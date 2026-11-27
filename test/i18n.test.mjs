// Kontrola tłumaczeń: każdy tekst w T('…') i data-i18n musi mieć tłumaczenie EN i DE z tymi samymi placeholderami.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EN from '../renderer/locales/en.js';
import DE from '../renderer/locales/de.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer');
const unq = (s) => s.replace(/\\(.)/g, (m, c) => ({ n: '\n', t: '\t' }[c] ?? c));
const keys = new Set();
for (const f of ['app.js', 'viewer.js', 'mc.js']) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/(?<![\w$.])(?:T|fail)\('((?:[^'\\]|\\.)*)'/g)) keys.add(unq(m[1]));
}
for (const m of fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/data-i18n(?:-title|-placeholder)?="([^"]*)"/g)) keys.add(m[1]);
const ph = (s) => (s.match(/\{\d+\}/g) || []).sort().join();

for (const [name, dict] of [['EN', EN], ['DE', DE]]) {
  test(`tłumaczenia ${name}: komplet kluczy`, () => {
    const missing = [...keys].filter((k) => dict[k] == null);
    assert.deepEqual(missing, []);
  });
  test(`tłumaczenia ${name}: placeholdery {0}…`, () => {
    const bad = [...keys].filter((k) => dict[k] != null && ph(dict[k]) !== ph(k));
    assert.deepEqual(bad, []);
  });
}
