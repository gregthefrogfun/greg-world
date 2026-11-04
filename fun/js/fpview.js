// First-person fly body: two front legs (coxa, femur, tibia, segmented tarsus, claws + pulvilli, bristles)
// driven by analytic two-bone IK, and translucent veined wings at the screen edges. Pure code, no assets.
export function createFPView(THREE, camera) {
  const view = new THREE.Group(); camera.add(view);
  const chitin = new THREE.ShaderMaterial({
    uniforms: { uBase: { value: new THREE.Color(0x2a1c12) }, uRim: { value: new THREE.Color(0xffc98a) } },
    vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uBase; uniform vec3 uRim; varying vec3 vN; varying vec3 vV; void main(){ vec3 n = normalize(vN); float l = 0.45 + 0.55*max(0., dot(n, normalize(vec3(.4,.8,.5)))); float spec = pow(max(0., dot(reflect(-normalize(vec3(.4,.8,.5)), n), vV)), 24.); float rim = pow(1. - max(0., dot(n, vV)), 2.5); gl_FragColor = vec4(uBase*l + vec3(.55,.45,.35)*spec*.6 + uRim*rim*.55, 1.); }`,
  });
  const hairMat = new THREE.MeshBasicMaterial({ color: 0x1a120c });
  const padMat = new THREE.MeshBasicMaterial({ color: 0xd9c49a });
  const seg = (r0, r1, len) => { const g = new THREE.CylinderGeometry(r1, r0, len, 7, 1); g.rotateX(-Math.PI / 2); g.translate(0, 0, -len / 2); return g; };
  const hairGeo = new THREE.ConeGeometry(0.00045, 0.009, 3); hairGeo.translate(0, 0.0045, 0);
  function bristles(len, r, n, parent, seed) {
    const m = new THREE.InstancedMesh(hairGeo, hairMat, n), d = new THREE.Object3D(); let a = seed;
    const rnd = () => ((a = (a * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const f = rnd(), th = rnd() * Math.PI * 2, out = new THREE.Vector3(Math.cos(th), Math.sin(th), 0);
      d.position.set(out.x * r, out.y * r, -f * len);
      const dir = out.clone().multiplyScalar(0.8).add(new THREE.Vector3(0, 0, 0.55 + rnd() * 0.3)).normalize();
      d.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir); d.scale.setScalar(0.7 + rnd() * 0.8); d.updateMatrix(); m.setMatrixAt(i, d.matrix);
    }
    parent.add(m); return m;
  }
  const L1 = 0.085, L2 = 0.08, L3 = 0.042;
  function makeLeg(s) {
    const root = new THREE.Group(); root.position.set(s * 0.03, -0.072, -0.045); view.add(root);
    const coxa = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 6), chitin); coxa.scale.set(1, 1, 1.6); root.add(coxa);
    const femur = new THREE.Group(); root.add(femur); femur.add(new THREE.Mesh(seg(0.0062, 0.0046, L1), chitin)); bristles(L1, 0.005, 46, femur, 11 + s);
    const tibia = new THREE.Group(); tibia.position.z = -L1; femur.add(tibia); tibia.add(new THREE.Mesh(seg(0.0046, 0.0034, L2), chitin)); bristles(L2, 0.0038, 38, tibia, 29 + s);
    const knee = new THREE.Mesh(new THREE.SphereGeometry(0.0048, 8, 6), chitin); tibia.add(knee);
    const tars = []; let parent = tibia, z = -L2;
    for (let i = 0; i < 4; i++) { const t = new THREE.Group(); t.position.z = z; parent.add(t); const l = L3 / 4; t.add(new THREE.Mesh(seg(0.0029 - i * 0.0003, 0.0026 - i * 0.0003, l), chitin)); bristles(l, 0.0026, 6, t, 50 + i * 7 + s); tars.push(t); parent = t; z = -l; }
    const tip = new THREE.Group(); tip.position.z = z; parent.add(tip);
    for (const c of [-1, 1]) {
      const claw = new THREE.Mesh(new THREE.ConeGeometry(0.0011, 0.007, 4), chitin); claw.position.set(c * 0.0022, -0.001, -0.002); claw.rotation.x = -2.2; claw.rotation.z = c * 0.3; tip.add(claw);
      const pad = new THREE.Mesh(new THREE.SphereGeometry(0.0024, 6, 5), padMat); pad.scale.set(1, 0.45, 1.4); pad.position.set(c * 0.0018, -0.0022, -0.001); tip.add(pad);
    }
    return { s, root, femur, tibia, tars, tip, cur: new THREE.Vector3(s * 0.055, -0.1, -0.2), flex: 0 };
  }
  const legs = [makeLeg(-1), makeLeg(1)];
  const m4 = new THREE.Matrix4(), up = new THREE.Vector3();
  function solve(leg, target, flex) {
    const r = leg.root.position, d0 = target.clone().sub(r); let d = d0.length();
    d = Math.max((L1 + L2) * 0.25, Math.min((L1 + L2) * 0.97, d));
    up.set(leg.s * 0.55, 1, 0.2).normalize();
    m4.lookAt(r, r.clone().add(d0), up); leg.root.quaternion.setFromRotationMatrix(m4);
    const a1 = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))));
    const a2 = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2))));
    leg.femur.rotation.x = a1; leg.tibia.rotation.x = -(Math.PI - a2);
    leg.tars.forEach((t, i) => (t.rotation.x = -flex * (0.35 + i * 0.12)));
  }
  // wings at the edges: veined, iridescent, three blur layers each
  const wingTex = (() => { const c = document.createElement("canvas"); c.width = 256; c.height = 96; const x = c.getContext("2d");
    const gr = x.createLinearGradient(0, 0, 256, 96); gr.addColorStop(0, "rgba(210,235,255,.5)"); gr.addColorStop(0.5, "rgba(235,205,255,.38)"); gr.addColorStop(1, "rgba(205,255,225,.42)");
    x.fillStyle = gr; x.beginPath(); x.ellipse(128, 48, 124, 42, 0, 0, 7); x.fill(); x.strokeStyle = "rgba(35,30,40,.55)"; x.lineWidth = 1.6;
    for (let i = 0; i < 6; i++) { x.beginPath(); x.moveTo(6, 48); x.bezierCurveTo(70, 18 + i * 10, 160, 10 + i * 13, 250, 14 + i * 13); x.stroke(); }
    for (let i = 0; i < 9; i++) { x.beginPath(); x.moveTo(40 + i * 24, 20 + (i % 3) * 8); x.lineTo(46 + i * 24, 76 - (i % 2) * 10); x.stroke(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const wings = [-1, 1].map((s) => {
    const g = new THREE.Group(); g.position.set(s * 0.085, 0.012, -0.075); view.add(g);
    const layers = [0, 1, 2].map((k) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.055), new THREE.MeshBasicMaterial({ map: wingTex, transparent: true, opacity: k ? 0.12 : 0.3, side: THREE.DoubleSide, depthTest: false, depthWrite: false })); m.geometry.translate(s * 0.07, 0, 0); m.renderOrder = 50; g.add(m); return m; });
    return { s, g, layers, pulse: 0 };
  });
  const tmp = new THREE.Vector3(), tgt = new THREE.Vector3();
  let rubW = 0, rubT = 0, wipe = -1, wipeLeg = 0, nextWipe = 3, smudge = 0, bob = 0, tw = [0, 0], twT = [0.7, 1.3];
  const smudgeEl = document.createElement("div"); smudgeEl.className = "smudge"; document.body.appendChild(smudgeEl);
  function update(dt, t, S) {
    view.visible = S.visible;
    if (!S.visible) { smudgeEl.style.opacity = 0; return; }
    rubW += ((S.rubbing ? 1 : 0) - rubW) * Math.min(1, dt / 0.2 * 2.2);
    if (S.rubbing) { rubT += dt; if (rubT > nextWipe && wipe < 0) { wipe = 0; wipeLeg = Math.floor(t * 3) % 2; nextWipe = rubT + 2.5 + (t % 1.5); } } else rubT = 0;
    if (wipe >= 0) { wipe += dt / 0.55; if (wipe > 0.45 && wipe < 0.6) smudge = 1; if (wipe >= 1) wipe = -1; }
    smudge = Math.max(0, smudge - dt * 1.4); smudgeEl.style.opacity = (smudge * 0.8).toFixed(3);
    const sp = Math.min(1, S.speed / 6), mo = S.reduceMotion ? 0.3 : 1;
    legs.forEach((leg, i) => {
      const s = leg.s;
      // idle: breathing sway + random twitches, out of phase
      twT[i] -= dt; if (twT[i] < 0) { tw[i] = 1; twT[i] = 0.6 + ((t * 7.3 + i * 3.1) % 1) * 2.2; } tw[i] = Math.max(0, tw[i] - dt * 6);
      tgt.set(s * 0.056 + Math.sin(t * 1.3 + i * 2) * 0.003, -0.098 + Math.sin(t * 1.9 + i) * 0.003 + tw[i] * 0.008, -0.19 + Math.sin(t * 1.1 + i * 1.7) * 0.004);
      let flex = 0.35 + Math.sin(t * 2.3 + i * 1.4) * 0.15 + tw[i] * 0.4;
      // flight: tuck back and up, trail with turns, stretch forward when braking
      if (!S.perched) { tmp.set(s * 0.07 - S.yawRate * 0.012, -0.112 + sp * 0.02, -0.11 - S.brake * 0.09); tgt.lerp(tmp, Math.min(1, sp * 1.4 + S.brake)); flex += sp * 0.5; }
      // walking on a surface: alternate steps into view
      if (S.perched && S.walking) { const ph = S.walkPhase + i * Math.PI; tgt.z += Math.cos(ph) * 0.035; tgt.y += Math.max(0, Math.sin(ph)) * 0.025 - 0.01; flex += Math.max(0, -Math.sin(ph)) * 0.4; }
      // landing: reach forward and down to touch the surface first
      if (S.landing > 0) { tmp.set(s * 0.06, -0.12, -0.215); tgt.lerp(tmp, S.landing); flex = flex * (1 - S.landing) + 0.15 * S.landing; }
      // manual leg control (Z / X + mouse)
      const man = i === 0 ? S.legL : S.legR;
      if (man && man.active) { tmp.set(s * 0.04 + man.x, -0.075 + man.y, -0.205); tgt.lerp(tmp, 0.9); flex = 0.1; }
      // E rub: tarsi meet in front, slide back and forth at ~7 Hz and twist round each other; now and then wipe the eye
      if (rubW > 0.001) {
        const ph = t * Math.PI * 2 * 7 + i * Math.PI;
        tmp.set(s * 0.0045 + Math.sin(ph) * 0.009 * s, -0.064 + Math.cos(ph * 0.5) * 0.004 + (i ? 0.003 : -0.003), -0.15 + Math.sin(ph) * 0.006);
        if (wipe >= 0 && i === wipeLeg) { const w = Math.sin(Math.min(1, wipe) * Math.PI); tmp.set(s * 0.012 - s * 0.03 * wipe, -0.064 + w * 0.09, -0.15 + w * 0.09); }
        tgt.lerp(tmp, rubW); flex = flex * (1 - rubW) + (0.55 + Math.sin(ph) * 0.4) * rubW;
      }
      leg.cur.lerp(tgt, Math.min(1, dt * (rubW > 0.5 ? 30 : 14)));
      leg.flex += (flex - leg.flex) * Math.min(1, dt * 16);
      solve(leg, leg.cur, leg.flex);
    });
    // wings: flutter + blur fan; flap pulses from Q/R or mouse buttons push them wide
    wings.forEach((w, i) => {
      const p = i === 0 ? S.wingL : S.wingR; w.pulse = Math.max(p ? 1 : 0, w.pulse - dt * 4);
      const amp = (S.perched ? 0.05 : 0.22 + sp * 0.12) + w.pulse * 0.35;
      w.layers.forEach((m, k) => { m.rotation.x = Math.sin(t * 64 + k * 2.1) * amp * 0.25; m.rotation.z = w.s * (0.15 + Math.sin(t * 71 + k * 1.7) * amp - (S.perched ? 0.2 : 0)); m.material.opacity = (k ? 0.08 : 0.24) + (S.perched ? 0.08 : 0) + w.pulse * 0.08; m.material.color.setHSL((t * 0.07 + k * 0.08 + i * 0.3) % 1, 0.35, 0.9); });
      w.g.visible = !S.perched || S.wingShow;
    });
    bob = S.reduceMotion ? 0 : Math.sin(t * 10.5) * 0.0018 * (S.perched ? 0.2 : 1) * mo;
    view.position.set(0, bob, 0);
  }
  return { view, update, legs };
}
