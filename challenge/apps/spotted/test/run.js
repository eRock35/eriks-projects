// The rules first (the board and its rarity, text, codes, scoring, a trip on
// one phone, the one door, the two-phone merge, the lifetime map, the recap
// card's words), then the demo's planted story, the storage module, the
// look, the page's promises and the copy, then end to end against the
// memory store:
//   SPOTTED_MEMORY=1 SPOTTED_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /spotted, the way
// the lab mounts it, so the key cookie's path, the parsers' order and the
// limiters run as deployed. Every name here is made up; phone numbers are
// built from pieces so no file carries one.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.SPOTTED_MEMORY !== '1' || process.env.SPOTTED_FAKE_AI !== '1') {
  console.error('run with SPOTTED_MEMORY=1 SPOTTED_FAKE_AI=1');
  process.exit(1);
}

const { app, store, ownerTag, misses } = require('../server');
const C = require('../public/spotted-core');
const D = require('../public/demo');
const S = require('../public/spotted-store');
const G = require('../lib/games');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
const ch = (n) => String.fromCharCode(n);
const RLO = ch(0x202E), ZW = ch(0x200B), FW_AT = ch(0xFF20);
const clone = (v) => JSON.parse(JSON.stringify(v));
const PHONE = ['555', '201', '3344'].join(' ');
const T0 = 1795618800000;

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
function trip(players, spots, extra) {
  let t = C.newTrip(Object.assign({ title: 'Test run', players }, extra || {}), T0);
  (spots || []).forEach(([c, p], i) => { t = C.spot(t, c, p, T0 + i + 1); });
  return t;
}

/* ================================================================== *
 * The rules
 * ================================================================== */

test('the board: the 50 states and DC, once each; four tiers of 14, 16, 11 and 10 worth 1, 2, 3 and 5; Alaska and Hawaii Rare; every tile on its own square of the 11 x 8 map', () => {
  assert.strictEqual(C.STATES.length, 51);
  assert.strictEqual(new Set(C.STATES.map((s) => s.c)).size, 51);
  assert.ok(C.isState('DC') && !C.isState('ON') && !C.isState('dc') && !C.isState('__proto__') && !C.isState('constructor'));
  const count = [0, 0, 0, 0, 0];
  C.STATES.forEach((s) => { count[s.tier]++; });
  assert.deepStrictEqual(count.slice(1), [14, 16, 11, 10]);
  assert.deepStrictEqual(C.TIERS.slice(1).map((t) => t.pts), [1, 2, 3, 5]);
  assert.deepStrictEqual(['CA', 'TX', 'FL', 'NY', 'OH', 'VT', 'WY', 'AK', 'HI', 'DC', 'IA', 'TN'].map((c) => C.pointsFor(c, 'rarity')), [1, 1, 1, 1, 1, 5, 5, 5, 5, 5, 3, 2]);
  assert.deepStrictEqual(['VT', 'CA', 'HI'].map((c) => C.pointsFor(c, 'flat')), [1, 1, 1]);
  assert.strictEqual(C.pointsFor('XX', 'rarity'), 0);
  assert.strictEqual(new Set(C.STATES.map((s) => s.x + ',' + s.y)).size, 51, 'no two tiles on one square');
  C.STATES.forEach((s) => assert.ok(s.x >= 0 && s.x < C.MAP_COLS && s.y >= 0 && s.y < C.MAP_ROWS, s.c));
  // A few neighbours sit where a reader expects them.
  const at = (c) => C.stateOf(c);
  assert.ok(at('WA').x < at('ME').x && at('ND').y < at('TX').y && at('FL').x > at('CA').x && at('OR').y === at('WA').y + 1);
});

test('text: first names letters only (any script), no digits, markup, bidi or zero-width; trip names a plain line, refused for an @ in any width, a link, seven digits in any script or markup; esc escapes all five', () => {
  assert.strictEqual(C.cleanName('  Rosa  '), 'Rosa');
  assert.strictEqual(C.cleanName('Zoë-Mae'), 'Zoë-Mae');
  assert.strictEqual(C.cleanName('Ren' + RLO + 'ee' + ZW), 'Renee');
  assert.strictEqual(C.cleanName('<b>Kai</b>'), 'Kai');
  assert.strictEqual(C.cleanName('12345'), '');
  assert.strictEqual(C.cleanName('x'.repeat(50)).length, 20);
  assert.strictEqual(C.cleanName({}), '');
  for (const bad of ['mail me' + AT + 'x', 'mail' + FW_AT + 'x', 'see https://x.test', 'www.x.test', 'call ' + PHONE, 'ring ' + ch(0x0967).repeat(7), '<script>']) assert.ok(C.refuse(bad), bad);
  for (const ok of ['Route 66 to Gran’s', 'I-95 north', 'Thanksgiving 2026']) assert.strictEqual(C.refuse(ok), '', ok);
  assert.strictEqual(C.cleanTitle('  Over   the river ' + ZW), 'Over the river');
  assert.strictEqual(C.cleanTitle('x'.repeat(90)).length, 40);
  assert.strictEqual(C.cleanTitle('a' + AT + 'b'), '');
  assert.strictEqual(C.esc(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
});

test('codes and ids: six characters with no I, O, 0 or 1; typed any way (dash, lower case, spaces); game ids 16 base64url characters', () => {
  assert.ok(!/[IO01]/.test(C.CODE_ALPHABET) && C.CODE_ALPHABET.length === 32);
  for (let i = 0; i < 200; i++) assert.ok(C.isCode(G.newCode()));
  assert.strictEqual(C.normalizeCode(' trk-4gn '), 'TRK4GN');
  assert.ok(C.isCode('TRK4GN') && !C.isCode('TRK4G0') && !C.isCode('TRK4G') && !C.isCode(null));
  assert.strictEqual(C.formatCode('trk4gn'), 'TRK-4GN');
  assert.ok(C.isGid(G.newGameId()) && !C.isGid('short') && !C.isGid('a/b/c/d/e/f/g/h/'));
  assert.strictEqual(G.newKey().length, 22);
});

test('scoring: points by rarity (or flat); ranks share a place on equal points; the headline says who leads or won, a tie said plainly; the best moments', () => {
  const t = trip(['Rosa', 'Ben', 'Mae'], [['HI', 0], ['OH', 1], ['TX', 1], ['CA', 1], ['VT', 2]]);
  const rows = C.standings(t.players, t.spots, t.scoring);
  assert.deepStrictEqual(rows.map((r) => [r.name, r.pts, r.count, r.rank]), [['Rosa', 5, 1, 1], ['Mae', 5, 1, 1], ['Ben', 3, 3, 3]]);
  assert.strictEqual(C.headline(rows, false), 'Rosa and Mae are tied on 5 points.');
  assert.strictEqual(C.headline(rows, true), 'Rosa and Mae tie for the win on 5 points.');
  const flat = C.standings(t.players, t.spots, 'flat');
  assert.deepStrictEqual(flat.map((r) => [r.name, r.pts]), [['Ben', 3], ['Rosa', 1], ['Mae', 1]]);
  assert.strictEqual(C.headline(flat, true), 'Ben wins with 3 points.');
  assert.strictEqual(C.headline(C.standings(t.players, {}, 'rarity'), false), 'No plates yet - eyes out the windows.');
  assert.strictEqual(C.headline(C.standings([{ name: 'Ada', c: 0 }], { OH: { p: 0, t: 1 } }, 'rarity'), false), 'Ada has 1 point.');
  assert.deepStrictEqual(C.highlights(t), ['Rarest plate: Hawaii, spotted by Rosa.', 'Ben spotted the most: 3 plates.']);
  assert.deepStrictEqual(C.totals(t.spots, 'rarity'), { count: 5, pts: 13, of: 51 });
  const all = trip(['Ada'], C.CODES.map((c) => [c, 0]));
  assert.ok(C.highlights(all).includes('Every plate on the board - all 51!'));
  assert.strictEqual(C.summary(all).pts, 14 * 1 + 16 * 2 + 11 * 3 + 10 * 5);
});

test('a trip on one phone: first spot wins (a second is refused, naming who has it); take back; add players up to 12, no repeats; an ended trip takes no plates; nothing changes in place', () => {
  const t = trip(['Rosa', 'Ben'], [['OH', 0]]);
  assert.throws(() => C.spot(t, 'OH', 1, T0 + 9), (e) => e.status === 409 && e.message === 'Rosa already spotted Ohio.');
  assert.throws(() => C.spot(t, 'ZZ', 0, T0), /not a plate/);
  assert.throws(() => C.spot(t, 'TX', 5, T0), /Who spotted/);
  const before = clone(t);
  const u = C.unspot(t, 'OH', T0 + 10);
  assert.deepStrictEqual(t, before, 'unspot does not change the trip it was given');
  assert.ok(!u.spots.OH && u.t === T0 + 10);
  let x = C.newTrip({ players: ['Ada'] }, T0);
  assert.strictEqual(x.title, 'Road trip');
  assert.throws(() => C.addPlayer(x, 'ada', T0), /already playing/);
  for (let i = 0; i < 11; i++) x = C.addPlayer(x, 'P' + 'abcdefghijk'[i], T0);
  assert.strictEqual(x.players.length, 12);
  assert.strictEqual(new Set(x.players.map((p) => p.c)).size, 12, 'twelve colours');
  assert.throws(() => C.addPlayer(x, 'Zed', T0), /12 players/);
  assert.throws(() => C.addPlayer(x, '123', T0), /first name/);
  const e = C.endTrip(t, T0 + 50);
  assert.throws(() => C.spot(e, 'TX', 0, T0 + 51), (er) => er.code === 'ended');
  assert.strictEqual(C.newTrip({ players: ['123', 'Rosa', 'rosa'] }, T0).players.length, 1, 'refused and repeated names dropped');
  assert.throws(() => C.renameTrip(t, 'mail ' + AT, T0), /email/);
});

test('the one door: strict refuses anything out of shape, whole; lenient mends and drops; a removal is a tombstone; bodyProblem finds the first personal string anywhere, keys included', () => {
  const good = { tabc1234: trip(['Rosa', 'Ben'], [['OH', 0], ['VT', 1]]), tgone123: { del: true, t: T0 } };
  assert.deepStrictEqual(C.cleanTrips(good, true), { trips: good, errors: [] });
  const bads = [
    (x) => { x.tabc1234.extra = 1; },
    (x) => { x.tabc1234.spots.ZZ = { p: 0, t: 1 }; },
    (x) => { x.tabc1234.spots.OH.p = 7; },
    (x) => { x.tabc1234.players[0].name = 'R0sa'; },
    (x) => { x.tabc1234.players[0].c = 99; },
    (x) => { x.tabc1234.players = []; },
    (x) => { x.tabc1234.title = '<b>x</b>'; },
    (x) => { x.tabc1234.mode = 'bus'; },
    (x) => { x.tabc1234.scoring = 'double'; },
    (x) => { x.tabc1234.t = -1; },
    (x) => { x['../x'] = x.tabc1234; },
    (x) => { x.tabc1234.spots.OH.extra = true; },
  ];
  for (const f of bads) {
    const x = clone(good); f(x);
    const r = C.cleanTrips(x, true);
    assert.ok(r.errors.length && Object.keys(r.trips).length === 0, JSON.stringify(x).slice(0, 80));
    const l = C.cleanTrips(x, false);
    Object.values(l.trips).forEach((t) => { if (!t.del) assert.deepStrictEqual(C.cleanTrip(t, true).errors, []); });
  }
  const many = {}; for (let i = 0; i < 301; i++) many['t' + String(i).padStart(6, 'a')] = { del: true, t: i };
  assert.ok(C.cleanTrips(many, true).errors.length);
  assert.strictEqual(Object.keys(C.trimTrips(many)).length, 300);
  assert.strictEqual(C.bodyProblem({ a: { b: ['ok', 'Call ' + PHONE] } }), C.refuse(PHONE));
  assert.ok(C.bodyProblem({ ['x' + AT + 'y']: 1 }), 'keys too');
  assert.strictEqual(C.bodyProblem(good), null);
});

test('two phones: each trip by its own time, a removal is a change, a tie the same from either side; symmetric and idempotent; the lifetime map unions every live trip', () => {
  const a = { t1aaaaaa: trip(['Rosa'], [['OH', 0]]), t2aaaaaa: trip(['Ben'], [['TX', 0]]) };
  const b = clone(a);
  b.t1aaaaaa = C.spot(b.t1aaaaaa, 'VT', 0, T0 + 99);
  b.t3aaaaaa = trip(['Mae'], [['HI', 0]]);
  a.t2aaaaaa = { del: true, t: T0 + 500 };
  const ab = C.mergeTrips(a, b), ba = C.mergeTrips(b, a);
  assert.deepStrictEqual(ab.trips, ba.trips, 'symmetric');
  assert.deepStrictEqual(C.mergeTrips(ab.trips, ab.trips).trips, ab.trips, 'idempotent');
  assert.strictEqual(ab.pulled, 2);
  assert.ok(ab.trips.t1aaaaaa.spots.VT && ab.trips.t2aaaaaa.del && ab.trips.t3aaaaaa);
  const tie1 = { t9aaaaaa: Object.assign(trip(['A']), { title: 'One' }) }, tie2 = { t9aaaaaa: Object.assign(trip(['A']), { title: 'Two' }) };
  assert.deepStrictEqual(C.mergeTrips(tie1, tie2).trips, C.mergeTrips(tie2, tie1).trips);
  const life = C.lifetime(ab.trips);
  assert.deepStrictEqual(Object.keys(life.seen).sort(), ['HI', 'OH', 'VT']);
  assert.deepStrictEqual([life.count, life.trips, life.missing.length], [3, 2, 48]);
  assert.deepStrictEqual(C.live(ab.trips).map((t) => t.id).sort(), ['t1aaaaaa', 't3aaaaaa']);
});

test('a car game as one phone sees it: names, colours, plates and the scoreboard - no key hash; players in join order; a game becomes a trip for the history', () => {
  const doc = D.game();
  doc.members.mjunie.keyHash = 'secret-hash';
  const v = C.gameView(doc, 'mrosa');
  assert.ok(!JSON.stringify(v).includes('secret-hash') && !JSON.stringify(v).includes('keyHash'));
  assert.deepStrictEqual(v.players.map((p) => p.name), ['Junie', 'Theo', 'Rosa', 'Ben']);
  assert.deepStrictEqual([v.you, v.host, v.players[2].you, v.players[0].host], [2, false, true, true]);
  const t = C.tripFromGame(v, null, T0);
  assert.deepStrictEqual(C.cleanTrip(t, true).errors, []);
  assert.strictEqual(C.summary(t).headline, v.headline);
  assert.strictEqual(C.tripFromGame(Object.assign({}, v, { ended: true }), t, T0 + 5).ended, T0 + 5);
});

test('the recap card’s words: title, date, headline, the line, four standings and "+N more", the best moment, colours by plate; fitText cuts with an ellipsis', () => {
  const t = trip(['Rosa', 'Ben', 'Mae', 'Kai', 'Ivy'], [['HI', 0], ['OH', 1], ['TX', 2], ['CA', 3], ['FL', 4]]);
  const d = C.recapData(t, T0);
  assert.strictEqual(d.date, '25 November 2026');
  assert.strictEqual(d.line, '5 of 51 plates · 9 points · 5 players');
  assert.strictEqual(d.rows.length, 4);
  assert.strictEqual(d.more, '+1 more');
  assert.strictEqual(d.moment, 'Rarest plate: Hawaii, spotted by Rosa.');
  assert.deepStrictEqual(d.spots, { HI: 0, OH: 1, TX: 2, CA: 3, FL: 4 });
  assert.strictEqual(d.rows[0].initials, 'RO');
  assert.strictEqual(C.initials('Mary Ann'), 'MA');
  const m = (s) => s.length * 10;
  assert.strictEqual(C.fitText('short', 100, m), 'short');
  assert.strictEqual(C.fitText('a much longer line', 100, m), 'a much lo…');
});

test('the demo’s planted story: four phones mid-drive, Theo leads with 13; tap Vermont and Junie leads with 15; tap Ohio and Theo gets there first; three earlier trips with 35 plates between them; nothing in it out of shape', () => {
  const g = D.game();
  assert.ok(C.isCode(D.CODE));
  const v = C.gameView(g, D.YOU);
  assert.strictEqual(v.headline, 'Theo leads with 13 points.');
  assert.deepStrictEqual(v.total, { count: 22, pts: 41, of: 51 });
  const vt = D.tap(g, 'VT', D.T);
  assert.strictEqual(vt.taken, null);
  assert.strictEqual(C.gameView(vt.doc, D.YOU).headline, 'Junie leads with 15 points.');
  const oh = D.tap(vt.doc, 'OH', D.T);
  assert.strictEqual(oh.taken, 'Theo');
  assert.strictEqual(C.gameView(oh.doc, D.YOU).headline, 'Junie leads with 15 points.');
  assert.strictEqual(C.gameView(oh.doc, D.YOU).rows[1].pts, 14);
  assert.strictEqual(D.tap(oh.doc, 'VT', D.T).taken, 'you');
  assert.deepStrictEqual(g, D.game(), 'the example never changes in place');
  const tr = D.trips();
  assert.deepStrictEqual(C.cleanTrips(tr, true).errors, []);
  assert.strictEqual(C.lifetime(tr).count, 35);
});

test('storage: one module; the trips through the one door; a throwing or missing localStorage falls back to memory and says so; a game is only ever remembered with its trip', () => {
  const mem = {};
  const ls = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const s = S.create(ls);
  assert.ok(s.persistent());
  s.putTrips({ tgood123: trip(['Rosa'], [['OH', 0]]) });
  mem[S.KEYS.trips] = JSON.stringify(Object.assign(JSON.parse(mem[S.KEYS.trips]), { 'bad id': {}, tbad1234: { title: '<x>' } }));
  assert.deepStrictEqual(Object.keys(s.getTrips()), ['tgood123', 'tbad1234']);
  assert.ok(!JSON.stringify(s.getTrips()).includes('<x>'));
  s.putNow({ game: 'AAAAAAAAAAAAAAAA' });
  assert.deepStrictEqual(s.getNow(), {}, 'a game alone is not kept');
  s.putNow({ game: 'AAAAAAAAAAAAAAAA', trip: 'gabcdefghij', key: 'x' });
  assert.deepStrictEqual(s.getNow(), { trip: 'gabcdefghij', game: 'AAAAAAAAAAAAAAAA' });
  s.putPrefs({ name: '<b>Rosa</b>', tour: 'yes' });
  assert.deepStrictEqual(s.getPrefs(), { name: 'Rosa', tour: false });
  mem[S.KEYS.sync] = '{not json';
  assert.deepStrictEqual(s.getSync(), { base: null, at: 0 });
  const broken = S.create({ getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); }, removeItem() { throw new Error('no'); } });
  assert.ok(!broken.persistent());
  broken.putTrips({ tgood123: trip(['Rosa']) });
  assert.deepStrictEqual(Object.keys(broken.getTrips()), ['tgood123'], 'kept in memory');
  assert.ok(!S.create(null).persistent());
  s.clearAll();
  assert.deepStrictEqual(Object.keys(mem), []);
});

test('every text colour holds 4.5:1 on its surface in both themes; the twelve player colours hold white text; the hero; the lab card 20+ in CIE Lab from every card with white text; 44px targets; no sideways scroll; reduced motion', () => {
  const css = read('public/app.css');
  const tokens = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));
  const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
  const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));
  const dark = tokens(darkBlock.slice(0, darkBlock.indexOf('}')));
  assert.deepStrictEqual(tokens(css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf(':root[data-theme="dark"]'))), dark, 'both dark blocks agree');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg) => assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const fg of ['text', 'muted', 'link', 'ink']) for (const bg of ['bg', 'card', 'card2']) ok(fg, bg);
    ok('text', 'accent-soft'); ok('text', 'warn-bg'); ok('muted', 'tile'); ok('accent-ink', 'accent'); ok('seen-ink', 'seen'); ok('bg', 'text');
    for (const k of ['ok', 'warn', 'bad']) { ok(k, `${k}-bg`); ok(k, 'card'); ok(k, 'bg'); }
    ok('ok', 'card2'); ok('link', 'card2');
  }
  for (const c of C.COLORS) assert.ok(ratio('#ffffff', c) >= 4.5, `white on ${c}`);
  C.COLORS.forEach((c, i) => assert.ok(css.includes(`.tile.p${i} rect, .bg${i} { fill: ${c}; background: ${c}; }`), `player colour ${i} in the CSS`));
  for (const bg of ['#8f3209', '#a43c0c', '#2a2f78']) assert.ok(ratio('#ffffff', bg) >= 4.5, `hero white on ${bg}`);
  assert.ok(ratio('#7a2b07', '#ffffff') >= 4.5);
  // The lab card.
  const LAB = require('../../../lab');
  const lab = LAB.get('spotted');
  assert.ok(lab, 'Spotted is in lab.js');
  assert.deepStrictEqual([lab.color, lab.color2, lab.dropped, lab.status, lab.emoji, lab.audience], ['#ea0000', '#7b5dae', '2026-11-22', 'testing', '\u{1F697}', 'Families and friends on a road trip']);
  assert.strictEqual(lab.tagline, 'The license plate game for the whole car - every phone playing, first to spot it scores.');
  assert.ok(ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const other of LAB.APPS.filter((x) => x.slug !== 'spotted')) {
    for (const c of [other.color, other.color2]) assert.ok(labDist(lab.color, c) >= 20 && labDist(lab.color2, c) >= 20, `away from ${other.slug} ${c}: ${labDist(lab.color, c).toFixed(1)} / ${labDist(lab.color2, c).toFixed(1)}`);
    assert.notStrictEqual(other.emoji, lab.emoji, `${other.slug} has the same emoji`);
  }
  assert.strictEqual(LAB.APPS.findIndex((x) => x.slug === 'spotted') + 1, 65, 'drop #65');
  assert.strictEqual(lab.features.length, 4);
  for (const sel of ['.btn', '.btn.small', '.link-btn', '.input', '.tabbar button']) assert.ok(new RegExp('\\n' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: (4[4-9]|[5-9]\\d)px').test(css), `${sel}: 44px`);
  assert.ok(/\.seg button, \.seg label \{[^}]*min-height: 44px/.test(css) && /\.plate \{[^}]*min-height: 64px/.test(css) && /\.trow \{[^}]*min-height: 64px/.test(css) && /\.whobtn \{[^}]*min-height: 56px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css) && /\.plates \{ display: grid; gap: 8px; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(css));
  assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(css));
});

test('the page: relative links, no inline script or handlers, the banner, the car with no variation selector; storage only through spotted-store.js; no clock or dice in the core or the demo; requests BASE-relative and only to the listed routes; polling only while visible; every received string escaped; the recap shared as a file', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  assert.ok(html.includes('\u{1F697}') && !html.includes('\u{1F697}\u{FE0F}'));
  const js = read('public/app.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(js), 'the page touches no storage itself');
  assert.match(js, /var BASE = new URL\('\.', document\.baseURI\)\.pathname;/);
  assert.match(js, /return fetch\(BASE \+ path, \{/);
  assert.strictEqual((js.match(/fetch\(/g) || []).length, 1, 'one fetch, through api()');
  const routes = new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[1] + ' ' + m[2]));
  for (const r of routes) assert.ok(/^(GET api\/g\/|POST api\/g\/|DELETE api\/g\/|POST api\/games$|GET api\/join\/|POST api\/join\/|GET api\/me$|GET api\/sync$|PUT api\/sync$|DELETE api\/sync$|POST api\/auth\/)/.test(r), r);
  assert.match(js, /document\.visibilityState === 'visible'/);
  assert.match(js, /function wantPoll\(\) \{ return Boolean\(state\.now\.game && !state\.demo && document\.visibilityState === 'visible'/);
  assert.match(js, /if \(document\.visibilityState !== 'visible'\) \{ clearTimeout\(pollTimer\); return; \}/);
  assert.ok(!/setInterval/.test(js), 'no timer runs when nobody is looking');
  for (const f of ['public/spotted-core.js', 'public/demo.js']) {
    const src = read(f);
    assert.ok(!/Date\.now|new Date\(\)|Math\.random|crypto\./.test(src), `${f}: no clock or dice`);
  }
  // Every received or typed field goes through esc() before markup (a
  // toast or a spoken line is set with textContent, never markup).
  assert.match(js, /t\.textContent = msg;/);
  const marked = js.split('\n').filter((l) => !/^\s*(if \(r\.taken === 'you'\) |else if \(r\.taken\) |else )?toast\(|\bsay\(/.test(l)).join('\n');
  for (const field of ['.title', '.name', 'v.headline', 'r.name', 'pl.name', 'who.name', 'state.q', 'st.n', 'err.message']) {
    const re = new RegExp("'\\s*\\+\\s*" + field.replace(/\./g, '\\.') + '\\s*\\+\\s*\'', 'g');
    assert.ok(!re.test(marked), `${field} concatenated into markup unescaped`);
  }
  assert.match(js, /new File\(\[recapBlob\], name, \{ type: 'image\/png' \}\)/);
  assert.match(js, /navigator\.share\(\{ files: \[file\]/);
  assert.ok(!/navigator\.share\(\{[^}]*url: [^}]*recap/i.test(js), 'the recap is never a link');
  assert.ok(!/getUserMedia|capture=|type="file"|geolocation/.test(js + html), 'no camera, no photos, no location');
  const sw = read('public/sw.js');
  assert.ok(sw.includes("if (rel.indexOf('api/') === 0) return;") && sw.includes("k.indexOf('spotted-') === 0"));
  for (const f of ['spotted-core.js', 'spotted-store.js', 'demo.js', 'app.js', 'app.css', 'desktop.css', 'passkey-client.js', 'verify-banner.js', 'icon.svg', 'manifest.webmanifest']) assert.ok(sw.includes(`'${f}'`), `${f} kept offline`);
});

test('the copy: no email addresses, phone numbers, model names or session links in any file; neutral words; the shared files are the lab’s copies; CLAUDE.md says it is a rebuild and explains the rarity rule', () => {
  const files = ['server.js', 'lib/games.js', 'lib/store.js', 'public/app.js', 'public/spotted-core.js', 'public/demo.js', 'public/spotted-store.js', 'public/index.html', 'public/app.css', 'public/sw.js', 'CLAUDE.md', 'test/run.js'];
  for (const f of files) {
    const s = read(f);
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(s), `${f}: an email address`);
    assert.ok(!/claude-(haiku|sonnet|opus)|claude\.ai\/code/.test(s), `${f}: a model name or session link`);
    assert.ok(!/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/.test(s), `${f}: an invisible character`);
    assert.ok(!new RegExp(['sk', 'ant', ''].join('-') + '|AIza[0-9A-Za-z_-]{20}').test(s), `${f}: a key-shaped string`);
  }
  assert.ok(!/require\('@anthropic-ai\/sdk'\)/.test(read('server.js')), 'no model client at all');
  for (const f of ['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']) assert.strictEqual(read('lib/' + f), fs.readFileSync(path.join(ROOT, '..', 'ladle', 'lib', f), 'utf8'), f);
  for (const f of ['desktop.css', 'passkey-client.js', 'verify-banner.js']) assert.strictEqual(read('public/' + f), fs.readFileSync(path.join(ROOT, '..', 'ladle', 'public', f), 'utf8'), f);
  const sync = fs.readFileSync(path.join(ROOT, '..', '..', '..', 'scripts', 'sync-shared.js'), 'utf8');
  assert.ok(sync.includes("['eriks-projects/challenge/apps/spotted/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']]") && sync.includes("['eriks-projects/challenge/apps/spotted/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']]"));
  const doc = read('CLAUDE.md');
  assert.match(doc, /a rebuild of the 2026-11-12 drop/i);
  assert.match(doc, /Alaska and Hawaii/);
  assert.match(doc, /No AI/);
  const copy = read('public/app.js') + read('public/demo.js');
  assert.ok(!/\b(he|she|his|her|him)\b/.test(copy.replace(/\/\*[\s\S]*?\*\//g, '')), 'neutral copy');
});

test('local-only switches throw on Cloud Run; the lab prefix is read; games found by one field; one history document per account, by its tag', () => {
  for (const [mod, env] of [['./lib/store', { SPOTTED_MEMORY: '1' }], ['./server', { SPOTTED_FAKE_AI: '1', SPOTTED_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, SPOTTED_MEMORY: '', SPOTTED_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, SPOTTED_MEMORY: '', SPOTTED_COLLECTION_PREFIX: 'spotted_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'spotted_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g))].sort(), ["store.get('games'", "store.get('trips'", "store.list('games'", "store.remove('games'", "store.transact('games'", "store.transact('trips'", "store.transactKeys('games'"]);
  assert.ok([...server.matchAll(/where: \[(\[[^\]]*\])\]/g)].every((m) => m[1] === "['code', '==', c]" || m[1] === "['code', '==', code]"), 'single-field equality only: no composite index');
  assert.match(server, /update\('spotted owner v1'\)/);
  assert.match(read('lib/games.js'), /update\(`spotted member v1:\$\{key\}:\$\{id\}`\)/);
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
    return { status: res.status, data, text: t, headers: res.headers, set };
  };
  call.cookies = cookies;
  call.ip = ip;
  return call;
}
const mail = (who) => `${who}${AT}example.com`;
async function register(who) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const HUGE = { x: 'x'.repeat(1.2 * 1024 * 1024) };
async function startGame(host, extra) {
  const r = await host('POST', '/api/games', Object.assign({ name: 'Rosa', title: 'Drive to Gran’s' }, extra || {}));
  assert.strictEqual(r.status, 200, r.text);
  return { id: r.data.id, code: r.data.game.code, game: r.data.game };
}
async function car(n) {
  const host = client();
  const g = await startGame(host);
  const players = [];
  for (let i = 0; i < n; i++) {
    const c = client();
    const j = await c('POST', `/api/join/${g.code}`, { name: 'Kid' });
    assert.strictEqual(j.status, 200, j.text);
    players.push(c);
  }
  return { host, players, ...g };
}

test('signed out: the page and its files load; the CSP and no-referrer; the app shell for any page path; sync answers 401 before reading a body; no other route takes a photo or a trip', async () => {
  const anon = client();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  for (const f of ['spotted-core.js', 'spotted-store.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  const shell = await page.text();
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/sync'], ['PUT', '/api/sync'], ['DELETE', '/api/sync']]) assert.strictEqual((await anon(m, p, m === 'PUT' ? { data: {} } : undefined)).status, 401, `${m} ${p}`);
  assert.strictEqual((await anon('PUT', '/api/sync', HUGE)).status, 401, 'the gate answers before the parser, so never 413');
  assert.strictEqual((await anon('POST', '/api/games', HUGE)).status, 413, 'a game takes 16 KB at most');
  for (const p of ['/api/photo', '/api/ai/plate', '/api/trips', '/api/plates']) assert.strictEqual((await anon('POST', p, { x: 1 })).status, 404, p);
  for (const p of ['/play', '/trips', '/join/ABC']) assert.strictEqual(await (await fetch(`${base}${p}`)).text(), shell, `${p} is only the app shell`);
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/sync', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
});

test('writes come from this page: another site’s request (Sec-Fetch-Site or Origin) is 403 and a body that is not JSON 415, before anything else', async () => {
  const c = client();
  assert.strictEqual((await c('POST', '/api/games', { name: 'Rosa' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await c('POST', '/api/games', { name: 'Rosa' }, { 'Sec-Fetch-Site': 'same-site' })).status, 403, 'a sibling subdomain is another site here');
  assert.strictEqual((await c('POST', '/api/join/TRK4GN', { name: 'Rosa' }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await c('POST', '/api/games', 'name=Rosa', { 'Content-Type': 'text/plain' })).status, 415);
  assert.strictEqual((await c('DELETE', '/api/g/AAAAAAAAAAAAAAAA', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const same = await c('POST', '/api/games', { name: 'Rosa' }, { 'Sec-Fetch-Site': 'same-origin', Origin: base.replace(/\/spotted$/, '') });
  assert.strictEqual(same.status, 200, same.text);
});

test('a car game: started with a first name and no account; joined with the code (any case, a dash) and a first name; the key an HttpOnly cookie on the app’s path, stored only as a per-game hash; a repeated name numbered; the preview shows no other name and no score', async () => {
  const host = client();
  const r = await host('POST', '/api/games', { name: '  Rosa ', title: 'Drive to Gran’s', scoring: 'flat' });
  assert.strictEqual(r.status, 200);
  const cookie = r.set.find((c) => c.startsWith('spotted_k='));
  assert.ok(cookie && /; Path=\/spotted\/;/.test(cookie) && /HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie), cookie);
  const key = host.cookies.spotted_k;
  assert.strictEqual(key.length, 22);
  const { id, game } = r.data;
  assert.deepStrictEqual([game.title, game.scoring, game.host, game.you, game.players[0].name], ['Drive to Gran’s', 'flat', true, 0, 'Rosa']);
  const doc = await store.get('games', id);
  assert.strictEqual(doc.members[Object.keys(doc.members)[0]].keyHash, G.keyHash(key, id));
  assert.ok(!JSON.stringify(doc).includes(key), 'the key itself is never stored');
  assert.strictEqual(G.keyHash(key, id), crypto.createHash('sha256').update(`spotted member v1:${key}:${id}`).digest('base64url').slice(0, 32));
  const peek = await client()('GET', `/api/join/${game.code.toLowerCase()}`);
  assert.deepStrictEqual(peek.data, { title: 'Drive to Gran’s', by: 'Rosa', players: 1, full: false, ended: false, already: null });
  const ben = client();
  const j = await ben('POST', `/api/join/${C.formatCode(game.code)}`, { name: 'Rosa' });
  assert.deepStrictEqual(j.data, { id, isNew: true });
  const again = await ben('POST', `/api/join/${game.code}`, { name: 'Other' });
  assert.deepStrictEqual(again.data, { id, isNew: false }, 'the same browser joins once');
  const v = (await ben('GET', `/api/g/${id}`)).data.game;
  assert.deepStrictEqual(v.players.map((p) => [p.name, p.c, p.you]), [['Rosa', 0, false], ['Rosa 2', 1, true]]);
  assert.ok(!JSON.stringify(v).includes('keyHash'));
  // The same browser in a second game: a different hash, so two games cannot be linked.
  const g2 = await startGame(host);
  const d2 = await store.get('games', g2.id);
  assert.notStrictEqual(Object.values(d2.members)[0].keyHash, doc.members[Object.keys(doc.members)[0]].keyHash);
  assert.strictEqual((await client()('POST', `/api/join/${game.code}`, { name: '123' })).status, 400);
  assert.strictEqual((await client()('POST', '/api/games', { name: '' })).status, 400);
  assert.strictEqual((await client()('POST', '/api/games', { name: 'Rosa', title: 'call ' + PHONE })).status, 400);
});

test('first tap wins: twelve phones tapping Ohio at once - exactly one scores it and eleven hear who did; different plates at once all land; the scores add up on every phone; a plate already yours says so', async () => {
  const c = await car(11);
  const all = [c.host, ...c.players];
  const res = await Promise.all(all.map((p) => p('POST', `/api/g/${c.id}/spots`, { state: 'OH' })));
  const wins = res.filter((r) => r.status === 200);
  assert.strictEqual(wins.length, 1, res.map((r) => r.status).join(','));
  const losers = res.filter((r) => r.status === 409);
  assert.strictEqual(losers.length, 11);
  const winner = wins[0].data.game.players[wins[0].data.game.you].name;
  losers.forEach((r) => { assert.strictEqual(r.data.code, 'taken'); assert.strictEqual(r.data.by, winner); assert.strictEqual(r.data.error, `${winner} spotted Ohio first.`); assert.ok(r.data.game.spots.OH); });
  const codes = ['TX', 'VT', 'HI', 'AK', 'IA', 'TN', 'CA', 'FL', 'NY', 'PA', 'MD', 'DE'];
  const many = await Promise.all(all.map((p, i) => p('POST', `/api/g/${c.id}/spots`, { state: codes[i] })));
  assert.ok(many.every((r) => r.status === 200), many.map((r) => r.status).join(','));
  assert.deepStrictEqual(many.map((r) => r.data.pts), codes.map((x) => C.pointsFor(x, 'rarity')));
  const views = await Promise.all(all.map((p) => p('GET', `/api/g/${c.id}`)));
  const first = views[0].data.game;
  views.forEach((v) => { assert.deepStrictEqual(v.data.game.rows, first.rows); assert.strictEqual(v.data.game.v, first.v); });
  assert.strictEqual(first.total.count, 13);
  assert.strictEqual(first.total.pts, 1 + codes.reduce((s, x) => s + C.pointsFor(x, 'rarity'), 0));
  const mine = await c.host('POST', `/api/g/${c.id}/spots`, { state: 'TX' });
  assert.deepStrictEqual([mine.status, mine.data.error], [409, 'You already have Texas.']);
  assert.strictEqual((await c.host('POST', `/api/g/${c.id}/spots`, { state: 'ON' })).status, 400);
  assert.strictEqual((await c.host('POST', `/api/g/${c.id}/spots`, { state: '__proto__' })).status, 400);
  // Without the queue, two read-then-write taps would both win: the memory
  // store's transaction is what keeps one.
  const id = 'race000000000000';
  await store.set('games', id, { spots: {} });
  const unsafe = (who) => store._unsafeUpdate('games', id, (cur) => (cur.spots.OH ? cur : { ...cur, spots: { OH: { by: who } } }));
  await Promise.all([unsafe('a'), unsafe('b')]);
  assert.strictEqual((await store.get('games', id)).spots.OH.by, 'b', 'the unqueued second write overwrote the first');
  await store.remove('games', id);
});

test('polling: ?since=v answers {same} for one read when nothing moved; a join or a plate moves v', async () => {
  const c = await car(1);
  const v = (await c.host('GET', `/api/g/${c.id}`)).data.game.v;
  assert.deepStrictEqual((await c.host('GET', `/api/g/${c.id}?since=${v}`)).data, { same: true, v });
  await c.players[0]('POST', `/api/g/${c.id}/spots`, { state: 'OH' });
  const next = await c.host('GET', `/api/g/${c.id}?since=${v}`);
  assert.ok(next.data.game && next.data.game.v === v + 1 && next.data.game.spots.OH);
  assert.strictEqual((await c.host('GET', `/api/g/${c.id}?since=abc`)).data.game.v, v + 1);
});

test('taking a plate back: the spotter within five minutes, never someone else’s; the host any plate; after five minutes only the host; the plate is open again', async () => {
  const c = await car(2);
  const [ben, mae] = c.players;
  await ben('POST', `/api/g/${c.id}/spots`, { state: 'OH' });
  const no = await mae('DELETE', `/api/g/${c.id}/spots/OH`);
  assert.deepStrictEqual([no.status, no.data.code], [403, 'not-yours']);
  const own = await ben('DELETE', `/api/g/${c.id}/spots/OH`);
  assert.ok(own.status === 200 && !own.data.game.spots.OH);
  assert.strictEqual((await mae('POST', `/api/g/${c.id}/spots`, { state: 'OH' })).status, 200, 'open again');
  await ben('POST', `/api/g/${c.id}/spots`, { state: 'TX' });
  const doc = await store.get('games', c.id);
  doc.spots.TX.at = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  await store.set('games', c.id, doc);
  const late = await ben('DELETE', `/api/g/${c.id}/spots/TX`);
  assert.deepStrictEqual([late.status, late.data.error], [403, 'Only the first 5 minutes - ask whoever started the game.']);
  const hostOk = await c.host('DELETE', `/api/g/${c.id}/spots/TX`);
  assert.ok(hostOk.status === 200 && !hostOk.data.game.spots.TX);
  assert.strictEqual((await c.host('DELETE', `/api/g/${c.id}/spots/ZZ`)).status, 400);
});

test('the end, leaving and removing: only the host ends, removes or deletes; an ended game takes no plates and no new players but every phone still reads it; a player who leaves keeps their points and can no longer open it; a removed player’s plates open again', async () => {
  const c = await car(3);
  const [ben, mae, kai] = c.players;
  await ben('POST', `/api/g/${c.id}/spots`, { state: 'VT' });
  await mae('POST', `/api/g/${c.id}/spots`, { state: 'OH' });
  await kai('POST', `/api/g/${c.id}/spots`, { state: 'TX' });
  assert.strictEqual((await ben('POST', `/api/g/${c.id}/end`)).data.code, 'not-host');
  const view = (await c.host('GET', `/api/g/${c.id}`)).data.game;
  const kaiId = view.players.find((p) => p.name === 'Kid 3').id;
  assert.strictEqual((await ben('DELETE', `/api/g/${c.id}/players/${kaiId}`)).status, 403);
  const kicked = await c.host('DELETE', `/api/g/${c.id}/players/${kaiId}`);
  assert.ok(kicked.status === 200 && !kicked.data.game.spots.TX && kicked.data.game.players.length === 3);
  assert.strictEqual((await kai('GET', `/api/g/${c.id}`)).status, 404);
  assert.strictEqual((await c.host('DELETE', `/api/g/${c.id}/me`)).status, 409, 'the host ends instead of leaving');
  assert.strictEqual((await mae('DELETE', `/api/g/${c.id}/me`)).status, 200);
  assert.strictEqual((await mae('GET', `/api/g/${c.id}`)).status, 404);
  const after = (await c.host('GET', `/api/g/${c.id}`)).data.game;
  assert.ok(after.spots.OH && after.players.find((p) => p.name === 'Kid 2').left, 'their plate and name stay');
  assert.strictEqual(after.rows.find((r) => r.name === 'Kid 2').pts, 1);
  const back = await mae('POST', `/api/join/${c.code}`, { name: 'Mae' });
  assert.strictEqual(back.data.isNew, false, 'rejoining picks their seat back up');
  const end = await c.host('POST', `/api/g/${c.id}/end`);
  assert.ok(end.data.game.ended);
  assert.strictEqual(end.data.game.headline, 'Kid wins with 5 points.');
  const late = await ben('POST', `/api/g/${c.id}/spots`, { state: 'CA' });
  assert.deepStrictEqual([late.status, late.data.code], [409, 'ended']);
  assert.strictEqual((await client()('POST', `/api/join/${c.code}`, { name: 'New' })).data.code, 'ended');
  assert.ok((await ben('GET', `/api/g/${c.id}`)).data.game.ended, 'still readable');
  assert.strictEqual((await ben('DELETE', `/api/g/${c.id}`)).status, 403);
  assert.strictEqual((await c.host('DELETE', `/api/g/${c.id}`)).status, 200);
  assert.strictEqual(await store.get('games', c.id), null);
});

test('the same 404, word for word, for an unknown id, a malformed one, one not yours and one gone; a game a day idle is deleted by the read that finds it - by id or by code; polling alone does not keep it alive', async () => {
  const c = await car(1);
  const stranger = client();
  const texts = new Set();
  for (const [who, p] of [[stranger, '/api/g/AAAAAAAAAAAAAAAA'], [stranger, '/api/g/bad'], [stranger, `/api/g/${c.id}`]]) {
    const r = await who('GET', p);
    assert.strictEqual(r.status, 404); texts.add(r.data.error);
  }
  assert.strictEqual(texts.size, 1);
  for (let i = 0; i < 3; i++) await c.host('GET', `/api/g/${c.id}`);
  const doc = await store.get('games', c.id);
  doc.updatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000).toISOString();
  await store.set('games', c.id, doc);
  const gone = await c.host('GET', `/api/g/${c.id}`);
  assert.strictEqual(gone.status, 404); assert.ok(texts.has(gone.data.error));
  assert.strictEqual(await store.get('games', c.id), null, 'deleted on read');
  const c2 = await car(0);
  const d2 = await store.get('games', c2.id);
  d2.updatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await store.set('games', c2.id, d2);
  assert.strictEqual((await client()('GET', `/api/join/${c2.code}`)).status, 404);
  assert.strictEqual(await store.get('games', c2.id), null);
  const fresh = await car(0);
  const d3 = await store.get('games', fresh.id);
  d3.updatedAt = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
  await store.set('games', fresh.id, d3);
  assert.strictEqual((await fresh.host('GET', `/api/g/${fresh.id}`)).status, 200, 'under a day: still there');
});

test('the wrong-code limiter: 30 distinct wrong codes or ids from one address in 15 minutes, then even the right one waits; the same dead id polled over and over counts once; another address is not affected; IPv6 by its /64', async () => {
  const c = await car(0);
  const guesser = client('2001:db8:aaaa:1::1');
  for (let i = 0; i < 40; i++) await guesser('GET', '/api/g/AAAAAAAAAAAAAAAA');
  assert.strictEqual((await guesser('GET', `/api/join/${c.code}`)).status, 200, 'one dead id, many times, is not guessing');
  const alphabet = C.CODE_ALPHABET;
  let n = 0;
  for (let i = 0; n < 29; i++) {
    const code = 'ZZZ' + alphabet[i % 32] + alphabet[Math.floor(i / 32) % 32] + 'Z';
    if (code === c.code) continue;
    const r = await guesser('GET', `/api/join/${code}`);
    assert.strictEqual(r.status, 404); n++;
  }
  const blocked = await client('2001:db8:aaaa:1::99')('GET', `/api/join/${c.code}`);
  assert.strictEqual(blocked.status, 429, 'the same /64, the right code: waits');
  assert.strictEqual((await guesser('POST', `/api/join/${c.code}`, { name: 'Kai' })).status, 429);
  assert.strictEqual((await guesser('GET', `/api/g/${c.id}`)).status, 429);
  assert.strictEqual((await client('2001:db8:bbbb:1::1')('GET', `/api/join/${c.code}`)).status, 200, 'another address is fine');
  misses.clear();
});

test('limits: 12 players a car (refused, never cut); 10 new games an address an hour; 30 new players an address an hour', async () => {
  const c = await car(11);
  const full = await client()('POST', `/api/join/${c.code}`, { name: 'Late' });
  assert.deepStrictEqual([full.status, full.data.error], [409, 'This car has 12 players - that’s the most one game can have.']);
  assert.strictEqual((await client()('GET', `/api/join/${c.code}`)).data.full, true);
  const one = client('2001:db8:cccc:1::1');
  for (let i = 0; i < 10; i++) assert.strictEqual((await one('POST', '/api/games', { name: 'Rosa' })).status, 200);
  assert.strictEqual((await one('POST', '/api/games', { name: 'Rosa' })).status, 429);
  const hosts = []; for (let i = 0; i < 4; i++) hosts.push(await startGame(client()));
  const flood = (i) => client('2001:db8:dddd:1::' + (i + 1).toString(16));
  let ok = 0;
  for (let i = 0; i < 31; i++) { const r = await flood(i)('POST', `/api/join/${hosts[Math.floor(i / 10)].code}`, { name: 'Kid' }); if (r.status === 200) ok++; else assert.strictEqual(r.status, 429); }
  assert.strictEqual(ok, 30);
});

test('hostile input end to end: markup, bidi and zero-width names, a long name, an email or phone as a trip name, a prototype key as a plate, a body that is not an object - refused or cleaned, nothing odd stored', async () => {
  const host = client();
  const r = await host('POST', '/api/games', { name: `<img src=x onerror=alert(1)>Ro${RLO}sa${ZW}`, title: 'Trip' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.game.players[0].name, 'Rosa');
  assert.strictEqual(r.data.game.title, 'Trip');
  for (const title of ['<b>Trip</b>', 'mail ' + mail('x'), 'call ' + PHONE, 'https://x.test']) assert.strictEqual((await client()('POST', '/api/games', { name: 'Rosa', title })).status, 400, title);
  const long = await client()('POST', `/api/join/${r.data.game.code}`, { name: 'Bartholomew-Alexander the Third' });
  assert.strictEqual(long.status, 200);
  for (const state of ['__proto__', 'constructor', 'toString', { x: 1 }, ['OH'], null]) assert.strictEqual((await host('POST', `/api/g/${r.data.id}/spots`, { state })).status, 400, JSON.stringify(state));
  assert.strictEqual((await host('POST', '/api/games', '[1,2]')).status, 400);
  assert.strictEqual((await host('POST', '/api/games', '{bad json')).status, 400);
  const dump = JSON.stringify(await store.get('games', r.data.id));
  assert.ok(!/[<>]|onerror|\u202E|\u200B/.test(dump), dump);
  assert.ok(dump.includes('"Bartholomew-Alexande"'), 'a long name is cut to 20, not refused');
  assert.ok(!dump.includes('Bartholomew-Alexander the Third'));
});

test('sync: the trip history follows the account to the other phone; a stale phone gets 409 with the account copy and merges; anything personal or out of shape refused whole; filed under an HMAC of the account id; 120 saves in ten minutes', async () => {
  const a = await register('trip.one');
  assert.deepStrictEqual((await a('GET', '/api/sync')).data, { data: null, updatedAt: null });
  const mine = { tlake1234: trip(['Junie', 'Theo'], [['OH', 0], ['VT', 1]]) };
  const s1 = await a('PUT', '/api/sync', { data: mine, base: null });
  assert.strictEqual(s1.status, 200, s1.text);
  const other = { ...mine, tcoast123: trip(['Rosa'], [['HI', 0]]) };
  const stale = await a('PUT', '/api/sync', { data: other, base: null });
  assert.deepStrictEqual([stale.status, stale.data.code], [409, 'conflict']);
  assert.deepStrictEqual(stale.data.data, mine);
  const merged = C.mergeTrips(other, stale.data.data).trips;
  const s2 = await a('PUT', '/api/sync', { data: merged, base: stale.data.updatedAt });
  assert.strictEqual(s2.status, 200);
  assert.deepStrictEqual(Object.keys((await a('GET', '/api/sync')).data.data).sort(), ['tcoast123', 'tlake1234']);
  for (const bad of [
    (x) => { x.tlake1234.title = 'Call ' + PHONE; },
    (x) => { x.tlake1234.players[0].name = mail('x'); },
    (x) => { x.tlake1234.extra = 1; },
    (x) => { x.tlake1234.spots.ON = { p: 0, t: 1 }; },
  ]) { const x = clone(merged); bad(x); const r = await a('PUT', '/api/sync', { data: x, base: s2.data.updatedAt }); assert.strictEqual(r.status, 400, r.text); }
  assert.strictEqual((await a('PUT', '/api/sync', { data: merged, base: s2.data.updatedAt, more: 1 })).status, 400);
  const me = await a('GET', '/api/auth/me');
  const uid = me.data.user ? me.data.user.id : Buffer.from(mail('trip.one')).toString('base64url');
  const tag = ownerTag(uid, 'local-dev-secret');
  const doc = await store.get('trips', tag);
  assert.ok(doc && doc.owner === tag, 'filed under the HMAC tag');
  assert.ok(!JSON.stringify(doc).includes(AT) && !JSON.stringify(doc).includes(uid));
  assert.strictEqual((await a('DELETE', '/api/sync')).status, 200);
  const removed = await a('PUT', '/api/sync', { data: merged, base: s2.data.updatedAt });
  assert.deepStrictEqual([removed.status, removed.data.code], [409, 'removed']);
  const b = await register('trip.two');
  let last = 0, base2 = null;
  for (let i = 0; i < 121; i++) { const r = await b('PUT', '/api/sync', { data: mine, base: base2 }); last = r.status; if (r.status === 200) base2 = r.data.updatedAt; }
  assert.strictEqual(last, 429);
});

test('a hostile pass leaves nothing identifying in the store: no browser key, no email, no account id, no markup; only games and trip histories are kept', async () => {
  const dump = store._dump();
  assert.ok(!dump.includes(AT) && !dump.includes('example.com'), 'no email');
  assert.ok(!/[<>]/.test(dump.replace(/\\u003[ce]/gi, '')), 'no markup');
  assert.ok(!/spotted_k/.test(dump));
  for (const [col, docs] of JSON.parse(dump)) {
    assert.ok(['games', 'trips'].includes(col), col);
    for (const [, d] of docs) {
      if (col === 'trips') assert.deepStrictEqual(Object.keys(d).sort(), ['owner', 'trips', 'updatedAt']);
      else {
        assert.deepStrictEqual(Object.keys(d).filter((k) => !['id', 'code', 'title', 'scoring', 'v', 'members', 'spots', 'ended', 'createdAt', 'updatedAt'].includes(k)), []);
        for (const m of Object.values(d.members)) assert.deepStrictEqual(Object.keys(m).filter((k) => !['name', 'c', 'keyHash', 'joinedAt', 'at', 'host', 'left'].includes(k)), []);
      }
    }
  }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/spotted', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/spotted`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
