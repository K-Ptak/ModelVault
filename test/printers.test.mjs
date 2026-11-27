// Biblioteka drukarek i sprawdzanie, czy model mieści się w obszarze roboczym.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRINTER_LIBRARY, printerById, printerFromPreset, presetPrice, fitsVolume, checkModelFit } from '../renderer/printers.js';

const BED = { x: 256, y: 256, z: 256 };
const MK4 = { x: 250, y: 210, z: 220 };

test('biblioteka: unikalne id i sensowne wymiary', () => {
  const ids = new Set();
  for (const p of PRINTER_LIBRARY) {
    assert.ok(!ids.has(p.id), `powtórzone id ${p.id}`); ids.add(p.id);
    assert.equal(p.bed.length, 3);
    for (const v of p.bed) assert.ok(v >= 100 && v <= 1000, `${p.id}: ${v}`);
    assert.ok(p.w > 0 && p.w < 1000);
    assert.ok(p.brand && p.name);
  }
  assert.deepEqual(printerById('mk4s').bed, [250, 210, 220]);
  assert.equal(printerById('nie-ma'), null);
});

test('drukarka z presetu i cena zależna od waluty', () => {
  const p = printerFromPreset(printerById('a1mini'), 'x');
  assert.deepEqual(p, { id: 'x', preset: 'a1mini', name: 'Bambu Lab A1 mini', x: 180, y: 180, z: 180 });
  assert.equal(presetPrice(printerById('a1mini'), 'zł'), 1100);
  assert.equal(presetPrice(printerById('a1mini'), '€'), 249);
});

test('fitsVolume: mieści się, za wysoki, za szeroki', () => {
  assert.equal(fitsVolume({ x: 100, y: 100, z: 100 }, BED).fits, true);
  assert.equal(fitsVolume({ x: 256, y: 256, z: 256 }, BED).fits, true, 'dokładnie na wymiar');
  assert.equal(fitsVolume({ x: 256.3, y: 100, z: 10 }, BED).fits, true, 'tolerancja zaokrągleń');
  const tall = fitsVolume({ x: 100, y: 100, z: 300 }, BED);
  assert.equal(tall.fits, false);
  assert.deepEqual(tall.over, { x: 0, y: 0, z: 44 });
  const wide = fitsVolume({ x: 270, y: 100, z: 10 }, BED);
  assert.equal(wide.fits, false);
  assert.equal(wide.over.x, 14);
});

test('fitsVolume: obrót o 90° na stole prostokątnym', () => {
  const r = fitsVolume({ x: 200, y: 240, z: 50 }, MK4); // 240 > 210 w Y, ale po obrocie 240 ≤ 250 w X
  assert.equal(r.fits, true);
  assert.equal(r.rotated, true);
  assert.equal(fitsVolume({ x: 240, y: 200, z: 50 }, MK4).rotated, false);
  assert.equal(fitsVolume({ x: 240, y: 240, z: 50 }, MK4).fits, false);
});

test('fitsVolume: brak danych / zła drukarka → null', () => {
  assert.equal(fitsVolume(null, BED), null);
  assert.equal(fitsVolume({ x: 1, y: 1, z: 1 }, { x: 0, y: 10, z: 10 }), null);
  assert.equal(fitsVolume({ x: NaN, y: 1, z: 1 }, BED), null);
});

test('checkModelFit: wybiera drukarkę, na której model się mieści', () => {
  const printers = [{ name: 'Mini', x: 180, y: 180, z: 180 }, { name: 'Duża', x: 350, y: 350, z: 350 }];
  const r = checkModelFit({ x: 200, y: 200, z: 100 }, printers);
  assert.equal(r.fits, true);
  assert.equal(r.best.printer.name, 'Duża');
  assert.equal(r.printers[0].fits, false);
  const no = checkModelFit({ x: 400, y: 100, z: 100 }, printers);
  assert.equal(no.fits, false);
  assert.equal(no.best.printer.name, 'Mini');
  assert.equal(checkModelFit({ x: 1, y: 1, z: 1 }, []), null);
  assert.equal(checkModelFit(null, printers), null);
});

test('checkModelFit: plik wielopłytowy sprawdzany płyta po płycie', () => {
  const stats = { x: 900, y: 600, z: 110, plates: [{ id: 1, x: 163, y: 154, z: 55 }, { id: 2, x: 224, y: 220, z: 110 }, { id: 3, x: 106, y: 166, z: 5 }] };
  const a1mini = [{ name: 'A1 mini', x: 180, y: 180, z: 180 }];
  const r = checkModelFit(stats, a1mini);
  assert.equal(r.fits, false, 'płyta 2 nie zmieści się na A1 mini');
  assert.deepEqual(r.best.plates.filter((p) => !p.fits).map((p) => p.id), [2]);
  assert.equal(checkModelFit(stats, [{ name: 'P1S', x: 256, y: 256, z: 256 }]).fits, true, 'całość 900 mm szer. nie ma znaczenia – liczą się płyty');
});
