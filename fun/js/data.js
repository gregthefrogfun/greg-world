// Greg data layer. The UI only reads from this store; the brain (greg-tick) writes to Supabase
// and every client gets the same state through Realtime.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_URL, SUPABASE_ANON, visitorId } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "greg-auth" },
  realtime: { params: { eventsPerSecond: 20 }, heartbeatIntervalMs: 15000, reconnectAfterMs: (n) => Math.min(10000, 500 * 2 ** n) },
});

export const store = {
  state: null, settings: null, wallet: null,
  diary: [], tools: [], ambitions: [], properties: [], wishes: [], works: [], items: [], positions: [], posts: [], chain: [], answers: [],
  viewers: 1, connected: false,
};
const subs = new Set();
export const onChange = (fn) => { subs.add(fn); fn(store, "init"); return () => subs.delete(fn); };
const emit = (what) => subs.forEach((f) => { try { f(store, what); } catch (e) { console.error(e); } });

const LIST = {
  diary: ["greg_diary", "created_at", 60],
  wishes: ["greg_wishes", "created_at", 50],
  works: ["greg_works", "created_at", 80],
  items: ["greg_items", "created_at", 100],
  positions: ["greg_positions", "updated_at", 100],
  posts: ["greg_posts", "created_at", 30],
  chain: ["greg_chain_log", "created_at", 50],
  tools: ["greg_tools", "created_at", 30],
  ambitions: ["greg_ambitions", "created_at", 20],
  properties: ["greg_properties", "created_at", 20],
};

async function loadAll(parts) {
  const jobs = [];
  if (!parts || parts.includes("state")) jobs.push(sb.from("greg_state").select("*").eq("id", 1).maybeSingle().then(({ data }) => { if (data) store.state = data; }));
  if (!parts || parts.includes("settings")) jobs.push(sb.from("greg_settings").select("*").eq("id", 1).maybeSingle().then(({ data }) => { store.settings = data; }));
  if (!parts || parts.includes("wallet")) jobs.push(sb.from("greg_wallet").select("address,enabled,kill_switch,daily_cap_sol,per_tx_cap_sol,approval_threshold_sol,balance_sol,balance_at").eq("id", 1).maybeSingle().then(({ data }) => { store.wallet = data; }));
  for (const [k, [t, o, n]] of Object.entries(LIST)) if (!parts || parts.includes(k)) jobs.push(sb.from(t).select("*").order(o, { ascending: false }).limit(n).then(({ data }) => { if (data) store[k] = data; }));
  if (!parts || parts.includes("answers")) jobs.push(sb.from("greg_questions").select("id,created_at,question,kind,status,answer,answered_at").eq("status", "answered").order("answered_at", { ascending: false }).limit(20).then(({ data }) => { if (data) store.answers = data; }));
  await Promise.all(jobs);
}

const TABLE_KEY = { greg_state: "state", greg_settings: "settings", greg_wallet: "wallet", greg_diary: "diary", greg_wishes: "wishes", greg_works: "works", greg_items: "items", greg_positions: "positions", greg_posts: "posts", greg_chain_log: "chain", greg_tools: "tools", greg_ambitions: "ambitions", greg_properties: "properties" };

function applyChange(p) {
  const key = TABLE_KEY[p.table]; if (!key) return;
  if (key === "state" || key === "settings" || key === "wallet") { if (p.new && p.new.id) store[key] = { ...(store[key] || {}), ...p.new }; emit(key); return; }
  const arr = store[key];
  if (p.eventType === "INSERT") arr.unshift(p.new);
  else if (p.eventType === "UPDATE") { const i = arr.findIndex((r) => r.id === p.new.id); if (i >= 0) arr[i] = p.new; else arr.unshift(p.new); }
  else if (p.eventType === "DELETE") { const i = arr.findIndex((r) => r.id === p.old.id); if (i >= 0) arr.splice(i, 1); }
  emit(key);
}

let started = false;
export async function start() {
  if (started) return; started = true;
  await loadAll(); emit("all");
  const ch = sb.channel("greg-world", { config: { presence: { key: visitorId() } } });
  for (const t of Object.keys(TABLE_KEY)) ch.on("postgres_changes", { event: "*", schema: "public", table: t }, applyChange);
  ch.on("presence", { event: "sync" }, () => { store.viewers = Math.max(1, Object.keys(ch.presenceState()).length); emit("viewers"); });
  ch.subscribe(async (status) => {
    store.connected = status === "SUBSCRIBED"; emit("conn");
    if (status === "SUBSCRIBED") { await ch.track({ at: Date.now() }); loadAll(); }
  });
  // Safety net: refresh in case a realtime event was missed (mobile tabs sleep).
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadAll().then(() => emit("all")); });
  setInterval(() => { if (!document.hidden) loadAll(["state", "diary"]).then(() => emit("state")); }, 60000);
}

export async function ask(q, isQuestion = false) {
  const { data, error } = await sb.rpc("greg_note", { q, visitor: visitorId(), is_question: isQuestion });
  if (error) return { ok: false, error: "Could not send. Try again." };
  return data;
}
export async function cheer(id) {
  const { data } = await sb.rpc("greg_cheer", { wish: id, voter: visitorId() });
  if (data?.ok) { try { const s = JSON.parse(localStorage.getItem("greg_cheered") || "[]"); s.push(id); localStorage.setItem("greg_cheered", JSON.stringify(s)); } catch {} }
  return data;
}
export const cheered = () => { try { return new Set(JSON.parse(localStorage.getItem("greg_cheered") || "[]")); } catch { return new Set(); } };

// Road to $1,000,000: paper portfolio + collection value (+ real wallet when phase 2 is on).
export function netWorth(s = store, solUsd = 150) {
  let cards = 0, bets = 0, pnl = 0;
  for (const p of s.positions) {
    if (p.status !== "open") continue;
    const v = Number(p.current_price ?? p.entry_price ?? 0) * Number(p.qty ?? 1);
    if (p.kind === "card") cards += v; else bets += v;
    pnl += v - Number(p.entry_price ?? 0) * Number(p.qty ?? 1);
  }
  for (const p of s.positions) if (p.status === "closed") pnl += Number(p.pnl ?? 0);
  const fund = Number(s.state?.golf_fund ?? 0);
  const wallet = s.wallet?.enabled && s.wallet?.balance_sol ? Number(s.wallet.balance_sol) * solUsd : 0;
  return { cards, bets, pnl, fund, wallet, total: cards + bets + fund + wallet };
}
