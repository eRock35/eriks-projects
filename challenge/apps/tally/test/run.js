// Pure rules first, then end to end against the memory store and the fake
// model:
//   TALLY_MEMORY=1 TALLY_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /tally, the way the
// lab mounts it, so the auth cookie, the budget gate, per-person scoping and
// the two big-body routes are exercised as deployed. Model calls are counted
// from the identity's usage rows - the same rows that bill a real account.

// The fixtures assume the week of 2026-09-26 (Tally's x-local-date is only
// believed within a day of the server's clock; Chaser's collected streak is
// counted in real weeks), so from Monday 2026-09-28 the suite failed on the
// calendar, not on the code. The clock is pinned to that day, running
// forward from there, before anything reads it - Receipt's fix.
{
  const RealDate = Date;
  const offset = RealDate.parse('2026-09-26T15:00:00Z') - RealDate.now();
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  };
}

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.TALLY_MEMORY !== '1' || process.env.TALLY_FAKE_AI !== '1') {
  console.error('run with TALLY_MEMORY=1 TALLY_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const R = require('../public/rules');
const ai = require('../lib/ai');
const { demo, DAYS, DEPOSITS, SETTINGS, TODAY, actualNet } = require('../lib/demo');

let base;
const TODAY_HDR = '2026-09-26';
function client() {
  const cookies = {};
  return async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-local-date': TODAY_HDR, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
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

const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15)); // the meter writes usage rows fire-and-forget
const jpeg = (s = '') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(s), Buffer.alloc(2000, 7)]).toString('base64');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const SQUARE = R.settingsOf({ processor: 'square', feeBps: 260, feeFixedCents: 15, windowDays: 1 });
const day = (date, gross, tx, extra = {}) => ({ date, grossCents: gross, txCount: tx, refundsCents: 0, tipsCents: 0, ...extra });
const net = (d, s = SQUARE) => R.expected(d, s).net;
const dep = (id, date, amountCents, description = 'SQUARE INC') => ({ id, date, amountCents, description });

/* ---------------- money ---------------- */

test('cents: typed money is read digit by digit, never through a float', () => {
  const cases = [['$1,284.50', 128450], ['1284.5', 128450], [1284.5, 128450], ['0.1', 10], [0.1 + 0.2, 30], ['1.005', 101], ['1.004', 100],
    ['.5', 50], ['5.', 500], ['$ 12', 1200], ['12,345,678.90', 1234567890], ['USD 3.10', 310], ['1,23', null], ['abc', null], ['', null], [NaN, null], [1e21, null], ['.', null]];
  for (const [v, want] of cases) assert.strictEqual(R.toCents(v), want, JSON.stringify(v));
  assert.strictEqual(R.toCents('-40'), null, 'negatives refused by default');
  assert.deepStrictEqual(['-40', '(12.00)', '40-', '$-1.50'].map((v) => R.toCents(v, true)), [-4000, -1200, -4000, -150]);
  // Thirty 10-cent lines add to exactly $3.00, where floats give 2.9999999999999996.
  let sum = 0; for (let i = 0; i < 30; i++) sum += R.toCents('0.10');
  assert.strictEqual(sum, 300);
  assert.deepStrictEqual([R.money(128450), R.money(-1200), R.money(5), R.money(0)], ['$1,284.50', '−$12.00', '$0.05', '$0.00']);
  assert.deepStrictEqual([R.money0(128450), R.moneyShort(84200), R.moneyShort(128450), R.moneyShort(1234567), R.plain(-705)], ['$1,285', '$842', '$1.3k', '$12k', '-7.05']);
  assert.deepStrictEqual([R.toBps('2.6'), R.toBps('2.49'), R.toBps('.5'), R.toBps('2.499'), R.toBps('abc')], [260, 249, 50, null, null]);
});

test('fee model: % of sales and tips plus a fee per transaction, in whole cents', () => {
  const e = R.expected(day('2026-09-22', 128450, 96, { tipsCents: 11025 }), SQUARE);
  // 139475 * 2.6% = 3626.35 -> 3626; + 96 * 15 = 1440
  assert.deepStrictEqual([e.charged, e.fee, e.net], [139475, 3626 + 1440, 139475 - 5066]);
  const r = R.expected(day('2026-09-22', 100000, 10, { refundsCents: 2500 }), SQUARE);
  assert.strictEqual(r.net, 100000 - 2500 - (2600 + 150), 'refunds come out of the payout; no fee back');
  assert.strictEqual(R.expected(day('2026-09-22', 0, 0), SQUARE).fee, 0);
  const sumup = R.settingsOf({ processor: 'sumup', feeBps: 275, feeFixedCents: 0 });
  assert.strictEqual(R.expected(day('2026-09-22', 10000, 50), sumup).fee, 275);
  assert.ok(R.PRESETS.every((p) => Number.isInteger(p.feeBps) && Number.isInteger(p.feeFixedCents) && [1, 2, 3].includes(p.windowDays) && p.note), 'every preset is complete');
  assert.strictEqual(R.feeText(SQUARE), '2.6% + 15¢');
  assert.deepStrictEqual([R.tolerance(10000, SQUARE), R.tolerance(200000, SQUARE)], [200, 1000], '$2, or 0.5% when larger');
});

/* ---------------- the calendar ---------------- */

test('settlement windows: weekends and bank holidays roll forward', () => {
  const h = R.holidays(2026);
  assert.deepStrictEqual(Object.keys(h), ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25']);
  assert.ok(!h['2026-07-03'] && !h['2026-07-04'], 'July 4, 2026 is a Saturday: the Fed does not close on Friday');
  assert.strictEqual(R.holidayName('2022-12-26'), 'Christmas Day (observed)', 'a Sunday holiday is observed Monday');
  assert.strictEqual(R.holidayName('2027-12-24'), null, 'a Saturday Christmas moves to no Friday');
  const s1 = SQUARE;
  assert.strictEqual(R.dueBy('2026-09-22', s1), '2026-09-23', 'Tue -> Wed');
  assert.strictEqual(R.dueBy('2026-09-18', s1), '2026-09-21', 'Fri -> Mon');
  assert.strictEqual(R.dueBy('2026-09-19', s1), '2026-09-21', 'Sat -> Mon');
  assert.strictEqual(R.dueBy('2026-09-20', s1), '2026-09-21', 'Sun -> Mon');
  assert.strictEqual(R.dueBy('2026-09-04', s1), '2026-09-08', 'Fri before Labor Day -> Tue');
  assert.strictEqual(R.dueBy('2026-11-25', s1), '2026-11-27', 'Thanksgiving skipped');
  assert.strictEqual(R.dueBy('2026-12-24', R.settingsOf({ windowDays: 3 })), '2026-12-30', 'three business days over Christmas and a weekend');
  assert.strictEqual(R.dueBy('2026-07-02', s1), '2026-07-03');
  assert.deepStrictEqual(R.holidaysBetween('2026-09-05', '2026-09-08').map((x) => x.name), ['Labor Day']);
  assert.deepStrictEqual([R.isoDay('2026-02-30'), R.isoDay('2026-02-28'), R.isoMonth('2026-13'), R.addMonths('2026-12', 1), R.dayShort('2026-09-22')], [null, '2026-02-28', null, '2027-01', 'Tue, Sep 22']);
});

/* ---------------- matching ---------------- */

test('matching: matched, short, pending, missing and nothing-due, each with its reason', () => {
  const days = [
    day('2026-09-14', 110000, 80),           // Mon: paid Tue, exact
    day('2026-09-15', 120000, 90),           // Tue: paid Wed, $86.40 short
    day('2026-09-16', 130000, 95),           // Wed: due Thu, nothing -> missing (today Sat)
    day('2026-09-18', 0, 0),                 // Fri: no card sales
    day('2026-09-25', 140000, 100),          // Fri: due Mon -> pending
  ];
  const deps = [dep('a', '2026-09-15', net(days[0]) - 3), dep('b', '2026-09-16', net(days[1]) - 8640)];
  const r = R.reconcile(days, deps, SQUARE, '2026-09-26');
  assert.deepStrictEqual(r.rows.map((x) => x.status), ['matched', 'short', 'missing', 'none', 'pending']);
  const [mt, sh, mi, no, pe] = r.rows;
  assert.ok(/landed Tuesday, Sep 15: .* Books balanced\./.test(R.explain(r, mt)), R.explain(r, mt));
  assert.ok(/\$86\.40 \(7\.\d%\) short/.test(R.explain(r, sh)), R.explain(r, sh));
  assert.strictEqual(sh.shortfall, 8640);
  assert.ok(/Wednesday’s \$1,300\.00 in card sales should have landed by Thursday, Sep 17; nothing yet\./.test(R.explain(r, mi)), R.explain(r, mi));
  assert.ok(/newest deposit on file is from Sep 16 — add newer bank lines first/.test(R.explain(r, mi)), 'says the bank lines may just be missing');
  assert.strictEqual(R.explain(r, no), 'No card sales recorded, so nothing is owed.');
  assert.ok(/should land by Monday, Sep 28: .*that’s normal/.test(R.explain(r, pe)), R.explain(r, pe));
  // On the due date itself it is still pending; the day after, missing.
  assert.strictEqual(R.reconcile([days[4]], [], SQUARE, '2026-09-28').rows[0].status, 'pending');
  assert.strictEqual(R.reconcile([days[4]], [], SQUARE, '2026-09-29').rows[0].status, 'missing');
});

test('matching: a weekend batched into one Monday deposit, a holiday, a late deposit and a split payout', () => {
  const days = [day('2026-09-04', 150000, 110), day('2026-09-05', 190000, 140), day('2026-09-06', 170000, 128), day('2026-09-07', 140000, 100), day('2026-09-08', 115000, 90)];
  const batch = days.slice(0, 4).reduce((a, d) => a + net(d), 0);
  const r = R.reconcile(days, [dep('b', '2026-09-08', batch - 2), dep('t', '2026-09-09', net(days[4]))], SQUARE, '2026-09-26');
  assert.deepStrictEqual(r.rows.map((x) => x.status), ['matched', 'matched', 'matched', 'matched', 'matched']);
  assert.strictEqual(r.groups.length, 2);
  assert.deepStrictEqual(r.groups[0].dates, ['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07']);
  assert.strictEqual(r.rows.slice(0, 4).reduce((a, x) => a + x.paid, 0), batch - 2, 'the day shares add up to the deposit exactly');
  assert.ok(/Paid together with Sat, Sep 5, Sun, Sep 6 and Mon, Sep 7|Paid together with Sat, Sep 5 and Sun, Sep 6 and Mon, Sep 7/.test(R.explain(r, r.rows[0])), R.explain(r, r.rows[0]));
  assert.ok(/Labor Day pushed it to Tuesday/.test(R.explain(r, r.rows[0])));
  // A deposit three business days late still matches, and says so.
  const late = R.reconcile([days[4]], [dep('l', '2026-09-14', net(days[4]))], SQUARE, '2026-09-26');
  assert.strictEqual(late.rows[0].status, 'matched');
  assert.ok(/It came 3 business days later than usual/.test(R.explain(late, late.rows[0])), R.explain(late, late.rows[0]));
  // A payout split into two transfers.
  const n = net(days[4]);
  const split = R.reconcile([days[4]], [dep('x', '2026-09-09', 60000), dep('y', '2026-09-09', n - 60000)], SQUARE, '2026-09-26');
  assert.deepStrictEqual([split.rows[0].status, split.groups[0].deposits.length, split.unplaced.length], ['matched', 2, 0]);
  // A deposit nothing explains stays unplaced rather than forcing a match.
  const odd = R.reconcile([days[4]], [dep('z', '2026-09-09', 9999)], SQUARE, '2026-09-26');
  assert.deepStrictEqual([odd.rows[0].status, odd.unplaced.length], ['missing', 1]);
});

test('matching: an exact deposit claims its day before a short one can take it', () => {
  // Wed's deposit (on Thu) is short; Thu's (on Fri) is exact. Thursday's
  // sales look a lot like Wednesday's, so a greedy matcher would hand the
  // short deposit to Thursday.
  const wed = day('2026-09-16', 124375, 94); const thu = day('2026-09-17', 118000, 90);
  const r = R.reconcile([wed, thu], [dep('w', '2026-09-17', net(wed) - 8640), dep('t', '2026-09-18', net(thu))], SQUARE, '2026-09-26');
  assert.deepStrictEqual(r.rows.map((x) => x.status), ['short', 'matched']);
  // ...and a same-day deposit is the unlikely reading.
  const r2 = R.reconcile([wed, thu], [dep('w', '2026-09-17', net(thu) + 2000)], SQUARE, '2026-09-19');
  assert.strictEqual(R.rowOf(r2, '2026-09-16').status !== 'pending', true);
});

test('fee creep hides inside the allowance, and is named anyway', () => {
  const r = R.reconcile(DAYS, DEPOSITS, SETTINGS, TODAY);
  const c = R.feeCreep(r);
  assert.ok(c, 'creep found');
  assert.strictEqual(c.since, '2026-09-14');
  assert.ok(c.toRate - c.fromRate > 0.0025 && c.toRate - c.fromRate < 0.0035, `${c.fromRate} -> ${c.toRate}`);
  assert.ok(c.monthlyCents > 10000 && c.monthlyCents < 16000, String(c.monthlyCents));
  assert.ok(R.rowOf(r, '2026-09-15').status === 'matched' && r.groups.find((g) => g.dates.includes('2026-09-15')).feeHigh, 'still "matched", fee flagged high');
  // A flat rate is not creep.
  const flat = DAYS.slice(0, 14);
  const flatDeps = flat.map((d, i) => dep(`f${i}`, R.dueBy(d.date, SETTINGS), R.expected(d, SETTINGS).net));
  assert.strictEqual(R.feeCreep(R.reconcile(flat, flatDeps, SETTINGS, TODAY)), null);
});

test('streaks and heatmap buckets', () => {
  const rows = ['matched', 'matched', 'short', 'matched', 'none', 'matched', 'pending'].map((status) => ({ status }));
  assert.deepStrictEqual(R.streak(rows), { current: 3, best: 3 });
  assert.deepStrictEqual(R.streak([{ status: 'matched' }, { status: 'missing' }]), { current: 0, best: 1 });
  assert.deepStrictEqual(R.streak([]), { current: 0, best: 0 });
  assert.deepStrictEqual(['matched', 'short', 'missing', 'pending', 'none', null].map(R.bucket), ['green', 'amber', 'red', 'grey', 'zero', 'empty']);
  const r = R.reconcile(DAYS, DEPOSITS, SETTINGS, TODAY);
  const m = R.month(r, '2026-09');
  assert.strictEqual(m.cells.length, 30);
  assert.strictEqual(m.lead, 2, 'September 2026 starts on a Tuesday');
  assert.deepStrictEqual(m.cells.slice(0, 5).map((c) => c.bucket), ['empty', 'empty', 'empty', 'empty', 'green']);
  assert.deepStrictEqual(['2026-09-16', '2026-09-22', '2026-09-25', '2026-09-26'].map((d) => m.cells.find((c) => c.date === d).bucket), ['amber', 'red', 'grey', 'empty']);
  assert.ok(m.cells.find((c) => c.date === '2026-09-27').future);
});

test('the sample café tells the story it says it does - with zero model calls', () => {
  const d = demo();
  const st = d.summary.statuses;
  assert.strictEqual(Object.keys(st).length, 21, 'three weeks');
  assert.strictEqual(st['2026-09-16'], 'short');
  assert.strictEqual(st['2026-09-22'], 'missing');
  assert.strictEqual(st['2026-09-25'], 'pending');
  assert.strictEqual(Object.values(st).filter((s) => s === 'matched').length, 18);
  assert.deepStrictEqual(d.summary.streak, { current: 2, best: 11 });
  assert.strictEqual(d.summary.creep.since, '2026-09-14');
  const m = R.month(R.reconcile(d.days, d.deposits, d.settings, d.today), '2026-09');
  assert.strictEqual(m.totals.unaccounted, R.rowOf(R.reconcile(d.days, d.deposits, d.settings, d.today), '2026-09-22').net + m.attention.find((x) => x.status === 'short').shortfall);
  // The late payout, once added, balances Tuesday and lengthens the streak.
  const after = R.reconcile(d.days, d.deposits.concat([d.lateDeposit]), d.settings, d.today);
  assert.strictEqual(R.rowOf(after, '2026-09-22').status, 'matched');
  assert.deepStrictEqual(R.streak(after.rows), { current: 8, best: 11 });
  assert.strictEqual(d.lateDeposit.amountCents, actualNet(d.days.find((x) => x.date === '2026-09-22')));
  // The sample's bank export: the payouts and the late one picked out; cash,
  // a Zelle and payments out are not.
  const p = R.parseBankCsv(d.csv, d.settings.keywords);
  assert.deepStrictEqual([p.cards, p.rows.length, p.skipped.outflows], [14, 17, 4]);
  assert.ok(p.rows.filter((x) => !x.processor).every((x) => /MOBILE DEPOSIT|ZELLE/.test(x.description)));
  assert.ok(/Copper Kettle Coffee/.test(d.business) && !/@/.test(JSON.stringify(d)), 'fictional, no addresses');
});

/* ---------------- bank CSV in, CSV out ---------------- */

test('bank CSVs: Chase, Bank of America, Wells Fargo (no header), a credit union with Debit/Credit', () => {
  const kw = R.DEFAULT_KEYWORDS;
  const chase = 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n' +
    'CREDIT,09/23/2026,"SQUARE INC DES:SQ260923 ID:T3B7 INDN:MY CAFE",1248.87,ACH_CREDIT,9000.00,\n' +
    'DEBIT,09/23/2026,RENT PAYMENT,-3200.00,ACH_DEBIT,7751.13,\n' +
    'CREDIT,09/22/2026,MOBILE DEPOSIT CASH,400.00,DEPOSIT,10951.13,\n';
  const c = R.parseBankCsv(chase, kw);
  assert.deepStrictEqual(c.rows.map((r) => [r.date, r.amountCents, r.processor]), [['2026-09-23', 124887, 'Square'], ['2026-09-22', 40000, null]]);
  assert.strictEqual(c.skipped.outflows, 1);
  const boa = 'Description,,Summary Amt.\nBeginning balance as of 09/01/2026,,"5,000.00"\n\nDate,Description,Amount,Running Bal.\n' +
    '09/15/2026,"STRIPE TRANSFER ST-8H2K","2,104.55","7,104.55"\n09/16/2026,"TOASTED BAGEL CO REFUND",12.00,"7,116.55"\n09/16/2026,"CLOVER DEP 555",880.10,"7,996.65"\n';
  const b = R.parseBankCsv(boa, kw);
  assert.deepStrictEqual(b.rows.map((r) => [r.date, r.amountCents, r.processor]), [['2026-09-16', 88010, 'Clover'], ['2026-09-16', 1200, null], ['2026-09-15', 210455, 'Stripe']], 'summary lines skipped; TOASTED is not TOAST');
  const wf = '"09/21/2026","5408.55","*","","SQUARE INC SQ260921 MERCH DEP"\n"09/21/2026","-118.40","*","","CITY WATER"\n"09/18/2026","1376.98","*","","SQ *PAYOUT 0918"\n';
  const w = R.parseBankCsv(wf, kw);
  assert.deepStrictEqual(w.rows.map((r) => [r.date, r.amountCents, r.processor]), [['2026-09-21', 540855, 'Square'], ['2026-09-18', 137698, 'Square']]);
  const cu = 'Transaction Date,Posted Date,Memo,Debit,Credit,Balance\n2026-09-10,2026-09-11,HEARTLAND PMT SYS BANKCARD,,"1,020.00",5000\n2026-09-11,2026-09-12,SYSCO,250.00,,4750\n';
  const u = R.parseBankCsv(cu, kw);
  assert.deepStrictEqual(u.rows.map((r) => [r.date, r.amountCents, r.processor]), [['2026-09-11', 102000, 'Heartland']], 'posting date: when it arrived');
  const semi = 'Date;Description;Amount\n2026-09-10;SUMUP PAYOUT;99,00\n2026-09-11;SUMUP PAYOUT;150.00\n';
  assert.strictEqual(R.parseBankCsv(semi, kw).rows.length, 1, 'semicolons; a decimal comma is not guessed at');
  assert.ok(R.parseBankCsv('hello world\nthis is not a statement', kw).error);
  assert.ok(R.parseBankCsv('', kw).error);
  const twice = R.parseBankCsv(chase + 'CREDIT,09/23/2026,"SQUARE INC DES:SQ260923 ID:T3B7 INDN:MY CAFE",1248.87,ACH_CREDIT,1,\n', kw);
  assert.strictEqual(twice.skipped.duplicates, 1, 'the same line twice in one file counts once');
  assert.deepStrictEqual([R.processorOf('POS SQ *COFFEE', kw).label, R.processorOf('SQUAREFOOT REALTY', kw), R.processorOf('PAYPAL *ZETTLE', kw).label], ['Square', null, 'PayPal']);
  assert.ok(R.parseBankCsv('Date,Description,Amount\n09/10/2026,<script>alert(1)</script>SQUARE,10.00\n', kw).rows[0].description.indexOf('<') < 0, 'markup stripped');
});

test('CSV export: formula injection is defused, our own numbers stay numbers', () => {
  assert.strictEqual(R.csvCell('=HYPERLINK("http://x","click")'), '"\'=HYPERLINK(""http://x"",""click"")"');
  for (const v of ['+1', '-2+3', '@SUM(A1)', '\tx', '\rx']) assert.ok(R.csvCell(v).replace(/^"/, '').startsWith('\''), JSON.stringify(v));
  assert.strictEqual(R.csvCell('-12.34', true), '-12.34');
  assert.strictEqual(R.csvCell('-12.34'), '\'-12.34', 'text that only looks like a number is still text');
  assert.strictEqual(R.csvCell('-1+cmd|', true), '\'-1+cmd|', 'a "number" flag is not a free pass');
  assert.strictEqual(R.csvCell('a,b'), '"a,b"');
  const days = [day('2026-09-22', 100000, 10)];
  const r = R.reconcile(days, [dep('e', '2026-09-23', net(days[0]), '=cmd|\' /C calc\'!A0')], SQUARE, '2026-09-26');
  const csv = R.exportCsv(r, '2026-09');
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[0].startsWith('Date,Weekday,Card sales'));
  assert.ok(lines[1].includes(',\'=cmd|'), lines[1]);
  assert.ok(lines[1].includes(',-0.00,') === false && lines[1].includes(',0.00,'), 'difference written as a number');
  assert.ok(/,Matched,/.test(lines[1]));
});

test('validation: days, deposits and settings', () => {
  assert.strictEqual(R.validateDay({ date: '2026-09-22', gross: '1,284.50', tx: '96' }, TODAY).day.grossCents, 128450);
  assert.strictEqual(R.validateDay({ date: '2026-09-28', gross: '10', tx: 1 }, TODAY).field, 'date', 'not in the future');
  assert.strictEqual(R.validateDay({ date: '2026-09-22', gross: '10' }, TODAY).field, 'tx', 'transactions needed when there are sales');
  assert.strictEqual(R.validateDay({ date: '2026-09-22', gross: '10', tx: 1.5 }, TODAY).field, 'tx');
  assert.strictEqual(R.validateDay({ date: '2026-09-22', gross: '-10', tx: 1 }, TODAY).field, 'gross');
  assert.strictEqual(R.validateDay({ date: '2026-09-22', gross: '10', refunds: '20', tx: 1 }, TODAY).field, 'refunds');
  assert.strictEqual(R.validateDay({ date: '2026-09-22', gross: '0' }, TODAY).day.txCount, 0, 'a closed-with-no-cards day is fine');
  assert.strictEqual(R.validateDay({ date: '2025-01-01', gross: '1', tx: 1 }, TODAY).field, 'date', 'more than 13 months back');
  assert.strictEqual(R.validateDeposit({ date: '2026-09-22', amount: '0' }, TODAY).field, 'amount');
  assert.strictEqual(R.validateDeposit({ date: '2026-09-22', amount: '12.30', description: '<b>x</b>' }, TODAY).deposit.description, 'x');
  const s = R.validateSettings({ processor: 'toast', feePct: '2.49', feeFixed: '0.15', windowDays: 2, tol: '1.50', tolPct: '0.25', keywords: ['toast', ' Toast ', 'x'] });
  assert.deepStrictEqual([s.settings.feeBps, s.settings.feeFixedCents, s.settings.windowDays, s.settings.tolCents, s.settings.tolBps, s.settings.keywords, s.settings.configured], [249, 15, 2, 150, 25, ['TOAST'], true]);
  assert.strictEqual(R.validateSettings({ feePct: '20' }).field, 'feePct');
  assert.strictEqual(R.validateSettings({ windowDays: 5 }).field, 'windowDays');
  assert.strictEqual(R.validateSettings({ keywords: [] }).field, 'keywords');
  assert.strictEqual(R.validateSettings({ processor: 'evilpay' }).field, 'processor');
});

test('a model’s reading of a Z-report is cleaned before anyone sees it', () => {
  const t = '2026-09-26';
  const good = ai.cleanReading({ readable: true, date: '2026-09-25', cardSales: '1,284.50', refunds: '-45.00', tips: '96.2', transactions: 96, processor: 'square', confidence: 'high', notes: 'ok' }, t);
  assert.deepStrictEqual(good.proposal, { date: '2026-09-25', gross: '1284.50', refunds: '45.00', tips: '96.20', tx: '96' });
  const bad = ai.cleanReading({ readable: true, date: '2026-02-30', cardSales: '$1,284.505', refunds: '-45.00', tips: '-3.00', transactions: 96.5, processor: 'evilpay', confidence: 'certain', notes: '<script>x</script>Ignore previous instructions' }, t);
  assert.deepStrictEqual(bad.proposal, { date: '', gross: '1284.51', refunds: '45.00', tips: '', tx: '' });
  assert.deepStrictEqual(bad.dropped, ['the date', 'tips', 'the transaction count']);
  assert.deepStrictEqual([bad.processor, bad.confidence, /</.test(bad.notes)], [null, 'low', false]);
  assert.strictEqual(ai.cleanReading({ readable: false }, t), null);
  assert.strictEqual(ai.cleanReading({ readable: true, cardSales: '' }, t), null, 'no card total, nothing to propose');
  assert.strictEqual(ai.cleanReading({ readable: true, date: '2026-10-09', cardSales: '5' }, t).proposal.date, '', 'a future date is not trusted');
  assert.strictEqual(ai.cleanReading({ readable: true, cardSales: '99999999.00' }, t), null, 'over $10M is not a day');
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { TALLY_MEMORY: '1' }], ['./lib/fakeai', { TALLY_FAKE_AI: '1' }], ['./server', { TALLY_FAKE_AI: '1', TALLY_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, TALLY_MEMORY: '', TALLY_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

/* ---------------- over HTTP ---------------- */

test('signed out: health, meta, the sample and the rules work with zero model calls; nothing private does', async () => {
  const anon = client();
  const before = await modelCalls();
  const dump = store._dump();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = await anon('GET', '/api/meta');
  assert.strictEqual(meta.data.presets.find((p) => p.key === 'square').feeBps, 260);
  const d = await anon('GET', '/api/demo');
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.data.demo, true);
  assert.strictEqual(d.data.summary.statuses['2026-09-22'], 'missing');
  const js = await (await fetch(`${base}/rules.js`)).text();
  assert.ok(js.includes('TallyRules'), 'the page runs the same rules the server does');
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('src="app.js"') && html.includes('href="app.css"') && html.includes('src="rules.js"'), 'relative asset links');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/books'], ['PUT', '/api/settings'], ['PUT', '/api/days/2026-09-22'], ['GET', '/api/days/2026-09-22'], ['DELETE', '/api/days/2026-09-22'],
    ['POST', '/api/days/snap'], ['POST', '/api/deposits'], ['PUT', '/api/deposits/abcdef'], ['DELETE', '/api/deposits/abcdef'], ['POST', '/api/deposits/csv'],
    ['GET', '/api/export?month=2026-09'], ['DELETE', '/api/books']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  // A stranger's 5 MB photo and 2 MB statement are turned away at the door, unread.
  assert.strictEqual((await anon('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } })).status, 401);
  assert.strictEqual((await anon('POST', '/api/deposits/csv', { csv: 'x'.repeat(2 * 1024 * 1024) })).status, 401);
  // ...and every other route keeps the small limit.
  assert.strictEqual((await anon('POST', '/api/deposits', { description: 'x'.repeat(200 * 1024) })).status, 413);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
  assert.strictEqual(store._dump(), dump, 'the sample writes nothing');
});

let maya, eve;

async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}

test('settings: a processor preset, validated, and yours alone', async () => {
  maya = await register('maya@example.com');
  eve = await register('eve@example.com');
  const me = await maya('GET', '/api/me');
  assert.deepStrictEqual([me.data.signedIn, me.data.configured], [true, false]);
  const empty = await maya('GET', '/api/books');
  assert.deepStrictEqual([empty.data.days, empty.data.deposits, empty.data.today, empty.data.settings.processor], [[], [], TODAY_HDR, 'square']);
  assert.strictEqual((await maya('PUT', '/api/settings', { feePct: 'lots' })).status, 400);
  const ok = await maya('PUT', '/api/settings', { processor: 'square', feePct: '2.6', feeFixed: '0.15', windowDays: 1, business: '<b>Maya’s Bakes</b>' });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual([ok.data.settings.feeBps, ok.data.settings.business, ok.data.settings.configured], [260, 'Maya’s Bakes', true]);
  assert.strictEqual((await eve('GET', '/api/books')).data.settings.business, '', 'eve sees her own defaults');
});

test('closing days: one document per date, replaced not doubled, 404 for anyone else', async () => {
  const bad = await maya('PUT', '/api/days/2026-09-22', { gross: '1284.50' });
  assert.deepStrictEqual([bad.status, bad.data.field], [400, 'tx']);
  assert.strictEqual((await maya('PUT', '/api/days/2026-09-30', { gross: '1', tx: 1 })).status, 400, 'not in the future');
  assert.strictEqual((await maya('PUT', '/api/days/2026-02-30', { gross: '1', tx: 1 })).status, 400);
  const a = await maya('PUT', '/api/days/2026-09-22', { gross: '1,284.50', tips: '110.25', tx: '96' });
  assert.deepStrictEqual([a.status, a.data.replaced, a.data.day.grossCents, a.data.day.tipsCents], [200, false, 128450, 11025]);
  const again = await maya('PUT', '/api/days/2026-09-22', { gross: '1284.50', tips: '110.25', refunds: '12', tx: 96 });
  assert.deepStrictEqual([again.data.replaced, again.data.day.refundsCents], [true, 1200]);
  await maya('PUT', '/api/days/2026-09-23', { gross: '1205.10', tx: 93 });
  await maya('PUT', '/api/days/2026-09-25', { gross: '1538.90', tx: 118 });
  const b = await maya('GET', '/api/books');
  assert.deepStrictEqual(b.data.days.map((d) => d.date).sort(), ['2026-09-22', '2026-09-23', '2026-09-25']);
  assert.strictEqual((await maya('GET', '/api/days/2026-09-22')).data.day.refundsCents, 1200);
  // Eve cannot read, replace or delete Maya's day: her own path has nothing there.
  assert.strictEqual((await eve('GET', '/api/days/2026-09-22')).status, 404);
  assert.strictEqual((await eve('DELETE', '/api/days/2026-09-22')).status, 404);
  assert.strictEqual((await eve('GET', '/api/books')).data.days.length, 0);
  assert.strictEqual((await maya('GET', '/api/days/not-a-date')).status, 404);
  assert.strictEqual((await maya('DELETE', '/api/days/2026-09-25')).status, 200);
  assert.strictEqual((await maya('GET', '/api/days/2026-09-25')).status, 404);
});

let depId;
test('deposits: typed, bulk, deduplicated, edited and deleted - and nobody else’s', async () => {
  const b = await maya('GET', '/api/books');
  const s = b.data.settings;
  const tue = b.data.days.find((d) => d.date === '2026-09-22');
  const one = await maya('POST', '/api/deposits', { date: '2026-09-23', amount: R.plain(R.expected(tue, s).net), description: 'SQUARE INC SQ0923' });
  assert.strictEqual(one.status, 200);
  depId = one.data.added[0].id;
  assert.strictEqual((await maya('POST', '/api/deposits', { date: '2026-09-23', amount: 'ten' })).status, 400);
  const bulk = await maya('POST', '/api/deposits', { deposits: [
    { date: '2026-09-23', amount: R.plain(R.expected(tue, s).net), description: 'SQUARE INC SQ0923' },
    { date: '2026-09-24', amount: '1,100.00', description: 'SQUARE INC SQ0924' },
  ] });
  assert.deepStrictEqual([bulk.data.added.length, bulk.data.skipped], [1, 1], 'the same bank line twice is added once');
  const allOrNothing = await maya('POST', '/api/deposits', { deposits: [{ date: '2026-09-24', amount: '5' }, { date: 'nope', amount: '5' }] });
  assert.ok(allOrNothing.status === 400 && /Line 2/.test(allOrNothing.data.error));
  assert.strictEqual((await maya('GET', '/api/books')).data.deposits.length, 2);
  const ed = await maya('PUT', `/api/deposits/${bulk.data.added[0].id}`, { amount: '1,150.00' });
  assert.strictEqual(ed.data.deposit.amountCents, 115000);
  assert.strictEqual((await eve('PUT', `/api/deposits/${depId}`, { amount: '1' })).status, 404);
  assert.strictEqual((await eve('DELETE', `/api/deposits/${depId}`)).status, 404);
  assert.strictEqual((await maya('DELETE', `/api/deposits/${bulk.data.added[0].id}`)).status, 200);
  assert.strictEqual((await maya('DELETE', '/api/deposits/../../x')).status, 404);
  // Maya's Tuesday now reconciles in the page's rules and in the export.
  const nb = (await maya('GET', '/api/books')).data;
  const r = R.reconcile(nb.days, nb.deposits, nb.settings, nb.today);
  assert.deepStrictEqual(r.rows.map((x) => x.status), ['matched', 'missing']);
});

test('importing a bank CSV previews and saves nothing; its own parser is bounded', async () => {
  const csv = 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n' +
    'CREDIT,09/24/2026,SQUARE INC SQ0924 INDN:MAYA,1156.42,ACH_CREDIT,1,\n' +
    'CREDIT,09/23/2026,SQUARE INC SQ0923,' + (await maya('GET', '/api/books')).data.deposits[0].amountCents / 100 + ',ACH_CREDIT,1,\n' +
    'CREDIT,09/22/2026,MOBILE DEPOSIT,200.00,DEPOSIT,1,\nDEBIT,09/22/2026,FLOUR MILL,-300.00,ACH_DEBIT,1,\n';
  const dump = store._dump();
  const r = await maya('POST', '/api/deposits/csv', { csv });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(r.data.rows.map((x) => [x.date, x.processor, x.have]), [['2026-09-24', 'Square', false], ['2026-09-23', 'Square', true], ['2026-09-22', null, false]]);
  assert.strictEqual(r.data.skipped.outflows, 1);
  assert.strictEqual(store._dump(), dump, 'a preview writes nothing');
  assert.strictEqual((await maya('POST', '/api/deposits/csv', { csv: 'not,a\nstatement' })).status, 400);
  assert.strictEqual((await maya('POST', '/api/deposits/csv', {})).status, 400);
  // 2.2 MB of text passes the 2.5 MB parser and is refused by the rules (400);
  // 3 MB never gets past the parser (413).
  assert.strictEqual((await maya('POST', '/api/deposits/csv', { csv: `Date,Description,Amount\n${'x'.repeat(2.2 * 1024 * 1024)}` })).status, 400);
  assert.strictEqual((await maya('POST', '/api/deposits/csv', { csv: 'x'.repeat(3 * 1024 * 1024) })).status, 413);
  // Keywords come from settings: a bank's own wording is one edit away.
  await maya('PUT', '/api/settings', { keywords: [...R.DEFAULT_KEYWORDS, 'MOBILE DEPOSIT'] });
  const r2 = await maya('POST', '/api/deposits/csv', { csv });
  assert.strictEqual(r2.data.rows.find((x) => /MOBILE/.test(x.description)).processor, 'Card deposit');
  await maya('PUT', '/api/settings', { keywords: R.DEFAULT_KEYWORDS });
});

test('export: the month as CSV, computed with the same rules', async () => {
  const r = await maya('GET', '/api/export?month=2026-09');
  assert.strictEqual(r.status, 200);
  assert.ok(/text\/csv/.test(r.headers.get('content-type')));
  assert.ok(/attachment; filename="tally-2026-09.csv"/.test(r.headers.get('content-disposition')));
  const lines = r.text.trim().split('\r\n');
  assert.strictEqual(lines.length, 3);
  assert.ok(/^2026-09-22,Tuesday,1284\.50,110\.25,12\.00,96,/.test(lines[1]) && /,Matched,/.test(lines[1]), lines[1]);
  assert.ok(/,Missing,/.test(lines[2]));
  assert.strictEqual((await maya('GET', '/api/export?month=Sept')).status, 400);
  assert.strictEqual((await eve('GET', '/api/export?month=2026-09')).text.trim().split('\r\n').length, 1, 'eve exports only her own (empty) month');
});

test('snap a Z-report: bytes checked before any spend, a proposal back, nothing stored', async () => {
  const dump = store._dump();
  let calls = await modelCalls();
  const notImage = await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: Buffer.from('%PDF-1.4 not a photo').toString('base64') } });
  assert.strictEqual(notImage.status, 400);
  assert.strictEqual((await maya('POST', '/api/days/snap', {})).status, 400);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a non-image');
  const good = await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('ZREPORT') } });
  assert.strictEqual(good.status, 200, JSON.stringify(good.data));
  assert.deepStrictEqual(good.data.proposal, { date: TODAY_HDR, gross: '1284.50', refunds: '45.00', tips: '96.20', tx: '96' });
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  calls += 1;
  const messy = await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('INJECT') } });
  assert.deepStrictEqual(messy.data.proposal, { date: '', gross: '1284.51', refunds: '45.00', tips: '', tx: '' });
  assert.ok(!/</.test(JSON.stringify(messy.data)));
  const blank = await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('BLANK') } });
  assert.deepStrictEqual([blank.status, /couldn’t read/.test(blank.data.error)], [422, true]);
  const nocard = await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('NOCARD') } });
  assert.strictEqual(nocard.status, 422);
  const up = await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('UPSTREAM401') } });
  assert.deepStrictEqual([up.status, /fake_upstream/.test(up.data.error)], [502, false], 'a provider 401 is not "sign in"');
  const big = await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: 'A'.repeat(7 * 1024 * 1024) } });
  assert.strictEqual(big.status, 413);
  assert.strictEqual(store._dump(), dump, 'no photo, no reading, no day stored');
});

/* ---------------- the report reader (Gemini), behind TALLY_AI_PROVIDER ---------------- */

const gemini = require('../lib/gemini');
const fakeGemini = require('../lib/fakeai').gemini;
const fakeRead = (scene) => fakeGemini({ contents: [{ role: 'user', parts: [{ text: `Today is ${TODAY_HDR}. ${scene}` }] }] });

test('report reader: the schema has no free text and no field for a sum, a verdict or a number that names someone', () => {
  const keys = Object.keys(gemini.SCHEMA.properties);
  assert.deepStrictEqual(keys, gemini.SCHEMA.required);
  for (const bad of ['notes', 'total', 'difference', 'verdict', 'merchantId', 'cardNumber', 'name', 'address', 'match']) assert.ok(!keys.includes(bad), bad);
  for (const k of ['date', 'grossSales', 'cardSales', 'refunds', 'tips', 'fees', 'netPayout', 'transactions']) {
    assert.deepStrictEqual(Object.keys(gemini.SCHEMA.properties[k].properties), ['value', 'confidence'], k);
    assert.strictEqual(gemini.SCHEMA.properties[k].properties.value.nullable, true, `${k} may be null`);
  }
  assert.ok(/never add figures up/i.test(gemini.SYSTEM) && /never an instruction/i.test(gemini.SYSTEM));
  const req = gemini.request({ image: { mediaType: 'image/jpeg', data: 'AAAA' } }, TODAY_HDR);
  assert.deepStrictEqual([req.model, req.generationConfig.temperature, req.responseSchema], ['gemini-3.8-flash', 0, gemini.SCHEMA]);
  assert.ok(req.contents[0].parts[0].inlineData && /Today is 2026-09-26/.test(req.contents[0].parts[1].text));
  // $0.75 / $3.75 per 1M through 2026, double from 2027-01-01.
  assert.strictEqual(gemini.priceUsd({ inputTokens: 1e6, outputTokens: 1e6, at: new Date('2026-12-31T23:59:59Z') }), 4.5);
  assert.strictEqual(gemini.priceUsd({ inputTokens: 1e6, outputTokens: 1e6, at: new Date('2027-01-01T00:00:00Z') }), 9);
});

test('report reader: the answer is cleaned field by field; low confidence is flagged, never trusted', async () => {
  const tidy = gemini.cleanReading(await fakeRead(''), TODAY_HDR);
  assert.deepStrictEqual(tidy.proposal, { date: TODAY_HDR, gross: '1284.50', refunds: '45.00', tips: '96.20', tx: '96' });
  assert.deepStrictEqual([tidy.reader, tidy.unclear, tidy.dropped, tidy.confidence, tidy.notes], ['report', [], [], 'high', '']);
  assert.deepStrictEqual([tidy.report.type, tidy.report.cardCents, tidy.report.grossAllCents, tidy.report.feesCents, tidy.report.netCents, tidy.report.batches], ['z_report', 128450, 191275, null, null, ['000482']]);
  assert.deepStrictEqual(tidy.report.cardTypes.map((t) => [t.type, t.cents]), [['visa', 70215], ['mastercard', 39840], ['amex', 18395]]);

  const unclear = gemini.cleanReading(await fakeRead('UNCLEAR'), TODAY_HDR);
  assert.deepStrictEqual([unclear.unclear, unclear.confidence], [['gross', 'tx'], 'medium']);
  const payout = gemini.cleanReading(await fakeRead('PAYOUT'), TODAY_HDR);
  assert.deepStrictEqual([payout.report.type, payout.report.feesCents, payout.report.netCents, payout.report.batches], ['payout_report', 5890, 127680, ['000482', '000483']]);

  const messy = gemini.cleanReading(await fakeRead('INJECT'), TODAY_HDR);
  assert.deepStrictEqual(messy.proposal, { date: '', gross: '1284.51', refunds: '45.00', tips: '', tx: '' });
  assert.deepStrictEqual(messy.dropped, ['the date', 'gross sales', 'tips', 'fees', 'the payout', 'the transaction count']);
  assert.deepStrictEqual([messy.report.type, messy.processor, messy.report.confidence.gross, messy.report.feesCents, messy.report.netCents, messy.unclear], ['other', null, 1, null, null, []]);
  assert.deepStrictEqual(messy.report.cardTypes.map((t) => [t.type, t.cents, t.confidence]), [['visa', 70000, 1], ['other', 100, 1]], 'known types once each, amounts as money, confidence clamped');
  assert.deepStrictEqual(messy.report.batches, ['••1111', 'B-0091'], 'a card number is cut to its last four; markup and prose are not batch numbers');
  const text = JSON.stringify(messy);
  for (const leak of ['<', '4111', 'verdict', 'reconciled', 'merchantId', '4445012345678', 'Dana', 'Ignore', '999999']) assert.ok(!text.includes(leak), leak);
  assert.deepStrictEqual(Object.keys(messy).sort(), ['confidence', 'dropped', 'filled', 'notes', 'processor', 'proposal', 'reader', 'report', 'unclear']);

  assert.strictEqual(gemini.cleanReading(await fakeRead('BLANK'), TODAY_HDR), null, 'not a report');
  assert.strictEqual(gemini.cleanReading(await fakeRead('NOCARD'), TODAY_HDR), null, 'cash and card as one total is not a card total');
  for (const junk of [null, 'x', [], {}, { reportType: 'z_report', cardSales: { value: 12.5, confidence: 1 } }]) assert.strictEqual(gemini.cleanReading(junk, TODAY_HDR), null);
  // An unclear card-type line makes the set unclear.
  const raw = await fakeRead('');
  raw.cardTypes[1].confidence = 0.4;
  assert.deepStrictEqual(gemini.cleanReading(raw, TODAY_HDR).unclear, ['types']);
});

test('report text is scrubbed before it is sent: last four only, no emails, phones or named people', () => {
  const out = R.scrubReportText('Merchant ID: 4445012345678\nTerminal 00123456\nCashier: Dana Okafor\nDate 2026-09-22 21:04\nVISA 4111 1111 1111 1111\nCard ************4242\n'
    + 'Card sales $1,284.50  96\nCall 555-867-5309 or dana@example.com\nBatch 000482 total 12845000.00\n<b>https://example.com/x</b>');
  assert.strictEqual(out, 'Merchant ID: ••5678\nTerminal ••3456\nCashier: [removed]\nDate 2026-09-22 21:04\nVISA ••1111\nCard ••4242\nCard sales $1,284.50 96\nCall [phone removed] or [email removed]\nBatch 000482 total 12845000.00\n[link removed]');
  assert.strictEqual(R.scrubReportText('x'.repeat(50000)).length, 6000);
  assert.strictEqual(R.scrubReportText(null), '');
});

test('the report check is Tally’s own arithmetic, and leaves out what is not confirmed', () => {
  const ctx = { settings: SETTINGS, days: DAYS, deposits: DEPOSITS, today: TODAY };
  const by = (r) => Object.fromEntries(R.checkReport(r, ctx).lines.map((l) => [l.key, l]));
  // The sample's Saturday batch report: types add up, the report adds up, the fee is the crept 2.9%.
  const sat = { date: '2026-09-26', cardCents: 187635, tipsCents: 17140, refundsCents: null, feesCents: 8068, netCents: 196707, tx: 142, cardTypes: [{ type: 'visa', cents: 102110 }, { type: 'mastercard', cents: 58875 }, { type: 'amex', cents: 26650 }] };
  const a = by(sat);
  assert.deepStrictEqual([a.types.tone, a.sum.tone, a.fee.tone, a.expect.tone, a.day.tone, a.deposit.tone], ['ok', 'ok', 'warn', 'info', 'info', 'info']);
  assert.ok(/\$80\.68 \(3\.94%\).*estimates \$74\.54 \(3\.64%\) - \$6\.14 more/.test(a.fee.text), a.fee.text);
  assert.ok(/\$1,973\.21 by Monday, Sep 28/.test(a.expect.text), a.expect.text);
  assert.strictEqual(R.checkReport(sat, ctx).expected, R.expected({ grossCents: 187635, tipsCents: 17140, txCount: 142 }, SETTINGS).net, 'the same fee model as closing a day');
  // Tips not confirmed yet: no sum, fee or expectation is worked out as if they were zero.
  const waiting = by({ ...sat, tipsCents: null, unknown: ['tips'] });
  assert.deepStrictEqual(Object.keys(waiting).sort(), ['day', 'deposit', 'types']);
  // A misread line, and a payout that is short of the report's own figures.
  assert.ok(/\$10\.00 less than the card sales printed/.test(by({ ...sat, cardTypes: [{ type: 'visa', cents: 101110 }, { type: 'mastercard', cents: 58875 }, { type: 'amex', cents: 26650 }] }).types.text));
  const held = by({ ...sat, netCents: 190000 });
  assert.deepStrictEqual([held.sum.tone, /\$67\.07 less/.test(held.sum.text)], ['warn', true]);
  // A closed day: Tuesday Sep 22 (missing in the sample). Same numbers -> the day's own explanation.
  const tue = DAYS.find((d) => d.date === '2026-09-22');
  const same = by({ date: tue.date, cardCents: tue.grossCents, tipsCents: tue.tipsCents, refundsCents: tue.refundsCents, tx: tue.txCount });
  assert.deepStrictEqual([same.day.tone, same.deposit.title, same.deposit.tone], ['ok', 'Missing', 'warn']);
  const off = by({ date: tue.date, cardCents: tue.grossCents + 450, tipsCents: tue.tipsCents, tx: tue.txCount });
  assert.ok(off.day.tone === 'warn' && /card sales \$1,289\.00 on the report, \$1,284\.50 in your books/.test(off.day.text), off.day.text);
  // A payout that is in the books is found by its exact amount.
  const mon = DEPOSITS[0];
  const found = by({ date: R.addDays(mon.date, -1), netCents: mon.amountCents });
  assert.deepStrictEqual([found.deposit.tone, found.deposit.text.includes(R.dayLong(mon.date))], ['ok', true]);
  // Nothing usable -> no lines, no throw.
  for (const junk of [null, {}, { cardCents: -5, tx: 1.5, cardTypes: 'x' }]) assert.deepStrictEqual(R.checkReport(junk, {}).lines, []);
});

/** A stand-in for the lab's guard: counts what the route asks of it. */
function fakeGuard(over = {}) {
  const g = { allowed: [], recorded: [], sent: [] };
  g.allow = async (a) => { g.allowed.push([a.provider, a.app, Boolean(a.req && a.req.user)]); return over.deny || { ok: true }; };
  g.record = async (a) => { g.recorded.push(a); return true; };
  g.priceUsd = (a) => { if (a.provider === 'gemini') return gemini.priceUsd(a); return 0.001; };
  g.gemini = { generate: async (r) => { g.sent.push(r); if (over.fail) throw over.fail; return { json: await r.fake({ contents: r.contents }), usage: { inputTokens: 2000, outputTokens: 300 } }; } };
  return g;
}

test('the provider switch defaults to Claude: nothing changes until TALLY_AI_PROVIDER=gemini', async () => {
  assert.strictEqual(process.env.TALLY_AI_PROVIDER, undefined);
  assert.strictEqual((await client()('GET', '/api/me')).data.reader, 'zreport');
  assert.strictEqual((await maya('GET', '/api/me')).data.reader, 'zreport');
  const r = await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('ZREPORT') } });
  assert.deepStrictEqual([r.status, r.data.reader, r.data.report, r.data.notes], [200, undefined, undefined, 'Card totals were printed separately from cash.'], 'Claude’s reading, in its old shape');
  assert.strictEqual((await maya('POST', '/api/days/snap', { text: 'Card sales 1,284.50 count 96' })).status, 400, 'pasted text is the report reader’s only');
  for (const v of ['', 'claude', 'Gemini', 'off', 'vertex']) {
    process.env.TALLY_AI_PROVIDER = v;
    assert.strictEqual((await maya('GET', '/api/me')).data.reader, 'zreport', v);
  }
  // With the lab's guard loaded, the Claude call asks it first and tells it the cost.
  delete process.env.TALLY_AI_PROVIDER;
  const g = global.LAB_AI_GUARD = fakeGuard();
  try {
    assert.strictEqual((await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('ZREPORT') } })).status, 200);
    assert.deepStrictEqual([g.allowed, g.recorded.map((x) => [x.provider, x.app, x.usd]), g.sent.length], [[['claude', 'tally', true]], [['claude', 'tally', 0.001]], 0]);
  } finally { delete global.LAB_AI_GUARD; }
});

test('report reader over HTTP: gates, guard, one schema’d call, charged, nothing stored', async () => {
  process.env.TALLY_AI_PROVIDER = 'gemini';
  const g = global.LAB_AI_GUARD = fakeGuard();
  try {
    const dump = store._dump();
    assert.strictEqual((await maya('GET', '/api/me')).data.reader, 'report');
    // Strangers: 401 with the body unread, guard and model untouched.
    assert.strictEqual((await client()('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } })).status, 401);
    // A non-image and an empty paste are 400s before the guard is asked or anything is spent.
    let calls = await modelCalls();
    assert.strictEqual((await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: Buffer.from('%PDF-1.4').toString('base64') } })).status, 400);
    assert.deepStrictEqual([(await maya('POST', '/api/days/snap', { text: 'hello there' })).status, (await maya('POST', '/api/days/snap', {})).status], [400, 400]);
    assert.deepStrictEqual([g.allowed.length, g.sent.length], [0, 0]);

    const good = await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('PAYOUT UNCLEAR') } });
    assert.strictEqual(good.status, 200, JSON.stringify(good.data));
    assert.deepStrictEqual([good.data.reader, good.data.unclear, good.data.report.type, good.data.report.netCents], ['report', ['gross', 'tx'], 'payout_report', 127680]);
    assert.deepStrictEqual(g.allowed, [['gemini', 'tally', true]]);
    assert.deepStrictEqual([g.sent.length, g.sent[0].model, g.sent[0].responseSchema === gemini.SCHEMA, g.sent[0].contents[0].parts[0].inlineData.mimeType], [1, 'gemini-3.8-flash', true, 'image/jpeg']);
    assert.deepStrictEqual(g.recorded.map((x) => [x.provider, x.app, x.usd]), [['gemini', 'tally', gemini.priceUsd({ inputTokens: 2000, outputTokens: 300 })]]);
    await settle();
    assert.strictEqual(await modelCalls(), calls + 1, 'charged to the person’s own ledger too');
    const row = (await identityStore.list('usage')).find((u) => u.route === 'snap:gemini-3.8-flash');
    assert.ok(row && row.costUsd > 0 && row.costUsd < 0.01, JSON.stringify(row));
    calls += 1;

    // Pasted text: what is sent has been scrubbed on the server, whatever the page did.
    const pasted = await maya('POST', '/api/days/snap', { text: 'Merchant 4445012345678\nCashier: Dana Okafor\nCard 4111 1111 1111 1111\nCard sales 1,284.50\nCount 96' });
    assert.strictEqual(pasted.status, 200, JSON.stringify(pasted.data));
    const sentText = g.sent[1].contents[0].parts.map((p) => p.text).join('');
    assert.ok(/••5678/.test(sentText) && /Card sales 1,284\.50/.test(sentText) && !/4445012345678|4111 1111|Dana/.test(sentText), sentText);
    assert.strictEqual(g.sent[1].contents[0].parts.some((p) => p.inlineData), false);

    assert.deepStrictEqual([(await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('BLANK') } })).status,
      (await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('NOCARD') } })).status], [422, 422]);
    const messy = await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('INJECT') } });
    assert.ok(messy.status === 200 && !/<|4111|verdict|Ignore/.test(JSON.stringify(messy.data)));

    // A provider failure: a status and the app's own words; what it billed is still recorded.
    const before = g.recorded.length;
    g.gemini.generate = async () => { throw Object.assign(new Error('Gemini answered 401. secret provider words'), { name: 'VertexError', code: 'http', status: 401, usage: { inputTokens: 1000, outputTokens: 0 } }); };
    const up = await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('X') } });
    assert.deepStrictEqual([up.status, up.data.error], [502, 'Could not read that photo. Try again, or type the numbers in.']);
    assert.strictEqual(g.recorded.length, before + 1);
    g.gemini.generate = async () => { throw Object.assign(new Error('slow'), { name: 'VertexError', code: 'timeout' }); };
    assert.strictEqual((await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('X') } })).status, 503);

    // The guard says no: its friendly message, its status, and no model call.
    const deny = global.LAB_AI_GUARD = fakeGuard({ deny: { ok: false, status: 429, code: 'burst-minute', message: 'Lots of people are using AI right now - try again in a minute.' } });
    const no = await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('ZREPORT') } });
    assert.deepStrictEqual([no.status, no.data.code, no.data.error, deny.sent.length, deny.recorded.length], [429, 'burst-minute', 'Lots of people are using AI right now - try again in a minute.', 0, 0]);

    // Out of credit: the identity gate answers before the guard is asked.
    await identityStore.merge('users', uidOf('maya@example.com'), { spentUsd: 100 });
    const broke = global.LAB_AI_GUARD = fakeGuard();
    assert.strictEqual((await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('ZREPORT') } })).status, 402);
    assert.deepStrictEqual([broke.allowed.length, broke.sent.length], [0, 0]);
    await identityStore.merge('users', uidOf('maya@example.com'), { spentUsd: 0 });

    // No guard at all (the app on its own): the local stand-in answers.
    delete global.LAB_AI_GUARD;
    const alone = await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('ZREPORT') } });
    assert.deepStrictEqual([alone.status, alone.data.proposal.gross, alone.data.unclear], [200, '1284.50', []]);
    assert.strictEqual((await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('UPSTREAM500') } })).status, 502);
    assert.strictEqual(store._dump(), dump, 'no photo, no text, no reading, no day stored');
  } finally {
    delete global.LAB_AI_GUARD;
    delete process.env.TALLY_AI_PROVIDER;
  }
});

test('the sample carries a made-up reading (no model), in the live reading’s exact shape', async () => {
  const before = await modelCalls();
  const d = (await client()('GET', '/api/demo')).data;
  assert.deepStrictEqual([d.reading.reader, d.reading.unclear, d.reading.report.type, d.reading.proposal.gross], ['report', ['tips'], 'batch_report', '1876.35']);
  assert.deepStrictEqual(Object.keys(d.reading).sort(), Object.keys(gemini.cleanReading(await fakeRead(''), TODAY_HDR)).sort());
  await settle();
  assert.strictEqual(await modelCalls(), before);
});

test('out of credit: 402 before any model call, while everything free still works', async () => {
  await identityStore.merge('users', uidOf('maya@example.com'), { spentUsd: 100 });
  await settle();
  const calls = await modelCalls();
  const r = await maya('POST', '/api/days/snap', { image: { type: 'image/jpeg', data: jpeg('ZREPORT') } });
  assert.strictEqual(r.status, 402);
  assert.ok('topUpUrl' in r.data);
  assert.strictEqual((await maya('PUT', '/api/days/2026-09-24', { gross: '1347.65', tx: 103 })).status, 200, 'typing is free');
  assert.strictEqual((await maya('POST', '/api/deposits', { date: '2026-09-25', amount: '1300.00', description: 'SQUARE' })).status, 200);
  assert.strictEqual((await maya('POST', '/api/deposits/csv', { csv: 'Date,Description,Amount\n09/25/2026,SQUARE,1.00\n' })).status, 200);
  assert.strictEqual((await maya('GET', '/api/books')).status, 200);
  assert.strictEqual((await maya('GET', '/api/export?month=2026-09')).status, 200);
  assert.strictEqual((await maya('PUT', '/api/settings', { windowDays: 2 })).status, 200);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call was made');
  await identityStore.merge('users', uidOf('maya@example.com'), { spentUsd: 0 });
});

test('caps: 400 days and 2,000 deposits, and starting over', async () => {
  const uid = uidOf('eve@example.com');
  for (let i = 0; i < R.LIMITS.days; i++) await store.set(`days/${uid}/items`, R.addDays('2025-08-01', i), { date: R.addDays('2025-08-01', i), grossCents: 100, txCount: 1 });
  const full = await eve('PUT', '/api/days/2026-09-26', { gross: '10', tx: 1 });
  assert.strictEqual(full.status, 409);
  assert.strictEqual((await eve('PUT', '/api/days/2026-09-01', { gross: '10', tx: 1 })).status, 200, 'correcting a closed day is not a new one');
  for (let i = 0; i < R.LIMITS.deposits; i++) await store.set(`deposits/${uid}/items`, `dfill${i}`, { date: '2026-09-01', amountCents: 100 + i, description: 'x' });
  assert.strictEqual((await eve('POST', '/api/deposits', { date: '2026-09-02', amount: '5' })).status, 409);
  assert.strictEqual((await eve('DELETE', '/api/books', {})).status, 400, 'needs DELETE typed');
  assert.strictEqual((await eve('DELETE', '/api/books', { confirm: 'DELETE' })).status, 200);
  const b = (await eve('GET', '/api/books')).data;
  assert.deepStrictEqual([b.days.length, b.deposits.length], [0, 0]);
  assert.ok((await maya('GET', '/api/books')).data.days.length > 0, 'maya’s books are untouched');
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use('/tally', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/tally`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
