// Tłumaczenia interfejsu. Kluczem jest tekst polski; brak tłumaczenia = tekst polski.
import EN from './locales/en.js';
import DE from './locales/de.js';

export const LANGS = { pl: 'Polski', en: 'English', de: 'Deutsch' };
const DICTS = { en: EN, de: DE };
const LOCALES = { pl: 'pl-PL', en: 'en-GB', de: 'de-DE' };

function detect() {
  try {
    const v = JSON.parse(localStorage.getItem('mv.lang'));
    if (v && LANGS[v]) return v;
  } catch { /* brak localStorage (Node) */ }
  const n = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en').slice(0, 2).toLowerCase();
  return LANGS[n] ? n : 'en';
}

export const LANG = detect();
export const LOCALE = LOCALES[LANG];

export function T(key, vars) {
  const d = DICTS[LANG];
  let s = d && d[key] != null ? d[key] : key;
  if (vars) s = s.replace(/\{(\d+)\}/g, (m, i) => (vars[i] !== undefined ? vars[i] : m));
  return s;
}

/** Zapamiętuje język (zmiana wymaga przeładowania okna). */
export function setLang(l) {
  try { localStorage.setItem('mv.lang', JSON.stringify(l)); } catch { /* ignore */ }
}
