// Kalendarz i powiadomienia o terminach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, addDays, daysBetween, monthGrid, collectEvents, byDay, attentionCount, dueNotifications, pruneSent, isDay } from '../renderer/calendar.js';

const NOW = new Date(2026, 10, 27, 10, 30).getTime(); // 27.11.2026, 10:30 (piątek)
const TODAY = '2026-11-27';
const ord = (id, deadline, status = 'printing') => ({ id, no: '2026/00' + id, name: 'Zam ' + id, status, deadline });

test('daty: klucz dnia, dodawanie dni, różnica, walidacja', () => {
  assert.equal(dayKey(NOW), TODAY);
  assert.equal(addDays(TODAY, 5), '2026-12-02');
  assert.equal(addDays('2026-03-28', 2), '2026-03-30', 'zmiana czasu na letni');
  assert.equal(daysBetween(TODAY, '2026-12-01'), 4);
  assert.equal(daysBetween('2026-10-24', '2026-10-27'), 3, 'zmiana czasu na zimowy');
  assert.ok(isDay('2026-02-28'));
  for (const bad of [null, '', '2026-2-3', 'jutro', 42]) assert.equal(isDay(bad), false);
});

test('siatka miesiąca zaczyna się od poniedziałku i ma 6 tygodni', () => {
  const g = monthGrid(2026, 10); // listopad 2026 – 1.11 to niedziela
  assert.equal(g.length, 42);
  assert.equal(g[0].key, '2026-10-26');
  assert.equal(g[6].key, '2026-11-01');
  assert.equal(g.filter((d) => d.inMonth).length, 30);
});

test('wydarzenia: terminy, zaplanowane wydruki, koniec druku z kolejki', () => {
  const orders = [ord(1, '2026-11-25'), ord(2, TODAY), ord(3, '2026-11-29', 'quoted'), ord(4, '2026-11-20', 'done'), ord(5, null)];
  const plans = [{ id: 'p1', date: '2026-11-28', time: '08:00', title: 'Wazon' }, { id: 'p2', date: '2026-11-26', title: 'Stare', done: false }, { id: 'p3', date: 'zła data' }];
  const schedule = [{ o: orders[1], end: new Date(2026, 10, 28, 14, 5).getTime(), late: 3600000 }];
  const ev = collectEvents(orders, plans, schedule, TODAY);
  assert.equal(ev.filter((e) => e.kind === 'deadline').length, 4, 'zamówienie bez terminu pomijane');
  assert.equal(ev.find((e) => e.id === 'dl:1').overdue, true);
  assert.equal(ev.find((e) => e.id === 'dl:2').soon, true);
  assert.equal(ev.find((e) => e.id === 'dl:4').active, false, 'wydane zamówienie nie jest przeterminowane');
  assert.equal(ev.find((e) => e.id === 'dl:4').overdue, false);
  assert.deepEqual(ev.find((e) => e.kind === 'finish'), { kind: 'finish', id: 'fin:2', date: '2026-11-28', time: '14:05', order: orders[1], late: true });
  assert.equal(ev.find((e) => e.id === 'plan:p2').overdue, true);
  assert.ok(!ev.some((e) => e.id === 'plan:p3'));
  const days = ev.map((e) => e.date);
  assert.deepEqual(days, [...days].sort(), 'posortowane po dacie');
  assert.deepEqual(byDay(ev).get('2026-11-28').map((e) => e.kind), ['plan', 'finish']);
  assert.equal(attentionCount(ev, TODAY), 4, 'przeterminowany + dzisiejszy termin + zaległy plan + spóźniony koniec druku');
});

test('powiadomienia: przed terminem, w dniu terminu, po terminie (raz dziennie)', () => {
  const data = { orders: [ord(1, '2026-11-28'), ord(2, TODAY), ord(3, '2026-11-24'), ord(4, '2026-11-24', 'done'), ord(5, '2026-12-05')] };
  const n = dueNotifications(data, NOW, {}, { daysBefore: 1, hour: 9 });
  assert.deepEqual(n.map((x) => [x.type, x.order.id, x.days]), [['soon', 1, 1], ['today', 2, 0], ['overdue', 3, 3]]);
  const sent = Object.fromEntries(n.map((x) => [x.key, NOW]));
  assert.deepEqual(dueNotifications(data, NOW + 3600000, sent, { daysBefore: 1, hour: 9 }), [], 'bez powtórek tego samego dnia');
  const tomorrow = new Date(2026, 10, 28, 9, 5).getTime();
  const n2 = dueNotifications(data, tomorrow, sent, { daysBefore: 1, hour: 9 });
  assert.deepEqual(n2.map((x) => [x.type, x.order.id]).sort(), [['overdue', 2], ['overdue', 3], ['today', 1]].sort());
});

test('powiadomienia: godzina powiadomień i ustawienia', () => {
  const data = { orders: [ord(1, TODAY), ord(2, '2026-11-29'), ord(3, '2026-11-01')] };
  const early = new Date(2026, 10, 27, 7, 0).getTime();
  assert.deepEqual(dueNotifications(data, early, {}, { hour: 9 }), [], 'przed godziną powiadomień nic');
  assert.deepEqual(dueNotifications(data, NOW, {}, { daysBefore: 2, overdueDaily: false }).map((x) => x.type), ['today', 'soon']);
  assert.deepEqual(dueNotifications(data, NOW, {}, { daysBefore: 0, overdueDaily: false }).map((x) => x.type), ['today']);
});

test('powiadomienia: kolejka przewiduje spóźnienie', () => {
  const o = ord(7, '2026-11-28');
  const n = dueNotifications({ orders: [], schedule: [{ o, end: 0, late: 26 * 3600000 }] }, NOW, {}, {});
  assert.deepEqual(n.map((x) => [x.type, x.days]), [['queueLate', 2]]);
  assert.deepEqual(dueNotifications({ schedule: [{ o, late: 1 }] }, NOW, {}, { queueLate: false }), []);
});

test('powiadomienia: zaplanowane wydruki o godzinie albo rano', () => {
  const plans = [
    { id: 'a', date: TODAY, time: '10:00', title: 'Teraz' },
    { id: 'b', date: TODAY, time: '11:00', title: 'Później' },
    { id: 'c', date: TODAY, title: 'Bez godziny' },
    { id: 'd', date: '2026-11-26', time: '08:00', title: 'Wczoraj rano – za stare' },
    { id: 'e', date: TODAY, time: '10:00', title: 'Zrobione', done: true },
  ];
  const n = dueNotifications({ plans }, NOW, {}, { hour: 9 });
  assert.deepEqual(n.map((x) => x.plan.id), ['a', 'c']);
  assert.deepEqual(dueNotifications({ plans }, NOW, {}, { plans: false }), []);
});

test('pruneSent usuwa stare wpisy', () => {
  const s = pruneSent({ a: NOW - 90 * 86400000, b: NOW - 86400000 }, NOW);
  assert.deepEqual(Object.keys(s), ['b']);
});
