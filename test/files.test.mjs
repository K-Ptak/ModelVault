// Odporność na nieobsługiwane, puste i uszkodzone pliki.
// Każdy uszkodzony plik ma kończyć się czytelnym komunikatem (Error z userFacing), a nie wyjątkiem z głębi biblioteki
// ani zawieszeniem aplikacji. Poprawne pliki muszą dalej działać.
import './_lang-pl.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { parseModel, checkStl, computeStats, extract3mfThumbnail } from '../renderer/viewer.js';
import { slicerInfoFromGcode, slicerInfoFrom3mf } from '../renderer/pricing.js';
import { parse3MFColors, gcodeColorInfo, parseGcodePaths } from '../renderer/mc.js';
import { detectPlates } from '../renderer/plates.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(here, 'fixtures', n));
const ab = (u) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
const txt = (s) => ab(new TextEncoder().encode(s));
const zip = (files) => ab(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]))));

// sześcian 10 mm z 12 trójkątów
const CUBE = (() => {
  const v = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return f.map((t) => t.map((i) => v[i]));
})();
function binStl(tris, { declared = tris.length, extra = 0, header = 'binary stl' } = {}) {
  const b = new ArrayBuffer(84 + tris.length * 50 + extra);
  const u = new Uint8Array(b); u.set(new TextEncoder().encode(header).slice(0, 80));
  const dv = new DataView(b); dv.setUint32(80, declared, true);
  tris.forEach((t, i) => { const o = 84 + i * 50 + 12; t.forEach((p, k) => p.forEach((c, j) => dv.setFloat32(o + (k * 3 + j) * 4, c, true))); });
  return b;
}
const asciiStl = (tris) => txt(`solid cube\n${tris.map((t) => `facet normal 0 0 0\n outer loop\n${t.map((p) => `  vertex ${p.join(' ')}`).join('\n')}\n endloop\nendfacet`).join('\n')}\nendsolid cube\n`);
const MODEL_XML = (verts, tris) => `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${verts.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${tris.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;

/** Oczekuje czytelnego błędu (userFacing) z fragmentem tekstu */
function rejects(ext, buf, re) {
  assert.throws(() => parseModel(ext, buf), (e) => {
    assert.ok(e.userFacing, `błąd techniczny zamiast czytelnego: ${e.message}`);
    if (re) assert.match(e.message, re);
    return true;
  });
}

// ---------- poprawne pliki dalej działają ----------
test('poprawny STL binarny i ASCII: sześcian 10 mm', () => {
  for (const buf of [binStl(CUBE), asciiStl(CUBE)]) {
    const p = parseModel('stl', buf);
    const s = computeStats(p.object, false, p.zUp);
    assert.equal(s.tris, 12);
    assert.ok(Math.abs(s.x - 10) < 1e-4 && Math.abs(s.y - 10) < 1e-4 && Math.abs(s.z - 10) < 1e-4);
    assert.ok(Math.abs(s.volume - 1) < 1e-4, `objętość ${s.volume} cm³`);
    assert.deepEqual(p.warnings, []);
  }
});

test('STL binarny z nagłówkiem zaczynającym się od „solid” jest czytany jako binarny', () => {
  const p = parseModel('stl', binStl(CUBE, { header: 'solid exported by CAD' }));
  assert.equal(computeStats(p.object, false, p.zUp).tris, 12);
});

test('STL binarny z nadmiarowymi bajtami na końcu', () => {
  const p = parseModel('stl', binStl(CUBE, { extra: 37 }));
  assert.equal(computeStats(p.object, false, p.zUp).tris, 12);
});

test('prawdziwe pliki z fixtures dalej się wczytują', () => {
  assert.ok(parseModel('obj', ab(fx('grzybek_2materialy.obj'))).slots.length >= 2);
  assert.ok(parseModel('3mf', ab(fx('robot_bambu_projekt.3mf'))).slots.length >= 2);
  assert.ok(parseModel('3mf', ab(fx('pionek_prusa.3mf'))).slots.length >= 2);
  assert.ok(parseModel('gcode', ab(fx('dwie_wieze.gcode'))).isGcode);
});

// ---------- puste i nieobsługiwane ----------
test('pusty plik (0 bajtów) w każdym formacie', () => {
  for (const ext of ['stl', 'obj', '3mf', 'ply', 'gcode']) rejects(ext, new ArrayBuffer(0), /pusty/);
});

test('nieobsługiwany format: czytelny komunikat zamiast awarii', () => {
  for (const ext of ['step', 'scad', 'f3d', 'blend', 'xyz', '']) rejects(ext, txt('ISO-10303-21;'), /Brak podglądu/);
});

test('plik z inną zawartością niż rozszerzenie (np. PNG zapisany jako .stl / .3mf)', () => {
  const png = ab(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(7)]));
  rejects('stl', png, /STL/);
  rejects('3mf', png, /3MF/);
  rejects('ply', png, /PLY/);
  rejects('gcode', png);
});

// ---------- uszkodzone STL ----------
test('STL: przypadkowe bajty nie powodują ogromnej alokacji pamięci', () => {
  const junk = new Uint8Array(5000); for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919) % 256;
  rejects('stl', ab(junk), /STL/);
});

test('STL: przerwane pobieranie (brakująca końcówka) – komunikat z liczbą trójkątów', () => {
  const full = binStl(CUBE);
  rejects('stl', full.slice(0, 84 + 9 * 50 + 20), /niekompletny.*9.*12/);
  rejects('stl', full.slice(0, 84 + 2 * 50), /niekompletny.*2.*12/); // ucięty w większości
});

test('STL: nagłówek deklaruje 0 trójkątów / brak ścian w ASCII', () => {
  rejects('stl', binStl([], { declared: 0 }), /geometrii/);
  rejects('stl', txt('solid x\nendsolid x\n'), /geometrii/);
});

test('STL: deklaracja nierealnej liczby trójkątów', () => {
  rejects('stl', binStl(CUBE.slice(0, 2), { declared: 4_000_000_000 }), /STL/);
});

test('STL: trójkąty z NaN są pomijane, reszta modelu zostaje', () => {
  const bad = CUBE.map((t, i) => (i < 2 ? [[NaN, 0, 0], t[1], t[2]] : t));
  const p = parseModel('stl', binStl(bad));
  assert.equal(computeStats(p.object, false, p.zUp).tris, 10);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /2/);
  rejects('stl', binStl(CUBE.map((t) => [[Infinity, 0, 0], t[1], t[2]])), /geometrii/);
});

// ---------- OBJ / PLY ----------
test('OBJ: tekst bez geometrii i ściany z indeksami poza zakresem', () => {
  rejects('obj', txt('lorem ipsum\nfoo bar\n'), /geometrii/);
  rejects('obj', txt('v 0 0 0\nf 1 2 3\n'), /geometrii/);
  const p = parseModel('obj', txt('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nf 1 2 9\n')); // jedna dobra, jedna zła ściana
  assert.equal(computeStats(p.object, false, p.zUp).tris, 1);
});

test('PLY: zły nagłówek i nagłówek bez danych', () => {
  rejects('ply', txt('not a ply file'), /PLY/);
  assert.throws(() => parseModel('ply', txt('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n')), (e) => e.userFacing);
});

// ---------- uszkodzone 3MF ----------
test('3MF: nie-ZIP, ZIP bez modelu, uszkodzony XML, pusta siatka', () => {
  rejects('3mf', txt('PK this is not really a zip'), /3MF/);
  rejects('3mf', zip({ 'readme.txt': 'hi' }), /3MF/);
  rejects('3mf', zip({ '3D/3dmodel.model': '<model><resources><object id="1"><mesh><vertices><vertex x="a"' }), /3MF/);
  rejects('3mf', zip({ '3D/3dmodel.model': MODEL_XML([], []) }), /3MF|geometrii/);
});

test('3MF: ucięte archiwum (przerwane pobieranie)', () => {
  const buf = ab(fx('robot_bambu_projekt.3mf'));
  rejects('3mf', buf.slice(0, Math.floor(buf.byteLength * 0.6)));
});

test('3MF: trójkąty z indeksami poza listą wierzchołków są pomijane', () => {
  const v = [[0, 0, 0], [10, 0, 0], [0, 10, 0]];
  rejects('3mf', zip({ '3D/3dmodel.model': MODEL_XML(v, [[0, 5, 9]]) }), /geometrii/);
  const p = parseModel('3mf', zip({ '3D/3dmodel.model': MODEL_XML(v, [[0, 1, 2], [0, 5, 9]]) }));
  assert.equal(computeStats(p.object, false, p.zUp).tris, 1);
});

// ---------- G-code ----------
test('G-code: śmieci, same ruchy jałowe, bardzo długie linie', () => {
  rejects('gcode', txt('%%%%\nhello\n'), /ścieżek/);
  rejects('gcode', txt('G28\nG0 X10 Y10 Z0.2\nG0 X20\n'), /ścieżek/);
  rejects('gcode', txt('G1 X' + '9'.repeat(100000) + ' E1\n'));
});

test('G-code: ujemne/zerowe wartości w komentarzach slicera nie psują wyceny', () => {
  const g = txt('; filament used [g] = -5\n; estimated printing time (normal mode) = abc\nG1 X1 Y1 E1\n');
  const r = slicerInfoFromGcode(g);
  assert.ok(r === null || !(r.grams < 0), `ujemne gramy: ${JSON.stringify(r)}`);
});

// ---------- funkcje pomocnicze nigdy nie rzucają ----------
test('odczyt danych slicera, miniatur i kolorów zwraca null dla uszkodzonych danych', () => {
  for (const buf of [new ArrayBuffer(0), txt('xx'), txt('PK\x03\x04garbage'), zip({ 'a.txt': 'b' })]) {
    assert.equal(slicerInfoFromGcode(buf), null);
    assert.equal(slicerInfoFrom3mf(buf), null);
    assert.equal(extract3mfThumbnail(buf), null);
    assert.equal(parse3MFColors(buf), null);
  }
  const ci = gcodeColorInfo('random text\n\u0000\u0001');
  assert.ok(Array.isArray(ci.slots));
  assert.equal(parseGcodePaths('').tools.size, 0);
  assert.equal(detectPlates([]).count, 0);
});

test('checkStl nie modyfikuje poprawnego bufora', () => {
  const b = binStl(CUBE);
  assert.equal(checkStl(b), b);
});
