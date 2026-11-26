// Kopiuje potrzebne pliki three.js do renderer/vendor (uruchamiane automatycznie po npm install).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', 'three');
const dst = path.join(root, 'renderer', 'vendor', 'three');
const files = {
  'build/three.module.js': 'three.module.js',
  'build/three.core.js': 'three.core.js',
  'examples/jsm/controls/OrbitControls.js': 'addons/controls/OrbitControls.js',
  'examples/jsm/loaders/STLLoader.js': 'addons/loaders/STLLoader.js',
  'examples/jsm/loaders/OBJLoader.js': 'addons/loaders/OBJLoader.js',
  'examples/jsm/loaders/3MFLoader.js': 'addons/loaders/3MFLoader.js',
  'examples/jsm/loaders/PLYLoader.js': 'addons/loaders/PLYLoader.js',
  'examples/jsm/libs/fflate.module.js': 'addons/libs/fflate.module.js',
  'examples/jsm/utils/BufferGeometryUtils.js': 'addons/utils/BufferGeometryUtils.js',
};
if (!fs.existsSync(src)) { console.warn('three nie jest zainstalowane – pomijam'); process.exit(0); }
fs.rmSync(dst, { recursive: true, force: true });
for (const [from, to] of Object.entries(files)) {
  const out = path.join(dst, to);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(path.join(src, from), out);
}
fs.copyFileSync(path.join(src, 'LICENSE'), path.join(dst, 'LICENSE'));
console.log('three.js →', path.relative(root, dst));
