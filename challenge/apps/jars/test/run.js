// Pure rules first, then the page's own files, then end to end over HTTP:
//   JARS_MEMORY=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /jars, the way the
// lab mounts it. Jars has no model call and no app data on the server, so the
// HTTP half is mostly about what is NOT there: no metered route, no route
// that takes a child, nothing stored, and a grandparents' link whose
// snapshot never reaches the server.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.JARS_MEMORY !== '1') {
  console.error('run with JARS_MEMORY=1');
  process.exit(1);
}

const { app, identityStore } = require('../server');
const C = require('../public/jars-core');
const D = require('../public/demo');

const ROOT = path.join(__dirname, '..');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------------- helpers ---------------- */

const T = '2026-10-16'; // a Friday
const X = { today: T, currency: 'GBP', locale: 'en-GB' };
function rng(seed) { let s = seed >>> 0; return (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) % n; }; }
/** A child paid on Saturdays, £6 a week, 50/40/10, started `weeksAgo`. */
function mk(o) {
  const opt = o || {};
  return C.cleanKid({
    id: 'ktestkid01', name: 'Maya', emoji: '🦊', colour: 'berry', weekly: opt.weekly === undefined ? 600 : opt.weekly, payday: opt.payday === undefined ? 6 : opt.payday,
    split: opt.split || { spend: 50, save: 40, give: 10 }, interest: opt.interest || { on: false, bp: 200, cap: 0 },
    start: opt.start || '2026-09-01', paidThrough: opt.paidThrough || null, jars: opt.jars || { spend: 0, save: 0, give: 0 },
    goals: opt.goals || [], goal: opt.goal || null,
  }, { today: opt.today || T });
}
const sumHistory = (k) => C.JARS.reduce((o, j) => { o[j] = k.history.reduce((s, e) => s + e.a[j], 0); return o; }, {});

/* ---------------- money ---------------- */

test('money: what a parent types becomes whole minor units - never a float, never negative', () => {
  const cases = [['2.40', 240], ['2,40', 240], ['£2.40', 240], [' $1,240.50 ', 124050], ['1.240,50', 124050], ['60p', 60], ['45c', 45], ['45¢', 45], ['3', 300], ['0.5', 50], ['0.05', 5],
    ['1,000', 100000], ['12.345', null], ['abc', null], ['-1', null], ['', null], ['1.2.3', null], ['9'.repeat(30), null], ['100000', null], [5, 500], [null, null], ['0', 0]];
  for (const [txt, want] of cases) assert.strictEqual(C.parseMoney(txt, 'GBP'), want, JSON.stringify(txt));
  assert.strictEqual(C.parseMoney('600', 'JPY'), 600, 'yen have no minor unit');
  assert.strictEqual(C.parseMoney('1,000', 'JPY'), 1000);
  assert.strictEqual(C.parseMoney('60p', 'JPY'), null);
  assert.strictEqual(C.parseMoney('2.40', 'JPY'), null);
  // Every amount a form can produce round-trips through its own field value.
  for (let m = 1; m <= 20000; m += 37) assert.strictEqual(C.parseMoney(C.inputValue(m, 'GBP'), 'GBP'), m);
  assert.strictEqual(C.plain(240, 'GBP'), '2.40'); assert.strictEqual(C.plain(-5, 'USD'), '-0.05'); assert.strictEqual(C.plain(600, 'JPY'), '600');
});

test('money: formatted with Intl - "£2.40", and a kid\'s "£3" and "60p"', () => {
  assert.strictEqual(C.money(240, 'GBP', 'en-GB'), '£2.40');
  assert.strictEqual(C.money(124050, 'USD', 'en-US'), '$1,240.50');
  assert.strictEqual(C.money(600, 'JPY', 'en-US'), '¥600');
  assert.strictEqual(C.short(300, 'GBP', 'en-GB'), '£3');
  assert.strictEqual(C.short(240, 'GBP', 'en-GB'), '£2.40');
  assert.strictEqual(C.short(60, 'GBP', 'en-GB'), '60p');
  assert.strictEqual(C.short(45, 'USD', 'en-US'), '45¢');
  assert.match(C.short(5, 'EUR', 'de-DE'), /^0,05\s€$/);
  assert.strictEqual(C.money(1.5, 'GBP'), '', 'a float is not money');
  assert.deepStrictEqual(['en-US', 'en-GB', 'de-DE', 'fr-CA', 'ja-JP', 'xx'].map((l) => C.currencyFor(C.regionOf(l))), ['USD', 'GBP', 'EUR', 'CAD', 'JPY', 'USD']);
  const s = C.cleanSettings({ curAuto: false, currency: 'DOGE' }, 'en-GB');
  assert.strictEqual(s.currency, 'GBP');
});

/* ---------------- the split ---------------- */

test('the split: three parts add up to exactly the amount; Spend and Give round down, odd pennies to Save', () => {
  assert.deepStrictEqual(C.splitAmount(600, C.DEFAULT_SPLIT), { spend: 300, save: 240, give: 60 });
  assert.deepStrictEqual(C.splitAmount(599, { spend: 33, save: 33, give: 34 }), { spend: 197, save: 199, give: 203 });
  assert.deepStrictEqual(C.splitAmount(1, C.DEFAULT_SPLIT), { spend: 0, save: 1, give: 0 }, 'one penny goes to Save');
  assert.deepStrictEqual(C.splitAmount(7, { spend: 50, save: 0, give: 50 }), { spend: 3, save: 1, give: 3 }, 'even at 0% Save gets the remainder');
  const r = rng(7);
  for (let i = 0; i < 20000; i++) {
    const a = r(101); const b = r(101 - a);
    const sp = { spend: a, save: 100 - a - b, give: b };
    const m = r(100001);
    const p = C.splitAmount(m, sp);
    assert.strictEqual(p.spend + p.save + p.give, m);
    assert.ok([p.spend, p.save, p.give].every(Number.isInteger) && p.spend >= 0 && p.give >= 0 && p.save >= 0);
    assert.ok(p.save >= Math.floor((m * sp.save) / 100), 'Save never loses by the rounding');
  }
  assert.deepStrictEqual(C.cleanSplit({ spend: 50, save: 40, give: 11 }), C.DEFAULT_SPLIT, 'not 100: default');
  assert.deepStrictEqual(C.cleanSplit({ spend: 50.5, save: 39.5, give: 10 }), C.DEFAULT_SPLIT, 'not whole: default');
  assert.deepStrictEqual(C.cleanSplit({ spend: -10, save: 100, give: 10 }), C.DEFAULT_SPLIT);
});

test('the split sliders: moving one rebalances the others in proportion - always 100, whole percents', () => {
  assert.deepStrictEqual(C.rebalance(C.DEFAULT_SPLIT, 'save', 70), { spend: 25, save: 70, give: 5 });
  assert.deepStrictEqual(C.rebalance(C.DEFAULT_SPLIT, 'spend', 0), { spend: 0, save: 80, give: 20 });
  assert.deepStrictEqual(C.rebalance({ spend: 100, save: 0, give: 0 }, 'spend', 30), { spend: 30, save: 70, give: 0 }, 'nothing to keep in proportion: Save takes it');
  assert.deepStrictEqual(C.rebalance({ spend: 0, save: 100, give: 0 }, 'save', 30), { spend: 35, save: 30, give: 35 });
  assert.deepStrictEqual(C.rebalance(C.DEFAULT_SPLIT, 'spend', 250), { spend: 100, save: 0, give: 0 }, 'clamped');
  assert.deepStrictEqual(C.rebalance({ spend: 50, save: 40, give: 10 }, 'save', 60), { spend: 33, save: 60, give: 7 });
  assert.deepStrictEqual(C.rebalance({ spend: 50, save: 40, give: 10 }, 'save', 60, 5), { spend: 35, save: 60, give: 5 }, 'a 5% slider keeps the others on 5s');
  const r = rng(11);
  let s = C.DEFAULT_SPLIT;
  for (let i = 0; i < 5000; i++) {
    s = C.rebalance(s, C.JARS[r(3)], r(121) - 10, r(2) ? 5 : undefined);
    assert.strictEqual(s.spend + s.save + s.give, 100, JSON.stringify(s));
    assert.ok(C.JARS.every((j) => Number.isInteger(s[j]) && s[j] >= 0));
    assert.deepStrictEqual(Object.keys(s), ['spend', 'save', 'give']);
  }
});

/* ---------------- paydays ---------------- */

test('payday: catches up every missed week, oldest first, and never pays twice', () => {
  // Started Tue 1 Sep; Saturdays since: 5, 12, 19, 26 Sep, 3 and 10 Oct = 6 by Fri 16 Oct.
  const k = mk();
  const r = C.runPaydays(k, T);
  assert.deepStrictEqual(r.paid.map((p) => p.d), ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10']);
  assert.deepStrictEqual(r.kid.jars, { spend: 1800, save: 1440, give: 360 });
  assert.strictEqual(r.kid.paidThrough, '2026-10-10');
  assert.strictEqual(C.payLine(r.paid[5], 'GBP', 'en-GB', T), 'Paid Saturday: £3 spend, £2.40 save, 60p give');
  assert.strictEqual(C.payLine(r.paid[5], 'GBP', 'en-GB', '2026-10-10'), 'Paid today: £3 spend, £2.40 save, 60p give');
  // Again today, tomorrow morning, and after a reload: nothing more until Saturday.
  assert.strictEqual(C.runPaydays(r.kid, T).paid.length, 0);
  assert.strictEqual(C.runPaydays(C.cleanKid(JSON.parse(JSON.stringify(r.kid)), X), T).paid.length, 0);
  const sat = C.runPaydays(r.kid, '2026-10-17');
  assert.deepStrictEqual(sat.paid.map((p) => p.d), ['2026-10-17']);
  // Opening the app every day pays exactly what opening it once does.
  let daily = mk();
  for (let d = '2026-09-01'; d <= '2026-12-31'; d = C.addDays(d, 1)) daily = C.runPaydays(daily, d).kid;
  const once = C.runPaydays(mk(), '2026-12-31').kid;
  assert.deepStrictEqual(daily.jars, once.jars);
  assert.strictEqual(daily.history.filter((e) => e.k === 'pay').length, 17, 'every Saturday, 5 Sep to 26 Dec');
  // A payday already in the history is never paid again, even if paidThrough was lost.
  const lost = Object.assign(JSON.parse(JSON.stringify(r.kid)), { paidThrough: null });
  const again = C.runPaydays(C.cleanKid(lost, X), T);
  assert.strictEqual(again.paid.length, 0);
  assert.deepStrictEqual(again.kid.jars, r.kid.jars);
  // The history sums to the jars.
  assert.deepStrictEqual(sumHistory(once), once.jars);
});

test('payday: on the day itself, not before the start, and no money is no payday line', () => {
  const k = mk({ start: '2026-10-17' });
  assert.strictEqual(C.runPaydays(k, '2026-10-16').paid.length, 0);
  assert.strictEqual(C.runPaydays(k, '2026-10-17').paid.length, 1, 'payday is paid on payday');
  assert.strictEqual(C.nextPayday(k, '2026-10-16'), '2026-10-17');
  const paid = C.runPaydays(k, '2026-10-17').kid;
  assert.strictEqual(C.nextPayday(paid, '2026-10-17'), '2026-10-24', 'paid today: next is next week');
  // newKid: the first payday is the next one, unless the parent asks to pay today.
  const fri = { today: '2026-10-17' };
  assert.strictEqual(C.runPaydays(C.newKid({ name: 'Leo', weekly: 200, payday: 6 }, fri), '2026-10-17').paid.length, 0);
  assert.strictEqual(C.runPaydays(C.newKid({ name: 'Leo', weekly: 200, payday: 6, startNow: true }, fri), '2026-10-17').paid.length, 1);
});

test('payday: DST never moves, skips or doubles one - calendar days in the phone\'s own zone', () => {
  // The phone's "today" at instants either side of local midnight across both
  // clock changes, in London (25 Oct / 29 Mar 2026) and New York (1 Nov / 8 Mar).
  const at = (iso, tz) => C.localDate(Date.parse(iso), tz);
  assert.strictEqual(at('2026-10-24T23:30:00Z', 'Europe/London'), '2026-10-25', 'BST: 00:30 Sunday');
  assert.strictEqual(at('2026-10-25T23:30:00Z', 'Europe/London'), '2026-10-25', 'GMT: 23:30 still Sunday');
  assert.strictEqual(at('2026-11-01T04:30:00Z', 'America/New_York'), '2026-11-01', '00:30 EDT on the change');
  assert.strictEqual(at('2026-11-02T04:30:00Z', 'America/New_York'), '2026-11-01', '23:30 EST still Sunday');
  assert.strictEqual(at('2026-03-29T00:30:00Z', 'Europe/London'), '2026-03-29');
  assert.strictEqual(at('2026-03-08T07:30:00Z', 'America/New_York'), '2026-03-08');
  // A Sunday-payday child opened every 37 minutes through a year in both
  // zones: one payday a week, on a Sunday, every week.
  for (const tz of ['Europe/London', 'America/New_York', 'Australia/Sydney']) {
    let k = mk({ payday: 0, start: '2026-01-01', today: '2026-01-01' });
    const seen = [];
    for (let ms = Date.parse('2026-01-01T00:00:00Z'); ms < Date.parse('2027-01-01T00:00:00Z'); ms += 37 * 60000) {
      const r = C.runPaydays(k, C.localDate(ms, tz));
      k = r.kid; for (const p of r.paid) seen.push(p.d);
    }
    assert.ok(seen.every((d) => C.weekdayOf(d) === 0), tz);
    for (let i = 1; i < seen.length; i++) assert.strictEqual(C.daysBetween(seen[i - 1], seen[i]), 7, `${tz} ${seen[i]}`);
    assert.ok(seen.length >= 52 && seen.length <= 53, `${tz}: ${seen.length}`);
  }
});

test('payday: moving the weekday never pays twice in a week; at most two years are caught up', () => {
  const k = C.runPaydays(mk(), T).kid; // paid Sat 10 Oct
  const moved = C.editKid(k, { name: 'Maya', weekly: 600, payday: 3, split: C.DEFAULT_SPLIT, interest: k.interest }, X);
  assert.strictEqual(C.nextPayday(moved, T), '2026-10-21', 'Wednesday, at least seven days after Saturday');
  const later = C.runPaydays(moved, '2026-11-30');
  for (let i = 1; i < later.paid.length; i++) assert.ok(C.daysBetween(later.paid[i - 1].d, later.paid[i].d) >= 7);
  assert.ok(C.daysBetween('2026-10-10', later.paid[0].d) >= 7);
  // Five years unopened: the last 104 paydays are paid, the rest counted.
  const old = mk({ start: '2021-10-01', today: T });
  const r = C.runPaydays(old, T);
  assert.strictEqual(r.paid.length, C.LIMITS.catchUpWeeks);
  assert.ok(r.skipped > 150);
  assert.strictEqual(C.runPaydays(r.kid, T).paid.length, 0);
});

/* ---------------- interest ---------------- */

test('interest: whole pennies, half a penny rounds up, capped, only when switched on', () => {
  const on = { on: true, bp: 200, cap: 0 };
  assert.strictEqual(C.interestFor(4120, on), 82, '2% of £41.20 is 82.4p');
  assert.strictEqual(C.interestFor(25, on), 1, '0.5p rounds up');
  assert.strictEqual(C.interestFor(24, on), 0, '0.48p rounds down');
  assert.strictEqual(C.interestFor(75, on), 2, '1.5p rounds up');
  assert.strictEqual(C.interestFor(100000, { on: true, bp: 500, cap: 600 }), 600, 'capped');
  assert.strictEqual(C.interestFor(4120, { on: false, bp: 200 }), 0);
  assert.strictEqual(C.interestFor(-50, on), 0);
  assert.strictEqual(C.cleanInterest({ on: true, bp: 9999 }).bp, 200, 'only rates from the list');
  for (let s = 0; s < 200000; s += 13) assert.ok(Number.isInteger(C.interestFor(s, { on: true, bp: 300, cap: 0 })));
  assert.strictEqual(C.interestLine(8, 'GBP', 'en-GB'), 'Your savings earned 8p!');
  assert.strictEqual(C.interestLine(0, 'GBP', 'en-GB'), '');
});

test('interest: compounds weekly on payday - on Save as it stood, before the new money', () => {
  const k = mk({ jars: { spend: 0, save: 4120, give: 0 }, interest: { on: true, bp: 200, cap: 0 }, start: '2026-10-17', today: T });
  const r = C.runPaydays(k, '2026-10-31');
  assert.deepStrictEqual(r.paid.map((p) => p.interest), [82, 89, 95]);
  // By hand: 4120 -> +82 +240 = 4442 -> +89 +240 = 4771 -> +95 +240 = 5106.
  assert.strictEqual(r.kid.jars.save, 5106);
  assert.strictEqual(r.kid.history.filter((e) => e.k === 'pay').reduce((s, e) => s + e.int, 0), 266);
  // The projection is the same sums as real paydays.
  const pr = C.projection(k, 3);
  assert.deepStrictEqual(pr.with, [4120, 4442, 4771, 5106]);
  assert.deepStrictEqual(pr.without, [4120, 4360, 4600, 4840]);
  assert.strictEqual(pr.extra, 266);
});

/* ---------------- goals ---------------- */

test('goals: progress, and the ETA in paydays (with interest) is what the real paydays deliver', () => {
  for (const [save, interest] of [[4044, { on: true, bp: 200, cap: 600 }], [100, { on: false }], [5900, { on: true, bp: 500, cap: 0 }], [0, { on: true, bp: 100, cap: 50 }]]) {
    let k = mk({ jars: { spend: 0, save, give: 0 }, interest, start: '2026-10-17', today: T });
    k = C.addGoal(k, { name: 'LEGO set', emoji: '🧱', price: 6000 }, X);
    const st = C.goalStatus(k, T);
    let n = 0;
    while (k.jars.save < 6000) { n++; k = C.runPaydays(k, C.addDays('2026-10-17', 7 * (n - 1))).kid; }
    assert.strictEqual(st.weeks, n, `save ${save}`);
    assert.strictEqual(st.date, C.addDays('2026-10-17', 7 * (n - 1)));
    assert.ok(st.plainWeeks >= st.weeks);
  }
  const k = C.addGoal(mk({ jars: { spend: 0, save: 4044, give: 0 } }), { name: 'LEGO', emoji: '🧱', price: 6000 }, X);
  const st = C.goalStatus(k, T);
  assert.deepStrictEqual([st.saved, st.left, st.pct, st.reached], [4044, 1956, 67, false]);
  assert.strictEqual(C.etaWords({ reached: false, weeks: 6 }), 'About 6 more paydays');
  assert.strictEqual(C.etaWords({ reached: false, weeks: 1 }), 'Next payday!');
  assert.strictEqual(C.etaWords({ reached: true }), 'You did it!');
  const none = C.addGoal(mk({ weekly: 0 }), { name: 'Bike', price: 9000 }, X);
  assert.strictEqual(C.goalStatus(none, T).weeks, null, 'nothing goes to Save: no ETA, never a loop');
  assert.strictEqual(C.paydaysTo(C.addGoal(mk({ weekly: 1, split: { spend: 100, save: 0, give: 0 } }), { name: 'X', price: 9000000 }, X), 9000000, false), null);
  assert.throws(() => C.addGoal(mk(), { name: '<b></b>', price: 100 }, X), /name and a price/);
  assert.throws(() => C.addGoal(mk(), { name: 'Bike', price: 0 }, X), /name and a price/);
});

test('goals: reached once (the celebration), bought out of Save, several with one active', () => {
  let k = mk({ jars: { spend: 500, save: 460, give: 0 } });
  k = C.addGoal(k, { name: 'Sticker book', emoji: '📒', price: 500 }, X);
  k = C.addGoal(k, { name: 'Kite', emoji: '🪁', price: 900 }, X);
  assert.strictEqual(k.goals[1].emoji, '🎁', 'pictures only from the list');
  assert.strictEqual(C.activeGoal(k).name, 'Sticker book', 'the first goal is the active one');
  assert.strictEqual(C.checkReached(k, T).reached, null);
  k = C.act(k, 'move', { from: 'spend', to: 'save', amount: 40 }, X).kid;
  const cr = C.checkReached(k, T);
  assert.strictEqual(cr.reached.name, 'Sticker book');
  assert.strictEqual(C.checkReached(cr.kid, T).reached, null, 'celebrated once');
  assert.throws(() => C.act(C.setGoal(cr.kid, cr.kid.goals[1].id), 'buy', { gid: cr.kid.goals[1].id }, X), /Not quite yet - £4 to go/);
  const b = C.act(cr.kid, 'buy', { gid: cr.kid.goals[0].id }, X);
  assert.strictEqual(b.kid.jars.save, 0);
  assert.strictEqual(b.kid.goals[0].bought, T);
  assert.strictEqual(C.activeGoal(b.kid).name, 'Kite', 'the next goal takes over');
  assert.match(b.msg, /Sticker book bought with £5/);
  const rm = C.removeGoal(b.kid, b.kid.goals[1].id);
  assert.strictEqual(C.activeGoal(rm), null);
  assert.strictEqual(rm.jars.save, 0, 'removing a goal moves no money');
});

/* ---------------- the moves ---------------- */

test('moves: spend, give, move, add, fix - and no jar ever goes below zero', () => {
  let k = mk({ jars: { spend: 500, save: 2000, give: 100 } });
  assert.throws(() => C.act(k, 'spend', { amount: 501, what: 'Toy' }, X), /only £5 in Maya’s Spend jar/);
  assert.throws(() => C.act(k, 'give', { amount: 101, to: 'x' }, X), /only £1 in Maya’s Give jar/);
  assert.throws(() => C.act(k, 'spend', { amount: 0 }, X), /How much/);
  assert.throws(() => C.act(k, 'spend', { amount: 1.5 }, X), /How much/);
  assert.throws(() => C.act(k, 'spend', { amount: -5 }, X), /How much/);
  assert.throws(() => C.act(k, 'move', { from: 'save', to: 'save', amount: 1 }, X), /two different jars/);
  assert.throws(() => C.act(k, 'move', { from: 'give', to: 'spend', amount: 200 }, X), /only £1/);
  assert.throws(() => C.act(k, 'fix', { jar: 'spend', amount: -1 }, X), /really in the jar/);
  k = C.act(k, 'spend', { amount: 120, what: 'Sweets' }, X).kid;
  k = C.act(k, 'give', { amount: 100, to: 'the shelter' }, X).kid;
  assert.throws(() => C.act(k, 'give', { amount: 1 }, X), /Give jar is empty/);
  const add = C.act(k, 'add', { amount: 1001, why: 'birthday', note: 'From Grandma', into: 'split' }, X);
  assert.deepStrictEqual(add.ev.a, { spend: 500, save: 401, give: 100 }, 'an odd added penny goes to Save too');
  assert.strictEqual(add.msg, '£10.01 added - £5 spend, £4.01 save, £1 give.');
  k = C.act(add.kid, 'add', { amount: 250, why: '__proto__', into: 'save' }, X).kid;
  assert.strictEqual(k.history[k.history.length - 1].why, 'other');
  k = C.act(k, 'fix', { jar: 'give', amount: 0 }, X).kid;
  assert.deepStrictEqual(k.jars, { spend: 880, save: 2651, give: 0 });
  // A long random run: never negative, never a float, the history adds up.
  const r = rng(99);
  let z = C.runPaydays(mk(), T).kid;
  const kinds = ['spend', 'give', 'move', 'add', 'fix'];
  for (let i = 0; i < 3000; i++) {
    const kind = kinds[r(5)];
    const opts = { amount: r(3000) + (r(9) ? 0 : -1500), what: 'x', to: 'y', from: C.JARS[r(3)], into: ['split', 'spend', 'save', 'give'][r(4)], jar: C.JARS[r(3)] };
    opts.to = kind === 'move' ? C.JARS[r(3)] : opts.to;
    try { z = C.act(z, kind, opts, X).kid; } catch (e) { assert.strictEqual(e.status, 400, e.message); }
    assert.ok(C.JARS.every((j) => Number.isSafeInteger(z.jars[j]) && z.jars[j] >= 0), JSON.stringify(z.jars));
  }
  assert.ok(z.history.length <= C.LIMITS.history);
});

test('moves: which need a grown-up - adding money, anything out of Save or Give, buying, correcting', () => {
  const table = [['spend', {}, false], ['give', {}, false], ['move', { from: 'spend', to: 'save' }, false], ['move', { from: 'spend', to: 'give' }, false],
    ['move', { from: 'save', to: 'spend' }, true], ['move', { from: 'save', to: 'give' }, true], ['move', { from: 'give', to: 'spend' }, true],
    ['add', {}, true], ['buy', {}, true], ['fix', {}, true]];
  for (const [kind, o, want] of table) assert.strictEqual(C.needsGrownUp(kind, o), want, `${kind} ${JSON.stringify(o)}`);
});

test('undo: puts the latest move back exactly - not after something else happened', () => {
  const k = mk({ jars: { spend: 500, save: 0, give: 0 }, start: '2026-10-17' });
  const r = C.act(k, 'spend', { amount: 200, what: 'Toy' }, X);
  assert.deepStrictEqual(C.undo(r.kid, r.token), k);
  const paid = C.runPaydays(r.kid, '2026-10-17').kid;
  assert.throws(() => C.undo(paid, r.token), /can’t be undone/);
  const r2 = C.act(r.kid, 'spend', { amount: 100, what: 'Sweets' }, X);
  assert.throws(() => C.undo(r2.kid, r.token), /can’t be undone/, 'only the latest');
});

/* ---------------- the PIN ---------------- */

test('PIN: four digits, kept only as a salted PBKDF2 hash; checked in constant time; a speed bump', async () => {
  const rec = await C.hashPin('4721');
  assert.strictEqual(rec.a, 'pbkdf2-sha256');
  assert.ok(rec.i >= 10000);
  assert.match(rec.s, /^[A-Za-z0-9_-]{16,64}$/);
  assert.ok(!JSON.stringify(rec).includes('4721'), 'the PIN itself is never stored');
  const rec2 = await C.hashPin('4721');
  assert.notStrictEqual(rec.h, rec2.h, 'a fresh salt each time');
  assert.strictEqual(await C.checkPin('4721', rec), true);
  assert.strictEqual(await C.checkPin('4722', rec), false);
  assert.strictEqual(await C.checkPin('472', rec), false);
  assert.strictEqual(await C.checkPin('4721', { a: 'pbkdf2-sha256', s: rec.s, h: rec.h.slice(1) + 'A', i: rec.i }), false);
  for (const bad of ['', '12345', 'abcd', '12 4', 1234, null, '١٢٣٤']) await assert.rejects(() => C.hashPin(bad), /Four digits/);
  for (const junk of [null, {}, { a: 'md5', s: rec.s, h: rec.h }, { a: 'pbkdf2-sha256', s: '<x>', h: rec.h }, { a: 'pbkdf2-sha256', s: rec.s, h: '' }]) {
    assert.strictEqual(C.cleanPinRecord(junk), null);
    assert.strictEqual(await C.checkPin('4721', junk), false);
  }
  // The no-WebCrypto fallback is still salted and checked the same way.
  const f = await C.hashPin('0000', { a: 'fnv', s: 'abcdefghijklmnop' });
  assert.strictEqual(await C.checkPin('0000', f), true);
  assert.strictEqual(await C.checkPin('0001', f), false);
  // Every message that sets one says what it is.
  const js = read('public/app.js');
  assert.strictEqual((js.match(/speed bump for little fingers, not security/g) || []).length >= 3, true);
});

/* ---------------- one door for every child ---------------- */

test('cleanKid: hostile records are cleaned - names, emoji, amounts, dates, goals and history bounded', () => {
  const evil = C.cleanKid({
    id: '__proto__', name: '<img src=x onerror=alert(1)>Maya\u202e', emoji: '<b>', colour: 'red;background:url(x)', age: 99,
    weekly: 1e12, payday: 9, split: { spend: 90, save: 90, give: 90 }, interest: { on: 'yes', bp: 1e6, cap: -1 },
    jars: { spend: 1.5, save: -100, give: 1e20 }, start: '2026-02-30', paidThrough: '2999-01-01',
    goals: Array.from({ length: 50 }, (_, i) => ({ name: 'G' + i, price: 100 + i })),
    history: Array.from({ length: 900 }, () => ({ k: 'spend', d: '2026-10-01', a: { spend: -10, save: 'x', give: 1e30 }, what: '<script>' })).concat([{ k: 'hack', d: T }, { k: 'pay', d: '2999-01-01' }]),
  }, X);
  assert.ok(evil);
  assert.strictEqual(evil.name, 'Maya');
  assert.ok(C.isKidId(evil.id));
  assert.deepStrictEqual([evil.emoji, evil.colour, evil.age, evil.weekly, evil.payday], ['🦊', 'berry', null, 0, 6]);
  assert.deepStrictEqual(evil.split, C.DEFAULT_SPLIT);
  assert.deepStrictEqual(evil.interest, { on: false, bp: 200, cap: 0 });
  assert.deepStrictEqual(evil.jars, { spend: 0, save: 0, give: 0 });
  assert.deepStrictEqual([evil.start, evil.paidThrough], [T, null]);
  assert.strictEqual(evil.goals.length, C.LIMITS.goals);
  assert.strictEqual(evil.history.length, C.LIMITS.history);
  assert.ok(evil.history.every((e) => C.KINDS.includes(e.k) && e.a.give === 0 && e.a.save === 0 && !/[<>]/.test(e.what || '')));
  assert.strictEqual(C.cleanKid({ name: '1234' }, X), null, 'a name needs a letter');
  assert.strictEqual(C.cleanKid({ name: '   ' }, X), null);
  assert.strictEqual(C.cleanKid(['Maya'], X), null);
  assert.strictEqual(C.cleanKid({ name: 'Mary-Jane O’Neil the third of her name' }, X).name.length <= 20, true);
});

/* ---------------- the grandparents' link ---------------- */

function demoKid() { return C.runPaydays(D.build(T, 'GBP').kids[0], T).kid; }

test('the grandparents\' link: into the fragment, compressed or plain, and back exactly', async () => {
  const k = demoKid();
  const p = C.packSnapshot(k, { today: T, currency: 'GBP' });
  assert.ok(!('id' in p) && !JSON.stringify(p).includes(k.id) && !JSON.stringify(p).includes('"age"'), 'no id, no age');
  const z = await C.encodeSnapshot(p);
  const pl = await C.encodeSnapshot(p, { plain: true });
  assert.match(z, /^v1\.z\.[A-Za-z0-9_-]+$/); assert.match(pl, /^v1\.p\.[A-Za-z0-9_-]+$/);
  assert.ok(z.length < pl.length, 'compression helps');
  const a = await C.decodeSnapshot('#' + z); const b = await C.decodeSnapshot(pl);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a, C.cleanSnapshot(p), 'what arrives is what was sent, cleaned');
  assert.deepStrictEqual([a.name, a.jars.save, a.goal.name, a.goal.pct, a.goal.weeks, a.cause], ['Maya', k.jars.save, 'LEGO set', 67, 6, 'the animal shelter']);
  assert.ok(a.went.length > 0 && a.went.every((w) => w.amount > 0));
  assert.deepStrictEqual(C.cleanSnapshot(JSON.parse(JSON.stringify(a)) && p), a, 'idempotent');
  const html = C.snapshotHtml(a, { locale: 'en-GB' });
  assert.match(html, /Maya’s jars/); assert.match(html, /£40\.44/); assert.match(html, /About 6 more paydays/);
});

test('the grandparents\' link: hiding amounts leaves no amount in the link at all', async () => {
  const k = demoKid();
  const p = C.packSnapshot(k, { today: T, hide: true, currency: 'GBP' });
  const flat = JSON.stringify(p);
  for (const v of [k.jars.spend, k.jars.save, k.jars.give, C.total(k), 6000]) assert.ok(!flat.includes(String(v)), `${v} leaked`);
  assert.ok(p.w.every((w) => w[3] === -1));
  const s = await C.decodeSnapshot(await C.encodeSnapshot(p));
  assert.strictEqual(s.hide, true);
  assert.strictEqual(s.total, null); assert.strictEqual(s.goal.price, null);
  assert.ok(Math.max(s.jars.spend, s.jars.save, s.jars.give) === 100);
  const html = C.snapshotHtml(s, { locale: 'en-GB' });
  assert.ok(!/£/.test(html), 'no amount is drawn');
  assert.match(html, /The fullest/); assert.match(html, /67% of the way/);
});

test('the grandparents\' link: too long trims the oldest rows; hostile or garbled fragments are refused, never thrown', async () => {
  const k = demoKid();
  const p = C.packSnapshot(k, { today: T, currency: 'GBP' });
  p.w = Array.from({ length: 400 }, (_, i) => [T, 's', require('crypto').randomBytes(30).toString('hex') + i, 100]);
  const f = await C.encodeSnapshot(p, { plain: true });
  assert.ok(f.length <= C.LIMITS.fragment);
  const big = { v: 1, n: 'x'.repeat(C.LIMITS.fragment), g: T, j: [1, 2, 3], cu: 'GBP', w: [] };
  assert.strictEqual(await C.encodeSnapshot(big, { plain: true }), null, 'over the cap: no link');
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const z = (buf) => 'v1.z.' + zlib.deflateSync(buf).toString('base64url');
  const hostile = [
    '', '#', 'nonsense', 'v2.p.' + b64(p), 'v1.x.abc', 'v1.p.!!!!', 'v1.p.' + b64('not json'), 'v1.p.' + b64([1, 2]),
    'v1.p.' + Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url'),
    'v1.p.' + b64(Object.assign({}, p, { v: 2 })), 'v1.p.' + b64(Object.assign({}, p, { n: '<b>' })), 'v1.p.' + b64(Object.assign({}, p, { cu: 'DOGE' })),
    'v1.p.' + b64(Object.assign({}, p, { j: [1, -2, 3] })), 'v1.p.' + b64(Object.assign({}, p, { j: [1.5, 2, 3] })), 'v1.p.' + b64(Object.assign({}, p, { g: '2026-02-30' })),
    z(Buffer.alloc(C.LIMITS.inflated * 8, 0x20)), // a deflate bomb
    'v1.z.' + 'A'.repeat(C.LIMITS.fragment), 'v1.z.AAAA', 'x'.repeat(C.LIMITS.fragment + 10),
  ];
  for (const h of hostile) assert.strictEqual(await C.decodeSnapshot(h), null, h.slice(0, 40));
  // Markup in every text field arrives as text, and the drawing escapes it.
  const inj = Object.assign({}, C.packSnapshot(k, { today: T, currency: 'GBP' }), { n: 'Maya<script>x</script>', ca: '"><img src=x onerror=alert(1)>', e: '<b>', c: 'red" onclick="x',
    go: ['<svg onload=alert(1)>LEGO', '🧱', 6000, 67, 6], w: [[T, 's', '<iframe>sweets', 100], [T, 'g', 'javascript:alert(1)', 50], [T, 'q', 'x', 1]] });
  const s = await C.decodeSnapshot(await C.encodeSnapshot(inj));
  const html = C.snapshotHtml(s, { locale: 'en-GB' });
  assert.ok(!/<(script|img|iframe|svg onload)/i.test(html) && !/ on[a-z]+=/i.test(html), html.slice(0, 300));
  assert.strictEqual(s.went.length, 2, 'unknown kinds dropped');
  assert.strictEqual(s.colour, 'berry');
});

test('the gift note: a short code that round-trips; never money; hostile codes refused', () => {
  const code = C.makeGift({ kid: 'Maya', amount: '10', currency: 'GBP', into: 'save', message: 'For the LEGO! <3', from: 'Grandma', today: T });
  assert.ok(code.length < 300);
  const g = C.readGift(code);
  assert.deepStrictEqual(g, { kid: 'Maya', amount: 1000, currency: 'GBP', into: 'save', message: 'For the LEGO!', from: 'Grandma', date: T });
  assert.deepStrictEqual(C.readGift('Grandma is sending £10 for Maya. Open this: https://challenge.example/jars/#gift/' + code), g, 'from a pasted message with the link');
  assert.deepStrictEqual(C.readGift('  ' + code + '\n'), g);
  assert.throws(() => C.makeGift({ kid: 'Maya', amount: 'lots', currency: 'GBP' }), /How much/);
  assert.throws(() => C.makeGift({ kid: 'Maya', amount: '0', currency: 'GBP' }), /How much/);
  const enc = (o) => 'g1.' + Buffer.from(JSON.stringify(o)).toString('base64url');
  for (const bad of [null, '', 'g1.', 'g1.!!!!!!!!!', enc({ v: 2, a: 100, c: 'GBP' }), enc({ v: 1, a: -100, c: 'GBP' }), enc({ v: 1, a: 1.5, c: 'GBP' }), enc({ v: 1, a: 1e9, c: 'GBP' }),
    enc({ v: 1, a: 100, c: 'BTC' }), 'g1.' + 'A'.repeat(5000), enc([1]), 'g1.' + Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8]).toString('base64url')]) {
    assert.strictEqual(C.readGift(bad), null, String(bad).slice(0, 30));
  }
  const h = C.readGift(enc({ v: 1, k: '<b>Maya</b>', a: 500, c: 'GBP', j: 'everything', m: '\u202e<img src=x>', f: 'x'.repeat(500) }));
  assert.deepStrictEqual([h.kid, h.into, h.message, h.from.length <= C.LIMITS.giftFrom], ['Maya', 'split', '', true]);
});

/* ---------------- files out and in ---------------- */

test('export / import: round-trips; hostile files refused or cleaned; the PIN stays on the phone', () => {
  const fam = D.build(T, 'GBP');
  const text = C.exportFamily({ settings: { currency: 'GBP', curAuto: true }, kids: fam.kids, pin: { h: 'SECRET' } });
  assert.ok(!text.includes('SECRET') && !/"pin/.test(text));
  const back = C.importFamily(text, { today: T, locale: 'en-GB' });
  assert.deepStrictEqual(back.kids, fam.kids);
  for (const [bad, re] of [['nope', /isn’t JSON/], ['{"app":"glovebox","v":1,"kids":[]}', /isn’t a Jars export/], ['[]', /isn’t a Jars export/], ['x'.repeat(C.LIMITS.importBytes + 1), /too big/]]) {
    assert.throws(() => C.importFamily(bad, { today: T, locale: 'en-GB' }), re);
  }
  const many = JSON.stringify({ app: 'jars', v: 1, kids: Array.from({ length: 40 }, (_, i) => ({ id: 'kaaaaaaa01', name: 'Kid' + 'abcdefghijklmnopqrstuvwxyz'[i % 26] })).concat([{ name: '<>' }, { __proto__: { polluted: 1 }, name: 'P' }]) });
  const r = C.importFamily(many, { today: T, locale: 'en-GB' });
  assert.strictEqual(r.kids.length, C.LIMITS.kids);
  assert.strictEqual(new Set(r.kids.map((k) => k.id)).size, r.kids.length, 'duplicate ids made unique');
  assert.strictEqual({}.polluted, undefined);
  const proto = C.importFamily('{"app":"jars","v":1,"kids":[{"name":"Ann","__proto__":{"x":1},"jars":{"__proto__":{"spend":5}}}]}', { today: T, locale: 'en-GB' });
  assert.deepStrictEqual(proto.kids[0].jars, { spend: 0, save: 0, give: 0 });
});

test('CSV: every row, quoted where needed, and no cell a spreadsheet would run', () => {
  let k = mk({ jars: { spend: 1000, save: 0, give: 0 } });
  k.name = 'Ann';
  k = C.act(k, 'spend', { amount: 120, what: '=HYPERLINK("http://evil","click")' }, X).kid;
  k = C.act(k, 'spend', { amount: 100, what: '+1+1' }, X).kid;
  k = C.act(k, 'spend', { amount: 100, what: '@SUM(A1), "quoted"\nnext' }, X).kid;
  k = C.act(k, 'add', { amount: 250, why: 'chore', note: '-2+3', into: 'spend' }, X).kid;
  const csv = C.csvFor([k], { currency: 'GBP' });
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines[0], 'Date,Child,What,Spend,Save,Give,Total,Note');
  assert.ok(csv.endsWith('\r\n'));
  assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""http://evil"",""click"")"`)), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes(",'+1+1,")));
  assert.ok(lines.some((l) => l.includes(`"'@SUM(A1)`)));
  assert.ok(lines.some((l) => l.includes(",'-2+3,")), 'a note starting with - is guarded');
  assert.ok(lines.some((l) => l.includes(',-1.20,0.00,0.00,-1.20,')), 'our own negative amounts are numbers, not guarded');
  for (const l of lines.slice(1)) assert.ok(!/(^|,)[=+@]/.test(l), l);
  assert.strictEqual(C.csvCell('plain', true), 'plain');
  assert.strictEqual(C.csvCell('\tx', true), "'\tx");
});

test('calendar (.ics): RFC 5545 - CRLF, folded at 75 octets, a weekly payday on the right weekday, escaped', () => {
  const fam = D.build(T, 'GBP');
  const kids = fam.kids.map((k) => C.runPaydays(k, T).kid);
  kids[0].name = 'Maya, the; \\ great';
  const r = C.icsFor(kids, { today: T, currency: 'GBP', locale: 'en-GB', now: Date.parse('2026-10-16T09:00:00Z') });
  assert.strictEqual(r.events, 4, 'two paydays and two goals');
  const t = r.text;
  assert.ok(t.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n') && t.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(t), 'CRLF only');
  for (const line of t.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  const unfolded = t.replace(/\r\n /g, '');
  assert.strictEqual((unfolded.match(/BEGIN:VEVENT/g) || []).length, (unfolded.match(/END:VEVENT/g) || []).length);
  const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const ev = unfolded.split('BEGIN:VEVENT').slice(1);
  const pays = ev.filter((e) => /RRULE/.test(e));
  assert.strictEqual(pays.length, 2);
  for (const e of pays) {
    const start = /DTSTART;VALUE=DATE:(\d{8})/.exec(e)[1];
    const d = `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6)}`;
    assert.ok(d > T, 'the next payday, not today\'s (already paid)');
    assert.strictEqual(/BYDAY=([A-Z]{2})/.exec(e)[1], days[C.weekdayOf(d)]);
    assert.match(e, /RRULE:FREQ=WEEKLY;COUNT=26;BYDAY=/);
  }
  assert.match(unfolded, /SUMMARY:💰 Payday: Maya\\, the\\; \\\\ great - £6/);
  assert.match(unfolded, /£3 spend\\, £2.40 save\\, 60p give\./);
  const uids = unfolded.match(/UID:[^\r]+/g);
  assert.strictEqual(new Set(uids).size, uids.length);
  assert.match(unfolded, /SUMMARY:🎯 Maya.*LEGO set - about now/);
});

/* ---------------- the example family ---------------- */

test('the example family holds its story on every third day of a year, in several currencies', () => {
  const C0 = ['GBP', 'USD', 'EUR', 'JPY', 'INR', 'SEK'];
  let n = 0;
  for (let d = '2026-10-16'; d < '2027-10-16'; d = C.addDays(d, 3)) {
    const cur = C0[n++ % C0.length];
    const m = D.scaleOf(cur);
    const fam = D.build(d, cur);
    assert.strictEqual(fam.kids.length, 2);
    for (const k of fam.kids) {
      assert.strictEqual(C.nextPayday(k, d), d, `${d}: today's payday is waiting`);
      assert.deepStrictEqual(sumHistory(k), k.jars, `${d} ${k.name}: the history is the jars`);
      assert.ok(C.JARS.every((j) => k.jars[j] >= 0));
      assert.ok(k.history.every((e) => e.d < d));
    }
    const [maya, leo] = fam.kids.map((k) => C.runPaydays(k, d).kid);
    const ms = C.goalStatus(maya, d); const ls = C.goalStatus(leo, d);
    assert.deepStrictEqual([ms.goal.name, ms.weeks, ms.reached], ['LEGO set', 6, false], `${d} ${cur}`);
    assert.ok(maya.history.some((e) => e.k === 'pay' && e.int > 0), 'a little interest earned');
    assert.strictEqual(maya.cause, 'the animal shelter');
    assert.deepStrictEqual([ls.goal.name, ls.left, ls.weeks], ['Sticker book', D.LEO_SHORT * m, 1], `${d} ${cur}`);
    assert.ok(leo.jars.spend >= D.LEO_SHORT * m, 'Leo can move it from Spend himself');
    assert.ok(leo.goals.some((g) => g.bought) && maya.goals.some((g) => g.bought));
  }
});

test('the drawings: jars and rings are SVG with nothing unescaped, fills between empty and full', () => {
  const svg = C.jarSvg('spend', 0.5, { uid: '"><script>', seed: 3 });
  assert.ok(!/<script|onload/i.test(svg) && !svg.includes('"><script'));
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  assert.ok(!C.jarSvg('save', 0).includes('jar-fill'), 'empty means empty');
  assert.ok(C.jarSvg('save', 0.001).includes('jar-fill'), 'a penny shows');
  assert.ok(!C.ringSvg(50, '<img>').includes('<img'));
  const f = C.fills(demoKid());
  assert.ok(C.JARS.every((j) => f[j] >= 0 && f[j] <= 1));
  assert.ok(Math.abs(f.save - 4044 / 6000) < 0.01, 'Save fills toward the goal');
});

/* ---------------- the page ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
test('contrast: every text colour 4.5:1 on its surface in both themes, white on every child\'s colour, jar fills 3:1', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['bg', 'card', 'card2', 'bar-bg']) for (const fg of ['text', 'muted', 'link', 'err']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    const pairs = [['accent-ink', 'accent'], ['text', 'accent-soft'], ['link', 'accent-soft'], ['muted', 'accent-soft'], ['good', 'good-bg'], ['good', 'card2'], ['bad', 'bad-bg'], ['warn', 'warn-bg'],
      ['strip-ink', 'strip'], ['strip-btn-ink', 'strip-btn'], ['strip-ink', 'bar-bg'] && ['text', 'bar-bg']];
    for (const j of ['spend', 'save', 'give']) pairs.push([`${j}-ink`, `${j}-tint`], [`${j}-ink`, 'card'], [`${j}-ink`, 'card2'], ['text', `${j}-tint`]);
    for (const [fg, bg] of pairs) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const c of ['berry', 'sky', 'leaf', 'sun', 'grape', 'coral']) assert.ok(ratio('#ffffff', t[`c-${c}`]) >= 4.5, `${name} white on ${c}`);
    for (const j of ['spend', 'save', 'give']) assert.ok(ratio(t[`${j}-fill`], t.glass) >= 3, `${name} ${j} fill on glass: ${ratio(t[`${j}-fill`], t.glass).toFixed(2)}`);
    assert.ok(ratio(t['glass-edge'], t.card) >= 3, `${name} jar outline`);
  }
  // The fridge chart prints dark on white whatever the theme.
  for (const fg of ['#1a1208', '#4f3f2e']) assert.ok(ratio(fg, '#ffffff') >= 4.5 && ratio(fg, '#dcf3e3') >= 4.5);
  // Big targets in the kid view, colour never alone.
  assert.match(css, /button\.jar-col \{[^}]*min-height: 48px/);
  assert.match(css, /\.kbtn \{[^}]*min-height: 60px/);
  assert.match(css, /\.key \{[^}]*height: 64px/);
  assert.match(css, /\.kidchip \{[^}]*min-height: 52px/);
  assert.match(css, /\.btn \{[^}]*min-height: 48px/);
  assert.match(css, /@media print/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  const js = read('public/app.js');
  assert.match(js, /jar-name"><span aria-hidden="true">' \+ C\.JAR_ICON\[j\] \+ '<\/span> ' \+ C\.JAR_LABEL\[j\]/, 'every jar carries its word and icon');
  assert.match(js, /REDUCED/); assert.match(js, /if \(REDUCED\) return;/);
});

test('the pages: relative links, no inline script or handlers, the banner, storage wrapped, no request of their own', () => {
  const html = read('public/index.html'), gran = read('public/gran.html');
  for (const [n, h] of [['index', html], ['gran', gran]]) {
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(h), `${n}: no inline <script>`);
    assert.ok(!/\son[a-z]+\s*=/i.test(h), `${n}: no inline handlers`);
    assert.ok(!/(src|href)="\//.test(h), `${n}: relative asset links only`);
  }
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && html.includes('<body class="dk">'));
  assert.ok(!gran.includes('verify-banner') && !gran.includes('passkey'), 'the grandparents\' page loads nothing that calls a server');
  const js = read('public/app.js'), gjs = read('public/gran.js'), core = read('public/jars-core.js'), demo = read('public/demo.js');
  for (const [n, s] of [['app.js', js], ['gran.js', gjs]]) {
    assert.ok(!/\son[a-z]+=\\?["']/.test(s), `${n}: no handler written into markup`);
    assert.ok(!/\.on(click|input|change|submit|keydown) =/.test(s), `${n}: handlers by addEventListener`);
    assert.ok(!/href="\//.test(s), `${n}: every URL relative`);
    assert.ok(!/innerHTML = [^;]*\+ (?!esc\(|C\.|'|")[a-z]+\.(name|note|what|cause|message|from)\b/i.test(s), `${n}: names go through esc()`);
  }
  assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|new Image/.test(js), 'the page makes no request of its own');
  assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|serviceWorker|localStorage|indexedDB|document\.cookie/.test(gjs + core + demo), 'the grandparents\' page, the rules and the example make no request and keep nothing');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/indexedDB|sessionStorage|document\.cookie/.test(js));
  assert.ok(js.includes("register('sw.js', { scope: './' })"));
  assert.ok(js.includes("BASE + 'gran#' + frag"), 'the snapshot goes in the fragment');
  assert.ok(gjs.includes("'#gift/' + code"), 'the gift note goes in the fragment');
  const emails = (html + js + gjs + core + demo).match(/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/gi) || [];
  assert.deepStrictEqual(emails.filter((e) => !/@jars\.local$/.test(e)), [], 'no email address in the pages (calendar UIDs end @jars.local)');
  assert.match(js, /First names or a nickname only - it stays on this phone/);
  assert.match(gjs, /It’s a note, not a payment: no money moves through Jars/);
  const server = read('server.js');
  assert.ok(!/setInterval|setTimeout/.test(server), 'nothing runs after a response (billed per request)');
});

test('the service worker: the app\'s own files under its own scope, never api/, only jars-* caches', () => {
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return/.test(sw));
  assert.ok(/url\.origin !== self\.location\.origin\) return/.test(sw));
  assert.ok(/url\.pathname\.indexOf\(scope\) !== 0\) return/.test(sw));
  assert.ok(/k\.indexOf\('jars-'\) === 0 && k !== CACHE/.test(sw));
  const shell = JSON.parse(/var SHELL = (\[[^\]]*\])/.exec(sw)[1].replace(/'/g, '"'));
  for (const f of shell.filter((x) => x !== './' && x !== 'gran')) assert.ok(fs.existsSync(path.join(ROOT, 'public', f)), `${f} is cached but missing`);
  for (const page of ['public/index.html', 'public/gran.html']) for (const [, f] of read(page).matchAll(/(?:src|href)="([^"#:]+)"/g)) if (f !== './') assert.ok(shell.includes(f), `${f} is loaded but not cached for offline`);
});

test('no model call anywhere: no SDK, no client, no metered route, no AI wording', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!Object.keys(pkg.dependencies || {}).some((d) => /anthropic|openai/i.test(d)), 'no model SDK is even installed');
  const files = ['server.js', 'lib/store.js', 'public/app.js', 'public/gran.js', 'public/jars-core.js', 'public/demo.js'];
  for (const f of files) {
    const s = read(f);
    assert.ok(!/require\(['"]@anthropic-ai|new Anthropic|messages\.create|identity\.meter\(|requireBudget|requireDailyCap|clientFor/.test(s), `${f} reaches for a model`);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'lib', 'ai.js')) && !fs.existsSync(path.join(ROOT, 'lib', 'fakeai.js')));
  // Every route the app itself defines is a GET; anything that writes is the shared account's.
  const own = app._router.stack.filter((l) => l.route).map((l) => [Object.keys(l.route.methods).join(','), l.route.path]);
  for (const [m, p] of own) assert.ok(m === 'get' || /^\/api\/auth\b/.test(String(p)), `${m} ${p}`);
  assert.ok(!/\bAI\b/.test(read('public/app.js').replace(/no AI/g, '')), 'no AI button or AI wording beyond "no AI"');
});

test('local-only switches throw on Cloud Run', () => {
  for (const [mod, env] of [['./lib/store', { JARS_MEMORY: '1' }], ['./server', { JARS_FAKE_AI: '1', JARS_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, JARS_MEMORY: '', JARS_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  assert.ok(/JARS_COLLECTION_PREFIX/.test(read('lib/store.js')), 'the prefix is read, ready for anything ever stored');
});

/* ---------------- over HTTP ---------------- */

let base;
const seen = [];

test('pages load with the lab\'s headers; the grandparents\' page is noindex and no-referrer', async () => {
  for (const f of ['', 'gran', 'jars-core.js', 'demo.js', 'app.js', 'gran.js', 'app.css', 'sw.js', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  const g = await fetch(`${base}/gran`);
  assert.strictEqual(g.headers.get('referrer-policy'), 'no-referrer');
  assert.match(g.headers.get('x-robots-tag'), /noindex/);
  assert.match(await g.text(), /<script src="gran\.js"><\/script>/);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.deepStrictEqual(h, { ok: true, stores: 'nothing', model: 'none' });
  assert.strictEqual((await fetch(`${base}/api/auth/me`)).status < 500, true, 'the shared account is mounted');
});

test('there is no route that takes a child, a jar, an amount or a model call', async () => {
  for (const p of ['/api/kids', '/api/family', '/api/jars', '/api/payday', '/api/sync', '/api/gift', '/api/snapshot', '/api/ai', '/api/chat', '/api/ask', '/api/read', '/api/look']) {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kids: [{ name: 'Maya' }] }) });
    assert.strictEqual(r.status, 404, p);
  }
  const big = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x'.repeat(20 * 1024) }) });
  assert.strictEqual(big.status, 413, 'a small body limit everywhere');
});

test('the grandparents\' link\'s fragment never reaches the server: it sees "/gran" and nothing after the #', async () => {
  const k = demoKid();
  const p = C.packSnapshot(k, { today: T, currency: 'GBP' });
  p.n = 'Fragmentmarker';
  const frag = await C.encodeSnapshot(p);
  const code = C.makeGift({ kid: 'Giftmarker', amount: '5', currency: 'GBP', today: T });
  const mark = seen.length;
  assert.strictEqual((await fetch(`${base}/gran#${frag}`)).status, 200);
  assert.strictEqual((await fetch(`${base}/#gift/${code}`)).status, 200);
  const got = seen.slice(mark);
  assert.deepStrictEqual(got.map((x) => x.url), ['/jars/gran', '/jars/']);
  const all = JSON.stringify(got);
  assert.ok(!all.includes(frag.slice(5, 30)) && !all.includes('v1.z') && !all.includes('g1.') && !all.includes('#'), 'no part of either in the request line or headers');
});

test('nothing is stored server-side: only the shared account, and nothing about a child', async () => {
  // An account, a few page loads and a link later:
  const r = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'parent.jars@example.com', password: 'a long enough password' }) });
  assert.strictEqual(r.status, 200);
  const dump = identityStore._dump();
  for (const m of ['Maya', 'Leo', 'Fragmentmarker', 'Giftmarker', 'LEGO', 'spend', 'pinMode', 'jars-family']) assert.ok(!dump.includes(m), `${m} was stored`);
  const cols = JSON.parse(dump).map(([p]) => p).sort();
  assert.ok(cols.every((c) => ['users', 'usage', 'events', 'control'].some((x) => c.toLowerCase().includes(x))), `only account collections: ${cols.join(', ')}`);
  assert.ok(!(await identityStore.list('usage')).length, 'and not one metered call');
  const src = read('server.js');
  assert.ok(!/store\.(set|merge|add|transact)\(/.test(src) && !/fs\.(write|append)/.test(src), 'the server has nowhere to write a child');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  // Everything the server is ever told, recorded, to prove what it never sees.
  hostApp.use((req, _res, next) => { seen.push({ url: req.originalUrl, headers: req.headers }); next(); });
  hostApp.use('/jars', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/jars`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
