// Greg's four HQ monitors, real data only:
//  left   Tweets:    his real posted tweets (greg_posts with a tweet_id) and what he is composing right now
//  center Charts:    live candles (GeckoTerminal) for what he watches, his real trades from greg_trades as markers,
//                    the real wallet value, PnL from real trades, the $1M progress. "Trading not enabled" until it is.
//  right  pump.fun:  newest Solana token profiles from DexScreener (live), labelled with the source
//  top    NFTs:      his real NFTs (wallet cards from the server cache) or "Gallery opening soon"
// Nothing is invented: when a source is unreachable the screen says so.
import { sb } from "./data.js";

const SOL_USDC_POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"; // Raydium SOL/USDC, his default watch
export function startScreens({ world, store, onOpen }) {
  const S = world.hq?.userData?.screens; if (!S) return;
  const data = { candles: null, candleErr: null, pairName: "SOL / USDC", tweets: [], trades: [], feed: null, feedErr: null, nfts: [] };
  const ink = "#e8f0ff", dim = "#8ea0c0", up = "#38d17a", down = "#ff5a5a", bg = "#0d1322";
  const ctx = (k) => S[k].cv.getContext("2d");
  const head = (x, w, title, tag) => { x.fillStyle = bg; x.fillRect(0, 0, w, 9999); x.fillStyle = "#16203a"; x.fillRect(0, 0, w, 44); x.fillStyle = ink; x.font = "800 24px system-ui"; x.fillText(title, 16, 31); if (tag) { x.font = "800 16px system-ui"; const tw = x.measureText(tag).width + 18; x.fillStyle = "#2a3658"; x.fillRect(w - tw - 12, 10, tw, 26); x.fillStyle = "#ffd23f"; x.fillText(tag, w - tw - 3, 29); } };
  const wrap = (x, t, X, Y, W, LH, max = 6) => { const words = String(t).split(" "); let line = "", n = 0; for (const w of words) { const tt = line + w + " "; if (x.measureText(tt).width > W && line) { x.fillText(line, X, Y); Y += LH; line = w + " "; if (++n >= max) return Y; } else line = tt; } x.fillText(line, X, Y); return Y + LH; };
  const usd = (n) => "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 2 : 0 });

  function drawCharts() {
    const { cv, tx } = S.charts, x = ctx("charts"), W = cv.width, H = cv.height, st = store.state || {};
    const enabled = !!(store.wallet?.enabled && !store.wallet?.kill_switch);
    head(x, W, "Charts · " + data.pairName, enabled ? "LIVE TRADING" : "Trading not enabled");
    const cw = W * 0.64, ch = H - 90, ox = 16, oy = 56;
    if (data.candles && data.candles.length) {
      const c = data.candles.slice(-48), lo = Math.min(...c.map((k) => k[3])), hi = Math.max(...c.map((k) => k[2])), sy = (v) => oy + ch - ((v - lo) / (hi - lo || 1)) * (ch - 20) - 10, bw = cw / c.length;
      x.strokeStyle = "#1f2b48"; x.lineWidth = 1; for (let i = 0; i < 5; i++) { const yy = oy + (i * ch) / 4; x.beginPath(); x.moveTo(ox, yy); x.lineTo(ox + cw, yy); x.stroke(); }
      c.forEach(([t, o, h, l, cl], i) => { const col = cl >= o ? up : down; x.strokeStyle = x.fillStyle = col; const cx = ox + i * bw + bw / 2; x.beginPath(); x.moveTo(cx, sy(h)); x.lineTo(cx, sy(l)); x.stroke(); x.fillRect(cx - bw * 0.32, Math.min(sy(o), sy(cl)), bw * 0.64, Math.max(2, Math.abs(sy(o) - sy(cl)))); });
      // his real trades as markers
      for (const tr of data.trades) { const ts = Date.parse(tr.created_at) / 1000, i = c.findIndex((k) => k[0] >= ts); if (i < 0) continue; const cx = ox + i * bw + bw / 2, buy = tr.side === "buy"; x.fillStyle = buy ? up : down; x.beginPath(); x.moveTo(cx, sy(c[i][buy ? 3 : 2]) + (buy ? 14 : -14)); x.lineTo(cx - 8, sy(c[i][buy ? 3 : 2]) + (buy ? 26 : -26)); x.lineTo(cx + 8, sy(c[i][buy ? 3 : 2]) + (buy ? 26 : -26)); x.fill(); }
      const last = c[c.length - 1][4]; x.fillStyle = ink; x.font = "800 22px system-ui"; x.fillText(usd(last), ox, H - 12); x.fillStyle = dim; x.font = "600 14px system-ui"; x.fillText("1h candles · GeckoTerminal", ox + 120, H - 14);
    } else { x.fillStyle = dim; x.font = "700 20px system-ui"; x.fillText(data.candleErr ? "Chart source unreachable right now" : "Loading live candles…", ox, oy + 40); }
    // portfolio column: real wallet value and real trades only
    const px = W * 0.68, sol = Number(st.wallet_usd || 0), cards = Number(st.cards_usd || 0), tot = sol + cards;
    x.fillStyle = dim; x.font = "700 15px system-ui"; x.fillText("WALLET VALUE", px, 74); x.fillStyle = ink; x.font = "900 34px system-ui"; x.fillText(usd(tot), px, 110);
    x.fillStyle = dim; x.font = "600 15px system-ui"; x.fillText(`SOL ${usd(sol)} + cards ${usd(cards)}`, px, 134);
    const pct = (tot / 1e6) * 100; x.fillStyle = "#1f2b48"; x.fillRect(px, 150, W - px - 16, 12); x.fillStyle = "#b6e452"; x.fillRect(px, 150, Math.max(2, (W - px - 16) * Math.min(1, pct / 100)), 12); x.fillStyle = dim; x.fillText(`$1M progress ${pct < 1 ? pct.toFixed(3) : pct.toFixed(1)}%`, px, 182);
    const closed = data.trades.filter((t) => t.pnl_usd != null), pnl = closed.reduce((a, t) => a + Number(t.pnl_usd), 0), wins = closed.filter((t) => Number(t.pnl_usd) > 0).length;
    x.fillStyle = dim; x.fillText("TRADES", px, 214); x.fillStyle = ink; x.font = "800 18px system-ui";
    if (!data.trades.length) x.fillText("No trades yet", px, 238);
    else { x.fillStyle = pnl >= 0 ? up : down; x.fillText(`PnL ${pnl >= 0 ? "+" : ""}${usd(pnl)} · win ${closed.length ? Math.round((wins / closed.length) * 100) : 0}%`, px, 238); x.font = "600 14px system-ui"; data.trades.slice(0, 4).forEach((t, i) => { x.fillStyle = t.side === "buy" ? up : down; x.fillText(`${t.side.toUpperCase()} ${t.symbol || ""} ${t.amount_usd ? usd(t.amount_usd) : ""}`, px, 262 + i * 20); }); }
    tx.needsUpdate = true;
  }
  function drawTweets() {
    const { cv, tx } = S.tweets, x = ctx("tweets"), W = cv.width, st = store.state || {};
    head(x, W, "Posts · @gregthefrogfun", "real posts only");
    let y = 76; const comp = st.screen?.mode === "tweet" ? st.screen.text : null;
    if (comp) { x.fillStyle = "#1b2744"; x.fillRect(12, y - 22, W - 24, 104); x.fillStyle = "#ffd23f"; x.font = "800 15px system-ui"; x.fillText("Writing now", 24, y); x.fillStyle = ink; x.font = "600 17px system-ui"; y = wrap(x, comp, 24, y + 24, W - 48, 21, 3) + 16; }
    x.font = "600 17px system-ui";
    if (!data.tweets.length) { x.fillStyle = dim; x.fillText("No tweets yet", 24, y + 10); }
    for (const t of data.tweets.slice(0, 4)) { if (y > cv.height - 40) break; x.fillStyle = dim; x.font = "700 13px system-ui"; x.fillText(new Date(t.posted_at || t.created_at).toLocaleString(), 24, y); x.fillStyle = ink; x.font = "600 17px system-ui"; y = wrap(x, t.text, 24, y + 22, W - 48, 21, 3) + 12; }
    tx.needsUpdate = true;
  }
  function drawPump() {
    const { cv, tx } = S.pump, x = ctx("pump"), W = cv.width;
    head(x, W, "pump.fun · new on Solana", "source: DexScreener");
    if (!data.feed) { x.fillStyle = dim; x.font = "700 18px system-ui"; x.fillText(data.feedErr ? "Feed unreachable right now" : "Loading live feed…", 20, 84); tx.needsUpdate = true; return; }
    data.feed.slice(0, 7).forEach((t, i) => { const y = 78 + i * 44; x.fillStyle = i % 2 ? "#111a2e" : "#0f1729"; x.fillRect(10, y - 26, W - 20, 40); x.fillStyle = ink; x.font = "800 17px system-ui"; x.fillText(String(t.name || t.tokenAddress.slice(0, 6) + "…").slice(0, 24), 22, y); x.fillStyle = dim; x.font = "600 13px system-ui"; x.fillText(String(t.desc || "").slice(0, 44), 22, y + 13 - 2 + 3); });
    x.fillStyle = "#ffd23f"; x.font = "700 13px system-ui"; x.fillText("Watching only. Holding: none. Not advice.", 20, cv.height - 14);
    tx.needsUpdate = true;
  }
  function drawNfts() {
    const { cv, tx } = S.nfts, x = ctx("nfts"), W = cv.width;
    const cards = store.wallet?.cards || data.nfts || [];
    head(x, W, "Greg's NFTs", cards.length ? cards.length + " in wallet" : "real wallet only");
    if (!cards.length) { x.fillStyle = ink; x.font = "800 26px system-ui"; x.fillText("Gallery opening soon", 24, 110); x.fillStyle = dim; x.font = "600 16px system-ui"; x.fillText("No NFTs in the wallet yet. Asking the universe.", 24, 142); }
    else cards.slice(0, 6).forEach((c, i) => { x.fillStyle = "#1b2744"; x.fillRect(16 + i * ((W - 32) / 6), 60, (W - 32) / 6 - 8, cv.height - 76); x.fillStyle = ink; x.font = "700 13px system-ui"; x.fillText(String(c.name || "").slice(0, 14), 22 + i * ((W - 32) / 6), cv.height - 24); });
    tx.needsUpdate = true;
  }
  const drawAll = () => { try { drawCharts(); drawTweets(); drawPump(); drawNfts(); } catch (e) { console.warn("screens", e); } };
  // data
  async function loadCandles() {
    try { const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${SOL_USDC_POOL}/ohlcv/hour?limit=48`, { headers: { accept: "application/json" } }); const j = await r.json(); const list = j?.data?.attributes?.ohlcv_list; if (!Array.isArray(list)) throw new Error("no data"); data.candles = list.map((k) => k.map(Number)).sort((a, b) => a[0] - b[0]); data.candleErr = null; } catch (e) { data.candleErr = String(e); }
  }
  async function loadFeed() {
    try { const r = await fetch("https://api.dexscreener.com/token-profiles/latest/v1"); const j = await r.json(); const sol = (Array.isArray(j) ? j : []).filter((t) => t.chainId === "solana"); data.feed = sol.slice(0, 10).map((t) => ({ tokenAddress: t.tokenAddress, name: (t.description || "").split(/[.!\n]/)[0].slice(0, 24) || t.tokenAddress.slice(0, 8), desc: t.description || "" })); data.feedErr = null; } catch (e) { data.feedErr = String(e); }
  }
  async function loadDb() {
    const [p, tr] = await Promise.all([
      sb.from("greg_posts").select("text,created_at,posted_at,tweet_id,status").eq("status", "posted").not("tweet_id", "is", null).order("created_at", { ascending: false }).limit(6),
      sb.from("greg_trades").select("*").order("created_at", { ascending: false }).limit(20),
    ]);
    data.tweets = p.data || []; data.trades = tr.data || [];
  }
  const tick = async () => { await Promise.allSettled([loadCandles(), loadFeed(), loadDb()]); drawAll(); };
  drawAll(); tick(); setInterval(tick, 120000); setInterval(drawAll, 5000);
  return { open: (k) => onOpen && onOpen(k, S[k].cv), drawAll };
}
