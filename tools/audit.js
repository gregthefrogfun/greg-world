window.__audit = () => {
  const W = window.__greg.world, T = W.THREE, P = W.phys, isl = W.isl;
  const props = []; const skip = (o) => o.userData.noCollide || o.isInstancedMesh || o.isSprite || o.isLineSegments;
  for (const o of isl.children) { if (skip(o)) continue; if (o.isMesh && (o.geometry.type === "PlaneGeometry" || o.geometry.type === "CircleGeometry" || o.geometry.type === "RingGeometry")) continue; const b = new T.Box3().setFromObject(o); if (b.isEmpty()) continue; const s = b.getSize(new T.Vector3()); if (s.x > 15 || s.z > 15) continue; const ry = o.rotation.y, rx = o.rotation.x, rz = o.rotation.z; o.rotation.set(0, 0, 0); o.updateMatrixWorld(true); const lb = new T.Box3().setFromObject(o); o.rotation.set(rx, ry, rz); o.updateMatrixWorld(true); const lc = lb.getCenter(new T.Vector3()).sub(o.position), he = lb.getSize(new T.Vector3()).multiplyScalar(0.5); const obb = { c: [o.position.x + lc.x * Math.cos(ry) + lc.z * Math.sin(ry), o.position.z - lc.x * Math.sin(ry) + lc.z * Math.cos(ry)], h: [he.x, he.z], a: ry };
    props.push({ obb, o, b, name: (typeof o.userData.pick === "string" ? o.userData.pick : o.userData.surface || o.geometry?.type || "group") + "@" + o.position.x.toFixed(1) + "," + o.position.z.toFixed(1) }); }
  const flags = { floating: [], sunk: [], overlap: [], outOfBounds: [] };
  const intended = (n) => /^(rock@|binder@|SphereGeometry@-1\.6,-12\.7|CylinderGeometry@0\.0,1\.1|group@-19\.1,-11\.6)/.test(n);
  for (const p of props) {
    const c = p.b.getCenter(new T.Vector3()), r = Math.hypot(c.x, c.z);
    if (r > W.R + 1.5 && p.b.min.y > -0.5) flags.outOfBounds.push(p.name);
    if (p.b.min.y > 0.03) { // something under it? cast from just under its bottom
      const h = P.raycast(new T.Vector3(c.x, p.b.min.y - 0.005, c.z), new T.Vector3(0, -1, 0), 3); const gap = h ? h.t + 0.005 : p.b.min.y; if (gap > 0.02 && !intended(p.name)) flags.floating.push(p.name + " gap " + gap.toFixed(2)); }
    if (p.b.min.y < -0.06 && r < W.R && !intended(p.name) && !p.name.startsWith("desk@")) flags.sunk.push(p.name + " " + p.b.min.y.toFixed(2));
  }
  const axes = (O) => [[Math.cos(O.a), -Math.sin(O.a)], [Math.sin(O.a), Math.cos(O.a)]];
  const sat = (A, B) => { let minPen = 1e9; for (const ax of [...axes(A), ...axes(B)]) { const proj = (O) => { const [u, v] = axes(O); const c = O.c[0] * ax[0] + O.c[1] * ax[1]; const r = O.h[0] * Math.abs(u[0] * ax[0] + u[1] * ax[1]) + O.h[1] * Math.abs(v[0] * ax[0] + v[1] * ax[1]); return [c - r, c + r]; }; const [a0, a1] = proj(A), [b0, b1] = proj(B); const pen = Math.min(a1, b1) - Math.max(a0, b0); if (pen <= 0) return 0; minPen = Math.min(minPen, pen); } return minPen; };
  for (let i = 0; i < props.length; i++) for (let j = i + 1; j < props.length; j++) { const a = props[i].b, b = props[j].b; const iy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y); if (iy < 0.15) continue; const pen = sat(props[i].obb, props[j].obb); if (pen > 0.15 && !(intended(props[i].name) || intended(props[j].name))) flags.overlap.push(props[i].name + " x " + props[j].name + ` (pen ${pen.toFixed(2)} m)`); }
  const intendedList = props.filter((p) => intended(p.name)).map((p) => p.name);
  return { intendedList, props: props.length, counts: Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, v.length])), flags };
};
