// All sound is synthesized live with WebAudio on ONE context, routed through mixer buses:
//   master -> sfx (flies, taps, UI), amb (ocean, wind, birds, crickets, cafe, keyboard, golf), music (lo-fi, Greg's songs), voice
// Volumes are per viewer (localStorage). Nothing plays before the first tap or key (browser rule).
let ctx = null, master = null; const B = {};
const VOL_KEY = "greg_vol_v1";
const DEF = { master: 0.85, sfx: 0.8, amb: 0.7, music: 0.5, voice: 0.9 };
let vol = { ...DEF }; try { vol = { ...DEF, ...JSON.parse(localStorage.getItem(VOL_KEY) || "{}") }; } catch {}
let gestured = false; for (const ev of ["pointerdown", "keydown", "touchstart"]) addEventListener(ev, () => { gestured = true; ac(); }, { once: true, capture: true });

function ac() {
  if (!gestured) return null;
  if (!ctx) {
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
    master = ctx.createGain(); master.gain.value = vol.master; master.connect(ctx.destination);
    for (const k of ["sfx", "amb", "music", "voice"]) { B[k] = ctx.createGain(); B[k].gain.value = vol[k]; B[k].connect(master); }
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}
export const context = () => ac();
export const bus = (k) => (ac() ? (k === "master" ? master : B[k]) : null);
export const volumes = () => ({ ...vol });
export function setVolume(k, v) {
  vol[k] = Math.max(0, Math.min(1, Number(v) || 0)); try { localStorage.setItem(VOL_KEY, JSON.stringify(vol)); } catch {}
  if (!ctx) return; const n = k === "master" ? master : B[k]; if (n) n.gain.setTargetAtTime(vol[k], ctx.currentTime, 0.05);
}
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
let NB = null;
function noiseBuf() { if (NB) return NB; const c = ac(); const b = c.createBuffer(1, c.sampleRate * 3, c.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return (NB = b); }
let BN = null; // brown noise for ocean/wind
function brownBuf() { if (BN) return BN; const c = ac(); const b = c.createBuffer(1, c.sampleRate * 4, c.sampleRate); const d = b.getChannelData(0); let last = 0; for (let i = 0; i < d.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; } return (BN = b); }
const loopNoise = (buf, filt, f, q = 0.7) => { const c = ac(); const s = c.createBufferSource(); s.buffer = buf; s.loop = true; const fl = c.createBiquadFilter(); fl.type = filt; fl.frequency.value = f; fl.Q.value = q; const g = c.createGain(); g.gain.value = 0; s.connect(fl); fl.connect(g); g.connect(B.amb); s.start(0, Math.random() * 2); return { s, f: fl, g }; };

// ---------- ambience layers, mixed by where the listener is ----------
let ambOn = false, L = null, timers = [];
const isDay = () => { const d = new Date(), h = d.getUTCHours() + d.getUTCMinutes() / 60; return h >= 6 && h < 19; };
function buildLayers() {
  if (L || !ac()) return;
  const c = ctx;
  const ocean = loopNoise(brownBuf(), "lowpass", 420, 0.5);
  const swell = c.createOscillator(); swell.frequency.value = 0.09; const sw = c.createGain(); sw.gain.value = 160; swell.connect(sw); sw.connect(ocean.f.frequency); swell.start();
  const wind = loopNoise(noiseBuf(), "bandpass", 380, 0.6);
  const wl = c.createOscillator(); wl.frequency.value = 0.17; const wlg = c.createGain(); wlg.gain.value = 120; wl.connect(wlg); wlg.connect(wind.f.frequency); wl.start();
  const cafe = loopNoise(brownBuf(), "bandpass", 520, 1.4); // murmur
  const mm = c.createOscillator(); mm.frequency.value = 3.1; const mmg = c.createGain(); mmg.gain.value = 140; mm.connect(mmg); mmg.connect(cafe.f.frequency); mm.start();
  L = { ocean, wind, cafe, near: { cafe: 0, desk: 0, green: 0 }, night: !isDay() };
}
function chirpBird(g = 0.05) { const c = ctx, t = c.currentTime; const o = c.createOscillator(), e = c.createGain(); o.type = "sine"; const f0 = 2200 + Math.random() * 1500; o.frequency.setValueAtTime(f0, t); for (let i = 0; i < 3; i++) { o.frequency.linearRampToValueAtTime(f0 * 1.3, t + i * 0.12 + 0.05); o.frequency.linearRampToValueAtTime(f0, t + i * 0.12 + 0.1); } e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(g, t + 0.02); e.gain.linearRampToValueAtTime(0, t + 0.4); o.connect(e); e.connect(B.amb); o.start(t); o.stop(t + 0.45); }
function cricket(g = 0.025) { const c = ctx, t = c.currentTime; for (let k = 0; k < 3; k++) { const o = c.createOscillator(), e = c.createGain(); o.type = "sine"; o.frequency.value = 4300 + Math.random() * 200; const s = t + k * 0.07; e.gain.setValueAtTime(0, s); e.gain.linearRampToValueAtTime(g, s + 0.01); e.gain.linearRampToValueAtTime(0, s + 0.045); o.connect(e); e.connect(B.amb); o.start(s); o.stop(s + 0.06); } }
function ribbit(g = 0.08) { const c = ctx, t = c.currentTime; for (let k = 0; k < 2; k++) { const o = c.createOscillator(), e = c.createGain(), f = c.createBiquadFilter(); o.type = "sawtooth"; o.frequency.value = 120 + Math.random() * 40; f.type = "bandpass"; f.frequency.value = 700; f.Q.value = 4; const s = t + k * 0.22; e.gain.setValueAtTime(0, s); e.gain.linearRampToValueAtTime(g, s + 0.02); e.gain.exponentialRampToValueAtTime(0.001, s + 0.16); o.connect(f); f.connect(e); e.connect(B.amb); o.start(s); o.stop(s + 0.2); } }
function espressoHiss(g) { const c = ctx, t = c.currentTime; const s = c.createBufferSource(); s.buffer = noiseBuf(); const f = c.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 3200; const e = c.createGain(); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(g, t + 0.15); e.gain.setValueAtTime(g, t + 1.2); e.gain.exponentialRampToValueAtTime(0.001, t + 2.2); s.connect(f); f.connect(e); e.connect(B.amb); s.start(t, Math.random()); s.stop(t + 2.3); }
function keyClicks(g) { const c = ctx, t = c.currentTime, n = 4 + Math.floor(Math.random() * 10); for (let i = 0; i < n; i++) { const s = c.createBufferSource(); s.buffer = noiseBuf(); const f = c.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 2500 + Math.random() * 1500; f.Q.value = 3; const e = c.createGain(); const st = t + i * (0.07 + Math.random() * 0.09); e.gain.setValueAtTime(g, st); e.gain.exponentialRampToValueAtTime(0.001, st + 0.03); s.connect(f); f.connect(e); e.connect(B.amb); s.start(st, Math.random() * 2); s.stop(st + 0.04); } }
function loopEvery(fn, lo, hi) { const go = () => { const id = setTimeout(() => { if (!ambOn) return; try { fn(); } catch {} go(); }, lo + Math.random() * (hi - lo)); timers.push(id); }; go(); }
export function ambient(on) {
  ambOn = !!on; timers.forEach(clearTimeout); timers = [];
  if (!ac()) return; buildLayers();
  B.amb.gain.setTargetAtTime(on ? vol.amb : 0, ctx.currentTime, 0.4);
  if (!on) return;
  loopEvery(() => { if (!L.night) { Math.random() < 0.75 ? chirpBird(0.04 + Math.random() * 0.03) : ribbit(0.06); } else ribbit(0.05); }, 2200, 6500);
  loopEvery(() => { if (L.night) cricket(0.02 + Math.random() * 0.015); }, 400, 1400);
  loopEvery(() => { if (L.near.cafe > 0.05 && Math.random() < 0.5) espressoHiss(0.07 * L.near.cafe); }, 9000, 22000);
  loopEvery(() => { if (L.near.desk > 0.05) keyClicks(0.05 * L.near.desk); }, 1500, 4500);
}
// called a few times per second with the listener (the fly's camera) and what Greg is doing
export function updateAmbience({ pos, R = 26, places = {}, gregAction = "" }) {
  if (!L || !ambOn || !pos) return; const t = ctx.currentTime;
  L.night = !isDay();
  const fromCentre = Math.hypot(pos.x, pos.z), shore = Math.max(0, Math.min(1, 1 - (R - fromCentre) / 14));
  L.ocean.g.gain.setTargetAtTime(0.06 + 0.22 * shore, t, 0.5);
  const alt = Math.max(0, Math.min(1, (pos.y - 1.5) / 10));
  L.wind.g.gain.setTargetAtTime(0.02 + 0.12 * alt + (L.night ? 0.02 : 0), t, 0.6);
  const near = (p, r) => (p ? Math.max(0, 1 - Math.hypot(pos.x - p.x, pos.z - p.z) / r) : 0);
  L.near.cafe = near(places.cafe, 9); L.near.desk = /tweet|trade|browse|board|build_tool/.test(gregAction) ? near(places.desk, 8) : 0; L.near.green = near(places.green, 18);
  L.cafe.g.gain.setTargetAtTime(0.16 * L.near.cafe, t, 0.4);
}
// golf putt "tock" (wood on ball), louder when close
export function tock(dist = 5) { if (!ambOn || !ac()) return; const c = ctx, t = c.currentTime, g = Math.max(0.02, 0.3 * (1 - Math.min(1, dist / 25))); const o = c.createOscillator(), e = c.createGain(), f = c.createBiquadFilter(); o.type = "triangle"; o.frequency.setValueAtTime(1150, t); o.frequency.exponentialRampToValueAtTime(700, t + 0.05); f.type = "bandpass"; f.frequency.value = 1100; f.Q.value = 6; e.gain.setValueAtTime(g, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.09); o.connect(f); f.connect(e); e.connect(B.amb); o.start(t); o.stop(t + 0.1); }
export function cupDrop(dist = 5) { if (!ambOn || !ac()) return; const c = ctx, t = c.currentTime, g = Math.max(0.02, 0.25 * (1 - Math.min(1, dist / 25))); for (let i = 0; i < 3; i++) { const o = c.createOscillator(), e = c.createGain(); o.type = "sine"; o.frequency.value = 1800 - i * 300; const s = t + i * 0.06; e.gain.setValueAtTime(g / (i + 1), s); e.gain.exponentialRampToValueAtTime(0.001, s + 0.08); o.connect(e); e.connect(B.amb); o.start(s); o.stop(s + 0.1); } }

// ---------- lo-fi bed (music bus) ----------
let lofiOn = false, lofiTimer = 0, lofiGain = null;
export function lofi(on) {
  lofiOn = !!on; clearTimeout(lofiTimer); if (!ac()) return;
  if (!lofiGain) { lofiGain = ctx.createGain(); lofiGain.gain.value = 0; lofiGain.connect(B.music); }
  lofiGain.gain.setTargetAtTime(on ? 0.5 : 0, ctx.currentTime, 0.5);
  if (!on) return;
  const chords = [[57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65], [52, 55, 59, 62]]; let bar = 0;
  (function loop() {
    if (!lofiOn) return; const t = ctx.currentTime + 0.05, beat = 60 / 72;
    const ch = chords[bar % 4]; ch.forEach((m) => pad(mtof(m), t, beat * 4, 0.05));
    for (let i = 0; i < 4; i++) { kick(t + i * beat, i % 2 === 0); hat(t + i * beat + beat / 2); }
    bar++; lofiTimer = setTimeout(loop, beat * 4 * 1000);
  })();
}
function pad(f, t, d, v) { const c = ctx; const o = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter(); o.type = "triangle"; o.frequency.value = f; o.detune.value = (Math.random() - 0.5) * 14; lp.type = "lowpass"; lp.frequency.value = 900; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.3); g.gain.linearRampToValueAtTime(0, t + d); o.connect(lp); lp.connect(g); g.connect(lofiGain); o.start(t); o.stop(t + d + 0.1); }
function kick(t, on) { if (!on) return snare(t); const c = ctx; const o = c.createOscillator(), g = c.createGain(); o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.15); g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25); o.connect(g); g.connect(lofiGain); o.start(t); o.stop(t + 0.3); }
function snare(t) { const c = ctx; const s = c.createBufferSource(); s.buffer = noiseBuf(); const f = c.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1500; const g = c.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18); s.connect(f); f.connect(g); g.connect(lofiGain); s.start(t, Math.random()); s.stop(t + 0.2); }
function hat(t) { const c = ctx; const s = c.createBufferSource(); s.buffer = noiseBuf(); const f = c.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 6000; const g = c.createGain(); g.gain.setValueAtTime(0.03, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05); s.connect(f); f.connect(g); g.connect(lofiGain); s.start(t, Math.random()); s.stop(t + 0.06); }

// ---------- Greg's songs (music bus) ----------
let stopSong = null;
export function playSong(song, onEnd) {
  stop(); if (!ac() || !song) return onEnd && onEnd();
  const c = ctx, t0 = c.currentTime + 0.05, beat = 60 / (song.bpm || 100), g = c.createGain(); g.gain.value = 0.5; g.connect(B.music);
  let t = t0; const nodes = [];
  for (const [m, d] of song.lead || []) { if (m) { const o = c.createOscillator(), e = c.createGain(); o.type = song.instrument === "piano" ? "triangle" : song.wave || "square"; o.frequency.value = mtof(m); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.12, t + 0.01); e.gain.exponentialRampToValueAtTime(0.001, t + d * beat * 0.95); o.connect(e); e.connect(g); o.start(t); o.stop(t + d * beat); nodes.push(o); } t += d * beat; }
  let tb = t0; for (const [m, d] of song.bass || []) { const o = c.createOscillator(), e = c.createGain(); o.type = "triangle"; o.frequency.value = mtof(m - 12); e.gain.setValueAtTime(0.1, tb); e.gain.exponentialRampToValueAtTime(0.001, tb + d * beat); o.connect(e); e.connect(g); o.start(tb); o.stop(tb + d * beat); nodes.push(o); tb += d * beat; }
  const end = Math.max(t, tb); const id = setTimeout(() => { stopSong = null; onEnd && onEnd(); }, (end - c.currentTime) * 1000);
  stopSong = () => { clearTimeout(id); nodes.forEach((n) => { try { n.stop(); } catch {} }); g.disconnect(); stopSong = null; onEnd && onEnd(); };
}
export const stop = () => stopSong && stopSong();

// ---------- UI sounds (sfx bus) ----------
export function blip(type = "pop") { if (!ac()) return; const c = ctx, t = c.currentTime; const o = c.createOscillator(), g = c.createGain(); o.type = "sine"; o.frequency.setValueAtTime(type === "pop" ? 600 : 300, t); o.frequency.exponentialRampToValueAtTime(type === "pop" ? 1200 : 900, t + 0.08); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12); o.connect(g); g.connect(B.sfx); o.start(t); o.stop(t + 0.15); }
export function click() { if (!ac()) return; const c = ctx, t = c.currentTime; const o = c.createOscillator(), g = c.createGain(); o.type = "square"; o.frequency.setValueAtTime(1800, t); o.frequency.exponentialRampToValueAtTime(900, t + 0.025); g.gain.setValueAtTime(0.045, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.035); o.connect(g); g.connect(B.sfx); o.start(t); o.stop(t + 0.04); }
export const unlock = () => { gestured = true; return ac(); };
