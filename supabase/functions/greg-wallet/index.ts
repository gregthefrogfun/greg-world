// greg-wallet: PHASE 2, built but OFF. Greg's own Solana wallet with hard server-side limits.
// - The keypair is generated here, encrypted with GREG_WALLET_KEK (a function secret the OWNER sets),
//   and stored encrypted. The private key is never logged, returned or shown. Only the address is public.
// - Spending needs: wallet.enabled = true AND kill_switch = false (both owner-only), allowlisted marketplace
//   and programs, per-purchase cap, per-day cap; anything above approval_threshold_sol waits for the owner.
// - Every action is written to greg_chain_log (public).
import { cors, db, json, who } from "./auth.ts";
import { Keypair, Connection, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } from "npm:@solana/web3.js@1.95.3";

const RPC = Deno.env.get("GREG_SOLANA_RPC") ?? "https://api.mainnet-beta.solana.com";
// Programs any transaction may also touch (fees, compute budget, token accounts).
const BASE_PROGRAMS = ["11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"];

async function kek(): Promise<CryptoKey | null> {
  const k = Deno.env.get("GREG_WALLET_KEK"); if (!k || k.length < 32) return null;
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(k));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function loadSigner(): Promise<Keypair | null> {
  const key = await kek(); if (!key) return null;
  const { data } = await db.from("greg_secrets").select("value").eq("name", "wallet_sk_enc").maybeSingle(); if (!data) return null;
  const [iv, ct] = data.value.split(".").map(unb64);
  const sk = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
  return Keypair.fromSecretKey(sk);
}
const log = (kind: string, note: string, amount_sol?: number, tx_sig?: string) => db.from("greg_chain_log").insert({ kind, note, amount_sol, tx_sig });

async function spentToday(): Promise<number> {
  const since = new Date(Date.now() - 86400000).toISOString();
  const { data } = await db.from("greg_wallet_requests").select("amount_sol").in("status", ["executed", "approved"]).gte("created_at", since);
  return (data || []).reduce((s: number, r: any) => s + Number(r.amount_sol), 0);
}

async function guard(w: any, r: { marketplace?: string; program_id?: string; amount_sol: number }) {
  if (!w?.address) return "no wallet";
  if (!w.enabled) return "wallet spending is disabled by the owner";
  if (w.kill_switch) return "kill switch is on";
  if (!(r.amount_sol > 0)) return "bad amount";
  if (r.amount_sol > Number(w.per_tx_cap_sol)) return `over per-purchase cap (${w.per_tx_cap_sol} SOL)`;
  if ((await spentToday()) + r.amount_sol > Number(w.daily_cap_sol)) return `over daily cap (${w.daily_cap_sol} SOL)`;
  if (!r.marketplace || !(w.allowed_marketplaces || []).includes(r.marketplace)) return "marketplace not allowlisted";
  if (r.program_id && !(w.allowed_programs || []).includes(r.program_id)) return "program not allowlisted";
  return null;
}

async function execute(reqRow: any, w: any) {
  const why = await guard(w, reqRow);
  if (why) { await db.from("greg_wallet_requests").update({ status: "blocked", reason: why }).eq("id", reqRow.id); await log("blocked", `${reqRow.description}: ${why}`, reqRow.amount_sol); return { ok: false, error: why }; }
  const signer = await loadSigner(); if (!signer) return { ok: false, error: "signer unavailable" };
  // The marketplace API must hand us an unsigned transaction; we check every program it touches.
  const txb64 = reqRow.payload?.tx; if (!txb64) return { ok: false, error: "no transaction in payload" };
  const tx = VersionedTransaction.deserialize(unb64(txb64));
  const keys = tx.message.getAccountKeys({ accountKeysFromLookups: undefined as any });
  if (!keys.get(0)?.equals(new PublicKey(w.address))) return { ok: false, error: "fee payer is not Greg" };
  const allowed = new Set([...BASE_PROGRAMS, ...(w.allowed_programs || [])]);
  for (const ix of tx.message.compiledInstructions) { const p = keys.get(ix.programIdIndex)?.toBase58(); if (!p || !allowed.has(p)) { await db.from("greg_wallet_requests").update({ status: "blocked", reason: "program not allowlisted: " + p }).eq("id", reqRow.id); return { ok: false, error: "program not allowlisted" }; } }
  const conn = new Connection(RPC, "confirmed");
  const before = await conn.getBalance(new PublicKey(w.address));
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, accounts: { encoding: "base64", addresses: [w.address] } });
  if (sim.value.err) { await db.from("greg_wallet_requests").update({ status: "failed", reason: "simulation failed" }).eq("id", reqRow.id); return { ok: false, error: "simulation failed" }; }
  const after = sim.value.accounts?.[0]?.lamports ?? before;
  const spend = (before - after) / LAMPORTS_PER_SOL;
  if (spend > Number(reqRow.amount_sol) * 1.02 + 0.003) { await db.from("greg_wallet_requests").update({ status: "blocked", reason: `simulated spend ${spend} SOL is above the request` }).eq("id", reqRow.id); return { ok: false, error: "spend above request" }; }
  tx.sign([signer]);
  const sig = await conn.sendTransaction(tx, { maxRetries: 3 });
  await db.from("greg_wallet_requests").update({ status: "executed", tx_sig: sig, decided_at: new Date().toISOString() }).eq("id", reqRow.id);
  await log(reqRow.kind, reqRow.description, reqRow.amount_sol, sig);
  return { ok: true, sig };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  const { data: w } = await db.from("greg_wallet").select("*").eq("id", 1).single();

  if (b.op === "balance") { // public: refresh the balance of the public address
    if (!w?.address) return json({ address: null });
    const bal = await new Connection(RPC).getBalance(new PublicKey(w.address)).catch(() => null);
    if (bal != null) await db.from("greg_wallet").update({ balance_sol: bal / LAMPORTS_PER_SOL, balance_at: new Date().toISOString() }).eq("id", 1);
    return json({ address: w.address, balance_sol: bal != null ? bal / LAMPORTS_PER_SOL : null });
  }

  const caller = await who(req);
  if (!caller) return json({ error: "owner or brain only" }, 401);

  if (b.op === "create") {
    if (caller !== "owner") return json({ error: "owner only" }, 401);
    if (w?.address) return json({ address: w.address, note: "wallet already exists" });
    const key = await kek(); if (!key) return json({ error: "Set the GREG_WALLET_KEK function secret first (32+ random characters). Only you should know it." }, 400);
    const kp = Keypair.generate();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, kp.secretKey));
    kp.secretKey.fill(0);
    await db.from("greg_secrets").insert({ name: "wallet_sk_enc", value: b64(iv) + "." + b64(ct) });
    const address = kp.publicKey.toBase58();
    await db.from("greg_wallet").update({ address, enabled: false, kill_switch: true, updated_at: new Date().toISOString() }).eq("id", 1);
    await log("created", "Greg's wallet was created. Spending is off until the owner turns it on.");
    return json({ address });
  }

  if (b.op === "request") { // the brain asks to buy a card or place a bet
    const row = { kind: b.kind, description: String(b.description || "").slice(0, 200), marketplace: b.marketplace, program_id: b.program_id, payload: b.payload || null, amount_sol: Number(b.amount_sol) };
    const why = await guard(w, row);
    if (why) { await db.from("greg_wallet_requests").insert({ ...row, status: "blocked", reason: why }); return json({ ok: false, error: why }); }
    const needsOwner = row.amount_sol > Number(w.approval_threshold_sol);
    const { data: r } = await db.from("greg_wallet_requests").insert({ ...row, status: "pending", reason: needsOwner ? "waiting for owner approval" : null }).select().single();
    if (needsOwner) return json({ ok: true, pending: r.id });
    return json(await execute(r, w));
  }

  if (b.op === "approve" || b.op === "reject") {
    if (caller !== "owner") return json({ error: "owner only" }, 401);
    const { data: r } = await db.from("greg_wallet_requests").select("*").eq("id", b.id).single();
    if (!r || r.status !== "pending") return json({ error: "not pending" }, 400);
    if (b.op === "reject") { await db.from("greg_wallet_requests").update({ status: "rejected", decided_at: new Date().toISOString() }).eq("id", r.id); await log("rejected", r.description, r.amount_sol); return json({ ok: true }); }
    await db.from("greg_wallet_requests").update({ status: "approved", decided_at: new Date().toISOString() }).eq("id", r.id);
    return json(await execute(r, w));
  }
  return json({ error: "unknown op" }, 400);
});
