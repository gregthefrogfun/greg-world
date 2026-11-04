// Greg's island in a 3D comic look: cel bands, halftone shadows, inverted-hull outlines.
// Vanilla three.js. Greg + key props are Higgsfield GLBs (rigged Greg when available); the rest is
// code-built with shared materials and instancing so it stays smooth on phones.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PLACES, posAt, SCALE, routineState, setRouter } from "./config.js";
import { createNav } from "./nav.js";
import { createPhysics } from "./physics.js";

const ASSET = new URL("../assets/3d/", import.meta.url).href;
const LIGHT = new THREE.Vector3(0.55, 1, 0.35).normalize();
const R_ISLAND = 24.5;
const GREG_H = 2.2;

// ---------- materials (instancing aware) ----------
const toonVS = `
varying vec3 vN; varying vec2 vUv; varying vec3 vC;
void main(){
  vUv=uv; vC=vec3(1.);
  mat4 im = mat4(1.);
  #ifdef USE_INSTANCING
    im = instanceMatrix;
  #endif
  #ifdef USE_INSTANCING_COLOR
    vC = instanceColor;
  #endif
  #ifdef USE_SKINNING
  #endif
  vN=normalize(mat3(modelMatrix*im)*normal);
  gl_Position=projectionMatrix*viewMatrix*modelMatrix*im*vec4(position,1.);
}`;
const toonFS = `
uniform vec3 uColor; uniform sampler2D uMap; uniform float uUseMap; uniform float uRep; uniform vec3 uLight; uniform float uDot; uniform float uEmissive; uniform float uPost; uniform float uDay;
varying vec3 vN; varying vec2 vUv; varying vec3 vC;
void main(){
  vec3 base = uColor*vC;
  if(uUseMap>0.5){ vec3 t=texture2D(uMap,vUv*uRep).rgb; t=pow(t,vec3(0.85)); base*= (uPost>0.5? floor(t*5.0+0.5)/5.0 : t); }
  float ndl = dot(normalize(vN), uLight);
  float band = ndl>0.5 ? 1.0 : (ndl>0.05 ? 0.86 : 0.72);
  vec3 col = base*band;
  if(band<1.0){ vec2 p = gl_FragCoord.xy/uDot; p = mat2(0.707,-0.707,0.707,0.707)*p; vec2 c = fract(p)-0.5; if(length(c)<(band<0.7?0.36:0.22)) col*=0.72; }
  col *= mix(vec3(0.42,0.46,0.72), vec3(1.08,1.04,0.98), uDay); float lum = dot(col, vec3(.299,.587,.114)); col = mix(vec3(lum), col, 1.18);
  col = mix(col, base*1.35, uEmissive);
  gl_FragColor = vec4(col,1.0);
}`;
const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
const DAY = { value: 1 };
const mats = new Map();
export function toon(color = 0xffffff, map = null, opts = {}) {
  const key = color + "|" + (map ? map.uuid : "") + "|" + (opts.emissive || 0) + (opts.post ? "p" : "") + (opts.side || "");
  if (mats.has(key)) return mats.get(key);
  const m = new THREE.ShaderMaterial({
    vertexShader: toonVS, fragmentShader: toonFS,
    uniforms: { uColor: { value: new THREE.Color(color) }, uMap: { value: map }, uUseMap: { value: map ? 1 : 0 }, uRep: { value: opts.rep || 1 }, uLight: { value: LIGHT }, uDot: { value: 5.0 * dpr }, uEmissive: { value: opts.emissive || 0 }, uPost: { value: opts.post ? 1 : 0 }, uDay: DAY },
    side: opts.side || THREE.FrontSide,
  });
  mats.set(key, m); return m;
}
const outVS = `uniform float uT; void main(){ mat4 im = mat4(1.);
  #ifdef USE_INSTANCING
    im = instanceMatrix;
  #endif
  vec4 mv=modelViewMatrix*im*vec4(position,1.); vec3 n=normalize(normalMatrix*mat3(im)*normal); mv.xyz+=n*uT*(-mv.z)*0.0042; gl_Position=projectionMatrix*mv; }`;
const outMats = new Map();
function outlineMat(t = 1) { if (!outMats.has(t)) outMats.set(t, new THREE.ShaderMaterial({ vertexShader: outVS, fragmentShader: `void main(){ gl_FragColor=vec4(0.06,0.05,0.07,1.); }`, uniforms: { uT: { value: t } }, side: THREE.BackSide })); return outMats.get(t); }
function outline(mesh, t = 1) {
  const o = mesh.isInstancedMesh ? new THREE.InstancedMesh(mesh.geometry, outlineMat(t), mesh.count) : new THREE.Mesh(mesh.geometry, outlineMat(t));
  if (mesh.isInstancedMesh) o.instanceMatrix = mesh.instanceMatrix;
  o.name = "outline"; o.raycast = () => {}; mesh.add(o); return mesh;
}
function M(geo, color, opts = {}) { const m = new THREE.Mesh(geo, toon(color, null, opts)); if (opts.outline !== false) outline(m, opts.ot || 1); return m; }
const G = { box: (w, h, d) => new THREE.BoxGeometry(w, h, d), cyl: (a, b, h, s = 10) => new THREE.CylinderGeometry(a, b, h, s), sph: (r, w = 12, h = 10) => new THREE.SphereGeometry(r, w, h) };
// ground overlays: drawn after the terrain with polygon offset and no depth write, so coplanar layers never z-fight
const decalMats = new Map();
function decal(mesh, layer = 1) {
  const src = mesh.material; const key = src.uuid + "|" + layer;
  if (!decalMats.has(key)) { const m = src.clone(); if (src.uniforms) m.uniforms = src.uniforms; m.polygonOffset = true; m.polygonOffsetFactor = -1 - layer; m.polygonOffsetUnits = -4 * layer; m.depthWrite = false; decalMats.set(key, m); }
  mesh.material = decalMats.get(key); mesh.renderOrder = layer; mesh.children.forEach((c) => { if (c.name === "outline") mesh.remove(c); }); return mesh;
}
function at(o, x, y, z, ry = 0) { o.position.set(x, y, z); o.rotation.y = ry; return o; }

// ---------- world ----------
export function createWorld(canvas, { onReady, lowPower, onPick, onUserOrbit, onLowQ } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowPower, powerPreference: "high-performance" });
  renderer.setPixelRatio(lowPower ? Math.min(dpr, 1.25) : dpr);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const SKY_DAY = new THREE.Color(0x8fd8ff), SKY_NIGHT = new THREE.Color(0x1d2347), SKY_DUSK = new THREE.Color(0xf6a26b);
  scene.background = SKY_DAY.clone();
  scene.fog = new THREE.Fog(0x8fe3e6, 70, 170);
  const amb = new THREE.AmbientLight(0xffffff, 1.1); scene.add(amb);
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.copy(LIGHT).multiplyScalar(30); scene.add(sun);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 320);
  camera.position.set(9, 9.5, 13);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 5; controls.maxDistance = 80; controls.maxPolarAngle = 1.32; controls.enablePan = false;
  controls.target.set(0, 0.8, 0);
  const picks = [];
  const pick = (obj, key) => { obj.userData.pick = key; picks.push(obj); return obj; };
  const rnd = mulberry(7);
  const P = PLACES;
  // the Fly Nest goes in the widest gap between the paths that leave the plaza
  const NEST = (() => { const angs = Object.keys(P).filter((k) => k !== "plaza").map((k) => Math.atan2(P[k].x - P.plaza.x, P[k].z - P.plaza.z)).sort((a, b) => a - b); let best = 0, ba = 0; angs.forEach((a, i) => { const b = i + 1 < angs.length ? angs[i + 1] : angs[0] + Math.PI * 2; if (b - a > best) { best = b - a; ba = (a + b) / 2; } }); return { x: P.plaza.x + Math.sin(ba) * 4.6, z: P.plaza.z + Math.cos(ba) * 4.6, a: ba }; })();
  // Espresso: Greg's espresso spot is inside the rotunda, the door faces the plaza
  const ESP = (() => { const b = P.bakery, dx = P.plaza.x - b.x, dz = P.plaza.z - b.z, l = Math.hypot(dx, dz); return { x: b.x - (dx / l) * 0.25, z: b.z - (dz / l) * 0.25, ry: Math.atan2(dx, dz) }; })();
  const HQ = (() => { const o = Math.hypot(P.desk.x, P.desk.z), ox = P.desk.x / o, oz = P.desk.z / o; const ry = Math.atan2(oz, -ox); const c = Math.cos(ry), s = Math.sin(ry); const lx = -0.4, lz = -1.75; return { ry, x: P.desk.x - (lx * c + lz * s), z: P.desk.z - (-lx * s + lz * c) }; })();

  // water + ocean
  const waterU = { uTime: { value: 0 }, uDay: DAY };
  const water = new THREE.Mesh(new THREE.CircleGeometry(220, 48), new THREE.ShaderMaterial({
    uniforms: waterU,
    vertexShader: `varying vec2 vP; void main(){ vP=position.xy; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform float uTime; uniform float uDay; varying vec2 vP; void main(){ float r=length(vP); vec3 c=mix(vec3(0.22,0.66,0.78),vec3(0.10,0.38,0.62),smoothstep(25.,100.,r));
      float w=sin(r*1.6-uTime*1.4)+sin(vP.x*0.7+uTime*0.7)*0.6; if((w>1.35 && r>25.6) || (r>25.2 && r<26.4 && sin(r*9.-uTime*3.)>-.2)) c=mix(c,vec3(0.85,0.97,1.),0.75);
      vec2 p=gl_FragCoord.xy/7.; p=mat2(.707,-.707,.707,.707)*p; if(length(fract(p)-.5)<.18 && r>28.) c*=0.93;
      c*=mix(vec3(0.35,0.4,0.7),vec3(1.),uDay); gl_FragColor=vec4(c,1.);} `,
  }));
  water.rotation.x = -Math.PI / 2; water.position.y = -0.45; scene.add(water);

  // island
  const isl = new THREE.Group(); scene.add(isl);
  const ground = new THREE.Mesh(G.cyl(R_ISLAND, R_ISLAND + 1.1, 1.3, 48), toon(0xffffff, tileTex("grass", renderer), { rep: 18 })); outline(ground); ground.position.y = -0.65; isl.add(ground);
  const sand = new THREE.Mesh(G.cyl(R_ISLAND + 1.4, R_ISLAND + 2, 0.5, 48), toon(0xffffff, tileTex("sand", renderer), { rep: 22 })); sand.position.y = -0.55; isl.add(sand);
  const beachPatch = M(new THREE.CircleGeometry(4.2, 20), 0xf6e2a4, { outline: false }); beachPatch.rotation.x = -Math.PI / 2; at(beachPatch, P.beach.x, 0.02, P.beach.z + 0.8); decal(beachPatch, 1); isl.add(beachPatch);

  // paths: ONE painted cobblestone layer (a top-down canvas) so ribbons never overlap or z-fight.
  // A plaza ring, a ring round the putting green, and gently curved spokes from the plaza edge to every spot.
  { const SZ = 2048, half = R_ISLAND + 0.6, k = SZ / (2 * half), X = (x) => (x + half) * k, Z = (z) => (z + half) * k;
    const cv = document.createElement("canvas"); cv.width = cv.height = SZ; const c = cv.getContext("2d");
    const tile = document.createElement("canvas"); tile.width = tile.height = 96; { const t = tile.getContext("2d"); t.fillStyle = "#b9a58a"; t.fillRect(0, 0, 96, 96); let r = 7; const rr = () => ((r = (r * 16807) % 2147483647) / 2147483647); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { const cx = j * 24 + 12 + (i % 2) * 12, cy = i * 24 + 12; t.fillStyle = ["#d8c6a8", "#cdb99a", "#e2d2b6", "#c4ae8e"][(i + j) % 4]; t.strokeStyle = "rgba(60,45,30,.55)"; t.lineWidth = 2.5; t.beginPath(); t.ellipse(cx % 96, cy, 10 + rr() * 1.5, 9 + rr() * 1.5, rr(), 0, 7); t.fill(); t.stroke(); t.fillStyle = "rgba(255,255,255,.18)"; t.beginPath(); t.ellipse((cx % 96) - 3, cy - 3, 4, 3, 0, 0, 7); t.fill(); } }
    const pat = c.createPattern(tile, "repeat");
    const W = 1.5 * k; // path width
    const spokes = [];
    for (const key of Object.keys(P)) { if (key === "plaza") continue; const b2 = P[key], a2 = P.plaza; const L = Math.hypot(b2.x - a2.x, b2.z - a2.z); const ux = (b2.x - a2.x) / L, uz = (b2.z - a2.z) / L; const s0 = [a2.x + ux * 2.9, a2.z + uz * 2.9]; const mid = [(s0[0] + b2.x) / 2 - uz * L * 0.08, (s0[1] + b2.z) / 2 + ux * L * 0.08]; spokes.push([s0, mid, [b2.x - ux * 1.2, b2.z - uz * 1.2]]); }
    const trace = () => { c.beginPath(); c.arc(X(P.plaza.x), Z(P.plaza.z), 2.9 * k, 0, 7); for (const [s0, m, e] of spokes) { c.moveTo(X(s0[0]), Z(s0[1])); c.quadraticCurveTo(X(m[0]), Z(m[1]), X(e[0]), Z(e[1])); } };
    c.lineCap = c.lineJoin = "round";
    trace(); c.strokeStyle = "rgba(70,55,35,.9)"; c.lineWidth = W + 0.2 * k; c.stroke();          // dark edge
    trace(); c.strokeStyle = pat; c.lineWidth = W; c.stroke();                                    // cobbles
    c.beginPath(); c.arc(X(P.green.x), Z(P.green.z), 3.2 * k, 0, 7); c.strokeStyle = "rgba(70,55,35,.9)"; c.lineWidth = 1.3 * k; c.stroke(); c.strokeStyle = pat; c.lineWidth = 1.1 * k; c.stroke();
    c.beginPath(); c.arc(X(P.plaza.x), Z(P.plaza.z), 2.9 * k, 0, 7); c.fillStyle = pat; c.fill(); c.strokeStyle = "rgba(70,55,35,.9)"; c.lineWidth = 0.2 * k; c.stroke();
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const paths = new THREE.Mesh(new THREE.PlaneGeometry(2 * half, 2 * half), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }));
    paths.material.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <dithering_fragment>", "#include <dithering_fragment>\n gl_FragColor.rgb *= vec3(1.06, 1.0, 0.93);"); };
    paths.rotation.x = -Math.PI / 2; paths.position.y = 0.02; paths.renderOrder = 2; paths.userData.noCollide = true; isl.add(paths); }
  const fountain = M(G.cyl(0.9, 1.1, 0.5, 14), 0xb9bcc8); at(fountain, P.plaza.x, 0.25, P.plaza.z); isl.add(fountain);
  const fw = M(G.cyl(0.75, 0.75, 0.06, 14), 0x4ab8ff, { outline: false, emissive: 0.2 }); at(fw, P.plaza.x, 0.52, P.plaza.z); isl.add(fw);

  // ---------- instanced nature (trees, bushes, flowers, reeds, rocks, lily pads) ----------
  const keepClear = (x, z, r = 2.6) => Object.values(P).some((p) => Math.hypot(p.x - x, p.z - z) < r) || Math.hypot(x - NEST.x, z - NEST.z) < r + 0.6 || Math.hypot(x - ESP.x, z - ESP.z) < r + 3 || Math.hypot(x - HQ.x, z - HQ.z) < r + 4.5 || Math.abs(x) < 0.9 && z > -10 && z < 12;
  function scatter(n, rMin, rMax, clear) { const out = []; let guard = 0; while (out.length < n && guard++ < n * 30) { const a = rnd() * Math.PI * 2, r = rMin + rnd() * (rMax - rMin); const x = Math.cos(a) * r, z = Math.sin(a) * r; if (clear && keepClear(x, z, clear)) continue; out.push([x, z]); } return out; }
  function instanced(geo, color, pts, f, ot = 1, colors) {
    const m = new THREE.InstancedMesh(geo, toon(color), pts.length); const d = new THREE.Object3D();
    pts.forEach((p, i) => { d.position.set(p[0], 0, p[1]); d.rotation.set(0, rnd() * 6.28, 0); d.scale.setScalar(1); f && f(d, i); d.updateMatrix(); m.setMatrixAt(i, d.matrix); if (colors) m.setColorAt(i, new THREE.Color(colors[i % colors.length])); });
    if (ot) outline(m, ot); isl.add(m); return m;
  }
  const treeSpots = scatter(lowPower ? 22 : 32, 13, R_ISLAND - 1.2, 4.5);
  instanced(G.cyl(0.25, 0.38, 3.2, 6), 0x8a5a33, treeSpots, (d) => { d.position.y = 1.6; });
  instanced(new THREE.IcosahedronGeometry(1.05, 0), 0xffffff, treeSpots, (d, i) => { d.position.y = 4.0; d.scale.setScalar(1.6 + (i % 5) * 0.2); }, 1, [0x3fae4a, 0x58c85a, 0x4bbf55]);
  instanced(new THREE.IcosahedronGeometry(0.55, 0), 0xffffff, scatter(lowPower ? 30 : 50, 3, R_ISLAND - 0.6, 1.8), (d) => { d.position.y = 0.35; d.scale.set(1.3, 0.8, 1.1); }, 0.8, [0x4fa83f, 0x67c24c]);
  instanced(new THREE.ConeGeometry(0.13, 0.28, 5), 0xffffff, scatter(lowPower ? 60 : 120, 2.5, R_ISLAND - 0.4, 1.4), (d) => { d.position.y = 0.14; d.rotation.x = Math.PI; }, 0, [0xff8fc0, 0xffd23f, 0xffffff, 0xb08cff]);
  instanced(G.cyl(0.03, 0.05, 1.3, 4), 0x4f9a3a, scatter(60, R_ISLAND + 0.6, R_ISLAND + 2.4, 0), (d) => { d.position.y = 0.2; d.rotation.z = (rnd() - 0.5) * 0.4; d.scale.y = 0.7 + rnd() * 0.8; }, 0.6);
  instanced(new THREE.DodecahedronGeometry(0.45, 0), 0x9a9caa, scatter(18, 4, R_ISLAND, 2.2), (d) => { d.position.y = 0.15; d.scale.set(1.2, 0.6 + rnd() * 0.5, 1); }, 0.8);
  const pads = instanced(G.cyl(0.8, 0.8, 0.05, 12), 0x43b049, scatter(26, R_ISLAND + 3, R_ISLAND + 12, 0), (d) => { d.position.y = -0.3; d.scale.setScalar(0.6 + rnd() * 0.8); }, 0.6);
  pads.position.y = 0;

  // clouds, birds, planes
  const clouds = new THREE.Group(); scene.add(clouds);
  for (let i = 0; i < 7; i++) {
    const c = new THREE.Group(); const n = 3 + Math.floor(rnd() * 3);
    for (let j = 0; j < n; j++) { const b = M(new THREE.IcosahedronGeometry(1.4 + rnd() * 1, 1), 0xffffff, { ot: 0.8 }); b.position.set(j * 1.8, rnd() * 0.6, rnd() * 0.8); c.add(b); }
    const a = rnd() * Math.PI * 2; c.position.set(Math.cos(a) * 45, 16 + rnd() * 6, Math.sin(a) * 45); c.userData.s = 0.3 + rnd() * 0.4; clouds.add(c);
  }
  const birds = []; for (let i = 0; i < 5; i++) { const b = new THREE.Group(); for (const s of [-1, 1]) { const w = M(G.box(0.5, 0.04, 0.14), 0x222233, { outline: false }); w.position.x = s * 0.25; w.userData.s = s; b.add(w); } b.userData = { a: rnd() * 6.28, r: 10 + rnd() * 14, h: 9 + rnd() * 4, sp: 0.15 + rnd() * 0.15 }; scene.add(b); birds.push(b); }
  const plane = buildPlane(); scene.add(plane); plane.visible = false; let planeT = -1, nextPlane = 8;

  // fireflies (night) + rain + tenant flies
  const fireGeo = new THREE.BufferGeometry(); const fp = new Float32Array(60 * 3); for (let i = 0; i < 60; i++) { const a = rnd() * 6.28, r = 2 + rnd() * (R_ISLAND - 2); fp.set([Math.cos(a) * r, 0.6 + rnd() * 1.5, Math.sin(a) * r], i * 3); }
  fireGeo.setAttribute("position", new THREE.BufferAttribute(fp, 3));
  const fireflies = new THREE.Points(fireGeo, new THREE.PointsMaterial({ color: 0xfff27a, size: 0.18, transparent: true, opacity: 0.9 })); scene.add(fireflies);
  const rainGeo = new THREE.BufferGeometry(); const rp = new Float32Array(900 * 3); for (let i = 0; i < 900; i++) rp.set([(rnd() - 0.5) * 50, rnd() * 25, (rnd() - 0.5) * 50], i * 3);
  rainGeo.setAttribute("position", new THREE.BufferAttribute(rp, 3));
  const rain = new THREE.Points(rainGeo, new THREE.PointsMaterial({ color: 0xbfe6ff, size: 0.08, transparent: true, opacity: 0.7 })); scene.add(rain); rain.visible = false;
  const flyGeo = new THREE.BufferGeometry(); const flyPos = new Float32Array(12 * 3); flyGeo.setAttribute("position", new THREE.BufferAttribute(flyPos, 3));
  const flies = new THREE.Points(flyGeo, new THREE.PointsMaterial({ color: 0x141218, size: 0.14 })); scene.add(flies);

  // ---------- places ----------
  // golf course: 3 holes with flags, bunkers, cart, bag, balls, trophy case
  const holes = [[P.green.x, P.green.z], [P.green.x - 5, P.green.z - 3.8], [P.green.x + 5.4, P.green.z - 4.2]];
  const flagCloths = [];
  holes.forEach(([x, z], i) => {
    const gr = M(new THREE.CircleGeometry(2.6, 26), 0x9be36a, { outline: false }); gr.rotation.x = -Math.PI / 2; at(gr, x, 0.03, z); decal(gr, 4); isl.add(gr); pick(gr, "golf");
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 1.75, 26), toon(0x8ad45c)); ring.rotation.x = -Math.PI / 2; at(ring, x, 0.035, z); decal(ring, 5); isl.add(ring);
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.16, 14), toon(0x1a1a1a)); hole.rotation.x = -Math.PI / 2; at(hole, x - 0.9, 0.04, z - 0.6); decal(hole, 6); isl.add(hole);
    if (i > 0) { const pole = M(G.cyl(0.04, 0.04, 2.4, 6), 0xffffff, { ot: 0.6 }); at(pole, x - 0.9, 1.2, z - 0.6); isl.add(pole); const cloth = M(flagGeo(), 0xff4a3a, { side: THREE.DoubleSide, outline: false }); at(cloth, x - 0.9, 0, z - 0.6); isl.add(cloth); flagCloths.push(cloth); }
    const nb = M(new THREE.CircleGeometry(0.9, 14), 0xf6e2a4, { outline: false }); nb.rotation.x = -Math.PI / 2; at(nb, x + 2.4, 0.03, z + 1.1); decal(nb, 4); isl.add(nb);
  });
  const holeP = new THREE.Vector3(holes[0][0] - 0.9, 0, holes[0][1] - 0.6);
  const ballMesh = M(G.sph(0.09, 10, 8), 0xffffff, { ot: 0.6 }); at(ballMesh, P.green.x + 0.8, 0.1, P.green.z + 0.9); isl.add(ballMesh);
  const golfArea = new THREE.Group(); at(golfArea, P.green.x - 3.2, 0, P.green.z + 2.6, 0.5); isl.add(golfArea); pick(golfArea, "golf");
  { // cart
    const cart = new THREE.Group(); at(cart, 0, 0, 0); golfArea.add(cart);
    const body = M(G.box(1.4, 0.5, 0.9), 0xffffff); body.position.y = 0.6; cart.add(body);
    const seat = M(G.box(0.6, 0.3, 0.8), 0xe85d75); seat.position.set(-0.2, 0.95, 0); cart.add(seat);
    const roof = M(G.box(1.5, 0.08, 1.0), 0x3ea24a); roof.position.y = 1.8; cart.add(roof);
    for (const [x, zz] of [[-0.55, 0.55], [0.55, 0.55], [-0.55, -0.55], [0.55, -0.55]]) { const w = M(G.cyl(0.22, 0.22, 0.14, 12), 0x222222, { ot: 0.6 }); w.rotation.x = Math.PI / 2; w.position.set(x, 0.22, zz); cart.add(w); }
    for (const x of [-0.65, 0.65]) { const post = M(G.box(0.06, 0.9, 0.06), 0xdddddd, { ot: 0.5 }); post.position.set(x, 1.35, 0); cart.add(post); }
    const bag = M(G.cyl(0.22, 0.2, 0.9, 10), 0x8a5a33); at(bag, 1.3, 0.45, 0.4); golfArea.add(bag);
    for (let i = 0; i < 4; i++) { const cl = M(G.cyl(0.02, 0.02, 0.5, 5), 0xcccccc, { ot: 0.4 }); cl.position.set(1.25 + (i % 2) * 0.1, 1.05, 0.35 + (i >> 1) * 0.1); golfArea.add(cl); }
    for (let i = 0; i < 6; i++) { const b = M(G.sph(0.08, 8, 6), 0xffffff, { ot: 0.4 }); const row = i < 3 ? 0 : i < 5 ? 1 : 2; b.position.set(1.9 + (i < 3 ? i * 0.17 : i < 5 ? 0.08 + (i - 3) * 0.17 : 0.17), 0.08 + row * 0.14, -0.4); golfArea.add(b); }
  }
  const shelf = new THREE.Group(); at(shelf, P.green.x + 4.2, 0, P.green.z - 1.2, -1.2); isl.add(shelf); pick(shelf, "trophies");
  { const back = M(G.box(1.8, 1.6, 0.4), 0x8a5a33); back.position.y = 0.8; shelf.add(back); const glass = M(G.box(1.6, 1.4, 0.05), 0x9fe8ff, { outline: false, emissive: 0.2 }); glass.position.set(0, 0.85, 0.22); shelf.add(glass);
    for (const [x, h] of [[-0.5, 0.45], [0, 0.6], [0.5, 0.38]]) { const cup = M(G.cyl(0.14, 0.06, h, 10), 0xffd23f, { emissive: 0.25 }); cup.position.set(x, 1.0 + h / 2 - 0.2, 0.1); shelf.add(cup); } }

  // home: lily pad + couch + TV + rug + lamp + art wall + posters
  const homeG = new THREE.Group(); isl.add(homeG);
  const deck = M(G.cyl(4.2, 4.2, 0.14, 24), 0xc48c55); at(deck, P.home.x + 0.4, 0.07, P.home.z + 0.6); homeG.add(deck); pick(deck, "home");
  const rug = M(G.cyl(1.2, 1.2, 0.04, 18), 0xe85d75, { outline: false }); at(rug, P.home.x + 1.6, 0.16, P.home.z - 0.4); homeG.add(rug);
  const couch = new THREE.Group(); at(couch, P.home.x + 1.6, 0.14, P.home.z - 1.6, 0); homeG.add(couch); pick(couch, "home");
  { const base = M(G.box(1.8, 0.45, 0.8), 0x6a4cff); base.position.y = 0.32; couch.add(base); const back = M(G.box(1.8, 0.6, 0.25), 0x5a3ee6); back.position.set(0, 0.75, -0.3); couch.add(back); for (const s of [-1, 1]) { const arm = M(G.box(0.25, 0.55, 0.8), 0x5a3ee6); arm.position.set(s * 0.9, 0.5, 0); couch.add(arm); } }
  const tv = new THREE.Group(); at(tv, P.home.x + 1.6, 0.14, P.home.z + 0.9, Math.PI); homeG.add(tv); pick(tv, "tv");
  { const st = M(G.box(1.2, 0.5, 0.4), 0x3b3f4a); st.position.y = 0.25; tv.add(st); const sc = M(G.box(1.4, 0.8, 0.08), 0x141218); sc.position.y = 0.95; tv.add(sc); }
  const tvScreen = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 0.65), toon(0x7ad8ff, null, { emissive: 1 })); tvScreen.position.set(0, 0.95, -0.05); tvScreen.rotation.y = Math.PI; tv.add(tvScreen);
  const lamp = new THREE.Group(); at(lamp, P.home.x + 3.0, 0.14, P.home.z - 1.7); homeG.add(lamp);
  { const pole = M(G.cyl(0.04, 0.04, 1.6, 6), 0x333333, { ot: 0.5 }); pole.position.y = 0.8; lamp.add(pole); const shade = M(G.cyl(0.2, 0.35, 0.35, 10), 0xffe6a6, { emissive: 0.5 }); shade.position.y = 1.7; lamp.add(shade); }
  const binder = new THREE.Group(); at(binder, P.home.x - 1.4, 0.14, P.home.z + 2.6, 0.5); homeG.add(binder); pick(binder, "binder");
  { const bt = M(G.box(0.4, 0.9, 0.7), 0x6a4cff); bt.position.y = 0.45; bt.rotation.z = 0.1; binder.add(bt); const bl = M(G.box(0.42, 0.25, 0.25), 0xffd23f, { outline: false }); bl.position.set(0, 0.6, 0.24); binder.add(bl); }
  const diaryBook = new THREE.Group(); at(diaryBook, P.home.x + 0.2, 0.2, P.home.z + 2.2); homeG.add(diaryBook); pick(diaryBook, "diary");
  { const db = M(G.box(0.6, 0.14, 0.45), 0xe85d75); db.position.y = 0.07; diaryBook.add(db); }
  // art wall with dream posters (canvas textures, original art)
  const artWall = new THREE.Group(); at(artWall, P.art.x, 0, P.art.z + 1.4, Math.PI); isl.add(artWall); pick(artWall, "art");
  { const wall = M(G.box(5.2, 2.6, 0.25), 0xfff3c4); wall.position.y = 1.3; artWall.add(wall);
    const posters = [["✈", "#4ab8ff", "FLY"], ["⛳", "#3ea24a", "ST ANDREWS"], ["🧜", "#7a5cff", "THE OCEAN"], ["🏛", "#f28a2e", "THE LOUVRE"]];
    posters.forEach(([e, c, t], i) => { const f = new THREE.Mesh(G.box(1.0, 1.25, 0.08), toon(0x5a3a1e)); f.position.set(-1.8 + i * 1.2, 1.4, -0.16); artWall.add(f);
      const pic = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 1.1), new THREE.MeshBasicMaterial({ map: posterTex(e, c, t) })); pic.position.set(-1.8 + i * 1.2, 1.4, -0.21); pic.rotation.y = Math.PI; artWall.add(pic); }); }
  // kitchen
  const kitchen = new THREE.Group(); at(kitchen, P.kitchen.x - 0.6, 0, P.kitchen.z + 1.6, Math.PI); isl.add(kitchen); pick(kitchen, "kitchen");
  const steam = [];
  { const floor = M(G.box(4.2, 0.12, 2.6), 0xe9e3d0, { outline: false }); floor.position.set(0, 0.06, -0.6); kitchen.add(floor);
    const counter = M(G.box(2.6, 0.9, 0.7), 0xffffff); counter.position.set(-0.3, 0.45, 0); kitchen.add(counter);
    const top = M(G.box(2.7, 0.08, 0.75), 0x8a5a33, { outline: false }); top.position.set(-0.3, 0.94, 0); kitchen.add(top);
    const stove = M(G.box(0.8, 0.92, 0.7), 0x3b3f4a); stove.position.set(1.4, 0.46, 0); kitchen.add(stove);
    const pot = M(G.cyl(0.22, 0.2, 0.3, 12), 0xb9bcc8); pot.position.set(1.4, 1.07, 0); kitchen.add(pot);
    const fridge = M(G.box(0.8, 1.8, 0.7), 0xdff3ff); fridge.position.set(-1.95, 0.9, 0); kitchen.add(fridge);
    const rack = M(G.box(0.9, 0.08, 0.15), 0x8a5a33); rack.position.set(-0.4, 1.6, 0.25); kitchen.add(rack);
    for (let i = 0; i < 4; i++) { const j = M(G.cyl(0.05, 0.05, 0.14, 6), [0xff5a4a, 0xffd23f, 0x3ea24a, 0xf28a2e][i], { ot: 0.4 }); j.position.set(-0.7 + i * 0.2, 1.71, 0.25); kitchen.add(j); }
    const table = M(G.cyl(0.6, 0.6, 0.08, 14), 0xb57a45); table.position.set(0.2, 0.72, -1.6); kitchen.add(table);
    const tleg = M(G.cyl(0.06, 0.06, 0.7, 6), 0x8a5a33, { ot: 0.5 }); tleg.position.set(0.2, 0.36, -1.6); kitchen.add(tleg);
    for (let i = 0; i < 4; i++) { const s = M(G.sph(0.12, 6, 5), 0xffffff, { outline: false }); s.material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }); s.position.set(1.4, 1.3, 0); s.userData.noCollide = true; kitchen.add(s); steam.push(s); } }
  // trading desk with monitors (live canvas texture)
  const screenCanvas = document.createElement("canvas"); screenCanvas.width = 512; screenCanvas.height = 256;
  const screenTex = new THREE.CanvasTexture(screenCanvas); screenTex.colorSpace = THREE.SRGBColorSpace;
  // Greg HQ: the chair sits exactly on his desk spot, the sea window faces outward
  const hq = buildHQ(SCALE, screenTex, renderer); at(hq, HQ.x, 0, HQ.z, HQ.ry); isl.add(hq); pick(hq, "desk");
  // reading nook: bookshelf + armchair + lamp
  const nook = new THREE.Group(); at(nook, P.nook.x - 1.1, 0, P.nook.z, Math.PI / 2); isl.add(nook); pick(nook, "books");
  { const sh = M(G.box(1.8, 2.2, 0.45), 0x8a5a33); sh.position.y = 1.1; nook.add(sh);
    const books = new THREE.InstancedMesh(G.box(0.12, 0.42, 0.3), toon(0xffffff), 36); const d = new THREE.Object3D();
    for (let i = 0; i < 36; i++) { const row = Math.floor(i / 12); d.position.set(-0.75 + (i % 12) * 0.135, 0.42 + row * 0.62, 0.1); d.rotation.set(0, 0, (rnd() - 0.5) * 0.1); d.updateMatrix(); books.setMatrixAt(i, d.matrix); books.setColorAt(i, new THREE.Color([0xe85d75, 0x4ab8ff, 0xffd23f, 0x3ea24a, 0x7a5cff, 0xf28a2e][i % 6])); }
    nook.add(books);
    const arm = new THREE.Group(); arm.position.set(0, 0, 1.6); nook.add(arm);
    const as = M(G.box(1.0, 0.45, 0.9), 0x3ea24a); as.position.y = 0.3; arm.add(as); const ab = M(G.box(1.0, 0.8, 0.22), 0x2f8a3a); ab.position.set(0, 0.8, -0.35); arm.add(ab); }
  // studio: GLB shed + synth + piano
  // workbench + easel
  const bench = new THREE.Group(); at(bench, P.bench.x + 1.0, 0, P.bench.z + 0.4, -0.9); isl.add(bench); pick(bench, "projects");
  { const top = M(G.box(2.2, 0.16, 1), 0xb57a45); top.position.y = 0.95; bench.add(top);
    for (const [x, z] of [[-1, -0.4], [1, -0.4], [-1, 0.4], [1, 0.4]]) { const l = M(G.box(0.12, 0.9, 0.12), 0x8a5a33, { ot: 0.7 }); l.position.set(x, 0.45, z); bench.add(l); }
    const lap = M(G.box(0.7, 0.05, 0.5), 0x3b3f4a); lap.position.set(-0.3, 1.06, 0); bench.add(lap);
    const lsc = M(G.box(0.7, 0.45, 0.04), 0x3b3f4a); lsc.position.set(-0.3, 1.3, -0.25); lsc.rotation.x = -0.2; bench.add(lsc);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.36), toon(0x9cff6b, null, { emissive: 1 })); glow.position.set(-0.3, 1.3, -0.225); glow.rotation.x = -0.2; bench.add(glow);
    const hammer = M(G.box(0.5, 0.08, 0.1), 0x777788, { ot: 0.6 }); hammer.position.set(0.6, 1.07, 0.1); hammer.rotation.y = 0.6; bench.add(hammer); }
  const easel = new THREE.Group(); at(easel, P.bench.x - 1.6, 0, P.bench.z + 1.4, 0.4); isl.add(easel); pick(easel, "projects");
  { for (const s of [-1, 1]) { const l = M(G.box(0.07, 1.8, 0.07), 0x8a5a33, { ot: 0.5 }); l.position.set(s * 0.35, 0.9, 0); l.rotation.z = s * 0.12; easel.add(l); }
    const cv = M(G.box(0.9, 0.7, 0.05), 0xffffff); cv.position.set(0, 1.25, 0.05); easel.add(cv);
    const paint = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.6), new THREE.MeshBasicMaterial({ map: posterTex("🐸", "#9be36a", "") })); paint.position.set(0, 1.25, 0.08); easel.add(paint); }
  // server rock + prediction board + wallet chest
  const rock = new THREE.Group(); at(rock, P.rock.x, 0, P.rock.z); isl.add(rock); pick(rock, "rock");
  const boulder = M(new THREE.DodecahedronGeometry(1.15, 0), 0x8d8f9c); boulder.scale.set(1.2, 0.8, 1); boulder.position.y = 0.6; rock.add(boulder);
  const crystal = M(new THREE.OctahedronGeometry(0.42, 0), 0xb6ff52, { emissive: 0.8 }); crystal.position.y = 1.95; rock.add(crystal);
  const nodes = []; for (let i = 0; i < 3; i++) { const n = M(G.sph(0.13, 8, 6), 0xb6ff52, { emissive: 0.8, ot: 0.6 }); rock.add(n); nodes.push(n); }
  const board = new THREE.Group(); at(board, P.rock.x + 2.2, 0, P.rock.z - 1.4, 0.7); isl.add(board); pick(board, "predictions");
  { const bp = M(G.box(1.7, 1.1, 0.08), 0x2f4a3a); bp.position.y = 1.45; board.add(bp); for (const x of [-0.7, 0.7]) { const l = M(G.box(0.08, 1.5, 0.08), 0x8a5a33, { ot: 0.6 }); l.position.set(x, 0.75, -0.06); board.add(l); } }
  const bars = []; for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(G.box(0.3, 0.6, 0.02), toon([0x9cff6b, 0xff6b6b, 0xffd23f][i], null, { emissive: 0.6 })); b.position.set(-0.45 + i * 0.45, 1.25, 0.05); board.add(b); bars.push(b); }
  const chest = new THREE.Group(); at(chest, P.rock.x - 1.8, 0, P.rock.z + 1.5, 1.1); isl.add(chest); pick(chest, "wallet");
  { const cb = M(G.box(0.8, 0.5, 0.55), 0xb57a45); cb.position.y = 0.25; chest.add(cb); }
  const coin = M(G.cyl(0.12, 0.12, 0.04, 14), 0xffd23f, { emissive: 0.5, ot: 0.6 }); coin.position.set(0, 0.95, 0); coin.rotation.x = Math.PI / 2; chest.add(coin);
  // town strip: web cafe + bakery + street lamps + benches + ATM + news stand + cafe tables
  const town = new THREE.Group(); isl.add(town);
  const cafe = new THREE.Group(); at(cafe, P.cafe.x + 2.2, 0, P.cafe.z - 2.2, -0.8); cafe.scale.setScalar(2.4); town.add(cafe); pick(cafe, "cafe");
  { const cw = M(G.box(2.4, 1.8, 1.8), 0x7a5cff); cw.position.y = 0.9; cafe.add(cw); const cr = M(G.box(2.7, 0.2, 2.1), 0x2b2540); cr.position.y = 1.9; cafe.add(cr);
    const cs = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.6), toon(0x9cff6b, null, { emissive: 1 })); cs.position.set(0, 1.05, 0.91); cafe.add(cs);
    const sign = makeLabel("WEB CAFE", 30, "#111", "#b6e452", true); sign.position.set(0, 2.45, 0.3); sign.scale.set(2.0, 0.5, 1); cafe.add(sign); }
  const espresso = buildEspresso(SCALE); at(espresso, ESP.x, 0, ESP.z, ESP.ry); town.add(espresso); pick(espresso, "bakery");
  const nest = buildNest(); at(nest, NEST.x, 0, NEST.z, NEST.a + Math.PI); isl.add(nest);
  for (const [x, z] of [[P.cafe.x - 2.2, P.cafe.z + 1.2], [P.bakery.x + 3.6, P.bakery.z + 2.4]]) { // cafe tables with umbrellas
    const t = new THREE.Group(); at(t, x, 0, z); town.add(t);
    const tb = M(G.cyl(0.45, 0.45, 0.06, 12), 0xffffff); tb.position.y = 0.75; t.add(tb); const pole = M(G.cyl(0.03, 0.03, 2.0, 6), 0x777788, { ot: 0.4 }); pole.position.y = 1.0; t.add(pole);
    const um = M(new THREE.ConeGeometry(1.0, 0.4, 8), 0xff5a4a); um.position.y = 2.0; t.add(um); }
  const lampPts = [[3, -8], [8.2, -8.2], [-3, 4], [3, 4], [-3, -3], [5, 9], [-5, 10]];
  instanced(G.cyl(0.05, 0.06, 2.4, 6), 0x2b2540, lampPts, (d) => { d.position.y = 1.2; }, 0.6);
  const lampHeads = instanced(G.sph(0.18, 8, 6), 0xffe6a6, lampPts, (d) => { d.position.y = 2.45; }, 0.6);
  instanced(G.box(1.2, 0.12, 0.4), 0xb57a45, [[2.2, -2.6], [-2.4, 2.8], [P.mailbox.x + 1.6, P.mailbox.z - 1.2], [P.cafe.x - 3.4, P.cafe.z - 1.0]], (d) => { d.position.y = 0.45; }, 0.6);
  const atm = new THREE.Group(); at(atm, P.cafe.x - 2.6, 0, P.cafe.z - 2.6, 0.5); town.add(atm); pick(atm, "atm");
  { const a = M(G.box(0.7, 1.4, 0.5), 0x4ab8ff); a.position.y = 0.7; atm.add(a); const l = makeLabel("ATM (BROKE)", 24, "#111", "#fff", true); l.position.set(0, 1.7, 0); l.scale.set(1.4, 0.35, 1); atm.add(l); }
  const news = new THREE.Group(); at(news, P.bakery.x - 3.6, 0, P.bakery.z + 2.2, 0.4); town.add(news);
  { const n = M(G.box(1.0, 1.0, 0.6), 0x3ea24a); n.position.y = 0.5; news.add(n); const p = M(G.box(0.8, 0.5, 0.05), 0xffffff, { ot: 0.5 }); p.position.set(0, 1.2, 0.2); p.rotation.x = -0.3; news.add(p); }
  // signposts
  const sign = new THREE.Group(); at(sign, P.plaza.x + 2.2, 0, P.plaza.z + 1.6); isl.add(sign);
  { const pole = M(G.cyl(0.06, 0.06, 2.2, 6), 0x8a5a33, { ot: 0.5 }); pole.position.y = 1.1; sign.add(pole);
    [["GOLF", -0.8], ["TOWN", 0.6], ["HOME", 2.4], ["BEACH", 3.8]].forEach(([t, r], i) => { const b = M(G.box(0.9, 0.22, 0.06), 0xb57a45, { ot: 0.4 }); b.position.set(0, 1.4 + i * 0.25, 0); b.rotation.y = r; sign.add(b); }); }
  // mailbox (fills with notes)
  const mailbox = new THREE.Group(); at(mailbox, P.mailbox.x - 0.7, 0, P.mailbox.z + 0.3, 0.6); isl.add(mailbox); pick(mailbox, "mailbox");
  const mpost = M(G.box(0.14, 1.1, 0.14), 0x8a5a33, { ot: 0.7 }); mpost.position.y = 0.55; mailbox.add(mpost);
  const mbox = M(G.box(0.9, 0.6, 0.6), 0x4ab8ff); mbox.position.y = 1.35; mailbox.add(mbox);
  const mflag = M(G.box(0.06, 0.4, 0.18), 0xff4a3a, { ot: 0.6 }); mflag.position.set(0.5, 1.55, 0); mailbox.add(mflag);
  const pile = new THREE.InstancedMesh(G.box(0.42, 0.04, 0.3), toon(0xffffff), 40); { const d = new THREE.Object3D(); for (let i = 0; i < 40; i++) { d.position.set((rnd() - 0.5) * 0.9 + 0.2, 0.03 + Math.floor(i / 4) * 0.045, 0.55 + (rnd() - 0.5) * 0.7); d.rotation.y = rnd() * 3; d.updateMatrix(); pile.setMatrixAt(i, d.matrix); pile.setColorAt(i, new THREE.Color([0xffffff, 0xfff3c4, 0xffd9f2, 0xdff3ff][i % 4])); } } pile.count = 0; mailbox.add(pile);
  function setMail(n) { pile.count = Math.min(40, Math.ceil(Math.max(0, n) / 2)); mflag.rotation.z = n > 0 ? 0 : -1.4; }
  // dock + beach umbrella + bridge
  const dock = new THREE.Group(); at(dock, P.edge.x, 0, P.edge.z + 1.8); isl.add(dock);
  for (let i = 0; i < 7; i++) { const pl = new THREE.Mesh(G.box(1.6, 0.12, 0.42), toon(0xffffff, tileTex("wood", renderer))); outline(pl, 0.7); pl.position.set(0, 0.0, i * 0.46); dock.add(pl); }
  const beachG = new THREE.Group(); at(beachG, P.beach.x, 0, P.beach.z + 0.6); isl.add(beachG); pick(beachG, "beach");
  { const pole = M(G.cyl(0.04, 0.04, 2.2, 6), 0xffffff, { ot: 0.4 }); pole.position.set(0.8, 1.1, 0); beachG.add(pole); const um = M(new THREE.ConeGeometry(1.2, 0.5, 10), 0x4ab8ff); um.position.set(0.8, 2.2, 0); beachG.add(um);
    const towel = M(G.box(0.8, 0.03, 1.6), 0xff8fc0, { outline: false }); towel.position.set(-0.4, 0.03, 0.2); beachG.add(towel); }
  // paper plane hill + windsock
  const hill = M(new THREE.SphereGeometry(3.2, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), 0x6cc04a); hill.scale.y = 0.45; at(hill, P.hill.x - 1.2, 0, P.hill.z - 1.0); isl.add(hill); pick(hill, "hill");
  const sock = new THREE.Group(); at(sock, P.hill.x - 1.2, 1.4, P.hill.z - 1.0); isl.add(sock);
  { const pole = M(G.cyl(0.04, 0.04, 2.0, 6), 0xffffff, { ot: 0.4 }); pole.position.y = 1.0; sock.add(pole); }
  const sockCloth = M(new THREE.ConeGeometry(0.18, 0.9, 8, 1, true), 0xff6b2e, { side: THREE.DoubleSide, outline: false }); sockCloth.rotation.z = Math.PI / 2; sockCloth.position.set(0.45, 1.9, 0); sock.add(sockCloth);
  // flats (fly tenants) with buzzing flies
  const flats = new THREE.Group(); at(flats, P.flats.x + 2.2, 0, P.flats.z - 1.6, -0.4); flats.scale.setScalar(1.6); isl.add(flats); pick(flats, "flats");
  { const colors = [0xffd23f, 0x4ab8ff, 0xff8fc0, 0x9be36a]; for (let i = 0; i < 4; i++) { const b = M(G.box(0.9, 0.7, 0.9), colors[i]); b.position.set((i % 2) * 1.0 - 0.5, 0.35 + Math.floor(i / 2) * 0.72, 0); flats.add(b); const dr = M(G.box(0.25, 0.4, 0.04), 0x6e4526, { outline: false }); dr.position.set((i % 2) * 1.0 - 0.5, 0.25 + Math.floor(i / 2) * 0.72, 0.47); flats.add(dr); }
    const roof = M(G.box(2.1, 0.1, 1.1), 0x2b2540); roof.position.y = 1.5; flats.add(roof); }
  const flatsCenter = new THREE.Vector3(P.flats.x + 2.2, 1.8, P.flats.z - 1.6);
  // careers: gym, pitch, stage (shown once he tries them)
  const gym = new THREE.Group(); at(gym, P.gym.x + 1.0, 0, P.gym.z + 0.6); isl.add(gym); pick(gym, "gym"); gym.visible = false;
  { const rackB = M(G.box(1.6, 0.1, 0.5), 0x3b3f4a); rackB.position.y = 0.6; gym.add(rackB); for (const x of [-0.7, 0.7]) { const l = M(G.box(0.08, 0.6, 0.4), 0x3b3f4a, { ot: 0.5 }); l.position.set(x, 0.3, 0); gym.add(l); }
    for (let i = 0; i < 4; i++) { const db = M(G.cyl(0.08, 0.08, 0.3, 8), 0x777788, { ot: 0.4 }); db.rotation.z = Math.PI / 2; db.position.set(-0.5 + i * 0.33, 0.72, 0); gym.add(db); }
    const pad = M(G.cyl(0.6, 0.6, 0.06, 12), 0x43b049); pad.position.set(-1.4, 0.03, 1.0); gym.add(pad); const stn = M(new THREE.DodecahedronGeometry(0.3, 0), 0x9a9caa); stn.position.set(0.8, 0.3, 1.1); gym.add(stn); }
  const pitch = new THREE.Group(); at(pitch, P.pitch.x + 1.2, 0, P.pitch.z, -Math.PI / 2); isl.add(pitch); pick(pitch, "pitch"); pitch.visible = false;
  { for (const x of [-1.2, 1.2]) { const p = M(G.box(0.1, 1.2, 0.1), 0xffffff, { ot: 0.5 }); p.position.set(x, 0.6, 0); pitch.add(p); } const cb = M(G.box(2.5, 0.1, 0.1), 0xffffff, { ot: 0.5 }); cb.position.y = 1.2; pitch.add(cb);
    const net = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide })); net.position.set(0, 0.6, -0.4); pitch.add(net);
    const line = new THREE.Mesh(new THREE.RingGeometry(1.6, 1.7, 24), toon(0xffffff)); line.rotation.x = -Math.PI / 2; line.position.set(0, 0.03, 3.2); decal(line, 2); pitch.add(line); }
  const stage = new THREE.Group(); at(stage, P.stage.x - 0.4, 0, P.stage.z - 1.6, 0.3); isl.add(stage); pick(stage, "stage"); stage.visible = false;
  { const fl = M(G.box(3.0, 0.4, 1.8), 0x8a5a33); fl.position.y = 0.2; stage.add(fl); for (const s of [-1, 1]) { const c = M(G.box(0.5, 2.4, 0.2), 0xc0392b); c.position.set(s * 1.4, 1.6, -0.7); stage.add(c); }
    const top = M(G.box(3.4, 0.4, 0.3), 0xc0392b); top.position.set(0, 2.8, -0.7); stage.add(top); const spot = M(G.cyl(0.15, 0.25, 0.4, 8), 0x333333); spot.position.set(1.8, 2.2, 1.2); spot.rotation.x = 0.8; stage.add(spot); }
  const careerProps = { bodybuilder: gym, footballer: pitch, actor: stage };
  // graded card slabs (only the wallet's own Collector Crypt NFT images; empty stands until the first pull)
  const slabG = new THREE.Group(); at(slabG, P.home.x + 4.6, 0, P.home.z - 2.4, -0.6); isl.add(slabG);
  { const shelfB = M(G.box(3.6, 1.0, 0.8), 0x2b2540); shelfB.position.y = 0.5; slabG.add(shelfB); const spot = new THREE.Mesh(new THREE.ConeGeometry(1.6, 2.6, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff6c9, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })); spot.position.y = 2.3; slabG.add(spot); }
  const slabItems = new THREE.Group(); slabG.add(slabItems);
  const texLoader = new THREE.TextureLoader(); texLoader.setCrossOrigin("anonymous");
  let cardsKey = "";
  function setCards(cards) {
    const k = (cards || []).map((c) => c.mint).join(","); if (k === cardsKey) return; const isNew = cardsKey && k.length > cardsKey.length; cardsKey = k; slabItems.clear();
    const list = (cards || []).slice(0, 8);
    const n = Math.max(3, list.length);
    for (let i = 0; i < n; i++) {
      const c = list[i]; const g = new THREE.Group(); g.position.set(-1.4 + (i % 4) * 0.95, 1.0 + Math.floor(i / 4) * 0.0, (Math.floor(i / 4) ? -0.25 : 0.1)); slabItems.add(g);
      const stand = M(G.box(0.5, 0.08, 0.3), 0x777788, { ot: 0.4 }); stand.position.y = 0.04; g.add(stand);
      if (c) {
        g.userData.pick = { card: c };
        const acrylic = new THREE.Mesh(G.box(0.62, 0.95, 0.08), new THREE.MeshBasicMaterial({ color: 0xdff3ff, transparent: true, opacity: 0.35 })); acrylic.position.y = 0.55; g.add(acrylic);
        const face = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.7), new THREE.MeshBasicMaterial({ color: 0xffffff })); face.position.set(0, 0.5, 0.045); g.add(face);
        if (c.image) texLoader.load(c.image, (t) => { t.colorSpace = THREE.SRGBColorSpace; face.material.map = t; face.material.needsUpdate = true; });
        const lab = makeLabel((c.grade || "GRADED").slice(0, 10), 26, "#111", "#ffd23f", true); lab.position.set(0, 1.12, 0.05); lab.scale.set(0.6, 0.15, 1); g.add(lab);
        g.userData.slab = true;
      } else if (i === 0 && !list.length) {
        const pl = makeLabel("waiting for the first pull", 22, "#111", "#fff", true); pl.position.set(1.4, 1.5, 0.2); pl.scale.set(2.6, 0.65, 1); slabItems.add(pl);
      }
    }
    if (isNew) { cheerUntil = performance.now() + 4000; cheerKind = "green"; }
    rebuildPhysics();
  }
  pick(slabG, "binder");

  // construction / properties
  const propG = new THREE.Group(); isl.add(propG);

  // GLB slots: lily pad, shed, synth, flag (hole 1), piano
  const slots = {
    home: { pos: [P.home.x - 0.6, 0.14, P.home.z + 0.8], h: 0.6, w: 3.6, rot: 0.4, file: "lilypad.glb", fallback: () => lilyFallback() },
    shed: { pos: [P.shed.x + 2.6, 0, P.shed.z - 1.0], h: 5.6, rot: -1.2, file: "shed.glb", fallback: () => shedFallback() },
    synth: { pos: [P.shed.x - 0.4, 0, P.shed.z + 1.3], h: 1.15, rot: -2.2, file: "synth.glb", fallback: () => synthFallback() },
    piano: { pos: [P.shed.x - 0.2, 0, P.shed.z - 1.5], h: 1.6, rot: 0.1, file: "piano.glb", fallback: () => pianoFallback() },
    flag: { pos: [holeP.x, 0, holeP.z], h: 2.6, rot: 0.3, file: "flag.glb", fallback: () => flagFallback() },
  };
  const propGroups = {};
  for (const [k, s] of Object.entries(slots)) {
    const g = new THREE.Group(); g.position.set(...s.pos); g.rotation.y = s.rot; isl.add(g); propGroups[k] = g;
    g.add(s.fallback()); pick(g, { home: "home", shed: "studio", synth: "studio", piano: "piano", flag: "golf" }[k]);
  }
  const synthLights = []; for (let i = 0; i < 4; i++) { const l = new THREE.Mesh(G.sph(0.05, 6, 4), toon([0xff4a3a, 0x9cff6b, 0x4ad8ff, 0xffd23f][i], null, { emissive: 1 })); l.position.set(P.shed.x - 0.75 + i * 0.22, 1.4, P.shed.z + 1.15); isl.add(l); synthLights.push(l); pick(l, "studio"); }
  const notes = []; for (let i = 0; i < 3; i++) { const n = makeLabel("♪", 64, "#141218"); n.scale.setScalar(0.45); n.visible = false; scene.add(n); notes.push(n); }

  // ---------- Greg ----------
  const greg = new THREE.Group(); scene.add(greg); greg.userData.pick = "greg";
  const gregBody = new THREE.Group(); greg.add(gregBody);
  let gregModel = gregFallback(); gregBody.add(gregModel);
  let rig = null; // { mixer, actions: {walk, idle}, bones: {...} }
  // held props, attached to a hand anchor (bone or body-space fallback)
  const hand = new THREE.Group(); hand.position.set(0.48 * GREG_H / 2.2, 0.95 * GREG_H / 2.2, 0.32); gregBody.add(hand);
  const held = { club: clubFallback(), book: bookProp(), ball: ballProp(), plane: planeProp(), brush: brushProp(), cup: cupProp(), pan: panProp(), bag: bagProp(), stone: stoneProp(), phone: null };
  Object.values(held).forEach((p) => { if (p) { p.visible = false; hand.add(p); } });
  const emote = makeLabel("!", 80, "#141218", "#ffffff"); emote.scale.setScalar(0.7); emote.position.set(0.7, GREG_H + 0.6, 0); emote.visible = false; greg.add(emote);
  const zzz = []; for (let i = 0; i < 3; i++) { const z = makeLabel("z", 64, "#ffffff", null); z.scale.setScalar(0.4 + i * 0.12); greg.add(z); zzz.push(z); }
  const coins = []; for (let i = 0; i < 8; i++) { const c = M(G.cyl(0.1, 0.1, 0.03, 10), 0xffd23f, { emissive: 0.6, outline: false }); c.visible = false; scene.add(c); coins.push(c); }
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.7, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.03; greg.add(shadow);

  // ---------- GLB loading ----------
  const loader = new GLTFLoader();
  const loadGLB = (file) => new Promise((res) => loader.load(ASSET + file, (g) => res(g), undefined, () => res(null)));
  function toonify(root, height, width) {
    const meshes = []; root.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) meshes.push(o); });
    meshes.forEach((o) => {
      const src = Array.isArray(o.material) ? o.material[0] : o.material;
      const map = src?.map || null; if (map) map.colorSpace = THREE.SRGBColorSpace;
      if (o.isSkinnedMesh) { const m = new THREE.MeshToonMaterial({ map, color: map ? 0xffffff : (src?.color?.getHex?.() ?? 0xcccccc), gradientMap: toonGradient() }); o.material = m; o.frustumCulled = false; }
      else { o.material = toon(map ? 0xffffff : (src?.color?.getHex?.() ?? 0xcccccc), map, { post: true }); if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); outline(o, 0.9); }
    });
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root); const size = box.getSize(new THREE.Vector3());
    const s = width ? width / Math.max(size.x, size.z) : height / size.y;
    root.scale.multiplyScalar(s); root.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(root); const c = b2.getCenter(new THREE.Vector3());
    root.position.x -= c.x; root.position.z -= c.z; root.position.y -= b2.min.y;
    return root;
  }
  const loads = [];
  for (const [k, s] of Object.entries(slots)) loads.push(loadGLB(s.file).then((g) => { if (!g) return; const grp = propGroups[k]; grp.clear(); grp.add(toonify(g.scene, s.h, s.w)); }));
  loads.push(loadGLB("club.glb").then((g) => {
    if (!g) return; const c = toonify(g.scene, GREG_H * 0.65);
    // grip at the hand, head toward the ground: model is upright, so flip and offset by its height
    const holder = new THREE.Group(); c.rotation.z = Math.PI; c.position.y = 0.05; holder.add(c); holder.userData.len = GREG_H * 0.65;
    held.club.parent.remove(held.club); held.club = holder; holder.visible = false; hand.add(holder);
  }));
  loads.push(Promise.all([loadGLB("greg-walk.glb"), loadGLB("greg-idle.glb")]).then(async ([walk, idle]) => {
    if (walk && walk.animations?.length) {
      const root = walk.scene; toonify(root, GREG_H);
      gregBody.remove(gregModel); gregModel = root; gregBody.add(root);
      const mixer = new THREE.AnimationMixer(root);
      const actions = { walk: mixer.clipAction(walk.animations[0]) };
      if (idle?.animations?.length) actions.idle = mixer.clipAction(idle.animations[0]);
      Object.values(actions).forEach((a) => { a.play(); a.setEffectiveWeight(0); });
      const bones = {}; const NAMES = { rhand: "RightHand", rarm: "RightArm", rfore: "RightForeArm", larm: "LeftArm", lfore: "LeftForeArm", spine: "Spine02", head: "Head", hips: "Hips" };
      root.traverse((o) => { if (o.isBone) for (const [k, n] of Object.entries(NAMES)) if (o.name === n) bones[k] = o; });
      rig = { mixer, actions, bones, rest: {}, k: root.scale.x };
      for (const [k, b] of Object.entries(bones)) rig.rest[k] = b.quaternion.clone();
      return;
    }
    const g = await loadGLB("greg.glb"); if (!g) return; gregBody.remove(gregModel); gregModel = toonify(g.scene, GREG_H); gregBody.add(gregModel);
  }));
  // ---------- physics: static trimesh from the real geometry, Greg's capsule, light props ----------
  const phys = createPhysics(THREE);
  [water, clouds, plane, fireflies, rain, flies].forEach((o) => (o.userData.noCollide = true));
  [crystal, ...nodes, ...flagCloths, sockCloth, ...synthLights, propGroups.flag, ...notes].forEach((o) => (o.userData.noCollide = true));
  const dyn = [];
  { ballMesh.userData.dynamic = true; const b = phys.addBody(ballMesh, 0.09, { mass: 0.6 }); b.golf = true; dyn.push(b);
    golfArea.updateMatrixWorld(true); golfArea.children.filter((c) => c.geometry?.type === "SphereGeometry").forEach((c) => { isl.attach(c); dyn.push(phys.addBody(c, 0.08, { mass: 0.5 })); }); }
  let physDirty = true, physT = 0;
  const rebuildPhysics = () => { physDirty = true; };
  function buildPhysicsNow() { physDirty = false; const n = phys.build([isl]); if (debugOn) drawDebug(); return n; }
  const debugOn = /[?&]debug=1/.test(location.search); let debugLines = null;
  function drawDebug() { if (debugLines) scene.remove(debugLines); debugLines = phys.debugLines(); debugLines.renderOrder = 999; scene.add(debugLines); }
  phys.setCapsule("greg", new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(0, 1.75, 0), SCALE.gregR, greg);
  const interactables = [...espresso.userData.interactables, ...hq.userData.interactables];
  const nav = createNav(THREE, phys, { radius: R_ISLAND }); let navGo = false;
  Promise.all(loads).then(() => { rebuildPhysics(); navGo = true; onReady && onReady(); });
  // ---------- Bit: Greg's little code-agent robot. Knee-high, screen face with pixel eyes, antenna status light,
  // one wheel, a tool arm. Follows Greg at a polite distance; when Greg sits at work, Bit does small jobs nearby.
  const bit = buildBit(); bit.position.set(P.plaza.x + 1.5, 0, P.plaza.z + 1); scene.add(bit);
  const bitS = { v: 0, say: null, sayUntil: 0, job: null, blinkT: 2 };
  phys.setCapsule("bit", new THREE.Vector3(0, 0.15, 0), new THREE.Vector3(0, 0.55, 0), 0.25, bit);
  const BIT_JOBS = [["lamp", "tightening a lamp post"], ["plants", "watering the hydrangeas"], ["screen", "scanning the trading screen"], ["codex", "reading the Codex"]];
  function updateBit(dt, t) {
    const g = greg.position, b = bit.position, plan = gregPlan(Date.now() + clockSkew), sitting = loco.v < 0.05 && /desk|tweet|browse|trade|draw|golf/.test(plan.action || "");
    const side = new THREE.Vector3(Math.cos(greg.rotation.y), 0, -Math.sin(greg.rotation.y));
    let tx = g.x + side.x * 1.2 - Math.sin(greg.rotation.y) * 0.6, tz = g.z + side.z * 1.2 - Math.cos(greg.rotation.y) * 0.6;
    const slot = Math.floor((Date.now() + clockSkew) / 90000), job = BIT_JOBS[slot % BIT_JOBS.length];
    if (sitting && slot % 3 === 1) { tx = g.x + Math.sin(slot) * 3; tz = g.z + Math.cos(slot) * 3; bitS.job = job; } else bitS.job = null;
    const dx = tx - b.x, dz = tz - b.z, d = Math.hypot(dx, dz);
    const vT = d < 0.15 ? 0 : Math.min(1.3, 0.4 + d * 0.8);
    bitS.v += Math.max(-2 * dt, Math.min(2.5 * dt, vT - bitS.v));
    if (d > 0.15) { const yaw = Math.atan2(dx, dz); const dy = Math.atan2(Math.sin(yaw - bit.rotation.y), Math.cos(yaw - bit.rotation.y)); bit.rotation.y += Math.max(-4 * dt, Math.min(4 * dt, dy)); }
    else { const yaw = Math.atan2(g.x - b.x, g.z - b.z); const dy = Math.atan2(Math.sin(yaw - bit.rotation.y), Math.cos(yaw - bit.rotation.y)); bit.rotation.y += dy * Math.min(1, dt * 3); }
    b.x += Math.sin(bit.rotation.y) * bitS.v * dt; b.z += Math.cos(bit.rotation.y) * bitS.v * dt;
    if (d > 8) { b.x = tx; b.z = tz; }
    const hit = phys.raycast(new THREE.Vector3(b.x, b.y + 0.5, b.z), DOWN, 1.2); const gy = hit && hit.normal.y > 0.7 && !hit.cap ? hit.point.y : 0; b.y += (gy - b.y) * Math.min(1, dt * 8);
    phys.moveCapsule("bit", tmpA.set(b.x, b.y + 0.15, b.z), tmpB.set(b.x, b.y + 0.55, b.z));
    const u = bit.userData; u.wheel.rotation.x += (bitS.v * dt) / 0.12; u.body.rotation.x = Math.min(0.15, bitS.v * 0.1); u.body.position.y = 0.42 + Math.sin(t * 3) * 0.008;
    const talking = performance.now() < bitS.sayUntil, thinking = !!bitS.job && d < 0.3;
    u.light.material.color.set(talking ? 0x4ab8ff : thinking ? 0xffd23f : 0x6cff7a);
    u.arm.rotation.x = thinking ? -1.2 + Math.sin(t * 9) * 0.3 : -0.2 + Math.sin(t * 1.5) * 0.05;
    bitS.blinkT -= dt; if (bitS.blinkT < 0) bitS.blinkT = 2 + Math.random() * 3;
    drawBitFace(u, t, bitS.blinkT < 0.12, talking, thinking);
  }
  // Bit's terse dev-humor lines: deterministic from the clock so every visitor sees the same line at the same time
  const BIT_LINES = ["refactored your life plan. 3 warnings.", "ran the numbers. the numbers ran away.", "flies detected: 0 paid, 1 suspicious.", "your putt has a 12 percent hit rate. i love you anyway.", "commit message: greg asked the universe again.", "uptime: excellent. golf: undefined.", "i fixed the lamp. it was not broken. now it is better.", "reminder: you are a frog.", "the market is a random walk. so are you. we match.", "scanning chart. verdict: lines.", "watering plants. they did not ask. i care anyway.", "error 404: one million dollars not found. yet.", "beep. that was a supportive beep.", "i read the codex. law 1 still holds: things fall."];
  const bitBub = (() => { const cv = document.createElement("canvas"); cv.width = 512; cv.height = 128; const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false })); sp.scale.set(1.0, 0.25, 1); sp.visible = false; sp.userData.noCollide = true; scene.add(sp); return { cv, sp, text: "" }; })();
  function bitSay(text, ms = 4500) { bitS.say = text; bitS.sayUntil = performance.now() + ms; if (bitBub.text !== text) { bitBub.text = text; const x = bitBub.cv.getContext("2d"); x.clearRect(0, 0, 512, 128); x.fillStyle = "#0e1726"; x.strokeStyle = "#4ab8ff"; x.lineWidth = 6; x.beginPath(); x.roundRect(4, 4, 504, 96, 22); x.fill(); x.stroke(); x.fillStyle = "#7fe3ff"; x.font = "700 24px monospace"; x.textAlign = "center"; x.fillText(text.length > 38 ? text.slice(0, 37) + "…" : text, 256, 60); bitBub.sp.material.map.needsUpdate = true; } }
  let bitLineSlot = -1;
  function bitChatter() { const now = Date.now() + clockSkew, slot = Math.floor(now / 40000); if (slot !== bitLineSlot && now % 40000 < 5000) { bitLineSlot = slot; bitSay(BIT_LINES[slot % BIT_LINES.length]); } bitBub.sp.visible = performance.now() < bitS.sayUntil; if (bitBub.sp.visible) bitBub.sp.position.set(bit.position.x, bit.position.y + 0.95, bit.position.z); }

  // owner-added items
  const itemGroup = new THREE.Group(); isl.add(itemGroup);
  let itemPop = new Map();
  function setItems(items) {
    const prev = new Set([...itemPop.keys()]); itemGroup.clear(); const next = new Map();
    (items || []).slice(0, 40).forEach((it, i) => {
      const a = i * 2.39996 + 0.5, r = 4.2 + (i % 4) * 1.1;
      const x = it.x != null ? Number(it.x) : Math.cos(a) * r, z = it.z != null ? Number(it.z) : Math.sin(a) * r;
      const g = new THREE.Group(); g.position.set(x, 0, z); g.userData.pick = { item: it };
      const ped = M(G.cyl(0.45, 0.55, 0.35, 10), it.effect ? 0xbbbbbb : it.kind === "place" ? 0xffc94a : 0xf47b6b); ped.position.y = 0.18; g.add(ped);
      const lab = makeLabel(it.emoji || "⭐", 96); lab.position.y = 1.0; lab.scale.setScalar(0.9); g.add(lab);
      const nm = makeLabel(it.name.slice(0, 22), 28, "#111", "#fff", true); nm.position.y = 1.75; nm.scale.set(2.2, 0.55, 1); g.add(nm);
      if (!prev.has(it.id) && itemPop.size) g.userData.popAt = performance.now();
      next.set(it.id, g); itemGroup.add(g);
    });
    itemPop = next; rebuildPhysics();
  }
  function setCareers(amb) { for (const a of amb || []) if (careerProps[a.slug]) careerProps[a.slug].visible = !(["locked"].includes(a.status)); rebuildPhysics(); }
  function setProperties(list) {
    propG.clear();
    const spots = [[P.beach.x + 3.4, P.beach.z - 1.2], [P.pitch.x - 1.6, P.pitch.z + 5.6], [P.hill.x + 3.6, P.hill.z + 4.0], [P.cafe.x - 5.6, P.cafe.z + 3.0]];
    (list || []).filter((p) => p.status === "construction" || (p.status === "owned" && p.granted)).slice(0, 4).forEach((p, i) => {
      const [x, z] = p.x != null ? [Number(p.x), Number(p.z)] : spots[i];
      const g = new THREE.Group(); g.position.set(x, 0, z); g.userData.pick = { property: p }; propG.add(g);
      const h = 0.3 + 2.4 * (p.build_progress / 100);
      const b = M(G.box(2.2, h, 1.8), p.status === "owned" ? 0xfff3c4 : 0xd9c7a0); b.position.y = h / 2; g.add(b);
      if (p.status === "construction") { for (const [sx, sz] of [[-1.2, -1], [1.2, -1], [-1.2, 1], [1.2, 1]]) { const pole = M(G.box(0.07, 3, 0.07), 0xf2b63a, { ot: 0.4 }); pole.position.set(sx, 1.5, sz); g.add(pole); } for (const y of [1, 2]) { const plank = M(G.box(2.6, 0.06, 0.3), 0xc48c55, { ot: 0.4 }); plank.position.set(0, y, 1); g.add(plank); } }
      else { const roof = M(new THREE.ConeGeometry(1.7, 0.9, 4), 0x3ea24a); roof.position.y = h + 0.45; roof.rotation.y = Math.PI / 4; g.add(roof); }
      const nm = makeLabel(`${p.name.slice(0, 18)}${p.status === "construction" ? " " + p.build_progress + "%" : ""}`, 26, "#111", "#fff", true); nm.position.y = h + 1.3; nm.scale.set(2.4, 0.6, 1); g.add(nm);
    });
    rebuildPhysics();
  }

  // ---------- desk screen ----------
  let screen = { mode: "idle", title: "Greg OS", text: "Welcome back, champion." }, screenAt = 0;
  function drawScreen(t) {
    const x = screenCanvas.getContext("2d"), W = 512, H = 256; const s = screen || {};
    x.fillStyle = "#0e1220"; x.fillRect(0, 0, W, H);
    x.fillStyle = "#b6e452"; x.font = "700 18px monospace"; x.fillText((s.title || "Greg OS").slice(0, 40), 14, 28);
    const el = (performance.now() - screenAt) / 1000;
    if (s.mode === "chart" && Array.isArray(s.series) && s.series.length > 1) {
      const v = s.series, mn = Math.min(...v), mx = Math.max(...v), n = Math.min(v.length, 2 + Math.floor(el * 8));
      x.strokeStyle = v[v.length - 1] >= v[0] ? "#4cff7a" : "#ff5a5a"; x.lineWidth = 3; x.beginPath();
      for (let i = 0; i < n; i++) { const px = 14 + (i / (v.length - 1)) * (W - 28), py = H - 20 - ((v[i] - mn) / (mx - mn || 1)) * (H - 70); i ? x.lineTo(px, py) : x.moveTo(px, py); }
      x.stroke(); x.fillStyle = "#fff"; x.font = "14px monospace"; x.fillText(s.text ? String(s.text).slice(0, 52) : "", 14, 50);
    } else if (s.mode === "tweet") {
      x.fillStyle = "#fff"; x.font = "700 16px sans-serif"; x.fillText("@gregthefrogfun", 14, 56);
      const full = String(s.text || ""), shown = full.slice(0, Math.floor(el * 18));
      x.font = "16px sans-serif"; wrap(x, shown + (Math.floor(t * 2) % 2 && shown.length < full.length ? "|" : ""), 14, 84, W - 28, 22);
      x.fillStyle = shown.length >= full.length ? "#1d9bf0" : "#2b3a55"; x.fillRect(W - 110, H - 44, 96, 30); x.fillStyle = "#fff"; x.font = "700 14px sans-serif"; x.fillText(s.posted ? "Sent!" : "Post", W - 82, H - 24);
    } else if (s.mode === "code") {
      x.font = "13px monospace"; const ls = String(s.text || "function greatness() {\n  return 'Greg';\n}").split("\n"); const off = Math.floor(el * 2) % Math.max(1, ls.length);
      for (let i = 0; i < 10; i++) { x.fillStyle = ["#9cdcfe", "#ce9178", "#b6e452", "#c586c0"][i % 4]; x.fillText((ls[(i + off) % ls.length] || "").slice(0, 60), 14, 56 + i * 19); }
    } else { x.fillStyle = "#fff"; x.font = "16px sans-serif"; wrap(x, String(s.text || ""), 14, 60, W - 28, 22); }
    screenTex.needsUpdate = true;
  }
  function setScreen(s) { if (JSON.stringify(s) !== JSON.stringify(screen)) { screen = s || screen; screenAt = performance.now(); } }

  // ---------- state + animation ----------
  let st = null, heading = 0, lastAction = "", actionStart = 0, cheerUntil = 0, cheerKind = "";
  function setState(s) {
    if (st && s && s.action !== st.action) { actionStart = performance.now(); if (controls.enabled) controls.dollyIn?.(1.08); }
    if (st && s && s.effects?.last_rent_tick !== st.effects?.last_rent_tick) coinPop(1.6);
    st = s; setMail(Number(s?.mail_unread || 0)); if (s?.screen) setScreen(s.screen);
    if (s?.screen?.result && s.screen.result !== cheerKind) { cheerKind = s.screen.result; cheerUntil = performance.now() + 5000; }
  }
  const tmp = new THREE.Vector3(), head = new THREE.Vector3();
  let follow = true; let raf = 0; const clock = new THREE.Clock();
  let colliders = null; setTimeout(() => (colliders = null), 8000);
  const camDesired = new THREE.Vector3(); let camHave = false, camDist = 0;
  let punchAt = 0, punchTarget = null;
  const frameHooks = []; let followObj = null, glance = null, glanceUnpaid = false;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(); let down = null;
  canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  // world objects open only when NOT flying (Greg cam / orbit view) and never while the pointer is locked
  let pickGate = () => true;
  canvas.addEventListener("pointerup", (e) => {
    if (document.pointerLockElement || !pickGate()) { down = null; return; }
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8 || performance.now() - down.t > 600) { down = null; return; }
    down = null; const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects([greg, ...picks, ...itemGroup.children, ...propG.children], true);
    for (const h of hits) { let o = h.object; while (o && !o.userData.pick) o = o.parent; if (o) { onPick && onPick(o.userData.pick, e); return; } }
  });
  controls.addEventListener("start", () => { if (follow && onUserOrbit) onUserOrbit(); });

  const POSE = [
    [/sleep|nap/, "sleep"], [/golf|putt/, "golf"], [/improve_course|develop/, "build"], [/piano/, "piano"], [/music|synth/, "synth"],
    [/read|learn|book/, "read"], [/diary|ponder|think/, "sit"], [/browse|tweet|board_meeting|build_tool|build_toy|wallet|trade/, "desk"],
    [/cook/, "cook"], [/eat|espresso/, "eat"], [/gym/, "lift"], [/football/, "juggle"], [/acting/, "act"], [/paper_plane/, "throw"],
    [/draw|study_art/, "paint"], [/collect_rent/, "rent"], [/read_mail/, "sit"], [/ask_owner/, "sit"], [/try_item/, "sit"],
  ];
  const poseFor = (a) => (POSE.find(([re]) => re.test(a)) || [0, "idle"])[1];
  const PROP = { golf: "club", read: "book", juggle: "ball", throw: "plane", paint: "brush", eat: "cup", cook: "pan", rent: "bag", lift: "stone" };
  const SIT_SPOT = { desk: [P.desk.x, P.desk.z, Math.atan2(-Math.sin(HQ.ry), -Math.cos(HQ.ry))], piano: [P.shed.x - 0.2, P.shed.z - 0.6, Math.PI] };

  let fpsN = 0, fpsT = 0, lowQ = false, renderOverride = null, lastFps = 60;
  const draw = () => (renderOverride ? renderOverride(renderer, scene, camera) : renderer.render(scene, camera));
  function setLowQuality(v) { lowQ = v; renderer.setPixelRatio(v ? 1 : (lowPower ? Math.min(dpr, 1.25) : dpr)); document.body.classList.toggle("lowq", v); resize(); }
  function frame() {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
    fpsN++; fpsT += clock.getDelta() + dt; if (t > 6 && fpsN >= 90) { const fps = fpsN / Math.max(0.001, fpsT); lastFps = fps; if (fps < 30 && !lowQ) { setLowQuality(true); onLowQ && onLowQ(); } fpsN = 0; fpsT = 0; }
    waterU.uTime.value = t;
    dayCycle(t);
    clouds.children.forEach((c) => { c.position.x += c.userData.s * dt; if (c.position.x > 60) c.position.x = -60; });
    birds.forEach((b) => { b.userData.a += b.userData.sp * dt; const { a, r, h } = b.userData; b.position.set(Math.cos(a) * r, h + Math.sin(a * 3) * 0.4, Math.sin(a) * r); b.rotation.y = -a; b.children.forEach((w) => (w.rotation.z = w.userData.s * Math.sin(t * 9) * 0.5)); });
    // planes overhead every so often
    if (planeT < 0 && t > nextPlane) { planeT = 0; plane.visible = true; plane.userData.dir = rnd() < 0.5 ? 1 : -1; plane.userData.z = (rnd() - 0.5) * 20; }
    if (planeT >= 0) { planeT += dt / 18; const d = plane.userData.dir; plane.position.set(d * (-70 + planeT * 140), 22, plane.userData.z); plane.rotation.y = d > 0 ? -Math.PI / 2 : Math.PI / 2; if (planeT > 1) { planeT = -1; plane.visible = false; nextPlane = t + 35 + rnd() * 40; } }
    crystal.rotation.y = t * 0.8; crystal.position.y = 1.95 + Math.sin(t * 2) * 0.08;
    nodes.forEach((n, i) => { const a = t * 0.9 + (i * Math.PI * 2) / 3; n.position.set(Math.cos(a) * 0.95, 1.95 + Math.sin(a * 2) * 0.2, Math.sin(a) * 0.95); });
    propGroups.flag.rotation.y = 0.3 + Math.sin(t * 2.3) * 0.12;
    flagCloths.forEach((f, i) => (f.rotation.y = Math.sin(t * 2.6 + i) * 0.25));
    sockCloth.rotation.x = Math.sin(t * 1.7) * 0.3;
    synthLights.forEach((l, i) => { l.visible = Math.sin(t * (3 + i) + i * 1.7) > -0.3; });
    bars.forEach((b, i) => { b.scale.y = 0.6 + 0.4 * Math.abs(Math.sin(t * 0.4 + i * 1.3)); });
    coin.rotation.z = t * 2;
    for (let i = 0; i < 12; i++) { const a = t * (1.5 + i * 0.13) + i; flyPos.set([flatsCenter.x + Math.cos(a) * (0.8 + (i % 3) * 0.35), flatsCenter.y + Math.sin(a * 2.3) * 0.5 + (i % 2), flatsCenter.z + Math.sin(a) * (0.8 + (i % 3) * 0.3)], i * 3); }
    flyGeo.attributes.position.needsUpdate = true;
    if (rain.visible) { const p = rainGeo.attributes.position.array; for (let i = 1; i < p.length; i += 3) { p[i] -= dt * 14; if (p[i] < 0) p[i] = 25; } rainGeo.attributes.position.needsUpdate = true; rain.position.set(camera.position.x * 0.5, 0, camera.position.z * 0.5); }
    for (const g of itemGroup.children) if (g.userData.popAt) { const k = Math.min(1, (performance.now() - g.userData.popAt) / 700); g.scale.setScalar(k < 1 ? 0.2 + 1.2 * Math.sin(k * Math.PI * 0.75) : 1); if (k >= 1) delete g.userData.popAt; }
    animateCoins(dt);
    if (glance || frameHooks.length) slabItems.children.forEach((g, i) => { if (g.userData.slab) g.rotation.y = Math.sin(t * 0.8 + i) * 0.15; });
    if (Math.floor(t * 4) !== Math.floor((t - dt) * 4)) drawScreen(t);
    if (physDirty) { physT -= dt; if (physT <= 0) { buildPhysicsNow(); physT = 0.4; } }
    phys.stepBodies(dt); golfCheck(dt);
    if (navGo && !physDirty && !nav.isReady()) { if (nav.buildSlice(4)) setRouter(nav.route); }
    if (st) updateGreg(dt, t);
    if (st) { updateBit(dt, t); bitChatter(); }
    for (const f of frameHooks) f(dt, t);
    if (!controls.enabled) { draw(); return; }
    if (follow) { const tg = followObj ? followObj.position : head.set(greg.position.x, 0.9, greg.position.z); const old = controls.target.clone(); controls.target.lerp(tg, followObj ? 0.15 : 0.06); camera.position.add(old.sub(controls.target).negate()); }
    if (camHave) camera.position.copy(camDesired);
    controls.update();
    camDesired.copy(camera.position); camHave = true;
    { // camera never inside geometry: sphere-cast from the target to the wanted spot, pull in fast, ease out slow
      const to = camDesired.clone().sub(controls.target), want = to.length(); to.divideScalar(want || 1);
      const from = controls.target.clone(); for (let k = 0; k < 8 && phys.nearest(from, 0.12, true); k++) from.y += 0.2; const hit = phys.sphereCast(from, to, 0.1, want, true); const allowed = hit ? Math.max(0.02, hit.t - 0.02) : want;
      camDist = camDist <= 0 ? allowed : allowed < camDist ? allowed : camDist + (allowed - camDist) * Math.min(1, dt * 2.5);
      camera.position.copy(from).addScaledVector(to, Math.min(camDist, want));
    }
    draw();
  }

  // micro-life: everyone computes the same wander/emote from the server timestamps (no extra calls)
  function microLife(now, base) {
    const since = now - Date.parse(st.arrive_at);
    if (since < 15000) return null;
    const slot = Math.floor(since / 12000), seed = (Date.parse(st.started_at) / 1000 + slot * 7919) % 100000;
    const r = mulberry(seed | 0); const kind = r();
    if (["sleep", "desk", "piano", "read", "sit", "cook"].includes(base)) return { pose: base, dx: 0, dz: 0, emo: kind < 0.15 ? "💭" : null };
    const ang = r() * Math.PI * 2, d = 0.6 + r() * 1.8;
    if (kind < 0.35) return { pose: "walk", dx: Math.cos(ang) * d, dz: Math.sin(ang) * d, slot };
    if (kind < 0.5) return { pose: "look", dx: 0, dz: 0 };
    if (kind < 0.6) return { pose: "scratch", dx: 0, dz: 0, emo: "?" };
    if (kind < 0.7) return { pose: "satchel", dx: 0, dz: 0 };
    if (kind < 0.8) return { pose: "wave", dx: 0, dz: 0, emo: "👋" };
    return { pose: base, dx: 0, dz: 0 };
  }

  let wander = new THREE.Vector2(), wanderT = new THREE.Vector2(), gregSpeed = 0;
  const loco = { v: 0, init: false, path: null, pathAt: 0, pi: 1, turnRate: 0, phase: 0 };
  const DOWN = new THREE.Vector3(0, -1, 0), tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  // the brain moves Greg when it ticks; if it has been quiet for 20 min, the deterministic routine takes over
  // the hourly schedule drives where Greg is; a fresh brain event (swat, talk, wish, cheer) interrupts for a few minutes, then he resumes
  const INTERRUPT = /swat|talk|wish|grant|cheer|celebrat|react|event/;
  function gregPlan(now) { if (st.paused) return st; const fresh = now - Date.parse(st.started_at) < 5 * 60e3 && INTERRUPT.test(st.action || ""); return fresh ? st : { ...st, ...routineState(now) }; }
  function updateGreg(dt, t) {
    const now = Date.now() + clockSkew;
    const S = gregPlan(now); const p = posAt(S, now); const pAhead = posAt(S, now + 450);
    const walking = p.walking && !st.paused;
    let pose = st.paused ? "sleep" : walking ? "walk" : poseFor(S.action || "");
    const emo = st.emotions || {};
    const mood = st.mood || "";
    if (!walking && !st.paused && pose === "idle") pose = emo.anxiety > 60 || Number(st.needs?.calm ?? 60) < 30 ? "pace" : emo.frustration > 60 ? "sulk" : emo.loneliness > 65 ? "droop" : Number(st.needs?.calm ?? 60) > 78 ? "lounge" : "idle";
    if (performance.now() < cheerUntil && !walking) pose = cheerKind === "green" ? "cheer" : "facepalm";
    const pd = (Date.now() - punchAt) / 1000; // -0.75..0 wind-up, 0..0.35 jab
    if (punchTarget && pd > -0.9 && pd < 0.4) { pose = pd < 0 ? "windup" : "jab"; }
    let micro = !walking && !st.paused ? microLife(now, pose) : null;
    if (planeT > 0.25 && planeT < 0.75 && !walking && !["sleep", "desk", "piano"].includes(pose)) micro = { pose: "lookup", dx: 0, dz: 0, emo: "✈️" };
    if (micro) { pose = micro.pose; wanderT.set(micro.dx, micro.dz); } else wanderT.set(0, 0);
    // sit spots (desk chair, piano bench)
    const sit = !walking && SIT_SPOT[pose];
    tmp.set(sit ? sit[0] : p.x, 0, sit ? sit[1] : p.z);
    wander.lerp(wanderT, Math.min(1, dt * 0.8));
    if (!walking && !sit) tmp.x += wander.x, tmp.z += wander.y;
    // locomotion: Greg chases the shared route point with a speed limit (0.8 m/s stroll, 1.2 m/s when behind),
    // accelerates over ~0.4 s, brakes over ~0.5 s, turns at most 120 deg/s and turns in place before big turns.
    const prev = greg.position.clone();
    if (!loco.init) { greg.position.set(tmp.x, 0, tmp.z); loco.init = true; }
    const tx = tmp.x - greg.position.x, tz = tmp.z - greg.position.z, dist = Math.hypot(tx, tz);
    let aimX = tmp.x, aimZ = tmp.z;
    if (dist > 1.6 && nav.isReady()) { // far behind (after an interruption or a visit): walk the nav path, not a straight line
      if (!loco.path || now - loco.pathAt > 1000) { loco.path = nav.route([greg.position.x, greg.position.z], [tmp.x, tmp.z]); loco.pathAt = now; loco.pi = 1; }
      const P2 = loco.path; if (P2 && P2.length > 1) { while (loco.pi < P2.length - 1 && Math.hypot(P2[loco.pi][0] - greg.position.x, P2[loco.pi][1] - greg.position.z) < 0.35) loco.pi++; aimX = P2[loco.pi][0]; aimZ = P2[loco.pi][1]; }
    } else loco.path = null;
    const ax = aimX - greg.position.x, az = aimZ - greg.position.z, ad = Math.hypot(ax, az);
    const routeV = walking ? SCALE.walkSpeed * (p.speed ?? 1) : 0;
    let vT = dist < 0.04 ? 0 : Math.min(walking || dist > 0.6 ? 1.2 : 0.8, routeV + 1.6 * Math.max(0, dist - 0.12));
    vT = Math.min(vT, Math.sqrt(2 * 1.6 * dist)); // brake into the stop
    const wantYaw = ad > 0.05 ? Math.atan2(ax, az) : null;
    if (wantYaw !== null) { let d0 = Math.atan2(Math.sin(wantYaw - greg.rotation.y), Math.cos(wantYaw - greg.rotation.y)); if (Math.abs(d0) > 1.0 && loco.v < 0.3) vT = 0; else vT *= Math.max(0.35, Math.cos(Math.min(1.2, Math.abs(d0)))); }
    loco.vT = vT; loco.dist = dist; loco.ad = ad;
    loco.v += Math.max(-1.6 * dt, Math.min(2.0 * dt, vT - loco.v));
    if (ad > 1e-4 && loco.v > 0) { const step = Math.min(ad, loco.v * dt), fx = Math.sin(greg.rotation.y), fz = Math.cos(greg.rotation.y); const mx = ax / ad, mz = az / ad; const bx = fx * 0.75 + mx * 0.25, bz = fz * 0.75 + mz * 0.25, bl = Math.hypot(bx, bz) || 1; greg.position.x += (bx / bl) * step; greg.position.z += (bz / bl) * step; loco.step = step; loco.aim = [aimX, aimZ]; }
    { const hit = phys.raycast(new THREE.Vector3(greg.position.x, greg.position.y + 0.7, greg.position.z), DOWN, 1.4); const gy = hit && hit.normal.y > 0.7 ? hit.point.y : 0; greg.position.y += (gy - greg.position.y) * Math.min(1, dt * 8); }
    phys.moveCapsule("greg", tmpA.set(greg.position.x, greg.position.y + 0.5, greg.position.z), tmpB.set(greg.position.x, greg.position.y + 1.75, greg.position.z));
    gregSpeed = Math.hypot(greg.position.x - prev.x, greg.position.z - prev.z) / Math.max(dt, 1e-3);
    const moving = loco.v > 0.06; if (loco.was && !moving) loco.stopAt = t; loco.was = moving;
    if (moving) pose = "walk";
    if (wantYaw !== null && (moving || dist > 0.08)) heading = wantYaw;
    else if (sit) heading = sit[2];
    else if (pose === "golf") heading = Math.atan2(holeP.x - greg.position.x, holeP.z - greg.position.z);
    else if ((pose === "windup" || pose === "jab") && punchTarget) heading = Math.atan2(punchTarget.x - greg.position.x, punchTarget.z - greg.position.z);
    else if (pose === "wave" || pose === "idle") heading = Math.atan2(camera.position.x - greg.position.x, camera.position.z - greg.position.z);
    let dy = Math.atan2(Math.sin(heading - greg.rotation.y), Math.cos(heading - greg.rotation.y));
    const maxTurn = 2.09 * dt; const turn = Math.max(-maxTurn, Math.min(maxTurn, dy * Math.min(1, dt * 8) / Math.max(dt, 1e-3) * dt));
    greg.rotation.y += turn; loco.turnRate += ((turn / Math.max(dt, 1e-3)) - loco.turnRate) * Math.min(1, dt * 8);
    const speed = mood === "jittery" ? 1.5 : emo.pride > 75 ? 1.2 : emo.joy < 30 ? 0.75 : 1;
    animate(pose, t, dt, speed, mood === "jittery");
    if (glance && rig?.bones.head && greg.position.distanceTo(glance) < 3.2) { const a = Math.atan2(glance.x - greg.position.x, glance.z - greg.position.z) - greg.rotation.y; const yaw = Math.max(-0.9, Math.min(0.9, Math.atan2(Math.sin(a), Math.cos(a)))); bone("head", 0, yaw / 0.6, 0); }
    if (glance && glanceUnpaid && greg.position.distanceTo(glance) < 3.2 && !walking) { gregBody.position.y += Math.abs(Math.sin(t * 8)) * 0.03; bone("rarm", -2.2, 0, Math.sin(t * 10) * 0.4); setEmote("💢", t); }
    // emote bubble
    const em = micro?.emo || ({ anxious: "!", sulking: "💢", lonely: "…", proud: "★", happy: "♥", jittery: "⚡" }[mood]) || (pose === "sleep" ? null : null);
    setEmote(em, t);
    // music notes over the piano / synth
    notes.forEach((n, i) => { n.visible = pose === "piano" || pose === "synth"; if (n.visible) { const k = (t * 0.6 + i / 3) % 1; n.position.set(greg.position.x + 0.4 + Math.sin(k * 6 + i) * 0.3, GREG_H + 0.2 + k * 1.4, greg.position.z); n.material.opacity = 1 - k; } });
    hq.userData.mugSteam.forEach((s, i) => { const k = (t * 0.4 + i / 4) % 1; const m = hq.userData.mug.position; s.position.set(m.x + Math.sin(k * 6 + i) * 0.03, m.y + 0.16 + k * 0.4, m.z); s.scale.setScalar(0.6 + k * 1.5); s.material.opacity = 0.45 * (1 - k); });
    steam.forEach((s, i) => { s.visible = pose === "cook"; if (s.visible) { const k = (t * 0.5 + i / 4) % 1; s.position.set(1.4 + Math.sin(k * 5 + i) * 0.1, 1.3 + k * 1.2, 0); s.scale.setScalar(0.6 + k); s.material.opacity = 0.7 * (1 - k); } });
  }

  function setEmote(e, t) {
    if (!e) { emote.visible = false; return; }
    if (emote.userData.e !== e) { const n = makeLabel(e, 80, "#141218", "#ffffff"); emote.material.map = n.material.map; emote.material.needsUpdate = true; emote.userData.e = e; }
    emote.visible = true; emote.position.y = GREG_H + 0.6 + Math.sin(t * 3) * 0.06;
  }

  // body-part animation: rig bones when available, plus whole-body transforms that read well from far away
  const q = new THREE.Quaternion(), e3 = new THREE.Euler();
  function bone(name, x, y, z) { if (!rig?.bones[name]) return; e3.set(x * 0.6, y * 0.6, z * 0.6); q.setFromEuler(e3); rig.bones[name].quaternion.multiply(q); }
  let walkW = 0, idleW = 1;
  function animate(pose, t, dt, speed, jitter) {
    gregBody.rotation.set(0, 0, 0); gregBody.position.set(0, 0, 0); gregBody.scale.set(1, 1, 1);
    const want = PROP[pose]; for (const [k, p] of Object.entries(held)) if (p) p.visible = k === want;
    zzz.forEach((z) => (z.visible = pose === "sleep"));
    if (rig) {
      // 0.25 s linear crossfade; playback rate from ground speed and the clip's measured stance speed, so planted feet don't slide
      walkW += Math.max(-dt / 0.25, Math.min(dt / 0.25, (pose === "walk" ? 1 : 0) - walkW)); idleW = 1 - walkW;
      rig.actions.walk.setEffectiveWeight(walkW); rig.actions.walk.timeScale = pose === "walk" ? Math.max(0.05, Math.min(2.2, gregSpeed / (WALK_CLIP.stance * rig.k))) : 1;
      if (rig.actions.idle) rig.actions.idle.setEffectiveWeight(idleW);
      rig.mixer.update(dt);
    }
    const s = t * speed, j = jitter ? (Math.random() - 0.5) * 0.03 : 0;
    gregBody.position.x += j;
    switch (pose) {
      case "walk": {
        // waddle layered on the rig (or the whole walk for the fallback model), phase locked to the steps:
        // weight shift side to side once per cycle, a small bob twice per cycle, lean into turns, head steady
        const ph = rig ? ((rig.actions.walk.time / WALK_CLIP.dur) * WALK_CLIP.cycles) % 1 : (loco.phase = (loco.phase + (gregSpeed * dt) / 1.1) % 1);
        const a = ph * Math.PI * 2, k = Math.min(1, gregSpeed / 0.5);
        gregBody.position.x = Math.sin(a) * 0.035 * k; gregBody.position.y = (rig ? 0.012 : 0.05) * k * (1 - Math.cos(2 * a)) * 0.5;
        gregBody.rotation.z = -Math.sin(a) * 0.05 * k - Math.max(-0.08, Math.min(0.08, loco.turnRate * 0.04)); gregBody.rotation.x = 0.04 * k;
        bone("head", 0, 0, Math.sin(a) * 0.05 * k); hand.rotation.x = -Math.sin(a) * 0.45 * k;
        break;
      }
      case "idle": { const b = Math.sin(t * 2); gregBody.scale.set(1 + b * 0.02, 1 - b * 0.025, 1 + b * 0.02); gregBody.rotation.y = Math.sin(t * 0.5) * 0.25; if ((t % 4.3) < 0.12) gregBody.scale.y *= 0.96; break; }
      case "look": gregBody.rotation.y = Math.sin(t * 0.9) * 0.7; bone("head", 0, Math.sin(t * 0.9) * 0.6, 0); break;
      case "lookup": gregBody.rotation.x = -0.3; bone("head", -0.6, 0, 0); break;
      case "scratch": gregBody.rotation.z = 0.08; bone("rarm", -2.4, 0, 0.3); hand.position.y = GREG_H * 0.95; hand.rotation.z = Math.sin(t * 14) * 0.2; break;
      case "satchel": gregBody.rotation.x = 0.25; gregBody.rotation.y = -0.4; break;
      case "wave": bone("rarm", -2.6, 0, Math.sin(t * 8) * 0.5); gregBody.rotation.z = Math.sin(t * 8) * 0.05; gregBody.position.y = Math.abs(Math.sin(t * 4)) * 0.05; break;
      case "sit": gregBody.scale.set(1.08, 0.82, 1.08); gregBody.rotation.x = -0.1 + Math.sin(t * 1.3) * 0.03; break;
      case "sleep": { gregBody.rotation.x = -Math.PI / 2 + 0.15; gregBody.position.set(0, 0.4, 0.6); const b = Math.sin(t * 1.2); gregBody.scale.set(1 + b * 0.03, 1, 1 + b * 0.03); zzz.forEach((z, i) => { const k = (t * 0.5 + i / 3) % 1; z.position.set(0.3 + k * 0.6, 1.2 + k * 1.4, 0); z.material.opacity = 1 - k; }); break; }
      case "golf": {
        const c = (t % 3.4) / 3.4; const sw = c < 0.55 ? -c / 0.55 * 1.7 : c < 0.66 ? -1.7 + (c - 0.55) / 0.11 * 2.9 : 1.2 - (c - 0.66) * 1.2;
        gregBody.rotation.x = 0.22; gregBody.rotation.y = sw * 0.3; hand.position.set(0.15, GREG_H * 0.42, 0.42); hand.rotation.set(0, 0, sw * 0.7);
        bone("rarm", 0.6 + sw * 0.3, 0, 0); bone("larm", 0.6 + sw * 0.3, 0, 0);
        if (c > 0.6 && c < 0.64) { gregBody.position.y = 0.05; golfHit(); } break;
      }
      case "piano": { gregBody.scale.set(1.05, 0.86, 1.05); gregBody.position.y = 0.15; gregBody.rotation.z = Math.sin(t * 2) * 0.07; gregBody.rotation.x = 0.12 + Math.sin(t * 5) * 0.03; bone("rarm", 0.9 + Math.sin(t * 11) * 0.2, 0, 0); bone("larm", 0.9 + Math.sin(t * 9 + 1) * 0.2, 0, 0); hand.position.y = GREG_H * 0.5; break; }
      case "synth": { const b = Math.sin(t * 7); gregBody.position.y = Math.max(0, b) * 0.08; gregBody.rotation.z = Math.sin(t * 3.5) * 0.15; bone("rarm", 1.0, Math.sin(t * 4) * 0.4, 0); break; }
      case "desk": { gregBody.scale.set(1.05, 0.86, 1.05); gregBody.position.y = 0.32; gregBody.rotation.x = 0.1; const ty = Math.sin(t * 16); bone("rarm", 1.1 + ty * 0.08, 0, 0); bone("larm", 1.1 - ty * 0.08, 0, 0); gregBody.position.y += Math.abs(ty) * 0.01; break; }
      case "read": { gregBody.scale.set(1.08, 0.84, 1.08); gregBody.rotation.x = 0.1; hand.position.set(0, GREG_H * 0.55, 0.45); hand.rotation.set(-0.5, 0, 0); if ((t % 6) < 0.4) held.book.rotation.y = (t % 6) * 6; else held.book.rotation.y = 0; break; }
      case "cook": { gregBody.rotation.y = Math.sin(t * 3) * 0.2; hand.position.set(0.2, GREG_H * 0.5, 0.45); hand.rotation.set(0, Math.sin(t * 6) * 0.6, 0); if ((t % 3) < 0.3) hand.position.y += 0.2; break; }
      case "eat": { gregBody.scale.set(1.06, 0.9, 1.06); hand.position.set(0.1, GREG_H * (0.55 + 0.12 * Math.max(0, Math.sin(t * 2))), 0.4); bone("rarm", 1.4, 0, 0); break; }
      case "lift": { const up = Math.max(0, Math.sin(t * 2.2)); hand.position.set(0, GREG_H * (0.5 + up * 0.5), 0.2); gregBody.scale.set(1 + up * 0.06, 1 - up * 0.04, 1 + up * 0.06); bone("rarm", -2.2 * up, 0, 0); bone("larm", -2.2 * up, 0, 0); break; }
      case "juggle": { const k = Math.abs(Math.sin(t * 4)); hand.position.set(0, 0.25 + k * 1.2, 0.5); gregBody.position.y = k * 0.06; gregBody.rotation.z = Math.sin(t * 4) * 0.08; break; }
      case "act": { const k = Math.floor(t / 2.5) % 3; gregBody.rotation.set(k === 0 ? -0.25 : 0.1, k === 1 ? 0.8 : -0.3, k === 2 ? 0.2 : 0); bone("rarm", k === 0 ? -2.6 : -1.2, 0, 0.6); bone("larm", k === 2 ? -2.0 : 0, 0, -0.6); break; }
      case "throw": { const c = (t % 3) / 3; hand.position.set(0.1, GREG_H * (0.6 + (c < 0.6 ? c * 0.6 : 0)), c < 0.6 ? 0.2 : 0.8); held.plane.visible = c < 0.65; gregBody.rotation.x = c < 0.6 ? -0.2 : 0.25; break; }
      case "paint": { hand.position.set(0.1, GREG_H * 0.62 + Math.sin(t * 5) * 0.1, 0.5); hand.rotation.z = Math.sin(t * 5) * 0.4; gregBody.rotation.y = Math.sin(t * 0.8) * 0.15; break; }
      case "rent": { const c = t % 5; gregBody.rotation.x = c < 1 ? Math.max(0, Math.sin(c * 12)) * 0.15 : 0; hand.position.set(0.2, GREG_H * 0.45, 0.3); if (c > 1.2 && c < 1.3) coinPop(0.6); if (c > 2 && c < 3.5) gregBody.position.y = Math.abs(Math.sin(c * 8)) * 0.05; break; }
      case "build": { const b = Math.sin(t * 10); gregBody.rotation.x = 0.15 + Math.max(0, b) * 0.15; bone("rarm", -1.5 + Math.max(0, b), 0, 0); break; }
      case "pace": { const k = Math.sin(t * 1.6); gregBody.position.x = k * 0.8; gregBody.rotation.y = Math.cos(t * 1.6) > 0 ? Math.PI / 2 : -Math.PI / 2; gregBody.position.y = Math.abs(Math.sin(t * 9)) * 0.08; break; }
      case "sulk": gregBody.rotation.x = 0.35; gregBody.scale.set(1.05, 0.9, 1.05); gregBody.rotation.y = Math.PI * 0.85; break;
      case "droop": gregBody.rotation.x = 0.28; gregBody.scale.set(1, 0.94, 1); gregBody.position.y = Math.sin(t) * 0.01; break;
      case "lounge": gregBody.rotation.x = -0.45; gregBody.scale.set(1.06, 0.88, 1.06); gregBody.position.z = -0.2; break;
      case "cheer": { const k = Math.abs(Math.sin(t * 6)); gregBody.position.y = k * 0.5; bone("rarm", -2.8, 0, 0); bone("larm", -2.8, 0, 0); gregBody.rotation.y = t * 4; break; }
      case "windup": gregBody.rotation.y = -0.6; gregBody.rotation.x = -0.15; bone("rarm", 0.8, 0, 1.2); hand.position.set(0.5, GREG_H * 0.6, -0.2); setEmote("💢", t); break;
      case "jab": gregBody.rotation.y = 0.35; gregBody.rotation.x = 0.2; gregBody.position.z = 0.25; bone("rarm", -1.6, 0, 0); hand.position.set(0.2, GREG_H * 0.62, 0.9); break;
      case "facepalm": gregBody.rotation.x = 0.3; bone("rarm", -2.0, 0, 0.8); hand.position.set(0.1, GREG_H * 0.85, 0.35); break;
    }
    { const st0 = t - (loco.stopAt ?? -9); if (st0 < 0.45 && pose !== "walk") { const k = Math.sin((st0 / 0.45) * Math.PI); gregBody.scale.y *= 1 - 0.035 * k; gregBody.scale.x *= 1 + 0.02 * k; gregBody.scale.z *= 1 + 0.02 * k; } }
    if (pose !== "golf" && pose !== "read" && pose !== "cook" && pose !== "eat" && pose !== "lift" && pose !== "juggle" && pose !== "throw" && pose !== "paint" && pose !== "rent" && pose !== "scratch" && pose !== "piano" && pose !== "facepalm" && pose !== "windup" && pose !== "jab") { hand.position.set(0.48, GREG_H * 0.43, 0.32); hand.rotation.set(0, 0, 0); }
  }

  // Greg's putt: the ball is a real physics body and rolls to (or past) the cup
  let lastPutt = 0;
  function golfHit() {
    const b = dyn[0]; if (!b || performance.now() - lastPutt < 2500) return; const bp = b.mesh.position;
    if (Math.hypot(bp.x - greg.position.x, bp.z - greg.position.z) > 2.8) return; lastPutt = performance.now();
    const d = new THREE.Vector3(holeP.x - bp.x, 0, holeP.z - bp.z), L = d.length(); d.normalize();
    const sp = Math.sqrt(2 * 1.6 * L) * (0.85 + ((Math.floor(performance.now() / 977) % 7) / 7) * 0.35);
    b.vel.set(d.x * sp, 0.4, d.z * sp); b.sleep = 0; frameEvent("putt", bp);
  }
  function golfCheck(dt) {
    const b = dyn[0]; if (!b) return; const bp = b.mesh.position;
    if (b.sunk) { b.sunk -= dt; if (b.sunk <= 0) { b.sunk = 0; bp.copy(b.home); b.vel.set(0, 0, 0); } return; }
    if (Math.hypot(bp.x - holeP.x, bp.z - holeP.z) < 0.14 && b.vel.length() < 2.2) { bp.set(holeP.x, -0.05, holeP.z); b.vel.set(0, 0, 0); b.sleep = 9; b.sunk = 2.5; cheerUntil = performance.now() + 3000; cheerKind = "green"; frameEvent("sunk", bp); }
  }
  const eventHooks = []; function frameEvent(kind, at) { for (const f of eventHooks) f(kind, at); }
  function coinPop(n = 1) { const N = Math.round(coins.length * Math.min(1, n)); for (let i = 0; i < N; i++) { const c = coins[i]; c.visible = true; c.position.copy(greg.position).add(new THREE.Vector3((Math.random() - 0.5) * 1.5, GREG_H * 0.8, (Math.random() - 0.5) * 1.5)); c.userData.v = new THREE.Vector3((Math.random() - 0.5) * 2, 3 + Math.random() * 2, (Math.random() - 0.5) * 2); c.userData.life = 1.4; } }
  function animateCoins(dt) { for (const c of coins) { if (!c.visible) continue; c.userData.life -= dt; c.userData.v.y -= 9 * dt; c.position.addScaledVector(c.userData.v, dt); c.rotation.x += dt * 10; if (c.userData.life < 0.5) c.position.lerp(new THREE.Vector3(greg.position.x + 0.4, GREG_H * 0.45, greg.position.z), 0.2); if (c.userData.life <= 0) c.visible = false; } }

  // day/night synced to real UTC time; rain on rainy days (same rule as the server)
  let lastSky = -1;
  function dayCycle(t) {
    if (Math.floor(t) === lastSky) return; lastSky = Math.floor(t);
    const d = new Date(Date.now() + clockSkew), h = d.getUTCHours() + d.getUTCMinutes() / 60;
    const day = h >= 6 && h < 18 ? 1 : h >= 5 && h < 6 ? h - 5 : h >= 18 && h < 19.5 ? 1 - (h - 18) / 1.5 : 0;
    DAY.value = 0.35 + 0.65 * day;
    const dusk = (h >= 17 && h < 19.5) || (h >= 5 && h < 7) ? 0.35 : 0;
    scene.background.copy(SKY_NIGHT).lerp(SKY_DAY, day).lerp(SKY_DUSK, dusk * day);
    scene.fog.color.copy(scene.background);
    fireflies.visible = day < 0.5; lampHeads.material.uniforms.uEmissive.value = day < 0.6 ? 1 : 0.1;
    rain.visible = Math.floor(Date.now() / 86400e3 + 1) % 4 === 2 && (d.getUTCHours() % 6) < 3;
  }

  let clockSkew = 0;
  function setClockSkew(ms) { clockSkew = ms || 0; }
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.fov = w < h ? 55 : 42; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas); resize(); frame();
  function screenOf(obj, dy) {
    head.set(obj.position.x, obj.position.y + dy, obj.position.z).project(camera);
    return { x: (head.x * 0.5 + 0.5) * canvas.clientWidth, y: (-head.y * 0.5 + 0.5) * canvas.clientHeight, visible: head.z < 1 };
  }
  function focus(place) {
    const p = place ? P[place] : greg.position; if (!p) return;
    follow = !place; const d = new THREE.Vector3(p.x, 0.8, p.z).sub(controls.target); controls.target.add(d); camera.position.add(d);
  }
  return {
    punch: (target, at) => { punchAt = at; punchTarget = target; },
    _loco: () => ({ ...loco, path: loco.path?.length, tmp: [tmp.x, tmp.z], heading, rot: greg.rotation.y }), bit, bitSay, bitJob: () => bitS.job, hq, nav, phys, interactables, isl, greg, nest, espresso, debugOn, onEvent: (f) => eventHooks.push(f), rebuildPhysics, buildPhysicsNow,
    nestSpawns: () => nest.userData.spawns.map((v) => nest.localToWorld(v.clone())), nestCenter: () => nest.localToWorld(new THREE.Vector3(0, 0.7, 0.4)),
    setNest: (n) => nest.userData.drawSign(n), gregPlan: (now) => (st ? gregPlan(now) : null), gregHeadY: () => greg.position.y + GREG_H * 0.92,
    setPickGate: (f) => (pickGate = f), renderer, setRenderOverride: (f) => (renderOverride = f), fps: () => lastFps,
    setNear: (n) => { if (Math.abs(camera.near - n) > 1e-4) { camera.near = n; camera.updateProjectionMatrix(); } },
    setCards, cheer: () => { cheerUntil = performance.now() + 4000; cheerKind = "green"; },
    setState, setItems, setCareers, setProperties, setScreen, setClockSkew, focus, coinPop,
    setFollow: (v) => { follow = v; }, isFollowing: () => follow,
    colliders: () => { if (!colliders) { colliders = []; const objs = [...picks, ...Object.values(propGroups), ...propG.children]; for (const o of objs) { const b = new THREE.Box3().setFromObject(o); if (b.isEmpty() || b.max.y - b.min.y < 0.05) continue; if (b.max.y < 0.3) continue; colliders.push(b.expandByScalar(0.12)); } treeSpots.forEach(([x, z]) => colliders.push(new THREE.Box3(new THREE.Vector3(x - 1.8, 0, z - 1.8), new THREE.Vector3(x + 1.8, 6, z + 1.8)))); } return colliders; },
    THREE, scene, camera, controls, setLowQuality, isLowQuality: () => lowQ, R: R_ISLAND, onFrame: (f) => frameHooks.push(f),
    followObject: (o) => { followObj = o; follow = true; }, setGlance: (v, unpaid) => { glance = v; glanceUnpaid = !!unpaid; }, gregPos: () => greg.position,
    gregScreen: () => screenOf(greg, GREG_H + 0.5),
    distTo: (place) => { const p = P[place]; return p ? camera.position.distanceTo(new THREE.Vector3(p.x, 0, p.z)) : 999; },
    stop: () => cancelAnimationFrame(raf),
  };

  // ---------- code-built props and fallbacks ----------
  function gregFallback() {
    const g = new THREE.Group(); const GR = 0x5cc24a, B = 0xd8f08a; const s = GREG_H / 2;
    const body = M(G.sph(0.62, 18, 14), GR); body.scale.set(1, 1.08, 0.92); body.position.y = 0.78; g.add(body);
    const belly = M(G.sph(0.5, 16, 12), B, { outline: false }); belly.scale.set(0.9, 0.95, 0.6); belly.position.set(0, 0.7, 0.3); g.add(belly);
    for (const sd of [-1, 1]) {
      const eye = M(G.sph(0.24, 14, 10), 0xffffff); eye.position.set(sd * 0.26, 1.38, 0.24); g.add(eye);
      const pupil = M(G.sph(0.11, 10, 8), 0x111111, { outline: false }); pupil.position.set(sd * 0.26, 1.36, 0.45); g.add(pupil);
      const lid = M(new THREE.SphereGeometry(0.255, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.45), GR); lid.position.set(sd * 0.26, 1.38, 0.24); lid.rotation.x = 0.35; g.add(lid);
      const leg = M(G.sph(0.22, 10, 8), GR); leg.scale.set(1, 0.6, 1.5); leg.position.set(sd * 0.32, 0.13, 0.12); g.add(leg);
    }
    const hat = M(new THREE.SphereGeometry(0.42, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), 0xf28a2e); hat.position.set(0, 1.42, -0.05); g.add(hat);
    const bag = M(G.box(0.36, 0.3, 0.14), 0x8a5a33); bag.position.set(0.52, 0.55, 0.15); bag.rotation.y = -0.5; g.add(bag);
    g.scale.setScalar(s); return g;
  }
  function clubFallback() { const g = new THREE.Group(); const L = GREG_H * 0.65; const sh = M(G.cyl(0.025, 0.025, L, 6), 0xcccccc, { ot: 0.5 }); sh.position.y = -L / 2; g.add(sh); const h = M(G.box(0.24, 0.07, 0.09), 0x999999, { ot: 0.5 }); h.position.set(0.08, -L, 0); g.add(h); const gr = M(G.cyl(0.04, 0.04, 0.25, 6), 0xf28a2e, { ot: 0.5 }); gr.position.y = -0.1; g.add(gr); return g; }
  function bookProp() { const g = new THREE.Group(); const c = M(G.box(0.36, 0.05, 0.26), 0x4ab8ff, { ot: 0.5 }); g.add(c); const p = M(G.box(0.33, 0.06, 0.23), 0xfff7e0, { outline: false }); p.position.y = 0.02; g.add(p); return g; }
  function ballProp() { return M(G.sph(0.16, 12, 10), 0xffffff, { ot: 0.6 }); }
  function planeProp() { const g = new THREE.Group(); const w = M(new THREE.ConeGeometry(0.18, 0.4, 3), 0xffffff, { ot: 0.4 }); w.rotation.x = Math.PI / 2; w.scale.y = 0.2; g.add(w); return g; }
  function brushProp() { const g = new THREE.Group(); const h = M(G.cyl(0.02, 0.02, 0.35, 5), 0xb57a45, { ot: 0.4 }); g.add(h); const tip = M(G.cyl(0.03, 0.01, 0.08, 5), 0xe85d75, { outline: false }); tip.position.y = 0.2; g.add(tip); return g; }
  function cupProp() { return M(G.cyl(0.08, 0.07, 0.15, 10), 0xf28a2e, { ot: 0.5 }); }
  function panProp() { const g = new THREE.Group(); const p = M(G.cyl(0.18, 0.16, 0.05, 12), 0x333333, { ot: 0.5 }); g.add(p); const h = M(G.box(0.3, 0.03, 0.04), 0x333333, { outline: false }); h.position.x = -0.3; g.add(h); return g; }
  function bagProp() { const b = M(G.sph(0.16, 10, 8), 0xc9a24a, { ot: 0.5 }); b.scale.y = 1.2; return b; }
  function stoneProp() { return M(new THREE.DodecahedronGeometry(0.2, 0), 0x9a9caa, { ot: 0.5 }); }
  function lilyFallback() { const g = new THREE.Group(); const p = M(new THREE.CylinderGeometry(1.7, 1.7, 0.12, 22, 1, false, 0.35, Math.PI * 2 - 0.35), 0x43b049); p.position.y = 0.06; g.add(p); const f = M(new THREE.ConeGeometry(0.35, 0.5, 6), 0xff8fc0); f.position.set(0.9, 0.35, -0.6); g.add(f); return g; }
  function shedFallback() { const g = new THREE.Group(); const w = M(G.box(2.4, 2, 2), 0xc48c55); w.position.y = 1; g.add(w); const r = M(new THREE.ConeGeometry(2.1, 1.1, 4), 0x7a4a2a); r.position.y = 2.55; r.rotation.y = Math.PI / 4; g.add(r); return g; }
  function synthFallback() { const g = new THREE.Group(); const s = M(G.box(1.3, 0.2, 0.55), 0x3b3f4a); s.position.y = 0.95; s.rotation.x = -0.25; g.add(s); const k = M(G.box(1.1, 0.06, 0.2), 0xffffff, { ot: 0.5 }); k.position.set(0, 1.03, 0.12); k.rotation.x = -0.25; g.add(k); for (const x of [-0.5, 0.5]) { const l = M(G.box(0.08, 0.9, 0.08), 0x8a5a33, { ot: 0.6 }); l.position.set(x, 0.45, 0); g.add(l); } return g; }
  function pianoFallback() { const g = new THREE.Group(); const b = M(G.box(1.6, 1.3, 0.6), 0x2f8a3a); b.position.y = 0.65; g.add(b); const k = M(G.box(1.5, 0.08, 0.3), 0xffffff, { ot: 0.5 }); k.position.set(0, 0.85, 0.42); g.add(k); const st = M(G.box(0.8, 0.45, 0.4), 0x8a5a33); st.position.set(0, 0.22, 1.0); g.add(st); return g; }
  function flagFallback() { const g = new THREE.Group(); const pole = M(G.cyl(0.04, 0.04, 2.4, 6), 0xffffff, { ot: 0.6 }); pole.position.y = 1.2; g.add(pole); g.add(M(flagGeo(), 0xff4a3a, { side: THREE.DoubleSide, outline: false })); return g; }
}

// Walk clip data, measured from greg-walk.glb with forward kinematics: 3 cycles in 4.2 s, a planted foot moves
// back at 0.27 model units/s (x the rig's scale = metres/s at playback rate 1).
const WALK_CLIP = { dur: 4.2, cycles: 3, stance: 0.27 };
function buildBit() {
  const g = new THREE.Group(); g.userData.surface = "bit";
  const body = new THREE.Group(); body.position.y = 0.42; g.add(body);
  const shell = M(new THREE.CapsuleGeometry(0.2, 0.16, 6, 16), 0xe8edf2); shell.scale.set(1, 1, 0.9); body.add(shell);
  const band = M(G.cyl(0.205, 0.205, 0.05, 20), 0x4ab8ff, { ot: 0.4 }); band.position.y = -0.08; body.add(band);
  const cv = document.createElement("canvas"); cv.width = 128; cv.height = 96; const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.19), new THREE.MeshBasicMaterial({ map: tex })); face.position.set(0, 0.06, 0.182); body.add(face);
  const bezel = M(G.box(0.29, 0.22, 0.02), 0x1b1f2a, { ot: 0.3 }); bezel.position.set(0, 0.06, 0.172); body.add(bezel);
  const ant = M(G.cyl(0.008, 0.008, 0.14, 6), 0x777f8a, { outline: false }); ant.position.y = 0.33; body.add(ant);
  const light = new THREE.Mesh(G.sph(0.032, 10, 8), new THREE.MeshBasicMaterial({ color: 0x6cff7a })); light.position.y = 0.41; body.add(light);
  const arm = new THREE.Group(); arm.position.set(0.22, -0.02, 0); body.add(arm);
  { const a1 = M(G.cyl(0.02, 0.02, 0.18, 8), 0x9aa3ad, { ot: 0.3 }); a1.position.y = -0.09; arm.add(a1); const claw = M(new THREE.TorusGeometry(0.035, 0.01, 6, 10, Math.PI * 1.4), 0x4ab8ff, { ot: 0.3 }); claw.position.y = -0.19; claw.rotation.z = Math.PI / 2; arm.add(claw); }
  const stub = M(G.cyl(0.03, 0.03, 0.12, 8), 0x9aa3ad, { ot: 0.3 }); stub.position.set(-0.22, -0.04, 0); stub.rotation.z = 0.4; body.add(stub);
  const fork = M(G.box(0.1, 0.16, 0.06), 0x9aa3ad, { ot: 0.3 }); fork.position.y = 0.17; g.add(fork);
  const wheel = new THREE.Group(); wheel.position.y = 0.12; g.add(wheel); const tire = M(G.cyl(0.12, 0.12, 0.07, 18), 0x22262e, { ot: 0.4 }); tire.rotation.z = Math.PI / 2; wheel.add(tire); const hub = M(G.cyl(0.05, 0.05, 0.08, 10), 0x4ab8ff, { outline: false }); hub.rotation.z = Math.PI / 2; wheel.add(hub);
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.22, 16), new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.2, depthWrite: false })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02; shadow.userData.noCollide = true; g.add(shadow);
  Object.assign(g.userData, { body, face, cv, tex, light, arm, wheel, lastFace: "" });
  return g;
}
function drawBitFace(u, t, blink, talking, thinking) {
  const key = (blink ? "b" : "o") + (talking ? Math.floor(t * 8) % 3 : "") + (thinking ? Math.floor(t * 6) : ""); if (key === u.lastFace) return; u.lastFace = key;
  const x = u.cv.getContext("2d"); x.fillStyle = "#0e1726"; x.fillRect(0, 0, 128, 96);
  if (thinking) { x.fillStyle = "#6cff7a"; x.font = "11px monospace"; const L = ["fn()", "if(ok)", "{ }", "0x1f", "ret;", "=> 42", "map()"]; for (let i = 0; i < 7; i++) x.fillText(L[(i + Math.floor(t * 6)) % 7], 8 + ((i * 17) % 40), 14 + i * 12); }
  else { x.fillStyle = "#7fe3ff"; for (const ex of [40, 88]) { if (blink) x.fillRect(ex - 12, 40, 24, 4); else { x.fillRect(ex - 9, 26, 18, 22); x.fillStyle = "#e9fbff"; x.fillRect(ex - 3, 29, 6, 6); x.fillStyle = "#7fe3ff"; } }
    if (talking) { const h = [4, 10, 6][Math.floor(t * 8) % 3]; x.fillRect(52, 66, 24, h); } else x.fillRect(54, 68, 20, 3); }
  u.tex.needsUpdate = true;
}
function flagGeo() { const fg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 2.4, 0), new THREE.Vector3(0, 1.9, 0), new THREE.Vector3(0.9, 2.15, 0)]); fg.computeVertexNormals(); return fg; }
let _grad = null;
function toonGradient() { if (_grad) return _grad; const d = new Uint8Array([90, 170, 255]); _grad = new THREE.DataTexture(d, 3, 1, THREE.RedFormat); _grad.minFilter = _grad.magFilter = THREE.NearestFilter; _grad.needsUpdate = true; return _grad; }
function buildPlane() {
  const g = new THREE.Group(); const body = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.25, 4, 10), toon(0xffffff)); body.rotation.z = Math.PI / 2; g.add(body); outline(body, 0.8);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.08, 4.4), toon(0xff5a4a)); g.add(wing); outline(wing, 0.8);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.08), toon(0xff5a4a)); tail.position.set(-1.8, 0.4, 0); g.add(tail);
  return g;
}
function posterTex(emoji, color, text) {
  const c = document.createElement("canvas"); c.width = 256; c.height = 320; const x = c.getContext("2d");
  x.fillStyle = color; x.fillRect(0, 0, 256, 320);
  x.fillStyle = "rgba(255,255,255,.18)"; for (let i = 0; i < 256; i += 12) for (let j = 0; j < 320; j += 12) { x.beginPath(); x.arc(i, j, 2, 0, 7); x.fill(); }
  x.font = "140px serif"; x.textAlign = "center"; x.fillText(emoji, 128, 190);
  if (text) { x.fillStyle = "#141218"; x.font = "900 26px sans-serif"; x.fillText(text, 128, 290); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function wrap(x, text, X, Y, W, LH) { const words = text.split(" "); let line = ""; for (const w of words) { const t = line + w + " "; if (x.measureText(t).width > W && line) { x.fillText(line, X, Y); Y += LH; line = w + " "; } else line = t; } x.fillText(line, X, Y); }
function makeLabel(text, size = 64, color = "#111", bg = null, pill = false) {
  const c = document.createElement("canvas"); const w = pill ? 512 : 128, h = 128; c.width = w; c.height = h;
  const x = c.getContext("2d");
  if (bg) { x.fillStyle = bg; x.strokeStyle = "#111"; x.lineWidth = 8; roundRect(x, 6, 6, w - 12, h - 12, 30); x.fill(); x.stroke(); }
  x.font = `800 ${size * (pill ? 2 : 1.4)}px system-ui, sans-serif`; x.textAlign = "center"; x.textBaseline = "middle"; x.fillStyle = color;
  if (!bg && !pill) { x.lineWidth = 10; x.strokeStyle = "#111"; x.strokeText(text, w / 2, h / 2 + 4); x.fillStyle = color === "#111" ? "#fff" : color; }
  x.fillText(text, w / 2, h / 2 + 4);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
}
function roundRect(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Procedural tileable comic textures (canvas, mipmapped, anisotropic): no extra downloads.
const _tiles = {};
function tileTex(kind, renderer) {
  if (_tiles[kind]) return _tiles[kind];
  const c = document.createElement("canvas"); c.width = c.height = 256; const x = c.getContext("2d"); const r = mulberry(kind.length * 97);
  const pal = { grass: ["#74c94a", "#6bbf44", "#82d455", "#5fae3c"], sand: ["#f2d38a", "#ead08a", "#f6dc9a", "#e2c27a"], stone: ["#cdb79a", "#c3ab8c", "#d8c4a8", "#b89f80"], wood: ["#c48c55", "#b57a45", "#a96d3c", "#cf9862"] }[kind];
  x.fillStyle = pal[0]; x.fillRect(0, 0, 256, 256);
  if (kind === "wood") { for (let i = 0; i < 4; i++) { x.fillStyle = pal[i]; x.fillRect(0, i * 64, 256, 62); x.fillStyle = "rgba(20,18,24,.5)"; x.fillRect(0, i * 64 + 62, 256, 2); for (let k = 0; k < 6; k++) { x.strokeStyle = "rgba(90,50,20,.25)"; x.beginPath(); x.moveTo(0, i * 64 + 8 + k * 9); x.bezierCurveTo(80, i * 64 + 4 + k * 9 + r() * 6, 170, i * 64 + 12 + k * 9, 256, i * 64 + 8 + k * 9); x.stroke(); } } }
  else if (kind === "stone") { for (let i = 0; i < 26; i++) { x.fillStyle = pal[i % 4]; x.strokeStyle = "rgba(20,18,24,.45)"; x.lineWidth = 3; const cx = r() * 256, cy = r() * 256, w = 30 + r() * 30; x.beginPath(); x.ellipse(cx, cy, w, w * 0.7, r() * 3, 0, 7); x.fill(); x.stroke(); } }
  else { for (let i = 0; i < 2600; i++) { x.fillStyle = pal[1 + (i % 3)]; const px = r() * 256, py = r() * 256; if (kind === "grass") { x.fillRect(px, py, 2, 5 + r() * 4); } else { x.fillRect(px, py, 2, 2); } } if (kind === "grass") for (let i = 0; i < 18; i++) { x.fillStyle = ["#fff", "#ffd23f", "#ff8fc0"][i % 3]; x.beginPath(); x.arc(r() * 256, r() * 256, 2.5, 0, 7); x.fill(); } }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return (_tiles[kind] = t);
}

// ---------- Espresso rotunda: a real building with thick walls, an open door, open + glazed windows, a dome,
// and a fully furnished interior the fly can explore (counter, machine, pastry case, chalk menu, bulbs, tables, cups).
function lathe(profile, seg = 20) { return new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), seg); }
function cupGeo(h = 0.11, r = 0.05) { return lathe([[0, 0], [r * 0.72, 0], [r * 0.8, 0.008], [r, h * 0.85], [r * 1.04, h], [r * 0.9, h], [r * 0.86, h * 0.86], [r * 0.66, 0.012], [0, 0.012]], 18); }
function canvasTex(w, h, draw) { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }
function buildEspresso(SC) {
  const g = new THREE.Group(); g.userData.surface = "espresso";
  const R = 2.7, TH = 0.2, H = SC.wallH, FLOOR = 0.06, SEG = 36, segW = (2 * Math.PI * R) / SEG + 0.02;
  const wallC = 0xf3e3c3, trimC = 0xffffff, domeC = 0x3f8f7a, woodC = 0x7a4a2a;
  const base = M(G.cyl(R + 0.3, R + 0.4, FLOOR, 40), 0xb9ad9a); base.position.y = FLOOR / 2; g.add(base);
  const floorTex = canvasTex(256, 256, (x) => { for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { x.fillStyle = (i + j) % 2 ? "#2b2540" : "#efe6d6"; x.fillRect(i * 32, j * 32, 32, 32); } });
  const floor = new THREE.Mesh(G.cyl(R - TH / 2, R - TH / 2, 0.02, 40), toon(0xffffff, floorTex, { rep: 3 })); floor.position.y = FLOOR + 0.01; g.add(floor);
  // wall ring of thick segments; local +z faces the plaza (door), windows at +-55deg (open) and +-125deg (glazed)
  const DOOR = 0, WIN = [[0.96, true], [-0.96, true], [2.18, false], [-2.18, false]];
  const angDist = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * Math.PI * 2, cx = Math.sin(a) * (R - TH / 2), cz = Math.cos(a) * (R - TH / 2);
    const part = (y0, y1) => { const w = M(G.box(segW, y1 - y0, TH), wallC, { ot: 0.6 }); w.position.set(cx, FLOOR + (y0 + y1) / 2, cz); w.rotation.y = a; g.add(w); return w; };
    if (angDist(a, DOOR) < 0.36) { part(SC.doorH, H); continue; }
    const win = WIN.find(([wa]) => angDist(a, wa) < 0.2);
    if (win) {
      part(0, 0.95); part(2.25, H);
      const sill = M(G.box(segW, 0.06, TH + 0.12), trimC, { ot: 0.5 }); sill.position.set(cx, FLOOR + 0.98, cz); sill.rotation.y = a; g.add(sill);
      if (!win[1]) { const gl = new THREE.Mesh(G.box(segW, 1.27, 0.03), new THREE.MeshBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0.28, depthWrite: false })); gl.userData.collide = true; gl.position.set(cx, FLOOR + 1.6, cz); gl.rotation.y = a; g.add(gl); }
      continue;
    }
    part(0, H);
  }
  // window frames (mullions) + door frame
  for (const [wa] of WIN) for (const s of [-1, 1]) { const a = wa + s * 0.215; const m = M(G.box(0.08, 1.35, TH + 0.06), trimC, { ot: 0.5 }); m.position.set(Math.sin(a) * (R - TH / 2), FLOOR + 1.6, Math.cos(a) * (R - TH / 2)); m.rotation.y = a; g.add(m); }
  for (const s of [-1, 1]) { const a = s * 0.37; const j = M(G.box(0.12, SC.doorH, TH + 0.08), woodC, { ot: 0.6 }); j.position.set(Math.sin(a) * (R - TH / 2), FLOOR + SC.doorH / 2, Math.cos(a) * (R - TH / 2)); j.rotation.y = a; g.add(j); }
  const lintel = M(G.box(2.1, 0.14, TH + 0.1), woodC, { ot: 0.6 }); lintel.position.set(0, FLOOR + SC.doorH + 0.07, R - TH / 2); g.add(lintel);
  const door = new THREE.Group(); door.position.set(-0.78, FLOOR, R - 0.02); door.rotation.y = -1.9; g.add(door);
  { const leaf = M(G.box(0.7, SC.doorH - 0.05, 0.06), 0x3e7a5c); leaf.position.set(0.35, (SC.doorH - 0.05) / 2, 0); door.add(leaf); const pane = new THREE.Mesh(G.box(0.46, 1.0, 0.02), new THREE.MeshBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0.4 })); pane.position.set(0.35, 1.7, 0.03); door.add(pane); const knob = M(G.sph(0.035, 8, 6), 0xd8b45a, { ot: 0.4 }); knob.position.set(0.62, 1.05, 0.05); door.add(knob); }
  // cornice, dome, lantern
  const corn = M(new THREE.TorusGeometry(R + 0.02, 0.12, 6, 40), trimC, { ot: 0.6 }); corn.rotation.x = Math.PI / 2; corn.position.y = FLOOR + H + 0.04; g.add(corn);
  const dome = M(new THREE.SphereGeometry(R + 0.12, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), domeC, { side: THREE.DoubleSide }); dome.scale.y = 0.62; dome.position.y = FLOOR + H + 0.1; g.add(dome);
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; const rib = M(G.box(0.07, 0.07, 1.9), 0x2f6f5c, { outline: false }); rib.position.set(Math.sin(a) * 1.62, FLOOR + H + 1.25, Math.cos(a) * 1.62); rib.rotation.y = a; rib.rotation.x = -0.82; g.add(rib); }
  const lan = M(G.cyl(0.35, 0.4, 0.5, 12), trimC); lan.position.y = FLOOR + H + 1.95; g.add(lan); const lanTop = M(new THREE.ConeGeometry(0.42, 0.4, 12), domeC); lanTop.position.y = FLOOR + H + 2.4; g.add(lanTop);
  const ball = M(G.sph(0.09, 10, 8), 0xd8b45a, { ot: 0.5, emissive: 0.2 }); ball.position.y = FLOOR + H + 2.65; g.add(ball);
  // sign over the door + striped awning
  const signTex = canvasTex(512, 128, (x, w, h) => { x.fillStyle = "#2b2540"; roundRect(x, 4, 4, w - 8, h - 8, 24); x.fill(); x.strokeStyle = "#d8b45a"; x.lineWidth = 6; x.stroke(); x.fillStyle = "#ffe6a6"; x.font = "900 74px Georgia, serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("Espresso", w / 2, h / 2 + 4); });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.42), new THREE.MeshBasicMaterial({ map: signTex })); sign.position.set(0, FLOOR + SC.doorH + 0.42, R + 0.01); g.add(sign);
  const awnTex = canvasTex(128, 64, (x) => { for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? "#fff6e6" : "#c0392b"; x.fillRect(i * 16, 0, 16, 64); } });
  const awn = new THREE.Mesh(G.box(2.0, 0.05, 0.75), toon(0xffffff, awnTex)); outline(awn, 0.5); awn.position.set(0, FLOOR + SC.doorH + 0.05, R + 0.42); awn.rotation.x = 0.32; g.add(awn);
  // wall lamps outside
  for (const s of [-1, 1]) { const a = s * 0.48; const l = M(G.sph(0.09, 8, 6), 0xffe6a6, { emissive: 1, ot: 0.5 }); l.position.set(Math.sin(a) * (R + 0.12), FLOOR + 2.2, Math.cos(a) * (R + 0.12)); g.add(l); }

  // ----- interior -----
  const IN = new THREE.Group(); IN.position.y = FLOOR + 0.02; g.add(IN); const ints = [];
  // counter along the back
  const cz = -1.05;
  const ctr = M(G.box(2.7, 1.0, 0.55), woodC); ctr.position.set(0, 0.5, cz); IN.add(ctr);
  const ctrTop = M(G.box(2.85, 0.06, 0.66), 0xf4f1ea, { ot: 0.5 }); ctrTop.position.set(0, 1.03, cz + 0.03); IN.add(ctrTop);
  for (let i = 0; i < 6; i++) { const p = M(G.box(0.36, 0.7, 0.02), 0x8e5a34, { outline: false }); p.position.set(-1.1 + i * 0.44, 0.5, cz + 0.285); IN.add(p); }
  // espresso machine
  const mach = new THREE.Group(); mach.position.set(-0.55, 1.06, cz - 0.05); IN.add(mach);
  { const body = M(G.box(0.78, 0.46, 0.44), 0xc9ccd4); body.position.y = 0.23; mach.add(body);
    const red = M(G.box(0.8, 0.08, 0.46), 0xb33a2e, { ot: 0.4 }); red.position.y = 0.42; mach.add(red);
    const tray = M(G.box(0.7, 0.03, 0.36), 0x8f939c, { ot: 0.3 }); tray.position.y = 0.475; mach.add(tray);
    for (let i = 0; i < 3; i++) { const c = new THREE.Mesh(cupGeo(0.06, 0.03), toon(0xffffff, null, { side: THREE.DoubleSide })); outline(c, 0.4); c.position.set(-0.2 + i * 0.2, 0.49, 0); c.rotation.x = Math.PI; c.position.y = 0.55; mach.add(c); }
    for (const s of [-1, 1]) { const gh = M(G.cyl(0.06, 0.07, 0.08, 10), 0xe4e6ea, { ot: 0.4 }); gh.position.set(s * 0.17, 0.12, 0.25); mach.add(gh); const pf = M(G.box(0.03, 0.03, 0.2), 0x222222, { ot: 0.3 }); pf.position.set(s * 0.17, 0.08, 0.36); mach.add(pf); }
    const drip = M(G.box(0.7, 0.03, 0.18), 0x6b6f78, { ot: 0.3 }); drip.position.set(0, -0.0 + 0.015, 0.3); mach.add(drip);
    const wand = M(G.cyl(0.008, 0.008, 0.26, 5), 0xe4e6ea, { ot: 0.3 }); wand.position.set(0.36, 0.18, 0.26); wand.rotation.z = 0.35; mach.add(wand);
    const gaugeTex = canvasTex(64, 64, (x) => { x.fillStyle = "#fff"; x.beginPath(); x.arc(32, 32, 30, 0, 7); x.fill(); x.strokeStyle = "#111"; x.lineWidth = 3; x.stroke(); x.strokeStyle = "#c0392b"; x.beginPath(); x.moveTo(32, 32); x.lineTo(50, 18); x.stroke(); });
    const gauge = new THREE.Mesh(new THREE.CircleGeometry(0.06, 16), new THREE.MeshBasicMaterial({ map: gaugeTex })); gauge.position.set(0, 0.28, 0.222); mach.add(gauge); }
  ints.push({ id: "espresso_machine", obj: mach, r: 0.9, prompt: "Puff the steam wand", kind: "steam" });
  // grinder
  { const gr = M(G.cyl(0.09, 0.11, 0.3, 10), 0x333333); gr.position.set(-1.15, 1.21, cz); IN.add(gr); const hop = M(new THREE.ConeGeometry(0.11, 0.2, 10, 1, true), 0x9fd8ff, { side: THREE.DoubleSide, ot: 0.3 }); hop.rotation.x = Math.PI; hop.position.set(-1.15, 1.45, cz); IN.add(hop); const beans = M(G.cyl(0.07, 0.02, 0.1, 8), 0x4a2a16, { outline: false }); beans.position.set(-1.15, 1.43, cz); IN.add(beans); }
  // pastry case with real glass and pastries on two tiers
  const pc = new THREE.Group(); pc.position.set(0.55, 1.06, cz); IN.add(pc);
  { const b = M(G.box(0.9, 0.06, 0.48), 0x2b2540, { ot: 0.4 }); b.position.y = 0.03; pc.add(b);
    const glass = new THREE.Mesh(G.box(0.9, 0.46, 0.48), new THREE.MeshBasicMaterial({ color: 0xdff6ff, transparent: true, opacity: 0.22, depthWrite: false })); glass.position.y = 0.29; glass.userData.collide = true; pc.add(glass);
    const shelf = M(G.box(0.86, 0.02, 0.44), 0xffffff, { outline: false }); shelf.position.y = 0.26; pc.add(shelf);
    for (let i = 0; i < 4; i++) { const cr = M(new THREE.TorusGeometry(0.045, 0.025, 6, 10, Math.PI * 1.2), 0xd99a4e, { ot: 0.3 }); cr.position.set(-0.3 + i * 0.2, 0.09, 0); cr.rotation.x = -Math.PI / 2; pc.add(cr); }
    for (let i = 0; i < 4; i++) { const d = M(new THREE.TorusGeometry(0.04, 0.022, 6, 12), [0xff8fc0, 0x6e3a1e, 0xffd23f, 0xffffff][i], { ot: 0.3 }); d.position.set(-0.3 + i * 0.2, 0.3, 0); d.rotation.x = -Math.PI / 2; pc.add(d); } }
  ints.push({ id: "pastry_case", obj: pc, r: 0.8, prompt: "Sniff the croissants", kind: "sniff" });
  // register + tip jar
  { const reg = M(G.box(0.26, 0.18, 0.22), 0x3b3f4a); reg.position.set(1.2, 1.15, cz); reg.rotation.x = -0.2; IN.add(reg); const jar = new THREE.Mesh(cupGeo(0.12, 0.05), new THREE.MeshBasicMaterial({ color: 0xdff6ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide })); jar.position.set(1.0, 1.06, cz + 0.15); IN.add(jar); ints.push({ id: "tip_jar", obj: jar, r: 0.5, prompt: "Drop a crumb in the tip jar", kind: "tip" }); }
  // back shelf with jars, and the chalk menu on the back wall
  const bs = M(G.box(2.0, 0.05, 0.25), woodC, { ot: 0.4 }); bs.position.set(0, 1.75, -2.3); IN.add(bs);
  for (let i = 0; i < 7; i++) { const j = new THREE.Mesh(cupGeo(0.16, 0.06), toon([0xd99a4e, 0x6e3a1e, 0xf6e2a4][i % 3], null, { side: THREE.DoubleSide })); outline(j, 0.3); j.position.set(-0.85 + i * 0.28, 1.78, -2.3); IN.add(j); }
  const menuTex = canvasTex(512, 340, (x, w, h) => {
    x.fillStyle = "#1f2a24"; x.fillRect(0, 0, w, h); x.strokeStyle = "#8a5a33"; x.lineWidth = 18; x.strokeRect(0, 0, w, h);
    x.fillStyle = "#f4f1ea"; x.textAlign = "center"; x.font = "700 44px 'Comic Sans MS', cursive"; x.fillText("Espresso Menu", w / 2, 62);
    x.font = "28px 'Comic Sans MS', cursive"; x.textAlign = "left";
    [["Espresso", "2"], ["Flat white", "3"], ["Fly-ccino", "4"], ["Golden-hour latte", "4"], ["Croissant", "3"], ["Lily-pad tart", "3"]].forEach(([n, p], i) => { x.fillText(n, 40, 112 + i * 36); x.textAlign = "right"; x.fillText(p + " crumbs", w - 40, 112 + i * 36); x.textAlign = "left"; });
    x.fillStyle = "#ffd23f"; x.font = "22px 'Comic Sans MS', cursive"; x.textAlign = "center"; x.fillText("ask the universe for a refill", w / 2, h - 22);
  });
  const menu = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.0), new THREE.MeshBasicMaterial({ map: menuTex })); menu.position.set(0, 2.45, -2.39); IN.add(menu);
  ints.push({ id: "menu", obj: menu, r: 1.2, prompt: "Read the chalk menu", kind: "menu", tex: menuTex });
  // Edison bulbs on cords
  const bulbs = [];
  for (const [bx, bz, len] of [[-0.9, -0.45, 0.5], [0, -0.5, 0.55], [0.9, -0.45, 0.45], [-1.4, 0.75, 0.5], [1.4, 0.75, 0.45], [0, 1.5, 0.4]]) {
    const cord = M(G.cyl(0.006, 0.006, len, 4), 0x141218, { outline: false }); cord.position.set(bx, H - len / 2, bz); IN.add(cord);
    const cap = M(G.cyl(0.025, 0.025, 0.05, 8), 0x8a6a3a, { ot: 0.3 }); cap.position.set(bx, H - len - 0.02, bz); IN.add(cap);
    const bulb = new THREE.Mesh(G.sph(0.055, 10, 8), toon(0xffc46b, null, { emissive: 1 })); bulb.scale.y = 1.25; bulb.position.set(bx, H - len - 0.1, bz); IN.add(bulb); bulbs.push(bulb);
  }
  ints.push({ id: "bulbs", obj: bulbs[1], r: 0.7, prompt: "Bat the bulb", kind: "bulb" });
  // tables, bistro chairs, cups with saucers on top
  const cups = [];
  for (const [tx, tz] of [[-1.45, 0.7], [1.45, 0.7]]) {
    const t = new THREE.Group(); t.position.set(tx, 0, tz); IN.add(t);
    const top = M(G.cyl(0.36, 0.36, 0.035, 20), 0xf4f1ea, { ot: 0.5 }); top.position.y = SC.tableH; t.add(top);
    const stem = M(G.cyl(0.03, 0.03, SC.tableH, 6), 0x2b2540, { ot: 0.4 }); stem.position.y = SC.tableH / 2; t.add(stem);
    const foot = M(G.cyl(0.2, 0.22, 0.03, 12), 0x2b2540, { ot: 0.4 }); foot.position.y = 0.015; t.add(foot);
    for (const s of [-1, 1]) { const ch = new THREE.Group(); ch.position.set(0, 0, s * 0.55); ch.rotation.y = s > 0 ? Math.PI : 0; t.add(ch);
      const seat = M(G.cyl(0.19, 0.19, 0.03, 14), 0xc0392b, { ot: 0.4 }); seat.position.y = SC.chairSeat; ch.add(seat);
      for (const [lx, lz] of [[0.12, 0.12], [-0.12, 0.12], [0.12, -0.12], [-0.12, -0.12]]) { const l = M(G.cyl(0.01, 0.012, SC.chairSeat, 4), 0x2b2540, { outline: false }); l.position.set(lx, SC.chairSeat / 2, lz); ch.add(l); }
      const back = M(new THREE.TorusGeometry(0.17, 0.013, 5, 14, Math.PI), 0x2b2540, { outline: false }); back.position.set(0, SC.chairSeat + 0.05, -0.17); ch.add(back); }
    const saucer = M(G.cyl(0.08, 0.06, 0.012, 16), 0xffffff, { ot: 0.3 }); saucer.position.set(0.08, SC.tableH + 0.024, 0.05); t.add(saucer);
    const cup = new THREE.Mesh(cupGeo(SC.cupH, SC.cupR), toon(0xffffff, null, { side: THREE.DoubleSide })); outline(cup, 0.35); cup.position.set(0.08, SC.tableH + 0.03, 0.05); t.add(cup);
    const handle = M(new THREE.TorusGeometry(0.025, 0.006, 5, 10), 0xffffff, { ot: 0.3 }); handle.position.set(0.08 + SC.cupR + 0.015, SC.tableH + 0.03 + SC.cupH * 0.55, 0.05); t.add(handle);
    const latte = canvasTex(64, 64, (x) => { x.fillStyle = "#7a4a26"; x.fillRect(0, 0, 64, 64); x.fillStyle = "#f6e6cc"; x.beginPath(); x.moveTo(32, 50); x.bezierCurveTo(4, 30, 18, 8, 32, 22); x.bezierCurveTo(46, 8, 60, 30, 32, 50); x.fill(); });
    const coffee = new THREE.Mesh(new THREE.CircleGeometry(SC.cupR * 0.86, 16), new THREE.MeshBasicMaterial({ map: latte })); coffee.rotation.x = -Math.PI / 2; coffee.position.set(0.08, SC.tableH + 0.03 + SC.cupH * 0.8, 0.05); t.add(coffee);
    cups.push(cup);
  }
  ints.push({ id: "cup", obj: cups[0], r: 0.45, prompt: "Taste the coffee", kind: "coffee" });
  ints.push({ id: "cup2", obj: cups[1], r: 0.45, prompt: "Taste the coffee", kind: "coffee" });
  // window bar with stools facing out, plants, a rug by the door
  { const wb = M(G.box(1.1, 0.05, 0.3), woodC, { ot: 0.4 }); wb.position.set(Math.sin(2.18) * 2.25, 1.0, Math.cos(2.18) * 2.25); wb.rotation.y = 2.18; IN.add(wb);
    for (const s of [-1, 1]) { const pot = M(G.cyl(0.14, 0.11, 0.26, 10), 0xc8633a); pot.position.set(s * 2.0, 0.13, 0.9); IN.add(pot); const pl = M(new THREE.IcosahedronGeometry(0.24, 0), 0x3fae4a); pl.position.set(s * 2.0, 0.45, 0.9); IN.add(pl); }
    const rug = M(G.cyl(0.6, 0.6, 0.01, 18), 0xc0392b, { outline: false }); rug.scale.z = 0.6; rug.position.set(0, 0.006, 2.0); IN.add(rug); }
  g.userData.interactables = ints; g.userData.bulbs = bulbs; g.userData.machine = mach;
  return g;
}
// The Fly Nest: an overturned terracotta pot where every fly spawns, with a ring of spawn points and a welcome sign.
function buildNest() {
  const g = new THREE.Group(); g.userData.surface = "nest";
  const pot = new THREE.Mesh(lathe([[0.42, 0], [0.62, 1.15], [0.7, 1.18], [0.7, 1.28], [0.6, 1.28], [0.55, 1.12], [0.36, 0.06], [0, 0.06], [0, 0], [0.42, 0]], 24), toon(0xc8633a, null, { side: THREE.DoubleSide })); outline(pot, 0.6);
  pot.rotation.x = Math.PI / 2; pot.position.set(0, 0.68, -0.6); g.add(pot);
  const moss = M(G.cyl(0.5, 0.5, 0.06, 14), 0x5fae3c, { outline: false }); moss.position.set(0, 0.06, 0.05); moss.scale.z = 1.6; g.add(moss);
  for (let i = 0; i < 7; i++) { const c = M(new THREE.DodecahedronGeometry(0.03, 0), 0xe0b070, { ot: 0.3 }); c.position.set(-0.3 + i * 0.1, 0.11, 0.1 + (i % 3) * 0.12); g.add(c); }
  const signTex = canvasTex(512, 384, () => {});
  const board = new THREE.Group(); board.position.set(1.1, 0, 0.7); board.rotation.y = -0.5; g.add(board);
  const post = M(G.box(0.08, 1.4, 0.08), 0x8a5a33, { ot: 0.5 }); post.position.y = 0.7; board.add(post);
  const plank = M(G.box(1.1, 0.8, 0.05), 0x8a5a33, { ot: 0.5 }); plank.position.y = 1.35; board.add(plank);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.74), new THREE.MeshBasicMaterial({ map: signTex })); face.position.set(0, 1.35, 0.03); board.add(face);
  function drawSign(online) {
    const x = signTex.image.getContext("2d"), w = 512, h = 384; x.fillStyle = "#fff6dc"; x.fillRect(0, 0, w, h);
    x.fillStyle = "#141218"; x.textAlign = "center"; x.font = "900 46px system-ui, sans-serif"; x.fillText("THE FLY NEST", w / 2, 58);
    x.font = "700 24px system-ui, sans-serif"; x.fillStyle = "#3a3340";
    ["Click to fly · Mouse look", "WASD fly · Space up · Ctrl down", "Shift boost · E rub · C perch", "F interact · V view · M map · H help"].forEach((l, i) => x.fillText(l, w / 2, 112 + i * 40));
    x.fillStyle = "#3ea24a"; roundRect(x, 116, 286, 280, 64, 32); x.fill(); x.fillStyle = "#fff"; x.font = "900 32px system-ui, sans-serif"; x.fillText(`${online} ${online === 1 ? "fly" : "flies"} online`, w / 2, 330);
    signTex.needsUpdate = true;
  }
  drawSign(1);
  g.userData.drawSign = drawSign; g.userData.sign = face;
  g.userData.spawns = Array.from({ length: 10 }, (_, i) => { const a = (i / 10) * Math.PI * 2; return new THREE.Vector3(Math.sin(a) * 0.7, 1.15 + (i % 2) * 0.12, 2.6 + Math.cos(a) * 0.35); });
  return g;
}

// ---------- Greg HQ: deep-blue wood-panel room, arched sea window, red chair, desk + live "Post" monitor,
// frog mug with steam, brass lamp, island painting, shelves (books, frog trophy, crystal), hanging ivy,
// GREG HQ sign, frog bean-bag, purple + yellow boxes, round blue rug, raised platform with warm LED steps,
// and a lush grass floor with stones and daisies. Local frame: -x = sea window, +z = open doorway.
function buildHQ(SC, screenTex, renderer) {
  const g = new THREE.Group(); g.userData.surface = "hq";
  const W = 8, D = 7, H = 3.9, T = 0.18;
  const panel = canvasTex(256, 256, (x) => { x.fillStyle = "#2c58a8"; x.fillRect(0, 0, 256, 256); for (let i = 0; i < 8; i++) { const c = ["#3062b5", "#2a55a3", "#2f5db0", "#2850a0"][i % 4]; x.fillStyle = c; x.fillRect(i * 32, 0, 30, 256); x.fillStyle = "rgba(8,16,40,.55)"; x.fillRect(i * 32 + 30, 0, 2, 256); for (let k = 0; k < 6; k++) { x.strokeStyle = "rgba(255,255,255,.05)"; x.beginPath(); x.moveTo(i * 32 + 4 + k * 4, 0); x.bezierCurveTo(i * 32 + 8 + k * 4, 80, i * 32 + k * 4, 170, i * 32 + 6 + k * 4, 256); x.stroke(); } } });
  panel.wrapS = panel.wrapT = THREE.RepeatWrapping;
  const wallM = toon(0xffffff, panel, { rep: 2 });
  const wall = (w, h, x, y, z, ry = 0) => { const m = new THREE.Mesh(G.box(w, h, T), wallM); outline(m, 0.6); m.position.set(x, y, z); m.rotation.y = ry; g.add(m); return m; };
  // floor: grass slab (raised 2 cm so it never z-fights the island)
  const floor = new THREE.Mesh(G.box(W, 0.06, D), toon(0xffffff, tileTex("grass", renderer), { rep: 3 })); floor.position.y = 0.03; g.add(floor);
  // back wall (desk + sign), right wall, front wall with a wide doorway
  wall(W, H, 0, H / 2, -D / 2); wall(D, H, W / 2, H / 2, 0, Math.PI / 2);
  wall(2.4, H, -W / 2 + 1.2, H / 2, D / 2); wall(2.2, H, W / 2 - 1.1, H / 2, D / 2); wall(3.4, H - 2.9, 0.1, 2.9 + (H - 2.9) / 2, D / 2);
  // sea wall: low sill, big window with mullions and an arched top
  const sill = new THREE.Mesh(G.box(T, 0.55, D), wallM); outline(sill, 0.6); sill.position.set(-W / 2, 0.275, 0); g.add(sill);
  const frameC = 0x2b2a35;
  for (const z of [-D / 2 + 0.05, -1.2, 1.2, D / 2 - 0.05]) { const m = M(G.box(0.14, H - 0.55, 0.14), frameC, { ot: 0.5 }); m.position.set(-W / 2, 0.55 + (H - 0.55) / 2, z); g.add(m); }
  for (const y of [0.6, 2.2]) { const m = M(G.box(0.14, 0.1, D), frameC, { ot: 0.5 }); m.position.set(-W / 2, y, 0); g.add(m); }
  const arch = M(new THREE.TorusGeometry(1.7, 0.08, 6, 24, Math.PI), frameC, { ot: 0.5 }); arch.rotation.y = Math.PI / 2; arch.position.set(-W / 2, 2.2, 0); arch.scale.set(1, 0.9, 1); g.add(arch);
  const glass = new THREE.Mesh(G.box(0.03, H - 0.6, D - 0.1), new THREE.MeshBasicMaterial({ color: 0xcdeeff, transparent: true, opacity: 0.12, depthWrite: false })); glass.userData.collide = true; glass.position.set(-W / 2, 0.55 + (H - 0.6) / 2, 0); g.add(glass);
  // sloped wooden ceiling with recessed warm lights
  const ceilTex = canvasTex(128, 128, (x) => { for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? "#5a3a22" : "#64422a"; x.fillRect(0, i * 16, 128, 15); x.fillStyle = "#2a1a10"; x.fillRect(0, i * 16 + 15, 128, 1); } });
  ceilTex.wrapS = ceilTex.wrapT = THREE.RepeatWrapping;
  const ceil = new THREE.Mesh(G.box(W + 0.4, 0.14, D + 0.4), toon(0xffffff, ceilTex, { rep: 3 })); outline(ceil, 0.6); ceil.position.set(0, H + 0.07, 0); g.add(ceil);
  for (let i = 0; i < 4; i++) { const b = M(G.box(0.22, 0.28, D + 0.4), 0x4a2e1a, { ot: 0.5 }); b.position.set(-3 + i * 2, H - 0.12, 0); g.add(b); }
  for (const [x, z] of [[-2, -1.5], [1, -1.5], [-2, 1.5], [1.5, 1.5]]) { const d = new THREE.Mesh(new THREE.CircleGeometry(0.11, 14), toon(0xfff1c4, null, { emissive: 1 })); d.rotation.x = Math.PI / 2; d.position.set(x, H - 0.005, z); d.userData.noCollide = true; g.add(d); }
  // round blue rug (decal over the grass)
  const rugTex = canvasTex(256, 256, (x) => { const cs = ["#1e3f8f", "#3a63c4", "#d9c88a", "#2a4fa8", "#1a3577"]; for (let i = 0; i < 5; i++) { x.fillStyle = cs[i]; x.beginPath(); x.arc(128, 128, 126 - i * 22, 0, 7); x.fill(); } });
  const rug = new THREE.Mesh(new THREE.CircleGeometry(1.5, 32), new THREE.MeshBasicMaterial({ map: rugTex })); rug.rotation.x = -Math.PI / 2; rug.position.set(-0.8, 0.065, -1.0); rug.scale.y = 0.75; decal(rug, 2); g.add(rug);
  // desk with drawers, monitor (live Post screen), webcam, keyboard
  const desk = new THREE.Group(); desk.position.set(-0.2, 0, -2.75); g.add(desk);
  { const wood = 0x6b4226; const top = M(G.box(2.6, 0.08, 0.95), wood); top.position.y = 0.8; desk.add(top);
    const ped = M(G.box(0.7, 0.76, 0.85), 0x3a3a46); ped.position.set(0.85, 0.38, 0); desk.add(ped);
    for (const y of [0.2, 0.52]) { const dr = M(G.box(0.62, 0.26, 0.02), 0x4a4a58, { ot: 0.4 }); dr.position.set(0.85, y, 0.43); desk.add(dr); const h = M(G.box(0.26, 0.03, 0.03), 0xd8b45a, { ot: 0.3, emissive: 0.3 }); h.position.set(0.85, y + 0.04, 0.45); desk.add(h); }
    const leg = M(G.box(0.07, 0.76, 0.8), wood, { ot: 0.4 }); leg.position.set(-1.2, 0.38, 0); desk.add(leg);
    // four monitors: left Tweets, center Charts + portfolio, right pump.fun feed, top NFTs (canvases drawn by screens.js)
    const mkScreen = (key, w, h, x, y, z, ry) => { const cv = document.createElement("canvas"); cv.width = Math.round(w * 900); cv.height = Math.round(h * 900); const tx = new THREE.CanvasTexture(cv); tx.colorSpace = THREE.SRGBColorSpace; tx.anisotropy = 4;
      const grp = new THREE.Group(); grp.position.set(x, y, z); grp.rotation.y = ry; desk.add(grp);
      const fr = M(G.box(w + 0.06, h + 0.06, 0.05), 0x15151c); grp.add(fr); const sc = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tx })); sc.position.z = 0.028; grp.add(sc); sc.userData.screen = key;
      screens[key] = { cv, tx, mesh: sc }; return grp; };
    const screens = {};
    mkScreen("charts", 0.95, 0.58, -0.1, 1.3, -0.22, 0); mkScreen("tweets", 0.66, 0.46, -1.0, 1.24, -0.12, 0.38); mkScreen("pump", 0.66, 0.46, 0.8, 1.24, -0.12, -0.38); mkScreen("nfts", 0.78, 0.4, -0.1, 1.86, -0.26, 0);
    for (const [x, ry] of [[-0.1, 0], [-1.0, 0.38], [0.8, -0.38]]) { const st = M(G.box(0.07, 0.34, 0.07), 0x2a2a33, { ot: 0.4 }); st.position.set(x, 0.98, -0.2); desk.add(st); }
    const pole = M(G.cyl(0.02, 0.02, 0.5, 6), 0x2a2a33, { ot: 0.3 }); pole.position.set(-0.1, 1.84, -0.32); desk.add(pole);
    const cam = M(G.box(0.14, 0.07, 0.07), 0x22222a, { ot: 0.3 }); cam.position.set(-0.1, 2.1, -0.24); desk.add(cam);
    g.userData.screens = screens;
    const kb = M(G.box(0.7, 0.03, 0.22), 0x2a2a33, { ot: 0.4 }); kb.position.set(-0.2, 0.855, 0.2); desk.add(kb);
    const mouse = M(G.sph(0.04, 8, 6), 0x2a2a33, { ot: 0.3 }); mouse.scale.set(1, 0.5, 1.4); mouse.position.set(0.3, 0.855, 0.22); desk.add(mouse); }
  // frog mug with steam
  const mug = new THREE.Mesh(cupGeo(0.13, 0.055), toon(0xffffff, null, { side: THREE.DoubleSide })); outline(mug, 0.35); mug.position.set(0.45, 0.84, -2.45); g.add(mug);
  for (const s of [-1, 1]) { const e = M(G.sph(0.018, 8, 6), 0x5cc24a, { ot: 0.3 }); e.position.set(0.45 + s * 0.022, 0.96, -2.395); g.add(e); }
  const mugSteam = []; for (let i = 0; i < 4; i++) { const s = new THREE.Mesh(G.sph(0.03, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false })); s.userData.noCollide = true; g.add(s); mugSteam.push(s); }
  // brass floor lamp at the right end of the desk, arching over the corner
  { const brass = 0xc9a04a; const b = M(G.cyl(0.16, 0.18, 0.05, 14), brass, { ot: 0.4 }); b.position.set(1.45, 0.085, -2.75); g.add(b);
    const p1 = M(G.cyl(0.02, 0.02, 1.6, 6), brass, { ot: 0.3 }); p1.position.set(1.45, 0.9, -2.75); g.add(p1);
    const a2 = M(G.cyl(0.015, 0.015, 0.5, 6), brass, { ot: 0.3 }); a2.position.set(1.27, 1.78, -2.62); a2.rotation.z = 1.1; a2.rotation.y = 0.6; g.add(a2);
    const sh = M(new THREE.ConeGeometry(0.16, 0.2, 14, 1, true), brass, { side: THREE.DoubleSide, ot: 0.4 }); sh.position.set(1.08, 1.68, -2.5); g.add(sh);
    const bulb = new THREE.Mesh(G.sph(0.06, 8, 6), toon(0xfff1b0, null, { emissive: 1 })); bulb.position.set(1.08, 1.62, -2.5); bulb.userData.noCollide = true; g.add(bulb);
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.45, 20), new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.16, depthWrite: false })); glow.rotation.x = -Math.PI / 2; glow.position.set(0.9, 0.845, -2.5); decal(glow, 3); g.add(glow); }
  // red office chair (the seat Greg sits in)
  const chair = new THREE.Group(); chair.position.set(-0.4, 0, -1.75); g.add(chair);
  { const red = 0xc8352b; const seat = M(G.box(0.72, 0.16, 0.66), red); seat.position.y = 0.55; chair.add(seat);
    const back = M(G.box(0.74, 0.95, 0.18), red); back.position.set(0, 1.12, 0.32); back.rotation.x = -0.1; chair.add(back);
    for (let i = 0; i < 4; i++) { const q = M(G.box(0.6, 0.02, 0.03), 0x9e2a22, { outline: false }); q.position.set(0, 0.8 + i * 0.2, 0.42); chair.add(q); }
    for (const s of [-1, 1]) { const arm = M(G.box(0.08, 0.06, 0.5), 0x2a2a33, { ot: 0.3 }); arm.position.set(s * 0.4, 0.78, 0.05); chair.add(arm); const ap = M(G.box(0.04, 0.2, 0.04), 0x2a2a33, { outline: false }); ap.position.set(s * 0.4, 0.66, 0.05); chair.add(ap); }
    const post = M(G.cyl(0.04, 0.04, 0.38, 8), 0x9a9aa6, { ot: 0.3 }); post.position.y = 0.3; chair.add(post);
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; const l = M(G.box(0.36, 0.04, 0.06), 0x2a2a33, { ot: 0.3 }); l.position.set(Math.cos(a) * 0.18, 0.09, Math.sin(a) * 0.18); l.rotation.y = -a; chair.add(l); const w = M(G.sph(0.045, 8, 6), 0x111111, { ot: 0.3 }); w.position.set(Math.cos(a) * 0.36, 0.045, Math.sin(a) * 0.36); chair.add(w); } }
  // island painting
  const paint = canvasTex(256, 200, (x, w, h) => { const sky = x.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, "#9fd8ff"); sky.addColorStop(1, "#e8f6ff"); x.fillStyle = sky; x.fillRect(0, 0, w, h); x.fillStyle = "#3aa7c9"; x.fillRect(0, h * 0.55, w, h); x.fillStyle = "#f2d38a"; x.beginPath(); x.ellipse(w / 2, h * 0.62, 90, 26, 0, 0, 7); x.fill(); x.fillStyle = "#5cc24a"; x.beginPath(); x.ellipse(w / 2, h * 0.56, 76, 30, 0, Math.PI, 0); x.fill(); x.fillStyle = "#3f8f3a"; for (const [a, b] of [[90, 70], [150, 76], [120, 64]]) { x.beginPath(); x.arc(a, b, 14, 0, 7); x.fill(); } x.fillStyle = "#fff"; x.beginPath(); x.arc(120, 82, 6, 0, 7); x.arc(134, 82, 6, 0, 7); x.fill(); });
  { const fr = M(G.box(1.2, 1.0, 0.06), 0xc9a04a); fr.position.set(-2.6, 2.0, -D / 2 + 0.12); g.add(fr); const pic = new THREE.Mesh(new THREE.PlaneGeometry(1.04, 0.84), new THREE.MeshBasicMaterial({ map: paint })); pic.position.set(-2.6, 2.0, -D / 2 + 0.16); g.add(pic); }
  // shelves: books, frog trophy, crystal
  const shelfX = 1.25;
  for (const y of [1.75, 2.45]) { const s = M(G.box(1.5, 0.05, 0.3), 0x6b4226, { ot: 0.4 }); s.position.set(shelfX, y, -D / 2 + 0.25); g.add(s); const led = new THREE.Mesh(G.box(1.4, 0.015, 0.02), toon(0xffc46b, null, { emissive: 1 })); led.position.set(shelfX, y - 0.035, -D / 2 + 0.38); led.userData.noCollide = true; g.add(led); }
  { const books = new THREE.InstancedMesh(G.box(0.07, 0.3, 0.22), toon(0xffffff), 12); const d = new THREE.Object3D(); for (let i = 0; i < 12; i++) { d.position.set(shelfX - 0.65 + i * 0.075, 1.93, -D / 2 + 0.25); d.rotation.z = i === 11 ? 0.3 : 0; d.scale.y = 0.8 + ((i * 37) % 5) * 0.06; d.updateMatrix(); books.setMatrixAt(i, d.matrix); books.setColorAt(i, new THREE.Color([0xc8352b, 0x2f8a3a, 0xd8b45a, 0x3a63c4, 0x7a4a2a, 0x8a5cff][i % 6])); } outline(books, 0.4); g.add(books);
    const tb = M(G.box(0.18, 0.06, 0.14), 0x6b4226, { ot: 0.3 }); tb.position.set(shelfX + 0.45, 2.51, -D / 2 + 0.25); g.add(tb);
    const tr = M(G.sph(0.11, 12, 10), 0xd8b45a, { emissive: 0.25, ot: 0.4 }); tr.scale.set(1, 0.85, 0.9); tr.position.set(shelfX + 0.45, 2.64, -D / 2 + 0.25); g.add(tr);
    for (const s of [-1, 1]) { const e = M(G.sph(0.04, 8, 6), 0xd8b45a, { emissive: 0.25, ot: 0.3 }); e.position.set(shelfX + 0.45 + s * 0.05, 2.73, -D / 2 + 0.27); g.add(e); }
    const cr = M(new THREE.OctahedronGeometry(0.11, 0), 0xa07cff, { emissive: 0.7, ot: 0.4 }); cr.scale.y = 1.5; cr.position.set(shelfX - 0.3, 2.62, -D / 2 + 0.25); g.add(cr);
    const pf = M(G.box(0.3, 0.38, 0.04), 0x3a2a5a, { ot: 0.4 }); pf.position.set(shelfX + 0.1, 2.67, -D / 2 + 0.22); pf.rotation.z = -0.08; g.add(pf); }
  // GREG HQ sign with the frog-face logo
  const signTex = canvasTex(320, 400, (x, w, h) => { x.fillStyle = "#1a2f5e"; x.fillRect(0, 0, w, h); x.strokeStyle = "#d8b45a"; x.lineWidth = 8; x.fillStyle = "#e9c46a"; x.beginPath(); x.ellipse(160, 120, 92, 62, 0, 0, 7); x.stroke(); for (const s of [-1, 1]) { x.beginPath(); x.arc(160 + s * 48, 64, 30, 0, 7); x.fill(); x.stroke(); x.fillStyle = "#1a2f5e"; x.beginPath(); x.arc(160 + s * 48, 64, 13, 0, 7); x.fill(); x.fillStyle = "#e9c46a"; } x.beginPath(); x.arc(160, 128, 50, 0.2, Math.PI - 0.2); x.stroke(); x.font = "900 92px Georgia, serif"; x.textAlign = "center"; x.fillStyle = "#e9c46a"; x.strokeStyle = "#7a5a1e"; x.lineWidth = 4; x.fillText("GREG", 160, 278); x.strokeText("GREG", 160, 278); x.fillText("HQ", 160, 370); x.strokeText("HQ", 160, 370); });
  { const b = M(G.box(1.45, 1.8, 0.08), 0x13234a); b.position.set(2.85, 2.35, -D / 2 + 0.13); g.add(b); const f = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.62), new THREE.MeshBasicMaterial({ map: signTex })); f.position.set(2.85, 2.35, -D / 2 + 0.18); g.add(f); g.userData.sign = f;
    for (let i = 0; i < 4; i++) { const sl = M(G.box(0.06, 3.2, 0.08), 0x6b4226, { ot: 0.3 }); sl.position.set(3.65 + i * 0.09, 1.9, -D / 2 + 0.15); g.add(sl); } }
  // raised wooden platform with warm LED step lights (bean-bag corner)
  const plat = new THREE.Group(); plat.position.set(W / 2 - 1.7, 0, 0.6); g.add(plat);
  { const woodTex = tileTex("wood", renderer); const deckM = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 0.3, 36, 1, false, Math.PI, Math.PI), toon(0xffffff, woodTex, { rep: 2 })); outline(deckM, 0.5); deckM.position.y = 0.15; plat.add(deckM);
    const strip = new THREE.Mesh(new THREE.TorusGeometry(2.31, 0.018, 4, 40, Math.PI), toon(0xffc46b, null, { emissive: 1 })); strip.rotation.x = Math.PI / 2; strip.rotation.z = Math.PI; strip.position.y = 0.05; strip.userData.noCollide = true; plat.add(strip);
    for (let i = 0; i < 5; i++) { const a = Math.PI + (i + 0.5) * (Math.PI / 5); const l = new THREE.Mesh(G.box(0.12, 0.05, 0.02), toon(0xfff1c4, null, { emissive: 1 })); l.position.set(Math.sin(a) * 2.31, 0.17, Math.cos(a) * 2.31); l.rotation.y = a; l.userData.noCollide = true; plat.add(l); } }
  // frog bean-bag sofa on the platform
  { const bb = new THREE.Group(); bb.position.set(W / 2 - 1.1, 0.3, 1.2); bb.rotation.y = -Math.PI / 2 - 0.5; g.add(bb);
    const base = M(G.sph(0.9, 20, 14), 0x5fa83c); base.scale.set(1.25, 0.5, 1); base.position.y = 0.4; bb.add(base);
    const back = M(G.sph(0.7, 18, 12), 0x6cb845); back.scale.set(1.3, 0.75, 0.6); back.position.set(0, 0.8, -0.5); bb.add(back);
    for (const s of [-1, 1]) { const eye = M(G.sph(0.17, 12, 10), 0x6cb845); eye.position.set(s * 0.32, 1.3, -0.45); bb.add(eye); const lid = M(new THREE.TorusGeometry(0.08, 0.018, 5, 10, Math.PI), 0x1b1b1b, { outline: false }); lid.position.set(s * 0.32, 1.32, -0.29); lid.rotation.z = Math.PI; bb.add(lid); }
    const smile = M(new THREE.TorusGeometry(0.2, 0.02, 5, 14, Math.PI), 0x1b1b1b, { outline: false }); smile.position.set(0, 1.08, -0.18); smile.rotation.z = Math.PI; bb.add(smile);
    for (const s of [-1, 1]) { const ch = M(G.sph(0.06, 8, 6), 0xff8fa0, { outline: false }); ch.scale.z = 0.4; ch.position.set(s * 0.42, 1.08, -0.22); bb.add(ch); } }
  // purple + yellow storage boxes
  { const p = M(G.box(1.0, 1.4, 0.9), 0x6a3fc8); p.position.set(W / 2 - 0.65, 0.3 + 0.7, -2.4); g.add(p); const lid = M(G.box(1.06, 0.08, 0.96), 0x7d52dd, { ot: 0.4 }); lid.position.set(W / 2 - 0.65, 0.3 + 1.44, -2.4); g.add(lid);
    const y = M(G.box(0.7, 0.6, 0.8), 0xf2b232); y.position.set(W / 2 - 1.2, 0.3 + 0.3, -1.75); y.rotation.y = 0.25; g.add(y); }
  // plants: big potted plant by the window, flowers, floor lantern, stones + daisies in the grass
  { const pot = M(G.cyl(0.32, 0.24, 0.6, 14), 0xf0ece4); pot.position.set(-3.3, 0.3, -2.6); g.add(pot);
    const leafG = new THREE.SphereGeometry(0.35, 8, 6); leafG.scale(1, 0.18, 0.5);
    for (let i = 0; i < 9; i++) { const a = i * 2.4; const l = M(leafG, 0x3f9a3a, { ot: 0.4 }); l.position.set(-3.3 + Math.cos(a) * 0.3, 0.9 + (i % 3) * 0.3, -2.6 + Math.sin(a) * 0.3); l.rotation.set(0.5 * Math.sin(a), -a, -0.6 + (i % 3) * 0.2); g.add(l); }
    const lant = M(G.box(0.3, 0.75, 0.3), 0x3a2a1a, { ot: 0.4 }); lant.position.set(-2.4, 0.38, -2.95); g.add(lant); const lg = new THREE.Mesh(G.box(0.24, 0.6, 0.24), toon(0xffd9a0, null, { emissive: 1 })); lg.position.set(-2.4, 0.4, -2.95); g.add(lg);
    for (const [x, z, s] of [[-3.2, 2.6, 0.5], [-1.8, 3.0, 0.35], [2.0, -0.2, 0.4], [-3.5, 0.6, 0.3]]) { const r = M(new THREE.DodecahedronGeometry(s, 1), 0x9a9caa, { ot: 0.5 }); r.scale.y = 0.55; r.position.set(x, s * 0.25, z); g.add(r); }
    const pts = []; let a = 7; const rr = () => ((a = (a * 16807) % 2147483647) / 2147483647); for (let i = 0; i < 70; i++) { const x = (rr() - 0.5) * (W - 0.6), z = (rr() - 0.5) * (D - 0.6); if (x > 1.2 && z > -1.8) continue; pts.push([x, z]); }
    const daisy = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 0.01, 8), toon(0xffffff), pts.length); const cen = new THREE.InstancedMesh(G.sph(0.018, 6, 4), toon(0xffd23f), pts.length); const d = new THREE.Object3D();
    pts.forEach(([x, z], i) => { d.position.set(x, 0.12, z); d.rotation.set(0.2, 0, 0.1); d.updateMatrix(); daisy.setMatrixAt(i, d.matrix); d.position.y = 0.13; d.updateMatrix(); cen.setMatrixAt(i, d.matrix); }); g.add(daisy, cen);
    const pinks = new THREE.InstancedMesh(G.sph(0.04, 8, 6), toon(0xff7fb0), 14); for (let i = 0; i < 14; i++) { d.position.set(-3.5 + (i % 5) * 0.15, 0.5 + (i % 3) * 0.12, -2.0 + Math.floor(i / 5) * 0.25); d.updateMatrix(); pinks.setMatrixAt(i, d.matrix); } g.add(pinks); }
  // ivy hanging from the ceiling edges (instanced leaves along drooping vines)
  { const leaf = new THREE.SphereGeometry(0.07, 6, 4); leaf.scale(1, 0.25, 0.7); const n = 220; const iv = new THREE.InstancedMesh(leaf, toon(0x4fae3a), n); const d = new THREE.Object3D(); let a = 3; const rr = () => ((a = (a * 16807) % 2147483647) / 2147483647); let k = 0;
    const vines = [[-3.6, -3.2], [-2.6, -3.3], [1.3, -3.3], [2.7, -3.3], [3.7, -2.0], [3.7, -0.4], [3.7, 2.5], [-3.7, -2.4]];
    for (const [vx, vz] of vines) { const len = 0.8 + rr() * 1.4; for (let i = 0; i < 27 && k < n; i++, k++) { const t = i / 26; d.position.set(vx + Math.sin(t * 6 + vx) * 0.08 + (rr() - 0.5) * 0.12, H - 0.15 - t * len, vz + (rr() - 0.5) * 0.12); d.rotation.set(rr() * 2, rr() * 6, rr() * 2); d.scale.setScalar(0.7 + rr() * 0.6); d.updateMatrix(); iv.setMatrixAt(k, d.matrix); iv.setColorAt(k, new THREE.Color().setHSL(0.28 + rr() * 0.06, 0.55, 0.35 + rr() * 0.12)); } }
    iv.count = k; iv.userData.noCollide = true; g.add(iv); }
  // ----- exterior: cream siding, gable roof with tiles, trims, a porch with steps, posts, awning and a GREG HQ sign -----
  { const cream = 0xf1e4c6, trim = 0xffffff, roofC = 0x3b6fb6;
    const clad = (w, h, x, y, z, ry = 0) => { const m = M(G.box(w, h, 0.05), cream, { ot: 0.5 }); m.position.set(x, y, z); m.rotation.y = ry; g.add(m); };
    clad(W + 0.1, H, 0, H / 2, -D / 2 - 0.115); clad(D + 0.1, H, W / 2 + 0.115, H / 2, 0, Math.PI / 2);
    clad(2.4, H, -W / 2 + 1.2, H / 2, D / 2 + 0.115); clad(2.2, H, W / 2 - 1.1, H / 2, D / 2 + 0.115); clad(3.4, H - 2.9, 0.1, 2.9 + (H - 2.9) / 2, D / 2 + 0.115);
    for (const [x, z] of [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]]) { const c = M(G.box(0.22, H + 0.1, 0.22), trim, { ot: 0.5 }); c.position.set(x + Math.sign(x) * 0.02, H / 2, z + Math.sign(z) * 0.02); g.add(c); }
    // door frame
    for (const sx of [-1.6, 1.8]) { const j = M(G.box(0.14, 2.9, 0.3), trim, { ot: 0.5 }); j.position.set(sx, 1.45, D / 2 + 0.05); g.add(j); }
    const lin = M(G.box(3.6, 0.16, 0.3), trim, { ot: 0.5 }); lin.position.set(0.1, 2.95, D / 2 + 0.05); g.add(lin);
    // gable roof (ridge along x) with tile texture
    const tileTex2 = canvasTex(128, 128, (x) => { for (let r = 0; r < 8; r++) for (let q = 0; q < 8; q++) { x.fillStyle = (r + q) % 3 ? "#3b6fb6" : "#3566a8"; x.beginPath(); x.arc(q * 16 + (r % 2) * 8, r * 16 + 16, 9, Math.PI, 0); x.fill(); x.strokeStyle = "rgba(10,20,50,.45)"; x.lineWidth = 2; x.stroke(); } });
    tileTex2.wrapS = tileTex2.wrapT = THREE.RepeatWrapping;
    const rise = 1.6, run = D / 2 + 0.5, slope = Math.hypot(rise, run), ang = Math.atan2(rise, run);
    for (const sz of [-1, 1]) { const r = new THREE.Mesh(G.box(W + 0.9, 0.16, slope), toon(0xffffff, tileTex2, { rep: 4 })); outline(r, 0.6); r.position.set(0, H + 0.14 + rise / 2, sz * run / 2); r.rotation.x = sz * ang; g.add(r); }
    const ridge = M(G.cyl(0.11, 0.11, W + 1.0, 8), 0x2a4f8a, { ot: 0.5 }); ridge.rotation.z = Math.PI / 2; ridge.position.set(0, H + 0.2 + rise, 0); g.add(ridge);
    const gable = new THREE.Shape(); gable.moveTo(-D / 2 - 0.1, 0); gable.lineTo(D / 2 + 0.1, 0); gable.lineTo(0, rise); gable.lineTo(-D / 2 - 0.1, 0);
    for (const sx of [-1, 1]) { const gm = new THREE.Mesh(new THREE.ShapeGeometry(gable), toon(cream, null, { side: THREE.DoubleSide })); gm.rotation.y = Math.PI / 2; gm.position.set(sx * (W / 2 + 0.12), H + 0.1, 0); g.add(gm);
      const win = new THREE.Mesh(new THREE.CircleGeometry(0.32, 20), toon(0xffe6a6, null, { emissive: 0.8, side: THREE.DoubleSide })); win.rotation.y = Math.PI / 2; win.position.set(sx * (W / 2 + 0.14), H + 0.75, 0); g.add(win);
      const wr = M(new THREE.TorusGeometry(0.33, 0.04, 6, 20), trim, { ot: 0.4 }); wr.rotation.y = Math.PI / 2; wr.position.copy(win.position); g.add(wr); }
    const chim = M(G.box(0.6, 1.6, 0.6), 0xb06a4a); chim.position.set(W / 2 - 1.4, H + 1.3, -1.2); g.add(chim); const chimTop = M(G.box(0.72, 0.12, 0.72), 0x6b3a2a, { ot: 0.4 }); chimTop.position.set(W / 2 - 1.4, H + 2.15, -1.2); g.add(chimTop);
    // porch: deck, steps, posts, awning, planters, and the sign over the door
    const deckM = new THREE.Mesh(G.box(4.2, 0.16, 1.6), toon(0xffffff, tileTex("wood", renderer), { rep: 2 })); outline(deckM, 0.5); deckM.position.set(0.1, 0.08, D / 2 + 0.95); g.add(deckM);
    const step = M(G.box(2.2, 0.08, 0.4), 0xb57a45, { ot: 0.4 }); step.position.set(0.1, 0.04, D / 2 + 1.95); g.add(step);
    for (const px of [-1.85, 2.05]) { const post = M(G.cyl(0.07, 0.07, 2.7, 8), trim, { ot: 0.4 }); post.position.set(px, 1.35, D / 2 + 1.6); g.add(post); }
    const awnTex2 = canvasTex(128, 64, (x) => { for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? "#fff6e6" : "#2f5db0"; x.fillRect(i * 16, 0, 16, 64); } });
    const awn = new THREE.Mesh(G.box(4.4, 0.06, 1.8), toon(0xffffff, awnTex2)); outline(awn, 0.5); awn.position.set(0.1, 2.8, D / 2 + 0.95); awn.rotation.x = 0.12; g.add(awn);
    for (const px of [-1.5, 1.7]) { const pot = M(G.cyl(0.22, 0.17, 0.4, 10), 0xc8633a); pot.position.set(px, 0.36, D / 2 + 1.45); g.add(pot); const bush = M(new THREE.IcosahedronGeometry(0.28, 0), 0x4fae3a); bush.position.set(px, 0.72, D / 2 + 1.45); g.add(bush); }
    const sTex = canvasTex(512, 128, (x, w, h) => { x.fillStyle = "#13234a"; roundRect(x, 4, 4, w - 8, h - 8, 22); x.fill(); x.strokeStyle = "#e9c46a"; x.lineWidth = 6; x.stroke(); x.fillStyle = "#e9c46a"; x.font = "900 76px Georgia, serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("GREG HQ", w / 2, h / 2 + 4); });
    const sg = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.55), new THREE.MeshBasicMaterial({ map: sTex })); sg.position.set(0.1, 3.35, D / 2 + 0.15); g.add(sg);
    // outside lamp by the door
    const lamp = new THREE.Mesh(G.sph(0.1, 10, 8), toon(0xffe6a6, null, { emissive: 1 })); lamp.position.set(2.3, 2.3, D / 2 + 0.2); g.add(lamp); }
  g.userData.chair = chair; g.userData.mugSteam = mugSteam; g.userData.mug = mug;
  // Greg's diary on the desk (open book with a red ribbon)
  const diary = new THREE.Group(); diary.position.set(-1.15, 0.84, -2.4); diary.rotation.y = 0.25; g.add(diary);
  { const cover = M(G.box(0.36, 0.03, 0.26), 0x8a2b2b, { ot: 0.3 }); diary.add(cover); for (const sx of [-1, 1]) { const pg = M(G.box(0.165, 0.02, 0.24), 0xfff7e0, { ot: 0.2 }); pg.position.set(sx * 0.088, 0.025, 0); pg.rotation.z = -sx * 0.06; diary.add(pg); }
    const lines2 = canvasTex(128, 96, (x) => { x.fillStyle = "#fff7e0"; x.fillRect(0, 0, 128, 96); x.strokeStyle = "#7a8aa8"; x.lineWidth = 1; for (let i = 1; i < 8; i++) { x.beginPath(); x.moveTo(6, i * 11); x.lineTo(122, i * 11); x.stroke(); } x.fillStyle = "#2a2a55"; x.font = "italic 10px Georgia"; x.fillText("dear diary,", 8, 9); });
    const pgTex = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.22), new THREE.MeshBasicMaterial({ map: lines2 })); pgTex.rotation.x = -Math.PI / 2; pgTex.position.y = 0.037; diary.add(pgTex);
    const rib = M(G.box(0.012, 0.004, 0.16), 0xc0392b, { outline: false }); rib.position.set(0.02, 0.04, 0.15); diary.add(rib); }
  g.userData.interactables = [
    { id: "hq_diary", obj: diary, r: 0.6, prompt: "Read Greg's diary", kind: "diary" },
    ...Object.entries(g.userData.screens).map(([k, sc]) => ({ id: "hq_screen_" + k, obj: sc.mesh, r: 0.7, prompt: "Open the " + ({ charts: "charts", tweets: "tweets", pump: "pump.fun", nfts: "NFT" }[k]) + " screen", kind: "screen", screen: k })),
    { id: "hq_mug", obj: mug, r: 0.5, prompt: "Sip Greg's coffee", kind: "coffee" },
    { id: "hq_sign", obj: g, r: 0, prompt: "", kind: "none" },
  ].filter((i) => i.r > 0);
  return g;
}
