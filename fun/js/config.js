// Shared config for Greg's world. The anon key is public by design (RLS protects the data).
export const SUPABASE_URL = "https://mdggkjocllyqxpthvtop.supabase.co";
export const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZ2dram9jbGx5cXhwdGh2dG9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwMjk5MTAsImV4cCI6MjEwODYwNTkxMH0.Y1djwNT24Rh26HZa5z_ao72HsGACnbQNLHfj2sn6zDE";
export const FN = SUPABASE_URL + "/functions/v1";
export const X_URL = "https://x.com/gregthefrogfun";
export const GOAL_USD = 1000000;

// Places on the island. Must match supabase/functions/greg-tick/places.ts
export const PLACES = {
  plaza: { x: 0.0, z: 1.12, label: "the plaza" },
  green: { x: 0.0, z: -14.0, label: "his golf course" },
  shed: { x: 13.3, z: -5.6, label: "the studio" },
  bench: { x: 12.32, z: 8.4, label: "the workbench" },
  edge: { x: 0.56, z: 17.36, label: "the pond edge" },
  home: { x: -13.3, z: 8.12, label: "his lily-pad home" },
  rock: { x: -12.32, z: -8.68, label: "the server rock" },
  mailbox: { x: -4.48, z: 15.12, label: "his fan mailbox" },
  cafe: { x: 14.7, z: -14.7, label: "the web cafe" },
  bakery: { x: 9.24, z: -17.64, label: "the bakery" },
  nook: { x: -17.64, z: 1.68, label: "his reading nook" },
  gym: { x: 8.4, z: 15.68, label: "his gym corner" },
  pitch: { x: 18.48, z: 2.24, label: "the football pitch" },
  stage: { x: -5.88, z: -6.72, label: "his tiny stage" },
  hill: { x: -17.92, z: -10.64, label: "the paper plane hill" },
  beach: { x: -10.36, z: 18.48, label: "the beach" },
  art: { x: -8.96, z: 12.32, label: "his art wall" },
  flats: { x: 6.72, z: -9.24, label: "Fly Flats" },
  desk: { x: -17.64, z: 10.92, label: "his trading desk" },
  kitchen: { x: -8.96, z: 4.76, label: "his kitchen" },
};

// One scale table for the whole island (meters). Greg is the "human" scale; the fly is tiny next to him.
export const SCALE = { gregH: 2.2, gregR: 0.55, doorH: 2.6, doorW: 1.5, wallH: 3.0, tableH: 0.78, chairSeat: 0.46, cupH: 0.12, cupR: 0.06, flyR: 0.025, flyBody: 0.066, walkSpeed: 1.15 };

// Greg's walking route. Every route passes the plaza on a ring around the fountain (never through it),
// with rounded corners, so all viewers compute the same smooth path from the server's from/to and timing.
const PLAZA_R = 2.3;
function ringPt(a) { return [PLACES.plaza.x + Math.sin(a) * PLAZA_R, PLACES.plaza.z + Math.cos(a) * PLAZA_R]; }
const angOf = (p) => Math.atan2(p.x - PLACES.plaza.x, p.z - PLACES.plaza.z);
export function standPoint(name) { if (name === "plaza") return ringPt(0); const p = PLACES[name]; return p ? [p.x, p.z] : null; }
let router = null;
export function setRouter(f) { router = f; }
function roundCorners(clean, R = 0.5) {
  const out = [clean[0]];
  for (let i = 1; i < clean.length - 1; i++) {
    const a = clean[i - 1], b = clean[i], c = clean[i + 1];
    const la = Math.hypot(b[0] - a[0], b[1] - a[1]), lc = Math.hypot(c[0] - b[0], c[1] - b[1]), r = Math.min(R, la / 2, lc / 2);
    if (r < 0.02) { out.push(b); continue; }
    const p0 = [b[0] + (a[0] - b[0]) * r / la, b[1] + (a[1] - b[1]) * r / la], p2 = [b[0] + (c[0] - b[0]) * r / lc, b[1] + (c[1] - b[1]) * r / lc];
    for (let k = 0; k <= 4; k++) { const t = k / 4, u = 1 - t; out.push([u * u * p0[0] + 2 * u * t * b[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * b[1] + t * t * p2[1]]); }
  }
  out.push(clean[clean.length - 1]); return out;
}
export function routePts(from, to) {
  const B = standPoint(to); if (!B) return null; const A = standPoint(from);
  if (!A || from === to) return [B];
  if (router) { const r = router(A, B); if (r && r.length > 1) return roundCorners(r, 0.2); }
  const pts = [A];
  const a0 = from === "plaza" ? 0 : angOf(PLACES[from]), a1 = to === "plaza" ? 0 : angOf(PLACES[to]);
  let da = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
  const n = Math.max(1, Math.ceil(Math.abs(da) / 0.35));
  for (let i = 0; i <= n; i++) pts.push(ringPt(a0 + (da * i) / n));
  pts.push(B);
  const clean = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.05);
  return roundCorners(clean, 0.9);
}
// Position along the route at time t (ms), with ease-in / ease-out so Greg accelerates and slows down naturally.
export function posAt(state, t) {
  const pts = routePts(state?.from_place, state?.place) || (Array.isArray(state?.path) && state.path.length ? state.path : [[0, 0]]);
  const s = Date.parse(state.started_at), e = Date.parse(state.arrive_at);
  if (pts.length < 2 || !(e > s) || t >= e) { const p = pts[pts.length - 1]; return { x: p[0], z: p[1], walking: false, dir: dirOf(pts, pts.length - 2) }; }
  const D = e - s, ramp = Math.min(900, D / 4), el = Math.max(0, t - s), vmax = 1 / (D - ramp);
  const f = el < ramp ? 0.5 * vmax * el * el / ramp : el > D - ramp ? 1 - 0.5 * vmax * (D - el) ** 2 / ramp : 0.5 * vmax * ramp + vmax * (el - ramp);
  const lens = []; let total = 0;
  for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); lens.push(l); total += l; }
  let d = Math.min(1, f) * total;
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i] || i === lens.length - 1) {
      const k = lens[i] ? Math.min(1, d / lens[i]) : 1;
      return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, z: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k, walking: true, dir: dirOf(pts, i), speed: el < ramp ? el / ramp : el > D - ramp ? (D - el) / ramp : 1, total, D };
    }
    d -= lens[i];
  }
}
export function routeLength(from, to) { const p = routePts(from, to) || []; let l = 0; for (let i = 0; i < p.length - 1; i++) l += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]); return l; }
function dirOf(pts, i) { if (i < 0 || !pts[i + 1]) return 0; return Math.atan2(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); }

// Deterministic daily routine (utility AI). When the brain hasn't moved Greg for a while, every client computes
// the same schedule from the clock, so the island keeps living with zero LLM calls.
const ROUTINE = [
  ["green", "golf", (h) => (h >= 7 && h < 11 ? 3 : h >= 15 && h < 18 ? 2 : 0.6)],
  ["bakery", "espresso", (h) => (h >= 6 && h < 10 ? 3.2 : h >= 13 && h < 15 ? 1.5 : 0.3)],
  ["desk", "browse", (h) => (h >= 10 && h < 17 ? 2 : 0.5)],
  ["kitchen", "cook", (h) => (h >= 11 && h < 13 ? 2.4 : h >= 18 && h < 20 ? 2.4 : 0.2)],
  ["nook", "read", (h) => (h >= 19 && h < 23 ? 2 : 0.6)],
  ["shed", "piano", (h) => (h >= 14 && h < 21 ? 1.4 : 0.4)],
  ["beach", "relax", (h) => (h >= 16 && h < 19.5 ? 3 : 0.4)],
  ["art", "draw", (h) => (h >= 9 && h < 18 ? 1 : 0.2)],
  ["plaza", "wave", () => 1],
  ["home", "sleep", (h) => (h >= 23 || h < 6 ? 8 : 0.05)],
];
const SLOT = 150000;
function rng(n) { let a = (n * 2654435761) >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function pickSlot(n, prev) {
  const h = new Date(n * SLOT).getUTCHours() + new Date(n * SLOT).getUTCMinutes() / 60, r = rng(n);
  const opts = ROUTINE.filter((o) => o[0] !== prev); const w = opts.map((o) => o[2](h)); const sum = w.reduce((a, b) => a + b, 0);
  let x = r() * sum; for (let i = 0; i < opts.length; i++) { x -= w[i]; if (x <= 0) return opts[i]; } return opts[0];
}
export function routineState(now) {
  const n = Math.floor(now / SLOT); let place = "home"; const chain = [];
  for (let k = n - 6; k <= n; k++) { const o = pickSlot(k, place); chain.push([o[0], o[1]]); place = o[0]; }
  const [to, action] = chain[chain.length - 1], from = chain[chain.length - 2][0];
  const start = n * SLOT, walk = (routeLength(from, to) / SCALE.walkSpeed) * 1000;
  return { from_place: from, place: to, action, started_at: new Date(start).toISOString(), arrive_at: new Date(start + walk).toISOString(), routine: true };
}

export function visitorId() {
  try { let v = localStorage.getItem("greg_visitor"); if (!v) { v = crypto.randomUUID(); localStorage.setItem("greg_visitor", v); } return v; } catch { return "anon-" + Math.random().toString(36).slice(2); }
}
export function ago(ts) {
  const s = Math.max(1, Math.round((Date.now() - Date.parse(ts)) / 1000));
  if (s < 60) return s + "s ago"; if (s < 3600) return Math.round(s / 60) + "m ago"; if (s < 86400) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago";
}
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const usd = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
