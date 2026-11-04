// Greg's four HQ monitors, real data only (never mock numbers; honest loading and empty states):
//  left   Posts:     his real posted tweets (greg_posts with a tweet_id) and what he is composing right now
//  center Chart:     live 1-minute candles (Jupiter datapi, pump.fun curve coins included) of the coin he holds or is
//                    watching, his entries and exits from greg_trades as markers, live PnL. Falls back to SOL / USD.
//  right  pump.fun:  live pump.fun feed (new coins and coins about to graduate): icon, ticker, market cap, curve %, age.
//                    The coin Greg is looking at is highlighted.
//  top    Positions: his open positions (live value) and today's PnL. Paper trades are labelled as paper.
// F on a monitor opens a full-size live view (HTML) with a pump.fun link to the coin. Tweets never contain addresses.
import { sb } from "./data.js";
import { FN, SUPABASE_ANON } from "./config.js";

const SOL_USDC_POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"; // fallback chart when he holds and watches nothing
const DATAPI = "https://datapi.jup.ag";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const okMint = (m) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(m || ""));
const pumpUrl = (m) => `https://pump.fun/coin/${encodeURIComponent(m)}`;

export function startScreens({ world, store, onOpen }) {
  const S = world.hq?.userData?.screens; if (!S) return;
  const data = { candles: null, candleErr: null, candleSrc: "", chartCoin: null, sol: null, tweets: [], trades: [], positions: [], tstate: null, feed: null, feedErr: null, feedAt: 0 };
  const ink = "#e8f0ff", dim = "#8ea0c0", up = "#38d17a", down = "#ff5a5a", bg = "#0d1322", hl = "#ffd23f";
  const ctx = (k) => S[k].cv.getContext("2d");
  const head = (x, w, title, tag) => { x.fillStyle = bg; x.fillRect(0, 0, w, 9999); x.fillStyle = "#16203a"; x.fillRect(0, 0, w, 44); x.fillStyle = ink; x.font = "800 24px system-ui"; x.fillText(title, 16, 31); if (tag) { x.font = "800 16px system-ui"; const tw = x.measureText(tag).width + 18; x.fillStyle = "#2a3658"; x.fillRect(w - tw - 12, 10, tw, 26); x.fillStyle = hl; x.fillText(tag, w - tw - 3, 29); } };
  const wrap = (x, t, X, Y, W, LH, max = 6) => { const words = String(t).split(" "); let line = "", n = 0; for (const w of words) { const tt = line + w + " "; if (x.measureText(tt).width > W && line) { x.fillText(line, X, Y); Y += LH; line = w + " "; if (++n >= max) return Y; } else line = tt; } x.fillText(line, X, Y); return Y + LH; };
  const usd = (n) => n == null || !Number.isFinite(Number(n)) ? "?" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 10 ? 2 : 0 });
  const kusd = (n) => n == null ? "?" : n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? "$" + (n / 1e3).toFixed(1) + "K" : "$" + Math.round(n);
  const px = (v) => v == null ? "?" : v < 0.0001 ? "$" + Number(v).toExponential(2) : "$" + Number(v).toPrecision(4);
  const ageOf = (iso) => { if (!iso) return "?"; const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000); return m < 60 ? Math.round(m) + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d"; };
  // coin icons: only load with CORS so the canvas stays readable; on failure we just skip the picture
  const icons = new Map();
  const icon = (url) => { if (!url || !/^https:\/\//.test(url)) return null; let e = icons.get(url); if (!e) { const im = new Image(); im.crossOrigin = "anonymous"; e = { im, ok: false }; im.onload = () => (e.ok = true); im.onerror = () => (e.ok = false); im.src = url; icons.set(url, e); if (icons.size > 120) icons.delete(icons.keys().next().value); } return e.ok ? e.im : null; };

  // which coin the center chart follows: newest open position, else what he is watching
  function chartTarget() {
    const p = data.positions[0]; if (p && okMint(p.mint)) return { mint: p.mint, symbol: p.symbol, name: p.name, icon: p.icon, pos: p };
    const w = data.tstate?.watching; if (w && okMint(w.mint)) return { mint: w.mint, symbol: w.symbol, name: w.name, icon: w.icon, pos: null };
    return null;
  }
  const positionPnl = (p) => { const v = Number(p.live_value ?? p.last_value_usd), c = Number(p.cost_usd); return Number.isFinite(v) && c > 0 ? { v, pnl: v - c, pct: ((v - c) / c) * 100 } : null; };
  const todayPnl = () => { const d0 = new Date(); d0.setUTCHours(0, 0, 0, 0); const realized = data.trades.filter((t) => t.side === "sell" && Date.parse(t.created_at) >= +d0).reduce((a, t) => a + Number(t.pnl_usd || 0), 0); const open = data.positions.reduce((a, p) => { const q = positionPnl(p); return a + (q ? q.pnl : 0); }, 0); return { realized, open, total: realized + open }; };

  function drawCharts() {
    const { cv, tx } = S.charts, x = ctx("charts"), W = cv.width, H = cv.height, st = store.state || {};
    const live = !!(store.wallet?.enabled && !store.wallet?.kill_switch && store.wallet?.trade_dry_run === false);
    const coin = data.chartCoin;
    head(x, W, "Chart · " + (coin ? (coin.symbol || "coin") : "SOL / USD"), live ? "LIVE TRADING" : data.positions.some((p) => p.paper) ? "PAPER (dry run)" : "Trading off");
    const cw = W * 0.64, ch = H - 96, ox = 16, oy = 56;
    const c = data.candles;
    if (c && c.length > 1) {
      const lo = Math.min(...c.map((k) => k.l)), hi = Math.max(...c.map((k) => k.h)), sy = (v) => oy + ch - ((v - lo) / (hi - lo || 1)) * (ch - 20) - 10, bw = cw / c.length;
      x.strokeStyle = "#1f2b48"; x.lineWidth = 1; for (let i = 0; i < 5; i++) { const yy = oy + (i * ch) / 4; x.beginPath(); x.moveTo(ox, yy); x.lineTo(ox + cw, yy); x.stroke(); }
      c.forEach((k, i) => { const col = k.c >= k.o ? up : down; x.strokeStyle = x.fillStyle = col; const cx = ox + i * bw + bw / 2; x.beginPath(); x.moveTo(cx, sy(k.h)); x.lineTo(cx, sy(k.l)); x.stroke(); x.fillRect(cx - bw * 0.32, Math.min(sy(k.o), sy(k.c)), bw * 0.64, Math.max(2, Math.abs(sy(k.o) - sy(k.c)))); });
      // entries and exits for this coin from greg_trades
      if (coin) for (const tr of data.trades.filter((t) => t.mint === coin.mint)) {
        const ts = Date.parse(tr.created_at) / 1000; let i = c.findIndex((k) => k.t >= ts - 30); if (i < 0) { if (ts > c[c.length - 1].t) i = c.length - 1; else continue; }
        const cx = ox + i * bw + bw / 2, buy = tr.side === "buy", yv = Number(tr.price_usd) >= lo && Number(tr.price_usd) <= hi ? sy(Number(tr.price_usd)) : sy(buy ? c[i].l : c[i].h);
        x.fillStyle = buy ? up : down; x.beginPath(); x.moveTo(cx, yv + (buy ? 6 : -6)); x.lineTo(cx - 9, yv + (buy ? 22 : -22)); x.lineTo(cx + 9, yv + (buy ? 22 : -22)); x.fill();
        x.font = "800 12px system-ui"; x.fillText(buy ? "IN" : "OUT", cx - 9, yv + (buy ? 36 : -28));
      }
      const last = c[c.length - 1].c; x.fillStyle = ink; x.font = "800 22px system-ui"; x.fillText(coin ? px(last) : usd(last), ox, H - 14);
      x.fillStyle = dim; x.font = "600 14px system-ui"; x.fillText(data.candleSrc, ox + 150, H - 16);
    } else { x.fillStyle = dim; x.font = "700 20px system-ui"; x.fillText(data.candleErr ? "Chart source unreachable right now" : "Loading live candles…", ox, oy + 40); }
    // right column: the coin and his live PnL, or the wallet
    const qx = W * 0.68; x.font = "700 15px system-ui";
    if (coin) {
      const im = icon(coin.icon); if (im) x.drawImage(im, qx, 58, 40, 40);
      x.fillStyle = ink; x.font = "900 22px system-ui"; x.fillText(String(coin.symbol || "?").slice(0, 12), qx + 48, 82); x.fillStyle = dim; x.font = "600 13px system-ui"; x.fillText(String(coin.name || "").slice(0, 22), qx + 48, 98);
      if (coin.pos) {
        const q = positionPnl(coin.pos);
        x.fillStyle = dim; x.font = "700 15px system-ui"; x.fillText(coin.pos.paper ? "PAPER POSITION" : "HOLDING", qx, 132);
        x.fillStyle = ink; x.font = "800 18px system-ui"; x.fillText(`in ${usd(coin.pos.cost_usd)} · now ${q ? usd(q.v) : "?"}`, qx, 156);
        if (q) { x.fillStyle = q.pnl >= 0 ? up : down; x.font = "900 28px system-ui"; x.fillText(`${q.pnl >= 0 ? "+" : ""}${q.pct.toFixed(1)}%`, qx, 192); }
      } else { x.fillStyle = hl; x.font = "800 16px system-ui"; x.fillText("WATCHING, not holding", qx, 140); }
      x.fillStyle = dim; x.font = "600 13px system-ui"; x.fillText("F: open the full chart", qx, 222);
    } else {
      const sol = Number(st.wallet_usd || 0), cards = Number(st.cards_usd || 0), tot = sol + cards;
      x.fillStyle = dim; x.fillText("WALLET VALUE", qx, 74); x.fillStyle = ink; x.font = "900 34px system-ui"; x.fillText(usd(tot), qx, 110);
      const pct = (tot / 1e6) * 100; x.fillStyle = "#1f2b48"; x.fillRect(qx, 130, W - qx - 16, 12); x.fillStyle = "#b6e452"; x.fillRect(qx, 130, Math.max(2, (W - qx - 16) * Math.min(1, pct / 100)), 12); x.fillStyle = dim; x.font = "600 15px system-ui"; x.fillText(`$1M progress ${pct < 1 ? pct.toFixed(3) : pct.toFixed(1)}%`, qx, 162);
      x.fillText("No position, nothing watched yet", qx, 192);
    }
    tx.needsUpdate = true;
  }
  function drawTweets() {
    const { cv, tx } = S.tweets, x = ctx("tweets"), W = cv.width, st = store.state || {};
    head(x, W, "Posts · @gregthefrogfun", "real posts only");
    let y = 76; const comp = st.screen?.mode === "tweet" ? st.screen.text : null;
    if (comp) { x.fillStyle = "#1b2744"; x.fillRect(12, y - 22, W - 24, 104); x.fillStyle = hl; x.font = "800 15px system-ui"; x.fillText("Writing now", 24, y); x.fillStyle = ink; x.font = "600 17px system-ui"; y = wrap(x, comp, 24, y + 24, W - 48, 21, 3) + 16; }
    x.font = "600 17px system-ui";
    if (!data.tweets.length) { x.fillStyle = dim; x.fillText("No tweets yet", 24, y + 10); }
    for (const t of data.tweets.slice(0, 4)) { if (y > cv.height - 40) break; x.fillStyle = dim; x.font = "700 13px system-ui"; x.fillText(new Date(t.posted_at || t.created_at).toLocaleString(), 24, y); x.fillStyle = ink; x.font = "600 17px system-ui"; y = wrap(x, t.text, 24, y + 22, W - 48, 21, 3) + 12; }
    tx.needsUpdate = true;
  }
  const feedRows = () => { const f = data.feed; if (!f) return []; const w = data.tstate?.watching?.mint; const rows = [...(f.aboutToGraduate || []).slice(0, 6).map((r) => ({ ...r, list: "graduating" })), ...(f.recent || []).slice(0, 6).map((r) => ({ ...r, list: "new" }))]; return rows.sort((a, b) => (b.mint === w) - (a.mint === w)); };
  function drawPump() {
    const { cv, tx } = S.pump, x = ctx("pump"), W = cv.width;
    head(x, W, "pump.fun · live", data.feedAt ? "updated " + Math.max(0, Math.round((Date.now() - data.feedAt) / 1000)) + "s ago" : "");
    const rows = feedRows();
    if (!rows.length) { x.fillStyle = dim; x.font = "700 18px system-ui"; x.fillText(data.feedErr ? "Feed unreachable right now" : "Loading live feed…", 20, 84); tx.needsUpdate = true; return; }
    const w = data.tstate?.watching?.mint, held = new Set(data.positions.map((p) => p.mint));
    x.fillStyle = dim; x.font = "700 12px system-ui"; x.fillText("COIN", 64, 60); x.fillText("MCAP", W * 0.52, 60); x.fillText("CURVE", W * 0.68, 60); x.fillText("AGE", W * 0.88, 60);
    rows.slice(0, 7).forEach((t, i) => {
      const y = 70 + i * 42, mark = t.mint === w || held.has(t.mint);
      x.fillStyle = mark ? "#3a3410" : i % 2 ? "#111a2e" : "#0f1729"; x.fillRect(8, y, W - 16, 38); if (mark) { x.strokeStyle = hl; x.lineWidth = 2; x.strokeRect(9, y + 1, W - 18, 36); }
      const im = icon(t.icon); if (im) x.drawImage(im, 16, y + 4, 30, 30); else { x.fillStyle = "#2a3658"; x.fillRect(16, y + 4, 30, 30); }
      x.fillStyle = ink; x.font = "800 16px system-ui"; x.fillText(String(t.symbol || "?").slice(0, 10), 56, y + 18); x.fillStyle = dim; x.font = "600 11px system-ui"; x.fillText((held.has(t.mint) ? "HOLDING · " : t.mint === w ? "GREG IS LOOKING · " : "") + t.list, 56, y + 32);
      x.fillStyle = ink; x.font = "700 15px system-ui"; x.fillText(kusd(t.mcap), W * 0.52, y + 24);
      const cp = Math.max(0, Math.min(100, Number(t.curve || 0))); x.fillStyle = "#1f2b48"; x.fillRect(W * 0.68, y + 14, W * 0.17, 10); x.fillStyle = cp >= 100 ? hl : up; x.fillRect(W * 0.68, y + 14, W * 0.17 * cp / 100, 10); x.fillStyle = dim; x.font = "600 11px system-ui"; x.fillText(cp.toFixed(0) + "%", W * 0.68, y + 35);
      x.fillStyle = dim; x.font = "700 14px system-ui"; x.fillText(ageOf(t.createdAt), W * 0.88, y + 24);
    });
    x.fillStyle = hl; x.font = "700 13px system-ui"; x.fillText("Live data from Jupiter. Not financial advice.", 16, cv.height - 12);
    tx.needsUpdate = true;
  }
  function drawPositions() {
    const { cv, tx } = S.nfts, x = ctx("nfts"), W = cv.width, H = cv.height;
    const P = data.positions, d = todayPnl(), paper = P.length && P.every((p) => p.paper);
    head(x, W, "Positions" + (paper ? " (paper)" : ""), `today ${d.total >= 0 ? "+" : ""}${usd(d.total)}`);
    if (!P.length) { x.fillStyle = ink; x.font = "800 24px system-ui"; x.fillText("No open positions", 24, 100); x.fillStyle = dim; x.font = "600 16px system-ui"; x.fillText(`Realized today: ${usd(d.realized)}`, 24, 130); tx.needsUpdate = true; return; }
    const cwid = (W - 24) / Math.min(3, P.length);
    P.slice(0, 3).forEach((p, i) => {
      const X = 12 + i * cwid, q = positionPnl(p); x.fillStyle = "#1b2744"; x.fillRect(X, 54, cwid - 10, H - 66);
      const im = icon(p.icon); if (im) x.drawImage(im, X + 10, 64, 34, 34);
      x.fillStyle = ink; x.font = "800 17px system-ui"; x.fillText(String(p.symbol || "?").slice(0, 10), X + 52, 80); x.fillStyle = dim; x.font = "600 12px system-ui"; x.fillText((p.paper ? "paper · " : "") + ageOf(p.opened_at), X + 52, 96);
      x.fillStyle = dim; x.font = "600 14px system-ui"; x.fillText(`in ${usd(p.cost_usd)} → ${q ? usd(q.v) : "?"}`, X + 10, 124);
      if (q) { x.fillStyle = q.pnl >= 0 ? up : down; x.font = "900 24px system-ui"; x.fillText(`${q.pnl >= 0 ? "+" : ""}${q.pct.toFixed(1)}%`, X + 10, 156); }
    });
    tx.needsUpdate = true;
  }
  const drawAll = () => { try { drawCharts(); drawTweets(); drawPump(); drawPositions(); } catch (e) { console.warn("screens", e); } };

  // ---------- data ----------
  async function edge(body) { const r = await fetch(FN + "/greg-trade", { method: "POST", headers: { "content-type": "application/json", apikey: SUPABASE_ANON }, body: JSON.stringify(body) }); if (!r.ok) throw new Error("edge " + r.status); return r.json(); }
  let directOk = true; // try Jupiter directly first; if the browser blocks it (CORS), use the edge proxy
  async function loadFeed() {
    try {
      let j = null;
      if (directOk) { try { const r = await fetch(DATAPI + "/v1/pools/gems", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recent: { launchpads: ["pump.fun"] }, aboutToGraduate: { launchpads: ["pump.fun"] } }) }); const g = await r.json(); const slim = (p) => { const a = p.baseAsset || {}; return { mint: a.id, symbol: a.symbol, name: a.name, icon: a.icon, mcap: a.mcap, curve: a.graduatedAt ? 100 : p.bondingCurve, createdAt: a.createdAt || a.firstPool?.createdAt }; }; j = { recent: (g.recent?.pools || []).map(slim), aboutToGraduate: (g.aboutToGraduate?.pools || []).map(slim) }; } catch { directOk = false; } }
      if (!j) j = await edge({ op: "feed" });
      if (j?.error) throw new Error(j.error);
      data.feed = j; data.feedAt = Date.now(); data.feedErr = null;
    } catch (e) { data.feedErr = String(e); }
  }
  async function loadChart() {
    const t = chartTarget(); data.chartCoin = t;
    try {
      if (t) {
        let j = null;
        if (directOk) { try { const r = await fetch(`${DATAPI}/v2/charts/${t.mint}?interval=1_MINUTE&to=${Date.now()}&candles=90&type=price&quote=usd`); j = await r.json(); } catch { directOk = false; } }
        if (!j) j = await edge({ op: "chart", mint: t.mint, interval: "1_MINUTE", candles: 90 });
        const list = (j?.candles || []).map((k) => ({ t: Number(k.time), o: Number(k.open), h: Number(k.high), l: Number(k.low), c: Number(k.close) })).filter((k) => Number.isFinite(k.c));
        if (!list.length) throw new Error("no candles yet");
        data.candles = list; data.candleSrc = "1m candles · Jupiter"; data.candleErr = null;
        if (t.pos) { const tok = Number(t.pos.tokens_raw) / 10 ** Number(t.pos.decimals || 6); t.pos.live_value = tok * list[list.length - 1].c; }
      } else {
        const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${SOL_USDC_POOL}/ohlcv/hour?limit=48`, { headers: { accept: "application/json" } }); const j = await r.json(); const ol = j?.data?.attributes?.ohlcv_list; if (!Array.isArray(ol)) throw new Error("no data");
        data.candles = ol.map((k) => ({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]) })).sort((a, b) => a.t - b.t); data.candleSrc = "1h candles · GeckoTerminal"; data.candleErr = null;
      }
    } catch (e) { data.candleErr = String(e); if (t) data.candles = null; }
  }
  async function loadDb() {
    const [p, tr, pos, ts] = await Promise.all([
      sb.from("greg_posts").select("text,created_at,posted_at,tweet_id,status").eq("status", "posted").not("tweet_id", "is", null).order("created_at", { ascending: false }).limit(6),
      sb.from("greg_trades").select("*").order("created_at", { ascending: false }).limit(40),
      sb.from("greg_trade_positions").select("*").eq("status", "open").order("opened_at", { ascending: false }),
      sb.from("greg_trade_state").select("watching,last_scan_at").eq("id", 1).maybeSingle(),
    ]);
    data.tweets = p.data || []; data.trades = tr.data || [];
    const old = new Map(data.positions.map((x) => [x.id, x.live_value])); data.positions = (pos.data || []).map((x) => ({ ...x, live_value: old.get(x.id) })); data.tstate = ts.data || null;
  }
  const visible = () => document.visibilityState !== "hidden";
  const slow = async () => { if (!visible()) return; await loadDb(); await loadChart(); drawAll(); refreshModal(); };
  const fast = async () => { if (!visible()) return; await loadChart(); drawAll(); refreshModal(); };
  const feedTick = async () => { if (!visible()) return; await loadFeed(); drawAll(); refreshModal(); };
  drawAll(); slow(); feedTick(); setInterval(slow, 20000); setInterval(fast, 6000); setInterval(feedTick, 10000); setInterval(drawAll, 2000);

  // ---------- full-size live view (F on a monitor) ----------
  let openKey = null;
  function html(k) {
    const P = data.positions, d = todayPnl();
    const posRow = (p) => { const q = positionPnl(p); return `<tr><td>${p.icon ? `<img src="${esc(p.icon)}" alt="" width="22" height="22" style="border-radius:6px;vertical-align:middle"> ` : ""}<b>${esc(p.symbol || "?")}</b>${p.paper ? " <small>(paper)</small>" : ""}</td><td>${usd(p.cost_usd)}</td><td>${q ? usd(q.v) : "?"}</td><td style="color:${q && q.pnl >= 0 ? up : down}">${q ? (q.pnl >= 0 ? "+" : "") + q.pct.toFixed(1) + "%" : "?"}</td><td><a href="${pumpUrl(p.mint)}" target="_blank" rel="noopener">pump.fun</a></td></tr>`; };
    const tbl = (h, rows) => `<table style="width:100%;border-collapse:collapse;font-size:14px"><tr>${h.map((x) => `<th style="text-align:left;color:#8ea0c0;font-weight:700">${x}</th>`).join("")}</tr>${rows}</table>`;
    if (k === "pump") { const rows = feedRows(); return rows.length ? tbl(["Coin", "Market cap", "Curve", "Age", ""], rows.slice(0, 14).map((t) => `<tr${t.mint === data.tstate?.watching?.mint ? ' style="background:#fff3c4"' : ""}><td>${t.icon ? `<img src="${esc(t.icon)}" alt="" width="22" height="22" style="border-radius:6px;vertical-align:middle"> ` : ""}<b>${esc(t.symbol || "?")}</b> <small>${esc(String(t.name || "").slice(0, 24))}</small></td><td>${kusd(t.mcap)}</td><td>${Math.round(Number(t.curve || 0))}%</td><td>${ageOf(t.createdAt)}</td><td><a href="${pumpUrl(t.mint)}" target="_blank" rel="noopener">pump.fun</a></td></tr>`).join("")) + "<p class='muted'>Live from Jupiter. Highlighted: the coin Greg is looking at. Not financial advice.</p>" : `<p>${data.feedErr ? "Feed unreachable right now." : "Loading live feed…"}</p>`; }
    if (k === "nfts") return (P.length ? tbl(["Coin", "In", "Now", "PnL", ""], P.map(posRow).join("")) : "<p>No open positions.</p>") + `<p>Today: <b>${d.total >= 0 ? "+" : ""}${usd(d.total)}</b> (realized ${usd(d.realized)}, open ${usd(d.open)}).</p>`;
    if (k === "charts") { const c = data.chartCoin; return `<img src="${S.charts.cv.toDataURL()}" alt="" style="width:100%;border:3px solid #141218;border-radius:10px;background:#0d1322">` + (c ? `<p><b>${esc(c.symbol || "")}</b> ${esc(c.name || "")} · <a href="${pumpUrl(c.mint)}" target="_blank" rel="noopener">open on pump.fun</a></p>` : "<p class='muted'>Not holding or watching a coin. Showing SOL / USD.</p>") + (P.length ? tbl(["Coin", "In", "Now", "PnL", ""], P.map(posRow).join("")) : ""); }
    return `<img src="${S[k].cv.toDataURL()}" alt="" style="width:100%;border:3px solid #141218;border-radius:10px;background:#0d1322">`;
  }
  function refreshModal() { const el = document.getElementById("gscr-live"); if (!el) { openKey = null; return; } if (openKey) el.innerHTML = html(openKey); }
  const titles = { charts: "Live chart", tweets: "Greg's posts", pump: "pump.fun live", nfts: "Positions and today's PnL" };
  const api = { open: (k) => onOpen && onOpen(k, S[k].cv), drawAll, title: (k) => titles[k] || "Monitor", html: (k) => { openKey = k; return `<div id="gscr-live">${html(k)}</div>`; } };
  window.__gregScreens = api;
  return api;
}
