import { createWorld } from "./world3d.js";
import { store, start, onChange, ask, cheer, cheered, netWorth } from "./data.js";
import { PLACES, esc, ago, usd, GOAL_USD, SUPABASE_URL, X_URL } from "./config.js";
import * as audio from "./audio.js";
import { startFlies } from "./flies.js";
import { createInput } from "./input.js";
import { createHud, createSave } from "./hud.js";
import { createEyes } from "./eyes.js";
import { startChat } from "./chat.js";

const $ = (s) => document.querySelector(s);
const prefs = (() => { try { return JSON.parse(localStorage.getItem("greg_prefs") || "{}"); } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem("greg_prefs", JSON.stringify(prefs)); } catch {} };

// ---------- world ----------
const world = createWorld($("#c"), {
  lowPower: /Android|iPhone|iPad/.test(navigator.userAgent) && (navigator.hardwareConcurrency || 4) <= 4,
  onReady: () => $("#loading").classList.add("done"),
  onPick: (k) => { audio.blip(); openPick(k); },
  onLowQ: () => { const b = document.querySelector("#lqBtn"); if (b) b.textContent = "⚡ Low"; },
});
setTimeout(() => $("#loading").classList.add("done"), 6000);
// server clock skew so every viewer interpolates Greg to the same spot
fetch(SUPABASE_URL + "/rest/v1/", { method: "HEAD" }).then((r) => { const d = Date.parse(r.headers.get("date")); if (d) world.setClockSkew(d - Date.now()); }).catch(() => {});

// ---------- top UI ----------
const NEEDS = [["hunger", "Hunger"], ["energy", "Energy"], ["curiosity", "Curiosity"], ["joy", "Joy"], ["calm", "Calm"]];
function renderTop() {
  const s = store.state; if (!s) return;
  world.setState(s);
  const moving = Date.parse(s.arrive_at) > Date.now();
  const plan = world.gregPlan ? world.gregPlan(Date.now()) : null; $("#status").textContent = s.paused ? "Greg is taking a break. His owner paused him." : plan?.routine ? "Greg: " + plan.label : (s.status_line || "Greg is doing Greg things");
  $("#needs").innerHTML = NEEDS.map(([k, l]) => { const v = Math.round(Number(s.needs?.[k] ?? 50)); return `<div class="need">${l}<div class="bar"><i style="width:${v}%" class="${v < 25 ? "low" : v < 50 ? "mid" : ""}"></i></div></div>`; }).join("");
  $("#mailN").textContent = s.mail_unread ?? 0;
  const say = $("#say"); const line = s.speech;
  if (line && !moving) { say.textContent = line; say.classList.remove("hide"); } else if (line && moving) { say.textContent = line; say.classList.remove("hide"); } else say.classList.add("hide");
}
function placeBubble() {
  const p = world.gregScreen(); const say = $("#say");
  if (p.visible) { const hw = say.offsetWidth / 2 + 8; say.style.left = Math.max(hw, Math.min(innerWidth - hw - (innerWidth >= 900 ? 432 : 0), p.x)) + "px"; say.style.top = Math.max(say.offsetHeight + 150, p.y) + "px"; }
  requestAnimationFrame(placeBubble);
}
placeBubble();
setInterval(renderTop, 5000);

// chips
const chip = (id, on) => $(id).setAttribute("aria-pressed", on ? "true" : "false");
$("#chipFollow").onclick = () => { const f = !world.isFollowing(); world.setFollow(f); chip("#chipFollow", f); $("#chipFollow").innerHTML = f ? "🎥 Follow Greg" : "🖐️ Free look"; };
$("#chipMail").onclick = () => openTab("mail");
$("#chipWorth").onclick = () => openTab("money");
$("#chipViewers").onclick = () => toast("Everyone here sees the same Greg, live.");
function setSound(on) { prefs.sound = on; savePrefs(); chip("#chipSound", on); $("#chipSound").innerHTML = on ? "🔊 Sounds" : "🔈 Sounds"; audio.ambient(on); }
function setLofi(on) { prefs.lofi = on; savePrefs(); chip("#chipLofi", on); audio.lofi(on); }
$("#chipSound").onclick = () => setSound(!prefs.sound);
$("#chipLofi").onclick = () => setLofi(!prefs.lofi);
// browsers only allow audio after a tap; ambience is on by default
window.addEventListener("pointerdown", function first() { window.removeEventListener("pointerdown", first); audio.unlock(); if (prefs.sound !== false) setSound(true); if (prefs.lofi) setLofi(true); }, { once: true });

// ---------- visitor flies ----------
let flies = null;
try {
  const input = createInput($("#c")); window.__gregInput = input; const save = createSave(), hud = createHud({ input, save, world });
  flies = startFlies(world, {
    input, hud, save, toast: (m) => toast(m),
    onInspect: (title, html) => { $("#mbody").innerHTML = `<h2>${esc(title)}</h2>${html}`; $("#modal").classList.add("show"); input.release(); },
    isSoundOn: () => prefs.sound !== false,
    onCount: (n) => { const el = $("#online"); if (el) el.textContent = n; },
    onRubNear: () => { const now = Date.now(); if (now - (window.__rubNag || 0) < 20000 || Math.random() < 0.5) { window.__rubNag = window.__rubNag || 0; return; } window.__rubNag = now; const say = $("#say"); say.textContent = ["Don't you dare.", "Hands where I can see them, buddy.", "Rubbing your hands near my croissant? Bold move."][Math.floor(Math.random() * 3)]; say.classList.remove("hide"); clearTimeout(window.__rentT); window.__rentT = setTimeout(renderTop, 4000); },
    onUnpaidNear: (mine) => { const now = Date.now(); if (now - (window.__rentNag || 0) < 25000) return; window.__rentNag = now; const say = $("#say"); const nm = mine && flies ? flies.name() : "buddy"; say.textContent = [`Rent's due, ${nm}.`, "Nice wings. Nicer if they paid rent.", "Tap tap tap. That's my foot. Rent, friend.", "Free-loading fly spotted. I'm watching you. Fondly."][Math.floor(Math.random() * 4)]; say.classList.remove("hide"); clearTimeout(window.__rentT); window.__rentT = setTimeout(renderTop, 4500); },
    onRent: (total) => { if (total != null) { const el = $("#flyRent"); if (el) el.textContent = total; } const pop = $("#rentPop"); if (pop) { pop.classList.remove("show"); void pop.offsetWidth; pop.classList.add("show"); } },
  });
  flies.onDeath(() => { toast("SWATTED! Respawning in 3..."); audio.blip("low"); });
  hud.mobile = (k, v) => flies.setMobile(k, v);
  const eyes = createEyes(world, flies); input.on("eyes", () => eyes.toggle());
  input.on("closeMenu", () => closeTop());
  try { startChat({ input, save, flies, toast }); } catch (e) { console.error("chat", e); }
  const rb = $("#renameBtn"); if (rb) rb.onclick = () => { closeTop(true); flies.rename(); };
  // ☰ menu: one list; every panel closes with ×, Esc (top panel first) or a click outside, and only one is open at a time
  const menuEl = $("#menu");
  const fillMenu = () => { $("#mName").textContent = flies.name(); $("#mMode").textContent = flies.settings.skill ? "Skill" : "Assisted"; $("#mSound").textContent = prefs.sound === false ? "off" : "on"; $("#mQ").textContent = world.isLowQuality() ? "Low" : "High"; };
  const openMenu = () => { closeTop(true); fillMenu(); menuEl.classList.add("show"); input.release(); };
  $("#menuBtn").onclick = (e) => { e.stopPropagation(); menuEl.classList.contains("show") ? menuEl.classList.remove("show") : openMenu(); };
  $("#menuClose").onclick = () => menuEl.classList.remove("show");
  menuEl.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => { const m = b.dataset.m;
    if (m === "resume") menuEl.classList.remove("show");
    if (m === "mode") { hud.onMode(!flies.settings.skill); fillMenu(); }
    if (m === "how") { menuEl.classList.remove("show"); hud.toggleHow(true); }
    if (m === "map") { menuEl.classList.remove("show"); hud.openMap(); }
    if (m === "chat") { menuEl.classList.remove("show"); input.press("chat"); input.press("chat", false); }
    if (m === "sound") { setSound(prefs.sound === false); fillMenu(); }
    if (m === "quality") { world.setLowQuality(!world.isLowQuality()); fillMenu(); } }));
  window.__openMenu = openMenu;
  window.__closeTop = closeTop;
  $("#payBtn").onclick = async () => { $("#payBtn").disabled = true; await flies.payRent(); audio.blip(); toast("Rent paid. Greg nods approvingly. 🪙"); setTimeout(() => ($("#payBtn").disabled = false), 60000); };
  $("#askBtn").onclick = () => { openTab("mail"); setTimeout(() => { const q = $("#isq"); if (q) q.checked = true; $("#note")?.focus(); }, 50); };
  $("#lqBtn").onclick = () => { const v = !world.isLowQuality(); world.setLowQuality(v); $("#lqBtn").textContent = v ? "⚡ Low" : "✨ HQ"; };
  $("#camBtn").onclick = () => { const p = !flies.isPov(); flies.setPov(p); $("#camBtn").textContent = p ? "🐸 Greg cam" : "🪰 Fly cam"; };
} catch (e) { console.error("flies", e); }
window.__greg = { world, get flies() { return flies; }, get input() { return window.__gregInput; } };

// ---------- $1M meter (server-cached wallet value, pushed to everyone over Realtime) ----------
const GREG_ADDR = "CNAg1pWXsyakdDr2XfVQqDWkdzY9mQpbYBTBxgc1oppf";
let lastTotal = null; const MILESTONES = [100, 1000, 10000, 100000, 1000000];
function renderMeter() {
  const st = store.state || {}; const sol = Number(st.wallet_usd || 0), cards = Number(st.cards_usd || 0), tot = sol + cards;
  const pct = (tot / 1e6) * 100;
  $("#mPct").textContent = (pct < 1 ? pct.toFixed(3) : pct.toFixed(1)) + "%";
  $("#mFill").style.width = Math.max(0.3, Math.min(100, pct)) + "%";
  $("#mLine").textContent = `SOL ${usd(sol)} + cards ${usd(cards)} = ${usd(tot)} · wallet value, live on Solana`;
  if (lastTotal != null && MILESTONES.some((m) => lastTotal < m && tot >= m)) { world.cheer(); toast("Milestone! Greg is dancing."); }
  lastTotal = tot;
  const b = $("#wBal"); if (b && st.wallet_sol != null) b.textContent = Number(st.wallet_sol).toFixed(3) + " SOL";
  world.setCards(st.cards || []);
  const bd = $("#binder"); if (bd) bd.innerHTML = (st.cards || []).map((c) => `<div style="border:2px solid var(--ink);border-radius:8px;overflow:hidden;background:#fff;font-size:10.5px;font-weight:800">${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" style="width:100%;aspect-ratio:5/7;object-fit:cover;display:block">` : ""}<div style="padding:3px">${esc((c.name || "").slice(0, 40))}<br>${esc(c.grade || "")} · ${usd(c.usd)}<br><span style="color:var(--muted)">${esc(c.source || "")}</span></div></div>`).join("") || `<p class="muted" style="grid-column:1/-1;font-weight:700">Waiting for the first pull. No cards in the wallet yet.</p>`;
}
const pingValue = () => fetch(SUPABASE_URL + "/functions/v1/greg-wallet-value", { method: "POST" }).catch(() => {});
pingValue(); setInterval(() => { if (!document.hidden) pingValue(); }, 60000);
$("#wCopy").onclick = () => { navigator.clipboard?.writeText(GREG_ADDR); toast("Address copied"); };

// optional real rent in SOL: the visitor signs a plain SOL transfer in their own wallet; the server verifies it on-chain
document.querySelectorAll("[data-sol]").forEach((b) => (b.onclick = async () => {
  const prov = window.phantom?.solana || window.solflare || window.solana;
  if (!prov) return toast("Open this page in Phantom or Solflare, or install one.");
  try {
    b.disabled = true; await prov.connect();
    const w3 = await import("https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.3/+esm");
    const bh = await fetch(SUPABASE_URL + "/functions/v1/greg-rent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "blockhash" }) }).then((r) => r.json());
    const from = prov.publicKey;
    const tx = new w3.Transaction({ feePayer: from, recentBlockhash: bh.blockhash }).add(w3.SystemProgram.transfer({ fromPubkey: from, toPubkey: new w3.PublicKey(GREG_ADDR), lamports: Math.round(Number(b.dataset.sol) * 1e9) }));
    const res = await prov.signAndSendTransaction(tx); const sig = res.signature || res;
    toast("Sent! Checking it on-chain...");
    const v = await fetch(SUPABASE_URL + "/functions/v1/greg-rent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sig, fly: flies?.me?.name }) }).then((r) => r.json());
    if (v.ok) { try { localStorage.setItem("greg_sol_paid", String(Date.now())); } catch {} flies?.markGold?.(); toast("Real rent paid. Gold badge unlocked. Greg is thrilled. 🪙"); world.cheer(); pingValue(); }
    else toast(v.error || "Could not verify yet. Try again in a minute.");
  } catch (e) { toast("Cancelled or failed."); } finally { b.disabled = false; }
}));

// ---------- menu overlay ----------
const menu = $("#menu");
if (menu) { menu.onclick = (e) => { if (e.target === menu) menu.classList.remove("show"); }; }

// ---------- sheet + tabs ----------
let tab = prefs.tab || "feed", worksSeg = "gallery";
function openTab(t) { tab = t; prefs.tab = t; savePrefs(); $("#sheet").classList.add("open"); renderTab(); }
document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => { if (tab === b.dataset.tab && $("#sheet").classList.contains("open") && innerWidth < 900) { $("#sheet").classList.remove("open"); return; } openTab(b.dataset.tab); }));
$(".grab").onclick = () => $("#sheet").classList.toggle("open");

const demo = (r) => (r?.is_demo ? ' <span class="badge demo">demo</span>' : "");
const KIND = { say: "says", think: "thinks", ask: "asks", opinion: "hot take", diary: "diary", reaction: "reacts" };
function renderTab() {
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false"));
  const b = $("#body");
  if (tab === "feed") b.innerHTML = feedHTML();
  if (tab === "wishes") b.innerHTML = wishesHTML();
  if (tab === "works") b.innerHTML = worksHTML();
  if (tab === "money") b.innerHTML = moneyHTML();
  if (tab === "mail") b.innerHTML = mailHTML();
  bindBody();
}
function feedHTML() {
  const items = store.diary.slice(0, 40).map((d) => `<div class="entry ${d.kind}"><div class="meta"><span class="badge">${KIND[d.kind] || d.kind}</span>${d.place ? esc(PLACES[d.place]?.label || d.place) + " · " : ""}${ago(d.created_at)}${demo(d)}</div><p>${esc(d.text)}</p></div>`).join("");
  const posts = store.posts.filter((p) => p.status !== "rejected").slice(0, 5).map((p) => `<div class="entry"><div class="meta"><span class="badge ${p.status === "posted" ? "granted" : "waiting"}">${p.status === "posted" ? "posted on X" : "draft tweet"}</span>${ago(p.created_at)}${demo(p)}</div><p>${esc(p.text)}</p></div>`).join("");
  return `<div class="sec"><h3>What Greg says and writes</h3>${items || '<div class="empty">Greg has not said anything yet.</div>'}</div>
  <div class="sec"><h3>Tweets he is drafting</h3>${posts || '<div class="empty">No drafts yet.</div>'}<p class="disc">Greg's own X account is not connected yet. Drafts wait here for his owner.</p></div>`;
}
function wishesHTML() {
  const done = cheered();
  const w = store.wishes.map((x) => `<div class="entry wish"><div class="row"><b style="font-size:16px">${esc(x.title)}</b><span class="badge ${x.status}">${x.status}</span></div>${x.why ? `<p class="muted" style="margin-top:4px">${esc(x.why)}</p>` : ""}${x.reaction ? `<p style="margin-top:6px">🐸 "${esc(x.reaction)}"</p>` : ""}<div class="row" style="margin-top:8px;justify-content:space-between"><span class="muted" style="font-size:12px;font-weight:800">${ago(x.created_at)}${demo(x)}</span>${x.status === "waiting" ? `<button class="btn small alt" data-cheer="${x.id}" ${done.has(x.id) ? "disabled" : ""}>📣 ${x.votes || 0} ${done.has(x.id) ? "cheered" : "cheer"}</button>` : `<span class="badge">📣 ${x.votes || 0}</span>`}</div></div>`).join("");
  return `<div class="sec"><h3>Greg's wish list</h3><p class="muted" style="margin:0 0 10px;font-weight:700">Things Greg asks his owner for. Only his owner can grant them. You can cheer to show you agree.</p>${w || '<div class="empty">No wishes yet.</div>'}</div>`;
}
function workCard(w) {
  const img = w.image_url ? `<img src="${esc(w.image_url)}" alt="${esc(w.title)}" loading="lazy">` : "";
  const extra = w.kind === "song" && w.song ? `<button class="btn small" data-song="${w.id}">▶ Play</button>` : w.link ? `<a class="btn small alt" href="${esc(w.link)}">Open</a>` : w.video_url ? `<a class="btn small alt" href="${esc(w.video_url)}">Watch</a>` : "";
  return `<div class="work">${img}<div class="in"><span class="t">${esc(w.title)}</span><span class="muted" style="font-size:12.5px;font-weight:700">${esc(w.blurb || "")}</span>${extra}<span class="credit">Generated by Greg · ${esc(w.compute_note || "Rendered on Higgsfield")}</span><span>${demo(w)}${w.version ? ` <span class="badge">v${esc(w.version)}</span>` : ""}</span></div></div>`;
}
function worksHTML() {
  const segs = { gallery: ["drawing", "album", "video"], jams: ["song"], projects: ["toy", "code", "golfsim", "course"] };
  const list = store.works.filter((w) => segs[worksSeg].includes(w.kind));
  let inner;
  if (worksSeg === "jams") inner = list.map((w) => `<div class="song">${w.image_url ? `<img src="${esc(w.image_url)}" alt="">` : ""}<div style="flex:1;min-width:0"><b>${esc(w.title)}</b>${demo(w)}<div class="muted" style="font-size:12.5px;font-weight:700">${esc(w.blurb || "")}</div><span class="credit">Generated by Greg · ${esc(w.compute_note || "Rendered on Higgsfield")}</span></div><button class="play" data-song="${w.id}" aria-label="Play ${esc(w.title)}">▶</button></div>`).join("");
  else inner = `<div class="grid">${list.map(workCard).join("")}</div>`;
  const tools = worksSeg === "projects" && store.tools.length ? `<div class="sec" style="margin-top:14px"><h3>Tools he built for himself</h3>${store.tools.map((t) => `<div class="entry"><div class="meta"><span class="badge ${t.enabled ? "granted" : "off"}">${t.enabled ? "in use" : "off"}</span>used ${t.uses} times</div><p><b>${esc(t.name)}</b>: ${esc(t.purpose || "")}</p></div>`).join("")}</div>` : "";
  return `<div class="seg"><button data-seg="gallery" aria-pressed="${worksSeg === "gallery"}">Gallery</button><button data-seg="jams" aria-pressed="${worksSeg === "jams"}">Jams</button><button data-seg="projects" aria-pressed="${worksSeg === "projects"}">Projects</button></div>${list.length ? inner : '<div class="empty">Nothing here yet. He is working on it.</div>'}${tools}`;
}
function moneyHTML() {
  const nw = netWorth(); const pct = Math.min(100, (nw.total / GOAL_USD) * 100);
  const cards = store.positions.filter((p) => p.kind === "card");
  const bets = store.positions.filter((p) => p.kind === "bet");
  const pnl = (p) => { const v = p.status === "closed" ? Number(p.pnl || 0) : (Number(p.current_price ?? p.entry_price ?? 0) - Number(p.entry_price ?? 0)) * Number(p.qty || 1); return `<span class="pnl ${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${usd(v)}</span>`; };
  const cardHTML = cards.map((c) => `<div class="card ${c.status === "watching" ? "watch" : ""}" title="${esc(c.opinion || "")}">${c.image_url ? `<img src="${esc(c.image_url)}" alt="${esc(c.name)}" loading="lazy">` : `<div style="position:absolute;inset:0;display:grid;place-items:center;font-size:34px">🃏</div>`}<div class="cap">${esc(c.name)}<br>${c.status === "watching" ? "wishlist " + usd(c.current_price) : usd(c.current_price ?? c.entry_price) + " " + pnl(c)}</div></div>`).join("");
  const betHTML = bets.map((b) => `<div class="entry"><div class="meta"><span class="badge ${b.status === "open" ? "paper" : b.status === "watching" ? "waiting" : ""}">${b.status === "watching" ? "watching" : b.status === "open" ? "paper bet" : "settled"}</span>${esc(b.source || "")}${demo(b)}</div><p>${esc(b.name)}</p><div class="row" style="justify-content:space-between;margin-top:4px;font-size:13px;font-weight:800"><span>${b.side ? "Side: " + esc(b.side) : ""} ${b.entry_price != null ? "@ " + Math.round(b.entry_price * 100) + "¢" : ""} → ${b.current_price != null ? Math.round(b.current_price * 100) + "¢" : "?"}</span>${b.status !== "watching" ? pnl(b) : ""}</div>${b.opinion ? `<p class="muted" style="margin-top:4px;font-size:13px">🐸 ${esc(b.opinion)}</p>` : ""}</div>`).join("");
  const w = store.wallet;
  const wallet = w?.address ? `<div class="entry"><div class="meta"><span class="badge ${w.enabled && !w.kill_switch ? "live" : "off"}">${w.enabled && !w.kill_switch ? "active" : "spending off"}</span></div><p style="word-break:break-all"><code>${esc(w.address)}</code></p><p>${w.balance_sol != null ? Number(w.balance_sol).toFixed(3) + " SOL" : "balance pending"}</p><p class="disc">Caps: ${w.per_tx_cap_sol} SOL per purchase, ${w.daily_cap_sol} SOL per day. Bigger moves need his owner's approval.</p></div>` : `<div class="empty">Greg does not have a real wallet yet. Everything below is paper money.</div>`;
  const chain = store.chain.slice(0, 10).map((c) => `<div class="entry"><div class="meta">${ago(c.created_at)} · ${esc(c.kind)}</div><p>${esc(c.note || "")} ${c.amount_sol ? c.amount_sol + " SOL" : ""} ${c.tx_sig ? `<a href="https://solscan.io/tx/${esc(c.tx_sig)}" target="_blank" rel="noopener">tx</a>` : ""}</p></div>`).join("");
  return `<div class="million"><div style="font-weight:900;font-size:13px;letter-spacing:.06em">ROAD TO $1,000,000</div><div class="big">${usd(nw.total)}</div><div class="track"><i style="width:${pct}%"></i></div><div style="font-size:12px;font-weight:800;opacity:.85">Golf fund ${usd(nw.fund)} · Cards ${usd(nw.cards)} · Bets ${usd(nw.bets)}${nw.wallet ? " · Wallet " + usd(nw.wallet) : ""}</div></div>
  <p class="disc">Greg is a cartoon frog playing a game. These are paper trades with pretend money, not advice. Visitors cannot invest, bet or earn anything here.</p>
  <div class="sec"><h3>Greg's collection</h3><div class="cards">${cardHTML || '<div class="empty">Empty binder.</div>'}</div></div>
  <div class="sec"><h3>Greg's predictions</h3>${betHTML || '<div class="empty">No predictions yet.</div>'}</div>
  <div class="sec"><h3>Greg's wallet</h3>${wallet}${chain ? `<h3 style="font-family:var(--font-head);font-weight:400;font-size:18px;margin:10px 0 6px">On-chain log</h3>${chain}` : ""}</div>`;
}
function mailHTML() {
  const s = store.state || {}; const sorter = store.tools.find((t) => t.slug === "mail-sorter" && t.enabled);
  const ans = store.answers.map((a) => `<div class="entry"><div class="meta">${a.kind === "question" ? "question" : "note"} · ${ago(a.answered_at || a.created_at)}</div><p class="muted">"${esc(a.question)}"</p><p style="margin-top:6px">🐸 ${esc(a.answer)}</p></div>`).join("");
  return `<div class="sec"><h3>Leave Greg a note</h3>
  <p class="muted" style="margin:0 0 8px;font-weight:700">Your note goes in the fan mailbox by his pond. He reads mail on his own schedule. ${s.mail_unread ? `There are <b>${s.mail_unread}</b> notes waiting.` : ""} ${sorter ? "He sorts it with his own Fan Mail Sorter." : ""}</p>
  <textarea id="note" maxlength="280" placeholder="Hi Greg, how is the putting green?"></textarea>
  <div class="row" style="margin-top:8px;justify-content:space-between"><label style="font-weight:800;font-size:14px"><input type="checkbox" id="isq"> It's a question</label><button class="btn" id="send">Drop in mailbox</button></div>
  <p class="disc">No links, no spam, be kind. Greg decides if and how he answers.</p></div>
  <div class="sec"><h3>Greg answered</h3>${ans || '<div class="empty">No answers yet.</div>'}</div>`;
}
function bindBody() {
  const b = $("#body");
  b.querySelectorAll("[data-seg]").forEach((x) => (x.onclick = () => { worksSeg = x.dataset.seg; renderTab(); }));
  b.querySelectorAll("[data-cheer]").forEach((x) => (x.onclick = async () => { x.disabled = true; const r = await cheer(Number(x.dataset.cheer)); if (r?.ok) { audio.blip(); toast("Greg heard you!"); } else toast(r?.error || "Try later"); }));
  b.querySelectorAll("[data-song]").forEach((x) => (x.onclick = () => playWork(Number(x.dataset.song), x)));
  const send = b.querySelector("#send");
  if (send) send.onclick = async () => {
    const t = b.querySelector("#note").value.trim(); if (t.length < 2) return toast("Write a little more.");
    send.disabled = true; const r = await ask(t, b.querySelector("#isq").checked); send.disabled = false;
    if (r?.ok) { b.querySelector("#note").value = ""; audio.blip(); toast("Dropped in his mailbox 📬"); } else toast(r?.error || "Could not send");
  };
}
let playing = null;
function playWork(id, btn) {
  const w = store.works.find((x) => x.id === id); if (!w?.song) return;
  if (playing === id) { audio.stop(); return; }
  audio.unlock(); playing = id; btn.textContent = "■";
  audio.playSong(w.song, () => { playing = null; btn.textContent = btn.classList.contains("play") ? "▶" : "▶ Play"; });
}

// ---------- clickable favourites ----------
const PICK = {
  greg: () => { const s = store.state || {}; const think = store.diary.find((d) => d.kind === "think"); return [`Greg, right now`, `<div class="bubble" style="margin:4px 0 20px">${esc(s.speech || think?.text || "Thinking about golf. Always golf.")}</div><p style="font-weight:800">${esc(s.status_line || "")}</p>${needsMini(s)}`]; },
  golf: () => [`The Greatest Green`, `<p>"Hand built. Every blade of grass. People say it's the finest putting green on any pond in the world. They say it to me all the time."</p><p class="muted">His golf fund: <b>${usd(store.state?.golf_fund)}</b></p><a class="btn" href="/golf/">⛳ Play his course</a>`],
  trophies: () => [`Trophy Shelf`, `<p>"Pond Open champion. Lily Pad Masters champion. Undisputed. I awarded them myself, which is the hardest judge there is."</p><ul style="font-weight:800"><li>🏆 Pond Open 2026 (self-awarded)</li><li>🥇 Longest Putt Over Water</li><li>🏅 Best Beanie, Golf Division</li></ul>`],
  studio: () => { const s = store.works.find((w) => w.kind === "song"); return [`The Studio`, `<p>"My synth makes sounds nobody has heard before. Tremendous sounds. Very green."</p>${s ? `<div class="song"><div style="flex:1"><b>${esc(s.title)}</b>${demo(s)}</div><button class="play" data-song="${s.id}">▶</button></div>` : ""}<button class="btn alt" data-goto="works:jams">All jams</button>`]; },
  binder: () => { const c = store.positions.filter((p) => p.kind === "card" && p.status === "open"); return [`Card Binder`, `<p>"My collection. Graded. Tokenized. Beautiful. Some of these cards will be worth a fortune, believe me."</p><p class="muted">${c.length} cards in the binder (paper), ${store.positions.filter((p) => p.kind === "card" && p.status === "watching").length} on his wishlist.</p><button class="btn" data-goto="money">Open the binder</button>`]; },
  predictions: () => { const b = store.positions.filter((p) => p.kind === "bet" && p.status === "open"); return [`Prediction Board`, `<p>"I read the odds like I read a green. Perfectly."</p>${b.slice(0, 3).map((x) => `<p style="font-weight:800">• ${esc(x.name)} <span class="badge paper">${esc(x.side || "")}</span></p>`).join("")}<p class="disc">Paper bets only. Not advice.</p><button class="btn" data-goto="money">See all predictions</button>`]; },
  projects: () => { const p = store.works.filter((w) => ["toy", "code", "golfsim", "course"].includes(w.kind)); return [`The Workbench`, `<p>"I build my own tools. Nobody builds tools like me. Engineers come to me and say, Greg, how?"</p>${p.slice(0, 3).map((x) => `<p style="font-weight:800">• ${esc(x.title)}${demo(x)}</p>`).join("")}<button class="btn" data-goto="works:projects">See his projects</button>`]; },
  diary: () => { const d = store.diary.filter((x) => x.kind === "diary").slice(0, 3); return [`Greg's Diary`, d.map((x) => `<div class="entry diary"><div class="meta">${ago(x.created_at)}</div><p>${esc(x.text)}</p></div>`).join("") + `<button class="btn" data-goto="feed">Read it all</button>`]; },
  wallet: () => [`The Money Chest`, `<p>"One million dollars. That's the plan. A very simple plan. Very smart."</p><p class="muted">Net worth (paper): <b>${usd(netWorth().total)}</b></p><button class="btn" data-goto="money">Road to $1,000,000</button>`],
  rock: () => [`The Server Rock`, `<p>"My server rock. Very powerful rock. The best rock. I think my brain lives in there. Hi, brain."</p>`],
  home: () => [`Lily-Pad Home`, `<p>"Luxury lily pad. Waterfront. Best views on the pond. I sleep here and dream about golf."</p>`],
  mailbox: () => [`Fan Mailbox`, `<p>"${(store.state?.mail_unread || 0) > 30 ? "So much mail. Nobody gets more fan mail than me. Nobody. It's a lot. Maybe too much." : "Fan mail. Very important. I read every one, eventually."}"</p><p class="muted"><b>${store.state?.mail_unread || 0}</b> notes waiting.</p><button class="btn" data-goto="mail">Leave him a note</button>`],
  cafe: () => [`The Web Cafe`, `<p>"Where I do my research. Cards, odds, golf clubs. I Google like a champion."</p>`],
  bakery: () => [`The Bakery`, `<p>"Fly croissants. The best snack in the pond. Keeps my Hunger bar beautiful."</p>`],
};
function needsMini(s) { return `<div class="needs" style="padding:0;margin-top:10px">${NEEDS.map(([k, l]) => { const v = Math.round(Number(s.needs?.[k] ?? 50)); return `<div class="need">${l}<div class="bar"><i style="width:${v}%" class="${v < 25 ? "low" : v < 50 ? "mid" : ""}"></i></div></div>`; }).join("")}</div>`; }
function openPick(k) {
  let title, html;
  if (k && typeof k === "object" && k.card) { const c = k.card; $("#mbody").innerHTML = `<h2>${esc(c.grade || "Graded card")}</h2>${c.image ? `<img src="${esc(c.image)}" alt="" style="width:100%;border:3px solid var(--ink);border-radius:12px">` : ""}<p style="font-weight:800">${esc(c.name)}</p><p>Value ${usd(c.usd)} <span class="muted">(${esc(c.source)})</span></p><p class="disc">Read only. Greg never lists, sells or moves cards.</p>`; $("#modal").classList.add("show"); return; }
  if (k && typeof k === "object" && k.item) { const it = k.item; title = `${it.emoji || "⭐"} ${it.name}`; html = `<p>"${esc(it.note || "A gift for my island. A tremendous gift.")}"</p><p class="muted">Added by his owner ${ago(it.created_at)}.</p>`; }
  else { const f = PICK[k]; if (!f) return; [title, html] = f(); }
  $("#mbody").innerHTML = `<h2>${esc(title)}</h2>${html}`; $("#modal").classList.add("show");
  $("#mbody").querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => { const [t, seg] = b.dataset.goto.split(":"); if (seg) worksSeg = seg; closeModal(); openTab(t); }));
  $("#mbody").querySelectorAll("[data-song]").forEach((x) => (x.onclick = () => playWork(Number(x.dataset.song), x)));
}
const closeModal = () => $("#modal").classList.remove("show");
$("#mclose").onclick = closeModal; $("#modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };
function closeTop(all) {
  const order = [() => $("#modal").classList.contains("show") && ($("#modal").classList.remove("show"), true), () => $("#menu")?.classList.contains("show") && ($("#menu").classList.remove("show"), true), () => document.querySelector(".ghow.show:not(.gname)") && (document.querySelector(".ghow.show:not(.gname)").classList.remove("show"), true), () => document.querySelector(".gmap:not(.hide)") && (document.querySelector(".gmap").classList.add("hide"), true)];
  let any = false; for (const f of order) { if (f()) { any = true; if (!all) break; } } return any;
}
addEventListener("keydown", (e) => { if (e.key === "Escape" && !document.activeElement?.closest?.("input,textarea") && !document.querySelector(".gname.show")) { if (!closeTop() && window.__openMenu) window.__openMenu(); } });
let tt = 0; function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => t.classList.remove("show"), 1800); }

// ---------- data wiring ----------
onChange((s, what) => {
  if (what === "viewers" || what === "init" || what === "all") $("#viewers").textContent = s.viewers;
  if (["state", "all", "init"].includes(what)) { renderTop(); renderMeter(); const el = $("#flyRent"); if (el && s.state?.fly_rent != null) el.textContent = s.state.fly_rent; }
  if (what === "items" || what === "all") world.setItems(s.items);
  if (what === "ambitions" || what === "all") world.setCareers(s.ambitions);
  if (what === "properties" || what === "all") world.setProperties(s.properties);
  $("#worthChip").textContent = usd(netWorth().total);
  if (what !== "viewers" && what !== "conn" && $("#sheet").classList.contains("open") && !document.activeElement?.matches?.("textarea")) renderTab();
});
if (innerWidth >= 900) openTab(tab); else renderTab();
start();
