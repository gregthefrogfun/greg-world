// greg-trade: Greg's pump.fun trade executor (curve coins and fresh PumpSwap graduates), via Jupiter.
//
// Security (owner rules):
// - Signs only with Greg's existing wallet. The private key comes from the GREG_WALLET_KEY function secret (base58),
//   which the owner sets. It is read only in loadSigner() below, never logged, returned or stored.
// - Before anything live, the derived public key must equal WALLET (below). Status reports only "key matches: yes/no".
// - Live trades need: greg_wallet.enabled = true AND kill_switch = false AND trade_dry_run = false AND key matches.
//   Those flags are owner-only; this function never changes enabled or kill_switch on its own.
// - Dry run (trade_dry_run = true): quote + simulate only, never signs, rows are logged with paper = true.
// - Caps are enforced here, server side: per trade USD, per day USD, max open positions, SOL reserve, slippage cap.
import { cors, db, json, who } from "./auth.ts";
import { Keypair, Connection, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } from "npm:@solana/web3.js@1.95.3";
import bs58 from "npm:bs58@6.0.0";

const WALLET = "CNAg1pWXsyakdDr2XfVQqDWkdzY9mQpbYBTBxgc1oppf";
const SOL = "So11111111111111111111111111111111111111112";
const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const RPC = Deno.env.get("GREG_SOLANA_RPC") ?? "https://api.mainnet-beta.solana.com";
const JUP = "https://lite-api.jup.ag";
const DATAPI = "https://datapi.jup.ag";
// Programs a swap transaction may touch. Anything else is refused (the owner can extend greg_wallet.allowed_programs).
const SWAP_PROGRAMS = [
  "11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
];
const H = 3600e3;
const conn = () => new Connection(RPC, "confirmed");
const num = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

async function getJSON(url: string, init?: RequestInit, ms = 12000): Promise<any | null> {
  try {
    const r = await fetch(url, { ...init, headers: { accept: "application/json", "user-agent": "GregTheFrog/1.0 (+https://gregthefrog.fun)", ...(init?.headers || {}) }, signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null; return await r.json();
  } catch { return null; }
}

// ---------- key handling (the only place GREG_WALLET_KEY is read) ----------
function loadSigner(): Keypair | null {
  const raw = Deno.env.get("GREG_WALLET_KEY"); if (!raw) return null;
  try {
    const b = bs58.decode(raw.trim());
    const kp = b.length === 64 ? Keypair.fromSecretKey(b) : b.length === 32 ? Keypair.fromSeed(b) : null;
    b.fill(0);
    if (!kp || kp.publicKey.toBase58() !== WALLET) return null;
    return kp;
  } catch { return null; } // never echo the error: it could contain parts of the input
}
function keyStatus() { return { key_present: !!Deno.env.get("GREG_WALLET_KEY"), key_matches: !!loadSigner() }; }

// ---------- market data ----------
let solCache = { t: 0, v: 0 };
async function solUsd(): Promise<number> {
  if (Date.now() - solCache.t < 60e3 && solCache.v) return solCache.v;
  const j = await getJSON(`${JUP}/price/v3?ids=${SOL}`); const v = num(j?.[SOL]?.usdPrice);
  if (v > 0) solCache = { t: Date.now(), v }; return v || solCache.v;
}
async function pool(mint: string): Promise<any | null> {
  const j = await getJSON(`${DATAPI}/v1/pools?assetIds=${mint}`);
  const ps = (j?.pools || []).filter((p: any) => p.baseAsset?.id === mint);
  return ps.find((p: any) => p.dex === "pump.fun") || ps.find((p: any) => /pump/i.test(p.dex || "")) || ps[0] || null;
}
function slim(p: any) {
  const a = p?.baseAsset || {};
  const graduated = !!a.graduatedAt || (p?.dex && p.dex !== "pump.fun");
  return { mint: a.id, name: String(a.name || "").slice(0, 40), symbol: String(a.symbol || "").slice(0, 16), icon: a.icon || null,
    mcap: num(a.mcap, null as any), price: num(a.usdPrice, null as any), holders: num(a.holderCount, null as any),
    curve: graduated ? 100 : num(p?.bondingCurve, null as any), graduated, graduatedAt: a.graduatedAt || null,
    createdAt: a.createdAt || a.firstPool?.createdAt || p?.createdAt || null, dev: a.dev || null, audit: a.audit || {},
    vol1h: num(a.stats1h?.buyVolume) + num(a.stats1h?.sellVolume), chg1h: num(a.stats1h?.priceChange, null as any), dex: p?.dex || null };
}
let feedCache: { t: number; v: any } = { t: 0, v: null };
async function feed() {
  if (feedCache.v && Date.now() - feedCache.t < 8000) return feedCache.v;
  const j = await getJSON(`${DATAPI}/v1/pools/gems`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recent: { launchpads: ["pump.fun"] }, aboutToGraduate: { launchpads: ["pump.fun"] }, graduated: { launchpads: ["pump.fun"] } }) });
  if (!j) return feedCache.v;
  const pick = (k: string) => (j?.[k]?.pools || []).map(slim).filter((x: any) => x.mint).slice(0, 30);
  feedCache = { t: Date.now(), v: { at: new Date().toISOString(), recent: pick("recent"), aboutToGraduate: pick("aboutToGraduate"), graduated: pick("graduated") } };
  return feedCache.v;
}

// ---------- safety screen (owner rules for curve coins) ----------
function curvePDA(mint: string) { return PublicKey.findProgramAddressSync([new TextEncoder().encode("bonding-curve"), new PublicKey(mint).toBytes()], PUMP_PROGRAM)[0].toBase58(); }
async function screen(mint: string, w: any) {
  const fails: string[] = [];
  const p = await pool(mint); if (!p) return { ok: false, fails: ["no pool data"], info: null };
  const s = slim(p);
  if ((p.baseAsset?.launchpad || "") !== "pump.fun") fails.push("not a pump.fun coin");
  if (s.graduated && s.graduatedAt && Date.now() - Date.parse(s.graduatedAt) > 24 * H) fails.push("graduated more than 24h ago");
  if (!(num(s.curve) >= num(w.trade_min_curve_pct, 20))) fails.push(`curve ${num(s.curve).toFixed(0)}% < ${w.trade_min_curve_pct}%`);
  if (!(num(s.holders) >= num(w.trade_min_holders, 50))) fails.push(`${s.holders ?? 0} holders < ${w.trade_min_holders}`);
  if (!s.audit.mintAuthorityDisabled || !s.audit.freezeAuthorityDisabled) fails.push("mint or freeze authority open");
  const rc = await getJSON(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, undefined, 15000);
  if (!rc) { fails.push("rugcheck unavailable"); return { ok: false, fails, info: s }; }
  if (rc.rugged) fails.push("rugcheck: rugged");
  if (rc.mintAuthority || rc.freezeAuthority) fails.push("mint or freeze authority open (rugcheck)");
  // top 10 holders, without the bonding curve, the AMM pool and known program accounts
  const skip = new Set<string>([curvePDA(mint), p.id, ...Object.keys(rc.knownAccounts || {})]);
  const mk = JSON.stringify(rc.markets || []);
  const holders = (rc.topHolders || []).filter((h: any) => !skip.has(h.owner) && !skip.has(h.address) && !mk.includes(h.owner) && !mk.includes(h.address));
  const top10 = holders.slice(0, 10).reduce((a: number, h: any) => a + num(h.pct), 0);
  if (top10 >= num(w.trade_max_top10_pct, 40)) fails.push(`top10 ${top10.toFixed(1)}% >= ${w.trade_max_top10_pct}%`);
  const creator = rc.creator || s.dev;
  const devHold = (rc.topHolders || []).filter((h: any) => h.owner === creator).reduce((a: number, h: any) => a + num(h.pct), 0);
  const supply = num(rc.token?.supply); const devBal = supply > 0 ? (num(rc.creatorBalance) / supply) * 100 : 0;
  const devPct = Math.max(devHold, devBal, num(s.audit.devBalancePercentage));
  if (devPct >= num(w.trade_max_dev_pct, 10)) fails.push(`dev holds ${devPct.toFixed(1)}%`);
  const risks = (rc.risks || []).filter((r: any) => !(!s.graduated && /liquidity|\bLP\b/i.test(r.name || "")));
  const bundle = num(rc.graphInsidersDetected) > 0 || risks.some((r: any) => /bundle|insider|sniper/i.test(r.name || "")) || num(s.audit.sniperPct) >= 20 || num(s.audit.botHoldersPercentage) >= 20;
  if (bundle) fails.push("bundle or insider flag");
  const danger = risks.filter((r: any) => r.level === "danger").map((r: any) => r.name);
  if (danger.length) fails.push("rugcheck danger: " + danger.join(", ").slice(0, 80));
  return { ok: fails.length === 0, fails, info: { ...s, top10: +top10.toFixed(1), devPct: +devPct.toFixed(1), rugScore: rc.score_normalised ?? null } };
}

// ---------- caps ----------
const dayStart = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };
async function spentToday(paper: boolean) {
  const { data } = await db.from("greg_trades").select("amount_usd").eq("side", "buy").eq("paper", paper).gte("created_at", dayStart());
  return (data || []).reduce((a: number, r: any) => a + num(r.amount_usd), 0);
}
async function openPositions(paper?: boolean) {
  let q = db.from("greg_trade_positions").select("*").eq("status", "open"); if (paper !== undefined) q = q.eq("paper", paper);
  const { data } = await q.order("opened_at"); return data || [];
}
function liveAllowed(w: any) {
  if (w.trade_dry_run) return "dry run is on";
  if (!w.enabled) return "trading is off (owner)";
  if (w.kill_switch) return "kill switch is on (owner)";
  if (!loadSigner()) return "wallet key missing or does not match Greg's address";
  return null;
}

// ---------- swap ----------
async function quote(input: string, output: string, amount: bigint | number | string, w: any) {
  const q = await getJSON(`${JUP}/swap/v1/quote?inputMint=${input}&outputMint=${output}&amount=${String(amount)}&slippageBps=${num(w.trade_slippage_bps, 1500)}&restrictIntermediateTokens=true`);
  if (!q?.outAmount) return null;
  return q;
}
async function buildTx(q: any): Promise<VersionedTransaction | null> {
  const j = await getJSON(`${JUP}/swap/v1/swap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteResponse: q, userPublicKey: WALLET, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 300000, priorityLevel: "high" } } }) }, 15000);
  if (!j?.swapTransaction) return null;
  return VersionedTransaction.deserialize(Uint8Array.from(atob(j.swapTransaction), (c) => c.charCodeAt(0)));
}
async function checkTx(tx: VersionedTransaction, w: any): Promise<string | null> {
  const lookups = await Promise.all(tx.message.addressTableLookups.map(async (l) => (await conn().getAddressLookupTable(l.accountKey)).value));
  const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: lookups.filter(Boolean) as any });
  if (keys.get(0)?.toBase58() !== WALLET) return "fee payer is not Greg";
  const ok = new Set([...SWAP_PROGRAMS, ...(w.allowed_programs || [])]);
  for (const ix of tx.message.compiledInstructions) { const p = keys.get(ix.programIdIndex)?.toBase58(); if (!p || !ok.has(p)) return "program not allowed: " + p; }
  return null;
}
async function simulate(tx: VersionedTransaction) {
  try {
    const before = await conn().getBalance(new PublicKey(WALLET));
    const s = await conn().simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: [WALLET] } });
    const after = s.value.accounts?.[0]?.lamports ?? before;
    return { ok: !s.value.err, err: s.value.err ? JSON.stringify(s.value.err).slice(0, 120) : null, spentLamports: before - after, logs: (s.value.logs || []).slice(-3) };
  } catch (e) { return { ok: false, err: String(e).slice(0, 120), spentLamports: 0 }; }
}
async function sendSigned(tx: VersionedTransaction): Promise<{ sig?: string; error?: string }> {
  const signer = loadSigner(); if (!signer) return { error: "signer unavailable" };
  const c = conn();
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = blockhash; // the swap tx came with a fresh hash, refresh anyway before signing
  tx.sign([signer]);
  const sig = await c.sendRawTransaction(tx.serialize(), { maxRetries: 3, skipPreflight: false });
  const r = await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed").catch((e) => ({ value: { err: String(e) } }));
  if ((r as any).value?.err) return { sig, error: "not confirmed: " + JSON.stringify((r as any).value.err).slice(0, 100) };
  return { sig };
}
async function tokenBalance(mint: string): Promise<bigint> {
  const r = await conn().getParsedTokenAccountsByOwner(new PublicKey(WALLET), { mint: new PublicKey(mint) }).catch(() => null);
  return (r?.value || []).reduce((a, x: any) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
}
const log = (kind: string, note: string, amount_sol?: number, tx_sig?: string) => db.from("greg_chain_log").insert({ kind, note: note.slice(0, 300), amount_sol, tx_sig });

// ---------- buy ----------
async function buy(w: any, mint: string, reason: string) {
  const live = !liveAllowed(w); const paper = !live;
  const open = await openPositions(paper);
  if (open.length >= num(w.trade_max_open, 3)) return { ok: false, error: `max ${w.trade_max_open} open positions` };
  if (open.some((p: any) => p.mint === mint)) return { ok: false, error: "already holding this coin" };
  const usd = num(w.trade_usd, 5);
  if ((await spentToday(paper)) + usd > num(w.trade_daily_usd, 25) + 1e-9) return { ok: false, error: `daily cap $${w.trade_daily_usd} reached` };
  const sc = await screen(mint, w); if (!sc.ok) return { ok: false, error: "safety: " + sc.fails.join("; "), info: sc.info };
  const sp = await solUsd(); if (!(sp > 0)) return { ok: false, error: "no SOL price" };
  const lamports = BigInt(Math.floor((usd / sp) * LAMPORTS_PER_SOL));
  if (live) {
    const bal = await conn().getBalance(new PublicKey(WALLET));
    const need = Number(lamports) + num(w.trade_reserve_sol, 0.02) * LAMPORTS_PER_SOL + 0.006 * LAMPORTS_PER_SOL; // + fees and token account rent
    if (bal < need) return { ok: false, error: `wallet has ${(bal / 1e9).toFixed(4)} SOL, needs ${(need / 1e9).toFixed(4)} (keeps ${w.trade_reserve_sol} SOL for fees)` };
  }
  const q = await quote(SOL, mint, lamports, w); if (!q) return { ok: false, error: "no quote" };
  if (num(q.priceImpactPct) * 100 > num(w.trade_slippage_bps, 1500) / 100) return { ok: false, error: `price impact ${(num(q.priceImpactPct) * 100).toFixed(1)}% too high` };
  const tx = await buildTx(q); if (!tx) return { ok: false, error: "could not build swap" };
  const bad = await checkTx(tx, w); if (bad) { await log("blocked", `buy ${sc.info?.symbol}: ${bad}`); return { ok: false, error: bad }; }
  const sim = await simulate(tx);
  let tokens = BigInt(q.outAmount), sig: string | null = null, note = paper ? `dry run: ${liveAllowed(w)}; simulation ${sim.ok ? "ok" : "failed " + sim.err}` : null;
  if (live) {
    if (!sim.ok) return { ok: false, error: "simulation failed: " + sim.err };
    if (sim.spentLamports > Number(lamports) * 1.03 + 0.012 * LAMPORTS_PER_SOL) return { ok: false, error: "simulated spend above the cap" };
    const r = await sendSigned(tx);
    if (r.error) { await log("trade_failed", `buy ${sc.info?.symbol}: ${r.error}`, Number(lamports) / 1e9, r.sig); return { ok: false, error: r.error, sig: r.sig }; }
    sig = r.sig!; const got = await tokenBalance(mint); if (got > 0n) tokens = got;
  }
  const decimals = 6; // pump.fun coins use 6 decimals
  const price = usd / (Number(tokens) / 10 ** decimals);
  const { data: pos } = await db.from("greg_trade_positions").insert({ mint, symbol: sc.info?.symbol, name: sc.info?.name, icon: sc.info?.icon, paper, tokens_raw: tokens.toString(), decimals, cost_usd: usd, cost_sol: Number(lamports) / 1e9, entry_price_usd: price, last_price_usd: price, last_value_usd: usd, curve_pct: sc.info?.curve, opened_on_curve: !sc.info?.graduated, reason: reason.slice(0, 200) }).select().single();
  await db.from("greg_trades").insert({ side: "buy", venue: sc.info?.graduated ? "pumpswap via jupiter" : "pump.fun curve via jupiter", mint, symbol: sc.info?.symbol, name: sc.info?.name, icon: sc.info?.icon, amount_usd: usd, amount_sol: Number(lamports) / 1e9, price_usd: price, signature: sig, reason: reason.slice(0, 200), paper, position_id: pos?.id, tokens_raw: tokens.toString(), mcap_usd: sc.info?.mcap, curve_pct: sc.info?.curve, sim_ok: sim.ok, note });
  if (sig) await log("trade", `bought $${usd} of ${sc.info?.symbol}`, Number(lamports) / 1e9, sig);
  return { ok: true, paper, sig, position: pos?.id, symbol: sc.info?.symbol, usd, sim_ok: sim.ok, sim_err: sim.err };
}

// ---------- exits ----------
async function sell(w: any, p: any, fraction: number, why: string) {
  const paper = !!p.paper;
  if (!paper) { const no = liveAllowed(w); if (no) return { ok: false, error: "live sell blocked: " + no }; }
  let amount = BigInt(p.tokens_raw);
  if (!paper) { const bal = await tokenBalance(p.mint); amount = bal < amount ? bal : amount; }
  const part = fraction >= 1 ? amount : amount / 2n; if (part <= 0n) return { ok: false, error: "nothing to sell" };
  const q = await quote(p.mint, SOL, part, w); if (!q) return { ok: false, error: "no sell quote" };
  const tx = paper ? null : await buildTx(q); const sim = tx ? await simulate(tx) : { ok: paper ? null : false, err: paper ? null : "no tx", spentLamports: 0 };
  let sig: string | null = null;
  if (!paper) {
    if (!tx) return { ok: false, error: "could not build sell" };
    const bad = await checkTx(tx, w); if (bad) return { ok: false, error: bad };
    const r = await sendSigned(tx); if (r.error) { await log("trade_failed", `sell ${p.symbol}: ${r.error}`, undefined, r.sig); return { ok: false, error: r.error }; }
    sig = r.sig!;
  }
  const sp = await solUsd(); const outUsd = (Number(q.outAmount) / 1e9) * sp;
  const share = Number(part) / Number(BigInt(p.tokens_raw) || 1n);
  const costPart = num(p.cost_usd) * share, pnl = outUsd - costPart;
  const left = BigInt(p.tokens_raw) - part, closed = fraction >= 1 || left <= 0n;
  await db.from("greg_trade_positions").update({ tokens_raw: closed ? "0" : left.toString(), cost_usd: num(p.cost_usd) - costPart, realized_usd: num(p.realized_usd) + pnl, took_profit: p.took_profit || why === "take profit", status: closed ? "closed" : "open", closed_at: closed ? new Date().toISOString() : null, close_reason: closed ? why : null }).eq("id", p.id);
  await db.from("greg_trades").insert({ side: "sell", venue: "jupiter", mint: p.mint, symbol: p.symbol, name: p.name, icon: p.icon, amount_usd: outUsd, amount_sol: Number(q.outAmount) / 1e9, price_usd: outUsd / (Number(part) / 10 ** num(p.decimals, 6)), pnl_usd: pnl, signature: sig, reason: why, paper, position_id: p.id, tokens_raw: part.toString(), sim_ok: sim.ok, note: paper ? "dry run" : null });
  if (sig) await log("trade", `sold ${fraction >= 1 ? "all" : "half"} of ${p.symbol} (${why})`, Number(q.outAmount) / 1e9, sig);
  return { ok: true, paper, sig, symbol: p.symbol, why, pnl_usd: +pnl.toFixed(2), closed };
}
async function exits(w: any) {
  const out: any[] = []; const sp = await solUsd();
  for (const p of await openPositions()) {
    const tokens = BigInt(p.tokens_raw); if (tokens <= 0n) continue;
    const q = await quote(p.mint, SOL, tokens, w);
    const value = q ? (Number(q.outAmount) / 1e9) * sp : null;
    const pl = await pool(p.mint); const s = pl ? slim(pl) : null;
    const price = value != null ? value / (Number(tokens) / 10 ** num(p.decimals, 6)) : num(s?.price, null as any);
    await db.from("greg_trade_positions").update({ last_price_usd: price, last_value_usd: value, last_checked_at: new Date().toISOString(), curve_pct: s?.curve ?? p.curve_pct }).eq("id", p.id);
    if (value == null) { out.push({ id: p.id, symbol: p.symbol, note: "no quote, holding" }); continue; }
    const pnlPct = ((value - num(p.cost_usd)) / Math.max(1e-9, num(p.cost_usd))) * 100;
    const ageH = (Date.now() - Date.parse(p.opened_at)) / H;
    let act: [number, string] | null = null;
    if (pnlPct <= -num(w.trade_sl_pct, 40)) act = [1, "stop loss"];
    else if (p.opened_on_curve && s?.graduated && pnlPct > 0) act = [1, "graduated while up"];
    else if (!p.took_profit && pnlPct >= num(w.trade_tp_pct, 100)) act = [0.5, "take profit"];
    else if (ageH >= num(w.trade_time_stop_h, 24)) act = [1, "time stop"];
    out.push({ id: p.id, symbol: p.symbol, paper: p.paper, pnlPct: +pnlPct.toFixed(1), action: act?.[1] || "hold", ...(act ? { result: await sell(w, p, act[0], act[1]) } : {}) });
  }
  return out;
}

// ---------- scan: candidates for the brain ----------
async function scan(w: any) {
  const f = await feed(); if (!f) return [];
  const held = new Set((await openPositions()).map((p: any) => p.mint));
  const pre = [...(f.aboutToGraduate || []), ...(f.graduated || []).filter((x: any) => x.graduatedAt && Date.now() - Date.parse(x.graduatedAt) < 24 * H)]
    .filter((x: any) => !held.has(x.mint) && num(x.curve) >= num(w.trade_min_curve_pct, 20) && num(x.holders) >= num(w.trade_min_holders, 50) && x.audit?.mintAuthorityDisabled && x.audit?.freezeAuthorityDisabled && !(num(x.audit?.devBalancePercentage) >= num(w.trade_max_dev_pct, 10)))
    .sort((a: any, b: any) => num(b.vol1h) - num(a.vol1h)).slice(0, 6);
  const out: any[] = [];
  for (const c of pre) { const s = await screen(c.mint, w); out.push({ ...(s.info || c), ok: s.ok, fails: s.fails }); if (out.filter((x) => x.ok).length >= 3) break; }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  // public, read-only market data for the monitors (no wallet access)
  if (b.op === "feed") return json(await feed() || { error: "feed unavailable" });
  if (b.op === "chart") {
    const mint = String(b.mint || ""); if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json({ error: "bad mint" }, 400);
    const iv = ["1_MINUTE", "5_MINUTE", "15_MINUTE", "1_HOUR"].includes(b.interval) ? b.interval : "1_MINUTE";
    const j = await getJSON(`${DATAPI}/v2/charts/${mint}?interval=${iv}&to=${Date.now()}&candles=${Math.min(200, num(b.candles, 90))}&type=price&quote=usd`);
    return json(j || { candles: [] });
  }
  if (b.op === "pool") { const p = await pool(String(b.mint || "")); return json(p ? slim(p) : { error: "no pool" }); }

  const caller = await who(req); if (!caller) return json({ error: "owner or brain only" }, 401);
  const { data: w } = await db.from("greg_wallet").select("*").eq("id", 1).single();
  if (!w) return json({ error: "no wallet row" }, 500);

  if (b.op === "status") {
    const [lv, pp] = [await openPositions(false), await openPositions(true)];
    const bal = await conn().getBalance(new PublicKey(WALLET)).catch(() => null);
    return json({ address: WALLET, ...keyStatus(), balance_sol: bal != null ? bal / 1e9 : null, enabled: w.enabled, kill_switch: w.kill_switch, dry_run: w.trade_dry_run, live_blocked_by: liveAllowed(w), spent_today_usd: await spentToday(false), paper_spent_today_usd: await spentToday(true), open_live: lv.length, open_paper: pp.length,
      caps: { trade_usd: w.trade_usd, trade_daily_usd: w.trade_daily_usd, trade_max_open: w.trade_max_open, trade_slippage_bps: w.trade_slippage_bps, trade_reserve_sol: w.trade_reserve_sol, trade_min_curve_pct: w.trade_min_curve_pct, trade_min_holders: w.trade_min_holders, trade_max_dev_pct: w.trade_max_dev_pct, trade_max_top10_pct: w.trade_max_top10_pct, trade_tp_pct: w.trade_tp_pct, trade_sl_pct: w.trade_sl_pct, trade_time_stop_h: w.trade_time_stop_h, trade_scan_every_min: w.trade_scan_every_min } });
  }
  if (b.op === "settings") { // owner only: caps, dry run, trading on/off, kill switch
    if (caller !== "owner") return json({ error: "owner only" }, 401);
    const allowed = ["trade_usd", "trade_daily_usd", "trade_max_open", "trade_slippage_bps", "trade_reserve_sol", "trade_min_curve_pct", "trade_min_holders", "trade_max_dev_pct", "trade_max_top10_pct", "trade_tp_pct", "trade_sl_pct", "trade_time_stop_h", "trade_scan_every_min", "trade_dry_run", "enabled", "kill_switch"];
    const patch: any = {}; for (const k of allowed) if (k in b) patch[k] = typeof w[k] === "boolean" ? !!b[k] : Number(b[k]);
    // hard ceilings so a typo cannot blow up the wallet
    if (patch.trade_usd > 50 || patch.trade_daily_usd > 250 || patch.trade_max_open > 10 || patch.trade_slippage_bps > 3000) return json({ error: "above hard ceiling ($50/trade, $250/day, 10 open, 30% slippage)" }, 400);
    await db.from("greg_wallet").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1);
    await log("settings", "owner changed trading settings: " + Object.keys(patch).join(", "));
    return json({ ok: true });
  }
  if (b.op === "tick") { // brain: evaluate exits every tick, scan for candidates when due
    const ex = await exits(w);
    const { data: ts } = await db.from("greg_trade_state").select("*").eq("id", 1).single();
    let candidates = null;
    if (b.scan || !ts?.last_scan_at || Date.now() - Date.parse(ts.last_scan_at) > num(w.trade_scan_every_min, 60) * 60e3) candidates = await scan(w);
    const watching = candidates?.find((c: any) => c.ok) || ts?.watching || null;
    await db.from("greg_trade_state").update({ last_tick_at: new Date().toISOString(), ...(candidates ? { candidates, last_scan_at: new Date().toISOString(), watching } : {}), last_result: { exits: ex }, updated_at: new Date().toISOString() }).eq("id", 1);
    return json({ ok: true, mode: liveAllowed(w) ? "paper" : "live", live_blocked_by: liveAllowed(w), exits: ex, candidates });
  }
  if (b.op === "buy") { // brain proposes; the executor validates everything again
    if (caller !== "cron" && caller !== "owner") return json({ error: "no" }, 401);
    const mint = String(b.mint || ""); if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json({ error: "bad mint" }, 400);
    const r = await buy(w, mint, String(b.reason || "").slice(0, 200));
    await db.from("greg_trade_state").update({ last_result: { buy: r }, updated_at: new Date().toISOString() }).eq("id", 1);
    return json(r);
  }
  return json({ error: "unknown op" }, 400);
});
