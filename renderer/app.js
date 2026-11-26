import { Viewer, parseModel, renderThumbnail, computeStats, extract3mfThumbnail, setModelColor, slotGeomStats, PALETTE, VIEW_PRESETS } from './viewer.js';
import { gcodeColorInfo, hexDist } from './mc.js';
import { priceItems, slicerInfoFromGcode, slicerInfoFrom3mf, fmtMoney, fmtNum, fmtDuration, parseDuration } from './pricing.js';

const api = window.api;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const OTHER_EXT = new Set(['step', 'stp', 'scad', 'f3d', 'blend', 'bgcode', 'amf', 'fbx', 'glb', 'gltf', 'iges', 'igs', 'lys', 'chitubox', 'ctb']);

// ---------- state ----------
const ls = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let lib = null; // { root, folders, files, meta }
const st = {
  folder: ls.get('mv.folder', ''),
  special: ls.get('mv.special', 'all'), // all | fav | todo | printed | untagged | folder
  tag: null,
  search: '',
  format: ls.get('mv.format', 'all'),
  sort: ls.get('mv.sort', 'name'),
  recursive: ls.get('mv.recursive', true),
  expanded: new Set(ls.get('mv.expanded', [])),
};
let visible = [];
const sel = new Set();
let anchor = null;
let focused = null;
const thumbs = new Map(); // rel -> url | 'none'
let viewer = null;
let viewToken = 0;
let S = null; // ustawienia aplikacji (main/settings.json)

// ---------- ustawienia ----------
let settingsT = null;
function saveSettings() { clearTimeout(settingsT); settingsT = setTimeout(() => api.setSettings(S).catch((e) => toast(e.message, true)), 300); }
const P = () => S.pricing;
const cur = () => P().currency || 'zł';
const filamentById = (id) => S.filaments.find((x) => x.id === id) || null;
const defaultFilament = () => filamentById(P().defaultFilament) || S.filaments[0] || null;
const filLabel = (fl) => fl ? `${fl.name} – ${fl.color}` : 'brak filamentu';
const thumbVer = () => S.appearance.modelColor + '|mc2';
const swatch = (fl) => `<span class="sw" style="background:${fl ? esc(fl.hex || '#888') : 'transparent'}"></span>`;

// ---------- utils ----------
const fmtSize = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;
const fmtDate = (ms) => new Date(ms).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const baseName = (rel) => rel.split('/').pop();
const parentOf = (rel) => rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
const folderLabel = (rel) => rel === '' ? 'Biblioteka' : baseName(rel);
function tagColor(t) {
  let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 60% 62%)`;
}
const metaOf = (rel) => (lib && lib.meta[rel]) || {};

function toast(msg, err = false, action = null) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-btn'; b.textContent = action.label;
    b.onclick = () => { el.remove(); action.fn(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), err ? 5000 : action ? 7000 : 2600);
}
async function safe(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e.message || String(e), true); return undefined; }
}

// ---------- modal ----------
function modal(html, onReady) {
  return new Promise((resolve) => {
    const back = $('#modalBack'), box = $('#modal');
    box.innerHTML = html;
    back.hidden = false;
    const close = (v) => { back.hidden = true; box.innerHTML = ''; document.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    document.addEventListener('keydown', key, true);
    back.onmousedown = (e) => { if (e.target === back) close(null); };
    onReady(box, close);
  });
}
function promptModal(title, value = '', okLabel = 'OK', selectBase = false) {
  return modal(`<h3>${esc(title)}</h3><input class="field" id="mIn" spellcheck="false"><div class="btns"><button class="btn" id="mNo">Anuluj</button><button class="btn primary" id="mOk">${esc(okLabel)}</button></div>`, (box, close) => {
    const inp = box.querySelector('#mIn');
    inp.value = value;
    inp.focus();
    const dot = value.lastIndexOf('.');
    if (selectBase && dot > 0) inp.setSelectionRange(0, dot); else inp.select();
    box.querySelector('#mNo').onclick = () => close(null);
    box.querySelector('#mOk').onclick = () => close(inp.value.trim() || null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') close(inp.value.trim() || null); };
  });
}
function confirmModal(title, text, okLabel = 'Usuń') {
  return modal(`<h3>${esc(title)}</h3><p>${text}</p><div class="btns"><button class="btn" id="mNo">Anuluj</button><button class="btn primary" id="mOk">${esc(okLabel)}</button></div>`, (box, close) => {
    box.querySelector('#mOk').focus();
    box.querySelector('#mNo').onclick = () => close(false);
    box.querySelector('#mOk').onclick = () => close(true);
  });
}
function pickFolderModal(title, exclude = []) {
  const all = ['', ...lib.folders].filter((f) => !exclude.some((x) => f === x || f.startsWith(x + '/')));
  return modal(`<h3>${esc(title)}</h3><input class="field" id="mFilter" placeholder="Filtruj…" style="margin-bottom:8px"><div class="folder-pick" id="mList"></div><div class="btns"><button class="btn" id="mNo">Anuluj</button><button class="btn primary" id="mOk">Przenieś</button></div>`, (box, close) => {
    let chosen = null;
    const list = box.querySelector('#mList');
    const draw = (q) => {
      list.innerHTML = all.filter((f) => !q || f.toLowerCase().includes(q)).map((f) => `<div data-f="${esc(f)}" class="${f === chosen ? 'on' : ''}">${f === '' ? '/ (główny folder)' : esc(f)}</div>`).join('');
    };
    draw('');
    const flt = box.querySelector('#mFilter');
    flt.focus();
    flt.oninput = () => draw(flt.value.toLowerCase());
    list.onclick = (e) => { const d = e.target.closest('[data-f]'); if (!d) return; chosen = d.dataset.f; draw(flt.value.toLowerCase()); };
    list.ondblclick = (e) => { const d = e.target.closest('[data-f]'); if (d) close(d.dataset.f); };
    box.querySelector('#mNo').onclick = () => close(null);
    box.querySelector('#mOk').onclick = () => close(chosen);
  });
}

// ---------- context menu ----------
function ctxMenu(x, y, items) {
  const el = $('#ctx');
  el.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<div class="it ${it.danger ? 'danger' : ''}" data-i="${i}"><span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</div>`).join('');
  el.hidden = false;
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  el.onclick = (e) => { const d = e.target.closest('[data-i]'); if (!d) return; el.hidden = true; items[+d.dataset.i].action(); };
}
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctx')) $('#ctx').hidden = true; });

// ---------- loading ----------
async function reload() {
  const data = await safe(() => api.getLibrary());
  if (data === undefined) return;
  lib = data;
  if (lib) {
    if (st.folder && !lib.folders.includes(st.folder)) st.folder = '';
    for (const r of [...sel]) if (!lib.files.some((f) => f.rel === r)) sel.delete(r);
    if (focused && !lib.files.some((f) => f.rel === focused)) focused = null;
  }
  renderAll();
}
let reloadTimer = null;
api.onChanged(() => { clearTimeout(reloadTimer); reloadTimer = setTimeout(reload, 150); });

function renderAll() {
  $('#libPathText').textContent = lib ? lib.root : 'Wybierz folder biblioteki…';
  $('#libPath').title = lib ? `${lib.root}\nKliknij, aby zmienić folder` : '';
  renderSidebar();
  renderGrid();
  renderDetail();
}

// ---------- filtering ----------
function computeVisible() {
  if (!lib) return [];
  const q = st.search.trim().toLowerCase();
  let list = lib.files.filter((f) => {
    const m = lib.meta[f.rel] || {};
    if (st.special === 'folder') {
      if (st.recursive ? !(f.dir === st.folder || (st.folder === '' ) || f.dir.startsWith(st.folder + '/')) : f.dir !== st.folder) return false;
    }
    if (st.special === 'order' && !order().items.some((i) => i.rel === f.rel)) return false;
    if (st.special === 'dups' && !dupState.byRel.has(f.rel)) return false;
    if (st.special === 'coll' && !(m.collections || []).includes(st.coll)) return false;
    if (['orders', 'stock', 'clients', 'queue'].includes(st.special)) return false;
    if (st.special === 'fav' && !m.favorite) return false;
    if (st.special === 'todo' && m.status !== 'todo') return false;
    if (st.special === 'printed' && m.status !== 'printed') return false;
    if (st.special === 'untagged' && m.tags && m.tags.length) return false;
    if (st.tag && !(m.tags || []).includes(st.tag)) return false;
    if (st.format !== 'all') {
      if (st.format === 'other' ? !OTHER_EXT.has(f.ext) : f.ext !== st.format) return false;
    }
    if (q) {
      const hay = `${f.rel} ${(m.tags || []).join(' ')} ${m.notes || ''} ${m.source || ''}`.toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name, 'pl', { numeric: true, sensitivity: 'base' }),
    date: (a, b) => b.mtime - a.mtime,
    size: (a, b) => b.size - a.size,
    ext: (a, b) => a.ext.localeCompare(b.ext) || a.name.localeCompare(b.name, 'pl', { numeric: true }),
  }[st.sort];
  if (st.special === 'dups') return list.sort((a, b) => dupState.byRel.get(a.rel) - dupState.byRel.get(b.rel) || a.rel.localeCompare(b.rel));
  return list.sort(cmp);
}

// ---------- sidebar ----------
function setView(patch) {
  Object.assign(st, patch);
  ls.set('mv.folder', st.folder); ls.set('mv.special', st.special);
  renderSidebar(); renderGrid();
}

function renderSidebar() {
  const sp = $('#specials');
  const tree = $('#tree');
  const tagsEl = $('#tagsList');
  if (!lib) { sp.innerHTML = ''; tree.innerHTML = '<div class="muted-note">Brak biblioteki</div>'; tagsEl.innerHTML = ''; return; }
  const cnt = { all: lib.files.length, fav: 0, todo: 0, printed: 0, untagged: 0 };
  const tagCount = new Map();
  for (const f of lib.files) {
    const m = lib.meta[f.rel] || {};
    if (m.favorite) cnt.fav++;
    if (m.status === 'todo') cnt.todo++;
    if (m.status === 'printed') cnt.printed++;
    if (!m.tags || !m.tags.length) cnt.untagged++;
    for (const t of m.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  }
  const items = [['all', '◫', 'Wszystkie modele'], ['fav', '★', 'Ulubione'], ['todo', '◷', 'Do wydruku'], ['printed', '✓', 'Wydrukowane'], ['untagged', '◌', 'Bez tagów'], ['dups', '⧉', 'Duplikaty']];
  const inboxRel = S.inbox && S.inbox.target;
  if (inboxRel && (S.inbox.enabled || lib.folders.includes(inboxRel))) {
    items.unshift(['inbox', '⇣', 'Do posortowania']);
    cnt.inbox = lib.files.filter((f) => f.dir === inboxRel || f.dir.startsWith(inboxRel + '/')).length;
  }
  cnt.dups = dupState.groups ? dupState.groups.reduce((a, g) => a + g.length, 0) : '';
  sp.innerHTML = items.map(([k, ico, label]) => `<div class="nav-item ${st.special === k ? 'active' : ''}" data-sp="${k}"><span class="ico">${ico}</span>${label}<span class="count">${cnt[k]}</span></div>`).join('');
  sp.querySelectorAll('[data-sp]').forEach((el) => el.onclick = () => el.dataset.sp === 'inbox' ? setView({ special: 'folder', folder: S.inbox.target }) : setView({ special: el.dataset.sp }));
  const ibItem = sp.querySelector('[data-sp="inbox"]'); if (ibItem) { ibItem.classList.toggle('active', st.special === 'folder' && st.folder === S.inbox.target); ibItem.classList.add('inbox-item'); }
  // kolekcje
  const collEl = $('#colls');
  const ccount = new Map();
  for (const f of lib.files) for (const id of (lib.meta[f.rel] || {}).collections || []) ccount.set(id, (ccount.get(id) || 0) + 1);
  collEl.innerHTML = collections().length ? collections().map((c) => `<div class="nav-item ${st.special === 'coll' && st.coll === c.id ? 'active' : ''}" data-coll="${esc(c.id)}"><span class="cdot" style="background:${esc(c.color)}"></span>${esc(c.name)}<span class="count">${ccount.get(c.id) || 0}</span></div>`).join('') : '<div class="muted-note">Przeciągnij modele na kolekcję albo użyj „+”</div>';
  collEl.querySelectorAll('[data-coll]').forEach((el) => {
    const c = collections().find((x) => x.id === el.dataset.coll);
    el.onclick = () => setView({ special: 'coll', coll: c.id });
    el.oncontextmenu = (e) => { e.preventDefault(); collectionMenu(c, e.clientX, e.clientY); };
    el.addEventListener('dragover', (e) => { if (dragPayload?.kind === 'files') { e.preventDefault(); el.classList.add('drop-hover'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drop-hover'); if (dragPayload?.kind === 'files') addToCollection(c.id, dragPayload.rels); });
  });
  $('#queueNav').classList.toggle('active', st.special === 'queue');
  $('#clientsNav').classList.toggle('active', st.special === 'clients');
  $('#queueCount').textContent = S.orders.filter((o) => o.status === 'printing').length || '';
  $('#clientsCount').textContent = (S.clients || []).length || '';
  $('#orderNav').classList.toggle('active', st.special === 'order');
  $('#ordersNav').classList.toggle('active', st.special === 'orders');
  $('#stockNav').classList.toggle('active', st.special === 'stock');
  updateOrderCount(); updateOrdersCount(); updateStockCount();

  // drzewo
  const counts = new Map();
  for (const f of lib.files) {
    let d = f.dir;
    counts.set('', (counts.get('') || 0) + 1);
    while (d) { counts.set(d, (counts.get(d) || 0) + 1); d = parentOf(d); }
  }
  const children = new Map();
  for (const f of lib.folders) { const p = parentOf(f); if (!children.has(p)) children.set(p, []); children.get(p).push(f); }
  const row = (rel, depth) => {
    const kids = children.get(rel) || [];
    const open = rel === '' || st.expanded.has(rel);
    const active = st.special === 'folder' && st.folder === rel;
    let h = `<div class="tree-row ${active ? 'active' : ''}" data-folder="${esc(rel)}" ${rel ? 'draggable="true"' : ''}>
      <span class="caret ${kids.length ? (open ? 'open' : '') : 'none'}" data-caret>▶</span><span class="fold"></span>
      <span class="tlabel">${esc(folderLabel(rel))}</span><span class="count">${counts.get(rel) || 0}</span></div>`;
    if (kids.length && open) h += `<div class="tree-children">${kids.map((k) => row(k, depth + 1)).join('')}</div>`;
    return h;
  };
  tree.innerHTML = row('', 0);
  tree.querySelectorAll('.tree-row').forEach((el) => {
    const rel = el.dataset.folder;
    el.onclick = (e) => {
      if (e.target.dataset.caret !== undefined && rel !== '') {
        st.expanded.has(rel) ? st.expanded.delete(rel) : st.expanded.add(rel);
        ls.set('mv.expanded', [...st.expanded]);
        renderSidebar(); return;
      }
      setView({ special: 'folder', folder: rel });
    };
    el.ondblclick = () => { if (rel) { st.expanded.has(rel) ? st.expanded.delete(rel) : st.expanded.add(rel); ls.set('mv.expanded', [...st.expanded]); renderSidebar(); } };
    el.oncontextmenu = (e) => { e.preventDefault(); folderMenu(rel, e.clientX, e.clientY); };
    makeDropTarget(el, rel);
    if (rel) el.ondragstart = (e) => startDrag(e, [rel], 'folder');
  });

  // tagi
  const tags = [...tagCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pl'));
  tagsEl.innerHTML = tags.length ? tags.map(([t, n]) => `<span class="tag ${st.tag === t ? 'active' : ''}" data-tag="${esc(t)}"><span class="dot" style="background:${tagColor(t)}"></span>${esc(t)} <small>${n}</small></span>`).join('')
    : '<div class="muted-note">Dodaj tagi w panelu po prawej</div>';
  tagsEl.querySelectorAll('[data-tag]').forEach((el) => el.onclick = () => setView({ tag: st.tag === el.dataset.tag ? null : el.dataset.tag }));
}

function folderMenu(rel, x, y) {
  const items = [
    { label: 'Nowy podfolder…', action: () => newFolder(rel) },
  ];
  if (rel) {
    items.push({ label: 'Zmień nazwę…', hint: 'F2', action: () => renameItem(rel, true) });
    items.push({ label: 'Przenieś do…', action: async () => { const d = await pickFolderModal(`Przenieś folder „${baseName(rel)}”`, [rel]); if (d !== null) await moveItems([rel], d); } });
  }
  items.push('-', { label: 'Pokaż w Eksploratorze', action: () => rel ? api.reveal(rel) : api.openRoot() });
  if (rel) items.push('-', { label: 'Usuń folder (do Kosza)', danger: true, action: () => trashItems([rel], true) });
  ctxMenu(x, y, items);
}

// ---------- drag & drop ----------
let dragPayload = null;
function startDrag(e, rels, kind) {
  dragPayload = { rels, kind };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-modelvault', JSON.stringify(rels));
  const g = $('#dragGhost');
  g.textContent = kind === 'folder' ? `📁 ${baseName(rels[0])}` : rels.length === 1 ? baseName(rels[0]) : `${rels.length} pliki`;
  e.dataTransfer.setDragImage(g, -10, -10);
}
document.addEventListener('dragend', () => { dragPayload = null; document.querySelectorAll('.dragging').forEach((c) => c.classList.remove('dragging')); });

function makeDropTarget(el, destRel) {
  el.addEventListener('dragover', (e) => {
    const internal = e.dataTransfer.types.includes('application/x-modelvault');
    const external = e.dataTransfer.types.includes('Files');
    if (!internal && !external) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = internal ? 'move' : 'copy';
    el.classList.add('drop-hover');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('drop-hover');
    $('#dropOverlay').hidden = true;
    const raw = e.dataTransfer.getData('application/x-modelvault');
    if (raw) await moveItems(JSON.parse(raw), destRel);
    else if (e.dataTransfer.files.length) await importDropped(e.dataTransfer.files, destRel);
  });
}

async function importDropped(fileList, destRel) {
  const paths = [...fileList].map((f) => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const r = await safe(() => api.importFiles(paths, destRel));
  if (r) { toast(`Skopiowano ${r.length} ${r.length === 1 ? 'element' : 'elementy'} do „${folderLabel(destRel)}”`); await reload(); }
}

// zewnętrzne pliki upuszczone na siatkę -> bieżący folder
const mainEl = $('#main');
let dragDepth = 0;
mainEl.addEventListener('dragenter', (e) => {
  if (!lib || !e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-modelvault')) return;
  dragDepth++;
  $('#dropTarget').textContent = folderLabel(currentDropFolder());
  $('#dropOverlay').hidden = false;
});
mainEl.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
mainEl.addEventListener('dragover', (e) => { if (lib && e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
mainEl.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true;
  if (!lib || e.dataTransfer.types.includes('application/x-modelvault')) return;
  if (e.dataTransfer.files.length) await importDropped(e.dataTransfer.files, currentDropFolder());
});
const currentDropFolder = () => st.special === 'folder' ? st.folder : '';

// ---------- operacje ----------
async function moveItems(rels, dest) {
  rels = rels.filter((r) => parentOf(r) !== dest && r !== dest);
  if (!rels.length) return;
  const moved = await safe(() => api.move(rels, dest));
  if (!moved) return;
  const wasSel = rels.filter((r) => sel.has(r));
  rels.forEach((r) => sel.delete(r));
  if (focused && rels.includes(focused)) focused = moved[rels.indexOf(focused)] || null;
  wasSel.forEach((r) => { const i = rels.indexOf(r); if (moved[i]) sel.add(moved[i]); });
  toast(`Przeniesiono ${moved.length} → ${folderLabel(dest)}`);
  // zachowaj miniatury
  rels.forEach((r, i) => { if (thumbs.has(r) && moved[i]) thumbs.set(moved[i], thumbs.get(r)); if (moved[i]) remapOrder(r, moved[i]); });
  await reload();
}
async function renameItem(rel, isFolder) {
  const name = await promptModal(isFolder ? 'Zmień nazwę folderu' : 'Zmień nazwę pliku', baseName(rel), 'Zmień', !isFolder);
  if (!name || name === baseName(rel)) return;
  const nr = await safe(() => api.rename(rel, name));
  if (!nr) return;
  remapOrder(rel, nr);
  if (isFolder) {
    if (st.folder === rel || st.folder.startsWith(rel + '/')) st.folder = nr + st.folder.slice(rel.length);
    if (st.expanded.has(rel)) { st.expanded.delete(rel); st.expanded.add(nr); ls.set('mv.expanded', [...st.expanded]); }
  } else {
    if (sel.has(rel)) { sel.delete(rel); sel.add(nr); }
    if (focused === rel) focused = nr;
  }
  await reload();
}
async function newFolder(parent) {
  const name = await promptModal(`Nowy folder w „${folderLabel(parent)}”`, '', 'Utwórz');
  if (!name) return;
  const r = await safe(() => api.createFolder(parent, name));
  if (r) { if (parent) { st.expanded.add(parent); ls.set('mv.expanded', [...st.expanded]); } await reload(); }
}
async function trashItems(rels, isFolder) {
  if (!rels.length) return;
  const what = isFolder ? `folder „${esc(baseName(rels[0]))}” razem z zawartością` : rels.length === 1 ? `„${esc(baseName(rels[0]))}”` : `${rels.length} pliki`;
  if (!(await confirmModal('Przenieść do Kosza?', `Przeniesiesz ${what} do Kosza systemu. Możesz to przywrócić z Kosza.`, 'Do Kosza'))) return;
  const ok = await safe(() => api.trash(rels));
  if (!ok) return;
  rels.forEach((r) => sel.delete(r));
  if (rels.includes(focused)) focused = null;
  if (isFolder && (st.folder === rels[0] || st.folder.startsWith(rels[0] + '/'))) st.folder = parentOf(rels[0]);
  toast('Przeniesiono do Kosza');
  await reload();
}
async function setMeta(rel, patch) {
  const m = await safe(() => api.setMeta(rel, patch));
  if (m === undefined) return;
  if (m) lib.meta[rel] = m; else delete lib.meta[rel];
}
async function setMetaMany(rels, fn) {
  for (const r of rels) await setMeta(r, fn(metaOf(r)));
  renderSidebar(); renderGrid(); renderDetail();
}

// ---------- grid ----------
const io = new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); requestThumb(en.target.dataset.rel, true); }
}, { root: $('#grid'), rootMargin: '300px' });

function renderGrid() {
  const grid = $('#grid'), empty = $('#empty');
  const VIEWS = ['order', 'orders', 'stock', 'clients', 'queue'];
  const view = (lib || st.special === 'stock' || st.special === 'clients') && VIEWS.includes(st.special) ? st.special : null;
  for (const v of VIEWS) $('#' + v).hidden = view !== v;
  grid.hidden = !!view;
  $('#crumbs').hidden = !!view && view !== 'order';
  if (view) {
    io.disconnect(); empty.hidden = true; visible = computeVisible(); renderCrumbs();
    ({ order: renderOrder, orders: renderOrders, stock: renderStock, clients: renderClients, queue: renderQueue })[view]();
    return;
  }
  if (st.special === 'dups' && lib) {
    computeDups();
    if (dupState.computing || !dupState.groups) { grid.innerHTML = ''; renderCrumbs(); empty.hidden = false; empty.innerHTML = '<div><span class="spin" style="display:inline-block;width:22px;height:22px;border:2px solid var(--line-2);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite"></span><br><br>Porównuję zawartość plików…</div>'; return; }
  }
  io.disconnect();
  visible = computeVisible();
  renderCrumbs();
  if (!lib) {
    grid.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = `<div><div class="welcome-art"></div><div class="big">Witaj w ModelVault</div>Wskaż folder, w którym trzymasz modele do druku 3D.<br>Podfoldery staną się kategoriami — wszystko dalej działa też w Eksploratorze.<br><button class="btn primary" id="chooseBtn">Wybierz folder biblioteki</button></div>`;
    $('#chooseBtn').onclick = chooseLibrary;
    return;
  }
  empty.hidden = visible.length > 0;
  if (!visible.length) empty.innerHTML = st.special === 'dups' ? '<div><div class="big">Brak duplikatów</div>Nie znalazłem plików o identycznej zawartości.</div>' : `<div><div class="big">Pusto</div>${st.search || st.tag || st.format !== 'all' ? 'Nic nie pasuje do filtrów.' : 'Przeciągnij tu pliki STL / 3MF / OBJ / G-code, aby je dodać.'}</div>`;
  grid.innerHTML = visible.map((f) => {
    const m = lib.meta[f.rel] || {};
    const t = thumbs.get(f.rel);
    const img = t && t !== 'none' ? `<img src="${t}" class="${f.image ? 'photo' : ''}" draggable="false">` : t === 'none' ? `<span class="ph">${esc(f.ext)}</span>` : '<span class="spin"></span>';
    const dg = st.special === 'dups' ? dupState.byRel.get(f.rel) : undefined;
    const col = ls.get(colorsKey(f), null);
    const nCol = col && col.slots ? col.slots.length : 1;
    const flags = `${dg !== undefined ? `<span class="flag dup">#${dg + 1}</span>` : ''}${nCol > 1 ? `<span class="flag mc" title="${nCol} kolory">${(col.slots.slice(0, 4).map((x, i) => `<i style="background:${esc(x.hex || PALETTE[i % PALETTE.length])}"></i>`).join(''))}</span>` : ''}${m.source ? '<span class="flag src" title="Ma link do źródła">↗</span>' : ''}${m.favorite ? '<span class="flag fav">★</span>' : ''}${m.status === 'todo' ? '<span class="flag todo">◷</span>' : ''}${m.status === 'printed' ? '<span class="flag printed">✓</span>' : ''}`;
    const dots = (m.tags || []).slice(0, 5).map((tg) => `<i style="background:${tagColor(tg)}" title="${esc(tg)}"></i>`).join('');
    return `<div class="card ${sel.has(f.rel) ? 'sel' : ''}" data-rel="${esc(f.rel)}" draggable="true" title="${esc(f.rel)}">
      <div class="thumb">${img}<div class="badges"><span class="ext ${esc(f.ext)}">${esc(f.ext)}</span><span class="flags">${flags}</span></div></div>
      <div class="info"><div class="name">${esc(f.name.replace(/\.[^.]+$/, ''))}</div><div class="sub"><span>${fmtSize(f.size)}</span>${st.special !== 'folder' || st.recursive ? `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.dir ? baseName(f.dir) : '')}</span>` : ''}<span class="dots">${dots}</span></div></div>
    </div>`;
  }).join('');
  grid.querySelectorAll('.card').forEach((c) => { if (!thumbs.has(c.dataset.rel)) io.observe(c); });
}

function renderCrumbs() {
  const el = $('#crumbs');
  if (!lib) { el.innerHTML = ''; return; }
  let h = '';
  if (st.special === 'folder') {
    const parts = st.folder ? st.folder.split('/') : [];
    h += `<span class="c ${parts.length ? '' : 'cur'}" data-c="">Biblioteka</span>`;
    parts.forEach((p, i) => { const rel = parts.slice(0, i + 1).join('/'); h += `<span class="sep">/</span><span class="c ${i === parts.length - 1 ? 'cur' : ''}" data-c="${esc(rel)}">${esc(p)}</span>`; });
    h += `<label><input type="checkbox" id="recur" ${st.recursive ? 'checked' : ''}>z podfolderami</label>`;
  } else {
    const names = { all: 'Wszystkie modele', fav: 'Ulubione', todo: 'Do wydruku', printed: 'Wydrukowane', untagged: 'Bez tagów', order: 'Wycena zamówienia', dups: 'Duplikaty', orders: 'Zamówienia', stock: 'Magazyn', inbox: 'Do posortowania' };
    if (st.special === 'coll') { const c = collections().find((x) => x.id === st.coll); names.coll = c ? `Kolekcja: ${c.name}` : 'Kolekcja'; }
    h += `<span class="c cur">${names[st.special]}</span>`;
  }
  if (st.tag) h += `<span class="sep">·</span><span class="tag active" id="clearTag"><span class="dot" style="background:${tagColor(st.tag)}"></span>${esc(st.tag)} <span class="x">✕</span></span>`;
  if (st.special === 'dups' && dupState.groups) {
    const waste = dupState.groups.reduce((a, g) => a + g[0].size * (g.length - 1), 0);
    h += `<span class="sep">·</span><span class="muted-note" style="padding:0">${dupState.groups.length} grup identycznych plików · do odzyskania ${fmtSize(waste)}</span>`;
  }
  h += `<span class="info">${visible.length} ${visible.length === 1 ? 'model' : 'modeli'}${sel.size > 1 ? ` · zaznaczono ${sel.size}` : ''}</span>`;
  el.innerHTML = h;
  el.querySelectorAll('[data-c]').forEach((c) => {
    c.onclick = () => setView({ special: 'folder', folder: c.dataset.c });
    makeDropTarget(c, c.dataset.c);
  });
  const rc = $('#recur'); if (rc) rc.onchange = () => { st.recursive = rc.checked; ls.set('mv.recursive', st.recursive); renderGrid(); };
  const ct = $('#clearTag'); if (ct) ct.onclick = () => setView({ tag: null });
}

function updateSelectionClasses() {
  document.querySelectorAll('#grid .card').forEach((c) => c.classList.toggle('sel', sel.has(c.dataset.rel)));
  const info = document.querySelector('#crumbs .info');
  if (info) info.textContent = `${visible.length} ${visible.length === 1 ? 'model' : 'modeli'}${sel.size > 1 ? ` · zaznaczono ${sel.size}` : ''}`;
}

const grid = $('#grid');
grid.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) { if (e.target === grid) { sel.clear(); focused = null; updateSelectionClasses(); renderDetail(); } return; }
  selectCard(card.dataset.rel, e);
});
grid.addEventListener('dblclick', (e) => { const card = e.target.closest('.card'); if (card) openDefault([card.dataset.rel]); });
grid.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card'); if (!card) return;
  const rel = card.dataset.rel;
  if (!sel.has(rel)) { sel.clear(); sel.add(rel); focused = rel; updateSelectionClasses(); renderDetail(); }
  document.querySelectorAll('#grid .card.sel').forEach((c) => c.classList.add('dragging'));
  startDrag(e, [...sel], 'files');
});
grid.addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.card');
  e.preventDefault();
  if (!card) { if (lib) folderMenu(currentDropFolder(), e.clientX, e.clientY); return; }
  const rel = card.dataset.rel;
  if (!sel.has(rel)) { sel.clear(); sel.add(rel); focused = rel; updateSelectionClasses(); renderDetail(); }
  const rels = [...sel];
  const one = rels.length === 1;
  const items = [];
  items.push(...openMenuItems(rels));
  items.push('-');
  if (one) items.push({ label: 'Pokaż w Eksploratorze', action: () => api.reveal(rel) });
  items.push({ label: 'Przenieś do…', action: async () => { const d = await pickFolderModal(one ? `Przenieś „${baseName(rel)}”` : `Przenieś ${rels.length} pliki`); if (d !== null) await moveItems(rels, d); } });
  if (one) items.push({ label: 'Zmień nazwę…', hint: 'F2', action: () => renameItem(rel, false) });
  items.push('-');
  const allFav = rels.every((r) => metaOf(r).favorite);
  items.push({ label: allFav ? 'Usuń z ulubionych' : 'Dodaj do ulubionych', hint: 'F', action: () => setMetaMany(rels, () => ({ favorite: !allFav })) });
  items.push({ label: 'Oznacz: do wydruku', action: () => setStatus(rels, 'todo') });
  items.push({ label: 'Oznacz: wydrukowane', action: () => setStatus(rels, 'printed') });
  items.push({ label: 'Dodaj tag…', action: () => bulkTag(rels) });
  items.push({ label: 'Dodaj do wyceny', action: () => addToOrder(rels) });
  items.push({ label: 'Dodaj do kolekcji…', action: () => pickCollectionModal(rels) });
  if (st.special === 'coll') items.push({ label: 'Usuń z tej kolekcji', action: () => removeFromCollection(st.coll, rels) });
  if (one) items.push({ label: 'Odśwież miniaturę', action: () => { thumbs.delete(rel); requestThumb(rel, true, true); } });
  items.push('-', { label: 'Usuń (do Kosza)', hint: 'Del', danger: true, action: () => trashItems(rels, false) });
  ctxMenu(e.clientX, e.clientY, items);
});

function selectCard(rel, e) {
  if (e && (e.ctrlKey || e.metaKey)) { sel.has(rel) ? sel.delete(rel) : sel.add(rel); anchor = rel; }
  else if (e && e.shiftKey && anchor) {
    const a = visible.findIndex((f) => f.rel === anchor), b = visible.findIndex((f) => f.rel === rel);
    if (a >= 0 && b >= 0) { sel.clear(); for (let i = Math.min(a, b); i <= Math.max(a, b); i++) sel.add(visible[i].rel); }
  } else { sel.clear(); sel.add(rel); anchor = rel; }
  focused = sel.has(rel) ? rel : [...sel].pop() || null;
  updateSelectionClasses();
  renderDetail();
  document.querySelector(`#grid .card[data-rel="${CSS.escape(rel)}"]`)?.scrollIntoView({ block: 'nearest' });
}

async function bulkTag(rels) {
  const t = await promptModal(`Dodaj tag do ${rels.length} ${rels.length === 1 ? 'pliku' : 'plików'}`, '', 'Dodaj');
  if (!t) return;
  const tags = t.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  await setMetaMany(rels, (m) => ({ tags: [...new Set([...(m.tags || []), ...tags])] }));
}

// ---------- miniatury ----------
const queue = [];
let busy = false;
function refreshCardFlags(rel) {
  const card = document.querySelector(`#grid .card[data-rel="${CSS.escape(rel)}"] .flags`);
  const f = lib && lib.files.find((x) => x.rel === rel);
  if (!card || !f || card.querySelector('.mc')) return;
  const col = ls.get(colorsKey(f), null);
  if (col && col.slots && col.slots.length > 1) card.insertAdjacentHTML('afterbegin', `<span class="flag mc" title="${col.slots.length} kolory">${col.slots.slice(0, 4).map((x, i) => `<i style="background:${esc(x.hex || PALETTE[i % PALETTE.length])}"></i>`).join('')}</span>`);
}
function setCardThumb(rel) {
  refreshCardFlags(rel);
  const ot = document.querySelector(`#order tr[data-rel="${CSS.escape(rel)}"] .o-thumb`);
  const tv = thumbs.get(rel);
  if (ot && tv && tv !== 'none') ot.innerHTML = `<img src="${tv}">`;
  const card = document.querySelector(`#grid .card[data-rel="${CSS.escape(rel)}"] .thumb`);
  if (!card) return;
  const t = thumbs.get(rel);
  const f = lib.files.find((x) => x.rel === rel);
  const old = card.querySelector('img, .ph, .spin');
  const el = t && t !== 'none' ? Object.assign(document.createElement('img'), { src: t, className: f && f.image ? 'photo' : '', draggable: false }) : Object.assign(document.createElement('span'), { className: 'ph', textContent: f ? f.ext : '' });
  old ? old.replaceWith(el) : card.prepend(el);
}
async function requestThumb(rel, priority, force = false) {
  const f = lib && lib.files.find((x) => x.rel === rel);
  if (!f) return;
  if (!force && thumbs.has(rel)) return setCardThumb(rel);
  if (f.image) {
    const url = await api.readImage(f.image).catch(() => null);
    thumbs.set(rel, url || 'none'); return setCardThumb(rel);
  }
  if (!force) {
    const cached = await api.getThumb(f.rel, f.mtime, f.size, thumbKeyFor(f)).catch(() => null);
    if (cached) { thumbs.set(rel, cached); return setCardThumb(rel); }
  }
  if (!f.viewable || f.size > 150 * 1048576) { thumbs.set(rel, 'none'); return setCardThumb(rel); }
  if (!queue.includes(rel)) priority ? queue.unshift(rel) : queue.push(rel);
  pump();
}
function gcodeThumb(buf) {
  const head = new TextDecoder().decode(buf.slice(0, Math.min(buf.byteLength, 2_000_000)));
  const re = /; thumbnail(?:_PNG)? begin (\d+)x(\d+) \d+\r?\n([\s\S]*?); thumbnail(?:_PNG)? end/g;
  let best = null, m;
  while ((m = re.exec(head))) { const area = +m[1] * +m[2]; if (!best || area > best.area) best = { area, data: m[3].replace(/[;\s]/g, '') }; }
  return best ? 'data:image/png;base64,' + best.data : null;
}
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const rel = queue.shift();
    const f = lib && lib.files.find((x) => x.rel === rel);
    if (!f) continue;
    let url = null;
    try {
      const buf = await api.readFile(rel);
      if (f.ext === '3mf') url = extract3mfThumbnail(buf);
      if (f.ext === 'gcode') url = gcodeThumb(buf);
      if (!url) {
        await new Promise((r) => setTimeout(r, 0));
        const parsed = parseModel(f.ext, buf);
        try { storeParsedAnalysis(f, parsed); } catch (e) { console.warn(e); }
        url = renderThumbnail(parsed, 320, slotColors(f, true), thumbSpecFor(f));
      }
      if (url) api.putThumb(f.rel, f.mtime, f.size, thumbKeyFor(f), url).catch(() => {});
    } catch (e) { console.warn('thumb', rel, e); }
    thumbs.set(rel, url || 'none');
    setCardThumb(rel);
  }
  busy = false;
}

// ---------- dane do wyceny (gramy / czas / filament / kolory) ----------
function statsKey(f) { return `mv.stats3:${f.rel}:${f.mtime}:${f.size}`; }
const slicerKey = (f) => `mv.slicer2:${f.rel}:${f.mtime}:${f.size}`;
const colorsKey = (f) => `mv.colors2:${f.rel}:${f.mtime}:${f.size}`;

function nearestFilament(hex) {
  if (!hex) return null;
  let best = null, bd = Infinity;
  for (const fl of S.filaments) { if (!fl.hex) continue; const d = hexDist(hex, fl.hex); if (d < bd) { bd = d; best = fl; } }
  return bd < 180 ? best : null;
}
/** Kolory slotów do podglądu/miniatur */
function slotColors(f, forThumb = false) {
  const c = ls.get(colorsKey(f), null);
  const slots = c && c.slots && c.slots.length ? c.slots : [{}];
  const multi = slots.length > 1;
  const d = forThumb ? null : printData(f);
  return slots.map((sl, i) => {
    if (!forThumb && S.appearance.useFilamentColor && d.parts[i] && (d.parts[i].filamentSet || (multi && d.parts[i].auto)) && d.parts[i].filament?.hex) return d.parts[i].filament.hex;
    if (multi) return sl.hex || PALETTE[i % PALETTE.length];
    return S.appearance.modelColor;
  });
}

/** Liczba zmian koloru z zakresów wysokości slotów: w każdej warstwie (k kolorów) – k-1 zmian. */
function estimateChanges(slots) {
  const geo = slots.filter((s) => Number.isFinite(s.zMin) && Number.isFinite(s.zMax) && s.zMax > s.zMin);
  if (geo.length < 2) return { changes: 0, presence: slots.map(() => 0) };
  const lh = Math.max(0.05, Number(P().layerHeight) || 0.2);
  const z0 = Math.min(...geo.map((s) => s.zMin)), z1 = Math.max(...geo.map((s) => s.zMax));
  const layers = Math.min(20000, Math.ceil((z1 - z0) / lh));
  let changes = 0;
  const presence = slots.map(() => 0);
  for (let L = 0; L < layers; L++) {
    const z = z0 + (L + 0.5) * lh;
    let k = 0;
    slots.forEach((s, i) => { if (Number.isFinite(s.zMin) && z >= s.zMin && z <= s.zMax) { k++; presence[i]++; } });
    if (k > 1) changes += k - 1;
  }
  return { changes, presence };
}

/**
 * Dane do wyceny pliku. Zwraca:
 * { parts:[{slot, name, fileHex, filament, filamentSet, auto, grams, gramsSrc}], grams, minutes, gramsSrc, minutesSrc,
 *   multi, changes, purgeG, changeMin, filament (pierwszy), filamentSet }
 */
function printData(f) {
  const m = metaOf(f.rel).print || {};
  const col = ls.get(colorsKey(f), null);
  const slots = col && col.slots && col.slots.length ? col.slots : [{ key: 's0', name: '', hex: null }];
  const multi = slots.length > 1;
  const sl = ls.get(slicerKey(f), null);
  let stats = ls.get(statsKey(f), null); if (stats && stats.failed) stats = null;
  const p = P();

  // filament per slot
  const parts = slots.map((s, i) => {
    const ov = (m.slots && m.slots[i]) || {};
    const setId = ov.filamentId || (i === 0 ? m.filamentId : null);
    let filament = filamentById(setId), filamentSet = !!filament, auto = false;
    if (!filament && multi) { filament = nearestFilament(s.hex); auto = !!filament; }
    if (!filament) filament = defaultFilament();
    return { slot: i, name: s.name || (multi ? `Kolor ${i + 1}` : ''), fileHex: s.hex || null, filament, filamentSet, auto, grams: null, gramsSrc: null, manual: ov.grams != null ? ov.grams : null };
  });
  const density = parts[0].filament ? Number(parts[0].filament.density) || 1.24 : 1.24;

  // czas / zmiany koloru
  let changes = 0, changeSrc = null, presence = slots.map(() => 1);
  if (multi) {
    if (col && Number.isFinite(col.toolChanges) && col.toolChanges > 0) { changes = col.toolChanges; changeSrc = 'G-code'; }
    else { const e = estimateChanges(slots); changes = e.changes; presence = e.presence; changeSrc = 'szacunek'; }
  }

  // gramy per slot
  const perSlot = col && col.perSlotGrams && col.perSlotGrams.some((x) => x != null) ? col.perSlotGrams : null;
  let purgeG = 0;
  if (!multi) {
    const pt = parts[0];
    if (m.grams != null) { pt.grams = m.grams; pt.gramsSrc = 'ręcznie'; }
    else if (sl && sl.grams != null) { pt.grams = sl.grams; pt.gramsSrc = sl.source; }
    else if (sl && sl.lengthMm != null) { pt.grams = sl.lengthMm * Math.PI * 0.875 * 0.875 / 1000 * density; pt.gramsSrc = sl.source; }
    else if (stats && stats.volume) { pt.grams = stats.volume * density * p.estFill; pt.gramsSrc = 'szacunek'; }
  } else {
    // udziały z geometrii
    const total = (sl && sl.grams != null) ? sl.grams : (stats && stats.volume ? stats.volume * density * p.estFill : null);
    const fromSlicerTotal = !!(sl && sl.grams != null);
    const paintG = slots.map((s, i) => (s.paintArea || 0) / 100 * (p.paintWall / 10) * (Number(parts[i].filament?.density) || density));
    const volSum = slots.reduce((a, s) => a + (s.vol || 0), 0);
    const areaSum = slots.reduce((a, s) => a + (s.area || 0), 0);
    let est = slots.map(() => 0);
    if (total != null) {
      const rest = Math.max(0, total - paintG.reduce((a, b) => a + b, 0));
      est = slots.map((s, i) => paintG[i] + (volSum > 0 ? rest * (s.vol || 0) / volSum : areaSum > 0 ? rest * (s.area || 0) / areaSum : rest / slots.length));
    }
    if (!fromSlicerTotal && !perSlot) {
      purgeG = changes * p.purgePerChange;
      const pres = presence.reduce((a, b) => a + b, 0) || 1;
      est = est.map((g, i) => g + purgeG * (presence[i] / pres));
    }
    parts.forEach((pt, i) => {
      if (pt.manual != null) { pt.grams = pt.manual; pt.gramsSrc = 'ręcznie'; }
      else if (perSlot && perSlot[i] != null) { pt.grams = perSlot[i]; pt.gramsSrc = col.perSlotSource || (sl && sl.source) || 'slicer'; }
      else if (total != null) { pt.grams = est[i]; pt.gramsSrc = fromSlicerTotal ? `${sl.source} + podział` : 'szacunek'; }
    });
  }
  const has = parts.some((x) => x.grams != null);
  const grams = has ? parts.reduce((a, x) => a + (x.grams || 0), 0) : null;
  const srcs = [...new Set(parts.map((x) => x.gramsSrc).filter(Boolean))];
  const gramsSrc = srcs.length === 1 ? srcs[0] : srcs.length ? 'mieszane' : null;

  let minutes = null, minutesSrc = null;
  const changeMin = changeSrc === 'szacunek' || (changeSrc === 'G-code' && !(sl && sl.minutes != null)) ? changes * p.changeTimeSec / 60 : 0;
  if (m.minutes != null) { minutes = m.minutes; minutesSrc = 'ręcznie'; }
  else if (sl && sl.minutes != null) { minutes = sl.minutes; minutesSrc = sl.source; }
  else if (grams != null && p.estGramsPerHour > 0) { minutes = (grams - purgeG) / p.estGramsPerHour * 60 + changeMin; minutesSrc = 'szacunek'; }

  const plates = stats && stats.plates ? stats.plates.length : 1;
  return { plates, plateList: stats && stats.plates ? stats.plates : null, parts, grams, minutes, gramsSrc, minutesSrc, multi, changes, changeSrc, purgeG, changeMin: minutesSrc === 'szacunek' ? changeMin : 0, filament: parts[0].filament, filamentSet: parts[0].filamentSet };
}

// analiza w tle (dane ze slicera + objętość + kolory), po jednym pliku naraz
let analysisChain = Promise.resolve();
const analyzing = new Set();
function ensureAnalysis(f) {
  const needSl = (f.ext === 'gcode' || f.ext === '3mf') && ls.get(slicerKey(f), undefined) === undefined;
  const needSt = f.viewable && f.ext !== 'gcode' && !ls.get(statsKey(f), null);
  const needCol = f.viewable && ls.get(colorsKey(f), undefined) === undefined;
  if ((!needSl && !needSt && !needCol) || analyzing.has(f.rel) || f.size > 250 * 1048576) return Promise.resolve(false);
  analyzing.add(f.rel);
  const job = analysisChain.then(async () => {
    try {
      const buf = await api.readFile(f.rel);
      if (needSl) ls.set(slicerKey(f), (f.ext === 'gcode' ? slicerInfoFromGcode(buf) : slicerInfoFrom3mf(buf)) || null);
      if (f.ext === 'gcode') {
        if (needCol) {
          const ci = f.size < 150 * 1048576 ? gcodeColorInfo(new TextDecoder().decode(buf)) : null;
          ls.set(colorsKey(f), ci ? { slots: ci.slots, perSlotGrams: ci.perSlotGrams, perSlotSource: 'G-code', toolChanges: ci.toolChanges } : null);
        }
      } else if (needSt || needCol) {
        await new Promise((r) => setTimeout(r, 0));
        const parsed = parseModel(f.ext, buf);
        storeParsedAnalysis(f, parsed);
      }
      return true;
    } catch (e) {
      console.warn('analysis', f.rel, e);
      if (needSl && ls.get(slicerKey(f), undefined) === undefined) ls.set(slicerKey(f), null);
      if (needSt && !ls.get(statsKey(f), null)) ls.set(statsKey(f), { failed: true });
      if (needCol && ls.get(colorsKey(f), undefined) === undefined) ls.set(colorsKey(f), null);
      return false;
    } finally { analyzing.delete(f.rel); }
  });
  analysisChain = job.catch(() => {});
  return job;
}
function storeParsedAnalysis(f, parsed) {
  const prev = ls.get(statsKey(f), null);
  if (!prev || prev.failed) ls.set(statsKey(f), { ...computeStats(parsed.object, parsed.isGcode, parsed.zUp), plates: parsed.plates && parsed.plates.length > 1 ? parsed.plates : null });
  if (ls.get(colorsKey(f), undefined) === undefined || parsed.isGcode) {
    const slots = slotGeomStats(parsed).map((x) => ({ key: x.key, ext: x.ext ?? null, name: x.name || '', hex: x.hex || null, area: x.area, vol: x.vol, paintArea: x.paintArea || 0, zMin: x.zMin, zMax: x.zMax }));
    const info = parsed.info || {};
    ls.set(colorsKey(f), {
      slots,
      perSlotGrams: info.slice ? info.slice.perSlotGrams : info.perSlotGrams || null,
      perSlotSource: info.slice ? '3MF (slicer)' : info.perSlotGrams ? 'G-code' : null,
      toolChanges: info.toolChanges ?? null,
    });
  }
}

function filamentOptions(selId, withDefault = true, short = false) {
  const def = defaultFilament();
  return (withDefault ? `<option value="">${short ? 'Domyślny' : `Domyślny (${esc(def ? filLabel(def) : '—')})`}</option>` : '') +
    S.filaments.map((fl) => `<option value="${esc(fl.id)}" ${fl.id === selId ? 'selected' : ''}>${esc(filLabel(fl))}${short ? '' : ` · ${fmtNum(fl.pricePerKg)} ${esc(cur())}/kg`}</option>`).join('');
}

function breakdownHtml(r, opts = {}) {
  const c = cur();
  const row = (k, sub, v, cls = '') => `<div class="br ${cls}"><span>${k}${sub ? `<small>${sub}</small>` : ''}</span><b>${fmtMoney(v, c)}</b></div>`;
  const p = P();
  return `<div class="breakdown">
    ${row('Filament', `${fmtNum(r.grams, 0)} g`, r.filament)}
    ${row('Prąd', `${fmtNum(r.kWh, 2)} kWh`, r.energy)}
    ${row('Eksploatacja drukarki', `${fmtNum(r.hours, 2)} h`, r.wear)}
    ${row('Twój czas', `${fmtNum(r.laborH, 2)} h`, r.labor)}
    ${row('Bufor na awarie', `${Math.round(p.buffer * 100)}%`, r.buffer)}
    ${row('Koszt', '', r.cost, 'total')}
    ${(p.margin > 0 || p.roundTo > 0) ? row('Cena dla klienta', p.margin > 0 ? `marża ${Math.round(p.margin * 100)}%` : 'zaokrąglone', r.price, 'price') : ''}
  </div>`;
}

// ---------- zamówienie ----------
const order = () => S.order;
let orderSeq = Date.now();
function addToOrder(rels) {
  for (const rel of rels) {
    const ex = order().items.find((i) => i.rel === rel);
    if (ex) ex.qty = (Number(ex.qty) || 0) + 1;
    else order().items.push({ id: 'i' + (orderSeq++).toString(36), rel, qty: 1 });
  }
  saveSettings();
  updateOrderCount();
  toast(rels.length === 1 ? `Dodano „${baseName(rels[0])}” do wyceny` : `Dodano ${rels.length} pliki do wyceny`);
  if (st.special === 'order') renderOrder();
}
function updateOrderCount() { const el = $('#orderCount'); if (el) el.textContent = order().items.reduce((a, i) => a + (Number(i.qty) || 0), 0); }
function remapOrder(oldRel, newRel) {
  let ch = false;
  for (const it of order().items) {
    if (!it.rel) continue;
    if (it.rel === oldRel) { it.rel = newRel; ch = true; }
    else if (it.rel.startsWith(oldRel + '/')) { it.rel = newRel + it.rel.slice(oldRel.length); ch = true; }
  }
  if (ch) saveSettings();
}
function orderLines() {
  return order().items.map((it) => {
    if (it.rel) {
      const f = lib && lib.files.find((x) => x.rel === it.rel);
      if (!f) return { it, missing: true, name: baseName(it.rel), grams: 0, minutes: 0, qty: 0, parts: [], filament: null };
      const d = printData(f);
      return { it, f, name: f.name.replace(/\.[^.]+$/, ''), ...d, qty: Number(it.qty) || 0 };
    }
    const fl = filamentById(it.filamentId) || defaultFilament();
    return { it, name: it.name || 'Pozycja', grams: it.grams ?? null, minutes: it.minutes ?? null, filament: fl, filamentSet: !!filamentById(it.filamentId), gramsSrc: 'ręcznie', minutesSrc: 'ręcznie', qty: Number(it.qty) || 0, parts: [{ slot: 0, filament: fl, grams: it.grams ?? null }], multi: false };
  });
}
const lineItem = (l) => ({ parts: l.parts.map((p) => ({ grams: p.grams || 0, filament: p.filament })), minutes: l.minutes || 0, qty: l.qty, plates: l.plates || 1 });
const lineFilCost = (l) => l.parts.reduce((a, p) => a + (p.filament && p.grams ? p.grams * l.qty / 1000 * p.filament.pricePerKg : 0), 0);

function renderOrder() {
  const el = $('#order');
  const lines = orderLines();
  // dociągnij brakujące dane w tle
  lines.forEach((l) => {
    if (!l.f) return;
    ensureAnalysis(l.f).then((ch) => { if (ch && st.special === 'order') renderOrderSoon(); });
    if (!thumbs.has(l.f.rel)) requestThumb(l.f.rel, false);
  });
  const r = priceItems(lines.filter((l) => !l.missing).map(lineItem), P());
  const c = cur();
  const srcBadge = (s) => s && s !== 'ręcznie' ? `<span class="src ${s === 'szacunek' || s === 'mieszane' ? 'est' : ''}" title="Źródło: ${esc(s)}">${s === 'szacunek' || s === 'mieszane' ? '~' : '⚙'}</span>` : '';
  const rows = lines.map((l) => {
    const thumb = l.f && thumbs.get(l.f.rel);
    const lineCost = lineFilCost(l);
    return `<tr data-id="${esc(l.it.id)}" data-rel="${esc(l.f ? l.f.rel : '')}" class="${l.missing ? 'missing' : ''} ${l.f && sel.has(l.f.rel) ? 'sel' : ''}">
      <td class="o-thumb">${thumb && thumb !== 'none' ? `<img src="${thumb}">` : `<span>${l.f ? esc(l.f.ext) : l.missing ? '?' : '✎'}</span>`}</td>
      <td class="o-name">${l.it.rel ? `<span class="nm" data-open>${esc(l.name)}</span>${l.missing ? '<small class="warn">brak pliku w bibliotece</small>' : `<small>${esc(l.f.dir || '/')}</small>`}`
        : `<input class="cell" data-k="name" value="${esc(l.name)}" spellcheck="false">`}</td>
      <td class="o-fil">${l.multi ? `<span class="mc-chips" data-open title="${esc(l.parts.map((p) => `${p.name}: ${filLabel(p.filament)} (${fmtNum(p.grams || 0, 1)} g)`).join('\n'))}">${l.parts.map((p) => swatch(p.filament)).join('')}<span>${l.parts.length} kolory</span></span>`
        : `${swatch(l.filament)}<select class="cell" data-k="filamentId" title="${esc(filLabel(l.filament))}">${filamentOptions(l.filamentSet ? l.filament.id : '', true, true)}</select>`}</td>
      <td class="o-num">${l.multi ? `<span class="ro">${l.grams != null ? fmtNum(l.grams, 0) : '—'}</span>` : `<input class="cell num" data-k="grams" value="${l.gramsSrc === 'ręcznie' && l.grams != null ? fmtNum(l.grams, l.grams % 1 ? 1 : 0) : ''}" placeholder="${l.grams != null ? fmtNum(l.grams, 0) : '—'}">`}${srcBadge(l.gramsSrc)}</td>
      <td class="o-num"><input class="cell num" data-k="minutes" value="${l.minutesSrc === 'ręcznie' && l.minutes != null ? fmtDurShort(l.minutes) : ''}" placeholder="${l.minutes != null ? fmtDurShort(l.minutes) : 'h:mm'}">${srcBadge(l.minutesSrc)}</td>
      <td class="o-qty"><input class="cell num" type="number" min="0" step="1" data-k="qty" value="${l.qty}"></td>
      <td class="o-cost">${fmtMoney(lineCost, c)}</td>
      <td><button class="icon-btn" data-rm title="Usuń z wyceny">✕</button></td>
    </tr>`;
  }).join('');
  const mats = r.byFil.filter((b) => b.grams > 0).map((b) => `<div class="br"><span>${swatch(b.filament)}${esc(b.filament ? filLabel(b.filament) : 'bez filamentu')}<small>${fmtNum(b.grams, 0)} g</small></span><b>${fmtMoney(b.cost, c)}</b></div>`).join('') || '<div class="muted-note">—</div>';
  el.innerHTML = `
    <div class="order-head">
      <input class="order-name" id="oName" placeholder="Nazwa zamówienia…" value="${esc(order().name || '')}" spellcheck="false">
      <select class="client-sel" id="oClient" title="Klient">${clientOptions(order().clientId)}</select>
      <button class="btn" id="oAdd">+ Pozycja ręczna</button>
      <button class="btn primary" id="oSave">Zapisz jako zamówienie</button>
      <button class="btn" id="oPdf">Oferta PDF</button>
      <button class="btn" id="oCopy">Kopiuj podsumowanie</button>
      <button class="btn" id="oCsv">Eksport CSV</button>
      <button class="btn danger" id="oClear">Wyczyść</button>
    </div>
    ${lines.length ? `
    <table class="otable">
      <thead><tr><th></th><th>Pozycja</th><th>Filament</th><th class="r">Gramy</th><th class="r">Czas</th><th class="r">Ile razy</th><th class="r">Filament</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td></td><td>Razem</td><td></td><td class="r">${fmtNum(r.grams, 0)} g</td><td class="r">${fmtDuration(r.minutes)}</td><td class="r">${r.prints}</td><td class="r">${fmtMoney(r.filament, c)}</td><td></td></tr></tfoot>
    </table>
    ${stockWarnings(r.byFil.map((b) => ({ filament: b.filament, grams: b.grams })))}
    <div class="legend"><span class="src">⚙</span> dane ze slicera (G-code / 3MF) · <span class="src est">~</span> szacunek z objętości modelu · puste pole = wartość automatyczna, wpisz liczbę, aby nadpisać</div>
    <div class="summary">
      <div class="scard"><h4>Materiały</h4>${mats}</div>
      <div class="scard"><h4>Koszty</h4>${breakdownHtml(r)}</div>
      <div class="scard big"><h4>${P().margin > 0 || P().roundTo > 0 ? 'Cena dla klienta' : 'Koszt zamówienia'}</h4>
        <div class="bigprice">${fmtMoney(P().margin > 0 || P().roundTo > 0 ? r.price : r.cost, c)}</div>
        <div class="muted-note" style="padding:0">koszt własny ${fmtMoney(r.cost, c)} · ${r.prints} ${r.prints === 1 ? 'wydruk' : 'wydruków'} · ${fmtDuration(r.minutes)} druku</div>
        <button class="btn" id="oSettings" style="margin-top:12px">Ustawienia wyceny…</button>
      </div>
    </div>` : `<div class="empty-order"><div class="big">Wycena jest pusta</div>
      Dodaj modele z biblioteki: prawy przycisk → „Dodaj do wyceny”, przycisk w panelu modelu<br>albo przeciągnij karty na „Wycena zamówienia” po lewej. Możesz też dodać pozycję ręcznie.</div>`}`;

  const findItem = (tr) => order().items.find((i) => i.id === tr.dataset.id);
  $('#oName').oninput = (e) => { order().name = e.target.value; saveSettings(); };
  $('#oAdd').onclick = () => { order().items.push({ id: 'i' + (orderSeq++).toString(36), name: 'Nowa pozycja', qty: 1 }); saveSettings(); updateOrderCount(); renderOrder(); el.querySelector('tbody tr:last-child input[data-k="name"]')?.select(); };
  $('#oClear').onclick = async () => { if (!lines.length || await confirmModal('Wyczyścić wycenę?', 'Usuniesz wszystkie pozycje z bieżącej wyceny. Pliki modeli zostaną nietknięte.', 'Wyczyść')) { order().items = []; order().name = ''; saveSettings(); updateOrderCount(); renderOrder(); } };
  const sv = $('#oSave'); if (sv) sv.onclick = () => saveOrderToHistory(lines, r);
  $('#oPdf').onclick = () => offerFromCurrentOrder();
  $('#oClient').onchange = async (e) => {
    if (e.target.value === '__new') { const c = await clientModal(); order().clientId = c && c !== 'deleted' ? c.id : order().clientId; }
    else order().clientId = e.target.value || null;
    saveSettings(); renderOrder();
  };
  $('#oCopy').onclick = () => api.copyText(orderSummaryText(lines, r)).then(() => toast('Skopiowano podsumowanie do schowka'));
  $('#oCsv').onclick = async () => { const p = await safe(() => api.saveFile(`${(order().name || 'wycena').replace(/[\\/:*?"<>|]/g, '_')}.csv`, orderCsv(lines, r))); if (p) toast('Zapisano CSV'); };
  const os = $('#oSettings'); if (os) os.onclick = () => openSettings('pricing');
  el.querySelectorAll('tbody tr').forEach((tr) => {
    const it = findItem(tr);
    const line = lines.find((l) => l.it === it);
    tr.querySelector('[data-rm]').onclick = () => { order().items = order().items.filter((x) => x !== it); saveSettings(); updateOrderCount(); renderOrder(); };
    tr.querySelectorAll('[data-open]').forEach((x) => x.addEventListener('click', () => { if (line.f) { selectCard(line.f.rel); renderOrder(); } }));
    tr.querySelectorAll('.cell').forEach((inp) => {
      inp.onchange = async () => {
        const k = inp.dataset.k;
        let v = inp.value.trim();
        if (k === 'qty') { it.qty = Math.max(0, parseInt(v, 10) || 0); saveSettings(); updateOrderCount(); return renderOrder(); }
        if (k === 'name') { it.name = v || 'Pozycja'; saveSettings(); return; }
        const val = k === 'grams' ? (v === '' ? null : parseFloat(v.replace(',', '.'))) : k === 'minutes' ? (v === '' ? null : parseDuration(v)) : (v || null);
        if ((k === 'grams' || k === 'minutes') && v !== '' && !Number.isFinite(val)) { toast('Nieprawidłowa wartość', true); return renderOrder(); }
        if (it.rel) { if (line.f) await setPrintMeta(line.f.rel, { [k]: val }); }
        else { it[k] = val; saveSettings(); }
        renderOrder();
        if (line.f && focused === line.f.rel) renderDetail();
      };
    });
  });
}
let orderT = null;
function renderOrderSoon() { clearTimeout(orderT); orderT = setTimeout(() => { if (st.special === 'order' && !document.activeElement?.classList.contains('cell')) renderOrder(); }, 200); }
function fmtDurShort(min) { const m = Math.round(min); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; }

async function setPrintMeta(rel, patch) {
  const curP = metaOf(rel).print || {};
  await setMeta(rel, { print: { ...curP, ...patch } });
}

function orderSummaryText(lines, r) {
  const c = cur(), p = P();
  const out = [`Wycena${order().name ? ': ' + order().name : ''}`, ''];
  for (const l of lines) if (!l.missing && l.qty > 0) out.push(`• ${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''} — ${fmtNum(l.grams || 0, 0)} g, ${fmtDuration(l.minutes)} (${l.parts.map((p) => filLabel(p.filament)).filter((v, i, a) => a.indexOf(v) === i).join(' + ')})`);
  out.push('', `Filament: ${fmtMoney(r.filament, c)} (${fmtNum(r.grams, 0)} g)`, `Prąd: ${fmtMoney(r.energy, c)} (${fmtNum(r.kWh, 2)} kWh)`,
    `Eksploatacja drukarki: ${fmtMoney(r.wear, c)} (${fmtNum(r.hours, 2)} h)`, `Mój czas: ${fmtMoney(r.labor, c)} (${fmtNum(r.laborH, 2)} h)`,
    `Bufor na awarie: ${fmtMoney(r.buffer, c)}`, `Koszt: ${fmtMoney(r.cost, c)}`);
  if (p.margin > 0 || p.roundTo > 0) out.push(`Cena dla klienta: ${fmtMoney(r.price, c)}`);
  return out.join('\n');
}
function orderCsv(lines, r) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const n = (v, d = 2) => (Number(v) || 0).toFixed(d).replace('.', ',');
  const rows = [['Pozycja', 'Filament', 'Kolor', 'Gramy', 'Czas (min)', 'Ile razy', 'Koszt filamentu'].map(q).join(';')];
  for (const l of lines) if (!l.missing) for (const [pi, p] of l.parts.entries()) rows.push([q(l.name + (l.multi ? ` [${p.name}]` : '')), q(p.filament?.name), q(p.filament?.color), n(p.grams, 1), pi === 0 ? n(l.minutes, 0) : '', l.qty, n(p.filament && p.grams ? p.grams * l.qty / 1000 * p.filament.pricePerKg : 0)].join(';'));
  rows.push('', [q('Filament'), n(r.filament)].join(';'), [q('Prąd (kWh)'), n(r.kWh, 3), n(r.energy)].join(';'), [q('Eksploatacja (h)'), n(r.hours), n(r.wear)].join(';'),
    [q('Mój czas (h)'), n(r.laborH), n(r.labor)].join(';'), [q('Bufor'), n(P().buffer), n(r.buffer)].join(';'), [q('Koszt'), n(r.cost)].join(';'), [q('Cena dla klienta'), n(r.price)].join(';'));
  return rows.join('\r\n');
}

// ---------- magazyn filamentów ----------
const tracked = (fl) => !!fl && fl.remaining != null && Number.isFinite(Number(fl.remaining));
function stockWarnings(list) {
  const need = new Map();
  for (const x of list) if (x.filament && x.grams > 0) need.set(x.filament.id, (need.get(x.filament.id) || 0) + x.grams);
  const msgs = [];
  for (const [id, g] of need) {
    const fl = filamentById(id);
    if (!tracked(fl)) continue;
    if (fl.remaining < g) msgs.push(`${filLabel(fl)}: potrzeba ${fmtNum(g, 0)} g, na stanie tylko ${fmtNum(fl.remaining, 0)} g`);
    else if (fl.remaining - g < S.stock.lowThreshold) msgs.push(`${filLabel(fl)}: po wydruku zostanie ${fmtNum(fl.remaining - g, 0)} g`);
  }
  return msgs.length ? `<div class="stockwarn">${msgs.map((m) => `<div>⚠ ${esc(m)}</div>`).join('')}</div>` : '';
}
function consume(parts, ref, label) {
  const agg = new Map();
  for (const p of parts) { if (!p.filament || !(p.grams > 0)) continue; agg.set(p.filament.id, (agg.get(p.filament.id) || 0) + p.grams); }
  const entries = [];
  for (const [id, g] of agg) {
    const fl = filamentById(id);
    if (!tracked(fl)) continue;
    fl.remaining = Math.round((Number(fl.remaining) - g) * 10) / 10;
    entries.push({ filamentId: id, grams: Math.round(g * 10) / 10 });
  }
  if (!entries.length) return null;
  const log = { id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: Date.now(), ref, label, entries, reverted: false };
  S.stockLog.unshift(log);
  S.stockLog = S.stockLog.slice(0, 400);
  saveSettings();
  toast(`Odjęto z magazynu: ${entries.map((e) => `${fmtNum(e.grams, 0)} g ${filLabel(filamentById(e.filamentId))}`).join(', ')}`, false, { label: 'Cofnij', fn: () => revertLog(log.id) });
  updateStockCount();
  if (st.special === 'stock') renderStock();
  return log.id;
}
function revertLog(id, quiet = false) {
  const log = S.stockLog.find((l) => l.id === id);
  if (!log || log.reverted) return;
  for (const e of log.entries) { const fl = filamentById(e.filamentId); if (tracked(fl)) fl.remaining = Math.round((Number(fl.remaining) + e.grams) * 10) / 10; }
  log.reverted = true;
  saveSettings();
  if (!quiet) toast('Przywrócono filament do magazynu');
  updateStockCount();
  if (st.special === 'stock') renderStock();
}
function revertByRef(ref) { const log = S.stockLog.find((l) => !l.reverted && l.ref === ref); if (log) revertLog(log.id); }
function updateStockCount() {
  const el = $('#stockCount'); if (!el || !S) return;
  const low = S.filaments.filter((fl) => tracked(fl) && fl.remaining < S.stock.lowThreshold).length;
  el.textContent = low ? `${low} ⚠` : '';
  el.classList.toggle('warn', low > 0);
}
async function setStatus(rels, status) {
  for (const rel of rels) {
    const prev = metaOf(rel).status || '';
    if (prev === status) continue;
    await setMeta(rel, { status });
    if (!S.stock.onModelPrinted) continue;
    const f = lib.files.find((x) => x.rel === rel);
    if (status === 'printed' && f) {
      const d = printData(f);
      consume(d.parts.map((p) => ({ filament: p.filament, grams: p.grams || 0 })), 'model:' + rel, f.name);
    } else if (prev === 'printed') revertByRef('model:' + rel);
  }
  renderSidebar(); renderGrid(); renderDetail();
}

function renderStock() {
  const el = $('#stock');
  const c = cur();
  const value = S.filaments.reduce((a, fl) => a + (tracked(fl) ? Math.max(0, fl.remaining) / 1000 * fl.pricePerKg : 0), 0);
  const cards = S.filaments.map((fl) => {
    const t = tracked(fl);
    const pct = t ? Math.max(0, Math.min(100, fl.remaining / (fl.spoolWeight || 1000) * 100)) : 0;
    const low = t && fl.remaining < S.stock.lowThreshold;
    return `<div class="spool ${low ? 'low' : ''}" data-id="${esc(fl.id)}">
      <div class="spool-top"><span class="disc" style="background:${esc(fl.hex || '#888')}"></span>
        <div><div class="sp-name">${esc(fl.name)}</div><div class="sp-sub">${esc(fl.color)} · ${esc(fl.type || '')} · ${fmtNum(fl.pricePerKg)} ${esc(c)}/kg</div></div></div>
      ${t ? `<div class="bar"><i style="width:${pct}%"></i></div>
        <div class="sp-nums"><b>${fmtNum(fl.remaining, 0)} g</b><span>z ${fmtNum(fl.spoolWeight || 1000, 0)} g · ${fmtMoney(Math.max(0, fl.remaining) / 1000 * fl.pricePerKg, c)}</span></div>
        ${low ? `<div class="sp-low">Kończy się — poniżej ${fmtNum(S.stock.lowThreshold, 0)} g</div>` : ''}
        <div class="sp-btns"><button class="btn" data-a="add">+1 szpula</button><button class="btn" data-a="set">Ustaw stan…</button><button class="icon-btn" data-a="untrack" title="Przestań śledzić">✕</button></div>`
      : `<div class="sp-untracked">Stan nie jest śledzony</div><div class="sp-btns"><button class="btn primary" data-a="set">Ustaw stan…</button><button class="btn" data-a="full">Pełna szpula</button></div>`}
    </div>`;
  }).join('');
  const logRows = S.stockLog.slice(0, 60).map((l) => `<tr class="${l.reverted ? 'reverted' : ''}">
      <td>${fmtDate(l.date)}</td><td>${esc(l.label || '')}</td>
      <td>${l.entries.map((e) => { const fl = filamentById(e.filamentId); return `${swatch(fl)}${fmtNum(e.grams, 1)} g ${esc(fl ? filLabel(fl) : '(usunięty filament)')}`; }).join('<br>')}</td>
      <td class="r">${l.reverted ? '<small>cofnięte</small>' : `<button class="btn" data-undo="${esc(l.id)}">Cofnij</button>`}</td></tr>`).join('');
  el.innerHTML = `
    <div class="order-head"><div class="vtitle">Magazyn filamentów</div><span class="vsub">wartość na stanie: <b>${fmtMoney(value, c)}</b></span><span style="flex:1"></span>
      <button class="btn" id="stEdit">Edytuj filamenty…</button></div>
    <div class="spools">${cards}</div>
    <div class="stock-settings">
      <label class="check"><input type="checkbox" id="stModel" ${S.stock.onModelPrinted ? 'checked' : ''}> Odejmuj filament, gdy oznaczę model jako „Wydrukowane”</label>
      <label class="check">Dla zamówień odejmuj filament przy statusie
        <select id="stOrder"><option value="printing" ${S.stock.onOrderStatus === 'printing' ? 'selected' : ''}>„W druku”</option><option value="done" ${S.stock.onOrderStatus === 'done' ? 'selected' : ''}>„Wydane”</option><option value="off" ${S.stock.onOrderStatus === 'off' ? 'selected' : ''}>nigdy</option></select></label>
      <label class="check">Ostrzegaj, gdy na szpuli zostaje mniej niż <input type="number" id="stLow" min="0" step="10" value="${S.stock.lowThreshold}" style="width:80px"> g</label>
      <p class="hint">Wybierz jeden sposób: odejmowanie przy modelach albo przy zamówieniach. Przy obu naraz ten sam wydruk zostanie odjęty dwa razy.</p>
    </div>
    <div class="label">Historia zużycia</div>
    ${logRows ? `<table class="otable log"><thead><tr><th>Data</th><th>Za co</th><th>Filament</th><th></th></tr></thead><tbody>${logRows}</tbody></table>` : '<div class="muted-note">Brak wpisów. Zużycie pojawi się po oznaczeniu modelu jako wydrukowany albo zmianie statusu zamówienia.</div>'}`;
  $('#stEdit').onclick = () => openSettings('filaments');
  $('#stModel').onchange = (e) => { S.stock.onModelPrinted = e.target.checked; saveSettings(); };
  $('#stOrder').onchange = (e) => { S.stock.onOrderStatus = e.target.value; saveSettings(); };
  $('#stLow').onchange = (e) => { S.stock.lowThreshold = Math.max(0, parseFloat(e.target.value) || 0); saveSettings(); updateStockCount(); renderStock(); };
  el.querySelectorAll('.spool').forEach((card) => {
    const fl = filamentById(card.dataset.id);
    card.querySelectorAll('[data-a]').forEach((b) => b.onclick = async () => {
      const a = b.dataset.a;
      if (a === 'add') fl.remaining = Number(fl.remaining) + (fl.spoolWeight || 1000);
      if (a === 'full') fl.remaining = fl.spoolWeight || 1000;
      if (a === 'untrack') fl.remaining = null;
      if (a === 'set') {
        const v = await promptModal(`Ile gramów zostało: ${filLabel(fl)}?`, tracked(fl) ? String(fl.remaining) : String(fl.spoolWeight || 1000), 'Zapisz');
        if (v == null) return;
        const n = parseFloat(v.replace(',', '.'));
        if (!Number.isFinite(n) || n < 0) return toast('Nieprawidłowa wartość', true);
        fl.remaining = n;
      }
      saveSettings(); updateStockCount(); renderStock();
    });
  });
  el.querySelectorAll('[data-undo]').forEach((b) => b.onclick = () => revertLog(b.dataset.undo));
}

// ---------- historia zamówień ----------
const ORDER_STATUS = { quoted: 'Wycenione', printing: 'W druku', done: 'Wydane', cancelled: 'Anulowane' };
let ordersFilter = 'all';
let ordersMonth = null;
let ordersOpen = new Set();
function nextOrderNo() {
  const y = new Date().getFullYear();
  const n = S.orders.filter((o) => o.year === y).reduce((a, o) => Math.max(a, o.seq || 0), 0) + 1;
  return { year: y, seq: n, no: `${y}/${String(n).padStart(3, '0')}` };
}
function saveOrderToHistory(lines, r) {
  const valid = lines.filter((l) => !l.missing && l.qty > 0);
  if (!valid.length) return toast('Wycena jest pusta', true);
  const no = nextOrderNo();
  const o = {
    id: 'o' + Date.now().toString(36), ...no, name: order().name || `Zamówienie ${no.no}`, createdAt: Date.now(), status: 'quoted', statusAt: { quoted: Date.now() },
    clientId: order().clientId || null, clientName: (clientById(order().clientId) || {}).name || null, deadline: null,
    items: valid.map((l) => ({ rel: l.it.rel || null, name: l.name, qty: l.qty, minutes: l.minutes || 0, plates: l.plates || 1,
      parts: l.parts.map((p) => ({ name: p.name || '', filamentId: p.filament ? p.filament.id : null, label: filLabel(p.filament), hex: p.filament ? p.filament.hex : null, grams: p.grams || 0, pricePerKg: p.filament ? p.filament.pricePerKg : 0 })) })),
    totals: { cost: r.cost, price: r.price, grams: r.grams, minutes: r.minutes, prints: r.prints, filament: r.filament, energy: r.energy, wear: r.wear, labor: r.labor, buffer: r.buffer },
    agreedPrice: null, consumedLog: null, note: '',
  };
  S.orders.unshift(o);
  saveSettings();
  updateOrdersCount();
  toast(`Zapisano zamówienie ${o.no}`, false, { label: 'Pokaż', fn: () => setView({ special: 'orders' }) });
}
function setOrderStatus(o, status) {
  const prev = o.status;
  if (prev === status) return;
  o.status = status;
  o.statusAt = { ...(o.statusAt || {}), [status]: Date.now() };
  const mode = S.stock.onOrderStatus;
  const shouldConsume = mode !== 'off' && !o.consumedLog && ((mode === 'printing' && (status === 'printing' || status === 'done')) || (mode === 'done' && status === 'done'));
  if (shouldConsume) {
    const parts = [];
    for (const it of o.items) for (const p of it.parts) parts.push({ filament: filamentById(p.filamentId), grams: p.grams * it.qty });
    o.consumedLog = consume(parts, 'order:' + o.id, `Zamówienie ${o.no} – ${o.name}`) || 'none';
  }
  if ((status === 'quoted' || status === 'cancelled') && o.consumedLog) {
    if (o.consumedLog !== 'none') revertLog(o.consumedLog);
    o.consumedLog = null;
  }
  saveSettings();
  updateOrdersCount();
}
const finalPrice = (o) => o.agreedPrice != null ? o.agreedPrice : o.totals.price;
const monthKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const monthLabel = (k) => { const [y, m] = k.split('-'); return new Date(+y, +m - 1, 1).toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' }); };
function updateOrdersCount() { const el = $('#ordersCount'); if (el && S) el.textContent = S.orders.filter((o) => o.status === 'quoted' || o.status === 'printing').length || ''; }

function orderToText(o) {
  const c = cur();
  const out = [`Zamówienie ${o.no}: ${o.name}`, ''];
  for (const it of o.items) out.push(`• ${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''} — ${fmtNum(it.parts.reduce((a, p) => a + p.grams, 0), 0)} g, ${fmtDuration(it.minutes)} (${[...new Set(it.parts.map((p) => p.label))].join(' + ')})`);
  out.push('', `Koszt: ${fmtMoney(o.totals.cost, c)}`, `Cena: ${fmtMoney(finalPrice(o), c)}`);
  return out.join('\n');
}

function renderOrders() {
  const el = $('#orders');
  const c = cur();
  const months = [...new Set([monthKey(Date.now()), ...S.orders.map((o) => monthKey(o.statusAt?.done || o.createdAt))])].sort().reverse();
  if (!ordersMonth || !months.includes(ordersMonth)) ordersMonth = months[0];
  const doneIn = S.orders.filter((o) => o.status === 'done' && monthKey(o.statusAt?.done || o.createdAt) === ordersMonth);
  const sum = (arr, fn) => arr.reduce((a, o) => a + fn(o), 0);
  const revenue = sum(doneIn, finalPrice), cost = sum(doneIn, (o) => o.totals.cost);
  const list = S.orders.filter((o) => (ordersFilter === 'all' || o.status === ordersFilter) && (!ordersClient || o.clientId === ordersClient));
  const rows = list.map((o) => {
    const open = ordersOpen.has(o.id);
    const nItems = o.items.reduce((a, it) => a + it.qty, 0);
    return `<tr data-id="${esc(o.id)}" class="ord ${o.status}">
      <td class="mono"><button class="caretbtn ${open ? 'open' : ''}" data-toggle>▶</button>${esc(o.no)}</td>
      <td><input class="cell" data-k="name" value="${esc(o.name)}" spellcheck="false">${o.clientId || o.clientName ? `<small class="cl-note">${esc((clientById(o.clientId) || {}).name || o.clientName)}</small>` : ''}</td>
      <td class="mono small">${new Date(o.createdAt).toLocaleDateString('pl-PL')}</td>
      <td class="r">${nItems}</td>
      <td class="r mono">${fmtMoney(o.totals.cost, c)}</td>
      <td class="r"><input class="cell num wide" data-k="agreedPrice" value="${o.agreedPrice != null ? fmtNum(o.agreedPrice) : ''}" placeholder="${fmtNum(o.totals.price)}" title="Cena uzgodniona z klientem (puste = wyliczona)"></td>
      <td><select class="cell status-sel ${o.status}" data-k="status">${Object.entries(ORDER_STATUS).map(([k, v]) => `<option value="${k}" ${k === o.status ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
      <td class="r nowrap"><button class="icon-btn" data-pdf title="Oferta PDF">⎙</button><button class="icon-btn" data-load title="Wczytaj do wyceny">↺</button><button class="icon-btn" data-copy title="Kopiuj podsumowanie">⧉</button><button class="icon-btn" data-del title="Usuń">✕</button></td>
    </tr>${open ? `<tr class="ord-detail"><td></td><td colspan="7">
      ${o.items.map((it) => `<div class="od-item"><b>${esc(it.name)}</b>${it.qty > 1 ? ` ×${it.qty}` : ''} <span class="mono small">${fmtDuration(it.minutes)}</span>
        <span class="od-parts">${it.parts.map((p) => `<span>${swatch({ hex: p.hex })}${esc(p.label)} ${fmtNum(p.grams, 1)} g</span>`).join('')}</span></div>`).join('')}
      <div class="od-meta">${Object.entries(o.statusAt || {}).map(([k, t]) => `${ORDER_STATUS[k]}: ${fmtDate(t)}`).join(' · ')}${o.consumedLog && o.consumedLog !== 'none' ? ' · filament odjęty z magazynu' : ''}</div>
      <textarea class="notes" data-k="note" placeholder="Notatka do zamówienia (klient, termin, adres wysyłki…)">${esc(o.note || '')}</textarea>
    </td></tr>` : ''}`;
  }).join('');
  el.innerHTML = `
    <div class="order-head"><div class="vtitle">Zamówienia</div><span style="flex:1"></span>
      <select id="oMonth">${months.map((m) => `<option value="${m}" ${m === ordersMonth ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}</select></div>
    <div class="kpis">
      <div class="kpi"><span>Wydane w miesiącu</span><b>${doneIn.length}</b></div>
      <div class="kpi"><span>Przychód</span><b>${fmtMoney(revenue, c)}</b></div>
      <div class="kpi"><span>Koszt własny</span><b>${fmtMoney(cost, c)}</b></div>
      <div class="kpi accent"><span>Zysk</span><b>${fmtMoney(revenue - cost, c)}</b></div>
      <div class="kpi"><span>Filament</span><b>${fmtNum(sum(doneIn, (o) => o.totals.grams) / 1000, 2)} kg</b></div>
      <div class="kpi"><span>Czas druku</span><b>${fmtDuration(sum(doneIn, (o) => o.totals.minutes))}</b></div>
    </div>
    ${ordersClient ? `<div class="client-filter">Klient: <b>${esc((clientById(ordersClient) || {}).name || '?')}</b> <button class="linkbtn" id="ocClear">pokaż wszystkich</button></div>` : ''}
    <div class="chips">${[['all', 'Wszystkie'], ...Object.entries(ORDER_STATUS)].map(([k, v]) => `<button class="chip ${ordersFilter === k ? 'on' : ''}" data-f="${k}">${v} <small>${k === 'all' ? S.orders.length : S.orders.filter((o) => o.status === k).length}</small></button>`).join('')}</div>
    ${list.length ? `<table class="otable orders"><thead><tr><th>Nr</th><th>Nazwa</th><th>Data</th><th class="r">Szt.</th><th class="r">Koszt</th><th class="r">Cena</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="empty-order"><div class="big">Brak zamówień</div>Przygotuj wycenę i kliknij „Zapisz jako zamówienie”.</div>`}
    <div class="label" style="margin-top:22px">Statystyki</div>
    ${statsHtml()}`;
  const occ = $('#ocClear'); if (occ) occ.onclick = () => { ordersClient = null; renderOrders(); };
  $('#oMonth').onchange = (e) => { ordersMonth = e.target.value; renderOrders(); };
  el.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { ordersFilter = b.dataset.f; renderOrders(); });
  el.querySelectorAll('tr.ord').forEach((tr) => {
    const o = S.orders.find((x) => x.id === tr.dataset.id);
    tr.querySelector('[data-toggle]').onclick = () => { ordersOpen.has(o.id) ? ordersOpen.delete(o.id) : ordersOpen.add(o.id); renderOrders(); };
    tr.querySelector('[data-k="name"]').onchange = (e) => { o.name = e.target.value.trim() || o.name; saveSettings(); };
    tr.querySelector('[data-k="agreedPrice"]').onchange = (e) => {
      const v = e.target.value.trim();
      const n = v === '' ? null : parseFloat(v.replace(/\s/g, '').replace(',', '.'));
      if (v !== '' && !Number.isFinite(n)) return toast('Nieprawidłowa cena', true);
      o.agreedPrice = n; saveSettings(); renderOrders();
    };
    tr.querySelector('[data-k="status"]').onchange = (e) => { setOrderStatus(o, e.target.value); renderOrders(); };
    tr.querySelector('[data-copy]').onclick = () => api.copyText(orderToText(o)).then(() => toast('Skopiowano'));
    tr.querySelector('[data-pdf]').onclick = () => offerFromOrder(o);
    tr.querySelector('[data-load]').onclick = () => {
      S.order = { name: o.name, clientId: o.clientId || null, items: o.items.map((it) => it.rel && lib.files.some((f) => f.rel === it.rel)
        ? { id: 'i' + (orderSeq++).toString(36), rel: it.rel, qty: it.qty }
        : { id: 'i' + (orderSeq++).toString(36), name: it.name, qty: it.qty, grams: it.parts.reduce((a, p) => a + p.grams, 0), minutes: it.minutes, filamentId: it.parts[0]?.filamentId || null }) };
      saveSettings(); updateOrderCount(); setView({ special: 'order' });
      toast(`Wczytano ${o.no} do wyceny`);
    };
    tr.querySelector('[data-del]').onclick = async () => {
      if (!(await confirmModal(`Usunąć zamówienie ${o.no}?`, 'Zamówienie zniknie z historii. Odjęty filament nie wróci automatycznie do magazynu; możesz to cofnąć w historii zużycia.', 'Usuń'))) return;
      S.orders = S.orders.filter((x) => x !== o); saveSettings(); updateOrdersCount(); renderOrders();
    };
    const det = tr.nextElementSibling;
    if (det && det.classList.contains('ord-detail')) {
      const ta = det.querySelector('textarea');
      ta.oninput = () => { o.note = ta.value; saveSettings(); };
    }
  });
}

// ---------- duplikaty ----------
let dupState = { computing: false, groups: null, byRel: new Map(), key: '' };
const hashKey = (f) => `mv.hash:${f.rel}:${f.mtime}:${f.size}`;
async function computeDups() {
  if (!lib || dupState.computing) return;
  const key = lib.files.map((f) => f.rel + f.size + f.mtime).join('|');
  if (dupState.groups && dupState.key === key) return;
  dupState.computing = true;
  renderGrid();
  const bySize = new Map();
  for (const f of lib.files) { if (!f.size) continue; if (!bySize.has(f.size)) bySize.set(f.size, []); bySize.get(f.size).push(f); }
  const cand = [...bySize.values()].filter((g) => g.length > 1).flat();
  const need = cand.filter((f) => !ls.get(hashKey(f), null)).map((f) => f.rel);
  for (let i = 0; i < need.length; i += 25) {
    const res = await api.hashFiles(need.slice(i, i + 25)).catch(() => ({}));
    for (const [rel, h] of Object.entries(res)) { const f = lib.files.find((x) => x.rel === rel); if (f && h) ls.set(hashKey(f), h); }
  }
  const byHash = new Map();
  for (const f of cand) { const h = ls.get(hashKey(f), null); if (!h) continue; if (!byHash.has(h)) byHash.set(h, []); byHash.get(h).push(f); }
  const groups = [...byHash.values()].filter((g) => g.length > 1).sort((a, b) => b[0].size * b.length - a[0].size * a.length);
  dupState = { computing: false, groups, byRel: new Map(groups.flatMap((g, i) => g.map((f) => [f.rel, i]))), key };
  if (st.special === 'dups') renderGrid();
}

// ---------- slicery ----------
function slicerChoices() {
  const def = S.slicers.default;
  const list = (S.slicers.list || []).filter((x) => x.enabled && x.available);
  return list.sort((a, b) => (a.id === def ? -1 : b.id === def ? 1 : 0));
}
function defaultSlicer() { return S.slicers.default === 'system' ? null : slicerChoices()[0] || null; }
function openWith(slicer, rels) { api.openInSlicer(slicer ? slicer.path : 'system', rels).catch((e) => toast(e.message, true)); }
function openDefault(rels) { openWith(defaultSlicer(), rels); }
const openLabel = () => { const d = defaultSlicer(); return d ? `Otwórz w ${d.name}` : 'Otwórz'; };
function openMenuItems(rels, includeDefault = true) {
  const d = defaultSlicer();
  const items = [];
  if (includeDefault) items.push({ label: openLabel(), hint: 'Enter', action: () => openDefault(rels) });
  for (const s of slicerChoices()) if (!d || s.id !== d.id) items.push({ label: `Otwórz w ${s.name}`, action: () => openWith(s, rels) });
  if (d) items.push({ label: 'Otwórz programem domyślnym systemu', action: () => openWith(null, rels) });
  return items;
}

// ---------- miniatury: widok ----------
const thumbSpecFor = (f) => metaOf(f.rel).thumbView || { dir: VIEW_PRESETS[S.thumbs.preset] || VIEW_PRESETS.iso };
const thumbKeyFor = (f) => `${thumbVer()}|${metaOf(f.rel).thumbView ? JSON.stringify(metaOf(f.rel).thumbView).slice(0, 80) : S.thumbs.preset}`;
async function snapThumbFromView(rel) {
  const spec = viewer && viewer.getViewSpec ? viewer.getViewSpec() : null;
  if (!spec) return toast('Najpierw otwórz podgląd 3D', true);
  await setMeta(rel, { thumbView: spec });
  thumbs.delete(rel);
  requestThumb(rel, true, true);
  toast('Ustawiono miniaturę z bieżącego widoku');
  renderDetail();
}

// ---------- kolekcje ----------
const collections = () => (lib && lib.collections) || [];
const COLL_COLORS = ['#f2a03d', '#6aa7ff', '#5ec48a', '#e07ab8', '#8e6cd8', '#3ec7c2', '#ef6461', '#e6c84a'];
async function saveCollections(list) { lib.collections = await api.setCollections(list); renderSidebar(); }
async function newCollection(addRels = []) {
  const name = await promptModal('Nowa kolekcja', '', 'Utwórz');
  if (!name) return null;
  const c = { id: 'c' + Date.now().toString(36), name, color: COLL_COLORS[collections().length % COLL_COLORS.length] };
  await saveCollections([...collections(), c]);
  if (addRels.length) await addToCollection(c.id, addRels);
  return c;
}
async function addToCollection(id, rels) {
  for (const r of rels) { const cur = metaOf(r).collections || []; if (!cur.includes(id)) await setMeta(r, { collections: [...cur, id] }); }
  const c = collections().find((x) => x.id === id);
  toast(`Dodano ${rels.length === 1 ? '1 model' : rels.length + ' modele'} do „${c ? c.name : ''}”`);
  renderSidebar(); renderGrid(); renderDetail();
}
async function removeFromCollection(id, rels) {
  for (const r of rels) await setMeta(r, { collections: (metaOf(r).collections || []).filter((x) => x !== id) });
  renderSidebar(); renderGrid(); renderDetail();
}
function pickCollectionModal(rels) {
  return modal(`<h3>Dodaj do kolekcji</h3><div class="folder-pick" id="mList">${collections().map((c) => `<div data-c="${esc(c.id)}"><span class="dot" style="background:${esc(c.color)};display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px"></span>${esc(c.name)}</div>`).join('') || '<div style="color:var(--dim)">Brak kolekcji</div>'}</div>
    <div class="btns"><button class="btn" id="mNew">+ Nowa kolekcja</button><span style="flex:1"></span><button class="btn" id="mNo">Anuluj</button></div>`, (box, close) => {
    box.querySelector('#mList').onclick = (e) => { const d = e.target.closest('[data-c]'); if (d) { close(true); addToCollection(d.dataset.c, rels); } };
    box.querySelector('#mNew').onclick = () => { close(true); newCollection(rels); };
    box.querySelector('#mNo').onclick = () => close(null);
  });
}
function collectionMenu(c, x, y) {
  ctxMenu(x, y, [
    { label: 'Zmień nazwę…', action: async () => { const n = await promptModal('Nazwa kolekcji', c.name, 'Zapisz'); if (n) saveCollections(collections().map((k) => (k.id === c.id ? { ...k, name: n } : k))); } },
    { label: 'Zmień kolor', action: () => saveCollections(collections().map((k) => (k.id === c.id ? { ...k, color: COLL_COLORS[(COLL_COLORS.indexOf(k.color) + 1) % COLL_COLORS.length] } : k))) },
    '-',
    { label: 'Usuń kolekcję (pliki zostają)', danger: true, action: async () => {
      if (!(await confirmModal(`Usunąć kolekcję „${esc(c.name)}”?`, 'Modele zostaną na swoich miejscach, zniknie tylko kolekcja.', 'Usuń'))) return;
      for (const f of lib.files) if ((metaOf(f.rel).collections || []).includes(c.id)) await setMeta(f.rel, { collections: metaOf(f.rel).collections.filter((x) => x !== c.id) });
      if (st.special === 'coll' && st.coll === c.id) st.special = 'all';
      saveCollections(collections().filter((k) => k.id !== c.id));
      renderGrid();
    } },
  ]);
}

// ---------- klienci ----------
const clientById = (id) => (S.clients || []).find((c) => c.id === id) || null;
function clientModal(c = null) {
  const v = c || { name: '', email: '', phone: '', address: '', notes: '' };
  return modal(`<h3>${c ? 'Klient' : 'Nowy klient'}</h3>
    <div class="form">
      <label>Imię i nazwisko / firma<input class="field" id="cName" value="${esc(v.name)}"></label>
      <div class="two"><label>E-mail<input class="field" id="cEmail" value="${esc(v.email)}"></label><label>Telefon<input class="field" id="cPhone" value="${esc(v.phone)}"></label></div>
      <label>Adres<input class="field" id="cAddr" value="${esc(v.address)}"></label>
      <label>Notatki<textarea class="notes" id="cNotes">${esc(v.notes)}</textarea></label>
    </div>
    <div class="btns">${c ? '<button class="btn danger" id="cDel">Usuń</button><span style="flex:1"></span>' : ''}<button class="btn" id="mNo">Anuluj</button><button class="btn primary" id="mOk">Zapisz</button></div>`, (box, close) => {
    box.querySelector('#cName').focus();
    box.querySelector('#mNo').onclick = () => close(null);
    box.querySelector('#mOk').onclick = () => {
      const name = box.querySelector('#cName').value.trim();
      if (!name) return toast('Podaj nazwę klienta', true);
      const data = { name, email: box.querySelector('#cEmail').value.trim(), phone: box.querySelector('#cPhone').value.trim(), address: box.querySelector('#cAddr').value.trim(), notes: box.querySelector('#cNotes').value };
      if (c) Object.assign(c, data); else S.clients.push({ id: 'k' + Date.now().toString(36), createdAt: Date.now(), ...data });
      saveSettings(); close(c || S.clients[S.clients.length - 1]);
    };
    const del = box.querySelector('#cDel');
    if (del) del.onclick = () => { S.clients = S.clients.filter((x) => x !== c); saveSettings(); close('deleted'); };
  });
}
function clientOptions(sel) {
  return `<option value="">— bez klienta —</option>${(S.clients || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'pl')).map((c) => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="__new">+ Nowy klient…</option>`;
}
let ordersClient = null;
function renderClients() {
  const el = $('#clients');
  const c = cur();
  const rows = (S.clients || []).map((k) => {
    const os = S.orders.filter((o) => o.clientId === k.id);
    const done = os.filter((o) => o.status === 'done');
    const last = os.reduce((m, o) => Math.max(m, o.createdAt), 0);
    return { k, n: os.length, revenue: done.reduce((a, o) => a + finalPrice(o), 0), profit: done.reduce((a, o) => a + finalPrice(o) - o.totals.cost, 0), last };
  }).sort((a, b) => b.revenue - a.revenue || a.k.name.localeCompare(b.k.name, 'pl'));
  el.innerHTML = `<div class="order-head"><div class="vtitle">Klienci</div><span class="vsub">${rows.length} w bazie</span><span style="flex:1"></span><button class="btn primary" id="clNew">+ Nowy klient</button></div>
    ${rows.length ? `<table class="otable"><thead><tr><th>Klient</th><th>Kontakt</th><th class="r">Zamówienia</th><th class="r">Przychód</th><th class="r">Zysk</th><th>Ostatnie</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr data-id="${esc(r.k.id)}"><td><b>${esc(r.k.name)}</b>${r.k.notes ? `<small class="cl-note">${esc(r.k.notes.slice(0, 80))}</small>` : ''}</td>
      <td class="small">${[r.k.email, r.k.phone].filter(Boolean).map(esc).join('<br>') || '—'}</td><td class="r mono">${r.n}</td><td class="r mono">${fmtMoney(r.revenue, c)}</td><td class="r mono">${fmtMoney(r.profit, c)}</td>
      <td class="small">${r.last ? new Date(r.last).toLocaleDateString('pl-PL') : '—'}</td>
      <td class="r nowrap"><button class="btn" data-orders>Zamówienia</button><button class="icon-btn" data-edit title="Edytuj">✎</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty-order"><div class="big">Brak klientów</div>Dodaj klienta tutaj albo wybierz „+ Nowy klient…” w wycenie zamówienia.</div>'}`;
  $('#clNew').onclick = async () => { if (await clientModal()) renderClients(); };
  el.querySelectorAll('tbody tr').forEach((tr) => {
    const k = clientById(tr.dataset.id);
    tr.querySelector('[data-edit]').onclick = async () => { if (await clientModal(k)) renderClients(); };
    tr.querySelector('[data-orders]').onclick = () => { ordersClient = k.id; ordersFilter = 'all'; setView({ special: 'orders' }); };
  });
}

// ---------- oferta PDF ----------
async function ensureThumb(rel) {
  if (thumbs.has(rel) && thumbs.get(rel) !== 'none') return thumbs.get(rel);
  await requestThumb(rel, true);
  for (let i = 0; i < 60 && !thumbs.has(rel); i++) await new Promise((r) => setTimeout(r, 250));
  const t = thumbs.get(rel);
  return t && t !== 'none' ? t : null;
}
async function buildOfferHtml({ no, name, client, items, total, cost, createdAt }) {
  const b = S.business, c = cur();
  // podział ceny na pozycje proporcjonalnie do kosztu pozycji
  const costs = items.map((it) => priceItems([{ parts: it.parts, minutes: it.minutes, qty: it.qty, plates: it.plates }], P(), false).cost);
  const sumC = costs.reduce((a, x) => a + x, 0) || 1;
  let left = Math.round(total * 100);
  const prices = costs.map((x, i) => { if (i === costs.length - 1) return left / 100; const v = Math.round(total * (x / sumC) * 100); left -= v; return v / 100; });
  const thumbsHtml = await Promise.all(items.map((it) => (it.rel ? ensureThumb(it.rel) : null)));
  const date = new Date(createdAt || Date.now());
  const valid = new Date(date.getTime() + (b.validityDays || 14) * 86400000);
  const e = esc;
  return `<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8"><title>Oferta ${e(no || '')}</title><style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; color: #1d2026; font-size: 11pt; }
    .page { padding: 18mm 18mm 16mm; }
    header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #f2a03d; padding-bottom: 10mm; margin-bottom: 8mm; }
    .biz b { font-size: 16pt; display: block; margin-bottom: 2mm; }
    .biz, .meta { line-height: 1.5; font-size: 9.5pt; color: #4a505a; }
    .meta { text-align: right; }
    .meta h1 { margin: 0 0 3mm; font-size: 22pt; color: #1d2026; letter-spacing: .5px; }
    .to { margin-bottom: 8mm; font-size: 10pt; line-height: 1.5; }
    .to small { color: #8a909a; text-transform: uppercase; letter-spacing: .8px; font-size: 8pt; display: block; margin-bottom: 1mm; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: .7px; color: #8a909a; border-bottom: 1px solid #d9dce1; padding: 2mm 2mm; }
    td { border-bottom: 1px solid #eceef1; padding: 3mm 2mm; vertical-align: middle; }
    td.r, th.r { text-align: right; white-space: nowrap; }
    .th { width: 18mm; } .th img { width: 16mm; height: 16mm; object-fit: contain; background: #f4f5f7; border-radius: 2mm; display: block; }
    .th div { width: 16mm; height: 16mm; background: #f4f5f7; border-radius: 2mm; }
    .nm b { display: block; } .nm small { color: #8a909a; font-size: 8.5pt; }
    .sum { margin-top: 6mm; display: flex; justify-content: flex-end; }
    .sum div { min-width: 70mm; border-top: 2px solid #1d2026; padding-top: 3mm; display: flex; justify-content: space-between; font-size: 14pt; font-weight: 700; }
    .notes { margin-top: 10mm; font-size: 9pt; color: #4a505a; line-height: 1.6; }
    footer { margin-top: 14mm; font-size: 8.5pt; color: #8a909a; border-top: 1px solid #eceef1; padding-top: 4mm; }
  </style></head><body><div class="page">
    <header><div class="biz"><b>${e(b.name || 'Druk 3D')}</b>${[b.address, b.email, b.phone, b.taxId ? 'NIP: ' + b.taxId : ''].filter(Boolean).map(e).join('<br>')}</div>
      <div class="meta"><h1>OFERTA</h1>${no ? `Nr ${e(no)}<br>` : ''}Data: ${date.toLocaleDateString('pl-PL')}<br>Ważna do: ${valid.toLocaleDateString('pl-PL')}</div></header>
    ${client ? `<div class="to"><small>Dla</small><b>${e(client.name)}</b>${[client.address, client.email, client.phone].filter(Boolean).map((x) => '<br>' + e(x)).join('')}</div>` : ''}
    ${name ? `<div class="to"><small>Dotyczy</small>${e(name)}</div>` : ''}
    <table><thead><tr><th></th><th>Pozycja</th><th>Materiał</th><th class="r">Ilość</th>${b.showItemPrices ? '<th class="r">Cena</th>' : ''}</tr></thead><tbody>
      ${items.map((it, i) => `<tr><td class="th">${thumbsHtml[i] ? `<img src="${thumbsHtml[i]}">` : '<div></div>'}</td>
        <td class="nm"><b>${e(it.name)}</b><small>${it.plates > 1 ? `${it.plates} płyty · ` : ''}${fmtNum(it.parts.reduce((a, p) => a + (p.grams || 0), 0), 0)} g · ${fmtDuration(it.minutes)}</small></td>
        <td>${[...new Set(it.parts.map((p) => p.filament ? `${p.filament.type || ''} ${p.filament.color}`.trim() : ''))].filter(Boolean).map(e).join(', ')}</td>
        <td class="r">${it.qty} szt.</td>${b.showItemPrices ? `<td class="r">${fmtMoney(prices[i], c)}</td>` : ''}</tr>`).join('')}
    </tbody></table>
    <div class="sum"><div><span>Razem</span><span>${fmtMoney(total, c)}</span></div></div>
    ${b.bank ? `<div class="notes">Płatność: ${e(b.bank)}</div>` : ''}
    <footer>${e(b.footer || '')}</footer>
  </div></body></html>`;
}
async function offerFromCurrentOrder() {
  const lines = orderLines().filter((l) => !l.missing && l.qty > 0);
  if (!lines.length) return toast('Wycena jest pusta', true);
  const r = priceItems(lines.map(lineItem), P());
  const html = await buildOfferHtml({ no: null, name: order().name, client: clientById(order().clientId), items: lines.map((l) => ({ rel: l.f ? l.f.rel : null, name: l.name, qty: l.qty, minutes: l.minutes || 0, plates: l.plates || 1, parts: l.parts.map((p) => ({ grams: p.grams || 0, filament: p.filament })) })), total: P().margin > 0 || P().roundTo > 0 ? r.price : r.cost, cost: r.cost });
  const p = await safe(() => api.savePdf(html, `Oferta - ${(order().name || 'wycena').replace(/[\\/:*?"<>|]/g, '_')}.pdf`));
  if (p) toast('Zapisano ofertę PDF');
}
async function offerFromOrder(o) {
  const html = await buildOfferHtml({ no: o.no, name: o.name, client: clientById(o.clientId) || (o.clientName ? { name: o.clientName } : null), createdAt: o.createdAt,
    items: o.items.map((it) => ({ rel: it.rel && lib && lib.files.some((f) => f.rel === it.rel) ? it.rel : null, name: it.name, qty: it.qty, minutes: it.minutes, plates: it.plates || 1, parts: it.parts.map((p) => ({ grams: p.grams, filament: filamentById(p.filamentId) || { id: p.filamentId, pricePerKg: p.pricePerKg, color: p.label, type: '' } })) })),
    total: finalPrice(o), cost: o.totals.cost });
  const p = await safe(() => api.savePdf(html, `Oferta ${o.no.replace('/', '-')} - ${o.name.replace(/[\\/:*?"<>|]/g, '_')}.pdf`));
  if (p) toast('Zapisano ofertę PDF');
}

// ---------- kolejka druku ----------
function orderPrintMinutes(o) {
  return o.items.reduce((a, it) => a + (it.minutes || 0) * it.qty, 0);
}
function schedule() {
  const q = S.queue;
  const list = S.orders.filter((o) => o.status === 'printing' || (q.includeQuoted && o.status === 'quoted'))
    .sort((a, b) => (a.queuePos ?? 1e9) - (b.queuePos ?? 1e9) || a.createdAt - b.createdAt);
  const printers = Math.max(1, q.printers | 0);
  const free = new Array(printers).fill(Date.now());
  const hpd = Math.min(24, Math.max(1, Number(q.hoursPerDay) || 24)), sh = Math.min(23, Math.max(0, Number(q.startHour) || 0));
  const align = (t) => { // przesuń start do okna pracy
    if (hpd >= 24) return t;
    const d = new Date(t), dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), sh).getTime(), dayEnd = dayStart + hpd * 3600000;
    if (t < dayStart) return dayStart;
    if (t >= dayEnd) return dayStart + 86400000;
    return t;
  };
  const addWork = (t, min) => { // praca tylko w oknie godzin
    let left = min * 60000; t = align(t);
    while (left > 0) {
      if (hpd >= 24) return t + left;
      const d = new Date(t), dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), sh).getTime() + hpd * 3600000;
      const chunk = Math.min(left, dayEnd - t);
      t += chunk; left -= chunk;
      if (left > 0) t = align(t + 1);
    }
    return t;
  };
  return list.map((o) => {
    let pi = 0; for (let i = 1; i < printers; i++) if (free[i] < free[pi]) pi = i;
    const plates = o.items.reduce((a, it) => a + (it.plates || 1) * it.qty, 0);
    const minutes = orderPrintMinutes(o) + plates * (P().minPerPrint || 0);
    const start = align(free[pi]);
    const end = addWork(start, minutes);
    free[pi] = end;
    const late = o.deadline ? end - new Date(o.deadline + 'T23:59:59').getTime() : -1;
    return { o, printer: pi, start, end, minutes, late };
  });
}
function renderQueue() {
  const el = $('#queue');
  const q = S.queue;
  const sch = schedule();
  const fmtDT = (t) => new Date(t).toLocaleString('pl-PL', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const t0 = Date.now(), t1 = Math.max(t0 + 7 * 86400000, ...sch.map((s) => s.end));
  const span = t1 - t0, W = 1000, rowH = 44, printers = Math.max(1, q.printers | 0);
  const days = Math.ceil(span / 86400000) + 1;
  const dayLines = Array.from({ length: days }, (_, i) => { const d = new Date(new Date(t0).setHours(0, 0, 0, 0) + i * 86400000); const x = (d.getTime() - t0) / span * W; return x >= 0 && x <= W ? `<line x1="${x}" x2="${x}" y1="0" y2="${printers * rowH + 18}" class="gl"/><text x="${x + 4}" y="${printers * rowH + 16}" class="gt">${d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })}</text>` : ''; }).join('');
  const bars = sch.map((s, i) => { const x = (s.start - t0) / span * W, w = Math.max(3, (s.end - s.start) / span * W); return `<g><rect x="${x}" y="${s.printer * rowH + 3}" width="${w}" height="${rowH - 6}" rx="4" class="gbar ${s.late > 0 ? 'late' : ''} ${s.o.status}"><title>${esc(s.o.no + ' ' + s.o.name)}</title></rect>${w > 60 ? `<text x="${x + 6}" y="${s.printer * rowH + rowH / 2 + 4}" class="bt">${esc(s.o.no)}</text>` : ''}</g>`; }).join('');
  el.innerHTML = `<div class="order-head"><div class="vtitle">Kolejka druku</div><span class="vsub">${sch.length} zamówień · ${fmtDuration(sch.reduce((a, s) => a + s.minutes, 0))} pracy drukarek</span><span style="flex:1"></span></div>
    <div class="qsettings">
      <label>Drukarki <input type="number" id="qP" min="1" max="20" value="${q.printers}"></label>
      <label>Druk od <input type="number" id="qS" min="0" max="23" value="${q.startHour}">:00</label>
      <label>przez <input type="number" id="qH" min="1" max="24" value="${q.hoursPerDay}"> h dziennie</label>
      <label class="check"><input type="checkbox" id="qQ" ${q.includeQuoted ? 'checked' : ''}> uwzględnij też „Wycenione”</label>
    </div>
    ${sch.length ? `<svg class="gantt" viewBox="0 0 ${W} ${printers * rowH + 22}">${dayLines}${bars}</svg>
    <table class="otable queue"><thead><tr><th></th><th>Nr</th><th>Zamówienie</th><th>Klient</th><th class="r">Czas</th><th>Start</th><th>Koniec</th><th>Termin</th><th></th></tr></thead><tbody>
    ${sch.map((s, i) => `<tr data-id="${esc(s.o.id)}" class="${s.late > 0 ? 'late' : ''}"><td class="nowrap"><button class="icon-btn" data-up ${i === 0 ? 'disabled' : ''}>▲</button><button class="icon-btn" data-down ${i === sch.length - 1 ? 'disabled' : ''}>▼</button></td>
      <td class="mono">${esc(s.o.no)}</td><td>${esc(s.o.name)}${printers > 1 ? `<small class="cl-note">drukarka ${s.printer + 1}</small>` : ''}</td><td class="small">${esc((clientById(s.o.clientId) || {}).name || s.o.clientName || '')}</td>
      <td class="r mono">${fmtDuration(s.minutes)}</td><td class="small">${fmtDT(s.start)}</td><td class="small"><b>${fmtDT(s.end)}</b></td>
      <td><input type="date" class="cell date" data-deadline value="${esc(s.o.deadline || '')}"></td>
      <td class="small">${s.o.deadline ? (s.late > 0 ? `<span class="late-badge">spóźnione o ${Math.ceil(s.late / 86400000)} d</span>` : '<span class="ok-badge">na czas</span>') : ''}</td></tr>`).join('')}</tbody></table>
    <p class="hint">Czas obejmuje druk wszystkich płyt i ${P().minPerPrint} min obsługi na płytę. Drukarka pracuje od ${q.startHour}:00 przez ${q.hoursPerDay} h dziennie (24 = bez przerw).</p>`
    : '<div class="empty-order"><div class="big">Kolejka jest pusta</div>Zamówienia ze statusem „W druku” pojawią się tutaj z przewidywanym terminem ukończenia.</div>'}`;
  const num = (id, k, min, max) => { const i = $(id); i.onchange = () => { q[k] = Math.min(max, Math.max(min, parseInt(i.value, 10) || min)); saveSettings(); renderQueue(); }; };
  num('#qP', 'printers', 1, 20); num('#qS', 'startHour', 0, 23); num('#qH', 'hoursPerDay', 1, 24);
  $('#qQ').onchange = (e) => { q.includeQuoted = e.target.checked; saveSettings(); renderQueue(); };
  el.querySelectorAll('tbody tr').forEach((tr, i) => {
    const o = S.orders.find((x) => x.id === tr.dataset.id);
    const move = (d) => { const ids = sch.map((s) => s.o); const j = i + d; [ids[i], ids[j]] = [ids[j], ids[i]]; ids.forEach((x, k) => { x.queuePos = k; }); saveSettings(); renderQueue(); };
    tr.querySelector('[data-up]').onclick = () => move(-1);
    tr.querySelector('[data-down]').onclick = () => move(1);
    tr.querySelector('[data-deadline]').onchange = (e) => { o.deadline = e.target.value || null; saveSettings(); renderQueue(); };
  });
}

// ---------- statystyki (wykresy) ----------
function statsHtml() {
  const c = cur();
  const done = S.orders.filter((o) => o.status === 'done');
  if (!done.length) return '<div class="muted-note" style="padding:8px 0">Wykresy pojawią się po pierwszym zamówieniu ze statusem „Wydane”.</div>';
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  const agg = months.map((m) => { const os = done.filter((o) => monthKey(o.statusAt?.done || o.createdAt) === m); const rev = os.reduce((a, o) => a + finalPrice(o), 0), cost = os.reduce((a, o) => a + o.totals.cost, 0); return { m, rev, cost, profit: rev - cost }; });
  const max = Math.max(1, ...agg.map((a) => Math.max(a.rev, a.cost)));
  const W = 720, H = 190, pad = 34, bw = (W - pad) / 12;
  const y = (v) => H - 22 - (v / max) * (H - 40);
  const ticks = [0, 0.5, 1].map((t) => max * t);
  const chart = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Przychód, koszt i zysk w ostatnich 12 miesiącach">
    ${ticks.map((t) => `<line x1="${pad}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="gl"/><text x="${pad - 4}" y="${y(t) + 3}" class="gt" text-anchor="end">${Math.round(t)}</text>`).join('')}
    ${agg.map((a, i) => { const x = pad + i * bw; const lbl = new Date(+a.m.slice(0, 4), +a.m.slice(5) - 1, 1).toLocaleDateString('pl-PL', { month: 'short' });
      return `<g><rect x="${x + bw * 0.14}" y="${y(a.rev)}" width="${bw * 0.34}" height="${H - 22 - y(a.rev)}" rx="2" class="b-rev"><title>${lbl}: przychód ${fmtMoney(a.rev, c)}</title></rect>
      <rect x="${x + bw * 0.52}" y="${y(a.cost)}" width="${bw * 0.34}" height="${H - 22 - y(a.cost)}" rx="2" class="b-cost"><title>${lbl}: koszt ${fmtMoney(a.cost, c)}</title></rect>
      ${a.rev ? `<text x="${x + bw / 2}" y="${y(Math.max(a.rev, a.cost)) - 4}" class="gv" text-anchor="middle">${a.profit >= 0 ? '+' : ''}${Math.round(a.profit)}</text>` : ''}
      <text x="${x + bw / 2}" y="${H - 6}" class="gt" text-anchor="middle">${lbl}</text></g>`; }).join('')}
  </svg>
  <div class="legend2"><span><i class="b-rev"></i>Przychód</span><span><i class="b-cost"></i>Koszt własny</span><span>liczba nad słupkami = zysk (${esc(c)})</span></div>`;
  // zysk wg kategorii (folder najwyższego poziomu) – przychód dzielony proporcjonalnie do kosztu pozycji
  const cat = new Map();
  for (const o of done) {
    const costs = o.items.map((it) => priceItems([{ parts: it.parts.map((p) => ({ grams: p.grams, filament: { id: p.filamentId, pricePerKg: p.pricePerKg } })), minutes: it.minutes, qty: it.qty, plates: it.plates || 1 }], P(), false).cost);
    const sum = costs.reduce((a, x) => a + x, 0) || 1;
    o.items.forEach((it, i) => {
      const k = it.rel ? (it.rel.includes('/') ? it.rel.split('/')[0] : '(główny folder)') : 'Pozycje ręczne';
      const share = costs[i] / sum;
      const e = cat.get(k) || { rev: 0, cost: 0, n: 0 };
      e.rev += finalPrice(o) * share; e.cost += o.totals.cost * share; e.n += it.qty;
      cat.set(k, e);
    });
  }
  const cats = [...cat.entries()].map(([k, v]) => ({ k, ...v, profit: v.rev - v.cost })).sort((a, b) => b.profit - a.profit);
  const cmax = Math.max(1, ...cats.map((x) => Math.abs(x.profit)));
  const catHtml = cats.map((x) => `<div class="hbar"><span class="hl" title="${esc(x.k)}">${esc(x.k)}</span><span class="ht"><i style="width:${Math.abs(x.profit) / cmax * 100}%" class="${x.profit < 0 ? 'neg' : ''}"></i></span><b>${fmtMoney(x.profit, c)}</b><small>${x.n} szt. · marża ${x.rev ? Math.round(x.profit / x.rev * 100) : 0}%</small></div>`).join('');
  // zużycie filamentów (wydane)
  const fil = new Map();
  for (const o of done) for (const it of o.items) for (const p of it.parts) { const e = fil.get(p.filamentId || p.label) || { label: p.label, hex: p.hex, g: 0 }; e.g += p.grams * it.qty; fil.set(p.filamentId || p.label, e); }
  const fl = [...fil.values()].sort((a, b) => b.g - a.g);
  const fmax = Math.max(1, ...fl.map((x) => x.g));
  const filHtml = fl.map((x) => `<div class="hbar"><span class="hl">${swatch({ hex: x.hex })}${esc(x.label)}</span><span class="ht"><i style="width:${x.g / fmax * 100}%;background:${esc(x.hex || 'var(--accent)')}"></i></span><b>${fmtNum(x.g / 1000, 2)} kg</b><small></small></div>`).join('');
  return `<div class="stats-grid"><div class="scard wide"><h4>Ostatnie 12 miesięcy</h4>${chart}</div>
    <div class="scard"><h4>Zysk wg kategorii (folderów)</h4>${catHtml}</div>
    <div class="scard"><h4>Zużycie filamentów (wydane zamówienia)</h4>${filHtml}</div></div>`;
}

// ---------- aktualizacje ----------
let updateState = null;
function renderUpdateBanner() {
  const b = $('#updBanner');
  if (!updateState || updateState.state === 'none' || updateState.state === 'error') { b.hidden = true; return; }
  b.hidden = false;
  if (updateState.state === 'available') b.innerHTML = `Dostępna nowa wersja ${esc(updateState.version)} <button class="toast-btn" id="updGo">Pobierz</button><button class="icon-btn" id="updX">✕</button>`;
  if (updateState.state === 'progress') b.innerHTML = `Pobieranie aktualizacji… ${updateState.percent}%`;
  if (updateState.state === 'downloaded') b.innerHTML = `Aktualizacja ${esc(updateState.version)} gotowa <button class="toast-btn" id="updInst">Uruchom ponownie i zainstaluj</button>`;
  const g = $('#updGo'); if (g) g.onclick = () => api.updateDownload();
  const x = $('#updX'); if (x) x.onclick = () => { b.hidden = true; };
  const i = $('#updInst'); if (i) i.onclick = () => api.updateInstall();
}
api.onUpdate((d) => { updateState = d; renderUpdateBanner(); if (d.state === 'error' && d.manual) toast('Nie udało się sprawdzić aktualizacji', true); });
api.onInboxAdded((d) => {
  toast(`Nowe w „${S.inbox.target}”: ${d.added.length === 1 ? baseName(d.added[0]) : d.added.length + ' pliki'} (z ${d.file})`, false, { label: 'Pokaż', fn: () => setView({ special: 'folder', folder: S.inbox.target }) });
});

// ---------- ustawienia: okno ----------
function openSettings(tab = 'appearance') {
  return modal(`<div class="settings">
    <div class="s-head"><h3>Ustawienia</h3>
      <div class="tabs"><button data-tab="appearance">Wygląd</button><button data-tab="pricing">Wycena</button><button data-tab="filaments">Filamenty</button><button data-tab="slicers">Slicery</button><button data-tab="inbox">Pobrane</button><button data-tab="business">Oferta</button><button data-tab="backup">Kopia</button><button data-tab="about">O programie</button></div></div>
    <div class="s-body" id="sBody"></div>
    <div class="btns"><button class="btn" id="sReset">Przywróć domyślne</button><span style="flex:1"></span><button class="btn primary" id="sClose">Gotowe</button></div>
  </div>`, (box, close) => {
    box.classList.add('wide');
    const body = box.querySelector('#sBody');
    let current = tab;
    const show = (t) => {
      current = t;
      box.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
      ({ appearance: tabAppearance, pricing: tabPricing, filaments: tabFilaments, slicers: tabSlicers, inbox: tabInbox, business: tabBusiness, backup: tabBackup, about: tabAbout })[t](body);
      box.querySelector('#sReset').hidden = !['appearance', 'pricing', 'filaments'].includes(t);
    };
    box.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => show(b.dataset.tab));
    box.querySelector('#sClose').onclick = () => close(true);
    let armed = false;
    box.querySelector('#sReset').onclick = async (e) => {
      const btn = e.currentTarget;
      if (!armed) {
        armed = true; btn.textContent = 'Kliknij ponownie, aby potwierdzić';
        setTimeout(() => { armed = false; btn.textContent = 'Przywróć domyślne'; }, 3500);
        return;
      }
      armed = false; btn.textContent = 'Przywróć domyślne';
      const d = await api.defaultSettings();
      if (current === 'appearance') S.appearance = d.appearance;
      if (current === 'pricing') S.pricing = { ...d.pricing, defaultFilament: P().defaultFilament };
      if (current === 'filaments') { S.filaments = d.filaments; if (!filamentById(P().defaultFilament)) P().defaultFilament = d.pricing.defaultFilament; }
      saveSettings(); applyAppearance(current === 'appearance'); afterPricingChange();
      toast('Przywrócono domyślne');
      show(current);
    };
    show(tab);
  }).then(() => { afterPricingChange(); });
}

function tabAppearance(body) {
  const a = S.appearance;
  const presets = ['#f2a03d', '#e9e9e4', '#9aa3ad', '#3f9c4f', '#4a86e8', '#d9534f', '#8e6cd8', '#2b2d31', '#d4a446', '#3ec7c2'];
  body.innerHTML = `
    <div class="label">Kolor modelu w podglądzie i na miniaturach</div>
    <div class="row"><input type="color" id="aColor" value="${esc(a.modelColor)}">
      <div class="presets">${presets.map((p) => `<button class="preset ${p === a.modelColor ? 'on' : ''}" data-c="${p}" style="background:${p}" title="${p}"></button>`).join('')}</div></div>
    <label class="check"><input type="checkbox" id="aFil" ${a.useFilamentColor ? 'checked' : ''}> W podglądzie 3D używaj koloru filamentu przypisanego do modelu</label>
    <p class="hint">Miniatury przerysują się w nowym kolorze. Miniatury z obrazków i osadzone przez slicer pozostają bez zmian.</p>
    <div class="label">Domyślny kąt kamery na miniaturach</div>
    <div class="seg" id="aPreset">${[['iso', 'Izometryczny'], ['front', 'Przód'], ['side', 'Bok'], ['top', 'Góra'], ['back', 'Tył']].map(([k, v]) => `<button data-p="${k}" class="${S.thumbs.preset === k ? 'on' : ''}">${v}</button>`).join('')}</div>
    <p class="hint">Dla pojedynczego modelu ustawisz własny kąt w panelu modelu („Miniatura → Z obecnego widoku”) albo przyciskiem ◉ w podglądzie.</p>
    <div class="label">Pamięć podręczna</div>
    <button class="btn" id="aClear">Wyczyść i wygeneruj miniatury od nowa</button>`;
  const setColor = (c) => { a.modelColor = c; saveSettings(); applyAppearance(true); body.querySelectorAll('.preset').forEach((p) => p.classList.toggle('on', p.dataset.c === c)); body.querySelector('#aColor').value = c; };
  body.querySelector('#aColor').onchange = (e) => setColor(e.target.value);
  body.querySelectorAll('.preset').forEach((p) => p.onclick = () => setColor(p.dataset.c));
  body.querySelector('#aFil').onchange = (e) => { a.useFilamentColor = e.target.checked; saveSettings(); applyAppearance(false); };
  body.querySelectorAll('#aPreset [data-p]').forEach((b) => b.onclick = () => { S.thumbs.preset = b.dataset.p; saveSettings(); body.querySelectorAll('#aPreset [data-p]').forEach((x) => x.classList.toggle('on', x === b)); applyAppearance(true); });
  body.querySelector('#aClear').onclick = async () => { await api.clearThumbs(); applyAppearance(true); toast('Miniatury zostaną wygenerowane ponownie'); };
}

const PRICING_FIELDS = [
  ['Prąd', [
    ['printerW', 'Moc drukarki w trakcie druku', 'W'],
    ['startKWh', 'Energia na rozgrzanie i start jednego wydruku', 'kWh'],
    ['kWhPrice', 'Cena prądu (brutto z dystrybucją)', 'zł/kWh'],
  ]],
  ['Drukarka', [
    ['printerPrice', 'Cena drukarki', 'zł'],
    ['printerLife', 'Żywotność drukarki', 'h'],
    ['servicePerH', 'Serwis i części (dysze, PEI, pasek…)', 'zł/h'],
  ]],
  ['Twój czas', [
    ['hourRate', 'Stawka za Twój czas', 'zł/h'],
    ['minPerPrint', 'Czas na jeden wydruk (przygotowanie, zdjęcie, obróbka)', 'min'],
    ['minPerOrder', 'Czas na całe zamówienie (kontakt, pakowanie)', 'min'],
  ]],
  ['Cena', [
    ['buffer', 'Bufor na nieudane wydruki', '%', true],
    ['margin', 'Marża (cena dla klienta)', '%', true],
    ['roundTo', 'Zaokrąglaj cenę dla klienta w górę do', 'zł'],
  ]],
  ['Wydruki wielokolorowe (szacunki, gdy brak danych ze slicera)', [
    ['purgePerChange', 'Filament zużyty na jedną zmianę koloru (purge + wieża)', 'g'],
    ['changeTimeSec', 'Czas jednej zmiany koloru', 's'],
    ['layerHeight', 'Wysokość warstwy (do liczenia zmian koloru)', 'mm'],
    ['paintWall', 'Grubość malowanej warstwy koloru', 'mm'],
  ]],
  ['Szacunki dla plików bez danych ze slicera', [
    ['estFill', 'Jaka część objętości modelu to plastik (ściany + wypełnienie)', '%', true],
    ['estGramsPerHour', 'Wydajność drukarki', 'g/h'],
  ]],
];
function tabPricing(body) {
  const p = P();
  body.innerHTML = `${PRICING_FIELDS.map(([g, fields]) => `<div class="label">${g}</div><div class="fields">${fields.map(([k, label, unit, pct]) => `
      <label class="fld"><span>${label}</span><span class="inp"><input type="number" step="any" min="0" data-k="${k}" ${pct ? 'data-pct' : ''} value="${pct ? +(p[k] * 100).toFixed(4) : p[k]}"><em>${unit === 'zł' || unit.startsWith('zł/') ? unit.replace('zł', esc(cur())) : unit}</em></span></label>`).join('')}</div>`).join('')}
    <div class="label">Inne</div><div class="fields">
      <label class="fld"><span>Domyślny filament</span><span class="inp"><select id="pDef">${filamentOptions(p.defaultFilament, false)}</select></span></label>
      <label class="fld"><span>Waluta</span><span class="inp"><input id="pCur" value="${esc(p.currency)}" style="width:80px"></span></label>
    </div>`;
  body.querySelectorAll('input[data-k]').forEach((inp) => inp.oninput = () => {
    const v = parseFloat(inp.value);
    if (!Number.isFinite(v) || v < 0) return;
    p[inp.dataset.k] = inp.hasAttribute('data-pct') ? v / 100 : v;
    saveSettings();
  });
  body.querySelector('#pDef').onchange = (e) => { p.defaultFilament = e.target.value; saveSettings(); };
  body.querySelector('#pCur').oninput = (e) => { p.currency = e.target.value.trim() || 'zł'; saveSettings(); };
}

function tabFilaments(body) {
  const types = ['PLA', 'PLA+', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'Inny'];
  const draw = () => {
    body.innerHTML = `<p class="hint" style="margin-top:0">Cena za kg służy do wyceny, gęstość do przeliczeń z objętości, a kolor do podglądu 3D i automatycznego dopasowania szpul do kolorów z pliku. Stan szpul ustawisz w widoku „Magazyn filamentów”.</p>
    <table class="ftable"><thead><tr><th></th><th>Nazwa</th><th>Kolor</th><th>Typ</th><th class="r">Cena/kg</th><th class="r">Gęstość</th><th class="r" title="Waga filamentu na pełnej szpuli">Szpula (g)</th><th title="Domyślny">★</th><th></th></tr></thead><tbody>
    ${S.filaments.map((fl) => `<tr data-id="${esc(fl.id)}">
      <td><input type="color" data-k="hex" value="${esc(fl.hex || '#888888')}"></td>
      <td><input data-k="name" value="${esc(fl.name)}" spellcheck="false"></td>
      <td><input data-k="color" value="${esc(fl.color)}" spellcheck="false"></td>
      <td><select data-k="type">${types.map((t) => `<option ${t === fl.type ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
      <td><input data-k="pricePerKg" type="number" step="0.01" min="0" class="num" value="${fl.pricePerKg}"></td>
      <td><input data-k="density" type="number" step="0.01" min="0" class="num" value="${fl.density}"></td>
      <td><input data-k="spoolWeight" type="number" step="50" min="0" class="num" value="${fl.spoolWeight || 1000}"></td>
      <td><input type="radio" name="fdef" ${P().defaultFilament === fl.id ? 'checked' : ''} title="Ustaw jako domyślny"></td>
      <td><button class="icon-btn" data-del title="Usuń">✕</button></td></tr>`).join('')}
    </tbody></table>
    <button class="btn" id="fAdd" style="margin-top:10px">+ Dodaj filament</button>`;
    body.querySelectorAll('tbody tr').forEach((tr) => {
      const fl = S.filaments.find((x) => x.id === tr.dataset.id);
      tr.querySelectorAll('[data-k]').forEach((inp) => {
        const ev = inp.type === 'color' || inp.tagName === 'SELECT' ? 'onchange' : 'oninput';
        inp[ev] = () => {
          const k = inp.dataset.k;
          fl[k] = (k === 'pricePerKg' || k === 'density' || k === 'spoolWeight') ? (parseFloat(inp.value) || 0) : inp.value;
          saveSettings();
          if (k === 'hex') applyAppearance(false);
        };
      });
      tr.querySelector('input[type=radio]').onchange = () => { P().defaultFilament = fl.id; saveSettings(); };
      tr.querySelector('[data-del]').onclick = () => {
        if (S.filaments.length <= 1) return toast('Musi zostać co najmniej jeden filament', true);
        S.filaments = S.filaments.filter((x) => x !== fl);
        if (P().defaultFilament === fl.id) P().defaultFilament = S.filaments[0].id;
        saveSettings(); draw();
      };
    });
    body.querySelector('#fAdd').onclick = () => {
      S.filaments.push({ id: 'f' + Date.now().toString(36), name: 'Nowy filament', color: 'kolor', hex: '#888888', type: 'PLA', pricePerKg: 60, density: 1.24, spoolWeight: 1000, remaining: null });
      saveSettings(); draw();
      body.querySelector('tbody tr:last-child input[data-k="name"]')?.select();
    };
  };
  draw();
}

function tabSlicers(body) {
  const sl = S.slicers;
  const draw = () => {
    const list = sl.list || [];
    body.innerHTML = `<p class="hint" style="margin-top:0">Pokazuję tylko slicery zainstalowane na tym komputerze. Domyślny slicer otwiera się po dwukliku, klawiszem Enter i przyciskiem „Otwórz”. Pozostałe są w menu ▾ i pod prawym przyciskiem.</p>
      <table class="ftable"><thead><tr><th title="Domyślny">★</th><th>Pokazuj</th><th>Slicer</th><th>Ścieżka</th><th></th></tr></thead><tbody>
      ${list.map((x, i) => `<tr data-i="${i}" class="${x.available ? '' : 'unavail'}"><td><input type="radio" name="sdef" ${sl.default === x.id ? 'checked' : ''} ${x.available && x.enabled ? '' : 'disabled'}></td>
        <td><input type="checkbox" data-en ${x.enabled ? 'checked' : ''}></td><td><b>${esc(x.name)}</b>${x.custom ? ' <small class="muted-note" style="padding:0">(własny)</small>' : ''}</td>
        <td class="pathcell" title="${esc(x.path || '')}">${x.available ? esc(x.path) : '<span style="color:var(--red)">nie znaleziono</span>'}</td>
        <td class="nowrap"><button class="btn" data-path>Zmień…</button>${x.custom ? '<button class="icon-btn" data-del>✕</button>' : ''}</td></tr>`).join('')}
      <tr><td><input type="radio" name="sdef" ${sl.default === 'system' ? 'checked' : ''} data-system></td><td></td><td><b>Program domyślny systemu</b></td><td class="pathcell">to, co Windows otwiera dla danego typu pliku</td><td></td></tr>
      </tbody></table>
      <div class="btns" style="justify-content:flex-start"><button class="btn" id="sDetect">Wykryj ponownie</button><button class="btn" id="sAdd">+ Dodaj inny slicer…</button></div>
      ${!list.some((x) => x.available) ? '<p class="hint">Nie znalazłem żadnego slicera w typowych miejscach. Dodaj go ręcznie, wskazując plik .exe.</p>' : ''}`;
    body.querySelectorAll('tbody tr[data-i]').forEach((tr) => {
      const x = list[+tr.dataset.i];
      tr.querySelector('input[type=radio]').onchange = () => { sl.default = x.id; saveSettings(); draw(); };
      tr.querySelector('[data-en]').onchange = (e) => { x.enabled = e.target.checked; if (!x.enabled && sl.default === x.id) { const n = list.find((y) => y.enabled && y.available); sl.default = n ? n.id : 'system'; } saveSettings(); draw(); };
      tr.querySelector('[data-path]').onclick = async () => { const p = await api.slicersPick(); if (p) { x.path = p; x.available = true; saveSettings(); draw(); } };
      const d = tr.querySelector('[data-del]'); if (d) d.onclick = () => { sl.list = list.filter((y) => y !== x); if (sl.default === x.id) sl.default = 'system'; saveSettings(); draw(); };
    });
    body.querySelector('[data-system]').onchange = () => { sl.default = 'system'; saveSettings(); draw(); };
    body.querySelector('#sDetect').onclick = async () => { await api.setSettings(S); const r = await safe(() => api.slicersDetect()); if (r) { S.slicers = r; tabSlicers(body); toast(`Wykryto: ${r.list.filter((x) => x.available).map((x) => x.name).join(', ') || 'brak'}`); } };
    body.querySelector('#sAdd').onclick = async () => {
      const p = await api.slicersPick(); if (!p) return;
      const name = await promptModal('Nazwa slicera', baseName(p.replace(/\\/g, '/')).replace(/\.(exe|app)$/i, ''), 'Dodaj');
      if (!name) return;
      sl.list = [...list, { id: 'custom-' + Date.now().toString(36), name, path: p, enabled: true, available: true, custom: true }];
      saveSettings(); openSettings('slicers');
    };
  };
  draw();
}
function tabInbox(body) {
  const ib = S.inbox;
  body.innerHTML = `<label class="check"><input type="checkbox" id="iEn" ${ib.enabled ? 'checked' : ''}> Śledź foldery i zbieraj nowe modele do folderu biblioteki „${esc(ib.target)}”</label>
    <p class="hint">Nowe pliki STL, 3MF, OBJ, STEP, G-code… pobrane po włączeniu tej opcji trafią do skrzynki. Archiwa ZIP z modelami (np. z Printables) zostaną rozpakowane do osobnego folderu, a sam ZIP zostaje w Pobranych.</p>
    <div class="label">Śledzone foldery</div>
    <div class="folders-list">${(ib.folders || []).map((f, i) => `<div class="frow"><span class="pathcell">${esc(f)}</span><button class="icon-btn" data-rm="${i}">✕</button></div>`).join('') || '<div class="muted-note">brak</div>'}</div>
    <button class="btn" id="iAddF" style="margin-top:6px">+ Dodaj folder…</button>
    <div class="label">Ustawienia</div>
    <div class="fields">
      <label class="fld"><span>Pliki z folderu</span><span class="inp"><select id="iMode"><option value="move" ${ib.mode === 'move' ? 'selected' : ''}>przenoś do biblioteki</option><option value="copy" ${ib.mode === 'copy' ? 'selected' : ''}>kopiuj (zostaw w Pobranych)</option></select></span></label>
      <label class="fld"><span>Folder skrzynki w bibliotece</span><span class="inp"><input id="iTarget" value="${esc(ib.target)}" style="width:200px"></span></label>
      <label class="fld"><span>Rozpakowuj archiwa ZIP z modelami</span><span class="inp"><input type="checkbox" id="iZip" ${ib.unzip ? 'checked' : ''}></span></label>
    </div>
    <button class="btn" id="iExisting" style="margin-top:12px" ${ib.enabled ? '' : 'disabled'}>Zaimportuj też modele, które już są w tych folderach</button>`;
  const apply = async () => { saveSettings(); await api.setSettings(S); await api.inboxApply(); renderSidebar(); };
  body.querySelector('#iEn').onchange = async (e) => { ib.enabled = e.target.checked; if (ib.enabled) ib.enabledAt = Date.now(); await apply(); tabInbox(body); };
  body.querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => { ib.folders.splice(+b.dataset.rm, 1); await apply(); tabInbox(body); });
  body.querySelector('#iAddF').onclick = async () => { const p = await api.inboxPickFolder(); if (p) { ib.folders = [...(ib.folders || []), p]; await apply(); tabInbox(body); } };
  body.querySelector('#iMode').onchange = async (e) => { ib.mode = e.target.value; await apply(); };
  body.querySelector('#iTarget').onchange = async (e) => { const v = e.target.value.trim().replace(/[\\:*?"<>|]/g, '_'); if (v) { ib.target = v; await apply(); } };
  body.querySelector('#iZip').onchange = async (e) => { ib.unzip = e.target.checked; await apply(); };
  body.querySelector('#iExisting').onclick = async () => { const n = await safe(() => api.inboxScanExisting()); if (n != null) toast(n ? `Importuję ${n} plików…` : 'Nie znalazłem modeli w śledzonych folderach'); };
}
function tabBusiness(body) {
  const b = S.business;
  const f = (k, label, w = 320) => `<label class="fld"><span>${label}</span><span class="inp"><input data-k="${k}" value="${esc(b[k] || '')}" style="width:${w}px"></span></label>`;
  body.innerHTML = `<p class="hint" style="margin-top:0">Te dane trafią na ofertę PDF dla klienta (przycisk „Oferta PDF” w wycenie i przy zamówieniach).</p>
    <div class="fields">${f('name', 'Nazwa (firma lub imię i nazwisko)')}${f('address', 'Adres')}${f('email', 'E-mail')}${f('phone', 'Telefon', 200)}${f('taxId', 'NIP (opcjonalnie)', 200)}${f('bank', 'Płatność / numer konta', 320)}${f('footer', 'Stopka', 320)}
      <label class="fld"><span>Oferta ważna przez</span><span class="inp"><input type="number" data-k="validityDays" min="1" value="${b.validityDays}" style="width:80px"><em>dni</em></span></label>
      <label class="fld"><span>Pokazuj ceny poszczególnych pozycji</span><span class="inp"><input type="checkbox" id="bItem" ${b.showItemPrices ? 'checked' : ''}></span></label>
    </div>`;
  body.querySelectorAll('input[data-k]').forEach((i) => i.oninput = () => { b[i.dataset.k] = i.type === 'number' ? Math.max(1, parseInt(i.value, 10) || 14) : i.value; saveSettings(); });
  body.querySelector('#bItem').onchange = (e) => { b.showItemPrices = e.target.checked; saveSettings(); };
}
async function tabBackup(body) {
  const list = await api.backupList().catch(() => []);
  body.innerHTML = `<p class="hint" style="margin-top:0">Kopia obejmuje ustawienia, filamenty, magazyn, klientów, historię zamówień oraz tagi i notatki bieżącej biblioteki. Same pliki modeli nie są kopiowane.</p>
    <label class="check"><input type="checkbox" id="bkAuto" ${S.backup.auto ? 'checked' : ''}> Automatyczna kopia raz dziennie (trzymam ${S.backup.keep} ostatnich)</label>
    <div class="btns" style="justify-content:flex-start"><button class="btn primary" id="bkNow">Zrób kopię teraz</button><button class="btn" id="bkExp">Eksportuj do pliku…</button><button class="btn" id="bkImp">Importuj z pliku…</button><button class="btn" id="bkDir">Otwórz folder kopii</button></div>
    <label class="check"><input type="checkbox" id="bkLib" checked> Przy przywracaniu nadpisz też tagi i notatki bieżącej biblioteki</label>
    <div class="label">Ostatnie kopie</div>
    <div class="folder-pick bk-list">${list.map((x) => { const m = x.name.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/); return `<div class="frow"><span>${m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : esc(x.name)}</span><small>${fmtSize(x.size)}</small><button class="btn" data-restore="${esc(x.name)}">Przywróć</button></div>`; }).join('') || '<div class="muted-note">Brak kopii</div>'}</div>`;
  const after = async (newS) => { if (!newS) return; S = newS; setModelColor(S.appearance.modelColor); thumbs.clear(); await reload(); toast('Przywrócono dane z kopii'); tabBackup(body); };
  body.querySelector('#bkAuto').onchange = (e) => { S.backup.auto = e.target.checked; saveSettings(); };
  body.querySelector('#bkNow').onclick = async () => { await api.setSettings(S); const n = await safe(() => api.backupCreate()); if (n) { toast('Zrobiono kopię'); tabBackup(body); } };
  body.querySelector('#bkExp').onclick = async () => { await api.setSettings(S); const p = await safe(() => api.backupExport()); if (p) toast('Wyeksportowano kopię'); };
  body.querySelector('#bkImp').onclick = async () => after(await safe(() => api.backupImport(body.querySelector('#bkLib').checked)));
  body.querySelector('#bkDir').onclick = () => api.backupOpenDir();
  body.querySelectorAll('[data-restore]').forEach((b) => b.onclick = async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = 'Na pewno?'; setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Przywróć'; }, 3000); return; }
    after(await safe(() => api.backupRestore(b.dataset.restore, body.querySelector('#bkLib').checked)));
  });
}
async function tabAbout(body) {
  const v = await api.appVersion().catch(() => ({ version: '?' }));
  body.innerHTML = `<div class="about"><div class="logo big"></div><div><div class="vtitle">ModelVault ${esc(v.version)}</div><div class="vsub">Menedżer biblioteki modeli 3D z wyceną wydruków</div></div></div>
    <div class="label">Konfiguracja</div>
    <button class="btn" id="abOnb">Uruchom kreator konfiguracji ponownie</button>
    <div class="label">Aktualizacje</div>
    ${v.updater ? `<label class="check"><input type="checkbox" id="upAuto" ${S.updates.auto ? 'checked' : ''}> Sprawdzaj aktualizacje przy starcie</label>
      <button class="btn" id="upNow">Sprawdź teraz</button> <span class="vsub" id="upMsg"></span>`
      : `<p class="hint">${v.portable ? 'To wersja przenośna (ZIP) – aktualizacje automatyczne działają w wersji instalowanej.' : 'Aktualizacje automatyczne działają w zainstalowanej wersji na Windows.'} Nowe wersje znajdziesz na GitHubie w zakładce Releases.</p>`}`;
  body.querySelector('#abOnb').onclick = () => { $('#modalBack').hidden = true; $('#modal').innerHTML = ''; openOnboarding(); };
  const a = body.querySelector('#upAuto'); if (a) a.onchange = (e) => { S.updates.auto = e.target.checked; saveSettings(); };
  const n = body.querySelector('#upNow'); if (n) n.onclick = async () => { body.querySelector('#upMsg').textContent = 'Sprawdzam…'; await safe(() => api.updateCheck()); setTimeout(() => { const m = body.querySelector('#upMsg'); if (m) m.textContent = updateState && updateState.state === 'available' ? `Dostępna ${updateState.version}` : updateState && updateState.state === 'none' ? 'Masz najnowszą wersję' : ''; }, 2500); };
}

// ---------- kreator pierwszego uruchomienia ----------
// Moc to średni pobór w trakcie druku PLA, cena – orientacyjna cena zakupu w PL. Wszystko da się poprawić.
const PRINTER_PRESETS = [
  { id: 'a1mini', name: 'Bambu Lab A1 mini', w: 70, price: 1100 },
  { id: 'a1', name: 'Bambu Lab A1', w: 95, price: 1700 },
  { id: 'p1s', name: 'Bambu Lab P1S', w: 110, price: 2700 },
  { id: 'x1c', name: 'Bambu Lab X1 Carbon', w: 120, price: 4500 },
  { id: 'mk4s', name: 'Prusa MK4S', w: 80, price: 4300 },
  { id: 'coreone', name: 'Prusa CORE One', w: 100, price: 5000 },
  { id: 'ender3v3', name: 'Creality Ender 3 V3 (SE/KE)', w: 120, price: 900 },
  { id: 'k1c', name: 'Creality K1C', w: 140, price: 1900 },
  { id: 'neptune4', name: 'Elegoo Neptune 4 / 4 Pro', w: 120, price: 1000 },
  { id: 'other', name: 'Inna drukarka', w: null, price: null },
];
function openOnboarding() {
  if (document.getElementById('onb')) return;
  const el = document.createElement('div');
  el.id = 'onb';
  el.className = 'onb';
  document.body.appendChild(el);
  const p = P();
  const steps = ['welcome', 'library', 'slicer', 'printer', 'filaments', 'pricing', 'look', 'extras', 'done'];
  const titles = { welcome: 'Witaj', library: 'Biblioteka', slicer: 'Slicer', printer: 'Drukarka i prąd', filaments: 'Filamenty', pricing: 'Twój czas i cena', look: 'Wygląd', extras: 'Automatyzacje', done: 'Gotowe' };
  let i = 0;
  let printerSel = S.onboardingPrinter || null;
  const c = () => esc(cur());
  const num = (id, val, step = 'any', w = 110) => `<input type="number" step="${step}" min="0" id="${id}" value="${val}" style="width:${w}px">`;

  function example() {
    const fl = defaultFilament();
    const r = priceItems([{ grams: 50, minutes: 180, filament: fl, qty: 1 }], P());
    return `<div class="onb-example"><div class="ex-h">Przykład: model 50 g, 3 h druku${fl ? `, ${esc(filLabel(fl))}` : ''}</div>
      <div class="ex-row"><span>filament</span><b>${fmtMoney(r.filament, cur())}</b></div>
      <div class="ex-row"><span>prąd + drukarka</span><b>${fmtMoney(r.energy + r.wear, cur())}</b></div>
      <div class="ex-row"><span>Twój czas</span><b>${fmtMoney(r.labor, cur())}</b></div>
      <div class="ex-row"><span>bufor</span><b>${fmtMoney(r.buffer, cur())}</b></div>
      <div class="ex-row tot"><span>koszt własny</span><b>${fmtMoney(r.cost, cur())}</b></div>
      ${P().margin > 0 || P().roundTo > 0 ? `<div class="ex-row price"><span>cena dla klienta</span><b>${fmtMoney(r.price, cur())}</b></div>` : ''}</div>`;
  }

  const body = {
    welcome: () => `<div class="onb-hero"><div class="logo big"></div><h1>Witaj w ModelVault</h1>
      <p>Skonfigurujmy kilka rzeczy, żeby wyceny od razu miały sens. To zajmie około 2 minut.<br>Każdy krok możesz pominąć, a wszystko zmienisz później w Ustawieniach (Ctrl+,).</p></div>`,
    library: () => `<h2>Gdzie trzymasz modele?</h2>
      <p class="lead">Wskaż folder z plikami STL / 3MF / G-code. Podfoldery staną się kategoriami, a pliki zostają tam, gdzie są: możesz je dalej przenosić w Eksploratorze.</p>
      <div class="onb-path ${lib ? 'ok' : ''}">${lib ? `✓ ${esc(lib.root)}<small>${lib.files.length} modeli · ${lib.folders.length} folderów</small>` : 'Nie wybrano folderu'}</div>
      <button class="btn primary" id="oLib">${lib ? 'Zmień folder…' : 'Wybierz folder…'}</button>`,
    slicer: () => {
      const list = (S.slicers.list || []).filter((x) => x.available);
      return `<h2>Którego slicera używasz?</h2>
      <p class="lead">Domyślny slicer otwiera modele po dwukliku i klawiszem Enter. Pozostałe zaznaczone będą dostępne w menu „Otwórz w…”.</p>
      ${list.length ? `<div class="onb-cards">${list.map((x) => `<label class="onb-card ${S.slicers.default === x.id ? 'on' : ''}" data-def="${esc(x.id)}">
          <input type="radio" name="osl" ${S.slicers.default === x.id ? 'checked' : ''}><b>${esc(x.name)}</b><small title="${esc(x.path)}">${esc(x.path)}</small>
          <span class="onb-show"><input type="checkbox" data-en="${esc(x.id)}" ${x.enabled ? 'checked' : ''}> pokazuj w menu</span></label>`).join('')}
          <label class="onb-card ${S.slicers.default === 'system' ? 'on' : ''}" data-def="system"><input type="radio" name="osl" ${S.slicers.default === 'system' ? 'checked' : ''}><b>Program domyślny systemu</b><small>to, co Windows otwiera dla danego pliku</small></label></div>`
        : `<div class="onb-path">Nie znalazłem slicera w typowych miejscach.</div>`}
      <div class="btns" style="justify-content:flex-start"><button class="btn" id="oSlAdd">+ Wskaż inny slicer (.exe)…</button><button class="btn" id="oSlDet">Wykryj ponownie</button></div>`;
    },
    printer: () => `<h2>Jaką masz drukarkę?</h2>
      <p class="lead">Na tej podstawie liczę prąd i zużycie drukarki. Wartości są orientacyjne, popraw je, jeśli znasz swoje.</p>
      <div class="onb-chips">${PRINTER_PRESETS.map((x) => `<button class="chip ${printerSel === x.id ? 'on' : ''}" data-pr="${x.id}">${esc(x.name)}</button>`).join('')}</div>
      <div class="fields onb-fields">
        <label class="fld"><span>Średni pobór mocy w trakcie druku</span><span class="inp">${num('oW', p.printerW, '1')}<em>W</em></span></label>
        <label class="fld"><span>Cena drukarki</span><span class="inp">${num('oPP', p.printerPrice, '1')}<em>${c()}</em></span></label>
        <label class="fld"><span>Ile godzin wytrzyma, zanim się „zwróci” (żywotność)</span><span class="inp">${num('oPL', p.printerLife, '100')}<em>h</em></span></label>
        <label class="fld"><span>Serwis i części: dysze, płyta PEI, paski</span><span class="inp">${num('oSv', p.servicePerH, '0.05')}<em>${c()}/h</em></span></label>
        <label class="fld"><span>Cena prądu z rachunku (brutto, z dystrybucją)</span><span class="inp">${num('oKwh', p.kWhPrice, '0.01')}<em>${c()}/kWh</em></span></label>
      </div>
      <p class="hint">Pobór mocy sprawdzisz gniazdkiem z pomiarem energii. Drukarka z obudową i grzaną komorą pobiera więcej.</p>`,
    filaments: () => `<h2>Twoje filamenty</h2>
      <p class="lead">Cena za kilogram decyduje o koszcie materiału, a kolor pomaga dopasować szpule do modeli wielokolorowych. Gwiazdka oznacza filament domyślny.</p>
      <table class="ftable onb-ft"><thead><tr><th></th><th>Nazwa</th><th>Kolor</th><th>Typ</th><th class="r">Cena/kg</th><th title="Domyślny">★</th><th></th></tr></thead><tbody>
      ${S.filaments.map((fl, k) => `<tr data-k="${k}"><td><input type="color" data-f="hex" value="${esc(fl.hex || '#888888')}"></td><td><input data-f="name" value="${esc(fl.name)}"></td><td><input data-f="color" value="${esc(fl.color)}"></td>
        <td><select data-f="type">${['PLA', 'PLA+', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'Inny'].map((t) => `<option ${t === fl.type ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
        <td><input data-f="pricePerKg" type="number" step="0.01" class="num" value="${fl.pricePerKg}"></td><td><input type="radio" name="ofdef" ${p.defaultFilament === fl.id ? 'checked' : ''}></td><td><button class="icon-btn" data-del>✕</button></td></tr>`).join('')}
      </tbody></table>
      <div class="btns" style="justify-content:flex-start"><button class="btn" id="oFAdd">+ Dodaj filament</button><button class="btn" id="oFClear">Wyczyść listę i zacznij od zera</button></div>`,
    pricing: () => `<h2>Twój czas i cena dla klienta</h2>
      <p class="lead">Ile liczysz za swoją pracę i jaki margines bezpieczeństwa chcesz mieć. Przykład po prawej przelicza się na żywo.</p>
      <div class="onb-split"><div class="fields onb-fields">
        <label class="fld"><span>Stawka za Twój czas</span><span class="inp">${num('oRate', p.hourRate, '1', 90)}<em>${c()}/h</em></span></label>
        <label class="fld"><span>Czas na jeden wydruk (przygotowanie, zdjęcie z płyty, obróbka)</span><span class="inp">${num('oMp', p.minPerPrint, '1', 90)}<em>min</em></span></label>
        <label class="fld"><span>Czas na całe zamówienie (kontakt, pakowanie)</span><span class="inp">${num('oMo', p.minPerOrder, '1', 90)}<em>min</em></span></label>
        <label class="fld"><span>Bufor na nieudane wydruki</span><span class="inp">${num('oBuf', +(p.buffer * 100).toFixed(2), '1', 90)}<em>%</em></span></label>
        <label class="fld"><span>Marża (zarobek ponad koszt)</span><span class="inp">${num('oMar', +(p.margin * 100).toFixed(2), '1', 90)}<em>%</em></span></label>
        <label class="fld"><span>Zaokrąglaj cenę dla klienta w górę do</span><span class="inp"><select id="oRnd">${[0, 1, 5, 10].map((v) => `<option value="${v}" ${+p.roundTo === v ? 'selected' : ''}>${v ? v + ' ' + c() : 'nie zaokrąglaj'}</option>`).join('')}</select></span></label>
        <label class="fld"><span>Waluta</span><span class="inp"><input id="oCur" value="${c()}" style="width:70px"></span></label>
      </div><div id="oEx">${example()}</div></div>
      <p class="hint">Drukujesz tylko dla siebie? Ustaw stawkę i marżę na 0, a zobaczysz czysty koszt materiału, prądu i drukarki.</p>`,
    look: () => {
      const presets = ['#f2a03d', '#e9e9e4', '#9aa3ad', '#3f9c4f', '#4a86e8', '#d9534f', '#8e6cd8', '#2b2d31'];
      return `<h2>Wygląd</h2>
      <p class="lead">Kolor, w jakim pokazuję modele bez przypisanego filamentu, i kąt kamery na miniaturach.</p>
      <div class="label">Kolor modelu</div>
      <div class="row"><input type="color" id="oCol" value="${esc(S.appearance.modelColor)}"><div class="presets">${presets.map((x) => `<button class="preset ${x === S.appearance.modelColor ? 'on' : ''}" data-c="${x}" style="background:${x}"></button>`).join('')}</div></div>
      <label class="check"><input type="checkbox" id="oFilCol" ${S.appearance.useFilamentColor ? 'checked' : ''}> Pokazuj model w kolorze przypisanego filamentu</label>
      <div class="label">Kąt kamery na miniaturach</div>
      <div class="seg" id="oPre">${[['iso', 'Izometryczny'], ['front', 'Przód'], ['side', 'Bok'], ['top', 'Góra']].map(([k, v]) => `<button data-p="${k}" class="${S.thumbs.preset === k ? 'on' : ''}">${v}</button>`).join('')}</div>`;
    },
    extras: () => `<h2>Automatyzacje (opcjonalnie)</h2>
      <div class="onb-opt"><label class="check"><input type="checkbox" id="oInbox" ${S.inbox.enabled ? 'checked' : ''}> <b>Zbieraj nowe modele z folderu Pobrane</b></label>
        <p class="hint">Nowe pliki STL, 3MF i inne modele (także z archiwów ZIP z Printables) trafią do folderu „${esc(S.inbox.target)}” w bibliotece. Stamtąd przeciągasz je do kategorii.</p>
        <label class="check sub">Pliki z Pobranych: <select id="oInMode"><option value="move" ${S.inbox.mode === 'move' ? 'selected' : ''}>przenoś</option><option value="copy" ${S.inbox.mode === 'copy' ? 'selected' : ''}>kopiuj</option></select></label></div>
      <div class="onb-opt"><label class="check"><input type="checkbox" id="oStock" ${S.stock.onModelPrinted ? 'checked' : ''}> <b>Odejmuj filament z magazynu po oznaczeniu modelu jako „Wydrukowane”</b></label>
        <p class="hint">Stan szpul ustawisz w widoku „Magazyn filamentów”. Każde odjęcie można cofnąć.</p></div>
      <div class="onb-opt"><label class="check"><input type="checkbox" id="oBk" ${S.backup.auto ? 'checked' : ''}> <b>Automatyczna kopia zapasowa raz dziennie</b></label>
        <p class="hint">Ustawienia, filamenty, klienci, zamówienia oraz tagi i notatki. Same pliki modeli nie są kopiowane.</p></div>`,
    done: () => {
      const d = defaultSlicer();
      return `<div class="onb-hero"><div class="onb-check">✓</div><h1>Gotowe!</h1>
      <div class="onb-summary">
        <div><span>Biblioteka</span><b>${lib ? esc(lib.root) : '— (wybierzesz później)'}</b></div>
        <div><span>Domyślny slicer</span><b>${d ? esc(d.name) : 'program domyślny systemu'}</b></div>
        <div><span>Drukarka</span><b>${printerSel ? esc(PRINTER_PRESETS.find((x) => x.id === printerSel).name) : 'własne ustawienia'} · ${P().printerW} W</b></div>
        <div><span>Filamenty</span><b>${S.filaments.length} w bibliotece, domyślny: ${esc(filLabel(defaultFilament()))}</b></div>
        <div><span>Twój czas</span><b>${P().hourRate} ${c()}/h · marża ${Math.round(P().margin * 100)}%</b></div>
      </div>
      <p class="lead" style="margin-top:18px">Wskazówka: dwuklik otwiera model w slicerze, a prawy przycisk pokazuje wszystkie opcje.<br>Kreator uruchomisz ponownie w Ustawienia → O programie.</p></div>`;
    },
  };

  const bind = {
    library: () => { $('#oLib').onclick = async () => { await chooseLibrary(); draw(); }; },
    slicer: () => {
      el.querySelectorAll('[data-def]').forEach((card) => card.querySelector('input[type=radio]').onchange = () => { S.slicers.default = card.dataset.def; const x = S.slicers.list.find((y) => y.id === card.dataset.def); if (x) x.enabled = true; draw(); });
      el.querySelectorAll('[data-en]').forEach((cb) => { cb.onclick = (e) => e.stopPropagation(); cb.onchange = () => { const x = S.slicers.list.find((y) => y.id === cb.dataset.en); x.enabled = cb.checked; if (!x.enabled && S.slicers.default === x.id) S.slicers.default = 'system'; draw(); }; });
      $('#oSlAdd').onclick = async () => {
        const path = await api.slicersPick(); if (!path) return;
        const name = await promptModal('Nazwa slicera', baseName(path.replace(/\\/g, '/')).replace(/\.(exe|app)$/i, ''), 'Dodaj');
        if (!name) return;
        const id = 'custom-' + Date.now().toString(36);
        S.slicers.list = [...(S.slicers.list || []), { id, name, path, enabled: true, available: true, custom: true }];
        S.slicers.default = id; draw();
      };
      $('#oSlDet').onclick = async () => { await api.setSettings(S); const r = await safe(() => api.slicersDetect()); if (r) { S.slicers = r; draw(); } };
    },
    printer: () => {
      el.querySelectorAll('[data-pr]').forEach((b) => b.onclick = () => {
        printerSel = b.dataset.pr;
        const pr = PRINTER_PRESETS.find((x) => x.id === printerSel);
        if (pr.w) { p.printerW = pr.w; p.printerPrice = pr.price; }
        draw();
      });
      const f = (id, k) => { $(id).oninput = (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v >= 0) p[k] = v; }; };
      f('#oW', 'printerW'); f('#oPP', 'printerPrice'); f('#oPL', 'printerLife'); f('#oSv', 'servicePerH'); f('#oKwh', 'kWhPrice');
    },
    filaments: () => {
      el.querySelectorAll('tbody tr').forEach((tr) => {
        const fl = S.filaments[+tr.dataset.k];
        tr.querySelectorAll('[data-f]').forEach((inp) => {
          inp[inp.type === 'color' || inp.tagName === 'SELECT' ? 'onchange' : 'oninput'] = () => { const k = inp.dataset.f; fl[k] = k === 'pricePerKg' ? parseFloat(inp.value) || 0 : inp.value; };
        });
        tr.querySelector('input[type=radio]').onchange = () => { p.defaultFilament = fl.id; };
        tr.querySelector('[data-del]').onclick = () => { if (S.filaments.length <= 1) return toast('Zostaw co najmniej jeden filament', true); S.filaments = S.filaments.filter((x) => x !== fl); if (p.defaultFilament === fl.id) p.defaultFilament = S.filaments[0].id; draw(); };
      });
      $('#oFAdd').onclick = () => { S.filaments.push({ id: 'f' + Date.now().toString(36), name: 'Nowy filament', color: 'kolor', hex: '#888888', type: 'PLA', pricePerKg: 70, density: 1.24, spoolWeight: 1000, remaining: null }); draw(); el.querySelector('tbody tr:last-child input[data-f="name"]')?.select(); };
      $('#oFClear').onclick = () => { const id = 'f' + Date.now().toString(36); S.filaments = [{ id, name: 'Mój filament', color: 'biały', hex: '#f1f1ee', type: 'PLA', pricePerKg: 70, density: 1.24, spoolWeight: 1000, remaining: null }]; p.defaultFilament = id; draw(); el.querySelector('tbody input[data-f="name"]')?.select(); };
    },
    pricing: () => {
      const upd = () => { $('#oEx').innerHTML = example(); };
      const f = (id, k, pct = false) => { $(id).oninput = (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v >= 0) { p[k] = pct ? v / 100 : v; upd(); } }; };
      f('#oRate', 'hourRate'); f('#oMp', 'minPerPrint'); f('#oMo', 'minPerOrder'); f('#oBuf', 'buffer', true); f('#oMar', 'margin', true);
      $('#oRnd').onchange = (e) => { p.roundTo = +e.target.value; upd(); };
      $('#oCur').oninput = (e) => { p.currency = e.target.value.trim() || 'zł'; upd(); };
    },
    look: () => {
      const setC = (v) => { S.appearance.modelColor = v; draw(); };
      $('#oCol').onchange = (e) => setC(e.target.value);
      el.querySelectorAll('.preset').forEach((b) => b.onclick = () => setC(b.dataset.c));
      $('#oFilCol').onchange = (e) => { S.appearance.useFilamentColor = e.target.checked; };
      el.querySelectorAll('#oPre [data-p]').forEach((b) => b.onclick = () => { S.thumbs.preset = b.dataset.p; draw(); });
    },
    extras: () => {
      $('#oInbox').onchange = (e) => { S.inbox.enabled = e.target.checked; if (e.target.checked) S.inbox.enabledAt = Date.now(); };
      $('#oInMode').onchange = (e) => { S.inbox.mode = e.target.value; };
      $('#oStock').onchange = (e) => { S.stock.onModelPrinted = e.target.checked; };
      $('#oBk').onchange = (e) => { S.backup.auto = e.target.checked; };
    },
  };

  async function finish() {
    S.onboardingDone = true;
    S.onboardingPrinter = printerSel;
    await api.setSettings(S);
    await api.inboxApply().catch(() => {});
    el.remove();
    setModelColor(S.appearance.modelColor);
    thumbs.clear();
    renderAll();
    toast('Konfiguracja zapisana');
  }
  function draw() {
    const s = steps[i];
    const pct = Math.round(i / (steps.length - 1) * 100);
    el.innerHTML = `<div class="onb-box">
      <div class="onb-side">${steps.map((k, j) => `<div class="onb-step ${j === i ? 'cur' : j < i ? 'done' : ''}" data-j="${j}"><span>${j < i ? '✓' : j + 1}</span>${titles[k]}</div>`).join('')}</div>
      <div class="onb-main"><div class="onb-progress"><i style="width:${pct}%"></i></div>
        <div class="onb-body">${body[s]()}</div>
        <div class="onb-nav">${i > 0 && s !== 'done' ? '<button class="btn" id="oBack">← Wstecz</button>' : '<span></span>'}<span style="flex:1"></span>
          ${s === 'welcome' ? '<button class="btn" id="oSkipAll">Pomiń konfigurację</button>' : ''}
          ${s !== 'done' && s !== 'welcome' ? '<button class="btn" id="oSkip">Pomiń krok</button>' : ''}
          <button class="btn primary" id="oNext">${s === 'welcome' ? 'Zaczynamy →' : s === 'done' ? 'Przejdź do biblioteki' : 'Dalej →'}</button></div></div></div>`;
    (bind[s] || (() => {}))();
    const go = (d) => { i = Math.max(0, Math.min(steps.length - 1, i + d)); draw(); };
    const b = $('#oBack'); if (b) b.onclick = () => go(-1);
    const sk = $('#oSkip'); if (sk) sk.onclick = () => go(1);
    const sa = $('#oSkipAll'); if (sa) sa.onclick = () => finish();
    $('#oNext').onclick = () => (s === 'done' ? finish() : go(1));
    el.querySelectorAll('.onb-step').forEach((x) => x.onclick = () => { const j = +x.dataset.j; if (j <= i) { i = j; draw(); } });
  }
  (async () => {
    if (!S.slicers.list || !S.slicers.list.length) { try { await api.setSettings(S); S.slicers = await api.slicersDetect(); } catch {} }
    draw();
  })();
}

function applyAppearance(colorChanged) {
  setModelColor(S.appearance.modelColor);
  if (colorChanged) {
    // przerysuj wyrenderowane miniatury (nie te z obrazków)
    for (const [rel] of thumbs) { const f = lib && lib.files.find((x) => x.rel === rel); if (!f || !f.image) thumbs.delete(rel); }
    renderGrid();
  }
  if (viewer && viewer.holder && focused) {
    const f = lib && lib.files.find((x) => x.rel === focused);
    if (f) viewer.setSlotColors(slotColors(f));
  }
}
function afterPricingChange() {
  if (st.special === 'order') renderOrder();
  if (st.special === 'stock') renderStock();
  if (st.special === 'orders') renderOrders();
  if (sel.size === 1) renderDetail();
  renderSidebar();
}

// ---------- detail ----------

function renderDetail() {
  const body = $('#detailBody');
  if (!viewer) {
    try { viewer = new Viewer($('#viewer')); }
    catch (e) { console.warn(e); viewer = { clear() {}, show() { throw new Error('WebGL niedostępny na tym komputerze'); }, resetView() {}, setWireframe() {}, toggleTravel() {}, holder: null, wire: false }; }
  }
  const msg = $('#viewerMsg');
  const tools = $('#viewerTools');

  if (!lib || !sel.size) {
    viewToken++; viewer.clear(); tools.hidden = true;
    msg.innerHTML = '';
    body.innerHTML = lib ? `<div class="d-empty">Wybierz model, aby zobaczyć podgląd 3D.<br><br>
      <span class="kbd">Ctrl</span>/<span class="kbd">Shift</span> + klik — wiele plików<br>
      Przeciągnij na folder po lewej — przenieś<br>
      <span class="kbd">F2</span> nazwa · <span class="kbd">Del</span> kosz · <span class="kbd">F</span> ulubione<br>
      Dwuklik — otwórz w slicerze</div>` : '';
    return;
  }

  if (sel.size > 1) {
    viewToken++; viewer.clear(); tools.hidden = true;
    msg.innerHTML = `<div style="font-size:28px;color:var(--text)">${sel.size}<div style="font-size:12px;color:var(--dim)">zaznaczonych plików</div></div>`;
    const rels = [...sel];
    const total = rels.reduce((s, r) => s + (lib.files.find((f) => f.rel === r)?.size || 0), 0);
    body.innerHTML = `<div class="d-name">Zaznaczono ${rels.length} pliki</div><div class="d-path">${fmtSize(total)} łącznie</div>
      <div class="label">Status</div>
      <div class="seg"><button data-st="">Brak</button><button data-st="todo" class="b">Do wydruku</button><button data-st="printed" class="g">Wydrukowane</button></div>
      <div class="btns">
        <button class="btn primary" id="bOrder">+ Do wyceny</button>
        <button class="btn" id="bTag">Dodaj tag…</button>
        <button class="btn" id="bFav">★ Ulubione</button>
        <button class="btn" id="bMove">Przenieś do…</button>
        <button class="btn danger" id="bDel">Usuń</button>
      </div>`;
    body.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => setStatus(rels, b.dataset.st));
    $('#bTag').onclick = () => bulkTag(rels);
    $('#bOrder').onclick = () => addToOrder(rels);
    $('#bFav').onclick = () => { const all = rels.every((r) => metaOf(r).favorite); setMetaMany(rels, () => ({ favorite: !all })); };
    $('#bMove').onclick = async () => { const d = await pickFolderModal(`Przenieś ${rels.length} pliki`); if (d !== null) await moveItems(rels, d); };
    $('#bDel').onclick = () => trashItems(rels, false);
    return;
  }

  const rel = focused && sel.has(focused) ? focused : [...sel][0];
  const f = lib.files.find((x) => x.rel === rel);
  if (!f) return;
  const m = lib.meta[rel] || {};
  let stats = ls.get(statsKey(f), null);
  if (stats && stats.failed) stats = null;
  const fmt = (n, d = 1) => n.toLocaleString('pl-PL', { maximumFractionDigits: d, minimumFractionDigits: d });
  const statHtml = (s) => s ? `
      ${s.plates ? (() => { const big = s.plates.reduce((m, p) => (p.x * p.y > m.x * m.y ? p : m), s.plates[0]); return `<div class="stat wide dims"><div class="k">${s.plates.length} płyty · największa (X × Y × Z)</div><div class="v">${fmt(big.x)} × ${fmt(big.y)} × ${fmt(big.z)} mm</div></div>`; })()
        : `<div class="stat wide dims"><div class="k">Wymiary (X × Y × Z)</div><div class="v">${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} mm</div></div>`}
      ${s.volume ? `<div class="stat"><div class="k">Objętość</div><div class="v">${fmt(s.volume, 2)} cm³</div></div>` : ''}
      ${s.tris ? `<div class="stat"><div class="k">Trójkąty</div><div class="v">${s.tris.toLocaleString('pl-PL')}</div></div>` : ''}`
    : f.viewable ? `<div class="stat wide dims"><div class="k">Wymiary</div><div class="v" style="color:var(--dim)">liczenie…</div></div>` : '';
  body.innerHTML = `
    <div class="row" style="margin:0;align-items:flex-start">
      <div style="flex:1;min-width:0"><div class="d-name" id="dName" title="Kliknij, aby zmienić nazwę">${esc(f.name)}</div>
      <div class="d-path" id="dPath" title="Pokaż w Eksploratorze">${esc(f.dir ? f.dir + '/' : '/')}</div></div>
      <button class="star ${m.favorite ? 'on' : ''}" id="dFav" title="Ulubione (F)">★</button>
    </div>
    <div class="stats" id="dStats">
      ${statHtml(stats)}
      <div class="stat"><div class="k">Rozmiar pliku</div><div class="v">${fmtSize(f.size)}</div></div>
      <div class="stat wide"><div class="k">Zmodyfikowano</div><div class="v" style="font-size:11.5px">${fmtDate(f.mtime)}</div></div>
    </div>
    ${pricingSectionHtml(f)}
    <div class="label">Status</div>
    <div class="seg" id="dStatus">
      <button data-st="" class="${!m.status ? 'on' : ''}">Brak</button>
      <button data-st="todo" class="b ${m.status === 'todo' ? 'on' : ''}">Do wydruku</button>
      <button data-st="printed" class="g ${m.status === 'printed' ? 'on' : ''}">Wydrukowane</button>
    </div>
    <div class="label">Tagi</div>
    <div class="tag-editor" id="dTags">
      ${(m.tags || []).map((t) => `<span class="tag"><span class="dot" style="background:${tagColor(t)}"></span>${esc(t)}<span class="x" data-rm="${esc(t)}">✕</span></span>`).join('')}
      <input id="dTagIn" placeholder="dodaj tag + Enter" list="allTags" spellcheck="false">
    </div>
    <datalist id="allTags">${[...new Set(Object.values(lib.meta).flatMap((x) => x.tags || []))].map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
    <div class="label">Źródło (link do Printables, MakerWorld, Thingiverse…)</div>
    <div class="srcrow"><input class="field sm" id="dSrc" value="${esc(m.source || '')}" placeholder="${esc(urlFromText(m.notes) || 'https://…')}" spellcheck="false"><button class="btn" id="dSrcOpen" ${m.source || urlFromText(m.notes) ? '' : 'disabled'}>Otwórz ↗</button></div>
    <div class="label">Kolekcje</div>
    <div class="tag-editor colls-edit">${(m.collections || []).map((id) => collections().find((c) => c.id === id)).filter(Boolean).map((c) => `<span class="tag"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}<span class="x" data-rmcoll="${esc(c.id)}">✕</span></span>`).join('')}<button class="linkbtn" id="dAddColl">+ dodaj do kolekcji</button></div>
    <div class="label">Miniatura</div>
    <div class="thumb-btns"><button class="btn" id="thView" title="Ustaw miniaturę z bieżącego kąta kamery w podglądzie">Z obecnego widoku</button><button class="btn" id="thImg" title="Np. zdjęcie gotowego wydruku">Wybierz zdjęcie…</button>${m.thumbView || f.image ? '<button class="btn" id="thReset">Przywróć domyślną</button>' : ''}</div>
    <div class="label">Notatki</div>
    <textarea class="notes" id="dNotes" placeholder="np. ustawienia druku, filament, podpory, link do źródła…">${esc(m.notes || '')}</textarea>
    <div class="btns">
      <span class="split"><button class="btn primary" id="dOpen">${esc(openLabel())}</button>${openMenuItems([rel], false).length ? '<button class="btn primary caret" id="dOpenMore" title="Inne programy">▾</button>' : ''}</span>
      <button class="btn" id="dReveal">Pokaż w Eksploratorze</button>
      <button class="btn" id="dMove">Przenieś…</button>
      <button class="btn danger" id="dDel">Usuń</button>
    </div>`;

  $('#dName').onclick = () => renameItem(rel, false);
  $('#dPath').onclick = () => api.reveal(rel);
  $('#dFav').onclick = () => setMetaMany([rel], (x) => ({ favorite: !x.favorite }));
  body.querySelectorAll('#dStatus [data-st]').forEach((b) => b.onclick = () => setStatus([rel], b.dataset.st));
  body.querySelectorAll('[data-rm]').forEach((x) => x.onclick = () => setMetaMany([rel], (mm) => ({ tags: (mm.tags || []).filter((t) => t !== x.dataset.rm) })));
  const tin = $('#dTagIn');
  tin.onkeydown = async (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = tin.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!v.length) return;
      await setMetaMany([rel], (mm) => ({ tags: [...new Set([...(mm.tags || []), ...v])] }));
      $('#dTagIn')?.focus();
    } else if (e.key === 'Backspace' && !tin.value && (m.tags || []).length) {
      await setMetaMany([rel], (mm) => ({ tags: (mm.tags || []).slice(0, -1) }));
      $('#dTagIn')?.focus();
    }
  };
  const notes = $('#dNotes');
  let nt = null;
  const saveNotes = async () => { clearTimeout(nt); if ((metaOf(rel).notes || '') !== notes.value) { await setMeta(rel, { notes: notes.value }); renderGridSoft(); } };
  notes.oninput = () => { clearTimeout(nt); nt = setTimeout(saveNotes, 700); };
  notes.onblur = saveNotes;
  $('#dOpen').onclick = () => openDefault([rel]);
  const dom = $('#dOpenMore');
  if (dom) dom.onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); ctxMenu(r.left, r.bottom + 4, openMenuItems([rel], false)); };
  $('#thView').onclick = () => snapThumbFromView(rel);
  $('#thImg').onclick = async () => { const r = await safe(() => api.pickImageFor(rel)); if (r) { thumbs.delete(rel); toast('Ustawiono zdjęcie jako miniaturę'); await reload(); } };
  const thR = $('#thReset');
  if (thR) thR.onclick = async () => {
    if (f.image && !(await confirmModal('Usunąć obrazek miniatury?', `Plik ${esc(baseName(f.image))} trafi do Kosza.`, 'Usuń'))) return;
    if (f.image) await safe(() => api.removeImage(f.image));
    await setMeta(rel, { thumbView: null });
    thumbs.delete(rel); await reload(); requestThumb(rel, true, true);
  };
  body.querySelectorAll('[data-rmcoll]').forEach((x) => x.onclick = () => removeFromCollection(x.dataset.rmcoll, [rel]));
  const ac = $('#dAddColl'); if (ac) ac.onclick = () => pickCollectionModal([rel]);
  const srcIn = $('#dSrc');
  srcIn.onchange = async () => {
    let v = srcIn.value.trim();
    if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
    await setMeta(rel, { source: v });
    renderDetail(); renderGrid();
  };
  srcIn.onkeydown = (e) => { if (e.key === 'Enter') srcIn.blur(); };
  $('#dSrcOpen').onclick = () => { const u = metaOf(rel).source || urlFromText(metaOf(rel).notes); if (u) api.openExternal(u).catch((er) => toast(er.message, true)); };
  $('#dReveal').onclick = () => api.reveal(rel);
  $('#dMove').onclick = async () => { const d = await pickFolderModal(`Przenieś „${f.name}”`); if (d !== null) await moveItems([rel], d); };
  $('#dDel').onclick = () => trashItems([rel], false);
  bindPricingSection(f);
  ensureAnalysis(f).then((ch) => { if (ch && focused === rel && sel.size === 1 && !document.activeElement?.closest('#detailBody')) renderDetail(); });

  loadPreview(f);
}

function urlFromText(t) { const m = String(t || '').match(/https?:\/\/[^\s<>"']+/i); return m ? m[0] : ''; }
function perSlotFromSlicer(d) { return d.parts.every((p) => p.gramsSrc && p.gramsSrc !== 'szacunek' && p.gramsSrc !== 'ręcznie' && !String(p.gramsSrc).includes('podział')); }
function srcTxt(x) { return x === 'ręcznie' ? 'wpisane ręcznie' : x === 'szacunek' ? 'szacunek' : x ? `z pliku ${x}` : ''; }
function pricingSectionHtml(f) {
  const d = printData(f);
  const has = d.grams != null;
  const r = has ? priceItems([{ parts: d.parts.map((p) => ({ grams: p.grams || 0, filament: p.filament })), minutes: d.minutes || 0, qty: 1, plates: d.plates }], P()) : null;
  const manual = metaOf(f.rel).print || {};
  const c = cur();
  let slotsHtml;
  if (!d.multi) {
    slotsHtml = `<div class="prow"><span>Filament</span><span class="pfil">${swatch(d.filament)}<select data-slot="0">${filamentOptions(d.filamentSet ? d.filament.id : '', true)}</select></span></div>
      <div class="prow two">
        <label><span>Gramy</span><input id="pG" class="field sm" value="${manual.grams != null ? fmtNum(manual.grams, manual.grams % 1 ? 1 : 0) : ''}" placeholder="${d.grams != null ? fmtNum(d.grams, 0) + ' g' : 'np. 74'}"></label>
        <label><span>Czas druku</span><input id="pT" class="field sm" value="${manual.minutes != null ? fmtDurShort(manual.minutes) : ''}" placeholder="${d.minutes != null ? fmtDurShort(d.minutes) : 'h:mm'}"></label>
      </div>`;
  } else {
    slotsHtml = `<div class="mc-head"><span>${d.parts.length} kolory w pliku</span><small>kolor z pliku → szpula</small></div>
      ${d.parts.map((pt) => `<div class="mc-row">
        <span class="fhex" style="background:${esc(pt.fileHex || PALETTE[pt.slot % PALETTE.length])}" title="Kolor zapisany w pliku: ${esc(pt.fileHex || 'brak')}"></span>
        <span class="mc-name" title="${esc(pt.name)}">${esc(pt.name)}</span>
        <span class="pfil">${swatch(pt.filament)}<select data-slot="${pt.slot}">${slotFilamentOptions(pt)}</select></span>
        <input class="field sm mc-g" data-slotg="${pt.slot}" value="${pt.manual != null ? fmtNum(pt.manual, pt.manual % 1 ? 1 : 0) : ''}" placeholder="${pt.grams != null ? fmtNum(pt.grams, 1) : '—'}" title="Gramy (puste = automatycznie, ${esc(srcTxt(pt.gramsSrc))})"><em>g</em>
      </div>`).join('')}
      <div class="prow two" style="margin-top:8px">
        <label><span>Razem</span><input class="field sm" disabled value="${d.grams != null ? fmtNum(d.grams, 1) + ' g' : '—'}"></label>
        <label><span>Czas druku</span><input id="pT" class="field sm" value="${manual.minutes != null ? fmtDurShort(manual.minutes) : ''}" placeholder="${d.minutes != null ? fmtDurShort(d.minutes) : 'h:mm'}"></label>
      </div>
      <div class="phint">${perSlotFromSlicer(d) ? `Gramy per kolor ze slicera (z purge i wieżą)${d.changeSrc === 'G-code' ? ` · zmiany koloru: <b>${d.changes}</b>` : ''}` : `Zmiany koloru: <b>${d.changes}</b> ${d.changeSrc === 'G-code' ? '(policzone z G-code)' : d.changes ? '(szacunek z wysokości kolorów)' : ''}${d.purgeG ? ` · purge ≈ ${fmtNum(d.purgeG, 1)} g` : ''}${d.changeMin ? ` · +${fmtDuration(d.changeMin)} na zmiany` : ''}`}</div>`;
  }
  const hint = [d.gramsSrc && `gramy: ${srcTxt(d.gramsSrc)}`, d.minutesSrc && `czas: ${srcTxt(d.minutesSrc)}`].filter(Boolean).join(' · ');
  const est = d.gramsSrc === 'szacunek' || d.gramsSrc === 'mieszane';
  const stockWarn = has ? stockWarnings(d.parts.map((p) => ({ filament: p.filament, grams: p.grams || 0 }))) : '';
  const platesHtml = d.plates > 1 ? `<div class="plates-box"><div class="mc-head"><span>${d.plates} płyty w pliku</span><small>każda płyta = osobny wydruk</small></div>
      ${d.plateList.map((pl) => `<div class="plate-row" data-plate="${pl.index}"><b>Płyta ${pl.id}</b><span>${fmtNum(pl.x, 0)} × ${fmtNum(pl.y, 0)} × ${fmtNum(pl.z, 0)} mm</span><span>${pl.grams != null ? fmtNum(pl.grams, 1) + ' g' : fmtNum(pl.volume, 1) + ' cm³'}</span><span>${pl.minutes != null ? fmtDuration(pl.minutes) : ''}</span></div>`).join('')}</div>` : '';
  return `<div class="label">Wycena <button class="linkbtn" id="pSet">ustawienia</button></div>
    <div class="pricebox">
      ${platesHtml}
      ${slotsHtml}
      ${hint ? `<div class="phint ${est ? 'est' : ''}">${esc(hint)}${d.gramsSrc === 'szacunek' ? ' — dla dokładnej wyceny potnij model w slicerze' : ''}</div>` : ''}
      ${stockWarn}
      ${has ? breakdownHtml(r) + `<div class="phint">jako osobne zamówienie (z czasem na kontakt i pakowanie)</div>`
        : `<div class="phint">${f.viewable && f.ext !== 'gcode' ? 'Liczenie objętości…' : 'Brak danych — wpisz gramy i czas ze slicera.'}</div>`}
      <button class="btn" id="pAdd" style="margin-top:10px;width:100%">+ Dodaj do wyceny zamówienia</button>
    </div>`;
}
function slotFilamentOptions(pt) {
  const def = defaultFilament();
  const autoLbl = pt.auto ? `Auto: ${filLabel(pt.filament)}` : `Domyślny (${def ? filLabel(def) : '—'})`;
  return `<option value="">${esc(autoLbl)}</option>` + S.filaments.map((fl) => `<option value="${esc(fl.id)}" ${pt.filamentSet && fl.id === pt.filament.id ? 'selected' : ''}>${esc(filLabel(fl))}</option>`).join('');
}
function bindPricingSection(f) {
  const rel = f.rel;
  const after = () => { renderDetail(); if (st.special === 'order') renderOrder(); };
  $('#pSet').onclick = () => openSettings('pricing');
  document.querySelectorAll('#detailBody .plate-row').forEach((row) => row.onclick = () => { const k = +row.dataset.plate; setPlateView(viewPlate === k ? null : k); });
  $('#pAdd').onclick = () => addToOrder([rel]);
  document.querySelectorAll('#detailBody select[data-slot]').forEach((sel) => sel.onchange = async () => {
    const i = +sel.dataset.slot, v = sel.value || null;
    const d = printData(f);
    if (!d.multi) await setPrintMeta(rel, { filamentId: v });
    else {
      const slots = [...((metaOf(rel).print || {}).slots || [])];
      slots[i] = { ...(slots[i] || {}), filamentId: v };
      await setPrintMeta(rel, { slots });
    }
    after();
  });
  document.querySelectorAll('#detailBody input[data-slotg]').forEach((inp) => {
    inp.onchange = async () => {
      const i = +inp.dataset.slotg, v = inp.value.trim();
      const val = v === '' ? null : parseFloat(v.replace(',', '.'));
      if (v !== '' && !Number.isFinite(val)) return toast('Nieprawidłowa wartość', true);
      const slots = [...((metaOf(rel).print || {}).slots || [])];
      slots[i] = { ...(slots[i] || {}), grams: val };
      await setPrintMeta(rel, { slots });
      after();
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') inp.dispatchEvent(new Event('change')); };
  });
  const bindNum = (id, key, parse) => {
    const inp = $(id);
    if (!inp) return;
    inp.onchange = async () => {
      const v = inp.value.trim();
      const val = v === '' ? null : parse(v);
      if (v !== '' && !Number.isFinite(val)) { toast('Nieprawidłowa wartość', true); return; }
      await setPrintMeta(rel, { [key]: val });
      inp.blur();
      after();
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') inp.dispatchEvent(new Event('change')); };
  };
  bindNum('#pG', 'grams', (v) => parseFloat(v.replace(',', '.')));
  bindNum('#pT', 'minutes', parseDuration);
}
function renderGridSoft() { /* notatki nie zmieniają kart */ }

async function loadPreview(f) {
  const token = ++viewToken;
  const msg = $('#viewerMsg');
  const tools = $('#viewerTools');
  if (viewer.currentRel === f.rel + f.mtime && viewer.holder) { viewer.setSlotColors(slotColors(f)); return; }
  viewer.clear();
  viewer.currentRel = null;
  tools.hidden = true;
  $('#vPlate').hidden = true;
  if (!f.viewable) {
    const t = thumbs.get(f.rel);
    msg.innerHTML = t && t !== 'none' ? `<img src="${t}">` : `Brak podglądu 3D dla .${esc(f.ext)}<br>Kliknij „Otwórz”, aby otworzyć w programie.`;
    return;
  }
  if (f.size > 250 * 1048576) { msg.innerHTML = 'Plik jest bardzo duży — podgląd pominięty.'; return; }
  msg.innerHTML = '<span class="spin" style="width:22px;height:22px;border:2px solid var(--line-2);border-top-color:var(--accent);border-radius:50%;display:inline-block;animation:spin .8s linear infinite"></span>';
  try {
    const buf = await api.readFile(f.rel);
    if (token !== viewToken) return;
    await new Promise((r) => setTimeout(r, 16));
    const parsed = parseModel(f.ext, buf);
    if (token !== viewToken) return;
    const hadColors = ls.get(colorsKey(f), undefined) !== undefined && !!(ls.get(statsKey(f), null) || parsed.isGcode);
    try { storeParsedAnalysis(f, parsed); } catch (e) { console.warn(e); }
    viewer.show(parsed);
    viewer.setSlotColors(slotColors(f));
    viewPlate = null;
    const vp = $('#vPlate');
    if (parsed.plates && parsed.plates.length > 1) { vp.innerHTML = `<option value="">Wszystkie płyty (${parsed.plates.length})</option>` + parsed.plates.map((p) => `<option value="${p.index}">Płyta ${p.id}</option>`).join(''); vp.hidden = false; }
    else vp.hidden = true;
    if (!hadColors && token === viewToken && focused === f.rel && !document.activeElement?.closest('#detailBody')) setTimeout(() => renderDetail(), 0);
    viewer.currentRel = f.rel + f.mtime;
    msg.innerHTML = '';
    tools.hidden = false;
    $('#vTravel').hidden = !parsed.isGcode;
  } catch (e) {
    if (token !== viewToken) return;
    console.warn(e);
    const t = thumbs.get(f.rel);
    msg.innerHTML = (t && t !== 'none' ? `<img src="${t}"><br>` : '') + `<span>Nie udało się wczytać modelu: ${esc(e.message)}</span>`;
    const box = $('#dStats'); box?.querySelector(".dims")?.remove();
  }
}

let viewPlate = null;
function setPlateView(k) {
  viewPlate = k;
  viewer.showPlate && viewer.showPlate(k);
  document.querySelectorAll('#detailBody .plate-row').forEach((r) => r.classList.toggle('on', +r.dataset.plate === k));
  const ps = $('#vPlate'); if (ps) ps.value = k == null ? '' : String(k);
}
$('#vPlate').onchange = (e) => setPlateView(e.target.value === '' ? null : +e.target.value);
$('#vReset').onclick = () => viewer.resetView();
$('#vSnap').onclick = () => { if (focused) snapThumbFromView(focused); };
$('#vWire').onclick = (e) => { viewer.setWireframe(!viewer.wire); e.currentTarget.classList.toggle('on', viewer.wire); };
$('#vTravel').onclick = (e) => { viewer.toggleTravel(); e.currentTarget.classList.toggle('on'); };

// ---------- top bar ----------
async function chooseLibrary() {
  const r = await safe(() => api.chooseLibrary());
  if (r) { lib = r; thumbs.clear(); sel.clear(); focused = null; st.folder = ''; st.special = 'all'; st.tag = null; renderAll(); }
}
$('#libPath').onclick = chooseLibrary;
let searchT = null;
$('#search').oninput = (e) => { clearTimeout(searchT); searchT = setTimeout(() => { st.search = e.target.value; renderGrid(); }, 120); };
$('#format').value = st.format;
$('#format').onchange = (e) => { st.format = e.target.value; ls.set('mv.format', st.format); renderGrid(); };
$('#sort').value = st.sort;
$('#sort').onchange = (e) => { st.sort = e.target.value; ls.set('mv.sort', st.sort); renderGrid(); };
const zoom = $('#zoom');
zoom.value = ls.get('mv.zoom', 180);
document.documentElement.style.setProperty('--card', zoom.value + 'px');
zoom.oninput = () => { document.documentElement.style.setProperty('--card', zoom.value + 'px'); ls.set('mv.zoom', +zoom.value); };
$('#newFolderBtn').onclick = () => lib && newFolder(st.special === 'folder' ? st.folder : '');

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || !$('#modalBack').hidden;
  if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); if ($('#modalBack').hidden) openSettings(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if (typing) { if (e.key === 'Escape') document.activeElement.blur(); return; }
  if (!lib) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); visible.forEach((f) => sel.add(f.rel)); updateSelectionClasses(); renderDetail(); return; }
  if (e.key === 'Escape') { sel.clear(); focused = null; updateSelectionClasses(); renderDetail(); return; }
  if (e.key === 'Delete' && sel.size) { trashItems([...sel], false); return; }
  if (e.key === 'F2' && sel.size === 1) { renameItem([...sel][0], false); return; }
  if (e.key === 'Enter' && sel.size) { openDefault([...sel]); return; }
  if (e.key.toLowerCase() === 'f' && sel.size) { const rels = [...sel]; const all = rels.every((r) => metaOf(r).favorite); setMetaMany(rels, () => ({ favorite: !all })); return; }
  if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key) && visible.length) {
    e.preventDefault();
    const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length);
    const cur = visible.findIndex((f) => f.rel === focused);
    const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    const next = Math.max(0, Math.min(visible.length - 1, cur < 0 ? 0 : cur + d));
    selectCard(visible[next].rel, e.shiftKey ? { shiftKey: true } : null);
  }
});

// nawigacja do wyceny + upuszczanie kart na nią
const orderNav = $('#orderNav');
orderNav.onclick = () => lib && setView({ special: 'order' });
orderNav.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-modelvault') && dragPayload?.kind === 'files') { e.preventDefault(); orderNav.classList.add('drop-hover'); } });
orderNav.addEventListener('dragleave', () => orderNav.classList.remove('drop-hover'));
orderNav.addEventListener('drop', (e) => { e.preventDefault(); orderNav.classList.remove('drop-hover'); const raw = e.dataTransfer.getData('application/x-modelvault'); if (raw && dragPayload?.kind === 'files') addToOrder(JSON.parse(raw)); });
$('#settingsBtn').onclick = () => openSettings();
$('#ordersNav').onclick = () => lib && setView({ special: 'orders' });
$('#queueNav').onclick = () => lib && setView({ special: 'queue' });
$('#clientsNav').onclick = () => S && setView({ special: 'clients' });
$('#newCollBtn').onclick = () => lib && newCollection(sel.size ? [...sel] : []);
$('#stockNav').onclick = () => S && setView({ special: 'stock' });

(async () => {
  S = await api.getSettings();
  if (!S.slicers || !S.slicers.list) { try { S.slicers = await api.slicersDetect(); } catch {} }
  setModelColor(S.appearance.modelColor);
  await reload();
  if (!S.onboardingDone) openOnboarding();
})();
window.__mv = { openOnboarding, st, sel, selectCard, reload, setView, openSettings, addToOrder, get lib() { return lib; }, get S() { return S; } };
