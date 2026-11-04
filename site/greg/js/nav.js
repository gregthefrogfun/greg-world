// Greg's navigation grid: built from the real collision geometry (a cell is walkable when Greg's capsule fits
// there), A* with octile moves, string-pulled with line-of-sight and corner-rounded. Every client builds the same
// grid from the same island, so everyone sees Greg walk the same path. Built in small slices so it never hitches.
export function createNav(THREE, phys, { radius = 24, cell = 0.33, clear = 0.6 } = {}) {
  const N = Math.ceil((radius * 2) / cell), off = radius;
  const free = new Uint8Array(N * N); let ready = false, built = 0;
  const idx = (i, j) => j * N + i, toW = (i) => i * cell - off + cell / 2, toC = (x) => Math.floor((x + off) / cell);
  const p = new THREE.Vector3();
  function cellFree(i, j) {
    const x = toW(i), z = toW(j); if (Math.hypot(x, z) > radius - 0.6) return 0;
    for (const y of [0.65, 1.2, 1.75]) { p.set(x, y, z); const n = phys.nearest(p, clear, true); if (n && (n.normal.y < 0.7 || n.point.y > 0.4)) return 0; }
    return 1;
  }
  function buildSlice(budgetMs = 6) { const t0 = performance.now(); while (built < N * N && performance.now() - t0 < budgetMs) { const i = built % N, j = Math.floor(built / N); free[built] = cellFree(i, j); built++; } if (built >= N * N && !ready) { label(); ready = true; } return ready; }
  function buildAll() { while (!buildSlice(1e9)); }
  // connected components: route ends snap to the big walkable area, never to an isolated pocket
  const comp = new Int32Array(N * N); let main = 0;
  function label() { comp.fill(0); let id = 0, best = 0; for (let k = 0; k < N * N; k++) { if (!free[k] || comp[k]) continue; id++; let c = 0; const q = [k]; comp[k] = id; while (q.length) { const v = q.pop(); c++; const i = v % N, j = (v - i) / N; for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const x = i + a, y = j + b; if (x < 0 || y < 0 || x >= N || y >= N) continue; const w = y * N + x; if (free[w] && !comp[w]) { comp[w] = id; q.push(w); } } } if (c > best) { best = c; main = id; } } }
  const isFree = (i, j) => i >= 0 && j >= 0 && i < N && j < N && free[idx(i, j)] === 1;
  function nearestFree(i, j) { const ok = (a, b) => isFree(a, b) && comp[b * N + a] === main; if (ok(i, j)) return [i, j]; for (let r = 1; r < 24; r++) for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) { if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue; if (ok(i + di, j + dj)) return [i + di, j + dj]; } return null; }
  function los(a, b) { const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz), n = Math.ceil(L / (cell * 0.35)); for (let k = 0; k <= n; k++) { const x = a[0] + (dx * k) / n, z = a[1] + (dz * k) / n; if (!isFree(toC(x), toC(z))) return false; } return true; }
  function astar(s, g) {
    const open = [[0, s[0], s[1]]], gs = new Map(), from = new Map(), key = (i, j) => j * N + i; gs.set(key(s[0], s[1]), 0);
    const h = (i, j) => { const dx = Math.abs(i - g[0]), dz = Math.abs(j - g[1]); return Math.max(dx, dz) + 0.414 * Math.min(dx, dz); };
    let guard = 0;
    while (open.length && guard++ < 60000) {
      let bi = 0; for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k; const [, i, j] = open.splice(bi, 1)[0];
      if (i === g[0] && j === g[1]) { const out = [[i, j]]; let k = key(i, j); while (from.has(k)) { k = from.get(k); out.push([k % N, Math.floor(k / N)]); } return out.reverse(); }
      const gc = gs.get(key(i, j));
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue; const ni = i + di, nj = j + dj; if (!isFree(ni, nj)) continue; if (di && dj && (!isFree(i + di, j) || !isFree(i, j + dj))) continue;
        const c = gc + (di && dj ? 1.414 : 1), k = key(ni, nj); if (c < (gs.get(k) ?? 1e9)) { gs.set(k, c); from.set(k, key(i, j)); open.push([c + h(ni, nj), ni, nj]); }
      }
    }
    return null;
  }
  const cache = new Map();
  function route(A, B) {
    if (!ready) return null; const k = A.join(",") + ">" + B.join(","); if (cache.has(k)) return cache.get(k);
    const s = nearestFree(toC(A[0]), toC(A[1])), g = nearestFree(toC(B[0]), toC(B[1])); if (!s || !g) return null;
    const cells = astar(s, g); if (!cells) { cache.set(k, null); return null; }
    const pts = cells.map(([i, j]) => [toW(i), toW(j)]);
    const pull = [pts[0]]; let a = 0; while (a < pts.length - 1) { let b = pts.length - 1; while (b > a + 1 && !los(pts[a], pts[b])) b--; pull.push(pts[b]); a = b; }
    const inMain = (P) => { const i = toC(P[0]), j = toC(P[1]); return isFree(i, j) && comp[j * N + i] === main; }; const sA = inMain(A) ? A : pts[0], sB = inMain(B) ? B : pts[pts.length - 1];
    const out = [sA, ...pull, sB].filter((p, i, arr) => i === 0 || Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1]) > 0.05);
    cache.set(k, out); return out;
  }
  return { buildSlice, buildAll, route, isReady: () => ready, isFree, toC, toW, N, cell, free, reset: () => { built = 0; ready = false; cache.clear(); } };
}
