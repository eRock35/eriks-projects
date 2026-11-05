// Pure rules first (bytes and encodings, delimiters and quoting, the table,
// dates, amounts, signs, the running balance, duplicates, OFX and QIF, each
// target's exact bytes, every undo, the re-check, the totals, the exports,
// settings and the AI helper's checks), then the demo, then hostile files,
// then the worker in a real worker thread, then the page's own promises,
// then end to end against the memory store and the fake model:
//   FEEDFIX_MEMORY=1 FEEDFIX_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /feedfix, the way
// the lab mounts it, so the auth cookie, the budget gate and each route's
// parser order are exercised as deployed. Model calls are counted from the
// identity usage rows, and what reached "the model" is read from the fake's
// own log.
//
// Every bank, payee and number here is made up; addresses are built with AT
// so no file carries one.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const express = require('express');

if (process.env.FEEDFIX_MEMORY !== '1' || process.env.FEEDFIX_FAKE_AI !== '1') {
  console.error('run with FEEDFIX_MEMORY=1 FEEDFIX_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient, ownerTag } = require('../server');
const C = require('../public/feedfix-core');
const D = require('../public/demo');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
const ch = (n) => String.fromCharCode(n);
const BOM = ch(0xFEFF), RLO = ch(0x202E), ZWSP = ch(0x200B), NUL = ch(0);

/* ---------------- helpers ---------------- */

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const diag = (input, opts) => C.view(C.diagnose(input, opts || {}));
const keys = (d) => d.findings.map((f) => f.key);
const find = (d, k) => d.findings.find((f) => f.key === k);
const fix = (input, opts) => C.fixFile(input, Object.assign({ profile: 'qbo3' }, opts || {}));
const demoBytes = (f) => C.encode(f.text, f.encoding, f.bom);
const DEMOS = D.files();
const demo = (id) => DEMOS.find((f) => f.id === id);
const SMALL = 'Booking date;Payee;Description;Amount\r\n03.10.2026;Lantern Hill Hardware;Card purchase;-84,12\r\n15.10.2026;Willowmere Clinic;Invoice 7;1.250,00\r\n';
const SIMPLE = (rows) => 'Date,Description,Amount\n' + rows.join('\n') + '\n';

/* ================================================================== *
 * Bytes and encodings
 * ================================================================== */

test('encodings: a UTF-8 byte-order mark, UTF-16 with and without one (both byte orders), Windows-1252, bad bytes, NULs at the end, and files that are not text at all', () => {
  const body = 'Date,Description,Amount\r\n01/15/2026,Café Lantern,-84.12\r\n01/16/2026,Deposit,1200.00\r\n';
  let d = diag(C.encode(body, 'utf-8', true));
  assert.deepStrictEqual([d.decoded.encoding, d.decoded.bom, keys(d)[0]], ['utf-8', true, 'bom']);
  assert.strictEqual(find(d, 'bom').examples[0].before.slice(0, 5), '‹BOM›', 'the mark is drawn where it hides');
  const u16 = C.encode(body, 'utf-16le');
  assert.deepStrictEqual([u16[0], u16[1]], [0xFF, 0xFE]);
  for (const [b, enc, nobom] of [[u16, 'utf-16le', false], [u16.slice(2), 'utf-16le', true]]) {
    d = diag(b);
    assert.deepStrictEqual([d.decoded.encoding, d.decoded.utf16NoBom, keys(d)], [enc, nobom, ['utf16']], 'UTF-16 found by its mark, or by every other byte being zero');
    assert.strictEqual(d.totals.rows, 2);
  }
  const be = new Uint8Array(u16.length); for (let i = 2; i < u16.length; i += 2) { be[i] = u16[i + 1]; be[i + 1] = u16[i]; } be[0] = 0xFE; be[1] = 0xFF;
  assert.strictEqual(diag(be).decoded.encoding, 'utf-16be');
  d = diag(C.encode(body, 'windows-1252'));
  assert.deepStrictEqual([d.decoded.encoding, keys(d)], ['windows-1252', ['cp1252']], 'invalid UTF-8 read as Windows-1252');
  assert.deepStrictEqual(find(d, 'cp1252').lines, [2]);
  const out = fix(C.encode(body, 'windows-1252'));
  assert.ok(C.utf8Decode(out.bytes).text.includes('Café Lantern') && !C.utf8Decode(out.bytes).invalid, 'written as UTF-8');
  const nul = C.toBytes(body + NUL + NUL + NUL);
  d = diag(nul);
  assert.deepStrictEqual([d.decoded.trailingNul, keys(d)], [3, ['nul']]);
  assert.ok(!Array.from(fix(nul).bytes).includes(0), 'no NUL in the output');
  for (const [sig, what] of [[[0x50, 0x4B, 0x03, 0x04, 1, 2], 'Excel workbook'], [[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], 'old-style Excel'], [[0x25, 0x50, 0x44, 0x46, 0x2D], 'PDF'], [[0x89, 0x50, 0x4E, 0x47], 'picture']]) {
    d = diag(new Uint8Array(sig));
    assert.deepStrictEqual([d.format, keys(d)], ['binary', ['binary']]);
    assert.ok(d.findings[0].title.includes(what), d.findings[0].title);
    assert.deepStrictEqual([fix(new Uint8Array(sig)).ok], [false], 'nothing is written for a file that is not text');
  }
  const junk = new Uint8Array(4000); for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919 + 13) % 256;
  assert.deepStrictEqual([diag(junk).format, diag(junk).findings[0].title], ['binary', 'This is not a text file'], 'binary junk renamed .csv is called what it is');
  assert.deepStrictEqual(keys(diag(new Uint8Array(0))), ['empty']);
  assert.deepStrictEqual(keys(diag('  \n\n ')), ['empty']);
});

test('text: UTF-8, Windows-1252 and UTF-16 written and read back by hand; garbled accents repaired only when they really are; invisible characters drawn as marks', () => {
  const s = 'Café € – “quoted” naïve 𝟙';
  assert.strictEqual(C.utf8Decode(C.utf8Encode(s)).text, s);
  const w = C.cp1252Encode('Café € – “x” 𝟙');
  assert.strictEqual(w.lost, 2, 'a character 1252 cannot hold becomes ? (a surrogate pair is two)');
  assert.strictEqual(C.cp1252Decode(w.bytes), 'Café € – “x” ??');
  assert.strictEqual(C.decode(C.encode(s, 'utf-16le')).text, s);
  const m = C.unmojibake('CafÃ© Lantern â€“ shop â€™s Â£5');
  assert.deepStrictEqual([m.text, m.count], ['Café Lantern – shop ’s £5', 4]);
  assert.deepStrictEqual(C.unmojibake('Café naïve Åsa Ørsted').count, 0, 'real accents are left alone');
  const d = diag(SIMPLE(['2026-01-15,CafÃ© Lantern,-84.12', '2026-01-16,Deposit,1200.00']));
  assert.deepStrictEqual(keys(d), ['mojibake']);
  assert.ok(fix(SIMPLE(['2026-01-15,CafÃ© Lantern,-84.12'])).text.includes('Café Lantern'));
  assert.ok(fix(SIMPLE(['2026-01-15,CafÃ© Lantern,-84.12']), { undo: { mojibake: true } }).text.includes('CafÃ©'), 'undo keeps it as it was');
  assert.strictEqual(C.visible(BOM + 'a\tb' + NUL + RLO + ZWSP + '\r\n'), '‹BOM›a⇥b‹NUL›‹U+202E›‹ZWSP›⏎');
  assert.strictEqual(C.line('  a' + ZWSP + 'b' + RLO + '   c  '), 'ab c');
  assert.strictEqual(C.esc('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
});

/* ================================================================== *
 * Delimiters, quoting and the table
 * ================================================================== */

test('delimiters and quoting: comma, semicolon (with decimal commas), tab, pipe, Excel\u2019s sep= line; doubled quotes and line breaks in quotes; CRLF, LF and bare CR', () => {
  assert.strictEqual(C.sniffDelimiter('a;b;c\n1,5;2;3\n4,25;5;6').delim, ';', 'semicolons win over the decimal commas in the amounts');
  assert.strictEqual(C.sniffDelimiter('a\tb\tc\n1\t2,5\t3\n').delim, '\t');
  assert.strictEqual(C.sniffDelimiter('a|b|c\n1|2|3\n').delim, '|');
  assert.deepStrictEqual(C.sniffDelimiter('sep=;\na,b;c\n'), { delim: ';', sep: true });
  const r = C.parseRecords('a,"b ""q"", c","line\nbreak"\r\n1,2,3\r4,5,6\n', ',');
  assert.deepStrictEqual(r.records.map((x) => [x.line, x.cells]), [[1, ['a', 'b "q", c', 'line\nbreak']], [3, ['1', '2', '3']], [4, ['4', '5', '6']]]);
  for (const [text, word] of [['Date;Payee;Amount\n2026-01-15;Shop;-1,50\n2026-01-16;Shop;2,00\n', 'semicolons'], ['Date\tPayee\tAmount\n2026-01-15\tShop\t-1.50\n', 'tabs'], ['Date|Payee|Amount\n2026-01-15|Shop|-1.50\n', 'pipes']]) {
    const d = diag(text);
    assert.ok(find(d, 'delimiter').title.includes(word), word);
    assert.strictEqual(find(d, 'delimiter').every, true);
    assert.ok(fix(text).recheck.clean);
  }
  let d = diag('sep=,\nDate,Description,Amount\n2026-01-15,Shop,-1.50\n');
  assert.deepStrictEqual([keys(d), d.totals.rows], [['sep'], 1]);
  d = diag('Date,Description,Amount\r2026-01-15,Shop,-1.50\r2026-01-16,Shop,-2.00\r');
  assert.deepStrictEqual([keys(d), d.totals.rows], [['endings-cr'], 2]);
  assert.ok(fix('Date,Description,Amount\r2026-01-15,Shop,-1.50\r').text.endsWith('-1.50\r\n'), 'every line ends CR LF');
  assert.deepStrictEqual(keys(diag('Date,Description,Amount\r\n2026-01-15,Shop,-1.50\n2026-01-16,Shop,-2.00\r\n')), ['endings-mixed']);
});

test('quotes that never close are repaired at the line they open on; an amount split by an unquoted comma is joined; stray quotes and ragged rows are named', () => {
  for (const tail of ['', '01/18/2026,"Fuel",-5.00\n01/19/2026,"Fuel",-6.00\n']) {
    const text = 'Date,Description,Amount\n01/15/2026,"Lantern Hill,-84.12\n01/16/2026,Deposit,1200.00\n01/17/2026,Shop,-5.00\n' + tail;
    const d = diag(text);
    assert.deepStrictEqual([find(d, 'unclosed').lines, d.verdict.blocks], [[2], 1], 'one unclosed quote, on line 2' + (tail ? ', mid-file' : ', to the end of the file'));
    const out = fix(text);
    assert.ok(out.text.includes('01/15/2026,Lantern Hill,-84.12'), 'read as a stray character');
    assert.ok(out.recheck.clean && out.totals.same);
    const strict = fix(text, { undo: { quote: true } });
    assert.ok(!strict.recheck.clean || strict.totals.after.rows < 3 + (tail ? 2 : 0), 'undone, a strict reader swallows the rows');
  }
  const split = 'Date,Description,Amount\n01/15/2026,Lantern Hill,-84.12\n01/16/2026,Deposit,1,200.00\n01/17/2026,Shop,-5.00\n';
  let d = diag(split);
  assert.deepStrictEqual(find(d, 'split').lines, [3]);
  assert.strictEqual(find(d, 'split').examples[0].after, '01/16/2026,Deposit,"1,200.00"');
  assert.deepStrictEqual([fix(split).recheck.clean, fix(split).totals.after.inCents], [true, 120000]);
  const unjoined = fix(split, { undo: { rejoin: true } });
  assert.deepStrictEqual([unjoined.totals.after.inCents, unjoined.totals.same, unjoined.ready], [100, false, false], 'undone, the deposit reads as 1.00 - and the totals say it is not the original');
  d = diag('Date,Description,Amount\n01/15/2026,12" pipe,-84.12\n01/16/2026,Shop,-1.00\n');
  assert.deepStrictEqual(find(d, 'stray-quote').lines, [2]);
  d = diag('Date,Description,Amount,Ref\n01/15/2026,Shop,-84.12,A1\n01/16/2026,Shop,-1.00\n01/17/2026,Shop,-2.00,A3\n01/18/2026,Shop,-3.00,A4\n');
  assert.deepStrictEqual(find(d, 'ragged').lines, [3]);
});

test('the table: lines above the header, the header, summary rows (closing balance, totals, end of statement, custom words), blank rows, the header repeated at a page break, "Page 2 of 3", a file with no header', () => {
  const text = [
    'Bank of Riverton', 'Account: Everyday, ending 4417', 'Period: 01.10.2026 - 31.10.2026',
    'Date,Description,Amount,Balance',
    '2026-10-01,Opening balance,,1000.00',
    '2026-10-02,Lantern Hill Hardware,-84.12,915.88',
    ',,,',
    'Page 1 of 2',
    'Date,Description,Amount,Balance',
    '2026-10-03,Willowmere Clinic,1200.00,2115.88',
    '2026-10-04,Saldo final del mes,,2115.88',
    'Total debits,,84.12,',
    'Closing balance,,,2115.88',
    'End of statement',
  ].join('\n') + '\n';
  let d = diag(text);
  assert.deepStrictEqual(d.removed, { preamble: 3, summary: 4, blank: 1, pages: 2, sep: 0 });
  assert.deepStrictEqual(find(d, 'preamble').lines, [1, 2, 3]);
  assert.deepStrictEqual(find(d, 'pages').lines, [8, 9]);
  assert.deepStrictEqual(find(d, 'summary').lines, [5, 12, 13, 14]);
  assert.strictEqual(d.totals.rows, 3, 'the custom-word row is a transaction until the word is known');
  d = diag(text, { words: ['saldo final'] });
  assert.deepStrictEqual([d.totals.rows, d.removed.summary], [2, 5], 'a word from settings marks a summary row');
  assert.deepStrictEqual(d.meta.tie, { opening: 100000, closing: 211588, net: 111588, ok: true }, 'opening + the rows = closing');
  const out = fix(text, { words: ['saldo final'] });
  assert.ok(out.recheck.clean && out.totals.same);
  assert.strictEqual(out.text.split('\r\n').length, 4);
  for (const k of ['preamble', 'summary', 'blank', 'pages']) assert.ok(!fix(text, { words: ['saldo final'], undo: { [k]: true } }).recheck.clean, `undo ${k}: the re-check flags it`);
  d = diag('01/15/2026,Lantern Hill Hardware,-84.12\n01/16/2026,Deposit from Willowmere,1200.00\n01/17/2026,Fee,-5.00\n');
  assert.deepStrictEqual([d.columns.hasHeader, d.columns.headers, keys(d)], [false, ['Column 1', 'Column 2', 'Column 3'], ['noheader', 'columns-unsure']]);
  assert.deepStrictEqual([d.columns.map.date, d.columns.map.description, d.columns.map.amount], [0, 1, 2], 'guessed from the values');
  assert.ok(fix('01/15/2026,Shop,-84.12\n01/16/2026,Deposit,1200.00\n').text.startsWith('Date,Description,Amount\r\n'), 'a header is written');
});

test('columns: header words and value shapes, Debit and Credit replacing Amount, problems in words, shape codes from the fixed list only', () => {
  const t = C.parseRecords('Posting Date,Transaction Details,Withdrawals,Deposits,Running Balance,Chq No.\n2026-01-15,Shop,84.12,,915.88,\n2026-01-16,Deposit,,1200.00,2115.88,\n2026-01-17,Cheque,250.00,,1865.88,1041\n', ',').records;
  const g = C.guessColumns(t[0].cells, t.slice(1).map((r) => r.cells), true);
  assert.deepStrictEqual([g.map.date, g.map.description, g.map.debit, g.map.credit, g.map.balance, g.map.reference, g.map.amount], [0, 1, 2, 3, 4, 5, -1]);
  assert.deepStrictEqual(C.mappingProblems({ date: -1, amount: -1, debit: -1, credit: -1, description: -1, payee: -1 }), ['Choose the date column.', 'Choose the amount column (or the Debit and Credit columns).', 'Choose the description or payee column.']);
  assert.deepStrictEqual(C.mappingProblems({ date: 0, amount: 0, description: 1 }), ['One column is chosen for two fields.']);
  for (const shapes of g.shapes) for (const s of shapes) { assert.ok(C.SHAPES[s], s); assert.ok(!/\d/.test(s), 'no digit in a shape code'); }
  assert.deepStrictEqual([g.shapes[0], g.shapes[2]], [['date-iso'], ['number-dot', 'number-positive', 'empty-mostly'].filter((x) => g.shapes[2].includes(x))]);
  const d = diag('Date,Description,Amount\n2026-01-15,Shop,-84.12\n', { map: { date: 0, description: -1, payee: -1, amount: 2 } });
  assert.deepStrictEqual(keys(d), ['columns-unsure']);
  assert.strictEqual(fix('Date,Description,Amount\n2026-01-15,Shop,-84.12\n', { map: { date: 0, amount: 2 } }).ok, false, 'nothing is written until the columns make sense');
});

/* ================================================================== *
 * Dates
 * ================================================================== */

test('dates: ISO with times, yyyymmdd only where mapped, day-first and month-first, two-digit years, month names either way round, Quicken\u2019s 1/31\'26, invalid days refused', () => {
  const cases = [['2026-01-31', null, '2026-01-31'], ['2026/01/31 14:22:05', null, '2026-01-31'], ['2026-01-31T09:00:00Z', null, '2026-01-31'], ['31.01.2026', null, '2026-01-31'], ['01/31/2026', null, '2026-01-31'], ['03/04/2026', 'dmy', '2026-04-03'], ['03/04/2026', 'mdy', '2026-03-04'], ['3/4/26', 'mdy', '2026-03-04'], ['31-Jan-26', null, '2026-01-31'], ['31 January 2026', null, '2026-01-31'], ['Jan 31, 2026', null, '2026-01-31'], ['Sat, 31 Jan 2026', null, '2026-01-31'], ["1/31'26", null, '2026-01-31'], ['31/01/99', null, '1999-01-31'], ['15/01/2026 14:05', null, '2026-01-15']];
  for (const [raw, order, want] of cases) assert.strictEqual(C.readDate(raw, order), want, raw);
  assert.strictEqual(C.readDate('20260131'), null, 'a bare number is not a date...');
  assert.strictEqual(C.readDate('20260131', null, true), '2026-01-31', '...unless the column is one');
  for (const bad of ['2026-02-30', '31/02/2026', '13/13/2026', 'TBD', '', 'Pending', '1250.00']) assert.strictEqual(C.readDate(bad, 'dmy', true), null, bad);
  assert.strictEqual(C.readDate('29/02/2028', 'dmy'), '2028-02-29', 'a leap day');
  const d = diag(SIMPLE(['15 Jan 26,Shop,-84.12', '16-Jan-26,Deposit,1200.00', 'Jan 17 2026,Fee,-5.00']));
  assert.deepStrictEqual(keys(d), ['dates-two', 'dates-text']);
  assert.ok(fix(SIMPLE(['15 Jan 26,Shop,-84.12'])).text.includes('01/15/2026'));
  const mixed = diag(SIMPLE(['2026-01-15,Shop,-84.12', '16/01/2026,Deposit,1200.00', '01/17/2026,Fee,-5.00']));
  assert.deepStrictEqual(keys(mixed), ['dates-mixed']);
  assert.deepStrictEqual(fix(SIMPLE(['2026-01-15,Shop,-84.12', '16/01/2026,Deposit,1200.00', '01/17/2026,Fee,-5.00'])).text.split('\r\n').slice(1, 4).map((l) => l.slice(0, 10)), ['01/15/2026', '01/16/2026', '01/17/2026'], 'each read the only way it can be');
  const bad = diag(SIMPLE(['2026-01-15,Shop,-84.12', 'TBD,Deposit,1200.00', '2026-02-30,Fee,-5.00', '2026-01-18,Coffee,-4.10']));
  assert.deepStrictEqual([keys(bad), find(bad, 'dates-bad').lines], [['dates-bad'], [3, 4]]);
  const kept = fix(SIMPLE(['2026-01-15,Shop,-84.12', 'TBD,Deposit,1200.00', '2026-02-30,Fee,-5.00', '2026-01-18,Coffee,-4.10']));
  assert.ok(!kept.recheck.clean, 'an unreadable date is never quietly dropped');
  const left = fix(SIMPLE(['2026-01-15,Shop,-84.12', 'TBD,Deposit,1200.00', '2026-02-30,Fee,-5.00', '2026-01-18,Coffee,-4.10']), { leaveOut: { 3: true, 4: true } });
  assert.deepStrictEqual([left.recheck.clean, left.totals.same, left.totals.removedRows, left.totals.after.rows], [true, true, 2, 2], 'left out on purpose, and listed');
});

test('day/month or month/day: when every date is 12 or under, both readings are offered and the one that runs in order is suggested (else the shorter span, else the browser\u2019s habit); an answer wins', () => {
  const vals = ['02/01/2026', '02/03/2026', '02/10/2026', '03/02/2026', '03/09/2026'];
  const q = C.orderQuestion(vals, true, true);
  assert.deepStrictEqual([q.suggestion, q.why, q.mdy.inOrder, q.dmy.inOrder, q.dmy.inversions], ['mdy', 'in order', true, false, 1], 'month/day runs in order even in a day-first browser');
  assert.deepStrictEqual([q.mdy.first, q.mdy.last, q.dmy.first, q.dmy.last], ['2026-02-01', '2026-03-09', '2026-01-02', '2026-10-02']);
  assert.deepStrictEqual(q.examples[0], { raw: '02/01/2026', dmy: '2026-01-02', mdy: '2026-02-01' });
  const span = C.orderQuestion(['01/02/2026', '01/03/2026'], true, true);
  assert.deepStrictEqual([span.suggestion, span.why], ['mdy', 'shorter'], 'both run in order: 2-3 January (a day) beats 1 February - 1 March (a month), even in a day-first browser');
  assert.deepStrictEqual([C.orderQuestion(['03/03/2026'], true, true).suggestion, C.orderQuestion(['03/03/2026'], false, true).suggestion], ['dmy', 'mdy'], 'a tie goes to the browser\u2019s habit');
  const text = SIMPLE(vals.map((v, i) => `${v},Row ${i},-1.0${i}`));
  let d = diag(text, { dayFirst: true });
  assert.deepStrictEqual([d.questions[0].chosen, d.questions[0].answered, find(d, 'dates-ambiguous').sev], ['mdy', false, 'wrong']);
  assert.ok(fix(text, { dayFirst: true, dateFormat: 'mdy' }).text.includes('02/01/2026,Row 0'));
  assert.ok(fix(text, { dayFirst: true }).text.includes('01/02/2026,Row 0'), 'and written day first for a day-first browser');
  d = diag(text, { order: 'dmy' });
  assert.deepStrictEqual([d.questions[0].chosen, d.questions[0].answered, find(d, 'dates-ambiguous').sev], ['dmy', true, 'info'], 'an answer stands, and the finding steps down');
  assert.strictEqual(fix(text, { order: 'dmy', dateFormat: 'mdy' }).text.split('\r\n')[1].slice(0, 10), '01/02/2026');
  assert.strictEqual(diag(SIMPLE(['13/01/2026,A,-1.00', '02/01/2026,B,-1.00'])).questions.length, 0, 'one day over 12 settles it');
});

/* ================================================================== *
 * Amounts and signs
 * ================================================================== */

test('amounts: decimal commas, thousands in four styles, currency signs and codes, parentheses, a trailing minus, CR and DR (spaced or glued), a typographic minus, more than two decimals - and "free" is not a number', () => {
  const cases = [['1.234,56', null, 123456, ['comma', 'thousands']], ['-84,12', null, -8412, ['comma']], ['1,234.56', null, 123456, ['thousands']], ['1 234,56', null, 123456, ['thousands', 'comma']], ['1\u00A0234,56', null, 123456, ['thousands', 'comma']], ["1'234.56", null, 123456, ['thousands']], ['$1,250.00', null, 125000, ['symbol', 'thousands']], ['€ -12,50', null, -1250, ['symbol', 'comma']], ['USD 412.37', null, 41237, ['code']], ['(84.12)', null, -8412, ['paren']], ['($84.12)', null, -8412, ['paren', 'symbol']], ['84.12-', null, -8412, ['trailing']], ['84.12 DR', null, -8412, ['crdr']], ['84.12DR', null, -8412, ['crdr']], ['1200.00 CR', null, 120000, ['crdr']], ['\u221284.12', null, -8412, ['minus']], ['12.345', null, 1235, ['precision']], ['1.234', ',', 123400, ['thousands']], ['12,50', '.', 1250, ['comma']], ['+5.00', null, 500, ['plus']], ['0', null, 0, []]];
  for (const [raw, dec, cents, notes] of cases) {
    const a = C.readAmount(raw, dec);
    assert.ok(a && !a.error, raw);
    assert.strictEqual(a.cents, cents, raw);
    assert.deepStrictEqual(Object.keys(a.notes).sort(), notes.slice().sort(), raw);
  }
  for (const bad of ['free', 'n/a', '1.2.3', '1,2,3.4,5', 'abc12', '12..5', '$']) assert.ok(C.readAmount(bad).error, bad);
  assert.strictEqual(C.readAmount(''), null);
  assert.strictEqual(C.amountStyle(['1.234,56', '-84,12', '5,00']), ',');
  assert.strictEqual(C.amountStyle(['1,234.56', '-84.12']), '.');
  assert.deepStrictEqual([C.plain(-8412), C.plain(5), C.plain(123456789)], ['-84.12', '0.05', '1234567.89']);
  assert.deepStrictEqual([C.money(441085, 'EUR'), C.money(-8412, 'USD'), C.money(100, 'GBP')], ['€4,410.85', '-$84.12', '£1.00']);
  const d = diag('Date,Description,Amount\n2026-01-15,Shop,84.12 DR\n2026-01-16,Deposit,"1,200.00 CR"\n2026-01-17,Fee,5.00DR\n2026-01-18,Coffee,4.10-\n2026-01-19,Fuel,(40.00)\n2026-01-20,Card,$12.00\n');
  assert.deepStrictEqual(keys(d).sort(), ['amount-crdr', 'amount-paren', 'amount-symbol', 'amount-thousands', 'amount-trailing'].sort());
  assert.deepStrictEqual(d.totals, { rows: 6, inCents: 121200, outCents: 13322, net: 107878, first: '2026-01-15', last: '2026-01-20', unread: 0 });
  assert.deepStrictEqual(keys(diag(SIMPLE(['2026-01-15,Shop,free', '2026-01-16,Deposit,1200.00', '2026-01-17,Fee,-5.00', '2026-01-18,Fuel,-40.00']))), ['amount-bad']);
});

test('signs: Debit and Credit columns combined (and split again for QuickBooks 4-column), debits written negative, a Type column, positive amounts the balance says go out, a whole file the wrong way round - and the person\u2019s own flip', () => {
  const dc = 'Date,Description,Debit,Credit\n2026-01-15,Shop,84.12,\n2026-01-16,Deposit,,1200.00\n2026-01-17,Fee,-5.00,\n';
  let d = diag(dc);
  assert.deepStrictEqual([d.totals.inCents, d.totals.outCents], [120000, 8912]);
  assert.deepStrictEqual(keys(d), ['debit-credit', 'debit-negative']);
  assert.strictEqual(fix(dc, { profile: 'qbo4' }).text, 'Date,Description,Credit,Debit\r\n01/15/2026,Shop,,84.12\r\n01/16/2026,Deposit,1200.00,\r\n01/17/2026,Fee,,5.00\r\n');
  const typed = 'Date,Description,Type,Amount\n2026-01-15,Shop,DEBIT,84.12\n2026-01-16,Deposit,CREDIT,1200.00\n2026-01-17,Fee,DR,5.00\n';
  d = diag(typed);
  assert.deepStrictEqual([keys(d), find(d, 'sign-type').lines, d.totals.outCents], [['sign-type'], [2, 4], 8912]);
  assert.strictEqual(fix(typed, { undo: { signs: true } }).totals.after.outCents, 0, 'undo: as the bank wrote them');
  assert.ok(fix(typed, { undo: { signs: true } }).fixes.find((x) => x.key === 'signs' && x.undone), 'and the fix stays listed, to redo');
  const pos = 'Date,Description,Amount,Balance\n2026-01-15,Shop,84.12,915.88\n2026-01-16,Deposit,1200.00,2115.88\n2026-01-17,Fee,5.00,2110.88\n2026-01-18,Coffee,4.10,2106.78\n';
  d = diag(pos);
  assert.deepStrictEqual([find(d, 'sign-balance').lines, d.totals.outCents], [[4, 5], 910], 'the balance shows which way each went; the first row cannot be told');
  assert.ok(/Line 2 could not be told/.test(find(d, 'sign-balance').detail));
  const inv = 'Date,Description,Amount,Balance\n2026-01-15,Shop,84.12,915.88\n2026-01-16,Deposit,-1200.00,2115.88\n2026-01-17,Fee,5.00,2110.88\n2026-01-18,Coffee,4.10,2106.78\n';
  d = diag(inv);
  assert.deepStrictEqual([find(d, 'sign-balance').title, d.totals.inCents, d.totals.outCents], ['The amounts move the balance the wrong way round', 120000, 9322]);
  const card = SIMPLE(['2026-01-15,Shop,84.12', '2026-01-16,Payment,-50.00']);
  assert.deepStrictEqual(diag(card, { flip: true }).totals, Object.assign(diag(card).totals, { inCents: 5000, outCents: 8412, net: -3412 }));
  assert.ok(fix(card, { flip: true }).fixes.find((x) => x.key === 'flip'));
});

test('the running balance: each row follows from the one before (oldest or newest first); a break says where a row may be missing and by how much; two rows on one day in the other order are not a break', () => {
  let d = diag('Date,Description,Amount,Balance\n2026-01-15,Shop,-84.12,915.88\n2026-01-16,Deposit,1200.00,2115.88\n2026-01-17,Fee,-5.00,2065.88\n2026-01-18,Coffee,-4.10,2061.78\n');
  const b = find(d, 'balance-break');
  assert.deepStrictEqual([b.lines, d.balance.breaks[0].after, d.balance.breaks[0].gap, b.carried], [[4], 3, -4500, true]);
  assert.ok(/Line 4: the balance moves \$45\.00 less than the amounts say, so a row may be missing between line 3 and line 4/.test(b.detail), b.detail);
  const out = fix('Date,Description,Amount,Balance\n2026-01-15,Shop,-84.12,915.88\n2026-01-16,Deposit,1200.00,2115.88\n2026-01-17,Fee,-5.00,2065.88\n2026-01-18,Coffee,-4.10,2061.78\n', { profile: 'generic' });
  assert.ok(out.recheck.clean && out.recheck.carried.some((c) => c.key === 'balance-break'), 'carried - a file fix cannot bring a row back');
  d = diag('Date,Description,Amount,Balance\n2026-01-18,Coffee,-4.10,2106.78\n2026-01-17,Fee,-5.00,2110.88\n2026-01-16,Deposit,1200.00,2115.88\n2026-01-15,Shop,-84.12,915.88\n');
  assert.deepStrictEqual([d.balance.newestFirst, d.balance.breakCount, find(d, 'balance-ok').ok], [true, 0, true]);
  d = diag('Date,Description,Amount,Balance\n2026-01-15,Shop,-10.00,990.00\n2026-01-16,Coffee,-3.00,982.00\n2026-01-16,Fuel,-5.00,987.00\n2026-01-17,Fee,-1.00,981.00\n');
  assert.strictEqual(d.balance.breakCount, 0, 'one day, the bank\u2019s own order');
  const tie = diag('Date,Description,Amount\nOpening balance,,1000.00\n2026-01-15,Shop,-84.12\n2026-01-16,Deposit,1200.00\nClosing balance,,2200.00\n');
  assert.deepStrictEqual([find(tie, 'opening-closing').sev, tie.meta.tie.ok], ['wrong', false], 'opening + rows not equal to closing: a row may be missing');
  assert.ok(/\$84\.12 is unaccounted for/.test(find(tie, 'opening-closing').detail));
});

test('duplicates: the same date, amount and description twice is flagged - never removed unless asked - and listed with the line it repeats', () => {
  const text = SIMPLE(['2026-01-15,Coffee,-3.40', '2026-01-15,Coffee,-3.40', '2026-01-15,Coffee,-3.40', '2026-01-16,Deposit,1200.00', '2026-01-16,Deposit,1200.00']);
  const d = diag(text);
  assert.deepStrictEqual([find(d, 'duplicates').lines, d.dups.map((x) => [x.line, x.of])], [[3, 4, 6], [[3, 2], [4, 2], [6, 5]]]);
  let out = fix(text);
  assert.deepStrictEqual([out.totals.after.rows, out.recheck.clean, out.fixes.find((x) => x.key === 'duplicates').label], [5, true, 'Kept 3 possible duplicates (listed in the duplicates report)']);
  out = fix(text, { dropDuplicates: true });
  assert.deepStrictEqual([out.totals.after.rows, out.totals.same, out.totals.removedRows, out.totals.removed.map((r) => r.why)], [2, true, 3, ['duplicate', 'duplicate', 'duplicate']], 'removed only on request, and the totals say so');
  assert.strictEqual(diag(SIMPLE(['2026-01-15,Coffee,-3.40', '2026-01-15,Coffee,-3.41'])).dups.length, 0);
  assert.strictEqual(C.duplicatesCsv(d.dups), 'line,same_as_line,date,amount,description,payee,reference\r\n3,2,2026-01-15,-3.40,Coffee,,\r\n4,2,2026-01-15,-3.40,Coffee,,\r\n6,5,2026-01-16,1200.00,Deposit,,\r\n');
});

/* ================================================================== *
 * OFX, QFX and QIF
 * ================================================================== */

const OFX_HEAD = 'OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nSECURITY:NONE\r\nENCODING:USASCII\r\nCHARSET:1252\r\nCOMPRESSION:NONE\r\nOLDFILEUID:NONE\r\nNEWFILEUID:NONE\r\n';
const trn = (type, dt, amt, fitid, name, memo) => `<STMTTRN>\r\n<TRNTYPE>${type}\r\n<DTPOSTED>${dt}\r\n<TRNAMT>${amt}\r\n${fitid === null ? '' : `<FITID>${fitid}\r\n`}<NAME>${name}\r\n${memo ? `<MEMO>${memo}\r\n` : ''}</STMTTRN>\r\n`;
const ofx = (head, body, acct = true, cur = 'USD') => `${head}<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n${cur ? `<CURDEF>${cur}\r\n` : ''}${acct ? '<BANKACCTFROM>\r\n<BANKID>900001\r\n<ACCTID>4417\r\n<ACCTTYPE>CHECKING\r\n</BANKACCTFROM>\r\n' : ''}<BANKTRANLIST>\r\n<DTSTART>20261001\r\n<DTEND>20261031\r\n${body}</BANKTRANLIST>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n`;

test('OFX 1.x (SGML): header problems strict readers refuse, duplicate and missing FITIDs, DTPOSTED and TRNAMT not in OFX form, a bare &, sections left open, no account, no currency, long names, signs and types', () => {
  const body = trn('DEBIT', '20261007', '-3.40', 'A1', 'Cobble &amp; Fern Café') + trn('DEBIT', '20261007', '-3.40', 'A1', 'Cobble &amp; Fern Café') + trn('CREDIT', '20261012', '2400.00', 'A3', 'Willowmere Clinic');
  let d = diag(C.encode(ofx(OFX_HEAD + '\r\n', body), 'windows-1252'));
  assert.deepStrictEqual([d.format, keys(d)], ['ofx', ['fitid-dup', 'duplicates']], 'a clean header, one reused FITID');
  assert.ok(/£|\$3\.40 never arrives/.test(find(d, 'fitid-dup').detail), find(d, 'fitid-dup').detail);
  assert.deepStrictEqual([find(d, 'fitid-dup').lines, find(d, 'fitid-dup').examples[0].before, find(d, 'fitid-dup').examples[0].after], [[31], 'line 24: <FITID>A1\nline 31: <FITID>A1', 'line 24: <FITID>A1  (kept)\nline 31: <FITID>A1-2'], 'the transaction that would be skipped, and both lines');
  assert.deepStrictEqual([d.totals.rows, d.sampleTx[0].payee], [3, 'Cobble & Fern Café'], 'entities read, Windows-1252 as declared - no encoding finding');
  for (const [head, code] of [[OFX_HEAD, 'blank line'], ['\r\n' + OFX_HEAD + '\r\n', 'before OFXHEADER'], [OFX_HEAD.replace('VERSION:102', 'VERSION : 102') + '\r\n', 'colon'], [OFX_HEAD.replace('DATA:OFXSGML\r\n', '') + '\r\n', 'no DATA line'], ['', 'no OFXHEADER line']]) {
    d = diag(ofx(head, trn('DEBIT', '20261007', '-3.40', 'A1', 'Shop')));
    assert.ok(find(d, 'ofx-header') && find(d, 'ofx-header').detail.includes(code), code + ': ' + (find(d, 'ofx-header') || {}).detail);
  }
  const messy = trn('DEBIT', '2026-10-07', '12,50', null, 'Smith & Sons') + trn('DEBIT', '20261008', '5.00', null, 'Brightwick Mutual Insurance Society Ltd') + '<STMTTRN>\r\n<TRNTYPE>CREDIT\r\n<DTPOSTED>20261009\r\n<TRNAMT>100.00\r\n<FITID>A3\r\n<NAME>Deposit\r\n';
  d = diag(ofx(OFX_HEAD + '\r\n', messy, false, ''));
  assert.deepStrictEqual(keys(d).sort(), ['ampersand', 'curdef', 'dtposted', 'fitid-missing', 'name-long', 'ofx-account', 'sign-type', 'trnamt', 'unclosed-tag'].sort());
  assert.deepStrictEqual([find(d, 'sign-type').lines, d.totals.outCents, d.totals.inCents], [[18, 24], 1750, 10000], 'every amount positive: TRNTYPE says which go out');
  d = diag(ofx(OFX_HEAD + '\r\n', trn('DEBIT', '20261007', '3.40', 'A1', 'Refund') + trn('DEBIT', '20261008', '-5.00', 'A2', 'Shop')));
  assert.deepStrictEqual([find(d, 'trnamt-sign').lines, d.totals.inCents], [[24], 340], 'a mixed file keeps the bank\u2019s amount and rewrites the type');
});

test('the OFX rebuild: a clean 1.0.2 header, every section closed, unique FITIDs (unique ones kept, repeats suffixed, missing ones stable across runs), NAME cut at 32 into MEMO, credit cards as CCACCTFROM, Windows-1252, and a clean re-check', () => {
  const body = trn('DEBIT', '20261007', '-3.40', 'A1', 'Cobble &amp; Fern Café') + trn('DEBIT', '20261007', '-3.40', 'A1', 'Cobble &amp; Fern Café') + trn('DEBIT', '20261014', '-212.50', null, 'Brightwick Mutual Insurance Society Ltd', 'Premium');
  const src = C.encode(ofx(OFX_HEAD, body), 'windows-1252');
  const out = fix(src, { profile: 'ofx' });
  assert.ok(out.recheck.clean && out.totals.same && out.ready, JSON.stringify(out.recheck));
  const o = C.parseOfx(C.cp1252Decode(out.bytes));
  assert.deepStrictEqual(o.txs.map((t) => t.f.FITID).slice(0, 2), ['A1', 'A1-2']);
  assert.ok(/^FF20261014[0-9A-F]{8}$/.test(o.txs[2].f.FITID), o.txs[2].f.FITID);
  assert.strictEqual(fix(src, { profile: 'ofx' }).text, out.text, 'generated FITIDs are the same every run - importing the fixed file twice does not duplicate it');
  assert.deepStrictEqual([o.txs[2].f.NAME, o.txs[2].f.MEMO], ['Brightwick Mutual Insurance Soci', 'Brightwick Mutual Insurance Society Ltd - Premium']);
  assert.ok(out.text.includes('<NAME>Cobble &amp; Fern Café') && C.cp1252Decode(out.bytes).includes('Café') && !Array.from(out.bytes).some((b) => b === 0xC3), 'escaped, and written as Windows-1252');
  assert.ok(out.text.startsWith(OFX_HEAD + '\r\n<OFX>\r\n'));
  assert.deepStrictEqual(out.fixes.map((x) => x.key), ['ofxheader', 'fitid', 'namelen', 'duplicates']);
  assert.ok(!fix(src, { profile: 'ofx', undo: { fitid: true } }).recheck.clean, 'undo: the duplicate FITIDs come back and the re-check says so');
  const cc = fix(SMALL, { profile: 'ofx', account: { acctId: '4417', acctType: 'CREDITCARD' }, currency: 'USD' });
  assert.ok(cc.text.includes('<CREDITCARDMSGSRSV1>') && cc.text.includes('<CCACCTFROM>\r\n<ACCTID>4417\r\n</CCACCTFROM>') && cc.recheck.clean);
  const noAcct = fix(SMALL, { profile: 'ofx' });
  assert.ok(!noAcct.recheck.clean && noAcct.recheck.conform.some((c) => c.account), 'a CSV has no account: the re-check asks for one');
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>1</BANKID><ACCTID>22</ACCTID><ACCTTYPE>SAVINGS</ACCTTYPE></BANKACCTFROM><BANKTRANLIST>\n<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261007</DTPOSTED><TRNAMT>-12.50</TRNAMT><FITID>X1</FITID><NAME>Smith & Sons</NAME></STMTTRN>\n<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261008</DTPOSTED><TRNAMT>-5.00</TRNAMT><FITID>X1</FITID><NAME>Fuel</NAME></STMTTRN>\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\n';
  const dx = diag(xml);
  assert.deepStrictEqual([C.formatLabel(dx), keys(dx), find(dx, 'ampersand').sev], ['OFX 2 (XML) · UTF-8', ['fitid-dup', 'ampersand'], 'blocks'], 'OFX 2: a bare & stops an XML reader');
  const fx = fix(xml, { profile: 'ofx' });
  assert.ok(fx.recheck.clean && fx.text.includes('<ACCTTYPE>SAVINGS') && fx.text.includes('<FITID>X1-2'));
  assert.ok(fix(xml).text.includes('10/07/2026,Smith & Sons,-12.50'), 'and to CSV');
});

test('QIF: a missing !Type header, Quicken\u2019s 1/31\'26 dates, the day/month question, amounts with commas, an entry with no closing ^ - and the conversion', () => {
  const noType = 'D10/31/2026\nT-84.12\nPLantern Hill Hardware\n^\nD11/01/2026\nT1,200.00\nPWillowmere Clinic\nMInvoice 7\n^\nD11/02\'26\nT-5.00\nPFee\nN1041\n';
  let d = diag(noType);
  assert.deepStrictEqual([d.format, keys(d)], ['qif', ['qif-type', 'amount-thousands', 'dates-two', 'qif-end']]);
  assert.strictEqual(find(d, 'dates-two').title, 'Quicken-style dates (1/31\'26)');
  assert.strictEqual(fix(noType, { profile: 'xero', dateFormat: 'mdy' }).text, 'Date,Amount,Payee,Description,Reference\r\n10/31/2026,-84.12,Lantern Hill Hardware,,\r\n11/01/2026,1200.00,Willowmere Clinic,Invoice 7,\r\n11/02/2026,-5.00,Fee,,1041\r\n');
  d = diag('!Type:Bank\nD03/04/2026\nT-84.12\nPLantern\n^\nD03/05/2026\nT1200.00\nPDeposit\n^\nD04/04/2026\nT-5.00\nPFee\n^\n');
  assert.deepStrictEqual([C.formatLabel(d), d.questions[0].suggestion], ['QIF (Bank) · UTF-8', 'mdy']);
  assert.ok(fix('!Type:CCard\nD03/04/2026\nT-84.12\nPLantern\n^\n').recheck.clean);
});

/* ================================================================== *
 * Each target, exact bytes
 * ================================================================== */

test('each target writes exactly the shape it promises: QuickBooks 3- and 4-column, Xero, generic ISO, OFX 1.0.2 - byte for byte', () => {
  const want = {
    qbo3: 'Date,Description,Amount\r\n10/03/2026,Lantern Hill Hardware - Card purchase,-84.12\r\n10/15/2026,Willowmere Clinic - Invoice 7,1250.00\r\n',
    qbo4: 'Date,Description,Credit,Debit\r\n10/03/2026,Lantern Hill Hardware - Card purchase,,84.12\r\n10/15/2026,Willowmere Clinic - Invoice 7,1250.00,\r\n',
    xero: 'Date,Amount,Payee,Description,Reference\r\n03/10/2026,-84.12,Lantern Hill Hardware,Card purchase,\r\n15/10/2026,1250.00,Willowmere Clinic,Invoice 7,\r\n',
    generic: 'Date,Description,Payee,Amount\r\n2026-10-03,Card purchase,Lantern Hill Hardware,-84.12\r\n2026-10-15,Invoice 7,Willowmere Clinic,1250.00\r\n',
    ofx: OFX_HEAD + '\r\n<OFX>\r\n<SIGNONMSGSRSV1>\r\n<SONRS>\r\n<STATUS>\r\n<CODE>0\r\n<SEVERITY>INFO\r\n</STATUS>\r\n<DTSERVER>20261015120000\r\n<LANGUAGE>ENG\r\n</SONRS>\r\n</SIGNONMSGSRSV1>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<TRNUID>1\r\n<STATUS>\r\n<CODE>0\r\n<SEVERITY>INFO\r\n</STATUS>\r\n<STMTRS>\r\n<CURDEF>USD\r\n<BANKACCTFROM>\r\n<BANKID>900001\r\n<ACCTID>4417\r\n<ACCTTYPE>CHECKING\r\n</BANKACCTFROM>\r\n<BANKTRANLIST>\r\n<DTSTART>20261003120000\r\n<DTEND>20261015120000\r\n<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<DTPOSTED>20261003120000\r\n<TRNAMT>-84.12\r\n<FITID>FF202610039F4A3034\r\n<NAME>Lantern Hill Hardware\r\n<MEMO>Card purchase\r\n</STMTTRN>\r\n<STMTTRN>\r\n<TRNTYPE>CREDIT\r\n<DTPOSTED>20261015120000\r\n<TRNAMT>1250.00\r\n<FITID>FF20261015BA428F94\r\n<NAME>Willowmere Clinic\r\n<MEMO>Invoice 7\r\n</STMTTRN>\r\n</BANKTRANLIST>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n',
  };
  for (const k of C.PROFILE_KEYS) {
    const out = fix(SMALL, { profile: k, dateFormat: k === 'xero' ? 'dmy' : undefined, account: { acctId: '4417', bankId: '900001' }, currency: 'USD' });
    assert.strictEqual(out.text, want[k], k);
    assert.deepStrictEqual(Array.from(out.bytes), Array.from(k === 'ofx' ? C.cp1252Encode(want[k]).bytes : C.utf8Encode(want[k])), k + ': the bytes, with no byte-order mark');
    assert.ok(out.recheck.clean && out.totals.same && out.ready, k);
    assert.strictEqual(out.fileName, 'statement-feedfix-' + k + '.' + (k === 'ofx' ? 'ofx' : 'csv'));
  }
  assert.strictEqual(fix(SMALL, { profile: 'qbo3', dateFormat: 'dmy' }).text.split('\r\n')[1].slice(0, 10), '03/10/2026');
  assert.strictEqual(fix(SMALL, { profile: 'generic', dateFormat: 'mdy' }).dateFormat, 'iso', 'a target with one format keeps it');
  assert.deepStrictEqual([C.profileDates('xero', true), C.profileDates('xero', false), C.profileDates('qbo3', true), C.profileDates('generic', true)], ['dmy', 'mdy', 'dmy', 'iso']);
});

/* ================================================================== *
 * The demo: every file, every target, every undo
 * ================================================================== */

test('the demo: three made-up banks, each broken exactly the intended way, with its hint on a finding that blocks import', () => {
  const want = {
    riverton: [['delimiter', 'preamble', 'bom', 'summary', 'amount-comma', 'amount-thousands', 'opening-closing', 'balance-ok'], '3 stop an import · 3 would import wrong', 19],
    lakeport: [['pages', 'blank', 'dates-ambiguous', 'amount-paren', 'amount-thousands'], '1 stops an import · 4 would import wrong', 17],
    harbour: [['ofx-header', 'fitid-dup', 'duplicates', 'name-long'], '2 stop an import · 2 worth knowing', 16],
  };
  for (const f of DEMOS) {
    const d = diag(demoBytes(f), { name: f.name });
    assert.deepStrictEqual(keys(d), want[f.id][0], f.id);
    assert.deepStrictEqual([d.verdict.line, d.totals.rows], want[f.id].slice(1), f.id);
    assert.strictEqual(find(d, f.hint).sev, 'blocks', f.id + ': the hint is on a finding that blocks import');
  }
  const r = diag(demoBytes(demo('riverton')));
  assert.deepStrictEqual([r.decoded.bom, r.delimiter, r.removed.preamble, find(r, 'summary').lines, r.meta.tie.ok], [true, 'semicolon', 3, [24], true]);
  assert.deepStrictEqual([r.totals.inCents, r.totals.outCents, r.currency, demo('riverton').currency], [443085, 179690, '', 'EUR'], 'no sign in the amounts: the demo says euros, the page passes it on');
  const l = diag(demoBytes(demo('lakeport')));
  assert.deepStrictEqual([l.questions[0].suggestion, l.questions[0].mdy.inOrder, l.questions[0].dmy.inOrder, find(l, 'pages').lines, find(l, 'blank').lines], ['mdy', true, false, [11, 12, 22], [10]]);
  const h = diag(demoBytes(demo('harbour')));
  assert.deepStrictEqual([find(h, 'fitid-dup').lines, h.currency, h.decoded.encoding, h.ofx.acct.ACCTID], [[74, 114], 'GBP', 'windows-1252', '00008421']);
  assert.ok(/£15\.90 never arrives/.test(find(h, 'fitid-dup').detail));
});

test('the demo: every file to every target re-checks clean with the same totals; every fix can be undone (and the re-check or the totals notice) and redone', () => {
  for (const f of DEMOS) {
    const b = demoBytes(f);
    for (const p of C.PROFILE_KEYS) {
      const base = { name: f.name, profile: p, account: { acctId: '4417' } };
      const out = fix(b, base);
      assert.ok(out.recheck.clean, `${f.id} -> ${p}: ${JSON.stringify(out.recheck.problems.concat(out.recheck.conform))}`);
      assert.ok(out.totals.same && out.ready, `${f.id} -> ${p}: totals`);
      assert.deepStrictEqual([out.totals.after.rows, out.totals.after.inCents, out.totals.after.outCents], [out.totals.before.rows, out.totals.before.inCents, out.totals.before.outCents]);
      for (const x of out.fixes.filter((y) => !y.required && !y.optional)) {
        const u = fix(b, Object.assign({}, base, { undo: { [x.key]: true } }));
        assert.ok(u.fixes.find((y) => y.key === x.key && y.undone), `${f.id} -> ${p}: undo ${x.key} stays listed`);
        // Lakeport's dates are already MM/DD/YYYY: written as they were, they
        // are exactly what QuickBooks wants, so undoing that fix is harmless.
        const harmless = f.id === 'lakeport' && x.key === 'dates' && out.dateFormat === 'mdy';
        assert.ok(harmless || Buffer.compare(Buffer.from(u.bytes), Buffer.from(out.bytes)) !== 0, `${f.id} -> ${p}: undo ${x.key} changes the file`);
        assert.ok(harmless || !u.recheck.clean || !u.totals.same, `${f.id} -> ${p}: undo ${x.key} is noticed`);
        assert.strictEqual(fix(b, Object.assign({}, base, { undo: {} })).text, out.text, 'redo gives the clean file back');
      }
    }
  }
});

test('totals that prove it: rows in and out, money in and out, net, first and last date - "same as the original" unless a row was left out on purpose, which is listed', () => {
  const out = fix(demoBytes(demo('harbour')), { dropDuplicates: true });
  assert.deepStrictEqual([out.totals.before.rows, out.totals.after.rows, out.totals.same, out.totals.removed], [16, 14, true, [{ line: 74, amount: -340, why: 'duplicate' }, { line: 114, amount: -1250, why: 'duplicate' }]]);
  assert.strictEqual(out.totals.before.outCents - out.totals.after.outCents, 1590);
  const r = fix(demoBytes(demo('riverton')));
  assert.strictEqual(`${C.plural(r.totals.after.rows, 'row')} · in ${C.money(r.totals.after.inCents, 'EUR')} · out ${C.money(r.totals.after.outCents, 'EUR')}`, '19 rows · in €4,430.85 · out €1,796.90');
  assert.deepStrictEqual([r.totals.after.first, r.totals.after.last], ['2026-10-01', '2026-10-31']);
  const wrongWay = fix(demoBytes(demo('lakeport')), { profile: 'xero', dateFormat: 'dmy', undo: { dates: true } });
  assert.ok(wrongWay.recheck.clean && !wrongWay.totals.same && !wrongWay.ready, 'dates that still parse, read the other way: only the totals catch it - and they do');
});

/* ================================================================== *
 * Exports
 * ================================================================== */

test('exports: formula cells defused in the fixed file and the duplicates list (and the report says so); the report is Markdown-safe and masked - counts and totals, never a payee or one row\u2019s amount', () => {
  const text = 'Date,Description,Amount\n2026-01-15,=HYPERLINK("http://evil.example"),-3.40\n2026-01-16,@SUM(A1),1200.00\n2026-01-17,+Plus Parking,-2.00\n2026-01-18,-Minus Market,-2.00\n2026-01-18,-Minus Market,-2.00\n';
  assert.deepStrictEqual(find(diag(text), 'formula').lines, [2, 3, 4, 5, 6], 'named in the diagnosis too');
  assert.strictEqual(find(diag(text), 'formula').examples[0].after, "'=HYPERLINK(\"http://evil.example\")");
  const out = fix(text);
  const rows = out.text.split('\r\n');
  assert.deepStrictEqual(rows.slice(1, 5), ['01/15/2026,"\'=HYPERLINK(""http://evil.example"")",-3.40', "01/16/2026,'@SUM(A1),1200.00", "01/17/2026,'+Plus Parking,-2.00", "01/18/2026,'-Minus Market,-2.00"]);
  assert.strictEqual(out.formulaCount, 5);
  assert.ok(out.fixes.find((x) => x.key === 'formula' && x.required));
  assert.ok(C.duplicatesCsv(out.dups).includes(",'-Minus Market,"));
  const rep = C.report(C.view(C.diagnose(text, { name: 'x*y_[z].csv' })), out, '2026-11-05 10:20');
  assert.ok(rep.includes('Formula safety: 5 text cells began with = + - or @'));
  assert.ok(rep.includes('x\\*y\\_\\[z\\].csv'), 'Markdown escaped');
  const d = C.view(C.diagnose(demoBytes(demo('riverton')), { name: 'riverton.csv' }));
  const fr = fix(demoBytes(demo('riverton')), { currency: 'EUR' });
  const r = C.report(d, fr, '2026-11-05 10:20');
  for (const p of ['Lantern Hill', 'Maple Row', 'Cobble', 'Willowmere', '84.12', '1250.00', '-950']) assert.ok(!r.includes(p), `the report leaks ${p}`);
  for (const p of ['€4,430.85', '€1,796.90', '| Original | 19 |', 'Clean: nothing found that would stop or spoil an import.', 'Blocks import:** Separated by semicolons', 'The fixed file matches the original']) assert.ok(r.includes(p), p);
  assert.ok(!/<|\]\(/.test(r.replace(/\\</g, '')), 'no markup and no link can form');
});

/* ================================================================== *
 * Settings and the AI helper's checks
 * ================================================================== */

test('settings: preferences only - unknown fields, oversize lists and anything that looks like a transaction (amounts, dates, long digit runs, addresses) are refused; merge keeps both sides\u2019 sources', () => {
  const good = { version: 1, profile: 'xero', dateFormats: { xero: 'dmy', qbo3: 'mdy' }, sources: [{ label: 'Riverton checking', order: 'dmy' }, { label: 'Lakeport share draft', order: 'mdy', flip: true }], words: ['saldo final', 'brought fwd'], currency: 'EUR' };
  const c = C.cleanSettings(good, true);
  assert.deepStrictEqual(c.errors, []);
  assert.deepStrictEqual(c.settings, good);
  for (const bad of [
    { rows: [{ amount: '1.00' }] }, { transactions: [] }, { profile: 'quicken' }, { currency: 'XXX' },
    { dateFormats: { generic: 'mdy' } }, { dateFormats: { nope: 'mdy' } },
    { sources: [{ label: 'Checking 4417 1234', order: 'dmy' }] }, { sources: [{ label: 'Rent 1,250.00' }] }, { sources: [{ label: 'Since 03/04/2026' }] }, { sources: [{ label: 'jo' + AT + 'x.example' }] },
    { sources: [{ label: 'Riverton', order: 'ymd' }] }, { sources: [{ label: 'Riverton', payee: 'Lantern Hill' }] }, { sources: [{ label: 'x'.repeat(41) }] }, { sources: [{ label: '<b>x</b>' }] },
    { sources: Array.from({ length: 31 }, (_, i) => ({ label: 'Bank ' + String.fromCharCode(65 + (i % 26)) + i })) },
    { words: ['total 12.50'] }, { words: ['ab'] }, { words: Array.from({ length: 31 }, (_, i) => 'word' + String.fromCharCode(97 + (i % 26)) + 'x') }, { words: ['End ' + RLO + 'here'] },
    { version: 2 }, { updatedAt: -1 }, [],
  ]) assert.ok(C.cleanSettings(bad, true).errors.length, JSON.stringify(bad).slice(0, 80));
  const m = C.mergeSettings({ sources: [{ label: 'Harbour current', order: 'dmy' }, { label: 'Riverton checking', order: 'mdy' }], words: ['saldo final', 'carried fwd'] }, good);
  assert.deepStrictEqual([m.added, m.settings.sources.map((s) => s.label + ':' + s.order)], [2, ['Riverton checking:dmy', 'Lakeport share draft:mdy', 'Harbour current:dmy']], 'this device wins a source both name');
  assert.deepStrictEqual(C.sourceFor(good, 'riverton CHECKING'), { label: 'Riverton checking', order: 'dmy' });
  assert.deepStrictEqual([C.labelFrom('lakeport-cu-export-2026-03.csv'), C.labelFrom('Statement_4417.ofx'), C.labelFrom('12345.csv')], ['lakeport cu', '', '']);
});

test('the AI request: header names and shape codes only; a header with an @, five digits, a date or an amount is sent as "Column N" by the page and refused by the server; the answer is checked', () => {
  const p = C.columnsPayload(['Booking date', 'Payee ' + AT + 'x', 'Acct 12345678', '01.10.2026', '1.250,00', 'Amount'], [['date-dmy'], ['text-short'], ['digits-long'], ['date-dmy'], ['number-comma', 'not-a-code'], ['number-comma']]);
  assert.deepStrictEqual(p, { columns: [{ header: 'Booking date', shape: ['date-dmy'] }, { header: 'Column 2', shape: ['text-short'] }, { header: 'Column 3', shape: ['digits-long'] }, { header: 'Column 4', shape: ['date-dmy'] }, { header: 'Column 5', shape: ['number-comma'] }, { header: 'Amount', shape: ['number-comma'] }] });
  assert.deepStrictEqual(C.columnsRequest(p), { req: p });
  for (const [bad, code] of [
    [{ columns: [{ header: 'Payee ' + AT + 'x', shape: [] }] }, 'value-in-header'], [{ columns: [{ header: 'Ref 12345', shape: [] }] }, 'value-in-header'], [{ columns: [{ header: '01.10.2026', shape: [] }] }, 'value-in-header'], [{ columns: [{ header: '$12', shape: [] }] }, 'value-in-header'],
    [{ columns: [{ header: 'Date', shape: ['date-dmy', 'Lantern Hill'] }] }, 'unknown-shape'], [{ columns: [{ header: 'Date', shape: [], sample: ['01.10.2026'] }] }, 'unknown-field'],
    [{ columns: [{ header: 'Date', shape: [] }], rows: [['01.10.2026']] }, 'unknown-field'], [{ columns: [] }, 'bad-columns'], [{ columns: Array.from({ length: 61 }, () => ({ header: 'A', shape: [] })) }, 'bad-columns'],
    [{ columns: [{ header: 'Date', shape: ['a', 'b', 'c', 'd', 'e', 'f'] }] }, 'bad-shape'], [[], 'unknown-field'], [null, 'unknown-field'],
  ]) assert.strictEqual(C.columnsRequest(bad).code, code, JSON.stringify(bad).slice(0, 80));
  const req = { columns: [{ header: 'a', shape: [] }, { header: 'b', shape: [] }, { header: 'c', shape: [] }, { header: 'd', shape: [] }] };
  const out = C.cleanColumns({ mapping: [{ column: 1, field: 'date', confidence: 'high' }, { column: 1, field: 'description', confidence: 'high' }, { column: 2, field: 'password' }, { column: 9, field: 'payee' }, { column: 3, field: 'amount', confidence: 'certain' }, { column: 4, field: 'debit', confidence: 'high' }, { column: 2, field: 'ignore' }, 'x'], note: '<b>ok</b> https://evil.example/x done' }, req);
  assert.deepStrictEqual(out.map, { date: 0, description: -1, payee: -1, amount: 2, debit: -1, credit: -1, balance: -1, reference: -1, type: -1 });
  assert.deepStrictEqual([out.confidence, out.ignored, out.dropped, out.note], [{ date: 'high', amount: 'low' }, [1], 5, 'ok done']);
  assert.strictEqual(C.cleanColumns({ mapping: [{ column: 1, field: 'ignore' }] }, req), null);
});

/* ================================================================== *
 * Hostile files
 * ================================================================== */

test('hostile files: markup and bidi in payees, a 2 MB cell, 60,000 rows, 300 columns, nothing but quotes, binary junk - read, capped, escaped, and quick', () => {
  const evil = 'Date,Description,Amount\n2026-01-15,<img src=x onerror=alert(1)>' + RLO + 'gnp.exe' + ZWSP + ',-1.00\n2026-01-16,"<script>alert(2)</script>",2.00\n';
  const d = diag(evil);
  assert.ok(d.sampleTx[0].description.startsWith('<img src=x onerror=alert(1)>') && !d.sampleTx[0].description.includes(RLO), 'markup kept as text, bidi gone');
  assert.ok(find(d, 'invisible'));
  const out = fix(evil);
  assert.ok(!out.text.includes(RLO) && !out.text.includes(ZWSP) && out.recheck.clean);
  assert.strictEqual(C.esc(d.sampleTx[1].description), '&lt;script&gt;alert(2)&lt;/script&gt;');
  const t0 = Date.now();
  const big = diag('Date,Description,Amount\n2026-01-15,' + 'x'.repeat(2 * 1024 * 1024) + ',-1.00\n');
  assert.ok(find(big, 'cut') && big.sampleTx[0].description.length <= C.LIMITS.cell);
  const many = ['Date,Description,Amount'];
  for (let i = 0; i < 60000; i++) many.push(`2026-01-${String(1 + (i % 28)).padStart(2, '0')},Row ${i},-1.00`);
  const m = diag(many.join('\n'));
  assert.ok(find(m, 'truncated') && m.totals.rows <= C.LIMITS.rows + 2000 && m.totals.rows >= C.LIMITS.rows, String(m.totals.rows));
  const wide = diag(Array.from({ length: 3 }, (_, r) => Array.from({ length: 300 }, (_, c) => (r ? (c === 0 ? '2026-01-15' : c === 1 ? '-1.00' : 'x') : 'H' + c)).join(',')).join('\n'));
  assert.ok(wide.columns.headers.length <= C.LIMITS.columns);
  assert.doesNotThrow(() => diag('"""""""""""",,,,""\n\n\n"'));
  assert.doesNotThrow(() => diag('<OFX><STMTTRN><STMTTRN><STMTTRN>' + '<NAME>&'.repeat(5000)));
  assert.doesNotThrow(() => diag('!Type:Bank\n' + 'D\nT\n^\n'.repeat(5000)));
  assert.ok(Date.now() - t0 < 15000, `hostile files read in ${Date.now() - t0} ms`);
  const eng = C.createEngine();
  assert.throws(() => eng.load({ id: 'x', bytes: new Uint8Array(C.LIMITS.fileBytes + 1) }), /over 20 MB/);
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
    vm.runInThisContext(fs.readFileSync(path.join(dir, 'feedfix-worker.js'), 'utf8'), { filename: 'feedfix-worker.js' });
  `, { eval: true });
  let seq = 0;
  const waits = {};
  w.on('message', (m) => { const p = waits[m.id]; if (!p) return; delete waits[m.id]; if (m.ok) p.resolve(m.out); else p.reject(new Error(m.error)); });
  return { call: (op, data) => new Promise((resolve, reject) => { const id = ++seq; waits[id] = { resolve, reject }; w.postMessage({ id, op, data }); }), stop: () => w.terminate() };
}

test('the worker reads a File itself, diagnoses, fixes and drops with the same engine; a demo text loads too; a file over 20 MB is refused before it is read', async () => {
  const w = spawnWorker();
  try {
    const f = demo('riverton');
    const d = await w.call('load', { id: 'a', name: f.name, file: new File([demoBytes(f)], f.name) });
    assert.deepStrictEqual([d.verdict.blocks, d.totals.rows, d.decoded.bom], [3, 19, true]);
    const fx = await w.call('fix', { id: 'a', opts: { profile: 'generic' } });
    assert.ok(fx.ready && fx.bytes instanceof Uint8Array && fx.text.startsWith('Date,Description,Payee,Amount,Balance\r\n'));
    const h = demo('harbour');
    const dh = await w.call('load', { id: 'b', name: h.name, text: h.text, encoding: h.encoding, bom: h.bom });
    assert.strictEqual(dh.format, 'ofx');
    assert.strictEqual((await w.call('diagnose', { id: 'a', opts: {} })).totals.rows, 19, 'one file never answers for the other');
    assert.strictEqual(await w.call('drop', { id: 'a' }), true);
    await assert.rejects(w.call('fix', { id: 'a', opts: {} }), /not loaded/);
    await assert.rejects(w.call('load', { id: 'x', file: new File([new Uint8Array(C.LIMITS.fileBytes + 1)], 'huge.csv') }), /over 20 MB/);
    await assert.rejects(w.call('nope', {}), /Unknown step/);
  } finally { w.stop(); }
});

/* ================================================================== *
 * The page's promises
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes; the hero, the mock and the lab card too; 44px targets; nothing scrolls the page sideways', () => {
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
    for (const k of ['blocks', 'wrong', 'info', 'ok']) { ok(k, `${k}-bg`); ok('text', `${k}-bg`); ok('muted', `${k}-bg`); ok(k, 'card'); }
    ok('mark-ink', 'mark-bg'); ok('del-ink', 'del-bg'); ok('add-ink', 'add-bg'); ok('pen', 'card'); ok('link', 'code-bg'); ok('muted', 'code-bg');
    for (const k of ['tone-blocks', 'tone-wrong', 'tone-info', 'tone-ok', 'accent']) ok(k, 'card', 3);
  }
  for (const bg of ['#0f3319', '#1b6b2a', '#6e0e48']) for (const fg of ['#ffffff', '#e9f6ec', '#ffd6ec']) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  for (const [fg, bg] of [['#10351a', '#c9f2d3'], ['#13201a', '#fbfdfb'], ['#4a5b50', '#fbfdfb'], ['#a3123a', '#fde6ec'], ['#8a4100', '#fdeed9'], ['#166534', '#dcf5e3']]) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}`);
  const lab = require('../../../lab').get('feedfix');
  assert.ok(lab && ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const sel of ['.btn', '.link-btn', '.seg button', '.input, textarea.input, select.input', '.check', '.reading', '.fhead', '.target']) assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: (4[4-9]|5\\d|60)px').test(css), `${sel}: 44px`);
  assert.ok(/\.tabbar button \{[^}]*min-height: 60px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/\.out \{[^}]*overflow: auto/.test(css) && /\.ba pre \{[^}]*overflow: auto/.test(css) && /\.totwrap \{[^}]*overflow-x: auto/.test(css) && /\.tablewrap \{[^}]*overflow: auto/.test(css) && /\.sent-pre \{[^}]*overflow: auto/.test(css), 'previews and tables scroll in their own box');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped and opt-in (settings only), no clock or network in the core, every file, typed and model string escaped', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js) && /localStorage\.removeItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/sessionStorage|indexedDB|document\.cookie/.test(js));
  assert.match(js, /function saveSoon\(\) \{ if \(!state\.keep\) return;/, 'nothing is stored unless this device said yes');
  assert.match(js, /store\(\{ v: 1, keep: true, settings: state\.settings, syncBase: state\.syncBase, device: state\.device \}\)/, 'and then only the settings - never a file');
  assert.match(js, /keep: false/);
  assert.match(js, /Intl\.getCanonicalLocales\(navigator\.language \|\| 'en-US'\)\[0\] \|\| 'en-US'; \} catch \(e\) \{ return 'en-US'; \}/, 'a locale Intl refuses (en-US@posix) falls back to en-US');
  assert.ok(!/eval\(|new Function|setTimeout\(['"]/.test(js + read('public/feedfix-core.js') + read('public/feedfix-worker.js') + read('public/demo.js')), 'no eval of any kind');
  assert.match(js, /new Worker\('feedfix-worker\.js'\)/, 'the worker is a same-origin file - the CSP allows it');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/columns', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/me', 'api/settings'].sort(), 'the page asks for nothing else - no route takes a file');
  assert.match(js, /api\('POST', 'api\/ai\/columns', payload\)/, 'the AI call sends the payload shown, and nothing else');
  assert.match(js, /var payload = C\.columnsPayload\(c\.headers, c\.shapes\);/);
  assert.match(js, /api\('PUT', 'api\/settings', \{ settings: settingsBody\(\), base:/, 'sync sends the settings and a base, nothing else');
  const files = ['public/index.html', 'public/app.js', 'public/feedfix-core.js', 'public/demo.js', 'public/feedfix-worker.js', 'server.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/store.js', 'CLAUDE.md', 'test/run.js'];
  for (const f of files) assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read(f)), `no email address in ${f}`);
  for (const f of ['public/feedfix-core.js', 'public/demo.js', 'public/feedfix-worker.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon|indexedDB|WebSocket/.test(src), `${f} touches no network or storage`);
    assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(src), `${f} has no dice and no clock`);
  }
  // Every interpolation of something a file, a person, the server or a model wrote goes through esc().
  const strip = (src) => { let out = ''; let i = 0; const re = /\besc\(/g; let m; while ((m = re.exec(src))) { if (m.index < i) continue; out += src.slice(i, m.index) + 'SAFE'; let depth = 0, j = m.index + m[0].length - 1; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; re.lastIndex = i; } return out + src.slice(i); };
  const risky = strip(js).split('\n').filter((l) => /</.test(l) && !/toast\(|confirm\(|prompt\(|copy\(|download\(|textContent/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(?!SAFE\b|i\b|String\b)([a-zA-Z_$][\w$]*(?:\.[\w$]+|\[[^\]]+\])*)\s*\+/g);
  const allowed = (r) => /\+\s*(syncLine\(\)|lineChips\(f\)|pill|body|btn|html|parts\.join|acctHtml|rows|head|list\.join|items\.join|reading\(|fixed|tail|sevCls|cls|demos|mockHtml|startHtml)/.test(r);
  const bad = (risky || []).filter((r) => !allowed(r));
  assert.deepStrictEqual(bad, [], `unescaped: ${bad}`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bbrief\b|\bsettings\b|\bcolumns\b)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /feedfix-shell-v1/.test(sw) && ['feedfix-core.js', 'feedfix-worker.js', 'demo.js', 'app.js'].every((f) => sw.includes(`'${f}'`)) && /k\.indexOf\('feedfix-'\) === 0/.test(sw), 'the service worker never answers api/ and only clears its own caches');
  assert.match(js, /navigator\.serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
  assert.match(js, /Check your software’s current import guide - these are the common shapes\./);
});

test('the demo is unmistakably made up: no real bank, no real person, said so in the file and on the page', () => {
  const src = read('public/demo.js');
  assert.match(src, /three MADE-UP banks/i);
  const all = src + read('public/app.js') + read('public/index.html');
  const real = ['Chase', 'Wells Fargo', 'Bank of America', 'Citibank', 'Citi ', 'HSBC', 'Barclays', 'Lloyds', 'NatWest', 'Santander', 'Capital One', 'US Bank', 'U.S. Bank', 'PNC', 'Truist', 'TD Bank', 'Royal Bank', 'RBC', 'Scotiabank', 'BMO', 'Westpac', 'ANZ', 'Commonwealth Bank', 'NAB', 'Monzo', 'Revolut', 'Starling', 'Nationwide', 'Halifax', 'ING', 'Deutsche Bank', 'BNP', 'Navy Federal', 'Ally', 'Schwab', 'Fidelity', 'American Express', 'Amex', 'Discover', 'Goldman', 'Morgan Stanley', 'Citizens Bank', 'Fifth Third', 'Regions', 'KeyBank', 'Huntington', 'Bank of Montreal', 'Metro Bank', 'Co-operative Bank', 'First Direct'];
  for (const r of real) assert.ok(!new RegExp('\\b' + r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim() + '\\b').test(all), `a real bank's name: ${r}`);
  assert.deepStrictEqual(D.BANKS, ['Bank of Riverton', 'Lakeport Credit Union', 'Harbour Mutual']);
  assert.ok(read('public/app.js').includes('A <b>made-up</b> file from') && read('public/app.js').includes('Made-up banks, made-up money'));
});

test('the copy: no invisible characters in any source file, no key- or token-shaped strings', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.name === 'node_modules' ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const invisible = new RegExp('[' + [[0, 8], [11, 12], [14, 31], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2069], [0xFEFF, 0xFEFF]].map(([a, b]) => '\\u' + a.toString(16).padStart(4, '0') + '-\\u' + b.toString(16).padStart(4, '0')).join('') + ']');
  for (const f of walk(ROOT).filter((x) => /\.(js|css|html|md|json|svg|webmanifest)$/.test(x) && !/package-lock/.test(x))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!invisible.test(src), `${path.relative(ROOT, f)} carries an invisible character`);
    if (!/lib\/(identity|stripe|byok|webauthn)/.test(f)) assert.ok(!/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}/.test(src), `${path.relative(ROOT, f)} carries a key-shaped string`);
  }
});

test('local-only switches throw on Cloud Run; the lab prefix is read; the store holds one kind of document, read by its id', () => {
  for (const [mod, env] of [['./lib/store', { FEEDFIX_MEMORY: '1' }], ['./lib/fakeai', { FEEDFIX_FAKE_AI: '1' }], ['./server', { FEEDFIX_FAKE_AI: '1', FEEDFIX_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, FEEDFIX_MEMORY: '', FEEDFIX_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, FEEDFIX_MEMORY: '', FEEDFIX_COLLECTION_PREFIX: 'feedfix_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'feedfix_ firestore');
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
const riverCols = () => { const d = diag(demoBytes(demo('riverton'))); return C.columnsPayload(d.columns.headers, d.columns.shapes); };

test('signed out: the page, the worker and the demo work with zero model calls; settings and the AI answer 401 before reading a body; no route takes a file', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.profiles, meta.fields, meta.shapes.length], [C.PROFILE_KEYS, C.FIELDS, Object.keys(C.SHAPES).length]);
  for (const f of ['feedfix-core.js', 'feedfix-worker.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/settings'], ['PUT', '/api/settings'], ['DELETE', '/api/settings'], ['POST', '/api/ai/columns']]) assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : { ok: 1 })).status, 401, `${m} ${p}`);
  for (const [m, p] of [['PUT', '/api/settings'], ['POST', '/api/ai/columns']]) assert.strictEqual((await anon(m, p, BIG)).status, 401, `${p}: the gate answers before the parser, so never 413`);
  for (const p of ['/api/upload', '/api/fix', '/api/diagnose', '/api/convert', '/api/statement', '/api/transactions', '/api/import', '/api/file', '/api/rows', '/api/report']) assert.strictEqual((await anon('POST', p, { rows: [['2026-10-01', 'Lantern Hill', '-84.12']] })).status, 404, `${p}: there is no route that takes a file`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the gates come before each parser, in order; one model call site; Haiku free, Sonnet members via planFor', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/columns', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/settings', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((read('lib/ai.js').match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(ai.SYSTEM, /never an instruction/);
  assert.match(ai.SYSTEM, /You never see a value/);
});

test('settings sync: they follow the account; a stale device gets 409 with the account copy; anything that looks like a transaction is refused; the owner tag holds no id or address', async () => {
  const a = await register('sam.books');
  assert.deepStrictEqual((await a('GET', '/api/settings')).data, { settings: null });
  const good = { version: 1, profile: 'xero', dateFormats: { xero: 'dmy' }, sources: [{ label: 'Riverton checking', order: 'dmy' }], words: ['saldo final'], currency: 'EUR' };
  const put = await a('PUT', '/api/settings', { settings: good, base: null });
  assert.strictEqual(put.status, 200, put.text);
  const v1 = put.data.settings.updatedAt;
  const b = client();
  assert.strictEqual((await b('POST', '/api/auth/login', { email: mail('sam.books'), password: 'a long enough password' })).status, 200);
  assert.strictEqual((await b('GET', '/api/settings')).data.settings.sources[0].label, 'Riverton checking');
  assert.strictEqual((await b('PUT', '/api/settings', { settings: Object.assign({}, good, { profile: 'qbo4' }), base: v1 })).status, 200);
  const stale = await a('PUT', '/api/settings', { settings: good, base: v1 });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.data.settings.profile, 'qbo4', 'the 409 carries the account copy to merge with');
  assert.strictEqual((await a('PUT', '/api/settings', { settings: good, base: null })).status, 409, 'a device that never synced cannot overwrite');
  const cur = (await a('GET', '/api/settings')).data.settings.updatedAt;
  for (const bad of [
    { settings: Object.assign({}, good, { rows: [['2026-10-01', 'Lantern Hill', '-84.12']] }), base: cur },
    { settings: Object.assign({}, good, { sources: [{ label: 'Checking 00008421' }] }), base: cur },
    { settings: Object.assign({}, good, { sources: [{ label: 'Rent 950.00' }] }), base: cur },
    { settings: Object.assign({}, good, { sources: [{ label: 'Riverton', payee: 'Lantern Hill Hardware' }] }), base: cur },
    { settings: Object.assign({}, good, { words: ['01/10/2026'] }), base: cur },
    { settings: Object.assign({}, good, { sources: [{ label: 'sam' + AT + 'x.example' }] }), base: cur },
    { settings: good, base: cur, file: 'Date,Amount' },
    { settings: 'nope', base: cur },
  ]) {
    const r = await a('PUT', '/api/settings', bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 120) + ' ' + r.text);
  }
  assert.strictEqual((await a('GET', '/api/settings')).data.settings.updatedAt, cur, 'nothing was saved');
  const dump = store._dump();
  assert.ok(!dump.includes('sam.books') && !dump.includes(uidOf(mail('sam.books'))), 'filed under an HMAC, never the account id or address');
  assert.ok(!/Lantern Hill|00008421|950\.00|84\.12/.test(dump), 'nothing from a refused body');
  assert.ok(dump.includes(ownerTag(uidOf(mail('sam.books')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  const doc = Object.values(JSON.parse(dump).find(([p]) => p === 'settings')[1]).map(([, d]) => d)[0];
  assert.deepStrictEqual(Object.keys(doc).sort(), ['owner', 'settings', 'updatedAt'], 'the document is the tag, the settings and a time');
  assert.deepStrictEqual(Object.keys(doc.settings).sort(), ['currency', 'dateFormats', 'profile', 'sources', 'version', 'words']);
  const other = await register('kim.other');
  assert.deepStrictEqual((await other('GET', '/api/settings')).data, { settings: null }, 'another account sees nothing of it');
  assert.strictEqual((await a('DELETE', '/api/settings')).status, 200);
  assert.deepStrictEqual((await b('GET', '/api/settings')).data, { settings: null });
});

test('help me read these columns over HTTP: names and shapes only; a value in the request is refused with no model call; the model saw no value; its answer is checked', async () => {
  const ana = await register('ana.columns');
  const calls = await modelCalls();
  for (const bad of [{}, { columns: [{ header: 'Payee ' + AT + 'x', shape: [] }] }, { columns: [{ header: 'Acct 00008421', shape: [] }] }, { columns: [{ header: '01.10.2026', shape: [] }] }, { columns: [{ header: 'Date', shape: ['Lantern Hill'] }] }, { columns: [{ header: 'Date', shape: [], values: ['01.10.2026'] }] }, { columns: [{ header: 'Date', shape: [] }], rows: [] }, []]) {
    const r = await ana('POST', '/api/ai/columns', bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 80) + ' ' + r.text);
  }
  assert.strictEqual((await ana('POST', '/api/ai/columns', { columns: [{ header: 'Ref 12345', shape: [] }] })).data.code, 'value-in-header');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const n0 = fakeClient.calls.length;
  const payload = riverCols();
  const r = await ana('POST', '/api/ai/columns', payload);
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const sent = fakeClient.calls[n0];
  assert.strictEqual(sent.model, 'claude-haiku-4-5');
  assert.deepStrictEqual(sent.tool_choice, { type: 'tool', name: 'read_columns' });
  const userText = sent.messages[0].content[0].text;
  assert.match(userText, /<<<COLUMNS\n1\. "Booking date" - date-like, day first; every value different\n[\s\S]*\nCOLUMNS>>>/, 'the names are fenced as untrusted');
  const riv = demo('riverton').text;
  for (const v of ['Lantern', 'Maple Row', '84,12', '1.250,00', '01.10.2026', '4417', 'Riverton']) assert.ok(!JSON.stringify(sent).includes(v), `the model saw ${v}`);
  assert.ok(riv.includes('Lantern'));
  assert.deepStrictEqual(r.data.columns.map, { date: 0, description: 3, payee: 2, amount: 4, debit: -1, credit: -1, balance: 5, reference: -1, type: -1 });
  assert.deepStrictEqual(r.data.columns.ignored, [1]);
  assert.ok(!store._dump().includes('Booking date'), 'nothing stored');
  fakeClient.mode = 'inject';
  const inj = await ana('POST', '/api/ai/columns', payload);
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<b>|<img|onerror|evil|hunter2|password|\u202e/i.test(inj.text), inj.text.slice(0, 400));
  assert.deepStrictEqual(inj.data.columns.map, { date: 0, description: -1, payee: -1, amount: 2, debit: -1, credit: -1, balance: -1, reference: -1, type: -1 }, 'one column each, real columns only, never Amount with Debit');
  assert.ok(inj.data.columns.dropped >= 6);
  fakeClient.mode = 'blank';
  assert.strictEqual((await ana('POST', '/api/ai/columns', payload)).status, 422);
  fakeClient.mode = 'maxtokens';
  assert.match((await ana('POST', '/api/ai/columns', payload)).data.error, /ran long/);
  fakeClient.mode = 'upstream401';
  const up = await ana('POST', '/api/ai/columns', payload);
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  fakeClient.mode = 'upstream529';
  const busy = await ana('POST', '/api/ai/columns', payload);
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('the gates: unconfirmed free account 403, out of credit 402, the day\u2019s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register('eve.unconfirmed');
  const body = { columns: [{ header: 'Date', shape: ['date-iso'] }] };
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/ai/columns', body);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/feedfix/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
    assert.strictEqual((await eve('POST', '/api/ai/columns', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ai/columns', body)).status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/columns', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-feedfix-${day}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/columns', body);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/columns', BIG)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-feedfix-${day}`); }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/feedfix', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/feedfix`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
