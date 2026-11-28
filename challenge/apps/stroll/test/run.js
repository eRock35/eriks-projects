// The rules first (text, codes, what a stroll and a shop may hold, when
// stamping is open, a card's progress, a stamp, the draw, the organizer's
// one door, what each phone is shown, the words on a sign, the example,
// the storage module), then the look, the page's promises and the copy,
// then end to end against the memory store:
//   STROLL_MEMORY=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /stroll, the way
// the lab mounts it, so the key cookie's path, the parser and the limiters
// run as deployed. Every name here is made up; phone numbers are built from
// pieces so no file carries one.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.STROLL_MEMORY !== '1') {
  console.error('run with STROLL_MEMORY=1');
  process.exit(1);
}

const { app, store, identityStore, LIMITS } = require('../server');
const C = require('../public/stroll-core');
const D = require('../public/demo');
const S = require('../public/stroll-store');
const G = require('../lib/strolls');
const QR = require('../public/qr');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
const ch = (n) => String.fromCharCode(n);
const RLO = ch(0x202E), ZW = ch(0x200B), FW_AT = ch(0xFF20);
const PHONE = ['555', '201', '3344'].join(' ');
const todayUtc = () => new Date().toISOString().slice(0, 10);
const throwsWith = (fn, status, re) => assert.throws(fn, (e) => { assert.strictEqual(e.status, status, e.message); assert.ok(e.expose); if (re) assert.match(e.message, re); return true; });

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
function cieLab(h) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16)));
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const labDist = (a, b) => { const x = cieLab(a), y = cieLab(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };

/* A street built by hand for the rules: four shops, Saturday and Sunday,
 * three stamps finish a passport, extra stamps are extra entries. */
const SAT = '2026-11-28', SUN = '2026-11-29';
const NOW = Date.parse('2026-11-28T15:00:00Z');
const TAG = (n) => `tag${String(n).padStart(3, '0')}${'x'.repeat(26)}`;
function street(over) {
  return {
    id: 'AAAAbbbbCCCCdddd', code: 'MAPLE2', title: 'Maple Street Passport', place: 'Maple Street', from: SAT, to: SUN, goal: 3, bonus: true, prize: 'A basket', v: 1,
    host: { name: 'Ana', keyHash: 'h' },
    shops: { sgift001: { name: 'Juniper & Wren', perk: 'Free gift wrap', k: 'JW7K', ts: 1 }, sbook002: { name: 'Dog-Eared Books', perk: '', k: 'DE4B', ts: 2 }, sbake003: { name: 'Crumb Bakery', perk: '', k: 'CR9M', ts: 3 }, sbike004: { name: 'Spoke & Chain', perk: '', k: 'SP3C', ts: 4 } },
    winners: {}, ...(over || {}),
  };
}
const card = (ids, over) => ({ name: 'Priya', stamps: Object.fromEntries((ids || []).map((id) => [id, NOW])), ...(over || {}) });
const ALL = ['sgift001', 'sbook002', 'sbake003', 'sbike004'];

/* ================================================================== *
 * The rules
 * ================================================================== */

test('text: cleaned to one line and a length; a first name is letters only; an email address, a link, a phone number and markup are refused with a reason', () => {
  assert.strictEqual(C.line(`  Juniper${ZW}  &${RLO} Wren \n`, 40), 'Juniper & Wren');
  assert.strictEqual(C.line('<b>Bold</b> shop<script>', 40), 'Bold shop');
  assert.strictEqual(Array.from(C.line('é'.repeat(90), 40)).length, 40);
  assert.strictEqual(C.cleanName('  priya  '), 'priya');
  assert.strictEqual(C.cleanName('Mary-Jo O’Neil'), 'Mary-Jo O’Neil');
  assert.strictEqual(C.cleanName('R2D2 <i>x</i>'), 'R D x');
  assert.strictEqual(C.cleanName('12345'), '');
  assert.strictEqual(C.cleanName(`ana${AT}example.com`), 'ana example.com');
  assert.strictEqual(Array.from(C.cleanName('a'.repeat(80))).length, C.LIMITS.name);
  assert.match(C.refuse(`mail me ana${AT}example.com`), /email/);
  assert.match(C.refuse(`ana${FW_AT}example`), /email/);
  assert.match(C.refuse('see https://example.com'), /links/);
  assert.match(C.refuse('www.example.com'), /links/);
  assert.match(C.refuse(`call ${PHONE}`), /phone/);
  assert.match(C.refuse('<img>'), /markup/);
  assert.strictEqual(C.refuse('A $100 basket, 10% off, open 9-5'), '');
  throwsWith(() => C.field(`x${AT}y.z`, 40, 'The prize'), 400, /^The prize: No email/);
  assert.strictEqual(C.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.strictEqual(C.plural(1, 'entry', 'entries'), '1 entry');
  assert.strictEqual(C.plural(2, 'entry', 'entries'), '2 entries');
});

test('codes and ids: six characters open a passport, four are a counter’s; no 0, O, 1 or I; typed any way they read the same', () => {
  assert.ok(!/[01IO]/.test(C.CODE_ALPHABET) && C.CODE_ALPHABET.length === 32);
  assert.strictEqual(C.normalizeCode(' ab-c d2 '), 'ABCD2');
  assert.ok(C.isCode('MAPLE2') && !C.isCode('MAPLE0') && !C.isCode('MAPLE') && !C.isCode(123456));
  assert.ok(C.isStamp('JW7K') && !C.isStamp('JW1K') && !C.isStamp('JW7KK') && !C.isStamp(null));
  assert.strictEqual(C.formatCode('maple2'), 'MAP-LE2');
  assert.ok(C.isGid('AAAAbbbbCCCC_d-d') && !C.isGid('short') && !C.isGid('AAAAbbbbCCCCdd/d'));
  assert.ok(C.isTag('x'.repeat(32)) && !C.isTag('x'.repeat(31)) && !C.isTag('__proto__'));
  assert.ok(C.isId('sgift001') && !C.isId('__proto__') && !C.isId('S1') && !C.isId('constructor.x'));
  let n = 0; const id = C.newId(() => (n++) % 32, 8, 's');
  assert.ok(C.isId(id) && id.length === 9);
  for (let i = 0; i < 200; i++) { assert.ok(C.isCode(G.newCode())); assert.ok(C.isStamp(G.newStamp())); assert.ok(C.isGid(G.newGid())); }
});

test('a stroll’s details: a name, real days in order, at most 31 of them, not already over, a goal from 1 to 40; refused with a reason, never quietly changed', () => {
  const ok = { title: ' Maple Street  Passport ', place: 'Maple Street', from: SAT, to: SUN, goal: '3', prize: 'A $100 basket' };
  assert.deepStrictEqual(C.cleanStroll(ok, SAT), { title: 'Maple Street Passport', place: 'Maple Street', from: SAT, to: SUN, goal: 3, bonus: true, prize: 'A $100 basket' });
  assert.strictEqual(C.cleanStroll({ ...ok, bonus: false, goal: 40 }, SAT).bonus, false);
  throwsWith(() => C.cleanStroll({ ...ok, title: '  ' }, SAT), 400, /name/);
  throwsWith(() => C.cleanStroll({ ...ok, from: '2026-02-30' }, SAT), 400, /first and the last day/);
  throwsWith(() => C.cleanStroll({ ...ok, to: '2026-11-27' }, SAT), 400, /before the first/);
  throwsWith(() => C.cleanStroll({ ...ok, to: '2026-12-29' }, SAT), 400, /up to 31 days/);
  assert.ok(C.cleanStroll({ ...ok, to: '2026-12-28' }, SAT));
  throwsWith(() => C.cleanStroll(ok, '2026-12-01'), 400, /already over/);
  assert.ok(C.cleanStroll(ok, '2026-11-30'), 'a day’s grace for a street west of UTC');
  for (const goal of [0, 41, '2.5', 'three', null, undefined, -1]) throwsWith(() => C.cleanStroll({ ...ok, goal }, SAT), 400, /How many stamps/);
  throwsWith(() => C.cleanStroll({ ...ok, prize: `ask ana${AT}example.com` }, SAT), 400, /^The prize: No email/);
  throwsWith(() => C.cleanStroll({ ...ok, place: `call ${PHONE}` }, SAT), 400, /phone/);
  throwsWith(() => C.cleanStroll(null, SAT), 400);
  assert.deepStrictEqual(C.cleanShop({ name: ' Crumb  Bakery ', perk: 'A free cookie' }), { name: 'Crumb Bakery', perk: 'A free cookie' });
  assert.deepStrictEqual(C.cleanShop('Crumb'), { name: 'Crumb', perk: '' });
  throwsWith(() => C.cleanShop({ name: '' }), 400, /shop’s name/);
  throwsWith(() => C.cleanShop({ name: 'Crumb', perk: 'see www.crumb.example' }), 400, /^The perk: No links/);
});

test('the days: before, on and after; stamping is open from the eve of the first day to the day after the last; kept 30 days, then expired', () => {
  const s = street();
  assert.deepStrictEqual(['2026-11-27', SAT, SUN, '2026-11-30'].map((d) => C.phase(s, d)), ['before', 'on', 'on', 'after']);
  assert.deepStrictEqual(['2026-11-26', '2026-11-27', SAT, SUN, '2026-11-30', '2026-12-01'].map((d) => C.stampOpen(s, d)), [false, true, true, true, true, false]);
  assert.ok(!C.expired(s, '2026-12-29') && C.expired(s, '2026-12-30') && C.expired({ ...s, to: 'x' }, SAT));
  assert.strictEqual(C.whenLine(s, '2026-11-27'), 'Starts tomorrow');
  assert.strictEqual(C.whenLine(s, '2026-11-20'), 'Starts Saturday, Nov 28');
  assert.strictEqual(C.whenLine(s, SAT), 'On now - until Sunday, Nov 29');
  assert.strictEqual(C.whenLine(s, SUN), 'Last day today');
  assert.strictEqual(C.whenLine({ ...s, to: SAT }, SAT), 'Today only');
  assert.strictEqual(C.whenLine(s, '2026-12-02'), 'Ended Nov 29');
  assert.strictEqual(C.dateRange(SAT, SUN), 'Nov 28 - 29');
  assert.strictEqual(C.dateRange('2026-11-29', '2026-12-02'), 'Nov 29 - Dec 2');
  assert.strictEqual(C.dateRange(SAT, SAT), 'Nov 28');
});

test('a card’s progress: only shops still on the passport count; the goal is never more than there are shops; a finished card has one entry, and one more per extra stamp when the passport says so', () => {
  const s = street();
  assert.deepStrictEqual(C.progress(s, card([])), { n: 0, goal: 3, of: 4, done: false, left: 3, entries: 0, all: false });
  assert.deepStrictEqual(C.progress(s, card(['sgift001', 'sbook002'])), { n: 2, goal: 3, of: 4, done: false, left: 1, entries: 0, all: false });
  assert.deepStrictEqual(C.progress(s, card(['sgift001', 'sbook002', 'sbake003'])), { n: 3, goal: 3, of: 4, done: true, left: 0, entries: 1, all: false });
  assert.deepStrictEqual(C.progress(s, card(ALL)), { n: 4, goal: 3, of: 4, done: true, left: 0, entries: 2, all: true });
  assert.strictEqual(C.progress({ ...s, bonus: false }, card(ALL)).entries, 1);
  assert.strictEqual(C.progress(s, card(['sgift001', 'sgone999', 'sbook002'])).n, 2, 'a stamp for a shop no longer on the passport does not count');
  assert.strictEqual(C.goalOf({ ...s, goal: 9 }), 4);
  assert.strictEqual(C.progress({ ...s, goal: 9 }, card(ALL)).entries, 1);
  const empty = street({ shops: {} });
  assert.strictEqual(C.goalOf(empty), 0);
  assert.strictEqual(C.progress(empty, card([])).done, false, 'no shops: nobody is finished');
  assert.strictEqual(C.progress(s, {}).n, 0);
  assert.strictEqual(C.progress(s, { stamps: { __proto__: 1, constructor: 1 } }).n, 0);
  const line = (ids, over) => C.progressLine(C.progress(street(over), card(ids)));
  assert.strictEqual(line([]), '3 more stamps to enter the draw.');
  assert.strictEqual(line(['sgift001', 'sbook002']), '1 more stamp to enter the draw.');
  assert.strictEqual(line(['sgift001', 'sbook002', 'sbake003']), 'You’re in the draw.');
  assert.strictEqual(line(ALL), 'Every shop stamped. 2 entries in the draw.');
  assert.strictEqual(line(ALL, { bonus: false }), 'Every shop stamped. You’re in the draw.');
  assert.strictEqual(line([], { shops: {} }), 'No shops on this passport yet.');
});

test('a stamp: the counter’s code, typed any way; once per shop; every wrong code reads the same; closed outside the days; a removed passport gets none', () => {
  const s = street(), ctx = { now: NOW, today: SAT };
  assert.deepStrictEqual(C.stamp(s, card([]), 'jw-7k', ctx), { shop: 'sgift001', isNew: true, set: { 'stamps.sgift001': NOW } });
  assert.deepStrictEqual(C.stamp(s, card(['sgift001']), 'JW7K', ctx), { shop: 'sgift001', isNew: false, set: {} });
  const wrong = [];
  for (const bad of ['ZZZZ', '', 'JW7', 'JW7KK', 'MAPLE2', null, {}, 'jw7k!x', '<b>']) { try { C.stamp(s, card([]), bad, ctx); assert.fail(`${bad} opened something`); } catch (e) { assert.strictEqual(e.status, 404, String(bad)); assert.strictEqual(e.code, 'wrong'); wrong.push(e.message); } }
  assert.strictEqual(new Set(wrong).size, 1); assert.strictEqual(wrong[0], C.WRONG_CODE);
  throwsWith(() => C.stamp(s, card([]), 'JW7K', { now: NOW, today: '2026-11-26' }), 409, /Stamps open Saturday, Nov 28/);
  throwsWith(() => C.stamp(s, card([]), 'JW7K', { now: NOW, today: '2026-12-01' }), 409, /ended/);
  throwsWith(() => C.stamp(s, card([]), 'ZZZZ', { now: NOW, today: '2026-12-01' }), 409, /ended/);
  throwsWith(() => C.stamp(s, card([], { removed: true }), 'JW7K', ctx), 403, /removed/);
  assert.strictEqual(C.shopByCode(s, 'de4b'), 'sbook002');
  assert.strictEqual(C.shopByCode(s, 'k'), null);
});

test('the draw: every ENTRY has the same chance (each pick from 0 to the total lands on its owner); unfinished, removed and past winners are out; nobody to draw is a 409; five winners at most; the dice are handed in', () => {
  const s = street();
  const cards = [
    { tag: TAG(1), name: 'Priya', stamps: card(ALL).stamps },                               // 2 entries
    { tag: TAG(2), name: 'Marcus', stamps: card(['sgift001', 'sbook002', 'sbake003']).stamps }, // 1
    { tag: TAG(3), name: 'Dee', stamps: card(['sgift001', 'sbook002']).stamps },              // not finished
    { tag: TAG(4), name: 'Cheat', stamps: card(ALL).stamps, removed: true },                // removed
    { tag: TAG(5), name: 'Lin', stamps: card(ALL).stamps },                                 // 2
    { tag: 'bad', name: 'No tag', stamps: card(ALL).stamps },
    null,
  ];
  assert.deepStrictEqual(C.entrants(s, cards).map((e) => [e.name, e.entries]), [['Priya', 2], ['Marcus', 1], ['Lin', 2]]);
  const wins = {};
  for (let i = 0; i < 5; i++) { const w = C.draw(s, cards, (n) => { assert.strictEqual(n, 5); return i; }); wins[w.name] = (wins[w.name] || 0) + 1; assert.strictEqual(w.of, 5); assert.strictEqual(w.people, 3); }
  assert.deepStrictEqual(wins, { Priya: 2, Marcus: 1, Lin: 2 });
  assert.deepStrictEqual(C.entrants({ ...s, bonus: false }, cards).map((e) => e.entries), [1, 1, 1]);
  const won = street({ winners: { [TAG(1)]: { name: 'Priya', claim: 'ABCDEF', at: 1 } } });
  assert.deepStrictEqual(C.entrants(won, cards).map((e) => e.name), ['Marcus', 'Lin'], 'nobody wins twice');
  throwsWith(() => C.draw(s, [cards[2], cards[3]], () => 0), 409, /Nobody has finished/);
  throwsWith(() => C.draw(s, [], () => 0), 409);
  const five = street({ winners: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [TAG(50 + n), { name: 'W', claim: 'ABCDEF', at: n }])) });
  throwsWith(() => C.draw(five, cards, () => 0), 409, /5 winners/);
  for (const bad of [-1, 5, 1.5, NaN, '0']) assert.throws(() => C.draw(s, cards, () => bad), /bad pick/);
  assert.deepStrictEqual(C.winnerList(street({ winners: { [TAG(2)]: { name: 'B', claim: 'BBBBBB', at: 2, given: true }, [TAG(1)]: { name: 'A', claim: 'AAAAAA', at: 1 } } })).map((w) => [w.name, w.given]), [['A', false], ['B', true]]);
  const src = read('public/stroll-core.js');
  assert.ok(!/Date\.now|Math\.random|new Date\(\)|crypto/.test(src), 'no clock and no dice in the rules');
  assert.match(read('lib/strolls.js'), /const rand = \(n\) => crypto\.randomInt\(n\)/);
  assert.match(read('server.js'), /Core\.draw\(cur, rows, G\.rand\)/);
});

test('the organizer’s one door: details, shops added with codes of their own (a clash is skipped), renamed, removed, a new code, a prize handed over; a duplicate shop and a forty-first are refused; anything else is a 400', () => {
  let s = street();
  const ctx = (over) => ({ now: NOW, today: SAT, ids: ['snew0001', 'snew0002', 'snew0003'], codes: ['JW7K', 'DE4B', 'AAAA', 'BBBB', 'AAAA', 'CCCC'], ...(over || {}) });
  let ch1 = C.act(s, { t: 'addshops', shops: ['Fern & Frond', { name: 'The Toy Box', perk: 'A balloon' }] }, ctx());
  assert.deepStrictEqual(ch1.set, { 'shops.snew0001': { name: 'Fern & Frond', perk: '', k: 'AAAA', ts: NOW }, 'shops.snew0002': { name: 'The Toy Box', perk: 'A balloon', k: 'BBBB', ts: NOW + 1 } });
  s = C.patch(s, ch1);
  assert.deepStrictEqual(C.shopIds(s), [...ALL, 'snew0001', 'snew0002']);
  assert.strictEqual(new Set(C.shopIds(s).map((id) => s.shops[id].k)).size, 6);
  throwsWith(() => C.act(s, { t: 'addshops', shops: ['fern  and frond', 'FERN & FROND'] }, ctx({ codes: ['DDDD', 'EEEE', 'FFFF'] })), 409, /already/);
  throwsWith(() => C.act(s, { t: 'addshops', shops: ['New One', 'new one'] }, ctx({ codes: ['DDDD', 'EEEE', 'FFFF'] })), 409, /already/);
  throwsWith(() => C.act(s, { t: 'addshops', shops: [] }, ctx()), 400);
  throwsWith(() => C.act(s, { t: 'addshops', shops: ['Ok', `x${AT}y.z`] }, ctx({ codes: ['DDDD', 'EEEE'] })), 400, /email/);
  throwsWith(() => C.act(s, { t: 'addshops', shops: ['Another'] }, ctx({ codes: ['JW7K', 'bad', 'AAAA'] })), 503, /counter code/);
  const many = Array.from({ length: 35 }, (_, i) => `Shop ${String.fromCharCode(65 + (i % 26))}${i > 25 ? 'x' : ''}`);
  throwsWith(() => C.act(s, { t: 'addshops', shops: many }, ctx()), 400, /up to 40 shops/);
  throwsWith(() => C.act(s, { t: 'addshops', shops: Array.from({ length: 41 }, (_, i) => `S ${i}`) }, ctx()), 400, /up to 40/);
  s = C.patch(s, C.act(s, { t: 'editshop', id: 'sbook002', name: 'Dog-Eared Books & Maps', perk: '10% off staff picks' }, ctx()));
  assert.deepStrictEqual(s.shops.sbook002, { name: 'Dog-Eared Books & Maps', perk: '10% off staff picks', k: 'DE4B', ts: 2 });
  throwsWith(() => C.act(s, { t: 'editshop', id: 'sbook002', name: 'Crumb Bakery' }, ctx()), 409, /already/);
  assert.ok(C.act(s, { t: 'editshop', id: 'sbook002', name: 'dog-eared books & maps' }, ctx()), 'a shop may keep its own name');
  for (const id of ['snope999', '__proto__', 'constructor', '', null, 'sbook002.k']) throwsWith(() => C.act(s, { t: 'editshop', id, name: 'X' }, ctx()), 404);
  const nc = C.act(s, { t: 'newcode', id: 'sgift001' }, ctx({ codes: ['JW7K', 'ZZZZ'] }));
  assert.deepStrictEqual(nc, { set: { 'shops.sgift001.k': 'ZZZZ' }, del: [] });
  s = C.patch(s, nc);
  assert.strictEqual(C.shopByCode(s, 'JW7K'), null, 'the old sign stops working');
  assert.strictEqual(C.shopByCode(s, 'ZZZZ'), 'sgift001');
  s = C.patch(s, C.act(s, { t: 'delshop', id: 'sbike004' }, ctx()));
  assert.ok(!C.own(s.shops, 'sbike004'));
  s = C.patch(s, C.act(s, { t: 'details', title: 'Maple Street Stroll', place: '', from: SAT, to: '2026-12-05', goal: 2, bonus: false, prize: '' }, ctx()));
  assert.deepStrictEqual([s.title, s.place, s.to, s.goal, s.bonus, s.prize, s.code], ['Maple Street Stroll', '', '2026-12-05', 2, false, '', 'MAPLE2']);
  throwsWith(() => C.act(s, { t: 'details', title: 'X', from: SAT, to: '2026-11-20', goal: 2 }, ctx()), 400);
  throwsWith(() => C.act(s, { t: 'details', title: 'X', from: '2026-10-01', to: '2026-10-02', goal: 2 }, ctx()), 400, /already over/);
  const w = street({ winners: { [TAG(1)]: { name: 'Priya', claim: 'ABCDEF', at: 1 } } });
  assert.deepStrictEqual(C.act(w, { t: 'given', tag: TAG(1) }, ctx()).set, { [`winners.${TAG(1)}.given`]: true });
  assert.deepStrictEqual(C.act(w, { t: 'given', tag: TAG(1), on: false }, ctx()).set, { [`winners.${TAG(1)}.given`]: false });
  for (const tag of [TAG(2), '__proto__', '', null]) throwsWith(() => C.act(w, { t: 'given', tag }, ctx()), 404);
  for (const bad of [null, 'x', [], {}, { t: 'winners' }, { t: 'host' }, { t: 7 }, { t: 'stamp', code: 'JW7K' }]) throwsWith(() => C.act(street(), bad, ctx()), 400);
  // Nothing an action carries beyond its own fields is ever read.
  const sneaky = C.act(street(), { t: 'editshop', id: 'sgift001', name: 'Juniper', k: 'AAAA', ts: 0, count: 99, host: true }, ctx());
  assert.deepStrictEqual(Object.keys(sneaky.set).sort(), ['shops.sgift001.name', 'shops.sgift001.perk']);
});

test('what each phone is shown: the organizer gets every counter code, the counts and the winners’ claim codes; A SHOPPER GETS NO CODE, no count, no other shopper - only a winner’s first name, and their own claim', () => {
  const s = street({ winners: { [TAG(1)]: { name: 'Priya', claim: 'QQQQQQ', at: 5 }, [TAG(2)]: { name: 'Marcus', claim: 'RRRRRR', at: 9, given: true } } });
  const counts = { cards: 12, stamps: 31, done: 4, s_sgift001: 11, s_sbook002: 9, s_sgone999: 3, d_20261128: 20, d_20261130: 2, cards_bad: 'x' };
  const h = C.view(s, { role: 'host' }, { today: SAT, counts });
  assert.deepStrictEqual(h.shops.map((x) => [x.name, x.k, x.count]), [['Juniper & Wren', 'JW7K', 11], ['Dog-Eared Books', 'DE4B', 9], ['Crumb Bakery', 'CR9M', 0], ['Spoke & Chain', 'SP3C', 0]]);
  assert.deepStrictEqual(h.counts, { cards: 12, stamps: 31, done: 4 });
  assert.deepStrictEqual(h.days, [{ day: SAT, n: 20 }, { day: SUN, n: 0 }, { day: '2026-11-30', n: 2 }]);
  assert.deepStrictEqual(h.winners.map((w) => [w.name, w.claim, w.given]), [['Priya', 'QQQQQQ', false], ['Marcus', 'RRRRRR', true]]);
  assert.strictEqual(h.t, '1.12.31.4');
  assert.deepStrictEqual(C.view(s, { role: 'host' }, { today: SAT, counts: null }).counts, { cards: 0, stamps: 0, done: 0 });
  const v = C.view(s, { role: 'card', card: card(['sgift001', 'sbook002']), tag: TAG(7) }, { today: SAT });
  const text = JSON.stringify(v);
  for (const secret of ['JW7K', 'DE4B', 'CR9M', 'SP3C', 'QQQQQQ', 'RRRRRR', TAG(1), TAG(2), 'keyHash', '"counts"', '"count"', '"days"', '"k"']) assert.ok(!text.includes(secret), `a shopper was sent ${secret}`);
  assert.deepStrictEqual(v.shops.map((x) => x.got), [true, true, false, false]);
  assert.deepStrictEqual(v.me, { name: 'Priya', n: 2, done: false, left: 1, entries: 0, all: false, removed: false });
  assert.deepStrictEqual(v.winners, [{ name: 'Priya' }, { name: 'Marcus' }]);
  assert.strictEqual(v.won, null);
  assert.deepStrictEqual([v.role, v.goal, v.host, v.open, v.t], ['card', 3, 'Ana', true, '1.2.2']);
  const mine = C.view(s, { role: 'card', card: card(ALL), tag: TAG(2) }, { today: SAT });
  assert.deepStrictEqual(mine.won, { claim: 'RRRRRR', given: true });
  assert.ok(!JSON.stringify(mine).includes('QQQQQQ'));
  assert.strictEqual(C.view(s, { role: 'card', card: card([]), tag: '__proto__' }, { today: SAT }).won, null);
  assert.strictEqual(C.view(s, { role: 'card', card: card([]), tag: TAG(7) }, { today: '2026-12-05' }).open, false);
});

test('the words: a counter sign carries its shop, its perk, its code and a link that joins and stamps; the poster carries the join link, the rules and every shop; the invitation says what to do', () => {
  const s = street();
  const v = C.view(s, { role: 'host' }, { today: SAT, counts: null });
  const base = 'https://lab.example/stroll/';
  const sg = C.sign(v, v.shops[0], base);
  assert.deepStrictEqual([sg.over, sg.head, sg.shop, sg.perk, sg.code, sg.url, sg.when, sg.prize], ['Maple Street Passport', 'Get your stamp here', 'Juniper & Wren', 'Free gift wrap', 'JW7K', 'https://lab.example/stroll/#stamp=MAPLE2.JW7K', 'Nov 28 - 29', 'A basket']);
  assert.match(sg.how, /No app, no sign-up/);
  const p = C.poster(v, base);
  assert.deepStrictEqual([p.head, p.url, p.code, p.shops.length], ['Maple Street Passport', 'https://lab.example/stroll/#join=MAPLE2', 'MAP-LE2', 4]);
  assert.deepStrictEqual(p.rules, ['Collect a stamp at 3 shops to enter the prize draw.', 'Every stamp after that is one more entry.', 'One stamp per shop. No purchase is needed for a stamp unless a shop’s own sign says so.']);
  assert.deepStrictEqual(C.rules(C.view(street({ goal: 4 }), { role: 'host' }, { today: SAT })).slice(0, 2), ['Collect a stamp at all 4 shops to enter the prize draw.', 'One stamp per shop. No purchase is needed for a stamp unless a shop’s own sign says so.']);
  assert.strictEqual(C.rules(C.view(street({ bonus: false }), { role: 'host' }, { today: SAT })).length, 2);
  assert.strictEqual(C.invite(v, base), 'Maple Street Passport - Maple Street, Nov 28 - 29. Collect 3 stamps to be in the draw for: A basket. Start your passport: https://lab.example/stroll/#join=MAPLE2');
  // The page reads exactly these fragments.
  const js = read('public/app.js');
  assert.ok(js.includes("/^join=([A-Za-z0-9-]{4,12})$/") && js.includes("/^stamp=([A-Za-z0-9]{6})\\.([A-Za-z0-9]{4})$/"));
  const svg = QR.svg(sg.url, 'A "label" <here>');
  assert.match(svg, /^<svg [^>]*aria-label="A label here"/);
  assert.ok(!/style=|<script|on\w+=/.test(svg));
});

test('the made-up street: built by the same rules, every text clean, every code its own; the visitor has three of five stamps, two more finish it, and the draw runs over its cards', () => {
  const d = D.doc(), cards = D.cards();
  assert.ok(C.isGid(d.id) && C.isCode(d.code));
  assert.ok(C.cleanStroll(d, D.TODAY));
  const ids = C.shopIds(d);
  assert.strictEqual(ids.length, 8);
  for (const id of ids) { assert.ok(C.isId(id)); assert.deepStrictEqual(C.cleanShop(d.shops[id]), { name: d.shops[id].name, perk: d.shops[id].perk }); assert.ok(C.isStamp(d.shops[id].k)); }
  assert.strictEqual(new Set(ids.map((id) => d.shops[id].k)).size, 8);
  for (const c of cards) { assert.ok(C.isTag(c.tag)); assert.strictEqual(C.cleanName(c.name), c.name); }
  assert.strictEqual(new Set(cards.map((c) => c.tag)).size, cards.length);
  assert.strictEqual(C.phase(d, D.TODAY), 'on');
  const me = cards[0];
  assert.deepStrictEqual([me.tag, C.progress(d, me).n, C.progress(d, me).left], [D.ME, 3, 2]);
  const ctx = { now: D.NOW, today: D.TODAY };
  for (const id of ['spagebk22', 'sspoke444']) { const r = C.stamp(d, me, d.shops[id].k, ctx); assert.ok(r.isNew); me.stamps[r.shop] = D.NOW; }
  assert.deepStrictEqual([C.progress(d, me).done, C.progress(d, me).entries], [true, 1]);
  const counts = D.counts(d, cards);
  assert.strictEqual(counts.stamps, ids.reduce((s, id) => s + counts[`s_${id}`], 0));
  assert.ok(counts.cards > cards.length && counts.done >= C.entrants(d, cards).length);
  const total = C.entrants(d, cards).reduce((s, e) => s + e.entries, 0);
  const w = C.draw(d, cards, () => total - 1);
  assert.ok(cards.some((c) => c.tag === w.tag));
  const v = C.view(d, { role: 'card', card: me, tag: D.ME }, { today: D.TODAY });
  for (const id of ids) assert.ok(!JSON.stringify(v).includes(d.shops[id].k));
  assert.strictEqual(D.doc().v, 1, 'it starts again from the same numbers');
  assert.strictEqual(Object.keys(D.cards()[0].stamps).length, 3);
});

test('what the phone keeps: a list, the last name used and the last copy - cleaned on the way in and out; storage that throws falls back to memory', () => {
  const mem = {}; const ls = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const s = S.create(ls);
  assert.ok(s.persistent());
  s.putList([{ id: 'AAAAbbbbCCCCdddd', title: '<b>Maple</b>', place: 'x', from: SAT, to: SUN, role: 'host', secret: 1 }, { id: 'bad' }, { id: 'AAAAbbbbCCCCdddd', title: 'dup' }, null]);
  assert.deepStrictEqual(s.getList(), [{ id: 'AAAAbbbbCCCCdddd', title: 'Maple', place: 'x', from: SAT, to: SUN, role: 'host' }]);
  s.putPrefs({ name: 'Ana <3', cur: 'nope', tab: 'draw', x: 1 });
  assert.deepStrictEqual(s.getPrefs(), { name: 'Ana', cur: '', tab: 'draw' });
  const v = C.view(street(), { role: 'card', card: card([]), tag: TAG(1) }, { today: SAT });
  s.putLast(v, 5); assert.strictEqual(s.getLast().g.id, v.id);
  s.putLast({ id: 'x' }, 5); assert.strictEqual(s.getLast().g.id, v.id, 'a bad copy never replaces a good one');
  mem[S.KEYS.last] = '{not json'; assert.strictEqual(s.getLast(), null);
  mem[S.KEYS.list] = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: `AAAAbbbbCCCC${String(1000 + i)}` }))); assert.strictEqual(s.getList().length, S.MAX);
  s.clearAll(); assert.deepStrictEqual(Object.keys(mem), []);
  const broken = S.create({ getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); }, removeItem() { throw new Error('no'); } });
  assert.ok(!broken.persistent());
  broken.putPrefs({ name: 'Dee' }); assert.strictEqual(broken.getPrefs().name, 'Dee');
  assert.ok(!S.create(null).persistent());
  assert.deepStrictEqual(S.TABS, ['overview', 'shops', 'signs', 'draw', 'passport', 'perks', 'about']);
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(read('public/app.js')), 'the page never touches storage itself');
});

/* ================================================================== *
 * The look, the page's promises, the copy
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes; the lab card’s two colours hold white text, are the farthest free colours from every other card (18+ in CIE Lab) and its emoji is on no other card - drop #74 on 2026-11-28; 44px targets; motion only when asked for; no gradients', () => {
  const css = read('public/app.css');
  const tokens = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));
  const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
  const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));
  const dark = tokens(darkBlock.slice(0, darkBlock.indexOf('}')));
  assert.deepStrictEqual(tokens(css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf(':root[data-theme="dark"]'))), dark, 'both dark blocks agree');
  assert.deepStrictEqual([light.bg, dark.bg, light.accent, dark.accent], ['#ffffff', '#000000', '#9c4a2f', '#f3b9a3']);
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min) => assert.ok(ratio(t[fg], t[bg]) >= (min || 4.5), `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const fg of ['text', 'muted', 'link']) for (const bg of ['bg', 'card2', 'sheet']) ok(fg, bg);
    ok('accent-ink', 'accent'); ok('link', 'accent-bg'); ok('accent', 'accent-bg'); ok('bg', 'text'); ok('accent', 'bg'); ok('accent', 'sheet');
    ok('accent', 'card2', 3); // a bar on its track: a shape, not text
    for (const k of ['good', 'warn', 'bad']) { ok(k, `${k}-bg`); ok(k, 'bg'); ok(k, 'sheet'); }
  }
  for (let i = 0; i <= 20; i++) assert.ok(new RegExp(`\\.p${i} \\{ width: ${i === 0 ? '0' : i * 5 + '%'}; \\}`).test(css), `bar width .p${i}`);
  for (let i = 0; i < 5; i++) assert.ok(css.includes(`.r${i} { transform: rotate(`), `stamp tilt .r${i}`);
  const LAB = require('../../../lab');
  const lab = LAB.get('stroll');
  assert.ok(lab, 'Stroll is in lab.js');
  assert.deepStrictEqual([lab.dropped, lab.status, LAB.APPS.indexOf(lab) + 1, LAB.APPS[LAB.APPS.length - 1].slug], ['2026-11-28', 'testing', 74, 'stroll']);
  assert.deepStrictEqual([lab.color, lab.color2, light.brand], ['#b16045', '#667b5a', '#b16045']);
  assert.ok(ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  const others = LAB.APPS.filter((a) => a.slug !== 'stroll');
  for (const a of others) {
    assert.notStrictEqual(a.emoji, lab.emoji, `${a.slug} has the same emoji`);
    for (const c of [a.color, a.color2]) for (const mine of [lab.color, lab.color2]) assert.ok(labDist(mine, c) >= 18, `${mine} is ${labDist(mine, c).toFixed(1)} from ${a.slug}'s ${c}`);
  }
  // What the comment in lab.js says was measured.
  assert.strictEqual(labDist(lab.color, LAB.get('firstday').color).toFixed(1), '19.0');
  assert.strictEqual(labDist(lab.color2, LAB.get('sprout').color).toFixed(1), '18.9');
  assert.strictEqual(labDist(lab.color, lab.color2).toFixed(1), '46.8');
  assert.deepStrictEqual([ratio('#ffffff', lab.color).toFixed(2), ratio('#ffffff', lab.color2).toFixed(2)], ['4.54', '4.62']);
  assert.strictEqual(lab.features.length, 4);
  assert.ok(read('public/icon.svg').includes(lab.color) && read('public/manifest.webmanifest').includes(lab.color));
  // Targets.
  assert.match(css, /\.btn \{[^}]*min-height: 48px/); assert.match(css, /\.btn\.small \{[^}]*min-height: 44px/);
  assert.match(css, /\.tabbar button \{[^}]*min-height: 48px/); assert.match(css, /\.input \{[^}]*min-height: 48px/);
  assert.match(css, /\.link-btn \{[^}]*min-height: 44px/); assert.match(css, /\.item \{[^}]*min-height: 56px/);
  assert.match(css, /body \{[^}]*overflow-x: hidden/);
  // Motion: every animation and transition sits inside the no-preference block.
  const start = css.indexOf('@media (prefers-reduced-motion: no-preference)');
  const end = css.indexOf('@media print');
  assert.ok(start > 0 && end > start);
  const outside = css.slice(0, start) + css.slice(end);
  assert.ok(!/\b(animation|transition)\s*:/.test(outside) && !/@keyframes/.test(outside), 'motion outside the no-preference block');
  assert.ok(/animation: thump/.test(css.slice(start, end)));
  assert.ok(!/gradient\(/.test(css) && !/@import|url\(/.test(css), 'no gradients, nothing fetched');
  assert.ok(!/font-family:(?![^;]*ui-monospace)/.test(css.replace(/font: 400 1rem[^;]*;/, '')), 'system fonts only');
});

test('the page’s promises: no inline script, handler or style attribute anywhere; every script and style is this app’s own; the verify banner is wired; the worker keeps every file the page loads and never the API; nothing asks for location, camera or notifications', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'an inline script');
  assert.ok(!/\son[a-z]+\s*=/i.test(html) && !/\sstyle\s*=/i.test(html) && !/<style/i.test(html));
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(srcs, ['stroll-core.js', 'demo.js', 'stroll-store.js', 'qr.js', 'passkey-client.js', 'verify-banner.js', 'app.js']);
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) assert.ok(!/^(https?:)?\/\//.test(m[1]) && !m[1].startsWith('/'), `${m[1]} is not relative`);
  const js = read('public/app.js');
  assert.ok(!/style\s*=|\.style\.|setAttribute\('style|\son[a-z]+=|innerHTML\s*=\s*[^;]*<script/i.test(js), 'the page writes a style or a handler');
  assert.ok(!/geolocation|getUserMedia|Notification|navigator\.contacts|eval\(|new Function/.test(js));
  assert.match(js, /navigator\.serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
  assert.match(js, /var BASE = new URL\('\.', document\.baseURI\)\.pathname;/);
  assert.ok(!/fetch\(['"]\//.test(js), 'a URL that is not relative to BASE');
  const sw = read('public/sw.js');
  const shell = JSON.parse(/var SHELL = (\[[^\]]+\]);/.exec(sw)[1].replace(/'/g, '"'));
  for (const f of [...srcs, 'app.css', 'icon.svg', 'manifest.webmanifest']) assert.ok(shell.includes(f), `${f} is not kept for offline`);
  for (const f of shell.slice(1)) assert.ok(fs.existsSync(path.join(ROOT, 'public', f)), `${f} does not exist`);
  assert.ok(sw.includes("rel.indexOf('api/') === 0") && sw.includes("k.indexOf('stroll-') === 0"));
  const man = JSON.parse(read('public/manifest.webmanifest'));
  assert.deepStrictEqual([man.start_url, man.scope, man.name], ['./', './', 'Stroll']);
  // Every tab in the markup is one the store knows, for the right role.
  const tabs = [...html.matchAll(/data-tab="([a-z]+)" data-role="(host|card)"/g)];
  assert.strictEqual(tabs.length, 14);
  for (const [, tab, role] of tabs) assert.ok((role === 'host' ? S.HOST_TABS : S.CARD_TABS).includes(tab));
});

test('the copy and the switches: no model is called and none is claimed; the page says what is kept; STROLL_MEMORY is refused on Cloud Run', () => {
  const server = read('server.js');
  assert.ok(!/anthropic|messages\.create|LAB_AI_GUARD|requireBudget/i.test(server.replace(/\/\/.*$/gm, '')), 'Stroll calls no model');
  const pkg = JSON.parse(read('package.json'));
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(), ['@google-cloud/firestore', '@simplewebauthn/server', 'express']);
  assert.match(pkg.scripts.test, /REQUIRE_VERIFIED_FOR_FREE_AI=0/);
  const js = read('public/app.js');
  assert.ok(!/\bAI\b|Claude|smart|magic/i.test(js.replace(/\/\*[\s\S]*?\*\//, '')), 'the page claims no AI');
  assert.ok(js.includes('Stroll never asks a shopper for an email or a phone number'));
  assert.ok(js.includes('it never asked for your email or your number'));
  assert.ok(js.includes('The server rolls the dice'));
  assert.ok(js.includes(String.raw`Getting a stamp needs a signal - stamps are not saved up for later.`));
  const r = spawnSync(process.execPath, ['-e', "require('./lib/store')"], { cwd: ROOT, env: { ...process.env, STROLL_MEMORY: '1', K_SERVICE: 'challenge' }, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /refused on Cloud Run/);
  const md = read('CLAUDE.md');
  for (const word of ['Small Business Saturday', 'No model', 'stroll_k', 'counts/<id>', 'crypto.randomInt', 'Not built']) assert.ok(md.includes(word), `CLAUDE.md does not mention ${word}`);
  assert.ok(!/claude\.ai\/code\/session|Claude-Session/.test(md));
});

/* ================================================================== *
 * Over HTTP
 * ================================================================== */

let base;
let ip6 = 1;
function client(addr) {
  const cookies = {};
  const ip = addr || `2001:db8:${(ip6++).toString(16)}::1`;
  const call = async function (method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const t = await res.text();
    let data = {}; try { data = JSON.parse(t); } catch (e) { data = { text: t }; }
    if (call.log) call.log.push(t);
    return { status: res.status, data, text: t, headers: res.headers, set };
  };
  call.cookies = cookies;
  call.ip = ip;
  return call;
}
const mail = (who) => `${who}${AT}example.com`;
async function register(who, c) {
  c = c || client();
  const r = await c('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
// A stroll that starts today (by the server's day), so stamping is open whatever hour this runs at.
const DAY = todayUtc();
const NEW = (over) => ({ name: 'Ana', title: 'Maple Street Passport', place: 'Maple Street', from: DAY, to: C.addDays(DAY, 1), goal: 3, bonus: true, prize: 'A basket', shops: ['Juniper & Wren', 'Dog-Eared Books', 'Crumb Bakery', 'Spoke & Chain'], ...(over || {}) });
async function start(over, host) {
  host = host || client();
  const r = await host('POST', '/api/strolls', NEW(over));
  assert.strictEqual(r.status, 200, r.text);
  return { host, id: r.data.id, code: r.data.g.code, g: r.data.g, ks: r.data.g.shops.map((s) => s.k) };
}
async function shopper(st, name, c) {
  c = c || client();
  const r = await c('POST', `/api/join/${st.code}`, { name: name || 'Priya' });
  assert.strictEqual(r.status, 200, r.text);
  return c;
}
const stampAt = (c, st, k) => c('POST', `/api/s/${st.id}/stamp`, { code: k });
const actOn = (st, action) => st.host('POST', `/api/s/${st.id}/act`, { action });
const hostView = async (st) => (await st.host('GET', `/api/s/${st.id}`)).data.g;
const GONE = 'This passport isn’t here any more. It may have been deleted, or it closed a month after its last day.';

test('signed out: the page, its headers and the health check answer; nothing needs an account; an unknown API path is a 404 in JSON', async () => {
  const c = client();
  const page = await c('GET', '/');
  assert.strictEqual(page.status, 200); assert.match(page.text, /<title>Stroll/);
  assert.strictEqual(page.headers.get('content-security-policy'), "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual((await c('GET', '/some/deep/link')).status, 200);
  assert.deepStrictEqual((await c('GET', '/api/health')).data, { ok: true, store: 'memory' });
  assert.deepStrictEqual((await c('GET', '/api/me')).data, { signedIn: false });
  assert.strictEqual((await c('GET', '/sw.js')).headers.get('cache-control'), 'no-cache');
  for (const f of ['app.css', 'app.js', 'stroll-core.js', 'qr.js', 'verify-banner.js', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await c('GET', `/${f}`)).status, 200, f);
  const nope = await c('GET', '/api/nope'); assert.strictEqual(nope.status, 404); assert.deepStrictEqual(nope.data, { error: 'Not found.' });
  assert.strictEqual((await c('GET', '/api/mine')).status, 401);
  assert.deepStrictEqual(Object.keys(c.cookies), [], 'looking sets no cookie');
});

test('writes come from this page: another site’s request is a 403, a form post a 415 - before anything is read', async () => {
  const st = await start();
  const c = client();
  for (const h of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'https://evil.example' }, { Origin: 'null' }]) {
    assert.strictEqual((await c('POST', '/api/strolls', NEW(), h)).status, 403, JSON.stringify(h));
    assert.strictEqual((await st.host('DELETE', `/api/s/${st.id}`, undefined, h)).status, 403);
    assert.strictEqual((await st.host('POST', `/api/s/${st.id}/draw`, {}, h)).status, 403);
  }
  assert.strictEqual((await c('POST', '/api/strolls', 'title=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.strictEqual((await c('POST', `/api/join/${st.code}`, 'name=x', { 'Content-Type': 'text/plain' })).status, 415);
  assert.strictEqual((await c('POST', '/api/strolls', NEW(), { 'Sec-Fetch-Site': 'same-origin', Origin: base.replace(/\/stroll$/, '') })).status, 200);
  assert.strictEqual((await st.host('GET', `/api/s/${st.id}`)).status, 200, 'still there');
});

test('starting and joining: the organizer needs no account, a shopper needs only a first name; the key is an HttpOnly cookie on this app’s path; a code shows the passport and no shop before joining; the same browser never joins twice', async () => {
  const c = client();
  assert.strictEqual((await c('POST', '/api/strolls', NEW({ name: '' }))).status, 400);
  assert.match((await c('POST', '/api/strolls', NEW({ title: '' }))).data.error, /name/);
  assert.match((await c('POST', '/api/strolls', NEW({ shops: ['Ok', `x${AT}y.zz`] }))).data.error, /email/);
  assert.match((await c('POST', '/api/strolls', NEW({ shops: ['Twice', 'twice'] }))).data.error, /already/);
  assert.deepStrictEqual(Object.keys(c.cookies), [], 'a refused start sets no cookie');
  const made = await c('POST', '/api/strolls', NEW());
  assert.strictEqual(made.status, 200);
  assert.match(made.set[0], /^stroll_k=[A-Za-z0-9_-]{22}; Path=\/stroll\/; Max-Age=34560000; SameSite=Lax; HttpOnly$/);
  const g = made.data.g;
  assert.deepStrictEqual([g.role, g.title, g.goal, g.host, g.shops.length, g.counts.cards], ['host', 'Maple Street Passport', 3, 'Ana', 4, 0]);
  assert.ok(C.isGid(made.data.id) && C.isCode(g.code) && g.shops.every((s) => C.isStamp(s.k)) && new Set(g.shops.map((s) => s.k)).size === 4);
  const st = { host: c, id: made.data.id, code: g.code, ks: g.shops.map((s) => s.k) };
  const p = client();
  const peek = await p('GET', `/api/join/${g.code.toLowerCase().slice(0, 3)}-${g.code.slice(3)}`);
  assert.deepStrictEqual(peek.data, { title: 'Maple Street Passport', place: 'Maple Street', when: C.dateRange(DAY, C.addDays(DAY, 1)), shops: 4, goal: 3, prize: 'A basket', ended: false, already: null, role: null });
  assert.strictEqual(peek.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.strictEqual((await p('GET', `/api/s/${st.id}`)).status, 404, 'knowing the id opens nothing');
  assert.match((await p('POST', `/api/join/${st.code}`, { name: '123' })).data.error, /first name/);
  const j = await p('POST', `/api/join/${st.code}`, { name: ' priya <b> ' });
  assert.deepStrictEqual(j.data, { id: st.id, isNew: true, role: 'card' });
  assert.match(j.set[0], /^stroll_k=.*HttpOnly$/);
  assert.deepStrictEqual((await p('POST', `/api/join/${st.code}`, { name: 'Someone Else' })).data, { id: st.id, isNew: false, role: 'card' });
  assert.deepStrictEqual((await c('POST', `/api/join/${st.code}`, { name: 'Ana' })).data, { id: st.id, isNew: false, role: 'host' });
  const mine = (await p('GET', `/api/s/${st.id}`)).data.g;
  assert.deepStrictEqual([mine.role, mine.me.name, mine.me.n, mine.me.left], ['card', 'priya', 0, 3]);
  assert.deepStrictEqual((await p('GET', `/api/join/${st.code}`)).data.already, st.id);
  assert.strictEqual((await hostView(st)).counts.cards, 1);
  assert.deepStrictEqual((await p('GET', `/api/s/${st.id}?since=${mine.t}`)).data, { same: true, t: mine.t });
  assert.strictEqual((await p('GET', '/api/join/ZZZZZZ')).status, 404);
});

test('stamping: a counter’s code stamps once; a second scan changes nothing; the third finishes the passport, the fourth is a second entry; the organizer’s counts move with each', async () => {
  const st = await start();
  const p = await shopper(st);
  const one = await stampAt(p, st, st.ks[0].toLowerCase());
  assert.deepStrictEqual([one.status, one.data.isNew, one.data.justDone, one.data.g.me.n], [200, true, false, 1]);
  assert.strictEqual(one.data.shop, st.g.shops[0].id);
  const again = await stampAt(p, st, st.ks[0]);
  assert.deepStrictEqual([again.status, again.data.isNew, again.data.g.me.n], [200, false, 1]);
  assert.strictEqual((await stampAt(p, st, st.ks[1])).data.justDone, false);
  const three = await stampAt(p, st, st.ks[2]);
  assert.deepStrictEqual([three.data.justDone, three.data.g.me.done, three.data.g.me.entries], [true, true, 1]);
  const four = await stampAt(p, st, st.ks[3]);
  assert.deepStrictEqual([four.data.justDone, four.data.g.me.entries, four.data.g.me.all], [false, 2, true]);
  const h = await hostView(st);
  assert.deepStrictEqual(h.counts, { cards: 1, stamps: 4, done: 1 });
  assert.deepStrictEqual(h.shops.map((s) => s.count), [1, 1, 1, 1]);
  assert.deepStrictEqual(h.days.filter((d) => d.n).map((d) => [d.day, d.n]), [[DAY, 4]]);
  const bad = await stampAt(p, st, 'ZZZZ');
  assert.deepStrictEqual([bad.status, bad.data], [404, { error: C.WRONG_CODE, code: 'wrong' }]);
  assert.strictEqual((await stampAt(p, st, st.code)).data.error, C.WRONG_CODE);
  const org = await stampAt(st.host, st, st.ks[0]);
  assert.deepStrictEqual([org.status, org.data.code], [409, 'organizer']);
  assert.strictEqual((await stampAt(client(), st, st.ks[0])).status, 404, 'a stranger cannot stamp');
  assert.deepStrictEqual((await hostView(st)).counts, { cards: 1, stamps: 4, done: 1 });
});

test('A SHOPPER IS NEVER SENT A COUNTER CODE: not on joining, reading, stamping, a wrong code or after the draw - nor a count, another shopper’s name or anyone else’s claim', async () => {
  const st = await start();
  const other = await shopper(st, 'Zebedee');
  for (const k of st.ks) await stampAt(other, st, k);
  const p = client(); p.log = [];
  await p('GET', `/api/join/${st.code}`);
  await shopper(st, 'Priya', p);
  await p('GET', `/api/s/${st.id}`);
  await stampAt(p, st, st.ks[0]); await stampAt(p, st, st.ks[0]); await stampAt(p, st, 'ZZZZ');
  await p('POST', `/api/s/${st.id}/act`, { action: { t: 'newcode', id: st.g.shops[0].id } });
  await p('GET', `/api/s/${st.id}/cards`);
  await p('POST', `/api/s/${st.id}/draw`, {});
  const drawn = await st.host('POST', `/api/s/${st.id}/draw`, {});
  assert.strictEqual(drawn.data.winner.name, 'Zebedee');
  const claim = drawn.data.g.winners[0].claim, tag = drawn.data.g.winners[0].tag;
  const after = await p('GET', `/api/s/${st.id}`);
  assert.deepStrictEqual(after.data.g.winners, [{ name: 'Zebedee' }]);
  assert.strictEqual(after.data.g.won, null);
  const all = p.log.join('\n');
  assert.ok(p.log.length >= 10);
  for (const k of st.ks.slice(1)) assert.ok(!all.includes(k), `a shopper was sent the code ${k}`);
  assert.ok(!new RegExp(`"k":|"${st.ks[0]}"`).test(all));
  for (const secret of [claim, tag, '"counts"', '"count"', 'keyHash', '"days"']) assert.ok(!all.includes(secret), `a shopper was sent ${secret}`);
  assert.strictEqual((all.match(/Zebedee/g) || []).length, 1, 'only as the winner');
  const won = (await other('GET', `/api/s/${st.id}`)).data.g;
  assert.deepStrictEqual(won.won, { claim, given: false });
});

test('many phones at once: forty shoppers stamping one counter in the same instant all land, and one shopper tapping the same code ten times is one stamp', async () => {
  const st = await start({ goal: 1 });
  const crowd = [];
  for (let i = 0; i < 40; i++) crowd.push(await shopper(st, `Shopper ${String.fromCharCode(65 + (i % 26))}`));
  const res = await Promise.all(crowd.map((c) => stampAt(c, st, st.ks[0])));
  assert.ok(res.every((r) => r.status === 200 && r.data.isNew && r.data.justDone));
  const one = crowd[0];
  const taps = await Promise.all(Array.from({ length: 10 }, () => stampAt(one, st, st.ks[1])));
  assert.strictEqual(taps.filter((r) => r.data.isNew).length, 1);
  const h = await hostView(st);
  assert.deepStrictEqual(h.counts, { cards: 40, stamps: 41, done: 40 });
  assert.deepStrictEqual(h.shops.map((s) => s.count), [40, 1, 0, 0]);
});

test('outside the days: a passport that has not started gives no stamp, one that has ended gives none and takes no new shopper - with a reason', async () => {
  const soon = await start({ from: C.addDays(DAY, 5), to: C.addDays(DAY, 6) });
  const p = await shopper(soon);
  const early = await stampAt(p, soon, soon.ks[0]);
  assert.deepStrictEqual([early.status, early.data.code], [409, 'closed']);
  assert.match(early.data.error, /^Stamps open /);
  assert.strictEqual((await p('GET', `/api/s/${soon.id}`)).data.g.open, false);
  const st = await start();
  const q = await shopper(st);
  await stampAt(q, st, st.ks[0]);
  await store.merge('strolls', st.id, { from: C.addDays(DAY, -9), to: C.addDays(DAY, -3) });
  const late = await stampAt(q, st, st.ks[1]);
  assert.deepStrictEqual([late.status, late.data.error], [409, 'This passport has ended - stamps are closed.']);
  assert.strictEqual((await q('GET', `/api/s/${st.id}`)).data.g.me.n, 1, 'their stamps are still theirs');
  const peek = await client()('GET', `/api/join/${st.code}`);
  assert.strictEqual(peek.data.ended, true);
  const j = await client()('POST', `/api/join/${st.code}`, { name: 'Late' });
  assert.deepStrictEqual([j.status, j.data.error], [409, 'This passport has ended.']);
  assert.strictEqual((await hostView(st)).counts.stamps, 1);
});

test('only the organizer changes the passport: a shopper’s act, list, draw, remove and delete are refused; a new code stops the old sign; a removed shop’s stamps stop counting; the details move the goal', async () => {
  const st = await start();
  const p = await shopper(st);
  for (const [m, tail, body] of [['POST', '/act', { action: { t: 'delshop', id: st.g.shops[0].id } }], ['GET', '/cards'], ['POST', '/draw', {}], ['DELETE', `/cards/${'x'.repeat(32)}`], ['DELETE', ''], ['POST', '/keep', {}]]) {
    const r = await p(m, `/api/s/${st.id}${tail}`, body);
    assert.ok(r.status === 403 || (tail === '/keep' && r.status === 401), `${m} ${tail}: ${r.status}`);
    if (r.status === 403) assert.deepStrictEqual(r.data, { error: C.HOST_ONLY, code: 'not-organizer' });
  }
  await stampAt(p, st, st.ks[0]); await stampAt(p, st, st.ks[1]);
  const add = await actOn(st, { t: 'addshops', shops: ['Fern & Frond', { name: 'The Toy Box', perk: 'A balloon for every little shopper' }] });
  assert.strictEqual(add.status, 200);
  assert.deepStrictEqual(add.data.g.shops.slice(4).map((s) => [s.name, s.perk, C.isStamp(s.k)]), [['Fern & Frond', '', true], ['The Toy Box', 'A balloon for every little shopper', true]]);
  assert.strictEqual(new Set(add.data.g.shops.map((s) => s.k)).size, 6);
  assert.strictEqual((await actOn(st, { t: 'addshops', shops: ['crumb bakery'] })).status, 409);
  const nc = await actOn(st, { t: 'newcode', id: st.g.shops[2].id });
  const fresh = nc.data.g.shops[2].k;
  assert.notStrictEqual(fresh, st.ks[2]);
  assert.strictEqual((await stampAt(p, st, st.ks[2])).status, 404, 'the old sign stops working');
  const third = await stampAt(p, st, fresh);
  assert.deepStrictEqual([third.status, third.data.g.me.done], [200, true]);
  const del = await actOn(st, { t: 'delshop', id: st.g.shops[0].id });
  assert.strictEqual(del.data.g.shops.length, 5);
  const mine = (await p('GET', `/api/s/${st.id}`)).data.g;
  assert.deepStrictEqual([mine.me.n, mine.me.done, mine.me.left, mine.shops.length], [2, false, 1, 5]);
  const det = await actOn(st, { t: 'details', title: 'Maple Street Stroll', place: '', from: DAY, to: C.addDays(DAY, 2), goal: 2, bonus: false, prize: 'Two baskets' });
  assert.deepStrictEqual([det.data.g.title, det.data.g.goal, det.data.g.bonus, det.data.g.prize, det.data.g.v > nc.data.g.v], ['Maple Street Stroll', 2, false, 'Two baskets', true]);
  assert.strictEqual((await p('GET', `/api/s/${st.id}`)).data.g.me.done, true);
  assert.strictEqual((await actOn(st, { t: 'details', title: `x${AT}y.zz`, from: DAY, to: DAY, goal: 2 })).status, 400);
  assert.strictEqual((await actOn(st, { t: 'nope' })).status, 400);
  assert.strictEqual((await actOn(st, null)).status, 400);
  assert.strictEqual((await st.host('POST', `/api/s/${st.id}/act`, { action: { t: 'editshop', id: '__proto__', name: 'X' } })).status, 404);
  // The passports list puts the counts right after a shop was removed and the goal changed.
  const list = await st.host('GET', `/api/s/${st.id}/cards`);
  assert.deepStrictEqual(list.data, { total: 1, list: [{ tag: list.data.list[0].tag, name: 'Priya', n: 2, done: true, entries: 1, removed: false }] });
  assert.deepStrictEqual((await hostView(st)).counts, { cards: 1, stamps: 3, done: 1 });
});

test('the draw over HTTP: nobody finished is a 409; the winner’s phone and the organizer see the same claim code and nobody else does; a removed passport is never drawn; nobody wins twice; handed over is marked', async () => {
  const st = await start({ goal: 2 });
  const none = await st.host('POST', `/api/s/${st.id}/draw`, {});
  assert.deepStrictEqual([none.status, none.data.code], [409, 'nobody']);
  const names = ['Priya', 'Marcus', 'Dee', 'Lin'];
  const people = [];
  for (const n of names) { const c = await shopper(st, n); people.push(c); await stampAt(c, st, st.ks[0]); await stampAt(c, st, st.ks[1]); }
  const lurker = await shopper(st, 'Lurker'); await stampAt(lurker, st, st.ks[0]);
  const list = (await st.host('GET', `/api/s/${st.id}/cards`)).data;
  assert.strictEqual(list.total, 5);
  assert.deepStrictEqual(list.list.map((c) => c.n), [2, 2, 2, 2, 1]);
  const dee = list.list.find((c) => c.name === 'Dee');
  assert.deepStrictEqual((await st.host('DELETE', `/api/s/${st.id}/cards/${dee.tag}`)).data, { ok: true });
  assert.deepStrictEqual((await st.host('DELETE', `/api/s/${st.id}/cards/${dee.tag}`)).data, { ok: true }, 'twice is still once');
  assert.deepStrictEqual((await hostView(st)).counts, { cards: 4, stamps: 9, done: 3 });
  const removed = await stampAt(people[2], st, st.ks[2]);
  assert.deepStrictEqual([removed.status, removed.data.code], [403, 'removed']);
  assert.strictEqual((await people[2]('GET', `/api/s/${st.id}`)).data.g.me.removed, true);
  assert.strictEqual((await st.host('DELETE', `/api/s/${st.id}/cards/${'x'.repeat(32)}`)).status, 404);
  assert.strictEqual((await st.host('DELETE', `/api/s/${st.id}/cards/short`)).status, 404);
  const winners = [];
  for (let i = 0; i < 3; i++) {
    const d = await st.host('POST', `/api/s/${st.id}/draw`, {});
    assert.strictEqual(d.status, 200, d.text);
    assert.deepStrictEqual([d.data.winner.of, d.data.winner.people], [3 - i, 3 - i]);
    winners.push(d.data.winner.name);
    assert.strictEqual(d.data.g.winners.length, i + 1);
  }
  assert.deepStrictEqual(winners.slice().sort(), ['Lin', 'Marcus', 'Priya'], 'Dee was removed, the lurker never finished, nobody won twice');
  assert.strictEqual((await st.host('POST', `/api/s/${st.id}/draw`, {})).status, 409);
  const h = await hostView(st);
  assert.ok(h.winners.every((w) => C.isCode(w.claim) && C.isTag(w.tag)) && new Set(h.winners.map((w) => w.claim)).size === 3);
  for (let i = 0; i < names.length; i++) {
    const g = (await people[i]('GET', `/api/s/${st.id}`)).data.g;
    const w = h.winners.find((x) => x.name === names[i]);
    if (names[i] === 'Dee') assert.strictEqual(g.won, null); else assert.deepStrictEqual(g.won, { claim: w.claim, given: false });
    assert.deepStrictEqual(g.winners, winners.map((name) => ({ name })));
  }
  const given = await actOn(st, { t: 'given', tag: h.winners[0].tag });
  assert.strictEqual(given.data.g.winners[0].given, true);
  const first = people[names.indexOf(h.winners[0].name)];
  assert.strictEqual((await first('GET', `/api/s/${st.id}`)).data.g.won.given, true);
  assert.strictEqual((await actOn(st, { t: 'given', tag: 'y'.repeat(32) })).status, 404);
});

test('leaving and deleting: a shopper tears up their own passport and is a stranger again (the visits stay counted); the organizer cannot leave, only delete - and then the stroll, every card and the counts are gone', async () => {
  const st = await start({ goal: 1 });
  const p = await shopper(st), q = await shopper(st, 'Marcus');
  await stampAt(p, st, st.ks[0]); await stampAt(q, st, st.ks[0]);
  assert.strictEqual((await st.host('DELETE', `/api/s/${st.id}/me`)).status, 409);
  assert.deepStrictEqual((await p('DELETE', `/api/s/${st.id}/me`)).data, { ok: true });
  assert.strictEqual((await p('GET', `/api/s/${st.id}`)).status, 404);
  assert.strictEqual((await stampAt(p, st, st.ks[1])).status, 404);
  const h = await hostView(st);
  assert.deepStrictEqual([h.counts, h.shops[0].count], [{ cards: 1, stamps: 2, done: 1 }, 2]);
  assert.deepStrictEqual((await p('POST', `/api/join/${st.code}`, { name: 'Priya' })).data, { id: st.id, isNew: true, role: 'card' });
  assert.strictEqual((await p('GET', `/api/s/${st.id}`)).data.g.me.n, 0, 'a fresh passport');
  assert.strictEqual((await q('DELETE', `/api/s/${st.id}`)).status, 403);
  assert.deepStrictEqual((await st.host('DELETE', `/api/s/${st.id}`)).data, { ok: true });
  for (const c of [st.host, p, q]) { const r = await c('GET', `/api/s/${st.id}`); assert.deepStrictEqual([r.status, r.data], [404, { error: GONE, code: 'gone' }]); }
  assert.strictEqual((await client()('GET', `/api/join/${st.code}`)).status, 404);
  assert.ok(!store._dump().includes(st.id), 'nothing of it is left');
});

test('the same 404, word for word, for an id that never was, a malformed one, one that is not yours and one that expired - and the read that finds an expired stroll deletes it, its cards and its counts', async () => {
  const st = await start();
  const p = await shopper(st);
  await stampAt(p, st, st.ks[0]);
  const stranger = client();
  const texts = new Set();
  for (const [c, id] of [[stranger, st.id], [stranger, 'AAAAbbbbCCCCdddd'], [stranger, 'short'], [stranger, '..%2F..%2Fx'], [stranger, `${st.id}x`]]) {
    for (const [m, tail, body] of [['GET', ''], ['POST', '/stamp', { code: st.ks[0] }], ['POST', '/act', { action: { t: 'delshop' } }], ['GET', '/cards'], ['POST', '/draw', {}], ['DELETE', '/me'], ['DELETE', '']]) {
      const r = await c(m, `/api/s/${id}${tail}`, body);
      assert.strictEqual(r.status, 404, `${m} ${id}${tail}`); texts.add(r.text);
    }
  }
  await store.merge('strolls', st.id, { from: C.addDays(DAY, -40), to: C.addDays(DAY, -31) });
  assert.ok(store._dump().includes(st.id));
  const r = await st.host('GET', `/api/s/${st.id}`);
  assert.strictEqual(r.status, 404); texts.add(r.text);
  assert.ok(!store._dump().includes(st.id), 'the stroll, its card and its counts are gone');
  texts.add((await p('GET', `/api/s/${st.id}`)).text);
  assert.deepStrictEqual([...texts], [JSON.stringify({ error: GONE, code: 'gone' })]);
  const st2 = await start();
  await shopper(st2);
  await store.merge('strolls', st2.id, { from: C.addDays(DAY, -40), to: C.addDays(DAY, -31) });
  assert.strictEqual((await client()('GET', `/api/join/${st2.code}`)).status, 404);
  assert.ok(!store._dump().includes(st2.id), 'found by its code, deleted the same way');
});

test('the limiters: ten wrong counter codes and a passport waits - even with the right one; thirty wrong passport codes and an address waits; ten new passports an hour per address', async () => {
  const st = await start();
  const p = await shopper(st);
  const wrong = ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE', 'FFFF', 'GGGG', 'HHHH', 'JJJJ', 'KKKK'].filter((k) => !st.ks.includes(k));
  for (let i = 0; i < 3; i++) assert.strictEqual((await stampAt(p, st, wrong[0])).status, 404, 'the same wrong code is one guess');
  for (const k of wrong.slice(0, 9)) assert.strictEqual((await stampAt(p, st, k)).status, 404);
  assert.strictEqual((await stampAt(p, st, st.ks[0])).status, 200, 'nine wrong: still fine');
  assert.strictEqual(wrong.length, 10, 'this run drew a shop code from the test’s wrong ones - run again');
  assert.strictEqual((await stampAt(p, st, wrong[9])).status, 404);
  const blocked = await stampAt(p, st, st.ks[1]);
  assert.strictEqual(blocked.status, 429); assert.match(blocked.data.error, /Too many wrong codes/);
  assert.strictEqual((await stampAt(await shopper(st, 'Other'), st, st.ks[1])).status, 200, 'another passport is not held up');
  const guesser = client();
  for (let i = 0; i < LIMITS.missesPerIp; i++) assert.strictEqual((await guesser('GET', `/api/join/ZZZZ${C.CODE_ALPHABET[i % 32]}${C.CODE_ALPHABET[Math.floor(i / 32)]}`)).status, 404);
  const held = await guesser('GET', `/api/join/${st.code}`);
  assert.strictEqual(held.status, 429); assert.match(held.data.error, /Too many wrong codes from here/);
  assert.strictEqual((await client()('GET', `/api/join/${st.code}`)).status, 200);
  const maker = client();
  for (let i = 0; i < LIMITS.strollsPerIp; i++) assert.strictEqual((await maker('POST', '/api/strolls', NEW({ shops: [] }))).status, 200);
  const over = await maker('POST', '/api/strolls', NEW());
  assert.strictEqual(over.status, 429); assert.match(over.data.error, /10 passports from here this hour/);
});

test('hostile input: a huge body is a 413, broken JSON a 400, markup never comes back, and names that look like object keys are just names or refused', async () => {
  const c = client();
  assert.strictEqual((await c('POST', '/api/strolls', JSON.stringify({ ...NEW(), prize: 'x'.repeat(20000) }))).status, 413);
  const broken = await c('POST', '/api/strolls', '{"title": ');
  assert.deepStrictEqual([broken.status, broken.data], [400, { error: 'That request could not be read.' }]);
  const st = await start({ title: `Maple${ZW} Street${RLO}`, shops: ['constructor', 'toString', 'Shop <i>one</i>'.replace(/<[^>]+>/g, '')] });
  assert.strictEqual(st.g.title, 'Maple Street');
  assert.deepStrictEqual(st.g.shops.map((s) => s.name), ['constructor', 'toString', 'Shop one']);
  assert.strictEqual((await c('POST', '/api/strolls', NEW({ title: '<script>alert(1)</script>' }))).status, 400);
  assert.strictEqual((await c('POST', '/api/strolls', NEW({ shops: ['<img src=x onerror=alert(1)>'] }))).status, 400);
  const p = await shopper(st, '<img src=x onerror=alert(1)>Zed');
  assert.strictEqual((await p('GET', `/api/s/${st.id}`)).data.g.me.name, 'Zed');
  for (const code of [null, 7, {}, ['JW7K'], 'x'.repeat(5000), '__proto__']) assert.strictEqual((await stampAt(p, st, code)).status, 404, JSON.stringify(code).slice(0, 20));
  assert.strictEqual((await p('POST', `/api/s/${st.id}/stamp`, '[]')).status, 404);
  const list = (await st.host('GET', `/api/s/${st.id}/cards`)).text;
  assert.ok(!/[<>]/.test(list));
  assert.strictEqual((await actOn(st, { t: 'addshops', shops: Array.from({ length: 41 }, (_, i) => `S${i}`) })).status, 400);
  assert.strictEqual((await actOn(st, { t: 'addshops', shops: 'not a list' })).status, 400);
  assert.deepStrictEqual({}.polluted, undefined);
});

test('signed in (free): the organizer keeps a passport on their account and opens it as the organizer on another phone; a shopper’s account is no organizer; the list is theirs alone', async () => {
  const phone = await register('stroll.ana');
  const me = await phone('GET', '/api/me');
  assert.deepStrictEqual(me.data, { signedIn: true, email: mail('stroll.ana'), keep: true });
  const st = await start({}, phone);
  assert.deepStrictEqual((await phone('POST', `/api/s/${st.id}/keep`, {})).data, { ok: true });
  assert.deepStrictEqual((await phone('POST', `/api/s/${st.id}/keep`, {})).data, { ok: true });
  const other = client();
  assert.strictEqual((await other('POST', '/api/auth/login', { email: mail('stroll.ana'), password: 'a long enough password' })).status, 200);
  const list = (await other('GET', '/api/mine')).data.list;
  assert.deepStrictEqual(list.map((g) => [g.id, g.title, g.place, g.from, g.role]), [[st.id, 'Maple Street Passport', 'Maple Street', DAY, 'host']]);
  const g = (await other('GET', `/api/s/${st.id}`)).data.g;
  assert.deepStrictEqual([g.role, g.shops[0].k], ['host', st.ks[0]]);
  assert.strictEqual((await other('POST', `/api/s/${st.id}/act`, { action: { t: 'editshop', id: g.shops[0].id, name: 'Juniper', perk: '' } })).status, 200);
  assert.deepStrictEqual((await other('GET', `/api/join/${st.code}`)).data.role, 'host');
  const sam = await register('stroll.sam');
  assert.strictEqual((await sam('GET', `/api/s/${st.id}`)).status, 404);
  assert.strictEqual((await sam('POST', `/api/s/${st.id}/keep`, {})).status, 404);
  await shopper(st, 'Sam', sam);
  assert.strictEqual((await sam('POST', `/api/s/${st.id}/keep`, {})).status, 403, 'a shopper keeps nothing on an account');
  assert.deepStrictEqual((await sam('GET', '/api/mine')).data, { list: [] });
  assert.strictEqual((await other('DELETE', '/api/mine/not-an-id')).status, 400);
  assert.deepStrictEqual((await other('DELETE', `/api/mine/${st.id}`)).data, { ok: true });
  assert.deepStrictEqual((await phone('GET', '/api/mine')).data, { list: [] });
  assert.strictEqual((await other('GET', `/api/s/${st.id}`)).status, 200, 'still the organizer: the seat is on the stroll');
  await other('POST', `/api/s/${st.id}/keep`, {});
  assert.deepStrictEqual((await other('DELETE', `/api/s/${st.id}`)).data, { ok: true });
  assert.deepStrictEqual((await phone('GET', '/api/mine')).data, { list: [] }, 'deleting takes it off the account');
});

test('what the store holds: strolls, cards, counts and the accounts’ lists - and in them no browser key, no account id, no email address, nothing about a shopper but a first name', async () => {
  const phone = await register('stroll.store');
  const st = await start({}, phone);
  await phone('POST', `/api/s/${st.id}/keep`, {});
  const p = await shopper(st, 'Priya');
  await stampAt(p, st, st.ks[0]);
  const dump = store._dump();
  const cols = JSON.parse(dump);
  assert.deepStrictEqual(cols.map((c) => c[0]).sort(), ['cards', 'counts', 'mine', 'strolls']);
  for (const key of [phone.cookies.stroll_k, p.cookies.stroll_k]) { assert.ok(key && key.length === 22); assert.ok(!dump.includes(key), 'a browser key was stored'); }
  assert.ok(!dump.includes(AT) && !dump.includes('example.com') && !/stroll\.store/.test(dump), 'an email address was stored');
  const users = JSON.stringify(await identityStore.list('users'));
  const uid = JSON.parse(users)[0] && (JSON.parse(users).find((u) => u.email === mail('stroll.store')) || {}).id;
  if (uid) assert.ok(!dump.includes(uid), 'an account id was stored');
  for (const [name, docs] of cols) {
    for (const [id, d] of docs) {
      const keys = Object.keys(d).sort();
      if (name === 'strolls') { assert.ok(C.isGid(id)); assert.deepStrictEqual(keys.filter((k) => !['bonus', 'code', 'createdAt', 'from', 'goal', 'host', 'place', 'prize', 'shops', 'title', 'to', 'updatedAt', 'v', 'winners'].includes(k)), [], `strolls keys: ${keys}`); assert.ok(Object.keys(d.host).every((k) => ['name', 'keyHash', 'owner'].includes(k))); }
      if (name === 'cards') { assert.match(id, /^[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{32}$/); assert.ok(keys.every((k) => ['createdAt', 'name', 'removed', 'sid', 'stamps'].includes(k)), `cards keys: ${keys}`); }
      if (name === 'counts') assert.ok(keys.every((k) => /^(cards|stamps|done|s_[a-z0-9]+|d_\d{8})$/.test(k)) && Object.values(d).every((n) => Number.isInteger(n)), `counts keys: ${keys}`);
      if (name === 'mine') assert.deepStrictEqual(keys, ['owner', 's', 'updatedAt']);
    }
  }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/stroll', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/stroll`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
