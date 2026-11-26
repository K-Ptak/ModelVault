import { Viewer, parseModel, renderThumbnail, computeStats, extract3mfThumbnail } from './viewer.js';

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

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), err ? 5000 : 2600);
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
    if (st.special === 'fav' && !m.favorite) return false;
    if (st.special === 'todo' && m.status !== 'todo') return false;
    if (st.special === 'printed' && m.status !== 'printed') return false;
    if (st.special === 'untagged' && m.tags && m.tags.length) return false;
    if (st.tag && !(m.tags || []).includes(st.tag)) return false;
    if (st.format !== 'all') {
      if (st.format === 'other' ? !OTHER_EXT.has(f.ext) : f.ext !== st.format) return false;
    }
    if (q) {
      const hay = `${f.rel} ${(m.tags || []).join(' ')} ${m.notes || ''}`.toLowerCase();
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
  const items = [['all', '◫', 'Wszystkie modele'], ['fav', '★', 'Ulubione'], ['todo', '◷', 'Do wydruku'], ['printed', '✓', 'Wydrukowane'], ['untagged', '◌', 'Bez tagów']];
  sp.innerHTML = items.map(([k, ico, label]) => `<div class="nav-item ${st.special === k ? 'active' : ''}" data-sp="${k}"><span class="ico">${ico}</span>${label}<span class="count">${cnt[k]}</span></div>`).join('');
  sp.querySelectorAll('[data-sp]').forEach((el) => el.onclick = () => setView({ special: el.dataset.sp }));

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
  rels.forEach((r, i) => { if (thumbs.has(r) && moved[i]) thumbs.set(moved[i], thumbs.get(r)); });
  await reload();
}
async function renameItem(rel, isFolder) {
  const name = await promptModal(isFolder ? 'Zmień nazwę folderu' : 'Zmień nazwę pliku', baseName(rel), 'Zmień', !isFolder);
  if (!name || name === baseName(rel)) return;
  const nr = await safe(() => api.rename(rel, name));
  if (!nr) return;
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
  if (!visible.length) empty.innerHTML = `<div><div class="big">Pusto</div>${st.search || st.tag || st.format !== 'all' ? 'Nic nie pasuje do filtrów.' : 'Przeciągnij tu pliki STL / 3MF / OBJ / G-code, aby je dodać.'}</div>`;
  grid.innerHTML = visible.map((f) => {
    const m = lib.meta[f.rel] || {};
    const t = thumbs.get(f.rel);
    const img = t && t !== 'none' ? `<img src="${t}" class="${f.image ? 'photo' : ''}" draggable="false">` : t === 'none' ? `<span class="ph">${esc(f.ext)}</span>` : '<span class="spin"></span>';
    const flags = `${m.favorite ? '<span class="flag fav">★</span>' : ''}${m.status === 'todo' ? '<span class="flag todo">◷</span>' : ''}${m.status === 'printed' ? '<span class="flag printed">✓</span>' : ''}`;
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
    const names = { all: 'Wszystkie modele', fav: 'Ulubione', todo: 'Do wydruku', printed: 'Wydrukowane', untagged: 'Bez tagów' };
    h += `<span class="c cur">${names[st.special]}</span>`;
  }
  if (st.tag) h += `<span class="sep">·</span><span class="tag active" id="clearTag"><span class="dot" style="background:${tagColor(st.tag)}"></span>${esc(st.tag)} <span class="x">✕</span></span>`;
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
grid.addEventListener('dblclick', (e) => { const card = e.target.closest('.card'); if (card) api.open(card.dataset.rel).catch((er) => toast(er.message, true)); });
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
  if (one) items.push({ label: 'Otwórz (slicer / domyślny program)', hint: 'Enter', action: () => api.open(rel).catch((er) => toast(er.message, true)) });
  if (one) items.push({ label: 'Pokaż w Eksploratorze', action: () => api.reveal(rel) });
  items.push({ label: 'Przenieś do…', action: async () => { const d = await pickFolderModal(one ? `Przenieś „${baseName(rel)}”` : `Przenieś ${rels.length} pliki`); if (d !== null) await moveItems(rels, d); } });
  if (one) items.push({ label: 'Zmień nazwę…', hint: 'F2', action: () => renameItem(rel, false) });
  items.push('-');
  const allFav = rels.every((r) => metaOf(r).favorite);
  items.push({ label: allFav ? 'Usuń z ulubionych' : 'Dodaj do ulubionych', hint: 'F', action: () => setMetaMany(rels, () => ({ favorite: !allFav })) });
  items.push({ label: 'Oznacz: do wydruku', action: () => setMetaMany(rels, () => ({ status: 'todo' })) });
  items.push({ label: 'Oznacz: wydrukowane', action: () => setMetaMany(rels, () => ({ status: 'printed' })) });
  items.push({ label: 'Dodaj tag…', action: () => bulkTag(rels) });
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
function setCardThumb(rel) {
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
    const cached = await api.getThumb(f.rel, f.mtime, f.size).catch(() => null);
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
        url = renderThumbnail(parseModel(f.ext, buf));
      }
      if (url) api.putThumb(f.rel, f.mtime, f.size, url).catch(() => {});
    } catch (e) { console.warn('thumb', rel, e); }
    thumbs.set(rel, url || 'none');
    setCardThumb(rel);
  }
  busy = false;
}

// ---------- detail ----------
function statsKey(f) { return `mv.stats:${f.rel}:${f.mtime}:${f.size}`; }

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
        <button class="btn" id="bTag">Dodaj tag…</button>
        <button class="btn" id="bFav">★ Ulubione</button>
        <button class="btn" id="bMove">Przenieś do…</button>
        <button class="btn danger" id="bDel">Usuń</button>
      </div>`;
    body.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => setMetaMany(rels, () => ({ status: b.dataset.st })));
    $('#bTag').onclick = () => bulkTag(rels);
    $('#bFav').onclick = () => { const all = rels.every((r) => metaOf(r).favorite); setMetaMany(rels, () => ({ favorite: !all })); };
    $('#bMove').onclick = async () => { const d = await pickFolderModal(`Przenieś ${rels.length} pliki`); if (d !== null) await moveItems(rels, d); };
    $('#bDel').onclick = () => trashItems(rels, false);
    return;
  }

  const rel = focused && sel.has(focused) ? focused : [...sel][0];
  const f = lib.files.find((x) => x.rel === rel);
  if (!f) return;
  const m = lib.meta[rel] || {};
  const stats = ls.get(statsKey(f), null);
  const fmt = (n, d = 1) => n.toLocaleString('pl-PL', { maximumFractionDigits: d, minimumFractionDigits: d });
  const statHtml = (s) => s ? `
      <div class="stat wide dims"><div class="k">Wymiary (X × Y × Z)</div><div class="v">${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} mm</div></div>
      ${s.volume ? `<div class="stat"><div class="k">Objętość</div><div class="v">${fmt(s.volume, 2)} cm³</div></div>
      <div class="stat"><div class="k">≈ waga PLA (100%)</div><div class="v">${fmt(s.volume * 1.24)} g</div></div>` : ''}
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
    <div class="label">Notatki</div>
    <textarea class="notes" id="dNotes" placeholder="np. ustawienia druku, filament, podpory, link do źródła…">${esc(m.notes || '')}</textarea>
    <div class="btns">
      <button class="btn primary" id="dOpen">Otwórz</button>
      <button class="btn" id="dReveal">Pokaż w Eksploratorze</button>
      <button class="btn" id="dMove">Przenieś…</button>
      <button class="btn danger" id="dDel">Usuń</button>
    </div>`;

  $('#dName').onclick = () => renameItem(rel, false);
  $('#dPath').onclick = () => api.reveal(rel);
  $('#dFav').onclick = () => setMetaMany([rel], (x) => ({ favorite: !x.favorite }));
  body.querySelectorAll('#dStatus [data-st]').forEach((b) => b.onclick = () => setMetaMany([rel], () => ({ status: b.dataset.st })));
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
  $('#dOpen').onclick = () => api.open(rel).catch((er) => toast(er.message, true));
  $('#dReveal').onclick = () => api.reveal(rel);
  $('#dMove').onclick = async () => { const d = await pickFolderModal(`Przenieś „${f.name}”`); if (d !== null) await moveItems([rel], d); };
  $('#dDel').onclick = () => trashItems([rel], false);

  loadPreview(f);
}
function renderGridSoft() { /* notatki nie zmieniają kart */ }

async function loadPreview(f) {
  const token = ++viewToken;
  const msg = $('#viewerMsg');
  const tools = $('#viewerTools');
  if (viewer.currentRel === f.rel + f.mtime && viewer.holder) return;
  viewer.clear();
  viewer.currentRel = null;
  tools.hidden = true;
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
    viewer.show(parsed);
    viewer.currentRel = f.rel + f.mtime;
    msg.innerHTML = '';
    tools.hidden = false;
    $('#vTravel').hidden = !parsed.isGcode;
    if (!ls.get(statsKey(f), null)) {
      const s = computeStats(viewer.holder, parsed.isGcode);
      ls.set(statsKey(f), s);
      if (token === viewToken && focused === f.rel) {
        const box = $('#dStats');
        if (box) {
          const fmt = (n, d = 1) => n.toLocaleString('pl-PL', { maximumFractionDigits: d, minimumFractionDigits: d });
          box.querySelector(".dims")?.remove();
          box.insertAdjacentHTML('afterbegin', `
            <div class="stat wide dims"><div class="k">Wymiary (X × Y × Z)</div><div class="v">${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} mm</div></div>
            ${s.volume ? `<div class="stat"><div class="k">Objętość</div><div class="v">${fmt(s.volume, 2)} cm³</div></div>
            <div class="stat"><div class="k">≈ waga PLA (100%)</div><div class="v">${fmt(s.volume * 1.24)} g</div></div>` : ''}
            ${s.tris ? `<div class="stat"><div class="k">Trójkąty</div><div class="v">${s.tris.toLocaleString('pl-PL')}</div></div>` : ''}`);
        }
      }
    }
  } catch (e) {
    if (token !== viewToken) return;
    console.warn(e);
    const t = thumbs.get(f.rel);
    msg.innerHTML = (t && t !== 'none' ? `<img src="${t}"><br>` : '') + `<span>Nie udało się wczytać modelu: ${esc(e.message)}</span>`;
    const box = $('#dStats'); box?.querySelector(".dims")?.remove();
  }
}

$('#vReset').onclick = () => viewer.resetView();
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if (typing) { if (e.key === 'Escape') document.activeElement.blur(); return; }
  if (!lib) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); visible.forEach((f) => sel.add(f.rel)); updateSelectionClasses(); renderDetail(); return; }
  if (e.key === 'Escape') { sel.clear(); focused = null; updateSelectionClasses(); renderDetail(); return; }
  if (e.key === 'Delete' && sel.size) { trashItems([...sel], false); return; }
  if (e.key === 'F2' && sel.size === 1) { renameItem([...sel][0], false); return; }
  if (e.key === 'Enter' && sel.size === 1) { api.open([...sel][0]).catch((er) => toast(er.message, true)); return; }
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

reload();
window.__mv = { st, sel, selectCard, reload, get lib() { return lib; } };
