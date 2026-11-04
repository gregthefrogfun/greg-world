// Flight HUD: controls card (keycaps light up while pressed), glowing-E interaction prompt, onboarding hints,
// 4-part leg/wing indicator, speed lines, "click to fly" hint, mobile joystick + buttons, island map, local save.
import { CONTROLS, KEYMAP } from "./input.js";
import { PLACES } from "./config.js";

export function createSave() {
  const KEY = "greg_save"; let data = {};
  try { data = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { data = {}; }
  const write = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {} };
  return {
    get: (k, d) => (data[k] === undefined ? d : data[k]), set: (k, v) => { data[k] = v; write(); },
    discover: (id) => { data.disc = data.disc || {}; if (data.disc[id]) return false; data.disc[id] = Date.now(); write(); return true; },
    discoveries: () => Object.keys(data.disc || {}).length,
    count: (k) => { data.counts = data.counts || {}; data.counts[k] = (data.counts[k] || 0) + 1; write(); return data.counts[k]; },
    raw: () => data,
  };
}

const CODE_LABEL = { KeyW: "WASD", KeyA: "WASD", KeyS: "WASD", KeyD: "WASD", Space: "Space", ControlLeft: "Ctrl", ControlRight: "Ctrl", ShiftLeft: "Shift", ShiftRight: "Shift", KeyE: "E", KeyF: "F", KeyC: "C", KeyV: "V", KeyB: "B", KeyM: "M", KeyZ: "Z / X", KeyX: "Z / X", KeyQ: "Q / R", KeyR: "Q / R", Digit1: "1-4", Digit2: "1-4", Digit3: "1-4", Digit4: "1-4", KeyH: "H", Escape: "Esc" };

export function createHud({ input, save, world }) {
  const el = (h) => { const d = document.createElement("div"); d.innerHTML = h.trim(); return d.firstChild; };
  const stop = (n) => { for (const ev of ["pointerdown", "mousedown", "mouseup", "click", "wheel", "touchstart"]) n.addEventListener(ev, (e) => e.stopPropagation(), { passive: true }); return n; };
  const root = el(`<div class="ghud"></div>`); document.body.appendChild(root);
  // controls card
  const keyHtml = (k) => k.split(" / ").map((p) => `<kbd>${p}</kbd>`).join("<i>/</i>");
  const card = stop(el(`<section class="gcard" aria-label="Controls"><header><b>Controls</b><button class="gx" aria-label="Hide controls">H</button></header><div class="grows">${CONTROLS.map(([k, l]) => `<div class="grow" data-k="${k}">${keyHtml(k)}<span>${l}</span></div>`).join("")}</div></section>`));
  root.appendChild(card);
  let cardOpen = save.get("cardOpen", true); const setCard = (v) => { cardOpen = v; card.classList.toggle("closed", !v); save.set("cardOpen", v); };
  setCard(cardOpen); card.querySelector(".gx").onclick = () => setCard(!cardOpen); input.on("help", () => setCard(!cardOpen));
  const rows = new Map([...card.querySelectorAll(".grow")].map((r) => [r.dataset.k, r]));
  // prompt chip (glowing carved-E style), hints, indicator, click-to-fly, speed lines
  const prompt = el(`<div class="gprompt hide"><kbd class="glow">F</kbd><span></span></div>`); root.appendChild(prompt);
  const hint = el(`<div class="ghint hide"></div>`); root.appendChild(hint);
  const lock = el(`<div class="glock">Click to fly · Esc for menu</div>`); root.appendChild(lock);
  const ind = el(`<div class="gind" aria-label="Legs and wings"><i data-p="legL">L leg</i><i data-p="legR">R leg</i><i data-p="wingL">L wing</i><i data-p="wingR">R wing</i></div>`); root.appendChild(ind);
  const lines = el(`<div class="gspeed"></div>`); document.body.appendChild(lines);
  const disc = el(`<div class="gdisc hide"></div>`); root.appendChild(disc);
  const stam = el(`<div class="gstam" title="Boost stamina"><i></i></div>`); root.appendChild(stam);
  const warnEl = el(`<div class="gwarn hide">!</div>`); root.appendChild(warnEl);
  const splat = el(`<div class="gsplat">🪰 <b>0</b> swatted today</div>`); root.appendChild(splat);
  try { splat.querySelector("b").textContent = localStorage.getItem("greg_splats_" + new Date().toISOString().slice(0, 10)) || 0; } catch {}
  const coarse = matchMedia("(pointer: coarse)").matches;
  input.on("lock", () => lock.classList.add("hide")); input.on("unlock", () => lock.classList.remove("hide"));
  if (coarse) lock.classList.add("hide");
  // onboarding: three hints, each disappears once the action is done
  const HINTS = [["click", coarse ? "Drag to look around" : "Click the world to fly"], ["move", coarse ? "Use the joystick to fly" : "WASD to move, Space / Ctrl up and down"], ["rub", "Press E to rub your hands"]];
  const doneSet = new Set(save.get("hints", [])); if (coarse) doneSet.add("click");
  function nextHint() { const h = HINTS.find(([k]) => !doneSet.has(k)); if (!h) { hint.classList.add("hide"); return; } hint.innerHTML = `<kbd class="glow">${h[0] === "click" ? "🖱" : h[0] === "move" ? "W" : "E"}</kbd>${h[1]}`; hint.classList.remove("hide"); }
  nextHint();
  // mobile: joystick + labelled buttons
  let mapOpen = false;
  if (coarse) {
    const joy = stop(el(`<div class="gjoy"><i></i></div>`)); root.appendChild(joy); const knob = joy.firstChild; let jid = null, c0 = null;
    joy.addEventListener("touchstart", (e) => { const t = e.changedTouches[0]; jid = t.identifier; const r = joy.getBoundingClientRect(); c0 = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; input.touch.active = true; }, { passive: true });
    joy.addEventListener("touchmove", (e) => { for (const t of e.changedTouches) if (t.identifier === jid) { const dx = t.clientX - c0.x, dy = t.clientY - c0.y, m = Math.min(1, Math.hypot(dx, dy) / 46), a = Math.atan2(dy, dx); input.touch.x = Math.cos(a) * m; input.touch.y = -Math.sin(a) * m; knob.style.transform = `translate(${Math.cos(a) * m * 34}px,${Math.sin(a) * m * 34}px)`; done("move"); } e.preventDefault(); }, { passive: false });
    const end = () => { jid = null; input.touch.active = false; input.touch.x = input.touch.y = 0; knob.style.transform = ""; };
    joy.addEventListener("touchend", end); joy.addEventListener("touchcancel", end);
    const btns = stop(el(`<div class="gbtns"><button data-a="up">Up</button><button data-a="down">Down</button><button data-a="boost">Boost</button><button data-a="rub">Rub</button><button data-a="perch">Land</button><button data-a="interact">Use</button><button data-a="eyes">👁</button><button data-a="help">?</button></div>`)); root.appendChild(btns);
    btns.querySelectorAll("button").forEach((b) => { const a = b.dataset.a; b.addEventListener("touchstart", (e) => { e.preventDefault(); if (["up", "down", "boost"].includes(a)) api.mobile && api.mobile(a, true); else if (a === "help") setCard(!cardOpen); else input.press(a, true); }, { passive: false }); b.addEventListener("touchend", () => { if (["up", "down", "boost"].includes(a)) api.mobile && api.mobile(a, false); else if (a !== "help") input.press(a, false); }); });
    setCard(save.get("cardOpenMobile", false));
  }
  // island map (M)
  const map = stop(el(`<div class="gmap hide"><canvas width="520" height="520"></canvas><p>M or Esc to close</p></div>`)); document.body.appendChild(map);
  const mctx = map.querySelector("canvas").getContext("2d");
  input.on("map", () => { mapOpen = !mapOpen; map.classList.toggle("hide", !mapOpen); if (mapOpen) input.release(); });
  function drawMap(me) {
    const x = mctx, W = 520, s = W / 60, cx = W / 2; x.clearRect(0, 0, W, W);
    x.fillStyle = "#8fe3e6"; x.beginPath(); x.arc(cx, cx, W / 2, 0, 7); x.fill(); x.fillStyle = "#74c94a"; x.beginPath(); x.arc(cx, cx, (world.R) * s, 0, 7); x.fill();
    x.fillStyle = "#141218"; x.font = "800 13px system-ui"; x.textAlign = "center";
    for (const [k, p] of Object.entries(PLACES)) { x.beginPath(); x.arc(cx + p.x * s, cx + p.z * s, 4, 0, 7); x.fill(); x.fillText(p.label.replace(/^(his|the) /, ""), cx + p.x * s, cx + p.z * s - 8); }
    const n = world.nestCenter(); x.fillStyle = "#c8633a"; x.beginPath(); x.arc(cx + n.x * s, cx + n.z * s, 7, 0, 7); x.fill(); x.fillText("Fly Nest", cx + n.x * s, cx + n.z * s + 20);
    const g = world.gregPos(); x.fillStyle = "#3ea24a"; x.strokeStyle = "#141218"; x.lineWidth = 3; x.beginPath(); x.arc(cx + g.x * s, cx + g.z * s, 9, 0, 7); x.fill(); x.stroke(); x.fillStyle = "#141218"; x.fillText("Greg", cx + g.x * s, cx + g.z * s + 24);
    if (me) { x.fillStyle = "#ff5a4a"; x.beginPath(); x.arc(cx + me.x * s, cx + me.z * s, 6, 0, 7); x.fill(); x.stroke(); }
  }
  // highlight keys while pressed
  addEventListener("keydown", (e) => { const l = CODE_LABEL[e.code]; if (l && rows.get(l)) rows.get(l).classList.add("on"); });
  addEventListener("keyup", (e) => { const l = CODE_LABEL[e.code]; if (l && rows.get(l)) rows.get(l).classList.remove("on"); });
  function done(k) { if (doneSet.has(k)) return; doneSet.add(k); save.set("hints", [...doneSet]); nextHint(); }
  let lastMap = 0, discT = 0;
  const api = {
    done, mapOpen: () => mapOpen, mobile: null,
    prompt: (text, key = "F") => { if (!text) { prompt.classList.add("hide"); return; } prompt.classList.remove("hide"); prompt.lastChild.textContent = text; prompt.firstChild.textContent = key; },
    flight: (f) => {
      for (const p of ["legL", "legR", "wingL", "wingR"]) ind.querySelector(`[data-p=${p}]`).classList.toggle("on", !!f[p]);
      stam.firstChild.style.width = Math.round((f.stamina ?? 1) * 100) + "%"; stam.classList.toggle("low", (f.stamina ?? 1) < 0.25);
      lines.style.opacity = f.boost ? Math.min(0.7, (f.speed - 3) / 5).toFixed(2) : 0;
      if (mapOpen && performance.now() - lastMap > 200) { lastMap = performance.now(); drawMap(world.camera.position); }
    },
    warn: (kind) => { warnEl.textContent = kind === "tongue" ? "TONGUE!" : "SWAT!"; warnEl.classList.remove("hide"); setTimeout(() => warnEl.classList.add("hide"), 450); },
    splats: (n) => { splat.querySelector("b").textContent = n; },
    trick: (m) => { disc.textContent = m; disc.classList.remove("hide"); clearTimeout(discT); discT = setTimeout(() => disc.classList.add("hide"), 1400); },
    discovery: (n) => { disc.textContent = `Discovery! ${n} found`; disc.classList.remove("hide"); clearTimeout(discT); discT = setTimeout(() => disc.classList.add("hide"), 2200); },
    controlsHtml: () => `<div class="grows big">${CONTROLS.map(([k, l]) => `<div class="grow">${keyHtml(k)}<span>${l}</span></div>`).join("")}</div>`,
    panels: () => [...document.querySelectorAll(".gcard:not(.closed), .flyhud, .top .status, .sheet, .gprompt:not(.hide), .flyui")],
  };
  return api;
}
export { KEYMAP };
