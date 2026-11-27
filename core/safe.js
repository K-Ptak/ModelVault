// Odporne wczytywanie plików danych i rozpakowywanie archiwów (proces główny, bez Electrona — testowalne w node).
'use strict';
const fs = require('fs');
const path = require('path');

const stamp = (d = new Date()) => {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
};

/**
 * Czyta plik JSON. Uszkodzony plik nie jest nadpisywany przy następnym zapisie:
 * zostaje przemianowany na `<nazwa>.broken-<data>.json`, żeby dało się go odzyskać.
 * @returns {{ state: 'ok'|'missing'|'broken', data: any, brokenCopy?: string, error?: string }}
 */
function readJsonSafe(file, validate = (d) => d && typeof d === 'object') {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { state: 'missing', data: null };
    return { state: 'broken', data: null, error: e.message };
  }
  try {
    const data = JSON.parse(text.replace(/^﻿/, ''));
    if (validate(data)) return { state: 'ok', data };
    throw new Error('invalid structure');
  } catch (e) {
    const ext = path.extname(file);
    const brokenCopy = `${file.slice(0, file.length - ext.length)}.broken-${stamp()}${ext || '.json'}`;
    try { fs.renameSync(file, brokenCopy); } catch { /* np. tylko do odczytu – i tak nie nadpisujemy bez zgody */ }
    return { state: 'broken', data: null, brokenCopy, error: e.message };
  }
}

/** Najnowsza poprawna kopia zapasowa z folderu (pliki modelvault-*.json). */
function latestValidBackup(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^modelvault-.*\.json$/.test(n)).sort().reverse(); } catch { return null; }
  for (const n of names) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (isBackupData(d)) return { name: n, data: d };
    } catch { /* uszkodzona kopia – szukamy dalej */ }
  }
  return null;
}

function isBackupData(d) {
  return !!(d && d.app === 'ModelVault' && d.settings && typeof d.settings === 'object' && !Array.isArray(d.settings));
}

function isMetaData(d) {
  return !!(d && typeof d === 'object' && d.files && typeof d.files === 'object' && !Array.isArray(d.files));
}

/**
 * Filtr dla fflate.unzipSync z limitem łącznego rozmiaru po rozpakowaniu (ochrona przed „bombami ZIP”).
 * `accept(name)` decyduje, które pliki rozpakować.
 */
function zipFilter(accept, maxTotal = 2 * 1024 ** 3, maxFiles = 5000) {
  let total = 0, count = 0;
  const f = (file) => {
    if (!accept(file.name)) return false;
    count++; total += file.originalSize || 0;
    if (count > maxFiles || total > maxTotal) { f.exceeded = true; return false; }
    return true;
  };
  f.exceeded = false;
  return f;
}

/** Ścieżka wewnątrz `dest` dla wpisu z archiwum albo null, gdy wpis próbuje wyjść poza folder (zip-slip). */
function safeEntryPath(dest, entry) {
  const clean = entry.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.').map((p) => p.replace(/[:*?"<>|]/g, '_'));
  if (!clean.length || clean.includes('..')) return null;
  const out = path.resolve(dest, ...clean);
  return out.startsWith(path.resolve(dest) + path.sep) ? out : null;
}

module.exports = { readJsonSafe, latestValidBackup, isBackupData, isMetaData, zipFilter, safeEntryPath, stamp };
