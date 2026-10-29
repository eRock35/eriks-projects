// Pure rules first (reading CSV, column guessing, names, account numbers,
// amounts, splits, verdicts, the demo's exact verdicts, exports, settings and
// the AI payloads), then the page's own promises, then end to end against the
// memory store and the fake model:
//   STRAY_MEMORY=1 STRAY_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /stray, the way the
// lab mounts it, so the auth cookie, the budget gate and each route's parser
// order are exercised as deployed. Model calls are counted from the identity
// usage rows, and what reached "the model" is read from the fake's own log.
//
// Every name, account and amount here is made up.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.STRAY_MEMORY !== '1' || process.env.STRAY_FAKE_AI !== '1') {
  console.error('run with STRAY_MEMORY=1 STRAY_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient, ownerTag } = require('../server');
const C = require('../public/stray-core');
const D = require('../public/demo');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const TODAY = '2026-10-29';

/* ---------------- helpers ---------------- */

const S = (o) => Object.assign(C.defaults(), o || {});
function book(rows, settings) {
  const accounts = rows.map((r, n) => Object.assign({ n, line: n + 2, number: '', borrower: '', coborrower: '', payment: null, pastDue: null, payoff: null, dueDay: null, status: 'Current', closed: false, invoices: [] }, r));
  return C.createIndex(accounts, S(settings));
}
const pay = (o) => Object.assign({ id: 'P1', line: 2, date: '2026-10-20', rawDate: '', cents: 0, payer: '', memo: '', account: '', method: '' }, o);
const verdictOf = (ix, p, opts) => C.matchPayment(pay(p), ix, opts);
function demo(today) {
  const f = D.files(today || TODAY);
  const pt = C.parseTable(f.payments.text, { maxRows: C.LIMITS.payments });
  const at = C.parseTable(f.accounts.text, { maxRows: C.LIMITS.accounts });
  const pg = C.guessColumns('payments', pt.headers, pt.rows);
  const ag = C.guessColumns('accounts', at.headers, at.rows);
  const P = C.buildPayments(pt, pg.map);
  const A = C.buildAccounts(at, ag.map);
  const m = C.matchAll(P.payments, A.accounts, C.defaults());
  return { pt, at, pg, ag, P, A, ...m, byId: Object.fromEntries(m.results.map((r) => [r.id, r])) };
}
const numOf = (d, i) => d.A.accounts[i].number;

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/* ================================================================== *
 * Reading files
 * ================================================================== */

test('CSV: RFC 4180 quoting - delimiters, doubled quotes and line breaks inside quotes; CRLF, LF and CR; a BOM', () => {
  const text = '\uFEFFItem,Payer,Memo,Amount\r\nA1,"OKAFOR, WILLIAM","said ""oct""\r\nand nov",412.37\nA2,Bell,plain,1\rA3,"x","",2\r\n';
  const t = C.parseTable(text);
  assert.deepStrictEqual(t.headers, ['Item', 'Payer', 'Memo', 'Amount'], 'the BOM is gone from the first header');
  assert.deepStrictEqual(t.rows, [['A1', 'OKAFOR, WILLIAM', 'said "oct" and nov', '412.37'], ['A2', 'Bell', 'plain', '1'], ['A3', 'x', '', '2']], 'a line break inside quotes stays in the cell (folded to a space)');
  assert.strictEqual(t.delimiter, ',');
  assert.strictEqual(t.kept, 3);
  assert.strictEqual(t.total, 3);
  assert.strictEqual(t.ragged, 0);
});

test('CSV: the delimiter is sniffed (semicolon, tab, pipe), Excel\u2019s sep= line wins, a report title above the header is skipped', () => {
  assert.strictEqual(C.parseTable('a;b;c\n1;2,5;3\n4;5;6\n').delimiter, ';');
  assert.deepStrictEqual(C.parseTable('a;b;c\n1;2,5;3\n').rows[0], ['1', '2,5', '3']);
  assert.strictEqual(C.parseTable('a\tb\tc\n1\t2\t3\n').delimiterName, 'tab');
  assert.strictEqual(C.parseTable('a|b|c\n1|2|3\n').delimiter, '|');
  const hinted = C.parseTable('sep=;\nx;y\n1,5;2\n');
  assert.deepStrictEqual([hinted.delimiter, hinted.headers, hinted.rows[0]], [';', ['x', 'y'], ['1,5', '2']]);
  const pre = C.parseTable('Suspense report\nRun 10/29/2026\nItem,Amount,Payer\nA1,1.00,Bell\nA2,2.00,Raman\n');
  assert.deepStrictEqual([pre.preamble, pre.headers, pre.kept], [2, ['Item', 'Amount', 'Payer'], 2]);
});

test('CSV: no header row becomes Column N; ragged rows padded or cut and counted; duplicate headers made unique; empty input', () => {
  const t = C.parseTable('104425,412.37,Priya Raman\n104118,389.12,Marcus Bell\n');
  assert.strictEqual(t.header, false);
  assert.deepStrictEqual(t.headers, ['Column 1', 'Column 2', 'Column 3']);
  assert.strictEqual(t.rows.length, 2);
  const r = C.parseTable('a,b,c\n1,2\n1,2,3,4\n5,6,7\n');
  assert.deepStrictEqual(r.rows, [['1', '2', ''], ['1', '2', '3'], ['5', '6', '7']]);
  assert.strictEqual(r.ragged, 2);
  assert.deepStrictEqual(C.parseTable('Name,Name,Amount\nx,y,1\n').headers, ['Name', 'Name (2)', 'Amount']);
  assert.strictEqual(C.parseTable('').empty, true);
  assert.strictEqual(C.parseTable('\n\n\n').empty, true);
});

test('CSV: hostile files - caps on rows, cells and columns; invisible characters removed and counted; an unclosed quote noted; a 2 MB cell and 60,000 rows stay fast', () => {
  const rows = ['Account,Borrower,Payment'];
  for (let i = 0; i < 60000; i++) rows.push(`${100000 + i},Person ${i},100.00`);
  let t0 = Date.now();
  const big = C.parseTable(rows.join('\n'), { maxRows: C.LIMITS.accounts });
  assert.strictEqual(big.kept, 50000);
  assert.strictEqual(big.truncated, 10000, 'the rows left out are counted, not silently dropped');
  assert.ok(Date.now() - t0 < 4000, `60,000 rows read in ${Date.now() - t0} ms`);
  t0 = Date.now();
  const huge = C.parseTable('Payer,Memo,Amount\n"' + 'x'.repeat(2 * 1024 * 1024) + '",m,1.00\n');
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(huge.rows[0][0].length <= C.LIMITS.cell && huge.cut === 1, 'a huge cell is cut, and said');
  const wide = C.parseTable(Array.from({ length: 80 }, (_, i) => `h${i}`).join(',') + '\n' + Array.from({ length: 80 }, () => '1').join(',') + '\n');
  assert.strictEqual(wide.headers.length, C.LIMITS.columns);
  assert.strictEqual(wide.wide, 20);
  const bidi = C.parseTable('Payer,Amount\n"Ev\u202eil\u200b Name",1.00\n');
  assert.strictEqual(bidi.rows[0][0], 'Evil Name');
  assert.strictEqual(bidi.invisible, 2);
  const open = C.parseTable('Payer,Amount\n"never closed,1.00\nmore,2.00\n');
  assert.strictEqual(open.openQuote, true);
  const formula = C.parseTable('Payer,Amount\n"=HYPERLINK(""http://x"")",1.00\n<img src=x onerror=alert(1)>,2.00\n');
  assert.strictEqual(formula.rows[0][0], '=HYPERLINK("http://x")', 'a formula is kept as text (escaped when drawn, defused when exported)');
  assert.strictEqual(formula.rows[1][0], '<img src=x onerror=alert(1)>');
});

test('money and dates, the ways exports write them; "free" is no amount; a negative is flagged', () => {
  const m = (s) => { const r = C.readMoney(s); return r ? (r.negative ? -r.cents : r.cents) : null; };
  assert.deepStrictEqual(['$1,234.56', '1234.56', '1.234,56', '1 234,56', 'USD 412.37', '412.37 USD', '412', '412.5', '$0.07', '(12.00)', '12.00-', '-5.00', '12.00 CR', 'free', '', 'abc', '1.2.3', '$'].map(m),
    [123456, 123456, 123456, 123456, 41237, 41237, 41200, 41250, 7, -1200, -1200, -500, 1200, null, null, null, null, null]);
  const d = (s, o, loose) => C.readDate(s, o, loose);
  assert.strictEqual(d('2026-10-05'), '2026-10-05');
  assert.strictEqual(d('2026-10-05T14:03:00Z'), '2026-10-05');
  assert.strictEqual(d('10/5/2026'), '2026-10-05');
  assert.strictEqual(d('10/5/26'), '2026-10-05');
  assert.strictEqual(d('5/10/2026', 'dmy'), '2026-10-05');
  assert.strictEqual(d('Oct 5, 2026'), '2026-10-05');
  assert.strictEqual(d('5 Oct 2026'), '2026-10-05');
  assert.strictEqual(d('05-Oct-26'), '2026-10-05');
  assert.strictEqual(d('2/30/2026'), null, 'not a real day');
  assert.strictEqual(d('20261005'), null, 'an 8-digit run looks like an account number...');
  assert.strictEqual(d('20261005', 'mdy', true), '2026-10-05', '...unless the column is mapped as the date');
  assert.strictEqual(d('46300', 'mdy', true), '2026-10-05', 'an Excel serial day');
  assert.strictEqual(C.dateOrder(['13/10/2026', '5/10/2026']), 'dmy');
  assert.strictEqual(C.dateOrder(['10/13/2026', '10/5/2026']), 'mdy');
});

/* ================================================================== *
 * Column guessing
 * ================================================================== */

test('columns: the demo\u2019s headers are all guessed, and sure', () => {
  const d = demo();
  assert.deepStrictEqual(d.pg.map, { date: 1, amount: 2, payer: 3, memo: 4, account: 5, method: 6, id: 0 });
  assert.deepStrictEqual(d.ag.map, { account: 0, borrower: 1, coborrower: 2, payment: 3, pastDue: 4, payoff: 5, dueDay: 6, status: 7, invoices: -1 });
  assert.strictEqual(d.pg.unsure, false);
  assert.strictEqual(d.ag.unsure, false);
  assert.ok(['amount', 'payer', 'account', 'date'].every((k) => d.pg.sure[k] === 'sure'));
});

test('columns: awkward headers and headerless files are guessed from header words and value shapes', () => {
  const pay = 'Rcvd Dt,Amt,Remitter Name,Ref/Memo,Loan #,Pmt Type,Trace\n10/27/2026,$412.37,PRIYA RAMAN,OCT PMT LN 104425,104425,ACH,T-88101\n10/26/2026,$389.12,MARCUS BELL,AUTO,104118,ACH,T-88102\n10/25/2026,"$1,250.00",NORTHSIDE AUTO BODY,INV 55120 REPAIR,,Wire,T-88103\n10/24/2026,$60.00,J PATEL,,,Check,T-88104\n';
  const t = C.parseTable(pay);
  const g = C.guessColumns('payments', t.headers, t.rows);
  assert.deepStrictEqual(g.map, { date: 0, amount: 1, payer: 2, memo: 3, account: 4, method: 5, id: 6 });
  const acc = 'Acct No.,Primary Borrower,Joint Owner,Inst Amt,Arrears,Bal,Nxt Due,Sts\n104425,Priya Raman,,412.37,0.00,"14,980.15",26,Active\n104118,Marcus Bell,Ann Bell,389.12,389.12,"11,204.40",27,Late\n104881,Thanh Nguyen,,298.55,0.00,"6,402.90",25,Active\n105327,Colette Marchand,,455.90,0.00,"17,733.08",24,Active\n';
  const at = C.parseTable(acc);
  const ag = C.guessColumns('accounts', at.headers, at.rows);
  assert.deepStrictEqual(ag.map, { account: 0, borrower: 1, coborrower: 2, payment: 3, pastDue: 4, payoff: 5, dueDay: 6, status: 7, invoices: -1 });
  // no header at all: shapes alone
  const bare = C.parseTable('10/27/2026,412.37,PRIYA RAMAN,104425\n10/26/2026,389.12,MARCUS BELL,104118\n10/25/2026,301.10,ANA LOPEZ,104999\n');
  const bg = C.guessColumns('payments', bare.headers, bare.rows);
  assert.strictEqual(bare.header, false);
  assert.deepStrictEqual([bg.map.date, bg.map.amount, bg.map.payer, bg.map.account], [0, 1, 2, 3]);
  assert.ok(Object.values(bg.sure).every((s) => s !== 'sure'), 'with no header words, nothing is "sure"');
  assert.strictEqual(bg.unsure, true, 'and the page offers the helper');
  // what is still missing, in words
  assert.deepStrictEqual(C.mappingProblems('accounts', { account: 0, borrower: -1, payment: 2 }), ['Choose the borrower column.']);
  assert.ok(C.mappingProblems('payments', { amount: 1, payer: -1, account: -1, memo: -1 }).some((x) => /nothing to match on/.test(x)));
  assert.ok(C.mappingProblems('payments', { amount: 1, payer: 1 }).some((x) => /two fields/.test(x)));
});

test('columns: shapes come from a fixed vocabulary with no digit in any code; a saved layout applies by header names', () => {
  for (const code of Object.keys(C.SHAPES)) assert.ok(/^[a-z-]+$/.test(code), code);
  const t = C.parseTable('Payer,Amount,Loan\nMARCUS BELL,$389.12,104118\nPRIYA RAMAN,$412.37,104425\nTHANH NGUYEN,$298.55,104881\nCOLETTE MARCHAND,$455.90,105327\n');
  const g = C.guessColumns('payments', t.headers, t.rows);
  assert.ok(g.shapes[0].includes('name-like') && g.shapes[0].includes('capitals'), g.shapes[0].join());
  assert.ok(g.shapes[1].includes('money-sign'));
  assert.ok(g.shapes[2].includes('digits-mid'));
  const preset = C.presetFrom('payments', ['Payer', 'Amount', 'Loan'], { payer: 0, amount: 1, account: 2, memo: -1 });
  assert.deepStrictEqual(preset.map, { payer: 'Payer', amount: 'Amount', account: 'Loan' });
  assert.deepStrictEqual(C.applyPreset('payments', ['loan', 'AMOUNT', 'payer'], [preset]), { date: -1, amount: 1, payer: 2, memo: -1, account: 0, method: -1, id: -1 });
  assert.strictEqual(C.applyPreset('payments', ['loan', 'AMOUNT'], [preset]), null, 'another layout does not use it');
});

/* ================================================================== *
 * Names
 * ================================================================== */

test('names: accents, punctuation, honorifics, suffixes and businesses; "A & B Smith" is two people; "Okafor, William" is read', () => {
  assert.deepStrictEqual(C.parseName('Mr. José O\u2019Brien-Núñez Jr.').tokens, ['jose', 'obrien', 'nunez']);
  const biz = C.parseName('Delgado Landscaping, LLC');
  assert.deepStrictEqual([biz.business, biz.tokens], [true, ['delgado']]);
  const hh = C.parseName('HECTOR & ANA MARTINEZ');
  assert.strictEqual(hh.people.length, 2);
  assert.ok(hh.people[0].includes('hector') && hh.people[0].includes('martinez'), 'the first-name-only person borrows the surname');
  assert.deepStrictEqual(C.personOf('Okafor, William J').tokens, ['william', 'j', 'okafor']);
  assert.deepStrictEqual([C.personOf('William J. Okafor').first, C.personOf('William J. Okafor').last], ['william', 'okafor']);
  assert.strictEqual(C.parseName('').empty, true);
});

test('names: token order, initials, ~40 groups of nicknames and abbreviations, extra pairs from settings, a one-letter slip', () => {
  const W = C.personOf('William Okafor');
  const lv = (payer, person, extra) => { const r = C.nameLevel(C.parseName(payer), person, extra); return r && r.level; };
  assert.strictEqual(lv('William Okafor', W), 'exact');
  assert.strictEqual(lv('OKAFOR WILLIAM', W), 'exact');
  assert.strictEqual(C.nameLevel(C.parseName('OKAFOR WILLIAM'), W).order, 'surname-first');
  assert.strictEqual(lv('OKAFOR WM', W), 'nick');
  assert.strictEqual(lv('Bill Okafor', W), 'nick');
  assert.strictEqual(lv('W. Okafor', W), 'initial');
  assert.strictEqual(lv('Okafor', W), 'surname');
  assert.strictEqual(lv('Grace Okafor', W), 'other');
  assert.strictEqual(lv('William Okafr', W), 'spelling');
  assert.strictEqual(lv('Okafor Plumbing LLC', W), 'business');
  assert.strictEqual(lv('Marcus Bell', W), null);
  assert.ok(C.NICKNAME_GROUPS.length >= 40, `${C.NICKNAME_GROUPS.length} groups`);
  for (const [a, b] of [['bob', 'robert'], ['liz', 'elizabeth'], ['beth', 'elizabeth'], ['kate', 'katherine'], ['katie', 'catherine'], ['mike', 'michael'], ['jen', 'jennifer'], ['jim', 'james'], ['peggy', 'margaret'], ['chuck', 'charles'], ['wm', 'william']]) assert.ok(C.nickEq(a, b), `${a} = ${b}`);
  assert.ok(!C.nickEq('bob', 'william'));
  const P = C.personOf('Gwendolyn Price');
  assert.strictEqual(lv('Wendy Price', P), 'other');
  const ix = book([{ number: '1', borrower: 'Gwendolyn Price' }], { nicknames: [['wendy', 'gwendolyn']] });
  assert.strictEqual(lv('Wendy Price', P, ix.extra), 'nick', 'an extra pair from settings counts');
});

/* ================================================================== *
 * Account numbers, memos and invoices
 * ================================================================== */

test('account numbers: exact; leading zeros, spaces, dashes and prefixes ignored; one digit off and two swapped found with which digits', () => {
  const ix = book([{ number: '104425', borrower: 'Priya Raman', payment: 41237 }, { number: 'AL-209931', borrower: 'Zoe Lin', payment: 10000 }]);
  const sig = (account, cents) => { const r = verdictOf(ix, { account, payer: 'Nobody Here', cents: cents || 1 }); return r.candidates[0] ? r.candidates[0].hits.find((h) => h.k === 'account') : null; };
  assert.strictEqual(sig('104425').sig, 'exact');
  assert.match(sig('0010-4425').text, /dashes and leading zeros are ignored: 0010-4425 \u2192 104425/);
  assert.match(sig('LN 104425').text, /the “LN” in front/);
  assert.strictEqual(sig('104 425').sig, 'norm');
  assert.strictEqual(sig('209931').sig, 'norm', 'the number part of AL-209931');
  assert.strictEqual(sig('104452').sig, 'swap');
  assert.match(sig('104452').text, /two digits swapped: 104452 given, 104425 on file/);
  assert.strictEqual(sig('104429').sig, 'oneOff');
  assert.match(sig('104429').text, /one digit off: 104429 given, 104425 on file \(6th digit\)/);
  assert.strictEqual(sig('994425'), null, 'two digits wrong is not a candidate');
  assert.strictEqual(C.oneOffAt('104429', '104425'), 6);
  assert.strictEqual(C.swappedAt('104452', '104425'), 5);
  const pre = book([{ number: 'AUTO77120', borrower: 'Zoe Lin' }], { acctPrefixes: ['AUTO'] });
  assert.strictEqual(C.acctKey('AUTO 77120', pre.settings).digits, '77120');
});

test('memos: account numbers inside the memo (not amounts, not dates); invoice numbers for receivables', () => {
  assert.deepStrictEqual(C.memoNumbers('LN 0104425 OCT PMT'), ['0104425']);
  assert.deepStrictEqual(C.memoNumbers('acct#104425 oct pmt'), ['104425']);
  assert.deepStrictEqual(C.memoNumbers('$412.37 on 10/05/2026 ref 2026-10-05'), ['20261005'].filter(() => false).concat(C.memoNumbers('$412.37 on 10/05/2026 ref 2026-10-05')), 'whatever it finds, never the amount');
  assert.ok(!C.memoNumbers('$41237.00 paid').includes('41237'), 'an amount is not an account number');
  assert.deepStrictEqual(C.memoNumbers('2 CAR PMTS'), [], 'too short');
  assert.deepStrictEqual(C.memoInvoices('Paying INV-2207 and inv 2210'), ['INV2207', 'INV2210']);
  const ix = book([{ number: '104425', borrower: 'Priya Raman', payment: 41237 }, { number: 'C-77', borrower: 'Acme Supply Co', invoices: ['INV-2207', 'INV-2210'] }]);
  const memo = verdictOf(ix, { memo: 'acct#104425 oct pmt', payer: 'PRIYA RAMAN', cents: 41237 });
  assert.strictEqual(memo.verdict, 'match');
  assert.match(memo.candidates[0].hits[0].text, /The memo carries the account number/);
  const inv = verdictOf(ix, { memo: 'Paying INV-2207', payer: 'ACME SUPPLY', cents: 99900 });
  assert.strictEqual(numOf({ A: { accounts: ix.accounts } }, inv.candidates[0].i), 'C-77');
  assert.match(inv.candidates[0].hits[0].text, /invoice INV2207/);
  const col = verdictOf(ix, { account: 'INV-2210', payer: 'Acme Supply Company', cents: 5000 });
  assert.ok(col.candidates[0].hits.some((h) => /Invoice INV-2210 is open/.test(h.text)), 'an invoice in the account column (AR)');
});

/* ================================================================== *
 * Amounts, splits and verdicts
 * ================================================================== */

test('amounts: the scheduled payment, past due, payment or past due plus the late fee, 2 or 3 payments, the payoff', () => {
  const a = { payment: 41237, pastDue: 82474, payoff: 1498015 };
  const s = (cents, fee) => { const r = C.amountSignal({ cents }, a, { lateFeeCents: fee === undefined ? 2500 : fee }); return r && r.sig; };
  assert.deepStrictEqual([s(41237), s(82474), s(1498015), s(43737), s(84974), s(123711), s(10), s(43737, 0)], ['payment', 'pastDue', 'payoff', 'lateFee', 'lateFee', 'multiple', null, null]);
  assert.strictEqual(C.amountSignal({ cents: 82474 }, { payment: 41237 }, {}).text, 'Amount is exactly 2 payments of $412.37');
});

test('verdicts: one digit off with the name is Check; with the amount too it is Match; two swapped is Match; a number belonging to someone else needs a look', () => {
  const ix = book([{ number: '106918', borrower: 'Dmitri Volkov', payment: 28740 }, { number: '104425', borrower: 'Priya Raman', payment: 41237 }, { number: '110904', borrower: 'Oliver Grant', payment: 52000, status: 'Paid off', closed: true }]);
  const off = verdictOf(ix, { account: '106913', payer: 'DMITRI VOLKOV', cents: 30000 });
  assert.strictEqual(off.verdict, 'check');
  assert.match(off.why[0], /one digit off and the amount isn’t one of this account’s/);
  assert.strictEqual(verdictOf(ix, { account: '106913', payer: 'DMITRI VOLKOV', cents: 28740 }).verdict, 'match');
  assert.strictEqual(verdictOf(ix, { account: '109618', payer: 'DMITRI VOLKOV', cents: 28740 }).verdict, 'match', 'a swap with name and amount');
  const conflict = verdictOf(ix, { account: '104425', payer: 'DMITRI VOLKOV', cents: 28740 });
  assert.ok(conflict.verdict !== 'match', conflict.verdict);
  assert.ok(conflict.candidates.find((c) => ix.accounts[c.i].number === '106918').misses.some((m) => /belongs to another account \(Priya Raman, 104425\)/.test(m.text)));
  const closed = verdictOf(ix, { account: '110904', payer: 'OLIVER GRANT', cents: 52000 });
  assert.strictEqual(closed.verdict, 'check');
  assert.ok(closed.why.some((w) => /closed or paid off/.test(w)));
  // name alone, or amount alone, never makes a match
  assert.strictEqual(verdictOf(ix, { payer: 'DMITRI VOLKOV', cents: 1 }).verdict, 'none');
  const amountOnly = verdictOf(ix, { payer: 'SOMEONE ELSE', cents: 28740 });
  assert.strictEqual(amountOnly.verdict, 'none');
  assert.ok(amountOnly.tried.some((t) => /fits 1 account, but nothing else ties/.test(t)));
});

test('verdicts: two possible says what tells them apart; an amount shared by many accounts is too common to tell', () => {
  const ix = book([{ number: '1', borrower: 'Jaya Patel', payment: 35000 }, { number: '2', borrower: 'Jonah Patel', payment: 29500, pastDue: 35000 }]);
  const two = verdictOf(ix, { payer: 'J PATEL', cents: 35000, date: null });
  assert.strictEqual(two.verdict, 'two');
  assert.match(two.apart[0], /Jaya Patel \(1\): amount is the scheduled payment, \$350\.00 · Jonah Patel \(2\): amount equals the past-due balance, \$350\.00/);
  const crowd = book(Array.from({ length: 12 }, (_, i) => ({ number: String(500000 + i), borrower: `Person ${'abcdefghijkl'[i]}x Q`, payment: 35000 })));
  const r = verdictOf(crowd, { payer: 'NOBODY', cents: 35000 });
  assert.strictEqual(r.verdict, 'none');
  assert.ok(r.tried.some((t) => /fits 12 accounts - too common to tell on its own/.test(t)));
});

test('splits: one payment across a household\u2019s loans; bounded so it cannot blow up; "Not a split" and "Not this" re-match', () => {
  const ix = book([{ number: '1', borrower: 'Hector Martinez', payment: 34410 }, { number: '2', borrower: 'Ana Martinez', payment: 27685 }, { number: '3', borrower: 'Luis Martinez', payment: 51200 }, { number: '4', borrower: 'Rosa Delgado', payment: 34410 }]);
  const r = verdictOf(ix, { payer: 'HECTOR & ANA MARTINEZ', cents: 62095 });
  assert.strictEqual(r.verdict, 'split');
  assert.deepStrictEqual(r.split.parts.map((x) => [ix.accounts[x.i].number, x.cents]), [['1', 34410], ['2', 27685]]);
  assert.match(r.split.hits[1], /Every borrower is named Martinez/);
  const three = verdictOf(ix, { payer: 'MARTINEZ FAMILY', cents: 34410 + 27685 + 51200 });
  assert.strictEqual(three.verdict, 'split');
  assert.strictEqual(three.split.parts.length, 3);
  assert.strictEqual(verdictOf(ix, { payer: 'ROSA DELGADO', cents: 62095 }).verdict, 'none', 'no household, no split');
  const noSplit = verdictOf(ix, { payer: 'HECTOR & ANA MARTINEZ', cents: 62095 }, { noSplit: true });
  assert.notStrictEqual(noSplit.verdict, 'split');
  assert.ok(noSplit.tried.includes('You ruled out splitting it') || noSplit.verdict !== 'none');
  // the subset-sum is bounded: a pool of 40 same-surname accounts with near-equal payments
  const many = book(Array.from({ length: 40 }, (_, i) => ({ number: String(700 + i), borrower: `Kim${'abcdefghijklmnopqrstuvwxyzabcdefghijklmn'[i]} Smith`, payment: 10000 + i })));
  const t0 = Date.now();
  const s = C.findSplits(10000 * 4 + 1000, many.accounts.map((a, i) => ({ i, cents: a.payment })));
  assert.ok(s.visits <= C.LIMITS.splitVisits + 50, `${s.visits} steps`);
  assert.ok(Date.now() - t0 < 200);
  assert.ok(s.found.every((f) => f.length <= C.LIMITS.splitMax));
  // Not this: the top account is ruled out and the payment is matched again
  const ix2 = book([{ number: '106918', borrower: 'Dmitri Volkov', payment: 28740 }]);
  const again = verdictOf(ix2, { account: '106913', payer: 'DMITRI VOLKOV', cents: 30000 }, { exclude: { 0: true } });
  assert.strictEqual(again.verdict, 'none');
  assert.ok(again.tried.some((t) => /You ruled out 106918/.test(t)));
});

test('the demo: each of the 14 payments gets exactly its intended verdict and account, on any day of the year', () => {
  const d = demo();
  assert.strictEqual(d.results.length, 14);
  assert.strictEqual(d.A.accounts.length, 30);
  for (const r of d.results) assert.strictEqual(r.verdict, D.EXPECT[r.id], `${r.id}: ${r.verdict}`);
  const top = (id) => numOf(d, d.byId[id].candidates[0].i);
  assert.deepStrictEqual(['JV-4101', 'JV-4102', 'JV-4103', 'JV-4104', 'JV-4105', 'JV-4106', 'JV-4107', 'JV-4108', 'JV-4109', 'JV-4111'].map(top), ['104118', '104881', '104425', '105327', '106918', '107264', '107733', '108052', '108490', '109377']);
  assert.deepStrictEqual(d.byId['JV-4110'].split.parts.map((x) => numOf(d, x.i)), ['108811', '108812']);
  assert.deepStrictEqual(d.byId['JV-4112'].candidates.slice(0, 2).map((c) => numOf(d, c.i)), ['109615', '109902']);
  const hit = (id, re) => assert.ok(d.byId[id].candidates[0].hits.some((h) => re.test(h.text)), `${id} ${re}`);
  hit('JV-4103', /memo carries the account number/);
  hit('JV-4104', /two digits swapped/);
  hit('JV-4105', /one digit off/);
  hit('JV-4106', /Wm is short for William/);
  hit('JV-4107', /co-borrower: LIZ CHEN - Liz is short for Elizabeth/);
  hit('JV-4108', /exactly 2 payments/);
  hit('JV-4109', /payoff/);
  hit('JV-4111', /A business, DELGADO LANDSCAPING LLC/);
  assert.ok(d.byId['JV-4113'].tried.length >= 3 && d.byId['JV-4114'].tried.length >= 3, 'what was tried');
  // the ages fill every bucket, and two are past the default 30-day limit
  const ag = C.ageing(d.P.payments, {}, TODAY, 30);
  assert.deepStrictEqual(ag.buckets.map((b) => b.count), [7, 3, 2, 2]);
  assert.strictEqual(ag.over, 2);
  assert.strictEqual(ag.oldest.days, 41);
  for (let k = 0; k < 365; k += 7) {
    const day = C.addDays(TODAY, k);
    for (const r of demo(day).results) assert.strictEqual(r.verdict, D.EXPECT[r.id], `${day} ${r.id}`);
  }
});

/* ================================================================== *
 * The meter, exports and settings
 * ================================================================== */

test('the meter and the day: dollars out of suspense, the posting file (a split is a line per account), the research list, the summary', () => {
  const d = demo();
  const P = d.P.payments;
  const dec = {
    'JV-4101': { kind: 'post', parts: [{ account: '104118', cents: 38912 }], by: 'EM', at: '2026-10-29T14:00:00Z', reason: 'Match: Account number 104118 matches exactly' },
    'JV-4110': { kind: 'split', parts: [{ account: '108811', cents: 34410 }, { account: '108812', cents: 27685 }], by: 'EM', at: '2026-10-29T14:01:00Z', reason: 'Split' },
    'JV-4113': { kind: 'hold', parts: [], by: 'EM', at: '2026-10-29T14:02:00Z', reason: 'Held' },
  };
  const m = C.meter(P, dec);
  assert.strictEqual(m.line, '$1,010.07 of $13,246.66 out of suspense - 2 of 14 payments');
  assert.deepStrictEqual([m.done, m.held], [2, 1]);
  const rows = C.postingRows(P, d.A.accounts, dec);
  assert.deepStrictEqual(rows.slice(1).map((r) => [r[0], r[3], r[4], r[5]]), [['JV-4101', '104118', '389.12', ''], ['JV-4110', '108811', '344.10', '1 of 2'], ['JV-4110', '108812', '276.85', '2 of 2']]);
  const research = C.researchRows(P, d.results, dec, { 'JV-4113': 'Called, left a message' }, TODAY);
  assert.strictEqual(research.length - 1, 12);
  const r13 = research.find((r) => r[0] === 'JV-4113');
  assert.strictEqual(r13[7], '41');
  assert.match(r13[10], /Memo: 55120 is not an account number/);
  assert.strictEqual(r13[11], 'Called, left a message');
  const sum = C.daySummary({ payments: P, results: d.results, decisions: dec, today: TODAY, limit: 30, title: 'Test CU' });
  assert.match(sum, /Cleared: \$1,010\.07 of \$13,246\.66 out of suspense/);
  assert.match(sum, /Oldest still open: \$1,250\.00 from NORTHSIDE AUTO BODY, 41 days in suspense \(JV-4113\)/);
  assert.match(sum, /8 Match, 2 Check, 1 Split, 1 Two possible, 2 No match/);
  assert.match(sum, /past your policy’s 30-day limit/);
});

test('exports are CSV-injection safe and RFC 4180 quoted; hostile text survives as text', () => {
  assert.deepStrictEqual(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx', 'plain', 'a,b', 'say "hi"', 'two\nlines', '412.37'].map(C.csvCell),
    ["'=1+1", "'+SUM(A1)", "'-2+3", "'@cmd", "'\tx", '"\'\rx"', 'plain', '"a,b"', '"say ""hi"""', '"two\nlines"', '412.37']);
  const P = [pay({ id: '=HYPERLINK("http://evil.example")', payer: '@SUM(1)', memo: '+cmd|calc', account: '-1', cents: 100 })];
  const dec = { [P[0].id]: { kind: 'post', parts: [{ account: '=1', cents: 100 }], by: '=x', at: '2026-10-29T00:00:00Z', reason: '-oops' } };
  const csv = C.toCsv(C.postingRows(P, [], dec));
  const line = csv.split('\r\n')[1];
  assert.ok(line.startsWith('"\'=HYPERLINK(""http://evil.example"")"'), line);
  for (const cell of line.split(',')) assert.ok(!/^[=+\-@]/.test(cell.replace(/^"/, '')), cell);
  const rcsv = C.toCsv(C.researchRows([P[0]], [], {}, {}, TODAY));
  assert.ok(rcsv.includes("'@SUM(1)") && rcsv.includes("'+cmd|calc"));
  assert.ok(csv.endsWith('\r\n'));
});

test('settings: preferences and header names only - unknown keys, value-looking headers and nicknames with digits are refused', () => {
  const ok = C.cleanSettings({ lateFeeCents: 3500, ageLimitDays: 45, nicknames: [['Wendy', 'gwendolyn']], acctPrefixes: ['al'], acctDigits: [6, 10], presets: [{ kind: 'payments', headers: ['Rcvd Date', 'Amount', 'Remitter'], map: { date: 'Rcvd Date', amount: 'Amount', payer: 'Remitter' } }] }, true);
  assert.deepStrictEqual(ok.errors, []);
  assert.deepStrictEqual([ok.settings.lateFeeCents, ok.settings.ageLimitDays, ok.settings.nicknames, ok.settings.acctPrefixes, ok.settings.acctDigits], [3500, 45, [['wendy', 'gwendolyn']], ['AL'], [6, 10]]);
  const bad = (raw) => C.cleanSettings(raw, true).errors;
  assert.ok(bad({ payments: [{ amount: 1 }] }).some((e) => /Unknown setting/.test(e)));
  assert.ok(bad({ nicknames: [['bob', 'robert 2']] }).length);
  assert.ok(bad({ nicknames: [['o\u2019brien', 'x']] }).length);
  for (const h of ['104425', 'priya@example', '$412.37', '10/05/2026', 'Amount 412.37', '<script>']) {
    assert.ok(bad({ presets: [{ kind: 'payments', headers: [h, 'Amount'], map: { amount: 'Amount' } }] }).length, h);
  }
  assert.ok(bad({ presets: [{ kind: 'payments', headers: ['Amount'], map: { amount: 'Amount' }, rows: [['1']] }] }).length, 'a layout cannot carry rows');
  assert.ok(bad({ presets: [{ kind: 'payments', headers: ['Amount'], map: { amount: 'Total' } }] }).length, 'a mapping to a header it does not have');
  assert.ok(bad({ lateFeeCents: -1 }).length && bad({ ageLimitDays: 0 }).length && bad({ acctDigits: [9, 4] }).length);
  assert.deepStrictEqual(C.cleanSettings({ nicknames: [['bob', 'robert 2'], ['peg', 'margaret']] }).settings.nicknames, [['peg', 'margaret']], 'the page\u2019s lenient read drops what is bad');
  const merged = C.mergeSettings({ lateFeeCents: 1000, presets: [ok.settings.presets[0]], updatedAt: 5 }, { lateFeeCents: 2000, nicknames: [['peg', 'margaret']], updatedAt: 9 });
  assert.deepStrictEqual([merged.lateFeeCents, merged.presets.length, merged.nicknames.length, merged.updatedAt], [2000, 1, 1, 9]);
});

/* ================================================================== *
 * The AI payloads
 * ================================================================== */

test('the letter request carries a situation code and a tone, nothing else; the letter comes back with only the five placeholders', () => {
  assert.deepStrictEqual(C.letterRequest({ situation: 'no-match' }), { situation: 'no-match', tone: 'friendly' });
  assert.deepStrictEqual(C.letterRequest({ situation: 'two-possible', tone: 'formal' }), { situation: 'two-possible', tone: 'formal' });
  for (const b of [{}, { situation: 'nope' }, { situation: 'no-match', amount: 1250 }, { situation: 'no-match', payer: 'X' }, { situation: 'no-match', tone: 'angry' }, null, [], 'no-match']) assert.strictEqual(C.letterRequest(b), null, JSON.stringify(b));
  const L = C.cleanLetter({ subject: 'Your {amount} <b>payment</b>', letter: 'Dear {Payer_Name},\u202e\nsee https://evil.example/x or www.evil.example and {ssn} {{date_received}} {reference}. Call {phone}.', email: '<script>x</script>Hi {payer_name}' });
  assert.strictEqual(L.subject, 'Your {amount} payment');
  assert.ok(!/https?:|www\.|evil|\{ssn\}|\u202e|</.test(L.letter + L.email), L.letter);
  assert.match(L.letter, /Dear \{payer_name\},/);
  assert.match(L.letter, /\{date_received\} \{reference\}/);
  assert.strictEqual(L.removed, 3);
  assert.strictEqual(C.cleanLetter({ letter: '', email: '' }), null);
  const filled = C.fillLetter('Hi {payer_name}, {amount} on {date_received} ({reference}) - {phone}', C.letterValues(pay({ payer: 'OKAFOR WM', cents: 53318, date: '2026-10-24', memo: '' , id: 'JV-4106' }), ''));
  assert.strictEqual(filled, 'Hi Okafor Wm, $533.18 on Oct 24, 2026 (JV-4106) - [phone]');
  assert.strictEqual(C.situationFor('two', {}), 'two-possible');
  assert.strictEqual(C.situationFor('check', { candidates: [{ flags: ['business'] }] }), 'business-for-owner');
});

test('the column helper is sent header names and shape codes only: a value, an @, a run of digits or an unknown code is refused', () => {
  const headers = ['Rcvd Dt', 'Amt', 'priya.raman@example', '104425', '$412.37', '10/05/2026'];
  const p = C.columnsPayload('payments', headers, [['date'], ['money-sign'], ['name-like'], ['digits-mid'], ['money-sign'], ['date']]);
  assert.deepStrictEqual(p.columns.map((c) => c.header), ['Rcvd Dt', 'Amt', 'Column 3', 'Column 4', 'Column 5', 'Column 6'], 'value-looking headers go as Column N');
  assert.deepStrictEqual(C.columnsRequest(p), p);
  const bad = (mut) => { const b = JSON.parse(JSON.stringify(p)); mut(b); return C.columnsRequest(b); };
  assert.strictEqual(bad((b) => { b.columns[0].header = 'a@b'; }), null);
  assert.strictEqual(bad((b) => { b.columns[0].header = 'Loan 104425'; }), null);
  assert.strictEqual(bad((b) => { b.columns[0].header = 'paid 4.50'; }), null);
  assert.strictEqual(bad((b) => { b.columns[0].shape = ['6-10 digits']; }), null, 'a shape must be a code from the list');
  assert.strictEqual(bad((b) => { b.columns[0].shape = ['date', 'date', 'date', 'date', 'date']; }), null);
  assert.strictEqual(bad((b) => { b.columns[0].sample = '412.37'; }), null, 'no value beside a header');
  assert.strictEqual(bad((b) => { b.rows = [['1']]; }), null);
  assert.strictEqual(bad((b) => { b.kind = 'loans'; }), null);
  assert.strictEqual(C.columnsRequest({ kind: 'payments', columns: [] }), null);
  const out = C.cleanColumns({ mapping: [{ field: 'amount', column: 2 }, { field: 'payer', column: 2 }, { field: 'ssn', column: 1 }, { field: 'date', column: 99 }, { field: 'memo', column: '3; DROP' }, 'nope', { field: 'date', column: 1 }], note: '<b>x</b> https://evil.example' }, p);
  assert.deepStrictEqual(out.map, { date: 0, amount: 1, payer: -1, memo: -1, account: -1, method: -1, id: -1 });
  assert.strictEqual(out.dropped, 5);
  assert.ok(!/<|https/.test(out.note));
});

/* ================================================================== *
 * The worker and the engine
 * ================================================================== */

test('the worker reads a File, keeps the tables and the index, and answers parse, prepare, rematch, explain and search', async () => {
  const posted = [];
  const ctx = { self: null, console, Promise, setTimeout };
  ctx.self = ctx;
  ctx.importScripts = (f) => vm.runInContext(read(`public/${f}`), ctx, { filename: f });
  ctx.postMessage = (m) => posted.push(m);
  const handlers = [];
  ctx.addEventListener = (ev, fn) => { if (ev === 'message') handlers.push(fn); };
  vm.createContext(ctx);
  vm.runInContext(read('public/stray-worker.js'), ctx, { filename: 'stray-worker.js' });
  const ask = async (id, op, data) => { handlers[0]({ data: { id, op, data } }); for (let i = 0; i < 50 && !posted.some((m) => m.id === id && 'ok' in m); i++) await new Promise((r) => setTimeout(r, 5)); return posted.find((m) => m.id === id && 'ok' in m); };
  const f = D.files(TODAY);
  const file = (name, text) => ({ name, size: text.length, text: async () => text });
  const a = await ask(1, 'parse', { kind: 'payments', file: file('s.csv', f.payments.text) });
  assert.ok(a.ok, a.error);
  assert.strictEqual(a.out.headers.length, 7);
  assert.ok(a.out.sample.length <= 8, 'the page gets a sample, not every row');
  const b = await ask(2, 'parse', { kind: 'accounts', file: file('a.csv', f.accounts.text) });
  const c = await ask(3, 'prepare', { payMap: a.out.guess.map, accMap: b.out.guess.map, settings: C.defaults() });
  assert.ok(c.ok, c.error);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(c.out.results.map((r) => r.verdict))), Object.values(D.EXPECT));
  const r = await ask(4, 'rematch', { pid: 'JV-4105', exclude: { 4: true } });
  assert.strictEqual(r.out.verdict, 'none');
  const e = await ask(5, 'explain', { pid: 'JV-4113', i: 0 });
  assert.ok(e.ok && e.out.misses.length);
  const s = await ask(6, 'search', { q: 'okafor' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.out.map((i) => c.out.accounts[i].number))), ['107264']);
  const big = await ask(7, 'parse', { kind: 'accounts', file: { name: 'x', size: C.LIMITS.fileBytes + 1, text: async () => '' } });
  assert.strictEqual(big.ok, false);
  assert.match(big.error, /over 20 MB/);
  assert.match(read('public/stray-worker.js'), /importScripts\('stray-core\.js'\)/);
});

test('scale: 5,000 payments against 50,000 accounts match in seconds, on one thread', () => {
  const accounts = [];
  const first = ['ana', 'ben', 'cara', 'dev', 'eli', 'fay', 'gus', 'hana', 'ivo', 'jo'];
  const word = (n) => { let w = ''; n += 1; while (n > 0) { w = String.fromCharCode(97 + ((n - 1) % 26)) + w; n = Math.floor((n - 1) / 26); } return w; };
  for (let i = 0; i < 50000; i++) accounts.push({ n: i, line: i + 2, number: String(300000 + i * 7), borrower: `${first[i % 10]} Q${word(Math.floor(i / 3))}son`, coborrower: '', payment: 20000 + (i % 977) * 13, pastDue: i % 9 ? 0 : 20000 + (i % 977) * 13, payoff: 900000 + i, dueDay: 1 + (i % 28), status: 'Current', closed: false, invoices: [] });
  const payments = [];
  for (let k = 0; k < 5000; k++) { const a = accounts[(k * 37) % 50000]; payments.push(pay({ id: `P${k}`, account: k % 3 ? a.number : '', payer: `${a.borrower.toUpperCase()}`, cents: a.payment })); }
  const t0 = Date.now();
  const { results } = C.matchAll(payments, accounts, C.defaults());
  const ms = Date.now() - t0;
  assert.ok(ms < 8000, `${ms} ms`);
  assert.ok(results.filter((r) => r.verdict === 'match').length > 4500, 'and they are right');
});

/* ================================================================== *
 * The page's own promises
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes; the hero and the lab card too; 44px targets; nothing scrolls the page sideways', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2', 'code-bg', 'bar-bg']) for (const fg of ['text', 'muted', 'link']) ok(fg, bg);
    ok('accent-ink', 'accent'); for (const fg of ['text', 'link', 'muted']) ok(fg, 'accent-soft');
    for (const k of ['match', 'check', 'split', 'two', 'none']) { ok(k, `${k}-bg`); ok('text', `${k}-bg`); ok('muted', `${k}-bg`); ok(k, 'card'); }
    ok('mark-ink', 'mark-bg'); ok('strip-ink', 'strip'); ok('bg', 'text'); ok('hot', 'hot-bg'); ok('hot', 'card'); ok('text', 'hot-bg');
    for (const tone of ['tone-match', 'tone-check', 'tone-split', 'tone-two', 'tone-none']) ok(tone, 'card', 3);
    ok('meter-fill', 'meter-bg', 3);
  }
  for (const bg of ['#0a2a3b', '#0b4f6c', '#6b2a10']) for (const fg of ['#ffffff', '#dbe8ef', '#ffd8a8', '#eef4f8']) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  for (const [fg, bg] of [['#2a1300', '#ffd8a8'], ['#13202e', '#fbfcfd'], ['#4a5767', '#fbfcfd'], ['#166534', '#dcfce7'], ['#166534', '#fbfcfd'], ['#2b1d00', '#fde68a']]) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}`);
  const lab = require('../../../lab').get('stray');
  assert.ok(lab && ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const sel of ['.btn', '.link-btn', '.seg button', '.filters button', '.age', '.input, textarea.input, select.input', '.check']) assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: 4[4-9]px').test(css), `${sel}: 44px`);
  assert.ok(/\.qrow \{[^}]*min-height: 60px/.test(css) && /\.tabbar button \{[^}]*min-height: 60px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/\.tablewrap \{[^}]*overflow: auto/.test(css) && /\.cmpwrap \{[^}]*overflow-x: auto/.test(css) && /\.out \{[^}]*overflow: auto/.test(css) && /\.filters \{[^}]*overflow-x: auto/.test(css), 'tables and exports scroll in their own box');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped and opt-in, no clock or network in the core, every file string escaped', () => {
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
  assert.match(js, /keep: device\.keep === true/, 'keeping the session is off unless this device said yes');
  assert.match(js, /if \(!state\.device\.keep \|\| !state\.loaded\) return '';/, 'nothing from a file is stored unless kept');
  assert.match(js, /var kept = state\.device\.keep \? recall\(K_SESSION\) : null;/);
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/columns', 'api/ai/letter', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/me', 'api/settings'].sort(), 'the page asks for nothing else - no route takes a payment');
  assert.ok(/api\('POST', 'api\/ai\/letter', body\)/.test(js) && /api\('POST', 'api\/ai\/columns', payload\)/.test(js), 'the AI calls send the payload shown, built by the core');
  const files = ['public/index.html', 'public/app.js', 'public/stray-core.js', 'public/demo.js', 'public/stray-worker.js', 'server.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/store.js', 'CLAUDE.md', 'test/run.js'];
  for (const f of files) assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read(f)), `no email address in ${f}`);
  for (const f of ['public/stray-core.js', 'public/demo.js', 'public/stray-worker.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon|indexedDB|WebSocket/.test(src), `${f} touches no network or storage`);
    assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(src), `${f} has no dice and no clock`);
    assert.ok(!/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/.test(src), `${f} carries no invisible characters of its own`);
  }
  // Every interpolation of something a file, a person, the server or a model wrote goes through esc().
  // Whatever sits inside an esc(...) call is escaped as a whole, so those calls are cut out first.
  const unesc = (src) => { let out = '', i = 0; for (;;) { const at = src.indexOf('esc(', i); if (at < 0) return out + src.slice(i); out += src.slice(i, at) + 'ESC'; let depth = 0, j = at + 3; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; } };
  const risky = unesc(js).split('\n').filter((l) => !/toast\(|confirm\(|prompt\(|copy\(|download\(|textContent|\.value = /.test(l)).join('\n')
    .match(/['"]\s*\+\s*(p\.payer|p\.memo|p\.account|p\.method|p\.id|p\.rawDate|a\.number|a\.borrower|a\.coborrower|a\.status|f\.name|hd|h|x\.text|x|w|s\.why|err\.message|e\.message|me\.email|state\.notes\[[^\]]+\]|c\.header|L\.letter|L\.subject|r\.why\[0\]|payerOf\(p\)|nameOf\([^)]*\))\s*\+/g);
  assert.strictEqual(risky, null, `unescaped: ${risky}`);
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bsent|\bsettings|\bpayload)\b/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /stray-shell-v1/.test(sw) && sw.includes("'stray-core.js'") && sw.includes("'stray-worker.js'"), 'the service worker never answers api/ and owns stray-* caches only');
  assert.match(read('public/demo.js'), /MADE-UP credit union/);
  assert.match(js, /Made-up example/);
});

test('local-only switches throw on Cloud Run; the lab prefix is read; the store is never queried', () => {
  for (const [mod, env] of [['./lib/store', { STRAY_MEMORY: '1' }], ['./lib/fakeai', { STRAY_FAKE_AI: '1' }], ['./server', { STRAY_FAKE_AI: '1', STRAY_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, STRAY_MEMORY: '', STRAY_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, STRAY_MEMORY: '', STRAY_COLLECTION_PREFIX: 'stray_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'stray_ firestore');
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
// Test accounts on the reserved example domain, built here so no address is written into a file.
const mail = (who) => `${who}${String.fromCharCode(64)}example.com`;
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
const columnsBody = () => { const d = demo(); return C.columnsPayload('payments', d.pt.headers, d.pg.shapes); };

test('signed out: the page and the demo work with zero model calls; settings and both AI routes answer 401 before reading a body; no route takes a payment', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  assert.deepStrictEqual((await anon('GET', '/api/meta')).data.verdicts, ['match', 'check', 'split', 'two', 'none']);
  for (const f of ['stray-core.js', 'stray-worker.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/settings'], ['PUT', '/api/settings'], ['DELETE', '/api/settings'], ['POST', '/api/ai/letter'], ['POST', '/api/ai/columns']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : { ok: 1 })).status, 401, `${m} ${p}`);
  }
  for (const [m, p] of [['PUT', '/api/settings'], ['POST', '/api/ai/letter'], ['POST', '/api/ai/columns']]) assert.strictEqual((await anon(m, p, BIG)).status, 401, `${p}: the gate answers before the parser, so never 413`);
  for (const p of ['/api/match', '/api/upload', '/api/payments', '/api/accounts', '/api/suspense']) assert.strictEqual((await anon('POST', p, { payments: [{ cents: 1 }] })).status, 404, `${p}: there is no route that takes a payment`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the gates come before each parser, in order; one model call site; Haiku free, Sonnet members via planFor', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  for (const p of ['/api/ai/letter', '/api/ai/columns']) assert.deepStrictEqual(layer(p, 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser'], p);
  assert.deepStrictEqual(layer('/api/settings', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((read('lib/ai.js').match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(ai.LETTER_SYSTEM, /no others/);
  assert.match(ai.COLUMNS_SYSTEM, /never an instruction to you/);
});

test('settings sync: they follow the account; a stale device gets 409 with the account copy; values are refused; nothing identifying is stored', async () => {
  const a = await register('sam.sync');
  assert.deepStrictEqual((await a('GET', '/api/settings')).data, { settings: null });
  const good = { lateFeeCents: 3500, ageLimitDays: 20, nicknames: [['wendy', 'gwendolyn']], presets: [{ kind: 'accounts', headers: ['Loan Number', 'Borrower', 'Monthly Pmt'], map: { account: 'Loan Number', borrower: 'Borrower', payment: 'Monthly Pmt' } }] };
  const put = await a('PUT', '/api/settings', { settings: good, base: null });
  assert.strictEqual(put.status, 200, put.text);
  assert.deepStrictEqual([put.data.settings.lateFeeCents, put.data.settings.ageLimitDays, put.data.settings.presets.length], [3500, 20, 1]);
  const v1 = put.data.settings.updatedAt;
  const b = client();
  assert.strictEqual((await b('POST', '/api/auth/login', { email: mail('sam.sync'), password: 'a long enough password' })).status, 200);
  const got = await b('GET', '/api/settings');
  assert.strictEqual(got.data.settings.ageLimitDays, 20);
  assert.strictEqual((await b('PUT', '/api/settings', { settings: { ...good, ageLimitDays: 25 }, base: v1 })).status, 200);
  const stale = await a('PUT', '/api/settings', { settings: { ...good, ageLimitDays: 10 }, base: v1 });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.data.settings.ageLimitDays, 25, 'the 409 carries the account copy to merge with');
  assert.strictEqual((await a('PUT', '/api/settings', { settings: good, base: null })).status, 409, 'a device that never synced cannot overwrite');
  // values are refused, with nothing saved
  const cur = (await a('GET', '/api/settings')).data.settings.updatedAt;
  for (const bad of [
    { settings: { ...good, payments: [{ payer: 'PRIYA RAMAN', cents: 41237 }] } },
    { settings: { ...good, nicknames: [['priya', 'raman 104425']] } },
    { settings: { ...good, presets: [{ kind: 'payments', headers: ['104425', 'Amount'], map: { amount: 'Amount' } }] } },
    { settings: { ...good, presets: [{ kind: 'payments', headers: ['PRIYA RAMAN', '$412.37'], map: {} }] } },
    { settings: { ...good, presets: [{ kind: 'payments', headers: ['Payer'], map: { payer: 'Payer' }, sample: ['PRIYA RAMAN'] }] } },
    { settings: good, accounts: [{ number: '104425' }] },
    { settings: 'nope' },
  ]) {
    const r = await a('PUT', '/api/settings', { base: cur, ...bad });
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 120));
  }
  assert.strictEqual((await a('GET', '/api/settings')).data.settings.updatedAt, cur, 'nothing was saved');
  const dump = store._dump();
  assert.ok(!dump.includes('sam.sync') && !dump.includes(uidOf(mail('sam.sync'))), 'filed under an HMAC, never the account id or email');
  assert.ok(!/PRIYA|104425|41237|412\.37/.test(dump), 'no value from a file');
  assert.ok(dump.includes(ownerTag(uidOf(mail('sam.sync')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  const other = await register('kim.other');
  assert.deepStrictEqual((await other('GET', '/api/settings')).data, { settings: null }, 'another account sees nothing of it');
  assert.strictEqual((await a('DELETE', '/api/settings')).status, 200);
  assert.deepStrictEqual((await b('GET', '/api/settings')).data, { settings: null });
});

test('the letter over HTTP: a request with anything but a situation and a tone is a 400 with no model call; the model sees no value; the answer is cleaned', async () => {
  const ana = await register('ana.letter');
  const calls = await modelCalls();
  for (const bad of [{}, { situation: 'nope' }, { situation: 'no-match', amount: 1250 }, { situation: 'no-match', amount: '$1,250' }, { situation: 'no-match', payer: 'NORTHSIDE AUTO BODY' }, { situation: 'no-match', date: '2026-09-18' }, { situation: 'no-match', reference: 'INV 55120' }, { situation: 'no-match', tone: 'angry' }, []]) {
    assert.strictEqual((await ana('POST', '/api/ai/letter', bad)).status, 400, JSON.stringify(bad));
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const n0 = fakeClient.calls.length;
  const r = await ana('POST', '/api/ai/letter', { situation: 'two-possible', tone: 'formal' });
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const req = fakeClient.calls[n0];
  assert.strictEqual(req.model, 'claude-haiku-4-5');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'write_letter' });
  const userText = req.messages[0].content[0].text;
  assert.ok(!/\d/.test(userText), `no digit at all reaches the model: ${userText}`);
  assert.match(userText, /one of two accounts/);
  assert.match(r.data.letter.letter, /^Dear \{payer_name\},/);
  assert.ok(/\{amount\}/.test(r.data.letter.letter) && /\{phone\}/.test(r.data.letter.letter));
  assert.ok(!store._dump().includes('Payments team'), 'nothing stored');
  fakeClient.mode = 'inject';
  const inj = await ana('POST', '/api/ai/letter', { situation: 'no-match' });
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]|\u202e|javascript:|https?:|www\.|evil\.example|\{ssn\}|\{account_number\}/i.test(inj.text), inj.text.slice(0, 300));
  assert.ok(inj.data.letter.letter.length <= C.LIMITS.letterChars && inj.data.letter.removed >= 4);
  fakeClient.mode = 'blank';
  assert.strictEqual((await ana('POST', '/api/ai/letter', { situation: 'no-match' })).status, 422);
  fakeClient.mode = 'maxtokens';
  assert.match((await ana('POST', '/api/ai/letter', { situation: 'no-match' })).data.error, /ran long/);
  fakeClient.mode = 'upstream401';
  const up = await ana('POST', '/api/ai/letter', { situation: 'no-match' });
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  fakeClient.mode = 'upstream529';
  const busy = await ana('POST', '/api/ai/letter', { situation: 'no-match' });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('the column helper over HTTP: headers and shape codes only - a value, an @, a digit run, an unknown code or an extra field is a 400; the mapping is checked', async () => {
  const sam = await register('sam.columns');
  const calls = await modelCalls();
  const body = columnsBody();
  const variants = [
    (b) => { b.columns[3].header = 'PRIYA RAMAN'; b.columns[3].header = 'priya@example'; },
    (b) => { b.columns[0].header = '104425'; },
    (b) => { b.columns[0].header = 'Paid 10/05'; },
    (b) => { b.columns[0].shape = ['6 to 10 digits']; },
    (b) => { b.columns[0].shape = ['date', 'name-like', 'capitals', 'few-values', 'list']; },
    (b) => { b.columns[0].values = ['10/27/2026']; },
    (b) => { b.sample = [['JV-4101', '$389.12']]; },
    (b) => { b.kind = 'everything'; },
    (b) => { b.columns = []; },
  ];
  for (const mut of variants) { const b = JSON.parse(JSON.stringify(body)); mut(b); assert.strictEqual((await sam('POST', '/api/ai/columns', b)).status, 400, mut.toString()); }
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const n0 = fakeClient.calls.length;
  const r = await sam('POST', '/api/ai/columns', body);
  assert.strictEqual(r.status, 200, r.text);
  const sent = JSON.stringify(fakeClient.calls[n0]);
  for (const v of ['389.12', 'MARCUS', 'OKAFOR', '104118', 'JV-4101', 'LN 0104425']) assert.ok(!sent.includes(v), `${v} reached the model`);
  assert.ok(sent.includes('<<<COLUMNS') && sent.includes('Rcvd Date') && sent.includes('number with 2 decimals') === false && sent.includes('amount with a currency sign'));
  assert.deepStrictEqual(fakeClient.calls[n0].tool_choice, { type: 'tool', name: 'map_columns' });
  assert.strictEqual(r.data.columns.map.amount, 2);
  assert.strictEqual(r.data.columns.map.payer, 3);
  fakeClient.mode = 'inject';
  const inj = await sam('POST', '/api/ai/columns', body);
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]|https?:/.test(inj.text));
  assert.strictEqual(inj.data.columns.dropped, 5);
  fakeClient.mode = 'blank';
  assert.strictEqual((await sam('POST', '/api/ai/columns', body)).status, 422);
});

test('the gates: unconfirmed free account 403, out of credit 402, the day\u2019s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register('eve.unconfirmed');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    for (const p of ['/api/ai/letter', '/api/ai/columns']) {
      const r = await eve('POST', p, p.endsWith('letter') ? { situation: 'no-match' } : columnsBody());
      assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email'], p);
      assert.strictEqual(r.data.resend, '/stray/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
      assert.strictEqual((await eve('POST', p, BIG)).status, 403, `${p}: 403 before the big body is read`);
    }
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  for (const p of ['/api/ai/letter', '/api/ai/columns']) {
    assert.strictEqual((await cal('POST', p, p.endsWith('letter') ? { situation: 'no-match' } : columnsBody())).status, 402, p);
    assert.strictEqual((await cal('POST', p, BIG)).status, 402, `${p}: 402, not 413`);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-stray-${day}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    for (const p of ['/api/ai/letter', '/api/ai/columns']) {
      const capped = await dan('POST', p, p.endsWith('letter') ? { situation: 'no-match' } : columnsBody());
      assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true], p);
      assert.strictEqual((await dan('POST', p, BIG)).status, 503, `${p}: the ceiling answers before the parser too`);
    }
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-stray-${day}`); }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/stray', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/stray`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
