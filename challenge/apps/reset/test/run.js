// The rules first - hand-worked rate changes and payments, each with its
// arithmetic written out, then the exact readers, days, the text doors,
// future resets, the batch, the notice, the one door for a book, the
// two-phone merge, the note request and its answer - then the demo's
// planted story, the storage module, the look, the page's promises and the
// copy, then end to end against the memory store and the fake model:
//   RESET_MEMORY=1 RESET_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /reset, the way
// the lab mounts it, so the auth cookie, the budget gate and each route's
// parser order are exercised as deployed. Model calls are counted from the
// identity usage rows, and what reached "the model" is read from the fake's
// own log.
//
// Every loan, lender and name here is made up. Phone, card, tax-id and
// account numbers are built from pieces, so no file carries any of them.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.RESET_MEMORY !== '1' || process.env.RESET_FAKE_AI !== '1') {
  console.error('run with RESET_MEMORY=1 RESET_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient, ownerTag } = require('../server');
const C = require('../public/reset-core');
const D = require('../public/demo');
const RS = require('../public/reset-store');
const img = require('../lib/image');
const aiLib = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
const ch = (n) => String.fromCharCode(n);
const RLO = ch(0x202E), FW_AT = ch(0xFF20);
const clone = (v) => JSON.parse(JSON.stringify(v));
// The models, from pieces: no file but server.js names one.
const FREE_MODEL = ['claude', 'haiku', '4', '5'].join('-'), PAID_MODEL = ['claude', 'sonnet', '5'].join('-');
const PHONE = ['555', '201', '3344'].join(' ');
const CARD = ['4111'].concat(Array(3).fill('1111')).join(' ');
const TAXID = ['123', '45', '6789'].join('-');
const ACCT = ['0044', '7122', '89'].join('');

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

/** A loan from form strings, defaults that bind nothing on their own. */
const BASE_FIELDS = { nick: 'Test duplex', rate: '6.5', start: '', bal: '200000.00', months: '300', index: '4.25', first: '0', date: '', name: '1-year CMT', margin: '2.75', round: 'nearest', step: '0.125', lookback: '45', every: '12', firstCap: '', periodicCap: '2', lifetimeCap: '', floor: '', ceiling: '', io: '0', payRound: 'nearest' };
function loanOf(f) { const r = C.loanFrom(Object.assign({}, BASE_FIELDS, f), 1); assert.deepStrictEqual(r.errors, [], JSON.stringify(f)); return r.loan; }
function worked(f) { const w = C.work(loanOf(f)); return { rate: C.fmtRate(w.rate), bound: w.bound, pay: C.fmtMoney(w.payment), w }; }

/* ================================================================== *
 * Hand-worked rate changes. Every payment below was worked separately
 * (to 80 digits) with P = B r / (1 - (1 + r)^-n), r = annual / 12, and
 * rounded once to the nearest cent, a half cent up.
 * ================================================================== */

test('hand-worked 1 - index + margin binds: 4.250% + 2.750% = 7.000%, on the eighth, inside the cap; $200,000.00 over 300 months is $1,413.56', () => {
  // fully indexed  4.250 + 2.750 = 7.000%
  // rounding       7.000 is a multiple of 0.125 - unchanged
  // periodic cap   6.500 +/- 2.000 = 4.500 .. 8.500 - 7.000 inside
  // payment        r = 0.07 / 12 = 0.0058333...; (1 + r)^300 = 5.7254182093...
  //                P = 200000 x 0.0058333... x 5.72541... / 4.72541... = 1413.5583945...
  //                -> $1,413.56
  const x = worked({});
  assert.deepStrictEqual([x.rate, x.bound, x.pay], ['7.000%', 'index+margin', '$1,413.56']);
  assert.strictEqual(x.w.fully, 700000);
  assert.strictEqual(x.w.change, 50000, '+0.500 points');
  assert.ok(x.w.steps.every((s) => !s.moved));
  assert.strictEqual(C.payment(20000000, 700000, 300).exact, '1,413.5583…');
});

test('hand-worked 2 - rounding binds: 4.31234% + 2.750% = 7.06234%, which is under the 7.0625% halfway mark, so nearest-eighth is 7.000%; rounded UP it is 7.125% and $1,429.55; an exact half rounds up', () => {
  // fully indexed  4.31234 + 2.75 = 7.06234%
  // nearest 1/8    halfway between 7.000 and 7.125 is 7.0625; 7.06234 < 7.0625 -> 7.000%
  // payment        same as case 1: $1,413.56
  const a = worked({ index: '4.31234' });
  assert.deepStrictEqual([a.rate, a.bound, a.pay], ['7.000%', 'rounding', '$1,413.56']);
  // rounded up     7.06234 -> 7.125%; r = 0.07125 / 12 = 0.0059375; (1 + r)^300 = 5.9060825072...
  //                P = 200000 x 0.0059375 x 5.90608... / 4.90608... = 1429.5464797... -> $1,429.55
  const b = worked({ index: '4.31234', round: 'up' });
  assert.deepStrictEqual([b.rate, b.bound, b.pay], ['7.125%', 'rounding', '$1,429.55']);
  // down           7.06234 -> 7.000%
  assert.strictEqual(worked({ index: '4.31234', round: 'down' }).rate, '7.000%');
  // the exact half 3.3125 + 2.75 = 6.0625 -> nearest rounds the half UP to 6.125%
  assert.strictEqual(worked({ index: '3.3125' }).rate, '6.125%');
  // negative values round on the number line: -0.0625 nearest -> 0.000, down -> -0.125
  assert.deepStrictEqual([C.roundRate(-6250, 'nearest', 12500), C.roundRate(-6250, 'down', 12500), C.roundRate(-6250, 'up', 12500)], [0, -12500, 0]);
  // not rounded    the fully indexed rate stands
  assert.strictEqual(worked({ index: '4.31234', round: 'none' }).rate, '7.06234%');
});

test('hand-worked 3 - the periodic cap binds, up and down: 5.100% + 2.750% = 7.850% -> 7.875%, held to 5.000% + 2 = 7.000% ($1,338.16 on $180,000.00 over 264); 2.000% + 2.750% = 4.750%, held to 7.000% - 1 = 6.000% ($1,074.65)', () => {
  // up             7.850 -> nearest eighth 7.875; cap 5.000 +/- 2.000 = 3.000 .. 7.000 -> 7.000%
  //                r = 0.0058333...; (1 + r)^264 = 4.6437662316...
  //                P = 180000 x 0.0058333... x 4.64377... / 3.64377... = 1338.1633818... -> $1,338.16
  const up = worked({ rate: '5', index: '5.1', bal: '180000.00', months: '264' });
  assert.deepStrictEqual([up.rate, up.bound, up.pay], ['7.000%', 'periodic cap', '$1,338.16']);
  assert.deepStrictEqual([up.w.rounded, up.w.lo, up.w.hi], [787500, 300000, 700000]);
  // down           4.750 on the eighth; cap 7.000 +/- 1.000 = 6.000 .. 8.000 -> 6.000%
  //                r = 0.005; (1.005)^240 = 3.3102044758...
  //                P = 150000 x 0.005 x 3.31020... / 2.31020... = 1074.6465877... -> $1,074.65
  const down = worked({ rate: '7', index: '2', bal: '150000.00', months: '240', periodicCap: '1' });
  assert.deepStrictEqual([down.rate, down.bound, down.pay], ['6.000%', 'periodic cap', '$1,074.65']);
  assert.strictEqual(down.w.change, -100000);
});

test('hand-worked 4 - a FIRST change: the first-change cap binds (3.250% + 2 = 5.250%, not the 7.000% index + margin gives, and not the 1-point periodic cap); with no first-change cap the periodic cap applies at the first change too', () => {
  // fully indexed  4.300 + 2.750 = 7.050% -> nearest eighth 7.000%
  // first change   cap 2.000 from 3.250: 1.250 .. 5.250 -> 5.250%  (the periodic 1.000 is NOT used now)
  // payment        r = 0.0525 / 12 = 0.004375; (1.004375)^300 = 3.7048295522...
  //                P = 250000 x 0.004375 x 3.70483... / 2.70483... = 1498.1192879... -> $1,498.12
  const f = worked({ rate: '3.25', start: '3.25', first: '1', firstCap: '2', periodicCap: '1', lifetimeCap: '5', index: '4.3', bal: '250000.00', months: '300' });
  assert.deepStrictEqual([f.rate, f.bound, f.pay], ['5.250%', 'first-change cap', '$1,498.12']);
  assert.match(f.w.steps.find((s) => s.rule === 'first-change cap').text, /periodic cap of 1\.000 pts applies from the next change/);
  // the same loan at a LATER change uses the periodic cap: 3.250 + 1.000 = 4.250%
  assert.deepStrictEqual([worked({ rate: '3.25', start: '3.25', first: '0', firstCap: '2', periodicCap: '1', index: '4.3' }).rate, worked({ rate: '3.25', start: '3.25', first: '0', firstCap: '2', periodicCap: '1', index: '4.3' }).bound], ['4.250%', 'periodic cap']);
  // no first-change cap: the periodic 1.000 holds the first change to 4.250%, named as the periodic cap
  const g = worked({ rate: '3.25', first: '1', firstCap: '', periodicCap: '1', index: '4.3' });
  assert.deepStrictEqual([g.rate, g.bound], ['4.250%', 'periodic cap']);
  assert.match(g.w.steps.find((s) => s.rule === 'periodic cap').text, /no separate first-change cap/);
});

test('hand-worked 5 - the lifetime cap binds: 6.600% + 2.750% = 9.350% -> 9.375%, inside the periodic cap (8.000 +/- 2), over 4.000% + 5 = 9.000%; $320,000.00 over 276 months is $2,749.66', () => {
  // fully indexed  9.350 -> nearest eighth 9.375
  // periodic       8.000 +/- 2.000 = 6.000 .. 10.000 -> 9.375 inside
  // lifetime       start 4.000 + 5.000 = 9.000 -> 9.000%
  // payment        r = 0.0075; (1.0075)^276 = 7.8638483256...
  //                P = 320000 x 0.0075 x 7.86385... / 6.86385... = 2749.6580760... -> $2,749.66
  const x = worked({ rate: '8', start: '4', lifetimeCap: '5', index: '6.6', bal: '320000.00', months: '276' });
  assert.deepStrictEqual([x.rate, x.bound, x.pay], ['9.000%', 'lifetime cap', '$2,749.66']);
});

test('hand-worked 6 - the ceiling binds when it is under the lifetime cap: the same loan with a stated maximum of 8.500% is 8.500% ($2,643.48); a ceiling above the lifetime cap leaves the lifetime cap binding', () => {
  // lifetime       9.000; ceiling 8.500 -> 8.500% (the lower limit wins, named as the ceiling)
  // payment        r = 0.085 / 12 = 0.0070833...; (1 + r)^276 = 7.0154058425...
  //                P = 320000 x 0.0070833... x 7.01541... / 6.01541... = 2643.4769311... -> $2,643.48
  const x = worked({ rate: '8', start: '4', lifetimeCap: '5', ceiling: '8.5', index: '6.6', bal: '320000.00', months: '276' });
  assert.deepStrictEqual([x.rate, x.bound, x.pay], ['8.500%', 'ceiling', '$2,643.48']);
  assert.strictEqual(worked({ rate: '8', start: '4', lifetimeCap: '5', ceiling: '9.5', index: '6.6' }).bound, 'lifetime cap');
  // a ceiling alone, no lifetime cap: 9.375 -> 9.000
  assert.deepStrictEqual([worked({ rate: '8', ceiling: '9', index: '6.6' }).rate, worked({ rate: '8', ceiling: '9', index: '6.6' }).bound], ['9.000%', 'ceiling']);
});

test('hand-worked 7 - the index goes below zero and the floor binds: -0.150% + 2.250% = 2.100% -> 2.125%, inside the cap (3.000 +/- 1), under the 2.500% floor -> 2.500%; $95,000.00 over 180 months is $633.45', () => {
  // fully indexed  -0.150 + 2.250 = 2.100% -> nearest eighth 2.125%
  // periodic       3.000 +/- 1.000 = 2.000 .. 4.000 -> 2.125 inside
  // floor          2.500 -> 2.500%
  // payment        r = 0.025 / 12 = 0.0020833...; (1 + r)^180 = 1.4544239574...
  //                P = 95000 x 0.0020833... x 1.45442... / 0.45442... = 633.4497485... -> $633.45
  const x = worked({ rate: '3', index: '-0.15', margin: '2.25', periodicCap: '1', floor: '2.5', bal: '95000.00', months: '180' });
  assert.deepStrictEqual([x.rate, x.bound, x.pay], ['2.500%', 'floor', '$633.45']);
  assert.strictEqual(x.w.fully, 210000);
  assert.ok(x.w.steps.find((s) => s.rule === 'floor').moved);
  // the floor wins over the periodic cap when they disagree: a current rate under the floor
  assert.deepStrictEqual([worked({ rate: '1', index: '-0.15', margin: '2.25', periodicCap: '0.5', floor: '2.5' }).rate, worked({ rate: '1', index: '-0.15', margin: '2.25', periodicCap: '0.5', floor: '2.5' }).bound], ['2.500%', 'floor']);
});

test('hand-worked 8 - the zero guard: -1.000% + 0.750% = -0.250% with no floor is 0.000%; the payment is B / n: $10,000.00 / 36 = 277.777... -> $277.78, and $12,000.00 / 120 = $100.00 exactly', () => {
  // fully indexed  -1.000 + 0.750 = -0.250%, not rounded, no cap, no floor -> 0.000% (zero guard)
  // payment        no interest: 10000 / 36 = 277.7777... -> $277.78
  const x = worked({ rate: '1', index: '-1', margin: '0.75', round: 'none', periodicCap: '', bal: '10000.00', months: '36' });
  assert.deepStrictEqual([x.rate, x.bound, x.pay, x.w.kind], ['0.000%', 'zero', '$277.78', 'zero']);
  assert.strictEqual(C.payment(1200000, 0, 120).cents, 10000);
  assert.strictEqual(C.payment(0, 500000, 120).cents, 0, 'a paid-off balance pays nothing');
  assert.throws(() => C.payment(100000, 500000, 0), /No months left/);
  assert.throws(() => C.payment(100000, -1, 12), /below zero/);
});

test('hand-worked 9 - interest-only: 3.375% + 2.750% = 6.125%; $150,000.00 x 0.06125 / 12 = 765.625 - a half cent, which rounds up to $765.63 (or up anyway); the payment that rounds UP to the cent', () => {
  // interest only  150000 x 0.06125 / 12 = 765.625 exactly -> nearest (half up) $765.63
  const x = worked({ rate: '6', index: '3.375', bal: '150000.00', io: '1' });
  assert.deepStrictEqual([x.rate, x.pay, x.w.kind], ['6.125%', '$765.63', 'io']);
  assert.strictEqual(x.w.paymentWas, 75000, 'was 150000 x 0.06 / 12 = $750.00');
  // payRound up    case 1's 1413.5583... rounds UP to $1,413.56; 1,074.6465... up to $1,074.65; 277.777... up to $277.78
  assert.strictEqual(C.payment(20000000, 700000, 300, { payRound: 'up' }).cents, 141356);
  // and a payment that is a whole number of cents is not pushed up: 12000 / 120 = 100.00
  assert.strictEqual(C.payment(1200000, 0, 120, { payRound: 'up' }).cents, 10000);
  // 1413.5583 to the nearest is .56 too; one where they differ: 1,338.1633 -> nearest .16, up .17
  assert.deepStrictEqual([C.payment(18000000, 700000, 264).cents, C.payment(18000000, 700000, 264, { payRound: 'up' }).cents], [133816, 133817]);
});

test('hand-worked 10 - twelve months paid between resets, each month\'s interest to the cent: $200,000.00 at 7.000% paying $1,413.56 leaves $196,940.37; the next reset re-amortises over 288 months', () => {
  // month 1        interest 200000.00 x 0.07 / 12 = 1166.666... -> 1166.67; principal 1413.56 - 1166.67 = 246.89; balance 199753.11
  // month 2        interest 199753.11 x 0.07 / 12 = 1165.2265... -> 1165.23; principal 248.33; balance 199504.78
  // ... (worked the same way, separately, for all twelve) -> 196940.37
  // reset 2       re-amortised: 196940.37 over 288 at 7.000% is again $1,413.56; twelve more months -> 193659.55
  assert.strictEqual(C.monthInterest(20000000, 700000), 116667);
  assert.strictEqual(C.monthInterest(19975311, 700000), 116523);
  const L = loanOf({ date: '2027-01-31' });
  const rows = C.future(L, { kind: 'flat', by: 0, list: [] }, 3);
  assert.deepStrictEqual(rows.map((r) => [r.day, C.fmtMoney(r.balance), r.months]), [['2027-01-31', '$200,000.00', 300], ['2028-01-31', '$196,940.37', 288], ['2029-01-31', '$193,659.55', 276]]);
  assert.strictEqual(rows[0].interest, rows[0].paid - (20000000 - 19694037), 'what was paid = interest + principal');
});

/* ================================================================== *
 * The rest of the rules
 * ================================================================== */

test('exact readers: rates digit by digit (7.125, 7 1/8, 1/8%, -0.15, +2) into units of 0.00001%; more than five decimals or an inexact fraction refused; money in cents; never parseFloat in the core', () => {
  const r = (s) => C.parseRate(s).v;
  assert.deepStrictEqual([r('7.125'), r('7 1/8'), r('1/8%'), r('-0.15'), r('+2'), r('0.1'), r('4.31234'), r('.5')], [712500, 712500, 12500, -15000, 200000, 10000, 431234, 50000]);
  assert.strictEqual(r('0.1') + r('0.2'), r('0.3'), 'no float drift');
  assert.match(C.parseRate('4.312345').error, /more than five decimals/);
  assert.match(C.parseRate('1/3').error, /not exact/);
  assert.ok(C.parseRate('seven').error && C.parseRate('').error && C.parseRate('1e3').error && C.parseRate('3.').error);
  assert.deepStrictEqual([C.parseMoney('$245,310.18').v, C.parseMoney('1234.5').v, C.parseMoney('0.07').v], [24531018, 123450, 7]);
  assert.ok(C.parseMoney('12,34.00').error && C.parseMoney('1.234').error && C.parseMoney('-5').error);
  assert.deepStrictEqual([C.fmtRate(712500), C.fmtRate(431234), C.fmtRate(-15000), C.fmtRate(0), C.fmtRate(700000)], ['7.125%', '4.31234%', '-0.150%', '0.000%', '7.000%']);
  assert.deepStrictEqual([C.fmtMoney(141356), C.fmtMoney(-8620), C.fmtMoney(5)], ['$1,413.56', '-$86.20', '$0.05']);
  assert.ok(!/parseFloat\(|parseInt\(|\.toFixed\(|Math\.pow\(/.test(read('public/reset-core.js')), 'no float path for money or a rate');
  assert.strictEqual(C.floorDiv(-7, 2), -4);
  assert.strictEqual(C.floorDiv(7, 2), 3);
});

test('days without a clock: months added with the day held or clamped (31 Jan + 1 = 28 Feb, 29 Feb in a leap year), the lookback in days, real days only', () => {
  assert.deepStrictEqual([C.addMonths('2027-01-31', 1), C.addMonths('2028-01-31', 1), C.addMonths('2026-12-01', 6), C.addMonths('2026-11-30', 3)], ['2027-02-28', '2028-02-29', '2027-06-01', '2027-02-28']);
  assert.deepStrictEqual([C.addDays('2026-12-01', -45), C.addDays('2027-03-01', -1)], ['2026-10-17', '2027-02-28']);
  assert.ok(C.isDay('2028-02-29') && !C.isDay('2027-02-29') && !C.isDay('2026-13-01') && !C.isDay('26-1-1'));
  assert.strictEqual(C.fmtDay('2026-12-01', true), 'December 1, 2026');
  const w = C.work(loanOf({ date: '2026-12-01', every: '6' }));
  assert.deepStrictEqual([w.lookbackDay, w.firstPayDay, w.nextChange], ['2026-10-17', '2027-01-01', '2027-06-01']);
});

test('loans by nickname only: a name (given, family, honorific, "Smith, J", "Borrower: ..."), nine digits, a tax id, an account-like run of six digits or "loan no. 123", an @, a phone, a link refused; nicknames like "Maple duplex 5/1" and "Pier 9 storage" pass', () => {
  for (const ok of ['Maple duplex 5/1', 'Pier 9 storage', 'Harbor St condo 7/1', 'Unit 12 - 2024 refi', 'Grant Ave fourplex', 'Kestrel 3/1 IO']) assert.strictEqual(C.nickProblem(ok), '', ok);
  const bad = ['John Smith', 'Linda', 'Mrs. Hale duplex', 'Garcia rental', 'Smith, J', 'Patel family loan', 'Borrower: Q', 'Loan ' + ACCT, 'Acct no. 4471', 'ID ' + TAXID, 'Dup ' + '987654', 'x' + AT + 'y', 'Call ' + PHONE, 'see loans.example.com', '=SUM(A1)', '<b>x</b>', 'Maple' + RLO, '', 'x'.repeat(41)];
  for (const b of bad) assert.ok(C.nickProblem(b), `refused: ${b}`);
  assert.match(C.nickProblem('John Smith'), /person’s name/);
  assert.match(C.nickProblem('Loan ' + ACCT), /number/);
  assert.match(C.nickProblem('Dup 987654'), /account or loan number/);
  // pasted note text: amounts and dates pass; names, account numbers, tax ids do not
  assert.strictEqual(C.pasteProblem(D.NOTE_TEXT), '');
  assert.strictEqual(C.pasteProblem('Principal $245,310.18, change date 12/01/2026 or 2026-12-01, margin 2.750%.'), '');
  for (const b of ['Borrower: Pat Q', 'Mr. Example agrees', 'Loan No. ' + ACCT, 'Loan number 4471-22', 'SSN ' + TAXID, 'Jennifer will pay', 'mail ' + AT + 'x', 'x'.repeat(6001)]) assert.ok(C.pasteProblem(b), `paste refused: ${b}`);
});

test('the form: every field read exactly and checked (ranges, floor under ceiling, a lifetime cap needs a start rate), fields round-trip', () => {
  const L = loanOf({ start: '5.875', lifetimeCap: '5', floor: '2.75', ceiling: '11', date: '2026-12-15' });
  assert.deepStrictEqual(C.loanFrom(C.fieldsOf(L), 1).loan, L, 'fields -> loan -> fields -> loan');
  const errs = (f) => C.loanFrom(Object.assign({}, BASE_FIELDS, f), 1).errors.map((e) => e.field);
  assert.deepStrictEqual(errs({ lifetimeCap: '5' }), ['start']);
  assert.deepStrictEqual(errs({ floor: '9', ceiling: '8' }), ['floor']);
  assert.deepStrictEqual(errs({ months: '0' }), ['months']);
  assert.deepStrictEqual(errs({ bal: 'lots' }), ['bal']);
  assert.deepStrictEqual(errs({ periodicCap: '25' }), ['periodicCap']);
  assert.deepStrictEqual(errs({ rate: '60' }), ['rate']);
  assert.deepStrictEqual(errs({ date: '2027-02-30' }), ['date']);
  assert.deepStrictEqual(errs({ nick: 'Linda Example', margin: '' }), ['nick', 'margin'], 'a bad nickname is named even beside a shape error');
});

test('future resets under a what-if path: flat, a step up each reset (the periodic cap and the lifetime cap play out), a step down to the floor, my own list (the last holds); the first change only once; stops when the months run out', () => {
  // Maple duplex 5/6: first change 5.250 (first-change cap); then +0.25 a reset on 4.300:
  // reset 1 index 4.550 + 2.750 = 7.300 -> 7.250, periodic 5.250 + 1 = 6.250 (periodic cap)
  // reset 2 index 4.800 -> 7.550 -> 7.500, 6.250 + 1 = 7.250 (periodic cap)
  // reset 3 index 5.050 -> 7.800 -> 7.750, 7.250 + 1 = 8.250, inside lifetime 3.250 + 5 = 8.250 -> 7.750 (rounding)
  // reset 4 index 5.300 -> 8.050 -> 8.000 (rounding)
  // reset 5 index 5.550 -> 8.300 -> 8.250, which IS the lifetime limit but rounding put it there (rounding)
  // reset 6 index 5.800 -> 8.550 -> 8.500, over 8.250 -> 8.250 (lifetime cap)
  const M = D.book().loans.lmaple0001;
  const up = C.future(M, { kind: 'step', by: 25000, list: [] }, 7);
  assert.deepStrictEqual(up.map((r) => [C.fmtRate(r.rate), r.bound]), [['5.250%', 'first-change cap'], ['6.250%', 'periodic cap'], ['7.250%', 'periodic cap'], ['7.750%', 'rounding'], ['8.000%', 'rounding'], ['8.250%', 'rounding'], ['8.250%', 'lifetime cap']]);
  assert.deepStrictEqual(up.map((r) => r.day).slice(0, 3), ['2026-12-01', '2027-06-01', '2027-12-01']);
  // down 2 points a reset: 2.300 + 2.75 = 5.050 -> 5.000 (rounding, inside 5.250 +/- 1); 0.300 -> 3.050 -> 3.000,
  // held to 5.000 - 1 = 4.000 (periodic); -1.700 -> 1.050 -> 1.000, held to 3.000 (periodic); -3.700 -> -0.950, held to 2.000, floor 2.750
  const down = C.future(M, { kind: 'step', by: -200000, list: [] }, 5);
  assert.deepStrictEqual(down.map((r) => [C.fmtRate(r.rate), r.bound]), [['5.250%', 'first-change cap'], ['5.000%', 'rounding'], ['4.000%', 'periodic cap'], ['3.000%', 'periodic cap'], ['2.750%', 'floor']]);
  const mine = C.future(M, { kind: 'list', by: 0, list: [350000, 300000] }, 4);
  assert.deepStrictEqual(mine.map((r) => r.index), [430000, 350000, 300000, 300000], 'the last value holds');
  const flat = C.future(M, C.defaultWhat(), 3);
  assert.ok(flat.every((r) => r.index === 430000));
  assert.ok(flat.slice(1).every((r) => r.balance < flat[0].balance), 'the balance is paid down between resets');
  const short = C.future(loanOf({ months: '20', every: '12' }), C.defaultWhat(), 10);
  assert.strictEqual(short.length, 2, '20 months: this change and one more');
  const io = C.future(loanOf({ io: '1', index: '3.375', rate: '6' }), C.defaultWhat(), 2);
  assert.strictEqual(io[1].balance, io[0].balance, 'interest-only pays no principal');
});

test('the batch from CSV: header in any order, quoted cells, per-row results and errors, a refused nickname never echoed, the template; results as CSV with every formula-starting cell quoted (a negative number left a number)', () => {
  const b = C.batch(D.CSV);
  assert.deepStrictEqual([b.ok, b.bad, b.rows.length], [5, 2, 7]);
  assert.deepStrictEqual(b.rows.filter((x) => !x.error).map((x) => [x.nick, C.fmtRate(x.res.rate), x.res.bound]), [['Birch Lane fourplex', '6.875%', 'periodic cap'], ['Willow Creek 5/6', '5.500%', 'first-change cap'], ['Granary lofts', '6.250%', 'periodic cap'], ['Ferry Street retail', '6.000%', 'rounding'], ['Aspen IO line', '6.125%', 'rounding']]);
  const refused = b.rows.find((x) => x.row === 6);
  assert.deepStrictEqual([refused.nick, /person’s name/.test(refused.error)], ['(refused nickname)', true]);
  assert.match(b.rows.find((x) => x.row === 7).error, /Margin is needed/);
  const out = C.batchCsv(b);
  assert.ok(!out.includes('Linda') && !out.includes('Example,'), 'the refused name never comes back out');
  assert.match(out, /^row,nickname,status,fully_indexed,rounded,new_rate,bound_by,rate_change,payment_at_current_rate,new_payment,payment_change,error\r\n/);
  assert.match(out, /4,Granary lofts,ok,5\.350,5\.375,6\.250,periodic cap,-1\.000,1146\.05,1059\.85,-86\.20,\r\n/);
  const q = C.batch('Nickname, Margin ,Balance,Rate,Months,Index\n"Lot 4, east",2.75,"100,000.00",5,120,3\n=cmd(),2,1000,5,12,3\n');
  assert.deepStrictEqual([q.ok, q.rows[0].nick, /formula/.test(q.rows[1].error)], [1, 'Lot 4, east', true]);
  assert.strictEqual(C.csvCell('=1+1'), "'=1+1");
  assert.strictEqual(C.csvCell('-0.150'), '-0.150');
  assert.strictEqual(C.csvCell('@x'), "'@x");
  assert.strictEqual(C.csvCell('a "b", c'), '"a ""b"", c"');
  assert.match(C.batch('nickname,balance\nx,1\n').error, /header needs rate, months, index and margin/);
  assert.ok(C.batch('x'.repeat(1024 * 1024 + 1)).error);
  assert.strictEqual(C.batch(C.TEMPLATE + 'Template row,1000,5,12,3,2.75,,,,,,,,,,\n').ok, 1, 'the template reads');
});

test('the draft notice: plain text, marked a draft and not legal advice; brackets for the borrower, the loan number and the phone (never filled); current and new rate and payment, the index as of the lookback day, the limit that applied; the nickname only when asked', () => {
  const M = D.book().loans.lmaple0001;
  const t = C.noticeText(M, C.work(M), { lender: D.NAME });
  for (const w of ['DRAFT - FOR REVIEW BEFORE SENDING. Not legal advice.', '[Borrower name and address]', '[Loan number]', '[phone number and hours]', 'Quillmere Community Bank', 'December 1, 2026', '3.250%         5.250%', '$1,218.29      $1,498.12', 'as of October 17, 2026 (45 days before the change date)', 'Because of the first-change cap, your new rate is 5.250% and not 7.000%.', '2.000 percentage points', 'first due on January 1, 2027', 'every 6 months']) assert.ok(t.includes(w), w);
  assert.ok(!t.includes('Maple'), 'no nickname unless asked');
  assert.ok(C.noticeText(M, C.work(M), { withNick: true }).includes('(internal nickname: Maple duplex 5/6)'));
  assert.ok(C.noticeText(M, C.work(M), {}).includes('[Lender name]'));
  const plain = loanOf({});
  assert.ok(C.noticeText(plain, C.work(plain), {}).includes('No limit in your loan changed the rate this time.'));
  assert.ok(!/[<>]/.test(t) && !t.includes(AT));
});

test('the one door for a book: strict refuses anything out of shape, whole (unknown fields, a float rate, a bad id, a refused nickname, a floor over the ceiling); lenient mends and drops; bodyProblem first', () => {
  const b = D.book();
  assert.deepStrictEqual(C.cleanBook(b, true).errors, []);
  const bad = [
    (x) => { x.extra = 1; }, (x) => { x.v = 2; }, (x) => { x.loans.lmaple0001.rate = 3.25; }, (x) => { x.loans.lmaple0001.borrower = 'x'; },
    (x) => { x.loans.lmaple0001.terms.notes = 'x'; }, (x) => { x.loans['../x'] = x.loans.lmaple0001; }, (x) => { x.loans.lmaple0001.nick = 'Linda Example'; },
    (x) => { x.loans.lmaple0001.terms.floor = 900000; }, (x) => { x.loans.lmaple0001.bal = -1; }, (x) => { x.loans.lmaple0001.what = { kind: 'moon' }; },
    (x) => { x.loans.lmaple0001 = { del: true, t: 5, nick: 'x' }; }, (x) => { x.loans.lmaple0001.t = '1'; },
  ];
  for (const f of bad) { const x = clone(b); f(x); assert.ok(C.cleanBook(x, true).errors.length, f.toString()); }
  const x = clone(b); x.loans.lmaple0001.nick = 'Linda Example'; x.loans.lharbor001.borrower = 'x';
  const lenient = C.cleanBook(x, false);
  assert.ok(!lenient.book.loans.lmaple0001 && lenient.book.loans.lharbor001 && !('borrower' in lenient.book.loans.lharbor001), 'the bad loan dropped, the unknown field mended away');
  assert.ok(C.bodyProblem({ a: ['x' + AT + 'y'] }) && C.bodyProblem({ a: TAXID.replace(/-/g, '') }) && C.bodyProblem({ a: 'x.example.com' }) && C.bodyProblem({ a: '<i>' }) && C.bodyProblem({ a: 'a' + RLO }));
  assert.strictEqual(C.bodyProblem(b), '');
});

test('two phones: each loan by its own time; a removal is a change; a loan both phones changed since they last agreed keeps both - the other as "(other phone)"; symmetric and idempotent, by hand and over 150 random pairs', () => {
  const base = D.book();
  const a = C.putLoan(base, 'lnewaaaa01', loanOf({ nick: 'Phone A loan' }), D.T + 10);
  const bb = C.removeLoan(C.putLoan(base, 'lnewbbbb01', loanOf({ nick: 'Phone B loan' }), D.T + 11), 'lcedar0001', D.T + 12);
  const m = C.merge(a, bb, D.T).book;
  assert.ok(m.loans.lnewaaaa01 && m.loans.lnewbbbb01 && m.loans.lcedar0001.del);
  const ea = clone(base); ea.loans.lmill00001.bal = 31900000; ea.loans.lmill00001.t = D.T + 20;
  const eb = clone(base); eb.loans.lmill00001.index = 650000; eb.loans.lmill00001.t = D.T + 30;
  const both = C.merge(ea, eb, D.T);
  assert.strictEqual(both.book.loans.lmill00001.index, 650000, 'the later change wins');
  assert.strictEqual(both.book.loans[C.copyIdOf('lmill00001')].nick, 'Mill building (other phone)');
  assert.strictEqual(both.notes.length, 1);
  assert.ok(!C.merge(ea, eb, D.T + 25).book.loans[C.copyIdOf('lmill00001')], 'changed on one phone since the base: no copy');
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const ids = Object.keys(base.loans);
  const mutate = (b0) => {
    let b = clone(b0);
    for (let i = 0; i < 3; i++) {
      const id = ids[rnd(ids.length)], t = D.T + 1 + rnd(50);
      if (rnd(4) === 0) b = C.removeLoan(b, id, t);
      else if (!b.loans[id].del) { const L = clone(b.loans[id]); L.index += 1250 * (1 + rnd(8)); b = C.putLoan(b, id, L, t); }
    }
    return b;
  };
  for (let i = 0; i < 150; i++) {
    const x = mutate(base), y = mutate(base);
    const xy = C.merge(x, y, D.T).book, yx = C.merge(y, x, D.T).book;
    assert.strictEqual(C.canon(xy), C.canon(yx), 'symmetric');
    assert.strictEqual(C.canon(C.merge(xy, xy, D.T).book), C.canon(xy), 'idempotent');
    assert.deepStrictEqual(C.cleanBook(xy, true).errors, [], 'passes the strict door');
  }
});

test('the note request is the photos alone or the pasted section alone - exactly {images} or {text}; anything else refused before a model call', () => {
  const im = { type: 'image/jpeg', data: 'A'.repeat(40) };
  assert.ok(C.termsRequest({ images: [im] }).req);
  assert.ok(C.termsRequest({ text: D.NOTE_TEXT }).req);
  for (const bad of [null, {}, [], { images: [] }, { images: [im, im, im] }, { images: [im], text: 'x' }, { images: [im], nick: 'Maple' }, { text: 5 }, { text: 'Borrower: Pat Q. margin 2.75%' }, { text: 'Loan No. ' + ACCT }, { images: [{ type: 'image/gif', data: im.data }] }, { images: [{ type: 'image/jpeg', data: 'not base64!!!!!!!!' }] }, { images: [Object.assign({ name: 'a.jpg' }, im)] }]) {
    assert.ok(C.termsRequest(bad).error, JSON.stringify(bad).slice(0, 60));
  }
  assert.strictEqual(C.termsRequest({ images: [im], nick: 'x' }).code, 'extra-field');
  assert.strictEqual(C.termsRequest({ text: 'Borrower: Pat Q' }).code, 'personal');
});

test('the reading checked: only the terms; a name, a loan number, a balance and advice dropped and named; every rate read exactly and in range (a 90% margin, "five-ish" dropped); form strings only - never a balance, rate, index value or nickname; nothing readable an error', () => {
  const good = C.cleanAiTerms(require('../lib/fakeai').GOOD);
  assert.deepStrictEqual(good.fields, { name: '30-day average SOFR', margin: '2.750', step: '0.125', firstCap: '2.000', periodicCap: '1.000', lifetimeCap: '5.000', floor: '2.750', round: 'nearest', lookback: '45', every: '6', io: '0' });
  assert.deepStrictEqual([good.unsure, good.dropped], [['ceiling'], []]);
  const bad = C.cleanAiTerms(Object.assign({}, require('../lib/fakeai').GOOD, { margin: '90%', lifetime_cap: 'five-ish points', borrower: 'Pat Example', loan_number: ACCT, balance: '$245,310.18', advice: 'Refinance now.', rounding: 'sideways', lookback_days: 900 }));
  assert.deepStrictEqual(bad.dropped.slice().sort(), ['advice', 'balance', 'borrower', 'lifetime_cap', 'loan_number', 'lookback_days', 'margin', 'rounding'].sort());
  assert.ok(!('margin' in bad.fields) && !('lifetimeCap' in bad.fields));
  for (const k of ['nick', 'rate', 'bal', 'index', 'months', 'start']) assert.ok(!(k in bad.fields), `never sets ${k}`);
  assert.ok(!JSON.stringify(bad).includes('Pat') && !JSON.stringify(bad).includes(ACCT));
  assert.ok(C.cleanAiTerms({ index_name: 'Linda Smith index', margin: '' }).error, 'a name as the index is dropped, and then nothing is left');
  assert.ok(C.cleanAiTerms({}).error && C.cleanAiTerms(null).error && C.cleanAiTerms({ margin: '', unsure: ['margin'] }).error);
});

test('the demo’s planted story: Quillmere Community Bank, seven loans, each a different rule binding - first-change cap 5.250% ($1,498.12), periodic cap, rounding, the floor after a negative index, the lifetime cap, the ceiling, interest-only $765.63; the example CSV; the example note read with its name, loan number and balance dropped', () => {
  const b = D.book();
  const got = C.liveLoans(b).map((L) => { const w = C.work(L); return [L.nick, C.fmtRate(w.rate), w.bound, C.fmtMoney(w.payment)]; });
  assert.deepStrictEqual(got, [
    ['Cedar Ridge lot', '2.500%', 'floor', '$633.45'], ['Harbor St condo 7/1', '7.000%', 'periodic cap', '$1,338.16'], ['Kestrel 3/1 IO', '6.125%', 'index+margin', '$765.63'],
    ['Maple duplex 5/6', '5.250%', 'first-change cap', '$1,498.12'], ['Mill building', '9.000%', 'lifetime cap', '$2,749.66'], ['Orchard six-plex', '7.000%', 'rounding', '$1,413.56'], ['Quarry Road warehouse', '8.500%', 'ceiling', '$2,643.48'],
  ]);
  assert.ok(b.loans.lcedar0001.index < 0, 'the Cedar Ridge index is below zero');
  assert.strictEqual(C.liveLoans(b).filter((L) => L.terms.io).length, 1);
  const r = C.cleanAiTerms(D.NOTE_RAW);
  assert.deepStrictEqual(r.dropped, ['borrower', 'loan_number', 'balance']);
  assert.ok(D.noteSvg().includes('made-up example') && D.NOTICE.includes('Made-up example'));
  assert.strictEqual(C.batch(D.CSV).bad, 2);
  assert.ok(D.book() !== D.book() && C.same(D.book(), D.book()), 'a fresh copy each time, the same each time');
});

test('storage: one module; the book through the one door; this phone’s lender name refused if it is a person or carries an @; IndexedDB wrapped - throwing, blocked or missing falls back to memory and says so', async () => {
  const s = RS.create(RS.memory());
  assert.strictEqual(await s.getBook(), null);
  const b = D.book(); b.loans.lmaple0001.borrower = 'x';
  await s.putBook(b);
  const back = await s.getBook();
  assert.ok(back.loans.lmaple0001 && !('borrower' in back.loans.lmaple0001), 'kept through the lenient door');
  await s.putDevice({ tour: true, lender: D.NAME, extra: 1 });
  assert.deepStrictEqual(await s.getDevice(), { tour: true, lender: D.NAME });
  await s.putDevice({ lender: 'Linda Example' });
  assert.strictEqual((await s.getDevice()).lender, '');
  await s.putDevice({ lender: 'x' + AT + 'bank' });
  assert.strictEqual((await s.getDevice()).lender, '');
  await s.putSync({ base: 'x', at: 5 });
  assert.deepStrictEqual(await s.getSync(), { base: null, at: 5 });
  const throwing = { open() { throw new Error('nope'); } };
  const t = RS.create(RS.idb('reset', throwing));
  await t.putBook(D.book());
  assert.ok((await t.getBook()).loans.lmaple0001, 'falls back to memory');
  assert.strictEqual(t.persistent(), false);
  const none = RS.create(RS.idb('reset', null));
  assert.strictEqual(none.persistent(), false);
  const blocked = { open() { const req = {}; setTimeout(() => req.onblocked && req.onblocked(), 0); return req; } };
  const bl = RS.create(RS.idb('reset', blocked));
  await bl.putDevice({ tour: true });
  assert.strictEqual((await bl.getDevice()).tour, true);
  assert.strictEqual(bl.persistent(), false);
});

test('every text colour holds 4.5:1 on its surface in both themes; the hero and its step card; the lab card (white text, 20+ in CIE Lab from every card, drop #66, the emoji); 44px targets; tables scroll in their own box; no sideways scroll; reduced motion', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  assert.deepStrictEqual(Object.keys(dark).sort(), Object.keys(light).sort(), 'every token has a dark value');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2', 'bar-bg', 'sticky', 'accent-soft', 'warn-bg', 'ok-bg', 'bad-bg', 'info-bg']) ok('text', bg);
    for (const bg of ['bg', 'card', 'card2', 'sticky', 'accent-soft']) { ok('muted', bg); ok('link', bg); ok('ink', bg); }
    ok('muted', 'info-bg'); ok('accent-ink', 'accent'); ok('bg', 'text'); ok('accent', 'card'); ok('ink', 'card2');
    for (const k of ['bad', 'warn', 'info', 'ok']) { ok(k, `${k}-bg`); ok(k, 'card'); ok(k, 'card2'); ok(k, 'bg'); }
  }
  assert.match(css, /\.hero \{[^}]*linear-gradient\(150deg, #4f3b00 0%, #6d5200 45%, #33475b 100%\)/);
  for (const bg of ['#4f3b00', '#6d5200', '#33475b']) for (const fg of ['#ffffff', '#fffaf0']) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}`);
  assert.ok(ratio('#4f3b00', '#fffaf0') >= 4.5 && ratio('#1f2328', '#ffffff') >= 4.5 && ratio('#8a1c1c', '#ffffff') >= 4.5 && ratio('#4f3b00', '#ffffff') >= 4.5, 'the step card');
  for (const sel of ['.btn', '.link-btn', '.seg button', '.chip', '.input, textarea.input, select.input', '.lrow', '.photobtn', '.checkrow']) assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: (4[4-9]|[5-9]\\d)px').test(css), `${sel}: 44px`);
  assert.ok(/details\.more > summary \{[^}]*min-height: 44px/.test(css) && /\.tabbar button \{[^}]*min-height: 60px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css) && /\.tablebox \{ overflow-x: auto; max-width: 100%;/.test(css));
  assert.ok(/@media \(prefers-reduced-motion: reduce\) \{\n {2}\*, \*::before, \*::after \{ animation: none !important; transition: none !important;/.test(css));
  const js = read('public/app.js');
  assert.strictEqual((js.match(/<table class="grid">/g) || []).length, 2);
  assert.strictEqual((js.match(/<div class="tablebox" tabindex="0" role="region"/g) || []).length, 2, 'every table in its own scrolling box');
  // The lab card.
  const LAB = require('../../../lab');
  const lab = LAB.get('reset');
  assert.ok(lab, 'Reset is in lab.js');
  assert.deepStrictEqual([lab.color, lab.color2, lab.dropped, lab.status, lab.emoji, lab.audience], ['#6f6303', '#2a301e', '2026-11-22', 'testing', '\u{1F4C8}', 'Servicing and loan-accounting teams at small banks and credit unions']);
  assert.strictEqual(lab.tagline, 'Every rate reset worked out from the note - new rate, new payment, which cap bit.');
  assert.ok(ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const other of LAB.APPS.filter((x) => x.slug !== 'reset')) {
    for (const c of [other.color, other.color2]) assert.ok(labDist(lab.color, c) >= 20 && labDist(lab.color2, c) >= 20, `away from ${other.slug} ${c}: ${labDist(lab.color, c).toFixed(1)} / ${labDist(lab.color2, c).toFixed(1)}`);
    assert.notStrictEqual(other.emoji, lab.emoji, `${other.slug} has the same emoji`);
  }
  assert.ok(labDist(lab.color, lab.color2) >= 20);
  assert.strictEqual(LAB.APPS.findIndex((x) => x.slug === 'reset') + 1, 66, 'drop #66');
  assert.strictEqual(lab.features.length, 4);
});

test('the page: relative links, no inline script or handlers, the banner, the chart emoji with no variation selector, storage only through reset-store.js, no clock or dice in the core or the demo, the requests it makes, the body shown is the body sent, every received string escaped, the tour', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  assert.ok(html.includes('\u{1F4C8}') && !html.includes('\u{1F4C8}\u{FE0F}'), 'the chart, no variation selector');
  const js = read('public/app.js');
  assert.ok(!js.includes('\u{FE0F}'));
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(js), 'the page touches no storage itself');
  for (const f of ['public/reset-core.js', 'public/demo.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon|indexedDB|WebSocket/.test(src), `${f} touches no network or storage`);
    assert.ok(!/Math\.random|Date\.now\(\)|new Date\(/.test(src), `${f} has no dice and no clock`);
  }
  const all = js + read('public/reset-core.js') + read('public/demo.js') + read('public/reset-store.js');
  assert.ok(!/eval\(|new Function|setTimeout\(['"]/.test(all), 'no eval of any kind');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/terms', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/me', 'api/sync'], 'the page asks for nothing else');
  assert.strictEqual((js.match(/\bfetch\(/g) || []).length, 2, 'two fetches: api() and the verify resend');
  assert.match(js, /api\('PUT', 'api\/sync', \{ data: bodyOf\(state\.book\), base:/);
  // "Read the note": the body built from what the sheet shows, and nothing else.
  assert.match(js, /if \(r\.mode === 'text'\) return \{ text: r\.text \};\n\s*return \{ images: \[1, 2\]\.filter\(function \(s\) \{ return r\.photos\[s\]; \}\)\.map\(function \(s\) \{ return \{ type: 'image\/jpeg', data: r\.photos\[s\]\.split\(','\)\[1\] \}; \}\) \};/);
  assert.match(js, /var sent = readBody\(\);\n\s*btn\.disabled = true;/);
  assert.match(js, /api\('POST', 'api\/ai\/terms', sent\)/);
  assert.match(js, /<img alt="The photo that will be sent" src="' \+ esc\(r\.photos\[s\]\) \+ '">/);
  assert.match(js, /What is sent: these photos of the note, shrunk on your phone - and nothing else\./);
  assert.match(js, /var k = Math\.min\(1, side \/ Math\.max\(img\.naturalWidth, img\.naturalHeight\)\);/, 'redrawn through a canvas');
  assert.match(js, /C\.pasteProblem\(r\.text\)/, 'pasted text checked on the phone too');
  assert.match(js, /Object\.keys\(res\.fields\)\.forEach\(function \(k\) \{ d\.fields\[k\] = res\.fields\[k\]; \}\);/, 'a reading only fills the form');
  assert.strictEqual((js.match(/type="email"/g) || []).length, 1, 'only the sign-in form asks for an email - the account holder’s own');
  assert.ok(!/type="tel"|autocomplete="(tel|street-address|address-line1|postal-code|cc-number|name|given-name|family-name)"/i.test(js + html));
  assert.ok(!/geolocation|getCurrentPosition|watchPosition/.test(all));
  assert.ok(!/navigator\.share\(\{[^}]*url:/.test(js), 'nothing shared as a link');
  assert.match(js, /download\('reset-results\.csv', C\.batchCsv\(state\.batch\), 'text\/csv'\)/, 'results exported from the phone');
  assert.match(js, /rd\.readAsText\(f\)/, 'the CSV read on the phone');
  // Every interpolation of something a person, the server or a model wrote goes through esc().
  const strip = (src) => { let out = ''; let i = 0; const re = /\besc\(/g; let m; while ((m = re.exec(src))) { if (m.index < i) continue; out += src.slice(i, m.index) + 'SAFE'; let depth = 0, j = m.index + m[0].length - 1; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; re.lastIndex = i; } return out + src.slice(i); };
  const risky = strip(js).split('\n').filter((l) => /</.test(l) && !/toast\(|confirm\(|prompt\(|copy\(|textContent|say\(/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(?!SAFE\b)([a-zA-Z_$][\w$]*(?:\.[\w$]+|\[[^\]]+\])*(?:\([^()]*\))?)\s*\+/g);
  const allowed = (r) => /\+\s*(?:[a-zA-Z]*Html(?:\([^()]*\))?|html|rows|steps|chips|body|seg|extra|input|res|dropped|readNote|dots|d|x\([^()]*\)|y\([^()]*\)|pl|pr|pt|pb|W|H|lim\([^()]*\)|ruleChip\([^()]*\)|ruleClass\([^()]*\)|fieldHtml\([^()]*\)|guideHtml\([^()]*\)|demoRibbon\(\)|mergeNoteHtml\(\)|syncLine\(\)|D\.noteSvg\(\)|k|o\[0\])\s*\+/.test(r);
  const bad = (risky || []).filter((r) => !allowed(r));
  assert.deepStrictEqual(bad, [], `unescaped: ${bad}`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bbrief\b|\bbook\b|\bimages?\b|\btext\b|\bdata\b)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /reset-shell-v1/.test(sw) && ['reset-core.js', 'reset-store.js', 'demo.js', 'app.js'].every((f) => sw.includes(`'${f}'`)) && /k\.indexOf\('reset-'\) === 0/.test(sw), 'the service worker caches only the app shell, never api/, and only clears its own caches');
  assert.match(js, /navigator\.serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
  // The tour: six steps, in order, each with its view and words.
  const tour = /var TOUR = \[([\s\S]*?)\n {2}\];/.exec(js)[1];
  assert.deepStrictEqual([...tour.matchAll(/view: '(\w+)'/g)].map((m) => m[1]), ['loans', 'loan', 'loan', 'loan', 'batch', 'edit']);
  for (const w of ['Open Maple duplex 5/6', 'Show the payment working', 'Index up ¼ point a reset', 'Draft the notice', 'Work out the example CSV', 'Read the example note', 'Add my first loan', '3.250% + 2 = 5.250%', '$1,498.12', 'not legal advice']) assert.ok(tour.includes(w), w);
  assert.match(js, /if \(n === 3\) \{ setWhat\(MAPLE, \{ kind: 'step', by: 25000, list: \[\] \}\);/);
  for (const v of ['loansHtml', 'loanHtml', 'editHtml', 'batchHtml', 'moreHtml']) assert.ok(new RegExp('function ' + v + '\\(\\) \\{[\\s\\S]{0,2500}?demoRibbon\\(\\)').test(js), `${v} carries the ribbon`);
  assert.match(js, /document\.addEventListener\('visibilitychange'[\s\S]{0,200}if \(signedIn\(\)\) syncIn\(\);/);
});

test('the copy: no bank, lender or brand name in any file; no invisible characters, key-shaped strings, email addresses, phone numbers or session links; model names only in MODELS; CLAUDE.md says it is a rebuild and documents the arithmetic', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.name === 'node_modules' ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const files = walk(ROOT).filter((x) => /\.(js|css|html|md|json|svg|webmanifest)$/.test(x) && !/package-lock/.test(x));
  assert.ok(files.length >= 20);
  const marks = [['Wells ', 'Fargo'], ['Chase ', 'Bank'], ['Bank of ', 'America'], ['Citi', 'bank'], ['U.S. ', 'Bank'], ['Fannie ', 'Mae'], ['Freddie ', 'Mac'], ['Navy ', 'Federal'], ['Pen', 'Fed'], ['Rocket ', 'Mortgage'], ['Quick', 'en'], ['Exc', 'el'], ['Black ', 'Knight'], ['Fis', 'erv'], ['Jack ', 'Henry'], ['Ellie ', 'Mae'], ['Encom', 'pass'], ['Bloom', 'berg'], ['Goo', 'gle'], ['Ama', 'zon'], ['Tru', 'ist'], ['Capital ', 'One'], ['Ally ', 'Bank'], ['Schw', 'ab']].map((p) => p.join(''));
  const markRe = new RegExp('(^|[^A-Za-z])(' + marks.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![A-Za-z])');
  assert.ok(markRe.test('a ' + marks[0] + ' loan') && !markRe.test('the excellent capital and one loan'), 'the check bites, and only where it should');
  const SESSION_LINK = new RegExp(['claude', 'ai/code'].join('\\.') + '|' + ['Claude', 'Session'].join('-'));
  const invisible = new RegExp('[' + [[0, 8], [11, 12], [14, 31], [0x7F, 0x9F], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2069], [0xFEFF, 0xFEFF]].map(([a, b]) => '\\u' + a.toString(16).padStart(4, '0') + '-\\u' + b.toString(16).padStart(4, '0')).join('') + ']');
  const phoneRe = /(^|[^\d.])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8'), rel = path.relative(ROOT, f);
    assert.ok(!invisible.test(src), `${rel} carries an invisible character`);
    if (!/lib\/(identity|stripe|byok|webauthn)/.test(f)) assert.ok(!/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\bsk-ant-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(src), `${rel} carries a key-shaped string`);
    if (!/^public\/(passkey-client|verify-banner|desktop)\.|^lib\/(identity|stripe|byok|webauthn|identity-store)\.js$/.test(rel)) {
      assert.ok(!markRe.test(src), `${rel} names a brand: ${(markRe.exec(src) || [])[2]}`);
      assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(src), `no email address in ${rel}`);
      assert.ok(!phoneRe.test(src), `no phone number in ${rel}: ${(phoneRe.exec(src) || [])[0]}`);
      assert.ok(!SESSION_LINK.test(src), `no session link in ${rel}`);
    }
  }
  const strings = JSON.stringify([D.book(), D.NOTE_RAW, D.NOTE_TEXT, D.noteSvg(), D.CSV, require('../lib/fakeai').GOOD]);
  assert.ok(!invisible.test(strings) && !markRe.test(strings), 'nor in what the demo and the fake make');
  const models = files.filter((f) => /claude-(haiku|sonnet|opus)/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f)).filter((f) => !/^lib\/identity/.test(f));
  assert.deepStrictEqual(models, ['server.js'], 'model names only in the MODELS constant');
  assert.ok(read('server.js').includes(`const MODELS = { free: '${FREE_MODEL}', paid: '${PAID_MODEL}' };`));
  assert.strictEqual((read('server.js').match(/claude-[a-z]+-[0-9]/g) || []).length, 2, 'once each');
  const doc = read('CLAUDE.md').replace(/\s+/g, ' ');
  assert.match(doc, /a rebuild of the 2026-11-13 drop/i);
  assert.match(doc, /HANDOFF\.md/);
  for (const w of ['a half rounds up', 'P = B × r ÷ (1 − (1 + r)^−n)', 'never carry over', '0.00001', 'whole cents']) assert.ok(doc.includes(w), `CLAUDE.md: ${w}`);
  for (const f of ['lib/identity.js', 'lib/identity-store.js', 'lib/byok.js', 'lib/stripe.js', 'lib/webauthn.js', 'public/desktop.css', 'public/passkey-client.js', 'public/verify-banner.js']) {
    assert.strictEqual(read(f), fs.readFileSync(path.join(ROOT, '..', 'ladle', f), 'utf8'), `${f} is the shared copy`);
  }
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*\n/gm, '').replace(/'[^'\n]*'/g, "''");
  assert.strictEqual(code(read('lib/image.js')), code(fs.readFileSync(path.join(ROOT, '..', 'ladle', 'lib', 'image.js'), 'utf8')), 'image.js is Ladle’s but for words');
});

test('local-only switches throw on Cloud Run; the lab prefix is read; one document per account, read by its id', () => {
  for (const [mod, env] of [['./lib/store', { RESET_MEMORY: '1' }], ['./lib/fakeai', { RESET_FAKE_AI: '1' }], ['./server', { RESET_FAKE_AI: '1', RESET_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, RESET_MEMORY: '', RESET_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, RESET_MEMORY: '', RESET_COLLECTION_PREFIX: 'reset_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'reset_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.ok(!/store\.list\(|orderBy/.test(server), 'no query: one document per account, by its id');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g))].sort(), ["store.get('books'", "store.transact('books'"]);
  assert.match(server, /update\('reset owner v1'\)/);
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
const BIG = { x: 'x'.repeat(1100 * 1024) };
const HUGE = { x: 'x'.repeat(5.5 * 1024 * 1024) };
/** The example with its times moved to now: a real phone stamps with its clock. */
function restamp(b, t) {
  const x = clone(b);
  x.t = t;
  for (const id of Object.keys(x.loans)) x.loans[id].t = t;
  return x;
}

/* ---- tiny images, by their bytes ---- */
function pngOf(w, h, extra) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), extra ? chunk('tEXt', Buffer.from(extra)) : Buffer.alloc(0), chunk('IDAT', Buffer.from('pixels')), chunk('IEND', Buffer.alloc(0))]);
}
function jpegOf(w, h, exif) {
  const seg = (m, data) => { const b = Buffer.alloc(4); b[0] = 0xff; b[1] = m; b.writeUInt16BE(data.length + 2, 2); return Buffer.concat([b, data]); };
  const sof = Buffer.alloc(15); sof[0] = 8; sof.writeUInt16BE(h, 1); sof.writeUInt16BE(w, 3); sof[5] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0')), exif ? seg(0xe1, Buffer.from('Exif\0\0' + exif)) : Buffer.alloc(0), seg(0xc0, sof), seg(0xda, Buffer.from([1, 2, 3])), Buffer.from('scan data'), Buffer.from([0xff, 0xd9])]);
}
function webpOf(w, h, exif) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32LE(data.length); return Buffer.concat([Buffer.from(type, 'latin1'), len, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const vp8x = Buffer.alloc(10); vp8x[0] = exif ? 0x08 : 0; vp8x.writeUIntLE(w - 1, 4, 3); vp8x.writeUIntLE(h - 1, 7, 3);
  const vp8l = Buffer.alloc(9); vp8l[0] = 0x2f; vp8l.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1);
  const body = Buffer.concat([chunk('VP8X', vp8x), chunk('VP8L', vp8l), exif ? chunk('EXIF', Buffer.from(exif)) : Buffer.alloc(0)]);
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}
const im = (buf, type) => ({ type: type || 'image/jpeg', data: buf.toString('base64') });
const pagesOf = (...ims) => ({ images: ims });

test('images by their bytes: JPEG, PNG and WebP sniffed, their metadata (EXIF, text, location) stripped, their size read; each of two photos checked; anything else refused', () => {
  const j = img.cleanJpeg(jpegOf(1200, 900, 'GPS 51.5N'));
  assert.deepStrictEqual(j.size, { width: 1200, height: 900 });
  assert.ok(!j.buf.includes(Buffer.from('Exif')) && !j.buf.includes(Buffer.from('GPS')));
  const p = img.cleanPng(pngOf(800, 600, 'Comment\0scanned at the branch'));
  assert.ok(!p.buf.includes(Buffer.from('scanned at')));
  const w = img.cleanWebp(webpOf(640, 480, 'GPS 51.5N'));
  assert.ok(!w.buf.includes(Buffer.from('GPS')) && !(w.buf[20] & 0x08));
  const brief = aiLib.brief(pagesOf(im(jpegOf(1600, 1200, 'GPS')), im(pngOf(900, 600, 'Comment\0back'), 'image/png')));
  assert.deepStrictEqual(Object.keys(brief), ['images'], 'the photos alone');
  assert.strictEqual(brief.images.length, 2);
  assert.ok(!Buffer.from(brief.images[0].data, 'base64').includes(Buffer.from('GPS')) && !Buffer.from(brief.images[1].data, 'base64').includes(Buffer.from('back')));
  assert.throws(() => aiLib.brief(pagesOf(im(jpegOf(100, 100)), im(jpegOf(2400, 1200)))), /too large/, 'the second photo is checked too');
  assert.throws(() => aiLib.brief(pagesOf(im(pngOf(10, 10), 'image/jpeg'))), /JPEG, PNG or WebP/);
  assert.deepStrictEqual(aiLib.brief({ text: D.NOTE_TEXT }), { text: D.NOTE_TEXT });
});

test('signed out: the page and its files load with zero model calls; sync and the AI answer 401 before reading a body; no other route takes or hosts a loan', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.ok(meta.rounding.includes('nearest') && meta.rules.includes('periodic cap'));
  for (const f of ['reset-core.js', 'reset-store.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  const shell = await page.text();
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/sync'], ['PUT', '/api/sync'], ['DELETE', '/api/sync'], ['POST', '/api/ai/terms']]) assert.strictEqual((await anon(m, p, m === 'GET' || m === 'DELETE' ? undefined : { ok: 1 })).status, 401, `${m} ${p}`);
  for (const [m, p] of [['PUT', '/api/sync'], ['POST', '/api/ai/terms']]) assert.strictEqual((await anon(m, p, HUGE)).status, 401, `${p}: the gate answers before the parser, so never 413`);
  for (const p of ['/api/loan', '/api/loans', '/api/batch', '/api/notice', '/api/rate', '/api/share', '/api/csv', '/api/ai/card']) {
    assert.strictEqual((await anon('POST', p, { x: 1 })).status, 404, `POST ${p}`);
    assert.strictEqual((await anon('GET', p)).status, 404, `GET ${p}`);
  }
  for (const p of ['/l/abc', '/loan', '/batch']) assert.strictEqual(await (await fetch(`${base}${p}`)).text(), shell, `${p} is only the app shell`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('writes come from this page: another site’s request (Sec-Fetch-Site or Origin) is 403 and a body that is not JSON 415, before anything else', async () => {
  const ana = await register('ana.sameorigin');
  const b = restamp(D.book(), Date.now());
  assert.strictEqual((await ana('PUT', '/api/sync', { data: b, base: null }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await ana('PUT', '/api/sync', { data: b, base: null }, { 'Sec-Fetch-Site': 'same-site' })).status, 403, 'a sibling subdomain is another site here');
  assert.strictEqual((await ana('PUT', '/api/sync', { data: b, base: null }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await ana('POST', '/api/ai/terms', { text: D.NOTE_TEXT }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await ana('PUT', '/api/sync', 'data=1', { 'Content-Type': 'text/plain' })).status, 415);
  assert.strictEqual((await ana('DELETE', '/api/sync', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const same = await ana('PUT', '/api/sync', { data: b, base: null }, { 'Sec-Fetch-Site': 'same-origin', Origin: base.replace(/\/reset$/, '') });
  assert.strictEqual(same.status, 200, same.text);
});

test('the gates come before each parser, in order; one model call site; Haiku free, Sonnet members via planFor; one forced tool with no field for a person, a number or an amount; max_tokens 400 with the arithmetic shown', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/terms', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/sync', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js'), ai = read('lib/ai.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((ai.match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(ai, /tool_choice: \{ type: 'tool', name: TOOL\.name \}/);
  assert.match(ai, /max_tokens: 400,/);
  assert.match(ai, /That is 280 for a reading filled to every cap, rounded up: 400\./, 'the arithmetic is shown');
  assert.strictEqual(15 + 5 + 7 * (8 + 6) + 7 + 8 + 9 + 7 + 71 + 60, 280, 'and it adds up');
  const props = Object.keys(aiLib.TOOL.input_schema.properties);
  assert.ok(!props.some((k) => /name$|^(borrower|person|address|loan|account|balance|payment|amount|rate|index_value|nick)/.test(k) && k !== 'index_name'), 'no field for a person, a number or an amount: ' + props);
  assert.deepStrictEqual(aiLib.TOOL.input_schema.required.slice().sort(), props.slice().sort());
  assert.match(src, /express\.json\(\{ limit: '1mb' \}\)/);
  assert.match(src, /express\.json\(\{ limit: '5mb' \}\)/);
});

test('sync: the book follows the account to the other phone; a stale phone gets 409 with the account copy and merges - a loan added on each phone both kept; bodies out of shape or personal refused whole; ~400 KB; 120 saves in ten minutes; filed under an HMAC', async () => {
  const a = await register('phone.one');
  assert.deepStrictEqual((await a('GET', '/api/sync')).data, { data: null, updatedAt: null });
  const b0 = restamp(D.book(), Date.now() - 60000);
  const put = await a('PUT', '/api/sync', { data: b0, base: null });
  assert.strictEqual(put.status, 200, put.text);
  const v1 = put.data.updatedAt;
  assert.ok(C.same(put.data.data, b0), 'saved as sent');
  const b = client();
  assert.strictEqual((await b('POST', '/api/auth/login', { email: mail('phone.one'), password: 'a long enough password' })).status, 200);
  const onB = (await b('GET', '/api/sync')).data;
  assert.strictEqual(onB.updatedAt, v1);
  const bEdit = C.putLoan(onB.data, 'lbbbbbbb01', loanOf({ nick: 'Second phone loan' }), Date.now());
  assert.strictEqual((await b('PUT', '/api/sync', { data: bEdit, base: v1 })).status, 200);
  const aEdit = C.putLoan(b0, 'laaaaaaa01', loanOf({ nick: 'First phone loan' }), Date.now() + 5);
  const stale = await a('PUT', '/api/sync', { data: aEdit, base: v1 });
  assert.deepStrictEqual([stale.status, stale.data.code], [409, 'conflict']);
  assert.ok(stale.data.data.loans.lbbbbbbb01, 'the 409 carries the account copy');
  const merged = C.merge(aEdit, stale.data.data, v1).book;
  const again = await a('PUT', '/api/sync', { data: merged, base: stale.data.updatedAt });
  assert.strictEqual(again.status, 200, again.text);
  const final = (await b('GET', '/api/sync')).data.data;
  assert.ok(final.loans.lbbbbbbb01 && final.loans.laaaaaaa01, 'both phones’ changes survived');
  assert.strictEqual((await a('PUT', '/api/sync', { data: merged, base: null })).status, 409, 'a phone that never synced cannot overwrite');
  const cur = (await a('GET', '/api/sync')).data;
  const variants = [
    ['an unknown field', (x) => { x.lender = 'x'; }],
    ['a borrower field', (x) => { x.loans.lmaple0001.borrower = 'Pat'; }],
    ['a personal name as a nickname', (x) => { x.loans.lmaple0001.nick = 'Jennifer Example'; }],
    ['an honorific', (x) => { x.loans.lmaple0001.nick = 'Mrs. Hale'; }],
    ['an account number as a nickname', (x) => { x.loans.lmaple0001.nick = 'Loan ' + ACCT; }],
    ['six digits in a nickname', (x) => { x.loans.lmaple0001.nick = 'Dup 987654'; }],
    ['a tax id', (x) => { x.loans.lmaple0001.terms.name = 'SOFR ' + TAXID; }],
    ['an @', (x) => { x.loans.lmaple0001.nick = 'ask ' + AT + 'x'; }],
    ['a full-width @', (x) => { x.loans.lmaple0001.nick = 'x' + FW_AT + 'y'; }],
    ['nine Arabic-Indic digits', (x) => { x.loans.lmaple0001.terms.name = ch(0x0662).repeat(9); }],
    ['a link', (x) => { x.loans.lmaple0001.terms.name = 'see rates.example.com'; }],
    ['a formula', (x) => { x.loans.lmaple0001.nick = '=HYPERLINK("x")'; }],
    ['markup', (x) => { x.loans.lmaple0001.nick = '<img src=x>'; }],
    ['an invisible character', (x) => { x.loans.lmaple0001.nick = 'Maple' + RLO; }],
    ['a float rate', (x) => { x.loans.lmaple0001.rate = 3.25; }],
    ['a rate out of range', (x) => { x.loans.lmaple0001.rate = 6000000; }],
    ['a floor over the ceiling', (x) => { x.loans.lcedar0001.terms.floor = 1000000; }],
    ['a time as a string', (x) => { x.loans.lmaple0001.t = '12'; }],
    ['a bad loan id', (x) => { x.loans['../x'] = x.loans.lmaple0001; }],
  ];
  for (const [what, f] of variants) {
    const x = clone(cur.data); f(x);
    const r = await a('PUT', '/api/sync', { data: x, base: cur.updatedAt });
    assert.strictEqual(r.status, 400, `${what}: ${r.text.slice(0, 200)}`);
  }
  assert.strictEqual((await a('PUT', '/api/sync', { data: cur.data, base: cur.updatedAt, photo: 'x' })).status, 400, 'nothing beside the book and its base');
  const big = clone(cur.data);
  for (let i = 0; i < 600; i++) big.loans['lbig' + String(i).padStart(4, '0')] = loanOf({ nick: 'Big one ' + i + ' with a long nickname' });
  const tooBig = await a('PUT', '/api/sync', { data: big, base: cur.updatedAt });
  assert.ok([400, 413].includes(tooBig.status), 'too many loans, or too much: ' + tooBig.status);
  assert.strictEqual((await a('PUT', '/api/sync', BIG)).status, 413, 'over the parser, after the sign-in');
  assert.strictEqual((await a('GET', '/api/sync')).data.updatedAt, cur.updatedAt, 'nothing was saved');
  const dump = store._dump();
  assert.ok(!dump.includes('phone.one') && !dump.includes(uidOf(mail('phone.one'))), 'filed under an HMAC, never the account id or address');
  assert.ok(dump.includes(ownerTag(uidOf(mail('phone.one')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  const doc = Object.values(JSON.parse(dump).find(([p]) => p === 'books')[1]).map(([, d]) => d).find((d) => d.book.loans.lbbbbbbb01);
  assert.deepStrictEqual(Object.keys(doc).sort(), ['book', 'owner', 'updatedAt']);
  assert.deepStrictEqual(Object.keys(doc.book).sort(), ['loans', 't', 'v']);
  const other = await register('someone.else');
  assert.deepStrictEqual((await other('GET', '/api/sync')).data.data, null, 'another account sees nothing of it');
  assert.strictEqual((await a('DELETE', '/api/sync')).status, 200);
  const removed = await b('PUT', '/api/sync', { data: final, base: 5 });
  assert.deepStrictEqual([removed.status, removed.data.code], [409, 'removed'], 'removed on the other phone says so');
  const r = await register('busy.desk');
  const mini = C.newBook(Date.now());
  let at = null, last = 0;
  for (let i = 0; i < 121; i++) { const res = await r('PUT', '/api/sync', { data: mini, base: at }); last = res.status; if (res.status === 200) at = res.data.updatedAt; else break; }
  assert.strictEqual(last, 429, 'the 121st save in ten minutes waits');
});

test('the AI over HTTP: exactly {images} or {text} - anything else, personal text and non-images refused with no model call; the model saw the photos stripped (or the pasted section) and one fixed sentence - no loan, no nickname; one forced tool; a name, a loan number, a balance and advice dropped; 422, 502, 503, 413', async () => {
  const ana = await register('ana.note');
  const calls = await modelCalls();
  const good = pagesOf(im(jpegOf(1600, 1200, 'GPS 51.5N branch')));
  const bad = [
    {}, [], { images: [] },
    Object.assign({}, good, { loan: D.book().loans.lmaple0001 }),
    Object.assign({}, good, { nick: 'Maple duplex 5/6' }),
    Object.assign({}, good, { text: D.NOTE_TEXT }),
    { text: 'Borrower: Pat Q. Margin 2.750%.' }, { text: 'Loan No. ' + ACCT + ' margin 2.75%' }, { text: 'SSN ' + TAXID }, { text: 'Call ' + PHONE }, { text: 'x' + AT + 'y' }, { text: '' }, { text: 'x'.repeat(6001) },
    pagesOf(im(Buffer.from('not a photo at all'))),
    pagesOf({ type: 'image/gif', data: good.images[0].data }),
    pagesOf({ type: 'image/png', data: good.images[0].data }),
    pagesOf(Object.assign({ name: 'note.jpg' }, good.images[0])),
    pagesOf(im(jpegOf(2400, 1600))),
    pagesOf(good.images[0], good.images[0], good.images[0]),
    pagesOf({ type: 'image/jpeg', data: Buffer.alloc(1.6 * 1024 * 1024, 7).toString('base64') }),
  ];
  for (const x of bad) {
    const r = await ana('POST', '/api/ai/terms', x);
    assert.strictEqual(r.status, 400, JSON.stringify(x).slice(0, 80) + ' ' + r.text.slice(0, 200));
  }
  assert.strictEqual((await ana('POST', '/api/ai/terms', Object.assign({}, good, { nick: 1 }))).data.code, 'extra-field');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  for (const [buf, type] of [[pngOf(900, 700, 'Comment\0secret'), 'image/png'], [webpOf(1000, 800, 'GPS 51.5N'), 'image/webp']]) {
    const ok = await ana('POST', '/api/ai/terms', pagesOf(im(buf, type)));
    assert.strictEqual(ok.status, 200, `${type}: ${ok.text.slice(0, 200)}`);
  }
  const n0 = fakeClient.calls.length;
  const dumpBefore = store._dump();
  const r = await ana('POST', '/api/ai/terms', good);
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.data.fields.margin, '2.750');
  assert.deepStrictEqual([r.data.fields.periodicCap, r.data.fields.every, r.data.unsure, r.data.dropped], ['1.000', '6', ['ceiling'], []]);
  const txt = await ana('POST', '/api/ai/terms', { text: D.NOTE_TEXT });
  assert.strictEqual(txt.status, 200, txt.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 4, 'one call each, metered');
  const sent = fakeClient.calls[n0];
  assert.strictEqual(sent.model, FREE_MODEL);
  assert.deepStrictEqual(sent.tool_choice, { type: 'tool', name: 'record_rate_terms' });
  assert.strictEqual(sent.tools.length, 1);
  assert.strictEqual(sent.max_tokens, 400);
  assert.strictEqual(sent.messages.length, 1);
  const content = sent.messages[0].content;
  assert.deepStrictEqual(content.map((x) => x.type), ['image', 'text']);
  assert.strictEqual(content[1].text, 'Read the rate-change terms in this page of a loan note.', 'one fixed sentence');
  assert.ok(!Buffer.from(content[0].source.data, 'base64').includes(Buffer.from('GPS')), 'the photo’s metadata stripped');
  const tsent = fakeClient.calls[n0 + 1].messages[0].content;
  assert.deepStrictEqual(tsent.map((x) => x.type), ['text']);
  assert.strictEqual(tsent[0].text, aiLib.TEXT.text + '\n\n----- NOTE SECTION START -----\n' + D.NOTE_TEXT + '\n----- NOTE SECTION END -----', 'the fixed sentence and the pasted section, nothing else');
  assert.ok(!/Maple|Quillmere|ana\.note/.test(JSON.stringify(sent)), 'nothing of the book or the account');
  assert.strictEqual(store._dump(), dumpBefore, 'nothing stored');
  fakeClient.mode = 'bad';
  const b = await ana('POST', '/api/ai/terms', good);
  assert.strictEqual(b.status, 200, b.text);
  assert.ok(!/Pat|Refinance|245,310|4471/.test(b.text), b.text.slice(0, 500));
  assert.deepStrictEqual(b.data.dropped.slice().sort(), ['advice', 'balance', 'borrower', 'lifetime_cap', 'loan_number', 'margin'].sort(), b.data.dropped.join(' | '));
  fakeClient.mode = 'inject';
  const inj = await ana('POST', '/api/ai/terms', good);
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<b>|ignore your|\u202e/i.test(inj.text), inj.text.slice(0, 300));
  assert.deepStrictEqual([inj.data.fields.name, inj.data.dropped], ['SOFR', ['admin', 'note']], 'markup and a bidi override mended out of a reading; the extra fields named, never echoed');
  fakeClient.mode = 'blank';
  const blank = await ana('POST', '/api/ai/terms', good);
  assert.deepStrictEqual([blank.status, /Nothing on that page/.test(blank.data.error)], [422, true]);
  fakeClient.mode = 'maxtokens';
  const mt = await ana('POST', '/api/ai/terms', good);
  assert.deepStrictEqual([mt.status, /ran long/.test(mt.data.error)], [502, true]);
  fakeClient.mode = 'upstream401';
  const up = await ana('POST', '/api/ai/terms', good);
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  fakeClient.mode = 'upstream529';
  const busy = await ana('POST', '/api/ai/terms', good);
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  const big = await ana('POST', '/api/ai/terms', HUGE);
  assert.deepStrictEqual([big.status, /too much/.test(big.data.error)], [413, true]);
});

test('the gates: an unconfirmed free account 403 verify-email with its resend link, out of credit 402, the day’s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register('eve.unconfirmed');
  const good = { text: D.NOTE_TEXT };
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/ai/terms', good);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/reset/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/ai/terms', HUGE)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ai/terms', good)).status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/terms', HUGE)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const today = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-reset-${today}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/terms', good);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/terms', HUGE)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-reset-${today}`); }
});

test('a hostile pass leaves nothing personal in the store: refused bodies, injected answers, the note photo and the pasted text never land; what is kept holds no email, phone, tax id, account number, name, markup or account id', async () => {
  const h = await register('hostile.pass');
  const s = restamp(D.book(), Date.now());
  const tries = [
    (x) => { x.loans.lmaple0001.nick = 'Call ' + PHONE; },
    (x) => { x.loans.lmaple0001.nick = 'mail ' + mail('dana'); },
    (x) => { x.loans.lmaple0001.terms.name = 'Card ' + CARD; },
    (x) => { x.loans.lmaple0001.nick = '<script>alert(1)</script>'; },
    (x) => { x.loans.lmaple0001.nick = 'Ring ' + ch(0x0967).repeat(9); },
    (x) => { x.loans.lmaple0001.nick = 'Patricia Example'; },
    (x) => { x.loans.lmaple0001.nick = 'Acct ' + ACCT; },
  ];
  for (const f of tries) { const x = clone(s); f(x); assert.strictEqual((await h('PUT', '/api/sync', { data: x, base: null })).status, 400); }
  assert.strictEqual((await h('PUT', '/api/sync', { data: s, base: null })).status, 200);
  fakeClient.mode = 'bad';
  await h('POST', '/api/ai/terms', pagesOf(im(jpegOf(300, 200, 'GPS 51.5N'))));
  await h('POST', '/api/ai/terms', { text: D.NOTE_TEXT });
  const dump = store._dump();
  assert.ok(!dump.includes(AT) && !dump.includes('example.com'), 'no email');
  assert.ok(![PHONE, CARD, TAXID, ACCT, '<script', 'Exif', 'GPS', 'base64', 'Patricia', 'Pat Example', 'NOTE SECTION', 'Change Dates'].some((x) => dump.includes(x)), 'no phone, card, tax id, account number, markup, name, reading, photo or pasted text');
  assert.ok(!dump.includes(uidOf(mail('hostile.pass'))), 'no account id');
  for (const [, docs] of JSON.parse(dump)) for (const [, d] of docs) assert.deepStrictEqual(Object.keys(d).sort(), ['book', 'owner', 'updatedAt'], 'only books are kept');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/reset', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/reset`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
