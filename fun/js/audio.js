// All sound is synthesized live with WebAudio: pond ambience, a lo-fi bed, and Greg's songs.
let ctx = null, master = null, ambGain = null, lofiGain = null, songGain = null;
function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
    ambGain = ctx.createGain(); ambGain.gain.value = 0; ambGain.connect(master);
    lofiGain = ctx.createGain(); lofiGain.gain.value = 0; lofiGain.connect(master);
    songGain = ctx.createGain(); songGain.gain.value = 0.5; songGain.connect(master);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
function noiseBuf(sec = 2) { const c = ac(); const b = c.createBuffer(1, c.sampleRate * sec, c.sampleRate); const d = b.getChannelData(0); let last = 0; for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } return b; }

// ---------- ambience: water + birds + frogs ----------
let ambOn = false, ambTimer = 0;
export function ambient(on) {
  const c = ac(); ambOn = on;
  if (on && !ambient.src) {
    const s = c.createBufferSource(); s.buffer = noiseBuf(3); s.loop = true;
    const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 520;
    const lfo = c.createOscillator(); lfo.frequency.value = 0.12; const lg = c.createGain(); lg.gain.value = 180; lfo.connect(lg); lg.connect(f.frequency); lfo.start();
    const g = c.createGain(); g.gain.value = 0.35; s.connect(f); f.connect(g); g.connect(ambGain); s.start(); ambient.src = s;
  }
  ambGain.gain.setTargetAtTime(on ? 0.5 : 0, c.currentTime, 0.4);
  clearTimeout(ambTimer);
  if (on) (function chirp() { ambTimer = setTimeout(() => { if (!ambOn) return; Math.random() < 0.6 ? bird() : ribbit(); chirp(); }, 2500 + Math.random() * 6000); })();
}
function bird() { const c = ac(), t = c.currentTime; const o = c.createOscillator(), g = c.createGain(); o.type = "sine"; const f0 = 2200 + Math.random() * 1500; o.frequency.setValueAtTime(f0, t); for (let i = 0; i < 3; i++) { o.frequency.linearRampToValueAtTime(f0 * 1.3, t + i * 0.12 + 0.05); o.frequency.linearRampToValueAtTime(f0, t + i * 0.12 + 0.1); } g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05, t + 0.02); g.gain.linearRampToValueAtTime(0, t + 0.4); o.connect(g); g.connect(ambGain); o.start(t); o.stop(t + 0.45); }
function ribbit() { const c = ac(), t = c.currentTime; for (let k = 0; k < 2; k++) { const o = c.createOscillator(), g = c.createGain(), f = c.createBiquadFilter(); o.type = "sawtooth"; o.frequency.value = 120 + Math.random() * 40; f.type = "bandpass"; f.frequency.value = 700; f.Q.value = 4; const s = t + k * 0.22; g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.09, s + 0.02); g.gain.exponentialRampToValueAtTime(0.001, s + 0.16); o.connect(f); f.connect(g); g.connect(ambGain); o.start(s); o.stop(s + 0.2); } }

// ---------- lo-fi bed ----------
let lofiOn = false, lofiTimer = 0;
const CHORDS = [[57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65], [52, 55, 59, 62]];
export function lofi(on) {
  const c = ac(); lofiOn = on;
  lofiGain.gain.setTargetAtTime(on ? 0.32 : 0, c.currentTime, 0.5);
  clearTimeout(lofiTimer);
  if (!on) return;
  if (!lofi.crackle) { const s = c.createBufferSource(); const b = c.createBuffer(1, c.sampleRate * 2, c.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() < 0.0008 ? (Math.random() - 0.5) * 0.6 : (Math.random() - 0.5) * 0.01; s.buffer = b; s.loop = true; s.connect(lofiGain); s.start(); lofi.crackle = s; }
  const bpm = 72, beat = 60 / bpm; let bar = 0;
  const loop = () => {
    if (!lofiOn) return; const t = c.currentTime + 0.05, ch = CHORDS[bar % 4];
    ch.forEach((m, i) => pad(mtof(m), t + i * 0.02, beat * 4, 0.05));
    for (let i = 0; i < 4; i++) { kick(t + i * beat * (i % 2 ? 1 : 1), i % 2 === 0); hat(t + i * beat + beat / 2); }
    bar++; lofiTimer = setTimeout(loop, beat * 4 * 1000 - 30);
  };
  loop();
}
function pad(f, t, d, v) { const c = ac(); const o = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter(); o.type = "triangle"; o.frequency.value = f; o.detune.value = (Math.random() - 0.5) * 14; lp.type = "lowpass"; lp.frequency.value = 900; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.3); g.gain.linearRampToValueAtTime(0, t + d); o.connect(lp); lp.connect(g); g.connect(lofiGain); o.start(t); o.stop(t + d + 0.1); }
function kick(t, on) { if (!on) return snare(t); const c = ac(); const o = c.createOscillator(), g = c.createGain(); o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.15); g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25); o.connect(g); g.connect(lofiGain); o.start(t); o.stop(t + 0.3); }
function snare(t) { const c = ac(); const s = c.createBufferSource(); s.buffer = noiseBuf(0.3); const f = c.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1500; const g = c.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18); s.connect(f); f.connect(g); g.connect(lofiGain); s.start(t); s.stop(t + 0.2); }
function hat(t) { const c = ac(); const s = c.createBufferSource(); s.buffer = noiseBuf(0.1); const f = c.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 6000; const g = c.createGain(); g.gain.setValueAtTime(0.03, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05); s.connect(f); f.connect(g); g.connect(lofiGain); s.start(t); s.stop(t + 0.06); }

// ---------- Greg's songs (JSON written by Greg: {bpm, wave, lead:[[midi,beats]], bass:[[midi,beats]], drums:"x.x.x..."}) ----------
let stopSong = null;
export function playSong(song, onEnd) {
  const c = ac(); if (stopSong) stopSong();
  const bpm = song.bpm || 100, beat = 60 / bpm, t0 = c.currentTime + 0.08; const nodes = []; let end = t0;
  const voice = (list, wave, oct, vol) => { let t = t0; for (const [m, b] of list || []) { if (m != null && m > 0) { const o = c.createOscillator(), g = c.createGain(); o.type = wave; o.frequency.value = mtof(m + oct); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.setTargetAtTime(0, t + b * beat * 0.8, 0.05); o.connect(g); g.connect(songGain); o.start(t); o.stop(t + b * beat + 0.2); nodes.push(o); } t += b * beat; } end = Math.max(end, t); };
  if (song.instrument === "piano") { const pv = (list, oct, vol) => { let t = t0; for (const [m, b] of list || []) { if (m > 0) for (const [h, a] of [[1, 1], [2, 0.35], [3, 0.12]]) { const o = c.createOscillator(), g = c.createGain(); o.type = "sine"; o.frequency.value = mtof(m + oct) * h; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol * a, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0008, t + 1.6); o.connect(g); g.connect(songGain); o.start(t); o.stop(t + 1.7); nodes.push(o); } t += b * beat; } end = Math.max(end, t + 1); }; pv(song.lead, 0, 0.14); pv(song.bass, -12, 0.12); }
  else { voice(song.lead, song.wave || "square", 0, 0.12); voice(song.bass, "triangle", -12, 0.2); }
  if (song.drums) { const steps = song.drums.length, len = end - t0; for (let i = 0; i < Math.floor(len / (beat / 2)); i++) if (song.drums[i % steps] === "x") kick(t0 + i * beat / 2, i % 4 === 0); }
  const timer = setTimeout(() => { stopSong = null; onEnd && onEnd(); }, (end - c.currentTime) * 1000 + 300);
  stopSong = () => { clearTimeout(timer); nodes.forEach((n) => { try { n.stop(); } catch {} }); stopSong = null; onEnd && onEnd(); };
  return stopSong;
}
export const stop = () => stopSong && stopSong();
export function blip(type = "pop") { const c = ac(), t = c.currentTime; const o = c.createOscillator(), g = c.createGain(); o.type = "sine"; o.frequency.setValueAtTime(type === "pop" ? 600 : 300, t); o.frequency.exponentialRampToValueAtTime(type === "pop" ? 1200 : 900, t + 0.08); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12); o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.15); }
export const unlock = () => ac();
