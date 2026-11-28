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

// ---------- nazwy zależne od systemu (Eksplorator / Finder, Kosz / Trash) ----------
export const PLATFORM = (typeof window !== 'undefined' && window.api && window.api.platform) || 'win32';
const PLATFORM_WORDS = {
  darwin: {
    pl: [[/Eksploratorze plików/g, 'Finderze'], [/Eksploratorze/g, 'Finderze'], [/Windows otwiera/g, 'macOS otwiera'], [/Ctrl\+/g, '⌘']],
    en: [[/File Explorer/g, 'Finder'], [/Explorer/g, 'Finder'], [/Recycle Bin/g, 'Trash'], [/Windows opens/g, 'macOS opens'], [/Ctrl\+/g, '⌘']],
    de: [[/Explorer/g, 'Finder'], [/Windows öffnet/g, 'macOS öffnet'], [/Strg\+/g, '⌘']],
  },
  linux: {
    pl: [[/w Eksploratorze plików/g, 'w menedżerze plików'], [/w Eksploratorze/g, 'w menedżerze plików'], [/Windows otwiera/g, 'system otwiera']],
    en: [[/in File Explorer/g, 'in the file manager'], [/in Explorer/g, 'in the file manager'], [/File Explorer/g, 'the file manager'], [/Recycle Bin/g, 'Trash'], [/Windows opens/g, 'the system opens']],
    de: [[/im Explorer/g, 'im Dateimanager'], [/Explorer/g, 'Dateimanager'], [/Windows öffnet/g, 'das System öffnet']],
  },
};
export function platformize(s, platform = PLATFORM, lang = LANG) {
  const rules = PLATFORM_WORDS[platform] && PLATFORM_WORDS[platform][lang];
  if (!rules || typeof s !== 'string') return s;
  for (const [re, to] of rules) s = s.replace(re, to);
  return s;
}
