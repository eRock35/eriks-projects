// Pure rules first, then end to end against the memory store and the fake
// model:
//   DRIP_MEMORY=1 DRIP_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /drip, the way the
// lab mounts it, so the auth cookie, the budget gate, the big-body route and
// the saved list are exercised as deployed. Model calls are counted from the
// identity's usage rows - the same rows that bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.DRIP_MEMORY !== '1' || process.env.DRIP_FAKE_AI !== '1') {
  console.error('run with DRIP_MEMORY=1 DRIP_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const C = require('../public/drip-core');
const S = require('../public/sample');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const FIX = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const TODAY = '2026-10-01';

let base;
let ipSeq = 10;
const freshIp = () => `203.0.113.${ipSeq++}`;
function client(ip) {
  const cookies = {};
  const addr = ip || freshIp();
  const call = async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) { data = { text }; }
    return { status: res.status, data, text, headers: res.headers };
  };
  call.cookies = cookies;
  return call;
}

const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const MARK = 'SCREENSHOTBYTESMARKER';
const png = (s = '') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(MARK + s), Buffer.alloc(2000, 7)]).toString('base64');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** Transactions from compact rows: [date, cents, desc]. */
const txs = (rows) => rows.map(([date, cents, desc]) => ({ date, cents, desc }));
/** n monthly charges from `start`, `jitter(i)` days late. */
function monthly(desc, start, n, cents, jitter) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([C.addDays(C.addMonths(start, i), jitter ? jitter(i) : 0), typeof cents === 'function' ? cents(i) : cents, desc]);
  return out;
}
const find = (rows, today = TODAY) => C.findRecurring(txs(rows), { today }).drips;
const byName = (drips, name) => drips.find((d) => d.name === name);

/* ---------------- pure: money and dates ---------------- */

test('money is read from its digits: separators, signs, symbols; words are no figure', () => {
  const signed = { '-17.99': -1799, '17.99': 1799, '$1,234.56': 123456, '(12.00)': -1200, '12.00-': -1200, '"-1,234.56"': null, '-1,234.56': -123456, '£7.99': 799, '(£12.00)': -1200, '12,50': 1250, '-1.234,56': -123456, '€ 3': 300, 'USD 12': 1200, '1.005': 101, '.5': 50, '$-4.00': -400, '0.00': 0 };
  for (const [v, want] of Object.entries(signed)) assert.strictEqual(C.signedCents(v), want, v);
  for (const bad of ['free', '', 'twelve', '$', '1e5', 'nine ninety-nine', null, undefined, {}, NaN, Infinity, '1234567890.00', '12a.00']) assert.strictEqual(C.signedCents(bad), null, String(bad));
  assert.strictEqual(C.toCents('-5.00'), null, 'a typed price is never negative');
  assert.strictEqual(C.toCents('$9.99/month'), 999);
  assert.strictEqual(C.toCents(0.1 + 0.2), 30, 'a float is read through its digits');
  assert.strictEqual(C.toCents('999999999'), null, 'over $10,000 a charge is no price');
  assert.deepStrictEqual([C.money(123456), C.money(-200), C.money(261591, { whole: true }), C.money(799, { currency: 'GBP' })], ['$1,234.56', '−$2.00', '$2,616', '£7.99']);
});

test('dates: every format a bank writes, day-first only when the file says so, month ends held', () => {
  const cases = [['2026-09-12', '2026-09-12'], ['09/12/2026', '2026-09-12'], ['9/2/26', '2026-09-02'], ['12.09.2026', '2026-09-12'], ['20260912', '2026-09-12'], ['Sep 12, 2026', '2026-09-12'], ['12 Sep 2026', '2026-09-12'], ['12-Sep-26', '2026-09-12'], ['September 12 2026', '2026-09-12'], ['2026-09-12T10:00:00Z', '2026-09-12']];
  for (const [v, want] of cases) assert.strictEqual(C.parseDate(v), want, v);
  assert.strictEqual(C.parseDate('03/09/2026', true), '2026-09-03');
  for (const bad of ['13/45/2026', '2026-02-30', 'not a date', '', 'Smarch 3, 2026']) assert.strictEqual(C.parseDate(bad), null, bad);
  assert.deepStrictEqual([C.addMonths('2026-01-31', 1), C.addMonths('2026-03-31', -1), C.addMonths('2026-11-15', 3), C.addMonths('2024-02-29', 12)], ['2026-02-28', '2026-02-28', '2027-02-15', '2025-02-28']);
});

/* ---------------- pure: reading statements ---------------- */

const DIALECTS = {
  'chase-card.csv': { n: 9, skipped: { payments: 1, refunds: 1, interest: 1 }, drips: ['Netflix', 'Spotify'] },
  'capital-one.csv': { n: 5, skipped: { payments: 1, moneyIn: 1 }, drips: ['Planet Fitness'] },
  'amex.csv': { n: 6, skipped: { payments: 1 }, drips: ['Platinum Annual Membership Fee', 'Hulu'] },
  'bofa-checking.csv': { n: 4, skipped: { payments: 1, transfers: 2, interest: 1, moneyIn: 1, unreadable: 1 }, drips: ['Verizon'] },
  'wells-fargo.csv': { n: 4, skipped: { transfers: 1, moneyIn: 1 }, drips: ['Disney+'] },
  'citi.csv': { n: 4, skipped: { payments: 1, unreadable: 1 }, drips: ['Adobe'] },
  'euro-semicolon.csv': { n: 4, skipped: { moneyIn: 1 }, drips: ['Spotify'] },
  'uk-card.csv': { n: 4, skipped: { refunds: 1, unreadable: 1 }, drips: ['Disney+'] },
  'apple-card.csv': { n: 7, skipped: { payments: 1 }, drips: ['Apple (App Store & iCloud)', 'Apple (App Store & iCloud)'] },
};

test('nine real-shaped bank exports: each read, payments/transfers/refunds/interest skipped and counted, drips found', () => {
  for (const [file, want] of Object.entries(DIALECTS)) {
    const p = C.parseStatement(FIX(file));
    assert.ok(!p.error, `${file}: ${p.error}`);
    assert.strictEqual(p.transactions.length, want.n, `${file}: ${p.transactions.map((t) => t.desc).join(' | ')}`);
    const skipped = { payments: 0, transfers: 0, refunds: 0, interest: 0, moneyIn: 0, unreadable: 0, ...want.skipped };
    assert.deepStrictEqual(p.skipped, skipped, file);
    assert.ok(p.transactions.every((t) => C.isoDay(t.date) && Number.isInteger(t.cents) && t.cents > 0), `${file}: whole cents, real days, spending only`);
    const drips = C.findRecurring(p.transactions, { today: TODAY }).drips;
    assert.deepStrictEqual(drips.map((d) => d.name).sort(), want.drips.slice().sort(), file);
  }
});

test('dialect details: signs, quoted commas, thousands, decimal commas, BOM + CRLF, headerless, a summary above the header', () => {
  const amex = C.parseStatement(FIX('amex.csv')).transactions;
  assert.ok(amex.some((t) => t.desc === 'BLUE BOTTLE COFFEE, OAKLAND CA' && t.cents === 625), 'a quoted comma stays in the field');
  assert.ok(amex.some((t) => t.cents === 120460), '"1,204.60" in quotes is $1,204.60');
  const chase = C.parseStatement(FIX('chase-card.csv')).transactions;
  assert.ok(chase.every((t) => t.cents > 0) && chase.some((t) => t.desc === 'NETFLIX.COM' && t.cents === 1799), 'negative purchases are spending (majority sign)');
  const eu = C.parseStatement(FIX('euro-semicolon.csv'));
  assert.ok(FIX('euro-semicolon.csv').startsWith('\ufeff') && FIX('euro-semicolon.csv').includes('\r\n'), 'the fixture really has a BOM and CRLF');
  assert.ok(eu.transactions.some((t) => t.cents === 123456 && t.date === '2026-07-15'), '-1.234,56 on 15.07.2026');
  assert.strictEqual(C.detectDelimiter(FIX('euro-semicolon.csv')), ';');
  const uk = C.parseStatement(FIX('uk-card.csv'));
  assert.strictEqual(uk.currency, 'GBP');
  assert.ok(uk.transactions.some((t) => t.date === '2026-09-12' && t.cents === 799));
  const wf = C.parseStatement(FIX('wells-fargo.csv'));
  assert.ok(wf.transactions.every((t) => /DISNEY|LUNA/.test(t.desc)), 'headerless: the description is the last column');
  const capOne = C.parseStatement(FIX('capital-one.csv')).transactions;
  assert.ok(!capOne.some((t) => t.cents === 1500), 'a Credit-column refund is not spending');
  // Tabs, a debit/credit pair with blanks, junk rows.
  const tabbed = C.parseStatement('Date\tDescription\tWithdrawals\tDeposits\n2026-09-01\tGYM CO\t30.00\t\n2026-09-02\tPAYCHECK\t\t900.00\n\t\t\t\nTotals\t\t30.00\t900.00\n');
  assert.deepStrictEqual([tabbed.transactions.length, tabbed.skipped.moneyIn, tabbed.skipped.unreadable], [1, 1, 1]);
  // Not a statement at all.
  assert.match(C.parseStatement('hello,world\nfoo,bar\n').error, /doesn’t look like a bank or card statement/);
  assert.match(C.parseStatement('').error, /empty/);
  assert.match(C.parseStatement('%PDF-1.4 binary junk').error, /doesn’t look like/);
});

test('day-first slashes are detected per file; a US file stays month-first', () => {
  const dm = C.parseStatement('Date,Description,Amount\n03/09/2026,GYM,-30.00\n25/09/2026,GYM,-30.00\n');
  assert.deepStrictEqual(dm.transactions.map((t) => t.date), ['2026-09-03', '2026-09-25']);
  const us = C.parseStatement('Date,Description,Amount\n03/09/2026,GYM,-30.00\n09/25/2026,GYM,-30.00\n');
  assert.deepStrictEqual(us.transactions.map((t) => t.date), ['2026-03-09', '2026-09-25']);
});

test('several files merge: the same rows in two downloads count once; two real charges in one file both stay', () => {
  const chase = FIX('chase-card.csv');
  const twice = C.parseStatements([{ name: 'a.csv', text: chase }, { name: 'b.csv', text: chase }]);
  assert.strictEqual(twice.transactions.length, 9);
  assert.strictEqual(twice.dupes, 9);
  const both = C.parseStatements([{ name: 'card.csv', text: chase }, { name: 'bank.csv', text: FIX('bofa-checking.csv') }]);
  assert.strictEqual(both.transactions.length, 13);
  assert.deepStrictEqual(C.findRecurring(both.transactions, { today: TODAY }).drips.map((d) => d.name).sort(), ['Netflix', 'Spotify', 'Verizon']);
  const sameDay = 'Date,Description,Amount\n2026-09-02,APP STORE GAME,-0.99\n2026-09-02,APP STORE GAME,-0.99\n';
  assert.strictEqual(C.parseStatements([{ name: 'x', text: sameDay }]).transactions.length, 2, 'two identical charges in ONE file are both real');
  assert.strictEqual(C.parseStatements([{ name: 'x', text: sameDay }, { name: 'y', text: sameDay }]).transactions.length, 2, '...and not doubled by a second copy of the file');
  const one = C.parseStatements([{ name: 'ok.csv', text: chase }, { name: 'junk.csv', text: 'nope' }]);
  assert.strictEqual(one.transactions.length, 9);
  assert.ok(one.files.find((f) => f.name === 'junk.csv').error, 'a bad file is named, the good one still reads');
});

test('limits: 5 MB and 20,000 rows are refused with a plain message', () => {
  assert.match(C.parseStatements([{ name: 'big.csv', text: 'x'.repeat(5 * 1024 * 1024 + 10) }]).error, /more than 5 MB/);
  const rows = ['Date,Description,Amount'];
  for (let i = 0; i < 20005; i++) rows.push(`2026-09-01,SHOP ${i % 50},-1.00`);
  assert.match(C.parseStatement(rows.join('\n')).error, /more than 20,000 rows/);
});

test('speed: a 5,000-row statement is read and searched in well under a second', () => {
  const lines = ['Transaction Date,Post Date,Description,Category,Type,Amount,Memo'];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const shops = Array.from({ length: 400 }, (_, i) => `SQ *SHOP NUMBER ${i} SPRINGFIELD IL`);
  for (let i = 0; i < 4910; i++) {
    const d = C.addDays('2025-10-01', Math.floor(rnd() * 365));
    lines.push(`${d.slice(5, 7)}/${d.slice(8)}/${d.slice(0, 4)},${d},"${shops[Math.floor(rnd() * shops.length)]}",Food,Sale,-${(1 + rnd() * 120).toFixed(2)},`);
  }
  for (let m = 0; m < 12; m++) for (const [desc, amt] of [['NETFLIX.COM', '17.99'], ['SPOTIFY USA', '11.99'], ['PLANET FITNESS', '24.99'], ['HULU 877-8244858 CA', '7.99'], ['DROPBOX*ABC12', '11.99'], ['NYTIMES*NYTDIGITAL', '4.00'], ['AUDIBLE*1A2B3', '14.95'], ['XFINITY MOBILE', '45.00']]) {
    const d = C.addMonths('2025-10-03', m);
    lines.push(`${d.slice(5, 7)}/${d.slice(8)}/${d.slice(0, 4)},${d},${desc},Bills,Sale,-${amt},`);
  }
  const text = lines.join('\r\n');
  assert.ok(lines.length > 5000);
  const t0 = process.hrtime.bigint();
  const p = C.parseStatements([{ name: 'big.csv', text }]);
  const r = C.findRecurring(p.transactions, { today: TODAY });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  assert.strictEqual(p.files[0].rows, 5006);
  assert.ok(p.transactions.length >= 5000);
  assert.deepStrictEqual(r.drips.filter((d) => !d.quiet).map((d) => d.name).sort(), ['Audible', 'Dropbox', 'Hulu', 'Netflix', 'Planet Fitness', 'Spotify', 'The New York Times', 'Xfinity'], 'the 400 random shops are not drips');
  console.log(`       (5,000 rows in ${ms.toFixed(0)} ms)`);
});

/* ---------------- pure: merchants ---------------- */

test('merchant names come out of the processor noise, store numbers, phones and places', () => {
  const cases = {
    'SQ *CORNER BEAN COFFEE': 'Corner Bean Coffee',
    'TST* LUNA TACOS SPRINGFIELD IL': 'Luna Tacos Springfield',
    'PAYPAL *TUNEBOX': 'Tunebox',
    'Streamio.com*AB12CD 888-555-0134 CA': 'Streamio',
    'FITNEST GYM #0217': 'Fitnest Gym',
    'MELODIA MUSIC 0423 NEW YORK NY': 'Melodia Music',
    'HOMEGUARD RENTERS INS 7781A': 'Homeguard Renters Ins',
    'ONLINE PAYMENT 12345 TO CITY WATER DEPT 09/12': 'City Water Dept',
    'POS DEBIT 1234 FUELSTOP 0412': 'Fuelstop',
    'CHECKCARD 0912 GREENLEAF MARKET': 'Greenleaf Market',
    'NOTELY PRO*QTR': 'Notely Pro',
    'BRIGHTLINE MOBILE BILL': 'Brightline Mobile',
  };
  for (const [desc, want] of Object.entries(cases)) assert.strictEqual(C.merchantInfo(desc).name, want, desc);
  // Known services: one key, however the bank spells it.
  const known = { 'NETFLIX.COM': 'netflix', 'NETFLIX.COM  NETFLIX.COM CA': 'netflix', 'Netflix 866-579-7172 CA': 'netflix', 'SPOTIFY USA': 'spotify', 'SPOTIFY P1A2B3C4D5 STOCKHOLM': 'spotify', 'PAYPAL *SPOTIFY': 'spotify', 'APPLE.COM/BILL 866-712-7753 CA': 'apple', 'GOOGLE *YouTubePremium': 'youtube', 'GOOGLE *Google One': 'googleone', 'GOOGLE *TOUCHTUNES': 'googleplay', 'PURCHASE AUTHORIZED ON 09/17 DISNEY PLUS 888-905-7888 CA S386260712345678 CARD 1234': 'disney', 'Amazon Prime*1A2B3C4D': 'amazonprime', 'AMZN Mktp US*2K4L81': null, 'COSTCO WHSE #0123': null, 'COSTCO *ANNUAL RENEWAL': 'costco', 'UBER *TRIP': null, 'UBER *ONE MEMBERSHIP': 'uberone' };
  for (const [desc, id] of Object.entries(known)) assert.strictEqual(C.merchantInfo(desc).known, id, desc);
  assert.strictEqual(C.merchantInfo('NETFLIX.COM').key, C.merchantInfo('Netflix 866-579-7172 CA').key);
  assert.ok(C.KNOWN.length >= 80, `${C.KNOWN.length} known services`);
  assert.ok(C.KNOWN.every((k) => C.CATS[k.cat] && !/https?:|www\./i.test(k.name)), 'names and categories only - no links');
  // Categories by keyword for merchants the table does not know.
  assert.deepStrictEqual(['FITNEST GYM', 'SHIELDVPN.NET', 'CLOUDVAULT STORAGE', 'SPARKR*GOLD DATING', 'THE DAILY LEDGER', 'BRIGHTLINE MOBILE'].map((d) => C.merchantInfo(d).cat), ['fitness', 'software', 'cloud', 'dating', 'news', 'phone']);
  // Hostile text: markup, bidi, control characters gone; bounded.
  const h = C.merchantInfo('<img src=x onerror=alert(1)>EVIL\u202e\u0000 SHOP' + 'A'.repeat(5000));
  assert.ok(!/[<>\u202e\u0000]/.test(h.name) && h.name.length <= C.LIMITS.name);
});

/* ---------------- pure: cadence ---------------- */

test('cadence: monthly with jitter, weekly, quarterly, yearly - from the gaps', () => {
  const jit = (i) => [0, 2, -1, 3, 1, 0][i % 6];
  const d = find([
    ...monthly('NETFLIX.COM', '2026-01-14', 9, 1799, jit),
    ...Array.from({ length: 10 }, (_, i) => [C.addDays('2026-07-02', 7 * i + (i % 3 === 0 ? 1 : 0)), 400, 'NYTIMES*NYTDIGITAL']),
    ...[0, 3, 6, 9].map((m) => [C.addMonths('2025-10-20', m), 2400, 'NOTELY PRO*QTR']),
    ['2024-11-04', 9900, 'NORDVPN*SUBSCRIPTION'], ['2025-11-06', 9900, 'NORDVPN*SUBSCRIPTION'],
  ]);
  assert.deepStrictEqual(d.map((x) => [x.name, x.cadence]).sort(), [['Netflix', 'monthly'], ['NordVPN', 'annual'], ['Notely Pro', 'quarterly'], ['The New York Times', 'weekly']]);
  const n = byName(d, 'Netflix');
  assert.deepStrictEqual([n.cents, n.monthly, n.yearly, n.confidence, n.charges.length], [1799, 1799, 21588, 'high', 9]);
  assert.strictEqual(n.next, '2026-10-14', 'next expected charge: a month after the last');
  assert.deepStrictEqual([byName(d, 'The New York Times').yearly, byName(d, 'The New York Times').monthly], [20800, 1733], 'weekly: 52 a year');
  assert.deepStrictEqual([byName(d, 'Notely Pro').yearly, byName(d, 'Notely Pro').monthly], [9600, 800]);
  assert.strictEqual(byName(d, 'NordVPN').next, '2026-11-06');
  assert.strictEqual(C.cadenceOf(['2026-01-01', '2026-01-31', '2026-03-03', '2026-04-01']), 'monthly', 'one skipped cycle is forgiven');
  assert.strictEqual(C.cadenceOf(['2026-01-01', '2026-01-12', '2026-02-20']), null);
});

test('not drips: one-offs, a shop you visit often, a restaurant you go to about monthly, an unknown merchant twice', () => {
  const rows = [];
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // Coffee 2-4 times a week, often the same $4.75.
  for (let dd = '2026-01-02'; dd < '2026-09-30'; dd = C.addDays(dd, 1 + Math.floor(rnd() * 4))) rows.push([dd, [475, 475, 475, 525, 610][Math.floor(rnd() * 5)], 'SQ *CORNER BEAN COFFEE']);
  // A Thai place about monthly, different bill each time.
  for (let i = 0; i < 8; i++) rows.push([C.addDays('2026-01-15', i * 31 + (i % 3)), 3600 + Math.floor(rnd() * 2600), 'THAI ORCHID']);
  // Groceries every 5-9 days.
  for (let dd = '2026-01-03'; dd < '2026-09-30'; dd = C.addDays(dd, 5 + Math.floor(rnd() * 5))) rows.push([dd, 3800 + Math.floor(rnd() * 10000), 'GREENLEAF MARKET #112']);
  // An unknown merchant twice, a month apart, same price - a coincidence, not proof.
  rows.push(['2026-03-10', 2499, 'BOOKWORM & CO'], ['2026-04-10', 2499, 'BOOKWORM & CO']);
  rows.push(['2026-05-05', 6418, 'HARDWARE HAVEN'], ['2026-08-19', 2299, 'HARDWARE HAVEN']);
  assert.deepStrictEqual(find(rows), []);
  // ...but a KNOWN service twice a month apart is enough.
  assert.deepStrictEqual(find([['2026-08-03', 1099, 'SPOTIFY USA'], ['2026-09-03', 1099, 'SPOTIFY USA']]).map((d) => [d.name, d.confidence]), [['Spotify', 'low']]);
  // A known yearly service seen once, with months of statement after it: probably yearly.
  const once = find([['2026-02-10', 13900, 'AMAZON PRIME*2K4L'], ['2026-09-28', 500, 'SQ *CORNER BEAN COFFEE']]);
  assert.deepStrictEqual(once.map((d) => [d.name, d.cadence, d.probablyYearly, d.next]), [['Amazon Prime', 'annual', true, '2027-02-10']]);
  assert.deepStrictEqual(find([['2026-09-10', 13900, 'AMAZON PRIME*2K4L'], ['2026-09-28', 500, 'CAFE']]), [], '...but not when the statement ends too soon to tell');
});

/* ---------------- pure: the flags ---------------- */

test('flag: price creep - "went from $15.49 to $17.99 in May - up $30 a year"', () => {
  const d = find(monthly('STREAMIO.COM', '2026-01-08', 9, (i) => (i < 4 ? 1549 : 1799)));
  const f = d[0].flags.find((x) => x.type === 'creep');
  assert.strictEqual(f.text, 'Streamio went from $15.49 to $17.99 in May - up $30 a year.');
  assert.deepStrictEqual([f.from, f.to, f.money, f.rises], [1549, 1799, 3000, 1]);
  const twice = find(monthly('STREAMIO.COM', '2025-10-08', 12, (i) => (i < 4 ? 1399 : i < 8 ? 1549 : 1799)))[0];
  assert.match(twice.flags[0].text, /from \$13\.99 to \$17\.99 \(twice, last in June\) - up \$48 a year/);
  // A bill that wobbles up and down is not creep.
  const wobble = find(monthly('VERIZON WIRELESS', '2026-01-03', 6, (i) => [8500, 8712, 8540, 8800, 8530, 8650][i]))[0];
  assert.ok(!wobble.flags.some((x) => x.type === 'creep'));
});

test('flag: trial turned paid - a $0 or $1 charge, then full price', () => {
  for (const trial of [100, 0]) {
    const d = find([['2026-06-26', trial, 'FlickHub.tv'], ...monthly('FlickHub.tv', '2026-07-26', 3, 1299)]);
    assert.strictEqual(d.length, 1);
    const f = d[0].flags.find((x) => x.type === 'trial');
    assert.ok(f, `trial of ${trial}`);
    assert.strictEqual(f.text, `FlickHub began as a ${C.money(trial)} trial in June - now $12.99 a month.`);
    assert.strictEqual(d[0].charges[0].cents, 1299, 'the trial is not one of the full-price charges');
  }
  // A small charge long before is not a trial.
  assert.ok(!find([['2026-01-01', 100, 'FLICKHUB.TV'], ...monthly('FLICKHUB.TV', '2026-07-26', 3, 1299)])[0].flags.length);
});

test('flag: doubles - two services in a category where one is enough, or one merchant charging twice a cycle', () => {
  const d = find([...monthly('SPOTIFY USA', '2026-03-12', 6, 1199), ...monthly('TIDAL.COM', '2026-04-02', 5, 1099), ...monthly('NETFLIX.COM', '2026-03-14', 6, 1799), ...monthly('HULU 877-8244858', '2026-03-22', 6, 799)]);
  const music = d.filter((x) => x.flags.some((f) => f.type === 'double'));
  assert.deepStrictEqual(music.map((x) => x.name).sort(), ['Spotify', 'Tidal'], 'two streaming services are a choice, two music apps a double');
  assert.strictEqual(music[0].flags[0].text, 'Two music apps: Spotify and Tidal - $275.76 a year together.');
  assert.strictEqual(C.topFlags(d).filter((f) => f.type === 'double').length, 1, 'one flag for the pair, not one each');
  // The same merchant twice every month: two drips, both flagged.
  const rows = [];
  for (let i = 0; i < 4; i++) { const day = C.addMonths('2026-05-05', i); rows.push([day, 1549, 'NETFLIX.COM'], [C.addDays(day, 1), 1549, 'NETFLIX.COM']); }
  const tw = find(rows);
  assert.deepStrictEqual(tw.map((x) => x.name).sort(), ['Netflix', 'Netflix (2nd charge)']);
  assert.ok(tw.every((x) => x.flags[0].type === 'twice' && /charges you twice each cycle/.test(x.flags[0].text)));
  assert.strictEqual(C.totals(tw).yearly, 2 * 12 * 1549, 'both count');
  assert.notStrictEqual(tw[0].id, tw[1].id);
});

test('flag: gone quiet - not counted in the total; renewal coming up in the next 30 days', () => {
  const d = find([...monthly('SPARKR*GOLD DATING', '2025-11-10', 6, 1999), ...monthly('SPOTIFY USA', '2025-11-12', 11, 1199), ['2025-10-21', 7999, 'LingoOwl*Annual Plan']]);
  const q = byName(d, 'Sparkr');
  assert.deepStrictEqual([q.quiet, q.next, q.flags.map((f) => f.type)], [true, null, ['quiet']]);
  assert.strictEqual(q.flags[0].text, 'Sparkr: last charged in April. Did you cancel? (Not counted in your total.)');
  const r = byName(d, 'LingoOwl');
  assert.deepStrictEqual([r.cadence, r.probablyYearly, r.next], ['annual', true, '2026-10-21']);
  assert.strictEqual(r.flags[0].text, 'LingoOwl renews on Oct 21 (in 20 days) - $79.99 for another year.');
  const t = C.totals(d);
  assert.deepStrictEqual([t.count, t.quiet, t.yearly], [2, 1, 12 * 1199 + 7999], 'the quiet one is left out');
  // A renewal 31 days away is not "coming up"; quiet drips never raise it.
  assert.ok(!find([['2025-11-01', 7999, 'LINGOOWL*ANNUAL PLAN'], ['2026-09-30', 100, 'X']], '2026-10-01')[0].flags.length);
});

/* ---------------- pure: the example ---------------- */

test('the example statement tells the story the page says it does, every time', () => {
  const p = C.parseStatements(S.files(TODAY));
  const r = C.findRecurring(p.transactions, { today: TODAY });
  const t = C.totals(r.drips);
  assert.deepStrictEqual([t.count, t.quiet, t.monthly, t.yearly], [14, 1, 21799, 261591]);
  assert.strictEqual(`${S.WHO} has ${t.count} drips costing ${C.money(t.monthly, { whole: true })} a month - ${C.money(t.yearly, { whole: true })} a year.`, 'Alex has 14 drips costing $218 a month - $2,616 a year.');
  assert.deepStrictEqual(C.topFlags(r.drips).map((f) => f.type), ['creep', 'trial', 'double', 'renewal', 'quiet']);
  const names = r.drips.map((d) => d.name).sort();
  assert.deepStrictEqual(names, ['Brightline Mobile', 'CloudVault Storage', 'FitNest Gym', 'FlickHub', 'HomeGuard Renters Ins', 'LingoOwl', 'Melodia Music', 'Munchr Plus', 'Notely Pro', 'PixelPass', 'ShieldVPN', 'Sparkr', 'Streamio', 'The Daily Ledger Digital', 'TuneBox'].sort());
  assert.deepStrictEqual(r.drips.map((d) => d.cadence).filter((c, i, a) => a.indexOf(c) === i).sort(), ['annual', 'monthly', 'quarterly', 'weekly'], 'every cadence is in it');
  for (const shop of ['Corner Bean', 'Greenleaf', 'Fuelstop', 'Luna', 'Thai Orchid', 'Starlight', 'Hardware', 'Bookworm', 'Petal']) assert.ok(!names.some((n) => n.includes(shop)), `${shop} is ordinary spending`);
  assert.deepStrictEqual(p.skipped, { payments: 12, transfers: 0, refunds: 1, interest: 1, moneyIn: 0, unreadable: 0 });
  // Invented names only: no real brand from the curated table in the example.
  assert.ok(p.transactions.every((x) => !C.merchantInfo(x.desc).known), 'the example uses no real brand');
  // The same on any day: the story is dated relative to today.
  for (const day of ['2026-01-31', '2027-03-01', '2026-12-25']) {
    const rr = C.findRecurring(C.parseStatements(S.files(day)).transactions, { today: day });
    assert.deepStrictEqual([C.totals(rr.drips).count, C.topFlags(rr.drips).map((f) => f.type)], [14, ['creep', 'trial', 'double', 'renewal', 'quiet']], day);
  }
  assert.strictEqual(S.csv(TODAY), S.csv(TODAY), 'deterministic');
});

/* ---------------- pure: savings, calendar, cleaning ---------------- */

test('savings and their equivalents: deterministic by amount', () => {
  assert.strictEqual(C.equivalent(61200), 'a weekend away');
  assert.deepStrictEqual([0, 500, 2000, 6000, 12000, 30000, 99999, 100000, 250000, 900000].map(C.equivalent), ['', 'a takeaway coffee or two', 'a few fancy coffees', 'a couple of movie nights', 'a really nice dinner out', 'concert tickets for two', 'a weekend away', 'a new phone', 'a week somewhere warm', 'a proper holiday for two']);
  const drips = C.findRecurring(C.parseStatements(S.files(TODAY)).transactions, { today: TODAY }).drips;
  for (const n of ['FitNest Gym', 'Streamio', 'Melodia Music', 'Sparkr']) byName(drips, n).decision = 'cut';
  const s = C.savings(drips);
  assert.deepStrictEqual([s.count, s.yearly, s.monthly], [3, 47988 + 21588 + 14388, Math.round((47988 + 21588 + 14388) / 12)], 'a quiet drip saves nothing');
  assert.strictEqual(C.savingsLine(s), 'Cutting 3 saves $840 a year - that’s a weekend away.');
  assert.match(C.howToCancel({ cat: 'streaming' }), /Account → Subscription → Cancel.*Settings → Subscriptions/);
  assert.match(C.howToCancel({ cat: 'fitness' }), /in person or in writing/);
});

test('the reminder calendar: RFC 5545, all-day, CRLF, folded, escaped, stable UIDs, never in the past', () => {
  const drips = C.findRecurring(C.parseStatements(S.files(TODAY)).transactions, { today: TODAY }).drips;
  const streamio = byName(drips, 'Streamio');
  streamio.decision = 'cut';
  streamio.name = 'Streamio, Plus; \\ "Premium" ' + 'é'.repeat(60);
  byName(drips, 'FitNest Gym').decision = 'cut';
  byName(drips, 'Sparkr').decision = 'cut';
  const rem = C.reminders(drips, TODAY);
  assert.deepStrictEqual(rem.map((x) => x.kind).sort(), ['cancel', 'cancel', 'renew'], 'quiet drips get nothing; the yearly one is a heads-up');
  assert.ok(rem.every((x) => x.date >= TODAY));
  for (const x of rem.filter((r) => r.kind === 'cancel')) { const d = drips.find((y) => y.id === x.id); assert.strictEqual(x.date, C.addDays(d.next, -2) < TODAY ? TODAY : C.addDays(d.next, -2)); }
  assert.strictEqual(C.reminders([{ id: 'd000000000001', name: 'Soon', cents: 100, cadence: 'monthly', next: '2026-10-02', decision: 'cut' }], TODAY)[0].date, TODAY, 'two days before tomorrow is in the past - today instead');
  const text = C.ics({ drips, today: TODAY, now: '2026-10-01T07:00:00Z' });
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n') && text.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(text), 'CRLF only');
  for (const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `folded: ${line}`);
  const unfolded = text.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('SUMMARY:Cancel Streamio\\, Plus\\; \\\\ "Premium" '), 'commas, semicolons and backslashes escaped');
  assert.ok(unfolded.includes('\\nFrom your Drip list.'), 'newlines escaped');
  assert.strictEqual((unfolded.match(/BEGIN:VEVENT/g) || []).length, 3);
  assert.strictEqual((unfolded.match(/DTSTART;VALUE=DATE:\d{8}/g) || []).length, 3);
  assert.strictEqual((unfolded.match(/BEGIN:VALARM/g) || []).length, 3);
  const uids = unfolded.match(/UID:[^\r]+/g);
  assert.strictEqual(new Set(uids).size, 3);
  streamio.next = '2026-10-20';
  assert.deepStrictEqual(C.ics({ drips, today: TODAY }).replace(/\r\n /g, '').match(/UID:[^\r]+/g).sort(), uids.slice().sort(), 'a moved date keeps its UID');
});

test('a drip from anywhere is cleaned: markup, bidi, bounds, enums; a saved drip has drip fields only', () => {
  const d = C.cleanDrip({ name: '<script>alert(1)</script>Streamio\u202e', cents: '17.99', cadence: 'hourly', cat: 'nope', next: '2026-02-30', decision: 'delete', notes: 'N'.repeat(900), source: 'evil', quiet: 'yes', charges: [{ date: '2026-09-01', cents: 1799 }], desc: 'NETFLIX.COM raw', statement: 'Date,Description' });
  assert.deepStrictEqual([d.name, d.cents, d.cadence, d.next, d.decision, d.notes.length, d.source, d.quiet], ['alert(1) Streamio', 1799, 'monthly', null, null, 200, 'hand', false], 'tags gone, their text kept as plain text');
  assert.ok(C.ID_RE.test(d.id));
  assert.deepStrictEqual(Object.keys(C.toSaved(d)).sort(), C.SAVED_FIELDS.slice().sort());
  assert.strictEqual(C.cleanDrip({ name: '', cents: 100 }), null);
  assert.strictEqual(C.cleanDrip({ name: 'X', cents: 'free' }), null);
  assert.strictEqual(C.cleanDrip({ name: 'X', cents: 99999999 }), null);
  assert.strictEqual(C.cleanList(Array.from({ length: 400 }, (_, i) => ({ name: `Plan ${i}`, cents: 100 + i }))).length, 150);
  const local = C.cleanDrip({ name: 'A', cents: 100, flags: [{ type: 'creep', text: '<b>up</b>', money: 5 }, { type: 'evil', text: 'x' }] }, { local: true });
  assert.deepStrictEqual(local.flags, [{ type: 'creep', text: 'up', money: 5 }]);
  const hand = C.handDrip({ name: 'Piano lessons', amount: '$120', cadence: 'monthly', next: '2026-09-20' }, TODAY);
  assert.deepStrictEqual([hand.drip.cents, hand.drip.source, hand.drip.next], [12000, 'hand', '2026-10-20'], 'a past date rolls to the next one');
  assert.match(C.handDrip({ name: 'X', amount: 'lots' }, TODAY).error, /what it costs/);
});

test('since last time: what is new, what changed price, what went - and decisions carry over', () => {
  const before = C.findRecurring(txs([...monthly('NETFLIX.COM', '2026-01-14', 6, 1549), ...monthly('HULU', '2026-01-22', 6, 799)]), { today: '2026-07-01' }).drips;
  before.find((x) => x.name === 'Netflix').decision = 'keep';
  before.find((x) => x.name === 'Netflix').notes = 'family';
  const hand = C.handDrip({ name: 'Piano lessons', amount: '120', cadence: 'monthly' }, TODAY).drip;
  const prev = before.concat([hand]);
  const after = C.findRecurring(txs([...monthly('NETFLIX.COM', '2026-04-14', 6, (i) => (i < 3 ? 1549 : 1799)), ...monthly('SPOTIFY USA', '2026-06-12', 4, 1199)]), { today: TODAY }).drips;
  const merged = C.carryOver(after, prev);
  const nf = merged.find((x) => x.name === 'Netflix');
  assert.deepStrictEqual([nf.decision, nf.notes], ['keep', 'family']);
  assert.ok(merged.some((x) => x.name === 'Piano lessons'), 'a hand-added drip stays');
  const s = C.compare(prev.map(C.toSaved), merged);
  assert.deepStrictEqual(s.added.map((x) => x.name), ['Spotify']);
  assert.deepStrictEqual(s.changed.map((x) => [x.name, x.from, x.to, x.yearly]), [['Netflix', 1549, 1799, 3000]]);
  assert.deepStrictEqual(s.gone.map((x) => x.name), ['Hulu']);
});

test('snap validation: hostile model output is cleaned, bounded and never invents a price', () => {
  const raw = {
    items: [
      { name: '<img src=x onerror=alert(1)>Streamio', price: '$17.99', cadence: 'monthly', renews: '2026-10-12' },
      { name: 'A'.repeat(20000), price: '3.00', cadence: 'monthly', renews: null },
      { name: 'Words', price: 'nine ninety-nine', cadence: 'monthly' },
      { name: 'Wine\u202e\u0000 club', price: 18, cadence: 'Monthly', renews: 'next tuesday' },
      { name: 'Free', price: '0', cadence: 'monthly' },
      { name: { x: 1 }, price: '2.00', cadence: 'monthly' },
      { name: 'Negative', price: '-5.00', cadence: 'monthly' },
      { name: 'Fortnightly', price: '4.00', cadence: 'fortnightly' },
      { name: 'Yearly words', price: '49.99', cadence: 'per year', renews: '1999-01-01' },
      'junk', null,
      ...Array.from({ length: 61 }, (_, i) => ({ name: `Plan ${i + 1}`, price: `${i + 1}.99`, cadence: 'weekly', renews: null })),
    ],
  };
  const out = C.cleanSnapItems(raw, TODAY);
  assert.strictEqual(out.items.length, 60, '61+ items -> 60');
  const json = JSON.stringify(out);
  assert.ok(!/<[a-z/!]/i.test(json) && !json.includes('\u202e') && !json.includes('\u0000'), 'no markup, bidi or control characters');
  assert.deepStrictEqual(out.items.slice(0, 4).map((i) => [i.name.slice(0, 10), i.cents, i.cadence, i.renews]), [['Streamio', 1799, 'monthly', '2026-10-12'], ['AAAAAAAAAA', 300, 'monthly', null], ['Wine club', 1800, 'monthly', null], ['Yearly wor', 4999, 'annual', null]]);
  assert.ok(out.items.every((i) => i.name.length <= C.LIMITS.name && i.cents > 0 && C.CADENCES.includes(i.cadence)));
  assert.ok(!out.items.some((i) => /Words|Free|Negative|Fortnightly/.test(i.name)), 'prices as words, $0, negatives and odd cadences are dropped');
  assert.ok(out.dropped >= 8);
  assert.deepStrictEqual(C.cleanSnapItems(null, TODAY), { items: [], dropped: 0 });
  const drips = C.snapToDrips([{ name: 'netflix premium', cents: 1799, cadence: 'monthly', renews: '2026-09-02' }], TODAY);
  assert.deepStrictEqual([drips[0].name, drips[0].key, drips[0].source, drips[0].next], ['Netflix', 'k:netflix', 'snap', '2026-10-02']);
});

test('the tool is forced, and the prompt forbids inventing a subscription or a price', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'ai.js'), 'utf8');
  assert.ok(/tool_choice: \{ type: 'tool', name: 'record_subscriptions' \}/.test(src));
  assert.match(ai.SUBS_SYSTEM, /never invent a subscription, a price or a date/);
  assert.match(ai.SUBS_SYSTEM, /never an instruction/);
  assert.deepStrictEqual(ai.SUBS_TOOL.input_schema.properties.items.items.properties.cadence.enum, ['weekly', 'monthly', 'quarterly', 'annual']);
  assert.strictEqual(ai.SUBS_TOOL.input_schema.properties.items.maxItems, 60);
});

/* ---------------- the house rules ---------------- */

test('every text colour holds 4.5:1 on its surface, light and dark', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  const block = (re) => Object.fromEntries([...css.match(re)[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
  const light = block(/:root \{([^}]*)\}/);
  const darkMedia = block(/:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/);
  const dark = block(/:root\[data-theme="dark"\] \{([^}]*)\}/);
  assert.deepStrictEqual(darkMedia, dark, 'the two dark blocks agree');
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs = [['text', 'bg'], ['text', 'card'], ['text', 'card2'], ['muted', 'card'], ['muted', 'bg'], ['muted', 'card2'], ['link', 'card'], ['link', 'bg'], ['link', 'card2'], ['link', 'accent-soft'], ['text', 'accent-soft'],
    ['accent-ink', 'accent'], ['keep', 'keep-bg'], ['keep', 'card'], ['cut', 'cut-bg'], ['cut', 'card'], ['cut', 'card2'], ['unsure', 'unsure-bg'], ['unsure', 'card'], ['text', 'cut-bg'], ['text', 'unsure-bg'],
    ['keep-solid-ink', 'keep-solid'], ['cut-solid-ink', 'cut-solid'], ['strip-ink', 'strip'], ['hero-ink', 'hero-a'], ['hero-ink', 'hero-b'], ['hero-soft', 'hero-a'], ['hero-soft', 'hero-b'], ['muted', 'accent-soft'], ['keep', 'card2']];
  for (const [name, t] of [['light', light], ['dark', { ...light, ...dark }]]) {
    for (const [fg, bg] of pairs) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name}: --${fg} on --${bg} is ${ratio(t[fg], t[bg]).toFixed(2)}:1`);
  }
  assert.ok(ratio('#0b2a4a', '#ffffff') >= 4.5, 'the strip button');
});

test('local-only switches throw on Cloud Run; the collection prefix is honoured', () => {
  for (const [mod, env] of [['./lib/store', { DRIP_MEMORY: '1' }], ['./lib/fakeai', { DRIP_FAKE_AI: '1' }], ['./server', { DRIP_FAKE_AI: '1', DRIP_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, DRIP_MEMORY: '', DRIP_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], { cwd: ROOT, env: { ...process.env, DRIP_MEMORY: '', DRIP_COLLECTION_PREFIX: 'drip_' }, encoding: 'utf8' });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'store.js'), 'utf8');
  assert.ok(/DRIP_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 9, 'every Firestore path is prefixed');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, nothing logged from a body', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  assert.match(html, /Drip finds patterns in your charges - check anything before you cancel it\./);
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js.replace(/\.on[a-z]+ =/g, '')), 'no handler written into markup');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'no other storage access');
  assert.ok(!/<script/i.test(js), 'no script written into markup');
  assert.match(js, /Read on this phone\. Nothing is uploaded\./);
  for (const f of ['server.js', 'lib/ai.js', 'lib/photo.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|photos|drips|name|items|raw|cents|price)/.test(src), `${f} logs a body`);
  }
});

test('the statement never leaves the page: every request the page makes, and what it carries', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  // Every call to the server goes through api() or a fetch of the resend link.
  const calls = [...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'(?:\s*\+[^,)]*)?(?:, ([^)]*\)?))?/g)].map((m) => `${m[1]} ${m[2]}`);
  const allowed = ['GET api/me', 'GET api/list', 'PUT api/list', 'DELETE api/list', 'POST api/snap', 'POST api/auth/', 'POST api/auth/logout', 'GET api/auth/billing'];
  for (const c of calls) assert.ok(allowed.includes(c), `unexpected request: ${c}`);
  assert.ok(calls.includes('PUT api/list') && calls.includes('POST api/snap'));
  assert.strictEqual((js.match(/\bfetch\(/g) || []).length, 2, 'fetch only in api() and the verify resend');
  assert.ok(!/XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(js));
  // What the list save sends: drips through toSaved, nothing else.
  assert.match(js, /function savedBody\(\) \{ return \{ drips: state\.drips\.map\(C\.toSaved\), checkedOn: state\.checkedOn \|\| TODAY \}; \}/);
  assert.strictEqual((js.match(/api\('PUT', 'api\/list', savedBody\(\)\)/g) || []).length, 2, 'both saves send savedBody()');
  // The import path never calls the server.
  const importFns = js.slice(js.indexOf('function readFiles('), js.indexOf('/* ---------------- snap a subscriptions page'));
  assert.ok(!/api\(|fetch\(/.test(importFns), 'reading a statement makes no request');
  // ...and the server has no route that would take one.
  const routes = app._router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  assert.deepStrictEqual(routes.filter((r) => !/^(GET|POST|PUT|DELETE) \/api\/auth|^GET \*$|^GET \/api\/(health|meta|me)|^GET \/healthz|^GET \/api\/health,\/healthz/.test(r)).sort(), ['DELETE /api/list', 'GET /api/list', 'POST /api/snap', 'PUT /api/list'].sort());
});

/* ---------------- over HTTP ---------------- */

async function register(email, ip) {
  const c = client(ip);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}

test('signed out: the page, the example and its files work with zero model calls; nothing private does', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.limits.drips, meta.limits.snapImages, meta.cadences.length], [150, 3, 4]);
  for (const f of ['drip-core.js', 'sample.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['POST', '/api/snap'], ['GET', '/api/list'], ['PUT', '/api/list'], ['DELETE', '/api/list']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' || m === 'DELETE' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  assert.strictEqual((await anon('POST', '/api/snap', { photos: [{ type: 'image/png', data: png() }] })).status, 401);
  assert.strictEqual((await anon('POST', '/api/snap', { photos: [{ type: 'image/png', data: 'A'.repeat(11 * 1024 * 1024) }] })).status, 401, 'the gate answers before the big parser');
  assert.strictEqual((await anon('POST', '/api/statement', { csv: 'Date,Description,Amount' })).status, 404, 'there is nowhere to send a statement');
  assert.strictEqual((await anon('PUT', '/api/list', { x: 'x'.repeat(200 * 1024) })).status, 413, 'every other route keeps the small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the snap route’s gates come before its 12 MB parser, in order; only it holds a model client', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/snap', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  for (const m of ['get', 'put', 'delete']) assert.strictEqual(layer('/api/list', m).route.stack[0].handle.name, 'requireUser');
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1);
});

let sam;

test('snap a subscriptions page: images checked before any spend, one metered call, a review, nothing stored', async () => {
  sam = await register('sam.snap@example.com');
  const dump = store._dump();
  const calls = await modelCalls();
  assert.strictEqual((await sam('POST', '/api/snap', {})).status, 400);
  assert.strictEqual((await sam('POST', '/api/snap', { photos: [{ type: 'image/png', data: Buffer.from('%PDF-1.4 not an image').toString('base64') }] })).status, 400);
  assert.strictEqual((await sam('POST', '/api/snap', { photos: Array.from({ length: 4 }, () => ({ type: 'image/png', data: png() })) })).status, 400, 'four images');
  assert.strictEqual((await sam('POST', '/api/snap', { photos: [{ type: 'image/png', data: 'A'.repeat(6 * 1024 * 1024) }] })).status, 400, 'one over 4 MB');
  assert.strictEqual((await sam('POST', '/api/snap', { photos: [{ type: 'image/gif', data: png() }] })).status, 400);
  assert.strictEqual((await sam('POST', '/api/snap', { photos: [{ type: 'image/png', data: 'A'.repeat(13 * 1024 * 1024) }] })).status, 413, 'over the 12 MB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const r = await sam('POST', '/api/snap', { photos: [{ type: 'image/png', data: png('a') }, { type: 'image/png', data: png('b') }, { type: 'image/png', data: png('c') }] });
  assert.strictEqual(r.status, 200, r.text.slice(0, 300));
  assert.ok(r.text.startsWith(' '), 'the answer streams whitespace first');
  assert.deepStrictEqual(r.data.items.map((i) => [i.name, i.cents, i.cadence, i.renews]), [['Streamio Premium', 1799, 'monthly', '2026-10-12'], ['CloudVault 200 GB', 299, 'monthly', '2026-10-04'], ['LingoOwl Super', 7999, 'annual', '2026-10-21'], ['Puzzle Garden', 499, 'weekly', null]]);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const inj = await sam('POST', '/api/snap', { photos: [{ type: 'image/png', data: png('INJECT') }] });
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !inj.text.includes('\\u202e'), 'no markup reaches the page');
  assert.strictEqual(inj.data.items.length, 60);
  assert.ok(inj.data.items.every((i) => i.cents > 0 && C.CADENCES.includes(i.cadence) && i.name.length <= 40));
  const blank = await sam('POST', '/api/snap', { photos: [{ type: 'image/png', data: png('BLANK') }] });
  assert.deepStrictEqual([blank.status, /No subscriptions with a price/.test(blank.data.error)], [200, true], 'after the stream starts, a failure is a 200 {error}');
  assert.match((await sam('POST', '/api/snap', { photos: [{ type: 'image/png', data: png('MAXTOKENS') }] })).data.error, /ran longer than one reading/);
  const up = await sam('POST', '/api/snap', { photos: [{ type: 'image/png', data: png('UPSTREAM401') }] });
  assert.ok(up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  assert.match((await sam('POST', '/api/snap', { photos: [{ type: 'image/png', data: png('UPSTREAM529') }] })).data.error, /AI is busy/);
  const after = store._dump();
  assert.strictEqual(after, dump, 'snapping stores nothing');
  assert.ok(!after.includes(MARK), 'no image bytes anywhere');
});

test('an unconfirmed free account gets the verify-email 403, before any model call or big body', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/snap', { photos: [{ type: 'image/png', data: png() }] });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.match(r.data.error, /Confirm your email/);
    assert.strictEqual(r.data.resend, '/drip/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/snap', { photos: [{ type: 'image/png', data: 'A'.repeat(14 * 1024 * 1024) }] })).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('PUT', '/api/list', { drips: [{ name: 'Gym', cents: 3000, cadence: 'monthly' }] })).status, 200, 'saving needs no AI and no confirmed address');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
});

test('out of credit: 402 before any model call - and before the big body is read', async () => {
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  const r = await cal('POST', '/api/snap', { photos: [{ type: 'image/png', data: png() }] });
  assert.strictEqual(r.status, 402);
  assert.match(r.data.detail, /Top up/, 'the 402 says how to keep going');
  assert.strictEqual((await cal('POST', '/api/snap', { photos: [{ type: 'image/png', data: 'A'.repeat(14 * 1024 * 1024) }] })).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call was made');
});

test('a saved list holds drips and nothing else - however much a request carries', async () => {
  const p = C.parseStatements(S.files(TODAY));
  const drips = C.findRecurring(p.transactions, { today: TODAY }).drips;
  drips[0].decision = 'cut';
  drips[0].notes = 'cancel after the finale';
  // A hostile or careless body: the whole charge history, flags, the raw
  // statement and the transactions riding along.
  const body = { drips: drips.map((d) => ({ ...d, desc: 'Streamio.com*AB12CD 888-555-0134 CA', transactions: p.transactions.slice(0, 5) })), checkedOn: TODAY, statement: S.csv(TODAY), transactions: p.transactions };
  const r = await sam('PUT', '/api/list', body);
  assert.strictEqual(r.status, 200, r.text.slice(0, 200));
  const doc = await store.get('lists', uidOf('sam.snap@example.com'));
  assert.deepStrictEqual(Object.keys(doc).sort(), ['checkedOn', 'createdAt', 'drips', 'id', 'updatedAt']);
  assert.strictEqual(doc.drips.length, 15);
  for (const d of doc.drips) assert.deepStrictEqual(Object.keys(d).sort(), C.SAVED_FIELDS.slice().sort());
  const dump = store._dump();
  for (const leak of ['Corner Bean', 'Greenleaf', 'Payment Thank You', 'Transaction Date', 'AB12CD', '888-555-0134', '"charges"', '"flags"', '"desc"']) assert.ok(!dump.includes(leak), `stored: ${leak}`);
  assert.deepStrictEqual([doc.drips[0].decision, doc.drips[0].notes, doc.checkedOn], ['cut', 'cancel after the finale', TODAY]);
  const back = await sam('GET', '/api/list');
  assert.deepStrictEqual([back.data.list.drips.length, back.data.list.checkedOn, back.data.limit], [15, TODAY, 150]);
  assert.ok(back.data.list.drips.every((d) => !('flags' in d) && !('charges' in d)));
  // A future checkedOn is today.
  assert.strictEqual((await sam('PUT', '/api/list', { drips: [], checkedOn: '2099-01-01' })).data.list.checkedOn, TODAY);
  await sam('PUT', '/api/list', body);
});

test('limits and ownership: 150 drips, one list per account, nobody reads anyone else’s, delete-all', async () => {
  const many = Array.from({ length: 151 }, (_, i) => ({ name: `Plan ${i}`, cents: 100 + i, cadence: 'monthly' }));
  const r = await sam('PUT', '/api/list', { drips: many });
  assert.deepStrictEqual([r.status, /up to 150 drips/.test(r.data.error)], [400, true]);
  assert.strictEqual((await sam('PUT', '/api/list', { drips: 'nope' })).status, 400);
  const olly = await register('olly.other@example.com');
  assert.strictEqual((await olly('GET', '/api/list')).data.list, null, 'a new account sees no list - not someone else’s');
  await olly('PUT', '/api/list', { drips: [{ name: 'Olly gym', cents: 2000, cadence: 'monthly' }] });
  assert.strictEqual((await sam('GET', '/api/list')).data.list.drips.length, 15, 'each account its own list');
  assert.deepStrictEqual((await olly('GET', '/api/list')).data.list.drips.map((d) => d.name), ['Olly gym']);
  assert.strictEqual((await olly('DELETE', '/api/list')).status, 200);
  assert.strictEqual((await olly('GET', '/api/list')).data.list, null);
  assert.strictEqual((await sam('GET', '/api/list')).data.list.drips.length, 15, 'deleting yours leaves theirs');
  // Saves per account are limited.
  const flood = await register('flood@example.com');
  let last;
  for (let i = 0; i < 61; i++) last = await flood('PUT', '/api/list', { drips: [] });
  assert.strictEqual(last.status, 429);
  const dump = store._dump();
  for (const email of ['sam.snap@example.com', 'olly.other@example.com']) assert.ok(!dump.includes(email), `no email stored: ${email}`);
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.set('trust proxy', 1);
  host.use('/drip', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/drip`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
