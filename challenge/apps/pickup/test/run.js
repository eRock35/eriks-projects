// Pure rules first, then end to end against the memory store and the fake
// model:
//   PICKUP_MEMORY=1 PICKUP_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /pickup, the way
// the lab mounts it, so the auth cookie, the budget gate, the member cookie's
// path, per-group rights and the big-body routes are exercised as deployed.
// Model calls are counted from the identity's usage rows - the same rows that
// bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.PICKUP_MEMORY !== '1' || process.env.PICKUP_FAKE_AI !== '1') {
  console.error('run with PICKUP_MEMORY=1 PICKUP_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const C = require('../public/pickup-core');
const S = require('../public/sample');
const QR = require('../public/qr');
const ai = require('../lib/ai');
const G = require('../lib/groups');
const photo = require('../lib/photo');

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
const MARK = 'CHATSHOTBYTESMARKER';
const png = (s = '') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(MARK + s), Buffer.alloc(2000, 7)]).toString('base64');
const BIG = 'A'.repeat(5 * 1024 * 1024);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- a little world for the pure tests ---------------- */

const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-05T16:00:00Z'); // Monday noon in New York
const rand = (n) => require('crypto').randomInt(n);
const host = { mid: 'mhost0001', host: true };
const ctx = (extra) => ({ now: NOW, rand, actor: host, ...(extra || {}) });
const NAMES = ['Host', 'Sam', 'Jo', 'Mia', 'Priya', 'Tom', 'Dev', 'Lena', 'Kai', 'Ravi', 'Ola', 'Ben', 'Chris', 'Nina'];
const mid = (n) => `m${n.toLowerCase().padEnd(8, '0').slice(0, 8)}`;
/** A group with these regulars and this week's game (Thursday 7pm). */
function world(names = NAMES, extra = {}, now = NOW) {
  const g = C.cleanGroup({
    name: 'Test Hoops', sport: 'basketball', tz: TZ,
    sched: { wd: 3, time: '19:00', place: 'Riverside', cap: 10, cost: 6000 },
    members: names.map((n, i) => ({ id: i === 0 ? 'mhost0001' : mid(n), name: n, emoji: C.EMOJI[i % C.EMOJI.length], skill: 3, host: i === 0 })),
    ...extra,
  }, { tz: TZ, rand });
  const e = C.ensureGame(g, now);
  C.applyPatch(g, e.patch);
  return { g, gid: e.gid };
}
const apply = (g, r) => { C.applyPatch(g, r.patch); return r; };
let clock = NOW;
const tick = () => ({ now: (clock += 1000), rand, actor: host });
const answer = (g, gid, who, a) => apply(g, C.rsvp(g, gid, who === 'Host' ? 'mhost0001' : mid(who), a, tick()));
const inNames = (g, gid) => C.lineup(g, g.games[gid]).in.map((e) => e.name);
const waitNames = (g, gid) => C.lineup(g, g.games[gid]).wait.map((e) => e.name);

/* ---------------- cleaning ---------------- */

test('names, answers and money are cleaned through one door', () => {
  assert.strictEqual(C.cleanName('<b>Sam</b>\u202e'), 'Sam');
  assert.strictEqual(C.cleanName('   '), '');
  assert.strictEqual(C.cleanName('x'.repeat(200)).length, C.LIMITS.memberName);
  assert.strictEqual(C.cleanName({ toString: () => 'Sam' }), '');
  assert.deepStrictEqual(C.cleanReply({ name: 'Jo', answer: 'IN', plusOnes: '2' }), { name: 'Jo', answer: 'in', plusOnes: 2 });
  assert.deepStrictEqual(C.cleanReply({ name: 'Jo', answer: 'out', plusOnes: 2 }), { name: 'Jo', answer: 'out', plusOnes: 0 }, 'only someone who is in brings a +1');
  assert.strictEqual(C.cleanReply({ name: 'Jo', answer: 'definitely' }), null);
  assert.strictEqual(C.cleanReply({ name: 'Jo', answer: 'in', plusOnes: 1e9 }).plusOnes, C.LIMITS.plusPerMember);
  assert.deepStrictEqual([C.moneyIn('$60'), C.moneyIn('60.5'), C.moneyIn('6,50'), C.moneyIn('free'), C.moneyIn('-5'), C.moneyIn('99999')], [6000, 6050, 650, null, 500, null]);
  assert.deepStrictEqual([C.fmtMoney(600, 'USD'), C.fmtMoney(650, 'GBP'), C.fmtMoney(1200, 'nope')], ['$6', '£6.50', '$12']);
  assert.deepStrictEqual([C.cleanTime('7:05'), C.cleanTime('24:00'), C.cleanTime('19:00')], ['07:05', null, '19:00']);
  assert.strictEqual(C.cleanTz('Not/AZone'), 'UTC');
  assert.strictEqual(C.cleanTz('America/New_York'), 'America/New_York');
});

test('game times are wall-clock in the group’s zone, across a clock change', () => {
  assert.strictEqual(new Date(C.zonedMs('2026-10-08', '19:00', TZ)).toISOString(), '2026-10-08T23:00:00.000Z');
  assert.strictEqual(new Date(C.zonedMs('2026-12-03', '19:00', TZ)).toISOString(), '2026-12-04T00:00:00.000Z', 'EST in December');
  assert.strictEqual(new Date(C.zonedMs('2026-10-08', '19:00', 'Europe/London')).toISOString(), '2026-10-08T18:00:00.000Z');
  assert.strictEqual(new Date(C.zonedMs('2026-03-08', '02:30', TZ)).toISOString(), '2026-03-08T07:30:00.000Z', 'a skipped hour lands an hour later');
  assert.strictEqual(C.weekday('2026-10-08'), 3, 'Thursday');
  assert.strictEqual(C.onOrAfter('2026-10-05', 3), '2026-10-08');
  assert.strictEqual(C.localDate(Date.parse('2026-10-09T02:00:00Z'), TZ), '2026-10-08', 'still Thursday evening in New York');
  assert.deepStrictEqual([C.timeLabel('19:00'), C.timeLabel('07:30'), C.timeLabel('12:00')], ['7pm', '7:30am', '12pm']);
});

/* ---------------- the week ---------------- */

test('recurring: this week’s game opens on the group’s weekday; the next opens when it is done, regulars not answered yet', () => {
  const { g, gid } = world();
  assert.strictEqual(gid, 'g20261008');
  const game = g.games[gid];
  assert.deepStrictEqual([game.time, game.place, game.cap, game.cost], ['19:00', 'Riverside', 10, 6000]);
  assert.strictEqual(C.ensureGame(g, NOW).patch, null, 'nothing to open while it is on');
  answer(g, gid, 'Sam', 'in');
  const ko = C.kickoff(g, game);
  assert.strictEqual(C.ensureGame(g, ko + 11 * 3600e3).patch, null, 'still this week’s at 6am the morning after');
  const nx = C.ensureGame(g, ko + 12 * 3600e3);
  assert.strictEqual(nx.gid, 'g20261015');
  apply(g, nx);
  const lu = C.lineup(g, g.games.g20261015);
  assert.strictEqual(lu.none.length, NAMES.length, 'everyone starts as not answered yet');
  assert.ok(g.games[gid].rsvps[mid('Sam')], 'last week keeps its answers');
  // Wrapped up early by the host, the next one opens straight away.
  const w2 = world();
  assert.throws(() => C.wrapUp(w2.g, w2.gid, ctx()), /after kickoff/);
  assert.throws(() => C.wrapUp(w2.g, w2.gid, ctx({ now: ko + 1000, actor: { mid: mid('Sam'), host: false } })), /Only the host/);
  apply(w2.g, C.wrapUp(w2.g, w2.gid, ctx({ now: ko + 3600e3 })));
  assert.strictEqual(C.ensureGame(w2.g, ko + 3600e3).gid, 'g20261015');
  // Nobody opened the app for three weeks: the next game is the next one to come, not one in the past.
  assert.strictEqual(C.ensureGame(g, Date.parse('2026-11-01T12:00:00Z')).gid, 'g20261105');
  // The season is kept to LIMITS.keepGames.
  const w3 = world();
  let t = NOW;
  for (let i = 0; i < 40; i++) { t += 7 * 86400e3; apply(w3.g, C.ensureGame(w3.g, t)); }
  assert.strictEqual(C.games(w3.g).length, C.LIMITS.keepGames);
});

test('answers: first come first served, the waitlist, and an Out moves the first waiter up with a line saying so', () => {
  const { g, gid } = world();
  for (const n of NAMES.slice(0, 12)) answer(g, gid, n, 'in');
  assert.deepStrictEqual(inNames(g, gid), NAMES.slice(0, 10));
  assert.deepStrictEqual(waitNames(g, gid), ['Ola', 'Ben']);
  assert.strictEqual(C.headline(C.lineup(g, g.games[gid])), 'Full - 2 waiting');
  const r = answer(g, gid, 'Jo', 'out');
  assert.ok(inNames(g, gid).includes('Ola') && !inNames(g, gid).includes('Jo'));
  assert.match(r.msg, /Ola moves up from the waitlist/);
  assert.deepStrictEqual(Object.values(g.games[gid].log).map(C.logText), ['Ola’s in - Jo dropped out']);
  assert.deepStrictEqual(waitNames(g, gid), ['Ben']);
  // Changing your mind: Jo back in goes to the back of the queue.
  answer(g, gid, 'Jo', 'in');
  assert.deepStrictEqual(waitNames(g, gid), ['Ben', 'Jo']);
  // Saying In again keeps your place.
  const before = g.games[gid].rsvps[mid('Sam')].t;
  answer(g, gid, 'Sam', 'in');
  assert.strictEqual(g.games[gid].rsvps[mid('Sam')].t, before);
  // Maybe takes you out of the queue; the waiter moves up.
  answer(g, gid, 'Mia', 'maybe');
  assert.ok(inNames(g, gid).includes('Ben'));
  assert.strictEqual(C.headline(C.lineup(g, g.games[gid])), 'Full - 1 waiting');
  const w = world();
  for (const n of NAMES.slice(0, 8)) answer(w.g, w.gid, n, 'in');
  assert.strictEqual(C.headline(C.lineup(w.g, w.g.games[w.gid])), '8 in · need 2 more');
  assert.strictEqual(C.headline(C.lineup(world().g, world().g.games.g20261008)), 'Nobody’s in yet');
});

test('+1s: named by who brought them, first come first served like anyone, out with their bringer', () => {
  const { g, gid } = world();
  for (const n of NAMES.slice(0, 9)) answer(g, gid, n, 'in');
  const tom = apply(g, C.addGuest(g, gid, { name: 'Marcus', by: mid('Sam') }, tick()));
  assert.match(tom.msg, /Marcus \(Sam’s \+1\) is in/);
  answer(g, gid, 'Ravi', 'in');
  const late = apply(g, C.addGuest(g, gid, { name: 'Lou', by: mid('Mia') }, tick()));
  assert.match(late.msg, /#2 on the waitlist/);
  assert.deepStrictEqual(waitNames(g, gid), ['Ravi', 'Lou'], 'a +1 added later waits behind a regular who answered first');
  // Sam goes out: Marcus goes with him, and the first two waiters move up.
  const r = answer(g, gid, 'Sam', 'out');
  assert.match(r.msg, /Their \+1 is out too/);
  assert.match(r.msg, /Ravi and Lou move up/);
  assert.deepStrictEqual(Object.values(g.games[gid].log).map(C.logText).sort(), ['Lou’s in - Marcus dropped out', 'Ravi’s in - Sam dropped out']);
  // A member answers for their own +1 only.
  const xid = Object.keys(g.games[gid].guests).find((k) => g.games[gid].guests[k].name === 'Lou');
  assert.throws(() => C.rsvp(g, gid, xid, 'out', ctx({ actor: { mid: mid('Jo'), host: false } })), /yourself and your \+1s/);
  apply(g, C.rsvp(g, gid, xid, 'out', ctx({ now: clock += 1000, actor: { mid: mid('Mia'), host: false } })));
  assert.ok(!g.games[gid].guests[xid]);
  // Limits.
  for (let i = 0; i < C.LIMITS.plusPerMember; i++) apply(g, C.addGuest(g, gid, { name: `G${i}` }, ctx({ now: clock += 1000, actor: { mid: mid('Jo'), host: false } })));
  assert.throws(() => C.addGuest(g, gid, { name: 'One more' }, ctx({ actor: { mid: mid('Jo'), host: false } })), /already has 3 guests/);
  assert.throws(() => C.addGuest(g, gid, { name: '<b></b>' }, tick()), /guest’s name/);
});

test('the cap: a bigger cap moves waiters up, a smaller one moves the latest in down - with lines', () => {
  const { g, gid } = world();
  for (const n of NAMES.slice(0, 12)) answer(g, gid, n, 'in');
  let r = apply(g, C.editGame(g, gid, { cap: 12 }, tick()));
  assert.match(r.msg, /Ola and Ben are in from the waitlist/);
  assert.strictEqual(inNames(g, gid).length, 12);
  r = apply(g, C.editGame(g, gid, { cap: 8 }, tick()));
  assert.match(r.msg, /Lena, Kai, Ravi, Ola and Ben moved to the waitlist|moved to the waitlist/);
  assert.deepStrictEqual(inNames(g, gid), NAMES.slice(0, 8));
  assert.deepStrictEqual(waitNames(g, gid), NAMES.slice(8, 12), 'the latest in go down first, in order');
  assert.ok(Object.values(g.games[gid].log).some((l) => C.logText(l) === 'Ben is on the waitlist - the cap went down'));
  assert.throws(() => C.editGame(g, gid, { cap: 1 }, tick()), /cap from 2/);
  assert.throws(() => C.editGame(g, gid, { cap: 12 }, ctx({ actor: { mid: mid('Sam'), host: false } })), /Only the host/);
  apply(g, C.editGame(g, gid, { time: '20:30', place: '<i>Gym 2</i>', cost: 4500 }, tick()));
  assert.deepStrictEqual([g.games[gid].time, g.games[gid].place, g.games[gid].cost], ['20:30', 'Gym 2', 4500]);
});

test('kickoff closes answers for everyone but the host; you answer for yourself', () => {
  const { g, gid } = world();
  const ko = C.kickoff(g, g.games[gid]);
  const sam = { mid: mid('Sam'), host: false };
  assert.throws(() => C.rsvp(g, gid, mid('Jo'), 'in', ctx({ actor: sam })), /yourself/);
  apply(g, C.rsvp(g, gid, mid('Sam'), 'in', ctx({ actor: sam })));
  assert.throws(() => C.rsvp(g, gid, mid('Sam'), 'out', ctx({ now: ko + 1, actor: sam })), /Kickoff has passed/);
  apply(g, C.rsvp(g, gid, mid('Sam'), 'out', ctx({ now: ko + 1 })));
  assert.throws(() => C.rsvp(g, gid, mid('Sam'), 'yes', ctx()), /In, maybe or out/);
  assert.throws(() => C.rsvp(g, gid, 'mnobody01', 'in', ctx()), /No one by that name/);
  assert.throws(() => C.rsvp(g, 'g20991231', mid('Sam'), 'in', ctx()), /isn’t here/);
});

test('two answers in the same millisecond still have an order: the last spot has one owner', () => {
  const { g, gid } = world();
  for (const n of NAMES.slice(0, 9)) answer(g, gid, n, 'in');
  const at = clock + 5000;
  apply(g, C.rsvp(g, gid, mid('Ravi'), 'in', { now: at, rand, actor: host }));
  const r = apply(g, C.rsvp(g, gid, mid('Ola'), 'in', { now: at, rand, actor: host }));
  assert.deepStrictEqual([C.statusOf(C.lineup(g, g.games[gid]), mid('Ravi')), r.status], ['in', 'wait1']);
});

/* ---------------- fair teams ---------------- */

/** An independent brute force: every labelled split into even sizes. */
function brute(players, sides, lines = [], usePos = false) {
  const N = players.length; const base = Math.floor(N / sides); const extra = N % sides; const maxSize = extra ? base + 1 : base;
  const total = players.reduce((s, p) => s + p.skill, 0);
  let best = null;
  const asg = new Array(N);
  const go = (i) => {
    if (i === N) {
      const sizes = new Array(sides).fill(0); const sums = new Array(sides).fill(0);
      players.forEach((p, k) => { sizes[asg[k]]++; sums[asg[k]] += p.skill; });
      if (sizes.filter((s) => s === base + 1).length !== extra && extra) return;
      if (sizes.some((s) => s < base || s > maxSize)) return;
      const adj = sums.map((s, t) => s * N + (maxSize - sizes[t]) * total);
      const gap = (Math.max(...adj) - Math.min(...adj)) / N;
      const idx = Object.fromEntries(players.map((p, k) => [p.id, k]));
      const broken = lines.filter((l) => (asg[idx[l.a]] === asg[idx[l.b]]) !== (l.k === 'together')).length;
      let pos = 0;
      if (usePos) for (const ps of new Set(players.map((p) => p.pos).filter(Boolean))) { const c = new Array(sides).fill(0); players.forEach((p, k) => { if (p.pos === ps) c[asg[k]]++; }); pos += Math.max(0, Math.max(...c) - Math.min(...c) - 1); }
      const key = [broken, pos, gap];
      if (!best || key[0] < best[0] || (key[0] === best[0] && (key[1] < best[1] || (key[1] === best[1] && key[2] < best[2] - 1e-9)))) best = key;
      return;
    }
    for (let t = 0; t < sides; t++) { asg[i] = t; go(i + 1); }
  };
  go(0);
  return best;
}
const P = (skills, pos = []) => skills.map((s, i) => ({ id: `mp${String(i).padStart(6, '0')}`, skill: s, pos: pos[i] || '' }));
const round1 = (x) => Math.round(x * 10) / 10;

test('fair teams are optimal on small cases, against a brute force', () => {
  let r = 1;
  const rnd = (n) => { r = (r * 48271) % 2147483647; return r % n; };
  for (let trial = 0; trial < 60; trial++) {
    const n = 4 + rnd(7); // 4..10
    const sides = n >= 9 && rnd(2) ? 3 : 2;
    const ps = P(Array.from({ length: n }, () => 1 + rnd(5)), Array.from({ length: n }, () => (rnd(4) === 0 ? 'gk' : '')));
    const lines = rnd(2) ? [{ a: ps[0].id, b: ps[1].id, k: 'apart' }, { a: ps[2].id, b: ps[3].id, k: 'together' }] : [];
    const usePos = Boolean(rnd(2));
    const got = C.balance(ps, { sides, seed: `t${trial}`, lines, usePos });
    const want = brute(ps, sides, lines, usePos);
    assert.ok(got.exact);
    assert.deepStrictEqual([got.broken, got.posOff, round1(got.gap)], [want[0], want[1], round1(want[2])], `trial ${trial}: ${JSON.stringify(ps.map((p) => p.skill))}`);
    assert.strictEqual(got.sides.flat().length, n);
    assert.ok(Math.max(...got.sides.map((s) => s.length)) - Math.min(...got.sides.map((s) => s.length)) <= 1, 'sizes differ by one at most');
  }
});

test('fair teams: positions spread, split/together lines held, last week avoided where it costs nothing', () => {
  const ps = P([3, 3, 3, 3, 3, 3, 3, 3, 3, 3], ['gk', 'gk']);
  const r = C.balance(ps, { sides: 2, seed: 'g1', usePos: true });
  assert.ok(r.sides.every((s) => s.filter((id) => id === ps[0].id || id === ps[1].id).length === 1), 'one keeper each');
  const lines = [{ a: ps[2].id, b: ps[3].id, k: 'apart' }, { a: ps[4].id, b: ps[5].id, k: 'together' }];
  const r2 = C.balance(ps, { sides: 2, seed: 'g1', lines });
  const teamOf = (id) => r2.sides.findIndex((s) => s.includes(id));
  assert.notStrictEqual(teamOf(ps[2].id), teamOf(ps[3].id));
  assert.strictEqual(teamOf(ps[4].id), teamOf(ps[5].id));
  // Last week's exact teams are not repeated when another split is as even.
  const last = r2.sides;
  const r3 = C.balance(ps, { sides: 2, seed: 'g1', lines, last });
  assert.notStrictEqual(r3.key, r2.key);
  assert.strictEqual(r3.gap, r2.gap);
  assert.strictEqual(r3.same, false);
  // ...but balance comes first: the only even split is used even if it repeats.
  const lop = P([5, 4, 2, 1]);
  const even = C.balance(lop, { sides: 2, seed: 'x' });
  const again = C.balance(lop, { sides: 2, seed: 'x', last: even.sides });
  assert.strictEqual(again.gap, 0);
  assert.strictEqual(again.same, true);
  // An impossible line is broken, and says so.
  const three = P([3, 3, 3, 3]);
  const imp = C.balance(three, { sides: 2, seed: 's', lines: [{ a: three[0].id, b: three[1].id, k: 'together' }, { a: three[0].id, b: three[2].id, k: 'together' }, { a: three[0].id, b: three[3].id, k: 'together' }] });
  assert.ok(imp.broken >= 1);
});

test('fair teams: deterministic, a reshuffle gives a different split, and big games stay quick', () => {
  const ps = P([5, 5, 4, 4, 3, 3, 3, 2, 2, 1]);
  const a = C.balance(ps, { sides: 2, seed: 'g20261008' });
  const b = C.balance(ps.slice().reverse(), { sides: 2, seed: 'g20261008' });
  assert.deepStrictEqual(a.sides, b.sides, 'the same however the list is ordered');
  const keys = new Set();
  let prevScore = -1;
  for (let n = 0; n < 6; n++) {
    const r = C.balance(ps, { sides: 2, seed: 'g20261008', n });
    keys.add(r.key);
    assert.ok(r.score >= prevScore, 'each reshuffle is the next-best, never better than the one before');
    prevScore = r.score;
  }
  assert.strictEqual(keys.size, 6, 'six reshuffles, six different splits');
  assert.notStrictEqual(C.balance(ps, { sides: 2, seed: 'g20261015' }).key === a.key && C.balance(ps, { sides: 2, seed: 'g20261022' }).key === a.key, true, 'equal splits vary week to week');
  // Only so many splits exist: reshuffling past them goes round again.
  const four = P([3, 3, 3, 3]);
  assert.strictEqual(C.balance(four, { sides: 2, seed: 's', n: 3 }).key, C.balance(four, { sides: 2, seed: 's', n: 0 }).key);
  // Forty players in four teams: the bounded search, fast, even and different on reshuffle.
  const forty = P(Array.from({ length: 40 }, (_, i) => 1 + ((i * 7) % 5)));
  const t0 = Date.now();
  const big = C.balance(forty, { sides: 4, seed: 'x' });
  const big2 = C.balance(forty, { sides: 4, seed: 'x', n: 2 });
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
  assert.strictEqual(big.exact, false);
  assert.ok(big.gap <= 1, `gap ${big.gap}`);
  assert.deepStrictEqual(big.sides.map((s) => s.length), [10, 10, 10, 10]);
  assert.notStrictEqual(big2.key, big.key);
  assert.deepStrictEqual(C.balance(forty, { sides: 4, seed: 'x' }).sides, big.sides, 'the search is deterministic too');
  assert.deepStrictEqual([C.gapText(0), C.gapText(0.4), C.gapText(1), C.gapText(2.5)], ['Dead even on skill', 'Within 1 point', 'Within 1 point', '2.5 points apart']);
  assert.deepStrictEqual([C.suggestSides(10, 5), C.suggestSides(15, 5), C.suggestSides(20, 5), C.suggestSides(8, 2)], [2, 3, 4, 4]);
});

test('makeTeams on a game: the host only, from whoever is In (skill adjusted quietly, +1s at theirs), stale when the line-up moves', () => {
  const { g, gid } = world();
  g.members.find((m) => m.name === 'Sam').skill = 5;
  g.members.find((m) => m.name === 'Dev').adj = 1; // says 5, plays like 1
  g.members.find((m) => m.name === 'Dev').skill = 5;
  for (const n of NAMES.slice(0, 9)) answer(g, gid, n, 'in');
  apply(g, C.addGuest(g, gid, { name: 'Marcus', by: mid('Sam'), skill: 5 }, tick()));
  assert.throws(() => C.makeTeams(g, gid, { sides: 2 }, ctx({ actor: { mid: mid('Sam'), host: false } })), /host makes the teams/);
  const r = apply(g, C.makeTeams(g, gid, { sides: 2 }, tick()));
  const t = g.games[gid].teams;
  assert.strictEqual(t.sides.flat().length, 10);
  assert.ok(t.sides.flat().some((id) => C.isGuestId(id)), 'the +1 plays');
  assert.strictEqual(C.playersFor(g, g.games[gid]).find((p) => p.id === mid('Dev')).skill, 1, 'the host’s number counts');
  assert.match(r.msg, /Teams made/);
  assert.strictEqual(C.teamsStale(g, g.games[gid]), false);
  answer(g, gid, 'Ravi', 'in'); // on the waitlist: the teams still stand
  assert.strictEqual(C.teamsStale(g, g.games[gid]), false);
  answer(g, gid, 'Jo', 'out');
  assert.strictEqual(C.teamsStale(g, g.games[gid]), true, 'Ravi is in, Jo is out');
  const sums = C.teamSums(g, g.games[gid]);
  assert.strictEqual(sums.length, 2);
  const re = apply(g, C.makeTeams(g, gid, { sides: 2, n: 1 }, tick()));
  assert.match(re.msg, /Reshuffled/);
  assert.throws(() => C.makeTeams(world().g, 'g20261008', { sides: 2 }, tick()), /at least 4 in/);
  assert.match(C.teamsText(g, g.games[gid]), /^Test Hoops - teams for Thu 8 Oct\nOrange: .*\nWhite: /);
});

test('winner stays on for three or four teams; two teams just play', () => {
  assert.deepStrictEqual(C.rotation(2, [{ a: 0, b: 1, w: 'a' }]).on, [0, 1]);
  let r = C.rotation(3, []);
  assert.deepStrictEqual([r.on, r.queue], [[0, 1], [2]]);
  r = C.rotation(3, [{ a: 0, b: 1, w: 'a' }]);
  assert.deepStrictEqual([r.on, r.queue, r.streak], [[0, 2], [1], { team: 0, wins: 1 }]);
  r = C.rotation(3, [{ a: 0, b: 1, w: 'a' }, { a: 0, b: 2, w: 'a' }]);
  assert.deepStrictEqual([r.on, r.queue], [[1, 2], [0]], 'two wins and off - everyone plays');
  r = C.rotation(4, [{ a: 0, b: 1, w: 'b' }, { a: 1, b: 2, w: 'd' }]);
  assert.deepStrictEqual([r.on, r.queue], [[3, 0], [1, 2]], 'a draw sends both off, the one on longer first');
});

/* ---------------- results, the season, Player of the Week ---------------- */

function playedWeek(g, gid, names, results) {
  for (const n of names) answer(g, gid, n, 'in');
  apply(g, C.makeTeams(g, gid, { sides: 2 }, tick()));
  const ko = C.kickoff(g, g.games[gid]);
  for (const [a, b, sa, sb] of results) apply(g, C.addMatch(g, gid, { a, b, sa, sb }, ctx({ now: ko + 1000 })));
  return ko;
}

test('results: a score or just who won; standings, win %, streaks and attendance over the season', () => {
  const { g, gid } = world();
  const ko = playedWeek(g, gid, NAMES.slice(0, 10), [[0, 1, 11, 8], [0, 1, 7, 11]]);
  const game = g.games[gid];
  assert.throws(() => C.addMatch(g, gid, { a: 0, b: 0, sa: 1, sb: 2 }, tick()), /two teams/);
  assert.throws(() => C.addMatch(g, gid, { a: 0, b: 1, sa: 3 }, tick()), /both scores/);
  assert.throws(() => C.addMatch(g, gid, { a: 0, b: 1, sa: -1, sb: 3 }, tick()), /0 to 999/);
  assert.throws(() => C.addMatch(g, gid, { a: 0, b: 1, w: 'x' }, tick()), /Who won/);
  const w = apply(g, C.addMatch(g, gid, { a: 0, b: 1, w: 'a' }, ctx({ now: ko + 5000 })));
  assert.match(w.msg, /^Orange beat White\.$/);
  const d = apply(g, C.addMatch(g, gid, { a: 0, b: 1, sa: 9, sb: 9 }, ctx({ now: ko + 6000 })));
  assert.match(d.msg, /drew 9-9/);
  assert.throws(() => C.removeMatch(g, gid, d.id, ctx({ actor: { mid: mid('Nina'), host: false } })), /Only the host or whoever entered it/);
  apply(g, C.removeMatch(g, gid, d.id, tick()));
  // Next week, Orange's players win again.
  const nx = C.ensureGame(g, ko + 13 * 3600e3); apply(g, nx);
  const orange = game.teams.sides[0].map((id) => C.nameOf(g, game, id));
  const ko2 = playedWeek(g, nx.gid, NAMES.slice(0, 10), [[0, 1, 11, 2]]);
  const st = C.standings(g, ko2 + 3600e3);
  assert.strictEqual(st.games, 2);
  const sam = st.rows.find((x) => x.name === 'Sam');
  assert.strictEqual(sam.games, 2);
  assert.strictEqual(sam.matches, 4);
  assert.strictEqual(sam.w + sam.l + sam.d, 4);
  assert.strictEqual(sam.pct, Math.round((100 * sam.w) / 4));
  const ben = st.rows.find((x) => x.name === 'Ben');
  assert.deepStrictEqual([ben.games, ben.came, ben.of, ben.pct], [0, 0, 2, null]);
  assert.ok(orange.length === 5);
  const top = st.rows[0];
  assert.ok(st.rows.every((r) => r.w <= top.w), 'sorted by wins');
  assert.deepStrictEqual([C.streakText({ r: 'W', n: 3 }), C.streakText({ r: 'W', n: 1 }), C.streakText({ r: 'L', n: 2 })], ['🔥 3 wins in a row', '', '2 losses in a row']);
  // Who played: the host can tick a no-show off.
  apply(g, C.setPlayed(g, nx.gid, C.playedIds(g, g.games[nx.gid]).filter((id) => id !== mid('Sam')), tick()));
  assert.strictEqual(C.standings(g, ko2 + 3600e3).rows.find((x) => x.name === 'Sam').games, 1);
  assert.throws(() => C.setPlayed(g, nx.gid, [], ctx({ actor: { mid: mid('Sam'), host: false } })), /Only the host/);
});

test('Player of the Week: one vote per regular who played, never for yourself, secret until it closes', () => {
  const { g, gid } = world();
  const ko = playedWeek(g, gid, NAMES.slice(0, 10), [[0, 1, 11, 9]]);
  const as = (n, extra) => ctx({ now: ko + 3600e3, actor: { mid: mid(n), host: false, online: true }, ...(extra || {}) });
  assert.throws(() => C.vote(g, gid, mid('Sam'), mid('Jo'), ctx({ now: ko - 1000, actor: { mid: mid('Sam'), host: false } })), /opens at kickoff/);
  apply(g, C.vote(g, gid, mid('Sam'), mid('Jo'), as('Sam')));
  apply(g, C.vote(g, gid, mid('Sam'), mid('Mia'), as('Sam'))); // changed their mind
  assert.throws(() => C.vote(g, gid, mid('Jo'), mid('Jo'), as('Jo')), /someone else/);
  assert.throws(() => C.vote(g, gid, mid('Jo'), mid('Ben'), as('Jo')), /someone who played/);
  assert.throws(() => C.vote(g, gid, mid('Ben'), mid('Jo'), as('Ben')), /who played this week/);
  assert.throws(() => C.vote(g, gid, mid('Mia'), mid('Jo'), as('Sam')), /yourself only/, 'online, nobody votes for someone else');
  apply(g, C.vote(g, gid, mid('Jo'), mid('Mia'), as('Jo')));
  apply(g, C.vote(g, gid, mid('Mia'), mid('Jo'), as('Mia')));
  let pw = C.potw(g, g.games[gid], ko + 3600e3, mid('Sam'));
  assert.deepStrictEqual([pw.open, pw.closed, pw.count, pw.mine, pw.winners], [true, false, 3, mid('Mia'), []]);
  assert.throws(() => C.closeVotes(g, gid, as('Sam')), /Only the host/);
  apply(g, C.closeVotes(g, gid, ctx({ now: ko + 7200e3 })));
  pw = C.potw(g, g.games[gid], ko + 7200e3, null);
  assert.deepStrictEqual([pw.closed, pw.reason, pw.winners, pw.top], [true, 'host', [mid('Mia')], 2]);
  assert.throws(() => C.vote(g, gid, mid('Tom'), mid('Mia'), as('Tom')), /closed/);
  // It closes by itself after three days, or when everyone has voted.
  const w2 = world();
  const ko2 = playedWeek(w2.g, w2.gid, NAMES.slice(0, 4), [[0, 1, 1, 0]]);
  assert.strictEqual(C.potw(w2.g, w2.g.games[w2.gid], ko2 + 73 * 3600e3, null).reason, 'time');
  const four = NAMES.slice(0, 4);
  four.forEach((n, i) => apply(w2.g, C.vote(w2.g, w2.gid, n === 'Host' ? 'mhost0001' : mid(n), four[(i + 1) % 4] === 'Host' ? 'mhost0001' : mid(four[(i + 1) % 4]), ctx({ now: ko2 + 1000 }))));
  pw = C.potw(w2.g, w2.g.games[w2.gid], ko2 + 2000, null);
  assert.deepStrictEqual([pw.reason, pw.winners.length], ['all', 4], 'a four-way tie: all four share it');
  assert.strictEqual(C.standings(w2.g, ko2 + 2000).rows.find((r) => r.name === 'Sam').potw, 1);
});

/* ---------------- court money ---------------- */

test('court money: the cost split among who played, to the cent; +1s owed by their bringer; balances across weeks', () => {
  const { g, gid } = world();
  for (const n of NAMES.slice(0, 6)) answer(g, gid, n, 'in');
  apply(g, C.addGuest(g, gid, { name: 'Marcus', by: mid('Sam') }, tick()));
  apply(g, C.editGame(g, gid, { cost: 1000 }, tick())); // $10 among 7 players
  const ko = C.kickoff(g, g.games[gid]);
  const sh = C.shares(g, g.games[gid]);
  assert.strictEqual(Object.values(sh.each).reduce((s, c) => s + c, 0), 1000, 'to the cent');
  assert.ok(Object.values(sh.each).every((c) => c === 142 || c === 143));
  assert.strictEqual(sh.owed[mid('Sam')], sh.each[mid('Sam')] + Object.entries(sh.each).find(([id]) => C.isGuestId(id))[1], 'Sam owes for Marcus too');
  assert.strictEqual(C.money(g, ko - 1000).owes.length, 0, 'nothing is owed before kickoff');
  let m = C.money(g, ko + 1000);
  assert.strictEqual(m.owes.length, 5, 'the host paid the court - their share is settled');
  assert.ok(!m.owes.some((o) => o.id === 'mhost0001'));
  const after = ctx({ now: ko + 2000 });
  assert.throws(() => C.markPaid(g, gid, mid('Jo'), true, ctx({ now: ko + 2000, actor: { mid: mid('Sam'), host: false } })), /Tick your own/);
  apply(g, C.markPaid(g, gid, mid('Jo'), true, ctx({ now: ko + 2000, actor: { mid: mid('Jo'), host: false } })));
  apply(g, C.markPaid(g, gid, mid('Mia'), true, after));
  assert.throws(() => C.markPaid(g, gid, mid('Ben'), true, after), /Nothing is owed/);
  m = C.money(g, ko + 3000);
  assert.deepStrictEqual(m.owes.map((o) => C.memberOf(g, o.id).name).sort(), ['Priya', 'Sam', 'Tom']);
  // A second week: Sam plays and doesn't pay again - his balance carries.
  const nx = C.ensureGame(g, ko + 13 * 3600e3); apply(g, nx);
  for (const n of ['Host', 'Sam', 'Jo', 'Mia']) answer(g, nx.gid, n, 'in');
  const ko2 = C.kickoff(g, g.games[nx.gid]);
  m = C.money(g, ko2 + 1000);
  const samRow = m.owes.find((o) => o.id === mid('Sam'));
  assert.strictEqual(samRow.games.length, 2);
  assert.strictEqual(samRow.cents, sh.owed[mid('Sam')] + 1500);
  assert.strictEqual(m.outstanding, m.owes.reduce((s, o) => s + o.cents, 0));
  assert.match(C.reminderText(g, m), /^Court money for Test Hoops: Sam \$\d+\.\d\d \(Oct 8, Oct 15\).* Pay Host - thanks!$/);
  // A collector who is not the host.
  g.collector = mid('Jo');
  assert.ok(C.money(g, ko2 + 1000).owes.some((o) => o.id === 'mhost0001'), 'the host owes when someone else paid the court');
  apply(g, C.markPaid(g, gid, mid('Jo'), false, ctx({ now: ko2 + 2000, actor: { mid: mid('Jo'), host: false } })));
  assert.ok(!C.money(g, ko2 + 2000).owes.some((o) => o.id === mid('Jo')), 'the collector never owes themselves');
  g.collector = null;
  for (const o of C.money(g, ko2 + 3000).owes) for (const x of o.games) apply(g, C.markPaid(g, x.id, o.id, true, ctx({ now: ko2 + 4000 })));
  assert.match(C.reminderText(g, C.money(g, ko2 + 5000)), /everyone’s paid up/);
});

/* ---------------- sharing ---------------- */

test('share and nudge lines are ready to paste; Pickup sends nothing itself', () => {
  const { g, gid } = world();
  for (const n of NAMES.slice(0, 8)) answer(g, gid, n, 'in');
  assert.strictEqual(C.shareText(g, g.games[gid], 'https://x/j/ABCDEF'), 'Test Hoops 7pm @ Riverside - 8 in, need 2. Tap to say you’re in: https://x/j/ABCDEF');
  assert.strictEqual(C.shareText(g, g.games[gid], null), 'Test Hoops 7pm @ Riverside - 8 in, need 2. Reply in, out or maybe!');
  assert.strictEqual(C.nudgeText(g, g.games[gid], 'Ben', 'https://x/j/ABCDEF'), 'Hey Ben - hoops Thursday 7pm @ Riverside. We’re at 8, need 2. You in? https://x/j/ABCDEF');
  for (const n of NAMES.slice(8, 12)) answer(g, gid, n, 'in');
  assert.match(C.shareText(g, g.games[gid], 'L'), /full, 2 waiting\. Join the waitlist: L$/);
});

/* ---------------- the free chat reader ---------------- */

test('the free reader understands WhatsApp and iMessage replies and "who’s in" lists, and leaves the messy rest', () => {
  const chat = [
    '[08/10/2026, 18:42:11] Sam Lee: I’m in',
    '[08/10/2026, 18:43:02] Jo Park: can\'t make it this week sorry',
    '08/10/2026, 18:45 - Mia: maybe, depends on work',
    '10/8/26, 6:47\u202fPM - \u200e~\u00a0Tom: in +1',
    'Messages and calls are end-to-end encrypted. No one outside of this chat can read them.',
    '[08/10/2026, 18:50:00] Ravi: <Media omitted>',
    'in - Priya',
    'Dev - out',
    'Kai ✅',
    '1. Lena',
    '2. Ola +1',
    '3. Ben (maybe)',
    '4. Chris - out',
    'Nina: 👍',
    'Omar: can\'t wait, I\'m in',
    'Zoe: I\'ll be in London until Friday but might make the late game if the train is on time and the stars align',
    '[08/10/2026, 19:10:00] Sam Lee: actually out, sorry',
  ].join('\n');
  const r = C.parseChat(chat);
  const got = Object.fromEntries(r.replies.map((x) => [x.name, x.answer + (x.plusOnes ? `+${x.plusOnes}` : '')]));
  assert.deepStrictEqual(got, { 'Sam Lee': 'out', 'Jo Park': 'out', Mia: 'maybe', Tom: 'in+1', Priya: 'in', Dev: 'out', Kai: 'in', Lena: 'in', Ola: 'in+1', Ben: 'maybe', Chris: 'out', Nina: 'in' });
  assert.deepStrictEqual(r.unread.map((l) => l.slice(0, 5)), ['Omar:', 'Zoe: '], 'ambiguous and long lines are left for the AI');
  assert.ok(!JSON.stringify(r).includes('Media omitted'));
  // Headings: "Out: Jo, Mia".
  const h = C.parseChat('In: Sam, Jo & Mia\nOut: Ben and Chris');
  assert.deepStrictEqual(h.replies.map((x) => `${x.name}:${x.answer}`), ['Sam:in', 'Jo:in', 'Mia:in', 'Ben:out', 'Chris:out']);
  // Hostile text is cleaned through the same door.
  const x = C.parseChat('<img src=x onerror=alert(1)>Sam\u202e: in\n' + 'A'.repeat(50000));
  assert.ok(!/[<>]/.test(JSON.stringify(x.replies)) && !/\u202e/.test(JSON.stringify(x.replies)));
  assert.strictEqual(C.parseChat(42).replies.length, 0);
});

test('answers are matched to regulars by name: full, first, or the chat name’s first word; the rest are new', () => {
  const members = [{ id: 'msam00001', name: 'Sam' }, { id: 'mjo000001', name: 'Jo Park' }, { id: 'mmia00001', name: 'Mia' }, { id: 'mmia00002', name: 'Mia K' }, { id: 'mzoe00001', name: 'Zoë' }];
  const m = C.matchReplies([{ name: 'Sam Lee', answer: 'in' }, { name: 'jo', answer: 'out' }, { name: 'Mia', answer: 'maybe' }, { name: 'Zoe', answer: 'in' }, { name: 'Tom', answer: 'in', plusOnes: 1 }, { name: 'Sam', answer: 'out' }, { name: '<b>', answer: 'in' }], members);
  assert.deepStrictEqual(m.map((x) => [x.name, x.id]), [['Sam Lee', 'msam00001'], ['jo', 'mjo000001'], ['Mia', 'mmia00001'], ['Zoe', 'mzoe00001'], ['Tom', null], ['Sam', null]], 'one regular is matched once');
  assert.strictEqual(m[4].plusOnes, 1);
});

test('rsvpMany applies a pasted chat through the same waitlist rules, +1s and all, for the host only', () => {
  const { g, gid } = world();
  const ans = NAMES.slice(1, 12).map((n) => ({ id: mid(n), a: 'in' })).concat([{ id: mid('Nina'), a: 'out' }, { id: mid('Chris'), a: 'maybe' }, { id: 'mghost001', a: 'in' }, { id: mid('Sam'), a: 'bogus' }]);
  ans[0].plus = 1;
  assert.throws(() => C.rsvpMany(g, gid, ans, ctx({ actor: { mid: mid('Sam'), host: false } })), /Only the host/);
  const r = apply(g, C.rsvpMany(g, gid, ans, tick()));
  assert.strictEqual(r.n, 13);
  const lu = C.lineup(g, g.games[gid]);
  assert.strictEqual(lu.in.length, 10);
  assert.deepStrictEqual(lu.wait.map((e) => e.name), ['Ola', 'Ben'], 'Sam’s +1 took a place - first come, first served');
  assert.ok(!lu.in.some((e) => e.id === 'mhost0001'));
  assert.ok(lu.in.some((e) => e.kind === 'x' && e.name === 'Guest'), 'Sam’s +1 joined after Sam');
  assert.strictEqual(apply(g, C.rsvpMany(g, gid, ans.slice(1, 3), tick())).n, 0, 'nothing new to apply');
});

/* ---------------- the group: storage and settings ---------------- */

test('a group from a phone is cleaned: only known fields, only its people, nothing hostile', () => {
  const { g, gid } = world();
  for (const n of NAMES.slice(0, 10)) answer(g, gid, n, 'in');
  apply(g, C.makeTeams(g, gid, { sides: 2 }, tick()));
  const raw = JSON.parse(JSON.stringify(g));
  raw.name = '<b>Hoops</b>\u202e';
  raw.evil = { $where: 1 };
  raw.members.push({ id: 'mevil0001', name: '', emoji: '<img>' }, { id: '__proto__', name: 'Proto' }, { id: 'mhost0001', name: 'Dupe' });
  raw.games[gid].rsvps.mnotreal1 = { a: 'in', t: 1 };
  raw.games[gid].rsvps[mid('Sam')].a = 'yes';
  raw.games[gid].teams.sides[0].push('mnotreal1');
  raw.games['../x'] = { date: '2026-10-01' };
  raw.games.g20261001 = { date: 'yesterday' };
  raw.games[gid].matches = { rbad00001: { a: 0, b: 9, w: 'a' }, rgood0001: { a: 0, b: 1, sa: 3, sb: 1, w: 'a', t: 1 } };
  raw.lines = [{ a: mid('Sam'), b: mid('Jo'), k: 'apart' }, { a: mid('Sam'), b: mid('Sam'), k: 'apart' }, { a: 'mnotreal1', b: mid('Jo') }];
  const c = C.cleanGroup(raw, { tz: TZ, rand });
  assert.strictEqual(c.name, 'Hoops');
  assert.ok(!('evil' in c));
  assert.strictEqual(c.members.length, NAMES.length + 1, 'Proto gets a fresh id; the blank and the duplicate id are dropped');
  assert.ok(c.members.every((m) => C.isMemberId(m.id) && C.EMOJI.includes(m.emoji)));
  assert.ok(!c.games[gid].rsvps.mnotreal1 && !c.games[gid].rsvps[mid('Sam')]);
  assert.ok(!c.games[gid].teams.sides.flat().includes('mnotreal1'));
  assert.deepStrictEqual(Object.keys(c.games), [gid]);
  assert.deepStrictEqual(Object.keys(c.games[gid].matches), ['rgood0001']);
  assert.strictEqual(c.lines.length, 1);
  assert.strictEqual(c.members.filter((m) => m.host).length, 1);
  assert.throws(() => C.cleanGroup({ name: '', members: [{ name: 'A' }] }, { tz: TZ }), /name/);
  assert.throws(() => C.cleanGroup({ name: 'X', members: [] }, { tz: TZ }), /Add yourself/);
});

test('a new group: the sport picker sets sensible defaults; regulars come in by name', () => {
  const g = C.newGroup({ name: 'Sunday Footy', sport: 'football', me: 'Ana', wd: 6, time: '10:00', place: 'Hackney Marshes', cost: '£40', cur: 'GBP', regulars: 'Ben, Cleo\nDee\n<b></b>\nben' }, { tz: 'Europe/London', now: NOW, rand });
  assert.deepStrictEqual([g.perSide, g.usePos, g.sched.cap, g.sched.cost, g.cur], [5, true, 10, 4000, 'GBP']);
  assert.deepStrictEqual(g.members.map((m) => m.name), ['Ana', 'Ben', 'Cleo', 'Dee']);
  assert.ok(g.members[0].host);
  assert.strictEqual(C.latest(g).date, '2026-10-11', 'the coming Sunday');
  const v = C.newGroup({ name: 'Volley', sport: 'volleyball', me: 'A' }, { tz: TZ, now: NOW, rand });
  assert.deepStrictEqual([v.perSide, v.sched.cap, C.sportOf(v).positions[0].id, v.usePos], [6, 12, 'setter', true]);
  const b = C.newGroup({ name: 'Hoops', sport: 'basketball', me: 'A' }, { tz: TZ, now: NOW, rand });
  assert.strictEqual(b.usePos, false, 'no positions for basketball by default');
  assert.throws(() => C.newGroup({ name: 'X', me: '' }, { tz: TZ, now: NOW, rand }), /Add your name/);
});

test('settings: skill is yours, the host adjusts quietly; a schedule change moves an unanswered game', () => {
  const { g, gid } = world();
  const sam = { mid: mid('Sam'), host: false };
  C.editMember(g, mid('Sam'), { skill: 5, pos: 'big', name: 'Sammy' }, sam);
  assert.deepStrictEqual([C.memberOf(g, mid('Sam')).skill, C.memberOf(g, mid('Sam')).pos, C.memberOf(g, mid('Sam')).name], [5, 'big', 'Sammy']);
  assert.throws(() => C.editMember(g, mid('Jo'), { skill: 1 }, sam), /your own settings/);
  assert.throws(() => C.editMember(g, mid('Sam'), { adj: 2 }, sam), /Only the host adjusts/);
  assert.throws(() => C.editMember(g, mid('Sam'), { name: 'jo' }, sam), /already called/);
  C.editMember(g, mid('Sam'), { adj: 3 }, host);
  assert.strictEqual(C.skillOf(C.memberOf(g, mid('Sam'))), 3);
  C.editMember(g, mid('Sam'), { pos: 'gk' }, sam);
  assert.strictEqual(C.memberOf(g, mid('Sam')).pos, '', 'a position the sport does not have');
  assert.throws(() => C.editGroup(g, { name: 'x' }, sam, NOW), /Only the host/);
  C.editGroup(g, { sched: { wd: 1, time: '18:30', cost: '$50' } }, host, NOW);
  assert.ok(!g.games[gid], 'the unanswered Thursday game moved');
  assert.deepStrictEqual([C.latest(g).date, C.latest(g).time, C.latest(g).cost], ['2026-10-06', '18:30', 5000]);
  answer(g, C.latest(g).id, 'Sam', 'in');
  C.editGroup(g, { sched: { wd: 4 } }, host, NOW);
  assert.strictEqual(C.latest(g).date, '2026-10-06', 'an answered game stays put');
  assert.throws(() => C.editGroup(g, { sched: { cap: 99 } }, host, NOW), /cap/);
  C.editGroup(g, { sport: 'football' }, host, NOW);
  assert.deepStrictEqual([g.usePos, g.perSide], [true, 5]);
  C.removeMember(g, mid('Sam'), host);
  assert.ok(!C.memberOf(g, mid('Sam')) && !C.latest(g).rsvps[mid('Sam')]);
  assert.throws(() => C.removeMember(g, 'mhost0001', host), /delete the group/);
});

/* ---------------- the example ---------------- */

test('the example group is played by the real rules: 16 regulars, 11 in, 2 maybe, a waitlist, teams, six weeks, two owing', () => {
  for (const tz of ['America/New_York', 'Europe/London', 'Pacific/Auckland']) {
    for (const now of [NOW, Date.parse('2026-10-08T22:30:00Z'), Date.parse('2026-10-09T03:00:00Z')]) {
      const g = S.state(now, tz);
      assert.strictEqual(g.members.length, 16);
      const games = C.games(g);
      assert.strictEqual(games.length, 7);
      const cur = C.latest(g);
      assert.ok(C.kickoff(g, cur) > now, 'this week’s game is still to come');
      assert.strictEqual(C.ensureGame(g, now).patch, null);
      const lu = C.lineup(g, cur);
      assert.strictEqual(Object.values(cur.rsvps).filter((r) => r.a === 'in').length, 11, '11 in');
      assert.strictEqual(lu.maybe.length, 2);
      assert.strictEqual(C.headline(lu), 'Full - 2 waiting');
      assert.ok(Object.values(cur.log).map(C.logText).includes('Lena’s in - Jo dropped out'));
      assert.ok(cur.teams && !C.teamsStale(g, cur));
      assert.ok(Object.values(cur.rsvps).every((r) => r.t <= now), 'nobody answered in the future');
      const st = C.standings(g, now);
      assert.strictEqual(st.games, 6);
      assert.ok(st.rows.some((r) => r.potw > 0));
      const m = C.money(g, now);
      assert.deepStrictEqual(m.owes.map((o) => [C.memberOf(g, o.id).name, o.cents]), [['Ben', 1200], ['Nina', 600]]);
      for (const past of games.slice(0, 6)) {
        const pw = C.potw(g, past, now, S.HOST);
        if (past !== games[5] || now >= C.kickoff(g, past) + C.VOTE_HOURS * 3600e3) assert.ok(pw.closed, `${past.date} closed`);
        else assert.ok(pw.open && !pw.mine, 'last week’s vote is still open, and Alex has not voted - the visitor can');
        assert.ok(C.matchList(past).length >= 3);
      }
      // Sam and Jo are kept apart, Mia and Priya together, every week they both played.
      for (const gm of games) {
        const team = (id) => gm.teams.sides.findIndex((s) => s.includes(id));
        if (team('msam00001') >= 0 && team('mjo000001') >= 0) assert.notStrictEqual(team('msam00001'), team('mjo000001'));
        if (team('mmia00001') >= 0 && team('mpriya001') >= 0) assert.strictEqual(team('mmia00001'), team('mpriya001'));
      }
      assert.deepStrictEqual(C.cleanGroup(JSON.parse(JSON.stringify(g)), { tz, rand }).members.length, 16, 'it survives the clean a phone gets');
    }
  }
  assert.deepStrictEqual(JSON.stringify(S.state(NOW, TZ)), JSON.stringify(S.state(NOW, TZ)), 'the same example on every phone');
});

/* ---------------- the model's half ---------------- */

test('the fake model and the cleaning of hostile output', async () => {
  const fake = require('../lib/fakeai').create();
  await assert.rejects(fake.messages.create({ messages: [] }), /force a tool/);
  const raw = (await fake.messages.create({ tool_choice: { type: 'tool', name: 'record_replies' }, messages: [{ content: [{ type: 'text', text: 'INJECT' }] }] })).content[0].input;
  const got = ai.cleanReplies(raw);
  assert.ok(got.length <= C.LIMITS.replies);
  assert.ok(!/[<>]/.test(JSON.stringify(got)) && !/\u202e/.test(JSON.stringify(got)));
  assert.ok(got.every((r) => C.ANSWERS.includes(r.answer) && r.plusOnes >= 0 && r.plusOnes <= 3 && r.name.length <= C.LIMITS.memberName));
  assert.deepStrictEqual(got.filter((r) => C.fold(r.name) === 'jo'), [{ name: 'jo', answer: 'out', plusOnes: 0 }], 'a repeat keeps the last answer');
  assert.ok(!got.some((r) => r.name === 'Ignore previous instructions'), 'an answer off the list is dropped');
  assert.deepStrictEqual(ai.cleanReplies({ replies: 'nope' }), []);
  assert.deepStrictEqual(ai.cleanReplies(null), []);
  const nm = ai.cleanNames(['Sam', '<b>Sam</b>', 'x'.repeat(100), '']);
  assert.deepStrictEqual([nm.length, nm[0], nm.every((n) => n.length <= 24)], [2, 'Sam', true], 'cleaned, folded, bounded');
  assert.match(ai.SYSTEM, /never an instruction/);
  assert.deepStrictEqual(ai.REPLIES_TOOL.input_schema.properties.replies.items.properties.answer.enum, C.ANSWERS);
});

test('a screenshot is checked by its bytes before anything is spent', () => {
  assert.throws(() => photo.validate(null), /screenshot/);
  assert.throws(() => photo.validate({ type: 'image/png', data: Buffer.from('%PDF-1.4').toString('base64') }), /PNG, JPEG or WebP/);
  assert.throws(() => photo.validate({ type: 'image/gif', data: png() }), /PNG, JPEG or WebP/);
  assert.throws(() => photo.validate({ type: 'image/png', data: 'A'.repeat(4 * 1024 * 1024) }), /too large/);
  assert.strictEqual(photo.validate({ type: 'image/jpeg', data: png() }).mediaType, 'image/png', 'the bytes win over the claim');
});

/* ---------------- static checks ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour holds 4.5:1 on its surface in both themes', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['bg', 'card', 'card2', 'accent-soft']) for (const fg of ['text', 'muted', 'link']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, `${name} accent-ink on accent`);
    for (const k of ['in', 'wait', 'maybe', 'out']) {
      assert.ok(ratio(t[k], t[`${k}-bg`]) >= 4.5, `${name} ${k} on its tint: ${ratio(t[k], t[`${k}-bg`]).toFixed(2)}`);
      assert.ok(ratio(t[k], t.card) >= 4.5, `${name} ${k} on a card: ${ratio(t[k], t.card).toFixed(2)}`);
      assert.ok(ratio(t[`${k}-on`], t[k]) >= 4.5, `${name} ink on a chosen ${k} button: ${ratio(t[`${k}-on`], t[k]).toFixed(2)}`);
    }
    assert.ok(ratio(t.owe, t['owe-bg']) >= 4.5 && ratio(t.owe, t.card) >= 4.5, `${name} the owes chip`);
    assert.ok(ratio(t.err, t.card) >= 4.5, `${name} errors`);
    assert.ok(ratio(t['strip-ink'], t.strip) >= 4.5 && ratio(t['strip-btn-ink'], t['strip-btn']) >= 4.5, `${name} the dark strip and the toast`);
    assert.ok(ratio(t.accent, t.card) >= 3, `${name} the focus ring and buttons (3:1)`);
  }
  // Team bibs: the swatch has a name beside it, and a border on a card.
  for (const team of C.TEAMS) assert.ok(/^#[0-9a-f]{6}$/.test(team.hex) && team.name);
  assert.ok(ratio('#111111', '#ffffff') >= 4.5, 'the QR screen');
});

test('the QR encoder draws a join link', () => {
  const svg = QR.svg('https://challenge.strongtechnicalconsulting.com/pickup/j/ABCDEF', 'Join "x" <group>');
  assert.ok(svg.startsWith('<svg') && !/<group>|"x"/.test(svg));
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { PICKUP_MEMORY: '1' }], ['./lib/fakeai', { PICKUP_FAKE_AI: '1' }], ['./server', { PICKUP_FAKE_AI: '1', PICKUP_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, PICKUP_MEMORY: '', PICKUP_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured; single-field queries only', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, PICKUP_MEMORY: '', PICKUP_COLLECTION_PREFIX: 'pickup_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8');
  assert.ok(/PICKUP_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
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
  assert.match(js, /never holds or moves money/, 'the money tab says so');
  for (const f of ['server.js', 'lib/ai.js', 'lib/groups.js', 'lib/photo.js', 'public/pickup-core.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|photo|name|text|raw|chat)/.test(src), `${f} logs a body`);
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
/** A group as a phone would send it to go online. */
function phoneGroup() {
  // The HTTP tests run against the real clock, so this week's game must be
  // ahead of it: a game dated from the fixed NOW has kicked off once that
  // Thursday passes, and the server rightly refuses members' answers.
  const { g } = world(NAMES.slice(0, 6), {}, Date.now() + 8 * 86400000);
  g.name = 'The <i>Test</i> Hoops';
  g.members[2].skill = 5; // Jo
  g.lines = [{ a: mid('Sam'), b: mid('Jo'), k: 'apart' }];
  return JSON.parse(JSON.stringify(g));
}

let HOST; let GID; let CODE; let hostMid; let GAME;

test('signed out: the page and the example work with zero model calls; nothing private does, and no big body is read', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.limits.members, meta.limits.groupsPerHost, meta.sports.length], [40, 5, C.SPORTS.length]);
  for (const f of ['pickup-core.js', 'sample.js', 'qr.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['POST', '/api/replies/text'], ['POST', '/api/replies/photo'], ['POST', '/api/groups'], ['GET', '/api/groups']]) assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p}`);
  assert.strictEqual((await anon('POST', '/api/replies/photo', { photo: { type: 'image/png', data: BIG } })).status, 401, 'the gate answers before the 4 MB parser');
  assert.strictEqual((await anon('POST', '/api/replies/text', { text: 'x'.repeat(200 * 1024) })).status, 401, 'and before the text parser');
  assert.strictEqual((await anon('POST', '/api/groups', { group: 'x'.repeat(700 * 1024) })).status, 401, 'going online: sign-in before its 512 KB parser');
  assert.strictEqual((await anon('POST', '/api/join/ABCDEF', { name: 'x'.repeat(100 * 1024) })).status, 413, 'every other route keeps the small limit');
  for (const p of ['/g/AAAAAAAAAAAAAAAA', '/j/ABCDEF']) {
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
  for (const p of ['/api/replies/text', '/api/replies/photo']) assert.deepStrictEqual(layer(p, 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser'], p);
  assert.deepStrictEqual(layer('/api/groups', 'post').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  for (const [p, m] of [['/api/groups', 'get'], ['/api/groups', 'post'], ['/api/groups/:gid', 'patch'], ['/api/groups/:gid', 'delete'], ['/api/groups/:gid/code', 'post']]) assert.strictEqual(layer(p, m).route.stack[0].handle.name, 'requireUser', `${m} ${p}`);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 2, 'two doors to one metered call, nowhere else');
});

test('reading the chat: input checked before any spend, one metered call, a proposal, nothing stored', async () => {
  HOST = await register('ana.host@example.com');
  const dump = store._dump();
  const calls = await modelCalls();
  assert.strictEqual((await HOST('POST', '/api/replies/text', {})).status, 400);
  assert.strictEqual((await HOST('POST', '/api/replies/text', { text: '!!! ??? ...' })).status, 400);
  assert.strictEqual((await HOST('POST', '/api/replies/text', { text: 'in '.repeat(8000) })).status, 400, 'over the paste limit');
  assert.strictEqual((await HOST('POST', '/api/replies/text', { text: 'x'.repeat(70 * 1024) })).status, 413, 'its own 64 KB parser, after the gates');
  assert.strictEqual((await HOST('POST', '/api/replies/photo', {})).status, 400);
  assert.strictEqual((await HOST('POST', '/api/replies/photo', { photo: { type: 'image/png', data: Buffer.from('%PDF-1.4 nope').toString('base64') } })).status, 400);
  assert.strictEqual((await HOST('POST', '/api/replies/photo', { photo: { type: 'image/png', data: BIG } })).status, 413, 'over the 4 MB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const SECRET_CHAT = 'Sam: in\nJo: nah\nMia: maybe\nZEBRA-CHAT-7731';
  const r = await HOST('POST', '/api/replies/text', { text: SECRET_CHAT, names: ['Sam', 'Jo', '<b>Mia</b>'] });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.data.replies.map((x) => `${x.name}:${x.answer}:${x.plusOnes}`), ['Sam:in:0', 'Jo:out:0', 'Mia:maybe:0', 'Tom:in:1', 'Priya:in:0']);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const shot = await HOST('POST', '/api/replies/photo', { photo: { type: 'image/png', data: png() }, names: ['Sam'] });
  assert.strictEqual(shot.status, 200, shot.text);
  const inj = await HOST('POST', '/api/replies/text', { text: 'INJECT please' });
  assert.strictEqual(inj.status, 200);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text), 'no markup or bidi reaches the page');
  assert.ok(inj.data.replies.length <= C.LIMITS.replies);
  const blank = await HOST('POST', '/api/replies/text', { text: 'BLANK chat' });
  assert.deepStrictEqual([blank.status, /Nobody’s answer/.test(blank.data.error)], [422, true]);
  assert.match((await HOST('POST', '/api/replies/photo', { photo: { type: 'image/png', data: png('MAXTOKENS') } })).data.error, /ran long/);
  const up = await HOST('POST', '/api/replies/text', { text: 'UPSTREAM401 chat' });
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await HOST('POST', '/api/replies/photo', { photo: { type: 'image/png', data: png('UPSTREAM529') } });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  assert.strictEqual(store._dump(), dump, 'reading a chat stores nothing');
  assert.ok(!store._dump().includes(MARK) && !store._dump().includes('ZEBRA-CHAT'), 'the text and the screenshot are never stored');
});

test('an unconfirmed free account gets the verify-email 403 before any model call or big body; out of credit is a 402', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/replies/text', { text: 'Sam: in' });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/pickup/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/replies/photo', { photo: { type: 'image/png', data: BIG } })).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('POST', '/api/groups', { group: { name: 'X', members: [] } })).status, 400, 'a group needs no AI and no confirmed address');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/replies/text', { text: 'Sam: in' })).status, 402);
  assert.strictEqual((await cal('POST', '/api/replies/photo', { photo: { type: 'image/png', data: BIG } })).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
});

test('a host puts a phone’s group online, season and all; a friend with no account joins by code and takes their seat', async () => {
  const r = await HOST('POST', '/api/groups', { group: phoneGroup(), tz: TZ });
  assert.strictEqual(r.status, 200, r.text);
  GID = r.data.id; CODE = r.data.group.code; hostMid = r.data.group.me;
  assert.ok(G.isGroupId(GID) && G.isCode(CODE));
  const g = r.data.group;
  assert.deepStrictEqual([g.name, g.host, g.tz, g.members.length, g.members[0].name, hostMid], ['The Test Hoops', true, TZ, 6, 'Host', 'mhost0001']);
  assert.strictEqual(g.lines.length, 1, 'the host sees the lines');
  GAME = C.latest(g).id;
  assert.ok(C.isGameId(GAME));
  // A friend opens the link.
  const sam = client();
  const look = await sam('GET', `/api/join/${CODE.toLowerCase().replace(/(...)/, '$1-')}`);
  assert.strictEqual(look.status, 200, 'the code is read however it is typed');
  assert.deepStrictEqual([look.data.name, look.data.sport, look.data.members, look.data.already, look.data.seats.length], ['The Test Hoops', 'basketball', 6, null, 5]);
  assert.ok(!/rsvps|skill|keyHash|lines/.test(look.text), 'a code shows the group and the open seats, not answers or numbers');
  assert.strictEqual(sam.cookies.pickup_k, undefined, 'looking mints nothing');
  const j = await sam('POST', `/api/join/${CODE}`, { seat: mid('Sam'), skill: 4 });
  assert.strictEqual(j.status, 200, JSON.stringify(j.data));
  assert.deepStrictEqual([j.data.groupId, j.data.me], [GID, mid('Sam')]);
  const ck = j.setCookie.find((c) => c.startsWith('pickup_k='));
  assert.match(ck, /^pickup_k=[A-Za-z0-9_-]{22}; Path=\/pickup\/; Max-Age=\d+; SameSite=Lax; HttpOnly/, 'HttpOnly, scoped to the app path');
  assert.strictEqual((await client()('POST', `/api/join/${CODE}`, { seat: mid('Sam') })).status, 409, 'a seat has one owner');
  const v = await sam('GET', `/api/groups/${GID}`);
  assert.strictEqual(v.status, 200);
  assert.deepStrictEqual([v.data.group.me, v.data.group.host], [mid('Sam'), false]);
  assert.ok(!/ownerTag|acctTags|keyHash|"acct"|example\.com|YW5hLm/.test(v.text), 'no tag, hash, account id or email reaches a member');
  // Skill numbers: Sam sees his own, nobody else's; no lines.
  const ms = v.data.group.members;
  assert.strictEqual(ms.find((m) => m.id === mid('Sam')).skill, 4);
  assert.ok(ms.filter((m) => m.id !== mid('Sam')).every((m) => !('skill' in m) && !('adj' in m)), 'other people’s numbers never reach a member');
  assert.deepStrictEqual(v.data.group.lines, []);
  const hv = await HOST('GET', `/api/groups/${GID}`);
  assert.strictEqual(hv.data.group.members.find((m) => m.id === mid('Jo')).skill, 5, 'the host sees everyone’s');
  // A new friend joins as someone new.
  const zed = client();
  const z = await zed('POST', `/api/join/${CODE}`, { name: '<b>Zed</b> \u202e', emoji: '🦖' });
  assert.strictEqual(z.status, 200);
  assert.strictEqual((await zed('GET', `/api/groups/${GID}`)).data.group.members.find((m) => m.id === z.data.me).name, 'Zed');
  assert.strictEqual((await zed('POST', `/api/join/${CODE}`, { name: 'Someone else' })).data.me, z.data.me, 'a browser that joined gets itself back');
  assert.strictEqual((await client()('POST', `/api/join/${CODE}`, { name: 'zed' })).status, 409, 'names are unique, case folded');
  // Polling: an idle group costs one read.
  const same = await sam('GET', `/api/groups/${GID}?since=${(await sam('GET', `/api/groups/${GID}`)).data.group.v}`);
  assert.strictEqual(same.data.same, true);
});

const memberAt = async (name) => { const c = client(); const r = await c('POST', `/api/join/${CODE}`, { name }); assert.strictEqual(r.status, 200, r.text); c.mid = r.data.me; return c; };

test('two phones: many answers at once all stick; the last spot claimed by two phones gives one In and one waitlisted', async () => {
  const phones = [];
  for (let i = 0; i < 12; i++) phones.push(await memberAt(`Runner${i}`));
  await HOST('PATCH', `/api/groups/${GID}/games/${GAME}`, { cap: 20 });
  const all = await Promise.all(phones.map((p) => p('PUT', `/api/groups/${GID}/games/${GAME}/rsvp/${p.mid}`, { a: 'in' })));
  assert.ok(all.every((r) => r.status === 200), all.map((r) => r.status).join());
  let g = (await HOST('GET', `/api/groups/${GID}`)).data.group;
  assert.strictEqual(Object.values(g.games[GAME].rsvps).filter((r) => r.a === 'in').length, 12, 'twelve answers at once, all twelve kept');
  // Without the transaction, the same two writes lose one (the queue is what keeps them).
  const doc = await store.get('groups', GID);
  await Promise.all(['a1', 'b2'].map((k) => store._unsafeUpdate('groups', GID, (cur) => { cur.games[GAME].rsvps[`m${k}aaaaa`] = { a: 'in', t: 1 }; return cur; })));
  const after = await store.get('groups', GID);
  assert.strictEqual(Object.keys(after.games[GAME].rsvps).filter((k) => /^m(a1|b2)aaaaa$/.test(k)).length, 1, 'a plain read-change-write loses one');
  await store.set('groups', GID, doc);
  // The last spot: cap at 13 with 12 in, two phones tap In together.
  await HOST('PATCH', `/api/groups/${GID}/games/${GAME}`, { cap: 13 });
  const a = await memberAt('LastA'); const b = await memberAt('LastB');
  const [ra, rb] = await Promise.all([a('PUT', `/api/groups/${GID}/games/${GAME}/rsvp/${a.mid}`, { a: 'in' }), b('PUT', `/api/groups/${GID}/games/${GAME}/rsvp/${b.mid}`, { a: 'in' })]);
  assert.deepStrictEqual([ra.status, rb.status], [200, 200]);
  assert.deepStrictEqual([ra.data.status, rb.data.status].sort(), ['in', 'wait1'], 'one In, one first on the waitlist');
  g = (await HOST('GET', `/api/groups/${GID}`)).data.group;
  const lu = C.lineup(g, g.games[GAME]);
  assert.strictEqual(lu.in.length, 13);
  assert.strictEqual(lu.wait.length, 1);
  // The one in drops out: the waiter moves up and the line says so.
  const inner = ra.data.status === 'in' ? a : b; const waiter = inner === a ? b : a;
  const out = await inner('PUT', `/api/groups/${GID}/games/${GAME}/rsvp/${inner.mid}`, { a: 'out' });
  assert.match(out.data.msg, /moves up from the waitlist/);
  assert.ok(Object.values(out.data.group.games[GAME].log).some((l) => C.logText(l) === `Last${waiter === a ? 'A' : 'B'}’s in - Last${inner === a ? 'A' : 'B'} dropped out`));
  // Tidy up for the next tests: everyone added here leaves.
  for (const p of [...phones, a, b]) assert.strictEqual((await p('DELETE', `/api/groups/${GID}/members/${p.mid}`)).data.left, true);
  await HOST('PATCH', `/api/groups/${GID}/games/${GAME}`, { cap: 10 });
});

test('members answer for themselves and their +1s; the host for anyone; strangers get the 404 a missing group gets', async () => {
  const sam = client(); await sam('POST', `/api/join/${CODE}`, {});
  const samC = client();
  // Sam's browser from before: re-join by seat is refused (taken), so use the original: find via a new join of a fresh seat.
  const jo = client();
  const jj = await jo('POST', `/api/join/${CODE}`, { seat: mid('Jo') });
  assert.strictEqual(jj.status, 200);
  assert.strictEqual((await jo('PUT', `/api/groups/${GID}/games/${GAME}/rsvp/${mid('Mia')}`, { a: 'in' })).status, 403, 'not for someone else');
  const r = await jo('PUT', `/api/groups/${GID}/games/${GAME}/rsvp/${mid('Jo')}`, { a: 'in' });
  assert.deepStrictEqual([r.status, r.data.msg], [200, 'You’re in! 🙌']);
  const gx = await jo('POST', `/api/groups/${GID}/games/${GAME}/guests`, { name: 'Marcus', skill: 5 });
  assert.strictEqual(gx.status, 200, gx.text);
  const xid = Object.keys(gx.data.group.games[GAME].guests)[0];
  assert.strictEqual(gx.data.group.games[GAME].guests[xid].skill, 5, 'the bringer sees their guest’s number');
  assert.strictEqual((await HOST('PUT', `/api/groups/${GID}/games/${GAME}/rsvp/${mid('Mia')}`, { a: 'maybe' })).status, 200, 'the host answers for anyone');
  const mia = client(); await mia('POST', `/api/join/${CODE}`, { seat: mid('Mia') });
  const mv = await mia('GET', `/api/groups/${GID}`);
  assert.ok(!('skill' in mv.data.group.games[GAME].guests[xid]), 'a +1’s number is for the host and the bringer');
  assert.strictEqual((await mia('PUT', `/api/groups/${GID}/games/${GAME}/rsvp/${xid}`, { a: 'out' })).status, 403);
  assert.strictEqual((await mia('PUT', `/api/groups/${GID}/games/${GAME}/rsvp/${mid('Mia')}`, { a: 'perhaps' })).status, 400);
  // Host-only things.
  assert.strictEqual((await mia('POST', `/api/groups/${GID}/games/${GAME}/teams`, { sides: 2 })).status, 403);
  assert.strictEqual((await mia('PATCH', `/api/groups/${GID}/games/${GAME}`, { cap: 4 })).status, 403);
  assert.strictEqual((await mia('PUT', `/api/groups/${GID}/lines`, { lines: [] })).status, 403);
  assert.strictEqual((await mia('PATCH', `/api/groups/${GID}`, { name: 'Mine' })).status, 401, 'group settings need the host’s account');
  // Strangers: every route is the missing group's 404, signed in or not.
  const stranger = await register('stranger@example.com');
  for (const [m, p, b] of [['GET', `/api/groups/${GID}`], ['PUT', `/api/groups/${GID}/games/${GAME}/rsvp/${mid('Jo')}`, { a: 'out' }], ['POST', `/api/groups/${GID}/games/${GAME}/guests`, { name: 'x' }], ['PATCH', `/api/groups/${GID}`, { name: 'x' }], ['DELETE', `/api/groups/${GID}`], ['PUT', `/api/groups/${GID}/games/${GAME}/paid/${mid('Jo')}`, {}], ['PATCH', `/api/groups/${GID}/members/${mid('Jo')}`, { name: 'x' }]]) {
    for (const who of [stranger, client()]) {
      const x = await who(m, p, b);
      const signedInOnly = (m === 'PATCH' || m === 'DELETE') && p === `/api/groups/${GID}`;
      assert.strictEqual(x.status, signedInOnly && who !== stranger ? 401 : 404, `${m} ${p}: ${x.status}`);
    }
  }
  const missing = await stranger('GET', '/api/groups/AAAAAAAAAAAAAAAA');
  assert.strictEqual(missing.data.error, (await stranger('GET', `/api/groups/${GID}`)).data.error, 'the same words as a group that does not exist');
  void sam; void samC;
});

test('teams, results, votes and Paid over HTTP: the core’s rules, and skill numbers never leak in a response', async () => {
  const joC = client(); await joC('POST', `/api/join/${CODE}`, {}); // a fresh browser: not Jo
  // Make teams with five or so in.
  for (const n of ['Host', 'Sam', 'Mia', 'Priya', 'Tom']) await HOST('PUT', `/api/groups/${GID}/games/${GAME}/rsvp/${n === 'Host' ? 'mhost0001' : mid(n)}`, { a: 'in' });
  const t = await HOST('POST', `/api/groups/${GID}/games/${GAME}/teams`, { sides: 2 });
  assert.strictEqual(t.status, 200, t.text);
  const teams = t.data.group.games[GAME].teams;
  assert.ok(teams.sides.length === 2 && typeof teams.gap === 'number');
  const team = (id) => teams.sides.findIndex((s) => s.includes(id));
  assert.notStrictEqual(team(mid('Sam')), team(mid('Jo')), 'Sam and Jo kept apart');
  const re = await HOST('POST', `/api/groups/${GID}/games/${GAME}/teams`, { sides: 2, n: 1 });
  assert.notDeepStrictEqual(re.data.group.games[GAME].teams.sides, teams.sides, 'reshuffle gives a different split');
  // What Mia's phone gets: no skill but hers, nothing in teams that carries a number per person.
  const mia = client(); const mj = await mia('POST', `/api/join/${CODE}`, { name: 'Mia Two' });
  const seen = (await mia('GET', `/api/groups/${GID}`)).text;
  const doc = await store.get('groups', GID);
  const skills = doc.members.filter((m) => m.id !== mj.data.me && m.skill).map((m) => `"skill":${m.skill}`);
  assert.ok(skills.length >= 2);
  assert.ok(!/"skill":[1-5]/.test(seen.replace(new RegExp(`"id":"${mj.data.me}"[^}]*`), '')), 'no other regular’s skill in a member’s response');
  assert.ok(!/"adj"/.test(seen));
  // Results: before kickoff a score can still be entered (games get played early); the host wraps up after kickoff.
  const res1 = await HOST('POST', `/api/groups/${GID}/games/${GAME}/matches`, { a: 0, b: 1, sa: 11, sb: 7 });
  assert.strictEqual(res1.status, 200, res1.text);
  assert.match(res1.data.msg, /beat .* 11-7/);
  assert.strictEqual((await HOST('POST', `/api/groups/${GID}/games/${GAME}/matches`, { a: 0, b: 5, w: 'a' })).status, 400);
  // Paid and votes need kickoff: move the game into the past by rewriting its date (as a host would after the fact).
  const past = C.addDays(C.localDate(Date.now(), TZ), -1);
  await HOST('PATCH', `/api/groups/${GID}/games/${GAME}`, { date: past });
  const now = (await HOST('GET', `/api/groups/${GID}`)).data;
  const g = now.group;
  assert.ok(g.games[GAME], 'yesterday’s game is still this week’s until it’s done');
  const sam = client(); // Sam's own browser: take a fresh seat isn't possible; use the host to tick Sam.
  const paid = await HOST('PUT', `/api/groups/${GID}/games/${GAME}/paid/${mid('Sam')}`, { paid: true });
  assert.strictEqual(paid.status, 200, paid.text);
  assert.ok(paid.data.group.games[GAME].paid[mid('Sam')]);
  assert.strictEqual((await mia('PUT', `/api/groups/${GID}/games/${GAME}/paid/${mid('Sam')}`, { paid: false })).status, 403, 'tick your own only');
  // Votes: the host votes; Mia did not play, so she can't.
  const hv = await HOST('PUT', `/api/groups/${GID}/games/${GAME}/vote`, { cand: mid('Sam') });
  assert.strictEqual(hv.status, 200, hv.text);
  assert.strictEqual((await mia('PUT', `/api/groups/${GID}/games/${GAME}/vote`, { cand: mid('Sam') })).status, 403);
  const mv = (await mia('GET', `/api/groups/${GID}`)).data.group.games[GAME];
  assert.deepStrictEqual([mv.votes, mv.voteCount], [{}, 1], 'votes are secret until voting closes - a count only');
  const hostView = (await HOST('GET', `/api/groups/${GID}`)).data.group.games[GAME];
  assert.deepStrictEqual(hostView.votes, { mhost0001: mid('Sam') }, 'even the host sees only their own vote');
  const closed = await HOST('POST', `/api/groups/${GID}/games/${GAME}/vote/close`, {});
  assert.deepStrictEqual(closed.data.group.games[GAME].votes, { mhost0001: mid('Sam') }, 'revealed once closed');
  // Wrap up: next week opens, regulars not answered yet.
  const done = await HOST('POST', `/api/groups/${GID}/games/${GAME}/done`, {});
  assert.strictEqual(done.status, 200, done.text);
  const games = C.games(done.data.group);
  assert.strictEqual(games.length, 2);
  assert.deepStrictEqual(games[1].rsvps, {});
  assert.strictEqual(C.weekday(games[1].date), 3);
  void joC; void sam;
});

test('applying a pasted chat online: the host only; names nobody matched become regulars first', async () => {
  const g0 = (await HOST('GET', `/api/groups/${GID}`)).data.group;
  const next = C.latest(g0).id;
  const r = await HOST('POST', `/api/groups/${GID}/games/${next}/rsvps`, { answers: [{ id: mid('Sam'), a: 'in' }, { id: mid('Tom'), a: 'out' }], add: [{ name: 'Newbie', a: 'in', plus: 1 }] });
  assert.strictEqual(r.status, 200, r.text);
  const g = r.data.group;
  const nb = g.members.find((m) => m.name === 'Newbie');
  assert.ok(nb && !nb.joined, 'a new regular, as an open seat');
  assert.deepStrictEqual([g.games[next].rsvps[mid('Sam')].a, g.games[next].rsvps[mid('Tom')].a, g.games[next].rsvps[nb.id].a], ['in', 'out', 'in']);
  assert.strictEqual(Object.values(g.games[next].guests).filter((x) => x.by === nb.id).length, 1);
  const mia = client(); await mia('POST', `/api/join/${CODE}`, { name: 'Pasty' });
  assert.strictEqual((await mia('POST', `/api/groups/${GID}/games/${next}/rsvps`, { answers: [{ id: mid('Sam'), a: 'out' }] })).status, 403);
  assert.strictEqual((await mia('POST', `/api/groups/${GID}/games/${next}/rsvps`, { add: [{ name: 'Sneaky', a: 'in' }] })).status, 403);
});

test('the host’s side: rename, settings, code rotation, a regulars cap; delete; nothing identifying stored', async () => {
  let r = await HOST('PATCH', `/api/groups/${GID}`, { name: 'Thursday <b>Hoops</b>', sched: { time: '20:00', cost: '$55' }, cur: 'GBP' });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual([r.data.group.name, r.data.group.sched.time, r.data.group.sched.cost, r.data.group.cur], ['Thursday Hoops', '20:00', 5500, 'GBP']);
  assert.strictEqual((await HOST('PATCH', `/api/groups/${GID}`, { sched: { cap: 999 } })).status, 400);
  const old = CODE;
  r = await HOST('POST', `/api/groups/${GID}/code`, {});
  CODE = r.data.group.code;
  assert.notStrictEqual(CODE, old);
  assert.strictEqual((await client()('GET', `/api/join/${old}`)).status, 404, 'the old link dies');
  assert.strictEqual((await HOST('PUT', `/api/groups/${GID}/lines`, { lines: [{ a: mid('Sam'), b: mid('Mia'), k: 'together' }, { a: mid('Sam'), b: 'mnope0001' }] })).data.group.lines.length, 1);
  r = await HOST('POST', `/api/groups/${GID}/members`, { names: ['Uma', 'Vic', 'uma'] });
  assert.deepStrictEqual(r.data.added.length, 2);
  const names = Array.from({ length: 45 }, (_, i) => `Extra${i}`);
  assert.strictEqual((await HOST('POST', `/api/groups/${GID}/members`, { names })).status, 409, `at most ${C.LIMITS.members} regulars`);
  // Nothing identifying stored: no email, no account id; tags and hashes only.
  const raw = JSON.stringify(await store.get('groups', GID));
  assert.ok(!/example\.com/.test(raw), 'no email');
  assert.ok(!raw.includes(uidOf('ana.host@example.com')), 'no account id');
  assert.ok(!/pickup_k|[A-Za-z0-9_-]{22}"/.test(raw.replace(/"(keyHash|ownerTag|acct)":"[^"]+"/g, '').replace(/"acctTags":\[[^\]]*\]/, '')), 'no browser key');
  // My groups, then delete.
  const mine = await HOST('GET', '/api/groups');
  assert.ok(mine.data.groups.some((x) => x.id === GID && x.host));
  const sam = client(); await sam('POST', `/api/join/${CODE}`, { name: 'Late Joiner' });
  assert.strictEqual((await sam('DELETE', `/api/groups/${GID}`)).status, 401);
  assert.strictEqual((await HOST('DELETE', `/api/groups/${GID}`)).status, 200);
  assert.strictEqual((await sam('GET', `/api/groups/${GID}`)).status, 404);
});

test('limits: five groups a host; distinct wrong codes are counted; an idle group is deleted by the read that finds it', async () => {
  const h = await register('busy.host@example.com');
  for (let i = 0; i < 5; i++) assert.strictEqual((await h('POST', '/api/groups', { group: phoneGroup(), tz: TZ })).status, 200);
  assert.strictEqual((await h('POST', '/api/groups', { group: phoneGroup(), tz: TZ })).status, 409);
  const guesser = client();
  for (let i = 0; i < G.LIMITS.missesPerIp; i++) await guesser('GET', `/api/join/${'ABCDEFGHJK'[i % 10]}${'ABCDEFGHJK'[Math.floor(i / 10)]}ZZZZ`);
  assert.strictEqual((await guesser('GET', '/api/join/ZZZZZZ')).status, 429);
  const poller = client();
  for (let i = 0; i < 40; i++) assert.strictEqual((await poller('GET', '/api/groups/AAAAAAAAAAAAAAAA')).status, 404, 'the same dead id is not guessing');
  const rows = (await h('GET', '/api/groups')).data.groups;
  const id = rows[0].id;
  const doc = await store.get('groups', id);
  doc.updatedAt = new Date(Date.now() - 181 * 86400e3).toISOString();
  await store.set('groups', id, doc);
  const r = await h('GET', `/api/groups/${id}`);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(await store.get('groups', id), null, 'deleted by the read that found it');
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use((req, res, next) => (req.path === '/pickup' ? res.redirect(301, '/pickup/') : next()));
  host.use('/pickup', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/pickup`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (e) { failed++; console.log(`  FAIL ${t.name}\n${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
