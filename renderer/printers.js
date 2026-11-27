// Biblioteka drukarek: obszar roboczy (X × Y × Z w mm), średni pobór mocy w trakcie druku PLA (W)
// i orientacyjna cena zakupu (PLN / EUR). Wartości z kart produktów – do poprawienia w ustawieniach.

export const PRINTER_LIBRARY = [
  // Bambu Lab
  { id: 'a1mini', brand: 'Bambu Lab', name: 'A1 mini', bed: [180, 180, 180], w: 70, pln: 1100, eur: 249, popular: true },
  { id: 'a1', brand: 'Bambu Lab', name: 'A1', bed: [256, 256, 256], w: 95, pln: 1700, eur: 399, popular: true },
  { id: 'p1p', brand: 'Bambu Lab', name: 'P1P', bed: [256, 256, 256], w: 100, pln: 2200, eur: 499 },
  { id: 'p1s', brand: 'Bambu Lab', name: 'P1S', bed: [256, 256, 256], w: 110, pln: 2700, eur: 649, popular: true },
  { id: 'x1c', brand: 'Bambu Lab', name: 'X1 Carbon', bed: [256, 256, 256], w: 120, pln: 4500, eur: 1099, popular: true },
  { id: 'h2d', brand: 'Bambu Lab', name: 'H2D', bed: [350, 320, 325], w: 160, pln: 9000, eur: 1999 },
  // Prusa
  { id: 'mini', brand: 'Prusa', name: 'MINI+', bed: [180, 180, 180], w: 60, pln: 2000, eur: 459 },
  { id: 'mk3s', brand: 'Prusa', name: 'MK3S+', bed: [250, 210, 210], w: 80, pln: 3300, eur: 799 },
  { id: 'mk4s', brand: 'Prusa', name: 'MK4S', bed: [250, 210, 220], w: 80, pln: 4300, eur: 999, popular: true },
  { id: 'coreone', brand: 'Prusa', name: 'CORE One', bed: [250, 220, 270], w: 100, pln: 5000, eur: 1199, popular: true },
  { id: 'xl', brand: 'Prusa', name: 'XL', bed: [360, 360, 360], w: 150, pln: 9500, eur: 2199 },
  // Creality
  { id: 'ender3v2', brand: 'Creality', name: 'Ender-3 V2', bed: [220, 220, 250], w: 110, pln: 800, eur: 199 },
  { id: 'ender3s1', brand: 'Creality', name: 'Ender-3 S1', bed: [220, 220, 270], w: 110, pln: 1000, eur: 249 },
  { id: 'ender3v3', brand: 'Creality', name: 'Ender-3 V3 / V3 SE', bed: [220, 220, 250], w: 120, pln: 900, eur: 219, popular: true },
  { id: 'ender3v3ke', brand: 'Creality', name: 'Ender-3 V3 KE', bed: [220, 220, 240], w: 120, pln: 1100, eur: 269 },
  { id: 'k1c', brand: 'Creality', name: 'K1 / K1C', bed: [220, 220, 250], w: 140, pln: 1900, eur: 449, popular: true },
  { id: 'k1max', brand: 'Creality', name: 'K1 Max', bed: [300, 300, 300], w: 180, pln: 2900, eur: 699 },
  { id: 'k2plus', brand: 'Creality', name: 'K2 Plus', bed: [350, 350, 350], w: 200, pln: 5500, eur: 1299 },
  // Elegoo
  { id: 'neptune4', brand: 'Elegoo', name: 'Neptune 4 / 4 Pro', bed: [225, 225, 265], w: 120, pln: 1000, eur: 249, popular: true },
  { id: 'neptune4plus', brand: 'Elegoo', name: 'Neptune 4 Plus', bed: [320, 320, 385], w: 160, pln: 1500, eur: 349 },
  { id: 'neptune4max', brand: 'Elegoo', name: 'Neptune 4 Max', bed: [420, 420, 480], w: 220, pln: 1800, eur: 429 },
  { id: 'centauri', brand: 'Elegoo', name: 'Centauri Carbon', bed: [256, 256, 256], w: 120, pln: 1400, eur: 319 },
  // Anycubic
  { id: 'kobra2neo', brand: 'Anycubic', name: 'Kobra 2 Neo', bed: [220, 220, 250], w: 100, pln: 700, eur: 169 },
  { id: 'kobra3', brand: 'Anycubic', name: 'Kobra 3', bed: [250, 250, 260], w: 120, pln: 1300, eur: 299 },
  { id: 'kobras1', brand: 'Anycubic', name: 'Kobra S1', bed: [250, 250, 250], w: 120, pln: 1900, eur: 449 },
  // Qidi
  { id: 'q1pro', brand: 'Qidi', name: 'Q1 Pro', bed: [245, 245, 240], w: 140, pln: 2000, eur: 459 },
  { id: 'plus4', brand: 'Qidi', name: 'Plus4', bed: [305, 305, 280], w: 180, pln: 3300, eur: 769 },
  { id: 'xplus3', brand: 'Qidi', name: 'X-Plus 3', bed: [280, 280, 270], w: 160, pln: 3000, eur: 699 },
  // inne
  { id: 'ad5m', brand: 'Flashforge', name: 'Adventurer 5M / 5M Pro', bed: [220, 220, 220], w: 100, pln: 1300, eur: 299 },
  { id: 'sv06', brand: 'Sovol', name: 'SV06', bed: [220, 220, 250], w: 100, pln: 900, eur: 199 },
  { id: 'sv08', brand: 'Sovol', name: 'SV08', bed: [350, 350, 345], w: 180, pln: 2500, eur: 579 },
  { id: 'voron24_300', brand: 'Voron', name: '2.4 (300 mm)', bed: [300, 300, 280], w: 180, pln: null, eur: null },
  { id: 'voron24_350', brand: 'Voron', name: '2.4 (350 mm)', bed: [350, 350, 330], w: 200, pln: null, eur: null },
  { id: 'trident300', brand: 'Voron', name: 'Trident (300 mm)', bed: [300, 300, 250], w: 180, pln: null, eur: null },
];

export const printerById = (id) => PRINTER_LIBRARY.find((p) => p.id === id) || null;
export const printerLabel = (p) => (p ? `${p.brand} ${p.name}` : '');
export const presetPrice = (p, currency) => (!p ? null : /zł|pln/i.test(currency || '') ? p.pln : p.eur);

/** Drukarka użytkownika z presetu biblioteki. */
export function printerFromPreset(p, id = 'pr' + Date.now().toString(36)) {
  return { id, preset: p.id, name: printerLabel(p), x: p.bed[0], y: p.bed[1], z: p.bed[2] };
}

const TOL = 0.5; // mm – zaokrąglenia w plikach

/**
 * Czy element o wymiarach {x, y, z} (mm, Z = wysokość) zmieści się na stole {x, y, z}.
 * Dopuszcza obrót o 90° wokół osi Z. Zwraca { fits, rotated, over: {x, y, z} } (over = o ile mm za duży).
 */
export function fitsVolume(dims, bed) {
  if (!dims || !bed || !(bed.x > 0 && bed.y > 0 && bed.z > 0)) return null;
  const { x, y, z } = dims;
  if (![x, y, z].every(Number.isFinite)) return null;
  const okZ = z <= bed.z + TOL;
  const straight = x <= bed.x + TOL && y <= bed.y + TOL;
  const rotated = !straight && y <= bed.x + TOL && x <= bed.y + TOL;
  const fits = okZ && (straight || rotated);
  // przekroczenie liczymy dla lepszej z dwóch orientacji
  const o1 = { x: Math.max(0, x - bed.x), y: Math.max(0, y - bed.y) };
  const o2 = { x: Math.max(0, y - bed.x), y: Math.max(0, x - bed.y) };
  const o = o1.x + o1.y <= o2.x + o2.y ? o1 : o2;
  return { fits, rotated, over: { x: fits ? 0 : o.x, y: fits ? 0 : o.y, z: Math.max(0, z - bed.z) } };
}

/**
 * Sprawdza model (statystyki z wymiarami i opcjonalnie płytami) względem drukarek użytkownika.
 * Model wielopłytowy jest sprawdzany płyta po płycie. Zwraca null, gdy brak danych lub drukarek.
 * { fits: bool, printers: [{ printer, fits, plates: [{id, fits, over}], over }] , best }
 */
export function checkModelFit(stats, printers) {
  if (!stats || !Array.isArray(printers) || !printers.length) return null;
  const parts = stats.plates && stats.plates.length > 1 ? stats.plates.map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z })) : [{ id: null, x: stats.x, y: stats.y, z: stats.z }];
  const res = [];
  for (const pr of printers) {
    const plates = parts.map((p) => ({ id: p.id, ...(fitsVolume(p, pr) || { fits: null }) }));
    if (plates.some((p) => p.fits === null)) continue;
    const fits = plates.every((p) => p.fits);
    const over = plates.reduce((a, p) => ({ x: Math.max(a.x, p.over.x), y: Math.max(a.y, p.over.y), z: Math.max(a.z, p.over.z) }), { x: 0, y: 0, z: 0 });
    res.push({ printer: pr, fits, plates, over });
  }
  if (!res.length) return null;
  const ok = res.filter((r) => r.fits);
  return { fits: ok.length > 0, printers: res, best: ok[0] || res[0] };
}
