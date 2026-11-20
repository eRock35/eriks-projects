// The rules first (the big days, the planner and its reasons, swaps, pins
// and moves, the shopping list, the doors, kid mode, the print maths, the
// recap, the two-phone merge), then the demo's planted story, hostile text,
// the storage module, the page's promises and the copy, then end to end
// against the memory store and the fake model:
//   AJAR_MEMORY=1 AJAR_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /ajar, the way the
// lab mounts it, so the auth cookie, the budget gate and each route's parser
// order are exercised as deployed. Model calls are counted from the identity
// usage rows, and what reached "the model" is read from the fake's own log.
//
// Every family and name here is made up. Addresses are built with AT and
// brand names from pieces, so no file carries either.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.AJAR_MEMORY !== '1' || process.env.AJAR_FAKE_AI !== '1') {
  console.error('run with AJAR_MEMORY=1 AJAR_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient, ownerTag } = require('../server');
const C = require('../public/ajar-core');
const D = require('../public/demo');
const DK = require('../public/ajar-deck');
const AS = require('../public/ajar-store');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
const ch = (n) => String.fromCharCode(n);
const RLO = ch(0x202E), ZWSP = ch(0x200B), FW_AT = ch(0xFF20), SMALL_AT = ch(0xFE6B);
const clone = (v) => JSON.parse(JSON.stringify(v));
// The models, from pieces: no file but server.js names one.
const FREE_MODEL = ['claude', 'haiku', '4', '5'].join('-'), PAID_MODEL = ['claude', 'sonnet', '5'].join('-');

/* ---------------- helpers ---------------- */

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
function cieLab(h) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16)));
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const labDist = (a, b) => { const x = cieLab(a), y = cieLab(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };

/** A countdown for the planner tests. */
function make(setup, picks, id) {
  const s = Object.assign(C.defaultSetup('2026-11-20'), setup || {});
  const cd = C.newCountdown(id || 'testcdabcd', s, 1000);
  cd.deck.picks = picks || [];
  return cd;
}
const plan = (cd, seed) => C.replan(cd, { seed: seed || 1, t: 5000 });
const weekdayOf = (d) => C.weekday(C.dayOf(d));
function own(id, k, extra) { return Object.assign({ id, t: 'Own ' + id, h: 'Something of our own.', th: 'any', tm: 'short', c: 'free', amt: 0, w: 'home', m: 'none', k: k || 'crafts', a: [0, 17], n: [], src: 'own' }, extra || {}); }

/* ================================================================== *
 * The big day
 * ================================================================== */

test('the big days: Christmas is doors 1-24 December; the first Sunday of Advent for 2026-2030 is 29 Nov, 28 Nov, 3 Dec, 2 Dec and 1 Dec, to 24 December; the year turns after Christmas Eve', () => {
  const xmas = C.range({ template: 'christmas', year: 2026 });
  assert.deepStrictEqual([xmas.start, xmas.end, xmas.bigDay, xmas.doors], ['2026-12-01', '2026-12-24', '2026-12-25', 24]);
  const want = { 2026: '2026-11-29', 2027: '2027-11-28', 2028: '2028-12-03', 2029: '2029-12-02', 2030: '2030-12-01' };
  for (const [y, d] of Object.entries(want)) {
    assert.strictEqual(C.adventStart(Number(y)), d, `Advent ${y}`);
    assert.strictEqual(weekdayOf(d), 0, `${d} is a Sunday`);
    const r = C.range({ template: 'advent', year: Number(y) });
    assert.deepStrictEqual([r.start, r.end], [d, `${y}-12-24`]);
    // The fourth Sunday before Christmas: three more Sundays come before 25 December.
    assert.strictEqual(r.dates.filter((x) => weekdayOf(x) === 0).length, 4, `${y}: four Sundays of Advent`);
  }
  assert.strictEqual(C.range({ template: 'advent', year: 2026 }).doors, 26);
  assert.strictEqual(C.range({ template: 'advent', year: 2028 }).doors, 22);
  assert.deepStrictEqual(['2026-11-20', '2026-12-24', '2026-12-25', '2027-01-03'].map(C.christmasYear), [2026, 2026, 2027, 2027]);
  assert.strictEqual(C.dayLabel('2026-12-16'), 'Wed 16 Dec');
  assert.strictEqual(C.longDay('2026-12-09'), 'Wednesday 9 December');
  assert.strictEqual(C.dayOf('2026-02-30'), null, 'a date that is not real');
});

test('any big day: 3 to 31 doors, ending the day before or on the day - and it says which', () => {
  const eve = C.range({ template: 'custom', bigDay: '2027-03-14', doors: 10, ends: 'eve' });
  assert.deepStrictEqual([eve.start, eve.end, eve.doors, eve.bigDay], ['2027-03-04', '2027-03-13', 10, '2027-03-14']);
  const day = C.range({ template: 'custom', bigDay: '2027-03-14', doors: 10, ends: 'day' });
  assert.deepStrictEqual([day.start, day.end], ['2027-03-05', '2027-03-14']);
  assert.match(C.rangeLine({ template: 'custom', bigDay: '2027-03-14', doors: 10, ends: 'eve' }), /10 doors, the last on the day before$/);
  assert.match(C.rangeLine({ template: 'custom', bigDay: '2027-03-14', doors: 10, ends: 'day' }), /the last on the day itself$/);
  assert.strictEqual(C.range({ template: 'custom', bigDay: '2027-01-02', doors: 3, ends: 'eve' }).start, '2026-12-30', 'across a new year');
  assert.strictEqual(C.range({ template: 'custom', bigDay: '2028-03-01', doors: 31, ends: 'eve' }).start, '2028-01-30', 'across a leap day: 29 February counts');
  assert.strictEqual(C.range({ template: 'custom', bigDay: '', doors: 5 }), null);
  for (const [n, ok] of [[2, false], [3, true], [31, true], [32, false]]) {
    const errs = [];
    C.cleanSetup(Object.assign(C.defaultSetup('2026-11-20'), { template: 'custom', bigDay: '2027-01-10', doors: n, name: 'A trip' }), errs, true);
    assert.strictEqual(errs.length === 0, ok, `${n} doors: ${errs}`);
  }
  assert.deepStrictEqual(C.themesFor({ template: 'christmas' }), ['festive', 'winter', 'any']);
  assert.deepStrictEqual(C.themesFor({ template: 'custom', look: 'birthday' }), ['birthday', 'any']);
  assert.deepStrictEqual(C.themesFor({ template: 'custom', look: 'winter' }), ['winter', 'any'], 'a winter countdown with no festive ones, for families who do not celebrate Christmas');
});

/* ================================================================== *
 * The deck
 * ================================================================== */

test('the deck: about a hundred activities in its own words, every tag from the lists, needs up to four short things, ages in range; ~30 original jokes, treats and notes; nothing religious', () => {
  assert.ok(C.DECK.length >= 95 && C.DECK.length <= 120, `${C.DECK.length} activities`);
  const ids = new Set(), titles = new Set();
  for (const a of C.DECK) {
    assert.ok(C.ID.deck.test(a.id) && !ids.has(a.id), a.id); ids.add(a.id);
    assert.ok(!titles.has(C.norm(a.t)), 'one title once: ' + a.t); titles.add(C.norm(a.t));
    assert.ok(C.THEMES.includes(a.th) && C.TIMES.includes(a.tm) && C.COSTS.includes(a.c) && C.WHERES.includes(a.w) && C.MESSES.includes(a.m) && C.LIKES.includes(a.k), a.id);
    assert.ok(a.t.length <= 50 && a.h.length <= 160 && a.n.length <= 4 && a.n.every((n) => n.length <= 30), a.id);
    assert.ok(a.a[0] >= 0 && a.a[1] <= 17 && a.a[0] <= a.a[1], a.id);
    assert.ok(a.c === 'free' ? a.amt === 0 : a.amt > 0, a.id + ' has a default amount');
    for (const s of [a.t, a.h, ...a.n]) assert.ok(!C.hasAt(s) && !C.hasLink(s) && !C.hasPhone(s) && !C.namesBrand(s) && !C.hasInvisible(s), `${a.id}: ${s}`);
  }
  for (const th of C.THEMES) assert.ok(C.DECK.filter((a) => a.th === th).length >= 6, th);
  for (const tm of C.TIMES) assert.ok(C.DECK.filter((a) => a.tm === tm).length >= 5, tm);
  assert.ok(DK.JOKES.length >= 28 && DK.JOKES.every((j) => j[0].endsWith('?') && j[1].length > 3), 'about thirty jokes, each a question and an answer');
  assert.ok(DK.TREATS.length >= 5 && DK.NOTES.length >= 5);
  const all = JSON.stringify(DK);
  assert.ok(!/\b(church|chapel|pray|prayer|nativity|bible|angel|jesus|christ\b|saint|carol service|mass\b|menorah|diwali|eid|temple|mosque|synagogue)\b/i.test(all), 'no religious content in the deck');
  assert.strictEqual(C.filler('joke-01').answer, DK.JOKES[0][1]);
  assert.strictEqual(C.filler('joke-99'), null);
});

/* ================================================================== *
 * The planner
 * ================================================================== */

function demoLikeSetup() { return { template: 'christmas', year: 2026, busy: [2, 4], evening: 30, kids: [{ name: 'Ada', age: 6 }], budget: { mode: 'set', usd: 60 }, pins: [{ id: 'p-concrt', title: 'Concert', date: '2026-12-16' }] }; }

test('the planner: busy evenings get 5-minute ones and fillers; half-day ones go on weekends; a pinned event is its own door on its date; nothing that needs shopping on the first two days; no two messy ones in a row', () => {
  const picks = ['biscuit-house', 'stick-den', 'bake-bread', 'decorate-biscuits', 'salt-dough', 'own-pizzas', 'playdough', 'paper-chain', 'kitchen-disco', 'charades', 'freeze-dance', 'frost-hunt', 'story-chain', 'memory-jar', 'compliment-circle', 'walk-bingo', 'draw-each-other', 'paper-planes', 'decorate-tree', 'board-games'];
  const { cd, report } = plan(make(demoLikeSetup(), picks), 7);
  assert.deepStrictEqual(C.checkPlan(cd), [], 'every rule holds');
  for (const d of C.datesOf(cd)) {
    const inf = C.info(cd, d), a = C.planned(cd, d);
    assert.ok(a, d);
    if (inf.pin) { assert.strictEqual(a.id, 'p-concrt'); continue; }
    if (inf.busy) assert.ok(a.filler || a.tm === 'quick', `${d} busy: ${a.t}`);
    if (a.tm === 'half') assert.ok(inf.weekend && !inf.busy, `${d}: ${a.t} on a weekday`);
    if (inf.idx < 2) assert.strictEqual(a.n.length, 0, `${d}: ${a.t} needs shopping on day ${inf.door}`);
    if (a.m === 'lots') assert.ok(!(C.planned(cd, C.addDays(d, 1)) || {}).m || C.planned(cd, C.addDays(d, 1)).m !== 'lots', `${d}: two messy in a row`);
  }
  assert.strictEqual(cd.plan['2026-12-16'].a, 'p-concrt');
  assert.ok(['2026-12-05', '2026-12-06', '2026-12-12', '2026-12-13', '2026-12-19', '2026-12-20'].some((d) => C.planned(cd, d).tm === 'half'), 'a weekend has a half-day one');
  assert.strictEqual(report.placed + report.leftOut.length, picks.length);
  const busyDays = C.datesOf(cd).filter((d) => C.info(cd, d).busy);
  assert.ok(busyDays.some((d) => C.planned(cd, d).filler), 'a filler on a busy evening');
  // With an hour every evening, a whole evening fits a weekday; with 15 minutes, nothing but a quick one does.
  const short = plan(make(Object.assign(demoLikeSetup(), { evening: 15, busy: [] }), ['walk-bingo', 'paper-snowflakes', 'kitchen-disco']), 3).cd;
  for (const d of C.datesOf(short)) { const a = C.planned(short, d), inf = C.info(short, d); if (a && !a.filler && a.src !== 'pin' && !inf.weekend) assert.strictEqual(a.tm, 'quick', `${d}: ${a.t} on a 15-minute weekday`); }
});

test('the planner: the same seed gives the same plan and a different seed a different one; it only places what was chosen; it explains each day in a few words', () => {
  const picks = C.starterPicks(make(demoLikeSetup()), 11);
  const base = make(demoLikeSetup(), picks);
  const a = plan(base, 42).cd, b = plan(base, 42).cd, c2 = plan(base, 43).cd;
  assert.deepStrictEqual(a.plan, b.plan, 'same seed, same plan');
  assert.notDeepStrictEqual(C.datesOf(a).map((d) => a.plan[d].a), C.datesOf(c2).map((d) => c2.plan[d].a), 'another seed, another plan');
  const placed = C.datesOf(a).map((d) => a.plan[d].a).filter((x) => C.isDeckId(x));
  assert.ok(placed.every((x) => picks.includes(x)), 'only chosen activities');
  assert.strictEqual(new Set(placed).size, placed.length, 'each once');
  const words = C.datesOf(a).map((d) => C.explain(a, d));
  assert.ok(words.every((w) => w.text && !w.warn && w.text.length < 140), 'a reason for every day');
  const busy = C.datesOf(a).find((d) => C.info(a, d).busy && !C.info(a, d).pin);
  assert.match(C.explain(a, busy).text, /^A busy (Tuesday|Thursday) - /);
  assert.match(C.explain(a, '2026-12-16').text, /^Fixed: Concert/);
  const half = C.datesOf(a).find((d) => C.planned(a, d).tm === 'half');
  if (half) assert.match(C.explain(a, half).text, /(Saturday|Sunday) - room for half a day/);
  // The same kind kept apart when there is room.
  for (let seed = 1; seed <= 25; seed++) {
    const cd = make({ template: 'custom', bigDay: '2027-02-06', doors: 5, ends: 'eve', busy: [], evening: 30 }, ['c-aaaaaaaa', 'c-bbbbbbbb']);
    cd.deck.custom = [own('c-aaaaaaaa', 'baking'), own('c-bbbbbbbb', 'baking')];
    const p = plan(cd, seed).cd, on = C.datesOf(p).filter((d) => p.plan[d].a.startsWith('c-'));
    assert.strictEqual(on.length, 2);
    assert.ok(C.dayOf(on[1]) - C.dayOf(on[0]) > 1, `seed ${seed}: two baking days side by side`);
  }
});

test('the planner keeps to the budget - the dearest left out and said; a budget of no money places free ones only - and keeps opened, pinned and fixed days where they are', () => {
  const picks = ['biscuit-house', 'kindness-bags', 'paper-chain', 'decorate-biscuits', 'walk-bingo'];
  const tight = plan(make(Object.assign(demoLikeSetup(), { budget: { mode: 'set', usd: 10 } }), picks), 1);
  assert.deepStrictEqual(tight.report.leftOut.filter((x) => x.why === 'budget').map((x) => x.id), ['biscuit-house', 'kindness-bags']);
  assert.ok(C.budget(tight.cd).total <= 1000, 'under $10');
  assert.match(C.budget(tight.cd).word, /^\$8 of \$10 - \$2 left\.$/);
  const none = plan(make(Object.assign(demoLikeSetup(), { budget: { mode: 'none', usd: 0 } }), picks), 1);
  assert.strictEqual(C.budget(none.cd).total, 0);
  assert.deepStrictEqual(none.report.leftOut.map((x) => x.id).sort(), ['biscuit-house', 'decorate-biscuits', 'kindness-bags', 'paper-chain']);
  // Said plainly when it cannot be under: an opened door's cost is already spent.
  const over = clone(tight.cd);
  over.setup.budget = { mode: 'set', usd: 2 };
  assert.match(C.budget(over).word, /^The plan costs \$8 and the budget is \$2 - \$6 over\.$/);
  // Opened, pinned and fixed days stay through a shuffle.
  let cd = plan(make(demoLikeSetup(), C.starterPicks(make(demoLikeSetup()), 5)), 5).cd;
  cd = C.openDoor(cd, '2026-12-01', '2026-12-01', 6000).cd;
  cd = C.togglePin(cd, '2026-12-05', { t: 6001 }).cd;
  const keep = { d1: cd.plan['2026-12-01'].a, d5: cd.plan['2026-12-05'].a };
  for (let s = 1; s < 20; s++) {
    const n = C.replan(cd, { seed: s, t: 7000 }).cd;
    assert.deepStrictEqual([n.plan['2026-12-01'].a, n.plan['2026-12-05'].a, n.plan['2026-12-16'].a], [keep.d1, keep.d5, 'p-concrt']);
    assert.strictEqual(n.plan['2026-12-01'].t, cd.plan['2026-12-01'].t, 'an untouched day keeps its time stamp');
  }
});

test('property: for 300 random families and countdowns, every planned day keeps every rule, nothing is placed twice, the budget holds, and starter picks fill most doors', () => {
  const rnd = C.prng(20261120);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  for (let i = 0; i < 300; i++) {
    const tpl = pick(['christmas', 'advent', 'custom']);
    const s = { template: tpl, year: 2026 + Math.floor(rnd() * 4), bigDay: C.iso(C.dayOf('2027-01-01') + Math.floor(rnd() * 500)), doors: 3 + Math.floor(rnd() * 29), ends: pick(['eve', 'day']), look: pick(C.LOOKS),
      busy: [0, 1, 2, 3, 4, 5, 6].filter(() => rnd() < 0.3), evening: pick(C.EVENINGS), budget: { mode: pick(C.BUDGET_MODES), usd: Math.floor(rnd() * 80) }, kids: rnd() < 0.7 ? [{ name: 'Kid', age: Math.floor(rnd() * 12) + 2 }] : [] };
    const base = make(s, []);
    const ds = C.datesOf(base);
    if (rnd() < 0.4) s.busyDates = [pick(ds)];
    if (rnd() < 0.5) s.pins = [{ id: 'p-abcdef', title: 'Party', date: pick(ds) }];
    const cd0 = make(s, rnd() < 0.5 ? C.starterPicks(make(s), i) : C.DECK.filter(() => rnd() < 0.25).map((a) => a.id));
    const { cd, report } = plan(cd0, i + 1);
    assert.deepStrictEqual(C.checkPlan(cd), [], `case ${i}: ${JSON.stringify(C.checkPlan(cd)).slice(0, 200)}`);
    const on = C.datesOf(cd).map((d) => cd.plan[d].a).filter((x) => !C.ID.filler.test(x));
    assert.strictEqual(new Set(on).size, on.length, `case ${i}: placed twice`);
    assert.ok(C.budget(cd).total <= C.budgetCap(cd.setup), `case ${i}: over budget`);
    assert.strictEqual(report.placed + report.leftOut.length, cd0.deck.picks.length, `case ${i}: every pick placed or said`);
    assert.ok(C.cleanCountdown(cd, true).errors.length === 0, `case ${i}: ${C.cleanCountdown(cd, true).errors[0]}`);
  }
});

/* ================================================================== *
 * Swaps, pins and moves - every refusal with a way out
 * ================================================================== */

test('swaps, pins and moves: refused with a way out for a fixed event (Setup), an opened door (pick another), a pinned day (unpin and swap) and a broken rule (swap anyway); the way out works', () => {
  const picks = ['biscuit-house', 'kitchen-disco', 'walk-bingo', 'paper-chain', 'charades', 'frost-hunt'];
  let cd = make(demoLikeSetup(), picks);
  cd.plan = { '2026-12-01': { a: 'kitchen-disco', t: 1 }, '2026-12-02': { a: 'walk-bingo', t: 1 }, '2026-12-03': { a: 'charades', t: 1 }, '2026-12-04': { a: 'paper-chain', t: 1 }, '2026-12-05': { a: 'biscuit-house', t: 1 }, '2026-12-06': { a: 'frost-hunt', t: 1 }, '2026-12-16': { a: 'p-concrt', t: 1 } };
  const ok = C.swap(cd, '2026-12-02', '2026-12-06', { t: 9 });
  assert.ok(ok.ok, ok.msg);
  assert.deepStrictEqual([ok.cd.plan['2026-12-02'].a, ok.cd.plan['2026-12-06'].a, ok.cd.plan['2026-12-02'].t], ['frost-hunt', 'walk-bingo', 9]);
  const ev = C.swap(cd, '2026-12-16', '2026-12-02', { t: 9 });
  assert.deepStrictEqual([ev.ok, ev.way.act], [false, 'setup']);
  assert.match(ev.msg, /Concert stays on Wed 16 Dec/);
  const rule = C.swap(cd, '2026-12-05', '2026-12-01', { t: 9 });
  assert.deepStrictEqual([rule.ok, rule.way.label, rule.way.force], [false, 'Swap anyway', true]);
  assert.match(rule.msg, /half a day/);
  const forced = C.swap(cd, '2026-12-05', '2026-12-01', { t: 9, force: true });
  assert.ok(forced.ok);
  assert.ok(C.checkPlan(forced.cd).some((x) => x.code === 'busy' || x.code === 'half'), 'the plan says what a forced swap broke');
  assert.ok(C.explain(forced.cd, '2026-12-01').warn, 'and the day says so');
  const buy = C.swap(cd, '2026-12-04', '2026-12-02', { t: 9 });
  assert.match(buy.msg, /needs coloured paper, and door 2 leaves no time to buy it/);
  const pinned = C.togglePin(cd, '2026-12-02', { t: 9 }).cd;
  const p1 = C.swap(pinned, '2026-12-02', '2026-12-06', { t: 9 });
  assert.deepStrictEqual([p1.ok, p1.way.unpin, p1.way.label], [false, true, 'Unpin it and swap']);
  const p2 = C.swap(pinned, '2026-12-02', '2026-12-06', { t: 10, unpin: true });
  assert.ok(p2.ok && !p2.cd.plan['2026-12-02'].pin);
  const opened = C.openDoor(cd, '2026-12-02', '2026-12-02', 10).cd;
  const op = C.swap(opened, '2026-12-02', '2026-12-06', { t: 11 });
  assert.deepStrictEqual([op.ok, op.way.act], [false, 'cancel']);
  assert.match(op.msg, /Door 2 is already open/);
  assert.strictEqual(C.togglePin(cd, '2026-12-16', { t: 1 }).way.act, 'setup');
  assert.strictEqual(C.togglePin(opened, '2026-12-02', { t: 1 }).ok, false);
  assert.strictEqual(C.swap(cd, '2026-12-02', '2026-12-02', {}).way.act, 'cancel');
  assert.strictEqual(C.swap(cd, '2026-12-02', '2027-12-02', {}).ok, false);
  for (const r of [ev, rule, buy, p1, op]) assert.ok(r.way && r.way.label && r.way.act, 'every refusal carries a way out');
});

test('move from an opened door: the activity goes to a later shut day, what was there comes to tonight instead, the door says moved; refusals each with a way out', () => {
  let cd = make(demoLikeSetup(), ['walk-bingo', 'paper-chain']);
  cd.plan = { '2026-12-02': { a: 'walk-bingo', t: 1 }, '2026-12-09': { a: 'joke-03', t: 1 }, '2026-12-10': { a: 'paper-chain', t: 1 }, '2026-12-16': { a: 'p-concrt', t: 1 } };
  assert.strictEqual(C.move(cd, '2026-12-02', '2026-12-09', { t: 2, today: '2026-12-02' }).way.act, 'open', 'open it first');
  cd = C.openDoor(cd, '2026-12-02', '2026-12-02', 3).cd;
  const m = C.move(cd, '2026-12-02', '2026-12-09', { t: 4, today: '2026-12-02' });
  assert.ok(m.ok, m.msg);
  assert.deepStrictEqual([m.cd.plan['2026-12-09'].a, m.cd.plan['2026-12-02'].a, m.cd.doors['2026-12-02'].status, m.cd.doors['2026-12-02'].to], ['walk-bingo', 'joke-03', 'moved', '2026-12-09']);
  assert.strictEqual(m.msg, 'Winter walk bingo moved to Wed 9 Dec.');
  assert.strictEqual(C.move(m.cd, '2026-12-02', '2026-12-11', { t: 5, today: '2026-12-02' }).ok, false, 'moved once');
  assert.strictEqual(C.move(cd, '2026-12-02', '2026-12-01', { t: 5, today: '2026-12-02' }).way.label, 'Pick a later day');
  assert.strictEqual(C.move(cd, '2026-12-02', '2026-12-16', { t: 5, today: '2026-12-02' }).ok, false, 'not onto a fixed event');
  const busy = C.move(cd, '2026-12-02', '2026-12-10', { t: 5, today: '2026-12-02' });
  assert.deepStrictEqual([busy.ok, busy.way.label], [false, 'Move it anyway'], 'a 30-minute one onto a busy Thursday');
  assert.ok(C.move(cd, '2026-12-02', '2026-12-10', { t: 5, today: '2026-12-02', force: true }).ok);
  assert.strictEqual(C.setStatus(m.cd, '2026-12-02', 'done', 6).ok, false, 'a moved door is not marked done');
});

/* ================================================================== *
 * Shopping, doors, kid mode
 * ================================================================== */

test('the shopping list: every planned activity’s needs rolled up and de-duplicated (plurals, "a"), each to buy by the day before first use, grouped by week, ticked, shared as plain text', () => {
  let cd = make(demoLikeSetup(), []);
  cd.deck.custom = [own('c-aaaaaaaa', 'crafts', { n: ['paper plates', 'Glue stick'] }), own('c-bbbbbbbb', 'crafts', { n: ['a paper plate', 'string'] })];
  cd.plan = { '2026-12-03': { a: 'c-aaaaaaaa', t: 1 }, '2026-12-14': { a: 'c-bbbbbbbb', t: 1 }, '2026-12-10': { a: 'paper-chain', t: 1 } };
  const s = C.shopping(cd, '2026-12-01');
  const by = Object.fromEntries(s.items.map((x) => [x.key, x]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['coloured paper', 'glue stick', 'paper plate', 'string']);
  assert.strictEqual(by['paper plate'].by, '2026-12-02', 'the day before first use');
  assert.deepStrictEqual(by['paper plate'].uses.map((u) => u.door), [3, 14], 'one line for both uses');
  assert.strictEqual(by['glue stick'].uses.length, 2, '"Glue stick" and "glue stick" are one thing');
  assert.strictEqual(by['paper plate'].due, 'tomorrow');
  assert.deepStrictEqual(s.groups.map((g) => g.label), ['Week of Mon 30 Nov', 'Week of Mon 7 Dec']);
  cd.shop['paper plate'] = { got: true, t: 2 };
  const s2 = C.shopping(cd, '2026-12-01');
  assert.deepStrictEqual([s2.got, s2.left], [1, 3]);
  const text = C.shopText(cd, '2026-12-01');
  assert.match(text, /^Shopping for Christmas \(4 things to get\)/);
  assert.match(text, /\[x\] paper plates - by Wed 2 Dec \(door 3 and 1 more\)/);
  assert.match(text, /\[ \] string - by Sun 13 Dec \(door 14\)/);
  assert.ok(!/<|>|https?:/.test(text), 'plain text');
  // A day-one need lands before door 1.
  const early = make(demoLikeSetup(), []);
  early.plan = { '2026-12-01': { a: 'paper-chain', t: 1 } };
  assert.strictEqual(C.shopping(early, '2026-11-20').groups[0].label, 'Before door 1 (Tue 1 Dec)');
  assert.strictEqual(C.shopping(early, '2026-12-01').items[0].due, 'late');
});

test('the doors: shut until their day from a passed-in today ("Opens tomorrow", "Opens Thursday"), the way out a grown-up peek; open, done, skipped, a star; the order on the board is shuffled and fixed', () => {
  const cd = D.countdown();
  const t = '2026-12-09';
  assert.deepStrictEqual(['2026-12-08', '2026-12-09', '2026-12-10', '2026-12-12', '2026-12-20'].map((d) => C.door(cd, d, t).state), ['open', 'today', 'shut', 'shut', 'shut']);
  assert.deepStrictEqual(['2026-12-10', '2026-12-12', '2026-12-20'].map((d) => C.door(cd, d, t).opens), ['Opens tomorrow', 'Opens Saturday', 'Opens Sun 20 Dec']);
  const locked = C.openDoor(cd, '2026-12-10', t, 1);
  assert.deepStrictEqual([locked.ok, locked.msg, locked.way.act], [false, 'Door 10 opens tomorrow.', 'plan']);
  const o = C.openDoor(cd, '2026-12-09', t, 2);
  assert.ok(o.ok && o.cd.doors['2026-12-09'].open);
  assert.ok(C.openDoor(cd, '2026-12-10', '2026-12-10', 3).ok, 'opens on its own day');
  assert.strictEqual(C.door(cd, '2026-12-09', '2026-12-11').state, 'missed', 'a missed door stays openable');
  let x = C.setStatus(o.cd, '2026-12-09', 'done', 4).cd;
  assert.strictEqual(x.doors['2026-12-09'].status, 'done');
  x = C.setStatus(x, '2026-12-09', 'done', 5).cd;
  assert.strictEqual(x.doors['2026-12-09'].status, '', 'a second tap undoes it');
  x = C.toggleStar(x, '2026-12-09', 6).cd;
  assert.strictEqual(x.doors['2026-12-09'].star, true);
  assert.strictEqual(C.setStatus(cd, '2026-12-10', 'done', 1).ok, false);
  assert.strictEqual(C.toggleStar(cd, '2026-12-10', 1).way.label, 'Open it');
  const lay = C.layout(cd);
  assert.deepStrictEqual(lay.slice().sort((a, b) => a - b), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.notDeepStrictEqual(lay, Array.from({ length: 24 }, (_, i) => i + 1), 'shuffled');
  assert.deepStrictEqual(C.layout(D.countdown()), lay, 'the same every time');
  assert.strictEqual(C.daysToGo(cd, t), 16);
});

test('kid mode’s grown-up question comes from a value the page passes: a sum like "7 + 5", four different choices with the answer among them, the same for the same value', () => {
  const seen = new Set();
  for (let n = 0; n < 500; n++) {
    const q = C.kidQuestion(n);
    assert.strictEqual(q.answer, q.a + q.b);
    assert.strictEqual(q.text, `${q.a} + ${q.b}`);
    assert.ok(q.a >= 4 && q.b >= 4 && q.a <= 9 && q.b <= 9);
    assert.strictEqual(new Set(q.choices).size, 4);
    assert.ok(q.choices.includes(q.answer));
    assert.deepStrictEqual(C.kidQuestion(n), q, 'no dice in the core');
    seen.add(q.text);
  }
  assert.ok(seen.size >= 30, 'many different sums');
  assert.ok(!/Math\.random/.test(read('public/ajar-core.js')));
  assert.match(read('public/app.js'), /state\.kidQ = C\.kidQuestion\(seed\(\)\)/, 'the page passes its own random number');
});

/* ================================================================== *
 * Print and the recap
 * ================================================================== */

test('the door cards: 8 to a Letter sheet and 8 to an A4 sheet, every card inside its page and its margins, none overlapping, edge to edge, every edge on a dashed cut line; 24 doors are three sheets', () => {
  for (const paper of ['letter', 'a4']) {
    const g = C.cardGrid(paper), P = g.paper;
    assert.strictEqual(g.cards.length, 8);
    for (const c of g.cards) {
      assert.ok(c.x >= g.margin - 1e-9 && c.y >= g.margin - 1e-9 && c.x + c.w <= P.w - g.margin + 1e-6 && c.y + c.h <= P.h - g.margin + 1e-6, `${paper} card ${c.i} inside`);
      assert.ok(c.w >= 90 && c.h >= 60, `${paper}: big enough to read (${c.w} x ${c.h} mm)`);
    }
    for (const a of g.cards) for (const b of g.cards) {
      if (a === b) continue;
      const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;
      assert.ok(!overlap, `${paper}: cards ${a.i} and ${b.i} overlap`);
    }
    const onCut = (x1, y1, x2, y2) => g.cuts.some((l) => Math.abs(l.x1 - x1) < 0.15 && Math.abs(l.x2 - x2) < 0.15 && l.y1 <= y1 + 0.15 && l.y2 >= y2 - 0.15) || g.cuts.some((l) => Math.abs(l.y1 - y1) < 0.15 && Math.abs(l.y2 - y2) < 0.15 && l.x1 <= x1 + 0.15 && l.x2 >= x2 - 0.15);
    for (const c of g.cards) {
      assert.ok(onCut(c.x, c.y, c.x, c.y + c.h) && onCut(c.x + c.w, c.y, c.x + c.w, c.y + c.h) && onCut(c.x, c.y, c.x + c.w, c.y) && onCut(c.x, c.y + c.h, c.x + c.w, c.y + c.h), `${paper} card ${c.i}: every edge is a cut`);
    }
    for (const l of g.cuts) assert.ok(l.x1 >= 0 && l.x2 <= P.w && l.y1 >= 0 && l.y2 <= P.h, 'cut lines on the page');
    assert.strictEqual(g.cuts.length, 3 + 5, 'three down, five across');
  }
  assert.strictEqual(C.cardGrid('a4').paper.css, 'A4');
  assert.deepStrictEqual(['en-US', 'en-CA', 'en-GB', 'de-DE', 'fr-CA'].map(C.paperFor), ['letter', 'letter', 'a4', 'a4', 'letter']);
  const cd = D.countdown();
  assert.deepStrictEqual(C.sheets(cd).map((s) => s.length), [8, 8, 8]);
  const cards = C.cards(cd);
  assert.deepStrictEqual([cards[0].n, cards[15].title, cards[14].filler, cards[14].answer.length > 0], [1, 'School concert', 'joke', true]);
  assert.ok(cards.every((k) => k.title.length <= 50 && k.how.length <= 200 && k.needs.length <= 4));
  const f = C.fridge(cd);
  assert.strictEqual(f.weeks.length, 4, 'the fridge plan: four weeks, Monday to Sunday');
  assert.ok(f.weeks[0][0].blank && f.weeks[0][1].n === 1, 'Monday 30 Nov is blank, door 1 is Tuesday');
});

test('the recap: doors opened, done, skipped, moved and favourites; over once the last door is open or the day has passed; the card’s words fit (fitText and wrapText with a measure)', () => {
  const cd = D.countdown();
  const r = C.recap(cd, D.TODAY);
  assert.deepStrictEqual([r.over, r.doors, r.opened, r.done, r.skipped, r.moved, r.stars], [false, 24, 8, 6, 1, 1, 2]);
  assert.deepStrictEqual(r.favourites.map((x) => x.title), ['Make a paper chain', 'Put up the decorations']);
  assert.strictEqual(C.recap(cd, '2026-12-25').over, true, 'the day after the last door');
  const end = D.finished();
  const e = C.recap(end, D.END);
  assert.deepStrictEqual([e.over, e.opened, e.done, e.skipped, e.moved, e.stars], [true, 24, 20, 3, 1, 5]);
  const card = C.recapCard(end, D.END);
  assert.deepStrictEqual([card.title, card.sub, card.counts.map((x) => x.join(' '))], ['Christmas', '24 doors · December 2026', ['24 opened', '20 done', '3 skipped', '5 favourites']]);
  assert.deepStrictEqual([card.favourites.length, card.more, card.grid.length], [4, 1, 24]);
  const measure = (s) => Array.from(s).length * 20;
  assert.strictEqual(C.fitText(measure, 'Short', 200), 'Short');
  const cut = C.fitText(measure, 'A very long countdown name that will not fit', 300);
  assert.ok(measure(cut) <= 300 && cut.endsWith('…'), cut);
  const lines = C.wrapText(measure, 'one two three four five six seven eight nine ten eleven twelve', 200, 2);
  assert.ok(lines.length === 2 && lines.every((l) => measure(l) <= 200) && lines[1].endsWith('…'), JSON.stringify(lines));
  assert.ok(C.wrapText(measure, 'x'.repeat(40), 200, 2).every((l) => measure(l) <= 200), 'one long word is cut, not overflowing');
});

/* ================================================================== *
 * Two phones
 * ================================================================== */

test('two phones: a door opened on one and a day swapped on the other both survive; the merge is symmetric and idempotent; a day both phones changed keeps the later change and says so', () => {
  const base = D.countdown();
  base.updatedAt = 100;
  const since = base.doors['2026-12-08'].t + 1;
  // Phone A opens door 9 and ticks bird seed; phone B swaps doors 12 and 14 and changes the budget.
  const a = C.setStatus(C.openDoor(base, '2026-12-09', '2026-12-09', since + 10).cd, '2026-12-09', 'done', since + 11).cd;
  a.shop['bird seed'] = { got: true, t: since + 12 };
  let b = C.swap(base, '2026-12-12', '2026-12-14', { t: since + 20, force: true }).cd;
  b.setup.budget.usd = 60; b.setupT = since + 21;
  const ab = C.merge(a, b, since), ba = C.merge(b, a, since);
  assert.ok(ab.cd.doors['2026-12-09'].open && ab.cd.doors['2026-12-09'].status === 'done', 'the door opened on A');
  assert.deepStrictEqual([ab.cd.plan['2026-12-12'].a, ab.cd.plan['2026-12-14'].a], ['homemade-cards', 'stick-den'], 'the swap made on B');
  assert.strictEqual(ab.cd.shop['bird seed'].got, true);
  assert.strictEqual(ab.cd.setup.budget.usd, 60);
  assert.strictEqual(ab.both, 0, 'nothing changed on both');
  assert.ok(C.same(ab.cd, ba.cd), 'symmetric');
  assert.ok(C.same(C.merge(ab.cd, b, since).cd, ab.cd) && C.same(C.merge(ab.cd, a, since).cd, ab.cd) && C.same(C.merge(ab.cd, ab.cd, since).cd, ab.cd), 'idempotent');
  assert.ok(C.cleanCountdown(ab.cd, true).errors.length === 0);
  // The same day changed on both: the later change wins, and the note says so.
  b = C.swap(base, '2026-12-11', '2026-12-14', { t: since + 30 }).cd;
  const a2 = C.swap(base, '2026-12-11', '2026-12-12', { t: since + 40, force: true }).cd;
  const m = C.merge(a2, b, since);
  assert.strictEqual(m.cd.plan['2026-12-11'].a, 'stick-den', 'the later change');
  assert.ok(m.both >= 1 && m.notes.some((x) => /Fri 11 Dec was changed on both phones - kept the later change\./.test(x)), m.notes.join(' | '));
  assert.ok(C.same(m.cd, C.merge(b, a2, since).cd), 'symmetric on a conflict too');
  const tie = C.merge(Object.assign(clone(a2), { plan: Object.assign({}, a2.plan, { '2026-12-11': { a: 'x-tie', t: 5 } }) }), Object.assign(clone(b), { plan: Object.assign({}, b.plan, { '2026-12-11': { a: 'y-tie', t: 5 } }) }), 0);
  const tie2 = C.merge(Object.assign(clone(b), { plan: Object.assign({}, b.plan, { '2026-12-11': { a: 'y-tie', t: 5 } }) }), Object.assign(clone(a2), { plan: Object.assign({}, a2.plan, { '2026-12-11': { a: 'x-tie', t: 5 } }) }), 0);
  assert.strictEqual(tie.cd.plan['2026-12-11'].a, tie2.cd.plan['2026-12-11'].a, 'a tie breaks the same way from either side');
});

/* ================================================================== *
 * The demo
 * ================================================================== */

test('the demo’s planted story: the Fernsby family (made up, first names only) to Christmas, 1-24 Dec 2026, 21 activities, the concert as its own quick door and 2 fillers; Tuesdays and Thursdays busy; $45 with a little left', () => {
  const cd = D.countdown();
  assert.deepStrictEqual(C.cleanCountdown(clone(cd), true).errors, []);
  assert.deepStrictEqual(C.range(cd.setup).dates.length, 24);
  assert.deepStrictEqual([C.range(cd.setup).start, C.range(cd.setup).end], ['2026-12-01', '2026-12-24']);
  assert.deepStrictEqual(cd.setup.kids, [{ name: 'Wren', age: 7 }, { name: 'Otto', age: 4 }]);
  assert.deepStrictEqual([cd.setup.adults, cd.setup.busy, cd.setup.budget], [2, [2, 4], { mode: 'set', usd: 45 }]);
  const kinds = C.datesOf(cd).map((d) => C.planned(cd, d));
  assert.strictEqual(kinds.filter((a) => a.src === 'deck').length, 21);
  assert.strictEqual(kinds.filter((a) => a.filler).length, 2);
  assert.strictEqual(C.planned(cd, '2026-12-16').t, 'School concert');
  assert.strictEqual(C.planned(cd, '2026-12-16').tm, 'quick');
  assert.strictEqual(weekdayOf('2026-12-16'), 3, 'Wednesday 16');
  assert.deepStrictEqual(C.checkPlan(cd), [], 'the planted plan keeps every rule');
  assert.deepStrictEqual(C.unplaced(cd), []);
  const b = C.budget(cd);
  assert.ok(b.over === 0 && b.left > 0 && b.left <= 1000, b.word);
  assert.ok(Object.values(cd.setup).every((v) => !/Fernsby/.test(JSON.stringify(v))), 'no surname in the countdown - first names only');
  assert.strictEqual(D.FAMILY, 'The Fernsby family');
  assert.ok(read('CLAUDE.md').includes('Fernsby') && /web search/i.test(read('CLAUDE.md')), 'the surname check is recorded');
});

test('the demo’s clock is Wednesday 9 December 2026, 6:15 pm: doors 1-8 open (six done with drawn photos, door 7 skipped, door 6 moved to Sunday 13), door 9 today and shut, the shopping partly ticked with bird seed due tomorrow', () => {
  const cd = D.countdown(), t = D.TODAY;
  assert.deepStrictEqual([t, weekdayOf(t), C.clock(D.NOW.h, D.NOW.m)], ['2026-12-09', 3, '6:15\u00A0pm']);
  const st = C.datesOf(cd).slice(0, 9).map((d) => [C.door(cd, d, t).state, (cd.doors[d] || {}).status || '']);
  assert.deepStrictEqual(st, [['open', 'done'], ['open', 'done'], ['open', 'done'], ['open', 'done'], ['open', 'done'], ['open', 'moved'], ['open', 'skipped'], ['open', 'done'], ['today', '']]);
  assert.strictEqual(cd.doors['2026-12-06'].to, '2026-12-13');
  assert.strictEqual(C.planned(cd, '2026-12-13').id, 'salt-dough', 'the moved one is on the 13th');
  const done = C.datesOf(cd).filter((d) => (cd.doors[d] || {}).status === 'done');
  assert.deepStrictEqual(Object.keys(D.PHOTOS).sort(), done.sort(), 'a drawn photo for each done door');
  for (const p of Object.values(D.PHOTOS)) assert.match(p, /^data:image\/svg\+xml;charset=utf-8,/);
  const s = C.shopping(cd, t);
  const unticked = s.items.filter((x) => !x.got);
  assert.deepStrictEqual(s.items.filter((x) => x.due).map((x) => [x.key, x.due]), [['bird seed', 'tomorrow']]);
  assert.ok(s.items.filter((x) => C.dayOf(x.by) <= C.dayOf(t)).every((x) => x.got), 'everything due by today is bought');
  assert.ok(s.got > 0 && unticked.length > 1, 'partly ticked');
  // The tour: five steps, in order, then "Make our calendar".
  const app = read('public/app.js');
  const views = [...app.matchAll(/\{ view: '(\w+)', title: '([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(views, ['doors', 'plan', 'shop', 'doors', 'print']);
  assert.match(app, /title: 'Kid mode on this phone'[^}]*kid: true/);
  assert.match(app, /next: 'Make our calendar'/);
  // The example is never kept, sent or synced.
  assert.match(app, /function commit\(next, quiet\) \{\n\s*if \(state\.demo\) state\.demoCd = next;\n\s*else \{/);
  assert.match(app, /if \(!signedIn\(\) \|\| !state\.me\.sync \|\| state\.demo\) return;/);
  // The example's AI answer passes the real checks, labelled as an example.
  const ex = C.cleanIdeas(D.IDEAS_RAW, C.ideasRequest(D.IDEAS_REQ).req);
  assert.deepStrictEqual([ex.ideas.length, ex.dropped], [6, 0]);
  assert.match(app, /Made-up example answer - ' : ''\) \+ 'AI-written - check they suit your family/);
});

/* ================================================================== *
 * Hostile text, and the one door
 * ================================================================== */

test('hostile text: markup and bidi cleaned; an @ in any width, nine digits, a link or markup refused whole by the server check; phone numbers, links and formulas caught; a kid’s name is letters only', () => {
  for (const s of ['a' + AT + 'b', 'mail me ' + FW_AT + ' home', 'x' + SMALL_AT + 'y']) assert.ok(C.hasAt(s), s);
  for (const s of ['https://x.example', 'see www.crafts.example', 'crafts.com', 'ftp://x']) assert.ok(C.hasLink(s), s);
  for (const s of ['call 0800 555 0199', '+44 20 7946 0000', '(555) 123-4567']) assert.ok(C.hasPhone(s), s);
  for (const s of ['=SUM(A1)', '+1', '@x', '-2+3']) assert.ok(C.isFormula(s), s);
  for (const s of ['Bake 12 biscuits', 'Ages 3-12', 'Door 24']) assert.ok(!C.hasPhone(s) && !C.hasLink(s) && !C.hasAt(s), s);
  assert.ok(C.nineDigits('123456789') && C.nineDigits(ch(0xFF11).repeat(9)) && !C.nineDigits('12345678'), 'nine digits in any width');
  assert.ok(C.nineDigits(ch(0x0661).repeat(9)) && C.nineDigits(ch(0x0967).repeat(9)) && C.hasPhone('call ' + ch(0x0660).repeat(3) + ' ' + ch(0x0661).repeat(4)), 'and in any script (found in the hostile pass: Arabic-Indic digits got through)');
  assert.strictEqual(C.line('<b>Hi</b> ' + RLO + 'there' + ZWSP + '  you'), 'Hi there you');
  const cd = D.countdown();
  const bad = [
    ['an unknown field', (x) => { x.photos = ['data:image/jpeg;base64,AAAA']; }],
    ['a nested unknown field', (x) => { x.setup.surname = 'Smith'; }],
    ['an @', (x) => { x.setup.pins[0].title = 'Concert ' + AT + ' school'; }],
    ['a full-width @', (x) => { x.setup.kids[0].name = 'Wren' + FW_AT + 'x'; }],
    ['nine digits', (x) => { x.setup.pins[0].title = 'Ring 020794600'; }],
    ['nine Arabic-Indic digits', (x) => { x.setup.pins[0].title = 'Ring ' + ch(0x0662).repeat(9); }],
    ['a link', (x) => { x.deck.custom = [own('c-aaaaaaaa', 'crafts', { t: 'See crafts.example.com' })]; }],
    ['markup', (x) => { x.setup.name = '<img src=x>'; }],
    ['bidi', (x) => { x.setup.kids[0].name = 'Wr' + RLO + 'en'; }],
  ];
  for (const [what, f] of bad) {
    const x = clone(cd); f(x);
    assert.ok(C.bodyProblem(x) || C.cleanCountdown(x, true).errors.length, what);
  }
  const names = clone(cd); names.setup.kids[0].name = 'R2D2';
  assert.ok(C.cleanCountdown(names, true).errors.some((e) => /letters only/.test(e)), 'a name is letters only');
  const tooMany = clone(cd); tooMany.deck.custom = Array.from({ length: 41 }, (_, i) => own('c-' + String(i).padStart(8, 'a'), 'crafts'));
  assert.ok(C.cleanCountdown(tooMany, true).errors.some((e) => /up to 40/.test(e)), 'over a limit');
  const lenient = C.cleanCountdown(Object.assign(clone(cd), { extra: 1, setup: Object.assign(clone(cd.setup), { name: '<b>Xmas</b>' + RLO }) })).countdown;
  assert.ok(!('extra' in lenient) && lenient.setup.name === 'Xmas', 'the lenient door mends instead');
  assert.deepStrictEqual(C.cleanCountdown('nope', true).errors[0], 'Send a countdown.');
});

/* ================================================================== *
 * Storage
 * ================================================================== */

function fakeIdb(mode) {
  const data = { kv: new Map(), photos: new Map() };
  const later = (fn) => setTimeout(fn, 0);
  return {
    data,
    open() {
      const req = {};
      later(() => {
        if (mode === 'blocked') { req.error = new Error('blocked'); if (req.onerror) req.onerror(); return; }
        req.result = {
          createObjectStore() {},
          transaction(store) {
            const tx = {};
            const op = (fn, write) => { const r = {}; later(() => { if (write && mode === 'full') { tx.error = new Error('QuotaExceededError'); if (tx.onerror) tx.onerror(); return; } r.result = fn(); if (r.onsuccess) r.onsuccess(); if (tx.oncomplete) tx.oncomplete(); }); return r; };
            tx.objectStore = () => ({
              get: (k) => op(() => data[store].get(k)),
              put: (v, k) => op(() => { data[store].set(k, JSON.parse(JSON.stringify(v))); }, true),
              delete: (k) => op(() => { data[store].delete(k); }, true),
              getAllKeys: () => op(() => [...data[store].keys()]),
              clear: () => op(() => { data[store].clear(); }, true),
            });
            return tx;
          },
        };
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}
const JPEG = 'data:image/jpeg;base64,' + Buffer.from('a little jpeg').toString('base64');

test('storage: one module; countdowns through the one door, up to three; device flags and sync bases checked; photos only as JPEG data URLs, on this phone; IndexedDB wrapped - blocked or full falls back to memory and says so', async () => {
  const s = AS.create(AS.idb('ajar-test', fakeIdb('ok')));
  assert.strictEqual(s.persistent(), true);
  const cd = D.countdown();
  await s.putCountdowns([cd, Object.assign(clone(cd), { id: 'secondcdxx' }), Object.assign(clone(cd), { id: 'thirdcdxxx' }), Object.assign(clone(cd), { id: 'fourthcdxx' })]);
  const back = await s.getCountdowns();
  assert.strictEqual(back.length, 3, 'up to three');
  assert.ok(C.same(back[0], C.cleanCountdown(cd).countdown), 'a round trip through the door');
  await s.putDevice({ tour: true, kid: 'yes', paper: 'a4', extra: 1 });
  assert.deepStrictEqual(await s.getDevice(), { tour: true, kid: false, paper: 'a4', photoLine: false });
  await s.putSync({ demofernsb: { base: 5, at: 6 }, 'bad id': { base: 1 } });
  assert.deepStrictEqual(await s.getSync(), { demofernsb: { base: 5, at: 6 } });
  assert.strictEqual(await s.photoPut(cd.id, '2026-12-01', { full: JPEG, thumb: JPEG, at: 1 }), true);
  assert.strictEqual(await s.photoPut(cd.id, '2026-12-02', { full: 'https://x.example/p.jpg', thumb: JPEG }), false, 'only a data URL from this phone');
  assert.strictEqual(await s.photoPut(cd.id, '2026-12-02', { full: 'data:image/png;base64,AAAA', thumb: JPEG }), false, 'only the canvas’s JPEG');
  assert.strictEqual(await s.photoPut(cd.id, 'not-a-day', { full: JPEG, thumb: JPEG }), false);
  assert.deepStrictEqual(await s.photoDays(cd.id), ['2026-12-01']);
  assert.strictEqual((await s.photoGet(cd.id, '2026-12-01')).full, JPEG);
  await s.photoClear(cd.id);
  assert.deepStrictEqual(await s.photoDays(cd.id), []);
  // Blocked (a private window): memory, and the page is told.
  const blocked = AS.create(AS.idb('ajar-test', fakeIdb('blocked')));
  await blocked.putCountdowns([cd]);
  assert.strictEqual((await blocked.getCountdowns()).length, 1, 'still works in this tab');
  assert.strictEqual(await blocked.photoPut(cd.id, '2026-12-01', { full: JPEG, thumb: JPEG }), true);
  assert.strictEqual((await blocked.photoGet(cd.id, '2026-12-01')).thumb, JPEG);
  assert.strictEqual(blocked.persistent(), false);
  // Full: the write fails, memory keeps it, and reading back returns it.
  const fullIdb = fakeIdb('full');
  const full = AS.create(AS.idb('ajar-test', fullIdb));
  await full.putCountdowns([cd]);
  assert.strictEqual((await full.getCountdowns())[0].id, cd.id, 'a failed write is still read back');
  assert.strictEqual(full.persistent(), false);
  assert.strictEqual(fullIdb.data.kv.size, 0);
  await full.photoPut(cd.id, '2026-12-03', { full: JPEG, thumb: JPEG });
  assert.deepStrictEqual(await full.photoDays(cd.id), ['2026-12-03']);
  // No IndexedDB at all.
  const none = AS.create(AS.idb('ajar-test', null));
  await none.putCurrent(cd.id);
  assert.strictEqual(await none.getCurrent(), cd.id);
  const src = read('public/ajar-store.js');
  assert.ok(!/Math\.random|Date\.now\(\)|new Date\(|fetch\(|localStorage|sessionStorage/.test(src), 'the store keeps things and does nothing else');
});

/* ================================================================== *
 * The look, the page's promises, the copy
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes and on every calendar look; the hero and the lab card too; 44px targets (kid mode bigger); nothing scrolls sideways', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  assert.deepStrictEqual(Object.keys(dark).sort(), Object.keys(light).sort(), 'every token has a dark value');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2', 'code-bg', 'bar-bg', 'sticky', 'accent-soft', 'warn-bg', 'ok-bg', 'bad-bg', 'info-bg']) ok('text', bg);
    for (const bg of ['bg', 'card', 'card2', 'sticky', 'accent-soft']) { ok('muted', bg); ok('link', bg); }
    ok('link', 'warn-bg'); ok('link', 'ok-bg'); ok('link', 'info-bg'); ok('link', 'bad-bg'); ok('muted', 'warn-bg'); ok('warn', 'bg'); ok('ok', 'bg'); ok('bad', 'bg');
    ok('accent-ink', 'accent'); ok('bg', 'ok');
    for (const k of ['bad', 'warn', 'info', 'ok']) { ok(k, `${k}-bg`); ok(k, 'card'); ok(k, 'card2'); }
    ok('ink2', 'card'); ok('accent', 'card', 3); ok('bg', 'text');
  }
  const looks = {};
  for (const [, name, body] of css.matchAll(/\.look-(\w+) \{([^}]*)\}/g)) { looks[name] = {}; for (const [, k, v] of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) looks[name][k] = v; }
  assert.deepStrictEqual(Object.keys(looks).sort(), C.LOOKS.slice().sort(), 'every look is painted');
  for (const [name, l] of Object.entries(looks)) {
    for (const [fg, bg] of [['door-ink', 'door'], ['cal-ink', 'cal'], ['cal-ink', 'cal2'], ['open-ink', 'open'], ['door-ink', 'open']]) assert.ok(ratio(l[fg], l[bg]) >= 4.5, `look ${name}: ${fg} on ${bg} ${ratio(l[fg], l[bg]).toFixed(2)}`);
  }
  for (const bg of ['#8f300f', '#a8360f', '#3730a3']) for (const fg of ['#ffffff', '#fff1e8', '#ffe2d1']) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  assert.ok(ratio('#5a1a06', '#fff1e8') >= 4.5);
  for (const [fg, bg] of [['#111111', '#ffffff'], ['#444444', '#ffffff'], ['#555555', '#ffffff'], ['#8a2d0a', '#ffffff'], ['#6b4a00', '#fff3d1'], ['#111111', '#fff3d1'], ['#666666', '#f2f2f2']]) assert.ok(ratio(fg, bg) >= 4.5, `print ${fg} on ${bg}`);
  assert.match(css, /\.hero \{[^}]*linear-gradient\(150deg, #8f300f 0%, #a8360f 35%, #3730a3 100%\)/);
  for (const sel of ['.btn', '.link-btn', '.seg2 button', '.chip', '.input, textarea.input, select.input', '.check', '.wd', '.dsel', '.pinbtn', '.morebtn', '.tpl']) assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-(height|width): (4[4-9]|5\\d|6\\d)px').test(css), `${sel}: 44px`);
  assert.ok(/\.door \{[^}]*min-height: 64px/.test(css) && /\.kidcal \.door \{[^}]*min-height: 96px/.test(css) && /\.kid-choices button \{[^}]*min-height: 72px/.test(css) && /\.kid-exit \{[^}]*min-height: 48px/.test(css), 'kid mode targets are bigger');
  assert.ok(/\.chipx button \{[^}]*min-width: 44px; min-height: 44px/.test(css) && /\.shoprow \{[^}]*min-height: 56px/.test(css) && /\.dtick \.box \{[^}]*width: 44px; height: 44px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css) && /\.tablewrap \{[^}]*overflow: auto/.test(css));
  assert.ok(/@media \(prefers-reduced-motion: reduce\) \{\n {2}\*, \*::before, \*::after \{ animation: none !important; transition: none !important;/.test(css), 'reduced motion: nothing swings, wiggles or bursts');
  assert.ok(/@media print \{[\s\S]*body > \*:not\(#print\) \{ display: none !important; \}[\s\S]*#stc-verify-banner, #live \{ display: none !important; \}/.test(css), 'print shows #print only - never the live region');
  const lab = require('../../../lab').get('ajar');
  assert.ok(lab, 'Ajar is in lab.js');
  assert.deepStrictEqual([lab.color, lab.color2, lab.dropped, lab.status, lab.emoji], ['#c2410c', '#4338ca', '2026-11-20', 'testing', '\u{1F31F}']);
  assert.ok(ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const stop of ['#036a7f', '#74275f', '#0f5f48', '#a3222f', '#4b5a1e', '#1c3d78', '#8a5300', '#3a3196', '#1e293b', '#0369a1', '#5b2a6e', '#7a4a1c']) {
    assert.ok(labDist(lab.color, stop) >= 20 && labDist(lab.color2, stop) >= 20, `away from ${stop}: ${labDist(lab.color, stop).toFixed(1)} / ${labDist(lab.color2, stop).toFixed(1)}`);
  }
});

test('the page: relative links, no inline script or handlers, the banner, storage only through ajar-store.js, no clock or dice in the core, the deck or the demo, the requests it makes and what they carry, every received string escaped, no email, phone or address fields, the recap never a link', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  assert.ok(html.indexOf('<div class="print" id="print"') > 0 && /<body[^>]*>[\s\S]*\n {2}<div class="print" id="print" aria-hidden="true"><\/div>\n/.test(html), 'the print view sits straight inside body, never inside something hidden');
  assert.ok(html.includes('\u{1F31F}') && !html.includes('\u{1F31F}\u{FE0F}'), 'the glowing star, no variation selector');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(js), 'the page touches no storage itself');
  assert.ok(!/\.backend\.(put|get|del)/.test(js), 'nor the store’s backend');
  assert.match(js, /Intl\.getCanonicalLocales\(navigator\.language \|\| 'en-US'\)\[0\] \|\| 'en-US'; \} catch \(e\) \{ return 'en-US'; \}/);
  for (const f of ['public/ajar-core.js', 'public/ajar-deck.js', 'public/demo.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon|indexedDB|WebSocket/.test(src), `${f} touches no network or storage`);
    assert.ok(!/Math\.random|Date\.now\(\)|new Date\(/.test(src), `${f} has no dice and no clock`);
  }
  const all = js + read('public/ajar-core.js') + read('public/demo.js') + read('public/ajar-store.js');
  assert.ok(!/eval\(|new Function|setTimeout\(['"]/.test(all), 'no eval of any kind');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/ideas', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/countdowns', 'api/countdowns/', 'api/me'].sort(), 'the page asks for nothing else - no route takes a photo');
  assert.strictEqual((js.match(/\bfetch\(/g) || []).length, 2, 'two fetches: api() and the verify resend');
  assert.match(js, /var btn = \$\('#aiSend', root\), sent = C\.ideasPayload\(cd\(\), state\.ai\.likes, state\.ai\.count\);/);
  assert.match(js, /api\('POST', 'api\/ai\/ideas', sent\)/, 'the AI call sends the payload, and nothing else');
  assert.match(js, /payload = C\.ideasPayload\(c, state\.ai\.likes, state\.ai\.count\)/);
  assert.match(js, /esc\(sentText\(payload\)\)/, 'what is shown is the same payload');
  assert.match(js, /the kids’ ages, the chips you picked, your budget and the month - never names, never your own ideas/);
  assert.match(js, /api\('PUT', 'api\/countdowns\/' \+ id, \{ countdown: bodyOf\(c\), base:/, 'sync sends the countdown and a base');
  // No field that asks for an email, a phone, an address, a school or a surname - except signing in.
  assert.strictEqual((js.match(/type="email"/g) || []).length, 1, 'only the sign-in form asks for an email');
  assert.ok(/function openAccount[\s\S]*type="email"[\s\S]*function openAccountSheet/.test(js));
  assert.ok(!/type="tel"|autocomplete="(tel|street-address|address-line1|postal-code|family-name)"|placeholder="[^"]*(address|phone|surname)/i.test(js + html));
  assert.match(js, /First names or nicknames only/);
  // The recap card: a file, never a link, never uploaded.
  const share = /case 'sharecard': \{[\s\S]*?break;\n {6}\}/.exec(js)[0];
  assert.ok(/navigator\.share\(\{ files: \[file\], title: C\.bigName\(cd\(\)\.setup\) \}\)/.test(share) && !/url:/.test(share) && !/api\(/.test(share), 'shared as a file');
  assert.match(js, /if \(canShareFiles\(\)\) navigator\.share[\s\S]{0,200}else download\(name, 'image\/png', rc\.blob\)/);
  assert.match(js, /data-recap="photo"' \+ \(state\.recap\.photo \? ' checked' : ''\)/, 'the photo is off unless ticked');
  assert.match(js, /recap: \{ photo: false, blob: null, url: null \}/);
  // Photos: shrunk through a canvas, kept here, never sent.
  assert.match(js, /redraw\(img, 1280, 0\.8\), thumb = redraw\(img, 320, 0\.7\)/);
  assert.match(js, /real\.photoPut\(state\.curId, d, p\)/);
  assert.match(js, /Photos stay on this phone - shrunk, with the location taken out\. Never sent, never synced\./);
  // Every interpolation of something a person, the server or a model wrote goes through esc().
  const strip = (src) => { let out = ''; let i = 0; const re = /\besc\(/g; let m; while ((m = re.exec(src))) { if (m.index < i) continue; out += src.slice(i, m.index) + 'SAFE'; let depth = 0, j = m.index + m[0].length - 1; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; re.lastIndex = i; } return out + src.slice(i); };
  const risky = strip(js).split('\n').filter((l) => /</.test(l) && !/toast\(|confirm\(|prompt\(|copy\(|download\(|textContent|say\(/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(?!SAFE\b)([a-zA-Z_$][\w$]*(?:\.[\w$]+|\[[^\]]+\])*(?:\([^()]*\))?)\s*\+/g);
  const allowed = (r) => /\+\s*(?:[a-zA-Z]*Html(?:\([^()]*\))?|html|deco|grid|photos|rows|openedHtml|dueHtml|tonight|filters|head|tools|body|foot|intro|form|sent|chips|kidRows|wd|bdates|pins|costRows|groups|guideHtml\([^()]*\)|demoRibbon\(\)|mergeNoteHtml\(\)|refusalHtml\(\)|reportHtml\(\)|syncLine\(\)|calHtml\([^()]*\)|behindHtml\([^()]*\)|tagsHtml\([^()]*\)|needsHtml\([^()]*\)|photoLine\(\)|chipGroup\([^()]*\)|segHtml\([^()]*\)|tplCard\([^()]*\)|doorBtn\([^()]*\)|mockCalHtml\(\)|swipeHtml\(\)|listHtml\(\)|cardsSheetHtml\([^()]*\)|fridgeHtml\([^()]*\)|plural\([^()]*\)|a|n|i|m|k|due|cls|lab)\s*\+/.test(r);
  const bad = (risky || []).filter((r) => !allowed(r));
  assert.deepStrictEqual(bad, [], `unescaped: ${bad}`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bbrief\b|\bcountdown\b|\bpayload\b)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /ajar-shell-v1/.test(sw) && ['ajar-core.js', 'ajar-deck.js', 'ajar-store.js', 'demo.js', 'app.js'].every((f) => sw.includes(`'${f}'`)) && /k\.indexOf\('ajar-'\) === 0/.test(sw), 'the service worker caches only the app shell, never api/, and only clears its own caches');
  assert.ok(/if \(!nav && SHELL\.indexOf\(rel\) < 0\) return;/.test(sw));
  assert.match(js, /navigator\.serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
  // A route change must not close the sheet it just opened, and the tour's after-hook runs last.
  assert.match(js, /function go\(view, after\) \{\n\s*history\.pushState\(null, '', BASE \+ '#' \+ view\);\n\s*route\(\); scrollTo\(0, 0\);\n\s*if \(after\) after\(\);\n\s*\}/);
});

test('the copy: no brand, shop, film, show, book, song or character names in any file; no invisible characters; no key-shaped strings; no email address; one model constant', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.name === 'node_modules' ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const files = walk(ROOT).filter((x) => /\.(js|css|html|md|json|svg|webmanifest)$/.test(x) && !/package-lock/.test(x));
  assert.ok(files.length >= 20);
  // Built from pieces, so this file does not carry the words it looks for.
  // Ordinary words are checked only with their capital, as a title is written.
  const marks = [['Le', 'go'], ['Play', 'mobil'], ['Bar', 'bie'], ['Hot ', 'Wheels'], ['Play-', 'Doh'], ['Cray', 'ola'], ['Fisher-', 'Price'], ['Has', 'bro'], ['Mat', 'tel'],
    ['Hers', 'hey'], ['Cad', 'bury'], ['Nest', 'l'], ['Ore', 'o'], ['Hari', 'bo'], ['Skit', 'tles'], ['Smar', 'ties'], ['Lin', 'dt'], ['Ferr', 'ero'], ['Kit ', 'Kat'], ['Nu', 'tella'], ['Coca-', 'Cola'], ['Pep', 'si'], ['Star', 'bucks'], ['Swiss ', 'Miss'], ['Cri', 'cut'],
    ['Wal', 'mart'], ['Cost', 'co'], ['Tes', 'co'], ['Hobby ', 'Lobby'], ['IK', 'EA'], ['Et', 'sy'], ['Hobby', 'craft'], ['Al', 'di'], ['Li', 'dl'], ['Insta', 'cart'], ['Door', 'Dash'], ['Fed', 'Ex'], ['Deliv', 'eroo'],
    ['Rud', 'olph'], ['Fros', 'ty'], ['Grin', 'ch'], ['Polar ', 'Express'], ['Home ', 'Alone'], ['Ola', 'f'], ['El', 'sa'], ['Padd', 'ington'], ['Gruff', 'alo'], ['Pep', 'pa'], ['Blu', 'ey'], ['Dis', 'ney'], ['Pix', 'ar'], ['Scroo', 'ge'], ['Harry ', 'Potter'], ['Nar', 'nia'], ['Mup', 'pet'], ['Poke', 'mon'], ['Mine', 'craft'], ['Paw ', 'Patrol'], ['Snoo', 'py'], ['Jingle ', 'Bells'], ['Nut', 'cracker'], ['Elf on the ', 'Shelf'], ['Shelf ', 'Elf'], ['San', 'ta'],
    ['Net', 'flix'], ['Hu', 'lu'], ['You', 'Tube'], ['Spot', 'ify'], ['Prime ', 'Video'], ['Dis', 'neyland'], ['Le', 'goland'], ['Universal ', 'Studios'], ['Six ', 'Flags'],
    ['Fro', 'zen'], ['Tar', 'get'], ['Ama', 'zon'], ['Mich', 'aels'], ['Kin', 'der']].map((p) => p.join(''));
  const markRe = new RegExp('(^|[^A-Za-z])(' + marks.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![A-Za-z])');
  assert.ok(markRe.test('a box of ' + marks[0] + ' bricks') && !markRe.test('aim for the target, frozen peas, kinder words') && C.namesBrand('build a ' + marks[0] + ' town') && !C.namesBrand('Make a paper chain'), 'the checks bite, and only where they should');
  const SESSION_LINK = new RegExp(['claude', 'ai/code'].join('\\.') + '|' + ['Claude', 'Session'].join('-'));
  const invisible = new RegExp('[' + [[0, 8], [11, 12], [14, 31], [0x7F, 0x9F], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2069], [0xFEFF, 0xFEFF]].map(([a, b]) => '\\u' + a.toString(16).padStart(4, '0') + '-\\u' + b.toString(16).padStart(4, '0')).join('') + ']');
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8'), rel = path.relative(ROOT, f);
    assert.ok(!invisible.test(src), `${rel} carries an invisible character`);
    if (!/lib\/(identity|stripe|byok|webauthn)/.test(f)) assert.ok(!/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\bsk-ant-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(src), `${rel} carries a key-shaped string`);
    if (!/^public\/(passkey-client|verify-banner|desktop)\.|^lib\/(identity|stripe|byok|webauthn|identity-store)\.js$/.test(rel)) {
      assert.ok(!markRe.test(src), `${rel} names a brand or title: ${(markRe.exec(src) || [])[2]}`);
      assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(src), `no email address in ${rel}`);
      assert.ok(!SESSION_LINK.test(src), `no session link in ${rel}`);
    }
  }
  const strings = JSON.stringify([D.countdown(), D.PHOTOS, D.IDEAS_RAW, DK]);
  assert.ok(!invisible.test(strings) && !markRe.test(strings), 'nor in what the demo and the deck make');
  const models = files.filter((f) => /claude-(haiku|sonnet|opus)/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f)).filter((f) => !/^lib\/identity/.test(f));
  assert.deepStrictEqual(models, ['server.js'], 'model names only in the MODELS constant');
  assert.ok(read('server.js').includes(`const MODELS = { free: '${FREE_MODEL}', paid: '${PAID_MODEL}' };`));
  assert.strictEqual((read('server.js').match(/claude-[a-z]+-[0-9]/g) || []).length, 2, 'once each');
});

test('local-only switches throw on Cloud Run; the lab prefix is read; one document per account, read by its id', () => {
  for (const [mod, env] of [['./lib/store', { AJAR_MEMORY: '1' }], ['./lib/fakeai', { AJAR_FAKE_AI: '1' }], ['./server', { AJAR_FAKE_AI: '1', AJAR_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, AJAR_MEMORY: '', AJAR_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, AJAR_MEMORY: '', AJAR_COLLECTION_PREFIX: 'ajar_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'ajar_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.ok(!/store\.list\(|orderBy/.test(server), 'no query: one document per account, by its id');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g))].sort(), ["store.get('calendars'", "store.transact('calendars'"]);
});

/* ================================================================== *
 * Over HTTP
 * ================================================================== */

let base;
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
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const t = await res.text();
    let data = {}; try { data = JSON.parse(t); } catch (e) { data = { text: t }; }
    return { status: res.status, data, text: t, headers: res.headers };
  };
}
const mail = (who) => `${who}${AT}example.com`;
const uidOf = (email) => Buffer.from(email).toString('base64url');
async function register(who) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const BIG = { x: 'x'.repeat(200 * 1024) };
const body = (cd) => { const b = clone(cd); delete b.updatedAt; return b; };
function restamp(cd, t) {
  const x = clone(cd);
  x.setupT = t; x.deckT = t;
  for (const f of ['plan', 'doors', 'shop']) for (const k of Object.keys(x[f])) x[f][k].t = t;
  return x;
}
const ideasBody = () => C.ideasPayload(D.countdown(), ['crafts', 'outdoors'], 6);

test('signed out: the page, the core, the deck, the demo and the store load with zero model calls; sync and the AI answer 401 before reading a body; there is no route that takes a photo', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.likes, meta.themes, meta.deck], [C.LIKES, C.THEMES, C.DECK.length]);
  for (const f of ['ajar-core.js', 'ajar-deck.js', 'ajar-store.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/countdowns'], ['PUT', '/api/countdowns/demofernsb'], ['DELETE', '/api/countdowns/demofernsb'], ['POST', '/api/ai/ideas']]) assert.strictEqual((await anon(m, p, m === 'GET' || m === 'DELETE' ? undefined : { ok: 1 })).status, 401, `${m} ${p}`);
  for (const [m, p] of [['PUT', '/api/countdowns/demofernsb'], ['POST', '/api/ai/ideas']]) assert.strictEqual((await anon(m, p, BIG)).status, 401, `${p}: the gate answers before the parser, so never 413`);
  for (const p of ['/api/photos', '/api/photo', '/api/upload', '/api/recap', '/api/share', '/api/cards', '/api/print']) assert.strictEqual((await anon('POST', p, { photo: JPEG })).status, 404, `${p}: no route takes a photo`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('writes come from this page: another site’s request (Sec-Fetch-Site or Origin) is 403 and a body that is not JSON 415, before anything else', async () => {
  const ana = await register('ana.sameorigin');
  const cd = body(D.countdown());
  assert.strictEqual((await ana('PUT', '/api/countdowns/demofernsb', { countdown: cd, base: null }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await ana('PUT', '/api/countdowns/demofernsb', { countdown: cd, base: null }, { 'Sec-Fetch-Site': 'same-site' })).status, 403, 'a sibling subdomain is another site here');
  assert.strictEqual((await ana('PUT', '/api/countdowns/demofernsb', { countdown: cd, base: null }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await ana('POST', '/api/ai/ideas', ideasBody(), { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await ana('PUT', '/api/countdowns/demofernsb', 'countdown=1', { 'Content-Type': 'text/plain' })).status, 415);
  assert.strictEqual((await ana('DELETE', '/api/countdowns/demofernsb', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const same = await ana('PUT', '/api/countdowns/demofernsb', { countdown: cd, base: null }, { 'Sec-Fetch-Site': 'same-origin', Origin: base.replace(/\/ajar$/, '') });
  assert.strictEqual(same.status, 200, same.text);
});

test('the gates come before each parser, in order; one model call site; Haiku free, Sonnet members via planFor; max_tokens from the limits', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/ideas', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/countdowns/:id', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js'), ai = read('lib/ai.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((ai.match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(ai, /tool_choice: \{ type: 'tool', name: tool\.name \}/);
  assert.match(ai, /max_tokens: 300 \+ 200 \* req\.count,/);
  assert.match(ai, /300 \+ 200 x 12 = 2,700/, 'the arithmetic is shown');
});

test('sync: a countdown follows the account to the other phone; a stale phone gets 409 with the account copy and merges; up to three; bodies refused whole; filed under an HMAC; never a photo', async () => {
  const a = await register('parent.one');
  assert.deepStrictEqual((await a('GET', '/api/countdowns')).data.countdowns, []);
  // The example's times are its own December; a real phone stamps with its clock.
  const cd = restamp(D.countdown(), Date.now() - 60000);
  const put = await a('PUT', `/api/countdowns/${cd.id}`, { countdown: body(cd), base: null });
  assert.strictEqual(put.status, 200, put.text);
  const v1 = put.data.countdown.updatedAt;
  assert.ok(C.same(Object.assign(clone(put.data.countdown), { updatedAt: 0 }), Object.assign(C.cleanCountdown(cd).countdown, { updatedAt: 0 })), 'saved as sent');
  // The other parent's phone.
  const b = client();
  assert.strictEqual((await b('POST', '/api/auth/login', { email: mail('parent.one'), password: 'a long enough password' })).status, 200);
  const onB = (await b('GET', '/api/countdowns')).data.countdowns[0];
  assert.strictEqual(onB.updatedAt, v1);
  // B swaps two days and saves; A opens door 9 against the old version.
  const bEdit = C.swap(onB, '2026-12-12', '2026-12-14', { t: Date.now(), force: true }).cd;
  const savedB = await b('PUT', `/api/countdowns/${cd.id}`, { countdown: body(bEdit), base: v1 });
  assert.strictEqual(savedB.status, 200, savedB.text);
  const aEdit = C.openDoor(cd, '2026-12-09', '2026-12-09', Date.now() + 5).cd;
  const stale = await a('PUT', `/api/countdowns/${cd.id}`, { countdown: body(aEdit), base: v1 });
  assert.deepStrictEqual([stale.status, stale.data.code], [409, 'conflict']);
  assert.strictEqual(stale.data.countdown.plan['2026-12-12'].a, 'homemade-cards', 'the 409 carries the account copy');
  const merged = C.merge(aEdit, stale.data.countdown, v1 - 1).cd;
  const again = await a('PUT', `/api/countdowns/${cd.id}`, { countdown: body(merged), base: stale.data.countdown.updatedAt });
  assert.strictEqual(again.status, 200, again.text);
  const final = (await b('GET', '/api/countdowns')).data.countdowns[0];
  assert.ok(final.doors['2026-12-09'].open && final.plan['2026-12-12'].a === 'homemade-cards', 'the door and the swap both survived');
  assert.strictEqual((await a('PUT', `/api/countdowns/${cd.id}`, { countdown: body(merged), base: null })).status, 409, 'a phone that never synced cannot overwrite');
  // Up to three.
  for (const id of ['secondcdab', 'thirdcdabc']) assert.strictEqual((await a('PUT', `/api/countdowns/${id}`, { countdown: Object.assign(body(cd), { id }), base: null })).status, 200);
  const full = await a('PUT', '/api/countdowns/fourthcdab', { countdown: Object.assign(body(cd), { id: 'fourthcdab' }), base: null });
  assert.deepStrictEqual([full.status, full.data.code], [409, 'full']);
  // Refused whole.
  const cur = (await a('GET', '/api/countdowns')).data.countdowns.find((x) => x.id === cd.id);
  const variants = [
    (x) => { x.photos = { '2026-12-01': JPEG }; },
    (x) => { x.setup.kids[0].email = mail('wren'); },
    (x) => { x.setup.pins[0].title = 'Concert ' + FW_AT + ' school'; },
    (x) => { x.setup.pins[0].title = 'Call 020794600'; },
    (x) => { x.deck.custom = [own('c-aaaaaaaa', 'crafts', { h: 'See https://crafts.example/winter' })]; },
    (x) => { x.setup.name = '<script>alert(1)</script>'; },
    (x) => { x.setup.kids[0].name = 'Wren' + RLO; },
    (x) => { x.deck.custom = Array.from({ length: 41 }, (_, i) => own('c-' + String(i).padStart(8, 'b'), 'crafts')); },
    (x) => { x.id = 'secondcdab'; },
  ];
  for (const f of variants) {
    const x = body(cur); f(x);
    const r = await a('PUT', `/api/countdowns/${cd.id}`, { countdown: x, base: cur.updatedAt });
    assert.strictEqual(r.status, 400, f.toString().slice(0, 80) + ' ' + r.text);
  }
  assert.strictEqual((await a('PUT', `/api/countdowns/${cd.id}`, { countdown: body(cur), base: cur.updatedAt, photo: JPEG })).status, 400, 'nothing beside the countdown and its base');
  assert.strictEqual((await a('PUT', `/api/countdowns/${cd.id}`, BIG)).status, 413, 'over the limit, after the sign-in');
  assert.strictEqual((await a('PUT', '/api/countdowns/..%2F..%2Fx', { countdown: body(cur), base: null })).status, 404);
  assert.strictEqual((await a('GET', '/api/countdowns')).data.countdowns.find((x) => x.id === cd.id).updatedAt, cur.updatedAt, 'nothing was saved');
  // What is stored.
  const dump = store._dump();
  assert.ok(!dump.includes('parent.one') && !dump.includes(uidOf(mail('parent.one'))), 'filed under an HMAC, never the account id or address');
  assert.ok(!/020794600|crafts\.example|base64,/.test(dump), 'nothing from a refused body, and no photo');
  assert.ok(dump.includes(ownerTag(uidOf(mail('parent.one')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  const doc = Object.values(JSON.parse(dump).find(([p]) => p === 'calendars')[1]).map(([, d]) => d).find((d) => d.countdowns[cd.id]);
  assert.deepStrictEqual(Object.keys(doc).sort(), ['countdowns', 'owner', 'updatedAt']);
  assert.deepStrictEqual(Object.keys(doc.countdowns[cd.id]).sort(), ['deck', 'deckT', 'doors', 'id', 'plan', 'setup', 'setupT', 'shop', 'updatedAt', 'v']);
  const other = await register('someone.else');
  assert.deepStrictEqual((await other('GET', '/api/countdowns')).data.countdowns, [], 'another account sees nothing of it');
  assert.strictEqual((await a('DELETE', `/api/countdowns/${cd.id}`)).status, 200);
  const removed = await b('PUT', `/api/countdowns/${cd.id}`, { countdown: body(final), base: final.updatedAt });
  assert.deepStrictEqual([removed.status, removed.data.code], [409, 'removed'], 'removed on the other phone says so');
});

test('the AI over HTTP: exactly the theme, month, ages, chips, budget, count and deck ids - extra fields, names and typed titles refused with no model call; the model saw nothing else; its answer checked (a brand, a link, a phone number and an address dropped); 422, 502, 503', async () => {
  const ana = await register('ana.ideas');
  const calls = await modelCalls();
  const good = ideasBody();
  const bad = [
    {}, [],
    Object.assign({}, good, { names: ['Wren', 'Otto'] }),
    Object.assign({}, good, { ages: ['Wren'] }),
    Object.assign({}, good, { ages: [4, 7, 'Otto'] }),
    Object.assign({}, good, { avoid: ['Make paper boats'] }),
    Object.assign({}, good, { avoid: ['c-abcdefgh'] }),
    Object.assign({}, good, { likes: ['crafts', 'shopping'] }),
    Object.assign({}, good, { theme: 'religious' }),
    Object.assign({}, good, { count: 50 }),
    Object.assign({}, good, { month: 13 }),
    Object.assign({}, good, { ages: [4, 7, 30] }),
    Object.assign({}, good, { custom: [{ t: 'Our own idea' }] }),
  ];
  for (const x of bad) {
    const r = await ana('POST', '/api/ai/ideas', x);
    assert.strictEqual(r.status, 400, JSON.stringify(x).slice(0, 80) + ' ' + r.text);
  }
  assert.strictEqual((await ana('POST', '/api/ai/ideas', Object.assign({}, good, { ages: ['Wren'] }))).data.code, 'names');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const n0 = fakeClient.calls.length;
  const r = await ana('POST', '/api/ai/ideas', good);
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const sent = fakeClient.calls[n0];
  assert.strictEqual(sent.model, FREE_MODEL);
  assert.deepStrictEqual(sent.tool_choice, { type: 'tool', name: 'record_ideas' });
  assert.strictEqual(sent.max_tokens, 300 + 200 * 6);
  assert.strictEqual(sent.tools[0].input_schema.properties.ideas.maxItems, 6);
  assert.deepStrictEqual(sent.tools[0].input_schema.properties.ideas.items.properties.cost.enum, ['free', 'little'], 'the budget shapes the tool');
  const text = sent.messages[0].content[0].text;
  assert.match(text, /- theme: winter festive/);
  assert.match(text, /- month: December/);
  assert.match(text, /- children's ages: 4, 7\n/);
  assert.match(text, /- they like: crafts, outdoors\n/);
  assert.match(text, /- budget: a few dollars at most per activity/);
  assert.match(text, /- how many ideas: 6/);
  assert.match(text, /- Make a paper chain\n/, 'the chosen deck titles, our own words');
  const flat = JSON.stringify(sent);
  assert.ok(!/Wren|Otto|Fernsby|School concert|2026|demofernsb/.test(flat), 'no name, no event, no date, no id of ours');
  assert.match(sent.system, /Never name a brand, shop, product, film, show, book, song, character, website or place/);
  assert.match(sent.system, /no fire beyond a grown-up lighting candles, no knives for small children, no open water or ice/);
  assert.match(sent.system, /no religious practice/);
  assert.deepStrictEqual(r.data.ideas.length, 6);
  assert.ok(r.data.ideas.every((x) => x.ageMin >= 4 && x.ageMax <= 7), 'ages clamped into the range asked');
  assert.ok(!store._dump().includes('Sock-puppet'), 'nothing stored');
  fakeClient.mode = 'bad';
  const b = await ana('POST', '/api/ai/ideas', good);
  assert.strictEqual(b.status, 200, b.text);
  assert.deepStrictEqual([b.data.ideas.map((x) => x.title), b.data.dropped], [['Sock-puppet weather report'], 8]);
  assert.ok(!C.namesBrand(b.text) && !/https?:|crafts\.example|0800|555|\u0040|HYPERLINK|Teen escape/.test(b.text), b.text.slice(0, 300));
  fakeClient.mode = 'inject';
  const inj = await ana('POST', '/api/ai/ideas', good);
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<b>|<img|onerror|hunter2|\u202e/i.test(inj.text) && inj.data.ideas.length === 6, inj.text.slice(0, 300));
  fakeClient.mode = 'blank';
  assert.deepStrictEqual([(await ana('POST', '/api/ai/ideas', good)).status], [422]);
  fakeClient.mode = 'maxtokens';
  const mt = await ana('POST', '/api/ai/ideas', good);
  assert.deepStrictEqual([mt.status, /ran long/.test(mt.data.error)], [502, true]);
  fakeClient.mode = 'upstream401';
  const up = await ana('POST', '/api/ai/ideas', good);
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  fakeClient.mode = 'upstream529';
  const busy = await ana('POST', '/api/ai/ideas', good);
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('the gates: an unconfirmed free account 403 verify-email, out of credit 402, the day’s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register('eve.unconfirmed');
  const good = ideasBody();
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/ai/ideas', good);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/ajar/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/ai/ideas', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ai/ideas', good)).status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/ideas', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const today = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-ajar-${today}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/ideas', good);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/ideas', BIG)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-ajar-${today}`); }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/ajar', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/ajar`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
