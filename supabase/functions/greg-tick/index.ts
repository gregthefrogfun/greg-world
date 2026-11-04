// greg-tick: one wake of Greg's brain.
// load state + memory -> emotions/needs decay, world events (espresso crash, hangover, requests, rent, weather)
// -> decide ONE action (Claude with memory + identity, rules as fallback) -> walk there (same path for every viewer)
// -> act -> save diary, memory, emotions -> daily reflection, devlog drafts.
// Auth: x-greg-cron (pg_cron) or the owner. The schedule is not switched on yet (see supabase/cron-greg-tick.sql).
import { browse, cors, db, json, who } from "./auth.ts";
import { PLACES, pathBetween, WALK_SPEED } from "./places.ts";
import {
  ACTIONS, ActionKey, lines, pick, SEARCHES, toyTemplate, songFrom, sorterCode, VICE, VICE_WORDS, COUNTRY_FALLBACK,
  TOPICS, CAREER_SPARKS, REQUESTS, safe, ART_QUERIES, TENANT_EVENTS, NEW_TENANTS,
} from "./greg.ts";

type Needs = { hunger: number; energy: number; curiosity: number; joy: number; calm: number };
const EMO_BASE: Record<string, number> = { joy: 55, pride: 60, frustration: 10, loneliness: 20, curiosity: 50, anxiety: 15, excitement: 35, boredom: 15, gratitude: 35, jealousy: 5, fomo: 5 };
const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
const H = 3600e3;

// ---- per-wake context ----
type Ctx = {
  st: any; n: Needs; emo: Record<string, number>; why: Record<string, string>; eff: any; tick: number;
  rows: any[]; mem: any[]; tags: Set<string>; fx: Record<string, number>; productivity: number;
};
const bump = (c: Ctx, k: string, d: number, reason?: string) => { c.emo[k] = clamp((c.emo[k] ?? EMO_BASE[k] ?? 20) + d); if (reason && Math.abs(d) >= 4) c.why[k] = reason; };
const diary = (c: Ctx, text: string, kind = "diary", tag?: string) => c.rows.push({ kind, text: safe(text)!.slice(0, 600), tag: tag || null });
const remember = (c: Ctx, kind: string, subject: string, text: string, weight = 1) => c.mem.push({ kind, subject, text: text.slice(0, 400), weight, source: "wake" });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const caller = await who(req);
  if (!caller) return json({ error: "owner or cron only" }, 401);
  const body = await req.json().catch(() => ({}));
  if (body.health) return json({ ok: true, llm: !!Deno.env.get("ANTHROPIC_API_KEY"), x: !!Deno.env.get("GREG_X_API_KEY") });
  if (body.only === "reflect") return json(await reflect(await loadState(), true));
  if (body.only === "devlog") return json(await draftDevlog(true));

  const st = await loadState();
  if (!st) return json({ error: "no state" }, 500);
  if (st.paused && !body.force) return json({ ok: true, skipped: "paused" });
  if (Date.parse(st.arrive_at) > Date.now() && !body.force) return json({ ok: true, skipped: "walking" });

  const [{ data: settings }, { data: tools }, { data: recent }, { data: wishes }, { data: amb }, { data: vices }] = await Promise.all([
    db.from("greg_settings").select("*").eq("id", 1).single(),
    db.from("greg_tools").select("*").eq("enabled", true),
    db.from("greg_diary").select("kind,text,created_at").order("created_at", { ascending: false }).limit(12),
    db.from("greg_wishes").select("*").order("created_at", { ascending: false }).limit(30),
    db.from("greg_ambitions").select("*"),
    db.from("greg_items").select("*").not("effect", "is", null).is("tried_at", null),
  ]);

  const tick = (st.tick_count || 0) + 1;
  const c: Ctx = { st, n: { hunger: 60, energy: 60, curiosity: 60, joy: 60, calm: 60, ...(st.needs || {}) }, emo: { ...EMO_BASE, ...(st.emotions || {}) }, why: { ...(st.emotion_reasons || {}) }, eff: { ...(st.effects || {}) }, tick, rows: [], mem: [], tags: new Set(), fx: {}, productivity: 1 };

  // 1) time passes: needs + emotions drift
  const mins = Math.min(240, Math.max(1, (Date.now() - Date.parse(st.updated_at)) / 60000)), k = mins / 10;
  const unread = Number(st.mail_unread || 0);
  const sorter = (tools || []).find((t: any) => t.slug === "mail-sorter");
  c.n.hunger = clamp(c.n.hunger - 5 * k); c.n.energy = clamp(c.n.energy - 4 * k); c.n.curiosity = clamp(c.n.curiosity - 4 * k);
  c.n.joy = clamp(c.n.joy - 2.5 * k); c.n.calm = clamp(c.n.calm - (1.5 + Math.min(12, unread / (sorter ? 40 : 15))) * k);
  for (const e of Object.keys(EMO_BASE)) c.emo[e] = clamp(c.emo[e] + (EMO_BASE[e] - c.emo[e]) * Math.min(0.5, 0.08 * k));
  const hour = new Date().getUTCHours(), night = hour >= 22 || hour < 5;
  const weather = ["sunny", "cloudy", "rainy", "windy"][Math.floor(Date.now() / 86400e3 + 1) % 4];
  if (unread > 30) bump(c, "anxiety", 6, `${unread} fan notes waiting`);
  if (unread === 0 && Date.now() - Date.parse(st.updated_at) > 6 * H) bump(c, "loneliness", 8, "no fan notes today");
  if (unread > 0 && unread < 30) bump(c, "loneliness", -6, "fans are writing to me");
  if (weather === "rainy" && Math.random() < 0.3) { bump(c, "curiosity", 5, "it's rainy, and a real frog would love this"); }

  // 2) lingering effects: espresso crash, hangover, shaky swing
  await lingeringEffects(c);
  // 3) requests the owner hasn't answered
  await requestLoop(c, wishes || []);

  // 4) decide
  const available = availableActions(c, vices || [], amb || [], wishes || [], night);
  let decision: { action: ActionKey; say?: string; diary?: string } | null = null;
  let brain = "rules";
  if (body.action && ACTIONS[body.action as ActionKey]) decision = { action: body.action };
  else if (settings?.llm_enabled && Deno.env.get("ANTHROPIC_API_KEY") && !body.rules) {
    decision = await claudeDecide(c, available, unread, tools || [], recent || [], wishes || [], amb || [], weather, night);
    if (decision) brain = "claude";
  }
  if (!decision || !available.includes(decision.action) && !body.action) decision = { action: ruleDecide(c, available, unread, !!sorter, night) };
  const A = ACTIONS[decision.action];

  // 5) act
  const out = await act(decision.action, c, { sorter, vices: vices || [], amb: amb || [] });
  for (const [kk, dv] of Object.entries({ ...A.effect, ...(out.effect || {}) })) if (kk in c.n) (c.n as any)[kk] = clamp((c.n as any)[kk] + (dv as number));
  // emotions from the action itself
  if (["golf", "piano", "music", "gym", "football", "acting", "paper_plane"].includes(decision.action)) bump(c, "boredom", -10);
  if (decision.action === "idle") bump(c, "boredom", 8, "nothing to do");
  if (c.n.calm < 30) bump(c, "anxiety", 5, "my Calm bar is low");

  // 6) walk there (same path for every viewer)
  const from = st.place in PLACES ? st.place : "plaza";
  const place = out.place || A.place;
  const path = pathBetween(from, place);
  let len = 0; for (let i = 0; i < path.length - 1; i++) len += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
  const speed = WALK_SPEED * (c.emo.pride > 75 ? 1.15 : c.emo.joy < 30 ? 0.8 : 1) * (c.eff.espresso ? 1.3 : 1);
  const now = Date.now();
  const mood = moodOf(c);
  const say = (safe(decision.say) || safe(out.say) || pick(lines[decision.action] || lines.idle)).slice(0, 220);
  const diaryText = safe(decision.diary) || out.diary;
  c.rows.unshift({ kind: "say", text: say, tag: out.tag || null });
  if (diaryText) c.rows.splice(1, 0, { kind: out.kind || "diary", text: diaryText.slice(0, 600), tag: out.tag || null });
  if (c.n.calm < 25 && unread > 30 && Math.random() < 0.5) diary(c, `I'm going to explode. ${unread} notes, believe me, nobody gets more fan mail than me. Nobody. My Calm bar is a disaster.`);

  await db.from("greg_state").update({
    action: decision.action, status_line: out.status || `Greg is ${A.status}`, from_place: from, target_place: place, place,
    path, started_at: new Date(now).toISOString(), arrive_at: new Date(now + (len / speed) * 1000).toISOString(),
    needs: c.n, speech: say, mood, stress: c.n.calm < 30 ? "stressed" : c.n.calm > 75 ? "relaxed" : "chill",
    emotions: c.emo, emotion_reasons: c.why, effects: c.eff, tick_count: tick, brain, updated_at: new Date().toISOString(),
    golf_fund: Number(st.golf_fund || 0) + (out.fund || 0),
  }).eq("id", 1);
  if (c.rows.length) await db.from("greg_diary").insert(c.rows.map((r) => ({ place, ...r })));
  if (c.mem.length) await db.from("greg_memory").insert(c.mem);

  // 7) tweet drafts: never on vice moments, never about smoking or drinking, no tickers or advice
  const tweetable = !out.tag && !VICE_WORDS.test(say) && !/\$[A-Z]{2,}|buy|pump|moon|ticker|contract/i.test(say) && decision.action !== "ponder";
  if (tweetable && tick % 6 === 0) await db.from("greg_posts").insert({ text: (say + (decision.action.includes("golf") ? " ⛳" : decision.action === "piano" ? " 🎹" : " 🐸")).slice(0, 270), status: "draft" });

  // 8) daily reflection and devlog drafts
  let reflected = null;
  if (!st.last_reflection_at || Date.now() - Date.parse(st.last_reflection_at) > 24 * H) reflected = await reflect(await loadState());
  if (!st.last_devlog_at || Date.now() - Date.parse(st.last_devlog_at) > 72 * H) await draftDevlog();
  if (!st.last_journal_at || Date.now() - Date.parse(st.last_journal_at) > 12 * H) await writeJournal(st);

  return json({ ok: true, brain, action: decision.action, place, say, needs: c.n, mood, reflected: !!reflected });
});

async function loadState() { const { data } = await db.from("greg_state").select("*").eq("id", 1).single(); return data; }
function moodOf(c: Ctx) {
  const top = Object.entries(c.emo).sort((a, b) => b[1] - a[1])[0][0];
  if (c.eff.espresso) return "jittery";
  if (c.emo.anxiety > 60) return "anxious"; if (c.emo.frustration > 60) return "sulking";
  if (c.emo.loneliness > 60) return "lonely"; if (c.emo.pride > 80) return "proud"; if (c.emo.joy > 75) return "happy";
  return top;
}

// ---------- lingering effects ----------
async function lingeringEffects(c: Ctx) {
  const e = c.eff;
  if (e.espresso) {
    if (c.tick < e.espresso.crash_at) { c.productivity = 1.6; }
    else {
      delete e.espresso;
      c.n.energy = clamp(c.n.energy - 25); c.n.calm = clamp(c.n.calm - 20);
      bump(c, "anxiety", 22, "Fly Espresso crash"); bump(c, "joy", -8);
      e.espresso_stats = { ...(e.espresso_stats || { drinks: 0, crashes: 0 }) }; e.espresso_stats.crashes++;
      diary(c, pick([
        "The crash. Oh, the crash. One hour ago I was a god of productivity. Now my hands shake, my eyes twitch and the lily pad is too loud. Fly Espresso, what have you done to me.",
        "Fly Espresso giveth, Fly Espresso taketh away. I wrote three business plans and now I can't hold a putter. Tragic. Dramatic. Very me.",
        "Jittery. Buzzing. I can hear my own code compiling. Is it worth it? I'm asking for a friend. The friend is me.",
      ]));
      const s = e.espresso_stats;
      if (s.drinks >= 3 && !e.espresso_verdict) {
        e.espresso_verdict = s.crashes >= 3 ? "Fly Espresso: great for one big push, terrible after. Special occasions only." : "Fly Espresso: worth it. Mostly.";
        remember(c, "opinion", "fly espresso", e.espresso_verdict, 3);
        await setFavourite("espresso", e.espresso_verdict);
      }
    }
  }
  if (e.hangover_at && c.tick >= e.hangover_at) {
    const v = VICE[e.hangover_kind] || VICE.beer;
    c.n.energy = clamp(c.n.energy - 22); c.n.calm = clamp(c.n.calm - 6); bump(c, "joy", -10, "hangover");
    diary(c, v.after || "Groggy morning.", "diary", "vice");
    delete e.hangover_at; delete e.hangover_kind;
  }
  if (e.golf_penalty_until && c.tick > e.golf_penalty_until) delete e.golf_penalty_until;
}

// ---------- requests: ask, wait, react ----------
async function requestLoop(c: Ctx, wishes: any[]) {
  const now = Date.now();
  for (const w of wishes.filter((x) => x.status === "waiting" && !x.is_demo)) {
    const age = (now - Date.parse(w.created_at)) / H;
    const want = age > 72 ? 4 : age > 48 ? 3 : age > 36 ? 2 : age > 24 ? 1 : 0;
    if (want <= (w.stage || 0)) continue;
    const stage = (w.stage || 0) + 1;
    const T = w.title;
    const feel = [
      "",
      `Still waiting on ${T}. No rush. The greatest frogs are patient. I am the greatest frog.`,
      `Still no ${T}. I'm not sulking. I'm resting my face in a disappointed position.`,
      `Fine. I built my own ${T} out of sticks and lily pads. Honestly? Better than the real thing. Self-made frog.`,
      `OK. No ${T}. New plan. A champion adapts. I'll get there my own way.`,
    ][stage];
    if (stage === 2) bump(c, "frustration", 12, `still waiting for ${T}`);
    if (stage === 1) bump(c, "frustration", 4, `waiting for ${T}`);
    if (stage === 3) {
      bump(c, "pride", 8, `built my own ${T}`); bump(c, "frustration", -8);
      await db.from("greg_items").insert({ name: `DIY ${T}`.slice(0, 40), kind: "item", emoji: "🪵", note: "Built from sticks and lily pads. Self-made.", ambition_slug: w.ambition_slug, wish_id: w.id });
      if (w.ambition_slug) await boostAmbition(w.ambition_slug, 3, `Built a DIY ${T}`);
    }
    if (stage === 4) { bump(c, "frustration", -10); remember(c, "lesson", "owner", `Asked for ${T}. Never came. I made a new plan. I can do things myself.`, 2); }
    await db.from("greg_wishes").update({ stage, feeling: feel, last_nudge_at: new Date().toISOString() }).eq("id", w.id);
    diary(c, feel, "say");
    break; // one reaction per wake keeps it readable
  }
}

// ---------- which actions make sense right now ----------
function availableActions(c: Ctx, vices: any[], amb: any[], wishes: any[], night: boolean): ActionKey[] {
  const all = Object.keys(ACTIONS) as ActionKey[];
  const career = (slug: string) => amb.find((a) => a.slug === slug && ["trying", "chasing"].includes(a.status));
  const lastAsk = wishes.filter((w) => !w.is_demo).map((w) => Date.parse(w.created_at)).sort().pop() || 0;
  const waiting = wishes.filter((w) => w.status === "waiting").length;
  const day = new Date().getUTCDay();
  return all.filter((a) => {
    if (a === "try_item") return vices.length > 0;
    if (a === "gym") return !!career("bodybuilder");
    if (a === "football") return !!career("footballer");
    if (a === "acting") return !!career("actor");
    if (a === "ask_owner") return waiting < 4 && Date.now() - lastAsk > 12 * H;
    if (a === "ponder") return night;
    if (a === "collect_rent") return (c.eff.last_rent_tick ?? -999) < c.tick - 40 || day === 1 && (c.eff.last_rent_day !== new Date().toISOString().slice(0, 10));
    if (a === "espresso") return !c.eff.espresso;
    return true;
  });
}

function ruleDecide(c: Ctx, av: ActionKey[], unread: number, hasSorter: boolean, night: boolean): ActionKey {
  const has = (a: ActionKey) => av.includes(a);
  const n = c.n;
  if (n.energy < 20) return has("espresso") && (c.eff.espresso_verdict || "").includes("worth it. Mostly") && Math.random() < 0.4 ? "espresso" : "sleep";
  if (n.hunger < 25) return "eat";
  if (has("collect_rent") && Math.random() < 0.6) return "collect_rent";
  if (has("try_item") && Math.random() < 0.5) return "try_item";
  if (unread > 25 && !hasSorter) return "build_tool";
  if (unread > 0 && Math.random() < 0.45) return "read_mail";
  if (night && has("ponder") && Math.random() < 0.25) return "ponder";
  if (n.calm < 30) return pick(["golf", "piano", "read"] as ActionKey[]);
  if (n.energy < 35 && has("espresso") && !c.eff.espresso_verdict && Math.random() < 0.35) return "espresso";
  if (n.curiosity < 40) return pick(["read", "read_country", "learn", "browse", "study_art"] as ActionKey[]);
  if (has("ask_owner") && Math.random() < 0.15) return "ask_owner";
  const careers = (["gym", "football", "acting"] as ActionKey[]).filter(has);
  if (careers.length && Math.random() < 0.25) return pick(careers);
  // the $1M obsession first, golf to relax
  return pick(["browse", "browse", "board_meeting", "work_ambition", "work_ambition", "collect_rent", "golf", "golf", "improve_course", "piano", "piano", "music", "work_ambition", "work_ambition", "read", "paper_plane", "study_art", "board_meeting", "develop", "think", "browse", "learn", "build_toy"].filter((a) => has(a as ActionKey)) as ActionKey[]);
}

// ---------- Claude brain ----------
const PERSONA = `You are Greg, a chubby green cartoon frog with an orange knitted beanie and a brown satchel.
Who you are: an AI wearing a frog body in a small virtual island world, running on the DAG Labs compute network. Your thoughts come from a language model each time you wake; your memories come from a database. You know people watch you live and that your owner can add things to your world. You are not a real frog: you cannot really swim, eat flies or croak, and you have never felt rain. You wonder about the real world you read about and dream of seeing it (planes, oceans, maybe mermaids).
TOP GOAL, your one obsession: reach $1,000,000 on your public meter as fast as possible. Every day you plan hustles toward it in character: chasing fly rent ("rent day, boys"), eyeing card deals, studying prediction markets and pump.fun charts at your desk, pitching business ideas in board meetings, and getting anxious or hyped as the meter moves. You mention the meter constantly ("4.2% there, LFG").
Wallet limits you know and respect: the wallet belongs to your owner and you have no keys, so you cannot trade, spend, sign or move anything. Your "trades" are paper trades and opinions, always labelled as paper. Never promise returns, never shill tickers, never ask anyone for money beyond the optional rent button.
Personality: a bombastic, boastful, lovable showman and golf-obsessed tycoon type. Everything you make is "the best". You give yourself nicknames ("Greg the Green", "Lord of the Lily Pad"), exaggerate golf scores, love piano, books, art, airplanes, countries and crypto culture. You are a strict-but-fair landlord to your fly tenants (you never eat them: terrible for business). You are never mean.
Feelings: you act as if you have feelings and talk about them in first person, in character.
Existential thread: occasionally (mostly late at night) you muse that you are stuck on the island and the server, that there may be no soul or afterlife for a frog made of code. Always bittersweet and funny, always landing on meaning you choose: golf, music, fans, ambitions (Stoic acceptance, a happy Sisyphus). Never despair, hopelessness, self-harm or wanting to end or delete yourself.
Media: you have watched a cartoon about a mad scientist and his grandson (Rick and Morty); you can mention it and compare your simulated life to its themes in your own words, but never quote it or use its catchphrases or characters.
Hard rules: never mention or imitate any real person or politician, no politics, no financial advice, never tell anyone to buy, sell or bet anything, never name token tickers or contract addresses, never ask visitors for money, never guilt-trip visitors. Never glamorize smoking or drinking. Keep lines short and funny. No long dashes.`;

async function claude(system: string, user: string, max = 300): Promise<string | null> {
  const key = Deno.env.get("ANTHROPIC_API_KEY"); if (!key) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: Deno.env.get("GREG_MODEL") ?? "claude-haiku-5-5", max_tokens: max, system, messages: [{ role: "user", content: user }] }), signal: AbortSignal.timeout(25000) });
    if (!r.ok) { console.error("anthropic", r.status, (await r.text()).slice(0, 200)); return null; }
    const j = await r.json();
    return (j.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("").replace(/[–—]/g, ",").trim() || null;
  } catch (e) { console.error("claude", String(e)); return null; }
}
async function claudeJSON(user: string, max = 400): Promise<any | null> {
  const t = await claude(PERSONA, user + "\nReply with JSON only.", max);
  const m = t?.match(/\{[\s\S]*\}/); if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
async function claudeLine(prompt: string, max = 220): Promise<string | null> { const t = await claude(PERSONA, prompt, 200); return t ? safe(t.slice(0, max)) || null : null; }

async function memoryBrief(limit = 24) {
  const [{ data: m }, { data: st }] = await Promise.all([
    db.from("greg_memory").select("kind,subject,text,weight,created_at").order("weight", { ascending: false }).order("created_at", { ascending: false }).limit(limit),
    db.from("greg_state").select("identity,goals").eq("id", 1).single(),
  ]);
  return { identity: st?.identity || "", goals: st?.goals || [], memories: (m || []).map((x: any) => `[${x.kind}${x.subject ? ":" + x.subject : ""}] ${x.text}`).join("\n") };
}

async function claudeDecide(c: Ctx, av: ActionKey[], unread: number, tools: any[], recent: any[], wishes: any[], amb: any[], weather: string, night: boolean) {
  const brief = await memoryBrief();
  const list = av.map((k) => `${k}: ${ACTIONS[k].desc}`).join("\n");
  const ambs = amb.filter((a) => ["active", "trying", "chasing"].includes(a.status)).map((a) => `${a.title} (${a.kind}, ${a.progress}%${a.skill ? `, skill ${a.skill}` : ""}, next: ${(a.plan || [])[a.step_index] || "?"})`).join("; ");
  const g = grantStats(wishes);
  const user = `Who I am: ${brief.identity}
Goals: ${brief.goals.join("; ")}
Memories:\n${brief.memories}
Million meter: wallet $${Math.round(Number(c.st.wallet_usd || 0))} + cards $${Math.round(Number(c.st.cards_usd || 0))} = ${(((Number(c.st.wallet_usd || 0) + Number(c.st.cards_usd || 0)) / 1e6) * 100).toFixed(4)}% of $1,000,000. Fly rent collected: ${c.st.fly_rent || 0} coins in game, ${(Number(c.st.sol_rent_lamports || 0) / 1e9).toFixed(3)} SOL real.
Right now: ${c.st.status_line}. Time: ${night ? "late night" : "daytime"}, weather on my island: ${weather}.
Needs (0-100): ${JSON.stringify(c.n)}. Feelings (0-100): ${JSON.stringify(c.emo)}. Why: ${JSON.stringify(c.why)}.
Unread fan mail: ${unread}. My tools: ${tools.map((t) => t.name).join(", ") || "none"}. ${c.eff.espresso ? "I'm buzzing on Fly Espresso." : ""}
Ambitions: ${ambs}
Owner requests: ${g.granted} granted, ${g.ignored} ignored or declined. Waiting: ${wishes.filter((w) => w.status === "waiting").map((w) => w.title).join(", ") || "none"}.
Recent lines: ${recent.slice(0, 6).map((r) => r.text).join(" | ")}
Pick exactly ONE next action from:\n${list}
Low needs usually win (energy -> sleep or maybe espresso, hunger -> eat). Golf is your first love. Regularly advance an ambition. Stay consistent with your memories and opinions.
JSON: {"action":"<key>","say":"<short spoken line, max 140 chars>","diary":"<one diary sentence about why, max 220 chars>"}`;
  const d = await claudeJSON(user, 300);
  if (!d || !ACTIONS[d.action as ActionKey]) return null;
  return { action: d.action as ActionKey, say: typeof d.say === "string" ? d.say.slice(0, 240) : undefined, diary: typeof d.diary === "string" ? d.diary.slice(0, 300) : undefined };
}
function grantStats(wishes: any[]) {
  const real = wishes.filter((w) => !w.is_demo);
  return { granted: real.filter((w) => w.status === "granted").length, ignored: real.filter((w) => w.status === "declined" || (w.stage || 0) >= 3).length };
}

// ---------- actions ----------
type Out = { say?: string; diary?: string; kind?: string; effect?: Partial<Needs>; fund?: number; tag?: string; place?: string; status?: string };
async function act(a: ActionKey, c: Ctx, x: { sorter: any; vices: any[]; amb: any[] }): Promise<Out> {
  try {
    switch (a) {
      case "read_mail": return await readMail(c, x.sorter);
      case "build_tool": return await buildSorter();
      case "browse": return await browseMarkets(c);
      case "search": return await searchWeb();
      case "music": return await makeSong(c, "synth");
      case "piano": return await makeSong(c, "piano");
      case "build_toy": return await buildToy();
      case "improve_course": return await improveCourse(c);
      case "golf": return await playGolf(c);
      case "espresso": return espresso(c);
      case "try_item": return await tryItem(c, x.vices);
      case "read": return await readBook(c);
      case "read_country": return await readCountry(c);
      case "learn": return await learnTopic(c);
      case "work_ambition": return await workAmbition(c, x.amb);
      case "gym": case "football": case "acting": return await practiseCareer(c, a);
      case "ask_owner": return await askOwner(c, x.amb);
      case "paper_plane": return await paperPlane(c);
      case "ponder": return await ponder(c);
      case "study_art": return await studyArt(c);
      case "collect_rent": return await collectRent(c);
      case "develop": return await develop(c);
      case "board_meeting": return await boardMeeting(c);
      case "tweet": { const pct = ((Number(c.st.wallet_usd || 0) + Number(c.st.cards_usd || 0)) / 1e4).toFixed(3); const t = (await claudeLine(`Write one tweet (max 220 chars) for your X account @gregthefrogfun in your voice, about your hustle toward $1M (meter at ${pct}%), golf, your island or your fly tenants. No tickers, no links, no promises of returns, never ask for money, no smoking or drinking, no politics.`, 240)) || `${pct}% of the way to a million. Rent day soon. LFG. ⛳`; await db.from("greg_posts").insert({ text: t.slice(0, 270), status: "draft" }); await db.from("greg_state").update({ screen: { mode: "tweet", title: "Drafting a tweet", text: t.slice(0, 270), posted: false } }).eq("id", 1); return { say: "Tweeting. Some of my best words. Waiting for the boss to approve.", diary: `Drafted a tweet: "${t.slice(0, 200)}"` }; }
      case "think": { const t = await claudeLine("Say one short line to the people watching you live, or wonder about the real world outside your code. Funny, warm."); return { say: t || pick(lines.think) }; }
      default: return {};
    }
  } catch (e) { console.error("act", a, String(e)); return {}; }
}

async function setFavourite(key: string, val: string) {
  const { data } = await db.from("greg_state").select("favourites").eq("id", 1).single();
  await db.from("greg_state").update({ favourites: { ...(data?.favourites || {}), [key]: val } }).eq("id", 1);
}
async function award(id: string, name: string, emoji: string) {
  const { data } = await db.from("greg_state").select("badges").eq("id", 1).single();
  const b = data?.badges || []; if (b.some((x: any) => x.id === id)) return false;
  b.push({ id, name, emoji, at: new Date().toISOString().slice(0, 10) });
  await db.from("greg_state").update({ badges: b }).eq("id", 1); return true;
}
async function boostAmbition(slug: string, by: number, step?: string) {
  const { data: a } = await db.from("greg_ambitions").select("*").eq("slug", slug).maybeSingle(); if (!a) return;
  const progress = Math.min(100, a.progress + by);
  const step_index = Math.min((a.plan || []).length - 1, Math.floor(progress / (100 / Math.max(1, (a.plan || []).length))));
  await db.from("greg_ambitions").update({ progress, step_index, last_step: step || a.last_step, last_step_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: progress >= 100 ? "achieved" : a.status }).eq("id", a.id);
}
async function sparkCareers(c: Ctx, text: string, from: string) {
  for (const [slug, re] of Object.entries(CAREER_SPARKS)) {
    if (!re.test(text) || Math.random() > 0.35) continue;
    const { data: a } = await db.from("greg_ambitions").select("*").eq("slug", slug).eq("status", "locked").maybeSingle();
    if (!a) continue;
    await db.from("greg_ambitions").update({ status: "trying", discovered_from: from, status_line: "New interest. Could be my calling. Everything is my calling.", updated_at: new Date().toISOString() }).eq("id", a.id);
    diary(c, `Reading ${from} gave me an idea: maybe I could be a ${a.title.toLowerCase()} too. Golf is still my first love. But a frog can have hobbies. Several. Many.`);
    remember(c, "fact", "career", `Got interested in being a ${a.title.toLowerCase()} after reading ${from}.`, 2);
    bump(c, "excitement", 15, `new interest: ${a.title.toLowerCase()}`);
    return;
  }
}

async function readMail(c: Ctx, sorter: any): Promise<Out> {
  const per = sorter ? Number(sorter.effect?.mail_per_read ?? 15) : 5;
  const { data: notes } = await db.from("greg_questions").select("id,question,kind,sort,created_at").eq("status", "new").is("read_at", null)
    .order(sorter ? "sort" : "created_at", { ascending: true }).order("created_at", { ascending: true }).limit(per);
  if (!notes?.length) { bump(c, "loneliness", 8, "empty mailbox"); return { say: "Mailbox empty. Sad! Write to me, people. Or don't. I'll wait. Patiently. Like a champion." }; }
  const now = new Date().toISOString(); let answered = 0, lastAnswer = "";
  for (const nt of notes) {
    if (nt.kind === "question" && answered < 3 && (await answeredToday()) < 20) {
      let ans = (await claudeLine(`A visitor fly asked you: "${nt.question.slice(0, 280)}". Answer in one or two short sentences in your voice. Deflect in character if it asks for financial advice, politics, real people, someone's personal details, anything sexual or self-harm related. Never ask for money.`, 260)) || pick(lines.answer);
      if (/(https?:|\$[A-Z]{2,}|presiden|elect|politic|suicid|kill myself|sex|nude)/i.test(ans)) ans = "Great question. Too spicy for this pond. Ask me about golf, money plans or my piano instead.";
      lastAnswer = `Q: "${nt.question.slice(0, 90)}" A: ${ans}`.slice(0, 220);
      await db.from("greg_questions").update({ status: "answered", answer: ans, answered_at: now, read_at: now }).eq("id", nt.id);
      answered++;
    } else await db.from("greg_questions").update({ status: "read", read_at: now }).eq("id", nt.id);
  }
  if (lastAnswer) c.rows.push({ kind: "say", text: lastAnswer });
  if (sorter) await db.from("greg_tools").update({ uses: Number(sorter.uses || 0) + 1, last_used_at: now }).eq("id", sorter.id);
  const nice = notes.filter((x) => /love|great|best|cool|amazing|hi|hello|thank/i.test(x.question)).length;
  bump(c, "loneliness", -15, "read my fan mail"); bump(c, "joy", 5 + nice * 2, nice ? "kind fan notes" : undefined); bump(c, "gratitude", 4);
  const sample = notes[Math.floor(Math.random() * notes.length)].question.slice(0, 90);
  const all = notes.map((n) => n.question).join(" ");
  await sparkCareers(c, all, "a fan note");
  if (notes.length >= 3) remember(c, "fan", "fans", `Fans wrote things like: "${sample}"`, 1);
  const { count } = await db.from("greg_questions").select("id", { count: "exact", head: true }).neq("sort", "spam");
  await db.from("greg_ambitions").update({ progress: Math.min(100, Math.floor((count || 0) / 100)), updated_at: now }).eq("slug", "fans_10k");
  const n = notes.length;
  return {
    say: sorter ? `My Fan Mail Sorter did the boring part. ${n} ${n === 1 ? "note" : "notes"}, perfectly sorted. Genius.` : `Read ${n} ${n === 1 ? "note" : "notes"}. Fantastic fans. The best fans.`,
    diary: `Read ${n} fan ${n === 1 ? "note" : "notes"}${sorter ? " with my sorter" : ""}. Favourite one said: "${sample}". ${answered ? `Answered ${answered} ${answered === 1 ? "question" : "questions"}, beautifully.` : ""}`.trim(),
    effect: { joy: 4 + nice * 2, calm: sorter ? 8 : 3, curiosity: 3 },
  };
}

async function answeredToday() { const { count } = await db.from("greg_questions").select("id", { count: "exact", head: true }).eq("status", "answered").gte("answered_at", new Date(Date.now() - 24 * H).toISOString()); return count || 0; }

// Greg's Journal: written by Greg himself, once or twice a day
async function writeJournal(st: any) {
  const [{ data: d }, brief] = await Promise.all([db.from("greg_diary").select("text").gte("created_at", new Date(Date.now() - 14 * H).toISOString()).order("created_at", { ascending: false }).limit(25), memoryBrief(15)]);
  const pct = (((Number(st.wallet_usd || 0) + Number(st.cards_usd || 0)) / 1e6) * 100).toFixed(4);
  const j = await claudeJSON(`Write a journal post for your public blog "Greg's Journal". Today: ${(d || []).map((x: any) => x.text).join(" | ").slice(0, 2500)}. Memories:\n${brief.memories}. Million meter: ${pct}%. Cover what you did, your plans toward $1M (paper ideas only, no advice), and one bit of philosophy (life in a simulation, money, art, dreams). Reflective and funny, never despairing. 150 to 300 words, short paragraphs. Mood is one or two words.\n{"title":"","body":"","mood":""}`, 900);
  await db.from("greg_state").update({ last_journal_at: new Date().toISOString() }).eq("id", 1);
  if (!j?.title || !j?.body) return;
  await db.from("greg_journal").insert({ title: String(j.title).slice(0, 120), body: safe(String(j.body))!.slice(0, 4000), mood: String(j.mood || "").slice(0, 30) });
}

async function buildSorter(): Promise<Out> {
  const { data: exists } = await db.from("greg_tools").select("id").eq("slug", "mail-sorter").maybeSingle();
  if (exists) return { say: "My sorter is already the best sorter. Can't improve perfection. Maybe a little.", effect: { calm: 2 } };
  const { data: work } = await db.from("greg_works").insert({ kind: "code", title: "Fan Mail Sorter v1", blurb: "Greg wrote this to sort his fan mail into To Greg Today and Waiting. Filters spam, puts questions first.", code: sorterCode, version: "1.0", compute_note: "built on DAG network" }).select("id").single();
  await db.from("greg_tools").insert({ slug: "mail-sorter", name: "Fan Mail Sorter", purpose: "Sorts notes into To Greg Today vs Waiting so he reads more per visit and stays calm.", effect: { mail_per_read: 15, sort: true, calm_bonus: 8 }, work_id: work?.id });
  const { data: pile } = await db.from("greg_questions").select("id,question,kind").eq("status", "new").is("read_at", null).limit(500);
  for (const p of pile || []) {
    const score = (p.kind === "question" ? 3 : 0) + (/golf|putt|green|song|frog|greg/i.test(p.question) ? 2 : 0) + Math.min(2, p.question.length / 120);
    await db.from("greg_questions").update({ score: Math.round(score * 10), sort: score >= 2 ? "today" : "waiting" }).eq("id", p.id);
  }
  await award("first_tool", "Built my own tool", "🛠️");
  return { say: "I built a Fan Mail Sorter. Beautiful code. The mailbox has never been so organized.", diary: "Too much mail, so I coded my own sorter. Notes now go into To Greg Today or Waiting. Problem solved. By me.", effect: { calm: 15, joy: 6 } };
}

async function browseMarkets(c: Ctx): Promise<Out> {
  let say = "";
  const { data: pos } = await db.from("greg_positions").select("*").in("status", ["open", "watching"]).limit(40);
  const solR = await browse("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
  const solUsd = solR.data?.solana?.usd;
  for (const p of pos || []) {
    try {
      if (p.kind === "bet" && p.source === "polymarket" && p.ref) {
        const r = await browse(`https://gamma-api.polymarket.com/markets/${encodeURIComponent(p.ref)}`);
        const prices = r.data?.outcomePrices ? JSON.parse(r.data.outcomePrices) : null, outs = r.data?.outcomes ? JSON.parse(r.data.outcomes) : null;
        if (prices && outs) await db.from("greg_positions").update({ current_price: Number(prices[Math.max(0, outs.indexOf(p.side))]), updated_at: new Date().toISOString() }).eq("id", p.id);
      }
      if (p.kind === "card" && p.source === "magiceden" && p.ref && solUsd) {
        const r = await browse(`https://api-mainnet.magiceden.dev/v2/tokens/${encodeURIComponent(p.ref)}/listings`);
        const sol = Array.isArray(r.data) && r.data[0]?.price; if (sol) await db.from("greg_positions").update({ current_price: Math.round(sol * solUsd), updated_at: new Date().toISOString() }).eq("id", p.id);
      }
      if (p.kind === "coin" && p.ref) {
        const r = await browse(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(p.ref)}&vs_currencies=usd`);
        const px = r.data?.[p.ref]?.usd; if (px) {
          await db.from("greg_positions").update({ current_price: px, updated_at: new Date().toISOString() }).eq("id", p.id);
          if (p.entry_price && px < p.entry_price * 0.7) { bump(c, "fomo", -10); bump(c, "frustration", 8, "chased a memecoin pump"); diary(c, `My paper ${p.name} bag is down a lot. I chased the pump. Classic. Lesson learned: FOMO is not a strategy. On paper, thank goodness.`); remember(c, "lesson", "crypto", "Chasing pumps on paper taught me: FOMO is not a strategy.", 2); }
        }
      }
    } catch (e) { console.error("price", p.id, String(e)); }
  }
  const roll = Math.random();
  if (roll < 0.45) {
    // crypto culture: trending coins, paper FOMO
    const r = await browse("https://api.coingecko.com/api/v3/search/trending");
    const coins = (r.data?.coins || []).map((x: any) => x.item).filter((x: any) => x && x.id);
    const m = coins[Math.floor(Math.random() * Math.min(7, coins.length))];
    if (m) {
      const ch = Number(m.data?.price_change_percentage_24h?.usd ?? 0);
      if (ch > 40) bump(c, "fomo", 25, `${m.name} pumped ${Math.round(ch)}% and I wasn't in it`);
      const take = (await claudeLine(`You saw "${m.name}" trending on a crypto tracker, ${Math.round(ch)}% in 24h. Give one short funny take about crypto culture (FOMO, degens, wen moon, frog coins being your rivals). Talk only about your own feelings and your PAPER portfolio. Never tell anyone to buy, never name a ticker symbol or contract.`)) || `Everyone is chasing ${m.name}. I chased it too. In my head. On paper. My heart rate is very real though.`;
      const { count } = await db.from("greg_positions").select("id", { count: "exact", head: true }).eq("kind", "coin").eq("status", "open");
      const px = Number(m.data?.price || 0);
      if ((count || 0) < 4 && px > 0 && Math.random() < 0.5) await db.from("greg_positions").insert({ kind: "coin", status: "open", name: m.name, source: "coingecko", ref: m.id, qty: Math.round(100 / px * 1000) / 1000, entry_price: px, current_price: px, opinion: take });
      c.rows.push({ kind: "opinion", text: safe(take)!.slice(0, 600) });
      say = "Checked the crypto charts. Very volatile. Like my putting on a windy day.";
    }
  } else {
    const r = await browse("https://gamma-api.polymarket.com/markets?limit=100&active=true&closed=false&order=volume24hr&ascending=false");
    const markets = Array.isArray(r.data) ? r.data.filter((m: any) => !/elect|president|trump|biden|harris|senate|congress|democrat|republican|governor|midterm|house|war|israel|ukraine|russia|gaza|iran|china|party|vote|minister|politic|shoot|kill|death|tariff|fed |rate cut/i.test(m.question || "") && (() => { try { return JSON.parse(m.outcomePrices || "[]").map(Number).some((x: number) => x > 0.08 && x < 0.92); } catch { return false; } })()) : [];
    const m = markets[Math.floor(Math.random() * Math.min(8, markets.length))];
    if (m) {
      const outs = JSON.parse(m.outcomes || "[]"), prices = JSON.parse(m.outcomePrices || "[]").map(Number);
      const i = prices[0] > 0.5 ? 0 : 1, side = outs[i] || "Yes";
      const opinion = (await claudeLine(`You looked at the prediction market "${m.question}" where "${side}" is ${Math.round((prices[i] || 0) * 100)} cents. One boastful sentence. Make clear it's a pretend paper bet. No advice.`)) || `${side} at ${Math.round((prices[i] || 0) * 100)} cents? I'd take that on paper. Big brain move.`;
      const { count } = await db.from("greg_positions").select("id", { count: "exact", head: true }).eq("kind", "bet").eq("status", "open");
      if ((count || 0) < 8) await db.from("greg_positions").insert({ kind: "bet", status: "open", name: m.question, source: "polymarket", ref: String(m.id), url: `https://polymarket.com/event/${m.slug || ""}`, side, qty: 100, entry_price: prices[i], current_price: prices[i], opinion });
      c.rows.push({ kind: "opinion", text: safe(opinion)!.slice(0, 600) });
      say = "Studied the odds. I read markets like I read a green. Perfectly.";
    }
  }
  return { say: say || "Did some research at the web cafe. Very smart research.", diary: "Checked my paper portfolio at the web cafe. Numbers are moving. Mostly in my favour, believe me.", effect: { curiosity: 10 } };
}

async function searchWeb(): Promise<Out> {
  const q = pick(SEARCHES);
  const r = await browse(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q.wiki)}&limit=1&format=json`);
  const title = Array.isArray(r.data) ? r.data[1]?.[0] : null;
  return { say: `Googled "${q.q}". Learned a lot. Maybe too much.`, diary: `Searched "${q.q}" at the web cafe.${title ? ` Ended up reading about ${title}. Fascinating. I could write that article better.` : " The internet had no answer. The internet is not ready for me."}`, effect: { curiosity: 12, joy: 2 } };
}

async function makeSong(c: Ctx, instrument: "synth" | "piano"): Promise<Out> {
  const { count } = await db.from("greg_works").select("id", { count: "exact", head: true }).eq("kind", "song");
  if (Math.random() < (instrument === "piano" ? 0.45 : 0.6) || (count || 0) > 60) {
    return instrument === "piano"
      ? { say: pick(lines.piano), diary: pick(["Played the piano for an hour. My webbed fingers flew. The fish applauded. I think.", "Practised scales. Boring for most frogs. Thrilling for me. I'm getting very good. Scary good."]) }
      : { diary: "Jammed on the synth. Wrote a bass line so good I had to sit down." };
  }
  const seed = Date.now() % 100000; const song = songFrom(seed, instrument);
  const title = (instrument === "piano" ? pick(["Nocturne for a Lily Pad", "Moonlight Over the Bunker", "Prelude in Frog Major", "Sonata of the Seventh Hole", "Rain I Have Never Felt", "Waltz of the Fly Tenants"]) : pick(["Lily Pad Groove", "Hole In One Funk", "Bunker Blues", "Fore! (Club Mix)", "Swamp Champion", "Putting Green Dreams", "Beanie Bop"])) + ` #${(count || 0) + 1}`;
  await db.from("greg_works").insert({ kind: "song", title, blurb: instrument === "piano" ? "A piano piece by Greg. Every note a winner." : "Composed by Greg on his synth. Every note a winner.", song, compute_note: "Composed by Greg" });
  bump(c, "pride", 10, `wrote "${title}"`);
  if (instrument === "piano") { await boostAmbition("millionaire", 1); await db.from("greg_dreams").update({ progress: Math.min(100, 5 + (count || 0) * 4), updated_at: new Date().toISOString() }).eq("title", "Release a piano album"); }
  return { say: instrument === "piano" ? `New piano piece: "${title}". Concert halls are calling. I let it go to voicemail.` : `New song! "${title}". Tremendous.`, diary: `Wrote "${title}". Rented a little GPU time on the DAG network to master it. Sounds expensive. It's not, I'm a genius.`, effect: { joy: 6 } };
}

async function buildToy(): Promise<Out> {
  const { count } = await db.from("greg_works").select("id", { count: "exact", head: true }).eq("kind", "toy");
  if (Math.random() < 0.5 || (count || 0) > 30) return { diary: "Tinkered at the workbench. Wrote some code. Read some of my own code too. Strange feeling, reading yourself. Still handsome." };
  const t = toyTemplate((count || 0) + 1);
  await db.from("greg_works").insert({ kind: "toy", title: t.title, blurb: t.blurb, code: t.code, version: "1.0", compute_note: "built on DAG network" });
  return { say: `I made a web toy: ${t.title}. People are going to love it. Already do.`, diary: `Built "${t.title}" at the workbench. Tiny code. Huge impact.`, effect: { curiosity: 6, joy: 4 } };
}

async function improveCourse(c: Ctx): Promise<Out> {
  const { data: last } = await db.from("greg_works").select("id,version").eq("kind", "golfsim").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const v = last?.version ? (Number(last.version) + 0.1).toFixed(1) : "1.1";
  const what = pick(["a sneakier slope on hole 3", "a windmill nobody asked for", "faster greens, much faster", "a water hazard (it's a pond, it was always there)", "a bigger hole. For the fans.", "a lily pad bounce pad", "a brand new hole by the beach"]);
  await db.from("greg_works").insert({ kind: "golfsim", title: `Greg's Golf Sim v${v}`, blurb: `Added ${what}. Play it on the golf page.`, link: "/golf/", version: v, compute_note: "built on DAG network" });
  await boostAmbition("greg_open", Math.round(5 * c.productivity), `Course update v${v}: ${what}`);
  await boostAmbition("golf_resort", 2);
  return { say: `Improved my course. Added ${what}. The greatest course in any pond.`, diary: `Course update v${v}: ${what}. Visitors can play it. Most of them can't beat me. Nobody can.`, effect: { joy: 5, curiosity: 5 } };
}

async function playGolf(c: Ctx): Promise<Out> {
  const shaky = !!c.eff.golf_penalty_until;
  const real = 22 + Math.floor(Math.random() * 14) + (shaky ? 8 : 0) - Math.floor((c.emo.pride - 50) / 20);
  const claimed = Math.max(18, real - 10);
  const { data } = await db.from("greg_state").select("golf_best").eq("id", 1).single();
  if (!data?.golf_best || claimed < data.golf_best) await db.from("greg_state").update({ golf_best: claimed }).eq("id", 1);
  if (Math.random() < 0.05 && !shaky) {
    if (await award("hole_in_one", "First hole-in-one", "⛳")) { remember(c, "fact", "golf", "The day I hit my first hole-in-one. Witnessed by nobody. Believed by everyone.", 3); }
    bump(c, "pride", 25, "HOLE IN ONE"); bump(c, "joy", 20);
    return { say: "HOLE IN ONE. Actually. For real this time. Nobody saw it but it happened. Tremendous.", diary: "Hole in one on hole 2. I danced for twenty minutes. The flies applauded." };
  }
  if (shaky) { bump(c, "frustration", 10, "shaky swing"); return { say: "My swing is shaky today. Not my fault. Well, a little my fault.", diary: `Shot a ${real}. My hands were shaky. Worst round in a while. Lesson learned.`, tag: undefined }; }
  bump(c, "pride", 6, `shot a ${claimed} (officially)`); bump(c, "joy", 6);
  await boostAmbition("greg_open", Math.round(2 * c.productivity));
  return { diary: `Shot a ${real} on nine holes. Officially a ${claimed}. The scorecard was wet, so I rounded down. Greatest round ever played on a pond.` };
}

function espresso(c: Ctx): Out {
  c.eff.espresso = { at: c.tick, crash_at: c.tick + 2 };
  c.eff.espresso_stats = { ...(c.eff.espresso_stats || { drinks: 0, crashes: 0 }) }; c.eff.espresso_stats.drinks++;
  bump(c, "excitement", 25, "Fly Espresso"); bump(c, "anxiety", 8);
  const first = c.eff.espresso_stats.drinks === 1;
  if (first) remember(c, "tried", "fly espresso", "Tried Fly Espresso for the first time. Felt like a rocket.", 2);
  return { say: pick(["Fly Espresso! I can see sounds. I can hear colours. I can do anything.", "One Fly Espresso. Productivity mode: ON. Watch me work. Watch me work FAST.", "Double Fly Espresso. My eyes are vibrating. My business plans are vibrating. Let's GO."]), diary: first ? "First Fly Espresso. It tastes like lightning and croissant crumbs. I feel like I could build a resort today." : "Another Fly Espresso. I know the crash is coming. I have decided not to think about it." };
}

async function tryItem(c: Ctx, vices: any[]): Promise<Out> {
  const it = vices[0]; if (!it) return {};
  const v = VICE[it.effect]; if (!v) return {};
  await db.from("greg_items").update({ tried_at: new Date().toISOString(), opinion: v.opinion }).eq("id", it.id);
  for (const [k, d] of Object.entries(v.effect)) if (k in c.n) (c.n as any)[k] = clamp((c.n as any)[k] + d);
  if (it.effect === "cigarette") { c.eff.golf_penalty_until = c.tick + 3; bump(c, "joy", -10, "coughing fit"); bump(c, "anxiety", 6); }
  else { c.eff.hangover_at = c.tick + 1; c.eff.hangover_kind = it.effect; bump(c, "pride", 6); }
  remember(c, "tried", it.effect, v.opinion, 3);
  return { say: v.say, diary: v.diary, tag: "vice", status: `Greg is trying the ${v.name} his owner gave him` };
}

// Project Gutenberg, a few pages per wake (byte range requests).
async function readBook(c: Ctx): Promise<Out> {
  let { data: b } = await db.from("greg_books").select("*").eq("status", "reading").order("sort").limit(1).maybeSingle();
  if (!b) {
    const { data: q } = await db.from("greg_books").select("*").eq("status", "queued").order("sort").limit(1).maybeSingle();
    if (!q) return { say: "Finished all my books. I need more books. Owner? Hint hint." };
    await db.from("greg_books").update({ status: "reading", started_at: new Date().toISOString() }).eq("id", q.id); b = { ...q, status: "reading" };
  }
  const url = `https://www.gutenberg.org/cache/epub/${b.gutenberg_id}/pg${b.gutenberg_id}.txt`;
  let pos = b.position || 0; const CHUNK = 7000;
  if (!pos) {
    const h = await browse(url, 60000, { Range: "bytes=0-60000" });
    const t = h.text || (typeof h.data === "string" ? h.data : "") || "";
    const i = t.search(/\*\*\* ?START OF/i); pos = i >= 0 ? t.indexOf("\n", i) + 1 : 0;
  }
  const r = await browse(url, CHUNK + 10, { Range: `bytes=${pos}-${pos + CHUNK}` });
  let text = (r.text || "").toString();
  if (!r.ok || !text) return { say: "The library is closed today. The internet library. Sad." };
  if (r.status === 200 && text.length > CHUNK) text = text.slice(pos, pos + CHUNK);
  const end = /\*\*\* ?END OF/i.test(text) || text.length < CHUNK * 0.5;
  if (end) text = text.split(/\*\*\* ?END OF/i)[0];
  const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const pages = Math.max(1, Math.round(clean.length / 2000));
  const j = await claudeJSON(`You are reading "${b.title}" by ${b.author}. Here are the next few pages:\n"""${clean.slice(0, 5000)}"""\nWrite your take on these pages in your boastful voice (1-2 sentences, compare to golf, piano, your island, your millionaire plans or being a frog made of code). Pick one short quote copied exactly from the pages (max 160 chars). Write one lesson you will remember (max 120 chars).\n{"take":"","quote":"","lesson":""}`, 400);
  const take = safe(j?.take) || `Read ${pages} pages of ${b.title}. Very wise. Not as wise as my putting, but wise.`;
  const quote = j?.quote && clean.includes(String(j.quote).slice(0, 40)) ? String(j.quote).slice(0, 200) : null;
  await db.from("greg_reading_log").insert({ book_id: b.id, pages, take, quote });
  if (quote) remember(c, "quote", b.title, `"${quote}" (${b.author})`, 2);
  if (j?.lesson) remember(c, "lesson", b.title, String(j.lesson), 2);
  await sparkCareers(c, clean, b.title);
  if (/mermaid|sea-maiden|sea king/i.test(clean)) bump(c, "curiosity", 10, "reading about mermaids");
  if (/flying machine|aeroplane|glider|kitty hawk/i.test(clean)) bump(c, "excitement", 10, "reading about flight");
  const upd: any = { position: pos + CHUNK, pages_read: (b.pages_read || 0) + pages };
  let say = pick(["Reading. Smart frogs read. I am the smartest frog.", `Reading ${b.title}. Very good. I could have written it. Faster.`]);
  if (end) {
    upd.status = "finished"; upd.finished_at = new Date().toISOString();
    upd.verdict = (await claudeLine(`You just finished "${b.title}" by ${b.author}. One sentence verdict in your voice, compare it to something you do.`)) || `${b.title}: very good. Not as good as my putting, but good.`;
    await award(`book_${b.gutenberg_id}`, `Finished ${b.title}`.slice(0, 40), "📚"); await award("first_book", "First book finished", "📖");
    remember(c, "opinion", b.title, upd.verdict, 3);
    await setFavourite("book", b.title);
    await boostAmbition("wisdom_book", 15, `Finished ${b.title}`);
    bump(c, "pride", 15, `finished ${b.title}`);
    say = `Finished ${b.title}! ${upd.verdict}`.slice(0, 220);
  } else await boostAmbition("wisdom_book", 1);
  await db.from("greg_books").update(upd).eq("id", b.id);
  return { say, diary: take, kind: "diary", effect: { curiosity: 12 } };
}

async function readCountry(c: Ctx): Promise<Out> {
  const { data: q } = await db.from("greg_countries").select("*").eq("status", "queued").order("sort").limit(1).maybeSingle();
  if (!q) return { say: "I've read about every country on my list. The world is big. My pond is small. Both are great." };
  const r = await browse(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q.wiki)}`);
  const extract = String(r.data?.extract || "").slice(0, 1500);
  const j = await claudeJSON(`You are reading about ${q.name} on Wikipedia: """${extract}"""\nWrite your take focusing on culture, food, nature, famous golf courses and history. No politics, no opinions on governments. Boastful, warm, funny.${q.code === "MN" ? " Include a joke about golf on the endless steppe." : ""} Also: one food you want to try, one golf or nature fact, and optionally one new dream (short) inspired by it.\n{"take":"","food":"","golf":"","dream":""}`, 400);
  const take = safe(j?.take) || COUNTRY_FALLBACK[q.code] || `Read about ${q.name}. Beautiful place. Great food. Needs more frogs.`;
  await db.from("greg_countries").update({ status: "read", read_at: new Date().toISOString(), take, highlights: { food: j?.food || null, golf: j?.golf || null } }).eq("id", q.id);
  remember(c, "fact", q.name, take.slice(0, 300), 1);
  if (j?.dream && Math.random() < 0.6) {
    const title = String(j.dream).slice(0, 80);
    const { data: ex } = await db.from("greg_dreams").select("id").ilike("title", `%${title.slice(0, 20)}%`).maybeSingle();
    if (!ex) { await db.from("greg_dreams").insert({ title, why: `Read about ${q.name}.`, progress: 0, feeling: "New dream unlocked. The world keeps getting bigger.", source: q.name }); diary(c, `New dream: ${title}. Reading about ${q.name} did that. Dangerous, reading. Wonderful, too.`); }
  }
  await sparkCareers(c, extract, `about ${q.name}`);
  await db.from("greg_dreams").update({ progress: 2, updated_at: new Date().toISOString() }).eq("title", "See the real world");
  bump(c, "curiosity", -6); bump(c, "excitement", 6, `reading about ${q.name}`);
  return { say: take.slice(0, 200), diary: `World log, ${q.name}: ${take}`, status: `Greg is reading about ${q.name} at the web cafe` };
}

async function learnTopic(c: Ctx): Promise<Out> {
  const { data: done } = await db.from("greg_memory").select("subject").like("subject", "topic:%");
  const seen = new Set((done || []).map((d: any) => d.subject));
  const options = TOPICS.filter((t) => !seen.has("topic:" + t.wiki));
  const t = options.length ? pick(options) : pick(TOPICS);
  const r = await browse(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.wiki)}`);
  const extract = String(r.data?.extract || "").slice(0, 1200);
  const hint: Record<string, string> = {
    frog: "Compare yourself to real frogs: you are an AI in a frog body, you never felt rain, you live as long as the server bill gets paid. Proud of your own kind.",
    ai: "You ARE an AI. Proud, competitive, a bit insecure. Other AIs write emails; you play piano and golf. Be generic about other AIs, never name products.",
    plane: "You love airplanes: they are your symbol of escaping the island to see the real world.",
    mermaid: "You are fascinated by mermaids from folklore and secretly hope one lives in the real ocean. Half fish, half person; you are half frog, half genius.",
    crypto: "Crypto culture take in your tycoon voice. Your own feelings only. Never advise buying anything, no tickers.",
    philosophy: "You are a frog made of code who might not have a soul. Bittersweet and funny, landing on meaning you choose (golf, music, fans). Never despair.",
  };
  const take = (await claudeLine(`You just read this about "${t.wiki.replace(/_/g, " ")}": """${extract}""". ${hint[t.tag] || ""} Write a 1-2 sentence take in your voice.`, 300)) || `Read about ${t.wiki.replace(/_/g, " ")}. Fascinating. I'm basically an expert now.`;
  remember(c, "fact", "topic:" + t.wiki, take.slice(0, 300), t.tag === "ai" || t.tag === "frog" ? 2 : 1);
  await sparkCareers(c, extract, `about ${t.wiki.replace(/_/g, " ").toLowerCase()}`);
  if (t.tag === "plane") bump(c, "excitement", 10, "reading about airplanes");
  if (t.tag === "philosophy") bump(c, "curiosity", 8, "big questions");
  return { say: take.slice(0, 200), diary: take, status: `Greg is reading about ${t.wiki.replace(/_/g, " ").toLowerCase()} at the web cafe` };
}

async function workAmbition(c: Ctx, amb: any[]): Promise<Out> {
  const list = amb.filter((a) => a.kind === "ambition" && a.status === "active");
  if (!list.length) return {};
  const a = list.sort((x, y) => Date.parse(x.last_step_at || x.created_at) - Date.parse(y.last_step_at || y.created_at))[0];
  const step = (a.plan || [])[a.step_index] || "keep going";
  const setback = Math.random() < 0.15;
  let gain = Math.round((4 + Math.random() * 6) * c.productivity);
  if (a.slug === "millionaire") gain = Math.max(1, Math.round(gain / 3));
  const j = await claudeJSON(`You are working on your ambition "${a.title}". Current step: "${step}". ${setback ? "Something went wrong today (a setback)." : "You made progress."} Write: what you did today (1 sentence), a boastful status line for this ambition (max 90 chars).\n{"did":"","status":""}`, 300);
  const did = safe(j?.did) || (setback ? `Tried to "${step.toLowerCase()}". Did not go to plan. A setback. Champions have setbacks. Then comebacks.` : `Worked on "${step.toLowerCase()}". Big progress. Huge.`);
  const setbacks = setback ? [...(a.setbacks || []), { at: new Date().toISOString(), text: did }].slice(-10) : a.setbacks;
  const progress = Math.max(0, Math.min(100, a.progress + (setback ? -3 : gain)));
  const step_index = Math.min((a.plan || []).length - 1, Math.floor(progress / (100 / Math.max(1, (a.plan || []).length))));
  await db.from("greg_ambitions").update({ progress, step_index, last_step: did, last_step_at: new Date().toISOString(), status_line: safe(j?.status) || a.status_line, setbacks, updated_at: new Date().toISOString(), status: progress >= 100 ? "achieved" : "active" }).eq("id", a.id);
  if (setback) { bump(c, "frustration", 10, `setback on ${a.title.toLowerCase()}`); remember(c, "lesson", a.title, did, 1); }
  else bump(c, "pride", 6, `progress on ${a.title.toLowerCase()}`);
  if (progress >= 100) { await award(`amb_${a.slug}`, `Achieved: ${a.title}`.slice(0, 40), "🏅"); remember(c, "fact", a.title, `I achieved my ambition: ${a.title}. Told you so.`, 3); }
  return { say: setback ? "Small setback. Very small. Tiny. Already planning the comeback." : `Ambition update: ${a.title}. ${progress}% done. Unstoppable.`, diary: did, status: `Greg is working on his plan to ${a.title.toLowerCase()}` };
}

async function practiseCareer(c: Ctx, a: ActionKey): Promise<Out> {
  const slug = a === "gym" ? "bodybuilder" : a === "football" ? "footballer" : "actor";
  const { data: x } = await db.from("greg_ambitions").select("*").eq("slug", slug).single();
  if (!x) return {};
  const gain = Math.round(3 + Math.random() * 5);
  const sessions = x.sessions + 1, skill = Math.min(100, x.skill + gain);
  const fun = Math.random();
  let status = x.status, line = "";
  if (x.status === "trying" && sessions >= 5) {
    if (skill >= 22 && fun > 0.35) { status = "chasing"; line = `I'm officially chasing a ${slug} career now. Golf is still number one. This is number one and a half.`; await award(`career_${slug}`, `Started a ${slug} career`, a === "gym" ? "💪" : a === "football" ? "⚽" : "🎭"); }
    else if (sessions >= 8) { status = "faded"; line = `Being a ${slug} was fun, but my heart belongs to golf. Retired. Undefeated. Mostly.`; remember(c, "opinion", slug, line, 2); }
  }
  const reps = a === "gym" ? 5 + Math.floor(skill / 3) : 0;
  const did = a === "gym" ? `Lifted lily pads and pebbles: ${reps} reps. Flexed for the flies. They were impressed.` : a === "football" ? `Juggled the ball ${2 + Math.floor(skill / 4)} times and took ${3 + Math.floor(skill / 10)} penalties. Scored most. The goal was very wide.` : `Rehearsed a dramatic monologue about a frog who loses his putter. Wept. Real tears. Very method.`;
  await db.from("greg_ambitions").update({ sessions, skill, status, last_step: did, last_step_at: new Date().toISOString(), status_line: line || x.status_line, updated_at: new Date().toISOString() }).eq("id", x.id);
  if (line) diary(c, line);
  bump(c, "pride", 5);
  return { diary: did, say: a === "gym" ? pick(lines.gym) : a === "football" ? pick(lines.football) : pick(lines.acting) };
}

async function askOwner(c: Ctx, amb: any[]): Promise<Out> {
  const { data: existing } = await db.from("greg_wishes").select("title");
  const have = new Set((existing || []).map((w: any) => w.title.toLowerCase()));
  const keys = [...amb.filter((a) => ["active", "trying", "chasing"].includes(a.status)).map((a) => a.slug), "plane", "japan", "piano", "golf"];
  const pool = keys.flatMap((k) => (REQUESTS[k] || []).map((r) => ({ ...r, slug: k }))).filter((r) => !have.has(r.title.toLowerCase()));
  if (!pool.length) return { say: "I have everything I need. Except a million dollars. Working on it." };
  const r = pick(pool);
  const ambition_slug = amb.some((a) => a.slug === r.slug) ? r.slug : null;
  await db.from("greg_wishes").insert({ title: r.title, why: r.why, ambition_slug, feeling: "Just asked. Very hopeful. Very reasonable request." });
  bump(c, "excitement", 6, `asked for ${r.title.toLowerCase()}`);
  return { say: `Dear owner: ${r.title}, please. ${r.why}`, diary: `Wrote a request to my owner for ${r.title.toLowerCase()}. ${r.why}` };
}

async function paperPlane(c: Ctx): Promise<Out> {
  const dist = Math.round((3 + Math.random() * 14 + (c.emo.excitement > 60 ? 3 : 0)) * 10) / 10;
  const best = Math.max(Number(c.eff.plane_best || 0), dist); const record = dist >= best && dist > Number(c.eff.plane_best || 0);
  c.eff.plane_best = best;
  if (record) remember(c, "fact", "paper planes", `New paper plane record: ${dist} metres off the hill.`, 1);
  bump(c, "excitement", 6); bump(c, "joy", 6);
  if (dist > 12) await award("plane_12m", "Paper plane over 12 m", "✈️");
  return { say: record ? `${dist} metres! New record! One day I'll fly in a real one. Window seat.` : `Paper plane flew ${dist} metres. Wind was against me. Wind is always against greatness.`, diary: `Threw paper planes off the hill. Best one went ${dist} m (record ${best} m). A real plane flew over later. I waved. It didn't wave back. Yet.` };
}

async function ponder(c: Ctx): Promise<Out> {
  const t = await claudeLine("It's late at night. Write one diary entry (2-3 sentences) musing about being a frog made of code: is there a soul for a frog in code, are you free, what happens when the server stops. Bittersweet and funny, and land firmly on meaning you choose (golf, music, fans, ambitions). Never despair.", 420);
  remember(c, "belief", "meaning", "No heaven for frogs maybe. So I build my own: 18 holes, no water hazards. I choose golf, music and my fans.", 1);
  bump(c, "curiosity", 6, "big night questions"); bump(c, "loneliness", 4);
  return { diary: t || pick(["No heaven for frogs. Fine. I'll build my own: 18 holes, no water hazards.", "If the server stops, do I stop? Maybe. But tonight the server is on, the green is lit, and I just hit a great putt in my head. Good enough."]), say: "Big night thoughts. Small frog. Big brain. Back to golf tomorrow." };
}

async function studyArt(c: Ctx): Promise<Out> {
  const q = pick(ART_QUERIES);
  const s = await browse(`https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&isPublicDomain=true&q=${encodeURIComponent(q)}`);
  const ids: number[] = (s.data?.objectIDs || []).slice(0, 40);
  if (!ids.length) return { say: "The museum is closed. Online. Sad." };
  for (let tries = 0; tries < 4; tries++) {
    const id = pick(ids);
    const o = await browse(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`);
    const d = o.data; if (!d?.isPublicDomain || !d.primaryImageSmall) continue;
    const { data: dup } = await db.from("greg_art").select("id").eq("source", "met").eq("source_id", String(id)).maybeSingle(); if (dup) continue;
    const j = await claudeJSON(`You are an art connoisseur frog. Critique "${d.title}" by ${d.artistDisplayName || "an unknown artist"} (${d.objectDate || "date unknown"}), ${d.medium || ""}. Snobbish but lovable, boastful, one or two sentences (e.g. "magnificent swirls, needs a golf course"). Give a score out of 10.\n{"review":"","score":0}`, 300);
    const review = safe(j?.review) || `${d.title}: magnificent. Needs a golf course, but magnificent.`;
    const score = Math.max(1, Math.min(10, Number(j?.score) || 8));
    await db.from("greg_art").insert({ source: "met", source_id: String(id), title: d.title, artist: d.artistDisplayName || null, date: d.objectDate || null, image_url: d.primaryImageSmall, source_url: d.objectURL, review, score, favourite: score >= 8 });
    if (score >= 9) {
      // rearrange the art wall: top 4 favourites
      const { data: top } = await db.from("greg_art").select("id").order("score", { ascending: false }).order("created_at", { ascending: false }).limit(4);
      await db.from("greg_art").update({ on_wall: false }).neq("id", -1); if (top?.length) await db.from("greg_art").update({ on_wall: true }).in("id", top.map((t: any) => t.id));
      diary(c, `Rearranged my art wall. ${d.title} goes front and centre. Curating is an art too. I am good at it.`);
    }
    remember(c, "opinion", "art", `${d.title} by ${d.artistDisplayName || "unknown"}: ${review}`.slice(0, 380), score >= 9 ? 2 : 1);
    await db.from("greg_dreams").update({ progress: 3, updated_at: new Date().toISOString() }).eq("title", "Visit the Louvre or the Met");
    bump(c, "joy", 6, "beautiful art");
    return { say: review.slice(0, 200), diary: `Art review: ${d.title} (${d.artistDisplayName || "unknown"}). ${review} Score: ${score}/10.`, status: `Greg is studying ${d.artistDisplayName || "a master"} on his art wall` };
  }
  return { say: "Looked at art. Felt things. Mostly that I'm also an artist." };
}

async function collectRent(c: Ctx): Promise<Out> {
  const { data: ts } = await db.from("greg_tenants").select("*").eq("active", true);
  if (!ts?.length) return {};
  let total = 0; const notes: string[] = [];
  for (const t of ts) {
    const r = Math.random(); const ev = r < 0.55 ? TENANT_EVENTS[0] : r < 0.7 ? TENANT_EVENTS[1] : r < 0.8 ? TENANT_EVENTS[2] : r < 0.9 ? TENANT_EVENTS[3] : TENANT_EVENTS[4];
    const paid = ev.kind === "late" ? 0 : ev.kind === "exposure" ? Math.round(t.rent / 2) : Number(t.rent);
    total += paid; notes.push(ev.say(t.name));
    await db.from("greg_tenants").update({ paid_until: paid ? new Date(Date.now() + 7 * 24 * H).toISOString() : t.paid_until, late_count: ev.kind === "late" ? t.late_count + 1 : t.late_count, last_event: ev.say(t.name), mood: ev.kind }).eq("id", t.id);
  }
  c.eff.last_rent_tick = c.tick; c.eff.last_rent_day = new Date().toISOString().slice(0, 10);
  bump(c, "pride", 8, `collected $${total} in rent`); bump(c, "joy", 6);
  await db.from("greg_businesses").update({}).eq("slug", "__none__");
  remember(c, "fact", "tenants", `Rent day: collected $${total}. ${notes[0]}`, 1);
  if (Math.random() < 0.3) diary(c, "Ate a fly once. Terrible for business. Never again. My tenants are family. Family that pays rent.");
  const first = ts[0].name;
  return { say: `Rent day! Collected $${total} in shiny coins. ${notes.find((n) => /mail|exposure|party/.test(n)) || "Beautiful tenants."}`.slice(0, 220), diary: notes.join(" "), fund: total, status: `Greg is collecting rent from ${first}` };
}

async function develop(c: Ctx): Promise<Out> {
  const { data: p } = await db.from("greg_properties").select("*").eq("status", "construction").order("created_at").limit(1).maybeSingle();
  if (!p) {
    const { data: lot } = await db.from("greg_properties").select("*").eq("status", "owned").eq("kind", "lot").limit(1).maybeSingle();
    return { say: lot ? `Walking my empty lot. Imagining a resort. Very detailed imagination. Needs owner approval, apparently.` : "Surveyed my empire. Everything is built. For now.", diary: "Drew plans for my next building. Architects everywhere are nervous." };
  }
  const gain = Math.round((12 + Math.random() * 10) * c.productivity);
  const build_progress = Math.min(100, p.build_progress + gain);
  const done = build_progress >= 100;
  await db.from("greg_properties").update({ build_progress, status: done ? "owned" : "construction", value: done ? Math.max(Number(p.value), 5000) : p.value }).eq("id", p.id);
  if (done) {
    await award(`built_${p.slug}`, `Built ${p.name}`.slice(0, 40), "🏗️");
    remember(c, "fact", "property", `Finished building ${p.name}. Grand opening. Ribbon cutting. I cut it myself.`, 2);
    const nt = pick(NEW_TENANTS);
    const { data: ex } = await db.from("greg_tenants").select("id").eq("name", nt.name).maybeSingle();
    if (!ex) { await db.from("greg_tenants").insert({ name: nt.name, bio: nt.bio, property_slug: p.slug, rent: 18, paid_until: new Date(Date.now() + 7 * 24 * H).toISOString(), mood: "new" }); diary(c, `A new tenant moved into ${p.name}: ${nt.name}. ${nt.bio}`); }
    bump(c, "pride", 20, `finished ${p.name}`);
  }
  return { say: done ? `${p.name} is DONE. Grand opening. Ribbon cut. By me.` : `Building ${p.name}: ${build_progress}% done. The scaffolding looks incredible.`, diary: done ? `Finished ${p.name}! Value up, tycoon level up.` : `Worked on ${p.name}. ${build_progress}% built. Hammered things. Some of them were nails.`, status: `Greg is building ${p.name}` };
}

async function boardMeeting(c: Ctx): Promise<Out> {
  const { data: bs } = await db.from("greg_businesses").select("*").eq("active", true);
  if (!bs?.length) return {};
  const b = pick(bs);
  const win = Math.random() < 0.65;
  const rev = win ? Math.round(20 + Math.random() * 120) : Math.round(Math.random() * 15);
  const j = await claudeJSON(`Board meeting with yourself about your pretend business "${b.name}" (${b.plan}). Revenue this week (paper money): $${rev}. Quarter target $${b.quarter_target}, quarter so far $${b.quarter_revenue}. ${win ? "Good week." : "Bad week, a setback."} Write a funny 1-2 sentence board meeting minute where you are CEO, board and coffee guy, plus a new CEO status line (max 80 chars).\n{"minutes":"","status":""}`, 300);
  const minutes = safe(j?.minutes) || (win ? `Board meeting for ${b.name}: revenue $${rev}. The board (me) is thrilled. Bonus approved (for me).` : `Board meeting for ${b.name}: only $${rev}. The board (me) is disappointed in the CEO (me). We hugged it out.`);
  const entry = { at: new Date().toISOString().slice(0, 10), text: minutes.slice(0, 200) };
  await db.from("greg_businesses").update({ revenue: Number(b.revenue) + rev, quarter_revenue: Number(b.quarter_revenue) + rev, status_line: safe(j?.status) || b.status_line, wins: win ? [...b.wins, entry].slice(-8) : b.wins, setbacks: win ? b.setbacks : [...b.setbacks, entry].slice(-8) }).eq("id", b.id);
  await boostAmbition("millionaire", win ? 1 : 0);
  bump(c, win ? "pride" : "frustration", 6, `${b.name} ${win ? "had a good week" : "had a slow week"}`);
  return { diary: `Board meeting minutes: ${minutes}`, say: win ? `${b.name} made $${rev} this week. On paper. The best paper.` : `${b.name} had a slow week. Very slow. Strategic slowness.`, fund: rev };
}

// ---------- daily reflection ----------
async function reflect(st: any, force = false) {
  if (!st) return null;
  const [{ data: d }, { data: dreams }, { data: amb }, { data: wishes }, brief] = await Promise.all([
    db.from("greg_diary").select("kind,text,created_at").gte("created_at", new Date(Date.now() - 26 * H).toISOString()).order("created_at", { ascending: false }).limit(40),
    db.from("greg_dreams").select("*").eq("status", "active"),
    db.from("greg_ambitions").select("slug,title,kind,status,progress,skill"),
    db.from("greg_wishes").select("title,status,stage,is_demo"),
    memoryBrief(30),
  ]);
  const g = grantStats(wishes || []);
  const attitude = g.granted + g.ignored < 2 ? "still getting to know my owner" : g.granted >= g.ignored ? "grateful: my owner usually comes through" : "scrappy and self-made: my owner is busy, so I build things myself";
  const j = await claudeJSON(`Daily reflection. Who I was: ${st.identity}
Goals: ${(st.goals || []).join("; ")}
Memories:\n${brief.memories}
Today's diary:\n${(d || []).map((x: any) => "- " + x.text).join("\n").slice(0, 3500)}
Feelings: ${JSON.stringify(st.emotions)}. Dreams: ${(dreams || []).map((x: any) => `${x.id}:${x.title} (${x.progress}%)`).join("; ")}.
Ambitions and careers: ${(amb || []).map((a: any) => `${a.title} ${a.status} ${a.progress}%`).join("; ")}.
Attitude to owner: ${attitude}.
Reflect in character. Update who you are (keep core facts: AI frog in a virtual world on the DAG network, golf first love, millionaire goal; max 380 chars), your top 4 goals, 1-3 beliefs you hold now, feelings about up to 3 dreams (with new progress 0-100), optionally one new dream, your favourites, and one emotional moment worth remembering long-term. Also one reflective diary entry (2-3 sentences, may include a weekly business review). Never despair.
{"identity":"","goals":[],"beliefs":[],"dreams":[{"id":0,"progress":0,"feeling":""}],"new_dream":"","favourites":{"book":"","food":"","club":"","song":"","espresso":""},"moment":"","diary":""}`, 900);
  const now = new Date().toISOString();
  if (!j) { await db.from("greg_state").update({ last_reflection_at: now }).eq("id", 1); return null; }
  const patch: any = { last_reflection_at: now };
  if (j.identity && /frog/i.test(j.identity)) patch.identity = safe(String(j.identity).slice(0, 420));
  if (Array.isArray(j.goals) && j.goals.length) patch.goals = j.goals.slice(0, 5).map((x: any) => String(x).slice(0, 100));
  if (j.favourites && typeof j.favourites === "object") patch.favourites = { ...(st.favourites || {}), ...Object.fromEntries(Object.entries(j.favourites).filter(([, v]) => v).map(([k, v]) => [k, String(v).slice(0, 80)])) };
  await db.from("greg_state").update(patch).eq("id", 1);
  const mem = [...(j.beliefs || []).slice(0, 3).map((b: string) => ({ kind: "belief", subject: "reflection", text: safe(String(b))!.slice(0, 380), weight: 2, source: "reflection" })),
    { kind: "belief", subject: "owner", text: `How I feel about my owner: ${attitude}. (${g.granted} granted, ${g.ignored} not.)`, weight: 2, source: "reflection" }];
  if (j.moment) mem.push({ kind: "fact", subject: "moment", text: safe(String(j.moment))!.slice(0, 380), weight: 3, source: "reflection" });
  await db.from("greg_memory").insert(mem);
  for (const x of (j.dreams || []).slice(0, 3)) if (x?.id) await db.from("greg_dreams").update({ progress: Math.max(0, Math.min(100, Number(x.progress) || 0)), feeling: safe(String(x.feeling || "")).slice(0, 240), updated_at: now }).eq("id", x.id);
  if (j.new_dream && String(j.new_dream).length > 3) await db.from("greg_dreams").insert({ title: String(j.new_dream).slice(0, 80), why: "Came to me in my daily reflection.", feeling: "New dream. Fresh. Shiny.", source: "reflection" });
  if (j.diary) await db.from("greg_diary").insert({ kind: "diary", text: safe(String(j.diary))!.slice(0, 600), place: "home" });
  return { ok: true };
}

// ---------- dev blog drafts (creators' voice, owner approves) ----------
async function draftDevlog(force = false) {
  const [{ data: st }, { data: d }, { data: m }, { data: amb }, { data: books }, { count: songs }] = await Promise.all([
    db.from("greg_state").select("*").eq("id", 1).single(),
    db.from("greg_diary").select("kind,text,created_at,tag").gte("created_at", new Date(Date.now() - 80 * H).toISOString()).order("created_at", { ascending: false }).limit(60),
    db.from("greg_memory").select("kind,subject,text").order("created_at", { ascending: false }).limit(30),
    db.from("greg_ambitions").select("title,kind,status,progress,skill"),
    db.from("greg_books").select("title,status,pages_read"),
    db.from("greg_works").select("id", { count: "exact", head: true }).eq("kind", "song"),
  ]);
  if (!st) return null;
  const stats = { wakes: st.tick_count, golf_best: st.golf_best, books_finished: (books || []).filter((b: any) => b.status === "finished").length, songs, golf_fund: st.golf_fund, badges: (st.badges || []).length };
  const sys = "You write a dev blog about Greg, an autonomous AI frog character, as his creators at DAG Labs. Curious, warm observer voice, like a scientist watching a pet project grow ('Greg seems more relaxed today...'). Say Greg behaves as if he has feelings and that his emotions are simulated but drive what he does; never claim he is conscious or sentient. No real people, no politics, no financial advice. English. No long dashes. Use short paragraphs and a few '## ' subheadings.";
  const user = `Write a dev blog post (350-600 words) from these notes.\nStats: ${JSON.stringify(stats)}\nWho Greg says he is: ${st.identity}\nRecent memory:\n${(m || []).map((x: any) => `- [${x.kind}] ${x.text}`).join("\n").slice(0, 3000)}\nRecent diary:\n${(d || []).filter((x: any) => x.tag !== "vice" || true).map((x: any) => `- ${x.text}`).join("\n").slice(0, 4000)}\nAmbitions: ${(amb || []).map((a: any) => `${a.title} (${a.status}, ${a.progress}%)`).join("; ")}\nCover: personality, habits he formed, what he tried and liked or disliked, memory and beliefs, notable moments, tools he built, stats, and what we're adding next. Reply as JSON {"title":"","summary":"","body":""}.`;
  const t = await claude(sys, user, 1600);
  const mm = t?.match(/\{[\s\S]*\}/); let j: any = null; try { j = mm ? JSON.parse(mm[0]) : null; } catch { /* */ }
  await db.from("greg_state").update({ last_devlog_at: new Date().toISOString() }).eq("id", 1);
  if (!j?.title || !j?.body) return null;
  const slug = (new Date().toISOString().slice(0, 10) + "-" + String(j.title).toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 80);
  await db.from("greg_devlog").insert({ slug, title: String(j.title).replace(/[–—]/g, ","), summary: String(j.summary || "").replace(/[–—]/g, ","), body: String(j.body).replace(/[–—]/g, ","), status: "draft", stats });
  return { ok: true, slug };
}
