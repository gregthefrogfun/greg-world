// One input manager for the whole island. Every key maps to exactly one action per context, game keys are off
// while typing or while a panel is open, and the mouse only steers the fly while the pointer is locked to the canvas.
export const KEYMAP = {
  fly: {
    KeyW: "forward", KeyS: "back", KeyA: "left", KeyD: "right", ArrowUp: "forward", ArrowDown: "back", ArrowLeft: "left", ArrowRight: "right",
    Space: "up", ControlLeft: "down", ControlRight: "down", ShiftLeft: "boost", ShiftRight: "boost",
    KeyE: "rub", KeyF: "interact", KeyC: "perch", KeyV: "view", KeyB: "eyes", KeyM: "map", KeyH: "help", KeyT: "chat", Enter: "chat",
    KeyQ: "wingL", KeyR: "wingR", KeyZ: "legL", KeyX: "legR", Digit1: "emote1", Digit2: "emote2", Digit3: "emote3", Digit4: "emote4", Escape: "menu",
  },
  perched: {
    KeyW: "forward", KeyS: "back", KeyA: "left", KeyD: "right", ArrowUp: "forward", ArrowDown: "back", ArrowLeft: "left", ArrowRight: "right",
    Space: "takeoff", ShiftLeft: "boost", ShiftRight: "boost", KeyE: "rub", KeyF: "interact", KeyC: "perch", KeyV: "view", KeyB: "eyes", KeyM: "map", KeyH: "help", KeyT: "chat", Enter: "chat",
    KeyZ: "legL", KeyX: "legR", Digit1: "emote1", Digit2: "emote2", Digit3: "emote3", Digit4: "emote4", Escape: "menu",
  },
  map: { KeyM: "map", Escape: "map" },
  menu: { Escape: "closeMenu" },
  typing: { Escape: "closeChat" },
};
// a key bound twice inside one context, or two keys fighting over a held action, is a conflict
export function conflicts() {
  const out = [];
  for (const [ctx, map] of Object.entries(KEYMAP)) {
    const seen = new Map();
    for (const [k, a] of Object.entries(map)) { if (seen.has(k)) out.push(`${ctx}: ${k} bound twice`); seen.set(k, a); }
    const view = ["view", "eyes"], wings = ["wingL", "wingR"];
    for (const [k, a] of Object.entries(map)) if (wings.includes(a) && view.includes(map[k])) out.push(`${ctx}: ${k} wing/view clash`);
  }
  return out;
}
export const CONTROLS = [
  ["Mouse", "Look"], ["WASD", "Fly / walk"], ["Space", "Up"], ["Ctrl", "Down"], ["Shift", "Boost"], ["E", "Rub hands"], ["F", "Interact"],
  ["C", "Land / perch"], ["V", "1st / 3rd person"], ["B", "Fly Eyes 360"], ["M", "Map"], ["Z / X", "Left / right leg"], ["Q / R", "Left / right wing"],
  ["1-4", "Emotes"], ["H", "Hide this card"], ["Esc", "Menu"],
];

export function createInput(canvas) {
  const held = new Set(), handlers = new Map(), keysDown = new Set();
  const mouse = { dx: 0, dy: 0, buttons: 0 };
  const touch = { x: 0, y: 0, active: false }; // virtual joystick
  let ctxFn = () => "fly";
  const typing = () => !!document.activeElement?.closest?.("input,textarea,select,[contenteditable=true]");
  const panelOpen = () => !!document.querySelector("#modal.show, .gmenu.show");
  function context() { if (typing()) return "typing"; if (panelOpen()) return "menu"; return ctxFn(); }
  const emit = (a, e) => { for (const f of handlers.get(a) || []) f(e); };
  addEventListener("keydown", (e) => {
    const ctx = context(), a = KEYMAP[ctx]?.[e.code]; keysDown.add(e.code);
    if (!a) return;
    if (ctx !== "typing" && ctx !== "menu") { if (e.code === "Space" || e.code.startsWith("Arrow") || e.code.startsWith("Control") || e.code === "Tab") e.preventDefault(); if (e.ctrlKey && ["KeyW", "KeyS", "KeyD", "KeyF", "KeyR", "KeyT"].includes(e.code)) e.preventDefault(); }
    if (!held.has(a) || !e.repeat) { if (!e.repeat) emit(a, e); }
    held.add(a);
  });
  addEventListener("keyup", (e) => { keysDown.delete(e.code); for (const map of Object.values(KEYMAP)) { const a = map[e.code]; if (a && ![...keysDown].some((k) => map[k] === a)) { if (held.has(a)) { held.delete(a); emit(a + ":up", e); } } } });
  addEventListener("blur", () => { held.clear(); keysDown.clear(); });
  // pointer lock: click the canvas to fly, Esc gives the mouse back to the UI
  const locked = () => document.pointerLockElement === canvas;
  canvas.addEventListener("click", () => { if (!locked() && context() !== "menu" && matchMedia("(pointer: fine)").matches) canvas.requestPointerLock?.(); emit("canvasClick"); });
  document.addEventListener("pointerlockchange", () => { emit(locked() ? "lock" : "unlock"); if (!locked()) { mouse.buttons = 0; held.delete("wingL"); held.delete("wingR"); } });
  addEventListener("mousemove", (e) => { if (!locked()) return; mouse.dx += e.movementX; mouse.dy += e.movementY; });
  canvas.addEventListener("mousedown", (e) => { if (!locked()) return; e.preventDefault(); const a = e.button === 0 ? "mouseL" : e.button === 2 ? "mouseR" : null; if (a) { held.add(a); emit(a, e); } });
  addEventListener("mouseup", (e) => { const a = e.button === 0 ? "mouseL" : e.button === 2 ? "mouseR" : null; if (a && held.has(a)) { held.delete(a); emit(a + ":up", e); } });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => { if (locked()) e.preventDefault(); }, { passive: false });
  // touch: drag on the canvas looks around (UI elements stop their own events)
  let lt = null;
  canvas.addEventListener("touchstart", (e) => { const t = e.changedTouches[0]; lt = { id: t.identifier, x: t.clientX, y: t.clientY }; }, { passive: true });
  canvas.addEventListener("touchmove", (e) => { for (const t of e.changedTouches) if (lt && t.identifier === lt.id) { mouse.dx += (t.clientX - lt.x) * 1.4; mouse.dy += (t.clientY - lt.y) * 1.4; lt.x = t.clientX; lt.y = t.clientY; } e.preventDefault(); }, { passive: false });
  canvas.addEventListener("touchend", () => (lt = null));
  return {
    held: (a) => (context() === "typing" || context() === "menu" ? false : held.has(a)),
    on: (a, f) => { if (!handlers.has(a)) handlers.set(a, []); handlers.get(a).push(f); },
    press: (a, down = true) => { if (down) { held.add(a); emit(a); } else { held.delete(a); emit(a + ":up"); } },
    takeMouse: () => { const d = [mouse.dx, mouse.dy]; mouse.dx = mouse.dy = 0; return d; },
    setContext: (f) => (ctxFn = f), context, locked, touch, keysDown,
    release: () => document.exitPointerLock?.(),
  };
}
