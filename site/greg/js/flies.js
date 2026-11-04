// Visitor flies on Freg Island. Every visitor is a fly. Default controls: WASD + mouse look (pointer lock),
// Space/Ctrl up/down, Shift boost. C perches on ANY surface (walls, ceilings, cups, Greg) and WASD then walks along it.
// Optional "wing skill" mode keeps the QWOP-style left/right wing flapping. Collisions are real swept-sphere
// physics against the island's triangle meshes (see physics.js).
// Multiplayer: Supabase Realtime rooms "greg-flies-N" (<= 30 flies each), compact array payloads at 10 Hz while
// moving and 1 Hz when still, 100 ms snapshot interpolation, remote flies drawn with instancing.
import { sb } from "./data.js";
import { createFPView } from "./fpview.js";

const ROOM_CAP = 30, SEND_HZ = 10, INTERP_MS = 100;
export const ST = { hover: 0, cruise: 1, dart: 2, boost: 3, perch: 4, takeoff: 5, tumble: 6, dead: 7, walk: 8 };
const F_PAID = 1, F_GOLD = 2, F_DEAD = 4, F_SHIELD = 8, F_LEGL = 16, F_LEGR = 32, F_WINGL = 64, F_WINGR = 128, F_RUB = 256;

export function startFlies(world, { input, hud, save, onCount, onRent, onUnpaidNear, onRubNear, onInspect, isSoundOn, toast } = {}) {
  const THREE = world.THREE, scene = world.scene, camera = world.camera, controls = world.controls, phys = world.phys;
  const RAD = 0.025, FS = 0.55, R = world.R + 9; // collider radius and visual scale: the fly is tiny next to Greg
  let me; try { me = JSON.parse(localStorage.getItem("greg_fly") || "null"); } catch {}
  if (!me) { me = { id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()), name: "Fly #" + (100 + Math.floor(Math.random() * 900)), hue: Math.floor(Math.random() * 360) }; try { localStorage.setItem("greg_fly", JSON.stringify(me)); } catch {} }
  const sid = me.id.replace(/-/g, "").slice(0, 10);
  const settings = save.get("settings", { skill: false, reduceMotion: false, levelHorizon: false, sens: 1, view: 1 });

  // ---------- instanced fly bodies (slot 0 = me in 3rd person, others after) ----------
  const MAXF = 64;
  const stripe = (() => { const c = document.createElement("canvas"); c.width = c.height = 64; const x = c.getContext("2d"); x.fillStyle = "#8a8e94"; x.fillRect(0, 0, 64, 64); x.fillStyle = "#1a1b20"; for (let i = 0; i < 4; i++) x.fillRect(8 + i * 14, 0, 6, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const mk = (geo, mat, per) => { const m = new THREE.InstancedMesh(geo, mat, MAXF * per); m.count = 0; m.frustumCulled = false; m.userData.noCollide = true; scene.add(m); return m; };
  const wingTex = (() => { const c = document.createElement("canvas"); c.width = 128; c.height = 64; const x = c.getContext("2d"); x.fillStyle = "rgba(215,235,255,.55)"; x.beginPath(); x.ellipse(64, 32, 62, 26, 0, 0, 7); x.fill(); x.strokeStyle = "rgba(30,30,40,.6)"; x.lineWidth = 1.5; for (let i = 0; i < 5; i++) { x.beginPath(); x.moveTo(4, 32); x.quadraticCurveTo(60, 8 + i * 12, 124, 10 + i * 11); x.stroke(); } const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const discTex = (() => { const c = document.createElement("canvas"); c.width = c.height = 64; const x = c.getContext("2d"); const g = x.createRadialGradient(32, 32, 4, 32, 32, 31); g.addColorStop(0, "rgba(230,240,255,.0)"); g.addColorStop(0.6, "rgba(230,240,255,.35)"); g.addColorStop(1, "rgba(230,240,255,0)"); x.fillStyle = g; x.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); return t; })();
  const parts = {
    thorax: mk(new THREE.SphereGeometry(0.028, 10, 8), new THREE.MeshBasicMaterial({ map: stripe }), 1),
    abd: mk(new THREE.SphereGeometry(0.03, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), 1),
    head: mk(new THREE.SphereGeometry(0.019, 8, 6), new THREE.MeshBasicMaterial({ color: 0x2a2b30 }), 1),
    eyes: mk(new THREE.SphereGeometry(0.0145, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), 2),
    wings: mk(new THREE.PlaneGeometry(0.075, 0.03).translate(0.0375, 0, 0), new THREE.MeshBasicMaterial({ map: wingTex, transparent: true, side: THREE.DoubleSide, depthWrite: false }), 2),
    disc: mk(new THREE.CircleGeometry(0.06, 16), new THREE.MeshBasicMaterial({ map: discTex, transparent: true, side: THREE.DoubleSide, depthWrite: false }), 2),
    legs: mk(new THREE.CylinderGeometry(0.0022, 0.0018, 0.05, 4).translate(0, -0.025, 0), new THREE.MeshBasicMaterial({ color: 0x15161a }), 6),
    coin: mk(new THREE.CylinderGeometry(0.018, 0.018, 0.005, 10), new THREE.MeshBasicMaterial({ color: 0xffd23f }), 1),
    shield: mk(new THREE.SphereGeometry(0.1, 16, 10), new THREE.MeshBasicMaterial({ color: 0x9cff6b, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending }), 1),
  };
  const ob = new THREE.Object3D(), M0 = new THREE.Matrix4(), M1 = new THREE.Matrix4(), Q = new THREE.Quaternion(), Qa = new THREE.Quaternion(), E = new THREE.Euler(), V = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), S1 = new THREE.Vector3(FS, FS, FS);
  const tintC = new THREE.Color(), eyeRed = new THREE.Color(0xc0392b), eyeDead = new THREE.Color(0x141218);
  const put = (mesh, idx, local) => { M1.multiplyMatrices(M0, local); mesh.setMatrixAt(idx, M1); };
  const L = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => { ob.position.set(x, y, z); ob.rotation.set(rx, ry, rz); ob.scale.set(sx, sy, sz); ob.updateMatrix(); return ob.matrix; };
  // one animation for everyone: hover/cruise/dart/boost/perch/walk/takeoff/tumble/dead, rub, legs and wing pulses
  function drawFly(slot, F, t) {
    const sp = F.speed || 0, dead = F.state === ST.dead, perched = F.state === ST.perch || F.state === ST.walk;
    Qa.setFromUnitVectors(Y, F.up || Y);
    E.set(perched ? 0 : Math.min(0.5, sp * 0.07) + (F.anim?.pitchK || 0), F.yaw, perched ? 0 : (F.anim?.bank || 0), "YXZ"); Q.setFromEuler(E);
    if (dead) Q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(t * 9, 0, t * 14)));
    Qa.multiply(Q);
    const hov = perched || dead ? 0 : Math.sin(t * 3.1 + slot) * 0.006 + Math.sin(t * 7.7 + slot * 2) * 0.002;
    V.copy(F.pos); V.y += hov; if (!perched) V.x += Math.sin(t * 5.3 + slot) * 0.002;
    M0.compose(V, Qa, S1);
    tintC.setHSL((F.hue || 0) / 360, 0.3, 0.6);
    put(parts.thorax, slot, L(0, 0, 0, 0, 0, 0, 1, 0.9, 1.1)); parts.thorax.setColorAt(slot, tintC);
    put(parts.abd, slot, L(0, -0.004, -0.045, 0.15, 0, 0, 0.9, 0.75, 1.35)); parts.abd.setColorAt(slot, tintC.clone().multiplyScalar(0.5));
    put(parts.head, slot, L(0, 0.004, 0.035));
    for (const s of [-1, 1]) { const k = slot * 2 + (s > 0 ? 1 : 0); put(parts.eyes, k, L(s * 0.012, 0.008, 0.043)); parts.eyes.setColorAt(k, dead ? eyeDead : eyeRed); }
    const flapK = perched ? 0 : 1, f = t * 58 + slot;
    for (const s of [-1, 1]) {
      const k = slot * 2 + (s > 0 ? 1 : 0), pulse = (s < 0 ? F.wingL : F.wingR) ? 0.5 : 0;
      const a = perched || dead ? 0.15 : Math.sin(f) * (0.75 + pulse), b = perched ? 0 : Math.sin(f * 2) * 0.22; // figure-8 hint
      put(parts.wings, k, L(s * 0.012, 0.022, -0.008, -Math.PI / 2 + b, s < 0 ? Math.PI : 0, s * (perched ? -0.05 : 0.25 + a), 1, 1, 1));
      put(parts.disc, k, L(s * 0.05, 0.024, -0.01, -Math.PI / 2, 0, 0, flapK, flapK, flapK * 0.7));
    }
    for (let i = 0; i < 6; i++) {
      const s = i % 2 ? 1 : -1, row = Math.floor(i / 2), k = slot * 6 + i;
      let rx = perched ? 0.15 : 0.6 + Math.min(0.6, sp * 0.1), rz = s * (perched ? 0.9 : 0.35);
      if (F.state === ST.walk) rx += Math.sin(t * 14 + (row + (s > 0 ? 1 : 0)) * Math.PI) * 0.35; // tripod gait
      if (row === 0 && F.rub) { rx = -0.9; rz = s * 0.15 + Math.sin(t * 44) * 0.2 * s; }
      if (row === 0 && ((s < 0 && F.legL) || (s > 0 && F.legR))) { rx = -1.3; rz = s * 0.2; }
      if (row === 0 && F.emote === "wave" && s > 0) { rx = -1.6; rz = 0.4 + Math.sin(t * 16) * 0.5; }
      put(parts.legs, k, L(s * 0.012, -0.014, 0.022 - row * 0.02, rx, 0, rz));
    }
    const coinOn = F.paid ? 1 : 0; put(parts.coin, slot, L(0, 0.06, 0, Math.PI / 2, 0, t * 3, coinOn, coinOn, coinOn)); parts.coin.setColorAt(slot, F.gold ? new THREE.Color(0xffa000) : new THREE.Color(0xffd23f));
    const sh = F.shield ? 1 + Math.sin(t * 6) * 0.04 : 0; put(parts.shield, slot, L(0, 0, 0, 0, 0, 0, sh, sh, sh));
  }
  function commitParts(n) { for (const m of Object.values(parts)) { const per = m.count === 0 && m.instanceMatrix.count / MAXF; m.count = n * (m === parts.eyes || m === parts.wings || m === parts.disc ? 2 : m === parts.legs ? 6 : 1); m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; } }
  // name tags for nearby flies only
  const tagPool = [];
  function tag(i, name, pos, show) {
    let s = tagPool[i];
    if (!s) { const cv = document.createElement("canvas"); cv.width = 256; cv.height = 64; s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false })); s.userData.cv = cv; s.scale.set(0.42, 0.105, 1); scene.add(s); tagPool[i] = s; }
    if (s.userData.name !== name) { const x = s.userData.cv.getContext("2d"); x.clearRect(0, 0, 256, 64); x.fillStyle = "rgba(255,255,255,.9)"; x.fillRect(0, 10, 256, 44); x.fillStyle = "#141218"; x.font = "800 28px system-ui"; x.textAlign = "center"; x.fillText(String(name || "Fly").slice(0, 16), 128, 42); s.material.map.needsUpdate = true; s.userData.name = name; }
    s.visible = show; if (show) s.position.set(pos.x, pos.y + 0.08, pos.z);
  }

  // ---------- first-person body ----------
  if (!camera.parent) scene.add(camera);
  const fp = createFPView(THREE, camera);

  // ---------- audio: buzz (pitch follows throttle), wind (speed), rub scratch, flaps, bonk, pop ----------
  let ac = null, buzz = null, wind = null, rubG = null, noiseBuf = null; const remoteVoices = [];
  const soundOn = () => !isSoundOn || isSoundOn();
  let gestured = false; for (const ev of ["pointerdown", "keydown", "touchstart"]) addEventListener(ev, () => (gestured = true), { once: true, capture: true });
  function audio() {
    if (ac) return ac; if (!gestured) return null; // browsers only allow audio after the first tap or key
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const master = ac.createGain(); master.gain.value = 1; master.connect(ac.destination); ac.master = master;
      // housefly buzz: ~190 Hz wingbeat (sawtooth + detuned square for harmonics), body resonance band, fast amplitude flutter
      const o1 = ac.createOscillator(), o2 = ac.createOscillator(); o1.type = "sawtooth"; o2.type = "square"; o1.frequency.value = 190; o2.frequency.value = 191.3;
      const o2g = ac.createGain(); o2g.gain.value = 0.35;
      const body = ac.createBiquadFilter(); body.type = "peaking"; body.frequency.value = 1150; body.Q.value = 1.4; body.gain.value = 9;
      const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2600;
      const flutter = ac.createGain(); flutter.gain.value = 0.75; const lfo = ac.createOscillator(); lfo.frequency.value = 23; const lfoG = ac.createGain(); lfoG.gain.value = 0.25; lfo.connect(lfoG); lfoG.connect(flutter.gain);
      const vib = ac.createOscillator(); vib.frequency.value = 5.3; const vibG = ac.createGain(); vibG.gain.value = 4; vib.connect(vibG); vibG.connect(o1.frequency); vibG.connect(o2.frequency);
      const g = ac.createGain(); g.gain.value = 0;
      o1.connect(body); o2.connect(o2g); o2g.connect(body); body.connect(lp); lp.connect(flutter); flutter.connect(g); g.connect(master); o1.start(); o2.start(); lfo.start(); vib.start(); buzz = { o1, o2, g, lfo };
      const n = ac.createBufferSource(); n.buffer = noiseBuf; n.loop = true; const wl = ac.createBiquadFilter(); wl.type = "lowpass"; wl.frequency.value = 500; const wg = ac.createGain(); wg.gain.value = 0; n.connect(wl); wl.connect(wg); wg.connect(master); n.start(); wind = { g: wg, f: wl };
      const rn = ac.createBufferSource(); rn.buffer = noiseBuf; rn.loop = true; const bp = ac.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 2200; bp.Q.value = 0.9; const rg = ac.createGain(); rg.gain.value = 0; rn.connect(bp); bp.connect(rg); rg.connect(master); rn.start(); rubG = rg;
      for (let i = 0; i < 2; i++) { const o = ac.createOscillator(); o.type = "sawtooth"; o.frequency.value = 215 + i * 9; const f = ac.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 800; const gg = ac.createGain(); gg.gain.value = 0; const p = ac.createPanner(); p.panningModel = "HRTF"; p.distanceModel = "inverse"; p.refDistance = 0.3; p.rolloffFactor = 1.6; o.connect(f); f.connect(gg); gg.connect(p); p.connect(master); o.start(); remoteVoices.push({ o, g: gg, p }); }
    } catch { ac = null; }
    return ac;
  }
  addEventListener("pointerdown", () => { audio(); ac?.resume?.(); }, { once: false });
  function blip(kind) {
    if (!soundOn() || !audio()) return; const t = ac.currentTime;
    if (kind === "flap" || kind === "flapL" || kind === "flapR") { const s = ac.createBufferSource(); s.buffer = noiseBuf; const f = ac.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 2400 + Math.random() * 2000; f.Q.value = 1.2; const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.008); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08); const p = ac.createStereoPanner ? ac.createStereoPanner() : null; if (p) p.pan.value = kind === "flapL" ? -0.7 : kind === "flapR" ? 0.7 : 0; s.connect(f); f.connect(g); (p ? (g.connect(p), p) : g).connect(ac.master); s.start(t, Math.random()); s.stop(t + 0.1); return; }
    const o = ac.createOscillator(), g = ac.createGain(); o.connect(g); g.connect(ac.master);
    const env = (a, d) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(a, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + d); o.start(t); o.stop(t + d + 0.02); };
    if (kind === "bonk") { o.type = "sine"; o.frequency.setValueAtTime(520, t); o.frequency.exponentialRampToValueAtTime(180, t + 0.12); env(0.18, 0.14); }
    else if (kind === "pop") { o.type = "triangle"; o.frequency.setValueAtTime(300, t); o.frequency.exponentialRampToValueAtTime(1200, t + 0.12); env(0.12, 0.16); }
    else if (kind === "tell") { o.type = "sine"; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.18); env(0.16, 0.2); }
    else if (kind === "tap") { o.type = "square"; o.frequency.value = 1400; env(0.03, 0.03); }
    else if (kind === "chime") { o.type = "sine"; o.frequency.setValueAtTime(880, t); o.frequency.setValueAtTime(1320, t + 0.09); env(0.12, 0.4); }
    else if (kind === "hiss") { o.disconnect(); const s = ac.createBufferSource(); s.buffer = noiseBuf; const f = ac.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 3000; s.connect(f); f.connect(g); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.1, t + 0.05); g.gain.exponentialRampToValueAtTime(0.001, t + 1.1); s.start(t); s.stop(t + 1.2); }
  }

  // ---------- state ----------
  const st = {
    pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: Math.PI, pitch: -0.1, mode: "fly", up: new THREE.Vector3(0, 1, 0), camUp: new THREE.Vector3(0, 1, 0),
    dead: 0, shield: 0, perchOn: null, perchLocal: null, perchNLocal: null, takeoffCD: 0, landing: 0, walkPhase: 0, bank: 0, yawRate: 0, lastYaw: Math.PI,
    rubbing: false, legL: { active: false, x: 0, y: 0 }, legR: { active: false, x: 0, y: 0 }, wingL: 0, wingR: 0, dartCD: 0, caffeine: 0, roll: 0, rollRate: 0, tumble: 0, emote: null, emoteUntil: 0, brakeK: 0,
  };
  let pov = true, third = settings.view === 3;
  function spawnAtNest(announce = true) {
    const pts = world.nestSpawns(); const p = pts[Math.floor(Math.random() * pts.length)];
    st.pos.copy(p); for (let k = 0; k < 10 && phys.nearest(st.pos, RAD * 2); k++) st.pos.y += 0.15; st.vel.set(0, 0, 0); st.mode = "fly"; st.up.set(0, 1, 0); st.perchOn = null; st.shield = 2; st.roll = 0; st.tumble = 0;
    // face away from the pot, toward the plaza (camera yaw: forward is (-sin yaw, -cos yaw))
    const c = world.nestCenter(); const dx = p.x - c.x, dz = p.z - c.z; st.yaw = Math.atan2(-dx, -dz); st.pitch = -0.12; st.lastYaw = st.yaw; st.camRoll = 0; qCam.setFromEuler(new THREE.Euler(st.pitch, st.yaw, 0, "YXZ"));
    burst(p, 0x9cff6b); blip("pop"); if (announce) send("spawn", { i: sid });
  }
  // particles: spawn pops, bump sparks, steam
  const puffs = []; const puffGeo = new THREE.SphereGeometry(0.015, 6, 4);
  function burst(at, color, n = 14, speed = 0.8, life = 0.6, size = 1) { for (let i = 0; i < n; i++) { const m = new THREE.Mesh(puffGeo, new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false })); m.userData.noCollide = true; m.position.copy(at); m.scale.setScalar(size); m.userData.v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.5 + Math.random())); m.userData.life = life; m.userData.max = life; scene.add(m); puffs.push(m); } }
  function stepPuffs(dt) { for (let i = puffs.length - 1; i >= 0; i--) { const m = puffs[i]; m.userData.life -= dt; m.position.addScaledVector(m.userData.v, dt); m.userData.v.multiplyScalar(Math.pow(0.2, dt)); m.material.opacity = m.userData.life / m.userData.max; if (m.userData.rise) m.userData.v.y += dt * 0.6; if (m.userData.life <= 0) { scene.remove(m); m.material.dispose(); puffs.splice(i, 1); } } }

  // ---------- input ----------
  const held = (a) => input.held(a);
  input.setContext(() => (hud.mapOpen() ? "map" : st.mode === "perch" ? "perched" : "fly"));
  const dirOf = (a) => ({ forward: [0, 1], back: [0, -1], left: [-1, 0], right: [1, 0] }[a]);
  const lastTap = {};
  for (const a of ["left", "right"]) input.on(a, () => { const now = performance.now(); if (now - (lastTap[a] || 0) < 260 && st.mode === "fly" && (st.rollCD || 0) <= 0) { st.vel.addScaledVector(camRight(), a === "left" ? -4.2 : 4.2); st.iframe = 0.4; st.rollCD = 0.9; st.rollSpin = a === "left" ? 1 : -1; blip("flapL"); blip("flapR"); } lastTap[a] = now; });
  for (const a of ["forward", "back", "left", "right"]) input.on(a, () => { if (st.mode !== "fly" || st.dartCD > 0 || settings.skill) return; const sp = st.vel.length(); if (sp > 2.2) return; const [x, z] = dirOf(a); const f = camFwd(), r = camRight(); st.vel.addScaledVector(f, z * 2.0).addScaledVector(r, x * 2.0); st.dartCD = 0.28; st.dartT = 0.18; });
  input.on("perch", () => { if (st.mode === "perch") takeoff(); else tryPerch(true); });
  input.on("takeoff", () => takeoff());
  input.on("up", () => { if (st.mode === "perch") takeoff(); });
  input.on("rub", () => { st.rubbing = true; hud.done("rub"); });
  input.on("rub:up", () => (st.rubbing = false));
  input.on("view", () => { if (!pov) setPov(true); third = !third; settings.view = third ? 3 : 1; save.set("settings", settings); });
  input.on("interact", () => interact());
  for (const [a, side] of [["wingL", -1], ["wingR", 1], ["mouseL", -1], ["mouseR", 1]]) input.on(a, () => { if (a.startsWith("mouse") && !settings.skill) return; flap(side); });
  input.on("legL", () => (st.legL.active = true)); input.on("legL:up", () => { st.legL.active = false; st.legL.x = st.legL.y = 0; });
  input.on("legR", () => (st.legR.active = true)); input.on("legR:up", () => { st.legR.active = false; st.legR.x = st.legR.y = 0; });
  ["emote1", "emote2", "emote3", "emote4"].forEach((a, i) => input.on(a, () => emote(["wave", "rub", "spin", "buzz"][i])));
  input.on("lock", () => hud.done("click"));

  function flap(side) {
    if (st.dead > 0 || !pov) return; blip(side < 0 ? "flapL" : "flapR"); if (side < 0) st.wingL = 0.25; else st.wingR = 0.25;
    if (st.mode === "perch") { takeoff(); return; }
    if (settings.skill) { if (st.tumble > 0) { st.rollRate *= 0.6; return; } st.vel.y += 1.15; st.vel.addScaledVector(flatFwd(), 0.55); st.rollRate += side * 1.9; st.yaw -= side * 0.12; }
    else { st.vel.addScaledVector(camRight(), side * 1.2); st.vel.y += 0.5; st.bank += side * 0.25; }
  }
  function emote(e) { st.emote = e; st.emoteUntil = performance.now() + 1800; send("emote", { i: sid, e }); if (e === "rub") { st.rubbing = true; setTimeout(() => (st.rubbing = held("rub")), 1500); } if (e === "buzz") blip("bonk"); }

  const qCam = new THREE.Quaternion(), qWant = new THREE.Quaternion(), qAl = new THREE.Quaternion(), qYaw = new THREE.Quaternion(), qPitch = new THREE.Quaternion(), qRoll = new THREE.Quaternion(), XA = new THREE.Vector3(1, 0, 0), ZA = new THREE.Vector3(0, 0, 1);
  const camFwd = () => new THREE.Vector3(0, 0, -1).applyQuaternion(qWant);
  const camRight = () => new THREE.Vector3(1, 0, 0).applyQuaternion(qWant);
  const flatFwd = () => new THREE.Vector3(-Math.sin(st.yaw), 0, -Math.cos(st.yaw));

  // ---------- perch / land on any surface ----------
  function tryPerch(manual) {
    if (st.dead > 0 || st.takeoffCD > 0) return false;
    let hit = phys.raycast(st.pos, camFwd(), 0.5);
    if (!hit) { const n = phys.nearest(st.pos, 0.35); if (n) hit = { point: n.point, normal: n.normal, owner: n.owner, cap: n.cap }; }
    if (!hit) { if (manual) toast && toast("Nothing to land on here. Fly closer."); return false; }
    perchAt(hit.point, hit.normal, hit.cap); return true;
  }
  function perchAt(point, normal, cap) {
    st.mode = "perch"; st.vel.set(0, 0, 0); st.up.copy(normal); st.pos.copy(point).addScaledVector(normal, RAD); st.landing = 1; st.perchOn = cap ? "greg" : null;
    if (cap) { const g = cap.obj || world.greg; st.perchObj = g; g.updateMatrixWorld(); st.perchLocal = g.worldToLocal(st.pos.clone()); st.perchNLocal = normal.clone().applyQuaternion(g.getWorldQuaternion(new THREE.Quaternion()).invert()); }
    blip("tap"); setTimeout(() => blip("tap"), 70); hud.done("perch"); if (perchAt.impact != null && perchAt.impact < 0.6) hud.trick && hud.trick("Soft landing +10"); perchAt.impact = null;
  }
  function takeoff() {
    if (st.mode !== "perch") return; st.mode = "fly"; st.perchOn = null; st.takeoffCD = 0.45;
    st.vel.copy(st.up).multiplyScalar(2.0).addScaledVector(camFwd(), 0.6); st.pos.addScaledVector(st.up, 0.01);
    st.wingL = st.wingR = 0.3; blip("flapL"); blip("flapR"); burst(st.pos, 0xdff3ff, 6, 0.4, 0.3, 0.6);
  }

  // ---------- interactions (data-driven) ----------
  const ents = [];
  const add = (e) => ents.push(e);
  for (const it of world.interactables) add({ ...it, pos: () => it.obj.getWorldPosition(new THREE.Vector3()) });
  add({ id: "greg", r: 1.6, prompt: "Wave at Greg", kind: "wave", pos: () => world.gregPos().clone().setY(world.gregHeadY() - 0.6) });
  add({ id: "nest_sign", r: 1.0, prompt: "Read the nest sign", kind: "sign", pos: () => world.nest.userData.sign.getWorldPosition(new THREE.Vector3()) });
  add({ id: "golf_ball", r: 0.6, prompt: "Push the golf ball", kind: "ball", pos: () => world.phys.bodies[0]?.mesh.position.clone() || new THREE.Vector3(0, -99, 0) });
  let focus = null;
  function pickFocus() {
    if (!pov || st.dead > 0) return null; const f = camFwd(); let best = null, bs = 0;
    for (const e of ents) { const p = e.pos(); const d = p.distanceTo(st.pos); if (d > e.r) continue; const dir = p.clone().sub(st.pos).normalize(); const dot = d < 0.35 ? 1 : dir.dot(f); if (dot < 0.8) continue; const sc = dot / (0.3 + d); if (sc > bs) { bs = sc; best = e; } }
    for (const [id, o] of others) { const d = o.F.pos.distanceTo(st.pos); if (d < 0.6 && !o.F.dead) { const dot = o.F.pos.clone().sub(st.pos).normalize().dot(f); if (dot > 0.8) return { id: "fly:" + id, prompt: `Bump ${o.name}`, kind: "bumpfly", target: id }; } }
    return best;
  }
  const steamMats = [];
  function interact() {
    const e = focus; if (!e) return; hud.done("interact");
    const first = save.discover(e.id);
    if (e.kind === "steam") { const p = world.espresso.userData.machine.localToWorld(new THREE.Vector3(0.4, 0.05, 0.3)); for (let i = 0; i < 18; i++) setTimeout(() => { burst(p, 0xffffff, 2, 0.25, 1.3, 2.4); puffs.slice(-2).forEach((m) => (m.userData.rise = true)); }, i * 40); blip("hiss"); toast && toast(first ? "Psssshhh! Discovery: the steam wand" : "Psssshhh!"); }
    else if (e.kind === "sniff") toast && toast("Butter, sugar and ambition. 10/10.");
    else if (e.kind === "tip") { const n = save.count("tips"); blip("chime"); toast && toast(`Crumb tipped. You've tipped ${n} crumb${n === 1 ? "" : "s"}.`); }
    else if (e.kind === "menu") onInspect && onInspect("Espresso menu", `<p style="font-weight:800">Espresso · 2 crumbs<br>Flat white · 3<br>Fly-ccino · 4<br>Golden-hour latte · 4<br>Croissant · 3<br>Lily-pad tart · 3</p><p class="muted">Prices in crumbs. Crumbs are pretend. Coffee is real (to frogs).</p>`);
    else if (e.kind === "bulb") { const b = e.obj; b.userData.swing = 1.4; blip("tap"); }
    else if (e.kind === "coffee") { st.caffeine = 15; toast && toast("Caffeinated! Wings at 140% for 15 s."); blip("chime"); }
    else if (e.kind === "diary") { sb.from("greg_journal").select("title,body,created_at,mood").order("created_at", { ascending: false }).limit(1).then(({ data }) => { const j = data?.[0]; const esc2 = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); onInspect && onInspect("Greg's diary", j ? `<p class="muted">${new Date(j.created_at).toLocaleString()}${j.mood ? " · " + esc2(j.mood) : ""}</p><h3>${esc2(j.title)}</h3><p style="white-space:pre-wrap;font-weight:700">${esc2(j.body)}</p><p><a class="btn alt" href="/journal/">Read all entries</a></p>` : `<p style="font-weight:700">The pages are still blank. Greg writes here once or twice a day.</p>`); }); }
    else if (e.kind === "screen") { const sc = world.hq.userData.screens[e.screen]; onInspect && onInspect({ charts: "Charts and portfolio", tweets: "Greg's posts", pump: "pump.fun feed", nfts: "Greg's NFTs" }[e.screen], `<img src="${sc.cv.toDataURL()}" alt="" style="width:100%;border:3px solid #141218;border-radius:10px;background:#0d1322">`); }
    else if (e.kind === "wave") emote("wave");
    else if (e.kind === "sign") onInspect && onInspect("The Fly Nest", hud.controlsHtml());
    else if (e.kind === "ball") { const b = world.phys.bodies[0]; if (b) { b.vel.addScaledVector(camFwd().setY(0).normalize(), 1.6); b.sleep = 0; blip("tap"); } }
    else if (e.kind === "bumpfly") bumpFly(e.target, true);
    if (first) hud.discovery(save.discoveries());
  }
  world.onFrame((dt) => { for (const it of world.interactables) if (it.kind === "bulb" && it.obj.userData.swing) { it.obj.userData.swing *= Math.pow(0.4, dt); it.obj.position.x += Math.sin(performance.now() / 160) * it.obj.userData.swing * 0.002; } });

  // ---------- multiplayer ----------
  const others = new Map(); let room = Number(sessionStorage.getItem("greg_fly_room") || 1), ch = null, joinTs = Date.now();
  function send(event, payload) { try { ch && ch.send({ type: "broadcast", event, payload }); } catch {} }
  function join(n) {
    if (ch) { try { sb.removeChannel(ch); } catch {} }
    room = n; try { sessionStorage.setItem("greg_fly_room", String(n)); } catch {}
    ch = sb.channel("greg-flies-" + n, { config: { broadcast: { self: false, ack: false }, presence: { key: sid } } });
    ch.on("broadcast", { event: "p" }, ({ payload: p }) => onP(p));
    ch.on("broadcast", { event: "swat" }, ({ payload }) => onSwat(payload));
    ch.on("broadcast", { event: "bump" }, ({ payload }) => onBump(payload));
    ch.on("broadcast", { event: "emote" }, ({ payload }) => { const o = others.get(payload?.i); if (o) { o.emote = payload.e; o.emoteUntil = performance.now() + 1800; } });
    ch.on("broadcast", { event: "splat" }, () => countSplat());
    ch.on("broadcast", { event: "spawn" }, ({ payload }) => { const o = others.get(payload?.i); if (o) burst(o.F.pos, 0x9cff6b); });
    ch.on("presence", { event: "sync" }, () => {
      const s = ch.presenceState(), ids = Object.keys(s); onCount && onCount(ids.length); world.setNest(ids.length || 1);
      for (const [id, o] of others) { const pr = s[id]?.[0]; if (!pr) drop(id); else { o.name = pr.n || o.name; o.hue = pr.h ?? o.hue; } }
      for (const id of ids) { const pr = s[id][0]; if (id !== sid && others.has(id)) { others.get(id).name = pr.n; others.get(id).hue = pr.h; } }
      // room sharding: if this room is over capacity and I joined late, hop to the next room
      const order = ids.map((id) => [id, s[id][0]?.ts || 0]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
      if (ids.length > ROOM_CAP && order.indexOf(sid) >= ROOM_CAP) join(room + 1);
    });
    ch.on("presence", { event: "leave" }, ({ key }) => drop(key));
    ch.subscribe((s) => { if (s === "SUBSCRIBED") ch.track({ n: me.name, h: me.hue, ts: joinTs }); if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") setTimeout(() => join(room), 3000); });
  }
  join(room);
  function onP(p) {
    if (!p || p.i === sid || !Array.isArray(p.a)) return;
    let o = others.get(p.i);
    if (!o) { if (others.size >= MAXF - 1) return; o = { id: p.i, name: "Fly", hue: 0, snaps: [], F: { pos: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), yaw: 0, speed: 0, anim: { bank: 0 } } }; others.set(p.i, o); const pr = ch.presenceState()[p.i]?.[0]; if (pr) { o.name = pr.n; o.hue = pr.h; } }
    o.snaps.push({ t: performance.now(), a: p.a }); if (o.snaps.length > 8) o.snaps.shift(); o.seen = performance.now();
  }
  function drop(id) { others.delete(id); }
  const sampleRemote = (o, now) => {
    const tt = now - INTERP_MS, sn = o.snaps; if (!sn.length) return;
    let a = sn[0], b = sn[sn.length - 1];
    for (let i = 0; i < sn.length - 1; i++) if (sn[i].t <= tt && sn[i + 1].t >= tt) { a = sn[i]; b = sn[i + 1]; break; }
    let k = b.t > a.t ? (tt - a.t) / (b.t - a.t) : 1; k = Math.max(0, Math.min(1.2, k)); // short extrapolation
    const A = a.a, B = b.a, lerp = (i) => (A[i] + (B[i] - A[i]) * k) / 100;
    const F = o.F, px = F.pos.x, pz = F.pos.z;
    F.pos.set(lerp(0), lerp(1), lerp(2)); let dy = B[3] - A[3]; dy = Math.atan2(Math.sin(dy / 100), Math.cos(dy / 100)) * 100; F.yaw = (A[3] + dy * Math.min(1, k)) / 100 + Math.PI;
    F.state = B[6]; const fl = B[7]; F.paid = !!(fl & F_PAID); F.gold = !!(fl & F_GOLD); F.dead = !!(fl & F_DEAD); F.shield = !!(fl & F_SHIELD); F.legL = !!(fl & F_LEGL); F.legR = !!(fl & F_LEGR); F.wingL = !!(fl & F_WINGL); F.wingR = !!(fl & F_WINGR); F.rub = !!(fl & F_RUB);
    if (B.length > 10) F.up.set(B[8], B[9], B[10]).normalize(); else F.up.set(0, 1, 0);
    o.vel = o.vel || new THREE.Vector3(); if (b.t > a.t) o.vel.set((B[0] - A[0]) / 100, (B[1] - A[1]) / 100, (B[2] - A[2]) / 100).divideScalar((b.t - a.t) / 1000);
    F.speed = B[5] / 100; F.hue = o.hue; F.anim.bank += ((B[4] / 100) - F.anim.bank) * 0.2; F.emote = performance.now() < (o.emoteUntil || 0) ? o.emote : null;
  };
  let lastSendT = 0, lastKey = "", lastBeat = 0;
  function sendState(now) {
    const moving = st.vel.lengthSq() > 0.0004 || st.rubbing || st.legL.active || st.legR.active;
    if (now - lastSendT < 1000 / SEND_HZ) return;
    const flags = (paid() ? F_PAID : 0) | (gold() ? F_GOLD : 0) | (st.dead > 0 ? F_DEAD : 0) | (st.shield > 0 ? F_SHIELD : 0) | (st.legL.active ? F_LEGL : 0) | (st.legR.active ? F_LEGR : 0) | (st.wingL > 0 ? F_WINGL : 0) | (st.wingR > 0 ? F_WINGR : 0) | (st.rubbing ? F_RUB : 0);
    const a = [Math.round(st.pos.x * 100), Math.round(st.pos.y * 100), Math.round(st.pos.z * 100), Math.round(st.yaw * 100), Math.round(st.bank * 100), Math.round(st.vel.length() * 100), stateCode(), flags];
    if (st.mode === "perch") a.push(Math.round(st.up.x * 100), Math.round(st.up.y * 100), Math.round(st.up.z * 100));
    const k = a.join(",");
    if (k === lastKey && now - lastBeat < 1000) return; if (!moving && k !== lastKey && now - lastSendT < 400) return;
    lastKey = k; lastSendT = now; lastBeat = now; send("p", { i: sid, a });
  }
  function stateCode() { if (st.dead > 0) return ST.dead; if (st.mode === "perch") return st.walking ? ST.walk : ST.perch; if (st.tumble > 0) return ST.tumble; if (st.takeoffCD > 0.2) return ST.takeoff; const sp = st.vel.length(); if (st.dartT > 0) return ST.dart; if (held("boost") && sp > 3) return ST.boost; return sp > 0.6 ? ST.cruise : ST.hover; }
  // bumps: soft knockback both ways, clamped, 0.5 s immunity, none in the nest
  let bumpImmune = 0;
  function bumpFly(id, playful) {
    const o = others.get(id); if (!o || bumpImmune > 0) return; if (st.pos.distanceTo(world.nestCenter()) < 1.6) return;
    const n = st.pos.clone().sub(o.F.pos).normalize(); const j = Math.min(2.2, 0.8 + st.vel.length() * 0.4 + (playful ? 0.6 : 0));
    st.vel.addScaledVector(n, j); bumpImmune = 0.5; blip("bonk"); burst(st.pos.clone().lerp(o.F.pos, 0.5), 0xffd23f, 8, 0.6, 0.35, 0.6);
    send("bump", { a: sid, b: id, n: [n.x, n.y, n.z].map((v) => Math.round(v * 100)), j: Math.round(j * 100) });
  }
  function onBump(p) { if (!p || p.b !== sid || bumpImmune > 0) return; const n = new THREE.Vector3(...p.n).divideScalar(-100); const j = Math.min(2.2, p.j / 100); if (st.mode === "perch") takeoff(); st.vel.addScaledVector(n, j); bumpImmune = 0.5; blip("bonk"); }

  // ---------- rent + swats ----------
  let paidAt = 0;
  const gold = () => { try { return Date.now() - Number(localStorage.getItem("greg_sol_paid") || 0) < 7 * 864e5; } catch { return false; } };
  const paid = () => Date.now() - paidAt < 10 * 60e3 || gold();
  async function payRent() { const { data } = await sb.rpc("greg_pay_fly_rent"); paidAt = Date.now(); onRent && onRent(data); }
  const isLeader = () => { const ids = Object.keys(ch?.presenceState() || {}); ids.push(sid); return ids.sort()[0] === sid; };
  let swatCooldown = 2, combo = 0; const nearSince = new Map();
  function leaderTick(dt) {
    if (!isLeader()) return; swatCooldown -= dt; if (swatCooldown > 0) return;
    const g = world.gregPos(), nc = world.nestCenter();
    const all = [{ id: sid, pos: st.pos, paid: paid(), dead: st.dead > 0, shield: st.shield > 0 }, ...[...others].map(([id, o]) => ({ id, pos: o.F.pos, paid: o.F.paid, dead: o.F.dead, shield: o.F.shield }))];
    for (const f of all) {
      const safe = f.dead || f.shield || f.pos.distanceTo(nc) < 2.5;
      const hd = Math.hypot(f.pos.x - g.x, f.pos.z - g.z);
      if (!safe && hd < 3.4 && f.pos.y < g.y + 3) nearSince.set(f.id, (nearSince.get(f.id) || 0) + dt * (hd < 1.6 ? 2 : 1)); else nearSince.delete(f.id);
      const annoy = nearSince.get(f.id) || 0;
      if (annoy > (f.paid ? 6 : 1.2) && Math.random() < dt * (f.paid ? 0.15 : 1.4)) {
        // aim leads the fly a little; 2.2 m+ away he uses a tongue flick (straight, ranged, tiny tell)
        const v = f.id === sid ? st.vel : (others.get(f.id)?.vel || new THREE.Vector3()); const aim = f.pos.clone().addScaledVector(v, 0.18);
        const ev = { target: f.id, at: Date.now() + (hd > 2.2 ? 280 : 350), aim: [aim.x, aim.y, aim.z].map((x) => Math.round(x * 100)), kind: hd > 2.2 ? "tongue" : "swat" };
        send("swat", ev); onSwat(ev); combo++; swatCooldown = combo < 3 ? 0.55 : 3.5; if (combo >= 3) combo = 0; nearSince.delete(f.id); return;
      }
    }
  }
  // the swat hand is a sphere that only exists during the hit frames
  function onSwat(ev) {
    const target = ev.target === sid ? st.pos : others.get(ev.target)?.F.pos; if (!target) return;
    world.punch && world.punch(target.clone(), ev.at);
    if (ev.target === sid) { hud.warn && hud.warn(ev.kind); blip("tell"); setTimeout(() => {
      const hand = ev.aim ? new THREE.Vector3(...ev.aim).divideScalar(100) : st.pos.clone();
      if (st.dead <= 0 && st.shield <= 0 && (st.iframe || 0) <= 0 && hand.distanceTo(st.pos) < (ev.kind === "tongue" ? 0.3 : 0.45)) die();
    }, Math.max(0, ev.at - Date.now())); }
  }
  let onDeath = null;
  function countSplat() { const k = "greg_splats_" + new Date().toISOString().slice(0, 10); let n = 0; try { n = Number(localStorage.getItem(k) || 0) + 1; localStorage.setItem(k, n); } catch {} hud.splats && hud.splats(n); }
  function die() { send("splat", { i: sid }); countSplat(); if (st.mode === "perch") { st.mode = "fly"; st.perchOn = null; } st.dead = 3; st.vel.set((Math.random() - 0.5) * 2, 2.5, (Math.random() - 0.5) * 2); burst(st.pos, 0x333333, 16, 1, 0.6); blip("bonk"); onDeath && onDeath(); }

  // ---------- main loop ----------
  const tmp = new THREE.Vector3(), wish = new THREE.Vector3();
  let fovNow = 70, shake = 0, lastPerchWalk = 0;
  world.onFrame((dt, t) => {
    const now = performance.now();
    st.takeoffCD = Math.max(0, st.takeoffCD - dt); st.dartCD = Math.max(0, st.dartCD - dt); st.iframe = Math.max(0, (st.iframe || 0) - dt); st.rollCD = Math.max(0, (st.rollCD || 0) - dt); st.dartT = Math.max(0, (st.dartT || 0) - dt); st.shield = Math.max(0, st.shield - dt); bumpImmune = Math.max(0, bumpImmune - dt);
    st.wingL = Math.max(0, st.wingL - dt); st.wingR = Math.max(0, st.wingR - dt); st.landing = Math.max(0, st.landing - dt * 2.5); st.caffeine = Math.max(0, st.caffeine - dt);
    // mouse: look, or steer a leg tip while Z / X is held
    const [mdx, mdy] = input.takeMouse(); const sens = 0.0022 * (settings.sens || 1);
    if (st.legL.active || st.legR.active) { for (const l of [st.legL, st.legR]) if (l.active) { l.x = Math.max(-0.05, Math.min(0.05, l.x + mdx * 0.00012 * (l === st.legL && st.legR.active ? -1 : 1))); l.y = Math.max(-0.03, Math.min(0.05, l.y - mdy * 0.00012)); } }
    else if (pov) { st.yaw -= mdx * sens; st.pitch = Math.max(-1.45, Math.min(1.45, st.pitch - mdy * sens)); }
    // manual rub: both legs held and moving in opposite directions
    const manualRub = st.legL.active && st.legR.active && Math.abs(mdx) > 2;
    let yr = st.yaw - st.lastYaw; yr = Math.atan2(Math.sin(yr), Math.cos(yr)); st.lastYaw = st.yaw; st.yawRate += (yr / Math.max(dt, 1e-3) - st.yawRate) * Math.min(1, dt * 8);
    const P0 = st.pos; st.walking = false;
    if (st.dead > 0) {
      st.dead -= dt; st.vel.y -= 9 * dt; phys.moveSphere(P0, st.vel, RAD, dt, { bounce: 0.3 });
      if (st.dead <= 0) spawnAtNest();
    } else if (st.mode === "perch") {
      if (st.perchOn === "greg") { const g = st.perchObj || world.greg; g.updateMatrixWorld(); P0.copy(g.localToWorld(st.perchLocal.clone())); st.up.copy(st.perchNLocal).applyQuaternion(g.getWorldQuaternion(new THREE.Quaternion())).normalize(); }
      let ix = (held("right") ? 1 : 0) - (held("left") ? 1 : 0), iz = (held("forward") ? 1 : 0) - (held("back") ? 1 : 0);
      if ((ix || iz) && st.perchOn !== "greg") {
        const n = st.up; let f = camFwd(); f.addScaledVector(n, -f.dot(n)); if (f.lengthSq() < 1e-4) f = new THREE.Vector3(0, 1, 0).applyQuaternion(qWant).addScaledVector(n, -n.y); f.normalize();
        const r = new THREE.Vector3().crossVectors(f, n).normalize(); const spd = held("boost") ? 0.75 : 0.32;
        wish.copy(f).multiplyScalar(iz).addScaledVector(r, ix).normalize().multiplyScalar(spd * dt);
        P0.add(wish); phys.depenetrate(P0, RAD * 0.9);
        const q = phys.nearest(P0, RAD * 3.5);
        if (q && !q.cap) { st.up.lerp(q.normal, 0.5).normalize(); P0.copy(q.point).addScaledVector(q.normal, RAD); }
        else if (!q) { st.mode = "fly"; st.vel.copy(wish).divideScalar(Math.max(dt, 1e-3)); }
        st.walking = true; st.walkPhase += dt * (held("boost") ? 22 : 13);
        if (now - lastPerchWalk > 140) { lastPerchWalk = now; if (Math.random() < 0.4) blip("tap"); }
      }
    } else if (settings.skill) {
      // wing skill mode: gravity, lift from flaps, uneven flapping rolls and turns, tumble past ~60 degrees
      const idle = Math.max(st.wingL, st.wingR) <= 0;
      if (held("up") && (st.burstCd || 0) <= 0) { st.vel.y += 2.6; st.burstCd = 0.6; blip("flapL"); blip("flapR"); }
      st.burstCd = (st.burstCd || 0) - dt;
      st.vel.y -= (held("down") ? 9 : idle ? 1.6 : 3.4) * dt;
      st.vel.multiplyScalar(Math.pow(0.6, dt));
      if (idle) st.roll *= Math.pow(0.25, dt);
      st.rollRate += (Math.random() - 0.5) * 2.2 * dt - st.roll * 1.2 * dt; st.rollRate *= Math.pow(0.35, dt);
      st.roll += st.rollRate * dt; st.yaw -= Math.sin(st.roll) * 1.4 * dt;
      if (st.tumble > 0) { st.tumble -= dt; st.roll += dt * 9; if (st.tumble <= 0) { st.roll = 0; st.rollRate = 0; } } else if (Math.abs(st.roll) > 1.05) st.tumble = 0.7;
      const ff = flatFwd(), hs = Math.hypot(st.vel.x, st.vel.z); if (hs > 0.05) { const k = Math.min(1, dt * 2); st.vel.x = st.vel.x * (1 - k) + ff.x * hs * k; st.vel.z = st.vel.z * (1 - k) + ff.z * hs * k; }
      flyMove(dt);
    } else {
      // default: smooth acceleration toward the wished velocity, drag to a steady hover when nothing is pressed
      const f = camFwd(), r = camRight();
      wish.set(0, 0, 0).addScaledVector(f, (held("forward") ? 1 : 0) - (held("back") ? 1 : 0)).addScaledVector(r, (held("right") ? 1 : 0) - (held("left") ? 1 : 0));
      wish.y += (held("up") || mobileUp ? 1 : 0) - (held("down") || mobileDown ? 1 : 0);
      if (input.touch.active) wish.addScaledVector(f, input.touch.y).addScaledVector(r, input.touch.x);
      const L0 = Math.min(1, wish.length()); if (L0 > 0) wish.normalize().multiplyScalar(L0);
      const wantBoost = (held("boost") || mobileBoost) && L0 > 0; st.stamina = Math.max(0, Math.min(1, (st.stamina ?? 1) + (wantBoost ? -0.38 : 0.2) * dt)); const boost = wantBoost && st.stamina > 0.02; const top = (boost ? 7.2 : 3.0) * (st.caffeine > 0 ? 1.4 : 1);
      const k = 1 - Math.exp(-dt * (L0 > 0 ? (boost ? 3.2 : 4.5) : 4.0)); // assisted: quick, smooth braking, holds altitude
      const before = st.vel.clone(); st.vel.lerp(wish.multiplyScalar(top), k);
      st.brakeK += ((before.length() - st.vel.length() > 0.02 && L0 === 0 ? 1 : 0) - st.brakeK) * Math.min(1, dt * 6);
      if (L0 > 0 || st.vel.lengthSq() > 0.01) hud.done("move");
      if (L0 > 0 && st.shield > 0 && st.shield < 1.7) st.shield = 0; // spawn protection ends early once you fly off
      // soft auto-avoid: look a little ahead; if a surface is coming fast, slide along it instead of hitting it
      const sp = st.vel.length();
      if (sp > 1.3) { const dir = st.vel.clone().divideScalar(sp); const h = phys.raycast(st.pos, dir, Math.min(1.2, 0.25 + sp * 0.18)); if (h) { const into = st.vel.dot(h.normal); if (into < 0) { st.vel.addScaledVector(h.normal, -into * Math.min(1, dt * 9)); const side = new THREE.Vector3().crossVectors(h.normal, Y); if (side.lengthSq() > 1e-4) st.vel.addScaledVector(side.normalize(), (side.dot(wish) >= 0 ? 1 : -1) * Math.min(0.6, -into) * dt * 4); } } }
      flyMove(dt, L0 > 0 ? wish : null);
    }
    if (manualRub) st.rubbing = true; else if (!held("rub") && st.emote !== "rub") st.rubbing = false;
    // soft bank into turns with overshoot-free smoothing
    const bcap = settings.skill ? 0.45 : 0.22; const bankT = Math.max(-bcap, Math.min(bcap, -st.yawRate * 0.06)) + (st.wingR > 0 ? -0.15 : 0) + (st.wingL > 0 ? 0.15 : 0);
    st.bank += (bankT - st.bank) * Math.min(1, dt * 5);
    // fly-fly separation (and bump on fast contact)
    for (const [id, o] of others) { if (o.F.dead) continue; const d = P0.distanceTo(o.F.pos); if (d > 0 && d < RAD * 2) { if (st.vel.length() > 1.2 && bumpImmune <= 0) bumpFly(id, false); else P0.addScaledVector(tmp.subVectors(P0, o.F.pos).normalize(), RAD * 2 - d); } }
    phys.pushBodies(P0, RAD, st.vel);
    if (!Number.isFinite(P0.x + P0.y + P0.z) || !Number.isFinite(st.vel.x + st.vel.y + st.vel.z)) { st.vel.set(0, 0, 0); spawnAtNest(false); }
    st.rollRate = Math.max(-6, Math.min(6, st.rollRate));
    const rr = Math.hypot(P0.x, P0.z); if (rr > R) { P0.x *= R / rr; P0.z *= R / rr; st.vel.x *= -0.3; st.vel.z *= -0.3; }
    if (P0.y > 18) { P0.y = 18; st.vel.y = Math.min(0, st.vel.y); }
    if (P0.y < -0.38) { P0.y = -0.38; st.vel.y = Math.abs(st.vel.y) * 0.4; } // water: no landing, gentle bounce
    groundClamp(P0, st.vel);
    if (P0.y < -2) spawnAtNest(false); // kill plane

    // remote flies
    let slot = 1; const g2 = world.gregPos();
    for (const [id, o] of others) {
      sampleRemote(o, now);
      if (now - (o.seen || now) > 15000) { drop(id); continue; }
      if (slot >= MAXF) break; o.F.hue = o.hue; drawFly(slot, o.F, t + slot); tag(slot, o.name, o.F.pos, o.F.pos.distanceTo(st.pos) < 14); slot++;
      if (o.F.rub && o.F.pos.distanceTo(g2) < 3.5 && onRubNear) onRubNear();
    }
    for (let i = slot; i < tagPool.length; i++) if (tagPool[i]) tagPool[i].visible = false;
    const showMe = !pov || third || st.dead > 0;
    if (showMe) drawFly(0, { pos: P0, up: st.mode === "perch" ? st.up : Y, yaw: st.yaw + Math.PI, speed: st.vel.length(), state: stateCode(), hue: me.hue, anim: { bank: st.bank }, rub: st.rubbing, legL: st.legL.active, legR: st.legR.active, wingL: st.wingL > 0, wingR: st.wingR > 0, paid: paid(), gold: gold(), shield: st.shield > 0, emote: now < st.emoteUntil ? st.emote : null }, t);
    else { M0.makeScale(0, 0, 0); for (const m of Object.values(parts)) { const per = m === parts.eyes || m === parts.wings || m === parts.disc ? 2 : m === parts.legs ? 6 : 1; for (let i = 0; i < per; i++) m.setMatrixAt(i, M0); } }
    commitParts(slot);
    // Greg glance / rent nags / swats
    let near = P0, nd = P0.distanceTo(g2), nearPaid = paid(), nearMine = true;
    for (const o of others.values()) { const d = o.F.pos.distanceTo(g2); if (d < nd) { nd = d; near = o.F.pos; nearPaid = o.F.paid; nearMine = false; } }
    world.setGlance(nd < 3.2 ? near : null, nd < 3.2 && !nearPaid);
    if (nd < 3.2 && !nearPaid && onUnpaidNear) onUnpaidNear(nearMine);
    if (st.rubbing && P0.distanceTo(g2) < 3.5 && onRubNear) onRubNear();
    leaderTick(dt);
    stepPuffs(dt);
    // camera
    if (pov) {
      world.setNear(0.012);
      st.camUp.lerp(st.mode === "perch" && !settings.levelHorizon ? st.up : Y, Math.min(1, dt / 0.25 * 1.6)).normalize();
      qAl.setFromUnitVectors(Y, st.camUp);
      const rm = settings.reduceMotion;
      // quaternions only; camera roll is damped and capped at 30 degrees (tumbles and death spins never flip the view)
      if (st.rollSpin) { st.rollSpin *= Math.pow(0.02, dt); if (Math.abs(st.rollSpin) < 0.01) st.rollSpin = 0; }
      let roll = (st.rollSpin || 0) * 0.5 + (st.mode === "perch" ? 0 : st.bank * (rm ? 0.3 : 1)) + (settings.skill ? -st.roll * 0.5 : 0) + (st.dead > 0 ? Math.sin(t * 5) * 0.35 : 0);
      roll = Math.max(-0.52, Math.min(0.52, roll)); st.camRoll = (st.camRoll || 0) + (roll - (st.camRoll || 0)) * Math.min(1, dt * 6);
      qYaw.setFromAxisAngle(Y, st.yaw); qPitch.setFromAxisAngle(XA, st.pitch + (st.dead > 0 ? Math.sin(t * 3) * 0.15 : 0)); qRoll.setFromAxisAngle(ZA, st.camRoll);
      qWant.copy(qAl).multiply(qYaw).multiply(qPitch).multiply(qRoll).normalize();
      if (!Number.isFinite(qWant.x)) qWant.identity();
      qCam.slerp(qWant, Math.min(1, dt * 22)).normalize(); camera.quaternion.copy(qCam);
      const eye = P0.clone().addScaledVector(st.camUp, st.mode === "perch" ? 0.012 : 0);
      if (third) { const back = new THREE.Vector3(0, 0.16, 0.55).applyQuaternion(qCam); const dist = back.length(); back.normalize(); const hit = phys.sphereCast(eye, back, 0.04, dist); camera.position.copy(eye).addScaledVector(back, hit ? Math.max(0.08, hit.t - 0.01) : dist); }
      else camera.position.copy(eye);
      shake = Math.max(0, shake - dt * 3); if (shake > 0 && !rm) camera.position.x += (Math.random() - 0.5) * 0.006 * shake;
      const spd = st.vel.length(), boosting = (held("boost") || mobileBoost) && spd > 3;
      const baseFov = innerWidth < innerHeight ? 78 : 68; const fov = baseFov + (rm ? 0 : Math.min(9, spd * 1.1) + (boosting ? 4 : 0));
      fovNow += (fov - fovNow) * Math.min(1, dt * 4); if (Math.abs(camera.fov - fovNow) > 0.05) { camera.fov = fovNow; camera.updateProjectionMatrix(); }
      fp.update(dt, t, { visible: !third && st.dead <= 0, speed: spd, yawRate: st.yawRate, brake: st.brakeK, perched: st.mode === "perch", walking: st.walking, walkPhase: st.walkPhase, landing: st.landing, rubbing: st.rubbing, legL: st.legL, legR: st.legR, wingL: st.wingL > 0.2, wingR: st.wingR > 0.2, reduceMotion: rm });
      hud.flight({ stamina: st.stamina ?? 1, speed: spd, boost: boosting && !rm, alt: P0.y, legL: st.legL.active, legR: st.legR.active, wingL: st.wingL > 0, wingR: st.wingR > 0, perched: st.mode === "perch", roll: settings.skill ? st.roll : st.bank, skill: settings.skill, dead: st.dead > 0, tumble: st.tumble > 0 });
      focus = pickFocus(); hud.prompt(focus ? focus.prompt : st.mode !== "perch" && phys.nearest(P0, 0.3) ? "Land / perch" : null, focus ? "F" : "C");
    } else { world.setNear(0.1); fp.update(dt, t, { visible: false }); hud.prompt(null); }
    // audio mix
    if (ac && buzz) {
      const on = soundOn() && st.dead <= 0 ? 1 : 0, spd = st.vel.length(), flying = st.mode !== "perch";
      const throttle = Math.min(1, spd / 6); buzz.o1.frequency.setTargetAtTime(178 + throttle * 70 + (st.caffeine > 0 ? 18 : 0) + Math.sin(t * 1.7) * 3, ac.currentTime, 0.08); buzz.o2.frequency.setTargetAtTime(179.3 + throttle * 71, ac.currentTime, 0.08); buzz.lfo.frequency.setTargetAtTime(18 + Math.random() * 12, ac.currentTime, 0.2);
      buzz.g.gain.setTargetAtTime(on * (flying ? 0.02 + throttle * 0.02 : 0), ac.currentTime, 0.1);
      wind.g.gain.setTargetAtTime(on * Math.min(0.12, spd * spd * 0.003), ac.currentTime, 0.15); wind.f.frequency.setTargetAtTime(300 + spd * 120, ac.currentTime, 0.2);
      rubG.gain.setTargetAtTime(on * (st.rubbing ? 0.035 * (0.6 + 0.4 * Math.abs(Math.sin(t * Math.PI * 7))) : 0), ac.currentTime, 0.02);
      const L = ac.listener; const fw = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion), uw = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      if (L.positionX) { L.positionX.value = camera.position.x; L.positionY.value = camera.position.y; L.positionZ.value = camera.position.z; L.forwardX.value = fw.x; L.forwardY.value = fw.y; L.forwardZ.value = fw.z; L.upX.value = uw.x; L.upY.value = uw.y; L.upZ.value = uw.z; }
      const nearest = [...others.values()].filter((o) => !o.F.dead && o.F.state !== ST.perch).sort((a, b) => a.F.pos.distanceTo(P0) - b.F.pos.distanceTo(P0)).slice(0, 2);
      remoteVoices.forEach((v, i) => { const o = nearest[i]; if (o && o.F.pos.distanceTo(P0) < 6) { if (v.p.positionX) { v.p.positionX.value = o.F.pos.x; v.p.positionY.value = o.F.pos.y; v.p.positionZ.value = o.F.pos.z; } v.g.gain.setTargetAtTime(on * 0.02, ac.currentTime, 0.1); const rv = o.vel ? -o.vel.dot(o.F.pos.clone().sub(P0).normalize()) : 0; v.o.frequency.setTargetAtTime((185 + Math.min(60, o.F.speed * 12)) * (343 / (343 - rv * 25)), ac.currentTime, 0.1); } else v.g.gain.setTargetAtTime(0, ac.currentTime, 0.1); });
    }
    document.body.classList.toggle("shielded", st.shield > 0 && pov && !third);
    sendState(now);
  });
  // safety net: the island top is flat ground at y=0 (beach at -0.3); a fly can never end up below it
  function groundClamp(p, v) {
    const r = Math.hypot(p.x, p.z), floor = r < world.R ? 0 : r < world.R + 2 ? -0.3 : -1e9;
    if (p.y < floor + RAD) { p.y = floor + RAD; if (v && v.y < 0) v.y = 0; return true; } return false;
  }
  function flyMove(dt, wishDir) {
    const before = st.vel.length();
    const c = phys.moveSphere(st.pos, st.vel, RAD, dt, { bounce: 0.3, friction: 0.08 });
    if (c) {
      if (c.impact > 1.6) { blip("bonk"); shake = Math.min(1, c.impact / 4); }
      // landing slowly into a surface sticks you to it
      const pushing = wishDir ? wishDir.clone().normalize().dot(c.normal) < -0.55 : held("down");
      if (st.takeoffCD <= 0 && c.impact < 1.4 && before < 1.5 && pushing) (perchAt.impact = c.impact), perchAt(st.pos.clone().addScaledVector(c.normal, -RAD), c.normal, c.hit?.cap);
    } else if (st.takeoffCD <= 0 && wishDir) { const n = phys.nearest(st.pos, 0.22); if (n && wishDir.clone().normalize().dot(n.normal) < -0.5 && st.vel.length() < 1.2) st.landing = Math.max(st.landing, 0.6); }
  }
  let mobileUp = false, mobileDown = false, mobileBoost = false;
  function setPov(v) { pov = v; controls.autoRotate = !pov; controls.autoRotateSpeed = 0.35; if (pov) { controls.enabled = false; qCam.copy(camera.quaternion); } else { controls.enabled = true; camera.up.set(0, 1, 0); world.followObject(null); world.setFollow(true); input.release(); } }
  // flight mode: Assisted (default, drone-like) or Skill (flap each wing). Pill on the HUD, K toggles.
  function setSkill(v, quiet) { settings.skill = v; save.set("settings", settings); hud.setMode(v); if (!quiet) toast && toast(v ? "Skill mode: Q / left click flaps the left wing, R / right click the right. Even rhythm flies straight." : "Assisted mode: WASD flies, the fly hovers by itself."); }
  hud.onMode = (v) => setSkill(v); input.on("mode", () => setSkill(!settings.skill)); setSkill(!!settings.skill, true);
  // chat bubbles over a fly for 4 s
  const bubbles = new Map();
  function say(id, text) {
    if (id === sid && pov && !third) return;
    let b = bubbles.get(id); if (!b) { const cv = document.createElement("canvas"); cv.width = 512; cv.height = 128; b = { sp: new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false })), cv }; b.sp.scale.set(0.9, 0.225, 1); b.sp.userData.noCollide = true; scene.add(b.sp); bubbles.set(id, b); }
    const x = b.cv.getContext("2d"); x.clearRect(0, 0, 512, 128); x.fillStyle = "rgba(255,255,255,.95)"; x.strokeStyle = "#141218"; x.lineWidth = 6; x.beginPath(); x.roundRect(4, 4, 504, 100, 26); x.fill(); x.stroke();
    x.fillStyle = "#141218"; x.font = "800 30px system-ui"; x.textAlign = "center"; const t = text.length > 34 ? text.slice(0, 33) + "…" : text; x.fillText(t, 256, 66); b.sp.material.map.needsUpdate = true; b.until = performance.now() + 4000;
  }
  world.onFrame(() => { const now = performance.now(); for (const [id, b] of bubbles) { const pos = id === sid ? st.pos : others.get(id)?.F.pos; b.sp.visible = !!pos && now < b.until; if (b.sp.visible) b.sp.position.set(pos.x, pos.y + 0.17, pos.z); } });
  function setName(v) {
    const taken = new Set(Object.entries(ch?.presenceState() || {}).filter(([k]) => k !== sid).map(([, p]) => String(p[0]?.n || "").toLowerCase()));
    let n = v, k = 2; while (taken.has(n.toLowerCase())) n = (v.slice(0, 13) + " " + k++).trim();
    me.name = n; try { localStorage.setItem("greg_fly", JSON.stringify(me)); } catch {} save.set("named", 1);
    try { ch?.track({ n: me.name, h: me.hue, ts: joinTs }); } catch {}
    toast && toast("You are " + n);
  }
  const rename = () => hud.askName(me.name, setName);
  if (!save.get("named", 0)) rename();
  world.setPickGate(() => !pov);
  // map hooks: other flies as dots, and a guide arrow toward a place picked on the map
  hud.others = () => [...others.values()].map((o) => o.F.pos);
  const guide = new THREE.Group(); guide.visible = false; camera.add(guide);
  { const m = new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false, transparent: true, opacity: 0.95 }); const sh = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.035, 10), m); sh.rotation.x = Math.PI / 2; sh.renderOrder = 60; guide.add(sh); }
  guide.position.set(0, 0.045, -0.2); let guideTo = null, guideName = "";
  hud.onGuide = (h) => { guideTo = new THREE.Vector3(h.px, 1, h.pz); guideName = h.name; toast && toast("Follow the arrow to " + h.name); };
  world.onFrame(() => { if (!guideTo || !pov) { guide.visible = false; return; } const d = Math.hypot(guideTo.x - st.pos.x, guideTo.z - st.pos.z); if (d < 2.2) { guideTo = null; guide.visible = false; toast && toast("You made it: " + guideName); return; } guide.visible = true; guide.lookAt(guideTo.x, st.pos.y, guideTo.z); });
  spawnAtNest(false); setPov(true); qCam.setFromEuler(new THREE.Euler(st.pitch, st.yaw, 0, "YXZ"));
  return {
    markGold: () => {}, me, setPov, isPov: () => pov, payRent, paid, onDeath: (f) => (onDeath = f), state: st, settings,
    setMobile: (k, v) => { if (k === "up") mobileUp = v; if (k === "down") mobileDown = v; if (k === "boost") mobileBoost = v; },
    setSetting: (k, v) => { settings[k] = v; save.set("settings", settings); }, perch: () => (st.mode === "perch" ? takeoff() : tryPerch(true)), interact, emote, others, sid, room: () => room,
    // test hooks
    rename, name: () => me.name, say, unstuck: () => { if (st.mode === "perch") { st.mode = "fly"; st.perchOn = null; } spawnAtNest(false); toast && toast("Back at the Fly Nest"); }, _clamp: groundClamp,
    _perchAt: perchAt, _spawn: spawnAtNest, _onP: onP,
  };
}
