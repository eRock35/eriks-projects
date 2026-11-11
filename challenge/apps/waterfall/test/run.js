// Pure rules first (reading an export, the column guess on a Stripe-shaped
// export and an awkward generic one, Unix seconds, ambiguous dates, the
// period-end evidence, the day split with largest-remainder rounding -
// property-tested - every rule, monthly and annual lines, prorations, usage
// in arrears, negative lines, voids, uncollectible, tax, discounts, the
// per-currency separation, the waterfall's totals, the roll-forward, the
// journal, the reconciliation buckets to the cent), then the demo and its
// planted gaps (checked against sums worked independently from the raw
// rows), then exports, settings, the AI request and answer, hostile input,
// the worker in a real worker thread, the page's own promises, and end to
// end against the memory store and the fake model:
//   WATERFALL_MEMORY=1 WATERFALL_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /waterfall, the
// way the lab mounts it, so the auth cookie, the budget gate and each
// route's parser order are exercised as deployed. Model calls are counted
// from the identity usage rows, and what reached "the model" is read from
// the fake's own log.
//
// Every company, customer and number here is made up. Addresses are built
// with AT so no file carries one.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const express = require('express');

if (process.env.WATERFALL_MEMORY !== '1' || process.env.WATERFALL_FAKE_AI !== '1') {
  console.error('run with WATERFALL_MEMORY=1 WATERFALL_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient, ownerTag } = require('../server');
const C = require('../public/waterfall-core');
const D = require('../public/demo');
const WS = require('../public/waterfall-store');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
const ch = (n) => String.fromCharCode(n);
const RLO = ch(0x202E), ZWSP = ch(0x200B);

/* ---------------- helpers ---------------- */

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const csv = (rows) => rows.map((r) => r.map((v) => (/[",\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v))).join(',')).join('\r\n') + '\r\n';
const day = (s) => C.dayFromIso(s);
const mk = (s) => C.monthFromKey(s);
const parts = (p) => p.map((x) => [C.monthKey(x[0]), x[1]]);

/** A small generic export: [invoice, date, status, customer, description, type, start, end, currency, amount, discount, tax] */
const HEAD = ['Invoice', 'Invoice Date', 'Status', 'Customer', 'Description', 'Type', 'Period Start', 'Period End', 'Currency', 'Amount', 'Discount', 'Tax'];
function engineFor(rows, opts = {}) {
  const e = C.createEngine();
  const m = e.load({ text: csv([opts.head || HEAD].concat(rows)), name: 'test.csv' });
  const map = Object.assign({}, m.map, opts.map || {});
  const p = e.prepare({ map, answers: Object.assign({ periodEnd: 'exclusive' }, opts.answers || {}) });
  const s = e.schedule({ rules: opts.rules || [] });
  return { e, m, p, s };
}
/** The synthetic month the reconciliation tests are worked by hand on. */
const RECON_ROWS = [
  ['A1', '2026-10-01', 'paid', 'Annual Co', 'Plan (annual)', 'subscription', '2026-10-01', '2027-10-01', 'USD', '1200.00', '0', '87.00'],
  ['B1', '2026-10-15', 'paid', 'Monthly Co', 'Plan (monthly)', 'subscription', '2026-10-15', '2026-11-15', 'USD', '100.00', '0', '0'],
  ['C1', '2026-09-15', 'paid', 'Monthly Co', 'Plan (monthly)', 'subscription', '2026-09-15', '2026-10-15', 'USD', '100.00', '0', '0'],
  ['D1', '2026-10-01', 'paid', 'Usage Co', 'API overage', 'usage', '2026-09-01', '2026-10-01', 'USD', '30.00', '0', '0'],
  ['E1', '2026-10-03', 'void', 'Void Co', 'Plan (monthly)', 'subscription', '2026-10-03', '2026-11-03', 'USD', '50.00', '0', '0'],
  ['F1', '2026-10-20', 'paid', 'Credit Co', 'Goodwill credit', 'credit', '', '', 'USD', '-10.00', '0', '0'],
  ['G1', '2026-10-05', 'paid', 'Euro GmbH', 'Setup', 'one-time', '', '', 'EUR', '20.00', '0', '0'],
  ['H1', '2026-10-01', 'paid', 'Promo Co', 'Plan (monthly)', 'subscription', '2026-10-01', '2026-11-01', 'USD', '50.00', '5.00', '0'],
];

/* ================================================================== *
 * Reading and the columns
 * ================================================================== */

test('reading: quoted commas and line breaks, CRLF and LF, a byte-order mark, semicolons, a report title above the header, ragged rows counted, a headerless file numbered', () => {
  const t = C.parseTable(ch(0xFEFF) + 'Billing report\r\nInvoice,Description,Amount\r\nI1,"Team, monthly","1,234.56"\nI2,"two\nlines",5\r\nI3,short\r\n');
  assert.deepStrictEqual(t.headers, ['Invoice', 'Description', 'Amount']);
  assert.strictEqual(t.preamble, 1);
  assert.deepStrictEqual(t.rows[0], ['I1', 'Team, monthly', '1,234.56']);
  assert.strictEqual(t.rows[1][1], 'two lines');
  assert.strictEqual(t.ragged, 1);
  const semi = C.parseTable('a;b;c\n1;2;3\n');
  assert.strictEqual(semi.delimiter, ';');
  const tsv = C.parseTable('Invoice\tAmount\nI1\t12.00\n');
  assert.strictEqual(tsv.delimiterName, 'tab');
  const noHead = C.parseTable('2026-01-01,12.00,USD\n2026-02-01,13.00,USD\n');
  assert.strictEqual(noHead.header, false);
  assert.deepStrictEqual(noHead.headers, ['Column 1', 'Column 2', 'Column 3']);
});

test('column guessing: the demo export is placed exactly; a Stripe-shaped API export (cents, Unix seconds, snake_case) and an awkward generic one (Client, Bill Date, Net, VAT, Service From/To, State) are placed sensibly', () => {
  const t = C.parseTable(D.csv());
  const g = C.guessColumns(t.headers, t.rows);
  const want = { lineId: 'Invoice Line Item ID', invoice: 'Invoice ID', date: 'Invoice Date (UTC)', status: 'Invoice Status', customerId: 'Customer ID', customer: 'Customer Name', desc: 'Description', product: 'Product', type: 'Type', proration: 'Proration', start: 'Period Start (UTC)', end: 'Period End (UTC)', currency: 'Currency', amount: 'Amount', discount: 'Discount Amount', tax: 'Tax Amount' };
  for (const [k, h] of Object.entries(want)) assert.strictEqual(t.headers[g.map[k]], h, k);
  assert.ok(Object.values(g.conf).every((c) => c === 'sure'), 'every one of them sure');
  // Stripe-shaped, as the API writes it.
  const api = C.parseTable(csv([['id', 'invoice', 'customer', 'customer_name', 'amount', 'currency', 'period_start', 'period_end', 'description', 'proration', 'type', 'status'],
    ['il_test1', 'in_test1', 'cus_test1', 'Brindlecomb Labs', '4900', 'usd', '1760486400', '1763164800', '1 × Starter', 'false', 'subscription', 'paid'],
    ['il_test2', 'in_test2', 'cus_test2', 'Hobnail Freight', '19900', 'usd', '1760486400', '1763164800', '1 × Team', 'false', 'subscription', 'open'],
    ['il_test3', 'in_test3', 'cus_test3', 'Quill & Pail', '59900', 'eur', '1760486400', '1763164800', '1 × Business', 'true', 'subscription', 'void']]));
  const ga = C.guessColumns(api.headers, api.rows).map;
  const at = (k) => api.headers[ga[k]];
  assert.deepStrictEqual([at('lineId'), at('invoice'), at('customerId'), at('customer'), at('amount'), at('currency'), at('start'), at('end'), at('desc'), at('proration'), at('type'), at('status')],
    ['id', 'invoice', 'customer', 'customer_name', 'amount', 'currency', 'period_start', 'period_end', 'description', 'proration', 'type', 'status']);
  const q = C.questions(api, ga, {});
  assert.strictEqual(q.units.ask, true, 'whole-number amounts: dollars or cents is asked');
  assert.strictEqual(q.units.example.raw, '4900');
  assert.deepStrictEqual([q.units.example.major, q.units.example.minor], ['$4,900.00', '$49.00']);
  const comma = C.parseTable('Amount;Ccy\n120,00;EUR\n240,00;EUR\n99,00;EUR\n');
  assert.strictEqual(C.questions(comma, C.guessColumns(comma.headers, comma.rows).map, {}).units, undefined, '120,00 has decimals - no cents question');
  const yen = C.parseTable('Amount,Currency\n4900,eur\n100,eur\n200,eur\n');
  assert.deepStrictEqual(C.questions(yen, C.guessColumns(yen.headers, yen.rows).map, {}).units.example, { raw: '4900', major: '€4,900.00', minor: '€49.00' }, 'the example in the file’s currency');
  assert.strictEqual(q.periodEnd.suggestion, 'exclusive', 'Unix seconds: 15 Oct to 15 Nov, the next period’s first day');
  // An awkward generic export.
  const awk = C.parseTable(csv([['Doc No', 'Client', 'Bill Date', 'Item', 'Net', 'VAT', 'Service From', 'Service To', 'State'],
    ['D-1', 'Kettlewisp Dental', '03/04/2026', 'Hosting - Apr 2026', '120.00', '24.00', '03/04/2026', '02/05/2026', 'Paid'],
    ['D-2', 'Kettlewisp Dental', '03/05/2026', 'Hosting - May 2026', '120.00', '24.00', '03/05/2026', '02/06/2026', 'Paid']]));
  const gw = C.guessColumns(awk.headers, awk.rows).map;
  const aw = (k) => (gw[k] === null ? null : awk.headers[gw[k]]);
  assert.deepStrictEqual([aw('invoice'), aw('customer'), aw('date'), aw('desc'), aw('amount'), aw('tax'), aw('start'), aw('end'), aw('status'), aw('currency')],
    ['Doc No', 'Client', 'Bill Date', 'Item', 'Net', 'VAT', 'Service From', 'Service To', 'State', null]);
  assert.deepStrictEqual(C.mappingProblems(Object.assign({}, gw, { amount: null })), ['Choose the column with the amount.']);
  assert.ok(C.mappingProblems(Object.assign({}, gw, { tax: gw.amount })).includes('One column is chosen for two fields.'));
  assert.ok(C.mappingProblems(Object.assign({}, gw, { date: null, start: null })).some((p) => /invoice date/.test(p)));
});

test('dates: ISO, timestamps with and without a zone (moved to UTC), Unix seconds and milliseconds, MM/DD/YYYY, month names; ambiguous day/month asked once with both readings; a part over 12 decides on its own', () => {
  const iso = (v, o) => { const r = C.readStamp(v, o, true); return r ? C.isoDay(r.day) : null; };
  assert.strictEqual(iso('2026-10-15'), '2026-10-15');
  assert.strictEqual(iso('2026-10-15 00:00:00'), '2026-10-15');
  assert.strictEqual(iso('2026-10-15T22:30:00-05:00'), '2026-10-16', 'a zone moves the day to UTC');
  assert.strictEqual(iso('2026-10-15T01:00:00+02:00'), '2026-10-14');
  assert.strictEqual(iso('1760486400'), '2025-10-15', 'Unix seconds');
  assert.strictEqual(iso('1760486400000'), '2025-10-15', 'Unix milliseconds');
  assert.strictEqual(C.readStamp('1760486400', 'mdy', false), null, 'a bare number is not a date unless the column is mapped as one');
  assert.strictEqual(iso('10/03/2026'), '2026-10-03');
  assert.strictEqual(iso('10/03/2026', 'dmy'), '2026-03-10');
  assert.strictEqual(iso('Oct 15, 2026'), '2026-10-15');
  assert.strictEqual(iso('15 October 2026'), '2026-10-15');
  for (const bad of ['2026-02-30', '13/13/2026', '2026-10-15T25:00', 'soon', '31/31/2026']) assert.strictEqual(iso(bad), null, bad);
  assert.strictEqual(C.readStamp('2026-10-14 23:59:59').eod, true);
  const amb = ['03/04/2026', '05/06/2026'];
  assert.strictEqual(C.dateOrder(amb), 'either');
  assert.deepStrictEqual(C.ambiguousExample(amb), { raw: '03/04/2026', mdy: '4 Mar 2026', dmy: '3 Apr 2026' });
  assert.strictEqual(C.dateOrder(['03/04/2026', '25/04/2026']), 'dmy');
  assert.strictEqual(C.dateOrder(['03/04/2026', '04/25/2026']), 'mdy');
  // The question, and the answer read through every date column.
  const rows = [['I1', '03/04/2026', 'paid', 'Snorrelby Labs', 'Plan', 'subscription', '03/04/2026', '03/05/2026', 'USD', '31.00', '', '']];
  const { m, p } = engineFor(rows, { answers: { order: 'dmy' } });
  assert.strictEqual(m.questions.order.ask, true);
  assert.deepStrictEqual(m.questions.order.example, { raw: '03/04/2026', mdy: '4 Mar 2026', dmy: '3 Apr 2026' });
  assert.strictEqual(p.first, '2026-04-03', 'answered day-first, every date column reads that way');
});

test('period end: exclusive (the next period’s first day, as Stripe writes it) and inclusive (its own last day) are found from the file with the evidence; 23:59 ends read inclusive; no evidence is said so', () => {
  const ex = [['I1', '2026-01-15', 'paid', 'Wafflecrag Media', 'Plan', 'subscription', '2026-01-15', '2026-02-15', 'USD', '10', '', ''], ['I2', '2026-02-15', 'paid', 'Wafflecrag Media', 'Plan', 'subscription', '2026-02-15', '2026-03-15', 'USD', '10', '', '']];
  const t1 = C.parseTable(csv([HEAD].concat(ex)));
  const g1 = C.guessColumns(t1.headers, t1.rows).map;
  const e1 = C.periodEvidence(t1, g1, 'mdy');
  assert.deepStrictEqual([e1.suggestion, e1.exclusive, e1.chainExclusive, e1.inclusive], ['exclusive', 2, 1, 0]);
  assert.strictEqual(e1.examples.exclusive[0].start, '15 Jan 2026');
  const inc = [['I1', '2026-01-15', 'paid', 'Wafflecrag Media', 'Plan', 'subscription', '2026-01-15', '2026-02-14', 'USD', '10', '', ''], ['I2', '2026-02-15', 'paid', 'Wafflecrag Media', 'Plan', 'subscription', '2026-02-15', '2026-03-14', 'USD', '10', '', '']];
  const t2 = C.parseTable(csv([HEAD].concat(inc)));
  const e2 = C.periodEvidence(t2, C.guessColumns(t2.headers, t2.rows).map, 'mdy');
  assert.deepStrictEqual([e2.suggestion, e2.inclusive, e2.chainInclusive], ['inclusive', 2, 1]);
  const eod = [['I1', '2026-01-01', 'paid', 'Wafflecrag Media', 'Plan', 'subscription', '2026-01-01 00:00:00', '2026-01-31 23:59:59', 'USD', '10', '', '']];
  const t3 = C.parseTable(csv([HEAD].concat(eod)));
  assert.strictEqual(C.periodEvidence(t3, C.guessColumns(t3.headers, t3.rows).map, 'mdy').suggestion, 'inclusive');
  const none = [['I1', '2026-01-10', 'paid', 'Wafflecrag Media', 'Plan', 'subscription', '2026-01-10', '2026-01-20', 'USD', '10', '', '']];
  const t4 = C.parseTable(csv([HEAD].concat(none)));
  assert.strictEqual(C.periodEvidence(t4, C.guessColumns(t4.headers, t4.rows).map, 'mdy').none, true);
  // The answer changes the days: 1 Jan - 31 Jan inclusive is all January.
  const { e } = engineFor([['I1', '2026-01-01', 'paid', 'Wafflecrag Media', 'Plan', 'subscription', '2026-01-01', '2026-01-31', 'USD', '31.00', '', '']], { answers: { periodEnd: 'inclusive' } });
  const s = e.schedule({ rules: [] });
  assert.deepStrictEqual(s.by.USD.months, ['2026-01']);
  const { s: s2 } = engineFor([['I1', '2026-01-01', 'paid', 'Wafflecrag Media', 'Plan', 'subscription', '2026-01-01', '2026-01-31', 'USD', '30.00', '', '']], { answers: { periodEnd: 'exclusive' } });
  assert.deepStrictEqual(s2.by.USD.rec, [3000], 'exclusive: 1 Jan - 31 Jan is the 30 days before the 31st');
});

/* ================================================================== *
 * The day split
 * ================================================================== */

test('the day split: a $1,200 year gives each month its days, the six leftover cents to the six earliest 31-day months; $199 over 15 Oct - 15 Nov; a credit splits the same way', () => {
  assert.deepStrictEqual(parts(C.splitDays(120000, day('2026-01-01'), day('2027-01-01'))), [
    ['2026-01', 10192], ['2026-02', 9205], ['2026-03', 10192], ['2026-04', 9863], ['2026-05', 10192], ['2026-06', 9863],
    ['2026-07', 10192], ['2026-08', 10192], ['2026-09', 9863], ['2026-10', 10192], ['2026-11', 9863], ['2026-12', 10191]]);
  assert.deepStrictEqual(parts(C.splitDays(19900, day('2026-10-15'), day('2026-11-15'))), [['2026-10', 10913], ['2026-11', 8987]]);
  assert.deepStrictEqual(parts(C.splitDays(-1000, day('2026-10-15'), day('2026-12-15'))), [['2026-10', -279], ['2026-11', -492], ['2026-12', -229]]);
  assert.deepStrictEqual(parts(C.splitDays(7, day('2026-10-31'), day('2026-11-01'))), [['2026-10', 7]], 'one day, one month');
  assert.deepStrictEqual(parts(C.splitDays(1, day('2026-10-20'), day('2026-12-10'))), [['2026-11', 1]], 'a cent goes to the month with the most of it; empty months are dropped');
});

test('property: for 20,000 random lines - any sign, one day to ten years - the months add up to exactly the amount, each within one cent of its exact share, and the split is the same every time', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 20000; i++) {
    const amount = Math.round((rnd() < 0.15 ? -1 : 1) * Math.floor(rnd() * (rnd() < 0.1 ? 1e12 : 1e7)));
    const s = day('2020-01-01') + Math.floor(rnd() * 3000);
    const e = s + 1 + Math.floor(rnd() * (rnd() < 0.05 ? 3660 : 400));
    const p = C.splitDays(amount, s, e);
    assert.strictEqual(p.reduce((a, x) => a + x[1], 0), amount, `${amount} over ${e - s} days`);
    for (const [mi, v] of p) {
      const d = Math.min(e, C.monthStart(mi + 1)) - Math.max(s, C.monthStart(mi));
      assert.ok(Math.abs(v - amount * d / (e - s)) < 1 + 1e-6, `${amount}: ${v} vs ${amount * d / (e - s)}`);
      assert.ok(Number.isInteger(v));
    }
    for (let k = 1; k < p.length; k++) assert.strictEqual(p[k][0], p[k - 1][0] + 1, 'months in order, none skipped');
    assert.deepStrictEqual(C.splitDays(amount, s, e), p);
  }
});

/* ================================================================== *
 * Lines and rules
 * ================================================================== */

test('every rule: over the service period by day (a line with none falls back to its invoice date), on the invoice date, over N months from the invoice date (31 Jan + 1 month = 28 Feb), exclude', () => {
  const l = { bill: day('2026-10-12'), s: day('2026-10-12'), e: day('2026-11-12'), amt: 31000 };
  assert.deepStrictEqual(parts(C.recognise(l, { rule: 'period' }).parts), [['2026-10', 20000], ['2026-11', 11000]]);
  assert.deepStrictEqual(parts(C.recognise(Object.assign({}, l, { s: null, e: null }), { rule: 'period' }).parts), [['2026-10', 31000]]);
  assert.strictEqual(C.recognise(Object.assign({}, l, { s: null, e: null }), { rule: 'period' }).kind, 'pit');
  assert.deepStrictEqual(parts(C.recognise(l, { rule: 'invoice' }).parts), [['2026-10', 31000]]);
  const twelve = C.recognise({ bill: day('2026-10-12'), s: null, e: null, amt: 250000 }, { rule: 'months', months: 12 });
  assert.deepStrictEqual([C.isoDay(twelve.s), C.isoDay(twelve.e)], ['2026-10-12', '2027-10-12']);
  assert.strictEqual(twelve.parts[0][1], 13698, '20 of 365 days in October');
  assert.strictEqual(twelve.parts.reduce((a, x) => a + x[1], 0), 250000);
  assert.strictEqual(C.isoDay(C.addMonths(day('2026-01-31'), 1)), '2026-02-28');
  assert.strictEqual(C.isoDay(C.addMonths(day('2028-01-31'), 1)), '2028-02-29');
  assert.strictEqual(C.recognise(l, { rule: 'exclude' }).kind, 'excluded');
  const rm = C.rulesMap([{ d: 'Setup', r: 'months', n: 99 }, { d: 'Deposit', r: 'exclude' }, { d: 'X', r: 'maybe' }]);
  assert.deepStrictEqual(rm, { Setup: { rule: 'months', months: 12 }, Deposit: { rule: 'exclude' } });
  assert.deepStrictEqual(C.ruleOf(rm, 'Anything'), { rule: 'period' }, 'the default');
  // Through the schedule: an excluded product is listed, not revenue.
  const { e } = engineFor([['I1', '2026-10-01', 'paid', 'Teacupvale Studio', 'Refundable deposit', 'one-time', '', '', 'USD', '500.00', '', '']], { rules: [] });
  const s = e.schedule({ rules: [{ d: 'Refundable deposit', r: 'exclude' }] });
  assert.deepStrictEqual(s.currencies, []);
  assert.deepStrictEqual(s.lists.excluded, { USD: { n: 1, cents: 50000 } });
});

test('lines: monthly and annual plans, a proration pair, usage billed in arrears (earned before it is billed), a credit over its own period; void and draft left out; uncollectible kept and listed; tax never revenue; discounts before and after; each currency its own schedule', () => {
  const rows = [
    ['M1', '2026-10-15', 'paid', 'Lumbergast Labs', '1 × Team (at $199.00 / month)', 'subscription', '2026-10-15', '2026-11-15', 'USD', '199.00', '', '14.43'],
    ['Y1', '2026-01-01', 'paid', 'Lumbergast Labs', '1 × Team (annual)', 'subscription', '2026-01-01', '2027-01-01', 'USD', '1200.00', '', ''],
    ['P1', '2026-10-12', 'paid', 'Umberwhisk Supply', 'Unused time on Team after 12 Oct 2026', '', '2026-10-12', '2026-11-01', 'USD', '-128.39', '', ''],
    ['P1', '2026-10-12', 'paid', 'Umberwhisk Supply', 'Remaining time on Business after 12 Oct 2026', '', '2026-10-12', '2026-11-01', 'USD', '386.45', '', ''],
    ['U1', '2026-11-01', 'paid', 'Umberwhisk Supply', 'API calls overage - Oct 2026', '', '2026-10-01', '2026-11-01', 'USD', '31.00', '', ''],
    ['K1', '2026-10-01', 'paid', 'Umberwhisk Supply', 'Credit note', '', '2026-10-01', '2026-12-01', 'USD', '-61.00', '', ''],
    ['V1', '2026-10-02', 'void', 'Velvetgrub Media', 'Team', 'subscription', '2026-10-02', '2026-11-02', 'USD', '199.00', '', ''],
    ['R1', '2026-10-03', 'draft', 'Velvetgrub Media', 'Team', 'subscription', '2026-10-03', '2026-11-03', 'USD', '199.00', '', ''],
    ['X1', '2026-10-01', 'uncollectible', 'Yarrowpip Brokers', 'Team', 'subscription', '2026-10-01', '2026-11-01', 'USD', '31.00', '', ''],
    ['E1', '2026-10-01', 'paid', 'Euro GmbH', 'Team', 'subscription', '2026-10-01', '2026-11-01', 'EUR', '62.00', '', '12.40'],
  ];
  const { p, s, e } = engineFor(rows);
  assert.deepStrictEqual(p.counts.status, { billed: 7, void: 1, draft: 1, uncollectible: 1 });
  assert.deepStrictEqual(p.counts.types, { subscription: 6, proration: 2, usage: 1, credit: 1 });
  const u = s.by.USD, at = (k) => u.rec[u.months.indexOf(k)];
  assert.deepStrictEqual(s.currencies.sort(), ['EUR', 'USD']);
  assert.deepStrictEqual(s.by.EUR.rec, [6200], 'EUR stays in EUR: no conversion, its own schedule');
  // October, by hand: monthly 10913 + annual 10192 + prorations (-12839 + 38645) + usage 3100 + credit -3050 (31 of 61 days... -3100 or -3050) + uncollectible 3100.
  const credit = C.splitDays(-6100, day('2026-10-01'), day('2026-12-01'))[0][1];
  assert.strictEqual(credit, -3100, '31 of 61 days of a -$61.00 credit');
  assert.strictEqual(at('2026-10'), 10913 + 10192 + (-12839) + 38645 + 3100 + credit + 3100);
  assert.strictEqual(u.billed[u.months.indexOf('2026-11')], 3100, 'the usage is billed in November');
  const oct = u.roll[u.months.indexOf('2026-10')];
  assert.strictEqual(oct.unbilled, 3100, 'October usage is earned before it is billed');
  assert.strictEqual(oct.closing, oct.ahead - oct.unbilled);
  assert.strictEqual(u.roll[u.months.indexOf('2026-11')].unbilled, 0, '...until November bills it');
  assert.deepStrictEqual(s.lists.void, { USD: { n: 1, cents: 19900 } });
  assert.deepStrictEqual(s.lists.draft, { USD: { n: 1, cents: 19900 } });
  assert.deepStrictEqual(s.lists.uncollectible, { USD: { n: 1, cents: 3100 } });
  assert.deepStrictEqual(s.lists.tax, { USD: { n: 1, cents: 1443 }, EUR: { n: 1, cents: 1240 } });
  assert.strictEqual(u.totals.billed, 19900 + 120000 - 12839 + 38645 + 3100 - 6100 + 3100, 'tax is not in it, nor void or draft');
  // Discounts: before (taken off) and after (already net); tax included (taken out).
  const d1 = engineFor([['I1', '2026-10-01', 'paid', 'Wafflecrag Media', 'Plan', 'subscription', '2026-10-01', '2026-11-01', 'USD', '100.00', '20.00', '']], { answers: { discount: 'before' } });
  assert.deepStrictEqual(d1.s.by.USD.rec, [8000]);
  const d2 = engineFor([['I1', '2026-10-01', 'paid', 'Wafflecrag Media', 'Plan', 'subscription', '2026-10-01', '2026-11-01', 'USD', '80.00', '20.00', '']], { answers: { discount: 'after' } });
  assert.deepStrictEqual(d2.s.by.USD.rec, [8000]);
  const d3 = engineFor([['I1', '2026-10-01', 'paid', 'Wafflecrag Media', 'Plan', 'subscription', '2026-10-01', '2026-11-01', 'USD', '108.00', '', '8.00']], { answers: { tax: 'included' } });
  assert.deepStrictEqual(d3.s.by.USD.rec, [10000]);
  // Types: a proration flag, usage words in a product, a negative line is a credit.
  assert.strictEqual(C.typeOf({ proration: true, desc: 'Team', amount: 100, period: true }), 'proration');
  assert.strictEqual(C.typeOf({ type: 'subscription', product: 'API calls overage', amount: 100, period: true }), 'usage');
  assert.strictEqual(C.typeOf({ type: 'invoiceitem', desc: 'Onboarding', amount: 100, period: false }), 'onetime');
  assert.strictEqual(C.typeOf({ desc: 'Team', amount: -100, period: true }), 'credit');
  assert.strictEqual(C.typeOf({ desc: 'Team', amount: 100, period: false }), 'onetime');
  // The products: prorations belong to their plan; dates and prices taken out.
  assert.deepStrictEqual(p.products.map((x) => x.key).sort(), ['API calls overage', 'Business', 'Credit note', 'Team', 'Team (annual)']);
  assert.ok(e.customers({}).total === 5);
});

test('the waterfall: every row adds to what was billed that month, every column to that month’s revenue, both to the same total; the roll-forward: each closing is the next opening and everything billed less everything recognised is the closing balance', () => {
  const e = C.createEngine();
  const m = e.load({ text: D.csv(), name: D.FILE, demo: true });
  e.prepare({ map: m.map, answers: { periodEnd: 'exclusive' } });
  const s = e.schedule({ rules: D.RULES });
  assert.strictEqual(s.ok, true);
  for (const k of s.currencies) {
    const c = s.by[k];
    assert.deepStrictEqual(c.checks, { rows: true, cols: true, grand: true, continuity: true, split: true }, k);
    for (let b = 0; b < c.n; b++) assert.strictEqual(c.matrix[b].reduce((a, v) => a + v, 0), c.billed[b]);
    for (let mm = 0; mm < c.n; mm++) assert.strictEqual(c.matrix.reduce((a, r) => a + r[mm], 0), c.rec[mm]);
    for (let i = 1; i < c.n; i++) assert.strictEqual(c.roll[i].opening, c.roll[i - 1].closing);
    for (const r of c.roll) assert.strictEqual(r.opening + r.billed - r.rec, r.closing);
    let tb = 0, tr = 0;
    c.roll.forEach((r, i) => { tb += r.billed; tr += r.rec; assert.strictEqual(tb - tr, r.closing, `${k} ${r.key}: billed to date less recognised to date`); });
    assert.strictEqual(c.roll[c.n - 1].closing, 0, 'everything billed is earned by the end');
  }
});

test('the journal balances every month in every currency - billing (receivable against deferred revenue, revenue for invoice-date lines, tax payable) and recognition - with the account names chosen, a negative total on the other side', () => {
  const e = C.createEngine();
  const m = e.load({ text: D.csv(), name: D.FILE, demo: true });
  e.prepare({ map: m.map, answers: { periodEnd: 'exclusive' } });
  const s = e.schedule({ rules: D.RULES, accounts: { ar: 'AR - trade', deferred: 'Unearned revenue', revenue: 'Subscription revenue', tax: 'Tax payable' } });
  for (const k of s.currencies) {
    const js = s.by[k].journal;
    assert.ok(js.length > 10);
    for (const j of js) {
      assert.ok(j.balanced && j.dr === j.cr, `${k} ${j.key}`);
      for (const en of j.entries) assert.strictEqual(en.rows.reduce((a, r) => a + r.dr, 0), en.rows.reduce((a, r) => a + r.cr, 0), `${k} ${j.key} ${en.name} balances on its own`);
    }
    const oct = js.find((j) => j.key === '2026-10');
    const accounts = [...new Set(oct.entries.flatMap((en) => en.rows.map((r) => r.account)))].sort();
    if (k === 'USD') assert.deepStrictEqual(accounts, ['AR - trade', 'Subscription revenue', 'Tax payable', 'Unearned revenue']);
    if (k === 'USD') assert.strictEqual(oct.entries[0].rows.find((r) => r.account === 'Subscription revenue').dr, 15000, 'the $150 service credit (no period) goes straight to revenue, on the debit side');
  }
  const jc = e.exportFile({ kind: 'journal', month: '2026-10' }).text;
  const rows = jc.trim().split('\r\n').map((l) => l.split(','));
  assert.deepStrictEqual(rows[0], ['date', 'journal', 'currency', 'account', 'debit', 'credit', 'memo']);
  for (const k of ['USD', 'EUR']) {
    const mine = rows.slice(1).filter((r) => r[2] === k);
    const sum = (i) => Math.round(mine.reduce((a, r) => a + (Number(r[i]) || 0), 0) * 100);
    assert.strictEqual(sum(4), sum(5), `${k}: the CSV balances`);
  }
  assert.ok(rows.slice(1).every((r) => r[0] === '2026-10-31'));
});

/* ================================================================== *
 * Why the dashboard and the ledger disagree
 * ================================================================== */

test('the reconciliation, worked by hand: billings before discounts with a void invoice and EUR at 1.10 tie to the cent - annual +$1,098.08, mid-month -$1.51, usage in arrears +$30.00, discount +$5.00, void +$50.00, EUR +$22.00', () => {
  const { e, s } = engineFor(RECON_ROWS);
  assert.ok(s.ok);
  const typed = 136500 + 500 + 5000 + 2200;
  const r = e.reconcile({ month: '2026-10', ccy: 'USD', dashboard: { kind: 'billings', cents: typed }, ledger: {}, fx: { EUR: C.readRate('1.10') } });
  assert.strictEqual(r.ours.revenue, 10192 + 5484 + 4667 + 4500 - 1000, 'October revenue');
  const x = r.dashboard;
  assert.deepStrictEqual([x.gap, x.ties, x.auto, x.residual], [typed - 23843, true, true, 0]);
  assert.deepStrictEqual(x.reading, { disc: true, tax: false, void: true, uncoll: false }, 'the smallest reading that ties');
  const b = Object.fromEntries(x.buckets.map((y) => [y.key, y.cents]));
  assert.deepStrictEqual(b, { prepay: 120000 - 10192, outside: (10000 - 5484) - 4667, usage: 3000, discount: 500, void: 5000, 'fx:EUR': 2200 });
  assert.strictEqual(x.sum, x.gap, 'the buckets add up to the gap exactly');
  assert.strictEqual(x.biggest, 'prepay');
  const pre = x.buckets.find((y) => y.key === 'prepay');
  assert.match(pre.sentence, /^\$1,098\.08 of the gap: 1 annual plan billed in October 2026 \(\$1,200\.00\) - only their October days, about 1\/12 of each, are October revenue \(\$101\.92\)/);
  assert.deepStrictEqual(pre.lines.map((l) => [l.cust, l.v]), [['Annual Co', 109808]]);
  assert.match(x.buckets.find((y) => y.key === 'usage').sentence, /1 usage line billed in October 2026 \(\$30\.00\)/);
  // MRR at month end: 1/12 of the annual, the two monthly plans in force, the credit not in MRR.
  const mrr = e.reconcile({ month: '2026-10', ccy: 'USD', dashboard: { kind: 'mrr', cents: 24500 }, ledger: {}, fx: {} }).dashboard;
  assert.deepStrictEqual([mrr.gap, mrr.ties, mrr.residual], [657, true, 0]);
  assert.deepStrictEqual(Object.fromEntries(mrr.buckets.map((y) => [y.key, y.cents])), { credit: 1000, prepay: -192, outside: -151 });
  const mrrD = e.reconcile({ month: '2026-10', ccy: 'USD', dashboard: { kind: 'mrr', cents: 25000 }, ledger: {}, fx: {} }).dashboard;
  assert.deepStrictEqual([mrrD.reading.disc, mrrD.ties], [true, true], 'MRR before discounts: the $5 off the promo plan');
  // Read by hand: no reading ties, so the rest is said plainly - and the buckets still add up.
  const off = e.reconcile({ month: '2026-10', ccy: 'USD', dashboard: { kind: 'billings', cents: typed + 1234 }, ledger: {}, fx: { EUR: C.readRate('1.10') } }).dashboard;
  assert.deepStrictEqual([off.ties, off.auto], [false, false]);
  assert.strictEqual(off.sum, off.gap);
  const hand = e.reconcile({ month: '2026-10', ccy: 'USD', dashboard: { kind: 'billings', cents: typed }, ledger: {}, fx: { EUR: C.readRate('1.10') }, reading: { tax: true } }).dashboard;
  assert.deepStrictEqual([hand.auto, hand.reading.tax, hand.sum === hand.gap], [false, true, true]);
  assert.strictEqual(hand.buckets.find((y) => y.key === 'residual').cents, typed - hand.modeled);
  // Without a rate, the other currency is named in the residual.
  const nofx = e.reconcile({ month: '2026-10', ccy: 'USD', dashboard: { kind: 'billings', cents: typed }, ledger: {}, fx: {} }).dashboard;
  assert.match(nofx.buckets.find((y) => y.key === 'residual').sentence, /EUR lines/);
  // The ledger: booked annual plans when billed - found, smallest set.
  const lr = e.reconcile({ month: '2026-10', ccy: 'USD', ledger: { revenue: 23843 + 109808, deferred: null }, fx: {} }).ledgerRevenue;
  assert.deepStrictEqual([lr.ties, lr.auto, lr.buckets.map((y) => y.key)], [true, true, ['when:prepay']]);
  const ld = e.reconcile({ month: '2026-09', ccy: 'USD', ledger: { deferred: 4667 }, fx: {} });
  assert.strictEqual(ld.ours.deferred, 4667 - 3000, 'September: half a monthly plan billed ahead, less the usage earned and billed in October');
  assert.deepStrictEqual(ld.ledgerDeferred.buckets.map((y) => [y.key, y.cents]), [['unbilled', 3000]]);
});

test('property: for 300 random months and figures, every reconciliation’s buckets add up to its gap exactly, whatever reading is set by hand', () => {
  const e = C.createEngine();
  const m = e.load({ text: D.csv(), name: D.FILE, demo: true });
  e.prepare({ map: m.map, answers: { periodEnd: 'exclusive' } });
  e.schedule({ rules: D.RULES });
  let seed = 99;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const months = ['2025-09', '2025-12', '2026-03', '2026-06', '2026-09', '2026-10', '2026-11'];
  for (let i = 0; i < 300; i++) {
    const o = { month: months[i % months.length], ccy: rnd() < 0.8 ? 'USD' : 'EUR', dashboard: { kind: rnd() < 0.5 ? 'billings' : 'mrr', cents: Math.floor(rnd() * 1e7) }, ledger: { revenue: Math.floor(rnd() * 5e6), deferred: Math.floor(rnd() * 1e7) - 2e6 }, fx: rnd() < 0.5 ? { EUR: C.readRate('1.0' + Math.floor(rnd() * 9)), USD: C.readRate('0.9' + Math.floor(rnd() * 9)) } : {} };
    if (rnd() < 0.4) o.reading = { disc: rnd() < 0.5, tax: rnd() < 0.5, void: rnd() < 0.5, uncoll: rnd() < 0.5 };
    if (rnd() < 0.3) o.ledgerPick = ['when:prepay', 'tax'];
    const r = e.reconcile(o);
    for (const k of ['dashboard', 'ledgerRevenue', 'ledgerDeferred']) {
      assert.strictEqual(r[k].sum, r[k].gap, `${k} ${JSON.stringify(o).slice(0, 120)}`);
      assert.strictEqual(r[k].ties, r[k].residual === 0);
    }
  }
});

/* ================================================================== *
 * The demo
 * ================================================================== */

let demoE = null;
function demoEngine() {
  if (demoE) return demoE;
  const e = C.createEngine();
  const m = e.load({ text: D.csv(), name: D.FILE, demo: true });
  const p = e.prepare({ map: m.map, answers: { periodEnd: m.questions.periodEnd.suggestion } });
  const s = e.schedule({ rules: D.RULES });
  demoE = { e, m, p, s };
  return demoE;
}

test('the demo: 120 made-up customers over 14 months, every column recognised, the period end found exclusive from the file, nothing left out; the planted pieces are all there', () => {
  const { m, p, s } = demoEngine();
  assert.strictEqual(m.problems.length, 0);
  assert.strictEqual(m.questions.periodEnd.suggestion, 'exclusive');
  assert.ok(m.questions.periodEnd.chainExclusive > 1000);
  assert.strictEqual(m.questions.order.ask, false);
  assert.strictEqual(m.questions.units, undefined, 'amounts with decimals: no cents question');
  assert.strictEqual(p.counts.customers, 120);
  assert.strictEqual(p.leftOut, 0);
  assert.deepStrictEqual(p.counts.status, { billed: p.counts.lines - 2, void: 1, uncollectible: 1 });
  assert.deepStrictEqual(Object.keys(p.counts.ccy).sort(), ['EUR', 'USD']);
  assert.deepStrictEqual([p.first, p.lastMonth], ['2025-09-01', '2026-11']);
  assert.strictEqual(p.counts.types.proration, 8, 'four upgrades, two proration lines each');
  assert.ok(p.counts.types.usage > 200);
  assert.strictEqual(p.counts.types.credit, 1);
  assert.deepStrictEqual(p.products.map((x) => x.key).sort(), ['API calls overage', 'Business', 'Business (annual)', 'Enterprise (annual)', 'Onboarding and implementation', 'Service credit', 'Starter', 'Team', 'Team (annual)', 'Team (quarterly)']);
  const rows = D.rows();
  const months = new Set(rows.map((r) => C.monthKey(C.monthOfDay(r.day))));
  assert.strictEqual([...months].filter((k) => k <= '2026-10').length, 14, 'fourteen months of invoices (and ten days of November)');
  assert.ok(s.ok);
});

test('the demo’s October 2026 tie-out: the dashboard, the ledger’s revenue and its deferred balance each explained to the cent - the dashboard figure re-added from the raw rows, the readings found, three annual plans the biggest bucket', () => {
  const { e } = demoEngine();
  const R = D.RECON;
  const rows = D.rows();
  const oct = (r) => C.monthKey(C.monthOfDay(r.day)) === '2026-10';
  // Independently: billings before discounts, void invoices counted, EUR at 1.08.
  const usd = rows.filter((r) => oct(r) && r.ccy === 'usd').reduce((a, r) => a + r.amount, 0);
  const eur = rows.filter((r) => oct(r) && r.ccy === 'eur').reduce((a, r) => a + r.amount, 0);
  assert.strictEqual(R.dashboard, usd + Math.round(eur * 1.08), 'the planted dashboard figure is the raw October billings before discounts, void included, EUR at 1.08');
  const r = e.reconcile({ month: R.month, ccy: R.ccy, dashboard: { kind: R.kind, cents: R.dashboard }, ledger: { revenue: R.ledgerRevenue, deferred: R.ledgerDeferred }, fx: { EUR: C.readRate(R.fx.EUR) } });
  // October revenue, independently: every USD line spread by day in floating point.
  let brute = 0, n = 0;
  const o0 = day('2026-10-01'), o1 = day('2026-11-01');
  for (const x of rows) {
    if (x.ccy !== 'usd' || x.status === 'void') continue;
    const net = x.amount - x.discount;
    let s = x.s, en = x.e;
    if (x.product === 'Onboarding and implementation') { s = x.day; en = C.addMonths(x.day, 12); }
    if (s === null) { if (x.day >= o0 && x.day < o1) { brute += net; n++; } continue; }
    const d = Math.min(en, o1) - Math.max(s, o0);
    if (d > 0) { brute += net * d / (en - s); n++; }
  }
  assert.ok(Math.abs(r.ours.revenue - brute) <= n, `October revenue ${r.ours.revenue} vs ${brute.toFixed(2)} worked day by day`);
  for (const k of ['dashboard', 'ledgerRevenue', 'ledgerDeferred']) {
    assert.deepStrictEqual([r[k].ties, r[k].auto, r[k].residual, r[k].sum === r[k].gap], [true, true, 0, true], k);
  }
  assert.deepStrictEqual(r.dashboard.reading, R.reading, 'it counts before discounts and counts the void invoice');
  assert.deepStrictEqual(r.ledgerRevenue.buckets.map((b) => b.key).sort(), R.ledgerPick.slice().sort());
  assert.deepStrictEqual(r.ledgerDeferred.buckets.map((b) => b.key).sort(), R.deferredPick.slice().sort());
  const b = Object.fromEntries(r.dashboard.buckets.map((x) => [x.key, x]));
  assert.strictEqual(r.dashboard.biggest, 'prepay');
  const billedOct = b.prepay.lines.filter((l) => l.v > 0 && /Oct 2026$/.test(l.bill));
  assert.deepStrictEqual(billedOct.map((l) => l.cust).sort(), ['Glimmerford Media', 'Quorvane Robotics', 'Saltmoth Logistics'], 'exactly three annual plans billed in October');
  assert.match(b.prepay.sentence, /3 annual plans billed in October 2026 \(\$35,980\.00\)/);
  assert.strictEqual(b.void.cents, 59900, 'Brimbleton Clinic’s duplicate invoice');
  assert.strictEqual(b.discount.cents, rows.filter((x) => oct(x) && x.ccy === 'usd' && x.status !== 'void').reduce((a, x) => a + x.discount, 0));
  assert.strictEqual(b['fx:EUR'].cents, Math.round(eur * 1.08));
  const unc = r.ledgerRevenue.buckets.find((x) => x.key === 'uncollectible');
  assert.strictEqual(unc.lines[0].cust, 'Ottercap Dental');
  assert.strictEqual(unc.cents, -C.splitDays(57000, day('2026-08-20'), day('2026-11-20')).find((x) => C.monthKey(x[0]) === '2026-10')[1], 'its October days of the quarter');
  assert.ok(r.ledgerDeferred.buckets.find((x) => x.key === 'unbilled').cents > 0, 'October usage billed in November sits outside the ledger’s deferred revenue');
});

test('the demo is unmistakably made up: a made-up company, invented customer names, DEMO ids, an EXAMPLE- file; no real company named', () => {
  assert.strictEqual(D.COMPANY, 'Brightwell Analytics');
  assert.ok(/^EXAMPLE-/.test(D.FILE));
  const cs = D.customers();
  assert.strictEqual(cs.length, 120);
  assert.strictEqual(new Set(cs.map((c) => c.name)).size, 120);
  assert.ok(cs.every((c) => /^cus_DEMO\d{4}$/.test(c.id)));
  assert.ok(D.rows().every((r) => /^in_DEMO\d{5}$/.test(r.inv) && /^il_DEMO\d{6}$/.test(r.lid)));
  const REAL = ['Stripe', 'Acme', 'Google', 'Amazon', 'Microsoft', 'Apple', 'Salesforce', 'Oracle', 'NetSuite', 'QuickBooks', 'Intuit', 'Xero', 'Shopify', 'Slack', 'Zoom', 'Atlassian', 'HubSpot', 'Zendesk', 'Twilio', 'Datadog', 'Snowflake', 'Adobe', 'IBM', 'Netflix', 'Uber', 'Airbnb', 'Dropbox', 'Notion', 'Figma', 'Chargebee', 'Recurly', 'Zuora', 'Paddle', 'Brightwell Capital', 'Walmart', 'Target', 'Costco', 'Tesla', 'Meta', 'Facebook', 'Twitter'];
  const all = D.csv() + read('public/demo.js');
  for (const n of REAL.filter((x) => x !== 'Stripe')) assert.ok(!new RegExp('\\b' + n + '\\b').test(all), n);
  assert.ok(!/\bStripe\b/.test(D.csv()), 'the file never names Stripe - only the comments say the layout is Stripe-shaped');
});

/* ================================================================== *
 * Customers and exports
 * ================================================================== */

test('a customer: their lines with the rule each follows and how it splits, their schedule and their deferred balance at every month end', () => {
  const { e } = demoEngine();
  const l = e.customers({ q: 'quorvane' });
  assert.deepStrictEqual(l.shown.map((c) => c.name), ['Quorvane Robotics']);
  const d = e.customer({ ci: l.shown[0].ci });
  assert.strictEqual(d.n, 2);
  const b = d.by.USD, i = b.months.indexOf('2026-10');
  assert.strictEqual(b.closing[i], 599000 - C.splitDays(599000, day('2026-10-07'), day('2027-10-07'))[0][1], 'the renewal less its 25 October days');
  assert.strictEqual(b.closing[b.months.length - 1], 0);
  assert.ok(d.lines.every((x) => x.rule === 'Over the service period, by day' && x.parts.reduce((a, p) => a + p[1], 0) === x.amt));
  assert.strictEqual(e.customers({}).total, 120);
  assert.strictEqual(e.customer({ ci: 9999 }), null);
});

test('exports: the schedule, waterfall, roll-forward and journal are formula-safe CSV with negative numbers still numbers; names masked on request; the close memo is escaped Markdown with the totals, the roll-forward, the buckets and the rules', () => {
  const rows = [
    ['I1', '2026-10-01', 'paid', '=HYPERLINK("http://evil.example","x")', '@SUM(1+1)', 'subscription', '2026-10-01', '2026-11-01', 'USD', '100.00', '', ''],
    ['I2', '2026-10-02', 'paid', '+Plain Co', 'Credit | <b>bold</b>', 'credit', '', '', 'USD', '-12.00', '', ''],
  ];
  const { e } = engineFor(rows);
  const sc = e.exportFile({ kind: 'schedule', mask: false }).text;
  assert.ok(sc.includes('"\'=HYPERLINK(""http://evil.example"",""x"")"'), 'a formula gets a leading quote');
  assert.ok(sc.includes("'@SUM(1+1)") && sc.includes("'+Plain Co"));
  assert.ok(/,-12\.00,/.test(sc), 'a negative amount stays a number');
  const masked = e.exportFile({ kind: 'schedule', mask: true }).text;
  assert.ok(!/HYPERLINK|Plain Co/.test(masked) && masked.includes('Customer 0001') && masked.includes('Customer 0002'));
  for (const kind of ['waterfall', 'roll', 'journal']) {
    const t = e.exportFile({ kind, ccy: 'USD', accounts: { ar: '=evil()' } }).text;
    assert.ok(!/(^|,)[=+@]/m.test(t), kind);
    if (kind === 'journal') assert.ok(t.includes("'=evil()"), 'even an account name');
  }
  const memo = e.exportFile({ kind: 'memo', month: '2026-10', recon: { month: '2026-10', ccy: 'USD', dashboard: { kind: 'billings', cents: 8800 }, ledger: { revenue: 8800 } } }).text;
  assert.match(memo, /^# Close memo - October 2026/);
  assert.ok(memo.includes('Credit \\| \\<b\\>bold\\</b\\>'), 'product names escaped');
  assert.ok(!memo.includes('<b>') && !memo.includes('HYPERLINK'));
  assert.ok(memo.includes('| Billed | $88.00 |') && memo.includes('### Billing dashboard') && memo.includes('## Rules used'));
  assert.ok(memo.includes(C.NOT_POLICY) && memo.includes(C.NO_FX));
  assert.strictEqual(C.csvCell('-1+1'), "'-1+1");
  assert.strictEqual(C.csvCell('-12.50'), '-12.50');
  assert.strictEqual(C.csvCell('\tx'), "'\tx");
  const demo = demoEngine().e.exportFile({ kind: 'memo', month: '2026-10', recon: { month: D.RECON.month, ccy: 'USD', dashboard: { kind: 'billings', cents: D.RECON.dashboard }, ledger: { revenue: D.RECON.ledgerRevenue, deferred: D.RECON.ledgerDeferred }, fx: { EUR: C.readRate('1.08') } } });
  assert.strictEqual(demo.name, 'EXAMPLE-waterfall-close-memo-2026-10.md');
  assert.ok(demo.text.includes('explained to the cent') && !/Quorvane|Glimmerford|Saltmoth/.test(demo.text), 'the memo carries buckets, not customer names');
});

/* ================================================================== *
 * Settings and the AI
 * ================================================================== */

test('settings: presets by header name, rules by product, account names, the period end and masking - unknown fields, an @, nine digits in a row, markup, more than 500 rules and bad rules are refused; merge keeps both sides’ rules', () => {
  const good = { version: 1, presets: [{ name: 'Billing export', map: { amount: 'Amount', date: 'Invoice Date (UTC)' } }], rules: [{ d: 'Onboarding and implementation', r: 'months', n: 12 }, { d: 'Refundable deposit', r: 'exclude' }], accounts: { ar: 'AR', deferred: 'Deferred', revenue: 'Revenue', tax: 'VAT' }, periodEnd: 'exclusive', mask: false };
  const ok = C.cleanSettings(good, true);
  assert.deepStrictEqual(ok.errors, []);
  assert.deepStrictEqual(ok.settings.rules, good.rules);
  for (const bad of [
    Object.assign({}, good, { customers: ['Quorvane Robotics'] }),
    Object.assign({}, good, { rules: [{ d: 'Plan for ann' + AT + 'x.example', r: 'period' }] }),
    Object.assign({}, good, { rules: [{ d: 'Order 123456789', r: 'period' }] }),
    Object.assign({}, good, { rules: [{ d: '<img src=x>', r: 'period' }] }),
    Object.assign({}, good, { rules: [{ d: 'Setup', r: 'months', n: 61 }] }),
    Object.assign({}, good, { rules: [{ d: 'Setup', r: 'invoice', n: 3 }] }),
    Object.assign({}, good, { rules: [{ d: 'Setup', r: 'maybe' }] }),
    Object.assign({}, good, { rules: Array.from({ length: 501 }, (_, i) => ({ d: 'Product ' + i, r: 'period' })) }),
    Object.assign({}, good, { presets: [{ name: 'x', map: { amount: '2026-10-01' } }] }),
    Object.assign({}, good, { accounts: { ar: 'AR', bank: 'Bank' } }),
    Object.assign({}, good, { periodEnd: 'sometimes' }),
    Object.assign({}, good, { rules: [{ d: 'Team' + RLO, r: 'period' }] }),
  ]) assert.ok(C.cleanSettings(bad, true).errors.length, JSON.stringify(bad).slice(0, 100));
  assert.strictEqual(C.cleanSettings(Object.assign({}, good, { rules: Array.from({ length: 500 }, (_, i) => ({ d: 'Product ' + i, r: 'period' })) }), true).errors.length, 0, 'exactly 500 is fine');
  const merged = C.mergeSettings({ rules: [{ d: 'Team', r: 'invoice' }, { d: 'Setup', r: 'months', n: 6 }] }, { rules: [{ d: 'Setup', r: 'months', n: 12 }] });
  assert.deepStrictEqual(merged.rules, [{ d: 'Setup', r: 'months', n: 12 }, { d: 'Team', r: 'invoice' }]);
});

test('the AI request: product descriptions and their shapes only - a description naming a customer or invoice is held back; amounts, dates and ids are taken out; the server refuses anything else before any call', () => {
  const { e } = demoEngine();
  const pl = e.aiPayload();
  assert.strictEqual(pl.products.length, 10);
  assert.ok(pl.products.every((p) => Object.keys(p).sort().join() === 'd,len,period,types'));
  assert.deepStrictEqual(pl.products.find((p) => p.d === 'Onboarding and implementation'), { d: 'Onboarding and implementation', period: 0, types: ['onetime'], len: 'none' });
  assert.deepStrictEqual(pl.products.find((p) => p.d === 'Team (annual)'), { d: 'Team (annual)', period: 100, types: ['subscription'], len: 'year' });
  const flat = JSON.stringify(pl.products);
  for (const c of D.customers()) assert.ok(!flat.includes(c.name) && !flat.includes(c.id));
  assert.ok(!/in_DEMO|\$|\d{4}-\d{2}/.test(flat));
  assert.ok(C.rulesRequest({ products: pl.products }).req, 'what the page sends, the server accepts');
  // Built from file-shaped descriptions.
  const held = C.aiPayload([{ key: 'Hosting for Wafflecrag Media', periodShare: 100, types: ['subscription'], len: 'month' }, { key: '1 × Team (at $199.00 / month) cus_ABC12345 2026-10-01', periodShare: 100, types: ['subscription'], len: 'month' }, { key: 'Invoice INV-998877', periodShare: 0, types: ['onetime'], len: 'none' }], ['Wafflecrag Media', 'INV-998877']);
  assert.strictEqual(held.held, 2);
  assert.deepStrictEqual(held.products.map((p) => p.d), ['1 × Team (at / month)']);
  // The server's check.
  const p = { d: 'Team', period: 100, types: ['subscription'], len: 'month' };
  const refuse = (body, code) => { const r = C.rulesRequest(body); assert.ok(r.error, JSON.stringify(body).slice(0, 90)); if (code) assert.strictEqual(r.code, code, JSON.stringify(body)); };
  refuse({ products: [Object.assign({}, p, { d: 'Team $199.00' })] }, 'amount');
  refuse({ products: [Object.assign({}, p, { d: 'Team 1,990.00' })] }, 'amount');
  refuse({ products: [Object.assign({}, p, { d: 'Team 2026-10-01' })] }, 'date');
  refuse({ products: [Object.assign({}, p, { d: 'Team Oct 15, 2026' })] }, 'date');
  refuse({ products: [Object.assign({}, p, { d: 'Team cus_DEMO0001' })] }, 'id');
  refuse({ products: [Object.assign({}, p, { d: 'Team in_1NxYzAbCdEf' })] }, 'id');
  refuse({ products: [Object.assign({}, p, { d: 'Team for ann' + AT + 'x' })] }, 'personal');
  refuse({ products: [Object.assign({}, p, { d: 'Team 123456789' })] }, 'personal');
  refuse({ products: [Object.assign({}, p, { customer: 'Quorvane Robotics' })] });
  refuse({ products: [p], customers: ['x'] });
  refuse({ products: [Object.assign({}, p, { d: '<b>Team</b>' })] });
  refuse({ products: [Object.assign({}, p, { d: 'x'.repeat(121) })] });
  refuse({ products: [Object.assign({}, p, { d: 'Te' + ZWSP + 'am' })] });
  refuse({ products: [Object.assign({}, p, { period: 101 })] });
  refuse({ products: [Object.assign({}, p, { types: ['subscription', 'subscription'] })] });
  refuse({ products: [Object.assign({}, p, { types: ['gift'] })] });
  refuse({ products: [Object.assign({}, p, { len: 'decade' })] });
  refuse({ products: [p, p] });
  refuse({ products: [] });
  refuse({ products: Array.from({ length: 201 }, (_, i) => Object.assign({}, p, { d: 'Product ' + 'abcdefghij'[i % 10] + i })) });
  refuse([]);
});

test('the AI answer: only the products sent, by number, each once; only the fixed rules; N from 1 to 60; a short plain reason with no markup, links or addresses', () => {
  const req = { products: [{ d: 'Team', period: 100, types: ['subscription'], len: 'month' }, { d: 'Setup', period: 0, types: ['onetime'], len: 'none' }, { d: 'Mystery', period: 50, types: ['subscription'], len: 'mixed' }] };
  const out = C.cleanAiRules({ suggestions: [
    { n: 1, rule: 'period', reason: 'Recognised over its period.' },
    { n: 2, rule: 'months', months: 12, reason: '<b>Spread</b> over a year - see https://evil.example/x or mail ops' + AT + 'evil.example and evil.com/y' + RLO },
    { n: 1, rule: 'invoice', reason: 'again' }, { n: 4, rule: 'period', reason: 'x' }, { n: 0, rule: 'period', reason: 'x' },
    { n: 3, rule: 'months', months: 61, reason: 'x' }, { n: 3, rule: 'maybe', reason: 'x' }, { n: '3', rule: 'unsure', reason: 'x' }, null,
  ] }, req);
  assert.deepStrictEqual(out.suggestions.map((s) => [s.n, s.d, s.rule, s.months]), [[1, 'Team', 'period', null], [2, 'Setup', 'months', 12]]);
  assert.strictEqual(out.dropped, 7);
  const why = out.suggestions[1].reason;
  assert.ok(!/<|>|https?:|evil|@/.test(why) && !why.includes(RLO), why);
  assert.ok(why.length <= C.LIMITS.reasonChars);
  assert.ok(C.cleanAiRules({ suggestions: [] }, req).error);
  assert.ok(C.cleanAiRules({}, req).error);
});

/* ================================================================== *
 * Storage and hostile input
 * ================================================================== */

test('storage: the one module keeps settings and two flags - every value through the core’s guards; nothing from a file', async () => {
  const s = WS.create(WS.memory());
  await s.putSettings({ rules: [{ d: 'Team', r: 'invoice' }], customers: ['Quorvane Robotics'], presets: [{ name: 'x', map: { amount: '1234567890' } }] });
  await s.putDevice({ hint: true, home: 'EUR', customer: 'Quorvane Robotics' });
  await s.putSyncBase('nope');
  const dump = s.backend.dump();
  assert.ok(!/Quorvane|1234567890|nope/.test(dump), dump);
  assert.deepStrictEqual((await s.getSettings()).rules, [{ d: 'Team', r: 'invoice' }]);
  assert.deepStrictEqual(await s.getDevice(), { hint: true, rulesHint: false, home: 'EUR' });
  assert.strictEqual(await s.getSyncBase(), null);
  const src = read('public/waterfall-store.js');
  assert.ok(/C\.cleanSettings\(v\)\.settings/.test(src) && /cleanDevice\(v\)/.test(src));
  assert.ok(!/localStorage|sessionStorage/.test(src));
  assert.ok(/try \{[^}]*self\.indexedDB\.open/.test(src.replace(/\n/g, ' ')), 'opening the database is wrapped');
});

test('hostile input: markup and bidi in customers and descriptions, malformed dates and amounts, too many decimals, a period over ten years, a 25 MB export of 250,000+ lines - read, cleaned, capped, and quick', () => {
  const rows = [
    ['I1', '2026-10-01', 'paid', '<img src=x onerror=alert(1)>' + RLO + 'Evil', 'Te' + ZWSP + 'am <script>', 'subscription', '2026-10-01', '2026-11-01', 'USD', '10.00', '', ''],
    ['I2', '31/31/2026', 'paid', 'Bad Date Co', 'Team', '', '', '', 'USD', '10.00', '', ''],
    ['I3', '2026-10-01', 'paid', 'Bad Amount Co', 'Team', '', '', '', 'USD', 'ten', '', ''],
    ['I4', '2026-10-01', 'paid', 'Decimals Co', 'Team', '', '', '', 'USD', '10.005', '', ''],
    ['I5', '2026-10-01', 'paid', 'Long Co', 'Team', '', '2026-01-01', '2037-01-01', 'USD', '10.00', '', ''],
    ['I6', '2026-10-01', 'paid', 'Backwards Co', 'Team', '', '2026-10-01', '2026-09-01', 'USD', '10.00', '', ''],
    ['I7', '2026-10-01', 'mystery', 'Odd Status Co', 'Team', '', '', '', 'XX', '10.00', '', ''],
    ['I8', '2026-10-01', 'mystery', 'Odd Status Co', 'Team', '', '', '', 'USD', '1e5', '', ''],
    ['I9', '2026-10-01', 'mystery', 'Odd Status Co', 'Team', '', '', '', 'USD', '99999999999.00', '', ''],
  ];
  const { p, e } = engineFor(rows);
  const n = (k) => p.checks[k].n;
  assert.deepStrictEqual([n('baddate'), n('amount'), n('decimals'), n('long'), n('backwards'), n('currency'), n('big')], [1, 2, 1, 1, 1, 1, 1]);
  assert.strictEqual(p.counts.lines, 1);
  const flat = JSON.stringify(e.customers({})) + JSON.stringify(p.products);
  assert.ok(!flat.includes(RLO) && !flat.includes(ZWSP), 'invisible characters removed on reading');
  assert.ok(flat.includes('<img src=x onerror=alert(1)>Evil'), 'markup kept as text - the page escapes it');
  // 25 MB: 250,000 lines kept, the rest counted; read, scheduled and reconciled in seconds.
  const head = HEAD.join(',');
  const parts2 = [head];
  let size = head.length;
  for (let i = 0; size < 25 * 1024 * 1024 - 300; i++) {
    const d0 = C.addMonths(day('2025-01-01'), i % 22), m = i % 28 + 1;
    const l = ['INV' + i, C.isoDay(d0 + m), 'paid', 'Customer ' + (i % 5000), i % 3 ? 'Team' : 'Team (annual)', 'subscription', C.isoDay(d0 + m), C.isoDay(C.addMonths(d0 + m, i % 3 ? 1 : 12)), i % 10 ? 'USD' : 'EUR', ((i % 900) + 10) + '.' + String(i % 100).padStart(2, '0'), '', ''].join(',');
    parts2.push(l); size += l.length + 2;
  }
  const big = parts2.join('\r\n');
  assert.ok(big.length <= C.LIMITS.fileBytes && parts2.length > 250001);
  const t0 = Date.now();
  const be = C.createEngine();
  const meta = be.load({ text: big, name: 'big.csv' });
  assert.strictEqual(meta.kept, 250000);
  assert.ok(meta.truncated > 0, 'the lines past 250,000 are counted');
  const bp = be.prepare({ map: meta.map, answers: { periodEnd: 'exclusive' } });
  assert.strictEqual(bp.counts.lines, 250000);
  const bs = be.schedule({ rules: [] });
  assert.ok(bs.ok);
  const br = be.reconcile({ month: '2026-03', ccy: 'USD', dashboard: { kind: 'billings', cents: 123456789 }, ledger: { revenue: 1, deferred: 2 }, fx: { EUR: 1100000 } });
  assert.strictEqual(br.dashboard.sum, br.dashboard.gap);
  be.customers({ q: 'Customer 42' });
  be.exportFile({ kind: 'schedule', mask: true });
  const ms = Date.now() - t0;
  assert.ok(ms < 45000, `took ${ms} ms`);
  console.log(`       (25 MB, 250,000 lines read, scheduled, reconciled and exported in ${ms} ms)`);
});

/* ================================================================== *
 * The worker, in a real worker thread
 * ================================================================== */

function spawnWorker() {
  const w = new Worker(`
    const { parentPort } = require('worker_threads'); const fs = require('fs'); const vm = require('vm'); const path = require('path');
    const dir = ${JSON.stringify(PUB)};
    global.self = global; global.module = undefined; global.exports = undefined;
    global.importScripts = (...f) => f.forEach((x) => vm.runInThisContext(fs.readFileSync(path.join(dir, x), 'utf8'), { filename: x }));
    global.postMessage = (m) => parentPort.postMessage(m);
    global.addEventListener = (t, fn) => { if (t === 'message') parentPort.on('message', (data) => fn({ data })); };
    vm.runInThisContext(fs.readFileSync(path.join(dir, 'waterfall-worker.js'), 'utf8'), { filename: 'waterfall-worker.js' });
  `, { eval: true });
  let seq = 0;
  const waits = {};
  w.on('message', (m) => { const p = waits[m.id]; if (!p) return; delete waits[m.id]; if (m.ok) p.resolve(m.out); else p.reject(new Error(m.error)); });
  return { call: (op, data) => new Promise((resolve, reject) => { const id = ++seq; waits[id] = { resolve, reject }; w.postMessage({ id, op, data }); }), stop: () => w.terminate() };
}

test('the worker reads a File itself and keeps the lines in its own memory; schedules, reconciles, exports and builds the AI payload; refuses a file over 25 MB before reading it; forgets everything when dropped', async () => {
  const w = spawnWorker();
  try {
    const text = csv([HEAD].concat(RECON_ROWS));
    const meta = await w.call('load', { file: new File([text], 'mine.csv'), name: 'mine.csv' });
    assert.strictEqual(meta.kept, RECON_ROWS.length);
    const p = await w.call('prepare', { map: meta.map, answers: { periodEnd: 'exclusive' } });
    assert.strictEqual(p.counts.lines, 8);
    const s = await w.call('schedule', { rules: [] });
    assert.ok(s.ok);
    const r = await w.call('reconcile', { month: '2026-10', ccy: 'USD', dashboard: { kind: 'billings', cents: 144200 }, ledger: {}, fx: { EUR: C.readRate('1.10') } });
    assert.strictEqual(r.dashboard.ties, true);
    assert.strictEqual((await w.call('exportFile', { kind: 'roll', ccy: 'USD' })).type, 'text/csv');
    assert.strictEqual((await w.call('aiPayload', {})).products.length, 5, 'Plan (annual), Plan (monthly), API overage, Goodwill credit, Setup');
    const demo = await w.call('load', { demo: true });
    assert.strictEqual(demo.demo, true);
    assert.deepStrictEqual(await w.call('has', {}), { file: true, lines: false, name: D.FILE, demo: true });
    assert.strictEqual(await w.call('drop', {}), true);
    await assert.rejects(w.call('schedule', { rules: [] }), /Load a billing export first/);
    await assert.rejects(w.call('load', { file: new File([new Uint8Array(C.LIMITS.fileBytes + 1)], 'huge.csv') }), /over 25 MB/);
    await assert.rejects(w.call('nope', {}), /Unknown step/);
  } finally { w.stop(); }
});

/* ================================================================== *
 * The page's promises
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes - pills, heat cells, the hero and the lab card too; chart and bridge marks 3:1; 44px targets; the triangle, tables and code scroll in their own box', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  assert.deepStrictEqual(Object.keys(dark).sort(), Object.keys(light).sort(), 'every token has a dark value');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2', 'code-bg', 'bar-bg', 'sticky']) for (const fg of ['text', 'muted', 'link']) ok(fg, bg);
    ok('accent-ink', 'accent'); for (const fg of ['text', 'link', 'muted']) ok(fg, 'accent-soft');
    for (const k of ['bad', 'warn', 'info', 'ok']) { ok(k, `${k}-bg`); ok('text', `${k}-bg`); ok(k, 'card'); ok(k, 'card2'); }
    for (const k of ['heat-1', 'heat-2', 'heat-3', 'heat-4', 'heat-5']) ok('text', k);
    for (const k of ['bar-rec', 'mark-billed', 'step-up', 'step-down', 'accent', 'bad']) { ok(k, 'card', 3); ok(k, 'card2', 3); }
    ok('bar-rec', 'bar-sched', 1.4);
    ok('bg', 'text');
  }
  for (const bg of ['#04495a', '#036a7f', '#5e2050']) for (const fg of ['#ffffff', '#e9f4f6', '#bfeaf3']) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  for (const [fg, bg] of [['#062a34', '#bfeaf3'], ['#0f1b20', '#fbfdfd'], ['#455760', '#fbfdfd'], ['#0f1b20', '#96cbda'], ['#ffffff', '#036a7f']]) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}`);
  assert.match(css, /\.hero \{[^}]*linear-gradient\(150deg, #04495a 0%, #036a7f 40%, #5e2050 100%\)/);
  const lab = require('../../../lab').get('waterfall');
  assert.ok(lab, 'Waterfall is in lab.js');
  assert.deepStrictEqual([lab.color, lab.color2, lab.dropped, lab.status, lab.emoji], ['#036a7f', '#74275f', '2026-11-11', 'testing', '\u{1F30A}']);
  assert.ok(ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const sel of ['.btn', '.link-btn', '.seg button', '.input, textarea.input, select.input', '.check', '.radio', '.cand', '.custrow']) assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: (4[4-9]|5\\d|60)px').test(css), `${sel}: 44px`);
  assert.ok(/details\.bucket > summary \{[^}]*min-height: 44px/.test(css) && /\.tabbar button \{[^}]*min-height: 60px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/\.tablewrap \{[^}]*overflow: auto/.test(css) && /\.tri \{[^}]*overflow: auto/.test(css) && /\.out, \.sent-pre \{[^}]*overflow: auto/.test(css) && /\.chart \{[^}]*overflow: auto/.test(css), 'the triangle, tables, the chart and code scroll in their own box');
  assert.ok(/\.tri thead th \{[^}]*position: sticky/.test(css) && /\.tri tbody th \{[^}]*position: sticky/.test(css), 'the triangle’s headers stick');
});

test('the page: relative links, no inline script or handlers, the banner, storage only through waterfall-store.js, no clock, dice, network or storage in the core, the demo or the worker, the requests it makes and what they carry, every file and model string escaped', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(js), 'the page touches no storage itself');
  assert.ok(!/\.backend\.(put|get|del)/.test(js), 'nor the store’s backend');
  assert.match(js, /Intl\.getCanonicalLocales\(navigator\.language \|\| 'en-US'\)\[0\] \|\| 'en-US'; \} catch \(e\) \{ return 'en-US'; \}/, 'a locale Intl refuses (en-US@posix) falls back to en-US');
  const all = js + read('public/waterfall-core.js') + read('public/waterfall-worker.js') + read('public/demo.js') + read('public/waterfall-store.js');
  assert.ok(!/eval\(|new Function|setTimeout\(['"]/.test(all), 'no eval of any kind');
  assert.match(js, /new Worker\('waterfall-worker\.js'\)/, 'the worker is a same-origin file - the CSP allows it');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/rules', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/me', 'api/settings'].sort(), 'the page asks for nothing else - no route takes a line');
  assert.strictEqual((js.match(/\bfetch\(/g) || []).length, 2, 'two fetches: api() and the verify resend');
  assert.match(js, /api\('POST', 'api\/ai\/rules', body\)/, 'the AI call sends the body shown, and nothing else');
  assert.match(js, /var body = \{ products: pl\.products \};/);
  assert.match(js, /esc\(sentText\(body\)\)/, 'what is sent is drawn from the same object');
  assert.match(js, /function sentText\(body\) \{ return '\{"products": \[\\n' \+ body\.products\.map\(function \(p\) \{ return '  ' \+ JSON\.stringify\(p\); \}\)/);
  assert.match(js, /api\('PUT', 'api\/settings', \{ settings: settingsBody\(\), base:/, 'sync sends the settings and a base, nothing else');
  const files = ['public/index.html', 'public/app.js', 'public/waterfall-core.js', 'public/demo.js', 'public/waterfall-worker.js', 'public/waterfall-store.js', 'server.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/store.js', 'CLAUDE.md', 'test/run.js'];
  for (const f of files) assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read(f)), `no email address in ${f}`);
  for (const f of ['public/waterfall-core.js', 'public/demo.js', 'public/waterfall-worker.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon|indexedDB|WebSocket/.test(src), `${f} touches no network or storage`);
    assert.ok(!/Math\.random|Date\.now\(\)|new Date\(/.test(src), `${f} has no dice and no clock`);
  }
  // Every interpolation of something a file, a person, the server or a model wrote goes through esc().
  const strip = (src) => { let out = ''; let i = 0; const re = /\besc\(/g; let m; while ((m = re.exec(src))) { if (m.index < i) continue; out += src.slice(i, m.index) + 'SAFE'; let depth = 0, j = m.index + m[0].length - 1; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; re.lastIndex = i; } return out + src.slice(i); };
  const risky = strip(js).split('\n').filter((l) => /</.test(l) && !/toast\(|confirm\(|prompt\(|copy\(|download\(|textContent/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(?!SAFE\b)([a-zA-Z_$][\w$]*(?:\.[\w$]+|\[[^\]]+\])*(?:\([^()]*\))?)\s*\+/g);
  const allowed = (r) => /\+\s*(?:[a-zA-Z]*Html(?:\([^()]*\))?|html|opts|head|body|parts|res|inputs|g|sel|months|fall|pill|extra|out|n|i|b|k|j|x|step|left\.toFixed\(2\)|width\.toFixed\(2\)|it\.kind|c\.ci|C\.LIMITS\.\w+|CONF_PILL\[[^\]]+\]|r\[0\]|r\[1\]|sign|cur|mapped\.length|sure|state\.device\.hint|plural\([^()]*\)|totalsHtml\([^()]*\)|scheduleChart\([^()]*\)|mockHtml\(\)|syncLine\(\)|radio\([^()]*\)|ruleRowHtml|guideHtml\([^()]*\)|demoNote\(\)|readingHtml\([^()]*\)|candHtml\([^()]*\)|sectionHtml\([^()]*\)|bucketHtml\([^()]*\)|journalHtml\([^()]*\)|accountsHtml\(\)|fileNotesHtml\([^()]*\)|questionsHtml\(\)|checksHtml\([^()]*\)|ccySegHtml\(\)|custDetailHtml\([^()]*\)|linesTableHtml\([^()]*\)|bridgeChart\([^()]*\)|rows|foot|exp\([^()]*\)|lines|detail|y|yy|cx|by|a|w|o|H|W|pl|pr|pt|bw|mi|t|v|y0|y1|x \+ 5|x \+ bw \/ 2|parts\.join\(''\)|out\.join\(''\)|Math\.\w+\([^()]*\)|y\([^()]*\)|monthSel|rollRows|cls\(v\)|kind)\s*\+/.test(r);
  const bad = (risky || []).filter((r) => !allowed(r));
  assert.deepStrictEqual(bad, [], `unescaped: ${bad}`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bbrief\b|\bsettings\b|\bpayload\b)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /waterfall-shell-v1/.test(sw) && ['waterfall-core.js', 'waterfall-worker.js', 'waterfall-store.js', 'demo.js', 'app.js'].every((f) => sw.includes(`'${f}'`)) && /k\.indexOf\('waterfall-'\) === 0/.test(sw), 'the service worker caches only the app shell, never api/, and only clears its own caches');
  assert.ok(/if \(!nav && SHELL\.indexOf\(rel\) < 0\) return;/.test(sw), 'nothing outside the shell is ever cached');
  assert.match(js, /navigator\.serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
  assert.strictEqual(C.NOT_POLICY, 'Waterfall applies the rules you choose - your accountant decides the policy.');
  assert.strictEqual(C.SETUP_LINE, 'Setup and implementation fees are often deferred - your accountant decides.');
  assert.ok(js.includes('C.NOT_POLICY') && js.includes('C.SETUP_LINE') && js.includes('C.NO_FX'));
  assert.ok(!/\b(ASC ?606|IFRS ?15|ASC|IFRS|GAAP|paragraph \d|606-10)\b/.test(all + html + read('lib/ai.js')), 'no standard cited');
});

test('the copy: no invisible characters in any source file, no key- or token-shaped strings', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.name === 'node_modules' ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const invisible = new RegExp('[' + [[0, 8], [11, 12], [14, 31], [0x7F, 0x9F], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2069], [0xFEFF, 0xFEFF]].map(([a, b]) => '\\u' + a.toString(16).padStart(4, '0') + '-\\u' + b.toString(16).padStart(4, '0')).join('') + ']');
  const all = walk(ROOT).filter((x) => /\.(js|css|html|md|json|svg|webmanifest)$/.test(x) && !/package-lock/.test(x));
  assert.ok(all.length >= 20);
  for (const f of all) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!invisible.test(src), `${path.relative(ROOT, f)} carries an invisible character`);
    if (!/lib\/(identity|stripe|byok|webauthn)/.test(f)) assert.ok(!/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\bsk-ant-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(src), `${path.relative(ROOT, f)} carries a key-shaped string`);
  }
  assert.ok(!invisible.test(D.csv()), 'nor the demo file it makes');
});

test('local-only switches throw on Cloud Run; the lab prefix is read; the store holds one kind of document, read by its id', () => {
  for (const [mod, env] of [['./lib/store', { WATERFALL_MEMORY: '1' }], ['./lib/fakeai', { WATERFALL_FAKE_AI: '1' }], ['./server', { WATERFALL_FAKE_AI: '1', WATERFALL_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, WATERFALL_MEMORY: '', WATERFALL_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, WATERFALL_MEMORY: '', WATERFALL_COLLECTION_PREFIX: 'waterfall_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'waterfall_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.ok(!/store\.list\(|orderBy/.test(server), 'one document per account, read by its id');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g))].sort(), ["store.get('settings'", "store.remove('settings'", "store.transact('settings'"]);
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
const BIG = { x: 'x'.repeat(900 * 1024) };
const aiBody = () => ({ products: demoEngine().e.aiPayload().products });

test('signed out: the page, the worker and the example work with zero model calls; settings and the AI answer 401 before reading a body; no route takes an export, a line or a figure', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.rules, meta.aiRules, meta.notPolicy], [C.RULES, C.AI_RULES, C.NOT_POLICY]);
  for (const f of ['waterfall-core.js', 'waterfall-worker.js', 'waterfall-store.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/settings'], ['PUT', '/api/settings'], ['DELETE', '/api/settings'], ['POST', '/api/ai/rules']]) assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : { ok: 1 })).status, 401, `${m} ${p}`);
  for (const [m, p] of [['PUT', '/api/settings'], ['POST', '/api/ai/rules']]) assert.strictEqual((await anon(m, p, BIG)).status, 401, `${p}: the gate answers before the parser, so never 413`);
  for (const p of ['/api/upload', '/api/export', '/api/lines', '/api/schedule', '/api/waterfall', '/api/reconcile', '/api/customers', '/api/journal', '/api/memo', '/api/ai/letter', '/api/file']) assert.strictEqual((await anon('POST', p, { customer: 'Quorvane Robotics', amount: 599000 })).status, 404, `${p}: there is no route that takes a line`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the gates come before each parser, in order; one model call site; Haiku free, Sonnet members via planFor', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/rules', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/settings', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((read('lib/ai.js').match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(read('lib/ai.js'), /tool_choice: \{ type: 'tool', name: RULES_TOOL\.name \}/);
});

test('settings sync: they follow the account; a stale device gets 409 with the account copy; anything that looks like a customer is refused; the owner tag holds no account id or address', async () => {
  const a = await register('finance.ana');
  assert.deepStrictEqual((await a('GET', '/api/settings')).data, { settings: null });
  const good = { version: 1, presets: [{ name: 'Billing export', map: { amount: 'Amount', date: 'Invoice Date (UTC)' } }], rules: [{ d: 'Onboarding and implementation', r: 'months', n: 12 }], accounts: { ar: 'Accounts receivable', deferred: 'Deferred revenue', revenue: 'Subscription revenue', tax: 'Sales tax payable' }, periodEnd: 'exclusive', mask: true };
  const put = await a('PUT', '/api/settings', { settings: good, base: null });
  assert.strictEqual(put.status, 200, put.text);
  const v1 = put.data.settings.updatedAt;
  const b = client();
  assert.strictEqual((await b('POST', '/api/auth/login', { email: mail('finance.ana'), password: 'a long enough password' })).status, 200);
  assert.strictEqual((await b('GET', '/api/settings')).data.settings.rules[0].d, 'Onboarding and implementation');
  assert.strictEqual((await b('PUT', '/api/settings', { settings: Object.assign({}, good, { mask: false }), base: v1 })).status, 200);
  const stale = await a('PUT', '/api/settings', { settings: good, base: v1 });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.data.settings.mask, false, 'the 409 carries the account copy to merge with');
  assert.strictEqual((await a('PUT', '/api/settings', { settings: good, base: null })).status, 409, 'a device that never synced cannot overwrite');
  const cur = (await a('GET', '/api/settings')).data.settings.updatedAt;
  for (const bad of [
    { settings: Object.assign({}, good, { customers: ['Quorvane Robotics'] }), base: cur },
    { settings: Object.assign({}, good, { rules: [{ d: 'Billing for ana' + AT + 'brightwell.example', r: 'period' }] }), base: cur },
    { settings: Object.assign({}, good, { rules: [{ d: 'Invoice 100045678912', r: 'period' }] }), base: cur },
    { settings: Object.assign({}, good, { rules: Array.from({ length: 501 }, (_, i) => ({ d: 'Product ' + i, r: 'period' })) }), base: cur },
    { settings: Object.assign({}, good, { rules: [{ d: 'Setup', r: 'months', n: 0 }] }), base: cur },
    { settings: Object.assign({}, good, { presets: [{ name: 'X', map: { customer: 'Quorvane Robotics 2026-10-07' } }] }), base: cur },
    { settings: Object.assign({}, good, { accounts: { ar: 'AR', lines: 'x' } }), base: cur },
    { settings: good, base: cur, lines: [{ customer: 'Quorvane Robotics' }] },
    { settings: 'nope', base: cur },
  ]) {
    const r = await a('PUT', '/api/settings', bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 120) + ' ' + r.text);
  }
  assert.strictEqual((await a('GET', '/api/settings')).data.settings.updatedAt, cur, 'nothing was saved');
  const dump = store._dump();
  assert.ok(!dump.includes('finance.ana') && !dump.includes(uidOf(mail('finance.ana'))), 'filed under an HMAC, never the account id or address');
  assert.ok(!/Quorvane|100045678912/.test(dump), 'nothing from a refused body');
  assert.ok(dump.includes(ownerTag(uidOf(mail('finance.ana')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  const doc = Object.values(JSON.parse(dump).find(([p]) => p === 'settings')[1]).map(([, d]) => d)[0];
  assert.deepStrictEqual(Object.keys(doc).sort(), ['owner', 'settings', 'updatedAt'], 'the document is the tag, the settings and a time');
  assert.deepStrictEqual(Object.keys(doc.settings).sort(), ['accounts', 'mask', 'periodEnd', 'presets', 'rules', 'version']);
  const other = await register('kim.other');
  assert.deepStrictEqual((await other('GET', '/api/settings')).data, { settings: null }, 'another account sees nothing of it');
  assert.strictEqual((await a('DELETE', '/api/settings')).status, 200);
  assert.deepStrictEqual((await b('GET', '/api/settings')).data, { settings: null });
});

test('the AI over HTTP: descriptions and shapes only; an amount, an id, a date, an @ or an unknown field is refused with no model call; the model saw nothing about a customer; its answer is checked', async () => {
  const ana = await register('ana.rules');
  const calls = await modelCalls();
  const good = aiBody();
  const p0 = good.products[0];
  for (const bad of [{}, { products: [Object.assign({}, p0, { d: 'Team $199.00' })] }, { products: [Object.assign({}, p0, { d: 'Team cus_DEMO0001' })] }, { products: [Object.assign({}, p0, { d: 'Team 2026-10-07' })] }, { products: [Object.assign({}, p0, { d: 'Team ' + AT + 'x' })] }, { products: [Object.assign({}, p0, { customer: 'Quorvane Robotics' })] }, Object.assign({}, good, { lines: [] }), []]) {
    const r = await ana('POST', '/api/ai/rules', bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 80) + ' ' + r.text);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const n0 = fakeClient.calls.length;
  const r = await ana('POST', '/api/ai/rules', good);
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const sent = fakeClient.calls[n0];
  assert.strictEqual(sent.model, 'claude-haiku-4-5');
  assert.deepStrictEqual(sent.tool_choice, { type: 'tool', name: 'suggest_rules' });
  assert.ok(sent.max_tokens >= 800 + 60 * good.products.length && sent.max_tokens <= 16000, 'room for a suggestion per product: ' + sent.max_tokens);
  const flat = JSON.stringify(sent);
  for (const c of D.customers()) assert.ok(!flat.includes(c.name) && !flat.includes(c.id), c.name);
  assert.ok(!/in_DEMO|il_DEMO|\$\d|\d{4}-\d{2}-\d{2}|Brightwell/.test(flat), 'no invoice, amount, date or company');
  assert.match(sent.messages[0].content[0].text, /<<<PRODUCTS\n1\. "/);
  const byD = Object.fromEntries(r.data.suggestions.map((s) => [s.d, s]));
  assert.deepStrictEqual([byD['Onboarding and implementation'].rule, byD['Onboarding and implementation'].months], ['months', 12]);
  assert.strictEqual(byD['Team (annual)'].rule, 'period');
  assert.ok(!store._dump().includes('Onboarding'), 'nothing stored');
  fakeClient.mode = 'bad';
  const bad = await ana('POST', '/api/ai/rules', good);
  assert.deepStrictEqual([bad.status, bad.data.suggestions.length, bad.data.dropped], [200, 1, 5]);
  fakeClient.mode = 'inject';
  const inj = await ana('POST', '/api/ai/rules', good);
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<b>|<img|onerror|hunter2|https?:|evil\.example|\u202e/i.test(inj.text), inj.text.slice(0, 300));
  fakeClient.mode = 'blank';
  assert.deepStrictEqual([(await ana('POST', '/api/ai/rules', good)).status], [422]);
  fakeClient.mode = 'maxtokens';
  assert.match((await ana('POST', '/api/ai/rules', good)).data.error, /ran long/);
  fakeClient.mode = 'upstream401';
  const up = await ana('POST', '/api/ai/rules', good);
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  fakeClient.mode = 'upstream529';
  const busy = await ana('POST', '/api/ai/rules', good);
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('the gates: an unconfirmed free account 403, out of credit 402, the day’s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register('eve.unconfirmed');
  const body = aiBody();
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/ai/rules', body);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/waterfall/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/ai/rules', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ai/rules', body)).status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/rules', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const today = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-waterfall-${today}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/rules', body);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/rules', BIG)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-waterfall-${today}`); }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/waterfall', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/waterfall`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
