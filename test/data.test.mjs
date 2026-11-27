// Uszkodzone pliki danych aplikacji (ustawienia, metadane biblioteki, kopie) i archiwa ZIP ze skrzynki „Pobrane”.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { zipSync, unzipSync, strToU8 } from 'three/addons/libs/fflate.module.js';

const require = createRequire(import.meta.url);
const safe = require('../core/safe.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mv-test-'));

test('readJsonSafe: brak pliku, poprawny plik, plik z BOM', () => {
  const d = tmp();
  assert.equal(safe.readJsonSafe(path.join(d, 'nie-ma.json')).state, 'missing');
  fs.writeFileSync(path.join(d, 'ok.json'), '{"a":1}');
  assert.deepEqual(safe.readJsonSafe(path.join(d, 'ok.json')), { state: 'ok', data: { a: 1 } });
  fs.writeFileSync(path.join(d, 'bom.json'), '\uFEFF{"a":2}');
  assert.equal(safe.readJsonSafe(path.join(d, 'bom.json')).data.a, 2);
});

test('readJsonSafe: uszkodzony plik jest odkładany na bok, a nie nadpisywany', () => {
  const d = tmp(), f = path.join(d, 'settings.json');
  for (const bad of ['{"orders": [1, 2', '', '\u0000\u0000\u0000', 'null', '[1,2,3]']) {
    fs.writeFileSync(f, bad);
    const r = safe.readJsonSafe(f, (x) => x && typeof x === 'object' && !Array.isArray(x));
    assert.equal(r.state, 'broken', `dla ${JSON.stringify(bad)}`);
    assert.equal(fs.existsSync(f), false, 'uszkodzony plik powinien zostać przemianowany');
    assert.ok(r.brokenCopy && fs.existsSync(r.brokenCopy));
    assert.equal(fs.readFileSync(r.brokenCopy, 'utf8'), bad, 'zawartość zachowana do odzyskania');
    fs.rmSync(r.brokenCopy);
  }
});

test('metadane biblioteki: zła struktura jest traktowana jak uszkodzenie', () => {
  assert.equal(safe.isMetaData({ version: 1, files: {} }), true);
  for (const bad of [null, {}, { files: [] }, { files: 'x' }, 42]) assert.equal(safe.isMetaData(bad), false);
});

test('kopie zapasowe: walidacja i wybór najnowszej poprawnej kopii', () => {
  assert.equal(safe.isBackupData({ app: 'ModelVault', settings: {} }), true);
  for (const bad of [null, {}, { app: 'Inna', settings: {} }, { app: 'ModelVault' }, { app: 'ModelVault', settings: [] }]) assert.equal(safe.isBackupData(bad), false);
  const d = tmp();
  fs.writeFileSync(path.join(d, 'modelvault-2026-01-01-10-00-00.json'), JSON.stringify({ app: 'ModelVault', settings: { v: 'stara' } }));
  fs.writeFileSync(path.join(d, 'modelvault-2026-02-01-10-00-00.json'), JSON.stringify({ app: 'ModelVault', settings: { v: 'nowa' } }));
  fs.writeFileSync(path.join(d, 'modelvault-2026-03-01-10-00-00.json'), '{"app":"ModelVault","sett'); // ucięta
  fs.writeFileSync(path.join(d, 'modelvault-2026-04-01-10-00-00.json'), JSON.stringify({ app: 'Coś innego' }));
  fs.writeFileSync(path.join(d, 'inny-plik.json'), JSON.stringify({ app: 'ModelVault', settings: { v: 'obcy' } }));
  const b = safe.latestValidBackup(d);
  assert.equal(b.name, 'modelvault-2026-02-01-10-00-00.json');
  assert.equal(b.data.settings.v, 'nowa');
  assert.equal(safe.latestValidBackup(path.join(d, 'brak')), null);
});

test('ZIP: limit rozmiaru po rozpakowaniu (ochrona przed „bombą ZIP”)', () => {
  const big = new Uint8Array(3 * 1024 * 1024); // 3 MB zer kompresuje się do kilku KB
  const z = zipSync({ 'a.stl': big, 'b.stl': big, 'c.stl': big, 'notatka.exe': strToU8('x') });
  const f1 = safe.zipFilter((n) => n.endsWith('.stl'), 10 * 1024 * 1024);
  const out1 = unzipSync(z, { filter: f1 });
  assert.equal(f1.exceeded, false);
  assert.deepEqual(Object.keys(out1).sort(), ['a.stl', 'b.stl', 'c.stl']);
  const f2 = safe.zipFilter((n) => n.endsWith('.stl'), 5 * 1024 * 1024);
  unzipSync(z, { filter: f2 });
  assert.equal(f2.exceeded, true);
  const f3 = safe.zipFilter(() => true, Infinity, 2);
  unzipSync(z, { filter: f3 });
  assert.equal(f3.exceeded, true, 'limit liczby plików');
});

test('ZIP: wpisy próbujące wyjść poza folder docelowy są odrzucane (zip-slip)', () => {
  const dest = path.join(os.tmpdir(), 'mv-dest');
  assert.equal(safe.safeEntryPath(dest, 'model/a.stl'), path.resolve(dest, 'model', 'a.stl'));
  assert.equal(safe.safeEntryPath(dest, './a.stl'), path.resolve(dest, 'a.stl'));
  for (const bad of ['../a.stl', 'x/../../a.stl', '..\\..\\a.stl', '', '/', '..']) assert.equal(safe.safeEntryPath(dest, bad), null, bad);
  assert.equal(safe.safeEntryPath(dest, '/etc/passwd'), path.resolve(dest, 'etc', 'passwd'), 'ścieżka bezwzględna trafia do środka folderu');
  assert.equal(safe.safeEntryPath(dest, 'C:\\Windows\\a.stl'), path.resolve(dest, 'C_', 'Windows', 'a.stl'));
  assert.equal(safe.safeEntryPath(dest, 'a<b>.stl'), path.resolve(dest, 'a_b_.stl'));
});

test('ZIP: uszkodzone archiwum zgłasza błąd, który da się złapać', () => {
  const z = zipSync({ 'a.stl': strToU8('solid a\nendsolid a\n'.repeat(100)) });
  assert.throws(() => unzipSync(z.slice(0, Math.floor(z.length / 2))));
  assert.throws(() => unzipSync(strToU8('to nie jest zip')));
});
