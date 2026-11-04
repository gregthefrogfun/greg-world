// greg-github: Greg uploads his own files (Codex laws, journal exports, art, notes) to GitHub.
// Hard limits, enforced here and nowhere else:
// - CREATE only, under greg-files/ in gregthefrogfun/greg-world (or gregthefrogfun/greg). Never update or delete:
//   the path is checked first and the request is refused if anything already exists there.
// - At most 3 files a day, each under 200 KB, text / markdown / json / png / jpg / webp only.
// - Text goes through the same content filter as Greg's posts.
// - Only the owner or the cron may call it. Token: Supabase secret GREG_GITHUB_TOKEN (fine-grained,
//   contents read/write on those repos only). The token is never logged or returned.
import { db, json, cors, who } from "./auth.ts";

const REPOS = new Set(["gregthefrogfun/greg-world", "gregthefrogfun/greg"]);
const MAX_BYTES = 200 * 1024, PER_DAY = 3;
const EXT = /\.(md|txt|json|png|jpe?g|webp)$/i, TEXT = /\.(md|txt|json)$/i;
const BLOCK = /(https?:\/\/(?!gregthefrog\.fun)|www\.|financial advice|guarantee|\$[A-Z]{2,}|contract address|seed phrase|private key|presiden|elect|senat|congress|politic|democrat|republican|trump|biden|musk|airdrop|giveaway|dm me|suicid|kill myself)/i;
const B58_LONG = /[1-9A-HJ-NP-Za-km-z]{40,}/;
const okPath = (p: string) => /^greg-files\/[a-z0-9][a-z0-9._\/-]{0,150}$/i.test(p) && !p.includes("..") && !p.includes("//") && EXT.test(p);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const caller = await who(req);
  if (caller !== "owner" && caller !== "cron") return json({ ok: false, error: "not allowed" }, 401);
  const token = Deno.env.get("GREG_GITHUB_TOKEN");
  if (!token) return json({ ok: false, error: "not configured: add the GREG_GITHUB_TOKEN secret" }, 200);
  let b: any; try { b = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
  const repo = String(b.repo || "gregthefrogfun/greg-world"), path = String(b.path || ""), message = String(b.message || "Greg uploads a file").slice(0, 120);
  if (!REPOS.has(repo)) return json({ ok: false, error: "repo not allowed" }, 400);
  if (!okPath(path)) return json({ ok: false, error: "path must be greg-files/<name>.(md|txt|json|png|jpg|webp)" }, 400);
  // content: text as utf-8 string, images as base64
  let b64: string, bytes: number;
  if (TEXT.test(path)) {
    const text = String(b.content ?? ""); if (!text.trim()) return json({ ok: false, error: "empty" }, 400);
    if (BLOCK.test(text) || B58_LONG.test(text) || /[\u2013\u2014]/.test(text) || BLOCK.test(message)) return json({ ok: false, error: "blocked by content filter" }, 400);
    const enc = new TextEncoder().encode(text); bytes = enc.length; let bin = ""; for (const c of enc) bin += String.fromCharCode(c); b64 = btoa(bin);
  } else {
    b64 = String(b.base64 || "").replace(/^data:[^,]+,/, ""); bytes = Math.floor((b64.length * 3) / 4);
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return json({ ok: false, error: "bad base64" }, 400);
  }
  if (bytes > MAX_BYTES) return json({ ok: false, error: "file over 200 KB" }, 400);
  // daily cap (UTC day), counted from the upload log
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const { count, error: cErr } = await db.from("greg_uploads").select("id", { count: "exact", head: true }).gte("created_at", since.toISOString()).eq("ok", true);
  if (cErr) return json({ ok: false, error: "upload log table missing" }, 500);
  if ((count ?? 0) >= PER_DAY) return json({ ok: false, error: "daily limit reached (3)" }, 429);
  const gh = (url: string, init: RequestInit = {}) => fetch("https://api.github.com/repos/" + repo + "/contents/" + encodeURI(path) + url, { ...init, headers: { authorization: "Bearer " + token, accept: "application/vnd.github+json", "user-agent": "gregthefrog.fun", "x-github-api-version": "2022-11-28", ...(init.headers || {}) } });
  // never overwrite: anything at that path means refuse
  const head = await gh("");
  if (head.status !== 404) { await head.body?.cancel(); return json({ ok: false, error: head.ok ? "file already exists, Greg only creates new files" : "could not check path (" + head.status + ")" }, 409); }
  await head.body?.cancel();
  // PUT without a sha can only create; GitHub rejects it if the file appeared meanwhile
  const put = await gh("", { method: "PUT", body: JSON.stringify({ message: message + "\n\nUploaded by Greg (greg-github function)", content: b64, committer: { name: "Greg the Frog", email: "greg@gregthefrog.fun" } }) });
  const r = await put.json().catch(() => ({}));
  const ok = put.status === 201;
  await db.from("greg_uploads").insert({ repo, path, bytes, ok, url: ok ? r?.content?.html_url ?? null : null, error: ok ? null : String(r?.message || put.status).slice(0, 200) });
  return json(ok ? { ok: true, url: r?.content?.html_url, path } : { ok: false, error: "github refused: " + (r?.message || put.status) }, ok ? 200 : 502);
});
