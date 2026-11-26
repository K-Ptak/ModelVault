// Wykrywanie wielu płyt w jednym pliku (np. eksport z Bambu Studio / MakerWorld,
// gdzie płyty leżą obok siebie w siatce co 1,2 × szerokość płyty).
// Czysty JS – bez three.js, żeby dało się testować w Node.

/** Rozstawy płyt: Bambu X1/P1/A1 (256 mm), A1 mini (180), H2D (350), 220, 235, 250, 300 mm. */
export const PLATE_PITCHES = [307.2, 216, 420, 264, 282, 300, 360];
const MIN_FOOTPRINT = 270; // mm – poniżej tego zawsze 1 płyta
const CELL = 5;            // mm – rozmiar komórki siatki
const GAP_CELLS = 3;       // dylatacja ±15 mm → obiekty bliżej niż ~30 mm łączą się w grupę
const MAX_PLATE = 262;     // mm – maksymalny rozmiar zawartości jednej płyty przy łączeniu

/**
 * meshes: [{ positions: Float32Array (xyz × 3 na trójkąt), up: 'z' | 'y' }]
 * Zwraca { count, plates:[{min:[a,b], max:[a,b], tris, area}], triPlate: Uint16Array[] }
 * (a,b) to współrzędne poziome: x oraz y (dla Z-up) albo z (dla Y-up).
 */
export function detectPlates(meshes) {
  let minA = Infinity, minB = Infinity, maxA = -Infinity, maxB = -Infinity, total = 0;
  const hb = (m) => (m.up === 'y' ? 2 : 1);
  for (const m of meshes) {
    const p = m.positions, b = hb(m);
    for (let i = 0; i < p.length; i += 3) {
      const a = p[i], c = p[i + b];
      if (a < minA) minA = a; if (a > maxA) maxA = a;
      if (c < minB) minB = c; if (c > maxB) maxB = c;
    }
    total += p.length / 9;
  }
  const single = () => ({ count: 1, plates: [{ min: [minA, minB], max: [maxA, maxB], tris: total }], triPlate: meshes.map((m) => new Uint16Array(m.positions.length / 9)) });
  if (!total || !Number.isFinite(minA)) return { count: 0, plates: [], triPlate: meshes.map(() => new Uint16Array(0)) };
  if (maxA - minA < MIN_FOOTPRINT && maxB - minB < MIN_FOOTPRINT) return single();

  const nx = Math.ceil((maxA - minA) / CELL) + 1, ny = Math.ceil((maxB - minB) / CELL) + 1;
  if (nx * ny > 4e6) return single();
  const occ = new Uint8Array(nx * ny);
  const cx = (a) => Math.min(nx - 1, Math.max(0, Math.floor((a - minA) / CELL)));
  const cy = (b) => Math.min(ny - 1, Math.max(0, Math.floor((b - minB) / CELL)));
  for (const m of meshes) {
    const p = m.positions, b = hb(m);
    for (let i = 0; i < p.length; i += 9) {
      const a0 = Math.min(p[i], p[i + 3], p[i + 6]), a1 = Math.max(p[i], p[i + 3], p[i + 6]);
      const b0 = Math.min(p[i + b], p[i + 3 + b], p[i + 6 + b]), b1 = Math.max(p[i + b], p[i + 3 + b], p[i + 6 + b]);
      const x0 = cx(a0), x1 = cx(a1), y0 = cy(b0), y1 = cy(b1);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) occ[y * nx + x] = 1;
    }
  }
  // dylatacja (separowalna) – łączy obiekty leżące blisko siebie
  const tmp = new Uint8Array(nx * ny), dil = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    let last = -1e9;
    for (let x = 0; x < nx; x++) { if (occ[y * nx + x]) last = x; if (x - last <= GAP_CELLS) tmp[y * nx + x] = 1; }
    last = 1e9;
    for (let x = nx - 1; x >= 0; x--) { if (occ[y * nx + x]) last = x; if (last - x <= GAP_CELLS) tmp[y * nx + x] = 1; }
  }
  for (let x = 0; x < nx; x++) {
    let last = -1e9;
    for (let y = 0; y < ny; y++) { if (tmp[y * nx + x]) last = y; if (y - last <= GAP_CELLS) dil[y * nx + x] = 1; }
    last = 1e9;
    for (let y = ny - 1; y >= 0; y--) { if (tmp[y * nx + x]) last = y; if (last - y <= GAP_CELLS) dil[y * nx + x] = 1; }
  }
  // spójne składowe
  const lab = new Int32Array(nx * ny).fill(-1);
  const clusters = [];
  const stack = [];
  for (let s = 0; s < nx * ny; s++) {
    if (!dil[s] || lab[s] >= 0) continue;
    const id = clusters.length;
    const cl = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, any: false };
    lab[s] = id; stack.push(s);
    while (stack.length) {
      const k = stack.pop();
      const x = k % nx, y = (k - x) / nx;
      if (occ[k]) { cl.any = true; if (x < cl.minX) cl.minX = x; if (x > cl.maxX) cl.maxX = x; if (y < cl.minY) cl.minY = y; if (y > cl.maxY) cl.maxY = y; }
      if (x > 0 && dil[k - 1] && lab[k - 1] < 0) { lab[k - 1] = id; stack.push(k - 1); }
      if (x < nx - 1 && dil[k + 1] && lab[k + 1] < 0) { lab[k + 1] = id; stack.push(k + 1); }
      if (y > 0 && dil[k - nx] && lab[k - nx] < 0) { lab[k - nx] = id; stack.push(k - nx); }
      if (y < ny - 1 && dil[k + nx] && lab[k + nx] < 0) { lab[k + nx] = id; stack.push(k + nx); }
    }
    clusters.push(cl);
  }
  const boxes = clusters.map((c) => ({ a0: minA + c.minX * CELL, a1: minA + (c.maxX + 1) * CELL, b0: minB + c.minY * CELL, b1: minB + (c.maxY + 1) * CELL }));
  if (boxes.length <= 1) return single();

  // 1) dopasowanie do siatki płyt (origin 0,0 – tak eksportuje Bambu Studio)
  let groupOf = null;
  for (const P of PLATE_PITCHES) {
    const keys = [];
    let ok = true;
    for (const bx of boxes) {
      const i0 = Math.floor((bx.a0 + 1) / P), i1 = Math.floor((bx.a1 - 1) / P);
      const j0 = Math.floor((bx.b0 + 1) / P), j1 = Math.floor((bx.b1 - 1) / P);
      if (i0 !== i1 || j0 !== j1) { ok = false; break; }
      keys.push(`${i0}:${j0}`);
    }
    if (ok && new Set(keys).size > 1) { groupOf = keys; break; }
  }
  // 2) awaryjnie: łącz grupy, których wspólny obrys mieści się na jednej płycie
  if (!groupOf) {
    const g = boxes.map((b, i) => ({ ...b, ids: [i] }));
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
        const u = { a0: Math.min(g[i].a0, g[j].a0), a1: Math.max(g[i].a1, g[j].a1), b0: Math.min(g[i].b0, g[j].b0), b1: Math.max(g[i].b1, g[j].b1) };
        if (u.a1 - u.a0 <= MAX_PLATE && u.b1 - u.b0 <= MAX_PLATE) { g[i] = { ...u, ids: [...g[i].ids, ...g[j].ids] }; g.splice(j, 1); merged = true; break outer; }
      }
    }
    groupOf = new Array(boxes.length);
    g.forEach((gr, k) => gr.ids.forEach((i) => { groupOf[i] = 'm' + k; }));
  }
  const uniq = [...new Set(groupOf)];
  if (uniq.length <= 1) return single();
  // kolejność: rzędy od góry (największe b), potem od lewej
  const gbox = uniq.map((k) => {
    const ids = groupOf.map((x, i) => (x === k ? i : -1)).filter((i) => i >= 0);
    return { k, a0: Math.min(...ids.map((i) => boxes[i].a0)), a1: Math.max(...ids.map((i) => boxes[i].a1)), b0: Math.min(...ids.map((i) => boxes[i].b0)), b1: Math.max(...ids.map((i) => boxes[i].b1)) };
  });
  const rowH = Math.max(...gbox.map((b) => b.b1 - b.b0)) * 0.5;
  gbox.sort((p, q) => (Math.abs(q.b1 - p.b1) > rowH ? q.b1 - p.b1 : p.a0 - q.a0));
  const plateIdx = new Map(gbox.map((b, i) => [b.k, i]));
  const clusterPlate = groupOf.map((k) => plateIdx.get(k));

  const plates = gbox.map((b) => ({ min: [Infinity, Infinity], max: [-Infinity, -Infinity], tris: 0 }));
  const triPlate = meshes.map((m) => {
    const p = m.positions, b = hb(m), out = new Uint16Array(p.length / 9);
    for (let i = 0, t = 0; i < p.length; i += 9, t++) {
      const a = (p[i] + p[i + 3] + p[i + 6]) / 3, c = (p[i + b] + p[i + 3 + b] + p[i + 6 + b]) / 3;
      const l = lab[cy(c) * nx + cx(a)];
      const pl = l >= 0 ? clusterPlate[l] : 0;
      out[t] = pl;
      const P = plates[pl];
      P.tris++;
      for (let k = 0; k < 9; k += 3) {
        const va = p[i + k], vb = p[i + k + b];
        if (va < P.min[0]) P.min[0] = va; if (va > P.max[0]) P.max[0] = va;
        if (vb < P.min[1]) P.min[1] = vb; if (vb > P.max[1]) P.max[1] = vb;
      }
    }
    return out;
  });
  return { count: plates.length, plates, triPlate };
}
