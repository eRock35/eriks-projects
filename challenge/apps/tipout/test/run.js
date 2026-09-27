// Pure rules first, then end to end against the memory store and the fake
// model:
//   TIPOUT_MEMORY=1 TIPOUT_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /tipout, the way
// the lab mounts it, so the auth cookie, the budget gate, per-manager scoping,
// the public receipt links and the one big-body route are exercised as
// deployed. Model calls are counted from the identity's usage rows - the same
// rows that bill a real account.

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.TIPOUT_MEMORY !== '1' || process.env.TIPOUT_FAKE_AI !== '1') {
  console.error('run with TIPOUT_MEMORY=1 TIPOUT_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const R = require('../public/rules');
const Q = require('../public/qr');
const S = require('../lib/shifts');
const ai = require('../lib/ai');
const { demo, build, SETUP, PEOPLE } = require('../lib/demo');

let base;
const TODAY = '2026-09-27';
function client() {
  const cookies = {};
  return async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-local-date': TODAY, ...(cookie ? { Cookie: cookie } : {}), ...headers },
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

/* ---------------- helpers for the pure half ---------------- */

const HOURS = R.template('hours');
const POINTS = R.template('points');
const TIPOUT = R.template('tipout');
let seq = 0;
const person = (name, role, hours) => ({ pid: `p${String(++seq).padStart(4, '0')}`, name, role, hours });
function run(rules, crew, money = {}, extra = {}) {
  const v = R.validateShift({ date: '2026-09-25', part: 'dinner', card: '0', cash: '0', ...money, crew, rules, ...extra }, TODAY);
  if (v.error) throw new Error(`validate: ${v.error}`);
  return { shift: v.shift, r: R.split(v.shift) };
}
const cents = (r) => Object.fromEntries(r.people.map((p) => [p.name, p.total]));
function conserved(r, shift) {
  const out = r.people.reduce((s, p) => s + p.total, 0);
  assert.strictEqual(out, shift.card + shift.cash, 'total paid out == total in');
  assert.strictEqual(r.check.balanced, true);
  for (const p of r.people) {
    assert.ok(Number.isInteger(p.total) && Number.isInteger(p.card) && Number.isInteger(p.cash), 'whole cents');
    assert.strictEqual(p.card + p.cash, p.total, `${p.name}: card + cash is the share`);
    assert.ok(p.card >= 0 && p.cash >= 0, `${p.name}: nothing negative`);
  }
  assert.strictEqual(r.cashPaid + r.toCard, shift.cash, 'every cash cent is in an envelope or moved to card');
}

/* ---------------- pure: reading numbers and names ---------------- */

test('money, points and hours are read from the digits, never a float', () => {
  assert.deepStrictEqual(['$1,284.60', '1284.6', '0.1', 'USD 12', '12.345', '12.344', '.5', '  7 '].map(R.toCents), [128460, 128460, 10, 1200, 1235, 1234, 50, 700]);
  for (const bad of ['-5', '(12.00)', '12,34', 'ten', '', '1e5', '$', NaN, Infinity, -3, {}]) assert.strictEqual(R.toCents(bad), null, String(bad));
  assert.strictEqual(R.toCents(0.1 + 0.2), 30);
  assert.deepStrictEqual(['1.2', '0.5', 1.25, '10%', '2.555'].map(R.toHundredths), [120, 50, 125, 1000, 256]);
  assert.deepStrictEqual([6.5, '7', '6.3', '8h', 0].map(R.toQuarters), [26, 28, 25, 32, 0]);
  assert.strictEqual(R.toQuarters('-1'), null);
  assert.strictEqual(R.money(160160), '$1,601.60');
});

test('first names only: surnames, markup and junk never survive', () => {
  assert.strictEqual(R.cleanName('Maya Thompson'), 'Maya', 'a surname typed by habit is dropped');
  assert.strictEqual(R.cleanName('sam r'), 'sam R.', 'an initial is kept to tell two Sams apart');
  assert.strictEqual(R.cleanName('<img src=x onerror=alert(1)>Maya'), 'Maya');
  assert.ok(!/[=()"+@]/.test(R.cleanName('=HYPERLINK("x")+@A1')), 'no formula characters');
  assert.strictEqual(R.cleanName('José'), 'José');
  assert.strictEqual(R.cleanName('Zoë-Ann'), 'Zoë-Ann');
  assert.strictEqual(R.cleanName('<<<<<<'.repeat(10000)), '', 'a hostile run of < costs linear time and leaves nothing');
  assert.strictEqual(R.cleanName('x'.repeat(500)).length, R.LIMITS.name);
  assert.strictEqual(R.cleanName('‮evil'), 'evil', 'direction overrides stripped');
});

/* ---------------- pure: rounding that never loses a cent ---------------- */

test('largest remainder: sums exactly, deterministic ties, 10,000 random splits', () => {
  assert.deepStrictEqual(R.allocate(10000, [1, 1, 1]).parts, [3334, 3333, 3333], 'the odd cent goes first in list order on a tie');
  assert.deepStrictEqual(R.allocate(100, [2, 1]).parts, [67, 33]);
  assert.deepStrictEqual(R.allocate(1, [1, 1, 1, 1]).parts, [1, 0, 0, 0]);
  assert.deepStrictEqual(R.allocate(5, [0, 3, 0]).parts, [0, 5, 0], 'zero weight gets nothing, not even a rounding cent');
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let i = 0; i < 10000; i++) {
    const n = 1 + Math.floor(rnd() * 30);
    const ws = Array.from({ length: n }, () => Math.floor(rnd() * 4000));
    if (!ws.some(Boolean)) ws[0] = 1;
    const amount = Math.floor(rnd() * 20000000);
    const a = R.allocate(amount, ws);
    assert.strictEqual(a.parts.reduce((x, y) => x + y, 0), amount, `split ${i}`);
    const W = ws.reduce((x, y) => x + y, 0);
    a.parts.forEach((p, j) => assert.ok(Math.abs(p - (amount * ws[j]) / W) < 1, 'nobody more than a cent from their exact share'));
  }
});

/* ---------------- pure: the three methods ---------------- */

test('hours: a share is hours over total hours, to the cent, balanced', () => {
  const crew = [person('Maya', 'server', 6), person('Luis', 'bartender', 3), person('Ana', 'busser', 3)];
  const { shift, r } = run(HOURS, crew, { card: '100.00', cash: '20.00' });
  assert.deepStrictEqual(cents(r), { Maya: 6000, Luis: 3000, Ana: 3000 });
  conserved(r, shift);
  assert.match(r.people[0].lines[0], /6 of 12 hours = 50\.00% of \$120\.00 → \$60\.00/);
  assert.deepStrictEqual(r.people.map((p) => p.cash), [1000, 500, 500], 'cash in proportion, in whole dollars');
  const odd = run(HOURS, [person('A', 'server', 1), person('B', 'server', 1), person('C', 'server', 1)], { card: '100.00' });
  assert.deepStrictEqual(Object.values(cents(odd.r)), [3334, 3333, 3333]);
  assert.match(odd.r.people[0].lines[0], /incl\. 1¢ rounding/, 'the rounding cent is shown, not hidden');
  conserved(odd.r, odd.shift);
});

test('points: role points × hours (server 1.0, bartender 1.2, busser 0.5, host 0.4)', () => {
  const crew = [person('Maya', 'server', 5), person('Luis', 'bartender', 5), person('Ana', 'busser', 4), person('Theo', 'host', 5)];
  // weights 5, 6, 2, 2 = 15 points of $300.00
  const { shift, r } = run(POINTS, crew, { card: '240.00', cash: '60.00' });
  assert.deepStrictEqual(cents(r), { Maya: 10000, Luis: 12000, Ana: 4000, Theo: 4000 });
  assert.match(r.people[1].lines[0], /Bartender 1\.2 pts × 5 h = 6 of 15 points = 40\.00%/);
  conserved(r, shift);
});

test('tip-outs first: bar 10% of tips, kitchen 3% of food sales, then the rest', () => {
  const crew = [person('Maya', 'server', 6), person('Jordan', 'server', 4), person('Luis', 'bartender', 8), person('Marco', 'kitchen', 8), person('Keisha', 'kitchen', 4)];
  const { shift, r } = run(TIPOUT, crew, { card: '800.00', cash: '200.00', sales: '4000.00' });
  const bar = r.pieces.find((p) => p.to === 'bartender');
  const kit = r.pieces.find((p) => p.to === 'kitchen');
  assert.deepStrictEqual([bar.amount, kit.amount], [10000, 12000], '10% of $1,000 and 3% of $4,000');
  assert.strictEqual(r.pieces.find((p) => p.kind === 'rest').amount, 78000);
  assert.deepStrictEqual(cents(r), { Maya: 46800, Jordan: 31200, Luis: 10000, Marco: 8000, Keisha: 4000 });
  assert.match(r.people[3].lines[0], /Kitchen tip-out \(3% of \$4,000\.00 food sales = \$120\.00\): 8 of 12 hours/);
  conserved(r, shift);
});

test('tip-outs: skipped when nobody in the role worked or sales are missing, capped at the tips', () => {
  const crew = [person('Maya', 'server', 6), person('Jordan', 'server', 6)];
  const { shift, r } = run(TIPOUT, crew, { card: '500.00' });
  assert.ok(r.pieces.filter((p) => p.kind === 'tipout').every((p) => p.skipped), 'no bartender, no kitchen on');
  assert.match(r.notes.join(' '), /Nobody on Bartender worked/);
  assert.deepStrictEqual(cents(r), { Maya: 25000, Jordan: 25000 });
  conserved(r, shift);
  const noSales = run(TIPOUT, [person('Maya', 'server', 6), person('Marco', 'kitchen', 6)], { card: '500.00' });
  assert.match(noSales.r.notes.join(' '), /Enter food sales/);
  assert.strictEqual(noSales.r.people.find((p) => p.name === 'Marco').total, 0, 'no sales, no kitchen tip-out - and no guess');
  conserved(noSales.r, noSales.shift);
  // 3% of $10,000 sales is more than $100 of tips: capped, never invented.
  const greedy = run(TIPOUT, [person('Maya', 'server', 6), person('Marco', 'kitchen', 6), person('Luis', 'bartender', 6)], { card: '100.00', sales: '10000.00' });
  assert.match(greedy.r.notes.join(' '), /more than the tips hold/);
  conserved(greedy.r, greedy.shift);
  // Only tip-out roles on: the rest is shared by everyone, not lost.
  const onlyBar = run(TIPOUT, [person('Luis', 'bartender', 6), person('Sam', 'bartender', 2)], { card: '100.00' });
  assert.deepStrictEqual(cents(onlyBar.r), { Luis: 7500, Sam: 2500 });
  conserved(onlyBar.r, onlyBar.shift);
});

test('zero hours, one person and thirty people', () => {
  const z = run(HOURS, [person('Maya', 'server', 6), person('Ana', 'busser', 0)], { card: '123.45' });
  assert.deepStrictEqual(cents(z.r), { Maya: 12345, Ana: 0 });
  assert.match(z.r.people[1].lines[0], /no hours this shift, so no share/);
  conserved(z.r, z.shift);
  const none = R.split(R.validateShift({ date: '2026-09-25', crew: [person('Ana', 'busser', 0)], card: '50', rules: HOURS }, TODAY).shift);
  assert.match(none.error, /Add hours/);
  // Everyone on zero points: an error, never $50 silently lost.
  const zp = R.validateRules({ ...POINTS, roles: [{ key: 'trainee', name: 'Trainee', pts: 0 }] }).rules;
  const lost = R.split(R.validateShift({ date: '2026-09-25', crew: [person('Kim', 'trainee', 5)], card: '50', rules: zp }, TODAY).shift);
  assert.ok(lost.error, 'nothing to share by is refused');
  const one = run(POINTS, [person('Maya', 'server', 5)], { card: '99.99', cash: '17.53' });
  assert.deepStrictEqual(cents(one.r), { Maya: 11752 });
  assert.deepStrictEqual([one.r.people[0].cash, one.r.toCard], [1700, 53], 'whole dollars in the envelope, the 53¢ with the card tips');
  conserved(one.r, one.shift);
  const roles = ['server', 'bartender', 'busser', 'host'];
  for (let t = 0; t < 50; t++) {
    const crew = Array.from({ length: 30 }, (_, i) => person(`Crew${String.fromCharCode(65 + (i % 26))}`, roles[(i * 7 + t) % 4], ((i * 13 + t * 5) % 40) / 4 + 0.25));
    for (const rules of [HOURS, POINTS, TIPOUT]) {
      const { shift, r } = run({ ...rules, cashDollars: t % 2 === 0 }, crew, { card: `${1000 + t * 37}.${String(t % 100).padStart(2, '0')}`, cash: `${300 + t * 11}.${String((t * 7) % 100).padStart(2, '0')}`, sales: `${5000 + t}.99` });
      assert.strictEqual(r.people.length, 30);
      conserved(r, shift);
      if (rules.cashDollars !== false && t % 2 === 0) assert.ok(r.people.every((p) => p.cash % 100 === 0), 'whole-dollar envelopes');
    }
  }
});

test('cash in cents mode: every cash cent goes in an envelope', () => {
  const { shift, r } = run({ ...HOURS, cashDollars: false }, [person('A', 'server', 3), person('B', 'server', 4)], { card: '10.00', cash: '33.33' });
  assert.strictEqual(r.toCard, 0);
  assert.strictEqual(r.cashPaid, 3333);
  conserved(r, shift);
  // All cash, cents mode: a share is never more cash than the share itself.
  const allCash = run({ ...HOURS, cashDollars: true }, [person('A', 'server', 1), person('B', 'server', 1), person('C', 'server', 1)], { cash: '10.40' });
  assert.ok(allCash.r.people.every((p) => p.cash <= p.total));
  conserved(allCash.r, allCash.shift);
});

/* ---------------- pure: envelopes ---------------- */

test('envelopes: exact change from the drawer, and the ideal ones when it is not counted', () => {
  const b = build(TODAY);
  const env = R.envelopesFor(b.result, b.shift.drawer);
  assert.strictEqual(env.status, 'exact');
  assert.strictEqual(env.leftCents, 0, 'the sample drawer comes out to zero');
  for (const p of env.people) assert.strictEqual(p.bills.reduce((s, x) => s + x.c * x.n, 0), p.cents, `${p.name}'s envelope holds exactly their cash`);
  const used = {};
  env.people.forEach((p) => p.bills.forEach((x) => { used[x.c] = (used[x.c] || 0) + x.n; }));
  for (const [c, n] of Object.entries(used)) assert.ok(n <= b.shift.drawer[c], `never more ${c}¢ than the drawer holds`);
  const ideal = R.envelopes([{ pid: 'a', name: 'A', cents: 8700 }], null);
  assert.deepStrictEqual([ideal.status, R.billsText(ideal.people[0].bills)], ['ideal', '1 × $50, 1 × $20, 1 × $10, 1 × $5, 2 × $1']);
  // Greedy would take the $50 and be stuck; the search finds three $20s.
  const tricky = R.envelopes([{ pid: 'a', name: 'A', cents: 6000 }], { 5000: 1, 2000: 3 });
  assert.deepStrictEqual([tricky.status, R.billsText(tricky.people[0].bills), tricky.leftCents], ['exact', '3 × $20', 5000]);
  const coins = R.envelopes([{ pid: 'a', name: 'A', cents: 41 }, { pid: 'b', name: 'B', cents: 30 }], { 25: 1, 10: 4, 5: 1, 1: 1 });
  assert.deepStrictEqual([coins.status, coins.leftCents], ['exact', 0], 'coins too, when the house pays them');
});

test('envelopes: impossible change is said plainly, with what to break', () => {
  const two = R.envelopes([{ pid: 'a', name: 'Maya', cents: 500 }, { pid: 'b', name: 'Luis', cents: 500 }], { 1000: 1 });
  assert.deepStrictEqual([two.status, two.exact, two.proven], ['short', false, true]);
  assert.match(two.message, /can’t make exact change/);
  assert.deepStrictEqual(two.people.map((p) => p.short), [500, 500]);
  assert.match(two.advice[0], /Swap one \$10/);
  const twenties = R.envelopes([{ pid: 'a', name: 'A', cents: 3000 }, { pid: 'b', name: 'B', cents: 1000 }], { 2000: 2 });
  assert.strictEqual(twenties.status, 'short');
  assert.match(twenties.advice[0], /Swap one \$20/);
  const thin = R.envelopes([{ pid: 'a', name: 'A', cents: 5000 }], { 2000: 1 });
  assert.match(thin.message, /holds \$20\.00 but the envelopes need \$50\.00/);
  assert.match(thin.advice[0], /pay the missing \$30\.00/);
  const many = R.envelopes(Array.from({ length: 30 }, (_, i) => ({ pid: `p${i}`, name: `P${i}`, cents: 1700 + i * 100 })), { 2000: 30, 1000: 30, 500: 30, 100: 200 });
  assert.strictEqual(many.status, 'exact', 'thirty envelopes from one drawer');
});

/* ---------------- pure: the manager heads-up ---------------- */

test('fairness heads-up: a manager or supervisor in the pool, informational only', () => {
  const rules = R.validateRules({ ...HOURS, roles: [...HOURS.roles, { key: 'sup', name: 'Floor supervisor', pts: 100, manager: true }, { key: 'gm', name: 'General Manager', pts: 100 }] }).rules;
  assert.strictEqual(rules.roles.find((r) => r.key === 'gm').manager, true, 'a manager title is flagged by its name');
  const plain = run(rules, [person('Maya', 'server', 6), person('Dana', 'sup', 0)], { card: '100' });
  assert.strictEqual(plain.r.headsUp, null, 'no hours, no share, no heads-up');
  const { shift, r } = run(rules, [person('Maya', 'server', 6), person('Dana', 'sup', 4)], { card: '100' });
  assert.ok(r.headsUp);
  assert.match(r.headsUp.text, /Dana \(Floor supervisor\)/);
  assert.match(r.headsUp.text, /Fair Labor Standards Act \(since 2018\)/);
  assert.match(r.headsUp.text, /Check your state and local rules/);
  assert.match(r.headsUp.text, /not legal advice/);
  assert.deepStrictEqual(cents(r), { Maya: 6000, Dana: 4000 }, 'the numbers are the house rules’, unchanged');
  conserved(r, shift);
  assert.ok(R.looksManager('Bar Manager') && R.looksManager('owner') && !R.looksManager('Server') && !R.looksManager('Managerial'));
});

/* ---------------- pure: hostile input ---------------- */

test('hostile input: every shift field bounded, typed and cleaned', () => {
  const ok = (over) => R.validateShift({ date: '2026-09-25', card: '10', crew: [person('Maya', 'server', 5)], rules: HOURS, ...over }, TODAY);
  assert.strictEqual(ok({ date: '2026-02-30' }).field, 'date');
  assert.strictEqual(ok({ date: '2026-10-05' }).field, 'date', 'not a week in the future');
  assert.strictEqual(ok({ card: '-10' }).field, 'card');
  assert.strictEqual(ok({ cash: '1e9' }).field, 'cash');
  assert.strictEqual(ok({ card: '100000.01' }).field, 'card', 'over the per-shift cap');
  assert.strictEqual(ok({ crew: [] }).field, 'crew');
  assert.strictEqual(ok({ crew: [person('Maya', 'server', 25)] }).field, 'crew', 'no 25-hour shifts');
  assert.strictEqual(ok({ crew: [person('Maya', 'server', 'lots')] }).field, 'crew');
  assert.strictEqual(ok({ crew: [person('Maya', 'wizard', 5)] }).field, 'crew', 'a role the rules do not have');
  const p = person('Maya', 'server', 5);
  assert.strictEqual(ok({ crew: [p, { ...p }] }).field, 'crew', 'the same person twice');
  assert.strictEqual(ok({ crew: Array.from({ length: 41 }, (_, i) => person(`P${i}`, 'server', 1)) }).field, 'crew');
  assert.strictEqual(ok({ crew: [{ ...person('x', 'server', 1), pid: '../../etc' }] }).field, 'crew');
  assert.strictEqual(ok({ drawer: { 2000: -1 } }).field, 'drawer');
  assert.strictEqual(ok({ drawer: { 2000: 1.5 } }).field, 'drawer');
  const odd = ok({ part: '<script>', drawer: { 2000: 2, 999: 5, __proto__: { x: 1 } }, crew: [person('<b>Maya</b> Smith', 'server', 5)] });
  assert.deepStrictEqual([odd.shift.part, odd.shift.drawer, odd.shift.crew[0].name], ['dinner', { 2000: 2 }, 'Maya'], 'unknown parts and bills dropped, names cleaned');
  assert.strictEqual(R.validateRules({ method: 'lottery', roles: HOURS.roles }).field, 'method');
  assert.strictEqual(R.validateRules({ method: 'tipout', roles: HOURS.roles, tipouts: [{ to: 'nobody', pct: 10 }] }).field, 'tipouts');
  assert.strictEqual(R.validateRules({ method: 'tipout', roles: HOURS.roles, tipouts: [{ to: 'server', pct: 90 }] }).field, 'tipouts', 'a tip-out over 50%');
  assert.strictEqual(R.validateRules({ method: 'points', roles: [{ name: 'Server', points: 9 }] }).field, 'roles');
  const r = R.validateRules({ method: 'hours', roles: [{ name: '<i>Server</i>' }, { name: 'Server' }] }).rules;
  assert.deepStrictEqual(r.roles.map((x) => [x.key, x.name]), [['server', 'Server'], ['server2', 'Server']], 'keys stay unique');
  assert.strictEqual(R.validateSetup({ ...HOURS, people: Array.from({ length: 61 }, (_, i) => ({ name: `P${i}` })) }).field, 'people');
});

/* ---------------- pure: receipts, week, CSV, QR ---------------- */

test('the share card: numbers and first names only, one person or the shift', () => {
  const b = build(TODAY);
  const whole = R.shareCard(b.shift, b.result, null, 'now');
  assert.strictEqual(whole.people.length, 9);
  const mine = R.shareCard(b.shift, b.result, 'pmaya', 'now');
  assert.deepStrictEqual([mine.kind, mine.people.length, mine.people[0].name], ['person', 1, 'Maya']);
  const text = JSON.stringify(mine);
  for (const other of PEOPLE.filter((p) => p.id !== 'pmaya')) assert.ok(!text.includes(`"${other.name}"`), `${other.name} is not on Maya's receipt`);
  assert.ok(!/drawer|notes|email|uid|Copper Fox/.test(JSON.stringify(whole)), 'no drawer, no notes, no account, no venue');
  assert.deepStrictEqual(Object.keys(whole).sort(), ['check', 'date', 'headcount', 'kind', 'method', 'methodLine', 'part', 'partLabel', 'people', 'pieces', 'pool', 'sharedAt', 'v']);
  assert.match(R.receiptText(b.shift, b.result), /Paid out \$1,601\.60 = tips in \$1,601\.60 ✓ balanced to the cent/);
});

test('the week and the CSV: totals per person, tips per hour, formula injection defused', () => {
  const b = build(TODAY);
  const w = R.week(b.items, R.weekStart(b.friday));
  assert.strictEqual(w.total, b.items.reduce((s, it) => s + it.result.totalIn, 0));
  assert.strictEqual(w.people.reduce((s, p) => s + p.total, 0), w.total, 'per-person totals add up to the week');
  const luis = w.people.find((p) => p.name === 'Luis');
  assert.strictEqual(luis.perHour, Math.round((luis.total * 4) / luis.q));
  const evil = R.validateRules({ method: 'hours', roles: [{ key: 'x', name: '=SUM(A1:A9)' }] }).rules;
  const one = run(evil, [person('Maya', 'x', 4)], { card: '40' });
  const csv = R.exportCsv([{ shift: one.shift, result: one.r }]);
  assert.ok(csv.startsWith('﻿Date,Shift,Name,Role'));
  assert.ok(csv.includes(",'=SUM(A1:A9),"), 'a role name that is a formula is text');
  assert.ok(csv.includes(',4,40.00,0.00,40.00,10.00,40.00,'), 'our own numbers stay numbers');
});

test('QR codes are real QR codes', () => {
  const m = Q.matrix('https://challenge.strongtechnicalconsulting.com/tipout/s/AbCdEfGhIjKlMnOpQrStUv');
  assert.ok(m.length >= 21 && (m.length - 17) % 4 === 0, 'a real QR size');
  for (const [r, c] of [[0, 0], [0, m.length - 7], [m.length - 7, 0]]) {
    assert.deepStrictEqual([m[r][c], m[r + 1][c + 1], m[r + 2][c + 2]], [1, 0, 1], 'finder pattern');
  }
  assert.ok(!/[<>"]"/.test(Q.svg('x', '"><script>')), 'the label cannot break out');
});

test('a model’s reading of a POS report is cleaned before anyone sees it', () => {
  assert.deepStrictEqual(ai.cleanReading({ readable: true, cardTips: '$1,284.605', cashTips: '-40', foodSales: '99999999', confidence: 'certain', note: '<b>hi</b>' }),
    { proposal: { card: '1284.61', cash: '', sales: '' }, filled: ['card'], dropped: ['cash tips', 'food sales'], confidence: 'low', note: 'hi' });
  assert.strictEqual(ai.cleanReading({ readable: false }), null);
  assert.strictEqual(ai.cleanReading({ readable: true, cardTips: '', cashTips: '', foodSales: '100' }), null, 'no tips, no proposal');
  assert.strictEqual(ai.TOOL.name, 'read_tip_report');
});

test('the sample tells the story it says it does', () => {
  const d = demo(TODAY);
  assert.strictEqual(d.result.totalIn, 160160);
  assert.strictEqual(d.result.check.balanced, true);
  assert.strictEqual(d.envelopes.status, 'exact');
  assert.strictEqual(d.result.headsUp, null, 'Dana the supervisor is on the roster but off tonight');
  assert.strictEqual(d.setup.people.length, 10);
  assert.ok(d.week.shifts >= 1 && d.week.days.every((x) => x.date <= R.addDays(TODAY, 6)));
  assert.ok(demo('2026-09-25').shifts.every((s) => s.date <= '2026-09-25'), 'no sample shift from the future');
  assert.strictEqual(SETUP.roles.find((r) => r.key === 'supervisor').manager, true);
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { TIPOUT_MEMORY: '1' }], ['./lib/fakeai', { TIPOUT_FAKE_AI: '1' }], ['./server', { TIPOUT_FAKE_AI: '1', TIPOUT_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, TIPOUT_MEMORY: '', TIPOUT_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, TIPOUT_MEMORY: '', TIPOUT_COLLECTION_PREFIX: 'tipout_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8');
  assert.ok(/TIPOUT_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 8, 'every Firestore path is prefixed');
});

/* ---------------- over HTTP ---------------- */

test('signed out: the sample, the rules and the page work with zero model calls; nothing private does', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = await anon('GET', '/api/meta');
  assert.deepStrictEqual(meta.data.templates.map((t) => t.key), ['hours', 'points', 'tipout']);
  const d = await anon('GET', '/api/demo');
  assert.deepStrictEqual([d.status, d.data.demo, d.data.result.totalIn], [200, true, 160160]);
  for (const f of ['rules.js', 'qr.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('src="app.js"') && html.includes('href="app.css"') && !/(src|href)="\//.test(html), 'relative asset links only');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['PUT', '/api/setup'], ['GET', '/api/shifts'], ['POST', '/api/shifts'], ['GET', '/api/shifts/abcdefghijkl'], ['PUT', '/api/shifts/abcdefghijkl'],
    ['DELETE', '/api/shifts/abcdefghijkl'], ['POST', '/api/shifts/abcdefghijkl/share'], ['DELETE', '/api/shifts/abcdefghijkl/share'], ['GET', '/api/week'], ['GET', '/api/export.csv'], ['POST', '/api/snap']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' || m === 'DELETE' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  // A stranger's 5 MB photo is turned away at the door, unread...
  const big = await anon('POST', '/api/snap', { image: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } });
  assert.strictEqual(big.status, 401, 'the gate answers before the 6 MB parser reads anything');
  // ...and every other route keeps the small limit.
  assert.strictEqual((await anon('POST', '/api/shifts', { crew: 'x'.repeat(200 * 1024) })).status, 413);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the snap route’s gates come before its body parser, in order', () => {
  const layer = app._router.stack.find((l) => l.route && l.route.path === '/api/snap');
  const names = layer.route.stack.map((l) => l.handle.name || '(anon)');
  assert.deepStrictEqual(names.slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
});

let maya, luis, eve;
const SHIFT = {};

async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}

const crewOf = (setup, hours) => setup.people.filter((p) => hours[p.name] !== undefined).map((p) => ({ pid: p.id, name: p.name, role: p.role, hours: hours[p.name] }));
const rulesOf = (s) => ({ method: s.method, restBy: s.restBy, cashDollars: s.cashDollars, roles: s.roles, tipouts: s.tipouts });

test('pool rules: validated, stored under the manager, returned by /api/me', async () => {
  maya = await register('maya.lead@example.com');
  assert.strictEqual((await maya('PUT', '/api/setup', { method: 'nope', roles: [] })).status, 400);
  const r = await maya('PUT', '/api/setup', { ...R.template('tipout'), people: [{ name: 'Maya Lopez', role: 'server' }, { name: '<b>Jordan</b>', role: 'server' }, { name: 'Luis', role: 'bartender' }, { name: 'Marco', role: 'kitchen' }, { name: 'Dana', role: 'server' }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(r.data.setup.people.map((p) => p.name), ['Maya', 'Jordan', 'Luis', 'Marco', 'Dana']);
  const me = await maya('GET', '/api/me');
  assert.deepStrictEqual(me.data.setup.people.map((p) => p.id), r.data.setup.people.map((p) => p.id));
  SHIFT.setup = me.data.setup;
});

test('a shift is saved as inputs and recomputed on every read; strangers get 404', async () => {
  const s = SHIFT.setup;
  const body = { date: '2026-09-26', part: 'dinner', card: '812.40', cash: '188.00', sales: '3100', crew: crewOf(s, { Maya: 6.5, Jordan: 6, Luis: 7, Marco: 8 }), rules: rulesOf(s), drawer: { 2000: 6, 1000: 3, 500: 4, 100: 18 } };
  assert.strictEqual((await maya('POST', '/api/shifts', { ...body, crew: crewOf(s, { Maya: 0 }) })).status, 400, 'nobody with hours');
  assert.strictEqual((await maya('POST', '/api/shifts', { ...body, date: '2027-01-01' })).status, 400);
  // What the page sends: the dollars as typed and hours as quarter-hours -
  // saved and read back as exactly the split the page drew.
  const page = { ...body, crew: body.crew.map((p) => ({ pid: p.pid, name: p.name, role: p.role, q: R.toQuarters(p.hours) })) };
  const local = R.split(R.validateShift(page, TODAY).shift);
  const r = await maya('POST', '/api/shifts', page);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(r.data.result, JSON.parse(JSON.stringify(local)), 'the server’s split is the page’s split, cent for cent');
  SHIFT.id = r.data.id;
  assert.strictEqual(r.data.result.check.balanced, true);
  assert.strictEqual(r.data.result.totalIn, 100040);
  assert.ok(r.data.envelopes && r.data.text.includes('TIP RECEIPT'));
  const raw = await store.get(`shifts/${uidOf('maya.lead@example.com')}/items`, SHIFT.id);
  assert.ok(!('result' in raw) && !('people' in raw), 'only the inputs are stored');
  const got = await maya('GET', `/api/shifts/${SHIFT.id}`);
  assert.deepStrictEqual(got.data.result, r.data.result);
  eve = await register('eve@example.com');
  assert.strictEqual((await eve('GET', `/api/shifts/${SHIFT.id}`)).status, 404);
  assert.strictEqual((await eve('PUT', `/api/shifts/${SHIFT.id}`, body)).status, 404);
  assert.strictEqual((await eve('DELETE', `/api/shifts/${SHIFT.id}`)).status, 404);
  assert.strictEqual((await eve('POST', `/api/shifts/${SHIFT.id}/share`)).status, 404);
  assert.deepStrictEqual((await eve('GET', '/api/shifts')).data.shifts, []);
  SHIFT.body = body;
});

test('receipt links: unguessable, public, numbers and first names only, escaped headers, read-only', async () => {
  const r = await maya('POST', `/api/shifts/${SHIFT.id}/share`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const sh = r.data.share;
  const tokens = [sh.token, ...sh.people.map((p) => p.token)];
  assert.strictEqual(tokens.length, 5);
  assert.strictEqual(new Set(tokens).size, 5);
  for (const t of tokens) assert.match(t, /^[A-Za-z0-9_-]{22}$/, '128 random bits, url-safe');
  assert.ok(!tokens.some((t) => t.includes(SHIFT.id)), 'the shift id is not in a link');
  const anon = client();
  const whole = await anon('GET', `/api/shared/${sh.token}`);
  assert.deepStrictEqual([whole.status, whole.data.kind, whole.data.people.length, whole.data.preview], [200, 'shift', 4, false]);
  assert.strictEqual(whole.headers.get('referrer-policy'), 'no-referrer');
  assert.match(whole.headers.get('x-robots-tag'), /noindex/);
  const mayaLink = sh.people.find((p) => p.name === 'Maya');
  const own = await anon('GET', `/api/shared/${mayaLink.token}`);
  assert.deepStrictEqual([own.data.kind, own.data.people.map((p) => p.name)], ['person', ['Maya']]);
  assert.ok(!/Lopez|example\.com|maya\.lead|drawer|uid/.test(own.text), 'no surname, no email, no account, no drawer');
  assert.strictEqual((await maya('GET', `/api/shared/${sh.token}`)).data.preview, true, 'the owner sees it is a preview');
  const page = await anon('GET', `/s/${mayaLink.token}`);
  assert.ok(page.text.includes('<base href="../">'));
  assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
  for (const bad of ['AAAAAAAAAAAAAAAAAAAAAA', 'short', '../../etc/passwd', 'A'.repeat(200)]) assert.strictEqual((await anon('GET', `/api/shared/${encodeURIComponent(bad)}`)).status, 404, bad);
  for (const m of ['POST', 'PUT', 'DELETE']) assert.strictEqual((await anon(m, `/api/shared/${sh.token}`, m === 'DELETE' ? undefined : {})).status, 405);
  assert.strictEqual((await anon('POST', `/s/${sh.token}`, {})).status, 405);
  // Sharing again keeps everyone's link.
  const again = await maya('POST', `/api/shifts/${SHIFT.id}/share`);
  assert.strictEqual(again.data.share.token, sh.token);
  assert.deepStrictEqual(again.data.share.people.map((p) => p.token).sort(), sh.people.map((p) => p.token).sort());
  SHIFT.share = sh;
});

test('a corrected shift updates its links at once; a person taken off loses theirs', async () => {
  const s = SHIFT.setup;
  const body = { ...SHIFT.body, card: '900.00', crew: crewOf(s, { Maya: 6.5, Jordan: 6, Luis: 7 }) };
  const r = await maya('PUT', `/api/shifts/${SHIFT.id}`, body);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const anon = client();
  const whole = await anon('GET', `/api/shared/${SHIFT.share.token}`);
  assert.strictEqual(whole.data.pool.card, 90000);
  assert.strictEqual(whole.data.people.length, 3);
  const marco = SHIFT.share.people.find((p) => p.name === 'Marco');
  assert.strictEqual((await anon('GET', `/api/shared/${marco.token}`)).status, 404, 'Marco was not on the corrected shift');
  const maya2 = SHIFT.share.people.find((p) => p.name === 'Maya');
  assert.strictEqual((await anon('GET', `/api/shared/${maya2.token}`)).data.people[0].total, r.data.result.people.find((p) => p.name === 'Maya').total);
});

test('the week and the CSV export', async () => {
  const s = SHIFT.setup;
  await maya('POST', '/api/shifts', { ...SHIFT.body, date: '2026-09-24', crew: crewOf(s, { Maya: 5, Luis: 5 }), card: '300', cash: '0', drawer: null });
  const w = await maya('GET', '/api/week?start=2026-09-23');
  assert.strictEqual(w.status, 200);
  assert.deepStrictEqual([w.data.week.start, w.data.week.end, w.data.week.shifts], ['2026-09-21', '2026-09-27', 2]);
  assert.strictEqual(w.data.week.people.reduce((t, p) => t + p.total, 0), w.data.week.total);
  assert.ok(w.data.shifts.every((x) => x.id && x.total));
  const empty = await maya('GET', '/api/week?start=2026-08-03');
  assert.strictEqual(empty.data.week.shifts, 0);
  const csv = await maya('GET', '/api/export.csv?from=2026-09-21&to=2026-09-27');
  assert.strictEqual(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /tipout-2026-09-21-to-2026-09-27\.csv/);
  assert.strictEqual(csv.text.trim().split('\r\n').length, 1 + 3 + 2);
  assert.strictEqual((await maya('GET', '/api/export.csv?from=2025-01-01&to=2026-09-27')).status, 400, 'a bounded range');
  assert.strictEqual((await eve('GET', '/api/export.csv?from=2026-09-21&to=2026-09-27')).text.trim().split('\r\n').length, 1, 'nobody else’s shifts');
});

test('snap a POS report: bytes checked before any spend, a proposal back, nothing stored', async () => {
  luis = await register('luis@example.com');
  const dump = store._dump();
  let calls = await modelCalls();
  assert.strictEqual((await luis('POST', '/api/snap', { image: { type: 'image/jpeg', data: Buffer.from('%PDF-1.4 not a photo').toString('base64') } })).status, 400);
  assert.strictEqual((await luis('POST', '/api/snap', {})).status, 400);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a non-image');
  const good = await luis('POST', '/api/snap', { image: { type: 'image/jpeg', data: jpeg('TIPREPORT') } });
  assert.strictEqual(good.status, 200, JSON.stringify(good.data));
  assert.deepStrictEqual(good.data.proposal, { card: '1284.60', cash: '317.00', sales: '4920.00' });
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  calls += 1;
  const messy = await luis('POST', '/api/snap', { image: { type: 'image/jpeg', data: jpeg('INJECT') } });
  assert.deepStrictEqual(messy.data.proposal, { card: '1284.61', cash: '', sales: '' });
  assert.ok(!/</.test(messy.text));
  const blank = await luis('POST', '/api/snap', { image: { type: 'image/jpeg', data: jpeg('BLANK') } });
  assert.deepStrictEqual([blank.status, /couldn’t read/.test(blank.data.error)], [422, true]);
  assert.strictEqual((await luis('POST', '/api/snap', { image: { type: 'image/jpeg', data: jpeg('NOTIPS') } })).status, 422);
  const up = await luis('POST', '/api/snap', { image: { type: 'image/jpeg', data: jpeg('UPSTREAM401') } });
  assert.deepStrictEqual([up.status, /fake_upstream/.test(up.text)], [502, false], 'a provider 401 is not "sign in", and its body is not passed on');
  assert.strictEqual((await luis('POST', '/api/snap', { image: { type: 'image/jpeg', data: 'A'.repeat(7 * 1024 * 1024) } })).status, 413);
  assert.strictEqual(store._dump(), dump, 'no photo and no reading stored');
});

test('out of credit: 402 before any model call - and before the big body is read', async () => {
  await identityStore.merge('users', uidOf('luis@example.com'), { spentUsd: 100 });
  await settle();
  const calls = await modelCalls();
  const r = await luis('POST', '/api/snap', { image: { type: 'image/jpeg', data: jpeg('TIPREPORT') } });
  assert.strictEqual(r.status, 402);
  const big = await luis('POST', '/api/snap', { image: { type: 'image/jpeg', data: 'A'.repeat(7 * 1024 * 1024) } });
  assert.strictEqual(big.status, 402, '402, not 413: the budget gate runs before the parser');
  await luis('PUT', '/api/setup', { ...R.template('hours'), people: [{ name: 'Luis', role: 'server' }] });
  const setup = (await luis('GET', '/api/me')).data.setup;
  const saved = await luis('POST', '/api/shifts', { date: '2026-09-26', card: '50', crew: crewOf(setup, { Luis: 4 }), rules: rulesOf(setup) });
  assert.strictEqual(saved.status, 200, 'splitting and saving are free');
  assert.strictEqual((await luis('POST', `/api/shifts/${saved.data.id}/share`)).status, 200);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call was made');
  await identityStore.merge('users', uidOf('luis@example.com'), { spentUsd: 0 });
});

test('deleting a shift kills its links; caps hold', async () => {
  const r = await maya('DELETE', `/api/shifts/${SHIFT.id}`);
  assert.strictEqual(r.status, 200);
  const anon = client();
  assert.strictEqual((await anon('GET', `/api/shared/${SHIFT.share.token}`)).status, 404);
  for (const p of SHIFT.share.people) assert.strictEqual((await anon('GET', `/api/shared/${p.token}`)).status, 404);
  assert.strictEqual((await maya('GET', `/api/shifts/${SHIFT.id}`)).status, 404);
  // Revoke without deleting.
  const s = SHIFT.setup;
  const again = await maya('POST', '/api/shifts', SHIFT.body);
  const sh = (await maya('POST', `/api/shifts/${again.data.id}/share`)).data.share;
  assert.strictEqual((await maya('DELETE', `/api/shifts/${again.data.id}/share`)).status, 200);
  assert.strictEqual((await anon('GET', `/api/shared/${sh.token}`)).status, 404);
  assert.strictEqual((await maya('GET', `/api/shifts/${again.data.id}`)).data.share, null);
  // Eight shifts a day, and the per-manager total.
  for (let i = 0; i < 7; i++) await maya('POST', '/api/shifts', { ...SHIFT.body, date: '2026-09-20', crew: crewOf(s, { Maya: 4 }) });
  const eighth = await maya('POST', '/api/shifts', { ...SHIFT.body, date: '2026-09-20', crew: crewOf(s, { Maya: 4 }) });
  assert.strictEqual(eighth.status, 200);
  assert.strictEqual((await maya('POST', '/api/shifts', { ...SHIFT.body, date: '2026-09-20', crew: crewOf(s, { Maya: 4 }) })).status, 409);
  await store.merge('setups', uidOf('eve@example.com'), { shiftCount: S.LIMITS.shifts });
  await eve('PUT', '/api/setup', { ...R.template('hours'), people: [{ name: 'Eve', role: 'server' }] });
  const es = (await eve('GET', '/api/me')).data.setup;
  assert.strictEqual((await eve('POST', '/api/shifts', { date: '2026-09-26', card: '5', crew: crewOf(es, { Eve: 1 }), rules: rulesOf(es) })).status, 409);
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use('/tipout', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/tipout`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
