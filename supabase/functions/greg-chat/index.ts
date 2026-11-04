// greg-chat: the only way a chat message gets stored. Filters, rate limits and owner moderation live here.
// POST { op: "send", fly, name, hue, text, room }  -> stores it (last 100 are what newcomers see) and returns it
// POST { op: "report", id }                          -> counts a report; 3 reports hide the message
// POST { op: "delete", id } / { op: "ban", fly }     -> owner only
import { db, json, cors, who } from "./auth.ts";

const SLURS = /(n[i1]gg|f[a@]gg?[o0]t|retard|tr[a@]nny|k[i1]ke|sp[i1]c\b|ch[i1]nk|c[u\*]nt|wh[o0]re|sl[u\*]t|r[a@]pe|n[a@]z[i1]|h[i1]tler|kys|kill yourself)/i;
const PROFANITY = /\b(fuck\w*|shit\w*|bitch\w*|dick|cock|pussy|asshole|bastard|motherf\w*)\b/gi;
const LINKS = /(https?:|www\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|fun|gg|ru|cn|ly|me|app|dev|co)\b|discord\.gg|t\.me\/)/i;
const KEYLIKE = /[1-9A-HJ-NP-Za-km-z]{32,}|0x[0-9a-fA-F]{20,}|\b([a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/;
const CONTACT = /[\w.+-]+@[\w-]+\.[\w.]+|(\+?\d[\d\s().-]{7,}\d)/;
const filter = (t: string) => (SLURS.test(t) ? "slur" : LINKS.test(t) ? "link" : KEYLIKE.test(t) ? "key or wallet" : CONTACT.test(t) ? "contact info" : null);
const clean = (t: string) => t.replace(PROFANITY, (w) => w[0] + "*".repeat(Math.max(1, w.length - 1)));
const last = new Map<string, number[]>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  let b: any; try { b = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
  const op = String(b.op || "send");
  if (op === "delete" || op === "ban") {
    if ((await who(req)) !== "owner") return json({ ok: false, error: "owner only" }, 401);
    if (op === "delete") { await db.from("greg_chat").update({ hidden: true }).eq("id", Number(b.id)); return json({ ok: true }); }
    await db.from("greg_chat_bans").upsert({ fly_id: String(b.fly).slice(0, 40), reason: String(b.reason || "").slice(0, 120) });
    await db.from("greg_chat").update({ hidden: true }).eq("fly_id", String(b.fly).slice(0, 40)); return json({ ok: true });
  }
  if (op === "report") {
    const { data } = await db.from("greg_chat").select("reports").eq("id", Number(b.id)).maybeSingle(); if (!data) return json({ ok: false }, 404);
    const r = (data.reports || 0) + 1; await db.from("greg_chat").update({ reports: r, hidden: r >= 3 }).eq("id", Number(b.id)); return json({ ok: true });
  }
  const fly = String(b.fly || "").slice(0, 40), name = String(b.name || "Fly").replace(/[^A-Za-z0-9 ]/g, "").slice(0, 16) || "Fly";
  let text = String(b.text || "").replace(/[\u0000-\u001f]/g, " ").replace(/[–—]/g, "-").trim();
  if (!fly || !text) return json({ ok: false, error: "empty" }, 400);
  if (text.length > 200) return json({ ok: false, error: "max 200 characters" }, 400);
  if (/^\s*(greg|bit)\s*$/i.test(name)) return json({ ok: false, error: "that name belongs to someone on the island" }, 400);
  // rate limit: 1 message per 2 s per fly, and a 30 s slowmode after 6 messages in 30 s
  const now = Date.now(), ip = req.headers.get("x-forwarded-for")?.split(",")[0] || "ip";
  for (const k of [fly, ip]) { const h = (last.get(k) || []).filter((t) => now - t < 30000); if (h.length && now - h[h.length - 1] < 2000) return json({ ok: false, error: "slow down a little (2 s)" }, 429); if (h.length >= 6) return json({ ok: false, error: "slowmode: wait 30 s" }, 429); h.push(now); last.set(k, h); }
  const { data: ban } = await db.from("greg_chat_bans").select("fly_id").eq("fly_id", fly).maybeSingle(); if (ban) return json({ ok: false, error: "you can't chat right now" }, 403);
  const bad = filter(text); if (bad) return json({ ok: false, error: "blocked: no " + bad + " in chat" }, 400);
  text = clean(text);
  const { data, error } = await db.from("greg_chat").insert({ fly_id: fly, name, hue: Math.max(0, Math.min(359, Number(b.hue) || 0)), text, room: Math.max(1, Math.min(999, Number(b.room) || 1)) }).select("id,created_at,fly_id,name,hue,text,from_greg").single();
  if (error) return json({ ok: false, error: "could not save" }, 500);
  // keep the table small: only the newest 500 rows are kept (newcomers load the last 100)
  if (data.id % 50 === 0) await db.from("greg_chat").delete().lt("id", data.id - 500);
  return json({ ok: true, msg: data });
});
