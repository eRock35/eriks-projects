// Pure rules first, then end to end against the memory store and the fake
// model:
//   DULY_MEMORY=1 DULY_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /duly, the way the
// lab mounts it, so the auth cookie, the budget gate, the sync routes and the
// metered route's parser are exercised as deployed. Model calls are counted
// from the identity's usage rows - the same rows that bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.DULY_MEMORY !== '1' || process.env.DULY_FAKE_AI !== '1') {
  console.error('run with DULY_MEMORY=1 DULY_FAKE_AI=1');
  process.exit(1);
}
// A free-tier ceiling far above anything these tests spend, so the cap can be
// reached on purpose by writing the day's tally (and read fresh each time).
process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const { app, identityStore, store } = require('../server');
const C = require('../public/duly-core');
const ai = require('../lib/ai');
const photo = require('../lib/photo');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let base;
let ip6 = 1;
const freshIp6 = () => `2001:db8:${(ip6++).toString(16)}::1`;
function client(ip) {
  const cookies = {};
  const addr = ip || freshIp6();
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
const settle = () => new Promise((r) => setTimeout(r, 15)); // the meter writes usage rows fire-and-forget

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- a little world for the pure tests ---------------- */

const T = '2026-10-20';
const NOW = Date.UTC(2026, 9, 20, 15);
const bill = (o) => C.cleanBill({ id: 'bill000001', payee: 'City Power', cycle: { kind: 'monthly', day: 14 }, pay: 'auto', amount: 8000, since: '2025-01-01', ...o }, T);
const HOSTILE = ['<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', '\u202eCity\u202c', 'Po\u2066wer\u2069 <script>x</script>'];

/* ---------------- cleaning ---------------- */

test('typed strings go through one door: no markup, no control or bidi characters, bounded', () => {
  assert.strictEqual(C.cleanText('<b>City</b> Power\u0007', 48), 'City Power');
  assert.strictEqual(C.cleanText('<img src=x onerror=alert(1)>', 48), '', 'nothing left of pure markup');
  assert.strictEqual(C.cleanText('\u202eRent\u202c', 48), 'Rent');
  assert.strictEqual(C.cleanText({ toString: () => 'x' }, 48), '', 'only strings');
  assert.strictEqual(Array.from(C.cleanText('x'.repeat(9000), C.LIMITS.payee)).length, C.LIMITS.payee);
  for (const h of HOSTILE) {
    const out = C.cleanText(h, 140);
    assert.ok(!/[<>\u202a-\u202e\u2066-\u2069]/.test(out), `${JSON.stringify(h)} -> ${JSON.stringify(out)}`);
  }
  assert.ok(C.clean('a'.repeat(5e6), 60).length <= 60, 'huge input is cut before any pattern runs');
  const b = bill({ payee: '<img src=x onerror=alert(1)>Water & Co', note: '"><svg onload=alert(1)> joint acct' });
  assert.ok(!/[<>]/.test(b.payee + b.note));
});

/* ---------------- account numbers ---------------- */

test('account numbers: a field named like one is refused; a value shaped like one is refused; dates, phones and "ending 4421" are fine', () => {
  for (const s of ['4111 1111 1111 1111', 'acct 12345678', '021000021', 'ref 1234-5678-9012', 'GB29NWBK60161331926819', '5500-0000-0000-0004']) {
    assert.ok(C.hasAccountNumber(s), s);
  }
  for (const s of ['ending 4421', 'Due 2026-10-14', 'due 10/14/2026', 'call (555) 010-1234', '1-800-555-0100', '555.010.1234', 'Visa 4421', '$1,850.00', 'Unit 12B']) {
    assert.ok(!C.hasAccountNumber(s), s);
  }
  const refused = (raw, why) => assert.throws(() => C.cleanBill({ id: 'bill000001', payee: 'Power', cycle: { kind: 'monthly', day: 1 }, ...raw }, T), (e) => e.status === 400 && e.code === 'account-number' && e.message === C.REFUSAL, why);
  refused({ accountNumber: '1' }, 'a field named accountNumber');
  refused({ acct: 'x' }, 'acct');
  refused({ routing: 'x' }, 'routing');
  refused({ cardNumber: 'x' }, 'cardNumber');
  refused({ iban: 'x' }, 'iban');
  refused({ password: 'x' }, 'password');
  refused({ cycle: { kind: 'monthly', day: 1, sortCode: '1' } }, 'nested');
  refused({ payee: 'Power 12345678901' }, 'in the payee');
  refused({ note: 'card 4111 1111 1111 1111' }, 'in the note');
  assert.ok(bill({ note: 'Visa ending 4421, call 1-800-555-0100 before 10/14/2026' }), 'a useful note survives');
  assert.ok(/Duly never keeps account/.test(C.REFUSAL), 'the refusal is a sentence');
  const s = C.stripAccountNumbers('Harbor Card acct 5500 0000 0000 0004, due 2026-11-01, call 1-800-555-0100');
  assert.strictEqual(s.stripped, true);
  assert.ok(!/5500/.test(s.text) && /2026-11-01/.test(s.text) && /1-800-555-0100/.test(s.text), s.text);
  assert.deepStrictEqual(C.stripAccountNumbers('City Power $84.20 due 2026-10-14'), { text: 'City Power $84.20 due 2026-10-14', stripped: false });
});

/* ---------------- categories ---------------- */

test('the category guess is a fixed keyword map, whole words, in a fixed precedence', () => {
  const cases = {
    'City Power & Light': 'electric', 'Northgate Gas': 'gas', 'Cedar Valley Water & Sewer': 'water', 'Fibrelink Internet': 'internet',
    'Cellwave Mobile': 'phone', 'Visa card': 'card', 'Credit card': 'card', 'Rent': 'home', 'Mortgage': 'home', 'Car insurance': 'insurance',
    'Car loan': 'car', 'Netflix': 'streaming', 'Carmen cleaning': null, 'Gym': null, '__proto__': null,
  };
  for (const [k, v] of Object.entries(cases)) assert.strictEqual(C.guessCategory(k), v, k);
  assert.strictEqual(bill({ payee: 'Mystery Co', category: 'nope' }).category, 'other');
  assert.strictEqual(C.CATEGORIES.length, 11);
  assert.ok(C.CATEGORIES.every((c) => c.emoji && c.label));
});

/* ---------------- cycles and due dates ---------------- */

test('due dates across month ends: day 31 is the month’s last day, day 30 in February is the 28th or 29th', () => {
  const m31 = bill({ cycle: { kind: 'monthly', day: 31 } });
  assert.deepStrictEqual(C.occurrences(m31, '2027-01-01', '2027-05-31'), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  const m30 = bill({ cycle: { kind: 'monthly', day: 30 } });
  assert.deepStrictEqual(C.occurrences(m30, '2028-02-01', '2028-03-31'), ['2028-02-29', '2028-03-30'], 'leap February');
  assert.strictEqual(C.nextDue(m31, '2027-02-27'), '2027-02-28');
  assert.strictEqual(C.nextDue(m31, '2027-03-01'), '2027-03-31');
  assert.strictEqual(C.lastDue(m31, '2027-03-01'), '2027-02-28');
  assert.strictEqual(C.nextDue(bill({ cycle: { kind: 'monthly', day: 20 } }), T), T, 'due today is next');
  assert.ok(/last day/.test(C.describeCycle(m31.cycle)));
  assert.strictEqual(C.describeCycle({ kind: 'monthly', day: 1 }), 'Monthly on the 1st');
  assert.strictEqual(C.describeCycle({ kind: 'monthly', day: 22 }), 'Monthly on the 22nd');
  assert.strictEqual(C.describeCycle({ kind: 'monthly', day: 13 }), 'Monthly on the 13th');
});

test('every N months follows its anchor across years; yearly on Feb 29 falls on Feb 28 outside leap years; statements use their dates', () => {
  const q = bill({ cycle: { kind: 'months', every: 3, day: 15, anchor: '2026-11' } });
  assert.deepStrictEqual(C.occurrences(q, '2026-01-01', '2027-12-31'), ['2026-02-15', '2026-05-15', '2026-08-15', '2026-11-15', '2027-02-15', '2027-05-15', '2027-08-15', '2027-11-15'], 'back from the anchor too');
  const b2 = bill({ cycle: { kind: 'months', every: 2, day: 31, anchor: '2027-02' } });
  assert.deepStrictEqual(C.occurrences(b2, '2027-01-01', '2027-06-30'), ['2027-02-28', '2027-04-30', '2027-06-30']);
  const leap = bill({ cycle: { kind: 'yearly', month: 2, day: 29 } });
  assert.deepStrictEqual(C.occurrences(leap, '2027-01-01', '2029-12-31'), ['2027-02-28', '2028-02-29', '2029-02-28']);
  assert.strictEqual(C.cleanCycle({ kind: 'yearly', month: 4, day: 31 }, T), null, 'April 31 is no date');
  assert.strictEqual(C.cleanCycle({ kind: 'monthly', day: 32 }, T), null);
  assert.strictEqual(C.cleanCycle({ kind: 'months', every: 1, day: 3, anchor: '2026-01' }, T), null, 'every month is "monthly"');
  assert.strictEqual(C.cleanCycle({ kind: 'weekly' }, T), null);
  const st = bill({ cycle: { kind: 'statement', dates: ['2026-09-09', 'nope', '2026-11-01', '2026-09-09', '2026-02-30'] } });
  assert.deepStrictEqual(st.cycle.dates, ['2026-09-09', '2026-11-01'], 'deduplicated, real days only');
  assert.strictEqual(C.nextDue(st, T), '2026-11-01');
  assert.strictEqual(C.nextDue(bill({ cycle: { kind: 'statement', dates: ['2026-09-09'] } }), T), null, 'no future date entered');
  assert.ok(C.isLeap(2028) && !C.isLeap(2100) && C.isLeap(2000) && !C.isLeap(2027));
  assert.strictEqual(C.daysBetween('2028-02-28', '2028-03-01'), 2);
  assert.strictEqual(C.addDays('2027-12-31', 1), '2028-01-01');
  assert.strictEqual(C.addMonths('2026-11', 3), '2027-02');
  assert.strictEqual(C.addMonths('2026-01', -1), '2025-12');
});

test('daylight saving never moves a due date: the same answers in every time zone, across both changes', () => {
  const script = `
    const C = require('./public/duly-core');
    const out = [];
    // Local noon on the days the clocks change in the US (2026-03-08, 2026-11-01) and in Europe and Australia.
    for (const [y, m, d] of [[2026, 2, 8], [2026, 10, 1], [2026, 2, 29], [2026, 9, 25], [2026, 3, 5]]) out.push(C.localDay(new Date(y, m, d, 12)));
    // Just after midnight local time on a 23-hour day.
    out.push(C.localDay(new Date(2026, 2, 8, 0, 30)), C.localDay(new Date(2026, 2, 8, 23, 30)));
    const b = { cycle: { kind: 'monthly', day: 8 } };
    out.push(C.occurrences(b, '2026-01-01', '2026-12-31').join(','), C.daysBetween('2026-03-07', '2026-03-09'), C.daysBetween('2026-10-31', '2026-11-02'), C.addDays('2026-03-07', 1), C.addDays('2026-11-01', 1));
    console.log(JSON.stringify(out));`;
  const results = ['America/New_York', 'Europe/London', 'Australia/Sydney', 'Pacific/Kiritimati', 'America/Los_Angeles'].map((TZ) => {
    const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  });
  for (const r of results) assert.deepStrictEqual(r, results[0]);
  assert.deepStrictEqual(results[0].slice(0, 7), ['2026-03-08', '2026-11-01', '2026-03-29', '2026-10-25', '2026-04-05', '2026-03-08', '2026-03-08']);
  assert.strictEqual(results[0][8], 2);
  assert.strictEqual(results[0][9], 2);
  assert.strictEqual(results[0][10], '2026-03-08');
  assert.strictEqual(results[0][11], '2026-11-02');
});

/* ---------------- money ---------------- */

test('money: whole cents in, "$1,240.50" out; "free" is no amount, not $0.00; negatives refused', () => {
  assert.strictEqual(C.parseMoney('$1,240.50'), 124050);
  assert.strictEqual(C.parseMoney('about 40'), 4000);
  assert.strictEqual(C.parseMoney('84.2'), 8420);
  assert.strictEqual(C.parseMoney(91.99), 9199);
  assert.strictEqual(C.parseMoney('free'), null);
  assert.strictEqual(C.parseMoney(''), null);
  assert.strictEqual(C.parseMoney('-40'), null);
  assert.strictEqual(C.parseMoney('(12.00)'), null);
  assert.strictEqual(C.parseMoney('$99,999,999,999'), null, 'over the ceiling');
  assert.strictEqual(C.fmtMoney(124050), '$1,240.50');
  assert.strictEqual(C.fmtMoney(7000), '$70.00');
  assert.strictEqual(C.fmtMoney(224774, { round: true }), '$2,248');
  assert.strictEqual(C.fmtMoney(null), '—');
  assert.strictEqual(C.median([3, 1, 2]), 2);
  assert.strictEqual(C.median([1, 2, 3, 4]), 3);
  assert.strictEqual(C.median([]), null);
});

/* ---------------- AutoPay health ---------------- */

test('AutoPay health: a score and a generic checklist per bill not on it - never a claim about a particular company', () => {
  const list = [bill({ id: 'aaaaaa1', pay: 'auto' }), bill({ id: 'aaaaaa2', pay: 'off' }), bill({ id: 'aaaaaa3', pay: 'manual', payee: 'Rent', category: 'home' })];
  const h = C.health(list);
  assert.deepStrictEqual([h.on, h.total, h.score, h.words, h.off.map((b) => b.id)], [1, 3, 33, '1 of 3 bills on AutoPay', ['aaaaaa2', 'aaaaaa3']]);
  assert.strictEqual(C.health([]).words, 'No bills yet');
  const card = C.checklist(bill({ category: 'card', payee: 'Harbor Card' }));
  assert.ok(card.steps.some((s) => /statement balance/i.test(s) && /not the minimum/i.test(s)), 'cards: statement balance, not the minimum');
  assert.ok(card.steps.some((s) => /checking/i.test(s)));
  const util = C.checklist(bill({ category: 'electric' }));
  assert.ok(util.steps.some((s) => /Billing or Payments/.test(s)));
  for (const c of [card, util, C.checklist(bill({ category: 'home' })), C.checklist(bill({ category: 'streaming' }))]) {
    assert.ok(c.notes.some((s) => /buffer/i.test(s)) && c.notes.some((s) => /first payment/i.test(s)) && c.notes.some((s) => /never ask for your login/i.test(s)), 'the honest notes every time');
  }
  assert.ok(C.checklist(bill({ pay: 'manual' })).notes.some((s) => /by hand/.test(s)));
  const all = JSON.stringify([...C.CATEGORY_IDS.map((id) => C.checklist(bill({ category: id })))]);
  assert.ok(!/Netflix|Visa|Chase|Comcast|Verizon|AT&T|Amex|Capital One|Spotify|Settings >/i.test(all), 'no company named, no menu path claimed');
});

/* ---------------- amounts over time ---------------- */

test('the spike rule: more than N% over the median of the amounts before it; one jump does not drag its own baseline', () => {
  const h = (amounts) => amounts.map((a, i) => ({ d: C.addDays('2026-01-14', i * 30), a }));
  const b = bill({ amount: 7000, history: h([7000, 7000, 7000, 9199]) });
  const f = C.amountFlags(b, 20);
  assert.deepStrictEqual(f.map((x) => x.high), [false, false, false, true]);
  assert.strictEqual(f[3].base, 7000);
  assert.strictEqual(f[3].over, 31);
  assert.strictEqual(C.amountFlags(b, 40)[3].high, false, 'the threshold is configurable');
  assert.strictEqual(C.amountFlags(bill({ amount: 7000, history: h([8401]) }), 20)[0].high, true, 'a fixed bill with no history is judged against its amount');
  assert.strictEqual(C.amountFlags(bill({ amount: 7000, history: h([8400]) }), 20)[0].high, false, 'exactly 20% is not more than 20%');
  const v = bill({ varies: true, amount: null, history: h([5000, 30000]) });
  assert.deepStrictEqual(C.amountFlags(v, 20).map((x) => x.high), [false, false], 'a varying bill needs two before it to be judged');
  const v2 = bill({ varies: true, amount: null, history: h([10000, 11000, 10500, 9000, 13000]) });
  assert.deepStrictEqual(C.amountFlags(v2, 20).map((x) => x.high), [false, false, false, false, true]);
  assert.strictEqual(C.typical(v2), 10500, 'a varying bill is usually its median');
  assert.strictEqual(C.typical(b), 7000);
  assert.strictEqual(C.amountFor(b, b.history[3].d), 9199, 'a logged cycle is its own amount');
  // The alert: a recent spike is called out at the top; an old one is not.
  const recent = bill({ amount: 7000, history: [{ d: '2026-07-22', a: 7000 }, { d: '2026-08-22', a: 7000 }, { d: '2026-09-22', a: 9199 }] });
  assert.ok(C.alerts([recent], T, { nowMs: NOW }).some((a) => a.kind === 'high' && /31% over its usual \$70\.00/.test(a.text)));
  const old = bill({ amount: 7000, history: [{ d: '2026-05-22', a: 7000 }, { d: '2026-06-22', a: 9199 }] });
  assert.ok(!C.alerts([old], T, { nowMs: NOW }).some((a) => a.kind === 'high'), 'more than 60 days ago is not news');
});

/* ---------------- the month ---------------- */

test('this month: paid by AutoPay on the due date (assumed), marked paid, late, due today, soon - and the totals', () => {
  const list = [
    bill({ id: 'auto00001', payee: 'Power', pay: 'auto', amount: 10000, cycle: { kind: 'monthly', day: 14 } }),
    bill({ id: 'manual001', payee: 'Rent', pay: 'manual', amount: 185000, cycle: { kind: 'monthly', day: 1 }, paid: ['2026-10-01'] }),
    bill({ id: 'late00001', payee: 'Water', pay: 'off', amount: 9000, cycle: { kind: 'monthly', day: 16 } }),
    bill({ id: 'today0001', payee: 'Phone', pay: 'manual', amount: 8500, cycle: { kind: 'monthly', day: 20 }, paid: ['2026-09-20'] }),
    bill({ id: 'soon00001', payee: 'Gas', pay: 'auto', varies: true, amount: null, cycle: { kind: 'monthly', day: 22 } }),
    bill({ id: 'later0001', payee: 'Net', pay: 'auto', amount: 7000, cycle: { kind: 'monthly', day: 30 } }),
    bill({ id: 'new000001', payee: 'Gym', pay: 'manual', amount: 3000, cycle: { kind: 'monthly', day: 5 }, since: '2026-10-18' }),
  ];
  const mv = C.monthView(list, '2026-10', T);
  const st = Object.fromEntries(mv.items.map((x) => [x.id, x.status + (x.how ? `:${x.how}` : '')]));
  assert.deepStrictEqual(st, { auto00001: 'paid:auto', manual001: 'paid:marked', late00001: 'overdue', today0001: 'today', soon00001: 'soon', later0001: 'later', new000001: 'paid:before' });
  assert.deepStrictEqual(mv.items.map((x) => x.status).slice(0, 4), ['overdue', 'today', 'soon', 'later'], 'late first');
  assert.strictEqual(mv.total, 10000 + 185000 + 9000 + 8500 + 7000 + 3000);
  assert.strictEqual(mv.toCome, 9000 + 8500 + 7000);
  assert.strictEqual(mv.unknown, 1, 'a varying bill with nothing logged is counted, not guessed');
  assert.strictEqual(C.statusWords({ status: 'overdue' }, '2026-10-16', T), '4 days late');
  assert.strictEqual(C.statusWords({ status: 'soon' }, '2026-10-22', T), 'Due in 2 days');
  assert.strictEqual(C.statusWords({ status: 'paid', how: 'auto' }, '2026-10-14', T), 'Paid by AutoPay (assumed)');
  const kinds = C.alerts(list, T, { nowMs: NOW }).map((a) => `${a.kind}:${a.id || ''}`);
  assert.deepStrictEqual(kinds, ['late:late00001', 'due:today0001', 'autopay:'], 'late, due today by hand, and the AutoPay line');
  const grid = C.monthGrid('2026-10');
  assert.strictEqual(grid[0].indexOf('2026-10-01'), 4, 'October 2026 starts on a Thursday');
  assert.ok(grid.every((w) => w.length === 7));
  assert.strictEqual(C.monthGrid('2027-02').flat().filter(Boolean).length, 28);
  assert.strictEqual(C.monthGrid('2028-02').flat().filter(Boolean).length, 29);
  const nw = bill({ id: 'brandnew1', createdAt: NOW - 3 * C.DAY_MS });
  assert.ok(C.alerts([nw], T, { nowMs: NOW }).some((a) => a.kind === 'new'), 'a bill added this week is new');
  const st2 = bill({ cycle: { kind: 'statement', dates: ['2026-09-09'] }, category: 'card' });
  assert.ok(C.alerts([st2], T, { nowMs: NOW }).some((a) => a.kind === 'date'), 'a statement bill with no next date asks for one');
});

/* ---------------- the calendar file ---------------- */

function parseIcs(text) {
  assert.ok(text.endsWith('\r\n'), 'ends with CRLF');
  assert.ok(!/[^\r]\n/.test(text), 'every line ends CRLF');
  const physical = text.slice(0, -2).split('\r\n');
  for (const l of physical) assert.ok(Buffer.byteLength(l, 'utf8') <= 75, `line over 75 octets: ${l}`);
  const lines = [];
  for (const l of physical) { if (l.startsWith(' ')) lines[lines.length - 1] += l.slice(1); else lines.push(l); }
  const stack = [];
  for (const l of lines) {
    if (l.startsWith('BEGIN:')) stack.push(l.slice(6));
    else if (l.startsWith('END:')) assert.strictEqual(stack.pop(), l.slice(4), 'BEGIN and END pair up');
    else assert.ok(/^[A-Z-]+(;[A-Z-]+=[^:;]+)*:/.test(l), `a property line: ${l}`);
  }
  assert.strictEqual(stack.length, 0);
  return lines;
}
function unescapeText(v) { return v.replace(/\\n/g, '\n').replace(/\\([,;\\])/g, '$1'); }

test('.ics: valid RFC 5545 - CRLF, folded at 75 octets, recurring rules for month ends and leap days, a reminder, text escaped', () => {
  const list = [
    bill({ id: 'monthly14', payee: 'City Power, Light; & "Gas" \\ Co', note: 'Line one\nline two, with; marks', cycle: { kind: 'monthly', day: 14 } }),
    bill({ id: 'monthly31', payee: 'Rent 🏠 Maple Court Apartments with a very long name indeed', pay: 'manual', cycle: { kind: 'monthly', day: 31 } }),
    bill({ id: 'quarter01', payee: 'Water', cycle: { kind: 'months', every: 3, day: 30, anchor: '2026-11' } }),
    bill({ id: 'leapyear1', payee: 'Insurance', cycle: { kind: 'yearly', month: 2, day: 29 } }),
    bill({ id: 'yearly001', payee: 'Car tax', cycle: { kind: 'yearly', month: 12, day: 2 } }),
    bill({ id: 'statement', payee: 'Harbor Card', category: 'card', varies: true, amount: null, cycle: { kind: 'statement', dates: ['2026-09-09', '2026-11-01', '2026-12-03'] } }),
  ];
  const text = C.buildIcs(list, { today: T, nowMs: NOW, remindDays: 3 });
  const lines = parseIcs(text);
  assert.deepStrictEqual(lines.slice(0, 3), ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Duly//Bill due dates//EN']);
  const events = text.split('BEGIN:VEVENT').length - 1;
  assert.strictEqual(events, 7, 'five recurring events and one per future statement date');
  const rrules = lines.filter((l) => l.startsWith('RRULE:'));
  assert.deepStrictEqual(rrules, [
    'RRULE:FREQ=MONTHLY;BYMONTHDAY=14',
    'RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1',
    'RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=28,29,30;BYSETPOS=-1',
    'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1',
    'RRULE:FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=2',
  ]);
  const starts = lines.filter((l) => l.startsWith('DTSTART'));
  assert.deepStrictEqual(starts, ['DTSTART;VALUE=DATE:20261114', 'DTSTART;VALUE=DATE:20261031', 'DTSTART;VALUE=DATE:20261130', 'DTSTART;VALUE=DATE:20270228', 'DTSTART;VALUE=DATE:20261202', 'DTSTART;VALUE=DATE:20261101', 'DTSTART;VALUE=DATE:20261203'], 'all-day, the next one first, past statements left out');
  const uids = lines.filter((l) => l.startsWith('UID:'));
  assert.strictEqual(new Set(uids).size, uids.length, 'unique UIDs');
  assert.ok(lines.includes('DTSTAMP:20261020T150000Z'));
  assert.strictEqual(lines.filter((l) => l === 'BEGIN:VALARM').length, 7, 'a reminder on every event');
  assert.ok(lines.filter((l) => l.startsWith('TRIGGER:')).every((l) => l === 'TRIGGER:-P2DT15H'), '3 days before at 9 am');
  assert.ok(C.buildIcs([list[0]], { today: T, nowMs: NOW, remindDays: 0 }).includes('TRIGGER:PT9H'), 'on the day at 9 am');
  assert.ok(C.buildIcs([list[0]], { today: T, nowMs: NOW, remindDays: 1 }).includes('TRIGGER:-PT15H'), 'the day before at 9 am');
  const summary = lines.find((l) => l.startsWith('SUMMARY:') && l.includes('City Power'));
  assert.ok(summary.includes('City Power\\, Light\\; & "Gas" \\\\ Co'), summary);
  assert.strictEqual(unescapeText(summary.slice(8)).includes('City Power, Light; & "Gas" \\ Co'), true);
  const desc = lines.find((l) => l.startsWith('DESCRIPTION:') && l.includes('Line one'));
  assert.ok(desc.includes('Line one line two\\, with\\; marks') && !/[\r\n]/.test(desc), 'a typed note is one line; its marks are escaped');
  assert.ok(/never pays bills and never holds account numbers/.test(text));
  assert.strictEqual(C.icsText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  const folded = C.icsFold('SUMMARY:' + '🏠'.repeat(40));
  for (const l of folded.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75);
  assert.strictEqual(folded.replace(/\r\n /g, ''), 'SUMMARY:' + '🏠'.repeat(40), 'never folded inside a character');
});

/* ---------------- the sample ---------------- */

test('the sample household: nine made-up bills - one spike, two not on AutoPay, one statement card, one late, one new', () => {
  for (const day of [T, '2026-01-31', '2028-02-29', '2026-12-31', '2027-03-01']) {
    const nowMs = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8), 12);
    const s = C.sample(day, nowMs);
    assert.strictEqual(s.length, 9, day);
    assert.ok(s.every((b) => b && b.sample === true && /^sample-/.test(b.id)), 'every one marked sample');
    assert.strictEqual(C.health(s).words, '7 of 9 bills on AutoPay');
    assert.strictEqual(s.filter((b) => b.cycle.kind === 'statement').length, 1);
    const spikes = s.filter((b) => { const f = C.amountFlags(b, 20); return f.length && f[f.length - 1].high; });
    assert.deepStrictEqual(spikes.map((b) => b.id), ['sample-internet'], `${day}: exactly one spike`);
    assert.ok(s.every((b) => C.amountFlags(b, 20).filter((x) => x.high).length <= 1));
    const kinds = C.alerts(s, day, { nowMs }).map((a) => a.kind);
    for (const k of ['late', 'high', 'new', 'autopay']) assert.ok(kinds.includes(k), `${day}: ${k} in ${kinds}`);
    assert.ok(s.every((b) => C.nextDue(b, day)), 'every sample bill has a next due date');
  }
  const names = C.sample(T, NOW).map((b) => b.payee).join(' ');
  assert.ok(!/Netflix|Comcast|Verizon|Chase|Visa|PG&E|Xfinity|Spotify/i.test(names), 'invented names only');
});

/* ---------------- the page and the files ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour holds 4.5:1 on its surface in both themes', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2']) for (const fg of ['text', 'muted', 'link']) ok(fg, bg);
    ok('text', 'accent-soft'); ok('link', 'accent-soft'); ok('muted', 'accent-soft');
    ok('accent-ink', 'accent'); ok('accent', 'card'); ok('accent', 'bg');
    for (const k of ['late', 'soon', 'paid', 'high', 'info']) { ok(k, `${k}-bg`); ok(k, 'card'); }
    ok('text', 'info-bg'); ok('text', 'paid-bg'); ok('muted', 'card2');
    ok('err', 'card'); ok('err', 'bg'); ok('ink2', 'card');
    ok('strip-ink', 'strip'); ok('strip-btn-ink', 'strip-btn');
  }
  assert.ok(ratio('#ffffff', '#0b6b4f') >= 4.5 && ratio('#ffffff', '#2b3a8f') >= 4.5, 'the lab card colours hold white text');
});

test('local-only switches throw on Cloud Run', () => {
  for (const [mod, env] of [['./lib/store', { DULY_MEMORY: '1' }], ['./lib/fakeai', { DULY_FAKE_AI: '1' }], ['./server', { DULY_FAKE_AI: '1', DULY_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, DULY_MEMORY: '', DULY_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured; no queries at all, so no index', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: ROOT, env: { ...process.env, DULY_MEMORY: '', DULY_COLLECTION_PREFIX: 'duly_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = read('lib/store.js');
  assert.ok(/DULY_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.ok(!/store\.list\(|orderBy/.test(server), 'documents are read by key only');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, no email, the core has no clock', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html));
  assert.ok(html.includes('class="tabbar dk-tabbar"'), 'the tab bar becomes the desktop rail');
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown)\s*=/.test(js), 'handlers by addEventListener, not properties');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/sessionStorage|indexedDB/.test(js));
  assert.ok(!/<script/i.test(js), 'no script written into markup');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const core = read('public/duly-core.js');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js + core + read('server.js')), 'no email address in the files');
  assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(core), 'the core has no dice and no clock');
  assert.match(js, /prefers-reduced-motion/);
  assert.ok(/toDataURL\('image\/jpeg'/.test(js) && /PHOTO_PX = 1600/.test(js), 'a photo is shrunk on the phone first');
  assert.ok(/Duly never pays a bill/.test(js) && /never asks for a password or an account number/.test(js), 'the page says it plainly');
  for (const f of ['server.js', 'lib/ai.js', 'public/duly-core.js']) {
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|text|payee|photo|note)/.test(read(f)), `${f} logs a body`);
  }
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(read('public/sw.js')), 'the service worker never caches the API');
});

/* ---------------- over HTTP ---------------- */

async function register(email, ip) {
  const c = client(ip);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const BILL = { payee: 'City Power', category: 'electric', amount: 8420, varies: false, cycle: { kind: 'monthly', day: 14 }, pay: 'auto', note: '', history: [{ d: '2026-09-14', a: 8420 }], paid: [], since: '2026-01-01', createdAt: 1, updatedAt: 5 };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64');

test('signed out: everything is free and makes no model call; the metered and sync routes answer 401 before reading a big body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.strictEqual(meta.categories.length, 11);
  for (const f of ['duly-core.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/read', { text: 'City Power $84.20 due 2026-10-30' })).status, 401);
  assert.strictEqual((await anon('POST', '/api/read', { text: 'x'.repeat(12 * 1024 * 1024) })).status, 401, 'the gate answers before the 9 MB parser');
  assert.strictEqual((await anon('GET', '/api/bills')).status, 401, 'syncing needs an account');
  assert.strictEqual((await anon('PUT', '/api/bills/bill000001', { bill: BILL })).status, 401);
  assert.strictEqual((await anon('POST', '/api/bills/merge', { bills: 'x'.repeat(400 * 1024) })).status, 401, 'and is refused before its big parser');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the metered route’s gates come before its parser, in order; one model client in the whole server', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/read', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/bills/merge', 'post').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one door to one metered call');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
});

test('signed in, the bills follow you: one at a time, newer wins on merge, two phones at once, account numbers refused, nothing identifying stored', async () => {
  const phoneA = await register('sam.sync@example.com');
  const put = await phoneA('PUT', '/api/bills/bill000001', { bill: { ...BILL, sample: true, extra: 'dropped' }, today: T });
  assert.strictEqual(put.status, 200, put.text);
  assert.deepStrictEqual(Object.keys(put.data.bill).sort(), [...C.SAVED_FIELDS].sort(), 'only the bill’s own fields');
  assert.strictEqual((await phoneA('PUT', '/api/bills/sample-rent', { bill: BILL })).status, 400, 'the sample stays on the phone');
  assert.strictEqual((await phoneA('PUT', '/api/bills/bill000002', { bill: { payee: '', cycle: BILL.cycle } })).status, 400);
  for (const bad of [{ ...BILL, accountNumber: '12345678' }, { ...BILL, routing: '021000021' }, { ...BILL, note: 'acct 1234 5678 9012' }, { ...BILL, payee: 'Power 4111111111111111' }]) {
    const r = await phoneA('PUT', '/api/bills/bill000003', { bill: bad, today: T });
    assert.deepStrictEqual([r.status, r.data.code, r.data.error], [400, 'account-number', C.REFUSAL], JSON.stringify(bad).slice(0, 80));
  }
  // The same account on another phone.
  const phoneB = client();
  assert.strictEqual((await phoneB('POST', '/api/auth/login', { email: 'sam.sync@example.com', password: 'a long enough password' })).status, 200);
  assert.deepStrictEqual((await phoneB('GET', '/api/bills')).data.bills.map((b) => b.payee), ['City Power']);
  const m = await phoneB('POST', '/api/bills/merge', { today: T, bills: [
    { ...BILL, id: 'bill000001', payee: 'Old name', updatedAt: 1 },
    { ...BILL, id: 'bill000004', payee: 'Rent', category: 'home', pay: 'manual', updatedAt: Date.now() },
    { ...BILL, id: 'bill000005', payee: 'Leaky', note: 'card 4111 1111 1111 1111' },
    { ...BILL, id: 'sample-gas', sample: true },
  ] });
  assert.strictEqual(m.status, 200, m.text);
  assert.deepStrictEqual(m.data.bills.map((b) => b.payee).sort(), ['City Power', 'Rent'], 'the newer copy kept, the sample and the leaky one left behind');
  assert.strictEqual(m.data.refused, 1);
  // Two phones saving different bills at the same moment: all stick.
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? phoneA : phoneB)('PUT', `/api/bills/race${String(i).padStart(6, '0')}`, { bill: { ...BILL, payee: `Bill ${i}` }, today: T })));
  assert.strictEqual((await phoneA('GET', '/api/bills')).data.bills.length, 14, 'twelve at once, none lost');
  assert.strictEqual((await phoneB('DELETE', '/api/bills/bill000004')).status, 200);
  assert.strictEqual((await phoneA('GET', '/api/bills')).data.bills.length, 13);
  const dump = store._dump();
  assert.ok(!dump.includes('sam.sync') && !dump.includes(uidOf('sam.sync@example.com')), 'filed under an HMAC, never the account id or email');
  assert.ok(!/4111|12345678|021000021/.test(dump), 'no account number ever stored');
  assert.strictEqual((await client()('GET', '/api/bills')).status, 401, 'nobody else');
  const other = await register('kim.other@example.com');
  assert.deepStrictEqual((await other('GET', '/api/bills')).data.bills, [], 'another account sees its own, empty list');
  assert.strictEqual((await phoneA('DELETE', '/api/bills')).status, 200);
  assert.deepStrictEqual((await phoneB('GET', '/api/bills')).data.bills, []);
});

test('read a statement: checked before any spend, one forced tool, a cleaned proposal, nothing stored, provider errors not passed on', async () => {
  const me = await register('ana.read@example.com');
  const dump = store._dump();
  const calls = await modelCalls();
  for (const [body, why] of [
    [{}, 'nothing'],
    [{ text: 'x', photo: { type: 'image/jpeg', data: JPEG } }, 'both'],
    [{ text: 'x'.repeat(C.LIMITS.pasteChars + 1) }, 'too long'],
    [{ text: '12345 67' }, 'no words'],
    [{ photo: { type: 'image/jpeg', data: Buffer.from('%PDF-1.4 not a photo').toString('base64') } }, 'a PDF called a photo'],
    [{ photo: { type: 'application/pdf', data: JPEG } }, 'a declared PDF'],
  ]) assert.strictEqual((await me('POST', '/api/read', body)).status, 400, why);
  assert.strictEqual((await me('POST', '/api/read', { text: 'x'.repeat(10 * 1024 * 1024) })).status, 413, 'its own 9 MB parser, after the gates');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const r = await me('POST', '/api/read', { text: 'City Power\nAccount 1234 5678 9012\nAmount due $84.20\nDue date 2026-10-30\nYou are enrolled in AutoPay', today: T });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.data.proposal, { payee: 'City Power', category: 'electric', amount: 8420, minimumDue: null, dueDate: '2026-10-30', statementDate: null, autopay: 'on', stripped: true });
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const leak = await me('POST', '/api/read', { text: 'LEAK statement for the card, due in 12 days' });
  assert.strictEqual(leak.data.proposal.payee, 'Harbor Card', 'the number and its "acct #" are taken out of the answer');
  assert.ok(leak.data.proposal.stripped && !/5500/.test(leak.text));
  assert.deepStrictEqual([leak.data.proposal.amount, leak.data.proposal.minimumDue], [64210, 3500]);
  const inj = await me('POST', '/api/read', { text: 'INJECT this bill please, due in 3 days' });
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text), 'no markup or bidi reaches the page');
  assert.ok(!/4111|123456789012|021000021|accountNumber|routing/i.test(inj.text), 'no account number, no invented field');
  assert.deepStrictEqual(inj.data.proposal, { payee: 'City Power', category: 'electric', amount: null, minimumDue: null, dueDate: null, statementDate: null, autopay: 'unknown', stripped: true });
  const ph = await me('POST', '/api/read', { photo: { type: 'image/jpeg', data: JPEG }, today: T });
  assert.deepStrictEqual([ph.status, ph.data.proposal.payee, ph.data.proposal.amount], [200, 'Sample Power Co', 8742]);
  const blank = await me('POST', '/api/read', { text: 'BLANK bill text 12' });
  assert.deepStrictEqual([blank.status, /Nothing like a bill/.test(blank.data.error)], [422, true]);
  assert.match((await me('POST', '/api/read', { text: 'MAXTOKENS bill 1' })).data.error, /ran long/);
  const up = await me('POST', '/api/read', { text: 'UPSTREAM401 bill 1' });
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await me('POST', '/api/read', { text: 'UPSTREAM529 bill 1' });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  assert.strictEqual(store._dump(), dump, 'reading stores nothing - not the text, not the photo, not the proposal');
});

test('what the model sees: a pasted statement stripped of account numbers first, one forced tool, nothing else of the household', async () => {
  const seen = [];
  const spy = { messages: { create: async (p) => { seen.push(p); return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'record_bill', input: { payee: 'X' } }] }; } } };
  const b = ai.brief({ text: 'Harbor Card\nAccount number 4111 1111 1111 1111\nRouting 021000021\nStatement balance $642.10 due 2026-11-01. Call 1-800-555-0100.' }, photo);
  assert.strictEqual(b.stripped, true);
  await ai.read(spy, 'claude-haiku-4-5', b, T);
  const p = seen[0];
  assert.deepStrictEqual(p.tool_choice, { type: 'tool', name: 'record_bill' }, 'one forced tool');
  assert.ok(p.max_tokens <= 1000);
  const text = JSON.stringify(p.messages);
  assert.ok(!/4111|021000021/.test(text), 'the numbers never reach the model');
  assert.ok(/642\.10/.test(text) && /2026-11-01/.test(text) && /1-800-555-0100/.test(text), 'the amount, the date and the phone number do');
  assert.ok(/Never return an account number/.test(p.system));
  assert.ok(!Object.keys(ai.TOOL.input_schema.properties).some((k) => /acc|card|routing|number/i.test(k)), 'the tool has no field that could hold one');
  const pb = ai.brief({ photo: { type: 'image/jpeg', data: JPEG } }, photo);
  await ai.read(spy, 'claude-haiku-4-5', pb, T);
  assert.strictEqual(seen[1].messages[0].content[0].type, 'image');
  assert.deepStrictEqual(ai.cleanProposal({ payee: 'Rent', amount: '$1,850', dueDate: '2030-01-01', statementDate: '2026-10-25', autopay: 'yes', category: 'home' }, T),
    { payee: 'Rent', category: 'home', amount: 185000, minimumDue: null, dueDate: null, statementDate: null, autopay: 'unknown', stripped: false }, 'impossible dates dropped, unknown autopay');
});

test('the gates: an unconfirmed free account gets verify-email 403, out of credit 402, the day’s free ceiling 503 - never a 413, never a model call', async () => {
  const BODY = { text: 'City Power $84.20 due 2026-10-30' };
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/read', BODY);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/duly/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/read', { text: 'x'.repeat(12 * 1024 * 1024) })).status, 403, '403 before the body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('PUT', '/api/bills/bill000001', { bill: BILL, today: T })).status, 200, 'syncing needs no AI and no confirmation');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/read', BODY)).status, 402);
  assert.strictEqual((await cal('POST', '/api/read', { text: 'x'.repeat(12 * 1024 * 1024) })).status, 402, '402, not 413');
  const dan = await register('dan.capped@example.com');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-duly-${day}`, { usd: 5000 });
  try {
    const capped = await dan('POST', '/api/read', BODY);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/read', { text: 'x'.repeat(12 * 1024 * 1024) })).status, 503, 'the ceiling answers before the parser too');
  } finally { await identityStore.remove('control', `free-spend-duly-${day}`); }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'none of them spent anything');
  assert.strictEqual((await dan('POST', '/api/read', BODY)).status, 200, 'and it lifts when the day’s tally is under it');
  await settle();
  calls = await modelCalls();
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use((req, res, next) => (req.path === '/duly' ? res.redirect(301, '/duly/') : next()));
  host.use('/duly', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/duly`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (e) { failed++; console.log(`  FAIL ${t.name}\n${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
