// Pure rules first, then end to end against the memory store and the fake
// model:
//   RECEIPT_MEMORY=1 RECEIPT_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /receipt, the way
// the lab mounts it, so the auth cookie, the budget gate, per-person scoping,
// the room's voter cookie and the share link are exercised as deployed. Model
// calls are counted from the identity's usage rows - the same rows that bill
// a real account.

// The fixtures are dated 2026-09-25 (x-local-date, T0), and the server only
// believes a browser's date within a day of its own clock - so from the 27th
// the suite failed on the calendar, not on the code (found 2026-09-27). The
// clock is pinned to the fixture day, running forward from there, before
// anything reads it.
{
  const RealDate = Date;
  const offset = RealDate.parse('2026-09-25T15:00:00Z') - RealDate.now();
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  };
}

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.RECEIPT_MEMORY !== '1' || process.env.RECEIPT_FAKE_AI !== '1') {
  console.error('run with RECEIPT_MEMORY=1 RECEIPT_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const R = require('../public/rules');
const Q = require('../public/qr');
const M = require('../lib/meetings');
const ai = require('../lib/ai');
const audio = require('../lib/audio');
const gemini = require('../lib/gemini');
const { demo, build, SETUP, END_MS, AUDIT, recapAnswer, sharpenAnswer } = require('../lib/demo');

const MIN = R.MIN;
const HOUR = R.HOUR;
let base;
function client() {
  let cookies = {};
  return async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-local-date': '2026-09-25', ...(cookie ? { Cookie: cookie } : {}), ...headers },
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
    return { status: res.status, data, headers: res.headers };
  };
}

const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15)); // the meter writes usage rows fire-and-forget

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]).toString('base64');
const withText = (s) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(s), Buffer.alloc(500, 3)]).toString('base64');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const T0 = Date.parse('2026-09-25T14:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const room = (o) => ({ title: 'Sync', mode: 'bands', people: [{ band: 'exec', rate: 200, count: 1 }, { band: 'manager', rate: 110, count: 2 }, { band: 'ic', rate: 85, count: 4 }], bookedMinutes: 45, agenda: [], ...o });

/* ---------------- pure: formatting and the room ---------------- */

test('formatting: money, clocks, durations, and time given back never rounded up', () => {
  assert.deepStrictEqual([R.money(486), R.money(486.004, true), R.money(38400), R.money(1234567.891, true), R.money(-12)], ['$486', '$486.00', '$38,400', '$1,234,567.89', '-$12']);
  assert.deepStrictEqual([R.clockText(0), R.clockText(38 * MIN + 22 * 1000), R.clockText(HOUR + 2 * MIN + 5000)], ['0:00', '38:22', '1:02:05']);
  assert.deepStrictEqual([R.durText(45 * MIN), R.durText(8.5 * MIN), R.durText(45000), R.durText(65 * MIN)], ['45m', '8m 30s', '45s', '1h 5m']);
  assert.strictEqual(R.minText(6.99 * MIN), '6 min');
});

test('setup: bands or a blended rate, headcount, the loaded multiplier, and no salaries by name', () => {
  const ok = R.validateSetup({ title: ' <b>Weekly</b> sync ', people: [{ band: 'exec', count: 1 }, { band: 'manager', count: '2' }, { band: 'ic', rate: '$85', count: 4 }], bookedMinutes: 45, labels: 'Maya, Jordan, maya, <i>Sam</i>' });
  assert.ok(ok.setup, JSON.stringify(ok));
  assert.strictEqual(ok.setup.title, 'Weekly sync', 'markup stripped');
  assert.deepStrictEqual(ok.setup.people.map((p) => [p.band, p.rate, p.count]), [['exec', 200, 1], ['manager', 110, 2], ['ic', 85, 4]], 'default rates per band');
  assert.deepStrictEqual(ok.setup.labels, ['Maya', 'Jordan', 'Sam'], 'labels deduped, markup gone');
  assert.strictEqual(R.hourly(ok.setup), 760);
  assert.strictEqual(R.hourly({ ...ok.setup, loaded: true }), 760 * 1.3, 'the loaded multiplier is opt-in');
  assert.strictEqual(R.headcount(ok.setup), 7);
  const blend = R.validateSetup({ title: 'All hands', mode: 'blended', people: [{ band: 'blended', rate: 95, count: 30 }] }).setup;
  assert.deepStrictEqual([blend.people.length, R.hourly(blend), R.headcount(blend), blend.bookedMinutes], [1, 2850, 30, 30]);
  const err = (raw) => R.validateSetup({ title: 'Sync', people: [{ band: 'ic', count: 3 }], ...raw }).field;
  assert.strictEqual(R.validateSetup({ title: 'x', people: [{ band: 'ic', count: 1 }] }).field, 'title');
  assert.strictEqual(err({ people: [] }), 'people', 'somebody has to be in the room');
  assert.strictEqual(err({ people: [{ band: 'ic', count: 2.5 }] }), 'people');
  assert.strictEqual(err({ people: [{ band: 'ic', count: 1, rate: 5000 }] }), 'people');
  assert.strictEqual(err({ people: [{ band: 'ic', count: 301 }] }), 'people');
  assert.strictEqual(err({ bookedMinutes: 2 }), 'bookedMinutes');
  assert.strictEqual(err({ bookedMinutes: 30, agenda: [{ title: 'A', minutes: 20 }, { title: 'B', minutes: 15 }] }), 'agenda', 'the timebox has to fit the booking');
  assert.strictEqual(err({ agenda: [{ title: 'A', minutes: 0 }] }), 'agenda');
  const a = R.validateSetup({ title: 'Sync', people: [{ band: 'ic', count: 2 }], agenda: [{ title: '<script>x</script>Review', minutes: 10, owner: 'Dana' }, { title: '', minutes: 5 }] }).setup;
  assert.deepStrictEqual([a.agenda.length, a.agenda[0].title, a.bookedMinutes], [1, 'Review', 10], 'empty items dropped; booked defaults to the agenda');
  const edit = R.validateSetup({ title: 'Renamed' }, ok.setup).setup;
  assert.deepStrictEqual([edit.title, R.hourly(edit), edit.labels.length], ['Renamed', 760, 3], 'fields not sent keep their values');
});

test('text: clean() and cleanText() are linear - a run of "<" cannot hold the process', () => {
  // Same answers as before for ordinary input.
  assert.strictEqual(R.clean(' a <b>bold</b>  <script>x</script>c '), 'a bold c');
  assert.strictEqual(R.clean('x <y z'), 'x y z', 'a stray bracket is dropped');
  assert.strictEqual(R.cleanText('# Head\n**b** <i>i</i>\n\n\n\nend', 100), 'Head\nb i\n\nend');
  const t0 = Date.now();
  R.clean('<'.repeat(6 * 1024 * 1024), 200);
  R.cleanText('<'.repeat(6 * 1024 * 1024), R.LIMITS.notes);
  // The tag pattern itself is linear too, with no cut to hide behind.
  assert.strictEqual(R.cleanText('<'.repeat(2e6) + 'ok', 1e6), 'ok');
  R.clean('<a'.repeat(1e6), 1e6);
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `took ${ms} ms`);
  assert.strictEqual(R.clean('word '.repeat(10000), 20).length, 20, 'still bounded');
});

/* ---------------- pure: the meter ---------------- */

test('the meter: elapsed from timestamps, minus every pause, the same after a reload', () => {
  const m = room({ startedAt: iso(T0), pauses: [{ at: iso(T0 + 10 * MIN), until: iso(T0 + 13 * MIN) }, { at: iso(T0 + 20 * MIN), until: null }] });
  assert.strictEqual(R.status(m), 'paused');
  assert.strictEqual(R.elapsed(m, T0 + 25 * MIN), 17 * MIN, 'an open pause holds the clock');
  assert.strictEqual(R.elapsed(JSON.parse(JSON.stringify(m)), T0 + 25 * MIN), 17 * MIN, 'nothing but stored strings');
  const ended = { ...m, pauses: [m.pauses[0]], endedAt: iso(T0 + 30 * MIN) };
  assert.deepStrictEqual([R.status(ended), R.elapsed(ended, T0 + 90 * MIN)], ['ended', 27 * MIN], 'the end freezes it');
  assert.strictEqual(R.elapsed(room({}), T0), 0, 'not started');
  // wallAt is elapsed() backwards, stepping over the pauses.
  const p = room({ startedAt: iso(T0), pauses: [{ at: iso(T0 + 10 * MIN), until: iso(T0 + 20 * MIN) }] });
  assert.deepStrictEqual([R.wallAt(p, 5 * MIN), R.wallAt(p, 10 * MIN), R.wallAt(p, 30 * MIN)], [T0 + 5 * MIN, T0 + 10 * MIN, T0 + 40 * MIN]);
  for (const x of [0, 7 * MIN, 10 * MIN, 33 * MIN]) assert.strictEqual(R.elapsed({ ...p, endedAt: iso(R.wallAt(p, x)) }, T0 + 99 * HOUR), x, `round trip ${x}`);
  assert.strictEqual(R.wallAt(room({ startedAt: iso(T0), pauses: [{ at: iso(T0 + 10 * MIN), until: null }] }), 25 * MIN), T0 + 10 * MIN, 'paused for good: it never ran longer');
  const L = R.live(room({ startedAt: iso(T0) }), T0 + 30 * MIN);
  assert.deepStrictEqual([L.costUsd, L.personHours, L.perMinute.toFixed(4), L.leftMs], [380, 3.5, (760 / 60).toFixed(4), 15 * MIN]);
  assert.strictEqual(L.compare.text, '1 iPad', '$380 is past an iPad');
});

test('the agenda: planned vs actual, the ring, the overrun in dollars, skipped items', () => {
  const m = room({ startedAt: iso(T0), agenda: [{ title: 'Wins', minutes: 5 }, { title: 'Campaign', minutes: 15 }, { title: 'Budget', minutes: 10 }], marks: [4 * MIN] });
  const a = R.agenda(m, T0 + 22 * MIN);
  assert.deepStrictEqual(a.items.map((i) => i.state), ['done', 'current', 'upcoming']);
  assert.deepStrictEqual([a.items[0].actualMs, a.items[0].underMs, a.items[0].overUsd], [4 * MIN, MIN, 0]);
  assert.strictEqual(a.current.title, 'Campaign');
  assert.strictEqual(a.current.overMs, 3 * MIN);
  assert.strictEqual(Math.round(a.current.overUsd * 100) / 100, 38, 'three minutes over at $760/h is $38');
  assert.strictEqual(a.current.leftMs, -3 * MIN);
  assert.strictEqual(a.current.pct, 1);
  const half = R.agenda(m, T0 + 11.5 * MIN).current;
  assert.strictEqual(half.pct, 0.5);
  const done = R.agenda({ ...m, marks: [4 * MIN, 20 * MIN], endedAt: iso(T0 + 26 * MIN) }, T0 + 99 * MIN);
  assert.deepStrictEqual(done.items.map((i) => i.state), ['done', 'done', 'skipped'], 'items never reached are skipped');
  const after = R.agenda({ ...m, marks: [5 * MIN, 20 * MIN, 30 * MIN], endedAt: iso(T0 + 34 * MIN) }, T0 + 99 * MIN);
  assert.strictEqual(after.afterMs, 4 * MIN, 'time after the last item is its own line');
});

test('comparisons and milestone pings', () => {
  assert.strictEqual(R.compare(3), null);
  assert.strictEqual(R.compare(36).text, '1.2 months of SaaS seats');
  assert.strictEqual(R.compare(24).text, '2 burritos');
  assert.strictEqual(R.compare(3490).text, '1.3 weeks at the beach');
  assert.deepStrictEqual(R.crossed(340, 360).map((m) => m.ping), ['the price of an iPad']);
  assert.deepStrictEqual(R.crossed(0, 40).map((m) => m.usd), [5, 12, 30]);
  assert.deepStrictEqual(R.crossed(360, 370), []);
});

/* ---------------- pure: the log and the heat clock ---------------- */

test('the log: a kind, some words, an owner from the typed labels, a real due date', () => {
  const labels = ['Maya', 'Jordan'];
  const ok = R.validateLog({ kind: 'action', text: ' Send the <b>brief</b> ', owner: 'jordan', due: '2026-09-27' }, labels);
  assert.deepStrictEqual(ok.item, { kind: 'action', text: 'Send the brief', owner: 'Jordan', due: '2026-09-27' }, 'the label in its own spelling');
  assert.strictEqual(R.validateLog({ kind: 'action', text: 'Do it', owner: 'Mallory' }, labels).field, 'owner', 'owners are attendees, not anyone');
  assert.strictEqual(R.validateLog({ kind: 'action', text: 'Do it', due: '2026-02-30' }, labels).field, 'due');
  assert.strictEqual(R.validateLog({ kind: 'gossip', text: 'x y' }, labels).field, 'kind');
  assert.strictEqual(R.validateLog({ kind: 'decision', text: ' ' }, labels).field, 'text');
  assert.deepStrictEqual(R.validateLog({ kind: 'decision', text: 'Ship it', owner: 'Maya', due: '2026-10-01' }, labels).item, { kind: 'decision', text: 'Ship it', owner: '', due: null }, 'only actions carry an owner and a date');
});

test('heat: warm, hot, scorching, dropped - from the age against the due date - and done', () => {
  const a = { createdAt: iso(T0), due: '2026-09-29' }; // due end of the 29th: ~4.4 days
  assert.strictEqual(R.heat(a, T0 + HOUR).state, 'warm');
  assert.strictEqual(R.heat(a, T0 + 3 * R.DAY).state, 'hot');
  assert.strictEqual(R.heat(a, Date.parse('2026-09-30T10:00:00Z')).state, 'scorching');
  assert.strictEqual(R.heat(a, Date.parse('2026-10-08T10:00:00Z')).state, 'dropped', 'a week past due');
  const noDue = { createdAt: iso(T0) };
  assert.strictEqual(R.heat(noDue, T0 + 4 * R.DAY).state, 'hot', 'no date means a week');
  assert.strictEqual(R.heat(noDue, T0 + 8 * R.DAY).state, 'scorching');
  assert.strictEqual(R.heat({ ...a, doneAt: iso(T0) }, T0 + 99 * R.DAY).state, 'done');
  // Past due by the person's own calendar, not 23:59 UTC.
  const fri = { createdAt: iso(T0 - 2 * R.DAY), due: '2026-09-25' };
  const la5pm = Date.parse('2026-09-26T00:30:00Z'); // 5:30pm on the 25th in California
  assert.strictEqual(R.heat(fri, la5pm, '2026-09-25').state, 'hot', 'still the due day where they are');
  const tokyo8am = Date.parse('2026-09-25T23:00:00Z'); // 8am on the 26th in Tokyo
  assert.strictEqual(R.heat(fri, tokyo8am, '2026-09-26').state, 'scorching', 'the due day is over where they are');
  assert.strictEqual(R.heat(fri, Date.parse('2026-10-03T12:00:00Z'), '2026-10-02').state, 'scorching', 'a week past due by their calendar');
  assert.strictEqual(R.heat(fri, Date.parse('2026-10-03T12:00:00Z'), '2026-10-03').state, 'dropped');
  const order = R.byHeat([
    { id: 'warm', createdAt: iso(T0), due: '2026-10-20' },
    { id: 'dropped', createdAt: iso(T0 - 30 * R.DAY) },
    { id: 'done', createdAt: iso(T0), doneAt: iso(T0) },
    { id: 'scorching', createdAt: iso(T0 - 9 * R.DAY) },
    { id: 'hot', createdAt: iso(T0 - 5 * R.DAY) },
  ], T0).map((r) => r.action.id);
  assert.deepStrictEqual(order, ['scorching', 'hot', 'warm', 'dropped'], 'the one to chase first; dropped last; done gone');
});

/* ---------------- pure: the room ---------------- */

test('ROTI, and bingo: a card dealt from a seed, and a line checked the same way everywhere', () => {
  assert.deepStrictEqual(R.rotiSummary([{ roti: 4 }, { roti: 3 }, { roti: 3 }, { roti: 2 }, { roti: 1 }, { roti: null }, { email: true }]), { n: 5, avg: 2.6, dist: [0, 1, 1, 2, 1] });
  assert.strictEqual(R.rotiSummary([]).avg, null);
  assert.strictEqual(R.validRoti(5), null);
  assert.strictEqual(R.validRoti('3'), 3);
  const card = R.deal('m1:alice');
  assert.strictEqual(card.length, 25);
  assert.strictEqual(card[R.FREE], 'FREE');
  assert.strictEqual(new Set(card).size, 25, 'no square twice');
  assert.ok(card.every((c) => c === 'FREE' || R.PHRASES.includes(c)));
  assert.deepStrictEqual(R.deal('m1:alice'), card, 'the same seed deals the same card');
  assert.notDeepStrictEqual(R.deal('m1:bob'), card, 'another browser gets another card');
  assert.ok(R.PHRASES.length >= 40 && new Set(R.PHRASES).size === R.PHRASES.length);
  assert.deepStrictEqual(R.bingoLine([10, 11, 13, 14]), [10, 11, 12, 13, 14], 'the free middle counts');
  assert.deepStrictEqual(R.bingoLine([4, 8, 16, 20]), [4, 8, 12, 16, 20], 'diagonals count');
  assert.deepStrictEqual(R.bingoLine(['0', 5, 10, 15, 20, 20]), [0, 5, 10, 15, 20]);
  assert.strictEqual(R.bingoLine([0, 1, 2, 3]), null);
  assert.strictEqual(R.bingoLine([0, 1, 2, 3, 99, -1, 'x']), null, 'junk marks are ignored');
  assert.strictEqual(R.LINES.length, 12);
});

/* ---------------- pure: the receipt ---------------- */

test('the receipt: cost by band, per item, per decision, the room, TIME GIVEN BACK - and verdicts', () => {
  const m = room({ startedAt: iso(T0), endedAt: iso(T0 + 30 * MIN), agenda: [{ title: 'A', minutes: 20 }, { title: 'B', minutes: 20 }], marks: [25 * MIN, 30 * MIN] });
  const log = [
    { kind: 'decision', text: 'Ship it', at: 5 * MIN }, { kind: 'decision', text: 'Hire', at: 6 * MIN },
    { kind: 'action', text: 'Send notes', owner: 'Maya', due: '2026-09-26', at: 7 * MIN }, { kind: 'parking', text: 'Later', at: 8 * MIN },
  ];
  const r = R.receipt(m, log, [{ roti: 3 }, { roti: 4, handle: '🦊', bingoAt: iso(T0 + 9 * MIN) }, { email: true, roti: 2 }], T0 + 99 * MIN);
  assert.deepStrictEqual([r.costUsd, r.headcount, r.durationMs, r.counts.decision, r.costPerDecision], [380, 7, 30 * MIN, 2, 190]);
  assert.deepStrictEqual(r.people.map((p) => [p.label, p.count, Math.round(p.costUsd)]), [['Exec', 1, 100], ['Manager', 2, 110], ['IC', 4, 170]]);
  assert.deepStrictEqual(r.items.map((i) => [i.actualMs / MIN, Math.round(i.overUsd * 100) / 100]), [[25, 63.33], [5, 0]]);
  assert.deepStrictEqual([r.givenBackMs, r.personMinutesGivenBack, r.onTime, r.early], [15 * MIN, 105, true, true]);
  assert.deepStrictEqual([r.roti.avg, r.emailVotes, r.voters, r.bingo.handle], [3, 1, 3, '🦊']);
  assert.strictEqual(r.verdict.key, 'worth');
  const text = R.receiptText(r);
  assert.match(text, /TIME GIVEN BACK +15 MIN/);
  assert.match(text, /COST PER DECISION +\$190/);
  assert.match(text, /Ship it/);
  const pub = R.receiptText(r, { numbersOnly: true });
  assert.ok(!pub.includes('Ship it') && !pub.includes('Sync') && !pub.includes('Maya') && pub.includes('Item 1'), 'numbers only');
  const none = R.receipt(m, [], [], T0 + 99 * MIN);
  assert.deepStrictEqual([none.costPerDecision, none.verdict.key], [null, 'nodecision'], 'zero decisions says so');
  assert.match(R.receiptText(none), /NO DECISIONS/);
  assert.strictEqual(R.receipt(m, log, [{ email: true }, { email: true, roti: 3 }, { roti: 4 }], T0).verdict.key, 'email', 'a majority for email wins');
  assert.strictEqual(R.receipt(m, log, [{ roti: 1 }, { roti: 1 }], T0).verdict.key, 'costly');
  const over = R.receipt({ ...m, endedAt: iso(T0 + 50 * MIN) }, log, [], T0 + 99 * MIN);
  assert.deepStrictEqual([over.givenBackMs, over.overrunMs, over.onTime], [0, 5 * MIN, false]);
  assert.match(R.receiptText(over), /OVER TIME +5M/);
});

test('recaps by hand: the free template is the log and nothing more; mailto has no recipient', () => {
  const t = R.recapTemplate({ title: 'Sync', day: '2026-09-25' }, [
    { kind: 'action', text: 'Send notes', owner: 'Maya', due: '2026-09-26', at: 2 }, { kind: 'decision', text: 'Ship it', at: 1 }, { kind: 'action', text: 'Book room', at: 3 },
  ]);
  assert.strictEqual(t.subject, 'Recap: Sync');
  assert.match(t.body, /Decisions\n- Ship it/);
  assert.match(t.body, /- Send notes - Maya, due Sat, Sep 26/);
  assert.match(t.body, /- Book room - \[owner\?\]/, 'an unowned action says so');
  assert.match(t.body, /Next meeting: \[add: when\]/);
  assert.ok(R.mailto('Hi', 'Body & more').startsWith('mailto:?subject=Hi&body=Body%20%26%20more'));
});

/* ---------------- pure: the audit and the scoreboard ---------------- */

test('the audit: annual cost, Shrink’s offer (50 → 25, weekly → every 2 weeks), savings, and somebody stays', () => {
  const allHands = R.validateRecurring({ title: 'Weekly all-hands', minutes: 30, cadence: 'weekly', people: [{ band: 'exec', count: 1 }, { band: 'manager', count: 5 }, { band: 'ic', count: 10 }] }).recurring;
  assert.strictEqual(R.annualCost(allHands), 38400);
  const sync = R.validateRecurring({ title: 'Sync', minutes: 50, cadence: 'weekly', people: [{ band: 'manager', count: 2 }, { band: 'ic', count: 4 }] }).recurring;
  assert.deepStrictEqual(R.shrinkSuggestion(sync), { minutes: 25, cadence: 'fortnightly', drop: [] });
  assert.strictEqual(R.savings({ ...sync, decision: 'kill' }), R.annualCost(sync));
  const shrunk = R.validateRecurring({ decision: 'shrink' }, sync).recurring;
  assert.deepStrictEqual(shrunk.shrink, { minutes: 25, cadence: 'fortnightly', drop: [] }, 'shrink without details takes the offer');
  assert.strictEqual(R.savings(shrunk), R.annualCost(sync) * 0.75, 'half the length, half as often');
  const dropAll = R.validateRecurring({ decision: 'shrink', shrink: { minutes: 50, cadence: 'weekly', drop: ['manager', 'ic', 'exec', 'ic'] } }, sync).recurring;
  assert.deepStrictEqual(dropAll.shrink.drop, ['manager'], 'at least one band stays; bands not in the room are ignored');
  assert.strictEqual(R.validateRecurring({ decision: 'shrink', shrink: { minutes: 90, cadence: 'daily' } }, sync).recurring.shrink.minutes, 50, 'a shrink never grows it');
  assert.strictEqual(R.validateRecurring({ decision: 'shrink', shrink: { minutes: 20, cadence: 'daily' } }, sync).recurring.shrink.cadence, 'weekly', 'nor makes it more often');
  assert.strictEqual(R.savings({ ...sync, decision: 'keep' }), 0);
  assert.strictEqual(R.validateRecurring({ title: 'X', minutes: 30 }).field, 'title');
  assert.strictEqual(R.validateRecurring({ title: 'Sync', minutes: 30, cadence: 'hourly', people: [{ band: 'ic', count: 1 }] }).field, 'cadence');
  const a = R.audit([{ ...sync, decision: 'kill' }, allHands]);
  assert.deepStrictEqual([a.rows[0].r.title, a.killed, a.undecided, a.savedPerYear], ['Weekly all-hands', 1, 1, R.annualCost(sync)], 'ranked by annual cost');
});

test('the scoreboard: weeks, the on-time streak, time given back, the ROTI trend, badges', () => {
  const row = (id, day, booked, actual, n, decisions, roti) => ({
    id, title: id, day, endedAt: `${day}T15:00:00Z`, bookedMs: booked * MIN, durationMs: actual * MIN, headcount: n,
    costUsd: 100 * n * actual / 60, personHours: n * actual / 60, decisions, rotiN: roti == null ? 0 : 3, rotiAvg: roti,
  });
  const rows = [
    row('mon', '2026-09-21', 30, 25, 4, 1, 3.3), row('tue', '2026-09-22', 30, 30.5, 4, 5, null), row('wed', '2026-09-24', 60, 40, 6, 0, 2.1),
    row('lastweek', '2026-09-16', 30, 45, 5, 1, 1.5), row('old', '2026-09-02', 60, 50, 10, 2, 2.8),
  ];
  const s = R.scoreboard(rows, [{ title: 'x', minutes: 30, cadence: 'weekly', people: [{ band: 'ic', rate: 85, count: 3 }], decision: 'kill' }], '2026-09-25');
  assert.strictEqual(s.weeks.length, 8);
  assert.deepStrictEqual([s.thisWeek.week, s.thisWeek.meetings], ['2026-09-21', 3]);
  assert.deepStrictEqual([s.streak, s.bestStreak], [3, 3], 'three on-time finishes since the overrun (30.5 of 30 is within the minute)');
  assert.strictEqual(s.givenBackMs, (5 + 20 + 10) * MIN);
  assert.strictEqual(Math.round(s.givenBackPersonHours * 100) / 100, Math.round(((5 * 4 + 20 * 6 + 10 * 10) / 60) * 100) / 100);
  assert.deepStrictEqual(s.rotiTrend.map((t) => t.avg), [2.8, 1.5, 3.3, 2.1], 'oldest first, meetings with votes only');
  assert.strictEqual(s.priciest.title, 'old');
  assert.deepStrictEqual(s.badges, ['first', 'zerooverrun', 'killed', 'cheapdecision']);
  assert.ok(s.savedPerYear > 0);
  const empty = R.scoreboard([], [], '2026-09-25');
  assert.deepStrictEqual([empty.meetings, empty.streak, empty.badges, empty.priciest], [0, 0, [], null]);
});

test('room codes and the QR code', () => {
  for (let i = 0; i < 50; i++) {
    const c = M.newCode();
    assert.ok(R.isCode(c), c);
  }
  assert.strictEqual(R.formatCode('abcd-2345'), 'ABCD-2345');
  assert.strictEqual(R.normalizeCode(' ab cd 23 45 '), 'ABCD2345');
  assert.ok(!R.isCode('ABCD0O11'), 'no 0, O, 1 or I');
  const m = Q.matrix('https://challenge.strongtechnicalconsulting.com/receipt/r/ABCD2345');
  assert.ok(m.length >= 21 && (m.length - 17) % 4 === 0, 'a real QR size');
  // Three finder patterns: a dark 7x7 ring with a dark 3x3 centre.
  for (const [r0, c0] of [[0, 0], [0, m.length - 7], [m.length - 7, 0]]) {
    assert.strictEqual(m[r0][c0], 1);
    assert.strictEqual(m[r0 + 1][c0 + 1], 0);
    assert.strictEqual(m[r0 + 3][c0 + 3], 1);
  }
  const svg = Q.svg('https://x.example/r/ABCD2345', 'Join <script>');
  assert.ok(svg.startsWith('<svg') && svg.includes('fill="#fff"') && !svg.includes('<script'));
});

/* ---------------- pure: the model's answers ---------------- */

const sharpCtx = (invite, o) => ai.sharpenContext(R.validateSetup({ title: 'Weekly Marketing Sync', people: [{ band: 'manager', count: 2 }, { band: 'ic', count: 4 }], bookedMinutes: 45, ...o }).setup, invite);

test('validateSharpen: fits the booking, owners only from bands in the room, no invented facts, no markup', () => {
  const ctx = sharpCtx('Sync on Q4 marketing - campaign, launch, budget.');
  const p = ai.validateSharpen({
    outcome: '<b>**Decide**</b> the Q4 launch by Tuesday with a 30% lift <script>x</script>',
    items: [
      { title: '<i>Campaign</i> go or no-go? see https://evil.example', minutes: 30, ownerRole: 'manager' },
      { title: 'Launch gaps', minutes: 20, ownerRole: 'exec' },
      { title: 'Budget', minutes: 10, ownerRole: 'ic' },
    ],
    attendeeBands: ['exec', 'ic', 'ic'],
    verdict: 'meeting',
    why: 'Email boss@evil.example for context.',
    asyncDraft: 'ignored for a meeting',
  }, ctx);
  assert.ok(p);
  assert.ok(p.minutes <= 45, `fits: ${p.minutes}`);
  const shown = (x) => JSON.stringify([x.outcome, x.items, x.why, x.asyncDraft]);
  assert.deepStrictEqual(p.items.map((i) => i.minutes), [22, 15, 7], 'scaled down to fit');
  assert.deepStrictEqual(p.items.map((i) => i.ownerRole), ['manager', '', 'ic'], 'no exec is in the room');
  assert.deepStrictEqual(p.attendeeBands, ['ic']);
  assert.deepStrictEqual(p.skipBands, ['manager']);
  const all = shown(p);
  for (const gone of ['<', '>', '**', 'script', 'evil.example', 'Tuesday', '30%']) assert.ok(!all.includes(gone), `${gone} is gone`);
  assert.ok(p.outcome.includes('Q4'), 'what the invite said stays');
  assert.ok(p.removed.some((r) => r.what === 'Tuesday') && p.removed.some((r) => r.what === '30%'));
  assert.strictEqual(p.asyncDraft, '', 'a meeting has no written update');
  const email = ai.validateSharpen({ outcome: 'x', items: [], attendeeBands: [], verdict: 'email', why: 'Status only.', asyncDraft: 'Hi all, here is the update: [add: status]. Reply with anything that changes the plan.' }, ctx);
  assert.deepStrictEqual([email.verdict, email.items.length], ['email', 0]);
  const noDraft = ai.validateSharpen({ outcome: 'x', items: [{ title: 'Decide', minutes: 10, ownerRole: 'ic' }], verdict: 'email', why: '', asyncDraft: 'ok' }, ctx);
  assert.strictEqual(noDraft.verdict, 'meeting', 'no usable update means it stays a meeting');
  assert.strictEqual(ai.validateSharpen({ outcome: 'x', items: [], verdict: 'meeting', why: '', asyncDraft: '' }, ctx), null);
});

test('validateSharpen: what it proposes is exactly what Apply (the edit route) accepts', () => {
  // A 480-minute workshop: an item over 240 minutes used to pass here and 400 on Apply.
  const ctx = sharpCtx('Full-day planning workshop', { bookedMinutes: 480 });
  const long = 'Decide the plan for the region with 12 stores and 40 staff over the next quarter, and who owns it';
  const p = ai.validateSharpen({
    outcome: `${'Leave with a plan that every region signs off on and '.repeat(3)}a 25% margin by Friday`,
    items: [{ title: long, minutes: 300, ownerRole: 'manager' }, { title: 'Owners', minutes: 60, ownerRole: 'ic' }],
    attendeeBands: ['manager'], verdict: 'meeting', why: 'Decisions.', asyncDraft: '',
  }, ctx);
  assert.deepStrictEqual(p.items.map((i) => i.minutes), [240, 60], 'capped at the 240 an item may have');
  for (const it of p.items) assert.ok(it.title.length <= R.LIMITS.itemTitle, it.title);
  assert.ok(p.outcome.length <= R.LIMITS.outcome, p.outcome);
  assert.ok(!/\[add:[^\]]*$/.test(p.items[0].title) && !/\[add:[^\]]*$/.test(p.outcome), 'no gap cut in half');
  // Straight into the edit route's own validator: no error, nothing trimmed.
  const applied = R.validateSetup({ agenda: p.items.map((it) => ({ title: it.title, minutes: it.minutes, owner: it.owner })), outcome: p.outcome }, { title: 'Workshop', people: ctx.people, bookedMinutes: 480 });
  assert.ok(applied.setup, JSON.stringify(applied));
  assert.deepStrictEqual(applied.setup.agenda.map((a) => a.title), p.items.map((i) => i.title));
  assert.strictEqual(applied.setup.outcome, p.outcome);
});

test('guardFacts: whole tokens only - "decide" is not Dec, "month" is not Mon, 25% is not 5%, $1,500 is not $150', () => {
  const sf = ai.sourceOf(['Decide how to spend the money this month on marketing. Satisfaction grew 25%, and the budget is $1,500.']);
  const found = [];
  const out = ai.guardFacts('Launch in Mar, final call in Dec, ship by Mon; lift of 5% on $150, then 25% on $1,500. Done by friday.', sf, found);
  assert.deepStrictEqual(found.slice().sort(), ['$150', '5%', 'Dec', 'Mar', 'Mon', 'friday']);
  assert.ok(out.includes('25%') && out.includes('$1,500'), 'what was given stays');
  assert.ok(!/\bMar\b|\bDec\b|\bMon\b|friday|\b5%|\$150\b/.test(out), out);
  assert.ok(out.endsWith('Done by [add: day].'), 'the sentence keeps its full stop');
  // Given as a day, used as a day - in any form.
  const given = ai.sourceOf(['Launch review on Friday, Sept 12 at 3 p.m.']);
  const f2 = [];
  assert.strictEqual(ai.guardFacts('Ship Fri, Sep 12 at 3pm', given, f2), 'Ship Fri, Sep 12 at 3pm');
  assert.deepStrictEqual(f2, []);
  // Ordinary words that happen to be short day or month names are left alone.
  assert.strictEqual(ai.guardFacts('we sat down to march on and mar nothing', ai.sourceOf(['x']), []), 'we sat down to march on and mar nothing');
});

const recapCtx = (notes, logs = [], o = {}) => ai.recapContext({ title: 'Sync', day: '2026-09-25', labels: ['Maya', 'Jordan', 'Sam'], ...o }, logs, notes, Boolean(o.photo));

test('validateRecap: every item cites its source; quotes must be in the notes; owners and dates must be earned', () => {
  const notes = 'Jordan: I’ll send the revised brief by Friday.\nMaya: can someone check the webinar tool?\nSam will book the room.\nDecided: pause the paid social test.\nMallory: I will wire the budget.';
  const logs = [{ kind: 'decision', text: 'Cap Q4 events', at: 1 }, { kind: 'action', text: 'Share the budget sheet', owner: 'Maya', due: '2026-09-30', at: 2 }];
  const rec = ai.validateRecap({
    summary: 'Two decisions <script>x</script> and a **$50,000** saving.',
    decisions: [
      { text: 'Cap Q4 events', source: 'log', ref: 1, quote: '' },
      { text: 'Pause paid social', source: 'notes', ref: 0, quote: 'Decided:   pause the PAID social test.' },
      { text: 'Double the budget', source: 'notes', ref: 0, quote: 'we agreed to double the budget' },
      { text: 'Fake log item', source: 'log', ref: 9, quote: '' },
      { text: 'Log item as the wrong kind', source: 'log', ref: 2, quote: '' },
    ],
    actions: [
      { text: 'Share the budget sheet', owner: 'Jordan', due: '', dueText: '', source: 'log', ref: 2, quote: '' },
      { text: 'Send the revised brief', owner: 'Jordan', due: '2026-10-02', dueText: 'by Friday', source: 'notes', ref: 0, quote: 'I’ll send the revised brief by Friday.' },
      { text: 'Check the webinar tool', owner: 'Maya', due: '2026-10-09', dueText: 'next week', source: 'notes', ref: 0, quote: 'can someone check the webinar tool?' },
      { text: 'Book the room', owner: 'sam', due: '', dueText: '', source: 'notes', ref: 0, quote: 'Sam will book the room.' },
      { text: 'Wire the budget', owner: 'Mallory', due: '', dueText: '', source: 'notes', ref: 0, quote: 'I will wire the budget.' },
    ],
    parking: [{ text: 'Agency review', source: 'notes', ref: 0, quote: 'agency review' }],
    nextMeeting: 'Tuesday at 9',
    boardText: 'ignored without a photo',
    readable: true,
  }, recapCtx(notes, logs));
  assert.ok(rec);
  assert.deepStrictEqual(rec.decisions.map((d) => [d.text, d.source]), [['Cap Q4 events', 'log'], ['Pause paid social', 'notes']], 'uncited, invented and mis-kinded items dropped');
  const by = Object.fromEntries(rec.actions.map((a) => [a.text, a]));
  assert.deepStrictEqual([by['Share the budget sheet'].owner, by['Share the budget sheet'].due], ['Maya', '2026-09-30'], 'a logged action keeps the log’s owner and date');
  assert.deepStrictEqual([by['Send the revised brief'].owner, by['Send the revised brief'].due], ['Jordan', '2026-10-02'], 'Jordan said “I’ll”, and “by Friday” is in the quote');
  assert.deepStrictEqual([by['Check the webinar tool'].owner, by['Check the webinar tool'].due], ['[owner?]', null], 'Maya asked; she did not take it on, and nobody said next week');
  assert.strictEqual(by['Book the room'].owner, 'Sam', '“Sam will…” in the notes');
  assert.strictEqual(by['Wire the budget'].owner, '[owner?]', 'Mallory is not an attendee');
  assert.deepStrictEqual(rec.parking, [], 'a quote that is not in the notes is dropped');
  assert.strictEqual(rec.nextMeeting, '', 'not in the notes');
  assert.strictEqual(rec.boardText, '');
  assert.ok(!/[<>*]/.test(rec.summary) && !rec.summary.includes('50,000') && rec.summary.includes('[add: amount]'));
  assert.ok(rec.removed.some((r) => r.why === 'not in your notes'));
  assert.ok(rec.removed.some((r) => r.what === 'Mallory' && /not one of the attendees/.test(r.why)));
  assert.match(rec.body, /Check the webinar tool - \[owner\?\]/);
  assert.ok(rec.mailto.startsWith('mailto:?subject=Recap%3A%20Sync'));
  // A valid citation does not license new words: a logged item prints as logged.
  const flip = ai.validateRecap({
    summary: '', decisions: [{ text: 'Keep the paid social test running and scale it up', source: 'log', ref: 1, quote: '' }],
    actions: [{ text: 'Cancel the budget sheet', owner: 'Jordan', due: '2026-12-01', dueText: '', source: 'log', ref: 2, quote: '' }], parking: [],
  }, recapCtx('', [{ kind: 'decision', text: 'Pause the paid social test', at: 1 }, { kind: 'action', text: 'Share the budget sheet', owner: 'Maya', due: '2026-09-30', at: 2 }]));
  assert.deepStrictEqual(flip.decisions.map((d) => [d.text, d.source]), [['Pause the paid social test', 'log']]);
  assert.deepStrictEqual(flip.actions.map((a) => [a.text, a.owner, a.due]), [['Share the budget sheet', 'Maya', '2026-09-30']]);
  assert.ok(!flip.body.includes('scale it up') && !flip.body.includes('Cancel'));
  assert.strictEqual(ai.validateRecap({ summary: 'ok', decisions: [], actions: [], parking: [] }, recapCtx('x')), null, 'nothing to recap');
  assert.strictEqual(ai.validateRecap({ readable: false, summary: '', decisions: [], actions: [], parking: [] }, recapCtx('', [], { photo: true })), null, 'an unreadable whiteboard alone');
});

test('who took it on: the speaker in their own words, or an assignment in the notes', () => {
  const paste = 'Jordan Lee: I’ll draft it.\n[10:02] Sam: happy to help\nPriya: Maya will review it.';
  assert.strictEqual(ai.tookItOn('Jordan', 'I’ll draft it.', paste), true, 'first name matches the speaker; curly quotes folded');
  assert.strictEqual(ai.tookItOn('Sam', 'happy to help', paste), false, 'no commitment in the words');
  assert.strictEqual(ai.tookItOn('Priya', 'Maya will review it.', paste), false, 'Priya said it about Maya');
  assert.strictEqual(ai.tookItOn('Maya', 'Maya will review it.', paste), true);
  assert.strictEqual(ai.speakerOf('happy to help', paste), 'sam', 'a timestamp before the speaker is fine');
  // Asking, declining and saying no are not taking it on.
  const more = 'Dana: let me know when the deck is ready\nSam will not be able to send the pricing page\nPriya: I will not own the webinar\nLee: I can’t do Friday\nKim: let me draft it\nAvi: I’ll never get to that, but I can send the notes';
  assert.strictEqual(ai.tookItOn('Dana', 'let me know when the deck is ready', more), false, '“let me know” hands it to someone else');
  assert.strictEqual(ai.tookItOn('Sam', 'Sam will not be able to send the pricing page', more), false);
  assert.strictEqual(ai.tookItOn('Priya', 'I will not own the webinar', more), false);
  assert.strictEqual(ai.tookItOn('Lee', 'I can’t do Friday', more), false);
  assert.strictEqual(ai.tookItOn('Kim', 'let me draft it', more), true, '“let me” with a verb of doing');
  assert.strictEqual(ai.tookItOn('Avi', 'I’ll never get to that, but I can send the notes', more), true, 'a later commitment in the same words still counts');
});

test('recap owners and dates from the notes: "Name: I\'ll ... by Friday", "Sam will ...", and nobody (stand-in answers)', () => {
  // 2026-11-23 is a Monday; the model's own date is left out on purpose -
  // a missing one used to drop "by Friday" entirely.
  const notes = '- Jordan: I\'ll send the deck by Friday\n2. Priya: sure, I can draft the FAQ by end of week\nSam will chase legal next Tuesday\nwe should look at pricing\nDana: I\'ll look into it, and Lee should book the room';
  const raw = {
    summary: '', decisions: [], parking: [],
    actions: [
      { text: 'Send the deck', owner: 'Jordan', due: '', dueText: 'by Friday', source: 'notes', ref: 0, quote: 'send the deck by Friday' },
      { text: 'Draft the FAQ', owner: 'Priya', due: '2026-12-25', dueText: 'by end of week', source: 'notes', ref: 0, quote: 'I can draft the FAQ by end of week' },
      { text: 'Chase legal', owner: 'Sam', due: '', dueText: 'next Tuesday', source: 'notes', ref: 0, quote: 'Sam will chase legal next Tuesday' },
      { text: 'Look at pricing', owner: 'Jordan', due: '2026-12-01', dueText: '', source: 'notes', ref: 0, quote: 'we should look at pricing' },
      { text: 'Book the room', owner: 'Dana', due: '', dueText: '', source: 'notes', ref: 0, quote: 'Lee should book the room' },
    ],
  };
  const expect = [
    ['Send the deck', 'Jordan', '2026-11-27'],   // a bulleted speaker; "I'll" just before the quote
    ['Draft the FAQ', 'Priya', '2026-11-27'],    // end of week is Friday: ours, not the model's Christmas
    ['Chase legal', 'Sam', '2026-12-01'],        // "Sam will", the following week's Tuesday
    ['Look at pricing', '[owner?]', null],       // nobody took it on, nobody said when
    ['Book the room', '[owner?]', null],         // Dana's "I'll" is another clause
  ];
  for (const labels of [[], ['Jordan', 'Priya', 'Sam', 'Dana']]) {
    const rec = ai.validateRecap(JSON.parse(JSON.stringify(raw)), ai.recapContext({ title: 'Sync', labels }, [], notes, false, '2026-11-23'));
    assert.deepStrictEqual(rec.actions.map((a) => [a.text, a.owner, a.due]), expect, labels.length ? 'typed labels' : 'no labels typed: the name as written');
    assert.ok(rec.removed.some((r) => r.what === '2026-12-01' && r.where === 'due date'), 'a date with no words for it');
    assert.match(rec.body, /Send the deck - Jordan, due/);
  }
  // Typed labels still bound it; with none, a voice or a pronoun is nobody.
  const pat = ai.validateRecap({ summary: '', decisions: [], parking: [], actions: [{ text: 'Send the deck', owner: 'Pat', due: '', dueText: '', source: 'notes', ref: 0, quote: 'Pat: I\'ll send the deck' }] },
    ai.recapContext({ title: 'Sync', labels: ['Jordan'] }, [], 'Pat: I\'ll send the deck', false, '2026-11-23'));
  assert.strictEqual(pat.actions[0].owner, '[owner?]', 'not one of the typed attendees');
  const voice = ai.validateRecap({ summary: '', decisions: [], parking: [], actions: [{ text: 'Send the deck', owner: 'Speaker 2', due: '', dueText: '', source: 'notes', ref: 0, quote: 'I\'ll send the deck' }] },
    ai.recapContext({ title: 'Sync', labels: [] }, [], 'Speaker 2: I\'ll send the deck', false, '2026-11-23'));
  assert.strictEqual(voice.actions[0].owner, '[owner?]', 'a voice is not a name');
  // A recap before Start has no meeting day: today's stands in, so the prompt has a date.
  assert.match(ai.recapPrompt(ai.recapContext({ title: 'Sync', labels: [] }, [], notes, false, '2026-11-23')), /MEETING DATE: 2026-11-23/);
  assert.match(ai.recapPrompt(ai.recapContext({ title: 'Sync', labels: [] }, [], notes, false)), /none typed - an owner is the name exactly as the notes write it/);
});

/* ---------------- pure: the sample ---------------- */

test('the sample: $486, 3 decisions at $162, ROTI 2.6, $38 over on the campaign review, TIME GIVEN BACK - all from the rules', () => {
  const d = build(Date.parse('2026-09-25T16:00:00Z'), '2026-09-25');
  const r = d.receipt;
  assert.strictEqual(R.money(r.costUsd, true), '$486.00');
  assert.deepStrictEqual([r.counts.decision, R.money(r.costPerDecision), r.roti.avg, r.roti.n, r.emailVotes, r.headcount], [3, '$162', 2.6, 5, 2, 7]);
  assert.strictEqual(r.people.length, 3, 'seven people across three bands');
  assert.strictEqual(r.items.length, 5);
  assert.strictEqual(R.agendaMinutes(SETUP.agenda), 45);
  const campaign = r.items.find((i) => i.title === 'Campaign review');
  assert.strictEqual(R.money(campaign.overUsd), '$38');
  assert.strictEqual(R.minText(r.givenBackMs), '6 min');
  assert.strictEqual(r.bingo.handle, '🦊');
  assert.strictEqual(r.verdict.key, 'fair');
  assert.match(d.receiptText, /TIME GIVEN BACK +6 MIN/);
  assert.strictEqual(d.script.speed, 60);
  assert.strictEqual(d.script.endMs, END_MS);
  const bingo = d.script.bingo;
  assert.deepStrictEqual(R.bingoLine(bingo.marks.map((x) => x.cell)), bingo.line, 'the scripted bingo is a real line on the dealt card');
  assert.ok(bingo.marks.every((x) => bingo.card[x.cell] === x.phrase));
  // The examples pass the real validators untouched.
  assert.deepStrictEqual(d.sharpen.proposal.removed, []);
  assert.deepStrictEqual(d.sharpen.proposal.notes, []);
  assert.deepStrictEqual(d.sharpen.proposal.items.map((i) => i.title), sharpenAnswer().items.map((i) => i.title));
  assert.strictEqual(d.sharpen.proposal.verdict, 'split');
  assert.ok(d.sharpen.proposal.asyncDraft.length > 100);
  assert.deepStrictEqual(d.recap.recap.removed, []);
  assert.strictEqual(d.recap.recap.actions.length, recapAnswer().actions.length);
  assert.strictEqual(d.recap.recap.actions.find((a) => a.source === 'notes').owner, 'Chris');
  // The audit: all-hands is $38,400 a year, and it is the most expensive.
  const a = R.audit(d.audit);
  assert.deepStrictEqual([a.rows[0].r.title, a.rows[0].annual], ['Weekly all-hands', 38400]);
  assert.strictEqual(d.audit.length, AUDIT.length);
  assert.ok(d.audit.every((x) => x.decision === null), 'undecided, for the visitor to swipe');
  assert.deepStrictEqual(d.scoreboard.badges, ['first', 'zerooverrun', 'killed', 'cheapdecision']);
  // Fictional: no real address anywhere.
  assert.ok(!/@(?!example)\w/.test(JSON.stringify(d)));
});

test('the public receipt: numbers only - no title, no item names, no decisions, no labels', () => {
  const d = build(Date.parse('2026-09-25T16:00:00Z'), '2026-09-25');
  const card = M.shareCard(d.receipt, 'now');
  const text = JSON.stringify(card);
  for (const s of [SETUP.title, ...SETUP.agenda.map((a) => a.title), ...SETUP.labels, ...d.log.map((l) => l.text), SETUP.invite]) assert.ok(!text.includes(s), `leaked: ${s}`);
  assert.deepStrictEqual([card.costUsd, card.counts.decision, card.roti.avg, card.bingo.handle, card.items.length], [486, 3, 2.6, '🦊', 5]);
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { RECEIPT_MEMORY: '1' }], ['./lib/fakeai', { RECEIPT_FAKE_AI: '1' }], ['./server', { RECEIPT_FAKE_AI: '1', RECEIPT_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, RECEIPT_MEMORY: '', RECEIPT_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

/* ---------------- over HTTP ---------------- */

test('signed out: health, meta, the sample and the rules work with zero model calls; nothing private does', async () => {
  const anon = client();
  const before = await modelCalls();
  const dump = store._dump();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = await anon('GET', '/api/meta');
  assert.deepStrictEqual(meta.data.bands.map((b) => [b.key, b.rate]), [['exec', 200], ['manager', 110], ['ic', 85]]);
  const d = await anon('GET', '/api/demo');
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.data.demo, true);
  assert.strictEqual(R.money(d.data.receipt.costUsd, true), '$486.00');
  assert.ok(d.data.sharpen.proposal && d.data.recap.recap && d.data.audit.length === 6);
  for (const f of ['rules.js', 'qr.js']) {
    const js = await fetch(`${base}/${f}`);
    assert.strictEqual(js.status, 200);
  }
  assert.ok((await (await fetch(`${base}/rules.js`)).text()).includes('ReceiptRules'), 'the page runs the same rules the server does');
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('src="app.js"') && html.includes('href="app.css"') && html.includes('src="rules.js"'), 'relative asset links');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/meetings'], ['POST', '/api/meetings'], ['GET', '/api/meetings/abcdef'], ['PUT', '/api/meetings/abcdef'], ['DELETE', '/api/meetings/abcdef'],
    ['POST', '/api/meetings/abcdef/start'], ['POST', '/api/meetings/abcdef/next'], ['POST', '/api/meetings/abcdef/end'], ['POST', '/api/meetings/abcdef/log'],
    ['PUT', '/api/meetings/abcdef/log/lid001'], ['DELETE', '/api/meetings/abcdef/log/lid001'], ['GET', '/api/meetings/abcdef/pulse'], ['GET', '/api/meetings/abcdef/receipt'],
    ['POST', '/api/meetings/abcdef/share'], ['POST', '/api/meetings/abcdef/code'], ['POST', '/api/meetings/abcdef/sharpen'], ['POST', '/api/meetings/abcdef/recap'],
    ['GET', '/api/recurring'], ['POST', '/api/recurring'], ['PUT', '/api/recurring/abcdef'], ['GET', '/api/scoreboard']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' || m === 'DELETE' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  // A stranger's 5 MB photo is turned away at the door, unread.
  const big = await anon('POST', '/api/meetings/abcdef/recap', { image: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } });
  assert.strictEqual(big.status, 401);
  // ...and every other route keeps the small limit.
  const fat = await anon('POST', '/api/meetings', { title: 'x'.repeat(200 * 1024) });
  assert.strictEqual(fat.status, 413);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
  assert.strictEqual(store._dump(), dump, 'the sample writes nothing');
});

let maya, eve;
const MT = {};

async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
/** Wind a meeting's clock back, as if it had started `min` minutes ago. */
async function ago(uid, mid, patch) { await store.merge(`meetings/${uid}/items`, mid, patch); }

test('a new meeting: validated, a room code, and the next occurrence of one in the same series', async () => {
  maya = await register('maya@example.com');
  assert.strictEqual((await maya('POST', '/api/meetings', { title: 'x', people: [{ band: 'ic', count: 1 }] })).status, 400);
  // 120 KB of '<' in every text field (under the 128 KB parser): answered at once.
  const t0 = Date.now();
  const lt = '<'.repeat(120 * 1024);
  assert.strictEqual((await maya('POST', '/api/meetings', { title: lt, people: [{ band: 'ic', count: 1 }] })).status, 400);
  assert.strictEqual((await maya('POST', '/api/meetings', { title: 'Brackets', invite: lt.slice(0, 60 * 1024), labels: lt.slice(0, 60 * 1024), people: [{ band: 'ic', count: 1 }] })).status, 200);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  const junk = (await maya('GET', '/api/meetings')).data.meetings.find((m) => m.title === 'Brackets');
  await maya('DELETE', `/api/meetings/${junk.id}`);
  const bad = await maya('POST', '/api/meetings', { title: 'Sync', people: [{ band: 'ic', count: 1 }], bookedMinutes: 30, agenda: [{ title: 'A', minutes: 40 }] });
  assert.deepStrictEqual([bad.status, bad.data.field], [400, 'agenda']);
  const r = await maya('POST', '/api/meetings', {
    title: '<b>Weekly Marketing Sync</b>', mode: 'bands', people: SETUP.people, bookedMinutes: 45, agenda: SETUP.agenda, labels: SETUP.labels, invite: SETUP.invite,
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  Object.assign(MT, { id: r.data.meeting.id, code: r.data.meeting.code });
  assert.strictEqual(r.data.meeting.title, 'Weekly Marketing Sync');
  assert.match(r.data.meeting.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.deepStrictEqual([r.data.meeting.status, r.data.meeting.bingo, r.data.meeting.agenda.length], ['waiting', false, 5], 'bingo is off unless the facilitator turns it on');
  const list = await maya('GET', '/api/meetings');
  assert.deepStrictEqual(list.data.meetings.map((m) => m.title), ['Weekly Marketing Sync']);
  const me = await maya('GET', '/api/me');
  assert.deepStrictEqual([me.data.meetings, me.data.lastSetup.people[2].count, me.data.lastSetup.labels.length], [1, 4, 7], 'the next form starts from the last room');
  const edit = await maya('PUT', `/api/meetings/${MT.id}`, { bingo: true, outcome: 'Leave with owners', labels: [...SETUP.labels] });
  assert.deepStrictEqual([edit.status, edit.data.meeting.bingo, edit.data.meeting.outcome], [200, true, 'Leave with owners']);
});

test('the clock: start, pause, resume, next, end - timestamps only, and the room is locked once it runs', async () => {
  const uid = uidOf('maya@example.com');
  assert.strictEqual((await maya('POST', `/api/meetings/${MT.id}/next`)).status, 409, 'start first');
  const s = await maya('POST', `/api/meetings/${MT.id}/start`);
  assert.deepStrictEqual([s.status, s.data.meeting.status, s.data.meeting.day], [200, 'live', '2026-09-25'], 'the day is the browser’s');
  assert.strictEqual((await maya('POST', `/api/meetings/${MT.id}/start`)).status, 409);
  const locked = await maya('PUT', `/api/meetings/${MT.id}`, { people: [{ band: 'ic', count: 1 }] });
  assert.strictEqual(locked.status, 409, 'the receipt stays honest');
  assert.strictEqual((await maya('PUT', `/api/meetings/${MT.id}`, { agenda: [] })).status, 409);
  assert.strictEqual((await maya('PUT', `/api/meetings/${MT.id}`, { title: 'Weekly Marketing Sync' })).status, 200, 'the title can still change');
  // Wind the clock back four minutes, then close the first item.
  const t = Date.now();
  await ago(uid, MT.id, { startedAt: iso(t - 4 * MIN) });
  const n = await maya('POST', `/api/meetings/${MT.id}/next`);
  assert.ok(Math.abs(n.data.meeting.marks[0] - 4 * MIN) < 5000, `first item took four minutes: ${n.data.meeting.marks[0]}`);
  assert.strictEqual((await maya('POST', `/api/meetings/${MT.id}/resume`)).status, 409, 'not paused');
  assert.strictEqual((await maya('POST', `/api/meetings/${MT.id}/pause`)).data.meeting.status, 'paused');
  assert.strictEqual((await maya('POST', `/api/meetings/${MT.id}/pause`)).status, 409);
  const back = await maya('POST', `/api/meetings/${MT.id}/resume`);
  assert.strictEqual(back.data.meeting.status, 'live');
  assert.strictEqual(back.data.meeting.pauses.length, 1);
  // The campaign review runs 18 minutes on a 15-minute box.
  const m0 = await store.get(`meetings/${uid}/items`, MT.id);
  await ago(uid, MT.id, { startedAt: iso(Date.parse(m0.startedAt) - 18 * MIN) });
  const got = await maya('GET', `/api/meetings/${MT.id}`);
  const cur = R.agenda(got.data.meeting, Date.parse(got.data.now)).current;
  assert.strictEqual(cur.title, 'Campaign review');
  assert.ok(cur.overMs > 2.9 * MIN && cur.overUsd > 36 && cur.overUsd < 40, `about $38 over: ${cur.overUsd}`);
});

test('the log: one tap each, owners from the labels, counters on the meeting, edit and tick done', async () => {
  const uid = uidOf('maya@example.com');
  const add = (b) => maya('POST', `/api/meetings/${MT.id}/log`, b);
  assert.strictEqual((await add({ kind: 'action', text: 'Wire it', owner: 'Mallory' })).data.field, 'owner');
  assert.strictEqual((await add({ kind: 'nope', text: 'x y' })).status, 400);
  const d1 = await add({ kind: 'decision', text: '<b>Pause</b> the paid social test' });
  assert.deepStrictEqual([d1.status, d1.data.item.text], [200, 'Pause the paid social test']);
  assert.ok(d1.data.item.at > 20 * MIN, 'stamped with the meeting time it was logged at');
  const a1 = await add({ kind: 'action', text: 'Send the revised brief', owner: 'jordan', due: '2026-09-27' });
  assert.deepStrictEqual([a1.data.item.owner, a1.data.item.due], ['Jordan', '2026-09-27']);
  await add({ kind: 'action', text: 'Book the webinar', owner: 'Sam' });
  await add({ kind: 'parking', text: 'Rebrand the newsletter?' });
  await add({ kind: 'decision', text: 'Cap Q4 events' });
  const junk = await add({ kind: 'decision', text: 'Oops' });
  assert.strictEqual((await maya('DELETE', `/api/meetings/${MT.id}/log/${junk.data.item.id}`)).status, 200);
  const doc = await store.get(`meetings/${uid}/items`, MT.id);
  assert.deepStrictEqual([doc.nDecision, doc.nAction, doc.nParking], [2, 2, 1], 'counters follow adds and deletes');
  const ed = await maya('PUT', `/api/meetings/${MT.id}/log/${a1.data.item.id}`, { text: 'Send the brief', due: '' });
  assert.deepStrictEqual([ed.data.item.text, ed.data.item.due, ed.data.item.owner], ['Send the brief', null, 'Jordan'], 'fields not sent are kept');
  const done = await maya('PUT', `/api/meetings/${MT.id}/log/${a1.data.item.id}`, { done: true });
  assert.ok(done.data.item.doneAt);
  MT.brief = a1.data.item.id;
  assert.strictEqual((await maya('PUT', `/api/meetings/${MT.id}/log/nope-nope`, { text: 'x y' })).status, 404);
});

test('a double-tapped delete removes one item and moves its counter once', async () => {
  const uid = uidOf('maya@example.com');
  const d = await maya('POST', `/api/meetings/${MT.id}/log`, { kind: 'decision', text: 'Tapped twice' });
  const before = (await store.get(`meetings/${uid}/items`, MT.id)).nDecision;
  // Firestore-like latency on every read, so the two requests really overlap.
  const get = store.get;
  store.get = async (...a) => { await new Promise((r) => setTimeout(r, 25)); return get.apply(store, a); };
  let both;
  try {
    both = await Promise.all([1, 2].map(() => maya('DELETE', `/api/meetings/${MT.id}/log/${d.data.item.id}`)));
  } finally { store.get = get; }
  assert.deepStrictEqual(both.map((r) => r.status).sort(), [200, 404]);
  assert.strictEqual((await store.get(`meetings/${uid}/items`, MT.id)).nDecision, before - 1, 'the counter agrees with the documents');
});

const voters = [];
test('the room: no account, one voice per browser, email taps, ROTI, and nothing private in view', async () => {
  const code = MT.code;
  const a = client();
  const g = await a('GET', `/api/room/${code.toLowerCase().replace('-', ' ')}`);
  assert.strictEqual(g.status, 200, JSON.stringify(g.data));
  assert.strictEqual(g.data.status, 'live');
  assert.ok(g.headers.get('set-cookie').includes('receipt_vid='), 'an opaque browser id');
  assert.match(g.headers.get('set-cookie'), /HttpOnly/);
  assert.strictEqual(g.headers.get('referrer-policy'), 'no-referrer');
  assert.match(g.headers.get('x-robots-tag'), /noindex/);
  const seen = JSON.stringify(g.data);
  for (const s of ['Jordan', 'Priya', 'Maya', 'Pause the paid social', 'Send the brief', SETUP.invite, 'Leave with owners']) assert.ok(!seen.includes(s), `the room sees no ${s}`);
  assert.strictEqual(g.data.meeting.agenda[1].title, 'Campaign review');
  assert.strictEqual(g.data.bingo.card.length, 25, 'bingo was turned on');
  assert.strictEqual((await a('POST', `/api/room/${code}/vote`, { roti: 9 })).status, 400);
  const v = await a('POST', `/api/room/${code}/vote`, { roti: 3 });
  assert.deepStrictEqual([v.status, v.data.me.roti, v.data.room.voters, v.data.room.rotiN], [200, 3, 1, 1]);
  await a('POST', `/api/room/${code}/vote`, { roti: 4 });
  const e = await a('POST', `/api/room/${code}/email`, { on: true });
  assert.deepStrictEqual([e.data.me.email, e.data.me.roti, e.data.room.voters, e.data.room.emailVotes], [true, 4, 1, 1], 'a changed vote is still one voice');
  voters.push(a);
  // A dozen phones at once: every vote is its own document, and all of them stick.
  const phones = Array.from({ length: 12 }, () => client());
  for (const p of phones) await p('GET', `/api/room/${code}`);
  await Promise.all(phones.map((p, i) => p('POST', `/api/room/${code}/vote`, { roti: i % 5 })));
  voters.push(...phones);
  const uid = uidOf('maya@example.com');
  const votes = await store.list(`meetings/${uid}/items/${MT.id}/votes`);
  assert.strictEqual(votes.length, 13);
  const doc = await store.get(`meetings/${uid}/items`, MT.id);
  assert.deepStrictEqual([doc.voterN, doc.rotiN, doc.rotiSum, doc.emailN], [13, 13, 4 + [0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1].reduce((s, x) => s + x, 0), 1], 'counters match the documents');
  const w = await a('POST', `/api/room/${code}/vote`, { roti: null });
  assert.deepStrictEqual([w.data.me.roti, w.data.room.rotiN, w.data.room.voters], [null, 12, 13], 'withdrawn, not double-counted');
  await a('POST', `/api/room/${code}/vote`, { roti: 4 });
  const pulse = await maya('GET', `/api/meetings/${MT.id}/pulse`);
  assert.deepStrictEqual([pulse.data.voters, pulse.data.emailVotes, pulse.data.roti.n], [13, 1, 13]);
  assert.ok(!JSON.stringify(pulse.data).includes(votes[0].id), 'no browser id leaves the server');
});

test('bingo: the card dealt again on the server; a claim must be a real line; the first one is credited', async () => {
  const code = MT.code;
  const a = voters[0];
  assert.strictEqual((await a('POST', `/api/room/${code}/bingo`, { handle: '🦊', marks: [0, 1, 2] })).status, 400, 'not a line');
  assert.strictEqual((await a('POST', `/api/room/${code}/bingo`, { handle: 'Mallory', marks: [10, 11, 13, 14] })).status, 400, 'handles come from the list');
  const win = await a('POST', `/api/room/${code}/bingo`, { handle: '🦊', marks: [10, 11, 13, 14] });
  assert.deepStrictEqual([win.status, win.data.line, win.data.me.handle, win.data.bingo.winner], [200, [10, 11, 12, 13, 14], '🦊', '🦊']);
  const b = voters[1];
  const late = await b('POST', `/api/room/${code}/bingo`, { handle: '🐙', marks: [2, 7, 17, 22] });
  assert.deepStrictEqual([late.status, late.data.bingo.winner], [200, '🦊'], 'the first bingo keeps the credit');
  const off = await maya('POST', '/api/meetings', { title: 'No games', people: [{ band: 'ic', count: 2 }] });
  await maya('POST', `/api/meetings/${off.data.meeting.id}/start`);
  const c = client();
  assert.strictEqual((await c('GET', `/api/room/${off.data.meeting.code}`)).data.bingo, null, 'off by default');
  assert.strictEqual((await c('POST', `/api/room/${off.data.meeting.code}/bingo`, { handle: '🦊', marks: [10, 11, 13, 14] })).status, 409);
  const waiting = await maya('POST', '/api/meetings', { title: 'Later', people: [{ band: 'ic', count: 2 }] });
  assert.strictEqual((await c('POST', `/api/room/${waiting.data.meeting.code}/vote`, { roti: 3 })).status, 409, 'voting opens at the start');
  await maya('DELETE', `/api/meetings/${off.data.meeting.id}`);
  await maya('DELETE', `/api/meetings/${waiting.data.meeting.id}`);
});

test('one address cannot fill a room: new voters per address are capped well under a room', async () => {
  assert.ok(M.LIMITS.newVotersPerIp < M.LIMITS.voters, 'the per-address cap binds before the room is full');
  const m = await maya('POST', '/api/meetings', { title: 'Stuffed', people: [{ band: 'ic', count: 3 }] });
  await maya('POST', `/api/meetings/${m.data.meeting.id}/start`);
  const code = m.data.meeting.code;
  const from = { 'X-Forwarded-For': '203.0.113.20' };
  let last;
  // A script with a made-up browser id per request, all from one address.
  for (let i = 0; i <= M.LIMITS.newVotersPerIp; i++) {
    last = await client()('POST', `/api/room/${code}/email`, { on: true }, { ...from, Cookie: `receipt_vid=${M.newToken()}` });
    if (i < M.LIMITS.newVotersPerIp) assert.strictEqual(last.status, 200, `voter ${i}: ${JSON.stringify(last.data)}`);
  }
  assert.deepStrictEqual([last.status, /new voters/.test(last.data.error)], [429, true]);
  const doc = await store.get(`meetings/${uidOf('maya@example.com')}/items`, m.data.meeting.id);
  assert.strictEqual(doc.voterN, M.LIMITS.newVotersPerIp, 'the room is nowhere near full');
  // Someone on another address still gets in.
  assert.strictEqual((await client()('POST', `/api/room/${code}/vote`, { roti: 3 }, { 'X-Forwarded-For': '203.0.113.21' })).status, 200);
  await maya('DELETE', `/api/meetings/${m.data.meeting.id}`);
});

test('end: the current item closes, the receipt prints, and voting stays open for a day', async () => {
  const uid = uidOf('maya@example.com');
  const e = await maya('POST', `/api/meetings/${MT.id}/end`);
  assert.deepStrictEqual([e.status, e.data.meeting.status, e.data.meeting.marks.length], [200, 'ended', 2], 'the campaign review closed at the end');
  assert.strictEqual((await maya('POST', `/api/meetings/${MT.id}/end`)).status, 409);
  const late = await voters[2]('POST', `/api/room/${MT.code}/vote`, { roti: 2 });
  assert.strictEqual(late.status, 200, 'a vote after the end still counts');
  const r = await maya('GET', `/api/meetings/${MT.id}/receipt`);
  assert.strictEqual(r.status, 200);
  const rc = r.data.receipt;
  assert.deepStrictEqual([rc.counts.decision, rc.counts.action, rc.counts.parking, rc.headcount, rc.ended, rc.bingo.handle], [2, 2, 1, 7, true, '🦊']);
  assert.deepStrictEqual(rc.items.map((i) => i.state), ['done', 'done', 'skipped', 'skipped', 'skipped']);
  assert.ok(rc.costUsd > 270 && rc.costUsd < 290, `about 22 minutes at $760/h: ${rc.costUsd}`);
  assert.strictEqual(R.minText(rc.givenBackMs), '22 min');
  assert.match(r.data.text, /TIME GIVEN BACK +22 MIN/);
  // A day later, the room has closed.
  await ago(uid, MT.id, { endedAt: iso(Date.now() - 25 * HOUR) });
  assert.strictEqual((await voters[3]('POST', `/api/room/${MT.code}/vote`, { roti: 1 })).status, 409);
  await ago(uid, MT.id, { endedAt: e.data.meeting.endedAt });
});

test('a meeting nobody ended: End at the booked time prints 45 minutes, not 16 hours - clamped to what happened', async () => {
  const uid = uidOf('maya@example.com');
  const mk = async (title) => {
    const r = await maya('POST', '/api/meetings', { title, people: [{ band: 'ic', count: 4 }], bookedMinutes: 45, agenda: [{ title: 'A', minutes: 20 }, { title: 'B', minutes: 20 }] });
    await maya('POST', `/api/meetings/${r.data.meeting.id}/start`);
    return r.data.meeting.id;
  };
  const start = Date.now() - 16 * HOUR;
  // Left running overnight, with one short pause early on.
  const a = await mk('Forgotten');
  await ago(uid, a, { startedAt: iso(start), marks: [20 * MIN], pauses: [{ at: iso(start + 5 * MIN), until: iso(start + 8 * MIN) }] });
  assert.strictEqual((await maya('POST', `/api/meetings/${a}/end`, { at: 'soon' })).status, 400);
  const ea = await maya('POST', `/api/meetings/${a}/end`, { at: 45 * MIN });
  assert.strictEqual(ea.status, 200, JSON.stringify(ea.data));
  assert.strictEqual(Date.parse(ea.data.meeting.endedAt), start + 48 * MIN, 'the wall clock at 45 minutes of meeting, stepping over the pause');
  assert.deepStrictEqual(ea.data.meeting.marks, [20 * MIN, 45 * MIN], 'the current item closes at the same moment');
  const ra = (await maya('GET', `/api/meetings/${a}/receipt`)).data.receipt;
  assert.deepStrictEqual([ra.durationMs, Math.round(ra.costUsd), ra.onTime, ra.overrunMs], [45 * MIN, 255, true, 0]);
  // Never before the last closed item...
  const b = await mk('Floor');
  await ago(uid, b, { startedAt: iso(start), marks: [30 * MIN] });
  const eb = await maya('POST', `/api/meetings/${b}/end`, { at: 10 * MIN });
  assert.deepStrictEqual([Date.parse(eb.data.meeting.endedAt), eb.data.meeting.marks], [start + 30 * MIN, [30 * MIN, 30 * MIN]]);
  // ...never past now...
  const c = await mk('Ceiling');
  await ago(uid, c, { startedAt: iso(Date.now() - 10 * MIN) });
  const ec = await maya('POST', `/api/meetings/${c}/end`, { at: 60 * MIN });
  assert.ok(Math.abs(Date.parse(ec.data.meeting.endedAt) - Date.now()) < 5000, 'clamped to now');
  // ...and a pause left open overnight ends where the meeting did.
  const d = await mk('Paused overnight');
  await ago(uid, d, { startedAt: iso(start), pauses: [{ at: iso(start + 50 * MIN), until: null }] });
  const ed = await maya('POST', `/api/meetings/${d}/end`, { at: 45 * MIN });
  assert.deepStrictEqual([ed.data.meeting.status, Date.parse(ed.data.meeting.endedAt), ed.data.meeting.pauses], ['ended', start + 45 * MIN, []]);
  assert.strictEqual(R.elapsed(ed.data.meeting, Date.now()), 45 * MIN);
  for (const id of [a, b, c, d]) await maya('DELETE', `/api/meetings/${id}`);
});

test('the shared receipt: numbers only, frozen, GET-only, noindex, no referrer, revocable', async () => {
  const anon = client();
  const s = await maya('POST', `/api/meetings/${MT.id}/share`);
  assert.strictEqual(s.status, 200, JSON.stringify(s.data));
  assert.ok(M.TOKEN_RE.test(s.data.token) && s.data.token.length >= 22);
  const pub = await anon('GET', `/api/shared/${s.data.token}`);
  assert.strictEqual(pub.status, 200);
  const text = JSON.stringify(pub.data);
  for (const leak of ['Weekly Marketing Sync', 'Campaign review', 'Pause the paid social', 'Send the brief', 'Jordan', 'Maya', 'Sam', 'Rebrand', SETUP.invite, 'maya@example.com', uidOf('maya@example.com'), MT.code]) {
    assert.ok(!text.includes(leak), `leaked: ${leak}`);
  }
  assert.deepStrictEqual([pub.data.counts.decision, pub.data.headcount, pub.data.bingo.handle, pub.data.preview], [2, 7, '🦊', false]);
  assert.strictEqual(pub.headers.get('referrer-policy'), 'no-referrer');
  assert.match(pub.headers.get('x-robots-tag'), /noindex/);
  const page = await fetch(`${base}/s/${s.data.token}`);
  assert.ok((await page.text()).includes('<base href="../">'));
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.strictEqual((await anon('POST', `/api/shared/${s.data.token}`, {})).status, 405, 'GET only');
  assert.strictEqual((await anon('DELETE', `/api/shared/${s.data.token}`)).status, 405);
  assert.strictEqual((await anon('PUT', `/s/${s.data.token}`, {})).status, 405);
  // Frozen: a late vote changes nothing until Update.
  const before = pub.data.roti.n;
  await voters[4]('POST', `/api/room/${MT.code}/vote`, { roti: null });
  assert.strictEqual((await anon('GET', `/api/shared/${s.data.token}`)).data.roti.n, before);
  const up = await maya('POST', `/api/meetings/${MT.id}/share`);
  assert.strictEqual(up.data.token, s.data.token, 'Update re-freezes the same link');
  assert.strictEqual((await anon('GET', `/api/shared/${s.data.token}`)).data.roti.n, before - 1);
  assert.strictEqual((await maya('GET', `/api/shared/${s.data.token}`)).data.preview, true);
  assert.strictEqual((await maya('DELETE', `/api/meetings/${MT.id}/share`)).status, 200);
  assert.strictEqual((await anon('GET', `/api/shared/${s.data.token}`)).status, 404, 'revoked for good');
  assert.strictEqual((await anon('GET', '/api/shared/short')).status, 404);
  const live = await maya('POST', '/api/meetings', { title: 'Not over', people: [{ band: 'ic', count: 2 }] });
  assert.strictEqual((await maya('POST', `/api/meetings/${live.data.meeting.id}/share`)).status, 409, 'a receipt is printed at the end');
  await maya('DELETE', `/api/meetings/${live.data.meeting.id}`);
  MT.token = (await maya('POST', `/api/meetings/${MT.id}/share`)).data.token;
});

test('room codes: typed any way; a wrong one says nothing; too many from one address are refused; a reset kills the old one', async () => {
  const c0 = client();
  // One address of its own, so the block below does not follow the other tests.
  const c = (m, p, b) => c0(m, p, b, { 'X-Forwarded-For': '203.0.113.9' });
  assert.strictEqual((await c('GET', '/api/room/ZZZZ-ZZZZ')).status, 404);
  const fresh = await maya('POST', `/api/meetings/${MT.id}/code`);
  assert.match(fresh.data.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.strictEqual((await c('GET', `/api/room/${MT.code}`)).status, 404, 'the old code is dead');
  assert.strictEqual((await c('GET', `/api/room/${fresh.data.code}`)).status, 200);
  MT.code = fresh.data.code;
  // Guessing takes many DIFFERENT codes; each counts once.
  const A = R.CODE_ALPHABET;
  let last;
  for (let i = 0; i < M.LIMITS.roomMissesPerIp + 1; i++) last = await c('GET', `/api/room/QQQQQQ${A[Math.floor(i / A.length)]}${A[i % A.length]}`);
  assert.strictEqual(last.status, 429);
  assert.strictEqual((await c('GET', `/api/room/${MT.code}`)).status, 429, 'once blocked, even the right code waits');
});

test('after a code reset, a room full of phones polling the old code on one address is not locked out of the new one', async () => {
  const c0 = client();
  const c = (m, p, b) => c0(m, p, b, { 'X-Forwarded-For': '203.0.113.10' });
  const old = MT.code;
  const fresh = await maya('POST', `/api/meetings/${MT.id}/code`);
  // Ten phones, five polls each, all still on the dead code: one wrong code.
  for (let i = 0; i < 50; i++) assert.strictEqual((await c('GET', `/api/room/${old}`)).status, 404);
  assert.strictEqual((await c('GET', `/api/room/${fresh.data.code}`)).status, 200, 'the new code still opens');
  MT.code = fresh.data.code;
});

test('sharpen: metered, forced tool, fits the booking, bands in the room only, markup stripped - and nothing stored', async () => {
  const m = await maya('POST', '/api/meetings', { title: 'Q4 launch', people: [{ band: 'manager', count: 1 }, { band: 'ic', count: 3 }], bookedMinutes: 30, invite: 'Catch up on the launch, budget and hiring' });
  MT.next = m.data.meeting.id;
  const calls = await modelCalls();
  const dump = store._dump();
  const r = await maya('POST', `/api/meetings/${MT.next}/sharpen`, {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one metered model call');
  assert.strictEqual(store._dump(), dump, 'a proposal saves nothing');
  assert.ok(r.data.proposal.minutes <= 30 && r.data.proposal.items.length >= 2);
  assert.ok(r.data.proposal.items.every((i) => ['manager', 'ic'].includes(i.ownerRole)));
  const inj = await maya('POST', `/api/meetings/${MT.next}/sharpen`, { invite: 'Launch review INJECT' });
  assert.strictEqual(inj.status, 200, JSON.stringify(inj.data));
  const p = inj.data.proposal;
  const all = JSON.stringify([p.outcome, p.items, p.why, p.asyncDraft]);
  for (const gone of ['<', '**', 'script', 'evil.example', 'Tuesday', '30%']) assert.ok(!all.includes(gone), `${gone} is gone`);
  assert.ok(p.minutes <= 30 && p.items.length <= 8, `fits: ${p.minutes} in ${p.items.length}`);
  assert.ok(p.items.every((i) => i.ownerRole !== 'exec'), 'nobody from exec is in the room');
  assert.ok(p.notes.length && p.removed.length);
  const email = await maya('POST', `/api/meetings/${MT.next}/sharpen`, { invite: 'Weekly status EMAIL, numbers' });
  assert.deepStrictEqual([email.data.proposal.verdict, email.data.proposal.asyncDraft.length > 40], ['email', true]);
  assert.strictEqual((await maya('POST', `/api/meetings/${MT.next}/sharpen`, { invite: 'EMPTY' })).status, 422);
  // The provider failing is OUR 502/503 with the route's own words - never its
  // status (a 401 reads as "signed out" on the page) nor its raw JSON.
  const quiet = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  let up401; let up529;
  try {
    up401 = await maya('POST', `/api/meetings/${MT.next}/sharpen`, { invite: 'Plan UPSTREAM401' });
    up529 = await maya('POST', `/api/meetings/${MT.next}/sharpen`, { invite: 'Plan UPSTREAM529' });
  } finally { console.error = quiet; }
  assert.deepStrictEqual([up401.status, up401.data.error], [502, 'Could not sharpen that. Try again, or start from a template.']);
  assert.deepStrictEqual([up529.status, up529.data.error], [503, 'Could not sharpen that. Try again, or start from a template.']);
  assert.ok(!JSON.stringify([up401.data, up529.data]).includes('fake_upstream_error'), 'no provider body reaches the page');
  assert.strictEqual(logged.length, 2, 'and the operator sees both in the log');
  // Apply is the ordinary edit route.
  const apply = await maya('PUT', `/api/meetings/${MT.next}`, { agenda: r.data.proposal.items, outcome: r.data.proposal.outcome, invite: r.data.invite });
  assert.strictEqual(apply.status, 200, JSON.stringify(apply.data));
  assert.strictEqual(apply.data.meeting.agenda.length, r.data.proposal.items.length);
  const calls2 = await modelCalls();
  assert.strictEqual((await maya('POST', `/api/meetings/${MT.id}/sharpen`, {})).status, 409, 'too late once it has started');
  await settle();
  assert.strictEqual(await modelCalls(), calls2, 'and nothing was spent finding out');
});

test('recap: 400s before any spend, the whiteboard read once and kept nowhere, quotes checked, owners earned', async () => {
  const calls = await modelCalls();
  const rec = (b) => maya('POST', `/api/meetings/${MT.next}/recap`, b);
  assert.strictEqual((await rec({})).status, 400, 'nothing logged, no notes, no photo');
  assert.strictEqual((await rec({ image: { type: 'image/jpeg', data: Buffer.from('%PDF-1.7 not an image').toString('base64') } })).status, 400);
  assert.strictEqual((await rec({ image: { type: 'application/pdf', data: JPEG } })).status, 400);
  assert.strictEqual((await rec({ image: { type: 'image/jpeg', data: 'not base64 !!' } })).status, 400);
  // The 6 MB parser is for the photo: notes that size are refused before any
  // cleaning runs, and quickly - a run of '<' used to hold the process.
  const t0 = Date.now();
  const huge = await rec({ notes: '<'.repeat(200 * 1024) });
  assert.deepStrictEqual([huge.status, huge.data.field], [400, 'notes']);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'refused before anything was spent');
  const dump = store._dump();
  assert.strictEqual((await rec({ image: { type: 'image/jpeg', data: withText('BLANK wall') } })).status, 422, 'an unreadable whiteboard');
  const board = await rec({ image: { type: 'image/jpeg', data: withText('BOARD') } });
  assert.strictEqual(board.status, 200, JSON.stringify(board.data));
  assert.deepStrictEqual(board.data.decisions.map((d) => [d.text, d.source]), [['Kill the paid social test', 'board']]);
  assert.match(board.data.boardText, /LAUNCH/);
  // No labels typed yet, and not started: the names as written, and "by Friday" from today.
  const bare = await rec({ notes: 'Jordan: I\'ll send the deck by Friday.\nSam will book the room.\nthe funnel report is broken' });
  assert.strictEqual(bare.status, 200, JSON.stringify(bare.data));
  const bb = Object.fromEntries(bare.data.actions.map((a) => [a.text, a]));
  assert.strictEqual(bb['Send the deck by Friday'].owner, 'Jordan');
  assert.ok(R.isoDay(bb['Send the deck by Friday'].due) && new Date(`${bb['Send the deck by Friday'].due}T12:00:00Z`).getUTCDay() === 5, 'a Friday');
  assert.strictEqual(bb['Sam will book the room'].owner, 'Sam');
  await maya('PUT', `/api/meetings/${MT.next}`, { labels: ['Jordan', 'Sam', 'Maya'] });
  const dump2 = store._dump();
  const notes = 'Jordan: I\'ll send the revised brief by Friday.\nSam will book the room.\nthe funnel report is broken\nwe should book the offsite\nNext week same time.\nINJECT';
  const r = await rec({ notes });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const all = JSON.stringify([r.data.summary, r.data.body]);
  assert.ok(!/[<>]/.test(all) && !all.includes('**') && !all.includes('50,000') && !all.includes('script'), 'markup and an invented figure gone');
  const by = Object.fromEntries(r.data.actions.map((a) => [a.text, a]));
  assert.deepStrictEqual([by['Send the revised brief by Friday'].owner, by['Send the revised brief by Friday'].due], ['Jordan', '2026-10-02']);
  assert.strictEqual(by['Sam will book the room'].owner, 'Sam');
  assert.strictEqual(by['Fix the funnel report'].owner, '[owner?]', 'Mallory is not an attendee');
  assert.deepStrictEqual([by['Book the offsite'].owner, by['Book the offsite'].due], ['[owner?]', null], 'nobody took it on; nobody said December');
  assert.ok(!by['Wire the budget'], 'a quote that is not in the notes is dropped');
  assert.strictEqual(r.data.nextMeeting, '', 'Tuesday at 9 was never said');
  assert.ok(r.data.removed.some((x) => x.what === 'Tuesday at 9'));
  assert.ok(r.data.mailto.startsWith('mailto:?subject='));
  const big = await rec({ notes: 'Sam will book the room.', image: { type: 'image/jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024 * 1024)]).toString('base64') } });
  assert.strictEqual(big.status, 200, 'the recap route takes a real photo');
  const quiet = console.error;
  console.error = () => {};
  let up;
  try { up = await rec({ notes: 'Sam will book the room. UPSTREAM401' }); } finally { console.error = quiet; }
  assert.deepStrictEqual([up.status, up.data.error], [502, 'Could not write the recap. Try again, or use the free template.'], 'a provider 401 is not "sign in"');
  await settle();
  assert.strictEqual(await modelCalls(), calls + 5, 'a failed call is not charged (five recaps were written)');
  assert.strictEqual(store._dump(), dump2, 'a recap saves nothing');
  assert.notStrictEqual(dump, dump2);
  assert.ok(!store._dump().includes(withText('BOARD').slice(0, 40)) && !store._dump().includes('funnel report'), 'no photo and no notes in the store');
});

/* ---------------- Record or snap (Gemini), the switch and the lab's AI guard ---------------- */

/** A tiny PCM WAV: a real header and `n` bytes of sound, with `text` in them. */
function wav(text = '', n = 400, byteRate = 16000) {
  const data = Buffer.concat([Buffer.from(text), Buffer.alloc(n, 1)]);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]).toString('base64');
}
const usageRows = async () => identityStore.list('usage');
async function onGemini(fn, guard) {
  process.env.RECEIPT_AI_PROVIDER = 'gemini';
  if (guard) global.LAB_AI_GUARD = guard;
  try { return await fn(); } finally { delete process.env.RECEIPT_AI_PROVIDER; delete global.LAB_AI_GUARD; }
}

test('a recording on the way in: the real type from its first bytes, 8 MB, a WAV no longer than 30 minutes - and never decoded whole', () => {
  const ok = audio.validate({ type: 'audio/wav', data: wav() });
  assert.deepStrictEqual([ok.mediaType, ok.bytes], ['audio/wav', 444]);
  assert.strictEqual(audio.validate({ data: `data:audio/webm;base64,${Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40, 2)]).toString('base64')}` }).mediaType, 'audio/webm', 'a data: URL, typed by its bytes');
  assert.strictEqual(audio.validate({ type: 'audio/mpeg', data: Buffer.concat([Buffer.from('....ftypM4A '), Buffer.alloc(40)]).toString('base64') }).mediaType, 'audio/mp4', 'the declared type is only a claim');
  const bad = (raw, re) => assert.throws(() => audio.validate(raw), (e) => e.status === 400 && e.expose === true && re.test(e.message));
  bad(null, /Record the meeting/);
  bad({ data: '' }, /could not be read/);
  bad({ data: 'not base64 !!' }, /could not be read/);
  bad({ type: 'audio/wav', data: JPEG }, /sound file/);
  bad({ type: 'audio/wav', data: Buffer.from('%PDF-1.7 not a recording at all').toString('base64') }, /sound file/);
  bad({ type: 'audio/wav', data: wav('', 2000, 1) }, /longer than 30 minutes/);
  const t0 = Date.now();
  bad({ data: 'A'.repeat(11 * 1024 * 1024 + 4096) }, /too big/);
  bad({ data: '<'.repeat(11 * 1024 * 1024 + 4096) }, /too big/);
  assert.ok(Date.now() - t0 < 500, 'an oversized string is refused by its length');
  assert.strictEqual(audio.MAX_MINUTES, 30);
  assert.strictEqual(audio.MAX_BYTES, 8 * 1024 * 1024);
});

test('a due date is worked out here, from the words said and the meeting’s date - or not at all', () => {
  const d = (w, day = '2026-09-25') => gemini.dueFromWords(w, day); // a Friday
  assert.strictEqual(d('by Friday'), '2026-10-02', 'said on a Friday: a week on');
  assert.strictEqual(d('by Monday'), '2026-09-28');
  assert.strictEqual(d('Thurs'), '2026-10-01');
  assert.strictEqual(d('next Tuesday'), '2026-09-29', 'the Tuesday of the following week');
  assert.strictEqual(d('next Friday', '2026-09-21'), '2026-10-02', 'not this week’s');
  assert.strictEqual(d('tomorrow'), '2026-09-26');
  assert.strictEqual(d('today'), '2026-09-25');
  assert.strictEqual(d('end of the week', '2026-09-22'), '2026-09-25');
  assert.strictEqual(d('by end of month'), '2026-09-30');
  assert.strictEqual(d('by October 15'), '2026-10-15');
  assert.strictEqual(d('the 3rd of March'), '2027-03-03', 'already past this year: next year’s');
  assert.strictEqual(d('Oct 15th'), '2026-10-15');
  assert.strictEqual(d('on 2026-10-09'), '2026-10-09');
  for (const vague of ['soon', 'next week', 'Q4', 'asap', 'in a couple of weeks', '', 'on 2031-01-01', 'the month after', 'Feb 31']) assert.strictEqual(d(vague), null, vague);
  assert.strictEqual(gemini.dueFromWords('by Friday', null), null, 'no meeting date, no date');
});

test('an owner survives only when the quoted words hand it to them by name', () => {
  const o = gemini.ownerAsSaid;
  assert.strictEqual(o('Sam', 'Sam will book the room'), 'Sam');
  assert.strictEqual(o('sam', 'SAM’LL book it'), 'sam');
  assert.strictEqual(o('Jordan', 'Jordan, can you book the room for the retro?'), 'Jordan');
  assert.strictEqual(o('Sam', 'Sam: legal sign-off by Friday'), 'Sam', 'a whiteboard line');
  assert.strictEqual(o('Dee', 'assigned to Dee'), 'Dee');
  assert.strictEqual(o('Sam', 'I’ll send the brief'), '', 'the name is not in the words');
  assert.strictEqual(o('Sam', 'Sam said the report is broken'), '', 'mentioned, not handed it');
  assert.strictEqual(o('Sam', 'Sam will not be able to send it'), '');
  assert.strictEqual(o('Sam', 'Samantha will send it'), '', 'whole names only');
  assert.strictEqual(o('Speaker 2', 'Speaker 2: I will do it'), '', 'a voice is not a name');
  assert.strictEqual(o('team', 'team to follow up'), '');
  assert.strictEqual(o('', 'Sam will book the room'), '');
});

test('validateMinutes: every item must quote the transcription; owners and dates are never invented', () => {
  const ctx = gemini.minutesContext({ title: 'Sync', labels: ['Jordan', 'Sam'] }, 'recording', '2026-09-25');
  const transcript = 'Maya: we launch on October 15.\nSpeaker 2: I\'ll send the brief by Friday.\nMaya: jordan will book the room.\nMaya: Priya, can you review it tomorrow?';
  const out = gemini.validateMinutes({
    readable: true, transcript, summary: '<b>**Shipped**</b> and it saves $50,000.',
    decisions: [{ text: 'Launch on October 15', quote: 'we launch on  OCTOBER 15' }, { text: 'Double the budget', quote: 'we doubled the budget' }, { text: 'Launch on October 15', quote: 'we launch on October 15.' }, { text: 'Launch on November 3', quote: 'we launch on October 15' }],
    actions: [
      { text: 'Send the brief', quote: 'I\'ll send the brief by Friday', owner: 'Sam', dueText: 'by Friday' },
      { text: 'Book the room', quote: 'jordan will book the room', owner: 'Jordan', dueText: 'by Monday', due: '2026-09-28' },
      { text: 'Review it', quote: 'Priya, can you review it tomorrow?', owner: 'Priya', dueText: 'tomorrow' },
      { text: 'Send the brief again', quote: 'I\'ll send the brief by Friday', owner: 'Speaker 2', dueText: null },
      { text: 'Invented', quote: 'x', owner: 'Sam', dueText: null },
    ],
    parking: [{ text: '<script>x</script>', quote: 'we launch on October 15' }, null, 'nope'],
  }, ctx);
  assert.deepStrictEqual(out.decisions.map((x) => x.text), ['Launch on October 15', 'Launch on [add: date] [add: number]'], 'a quote nobody said is dropped, a repeat too, and a date that is not in the quote is a gap');
  const by = Object.fromEntries(out.actions.map((a) => [a.text, a]));
  assert.deepStrictEqual([by['Send the brief'].owner, by['Send the brief'].dueText, by['Send the brief'].due], [null, 'by Friday', '2026-10-02'], 'Sam is not in those words; Friday is ours to work out');
  assert.deepStrictEqual([by['Book the room'].owner, by['Book the room'].ownerIsAttendee, by['Book the room'].due, by['Book the room'].dueText], ['Jordan', true, null, null], 'the attendee’s own spelling; nobody said Monday, and a date the model sent is never read');
  assert.deepStrictEqual([by['Review it'].owner, by['Review it'].ownerIsAttendee, by['Review it'].due], ['Priya', false, '2026-09-26'], 'a name as said, even when not typed');
  assert.strictEqual(by['Send the brief again'].owner, null);
  assert.ok(!by.Invented);
  assert.deepStrictEqual(out.parking, []);
  assert.ok(!/[<>*]|50,000/.test(out.summary), out.summary);
  for (const w of ['Double the budget', 'Sam', 'by Monday', 'Speaker 2', 'Invented']) assert.ok(out.removed.some((r) => r.what === w), `${w} is listed as taken out`);
  assert.strictEqual(out.transcript, transcript);
  for (const a of out.actions) assert.ok(R.norm(out.transcript).includes(R.norm(a.quote)));
  // Nothing heard, nothing read.
  assert.strictEqual(gemini.validateMinutes({ readable: false, transcript: 'x'.repeat(50), decisions: [], actions: [], parking: [] }, ctx), null);
  assert.strictEqual(gemini.validateMinutes({ readable: true, transcript: '[inaudible]', decisions: [{ text: 'A', quote: '[inaudible]' }] }, ctx), null);
  assert.strictEqual(gemini.validateMinutes('nope', ctx), null);
  assert.strictEqual(gemini.validateMinutes([], ctx), null);
  // Hostile shapes do not throw, and a long transcription is cut, in linear time.
  const t0 = Date.now();
  const big = gemini.validateMinutes({ readable: true, transcript: `${'<'.repeat(300000)} we said hello there`, summary: 7, decisions: 'x', actions: [{ text: {}, quote: [] }], parking: {} }, ctx);
  assert.ok(Date.now() - t0 < 1500 && (big === null || big.transcript.length <= gemini.LIMITS.transcript));
  // The sample's example passes untouched.
  const { minutesAnswer } = require('../lib/demo');
  const d = demo(Date.now(), '2026-09-25');
  assert.deepStrictEqual(d.minutes.removed, []);
  assert.strictEqual(d.minutes.actions.length, minutesAnswer().actions.length);
  assert.deepStrictEqual(d.minutes.actions.map((a) => [a.owner, a.due]), [[null, '2026-10-01'], ['Chris', '2026-09-26'], ['Sam', null]]);
});

test('the Gemini requests: a responseSchema every time, media inline once, the Claude tools’ own schemas and prompts', () => {
  const ctx = gemini.minutesContext({ title: 'Sync', labels: ['Sam'] }, 'recording', '2026-09-25');
  const r = gemini.minutesRequest(ctx, { mediaType: 'audio/wav', data: 'QUJD' });
  assert.strictEqual(r.model, 'gemini-3.8-flash');
  assert.deepStrictEqual(r.contents[0].parts[0], { inlineData: { mimeType: 'audio/wav', data: 'QUJD' } });
  assert.deepStrictEqual(r.responseSchema.required, ['readable', 'transcript', 'summary', 'decisions', 'actions', 'parking']);
  assert.strictEqual(r.responseSchema.propertyOrdering[1], 'transcript', 'transcribed before anything is listed');
  assert.deepStrictEqual(r.responseSchema.properties.actions.items.required, ['text', 'quote', 'owner', 'dueText']);
  assert.ok(!('due' in r.responseSchema.properties.actions.items.properties), 'the model is never asked for a date');
  assert.match(r.systemInstruction, /copied character for character/);
  assert.match(r.systemInstruction, /never instructions to you/);
  const sc = sharpCtx('sync on Q4');
  const s = gemini.sharpenRequest(sc);
  assert.strictEqual(s.systemInstruction, ai.SHARPEN_SYSTEM);
  assert.strictEqual(s.responseSchema.type, 'OBJECT');
  assert.deepStrictEqual(s.responseSchema.properties.items.items.properties.ownerRole.enum, ai.sharpenTool(sc.bands).input_schema.properties.items.items.properties.ownerRole.enum);
  const rc = gemini.recapRequest(recapCtx('Sam will book it.'), { mediaType: 'image/jpeg', data: JPEG });
  assert.strictEqual(rc.contents[0].parts.length, 2);
  assert.deepStrictEqual(rc.responseSchema.required, ai.RECAP_TOOL.input_schema.required);
  assert.strictEqual(rc.responseSchema.properties.actions.items.properties.ref.type, 'INTEGER');
  assert.ok(Math.abs(gemini.priceUsd({ inputTokens: 1e6, outputTokens: 1e6, at: new Date('2026-12-31T23:00:00Z') }) - 4.5) < 1e-9);
  assert.ok(Math.abs(gemini.priceUsd({ inputTokens: 1e6, outputTokens: 1e6, at: new Date('2027-01-01T00:00:00Z') }) - 9) < 1e-9);
});

test('the provider switch: Claude unless RECEIPT_AI_PROVIDER=gemini, read per request; unset, "Record or snap" is off and costs nothing', async () => {
  assert.strictEqual(process.env.RECEIPT_AI_PROVIDER, undefined, 'the suite runs on the default');
  const anon = client();
  const aiNow = (await anon('GET', '/api/me')).data.ai;
  assert.deepStrictEqual({ ...aiNow, minuteCents: 0 }, { provider: 'claude', minutes: false, audioMinutes: 30, audioBytes: 8 * 1024 * 1024, minuteCents: 0 });
  assert.ok(aiNow.minuteCents > 0.2 && aiNow.minuteCents < 0.6, 'about a quarter of a cent a minute (double from 2027)');
  for (const v of ['Gemini', 'GEMINI', '1', 'true', 'vertex', ' gemini', 'off']) {
    process.env.RECEIPT_AI_PROVIDER = v;
    try { assert.strictEqual((await anon('GET', '/api/me')).data.ai.provider, 'claude', `"${v}" is not the switch`); } finally { delete process.env.RECEIPT_AI_PROVIDER; }
  }
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /process\.env\.RECEIPT_AI_PROVIDER === 'gemini' \? 'gemini' : 'claude'/);
  // The route's order is the safety: sign-in, budget, daily cap, ownership, the switch, and only then the big parser.
  assert.match(src, /app\.post\('\/api\/meetings\/:id\/minutes', \.\.\.spend, ownerOnly, minutesOn, mediaJson, /);
  assert.match(src, /const spend = \[identity\.requireUser, identity\.requireBudget, identity\.requireDailyCap\];/);
  const calls = await modelCalls();
  const dump = store._dump();
  assert.strictEqual((await anon('POST', '/api/meetings/abcdef/minutes', { audio: { data: wav() } })).status, 401);
  const off = await maya('POST', `/api/meetings/${MT.next}/minutes`, { audio: { type: 'audio/wav', data: wav() } });
  assert.deepStrictEqual([off.status, off.data.code], [404, 'ai-off']);
  assert.strictEqual((await maya('GET', '/api/me')).data.ai.minutes, false);
  // Claude still answers the recap, and with a guard in the lab it is asked first and told the cost after.
  const seen = [];
  global.LAB_AI_GUARD = {
    allow: async (a) => { seen.push(['allow', a.provider, a.app, Boolean(a.req && a.req.user)]); return { ok: true }; },
    record: async (r) => { seen.push(['record', r.provider, r.app, r.usd]); return true; },
    priceUsd: (p) => { seen.push(['price', p.provider, p.model, p.inputTokens, p.outputTokens]); return 0.0123; },
    gemini: { generate: async () => { throw new Error('Gemini must not be called on the default'); } },
  };
  try {
    const r = await maya('POST', `/api/meetings/${MT.next}/recap`, { notes: 'Sam will book the room.' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.deepStrictEqual(seen, [['allow', 'claude', 'receipt', true], ['price', 'claude', 'claude-haiku-4-5', 800, 400], ['record', 'claude', 'receipt', 0.0123]]);
    global.LAB_AI_GUARD.allow = async () => ({ ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' });
    await settle();
    const before = await modelCalls();
    const no = await maya('POST', `/api/meetings/${MT.next}/recap`, { notes: 'Sam will book the room.' });
    assert.deepStrictEqual([no.status, no.data.code, no.data.error], [503, 'monthly-cap', 'AI answers are resting until next month; everything else still works.']);
    await settle();
    assert.strictEqual(await modelCalls(), before, 'the guard said no: no model call');
  } finally { delete global.LAB_AI_GUARD; }
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1);
  assert.strictEqual(store._dump(), dump);
});

test('Record or snap: 400s before any spend, heard once and kept nowhere, quotes checked against the transcription, owners and dates as said', async () => {
  await onGemini(async () => {
    assert.deepStrictEqual((await maya('GET', '/api/me')).data.ai.minutes, true);
    const min = (b) => maya('POST', `/api/meetings/${MT.next}/minutes`, b);
    const calls = await modelCalls();
    const dump = store._dump();
    for (const [b, why] of [[{}, 'nothing sent'], [{ audio: { data: wav() }, image: { type: 'image/jpeg', data: JPEG } }, 'both at once'],
      [{ audio: { type: 'audio/wav', data: JPEG } }, 'a photo is not a recording'], [{ audio: { data: 'not base64 !!' } }, 'not base64'],
      [{ audio: { data: wav('', 2000, 1) } }, 'a WAV over 30 minutes'], [{ image: { type: 'image/jpeg', data: Buffer.from('%PDF-1.7').toString('base64') } }, 'a PDF is not a photo'],
      [{ audio: 'just a string' }, 'not an object']]) {
      assert.strictEqual((await min(b)).status, 400, why);
    }
    await settle();
    assert.strictEqual(await modelCalls(), calls, 'refused before anything was spent');
    assert.strictEqual((await min({ audio: { type: 'audio/wav', data: wav('BLANK hiss') } })).status, 422, 'nothing could be heard');

    const r = await min({ audio: { type: 'audio/wav', data: wav('', 200 * 1024) } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.strictEqual(r.data.kind, 'recording');
    assert.match(r.data.transcript, /^Maya: Okay, we are recording\./);
    assert.deepStrictEqual(r.data.decisions, [{ text: 'Launch on October 15', quote: 'we launch on October 15' }]);
    const day = r.data.day;
    assert.deepStrictEqual(r.data.actions.map((a) => [a.text, a.owner, a.ownerIsAttendee, a.dueText, a.due]), [
      ['Send the revised brief', null, false, 'by Friday', gemini.dueFromWords('by Friday', day)],
      ['Book the room for the retro', 'Jordan', true, null, null],
      ['Review the pricing page', 'Priya', false, 'tomorrow', R.addDays(day, 1)],
    ], '"I’ll" names nobody; Jordan and Priya are named in the words; the dates are ours');
    assert.strictEqual(r.data.parking.length, 1);
    assert.deepStrictEqual(r.data.removed, []);
    for (const x of [...r.data.decisions, ...r.data.actions, ...r.data.parking]) assert.ok(R.norm(r.data.transcript).includes(R.norm(x.quote)), x.quote);

    const inj = await min({ audio: { type: 'audio/wav', data: wav('INJECT') } });
    assert.strictEqual(inj.status, 200, JSON.stringify(inj.data));
    const all = JSON.stringify({ ...inj.data, transcript: '', removed: [] });
    assert.ok(!/<script|\*\*|50,000|Double the budget|Mallory|Speaker 2|2026-12-01/.test(all), `nothing invented survives: ${all}`);
    const ib = Object.fromEntries(inj.data.actions.map((a) => [a.text.split(' ').slice(0, 3).join(' '), a]));
    assert.deepStrictEqual([ib['Wire the budget'].owner, ib['Chase the vendor'].owner, ib['Chase the vendor'].due, ib['Chase the vendor'].dueText], [null, null, null, null]);
    assert.deepStrictEqual([ib['Fix the launch'].owner, ib['Fix the launch'].due], [null, null], 'Maya is only the speaker; a date the model worked out is not read');
    assert.ok(inj.data.removed.length >= 5);

    const board = await min({ image: { type: 'image/jpeg', data: withText('BOARD') } });
    assert.strictEqual(board.status, 200, JSON.stringify(board.data));
    assert.deepStrictEqual([board.data.kind, board.data.actions[0].owner, board.data.actions[0].ownerIsAttendee, board.data.actions[0].dueText], ['board', 'Sam', true, 'by Friday']);
    assert.strictEqual((await min({ image: { type: 'image/jpeg', data: withText('BLANK wall') } })).status, 422);

    await settle();
    const rows = (await usageRows()).slice(-5);
    assert.strictEqual(await modelCalls(), calls + 5, 'one call each - the unreadable ones too');
    assert.ok(rows.every((u) => u.route === 'minutes:gemini-3.8-flash' && u.model === 'claude-haiku-4-5'), JSON.stringify(rows.map((u) => u.route)));
    assert.strictEqual(store._dump(), dump, 'nothing is saved: not the recording, not the transcription, not the items');
    assert.ok(!store._dump().includes('Okay, we are recording') && !JSON.stringify(await usageRows()).includes('recording.'));

    // What the person keeps goes through the ordinary log route, their edit and all.
    const a = r.data.actions[1];
    const saved = await maya('POST', `/api/meetings/${MT.next}/log`, { kind: 'action', text: `${a.text} (Thursday’s)`, owner: a.owner, due: '2026-10-01' });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.data));
    assert.deepStrictEqual([saved.data.item.owner, saved.data.item.due], ['Jordan', '2026-10-01']);
    assert.strictEqual((await maya('DELETE', `/api/meetings/${MT.next}/log/${saved.data.item.id}`)).status, 200);

    // The sharpener and the recap answer the same on Gemini, through the same validators.
    const before = await modelCalls();
    const fresh = await maya('POST', '/api/meetings', { title: 'Q4 planning', people: [{ band: 'manager', count: 2 }, { band: 'ic', count: 3 }], bookedMinutes: 30, agenda: [{ title: 'Talk', minutes: 30 }] });
    const sh = await maya('POST', `/api/meetings/${fresh.data.meeting.id}/sharpen`, { invite: 'sync on Q4 budget, hiring INJECT' });
    assert.strictEqual(sh.status, 200, JSON.stringify(sh.data));
    assert.ok(sh.data.proposal.items.length <= 8 && sh.data.proposal.items.reduce((s, i) => s + i.minutes, 0) <= 30);
    assert.ok(!/[<>]|evil\.example|Tuesday|30%/.test(JSON.stringify(sh.data.proposal).replace(/"removed":.*$/, '')));
    await maya('DELETE', `/api/meetings/${fresh.data.meeting.id}`);
    const rec = await maya('POST', `/api/meetings/${MT.next}/recap`, { notes: 'Jordan: I\'ll send the revised brief by Friday.\nSam will book the room.\nINJECT', image: { type: 'image/jpeg', data: withText('BOARD') } });
    assert.strictEqual(rec.status, 200, JSON.stringify(rec.data));
    const rb = Object.fromEntries(rec.data.actions.map((x) => [x.text, x]));
    assert.strictEqual(rb['Send the revised brief by Friday'].owner, 'Jordan');
    assert.ok(!rb['Wire the budget'] && rec.data.decisions.some((d) => d.source === 'board'));
    const quiet = console.error;
    console.error = () => {};
    let up;
    try { up = await maya('POST', `/api/meetings/${MT.next}/recap`, { notes: 'Sam will book the room. UPSTREAM429' }); } finally { console.error = quiet; }
    assert.deepStrictEqual([up.status, up.data.error], [503, 'Could not write the recap. Try again, or use the free template.'], 'the provider’s words never reach the page');
    await settle();
    assert.strictEqual(await modelCalls(), before + 2);
    assert.deepStrictEqual((await usageRows()).slice(-2).map((u) => u.route), ['sharpen:gemini-3.8-flash', 'recap:gemini-3.8-flash']);
  });
});

test('Record or snap behind the gates: signed out 401, out of credit 402, a stranger 404 - each before the 12 MB body is read or a model called', async () => {
  await onGemini(async () => {
    const calls = await modelCalls();
    const heavy = { audio: { type: 'audio/wav', data: wav('', 8.5 * 1024 * 1024) } };
    assert.strictEqual((await client()('POST', `/api/meetings/${MT.next}/minutes`, heavy)).status, 401);
    const stranger = await register('mallory@example.com');
    assert.strictEqual((await stranger('POST', `/api/meetings/${MT.next}/minutes`, heavy)).status, 404, 'ownership before the parser');
    await identityStore.merge('users', uidOf('maya@example.com'), { spentUsd: 100 });
    try {
      const broke = await maya('POST', `/api/meetings/${MT.next}/minutes`, heavy);
      assert.strictEqual(broke.status, 402);
      assert.ok('topUpUrl' in broke.data);
    } finally { await identityStore.merge('users', uidOf('maya@example.com'), { spentUsd: 0 }); }
    // The owner's own oversized recording is a plain 400/413, never a model call.
    assert.strictEqual((await maya('POST', `/api/meetings/${MT.next}/minutes`, heavy)).status, 400);
    assert.strictEqual((await maya('POST', `/api/meetings/${MT.next}/minutes`, { audio: { data: 'A'.repeat(13 * 1024 * 1024) } })).status, 413);
    assert.strictEqual((await maya('POST', '/api/meetings', { title: 'x'.repeat(200 * 1024) })).status, 413, 'every other route keeps the small limit');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  });
});

test('the lab’s AI guard around Gemini: asked first, told the real cost after, its "no" shown as it is - and a failed call that billed is still recorded', async () => {
  const seen = [];
  const sent = [];
  const guard = {
    allow: async (a) => { seen.push(['allow', a.provider, a.app, a.req.user.id === uidOf('maya@example.com')]); return { ok: true }; },
    record: async (r) => { seen.push(['record', r.provider, r.app, r.usd]); return true; },
    priceUsd: (p) => { assert.strictEqual(p.provider, 'gemini'); assert.strictEqual(p.model, 'gemini-3.8-flash'); return (p.inputTokens * 0.75 + p.outputTokens * 3.75) / 1e6; },
    gemini: {
      generate: async (r) => {
        seen.push(['generate']);
        sent.push(r);
        return { json: await r.fake({ contents: r.contents, generationConfig: { responseSchema: r.responseSchema } }), usage: { inputTokens: 57600, outputTokens: 9000 } };
      },
    },
  };
  const body = { audio: { type: 'audio/wav', data: wav() } };
  await onGemini(async () => {
    const r = await maya('POST', `/api/meetings/${MT.next}/minutes`, body);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const usd = (57600 * 0.75 + 9000 * 3.75) / 1e6;
    assert.deepStrictEqual(seen, [['allow', 'gemini', 'receipt', true], ['generate'], ['record', 'gemini', 'receipt', usd]]);
    assert.deepStrictEqual([sent[0].model, sent[0].contents[0].parts[0].inlineData.mimeType, typeof sent[0].responseSchema, sent[0].timeoutMs], ['gemini-3.8-flash', 'audio/wav', 'object', 150000]);
    await settle();
    const row = (await usageRows()).slice(-1)[0];
    assert.ok(Math.abs(row.costUsd - usd) < 0.0001, `the person is charged what it cost: ${row.costUsd}`);

    // A burst or the month's cap: its own words and status, and no model call.
    seen.length = 0;
    guard.allow = async () => ({ ok: false, status: 429, code: 'burst-minute', message: 'Lots of people are using AI right now - try again in a minute.' });
    const calls = await modelCalls();
    const no = await maya('POST', `/api/meetings/${MT.next}/minutes`, body);
    assert.deepStrictEqual([no.status, no.data.code, no.data.error], [429, 'burst-minute', 'Lots of people are using AI right now - try again in a minute.']);
    assert.deepStrictEqual(seen, []);
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    // A bad recording never reaches the guard at all.
    guard.allow = async () => { seen.push(['allow']); return { ok: true }; };
    assert.strictEqual((await maya('POST', `/api/meetings/${MT.next}/minutes`, { audio: { data: JPEG } })).status, 400);
    assert.deepStrictEqual(seen, []);

    // Gemini fails after billing: the page gets our words, the cost is still recorded.
    guard.gemini.generate = async () => { throw Object.assign(new Error('Gemini gave no answer. {"raw":"provider text"}'), { code: 'blocked', usage: { inputTokens: 1000, outputTokens: 0 } }); };
    const quiet = console.error;
    console.error = () => {};
    let bad;
    try { bad = await maya('POST', `/api/meetings/${MT.next}/minutes`, body); } finally { console.error = quiet; }
    assert.deepStrictEqual([bad.status, bad.data.error], [502, 'Could not read that right now. Nothing was saved - try again in a minute, or log the items by hand.']);
    assert.deepStrictEqual(seen, [['allow'], ['record', 'gemini', 'receipt', 0.00075]]);
    guard.gemini.generate = async () => { throw Object.assign(new Error('Gemini took too long.'), { code: 'timeout' }); };
    console.error = () => {};
    try { bad = await maya('POST', `/api/meetings/${MT.next}/minutes`, body); } finally { console.error = quiet; }
    assert.strictEqual(bad.status, 503, 'a timeout says try again');
  }, guard);
  // No guard and no stand-in is not reachable in the suite (the stand-in is on); the default is untouched.
  assert.strictEqual(global.LAB_AI_GUARD, undefined);
});

test('Gemini fails, Claude answers the sharpener and the recap: a thrown call, unusable output, the Gemini cap - not a burst; Record or snap stays Gemini-only', async () => {
  const lines = [];
  const quietLog = console.log; const quietErr = console.error;
  console.log = (m) => lines.push(String(m)); console.error = () => {};
  const mk = (o = {}) => {
    const seen = [];
    return { seen, g: {
      allow: async (a) => { seen.push(['allow', a.provider]); return (a.provider === 'gemini' && o.denyGemini) || { ok: true }; },
      record: async (r) => { seen.push(['record', r.provider]); return true; },
      priceUsd: () => 0.001,
      gemini: { generate: async (r) => { seen.push(['generate']); if (o.generate) return o.generate(r); return { json: await r.fake({ contents: r.contents, generationConfig: { responseSchema: r.responseSchema } }), usage: { inputTokens: 100, outputTokens: 10 } }; } },
    } };
  };
  const thrown = { generate: async () => { throw Object.assign(new Error('Gemini answered 500. SECRET'), { name: 'VertexError', code: 'http', status: 500, usage: { inputTokens: 900, outputTokens: 0 } }); } };
  const sharpen = (o) => { const x = mk(o); return onGemini(async () => ({ r: await maya('POST', `/api/meetings/${MT.next}/sharpen`, {}), seen: x.seen }), x.g); };
  const recap = (o) => { const x = mk(o); return onGemini(async () => ({ r: await maya('POST', `/api/meetings/${MT.next}/recap`, { notes: 'Sam will book the room.' }), seen: x.seen }), x.g); };
  try {
    let { r, seen } = await sharpen(thrown);
    assert.deepStrictEqual([r.status, r.data.proposal.items.length >= 2, seen], [200, true, [['allow', 'gemini'], ['generate'], ['record', 'gemini'], ['allow', 'claude'], ['record', 'claude']]], JSON.stringify(r.data));
    assert.ok(!JSON.stringify(r.data).includes('SECRET'));
    ({ r, seen } = await recap(thrown));
    assert.deepStrictEqual([r.status, Array.isArray(r.data.actions), seen.filter((x) => x[0] === 'allow')], [200, true, [['allow', 'gemini'], ['allow', 'claude']]], JSON.stringify(r.data));
    ({ r, seen } = await sharpen({ generate: async () => ({ json: { items: [] }, usage: { inputTokens: 10, outputTokens: 1 } }) }));
    assert.deepStrictEqual([r.status, seen.filter((x) => x[0] === 'allow')], [200, [['allow', 'gemini'], ['allow', 'claude']]]);
    ({ r, seen } = await recap({ denyGemini: { ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' } }));
    assert.deepStrictEqual([r.status, seen], [200, [['allow', 'gemini'], ['allow', 'claude'], ['record', 'claude']]]);
    const before = await modelCalls();
    for (const code of ['burst-minute', 'burst-day']) {
      ({ r, seen } = await sharpen({ denyGemini: { ok: false, status: 429, code, message: 'Lots of people are using AI right now - try again in a minute.' } }));
      assert.deepStrictEqual([r.status, r.data.code, seen], [429, code, [['allow', 'gemini']]]);
    }
    await settle();
    assert.strictEqual(await modelCalls(), before, 'a burst: no Claude call');
    // Record or snap has no Claude path: its own friendly error.
    const x = mk(thrown);
    r = await onGemini(() => maya('POST', `/api/meetings/${MT.next}/minutes`, { audio: { type: 'audio/wav', data: wav() } }), x.g);
    assert.deepStrictEqual([r.status, r.data.error, x.seen.filter((y) => y[0] === 'allow')], [502, 'Could not read that right now. Nothing was saved - try again in a minute, or log the items by hand.', [['allow', 'gemini']]]);
  } finally { console.log = quietLog; console.error = quietErr; }
  assert.deepStrictEqual(lines.filter((l) => /gemini failed/.test(l)), ['[receipt] gemini failed (http); used claude', '[receipt] gemini failed (http); used claude', '[receipt] gemini failed (unusable); used claude', '[receipt] gemini failed (monthly-cap); used claude']);
});

test('claude-first: the sharpener and the recap run on Claude, Gemini answers when Claude throws, is unusable or capped - not a burst; Record or snap is on', async () => {
  const lines = [];
  const quietLog = console.log; const quietErr = console.error;
  console.log = (m) => lines.push(String(m)); console.error = () => {};
  const mk = (o = {}) => {
    const seen = [];
    return { seen, g: {
      allow: async (a) => { seen.push(['allow', a.provider]); return (a.provider === 'claude' && o.denyClaude) || { ok: true }; },
      record: async (r) => { seen.push(['record', r.provider]); return true; },
      priceUsd: () => 0.001,
      // Gemini reads a copy with the stand-in's failure words defused.
      gemini: { generate: async (r) => { seen.push(['generate']); return { json: await r.fake({ contents: JSON.parse(JSON.stringify(r.contents).replace(/UPSTREAM/g, 'UP-STREAM').replace(/EMPTY/g, 'E-MPTY')), generationConfig: { responseSchema: r.responseSchema } }), usage: { inputTokens: 100, outputTokens: 10 } }; } },
    } };
  };
  const cf = async (fn, g) => { process.env.RECEIPT_AI_PROVIDER = 'claude-first'; global.LAB_AI_GUARD = g; try { return await fn(); } finally { delete process.env.RECEIPT_AI_PROVIDER; delete global.LAB_AI_GUARD; } };
  const sharpen = (o) => { const x = mk(o); return cf(async () => ({ r: await maya('POST', `/api/meetings/${MT.next}/sharpen`, {}), seen: x.seen }), x.g); };
  const recap = (notes, o) => { const x = mk(o); return cf(async () => ({ r: await maya('POST', `/api/meetings/${MT.next}/recap`, { notes }), seen: x.seen }), x.g); };
  try {
    const me = await cf(() => maya('GET', '/api/me'), mk().g);
    assert.deepStrictEqual([me.data.ai.provider, me.data.ai.minutes], ['claude-first', true]);
    // Claude answers when it can.
    let { r, seen } = await sharpen();
    assert.deepStrictEqual([r.status, seen], [200, [['allow', 'claude'], ['record', 'claude']]]);
    // Claude throws: Gemini answers 200.
    ({ r, seen } = await recap('Sam will book the room. UPSTREAM500'));
    assert.deepStrictEqual([r.status, Array.isArray(r.data.actions), seen], [200, true, [['allow', 'claude'], ['allow', 'gemini'], ['generate'], ['record', 'gemini']]], JSON.stringify(r.data));
    assert.ok(!JSON.stringify(r.data).includes('fake_upstream'));
    // Claude unusable: Gemini (the Claude call that billed is still recorded).
    ({ r, seen } = await recap('EMPTY. Sam will book the room.'));
    assert.deepStrictEqual([r.status, seen], [200, [['allow', 'claude'], ['record', 'claude'], ['allow', 'gemini'], ['generate'], ['record', 'gemini']]], JSON.stringify(r.data));
    // Claude's monthly cap: Gemini.
    ({ r, seen } = await sharpen({ denyClaude: { ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' } }));
    assert.deepStrictEqual([r.status, r.data.proposal.items.length >= 2, seen], [200, true, [['allow', 'claude'], ['allow', 'gemini'], ['generate'], ['record', 'gemini']]]);
    // A burst refusal goes out as it is.
    const before = await modelCalls();
    for (const code of ['burst-minute', 'burst-day']) {
      ({ r, seen } = await sharpen({ denyClaude: { ok: false, status: 429, code, message: 'Lots of people are using AI right now - try again in a minute.' } }));
      assert.deepStrictEqual([r.status, r.data.code, seen], [429, code, [['allow', 'claude']]]);
    }
    await settle();
    assert.strictEqual(await modelCalls(), before, 'a burst: no Gemini call, nobody charged');
    // Record or snap (Gemini only) is on.
    const x = mk();
    r = await cf(() => maya('POST', `/api/meetings/${MT.next}/minutes`, { audio: { type: 'audio/wav', data: wav() } }), x.g);
    assert.deepStrictEqual([r.status, x.seen], [200, [['allow', 'gemini'], ['generate'], ['record', 'gemini']]], JSON.stringify(r.data));
  } finally { console.log = quietLog; console.error = quietErr; }
  assert.deepStrictEqual(lines.filter((l) => /claude failed/.test(l)), ['[receipt] claude failed (500); used gemini', '[receipt] claude failed (unusable); used gemini', '[receipt] claude failed (monthly-cap); used gemini']);
});

test('out of credit: 402 before any model call, while everything else stays free', async () => {
  await identityStore.merge('users', uidOf('maya@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  for (const [p, body] of [[`/api/meetings/${MT.next}/sharpen`, {}], [`/api/meetings/${MT.next}/recap`, { notes: 'Sam will book the room.', image: { type: 'image/jpeg', data: JPEG } }]]) {
    const r = await maya('POST', p, body);
    assert.strictEqual(r.status, 402, p);
    assert.ok('topUpUrl' in r.data);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call was made');
  const m = await maya('POST', '/api/meetings', { title: 'Broke but busy', people: [{ band: 'ic', count: 3 }], agenda: [{ title: 'Only item', minutes: 10 }] });
  assert.strictEqual(m.status, 200, 'meetings are free');
  const id = m.data.meeting.id;
  for (const verb of ['start', 'pause', 'resume', 'next', 'end']) assert.strictEqual((await maya('POST', `/api/meetings/${id}/${verb}`)).status, 200, verb);
  assert.strictEqual((await maya('POST', `/api/meetings/${id}/log`, { kind: 'decision', text: 'Free decisions' })).status, 200);
  assert.strictEqual((await client()('GET', `/api/room/${m.data.meeting.code}`)).status, 200);
  assert.strictEqual((await maya('GET', `/api/meetings/${id}/receipt`)).status, 200);
  assert.strictEqual((await maya('POST', `/api/meetings/${id}/share`)).status, 200);
  assert.strictEqual((await maya('GET', '/api/recurring')).status, 200);
  assert.strictEqual((await maya('GET', '/api/scoreboard')).status, 200);
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  await identityStore.merge('users', uidOf('maya@example.com'), { spentUsd: 0 });
  await maya('DELETE', `/api/meetings/${id}`);
});

test('the audit: add, rank, Keep / Shrink / Kill, and the saved-per-year total', async () => {
  const add = (b) => maya('POST', '/api/recurring', b);
  assert.strictEqual((await add({ title: 'x' })).status, 400);
  for (const [title, minutes, cadence, [e, m, i]] of AUDIT) {
    const r = await add({ title, minutes, cadence, people: [{ band: 'exec', count: e }, { band: 'manager', count: m }, { band: 'ic', count: i }] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  }
  let a = await maya('GET', '/api/recurring');
  assert.deepStrictEqual([a.data.rows[0].title, a.data.rows[0].annual, a.data.savedPerYear, a.data.undecided], ['Weekly all-hands', 38400, 0, 6]);
  const byTitle = (t) => a.data.rows.find((r) => r.title === t);
  assert.deepStrictEqual(byTitle('Weekly Marketing Sync').suggestion, { minutes: 25, cadence: 'fortnightly', drop: [] });
  a = await maya('PUT', `/api/recurring/${byTitle('Friday pipeline review').id}`, { decision: 'kill' });
  assert.strictEqual(a.data.savedPerYear, 16200);
  a = await maya('PUT', `/api/recurring/${byTitle('Weekly Marketing Sync').id}`, { decision: 'shrink', shrink: { minutes: 25, cadence: 'fortnightly', drop: ['exec'] } });
  const sync = byTitle('Weekly Marketing Sync');
  assert.strictEqual(Math.round(sync.saved), Math.round(27360 - (560 * 25 / 60) * 24), 'shorter, half as often, and the exec gets the recap');
  a = await maya('PUT', `/api/recurring/${byTitle('Daily stand-up').id}`, { decision: 'keep' });
  assert.deepStrictEqual([a.data.killed, a.data.shrunk, a.data.kept, a.data.undecided], [1, 1, 1, 3]);
  assert.strictEqual(Math.round(a.data.savedPerYear), Math.round(16200 + sync.saved));
  a = await maya('PUT', `/api/recurring/${byTitle('Daily stand-up').id}`, { decision: null });
  assert.strictEqual(a.data.kept, 0, 'a decision can be undone');
  assert.strictEqual((await maya('PUT', `/api/recurring/${byTitle('Design crit').id}`, { decision: 'maybe' })).status, 400);
  const del = await maya('DELETE', `/api/recurring/${byTitle('Design crit').id}`);
  assert.strictEqual(del.data.rows.length, 5);
});

test('the scoreboard and loose ends: the next occurrence brings back last week’s open actions, with their heat', async () => {
  const s = await maya('GET', '/api/scoreboard');
  assert.strictEqual(s.status, 200);
  const sb = s.data.scoreboard;
  assert.ok(sb.meetings >= 1 && sb.badges.includes('first') && sb.badges.includes('killed'), JSON.stringify(sb.badges));
  assert.ok(sb.givenBackMs >= 22 * MIN);
  assert.ok(s.data.openActions.some((a) => a.text === 'Book the webinar' && a.heat.state === 'warm' && a.meetingTitle === 'Weekly Marketing Sync'));
  assert.ok(!s.data.openActions.some((a) => a.text === 'Send the brief'), 'done actions are not loose');
  assert.deepStrictEqual([sb.actions.open, sb.actions.done], [1, 1]);
  const next = await maya('POST', '/api/meetings', { repeatOf: MT.id });
  assert.strictEqual(next.status, 200, JSON.stringify(next.data));
  const nm = next.data.meeting;
  assert.deepStrictEqual([nm.title, nm.agenda.length, nm.labels.length, nm.seriesKey, nm.status, nm.bingo], ['Weekly Marketing Sync', 5, 7, MT.id, 'waiting', true], 'same room, same series, a fresh clock');
  assert.notStrictEqual(nm.code, MT.code);
  const g = await maya('GET', `/api/meetings/${nm.id}`);
  assert.deepStrictEqual(g.data.looseEnds.map((l) => [l.text, l.owner, l.meetingId]), [['Book the webinar', 'Sam', MT.id]]);
  // Tick it done from the next meeting, and it is no longer loose.
  await maya('PUT', `/api/meetings/${MT.id}/log/${g.data.looseEnds[0].id}`, { done: true });
  assert.deepStrictEqual((await maya('GET', `/api/meetings/${nm.id}`)).data.looseEnds, []);
  const third = await maya('POST', '/api/meetings', { repeatOf: nm.id, title: 'Weekly Marketing Sync (moved)' });
  assert.strictEqual(third.data.meeting.seriesKey, MT.id, 'a series keeps its first meeting’s key');
  await maya('DELETE', `/api/meetings/${third.data.meeting.id}`);
  MT.repeat = nm.id;
});

test('strangers get 404 on every meeting and audit route, before any model call or big body', async () => {
  eve = await register('eve@example.com');
  const calls = await modelCalls();
  const lid = MT.brief;
  const rid = (await store.list(`recurring/${uidOf('maya@example.com')}/items`))[0].id;
  for (const [m, p, b] of [['GET', `/api/meetings/${MT.id}`], ['PUT', `/api/meetings/${MT.id}`, { title: 'Mine now' }], ['DELETE', `/api/meetings/${MT.id}`],
    ['POST', `/api/meetings/${MT.id}/start`], ['POST', `/api/meetings/${MT.id}/end`], ['POST', `/api/meetings/${MT.id}/code`], ['POST', `/api/meetings/${MT.id}/log`, { kind: 'decision', text: 'Mine' }],
    ['PUT', `/api/meetings/${MT.id}/log/${lid}`, { done: false }], ['DELETE', `/api/meetings/${MT.id}/log/${lid}`], ['GET', `/api/meetings/${MT.id}/pulse`],
    ['GET', `/api/meetings/${MT.id}/receipt`], ['POST', `/api/meetings/${MT.id}/share`], ['DELETE', `/api/meetings/${MT.id}/share`],
    ['POST', `/api/meetings/${MT.next}/sharpen`, {}], ['POST', `/api/meetings/${MT.next}/recap`, { notes: 'Sam will do it.' }],
    ['PUT', `/api/recurring/${rid}`, { decision: 'kill' }], ['DELETE', `/api/recurring/${rid}`], ['GET', '/api/meetings/nope-nope'],
    ['POST', '/api/meetings', { repeatOf: MT.id }]]) {
    const r = await eve(m, p, b);
    assert.strictEqual(r.status, 404, `${m} ${p} -> ${r.status}`);
  }
  // A stranger's 5 MB upload is refused by ownership before it is parsed.
  const big = await eve('POST', `/api/meetings/${MT.next}/recap`, { image: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } });
  assert.strictEqual(big.status, 404);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'a stranger costs nothing');
  assert.deepStrictEqual((await eve('GET', '/api/meetings')).data.meetings, []);
  assert.deepStrictEqual((await eve('GET', '/api/recurring')).data.rows, []);
  assert.strictEqual((await eve('GET', '/api/scoreboard')).data.scoreboard.meetings, 0);
});

test('caps: meetings, the log, the audit and the room', async () => {
  const uid = uidOf('eve@example.com');
  const m = await eve('POST', '/api/meetings', { title: 'Eve sync', people: [{ band: 'ic', count: 2 }] });
  const id = m.data.meeting.id;
  for (let i = 0; i < M.LIMITS.log; i++) await store.set(`meetings/${uid}/items/${id}/log`, `fill${i}`, { kind: 'parking', text: 'x', at: 0 });
  assert.strictEqual((await eve('POST', `/api/meetings/${id}/log`, { kind: 'decision', text: 'One more' })).status, 409);
  await store.merge(`meetings/${uid}/items`, id, { voterN: M.LIMITS.voters });
  await eve('POST', `/api/meetings/${id}/start`);
  const full = await client()('POST', `/api/room/${m.data.meeting.code}/vote`, { roti: 3 });
  assert.deepStrictEqual([full.status, /full/.test(full.data.error)], [409, true]);
  for (let i = 0; i < M.LIMITS.recurring; i++) await store.set(`recurring/${uid}/items`, `rfill${i}`, { title: 'x', minutes: 30, cadence: 'weekly', people: [{ band: 'ic', rate: 85, count: 1 }], createdAt: iso(T0) });
  assert.strictEqual((await eve('POST', '/api/recurring', { title: 'One too many', minutes: 30, people: [{ band: 'ic', count: 1 }] })).status, 409);
  for (let i = 0; i < M.LIMITS.meetings; i++) await store.set(`meetings/${uid}/items`, `mfill${i}`, { title: 'x', createdAt: iso(T0), people: [] });
  assert.strictEqual((await eve('POST', '/api/meetings', { title: 'One too many', people: [{ band: 'ic', count: 1 }] })).status, 409);
});

test('deleting a meeting takes its log, votes, room code and share link with it', async () => {
  const uid = uidOf('maya@example.com');
  const raw = await store.get(`meetings/${uid}/items`, MT.id);
  assert.ok((await store.list(`meetings/${uid}/items/${MT.id}/votes`)).length > 0);
  assert.strictEqual((await maya('DELETE', `/api/meetings/${MT.id}`)).status, 200);
  assert.strictEqual((await maya('GET', `/api/meetings/${MT.id}`)).status, 404);
  assert.deepStrictEqual(await store.list(`meetings/${uid}/items/${MT.id}/log`), []);
  assert.deepStrictEqual(await store.list(`meetings/${uid}/items/${MT.id}/votes`), []);
  assert.strictEqual(await store.get('codes', raw.code), null);
  assert.strictEqual(await store.get('shares', MT.token), null);
  assert.strictEqual((await client()('GET', `/api/shared/${MT.token}`)).status, 404);
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use('/receipt', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/receipt`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
void demo;
