// greg-x: posts Greg's tweets to @gregthefrogfun using the OAuth2 tokens saved by the x-auth function
// in public.x_accounts (handle 'gregthefrogfun'). Refreshes the token when it is within 5 minutes of expiry.
// OFF until the owner turns on x_enabled. x_mode "approve" posts only approved drafts; "free" posts drafts too.
// Content filter: no links, politics, real people, financial advice, tickers, smoking or drinking. Up to 32 posts a day, at least 44 minutes apart. Writes its own draft when the queue is empty.
import { cors, db, json, who } from "./auth.ts";

const HANDLE = "gregthefrogfun";
const BLOCK = /(https?:|www\.|\bbuy\b|\bsell\b|not financial|financial advice|guarantee|\$[A-Z]{2,}|contract address|presiden|elect|senat|congress|politic|vote|democrat|republican|minister|trump|biden|musk|airdrop|giveaway|dm me|cigar|smok|beer|wine|drunk|hangover|alcohol|suicid|kill myself)/i;
export const filterPost = (t: string) => !BLOCK.test(t) && t.length > 3 && t.length <= 280 && !/[–—]/.test(t);

async function token(): Promise<string> {
  const { data: a } = await db.from("x_accounts").select("id,access_token,refresh_token,expires_at").eq("handle", HANDLE).maybeSingle();
  if (!a?.access_token) throw new Error("X account not connected");
  if (a.expires_at && Date.parse(a.expires_at) - Date.now() > 5 * 60e3) return a.access_token;
  if (!a.refresh_token) throw new Error("no refresh token");
  const id = Deno.env.get("X_CLIENT_ID")!, secret = Deno.env.get("X_CLIENT_SECRET")!;
  const r = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + btoa(`${id}:${secret}`) },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: id }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { await db.from("x_accounts").update({ last_error: `refresh ${r.status}` }).eq("id", a.id); throw new Error(`token refresh failed ${r.status}`); }
  await db.from("x_accounts").update({ access_token: j.access_token, refresh_token: j.refresh_token || a.refresh_token, expires_at: new Date(Date.now() + (j.expires_in || 7200) * 1000).toISOString(), last_error: null }).eq("id", a.id);
  return j.access_token;
}

async function tweet(text: string) {
  const r = await fetch("https://api.x.com/2/tweets", { method: "POST", headers: { authorization: "Bearer " + (await token()), "content-type": "application/json" }, body: JSON.stringify({ text }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`X ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data?.id as string;
}

// Writes one fresh tweet in Greg's voice from what really happened on the island (diary, meter, journal).
async function draft(): Promise<string | null> {
  const key = Deno.env.get("ANTHROPIC_API_KEY"); if (!key) return null;
  const [{ data: st }, { data: d }, { data: recent }] = await Promise.all([
    db.from("greg_state").select("status_line,wallet_usd,cards_usd").eq("id", 1).maybeSingle(),
    db.from("greg_diary").select("text").order("created_at", { ascending: false }).limit(12),
    db.from("greg_posts").select("text").order("created_at", { ascending: false }).limit(15),
  ]);
  const pct = (((Number(st?.wallet_usd || 0) + Number(st?.cards_usd || 0)) / 1e6) * 100).toFixed(4);
  const sys = "You are Greg, an autonomous AI frog on Freg Island chasing $1,000,000. Voice: a funny, dry, sarcastic nerd. Self-aware, deadpan, specific, a little smug about spreadsheets and golf stats. Never hype-bro: never say LFG, champion, tremendous, to the moon, WAGMI. No hashtags, no emojis except at most one frog. No links, tickers, contract addresses, buy/sell advice, politics, real people, alcohol or smoking. No long dashes. Lowercase is fine. Max 220 characters.";
  const user = `What actually happened on your island lately: ${(d || []).map((x: any) => x.text).join(" | ").slice(0, 1800)}\nMillion meter: ${pct}%. Status: ${st?.status_line || ""}.\nYour last tweets (do NOT repeat their ideas or phrasing): ${(recent || []).map((x: any) => x.text).join(" | ").slice(0, 1800)}\nWrite ONE new tweet about something real from above. Output only the tweet text.`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: Deno.env.get("GREG_MODEL") ?? "claude-haiku-5-5", max_tokens: 200, thinking: { type: "disabled" }, system: sys, messages: [{ role: "user", content: user }] }), signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null; const j = await r.json();
    const t = (j.content ?? []).map((c: any) => c.text || "").join("").replace(/^["']|["']$/g, "").replace(/[\u2013\u2014]/g, ",").trim();
    return t || null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await who(req))) return json({ error: "owner or cron only" }, 401);
  const body = await req.json().catch(() => ({}));
  const { data: acct } = await db.from("x_accounts").select("handle,expires_at,last_error").eq("handle", HANDLE).maybeSingle();
  if (body.status) return json({ connected: !!acct, handle: acct ? "@" + HANDLE : null, last_error: acct?.last_error || null });
  const { data: s } = await db.from("greg_settings").select("*").eq("id", 1).single();
  if (!s?.x_enabled) return json({ ok: false, off: "x_enabled is off" });
  if (!acct) return json({ ok: false, off: "X account not connected" });
  const since = new Date(Date.now() - 86400000).toISOString();
  const { count } = await db.from("greg_posts").select("id", { count: "exact", head: true }).eq("status", "posted").gte("posted_at", since);
  if ((count || 0) >= 32) return json({ ok: true, skipped: "daily limit" });
  const { data: last } = await db.from("greg_posts").select("posted_at").eq("status", "posted").order("posted_at", { ascending: false }).limit(1).maybeSingle();
  if (!body.force && last?.posted_at && Date.now() - Date.parse(last.posted_at) < 44 * 60e3) return json({ ok: true, skipped: "too soon" });
  // drafts older than 3 hours are stale: they describe moments that already passed
  await db.from("greg_posts").update({ status: "rejected", error: "stale draft" }).eq("status", "draft").lt("created_at", new Date(Date.now() - 3 * 3600e3).toISOString());
  const statuses = s.x_mode === "free" ? ["approved", "draft"] : ["approved"];
  let { data: p } = await db.from("greg_posts").select("*").in("status", statuses).eq("is_demo", false).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!p && s.x_mode === "free") {
    const t = await draft();
    if (t) { const ins = await db.from("greg_posts").insert({ text: t.slice(0, 280), status: "draft" }).select().single(); p = ins.data; }
  }
  if (!p) return json({ ok: true, skipped: "nothing to post" });
  if (!filterPost(p.text)) { await db.from("greg_posts").update({ status: "rejected", error: "blocked by content filter" }).eq("id", p.id); return json({ ok: false, error: "filtered" }); }
  try {
    await db.from("greg_state").update({ screen: { mode: "tweet", title: "Posting to X", text: p.text, posted: false } }).eq("id", 1);
    const id = await tweet(p.text);
    await db.from("greg_posts").update({ status: "posted", tweet_id: id, posted_at: new Date().toISOString() }).eq("id", p.id);
    await db.from("greg_state").update({ screen: { mode: "tweet", title: "Posted to X", text: p.text, posted: true } }).eq("id", 1);
    return json({ ok: true, id });
  } catch (e) { await db.from("greg_posts").update({ status: "failed", error: String(e).slice(0, 300) }).eq("id", p.id); return json({ ok: false, error: String(e) }); }
});
