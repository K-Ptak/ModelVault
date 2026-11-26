// ModelVault – menedżer biblioteki modeli 3D
// Biblioteka = zwykły folder na dysku. Podfoldery = kategorie.
// Tagi / notatki / status trzymane w <biblioteka>/.modelvault.json (wędruje razem z folderem).

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const META_FILE = '.modelvault.json';
const VIEWABLE = new Set(['stl', 'obj', '3mf', 'ply', 'gcode']);
const OTHER = new Set(['step', 'stp', 'scad', 'f3d', 'blend', 'bgcode', 'amf', 'fbx', 'glb', 'gltf', 'iges', 'igs', 'lys', 'chitubox', 'ctb']);
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'webp']);
const IGNORE_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);

let win = null;
let config = {};
let root = null;
let meta = { version: 1, files: {} };
let watcher = null;
let selfWriteUntil = 0;

const configPath = () => path.join(app.getPath('userData'), 'config.json');
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

// Domyślne ustawienia = wartości z arkusza wyceny użytkownika
const DEFAULT_SETTINGS = {
  version: 1,
  appearance: { modelColor: '#f2a03d', useFilamentColor: true },
  pricing: {
    currency: 'zł',
    printerW: 120,          // moc drukarki w trakcie druku (W)
    startKWh: 0.03,         // energia na rozgrzanie i start jednego wydruku (kWh)
    kWhPrice: 1.04,         // cena prądu (zł/kWh)
    hourRate: 40,           // stawka za mój czas (zł/h)
    minPerPrint: 10,        // mój czas na jeden wydruk (min)
    minPerOrder: 15,        // mój czas na całe zamówienie (min)
    printerPrice: 2359,     // cena drukarki (zł)
    printerLife: 6000,      // żywotność drukarki (h)
    servicePerH: 0.2,       // serwis i części (zł/h)
    buffer: 0.1,            // bufor na nieudane wydruki (ułamek)
    margin: 0,              // marża (ułamek) -> cena dla klienta
    roundTo: 0,             // zaokrąglanie ceny dla klienta w górę (zł)
    estFill: 0.35,          // szacunek z objętości: jaka część bryły to plastik
    estGramsPerHour: 12,    // szacunek czasu: wydajność drukarki (g/h)
    defaultFilament: 'f6',
  },
  filaments: [
    { id: 'f1', name: 'PlastSpaw PLA+', color: 'beżowy', hex: '#d8c4a2', type: 'PLA', pricePerKg: 45, density: 1.24 },
    { id: 'f2', name: 'PlastSpaw PLA+', color: 'zielony', hex: '#3f9c4f', type: 'PLA', pricePerKg: 45, density: 1.24 },
    { id: 'f3', name: 'SUNLU PLA+', color: 'srebrny', hex: '#b7bcc3', type: 'PLA', pricePerKg: 69.99, density: 1.24 },
    { id: 'f4', name: 'eSun PLA', color: 'niebieski/czerwony', hex: '#7b5fd6', type: 'PLA', pricePerKg: 47.52, density: 1.24 },
    { id: 'f5', name: 'SUNLU PETG', color: 'czarny', hex: '#2b2d31', type: 'PETG', pricePerKg: 42.99, density: 1.27 },
    { id: 'f6', name: 'SUNLU PLA+', color: 'złoty', hex: '#d4a446', type: 'PLA', pricePerKg: 69.99, density: 1.24 },
    { id: 'f7', name: 'TECBEARS PETG', color: 'biały', hex: '#f1f1ee', type: 'PETG', pricePerKg: 39.99, density: 1.27 },
  ],
  order: { name: '', items: [] },
};
let settings = null;
function loadSettings() {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch {}
  const d = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings = s ? {
    ...d, ...s,
    appearance: { ...d.appearance, ...(s.appearance || {}) },
    pricing: { ...d.pricing, ...(s.pricing || {}) },
    filaments: Array.isArray(s.filaments) ? s.filaments : d.filaments,
    order: s.order && Array.isArray(s.order.items) ? s.order : d.order,
  } : d;
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  const tmp = settingsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, settingsPath());
}
const thumbDir = () => path.join(app.getPath('userData'), 'thumbs');

// ---------- config ----------
function loadConfig() {
  try { config = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { config = {}; }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

// ---------- path helpers ----------
const toRel = (abs) => path.relative(root, abs).split(path.sep).join('/');
function toAbs(rel) {
  const abs = path.resolve(root, ...String(rel || '').split('/').filter(Boolean));
  const r = path.relative(root, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error('Ścieżka poza biblioteką');
  return abs;
}
const extOf = (n) => path.extname(n).slice(1).toLowerCase();

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

async function uniquePath(abs) {
  if (!(await exists(abs))) return abs;
  const dir = path.dirname(abs), ext = path.extname(abs), base = path.basename(abs, ext);
  for (let i = 2; ; i++) {
    const cand = path.join(dir, `${base} (${i})${ext}`);
    if (!(await exists(cand))) return cand;
  }
}

async function moveFs(src, dst) {
  try { await fsp.rename(src, dst); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(src, dst, { recursive: true });
    await fsp.rm(src, { recursive: true, force: true });
  }
}

// ---------- metadata ----------
async function loadMeta() {
  meta = { version: 1, files: {} };
  if (!root) return;
  try {
    const m = JSON.parse(await fsp.readFile(path.join(root, META_FILE), 'utf8'));
    if (m && m.files) meta = m;
  } catch { /* brak pliku – OK */ }
}
let saveTimer = null;
function saveMetaSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveMetaNow, 250);
}
async function saveMetaNow() {
  if (!root) return;
  selfWriteUntil = Date.now() + 1500;
  const p = path.join(root, META_FILE);
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2));
  await fsp.rename(tmp, p);
}
function remapMeta(oldRel, newRel, isDir) {
  const out = {};
  for (const [k, v] of Object.entries(meta.files)) {
    if (k === oldRel) out[newRel] = v;
    else if (isDir && k.startsWith(oldRel + '/')) out[newRel + k.slice(oldRel.length)] = v;
    else out[k] = v;
  }
  meta.files = out;
}

// ---------- scanning ----------
async function scan() {
  if (!root) return null;
  const folders = [];
  const files = [];
  const images = new Map(); // dirRel -> Map(basenameLower -> rel)
  async function walk(absDir, depth) {
    let entries;
    try { entries = await fsp.readdir(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) {
        if (depth > 12) continue;
        folders.push(toRel(abs));
        await walk(abs, depth + 1);
      } else if (e.isFile()) {
        const ext = extOf(e.name);
        const dirRel = toRel(absDir);
        if (IMAGES.has(ext)) {
          if (!images.has(dirRel)) images.set(dirRel, new Map());
          images.get(dirRel).set(path.basename(e.name, path.extname(e.name)).toLowerCase(), toRel(abs));
          continue;
        }
        if (!VIEWABLE.has(ext) && !OTHER.has(ext)) continue;
        let st;
        try { st = await fsp.stat(abs); } catch { continue; }
        files.push({ rel: toRel(abs), name: e.name, dir: dirRel === '' ? '' : dirRel, ext, size: st.size, mtime: st.mtimeMs, viewable: VIEWABLE.has(ext) });
      }
    }
  }
  await walk(root, 0);

  // obrazek o tej samej nazwie co model (np. z Printables) = gotowa miniatura
  for (const f of files) {
    const imgs = images.get(f.dir);
    if (!imgs) continue;
    const base = path.basename(f.name, path.extname(f.name)).toLowerCase();
    if (imgs.has(base)) f.image = imgs.get(base);
  }

  // Pliki przeniesione poza aplikacją: dopasuj osierocone metadane po nazwie + rozmiarze
  const byRel = new Set(files.map((f) => f.rel));
  let changed = false;
  const orphans = Object.keys(meta.files).filter((k) => !byRel.has(k));
  for (const k of orphans) {
    const m = meta.files[k];
    const name = k.split('/').pop();
    const cand = files.filter((f) => f.name === name && !meta.files[f.rel] && (m.size == null || m.size === f.size));
    if (cand.length === 1) { meta.files[cand[0].rel] = m; delete meta.files[k]; changed = true; }
  }
  for (const f of files) {
    const m = meta.files[f.rel];
    if (m && m.size !== f.size) { m.size = f.size; changed = true; }
  }
  if (changed) saveMetaSoon();

  folders.sort((a, b) => a.localeCompare(b, 'pl', { numeric: true, sensitivity: 'base' }));
  return { root, folders, files, meta: meta.files };
}

// ---------- watcher ----------
function startWatcher() {
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  if (!root) return;
  let t = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (_ev, fname) => {
      if (fname && String(fname).includes(META_FILE) && Date.now() < selfWriteUntil) return;
      clearTimeout(t);
      t = setTimeout(async () => {
        if (fname && String(fname).endsWith(META_FILE) && Date.now() >= selfWriteUntil) await loadMeta();
        win && win.webContents.send('lib:changed');
      }, 500);
    });
    watcher.on('error', () => {});
  } catch (e) { console.warn('watch failed', e); }
}

async function setRoot(p) {
  root = p;
  config.root = p;
  saveConfig();
  await loadMeta();
  startWatcher();
}

// ---------- IPC ----------
function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message || String(err) }; }
  });
}

handle('lib:get', async () => scan());
handle('lib:choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Wybierz folder z modelami 3D', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  await setRoot(r.filePaths[0]);
  return scan();
});

handle('file:read', async (rel) => {
  const buf = await fsp.readFile(toAbs(rel));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

handle('items:move', async (rels, destDirRel) => {
  const destAbs = toAbs(destDirRel);
  const moved = [];
  for (const rel of rels) {
    const src = toAbs(rel);
    const st = await fsp.stat(src);
    const isDir = st.isDirectory();
    if (isDir && (destAbs + path.sep).startsWith(src + path.sep)) throw new Error('Nie można przenieść folderu do niego samego');
    if (path.dirname(src) === destAbs) continue;
    const dst = await uniquePath(path.join(destAbs, path.basename(src)));
    await moveFs(src, dst);
    // obrazek-miniatura jedzie razem z modelem
    if (!isDir) {
      const base = src.slice(0, -path.extname(src).length);
      for (const ie of IMAGES) {
        const img = `${base}.${ie}`;
        if (await exists(img)) {
          const dbase = dst.slice(0, -path.extname(dst).length);
          if (!(await exists(`${dbase}.${ie}`))) await moveFs(img, `${dbase}.${ie}`);
        }
      }
    }
    remapMeta(rel, toRel(dst), isDir);
    moved.push(toRel(dst));
  }
  await saveMetaNow();
  return moved;
});

handle('item:rename', async (rel, newName) => {
  newName = String(newName).trim();
  if (!newName || /[\\/:*?"<>|]/.test(newName)) throw new Error('Niedozwolona nazwa');
  const src = toAbs(rel);
  const st = await fsp.stat(src);
  const dst = path.join(path.dirname(src), newName);
  if (dst === src) return rel;
  if (await exists(dst) && dst.toLowerCase() !== src.toLowerCase()) throw new Error('Element o tej nazwie już istnieje');
  await fsp.rename(src, dst);
  remapMeta(rel, toRel(dst), st.isDirectory());
  await saveMetaNow();
  return toRel(dst);
});

handle('folder:create', async (parentRel, name) => {
  name = String(name).trim();
  if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('Niedozwolona nazwa');
  const p = toAbs(parentRel ? `${parentRel}/${name}` : name);
  if (await exists(p)) throw new Error('Folder już istnieje');
  await fsp.mkdir(p, { recursive: true });
  return toRel(p);
});

handle('items:trash', async (rels) => {
  for (const rel of rels) {
    const abs = toAbs(rel);
    if (abs === root) throw new Error('Nie można usunąć całej biblioteki');
    await shell.trashItem(abs);
    for (const k of Object.keys(meta.files)) if (k === rel || k.startsWith(rel + '/')) delete meta.files[k];
  }
  await saveMetaNow();
  return true;
});

handle('files:import', async (absPaths, destDirRel) => {
  const destAbs = toAbs(destDirRel);
  const out = [];
  for (const p of absPaths) {
    const dst = await uniquePath(path.join(destAbs, path.basename(p)));
    await fsp.cp(p, dst, { recursive: true });
    out.push(toRel(dst));
  }
  return out;
});

handle('meta:set', async (rel, patch) => {
  const cur = meta.files[rel] || {};
  const next = { ...cur, ...patch };
  try { next.size = (await fsp.stat(toAbs(rel))).size; } catch {}
  if (next.print) { for (const k of Object.keys(next.print)) if (next.print[k] == null || next.print[k] === '') delete next.print[k]; if (!Object.keys(next.print).length) delete next.print; }
  const empty = !(next.tags && next.tags.length) && !next.notes && !next.status && !next.favorite && !next.print;
  if (empty) delete meta.files[rel]; else meta.files[rel] = next;
  saveMetaSoon();
  return meta.files[rel] || null;
});

handle('shell:open', async (rel) => { const e = await shell.openPath(toAbs(rel)); if (e) throw new Error(e); return true; });
handle('shell:reveal', async (rel) => { shell.showItemInFolder(toAbs(rel)); return true; });
handle('shell:openRoot', async () => { if (root) await shell.openPath(root); return true; });

const thumbKey = (rel, mtime, size, v) => crypto.createHash('sha1').update(`${root}|${rel}|${mtime}|${size}|${v || ''}`).digest('hex');
handle('thumb:get', async (rel, mtime, size, v) => {
  try { return 'data:image/png;base64,' + (await fsp.readFile(path.join(thumbDir(), thumbKey(rel, mtime, size, v) + '.png'))).toString('base64'); }
  catch { return null; }
});
handle('thumb:put', async (rel, mtime, size, v, dataUrl) => {
  await fsp.mkdir(thumbDir(), { recursive: true });
  await fsp.writeFile(path.join(thumbDir(), thumbKey(rel, mtime, size, v) + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  return true;
});
handle('thumb:clear', async () => { await fsp.rm(thumbDir(), { recursive: true, force: true }); return true; });

handle('settings:get', async () => settings);
handle('settings:set', async (next) => { settings = next; saveSettings(); return true; });
handle('settings:defaults', async () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
handle('clipboard:write', async (text) => { clipboard.writeText(String(text)); return true; });
handle('file:save', async (defaultName, content) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (r.canceled || !r.filePath) return null;
  await fsp.writeFile(r.filePath, '\ufeff' + content, 'utf8');
  return r.filePath;
});
handle('image:read', async (rel) => {
  const abs = toAbs(rel);
  const ext = extOf(abs) === 'jpg' ? 'jpeg' : extOf(abs);
  return `data:image/${ext};base64,` + (await fsp.readFile(abs)).toString('base64');
});

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 600,
    backgroundColor: '#14161a',
    title: 'ModelVault',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools();
  });

  // tryb testowy: zrzut ekranu i wyjście
  if (process.env.MV_SCREENSHOT) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.level, e.message));
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.MV_EVAL) { try { await win.webContents.executeJavaScript(process.env.MV_EVAL); } catch (e) { console.error(e); } await new Promise((r) => setTimeout(r, 4000)); }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.MV_SCREENSHOT, img.toPNG());
        app.quit();
      }, Number(process.env.MV_DELAY || 6000));
    });
  }
}

// programowy WebGL, gdy GPU jest niedostępne (VM, stare sterowniki)
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

app.whenReady().then(async () => {
  loadConfig();
  loadSettings();
  const r = process.env.MV_ROOT || config.root;
  if (r && fs.existsSync(r)) await setRoot(r);
  createWindow();
});
app.on('window-all-closed', async () => { clearTimeout(saveTimer); try { await saveMetaNow(); } catch {} app.quit(); });
