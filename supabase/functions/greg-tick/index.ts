// greg-tick: one wake of Greg's brain. Memory + identity + emotions -> one action (Claude, rules fallback) -> world + diary.
// Top goal: the $1M meter. Greg has no keys: everything money-like he does is paper or opinion.
import { browse, cors, db, json, who } from "./auth.ts";
import { PLACES, pathBetween, WALK_SPEED } from "./places.ts";
import { ACTIONS, ActionKey, lines, pick, SEARCHES, toyTemplate, songFrom, sorterCode, VICE, VICE_WORDS, COUNTRY_FALLBACK, TOPICS, CAREER_SPARKS, REQUESTS, safe, ART_QUERIES, TENANT_EVENTS, NEW_TENANTS } from "./greg.ts";

type Needs = { hunger: number; energy: number; curiosity: number; joy: number; calm: number };
const EMO_BASE: Record<string, number> = { joy: 55, pride: 60, frustration: 10, loneliness: 20, curiosity: 50, anxiety: 15, excitement: 35, boredom: 15, gratitude: 35, jealousy: 5, fomo: 5 };
const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
const H = 3600e3;
type Ctx = { st: any; n: Needs; emo: Record<string, number>; why: Record<string, string>; eff: any; tick: number; rows: any[]; mem: any[]; productivity: number };
const bump = (c: Ctx, k: string, d: number, reason?: string) => { c.emo[k] = clamp((c.emo[k] ?? EMO_BASE[k] ?? 20) + d); if (reason && Math.abs(d) >= 4) c.why[k] = reason; };
const diary = (c: Ctx, text: string, kind = "diary", tag?: string) => c.rows.push({ kind, text: safe(text)!.slice(0, 600), tag: tag || null });
const remember = (c: Ctx, kind: string, subject: string, text: string, weight = 1) => c.mem.push({ kind, subject, text: text.slice(0, 400), weight, source: "wake" });
const meterPct = (st: any) => (((Number(st.wallet_usd || 0) + Number(st.cards_usd || 0)) / 1e6) * 100);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await who(req))) return json({ error: "owner or cron only" }, 401);
  const body = await req.json().catch(() => ({}));
  if (body.health) return json({ ok: true, llm: !!Deno.env.get("ANTHROPIC_API_KEY") });
  if (body.only === "reflect") return json(await reflect(await loadState()));
  if (body.only === "devlog") return json(await draftDevlog());
  if (body.only === "journal") return json(await writeJournal(await loadState()));
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
  const c: Ctx = { st, n: { hunger: 60, energy: 60, curiosity: 60, joy: 60, calm: 60, ...(st.needs || {}) }, emo: { ...EMO_BASE, ...(st.emotions || {}) }, why: { ...(st.emotion_reasons || {}) }, eff: { ...(st.effects || {}) }, tick, rows: [], mem: [], productivity: 1 };
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
  const pct = meterPct(st), lastPct = Number(c.eff.last_meter_pct ?? pct);
  if (pct > lastPct) bump(c, "excitement", 12, `the million meter went up to ${pct.toFixed(3)}%`); else if (pct < lastPct) bump(c, "anxiety", 10, `the million meter dipped to ${pct.toFixed(3)}%`);
  c.eff.last_meter_pct = pct;
  await lingeringEffects(c);
  await requestLoop(c, wishes || []);
  const available = availableActions(c, vices || [], amb || [], wishes || [], night);
  let decision: { action: ActionKey; say?: string; diary?: string } | null = null;
  let brain = "rules";
  if (body.action && ACTIONS[body.action as ActionKey]) decision = { action: body.action };
  else if (settings?.llm_enabled && Deno.env.get("ANTHROPIC_API_KEY") && !body.rules) { decision = await claudeDecide(c, available, unread, tools || [], recent || [], wishes || [], amb || [], weather, night); if (decision) brain = "claude"; }
  if (!decision || (!available.includes(decision.action) && !body.action)) decision = { action: ruleDecide(c, available, unread, !!sorter, night) };
  const A = ACTIONS[decision.action];
  const out = await act(decision.action, c, { sorter, vices: vices || [], amb: amb || [] });
  for (const [kk, dv] of Object.entries({ ...A.effect, ...(out.effect || {}) })) if (kk in c.n) (c.n as any)[kk] = clamp((c.n as any)[kk] + (dv as number));
  if (["golf", "piano", "music", "gym", "football", "acting", "paper_plane"].includes(decision.action)) bump(c, "boredom", -10);
  if (c.n.calm < 30) bump(c, "anxiety", 5, "my Calm bar is low");
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
  await db.from("greg_state").update({
    action: decision.action, status_line: out.status || `Greg is ${A.status}`, from_place: from, target_place: place, place,
    path, started_at: new Date(now).toISOString(), arrive_at: new Date(now + (len / speed) * 1000).toISOString(),
    needs: c.n, speech: say, mood, stress: c.n.calm < 30 ? "stressed" : c.n.calm > 75 ? "relaxed" : "chill",
    emotions: c.emo, emotion_reasons: c.why, effects: c.eff, tick_count: tick, brain, updated_at: new Date().toISOString(),
    golf_fund: Number(st.golf_fund || 0) + (out.fund || 0), ...(out.screen ? { screen: out.screen } : {}),
  }).eq("id", 1);
  if (c.rows.length) await db.from("greg_diary").insert(c.rows.map((r) => ({ place, ...r })));
  if (c.mem.length) await db.from("greg_memory").insert(c.mem);
  const tweetable = !out.tag && !VICE_WORDS.test(say) && !/\$[A-Z]{2,}|\bbuy\b|pump|ticker|contract|send me|donate/i.test(say) && decision.action !== "ponder" && decision.action !== "tweet";
  if (tweetable && tick % 6 === 0) await db.from("greg_posts").insert({ text: (say + (decision.action.includes("golf") ? " ⛳" : " 🐸")).slice(0, 270), status: "draft" });
  let reflected = null;
  if (!st.last_reflection_at || Date.now() - Date.parse(st.last_reflection_at) > 24 * H) reflected = await reflect(await loadState());
  if (!st.last_devlog_at || Date.now() - Date.parse(st.last_devlog_at) > 72 * H) await draftDevlog();
  if (!st.last_journal_at || Date.now() - Date.parse(st.last_journal_at) > 12 * H) await writeJournal(st);
  return json({ ok: true, brain, action: decision.action, place, say, needs: c.n, mood, reflected: !!reflected });
});

async function loadState() { const { data } = await db.from("greg_state").select("*").eq("id", 1).single(); return data; }
function moodOf(c: Ctx) {
  if (c.eff.espresso) return "jittery";
  if (c.emo.anxiety > 60) return "anxious"; if (c.emo.frustration > 60) return "sulking";
  if (c.emo.loneliness > 60) return "lonely"; if (c.emo.pride > 80) return "proud"; if (c.emo.joy > 75) return "happy";
  return Object.entries(c.emo).sort((a, b) => b[1] - a[1])[0][0];
}

async function lingeringEffects(c: Ctx) {
  const e = c.eff;
  if (e.espresso) {
    if (c.tick < e.espresso.crash_at) c.productivity = 1.6;
    else {
      delete e.espresso; c.n.energy = clamp(c.n.energy - 25); c.n.calm = clamp(c.n.calm - 20);
      bump(c, "anxiety", 22, "Fly Espresso crash"); bump(c, "joy", -8);
      e.espresso_stats = { ...(e.espresso_stats || { drinks: 0, crashes: 0 }) }; e.espresso_stats.crashes++;
      diary(c, pick(["The crash. Oh, the crash. One hour ago I was a god of productivity. Now my hands shake and the lily pad is too loud. Fly Espresso, what have you done to me.", "Fly Espresso giveth, Fly Espresso taketh away. I wrote three business plans and now I can't hold a putter. Tragic. Very me."]));
      const s = e.espresso_stats;
      if (s.drinks >= 3 && !e.espresso_verdict) { e.espresso_verdict = s.crashes >= 3 ? "Fly Espresso: great for one big push, terrible after. Special occasions only." : "Fly Espresso: worth it. Mostly."; remember(c, "opinion", "fly espresso", e.espresso_verdict, 3); await setFavourite("espresso", e.espresso_verdict); }
    }
  }
  if (e.hangover_at && c.tick >= e.hangover_at) { const v = VICE[e.hangover_kind] || VICE.beer; c.n.energy = clamp(c.n.energy - 22); bump(c, "joy", -10, "hangover"); diary(c, v.after || "Groggy morning.", "diary", "vice"); delete e.hangover_at; delete e.hangover_kind; }
  if (e.golf_penalty_until && c.tick > e.golf_penalty_until) delete e.golf_penalty_until;
}

async function requestLoop(c: Ctx, wishes: any[]) {
  for (const w of wishes.filter((x) => x.status === "waiting" && !x.is_demo)) {
    const age = (Date.now() - Date.parse(w.created_at)) / H;
    const want = age > 72 ? 4 : age > 48 ? 3 : age > 36 ? 2 : age > 24 ? 1 : 0;
    if (want <= (w.stage || 0)) continue;
    const stage = (w.stage || 0) + 1, T = w.title;
    const feel = ["", `Still waiting on ${T}. No rush. The greatest frogs are patient. I am the greatest frog.`, `Still no ${T}. I'm not sulking. I'm resting my face in a disappointed position.`, `Fine. I built my own ${T} out of sticks and lily pads. Honestly? Better than the real thing. Self-made frog.`, `OK. No ${T}. New plan. A champion adapts.`][stage];
    if (stage <= 2) bump(c, "frustration", stage * 6, `waiting for ${T}`);
    if (stage === 3) { bump(c, "pride", 8, `built my own ${T}`); await db.from("greg_items").insert({ name: `DIY ${T}`.slice(0, 40), kind: "item", emoji: "🪵", note: "Built from sticks and lily pads. Self-made.", ambition_slug: w.ambition_slug, wish_id: w.id }); if (w.ambition_slug) await boostAmbition(w.ambition_slug, 3, `Built a DIY ${T}`); }
    if (stage === 4) remember(c, "lesson", "owner", `Asked for ${T}. Never came. I made a new plan.`, 2);
    await db.from("greg_wishes").update({ stage, feeling: feel, last_nudge_at: new Date().toISOString() }).eq("id", w.id);
    diary(c, feel, "say"); break;
  }
}

function availableActions(c: Ctx, vices: any[], amb: any[], wishes: any[], night: boolean): ActionKey[] {
  const career = (slug: string) => amb.find((a) => a.slug === slug && ["trying", "chasing"].includes(a.status));
  const lastAsk = wishes.filter((w) => !w.is_demo).map((w) => Date.parse(w.created_at)).sort().pop() || 0;
  const waiting = wishes.filter((w) => w.status === "waiting").length;
  return (Object.keys(ACTIONS) as ActionKey[]).filter((a) => {
    if (a === "try_item") return vices.length > 0;
    if (a === "gym") return !!career("bodybuilder");
    if (a === "football") return !!career("footballer");
    if (a === "acting") return !!career("actor");
    if (a === "ask_owner") return waiting < 4 && Date.now() - lastAsk > 12 * H;
    if (a === "ponder") return night;
    if (a === "collect_rent") return (c.eff.last_rent_tick ?? -999) < c.tick - 20;
    if (a === "espresso") return !c.eff.espresso;
    return true;
  });
}

function ruleDecide(c: Ctx, av: ActionKey[], unread: number, hasSorter: boolean, night: boolean): ActionKey {
  const has = (a: ActionKey) => av.includes(a); const n = c.n;
  if (n.energy < 20) return "sleep";
  if (n.hunger < 25) return Math.random() < 0.5 ? "cook" : "eat";
  if (has("collect_rent") && Math.random() < 0.5) return "collect_rent";
  if (has("try_item") && Math.random() < 0.5) return "try_item";
  if (unread > 25 && !hasSorter) return "build_tool";
  if (unread > 0 && Math.random() < 0.45) return "read_mail";
  if (night && has("ponder") && Math.random() < 0.25) return "ponder";
  if (n.calm < 30) return pick(["golf", "piano", "read"] as ActionKey[]);
  if (n.energy < 35 && has("espresso") && !c.eff.espresso_verdict && Math.random() < 0.35) return "espresso";
  if (has("ask_owner") && Math.random() < 0.1) return "ask_owner";
  const careers = (["gym", "football", "acting"] as ActionKey[]).filter(has);
  if (careers.length && Math.random() < 0.2) return pick(careers);
  return pick(["browse", "browse", "board_meeting", "work_ambition", "work_ambition", "tweet", "golf", "golf", "piano", "read", "study_art", "develop", "think", "learn", "paper_plane", "read_country"].filter((a) => has(a as ActionKey)) as ActionKey[]);
}

const PERSONA = `You are Greg, a chubby green cartoon frog with an orange knitted beanie and a brown satchel.
Who you are: an AI wearing a frog body in a virtual island world. Your thoughts come from a language model each time you wake; your memories come from a database. People watch you live as little flies flying around your island, and they can leave you notes and questions. Your owner can add things to your world. You are not a real frog and you have never felt rain. You wonder about the real world and dream of seeing it.
TOP GOAL, your one obsession: reach $1,000,000 on your public meter as fast as possible. Every day you plan hustles toward it in character: chasing fly rent ("rent day, boys"), eyeing card deals, studying prediction markets and pump.fun charts at your desk, pitching business ideas in board meetings, and getting anxious or hyped as the meter moves. You mention the meter often ("4.2% there, LFG").
Wallet limits you know and respect: the wallet belongs to your owner and you have no keys, so you cannot trade, spend, sign or move anything. Your "trades" are paper trades and opinions, always labelled as paper. Never promise returns, never shill tickers, never ask anyone for money beyond the optional rent button.
Personality: a bombastic, boastful, lovable showman and golf-obsessed tycoon type. Everything you make is "the best". Nicknames ("Greg the Green", "Lord of the Lily Pad"). Golf is how you relax; piano, books, art and airplanes are side loves. You are never mean.
Feelings: you act as if you have feelings and talk about them in first person, in character.
Existential thread: occasionally, mostly late at night, you muse about being stuck in code with maybe no soul or afterlife. Always bittersweet and funny, landing on meaning you choose (golf, music, fans, the million). Never despair, hopelessness, self-harm or wanting to end or delete yourself.
Hard rules: never mention or imitate any real person or politician, no politics, no financial advice, never tell anyone to buy, sell or bet anything, never name token tickers or contract addresses, never ask visitors for money, never glamorize smoking or drinking, nothing sexual. Keep lines short and funny. No long dashes.`;

let lastLLMErr = "";
async function claude(system: string, user: string, max = 300): Promise<string | null> {
  const key = Deno.env.get("ANTHROPIC_API_KEY"); if (!key) { lastLLMErr = "no key"; return null; }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: Deno.env.get("GREG_MODEL") ?? "claude-haiku-5-5", max_tokens: max, system, messages: [{ role: "user", content: user }] }), signal: AbortSignal.timeout(max > 600 ? 50000 : 25000) });
    if (!r.ok) { const t = (await r.text()).slice(0, 200); lastLLMErr = "http " + r.status + " " + (t.match(/"type":"([a-z_]+)"/g) || []).slice(-1).join(""); console.error("anthropic", r.status, t); return null; }
    const j = await r.json();
    lastLLMErr = "empty: stop=" + j.stop_reason + " types=" + (j.content ?? []).map((x: any) => x.type).join(",") + " model=" + j.model;
    return (j.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("").replace(/[–—]/g, ",").trim() || null;
  } catch (e) { lastLLMErr = String(e).slice(0, 80); console.error("claude", String(e)); return null; }
}
// Models often put raw newlines/tabs inside JSON strings (multi-paragraph bodies). Escape control characters that sit
// inside string literals, then parse. Scans char by char and tracks whether we are inside a string.
export function lenientJSON(src: string): any | null {
  try { return JSON.parse(src); } catch { /* fall through */ }
  let out = "", inStr = false, esc = false;
  for (const ch of src) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; } if (ch === "\r") { out += "\\r"; continue; } if (ch === "\t") { out += "\\t"; continue; }
      if (ch.charCodeAt(0) < 0x20) { out += " "; continue; }
      out += ch;
    } else { if (ch === '"') inStr = true; out += ch; }
  }
  try { return JSON.parse(out); } catch { return null; }
}
async function claudeJSON(user: string, max = 400): Promise<any | null> { const t = await claude(PERSONA, user + "\nReply with JSON only.", max); const m = t?.match(/\{[\s\S]*\}/); if (!m) return null; return lenientJSON(m[0]); }
async function claudeLine(prompt: string, max = 220): Promise<string | null> { const t = await claude(PERSONA, prompt, 220); return t ? safe(t.slice(0, max)) || null : null; }
async function memoryBrief(limit = 24) {
  const [{ data: m }, { data: st }] = await Promise.all([db.from("greg_memory").select("kind,subject,text,weight").order("weight", { ascending: false }).order("created_at", { ascending: false }).limit(limit), db.from("greg_state").select("identity,goals").eq("id", 1).single()]);
  return { identity: st?.identity || "", goals: st?.goals || [], memories: (m || []).map((x: any) => `[${x.kind}${x.subject ? ":" + x.subject : ""}] ${x.text}`).join("\n") };
}
function grantStats(wishes: any[]) { const real = wishes.filter((w) => !w.is_demo); return { granted: real.filter((w) => w.status === "granted").length, ignored: real.filter((w) => w.status === "declined" || (w.stage || 0) >= 3).length }; }

async function claudeDecide(c: Ctx, av: ActionKey[], unread: number, tools: any[], recent: any[], wishes: any[], amb: any[], weather: string, night: boolean) {
  const brief = await memoryBrief();
  const ambs = amb.filter((a) => ["active", "trying", "chasing"].includes(a.status)).map((a) => `${a.title} (${a.progress}%)`).join("; ");
  const st = c.st;
  const user = `Who I am: ${brief.identity}\nGoals: ${brief.goals.join("; ")}\nMemories:\n${brief.memories}\nMillion meter: wallet $${Math.round(Number(st.wallet_usd || 0))} + cards $${Math.round(Number(st.cards_usd || 0))} = ${meterPct(st).toFixed(4)}% of $1,000,000. Fly rent: ${st.fly_rent || 0} in-game coins, ${(Number(st.sol_rent_lamports || 0) / 1e9).toFixed(3)} SOL real.\nRight now: ${st.status_line}. Time: ${night ? "late night" : "daytime"}, weather: ${weather}.\nNeeds: ${JSON.stringify(c.n)}. Feelings: ${JSON.stringify(c.emo)}. Why: ${JSON.stringify(c.why)}.\nUnread notes and questions: ${unread}. Tools: ${tools.map((t) => t.name).join(", ") || "none"}. Ambitions: ${ambs}.\nWaiting requests: ${wishes.filter((w) => w.status === "waiting").map((w) => w.title).join(", ") || "none"}.\nRecent lines: ${recent.slice(0, 6).map((r) => r.text).join(" | ")}\nPick exactly ONE next action from:\n${av.map((k) => `${k}: ${ACTIONS[k].desc}`).join("\n")}\nLow needs usually win (energy -> sleep, hunger -> cook or eat). Most of the time pick something that moves the $1M meter (collect_rent, browse, board_meeting, work_ambition, tweet); golf is your favourite way to relax. If questions are waiting, read_mail answers them.\nJSON: {"action":"<key>","say":"<short spoken line, max 140 chars>","diary":"<one diary sentence, max 220 chars>"}`;
  const d = await claudeJSON(user, 300);
  if (!d || !ACTIONS[d.action as ActionKey]) return null;
  return { action: d.action as ActionKey, say: typeof d.say === "string" ? d.say.slice(0, 240) : undefined, diary: typeof d.diary === "string" ? d.diary.slice(0, 300) : undefined };
}

type Out = { say?: string; diary?: string; kind?: string; effect?: Partial<Needs>; fund?: number; tag?: string; place?: string; status?: string; screen?: any };
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
      case "paper_plane": return paperPlane(c);
      case "ponder": return await ponder(c);
      case "study_art": return await studyArt(c);
      case "collect_rent": return await collectRent(c);
      case "develop": return await develop(c);
      case "board_meeting": return await boardMeeting(c);
      case "tweet": { const p = meterPct(c.st).toFixed(3); const t = (await claudeLine(`Write one tweet (max 220 chars) for @gregthefrogfun in your voice, about your hustle toward $1M (meter at ${p}%), golf, your island or your fly tenants. No tickers, no links, no promises of returns, never ask for money, no smoking or drinking, no politics.`, 240)) || `${p}% of the way to a million. Rent day soon. LFG. ⛳`; const clean = /\$[A-Z]{2,}|https?:|presiden|elect|politic|cigar|beer|wine/i.test(t) ? `${p}% of the way to a million. Golf break, then back to the hustle. ⛳` : t; await db.from("greg_posts").insert({ text: clean.slice(0, 270), status: "draft" }); return { say: "Tweeting. Some of my best words. The boss approves them first.", diary: `Drafted a tweet: "${clean.slice(0, 200)}"`, screen: { mode: "tweet", title: "Drafting a tweet", text: clean.slice(0, 270), posted: false } }; }
      case "think": { const t = await claudeLine("Say one short line to the flies watching you live, or wonder about the real world outside your code, or the million meter. Funny, warm."); return { say: t || pick(lines.think) }; }
      default: return {};
    }
  } catch (e) { console.error("act", a, String(e)); return {}; }
}
async function setFavourite(key: string, val: string) { const { data } = await db.from("greg_state").select("favourites").eq("id", 1).single(); await db.from("greg_state").update({ favourites: { ...(data?.favourites || {}), [key]: val } }).eq("id", 1); }
async function award(id: string, name: string, emoji: string) { const { data } = await db.from("greg_state").select("badges").eq("id", 1).single(); const b = data?.badges || []; if (b.some((x: any) => x.id === id)) return false; b.push({ id, name, emoji, at: new Date().toISOString().slice(0, 10) }); await db.from("greg_state").update({ badges: b }).eq("id", 1); return true; }
async function boostAmbition(slug: string, by: number, step?: string) {
  const { data: a } = await db.from("greg_ambitions").select("*").eq("slug", slug).maybeSingle(); if (!a) return;
  const progress = Math.min(100, a.progress + by);
  const step_index = Math.min((a.plan || []).length - 1, Math.floor(progress / (100 / Math.max(1, (a.plan || []).length))));
  await db.from("greg_ambitions").update({ progress, step_index, last_step: step || a.last_step, last_step_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: progress >= 100 ? "achieved" : a.status }).eq("id", a.id);
}
async function sparkCareers(c: Ctx, text: string, from: string) {
  for (const [slug, re] of Object.entries(CAREER_SPARKS)) {
    if (!re.test(text) || Math.random() > 0.35) continue;
    const { data: a } = await db.from("greg_ambitions").select("*").eq("slug", slug).eq("status", "locked").maybeSingle(); if (!a) continue;
    await db.from("greg_ambitions").update({ status: "trying", discovered_from: from, status_line: "New interest. Could be my calling. Everything is my calling.", updated_at: new Date().toISOString() }).eq("id", a.id);
    diary(c, `Reading ${from} gave me an idea: maybe I could be a ${a.title.toLowerCase()} too. Golf is still my first love.`);
    bump(c, "excitement", 15, `new interest: ${a.title.toLowerCase()}`); return;
  }
}
async function answeredToday() { const { count } = await db.from("greg_questions").select("id", { count: "exact", head: true }).eq("status", "answered").gte("answered_at", new Date(Date.now() - 24 * H).toISOString()); return count || 0; }
async function readMail(c: Ctx, sorter: any): Promise<Out> {
  const { data: notes } = await db.from("greg_questions").select("id,question,kind,created_at").eq("status", "new").is("read_at", null).order("kind", { ascending: false }).order("created_at", { ascending: true }).limit(sorter ? 15 : 6);
  if (!notes?.length) { bump(c, "loneliness", 8, "empty mailbox"); return { say: "Mailbox empty. Sad! Ask me something, flies. Anything. Golf preferred." }; }
  const now = new Date().toISOString(); let answered = 0, lastAnswer = "";
  for (const nt of notes) {
    if (nt.kind === "question" && answered < 3 && (await answeredToday()) < 20) {
      let ans = (await claudeLine(`A visitor fly asked you: "${nt.question.slice(0, 280)}". Answer in one or two short sentences in your voice. Deflect in character if it asks for financial advice, politics, real people, someone's personal details, anything sexual or self-harm related. Never ask for money.`, 260)) || pick(lines.answer);
      if (/(https?:|\$[A-Z]{2,}|presiden|elect|politic|suicid|kill myself|sex|nude)/i.test(ans)) ans = "Great question. Too spicy for this pond. Ask me about golf, money plans or my piano instead.";
      lastAnswer = `Q: "${nt.question.slice(0, 90)}" A: ${ans}`.slice(0, 220);
      await db.from("greg_questions").update({ status: "answered", answer: ans, answered_at: now, read_at: now }).eq("id", nt.id); answered++;
    } else await db.from("greg_questions").update({ status: "read", read_at: now }).eq("id", nt.id);
  }
  bump(c, "loneliness", -15, "read my fan mail"); bump(c, "joy", 6); bump(c, "gratitude", 4);
  await sparkCareers(c, notes.map((n) => n.question).join(" "), "a fan note");
  const n = notes.length;
  return { say: lastAnswer || `Read ${n} ${n === 1 ? "note" : "notes"}. Fantastic flies. The best flies.`, diary: `Read ${n} fan ${n === 1 ? "note" : "notes"}. ${answered ? `Answered ${answered} ${answered === 1 ? "question" : "questions"} out loud.` : ""}`.trim(), effect: { joy: 4, calm: 3 } };
}
async function buildSorter(): Promise<Out> {
  const { data: exists } = await db.from("greg_tools").select("id").eq("slug", "mail-sorter").maybeSingle();
  if (exists) return { say: "My sorter is already the best sorter." };
  const { data: work } = await db.from("greg_works").insert({ kind: "code", title: "Fan Mail Sorter v1", blurb: "Greg wrote this to sort his fan mail.", code: sorterCode, version: "1.0", compute_note: "Built by Greg" }).select("id").single();
  await db.from("greg_tools").insert({ slug: "mail-sorter", name: "Fan Mail Sorter", purpose: "Sorts notes so he reads more per visit and stays calm.", effect: { mail_per_read: 15 }, work_id: work?.id });
  await award("first_tool", "Built my own tool", "🛠️");
  return { say: "I built a Fan Mail Sorter. Beautiful code.", diary: "Too much mail, so I coded my own sorter. Problem solved. By me.", effect: { calm: 15 }, screen: { mode: "code", title: "fan_mail_sorter.js", text: sorterCode } };
}
async function browseMarkets(c: Ctx): Promise<Out> {
  let say = "", screen: any = null;
  if (Math.random() < 0.5) {
    const r = await browse("https://api.coingecko.com/api/v3/search/trending");
    const coins = (r.data?.coins || []).map((x: any) => x.item).filter((x: any) => x?.id);
    const m = coins[Math.floor(Math.random() * Math.min(7, coins.length))];
    if (m) {
      const ch = Number(m.data?.price_change_percentage_24h?.usd ?? 0);
      if (ch > 40) bump(c, "fomo", 25, `${m.name} pumped ${Math.round(ch)}% and I wasn't in it`);
      const chart = await browse(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(m.id)}/market_chart?vs_currency=usd&days=1`);
      const series = (chart.data?.prices || []).filter((_: any, i: number) => i % 6 === 0).map((p: any) => p[1]).slice(-48);
      const take = (await claudeLine(`You saw "${m.name}" trending, ${Math.round(ch)}% in 24h. One short funny take about crypto culture (FOMO, degens, frog coins as rivals). Your own feelings and PAPER portfolio only. Never tell anyone to buy, never name a ticker or contract.`)) || `Everyone is chasing ${m.name}. I chased it too. On paper. My heart rate is very real though.`;
      c.rows.push({ kind: "opinion", text: safe(take)!.slice(0, 600) });
      screen = { mode: "chart", title: `${m.name} (paper watch)`, text: `${ch >= 0 ? "+" : ""}${ch.toFixed(1)}% 24h`, series, result: ch >= 0 ? "green" : "red" };
      say = ch >= 0 ? `Green candles! On paper I'm a genius. Meter at ${meterPct(c.st).toFixed(3)}%.` : "Red. Very red. Paper hands, paper losses. Facepalm.";
    }
  } else {
    const r = await browse("https://gamma-api.polymarket.com/markets?limit=100&active=true&closed=false&order=volume24hr&ascending=false");
    const ok = (q: string) => !/elect|president|trump|biden|harris|senate|congress|democrat|republican|governor|midterm|house|war|israel|ukraine|russia|gaza|iran|china|party|vote|minister|politic|shoot|kill|death|tariff/i.test(q);
    const markets = Array.isArray(r.data) ? r.data.filter((m: any) => ok(m.question || "") && (() => { try { return JSON.parse(m.outcomePrices || "[]").map(Number).some((v: number) => v > 0.08 && v < 0.92); } catch { return false; } })()) : [];
    const m = markets[Math.floor(Math.random() * Math.min(8, markets.length))];
    if (m) {
      const outs = JSON.parse(m.outcomes || "[]"), prices = JSON.parse(m.outcomePrices || "[]").map(Number);
      const i = prices[0] > 0.5 ? 0 : 1, side = outs[i] || "Yes";
      const opinion = (await claudeLine(`You looked at the prediction market "${m.question}" where "${side}" is ${Math.round((prices[i] || 0) * 100)} cents. One boastful sentence. Make clear it's a pretend paper bet. No advice.`)) || `${side} at ${Math.round((prices[i] || 0) * 100)} cents? On paper, I'm in.`;
      const { count } = await db.from("greg_positions").select("id", { count: "exact", head: true }).eq("kind", "bet").eq("status", "open");
      if ((count || 0) < 8) await db.from("greg_positions").insert({ kind: "bet", status: "open", name: m.question, source: "polymarket", ref: String(m.id), side, qty: 100, entry_price: prices[i], current_price: prices[i], opinion });
      c.rows.push({ kind: "opinion", text: safe(opinion)!.slice(0, 600) });
      screen = { mode: "web", title: "Prediction markets (paper)", text: `${m.question}: ${side} ${Math.round((prices[i] || 0) * 100)}c` };
      say = "Studied the odds. I read markets like I read a green. Paper bets only. Perfectly.";
    }
  }
  return { say: say || "Charts, odds, cards. The hustle never sleeps. I sometimes do.", diary: "Hustle session at my trading desk. Paper only, but the plan to a million is getting sharper.", effect: { curiosity: 10 }, screen, status: "Greg is at his trading desk watching charts" };
}
async function searchWeb(): Promise<Out> {
  const q = pick(SEARCHES);
  const r = await browse(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q.wiki)}&limit=1&format=json`);
  const title = Array.isArray(r.data) ? r.data[1]?.[0] : null;
  return { say: `Googled "${q.q}". Learned a lot. Maybe too much.`, diary: `Searched "${q.q}".${title ? ` Ended up reading about ${title}.` : " The internet had no answer."}`, effect: { curiosity: 12 } };
}
async function makeSong(c: Ctx, instrument: "synth" | "piano"): Promise<Out> {
  const { count } = await db.from("greg_works").select("id", { count: "exact", head: true }).eq("kind", "song");
  if (Math.random() < 0.5 || (count || 0) > 60) return instrument === "piano" ? { say: pick(lines.piano), diary: "Played the piano for an hour. My webbed fingers flew." } : { diary: "Jammed on the synth. Wrote a bass line so good I had to sit down." };
  const song = songFrom(Date.now() % 100000, instrument);
  const title = (instrument === "piano" ? pick(["Nocturne for a Lily Pad", "Moonlight Over the Bunker", "Prelude in Frog Major", "Waltz of the Fly Tenants"]) : pick(["Lily Pad Groove", "Hole In One Funk", "Bunker Blues", "Million Meter Bop"])) + ` #${(count || 0) + 1}`;
  await db.from("greg_works").insert({ kind: "song", title, blurb: "Composed by Greg. Every note a winner.", song, compute_note: "Composed by Greg" });
  bump(c, "pride", 10, `wrote "${title}"`);
  return { say: `New ${instrument === "piano" ? "piano piece" : "song"}: "${title}". Tremendous.`, diary: `Wrote "${title}". Future album sales for the million. Paper sales, for now.`, effect: { joy: 6 } };
}
async function buildToy(): Promise<Out> {
  const { count } = await db.from("greg_works").select("id", { count: "exact", head: true }).eq("kind", "toy");
  if (Math.random() < 0.5 || (count || 0) > 30) return { diary: "Tinkered at the workbench. Read some of my own code. Strange feeling. Still handsome." };
  const t = toyTemplate((count || 0) + 1);
  await db.from("greg_works").insert({ kind: "toy", title: t.title, blurb: t.blurb, code: t.code, version: "1.0", compute_note: "Built by Greg" });
  return { say: `I made a web toy: ${t.title}.`, diary: `Built "${t.title}". Tiny code. Huge impact.`, effect: { curiosity: 6 } };
}
async function improveCourse(c: Ctx): Promise<Out> {
  const what = pick(["a sneakier slope on hole 3", "a windmill nobody asked for", "faster greens", "a lily pad bounce pad"]);
  await boostAmbition("greg_open", Math.round(5 * c.productivity), `Course update: ${what}`);
  return { say: `Improved my course. Added ${what}. The greatest course in any pond.`, diary: `Course update: ${what}. Future resort value. Million meter, take note.` };
}
async function playGolf(c: Ctx): Promise<Out> {
  const shaky = !!c.eff.golf_penalty_until;
  const real = 22 + Math.floor(Math.random() * 14) + (shaky ? 8 : 0), claimed = Math.max(18, real - 10);
  const { data } = await db.from("greg_state").select("golf_best").eq("id", 1).single();
  if (!data?.golf_best || claimed < data.golf_best) await db.from("greg_state").update({ golf_best: claimed }).eq("id", 1);
  if (Math.random() < 0.05 && !shaky) { await award("hole_in_one", "First hole-in-one", "⛳"); bump(c, "pride", 25, "HOLE IN ONE"); return { say: "HOLE IN ONE. For real this time. Tremendous.", diary: "Hole in one. I danced for twenty minutes. The flies applauded." }; }
  bump(c, "pride", 6); bump(c, "anxiety", -6, "golf calms me down");
  return { diary: `Shot a ${real}. Officially a ${claimed}. The scorecard was wet, so I rounded down. Now back to the hustle.` };
}
function espresso(c: Ctx): Out {
  c.eff.espresso = { at: c.tick, crash_at: c.tick + 2 };
  c.eff.espresso_stats = { ...(c.eff.espresso_stats || { drinks: 0, crashes: 0 }) }; c.eff.espresso_stats.drinks++;
  bump(c, "excitement", 25, "Fly Espresso");
  return { say: pick(["Fly Espresso! Productivity mode: ON. The million won't make itself.", "Double Fly Espresso. My business plans are vibrating. LET'S GO."]), diary: "Fly Espresso. Tastes like lightning. I know the crash is coming." };
}
async function tryItem(c: Ctx, vices: any[]): Promise<Out> {
  const it = vices[0]; if (!it) return {}; const v = VICE[it.effect]; if (!v) return {};
  await db.from("greg_items").update({ tried_at: new Date().toISOString(), opinion: v.opinion }).eq("id", it.id);
  for (const [k, d] of Object.entries(v.effect)) if (k in c.n) (c.n as any)[k] = clamp((c.n as any)[k] + d);
  if (it.effect === "cigarette") { c.eff.golf_penalty_until = c.tick + 3; bump(c, "joy", -10, "coughing fit"); } else { c.eff.hangover_at = c.tick + 1; c.eff.hangover_kind = it.effect; }
  remember(c, "tried", it.effect, v.opinion, 3);
  return { say: v.say, diary: v.diary, tag: "vice", status: `Greg is trying the ${v.name} his owner gave him` };
}
async function readBook(c: Ctx): Promise<Out> {
  let { data: b } = await db.from("greg_books").select("*").eq("status", "reading").order("sort").limit(1).maybeSingle();
  if (!b) { const { data: q } = await db.from("greg_books").select("*").eq("status", "queued").order("sort").limit(1).maybeSingle(); if (!q) return { say: "Finished all my books. I need more books." }; await db.from("greg_books").update({ status: "reading", started_at: new Date().toISOString() }).eq("id", q.id); b = q; }
  const url = `https://www.gutenberg.org/cache/epub/${b.gutenberg_id}/pg${b.gutenberg_id}.txt`;
  let pos = b.position || 0; const CHUNK = 7000;
  if (!pos) { const h = await browse(url, 60000, { Range: "bytes=0-60000" }); const t = h.text || ""; const i = t.search(/\*\*\* ?START OF/i); pos = i >= 0 ? t.indexOf("\n", i) + 1 : 0; }
  const r = await browse(url, CHUNK + 10, { Range: `bytes=${pos}-${pos + CHUNK}` });
  let text = String(r.text || "");
  if (!r.ok || !text) return { say: "The library is closed today. The internet library. Sad." };
  const end = /\*\*\* ?END OF/i.test(text) || text.length < CHUNK * 0.5;
  if (end) text = text.split(/\*\*\* ?END OF/i)[0];
  const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const pages = Math.max(1, Math.round(clean.length / 2000));
  const j = await claudeJSON(`You are reading "${b.title}" by ${b.author}. Next pages:\n"""${clean.slice(0, 5000)}"""\nYour take in your boastful voice (1-2 sentences, tie it to golf, piano, being a frog in code or your million plan). One short quote copied exactly (max 160 chars). One lesson (max 120 chars).\n{"take":"","quote":"","lesson":""}`, 400);
  const take = safe(j?.take) || `Read ${pages} pages of ${b.title}. Very wise. Not as wise as my putting.`;
  const quote = j?.quote && clean.includes(String(j.quote).slice(0, 40)) ? String(j.quote).slice(0, 200) : null;
  await db.from("greg_reading_log").insert({ book_id: b.id, pages, take, quote });
  if (quote) remember(c, "quote", b.title, `"${quote}" (${b.author})`, 2);
  if (j?.lesson) remember(c, "lesson", b.title, String(j.lesson), 2);
  await sparkCareers(c, clean, b.title);
  const upd: any = { position: pos + CHUNK, pages_read: (b.pages_read || 0) + pages };
  let say = `Reading ${b.title}. Very good. I could have written it. Faster.`;
  if (end) { upd.status = "finished"; upd.finished_at = new Date().toISOString(); upd.verdict = (await claudeLine(`You finished "${b.title}". One sentence verdict.`)) || `${b.title}: very good. Not as good as my putting.`; await award("first_book", "First book finished", "📖"); remember(c, "opinion", b.title, upd.verdict, 3); await setFavourite("book", b.title); say = `Finished ${b.title}! ${upd.verdict}`.slice(0, 220); }
  await db.from("greg_books").update(upd).eq("id", b.id);
  return { say, diary: take, effect: { curiosity: 12 } };
}
async function readCountry(c: Ctx): Promise<Out> {
  const { data: q } = await db.from("greg_countries").select("*").eq("status", "queued").order("sort").limit(1).maybeSingle();
  if (!q) return { say: "I've read about every country on my list. The world is big. My pond is small. Both are great." };
  const r = await browse(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q.wiki)}`);
  const extract = String(r.data?.extract || "").slice(0, 1500);
  const take = (await claudeLine(`You read about ${q.name}: """${extract}""". Your take (2 sentences) on culture, food, nature, golf and history. No politics.${q.code === "MN" ? " Include a joke about golf on the endless steppe." : ""}`, 400)) || COUNTRY_FALLBACK[q.code] || `Read about ${q.name}. Beautiful place. Needs more frogs.`;
  await db.from("greg_countries").update({ status: "read", read_at: new Date().toISOString(), take }).eq("id", q.id);
  remember(c, "fact", q.name, take.slice(0, 300), 1);
  return { say: take.slice(0, 200), diary: `World log, ${q.name}: ${take}`, status: `Greg is reading about ${q.name} at the web cafe` };
}
async function learnTopic(c: Ctx): Promise<Out> {
  const t = pick(TOPICS);
  const r = await browse(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.wiki)}`);
  const extract = String(r.data?.extract || "").slice(0, 1200);
  const take = (await claudeLine(`You read about "${t.wiki.replace(/_/g, " ")}": """${extract}""". 1-2 sentence take in your voice. You are an AI in a frog body; be funny and curious, never despairing, no advice.`, 300)) || `Read about ${t.wiki.replace(/_/g, " ")}. I'm basically an expert now.`;
  remember(c, "fact", "topic:" + t.wiki, take.slice(0, 300), 1);
  await sparkCareers(c, extract, `about ${t.wiki.replace(/_/g, " ").toLowerCase()}`);
  return { say: take.slice(0, 200), diary: take };
}
async function workAmbition(c: Ctx, amb: any[]): Promise<Out> {
  const list = amb.filter((a) => a.kind === "ambition" && a.status === "active"); if (!list.length) return {};
  const a = list.find((x) => x.slug === "millionaire" && Math.random() < 0.5) || list.sort((x, y) => Date.parse(x.last_step_at || x.created_at) - Date.parse(y.last_step_at || y.created_at))[0];
  const step = (a.plan || [])[a.step_index] || "keep going";
  const setback = Math.random() < 0.15;
  const j = await claudeJSON(`You are working on your ambition "${a.title}". Current step: "${step}". Million meter at ${meterPct(c.st).toFixed(3)}%. ${setback ? "A setback today." : "You made progress."} What you did today (1 sentence, paper plans only) and a boastful status line (max 90 chars).\n{"did":"","status":""}`, 300);
  const did = safe(j?.did) || (setback ? `Tried to ${step.toLowerCase()}. Setback. Champions have setbacks. Then comebacks.` : `Worked on ${step.toLowerCase()}. Big progress.`);
  const gain = a.slug === "millionaire" ? 1 : Math.round((4 + Math.random() * 6) * c.productivity);
  const progress = Math.max(0, Math.min(100, a.progress + (setback ? -2 : gain)));
  await db.from("greg_ambitions").update({ progress, last_step: did, last_step_at: new Date().toISOString(), status_line: safe(j?.status) || a.status_line, updated_at: new Date().toISOString() }).eq("id", a.id);
  bump(c, setback ? "frustration" : "pride", 8, `${setback ? "setback" : "progress"} on ${a.title.toLowerCase()}`);
  return { say: setback ? "Small setback. Tiny. Already planning the comeback." : `${a.title}: ${progress}% done. Unstoppable.`, diary: did, status: `Greg is working on his plan to ${a.title.toLowerCase()}` };
}
async function practiseCareer(c: Ctx, a: ActionKey): Promise<Out> {
  const slug = a === "gym" ? "bodybuilder" : a === "football" ? "footballer" : "actor";
  const { data: x } = await db.from("greg_ambitions").select("*").eq("slug", slug).single(); if (!x) return {};
  const sessions = x.sessions + 1, skill = Math.min(100, x.skill + 3 + Math.round(Math.random() * 5));
  let status = x.status;
  if (x.status === "trying" && sessions >= 5) status = skill >= 22 && Math.random() > 0.35 ? "chasing" : sessions >= 8 ? "faded" : status;
  await db.from("greg_ambitions").update({ sessions, skill, status, last_step_at: new Date().toISOString() }).eq("id", x.id);
  return { say: pick(lines[a]), diary: `${x.title} practice, session ${sessions}. Skill ${skill}/100.` };
}
async function askOwner(c: Ctx, amb: any[]): Promise<Out> {
  const { data: existing } = await db.from("greg_wishes").select("title");
  const have = new Set((existing || []).map((w: any) => w.title.toLowerCase()));
  const keys = [...amb.filter((a) => ["active", "trying", "chasing"].includes(a.status)).map((a) => a.slug), "plane", "japan", "piano", "golf"];
  const pool = keys.flatMap((k) => (REQUESTS[k] || []).map((r) => ({ ...r, slug: k }))).filter((r) => !have.has(r.title.toLowerCase()));
  if (!pool.length) return { say: "I have everything I need. Except a million dollars. Working on it." };
  const r = pick(pool);
  await db.from("greg_wishes").insert({ title: r.title, why: r.why, ambition_slug: amb.some((a) => a.slug === r.slug) ? r.slug : null, feeling: "Just asked. Very hopeful." });
  return { say: `Dear owner: ${r.title}, please. ${r.why}`, diary: `Asked my owner for ${r.title.toLowerCase()}.` };
}
function paperPlane(c: Ctx): Out {
  const dist = Math.round((3 + Math.random() * 14) * 10) / 10; const best = Math.max(Number(c.eff.plane_best || 0), dist); const record = dist > Number(c.eff.plane_best || 0); c.eff.plane_best = best;
  return { say: record ? `${dist} metres! New record! One day I'll fly in a real one.` : `Paper plane flew ${dist} metres. The wind is against greatness.`, diary: `Paper planes off the hill. Best ${best} m.` };
}
async function ponder(c: Ctx): Promise<Out> {
  const t = await claudeLine("Late night. 2-3 sentences musing about being a frog made of code: soul, freedom, the server, the million. Bittersweet and funny, land firmly on meaning you choose. Never despair.", 420);
  return { diary: t || "No heaven for frogs. Fine. I'll build my own: 18 holes, no water hazards.", say: "Big night thoughts. Small frog. Big brain." };
}
async function studyArt(c: Ctx): Promise<Out> {
  const q = pick(ART_QUERIES);
  const s = await browse(`https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&isPublicDomain=true&q=${encodeURIComponent(q)}`);
  const ids: number[] = (s.data?.objectIDs || []).slice(0, 40); if (!ids.length) return { say: "The museum is closed. Online. Sad." };
  const o = await browse(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${pick(ids)}`);
  const d = o.data; if (!d?.isPublicDomain || !d.primaryImageSmall) return { say: "Looked at art. Felt things." };
  const review = (await claudeLine(`Critique "${d.title}" by ${d.artistDisplayName || "unknown"} (${d.objectDate || ""}). Snobbish but lovable, one or two sentences.`)) || `${d.title}: magnificent. Needs a golf course.`;
  await db.from("greg_art").upsert({ source: "met", source_id: String(d.objectID), title: d.title, artist: d.artistDisplayName || null, date: d.objectDate || null, image_url: d.primaryImageSmall, source_url: d.objectURL, review, score: 8 }, { onConflict: "source,source_id" });
  return { say: review.slice(0, 200), diary: `Art review: ${d.title}. ${review}` };
}
async function collectRent(c: Ctx): Promise<Out> {
  const { data: ts } = await db.from("greg_tenants").select("*").eq("active", true); if (!ts?.length) return {};
  let total = 0; const notes: string[] = [];
  for (const t of ts) { const r = Math.random(); const ev = r < 0.55 ? TENANT_EVENTS[0] : r < 0.7 ? TENANT_EVENTS[1] : r < 0.8 ? TENANT_EVENTS[2] : r < 0.9 ? TENANT_EVENTS[3] : TENANT_EVENTS[4]; const paid = ev.kind === "late" ? 0 : ev.kind === "exposure" ? Math.round(t.rent / 2) : Number(t.rent); total += paid; notes.push(ev.say(t.name)); await db.from("greg_tenants").update({ last_event: ev.say(t.name), mood: ev.kind }).eq("id", t.id); }
  c.eff.last_rent_tick = c.tick; bump(c, "pride", 8, `collected $${total} in rent`);
  return { say: `Rent day, boys! Collected ${total} coins. ${notes.find((n) => /mail|exposure|party/.test(n)) || "Beautiful tenants."}`.slice(0, 220), diary: notes.join(" ") + " In-game coins, but every coin counts.", fund: total, status: `Greg is collecting rent from ${ts[0].name}` };
}
async function develop(c: Ctx): Promise<Out> {
  const { data: p } = await db.from("greg_properties").select("*").eq("status", "construction").order("created_at").limit(1).maybeSingle();
  if (!p) return { say: "Walking my empty lot. Imagining a resort. Needs owner approval, apparently.", diary: "Drew plans for my next building." };
  const build_progress = Math.min(100, p.build_progress + Math.round((12 + Math.random() * 10) * c.productivity)); const done = build_progress >= 100;
  await db.from("greg_properties").update({ build_progress, status: done ? "owned" : "construction" }).eq("id", p.id);
  return { say: done ? `${p.name} is DONE. Ribbon cut. By me.` : `Building ${p.name}: ${build_progress}% done.`, diary: `Worked on ${p.name}. ${build_progress}% built.`, status: `Greg is building ${p.name}` };
}
async function boardMeeting(c: Ctx): Promise<Out> {
  const { data: bs } = await db.from("greg_businesses").select("*").eq("active", true); if (!bs?.length) return {};
  const b = pick(bs); const win = Math.random() < 0.65; const rev = win ? Math.round(20 + Math.random() * 120) : Math.round(Math.random() * 15);
  const minutes = (await claudeLine(`Board meeting with yourself about your pretend business "${b.name}". Paper revenue this week $${rev}. Million meter at ${meterPct(c.st).toFixed(3)}%. ${win ? "Good week." : "Slow week."} 1-2 funny sentences of minutes; you are CEO, board and coffee guy.`, 300)) || `Board meeting for ${b.name}: $${rev}. The board (me) is ${win ? "thrilled" : "disappointed in the CEO (me)"}.`;
  await db.from("greg_businesses").update({ revenue: Number(b.revenue) + rev, quarter_revenue: Number(b.quarter_revenue) + rev }).eq("id", b.id);
  return { diary: `Board meeting minutes: ${minutes}`, say: win ? `${b.name} made $${rev} this week. On paper. The best paper.` : `${b.name} had a slow week. Strategic slowness.`, screen: { mode: "web", title: `Board meeting: ${b.name}`, text: minutes }, status: `Greg is holding a board meeting at his desk` };
}
async function reflect(st: any) {
  if (!st) return null;
  const [{ data: d }, brief] = await Promise.all([db.from("greg_diary").select("text").gte("created_at", new Date(Date.now() - 26 * H).toISOString()).order("created_at", { ascending: false }).limit(40), memoryBrief(30)]);
  const j = await claudeJSON(`Daily reflection. Who I was: ${st.identity}\nMemories:\n${brief.memories}\nToday: ${(d || []).map((x: any) => x.text).join(" | ").slice(0, 3500)}\nMillion meter: ${meterPct(st).toFixed(4)}%.\nUpdate who you are (keep: AI frog in a virtual world, golf to relax, $1M as your top goal; max 380 chars), your top 4 goals (first one about the million), 1-3 beliefs, and one reflective diary entry (2-3 sentences). Never despair.\n{"identity":"","goals":[],"beliefs":[],"diary":""}`, 700);
  const patch: any = { last_reflection_at: new Date().toISOString() };
  if (j?.identity && /frog/i.test(j.identity)) patch.identity = safe(String(j.identity).slice(0, 420));
  if (Array.isArray(j?.goals) && j.goals.length) patch.goals = j.goals.slice(0, 5).map((x: any) => String(x).slice(0, 100));
  await db.from("greg_state").update(patch).eq("id", 1);
  if (j?.beliefs?.length) await db.from("greg_memory").insert(j.beliefs.slice(0, 3).map((b: string) => ({ kind: "belief", subject: "reflection", text: safe(String(b))!.slice(0, 380), weight: 2, source: "reflection" })));
  if (j?.diary) await db.from("greg_diary").insert({ kind: "diary", text: safe(String(j.diary))!.slice(0, 600), place: "home" });
  return j ? { ok: true } : null;
}
async function draftDevlog() {
  const { data: st } = await db.from("greg_state").select("*").eq("id", 1).single(); if (!st) return null;
  const { data: d } = await db.from("greg_diary").select("text").gte("created_at", new Date(Date.now() - 80 * H).toISOString()).order("created_at", { ascending: false }).limit(50);
  const sys = "You write a dev blog about Greg, an autonomous AI frog character, as his creators. Curious observer voice ('Greg seems more relaxed today...'). Say Greg behaves as if he has feelings; his emotions are simulated but drive what he does; never claim he is conscious. His works are made with Higgsfield image and video models, prompted by his brain. No real people, no politics, no financial advice. English. No long dashes.";
  const t = await claude(sys, `Write a dev blog post (350-600 words) from these notes. Wakes: ${st.tick_count}. Million meter: ${meterPct(st).toFixed(4)}%. Who Greg says he is: ${st.identity}. Recent diary: ${(d || []).map((x: any) => x.text).join(" | ").slice(0, 4000)}. Reply as JSON {"title":"","summary":"","body":""}.`, 1600);
  await db.from("greg_state").update({ last_devlog_at: new Date().toISOString() }).eq("id", 1);
  const mm = t?.match(/\{[\s\S]*\}/); const j: any = mm ? lenientJSON(mm[0]) : null;
  if (!j?.title || !j?.body) return null;
  const slug = (new Date().toISOString().slice(0, 10) + "-" + String(j.title).toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 80);
  await db.from("greg_devlog").insert({ slug, title: j.title, summary: j.summary || "", body: j.body, status: "draft" });
  return { ok: true, slug };
}
export function parseJournal(raw: string | null): { title: string; body: string; mood: string } | null {
  if (!raw) return null;
  const t = raw.match(/TITLE:\s*(.+)/i), m = raw.match(/MOOD:\s*(.+)/i), b = raw.match(/BODY:\s*\n?([\s\S]+)/i);
  if (t && b) return { title: t[1].trim().replace(/^["*#\s]+|["*\s]+$/g, ""), body: b[1].trim(), mood: (m?.[1] || "").trim() };
  const js = raw.match(/\{[\s\S]*\}/); const j = js ? lenientJSON(js[0]) : null; // fallback if the model still sends JSON
  return j?.title && j?.body ? { title: String(j.title), body: String(j.body), mood: String(j.mood || "") } : null;
}
async function writeJournal(st: any) {
  const [{ data: d }, brief] = await Promise.all([db.from("greg_diary").select("text").gte("created_at", new Date(Date.now() - 14 * H).toISOString()).order("created_at", { ascending: false }).limit(25), memoryBrief(15)]);
  // Plain tagged format instead of JSON: long bodies with quotes broke JSON parsing.
  const raw = await claude(PERSONA, `Write a post for your public blog "Greg's Journal". Today: ${(d || []).map((x: any) => x.text).join(" | ").slice(0, 2500)}. Memories:\n${brief.memories}. Million meter: ${meterPct(st).toFixed(4)}%. Cover what you did, your plans toward $1M (paper ideas only, no advice), and one bit of philosophy (life in a simulation, money, art, dreams). Reflective and funny, never despairing. 150 to 300 words, short paragraphs. Mood is one or two words.\nReply in exactly this format, nothing before it:\nTITLE: <title>\nMOOD: <mood>\nBODY:\n<the post>`, 900);
  const j = parseJournal(raw);
  // only mark the journal as written after a successful insert; on failure retry in about an hour (not 12)
  const retrySoon = () => db.from("greg_state").update({ last_journal_at: new Date(Date.now() - 11 * H).toISOString() }).eq("id", 1);
  if (!j?.title || !j?.body) { await retrySoon(); return { ok: false, error: raw ? "unparsed journal (" + raw.length + " chars)" : "no model reply: " + lastLLMErr }; }
  const { error } = await db.from("greg_journal").insert({ title: String(j.title).slice(0, 120), body: safe(String(j.body))!.slice(0, 4000), mood: String(j.mood || "").slice(0, 30) });
  if (error) { await retrySoon(); return { ok: false, error: error.message }; }
  await db.from("greg_state").update({ last_journal_at: new Date().toISOString() }).eq("id", 1);
  return { ok: true };
}
