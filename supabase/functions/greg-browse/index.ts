// greg-browse: Greg's read-only web tool. Owner or cron only. GET on allowlisted public APIs.
import { browse, cors, json, who, ALLOWED_HOSTS } from "./auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const caller = await who(req);
  if (!caller) return json({ error: "owner only" }, 401);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(new URL(req.url).searchParams);
  if (body.probe) {
    const probes: Record<string, string> = {
      polymarket: "https://gamma-api.polymarket.com/markets?limit=2&active=true&closed=false&order=volume24hr&ascending=false",
      kalshi: "https://api.elections.kalshi.com/trade-api/v2/markets?limit=2&status=open",
      manifold: "https://api.manifold.markets/v0/search-markets?term=golf&limit=2",
      magiceden: "https://api-mainnet.magiceden.dev/v2/collections/collector_crypt/stats",
      collectorcrypt: "https://api.collectorcrypt.com/",
      coingecko: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      wikipedia: "https://en.wikipedia.org/w/api.php?action=opensearch&search=golf%20bag&limit=2&format=json",
      pokemontcg: "https://api.pokemontcg.io/v2/cards?q=name:charizard&pageSize=1",
    };
    const out: Record<string, unknown> = {};
    await Promise.all(Object.entries(probes).map(async ([k, u]) => { const r = await browse(u, 3000); out[k] = { ok: r.ok, status: r.status, error: r.error, sample: JSON.stringify(r.data ?? r.text ?? "").slice(0, 300) }; }));
    return json({ hosts: ALLOWED_HOSTS, probes: out });
  }
  if (!body.url) return json({ hosts: ALLOWED_HOSTS });
  return json(await browse(String(body.url)));
});
