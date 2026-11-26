// Obsługa modeli wielokolorowych: 3MF (Bambu Studio / OrcaSlicer / PrusaSlicer / rdzeń 3MF),
// G-code z wieloma narzędziami (T0..Tn) oraz OBJ z wieloma materiałami.
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';

export const PALETTE = ['#f2a03d', '#4a86e8', '#e9e9e4', '#d9534f', '#3f9c4f', '#8e6cd8', '#2b2d31', '#3ec7c2', '#e6c84a', '#e07ab8', '#8b5a2b', '#9aa3ad'];

export function normHex(c) {
  if (!c) return null;
  let s = String(c).trim().replace(/^"|"$/g, '');
  if (!s.startsWith('#')) return null;
  s = s.slice(1);
  if (s.length === 3) s = s.split('').map((x) => x + x).join('');
  if (s.length === 8) s = s.slice(0, 6); // #RRGGBBAA
  return /^[0-9a-f]{6}$/i.test(s) ? '#' + s.toUpperCase() : null;
}
export function hexDist(a, b) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  const rm = (r1 + r2) / 2; // „redmean” – prosta odległość percepcyjna
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
}

const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
function attrs(s) { const o = {}; let m; attrRe.lastIndex = 0; while ((m = attrRe.exec(s))) o[m[1]] = m[2]; return o; }

/** Dekodowanie malowania (TriangleSelector z PrusaSlicer, używane też przez Bambu/Orca).
 *  Zwraca dominujący stan: 0 = filament części, N = filament N. */
export function decodePaint(str) {
  if (!str) return 0;
  const bits = [];
  for (let i = str.length - 1; i >= 0; i--) {
    const c = str.charCodeAt(i);
    const d = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (d < 0) continue;
    for (let b = 0; b < 4; b++) bits.push((d >> b) & 1);
  }
  let pos = 0;
  const nib = () => { let v = 0; for (let i = 0; i < 4; i++) v |= (bits[pos++] || 0) << i; return v; };
  const w = new Map();
  const rec = (depth, weight) => {
    if (pos >= bits.length || depth > 24) return;
    const code = nib();
    const split = code & 3;
    if (split === 0) {
      const st = (code & 12) === 12 ? nib() + 3 : code >> 2;
      w.set(st, (w.get(st) || 0) + weight);
    } else {
      const n = split + 1;
      for (let i = 0; i < n; i++) rec(depth + 1, weight / n);
    }
  };
  rec(0, 1);
  let best = 0, bw = -1;
  for (const [s, x] of w) if (x > bw) { bw = x; best = s; }
  return best;
}

// ---------- transformacje 3MF (3x4, wektory wierszowe) ----------
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
function parseT(s) { if (!s) return IDENT; const v = s.trim().split(/\s+/).map(Number); return v.length === 12 && v.every(Number.isFinite) ? v : IDENT; }
function mul(a, b) { // najpierw a, potem b
  const r = new Array(12);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
    if (i === 3) s += b[9 + j];
    r[i * 3 + j] = s;
  }
  return r;
}

/**
 * Parsuje 3MF z informacją o kolorach.
 * Zwraca { slots:[{key, ext, name, hex, tris, area, vol, paintArea, zMin, zMax, positions}], slice, hasSlicerInfo } lub null.
 */
export function parse3MFColors(buffer) {
  let files;
  try { files = unzipSync(new Uint8Array(buffer)); } catch { return null; }
  const names = Object.keys(files);
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const get = (p) => { const k = lower.get(String(p).replace(/^\//, '').toLowerCase()); return k ? strFromU8(files[k]) : null; };

  let rootPath = '3D/3dmodel.model';
  const rels = get('_rels/.rels');
  if (rels) { const m = rels.match(/Target="([^"]+?\.model)"/i); if (m) rootPath = m[1].replace(/^\//, ''); }

  // --- kolory filamentów i przypisania ze slicera ---
  let colors = [];
  const proj = get('Metadata/project_settings.config');
  if (proj) { try { const j = JSON.parse(proj); if (Array.isArray(j.filament_colour)) colors = j.filament_colour.map(normHex); } catch {} }
  const prusaCfg = get('Metadata/Slic3r_PE.config') || get('Metadata/PrusaSlicer.config');
  if (prusaCfg && !colors.length) {
    const line = (k) => { const m = prusaCfg.match(new RegExp(`;\\s*${k}\\s*=\\s*([^\\r\\n]*)`)); return m ? m[1].split(';').map((s) => normHex(s)) : []; };
    const ec = line('extruder_colour'), fc = line('filament_colour');
    const n = Math.max(ec.length, fc.length);
    for (let i = 0; i < n; i++) colors.push(ec[i] || fc[i] || null);
  }

  const bambuObj = new Map(), bambuPart = new Map();
  const ms = get('Metadata/model_settings.config');
  if (ms) {
    for (const m of ms.matchAll(/<object\s+id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
      const id = m[1], body = m[2];
      for (const p of body.matchAll(/<part\s+([^>]*)>([\s\S]*?)<\/part>/g)) {
        const pa = attrs(p[1]);
        const ex = p[2].match(/key="extruder"\s+value="(\d+)"/);
        bambuPart.set(`${id}:${pa.id}`, { ext: ex ? +ex[1] : null, subtype: pa.subtype || 'normal_part' });
      }
      const outer = body.replace(/<part[\s\S]*?<\/part>/g, '');
      const ex = outer.match(/key="extruder"\s+value="(\d+)"/);
      if (ex) bambuObj.set(id, +ex[1]);
    }
  }
  const prusaObj = new Map(), prusaVol = new Map();
  const pm = get('Metadata/Slic3r_PE_model.config') || get('Metadata/PrusaSlicer_model.config');
  if (pm) {
    for (const m of pm.matchAll(/<object\s+id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
      const id = m[1], body = m[2];
      const vols = [];
      for (const v of body.matchAll(/<volume\s+([^>]*)>([\s\S]*?)<\/volume>/g)) {
        const va = attrs(v[1]);
        const ex = v[2].match(/key="extruder"\s+value="(\d+)"/);
        const vt = v[2].match(/key="volume_type"\s+value="([^"]+)"/);
        const mod = v[2].match(/key="modifier"\s+value="1"/);
        vols.push({ first: +va.firstid, last: +va.lastid, ext: ex ? +ex[1] : null, part: (vt ? vt[1] === 'ModelPart' : !mod) });
      }
      prusaVol.set(id, vols);
      const outer = body.replace(/<volume[\s\S]*?<\/volume>/g, '');
      const ex = outer.match(/key="extruder"\s+value="(\d+)"/);
      if (ex) prusaObj.set(id, +ex[1]);
    }
  }
  const hasExtInfo = !!(ms || pm || proj || prusaCfg);

  // --- wyniki cięcia (Bambu/Orca) ---
  let slice = null;
  const si = get('Metadata/slice_info.config');
  if (si) {
    const perExt = new Map(); let sec = 0, g = 0, any = false;
    for (const m of si.matchAll(/key="prediction"\s+value="([\d.]+)"/g)) { sec += +m[1]; any = true; }
    for (const m of si.matchAll(/key="weight"\s+value="([\d.]+)"/g)) { g += +m[1]; any = true; }
    for (const m of si.matchAll(/<filament\s+([^>]*)\/?>/g)) {
      const a = attrs(m[1]);
      const id = +a.id, ug = parseFloat(a.used_g);
      if (!id) continue;
      const cur = perExt.get(id) || { grams: 0, hex: normHex(a.color), type: a.type };
      if (Number.isFinite(ug)) cur.grams += ug;
      perExt.set(id, cur);
      any = true;
    }
    if (any) slice = { minutes: sec ? sec / 60 : null, grams: g || null, perExt };
  }

  // --- geometria ---
  const objects = new Map();
  const mats = new Map();
  const done = new Set();
  let rootXml = null;
  const parseFile = (path) => {
    if (done.has(path)) return;
    done.add(path);
    const xml = get(path);
    if (!xml) return;
    if (path === rootPath) rootXml = xml;
    for (const m of xml.matchAll(/<(?:\w+:)?basematerials\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?basematerials>/g)) {
      const a = attrs(m[1]);
      mats.set(`${path}#${a.id}`, [...m[2].matchAll(/<(?:\w+:)?base\b([^>]*)\/?>/g)].map((b) => { const ba = attrs(b[1]); return { name: ba.name || '', hex: normHex(ba.displaycolor) }; }));
    }
    for (const m of xml.matchAll(/<(?:\w+:)?colorgroup\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?colorgroup>/g)) {
      const a = attrs(m[1]);
      mats.set(`${path}#${a.id}`, [...m[2].matchAll(/<(?:\w+:)?color\b([^>]*)\/?>/g)].map((b) => ({ name: '', hex: normHex(attrs(b[1]).color) })));
    }
    for (const m of xml.matchAll(/<(?:\w+:)?object\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?object>/g)) {
      const a = attrs(m[1]);
      const body = m[2];
      const obj = { id: a.id, path, pid: a.pid, pindex: a.pindex != null ? +a.pindex : null, type: a.type || 'model', mesh: null, components: [] };
      if (/<(?:\w+:)?mesh\b/.test(body)) {
        const v = [];
        for (const vm of body.matchAll(/<(?:\w+:)?vertex\s([^>]*?)\/?>/g)) {
          const s = vm[1];
          const x = s.match(/\bx="([^"]+)"/), y = s.match(/\by="([^"]+)"/), z = s.match(/\bz="([^"]+)"/);
          v.push(+(x && x[1]), +(y && y[1]), +(z && z[1]));
        }
        const t = [];
        for (const tm of body.matchAll(/<(?:\w+:)?triangle\s([^>]*?)\/?>/g)) {
          const ta = attrs(tm[1]);
          t.push({ v1: +ta.v1, v2: +ta.v2, v3: +ta.v3, pid: ta.pid, p1: ta.p1 != null ? +ta.p1 : null, paint: ta.paint_color || ta['slic3rpe:mmu_segmentation'] || null });
        }
        obj.mesh = { v, t };
      }
      for (const cm of body.matchAll(/<(?:\w+:)?component\b([^>]*?)\/?>/g)) {
        const ca = attrs(cm[1]);
        const cpath = (ca['p:path'] || ca.path || '').replace(/^\//, '') || path;
        obj.components.push({ objectid: ca.objectid, path: cpath, t: parseT(ca.transform) });
      }
      objects.set(`${path}#${a.id}`, obj);
    }
  };
  parseFile(rootPath);
  if (!rootXml) return null;
  // dociągnij pliki obiektów (production extension)
  for (let guard = 0; guard < 4; guard++) {
    let added = false;
    for (const o of [...objects.values()]) for (const c of o.components) if (!done.has(c.path)) { parseFile(c.path); added = true; }
    if (!added) break;
  }

  const slots = new Map();
  const slotFor = (key, init) => {
    let s = slots.get(key);
    if (!s) { s = { key, tris: 0, area: 0, vol: 0, paintArea: 0, zMin: Infinity, zMax: -Infinity, pos: [], ...init }; slots.set(key, s); }
    return s;
  };

  const buildM = rootXml.match(/<(?:\w+:)?build\b[^>]*>([\s\S]*?)<\/(?:\w+:)?build>/);
  const items = buildM ? [...buildM[1].matchAll(/<(?:\w+:)?item\b([^>]*?)\/?>/g)].map((m) => attrs(m[1])) : [];
  if (!items.length) for (const o of objects.values()) if (o.path === rootPath) items.push({ objectid: o.id });

  let totalTris = 0;
  const MAX_TRIS = 4_000_000;
  const emit = (obj, M, ctx) => {
    const { v, t } = obj.mesh;
    const pvols = ctx.prusaVols;
    for (let i = 0; i < t.length; i++) {
      if (totalTris > MAX_TRIS) return;
      const tri = t[i];
      // filament bazowy
      let base = null, isPart = true;
      if (pvols) {
        const pv = pvols.find((x) => i >= x.first && i <= x.last);
        if (pv) { base = pv.ext; isPart = pv.part; }
      }
      if (!isPart || ctx.skip) continue;
      if (base == null) base = ctx.ext;
      if (base == null) base = 1;
      let key, init, paintState = decodePaint(tri.paint);
      if (hasExtInfo || paintState) {
        const ext = paintState || base;
        key = 'e' + ext;
        init = { ext, name: `Filament ${ext}`, hex: (slice && slice.perExt.get(ext) && slice.perExt.get(ext).hex) || colors[ext - 1] || null };
      } else {
        const pid = tri.pid || obj.pid;
        const pidx = tri.p1 != null ? tri.p1 : obj.pindex;
        const mlist = pid != null ? mats.get(`${obj.path}#${pid}`) || mats.get(`${rootPath}#${pid}`) : null;
        if (mlist && pidx != null && mlist[pidx]) {
          key = `m${pid}:${pidx}`;
          init = { ext: null, name: mlist[pidx].name || `Materiał ${pidx + 1}`, hex: mlist[pidx].hex };
        } else { key = 'e1'; init = { ext: 1, name: 'Filament 1', hex: null }; }
      }
      const s = slotFor(key, init);
      const a = tri.v1 * 3, b = tri.v2 * 3, c = tri.v3 * 3;
      const P = [];
      for (const k of [a, b, c]) {
        const x = v[k], y = v[k + 1], z = v[k + 2];
        P.push(x * M[0] + y * M[3] + z * M[6] + M[9], x * M[1] + y * M[4] + z * M[7] + M[10], x * M[2] + y * M[5] + z * M[8] + M[11]);
      }
      for (let k = 0; k < 9; k++) s.pos.push(P[k]);
      const ux = P[3] - P[0], uy = P[4] - P[1], uz = P[5] - P[2], wx = P[6] - P[0], wy = P[7] - P[1], wz = P[8] - P[2];
      const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
      const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
      s.tris++; s.area += area;
      if (paintState) s.paintArea += area;
      else s.vol += (P[0] * (P[4] * P[8] - P[5] * P[7]) - P[1] * (P[3] * P[8] - P[5] * P[6]) + P[2] * (P[3] * P[7] - P[4] * P[6])) / 6;
      const zl = Math.min(P[2], P[5], P[8]), zh = Math.max(P[2], P[5], P[8]);
      if (zl < s.zMin) s.zMin = zl;
      if (zh > s.zMax) s.zMax = zh;
      totalTris++;
    }
  };
  const walk = (key, M, ctx, depth) => {
    const obj = objects.get(key);
    if (!obj || depth > 8) return;
    if (obj.mesh && obj.mesh.t.length) emit(obj, M, ctx);
    obj.components.forEach((c) => {
      const child = { ...ctx };
      if (depth === 0) {
        const bp = bambuPart.get(`${ctx.topId}:${c.objectid}`);
        if (bp) { if (bp.ext != null) child.ext = bp.ext; if (bp.subtype !== 'normal_part') child.skip = true; }
      }
      walk(`${c.path}#${c.objectid}`, mul(c.t, M), child, depth + 1);
    });
  };
  for (const it of items) {
    const top = objects.get(`${rootPath}#${it.objectid}`);
    if (!top || top.type === 'support' || top.type === 'other') continue;
    const ctx = { topId: it.objectid, ext: bambuObj.get(it.objectid) ?? prusaObj.get(it.objectid) ?? null, prusaVols: prusaVol.get(it.objectid) || null };
    walk(`${rootPath}#${it.objectid}`, parseT(it.transform), ctx, 0);
  }
  if (!totalTris) return null;

  // filamenty zużyte tylko w podporach / wieży (bez geometrii modelu)
  if (slice) for (const [ext, info] of slice.perExt) {
    if (info.grams > 0 && !slots.has('e' + ext)) slots.set('e' + ext, { key: 'e' + ext, ext, name: `Filament ${ext} (podpory/wieża)`, hex: info.hex || colors[ext - 1] || null, tris: 0, area: 0, vol: 0, paintArea: 0, zMin: Infinity, zMax: -Infinity, pos: [] });
  }
  const list = [...slots.values()].sort((a, b) => (a.ext ?? 999) - (b.ext ?? 999) || a.key.localeCompare(b.key));
  return {
    slots: list.map((s) => ({ key: s.key, ext: s.ext, name: s.name, hex: s.hex, tris: s.tris, area: s.area, vol: Math.abs(s.vol), paintArea: s.paintArea, zMin: s.zMin, zMax: s.zMax, positions: new Float32Array(s.pos) })),
    slice: slice ? { minutes: slice.minutes, grams: slice.grams, perSlotGrams: list.map((s) => (s.ext != null && slice.perExt.get(s.ext) ? slice.perExt.get(s.ext).grams : null)) } : null,
  };
}

// ---------- G-code ----------
function splitList(v) { return v == null ? [] : String(v).split(/[;,]/).map((s) => s.trim()); }

/** Szybkie informacje o kolorach z G-code (bez budowania geometrii). */
export function gcodeColorInfo(text) {
  const head = (re) => { const m = text.match(re); return m ? m[1] : null; };
  const ec = splitList(head(/;\s*extruder_colou?r\s*=\s*([^\r\n]*)/i)).map(normHex);
  const fc = splitList(head(/;\s*filament_colou?r\s*=\s*([^\r\n]*)/i)).map(normHex);
  const n = Math.max(ec.length, fc.length);
  const colors = [];
  for (let i = 0; i < n; i++) colors.push(ec[i] || fc[i] || null);
  const gl = head(/;\s*filament used \[g\]\s*=\s*([\d.,\s]+)/i);
  const perTool = gl ? splitList(gl).map(parseFloat).filter((x) => Number.isFinite(x)) : [];
  const toolRe = /^[ \t]*T(\d+)\b/gm;
  let m, cur = null, changes = 0;
  const used = new Set();
  while ((m = toolRe.exec(text))) {
    const t = +m[1];
    if (t > 15) continue;
    if (cur !== null && t !== cur) changes++;
    cur = t; used.add(t);
  }
  perTool.forEach((g, i) => { if (g > 0) used.add(i); });
  if (!used.size) used.add(0);
  const tools = [...used].sort((a, b) => a - b);
  return {
    tools,
    slots: tools.map((t) => ({ key: 't' + t, ext: t + 1, name: `Filament ${t + 1}`, hex: colors[t] || null })),
    perSlotGrams: perTool.length > 1 ? tools.map((t) => perTool[t] ?? 0) : null,
    toolChanges: changes,
  };
}

/** Buduje ścieżki druku per narzędzie. Obsługuje G0/G1/G2/G3, G90/G91, M82/M83, G92, T<n>. */
export function parseGcodePaths(text, maxSeg = 3_000_000) {
  const ext = new Map();
  const travel = [];
  let x = 0, y = 0, z = 0, e = 0, abs = true, absE = true, tool = 0, segs = 0;
  let i = 0;
  const L = text.length;
  const push = (arr, x1, y1, z1, x2, y2, z2) => { arr.push(x1, y1, z1, x2, y2, z2); };
  while (i < L) {
    let j = text.indexOf('\n', i);
    if (j < 0) j = L;
    let line = text.slice(i, j);
    i = j + 1;
    const sc = line.indexOf(';');
    if (sc >= 0) line = line.slice(0, sc);
    line = line.trim();
    if (!line) continue;
    const c0 = line.charCodeAt(0);
    if (c0 === 84) { const t = parseInt(line.slice(1), 10); if (t >= 0 && t < 16) tool = t; continue; }
    if (c0 !== 71 && c0 !== 77) continue;
    const parts = line.split(/\s+/);
    const cmd = parts[0].toUpperCase();
    if (cmd === 'G90') { abs = true; absE = true; continue; }
    if (cmd === 'G91') { abs = false; absE = false; continue; }
    if (cmd === 'M82') { absE = true; continue; }
    if (cmd === 'M83') { absE = false; continue; }
    const p = {};
    for (let k = 1; k < parts.length; k++) { const s = parts[k]; if (s.length > 1) p[s[0].toUpperCase()] = parseFloat(s.slice(1)); }
    if (cmd === 'G92') { if (p.X != null) x = p.X; if (p.Y != null) y = p.Y; if (p.Z != null) z = p.Z; if (p.E != null) e = p.E; continue; }
    const isMove = cmd === 'G0' || cmd === 'G1' || cmd === 'G00' || cmd === 'G01';
    const isArc = cmd === 'G2' || cmd === 'G3' || cmd === 'G02' || cmd === 'G03';
    if (!isMove && !isArc) continue;
    const nx = p.X != null ? (abs ? p.X : x + p.X) : x;
    const ny = p.Y != null ? (abs ? p.Y : y + p.Y) : y;
    const nz = p.Z != null ? (abs ? p.Z : z + p.Z) : z;
    let de = 0;
    if (p.E != null) { if (absE) { de = p.E - e; e = p.E; } else { de = p.E; e += p.E; } }
    const extruding = de > 0.00001;
    const target = extruding ? (ext.get(tool) || ext.set(tool, []).get(tool)) : travel;
    if (segs < maxSeg && (extruding || travel.length < 6_000_000)) {
      if (isArc && (p.I != null || p.J != null)) {
        const cx = x + (p.I || 0), cy = y + (p.J || 0);
        const r = Math.hypot(x - cx, y - cy);
        let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx);
        const cw = cmd === 'G2' || cmd === 'G02';
        let da = a1 - a0;
        if (cw && da >= 0) da -= Math.PI * 2;
        if (!cw && da <= 0) da += Math.PI * 2;
        if (Math.abs(nx - x) < 1e-9 && Math.abs(ny - y) < 1e-9) da = cw ? -Math.PI * 2 : Math.PI * 2;
        const n = Math.min(64, Math.max(2, Math.ceil(Math.abs(da) * r / 1.0)));
        let px = x, py = y, pz = z;
        for (let k = 1; k <= n; k++) {
          const a = a0 + da * (k / n);
          const qx = k === n ? nx : cx + r * Math.cos(a), qy = k === n ? ny : cy + r * Math.sin(a), qz = z + (nz - z) * (k / n);
          push(target, px, py, pz, qx, qy, qz);
          px = qx; py = qy; pz = qz;
        }
      } else if (nx !== x || ny !== y || nz !== z) {
        push(target, x, y, z, nx, ny, nz);
      }
      if (extruding) segs++;
    }
    x = nx; y = ny; z = nz;
  }
  return { tools: new Map([...ext.entries()].sort((a, b) => a[0] - b[0]).map(([t, arr]) => [t, new Float32Array(arr)])), travel: new Float32Array(travel) };
}
