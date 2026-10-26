// Pure rules first, then end to end against the memory store and the fake
// model:
//   REP_MEMORY=1 REP_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /rep, the way the
// lab mounts it, so the auth cookie, the budget gate, the sync routes and the
// metered route's parser are exercised as deployed. Model calls are counted
// from the identity's usage rows - the same rows that bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.REP_MEMORY !== '1' || process.env.REP_FAKE_AI !== '1') {
  console.error('run with REP_MEMORY=1 REP_FAKE_AI=1');
  process.exit(1);
}
process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const { app, identityStore, store, fakeClient, ownerTag } = require('../server');
const C = require('../public/rep-core');
const ai = require('../lib/ai');

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
const settle = () => new Promise((r) => setTimeout(r, 15));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const T = '2026-10-26';
const NOW = Date.UTC(2026, 9, 26, 15);
const HOSTILE = ['<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', '\u202eSquat\u202c', 'Be\u2066nch\u2069 <script>x</script>'];
const LIB = (id) => C.exerciseOf(id);
let wid = 0;
/** A workout on a day with one exercise: sets as [kg, reps, rpe?]. */
function wo(day, ex, sets, extra) {
  wid++;
  return C.cleanWorkout({ id: `test${String(wid).padStart(4, '0')}`, day, startedAt: C.dayMs(day) + 18 * 3600000, name: 'Test', entries: [{ id: `ent${wid}x`, ex, goal: extra && extra.goal, sets: sets.map(([w, r, rpe, warm]) => ({ w, r, rpe: rpe || null, warm: Boolean(warm) })) }], ...(extra || {}) });
}

/* ---------------- cleaning ---------------- */

test('typed strings go through one door: no markup, no control or bidi characters, bounded', () => {
  assert.strictEqual(C.cleanText('<b>Leg</b> day\u0007', 40), 'Leg day');
  assert.strictEqual(C.cleanText('<img src=x onerror=alert(1)>', 40), '', 'nothing left of pure markup');
  for (const h of HOSTILE) assert.ok(!/[<>\u202a-\u202e\u2066-\u2069]/.test(C.clean(h, 100)), h);
  assert.strictEqual(Array.from(C.cleanText('🏋️'.repeat(300), 40)).length, 40, 'cut on a whole character');
  assert.strictEqual(C.cleanText('a'.repeat(5e6), 40).length, 40, 'a huge string costs linear time and comes back bounded');
  assert.strictEqual(C.noLinks('Squat at https://evil.example/x or www.evil.example javascript:alert(1) evil.com', 80), 'Squat at or');
  const w = C.cleanWorkout({ id: 'abcd1234', day: T, name: HOSTILE[0] + ' Legs', note: HOSTILE[1] + ' felt good', entries: [{ ex: 'squat', sets: [{ w: 100, r: 5 }] }] });
  assert.strictEqual(w.name, 'Legs');
  assert.ok(!/[<>]/.test(JSON.stringify(w)));
  const x = C.cleanExercise({ id: 'cabcdef1', name: HOSTILE[2] + ' Landmine press', kind: '<script>', group: 'x' });
  assert.deepStrictEqual([x.name, x.kind, x.group], ['Squat Landmine press', 'machine', 'other']);
  assert.strictEqual(C.cleanExercise({ id: 'squat', name: 'Fake' }), null, 'a custom id cannot shadow the library');
  assert.strictEqual(C.cleanExercise({ id: 'c../../x', name: 'Bad' }), null);
});

/* ---------------- units ---------------- */

test('units: stored in kg to 0.1 g, so every kg and lb value (two decimals) comes back exactly; conversions are right', () => {
  for (let v = 0; v <= 700; v += 0.25) {
    for (const u of ['kg', 'lb']) {
      const kg = C.toKg(v, u);
      assert.strictEqual(C.shown(kg, u), Math.round(v * 100) / 100, `${v} ${u} -> ${kg} kg -> ${C.shown(kg, u)}`);
    }
  }
  for (const v of [0.01, 1.11, 33.33, 102.47, 225.55, 999.99]) for (const u of ['kg', 'lb']) assert.strictEqual(C.shown(C.toKg(v, u), u), v, `${v} ${u}`);
  assert.strictEqual(C.toKg(225, 'lb'), 102.0583);
  assert.strictEqual(C.fmtW(C.toKg(225, 'lb'), 'lb'), '225 lb');
  assert.strictEqual(C.fmtW(100, 'lb'), '220.46 lb');
  assert.strictEqual(C.fmtW(82.5, 'kg'), '82.5 kg');
  assert.strictEqual(C.fmtE(107.9166, 'kg'), '107.9 kg');
  assert.strictEqual(C.parseWeight('82,5', 'kg'), 82.5, 'a decimal comma');
  assert.strictEqual(C.parseWeight('185', 'lb'), C.toKg(185, 'lb'));
  for (const bad of ['', '-5', '1e3', 'abc', '80kg', '99999', '1001']) assert.strictEqual(C.parseWeight(bad, 'kg'), null, bad);
  assert.strictEqual(C.parseWeight('2204', 'lb'), C.toKg(2204, 'lb'), 'the kg ceiling, typed in lb');
  assert.strictEqual(C.parseWeight('2205', 'lb'), null);
  assert.strictEqual(C.unitOf('stone'), 'kg');
});

test('e1RM is Epley: w x (1 + reps/30); a single is itself; nothing past 15 reps or at no weight', () => {
  assert.strictEqual(C.e1rm(100, 1), 100);
  assert.strictEqual(C.e1rm(100, 5), 116.6667);
  assert.strictEqual(C.e1rm(100, 10), 133.3333);
  assert.strictEqual(C.e1rm(60, 15), 90);
  assert.strictEqual(C.e1rm(60, 16), null);
  assert.strictEqual(C.e1rm(0, 5), null);
  assert.strictEqual(C.e1rm(100, 0), null);
  assert.strictEqual(C.e1rm(100, 2.5), null);
});

/* ---------------- plates ---------------- */

test('plates: exact loads in kg and lb, heaviest first, and the nearest below and above when a weight cannot be made', () => {
  const kg = C.cleanPlates(null, 'kg');
  const lb = C.cleanPlates(null, 'lb');
  const pm = (t, b, c, u) => C.plateMath(t, b, c, u);
  assert.deepStrictEqual(pm(100, 20, kg, 'kg').perSide, [25, 15]);
  assert.deepStrictEqual(pm(140, 20, kg, 'kg').perSide, [25, 25, 10]);
  assert.deepStrictEqual(pm(82.5, 20, kg, 'kg').perSide, [25, 5, 1.25]);
  assert.deepStrictEqual(pm(60, 15, kg, 'kg').perSide, [20, 2.5], 'a 15 kg bar');
  assert.deepStrictEqual(pm(225, 45, lb, 'lb').perSide, [45, 45]);
  assert.deepStrictEqual(pm(315, 45, lb, 'lb').perSide, [45, 45, 45]);
  assert.deepStrictEqual(pm(135, 45, lb, 'lb').perSide, [45]);
  assert.deepStrictEqual(pm(185, 45, lb, 'lb').perSide, [45, 25]);
  assert.deepStrictEqual(pm(20, 20, kg, 'kg'), { ...pm(20, 20, kg, 'kg'), exact: true, perSide: [], total: 20 }, 'just the bar');
  // Impossible weights
  const k83 = pm(83, 20, kg, 'kg');
  assert.deepStrictEqual([k83.exact, k83.why, k83.below.total, k83.above.total], [false, 'between', 82.5, 85]);
  assert.deepStrictEqual(k83.below.perSide, [25, 5, 1.25]);
  const k824 = pm(82.4, 20, kg, 'kg');
  assert.deepStrictEqual([k824.below.total, k824.above.total], [80, 82.5], 'a weight between two makeable ones, not on a half-plate');
  const l227 = pm(227, 45, lb, 'lb');
  assert.deepStrictEqual([l227.exact, l227.below.total, l227.above.total], [false, 225, 230]);
  const under = pm(15, 20, kg, 'kg');
  assert.deepStrictEqual([under.exact, under.why, under.below, under.above.total], [false, 'under', null, 20]);
  const few = { 20: 1, 10: 1 };
  const heavy = pm(200, 20, few, 'kg');
  assert.deepStrictEqual([heavy.why, heavy.below.total, heavy.above], ['heavy', 80, null], 'more than the plates make');
  assert.deepStrictEqual(pm(50, 20, {}, 'kg').below.total, 20, 'no plates at all: just the bar');
  // A set greedy cannot solve: 15s and 10s only. 60 kg needs 10 + 10 a side, not a 15.
  assert.deepStrictEqual(pm(60, 20, { 15: 2, 10: 2 }, 'kg').perSide, [10, 10]);
  assert.deepStrictEqual(pm(70, 20, { 15: 2, 10: 2 }, 'kg').perSide, [15, 10]);
  // Micro plates
  const micro = { ...kg, 0.25: 2, 0.5: 2 };
  assert.deepStrictEqual(pm(101, 20, micro, 'kg').perSide, [25, 15, 0.5]);
  assert.strictEqual(pm(100.5, 20, micro, 'kg').exact, true);
  assert.strictEqual(pm(100.5, 20, kg, 'kg').exact, false);
  // The counts are respected: two pairs of 25 is all you have.
  assert.deepStrictEqual(pm(140, 20, { 25: 2, 5: 4 }, 'kg').perSide, [25, 25, 5, 5]);
  for (const bad of [-5, NaN, 'x', 6000]) assert.strictEqual(pm(bad, 20, kg, 'kg').why, 'bad');
  assert.strictEqual(C.platesText([20, 10, 2.5]), '20 + 10 + 2.5');
  // Every total the calculator calls exact really is bar + 2 x the plates.
  for (let t = 20; t <= 300; t += 1.25) {
    const r = pm(t, 20, kg, 'kg');
    if (r.exact) assert.strictEqual(Math.round((20 + 2 * r.perSide.reduce((a, b) => a + b, 0)) * 100), Math.round(t * 100), String(t));
    else for (const n of [r.below, r.above].filter(Boolean)) assert.strictEqual(Math.round((20 + 2 * n.perSide.reduce((a, b) => a + b, 0)) * 100), Math.round(n.total * 100));
  }
});

/* ---------------- progression ---------------- */

test('beat last time: add weight when every rep is done, stay on a miss, deload after the third miss in a row', () => {
  const squat = LIB('squat'), bench = LIB('bench'), curl = LIB('db-curl'), press = LIB('leg-press');
  const goal = { sets: 3, reps: 5 };
  const ses = (list, ex) => C.sessionsOf(list, ex.id, ex);
  let s = C.suggest(ses([wo('2026-10-20', 'bench', [[80, 5], [80, 5], [80, 5]])], bench), bench, 'kg');
  assert.deepStrictEqual([s.kind, s.w, s.text], ['up', 82.5, 'Last time 3x5 at 80 kg, all reps done - try 82.5 kg']);
  s = C.suggest(ses([wo('2026-10-20', 'squat', [[100, 5], [100, 5], [100, 5]])], squat), squat, 'kg');
  assert.deepStrictEqual([s.kind, s.w], ['up', 105], 'lower-body barbell lifts jump 5 kg');
  s = C.suggest(ses([wo('2026-10-20', 'squat', [[C.toKg(225, 'lb'), 5]])], squat), squat, 'lb');
  assert.strictEqual(s.text, 'Last time 1x5 at 225 lb, all reps done - try 235 lb', 'and 10 lb');
  s = C.suggest(ses([wo('2026-10-20', 'bench', [[C.toKg(185, 'lb'), 5]])], bench), bench, 'lb');
  assert.strictEqual(C.shown(s.w, 'lb'), 190);
  s = C.suggest(ses([wo('2026-10-20', 'db-curl', [[12.5, 12], [12.5, 12]])], curl), curl, 'kg');
  assert.strictEqual(C.shown(s.w, 'kg'), 15);
  s = C.suggest(ses([wo('2026-10-20', 'leg-press', [[150, 10]])], press), press, 'kg');
  assert.strictEqual(s.w, 155);
  // A history logged in kg, shown to someone now in lb: a weight the bar can make.
  s = C.suggest(ses([wo('2026-10-20', 'bench', [[80, 5], [80, 5]])], bench), bench, 'lb');
  assert.strictEqual(C.shown(s.w, 'lb'), 180, '80 kg is 176.4 lb; +5 is 181.4, and the nearest the bar makes is 180');
  // Misses
  const miss = (day) => wo(day, 'bench', [[80, 5], [80, 5], [80, 4]], { goal });
  s = C.suggest(ses([wo('2026-10-10', 'bench', [[77.5, 5], [77.5, 5], [77.5, 5]], { goal }), miss('2026-10-14')], bench), bench, 'kg');
  assert.deepStrictEqual([s.kind, s.w, s.text], ['stay', 80, 'Missed reps last time (5, 5, 4 at 80 kg) - stay at 80 kg']);
  s = C.suggest(ses([miss('2026-10-14'), miss('2026-10-16')], bench), bench, 'kg');
  assert.deepStrictEqual([s.kind, s.text], ['stay', 'Missed reps twice at 80 kg - stay there; a third miss means a deload']);
  s = C.suggest(ses([miss('2026-10-14'), miss('2026-10-16'), miss('2026-10-18')], bench), bench, 'kg');
  assert.deepStrictEqual([s.kind, s.w, s.text], ['deload', 72.5, 'Third miss in a row at 80 kg - deload to 72.5 kg and build back up']);
  s = C.suggest(ses([miss('2026-10-12'), miss('2026-10-14'), miss('2026-10-16'), miss('2026-10-18')], bench), bench, 'kg');
  assert.match(s.text, /^4 misses in a row at 80 kg - deload to 72\.5 kg/);
  s = C.suggest(ses([wo('2026-10-14', 'bench', [[C.toKg(200, 'lb'), 5], [C.toKg(200, 'lb'), 3]], { goal }), wo('2026-10-16', 'bench', [[C.toKg(200, 'lb'), 4]], { goal }), wo('2026-10-18', 'bench', [[C.toKg(200, 'lb'), 4]], { goal })], bench), bench, 'lb');
  assert.deepStrictEqual([s.kind, C.shown(s.w, 'lb')], ['deload', 180], 'in lb: 200 -> 180');
  s = C.suggest(ses([miss('2026-10-14'), wo('2026-10-16', 'bench', [[82.5, 5], [82.5, 4]], { goal }), miss('2026-10-18')], bench), bench, 'kg');
  assert.deepStrictEqual([s.kind, s.misses], ['stay', 1], 'a miss at another weight breaks the run');
  s = C.suggest(ses([wo('2026-10-18', 'bench', [[80, 5], [80, 5]], { goal })], bench), bench, 'kg');
  assert.deepStrictEqual([s.kind, s.text], ['stay', 'Missed reps last time (2 sets of 3 at 80 kg) - stay at 80 kg'], 'a missed set is a miss');
  s = C.suggest(ses([wo('2026-10-18', 'bench', [[80, 5], [80, 5], [80, 5, 10]], { goal })], bench), bench, 'kg');
  assert.deepStrictEqual([s.kind, s.w], ['repeat', 80], 'every rep, but at RPE 10: repeat it once');
  s = C.suggest(ses([wo('2026-10-18', 'bench', [[60, 8, null, true], [80, 5], [80, 5]])], bench), bench, 'kg');
  assert.strictEqual(s.kind, 'up', 'warm-ups do not count');
  // Bodyweight
  const pull = LIB('pull-up');
  s = C.suggest(ses([wo('2026-10-18', 'pull-up', [[0, 8], [0, 8], [0, 8]], { goal: { sets: 3, reps: 8 } })], pull), pull, 'kg');
  assert.deepStrictEqual([s.kind, s.reps, s.text], ['reps', 9, 'Last time 3x8, all reps done - try 3x9']);
  s = C.suggest(ses([wo('2026-10-18', 'pull-up', [[0, 8], [0, 7], [0, 6]])], pull), pull, 'kg');
  assert.deepStrictEqual([s.kind, s.text], ['stay', 'Missed reps last time (8, 7, 6) - stay at 3x8']);
  s = C.suggest(ses([wo('2026-10-12', 'pull-up', [[0, 8], [0, 7]]), wo('2026-10-14', 'pull-up', [[0, 8], [0, 7]]), wo('2026-10-18', 'pull-up', [[0, 8], [0, 7]])], pull), pull, 'kg');
  assert.strictEqual(s.kind, 'stay', 'no deload of nothing');
  s = C.suggest(ses([wo('2026-10-18', 'pull-up', [[10, 5], [10, 5]])], pull), pull, 'kg');
  assert.deepStrictEqual([s.kind, s.w], ['up', 12.5], 'weighted pull-ups add weight');
  assert.strictEqual(C.suggest([], bench, 'kg').kind, 'first');
  assert.strictEqual(C.scheme({ reps: [5, 5, 5] }), '3x5');
  assert.strictEqual(C.scheme({ reps: [5, 5, 4] }), '5, 5, 4');
});

/* ---------------- PRs ---------------- */

test('PRs: heaviest weight, most reps at a weight, best e1RM and most volume - against everything before, never on a first session', () => {
  const bench = LIB('bench');
  const list = [
    wo('2026-10-01', 'bench', [[80, 5], [80, 5], [80, 5]]),
    wo('2026-10-05', 'bench', [[82.5, 5], [82.5, 5], [82.5, 5]]),
    wo('2026-10-09', 'bench', [[80, 8], [60, 5, null, true]]),
    wo('2026-10-13', 'bench', [[82.5, 5], [82.5, 5], [82.5, 5], [82.5, 5]]),
    wo('2026-10-17', 'bench', [[70, 5]]),
  ];
  const tl = C.timeline(list, 'bench', {}, 'kg');
  assert.deepStrictEqual(tl[0].prs, [], 'nothing to beat on day one');
  assert.deepStrictEqual(tl[1].prs.map((p) => p.type), ['weight', 'e1rm', 'volume']);
  assert.strictEqual(tl[1].prs[0].text, '82.5 kg × 5 (was 80 kg)');
  assert.deepStrictEqual(tl[2].prs.map((p) => p.type), ['reps', 'e1rm'], '80 x 8 beats 80 x 5 and the e1RM; the warm-up counts for nothing');
  assert.strictEqual(tl[2].prs[0].text, '8 reps (was 5)');
  assert.deepStrictEqual(tl[3].prs.map((p) => p.type), ['volume'], 'a fourth set at 82.5: the same reps, more volume');
  assert.deepStrictEqual(tl[4].prs, []);
  // Live, set by set
  const rec = C.recordsOf(C.sessionsOf(list, 'bench', bench), bench);
  assert.deepStrictEqual(C.setPrs(rec, { w: 85, r: 3, warm: false }, bench, 'kg').map((p) => p.type), ['weight']);
  assert.deepStrictEqual(C.setPrs(rec, { w: 85, r: 8, warm: false }, bench, 'kg').map((p) => p.type), ['weight', 'e1rm']);
  assert.deepStrictEqual(C.setPrs(rec, { w: 82.5, r: 6, warm: false }, bench, 'kg').map((p) => p.type), ['reps'], '82.5 x 6 is 99 kg e1RM, under the 101.3 of 80 x 8');
  assert.deepStrictEqual(C.setPrs(rec, { w: 120, r: 5, warm: true }, bench, 'kg'), [], 'a warm-up is never a PR');
  assert.deepStrictEqual(C.setPrs(C.emptyRecords(), { w: 100, r: 5 }, bench, 'kg'), [], 'nor is the first set ever');
  assert.match(C.setPrs(rec, { w: C.toKg(190, 'lb'), r: 5 }, bench, 'lb')[0].text, /^190 lb × 5 \(was 181\.88 lb\)$/, 'in the lifter’s unit');
  // Bodyweight: reps, then added weight
  const pull = LIB('pull-up');
  const pl = C.timeline([wo('2026-10-01', 'pull-up', [[0, 8]]), wo('2026-10-03', 'pull-up', [[0, 10]]), wo('2026-10-05', 'pull-up', [[5, 5]])], 'pull-up', {}, 'kg');
  assert.deepStrictEqual(pl[1].prs.map((p) => [p.type, p.title, p.text]), [['reps', 'Most reps at bodyweight', '10 reps (was 8)'], ['volume', 'Most volume', '10 reps (was 8)']]);
  assert.deepStrictEqual(pl[2].prs.map((p) => p.text), ['+5 kg × 5 (was bodyweight)']);
  // A whole workout
  const w = list[1];
  assert.deepStrictEqual(C.workoutPrs(list, w, {}, 'kg').map((x) => [x.ex, x.prs.length]), [['bench', 3]]);
  assert.deepStrictEqual(C.liftsOf(list, {}), ['bench']);
});

/* ---------------- the rest timer ---------------- */

test('rest timer: worked out from its start time - a locked screen, a skipped tick or a clock change cannot lose it', () => {
  const start = NOW;
  assert.strictEqual(C.restLeft(start, 90, start), 90);
  assert.strictEqual(C.restLeft(start, 90, start + 1), 90, 'rounded up: 89.999 s shows 1:30');
  assert.strictEqual(C.restLeft(start, 90, start + 1000), 89);
  assert.strictEqual(C.restLeft(start, 90, start + 89001), 1);
  assert.strictEqual(C.restLeft(start, 90, start + 90000), 0);
  assert.strictEqual(C.restLeft(start, 90, start + 3600000), 0, 'the phone was locked for an hour');
  assert.strictEqual(C.restLeft(start, 90, start - 600000), 90, 'the clock went back: never more than the rest itself');
  assert.strictEqual(C.restLeft(null, 90, start), 0);
  assert.strictEqual(C.restDone(start, 90, start + 45000), 0.5);
  assert.strictEqual(C.restDone(start, 90, start + 900000), 1);
  let t = { start, secs: 90 };
  assert.strictEqual(C.restAdjust(t, 15, start + 10000).secs, 105);
  assert.strictEqual(C.restAdjust(t, -15, start + 10000).secs, 75);
  assert.strictEqual(C.restAdjust(t, -60, start + 50000).ended, true, 'taking away more than is left ends it');
  assert.strictEqual(C.restAdjust({ start, secs: 890 }, 60, start).secs, C.LIMITS.restMax);
  assert.deepStrictEqual([C.fmtClock(0), C.fmtClock(59.9), C.fmtClock(90), C.fmtClock(725), C.fmtClock(3729)], ['0:00', '0:59', '1:30', '12:05', '1:02:09']);
  assert.strictEqual(C.restOf(LIB('squat'), {}), 180);
  assert.strictEqual(C.restOf(LIB('squat'), { rest: { squat: 240 } }), 240, 'the lifter’s own choice for that lift');
  assert.strictEqual(C.restOf(LIB('squat'), { rest: { squat: 5 } }), 180, 'a silly value is ignored');
  const sw = C.cleanWorkout({ id: 'act00001', day: T, entries: [], rest: { start: NOW, secs: 120, ex: 'squat' } }, { active: true });
  assert.deepStrictEqual(sw.rest, { start: NOW, secs: 120, ex: 'squat', alerted: false }, 'a workout under way keeps its timer across a reload');
});

/* ---------------- weeks, streaks, time zones ---------------- */

test('streaks and the calendar: weeks run Monday to Sunday on civil days, the same in every time zone and across clock changes', () => {
  const day = (d) => wo(d, 'squat', [[100, 5]]);
  // Three a week for three weeks, then this week so far.
  const list = ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', '2026-10-14', '2026-10-16', '2026-10-19', '2026-10-21', '2026-10-24', '2026-10-26'].map(day);
  let s = C.streak(list, '2026-10-26', 3);
  assert.deepStrictEqual([s.current, s.best, s.thisWeek, s.pending, s.left], [3, 3, 1, true, 2], 'this week is still open: the streak stands');
  s = C.streak(list, '2026-10-28', 2);
  assert.deepStrictEqual([s.current, s.pending], [3, true]);
  s = C.streak(list.concat([day('2026-10-27'), day('2026-10-28')]), '2026-10-28', 3);
  assert.deepStrictEqual([s.current, s.pending], [4, false], 'met this week: it counts');
  s = C.streak(list, '2026-11-03', 3);
  assert.deepStrictEqual([s.current, s.best], [0, 3], 'last week missed: broken, the best remembered');
  assert.strictEqual(C.streak(list, '2026-10-26', 1).current, 4);
  assert.strictEqual(C.streak([day('2026-10-30')], '2026-10-26', 1).thisWeek, 0, 'a future-dated workout counts for nothing yet');
  // Weeks across both clock changes: Europe on Oct 25, the US on Nov 1, 2026; the US spring change on Mar 8.
  assert.strictEqual(C.weekStart('2026-10-25'), '2026-10-19');
  assert.strictEqual(C.weekStart('2026-10-26'), '2026-10-26');
  assert.strictEqual(C.weekStart('2026-11-01'), '2026-10-26');
  assert.strictEqual(C.weekStart('2026-03-08'), '2026-03-02');
  assert.strictEqual(C.addDays('2026-10-24', 2), '2026-10-26');
  assert.strictEqual(C.daysBetween('2026-10-24', '2026-11-02'), 9);
  const cal = C.calendar(list, '2026-10-26', 12);
  assert.strictEqual(cal.length, 12);
  assert.strictEqual(cal[11].start, '2026-10-26');
  assert.strictEqual(cal[11].days[0].today, true);
  assert.strictEqual(cal.reduce((n, c) => n + c.days.reduce((m, d) => m + d.n, 0), 0), 10);
  // The same sums in six zones give byte-identical answers; the lifter's own day is the zone's.
  const code = `const C=require('./public/rep-core');const ds=['2026-10-19','2026-10-21','2026-10-24','2026-10-26','2026-11-01','2026-11-02'];
    const list=ds.map((d,i)=>C.cleanWorkout({id:'tz'+String(i).padStart(4,'0'),day:d,entries:[{ex:'squat',sets:[{w:100,r:5}]}]}));
    const late=C.localDay(new Date(Date.UTC(2026,9,26,3,30)));
    console.log(JSON.stringify({s:C.streak(list,'2026-11-02',2),c:C.calendar(list,'2026-11-02',4),g:C.groupWeeks(list,{},'2026-11-02',3),late}));`;
  const outs = {};
  for (const tz of ['UTC', 'America/New_York', 'Europe/London', 'Pacific/Auckland', 'Asia/Kolkata', 'America/Los_Angeles']) {
    const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    outs[tz] = JSON.parse(r.stdout);
  }
  const strip = (o) => JSON.stringify({ s: o.s, c: o.c, g: o.g });
  for (const tz of Object.keys(outs)) assert.strictEqual(strip(outs[tz]), strip(outs.UTC), tz);
  assert.deepStrictEqual([outs.UTC.late, outs['America/New_York'].late, outs['Pacific/Auckland'].late], ['2026-10-26', '2026-10-25', '2026-10-26'], '03:30 UTC is still Sunday night in New York');
  assert.deepStrictEqual([outs.UTC.s.current, outs.UTC.s.thisWeek], [2, 1]);
  const gw = C.groupWeeks([wo('2026-10-26', 'squat', [[100, 5], [100, 5]]), wo('2026-10-26', 'bench', [[80, 5]])], {}, '2026-10-26', 2);
  assert.deepStrictEqual(gw[1].sets, { legs: 2, chest: 1 });
  assert.deepStrictEqual(gw[1].volume, { legs: 1000, chest: 400 });
});

/* ---------------- routines ---------------- */

test('routines: the starters use real library lifts, "up next" alternates, a draft plans every set with the weight to try', () => {
  for (const r of C.STARTER_ROUTINES) for (const x of r.exercises) assert.ok(LIB(x.ex), `${r.id}: ${x.ex}`);
  assert.deepStrictEqual(C.STARTERS.map((s) => s.name), ['Beginner full body', 'Push / Pull / Legs', '5x5 strength']);
  const a = { ...wo('2026-10-20', 'squat', [[100, 5], [100, 5], [100, 5]], { goal: { sets: 3, reps: 5 } }), routineId: 'starter-fb-a' };
  assert.strictEqual(C.nextUp([a], []).id, 'starter-fb-b');
  const b = { ...wo('2026-10-22', 'squat', [[105, 5]]), routineId: 'starter-fb-b' };
  assert.strictEqual(C.nextUp([a, b], []).id, 'starter-fb-a');
  const legs = { ...wo('2026-10-22', 'squat', [[105, 5]]), routineId: 'starter-ppl-legs' };
  assert.strictEqual(C.nextUp([legs], []).id, 'starter-ppl-push', 'Legs wraps round to Push');
  assert.strictEqual(C.nextUp([wo('2026-10-22', 'squat', [[105, 5]])], []), null, 'no routine yet: nothing to suggest');
  const mine = [1, 2].map((wk) => C.cleanRoutine({ id: `myplan-w${wk}`, name: `Week ${wk} · Day A`, program: 'Mine', week: wk, exercises: [{ ex: 'bench', sets: 3, reps: 5, pct: 75 }] }));
  assert.strictEqual(C.nextUp([{ ...b, routineId: 'myplan-w1' }], mine).id, 'myplan-w2');
  const ctx = { workouts: [a], custom: {}, settings: C.defaultSettings('kg'), today: T, nowMs: NOW, id: (p) => `${p}x${Math.floor(Math.random() * 1e8)}` };
  const draft = C.draftWorkout(C.routineById('starter-fb-b', []), ctx);
  const sq = draft.entries.find((e) => e.ex === 'squat');
  assert.deepStrictEqual([sq.goal, sq.sets.length, sq.sets[0].w, sq.sets[0].done], [{ sets: 3, reps: 5 }, 3, 105, false], 'last time 3x5 at 100 - try 105, three sets planned');
  assert.strictEqual(draft.entries.find((e) => e.ex === 'ohp').sets[0].w, null, 'never done: a weight to pick');
  const adhoc = C.draftEntry({ ex: 'bench' }, ctx);
  assert.deepStrictEqual([adhoc.goal, adhoc.sets.length, adhoc.sets[0].r], [null, 3, 5], 'added on the fly: three sets planned, but no goal nobody chose');
  const twoGood = C.cleanWorkout({ id: 'adhoc001', day: T, entries: [{ ...adhoc, sets: [{ w: 60, r: 5, done: true }, { w: 60, r: 5, done: true }, adhoc.sets[2]] }] }, { active: true });
  const saved2 = C.finish(twoGood, NOW);
  assert.strictEqual(C.suggest(C.sessionsOf([saved2], 'bench', LIB('bench')), LIB('bench'), 'kg').kind, 'up', 'two good sets of an ad-hoc lift are not a miss');
  assert.strictEqual(draft.entries.find((e) => e.ex === 'pull-up').sets[0].w, 0, 'bodyweight');
  const pctDraft = C.draftWorkout(mine[0], ctx);
  assert.strictEqual(pctDraft.entries[0].sets[0].w, null, 'a % of an e1RM that does not exist yet stays blank');
  const pctDraft2 = C.draftWorkout(mine[0], { ...ctx, workouts: [wo('2026-10-20', 'bench', [[100, 5]])] });
  assert.strictEqual(pctDraft2.entries[0].sets[0].w, 87.5, '75% of 116.7 kg is 87.5, to what the bar makes');
  assert.strictEqual(C.cleanRoutine({ id: 'starter-fb-a', name: 'Fake', exercises: [{ ex: 'squat', sets: 3, reps: 5 }] }), null, 'nobody can overwrite a starter');
  assert.strictEqual(C.cleanRoutine({ id: 'r1234567', name: 'Nothing', exercises: [{ ex: 'not-a-lift', sets: 3, reps: 5 }] }), null);
  const cr = C.cleanRoutine({ id: 'r1234567', name: 'Odd', exercises: [{ ex: 'squat', sets: 99, reps: 5 }, { ex: 'bench', sets: 3, reps: 5, pct: 300, w: -4 }, { ex: 'cnotmine1', sets: 3, reps: 5 }] }, {});
  assert.deepStrictEqual(cr.exercises.map((x) => [x.ex, x.pct, x.w]), [['bench', null, null]], 'out-of-range or unknown items dropped');
  const fromW = C.routineFromWorkout(wo('2026-10-20', 'bench', [[60, 8, null, true], [80, 5], [80, 5], [80, 5]]), 'rnew0001', NOW);
  assert.deepStrictEqual(fromW.exercises.map((x) => [x.ex, x.sets, x.reps]), [['bench', 3, 5]]);
  const fin = C.finish({ ...draft, entries: [{ ...sq, sets: [{ ...sq.sets[0], done: true, w: 105, r: 5 }, sq.sets[1], sq.sets[2]] }] }, NOW + 3600000);
  assert.deepStrictEqual(fin.entries[0].sets, [{ w: 105, r: 5, rpe: null, warm: false }], 'only logged sets are kept');
  assert.strictEqual(C.finish({ ...draft }, NOW), null, 'nothing logged: nothing saved');
});

/* ---------------- import and export ---------------- */

test('export and import: JSON round trips; CSV is quoted and never a formula; another app’s CSV maps to the library; hostile files are cleaned or refused', () => {
  const custom = { cland00001: C.cleanExercise({ id: 'cland00001', name: 'Landmine press', kind: 'barbell', group: 'shoulders' }) };
  const list = [
    C.cleanWorkout({ id: 'w0000001', day: '2026-10-20', name: '=HYPERLINK("x") day', note: 'ok', entries: [{ ex: 'bench', sets: [{ w: 80, r: 5, rpe: 8 }, { w: 60, r: 8, warm: true }] }, { ex: 'cland00001', sets: [{ w: 30, r: 10 }] }] }, { custom }),
    { ...C.sample(T, NOW, 'kg').workouts[0] },
  ];
  const json = C.exportJson({ workouts: list, routines: [], custom }, 'kg');
  const back = C.importJson(json, { today: T });
  assert.strictEqual(back.workouts.length, 1, 'the sample never leaves');
  assert.deepStrictEqual(back.workouts[0], list[0]);
  assert.deepStrictEqual(Object.keys(back.custom), ['cland00001']);
  assert.throws(() => C.importJson('{nope', {}), /isn’t JSON/);
  assert.throws(() => C.importJson('{"workouts":[]}', {}), /isn’t a Rep export/);
  assert.throws(() => C.importJson('x'.repeat(C.LIMITS.importBytes + 1), {}), (e) => e.status === 413);
  const hostile = JSON.stringify({ app: 'rep', workouts: [{ id: 'w0000002', day: '2026-10-21', name: HOSTILE[0], entries: [{ ex: 'squat', sets: [{ w: 'lots', r: 5 }, { w: 100, r: 5 }] }] }, { id: '../../etc', day: '2026-10-21', entries: [] }, { id: 'w0000003', day: '2099-01-01', entries: [{ ex: 'squat', sets: [{ w: 100, r: 5 }] }] }] });
  const h = C.importJson(hostile, { today: T });
  assert.deepStrictEqual([h.workouts.length, h.skipped, h.workouts[0].name, h.workouts[0].entries[0].sets.length], [1, 2, 'Workout', 1], 'bad ids, future dates and bad sets refused');
  // CSV
  const csv = C.exportCsv(list, custom, 'lb');
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines[0], 'Date,Workout,Exercise,Set,Weight,Unit,Reps,RPE,Warm-up');
  assert.strictEqual(lines[1], `2026-10-20,"'=HYPERLINK(""x"") day",Bench press,1,176.37,lb,5,8,`, 'a leading = is defused, quotes doubled');
  assert.strictEqual(lines.length, 4, 'three sets; the sample left out');
  const again = C.importCsv(csv, { unit: 'kg', today: T, custom });
  assert.deepStrictEqual(again.workouts[0].entries.map((e) => [e.ex, e.sets.map((s) => [C.shown(s.w, 'lb'), s.r, s.rpe, s.warm])]), [['bench', [[176.37, 5, 8, false], [132.28, 8, null, true]]], ['cland00001', [[66.14, 10, null, false]]]], 'our own CSV comes back, the unit column honoured, the custom lift matched by name');
  const twice = C.importCsv(csv, { unit: 'kg', today: T, custom });
  assert.deepStrictEqual(twice.workouts.map((w) => w.id), again.workouts.map((w) => w.id), 'the same file twice: the same ids, so nothing doubles');
  const strong = [
    'Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE',
    '2026-10-01 18:02:11,"Push, heavy",1h,Bench Press (Barbell),1,185,5,0,0,,,8',
    '2026-10-01 18:02:11,"Push, heavy",1h,Bench Press (Barbell),2,185,5,0,0,,,',
    '2026-10-01 18:02:11,"Push, heavy",1h,Overhead Press (Barbell),1,95,8,0,0,,,',
    '2026-10-01 18:02:11,"Push, heavy",1h,Cable Crossover,1,40,12,0,0,,,',
    '2026-10-01 18:02:11,"Push, heavy",1h,Running (Treadmill),1,0,0,5,1800,,,',
    '2026-10-03 07:00:00,Pull,1h,Pull Up,1,0,10,0,0,,,',
    'not a date,Pull,1h,Pull Up,1,0,10,0,0,,,',
  ].join('\n');
  const st = C.importCsv(strong, { unit: 'lb', today: T, custom: {} });
  assert.deepStrictEqual(st.workouts.map((w) => [w.day, w.name, w.entries.map((e) => e.ex)]), [['2026-10-01', 'Push, heavy', ['bench', 'ohp', st.workouts[0].entries[2].ex]], ['2026-10-03', 'Pull', ['pull-up']]]);
  assert.strictEqual(C.shown(st.workouts[0].entries[0].sets[0].w, 'lb'), 185);
  assert.deepStrictEqual(Object.values(st.custom).map((x) => [x.name, x.kind, x.group]), [['Cable Crossover', 'machine', 'other']], 'an unknown lift becomes a custom one');
  assert.strictEqual(st.skipped, 2, 'the treadmill row (no reps) and the row with no date');
  assert.throws(() => C.importCsv('Name,Value\nx,1', {}), /needs Date, Exercise and Reps/);
  assert.throws(() => C.importCsv('Date,Exercise,Reps\n' + 'bad,Squat,5\n'.repeat(3), {}), /No sets could be read/);
  const evil = C.importCsv(`Date,Exercise,Weight,Reps\n2026-10-02,"${HOSTILE[0]}Squat",100,5\n2026-10-02,"<b></b>",100,5\n2026-10-02,Squat,99999,5`, { unit: 'kg', today: T });
  assert.deepStrictEqual([evil.workouts[0].entries.map((e) => e.ex), evil.skipped], [['squat'], 2], 'markup stripped (and then it is a squat); an empty name and an impossible weight refused');
  assert.ok(C.parseCsv('a,"b\nc",d\r\n1,2,3').length === 2 && C.parseCsv('a,"b\nc",d\r\n1,2,3')[0][1] === 'b\nc');
  assert.strictEqual(C.csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.strictEqual(C.csvCell('-2+3'), "'-2+3");
});

/* ---------------- the sample ---------------- */

test('the sample month: made-up workouts before today, a bench PR in the last one, a stalled press that suggests a deload, a four-week streak', () => {
  for (const day of ['2026-10-26', '2026-10-29', '2026-11-01', '2028-02-29', '2026-12-31', '2027-01-01']) {
    for (const unit of ['kg', 'lb']) {
      const s = C.sample(day, NOW, unit).workouts;
      assert.ok(s.length >= 12 && s.length <= 15, `${day}: ${s.length}`);
      assert.ok(s.every((w) => w.sample === true && /^sample-/.test(w.id) && w.day < day && C.cleanWorkout(w, { keepSample: true })), day);
      const last = s[s.length - 1];
      assert.strictEqual(last.name, 'Full body A', day);
      const prs = C.workoutPrs(s, last, {}, unit);
      assert.ok(prs.some((p) => p.ex === 'bench' && p.prs.some((x) => x.type === 'weight')), `${day}: the bench PR`);
      const ohp = C.suggest(C.sessionsOf(s, 'ohp', LIB('ohp')), LIB('ohp'), unit);
      assert.strictEqual(ohp.kind, 'deload', `${day} ${unit}: ${ohp.text}`);
      assert.strictEqual(C.suggest(C.sessionsOf(s, 'squat', LIB('squat')), LIB('squat'), unit).kind, 'up');
      assert.strictEqual(C.nextUp(s, []).id, 'starter-fb-b');
      assert.ok(C.streak(s, day, 3).current >= 4, `${day}: streak ${C.streak(s, day, 3).current}`);
      const tl = C.timeline(s, 'squat', {}, unit);
      assert.ok(tl.every((x, i) => i === 0 || x.topW > tl[i - 1].topW), 'the squat climbs');
    }
  }
  assert.strictEqual(C.suggest(C.sessionsOf(C.sample(T, NOW, 'kg').workouts, 'ohp', LIB('ohp')), LIB('ohp'), 'kg').text, 'Third miss in a row at 40 kg - deload to 35 kg and build back up');
  assert.strictEqual(C.suggest(C.sessionsOf(C.sample(T, NOW, 'lb').workouts, 'ohp', LIB('ohp')), LIB('ohp'), 'lb').text, 'Third miss in a row at 90 lb - deload to 80 lb and build back up');
});

/* ---------------- the AI plan ---------------- */

test('"Plan my next 4 weeks": the brief is only training numbers, and the plan that comes back is bounded, known lifts or named ones, on your equipment', () => {
  const s = C.sample(T, NOW, 'kg').workouts;
  s[0].note = 'Zelda Quixote, knee hurts';
  const b = C.planBrief(s, {}, T, 'kg', { goal: 'strength', days: 3, equipment: ['barbell', 'bodyweight'] });
  assert.deepStrictEqual(Object.keys(b).sort(), ['days', 'equipment', 'goal', 'lifts', 'unit']);
  assert.ok(!/Zelda|knee|sample|2026-/.test(JSON.stringify(b)), 'no notes, no ids, no dates');
  const sq = b.lifts.find((l) => l.ex === 'squat');
  assert.deepStrictEqual([sq.sessions, sq.best, sq.last.done], [12, { w: 92.5, r: 5 }, true]);
  assert.strictEqual(b.lifts.find((l) => l.ex === 'ohp').misses, 3);
  const cb = C.cleanBrief({ ...b, name: 'Zelda', email: 'z@example.com', lifts: b.lifts.concat([{ ex: '<b>Sled</b> push https://x.example', kind: 'nope', sessions: 999, best: { w: -1, r: 999 }, e1rm: 'big' }]) });
  assert.ok(!('name' in cb) && !('email' in cb));
  const sled = cb.lifts[cb.lifts.length - 1];
  assert.deepStrictEqual([sled.ex, sled.custom, sled.kind, sled.sessions, sled.best.w, sled.best.r, sled.e1rm], ['Sled push', true, 'machine', 0, null, null, null]);
  for (const bad of [{}, { goal: 'bulk', days: 3, equipment: ['barbell'] }, { goal: 'size', days: 9, equipment: ['barbell'] }, { goal: 'size', days: 3, equipment: ['kettlebells'] }]) assert.throws(() => C.cleanBrief(bad), (e) => e.status === 400);
  // What the model is told
  const text = ai.describe(cb);
  assert.match(text, /Goal: strength/);
  assert.match(text, /- squat \(barbell\): 12 sessions; best set 92\.5 kg x 5; e1RM 107\.92 kg/);
  assert.match(text, /- ohp \(barbell\):[^\n]*3 misses in a row/);
  assert.ok(!/leg-press|lat-pulldown|db-bench/.test(text.split('\n')[4]), 'only the equipment given (and bodyweight) is allowed');
  // A plan, cleaned
  const raw = {
    summary: 'Build up. https://evil.example',
    days: [
      { name: 'Lower <b>A</b>', exercises: [
        { exercise: 'squat', rest: 180, weeks: [{ sets: 3, reps: 5, pct: 75 }, { sets: 3, reps: 5, pct: 80 }, { sets: 99, reps: 0, pct: 300 }, { sets: 2, reps: 5, pct: 65 }] },
        { exercise: 'Back Squat', rest: 180, weeks: [{ sets: 3, reps: 5 }] },
        { exercise: 'leg-press', rest: 90, weeks: [{ sets: 3, reps: 10, weight: 100 }] },
        { exercise: 'Sled push', rest: 99999, weeks: [{ sets: 3, reps: 10 }] },
        { exercise: 'Bench Press (Barbell)', rest: 5, weeks: [{ sets: 3, reps: 8, weight: 60 }, { sets: 'x' }] },
        { exercise: 'barbell', rest: 60, weeks: [{ sets: 3, reps: 8 }] },
      ] },
      { name: '', exercises: [{ exercise: 'pull-up', rest: 120, weeks: [{ sets: 3, reps: 8 }, { sets: 3, reps: 9 }, { sets: 3, reps: 10 }, { sets: 2, reps: 8 }] }] },
      { name: 'Empty', exercises: [] },
      { name: 'Fourth day nobody asked for', exercises: [{ exercise: 'deadlift', rest: 180, weeks: [{ sets: 1, reps: 5 }] }] },
    ],
  };
  const plan = C.cleanPlan(raw, cb);
  assert.strictEqual(plan.summary, 'Build up.');
  assert.deepStrictEqual(plan.days.map((d) => d.name), ['Lower A', 'Day B'], 'three days asked for; the empty one dropped');
  const d0 = plan.days[0].exercises;
  assert.deepStrictEqual(d0.map((x) => x.ex || x.custom), ['squat', 'Sled push', 'bench'], 'a duplicate squat, a machine on a barbell-only plan and a bare kind word dropped');
  assert.deepStrictEqual(d0[0].weeks[2], { sets: 8, reps: 1, pct: null, w: null }, 'clamped to 1-8 sets and 1-30 reps; a 300% load dropped');
  assert.deepStrictEqual([d0[1].rest, d0[1].kind, d0[2].rest], [600, 'machine', 30], 'rest held to 30 s - 10 min');
  assert.strictEqual(d0[1].weeks.length, 4, 'always four weeks');
  assert.strictEqual(d0[2].weeks[3].w, 60, 'a weight in the lifter’s unit, the last good week carried on');
  assert.throws(() => C.cleanPlan({ days: [] }, cb), (e) => e.status === 422);
  assert.throws(() => C.cleanPlan(null, cb), (e) => e.status === 422);
  let n = 0;
  const out = C.planRoutines(plan, { custom: {}, id: (p) => `${p}plan${String(n++).padStart(4, '0')}`, nowMs: NOW, label: 'My 4-week plan' });
  assert.strictEqual(out.routines.length, 8, 'two days x four weeks');
  assert.deepStrictEqual(out.routines.slice(0, 3).map((r) => r.name), ['Week 1 · Lower A', 'Week 1 · Day B', 'Week 2 · Lower A']);
  assert.deepStrictEqual(Object.values(out.custom).map((x) => x.name), ['Sled push'], 'one custom exercise, made once');
  const saved = out.routines.map((r) => C.cleanRoutine(r, out.custom));
  assert.ok(saved.every(Boolean), 'every routine is valid as saved');
  assert.deepStrictEqual([saved[2].name, saved[2].exercises[0].ex, saved[2].exercises[0].pct], ['Week 2 · Lower A', 'squat', 80], 'each week carries its own prescription');
  assert.strictEqual(C.nextUp([{ ...wo(T, 'squat', [[100, 5]]), routineId: saved[0].id }], saved).id, saved[1].id, 'the plan runs in order');
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
    for (const bg of ['bg', 'card', 'card2']) for (const fg of ['text', 'muted', 'link', 'accent', 'bad', 'good', 'warn', 'pr']) ok(fg, bg);
    ok('accent-ink', 'accent'); ok('link', 'accent-soft'); ok('text', 'accent-soft'); ok('muted', 'accent-soft');
    for (const k of ['good', 'warn', 'bad', 'pr']) { ok(k, `${k}-bg`); ok('text', `${k}-bg`); }
    for (const bg of ['con', 'con2']) { ok('con-ink', bg); ok('con-muted', bg); }
    ok('con-go-ink', 'con-go'); ok('con-good', 'con');
    ok('strip-ink', 'strip'); ok('strip-btn-ink', 'strip-btn');
    ok('text', 'bg'); ok('bg', 'text'); // the toast
  }
  assert.ok(ratio('#ffffff', '#1d4ed8') >= 4.5 && ratio('#ffffff', '#b91c1c') >= 4.5, 'the lab card colours hold white text');
});

test('local-only switches throw on Cloud Run', () => {
  for (const [mod, env] of [['./lib/store', { REP_MEMORY: '1' }], ['./lib/fakeai', { REP_FAKE_AI: '1' }], ['./server', { REP_FAKE_AI: '1', REP_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, REP_MEMORY: '', REP_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured; the one query is a single equality filter, so no composite index', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: ROOT, env: { ...process.env, REP_MEMORY: '', REP_COLLECTION_PREFIX: 'rep_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = read('lib/store.js');
  assert.ok(/REP_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.deepStrictEqual([...new Set(server.match(/store\.list\([^)]*\)/g))], ["store.list('months', { where: [['owner', '==', tag]], limit: 600 })"]);
  assert.ok(!/orderBy/.test(server));
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, no email, the core has no clock, every typed string escaped', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html));
  assert.ok(html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/sessionStorage|indexedDB/.test(js));
  assert.ok(!/<script/i.test(js));
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const core = read('public/rep-core.js');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js + core + read('server.js') + read('CLAUDE.md') + read('lib/ai.js')), 'no email address in the files');
  assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(core), 'the core has no dice and no clock');
  assert.match(js, /prefers-reduced-motion/);
  assert.match(read('public/app.css'), /prefers-reduced-motion: reduce\) \{ \.confetti \{ display: none; \}/);
  // Every interpolation of a string someone typed (or a file or a model wrote) goes through esc().
  const risky = js.split('\n').filter((l) => !/toast\(|say\(|celebrate\(/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(w\.name|a\.name|r\.name|ex\.name|e\.name|d\.name|p\.name|it\.custom|name|pl\.summary|x\.title|x\.text|s\.text|me\.email|w\.note|a\.note|up\.name|up\.program|k\.label|g\.label|p\.label|label)\s*\+/g);
  assert.strictEqual(risky, null, `unescaped: ${risky}`);
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|brief|workout|note|name)/.test(read(f)), `${f} logs a body`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(read('public/sw.js')), 'the service worker never caches the API');
  assert.ok(read('public/sw.js').includes("'rep-core.js'") && !/kindly/i.test(read('public/sw.js')));
  assert.match(js, /not medical advice/i, 'the plain safety line');
});

/* ---------------- over HTTP ---------------- */

async function register(email, ip) {
  const c = client(ip);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const BRIEF = { goal: 'strength', days: 3, equipment: ['barbell', 'dumbbell', 'bodyweight'], unit: 'kg', lifts: [{ ex: 'squat', kind: 'barbell', sessions: 6, best: { w: 100, r: 5 }, e1rm: 116.67, last: { w: 100, sets: 3, reps: 5, done: true }, misses: 0 }, { ex: 'bench', kind: 'barbell', sessions: 6, best: { w: 80, r: 5 }, e1rm: 93.33, last: { w: 80, sets: 3, reps: 5, done: false }, misses: 2 }] };
const WORKOUT = { id: 'wsync0001', day: '2026-10-20', startedAt: Date.UTC(2026, 9, 20, 18), endedAt: Date.UTC(2026, 9, 20, 19), name: 'Legs', note: 'felt strong', entries: [{ id: 'esync0001', ex: 'squat', goal: { sets: 3, reps: 5 }, sets: [{ w: 100, r: 5 }, { w: 100, r: 5 }, { w: 100, r: 5 }] }], updatedAt: 5 };

test('signed out: everything is free and makes no model call; the metered and sync routes answer 401 before reading a big body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  assert.strictEqual((await anon('GET', '/api/meta')).data.library, 43);
  for (const f of ['rep-core.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/plan', BRIEF)).status, 401);
  assert.strictEqual((await anon('POST', '/api/plan', { x: 'x'.repeat(12 * 1024 * 1024) })).status, 401, 'the gate answers before the parser');
  assert.strictEqual((await anon('GET', '/api/log')).status, 401);
  assert.strictEqual((await anon('PUT', '/api/workouts/wsync0001', { workout: WORKOUT })).status, 401);
  assert.strictEqual((await anon('PUT', '/api/workouts/wsync0001', { x: 'x'.repeat(900 * 1024) })).status, 401, 'refused before its parser');
  assert.strictEqual((await anon('POST', '/api/log/merge', { workouts: 'x'.repeat(900 * 1024) })).status, 401, 'refused before its big parser');
  assert.strictEqual((await anon('PUT', '/api/routines/r1234567', { routine: {} })).status, 401);
  assert.strictEqual((await anon('DELETE', '/api/log')).status, 401);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the metered route’s gates come before its parser, in order; one model client in the whole server', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/plan', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  for (const [p, m] of [['/api/log/merge', 'post'], ['/api/workouts/:id', 'put'], ['/api/routines/:id', 'put'], ['/api/exercises/:id', 'put']]) {
    assert.deepStrictEqual(layer(p, m).route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser'], p);
  }
  const src = read('server.js');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one door to one metered call');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
});

test('signed in, the log follows you: one at a time, newer wins on merge, two phones at once, nothing identifying stored', async () => {
  const phoneA = await register('sam.sync@example.com');
  const put = await phoneA('PUT', '/api/workouts/wsync0001', { workout: { ...WORKOUT, sample: true, extra: 'dropped', name: `${HOSTILE[0]}Legs` }, today: T });
  assert.strictEqual(put.status, 200, put.text);
  assert.deepStrictEqual(Object.keys(put.data.workout).sort(), [...C.SAVED_FIELDS].sort(), 'only the workout’s own fields');
  assert.strictEqual(put.data.workout.name, 'Legs');
  assert.strictEqual((await phoneA('PUT', '/api/workouts/sample-w01', { workout: WORKOUT })).status, 400, 'the sample stays on the phone');
  assert.strictEqual((await phoneA('PUT', '/api/workouts/wsync0002', { workout: { ...WORKOUT, entries: [] } })).status, 400);
  assert.strictEqual((await phoneA('PUT', '/api/workouts/wsync0003', { workout: { ...WORKOUT, day: '2099-01-01' } })).status, 400, 'no future dates');
  assert.strictEqual((await phoneA('PUT', '/api/exercises/csled00001', { exercise: { name: 'Sled push', kind: 'machine', group: 'legs' } })).status, 200);
  assert.strictEqual((await phoneA('PUT', '/api/routines/rsync0001', { routine: { name: 'Legs day', exercises: [{ ex: 'squat', sets: 3, reps: 5 }, { ex: 'csled00001', sets: 3, reps: 10 }] } })).status, 200);
  assert.strictEqual((await phoneA('PUT', '/api/routines/starter-fb-a', { routine: { name: 'Hijack', exercises: [{ ex: 'squat', sets: 3, reps: 5 }] } })).status, 400);
  const phoneB = client();
  assert.strictEqual((await phoneB('POST', '/api/auth/login', { email: 'sam.sync@example.com', password: 'a long enough password' })).status, 200);
  const got = await phoneB('GET', '/api/log');
  assert.deepStrictEqual([got.data.workouts.map((w) => w.name), got.data.routines.map((r) => r.name), got.data.exercises.map((e) => e.name)], [['Legs'], ['Legs day'], ['Sled push']]);
  const m = await phoneB('POST', '/api/log/merge', { today: T, workouts: [
    { ...WORKOUT, name: 'Old name', updatedAt: 1 },
    { ...WORKOUT, id: 'wsync0004', day: '2026-09-30', name: 'September', updatedAt: Date.now() },
    { ...WORKOUT, id: 'sample-w02', sample: true },
    { ...WORKOUT, id: 'wsync0005', entries: [] },
  ], routines: [], exercises: [] });
  assert.strictEqual(m.status, 200, m.text);
  assert.deepStrictEqual(m.data.workouts.map((w) => w.name), ['September', 'Legs'], 'the newer copy kept; the sample and the empty one left behind');
  assert.strictEqual(m.data.refused, 1);
  assert.strictEqual((await phoneB('POST', '/api/log/merge', { workouts: Array.from({ length: C.LIMITS.mergeBatch + 1 }, () => WORKOUT) })).status, 400, 'batches are bounded');
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? phoneA : phoneB)('PUT', `/api/workouts/race${String(i).padStart(6, '0')}`, { workout: { ...WORKOUT, name: `Race ${i}` }, today: T })));
  assert.strictEqual((await phoneA('GET', '/api/log')).data.workouts.length, 14, 'twelve at once into one month, none lost');
  assert.strictEqual((await phoneB('DELETE', '/api/workouts/wsync0004?day=2026-09-30')).status, 200);
  assert.strictEqual((await phoneB('DELETE', '/api/workouts/wsync0004?day=2026-09-30')).status, 200, 'deleting twice is fine');
  assert.strictEqual((await phoneB('DELETE', '/api/workouts/wsync0004')).status, 400, 'a delete says which day');
  assert.strictEqual((await phoneA('GET', '/api/log')).data.workouts.length, 13);
  assert.strictEqual((await phoneA('DELETE', '/api/routines/rsync0001')).status, 200);
  assert.deepStrictEqual((await phoneB('GET', '/api/log')).data.routines, []);
  const dump = store._dump();
  assert.ok(!dump.includes('sam.sync') && !dump.includes(uidOf('sam.sync@example.com')), 'filed under an HMAC, never the account id or email');
  assert.ok(dump.includes(ownerTag(uidOf('sam.sync@example.com'), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  assert.ok(dump.includes('"month":"2026-10"') && dump.includes('"month":"2026-09"') === false, 'one document per month; an emptied month is removed');
  const other = await register('kim.other@example.com');
  assert.deepStrictEqual((await other('GET', '/api/log')).data.workouts, [], 'another account sees its own, empty log');
  assert.strictEqual((await phoneA('DELETE', '/api/log')).status, 200);
  const after = (await phoneB('GET', '/api/log')).data;
  assert.deepStrictEqual([after.workouts, after.routines, after.exercises], [[], [], []], 'forgotten from the account');
});

test('plan my next 4 weeks: checked before any spend, one forced tool, cleaned (no links, no markup, bounded), nothing stored, no name or note sent', async () => {
  const me = await register('ana.plans@example.com');
  const dump = store._dump();
  const calls = await modelCalls();
  for (const body of [{}, { goal: 'bulk', days: 3, equipment: ['barbell'] }, { goal: 'size', days: 1, equipment: ['barbell'] }, { goal: 'size', days: 3, equipment: [] }]) assert.strictEqual((await me('POST', '/api/plan', body)).status, 400);
  assert.strictEqual((await me('POST', '/api/plan', { x: 'x'.repeat(20 * 1024) })).status, 413, 'its own 16 KB parser, after the gates');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  fakeClient.seen.length = 0;
  const r = await me('POST', '/api/plan', { ...BRIEF, name: 'Zelda Quixote', email: 'zelda@example.com', note: 'my left knee', today: T });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.data.plan.days.length, 3);
  assert.ok(r.data.plan.days.every((d) => d.exercises.every((x) => x.weeks.length === 4)));
  assert.ok(r.data.plan.days.every((d) => d.exercises.every((x) => !x.ex || ['barbell', 'dumbbell', 'bodyweight'].includes(C.exerciseOf(x.ex).kind))), 'only the equipment given');
  assert.strictEqual(fakeClient.calls[fakeClient.calls.length - 1], 'plan_weeks', 'one forced tool');
  assert.strictEqual(fakeClient.seen.length, 1);
  assert.ok(!/zelda|quixote|example\.com|knee/i.test(fakeClient.seen[0]), 'no name, email or note reaches the model');
  assert.ok(/e1RM 116\.67 kg/.test(fakeClient.seen[0]) && /2 misses in a row/.test(fakeClient.seen[0]));
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const inj = await me('POST', '/api/plan', { ...BRIEF, lifts: BRIEF.lifts.concat([{ ex: 'INJECT', kind: 'machine', sessions: 1 }]) });
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text), 'no markup or bidi');
  assert.ok(!/https?:|www\.|evil|javascript/i.test(inj.text), 'no links from the model, anywhere');
  const p = inj.data.plan;
  assert.ok(p.days.length <= 3 && p.days.every((d) => d.exercises.length <= C.LIMITS.planExercises), 'the days asked for, eight exercises at most');
  const flat = p.days.flatMap((d) => d.exercises);
  assert.ok(flat.every((x) => x.weeks.length === 4 && x.weeks.every((w) => w.sets >= 1 && w.sets <= 8 && w.reps >= 1 && w.reps <= 30 && (w.pct === null || (w.pct >= 30 && w.pct <= 100)) && (w.w === null || w.w >= 0)) && x.rest >= 30 && x.rest <= 600));
  assert.ok(!flat.some((x) => x.ex === 'leg-press'), 'a machine on a plan without machines is dropped');
  assert.ok(!('link' in p) && flat.every((x) => !('note' in x) && !('link' in x)));
  assert.strictEqual((await me('POST', '/api/plan', { ...BRIEF, lifts: [{ ex: 'BLANK', kind: 'machine' }] })).status, 422);
  assert.match((await me('POST', '/api/plan', { ...BRIEF, lifts: [{ ex: 'MAXTOKENS', kind: 'machine' }] })).data.error, /ran long/);
  const up = await me('POST', '/api/plan', { ...BRIEF, lifts: [{ ex: 'UPSTREAM401', kind: 'machine' }] });
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await me('POST', '/api/plan', { ...BRIEF, lifts: [{ ex: 'UPSTREAM529', kind: 'machine' }] });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  assert.strictEqual(store._dump(), dump, 'planning stores nothing');
});

test('the gates: an unconfirmed free account gets verify-email 403, out of credit 402, the day’s free ceiling 503 - never a 413, never a model call', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/plan', BRIEF);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/rep/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/plan', { x: 'x'.repeat(12 * 1024 * 1024) })).status, 403, '403 before the body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('PUT', '/api/workouts/wsync0001', { workout: WORKOUT, today: T })).status, 200, 'syncing needs no AI and no confirmation');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/plan', BRIEF)).status, 402);
  assert.strictEqual((await cal('POST', '/api/plan', { x: 'x'.repeat(12 * 1024 * 1024) })).status, 402, '402, not 413');
  const dan = await register('dan.capped@example.com');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-rep-${day}`, { usd: 5000 });
  try {
    const capped = await dan('POST', '/api/plan', BRIEF);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/plan', { x: 'x'.repeat(12 * 1024 * 1024) })).status, 503, 'the ceiling answers before the parser too');
  } finally { await identityStore.remove('control', `free-spend-rep-${day}`); }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'none of them spent anything');
  assert.strictEqual((await dan('POST', '/api/plan', BRIEF)).status, 200, 'and it lifts when the day’s tally is under it');
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use((req, res, next) => (req.path === '/rep' ? res.redirect(301, '/rep/') : next()));
  host.use('/rep', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/rep`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (e) { failed++; console.log(`  FAIL ${t.name}\n${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
