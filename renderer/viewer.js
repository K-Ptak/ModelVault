import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { GCodeLoader } from 'three/addons/loaders/GCodeLoader.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';

const MODEL_COLOR = 0xf2a03d;

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

/** Zwraca { object, zUp, isGcode } */
export function parseModel(ext, buffer) {
  switch (ext) {
    case 'stl': {
      const geo = new STLLoader().parse(buffer);
      geo.computeVertexNormals(); // wiele plików STL ma zerowe/błędne normalne
      return { object: meshFromGeometry(geo), zUp: true };
    }
    case 'ply': {
      const geo = new PLYLoader().parse(buffer);
      const m = meshFromGeometry(geo);
      if (geo.attributes.color) m.material.vertexColors = true, m.material.color.set(0xffffff);
      return { object: m, zUp: true };
    }
    case 'obj': {
      const text = new TextDecoder().decode(buffer);
      const obj = new OBJLoader().parse(text);
      restyle(obj);
      return { object: obj, zUp: false };
    }
    case '3mf': {
      const obj = new ThreeMFLoader().parse(buffer);
      let meshes = 0;
      obj.traverse((c) => { if (c.isMesh) meshes++; });
      if (!meshes) throw new Error('Plik 3MF nie zawiera siatki, którą da się odczytać');
      restyle(obj);
      return { object: obj, zUp: true };
    }
    case 'gcode': {
      const text = new TextDecoder().decode(buffer);
      const obj = new GCodeLoader().parse(text);
      obj.traverse((c) => {
        if (c.isLineSegments || c.isLine) {
          const travel = c.material && c.material.name === 'path';
          c.userData.travel = travel;
          c.material = new THREE.LineBasicMaterial({ color: travel ? 0x5a6578 : MODEL_COLOR, transparent: travel, opacity: travel ? 0.35 : 1 });
          if (travel) c.visible = false;
        }
      });
      return { object: obj, zUp: false, isGcode: true };
    }
    default:
      throw new Error('Brak podglądu dla tego formatu');
  }
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
  object.traverse((c) => { if ((c.isMesh || c.isLine || c.isLineSegments) && !c.userData.travel) { box.expandByObject(c); any = true; } });
  return any ? box : new THREE.Box3().setFromObject(object);
}

export function computeStats(object, isGcode) {
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

function fitCamera(camera, holder, controls) {
  const box = boxOf(holder);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 0.001);
  const dist = r / Math.sin((camera.fov * Math.PI) / 180 / 2) * 1.05;
  const dir = new THREE.Vector3(1, 0.8, 1.2).normalize();
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  camera.near = dist / 100; camera.far = dist * 100;
  camera.updateProjectionMatrix();
  if (controls) { controls.target.copy(sphere.center); controls.update(); }
  else camera.lookAt(sphere.center);
  return r;
}

// ---------- miniatury (jeden współdzielony renderer) ----------
let thumbR = null;
export function renderThumbnail(parsed, size = 320) {
  if (!thumbR) {
    const canvas = document.createElement('canvas');
    thumbR = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbR.setPixelRatio(1);
  }
  thumbR.setSize(size, size, false);
  const scene = new THREE.Scene();
  addLights(scene);
  const holder = orient(parsed.object, parsed.zUp);
  scene.add(holder);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
  fitCamera(cam, holder);
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
  resetView() { if (this.holder) fitCamera(this.camera, this.holder, this.controls); }
  setWireframe(on) {
    this.wire = on;
    this.holder?.traverse((o) => { if (o.isMesh) o.material.wireframe = on; });
  }
  toggleTravel() {
    this.holder?.traverse((o) => { if (o.userData.travel) o.visible = !o.visible; });
  }
}
