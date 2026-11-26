// ModelVault – menedżer biblioteki modeli 3D
// Biblioteka = zwykły folder na dysku. Podfoldery = kategorie.
// Tagi / notatki / status trzymane w <biblioteka>/.modelvault.json (wędruje razem z folderem).

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
let fflate = null; try { fflate = require('fflate'); } catch {}
let autoUpdater = null; try { ({ autoUpdater } = require('electron-updater')); } catch {}

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
    // wielokolorowe (szacunki, gdy brak danych ze slicera)
    layerHeight: 0.2,       // mm – do liczenia zmian koloru z wysokości
    purgePerChange: 0.6,    // g filamentu wyrzucanego przy jednej zmianie koloru (purge + wieża)
    changeTimeSec: 45,      // s na jedną zmianę koloru
    paintWall: 0.8,         // mm – grubość „skóry” malowanego koloru
  },
  stock: {
    lowThreshold: 150,          // g – ostrzeżenie o kończącej się szpuli
    onModelPrinted: true,       // odejmuj filament po oznaczeniu modelu jako „wydrukowane”
    onOrderStatus: 'printing',  // 'printing' | 'done' | 'off' – kiedy odejmować dla zamówień
  },
  orders: [],
  stockLog: [],
  clients: [],
  business: { name: '', address: '', email: '', phone: '', taxId: '', bank: '', footer: 'Dziękuję za zainteresowanie!', validityDays: 14, showItemPrices: true },
  queue: { printers: 1, hoursPerDay: 14, startHour: 8, includeQuoted: false },
  slicers: { list: null, default: null },
  inbox: { enabled: false, folders: null, mode: 'move', target: 'Do posortowania', unzip: true, enabledAt: 0, processed: {} },
  thumbs: { preset: 'iso' },
  backup: { auto: true, keep: 14, last: 0 },
  updates: { auto: true },
  onboardingDone: false,
  filaments: [
    { id: 'f1', name: 'PlastSpaw PLA+', color: 'beżowy', hex: '#d8c4a2', type: 'PLA', pricePerKg: 45, density: 1.24, spoolWeight: 1000, remaining: null },
    { id: 'f2', name: 'PlastSpaw PLA+', color: 'zielony', hex: '#3f9c4f', type: 'PLA', pricePerKg: 45, density: 1.24, spoolWeight: 1000, remaining: null },
    { id: 'f3', name: 'SUNLU PLA+', color: 'srebrny', hex: '#b7bcc3', type: 'PLA', pricePerKg: 69.99, density: 1.24, spoolWeight: 1000, remaining: null },
    { id: 'f4', name: 'eSun PLA', color: 'niebieski/czerwony', hex: '#7b5fd6', type: 'PLA', pricePerKg: 47.52, density: 1.24, spoolWeight: 1000, remaining: null },
    { id: 'f5', name: 'SUNLU PETG', color: 'czarny', hex: '#2b2d31', type: 'PETG', pricePerKg: 42.99, density: 1.27, spoolWeight: 1000, remaining: null },
    { id: 'f6', name: 'SUNLU PLA+', color: 'złoty', hex: '#d4a446', type: 'PLA', pricePerKg: 69.99, density: 1.24, spoolWeight: 1000, remaining: null },
    { id: 'f7', name: 'TECBEARS PETG', color: 'biały', hex: '#f1f1ee', type: 'PETG', pricePerKg: 39.99, density: 1.27, spoolWeight: 1000, remaining: null },
  ],
  order: { name: '', items: [] },
};
let settings = null;
function loadSettingsFromObject() { const s = settings; settings = null; loadSettings(s); }
function loadSettings(given) {
  let s = given || null;
  if (!given) { try { s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch {} }
  const d = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings = s ? {
    ...d, ...s,
    appearance: { ...d.appearance, ...(s.appearance || {}) },
    pricing: { ...d.pricing, ...(s.pricing || {}) },
    stock: { ...d.stock, ...(s.stock || {}) },
    orders: Array.isArray(s.orders) ? s.orders : [],
    stockLog: Array.isArray(s.stockLog) ? s.stockLog : [],
    clients: Array.isArray(s.clients) ? s.clients : [],
    business: { ...d.business, ...(s.business || {}) },
    queue: { ...d.queue, ...(s.queue || {}) },
    slicers: { ...d.slicers, ...(s.slicers || {}) },
    inbox: { ...d.inbox, ...(s.inbox || {}) },
    thumbs: { ...d.thumbs, ...(s.thumbs || {}) },
    backup: { ...d.backup, ...(s.backup || {}) },
    updates: { ...d.updates, ...(s.updates || {}) },
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
  return { root, folders, files, meta: meta.files, collections: meta.collections || [] };
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
  if (settings) startInbox();
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
  if (next.print && Array.isArray(next.print.slots)) { next.print.slots = next.print.slots.map((x) => x || null); if (!next.print.slots.some((x) => x && (x.filamentId || x.grams != null))) delete next.print.slots; }
  if (next.print && !Object.keys(next.print).length) delete next.print;
  if (next.source === '') delete next.source;
  if (Array.isArray(next.collections) && !next.collections.length) delete next.collections;
  if (next.thumbView === null) delete next.thumbView;
  const empty = !(next.tags && next.tags.length) && !next.notes && !next.status && !next.favorite && !next.print && !next.source && !next.collections && !next.thumbView;
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
handle('files:hash', async (rels) => {
  const out = {};
  for (const rel of rels) {
    try {
      out[rel] = await new Promise((res, rej) => {
        const h = crypto.createHash('sha1');
        fs.createReadStream(toAbs(rel)).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
      });
    } catch { out[rel] = null; }
  }
  return out;
});
handle('shell:external', async (url) => {
  if (!/^https?:\/\//i.test(String(url))) throw new Error('Obsługiwane są tylko linki http(s)');
  await shell.openExternal(String(url));
  return true;
});
handle('settings:set', async (next) => {
  // pola prowadzone przez proces główny nie są nadpisywane przez okno
  const processed = settings.inbox.processed, last = settings.backup.last;
  settings = next;
  settings.inbox = { ...settings.inbox, processed };
  settings.backup = { ...settings.backup, last };
  saveSettings();
  return true;
});
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

handle('image:pickFor', async (rel) => {
  const r = await dialog.showOpenDialog(win, { title: 'Wybierz zdjęcie / obrazek miniatury', properties: ['openFile'], filters: [{ name: 'Obrazy', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const src = r.filePaths[0];
  const model = toAbs(rel);
  const base = model.slice(0, -path.extname(model).length);
  for (const ie of IMAGES) { const old = `${base}.${ie}`; if (await exists(old)) await shell.trashItem(old).catch(() => fsp.rm(old, { force: true })); }
  const dst = `${base}.${extOf(src) === 'jpeg' ? 'jpg' : extOf(src)}`;
  await fsp.copyFile(src, dst);
  return toRel(dst);
});
handle('image:removeFor', async (imgRel) => { await shell.trashItem(toAbs(imgRel)); return true; });
handle('collections:set', async (list) => { meta.collections = Array.isArray(list) ? list : []; await saveMetaNow(); return meta.collections; });

// ---------- kopie zapasowe ----------
const backupDir = () => path.join(app.getPath('userData'), 'backups');
async function createBackup(reason = 'auto') {
  await fsp.mkdir(backupDir(), { recursive: true });
  const d0 = new Date(), z = (n) => String(n).padStart(2, '0');
  const stamp = `${d0.getFullYear()}-${z(d0.getMonth() + 1)}-${z(d0.getDate())}-${z(d0.getHours())}-${z(d0.getMinutes())}-${z(d0.getSeconds())}`;
  const data = { app: 'ModelVault', kind: 'backup', version: app.getVersion(), createdAt: Date.now(), reason, settings, library: root ? { root, meta } : null };
  const file = path.join(backupDir(), `modelvault-${stamp}.json`);
  await fsp.writeFile(file, JSON.stringify(data));
  settings.backup.last = Date.now(); saveSettings();
  const all = (await fsp.readdir(backupDir())).filter((n) => /^modelvault-.*\.json$/.test(n)).sort().reverse();
  for (const old of all.slice(Math.max(3, settings.backup.keep || 14))) await fsp.rm(path.join(backupDir(), old), { force: true });
  return path.basename(file);
}
async function maybeAutoBackup() {
  if (!settings.backup.auto) return;
  if (Date.now() - (settings.backup.last || 0) > 20 * 3600 * 1000) { try { await createBackup('auto'); } catch (e) { console.warn('backup', e); } }
}
function applyBackupData(data, withLibrary) {
  if (!data || data.app !== 'ModelVault' || !data.settings) throw new Error('To nie jest kopia ModelVault');
  const keepSlicers = settings.slicers;
  settings = data.settings; loadSettingsFromObject();
  if (!settings.slicers || !settings.slicers.list) settings.slicers = keepSlicers;
  saveSettings();
  if (withLibrary && data.library && data.library.meta && root) { meta = data.library.meta; return saveMetaNow(); }
}
handle('backup:list', async () => {
  try {
    const names = (await fsp.readdir(backupDir())).filter((n) => /^modelvault-.*\.json$/.test(n)).sort().reverse();
    return Promise.all(names.map(async (n) => ({ name: n, size: (await fsp.stat(path.join(backupDir(), n))).size })));
  } catch { return []; }
});
handle('backup:create', async () => createBackup('manual'));
handle('backup:restore', async (name, withLibrary) => {
  const data = JSON.parse(await fsp.readFile(path.join(backupDir(), path.basename(name)), 'utf8'));
  await createBackup('przed przywróceniem');
  await applyBackupData(data, withLibrary);
  return settings;
});
handle('backup:export', async () => {
  const r = await dialog.showSaveDialog(win, { defaultPath: `ModelVault-kopia-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Kopia ModelVault', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  await fsp.writeFile(r.filePath, JSON.stringify({ app: 'ModelVault', kind: 'export', version: app.getVersion(), createdAt: Date.now(), settings, library: root ? { root, meta } : null }, null, 1));
  return r.filePath;
});
handle('backup:import', async (withLibrary) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Kopia ModelVault', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const data = JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8'));
  await createBackup('przed importem');
  await applyBackupData(data, withLibrary);
  return settings;
});
handle('backup:openDir', async () => { await fsp.mkdir(backupDir(), { recursive: true }); await shell.openPath(backupDir()); return true; });

// ---------- slicery ----------
const env = (k) => process.env[k] || '';
const PF = () => [env('ProgramFiles') || 'C:\\Program Files', env('ProgramFiles(x86)') || 'C:\\Program Files (x86)', path.join(env('LOCALAPPDATA') || path.join(os.homedir(), 'AppData', 'Local'), 'Programs')];
const KNOWN_SLICERS = [
  { id: 'bambu', name: 'Bambu Studio', win: [['Bambu Studio', 'bambu-studio.exe']], mac: ['BambuStudio.app', 'Bambu Studio.app'], linux: ['bambu-studio', 'BambuStudio'] },
  { id: 'orca', name: 'OrcaSlicer', win: [['OrcaSlicer', 'orca-slicer.exe']], mac: ['OrcaSlicer.app'], linux: ['orca-slicer', 'OrcaSlicer'] },
  { id: 'prusa', name: 'PrusaSlicer', win: [['Prusa3D\\PrusaSlicer', 'prusa-slicer.exe'], ['PrusaSlicer', 'prusa-slicer.exe']], mac: ['Original Prusa Drivers/PrusaSlicer.app', 'PrusaSlicer.app'], linux: ['prusa-slicer', 'PrusaSlicer'] },
  { id: 'cura', name: 'UltiMaker Cura', winPrefix: [['UltiMaker Cura', ['UltiMaker-Cura.exe', 'Cura.exe']], ['Ultimaker Cura', ['Ultimaker-Cura.exe', 'Cura.exe']]], mac: ['UltiMaker Cura.app', 'Ultimaker Cura.app'], linux: ['cura', 'UltiMaker-Cura'] },
  { id: 'creality', name: 'Creality Print', winPrefix: [['Creality Print', ['CrealityPrint.exe', 'Creality Print.exe']]], mac: ['CrealityPrint.app', 'Creality Print.app'], linux: ['CrealityPrint'] },
  { id: 'elegoo', name: 'ElegooSlicer', win: [['ElegooSlicer', 'elegoo-slicer.exe']], mac: ['ElegooSlicer.app'], linux: ['elegoo-slicer'] },
  { id: 'anycubic', name: 'Anycubic Slicer Next', win: [['AnycubicSlicerNext', 'AnycubicSlicerNext.exe'], ['Anycubic Slicer Next', 'AnycubicSlicerNext.exe']], mac: ['AnycubicSlicerNext.app'], linux: [] },
  { id: 'superslicer', name: 'SuperSlicer', win: [['SuperSlicer', 'superslicer.exe']], mac: ['SuperSlicer.app'], linux: ['superslicer'] },
  { id: 'flashprint', name: 'FlashPrint', winPrefix: [['FlashForge\\FlashPrint', ['FlashPrint.exe']]], mac: ['FlashPrint 5.app'], linux: [] },
];
async function which(cmd) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) { const p = path.join(d, cmd); if (await exists(p)) return p; }
  return null;
}
async function detectSlicers() {
  const found = [];
  for (const k of KNOWN_SLICERS) {
    let hit = null;
    if (process.platform === 'win32') {
      for (const base of PF()) {
        for (const [dir, exe] of k.win || []) { const p = path.join(base, dir, exe); if (await exists(p)) { hit = p; break; } }
        if (!hit) for (const [prefix, exes] of k.winPrefix || []) {
          const parent = path.join(base, path.dirname(prefix) === '.' ? '' : path.dirname(prefix));
          const pre = path.basename(prefix);
          let names = []; try { names = (await fsp.readdir(parent)).filter((n) => n.startsWith(pre)).sort().reverse(); } catch {}
          for (const n of names) { for (const e of exes) { const p = path.join(parent, n, e); if (await exists(p)) { hit = p; break; } } if (hit) break; }
          if (hit) break;
        }
        if (hit) break;
      }
    } else if (process.platform === 'darwin') {
      for (const a of k.mac || []) { const p = path.join('/Applications', a); if (await exists(p)) { hit = p; break; } }
    } else {
      for (const c of k.linux || []) { const p = await which(c); if (p) { hit = p; break; } }
    }
    if (hit) found.push({ id: k.id, name: k.name, path: hit });
  }
  return found;
}
async function mergeDetected() {
  const det = await detectSlicers();
  const cur = settings.slicers.list || [];
  const out = [...cur];
  for (const d of det) {
    const ex = out.find((x) => x.id === d.id && !x.custom);
    if (ex) { if (!(await exists(ex.path))) ex.path = d.path; }
    else out.push({ ...d, enabled: true, custom: false });
  }
  for (const x of out) x.available = !!x.path && await exists(x.path);
  settings.slicers.list = out;
  if (!settings.slicers.default || (settings.slicers.default !== 'system' && !out.some((x) => x.id === settings.slicers.default && x.available && x.enabled))) {
    const first = out.find((x) => x.available && x.enabled);
    settings.slicers.default = first ? first.id : 'system';
  }
  saveSettings();
  return settings.slicers;
}
handle('slicers:detect', async () => mergeDetected());
handle('slicers:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Wskaż plik programu slicera', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Program', extensions: ['exe'] }] : [] });
  return r.canceled ? null : r.filePaths[0];
});
handle('slicers:open', async (slicerPath, rels) => {
  const files = rels.map(toAbs);
  if (!slicerPath || slicerPath === 'system') { for (const f of files) { const e = await shell.openPath(f); if (e) throw new Error(e); } return true; }
  if (!(await exists(slicerPath))) throw new Error('Nie znaleziono programu: ' + slicerPath);
  const child = process.platform === 'darwin' && slicerPath.endsWith('.app')
    ? spawn('open', ['-a', slicerPath, ...files], { detached: true, stdio: 'ignore' })
    : spawn(slicerPath, files, { detached: true, stdio: 'ignore', cwd: path.dirname(slicerPath) });
  child.on('error', () => {});
  child.unref();
  return true;
});

// ---------- skrzynka „Do posortowania” (Pobrane) ----------
const INBOX_EXT = new Set([...VIEWABLE, ...OTHER]);
const TEMP_EXT = /\.(crdownload|part|partial|tmp|download|opdownload)$/i;
let inboxWatchers = [];
let inboxBusy = false;
const inboxPending = new Set();
function defaultInboxFolders() { try { return [app.getPath('downloads')]; } catch { return [path.join(os.homedir(), 'Downloads')]; } }
async function waitStable(p) {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    let st; try { st = await fsp.stat(p); } catch { return false; }
    if (st.size === last && st.size > 0) return true;
    last = st.size;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}
function safeJoin(base, rel) {
  const parts = rel.split(/[\\/]+/).filter((x) => x && x !== '.' && x !== '..').map((x) => x.replace(/[:*?"<>|]/g, '_'));
  return path.join(base, ...parts);
}
async function processInboxFile(abs) {
  const ib = settings.inbox;
  if (!root || !ib.enabled) return null;
  const name = path.basename(abs);
  const ext = extOf(name);
  if (TEMP_EXT.test(name) || name.startsWith('.')) return null;
  const isZip = ext === 'zip';
  if (!isZip && !INBOX_EXT.has(ext)) return null;
  let st; try { st = await fsp.stat(abs); } catch { return null; }
  const key = abs.toLowerCase();
  if (ib.processed[key] && ib.processed[key] === st.mtimeMs) return null;
  if (!(await waitStable(abs))) return null;
  st = await fsp.stat(abs);
  const target = toAbs(ib.target || 'Do posortowania');
  await fsp.mkdir(target, { recursive: true });
  let added = [];
  if (isZip) {
    if (!ib.unzip || !fflate || st.size > 600 * 1048576) return null;
    const buf = await fsp.readFile(abs);
    let entries;
    try { entries = fflate.unzipSync(new Uint8Array(buf), { filter: (f) => { const e = extOf(f.name); return INBOX_EXT.has(e) || IMAGES.has(e) || /\.(txt|md|pdf)$/i.test(f.name); } }); } catch { return null; }
    const models = Object.keys(entries).filter((n) => INBOX_EXT.has(extOf(n)) && !n.endsWith('/'));
    if (!models.length) { ib.processed[key] = st.mtimeMs; saveSettings(); return null; }
    const dest = await uniquePath(path.join(target, path.basename(name, '.zip').replace(/[:*?"<>|]/g, '_')));
    for (const [n, data] of Object.entries(entries)) {
      if (n.endsWith('/') || n.startsWith('__MACOSX')) continue;
      const out = safeJoin(dest, n);
      if (!out.startsWith(dest + path.sep)) continue;
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await fsp.writeFile(out, data);
      if (INBOX_EXT.has(extOf(n))) added.push(toRel(out));
    }
  } else {
    const dst = await uniquePath(path.join(target, name));
    if (ib.mode === 'copy') await fsp.copyFile(abs, dst); else await moveFs(abs, dst);
    added.push(toRel(dst));
    const base = abs.slice(0, -path.extname(abs).length);
    for (const ie of IMAGES) {
      const img = `${base}.${ie}`;
      if (await exists(img)) { const d2 = dst.slice(0, -path.extname(dst).length) + '.' + ie; if (ib.mode === 'copy') await fsp.copyFile(img, d2); else await moveFs(img, d2); }
    }
  }
  ib.processed[key] = st.mtimeMs;
  const keys = Object.keys(ib.processed); if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete ib.processed[k];
  saveSettings();
  return added;
}
async function drainInbox() {
  if (inboxBusy) return;
  inboxBusy = true;
  try {
    while (inboxPending.size) {
      const abs = inboxPending.values().next().value;
      inboxPending.delete(abs);
      try {
        const added = await processInboxFile(abs);
        if (added && added.length && win) win.webContents.send('inbox:added', { file: path.basename(abs), added });
      } catch (e) { console.warn('inbox', abs, e); }
    }
  } finally { inboxBusy = false; }
}
async function scanInbox(includeExisting = false) {
  const ib = settings.inbox;
  let n = 0;
  for (const dir of ib.folders || []) {
    let names = []; try { names = await fsp.readdir(dir); } catch { continue; }
    for (const nm of names) {
      const abs = path.join(dir, nm);
      let st; try { st = await fsp.stat(abs); } catch { continue; }
      if (!st.isFile()) continue;
      if (!includeExisting && st.mtimeMs < (ib.enabledAt || 0)) continue;
      const e = extOf(nm);
      if (e === 'zip' || INBOX_EXT.has(e)) { inboxPending.add(abs); n++; }
    }
  }
  drainInbox();
  return n;
}
function startInbox() {
  for (const w of inboxWatchers) { try { w.close(); } catch {} }
  inboxWatchers = [];
  const ib = settings.inbox;
  if (!ib.folders) { ib.folders = defaultInboxFolders(); saveSettings(); }
  if (!ib.enabled || !root) return;
  for (const dir of ib.folders) {
    try {
      const w = fs.watch(dir, (ev, fname) => { if (fname) { inboxPending.add(path.join(dir, String(fname))); setTimeout(drainInbox, 800); } });
      w.on('error', () => {});
      inboxWatchers.push(w);
    } catch (e) { console.warn('inbox watch', dir, e.message); }
  }
  scanInbox(false);
}
handle('inbox:apply', async () => { startInbox(); return settings.inbox; });
handle('inbox:scanExisting', async () => scanInbox(true));
handle('inbox:pickFolder', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; });

// ---------- PDF oferty ----------
handle('pdf:save', async (html, defaultName) => {
  const r = process.env.MV_PDF_OUT ? { filePath: process.env.MV_PDF_OUT } : await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return null;
  const tmp = path.join(os.tmpdir(), `modelvault-oferta-${Date.now()}.html`);
  await fsp.writeFile(tmp, html, 'utf8');
  const pw = new BrowserWindow({ show: false, webPreferences: { offscreen: false, javascript: false } });
  try {
    await pw.loadFile(tmp);
    const pdf = await pw.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'none' } });
    await fsp.writeFile(r.filePath, pdf);
  } finally { pw.destroy(); fsp.rm(tmp, { force: true }).catch(() => {}); }
  if (!process.env.MV_PDF_OUT) shell.openPath(r.filePath);
  return r.filePath;
});

// ---------- aktualizacje ----------
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR || !!process.env.MV_PORTABLE || (app.isPackaged && !fs.existsSync(path.join(process.resourcesPath || '', 'app-update.yml')));
function sendUpdate(state, extra = {}) { win && win.webContents.send('update:status', { state, ...extra }); }
function setupUpdater() {
  if (!autoUpdater || !app.isPackaged || isPortable || process.platform !== 'win32') return false;
  autoUpdater.autoDownload = false;
  autoUpdater.on('update-available', (i) => sendUpdate('available', { version: i.version }));
  autoUpdater.on('update-not-available', () => sendUpdate('none'));
  autoUpdater.on('download-progress', (p) => sendUpdate('progress', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => sendUpdate('downloaded', { version: i.version }));
  autoUpdater.on('error', (e) => sendUpdate('error', { message: String(e && e.message || e) }));
  return true;
}
let updaterReady = false;
handle('update:check', async () => { if (!updaterReady) return { supported: false, version: app.getVersion() }; await autoUpdater.checkForUpdates(); return { supported: true, version: app.getVersion() }; });
handle('update:download', async () => { if (updaterReady) await autoUpdater.downloadUpdate(); return true; });
handle('update:install', async () => { if (updaterReady) autoUpdater.quitAndInstall(); return true; });
handle('app:version', async () => ({ version: app.getVersion(), updater: updaterReady, portable: isPortable, platform: process.platform }));

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 600,
    backgroundColor: '#14161a',
    title: 'ModelVault',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
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
app.commandLine.appendSwitch('lang', 'pl');

app.whenReady().then(async () => {
  loadConfig();
  loadSettings();
  const r = process.env.MV_ROOT || config.root;
  if (r && fs.existsSync(r)) await setRoot(r);
  createWindow();
  mergeDetected().catch(() => {});
  maybeAutoBackup();
  setInterval(maybeAutoBackup, 3600 * 1000);
  startInbox();
  updaterReady = setupUpdater();
  if (updaterReady && settings.updates.auto) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000);
});
app.on('window-all-closed', async () => { clearTimeout(saveTimer); try { await saveMetaNow(); } catch {} app.quit(); });
