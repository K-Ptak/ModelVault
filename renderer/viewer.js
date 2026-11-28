import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import { parse3MFColors, parseGcodePaths, gcodeColorInfo, PALETTE } from './mc.js';
import { detectPlates } from './plates.js';
import { T } from './i18n.js';

let MODEL_COLOR = 0xf2a03d;
export function setModelColor(hex) { MODEL_COLOR = new THREE.Color(hex).getHex(); }

// ---------- parsing ----------
function meshFromGeometry(geo) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: MODEL_COLOR, roughness: 0.55, metalness: 0.05, flatShading: false });
  return new THREE.Mesh(geo, mat);
}

function restyle(obj) {
  obj.traverse((c) => {
    if (c.isMesh) {
      const hasVC = !!c.geometry.attributes.color;
      c.material = new THREE.MeshStandardMaterial({ color: hasVC ? 0xffffff : MODEL_COLOR, vertexColors: hasVC, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    }
  });
}

function meshPerSlot(slot, positions) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const m = meshFromGeometry(geo);
  m.material.side = THREE.DoubleSide;
  m.userData.slot = slot;
  return m;
}

/** Rozbija meshe OBJ z wieloma materiałami na osobne sloty kolorów. */
function splitObjMaterials(obj) {
  const names = [];
  const out = new THREE.Group();
  obj.traverse((c) => {
    if (!c.isMesh) return;
    const mats = Array.isArray(c.material) ? c.material : [c.material];
    const groups = Array.isArray(c.material) && c.geometry.groups.length ? c.geometry.groups : [{ start: 0, count: c.geometry.attributes.position.count, materialIndex: 0 }];
    const pos = c.geometry.attributes.position;
    for (const g of groups) {
      const name = (mats[g.materialIndex] && mats[g.materialIndex].name) || '';
      let slot = names.indexOf(name);
      if (slot < 0) { slot = names.length; names.push(name); }
      const arr = new Float32Array(g.count * 3);
      for (let k = 0; k < g.count; k++) { arr[k * 3] = pos.getX(g.start + k); arr[k * 3 + 1] = pos.getY(g.start + k); arr[k * 3 + 2] = pos.getZ(g.start + k); }
      out.add(meshPerSlot(slot, arr));
    }
  });
  return { object: out, slots: names.map((n, i) => ({ key: 'o' + i, ext: null, name: n || T('Materiał {0}', { 0: i + 1 }), hex: null })) };
}

// ---------- walidacja plików ----------
const head = (buffer, n = 512) => new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(n, buffer.byteLength)));
const fail = (key, vars) => { const e = new Error(T(key, vars)); e.userFacing = true; return e; };

/** Sprawdza STL i zwraca bufor do sparsowania (binarny bez nadmiarowych bajtów) albo rzuca czytelny błąd. */
export function checkStl(buffer) {
  const len = buffer.byteLength;
  if (len === 0) throw fail('Plik jest pusty (0 bajtów).');
  const txt = head(buffer, 1024);
  const ascii = /^\s*solid\b/i.test(txt) && /\bfacet\b|\bendsolid\b/i.test(txt + head(buffer.slice(Math.max(0, len - 1024)), 1024));
  if (len >= 84) {
    const n = new DataView(buffer).getUint32(80, true);
    const need = 84 + n * 50;
    if (n > 0 && need === len) return buffer;
    if (n > 0 && need < len && !ascii) return buffer.slice(0, need); // nadmiarowe bajty na końcu
    if (!ascii) {
      if (n === 0) throw fail('Plik nie zawiera żadnej geometrii.');
      const have = Math.floor((len - 84) / 50);
      // wygląda na STL ucięty w trakcie pobierania? (pierwsze trójkąty mają sensowne współrzędne)
      const dv = new DataView(buffer);
      let plausible = n <= 50_000_000 && have > 0;
      for (let t = 0; plausible && t < Math.min(have, 16); t++) for (let k = 3; k < 12; k++) { const v = dv.getFloat32(84 + t * 50 + k * 4, true); if (!Number.isFinite(v) || Math.abs(v) > 1e5) { plausible = false; break; } }
      if (!plausible) throw fail('To nie jest prawidłowy plik STL albo plik jest uszkodzony.');
      throw fail('Plik STL jest niekompletny: zawiera {0} z {1} trójkątów (przerwane pobieranie?).', { 0: have.toLocaleString(), 1: n.toLocaleString() });
    }
  }
  if (!ascii) throw fail('To nie jest prawidłowy plik STL albo plik jest uszkodzony.');
  if (len < 84 || !/\bfacet\b/i.test(txt + head(buffer.slice(Math.max(0, len - 1024)), 1024))) throw fail('Plik nie zawiera żadnej geometrii.');
  return buffer;
}

/** Usuwa trójkąty z nieprawidłowymi współrzędnymi (NaN, ∞, zły indeks); zwraca liczbę pozostałych trójkątów. */
export function sanitizeObject(object) {
  let total = 0, dropped = 0;
  const kill = [];
  object.traverse((m) => {
    if (!m.isMesh) return;
    let g = m.geometry;
    const pos = g.attributes.position;
    if (!pos) { kill.push(m); return; }
    if (g.index) {
      const idx = g.index.array, ok = [];
      for (let i = 0; i + 2 < idx.length; i += 3) if (idx[i] < pos.count && idx[i + 1] < pos.count && idx[i + 2] < pos.count) ok.push(idx[i], idx[i + 1], idx[i + 2]);
      if (ok.length !== idx.length - (idx.length % 3)) { dropped += (idx.length - ok.length) / 3; g.setIndex(ok); }
      const ng = g.toNonIndexed(); g.dispose(); m.geometry = g = ng;
    }
    const a = g.attributes.position.array, n = Math.floor(a.length / 9);
    let bad = 0;
    for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) if (!Number.isFinite(a[t * 9 + k])) { bad++; break; }
    if (bad) {
      const out = new Float32Array((n - bad) * 9);
      let j = 0;
      for (let t = 0; t < n; t++) { let ok = true; for (let k = 0; k < 9; k++) if (!Number.isFinite(a[t * 9 + k])) { ok = false; break; } if (ok) { out.set(a.subarray(t * 9, t * 9 + 9), j); j += 9; } }
      const ng = new THREE.BufferGeometry(); ng.setAttribute('position', new THREE.BufferAttribute(out, 3)); ng.computeVertexNormals();
      g.dispose(); m.geometry = ng;
      dropped += bad;
    }
    const cnt = Math.floor(m.geometry.attributes.position.count / 3);
    if (!cnt) kill.push(m);
    total += cnt;
  });
  kill.forEach((m) => m.parent && m.parent.remove(m));
  return { tris: total, dropped };
}

/** Zwraca { object, zUp, isGcode, slots:[{name, hex, ...}], info, warnings } */
export function parseModel(ext, buffer) {
  if (!buffer || buffer.byteLength === 0) throw fail('Plik jest pusty (0 bajtów).');
  let parsed;
  try { parsed = parseRaw(ext, buffer); } catch (e) {
    if (e.userFacing) throw e;
    if (e instanceof RangeError && /allocation/i.test(e.message)) throw fail('Plik jest uszkodzony: deklaruje nierealnie dużo danych.');
    throw fail('Plik jest uszkodzony lub ma nieobsługiwaną strukturę ({0}).', { 0: e.message.replace(/^THREE\.\w+:\s*/, '').slice(0, 120) });
  }
  parsed.warnings = parsed.warnings || [];
  if (!parsed.isGcode) {
    const r = sanitizeObject(parsed.object);
    if (!r.tris) throw fail('Plik nie zawiera żadnej geometrii.');
    if (r.dropped) parsed.warnings.push(T('Pominięto {0} uszkodzonych trójkątów.', { 0: r.dropped.toLocaleString() }));
    if (parsed.needPlates) return withPlates(parsed);
  }
  return parsed;
}

function parseRaw(ext, buffer) {
  switch (ext) {
    case 'stl': {
      const geo = new STLLoader().parse(checkStl(buffer));
      geo.computeVertexNormals(); // wiele plików STL ma zerowe/błędne normalne
      return { needPlates: true, object: meshFromGeometry(geo), zUp: true, slots: [{ key: 's0', name: '', hex: null }] };
    }
    case 'ply': {
      if (!/^ply\s/.test(head(buffer, 8))) throw fail('To nie jest prawidłowy plik PLY albo plik jest uszkodzony.');
      const geo = new PLYLoader().parse(buffer);
      const m = meshFromGeometry(geo);
      if (geo.attributes.color) m.material.vertexColors = true, m.material.color.set(0xffffff);
      return { object: m, zUp: true, slots: [{ key: 's0', name: '', hex: null }] };
    }
    case 'obj': {
      const text = new TextDecoder().decode(buffer);
      const obj = new OBJLoader().parse(text);
      const r = splitObjMaterials(obj);
      return { needPlates: true, object: r.object, zUp: false, slots: r.slots.length ? r.slots : [{ key: 's0', name: '', hex: null }] };
    }
    case '3mf': {
      const sig = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
      if (sig[0] !== 0x50 || sig[1] !== 0x4b) throw fail('To nie jest prawidłowy plik 3MF (archiwum ZIP) albo plik jest uszkodzony.');
      const mc = parse3MFColors(buffer);
      if (mc) {
        const g = new THREE.Group();
        for (const ch of mc.chunks) { if (!ch.positions.length) continue; const m = meshPerSlot(ch.slot, ch.positions); m.userData.plate = ch.plate; g.add(m); }
        if (!g.children.length) throw fail('Plik nie zawiera żadnej geometrii.');
        return { needPlates: true, object: g, zUp: true, slots: mc.slots, info: { slice: mc.slice }, platesFromFile: mc.plateCount > 1 ? mc.plateIds : null };
      }
      let obj;
      try { obj = new ThreeMFLoader().parse(buffer); } catch { throw fail('Plik 3MF nie zawiera modelu 3D, który da się odczytać (uszkodzone lub niepełne archiwum).'); }
      let meshes = 0;
      obj.traverse((c) => { if (c.isMesh) meshes++; });
      if (!meshes) throw fail('Plik 3MF nie zawiera siatki, którą da się odczytać');
      restyle(obj);
      return { object: obj, zUp: true, slots: [{ key: 's0', name: '', hex: null }] };
    }
    case 'gcode': {
      const text = new TextDecoder().decode(buffer);
      const ci = gcodeColorInfo(text);
      const paths = parseGcodePaths(text);
      const g = new THREE.Group();
      const slotOf = new Map(ci.tools.map((t, i) => [t, i]));
      for (const [t, arr] of paths.tools) {
        if (!slotOf.has(t)) { slotOf.set(t, ci.slots.length); ci.slots.push({ key: 't' + t, ext: t + 1, name: `Filament ${t + 1}`, hex: null }); }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const ls = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: MODEL_COLOR }));
        ls.userData.slot = slotOf.get(t);
        g.add(ls);
      }
      if (paths.travel.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(paths.travel, 3));
        const ls = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x5a6578, transparent: true, opacity: 0.35 }));
        ls.userData.travel = true; ls.visible = false;
        g.add(ls);
      }
      if (![...paths.tools.values()].some((a) => a.length)) throw fail('Nie znaleziono ścieżek druku w G-code');
      return { object: g, zUp: true, isGcode: true, slots: ci.slots, info: { toolChanges: ci.toolChanges, perSlotGrams: ci.perSlotGrams } };
    }
    default:
      throw fail('Brak podglądu dla tego formatu');
  }
}

/** Wykrywa płyty (lub bierze je z pliku), dzieli meshe per płyta i liczy wymiary każdej płyty. */
function withPlates(parsed) {
  const meshes = [];
  parsed.object.traverse((o) => { if (o.isMesh) meshes.push(o); });
  if (!parsed.platesFromFile) {
    meshes.forEach((m) => { if (m.geometry.index) { const g = m.geometry.toNonIndexed(); m.geometry.dispose(); m.geometry = g; } });
    const det = detectPlates(meshes.map((m) => ({ positions: m.geometry.attributes.position.array, up: parsed.zUp ? 'z' : 'y' })));
    if (det.count > 1) {
      const group = new THREE.Group();
      meshes.forEach((m, mi) => {
        const pos = m.geometry.attributes.position.array, tp = det.triPlate[mi];
        const buckets = new Map();
        for (let t = 0; t < tp.length; t++) { const k = tp[t]; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(t); }
        for (const [pl, tris] of buckets) {
          const arr = new Float32Array(tris.length * 9);
          tris.forEach((t, j) => arr.set(pos.subarray(t * 9, t * 9 + 9), j * 9));
          const nm = meshPerSlot(m.userData.slot ?? 0, arr);
          nm.material.dispose(); nm.material = m.material.clone(); nm.material.side = THREE.DoubleSide;
          nm.userData.plate = pl;
          group.add(nm);
        }
        m.geometry.dispose();
      });
      parsed.object = group;
    } else meshes.forEach((m) => { m.userData.plate = 0; });
  }
  // wymiary i objętość per płyta
  const info = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  parsed.object.updateMatrixWorld(true);
  parsed.object.traverse((m) => {
    if (!m.isMesh) return;
    const pl = m.userData.plate || 0;
    const it = info.get(pl) || { min: new THREE.Vector3(Infinity, Infinity, Infinity), max: new THREE.Vector3(-Infinity, -Infinity, -Infinity), vol: 0, tris: 0 };
    const pos = m.geometry.attributes.position, idx = m.geometry.index;
    const n = idx ? idx.count / 3 : pos.count / 3;
    for (let i = 0; i < n; i++) {
      a.fromBufferAttribute(pos, idx ? idx.getX(i * 3) : i * 3); b.fromBufferAttribute(pos, idx ? idx.getX(i * 3 + 1) : i * 3 + 1); c.fromBufferAttribute(pos, idx ? idx.getX(i * 3 + 2) : i * 3 + 2);
      it.min.min(a).min(b).min(c); it.max.max(a).max(b).max(c);
      it.vol += a.dot(b.clone().cross(c)) / 6;
    }
    it.tris += n;
    info.set(pl, it);
  });
  const keys = [...info.keys()].sort((x, y) => x - y);
  const sliceP = parsed.info && parsed.info.slice && parsed.info.slice.plates ? parsed.info.slice.plates : [];
  parsed.plates = keys.map((k, i) => {
    const it = info.get(k), sz = it.max.clone().sub(it.min);
    const id = parsed.platesFromFile ? parsed.platesFromFile[k] : k + 1;
    const sp = sliceP.find((x) => x.index === id);
    return { index: k, id, x: sz.x, y: parsed.zUp ? sz.y : sz.z, z: parsed.zUp ? sz.z : sz.y, volume: Math.abs(it.vol) / 1000, tris: it.tris, minutes: sp ? sp.minutes : null, grams: sp ? sp.grams : null };
  });
  return parsed;
}

/** Kolory slotów: tablica hex wg indeksu slotu */
export function applySlotColors(object, colors) {
  const cs = colors.map((h) => new THREE.Color(h || '#888888'));
  object.traverse((o) => {
    if (o.userData.travel) return;
    if ((o.isMesh && !o.material.vertexColors) || o.isLine || o.isLineSegments) {
      const c = cs[o.userData.slot ?? 0] || cs[0];
      if (c) o.material.color.copy(c);
    }
  });
}
export { PALETTE };

/** Statystyki per slot (powierzchnia, objętość, zakres wysokości) w układzie modelu. */
export function slotGeomStats(parsed) {
  const out = parsed.slots.map((s) => ({ ...s }));
  if (parsed.isGcode) return out;
  const need = out.some((s) => s.area == null);
  if (!need) return out;
  out.forEach((s) => { s.area = 0; s.vol = 0; s.paintArea = 0; s.zMin = Infinity; s.zMax = -Infinity; });
  parsed.object.updateMatrixWorld(true);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  parsed.object.traverse((m) => {
    if (!m.isMesh) return;
    const st = out[m.userData.slot ?? 0] || out[0];
    const pos = m.geometry.attributes.position, idx = m.geometry.index;
    const n = idx ? idx.count / 3 : pos.count / 3;
    for (let i = 0; i < n; i++) {
      a.fromBufferAttribute(pos, idx ? idx.getX(i * 3) : i * 3);
      b.fromBufferAttribute(pos, idx ? idx.getX(i * 3 + 1) : i * 3 + 1);
      c.fromBufferAttribute(pos, idx ? idx.getX(i * 3 + 2) : i * 3 + 2);
      st.area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
      st.vol += a.dot(b.clone().cross(c)) / 6;
      const h = parsed.zUp ? [a.z, b.z, c.z] : [a.y, b.y, c.y];
      st.zMin = Math.min(st.zMin, ...h); st.zMax = Math.max(st.zMax, ...h);
    }
  });
  out.forEach((s) => { s.vol = Math.abs(s.vol); });
  return out;
}

/** Miniatura osadzona w 3MF (PrusaSlicer, Bambu Studio, Orca) */
export function extract3mfThumbnail(buffer) {
  try {
    const files = unzipSync(new Uint8Array(buffer), {
      filter: (f) => /^metadata\/(thumbnail|plate_\d+|top_\d+)\.png$/i.test(f.name) || /thumbnail\.png$/i.test(f.name),
    });
    const names = Object.keys(files).sort((a, b) => {
      const s = (n) => (/plate_1\.png$/i.test(n) ? 0 : /thumbnail\.png$/i.test(n) ? 1 : 2);
      return s(a) - s(b);
    });
    if (!names.length) return null;
    const bytes = files[names[0]];
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return 'data:image/png;base64,' + btoa(bin);
  } catch { return null; }
}

/** Wymiary (mm), liczba trójkątów, objętość (cm³) */
function boxOf(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3();
  let any = false;
  object.traverse((c) => { if ((c.isMesh || c.isLine || c.isLineSegments) && !c.userData.travel && c.visible && !c.userData.hiddenPlate) { box.expandByObject(c); any = true; } });
  return any ? box : new THREE.Box3().setFromObject(object);
}

export function computeStats(object, isGcode, rawZUp = false) {
  const box = boxOf(object);
  const size = box.getSize(new THREE.Vector3());
  let tris = 0, vol = 0;
  if (!isGcode) {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    object.traverse((m) => {
      if (!m.isMesh) return;
      const g = m.geometry, pos = g.attributes.position, idx = g.index;
      const n = idx ? idx.count / 3 : pos.count / 3;
      tris += n;
      for (let i = 0; i < n; i++) {
        const i0 = idx ? idx.getX(i * 3) : i * 3, i1 = idx ? idx.getX(i * 3 + 1) : i * 3 + 1, i2 = idx ? idx.getX(i * 3 + 2) : i * 3 + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m.matrixWorld);
        vol += a.dot(b.clone().cross(c)) / 6;
      }
    });
  }
  // po obróceniu Z-up -> Y-up: X szer., Z głęb., Y wys.
  if (rawZUp) return { x: size.x, y: size.y, z: size.z, tris: Math.round(tris), volume: Math.abs(vol) / 1000 };
  return { x: size.x, y: size.z, z: size.y, tris: Math.round(tris), volume: Math.abs(vol) / 1000 };
}

function orient(object, zUp) {
  const holder = new THREE.Group();
  if (zUp) object.rotation.x = -Math.PI / 2;
  holder.add(object);
  const box = boxOf(holder);
  const center = box.getCenter(new THREE.Vector3());
  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y -= box.min.y;
  holder.updateMatrixWorld(true);
  return holder;
}

function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.6));
  const d1 = new THREE.DirectionalLight(0xffffff, 2.2); d1.position.set(1, 2, 1.5); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xbcd2ff, 0.8); d2.position.set(-1.5, 0.5, -1); scene.add(d2);
}

export const VIEW_PRESETS = { iso: [1, 0.8, 1.2], front: [0, 0.25, 1], side: [1, 0.25, 0], top: [0.001, 1, 0.02], back: [-0.6, 0.6, -1] };
function fitCamera(camera, holder, controls, spec = null) {
  const box = boxOf(holder);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 0.001);
  let dist = r / Math.sin((camera.fov * Math.PI) / 180 / 2) * 1.05;
  const dir = new THREE.Vector3(...(spec && spec.dir ? spec.dir : VIEW_PRESETS.iso)).normalize();
  if (spec && spec.dist) dist = spec.dist * r;
  if (spec && spec.tx != null) sphere.center.add(new THREE.Vector3(spec.tx * r, spec.ty * r, spec.tz * r));
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  camera.near = dist / 100; camera.far = dist * 100;
  camera.updateProjectionMatrix();
  if (controls) { controls.target.copy(sphere.center); controls.update(); }
  else camera.lookAt(sphere.center);
  return r;
}

// ---------- miniatury (jeden współdzielony renderer) ----------
let thumbR = null;
export function renderThumbnail(parsed, size = 320, colors = null, viewSpec = null) {
  if (!thumbR) {
    const canvas = document.createElement('canvas');
    thumbR = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbR.setPixelRatio(1);
  }
  thumbR.setSize(size, size, false);
  const scene = new THREE.Scene();
  addLights(scene);
  if (colors) applySlotColors(parsed.object, colors);
  const holder = orient(parsed.object, parsed.zUp);
  scene.add(holder);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
  fitCamera(cam, holder, null, viewSpec);
  thumbR.setClearColor(0x000000, 0);
  thumbR.render(scene, cam);
  const url = thumbR.domElement.toDataURL('image/png');
  scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose?.(); });
  return url;
}

// ---------- interaktywny podgląd ----------
export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    addLights(this.scene);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.holder = null;
    this.grid = null;
    this.wire = false;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    const loop = () => { this.raf = requestAnimationFrame(loop); this.controls.update(); this.renderer.render(this.scene, this.camera); };
    loop();
  }
  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  clear() {
    if (this.holder) {
      this.scene.remove(this.holder);
      this.holder.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
      this.holder = null;
    }
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid = null; }
    this.setBuildVolume(null);
    this.clearBatch();
  }
  /** Podgląd partii: kopie modelu rozmieszczone na stole wg layout ({x, y, rot} w mm od rogu); nadmiar na kolejnych (czerwonych) płytach. */
  showBatch(layout, bed, copies) {
    this.clearBatch();
    if (!this.holder || !layout || !layout.length || copies <= 1) return;
    const g = new THREE.Group();
    const cap = layout.length, n = Math.min(copies, 600), plates = Math.ceil(n / cap), pitch = bed.x + 30;
    this._batchMats = [];
    const red = new THREE.MeshStandardMaterial({ color: 0xe5484d, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide });
    this._batchMats.push(red);
    for (let i = 0; i < n; i++) {
      const p = layout[i % cap], k = Math.floor(i / cap);
      const c = this.holder.clone();
      c.visible = true;
      c.rotation.y = p.rot ? Math.PI / 2 : 0;
      c.position.set(p.x - bed.x / 2 + k * pitch, 0, p.y - bed.y / 2);
      if (k > 0) c.traverse((o) => { if (o.isMesh) o.material = red; });
      g.add(c);
    }
    for (let k = 0; k < plates; k++) {
      const ok = k === 0;
      const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(bed.x, bed.z, bed.y)), new THREE.LineBasicMaterial({ color: ok ? 0x6aa7ff : 0xe5484d, transparent: true, opacity: ok ? 0.5 : 0.9 }));
      box.position.set(k * pitch, bed.z / 2, 0);
      box.userData.batchFrame = true;
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(bed.x, bed.y), new THREE.MeshBasicMaterial({ color: ok ? 0x6aa7ff : 0xe5484d, transparent: true, opacity: 0.06, side: THREE.DoubleSide }));
      plate.rotation.x = -Math.PI / 2; plate.position.set(k * pitch, 0.02, 0);
      plate.userData.batchFrame = true;
      g.add(box, plate);
    }
    this.holder.visible = false;
    this.batch = g;
    this.scene.add(g);
    if (this.grid) this.grid.visible = false;
    fitCamera(this.camera, g, this.controls);
  }
  clearBatch() {
    if (!this.batch) return;
    this.scene.remove(this.batch);
    this.batch.traverse((o) => { if (o.userData.batchFrame) { o.geometry.dispose(); o.material.dispose(); } });
    (this._batchMats || []).forEach((m) => m.dispose());
    this.batch = null;
    if (this.holder) { this.holder.visible = true; fitCamera(this.camera, this.holder, this.controls); }
    if (this.grid) this.grid.visible = true;
  }
  /** Obrys obszaru roboczego {x, y, z} (mm) wyśrodkowany pod widocznym modelem; ok=false → czerwony. */
  setBuildVolume(bed, ok = true, rotated = false) {
    if (this.volume) { this.scene.remove(this.volume); this.volume.geometry.dispose(); this.volume.material.dispose(); this.volume = null; }
    if (!bed || !this.holder) return;
    this._bed = [bed, ok, rotated];
    const bx = rotated ? bed.y : bed.x, by = rotated ? bed.x : bed.y;
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(bx, bed.z, by));
    const mat = new THREE.LineBasicMaterial({ color: ok ? 0x6aa7ff : 0xe5484d, transparent: true, opacity: ok ? 0.45 : 0.9 });
    const box = boxOf(this.holder), c = box.getCenter(new THREE.Vector3());
    this.volume = new THREE.LineSegments(geo, mat);
    this.volume.position.set(c.x, box.min.y + bed.z / 2, c.z);
    this.scene.add(this.volume);
  }
  show(parsed) {
    this.clear();
    this.holder = orient(parsed.object, parsed.zUp);
    this.scene.add(this.holder);
    const box = boxOf(this.holder);
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, 20);
    const step = span > 300 ? 50 : span > 80 ? 10 : 5;
    const gsize = Math.ceil((span * 1.6) / step) * step;
    this.grid = new THREE.GridHelper(gsize, gsize / step, 0x4a5262, 0x2a2f38);
    this.grid.position.y = -0.01;
    this.scene.add(this.grid);
    this.setWireframe(this.wire);
    fitCamera(this.camera, this.holder, this.controls);
  }
  setSlotColors(colors) { if (this.holder) applySlotColors(this.holder, colors); }
  setColor(hex) {
    const c = new THREE.Color(hex);
    this.holder?.traverse((o) => {
      if ((o.isMesh && !o.material.vertexColors) || ((o.isLine || o.isLineSegments) && !o.userData.travel)) o.material.color.copy(c);
    });
  }
  resetView() { const t = this.batch || this.holder; if (t) fitCamera(this.camera, t, this.controls); }
  showPlate(k) {
    if (!this.holder) return;
    this.holder.traverse((o) => { if (o.isMesh) { const hide = k != null && (o.userData.plate || 0) !== k; o.visible = !hide; o.userData.hiddenPlate = hide; } });
    const box = boxOf(this.holder);
    if (this.grid) { const c = box.getCenter(new THREE.Vector3()); this.grid.position.x = c.x; this.grid.position.z = c.z; }
    if (this.volume && this._bed) this.setBuildVolume(...this._bed);
    fitCamera(this.camera, this.holder, this.controls);
  }
  /** Kierunek kamery względem środka i odległość w promieniach – do zapamiętania widoku miniatury */
  getViewSpec() {
    if (!this.holder) return null;
    const sphere = boxOf(this.holder).getBoundingSphere(new THREE.Sphere());
    const d = this.camera.position.clone().sub(this.controls.target);
    const len = d.length();
    d.normalize();
    return { dir: [d.x, d.y, d.z], dist: len / Math.max(sphere.radius, 0.001), tx: (this.controls.target.x - sphere.center.x) / sphere.radius, ty: (this.controls.target.y - sphere.center.y) / sphere.radius, tz: (this.controls.target.z - sphere.center.z) / sphere.radius };
  }
  setWireframe(on) {
    this.wire = on;
    this.holder?.traverse((o) => { if (o.isMesh) o.material.wireframe = on; });
  }
  toggleTravel() {
    this.holder?.traverse((o) => { if (o.userData.travel) o.visible = !o.visible; });
  }
}
