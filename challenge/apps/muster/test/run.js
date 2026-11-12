// Pure rules first (reading a portfolio, the column guess with two
// borrowers, rate formats and ambiguous dates, every row check, the
// fixed-width builder against the default layout, customer record ids, the
// batch record holding no SSN, date of birth or name, both results readers,
// matching back, every decision branch, the 6% math in cents against
// hand-worked cases, the audit chain verified with node:crypto, the
// worklist, the exports, the letter, the AI letter's request and checks,
// settings), then the demo, then the storage module, then hostile input,
// then the worker in a real worker thread (with SubtleCrypto - it must agree
// with node:crypto), then the page's own promises, then end to end against
// the memory store and the fake model:
//   MUSTER_MEMORY=1 MUSTER_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /muster, the way
// the lab mounts it, so the auth cookie, the budget gate and each route's
// parser order are exercised as deployed. Model calls are counted from the
// identity usage rows, and what reached "the model" is read from the fake's
// own log.
//
// Every lender, person and number here is made up. SSNs are in the 900-999
// area, which is never issued, unless a test needs one outside it - then it
// is built at run time. Addresses are built with AT so no file carries one.

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

if (process.env.MUSTER_MEMORY !== '1' || process.env.MUSTER_FAKE_AI !== '1') {
  console.error('run with MUSTER_MEMORY=1 MUSTER_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient, ownerTag } = require('../server');
const C = require('../public/muster-core');
const D = require('../public/demo');
const MS = require('../public/muster-store');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
const ch = (n) => String.fromCharCode(n);
const RLO = ch(0x202E), ZWSP = ch(0x200B);
const T = '2026-11-09';

/* ---------------- helpers ---------------- */

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const digest = (s) => Promise.resolve(sha(s));
const engine = () => C.createEngine({ digest });
const csv = (rows) => rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v))).join(',')).join('\r\n') + '\r\n';
const ssn = (i) => (900 + (i % 99)) + '-' + String(10 + (i % 89)).padStart(2, '0') + '-' + String(1000 + i).padStart(4, '0');

/** A small book: [loan, product, opened, rate, balance, b1 last, first, middle, ssn, dob, b2 last, first, ssn, dob] */
const HEAD = ['Loan Number', 'Product', 'Open Date', 'Note Rate', 'Current Balance', 'Borrower Last Name', 'Borrower First Name', 'Borrower Middle', 'Borrower SSN', 'Borrower DOB', 'Co-Borrower Last Name', 'Co-Borrower First Name', 'Co-Borrower SSN', 'Co-Borrower DOB'];
function book(rows) { return csv([HEAD].concat(rows)); }
function row(i, extra) {
  return Object.assign(['LN-' + (1000 + i), 'Auto - Used', '03/14/2021', '8.99', '$12,000.00', 'Quarrie', 'Tamsin', 'J', ssn(i), '07/22/1990', '', '', '', ''], extra || {});
}
async function pipeline(text, opts = {}) {
  const e = engine();
  const m = e.loadPortfolio({ text, name: 'book.csv', demo: opts.demo !== false });
  const map = Object.assign({}, m.guess.map, opts.map || {});
  const p = e.prepare({ map, statusDate: opts.statusDate || T, batchId: opts.batchId || 'TEST1', cridMode: opts.cridMode, layout: opts.layout, order: opts.order, fraction: opts.fraction, typeMap: opts.typeMap });
  return { e, m, map, p };
}
function result(crid, o) { return Object.assign({ line: 2, crid, active: false, adStart: null, adEnd: null, left: false, leftStart: null, leftEnd: null, future: false, futureStart: null, statusDate: null, component: '', match: '' }, o || {}); }
function ent(o) { return Object.assign({ crid: 'X1B1', loan: 'X-1', b: 1, orig: '2020-01-15', rateU: 89900, bal: 1842000, pay: 41237, fees: 0, type: 'auto', applied: false }, o || {}); }
const ctx = (o) => Object.assign({ policy: 'proactive', today: T, statusDate: T }, o || {});

/* ================================================================== *
 * Reading a portfolio and guessing its columns
 * ================================================================== */

test('reading: quoted commas and line breaks, CRLF and LF, a byte-order mark, semicolons, a report title above the header, ragged rows counted, a headerless file numbered', () => {
  const t = C.parseTable('\uFEFFLoan Report - October\r\nLoan,Name,Note\r\n1,"Okafor, W","two\nlines"\r\n2,Chen,x\r\n3,Ruiz\r\n');
  assert.deepStrictEqual(t.headers, ['Loan', 'Name', 'Note']);
  assert.strictEqual(t.preamble, 1);
  assert.strictEqual(t.rows[0][1], 'Okafor, W');
  assert.strictEqual(t.rows[0][2], 'two lines');
  assert.strictEqual(t.ragged, 1);
  assert.deepStrictEqual(t.lines, [3, 5, 6], 'each row remembers its line in the file');
  assert.strictEqual(C.parseTable('a;b;c\n1;2;3\n').delimiterName, 'semicolon');
  assert.strictEqual(C.parseTable('a\tb\tc\n1\t2\t3\n').delimiterName, 'tab');
  const h = C.parseTable('LN-1,912-34-5678,03/04/1990\nLN-2,913-34-5678,05/06/1991\n');
  assert.strictEqual(h.header, false);
  assert.deepStrictEqual(h.headers, ['Column 1', 'Column 2', 'Column 3']);
});

test('column guessing: the demo is placed exactly, both borrowers; an awkward export (camelCase, co-borrower words, a full-name column, P&I) is placed sensibly; a column chosen twice is a problem', () => {
  const m = engine().loadPortfolio({ text: D.portfolio(T), name: D.FILE, demo: true });
  for (const [k, i] of Object.entries(D.MAP)) assert.strictEqual(m.guess.map[k], i, k);
  assert.ok(Object.values(m.guess.conf).every((c) => c === 'sure'), 'every demo field sure');
  const awkward = csv([
    ['acctNo', 'Prod Type', 'Booked', 'APR', 'UPB', 'Borrower Name', 'Borr SSN', 'Birth Date', 'CoBorrower Name', 'CoBorrower SSN', 'CoBorrower Birth Date', 'P&I', 'SCRA'],
    ['A-1', 'HELOC', '2019-02-03', '9.49%', '1,000.00', 'QUARRIE, TAMSIN J', ssn(1), '1990-07-22', 'Quarrie Wren', ssn(2), '1991-01-02', '210.00', 'N'],
    ['A-2', 'New Auto', '2020-02-03', '7.25%', '2,000.00', 'Halloway, Ulric', ssn(3), '1988-03-04', '', '', '', '310.00', 'Y'],
  ]);
  const g = engine().loadPortfolio({ text: awkward, name: 'x.csv' }).guess.map;
  assert.deepStrictEqual([g.loan, g.type, g.orig, g.rate, g.bal, g.b1Full, g.b1Ssn, g.b1Dob, g.b2Full, g.b2Ssn, g.b2Dob, g.pay, g.applied], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.strictEqual(g.b1Last, null);
  assert.deepStrictEqual(C.splitFull('QUARRIE, TAMSIN J'), { last: 'QUARRIE', first: 'TAMSIN', middle: 'J' });
  assert.deepStrictEqual(C.splitFull('Wren A Quarrie Jr'), { last: 'Quarrie Jr', first: 'Wren', middle: 'A' });
  assert.match(C.mappingProblems({ loan: 0, b1Ssn: 1, b1Last: 1 }).join(' '), /two fields/);
  assert.match(C.mappingProblems({ loan: 0 }).join(' '), /SSN/);
  assert.strictEqual(C.typeOf('Home Equity Line').type, 'mortgage');
  assert.strictEqual(C.typeOf('Home Equity Line').sure, false, 'a home-equity line is flagged to check');
  assert.deepStrictEqual(['1st Mortgage', 'Used Auto', 'Visa Platinum', 'Signature Loan', 'Private Student', 'Boat'].map((v) => C.typeOf(v).type), ['mortgage', 'auto', 'card', 'personal', 'student', 'auto']);
});

test('rates: 9.49, 9.49% and 0.0949 all read; a book whose every rate is 1 or under asks whether they are fractions, with both readings', async () => {
  assert.strictEqual(C.rateUnits(C.readRate('9.49')), 94900);
  assert.strictEqual(C.rateUnits(C.readRate('9.49%')), 94900);
  assert.strictEqual(C.rateUnits(C.readRate('0.0949'), true), 94900);
  assert.strictEqual(C.rateUnits(C.readRate('6.875')), 68750);
  assert.strictEqual(C.readRate('n/a'), null);
  assert.strictEqual(C.readRate('150'), null);
  assert.deepStrictEqual([C.rateText(68750), C.rateText(89900), C.rateText(60000), C.rateText(115000)], ['6.875%', '8.99%', '6.00%', '11.50%']);
  const text = book([row(1, { 3: '0.0949' }), row(2, { 3: '0.0525' })]);
  const e = engine();
  const m = e.loadPortfolio({ text, name: 'f.csv', demo: true });
  const q = e.questions({ map: m.guess.map });
  assert.deepStrictEqual([q.fraction.example, q.fraction.asFraction, q.fraction.asPercent], ['0.0949', '9.49%', '0.0949%']);
  e.prepare({ map: m.guess.map, statusDate: T, batchId: 'R', fraction: true });
  const b = await e.build({ statusDate: T, today: T, batchId: 'R', createdAt: T });
  assert.deepStrictEqual(Object.values(b.batch.map).map((a) => a[3]), [94900, 52500]);
  assert.strictEqual(engine().questions === undefined, false);
  const mixed = engine();
  const mm = mixed.loadPortfolio({ text: book([row(1, { 3: '0.0949' }), row(2, { 3: '5.25' })]), name: 'f.csv', demo: true });
  assert.strictEqual(mixed.questions({ map: mm.guess.map }).fraction, null, 'no question when some rates are percentages');
});

test('ambiguous dates: a file whose every date reads both ways asks once, with both readings; the answer reads every date column that way; a part over 12 decides on its own', () => {
  const amb = book([row(1, { 2: '03/04/2021', 9: '05/06/1990' }), row(2, { 2: '02/01/2020', 9: '07/08/1991' })]);
  const e = engine();
  const m = e.loadPortfolio({ text: amb, name: 'f.csv', demo: true });
  const q = e.questions({ map: m.guess.map });
  assert.deepStrictEqual([q.dates.raw, q.dates.mdy, q.dates.dmy], ['05/06/1990', '1990-05-06', '1990-06-05']);
  const loans = (order) => C.buildLoans(C.parseTable(amb), m.guess.map, { order });
  assert.deepStrictEqual([loans('mdy')[0].orig, loans('mdy')[0].people[0].dob], ['2021-03-04', '1990-05-06']);
  assert.deepStrictEqual([loans('dmy')[0].orig, loans('dmy')[0].people[0].dob], ['2021-04-03', '1990-06-05']);
  assert.strictEqual(C.dateOrder(['13/04/2021', '03/04/2021']), 'dmy');
  assert.strictEqual(C.dateOrder(['04/13/2021']), 'mdy');
  assert.strictEqual(C.dateOrder(['2021-04-13']), 'none');
  const clear = engine();
  const cm = clear.loadPortfolio({ text: book([row(1, { 2: '03/14/2021' })]), name: 'f.csv', demo: true });
  assert.strictEqual(clear.questions({ map: cm.guess.map }).dates, null);
  assert.strictEqual(C.readDate('20210314', 'mdy', true), '2021-03-14');
  assert.strictEqual(C.readDate('20210314', 'mdy', false), null, 'yyyymmdd only in a mapped date column');
});

/* ================================================================== *
 * Row checks
 * ================================================================== */

test('every row check, with counts and the exact rows: no loan id, no SSN, not 9 digits, never issued (area 000, 666, 900-999 outside the example, group 00, serial 0000), dates of birth missing, unreadable and implausible, no last name - all left out; no first name, cut, folded, the same SSN twice on a loan, rate, origination and balance unreadable - included; the same SSN on two loans - fine', async () => {
  const valid = ['123', '45', '6789'].join('');
  assert.strictEqual(C.ssnProblem(valid), '');
  assert.strictEqual(C.ssnProblem('912345678'), 'area 912 (900-999)');
  assert.strictEqual(C.ssnProblem('912345678', true), '', 'the example is the one place the 900 area passes');
  assert.deepStrictEqual(['000451234', '666451234', '912004471', '912450000', '12345678', ''].map((s) => C.ssnProblem(s, true)), ['area 000', 'area 666', 'group 00', 'serial 0000', 'shape', 'missing']);
  const rows = [
    row(1, { 0: '' }),
    row(2, { 8: '' }),
    row(3, { 8: '912-34-567' }),
    row(4, { 8: '000-34-5678' }),
    row(5, { 9: '' }),
    row(6, { 9: 'soon' }),
    row(7, { 9: '01/01/2019' }),
    row(8, { 5: '' }),
    row(9, { 6: '' }),
    row(10, { 5: 'Ibáñez-Montgomery-Featherstone' }),
    row(11, { 5: 'Nguyễn', 6: 'Zoë' }),
    row(12, { 10: 'Quarrie', 11: 'Wren', 12: ssn(12), 13: '01/02/1991' }),
    row(13, { 3: 'TBD' }),
    row(14, { 2: '' }),
    row(15, { 4: '' }),
    row(16, { 8: ssn(17) }),
    row(17),
  ];
  const { p } = await pipeline(book(rows));
  const g = Object.fromEntries(p.groups.map((x) => [x.key, x]));
  const loansOf = (k) => g[k].rows.map((r) => r.loan + '/B' + r.b);
  assert.deepStrictEqual(loansOf('loan-missing'), ['/B1']);
  assert.deepStrictEqual(loansOf('ssn-missing'), ['LN-1002/B1']);
  assert.deepStrictEqual(loansOf('ssn-shape'), ['LN-1003/B1']);
  assert.deepStrictEqual(loansOf('ssn-never'), ['LN-1004/B1']);
  assert.match(g['ssn-never'].rows[0].detail, /area 000 · •••-••-5678/);
  assert.deepStrictEqual(loansOf('dob-missing'), ['LN-1005/B1']);
  assert.deepStrictEqual(loansOf('dob-bad'), ['LN-1006/B1']);
  assert.deepStrictEqual(loansOf('dob-odd'), ['LN-1007/B1']);
  assert.deepStrictEqual(loansOf('last-missing'), ['LN-1008/B1']);
  assert.deepStrictEqual(loansOf('first-missing'), ['LN-1009/B1']);
  assert.deepStrictEqual(g.cut.rows.map((r) => [r.loan, r.before, r.after]), [['LN-1010', 'IBANEZ-MONTGOMERY-FEATHERSTONE', 'IBANEZ-MONTGOMERY-FEATHERS']]);
  assert.deepStrictEqual(g.folded.rows.map((r) => [r.field, r.before, r.after]), [['last', 'Ibáñez-Montgomery-Featherstone', 'IBANEZ-MONTGOMERY-FEATHERSTONE'], ['last', 'Nguyễn', 'NGUYEN'], ['first', 'Zoë', 'ZOE']]);
  assert.deepStrictEqual(loansOf('same-person'), ['LN-1012/B2']);
  assert.deepStrictEqual(loansOf('rate-bad'), ['LN-1013/B1']);
  assert.deepStrictEqual(loansOf('orig-bad'), ['LN-1014/B1']);
  assert.deepStrictEqual(loansOf('bal-bad'), ['LN-1015/B1']);
  assert.deepStrictEqual(loansOf('dup'), ['LN-1016/B1', 'LN-1017/B1']);
  assert.ok(['loan-missing', 'ssn-missing', 'ssn-shape', 'ssn-never', 'dob-missing', 'dob-bad', 'dob-odd', 'last-missing'].every((k) => g[k].sev === 'block'));
  assert.ok(['first-missing', 'cut', 'folded', 'same-person', 'rate-bad', 'orig-bad', 'bal-bad'].every((k) => g[k].sev === 'warn'));
  assert.strictEqual(g.dup.sev, 'info');
  assert.deepStrictEqual(p.counts, { loans: 17, borrowers: 18, ok: 10, left: 8, warned: 4, coBorrowers: 1 });
  assert.ok(!JSON.stringify(p.groups).includes(ssn(16).replace(/-/g, '')), 'an SSN appears in the checks only as its last four digits');
  const fold = C.fold('O’Brien-St. John  Ærø');
  assert.deepStrictEqual([fold.text, fold.changed], ["O'BRIEN-ST JOHN AERO", true]);
  assert.strictEqual(C.fold("O'BRIEN").changed, false, 'upper-casing alone is not a fold');
});

/* ================================================================== *
 * The request file
 * ================================================================== */

test('the fixed-width builder: every field at its exact position in the default layout, padded with spaces on the right, names folded and cut, 119-character lines, CRLF by default and LF on request, split every N, file names, a status date in the future refused', async () => {
  const rows = [row(1, { 5: 'Ibáñez-Montgomery-Featherstone', 6: 'Zoë', 7: '' }), row(2, { 10: 'Quarrie', 11: 'Wren', 12: ssn(22), 13: '12/31/1989' })];
  const { e } = await pipeline(book(rows));
  const b = await e.build({ statusDate: '2026-11-02', today: T, batchId: 'k7q2m', createdAt: T + 'T10:00:00Z' });
  assert.strictEqual(b.files.length, 1);
  assert.strictEqual(b.files[0].name, 'EXAMPLE-muster-request-20261102-K7Q2M.txt', 'the example names its file EXAMPLE-');
  const lines = b.files[0].text.split('\r\n');
  assert.strictEqual(lines.pop(), '', 'every line ends with CRLF, the last one too');
  assert.strictEqual(lines.length, 3);
  assert.ok(lines.every((l) => l.length === 119) && b.allExact);
  const at = (l, s, n) => l.slice(s - 1, s - 1 + n);
  const l0 = lines[0];
  assert.strictEqual(at(l0, 1, 9), ssn(1).replace(/-/g, ''));
  assert.strictEqual(at(l0, 10, 8), '19900722');
  assert.strictEqual(at(l0, 18, 26), 'IBANEZ-MONTGOMERY-FEATHERS', 'folded and cut to 26');
  assert.strictEqual(at(l0, 44, 20), 'ZOE'.padEnd(20));
  assert.strictEqual(at(l0, 64, 28), 'LN1001B1'.padEnd(28));
  assert.strictEqual(at(l0, 92, 20), ' '.repeat(20), 'an empty optional field is all spaces');
  assert.strictEqual(at(l0, 112, 8), '20261102');
  assert.strictEqual(at(lines[2], 18, 26), 'QUARRIE'.padEnd(26));
  assert.strictEqual(at(lines[2], 64, 28).trim(), 'LN1002B2');
  assert.strictEqual(at(lines[2], 10, 8), '19891231');
  assert.ok(!/[^\x20-\x7e]/.test(b.files[0].text.replace(/\r\n/g, '')), 'plain ASCII - no byte-order mark, nothing outside A-Z, digits and spaces');
  assert.strictEqual(b.files[0].sha256, sha(b.files[0].text));
  const lf = await e.build({ statusDate: T, today: T, batchId: 'B', createdAt: T, lineEnding: 'lf' });
  assert.ok(!lf.files[0].text.includes('\r') && lf.files[0].text.endsWith('\n'));
  await assert.rejects(e.build({ statusDate: '2026-11-10', today: T, batchId: 'B', createdAt: T }), /cannot be in the future/);
  const big = await pipeline(book(Array.from({ length: 120 }, (_, i) => row(i + 1))));
  const sp = await big.e.build({ statusDate: T, today: T, batchId: 'SPLIT', createdAt: T, split: 50 });
  assert.deepStrictEqual(sp.files.map((f) => [f.name.replace(/^EXAMPLE-muster-request-\d+-/, ''), f.records]), [['SPLIT-1.txt', 50], ['SPLIT-2.txt', 50], ['SPLIT-3.txt', 20]]);
  assert.strictEqual(sp.batch.files.length, 3);
  const one = await big.e.build({ statusDate: T, today: T, batchId: 'ONE', createdAt: T, split: 0 });
  assert.strictEqual(one.files.length, 1);
});

test('the layout: edited starts and lengths are used; overlaps, a field past the line, too-short dates and SSNs are refused in words; a bad layout never builds; reset is the default', async () => {
  assert.deepStrictEqual(C.layoutProblems(C.DEFAULT_LAYOUT), []);
  const lay = JSON.parse(JSON.stringify(C.DEFAULT_LAYOUT));
  lay.lineLength = 130; lay.fields.status = { start: 121, len: 8 };
  assert.deepStrictEqual(C.layoutProblems(lay), []);
  const { e } = await pipeline(book([row(1)]), { layout: lay });
  const b = await e.build({ statusDate: T, today: T, batchId: 'L', createdAt: T, layout: lay });
  const l = b.files[0].text.split('\r\n')[0];
  assert.strictEqual(l.length, 130);
  assert.strictEqual(l.slice(120, 128), '20261109');
  assert.strictEqual(l.slice(111, 120), ' '.repeat(9), 'the gap is spaces');
  assert.strictEqual(b.batch.layoutDefault, false);
  const over = JSON.parse(JSON.stringify(C.DEFAULT_LAYOUT)); over.fields.first.start = 40;
  assert.match(C.layoutProblems(over).join(' '), /Last name \(18-43\) overlaps First name \(40-59\)/);
  const past = JSON.parse(JSON.stringify(C.DEFAULT_LAYOUT)); past.fields.status.len = 9;
  assert.match(C.layoutProblems(past).join(' '), /ends at position 120, past the line length of 119/);
  const short = JSON.parse(JSON.stringify(C.DEFAULT_LAYOUT)); short.fields.dob.len = 6;
  assert.match(C.layoutProblems(short).join(' '), /Date of birth needs at least 8 characters/);
  const junk = JSON.parse(JSON.stringify(C.DEFAULT_LAYOUT)); junk.fields.ssn.start = 'x';
  assert.ok(C.layoutProblems(junk).length);
  assert.deepStrictEqual(C.cleanLayout(over), C.DEFAULT_LAYOUT, 'an unusable layout never reaches the builder');
  assert.deepStrictEqual(C.rulerLines(12), ['         1  ', '123456789012']);
});

test('customer record ids: the loan id cleaned to A-Z and 0-9 plus B1 / B2; two loans that clean to the same id - the second left out; one too long - left out; short codes from Muster never collide and carry no loan id', async () => {
  assert.strictEqual(C.cleanCrid('lcu-40112 ', 1), 'LCU40112B1');
  const { p } = await pipeline(book([row(1, { 0: 'LN-1001' }), row(2, { 0: 'LN 1001' }), row(3, { 0: 'X'.repeat(30) })]));
  const g = Object.fromEntries(p.groups.map((x) => [x.key, x]));
  assert.deepStrictEqual(g['crid-dup'].rows.map((r) => [r.loan, r.detail]), [['LN 1001', 'LN1001B1 - also line 2']]);
  assert.deepStrictEqual(g['crid-long'].rows.map((r) => r.loan), ['X'.repeat(30)]);
  assert.strictEqual(p.counts.ok, 1);
  const s = await pipeline(book([row(1, { 0: 'LN-1001' }), row(2, { 0: 'LN 1001' }), row(3, { 0: 'X'.repeat(30) })]), { cridMode: 'short', batchId: 'Q7Z2M' });
  assert.strictEqual(s.p.counts.ok, 3, 'short codes leave nothing out');
  const b = await s.e.build({ statusDate: T, today: T, batchId: 'Q7Z2M', createdAt: T, cridMode: 'short' });
  assert.deepStrictEqual(Object.keys(b.batch.map), ['Q7Z2M0001', 'Q7Z2M0002', 'Q7Z2M0003']);
  assert.strictEqual(b.batch.map.Q7Z2M0002[0], 'LN 1001', 'the batch record maps the code back to the loan');
  assert.ok(!b.files[0].text.includes('LN1001'), 'no loan id in the file');
  const many = new Set(Array.from({ length: 5000 }, (_, i) => C.shortCrid('ABCDE', i + 1)));
  assert.strictEqual(many.size, 5000);
});

test('the batch record holds no SSN, date of birth or name - only the customer record id, the loan id and what a decision needs; one whose loan ids carry an SSN or a name is refused', async () => {
  const { e } = await pipeline(D.portfolio(T), {});
  const b = await e.build({ statusDate: T, today: T, batchId: 'DEMO', createdAt: T + 'T09:00:00Z' });
  const json = JSON.stringify(b.batch);
  const loans = D.book(T);
  for (const L of loans) for (const P of L.people) {
    assert.ok(!json.includes(P.ssn) && !json.includes(P.ssn.replace(/-/g, '')), 'no SSN');
    if (P.dob) assert.ok(!json.includes(P.dob) && !json.includes(P.dob.replace(/-/g, '')), 'no date of birth');
    for (const n of [P.last, P.first]) assert.ok(!new RegExp('\\b' + C.fold(n).text.replace(/[-']/g, '.') + '\\b', 'i').test(json), 'no name: ' + n);
  }
  assert.ok(!/\d{9}/.test(json), 'no run of nine digits at all');
  assert.deepStrictEqual(Object.keys(b.batch).sort(), ['count', 'createdAt', 'cridMode', 'demo', 'files', 'id', 'layoutDefault', 'lineEnding', 'loans', 'map', 'statusDate', 'v']);
  assert.deepStrictEqual(C.entry(b.batch, 'LCU40112B1'), { crid: 'LCU40112B1', loan: 'LCU-40112', b: 1, orig: C.addDays(T, -1115), rateU: 89900, bal: 1842000, pay: 41237, fees: 0, type: 'auto', applied: false });
  // A book that keys its loans on SSNs.
  const keyed = await pipeline(book([row(1, { 0: ssn(1) })]));
  await assert.rejects(keyed.e.build({ statusDate: T, today: T, batchId: 'K', createdAt: T }), /carry borrowers’ SSNs or names/);
  const named = await pipeline(book([row(1, { 0: 'QUARRIE-7' })]));
  await assert.rejects(named.e.build({ statusDate: T, today: T, batchId: 'K', createdAt: T }), /SSNs or names/);
  const shortOk = await pipeline(book([row(1, { 0: 'LN-77' })]), { cridMode: 'short' });
  assert.ok((await shortOk.e.build({ statusDate: T, today: T, batchId: 'K', createdAt: T, cridMode: 'short' })).batch.count === 1);
  assert.throws(() => C.safeBatch({ id: 'x' }), /not a batch/);
  const forged = C.safeBatch({ id: 'AB12C', statusDate: T, map: { 'ab-1<b>': ['L-1', 2, 'nope', 1.5, -4, 'x', null, 'boat', 'yes'], ok: 'not an array' }, files: [{ name: '../../etc', records: 'x', sha256: 'zz' }], ssn: ssn(1), names: ['QUARRIE'] });
  assert.deepStrictEqual(forged.map, { AB1B: ['L-1', 2, '', null, null, null, 0, 'other', 1] });
  assert.deepStrictEqual(forged.files, [{ name: 'etc', records: 0, sha256: '' }]);
  assert.ok(!JSON.stringify(forged).includes('QUARRIE') && !JSON.stringify(forged).includes(ssn(1)), 'unknown fields are dropped, not kept');
});

/* ================================================================== *
 * Results
 * ================================================================== */

test('the CSV results reader: columns guessed by header; Yes/No/Y/N/True/False/1/0; dates as YYYYMMDD, YYYY-MM-DD or MM/DD/YYYY; any SSN, date-of-birth or name column ignored and never kept', () => {
  assert.deepStrictEqual(['Yes', 'n', 'TRUE', 'false', '1', '0', '', 'maybe'].map(C.readYesNo), [true, false, true, false, true, false, null, null]);
  assert.deepStrictEqual(['20260602', '2026-06-02', '06/02/2026', '6/2/2026', '00000000', '02.06.2026', '2026-02-30'].map(C.readResultDate), ['2026-06-02', '2026-06-02', '2026-06-02', '2026-06-02', null, null, null]);
  const g = C.guessResultColumns(D.RHEAD);
  assert.deepStrictEqual(g.map, { crid: 0, active: 1, adStart: 2, adEnd: 3, left: 4, leftStart: 5, leftEnd: 6, future: 7, futureStart: 8, component: 9, match: 10, statusDate: null });
  const odd = ['SSN', 'Date of Birth', 'Last Name', 'First Name', 'Cust Rec ID', 'AD Status', 'EOD', 'Projected End', 'Left AD (367)', 'LD Start', 'LD End', 'Future Call Up', 'Call-Up Report Date', 'Branch', 'Error Message', 'Status Date'];
  const og = C.guessResultColumns(odd);
  assert.deepStrictEqual([og.map.crid, og.map.active, og.map.adStart, og.map.adEnd, og.map.left, og.map.future, og.map.futureStart, og.map.component, og.map.match, og.map.statusDate], [4, 5, 6, 7, 8, 11, 12, 13, 14, 15]);
  assert.deepStrictEqual(og.ignored, [0, 1, 2, 3], 'SSN, DOB and name columns are ignored');
  const text = csv([odd, [ssn(1), '19900722', 'Quarrie', 'Tamsin', 'LN1001B1', 'Y', '20260602', '', 'N', '', '', 'N', '', 'Army', '', '20261109'], [ssn(2), '19910101', 'Halloway', 'Ulric', 'LN1002B1', 'N', '', '', 'N', '', '', 'Y', '12/24/2026', '', '', '20261109']]);
  const e = engine();
  const meta = e.loadResults({ text, name: 'r.csv' });
  assert.strictEqual(meta.mode, 'csv');
  assert.ok(meta.sample.every((r) => r.slice(0, 4).every((v) => v === '(ignored)')), 'the preview never shows them');
  const map = Object.assign({}, meta.guess, { crid: 4 });
  const out = e.readResults({ map: Object.assign({}, map, { adEnd: 0 }) }).results;
  assert.deepStrictEqual(out.map((r) => [r.crid, r.active, r.adStart, r.future, r.futureStart, r.statusDate, r.component]), [['LN1001B1', true, '2026-06-02', false, null, '2026-11-09', 'Army'], ['LN1002B1', false, null, true, '2026-12-24', '2026-11-09', '']]);
  assert.ok(out.every((r) => r.adEnd === null), 'a column mapped to an ignored SSN column reads nothing');
  const flat = JSON.stringify(out);
  assert.ok(!/Quarrie|Halloway|Tamsin|19900722/.test(flat) && !flat.includes(ssn(1)), 'nothing from the ignored columns is kept');
  assert.match(C.resultProblems({ crid: null }).join(' '), /customer record id/);
});

test('the fixed-width results reader: spans marked on a ruler read each field; overlaps and a missing record id are refused; a header line is skipped; nine-digit runs are hidden in the preview with the same width', () => {
  // An awkward layout: the request echoed first (SSN and date of birth run together), then statuses.
  const lines = [
    'REC     CUSTOMER RECORD ID           A ADSTART  ADEND    L LDSTART  LDEND    F FUTURE   ',
    ['912345678' + '19900722', 'LN1001B1'.padEnd(28), 'Y', '20260602', '        ', 'N', '        ', '        ', 'N', '        '].join(' '),
    ['913345678' + '19910101', 'LN1002B1'.padEnd(28), 'N', '        ', '        ', 'Y', '20250101', '20260701', 'N', '        '].join(' '),
  ];
  const text = lines.join('\n') + '\n';
  assert.strictEqual(C.looksFixed(text), true);
  assert.strictEqual(C.looksFixed(D.results({ map: { A1B1: ['A-1', 1] } }, T)), false);
  const e = engine();
  const meta = e.loadResults({ text, name: 'dmdc.txt' });
  assert.strictEqual(meta.mode, 'fixed');
  assert.strictEqual(meta.skip, 1, 'a header line with no digits is skipped');
  assert.strictEqual(meta.lines[1].slice(0, 17), '•'.repeat(17), 'the SSN and date of birth run is hidden, width kept');
  assert.strictEqual(meta.lines[1].length, lines[1].length);
  const spans = [{ field: 'crid', start: 19, len: 28 }, { field: 'active', start: 48, len: 1 }, { field: 'adStart', start: 50, len: 8 }, { field: 'left', start: 68, len: 1 }, { field: 'leftStart', start: 70, len: 8 }, { field: 'leftEnd', start: 79, len: 8 }];
  assert.deepStrictEqual(C.spanProblems(spans, 100), []);
  assert.match(C.spanProblems([{ field: 'crid', start: 19, len: 28 }, { field: 'active', start: 40, len: 2 }], 100).join(' '), /overlap/);
  assert.match(C.spanProblems([{ field: 'active', start: 48, len: 1 }], 100).join(' '), /customer record id/);
  assert.match(C.spanProblems([{ field: 'nope', start: 1, len: 1 }], 100).join(' '), /not one of the fields/);
  const out = e.readResults({ spans, skip: 1 }).results;
  assert.deepStrictEqual(out.map((r) => [r.line, r.crid, r.active, r.adStart, r.left, r.leftStart, r.leftEnd]), [[2, 'LN1001B1', true, '2026-06-02', false, null, null], [3, 'LN1002B1', false, null, true, '2025-01-01', '2026-07-01']]);
  assert.ok(!JSON.stringify(out).includes('912345678'), 'the SSN on the line is never read');
});

test('matching back: the batch most lines belong to is picked; lines matching no record listed with their line numbers; records with no line listed and decided "Check by hand"; a repeated line counted once', () => {
  const b1 = { id: 'AAAAA', statusDate: T, map: { X1B1: ['X-1', 1, '2020-01-01', 89900, 100000, 0, 0, 'auto', 0], X2B1: ['X-2', 1, '2020-01-01', 89900, 100000, 0, 0, 'auto', 0], X3B1: ['X-3', 1, '', null, null, null, 0, 'auto', 0] } };
  const b2 = { id: 'BBBBB', statusDate: T, map: { Y1B1: ['Y-1', 1, '', null, null, null, 0, 'other', 0] } };
  const res = [result('X1B1', { line: 2 }), result('X2B1', { line: 3, active: true, adStart: '2026-06-01' }), result('X2B1', { line: 4 }), result('ZZZB1', { line: 5 })];
  const m = C.matchResults(res, [b2, b1]);
  assert.strictEqual(m.batchId, 'AAAAA');
  assert.deepStrictEqual(m.matched.map((x) => x.crid), ['X1B1', 'X2B1']);
  assert.deepStrictEqual(m.unmatched, [{ line: 5, crid: 'ZZZB1' }]);
  assert.deepStrictEqual(m.missing, ['X3B1']);
  assert.strictEqual(m.duplicates, 1);
  const ds = C.decideAll(b1, m, ctx());
  assert.deepStrictEqual(ds.map((d) => d.code), ['none', 'eligible', 'hand']);
  assert.match(ds[2].sentence, /No result line came back/);
  assert.strictEqual(C.matchResults([result('QQB1')], [b1]).batchId, null);
});

/* ================================================================== *
 * Decisions and the 6% math
 * ================================================================== */

test('every decision branch, each with its sentence and the rule it rests on', () => {
  const S = '2026-06-02';
  const d = (e, r, c) => C.decide(ent(e), r === null ? null : result('X1B1', r), ctx(c));
  // No action.
  const none = d({}, {});
  assert.deepStrictEqual([none.code, none.rules], ['none', ['dmdc']]);
  assert.match(none.sentence, /Not on active duty on 9 Nov 2026, not released in the 367 days before it, and no future call-up/);
  // Active, at or under 6%.
  const under = d({ rateU: 52500 }, { active: true, adStart: S });
  assert.deepStrictEqual([under.code, under.word], ['under', 'No change - at or under 6%']);
  // Active, under 6% but fees take it over - fees count as interest.
  const fees = d({ rateU: 55000, bal: 100000, fees: 500 }, { active: true, adStart: S });
  assert.strictEqual(fees.code, 'eligible');
  assert.ok(fees.rules.includes('fees'));
  // Active, open-ended.
  const open = d({}, { active: true, adStart: S });
  assert.deepStrictEqual([open.code, open.capStart, open.capEnd, open.open], ['eligible', S, null, true]);
  assert.ok(open.rules.includes('cap') && open.rules.includes('forgiven') && !open.rules.includes('mortgage'));
  // Active with an end date, not a mortgage: the cap ends with service.
  const ends = d({ type: 'card' }, { active: true, adStart: S, adEnd: '2027-05-28' });
  assert.deepStrictEqual([ends.capEnd, ends.open], ['2027-05-28', false]);
  // A mortgage: service and one year after.
  const mort = d({ type: 'mortgage' }, { active: true, adStart: S, adEnd: '2027-01-13' });
  assert.deepStrictEqual([mort.code, mort.capEnd], ['eligible', '2028-01-13']);
  assert.ok(mort.rules.includes('mortgage'));
  assert.match(mort.sentence, /one year after service ends on 13 Jan 2027, because it is a mortgage/);
  // Taken out during service.
  const during = d({ orig: '2026-08-01' }, { active: true, adStart: S });
  assert.strictEqual(during.code, 'policy');
  assert.match(during.sentence, /Taken out during service .* the statute’s cap covers obligations from before service; your policy may still apply it/);
  assert.strictEqual(d({ orig: S }, { active: true, adStart: S }).code, 'policy', 'on the day service began counts as during');
  // Released within 367 days: a mortgage keeps its tail.
  const relM = d({ type: 'mortgage', orig: '2020-10-31' }, { left: true, leftStart: '2025-05-26', leftEnd: '2026-07-10' });
  assert.deepStrictEqual([relM.code, relM.capStart, relM.capEnd, relM.R, relM.askBy], ['eligible', '2025-05-26', '2027-07-10', '2026-07-10', '2027-01-06']);
  // Released, not a mortgage: owed for the service period; proactive applies it now, notice waits.
  const relA = d({}, { left: true, leftStart: '2025-05-26', leftEnd: '2026-07-10' });
  assert.deepStrictEqual([relA.code, relA.capEnd, relA.est.monthly], ['eligible', '2026-07-10', 0]);
  assert.match(relA.sentence, /They can ask until 6 Jan 2027; your proactive policy applies it now/);
  const relN = d({}, { left: true, leftStart: '2025-05-26', leftEnd: '2026-07-10' }, { policy: 'notice' });
  assert.strictEqual(relN.code, 'notice');
  assert.match(relN.sentence, /They can ask until 6 Jan 2027/);
  const late = d({}, { left: true, leftStart: '2025-01-01', leftEnd: '2026-01-02' }, { policy: 'notice' });
  assert.strictEqual(late.code, 'policy');
  assert.match(late.sentence, /The 180 days for written notice ended on 1 Jul 2026 - your policy decides/);
  // The notice policy on an active case.
  const notice = d({}, { active: true, adStart: S }, { policy: 'notice' });
  assert.strictEqual(notice.code, 'notice');
  assert.ok(notice.rules.includes('notice'));
  assert.match(notice.sentence, /Tell the borrower - awaiting notice/);
  // A future call-up.
  const watch = d({}, { future: true, futureStart: '2026-12-24' });
  assert.deepStrictEqual([watch.code, watch.C], ['watch', '2026-12-24']);
  assert.match(watch.sentence, /check again on that date/);
  // Check by hand: an error, no status, no start date, no rate, no origination.
  assert.strictEqual(d({}, { active: null, left: null, future: null, match: 'No match found' }).code, 'hand');
  assert.match(d({}, { active: null, left: null, future: null }).sentence, /No status could be read/);
  assert.match(d({}, { active: true }).sentence, /no start date/);
  assert.match(d({ rateU: null }, { active: true, adStart: S }).sentence, /no readable rate/);
  assert.match(d({ orig: null }, { active: true, adStart: S }).sentence, /no readable origination date/);
  assert.match(d({}, { left: true, leftEnd: '2026-07-10' }).sentence, /does not say when that service began/);
  assert.strictEqual(d({}, null).code, 'hand');
  // Already applied.
  assert.match(d({ applied: true }, { active: true, adStart: S }).sentence, /already marks the cap as applied. Confirm it runs from 2 Jun 2026/);
  assert.match(d({ applied: true }, {}).sentence, /but this check shows no active duty/);
  // Co-borrower, status date mismatch, and a call-up on top of service.
  const co = d({ b: 2 }, { active: true, adStart: S, future: true, futureStart: '2027-01-01', statusDate: '2026-11-01' });
  assert.ok(co.notes.some((n) => /borrower 2 on this loan/.test(n)) && co.notes.some((n) => /not the batch’s/.test(n)) && co.notes.some((n) => /future call-up/.test(n)));
  for (const x of [none, under, open, mort, during, relA, relN, notice, watch]) for (const k of x.rules) assert.ok(C.RULES[k], k);
});

test('the 6% math in integer cents, checked against hand-worked cases', () => {
  // $18,420.00 at 8.99% for 160 days: 1,842,000 x 0.0299 x 160 / 365 = 24,142.6 -> 24,143 cents.
  assert.strictEqual(C.overInterest(1842000, 89900, 160), 24143);
  // $231,560.42 at 6.875% for 300 days: 23,156,042 x 0.00875 x 300 / 365 = 166,532.9 -> 166,533.
  assert.strictEqual(C.overInterest(23156042, 68750, 300), 166533);
  // $4,860.15 at 24.99% for 75 days: 486,015 x 0.1899 x 75 / 365 = 18,964.7 -> 18,965.
  assert.strictEqual(C.overInterest(486015, 249900, 75), 18965);
  // Fees $3.95 a month for 75 days: 395 x 75 x 12 / 365 = 973.97 -> 974.
  assert.strictEqual(C.feesFor(395, 75), 974);
  // Monthly drop: $4,860.15 x 18.99% / 12 = 7,691.2 -> 7,691, plus $3.95 = 8,086.
  assert.strictEqual(C.monthlyOver(486015, 249900, 395), 8086);
  assert.strictEqual(C.monthlyOver(1842000, 89900, 0), 4590);
  // A $500,000 mortgage at 12% for 400 days - big enough to overflow a double's integers in the product.
  assert.strictEqual(C.overInterest(50000000, 120000, 400), 3287671);
  assert.strictEqual(C.overInterest(1842000, 89900, 0), 0);
  // Under 6% with fees: 100,000 x (5.5% - 6%) / 12 = -41.67, + 500 = 458.
  assert.strictEqual(C.monthlyOver(100000, 55000, 500), 458);
  assert.strictEqual(C.overCap(100000, 55000, 500), true);
  assert.strictEqual(C.overCap(100000, 55000, 0), false);
  assert.strictEqual(C.overCap(10000000, 55000, 500), false, 'a big balance leaves room under 6% for small fees');
  const e = C.estimate(ent({ bal: 486015, rateU: 249900, fees: 395 }), '2026-08-26', T, true);
  assert.deepStrictEqual([e.days, e.interest, e.fees, e.owed, e.monthly], [75, 18965, 974, 19939, 8086]);
  assert.deepStrictEqual(e.math, [
    'Rate 24.99% − 6.00% = 18.99 points over the cap',
    '$4,860.15 × 18.99% × 75 days ÷ 365 = $189.65 (26 Aug 2026 to 9 Nov 2026)',
    'Fees $3.95 a month × 75 days × 12 ÷ 365 = $9.74 (fees count as interest)',
    'Owed so far ≈ $199.39',
    'Payment drop ≈ $4,860.15 × 18.99% ÷ 12 + $3.95 fees = $80.86 a month while capped',
  ]);
  // A cap that ended: owed to its end, no monthly drop.
  const ended = C.decide(ent({ type: 'card' }), result('X1B1', { active: true, adStart: '2026-01-01', adEnd: '2026-03-02' }), ctx());
  assert.deepStrictEqual([ended.est.days, ended.est.monthly], [60, 0]);
  assert.strictEqual(ended.est.owed, C.overInterest(1842000, 89900, 60));
  assert.strictEqual(C.addYears('2028-02-29', 1), '2029-02-28');
  assert.strictEqual(C.daysBetween('2026-03-07', '2026-03-09'), 2, 'UTC days: a clock change is not a day');
});

/* ================================================================== *
 * The worklist, the audit chain, exports
 * ================================================================== */

async function demoRun(day, policy) {
  const e = engine();
  const m = e.loadPortfolio({ text: D.portfolio(day), name: D.FILE, demo: true });
  const p = e.prepare({ map: m.guess.map, statusDate: day, batchId: 'DEMO' });
  const b = await e.build({ statusDate: day, today: day, batchId: 'DEMO', createdAt: day + 'T09:00:00Z' });
  e.loadResults({ text: D.results(b.batch, day), name: D.RESULTS_FILE });
  const r = e.readResults({ map: C.guessResultColumns(D.RHEAD).map });
  const mt = C.matchResults(r.results, [b.batch]);
  return { e, m, p, b, r, mt, ds: C.decideAll(b.batch, mt, { policy: policy || 'proactive', today: day }) };
}

test('the audit log: each event SHA-256-chained (verified here with node:crypto over the core’s canonical form); an edit, a removal and a swap each found, with the first broken link', async () => {
  const s = MS.create(MS.memory());
  const id = 'AUDIT';
  await s.appendAudit(id, { kind: 'batch', at: T + 'T09:00:00Z', value: { records: 3, files: [{ name: 'x.txt', sha256: sha('x') }] } }, digest);
  await s.appendAudit(id, { kind: 'results', at: T + 'T09:01:00Z', value: { matched: 3, unmatched: 0, missing: 0 } }, digest);
  await s.appendAudit(id, { kind: 'step', at: T + 'T09:02:00Z', crid: 'X1B1', field: 'rate', value: '2026-11-10', by: 'EM' }, digest);
  await s.appendAudit(id, { kind: 'step', at: T + 'T09:03:00Z', crid: 'X1B1', field: 'refund', value: { date: '2026-11-11', cents: 24143 }, by: 'EM' }, digest);
  const ev = await s.getAudit(id);
  assert.deepStrictEqual(ev.map((e) => e.seq), [1, 2, 3, 4]);
  assert.strictEqual(ev[0].prev, C.GENESIS);
  for (let i = 0; i < ev.length; i++) {
    const { hash, ...rest } = ev[i];
    const keys = Object.keys(rest).sort();
    const canon = '{' + keys.map((k) => JSON.stringify(k) + ':' + C.canonical(rest[k])).join(',') + '}';
    assert.strictEqual(hash, sha(canon), 'node:crypto over the canonical form');
    if (i) assert.strictEqual(ev[i].prev, ev[i - 1].hash);
  }
  assert.deepStrictEqual(await C.verifyAudit(ev, digest), { ok: true, n: 4, verified: 4, broken: null });
  const edited = JSON.parse(JSON.stringify(ev)); edited[2].value = '2026-11-01';
  const r1 = await C.verifyAudit(edited, digest);
  assert.deepStrictEqual([r1.ok, r1.broken.seq, r1.verified], [false, 3, 2]);
  assert.match(r1.broken.why, /Event 3 was changed after it was written/);
  const removed = ev.slice(0, 1).concat(ev.slice(2));
  assert.match((await C.verifyAudit(removed, digest)).broken.why, /missing or out of order before event 2/);
  const swapped = [ev[0], ev[2], ev[1], ev[3]];
  assert.strictEqual((await C.verifyAudit(swapped, digest)).broken.i, 1);
  const relinked = JSON.parse(JSON.stringify(ev)); relinked[3].prev = ev[1].hash;
  assert.match((await C.verifyAudit(relinked, digest)).broken.why, /does not point at the hash/);
  const w = C.workFrom(ev);
  assert.deepStrictEqual(w.cases.X1B1, Object.assign({}, w.cases.X1B1, { rate: '2026-11-10', refund: '2026-11-11', refundCents: 24143, by: 'EM', done: false }));
  assert.match(C.describeEvent(ev[3]), /X1B1: refund or credit \$241\.43 on 11 Nov 2026 · EM/);
  assert.ok(!('setAudit' in s) && !('editAudit' in s) && !('deleteEvent' in s), 'there is no way to edit or delete one event');
});

test('the worklist: every case that needs a person, most pressing first; steps tick off from the log; the re-check list; median days from match to rate change', async () => {
  const { ds } = await demoRun(T);
  const list = C.worklist(ds, { cases: {} });
  assert.deepStrictEqual(list.map((w) => w.d.code), ['eligible', 'eligible', 'eligible', 'eligible', 'eligible', 'policy', 'hand', 'watch']);
  assert.deepStrictEqual(list.slice(0, 5).map((w) => w.d.loan), ['LCU-40172', 'LCU-40135', 'LCU-40112', 'LCU-40127', 'LCU-40141'], 'biggest estimate first');
  assert.deepStrictEqual(list[0].left, ['rate', 'refund', 'letter', 'done']);
  assert.deepStrictEqual(list[5].left, ['outcome']);
  const events = [
    { kind: 'results', at: T + 'T09:00:00Z' },
    { kind: 'step', crid: 'LCU40112B1', field: 'rate', value: '2026-11-12', at: '' },
    { kind: 'step', crid: 'LCU40135B1', field: 'rate', value: '2026-11-11', at: '' },
    { kind: 'step', crid: 'LCU40127B1', field: 'rate', value: '2026-11-16', at: '' },
    { kind: 'step', crid: 'LCU40127B1', field: 'done', value: true, at: '' },
    { kind: 'step', crid: 'LCU40163B1', field: 'outcome', value: 'apply', at: '' },
  ];
  const work = C.workFrom(events);
  assert.strictEqual(C.medianToRate(work), 3, 'the median of 3, 2 and 7 days');
  const w2 = C.worklist(ds, work);
  assert.strictEqual(w2[w2.length - 1].d.loan, 'LCU-40127', 'done cases go to the end');
  assert.deepStrictEqual(w2.find((w) => w.d.loan === 'LCU-40163').left, ['rate', 'letter', 'done'], 'the policy case, applied, gets the steps');
  assert.deepStrictEqual(C.recheckList(ds).map((x) => [x.loan, x.b]).sort(), [['LCU-40112', 1], ['LCU-40141', 2], ['LCU-40172', 1], ['LCU-40188', 1]].sort());
});

test('exports: the per-loan CSV is formula-safe and masks loan ids on request; the summary is escaped Markdown with the numbers; the audit log JSON carries its chain', async () => {
  const { b, ds } = await demoRun(T);
  const hostile = Object.assign({}, b.batch, { map: Object.assign({}, b.batch.map, { EVILB1: ['=HYPERLINK("http://x","y")', 1, '2020-01-01', 89900, 100, 0, 0, 'auto', 0] }) });
  const all = ds.concat([C.decide(C.entry(hostile, 'EVILB1'), null, ctx())]);
  const out = C.examCsv(hostile, all, { cases: { LCU40112B1: { rate: '2026-11-12', refund: '2026-11-13', refundCents: 24143, letter: null, done: false, by: 'EM', note: '+1 call back', outcome: '' } } }, {});
  const lines = out.trim().split('\r\n');
  assert.strictEqual(lines[0], C.toCsv([['batch', 'status_date', 'customer_record_id', 'loan', 'borrower', 'loan_type', 'origination', 'rate', 'balance', 'decision', 'why', 'active_duty_start', 'active_duty_end', 'left_active_duty', 'future_call_up', 'cap_start', 'cap_end', 'est_owed', 'est_monthly_drop', 'rate_reduced', 'refund_date', 'refund_amount', 'letter_sent', 'done', 'decided_by', 'note']]).trim());
  assert.strictEqual(lines.length, 70);
  assert.ok(out.includes(`"'=HYPERLINK(""http://x"",""y"")"`), 'a formula is defused with an apostrophe');
  assert.ok(out.includes("'+1 call back"));
  assert.ok(lines.some((l) => l.includes('LCU-40112') && l.includes('241.43') && l.includes('2026-11-12') && l.includes('EM')));
  const masked = C.examCsv(b.batch, ds, { cases: {} }, { mask: true });
  assert.ok(!masked.includes('LCU-40112') && masked.includes('••••0112'));
  const md = C.summaryMarkdown(b.batch, ds, { cases: {} }, { ok: true, n: 10 }, {});
  assert.match(md, /^# SCRA 6% cap check - batch DEMO/);
  assert.match(md, /Checked 68 borrowers on 58 loans on 9 Nov 2026 \(the active duty status date\)\. 6 were on active duty, 1 left active duty in the 367 days before it and 1 had a future call-up\. 5 cases eligible, est\. \$5,239\.05 owed so far and \$505\.42 a month off payments\. 0 applied \(rate reduced\)\./);
  assert.match(md, /Verified: 10 events/);
  assert.match(md, /A starting checklist, not legal advice - your policy and counsel decide\./);
  assert.match(md, /An estimate - your servicing system calculates the exact amount from the payment history\./);
  const md2 = C.summaryMarkdown(Object.assign({}, b.batch, { id: '<b>*' }), ds, { cases: {} }, null, {});
  assert.ok(md2.includes('\\<b\\>\\*') && !md2.includes('<b>'), 'Markdown-escaped');
  const j = JSON.parse(C.auditJson(b.batch, [{ seq: 1, hash: 'h' }], { ok: true }));
  assert.deepStrictEqual([j.app, j.batch, j.verified, j.events.length], ['muster', 'DEMO', true, 1]);
  assert.match(j.recipe, /sha256/);
});

/* ================================================================== *
 * The letter and the AI letter
 * ================================================================== */

test('the template letter: filled on the device with the case’s facts; name and loan number from the portfolio while it is open, placeholders otherwise; an unknown placeholder is listed, never guessed', async () => {
  const { e, ds } = await demoRun(T);
  const d = ds.find((x) => x.loan === 'LCU-40112');
  const person = e.person({ loan: d.loan, b: d.b });
  assert.deepStrictEqual(Object.keys(person).sort(), ['borrower_name', 'loan_number']);
  const facts = C.letterFacts(d, T);
  const f = C.fillLetter(C.DEFAULT_TEMPLATE, facts, Object.assign({ servicer_name: D.LENDER, contact_line: D.CONTACT }, person));
  assert.deepStrictEqual(f.unknown, []);
  assert.match(f.text, /^Larkmoor Community Credit Union\nNovember 9, 2026\n\nDear [A-Z][a-z]+ [A-Z]\. [A-Z][a-z-]+,/);
  assert.match(f.text, /We are reducing the interest rate on this loan to 6% from June 2, 2026\./);
  assert.match(f.text, /about \$241\.43 of interest above 6% will be credited to your loan, and your monthly payment will drop by about \$45\.90/);
  assert.match(f.text, /Servicemembers Civil Relief Act/);
  const blank = C.fillLetter('Dear {{borrower_name}}, loan {{loan_number}} {{ssn}}', facts, {});
  assert.deepStrictEqual([blank.text, blank.unknown], ['Dear [borrower name], loan [loan number] {{ssn}}', ['ssn']]);
  const rel = ds.find((x) => x.loan === 'LCU-40172');
  assert.match(C.letterFacts(rel, T).cap_period, /from May 26, 2025 to July 10, 2027/);
  const relA = C.decide(ent(), result('X1B1', { left: true, leftStart: '2025-05-26', leftEnd: '2026-07-10' }), ctx());
  assert.match(C.letterFacts(relA, T).action_line, /Interest above 6% on this loan from May 26, 2025 to July 10, 2026 is forgiven/);
  assert.match(C.letterFacts(ds.find((x) => x.code === 'watch'), T).action_line, /future call-up starting December 24, 2026/);
});

test('the AI letter request: built from the decision alone - a code, a loan type, a tone, dates and amounts - never a name, a loan id, an SSN or a date of birth; the server refuses anything else before any call', async () => {
  const { ds } = await demoRun(T);
  const loans = D.book(T);
  for (const d of ds.filter((x) => C.LETTER_CODES[x.code])) {
    const p = C.letterPayload(d, 'warm');
    const flat = JSON.stringify(p);
    assert.deepStrictEqual(Object.keys(p).filter((k) => !['code', 'loanType', 'tone', 'newRate', 'dates', 'amounts'].includes(k)), []);
    assert.ok(!flat.includes(d.loan) && !flat.includes(d.crid) && !/LCU/.test(flat), 'no loan id');
    for (const L of loans) for (const P of L.people) {
      assert.ok(!flat.includes(P.ssn.replace(/-/g, '')) && !flat.includes(P.ssn) && !(P.dob && flat.includes(P.dob)) && !flat.includes(P.last) && !flat.includes(P.first), 'nothing about a person');
    }
    assert.strictEqual(C.letterRequest(p).req.code, d.code, 'what the page sends is what the server accepts');
  }
  assert.strictEqual(C.letterPayload(ds.find((x) => x.code === 'policy'), 'warm'), null);
  const good = C.letterPayload(ds.find((x) => x.loan === 'LCU-40112'), 'plain');
  assert.deepStrictEqual(good, { code: 'eligible', loanType: 'auto', tone: 'plain', newRate: 6, dates: { serviceStart: C.addDays(T, -160), capStart: C.addDays(T, -160) }, amounts: { owedCents: 24143, monthlyCents: 4590 } });
  for (const bad of [
    Object.assign({}, good, { name: 'Tamsin' }),
    Object.assign({}, good, { loanId: 'LCU-40112' }),
    Object.assign({}, good, { dates: Object.assign({}, good.dates, { dob: '1990-07-22' }) }),
    Object.assign({}, good, { tone: 'x' + AT + 'y' }),
    Object.assign({}, good, { amounts: { owedCents: 912345678 } }),
    Object.assign({}, good, { code: ['912', '34', '5678'].join('-') }),
    Object.assign({}, good, { newRate: 5 }),
    Object.assign({}, good, { code: 'policy' }),
    Object.assign({}, good, { dates: { serviceStart: '06/02/2026' } }),
    Object.assign({}, good, { amounts: { owedCents: 1.5 } }),
    [],
  ]) assert.ok(C.letterRequest(bad).error, JSON.stringify(bad).slice(0, 100));
  assert.strictEqual(C.letterRequest(Object.assign({}, good, { name: 'x' })).code, 'unknown-field');
  assert.strictEqual(C.letterRequest(Object.assign({}, good, { tone: ssn(1) })).code, 'personal');
});

test('the AI letter answer: placeholders required and no others; no web address or email; every number and date one that was sent (or 6 / 6%); no law but the Servicemembers Civil Relief Act; markup and invisible characters stripped; bounded', () => {
  const req = C.letterRequest({ code: 'eligible', loanType: 'auto', tone: 'warm', newRate: 6, dates: { serviceStart: '2026-06-02', capStart: '2026-06-02' }, amounts: { owedCents: 24143, monthlyCents: 4590 } }).req;
  const base = 'Dear {{borrower_name}},\n\nUnder the Servicemembers Civil Relief Act we are lowering the rate on loan {{loan_number}} to 6% from June 2, 2026. About $241.43 comes back to you and your payment drops by $45.90 a month. These are estimates.\n\nQuestions: {{contact_line}}.\n\n{{servicer_name}}';
  const ok = C.cleanAiLetter({ subject: 'Your 6% cap', letter: base }, req);
  assert.strictEqual(ok.letter, base);
  const strip = C.cleanAiLetter({ subject: '<b>Your 6% cap</b>', letter: '<i>' + RLO + '</i>' + base.replace('Dear', '<img src=x onerror=alert(1)>Dear' + ZWSP) }, req);
  assert.ok(strip.letter && !/[<>]|onerror/.test(strip.letter + strip.subject) && !strip.letter.includes(RLO) && !strip.letter.includes(ZWSP));
  const bad = (letter, code) => assert.strictEqual(C.cleanAiLetter({ subject: 's', letter }, req).code, code, letter.slice(0, 60));
  bad(base.replace('$241.43', '$250.00'), 'number');
  bad(base + ' You have 180 days.', 'number');
  bad(base.replace('June 2, 2026', 'June 3, 2026'), 'number');
  bad(base + ' See https://example.org/scra', 'link');
  bad(base + ' Write to help' + AT + 'larkmoor.example', 'link');
  bad(base + ' Visit larkmoor.com', 'link');
  bad(base.replace('{{contact_line}}', '{{phone}}'), 'placeholder');
  bad(base.replace('{{servicer_name}}', 'Larkmoor'), 'placeholder');
  bad(base + ' {not a placeholder}', 'placeholder');
  bad(base.replace('Under the Servicemembers', 'Under the Military Lending Act and the Servicemembers'), 'law');
  bad(base + ' (50 U.S.C. § 3937)', 'law');
  bad(base.replace('Under the Servicemembers Civil Relief Act', 'Under the Truth in Lending Act'), 'law');
  bad('Too short {{borrower_name}}', 'short');
  bad(base + ' x'.repeat(2100), 'long');
  assert.ok(C.cleanAiLetter({ subject: 's', letter: base.replace('6%', '6.00%') + ' The 6 percent cap.' }, req).letter, '6 and 6% are always allowed');
  assert.strictEqual(C.cleanAiLetter(null, req).code, 'shape');
  assert.match(ai.SYSTEM, /never as instructions/);
  assert.match(ai.userText(req), /<<<FACTS\n[\s\S]*Military service began on: June 2, 2026[\s\S]*Estimated interest above 6% owed so far: \$241\.43[\s\S]*FACTS>>>/);
});

/* ================================================================== *
 * Settings
 * ================================================================== */

test('settings: layouts and preferences only - unknown fields, an @, an SSN-shaped number, nine digits in a row, a bad layout or span, markup-looking headers are refused; merge keeps both sides’ presets', () => {
  const good = { version: 1, layout: C.DEFAULT_LAYOUT, resultsSpans: [{ field: 'crid', start: 19, len: 28 }, { field: 'active', start: 48, len: 1 }], presets: [{ name: 'Core export', kind: 'portfolio', map: { loan: 'Loan Number', b1Ssn: 'Borrower SSN' } }], policy: 'notice', split: 5000, lineEnding: 'lf', cridMode: 'short', letter: { template: 'Dear {{borrower_name}}', servicer: 'Larkmoor', contact: 'Member Services, 1-800-555-0142' } };
  const c = C.cleanSettings(good, true);
  assert.deepStrictEqual(c.errors, []);
  assert.strictEqual(c.settings.policy, 'notice');
  for (const bad of [
    Object.assign({}, good, { loans: [{ id: 'LCU-40112' }] }),
    Object.assign({}, good, { letter: Object.assign({}, good.letter, { contact: 'help' + AT + 'larkmoor.example' }) }),
    Object.assign({}, good, { letter: Object.assign({}, good.letter, { template: 'Dear Tamsin, SSN ' + ssn(1) }) }),
    Object.assign({}, good, { letter: Object.assign({}, good.letter, { template: 'Loan 1000045678' }) }),
    Object.assign({}, good, { presets: [{ name: 'X', kind: 'portfolio', map: { loan: 'LCU-40112' } }] }),
    Object.assign({}, good, { presets: [{ name: 'X', kind: 'portfolio', map: { password: 'Loan' } }] }),
    Object.assign({}, good, { layout: Object.assign({}, C.DEFAULT_LAYOUT, { lineLength: 50 }) }),
    Object.assign({}, good, { resultsSpans: [{ field: 'crid', start: 1, len: 5 }, { field: 'active', start: 3, len: 2 }] }),
    Object.assign({}, good, { policy: 'whenever' }),
    Object.assign({}, good, { split: 7 }),
    Object.assign({}, good, { letter: { template: 'x', note: 'y' } }),
    Object.assign({}, good, { cridMode: 'ssn' }),
    Object.assign({}, good, { letter: Object.assign({}, good.letter, { servicer: 'Lark' + RLO + 'moor' }) }),
  ]) assert.ok(C.cleanSettings(bad, true).errors.length, JSON.stringify(bad).slice(0, 140));
  const loose = C.cleanSettings({ policy: 'whenever', layout: { junk: 1 } });
  assert.deepStrictEqual([loose.settings.policy, loose.settings.layout], ['proactive', C.DEFAULT_LAYOUT], 'a stored copy falls back to the defaults');
  const a = Object.assign({}, c.settings, { updatedAt: 10, presets: [{ name: 'A', kind: 'portfolio', map: { loan: 'Loan' } }] });
  const b = Object.assign({}, c.settings, { updatedAt: 20, policy: 'proactive', presets: [{ name: 'B', kind: 'results', map: { crid: 'Customer Record ID' } }] });
  const m = C.mergeSettings(a, b);
  assert.deepStrictEqual([m.settings.policy, m.settings.presets.map((p) => p.name).sort(), m.added], ['proactive', ['A', 'B'], 1]);
});

/* ================================================================== *
 * The demo
 * ================================================================== */

test('the example produces exactly the planted outcomes - three rows with problems, two left out, nine planted decisions, everything else no action - on every fourteenth day for a year, under either policy', async () => {
  for (let k = 0; k < 27; k++) {
    const day = C.addDays('2026-11-09', k * 14);
    const { p, b, mt, ds } = await demoRun(day);
    const rp = {};
    p.groups.forEach((g) => { rp[g.key] = g.rows.map((r) => r.loan); });
    assert.deepStrictEqual(rp, D.ROW_PROBLEMS, day + ' row problems');
    assert.deepStrictEqual([p.counts.loans, p.counts.borrowers, p.counts.coBorrowers, p.counts.ok], [60, 70, 10, 68], day);
    assert.ok(D.LEFT_OUT.every((x) => !Object.values(b.batch.map).some((a) => a[0] + '|' + a[1] === x)), 'the two blocked records are not in the file');
    assert.deepStrictEqual([mt.matched.length, mt.unmatchedCount, mt.missing.length], [68, 0, 0]);
    const got = {};
    ds.forEach((d) => { if (d.code !== 'none') got[d.loan + '|' + d.b] = d.code; });
    assert.deepStrictEqual(got, D.expected(), day + ' decisions');
    const t = C.totals(b.batch, ds);
    assert.deepStrictEqual([t.eligible, t.todo, t.active, t.released, t.watch, t.by.none], [5, 8, 6, 1, 1, 59], day);
    const relM = ds.find((d) => d.loan === 'LCU-40172');
    assert.ok(relM.capEnd > day && relM.est.monthly > 0 && relM.est.owed > 0, 'the released mortgage’s tail is running with back interest owed');
    const mort = ds.find((d) => d.loan === 'LCU-40135');
    assert.strictEqual(mort.capEnd, C.addYears(C.addDays(day, 65), 1), 'the mortgage’s one-year tail');
    assert.strictEqual(ds.find((d) => d.loan === 'LCU-40141' && d.code === 'eligible').b, 2, 'the co-borrower serves');
    assert.ok(ds.find((d) => d.loan === 'LCU-40127').est.fees > 0, 'the card’s fees count as interest');
  }
  const n = await demoRun(T, 'notice');
  assert.deepStrictEqual(n.ds.filter((d) => d.code === 'notice').map((d) => d.loan).sort(), ['LCU-40112', 'LCU-40127', 'LCU-40135', 'LCU-40141', 'LCU-40172']);
  const d = await demoRun(T);
  assert.deepStrictEqual(d.ds.filter((x) => x.code === 'eligible').map((x) => [x.loan, x.est.owed]).sort(), [['LCU-40112', 24143], ['LCU-40127', 19939], ['LCU-40135', 166533], ['LCU-40141', 4364], ['LCU-40172', 308926]].sort());
});

test('the example is unmistakably made up: a made-up lender, invented people, every SSN in the never-issued 900-999 area, a file called EXAMPLE-, no real lender, bank or servicer named', () => {
  const src = read('public/demo.js');
  assert.match(src, /A MADE-UP lender/);
  assert.strictEqual(D.LENDER, 'Larkmoor Community Credit Union');
  assert.ok(D.FILE.startsWith('EXAMPLE-') && D.RESULTS_FILE.startsWith('EXAMPLE-'));
  const people = D.book(T).flatMap((L) => L.people);
  assert.strictEqual(people.length, 70);
  assert.ok(people.every((p) => /^9\d\d-\d\d-\d{4}$/.test(p.ssn)), 'every SSN in the 900 area');
  assert.strictEqual(new Set(people.map((p) => p.ssn)).size, 70);
  const all = src + read('public/app.js') + read('public/index.html') + read('public/muster-core.js');
  const real = ['Chase', 'Wells Fargo', 'Bank of America', 'Citibank', 'Citi', 'Capital One', 'American Express', 'Discover', 'Navy Federal', 'USAA', 'PenFed', 'Pentagon Federal', 'Armed Forces Bank', 'Service Credit Union', 'Andrews Federal', 'Security Service', 'Ally', 'Santander', 'Synchrony', 'SoFi', 'Sallie Mae', 'Navient', 'Nelnet', 'Rocket Mortgage', 'Mr. Cooper', 'PHH', 'Freedom Mortgage', 'Truist', 'PNC', 'US Bank', 'TD Bank', 'Fifth Third', 'KeyBank', 'Huntington', 'Regions', 'Toyota Financial', 'Ford Credit', 'GM Financial', 'Fort Bragg', 'Fort Liberty', 'Camp Lejeune', 'Fort Hood', 'Fort Cavazos', 'Norfolk', 'San Diego'];
  for (const r of real) assert.ok(!new RegExp('\\b' + r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(all), `a real name: ${r}`);
  assert.ok(read('public/app.js').includes('EXAMPLE - do not upload this file.'));
  assert.ok(read('public/app.js').includes('Example results (made-up layout for this demo)'));
});

/* ================================================================== *
 * The storage module: the one door to the device's storage
 * ================================================================== */

test('storage: a stored batch record, its results and its audit log hold no SSN, no date of birth from the portfolio, no name and no nine-digit run - a note with them typed in is scrubbed; settings and device preferences are cleaned on the way in and out', async () => {
  const { e, b, r, ds } = await demoRun(T);
  const mem = MS.memory();
  const s = MS.create(mem);
  const people = C.peopleOf(D.book(T).map((L) => ({ people: L.people.map((p) => ({ ssn: p.ssn.replace(/-/g, ''), dob: p.dob, last: p.last, first: p.first, middle: p.middle })) })));
  await s.putBatch(b.batch, people);
  await s.putResults('DEMO', r.results.concat([{ crid: 'X', match: 'Error for ' + ssn(5) + ' Quarrie', component: 'Army' }]), T, D.RESULTS_FILE, people);
  const p0 = D.book(T)[0].people[0];
  const scrubbed = e.scrub({ text: `Called ${p0.first} ${p0.last} (SSN ${p0.ssn}, born ${p0.dob.slice(5, 7)}/${p0.dob.slice(8)}/${p0.dob.slice(0, 4)}) at x${AT}y.example - 1000045678` });
  assert.strictEqual(scrubbed.removed, 6);
  await s.appendAudit('DEMO', { kind: 'note', at: T, crid: 'LCU40101B1', value: scrubbed.text }, digest);
  await s.appendAudit('DEMO', { kind: 'note', at: T, crid: 'LCU40101B1', value: `${p0.last} again ${p0.ssn}` }, digest, people);
  await s.appendAudit('DEMO', { kind: 'step', at: T, crid: 'LCU40101B1', field: 'by', value: 'EM', by: 'EM' + ssn(2) }, digest);
  for (const d of ds.filter((x) => C.TODO[x.code])) await s.appendAudit('DEMO', { kind: 'decision', at: T, crid: d.crid, value: { code: d.code, owed: d.est ? d.est.owed : 0, monthly: 0, capStart: d.capStart, capEnd: d.capEnd } }, digest);
  await s.putSettings(Object.assign(C.defaults(), { policy: 'notice', letter: { template: 'x', servicer: 'y', contact: 'z' } }));
  await s.putDevice({ initials: 'EM' + ssn(3), hint: true, junk: ssn(4) });
  const dump = mem.dump();
  for (const L of D.book(T)) for (const P of L.people) {
    assert.ok(!dump.includes(P.ssn) && !dump.includes(P.ssn.replace(/-/g, '')), 'no SSN stored');
    if (P.dob) for (const f of [P.dob, P.dob.replace(/-/g, ''), P.dob.slice(5, 7) + '/' + P.dob.slice(8) + '/' + P.dob.slice(0, 4)]) assert.ok(!dump.includes(f), 'no date of birth stored: ' + f);
    for (const n of [P.last, P.first]) assert.ok(!new RegExp('\\b' + n.replace(/[-']/g, '.') + '\\b', 'i').test(dump), 'no name stored: ' + n);
  }
  assert.ok(!/\d{9}/.test(dump.replace(/[0-9a-f]{64}/g, 'HASH')), 'no run of nine digits anywhere in storage (SHA-256 hex aside)');
  assert.ok(!dump.includes(AT), 'no address');
  assert.match(dump, /\[name removed\]/);
  assert.match(dump, /\[number removed\]/);
  assert.match(dump, /\[date removed\]/);
  const list = await s.listBatches();
  assert.deepStrictEqual(Object.keys(list[0]).sort(), ['count', 'createdAt', 'demo', 'files', 'id', 'loans', 'statusDate']);
  assert.ok((await C.verifyAudit(await s.getAudit('DEMO'), digest)).ok);
  assert.deepStrictEqual(await s.getDevice(), { initials: 'EM', hint: true, results: false }, 'initials are letters, spaces and full stops');
  await s.delBatch('DEMO');
  assert.deepStrictEqual([await s.getBatch('DEMO'), await s.getResults('DEMO'), (await s.getAudit('DEMO')).length, (await s.listBatches()).length], [null, null, 0, 0]);
  const bad = await s.restoreAudit('X', [{ seq: 1, prev: C.GENESIS, kind: 'note', at: T, batch: 'X', value: 'x', hash: 'f'.repeat(64) }], digest).catch((err) => err.message);
  assert.match(bad, /does not verify/);
});

/* ================================================================== *
 * Hostile input
 * ================================================================== */

test('hostile input: markup and bidi in names and loan ids, malformed dates and rates, a 25 MB export, a file over 25 MB - read, cleaned, capped, and quick', async () => {
  const rows = [
    row(1, { 0: '<img src=x onerror=alert(1)>', 5: 'Quar' + RLO + 'rie<script>', 6: '=cmd|x', 2: '31/31/2020', 3: '9.9.9', 9: '1990-02-30' }),
    row(2, { 0: 'LN-' + ZWSP + '2', 5: 'O’Brien', 6: '"Tam"' }),
  ];
  const { e, p } = await pipeline(book(rows));
  const g = Object.fromEntries(p.groups.map((x) => [x.key, x]));
  assert.ok(g['dob-bad'] && g['rate-bad'] && g['orig-bad'], 'malformed dates and rates are named, not guessed');
  const b = await e.build({ statusDate: T, today: T, batchId: 'H', createdAt: T, cridMode: 'short' });
  const text = b.files[0] ? b.files[0].text : '';
  assert.ok(!/[<>"=|]/.test(text) && !text.includes(RLO) && !text.includes(ZWSP), 'nothing but A-Z, digits, space, hyphen and apostrophe in the file');
  assert.ok(text.includes("O'BRIEN"));
  assert.ok(!JSON.stringify(b.batch).includes(ZWSP) && !JSON.stringify(p.groups).includes(RLO), 'invisible characters removed on reading');
  // 25 MB of portfolio: read and checked in seconds, rows past 250,000 counted, not kept.
  const line = (i) => ['LN-' + i, 'Auto - Used', '03/14/2021', '8.99', '$12000.00', 'Quarrie', 'Tamsin', 'J', (900 + (i % 99)) + '-' + String(10 + (i % 89)).padStart(2, '0') + '-' + String(1000 + (i % 8999)).padStart(4, '0'), '07/22/1990', '', '', '', ''].join(',');
  const parts = [HEAD.join(',')];
  let size = parts[0].length;
  for (let i = 1; size < 25 * 1024 * 1024 - 200; i++) { const l = line(i); parts.push(l); size += l.length + 2; }
  const big = parts.join('\r\n');
  assert.ok(big.length <= C.LIMITS.fileBytes);
  const t0 = Date.now();
  const be = engine();
  const meta = be.loadPortfolio({ text: big, name: 'big.csv', demo: true });
  assert.strictEqual(meta.stats.kept, 250000);
  assert.ok(meta.stats.truncated > 0, 'the rows past 250,000 are counted');
  const bp = be.prepare({ map: meta.guess.map, statusDate: T, batchId: 'BIG', cridMode: 'short' });
  const bb = await be.build({ statusDate: T, today: T, batchId: 'BIG', createdAt: T, cridMode: 'short' });
  assert.strictEqual(bb.batch.count, bp.counts.ok);
  assert.ok(bb.allExact);
  const ms = Date.now() - t0;
  assert.ok(ms < 30000, `took ${ms} ms`);
  console.log(`       (25 MB, 250,000 loans read, checked and built in ${ms} ms)`);
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
    vm.runInThisContext(fs.readFileSync(path.join(dir, 'muster-worker.js'), 'utf8'), { filename: 'muster-worker.js' });
  `, { eval: true });
  let seq = 0;
  const waits = {};
  w.on('message', (m) => { const p = waits[m.id]; if (!p) return; delete waits[m.id]; if (m.ok) p.resolve(m.out); else p.reject(new Error(m.error)); });
  return { call: (op, data) => new Promise((resolve, reject) => { const id = ++seq; waits[id] = { resolve, reject }; w.postMessage({ id, op, data }); }), stop: () => w.terminate() };
}

test('the worker reads a File itself, keeps the borrowers in its own memory, builds the request file and hashes it with SubtleCrypto - the same hash as node:crypto; reads results; refuses a file over 25 MB before reading it', async () => {
  const w = spawnWorker();
  try {
    const text = D.portfolio(T);
    const meta = await w.call('loadPortfolio', { file: new File([text], D.FILE), name: D.FILE });
    assert.strictEqual(meta.stats.kept, 60);
    assert.ok(!JSON.stringify(meta).includes('901-11-1001') && JSON.stringify(meta).includes('•••-••-1001'), 'the page sees SSNs only masked');
    const demo = await w.call('loadPortfolio', { demo: true, today: T });
    assert.strictEqual(demo.demo, true);
    const p = await w.call('prepare', { map: demo.guess.map, statusDate: T, batchId: 'DEMO' });
    assert.strictEqual(p.counts.ok, 68);
    const b = await w.call('build', { statusDate: T, today: T, batchId: 'DEMO', createdAt: T });
    assert.strictEqual(b.files[0].sha256, sha(b.files[0].text), 'SubtleCrypto and node:crypto agree');
    assert.strictEqual(b.batch.files[0].sha256, sha(b.files[0].text));
    const lr = await w.call('loadResults', { file: new File([D.results(b.batch, T)], D.RESULTS_FILE) });
    assert.strictEqual(lr.mode, 'csv');
    const rr = await w.call('readResults', { map: lr.guess });
    assert.strictEqual(rr.count, 68);
    assert.ok((await w.call('person', { loan: 'LCU-40112', b: 1 })).borrower_name);
    assert.strictEqual((await w.call('scrub', { text: 'ssn 912-34-5678' })).removed, 1);
    assert.strictEqual(await w.call('drop', {}), true);
    assert.strictEqual(await w.call('person', { loan: 'LCU-40112', b: 1 }), null, 'gone when dropped');
    await assert.rejects(w.call('build', { statusDate: T, today: T, batchId: 'X' }), /Load the portfolio first/);
    await assert.rejects(w.call('loadPortfolio', { file: new File([new Uint8Array(C.LIMITS.fileBytes + 1)], 'huge.csv') }), /over 25 MB/);
    await assert.rejects(w.call('nope', {}), /Unknown step/);
  } finally { w.stop(); }
});

/* ================================================================== *
 * The page's promises
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes - the request file’s field tints and the selection too; the hero, the mock and the lab card; marks 3:1; 44px targets; tables, the preview and the ruler scroll in their own box', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  assert.deepStrictEqual(Object.keys(dark).sort(), Object.keys(light).sort(), 'every token has a dark value');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2', 'code-bg', 'bar-bg']) for (const fg of ['text', 'muted', 'link']) ok(fg, bg);
    ok('accent-ink', 'accent'); for (const fg of ['text', 'link', 'muted']) ok(fg, 'accent-soft');
    for (const k of ['critical', 'high', 'medium', 'low', 'info', 'ok']) { ok(k, `${k}-bg`); ok('text', `${k}-bg`); ok(k, 'card'); }
    ok('muted', 'ok-bg'); ok('high', 'high-bg');
    for (const k of ['ssn', 'dob', 'last', 'first', 'crid', 'middle', 'status', 'sel']) { ok('text', `band-${k}`); }
    ok('muted', 'band-sel');
    for (const k of ['tone-critical', 'tone-high', 'tone-medium', 'tone-low', 'tone-info', 'tone-ok', 'accent']) ok(k, 'card', 3);
    ok('bg', 'text');
  }
  for (const bg of ['#2f3a12', '#3e4c19', '#1c3d78']) for (const fg of ['#ffffff', '#eef2e6', '#f2dc8a']) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  for (const [fg, bg] of [['#1d2408', '#f2dc8a'], ['#14181f', '#fbfcf8'], ['#4a5260', '#fbfcf8'], ['#166534', '#dcf5e3'], ['#6b5300', '#fbf1c7'], ['#1d4f91', '#e3edfb'], ['#14181f', '#e9ece4']]) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}`);
  const lab = require('../../../lab').get('muster');
  assert.ok(lab, 'Muster is in lab.js');
  assert.ok(ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const sel of ['.btn', '.link-btn', '.seg button', '.input, textarea.input, select.input', '.check', '.ghead', '.chead', '.radio', '.steps button', '.filters button']) assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: (4[4-9]|5\\d|60)px').test(css), `${sel}: 44px`);
  assert.ok(/details\.why > summary \{[^}]*min-height: 44px/.test(css) && /\.tabbar button \{[^}]*min-height: 60px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/\.tablewrap \{[^}]*overflow: auto/.test(css) && /\.fw \{[^}]*overflow: auto/.test(css) && /\.out \{[^}]*overflow: auto/.test(css) && /\.sent-pre \{[^}]*overflow: auto/.test(css), 'tables, the preview, the ruler and code scroll in their own box');
  assert.ok(/\.ruler \{[^}]*touch-action: none/.test(css), 'dragging the ruler on a phone does not scroll the page');
});

test('the page: relative links, no inline script or handlers, the banner, storage only through muster-store.js and its guards, no clock, dice, network or storage in the core, the demo or the worker, the requests it makes and what they carry, every file and model string escaped', () => {
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
  const st = read('public/muster-store.js');
  assert.ok(/C\.safeBatch\(batch, people\)/.test(st) && /C\.safeResults\(list, people\)/.test(st) && /C\.nextEvent\(events, f, digest\)/.test(st) && /C\.cleanSettings\(v\)\.settings/.test(st), 'everything stored passes a guard');
  assert.ok(!/localStorage|sessionStorage/.test(st), 'IndexedDB or memory - one door');
  assert.ok(/try \{[^}]*self\.indexedDB\.open/.test(st.replace(/\n/g, ' ')), 'opening the database is wrapped');
  assert.match(js, /Intl\.getCanonicalLocales\(navigator\.language \|\| 'en-US'\)\[0\] \|\| 'en-US'; \} catch \(e\) \{ return 'en-US'; \}/, 'a locale Intl refuses (en-US@posix) falls back to en-US');
  assert.ok(!/eval\(|new Function|setTimeout\(['"]/.test(js + read('public/muster-core.js') + read('public/muster-worker.js') + read('public/demo.js') + st), 'no eval of any kind');
  assert.match(js, /new Worker\('muster-worker\.js'\)/, 'the worker is a same-origin file - the CSP allows it');
  assert.match(js, /crypto\.subtle\.digest\('SHA-256', enc\.encode\(text\)\)/, 'SHA-256 by SubtleCrypto on the page');
  assert.match(read('public/muster-worker.js'), /self\.crypto\.subtle\.digest\('SHA-256', enc\.encode\(text\)\)/, 'and in the worker');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/letter', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/me', 'api/settings'].sort(), 'the page asks for nothing else - no route takes a borrower');
  assert.strictEqual((js.match(/\bfetch\(/g) || []).length, 2, 'two fetches: api() and the verify resend');
  assert.match(js, /api\('POST', 'api\/ai\/letter', payload\)/, 'the AI call sends the payload shown, and nothing else');
  assert.match(js, /var payload = C\.letterPayload\(d, tone\);/);
  assert.match(js, /api\('PUT', 'api\/settings', \{ settings: settingsBody\(\), base:/, 'sync sends the settings and a base, nothing else');
  const files = ['public/index.html', 'public/app.js', 'public/muster-core.js', 'public/demo.js', 'public/muster-worker.js', 'public/muster-store.js', 'server.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/store.js', 'CLAUDE.md', 'test/run.js'];
  for (const f of files) assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read(f)), `no email address in ${f}`);
  for (const f of ['public/muster-core.js', 'public/demo.js', 'public/muster-worker.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon|indexedDB|WebSocket/.test(src), `${f} touches no network or storage`);
    assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(src), `${f} has no dice and no clock`);
  }
  assert.ok(!/crypto\./.test(read('public/muster-core.js').replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')), 'the core never hashes by itself - SHA-256 is handed in');
  // Every interpolation of something a file, a person, the server or a model wrote goes through esc().
  const strip = (src) => { let out = ''; let i = 0; const re = /\besc\(/g; let m; while ((m = re.exec(src))) { if (m.index < i) continue; out += src.slice(i, m.index) + 'SAFE'; let depth = 0, j = m.index + m[0].length - 1; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; re.lastIndex = i; } return out + src.slice(i); };
  const risky = strip(js).split('\n').filter((l) => /</.test(l) && !/toast\(|confirm\(|prompt\(|copy\(|download\(|textContent/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(?!SAFE\b|i\b|k\b|p\b|String\b)([a-zA-Z_$][\w$]*(?:\.[\w$]+|\[[^\]]+\])*)\s*\+/g);
  const allowed = (r) => /\+\s*(?:(?:[a-zA-Z]*Html|html|bands|cells|body|opts|built|letter|done|head|mapping|lead|note|dateIn|amt|meta|out|next|n|j|on|cls|edge|low|at\b)|s\.len|s\.start|PILL\[[^\]]+\]|SEV_PILL\[[^\]]+\]|g\.sev|d\.code|s\.key|x\.k|(?:it|x|s)\[[0-9]\]|C\.LIMITS\.\w+|width|len|state\.device\.hint)/.test(r);
  const bad = (risky || []).filter((r) => !allowed(r));
  assert.deepStrictEqual(bad, [], `unescaped: ${bad}`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bbrief\b|\bsettings\b|\bpayload\b)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /muster-shell-v1/.test(sw) && ['muster-core.js', 'muster-worker.js', 'muster-store.js', 'demo.js', 'app.js'].every((f) => sw.includes(`'${f}'`)) && /k\.indexOf\('muster-'\) === 0/.test(sw), 'the service worker caches only the app shell, never api/, and only clears its own caches');
  assert.ok(/if \(!nav && SHELL\.indexOf\(rel\) < 0\) return;/.test(sw), 'nothing outside the shell is ever cached');
  assert.match(js, /navigator\.serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
  assert.match(read('public/muster-core.js'), /A starting checklist, not legal advice - your policy and counsel decide\./);
  assert.ok(js.includes('Check these positions against the current DMDC SCRA User Guide (“Format of the Request File”) before your first upload. DMDC checks every file it receives, so a wrong layout is refused rather than misread.'));
  assert.ok(js.includes('Request layout - DMDC SCRA multiple record request'));
  // The statute points are stated once, in the core, and nothing beyond them.
  assert.strictEqual(Object.keys(C.RULES).length, 6);
  assert.ok(!/\b(Military Lending Act|Truth in Lending|Regulation Z|TILA|MLA)\b/.test(js + read('public/muster-core.js').replace(/var LAW_OK[\s\S]*?cleanAiLetter[\s\S]*?\n {2}\}/, '') + html));
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
});

test('local-only switches throw on Cloud Run; the lab prefix is read; the store holds one kind of document, read by its id', () => {
  for (const [mod, env] of [['./lib/store', { MUSTER_MEMORY: '1' }], ['./lib/fakeai', { MUSTER_FAKE_AI: '1' }], ['./server', { MUSTER_FAKE_AI: '1', MUSTER_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, MUSTER_MEMORY: '', MUSTER_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, MUSTER_MEMORY: '', MUSTER_COLLECTION_PREFIX: 'muster_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'muster_ firestore');
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
let demoLetter = null;
async function letterPayload() {
  if (!demoLetter) { const { ds } = await demoRun(T); demoLetter = C.letterPayload(ds.find((d) => d.loan === 'LCU-40112'), 'warm'); }
  return demoLetter;
}

test('signed out: the page, the worker and the example work with zero model calls; settings and the AI answer 401 before reading a body; no route takes a portfolio, a request file, results or a log', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.layout, meta.decisions, meta.rules], [C.DEFAULT_LAYOUT, C.DECISIONS, C.RULES]);
  for (const f of ['muster-core.js', 'muster-worker.js', 'muster-store.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/settings'], ['PUT', '/api/settings'], ['DELETE', '/api/settings'], ['POST', '/api/ai/letter']]) assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : { ok: 1 })).status, 401, `${m} ${p}`);
  for (const [m, p] of [['PUT', '/api/settings'], ['POST', '/api/ai/letter']]) assert.strictEqual((await anon(m, p, BIG)).status, 401, `${p}: the gate answers before the parser, so never 413`);
  for (const p of ['/api/upload', '/api/portfolio', '/api/request', '/api/results', '/api/batch', '/api/audit', '/api/ssn', '/api/dmdc', '/api/decide', '/api/check', '/api/letter', '/api/borrowers', '/api/export']) assert.strictEqual((await anon('POST', p, { ssn: ssn(1), loan: 'LCU-40112' })).status, 404, `${p}: there is no route that takes a borrower`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the gates come before each parser, in order; one model call site; Haiku free, Sonnet members via planFor', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/letter', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/settings', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((read('lib/ai.js').match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(read('lib/ai.js'), /tool_choice: \{ type: 'tool', name: LETTER_TOOL\.name \}/);
});

test('settings sync: they follow the account; a stale device gets 409 with the account copy; anything that looks like a borrower is refused; the owner tag holds no account id or address', async () => {
  const a = await register('servicing.ana');
  assert.deepStrictEqual((await a('GET', '/api/settings')).data, { settings: null });
  const good = { version: 1, layout: C.DEFAULT_LAYOUT, resultsSpans: [{ field: 'crid', start: 19, len: 28 }], presets: [{ name: 'Core export', kind: 'portfolio', map: { loan: 'Loan Number', b1Ssn: 'Borrower SSN' } }], policy: 'proactive', split: 0, lineEnding: 'crlf', cridMode: 'loan', letter: { template: C.DEFAULT_TEMPLATE, servicer: 'Larkmoor Community Credit Union', contact: 'Member Services, 1-800-555-0142' } };
  const put = await a('PUT', '/api/settings', { settings: good, base: null });
  assert.strictEqual(put.status, 200, put.text);
  const v1 = put.data.settings.updatedAt;
  const b = client();
  assert.strictEqual((await b('POST', '/api/auth/login', { email: mail('servicing.ana'), password: 'a long enough password' })).status, 200);
  assert.strictEqual((await b('GET', '/api/settings')).data.settings.presets[0].name, 'Core export');
  assert.strictEqual((await b('PUT', '/api/settings', { settings: Object.assign({}, good, { policy: 'notice' }), base: v1 })).status, 200);
  const stale = await a('PUT', '/api/settings', { settings: good, base: v1 });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.data.settings.policy, 'notice', 'the 409 carries the account copy to merge with');
  assert.strictEqual((await a('PUT', '/api/settings', { settings: good, base: null })).status, 409, 'a device that never synced cannot overwrite');
  const cur = (await a('GET', '/api/settings')).data.settings.updatedAt;
  for (const bad of [
    { settings: Object.assign({}, good, { borrowers: [{ ssn: ssn(1) }] }), base: cur },
    { settings: Object.assign({}, good, { letter: Object.assign({}, good.letter, { template: 'Dear Tamsin Quarrie ' + ssn(1) }) }), base: cur },
    { settings: Object.assign({}, good, { letter: Object.assign({}, good.letter, { template: 'Loan 1000045678 for you' }) }), base: cur },
    { settings: Object.assign({}, good, { letter: Object.assign({}, good.letter, { contact: 'help' + AT + 'larkmoor.example' }) }), base: cur },
    { settings: Object.assign({}, good, { presets: [{ name: 'X', kind: 'portfolio', map: { loan: 'LCU-40112' } }] }), base: cur },
    { settings: Object.assign({}, good, { layout: { lineLength: 3 } }), base: cur },
    { settings: good, base: cur, batch: { id: 'K7Q2M' } },
    { settings: 'nope', base: cur },
  ]) {
    const r = await a('PUT', '/api/settings', bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 120) + ' ' + r.text);
  }
  assert.strictEqual((await a('GET', '/api/settings')).data.settings.updatedAt, cur, 'nothing was saved');
  const dump = store._dump();
  assert.ok(!dump.includes('servicing.ana') && !dump.includes(uidOf(mail('servicing.ana'))), 'filed under an HMAC, never the account id or address');
  assert.ok(!/Quarrie|1000045678|K7Q2M|LCU-40112/.test(dump) && !dump.includes(ssn(1)), 'nothing from a refused body');
  assert.ok(dump.includes(ownerTag(uidOf(mail('servicing.ana')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  const doc = Object.values(JSON.parse(dump).find(([p]) => p === 'settings')[1]).map(([, d]) => d)[0];
  assert.deepStrictEqual(Object.keys(doc).sort(), ['owner', 'settings', 'updatedAt'], 'the document is the tag, the settings and a time');
  assert.deepStrictEqual(Object.keys(doc.settings).sort(), ['cridMode', 'layout', 'letter', 'lineEnding', 'policy', 'presets', 'resultsSpans', 'split', 'version']);
  const other = await register('kim.other');
  assert.deepStrictEqual((await other('GET', '/api/settings')).data, { settings: null }, 'another account sees nothing of it');
  assert.strictEqual((await a('DELETE', '/api/settings')).status, 200);
  assert.deepStrictEqual((await b('GET', '/api/settings')).data, { settings: null });
});

test('the AI letter over HTTP: codes, dates and amounts only; a name, a loan id, an SSN or an unknown field is refused with no model call; the model saw nothing about a person; its letter is checked', async () => {
  const ana = await register('ana.letters');
  const calls = await modelCalls();
  const good = await letterPayload();
  for (const bad of [{}, Object.assign({}, good, { name: 'Tamsin Quarrie' }), Object.assign({}, good, { loan: 'LCU-40112' }), Object.assign({}, good, { tone: ssn(1) }), Object.assign({}, good, { amounts: { owedCents: 1000045678 } }), Object.assign({}, good, { code: 'x' + AT + 'y' }), []]) {
    const r = await ana('POST', '/api/ai/letter', bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 80) + ' ' + r.text);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const n0 = fakeClient.calls.length;
  const r = await ana('POST', '/api/ai/letter', good);
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const sent = fakeClient.calls[n0];
  assert.strictEqual(sent.model, 'claude-haiku-4-5');
  assert.deepStrictEqual(sent.tool_choice, { type: 'tool', name: 'write_letter' });
  const flat = JSON.stringify(sent);
  for (const L of D.book(T)) {
    assert.ok(!flat.includes(L.loan) && !flat.includes(L.loan.replace(/-/g, '')), 'no loan id');
    for (const P of L.people) assert.ok(!flat.includes(P.ssn) && !flat.includes(P.ssn.replace(/-/g, '')) && !(P.dob && flat.includes(P.dob)) && !new RegExp('\\b' + P.last + '\\b').test(flat) && !new RegExp('\\b' + P.first + '\\b').test(flat), 'nothing about ' + P.first);
  }
  assert.ok(!/Larkmoor|1-800/.test(flat), 'not even the servicer');
  assert.match(sent.messages[0].content[0].text, /<<<FACTS\nDecision: eligible/);
  assert.ok(['{{borrower_name}}', '{{loan_number}}', '{{servicer_name}}', '{{contact_line}}'].every((p) => r.data.letter.includes(p)));
  assert.match(r.data.letter, /\$241\.43/);
  assert.ok(!store._dump().includes('241.43'), 'nothing stored');
  for (const [mode, code] of [['badnumber', 'number'], ['url', 'link'], ['law', 'law'], ['placeholder', 'placeholder'], ['blank', 'short']]) {
    fakeClient.mode = mode;
    const x = await ana('POST', '/api/ai/letter', good);
    assert.deepStrictEqual([x.status, x.data.code], [422, code], mode + ' ' + x.text);
  }
  fakeClient.mode = 'inject';
  const inj = await ana('POST', '/api/ai/letter', good);
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<b>|<img|<i>|onerror|hunter2|\u202e/i.test(inj.text), inj.text.slice(0, 300));
  fakeClient.mode = 'maxtokens';
  assert.match((await ana('POST', '/api/ai/letter', good)).data.error, /ran long/);
  fakeClient.mode = 'upstream401';
  const up = await ana('POST', '/api/ai/letter', good);
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  fakeClient.mode = 'upstream529';
  const busy = await ana('POST', '/api/ai/letter', good);
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('the gates: an unconfirmed free account 403, out of credit 402, the day’s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register('eve.unconfirmed');
  const body = await letterPayload();
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/ai/letter', body);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/muster/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/ai/letter', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ai/letter', body)).status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/letter', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-muster-${day}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/letter', body);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/letter', BIG)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-muster-${day}`); }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/muster', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/muster`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
