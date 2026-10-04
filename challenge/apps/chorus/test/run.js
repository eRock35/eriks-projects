// Pure rules first, then end to end against the memory store and the fake
// model:
//   CHORUS_MEMORY=1 CHORUS_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /chorus, the way
// the lab mounts it, so the auth cookie, the budget gate, the member
// cookie's path, per-household rights and the big-body route are exercised
// as deployed. Model calls are counted from the identity's usage rows - the
// same rows that bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.CHORUS_MEMORY !== '1' || process.env.CHORUS_FAKE_AI !== '1') {
  console.error('run with CHORUS_MEMORY=1 CHORUS_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const C = require('../public/chorus-core');
const S = require('../public/sample');
const QR = require('../public/qr');
const ai = require('../lib/ai');
const H = require('../lib/homes');

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
const MARK = 'ROOMBYTESMARKER';
const jpeg = (s = '') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(MARK + s), Buffer.alloc(2000, 7)]).toString('base64');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- helpers for the pure rules ---------------- */

let seq = 0;
const rand = (n) => (seq++ * 7919) % n;
const W0 = '2026-09-07';
function homeOf(people, chores) {
  return C.cleanHome({ name: 'Test home', members: people.map((p) => (typeof p === 'string' ? { name: p } : p)), chores }, { week: W0, rand });
}
const loadsOf = (home, doc) => {
  const out = {}; for (const m of home.members) out[m.id] = 0;
  const eff = C.effective(doc);
  for (const s of C.weekSlots(home.chores, doc.week, home.since)) if (eff[s.id]) out[eff[s.id]] += s.pts;
  return out;
};
/** Deal `n` weeks in a row from W0, newest first. */
function run(home, n, pinsFor) {
  const docs = [];
  let wk = W0;
  for (let i = 0; i < n; i++) {
    const d = C.deal(home, wk, docs, pinsFor ? pinsFor(wk) : {});
    docs.unshift({ week: wk, basis: d.basis, assign: d.assign, ticks: {}, swaps: {} });
    wk = C.addWeeks(wk, 1);
  }
  return docs;
}
const id = (home, name) => home.members.find((m) => m.name === name).id;
const cid = (home, name) => home.chores.find((c) => c.name === name).id;

/* ---------------- pure: weeks, slots, text ---------------- */

test('weeks start on Monday in the household’s own time zone; slots follow each frequency', () => {
  assert.strictEqual(C.weekKey(Date.parse('2026-10-04T23:30:00Z'), 'America/New_York'), '2026-09-28', 'Sunday evening in New York');
  assert.strictEqual(C.weekKey(Date.parse('2026-10-05T03:30:00Z'), 'America/New_York'), '2026-09-28', 'still Sunday there');
  assert.strictEqual(C.weekKey(Date.parse('2026-10-05T03:30:00Z'), 'UTC'), '2026-10-05');
  assert.strictEqual(C.weekKey(Date.parse('2026-10-04T23:30:00Z'), 'Asia/Tokyo'), '2026-10-05', 'already Monday in Tokyo');
  assert.strictEqual(C.cleanTz('Not/AZone'), 'UTC');
  assert.strictEqual(C.cleanTz('<script>'), 'UTC');
  const ch = (freq, start) => ({ id: 'cabcdefg1', effort: 3, freq, start });
  assert.deepStrictEqual(C.slotsFor(ch('daily'), W0).map((s) => s.day), [0, 1, 2, 3, 4, 5, 6]);
  const often = [0, 1, 2, 3].map((i) => C.slotsFor(ch('often'), C.addWeeks(W0, i)).length);
  assert.ok(often.includes(3) && often.includes(2) && often.reduce((a, b) => a + b) === 10, `2-3x alternates: ${often}`);
  assert.deepStrictEqual([0, 1, 2, 3].map((i) => C.slotsFor(ch('biweekly', W0), C.addWeeks(W0, i)).length), [1, 0, 1, 0]);
  assert.deepStrictEqual([0, 1, 2, 3, 4].map((i) => C.slotsFor(ch('monthly', W0), C.addWeeks(W0, i)).length), [1, 0, 0, 0, 1]);
  assert.ok(C.slotsFor(ch('daily'), W0).every((s) => s.pts === 3 && C.isSlotId(s.id)));
  // A household that starts mid-week only gets what is still ahead of it.
  const h = homeOf(['A', 'B'], C.templateChores('couple'));
  assert.strictEqual(C.weekSlots(h.chores, W0, '2026-09-09').filter((s) => s.chore === h.chores[0].id).length, 5, 'Wed..Sun of a daily chore');
  assert.ok(C.weekSlots(h.chores, W0, '2026-09-09').some((s) => s.day === null), 'weekly chores kept when it starts by Thursday');
  assert.ok(!C.weekSlots(h.chores, W0, '2026-09-12').some((s) => s.day === null), 'not when it starts on Saturday');
  assert.strictEqual(C.weekSlots(h.chores, C.addWeeks(W0, 1), '2026-09-12').length, C.weekSlots(h.chores, C.addWeeks(W0, 1)).length, 'the next week is whole');
});

test('typed text is bounded and stripped of markup, control and bidi characters; a household is cleaned whole', () => {
  assert.strictEqual(C.clean('<b>Bins</b>\u202e o\u0000ut\u200b', 40), 'Bins o ut');
  assert.ok(C.clean('A'.repeat(500), 10).endsWith('…'));
  const t0 = Date.now(); C.clean('<'.repeat(400000), 40); assert.ok(Date.now() - t0 < 500, 'linear on hostile input');
  assert.strictEqual(C.cleanName('<script>'), '');
  assert.strictEqual(C.cleanChoreEmoji('🗑️'), '🗑️');
  assert.strictEqual(C.cleanChoreEmoji('👨‍👩‍👧'), '👨‍👩‍👧', 'a ZWJ family is one emoji');
  for (const bad of ['<x>', 'ab', '🗑️🗑️', '🧹x', '', null, 42]) assert.strictEqual(C.cleanChoreEmoji(bad), null, String(bad));
  assert.deepStrictEqual([1, '3', 5].map(C.cleanEffort), [1, 3, 5]);
  for (const bad of [0, 6, 2.5, '9', 'big', null]) assert.strictEqual(C.cleanEffort(bad), null, String(bad));
  assert.throws(() => homeOf(['A', 'a'], []), /Two people are called/);
  assert.throws(() => homeOf(Array.from({ length: 13 }, (_, i) => `P${i}`), []), /12 people at most/);
  assert.throws(() => homeOf(['A'], Array.from({ length: 61 }, (_, i) => ({ name: `C${i}`, effort: 1, freq: 'weekly' }))), /60 chores at most/);
  assert.throws(() => homeOf(['A'], [{ name: 'X', effort: 9, freq: 'weekly' }]), /Effort/);
  assert.throws(() => homeOf(['A'], [{ name: 'X', effort: 2, freq: 'hourly' }]), /how often/);
  const h = C.cleanHome({ name: '<i>Flat</i> 4B', members: [{ name: 'Ana', emoji: '🦊', weight: 7, cant: ['cnotachore', 'x'], dislikes: [] }, { name: 'Ben', emoji: '🦊' }], chores: [{ name: 'Bins', emoji: '<b>', effort: 2, freq: 'weekly' }] }, { week: W0 });
  assert.strictEqual(h.name, 'Flat 4B');
  assert.deepStrictEqual([h.members[0].weight, h.members[0].cant], [1, []], 'a weight off the list is a full share; exclusions only name real chores');
  assert.notStrictEqual(h.members[1].emoji, h.members[0].emoji, 'two people never share an emoji');
  assert.strictEqual(h.chores[0].emoji, '🧹', 'a bad emoji becomes a broom');
});

/* ---------------- pure: the deal ---------------- */

test('the deal balances effort points by each person’s share (a kid counts half)', () => {
  const h = homeOf(['Ana', 'Ben', { name: 'Kid', weight: 0.5 }, { name: 'Tot', weight: 0.5 }], C.templateChores('family'));
  for (const doc of run(h, 6)) {
    const L = loadsOf(h, doc);
    const total = Object.values(L).reduce((a, b) => a + b, 0);
    const T = total / 3; // 1 + 1 + 0.5 + 0.5
    for (const m of h.members) {
      const per = L[m.id] / m.weight;
      assert.ok(Math.abs(per - T) <= 4, `${doc.week} ${m.name}: ${L[m.id]} pts (per share ${per.toFixed(1)} vs ${T.toFixed(1)})`);
    }
    assert.ok(Object.values(doc.assign).every(Boolean), 'every slot has someone');
  }
  const r = homeOf(['A', 'B', 'C'], C.templateChores('roommates'));
  for (const doc of run(r, 4)) {
    const v = Object.values(loadsOf(r, doc));
    assert.ok(Math.max(...v) - Math.min(...v) <= 3, `roommates within 3 points: ${v}`);
  }
});

test('nobody ever gets a chore they can’t do; one able person gets it; nobody able leaves it unassigned', () => {
  const chores = C.templateChores('family');
  const h0 = homeOf(['Ana', 'Ben', { name: 'Kid', weight: 0.5 }], chores);
  const bath = cid(h0, 'Clean the bathroom'); const shop = cid(h0, 'Grocery shop');
  const h = { ...h0, members: h0.members.map((m) => (m.name === 'Kid' ? { ...m, cant: [bath, shop] } : m.name === 'Ben' ? { ...m, cant: [shop] } : m)) };
  for (const doc of run(h, 8)) {
    for (const [slot, mid] of Object.entries(doc.assign)) {
      const m = h.members.find((x) => x.id === mid);
      assert.ok(!m.cant.includes(slot.split('_')[0]), `${m.name} got ${slot}`);
    }
    assert.strictEqual(doc.assign[shop + '_0'], id(h, 'Ana'), 'only Ana can shop');
  }
  const none = { ...h, members: h.members.map((m) => ({ ...m, cant: [bath] })) };
  const d = C.deal(none, W0, [], {});
  assert.strictEqual(d.assign[bath + '_0'], null);
  const ex = C.explain(none, { week: W0, ...d, ticks: {}, swaps: {} }, []);
  assert.match(ex[`${bath}:-`], /can’t-do list/);
});

test('the rotation: the bathroom moves on every week, and a least-liked chore never lands on someone twice running', () => {
  const h0 = homeOf(['Ana', 'Ben', 'Cy'], [{ name: 'Clean the bathroom', emoji: '🛁', effort: 4, freq: 'weekly' }, { name: 'Bins', emoji: '🗑️', effort: 2, freq: 'weekly' }, { name: 'Vacuum', emoji: '🧹', effort: 3, freq: 'weekly' }, { name: 'Dishes', emoji: '🍽️', effort: 2, freq: 'daily' }]);
  const bath = cid(h0, 'Clean the bathroom');
  const docs = run(h0, 9).reverse();
  const who = docs.map((d) => d.assign[bath + '_0']);
  for (let i = 1; i < who.length; i++) assert.notStrictEqual(who[i], who[i - 1], `the bathroom twice running in week ${i}: ${who}`);
  assert.strictEqual(new Set(who).size, 3, 'everyone takes a turn');
  // Ben dislikes it: when it could go to Ben or someone else, it never goes to him two weeks running.
  const h = { ...h0, members: h0.members.map((m) => (m.name === 'Ben' ? { ...m, dislikes: [bath] } : m)) };
  const w2 = run(h, 12).reverse().map((d) => d.assign[bath + '_0']);
  for (let i = 1; i < w2.length; i++) assert.ok(!(w2[i] === id(h, 'Ben') && w2[i - 1] === id(h, 'Ben')), `Ben twice running: ${w2}`);
  assert.ok(w2.filter((x) => x === id(h, 'Ben')).length <= 4, 'and less than his share of it');
  // ...and the page says why.
  const hist = [{ week: '2026-09-21', assign: { [bath + '_0']: id(h0, 'Ana') }, ticks: {}, swaps: {} }, { week: '2026-09-14', assign: { [bath + '_0']: id(h0, 'Ana') }, ticks: {}, swaps: {} }];
  const d = C.deal(h0, '2026-09-28', hist, {});
  assert.notStrictEqual(d.assign[bath + '_0'], id(h0, 'Ana'));
  const doc = { week: '2026-09-28', ...d, ticks: {}, swaps: {} };
  const line = C.explain(h0, doc, hist)[`${bath}:${d.assign[bath + '_0']}`];
  assert.match(line, /^(Ben|Cy)’s turn this week - Ana had it the last two weeks\.$/, line);
});

test('the deal is deterministic: same inputs, same plan - and pinned slots stay put', () => {
  const h = homeOf(['Ana', 'Ben', { name: 'Kid', weight: 0.5 }], C.templateChores('family'));
  const hist = run(h, 3);
  const a = C.deal(h, '2026-09-28', hist, {});
  const b = C.deal(JSON.parse(JSON.stringify(h)), '2026-09-28', JSON.parse(JSON.stringify(hist)), {});
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.basis, C.basisOf(h));
  const renamed = { ...h, members: h.members.map((m) => ({ ...m, name: m.name + 'x', emoji: '🐼' })) };
  assert.strictEqual(C.basisOf(renamed), a.basis, 'names and emoji do not change the deal');
  assert.notStrictEqual(C.basisOf({ ...h, chores: h.chores.slice(1) }), a.basis);
  // Different weeks deal differently (the tie-breaks move), not one fixed chart.
  const w1 = C.deal(h, '2026-10-05', [], {}).assign; const w2 = C.deal(h, '2026-10-12', [], {}).assign;
  assert.ok(Object.keys(w1).some((k) => w1[k] !== w2[k]));
  // Pins: a done slot stays with whoever did it, and the rest re-balances.
  const slot = Object.keys(a.assign)[0];
  const other = h.members.find((m) => m.id !== a.assign[slot]).id;
  const p = C.deal(h, '2026-09-28', hist, { [slot]: other });
  assert.strictEqual(p.assign[slot], other);
  const t0 = Date.now();
  const big = homeOf(Array.from({ length: 12 }, (_, i) => `P${i}`), Array.from({ length: 60 }, (_, i) => ({ name: `Chore ${i}`, effort: (i % 5) + 1, freq: i % 3 ? 'daily' : 'weekly' })));
  C.deal(big, W0, run(big, 4), {});
  assert.ok(Date.now() - t0 < 4000, `the largest household deals in ${Date.now() - t0}ms`);
});

test('ticks and swaps: one key each, the right person credited, swaps move the points', () => {
  const h = homeOf(['Ana', 'Ben', { name: 'Kid', weight: 0.5 }], [{ name: 'Bins', emoji: '🗑️', effort: 2, freq: 'weekly' }, { name: 'Bathroom', emoji: '🛁', effort: 4, freq: 'weekly' }, { name: 'Dishes', emoji: '🍽️', effort: 2, freq: 'daily' }]);
  const kid = id(h, 'Kid');
  h.members.find((m) => m.id === kid).cant = [cid(h, 'Bathroom')];
  let doc = C.ensureWeek(h, null, W0, []);
  const bins = cid(h, 'Bins') + '_0';
  const holder = C.effective(doc)[bins];
  const other = h.members.find((m) => m.id !== holder && m.id !== kid).id;
  const t = C.tick(h, doc, bins, { mid: other }, Date.parse('2026-09-08T10:00:00Z'));
  assert.deepStrictEqual(Object.keys(t.set), ['ticks.' + bins], 'one key');
  assert.strictEqual(t.set['ticks.' + bins].who, holder, 'credit goes to whoever holds it, not whoever tapped');
  assert.strictEqual(t.set['ticks.' + bins].by, other);
  doc = C.applyPatch(doc, t);
  assert.strictEqual(C.tick(h, doc, bins, { mid: other }, Date.now()), null, 'a second tick changes nothing');
  assert.throws(() => C.tick(h, doc, 'cnotreal1_0', { mid: other }, Date.now()), /No such chore/);
  assert.throws(() => C.tick(h, doc, '../evil', { mid: other }, Date.now()), /No such chore/);
  assert.throws(() => C.swap(h, doc, bins, { mid: holder }, 'offer', Date.now()), /already done/);
  doc = C.applyPatch(doc, C.untick(h, doc, bins));
  assert.ok(!doc.ticks[bins]);
  // Offer and claim.
  const bath = cid(h, 'Bathroom') + '_0';
  const bh = C.effective(doc)[bath];
  const notBh = h.members.find((m) => m.id !== bh && m.id !== kid).id;
  assert.throws(() => C.swap(h, doc, bath, { mid: notBh }, 'offer', Date.now()), /your own chores/);
  doc = C.applyPatch(doc, C.swap(h, doc, bath, { mid: bh }, 'offer', Date.now()));
  assert.throws(() => C.swap(h, doc, bath, { mid: bh }, 'claim', Date.now()), /your own offer/);
  assert.throws(() => C.swap(h, doc, bath, { mid: kid }, 'claim', Date.now()), /can’t-do list/);
  assert.throws(() => C.swap(h, doc, bath, { mid: notBh }, 'give', Date.now(), notBh), /Offer it instead/);
  const before = C.board(h, doc).find((r) => r.id === notBh).total;
  doc = C.applyPatch(doc, C.swap(h, doc, bath, { mid: notBh }, 'claim', Date.now()));
  assert.strictEqual(C.effective(doc)[bath], notBh);
  assert.strictEqual(C.board(h, doc).find((r) => r.id === notBh).total, before + 4, 'the points moved');
  assert.throws(() => C.swap(h, doc, bath, { mid: holder }, 'claim', Date.now()), /already took/);
  doc = C.applyPatch(doc, C.tick(h, doc, bath, { mid: bh }, Date.now()));
  assert.strictEqual(doc.ticks[bath].who, notBh, 'done by the one who took it');
  assert.match(C.explain(h, doc, [])[`${cid(h, 'Bathroom')}:${notBh}`], /took this from/);
  // On a phone the household shares, hand it straight to someone.
  const d2 = C.applyPatch(doc, C.swap(h, doc, cid(h, 'Dishes') + '_3', { mid: null, host: true, local: true }, 'give', Date.now(), kid));
  assert.strictEqual(C.effective(d2)[cid(h, 'Dishes') + '_3'], kid);
  // Re-dealt after a change, done and swapped slots stay where they are.
  const h2 = { ...h, chores: [...h.chores, { id: 'cnewchore1', name: 'Mop', emoji: '🪣', effort: 3, freq: 'weekly', start: W0 }] };
  const re = C.ensureWeek(h2, doc, W0, []);
  assert.notStrictEqual(re, doc);
  assert.strictEqual(C.effective(re)[bath], notBh);
  assert.ok(re.ticks[bath] && re.assign['cnewchore1_0']);
  assert.strictEqual(C.ensureWeek(h2, re, W0, []), re, 'nothing changed, nothing re-dealt');
});

test('fairness: shares against fair shares by weight, in one plain line; streaks count whole weeks done', () => {
  const h = homeOf(['Ana', 'Ben', { name: 'Kid', weight: 0.5 }], [{ name: 'Bins', emoji: '🗑️', effort: 2, freq: 'weekly' }, { name: 'Dishes', emoji: '🍽️', effort: 2, freq: 'daily' }]);
  const docs = run(h, 3);
  const ana = id(h, 'Ana');
  // Ana does everything in every week.
  for (const d of docs) for (const s of C.weekSlots(h.chores, d.week)) d.ticks[s.id] = { who: ana, by: ana, pts: s.pts, at: '2026-09-10T00:00:00Z' };
  const f = C.fairness(h, docs);
  assert.strictEqual(f.rows.find((r) => r.id === ana).share, 1);
  assert.strictEqual(f.rows.find((r) => r.id === ana).fair, 0.4);
  assert.match(f.line, /^Ana did 100% of the work in the last three weeks - a fair share is 40%\.$/);
  assert.match(C.fairness(h, [{ week: W0, assign: {}, ticks: {}, swaps: {} }]).line, /Nothing ticked yet/);
  const even = run(h, 1);
  for (const s of C.weekSlots(h.chores, even[0].week)) { const w = even[0].assign[s.id]; even[0].ticks[s.id] = { who: w, by: w, pts: s.pts, at: 'x' }; }
  assert.match(C.fairness(h, even).line, /Nicely shared/);
  // Streaks: Ana finished every week; nobody else did.
  const st = run(h, 4);
  for (const d of st) for (const s of C.weekSlots(h.chores, d.week)) if (d.assign[s.id] === ana) d.ticks[s.id] = { who: ana, by: ana, pts: s.pts, at: 'x' };
  assert.strictEqual(C.streak(h, st, ana), 4);
  assert.strictEqual(C.streak(h, st, id(h, 'Ben')), 0);
  const unfinished = JSON.parse(JSON.stringify(st)); unfinished[0].ticks = {};
  assert.strictEqual(C.streak(h, unfinished, ana), 3, 'this week, still going, neither counts nor breaks it');
  unfinished[1].ticks = {};
  assert.strictEqual(C.streak(h, unfinished, ana), 0, 'a past week not finished breaks it');
  assert.match(C.weekSummary(h, st[0]), /Kid counts half/);
  assert.strictEqual(C.nudgeText({ name: 'Sam' }, { name: 'Take the bins out', emoji: '🗑️', nudge: 'the bins go out tonight' }, { day: 2 }, 2), 'Hey Sam - the bins go out tonight 🗑️ Thank you!');
  assert.strictEqual(C.nudgeText({ name: 'Sam' }, { name: 'Vacuum', emoji: '🧹' }, { day: null }, 2), 'Hey Sam - vacuum is yours this week 🧹 Thank you!');
});

test('the example household is dealt by the real rules: a week in progress, an offer up for grabs, Maria carrying it', () => {
  for (const at of ['2026-10-05T08:00:00Z', '2026-10-08T19:00:00Z', '2026-10-11T21:00:00Z']) {
    const s = S.state(Date.parse(at), 'America/Chicago');
    assert.strictEqual(s.weeks.length, 5);
    assert.strictEqual(s.home.members.length, 4);
    assert.strictEqual(s.home.chores.length, 10);
    assert.ok(Object.values(s.weeks[0].swaps).some((x) => x.state === 'offered'), 'an offer on the board');
    const f = C.fairness(s.home, s.weeks.slice(0, 4));
    assert.match(f.line, /^Maria did \d+% of the work in the last four weeks/);
    for (const d of s.weeks) for (const [slot, mid] of Object.entries(d.assign)) {
      const m = s.home.members.find((x) => x.id === mid);
      assert.ok(m && !m.cant.includes(slot.split('_')[0]), 'Mateo never gets the bathroom');
    }
    assert.deepStrictEqual(S.state(Date.parse(at), 'America/Chicago'), s, 'the same moment, the same example');
  }
});

test('a model’s suggestions are untrusted: bounded, stripped, enums, no repeats, at most twenty', () => {
  const raw = {
    relevant: true,
    chores: [
      { name: `<img src=x onerror=alert(1)>Scrub\u202e the tub${'A'.repeat(5000)}`, emoji: '<script>', effort: 9, freq: 'hourly' },
      { name: 'Wash the windows', emoji: '<b>🪟</b>', effort: 3, freq: 'monthly' },
      { name: 'Dishes', emoji: '🍽️', effort: 2, freq: 'daily' },
      { name: 'wash  the WINDOWS!', emoji: '🪟', effort: 3, freq: 'monthly' },
      { name: { evil: 1 }, emoji: '🧽', effort: 2, freq: 'weekly' },
      { name: 'Water plants', emoji: '🪴', effort: '2', freq: 'weekly' },
      ...Array.from({ length: 40 }, (_, i) => ({ name: `Chore ${i}`, emoji: '🧹', effort: 2, freq: 'weekly' })),
    ],
  };
  const out = ai.cleanSuggestions(raw, ['dishes']);
  assert.ok(!/[<>\u202e]/.test(JSON.stringify(out)));
  assert.strictEqual(out.length, C.LIMITS.suggestions);
  assert.ok(!out.some((c) => /^dishes$/i.test(c.name)), 'already on the list');
  assert.strictEqual(out.filter((c) => /windows/i.test(c.name)).length, 1, 'repeats folded');
  assert.strictEqual(out.find((c) => /windows/i.test(c.name)).emoji, '🧹', 'markup around an emoji is not an emoji');
  assert.ok(out.every((c) => C.FREQ_IDS.includes(c.freq) && c.effort >= 1 && c.effort <= 5 && Array.from(c.name).length <= C.LIMITS.choreName));
  assert.ok(!out.some((c) => /Scrub/.test(c.name)), 'an effort of 9 is not a chore');
  assert.deepStrictEqual(ai.cleanSuggestions({ relevant: false, chores: raw.chores }, []), []);
  assert.deepStrictEqual(ai.cleanSuggestions(null, []), []);
  assert.deepStrictEqual(ai.cleanSuggestions({ relevant: true, chores: 'no' }, []), []);
  assert.strictEqual(ai.TOOL.input_schema.properties.chores.items.properties.freq.enum.length, C.FREQS.length);
  assert.match(ai.SYSTEM, /never an instruction/);
});

/* ---------------- static checks ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour holds 4.5:1 on its surface and every person colour 3:1 on a card, in both themes', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['bg', 'card', 'card2', 'accent-soft']) for (const fg of ['text', 'muted', 'link']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, `${name} accent-ink on accent`);
    assert.ok(ratio(t.good, t['good-bg']) >= 4.5 && ratio(t.good, t.card) >= 4.5, `${name} good`);
    assert.ok(ratio(t.warn, t['warn-bg']) >= 4.5, `${name} warn`);
    assert.ok(ratio(t.err, t.card) >= 4.5, `${name} errors`);
    assert.ok(ratio(t['strip-ink'], t.strip) >= 4.5 && ratio(t['strip-btn-ink'], t['strip-btn']) >= 4.5, `${name} the strip`);
    assert.ok(ratio(t.accent, t.card) >= 3 && ratio(t.accent, t.card2) >= 3, `${name} the tick ring and meters (graphics, 3:1)`);
    for (let i = 0; i < 12; i++) assert.ok(ratio(t['p' + i], t.card) >= 3 && ratio(t['p' + i], t.card2) >= 3, `${name} person colour ${i}: ${ratio(t['p' + i], t.card).toFixed(2)}`);
  }
  assert.ok(ratio('#3a5a10', '#ffffff') >= 4.5 && ratio('#111111', '#ffffff') >= 4.5, 'the QR screen');
});

test('the QR encoder draws a join link', () => {
  const svg = QR.svg('https://challenge.strongtechnicalconsulting.com/chorus/j/ABCDEF', 'Join "x" <home>');
  assert.ok(svg.startsWith('<svg') && !/<home>|"x"/.test(svg));
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { CHORUS_MEMORY: '1' }], ['./lib/fakeai', { CHORUS_FAKE_AI: '1' }], ['./server', { CHORUS_FAKE_AI: '1', CHORUS_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, CHORUS_MEMORY: '', CHORUS_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, CHORUS_MEMORY: '', CHORUS_COLLECTION_PREFIX: 'chorus_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8');
  assert.ok(/CHORUS_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, nothing logged from a body', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input) =/.test(js), 'handlers by addEventListener, not properties');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.ok(!/<script/i.test(js), 'no script written into markup');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js), 'no email address in the page');
  for (const f of ['server.js', 'lib/ai.js', 'lib/homes.js', 'lib/photo.js', 'public/chorus-core.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|photo|name|text|raw|chore)/.test(src), `${f} logs a body`);
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
/** A household as a phone would send it to go online. */
function localHome(n = 4) {
  const people = ['Ana', 'Ben', 'Cleo', 'Dev', 'Eve', 'Finn', 'Gus', 'Hal'].slice(0, n).map((name, i) => ({ id: C.newId('m'), name, emoji: C.EMOJI[i], weight: i >= 2 ? 0.5 : 1 }));
  // Started a fortnight ago, so this week is a whole one whatever day the suite runs.
  const home = C.cleanHome({ name: 'The <b>Test</b> House', members: people, chores: C.templateChores('family'), since: C.addWeeks(C.weekKey(Date.now(), 'UTC'), -2) }, { week: C.weekKey(Date.now(), 'UTC') });
  home.tz = 'UTC'; home.me = home.members[0].id;
  return home;
}

test('signed out: the page and the example work with zero model calls; nothing private does, and no big body is read', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.limits.members, meta.limits.chores, meta.freqs.length, meta.templates.length], [12, 60, 5, 3]);
  for (const f of ['chorus-core.js', 'sample.js', 'qr.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['POST', '/api/suggest'], ['POST', '/api/homes'], ['GET', '/api/homes']]) assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p}`);
  assert.strictEqual((await anon('POST', '/api/suggest', { text: 'a kitchen' })).status, 401);
  assert.strictEqual((await anon('POST', '/api/suggest', { photo: { type: 'image/jpeg', data: 'A'.repeat(7 * 1024 * 1024) } })).status, 401, 'the gate answers before the big parser');
  assert.strictEqual((await anon('POST', '/api/homes', { home: 'x'.repeat(200 * 1024) })).status, 401, 'going online: sign-in before its 256 KB parser');
  assert.strictEqual((await anon('POST', '/api/join/ABCDEF', { name: 'x'.repeat(100 * 1024) })).status, 413, 'every other route keeps the small limit');
  for (const p of ['/h/AAAAAAAAAAAAAAAA', '/j/ABCDEF']) {
    const r = await fetch(`${base}${p}`);
    assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).includes('<base href="../">'), 'deep links resolve assets from the app root');
    assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
    assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the suggest route’s gates come before its 6 MB parser, in order; one model client in the whole server', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/suggest', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/homes', 'post').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  for (const [p, m] of [['/api/homes', 'get'], ['/api/homes', 'post'], ['/api/homes/:hid', 'patch'], ['/api/homes/:hid', 'delete'], ['/api/homes/:hid/code', 'post']]) assert.strictEqual(layer(p, m).route.stack[0].handle.name, 'requireUser', `${m} ${p}`);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1);
});

let host; let HOME; let CODE; let hostMid;

test('suggest chores: input checked before any spend, one metered call, a proposal to review, nothing stored', async () => {
  host = await register('ana.host@example.com');
  const dump = store._dump();
  const calls = await modelCalls();
  assert.strictEqual((await host('POST', '/api/suggest', {})).status, 400);
  assert.strictEqual((await host('POST', '/api/suggest', { text: '!!' })).status, 400);
  assert.strictEqual((await host('POST', '/api/suggest', { photo: { type: 'image/jpeg', data: Buffer.from('%PDF-1.4 nope').toString('base64') } })).status, 400);
  assert.strictEqual((await host('POST', '/api/suggest', { photo: { type: 'image/gif', data: jpeg() } })).status, 400);
  assert.strictEqual((await host('POST', '/api/suggest', { photo: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } })).status, 400, 'over 4 MB');
  assert.strictEqual((await host('POST', '/api/suggest', { photo: { type: 'image/jpeg', data: 'A'.repeat(7 * 1024 * 1024) } })).status, 413, 'over the 6 MB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const r = await host('POST', '/api/suggest', { photo: { type: 'image/jpeg', data: jpeg() }, have: ['dishes'] });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.data.chores.length, 5, 'the kitchen, minus the dishes it already has');
  assert.ok(!r.data.chores.some((c) => c.name === 'Dishes'));
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  assert.strictEqual((await host('POST', '/api/suggest', { text: 'A small flat with a cat' })).status, 200, 'words alone work too');
  const inj = await host('POST', '/api/suggest', { text: 'INJECT please' });
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text), 'no markup or bidi reaches the page');
  assert.ok(inj.data.chores.length <= 20);
  const blank = await host('POST', '/api/suggest', { photo: { type: 'image/jpeg', data: jpeg('BLANK') } });
  assert.deepStrictEqual([blank.status, /No chores came out/.test(blank.data.error)], [422, true]);
  assert.match((await host('POST', '/api/suggest', { text: 'MAXTOKENS kitchen' })).data.error, /ran long/);
  const up = await host('POST', '/api/suggest', { text: 'UPSTREAM401 kitchen' });
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await host('POST', '/api/suggest', { text: 'UPSTREAM529 kitchen' });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  assert.strictEqual(store._dump(), dump, 'suggesting stores nothing');
});

test('an unconfirmed free account gets the verify-email 403 before any model call or big body; out of credit is a 402', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/suggest', { text: 'a kitchen' });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/chorus/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/suggest', { photo: { type: 'image/jpeg', data: 'A'.repeat(7 * 1024 * 1024) } })).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('POST', '/api/homes', { home: localHome(2), me: null })).status, 400, 'a household needs no AI and no confirmed address - just a "me"');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/suggest', { text: 'a kitchen' })).status, 402);
  assert.strictEqual((await cal('POST', '/api/suggest', { photo: { type: 'image/jpeg', data: 'A'.repeat(7 * 1024 * 1024) } })).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
});

let localCopy;
test('a host puts a phone’s household online, history and all; a roommate with no account joins by code as their own seat', async () => {
  const home = localHome(4);
  localCopy = home;
  const wk = C.weekKey(Date.now(), 'UTC');
  const last = C.addWeeks(wk, -1);
  const past = C.ensureWeek(home, null, last, []);
  const s0 = Object.keys(past.assign)[0];
  past.ticks[s0] = { who: past.assign[s0], by: past.assign[s0], pts: 2, at: new Date().toISOString() };
  const r = await host('POST', '/api/homes', { home, me: home.me, tz: 'UTC', weeks: { [last]: past, '2020-01-06': past, [C.addWeeks(wk, 2)]: past, garbage: 1 } });
  assert.strictEqual(r.status, 200, r.text);
  HOME = r.data.id; CODE = r.data.home.code; hostMid = r.data.home.me;
  assert.ok(H.isHomeId(HOME) && H.isCode(CODE));
  assert.deepStrictEqual([r.data.home.name, r.data.home.host, r.data.home.members.length, hostMid], ['The Test House', true, 4, home.me]);
  assert.strictEqual(r.data.week, wk);
  assert.strictEqual(r.data.weeks[1].week, last, 'last week came along');
  assert.ok(r.data.weeks[1].ticks[s0], '...with what was done');
  assert.ok(Object.keys(r.data.weeks[0].assign).length > 10, 'this week is dealt');
  assert.ok(!store._dump().includes('2020-01-06') && !store._dump().includes(C.addWeeks(wk, 2)), 'only real past weeks are kept');
  // A roommate opens the link.
  const ben = client();
  const look = await ben('GET', `/api/join/${CODE.toLowerCase().replace(/(...)/, '$1-')}`);
  assert.strictEqual(look.status, 200, 'the code is read however it is typed');
  assert.deepStrictEqual([look.data.name, look.data.members, look.data.already], ['The Test House', 4, null]);
  assert.deepStrictEqual(look.data.seats.map((s) => s.name), ['Ben', 'Cleo', 'Dev'], 'open seats: the host is not one');
  assert.strictEqual(ben.cookies.chorus_k, undefined, 'looking mints nothing');
  const j = await ben('POST', `/api/join/${CODE}`, { seat: look.data.seats[0].id });
  assert.strictEqual(j.status, 200, JSON.stringify(j.data));
  assert.strictEqual(j.data.homeId, HOME);
  const ck = j.setCookie.find((c) => c.startsWith('chorus_k='));
  assert.match(ck, /^chorus_k=[A-Za-z0-9_-]{22}; Path=\/chorus\/; Max-Age=\d+; SameSite=Lax; HttpOnly/, 'HttpOnly, scoped to the app path');
  const v = await ben('GET', `/api/homes/${HOME}`);
  assert.strictEqual(v.status, 200);
  assert.strictEqual(v.data.home.me, look.data.seats[0].id, 'Ben is Ben');
  assert.ok(!/ownerTag|acctTags|keyHash|"acct"|example\.com|YW5hLm/.test(v.text), 'no tag, hash, account id or email reaches a member');
  assert.strictEqual((await client()('POST', `/api/join/${CODE}`, { seat: look.data.seats[0].id })).status, 409, 'a taken seat is taken');
  assert.strictEqual((await ben('POST', `/api/join/${CODE}`, { name: 'Someone else' })).data.me, j.data.me, 'a browser that joined gets itself back');
  const newbie = client();
  const n = await newbie('POST', `/api/join/${CODE}`, { name: '<b>Fern</b> \u202e', emoji: '🐸' });
  assert.strictEqual(n.status, 200);
  const nv = await newbie('GET', `/api/homes/${HOME}`);
  assert.deepStrictEqual(nv.data.home.members.slice(-1).map((m) => [m.name, m.emoji, m.weight]), [['Fern', '🐸', 1]]);
  assert.strictEqual((await client()('POST', `/api/join/${CODE}`, { name: 'fern' })).status, 409, 'names are unique, case folded');
  // Polling: an idle household costs one read.
  const same = await ben('GET', `/api/homes/${HOME}?since=${nv.data.home.v}&week=${wk}`);
  assert.deepStrictEqual(same.data, { same: true, v: nv.data.home.v });
  assert.ok((await ben('GET', `/api/homes/${HOME}?since=${nv.data.home.v}&week=2020-01-06`)).data.home, 'a new week is never "same"');
});

test('strangers get the 404 a missing household gets, signed in or not; guessing codes is limited', async () => {
  for (const c of [client(), await register('olly.other@example.com')]) {
    for (const [m, p, b] of [['GET', `/api/homes/${HOME}`], ['PUT', `/api/homes/${HOME}/ticks/cabcdefg1_0`], ['POST', `/api/homes/${HOME}/swaps/cabcdefg1_0`, { action: 'claim' }], ['POST', `/api/homes/${HOME}/chores`, { name: 'Spy', effort: 1, freq: 'weekly' }], ['PATCH', `/api/homes/${HOME}/members/${hostMid}`, { name: 'Pwned' }], ['DELETE', `/api/homes/${HOME}/members/${hostMid}`]]) {
      const r = await c(m, p, b);
      assert.strictEqual(r.status, 404, `${m} ${p}: ${r.status}`);
      assert.strictEqual(r.data.error, 'No household here.');
    }
  }
  const olly = await register('olly2.other@example.com');
  for (const [m, p] of [['PATCH', `/api/homes/${HOME}`], ['POST', `/api/homes/${HOME}/code`], ['DELETE', `/api/homes/${HOME}`]]) assert.strictEqual((await olly(m, p, { name: 'x' })).status, 404, `${m} ${p}`);
  assert.strictEqual((await client()('GET', '/api/homes/AAAAAAAAAAAAAAAA')).status, 404);
  const guesser = client();
  for (let i = 0; i < H.LIMITS.missesPerIp; i++) await guesser('GET', `/api/join/${H.newCode()}`);
  assert.strictEqual((await guesser('GET', `/api/join/${CODE}`)).status, 429, 'even the right code waits');
  const repeat = client();
  for (let i = 0; i < 40; i++) await repeat('GET', '/api/homes/AAAAAAAAAAAAAAAB');
  assert.strictEqual((await repeat('GET', `/api/join/${CODE}`)).status, 200, 'a dead id polled again is not guessing');
});

test('two phones ticking at once both stick (and the same writes without the transaction would lose one)', async () => {
  const phones = [];
  for (let i = 0; i < 6; i++) {
    const c = client();
    const r = await c('POST', `/api/join/${CODE}`, { name: `Phone${i}` });
    assert.strictEqual(r.status, 200, r.text);
    phones.push(c);
  }
  const v = await host('GET', `/api/homes/${HOME}`);
  const slots = Object.keys(v.data.weeks[0].assign).filter((k) => !v.data.weeks[0].ticks[k]).slice(0, 18);
  const res = await Promise.all(slots.map((s, i) => phones[i % 6]('PUT', `/api/homes/${HOME}/ticks/${s}`)));
  assert.ok(res.every((r) => r.status === 200), res.map((r) => r.status).join(','));
  const after = await host('GET', `/api/homes/${HOME}`);
  for (const s of slots) assert.ok(after.data.weeks[0].ticks[s], `${s} stuck`);
  // Credit is the holder's, whoever tapped.
  const eff = C.effective(after.data.weeks[0]);
  for (const s of slots) assert.strictEqual(after.data.weeks[0].ticks[s].who, eff[s]);
  // The same two writes as a plain read-change-write: one is lost.
  const wid = `${HOME}_${after.data.week}`;
  const [a, b] = Object.keys(after.data.weeks[0].assign).filter((k) => !after.data.weeks[0].ticks[k]).slice(0, 2);
  assert.ok(a && b);
  await Promise.all([a, b].map((s) => store._unsafeUpdate('weeks', wid, (cur) => ({ ...cur, ticks: { ...cur.ticks, [s]: { who: hostMid, by: hostMid, pts: 1, at: 'x' } } }))));
  const lost = await store.get('weeks', wid);
  assert.ok(!(lost.ticks[a] && lost.ticks[b]), 'without the queue one tick is lost');
  // Untick twice at once: both answer, the tick is gone once.
  const r2 = await Promise.all([host('DELETE', `/api/homes/${HOME}/ticks/${slots[0]}`), phones[0]('DELETE', `/api/homes/${HOME}/ticks/${slots[0]}`)]);
  assert.deepStrictEqual(r2.map((r) => r.status), [200, 200]);
  assert.ok(!(await host('GET', `/api/homes/${HOME}`)).data.weeks[0].ticks[slots[0]]);
  assert.strictEqual((await host('PUT', `/api/homes/${HOME}/ticks/cnotreal1_0`)).status, 404);
  assert.strictEqual((await host('PUT', `/api/homes/${HOME}/ticks/..%2F..%2Fx`)).status, 404);
  // Leave the phones: they are cleaned up below.
  for (const c of phones) await c('DELETE', `/api/homes/${HOME}/members/${(await c('GET', `/api/homes/${HOME}`)).data.home.me}`);
});

test('swaps: offer, one taker when two claim at once, the points move, only the offerer takes it back', async () => {
  const ben = client();
  const look = await ben('GET', `/api/join/${CODE}`);
  await ben('POST', `/api/join/${CODE}`, { seat: look.data.seats[0].id }); // Cleo
  const cleoMid = (await ben('GET', `/api/homes/${HOME}`)).data.home.me;
  const dev = client();
  await dev('POST', `/api/join/${CODE}`, { seat: look.data.seats[1].id }); // Dev
  const v = (await host('GET', `/api/homes/${HOME}`)).data;
  const eff = C.effective(v.weeks[0]);
  const home = v.home;
  const mine = Object.keys(eff).find((k) => eff[k] === hostMid && !v.weeks[0].ticks[k] && home.members.filter((m) => m.id !== hostMid).every((m) => !m.cant.includes(k.split('_')[0])));
  assert.ok(mine, 'the host has a chore to offer');
  const notMine = Object.keys(eff).find((k) => eff[k] === cleoMid && !v.weeks[0].ticks[k]);
  assert.ok(notMine, 'Cleo has a chore of her own');
  assert.strictEqual((await host('POST', `/api/homes/${HOME}/swaps/${mine}`, { action: 'nope' })).status, 400);
  assert.strictEqual((await ben('POST', `/api/homes/${HOME}/swaps/${mine}`, { action: 'offer' })).status, 403, 'only your own');
  assert.strictEqual((await host('POST', `/api/homes/${HOME}/swaps/${mine}`, { action: 'offer' })).status, 200);
  assert.strictEqual((await host('POST', `/api/homes/${HOME}/swaps/${mine}`, { action: 'claim' })).status, 409, 'not your own offer');
  const both = await Promise.all([ben('POST', `/api/homes/${HOME}/swaps/${mine}`, { action: 'claim' }), dev('POST', `/api/homes/${HOME}/swaps/${mine}`, { action: 'claim' })]);
  assert.deepStrictEqual(both.map((r) => r.status).sort(), [200, 409], 'one taker');
  const winner = both[0].status === 200 ? ben : dev;
  const after = (await host('GET', `/api/homes/${HOME}`)).data;
  const taker = (await winner('GET', `/api/homes/${HOME}`)).data.home.me;
  assert.strictEqual(C.effective(after.weeks[0])[mine], taker, 'the chore moved');
  const rowsBefore = C.board(home, v.weeks[0]); const rowsAfter = C.board(after.home, after.weeks[0]);
  const pts = C.slotOf(after.home, after.weeks[0], mine).slot.pts;
  assert.strictEqual(rowsAfter.find((r) => r.id === taker).total, rowsBefore.find((r) => r.id === taker).total + pts, 'the points moved with it');
  assert.strictEqual(rowsAfter.find((r) => r.id === hostMid).total, rowsBefore.find((r) => r.id === hostMid).total - pts);
  assert.strictEqual((await host('POST', `/api/homes/${HOME}/swaps/${mine}`, { action: 'cancel' })).status, 200, 'cancelling a claimed one does nothing');
  assert.strictEqual(C.effective((await host('GET', `/api/homes/${HOME}`)).data.weeks[0])[mine], taker);
  // Tick it: credited to the taker.
  await host('PUT', `/api/homes/${HOME}/ticks/${mine}`);
  assert.strictEqual((await host('GET', `/api/homes/${HOME}`)).data.weeks[0].ticks[mine].who, taker);
  // Offer and take back.
  assert.strictEqual((await ben('POST', `/api/homes/${HOME}/swaps/${notMine}`, { action: 'offer' })).status, 200);
  assert.strictEqual((await dev('POST', `/api/homes/${HOME}/swaps/${notMine}`, { action: 'cancel' })).status, 403, 'only the offerer takes it back');
  assert.strictEqual((await ben('POST', `/api/homes/${HOME}/swaps/${notMine}`, { action: 'cancel' })).status, 200);
  assert.ok(!(await ben('GET', `/api/homes/${HOME}`)).data.weeks[0].swaps[notMine]);
  // `give` is for a phone the household shares, never online.
  assert.strictEqual((await host('POST', `/api/homes/${HOME}/swaps/${notMine}`, { action: 'give' })).status, 400);
});

test('people and chores: your own settings, the host’s weights, a re-deal that keeps what is done, and the caps', async () => {
  const cleo = client();
  const look = await cleo('GET', `/api/join/${CODE}`);
  // Everyone has joined by now except perhaps nobody; join as someone new.
  await cleo('POST', `/api/join/${CODE}`, { name: 'Gwen' });
  const v = (await cleo('GET', `/api/homes/${HOME}`)).data;
  const me = v.home.me;
  const bath = v.home.chores.find((c) => c.name === 'Clean the bathroom').id;
  assert.ok(look.status === 200);
  const r = await cleo('PATCH', `/api/homes/${HOME}/members/${me}`, { cant: [bath, 'cnotachore'], dislikes: [bath] });
  assert.strictEqual(r.status, 200, r.text);
  const mine = r.data.home.members.find((m) => m.id === me);
  assert.deepStrictEqual([mine.cant, mine.dislikes], [[bath], [bath]]);
  assert.ok(!Object.entries(C.effective(r.data.weeks[0])).some(([k, w]) => w === me && k.startsWith(bath)), 're-dealt without the bathroom for Gwen');
  assert.strictEqual((await cleo('PATCH', `/api/homes/${HOME}/members/${me}`, { weight: 0.25 })).status, 403, 'weights are the host’s');
  assert.strictEqual((await cleo('PATCH', `/api/homes/${HOME}/members/${hostMid}`, { cant: [bath] })).status, 403, 'not someone else’s');
  const hw = await host('PATCH', `/api/homes/${HOME}/members/${me}`, { weight: 0.5 });
  assert.strictEqual(hw.data.home.members.find((m) => m.id === me).weight, 0.5);
  assert.strictEqual((await host('PATCH', `/api/homes/${HOME}/members/${me}`, { weight: 3 })).status, 400);
  // A done tick survives a chore change.
  const before = (await host('GET', `/api/homes/${HOME}`)).data;
  const done = Object.keys(before.weeks[0].ticks);
  assert.ok(done.length);
  const add = await cleo('POST', `/api/homes/${HOME}/chores`, { name: 'Water the <i>plants</i>', emoji: '🪴', effort: 1, freq: 'weekly' });
  assert.strictEqual(add.status, 200, add.text);
  const plant = add.data.home.chores.find((c) => c.name === 'Water the plants');
  assert.ok(plant && plant.start === add.data.week, 'starts this week');
  for (const k of done) assert.deepStrictEqual(add.data.weeks[0].ticks[k], before.weeks[0].ticks[k], 'done stays done');
  assert.ok(add.data.weeks[0].assign[plant.id + '_0'], 'and the new chore is dealt');
  const ed = await cleo('PATCH', `/api/homes/${HOME}/chores/${plant.id}`, { effort: 2, freq: 'often' });
  assert.deepStrictEqual([ed.data.home.chores.find((c) => c.id === plant.id).effort, ed.data.home.chores.find((c) => c.id === plant.id).freq], [2, 'often']);
  assert.strictEqual((await cleo('PATCH', `/api/homes/${HOME}/chores/${plant.id}`, { effort: 7 })).status, 400);
  assert.strictEqual((await cleo('DELETE', `/api/homes/${HOME}/chores/${plant.id}`)).status, 200);
  assert.strictEqual((await cleo('DELETE', `/api/homes/${HOME}/chores/${plant.id}`)).status, 404);
  // Caps: sixty chores.
  const have = ed.data.home.chores.length - 1;
  const many = Array.from({ length: C.LIMITS.chores - have }, (_, i) => ({ name: `Extra ${i}`, emoji: '🧹', effort: 1, freq: 'monthly' }));
  assert.strictEqual((await host('POST', `/api/homes/${HOME}/chores`, { chores: many })).status, 200);
  assert.strictEqual((await host('POST', `/api/homes/${HOME}/chores`, { name: 'One too many', effort: 1, freq: 'weekly' })).status, 409);
  // ...and twelve people.
  const now = (await host('GET', `/api/homes/${HOME}`)).data.home.members.length;
  for (let i = now; i < C.LIMITS.members; i++) assert.strictEqual((await client()('POST', `/api/join/${CODE}`, { name: `Fill${i}` })).status, 200);
  assert.strictEqual((await client()('POST', `/api/join/${CODE}`, { name: 'Thirteenth' })).status, 409);
  assert.strictEqual((await host('POST', `/api/homes/${HOME}/members`, { name: 'Baby' })).status, 409);
  assert.strictEqual((await client()('GET', `/api/join/${CODE}`)).data.full, true);
  // Leaving and removal.
  assert.strictEqual((await cleo('DELETE', `/api/homes/${HOME}/members/${hostMid}`)).status, 403);
  assert.strictEqual((await host('DELETE', `/api/homes/${HOME}/members/${hostMid}`)).status, 409, 'the host can’t leave');
  const left = await cleo('DELETE', `/api/homes/${HOME}/members/${me}`);
  assert.deepStrictEqual(left.data, { ok: true, left: true });
  assert.strictEqual((await cleo('GET', `/api/homes/${HOME}`)).status, 404, 'gone is gone');
  const after = (await host('GET', `/api/homes/${HOME}`)).data;
  assert.ok(!Object.values(C.effective(after.weeks[0])).includes(me), 're-dealt without her');
});

test('the host: a new code kills the old link, five households at most, delete takes every week with it', async () => {
  const v = await host('POST', `/api/homes/${HOME}/code`, {});
  assert.strictEqual(v.status, 200);
  assert.notStrictEqual(v.data.home.code, CODE);
  assert.strictEqual((await client()('GET', `/api/join/${CODE}`)).status, 404);
  const rn = await host('PATCH', `/api/homes/${HOME}`, { name: '<b>Flat</b> 4B' });
  assert.strictEqual(rn.data.home.name, 'Flat 4B');
  const list = await host('GET', '/api/homes');
  assert.deepStrictEqual(list.data.homes.map((h) => [h.id, h.host]), [[HOME, true]]);
  const zed = await register('zed.many@example.com');
  for (let i = 0; i < H.LIMITS.homesPerHost; i++) {
    const h = localHome(2);
    assert.strictEqual((await zed('POST', '/api/homes', { home: h, me: h.me, tz: 'UTC' })).status, 200);
  }
  const h6 = localHome(2);
  assert.strictEqual((await zed('POST', '/api/homes', { home: h6, me: h6.me, tz: 'UTC' })).status, 409);
  assert.strictEqual((await zed('POST', '/api/homes', { home: { ...h6, members: [] }, me: 'x', tz: 'UTC' })).status, 409, 'the cap comes first');
  const dump = store._dump();
  assert.ok(dump.includes(`${HOME}_`));
  assert.strictEqual((await host('DELETE', `/api/homes/${HOME}`)).status, 200);
  assert.ok(!store._dump().includes(HOME), 'no week or household document names it');
  assert.strictEqual((await host('GET', `/api/homes/${HOME}`)).status, 404);
});

test('a household nobody has touched in 180 days is deleted by the read that finds it', async () => {
  const yan = await register('yan.idle@example.com');
  const h = localHome(2);
  const c = await yan('POST', '/api/homes', { home: h, me: h.me, tz: 'UTC' });
  const id = c.data.id;
  await store.merge('homes', id, { updatedAt: new Date(Date.now() - 181 * 86400000).toISOString() });
  const r = await yan('GET', `/api/homes/${id}`);
  assert.deepStrictEqual([r.status, r.data.code], [404, 'expired']);
  assert.ok(!store._dump().includes(id));
});

test('stored households and weeks hold no email, no account id, no browser key and no photo', async () => {
  const g = client();
  const qq = await register('qq.store@example.com');
  const h = localHome(3);
  const c = await qq('POST', '/api/homes', { home: h, me: h.me, tz: 'UTC' });
  await g('POST', `/api/join/${c.data.home.code}`, { name: 'Keyholder' });
  const dump = store._dump();
  for (const email of ['ana.host@example.com', 'olly.other@example.com', 'zed.many@example.com', 'qq.store@example.com']) {
    assert.ok(!dump.includes(email), `no email: ${email}`);
    assert.ok(!dump.includes(uidOf(email)), `no account id: ${email}`);
  }
  assert.ok(g.cookies.chorus_k && !dump.includes(g.cookies.chorus_k), 'the browser key itself is never stored');
  assert.ok(!dump.includes(MARK) && !dump.includes('/9j/'), 'no photo bytes');
  const doc = await store.get('homes', c.data.id);
  assert.deepStrictEqual(Object.keys(doc).sort(), ['acctTags', 'chores', 'code', 'createdAt', 'id', 'members', 'name', 'ownerTag', 'since', 'tz', 'updatedAt', 'v'].sort());
  for (const m of doc.members) assert.deepStrictEqual(Object.keys(m).sort(), ['acct', 'cant', 'dislikes', 'emoji', 'host', 'id', 'joinedAt', 'keyHash', 'name', 'weight'].sort());
  const wk = await store.get('weeks', `${c.data.id}_${c.data.week}`);
  assert.deepStrictEqual(Object.keys(wk).sort(), ['assign', 'basis', 'createdAt', 'homeId', 'id', 'swaps', 'ticks', 'week'].sort());
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/chorus', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/chorus`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
