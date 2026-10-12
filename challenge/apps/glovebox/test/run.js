// Pure rules first, then the page's own files, then end to end over HTTP:
//   GLOVEBOX_MEMORY=1 GLOVEBOX_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /glovebox, the way
// the lab mounts it, so the auth cookie, the budget gate and the metered
// route's parser order are exercised as deployed. Model calls are counted
// from the identity's usage rows - the same rows that bill a real account -
// and what reached "the model" is read from the fake client's own log.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.GLOVEBOX_MEMORY !== '1' || process.env.GLOVEBOX_FAKE_AI !== '1') {
  console.error('run with GLOVEBOX_MEMORY=1 GLOVEBOX_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, fakeCalls } = require('../server');
const C = require('../public/glovebox-core');
const L = require('../public/glovebox-lights');
const D = require('../public/demo');

const ROOT = path.join(__dirname, '..');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------------- helpers ---------------- */

const T = '2026-10-12';
const X = { today: T, currency: 'USD', units: 'mi', region: 'US' };
const mi = (n) => C.toKm(n, 'mi');
/** A car with readings `[daysAgo, miles]` and services `[daysAgo, [items], miles]`. */
function mk(opts) {
  const o = opts || {};
  return C.cleanCar({
    id: 'ctestcar01', make: 'Honda', model: 'Civic', year: 2017, fuel: o.fuel || 'petrol', belt: o.belt || 'chain',
    added: C.addDays(T, -(o.added || 400)),
    readings: (o.readings || [[400, 30000], [0, 42000]]).map(([a, m]) => ({ d: C.addDays(T, -a), km: mi(m) })),
    services: (o.services || []).map(([a, items, m], i) => ({ id: 'stest' + String(i).padStart(4, '0'), d: C.addDays(T, -a), items, km: m === undefined ? null : mi(m), cost: o.cost || null, cur: 'USD' })),
    base: o.base, plan: o.plan, dates: o.dates,
  }, X);
}
const st = (car, id, today) => C.statusOf(car, C.item(id), today || T);

/* ---------------- units, dates, words ---------------- */

test('units: kept in km; miles <-> km round-trips every whole number both ways; display rounding', () => {
  for (let n = 0; n <= 300000; n += 7) {
    assert.strictEqual(Math.round(C.fromKm(C.toKm(n, 'mi'), 'mi')), n, `${n} mi`);
    assert.strictEqual(Math.round(C.fromKm(C.toKm(n, 'km'), 'km')), n, `${n} km`);
  }
  assert.strictEqual(C.toKm(1, 'mi'), 1.61);
  assert.strictEqual(C.toKm(100, 'mi'), 160.93);
  assert.strictEqual(C.dist(mi(48230), 'mi'), '48,230 mi');
  assert.strictEqual(C.dist(77618.4, 'km'), '77,618 km');
  assert.strictEqual(C.roughly(mi(630), 'mi', true), '600 miles');
  assert.strictEqual(C.roughly(mi(87), 'mi'), '90 mi');
  assert.strictEqual(C.toKm(NaN, 'mi'), null);
  // A car stored in km reads the same after a units switch: nothing is rewritten.
  const car = mk();
  assert.strictEqual(C.dist(car.readings[1].km, 'km'), '67,592 km');
  assert.strictEqual(C.dist(car.readings[1].km, 'mi'), '42,000 mi');
});

test('region: miles and currency from the phone\'s locale, km and euros elsewhere', () => {
  assert.deepStrictEqual(['en-US', 'en-GB', 'de-DE', 'fr-CA', 'en-AU', 'ja-JP', 'zh-Hant-HK', 'xx'].map((l) => [C.regionOf(l), C.unitsFor(C.regionOf(l)), C.currencyFor(C.regionOf(l))]),
    [['US', 'mi', 'USD'], ['GB', 'mi', 'GBP'], ['DE', 'km', 'EUR'], ['CA', 'km', 'CAD'], ['AU', 'km', 'AUD'], ['JP', 'km', 'JPY'], ['HK', 'km', 'HKD'], ['US', 'mi', 'USD']]);
  const s = C.cleanSettings({ unitsAuto: false, units: 'km', curAuto: false, currency: 'GBP' }, 'en-US');
  assert.deepStrictEqual([s.units, s.currency], ['km', 'GBP']);
  const bad = C.cleanSettings({ unitsAuto: false, units: 'parsecs', curAuto: false, currency: 'DOGE' }, 'en-GB');
  assert.deepStrictEqual([bad.units, bad.currency], ['mi', 'GBP']);
  assert.strictEqual(C.spell('Tyre rotation and tyres', 'US'), 'Tire rotation and tires');
  assert.strictEqual(C.spell('Tyre rotation', 'GB'), 'Tyre rotation');
  assert.strictEqual(C.money(2148, 'USD'), '$2,148.00');
  assert.strictEqual(C.money(8000, 'JPY'), '¥8,000');
});

test('dates: calendar months (the 31st clamps), whole days across DST, the phone\'s own today', () => {
  assert.strictEqual(C.addMonths('2026-01-31', 1), '2026-02-28');
  assert.strictEqual(C.addMonths('2028-01-31', 1), '2028-02-29');
  assert.strictEqual(C.addMonths('2026-10-12', 24), '2028-10-12');
  assert.strictEqual(C.addMonths('2026-12-15', -12), '2025-12-15');
  assert.strictEqual(C.daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.strictEqual(C.addDays('2026-11-01', 7), '2026-11-08');
  const ms = Date.parse('2026-10-12T05:30:00Z');
  assert.strictEqual(C.localDate(ms, 'America/Los_Angeles'), '2026-10-11');
  assert.strictEqual(C.localDate(ms, 'Pacific/Auckland'), '2026-10-12');
  assert.strictEqual(C.localDate(ms, 'Not/AZone'), '2026-10-12');
  assert.deepStrictEqual([0, 1, 5, 19, 40, 120, 400, 800].map(C.inWords), ['today', 'tomorrow', 'in 5 days', 'in about 3 weeks', 'in about 6 weeks', 'in about 4 months', 'in about a year', 'in about 2 years']);
  assert.deepStrictEqual([1, 9, 20, 200].map(C.agoWords), ['yesterday', '9 days ago', 'about 3 weeks ago', 'about 7 months ago']);
});

/* ---------------- driving pace ---------------- */

test('pace: from readings over the last year; a single reading or a short span is an assumed typical year', () => {
  const p = C.paceOf(mk({ readings: [[300, 30000], [0, 39000]] }), T);
  assert.strictEqual(p.assumed, false);
  assert.ok(Math.abs(C.fromKm(p.perDay, 'mi') - 30) < 0.01, 'about 30 mi a day');
  assert.strictEqual(C.paceText(p, 'mi'), 'About 900 mi a month');
  const one = C.paceOf(mk({ readings: [[0, 42000]] }), T);
  assert.strictEqual(one.assumed, true);
  assert.ok(Math.abs(one.perDay * 365.25 - C.DEFAULT_KM_PER_YEAR) < 1e-6);
  assert.match(C.paceText(one, 'mi'), /typical guess/);
  const short = C.paceOf(mk({ readings: [[10, 41800], [0, 42000]] }), T);
  assert.strictEqual(short.assumed, true, 'under a fortnight apart is not enough');
  const none = C.paceOf(mk({ readings: [] }), T);
  assert.deepStrictEqual([none.latest, none.est, none.stale], [null, null, true]);
});

test('pace: a lower reading is set aside and counted; a long gap reaches back for the point before the year', () => {
  const lower = C.paceOf(mk({ readings: [[200, 30000], [100, 3500], [0, 36000]] }), T);
  assert.strictEqual(lower.lower, 1, 'one reading went down');
  assert.ok(Math.abs(C.fromKm(lower.perDay, 'mi') - 30) < 0.01, 'and it changes nothing');
  assert.strictEqual(C.fromKm(lower.latest.km, 'mi').toFixed(0), '36000');
  // Readings two years apart and nothing in between: the pace still comes from them.
  const gap = C.paceOf(mk({ readings: [[730, 20000], [0, 34600]] }), T);
  assert.strictEqual(gap.assumed, false);
  assert.ok(Math.abs(C.fromKm(gap.perDay, 'mi') - 20) < 0.01);
  // The latest reading is old: today's odometer is estimated, and it asks.
  const old = C.paceOf(mk({ readings: [[300, 30000], [45, 37650]] }), T);
  assert.strictEqual(old.stale, true);
  assert.ok(Math.abs(C.fromKm(old.est, 'mi') - (37650 + 45 * 30)) < 1);
  assert.strictEqual(C.paceOf(mk({ readings: [[300, 30000], [30, 38100]] }), T).stale, false, '30 days is not yet stale');
  // A service's mileage counts as a reading.
  const svc = C.paceOf(mk({ readings: [[300, 30000]], services: [[0, ['oil'], 39000]] }), T);
  assert.strictEqual(svc.assumed, false);
  // kmAt: between two points it interpolates.
  const car = mk({ readings: [[100, 30000], [0, 33000]] });
  assert.ok(Math.abs(C.fromKm(C.kmAt(car, C.addDays(T, -50), null, T), 'mi') - 31500) < 1);
});

/* ---------------- what's due ---------------- */

test('due: miles or months, whichever comes first - and bands Overdue / Due soon / Coming up / All good', () => {
  // 30 mi a day. Oil every 12,000 km (~7,456 mi) or 12 months.
  const R = [[400, 30000], [0, 42000]];
  // Distance first: done 200 days ago = 6,000 mi ago -> ~1,456 mi left, ~49 days; months would be ~165 days.
  let s = st(mk({ readings: R, services: [[200, ['oil'], 36000]] }), 'oil');
  assert.deepStrictEqual([s.by, s.band], ['km', 'coming']);
  assert.ok(Math.abs(s.days - 1456.3 / 30) < 0.5, String(s.days));
  assert.match(C.dueText(s, 'mi', T), /^Due in about 7 weeks \(≈ 1,500 mi\)$/);
  // Months first: a car barely driven - 10 months ago, 500 miles since.
  const slow = mk({ readings: [[400, 41000], [0, 41600]], services: [[300, ['oil'], 41100]] });
  s = st(slow, 'oil');
  assert.deepStrictEqual([s.by, s.band, s.due], ['time', 'coming', C.addMonths(C.addDays(T, -300), 12)]);
  assert.match(C.dueText(s, 'mi', T), /^Due in about 2 months · by /);
  // Due soon by distance (within ~10% of the interval) even when the date is far.
  s = st(mk({ readings: R, services: [[230, ['oil'], 35200]] }), 'oil');
  assert.strictEqual(s.band, 'soon');
  // Overdue by distance.
  s = st(mk({ readings: R, services: [[300, ['oil'], 33000]] }), 'oil');
  assert.deepStrictEqual([s.band, s.by], ['overdue', 'km']);
  assert.match(C.dueText(s, 'mi', T), /^Overdue by about 1,500 mi$/);
  // Overdue by time (the car hardly moved).
  s = st(mk({ readings: [[500, 41000], [0, 41500]], services: [[400, ['oil'], 41100]] }), 'oil');
  assert.deepStrictEqual([s.band, s.by], ['overdue', 'time']);
  assert.match(C.dueText(s, 'mi', T), /^Overdue since .* \(about \d+ weeks? ago\)|^Overdue since .* \(about \d+ months ago\)/);
  // All good.
  s = st(mk({ readings: R, services: [[10, ['oil'], 41700]] }), 'oil');
  assert.strictEqual(s.band, 'good');
  // A time-only item (brake fluid, 24 months) never comes due by distance.
  s = st(mk({ readings: R, services: [[650, ['brakefluid'], 20000]] }), 'brakefluid');
  assert.deepStrictEqual([s.by, s.dueKm, s.band], ['time', null, 'coming']);
  // A service logged with no mileage: its odometer is worked out from the readings.
  s = st(mk({ readings: [[400, 30000], [0, 42000]], services: [[200, ['oil']]] }), 'oil');
  assert.ok(s.lastKmEstimated && Math.abs(C.fromKm(s.lastKm, 'mi') - 36000) < 1);
});

test('due: a car parked for good comes due by time only; the board sorts most urgent first', () => {
  const parked = mk({ readings: [[300, 41000], [0, 41000]], services: [[100, ['oil'], 41000]] });
  const s = st(parked, 'oil');
  assert.strictEqual(s.by, 'time');
  assert.strictEqual(C.paceText(C.paceOf(parked, T), 'mi'), 'Hardly driven lately');
  const b = C.board(mk({ readings: [[400, 30000], [0, 42000]], services: [[300, ['oil', 'rotate'], 33000], [10, ['brakes'], 41700]] }), T);
  assert.ok(['oil', 'rotate'].every((id) => b.overdue.some((x) => x.item.id === id)));
  assert.ok(!b.overdue.concat(b.soon, b.coming).some((x) => x.item.id === 'brakes'), 'just done');
  for (const k of ['overdue', 'soon', 'coming', 'good']) for (let i = 1; i < b[k].length; i++) assert.ok(b[k][i - 1].days <= b[k][i].days);
});

test('headline: one line, in words', () => {
  const R = [[400, 30000], [0, 42000]];
  assert.strictEqual(C.headline(mk({ readings: R, services: [[230, ['oil'], 35100], [5, ['rotate', 'brakes', 'cabin', 'battery', 'wipers', 'airfilter'], 41850]], base: { how: 'new', d: C.addDays(T, -400), km: mi(30000) } }), T, 'mi', 'US'),
    'Oil & filter change due in about 3 weeks (≈ 600 miles).');
  assert.strictEqual(C.headline(mk({ readings: R, services: [[300, ['oil'], 33000], [395, ['wipers'], 30100]], base: { how: 'new', d: C.addDays(T, -20), km: mi(41400) } }), T, 'mi', 'US'),
    'Oil & filter change is overdue - by about 1,500 miles. 1 more thing overdue too.');
  assert.match(C.headline(mk({ readings: R, base: { how: 'new', d: C.addDays(T, -2), km: mi(41950) } }), T, 'km', 'GB'), /^All good\. Next up: /);
});

test('fuel rules: an EV has no oil, plugs, air or fuel filter or timing belt; diesel has a fuel filter, not plugs; a belt only when it has one', () => {
  const ids = (car) => C.itemsFor(car).map((i) => i.id);
  const ev = mk({ fuel: 'ev', belt: 'belt' });
  assert.strictEqual(ev.belt, 'chain', 'an EV never has a timing belt');
  for (const x of ['oil', 'plugs', 'airfilter', 'fuelfilter', 'timing']) assert.ok(!ids(ev).includes(x), `EV: ${x}`);
  for (const x of ['rotate', 'tyres', 'brakes', 'brakefluid', 'coolant', 'cabin', 'battery', 'wipers', 'inspection']) assert.ok(ids(ev).includes(x), `EV keeps ${x}`);
  const diesel = mk({ fuel: 'diesel', belt: 'belt' });
  assert.ok(ids(diesel).includes('fuelfilter') && !ids(diesel).includes('plugs') && ids(diesel).includes('timing'));
  assert.ok(!ids(mk({ belt: 'chain' })).includes('timing') && !ids(mk({ belt: 'unsure' })).includes('timing'));
  assert.strictEqual(C.intervalOf(diesel, C.item('oil')).km, 15000);
  assert.strictEqual(C.intervalOf(mk(), C.item('oil')).km, 12000);
  assert.strictEqual(C.intervalOf(ev, C.item('tyres')).km, 45000, 'heavier EVs wear tyres faster');
  // Every item has a reason, an emoji and a way to come due.
  for (const it of C.ITEMS) {
    assert.ok(it.name && it.short && it.emoji && it.why.length > 30, it.id);
    assert.ok(it.months || it.km, it.id);
    assert.ok(it.fuels.length, it.id);
  }
});

test('where history starts: "last service" covers the routine jobs; a new car starts everything; otherwise "No record"', () => {
  const base = { how: 'known', d: C.addDays(T, -100), km: mi(39000) };
  const car = mk({ base });
  assert.strictEqual(st(car, 'oil').last.from, 'base');
  assert.strictEqual(st(car, 'oil').unknown, false);
  assert.strictEqual(st(car, 'tyres').unknown, true, 'new tyres are not part of a routine service');
  assert.strictEqual(st(car, 'tyres').last.d, car.added);
  const fresh = mk({ base: { how: 'new', d: C.addDays(T, -5), km: mi(10) } });
  assert.ok(C.itemsFor(fresh).every((it) => it.kind === 'date' || !st(fresh, it.id).unknown));
  const none = mk({});
  assert.ok(C.itemsFor(none).filter((it) => it.kind !== 'date').every((it) => st(none, it.id).unknown));
  // The add form.
  const nc = C.newCar({ make: 'Toyota', model: 'Corolla', year: 2016, fuel: 'petrol', belt: 'chain', km: mi(61400), last: 'known', lastD: '2026-05-02', lastKm: mi(57900), dates: { inspection: '2027-03-01', bogus: 'x' } }, X);
  assert.deepStrictEqual([nc.base.how, nc.readings.length, Object.keys(nc.dates)], ['known', 2, ['inspection']]);
  assert.strictEqual(C.paceOf(nc, T).assumed, false, 'the last service\'s mileage gives a pace straight away');
});

test('renewals: the date you give, else a year on from the last one logged; logging one moves it on', () => {
  let car = mk({ dates: { insurance: C.addDays(T, 20) } });
  assert.deepStrictEqual([st(car, 'insurance').band, st(car, 'inspection').band], ['soon', 'none']);
  assert.match(C.dueText(st(car, 'insurance'), 'mi', T), /^Due in about 3 weeks · /);
  car = mk({ services: [[200, ['inspection']]] });
  assert.strictEqual(st(car, 'inspection').due, C.addMonths(C.addDays(T, -200), 12));
  const r = C.act(mk({ dates: { registration: C.addDays(T, 5) } }), 'service', X, { d: T, items: ['registration'], cost: 90 });
  assert.strictEqual(r.car.dates.registration, C.addMonths(T, 12));
  assert.strictEqual(st(r.car, 'registration').band, 'good');
  assert.strictEqual(st(mk({ dates: { insurance: C.addDays(T, -1) } }), 'insurance').band, 'overdue');
});

/* ---------------- actions and undo ---------------- */

test('actions: log a service resets the item; undo puts the car back exactly; an old undo is refused', () => {
  const car = mk({ readings: [[400, 30000], [0, 42000]], services: [[300, ['oil'], 33000]] });
  const frozen = JSON.stringify(car);
  assert.strictEqual(st(car, 'oil').band, 'overdue');
  const r = C.act(car, 'service', X, { d: T, km: mi(42000), items: ['oil', 'cabin', 'nonsense'], cost: 89.5, shop: '<b>Quick</b>Lube', note: 'Synthetic' });
  assert.strictEqual(JSON.stringify(car), frozen, 'the argument is never changed');
  assert.strictEqual(st(r.car, 'oil').band, 'good');
  const s = r.car.services[r.car.services.length - 1];
  assert.deepStrictEqual([s.items, s.cost, s.shop, s.cur], [['oil', 'cabin'], 89.5, 'Quick Lube', 'USD']);
  assert.match(r.msg, /^Logged oil change and cabin filter\. Next oil change: due in about 8 months \(≈ 7,500 mi\)\.$/);
  const back = C.undo(r.car, r.token);
  assert.strictEqual(JSON.stringify(back), frozen, 'undo is exact');
  // A second change since: the first one's undo can no longer apply.
  const r2 = C.act(r.car, 'reading', X, { km: mi(42010) });
  assert.throws(() => C.undo(r2.car, r.token), (e) => e.status === 409);
  assert.strictEqual(JSON.stringify(C.undo(r2.car, r2.token)), JSON.stringify(r.car));
  // Bad entries are refused with a sentence.
  assert.throws(() => C.act(car, 'service', X, { d: C.addDays(T, 1), items: ['oil'] }), /future/);
  assert.throws(() => C.act(car, 'service', X, { d: T, items: [] }), /Pick what was done/);
  assert.throws(() => C.act(car, 'nope', X, {}), /Unknown/);
  // "Other work" alone is fine.
  assert.strictEqual(C.act(car, 'service', X, { d: T, items: [], other: 'New headlight bulb' }).car.services.length, 2);
});

test('readings: a lower reading or an impossible jump asks first; a same-day reading replaces; deleting an entry undoes', () => {
  const car = mk({ readings: [[30, 41000], [0, 42000]] });
  assert.throws(() => C.act(car, 'reading', X, { km: mi(4200) }), (e) => e.status === 409 && e.code === 'lower' && /lower than your reading of 42,000 mi/.test(e.message));
  assert.strictEqual(C.act(car, 'reading', X, { km: mi(4200), force: true }).car.readings.length, 2, 'forced: replaces today\'s');
  assert.throws(() => C.act(car, 'reading', X, { km: mi(142000) }), (e) => e.code === 'jump');
  assert.throws(() => C.act(car, 'reading', X, { km: mi(43000), d: C.addDays(T, 2) }), /future/);
  assert.throws(() => C.act(car, 'reading', X, { km: 'lots' }), /odometer/);
  const r = C.act(car, 'reading', X, { km: mi(41500), d: C.addDays(T, -10) });
  assert.strictEqual(r.car.readings.length, 3, 'an earlier date between two readings is fine');
  assert.throws(() => C.act(car, 'reading', X, { km: mi(42100), d: C.addDays(T, -10) }), (e) => e.code === 'lower' && /higher than your later reading/.test(e.message));
  const svc = C.act(car, 'service', X, { d: T, items: ['wipers'] });
  const del = C.act(svc.car, 'delsvc', X, { sid: svc.car.lastSvc });
  assert.strictEqual(del.car.services.length, 0);
  assert.strictEqual(C.undo(del.car, del.token).services.length, 1);
  assert.throws(() => C.act(car, 'delsvc', X, { sid: 'sdoesnotexist' }), (e) => e.status === 404);
});

test('the plan: every interval editable, "stop tracking", back to generic; bounds held', () => {
  const car = mk();
  let r = C.act(car, 'plan', X, { id: 'oil', km: mi(5000), months: 6 });
  assert.deepStrictEqual([C.intervalOf(r.car, C.item('oil')).km, C.intervalOf(r.car, C.item('oil')).months, C.intervalOf(r.car, C.item('oil')).custom], [8047, 6, true]);
  assert.match(r.msg, /every 5,000 mi or 6 months/);
  r = C.act(r.car, 'plan', X, { id: 'oil', reset: true });
  assert.strictEqual(C.intervalOf(r.car, C.item('oil')).km, 12000);
  r = C.act(r.car, 'plan', X, { id: 'wipers', off: true });
  assert.ok(!C.board(r.car, T).good.concat(C.board(r.car, T).coming).some((x) => x.item.id === 'wipers'));
  assert.strictEqual(C.board(r.car, T).off.length, 1);
  assert.throws(() => C.act(car, 'plan', X, { id: 'oil', km: 3, months: 999 }), /distance/);
  const cleaned = C.cleanCar({ make: 'X', plan: { oil: { km: 10, months: -1 }, __proto__: { km: 1 }, rotate: { km: 8000 }, inspection: { km: 5000, months: 24 } } }, X);
  assert.deepStrictEqual(cleaned.plan, { rotate: { km: 8000 }, inspection: { months: 24 } });
});

/* ---------------- costs ---------------- */

test('costs: this year, all time, per mile over the distance logged; other currencies counted, not added', () => {
  const car = mk({ readings: [[400, 30000], [0, 42000]] });
  let c = C.act(car, 'service', X, { d: C.addDays(T, -380), km: mi(30600), items: ['oil'], cost: 100 }).car;
  c = C.act(c, 'service', X, { d: '2026-02-01', items: ['wipers'], cost: 40 }).car;
  c = C.act(c, 'service', X, { d: '2026-06-01', items: ['rotate'], cost: 60.5 }).car;
  c = C.act(c, 'service', X, { d: '2026-06-02', items: ['cabin'], cost: 20, cur: 'EUR' }).car;
  c = C.act(c, 'service', X, { d: '2026-06-03', items: ['brakes'] }).car;
  const k = C.costs(c, T, 'USD');
  assert.deepStrictEqual([k.year, k.all, k.count, k.other], [100.5, 200.5, 3, 1]);
  const perMile = k.perKm * C.KM_PER_MI;
  assert.ok(Math.abs(perMile - 200.5 / (42000 - 30600)) < 1e-6, String(perMile));
  assert.strictEqual(C.costs(mk({ readings: [[0, 42000]] }), T, 'USD').perKm, null, 'no distance, no per mile');
});

/* ---------------- the example garage ---------------- */

test('the example garage: the SUV has one thing overdue and one due soon, the hatchback is sparse - on every day of a year', () => {
  for (let i = 0; i < 366; i++) {
    const t = C.addDays('2026-10-12', i);
    const g = D.build(t, 'USD');
    assert.strictEqual(g.cars.length, 2);
    const [suv, hatch] = g.cars;
    const b = C.board(suv, t);
    const ids = (k) => b[k].map((x) => x.item.id).join(',');
    assert.strictEqual(ids('overdue'), 'rotate', `${t} overdue`);
    assert.strictEqual(ids('soon'), 'oil', `${t} soon`);
    assert.strictEqual(ids('coming'), 'brakefluid,wipers,registration', `${t} coming`);
    assert.strictEqual(b.none.length, 0);
    assert.strictEqual(C.headline(suv, t, 'mi', 'US'), 'Tire rotation is overdue - by about 1,400 miles.');
    assert.strictEqual(C.dueText(b.soon[0], 'mi', t), 'Due in about 3 weeks (≈ 600 mi)');
    assert.strictEqual(b.pace.stale, false);
    assert.strictEqual(C.paceText(b.pace, 'mi'), 'About 1,000 mi a month');
    const h = C.board(hatch, t);
    assert.strictEqual(h.overdue.length + h.soon.length, 0, `${t} hatch`);
    assert.strictEqual(h.coming.map((x) => x.item.id).join(','), 'insurance,rotate');
    assert.ok(h.pace.stale, 'the hatchback asks for a reading');
    assert.strictEqual(hatch.belt, 'unsure');
    assert.ok(h.good.some((x) => x.unknown), 'sparse: "No record" items');
    assert.deepStrictEqual(h.none.map((x) => x.item.id), ['inspection', 'registration']);
  }
  const g = D.build(T, 'USD');
  assert.strictEqual(g.cars[0].services.length, D.SUV_LOG.length);
  assert.ok(C.costs(g.cars[0], T, 'USD').perKm > 0);
  assert.strictEqual(D.build(T, 'JPY').cars[0].services[1].cost, 94 * 150, 'scaled for yen');
  assert.ok(!/fetch\(|localStorage|indexedDB/.test(read('public/demo.js')));
});

/* ---------------- the one door ---------------- */

test('cleanCar: hostile and broken cars come out safe, bounded and dated sanely', () => {
  const raw = {
    id: '../../etc', nick: '<img src=x onerror=alert(1)>Bert‮', make: 'A'.repeat(500), model: '\u0000', year: 3000, fuel: 'jet', belt: 'rope', added: '2999-01-01', rev: -4,
    readings: [{ d: '2026-02-30', km: 5 }, { d: '2026-01-01', km: -9 }, { d: '2026-01-02', km: 1e12 }, { d: '2026-01-03', km: 1000 }, { d: '2099-01-01', km: 2000 }, null, 'x'],
    services: [{ d: '2026-01-04', items: ['oil', 'oil', '__proto__', 'constructor'], cost: -1, cur: 'DOGE', shop: '<script>x</script>', note: 'n'.repeat(900) }, { d: '2026-01-05', items: [] }, { d: 'yesterday', items: ['oil'] }],
    plan: 'nope', dates: { insurance: '2026-13-01', registration: '2027-01-01' }, base: { how: 'known', d: '2099-01-01' },
  };
  const c = C.cleanCar(raw, X);
  assert.ok(C.isCarId(c.id) && c.id !== raw.id);
  assert.ok(!/[<>\u202e]/.test(JSON.stringify(c)), 'no markup or bidi');
  assert.deepStrictEqual([c.nick, c.make.length, c.model, c.year, c.fuel, c.belt, c.added, c.rev], ['Bert', 30, '', null, 'petrol', 'unsure', T, 0]);
  assert.deepStrictEqual(c.readings, [{ d: '2026-01-03', km: 1000 }]);
  assert.strictEqual(c.services.length, 1);
  assert.deepStrictEqual([c.services[0].items, c.services[0].cost, c.services[0].cur, c.services[0].note.length], [['oil'], null, 'USD', 280]);
  assert.deepStrictEqual(c.dates, { registration: '2027-01-01' });
  assert.strictEqual(c.base.how, 'assumed');
  assert.strictEqual(C.cleanCar({ nick: '   ' }, X), null, 'nothing to call it');
  assert.strictEqual(C.cleanCar([1, 2], X), null);
  const many = { make: 'X', services: [], readings: [] };
  for (let i = 0; i < 900; i++) { many.services.push({ d: C.addDays(T, -i), items: ['wipers'] }); many.readings.push({ d: C.addDays(T, -i), km: 90000 - i * 10 }); }
  const big = C.cleanCar(many, X);
  assert.deepStrictEqual([big.services.length, big.readings.length], [C.LIMITS.services, C.LIMITS.readings]);
  assert.strictEqual(big.services[big.services.length - 1].d, T, 'the newest are the ones kept');
});

/* ---------------- the warning-light catalogue ---------------- */

test('the light catalogue: ~40 symbols, every one complete; ids unique; three colour groups', () => {
  assert.ok(L.LIGHTS.length >= 40, String(L.LIGHTS.length));
  assert.strictEqual(new Set(L.LIGHTS.map((l) => l.id)).size, L.LIGHTS.length);
  for (const l of L.LIGHTS) {
    assert.ok(/^[a-z0-9-]+$/.test(l.id), l.id);
    assert.ok(['red', 'amber', 'green', 'blue'].includes(l.colour), l.id);
    assert.strictEqual(l.group, L.COLOURS[l.colour].group);
    assert.ok(typeof l.svg === 'string' && l.svg.length > 20, `${l.id} icon`);
    assert.ok(!/<script|on[a-z]+=|href|xlink|javascript:/i.test(l.svg), `${l.id} icon is plain shapes`);
    assert.ok(/^(<(path|circle|rect|text)\b[^<>]*(\/>|>[A-Z!]{1,5}<\/text>))+$/.test(l.svg), `${l.id} icon markup`);
    assert.ok(l.name && l.aka && l.means.length > 20 && l.urgency && l.cause, `${l.id} text`);
    assert.ok(Array.isArray(l.now) && l.now.length >= 1 && l.now.every((x) => x.length > 10), `${l.id} what to do`);
    assert.ok(Array.isArray(l.dont) && l.dont.length >= 1 && l.dont.every((x) => /^(Don’t|Never|If)/.test(x)), `${l.id} what not to do`);
  }
  const g = (id) => L.inGroup(id).length;
  assert.ok(g('red') >= 10 && g('amber') >= 15 && g('info') >= 8, `${g('red')}/${g('amber')}/${g('info')}`);
  for (const must of ['oil-pressure', 'coolant-temp', 'battery', 'brake', 'abs', 'airbag', 'tpms', 'traction', 'power-steering', 'low-fuel', 'door-open', 'seat-belt', 'glow-plug', 'dpf', 'adblue', 'washer-fluid', 'high-beam', 'front-fog', 'rear-fog', 'lane-assist', 'service-due', 'transmission', 'check-engine']) assert.ok(L.light(must), must);
  assert.strictEqual(L.light('__proto__'), null);
  assert.strictEqual(L.light('constructor'), null);
  assert.deepStrictEqual(L.find('oil').slice(0, 2).map((l) => l.id).sort(), ['oil-level', 'oil-pressure']);
  assert.strictEqual(L.find('horseshoe')[0].id, 'tpms');
  assert.deepStrictEqual(L.find('<script>'), []);
});

test('the light catalogue is safe: every red says stop safely; nothing is ever "safe to ignore"; pull over and engine off for oil and heat', () => {
  for (const l of L.inGroup('red')) {
    assert.match(l.urgency, /stop/i, `${l.id} urgency`);
    assert.match(l.now[0], /\bstop\b/i, `${l.id}: the first thing to do is stop safely`);
    assert.match(l.now[0], /safe/i, `${l.id}: safely`);
  }
  for (const id of ['oil-pressure', 'coolant-temp']) assert.match(L.light(id).now[0], /safe place and stop .* turn the engine off/i);
  const all = JSON.stringify(L.LIGHTS.map((l) => [l.means, l.urgency, l.now, l.dont, l.cause, l.flashing || '']));
  assert.ok(!/safe to (ignore|drive|keep)|can (be )?(safely )?ignored?|fine to (ignore|drive)|ok(ay)? to ignore|nothing to worry|keep driving normally/i.test(all), 'never says a warning can be ignored');
  assert.ok(!/\b(unscrew|remove the|disconnect|jack|bleed|drain)\b/i.test(all), 'no repair instructions beyond basic checks');
  assert.match(L.light('check-engine').flashing, /stop safely/);
  const page = read('public/app.js');
  assert.match(page, /Guidance, not a diagnosis/);
  assert.match(page, /owner’s manual/);
  for (const g of L.GROUPS) assert.ok(g.label && g.means && g.line, g.id);
  assert.match(L.GROUPS[0].line, /stop/i);
});

/* ---------------- the history link ---------------- */

const svcCar = () => D.build(T, 'USD').cars[0];
test('the history report: packed newest first, receipts never in it, costs and notes only when ticked', () => {
  const car = svcCar();
  car.services[3].photo = true;
  const p = C.packReport(car, { today: T, units: 'mi' });
  assert.strictEqual(p.s.length, car.services.length);
  assert.ok(p.s[0][0] > p.s[1][0], 'newest first');
  assert.ok(p.s.every((r) => r[5] === '' && r[6] === -1 && r[7] === ''), 'no notes or costs by default');
  assert.ok(!JSON.stringify(p).includes('photo') && !JSON.stringify(p).includes(car.id), 'no receipt flags, no ids');
  assert.ok(!JSON.stringify(p).includes('The family SUV'), 'the nickname stays home');
  const withAll = C.packReport(car, { today: T, units: 'mi', costs: true, notes: true });
  assert.ok(withAll.s.some((r) => r[6] > 0) && withAll.s.some((r) => r[5]));
  const rep = C.cleanReport(JSON.parse(JSON.stringify(withAll)));
  assert.deepStrictEqual([rep.year, rep.make, rep.model, rep.units, rep.services.length], [2018, 'Honda', 'CR-V', 'mi', car.services.length]);
  const html = C.reportHtml(rep, { units: 'mi', region: 'US' });
  assert.match(html, /2018 Honda CR-V/);
  assert.match(html, /Oil change <span class="muted">×4<\/span>/);
  assert.match(html, /not checked by a garage/);
  assert.match(C.reportHtml(rep, { units: 'km' }), / km</);
});

test('the history link: into the fragment, compressed or plain, and back exactly', async () => {
  const p = C.packReport(svcCar(), { today: T, units: 'mi', costs: true });
  const z = await C.encodeReport(p);
  assert.match(z.frag, /^v1\.z\.[A-Za-z0-9_-]+$/);
  const plain = await C.encodeReport(p, { plain: true });
  assert.match(plain.frag, /^v1\.p\.[A-Za-z0-9_-]+$/);
  assert.ok(z.frag.length < plain.frag.length, 'compression helps');
  const a = await C.decodeReport('#' + z.frag);
  const b = await C.decodeReport(plain.frag);
  assert.deepStrictEqual(a, C.cleanReport(JSON.parse(JSON.stringify(p))));
  assert.deepStrictEqual(a, b);
  // The biggest log there can be: 300 long entries. The link stays under the
  // cap by leaving the oldest off, and says how many.
  const huge = { make: 'Volkswagen', model: 'Golf', year: 2015, services: [], readings: [] };
  const noise = (n, len) => { let s = ''; let h = n; while (s.length < len) { h = C.hash32(String(h)); s += h.toString(36); } return s.slice(0, len); };
  for (let i = 0; i < 300; i++) huge.services.push({ d: C.addDays(T, -i * 3), km: 200000 - i * 300, items: ['oil', 'cabin', 'rotate', 'brakes'], other: 'x' + noise(i, 70), shop: 'S' + noise(i + 1e4, 55), note: 'N' + noise(i + 2e4, 270), cost: 1234.56, cur: 'EUR' });
  const hp = C.packReport(C.cleanCar(huge, X), { today: T, units: 'km', costs: true, notes: true });
  for (const plainMode of [false, true]) {
    const r = await C.encodeReport(hp, { plain: plainMode });
    assert.ok(r.frag.length <= C.LIMITS.fragment, String(r.frag.length));
    assert.ok(r.dropped > 0 && r.kept + r.dropped === hp.s.length);
    const back = await C.decodeReport(r.frag);
    assert.strictEqual(back.services.length, r.kept);
    assert.strictEqual(back.services[0].d, T, 'the newest are kept');
  }
});

test('the history link: hostile or garbled fragments are refused safely - never thrown, never markup', async () => {
  const enc = async (obj, plain) => (await C.encodeReport(Object.assign({ s: [] }, obj), { plain })) || { frag: '' };
  const good = C.packReport(svcCar(), { today: T, units: 'mi' });
  const z = (await C.encodeReport(good)).frag;
  const bad = ['', '#', 'v2.z.abc', 'v1.q.abc', 'v1.z.', 'v1.z.!!!!', 'v1.p.' + 'A'.repeat(20000), z.slice(0, z.length - 30), z.replace('v1.z.', 'v1.p.'),
    'v1.p.' + C.b64url(new TextEncoder().encode('{"v":1')), 'v1.p.' + C.b64url(new Uint8Array([0xff, 0xfe, 0x00])), 'v1.p.' + C.b64url(new TextEncoder().encode('[1,2,3]')), null, 42, { toString: () => 'x' }];
  for (const f of bad) assert.strictEqual(await C.decodeReport(f), null, String(f).slice(0, 40));
  // A deflate bomb: a few KB that inflate past the cap.
  const bomb = await new Response(new Blob([new Uint8Array(4 * 1024 * 1024)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
  assert.strictEqual(await C.decodeReport('v1.z.' + C.b64url(new Uint8Array(bomb))), null);
  // Well-formed but hostile: markup, bidi, fake items, absurd numbers.
  const evil = { v: 1, t: [99999, '<img src=x onerror=alert(1)>Honda', '<script>alert(1)</script>‮Civic', 'rocket'], o: [-5, 'never'], u: 'leagues', g: T,
    s: [[T, 1e15, ['oil', 'flux', '__proto__'], '<b>bold</b>', '<a href="javascript:alert(1)">Shop</a>', 'note', -50, 'DOGE'], ['2026-02-31', 1, ['oil']], [T, 5, [], ''], 'junk'] };
  const out = await C.decodeReport((await enc(evil, true)).frag);
  assert.ok(out, 'cleaned, not refused');
  assert.deepStrictEqual([out.year, out.fuel, out.odo, out.units, out.services.length], [null, null, null, 'mi', 1]);
  assert.deepStrictEqual([out.services[0].items, out.services[0].km, out.services[0].cost, out.services[0].cur], [['oil'], null, null, null]);
  const html = C.reportHtml(out);
  assert.ok(!/<(img|script|a)\b/i.test(html) && !/<b>bold|onerror=|javascript:|\u202e/.test(html), 'nothing executable or reversed');
  // Raw strings that still need escaping when drawn are escaped.
  const q = C.cleanReport({ v: 1, t: [2020, 'Tom & "Jerry\'s"', 'Car', 'ev'], o: [1, T], u: 'km', g: T, s: [[T, 1, ['tyres'], '', 'A & B', '', -1, '']] });
  assert.match(C.reportHtml(q), /Tom &amp; &quot;Jerry&#39;s&quot;/);
  assert.strictEqual(C.cleanReport({ v: 1, t: [2020, 'A', 'B', 'ev'], g: T, s: [] }), null, 'no entries, no report');
  assert.strictEqual(C.cleanReport({ v: 1, t: [2020, '', '', 'ev'], g: T, s: [[T, 1, ['oil']]] }), null, 'no name');
});

/* ---------------- the calendar ---------------- */

test('.ics: valid iCalendar - CRLF, folded at 75 octets on whole characters, escaped, one all-day event per item due within a year', () => {
  const g = D.build(T, 'USD');
  const r = C.icsFor(g.cars, { today: T, units: 'mi', region: 'US', now: Date.parse('2026-10-12T08:00:00Z') });
  const text = r.text;
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n') && text.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(text), 'CRLF only');
  for (const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `too long: ${line}`);
  const unfolded = text.replace(/\r\n /g, '');
  const events = unfolded.split('BEGIN:VEVENT').length - 1;
  assert.strictEqual(events, r.events);
  assert.ok(events >= 10);
  assert.strictEqual((unfolded.match(/END:VEVENT/g) || []).length, events);
  assert.match(unfolded, /SUMMARY:🔧 Tire rotation - The family SUV/);
  assert.match(unfolded, new RegExp('DTSTART;VALUE=DATE:' + T.replace(/-/g, '') + '\\r\\nDTEND;VALUE=DATE:' + C.addDays(T, 1).replace(/-/g, '')), 'overdue is today');
  assert.match(unfolded, /projected from your driving/);
  assert.match(unfolded, /Your owner’s manual wins/);
  assert.ok(/DESCRIPTION:[^\r]*\\n/.test(unfolded) && /\\,/.test(unfolded), 'newlines and commas escaped');
  assert.strictEqual(new Set(unfolded.match(/UID:[^\r]+/g)).size, events, 'unique UIDs');
  assert.ok(!/DTSTART;VALUE=DATE:(\d{8})/.exec(unfolded) || [...unfolded.matchAll(/DTSTART;VALUE=DATE:(\d{8})/g)].every((m) => m[1] >= T.replace(/-/g, '') && m[1] <= C.addDays(T, 364).replace(/-/g, '')));
  const evil = C.cleanCar({ nick: 'Semi;colon, comma\\back', make: 'X', readings: [{ d: T, km: 1 }], dates: { insurance: C.addDays(T, 3) } }, X);
  const e = C.icsFor([evil], { today: T }).text.replace(/\r\n /g, '');
  assert.match(e, /Semi\\;colon\\, comma\\\\back/);
});

/* ---------------- export / import ---------------- */

test('export and import: a round trip keeps every car; a hostile file is cleaned or refused', () => {
  const g = D.build(T, 'USD');
  const settings = C.cleanSettings({ unitsAuto: false, units: 'km' }, 'en-US');
  const text = C.exportGarage({ settings, cars: g.cars }, Date.parse('2026-10-12T00:00:00Z'));
  const back = C.importGarage(text, { today: T, locale: 'en-US' });
  assert.deepStrictEqual(back.cars, g.cars);
  assert.strictEqual(back.settings.units, 'km');
  for (const bad of ['not json', '{}', '{"app":"sprout","v":1,"cars":[]}', '{"app":"glovebox","v":2,"cars":[]}', '{"app":"glovebox","v":1,"cars":{}}', 'x'.repeat(C.LIMITS.importBytes + 1), null]) {
    assert.throws(() => C.importGarage(bad, { today: T }), (e) => e.expose && /Glovebox export|JSON|too big/.test(e.message));
  }
  const hostile = JSON.stringify({ app: 'glovebox', v: 1, settings: { units: '<x>', currency: 'DOGE' }, cars: [g.cars[0], g.cars[0], { nick: '<script>alert(1)</script>' }, { nick: '' }, 'x', ...Array(30).fill({ make: 'Spam' })] });
  const h = C.importGarage(hostile, { today: T, locale: 'en-GB' });
  assert.strictEqual(h.cars.length, C.LIMITS.cars);
  assert.notStrictEqual(h.cars[0].id, h.cars[1].id, 'duplicate ids made unique');
  assert.ok(!JSON.stringify(h).includes('<'));
  assert.deepStrictEqual([h.settings.units, h.settings.currency], ['mi', 'GBP']);
  assert.ok(h.dropped >= 2);
});

/* ---------------- the AI answers ---------------- */

test('cleanDash: catalogue ids only if real; the catalogue\'s advice, never the model\'s urgency; a red light is red whatever the model says', () => {
  const r = C.cleanDash({
    relevant: true,
    lights: [
      { catalogueId: 'oil-pressure', colour: 'red', description: 'Oil can. It is safe to keep driving to your destination.', urgency: 'low' },
      { catalogueId: 'check-engine', colour: 'red', description: 'Engine outline' },
      { catalogueId: 'flux', colour: 'purple', description: '<img src=x onerror=alert(1)>Mystery' },
      { catalogueId: '__proto__', colour: 'amber', description: '' },
      { catalogueId: 'oil-pressure', colour: 'red', description: 'again' },
      { description: 'Squiggle', colour: 'unknown' },
    ],
    odometer: { value: 48212.4, unit: 'mi' }, notes: 'Not serious. Two lights are hard to make out.', urgency: 'none',
  });
  assert.deepStrictEqual(r.lights.map((x) => [x.id, x.group]), [['oil-pressure', 'red'], ['check-engine', 'red'], [null, 'red'], [null, 'red']]);
  assert.strictEqual(r.lights[0].description, 'Oil can.', 'the "safe to keep driving" sentence is gone');
  assert.strictEqual(r.lights[2].description, 'Mystery');
  assert.ok(!('urgency' in r) && r.lights.every((x) => !('urgency' in x)));
  assert.strictEqual(r.notes, 'Two lights are hard to make out.');
  assert.deepStrictEqual(r.odometer, { value: 48212, unit: 'mi' });
  assert.deepStrictEqual(C.cleanDash(JSON.parse(JSON.stringify(r))), r, 'cleaning twice changes nothing (the page cleans the server\'s answer again)');
  assert.strictEqual(C.cleanDash({ lights: [{ catalogueId: 'high-beam', colour: 'blue', description: 'Lamp' }], odometer: { value: -1 } }).odometer, null);
  assert.strictEqual(C.cleanDash({ odometer: { value: 1200, unit: 'leagues' } }).odometer.unit, null);
  assert.strictEqual(C.cleanDash({ relevant: false }).relevant, false);
  const many = C.cleanDash({ lights: Array.from({ length: 60 }, (_, i) => ({ description: 'L' + i, colour: 'amber' })) });
  assert.strictEqual(many.lights.length, 12);
});

test('cleanReceipt: a date not in the future, items matched only if real, costs bounded, a known currency', () => {
  const r = C.cleanReceipt({ relevant: true, date: '2026-10-02', mileage: 48160, mileageUnit: 'mi', shop: 'Quick<b>Lube</b>', currency: 'usd', total: 112.5,
    items: [{ catalogueItem: 'oil', description: 'LOF', cost: 74.99 }, { catalogueItem: 'flux', description: 'Flux service', cost: -1 }, { catalogueItem: '__proto__', description: '' }, { description: '', cost: 3 }] }, { today: T });
  assert.deepStrictEqual([r.date, r.mileage, r.shop, r.currency, r.total], ['2026-10-02', { value: 48160, unit: 'mi' }, 'Quick Lube', 'USD', 112.5]);
  assert.deepStrictEqual(r.items, [{ item: 'oil', description: 'LOF', cost: 74.99 }, { item: null, description: 'Flux service', cost: null }]);
  assert.deepStrictEqual(C.cleanReceipt(JSON.parse(JSON.stringify(r)), { today: T }), r, 'idempotent');
  const f = C.cleanReceipt({ date: '2026-10-13', mileage: 1e9, total: 1e12, currency: 'DOGE' }, { today: T });
  assert.deepStrictEqual([f.date, f.mileage, f.total, f.currency], [null, null, null, null]);
});

/* ---------------- the page ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
test('every text colour holds 4.5:1 on its surface in both themes; band bars and lit icons 3:1; colour is never alone', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['bg', 'card', 'card2', 'bar-bg']) for (const fg of ['text', 'muted', 'link', 'err', 'good', 'bad']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    const pairs = [['text', 'accent-soft'], ['link', 'accent-soft'], ['muted', 'accent-soft'], ['accent-ink', 'accent'], ['good', 'good-bg'], ['bad', 'bad-bg'], ['warn', 'warn-bg'], ['strip-ink', 'strip'], ['strip-btn-ink', 'strip-btn'],
      ['red-ink', 'red-bg'], ['amber-ink', 'amber-bg'], ['info-ink', 'info-bg'], ['dash-ink', 'dash'], ['card', 'overdue'], ['good-ink', 'good-tint'], ['text', 'card2']];
    for (const b of ['overdue', 'soon', 'coming']) pairs.push([b, `${b}-bg`], [b, 'card']);
    pairs.push(['good-ink', 'card']);
    for (const [fg, bg] of pairs) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const b of ['overdue', 'soon', 'coming', 'good']) assert.ok(ratio(t[`${b}-bar`], t.card) >= 3, `${name} ${b} bar`);
    for (const lit of ['lit-red', 'lit-amber', 'lit-green', 'lit-blue']) assert.ok(ratio(t[lit], t.dash) >= 4.5, `${name} ${lit} on the dash`);
    assert.ok(ratio('#c3cad5', t.dash) >= 4.5, 'odometer label');
    assert.ok(ratio(t.accent, t.card) >= 3, `${name} accent mark`);
  }
  assert.ok(/min-height: 44px/.test(css) && /\.pa \{[^}]*min-height: 44px; min-width: 44px/.test(css), '44px tap targets');
  assert.ok(/@media print/.test(css), 'a printable history');
  // Colour never alone: every group chip and band carries its word.
  const js = read('public/app.js');
  assert.match(js, /gchip g-' \+ [^;]*esc\((gi\.means|colourWord)/);
  assert.match(js, /btag"><span aria-hidden="true">' \+ bd\.icon \+ '<\/span>' \+ esc\(bd\.label\)/);
});

test('the pages: relative links, no inline script or handlers, the banner, storage wrapped, only known requests', () => {
  const html = read('public/index.html'), hist = read('public/history.html');
  for (const [n, h] of [['index', html], ['history', hist]]) {
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(h), `${n}: no inline <script>`);
    assert.ok(!/\son[a-z]+\s*=/i.test(h), `${n}: no inline handlers`);
    assert.ok(!/(src|href)="\//.test(h), `${n}: relative asset links only`);
  }
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && html.includes('<body class="dk">'));
  const js = read('public/app.js'), hjs = read('public/history.js'), core = read('public/glovebox-core.js'), lights = read('public/glovebox-lights.js');
  for (const [n, s] of [['app.js', js], ['history.js', hjs]]) {
    assert.ok(!/\son[a-z]+=\\?["']/.test(s), `${n}: no handler written into markup`);
    assert.ok(!/\.on[a-z]+ =/.test(s), `${n}: handlers by addEventListener`);
    assert.ok(!/fetch\(['"]\//.test(s) && !/href="\//.test(s), `${n}: every URL relative to BASE`);
    assert.ok(!/innerHTML = [^;]*\+ (?!esc\(|plural|C\.|'|")[a-z]+\.(nick|note|shop|name|description|other)\b/i.test(s), `${n}: names go through esc()`);
  }
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(/indexedDB\.open[\s\S]{0,900}catch \(e\)/.test(js), 'IndexedDB opened inside try/catch');
  const calls = [...js.matchAll(/api\('(GET|POST)', '([^']+)'/g)].map((m) => m[2]);
  assert.deepStrictEqual([...new Set(calls)].sort(), ['api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/me', 'api/read'], 'the page asks for nothing else - no route takes a car');
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|indexedDB/.test(hjs + core + lights + read('public/demo.js')), 'the buyer\'s page, the rules, the lights and the example make no request and keep nothing');
  assert.ok(js.includes("register('sw.js', { scope: './' })"));
  assert.ok(js.includes("BASE + 'history#' + r.frag"), 'the report goes in the fragment');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js + hjs + core + lights), 'no email address in the pages');
  const server = read('server.js');
  assert.ok(!/setInterval|setTimeout/.test(server), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js', 'lib/photo.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|photo|\.data\b|raw)/.test(read(f)), `${f} logs a body or a photo`);
});

test('the service worker: the app\'s own files under its own scope, never api/, only glovebox-* caches', () => {
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return/.test(sw));
  assert.ok(/url\.origin !== self\.location\.origin\) return/.test(sw));
  assert.ok(/url\.pathname\.indexOf\(scope\) !== 0\) return/.test(sw));
  assert.ok(/k\.indexOf\('glovebox-'\) === 0 && k !== CACHE/.test(sw));
  const shell = JSON.parse(/var SHELL = (\[[^\]]*\])/.exec(sw)[1].replace(/'/g, '"'));
  for (const f of shell.filter((x) => x !== './' && x !== 'history')) assert.ok(fs.existsSync(path.join(ROOT, 'public', f)), `${f} is cached but missing`);
  for (const page of ['public/index.html', 'public/history.html']) for (const [, f] of read(page).matchAll(/(?:src|href)="([^"#:]+)"/g)) if (f !== './') assert.ok(shell.includes(f), `${f} is loaded but not cached for offline`);
});

test('local-only switches throw on Cloud Run', () => {
  for (const [mod, env] of [['./lib/store', { GLOVEBOX_MEMORY: '1' }], ['./lib/fakeai', { GLOVEBOX_FAKE_AI: '1' }], ['./server', { GLOVEBOX_FAKE_AI: '1', GLOVEBOX_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, GLOVEBOX_MEMORY: '', GLOVEBOX_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  assert.ok(/GLOVEBOX_COLLECTION_PREFIX/.test(read('lib/store.js')), 'the prefix is read, ready for anything ever stored');
});

/* ---------------- over HTTP ---------------- */

let base;
const seen = [];
let ip6 = 1;
function client() {
  const cookies = {};
  const addr = `2001:db8:${(ip6++).toString(16)}::1`;
  return async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) { data = { text }; }
    return { status: res.status, data, text, headers: res.headers };
  };
}
async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const jpeg = (marker) => ({ type: 'image/jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from(`JFIF PHOTO_MARKER_BYTES ${marker || ''}`)]).toString('base64') });
const BIG = { kind: 'dash', photo: { type: 'image/jpeg', data: 'A'.repeat(7 * 1024 * 1024) } };

test('signed out: every page loads, zero model calls; the AI route answers 401 before reading any body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.stores, 'nothing');
  assert.strictEqual((await anon('GET', '/api/meta')).data.lights, L.LIGHTS.length);
  for (const f of ['', 'history', 'glovebox-core.js', 'glovebox-lights.js', 'demo.js', 'app.js', 'history.js', 'app.css', 'sw.js', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  const hist = await fetch(`${base}/history`);
  assert.strictEqual(hist.headers.get('referrer-policy'), 'no-referrer');
  assert.match(hist.headers.get('x-robots-tag'), /noindex/);
  assert.match(await hist.text(), /<script src="history\.js"><\/script>/);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const kind of ['dash', 'receipt']) assert.strictEqual((await anon('POST', '/api/read', { kind, photo: jpeg() })).status, 401);
  assert.strictEqual((await anon('POST', '/api/read', BIG)).status, 401, 'the gate answers before the parser, so not 413');
  for (const p of ['/api/cars', '/api/garage', '/api/history', '/api/report', '/api/sync', '/api/receipts']) assert.strictEqual((await anon('POST', p, { cars: [] })).status, 404, `${p}: there is no route for cars`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the history link\'s fragment never reaches the server: it sees "/history" and nothing after the #', async () => {
  const p = C.packReport(svcCar(), { today: T, units: 'mi', notes: true });
  p.s[0][5] = 'FRAGMENT_MARKER_NOTE';
  const { frag } = await C.encodeReport(p);
  const mark = seen.length;
  const r = await fetch(`${base}/history#${frag}`);
  assert.strictEqual(r.status, 200);
  const got = seen.slice(mark);
  assert.deepStrictEqual(got.map((x) => x.url), ['/glovebox/history']);
  const all = JSON.stringify(got);
  assert.ok(!all.includes(frag.slice(5, 30)) && !all.includes('v1.z') && !all.includes('#'), 'no part of the report in the request line, headers or body');
  assert.ok(!JSON.stringify(identityStore._dump()).includes('FRAGMENT_MARKER'));
});

test('the metered route: requireUser, requireBudget, requireDailyCap, THEN its parser; one model call in the server', () => {
  const layer = app._router.stack.find((l) => l.route && l.route.path === '/api/read' && l.route.methods.post);
  assert.deepStrictEqual(layer.route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one metered call, nowhere else');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  const ai = require('../lib/ai');
  assert.match(ai.SYSTEM.dash, /Do not judge how serious anything is and do not give advice/);
  assert.match(ai.SYSTEM.dash, /Never guess a catalogue id/);
  assert.ok(!JSON.stringify(ai.DASH_TOOL).includes('urgen'), 'the dash tool does not even ask for urgency');
  assert.match(ai.SYSTEM.receipt, /do not invent/);
});

test('read: input checked by its bytes before any spend, one metered call, a forced tool, the answer cleaned', async () => {
  const ana = await register('ana.driver@example.com');
  const calls = await modelCalls();
  assert.strictEqual((await ana('POST', '/api/read', {})).status, 400);
  assert.strictEqual((await ana('POST', '/api/read', { kind: 'selfie', photo: jpeg() })).status, 400, 'an unknown kind');
  assert.strictEqual((await ana('POST', '/api/read', { kind: 'dash' })).status, 400, 'no photo');
  assert.strictEqual((await ana('POST', '/api/read', { kind: 'dash', photo: { type: 'image/jpeg', data: Buffer.from('%PDF-1.4 not a photo').toString('base64') } })).status, 400, 'a PDF called a JPEG');
  assert.strictEqual((await ana('POST', '/api/read', { kind: 'dash', photo: { type: 'image/jpeg', data: 'not base64 !!' } })).status, 400);
  assert.strictEqual((await ana('POST', '/api/read', { kind: 'receipt', photo: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } })).status, 400, 'over 4 MB decoded');
  assert.strictEqual((await ana('POST', '/api/read', BIG)).status, 413, 'over the 6 MB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad photo');
  const n0 = fakeCalls.length;
  const r = await ana('POST', '/api/read', { kind: 'dash', photo: jpeg(), today: T });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.data.result.lights.map((x) => [x.id, x.group]), [['check-engine', 'amber'], ['tpms', 'amber']]);
  assert.deepStrictEqual(r.data.result.odometer, { value: 48212, unit: 'mi' });
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const req = fakeCalls[fakeCalls.length - 1];
  assert.strictEqual(fakeCalls.length, n0 + 1);
  assert.strictEqual(req.model, 'claude-haiku-4-5', 'a free account runs Haiku');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'read_dash' });
  // The model says the red oil light is fine. The app never repeats it.
  const red = await ana('POST', '/api/read', { kind: 'dash', photo: jpeg('REDOIL') });
  assert.deepStrictEqual([red.data.result.lights[0].id, red.data.result.lights[0].group], ['oil-pressure', 'red']);
  assert.ok(!/safe to keep|not serious|ignore|urgency/i.test(red.text), red.text);
  const inj = await ana('POST', '/api/read', { kind: 'dash', photo: jpeg('INJECT') });
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text), 'no markup or bidi reaches the page');
  assert.ok(!/flux|purple|parsecs|urgency|severity|harmless|safe to ignore/i.test(inj.text), inj.text);
  assert.ok(inj.data.result.lights.length <= 12);
  assert.strictEqual(inj.data.result.lights[0].group, 'red', 'the made-up lights fall back to red, the careful answer');
  assert.ok(inj.data.result.lights.some((x) => x.id === 'check-engine' && x.group === 'red'), 'lit red, treated as red');
  assert.strictEqual(inj.data.result.odometer, null);
  // Receipts.
  const rc = await ana('POST', '/api/read', { kind: 'receipt', photo: jpeg(), today: T });
  assert.strictEqual(rc.status, 200, rc.text);
  assert.deepStrictEqual(fakeCalls[fakeCalls.length - 1].tool_choice, { type: 'tool', name: 'read_receipt' });
  assert.deepStrictEqual([rc.data.result.date, rc.data.result.total, rc.data.result.items.map((x) => x.item)], ['2026-10-02', 112.5, ['oil', 'rotate', 'wipers']]);
  const ri = await ana('POST', '/api/read', { kind: 'receipt', photo: jpeg('INJECT'), today: T });
  assert.ok(!/<[a-z/!]/i.test(ri.text) && !/\u202e|DOGE|flux-capacitor|2999/.test(ri.text), ri.text);
  assert.deepStrictEqual([ri.data.result.date, ri.data.result.mileage, ri.data.result.total, ri.data.result.currency], [null, null, null, null]);
  assert.ok(ri.data.result.items.length <= 20 && ri.data.result.items[0].item === null && ri.data.result.items[0].cost === null);
  // A phone date far from the server's is not trusted.
  const skew = await ana('POST', '/api/read', { kind: 'receipt', photo: jpeg(), today: '2099-01-01' });
  assert.strictEqual(skew.status, 200);
  for (const kind of ['dash', 'receipt']) {
    const blank = await ana('POST', '/api/read', { kind, photo: jpeg('BLANK') });
    assert.deepStrictEqual([blank.status, /doesn’t look like/.test(blank.data.error)], [422, true]);
  }
  assert.match((await ana('POST', '/api/read', { kind: 'dash', photo: jpeg('MAXTOKENS') })).data.error, /ran long/);
  const up = await ana('POST', '/api/read', { kind: 'dash', photo: jpeg('UPSTREAM401') });
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in|401/.test(up.text), 'a provider error is not passed on');
  const busy = await ana('POST', '/api/read', { kind: 'receipt', photo: jpeg('UPSTREAM529') });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('an unconfirmed free account gets the verify-email 403 before any model call or big body; out of credit is a 402, not a 413', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/read', { kind: 'dash', photo: jpeg() });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/glovebox/api/auth/verify/send', 'the resend link is under this app\'s mount');
    assert.strictEqual((await eve('POST', '/api/read', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/read', { kind: 'receipt', photo: jpeg() })).status, 402);
  assert.strictEqual((await cal('POST', '/api/read', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
});

test('nothing is stored server-side: no car, no photo, no answer - only the shared account and its usage rows', async () => {
  const dump = identityStore._dump();
  for (const m of ['PHOTO_MARKER', 'read_dash', 'read_receipt', 'check-engine', 'QuickLube', 'oil-pressure', 'FRAGMENT_MARKER', Buffer.from('JFIF PHOTO_MARKER').toString('base64').slice(0, 16)]) assert.ok(!dump.includes(m), `${m} was stored`);
  const cols = JSON.parse(dump).map(([p]) => p).sort();
  assert.ok(cols.every((c) => ['users', 'usage', 'events', 'control'].some((k) => c.toLowerCase().includes(k))), `only account collections: ${cols.join(', ')}`);
  const src = read('server.js');
  assert.ok(!/store\.(set|merge|add|transact)\(/.test(src), 'the server has no app store to write to');
  assert.ok(!/fs\.(write|append)/.test(src + read('lib/photo.js') + read('lib/ai.js')), 'and writes no files');
  assert.ok(fakeCalls.every((c) => c.messages[0].content.every((b) => b.type !== 'image' || /^<\d+ chars>$/.test(b.source.data))), 'even the test double keeps only a photo\'s length');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  // Everything the server is ever told, recorded, to prove what it never sees.
  hostApp.use((req, _res, next) => { seen.push({ url: req.originalUrl, headers: req.headers }); next(); });
  hostApp.use('/glovebox', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/glovebox`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
