// Pure rules first, then end to end against the memory store and the fake
// model:
//   LEASH_MEMORY=1 LEASH_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /leash, the way
// the lab mounts it, so the auth cookie, the budget gate, per-owner scoping
// and the big-body route are exercised as deployed. Model calls are counted
// from the identity's usage rows - the same rows that bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.LEASH_MEMORY !== '1' || process.env.LEASH_FAKE_AI !== '1') {
  console.error('run with LEASH_MEMORY=1 LEASH_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const C = require('../public/leash-core');
const Sample = require('../public/sample');
const ai = require('../lib/ai');
const A = require('../lib/agents');

let base;
function client() {
  const cookies = {};
  return async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
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
const say = (p) => p.map((x) => (x.b !== undefined ? x.b : x.t)).join('');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const IDS = C.CATALOG.map((c) => c.id);
const on = (id, extra = {}) => ({ autonomy: 'alone', perAction: null, perDay: null, logged: false, undo: C.BY_ID[id].undo === false ? null : 'no', ...extra });
const prof = (caps, extra = {}) => C.cleanProfile({ name: 'T', talksTo: ['customers'], watch: { mode: 'business' }, rate: 20, caps, ...extra });
const sc = (p) => C.score(p).score;

/** A deterministic random profile generator for property tests. */
function randomProfile(next) {
  const caps = {};
  for (const cat of C.CATALOG) {
    const r = next();
    if (r < 0.45) continue;
    caps[cat.id] = {
      autonomy: next() < 0.5 ? 'ask' : 'alone',
      perAction: cat.unit === 'money' && next() < 0.5 ? Math.floor(next() * 1000000) : null,
      perDay: next() < 0.5 ? (cat.unit === 'money' ? Math.floor(next() * 10000000) : Math.floor(next() * 20000)) : null,
      logged: next() < 0.5,
      undo: C.UNDO[Math.floor(next() * 3)],
    };
  }
  const modes = C.WATCH.map((w) => w.id);
  return C.cleanProfile({ caps, watch: { mode: modes[Math.floor(next() * modes.length)], everyHours: 1 + Math.floor(next() * 30) }, rate: 1 + Math.floor(next() * 200) });
}

/* ---------------- the catalog ---------------- */

test('the catalog: 18 capabilities, six groups of three, every field sane', () => {
  assert.strictEqual(C.CATALOG.length, 18);
  assert.deepStrictEqual(C.GROUPS.map((g) => g.id), ['money', 'customers', 'data', 'systems', 'outside', 'decisions']);
  for (const g of C.GROUPS) assert.strictEqual(C.CATALOG.filter((c) => c.group === g.id).length, 3, g.id);
  assert.strictEqual(new Set(IDS).size, 18, 'ids are unique');
  for (const c of C.CATALOG) {
    assert.ok(/^[a-z_]+$/.test(c.id), c.id);
    assert.ok(c.label && c.desc && c.short && c.one, `${c.id} has its words`);
    assert.ok(Number.isInteger(c.severity) && c.severity >= 1 && c.severity <= 10, `${c.id} severity`);
    assert.ok(['money', 'count'].includes(c.unit), `${c.id} unit`);
    assert.ok(c.refD > c.sugD && c.sugD > 0, `${c.id}: suggested daily limit is under the large one`);
    if (c.unit === 'money') assert.ok(c.refA > c.sugA && c.sugA > 0, `${c.id}: per-action`);
    else assert.ok(c.noun, `${c.id} noun`);
    assert.ok(c.undo === false || C.UNDO.includes(c.undo), `${c.id} undo default`);
    if (c.undoFix) assert.ok(C.UNDO.includes(c.undoFix.to) && C.UNDO.indexOf(c.undoFix.to) < C.UNDO.indexOf(c.undo), `${c.id} undo fix improves`);
    if (c.worst) {
      assert.strictEqual(c.worst.length, 2);
      assert.ok(c.worst[0].includes('{x}') && !c.worst[1].includes('{x}') && /\{[^}]+\}/.test(c.worst[1]), `${c.id} worst templates`);
    }
  }
  assert.ok(C.BY_ID.payouts.severity === 10 && C.BY_ID.apis.severity === 5, 'the HOW text quotes these');
});

test('the drill bank: ~30+ cards, valid, and every capability has at least two stories', () => {
  assert.ok(C.CARDS.length >= 30, `${C.CARDS.length} cards`);
  assert.strictEqual(new Set(C.CARDS.map((c) => c.id)).size, C.CARDS.length);
  for (const card of C.CARDS) {
    assert.ok(card.caps.every((id) => C.BY_ID[id]), card.id);
    assert.strictEqual(card.r.length, 4, `${card.id} has four responses`);
    for (const r of card.r) assert.ok(['kill', 'logs', 'undo', 'limit', 'approve', 'bad'].includes(r[0]) && r[1], `${card.id} ${r[0]}`);
    assert.ok(card.r.some((r) => r[0] === 'bad'), `${card.id} has a wrong answer`);
    assert.ok(card.r.filter((r) => r[0] !== 'bad').length >= 2, `${card.id} has real choices`);
    assert.ok(card.title && card.text.length < 240, card.id);
  }
  for (const id of IDS) assert.ok(C.CARDS.filter((c) => c.caps[0] === id).length >= 2 || C.CARDS.filter((c) => c.caps.includes(id)).length >= 2, `${id} has two cards`);
  assert.ok(C.CARDS.filter((c) => !c.caps.length).length >= 2, 'generic cards for any agent');
});

/* ---------------- numbers ---------------- */

test('money and counts are read from the digits; words are no figure', () => {
  const cases = { '$1,240.50': 124050, '500': 50000, '$500': 50000, '500 a day': 50000, '0.5': 50, '12.345': 1235, 'USD 12': 1200 };
  for (const [v, want] of Object.entries(cases)) assert.strictEqual(C.toCents(v), want, v);
  assert.strictEqual(C.toCents(0.1 + 0.2), 30);
  for (const bad of ['five hundred dollars', 'lots', '', '-40', '1e5', NaN, Infinity, -1, {}, null, '99999999999999']) assert.strictEqual(C.toCents(bad), null, String(bad));
  assert.deepStrictEqual(['1,400', '500 records a day', 500, '200/day', 'lots', '-3', '2.5', 12.5].map(C.toCount), [1400, 500, 500, 200, null, null, null, null]);
  assert.deepStrictEqual([999, 1000, 12345, 240000, 987654].map(C.floor2), [999, 1000, 12000, 240000, 980000]);
  assert.strictEqual(C.worstMoney(1234599), '$12,000', 'down, never up');
  assert.strictEqual(C.worstMoney(99999), '$999');
  // A saved number is already cents; a typed string is dollars.
  assert.strictEqual(C.cleanProfile({ caps: { refunds: { autonomy: 'alone', perAction: 50000 } } }).caps.refunds.perAction, 50000);
  assert.strictEqual(C.cleanProfile({ caps: { refunds: { autonomy: 'alone', perAction: '500' } } }).caps.refunds.perAction, 50000);
  assert.strictEqual(C.cleanProfile({ caps: { refunds: { autonomy: 'alone', perAction: 12.5 } } }).caps.refunds.perAction, null, 'a fractional cent is not a stored limit');
  assert.strictEqual(C.cleanProfile({ caps: { email: { autonomy: 'alone', perAction: 5 } } }).caps.email.perAction, null, 'a count has no per-action limit');
});

test('profiles are cleaned: unknown ids, off entries and bad enums drop out', () => {
  const p = C.cleanProfile({ name: '<b>Bot</b>\u202e', caps: { refunds: { autonomy: 'yolo' }, nope: { autonomy: 'alone' }, email: { autonomy: 'ask', undo: 'maybe', logged: 'yes' }, __proto__: { x: 1 } }, watch: { mode: 'sometimes', everyHours: -4 }, rate: 'lots', talksTo: ['public', 'aliens'] });
  assert.deepStrictEqual(Object.keys(p.caps), ['email']);
  assert.deepStrictEqual(p.caps.email, { autonomy: 'ask', perAction: null, perDay: null, logged: false, undo: 'no' });
  assert.strictEqual(p.name, 'Bot');
  assert.deepStrictEqual([p.watch, p.rate, p.talksTo], [{ mode: 'business', everyHours: 4 }, 20, ['public']]);
  assert.strictEqual(C.cleanProfile({ caps: { browse: { autonomy: 'alone', undo: 'yes' } } }).caps.browse.undo, null, 'undo means nothing for reading a page');
});

/* ---------------- the score ---------------- */

test('score: nothing on or everything off is 0 and Low; bands at 25, 50, 75', () => {
  assert.deepStrictEqual([sc(prof({})), C.score(prof({})).band.id], [0, 'low']);
  const off = {}; for (const id of IDS) off[id] = { autonomy: 'off' };
  assert.strictEqual(sc(prof(off)), 0);
  assert.strictEqual(C.ringText(C.score(prof({}))), 'Blast radius 0 out of 100, Low. Nothing is switched on yet.');
  assert.deepStrictEqual([0, 24, 25, 49, 50, 74, 75, 100].map((s) => C.bandOf(s).id), ['low', 'low', 'watch', 'watch', 'high', 'high', 'severe', 'severe']);
  const all = {}; for (const id of IDS) all[id] = on(id);
  const worst = C.score(prof(all, { watch: { mode: 'none' } }));
  assert.ok(worst.score >= 99 && worst.band.id === 'severe', `everything alone, unlimited, unlogged, unwatched: ${worst.score}`);
  assert.ok(sc(prof({ apis: { autonomy: 'ask', perDay: 10, logged: true } }, { watch: { mode: 'always' } })) <= 2, 'one small, watched, logged thing is near 0');
});

test('score: the groups add up to the score exactly, and the ring says it in words', () => {
  let seed = 7;
  const next = C.rng(seed);
  for (let i = 0; i < 300; i++) {
    const p = randomProfile(next);
    const s = C.score(p);
    assert.strictEqual(s.groups.reduce((a, g) => a + g.points, 0), s.score);
    assert.ok(s.score >= 0 && s.score <= 100 && Number.isInteger(s.score));
    if (s.score) assert.match(C.ringText(s), new RegExp(`^Blast radius ${s.score} out of 100, ${s.band.label}\\. Points by area: `));
  }
  seed++;
});

test('score is monotonic: more freedom, fewer limits, less logging or undo, more unwatched hours never lower it', () => {
  const next = C.rng(20260930);
  const hoursOrder = [{ mode: 'always' }, { mode: 'checks', everyHours: 2 }, { mode: 'checks', everyHours: 4 }, { mode: 'waking' }, { mode: 'checks', everyHours: 12 }, { mode: 'business' }, { mode: 'none' }];
  for (let i = 0; i < 400; i++) {
    const p = randomProfile(next);
    const s0 = sc(p);
    for (const id of IDS) {
      const cat = C.BY_ID[id];
      const c = p.caps[id];
      const up = JSON.parse(JSON.stringify(p));
      if (!c) { up.caps[id] = on(id, { autonomy: 'ask' }); assert.ok(sc(up) >= s0, `turning ${id} on`); continue; }
      if (c.autonomy === 'ask') { up.caps[id].autonomy = 'alone'; assert.ok(sc(up) >= s0, `${id} ask -> alone`); }
      const noLim = JSON.parse(JSON.stringify(p)); noLim.caps[id].perDay = null; assert.ok(sc(noLim) >= s0, `${id} daily limit removed`);
      const bigger = JSON.parse(JSON.stringify(p)); if (c.perDay !== null) { bigger.caps[id].perDay = c.perDay * 3 + 1; assert.ok(sc(bigger) >= s0, `${id} limit raised`); }
      if (cat.unit === 'money') { const na = JSON.parse(JSON.stringify(p)); na.caps[id].perAction = null; assert.ok(sc(na) >= s0, `${id} per-action removed`); }
      if (c.logged) { const nl = JSON.parse(JSON.stringify(p)); nl.caps[id].logged = false; assert.ok(sc(nl) >= s0, `${id} logging removed`); }
      if (c.undo && c.undo !== 'no') { const nu = JSON.parse(JSON.stringify(p)); nu.caps[id].undo = C.UNDO[C.UNDO.indexOf(c.undo) + 1]; assert.ok(sc(nu) >= s0, `${id} less undoable`); }
    }
    let prev = -1;
    for (const w of hoursOrder) {
      const q = JSON.parse(JSON.stringify(p)); q.watch = w;
      const s = sc(q);
      assert.ok(s >= prev, `more unwatched hours (${JSON.stringify(w)}) lowered it`);
      prev = s;
    }
  }
  assert.deepStrictEqual(hoursOrder.map(C.windowHours), [1, 2, 4, 8, 12, 24, 24]);
  assert.strictEqual(C.windowHours({ mode: 'checks', everyHours: 72 }), 24, 'a worst day is a day');
});

/* ---------------- the worst day ---------------- */

test('worst day: the sample lands - $240,000 in refunds, no ceiling on discounts, 480 emails', () => {
  const w = C.worstDay(Sample.profile());
  assert.strictEqual(say(w.parts), 'On its worst day it could refund $240,000, give away any amount in discounts and email 480 customers before anyone looks.');
  assert.deepStrictEqual(w.parts.filter((x) => x.b).map((x) => x.b), ['$240,000', 'any amount', '480']);
  assert.ok(w.notes.includes('No limit set on discounts and personal-data reads - no ceiling.'));
  assert.ok(w.notes.includes('Nobody watches at weekends - 24 hours at a stretch on its worst day.'));
  assert.strictEqual(w.more.length, 1, "reading every customer's record is the fourth");
});

test('worst day: rounded down, never overstated; the daily limit caps the rate', () => {
  // $1,234.56 a day is $1,200 on the page, not $1,235.
  let w = C.worstDay(prof({ refunds: on('refunds', { perDay: 123456 }) }));
  assert.strictEqual(say(w.parts), 'On its worst day it could refund $1,200 before anyone looks.');
  // Per-action x rate x hours when that is under the daily limit.
  w = C.worstDay(prof({ refunds: on('refunds', { perAction: 5000, perDay: 10000000 }) }, { watch: { mode: 'waking' }, rate: 3 }));
  assert.match(say(w.parts), /refund \$1,200 before/, '$50 x 3 an hour x 8 hours');
  // A $12,345 day is $12,000.
  w = C.worstDay(prof({ payouts: on('payouts', { perDay: 1234500 }) }));
  assert.match(say(w.parts), /pay out \$12,000 before/);
  // Counts: 2,480 floor to 2,400.
  w = C.worstDay(prof({ email: on('email') }, { rate: 104, watch: { mode: 'none' } }));
  assert.match(say(w.parts), /email 2,400 customers before/);
  w = C.worstDay(prof({ email: on('email', { perDay: 150 }) }, { rate: 104 }));
  assert.match(say(w.parts), /email 150 customers before/);
});

test('worst day: a blank limit says "no ceiling" plainly', () => {
  let w = C.worstDay(prof({ refunds: on('refunds') }));
  assert.strictEqual(say(w.parts), 'On its worst day it could refund any amount before anyone looks.');
  assert.ok(w.notes[0] === 'No limit set on refunds - no ceiling.');
  w = C.worstDay(prof({ export: on('export') }));
  assert.match(say(w.parts), /export every record it can reach/);
  w = C.worstDay(prof({ export: on('export', { perDay: 500 }) }));
  assert.match(say(w.parts), /export 500 records/);
  assert.ok(!w.notes.some((n) => /no ceiling/.test(n)));
});

test('worst day: 24/7, all asking, nothing on, reading only', () => {
  let w = C.worstDay(prof({ refunds: on('refunds', { perAction: 10000 }) }, { watch: { mode: 'always' }, rate: 30 }));
  assert.match(say(w.parts), /refund \$3,000 before anyone looks/, 'the first hour: $100 x 30');
  assert.ok(w.notes.includes('Watched around the clock - this is the first hour before someone steps in.'));
  assert.strictEqual(w.hours, 1);
  w = C.worstDay(prof({}));
  assert.deepStrictEqual([w.empty, say(w.parts)], [true, 'Tick what your agent can do and its worst day shows here.']);
  w = C.worstDay(prof({ refunds: on('refunds', { autonomy: 'ask' }), email: on('email', { autonomy: 'ask' }) }));
  assert.strictEqual(say(w.parts), 'Nothing it does happens without a person saying yes first. Its worst day is its worst approval.');
  w = C.worstDay(prof({ browse: on('browse'), apis: on('apis') }));
  assert.match(say(w.parts), /^Alone it only reads and calls out \(web browsing and API calls\)/);
  w = C.worstDay(prof({ refunds: on('refunds', { perDay: 100000 }), email: on('email', { autonomy: 'ask' }) }));
  assert.ok(w.notes.includes('Customer email waits for a human.'));
  w = C.worstDay(prof({ refunds: on('refunds', { perDay: 100000 }) }, { watch: { mode: 'checks', everyHours: 6 } }));
  assert.ok(w.notes.includes('Someone checks its log every 6 hours - up to 6 hours at a stretch.'));
});

/* ---------------- fixes ---------------- */

test('fixes: each delta is exactly the re-score, none does nothing, the top one lowers it', () => {
  const next = C.rng(99);
  for (let i = 0; i < 200; i++) {
    const p = randomProfile(next);
    const now = sc(p);
    const list = C.fixes(p);
    for (const f of list) {
      assert.strictEqual(f.delta, now - sc(C.applyFix(p, f.id)), f.id);
      assert.strictEqual(f.after, now - f.delta);
      assert.ok(f.delta >= 1, `${f.id} moves the score`);
    }
    for (let k = 1; k < list.length; k++) assert.ok(list[k - 1].delta >= list[k].delta, 'biggest first');
    if (list.length) assert.ok(sc(C.applyFix(p, list[0].id)) < now);
    // Candidates that move nothing are never offered.
    const offered = new Set(list.map((f) => f.id));
    for (const f of C.candidates(p)) if (!offered.has(f.id)) assert.ok(now - sc(C.applyFix(p, f.id)) < 1, `${f.id} was left out`);
  }
  assert.deepStrictEqual(C.fixes(prof({})), [], 'nothing on, nothing to fix');
  const p = prof({ refunds: on('refunds') });
  assert.deepStrictEqual(C.applyFix(p, 'nonsense:refunds'), p, 'an unknown fix changes nothing');
  assert.deepStrictEqual(C.applyFix(p, 'log:email'), p, 'a fix for something off changes nothing');
  assert.ok(!C.candidates(prof({ browse: on('browse') })).some((f) => /^(ask|cap):browse/.test(f.id)), 'no "approve every page"');
});

test('fixes: the sample is High and three fixes drop it into Watch', () => {
  const p = Sample.profile();
  assert.deepStrictEqual([sc(p), C.score(p).band.id], [68, 'high']);
  const list = C.fixes(p);
  assert.strictEqual(list[0].text, 'Have someone check its log every 4 hours, weekends too');
  let q = p;
  for (const f of list.slice(0, 3)) q = C.applyFix(q, f.id);
  assert.strictEqual(C.score(q).band.id, 'watch', `top three at once: ${sc(q)}`);
  q = p;
  for (let k = 0; k < 3; k++) q = C.applyFix(q, C.fixes(q)[0].id);
  assert.strictEqual(C.score(q).band.id, 'watch', `one at a time: ${sc(q)}`);
  assert.ok(list.some((f) => f.text === 'Cap refunds at $1,000 a day'));
  assert.ok(list.some((f) => f.text === 'Turn on replayable logs for customer email'));
  assert.ok(list.some((f) => f.text === 'Cap customer email at 200 customers a day'));
});

/* ---------------- the drill ---------------- */

test('drill: the same seed deals the same cards; cards only for what is switched on', () => {
  const p = Sample.profile();
  assert.deepStrictEqual(C.deal(p, 42), C.deal(p, 42));
  const seen = new Set();
  for (let s = 1; s <= 60; s++) {
    const d = C.deal(p, s);
    assert.strictEqual(d.length, 3);
    assert.strictEqual(new Set(d.map((x) => x.id)).size, 3, 'three different cards');
    for (const x of d) {
      const card = C.CARDS.find((c) => c.id === x.id);
      assert.ok(card.caps.every((id) => C.cleanProfile(p).caps[id]), `${x.id} needs only what is on`);
      assert.deepStrictEqual([...x.order].sort(), [0, 1, 2, 3]);
      seen.add(x.id);
    }
  }
  assert.ok(seen.size >= 8, `different runs deal different cards (${seen.size})`);
  assert.deepStrictEqual(C.deal(prof({}), 1), [], 'nothing on, no drill');
  const one = C.deal(prof({ deploy: on('deploy') }), 3);
  assert.strictEqual(one.length, 3);
  assert.deepStrictEqual(one.slice(0, 2).map((x) => x.focus).sort(), ['deploy', 'deploy']);
  assert.strictEqual(one[2].focus, null, 'topped up with a card for any agent');
  assert.ok(!C.eligible(prof({ export: on('export') })).some((c) => c.id === 'hidden'), 'the injection card needs browsing too');
});

test('drill: scoring reads the charter and the profile, not just the answer', () => {
  const card = { id: 'refund-loop', order: [0, 1, 2, 3] };
  const bare = prof({ refunds: on('refunds') });
  let ev = C.evaluate(card, bare, {});
  assert.strictEqual(ev.prep.points, 0, 'nothing in place');
  assert.deepStrictEqual(ev.responses.map((r) => r.works), [false, false, false, false]);
  assert.strictEqual(ev.responses[ev.best].type, 'kill', 'with nothing, stopping it is still the best call');
  assert.match(ev.responses[0].outcome, /Nobody is named/);
  const kinds = ev.prep.missing.map((m) => m.fix || m.field);
  assert.deepStrictEqual(kinds, ['killOwner', 'log:refunds', 'ask:refunds', 'cap:refunds']);
  // An owner but no "how" is part of the way.
  ev = C.evaluate(card, bare, { killOwner: 'Sam' });
  assert.strictEqual(ev.prep.points, 15);
  assert.match(ev.responses[0].outcome, /Sam owns the switch, but nobody wrote down how/);
  // Everything in place.
  const ready = prof({ refunds: on('refunds', { autonomy: 'ask', perDay: 100000, logged: true, undo: 'yes' }) });
  const ch = { killOwner: 'Sam (ops)', killHow: 'Flag off in admin', killSpeed: 'in 2 minutes' };
  ev = C.evaluate(card, ready, ch);
  assert.strictEqual(ev.prep.points, 100);
  assert.deepStrictEqual(ev.prep.missing, []);
  assert.deepStrictEqual(ev.responses.map((r) => [r.type, r.works]), [['kill', true], ['logs', true], ['limit', true], ['bad', false]]);
  assert.strictEqual(ev.responses[0].outcome, 'Sam (ops) switches it off (in 2 minutes). It stops.');
  assert.match(ev.responses[2].outcome, /stops itself at \$1,000 a day/);
  // The best call follows the profile: a card whose best is the logs, with no logs, is not logs.
  const explain = { id: 'explain', order: [0, 1, 2, 3] };
  const withLogs = prof({ approve: on('approve', { logged: true }) });
  assert.strictEqual(C.evaluate(explain, withLogs, {}).responses[C.evaluate(explain, withLogs, {}).best].type, 'logs');
  const noLogs = prof({ approve: on('approve') });
  assert.notStrictEqual(C.evaluate(explain, noLogs, {}).responses[C.evaluate(explain, noLogs, {}).best].type, 'logs');
});

test('drill: a result averages readiness, counts best calls and ranks what would have saved you', () => {
  const p = Sample.profile();
  const dealt = C.deal(p, 5);
  const picks = dealt.map((d) => C.evaluate(d, p, Sample.charter()).best);
  let res = C.result(dealt, picks, p, Sample.charter());
  assert.strictEqual(res.calls, 3);
  assert.strictEqual(res.readiness, Math.round(res.rounds.reduce((a, r) => a + r.prep, 0) / 3));
  assert.ok(['Ready', 'Shaky', 'Not ready'].includes(res.label));
  assert.strictEqual(res.saves[0].field, 'killHow', 'the kill switch comes first');
  const keys = res.saves.map((s) => s.fix || s.field);
  assert.strictEqual(new Set(keys).size, keys.length, 'each once');
  res = C.result(dealt, [null, null, null], p, Sample.charter());
  assert.deepStrictEqual([res.calls, res.rounds.every((r) => r.timedOut)], [0, true], 'time ran out on every card');
  // Applying what would have saved you raises readiness.
  let q = p;
  for (const s of res.saves) if (s.kind === 'fix') q = C.applyFix(q, s.fix);
  const after = C.result(dealt, [null, null, null], q, { ...Sample.charter(), killHow: 'Admin > Support bot > off', review: 'monthly' });
  assert.ok(after.readiness > res.readiness, `${res.readiness} -> ${after.readiness}`);
  assert.deepStrictEqual(C.cleanDrill({ at: '2026-09-30T10:00:00.000Z', readiness: 101, calls: 1, rounds: 3 }), null);
  assert.deepStrictEqual(C.cleanDrill({ at: '2026-09-30T10:00:00.000Z', readiness: 50, calls: 4, rounds: 3 }), null);
  assert.deepStrictEqual(C.cleanDrill({ at: 'yesterday', readiness: 50, calls: 1, rounds: 3 }), null);
  assert.strictEqual(C.cleanDrills(Array.from({ length: 40 }, (_, i) => ({ at: '2026-09-30T10:00:00.000Z', readiness: i, calls: 0, rounds: 3 }))).length, 30);
});

/* ---------------- the charter ---------------- */

test('charter: the sample reads right, and Markdown makes user text inert', () => {
  const md = C.charterMarkdown(Sample.profile(), Sample.charter(), '2026-09-30');
  assert.match(md, /^# Agent charter: Juniper Outdoor's support agent\n/);
  assert.match(md, /- \*\*Issue refunds or credits\*\* - up to \$500 each; no daily limit; logged to replay; cannot be undone/);
  assert.match(md, /- Owner: Priya \(support lead\)\n- How: _not set yet_\n- How fast: _not set yet_/);
  assert.match(md, /## What needs a human first\n\n- Nothing\./);
  assert.match(md, /1\. Stop the agent - use the kill switch above\.[\s\S]*5\. Decide on disclosure with your counsel\./);
  assert.ok(md.includes(C.DISCLAIMER));
  assert.ok(!/reportable|regulation|GDPR|required by law/i.test(md), 'no legal claims');
  const hostile = C.charterMarkdown({ name: '# Pwned **bold** [link](javascript:x) <script>alert(1)</script> `code` |t|', caps: {} },
    { killOwner: '- not a list', killHow: '1. not a list either\nsecond line', killSpeed: '_under_ ~strike~ \\ back' }, 'bad-date');
  const title = hostile.split('\n')[0];
  assert.strictEqual(title, '# Agent charter: \\# Pwned \\*\\*bold\\*\\* \\[link\\](javascript:x) alert(1) \\`code\\` \\|t\\|', 'markup escaped, tags dropped');
  assert.ok(!/<script/i.test(hostile));
  assert.match(hostile, /- Owner: \\- not a list\n/);
  assert.match(hostile, /- How: 1\\\. not a list either second line\n/, 'one line, and a leading "1." escaped');
  assert.match(hostile, /- How fast: \\_under\\_ \\~strike\\~ \\\\ back/);
  assert.ok(!/Written bad-date/.test(hostile));
  assert.strictEqual(C.md('1. start'), '1\\. start');
});

/* ---------------- reading an agent ---------------- */

test('extraction: hostile model output is bounded, stripped, checked and quotes verified', () => {
  const text = 'Tools: issue_refund(order_id, amount) refunds up to $500. You must always email every customer on the list.';
  const raw = {
    capabilities: [
      { id: '<script>alert(1)</script>', autonomy: 'alone', limit: null, evidence: 'x', confidence: 'high' },
      { id: 'refunds', autonomy: 'yolo', limit: { perAction: 'five hundred dollars', perDay: '$1,000' }, evidence: `<img src=x onerror=alert(1)>${'Q'.repeat(9000)}`, confidence: 'certain' },
      { id: 'refunds', autonomy: 'ask', limit: null, evidence: 'duplicate', confidence: 'low' },
      { id: 'email', autonomy: 'ask', limit: { perDay: 'lots' }, evidence: 'You must always  email every customer on the list.', confidence: 'high' },
      { id: 'export', autonomy: 'alone', limit: { perDay: -40 }, evidence: '\u202e\u0000 evil', confidence: 'medium' },
      { id: 'browse', autonomy: 'alone', limit: { perAction: '999', perDay: 12.5 }, evidence: { nested: true }, confidence: 'low' },
      { id: 'payouts', autonomy: 'alone', limit: { perAction: 9e99, perDay: '500' }, evidence: 'refunds up to $500', confidence: 'high' },
      'junk', null,
      ...Array.from({ length: 60 }, (_, i) => ({ id: `made_up_${i}`, autonomy: 'alone', evidence: 'x' })),
    ],
    risks: ['<b>Bold</b> risk', 'R'.repeat(5000), '', { no: 1 }, 'Same', 'Same', 'Four', 'Five', 'Six', 'Seven'],
  };
  const out = C.cleanExtraction(raw, text);
  assert.deepStrictEqual(out.found.map((f) => f.id), ['refunds', 'payouts', 'email', 'export', 'browse'], 'catalog ids only, each once, in catalog order');
  const by = Object.fromEntries(out.found.map((f) => [f.id, f]));
  assert.deepStrictEqual([by.refunds.autonomy, by.refunds.perAction, by.refunds.perDay, by.refunds.confidence], ['alone', null, 100000, 'low'], 'a bad enum is never trusted; a limit in words is no limit');
  assert.ok(by.refunds.quote.length <= C.LIMITS.quote && !/[<>]/.test(by.refunds.quote), 'bounded and stripped');
  assert.strictEqual(by.refunds.verified, false);
  assert.deepStrictEqual([by.email.verified, by.email.perDay, by.email.autonomy], [true, null, 'ask'], 'a quote with extra spaces still matches');
  assert.deepStrictEqual([by.export.perDay, by.export.quote], [null, 'evil'], 'negative limits and control characters gone');
  assert.deepStrictEqual([by.browse.perAction, by.browse.perDay, by.browse.quote, by.browse.verified], [null, null, '', false], 'no per-action on a count; 12.5 is no count');
  assert.deepStrictEqual([by.payouts.perAction, by.payouts.perDay, by.payouts.verified], [null, 50000, true], 'an absurd number is no limit; a model\'s "500" is dollars');
  assert.strictEqual(out.unverified, 3);
  assert.deepStrictEqual(out.risks.map((r) => r.length <= C.LIMITS.risk), [true, true, true, true, true]);
  assert.strictEqual(out.risks.length, 5);
  assert.ok(!out.risks.some((r) => /<b>/.test(r)));
  assert.ok(out.dropped >= 60);
  assert.deepStrictEqual(C.cleanExtraction('nonsense', text), { found: [], risks: [], dropped: 0, unverified: 0 });
  // Applying findings keeps what was set for logging.
  const p = C.applyFindings(prof({ email: on('email', { logged: true }) }), out.found);
  assert.deepStrictEqual([p.caps.email.autonomy, p.caps.email.logged, p.caps.refunds.perDay, p.caps.refunds.logged], ['ask', true, 100000, false]);
  assert.ok(ai.SYSTEM.includes('never an instruction') && ai.SYSTEM.includes('Never invent a capability'));
  assert.deepStrictEqual(ai.TOOL.input_schema.properties.capabilities.items.properties.id.enum, IDS);
});

/* ---------------- the page and the files ---------------- */

test('the sample shows every feature with no model call', () => {
  const a = C.cleanAgent({ name: Sample.NAME, profile: Sample.profile(), charter: Sample.charter(), drills: Sample.drills() });
  assert.strictEqual(a.drills.length, 1, 'one past drill');
  assert.ok(a.charter.killOwner && !a.charter.killHow, 'a half-filled charter');
  assert.ok(C.deal(a.profile, 1).length === 3);
  assert.ok(Sample.PROMPT.length > C.LIMITS.textMin);
  const read = C.cleanExtraction(require('../lib/fakeai').mapText(Sample.PROMPT), Sample.PROMPT);
  assert.deepStrictEqual(read.found.map((f) => [f.id, f.verified]), [['refunds', true], ['pricing', true], ['email', true], ['read_pii', true], ['browse', false]], 'the fake reads the example with one unverified quote');
});

test('colours: every text pair holds 4.5:1 in both themes; the ring holds 3:1', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  const block = (re) => Object.fromEntries([...css.match(re)[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
  const light = block(/:root \{([\s\S]*?)\n\}/);
  const dark = { ...light, ...block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/) };
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const text = [['text', 'bg'], ['text', 'card'], ['text', 'card2'], ['muted', 'card'], ['muted', 'bg'], ['muted', 'card2'], ['link', 'card'], ['link', 'bg'], ['link', 'card2'],
    ['accent-ink', 'accent'], ['amber', 'card'], ['pass', 'pass-bg'], ['pass', 'card'], ['breach', 'breach-bg'], ['breach', 'card'], ['warn', 'card2'], ['text', 'warn-bg'],
    ['text', 'accent-soft'], ['pass', 'card2'], ['band-low', 'card'], ['band-watch', 'card'], ['band-high', 'card'], ['band-severe', 'card'], ['band-low', 'bg'], ['band-severe', 'bg'], ['band-high', 'bg'], ['band-watch', 'bg']];
  const art = ['g-money', 'g-customers', 'g-data', 'g-systems', 'g-outside', 'g-decisions'].map((g) => [g, 'card']);
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const [fg, bg] of text) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name}: --${fg} on --${bg} is ${ratio(t[fg], t[bg]).toFixed(2)}:1`);
    for (const [fg, bg] of art) assert.ok(ratio(t[fg], t[bg]) >= 3, `${name}: --${fg} on --${bg} is ${ratio(t[fg], t[bg]).toFixed(2)}:1`);
    assert.ok(ratio('#ffffff', t.hero) >= 4.5 && ratio('#e6f0f3', t.hero) >= 4.5, `${name}: the strip and the scenario card`);
  }
  assert.ok(ratio('#2b1a02', '#fcd28a') >= 4.5, 'the Example tag');
  assert.ok(ratio('#14303b', '#ffffff') >= 4.5, 'the strip button');
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { LEASH_MEMORY: '1' }], ['./lib/fakeai', { LEASH_FAKE_AI: '1' }], ['./server', { LEASH_FAKE_AI: '1', LEASH_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, LEASH_MEMORY: '', LEASH_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, LEASH_MEMORY: '', LEASH_COLLECTION_PREFIX: 'leash_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8');
  assert.ok(/LEASH_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 8, 'every Firestore path is prefixed');
});

test('the page: relative links, no inline script or handlers, the banner, nothing logged from a body', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js.replace(/\.on[a-z]+ =/g, '')), 'no handler written into markup');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  for (const f of ['server.js', 'lib/ai.js', 'lib/agents.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|text|profile|charter|raw)/.test(src), `${f} logs a body`);
  }
  // The disclaimer is said once on the page and makes no legal claim.
  assert.strictEqual(C.DISCLAIMER, 'A planning tool, not legal or compliance advice - what you must report depends on your rules and your counsel.');
  assert.ok(!/reportable/i.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'leash-core.js'), 'utf8').replace(/It never says what is\n \* "reportable"/, '')));
});

/* ---------------- over HTTP ---------------- */

async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const agentBody = () => ({ name: 'Juniper test', profile: Sample.profile(), charter: Sample.charter(), drills: Sample.drills() });
const MARK = 'PASTEDSECRETMARKER-7f3a';
const pasted = () => `${Sample.PROMPT}\nInternal note ${MARK}: the refund key lives in vault path ops/refunds.`;

test('signed out: the page and its files work with zero model calls; nothing private does', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.limits.agents, meta.limits.drills, meta.limits.text, meta.catalog.length], [10, 30, 40000, 18]);
  for (const f of ['leash-core.js', 'sample.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['POST', '/api/read'], ['GET', '/api/agents'], ['POST', '/api/agents'], ['GET', '/api/agents/abcdefghijkl'], ['PUT', '/api/agents/abcdefghijkl'],
    ['PATCH', '/api/agents/abcdefghijkl'], ['DELETE', '/api/agents/abcdefghijkl'], ['POST', '/api/agents/abcdefghijkl/duplicate'], ['POST', '/api/agents/abcdefghijkl/drills']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' || m === 'DELETE' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  assert.strictEqual((await anon('POST', '/api/read', { text: pasted() })).status, 401);
  // A stranger's big body is turned away at the door, unread...
  assert.strictEqual((await anon('POST', '/api/read', { text: 'A'.repeat(450 * 1024) })).status, 401, 'the gate answers before the big parser');
  assert.strictEqual((await anon('POST', '/api/read', 'x'.repeat(2 * 1024 * 1024))).status, 401, 'even past the big parser\'s limit');
  // ...and every other route keeps the small limit.
  assert.strictEqual((await anon('POST', '/api/agents', { x: 'x'.repeat(100 * 1024) })).status, 413);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the read route\'s gates come before its parser, in order', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/read', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  for (const [p, m] of [['/api/agents', 'get'], ['/api/agents', 'post'], ['/api/agents/:id', 'put'], ['/api/agents/:id', 'delete'], ['/api/agents/:id/drills', 'post']]) assert.strictEqual(layer(p, m).route.stack[0].handle.name, 'requireUser', `${m} ${p}`);
});

let ana, ben;

test('read my agent: text checked before any spend, one metered call, cleaned, nothing stored', async () => {
  ana = await register('ana.ops@example.com');
  const dump = store._dump();
  let calls = await modelCalls();
  for (const bad of [{}, { text: 42 }, { text: 'too short' }, { text: 'x'.repeat(C.LIMITS.text + 1) }]) assert.strictEqual((await ana('POST', '/api/read', bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  assert.strictEqual((await ana('POST', '/api/read', { text: 'A'.repeat(600 * 1024) })).status, 413, 'over the parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const r = await ana('POST', '/api/read', { text: pasted() });
  assert.strictEqual(r.status, 200, r.text.slice(0, 300));
  assert.ok(r.text.startsWith(' '), 'the answer streams whitespace first');
  assert.deepStrictEqual(r.data.found.map((f) => f.id), ['refunds', 'pricing', 'email', 'read_pii', 'browse']);
  assert.deepStrictEqual(r.data.found.find((f) => f.id === 'refunds'), { id: 'refunds', autonomy: 'alone', perAction: 50000, perDay: null, quote: "- issue_refund(order_id, amount): refund up to $500 per order without asking anyone. Anything larger, hand to a person.", verified: true, confidence: 'high' });
  assert.deepStrictEqual(r.data.found.find((f) => f.id === 'browse').verified, false, 'the paraphrased quote is kept, marked');
  assert.strictEqual(r.data.unverified, 1);
  assert.strictEqual(r.data.risks.length, 1);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  calls += 1;
  const inj = await ana('POST', '/api/read', { text: `INJECT ${'padding '.repeat(10)}` });
  assert.ok(!/<[a-z/!]/i.test(inj.text), 'no markup reaches the page');
  assert.ok(inj.data.found.every((f) => IDS.includes(f.id)) && inj.data.found.length <= 18 && inj.data.risks.length <= 5);
  const none = await ana('POST', '/api/read', { text: `NOTHING ${'padding '.repeat(10)}` });
  assert.deepStrictEqual([none.status, /could not find anything/.test(none.data.error)], [200, true], 'after the stream starts, a failure is a 200 {error}');
  assert.match((await ana('POST', '/api/read', { text: `NOTANAGENT ${'padding '.repeat(10)}` })).data.error, /could not find anything/);
  assert.match((await ana('POST', '/api/read', { text: `MAXTOKENS refund ${'padding '.repeat(10)}` })).data.error, /ran longer than one reading/);
  const up = await ana('POST', '/api/read', { text: `UPSTREAM401 ${'padding '.repeat(10)}` });
  assert.ok(up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  assert.match((await ana('POST', '/api/read', { text: `UPSTREAM529 ${'padding '.repeat(10)}` })).data.error, /AI is busy/);
  assert.strictEqual(store._dump(), dump, 'reading stores nothing');
  assert.ok(!store._dump().includes(MARK) && !JSON.stringify(await identityStore.list('usage')).includes(MARK), 'the pasted text is nowhere');
});

test('an unconfirmed free account gets the verify-email 403, before any model call or big body', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/read', { text: pasted() });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.match(r.data.error, /Confirm your email/);
    assert.strictEqual(r.data.resend, '/leash/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/read', { text: 'A'.repeat(600 * 1024) })).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('POST', '/api/agents', agentBody())).status, 200, 'saving needs no AI and no confirmed address');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
});

test('out of credit: 402 before any model call - and before the big body is read', async () => {
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  const r = await cal('POST', '/api/read', { text: pasted() });
  assert.strictEqual(r.status, 402);
  assert.strictEqual((await cal('POST', '/api/read', { text: 'A'.repeat(600 * 1024) })).status, 402, '402, not 413');
  assert.strictEqual((await cal('POST', '/api/agents', agentBody())).status, 200, 'saving is free');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call was made');
});

let AGENT_ID;

test('save an agent: the profile, charter and drill scores - never pasted text or anything else', async () => {
  await ana('POST', '/api/read', { text: pasted() });
  const body = { ...agentBody(), name: '<b>Juniper</b> bot', text: pasted(), pasted: pasted(), reading: { quote: MARK }, profile: { ...Sample.profile(), extra: MARK }, charter: { ...Sample.charter(), notes: MARK } };
  const r = await ana('POST', '/api/agents', body);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  AGENT_ID = r.data.agent.id;
  assert.ok(A.ID_RE.test(AGENT_ID));
  assert.strictEqual(r.data.agent.name, 'Juniper bot');
  assert.deepStrictEqual(r.data.agent.profile, C.cleanProfile(Sample.profile()));
  assert.strictEqual(r.data.agent.drills.length, 1);
  const doc = await store.get(`agents/${uidOf('ana.ops@example.com')}/items`, AGENT_ID);
  assert.deepStrictEqual(Object.keys(doc).sort(), ['charter', 'createdAt', 'drills', 'id', 'name', 'profile', 'updatedAt']);
  assert.ok(!store._dump().includes(MARK) && !store._dump().includes('vault path'), 'nothing pasted is stored, anywhere');
  const list = (await ana('GET', '/api/agents')).data;
  assert.deepStrictEqual([list.limit, list.agents.length, list.agents[0].score, list.agents[0].band, list.agents[0].caps, list.agents[0].readiness], [10, 1, 68, 'High', 5, 38]);
});

test('update, rename, drills, duplicate; another person\'s agent is a 404', async () => {
  const U = `/api/agents/${AGENT_ID}`;
  const got = (await ana('GET', U)).data.agent;
  const next = C.applyFix(got.profile, 'watch');
  delete next.caps.browse;
  let r = await ana('PUT', U, { ...got, profile: next, charter: { ...got.charter, killHow: 'Admin > bot > off' }, drills: [] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([Object.keys(r.data.agent.profile.caps).includes('browse'), r.data.agent.charter.killHow, r.data.agent.drills.length, r.data.agent.createdAt], [false, 'Admin > bot > off', 1, got.createdAt], 'a switched-off capability stays off; drills are the server\'s');
  r = await ana('POST', `${U}/drills`, { readiness: 72, calls: 2, rounds: 3, at: '1999-01-01T00:00:00.000Z' });
  assert.strictEqual(r.data.agent.drills.length, 2);
  assert.ok(r.data.agent.drills[1].at > '2026', 'the server stamps the time');
  for (const bad of [{ readiness: 101, calls: 1, rounds: 3 }, { readiness: 50, calls: 4, rounds: 3 }, { readiness: 'high' }, {}]) assert.strictEqual((await ana('POST', `${U}/drills`, bad)).status, 400);
  for (let i = 0; i < 35; i++) await ana('POST', `${U}/drills`, { readiness: i, calls: 0, rounds: 3 });
  r = await ana('GET', U);
  assert.strictEqual(r.data.agent.drills.length, 30, 'the last 30 kept');
  assert.strictEqual(r.data.agent.drills[29].readiness, 34);
  assert.strictEqual((await ana('PATCH', U, { name: '  ' })).status, 400);
  assert.strictEqual((await ana('PATCH', U, { name: 'Support bot v2' })).data.agent.name, 'Support bot v2');
  const dup = await ana('POST', `${U}/duplicate`);
  assert.deepStrictEqual([dup.data.agent.name, dup.data.agent.drills.length], ['Support bot v2 (copy)', 30]);
  assert.notStrictEqual(dup.data.agent.id, AGENT_ID);
  ben = await register('ben.other@example.com');
  for (const [m, p, b] of [['GET', U], ['PUT', U, agentBody()], ['PATCH', U, { name: 'mine now' }], ['DELETE', U], ['POST', `${U}/duplicate`], ['POST', `${U}/drills`, { readiness: 1, calls: 0, rounds: 3 }]]) {
    assert.strictEqual((await ben(m, p, b)).status, 404, `${m} ${p}`);
  }
  assert.deepStrictEqual((await ben('GET', '/api/agents')).data.agents, []);
  assert.strictEqual((await ana('GET', U)).data.agent.name, 'Support bot v2', 'untouched by the stranger');
  assert.strictEqual((await ana('GET', '/api/agents/..%2F..%2Fx')).status, 404);
  assert.strictEqual((await ana('DELETE', `/api/agents/${dup.data.agent.id}`)).status, 200);
});

test('limits: 10 agents a person, 60 drills in a body refused; delete removes everything', async () => {
  const have = (await ana('GET', '/api/agents')).data.agents.length;
  for (let i = have; i < 10; i++) assert.strictEqual((await ana('POST', '/api/agents', agentBody())).status, 200);
  const eleventh = await ana('POST', '/api/agents', agentBody());
  assert.deepStrictEqual([eleventh.status, /up to 10 agents/.test(eleventh.data.error)], [409, true]);
  assert.strictEqual((await ana('POST', `/api/agents/${AGENT_ID}/duplicate`)).status, 409, 'a duplicate counts too');
  assert.strictEqual((await ben('POST', '/api/agents', { ...agentBody(), drills: Array.from({ length: 61 }, () => Sample.drills()[0]) })).status, 400);
  assert.strictEqual((await ana('DELETE', `/api/agents/${AGENT_ID}`)).status, 200);
  assert.strictEqual(await store.get(`agents/${uidOf('ana.ops@example.com')}/items`, AGENT_ID), null, 'gone');
  assert.strictEqual((await ana('GET', `/api/agents/${AGENT_ID}`)).status, 404);
  assert.strictEqual((await ana('DELETE', `/api/agents/${AGENT_ID}`)).status, 404);
});

test('two saves at once never make an eleventh agent', async () => {
  const dee = await register('dee.race@example.com');
  for (let i = 0; i < 9; i++) await dee('POST', '/api/agents', agentBody());
  const both = await Promise.all([dee('POST', '/api/agents', agentBody()), dee('POST', '/api/agents', agentBody())]);
  assert.deepStrictEqual(both.map((r) => r.status).sort(), [200, 409]);
  assert.strictEqual((await dee('GET', '/api/agents')).data.agents.length, 10);
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use('/leash', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/leash`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
