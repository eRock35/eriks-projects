// End to end, against the memory store and the fake model:
//   CHASER_MEMORY=1 CHASER_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// Drives the real Express app over HTTP, mounted under /chaser the way the lab
// mounts it, so the auth cookie, the budget gate, every ownership check and
// the public statement link are exercised as deployed rather than as
// unit-tested pieces. The pure rules (ranking, forecast, fees, grades) get
// fixed-date tests first, because "today" is the input they all depend on.

const assert = require('assert');
const http = require('http');
const express = require('express');

if (process.env.CHASER_MEMORY !== '1' || process.env.CHASER_FAKE_AI !== '1') {
  console.error('run with CHASER_MEMORY=1 CHASER_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const B = require('../lib/book');
const L = require('../lib/ladder');
const photo = require('../lib/photo');
const { demo } = require('../lib/demo');

let base;
function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, headers: res.headers };
  };
}

const uidOf = (email) => Buffer.from(email).toString('base64url');
const spentBy = async (email) => Number(((await identityStore.get('users', uidOf(email))) || {}).spentUsd || 0);
const modelCalls = async () => (await identityStore.list('usage')).length;
const TODAY = B.utcToday();
const day = (n) => B.addDays(TODAY, n);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]).toString('base64');
const BLANK = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('BLANK page'), Buffer.alloc(500, 3)]).toString('base64');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- pure rules, fixed dates ---------------- */

const T = '2026-09-24';
const mk = (id, clientId, dollars, due, extra = {}) => ({
  id, clientId, number: id, amountCents: dollars * 100, currency: 'USD', issued: B.addDays(due, -30), due,
  payments: [], chases: [], promises: [], stage: 0, ...extra,
});

test('money is integer cents; "free" is no amount, not $0', () => {
  assert.strictEqual(B.toCents('$1,250.50'), 125050);
  assert.strictEqual(B.toCents('about 40'), 4000);
  assert.strictEqual(B.toCents(19.99), 1999);
  assert.strictEqual(B.toCents('free'), null);
  assert.strictEqual(B.toCents(''), null);
  assert.strictEqual(B.toCents('-40'), null, 'a negative is refused, not stripped');
  assert.strictEqual(B.toCents(1e12), B.LIMITS.cents);
  assert.strictEqual(B.isoDay('2026-02-30'), null);
  assert.strictEqual(B.isoDay('2026-02-28'), '2026-02-28');
  assert.strictEqual(B.termsDaysOf('Net 14'), 14);
  assert.strictEqual(B.termsDaysOf('Due on receipt'), 0);
});

test('Today: a 45-day-late $5,000 beats a 3-day-late $200', () => {
  const clients = [{ id: 'a', name: 'Big Co' }, { id: 'b', name: 'Small Co' }];
  const v = B.todayView([mk('small', 'b', 200, B.addDays(T, -3)), mk('big', 'a', 5000, B.addDays(T, -45))], clients, B.SETTINGS_DEFAULTS, T);
  assert.deepStrictEqual(v.chase.map((r) => r.id), ['big', 'small']);
  assert.strictEqual(v.chase[0].score, 5000 * 46);
  assert.strictEqual(v.totals.overdueCents, 520000);
  assert.strictEqual(v.totals.outstandingCents, 520000);
});

test('Today: a broken promise ranks up, and a live one waits', () => {
  const clients = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  const v = B.todayView([
    mk('kept-quiet', 'a', 1000, B.addDays(T, -10)),
    mk('broke', 'b', 1000, B.addDays(T, -10), { promises: [{ date: B.addDays(T, -2), at: `${B.addDays(T, -5)}T10:00:00Z` }] }),
    mk('promised', 'c', 3000, B.addDays(T, -10), { promises: [{ date: B.addDays(T, 2), at: `${T}T10:00:00Z` }] }),
  ], clients, B.SETTINGS_DEFAULTS, T);
  assert.deepStrictEqual(v.chase.map((r) => r.id), ['broke', 'kept-quiet']);
  assert.ok(v.chase[0].promiseBroken);
  assert.ok(/didn't pay/.test(v.chase[0].why[0]));
  assert.strictEqual(v.chase[0].score, Math.round(1000 * 11 * 1.6));
  assert.strictEqual(v.waiting.find((r) => r.id === 'promised').status, 'promised');
  // Even a much bigger broken-promise invoice cannot hide from a chase the day after.
  const w = B.todayView([mk('big', 'a', 1000, B.addDays(T, -10)), mk('b2', 'b', 800, B.addDays(T, -10), { promises: [{ date: B.addDays(T, -1) }] })], clients, B.SETTINGS_DEFAULTS, T);
  assert.strictEqual(w.chase[0].id, 'b2', 'a broken promise lifts $800 above $1,000');
});

test('Today: chased recently waits its gap; a promise broken since the chase is due again', () => {
  const clients = [{ id: 'a', name: 'A' }];
  const chased = mk('x', 'a', 500, B.addDays(T, -20), { stage: 1, lastChasedAt: `${B.addDays(T, -2)}T09:00:00Z`, chases: [{ kind: 'nudge', at: `${B.addDays(T, -2)}T09:00:00Z` }] });
  let v = B.todayView([chased], clients, B.SETTINGS_DEFAULTS, T);
  assert.strictEqual(v.chase.length, 0);
  assert.strictEqual(v.waiting[0].nextChaseOn, B.addDays(T, 3), 'a nudge waits five days');
  chased.promises = [{ date: B.addDays(T, -1) }];
  v = B.todayView([chased], clients, B.SETTINGS_DEFAULTS, T);
  assert.strictEqual(v.chase.length, 1, 'the promise broke after the nudge');
});

test('forecast: expected dates from promises and client history, buckets by week', () => {
  const clients = [{ id: 'a', name: 'Slow Co' }, { id: 'b', name: 'New Co' }, { id: 'c', name: 'Promiser' }];
  const invoices = [
    // Slow Co's history: two paid, 10 and 20 days late -> average 15.
    mk('h1', 'a', 1000, B.addDays(T, -100), { payments: [{ id: 'p', cents: 100000, date: B.addDays(T, -90) }] }),
    mk('h2', 'a', 1000, B.addDays(T, -60), { payments: [{ id: 'q', cents: 100000, date: B.addDays(T, -40) }] }),
    // Due in 2 days -> expected in 17 days (week 2), likelihood 0.95 - 0.075 = 0.875 -> 0.88.
    mk('o1', 'a', 2000, B.addDays(T, 2)),
    // New client, due in 3 days, no history -> book average 15 -> day 18 (week 2), 0.75.
    mk('o2', 'b', 1000, B.addDays(T, 3)),
    // Promised in 4 days -> week 0, 0.85.
    mk('o3', 'c', 400, B.addDays(T, -5), { promises: [{ date: B.addDays(T, 4) }] }),
    // Slow Co, 30 days late: expected due+15 has passed -> a week from today (week 1), 0.88.
    mk('o4', 'a', 100, B.addDays(T, -30)),
  ];
  const ds = B.deriveAll(invoices, T);
  const cards = B.scorecards(clients, ds, 'USD');
  const f = B.forecast(ds, cards, T, 'USD');
  assert.strictEqual(cards.find((c) => c.id === 'a').avgDaysLate, 15);
  assert.strictEqual(f.weeks.length, 4);
  assert.strictEqual(f.weeks[0].likelyCents, 34000); // 400 x 0.85
  assert.strictEqual(f.weeks[1].likelyCents, 8800); // 100 x 0.88
  assert.strictEqual(f.weeks[2].likelyCents, 176000 + 75000); // 2000 x 0.88 + 1000 x 0.75
  assert.strictEqual(f.weeks[3].likelyCents, 0);
  assert.strictEqual(f.weeks[0].dueCents, 300000, 'face value due this week: o1 + o2');
  assert.strictEqual(f.likelyCents, 34000 + 8800 + 251000);
  assert.strictEqual(f.byDate, B.addDays(T, 27));
});

test('late fees: flat, percent per month pro rata, grace days - and none by default', () => {
  const d = B.derive(mk('f', 'a', 1000, B.addDays(T, -35)), T);
  assert.strictEqual(B.lateFee(d, { mode: 'none' }, T).cents, 0);
  assert.strictEqual(B.lateFee(d, B.SETTINGS_DEFAULTS.lateFee, T).applies, false);
  const flat = B.lateFee(d, { mode: 'flat', flatCents: 2500, graceDays: 7 }, T);
  assert.strictEqual(flat.cents, 2500);
  assert.ok(flat.applies);
  const pct = B.lateFee(d, { mode: 'percent', pctPerMonth: 1.5, graceDays: 5 }, T);
  assert.strictEqual(pct.days, 30);
  assert.strictEqual(pct.cents, 1500, '1.5% of $1,000 for exactly one 30-day month');
  const pct2 = B.lateFee(d, { mode: 'percent', pctPerMonth: 2, graceDays: 20 }, T);
  assert.strictEqual(pct2.cents, 1000, '15 days of 2% on $1,000');
  const inGrace = B.lateFee(B.derive(mk('g', 'a', 1000, B.addDays(T, -5)), T), { mode: 'flat', flatCents: 2500, graceDays: 7 }, T);
  assert.strictEqual(inGrace.cents, 0);
  assert.ok(/grace/.test(inGrace.rule));
  const partly = B.derive(mk('h', 'a', 1000, B.addDays(T, -35), { payments: [{ id: 'x', cents: 60000, date: T }] }), T);
  assert.strictEqual(B.lateFee(partly, { mode: 'percent', pctPerMonth: 1.5, graceDays: 5 }, T).cents, 600, 'interest is on the balance');
});

test('scorecard: days late, on-time %, grade and the style that works', () => {
  const inv = [
    mk('a1', 'c', 1000, B.addDays(T, -100), { payments: [{ id: 'p', cents: 100000, date: B.addDays(T, -100) }] }), // on time
    mk('a2', 'c', 1000, B.addDays(T, -70), {
      payments: [{ id: 'q', cents: 100000, date: B.addDays(T, -50) }], // 20 late
      chases: [{ kind: 'nudge', at: `${B.addDays(T, -65)}T10:00:00Z` }, { kind: 'followup', at: `${B.addDays(T, -55)}T10:00:00Z` }],
    }),
    mk('a3', 'c', 1000, B.addDays(T, -40), {
      payments: [{ id: 'r', cents: 50000, date: B.addDays(T, -30) }, { id: 's', cents: 50000, date: B.addDays(T, -10) }], // 30 late
      chases: [{ kind: 'nudge', at: `${B.addDays(T, -35)}T10:00:00Z` }, { kind: 'followup', at: `${B.addDays(T, -25)}T10:00:00Z` }, { kind: 'firm', at: `${B.addDays(T, -15)}T10:00:00Z` }],
    }),
    mk('a4', 'c', 500, B.addDays(T, -12), { promises: [{ date: B.addDays(T, -3) }] }), // open, 12 late, 1 broken
  ];
  const s = B.scorecard({ id: 'c', name: 'Client' }, B.deriveAll(inv, T), 'USD');
  assert.strictEqual(s.paidCount, 3);
  assert.strictEqual(s.avgDaysLate, 16.7);
  assert.strictEqual(s.onTimePct, 33);
  assert.strictEqual(s.totalPaidCents, 300000);
  assert.strictEqual(s.outstandingCents, 50000);
  assert.strictEqual(s.brokenPromises, 1);
  // 100 - 8.35 - 10.05 - 6 - 10 = 65.6
  assert.strictEqual(s.points, 65.6);
  assert.strictEqual(s.grade, 'C');
  assert.strictEqual(s.styleRung, 2, 'paid after 0, 2 and 3 rungs -> median 2');
  assert.ok(/follow-up/.test(s.style));
  const fresh = B.scorecard({ id: 'n', name: 'New' }, [], 'USD');
  assert.strictEqual(fresh.grade, null, 'no history, no grade');
  const off = B.scorecard({ id: 'w', name: 'W' }, B.deriveAll([mk('w1', 'w', 100, B.addDays(T, -200), { writtenOff: true }), mk('w3', 'w', 100, B.addDays(T, -150), { writtenOff: true }), mk('w2', 'w', 100, B.addDays(T, -90))], T), 'USD');
  assert.strictEqual(off.grade, 'F');
});

test('template chases: tone, a broken promise named, a fee only when asked', () => {
  const d = B.derive(mk('t', 'a', 1200, B.addDays(T, -20), { promises: [{ date: B.addDays(T, -3) }] }), T);
  const settings = { ...B.SETTINGS_DEFAULTS, businessName: 'Studio', yourName: 'Ana', paymentLink: 'https://pay.example/x', lateFee: { mode: 'flat', flatCents: 2500, graceDays: 7 } };
  const f = L.factsFor(d, { name: 'Acme Ltd', contactName: 'Jo Smith' }, settings, T, { kind: 'firm' });
  const t = L.template(f);
  assert.ok(t.body.startsWith('Hi Jo,'));
  assert.ok(/\$1,200/.test(t.body) && /pay\.example/.test(t.body));
  assert.ok(/hasn't come through/.test(t.body), 'the broken promise is referenced');
  assert.ok(!/late fee/i.test(t.body), 'no fee unless asked');
  assert.ok(t.body.endsWith('Thanks,\nAna\nStudio'));
  const withFee = L.template(L.factsFor(d, { name: 'Acme Ltd' }, settings, T, { kind: 'firm', includeFee: true }));
  assert.ok(/late fee of \$25/.test(withFee.body) && /\$1,225/.test(withFee.body));
  assert.ok(withFee.body.startsWith('Hi Acme Ltd,'), 'no contact name: greet the business');
  assert.ok(t.sms.length <= 320);
  const warm = L.template({ ...f, kind: 'nudge', tone: 10 });
  const cold = L.template({ ...f, kind: 'nudge', tone: 90 });
  assert.notStrictEqual(warm.body, cold.body);
});

test('photos: JPEG passes; lies, wrong types and oversize are refused', () => {
  assert.strictEqual(photo.validate({ type: 'image/jpeg', data: JPEG }).mediaType, 'image/jpeg');
  assert.strictEqual(photo.validate({ data: 'data:image/jpeg;base64,' + JPEG }).mediaType, 'image/jpeg');
  assert.throws(() => photo.validate({ type: 'image/jpeg', data: Buffer.from('%PDF-1.7').toString('base64') }), /JPEG, PNG or WebP/);
  assert.throws(() => photo.validate({ type: 'image/gif', data: JPEG }), /JPEG, PNG or WebP/);
  assert.throws(() => photo.validate(null), /Add a photo/);
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(photo.MAX_BYTES + 10)]).toString('base64');
  assert.throws(() => photo.validate({ type: 'image/jpeg', data: big }), /too large/);
});

test('the demo book is realistic and runs through the real arithmetic', () => {
  const d = demo(T);
  assert.strictEqual(d.clients.length, 6);
  assert.ok(d.invoices.length >= 12);
  assert.deepStrictEqual(d.today.chase.map((r) => r.number), ['NL-1033', 'NL-1044', 'NL-1055']);
  assert.ok(d.today.chase[1].promiseBroken, 'a broken promise is in the sample');
  assert.ok(d.today.waiting.some((r) => r.status === 'promised'));
  assert.ok(d.clients.some((c) => c.grade === 'A') && d.clients.some((c) => c.grade === 'F'));
  assert.ok(d.drafts['demo-i4'].body.includes('$5,200'));
  assert.strictEqual(d.drafts['demo-i4'].source, 'sample');
  assert.ok(d.today.forecast.likelyCents > 0);
  assert.ok(d.today.totals.collectedMonthCents > 0, 'something came in this month');
});

/* ---------------- over HTTP ---------------- */

test('signed out: health, meta and the demo work with zero model calls; nothing else does', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  assert.strictEqual((await anon('GET', '/api/meta')).data.stages.length, 4);
  const d = await anon('GET', '/api/demo');
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.data.demo, true);
  assert.strictEqual(d.data.clients.length, 6);
  assert.ok(Object.keys(d.data.drafts).length >= 3);
  assert.strictEqual(await modelCalls(), before, 'the demo made no model call');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/today'], ['GET', '/api/invoices'], ['POST', '/api/invoices'], ['GET', '/api/clients'], ['POST', '/api/invoices/read'], ['POST', '/api/invoices/x/draft'], ['POST', '/api/invoices/x/template'], ['PUT', '/api/settings'], ['GET', '/api/wins']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  assert.strictEqual(await modelCalls(), before);
});

let alice, bob;
const ids = {};

test('register, sign out, sign back in; settings are cleaned', async () => {
  alice = client();
  const reg = await alice('POST', '/api/auth/register', { email: 'alice@example.com', password: 'correct horse battery' });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.data));
  let me = await alice('GET', '/api/me');
  assert.strictEqual(me.data.signedIn, true);
  assert.strictEqual(me.data.settings.setUp, false);
  assert.strictEqual(me.data.budget.remainingUsd, 2);
  await alice('POST', '/api/auth/logout');
  assert.strictEqual((await alice('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await alice('POST', '/api/auth/login', { email: 'alice@example.com', password: 'wrong password!!' })).status, 401);
  assert.strictEqual((await alice('POST', '/api/auth/login', { email: 'alice@example.com', password: 'correct horse battery' })).status, 200);
  const s = await alice('PUT', '/api/settings', {
    businessName: 'Alpine <Design>', yourName: 'Alice', signOff: 'Cheers,', tone: 250, paymentLink: 'javascript:alert(1)',
    paymentInstructions: 'Bank: 12-3456', contact: 'hi@alpine.example', currency: 'eur', termsDays: 14,
    lateFee: { mode: 'percent', pctPerMonth: 99, graceDays: 5 },
  });
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.data.businessName, 'Alpine Design');
  assert.strictEqual(s.data.tone, 100);
  assert.strictEqual(s.data.paymentLink, '', 'only https links');
  assert.strictEqual(s.data.currency, 'EUR');
  assert.strictEqual(s.data.lateFee.pctPerMonth, 10);
  const s2 = await alice('PUT', '/api/settings', { paymentLink: 'https://pay.example/alpine', currency: 'USD', tone: 30 });
  assert.strictEqual(s2.data.paymentLink, 'https://pay.example/alpine');
  assert.strictEqual(s2.data.businessName, 'Alpine Design', 'a partial save keeps the rest');
  me = await alice('GET', '/api/me');
  assert.strictEqual(me.data.settings.setUp, true);
});

test('clients: create, validate, no duplicates, edit, and delete only when empty', async () => {
  assert.strictEqual((await alice('POST', '/api/clients', { name: '' })).status, 400);
  assert.strictEqual((await alice('POST', '/api/clients', { name: 'X', email: 'not-an-email' })).status, 400);
  assert.strictEqual((await alice('POST', '/api/clients', { name: 'X', phone: '12' })).status, 400);
  const c = await alice('POST', '/api/clients', { name: 'Big <b>Co</b>', contactName: 'Bea Big', email: 'AP@BigCo.example', phone: '+1 (555) 010-0000' });
  assert.strictEqual(c.status, 200, JSON.stringify(c.data));
  assert.strictEqual(c.data.name, 'Big bCo/b');
  assert.strictEqual(c.data.email, 'ap@bigco.example');
  ids.big = c.data.id;
  assert.strictEqual((await alice('POST', '/api/clients', { name: 'big bco/b' })).status, 409);
  const e = await alice('PUT', `/api/clients/${ids.big}`, { name: 'Big Co' });
  assert.strictEqual(e.data.name, 'Big Co');
  assert.strictEqual(e.data.email, 'ap@bigco.example', 'editing the name keeps the rest');
  const tmp = await alice('POST', '/api/clients', { name: 'Temp' });
  assert.strictEqual((await alice('DELETE', `/api/clients/${tmp.data.id}`)).status, 200);
});

test('invoices: create with validation, terms become a due date, numbers are automatic', async () => {
  assert.strictEqual((await alice('POST', '/api/invoices', { clientId: ids.big })).status, 400, 'no amount');
  assert.strictEqual((await alice('POST', '/api/invoices', { clientId: ids.big, amount: 'free' })).status, 400);
  assert.strictEqual((await alice('POST', '/api/invoices', { clientId: ids.big, amount: 100, due: '2026-02-30' })).status, 400);
  assert.strictEqual((await alice('POST', '/api/invoices', { clientId: ids.big, amount: 100, issued: day(0), due: day(-1) })).status, 400);
  assert.strictEqual((await alice('POST', '/api/invoices', { clientId: 'nope', amount: 100 })).status, 404);
  assert.strictEqual((await alice('POST', '/api/invoices', { client: { name: '' }, amount: 100 })).status, 400);
  const big = await alice('POST', '/api/invoices', { clientId: ids.big, amount: '$5,000.00', issued: day(-75), due: day(-45), notes: 'Private: they are slow' }, { 'X-Local-Date': TODAY });
  assert.strictEqual(big.status, 200, JSON.stringify(big.data));
  assert.strictEqual(big.data.amountCents, 500000);
  assert.strictEqual(big.data.number, 'INV-1001');
  assert.strictEqual(big.data.daysLate, 45);
  assert.strictEqual(big.data.status, 'open');
  assert.strictEqual(big.data.currency, 'USD');
  ids.bigInv = big.data.id;
  const small = await alice('POST', '/api/invoices', { client: { name: 'Small Shop', email: 'owner@small.example', phone: '555 010 1234' }, number: 'S-7', amountCents: 20000, issued: day(-17), terms: 'Net 14' });
  assert.strictEqual(small.data.due, day(-3), 'Net 14 from the issue date');
  assert.strictEqual(small.data.number, 'S-7');
  ids.small = small.data.client.id;
  ids.smallInv = small.data.id;
  const again = await alice('POST', '/api/invoices', { client: { name: 'small shop' }, amount: 50, currency: 'gbp' });
  assert.strictEqual(again.data.client.id, ids.small, 'a client typed again is found, not duplicated');
  assert.strictEqual(again.data.currency, 'GBP');
  assert.strictEqual(again.data.due, day(14), 'the settings\' default terms');
  ids.gbp = again.data.id;
  const ed = await alice('PUT', `/api/invoices/${ids.gbp}`, { amount: 75, status: 'paid', payments: [{ cents: 7500 }], stage: 4 });
  assert.strictEqual(ed.data.amountCents, 7500);
  assert.strictEqual(ed.data.status, 'open', 'status, payments and stage are not editable');
  assert.strictEqual(ed.data.paidCents, 0);
  assert.strictEqual(ed.data.stage, 0);
});

test('Today over HTTP: ordering, totals by currency, the forecast', async () => {
  const t = await alice('GET', '/api/today', undefined, { 'X-Local-Date': TODAY });
  assert.strictEqual(t.status, 200);
  assert.deepStrictEqual(t.data.chase.map((r) => r.id), [ids.bigInv, ids.smallInv]);
  assert.strictEqual(t.data.totals.outstandingCents, 520000);
  assert.strictEqual(t.data.totals.overdueCents, 520000);
  assert.deepStrictEqual(t.data.totals.others.map((o) => [o.currency, o.outstandingCents]), [['GBP', 7500]], 'pounds are not added to dollars');
  assert.strictEqual(t.data.forecast.weeks.length, 4);
  assert.strictEqual(t.data.forecast.currency, 'USD');
  assert.strictEqual((await alice('GET', '/api/today?today=1999-01-01')).data.today, TODAY, 'an implausible local date is ignored');
});

test('partial payments: balances, limits, "mark paid", and a deleted payment reopens it', async () => {
  const inv = await alice('POST', '/api/invoices', { clientId: ids.big, amount: 1000, issued: day(-40), due: day(-10) });
  const id = inv.data.id;
  let r = await alice('POST', `/api/invoices/${id}/payments`, { amount: '400', date: day(-2), note: 'first half-ish' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.paidCents, 40000);
  assert.strictEqual(r.data.balanceCents, 60000);
  assert.strictEqual(r.data.status, 'open');
  assert.strictEqual(r.data.win, null);
  assert.ok(r.data.why.includes('part paid'));
  assert.strictEqual((await alice('POST', `/api/invoices/${id}/payments`, { amount: 700 })).status, 400, 'more than the balance');
  assert.strictEqual((await alice('POST', `/api/invoices/${id}/payments`, { amount: 10, date: day(5) })).status, 400, 'future-dated');
  assert.strictEqual((await alice('POST', `/api/invoices/${id}/payments`, { amount: 0 })).status, 400);
  assert.strictEqual((await alice('PUT', `/api/invoices/${id}`, { amount: 300 })).status, 400, 'the amount cannot drop below what was paid');
  r = await alice('POST', `/api/invoices/${id}/payments`, { full: true });
  assert.strictEqual(r.data.status, 'paid');
  assert.strictEqual(r.data.balanceCents, 0);
  assert.strictEqual(r.data.paidAt, TODAY);
  assert.strictEqual(r.data.win.cleared, true);
  assert.strictEqual(r.data.win.daysLate, 10);
  assert.strictEqual(r.data.win.streakWeeks, 1);
  assert.ok(r.data.newBadges.some((b) => b.key === 'first_paid'));
  assert.strictEqual((await alice('POST', `/api/invoices/${id}/payments`, { amount: 1 })).status, 409, 'paid in full');
  const pid = r.data.payments.find((p) => p.cents === 60000).id;
  r = await alice('DELETE', `/api/invoices/${id}/payments/${pid}`);
  assert.strictEqual(r.data.status, 'open');
  assert.strictEqual(r.data.balanceCents, 60000);
  assert.strictEqual((await alice('DELETE', `/api/invoices/${id}/payments/nope`)).status, 404);
  await alice('POST', `/api/invoices/${id}/payments`, { full: true });
  const again = await alice('POST', `/api/invoices/${id}/payments`, { full: true });
  assert.strictEqual(again.status, 409);
  const wins = await alice('GET', '/api/wins');
  assert.ok(wins.data.badges.find((b) => b.key === 'first_paid').earnedAt, 'earned badges are kept');
  assert.ok(wins.data.collectedMonthCents >= 60000, 'today\'s payment counts this month');
});

test('the ladder: logging "sent" climbs a rung and starts the wait; skipping ahead works', async () => {
  let r = await alice('GET', `/api/invoices/${ids.smallInv}`);
  assert.strictEqual(r.data.stage, 0);
  assert.strictEqual(r.data.nextKind, 'nudge');
  r = await alice('POST', `/api/invoices/${ids.smallInv}/chases`, { kind: 'nudge', channel: 'email', source: 'template', subject: 'Reminder', body: 'Hi <b>there</b>' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.stage, 1);
  assert.strictEqual(r.data.nextKind, 'followup');
  assert.strictEqual(r.data.chaseDue, false);
  assert.strictEqual(r.data.nextChaseOn, day(5));
  assert.strictEqual(r.data.chases[0].body, 'Hi bthere/b');
  assert.ok(r.data.newBadges.some((b) => b.key === 'first_chase'));
  const t = await alice('GET', '/api/today');
  assert.ok(!t.data.chase.some((x) => x.id === ids.smallInv), 'chased today: off the list');
  assert.ok(t.data.waiting.some((x) => x.id === ids.smallInv));
  r = await alice('POST', `/api/invoices/${ids.smallInv}/chases`, { kind: 'firm', channel: 'sms' });
  assert.strictEqual(r.data.stage, 3);
  assert.strictEqual(r.data.nextKind, 'final');
  r = await alice('POST', `/api/invoices/${ids.smallInv}/chases`, { kind: 'plan', channel: 'copy' });
  assert.strictEqual(r.data.stage, 3, 'a plan offer is off the ladder');
  r = await alice('POST', `/api/invoices/${ids.smallInv}/pause`, { paused: true });
  assert.strictEqual(r.data.paused, true);
  assert.ok((await alice('GET', '/api/today')).data.paused.some((x) => x.id === ids.smallInv));
  r = await alice('POST', `/api/invoices/${ids.smallInv}/pause`, { paused: false });
  assert.strictEqual(r.data.paused, false);
});

test('promises: a promise waits; a broken one ranks up and the next draft says so', async () => {
  const inv = await alice('POST', '/api/invoices', { clientId: ids.big, amount: 1000, issued: day(-40), due: day(-10) });
  const id = inv.data.id;
  assert.strictEqual((await alice('POST', `/api/invoices/${id}/promise`, { date: day(-1) })).status, 400);
  assert.strictEqual((await alice('POST', `/api/invoices/${id}/promise`, { date: 'Friday' })).status, 400);
  let r = await alice('POST', `/api/invoices/${id}/promise`, { date: day(3), note: 'After their <client> pays them' });
  assert.strictEqual(r.data.status, 'promised');
  assert.strictEqual(r.data.promises[0].note, 'After their client pays them');
  let t = await alice('GET', '/api/today');
  assert.ok(!t.data.chase.some((x) => x.id === id));
  // Time passes: the promised day comes and goes.
  const raw = await store.get(`invoices/${uidOf('alice@example.com')}/items`, id);
  await store.merge(`invoices/${uidOf('alice@example.com')}/items`, id, { promises: [{ ...raw.promises[0], date: day(-2) }] });
  t = await alice('GET', '/api/today');
  const row = t.data.chase.find((x) => x.id === id);
  assert.ok(row && row.promiseBroken);
  assert.ok(t.data.chase.findIndex((x) => x.id === id) < t.data.chase.findIndex((x) => x.id === ids.smallInv) || !t.data.chase.some((x) => x.id === ids.smallInv));
  r = await alice('POST', `/api/invoices/${id}/template`, {});
  assert.ok(/hasn't come through/.test(r.data.body));
  r = await alice('POST', `/api/invoices/${id}/draft`, {});
  assert.ok(/You'd said it would be paid by/.test(r.data.body), 'the model was told about the broken promise');
  assert.strictEqual((await alice('DELETE', `/api/invoices/${id}/promise`)).status, 409, 'a broken promise is history');
  ids.promised = id;
});

test('a chase draft: metered, forced tool, markup stripped, fee only when ticked', async () => {
  const c = await alice('POST', '/api/clients', { name: 'INJECT Holdings', email: 'x@inject.example' });
  const inv = await alice('POST', '/api/invoices', { clientId: c.data.id, amount: 2000, issued: day(-50), due: day(-20) });
  const before = await spentBy('alice@example.com');
  const calls = await modelCalls();
  const r = await alice('POST', `/api/invoices/${inv.data.id}/draft`, { kind: 'followup' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.source, 'ai');
  assert.strictEqual(r.data.kind, 'followup');
  assert.ok(!/[<>]/.test(r.data.subject + r.data.body + r.data.sms), 'model markup is stripped');
  assert.ok(r.data.body.includes('$2,000'));
  assert.ok(r.data.body.includes('pay.example/alpine'), 'the payment link is in it');
  assert.strictEqual(r.data.to.email, 'x@inject.example');
  assert.ok(!/late fee/i.test(r.data.body));
  assert.ok(await spentBy('alice@example.com') > before, 'the draft was metered');
  assert.strictEqual(await modelCalls(), calls + 1);
  const withFee = await alice('POST', `/api/invoices/${inv.data.id}/draft`, { includeFee: true });
  assert.ok(/late fee of \$/.test(withFee.data.body));
  assert.ok(withFee.data.fee && withFee.data.fee.amount);
  const after = await alice('GET', `/api/invoices/${inv.data.id}`);
  assert.strictEqual(after.data.balanceCents, 200000, 'a fee is never added to the balance');
  assert.strictEqual(after.data.stage, 0, 'drafting is not chasing');
  assert.ok(after.data.lateFee.applies);
  assert.strictEqual((await alice('POST', `/api/invoices/${ids.bigInv}/draft`, { kind: 'nonsense' })).data.kind, 'nudge', 'an unknown kind falls back to the next rung');
});

test('out of credit: 402 before any model call; the template is free and still works', async () => {
  bob = client();
  await bob('POST', '/api/auth/register', { email: 'bob@example.com', password: 'another long password' });
  const inv = await bob('POST', '/api/invoices', { client: { name: 'Bobs Client' }, amount: 300, issued: day(-40), due: day(-10) });
  await identityStore.merge('users', uidOf('bob@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  const d = await bob('POST', `/api/invoices/${inv.data.id}/draft`, {});
  assert.strictEqual(d.status, 402);
  assert.ok('topUpUrl' in d.data);
  assert.strictEqual((await bob('POST', '/api/invoices/read', { image: { type: 'image/jpeg', data: JPEG } })).status, 402);
  assert.strictEqual(await modelCalls(), calls, 'no model call was made');
  const t = await bob('POST', `/api/invoices/${inv.data.id}/template`, { kind: 'nudge' });
  assert.strictEqual(t.status, 200);
  assert.strictEqual(t.data.source, 'template');
  assert.ok(t.data.body.includes('$300'));
  assert.strictEqual(await spentBy('bob@example.com'), 100, 'templates never spend');
  assert.strictEqual((await bob('POST', `/api/invoices/${inv.data.id}/chases`, { kind: 'nudge', channel: 'email', source: 'template' })).status, 200, 'logging a chase is free');
  assert.strictEqual((await bob('POST', `/api/invoices/${inv.data.id}/payments`, { full: true })).status, 200, 'getting paid is free');
  await identityStore.merge('users', uidOf('bob@example.com'), { spentUsd: 0 });
});

test('snap an invoice: bad image 400 before the model, unreadable 422, a proposal and nothing stored', async () => {
  const calls = await modelCalls();
  const spent = await spentBy('alice@example.com');
  let r = await alice('POST', '/api/invoices/read', { image: { type: 'image/jpeg', data: Buffer.from('not an image at all').toString('base64') } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await alice('POST', '/api/invoices/read', {})).status, 400);
  assert.strictEqual(await modelCalls(), calls, 'refused before anything was spent');
  assert.strictEqual(await spentBy('alice@example.com'), spent);
  r = await alice('POST', '/api/invoices/read', { image: { type: 'image/jpeg', data: BLANK } });
  assert.strictEqual(r.status, 422);
  const invoicesBefore = (await alice('GET', '/api/invoices')).data.invoices.length;
  const dumpBefore = store._dump().length;
  r = await alice('POST', '/api/invoices/read', { image: { type: 'image/jpeg', data: JPEG } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.client.name, 'Harbor & Pine Design', 'model text is cleaned');
  assert.strictEqual(r.data.amountCents, 348000);
  assert.strictEqual(r.data.number, 'HP-2291');
  assert.strictEqual(r.data.due, '2026-09-13');
  assert.strictEqual(r.data.matchedClientId, null);
  assert.strictEqual((await alice('GET', '/api/invoices')).data.invoices.length, invoicesBefore, 'reading saves nothing');
  assert.strictEqual(store._dump().length, dumpBefore, 'nothing at all was written');
  assert.ok(!store._dump().includes(JPEG.slice(0, 60)), 'the photo is nowhere in the store');
  const saved = await alice('POST', '/api/invoices', { client: r.data.client, number: r.data.number, amountCents: r.data.amountCents, issued: r.data.issued, due: r.data.due, source: 'snap' });
  assert.strictEqual(saved.data.source, 'snap');
  assert.ok(!JSON.stringify(await store.get(`invoices/${uidOf('alice@example.com')}/items`, saved.data.id)).includes(JPEG.slice(0, 60)));
});

test('scorecards over HTTP: sorted by risk, with grades', async () => {
  const r = await alice('GET', '/api/clients');
  assert.strictEqual(r.status, 200);
  const big = r.data.clients.find((c) => c.id === ids.big);
  assert.strictEqual(big.paidCount, 1);
  assert.strictEqual(big.avgDaysLate, 10);
  assert.strictEqual(big.onTimePct, 0);
  assert.ok(['A', 'B', 'C', 'D', 'F'].includes(big.grade));
  const risks = r.data.clients.map((c) => c.riskCents);
  assert.deepStrictEqual(risks, [...risks].sort((a, b) => b - a));
  const one = await alice('GET', `/api/clients/${ids.big}`);
  assert.ok(one.data.rows.length >= 3);
  assert.strictEqual((await alice('DELETE', `/api/clients/${ids.big}`)).status, 409, 'a client with invoices stays');
});

let token;
test('statements: a frozen, read-only share with an unguessable link, revocable', async () => {
  const st = await alice('GET', `/api/clients/${ids.big}/statement`);
  assert.strictEqual(st.status, 200);
  assert.strictEqual(st.data.business.name, 'Alpine Design');
  assert.strictEqual(st.data.groups[0].currency, 'USD');
  assert.strictEqual(st.data.groups[0].balanceCents, 600000, 'the $5,000 and the promised $1,000; the paid one is not owed');
  assert.ok(st.data.groups[0].payments.length >= 2, 'recent payments are listed');
  const sh = await alice('POST', `/api/clients/${ids.big}/share`);
  assert.strictEqual(sh.status, 200);
  token = sh.data.token;
  assert.ok(/^[A-Za-z0-9_-]{22}$/.test(token), '128 random bits');
  assert.strictEqual(sh.data.url, `s/${token}`, 'relative to the app, never absolute');
  const anon = client();
  const pub = await anon('GET', `/api/shared/${token}`);
  assert.strictEqual(pub.status, 200);
  assert.strictEqual(pub.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual(pub.headers.get('x-robots-tag'), 'noindex, nofollow');
  const s = JSON.stringify(pub.data);
  for (const bad of ['alice@example.com', uidOf('alice@example.com'), 'Private: they are slow', 'ap@bigco.example', '010-0000', 'chases', 'promises', 'grade', 'lateFee', 'riskCents']) {
    assert.ok(!s.includes(bad), `the shared statement leaked ${bad}`);
  }
  assert.strictEqual(pub.data.business.contact, 'hi@alpine.example', 'only the contact line they chose');
  const frozenBalance = pub.data.groups[0].balanceCents;
  await alice('POST', `/api/invoices/${ids.bigInv}/payments`, { amount: 1000 });
  assert.strictEqual((await anon('GET', `/api/shared/${token}`)).data.groups[0].balanceCents, frozenBalance, 'the copy is frozen');
  for (const m of ['POST', 'PUT', 'DELETE']) assert.strictEqual((await anon(m, `/api/shared/${token}`, {})).status, 404, `${m} is not a thing a share does`);
  assert.strictEqual((await anon('GET', '/api/shared/AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
  assert.strictEqual((await anon('GET', '/api/shared/short')).status, 404);
  const refreshed = await alice('POST', `/api/clients/${ids.big}/share`);
  assert.strictEqual(refreshed.data.token, token, 'sharing again refreshes the same link');
  assert.strictEqual((await anon('GET', `/api/shared/${token}`)).data.groups[0].balanceCents, frozenBalance - 100000);
  assert.strictEqual((await alice('DELETE', `/api/clients/${ids.big}/share`)).status, 200);
  assert.strictEqual((await anon('GET', `/api/shared/${token}`)).status, 404, 'revoked');
  const fresh = await alice('POST', `/api/clients/${ids.big}/share`);
  assert.notStrictEqual(fresh.data.token, token, 'a revoked link never comes back');
});

test('the shared page works under the mount, is not indexed, and leaks no referrer', async () => {
  const sh = await alice('POST', `/api/clients/${ids.big}/share`);
  const res = await fetch(`${base}/s/${sh.data.token}`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<base href="../">'));
  assert.ok(!/(href|src)="\//.test(html), 'no absolute asset paths');
  assert.strictEqual(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.strictEqual(res.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual((await fetch(`${base}/app.css`)).status, 200);
});

test('another user gets 404 on everything of yours', async () => {
  const eve = client();
  await eve('POST', '/api/auth/register', { email: 'eve@example.com', password: 'eve has a password' });
  const inv = ids.bigInv;
  for (const [m, p, body] of [
    ['GET', `/api/invoices/${inv}`], ['PUT', `/api/invoices/${inv}`, { amount: 1 }], ['DELETE', `/api/invoices/${inv}`],
    ['POST', `/api/invoices/${inv}/payments`, { full: true }], ['DELETE', `/api/invoices/${inv}/payments/x`],
    ['POST', `/api/invoices/${inv}/promise`, { date: day(2) }], ['DELETE', `/api/invoices/${inv}/promise`],
    ['POST', `/api/invoices/${inv}/chases`, { kind: 'nudge' }], ['POST', `/api/invoices/${inv}/pause`, {}],
    ['POST', `/api/invoices/${inv}/write-off`, {}], ['POST', `/api/invoices/${inv}/draft`, {}], ['POST', `/api/invoices/${inv}/template`, {}],
    ['GET', `/api/clients/${ids.big}`], ['PUT', `/api/clients/${ids.big}`, { name: 'Mine now' }], ['DELETE', `/api/clients/${ids.big}`],
    ['GET', `/api/clients/${ids.big}/statement`], ['POST', `/api/clients/${ids.big}/share`], ['DELETE', `/api/clients/${ids.big}/share`],
    ['POST', '/api/invoices', { clientId: ids.big, amount: 5 }],
  ]) {
    assert.strictEqual((await eve(m, p, body)).status, 404, `${m} ${p}`);
  }
  assert.strictEqual((await eve('GET', '/api/invoices')).data.invoices.length, 0);
  assert.strictEqual((await eve('GET', '/api/clients')).data.clients.length, 0);
  assert.strictEqual((await eve('GET', '/api/today')).data.chase.length, 0);
  assert.strictEqual((await alice('GET', `/api/invoices/${inv}`)).data.amountCents, 500000);
});

test('write-off and delete', async () => {
  let r = await alice('POST', `/api/invoices/${ids.gbp}/write-off`, { writtenOff: true });
  assert.strictEqual(r.data.status, 'written_off');
  assert.strictEqual((await alice('POST', `/api/invoices/${ids.gbp}/payments`, { amount: 1 })).status, 409);
  r = await alice('POST', `/api/invoices/${ids.gbp}/write-off`, { writtenOff: false });
  assert.strictEqual(r.data.status, 'open');
  assert.strictEqual((await alice('DELETE', `/api/invoices/${ids.gbp}`)).status, 200);
  assert.strictEqual((await alice('GET', `/api/invoices/${ids.gbp}`)).status, 404);
});

test('caps: 500 invoices and 200 clients a book', async () => {
  const dave = client();
  await dave('POST', '/api/auth/register', { email: 'dave@example.com', password: 'dave long password' });
  const uid = uidOf('dave@example.com');
  const c = await dave('POST', '/api/clients', { name: 'Only' });
  for (let i = 0; i < B.LIMITS.invoices; i++) {
    await store.add(`invoices/${uid}/items`, { clientId: c.data.id, number: `N${i}`, amountCents: 100, currency: 'USD', issued: day(-5), due: day(5), payments: [], chases: [], promises: [], stage: 0 });
  }
  const r = await dave('POST', '/api/invoices', { clientId: c.data.id, amount: 5 });
  assert.strictEqual(r.status, 409);
  assert.ok(/500/.test(r.data.error));
  for (let i = 1; i < B.LIMITS.clients; i++) await store.add(`clients/${uid}/items`, { name: `C${i}` });
  assert.strictEqual((await dave('POST', '/api/clients', { name: 'One too many' })).status, 409);
  const t = await dave('GET', '/api/today');
  assert.strictEqual(t.status, 200, 'a full book still draws');
});

test('wins: the streak, the collected total and the badges add up', async () => {
  const w = await alice('GET', '/api/wins');
  assert.strictEqual(w.status, 200);
  assert.ok(w.data.paidCount >= 1);
  assert.strictEqual(w.data.streakWeeks, 1);
  assert.ok(w.data.chasesSent >= 3);
  const got = w.data.badges.filter((b) => b.earnedAt).map((b) => b.key);
  assert.ok(got.includes('first_chase') && got.includes('first_paid'));
  assert.ok(!got.includes('five_paid'));
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use('/chaser', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/chaser`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
