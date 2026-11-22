// The rules first (the routes, the conversion table, days, weeks and time
// zones, scoring, caps and streaks, progress and postcards, text, codes, a
// trek on one phone, the one door, the two-phone merge, the recap card's
// words), then the demo's planted story, the storage module, the look, the
// page's promises and the copy, then end to end against the memory store:
//   TREK_MEMORY=1 TREK_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /trek, the way
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

if (process.env.TREK_MEMORY !== '1' || process.env.TREK_FAKE_AI !== '1') {
  console.error('run with TREK_MEMORY=1 TREK_FAKE_AI=1');
  process.exit(1);
}

const { app, store, ownerTag, misses } = require('../server');
const C = require('../public/trek-core');
const D = require('../public/demo');
const S = require('../public/trek-store');
const G = require('../lib/crews');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
const ch = (n) => String.fromCharCode(n);
const RLO = ch(0x202E), ZW = ch(0x200B), FW_AT = ch(0xFF20);
const clone = (v) => JSON.parse(JSON.stringify(v));
const PHONE = ['555', '201', '3344'].join(' ');
const T0 = 1795348800000; // 22 Nov 2026 12:00 UTC, a Sunday
const DAY0 = '2026-11-22';
const todayUtc = () => new Date().toISOString().slice(0, 10);

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
/** A trek on one phone with logs [p, day, kind, unit, amt]. */
function trek(players, logs, route) {
  let t = C.newTrek({ title: 'Test trek', players, route: route || 'c2c' }, T0, '2026-11-02');
  (logs || []).forEach(([p, day, kind, unit, amt], i) => { t = C.addLog(t, 'ltest' + String(i).padStart(4, '0'), { p, day, kind, unit, amt }, T0 + i, DAY0).trek; });
  return t;
}

/* ================================================================== *
 * The rules
 * ================================================================== */

test('the routes: six, each with a real length, a start and an end, eight checkpoints in order ending at the finish, a drawn line inside the box; the point along the line moves from start to end', () => {
  assert.deepStrictEqual(C.ROUTES.map((r) => [r.id, r.km]), [['hadrian', 135], ['c2c', 309], ['camino', 780], ['at', 3520], ['pct', 4265], ['usa', 4700]]);
  for (const r of C.ROUTES) {
    assert.strictEqual(r.checkpoints.length, 8, r.id);
    assert.strictEqual(r.checkpoints[7].at, r.m, `${r.id} ends at the finish`);
    r.checkpoints.forEach((c, i) => { if (i) assert.ok(c.at > r.checkpoints[i - 1].at); assert.ok(c.name && c.card.length > 30); assert.ok(!/[<>@]/.test(c.card + c.name)); });
    r.pts.forEach(([x, y]) => assert.ok(x >= 0 && x <= 1000 && y >= 0 && y <= 560, r.id));
    assert.deepStrictEqual(C.pointAt(r, 0).slice(0, 2), r.pts[0]);
    assert.deepStrictEqual(C.pointAt(r, 1).slice(0, 2), r.pts[r.pts.length - 1]);
    assert.deepStrictEqual(C.pointAt(r, 7).slice(0, 2), r.pts[r.pts.length - 1], 'clamped');
  }
  assert.strictEqual(C.ROUTES.find((r) => r.id === 'camino').checkpoints[3].name, 'Halfway');
  assert.ok(C.isRoute('pct') && !C.isRoute('__proto__') && !C.isRoute('constructor') && !C.isRoute(null));
});

test('the conversion table: walk and roll 1 km = 1 trail km and 80 m a minute; run 1 km and 160 m; ride a third and 100 m; swim four times and 120 m; miles are 1.609344 km; whole metres; out-of-range amounts refused with a reason', () => {
  const t = (k, u, a) => C.toTrail(k, u, a);
  assert.deepStrictEqual([t('walk', 'km', 1), t('roll', 'km', 1), t('run', 'km', 1), t('ride', 'km', 1), t('swim', 'km', 1)], [1000, 1000, 1000, 333, 4000]);
  assert.deepStrictEqual([t('walk', 'min', 30), t('roll', 'min', 30), t('run', 'min', 30), t('ride', 'min', 30), t('swim', 'min', 30)], [2400, 2400, 4800, 3000, 3600]);
  assert.strictEqual(t('ride', 'km', 30), 10000);
  assert.strictEqual(t('run', 'mi', 1), 1609);
  assert.strictEqual(t('ride', 'mi', 3), 1609);
  assert.strictEqual(t('walk', 'km', '2,5'), 2500, 'a decimal comma');
  assert.strictEqual(t('walk', 'km', 2.54), 2500, 'one decimal');
  assert.strictEqual(t('walk', 'min', 29.6), 2400, 'whole minutes');
  for (const [k, u, a] of [['walk', 'min', 0], ['walk', 'min', 601], ['walk', 'km', 0.04], ['walk', 'km', 101], ['swim', 'km', 31], ['ride', 'km', 301], ['ride', 'mi', 187], ['walk', 'km', -2], ['walk', 'km', 'ten'], ['walk', 'km', '1e3'], ['walk', 'km', Infinity], ['fly', 'km', 2], ['walk', 'yards', 2], ['walk', 'km', null], ['walk', 'km', {}]]) {
    assert.throws(() => t(k, u, a), (e) => e.status === 400 && e.message.length > 5, `${k} ${u} ${a}`);
  }
  assert.strictEqual(t('ride', 'km', 300), 100000);
  assert.strictEqual(C.amountProblem('swim', 'km', 40), 'From 0.1 to 30 km for one swim.');
  assert.strictEqual(C.amountProblem('walk', 'min', 0), 'Minutes from 1 to 600.');
  assert.strictEqual(C.amountProblem('walk', 'min', 30), '');
});

test('days and weeks: calendar dates checked strictly; weeks Monday to Sunday; a phone’s local date from its UTC offset, so a Sunday-night walk in California is Sunday’s and a Monday-morning one in Auckland is Monday’s; the server allows today or six days back in every time zone', () => {
  assert.ok(C.isDay('2026-11-22') && C.isDay('2028-02-29'));
  for (const bad of ['2026-02-29', '2026-13-01', '2026-11-31', '26-11-22', '2026-11-22T00:00', '', null, 20261122]) assert.ok(!C.isDay(bad), String(bad));
  assert.deepStrictEqual(['2026-11-16', '2026-11-19', '2026-11-22', '2026-11-23'].map(C.weekOf), ['2026-11-16', '2026-11-16', '2026-11-16', '2026-11-23']);
  assert.strictEqual(C.weekOf('2027-01-01'), '2026-12-28', 'a week across the new year');
  assert.strictEqual(C.weekOf('1970-01-01'), '1969-12-29');
  assert.strictEqual(C.weekday('2026-11-22'), 'Sun');
  assert.strictEqual(C.addDays('2026-12-31', 1), '2027-01-01');
  // Monday 07:30 UTC is still Sunday 23:30 in California (UTC-8: offset 480).
  const mondayUtc = Date.UTC(2026, 10, 23, 7, 30);
  assert.strictEqual(C.localDay(mondayUtc, 480), '2026-11-22');
  assert.strictEqual(C.weekOf(C.localDay(mondayUtc, 480)), '2026-11-16', 'it counts in Sunday’s week');
  assert.strictEqual(C.localDay(mondayUtc, 0), '2026-11-23');
  // Sunday 11:00 UTC is already Monday in Kiritimati (UTC+14: offset -840).
  assert.strictEqual(C.localDay(Date.UTC(2026, 10, 22, 11, 0), -840), '2026-11-23');
  assert.strictEqual(C.localDay(Date.UTC(2026, 10, 22, 11, 0), 720), '2026-11-21', 'UTC-12 is still Saturday');
  assert.ok(C.dayAllowed('2026-11-23', '2026-11-22'), 'UTC+14 is a day ahead');
  assert.ok(C.dayAllowed('2026-11-14', '2026-11-22'), 'six back in UTC-12 is eight back of UTC');
  assert.ok(!C.dayAllowed('2026-11-24', '2026-11-22') && !C.dayAllowed('2026-11-13', '2026-11-22') && !C.dayAllowed('nope', '2026-11-22'));
});

test('scoring: 10 points a day out, 1 per trail km capped at 25 a day, 15 a week with 3+ days; a daily short walk beats one huge day; ranks share a place; the headline says who leads, a tie said plainly', () => {
  const daily = {}; for (let i = 0; i < 7; i++) daily[C.addDays('2026-11-16', i)] = 2000;
  const s = C.personStats(daily, DAY0);
  assert.deepStrictEqual([s.active, s.m, s.goalWeeks, s.pts], [7, 14000, 1, 70 + 14 + 15]);
  const huge = C.personStats({ '2026-11-18': 999000 }, DAY0);
  assert.deepStrictEqual([huge.active, huge.m, huge.pts], [1, 25000, 10 + 25], 'capped at 25 km a day');
  const rows = C.standings([{ name: 'Ada', c: 0 }, { name: 'Bo', c: 1 }, { name: 'Cy', c: 2 }], [daily, { '2026-11-18': 999000 }, daily], DAY0);
  assert.deepStrictEqual(rows.map((r) => [r.name, r.rank]), [['Ada', 1], ['Cy', 1], ['Bo', 3]]);
  assert.strictEqual(C.headline(rows, false), 'Ada and Cy are level on 99 points.');
  assert.strictEqual(C.headline(C.standings([{ name: 'Bo' }], [{ '2026-11-18': 999000 }], DAY0), false), 'Bo has 35 points.');
  assert.strictEqual(C.headline(C.standings([{ name: 'Ada' }, { name: 'Bo' }], [{}, {}], DAY0), false), 'No steps yet - log the first walk.');
  const two = C.standings([{ name: 'Ada' }, { name: 'Bo' }], [daily, {}], DAY0);
  assert.strictEqual(C.headline(two, true), 'Ada finished top with 99 points.');
  // Ties on points go to more days out, then distance - but share the rank.
  const t2 = C.standings([{ name: 'A' }, { name: 'B' }], [{ '2026-11-16': 1000 }, { '2026-11-16': 1999 }], DAY0);
  assert.deepStrictEqual(t2.map((r) => [r.name, r.pts, r.rank]), [['B', 11, 1], ['A', 11, 1]]);
});

test('streaks: weeks in a row with 3+ days out; this week counts once made and does not break the streak while it can still be made; a missed week breaks it; the best run is kept; the crew streak needs everyone (from the week they joined; someone who left no longer counts)', () => {
  const weeks = (starts, n) => { const o = {}; starts.forEach((w) => { for (let i = 0; i < n; i++) o[C.addDays(w, i)] = 1000; }); return o; };
  const w = ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'];
  assert.strictEqual(C.personStats(weeks(w, 3), '2026-11-22').streak, 4, 'four weeks made, this one included');
  assert.strictEqual(C.personStats(weeks(w, 3), '2026-11-23').streak, 4, 'Monday: this week not made yet, the streak stands');
  assert.strictEqual(C.personStats(weeks(w, 3), '2026-11-30').streak, 0, 'a whole week missed: gone');
  assert.strictEqual(C.personStats(weeks(w, 3), '2026-11-30').best, 4, 'the best run stays');
  assert.strictEqual(C.personStats(weeks([w[0], w[1], w[3]], 3), '2026-11-22').streak, 1);
  assert.strictEqual(C.personStats(weeks(w, 2), '2026-11-22').streak, 0, 'two days a week is not the goal');
  assert.strictEqual(C.personStats(weeks(w, 3), '2026-11-22').thisWeek, 3);
  const ppl = [{ name: 'A', since: '2026-10-26' }, { name: 'B', since: '2026-11-09' }, { name: 'C', since: '2026-10-26', left: true }];
  const days = [weeks(w, 1), weeks([w[2], w[3]], 1), {}];
  assert.strictEqual(C.crewStreak(ppl, days, '2026-11-22'), 4, 'B counts from the week they joined; C left');
  assert.strictEqual(C.crewStreak(ppl, [weeks(w, 1), weeks([w[3]], 1), {}], '2026-11-22'), 1, 'B missed a week');
  assert.strictEqual(C.crewStreak(ppl, days, '2026-11-24'), 4, 'this week in progress does not break it');
  assert.strictEqual(C.crewStreak(ppl, days, 'nope'), 0);
});

test('progress and postcards: the crew’s capped distance added up across everyone (left members included); reached checkpoints, the next one and how far; crossing several at once; done at the end', () => {
  const r = C.routeOf('hadrian');
  const p = C.progress('hadrian', [{ '2026-11-20': 30000, '2026-11-21': 10000 }, { '2026-11-20': 5000 }]);
  assert.deepStrictEqual([p.m, p.reached, p.next.name, p.next.toGo], [40000, [0, 1], 'The crags', r.checkpoints[2].at - 40000]);
  assert.deepStrictEqual(C.crossed('hadrian', 13000, 70000), [0, 1, 2, 3]);
  assert.deepStrictEqual(C.crossed('hadrian', 13499, 13500), [0], 'reaching a checkpoint exactly counts');
  assert.deepStrictEqual(C.crossed('hadrian', 0, 1), []);
  const done = C.progress('hadrian', [Object.fromEntries(Array.from({ length: 6 }, (_, i) => [C.addDays('2026-11-01', i), 25000]))]);
  assert.ok(done.done && done.frac === 1 && done.next === null && done.reached.length === 8);
});

test('text: first names letters only (any script); names refused for an @ in any width, a link, seven digits in any script or markup; esc escapes all five; distances in km or miles', () => {
  assert.strictEqual(C.cleanName('  Priya  '), 'Priya');
  assert.strictEqual(C.cleanName('Zoë-Mae'), 'Zoë-Mae');
  assert.strictEqual(C.cleanName('Ren' + RLO + 'ee' + ZW), 'Renee');
  assert.strictEqual(C.cleanName('<b>Kai</b>'), 'Kai');
  assert.strictEqual(C.cleanName('12345'), '');
  assert.strictEqual(C.cleanName('x'.repeat(50)).length, 20);
  for (const bad of ['mail me' + AT + 'x', 'mail' + FW_AT + 'x', 'see https://x.test', 'www.x.test', 'call ' + PHONE, 'ring ' + ch(0x0967).repeat(7), '<script>']) assert.ok(C.refuse(bad), bad);
  for (const ok of ['The Lunch Loop', 'Floor 3 walkers', 'Class of 2026']) assert.strictEqual(C.refuse(ok), '', ok);
  assert.strictEqual(C.cleanTitle('x'.repeat(90)).length, 40);
  assert.strictEqual(C.esc(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  assert.deepStrictEqual([C.dist(2400, 'km'), C.dist(2400, 'mi'), C.dist(780000, 'km'), C.dist(388100, 'km'), C.dist(4700000, 'km'), C.dist(0, 'km')], ['2.4 km', '1.5 mi', '780 km', '388.1 km', '4,700 km', '0 km']);
  assert.strictEqual(C.logText('Priya', { kind: 'walk', unit: 'min', amt: 30 }), 'Priya walked 30 min');
  assert.strictEqual(C.logText('Ines', { kind: 'swim', unit: 'km', amt: 1.5 }), 'Ines swam 1.5 km');
});

test('codes and ids: six characters with no I, O, 0 or 1; typed any way; crew ids 16 base64url characters; keys 22', () => {
  assert.ok(!/[IO01]/.test(C.CODE_ALPHABET) && C.CODE_ALPHABET.length === 32);
  for (let i = 0; i < 200; i++) assert.ok(C.isCode(G.newCode()));
  assert.strictEqual(C.normalizeCode(' lnch-4p '), 'LNCH4P');
  assert.ok(C.isCode('LNCH4P') && !C.isCode('LNCH40') && !C.isCode('LNCH4') && !C.isCode(null));
  assert.ok(C.isGid(G.newCrewId()) && !C.isGid('short') && !C.isGid('a/b/c/d/e/f/g/h/'));
  assert.strictEqual(G.newKey().length, 22);
});

test('a trek on one phone: log for anyone on it, today or six days back; the distance worked out from what was logged; postcards when a checkpoint is passed; 20 logs a day each; take back; add people up to 20; an ended trek takes no logs; nothing changes in place', () => {
  let t = trek(['Mara', 'Dev'], [], 'hadrian');
  const r = C.addLog(t, 'lfirst001', { p: 1, day: DAY0, kind: 'ride', unit: 'km', amt: 45 }, T0, DAY0);
  assert.deepStrictEqual([r.m, r.crossed], [15000, [0]]);
  assert.deepStrictEqual(Object.keys(t.logs), [], 'the trek given is unchanged');
  t = r.trek;
  assert.deepStrictEqual(C.trekDays(t), [{}, { [DAY0]: 15000 }]);
  assert.throws(() => C.addLog(t, 'lnext0001', { p: 0, day: '2026-11-23', kind: 'walk', unit: 'min', amt: 30 }, T0, DAY0), /6 days back/, 'tomorrow');
  assert.throws(() => C.addLog(t, 'lnext0001', { p: 0, day: '2026-11-15', kind: 'walk', unit: 'min', amt: 30 }, T0, DAY0), /6 days back/);
  assert.ok(C.addLog(t, 'lnext0001', { p: 0, day: '2026-11-16', kind: 'walk', unit: 'min', amt: 30 }, T0, DAY0));
  assert.throws(() => C.addLog(t, 'lnext0001', { p: 5, day: DAY0, kind: 'walk', unit: 'min', amt: 30 }, T0, DAY0), /Who/);
  assert.throws(() => C.addLog(t, 'lfirst001', { p: 0, day: DAY0, kind: 'walk', unit: 'min', amt: 30 }, T0, DAY0), /Try again/, 'an id once');
  assert.throws(() => C.addLog(t, 'lnext0001', { p: 0, day: DAY0, kind: 'walk', unit: 'min', amt: 9999 }, T0, DAY0), /Minutes from 1/);
  let many = t;
  for (let i = 0; i < 19; i++) many = C.addLog(many, 'lmany' + String(i).padStart(4, '0'), { p: 1, day: DAY0, kind: 'walk', unit: 'min', amt: 60 }, T0, DAY0).trek;
  assert.throws(() => C.addLog(many, 'lmanyover', { p: 1, day: DAY0, kind: 'walk', unit: 'min', amt: 5 }, T0, DAY0), /20 logs in one day/);
  assert.strictEqual(C.summary(many, DAY0).progress.m, 25000, 'the day is capped at 25 km');
  const u = C.removeLog(t, 'lfirst001', T0 + 5);
  assert.ok(!u.logs.lfirst001 && t.logs.lfirst001 && u.t === T0 + 5);
  let x = C.newTrek({ players: ['Ada'] }, T0, DAY0);
  assert.deepStrictEqual([x.title, x.route, x.players[0].since], ['My trek', 'hadrian', DAY0]);
  assert.throws(() => C.addPerson(x, 'ada', T0, DAY0), /already in/);
  for (let i = 0; i < 19; i++) x = C.addPerson(x, 'P' + 'abcdefghijklmnopqrs'[i], T0, DAY0);
  assert.strictEqual(x.players.length, 20);
  assert.throws(() => C.addPerson(x, 'Zed', T0, DAY0), /20 people/);
  const e = C.endTrek(t, T0 + 50);
  assert.throws(() => C.addLog(e, 'lnext0002', { p: 0, day: DAY0, kind: 'walk', unit: 'min', amt: 30 }, T0, DAY0), (er) => er.code === 'ended');
  assert.strictEqual(C.newTrek({ players: ['123', 'Rosa', 'rosa'] }, T0, DAY0).players.length, 1);
  assert.throws(() => C.renameTrek(t, 'mail ' + AT, T0), /email/);
});

test('the one door: strict refuses anything out of shape, whole; lenient mends and drops; a crew trek keeps days, not logs; the distance is never stored for a solo trek (worked out again from what was logged); bodyProblem finds the first personal string anywhere, keys included', () => {
  const crewTrek = C.trekFromCrew(C.crewView(D.crew(), D.YOU), null, T0);
  const good = { tabc1234: trek(['Mara', 'Dev'], [[0, DAY0, 'walk', 'min', 30], [1, '2026-11-20', 'swim', 'km', 1]]), cabc1234: crewTrek, tgone123: { del: true, t: T0 } };
  assert.deepStrictEqual(C.cleanTreks(good, true), { treks: good, errors: [] });
  const bads = [
    (x) => { x.tabc1234.extra = 1; },
    (x) => { x.tabc1234.logs.ltest0000.p = 7; },
    (x) => { x.tabc1234.logs.ltest0000.amt = 9999; },
    (x) => { x.tabc1234.logs.ltest0000.m = 99999; },
    (x) => { x.tabc1234.logs.ltest0000.kind = 'fly'; },
    (x) => { x.tabc1234.logs.ltest0000.day = '2026-02-30'; },
    (x) => { x.tabc1234.players[0].name = 'M4ra'; },
    (x) => { x.tabc1234.players[0].c = 99; },
    (x) => { x.tabc1234.players[0].since = 'yesterday'; },
    (x) => { x.tabc1234.players = []; },
    (x) => { x.tabc1234.title = '<b>x</b>'; },
    (x) => { x.tabc1234.mode = 'bus'; },
    (x) => { x.tabc1234.route = 'moon'; },
    (x) => { x.tabc1234.days = [{ [DAY0]: 5 }]; },
    (x) => { x.cabc1234.days[0][DAY0] = -5; },
    (x) => { x.cabc1234.days[0]['2026-13-01'] = 5; },
    (x) => { x.cabc1234.logs = x.tabc1234.logs; },
    (x) => { x.tabc1234.t = -1; },
    (x) => { x.tabc1234.leg = 'one'; },
    (x) => { x['../x'] = x.tabc1234; },
  ];
  for (const f of bads) {
    const x = clone(good); f(x);
    const r = C.cleanTreks(x, true);
    assert.ok(r.errors.length && Object.keys(r.treks).length === 0, f.toString());
    const l = C.cleanTreks(x, false);
    Object.values(l.treks).forEach((t) => { if (!t.del) assert.deepStrictEqual(C.cleanTrek(t, true).errors, [], f.toString()); });
  }
  const many = {}; for (let i = 0; i < 101; i++) many['t' + String(i).padStart(6, 'a')] = { del: true, t: i };
  assert.ok(C.cleanTreks(many, true).errors.length);
  assert.strictEqual(Object.keys(C.trimTreks(many)).length, 100);
  assert.strictEqual(C.bodyProblem({ a: { b: ['ok', 'Call ' + PHONE] } }), C.refuse(PHONE));
  assert.ok(C.bodyProblem({ ['x' + AT + 'y']: 1 }), 'keys too');
  assert.strictEqual(C.bodyProblem(good), null);
});

test('two phones: each trek by its own time, a removal is a change, a tie the same from either side; symmetric and idempotent; lifetime adds up every live trek and the routes finished', () => {
  const a = { t1aaaaaa: trek(['Mara'], [[0, DAY0, 'walk', 'km', 5]]), t2aaaaaa: trek(['Dev'], [[0, DAY0, 'run', 'km', 5]]) };
  const b = clone(a);
  b.t1aaaaaa = C.addLog(b.t1aaaaaa, 'lother001', { p: 0, day: DAY0, kind: 'walk', unit: 'km', amt: 2 }, T0 + 99, DAY0).trek;
  b.t3aaaaaa = trek(['Ines'], [[0, DAY0, 'swim', 'km', 1]]);
  a.t2aaaaaa = { del: true, t: T0 + 500 };
  const ab = C.mergeTreks(a, b), ba = C.mergeTreks(b, a);
  assert.deepStrictEqual(ab.treks, ba.treks, 'symmetric');
  assert.deepStrictEqual(C.mergeTreks(ab.treks, ab.treks).treks, ab.treks, 'idempotent');
  assert.strictEqual(ab.pulled, 2);
  assert.ok(ab.treks.t1aaaaaa.logs.lother001 && ab.treks.t2aaaaaa.del && ab.treks.t3aaaaaa);
  const tie1 = { t9aaaaaa: Object.assign(trek(['A']), { title: 'One' }) }, tie2 = { t9aaaaaa: Object.assign(trek(['A']), { title: 'Two' }) };
  assert.deepStrictEqual(C.mergeTreks(tie1, tie2).treks, C.mergeTreks(tie2, tie1).treks);
  const life = C.lifetime(Object.assign({}, ab.treks, D.treks()));
  assert.deepStrictEqual([life.m, life.treks, life.done], [7000 + 4000 + 140000, 3, ['hadrian']]);
  assert.deepStrictEqual(C.live(ab.treks).map((t) => t.id).sort(), ['t1aaaaaa', 't3aaaaaa']);
});

test('a crew as one phone sees it: names, colours, each person’s metres by day and the newest logs - no key hash; members in join order; a crew becomes a trek for the history', () => {
  const doc = D.crew();
  doc.members.mmara.keyHash = 'secret-hash';
  const v = C.crewView(doc, 'mpriya');
  assert.ok(!JSON.stringify(v).includes('secret-hash') && !JSON.stringify(v).includes('keyHash'));
  assert.deepStrictEqual(v.players.map((p) => p.name), ['Mara', 'Dev', 'Priya', 'Tomas', 'Ines']);
  assert.deepStrictEqual([v.you, v.host, v.players[2].you, v.players[0].host], [2, false, true, true]);
  assert.strictEqual(v.feed.length, C.LIMITS.feed);
  assert.ok(v.feed.every((l, i) => !i || v.feed[i - 1].at >= l.at), 'newest first');
  const t = C.trekFromCrew(v, null, T0);
  assert.deepStrictEqual(C.cleanTrek(t, true).errors, []);
  assert.strictEqual(C.summary(t, D.TODAY).progress.m, C.progress(v.route, v.days).m);
});

test('the recap card’s words: title, date, route, the line, the days out and crew streak, four standings and "+N more", the moment; fitText cuts with an ellipsis', () => {
  const v = C.crewView(D.crew(), D.YOU);
  const d = C.recapData(C.trekFromCrew(v, null, T0), D.TODAY, 'km');
  assert.strictEqual(d.date, '22 November 2026');
  assert.strictEqual(d.route, 'Camino Francés');
  assert.strictEqual(d.line, '388.1 km of 780 km · 49%');
  assert.strictEqual(d.sub, '81 days out · 5 people · crew streak 5 weeks');
  assert.deepStrictEqual(d.rows.map((r) => r.name), ['Priya', 'Dev', 'Mara', 'Tomas']);
  assert.strictEqual(d.more, '+1 more');
  assert.strictEqual(d.moment, 'Latest postcard: Old bridges.');
  assert.strictEqual(C.recapData(D.treks().tdemowall1, D.TODAY, 'mi').moment, 'Finished the whole Hadrian’s Wall Path!');
  assert.strictEqual(C.initials('Mary Ann'), 'MA');
  const m = (s) => s.length * 10;
  assert.strictEqual(C.fitText('short', 100, m), 'short');
  assert.strictEqual(C.fitText('a much longer line', 100, m), 'a much lo…');
});

test('the demo’s planted story: five coworkers five weeks into the Camino, 1.9 km short of halfway; Priya leads by showing up, Tomas covered the most ground and is fourth; a 30-minute walk brings the halfway postcard; crew streak 5 weeks; nothing in it out of shape', () => {
  const v = C.crewView(D.crew(), D.YOU);
  const p = C.progress(v.route, v.days);
  assert.deepStrictEqual([p.m, p.next.name, p.next.toGo], [388100, 'Halfway', 1900]);
  const rows = C.standings(v.players, v.days, D.TODAY);
  assert.deepStrictEqual(rows.map((r) => r.name), ['Priya', 'Dev', 'Mara', 'Tomas', 'Ines']);
  assert.strictEqual(C.headline(rows, false), 'Priya leads with 484 points.');
  assert.ok(rows[3].m > Math.max(...rows.filter((r) => r.name !== 'Tomas').map((r) => r.m)), 'Tomas went furthest');
  assert.strictEqual(C.crewStreak(v.players, v.days, D.TODAY), 5);
  const r = D.log(D.crew(), 1, { kind: 'walk', unit: 'min', amt: 30, day: D.TODAY });
  assert.deepStrictEqual([r.m, r.crossed], [2400, [3]]);
  assert.strictEqual(C.routeOf('camino').checkpoints[3].name, 'Halfway');
  const lid = Object.keys(r.doc.logs).find((k) => k.startsWith('lyou'));
  assert.deepStrictEqual(Object.keys(D.unlog(r.doc, lid).logs).length, Object.keys(D.crew().logs).length);
  assert.deepStrictEqual(D.crew(), D.crew(), 'the example is the same every time');
  assert.ok(C.isCode(D.CODE));
  assert.deepStrictEqual(C.cleanTreks(D.treks(), true).errors, []);
  assert.ok(C.dayAllowed(D.TODAY, D.TODAY));
});

test('storage: one module; the treks through the one door; a throwing or missing localStorage falls back to memory; a crew is only ever remembered with its trek; prefs cleaned (unit km or mi)', () => {
  const mem = {};
  const ls = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const s = S.create(ls);
  assert.ok(s.persistent());
  s.putTreks({ tgood123: trek(['Mara'], [[0, DAY0, 'walk', 'km', 5]]) });
  mem[S.KEYS.treks] = JSON.stringify(Object.assign(JSON.parse(mem[S.KEYS.treks]), { 'bad id': {}, tbad1234: { title: '<x>' } }));
  assert.deepStrictEqual(Object.keys(s.getTreks()), ['tgood123', 'tbad1234']);
  assert.ok(!JSON.stringify(s.getTreks()).includes('<x>'));
  s.putNow({ crew: 'AAAAAAAAAAAAAAAA' });
  assert.deepStrictEqual(s.getNow(), {}, 'a crew alone is not kept');
  s.putNow({ crew: 'AAAAAAAAAAAAAAAA', trek: 'cabcdefghij', key: 'x' });
  assert.deepStrictEqual(s.getNow(), { trek: 'cabcdefghij', crew: 'AAAAAAAAAAAAAAAA' });
  s.putPrefs({ name: '<b>Mara</b>', tour: 'yes', unit: 'furlongs', kind: 'fly' });
  assert.deepStrictEqual(s.getPrefs(), { name: 'Mara', tour: false, unit: 'km', kind: 'walk' });
  s.putPrefs({ unit: 'mi', kind: 'swim' });
  assert.deepStrictEqual([s.getPrefs().unit, s.getPrefs().kind], ['mi', 'swim']);
  mem[S.KEYS.sync] = '{not json';
  assert.deepStrictEqual(s.getSync(), { base: null, at: 0 });
  const broken = S.create({ getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); }, removeItem() { throw new Error('no'); } });
  assert.ok(!broken.persistent());
  broken.putTreks({ tgood123: trek(['Mara']) });
  assert.deepStrictEqual(Object.keys(broken.getTreks()), ['tgood123'], 'kept in memory');
  assert.ok(!S.create(null).persistent());
  s.clearAll();
  assert.deepStrictEqual(Object.keys(mem), []);
});

test('every text colour holds 4.5:1 on its surface in both themes; the twelve people’s colours hold white text; the hero; the lab card 20+ in CIE Lab from every card with white text, its emoji on no other card, drop #67; 44px targets; no sideways scroll; reduced motion', () => {
  const css = read('public/app.css');
  const tokens = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));
  const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
  const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));
  const dark = tokens(darkBlock.slice(0, darkBlock.indexOf('}')));
  assert.deepStrictEqual(tokens(css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf(':root[data-theme="dark"]'))), dark, 'both dark blocks agree');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min) => assert.ok(ratio(t[fg], t[bg]) >= (min || 4.5), `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const fg of ['text', 'muted', 'link', 'ink']) for (const bg of ['bg', 'card', 'card2']) ok(fg, bg);
    ok('text', 'accent-soft'); ok('text', 'warn-bg'); ok('text', 'land'); ok('accent-ink', 'accent'); ok('bg', 'text'); ok('muted', 'accent-soft');
    for (const k of ['ok', 'warn', 'bad']) { ok(k, `${k}-bg`); ok(k, 'card'); ok(k, 'bg'); }
    ok('path', 'land', 3); ok('walked', 'land', 3); ok('ink', 'land', 3); // the drawn line and marker: 3:1, graphics
  }
  for (const c of C.COLORS) assert.ok(ratio('#ffffff', c) >= 4.5, `white on ${c}`);
  C.COLORS.forEach((c, i) => assert.ok(css.includes(`.bg${i} { background: ${c}; }`), `colour ${i} in the CSS`));
  for (const bg of ['#1b5e20', '#24672a', '#174a96']) assert.ok(ratio('#ffffff', bg) >= 4.5, `hero white on ${bg}`);
  assert.ok(ratio('#1b5e20', '#ffffff') >= 4.5 && ratio('#ffffff', '#1b5e20') >= 4.5 && ratio('#ffffff', '#174a96') >= 4.5, 'the recap card');
  const LAB = require('../../../lab');
  const lab = LAB.get('trek');
  assert.ok(lab, 'Trek is in lab.js');
  assert.deepStrictEqual([lab.color, lab.color2, lab.dropped, lab.status, lab.emoji, lab.audience], ['#218721', '#2769cc', '2026-11-22', 'testing', '\u{1F97E}', 'Friends, families, coworkers and walking groups']);
  assert.strictEqual(lab.tagline, 'A journey for your whole crew - every walk, run and ride moves you all along the map.');
  assert.ok(ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const other of LAB.APPS.filter((x) => x.slug !== 'trek')) {
    for (const c of [other.color, other.color2]) assert.ok(labDist(lab.color, c) >= 20 && labDist(lab.color2, c) >= 20, `away from ${other.slug} ${c}: ${labDist(lab.color, c).toFixed(1)} / ${labDist(lab.color2, c).toFixed(1)}`);
    assert.notStrictEqual(other.emoji, lab.emoji, `${other.slug} has the same emoji`);
  }
  assert.strictEqual(LAB.APPS.findIndex((x) => x.slug === 'trek') + 1, 67, 'drop #67');
  assert.strictEqual(lab.features.length, 4);
  for (const sel of ['.btn', '.btn.small', '.link-btn', '.input', '.tabbar button']) assert.ok(new RegExp('\\n' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: (4[4-9]|[5-9]\\d)px').test(css), `${sel}: 44px`);
  assert.ok(/\.seg button, \.seg label \{[^}]*min-height: 44px/.test(css) && /\.pc \{[^}]*min-height: 56px/.test(css) && /\.trow \{[^}]*min-height: 64px/.test(css) && /\.rpick \{[^}]*min-height: 44px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css) && /\.tablewrap \{ overflow-x: auto; \}/.test(css));
  assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(css));
});

test('the page: relative links, no inline script or handlers, the banner, the boot with no variation selector; storage only through trek-store.js; no clock or dice in the core or the demo; requests BASE-relative and only to the listed routes; polling only while visible; every received string escaped; the recap shared as a file; no location, GPS, camera or health data', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  assert.ok(html.includes('\u{1F97E}') && !html.includes('\u{1F97E}\u{FE0F}'));
  const js = read('public/app.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(js), 'the page touches no storage itself');
  assert.match(js, /var BASE = new URL\('\.', document\.baseURI\)\.pathname;/);
  assert.match(js, /return fetch\(BASE \+ path, \{/);
  assert.strictEqual((js.match(/fetch\(/g) || []).length, 1, 'one fetch, through api()');
  const routes = new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[1] + ' ' + m[2]));
  for (const r of routes) assert.ok(/^(GET api\/c\/|POST api\/c\/|DELETE api\/c\/|POST api\/crews$|GET api\/join\/|POST api\/join\/|GET api\/me$|GET api\/sync$|PUT api\/sync$|DELETE api\/sync$|POST api\/auth\/)/.test(r), r);
  assert.match(js, /function wantPoll\(\) \{ return Boolean\(state\.now\.crew && !state\.demo && document\.visibilityState === 'visible'/);
  assert.match(js, /if \(document\.visibilityState !== 'visible'\) \{ clearTimeout\(pollTimer\); return; \}/);
  assert.ok(!/setInterval/.test(js), 'no timer runs when nobody is looking');
  for (const f of ['public/trek-core.js', 'public/demo.js']) {
    const src = read(f);
    assert.ok(!/Date\.now|new Date\(\)|Math\.random|crypto\./.test(src), `${f}: no clock or dice`);
  }
  assert.match(js, /t\.textContent = msg;/);
  const marked = js.split('\n').filter((l) => !/^\s*(else )?toast\(|\bsay\(|textContent = /.test(l)).join('\n');
  for (const field of ['.title', '.name', 'pl.name', 'r.name', 'c.name', 'c.card', 'r.from', 'r.to', 'err.message', 'v.code', 'state.prefs.name']) {
    const re = new RegExp("'\\s*\\+\\s*" + field.replace(/\./g, '\\.') + '\\s*\\+\\s*\'', 'g');
    assert.ok(!re.test(marked), `${field} concatenated into markup unescaped`);
  }
  assert.match(js, /new File\(\[recapBlob\], name, \{ type: 'image\/png' \}\)/);
  assert.match(js, /navigator\.share\(\{ files: \[file\]/);
  assert.ok(!/getUserMedia|capture=|type="file"|geolocation|DeviceMotion|HealthKit|watchPosition/i.test(js + html), 'no camera, no location, no health data');
  const sw = read('public/sw.js');
  assert.ok(sw.includes("if (rel.indexOf('api/') === 0) return;") && sw.includes("k.indexOf('trek-') === 0"));
  for (const f of ['trek-core.js', 'trek-store.js', 'demo.js', 'app.js', 'app.css', 'desktop.css', 'passkey-client.js', 'verify-banner.js', 'icon.svg', 'manifest.webmanifest']) assert.ok(sw.includes(`'${f}'`), `${f} kept offline`);
});

test('the copy: no email addresses, phone numbers, model names or session links in any file; neutral words; the shared files are the lab’s copies; CLAUDE.md says it is a rebuild and documents the conversion table, the cap, the points and the 30-day expiry', () => {
  const files = ['server.js', 'lib/crews.js', 'lib/store.js', 'public/app.js', 'public/trek-core.js', 'public/demo.js', 'public/trek-store.js', 'public/index.html', 'public/app.css', 'public/sw.js', 'CLAUDE.md', 'test/run.js'];
  for (const f of files) {
    const s = read(f);
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(s), `${f}: an email address`);
    assert.ok(!/claude-(haiku|sonnet|opus)|claude\.ai\/code/.test(s), `${f}: a model name or session link`);
    assert.ok(!/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/.test(s), `${f}: an invisible character`);
    assert.ok(!new RegExp(['sk', 'ant', ''].join('-') + '|AIza[0-9A-Za-z_-]{20}').test(s), `${f}: a key-shaped string`);
  }
  assert.ok(!/require\('@anthropic-ai\/sdk'\)/.test(read('server.js')), 'no model client at all');
  for (const f of ['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']) assert.strictEqual(read('lib/' + f), fs.readFileSync(path.join(ROOT, '..', 'spotted', 'lib', f), 'utf8'), f);
  for (const f of ['desktop.css', 'passkey-client.js', 'verify-banner.js']) assert.strictEqual(read('public/' + f), fs.readFileSync(path.join(ROOT, '..', 'spotted', 'public', f), 'utf8'), f);
  const sync = fs.readFileSync(path.join(ROOT, '..', '..', '..', 'scripts', 'sync-shared.js'), 'utf8');
  assert.ok(sync.includes("['eriks-projects/challenge/apps/trek/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']]") && sync.includes("['eriks-projects/challenge/apps/trek/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']]"));
  const doc = read('CLAUDE.md');
  assert.match(doc, /a rebuild of the 2026-11-14 drop/i);
  for (const s of ['| walk', '| ride', '| swim', '| roll', '| run', '25 km', '30 days', 'No AI']) assert.ok(doc.includes(s), s);
  const copy = read('public/app.js') + read('public/demo.js') + read('public/trek-core.js');
  assert.ok(!/\b(he|she|his|her|him)\b/.test(copy.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'neutral copy');
});

test('local-only switches throw on Cloud Run; the lab prefix is read; crews found by one field; one history document per account, by its tag', () => {
  for (const [mod, env] of [['./lib/store', { TREK_MEMORY: '1' }], ['./server', { TREK_FAKE_AI: '1', TREK_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, TREK_MEMORY: '', TREK_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, TREK_MEMORY: '', TREK_COLLECTION_PREFIX: 'trek_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'trek_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g))].sort(), ["store.get('crews'", "store.get('treks'", "store.list('crews'", "store.remove('crews'", "store.transact('crews'", "store.transact('treks'", "store.transactKeys('crews'"]);
  assert.ok([...server.matchAll(/where: \[(\[[^\]]*\])\]/g)].every((m) => m[1] === "['code', '==', c]" || m[1] === "['code', '==', code]"), 'single-field equality only: no composite index');
  assert.match(server, /update\('trek owner v1'\)/);
  assert.match(read('lib/crews.js'), /update\(`trek member v1:\$\{key\}:\$\{id\}`\)/);
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
async function startCrew(host, extra) {
  const r = await host('POST', '/api/crews', Object.assign({ name: 'Mara', title: 'The Lunch Loop', route: 'hadrian' }, extra || {}));
  assert.strictEqual(r.status, 200, r.text);
  return { id: r.data.id, code: r.data.crew.code, crew: r.data.crew };
}
async function crewOf(n, extra) {
  const host = client();
  const g = await startCrew(host, extra);
  const members = [];
  for (let i = 0; i < n; i++) {
    const c = client();
    const j = await c('POST', `/api/join/${g.code}`, { name: 'Walker' });
    assert.strictEqual(j.status, 200, j.text);
    members.push(c);
  }
  return { host, members, ...g };
}
const walk = (amt, day) => ({ kind: 'walk', unit: 'min', amt: amt || 30, day: day || todayUtc() });

test('signed out: the page and its files load; the CSP and no-referrer; the app shell for any page path; sync answers 401 before reading a body; no other route takes a location or a photo', async () => {
  const anon = client();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  for (const f of ['trek-core.js', 'trek-store.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  const shell = await page.text();
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/sync'], ['PUT', '/api/sync'], ['DELETE', '/api/sync']]) assert.strictEqual((await anon(m, p, m === 'PUT' ? { data: {} } : undefined)).status, 401, `${m} ${p}`);
  assert.strictEqual((await anon('PUT', '/api/sync', HUGE)).status, 401, 'the gate answers before the parser, so never 413');
  assert.strictEqual((await anon('POST', '/api/crews', HUGE)).status, 413, 'a crew takes 16 KB at most');
  for (const p of ['/api/location', '/api/gps', '/api/import', '/api/ai/log', '/api/treks']) assert.strictEqual((await anon('POST', p, { x: 1 })).status, 404, p);
  for (const p of ['/play', '/treks', '/join/ABC']) assert.strictEqual(await (await fetch(`${base}${p}`)).text(), shell, `${p} is only the app shell`);
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/sync', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
});

test('writes come from this page: another site’s request (Sec-Fetch-Site or Origin) is 403 and a body that is not JSON 415, before anything else', async () => {
  const c = client();
  assert.strictEqual((await c('POST', '/api/crews', { name: 'Mara', route: 'c2c' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await c('POST', '/api/crews', { name: 'Mara', route: 'c2c' }, { 'Sec-Fetch-Site': 'same-site' })).status, 403, 'a sibling subdomain is another site here');
  assert.strictEqual((await c('POST', '/api/join/LNCH4P', { name: 'Mara' }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await c('POST', '/api/crews', 'name=Mara', { 'Content-Type': 'text/plain' })).status, 415);
  assert.strictEqual((await c('DELETE', '/api/c/AAAAAAAAAAAAAAAA', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const same = await c('POST', '/api/crews', { name: 'Mara', route: 'c2c' }, { 'Sec-Fetch-Site': 'same-origin', Origin: base.replace(/\/trek$/, '') });
  assert.strictEqual(same.status, 200, same.text);
});

test('a crew: started with a first name, a route and no account; joined with the code (any case, a dash) and a first name; the key an HttpOnly cookie on the app’s path, stored only as a per-crew hash; a repeated name numbered; the preview shows no other name and no distance', async () => {
  const host = client();
  const r = await host('POST', '/api/crews', { name: '  Mara ', title: 'The Lunch Loop', route: 'camino' });
  assert.strictEqual(r.status, 200);
  const cookie = r.set.find((c) => c.startsWith('trek_k='));
  assert.ok(cookie && /; Path=\/trek\/;/.test(cookie) && /HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie), cookie);
  const key = host.cookies.trek_k;
  assert.strictEqual(key.length, 22);
  const { id, crew } = r.data;
  assert.deepStrictEqual([crew.title, crew.route, crew.host, crew.you, crew.players[0].name, crew.players[0].since], ['The Lunch Loop', 'camino', true, 0, 'Mara', todayUtc()]);
  const doc = await store.get('crews', id);
  assert.strictEqual(doc.members[Object.keys(doc.members)[0]].keyHash, G.keyHash(key, id));
  assert.ok(!JSON.stringify(doc).includes(key), 'the key itself is never stored');
  assert.strictEqual(G.keyHash(key, id), crypto.createHash('sha256').update(`trek member v1:${key}:${id}`).digest('base64url').slice(0, 32));
  const peek = await client()('GET', `/api/join/${crew.code.toLowerCase()}`);
  assert.deepStrictEqual(peek.data, { title: 'The Lunch Loop', route: 'Camino Francés', by: 'Mara', members: 1, full: false, already: null });
  const dev = client();
  const j = await dev('POST', `/api/join/${C.formatCode(crew.code)}`, { name: 'Mara' });
  assert.deepStrictEqual(j.data, { id, isNew: true });
  const again = await dev('POST', `/api/join/${crew.code}`, { name: 'Other' });
  assert.deepStrictEqual(again.data, { id, isNew: false }, 'the same browser joins once');
  const v = (await dev('GET', `/api/c/${id}`)).data.crew;
  assert.deepStrictEqual(v.players.map((p) => [p.name, p.c, p.you]), [['Mara', 0, false], ['Mara 2', 1, true]]);
  assert.ok(!JSON.stringify(v).includes('keyHash'));
  const g2 = await startCrew(host);
  const d2 = await store.get('crews', g2.id);
  assert.notStrictEqual(Object.values(d2.members)[0].keyHash, doc.members[Object.keys(doc.members)[0]].keyHash, 'two crews cannot be linked to one phone');
  assert.strictEqual((await client()('POST', `/api/join/${crew.code}`, { name: '123' })).status, 400);
  assert.strictEqual((await client()('POST', '/api/crews', { name: '', route: 'c2c' })).status, 400);
  assert.strictEqual((await client()('POST', '/api/crews', { name: 'Mara', route: 'moon' })).status, 400);
  assert.strictEqual((await client()('POST', '/api/crews', { name: 'Mara', route: 'c2c', title: 'call ' + PHONE })).status, 400);
});

test('logging: the trail distance is worked out on the server from what was logged (a sent distance is ignored); the crew moves; postcards come back when a checkpoint is passed; a day out of range, a bad kind or amount refused; 20 logs a day each; the daily cap holds for the crew', async () => {
  const c = await crewOf(1);
  const [dev] = c.members;
  const r = await dev('POST', `/api/c/${c.id}/logs`, { kind: 'ride', unit: 'km', amt: 45, day: todayUtc(), m: 999999 });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual([r.data.m, r.data.crossed], [15000, [0]]);
  assert.strictEqual(C.progress(r.data.crew.route, r.data.crew.days).m, 15000);
  assert.strictEqual(r.data.crew.feed[0].m, 15000);
  const doc = await store.get('crews', c.id);
  const log = Object.values(doc.logs)[0];
  assert.deepStrictEqual(Object.keys(log).sort(), ['amt', 'at', 'by', 'day', 'kind', 'm', 'unit']);
  for (const bad of [{ kind: 'fly', unit: 'km', amt: 5 }, { kind: 'walk', unit: 'km', amt: 500 }, { kind: 'walk', unit: 'min', amt: 0 }, { kind: 'walk', unit: 'min', amt: '30; drop' }, { kind: 'walk', unit: 'min', amt: { $gt: 1 } }, { kind: ['walk'], unit: 'min', amt: 30 }]) {
    assert.strictEqual((await dev('POST', `/api/c/${c.id}/logs`, { ...bad, day: todayUtc() })).status, 400, JSON.stringify(bad));
  }
  for (const day of [C.addDays(todayUtc(), 2), C.addDays(todayUtc(), -9), '2026-02-30', 'today', null, 20261122]) assert.strictEqual((await dev('POST', `/api/c/${c.id}/logs`, { ...walk(30), day })).status, 400, String(day));
  assert.strictEqual((await dev('POST', `/api/c/${c.id}/logs`, walk(30, C.addDays(todayUtc(), 1)))).status, 200, 'UTC+14 is already tomorrow');
  assert.strictEqual((await dev('POST', `/api/c/${c.id}/logs`, walk(30, C.addDays(todayUtc(), -7)))).status, 200, 'six back in UTC-12');
  const d = C.addDays(todayUtc(), -2);
  for (let i = 0; i < 20; i++) assert.strictEqual((await c.host('POST', `/api/c/${c.id}/logs`, { kind: 'run', unit: 'km', amt: 10, day: d })).status, 200);
  const over = await c.host('POST', `/api/c/${c.id}/logs`, { kind: 'run', unit: 'km', amt: 10, day: d });
  assert.deepStrictEqual([over.status, over.data.error], [409, '20 logs in one day is the most.']);
  const v = (await c.host('GET', `/api/c/${c.id}`)).data.crew;
  assert.strictEqual(v.days[0][d], 200000, 'what was logged is kept whole');
  assert.strictEqual(C.progress(v.route, v.days).m, 15000 + 2400 * 2 + 25000, 'but the crew moves by the capped day');
});

test('logs from many phones at once never lose distance: twelve phones each logging five times at once - every log lands and the total is the exact sum; without the queue a running total would lose writes', async () => {
  const c = await crewOf(11, { route: 'pct' });
  const all = [c.host, ...c.members];
  // Five logs each, all under the day's cap, so every metre counts.
  const amt = (i, k) => Math.round((i + 1 + k) * 3) / 10;
  const res = await Promise.all(all.flatMap((p, i) => [1, 2, 3, 4, 5].map((k) => p('POST', `/api/c/${c.id}/logs`, { kind: 'walk', unit: 'km', amt: amt(i, k), day: todayUtc() }))));
  assert.ok(res.every((r) => r.status === 200), res.map((r) => r.status).join(','));
  const expect = all.reduce((s, _, i) => s + [1, 2, 3, 4, 5].reduce((t, k) => t + C.toTrail('walk', 'km', amt(i, k)), 0), 0);
  assert.ok(all.every((_, i) => [1, 2, 3, 4, 5].reduce((t, k) => t + C.toTrail('walk', 'km', amt(i, k)), 0) < C.CAP_M), 'under the cap');
  const views = await Promise.all(all.map((p) => p('GET', `/api/c/${c.id}`)));
  views.forEach((v) => { assert.strictEqual(C.progress(v.data.crew.route, v.data.crew.days).m, expect); assert.strictEqual(v.data.crew.logs, 60); });
  assert.strictEqual(Object.keys((await store.get('crews', c.id)).logs).length, 60);
  // A running total kept by read-then-write, without the queue, loses one.
  const id = 'race000000000000';
  await store.set('crews', id, { total: 0 });
  const unsafe = (m) => store._unsafeUpdate('crews', id, (cur) => ({ ...cur, total: cur.total + m }));
  await Promise.all([unsafe(2400), unsafe(4800)]);
  assert.notStrictEqual((await store.get('crews', id)).total, 7200, 'the unqueued second write overwrote the first');
  await store.remove('crews', id);
});

test('finishing and the next leg: the log that reaches the end marks the crew finished; only the host picks the next route, and only once finished (or before anyone logged); the finished leg is kept, the new one starts from zero', async () => {
  const c = await crewOf(1, { route: 'c2c' });
  assert.strictEqual((await c.host('POST', `/api/c/${c.id}/route`, { route: 'hadrian' })).data.crew.route, 'hadrian', 'nobody has logged: the route may change');
  assert.strictEqual((await c.members[0]('POST', `/api/c/${c.id}/route`, { route: 'c2c' })).status, 403);
  await c.host('POST', `/api/c/${c.id}/logs`, walk(30));
  const early = await c.host('POST', `/api/c/${c.id}/route`, { route: 'c2c' });
  assert.deepStrictEqual([early.status, early.data.code], [409, 'not-finished']);
  // 135 km at 25 km a day each: two people, three days.
  let last;
  for (let i = 0; i < 3; i++) for (const p of [c.host, c.members[0]]) last = await p('POST', `/api/c/${c.id}/logs`, { kind: 'run', unit: 'km', amt: 25, day: C.addDays(todayUtc(), -i) });
  assert.ok(last.data.crew.finished, 'finished');
  assert.ok(last.data.crossed.includes(7), 'the last postcard');
  assert.strictEqual((await c.host('POST', `/api/c/${c.id}/route`, { route: 'moon' })).status, 400);
  const next = await c.host('POST', `/api/c/${c.id}/route`, { route: 'camino' });
  assert.strictEqual(next.status, 200, next.text);
  const v = next.data.crew;
  assert.deepStrictEqual([v.route, v.feed.length, v.finished, v.past.length, v.past[0].route], ['camino', 0, '', 1, 'hadrian']);
  assert.ok(v.past[0].m >= 135000);
  assert.strictEqual(C.progress(v.route, v.days).m, 0);
});

test('polling: ?since=v answers {same} for one read when nothing moved; a join or a log moves v', async () => {
  const c = await crewOf(1);
  const v = (await c.host('GET', `/api/c/${c.id}`)).data.crew.v;
  assert.deepStrictEqual((await c.host('GET', `/api/c/${c.id}?since=${v}`)).data, { same: true, v });
  await c.members[0]('POST', `/api/c/${c.id}/logs`, walk());
  const next = await c.host('GET', `/api/c/${c.id}?since=${v}`);
  assert.ok(next.data.crew && next.data.crew.v === v + 1 && next.data.crew.feed.length === 1);
  assert.strictEqual((await c.host('GET', `/api/c/${c.id}?since=abc`)).data.crew.v, v + 1);
});

test('taking a log back: your own any time this leg, never someone else’s; the host anyone’s; the crew moves back', async () => {
  const c = await crewOf(2);
  const [dev, ines] = c.members;
  const r = await dev('POST', `/api/c/${c.id}/logs`, walk(60));
  const lid = r.data.crew.feed[0].id;
  const no = await ines('DELETE', `/api/c/${c.id}/logs/${lid}`);
  assert.deepStrictEqual([no.status, no.data.code], [403, 'not-yours']);
  const own = await dev('DELETE', `/api/c/${c.id}/logs/${lid}`);
  assert.ok(own.status === 200 && own.data.crew.feed.length === 0 && C.progress(own.data.crew.route, own.data.crew.days).m === 0);
  const r2 = await ines('POST', `/api/c/${c.id}/logs`, { kind: 'walk', unit: 'min', amt: 600, day: todayUtc() });
  const hostOk = await c.host('DELETE', `/api/c/${c.id}/logs/${r2.data.crew.feed[0].id}`);
  assert.ok(hostOk.status === 200 && hostOk.data.crew.feed.length === 0);
  assert.strictEqual((await c.host('DELETE', `/api/c/${c.id}/logs/not-an-id!`)).status, 400);
  assert.strictEqual((await c.host('DELETE', `/api/c/${c.id}/logs/lnothere1`)).status, 200, 'already gone is fine');
});

test('leaving and removing: only the host removes or deletes; a member who leaves keeps their distance with the crew and can no longer open it, and rejoins their seat; a removed member’s logs go; the host deletes instead of leaving', async () => {
  const c = await crewOf(3);
  const [dev, ines, kai] = c.members;
  await dev('POST', `/api/c/${c.id}/logs`, walk(30));
  await ines('POST', `/api/c/${c.id}/logs`, walk(60));
  await kai('POST', `/api/c/${c.id}/logs`, walk(90));
  const view = (await c.host('GET', `/api/c/${c.id}`)).data.crew;
  const kaiId = view.players.find((p) => p.name === 'Walker 3').id;
  assert.strictEqual((await dev('DELETE', `/api/c/${c.id}/members/${kaiId}`)).status, 403);
  const kicked = await c.host('DELETE', `/api/c/${c.id}/members/${kaiId}`);
  assert.ok(kicked.status === 200 && kicked.data.crew.players.length === 3 && C.progress(kicked.data.crew.route, kicked.data.crew.days).m === 2400 + 4800);
  assert.strictEqual((await kai('GET', `/api/c/${c.id}`)).status, 404);
  assert.strictEqual((await c.host('DELETE', `/api/c/${c.id}/members/__proto__`)).status, 404);
  assert.strictEqual((await c.host('DELETE', `/api/c/${c.id}/me`)).status, 409, 'the host deletes instead of leaving');
  assert.strictEqual((await ines('DELETE', `/api/c/${c.id}/me`)).status, 200);
  assert.strictEqual((await ines('GET', `/api/c/${c.id}`)).status, 404);
  const after = (await c.host('GET', `/api/c/${c.id}`)).data.crew;
  assert.ok(after.players.find((p) => p.name === 'Walker 2').left, 'their name stays, marked');
  assert.strictEqual(C.progress(after.route, after.days).m, 2400 + 4800, 'and their distance');
  const back = await ines('POST', `/api/join/${c.code}`, { name: 'Ines' });
  assert.strictEqual(back.data.isNew, false, 'rejoining picks their seat back up');
  assert.strictEqual((await dev('DELETE', `/api/c/${c.id}`)).status, 403);
  assert.strictEqual((await c.host('DELETE', `/api/c/${c.id}`)).status, 200);
  assert.strictEqual(await store.get('crews', c.id), null);
});

test('the same 404, word for word, for an unknown id, a malformed one, one not yours and one gone; a crew 30 days idle is deleted by the read that finds it - by id or by code; 29 days is fine; polling alone does not keep it alive', async () => {
  const c = await crewOf(1);
  const stranger = client();
  const texts = new Set();
  for (const [who, p] of [[stranger, '/api/c/AAAAAAAAAAAAAAAA'], [stranger, '/api/c/bad'], [stranger, `/api/c/${c.id}`]]) {
    const r = await who('GET', p);
    assert.strictEqual(r.status, 404); texts.add(r.data.error);
  }
  assert.strictEqual(texts.size, 1);
  for (let i = 0; i < 3; i++) await c.host('GET', `/api/c/${c.id}`);
  const doc = await store.get('crews', c.id);
  assert.ok(Date.now() - Date.parse(doc.updatedAt) < 60000, 'reads did not touch it');
  doc.updatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000 - 1000).toISOString();
  await store.set('crews', c.id, doc);
  const gone = await c.host('GET', `/api/c/${c.id}`);
  assert.strictEqual(gone.status, 404); assert.ok(texts.has(gone.data.error));
  assert.strictEqual(await store.get('crews', c.id), null, 'deleted on read');
  const c2 = await crewOf(0);
  const d2 = await store.get('crews', c2.id);
  d2.updatedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  await store.set('crews', c2.id, d2);
  assert.strictEqual((await client()('GET', `/api/join/${c2.code}`)).status, 404);
  assert.strictEqual(await store.get('crews', c2.id), null);
  const fresh = await crewOf(0);
  const d3 = await store.get('crews', fresh.id);
  d3.updatedAt = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();
  await store.set('crews', fresh.id, d3);
  assert.strictEqual((await fresh.host('GET', `/api/c/${fresh.id}`)).status, 200, 'under 30 days: still there');
  await fresh.host('POST', `/api/c/${fresh.id}/logs`, walk());
  assert.ok(Date.now() - Date.parse((await store.get('crews', fresh.id)).updatedAt) < 60000, 'a log keeps it alive');
});

test('the wrong-code limiter: 30 distinct wrong codes or ids from one address in 15 minutes, then even the right one waits; the same dead id polled over and over counts once; another address is not affected; IPv6 by its /64', async () => {
  const c = await crewOf(0);
  const guesser = client('2001:db8:aaaa:1::1');
  for (let i = 0; i < 40; i++) await guesser('GET', '/api/c/AAAAAAAAAAAAAAAA');
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
  assert.strictEqual((await guesser('GET', `/api/c/${c.id}`)).status, 429);
  assert.strictEqual((await client('2001:db8:bbbb:1::1')('GET', `/api/join/${c.code}`)).status, 200, 'another address is fine');
  misses.clear();
});

test('limits: 20 people a crew (refused, never cut); colours repeat past twelve; 10 new crews an address an hour; 30 new members an address an hour', async () => {
  const c = await crewOf(19);
  const full = await client()('POST', `/api/join/${c.code}`, { name: 'Late' });
  assert.deepStrictEqual([full.status, full.data.error], [409, 'This crew has 20 people - that’s the most one crew can have.']);
  assert.strictEqual((await client()('GET', `/api/join/${c.code}`)).data.full, true);
  const v = (await c.host('GET', `/api/c/${c.id}`)).data.crew;
  assert.deepStrictEqual(v.players.slice(0, 12).map((p) => p.c), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(v.players.every((p) => p.c >= 0 && p.c < 12));
  const one = client('2001:db8:cccc:1::1');
  for (let i = 0; i < 10; i++) assert.strictEqual((await one('POST', '/api/crews', { name: 'Mara', route: 'c2c' })).status, 200);
  assert.strictEqual((await one('POST', '/api/crews', { name: 'Mara', route: 'c2c' })).status, 429);
  const hosts = []; for (let i = 0; i < 4; i++) hosts.push(await startCrew(client()));
  const flood = (i) => client('2001:db8:dddd:1::' + (i + 1).toString(16));
  let ok = 0;
  for (let i = 0; i < 31; i++) { const r = await flood(i)('POST', `/api/join/${hosts[Math.floor(i / 10)].code}`, { name: 'Kid' }); if (r.status === 200) ok++; else assert.strictEqual(r.status, 429); }
  assert.strictEqual(ok, 30);
});

test('hostile input end to end: markup, bidi and zero-width names, a long name, an email or phone as a crew name, prototype keys as a route or kind, a body that is not an object - refused or cleaned, nothing odd stored', async () => {
  const host = client();
  const r = await host('POST', '/api/crews', { name: `<img src=x onerror=alert(1)>Ma${RLO}ra${ZW}`, title: 'Crew', route: 'c2c' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.crew.players[0].name, 'Mara');
  for (const title of ['<b>Crew</b>', 'mail ' + mail('x'), 'call ' + PHONE, 'https://x.test']) assert.strictEqual((await client()('POST', '/api/crews', { name: 'Mara', title, route: 'c2c' })).status, 400, title);
  for (const route of ['__proto__', 'constructor', 'toString', { x: 1 }, ['c2c'], null]) assert.strictEqual((await client()('POST', '/api/crews', { name: 'Mara', route })).status, 400, JSON.stringify(route));
  const long = await client()('POST', `/api/join/${r.data.crew.code}`, { name: 'Bartholomew-Alexander the Third' });
  assert.strictEqual(long.status, 200);
  for (const kind of ['__proto__', 'constructor', 'toString']) assert.strictEqual((await host('POST', `/api/c/${r.data.id}/logs`, { kind, unit: 'min', amt: 30, day: todayUtc() })).status, 400, kind);
  for (const unit of ['__proto__', 'hours']) assert.strictEqual((await host('POST', `/api/c/${r.data.id}/logs`, { kind: 'walk', unit, amt: 30, day: todayUtc() })).status, 400, unit);
  assert.strictEqual((await host('POST', '/api/crews', '[1,2]')).status, 400);
  assert.strictEqual((await host('POST', '/api/crews', '{bad json')).status, 400);
  const dump = JSON.stringify(await store.get('crews', r.data.id));
  assert.ok(!/[<>]|onerror|\u202E|\u200B/.test(dump), dump);
  assert.ok(dump.includes('"Bartholomew-Alexande"'), 'a long name is cut to 20, not refused');
});

test('sync: the trek history follows the account to the other phone; a stale phone gets 409 with the account copy and merges; anything personal or out of shape refused whole; filed under an HMAC of the account id; 120 saves in ten minutes', async () => {
  const a = await register('trek.one');
  assert.deepStrictEqual((await a('GET', '/api/sync')).data, { data: null, updatedAt: null });
  const mine = { twall1234: trek(['Mara', 'Dev'], [[0, DAY0, 'walk', 'min', 30], [1, DAY0, 'ride', 'km', 30]]) };
  const s1 = await a('PUT', '/api/sync', { data: mine, base: null });
  assert.strictEqual(s1.status, 200, s1.text);
  const other = { ...mine, tcoast123: trek(['Ines'], [[0, DAY0, 'swim', 'km', 1]]) };
  const stale = await a('PUT', '/api/sync', { data: other, base: null });
  assert.deepStrictEqual([stale.status, stale.data.code], [409, 'conflict']);
  assert.deepStrictEqual(stale.data.data, mine);
  const merged = C.mergeTreks(other, stale.data.data).treks;
  const s2 = await a('PUT', '/api/sync', { data: merged, base: stale.data.updatedAt });
  assert.strictEqual(s2.status, 200);
  assert.deepStrictEqual(Object.keys((await a('GET', '/api/sync')).data.data).sort(), ['tcoast123', 'twall1234']);
  for (const bad of [
    (x) => { x.twall1234.title = 'Call ' + PHONE; },
    (x) => { x.twall1234.players[0].name = mail('x'); },
    (x) => { x.twall1234.extra = 1; },
    (x) => { x.twall1234.logs.ltest0000.amt = 5000; },
    (x) => { x.twall1234.route = 'moon'; },
  ]) { const x = clone(merged); bad(x); const r = await a('PUT', '/api/sync', { data: x, base: s2.data.updatedAt }); assert.strictEqual(r.status, 400, r.text); }
  assert.strictEqual((await a('PUT', '/api/sync', { data: merged, base: s2.data.updatedAt, more: 1 })).status, 400);
  const me = await a('GET', '/api/auth/me');
  const uid = me.data.user ? me.data.user.id : Buffer.from(mail('trek.one')).toString('base64url');
  const tag = ownerTag(uid, 'local-dev-secret');
  const doc = await store.get('treks', tag);
  assert.ok(doc && doc.owner === tag, 'filed under the HMAC tag');
  assert.ok(!JSON.stringify(doc).includes(AT) && !JSON.stringify(doc).includes(uid));
  assert.strictEqual((await a('DELETE', '/api/sync')).status, 200);
  const removed = await a('PUT', '/api/sync', { data: merged, base: s2.data.updatedAt });
  assert.deepStrictEqual([removed.status, removed.data.code], [409, 'removed']);
  const b = await register('trek.two');
  let last = 0, base2 = null;
  for (let i = 0; i < 121; i++) { const r = await b('PUT', '/api/sync', { data: mine, base: base2 }); last = r.status; if (r.status === 200) base2 = r.data.updatedAt; }
  assert.strictEqual(last, 429);
});

test('a hostile pass leaves nothing identifying in the store: no browser key, no email, no account id, no markup, no location; only crews and trek histories are kept', async () => {
  const dump = store._dump();
  assert.ok(!dump.includes(AT) && !dump.includes('example.com'), 'no email');
  assert.ok(!/[<>]/.test(dump.replace(/\\u003[ce]/gi, '')), 'no markup');
  assert.ok(!/trek_k|"(lat|lng|latitude|longitude|geo|location)"/.test(dump));
  for (const [col, docs] of JSON.parse(dump)) {
    assert.ok(['crews', 'treks'].includes(col), col);
    for (const [, d] of docs) {
      if (col === 'treks') assert.deepStrictEqual(Object.keys(d).sort(), ['owner', 'treks', 'updatedAt']);
      else {
        assert.deepStrictEqual(Object.keys(d).filter((k) => !['id', 'code', 'title', 'route', 'v', 'members', 'logs', 'started', 'finished', 'past', 'createdAt', 'updatedAt'].includes(k)), []);
        for (const m of Object.values(d.members)) assert.deepStrictEqual(Object.keys(m).filter((k) => !['name', 'c', 'keyHash', 'joinedAt', 'since', 'at', 'host', 'left'].includes(k)), []);
      }
    }
  }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/trek', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/trek`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
