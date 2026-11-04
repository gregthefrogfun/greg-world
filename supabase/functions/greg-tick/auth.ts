// Shared helpers for Greg's edge functions (copied into each function on deploy).
import { createClient } from "jsr:@supabase/supabase-js@2";

export const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-greg-key, x-greg-cron, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
export const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });

export async function sha256(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function who(req: Request): Promise<"owner" | "cron" | null> {
  const key = req.headers.get("x-greg-key"), cron = req.headers.get("x-greg-cron");
  if (key || cron) {
    const { data } = await db.from("greg_secrets").select("name,value").in("name", ["admin_key_sha256", "cron_secret"]);
    const m = Object.fromEntries((data ?? []).map((r: any) => [r.name, r.value]));
    if (key && m.admin_key_sha256 && (await sha256(key)) === m.admin_key_sha256) return "owner";
    if (cron && m.cron_secret && cron === m.cron_secret) return "cron";
  }
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (bearer && bearer.split(".").length === 3) {
    const { data } = await db.auth.getUser(bearer);
    const email = data?.user?.email?.toLowerCase();
    if (email) { const { data: o } = await db.from("greg_owners").select("email").eq("email", email).maybeSingle(); if (o) return "owner"; }
  }
  return null;
}

export const ALLOWED_HOSTS = [
  "gamma-api.polymarket.com", "clob.polymarket.com", "api.elections.kalshi.com", "api.manifold.markets",
  "api-mainnet.magiceden.dev", "api-mainnet.magiceden.io", "api.mainnet.tensordev.io", "api.collectorcrypt.com", "collectorcrypt.com",
  "api.coingecko.com", "en.wikipedia.org", "api.pokemontcg.io", "www.gutenberg.org", "gutenberg.org", "api.dexscreener.com",
  "collectionapi.metmuseum.org",
];
export async function browse(url: string, max = 1_000_000, extraHeaders: Record<string, string> = {}): Promise<{ ok: boolean; status?: number; data?: any; text?: string; error?: string }> {
  let u: URL; try { u = new URL(url); } catch { return { ok: false, error: "bad url" }; }
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.includes(u.hostname)) return { ok: false, error: "host not allowed: " + u.hostname };
  try {
    const r = await fetch(u, { headers: { "user-agent": "GregTheFrog/1.0 (+https://gregthefrog.fun)", accept: "application/json,text/plain,*/*", ...extraHeaders }, signal: AbortSignal.timeout(15000), redirect: "follow" });
    const t = (await r.text()).slice(0, max);
    let data: any = undefined; try { data = JSON.parse(t); } catch { /* not json */ }
    return { ok: r.ok, status: r.status, data, text: data ? undefined : t.slice(0, Math.max(4000, max)) };
  } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
}
