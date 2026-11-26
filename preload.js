const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(name, ...args) {
  const r = await ipcRenderer.invoke(name, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

contextBridge.exposeInMainWorld('api', {
  getLibrary: () => call('lib:get'),
  chooseLibrary: () => call('lib:choose'),
  readFile: (rel) => call('file:read', rel),
  readImage: (rel) => call('image:read', rel),
  move: (rels, destDir) => call('items:move', rels, destDir),
  rename: (rel, name) => call('item:rename', rel, name),
  createFolder: (parent, name) => call('folder:create', parent, name),
  trash: (rels) => call('items:trash', rels),
  importFiles: (paths, destDir) => call('files:import', paths, destDir),
  setMeta: (rel, patch) => call('meta:set', rel, patch),
  open: (rel) => call('shell:open', rel),
  reveal: (rel) => call('shell:reveal', rel),
  openRoot: () => call('shell:openRoot'),
  getThumb: (rel, mtime, size, v) => call('thumb:get', rel, mtime, size, v),
  putThumb: (rel, mtime, size, v, url) => call('thumb:put', rel, mtime, size, v, url),
  clearThumbs: () => call('thumb:clear'),
  getSettings: () => call('settings:get'),
  setSettings: (s) => call('settings:set', s),
  defaultSettings: () => call('settings:defaults'),
  hashFiles: (rels) => call('files:hash', rels),
  openExternal: (url) => call('shell:external', url),
  copyText: (t) => call('clipboard:write', t),
  saveFile: (name, content) => call('file:save', name, content),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onChanged: (cb) => ipcRenderer.on('lib:changed', cb),
});
