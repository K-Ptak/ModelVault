// Komunikaty w testach po polsku (tekst źródłowy), niezależnie od języka systemu.
globalThis.localStorage = { getItem: (k) => (k === 'mv.lang' ? '"pl"' : null), setItem() {} };
