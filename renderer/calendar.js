// Kalendarz i powiadomienia: czysta logika (bez DOM), testowana w test/calendar.test.mjs.
// Daty dni jako lokalne 'RRRR-MM-DD', godziny jako 'GG:MM'.

export const ACTIVE = new Set(['quoted', 'printing']); // zamówienia, których termin jeszcze obowiązuje
const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => { const x = d instanceof Date ? d : new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
export const parseDay = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (k, n) => { const d = parseDay(k); d.setDate(d.getDate() + n); return dayKey(d); };
export const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);
const at = (k, hhmm) => { const d = parseDay(k); const [h, m] = (hhmm || '0:0').split(':').map(Number); d.setHours(h || 0, m || 0, 0, 0); return d.getTime(); };
export const isDay = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && !Number.isNaN(parseDay(k).getTime());

/** Siatka miesiąca: 6 tygodni od poniedziałku. */
export function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const shift = (first.getDay() + 6) % 7; // poniedziałek = 0
  const start = new Date(year, month, 1 - shift);
  return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return { key: dayKey(d), day: d.getDate(), inMonth: d.getMonth() === month }; });
}

/**
 * Wydarzenia w kalendarzu.
 * @param orders  zamówienia (S.orders)
 * @param plans   zaplanowane wydruki (S.plans)
 * @param schedule wynik planowania kolejki: [{ o, end, late }]
 * @returns [{ kind: 'deadline'|'finish'|'plan', date, time?, id, ... }]
 */
export function collectEvents(orders = [], plans = [], schedule = [], today = dayKey(new Date())) {
  const ev = [];
  for (const o of orders) {
    if (!o || !isDay(o.deadline)) continue;
    const active = ACTIVE.has(o.status);
    ev.push({ kind: 'deadline', id: 'dl:' + o.id, date: o.deadline, order: o, active, overdue: active && o.deadline < today, soon: active && o.deadline >= today && daysBetween(today, o.deadline) <= 2 });
  }
  for (const s of schedule) {
    if (!s || !s.o || !Number.isFinite(s.end)) continue;
    ev.push({ kind: 'finish', id: 'fin:' + s.o.id, date: dayKey(s.end), time: `${pad(new Date(s.end).getHours())}:${pad(new Date(s.end).getMinutes())}`, order: s.o, late: s.late > 0 });
  }
  for (const p of plans) {
    if (!p || !isDay(p.date)) continue;
    ev.push({ kind: 'plan', id: 'plan:' + p.id, date: p.date, time: p.time || null, plan: p, overdue: !p.done && p.date < today });
  }
  const rank = { deadline: 0, plan: 1, finish: 2 };
  return ev.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time || '99') < (b.time || '99') ? -1 : (a.time || '99') > (b.time || '99') ? 1 : rank[a.kind] - rank[b.kind]));
}

export const byDay = (events) => { const m = new Map(); for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); } return m; };

/** Ile rzeczy wymaga uwagi (przeterminowane + na dziś) – do znaczka na dzwonku. */
export function attentionCount(events, today = dayKey(new Date())) {
  return events.filter((e) => (e.kind === 'deadline' && e.active && e.date <= today) || (e.kind === 'plan' && !e.plan.done && e.date <= today) || (e.kind === 'finish' && e.late)).length;
}

/**
 * Powiadomienia do wysłania teraz. Każde ma unikalny `key`, który zapisujemy w `sent`, żeby nie powtarzać.
 * opts: { daysBefore, hour, overdueDaily, queueLate, plans }
 * Zwraca [{ key, type, order?, plan?, days? }] – tekst buduje interfejs (tłumaczenia).
 */
export function dueNotifications({ orders = [], plans = [], schedule = [] }, now = Date.now(), sent = {}, opts = {}) {
  const o = { daysBefore: 1, hour: 9, overdueDaily: true, queueLate: true, plans: true, ...opts };
  const today = dayKey(now), hourOk = new Date(now).getHours() >= o.hour;
  const out = [];
  const push = (n) => { if (!sent[n.key]) out.push(n); };
  for (const ord of orders) {
    if (!ord || !ACTIVE.has(ord.status) || !isDay(ord.deadline)) continue;
    const d = daysBetween(today, ord.deadline);
    if (d < 0) { if (o.overdueDaily && hourOk) push({ key: `late:${ord.id}:${ord.deadline}:${today}`, type: 'overdue', order: ord, days: -d }); continue; }
    if (d === 0) { if (hourOk) push({ key: `today:${ord.id}:${ord.deadline}`, type: 'today', order: ord, days: 0 }); continue; }
    if (o.daysBefore > 0 && d <= o.daysBefore && hourOk) push({ key: `soon:${ord.id}:${ord.deadline}`, type: 'soon', order: ord, days: d });
  }
  if (o.queueLate) for (const s of schedule) {
    if (!s || !s.o || !(s.late > 0) || !isDay(s.o.deadline)) continue;
    push({ key: `qlate:${s.o.id}:${s.o.deadline}`, type: 'queueLate', order: s.o, days: Math.ceil(s.late / 86400000) });
  }
  if (o.plans) for (const p of plans) {
    if (!p || p.done || !isDay(p.date)) continue;
    const t = p.time ? at(p.date, p.time) : at(p.date, `${o.hour}:00`);
    // w momencie zaplanowanym, ale nie później niż 12 h po nim (aplikacja mogła być zamknięta)
    if (now >= t && now - t < 12 * 3600000) push({ key: `plan:${p.id}:${p.date}:${p.time || ''}`, type: 'plan', plan: p });
  }
  return out;
}

/** Usuwa z `sent` wpisy starsze niż `days` dni. */
export function pruneSent(sent, now = Date.now(), days = 60) {
  const out = {};
  for (const [k, t] of Object.entries(sent || {})) if (now - t < days * 86400000) out[k] = t;
  return out;
}
