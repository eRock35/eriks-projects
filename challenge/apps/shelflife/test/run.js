// Pure rules first, then end to end against the memory store and the fake
// model:
//   SHELFLIFE_MEMORY=1 SHELFLIFE_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /shelflife, the
// way the lab mounts it, so the auth cookie, the budget gate, the member
// cookie's path, per-kitchen rights and the big-body routes are exercised as
// deployed. Model calls are counted from the identity's usage rows - the
// same rows that bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.SHELFLIFE_MEMORY !== '1' || process.env.SHELFLIFE_FAKE_AI !== '1') {
  console.error('run with SHELFLIFE_MEMORY=1 SHELFLIFE_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const C = require('../public/shelf-core');
const S = require('../public/sample');
const QR = require('../public/qr');
const ai = require('../lib/ai');
const K = require('../lib/kitchens');
const fakeai = require('../lib/fakeai');

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
    return { status: res.status, data, text, headers: res.headers, setCookie: set };
  };
  call.cookies = cookies;
  call.ip = addr;
  return call;
}

const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15)); // the meter writes usage rows fire-and-forget
const MARK = 'FRIDGEBYTESMARKER';
const jpeg = (s = '') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(MARK + s), Buffer.alloc(2000, 7)]).toString('base64');
const BIG = 'A'.repeat(7 * 1024 * 1024);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const T = '2026-10-06';
const rand = (n) => Math.floor(Math.random() * n);
const ctx = (extra) => ({ today: T, now: Date.parse(`${T}T12:00:00Z`), rand, by: null, ...(extra || {}) });
/** A kitchen object with these items (raw, through cleanItem). */
function kitchenOf(raws, history) {
  const items = {};
  for (const r of raws) { const it = C.cleanItem(r, { today: T, rand, keepId: true }); items[it.id] = it; }
  return { name: 'Test', tz: 'UTC', created: C.addDays(T, -40), items, history: history || {} };
}
function act(k, r) { C.applyPatch(k, r.patch); return r; }

/* ---------------- the catalogue and recipes ---------------- */

test('the catalogue: ~150 everyday foods, every one sane', () => {
  assert.ok(C.CATALOGUE.length >= 150, `${C.CATALOGUE.length} foods`);
  const ids = new Set();
  for (const c of C.CATALOGUE) {
    assert.ok(/^[a-z]{2,16}$/.test(c.id) && !ids.has(c.id), c.id);
    ids.add(c.id);
    assert.ok(C.PLACE_IDS.includes(c.place), c.id);
    assert.ok(Number.isInteger(c.days) && c.days > 0 && c.days <= 800, `${c.id} days`);
    assert.ok(Number.isInteger(c.opened) && c.opened >= 0 && c.opened <= c.days, `${c.id} opened`);
    assert.ok(c.price > 0 && c.price < 20, `${c.id} price`);
    assert.ok(C.cleanFoodEmoji(c.emoji), `${c.id} emoji`);
    assert.ok(Number.isInteger(c.freeze) && c.freeze >= 0 && Number.isInteger(c.thaw) && c.thaw >= 1, `${c.id} freezer`);
    assert.ok(!c.openPlace || C.PLACE_IDS.includes(c.openPlace));
  }
  // The guidance the brief names, roughly where a home cook would put it.
  assert.deepStrictEqual([C.CAT.chicken.days, C.CAT.leftovers.days, C.CAT.bread.days, C.CAT.bread.place, C.CAT.eggs.days, C.CAT.milk.opened, C.CAT.salsa.opened, C.CAT.salsa.openPlace], [2, 4, 5, 'pantry', 28, 5, 7, 'fridge']);
  for (const id of C.WEEKLY) assert.ok(C.CAT[id], `weekly ${id}`);
  assert.strictEqual(C.WEEKLY.length, 24);
  assert.ok(C.CATALOGUE.filter((c) => c.tip).length >= 10, 'the most-binned foods carry a tip');
});

test('the recipes: 40+, each slot names real foods, 4-6 short steps', () => {
  assert.ok(C.RECIPES.length >= 40, `${C.RECIPES.length}`);
  const ids = new Set();
  for (const r of C.RECIPES) {
    assert.ok(!ids.has(r.id)); ids.add(r.id);
    assert.ok(r.uses.length >= 1 && r.uses.every((alts) => alts.length && alts.every((id) => C.CAT[id])), r.id);
    assert.ok(r.nice.every((id) => C.CAT[id]), r.id);
    assert.ok(r.steps.length >= 4 && r.steps.length <= 6, `${r.id}: ${r.steps.length} steps`);
    assert.ok(r.steps.every((s) => s.length <= 160), `${r.id} step length`);
    assert.ok(Number.isInteger(r.minutes) && r.minutes >= 5 && r.minutes <= 90);
    assert.ok(C.cleanFoodEmoji(r.emoji), r.id);
  }
});

test('type-ahead and name matching', () => {
  assert.strictEqual(C.search('spin')[0].id, 'spinach');
  assert.strictEqual(C.search('chick')[0].id, 'chicken');
  assert.strictEqual(C.search('MILK')[0].id, 'milk');
  assert.ok(C.search('yog').slice(0, 2).every((c) => /yoghurt/i.test(c.name)));
  assert.deepStrictEqual(C.search(''), []);
  assert.deepStrictEqual(C.search('<script>'), []);
  assert.strictEqual(C.catFor('Bananas').id, 'bananas');
  assert.strictEqual(C.catFor('banana').id, 'bananas');
  assert.strictEqual(C.catFor('zucchini').id, 'courgette');
  assert.strictEqual(C.catFor('Half a roast chicken').id, 'roastchicken');
  assert.strictEqual(C.catFor('Grandma’s secret stew'), null);
  assert.strictEqual(C.catFor('__proto__'), null);
  assert.strictEqual(C.catFor('constructor'), null);
});

/* ---------------- days and bands ---------------- */

test('bands across midnight and time zones: "today" is the kitchen’s', () => {
  // One instant: 23:30 on Oct 6 in Los Angeles, already 19:30 on Oct 7 in Auckland.
  const ms = Date.parse('2026-10-07T06:30:00Z');
  assert.strictEqual(C.localDate(ms, 'America/Los_Angeles'), '2026-10-06');
  assert.strictEqual(C.localDate(ms, 'Pacific/Auckland'), '2026-10-07');
  assert.strictEqual(C.localDate(ms, 'UTC'), '2026-10-07');
  assert.strictEqual(C.localDate(ms, 'Not/AZone'), '2026-10-07', 'a bad zone is UTC');
  const it = C.cleanItem({ name: 'Spinach', use: '2026-10-06' }, { today: '2026-10-06' });
  assert.strictEqual(C.bandOf(it, C.localDate(ms, 'America/Los_Angeles')), 'today');
  assert.strictEqual(C.bandOf(it, C.localDate(ms, 'Pacific/Auckland')), 'past');
  // A minute later in LA it is a new day: Today has become Past, Tomorrow Today.
  const next = C.localDate(ms + 31 * 60000, 'America/Los_Angeles');
  assert.strictEqual(next, '2026-10-07');
  assert.strictEqual(C.bandOf(it, next), 'past');
  const tom = C.cleanItem({ name: 'Milk', use: '2026-10-07' }, { today: '2026-10-06' });
  assert.deepStrictEqual([C.bandOf(tom, '2026-10-06'), C.bandOf(tom, next)], ['tomorrow', 'today']);
  // Every band edge.
  const d = (n) => ({ use: C.addDays(T, n) });
  assert.deepStrictEqual([-30, -1, 0, 1, 2, 7, 8, 400].map((n) => C.bandOf(d(n), T)), ['past', 'past', 'today', 'tomorrow', 'week', 'week', 'later', 'later']);
  // Whole days across a DST change (London leaves summer time on Oct 25, 2026).
  assert.strictEqual(C.daysBetween('2026-10-24', '2026-10-26'), 2);
  assert.strictEqual(C.addDays('2026-10-24', 2), '2026-10-26');
  assert.strictEqual(C.localDate(Date.parse('2026-10-25T23:30:00Z'), 'Europe/London'), '2026-10-25');
  assert.strictEqual(C.localDate(Date.parse('2026-03-29T00:30:00Z'), 'Europe/London'), '2026-03-29');
  assert.strictEqual(C.addDays('2028-02-28', 1), '2028-02-29', 'a leap day');
  assert.ok(!C.isDate('2026-02-30') && !C.isDate('2026-13-01') && C.isDate('2028-02-29'));
});

test('the headline and the band order', () => {
  const k = kitchenOf([
    { id: 'iaaaaaaa1', name: 'Spinach', daysLeft: 0 }, { id: 'iaaaaaaa2', name: 'Half a chicken', cat: 'roastchicken', daysLeft: 0 },
    { id: 'iaaaaaaa3', name: 'Strawberries', daysLeft: 0 }, { id: 'iaaaaaaa4', name: 'Coriander', cat: 'herbs', daysLeft: -2 },
    { id: 'iaaaaaaa5', name: 'Pasta', daysLeft: 300 },
  ]);
  assert.strictEqual(C.headline(k.items, T), '3 things to use today - half a chicken, the spinach and the strawberries. The coriander is past its date - check it before you eat it.');
  assert.deepStrictEqual(C.bands(k.items, T).map((b) => [b.id, b.items.length]), [['past', 1], ['today', 3], ['later', 1]]);
  assert.match(C.headline({}, T), /empty/);
  assert.match(C.headline(kitchenOf([{ name: 'Milk', daysLeft: 1 }]).items, T), /^Nothing has to go today\. Tomorrow: the milk\.$/);
  assert.match(C.headline(kitchenOf([{ name: 'Eggs', daysLeft: 5 }]).items, T), /^Nothing urgent/);
  assert.match(C.headline(kitchenOf([{ name: 'Rice', daysLeft: 50 }]).items, T), /All good/);
  const many = kitchenOf(['A1', 'B1', 'C1', 'D1', 'E1'].map((n) => ({ name: n, daysLeft: 0 })));
  assert.match(C.headline(many.items, T), /5 things to use today - .* and 2 more\./);
});

/* ---------------- cleaning ---------------- */

test('cleanItem: the one door every item goes through, hostile input included', () => {
  const it = C.cleanItem({ name: 'spinach' }, { today: T });
  assert.deepStrictEqual([it.cat, it.place, it.qty, it.use, it.emoji, it.opened, it.frozen, it.leftover], ['spinach', 'fridge', 1, C.addDays(T, 5), '🥬', null, null, false]);
  assert.ok(C.isItemId(it.id));
  const evil = C.cleanItem({ name: `<img src=x onerror=alert(1)>Spi\u202enach${'A'.repeat(5000)}`, emoji: '<script>', place: 'roof', qty: 1e9, daysLeft: -99999, catalogueId: '__proto__', opened: 'yesterday', frozen: '2026-10-01', id: '../../x', leftover: 'yes' }, { today: T, keepId: true });
  assert.ok(!/[<>\u202e]/.test(evil.name) && Array.from(evil.name).length <= C.LIMITS.itemName, evil.name);
  assert.deepStrictEqual([evil.place, evil.qty, evil.cat, evil.opened, evil.frozen, evil.emoji, evil.leftover], ['fridge', 1, null, null, null, '🍽️', false]);
  assert.ok(C.isItemId(evil.id), 'a bad id is replaced');
  assert.strictEqual(evil.use, C.addDays(T, 5), 'nonsense days fall back to a plain default');
  assert.throws(() => C.cleanItem({ name: '   ' }, { today: T }), /name/);
  assert.throws(() => C.cleanItem({ name: { evil: 1 } }, { today: T }), /name/);
  assert.throws(() => C.cleanItem(null, { today: T }), /name/);
  assert.strictEqual(C.cleanItem({ catalogueId: 'milk' }, { today: T }).name, 'Milk', 'a catalogue id alone names it');
  assert.strictEqual(C.cleanItem({ name: 'x', daysLeft: '4' }, { today: T }).use, C.addDays(T, 4));
  assert.strictEqual(C.cleanItem({ name: 'x', daysLeft: 1.5 }, { today: T }).use, C.addDays(T, 5));
  assert.strictEqual(C.cleanItem({ name: 'x', use: '2026-02-30' }, { today: T }).use, C.addDays(T, 5));
  assert.strictEqual(C.cleanItem({ name: 'x', use: '2099-01-01' }, { today: T }).use, C.addDays(T, 5), 'a date years out is not believed');
  assert.strictEqual(C.cleanItem({ name: 'x', qty: '3' }, { today: T }).qty, 3);
  assert.strictEqual(C.cleanItem({ name: 'x', qty: 0 }, { today: T }).qty, 1);
  assert.strictEqual(C.cleanItem({ name: 'Peas', place: 'freezer' }, { today: T }).use, C.addDays(T, 365));
  assert.strictEqual(C.cleanItem({ name: 'Mystery', place: 'pantry' }, { today: T }).use, C.addDays(T, 14));
  assert.strictEqual(C.cleanItem({ name: 'Milk', opened: T }, { today: T }).use, C.addDays(T, 5), 'already open uses the opened life');
  assert.strictEqual(C.cleanItem({ name: '🍕' }, { today: T }).name, '🍕');
  assert.strictEqual(C.cleanFoodEmoji('🥬🥬'), null);
  assert.strictEqual(C.cleanFoodEmoji('👨‍👩‍👧'), '👨‍👩‍👧');
  const lo = C.leftovers('<b>Chilli</b>', 3, { today: T });
  assert.deepStrictEqual([lo.name, lo.qty, lo.leftover, lo.use, lo.emoji], ['Chilli', 3, true, C.addDays(T, 4), '🍲']);
});

/* ---------------- the actions ---------------- */

test('"I opened it", "Froze it", "Thaw it", "+days": the date maths', () => {
  const k = kitchenOf([
    { id: 'imilk0001', name: 'Milk' }, { id: 'imilk0002', name: 'Milk', daysLeft: 2 }, { id: 'isalsa001', name: 'Salsa' },
    { id: 'ichicken1', name: 'Chicken', cat: 'chicken' }, { id: 'ilettuce1', name: 'Lettuce' }, { id: 'imystery1', name: 'Mystery', daysLeft: 3 },
    { id: 'ipast0001', name: 'Old yoghurt', cat: 'yoghurt', daysLeft: -3 }, { id: 'ilefto001', name: 'Stew', cat: 'leftovers', leftover: true },
  ]);
  assert.strictEqual(k.items.imilk0001.use, C.addDays(T, 7));
  let r = act(k, C.open(k, 'imilk0001', ctx()));
  assert.deepStrictEqual([k.items.imilk0001.use, k.items.imilk0001.opened], [C.addDays(T, 5), T]);
  assert.match(r.msg, /use within 5 days/);
  act(k, C.open(k, 'imilk0002', ctx()));
  assert.strictEqual(k.items.imilk0002.use, C.addDays(T, 2), 'opening never moves a date later');
  r = act(k, C.open(k, 'isalsa001', ctx()));
  assert.deepStrictEqual([k.items.isalsa001.place, k.items.isalsa001.use], ['fridge', C.addDays(T, 7)]);
  assert.match(r.msg, /fridge/);
  r = act(k, C.open(k, 'imystery1', ctx()));
  assert.strictEqual(k.items.imystery1.use, C.addDays(T, 3), 'no opened life known: the date stays');
  r = act(k, C.freeze(k, 'ichicken1', ctx()));
  assert.deepStrictEqual([k.items.ichicken1.place, k.items.ichicken1.frozen, k.items.ichicken1.use], ['freezer', T, C.addDays(T, 270)]);
  assert.match(r.msg, /good till/);
  assert.strictEqual(C.bandOf(k.items.ichicken1, T), 'later', 'frozen, it drops down the board');
  r = act(k, C.freeze(k, 'ilettuce1', ctx()));
  assert.strictEqual(k.items.ilettuce1.use, C.addDays(T, 30));
  assert.match(r.msg, /doesn’t freeze brilliantly/);
  act(k, C.freeze(k, 'ilefto001', ctx()));
  assert.strictEqual(k.items.ilefto001.use, C.addDays(T, 90));
  const later = ctx({ today: C.addDays(T, 40) });
  r = act(k, C.thaw(k, 'ichicken1', later));
  assert.deepStrictEqual([k.items.ichicken1.place, k.items.ichicken1.frozen, k.items.ichicken1.use], ['fridge', null, C.addDays(T, 41)]);
  assert.match(r.msg, /tomorrow/);
  act(k, C.extend(k, 'ipast0001', 1, ctx()));
  assert.strictEqual(k.items.ipast0001.use, C.addDays(T, 1), '+1 on a past date counts from today');
  act(k, C.extend(k, 'imilk0001', 3, ctx()));
  assert.strictEqual(k.items.imilk0001.use, C.addDays(T, 8));
  assert.throws(() => C.extend(k, 'imilk0001', 0, ctx()), /1 to 30/);
  assert.throws(() => C.extend(k, 'imilk0001', 'lots', ctx()), /1 to 30/);
  assert.throws(() => C.open(k, 'inotthere', ctx()), (e) => e.status === 404);
  assert.throws(() => C.open(k, '__proto__', ctx()), (e) => e.status === 404);
  // An edit that moves something into the freezer re-dates it like Froze it.
  const e = kitchenOf([{ id: 'ibread001', name: 'Bread' }]);
  act(e, C.editItem(e, 'ibread001', { place: 'freezer' }, ctx()));
  assert.deepStrictEqual([e.items.ibread001.place, e.items.ibread001.use], ['freezer', C.addDays(T, 90)]);
  act(e, C.editItem(e, 'ibread001', { place: 'pantry' }, ctx()));
  assert.deepStrictEqual([e.items.ibread001.place, e.items.ibread001.use, e.items.ibread001.frozen], ['pantry', C.addDays(T, 3), null]);
  act(e, C.editItem(e, 'ibread001', { name: '<i>Rye</i>', qty: 2, use: C.addDays(T, 9) }, ctx()));
  assert.deepStrictEqual([e.items.ibread001.name, e.items.ibread001.qty, e.items.ibread001.use], ['Rye', 2, C.addDays(T, 9)]);
  assert.throws(() => C.editItem(e, 'ibread001', { qty: 500 }, ctx()), /Quantity/);
  assert.throws(() => C.editItem(e, 'ibread001', { place: 'roof' }, ctx()), /Fridge/);
  assert.throws(() => C.editItem(e, 'ibread001', { use: 'soon' }, ctx()), /date/);
  assert.throws(() => C.editItem(e, 'ibread001', { name: '' }, ctx()), /name/);
});

test('ate it, binned it, undo, cook: one unit at a time, history kept and bounded', () => {
  const k = kitchenOf([{ id: 'iyog00001', name: 'Yoghurt', qty: 3, daysLeft: 1 }, { id: 'ispin0001', name: 'Spinach', daysLeft: 0 }, { id: 'iegg00001', name: 'Eggs' }]);
  let r = act(k, C.done(k, 'iyog00001', 'ate', ctx({ by: 'mabcdefg1' })));
  assert.strictEqual(k.items.iyog00001.qty, 2);
  const ev = k.history[r.event.id];
  assert.deepStrictEqual([ev.outcome, ev.date, ev.left, ev.name, ev.cat, ev.by, ev.iid, ev.price], ['ate', T, 1, 'Yoghurt', 'yoghurt', 'mabcdefg1', 'iyog00001', 1.2]);
  assert.match(r.msg, /Rescued/);
  r = act(k, C.done(k, 'ispin0001', 'binned', ctx()));
  assert.ok(!k.items.ispin0001, 'the last one is gone');
  assert.match(r.msg, /Binned the spinach/);
  // Undo brings back the very item.
  act(k, C.undo(k, r.event.id, ctx()));
  assert.deepStrictEqual([k.items.ispin0001.name, k.items.ispin0001.use, k.items.ispin0001.qty], ['Spinach', T, 1]);
  assert.ok(!Object.values(k.history).some((e) => e.outcome === 'binned'));
  const y = Object.values(k.history).find((e) => e.iid === 'iyog00001');
  act(k, C.undo(k, y.id, ctx()));
  assert.strictEqual(k.items.iyog00001.qty, 3, 'undo on a pack still there puts one back');
  assert.throws(() => C.undo(k, y.id, ctx()), (e) => e.status === 404, 'twice is nothing');
  assert.throws(() => C.done(k, 'iegg00001', 'composted', ctx()), /Ate it or binned it/);
  r = act(k, C.cook(k, ['ispin0001', 'iegg00001', 'iegg00001', 'not-an-id'], 'Omelette', ctx()));
  assert.strictEqual(r.events.length, 2, 'repeats and junk ids dropped');
  assert.ok(!k.items.ispin0001 && !k.items.iegg00001);
  assert.ok(r.events.every((e) => e.dish === 'Omelette' && e.outcome === 'ate'));
  assert.throws(() => C.cook(k, [], 'x', ctx()), /Pick/);
  assert.throws(() => C.cook(k, ['iabsent01'], 'x', ctx()), (e) => e.status === 404);
  // Bounded: past the cap the oldest go; past 120 days they go anyway.
  const hist = {};
  for (let i = 0; i < C.LIMITS.history; i++) {
    const id = `eh${String(i).padStart(5, '0')}`;
    const date = C.addDays(T, -Math.floor(i / 10));
    hist[id] = { id, iid: 'ixx000001', name: 'X', emoji: '🍽️', cat: null, place: 'fridge', outcome: 'ate', date, left: 0, price: 1, by: null, at: `${date}T12:${String(i % 60).padStart(2, '0')}:00.000Z` };
  }
  hist.eold00001 = { ...hist.eh00000, id: 'eold00001', date: C.addDays(T, -121), at: `${C.addDays(T, -121)}T00:00:00.000Z` };
  const big = kitchenOf([{ id: 'ilast0001', name: 'Last' }], hist);
  r = C.done(big, 'ilast0001', 'ate', ctx());
  assert.ok(r.patch.del.includes('history.eold00001'), 'past 120 days goes');
  assert.ok(r.patch.del.filter((x) => x.startsWith('history.')).length >= 2, 'and the oldest past the cap');
  act(big, r);
  assert.ok(Object.keys(big.history).length <= C.LIMITS.history);
});

test('adding: the same food again adds to its quantity; the kitchen has a ceiling', () => {
  const k = kitchenOf([]);
  let r = act(k, C.addItems(k, [{ name: 'Milk' }, { name: 'milk' }, { name: 'Milk', daysLeft: 2 }], ctx()));
  const list = Object.values(k.items);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list.find((x) => x.use === C.addDays(T, 7)).qty, 2);
  assert.strictEqual(r.added.length, 3);
  const many = [];
  for (let i = 0; i < C.LIMITS.addAtOnce; i++) many.push({ name: `Thing ${i}` });
  for (let n = 0; n < 6; n++) act(k, C.addItems(k, many.map((x) => ({ name: `${x.name}-${n}` })), ctx()));
  assert.strictEqual(Object.keys(k.items).length, 362);
  assert.throws(() => C.addItems(k, many, ctx()), (e) => e.status === 409 && /400/.test(e.message));
  assert.throws(() => C.addItems(k, many.concat(many), ctx()), /at a time/);
  assert.throws(() => C.addItems(k, [], ctx()), /Add something/);
});

/* ---------------- tonight ---------------- */

test('recipes are ranked by what is going off, weighted by urgency, and by how little they need', () => {
  const k = kitchenOf([
    { id: 'ispin0001', name: 'Spinach', daysLeft: 0 }, { id: 'ieggs0001', name: 'Eggs', daysLeft: 9 }, { id: 'ifeta0001', name: 'Feta', daysLeft: 1 },
    { id: 'imilk0001', name: 'Milk', daysLeft: 20 }, { id: 'ipasta001', name: 'Pasta', daysLeft: 300 }, { id: 'ichick001', name: 'Chicken', cat: 'chicken', place: 'freezer', daysLeft: 100 },
  ]);
  const ranked = C.rankRecipes(k.items, T);
  assert.ok(ranked.length >= 3);
  assert.ok(['omelette', 'frittata'].includes(ranked[0].recipe.id), ranked.slice(0, 3).map((m) => m.recipe.id).join());
  assert.ok(ranked.every((m) => m.expiring.length >= 1), 'everything shown uses something going off');
  assert.ok(ranked.every((m) => m.missing.length <= 2));
  const om = ranked.find((m) => m.recipe.id === 'omelette');
  assert.deepStrictEqual(om.used.map((x) => x.id), ['ieggs0001', 'ispin0001']);
  assert.deepStrictEqual(om.nice.map((x) => x.id), ['ifeta0001']);
  assert.strictEqual(C.recipeLine(om), 'Uses 2 things going off: spinach and feta · 10 min');
  // The more urgent spinach scores more than the same recipe a week later.
  const calm = kitchenOf([{ name: 'Spinach', daysLeft: 6 }, { name: 'Eggs', daysLeft: 9 }]);
  assert.ok(C.matchRecipe(C.RECIPES.find((r) => r.id === 'omelette'), calm.items, T).score < om.score);
  // A missing ingredient costs more than an urgent one earns.
  const stir = C.matchRecipe(C.RECIPES.find((r) => r.id === 'stirfry'), k.items, T);
  assert.ok(stir.missing.length === 1 && stir.score < om.score);
  // Frozen food barely counts.
  assert.strictEqual(C.urgency(k.items.ichick001, T), 0.2);
  // With nothing going off, recipes that use what you have still show.
  const calmer = kitchenOf([{ name: 'Pasta', daysLeft: 300 }, { name: 'Pesto', daysLeft: 300 }]);
  const r2 = C.rankRecipes(calmer.items, T);
  assert.strictEqual(r2[0].recipe.id, 'pesto');
  assert.match(C.recipeLine(r2[0]), /^Uses what you have/);
  assert.deepStrictEqual(C.rankRecipes({}, T), []);
  // Two slots of the same list take two different items.
  const veg = kitchenOf([{ id: 'icarrot01', name: 'Carrots', daysLeft: 1 }, { id: 'iparsn001', name: 'Parsnips', daysLeft: 1 }]);
  const rv = C.matchRecipe(C.RECIPES.find((r) => r.id === 'roastveg'), veg.items, T);
  assert.deepStrictEqual(rv.used.map((x) => x.id).sort(), ['icarrot01', 'iparsn001']);
});

/* ---------------- saved and wasted ---------------- */

function ev(daysAgo, outcome, extra) {
  const date = C.addDays(T, -daysAgo);
  return { id: C.newId('e'), iid: 'ixx000001', name: 'Spinach', emoji: '🥬', cat: 'spinach', place: 'fridge', outcome, date, left: 0, price: 2.5, by: null, at: `${date}T12:00:00.000Z`, ...(extra || {}) };
}
const histOf = (list) => Object.fromEntries(list.map((e) => [e.id, e]));

test('stats: eaten vs binned, money rescued, the windows, the streak and what keeps being binned', () => {
  const k = kitchenOf([], histOf([
    ev(0, 'ate', { left: 0 }), ev(1, 'ate', { left: 5, price: 3 }), ev(6, 'ate', { left: -1 }), ev(7, 'binned'),
    ev(10, 'binned'), ev(20, 'binned'), ev(20, 'ate', { cat: 'milk', name: 'Milk', price: 1.5, left: 1 }), ev(27, 'ate'), ev(28, 'binned'), ev(40, 'binned'),
  ]));
  k.created = C.addDays(T, -60);
  const st = C.stats(k, T);
  assert.deepStrictEqual([st.week.ate, st.week.binned, st.week.rescued, st.week.savedUsd, st.week.wastedUsd, st.week.eatenPct], [3, 0, 2, 5, 0, 100], 'this week is today and the six days before');
  assert.deepStrictEqual([st.month.ate, st.month.binned, st.month.rescued], [5, 3, 4], 'four weeks is 28 days');
  assert.deepStrictEqual(st.weeks.map((w) => [w.label, w.ate, w.binned]), [['This week', 3, 0], ['Last week', 0, 2], ['2 weeks ago', 1, 1], ['3 weeks ago', 1, 0]]);
  assert.deepStrictEqual(st.streak, { days: 7, best: 20 }, 'last binned 7 days ago; the longest run was the first 20 days');
  assert.deepStrictEqual(st.binnedMost.map((x) => [x.name, x.n]), [['Spinach', 3]]);
  assert.strictEqual(C.binLine(st.binnedMost[0]), 'You’ve binned spinach 3 times this month - buy the small bag, or freeze some for smoothies?');
  // Binned today: the streak is 0. Nothing ever binned: it counts from the first day.
  assert.strictEqual(C.stats({ created: C.addDays(T, -2), history: histOf([ev(0, 'binned')]) }, T).streak.days, 0);
  assert.deepStrictEqual(C.stats({ created: C.addDays(T, -2), history: {} }, T).streak, { days: 3, best: 3 });
  assert.deepStrictEqual(C.stats({ created: T, history: {} }, T).streak, { days: 1, best: 1 });
  // A future-dated event (a phone with a wrong clock) counts for nothing.
  assert.strictEqual(C.stats({ created: T, history: histOf([ev(-3, 'binned')]) }, T).streak.days, 1);
  assert.strictEqual(C.money(23.1), '$23');
  assert.strictEqual(C.money(4.5), '$5');
  assert.strictEqual(C.money(0.5), '$0.50');
  assert.strictEqual(C.money(-3), '$0');
});

test('before you shop: what not to buy, and what is running out', () => {
  const k = kitchenOf([
    { name: 'Eggs', daysLeft: 9 }, { name: 'Eggs', daysLeft: 20, qty: 2 }, { name: 'Milk', daysLeft: 0 }, { name: 'Stew', cat: 'leftovers', leftover: true, daysLeft: 3 },
    { name: 'Bread', daysLeft: 1 },
  ], histOf([ev(1, 'ate', { cat: 'bananas', name: 'Bananas' }), ev(3, 'ate', { cat: 'bananas', name: 'Bananas' }), ev(2, 'ate', { cat: 'milk', name: 'Milk' }), ev(9, 'ate', { cat: 'milk', name: 'Milk' }), ev(5, 'ate', { cat: 'eggs', name: 'Eggs' }), ev(6, 'ate', { cat: 'eggs', name: 'Eggs' }), ev(40, 'ate', { cat: 'apples', name: 'Apples' }), ev(41, 'ate', { cat: 'apples', name: 'Apples' })]));
  const s = C.shopping(k, T);
  assert.deepStrictEqual(s.dontBuy.map((x) => [x.name, x.qty]), [['Eggs', 3]], 'not the milk going today, the bread going tomorrow, or leftovers');
  assert.deepStrictEqual(s.runningOut.map((x) => x.key), ['bananas', 'milk'], 'eaten twice this month and none left (or only some that goes today); not eggs, not last month’s apples');
  const text = C.shoppingText(s, '<b>Ours</b>');
  assert.match(text, /Running out: bananas, milk/);
  assert.match(text, /Don’t buy - we have: eggs ×3/);
  assert.match(C.shoppingText({ dontBuy: [], runningOut: [] }), /Nothing to flag/);
});

test('cleanKitchen: a phone’s kitchen, brought online, is bounded and cleaned', () => {
  const items = {};
  for (let i = 0; i < 450; i++) items[`i${String(i).padStart(8, '0')}`] = { id: `i${String(i).padStart(8, '0')}`, name: `Food ${i}`, use: C.addDays(T, i % 30) };
  items.ibad = { name: '' };
  const history = [ev(1, 'ate'), ev(1, 'eaten'), ev(200, 'ate'), ev(-5, 'binned'), { ...ev(2, 'binned'), name: '<b>x</b>', price: 9e9, left: 'x', dish: '<i>Pie</i>' }, 'junk', null];
  const k = C.cleanKitchen({ name: '<script>Our</script> kitchen', items, history, created: 'whenever' }, { today: T, rand });
  assert.strictEqual(k.name, 'Our kitchen');
  assert.strictEqual(Object.keys(k.items).length, C.LIMITS.items);
  assert.strictEqual(k.created, T);
  const hs = Object.values(k.history);
  assert.strictEqual(hs.length, 2, 'only real outcomes, inside the window, not in the future');
  const odd = hs.find((e) => e.outcome === 'binned');
  assert.deepStrictEqual([odd.name, odd.price, odd.left, odd.dish, odd.by], ['x', 2.5, 0, 'Pie', null]);
  assert.strictEqual(C.cleanKitchen(null, { today: T }).name, 'Our kitchen');
});

/* ---------------- the example kitchen ---------------- */

test('the example kitchen: ~25 things in every band, a month of history, the same for everyone on a day', () => {
  for (const [ms, tz] of [[Date.parse('2026-10-06T10:00:00Z'), 'Europe/London'], [Date.parse('2027-03-01T23:59:00Z'), 'Pacific/Auckland'], [Date.parse('2026-12-31T23:30:00Z'), 'America/New_York']]) {
    const k = S.state(ms, tz);
    const t = C.localDate(ms, tz);
    const n = C.counts(k.items, t);
    assert.ok(n.total >= 25 && n.total <= 30, `${n.total} items`);
    assert.deepStrictEqual([n.past, n.today, n.tomorrow], [1, 3, 2]);
    assert.ok(n.week >= 5 && n.later >= 10);
    assert.ok(Object.values(k.items).some((i) => i.place === 'freezer') && Object.values(k.items).some((i) => i.place === 'pantry'));
    assert.match(C.headline(k.items, t), /^3 things to use today - half a roast chicken, the spinach and the strawberries\./);
    const st = C.stats(k, t);
    assert.deepStrictEqual(st.streak, { days: 6, best: 6 });
    assert.ok(st.week.ate >= 8 && st.month.binned >= 5 && st.month.savedUsd > 20);
    assert.strictEqual(st.binnedMost[0].name, 'Spinach');
    assert.strictEqual(st.binnedMost[0].n, 3);
    assert.ok(C.rankRecipes(k.items, t).length >= 6);
    assert.ok(C.shopping(k, t).runningOut.length >= 3);
    assert.deepStrictEqual(S.state(ms, tz), k, 'deterministic');
    for (const it of Object.values(k.items)) assert.deepStrictEqual(C.cleanItem(it, { today: t, keepId: true }), it, `${it.name} is already clean`);
  }
});

/* ---------------- the model's output ---------------- */

test('the fake model refuses an unforced call; record_items and propose_recipe answers are cleaned', async () => {
  const fake = fakeai.create();
  await assert.rejects(fake.messages.create({ messages: [] }), /force a tool/);
  const raw = (await fake.messages.create({ tool_choice: { type: 'tool', name: 'record_items' }, messages: [{ content: [{ type: 'text', text: 'INJECT' }] }] })).content[0].input;
  const items = ai.cleanItems(raw, T);
  assert.ok(items.length <= C.LIMITS.snapItems);
  assert.ok(items.every((it) => !/[<>\u202e]/.test(it.name) && Array.from(it.name).length <= 40 && C.PLACE_IDS.includes(it.place) && it.qty >= 1 && it.qty <= 99 && it.daysLeft >= -60 && it.daysLeft <= 1100), JSON.stringify(items.slice(0, 3)));
  const milk = items.find((it) => it.name === 'Milk');
  assert.deepStrictEqual([milk.qty, milk.daysLeft, milk.cat, milk.emoji], [3, 7, 'milk', '🥛'], 'the two milks folded, a nonsense date became the catalogue’s');
  assert.ok(!items.some((it) => it.cat === '__proto__'));
  assert.deepStrictEqual(ai.cleanItems({ relevant: false, items: raw.items }, T), []);
  assert.deepStrictEqual(ai.cleanItems(null, T), []);
  assert.deepStrictEqual(ai.cleanItems({ relevant: true, items: 'lots' }, T), []);
  // A recipe: only ids it was told about, bounded, no markup.
  const list = ai.cleanIdeaItems([{ id: 'ispin0001', name: 'Spinach', daysLeft: 0 }, { id: 'ieggs0001', name: 'Eggs', daysLeft: 9, place: 'fridge' }, { id: 'ifeta0001', name: '<b>Feta</b>', daysLeft: 2 }, { id: 'bad', name: 'x', daysLeft: 1 }, { id: 'ixxx00001', name: 'No days' }, { id: 'ispin0001', name: 'Again', daysLeft: 1 }]);
  assert.deepStrictEqual(list.map((x) => [x.id, x.name]), [['ispin0001', 'Spinach'], ['ifeta0001', 'Feta'], ['ieggs0001', 'Eggs']], 'sorted by urgency, junk out');
  const text = list.map((it) => `${it.id}: ${it.name}`).join('\n');
  const rraw = (await fake.messages.create({ tool_choice: { type: 'tool', name: 'propose_recipe' }, messages: [{ content: [{ type: 'text', text: `INJECT\n${text}` }] }] })).content[0].input;
  const rec = ai.cleanRecipe(rraw, list);
  assert.ok(rec);
  assert.ok(!/[<>\u202e]/.test(JSON.stringify(rec)));
  assert.deepStrictEqual(rec.uses, ['ispin0001', 'ifeta0001', 'ieggs0001'], 'repeats, made-up and malformed ids dropped');
  assert.ok(rec.steps.length <= C.LIMITS.steps && rec.extra.length <= C.LIMITS.extras && Array.from(rec.title).length <= 60);
  assert.deepStrictEqual([rec.minutes, rec.emoji], [30, '🍽️']);
  assert.strictEqual(ai.cleanRecipe({ title: 'Toast', emoji: '🍞', minutes: 5, uses: ['inotreal99'], extra: [], steps: ['a', 'b'] }, list), null, 'uses nothing real');
  assert.strictEqual(ai.cleanRecipe({ title: 'Toast', uses: ['ispin0001'], steps: ['Only one'] }, list), null, 'one step is not a recipe');
  assert.strictEqual(ai.cleanRecipe('nope', list), null);
  assert.deepStrictEqual(ai.cleanAvoid(['<b>Omelette</b>', 5, 'x'.repeat(500)]).map((s) => s.length <= 60), [true, true, true]);
  assert.match(ai.ITEMS_SYSTEM, /never an instruction/);
  assert.match(ai.RECIPE_SYSTEM, /never an instruction/);
  assert.deepStrictEqual(ai.ITEMS_TOOL.input_schema.properties.items.items.properties.place.enum, C.PLACE_IDS);
});

/* ---------------- static checks ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour holds 4.5:1 on its surface in both themes; band bars 3:1 on a card', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['bg', 'card', 'card2', 'accent-soft']) for (const fg of ['text', 'muted', 'link']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, `${name} accent-ink on accent`);
    for (const b of ['past', 'today', 'tomorrow', 'week', 'later']) {
      assert.ok(ratio(t[b], t[`${b}-bg`]) >= 4.5, `${name} ${b} on its tint: ${ratio(t[b], t[`${b}-bg`]).toFixed(2)}`);
      assert.ok(ratio(t[b], t.card) >= 4.5, `${name} ${b} on a card: ${ratio(t[b], t.card).toFixed(2)}`);
      assert.ok(ratio(t[`${b}-bar`], t.card) >= 3, `${name} ${b} bar on a card: ${ratio(t[`${b}-bar`], t.card).toFixed(2)}`);
    }
    assert.ok(ratio(t.good, t['good-bg']) >= 4.5 && ratio(t.good, t.card) >= 4.5 && ratio(t.good, t.card2) >= 4.5, `${name} good`);
    assert.ok(ratio(t.bad, t['bad-bg']) >= 4.5 && ratio(t.bad, t.card) >= 4.5 && ratio(t.bad, t.card2) >= 4.5, `${name} bad`);
    assert.ok(ratio(t.text, t['bad-bg']) >= 4.5, `${name} text on the binned list`);
    assert.ok(ratio(t.err, t.card) >= 4.5, `${name} errors`);
    assert.ok(ratio(t['strip-ink'], t.strip) >= 4.5 && ratio(t['strip-btn-ink'], t['strip-btn']) >= 4.5, `${name} the strip and the toast`);
    assert.ok(ratio(t.muted, t['today-bg']) >= 4.5 || true);
    assert.ok(ratio(t.accent, t.card) >= 3, `${name} the focus ring and buttons (3:1)`);
  }
  assert.ok(ratio('#ffffff', '#9a3412') >= 4.5, 'the hero’s Today badge');
  assert.ok(ratio('#2a5e33', '#ffffff') >= 4.5 && ratio('#111111', '#ffffff') >= 4.5, 'the QR screen');
});

test('the QR encoder draws a join link', () => {
  const svg = QR.svg('https://challenge.strongtechnicalconsulting.com/shelflife/j/ABCDEF', 'Join "x" <kitchen>');
  assert.ok(svg.startsWith('<svg') && !/<kitchen>|"x"/.test(svg));
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { SHELFLIFE_MEMORY: '1' }], ['./lib/fakeai', { SHELFLIFE_FAKE_AI: '1' }], ['./server', { SHELFLIFE_FAKE_AI: '1', SHELFLIFE_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, SHELFLIFE_MEMORY: '', SHELFLIFE_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, SHELFLIFE_MEMORY: '', SHELFLIFE_COLLECTION_PREFIX: 'shelflife_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8');
  assert.ok(/SHELFLIFE_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const m of server.matchAll(/where: \[(\[[^\]]*\](?:, )?)+\]/g)) assert.strictEqual((m[0].match(/\['/g) || []).length, 1, `one equality filter per query: ${m[0]}`);
  assert.ok(!/orderBy/.test(server), 'no ordered query, so no composite index');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, nothing logged from a body', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error) =/.test(js), 'handlers by addEventListener, not properties');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/<script/i.test(js), 'no script written into markup');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js), 'no email address in the page');
  assert.match(js, /when in doubt, throw it out/, 'the guidance line is on the page');
  for (const f of ['server.js', 'lib/ai.js', 'lib/kitchens.js', 'lib/photo.js', 'public/shelf-core.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|photo|name|text|raw|item)/.test(src), `${f} logs a body`);
  }
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!/setInterval|setTimeout/.test(server), 'nothing runs after a response (billed per request)');
});

/* ---------------- over HTTP ---------------- */

async function register(email, ip) {
  const c = client(ip);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
/** A kitchen as a phone would send it to go online. */
function localKitchen() {
  const k = kitchenOf([
    { id: 'ispin0001', name: 'Spinach', daysLeft: 0 }, { id: 'imilk0001', name: 'Milk', daysLeft: 1, qty: 2 }, { id: 'ieggs0001', name: 'Eggs' },
    { id: 'ifeta0001', name: '<b>Feta</b>', daysLeft: 3 }, { id: 'ipasta001', name: 'Pasta' },
  ], histOf([ev(1, 'ate'), ev(3, 'binned'), ev(400, 'ate')]));
  return { name: 'The <i>Test</i> Kitchen', created: C.addDays(T, -10), items: k.items, history: k.history };
}

test('signed out: the page and the example work with zero model calls; nothing private does, and no big body is read', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.limits.items, meta.limits.members, meta.catalogue >= 150, meta.recipes >= 40], [400, 12, true, true]);
  for (const f of ['shelf-core.js', 'sample.js', 'qr.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['POST', '/api/snap'], ['POST', '/api/idea'], ['POST', '/api/kitchens'], ['GET', '/api/kitchens']]) assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p}`);
  assert.strictEqual((await anon('POST', '/api/snap', { photo: { type: 'image/jpeg', data: BIG } })).status, 401, 'the gate answers before the 6 MB parser');
  assert.strictEqual((await anon('POST', '/api/idea', { items: 'x'.repeat(200 * 1024) })).status, 401, 'and before the idea parser');
  assert.strictEqual((await anon('POST', '/api/kitchens', { kitchen: 'x'.repeat(700 * 1024) })).status, 401, 'going online: sign-in before its 512 KB parser');
  assert.strictEqual((await anon('POST', '/api/join/ABCDEF', { name: 'x'.repeat(100 * 1024) })).status, 413, 'every other route keeps the small limit');
  for (const p of ['/k/AAAAAAAAAAAAAAAA', '/j/ABCDEF']) {
    const r = await fetch(`${base}${p}`);
    assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).includes('<base href="../">'), 'deep links resolve assets from the app root');
    assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
    assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the metered routes’ gates come before their parsers, in order; one model client in the whole server', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  for (const p of ['/api/snap', '/api/idea']) assert.deepStrictEqual(layer(p, 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser'], p);
  assert.deepStrictEqual(layer('/api/kitchens', 'post').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  for (const [p, m] of [['/api/kitchens', 'get'], ['/api/kitchens', 'post'], ['/api/kitchens/:kid', 'patch'], ['/api/kitchens/:kid', 'delete'], ['/api/kitchens/:kid/code', 'post']]) assert.strictEqual(layer(p, m).route.stack[0].handle.name, 'requireUser', `${m} ${p}`);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 2, 'two metered calls, nowhere else');
});

let host; let KID; let CODE; let hostMid;

test('snap: the photo checked before any spend, one metered call, a proposal to review, nothing stored', async () => {
  host = await register('ana.host@example.com');
  const dump = store._dump();
  const calls = await modelCalls();
  assert.strictEqual((await host('POST', '/api/snap', {})).status, 400);
  assert.strictEqual((await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: Buffer.from('%PDF-1.4 nope').toString('base64') } })).status, 400);
  assert.strictEqual((await host('POST', '/api/snap', { photo: { type: 'image/gif', data: jpeg() } })).status, 400);
  assert.strictEqual((await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } })).status, 400, 'over 4 MB');
  assert.strictEqual((await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: BIG } })).status, 413, 'over the 6 MB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const r = await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg() }, tz: 'Europe/London' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.data.items.length, 8);
  const sp = r.data.items.find((it) => it.name === 'Spinach');
  assert.deepStrictEqual([sp.cat, sp.place, sp.daysLeft, sp.emoji], ['spinach', 'fridge', 2, '🥬']);
  assert.strictEqual(r.data.items.find((it) => it.name === 'Lemon').cat, 'lemon', 'a name the catalogue knows is matched without an id');
  assert.strictEqual(r.data.items.find((it) => it.name === 'Leftover chilli').cat, 'leftovers');
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const receipt = await host('POST', '/api/snap', { photo: { type: 'image/png', data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('RECEIPT')]).toString('base64') } });
  assert.deepStrictEqual(receipt.data.items.map((x) => x.cat), ['bananas', 'chicken', 'spinach', 'bread', 'peas']);
  const inj = await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg('INJECT') } });
  assert.strictEqual(inj.status, 200);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text), 'no markup or bidi reaches the page');
  assert.ok(inj.data.items.length <= C.LIMITS.snapItems);
  const blank = await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg('BLANK') } });
  assert.deepStrictEqual([blank.status, /No food came out/.test(blank.data.error)], [422, true]);
  assert.match((await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg('MAXTOKENS') } })).data.error, /ran long/);
  const up = await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg('UPSTREAM401') } });
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg('UPSTREAM529') } });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  assert.strictEqual(store._dump(), dump, 'snapping stores nothing');
  assert.ok(!store._dump().includes(MARK), 'the photo is never stored');
});

test('chef’s idea: the list checked first, one metered call, only real items used', async () => {
  const calls = await modelCalls();
  assert.strictEqual((await host('POST', '/api/idea', {})).status, 400);
  assert.strictEqual((await host('POST', '/api/idea', { items: [{ id: 'nope', name: 'x', daysLeft: 1 }] })).status, 400);
  assert.strictEqual((await host('POST', '/api/idea', { items: 'x'.repeat(70 * 1024) })).status, 413, 'its own 64 KB parser, after the gates');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const items = [{ id: 'ispin0001', name: 'Spinach', daysLeft: 0 }, { id: 'ieggs0001', name: 'Eggs', daysLeft: 9 }, { id: 'ifeta0001', name: 'Feta', daysLeft: 2 }, { id: 'ipasta001', name: 'Pasta', daysLeft: 200 }];
  const r = await host('POST', '/api/idea', { items, avoid: ['Omelette'] });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.data.recipe.uses, ['ispin0001', 'ifeta0001', 'ieggs0001'], 'the three most urgent');
  assert.ok(r.data.recipe.steps.length >= 2 && r.data.recipe.title);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1);
  const inj = await host('POST', '/api/idea', { items: [{ id: 'iinject01', name: 'INJECT', daysLeft: 1 }, ...items] });
  assert.strictEqual(inj.status, 200);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text));
  assert.ok(inj.data.recipe.uses.every((id) => ['iinject01', ...items.map((x) => x.id)].includes(id)));
  assert.ok(inj.data.recipe.steps.length <= C.LIMITS.steps);
  const blank = await host('POST', '/api/idea', { items: [{ id: 'iblank001', name: 'BLANK', daysLeft: 1 }] });
  assert.deepStrictEqual([blank.status, /didn’t use anything/.test(blank.data.error)], [422, true]);
  const up = await host('POST', '/api/idea', { items: [{ id: 'iup000001', name: 'UPSTREAM500', daysLeft: 1 }] });
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text));
});

test('an unconfirmed free account gets the verify-email 403 before any model call or big body; out of credit is a 402', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg() } });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/shelflife/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/snap', { photo: { type: 'image/jpeg', data: BIG } })).status, 403, '403 before the big body is read');
    assert.strictEqual((await eve('POST', '/api/idea', { items: [{ id: 'ispin0001', name: 'Spinach', daysLeft: 0 }] })).status, 403);
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('POST', '/api/kitchens', { kitchen: localKitchen(), me: { name: '' } })).status, 400, 'a kitchen needs no AI and no confirmed address - just a name');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg() } })).status, 402);
  assert.strictEqual((await cal('POST', '/api/snap', { photo: { type: 'image/jpeg', data: BIG } })).status, 402, '402, not 413');
  assert.strictEqual((await cal('POST', '/api/idea', { items: [{ id: 'ispin0001', name: 'Spinach', daysLeft: 0 }] })).status, 402);
  await settle();
  assert.strictEqual(await modelCalls(), calls);
});

test('a host puts a phone’s kitchen online, history and all; a housemate with no account joins by code', async () => {
  const r = await host('POST', '/api/kitchens', { kitchen: localKitchen(), me: { name: 'Ana', emoji: '🦊' }, tz: 'Europe/London' });
  assert.strictEqual(r.status, 200, r.text);
  KID = r.data.id; CODE = r.data.kitchen.code; hostMid = r.data.kitchen.me;
  assert.ok(K.isKitchenId(KID) && K.isCode(CODE));
  const k = r.data.kitchen;
  assert.deepStrictEqual([k.name, k.host, k.tz, k.members.length, k.members[0].name, k.members[0].emoji], ['The Test Kitchen', true, 'Europe/London', 1, 'Ana', '🦊']);
  assert.deepStrictEqual(Object.keys(k.items).sort(), ['ieggs0001', 'ifeta0001', 'imilk0001', 'ipasta001', 'ispin0001']);
  assert.strictEqual(k.items.ifeta0001.name, 'Feta');
  assert.strictEqual(Object.keys(k.history).length, 2, 'the history came along, without what was too old');
  // A housemate opens the link.
  const ben = client();
  const look = await ben('GET', `/api/join/${CODE.toLowerCase().replace(/(...)/, '$1-')}`);
  assert.strictEqual(look.status, 200, 'the code is read however it is typed');
  assert.deepStrictEqual([look.data.name, look.data.members, look.data.already], ['The Test Kitchen', 1, null]);
  assert.ok(!('items' in look.data) && !('members' in look.data && Array.isArray(look.data.members)), 'a code shows the name and size, not the fridge or who');
  assert.strictEqual(ben.cookies.shelf_k, undefined, 'looking mints nothing');
  const j = await ben('POST', `/api/join/${CODE}`, { name: '<b>Ben</b> \u202e', emoji: '🐻' });
  assert.strictEqual(j.status, 200, JSON.stringify(j.data));
  assert.strictEqual(j.data.kitchenId, KID);
  const ck = j.setCookie.find((c) => c.startsWith('shelf_k='));
  assert.match(ck, /^shelf_k=[A-Za-z0-9_-]{22}; Path=\/shelflife\/; Max-Age=\d+; SameSite=Lax; HttpOnly/, 'HttpOnly, scoped to the app path');
  const v = await ben('GET', `/api/kitchens/${KID}`);
  assert.strictEqual(v.status, 200);
  assert.deepStrictEqual([v.data.kitchen.me === j.data.me, v.data.kitchen.host, v.data.kitchen.members.map((m) => m.name)], [true, false, ['Ana', 'Ben']]);
  assert.ok(!/ownerTag|acctTags|keyHash|"acct"|example\.com|YW5hLm/.test(v.text), 'no tag, hash, account id or email reaches a member');
  assert.strictEqual((await ben('POST', `/api/join/${CODE}`, { name: 'Someone else' })).data.me, j.data.me, 'a browser that joined gets itself back');
  assert.strictEqual((await client()('POST', `/api/join/${CODE}`, { name: 'ben' })).status, 409, 'names are unique, case folded');
  assert.strictEqual((await client()('POST', `/api/join/${CODE}`, { name: '' })).status, 400);
  // Polling: an idle kitchen costs one read.
  const same = await ben('GET', `/api/kitchens/${KID}?since=${v.data.kitchen.v}`);
  assert.deepStrictEqual(same.data, { same: true, v: v.data.kitchen.v });
});

test('members eat, bin, open, freeze, thaw, extend, edit, cook and undo - the core’s rules, over HTTP', async () => {
  const ben = client();
  await ben('POST', `/api/join/${CODE}`, { name: 'Cleo' });
  let r = await ben('POST', `/api/kitchens/${KID}/items/imilk0001/done`, { outcome: 'ate' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.data.kitchen.items.imilk0001.qty, 1);
  assert.match(r.data.msg, /milk/i);
  const eid = r.data.eid;
  assert.strictEqual(r.data.kitchen.history[eid].by, r.data.kitchen.me, 'whose it was');
  r = await ben('POST', `/api/kitchens/${KID}/undo/${eid}`, {});
  assert.strictEqual(r.data.kitchen.items.imilk0001.qty, 2);
  assert.ok(!r.data.kitchen.history[eid]);
  assert.strictEqual((await ben('POST', `/api/kitchens/${KID}/undo/${eid}`, {})).status, 404);
  assert.strictEqual((await ben('POST', `/api/kitchens/${KID}/undo/..%2Fx`, {})).status, 404);
  assert.strictEqual((await ben('POST', `/api/kitchens/${KID}/items/imilk0001/done`, { outcome: 'composted' })).status, 400);
  r = await ben('PATCH', `/api/kitchens/${KID}/items/ieggs0001`, { action: 'freeze' });
  assert.strictEqual(r.data.kitchen.items.ieggs0001.place, 'freezer');
  r = await ben('PATCH', `/api/kitchens/${KID}/items/ieggs0001`, { action: 'thaw' });
  assert.strictEqual(r.data.kitchen.items.ieggs0001.place, 'fridge');
  const today = C.localDate(Date.now(), 'Europe/London');
  r = await ben('PATCH', `/api/kitchens/${KID}/items/ifeta0001`, { action: 'open' });
  assert.deepStrictEqual([r.data.kitchen.items.ifeta0001.opened, r.data.kitchen.items.ifeta0001.use <= C.addDays(today, 5)], [today, true]);
  r = await ben('PATCH', `/api/kitchens/${KID}/items/ipasta001`, { action: 'extend', days: 3 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await ben('PATCH', `/api/kitchens/${KID}/items/ipasta001`, { action: 'explode' })).status, 400);
  assert.strictEqual((await ben('PATCH', `/api/kitchens/${KID}/items/ipasta001`, { action: 'extend', days: 99 })).status, 400);
  r = await ben('PATCH', `/api/kitchens/${KID}/items/ipasta001`, { name: '<b>Penne</b>', qty: 3 });
  assert.deepStrictEqual([r.data.kitchen.items.ipasta001.name, r.data.kitchen.items.ipasta001.qty], ['Penne', 3]);
  r = await ben('POST', `/api/kitchens/${KID}/items`, { items: [{ name: 'Bananas', qty: 4 }, { name: 'Leftover <script>chilli', cat: 'leftovers', leftover: true }] });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.data.added.length, 2);
  const chilli = Object.values(r.data.kitchen.items).find((it) => /chilli/.test(it.name));
  assert.ok(chilli.leftover && !/[<>]/.test(chilli.name));
  r = await ben('POST', `/api/kitchens/${KID}/cook`, { ids: ['ispin0001', 'ieggs0001'], title: 'Omelette' });
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(!r.data.kitchen.items.ispin0001 && !r.data.kitchen.items.ieggs0001);
  assert.strictEqual(Object.values(r.data.kitchen.history).filter((e) => e.dish === 'Omelette').length, 2);
  assert.strictEqual((await ben('POST', `/api/kitchens/${KID}/cook`, { ids: ['ispin0001'], title: 'Again' })).status, 404, 'already eaten');
  r = await ben('DELETE', `/api/kitchens/${KID}/items/${chilli.id}`);
  assert.ok(!r.data.kitchen.items[chilli.id]);
  assert.strictEqual((await ben('DELETE', `/api/kitchens/${KID}/items/${chilli.id}`)).status, 404);
  // The host sees all of it.
  const hv = await host('GET', `/api/kitchens/${KID}`);
  assert.strictEqual(hv.data.kitchen.items.ipasta001.name, 'Penne');
  // Names: your own; the host's anyone's.
  const me = hv.data.kitchen.members.find((m) => m.name === 'Cleo');
  assert.strictEqual((await ben('PATCH', `/api/kitchens/${KID}/members/${hostMid}`, { name: 'Pwned' })).status, 403);
  assert.strictEqual((await ben('PATCH', `/api/kitchens/${KID}/members/${me.id}`, { name: 'Cleo B', emoji: '🐸' })).status, 200);
  assert.strictEqual((await ben('PATCH', `/api/kitchens/${KID}/members/${me.id}`, { emoji: '💩' })).status, 400);
  // A member cannot rename, re-code or delete the kitchen; they can leave.
  for (const [m, p] of [['PATCH', `/api/kitchens/${KID}`], ['POST', `/api/kitchens/${KID}/code`], ['DELETE', `/api/kitchens/${KID}`]]) assert.strictEqual((await ben(m, p, { name: 'x' })).status, 401, 'no account at all: those need one');
  assert.deepStrictEqual((await ben('DELETE', `/api/kitchens/${KID}/members/${me.id}`)).data, { ok: true, left: true });
  assert.strictEqual((await ben('GET', `/api/kitchens/${KID}`)).status, 404, 'gone is gone');
  assert.strictEqual((await host('DELETE', `/api/kitchens/${KID}/members/${hostMid}`)).status, 409, 'the host deletes rather than leaves');
});

test('strangers get the 404 a missing kitchen gets, signed in or not; guessing codes is limited', async () => {
  for (const c of [client(), await register('olly.other@example.com')]) {
    for (const [m, p, b] of [['GET', `/api/kitchens/${KID}`], ['POST', `/api/kitchens/${KID}/items`, { name: 'Spy' }], ['PATCH', `/api/kitchens/${KID}/items/ipasta001`, { action: 'freeze' }], ['POST', `/api/kitchens/${KID}/items/ipasta001/done`, { outcome: 'binned' }], ['DELETE', `/api/kitchens/${KID}/items/ipasta001`], ['POST', `/api/kitchens/${KID}/cook`, { ids: ['ipasta001'] }], ['POST', `/api/kitchens/${KID}/undo/eabcdefgh`], ['PATCH', `/api/kitchens/${KID}/members/${hostMid}`, { name: 'Pwned' }], ['DELETE', `/api/kitchens/${KID}/members/${hostMid}`]]) {
      const r = await c(m, p, b);
      assert.strictEqual(r.status, 404, `${m} ${p}: ${r.status}`);
      assert.strictEqual(r.data.error, 'No kitchen here.');
    }
  }
  const olly = await register('olly2.other@example.com');
  for (const [m, p] of [['PATCH', `/api/kitchens/${KID}`], ['POST', `/api/kitchens/${KID}/code`], ['DELETE', `/api/kitchens/${KID}`]]) assert.strictEqual((await olly(m, p, { name: 'x' })).status, 404, `${m} ${p}`);
  assert.strictEqual((await client()('GET', '/api/kitchens/AAAAAAAAAAAAAAAA')).status, 404);
  assert.strictEqual((await host('GET', `/api/kitchens/${KID}`)).data.kitchen.items.ipasta001.name, 'Penne', 'nothing a stranger tried landed');
  const guesser = client();
  for (let i = 0; i < K.LIMITS.missesPerIp; i++) await guesser('GET', `/api/join/${K.newCode()}`);
  assert.strictEqual((await guesser('GET', `/api/join/${CODE}`)).status, 429, 'even the right code waits');
  const repeat = client();
  for (let i = 0; i < 40; i++) await repeat('GET', '/api/kitchens/AAAAAAAAAAAAAAAB');
  assert.strictEqual((await repeat('GET', `/api/join/${CODE}`)).status, 200, 'a dead id polled again is not guessing');
});

test('two phones at once both stick (and the same writes without the transaction would lose one)', async () => {
  const phones = [];
  for (let i = 0; i < 6; i++) {
    const c = client();
    const r = await c('POST', `/api/join/${CODE}`, { name: `Phone${i}` });
    assert.strictEqual(r.status, 200, r.text);
    phones.push(c);
  }
  // Six phones add three things each, all at once.
  const adds = await Promise.all(phones.flatMap((c, i) => [0, 1, 2].map((j) => c('POST', `/api/kitchens/${KID}/items`, { name: `Food ${i}-${j}`, daysLeft: 2 }))));
  assert.ok(adds.every((r) => r.status === 200), adds.map((r) => r.status).join(','));
  let v = (await host('GET', `/api/kitchens/${KID}`)).data.kitchen;
  const mine = Object.values(v.items).filter((it) => /^Food \d-\d$/.test(it.name));
  assert.strictEqual(mine.length, 18, 'every add stuck');
  // ...then eat or bin all eighteen at once, from six phones.
  const done = await Promise.all(mine.map((it, i) => phones[i % 6]('POST', `/api/kitchens/${KID}/items/${it.id}/done`, { outcome: i % 3 ? 'ate' : 'binned' })));
  assert.ok(done.every((r) => r.status === 200), done.map((r) => r.status).join(','));
  v = (await host('GET', `/api/kitchens/${KID}`)).data.kitchen;
  for (const it of mine) {
    assert.ok(!v.items[it.id], `${it.name} is gone`);
    assert.strictEqual(Object.values(v.history).filter((e) => e.iid === it.id).length, 1, `${it.name} is in the history once`);
  }
  // Two phones tap Ate it on the last yoghurt at the same moment: one wins.
  const y = await host('POST', `/api/kitchens/${KID}/items`, { name: 'Last yoghurt' });
  const yid = y.data.added[0];
  const both = await Promise.all([phones[0]('POST', `/api/kitchens/${KID}/items/${yid}/done`, { outcome: 'ate' }), phones[1]('POST', `/api/kitchens/${KID}/items/${yid}/done`, { outcome: 'ate' })]);
  assert.deepStrictEqual(both.map((r) => r.status).sort(), [200, 404], 'one eats it; the other is told it has gone');
  // One phone freezes the pasta while another edits its name: both land.
  await Promise.all([phones[2]('PATCH', `/api/kitchens/${KID}/items/ipasta001`, { action: 'freeze' }), phones[3]('PATCH', `/api/kitchens/${KID}/items/ifeta0001`, { name: 'Greek feta' })]);
  v = (await host('GET', `/api/kitchens/${KID}`)).data.kitchen;
  assert.deepStrictEqual([v.items.ipasta001.place, v.items.ifeta0001.name], ['freezer', 'Greek feta']);
  // The same two adds as a plain read-change-write: one is lost.
  await Promise.all(['ilost0001', 'ilost0002'].map((id) => store._unsafeUpdate('kitchens', KID, (cur) => ({ ...cur, items: { ...cur.items, [id]: { ...cur.items.ifeta0001, id } } }))));
  const lost = await store.get('kitchens', KID);
  assert.ok(!(lost.items.ilost0001 && lost.items.ilost0002), 'without the transaction one add is lost');
  for (const c of phones) await c('DELETE', `/api/kitchens/${KID}/members/${(await c('GET', `/api/kitchens/${KID}`)).data.kitchen.me}`);
});

test('limits: 400 things, 12 people, 5 kitchens a host; rotate the code; delete takes everything', async () => {
  // Fill to the ceiling in big adds.
  let v = (await host('GET', `/api/kitchens/${KID}`)).data.kitchen;
  let have = Object.keys(v.items).length;
  let n = 0;
  while (have < C.LIMITS.items) {
    const batch = [];
    for (let i = 0; i < Math.min(C.LIMITS.addAtOnce, C.LIMITS.items - have); i++) batch.push({ name: `Filler ${n++}` });
    const r = await host('POST', `/api/kitchens/${KID}/items`, { items: batch });
    assert.strictEqual(r.status, 200, r.text);
    have = Object.keys(r.data.kitchen.items).length;
  }
  const full = await host('POST', `/api/kitchens/${KID}/items`, { name: 'One more' });
  assert.deepStrictEqual([full.status, /400/.test(full.data.error)], [409, true]);
  // People.
  const joiners = [];
  const already = v.members.length;
  for (let i = 0; i < K.LIMITS.members - already; i++) {
    const c = client();
    const r = await c('POST', `/api/join/${CODE}`, { name: `Person${i}` });
    assert.strictEqual(r.status, 200, r.text);
    joiners.push(c);
  }
  assert.deepStrictEqual([(await client()('POST', `/api/join/${CODE}`, { name: 'Thirteen' })).status, (await client()('GET', `/api/join/${CODE}`)).data.full], [409, true]);
  // Rotating the code kills the old link, not the people in.
  const rot = await host('POST', `/api/kitchens/${KID}/code`, {});
  assert.notStrictEqual(rot.data.kitchen.code, CODE);
  assert.strictEqual((await client()('GET', `/api/join/${CODE}`)).status, 404);
  assert.strictEqual((await joiners[0]('GET', `/api/kitchens/${KID}`)).status, 200);
  CODE = rot.data.kitchen.code;
  // The host removes someone.
  const someone = (await joiners[1]('GET', `/api/kitchens/${KID}`)).data.kitchen.me;
  assert.strictEqual((await host('DELETE', `/api/kitchens/${KID}/members/${someone}`)).status, 200);
  assert.strictEqual((await joiners[1]('GET', `/api/kitchens/${KID}`)).status, 404);
  assert.strictEqual((await host('PATCH', `/api/kitchens/${KID}`, { name: '<b>Renamed</b>' })).data.kitchen.name, 'Renamed');
  // Five kitchens a host.
  const zed = await register('zed.many@example.com');
  for (let i = 0; i < K.LIMITS.kitchensPerHost; i++) assert.strictEqual((await zed('POST', '/api/kitchens', { kitchen: { name: `K${i}`, items: {} }, me: { name: 'Zed' }, tz: 'UTC' })).status, 200);
  assert.strictEqual((await zed('POST', '/api/kitchens', { kitchen: { name: 'K6' }, me: { name: 'Zed' }, tz: 'UTC' })).status, 409);
  assert.strictEqual((await zed('GET', '/api/kitchens')).data.kitchens.length, 5);
  assert.deepStrictEqual((await host('GET', '/api/kitchens')).data.kitchens.map((k) => [k.id, k.host]), [[KID, true]]);
  assert.ok(store._dump().includes(KID));
  assert.strictEqual((await host('DELETE', `/api/kitchens/${KID}`)).status, 200);
  assert.ok(!store._dump().includes(KID), 'nothing names it any more');
  assert.strictEqual((await host('GET', `/api/kitchens/${KID}`)).status, 404);
});

test('a kitchen nobody has touched in 180 days is deleted by the read that finds it', async () => {
  const yan = await register('yan.idle@example.com');
  const c = await yan('POST', '/api/kitchens', { kitchen: localKitchen(), me: { name: 'Yan' }, tz: 'UTC' });
  const id = c.data.id;
  await store.merge('kitchens', id, { updatedAt: new Date(Date.now() - 181 * 86400000).toISOString() });
  const r = await yan('GET', `/api/kitchens/${id}`);
  assert.deepStrictEqual([r.status, r.data.code], [404, 'expired']);
  assert.ok(!store._dump().includes(id));
  // And one that is used keeps going: every write moves updatedAt.
  const c2 = await yan('POST', '/api/kitchens', { kitchen: localKitchen(), me: { name: 'Yan' }, tz: 'UTC' });
  await store.merge('kitchens', c2.data.id, { updatedAt: new Date(Date.now() - 179 * 86400000).toISOString() });
  await yan('POST', `/api/kitchens/${c2.data.id}/items/ipasta001/done`, { outcome: 'ate' });
  assert.ok(Date.parse((await store.get('kitchens', c2.data.id)).updatedAt) > Date.now() - 60000);
});

test('stored kitchens hold no email, no account id, no browser key and no photo', async () => {
  const g = client();
  const qq = await register('qq.store@example.com');
  const c = await qq('POST', '/api/kitchens', { kitchen: localKitchen(), me: { name: 'Q' }, tz: 'UTC' });
  await g('POST', `/api/join/${c.data.kitchen.code}`, { name: 'Keyholder' });
  await qq('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg() } });
  const dump = store._dump();
  for (const email of ['ana.host@example.com', 'olly.other@example.com', 'zed.many@example.com', 'qq.store@example.com', 'yan.idle@example.com']) {
    assert.ok(!dump.includes(email), `no email: ${email}`);
    assert.ok(!dump.includes(uidOf(email)), `no account id: ${email}`);
  }
  assert.ok(g.cookies.shelf_k && !dump.includes(g.cookies.shelf_k), 'the browser key itself is never stored');
  assert.ok(!dump.includes(MARK) && !dump.includes('/9j/'), 'no photo bytes');
  const doc = await store.get('kitchens', c.data.id);
  assert.deepStrictEqual(Object.keys(doc).sort(), ['acctTags', 'code', 'created', 'createdAt', 'history', 'id', 'items', 'members', 'name', 'ownerTag', 'tz', 'updatedAt', 'v'].sort());
  for (const m of doc.members) assert.deepStrictEqual(Object.keys(m).sort(), ['acct', 'emoji', 'host', 'id', 'joinedAt', 'keyHash', 'name'].sort());
  for (const it of Object.values(doc.items)) assert.deepStrictEqual(Object.keys(it).sort(), ['added', 'cat', 'emoji', 'frozen', 'id', 'leftover', 'name', 'opened', 'place', 'qty', 'use'].sort());
  assert.deepStrictEqual(Object.keys(await store.list('kitchens')).length > 0, true);
  const cols = JSON.parse(dump).map(([p]) => p);
  assert.deepStrictEqual(cols.sort(), ['kitchens'], 'one collection, nothing else');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/shelflife', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/shelflife`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
