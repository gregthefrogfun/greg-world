// Flight HUD: controls card (keycaps light up while pressed), glowing-E interaction prompt, onboarding hints,
// 4-part leg/wing indicator, speed lines, "click to fly" hint, mobile joystick + buttons, island map, local save.
import { CONTROLS, CONTROLS_SKILL, KEYMAP } from "./input.js";
import { PLACES, scheduleInfo, routePts, routineState } from "./config.js";

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
  const card = stop(el(`<section class="gcard" aria-label="Controls"><header><b>Controls</b><button class="gx" aria-label="Hide controls">H</button></header><p class="gtip hide">Keep the rhythm even to fly straight.</p><div class="grows"></div></section>`));
  root.appendChild(card);
  let cardOpen = save.get("cardOpen", true); const setCard = (v) => { cardOpen = v; card.classList.toggle("closed", !v); save.set("cardOpen", v); typeof fitPill === "function" && fitPill(); };
  setCard(cardOpen); card.querySelector(".gx").onclick = () => setCard(!cardOpen); input.on("help", () => toggleHow());
  let rows = new Map(), skill = false;
  const rowsHtml = (list) => list.map(([k, l]) => `<div class="grow" data-k="${k}">${keyHtml(k)}<span>${l}</span></div>`).join("");
  function renderRows() { card.querySelector(".grows").innerHTML = rowsHtml(skill ? CONTROLS_SKILL : CONTROLS); card.querySelector(".gtip").classList.toggle("hide", !skill); card.querySelector("header b").textContent = skill ? "Skill controls" : "Controls"; rows = new Map([...card.querySelectorAll(".grow")].map((r) => [r.dataset.k, r])); fitPill(); }
  function fitPill() { requestAnimationFrame(() => document.documentElement.style.setProperty("--cardh", (card.classList.contains("closed") || getComputedStyle(card).display === "none" ? 40 : card.offsetHeight + 8) + "px")); }
  renderRows();
  // mode pill (always visible): Assisted | Skill, K toggles
  const pill = stop(el(`<div class="gmode" role="group" aria-label="Flight mode"><button data-m="0">✈️ Assisted</button><button data-m="1">🪰 Skill</button></div>`)); root.appendChild(pill);
  pill.querySelectorAll("button").forEach((b) => (b.onclick = () => api.onMode && api.onMode(b.dataset.m === "1")));
  function setMode(v) { skill = v; pill.querySelectorAll("button").forEach((b) => b.classList.toggle("on", (b.dataset.m === "1") === v)); renderRows(); }
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
  // "How to fly": first-load overlay with big keycaps and a tiny animated demo per step; H or ? reopens it
  const STEPS = coarse ? [
    ["👆", "Drag to look", "Drag anywhere on the world to turn your head.", "look"],
    ["🕹", "Joystick to fly", "The joystick on the left moves you around.", "move"],
    ["Up", "Up and Down", "Hold Up to climb, Down to sink.", "updown"],
    ["Rub", "Rub your hands", "A fly classic. You can do it mid air.", "rub"],
    ["Land", "Land anywhere", "Walls, cups, rooftops, even Greg. Then walk around.", "land"],
    ["👁", "Fly eyes", "See the island the way a fly does.", "eyes"],
    ["🪰", "Want a challenge?", "Skill mode: flap each wing yourself.", "skill"],
  ] : [
    ["Click", "Click to fly", "Click the world to grab the mouse. Esc gives it back.", "click"],
    ["WASD", "Move", "W forward, S back, A and D sideways. Mouse steers.", "move"],
    ["Space / Ctrl", "Up and down", "Space climbs, Ctrl sinks. Shift boosts.", "updown"],
    ["E", "Rub your hands", "Hold E. Works while flying.", "rub"],
    ["C", "Land anywhere", "Walls, cups, rooftops, even Greg. WASD walks, Space takes off.", "land"],
    ["V", "Camera", "Switch between your fly eyes and a view from behind.", "cam"],
    ["K", "Want a challenge?", "Skill mode: flap each wing yourself. Q and R, or the mouse buttons.", "skill"],
  ];
  const how = stop(el(`<div class="ghow" role="dialog" aria-label="How to fly"><div class="ghow-in"><h2>How to fly</h2><p class="sub">You are a fly on Greg's island. Here is everything you need.</p><ol>${STEPS.map(([k, t, d, a]) => `<li><div class="demo d-${a}"><kbd class="big">${k.split(" / ").join("</kbd><kbd class=\"big\">")}</kbd><span class="fx"></span></div><b>${t}</b><span>${d}</span>${a === "skill" ? `<button class="tryskill">Try it</button>` : ""}</li>`).join("")}</ol><button class="gotit">Got it</button><p class="sub small">Press ${coarse ? "?" : "H or ?"} any time to see this again.</p></div></div>`));
  document.body.appendChild(how);
  function toggleHow(v) { const on = v ?? !how.classList.contains("show"); how.classList.toggle("show", on); if (on) input.release(); }
  how.querySelector(".tryskill").onclick = () => { toggleHow(false); save.set("howSeen", 1); api.onMode && api.onMode(true); };
  how.querySelector(".gotit").onclick = () => { toggleHow(false); save.set("howSeen", 1); };
  how.addEventListener("click", (e) => { if (e.target === how) toggleHow(false); });
  // "Name your fly": first visit, before the How to fly intro
  const NAMES = ["Buzz Lightweight", "Sir Lands-a-Lot", "Wing Commander", "Captain Hover", "Lady Buzzington", "Zoom Zoom", "Fly Guy", "Mister Wiggles", "Sticky Feet", "Professor Buzz", "Crumb Hunter", "Tiny Tornado", "Señor Zip", "Doctor Hum", "Sky Noodle", "Rent Dodger"];
  const BAD = /(fuck|shit|bitch|cunt|nigg|fag|retard|whore|slut|dick|cock|pussy|rape|nazi|hitler|porn|sex|http|www\.|\.com|\.fun|\.io)/i;
  const nameOk = (n) => /^[A-Za-z0-9 ]{2,16}$/.test(n) && !BAD.test(n.replace(/\s+/g, "")) && !/^\s*(greg|bit)\s*$/i.test(n) && !/greg ?the ?frog|official|admin|owner/i.test(n);
  const nameCard = stop(el(`<div class="ghow gname" role="dialog" aria-label="Name your fly"><div class="ghow-in" style="width:min(420px,100%)"><h2>Name your fly</h2><p class="sub">Everyone on the island will see it.</p><div class="nrow"><input maxlength="16" autocomplete="off" spellcheck="false" aria-label="Fly name"><button class="dice" title="Random name">🎲</button></div><p class="nerr"></p><button class="gotit">Spawn</button></div></div>`));
  document.body.appendChild(nameCard);
  const nIn = nameCard.querySelector("input"), nErr = nameCard.querySelector(".nerr");
  nameCard.querySelector(".dice").onclick = () => { nIn.value = NAMES[Math.floor(Math.random() * NAMES.length)]; nErr.textContent = ""; };
  let nameDone = null;
  function submitName() { const v = nIn.value.trim().replace(/\s+/g, " "); if (!nameOk(v)) { nErr.textContent = "2 to 16 letters, numbers or spaces. Keep it friendly, and no Greg or Bit."; return; } nameCard.classList.remove("show"); const cb = nameDone; nameDone = null; cb && cb(v); if (!save.get("howSeen", 0)) toggleHow(true); }
  nameCard.querySelector(".gotit").onclick = submitName; nIn.addEventListener("keydown", (e) => { if (e.key === "Enter") submitName(); e.stopPropagation(); });
  function askName(current, cb) { nIn.value = current || NAMES[Math.floor(Math.random() * NAMES.length)]; nErr.textContent = ""; nameDone = cb; nameCard.classList.add("show"); input.release(); setTimeout(() => nIn.focus(), 50); }
  if (!save.get("howSeen", 0) && save.get("named", 0)) toggleHow(true);
  // minimap with Greg's schedule: next stop, countdown, dotted path to it
  const mini = stop(el(`<div class="gmini"><canvas width="240" height="240"></canvas><div class="gsched"><b>Greg's schedule</b><span class="now"></span><span class="nxt"></span></div></div>`)); root.appendChild(mini);
  const mm = mini.querySelector("canvas").getContext("2d");
  let lastMini = 0;
  function drawMini() {
    const now = Date.now(), x = mm, W = 240, R = world.R + 2, s = W / 2 / R, c = W / 2; const g = world.gregPos(), me = world.camera.position;
    x.clearRect(0, 0, W, W); x.save(); x.beginPath(); x.arc(c, c, c - 3, 0, 7); x.clip();
    x.fillStyle = "#4fb6d6"; x.fillRect(0, 0, W, W); x.fillStyle = "#6cc04a"; x.beginPath(); x.arc(c, c, world.R * s, 0, 7); x.fill();
    x.fillStyle = "rgba(20,18,24,.55)"; for (const p of Object.values(PLACES)) { x.beginPath(); x.arc(c + p.x * s, c + p.z * s, 2.2, 0, 7); x.fill(); }
    const info = scheduleInfo(now), plan = world.gregPlan ? world.gregPlan(now) : null;
    const pts = routePts(info.now.place, info.next.place) || [];
    x.setLineDash([4, 4]); x.strokeStyle = "#fff"; x.lineWidth = 2.5; x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(c + p[0] * s, c + p[1] * s) : x.moveTo(c + p[0] * s, c + p[1] * s))); x.stroke(); x.setLineDash([]);
    const np = PLACES[info.next.place]; if (np) { x.strokeStyle = "#ffd23f"; x.lineWidth = 3; x.beginPath(); x.arc(c + np.x * s, c + np.z * s, 6, 0, 7); x.stroke(); }
    x.fillStyle = "#3ea24a"; x.strokeStyle = "#141218"; x.lineWidth = 2; x.beginPath(); x.arc(c + g.x * s, c + g.z * s, 6.5, 0, 7); x.fill(); x.stroke();
    x.fillStyle = "#ff5a4a"; x.beginPath(); x.arc(c + me.x * s, c + me.z * s, 4.5, 0, 7); x.fill(); x.stroke();
    x.restore(); x.lineWidth = 4; x.strokeStyle = "#141218"; x.beginPath(); x.arc(c, c, c - 3, 0, 7); x.stroke(); x.fillStyle = "#141218"; x.font = "900 16px system-ui"; x.textAlign = "center"; x.fillText("N", c, 18);
    const m = Math.floor(info.inMs / 60000), sec = Math.floor((info.inMs % 60000) / 1000);
    const interrupted = plan && !plan.routine;
    mini.querySelector(".now").textContent = interrupted ? "Busy with something, back soon" : "Now: " + info.now.label;
    mini.querySelector(".nxt").textContent = `Next: ${info.next.label} in ${m}:${String(sec).padStart(2, "0")}`;
  }
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
  const map = stop(el(`<div class="gmap hide"><canvas width="520" height="520"></canvas><p>Tap a place to get a guide arrow · M or Esc to close</p></div>`)); document.body.appendChild(map);
  const mctx = map.querySelector("canvas").getContext("2d");
  input.on("map", () => { mapOpen = !mapOpen; map.classList.toggle("hide", !mapOpen); if (mapOpen) input.release(); });
  // full island map: named places, Greg live, you, other flies, Greg's next stop; tap a place for a guide arrow
  const NICE = { desk: "Greg HQ", bakery: "Espresso", cafe: "Web Cafe", green: "Putting green", edge: "Dock", beach: "Beach", plaza: "Plaza", home: "Lily-pad home", rock: "Server rock", shed: "Studio", bench: "Easel", kitchen: "Kitchen", nook: "Reading nook", mailbox: "Fan mail", art: "Art wall", flats: "Fly Flats", gym: "Gym", pitch: "Football pitch", stage: "Stage", hill: "Paper plane hill" };
  let mapHits = [];
  function drawMap(me) {
    const x = mctx, W = 520, s = W / 60, cx = W / 2; x.clearRect(0, 0, W, W); mapHits = [];
    const sx = (v) => cx + v * s;
    // sea, sand, grass with soft shading, paths
    const sea = x.createRadialGradient(cx, cx, world.R * s, cx, cx, W / 2); sea.addColorStop(0, "#5cc8e0"); sea.addColorStop(1, "#2f8fbf"); x.fillStyle = sea; x.beginPath(); x.arc(cx, cx, W / 2, 0, 7); x.fill();
    x.fillStyle = "#f2d38a"; x.beginPath(); x.arc(cx, cx, (world.R + 1.8) * s, 0, 7); x.fill();
    const gr = x.createRadialGradient(cx - 40, cx - 60, 20, cx, cx, world.R * s); gr.addColorStop(0, "#8fdc5a"); gr.addColorStop(1, "#4fa83f"); x.fillStyle = gr; x.beginPath(); x.arc(cx, cx, world.R * s, 0, 7); x.fill();
    x.strokeStyle = "rgba(255,255,255,.5)"; x.lineWidth = 2; x.setLineDash([2, 5]); x.beginPath(); x.arc(cx, cx, (world.R + 2.6) * s, 0, 7); x.stroke(); x.setLineDash([]);
    x.strokeStyle = "#d8c6a8"; x.lineWidth = 6; x.lineCap = "round"; for (const p of Object.values(PLACES)) { x.beginPath(); x.moveTo(sx(PLACES.plaza.x), sx(PLACES.plaza.z)); x.lineTo(sx(p.x), sx(p.z)); x.stroke(); }
    x.fillStyle = "#d8c6a8"; x.beginPath(); x.arc(sx(PLACES.plaza.x), sx(PLACES.plaza.z), 2.9 * s, 0, 7); x.fill();
    let tr = 3; const r1 = () => ((tr = (tr * 16807) % 2147483647) / 2147483647); x.fillStyle = "#2f7d33"; for (let i = 0; i < 70; i++) { const a = r1() * 6.28, rr = 13 + r1() * 10; x.beginPath(); x.arc(cx + Math.cos(a) * rr * s, cx + Math.sin(a) * rr * s, 4 + r1() * 3, 0, 7); x.fill(); }
    const info = scheduleInfo(Date.now()), np = PLACES[info.next.place];
    const pts = routePts(info.now.place, info.next.place) || []; x.setLineDash([6, 6]); x.strokeStyle = "#fff"; x.lineWidth = 3; x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(sx(p[0]), sx(p[1])) : x.moveTo(sx(p[0]), sx(p[1])))); x.stroke(); x.setLineDash([]);
    // markers first, labels after with collision avoidance and leader lines
    const labels = [];
    const marker = (px, pz, col, r, stroke) => { x.fillStyle = col; x.beginPath(); x.arc(sx(px), sx(pz), r, 0, 7); x.fill(); if (stroke) { x.strokeStyle = "#141218"; x.lineWidth = 2; x.stroke(); } };
    for (const [k, p] of Object.entries(PLACES)) { const big = ["desk", "bakery", "cafe", "green", "edge", "beach"].includes(k); marker(p.x, p.z, big ? "#141218" : "rgba(20,18,24,.55)", big ? 5 : 3.5); labels.push({ px: p.x, pz: p.z, text: NICE[k] || p.label, pri: big ? 2 : 1, big }); mapHits.push({ x: sx(p.x), y: sx(p.z), name: NICE[k] || p.label, px: p.x, pz: p.z }); }
    const n = world.nestCenter(); marker(n.x, n.z, "#c8633a", 6, true); labels.push({ px: n.x, pz: n.z, text: "Fly Nest", pri: 3, big: true }); mapHits.push({ x: sx(n.x), y: sx(n.z), name: "Fly Nest", px: n.x, pz: n.z });
    if (np) { x.strokeStyle = "#ffd23f"; x.lineWidth = 4; x.beginPath(); x.arc(sx(np.x), sx(np.z), 11, 0, 7); x.stroke(); }
    for (const o of api.others ? api.others() : []) marker(o.x, o.z, "#ffd23f", 4, true);
    const g = world.gregPos(); marker(g.x, g.z, "#3ea24a", 9, true); labels.push({ px: g.x, pz: g.z, text: "Greg", pri: 5, big: true, col: "#1d6b2a" });
    if (me) { marker(me.x, me.z, "#ff5a4a", 6.5, true); labels.push({ px: me.x, pz: me.z, text: "You", pri: 6, big: true, col: "#c0392b" }); }
    const placed = []; const hit = (r) => placed.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
    labels.sort((a, b) => b.pri - a.pri);
    for (const L of labels) {
      x.font = (L.big ? "900 13px" : "800 11px") + " system-ui"; const w = x.measureText(L.text).width + 8, h = L.big ? 17 : 15, ax = sx(L.px), az = sx(L.pz);
      const tries = [[0, -h - 7], [0, 9], [10, -h / 2], [-w - 10, -h / 2], [12, -h - 10], [-w - 12, -h - 10], [12, 10], [-w - 12, 10], [0, -h - 26], [0, 28], [26, -h / 2], [-w - 26, -h / 2]];
      let r = null; for (const [ox, oy] of tries) { const c0 = { x: ax + (ox === 0 ? -w / 2 : ox), y: az + oy, w, h }; if (!hit(c0)) { r = c0; break; } } if (!r) continue; placed.push(r);
      const lx = r.x + r.w / 2, ly = r.y + r.h / 2; if (Math.hypot(lx - ax, ly - az) > 22) { x.strokeStyle = "rgba(20,18,24,.6)"; x.lineWidth = 1.2; x.beginPath(); x.moveTo(ax, az); x.lineTo(lx, ly); x.stroke(); }
      x.fillStyle = "rgba(255,255,255,.88)"; x.beginPath(); x.roundRect(r.x, r.y, r.w, r.h, 6); x.fill(); x.fillStyle = L.col || "#141218"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(L.text, lx, ly + 1);
    }
    x.textBaseline = "alphabetic";
    if (np) { x.font = "900 12px system-ui"; x.fillStyle = "#141218"; x.textAlign = "left"; x.fillText("◯ Greg's next stop: " + info.next.label, 14, W - 14); }
  }
  map.querySelector("canvas").addEventListener("click", (e) => {
    const r = e.target.getBoundingClientRect(), mx = ((e.clientX - r.left) / r.width) * 520, my = ((e.clientY - r.top) / r.height) * 520;
    let best = null, bd = 30; for (const h of mapHits) { const d = Math.hypot(h.x - mx, h.y - my); if (d < bd) { bd = d; best = h; } }
    if (best) { api.onGuide && api.onGuide(best); mapOpen = false; map.classList.add("hide"); }
  });
  // highlight keys while pressed
  addEventListener("keydown", (e) => { const l = CODE_LABEL[e.code]; if (l && rows.get(l)) rows.get(l).classList.add("on"); });
  addEventListener("keyup", (e) => { const l = CODE_LABEL[e.code]; if (l && rows.get(l)) rows.get(l).classList.remove("on"); });
  function done(k) { if (doneSet.has(k)) return; doneSet.add(k); save.set("hints", [...doneSet]); nextHint(); }
  let lastMap = 0, discT = 0;
  const api = {
    toggleHow, openMap: () => { mapOpen = true; map.classList.remove("hide"); input.release(); }, closeMap: () => { mapOpen = false; map.classList.add("hide"); }, howOpen: () => how.classList.contains("show"),
    askName, nameOk, setMode, onMode: null, others: null, onGuide: null,
    done, mapOpen: () => mapOpen, mobile: null,
    prompt: (text, key = "F") => { if (!text) { prompt.classList.add("hide"); return; } prompt.classList.remove("hide"); prompt.lastChild.textContent = text; prompt.firstChild.textContent = key; },
    flight: (f) => {
      if (performance.now() - lastMini > 250) { lastMini = performance.now(); drawMini(); }
      for (const p of ["legL", "legR", "wingL", "wingR"]) ind.querySelector(`[data-p=${p}]`).classList.toggle("on", !!f[p]);
      stam.firstChild.style.width = Math.round((f.stamina ?? 1) * 100) + "%"; stam.classList.toggle("low", (f.stamina ?? 1) < 0.25);
      lines.style.opacity = f.boost ? Math.min(0.7, (f.speed - 3) / 5).toFixed(2) : 0;
      if (mapOpen && performance.now() - lastMap > 200) { lastMap = performance.now(); drawMap(world.camera.position); }
    },
    warn: (kind) => { warnEl.textContent = kind === "tongue" ? "TONGUE!" : "SWAT!"; warnEl.classList.remove("hide"); setTimeout(() => warnEl.classList.add("hide"), 450); },
    splats: (n) => { splat.querySelector("b").textContent = n; },
    trick: (m) => { disc.textContent = m; disc.classList.remove("hide"); clearTimeout(discT); discT = setTimeout(() => disc.classList.add("hide"), 1400); },
    discovery: (n) => { disc.textContent = `Discovery! ${n} found`; disc.classList.remove("hide"); clearTimeout(discT); discT = setTimeout(() => disc.classList.add("hide"), 2200); },
    controlsHtml: () => `<div class="grows big">${(skill ? CONTROLS_SKILL : CONTROLS).map(([k, l]) => `<div class="grow">${keyHtml(k)}<span>${l}</span></div>`).join("")}</div>`,
    panels: () => [...document.querySelectorAll(".gcard:not(.closed), .flyhud, .top .status, .sheet, .gprompt:not(.hide), .flyui")],
  };
  return api;
}
export { KEYMAP };
