// Wycena wydruków – ta sama logika co w arkuszu „Druk 3D – skoroszyt wyceny”.
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { LOCALE } from './i18n.js';

export const fmtMoney = (v, cur = 'zł') => `${(Number.isFinite(v) ? v : 0).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
export const fmtNum = (v, d = 2) => (Number.isFinite(v) ? v : 0).toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
export function fmtDuration(min) {
  if (!Number.isFinite(min) || min <= 0) return '—';
  const m = Math.round(min), h = Math.floor(m / 60), r = m % 60;
  return h ? `${h} h ${String(r).padStart(2, '0')} min` : `${r} min`;
}
/** "2:37", "2h 37m", "157", "2,5h", "1d 2h" -> minuty */
export function parseDuration(txt) {
  if (txt == null) return null;
  const s = String(txt).trim().toLowerCase().replace(',', '.');
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/))) return +m[1] * 60 + +m[2] + (m[3] ? +m[3] / 60 : 0);
  if (/^\d+(\.\d+)?$/.test(s)) return +s;
  let total = 0, any = false;
  const re = /(\d+(?:\.\d+)?)\s*(d|h|godz|g|m|min|s)/g;
  while ((m = re.exec(s))) {
    any = true;
    const v = +m[1], u = m[2];
    total += u === 'd' ? v * 1440 : (u === 'h' || u === 'g' || u === 'godz') ? v * 60 : u === 's' ? v / 60 : v;
  }
  return any ? total : null;
}

/**
 * items: [{ grams, minutes, qty, filament }]   (qty = ile razy drukujesz)
 * includeOrderTime: czy doliczać czas „na całe zamówienie”
 */
export function priceItems(items, p, includeOrderTime = true) {
  let grams = 0, minutes = 0, prints = 0, filament = 0;
  const byFil = new Map();
  for (const it of items) {
    const q = Math.max(0, Number(it.qty) || 0);
    const min = (Number(it.minutes) || 0) * q;
    minutes += min; prints += q * Math.max(1, Number(it.plates) || 1);
    const parts = it.parts && it.parts.length ? it.parts : [{ grams: it.grams, filament: it.filament }];
    for (const pt of parts) {
      const g = (Number(pt.grams) || 0) * q;
      grams += g;
      const price = pt.filament ? Number(pt.filament.pricePerKg) || 0 : 0;
      const c = (g / 1000) * price;
      filament += c;
      const key = pt.filament ? pt.filament.id : '_none';
      const cur = byFil.get(key) || { filament: pt.filament || null, grams: 0, cost: 0 };
      cur.grams += g; cur.cost += c;
      byFil.set(key, cur);
    }
  }
  const hours = minutes / 60;
  const kWh = hours * (p.printerW / 1000) + prints * p.startKWh;
  const energy = kWh * p.kWhPrice;
  const wear = hours * (p.printerPrice / Math.max(1, p.printerLife) + p.servicePerH);
  const laborH = (prints * p.minPerPrint + (includeOrderTime && prints > 0 ? p.minPerOrder : 0)) / 60;
  const labor = laborH * p.hourRate;
  const buffer = (filament + energy + wear) * p.buffer;
  const cost = filament + energy + wear + labor + buffer;
  let price = cost * (1 + (Number(p.margin) || 0));
  const step = Number(p.roundTo) || 0;
  if (step > 0) price = Math.ceil(price / step - 1e-9) * step;
  return { grams, minutes, hours, prints, filament, kWh, energy, wear, laborH, labor, buffer, cost, price, byFil: [...byFil.values()] };
}

// ---------- dane ze slicera ----------
function parseSlicerText(text) {
  let grams = null, minutes = null, lengthMm = null, m;
  // PrusaSlicer / Orca / SuperSlicer
  if ((m = text.match(/;\s*total filament used \[g\]\s*=\s*([\d.]+)/i))) grams = +m[1];
  else if ((m = text.match(/;\s*filament used \[g\]\s*=\s*([\d.,\s]+)/i))) grams = m[1].split(',').reduce((a, b) => a + (parseFloat(b) || 0), 0);
  // Bambu Studio
  if (grams == null && (m = text.match(/;\s*total filament weight \[g\]\s*:\s*([\d.,\s]+)/i))) grams = m[1].split(',').reduce((a, b) => a + (parseFloat(b) || 0), 0);
  // czas
  if ((m = text.match(/;\s*estimated printing time(?: \(normal mode\))?\s*=\s*([^\r\n]+)/i))) minutes = parseDuration(m[1]);
  else if ((m = text.match(/total estimated time:\s*([^;\r\n]+)/i))) minutes = parseDuration(m[1]);
  else if ((m = text.match(/;\s*model printing time:\s*([^;\r\n]+)/i))) minutes = parseDuration(m[1]);
  // Cura
  if (minutes == null && (m = text.match(/;TIME:(\d+)/))) minutes = +m[1] / 60;
  if (grams == null && (m = text.match(/;Filament used:\s*([\d.]+)m/i))) lengthMm = +m[1] * 1000;
  if (grams == null && lengthMm == null && (m = text.match(/;\s*(?:total )?filament used \[mm\]\s*=\s*([\d.,\s]+)/i))) lengthMm = m[1].split(',').reduce((a, b) => a + (parseFloat(b) || 0), 0);
  return { grams, minutes, lengthMm };
}

export function slicerInfoFromGcode(buffer) {
  const u8 = new Uint8Array(buffer);
  const dec = new TextDecoder();
  const N = 400_000;
  const text = u8.length <= N * 2 ? dec.decode(u8) : dec.decode(u8.subarray(0, N)) + '\n' + dec.decode(u8.subarray(u8.length - N));
  const r = parseSlicerText(text);
  if (r.grams == null && r.minutes == null && r.lengthMm == null) return null;
  return { ...r, source: 'G-code' };
}

export function slicerInfoFrom3mf(buffer) {
  try {
    const files = unzipSync(new Uint8Array(buffer), { filter: (f) => /slice_info\.config$/i.test(f.name) || /Metadata\/plate_\d+\.gcode$/i.test(f.name) });
    const cfgName = Object.keys(files).find((n) => /slice_info\.config$/i.test(n));
    if (cfgName) {
      const xml = strFromU8(files[cfgName]);
      let sec = 0, g = 0, any = false, m;
      const reP = /key="prediction"\s+value="([\d.]+)"/g, reW = /key="weight"\s+value="([\d.]+)"/g;
      while ((m = reP.exec(xml))) { sec += +m[1]; any = true; }
      while ((m = reW.exec(xml))) { g += +m[1]; any = true; }
      if (any) return { grams: g || null, minutes: sec ? sec / 60 : null, source: '3MF (slicer)' };
    }
    const gc = Object.keys(files).find((n) => /\.gcode$/i.test(n));
    if (gc) { const r = parseSlicerText(strFromU8(files[gc])); if (r.grams != null || r.minutes != null) return { ...r, source: '3MF (slicer)' }; }
  } catch { /* nie zip / uszkodzony */ }
  return null;
}
