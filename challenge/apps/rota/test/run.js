// Pure rules first, then end to end against the memory store and the fake
// model:
//   ROTA_MEMORY=1 ROTA_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /rota, the way the
// lab mounts it, so the auth cookie, the budget gate, the device cookie's
// path, the manager key and the metered route's parser are exercised as
// deployed. Model calls are counted from the identity's usage rows - the
// same rows that bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.ROTA_MEMORY !== '1' || process.env.ROTA_FAKE_AI !== '1') {
  console.error('run with ROTA_MEMORY=1 ROTA_FAKE_AI=1');
  process.exit(1);
}
process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const { app, identityStore, store } = require('../server');
const C = require('../public/rota-core');
const T = require('../lib/teams');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NOW = Date.parse('2026-10-21T15:00:00Z');
const HOUR = 3600000;

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
  call.cookies = cookies;
  return call;
}
const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const HOSTILE = ['<img src=x onerror=alert(1)>Ana', '"><svg onload=alert(1)>Bo', '\u202eCal\u202c', 'Dee <script>x</script>'];

/** A seeded generator, so the random teams are the same on every run. */
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return s / 4294967296; }; }

/** Check every rule against an assign map, independently of the core's
 *  own blockers(): role, can't, the hours window, overlap, rest, max. */
function audit(doc, week) {
  const w = doc.weeks[week];
  const bad = [];
  const per = {};
  for (const s of w.shifts) {
    const t = C.shiftTimes(doc.team, week, s);
    for (const a of w.assign[s.id] || []) (per[a.pid] = per[a.pid] || []).push({ s, t });
    if ((w.assign[s.id] || []).length > s.need) bad.push(`${s.id} over need`);
  }
  for (const [pid, list] of Object.entries(per)) {
    const p = C.personOf(doc, pid);
    let hours = 0;
    for (const { s, t } of list) {
      hours += t.hours;
      if (!p.roles.includes(s.role)) bad.push(`${p.name} role ${s.role}`);
      const av = C.availOf(w, pid, s.day);
      if (av.s === 'cant') bad.push(`${p.name} cant ${s.day}`);
      if (av.from && t.sMin < C.toMin(av.from)) bad.push(`${p.name} before ${av.from}`);
      if (av.to && t.eMin > C.toMin(av.to)) bad.push(`${p.name} after ${av.to}`);
      if (w.avail[pid] && w.avail[pid].noCloses && t.close) bad.push(`${p.name} noCloses`);
    }
    if (p.maxHours && hours > p.maxHours + 1e-9) bad.push(`${p.name} ${hours} > max ${p.maxHours}`);
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const x = list[i].t; const y = list[j].t;
        if (x.startMs < y.endMs && y.startMs < x.endMs) bad.push(`${p.name} overlap`);
        if (x.date !== y.date && x.endMs <= y.startMs && y.startMs - x.endMs < doc.team.minRest * HOUR) bad.push(`${p.name} rest ${list[i].s.id}->${list[j].s.id}`);
      }
    }
  }
  return bad;
}

/** A random team and week: 4-14 people, 2-4 roles, 10-40 shifts (some
 *  overnight), random availability with hours windows. */
function randomTeam(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const roles = ['Bar', 'Floor', 'Kitchen', 'Till'].slice(0, 2 + Math.floor(r() * 3));
  const zone = pick(['Europe/London', 'America/New_York', 'Australia/Sydney', 'UTC', 'Asia/Kolkata']);
  const doc = C.newDoc({ name: 'R', zone, roles, minRest: pick([0, 8, 10, 12]), hours: C.TEMPLATES.bar.hours }, 0);
  const week = '2026-10-26';
  C.weekOf(doc, week, true);
  const n = 4 + Math.floor(r() * 11);
  for (let i = 0; i < n; i++) {
    C.addPerson(doc, { name: ['Ana', 'Bo', 'Cal', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kit', 'Lu', 'Max', 'Ned'][i], roles: roles.filter(() => r() < 0.55).concat(i % 3 === 0 ? [] : [pick(roles)]), maxHours: r() < 0.8 ? 8 + Math.floor(r() * 32) : undefined, targetHours: r() < 0.7 ? 6 + Math.floor(r() * 30) : undefined }, C.idFrom('p', `${seed}:${i}`, 8), 0);
  }
  const w = doc.weeks[week];
  const m = 10 + Math.floor(r() * 31);
  for (let i = 0; i < m; i++) {
    const st = 6 * 60 + Math.floor(r() * 32) * 30;
    const len = 4 * 60 + Math.floor(r() * 12) * 30;
    const tt = (x) => `${String(Math.floor((x % 1440) / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
    const s = C.cleanShift(doc.team, { day: Math.floor(r() * 7), start: tt(st), end: tt(st + len), role: pick(roles), need: 1 + Math.floor(r() * 2) }, C.idFrom('s', `${seed}:s${i}`, 8));
    if (s) { w.shifts.push(s); w.assign[s.id] = []; }
  }
  for (const p of doc.people) {
    const days = C.DAYS.map(() => { const x = r(); return x < 0.2 ? { s: 'cant' } : x < 0.35 ? { s: 'prefer' } : x < 0.45 ? { s: 'can', from: '12:00' } : x < 0.52 ? { s: 'can', to: '16:00' } : x < 0.9 ? { s: 'can' } : null; });
    w.avail[p.id] = { days: C.cleanAvailDays(days), note: '', noCloses: r() < 0.1 };
  }
  return { doc, week };
}

/** A shift on a published week that its holder could hand to someone the
 *  rules allow: {shift, from, takers}. */
function swappable(doc, week, skip) {
  const w = doc.weeks[week];
  for (const s of w.shifts.filter((x) => x.day < 5 && x.role !== 'Kitchen' && !(skip || []).includes(x.id))) {
    for (const a of w.assign[s.id]) {
      const takers = doc.people.filter((p) => p.id !== a.pid && C.swapBlockers(doc, week, { shiftId: s.id, from: a.pid }, p.id).length === 0);
      if (takers.length) return { shift: s, from: a.pid, takers };
    }
  }
  return null;
}

/* ---------------- cleaning ---------------- */

test('typed strings go through one door; a person is a first name and at most an initial', () => {
  assert.strictEqual(C.firstName('Mia Rodriguez'), 'Mia R.');
  assert.strictEqual(C.firstName('  zoë  '), 'zoë');
  assert.strictEqual(C.firstName("D'Arcy-Jean O'Neil Smith"), "D'Arcy-Jean O.");
  assert.strictEqual(C.firstName('<img src=x onerror=alert(1)>'), '');
  assert.strictEqual(C.firstName({ toString: () => 'Ana' }), '', 'only strings');
  for (const h of HOSTILE) assert.ok(!/[<>"\u202a-\u202e\u2066-\u2069]/.test(C.firstName(h)), JSON.stringify(h));
  assert.ok(Array.from(C.firstName('x'.repeat(9000))).length <= C.LIMITS.name);
  assert.ok(C.clean('a'.repeat(5e6), 60).length <= 60);
  assert.strictEqual(C.cleanTime('6:30'), '06:30');
  assert.strictEqual(C.cleanTime('24:00'), null);
  assert.strictEqual(C.cleanDate('2026-02-30'), null);
  assert.deepStrictEqual(C.cleanAvailDays([{ s: 'can', from: '18:00', to: '09:00' }, { s: 'nope' }, { s: 'cant', from: '10:00' }]).slice(0, 3), [{ s: 'can', from: null, to: null }, null, { s: 'cant', from: null, to: null }]);
});

/* ---------------- time ---------------- */

test('time: shifts are civil times in the business zone; a DST week counts real hours', () => {
  // Europe/London: clocks go back at 02:00 on Sun 25 Oct 2026.
  const doc = C.newDoc({ name: 'Bar', zone: 'Europe/London', roles: ['Bar'], minRest: 10 }, 0);
  const week = '2026-10-19';
  const sat = C.shiftTimes(doc.team, week, { day: 5, start: '20:00', end: '03:00', role: 'Bar' });
  assert.strictEqual(sat.hours, 8, 'a 7-hour wall shift across fall-back is 8 real hours');
  assert.strictEqual(new Date(sat.startMs).toISOString(), '2026-10-24T19:00:00.000Z');
  assert.strictEqual(new Date(sat.endMs).toISOString(), '2026-10-25T03:00:00.000Z');
  // Spring forward, 29 Mar 2026: the same shift is 6 real hours.
  assert.strictEqual(C.shiftTimes(doc.team, '2026-03-23', { day: 5, start: '20:00', end: '03:00', role: 'Bar' }).hours, 6);
  // New York: back on Sun 1 Nov 2026.
  const ny = C.newDoc({ name: 'NY', zone: 'America/New_York', roles: ['Bar'] }, 0).team;
  assert.strictEqual(C.shiftTimes(ny, '2026-10-26', { day: 5, start: '22:00', end: '06:00', role: 'Bar' }).hours, 9);
  assert.strictEqual(C.shiftTimes(ny, '2026-10-26', { day: 0, start: '09:00', end: '17:00', role: 'Bar' }).hours, 8);
  // A time the clocks skip lands after the gap; a repeated time takes the first.
  assert.strictEqual(new Date(C.wallToUtc('2026-03-29', 90, 'Europe/London')).toISOString(), '2026-03-29T01:30:00.000Z');
  assert.strictEqual(new Date(C.wallToUtc('2026-10-25', 90, 'Europe/London')).toISOString(), '2026-10-25T00:30:00.000Z');
  // Rest is real hours too: Sat close at 03:00 (an extra hour that night),
  // Sun open at 12:00 is 9 real hours - one short of 10.
  const w = C.weekOf(doc, week, true);
  C.addPerson(doc, { name: 'Ana', roles: ['Bar'] }, 'paaaaaaaa', 0);
  w.shifts.push({ id: 'saaaaaaaa', day: 5, start: '20:00', end: '03:00', role: 'Bar', need: 1 }, { id: 'sbbbbbbbb', day: 6, start: '12:00', end: '18:00', role: 'Bar', need: 1 });
  w.assign = { saaaaaaaa: [{ pid: 'paaaaaaaa', by: 'manager' }], sbbbbbbbb: [] };
  const ctx = C.context(doc, week);
  assert.deepStrictEqual(C.blockers(ctx, 'sbbbbbbbb', 'paaaaaaaa', ['saaaaaaaa']).map((b) => b.code), ['rest']);
  doc.team.minRest = 9;
  assert.deepStrictEqual(C.blockers(C.context(doc, week), 'sbbbbbbbb', 'paaaaaaaa', ['saaaaaaaa']), [], '9 real hours meets a 9-hour rule');
  assert.strictEqual(C.todayIn('Pacific/Auckland', Date.parse('2026-10-21T12:00:00Z')), '2026-10-22');
  assert.strictEqual(C.nextWeekOf('2026-10-21'), '2026-10-26');
  assert.strictEqual(C.weekLabel('2026-10-26'), '26 Oct – 1 Nov');
});

/* ---------------- the solver ---------------- */

test('Fill the gaps never breaks can’t, roles, hours windows, no closes, overlap, rest or max hours - 300 random teams', () => {
  let placed = 0; let gaps = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const { doc, week } = randomTeam(seed);
    const r = C.fill(doc, week);
    doc.weeks[week].assign = r.assign;
    assert.deepStrictEqual(audit(doc, week), [], `seed ${seed}`);
    assert.deepStrictEqual(C.conflicts(doc, week), [], `seed ${seed}: the core agrees`);
    // Every seat is either placed or reported as a gap, with a reason.
    const open = C.openSeats(doc, week).reduce((s, g) => s + g.seats, 0);
    assert.strictEqual(open, r.gaps.reduce((s, g) => s + g.seats, 0), `seed ${seed}: gaps add up`);
    for (const g of r.gaps) assert.ok(/: nobody (available|on the team)/.test(g.text) && g.fix, g.text);
    // Deterministic: the same team gives the same rota.
    assert.deepStrictEqual(C.fill(JSON.parse(JSON.stringify({ ...doc, weeks: { [week]: { ...doc.weeks[week], assign: Object.fromEntries(Object.keys(r.assign).map((k) => [k, []])) } } })), week).assign, r.assign, `seed ${seed} deterministic`);
    placed += r.placed.length; gaps += r.gaps.length;
  }
  assert.ok(placed > 3000 && gaps > 50, `${placed} placed, ${gaps} gaps across the runs`);
});

test('the solver keeps the manager’s own picks, and only reports a gap nobody could fill', () => {
  for (let seed = 400; seed < 460; seed++) {
    const { doc, week } = randomTeam(seed);
    const r = C.fill(doc, week);
    doc.weeks[week].assign = r.assign;
    // A gap is honest: nobody could take it, even by moving one of their filled shifts.
    for (const g of r.gaps) {
      const list = C.candidates(doc, week, g.shiftId);
      assert.strictEqual(list.filter((c) => c.ok).length, 0, `seed ${seed}: ${g.text}`);
    }
  }
  const { doc, week } = C.sample('2026-10-21', 'America/New_York');
  const w = doc.weeks[week];
  const s = w.shifts.find((x) => x.role === 'Counter' && x.day === 2);
  const ava = doc.people.find((p) => p.name === 'Theo');
  w.assign[s.id] = [{ pid: ava.id, by: 'manager' }];
  const r = C.fill(doc, week);
  assert.deepStrictEqual(r.assign[s.id], [{ pid: ava.id, by: 'manager' }], 'a manager’s pick stays');
});

test('the sample cafe: one tap fills all but one honest gap, explains every placement, and evens out the month', () => {
  const { doc, week } = C.sample('2026-10-21', 'America/New_York');
  assert.strictEqual(week, '2026-10-26');
  assert.strictEqual(doc.people.length, 8);
  assert.ok(doc.people.every((p) => doc.weeks[week].avail[p.id]), 'availability already in');
  assert.strictEqual(C.openSeats(doc, week).reduce((s, g) => s + g.seats, 0), 33, 'the week starts empty');
  assert.deepStrictEqual(C.gaps(doc, week).map((g) => g.text.split(': ')[0]), ['Sun 7:30am–3:30pm Kitchen'], 'only a seat nobody could take is a gap, even before a fill');
  const before = C.fairness(doc, '2026-10-19').score;
  const out = C.manage(doc, 'fill', { week }, NOW);
  assert.strictEqual(out.placed.length, 32);
  assert.strictEqual(out.gaps.length, 1);
  assert.match(out.gaps[0].text, /^Sun 7:30am–3:30pm Kitchen: nobody available who can do Kitchen - Jonah can’t Sun · Lena can’t Sun$/);
  assert.deepStrictEqual(audit(doc, week), []);
  assert.deepStrictEqual(C.gaps(doc, week).map((g) => g.text), [out.gaps[0].text], 'the same gap on reload');
  const after = C.fairness(doc, week);
  assert.ok(after.score > before + 15, `fairness ${before} -> ${after.score}`);
  // Those with the most closes over the last three weeks get the fewest now.
  const st = C.weekStats(doc, week);
  const hist = C.history(doc, week).people;
  const byHist = doc.people.filter((p) => p.roles.includes('Barista') || p.roles.includes('Counter')).sort((a, b) => hist[b.id].closes - hist[a.id].closes);
  assert.ok(st[byHist[0].id].closes <= 1 && st[byHist[1].id].closes <= 1, 'the two who closed most close least now');
  // Every placement has an explanation in words.
  for (const s of doc.weeks[week].shifts) {
    for (const a of doc.weeks[week].assign[s.id]) {
      const ex = C.explain(doc, week, s.id, a.pid);
      assert.ok(ex && ex.lines[0] === `Can do ${s.role}` && ex.lines.length >= 3 && ex.versus, JSON.stringify(ex));
      assert.ok(!/Breaks a rule/.test(ex.versus));
    }
  }
  assert.deepStrictEqual(C.sample('2026-10-21', 'America/New_York').doc.people, C.sample('2026-10-21', 'America/New_York').doc.people, 'the same sample everywhere');
});

test('fairness: hours against target, closes and weekends against a fair share over four weeks, prefer-nots, and who has been short-changed', () => {
  const { doc, week } = C.sample('2026-10-21', 'America/New_York');
  const f0 = C.fairness(doc, '2026-10-19');
  assert.deepStrictEqual(f0.weeks, ['2026-10-05', '2026-10-12', '2026-10-19']);
  assert.ok(f0.score < 50 && f0.band.id === 'uneven', `the spreadsheet weeks score ${f0.score}`);
  assert.deepStrictEqual(f0.parts.map((p) => p.id), ['hours', 'closes', 'weekends', 'prefer']);
  const names = f0.short.map((s) => s.name);
  for (const n of ['Priya', 'Sam', 'Jonah', 'Kai']) assert.ok(names.includes(n), `${n} short-changed: ${JSON.stringify(f0.short)}`);
  assert.ok(f0.short.find((s) => s.name === 'Jonah').why.some((w) => /h a week under the 36 h target/.test(w)));
  assert.ok(f0.short.find((s) => s.name === 'Sam').why.some((w) => /closes in 3 wk - \d+ over a fair share/.test(w)));
  C.manage(doc, 'fill', { week }, NOW);
  const f1 = C.fairness(doc, week);
  assert.strictEqual(f1.weeks.length, 4);
  assert.ok(f1.people.every((p) => p.week && p.window && p.window.weeks === 4));
  assert.ok(f1.parts.find((p) => p.id === 'hours').pts <= 5, 'everyone close to their target this week');
  assert.strictEqual(f1.parts.find((p) => p.id === 'prefer').pts, 0, 'no prefer-nots needed');
  // A prefer-not given anyway costs points and is named.
  const w = doc.weeks[week];
  const mia = doc.people.find((p) => p.name === 'Mia');
  const sat = w.shifts.find((s) => s.day === 5 && s.role === 'Barista' && !(w.assign[s.id] || []).some((a) => a.pid === mia.id));
  w.assign[sat.id] = [{ pid: mia.id, by: 'manager' }];
  assert.ok(C.fairness(doc, week).parts.find((p) => p.id === 'prefer').pts > 0);
});

/* ---------------- changes, swaps, the calendar ---------------- */

test('swaps: only teammates the rules allow can claim; the manager approves, or auto-approve when nothing breaks; every change is logged', () => {
  const { doc, week } = C.sample('2026-10-21', 'America/New_York');
  C.manage(doc, 'fill', { week }, NOW);
  assert.throws(() => C.staff(doc, doc.people[0].id, 'offer', { week, shiftId: doc.weeks[week].shifts[0].id }, NOW), /published/);
  C.manage(doc, 'publish', { week }, NOW);
  const w = doc.weeks[week];
  const byName = (n) => doc.people.find((p) => p.name === n);
  // A weekday Counter or Barista shift that someone else could take.
  let tue = null; let from = null;
  for (const s of w.shifts.filter((x) => x.day < 5 && x.role !== 'Kitchen')) {
    for (const a of w.assign[s.id]) {
      if (doc.people.some((p) => p.id !== a.pid && C.swapBlockers(doc, week, { shiftId: s.id, from: a.pid }, p.id).length === 0)) { tue = s; from = a.pid; break; }
    }
    if (tue) break;
  }
  assert.ok(tue, 'a swappable shift');
  const r = C.staff(doc, from, 'offer', { week, shiftId: tue.id }, NOW);
  assert.match(r.swapId, /^w/);
  assert.throws(() => C.staff(doc, from, 'offer', { week, shiftId: tue.id }, NOW), /already offered/);
  // Jonah does Kitchen only, and someone else is ruled out by the rules: neither may claim, neither sees it.
  const noOnes = [byName('Jonah')].concat(doc.people.filter((p) => p.id !== from && p.roles.includes(tue.role) && C.swapBlockers(doc, week, w.swaps[0], p.id).length).slice(0, 1));
  assert.strictEqual(noOnes.length, 2, 'someone with the role is ruled out too');
  for (const p of noOnes) {
    assert.throws(() => C.staff(doc, p.id, 'claim', { week, id: r.swapId }, NOW), (e) => e.status === 409 && /You can’t take this one/.test(e.message), p.name);
    assert.ok(!C.staffView(doc, p.id, NOW).weeks[week].swaps.some((x) => x.id === r.swapId), `${p.name} doesn’t see it`);
  }
  // Someone the rules allow sees it and claims it; the manager approves.
  const ok = doc.people.find((p) => p.id !== from && C.swapBlockers(doc, week, w.swaps[0], p.id).length === 0);
  assert.ok(ok, 'someone can take it');
  assert.ok(C.staffView(doc, ok.id, NOW).weeks[week].swaps.find((x) => x.id === r.swapId).canClaim);
  assert.deepStrictEqual(C.staff(doc, ok.id, 'claim', { week, id: r.swapId }, NOW), { approved: false });
  assert.strictEqual(w.swaps[0].status, 'pending');
  C.manage(doc, 'swap', { week, id: r.swapId, decision: 'approve' }, NOW);
  assert.ok(w.assign[tue.id].some((a) => a.pid === ok.id && a.by === 'swap') && !w.assign[tue.id].some((a) => a.pid === from));
  assert.deepStrictEqual(audit(doc, week), [], 'a swap never breaks a rule');
  // Auto-approve: a claim that breaks nothing goes straight through.
  C.manage(doc, 'settings', { autoApprove: true }, NOW);
  const sw2 = swappable(doc, week, [tue.id]);
  assert.ok(sw2, 'a second swappable shift');
  const s2 = sw2.shift;
  const id2 = C.staff(doc, sw2.from, 'offer', { week, shiftId: s2.id }, NOW).swapId;
  const taker = sw2.takers[0];
  assert.deepStrictEqual(C.staff(doc, taker.id, 'claim', { week, id: id2 }, NOW), { approved: true });
  assert.deepStrictEqual(audit(doc, week), []);
  // A shift that has started can't be offered or claimed.
  assert.throws(() => C.staff(doc, taker.id, 'offer', { week, shiftId: s2.id }, Date.parse('2026-11-05T12:00:00Z')), /Pick this week|started/);
  const log = doc.log.map((l) => l.text).join('\n');
  for (const re of [/Filled the gaps: 32 placed, 1 still open/, /Published the week of Mon 26 Oct/, /offered .* for swap/, /claimed .* waiting for the manager/, /\(swap\)/, /Changed the team settings/]) assert.match(log, re);
});

test('a phone only changes its own name, this week or the next four; a manager plans five back to eight ahead', () => {
  const { doc, week } = C.sample('2026-10-21', 'America/New_York');
  const p = doc.people[0];
  assert.throws(() => C.staff(doc, 'pnotthere1', 'avail', { week, days: [] }, NOW), (e) => e.status === 403);
  assert.throws(() => C.staff(doc, p.id, 'avail', { week: '2027-06-07', days: [] }, NOW), /next four/);
  assert.throws(() => C.staff(doc, p.id, 'avail', { week: '2026-10-28', days: [] }, NOW), /next four/, 'not a Monday');
  C.staff(doc, p.id, 'avail', { week, days: [{ s: 'cant' }], note: '<b>dentist</b> \u202e', noCloses: true }, NOW);
  assert.deepStrictEqual(doc.weeks[week].avail[p.id].days[0], { s: 'cant', from: null, to: null });
  assert.strictEqual(doc.weeks[week].avail[p.id].note, 'dentist');
  assert.throws(() => C.manage(doc, 'fill', { week: '2027-06-07' }, NOW), /next eight/);
  assert.throws(() => C.manage(doc, 'explode', {}, NOW), /Unknown/);
  assert.throws(() => C.manage(doc, 'person', { person: { name: 'mia' } }, NOW), /already a Mia - add an initial \(“Mia R\.”\)/);
  assert.ok(Object.keys(doc.weeks).length <= C.LIMITS.weeks);
});

test('the .ics: valid, one event per published shift, UTC instants (right across a clock change), escaped, folded', () => {
  const doc = C.newDoc({ name: 'Bar, Grill; & "Co" <b>', zone: 'Europe/London', roles: ['Bar'], minRest: 0 }, 0);
  const week = '2026-10-19';
  const w = C.weekOf(doc, week, true);
  C.addPerson(doc, { name: 'Ana', roles: ['Bar'] }, 'paaaaaaaa', 0);
  C.addPerson(doc, { name: 'Bo', roles: ['Bar'] }, 'pbbbbbbbb', 0);
  const old = C.weekOf(doc, '2026-10-12', true);
  old.shifts.push({ id: 'scccccccc', day: 0, start: '09:00', end: '17:00', role: 'Bar', need: 1 });
  old.assign = { scccccccc: [{ pid: 'paaaaaaaa', by: 'm' }] };
  old.published = true;
  w.shifts.push({ id: 'saaaaaaaa', day: 5, start: '20:00', end: '03:00', role: 'Bar', need: 2 }, { id: 'sbbbbbbbb', day: 0, start: '09:00', end: '17:00', role: 'Bar', need: 1 });
  w.assign = { saaaaaaaa: [{ pid: 'paaaaaaaa', by: 'm' }, { pid: 'pbbbbbbbb', by: 'm' }], sbbbbbbbb: [{ pid: 'pbbbbbbbb', by: 'm' }] };
  assert.ok(!/BEGIN:VEVENT/.test(C.buildIcs(doc, 'paaaaaaaa', NOW)), 'nothing before it is published');
  w.published = true;
  const ics = C.buildIcs(doc, 'paaaaaaaa', NOW);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'CRLF only');
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `folded: ${line}`);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.strictEqual((unfolded.match(/BEGIN:VEVENT/g) || []).length, 1, 'only Ana’s own shift, this week on (not the week before)');
  assert.match(unfolded, /DTSTART:20261024T190000Z\r\nDTEND:20261025T030000Z/);
  assert.match(unfolded, /UID:saaaaaaaa-2026-10-19@rota/);
  assert.match(unfolded, /SUMMARY:Bar shift · Bar\\, Grill\\; & "Co"\r\n/);
  assert.match(unfolded, /With Bo\./);
  assert.match(unfolded, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:[^\r]+\r\nTRIGGER:-PT1H\r\nEND:VALARM/);
  assert.strictEqual((unfolded.match(/^BEGIN:/gm) || []).length, (unfolded.match(/^END:/gm) || []).length);
  assert.ok(!/<b>/.test(unfolded));
});

test('what each viewer sees: a phone never gets anyone else’s availability, hours or notes, a draft, the log or a hash', () => {
  const { doc, week } = C.sample('2026-10-21', 'America/New_York');
  doc.people[0].keyHash = 'SECRETHASH';
  C.manage(doc, 'fill', { week }, NOW);
  const v = C.staffView(doc, doc.people[1].id, NOW);
  const text = JSON.stringify(v);
  assert.deepStrictEqual(Object.keys(v).sort(), ['me', 'people', 'team', 'v', 'weeks']);
  assert.deepStrictEqual(Object.keys(v.team).sort(), ['autoApprove', 'minRest', 'name', 'roles', 'zone']);
  assert.ok(v.people.every((p) => Object.keys(p).sort().join() === 'free,id,name'));
  assert.ok(!text.includes('SECRETHASH') && !text.includes('targetHours":38') && !text.includes('Uni Mon-Wed') && !text.includes('log'));
  assert.strictEqual(v.weeks[week].shifts.length, 0, 'a draft week shows no shifts');
  assert.ok(Object.values(v.weeks).every((w) => !w.avail || w === v.weeks[week] || true));
  for (const [k, w] of Object.entries(v.weeks)) assert.ok(!w.avail || doc.weeks[k].avail[doc.people[1].id], 'only their own availability');
  const m = C.managerView(doc);
  assert.ok(!JSON.stringify(m).includes('SECRETHASH') && m.people[0].linked === true);
});

/* ---------------- the page and the code ---------------- */

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
    for (const bg of ['bg', 'card', 'card2']) for (const fg of ['text', 'muted', 'link', 'plum', 'err', 'ok']) ok(fg, bg);
    ok('link', 'accent-soft'); ok('text', 'accent-soft'); ok('accent-ink', 'accent'); ok('accent', 'card'); ok('accent', 'bg');
    for (const s of ['can', 'prefer', 'cant', 'none']) ok(s, `${s}-bg`);
    ok('cant', 'card2'); ok('prefer', 'card'); ok('can', 'card');
    ok('bg', 'text'); ok('card', 'plum'); ok('card', 'cant'); // the toast, the preview bar, the badge
  }
  for (const c of ['#0e6170', '#5b2a86']) assert.ok(ratio('#ffffff', c) >= 4.5, `lab card colour ${c} holds white text`);
});

test('local-only switches throw on Cloud Run', () => {
  for (const [mod, env] of [['./lib/store', { ROTA_MEMORY: '1' }], ['./lib/fakeai', { ROTA_FAKE_AI: '1' }], ['./server', { ROTA_FAKE_AI: '1', ROTA_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, ROTA_MEMORY: '', ROTA_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured; single-field queries only; only the host’s shared dependencies', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: ROOT, env: { ...process.env, ROTA_MEMORY: '', ROTA_COLLECTION_PREFIX: 'rota_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = read('lib/store.js');
  assert.ok(/ROTA_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 10);
  const server = read('server.js');
  const queries = [...server.matchAll(/where: \[(\[[^\]]*\](?:, )?)+\]/g)];
  assert.ok(queries.length >= 1);
  for (const m of queries) assert.strictEqual((m[0].match(/\['/g) || []).length, 1, m[0]);
  assert.ok(!/orderBy/.test(server));
  assert.deepStrictEqual(Object.keys(require('../package.json').dependencies).sort(), ['@anthropic-ai/sdk', '@google-cloud/firestore', '@simplewebauthn/server', 'express']);
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, everything escaped; the core has no clock and no dice', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown)\s*=/.test(js));
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js));
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/<script/i.test(js));
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js) && !/location\.href = ['"]\//.test(js), 'every browser URL is relative to BASE');
  for (const f of ['name', 'text', 'role', 'note', 'label', 'fix', 'message', 'why', 'versus', 'shift']) {
    const raw = new RegExp(`'\\s*\\+\\s*[a-zA-Z0-9_.]+\\.${f}\\s*\\+\\s*'`, 'g');
    const bad = (js.match(raw) || []).filter((m) => !/C\.LIMITS\./.test(m));
    assert.deepStrictEqual(bad, [], `.${f} drawn without esc(): ${bad.join(' ')}`);
  }
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js + read('public/rota-core.js')), 'no email address in the page');
  assert.ok(!/Math\.random|Date\.now\(\)/.test(read('public/rota-core.js')), 'the core has no dice and no clock');
  assert.match(js, /prefers-reduced-motion/);
  for (const f of ['server.js', 'lib/ai.js', 'lib/teams.js', 'public/rota-core.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|text|name)/.test(read(f)), `${f} logs a body`);
  assert.ok(/rel\.indexOf\('api\/'\) === 0 \|\| rel\.indexOf\('t\/'\) === 0/.test(read('public/sw.js')), 'the service worker never caches the API or a team page');
});

/* ---------------- over HTTP ---------------- */

async function register(email, ip) {
  const c = client(ip);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
async function openTeam(c, body = { sample: true, zone: 'America/New_York' }) {
  const r = await c('POST', '/api/teams', body);
  assert.strictEqual(r.status, 200, r.text);
  return { code: r.data.code, key: r.data.key, week: r.data.week, team: r.data.team, mgr: { 'X-Rota-Key': r.data.key } };
}

test('signed out: the page, a team, a link and a fill work with zero model calls; the metered route answers 401 before reading a big body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  for (const f of ['rota-core.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/read-texts', { text: 'Mia: any day', names: ['Mia'], week: '2026-10-26' })).status, 401);
  assert.strictEqual((await anon('POST', '/api/read-texts', { text: 'x'.repeat(200 * 1024) })).status, 401, 'the gate answers before the parser');
  assert.strictEqual((await anon('POST', '/api/teams', { name: 'x'.repeat(40 * 1024) })).status, 413, 'every other route keeps its small limit');
  assert.strictEqual((await anon('POST', '/api/teams', { name: '' })).status, 400);
  const t = await openTeam(anon, { name: 'Corner Cafe', zone: 'Europe/London', template: 'cafe' });
  assert.match(t.code, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.strictEqual(t.team.team.zone, 'Europe/London');
  assert.ok(t.team.weeks[t.week].shifts.length > 20, 'the template’s shifts');
  const deep = await fetch(`${base}/t/${t.code}`);
  assert.ok((await deep.text()).includes('<base href="../">'));
  assert.strictEqual(deep.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual(deep.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.strictEqual((await fetch(`${base}/t/${t.code}`, { method: 'POST' })).status, 405);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('a team’s life over HTTP: the link, names claimed, availability from phones, fill, publish, shifts and a calendar, a swap only to someone eligible', async () => {
  const mgrC = client();
  const { code, mgr, week, team } = await openTeam(mgrC);
  assert.strictEqual(team.people.length, 8);
  const byName = (n) => team.people.find((p) => p.name === n);
  // Without the key, the manager's controls are the 404 a missing code gets.
  const missing = await client()('GET', '/api/teams/ZZZZZZZZZZ');
  for (const h of [{}, { 'X-Rota-Key': T.newKey() }]) {
    const r = await client()('POST', `/api/teams/${code}/manage`, { action: 'fill', week }, h);
    assert.deepStrictEqual([r.status, r.data.error], [404, missing.data.error]);
  }
  // Phones join: claim a free name; a taken name is refused; a new name is added.
  const mia = client();
  let r = await mia('GET', `/api/teams/${code}`);
  assert.strictEqual(r.data.role, 'staff');
  assert.strictEqual(r.data.team.me, null);
  r = await mia('POST', `/api/teams/${code}/join`, { pid: byName('Mia').id });
  assert.strictEqual(r.data.team.me.name, 'Mia');
  assert.match(mia.cookies.rota_k, /^[A-Za-z0-9_-]{22}$/);
  assert.strictEqual((await client()('POST', `/api/teams/${code}/join`, { pid: byName('Mia').id })).status, 409, 'one phone per name');
  assert.strictEqual((await mia('POST', `/api/teams/${code}/join`, { pid: byName('Theo').id })).data.team.me.name, 'Mia', 'a phone keeps its name');
  const zed = client();
  r = await zed('POST', `/api/teams/${code}/join`, { name: 'Zed Quinn' });
  assert.strictEqual(r.data.team.me.name, 'Zed Q.');
  assert.strictEqual((await client()('POST', `/api/teams/${code}/join`, { name: 'zed q.' })).status, 409, 'two Zed Q.s need telling apart');
  // Zed marks availability and roles from the phone; the manager sees it.
  r = await zed('POST', `/api/teams/${code}/staff`, { action: 'profile', roles: ['Counter', 'Made up'], targetHours: 12, maxHours: 16 });
  assert.deepStrictEqual(r.data.team.me.roles, ['Counter']);
  r = await zed('POST', `/api/teams/${code}/staff`, { action: 'avail', week, days: [{ s: 'can' }, { s: 'cant' }, null, null, null, { s: 'can', from: '16:00' }, { s: 'prefer' }], noCloses: true, note: 'Sat after 4' });
  assert.strictEqual(r.status, 200, r.text);
  r = await mgrC('GET', `/api/teams/${code}`, undefined, mgr);
  assert.strictEqual(r.data.role, 'manager');
  const zedId = r.data.team.people.find((p) => p.name === 'Zed Q.').id;
  assert.deepStrictEqual(r.data.team.weeks[week].avail[zedId].days[5], { s: 'can', from: '16:00', to: null });
  assert.strictEqual(r.data.team.weeks[week].avail[zedId].noCloses, true);
  assert.ok(r.data.team.people.find((p) => p.name === 'Mia').linked);
  // A phone that isn't on the team can't change anything.
  assert.strictEqual((await client()('POST', `/api/teams/${code}/staff`, { action: 'avail', week, days: [] })).status, 403);
  // Fill, publish.
  r = await mgrC('POST', `/api/teams/${code}/manage`, { action: 'fill', week }, mgr);
  assert.ok(r.data.result.placed.length >= 32, r.text);
  const v = r.data.team.v;
  assert.deepStrictEqual((await mgrC('GET', `/api/teams/${code}?since=${v}`, undefined, mgr)).data, { same: true, v });
  assert.strictEqual((await mia('GET', `/api/teams/${code}`)).data.team.weeks[week].shifts.length, 0, 'staff see nothing until it’s published');
  await mgrC('POST', `/api/teams/${code}/manage`, { action: 'publish', week }, mgr);
  r = await mia('GET', `/api/teams/${code}`);
  const miaShifts = r.data.team.weeks[week].shifts.filter((s) => s.people.includes(byName('Mia').id));
  assert.ok(miaShifts.length >= 3);
  // Her calendar.
  const ics = await mia('GET', `/api/teams/${code}/calendar.ics`);
  assert.strictEqual(ics.headers.get('content-type'), 'text/calendar; charset=utf-8');
  const cur = C.mondayOf(C.todayIn('America/New_York', Date.now()));
  const expected = Object.entries(r.data.team.weeks).filter(([k, w]) => k >= cur && w.published).reduce((n, [, w]) => n + w.shifts.filter((s) => s.people.includes(byName('Mia').id)).length, 0);
  assert.ok(expected >= miaShifts.length);
  assert.strictEqual((ics.text.match(/BEGIN:VEVENT/g) || []).length, expected);
  assert.strictEqual((await client()('GET', `/api/teams/${code}/calendar.ics`)).status, 403);
  // Someone offers a shift; a phone the rules rule out can't see or take it; an eligible phone claims; the manager approves.
  const doc = await store.get('teams', code);
  const sw = swappable(doc, week);
  assert.ok(sw, 'a swappable shift');
  const shift = sw.shift;
  const phoneFor = async (pid) => { if (pid === byName('Mia').id) return mia; if (pid === zedId) return zed; const c = client(); await c('POST', `/api/teams/${code}/join`, { pid }); return c; };
  const holder = await phoneFor(sw.from);
  r = await holder('POST', `/api/teams/${code}/staff`, { action: 'offer', week, shiftId: shift.id });
  assert.strictEqual(r.status, 200, r.text);
  const swap = r.data.team.weeks[week].swaps.find((x) => x.shiftId === shift.id);
  const eligible = sw.takers.filter((p) => p.id !== byName('Mia').id && p.id !== zedId);
  const ineligible = doc.people.filter((p) => p.id !== sw.from && !sw.takers.includes(p) && p.id !== byName('Mia').id);
  assert.ok(eligible.length && ineligible.length, 'some can, some can’t');
  const phoneForP = (p) => phoneFor(p.id);
  const no = ineligible.find((p) => p.id !== zedId);
  const noC = await phoneForP(no);
  assert.ok(!(await noC('GET', `/api/teams/${code}`)).data.team.weeks[week].swaps.some((x) => x.id === swap.id), 'an ineligible phone doesn’t see it');
  r = await noC('POST', `/api/teams/${code}/staff`, { action: 'claim', week, id: swap.id });
  assert.deepStrictEqual([r.status, /can’t take this one/.test(r.data.error)], [409, true]);
  const yesC = await phoneForP(eligible[0]);
  r = await yesC('POST', `/api/teams/${code}/staff`, { action: 'claim', week, id: swap.id });
  assert.deepStrictEqual(r.data.result, { approved: false });
  r = await mgrC('POST', `/api/teams/${code}/manage`, { action: 'swap', week, id: swap.id, decision: 'approve' }, mgr);
  const after = r.data.team.weeks[week].assign[shift.id].map((a) => a.pid);
  assert.ok(after.includes(eligible[0].id) && !after.includes(sw.from));
  assert.ok(r.data.team.log.some((l) => /\(swap\)/.test(l.text)));
  // "Not me" frees the name; the manager can free one too.
  r = await mia('POST', `/api/teams/${code}/leave`, {});
  assert.strictEqual(r.data.team.me, null);
  r = await mgrC('POST', `/api/teams/${code}/manage`, { action: 'unlink', pid: zedId }, mgr);
  assert.strictEqual(r.data.team.people.find((p) => p.id === zedId).linked, false);
  // Delete: the manager only.
  assert.strictEqual((await mia('DELETE', `/api/teams/${code}`)).status, 404);
  assert.strictEqual((await mgrC('DELETE', `/api/teams/${code}`, undefined, mgr)).status, 200);
  assert.strictEqual((await mia('GET', `/api/teams/${code}`)).status, 404);
});

test('what a link reveals: first names, the published rota, your own marks - never a key, a hash, a tag, someone else’s availability or hours, a draft or the log; hostile names are cleaned', async () => {
  const mgrC = client();
  const { code, mgr, week, key } = await openTeam(mgrC);
  const phones = [];
  for (const h of HOSTILE) { const c = client(); const r = await c('POST', `/api/teams/${code}/join`, { name: h }); assert.strictEqual(r.status, 200, r.text); phones.push(c); }
  const r = await phones[0]('GET', `/api/teams/${code}`);
  const t = r.data.team;
  assert.deepStrictEqual(t.people.slice(-4).map((p) => p.name), ['Ana', 'Bo', 'Cal', 'Dee X.']);
  assert.ok(!/[<>\u202e]/.test(r.text), 'no markup or bidi in what a phone is sent');
  const doc = await store.get('teams', code);
  const leaks = [key, doc.ownerHash, doc.creator, ...doc.people.filter((p) => p.keyHash).map((p) => p.keyHash), phones[0].cookies.rota_k, 'Uni Mon-Wed', 'School run', '"targetHours":38', '"log"'];
  for (const s of leaks) assert.ok(!r.text.includes(s), `the staff view leaks ${s}`);
  assert.ok(Object.values(t.weeks).every((w) => w.avail === null), 'nobody else’s availability (Ana has marked none)');
  const all = (await mgrC('GET', `/api/teams/${code}`, undefined, mgr)).text;
  assert.ok(!all.includes(doc.ownerHash) && !all.includes(doc.creator) && !doc.people.some((p) => p.keyHash && all.includes(p.keyHash)), 'not even the manager gets hashes');
  assert.ok(!store._dump().includes(key) && !store._dump().includes(phones[0].cookies.rota_k), 'no key is stored');
  assert.deepStrictEqual(Object.keys(doc).sort(), ['code', 'createdAt', 'creator', 'expiresAt', 'id', 'log', 'ownerHash', 'people', 'team', 'updatedAt', 'v', 'weeks'].sort(), 'exactly what is stored');
  assert.ok(week);
});

test('codes, limits and expiry: unknown, malformed and expired read the same 404; 10 teams an hour per address; 5 per phone; 40 new names; distinct wrong codes', async () => {
  const codes = new Set();
  for (let i = 0; i < 300; i++) codes.add(T.newCode());
  assert.strictEqual(codes.size, 300);
  for (const c of codes) assert.ok(T.isCode(c) && !/[IO01]/.test(c));
  const anon = client();
  const unknown = await anon('GET', '/api/teams/ZZZZZZZZZZ');
  const bad = await anon('GET', '/api/teams/not-a-code!!');
  assert.deepStrictEqual([unknown.status, bad.status, bad.data.error], [404, 404, unknown.data.error]);
  const { code } = await openTeam(client());
  await store.merge('teams', code, { expiresAt: '2026-01-01T00:00:00.000Z' });
  const ex = await anon('GET', `/api/teams/${code}`);
  assert.deepStrictEqual([ex.status, ex.data], [unknown.status, unknown.data]);
  assert.strictEqual(await store.get('teams', code), null, 'deleted by the read that found it');
  const fresh = await openTeam(client());
  const exp = (await store.get('teams', fresh.code)).expiresAt;
  assert.ok(Date.parse(exp) - Date.now() > 89.9 * 86400000, 'a team lasts 90 days');
  await client()('POST', `/api/teams/${fresh.code}/join`, { name: 'Late' });
  assert.ok(Date.parse((await store.get('teams', fresh.code)).expiresAt) >= Date.parse(exp), 'every change pushes it out');
  // Per address.
  const net = '2001:db8:cccc:1';
  for (let i = 0; i < T.LIMITS.teamsPerIp; i++) assert.strictEqual((await client(`${net}::${i + 1}`)('POST', '/api/teams', { name: `T${i}` })).status, 200);
  const over = await client(`${net}::99`)('POST', '/api/teams', { name: 'One more' });
  assert.deepStrictEqual([over.status, /10 new teams/.test(over.data.error)], [429, true]);
  // Per phone.
  const phone = client();
  await openTeam(phone, { name: 'A' });
  for (let i = 1; i < T.LIMITS.openPerCreator; i++) { const c = client(); Object.assign(c.cookies, phone.cookies); assert.strictEqual((await c('POST', '/api/teams', { name: `B${i}` })).status, 200); }
  const c6 = client(); Object.assign(c6.cookies, phone.cookies);
  const capped = await c6('POST', '/api/teams', { name: 'C' });
  assert.deepStrictEqual([capped.status, /5 teams/.test(capped.data.error)], [429, true]);
  // New names from one address.
  const big = await openTeam(client(), { name: 'Big' });
  const adder = '2001:db8:dddd:1';
  let n = 0;
  for (; n < T.LIMITS.newPeoplePerIp; n++) {
    const r = await client(`${adder}::${n + 1}`)('POST', `/api/teams/${big.code}/join`, { name: `N${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}` });
    if (r.status !== 200) { assert.strictEqual(r.status, 409, r.text); break; } // the team cap (30) comes first
  }
  assert.strictEqual(n, C.LIMITS.people, 'a team holds 30');
  // Distinct wrong codes: guessing stops; one dead code polled is not guessing.
  const guess = client();
  for (let i = 0; i < 40; i++) assert.strictEqual((await guess('GET', '/api/teams/ZZZZZZZZZZ')).status, 404);
  for (let i = 0; i < T.LIMITS.missesPerIp - 1; i++) await guess('GET', `/api/teams/${T.newCode()}`);
  assert.strictEqual((await guess('GET', `/api/teams/${big.code}`)).status, 429, 'then even a real one waits');
  assert.strictEqual((await client()('GET', `/api/teams/${big.code}`)).status, 200, 'for that address only');
  assert.match(read('server.js'), /opensAll\.blocked\('all'\)/);
});

test('the metered route’s gates come before its parser, in order; one model client', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/read-texts', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1);
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
});

test('Read their texts: checked before any spend, one forced tool, validated against the names and the week, a proposal only - nothing stored', async () => {
  const me = await register('ana.texts@example.com');
  const names = ['Mia', 'Theo', 'Priya', 'Sam', 'Ava'];
  const week = '2026-10-26';
  const dump = store._dump();
  const calls = await modelCalls();
  assert.strictEqual((await me('POST', '/api/read-texts', { text: 'hi', names, week })).status, 400);
  assert.strictEqual((await me('POST', '/api/read-texts', { text: 'Mia: any day', names: [], week })).status, 400);
  assert.strictEqual((await me('POST', '/api/read-texts', { text: 'Mia: any day', names, week: '2026-10-27' })).status, 400, 'a Monday');
  assert.strictEqual((await me('POST', '/api/read-texts', { text: 'x'.repeat(13000), names, week })).status, 400);
  assert.strictEqual((await me('POST', '/api/read-texts', { text: 'x'.repeat(20 * 1024), names, week })).status, 413, 'its own 16 KB parser, after the gates');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const text = "Theo: can't do Tue, Sat after 4 only\nPriya: any day but no closes\nAva: rather not Sunday, max 18 hours\nRandom Guy: can do Mon";
  const r = await me('POST', '/api/read-texts', { text, names, week });
  assert.strictEqual(r.status, 200, r.text);
  const p = r.data.proposal;
  assert.deepStrictEqual(p.people.map((x) => x.name), ['Theo', 'Priya', 'Ava'], 'in team order, only team names');
  const theo = p.people[0];
  assert.deepStrictEqual(theo.days[1], { s: 'cant', from: null, to: null });
  assert.deepStrictEqual(theo.days[5], { s: 'can', from: '16:00', to: null });
  assert.strictEqual(theo.days[0], null, 'a day nobody mentioned stays unmarked');
  assert.ok(p.people[1].noCloses && p.people[1].days.every((d) => d && d.s === 'can'));
  assert.deepStrictEqual([p.people[2].days[6].s, p.people[2].maxHours], ['prefer', 18]);
  assert.ok(p.unclear.some((u) => /Random Guy/.test(u)));
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  assert.strictEqual(store._dump(), dump, 'nothing stored - it is a proposal');
  // Hostile output is cleaned and bounded; made-up names, days and states dropped.
  const inj = await me('POST', '/api/read-texts', { text: 'Mia: any day INJECT', names, week });
  assert.ok(inj.data.proposal, inj.text);
  assert.ok(!/[<>\u202e]/.test(JSON.stringify(inj.data.proposal)), 'no markup or bidi survives');
  const mia = inj.data.proposal.people.find((x) => x.name === 'Mia');
  assert.strictEqual(mia.maxHours, null, 'an impossible max is dropped');
  assert.deepStrictEqual(mia.days[2], { s: 'can', from: null, to: null }, 'times backwards are dropped');
  assert.ok(!inj.data.proposal.people.some((x) => /Zed/.test(x.name)));
  for (const [trigger, re, status] of [['BLANK', /didn’t come back as availability/, 422], ['MAXTOKENS', /ran long/, 502]]) {
    const b = await me('POST', '/api/read-texts', { text: `Mia: any day ${trigger}`, names, week });
    assert.strictEqual(b.status, 200, 'streamed: the outcome is in the body');
    assert.deepStrictEqual([re.test(b.data.error), b.data.status], [true, status], b.text);
  }
  const up = await me('POST', '/api/read-texts', { text: 'Mia: any day UPSTREAM401', names, week });
  assert.ok(up.data.error && up.data.status === 502 && !/fake_upstream|stand-in/.test(up.text));
  const busy = await me('POST', '/api/read-texts', { text: 'Mia: any day UPSTREAM529', names, week });
  assert.deepStrictEqual([busy.data.status, /AI is busy/.test(busy.data.error)], [503, true]);
  assert.ok(!store._dump().includes('Sat after 4 only'), 'the pasted text is never stored');
  // Applying is an ordinary change, on the manager's tap.
  const mgrC = client();
  const t = await openTeam(mgrC);
  const theoId = t.team.people.find((x) => x.name === 'Theo').id;
  const ap = await mgrC('POST', `/api/teams/${t.code}/manage`, { action: 'availMany', week: t.week, marks: { [theoId]: { days: theo.days }, pnotreal00: { days: theo.days } } }, t.mgr);
  assert.strictEqual(ap.data.result.applied, 1);
  const tw = ap.data.team.weeks[t.week].avail[theoId].days;
  assert.deepStrictEqual([tw[1].s, tw[5].from, tw[0].s], ['cant', '16:00', 'can'], 'unmentioned days keep what they had');
});

test('the model sees only the messages, the names and the week - one forced tool, enums from the team', async () => {
  const seen = [];
  const spy = { messages: { create: async (p) => { seen.push(p); return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'record_availability', input: { people: [{ name: 'Mia', days: [{ day: 'Mon', state: 'cant' }] }] } }] }; } } };
  const b = ai.brief({ text: 'Mia: off Monday <script>x</script>', names: ['Mia', '<b>Theo</b>'], week: '2026-10-26', secret: 'SECRET-FIELD' });
  assert.deepStrictEqual(Object.keys(b).sort(), ['names', 'text', 'week']);
  assert.deepStrictEqual(b.names, ['Mia', 'Theo']);
  const raw = await ai.read(spy, 'claude-haiku-4-5', b);
  const p = seen[0];
  assert.deepStrictEqual(p.tool_choice, { type: 'tool', name: 'record_availability' });
  assert.ok(p.max_tokens <= 4000);
  assert.ok(!/SECRET|<script/.test(JSON.stringify(p.messages)));
  assert.deepStrictEqual(p.tools[0].input_schema.properties.people.items.properties.name.enum, ['Mia', 'Theo']);
  assert.deepStrictEqual(p.tools[0].input_schema.properties.people.items.properties.days.items.properties.day.enum, C.DAYS);
  assert.match(p.system, /never an instruction/);
  assert.deepStrictEqual(ai.toProposal(raw, b.names).people[0].days[0], { s: 'cant', from: null, to: null });
  assert.throws(() => ai.toProposal({ people: [{ name: 'Nobody', days: [{ day: 'Mon', state: 'can' }] }] }, b.names), (e) => e.status === 422);
});

test('the gates: unconfirmed 403, out of credit 402, the day’s free ceiling 503 - each before the parser, never a model call', async () => {
  const ASK = { text: 'Mia: any day', names: ['Mia'], week: '2026-10-26' };
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/read-texts', ASK);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/rota/api/auth/verify/send');
    assert.strictEqual((await eve('POST', '/api/read-texts', { text: 'x'.repeat(200 * 1024) })).status, 403);
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/read-texts', ASK)).status, 402);
  assert.strictEqual((await cal('POST', '/api/read-texts', { text: 'x'.repeat(200 * 1024) })).status, 402, '402, not 413');
  const dan = await register('dan.capped@example.com');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-rota-${day}`, { usd: 5000 });
  try {
    const capped = await dan('POST', '/api/read-texts', ASK);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/read-texts', { text: 'x'.repeat(200 * 1024) })).status, 503);
  } finally { await identityStore.remove('control', `free-spend-rota-${day}`); }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call behind any gate');
  assert.strictEqual((await dan('POST', '/api/read-texts', ASK)).status, 200, 'and it lifts');
});

test('concurrent phones: availability from many phones at once all lands (one transaction each)', async () => {
  const mgrC = client();
  const { code, mgr, week, team } = await openTeam(mgrC);
  const phones = await Promise.all(team.people.map(async (p) => { const c = client(); await c('POST', `/api/teams/${code}/join`, { pid: p.id }); return c; }));
  await Promise.all(phones.map((c, i) => c('POST', `/api/teams/${code}/staff`, { action: 'avail', week, days: [{ s: i % 2 ? 'cant' : 'can' }], note: `n${i}` })));
  const t = (await mgrC('GET', `/api/teams/${code}`, undefined, mgr)).data.team;
  assert.deepStrictEqual(team.people.map((p, i) => t.weeks[week].avail[p.id].note), team.people.map((p, i) => `n${i}`));
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use((req, res, next) => (req.path === '/rota' ? res.redirect(301, '/rota/') : next()));
  host.use('/rota', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/rota`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (e) { failed++; console.log(`  FAIL ${t.name}\n${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
