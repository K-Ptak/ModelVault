// Testy logiki bez interfejsu: wycena, pliki wielokolorowe, płyty.
// Uruchom: npm test   (opcjonalnie MV_REAL_DIR=ścieżka do folderu z prawdziwymi plikami)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceItems, parseDuration, slicerInfoFromGcode, slicerInfoFrom3mf } from '../renderer/pricing.js';
import { decodePaint, parse3MFColors, gcodeColorInfo, parseGcodePaths, normHex, hexDist } from '../renderer/mc.js';
import { detectPlates } from '../renderer/plates.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(here, 'fixtures', n));
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

const SHEET = { printerW: 120, startKWh: 0.03, kWhPrice: 1.04, hourRate: 40, minPerPrint: 10, minPerOrder: 15, printerPrice: 2359, printerLife: 6000, servicePerH: 0.2, buffer: 0.1, margin: 0, roundTo: 0 };
const FIL = { zloty: { id: 'z', pricePerKg: 69.99 }, bialy: { id: 'b', pricePerKg: 39.99 }, zielony: { id: 'g', pricePerKg: 45 } };

// ---------- wycena ----------
test('wycena zgodna z arkuszem (84,66 zł)', () => {
  const rows = [[74, 157, FIL.zloty], [172, 444, FIL.bialy], [162, 314, FIL.bialy], [40, 253, FIL.zielony], [50, 71, FIL.zielony]];
  const r = priceItems(rows.map(([grams, minutes, filament]) => ({ grams, minutes, filament, qty: 1 })), SHEET);
  close(r.filament, 22.58592);
  close(r.kWh, 2.628);
  close(r.wear, 12.248891666666665);
  close(r.labor, 43.333333333333336);
  close(r.cost, 84.65805816666666);
});

test('wiele szpul w jednym wydruku sumuje się jak osobne pozycje', () => {
  const a = priceItems([{ parts: [{ grams: 30, filament: FIL.bialy }, { grams: 10, filament: FIL.zloty }], minutes: 60, qty: 1 }], SHEET);
  close(a.grams, 40);
  close(a.filament, 30 / 1000 * 39.99 + 10 / 1000 * 69.99);
  assert.equal(a.byFil.length, 2);
});

test('płyty: każda płyta to osobny wydruk (start + czas obsługi)', () => {
  const one = priceItems([{ grams: 100, minutes: 300, filament: FIL.zloty, qty: 1, plates: 1 }], SHEET);
  const five = priceItems([{ grams: 100, minutes: 300, filament: FIL.zloty, qty: 1, plates: 5 }], SHEET);
  assert.equal(five.prints, 5);
  close(five.kWh - one.kWh, 4 * SHEET.startKWh);
  close(five.laborH - one.laborH, 4 * SHEET.minPerPrint / 60);
});

test('marża i zaokrąglanie ceny w górę', () => {
  const r = priceItems([{ grams: 50, minutes: 60, filament: FIL.zloty, qty: 1 }], { ...SHEET, margin: 0.3, roundTo: 5 });
  assert.equal(r.price % 5, 0);
  assert.ok(r.price >= r.cost * 1.3);
});

test('parsowanie czasu w różnych formatach', () => {
  assert.equal(parseDuration('2:37'), 157);
  close(parseDuration('1h 2m 3s'), 62.05);
  assert.equal(parseDuration('1d 2h 3m'), 1563);
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration('2,5h'), 150);
  assert.equal(parseDuration(''), null);
});

// ---------- kolory ----------
test('dekodowanie malowania (TriangleSelector)', () => {
  assert.equal(decodePaint('4'), 1);
  assert.equal(decodePaint('8'), 2);
  assert.equal(decodePaint('0C'), 3);
  assert.equal(decodePaint('1C'), 4);
  assert.equal(decodePaint(''), 0);
});

test('kolory hex i odległość', () => {
  assert.equal(normHex('#ff8000ff'), '#FF8000');
  assert.equal(normHex('#abc'), '#AABBCC');
  assert.equal(normHex('red'), null);
  assert.ok(hexDist('#FFFFFF', '#F2F2F2') < hexDist('#FFFFFF', '#000000'));
});

test('3MF Bambu (projekt): części, malowanie, kolory z projektu', () => {
  const r = parse3MFColors(ab(fx('robot_bambu_projekt.3mf')));
  assert.ok(r);
  assert.deepEqual(r.slots.map((s) => s.ext), [1, 2, 3]);
  assert.equal(r.slots[0].hex, '#F2F2F2');
  assert.equal(r.slots[1].hex, '#1A1A1A');
  assert.ok(r.slots[2].paintArea > 1000, 'pomalowana góra ~1257 mm²');
  assert.equal(r.slice, null);
});

test('3MF Bambu (pocięty): gramy per filament ze slice_info', () => {
  const r = parse3MFColors(ab(fx('robot_bambu_pociety.gcode.3mf')));
  assert.deepEqual(r.slice.perSlotGrams, [33.4, 3.88, 4.09]);
  close(r.slice.minutes, 152);
  const s = slicerInfoFrom3mf(ab(fx('robot_bambu_pociety.gcode.3mf')));
  close(s.grams, 41.37);
});

test('3MF PrusaSlicer: volumes z ekstruderami i extruder_colour', () => {
  const r = parse3MFColors(ab(fx('pionek_prusa.3mf')));
  assert.deepEqual(r.slots.map((s) => s.ext), [1, 2]);
  assert.equal(r.slots[0].hex, '#2E7D32');
  assert.equal(r.slots[1].hex, '#FBC02D');
});

test('G-code: narzędzia, kolory, gramy per filament, zmiany koloru, łuki', () => {
  const text = fx('dwie_wieze.gcode').toString('utf8');
  const ci = gcodeColorInfo(text);
  assert.deepEqual(ci.tools, [0, 1]);
  assert.deepEqual(ci.slots.map((s) => s.hex), ['#3B6FD9', '#F2C230']);
  assert.deepEqual(ci.perSlotGrams, [0.91, 0.52]);
  assert.equal(ci.toolChanges, 24);
  const p = parseGcodePaths(text);
  assert.equal(p.tools.get(1).length / 6, 12 * 40);
  assert.ok(p.tools.get(0).length / 6 > 20 * 40, 'łuki G2 dodają segmenty');
  const si = slicerInfoFromGcode(ab(fx('dwie_wieze.gcode')));
  close(si.grams, 1.43);
  close(si.minutes, 14 + 40 / 60);
});

// ---------- płyty ----------
function cube(x, y, s = 20) {
  const v = [[x, y, 0], [x + s, y, 0], [x + s, y + s, 0], [x, y + s, 0], [x, y, s], [x + s, y, s], [x + s, y + s, s], [x, y + s, s]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return f.flatMap((t) => t.flatMap((i) => v[i]));
}
const mesh = (...cubes) => [{ positions: new Float32Array(cubes.flat()), up: 'z' }];

test('płyty: jeden model = jedna płyta', () => {
  assert.equal(detectPlates(mesh(cube(10, 10))).count, 1);
});
test('płyty: kilka obiektów na jednej płycie to nadal jedna płyta', () => {
  assert.equal(detectPlates(mesh(cube(10, 10), cube(120, 10), cube(10, 200))).count, 1);
});
test('płyty: siatka Bambu co 307,2 mm, kolejność wierszami od góry', () => {
  const r = detectPlates(mesh(cube(30, 30), cube(100, 150), cube(340, 40), cube(650, 60), cube(40, -250)));
  assert.equal(r.count, 4);
  assert.ok(r.plates[0].min[0] < 200 && r.plates[0].min[1] > 0, 'płyta 1 w lewym górnym rogu');
  assert.ok(r.plates[3].min[1] < 0, 'płyta 4 w drugim rzędzie');
});

const REAL = process.env.MV_REAL_DIR;
function readStl(p) {
  const b = fs.readFileSync(p); const n = b.readUInt32LE(80); const out = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) { const o = 84 + i * 50 + 12; for (let k = 0; k < 9; k++) out[i * 9 + k] = b.readFloatLE(o + k * 4); }
  return out;
}
test('prawdziwe pliki: Breakfast_Set z MakerWorld ma 5 płyt', { skip: !REAL || !fs.existsSync(path.join(REAL || '', 'Breakfast_Set.stl')) }, () => {
  const r = detectPlates([{ positions: readStl(path.join(REAL, 'Breakfast_Set.stl')), up: 'z' }]);
  assert.equal(r.count, 5);
  assert.deepEqual(r.plates.map((p) => Math.round(p.max[0] - p.min[0])), [163, 60, 224, 106, 110]);
});
test('prawdziwe pliki: pojedyncze modele mają 1 płytę', { skip: !REAL }, () => {
  for (const f of ['Bit_4PCs.stl', 'Diamond_Icicle.stl']) {
    const p = path.join(REAL, f);
    if (fs.existsSync(p)) assert.equal(detectPlates([{ positions: readStl(p), up: 'z' }]).count, 1, f);
  }
});
