// Freg Island physics: static triangle-mesh colliders built from the real rendered geometry (so doors, windows and
// gaps are open exactly where the model is open), a uniform 3D grid for fast queries, swept sphere movement with
// depenetration and soft bounces, ray casts, sphere casts (sphere tracing), a few dynamic sphere props, and capsules
// for moving characters. Plain JS, no wasm, so it runs the same in the browser and in the headless QA.
export function createPhysics(THREE, { cell = 1.0 } = {}) {
  let T = new Float32Array(0), N = new Float32Array(0), owner = [], nTri = 0;
  let grid = new Map(), stamp = new Uint32Array(0), stampId = 1;
  const capsules = new Map(); // id -> { a: Vector3, b: Vector3, r, obj }
  const bodies = [];
  const key = (i, j, k) => ((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512);
  const ci = (v) => Math.floor(v / cell);

  function build(roots, { skip } = {}) {
    const tris = [], own = [];
    const m = new THREE.Matrix4(), im = new THREE.Matrix4(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const visible = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
    const take = (o) => {
      if (!(o.isMesh) || o.isSprite || o.name === "outline" || o.userData.noCollide || o.userData.dynamic) return false;
      for (let p = o; p; p = p.parent) if (p.userData.noCollide || p.userData.dynamic) return false;
      if (skip && skip(o)) return false;
      const mt = Array.isArray(o.material) ? o.material[0] : o.material;
      if (mt && mt.depthWrite === false && !o.userData.collide) return false; // decals, glow cones, wing planes
      return visible(o);
    };
    for (const r of roots) r.updateMatrixWorld(true);
    for (const r of roots) r.traverse((o) => {
      if (!take(o)) return;
      const g = o.geometry, pos = g.attributes.position; if (!pos) return;
      const idx = g.index ? g.index.array : null, n = idx ? idx.length : pos.count;
      const inst = o.isInstancedMesh ? o.count : 1;
      for (let s = 0; s < inst; s++) {
        m.copy(o.matrixWorld); if (o.isInstancedMesh) { o.getMatrixAt(s, im); m.multiply(im); }
        for (let i = 0; i + 2 < n; i += 3) {
          const i0 = idx ? idx[i] : i, i1 = idx ? idx[i + 1] : i + 1, i2 = idx ? idx[i + 2] : i + 2;
          a.fromBufferAttribute(pos, i0).applyMatrix4(m); b.fromBufferAttribute(pos, i1).applyMatrix4(m); c.fromBufferAttribute(pos, i2).applyMatrix4(m);
          const ab = b.clone().sub(a), ac = c.clone().sub(a); if (ab.cross(ac).lengthSq() < 1e-10) continue;
          tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); own.push(o.userData.ownerKey || ownerOf(o));
        }
      }
    });
    nTri = tris.length / 9; T = new Float32Array(tris); owner = own; N = new Float32Array(nTri * 3);
    grid = new Map(); stamp = new Uint32Array(nTri);
    for (let t = 0; t < nTri; t++) {
      const o = t * 9;
      const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay), ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const l = Math.hypot(nx, ny, nz) || 1; N[t * 3] = nx / l; N[t * 3 + 1] = ny / l; N[t * 3 + 2] = nz / l;
      const x0 = ci(Math.min(ax, bx, cx)), x1 = ci(Math.max(ax, bx, cx)), y0 = ci(Math.min(ay, by, cy)), y1 = ci(Math.max(ay, by, cy)), z0 = ci(Math.min(az, bz, cz)), z1 = ci(Math.max(az, bz, cz));
      for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) for (let k = z0; k <= z1; k++) {
        const kk = key(i, j, k); let arr = grid.get(kk); if (!arr) grid.set(kk, (arr = [])); arr.push(t);
      }
    }
    return nTri;
  }
  function ownerOf(o) { for (let p = o; p; p = p.parent) if (p.userData.pick || p.userData.surface) return p.userData.surface || (typeof p.userData.pick === "string" ? p.userData.pick : "prop"); return "world"; }

  // closest point on triangle t to p (Ericson); writes into out, returns squared distance
  function closestOnTri(t, px, py, pz, out) {
    const o = t * 9;
    const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    let x, y, z;
    if (d1 <= 0 && d2 <= 0) { x = ax; y = ay; z = az; }
    else {
      const bpx = px - bx, bpy = py - by, bpz = pz - bz;
      const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) { x = bx; y = by; z = bz; }
      else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); x = ax + abx * v; y = ay + aby * v; z = az + abz * v; }
        else {
          const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
          const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
          if (d6 >= 0 && d5 <= d6) { x = cx; y = cy; z = cz; }
          else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); x = ax + acx * w; y = ay + acy * w; z = az + acz * w; }
            else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); x = bx + (cx - bx) * w; y = by + (cy - by) * w; z = bz + (cz - bz) * w; }
              else { const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; x = ax + abx * v + acx * w; y = ay + aby * v + acy * w; z = az + abz * v + acz * w; }
            }
          }
        }
      }
    }
    out[0] = x; out[1] = y; out[2] = z;
    return (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
  }
  function forCells(px, py, pz, r, fn) {
    stampId++; if (stampId > 4e9) { stamp.fill(0); stampId = 1; }
    const x0 = ci(px - r), x1 = ci(px + r), y0 = ci(py - r), y1 = ci(py + r), z0 = ci(pz - r), z1 = ci(pz + r);
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) for (let k = z0; k <= z1; k++) {
      const arr = grid.get(key(i, j, k)); if (!arr) continue;
      for (const t of arr) { if (stamp[t] === stampId) continue; stamp[t] = stampId; fn(t); }
    }
  }
  const cp = [0, 0, 0];
  // nearest static surface within r: { d, point, normal, tri, owner } or null
  function nearest(p, r, noCaps) {
    let best = r * r, bt = -1, bx = 0, by = 0, bz = 0;
    forCells(p.x, p.y, p.z, r, (t) => { const d = closestOnTri(t, p.x, p.y, p.z, cp); if (d < best) { best = d; bt = t; bx = cp[0]; by = cp[1]; bz = cp[2]; } });
    if (!noCaps) for (const c of capsules.values()) { const q = capClosest(c, p); const d = q.distanceToSquared(p) - 0; const dd = Math.max(0, Math.sqrt(d) - c.r); if (dd * dd < best) { best = dd * dd; bt = -2; const n = p.clone().sub(q).normalize(); bx = q.x + n.x * c.r; by = q.y + n.y * c.r; bz = q.z + n.z * c.r; nearest.cap = c; } }
    if (bt === -1) return null;
    const d = Math.sqrt(best); const point = new THREE.Vector3(bx, by, bz);
    let normal = p.clone().sub(point); if (d > 1e-5) normal.divideScalar(d); else if (bt >= 0) normal.set(N[bt * 3], N[bt * 3 + 1], N[bt * 3 + 2]); else normal.set(0, 1, 0);
    return { d, point, normal, tri: bt, owner: bt >= 0 ? owner[bt] : "cap:" + nearest.cap.id, cap: bt === -2 ? nearest.cap : null };
  }
  const _ca = new THREE.Vector3();
  function capClosest(c, p) { const ab = _ca.copy(c.b).sub(c.a); const t = Math.max(0, Math.min(1, p.clone().sub(c.a).dot(ab) / (ab.lengthSq() || 1))); return c.a.clone().addScaledVector(ab, t); }

  // push a sphere out of everything it overlaps; returns the summed contact normal (zero if free)
  function depenetrate(p, r, iters = 4) {
    const acc = new THREE.Vector3(); let hit = null;
    for (let it = 0; it < iters; it++) {
      let deepest = 0, nx = 0, ny = 0, nz = 0, any = false, tri = -1;
      forCells(p.x, p.y, p.z, r, (t) => {
        const d2 = closestOnTri(t, p.x, p.y, p.z, cp); if (d2 >= r * r) return;
        const d = Math.sqrt(d2), pen = r - d; if (pen <= deepest) return;
        deepest = pen; any = true; tri = t;
        if (d > 1e-6) { nx = (p.x - cp[0]) / d; ny = (p.y - cp[1]) / d; nz = (p.z - cp[2]) / d; } else { nx = N[t * 3]; ny = N[t * 3 + 1]; nz = N[t * 3 + 2]; }
      });
      for (const c of capsules.values()) { const q = capClosest(c, p); const d = q.distanceTo(p), pen = r + c.r - d; if (pen > deepest) { deepest = pen; any = true; tri = -2; const n = p.clone().sub(q).divideScalar(d || 1); nx = n.x; ny = n.y; nz = n.z; hit = { cap: c }; } }
      if (!any) break;
      p.x += nx * (deepest + 1e-4); p.y += ny * (deepest + 1e-4); p.z += nz * (deepest + 1e-4); acc.x += nx; acc.y += ny; acc.z += nz;
      if (tri >= 0) hit = { tri, owner: owner[tri] };
    }
    if (acc.lengthSq() > 0) acc.normalize();
    depenetrate.hit = hit; return acc;
  }
  // swept sphere move: substeps of at most 0.4 r so thin walls can't be tunnelled; soft bounce + friction on contact
  function moveSphere(p, v, r, dt, { bounce = 0.25, friction = 0.1 } = {}) {
    const dist = v.length() * dt, steps = Math.min(40, Math.max(1, Math.ceil(dist / (r * 0.4))));
    const h = dt / steps; let contact = null;
    for (let s = 0; s < steps; s++) {
      p.addScaledVector(v, h);
      const n = depenetrate(p, r);
      if (n.lengthSq() > 0) {
        const vn = v.dot(n);
        if (vn < 0) { v.addScaledVector(n, -(1 + bounce) * vn); const tang = v.clone().addScaledVector(n, -v.dot(n)); v.addScaledVector(tang, -friction); }
        contact = { normal: n.clone(), hit: depenetrate.hit, impact: -vn };
      }
    }
    return contact;
  }
  // ray cast against static triangles (and capsules); returns { t, point, normal, owner } or null
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), pv = new THREE.Vector3(), tv = new THREE.Vector3(), qv = new THREE.Vector3();
  function raycast(o, d, maxT) {
    let best = maxT, bt = -1; const step = cell * 0.5;
    stampId++;
    for (let s = 0; s <= maxT + step; s += step) {
      const x = o.x + d.x * s, y = o.y + d.y * s, z = o.z + d.z * s;
      const i0 = ci(x), j0 = ci(y), k0 = ci(z);
      for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (let k = k0 - 1; k <= k0 + 1; k++) {
        const arr = grid.get(key(i, j, k)); if (!arr) continue;
        for (const t of arr) {
          if (stamp[t] === stampId) continue; stamp[t] = stampId;
          const q = t * 9; e1.set(T[q + 3] - T[q], T[q + 4] - T[q + 1], T[q + 5] - T[q + 2]); e2.set(T[q + 6] - T[q], T[q + 7] - T[q + 1], T[q + 8] - T[q + 2]);
          pv.crossVectors(d, e2); const det = e1.dot(pv); if (Math.abs(det) < 1e-9) continue;
          const inv = 1 / det; tv.set(o.x - T[q], o.y - T[q + 1], o.z - T[q + 2]); const u = tv.dot(pv) * inv; if (u < 0 || u > 1) continue;
          qv.crossVectors(tv, e1); const v = d.dot(qv) * inv; if (v < 0 || u + v > 1) continue;
          const tt = e2.dot(qv) * inv; if (tt > 1e-5 && tt < best) { best = tt; bt = t; }
        }
      }
      if (bt >= 0 && best < s - step) break;
    }
    let capHit = null;
    for (const c of capsules.values()) { for (let s = 0; s < Math.min(best, maxT); s += 0.05) { const p = o.clone().addScaledVector(d, s); if (capClosest(c, p).distanceTo(p) < c.r) { if (s < best) { best = s; capHit = c; } break; } } }
    if (bt < 0 && !capHit) return null;
    const point = o.clone().addScaledVector(d, best);
    let normal; if (capHit) normal = point.clone().sub(capClosest(capHit, point)).normalize(); else { normal = new THREE.Vector3(N[bt * 3], N[bt * 3 + 1], N[bt * 3 + 2]); if (normal.dot(d) > 0) normal.negate(); }
    return { t: best, point, normal, owner: capHit ? "cap:" + capHit.id : owner[bt], cap: capHit };
  }
  // sphere cast by sphere tracing: first distance along d where a sphere of radius r touches geometry
  function sphereCast(o, d, r, maxT, noCaps) {
    let t = 0; const p = new THREE.Vector3();
    for (let i = 0; i < 64 && t < maxT; i++) {
      p.copy(o).addScaledVector(d, t);
      const n = nearest(p, r + 0.6, noCaps); const dist = n ? n.d : r + 0.6;
      if (dist <= r) return { t: Math.max(0, t), normal: n.normal };
      t += Math.max(0.01, dist - r);
    }
    return null;
  }
  function setCapsule(id, a, b, r, obj) { capsules.set(id, { id, a: a.clone(), b: b.clone(), r, obj }); }
  function moveCapsule(id, a, b) { const c = capsules.get(id); if (c) { c.a.copy(a); c.b.copy(b); } }

  // light dynamic props: spheres that roll, bounce and get pushed by flies
  function addBody(mesh, r, opts = {}) { const b = { mesh, r, vel: new THREE.Vector3(), sleep: 0, mass: opts.mass || 1, onSettle: opts.onSettle, rollTo: opts.rollTo, home: mesh.position.clone() }; mesh.userData.dynamic = true; bodies.push(b); return b; }
  function stepBodies(dt, g = 9.8) {
    for (const b of bodies) {
      if (b.sleep > 1.5 && b.vel.lengthSq() < 1e-4) continue;
      b.vel.y -= g * dt;
      const c = moveSphere(b.mesh.position, b.vel, b.r, dt, { bounce: 0.35, friction: 0.02 });
      if (c && c.normal.y > 0.6) { const k = Math.exp(-1.6 * dt); b.vel.x *= k; b.vel.z *= k; if (b.vel.y < 0.05 && b.vel.y > -0.05) b.vel.y = 0; b.mesh.rotation.x += b.vel.z * dt / b.r; b.mesh.rotation.z -= b.vel.x * dt / b.r; }
      if (b.vel.lengthSq() < 0.0004) b.sleep += dt; else b.sleep = 0;
      if (b.mesh.position.y < -2) { b.mesh.position.copy(b.home); b.vel.set(0, 0, 0); }
      b.onStep && b.onStep(b, dt);
    }
  }
  function pushBodies(p, r, v) { for (const b of bodies) { const d = b.mesh.position.distanceTo(p), m = r + b.r; if (d < m && d > 1e-6) { const n = b.mesh.position.clone().sub(p).divideScalar(d); b.mesh.position.addScaledVector(n, m - d); const rel = v.dot(n); if (rel > 0) b.vel.addScaledVector(n, rel * 1.2 / b.mass); b.vel.y += 0.3; b.sleep = 0; } } }
  function debugLines() {
    const pos = new Float32Array(nTri * 18);
    for (let t = 0; t < nTri; t++) { const o = t * 9, q = t * 18; pos.set([T[o], T[o + 1], T[o + 2], T[o + 3], T[o + 4], T[o + 5], T[o + 3], T[o + 4], T[o + 5], T[o + 6], T[o + 7], T[o + 8], T[o + 6], T[o + 7], T[o + 8], T[o], T[o + 1], T[o + 2]], q); }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xff00aa, transparent: true, opacity: 0.35, depthTest: false }));
  }
  return { build, nearest, depenetrate, moveSphere, raycast, sphereCast, setCapsule, moveCapsule, capsules, addBody, stepBodies, pushBodies, bodies, debugLines, stats: () => ({ tris: nTri, cells: grid.size }) };
}
