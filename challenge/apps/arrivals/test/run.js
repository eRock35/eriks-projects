// The rules first (time zones, days, what a trip is, the one door, the
// board, who needs a ride, clashes, runs that could be one, a driver's runs,
// the day's plan, the example's planted story, the storage module), then
// the look, the page's promises and the copy, then end to end against the
// memory store:
//   ARRIVALS_MEMORY=1 ARRIVALS_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /arrivals, the
// way the lab mounts it, so the key cookie's path, the parsers' order and
// the limiters run as deployed. Every name here is made up; phone numbers
// are built from pieces so no file carries one.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.ARRIVALS_MEMORY !== '1' || process.env.ARRIVALS_FAKE_AI !== '1') {
  console.error('run with ARRIVALS_MEMORY=1 ARRIVALS_FAKE_AI=1');
  process.exit(1);
}

const { app, store, identityStore, misses, fakeClient, MODELS } = require('../server');
const C = require('../public/arrivals-core');
const D = require('../public/demo');
const S = require('../public/arrivals-store');
const G = require('../lib/gatherings');
const ai = require('../lib/ai');
const photo = require('../lib/photo');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
const ch = (n) => String.fromCharCode(n);
const RLO = ch(0x202E), ZW = ch(0x200B), FW_AT = ch(0xFF20);
const PHONE = ['555', '201', '3344'].join(' ');
const CHI = 'America/Chicago';
const utc = (s) => Date.parse(s);
const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';
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

/* A gathering built by hand for the rules: Wed 25 - Sun 29 Nov 2026 in
 * Chicago, three members (host Rosa, Sam, Mei). */
const GATH = { from: '2026-11-25', to: '2026-11-29', tz: CHI };
const NOON = C.zonedToUtc('2026-11-25T12:00', CHI);
function gathering(trips) {
  const doc = {
    id: 'gathering0000001', code: 'ABCDEF', title: 'Thanksgiving', place: 'Mom’s house', ...GATH, v: 1,
    members: {
      mrosa111: { name: 'Rosa', c: 0, host: true, keyHash: 'k1', owner: 'o1', joinedAt: '2026-11-20T10:00:00.000Z' },
      msam2222: { name: 'Sam', c: 1, keyHash: 'k2', joinedAt: '2026-11-20T11:00:00.000Z' },
      mmei3333: { name: 'Mei', c: 2, keyHash: 'k3', joinedAt: '2026-11-20T12:00:00.000Z' },
    },
    trips: {},
  };
  (trips || []).forEach((t, i) => {
    const id = 'ttest' + String(i).padStart(3, '0');
    const out = C.cleanTrip({ mode: 'flight', who: 'P' + ch(65 + i), ...t }, doc, null);
    if (t.status) out.status = t.status;
    if (t.delay) out.delay = t.delay;
    if (t.driver) out.ride = { k: 'driver', mid: t.driver };
    out.by = 'mrosa111'; out.ts = NOON;
    doc.trips[id] = out;
  });
  return doc;
}
const vw = (doc, mid) => C.view(doc, mid || 'msam2222');
const at = (hm, day) => `${day || '2026-11-25'}T${hm}`;
const kinds = (v, now) => C.issues(v, now === undefined ? NOON : now).map((i) => i.kind);

/* ================================================================== *
 * The rules
 * ================================================================== */

test('time zones: a wall-clock time and its zone name one instant - Chicago in winter and summer, the coasts three hours apart, half- and quarter-hour zones, no-DST Phoenix, both sides of the date line; back again in any zone', () => {
  assert.strictEqual(iso(C.zonedToUtc('2026-11-25T15:10', CHI)), '2026-11-25T21:10Z', 'CST is UTC-6');
  assert.strictEqual(iso(C.zonedToUtc('2026-07-04T15:10', CHI)), '2026-07-04T20:10Z', 'CDT is UTC-5');
  assert.strictEqual(C.zonedToUtc('2026-11-25T12:00', 'America/Los_Angeles'), C.zonedToUtc('2026-11-25T15:00', 'America/New_York'), 'noon Pacific is 3 PM Eastern');
  assert.strictEqual(iso(C.zonedToUtc('2026-11-25T09:00', 'Asia/Kolkata')), '2026-11-25T03:30Z');
  assert.strictEqual(iso(C.zonedToUtc('2026-11-25T09:00', 'Asia/Kathmandu')), '2026-11-25T03:15Z');
  assert.strictEqual(iso(C.zonedToUtc('2026-07-04T12:00', 'America/Phoenix')), '2026-07-04T19:00Z');
  assert.strictEqual(iso(C.zonedToUtc('2026-01-04T12:00', 'America/Phoenix')), '2026-01-04T19:00Z', 'Phoenix never moves');
  assert.strictEqual(iso(C.zonedToUtc('2026-11-26T08:00', 'Pacific/Kiritimati')), '2026-11-25T18:00Z', 'UTC+14: already tomorrow');
  assert.strictEqual(iso(C.zonedToUtc('2026-11-25T08:00', 'Pacific/Honolulu')), '2026-11-25T18:00Z', 'UTC-10: the same instant, a day earlier on the calendar');
  assert.strictEqual(iso(C.zonedToUtc('2026-01-15T10:00', 'Australia/Sydney')), '2026-01-14T23:00Z', 'southern summer, UTC+11');
  assert.strictEqual(iso(C.zonedToUtc('2026-07-15T10:00', 'Australia/Sydney')), '2026-07-15T00:00Z');
  assert.strictEqual(iso(C.zonedToUtc('2026-12-31T23:30', 'America/New_York')), '2027-01-01T04:30Z', 'across the year');
  // Back again: every zone and time round-trips.
  for (const tz of C.COMMON_ZONES.concat(['Asia/Kathmandu', 'Pacific/Kiritimati', 'Pacific/Chatham', 'America/St_Johns', 'UTC'])) {
    assert.ok(C.isZone(tz), tz);
    for (const local of ['2026-01-01T00:00', '2026-03-15T12:34', '2026-06-30T23:59', '2026-11-25T15:10', '2028-02-29T06:05']) {
      const ms = C.zonedToUtc(local, tz);
      assert.strictEqual(C.zoneLocal(ms, tz), local, `${tz} ${local}`);
      assert.strictEqual(ms % 60000, 0);
    }
  }
  // One instant read in other zones: the board's zone, not the phone's.
  const landed = C.zonedToUtc('2026-11-25T22:30', 'America/Los_Angeles');
  assert.strictEqual(C.zoneLocal(landed, CHI), '2026-11-26T00:30', 'a late flight on the coast is tomorrow at Mom’s');
  assert.strictEqual(C.zoneDay(landed, CHI), '2026-11-26');
  assert.strictEqual(C.clockAt(landed, 'Europe/London'), '6:30 AM');
  assert.deepStrictEqual([C.offsetMin(landed, CHI), C.offsetMin(landed, 'Asia/Kolkata'), C.offsetMin(utc('2026-07-01T00:00Z'), CHI)], [-360, 330, -300]);
  assert.deepStrictEqual([C.zoneAbbr(landed, CHI), C.zoneAbbr(utc('2026-07-01T00:00Z'), CHI), C.zoneCity('America/Los_Angeles')], ['CST', 'CDT', 'Los Angeles']);
  assert.deepStrictEqual(['00:05', '09:00', '12:00', '12:30', '13:07', '23:59'].map(C.clock), ['12:05 AM', '9:00 AM', '12:00 PM', '12:30 PM', '1:07 PM', '11:59 PM']);
});

test('time zones at the edges: the hour that never happens moves forward by the gap, the hour that happens twice is the first one - north and south of the equator; junk is refused, never guessed', () => {
  // US spring forward, 8 Mar 2026: 02:00 -> 03:00 in Chicago.
  assert.strictEqual(iso(C.zonedToUtc('2026-03-08T01:59', CHI)), '2026-03-08T07:59Z');
  assert.strictEqual(iso(C.zonedToUtc('2026-03-08T02:30', CHI)), '2026-03-08T08:30Z', '2:30 never happened: read as 3:30 CDT');
  assert.strictEqual(C.zoneLocal(C.zonedToUtc('2026-03-08T02:30', CHI), CHI), '2026-03-08T03:30');
  assert.strictEqual(iso(C.zonedToUtc('2026-03-08T03:00', CHI)), '2026-03-08T08:00Z');
  // US fall back, 1 Nov 2026: 01:30 happens twice.
  assert.strictEqual(iso(C.zonedToUtc('2026-11-01T01:30', CHI)), '2026-11-01T06:30Z', 'the first 1:30, still CDT');
  assert.strictEqual(iso(C.zonedToUtc('2026-11-01T00:59', CHI)), '2026-11-01T05:59Z');
  assert.strictEqual(iso(C.zonedToUtc('2026-11-01T02:00', CHI)), '2026-11-01T08:00Z', 'after the repeat, CST');
  // Sydney: forward 4 Oct 2026 (02:00 -> 03:00), back 5 Apr 2026 (03:00 -> 02:00).
  assert.strictEqual(iso(C.zonedToUtc('2026-10-04T02:30', 'Australia/Sydney')), '2026-10-03T16:30Z', 'read as 3:30 AEDT');
  assert.strictEqual(iso(C.zonedToUtc('2026-04-05T02:30', 'Australia/Sydney')), '2026-04-04T15:30Z', 'the first 2:30, still AEDT');
  // London, 29 Mar 2026: 01:30 never happens.
  assert.strictEqual(iso(C.zonedToUtc('2026-03-29T01:30', 'Europe/London')), '2026-03-29T01:30Z');
  for (const bad of ['', 'tomorrow', '2026-11-25', '2026-11-25 15:10', '2026-13-01T10:00', '2026-02-30T10:00', '2026-11-25T24:00', '2026-11-25T10:60', '2026-11-25T15:10:00', null, 5, {}]) {
    assert.strictEqual(C.zonedToUtc(bad, CHI), null, String(bad));
    assert.strictEqual(C.isLocal(bad), false);
  }
  for (const bad of ['', 'Mars/Olympus', 'Chicago', 'America/Chicago; DROP', '../etc', '<x>', 'a'.repeat(60), null, 7, 'constructor', '__proto__']) {
    assert.strictEqual(C.isZone(bad), false, String(bad));
    assert.strictEqual(C.zonedToUtc('2026-11-25T15:10', bad), null);
  }
});

test('days: calendar dates checked strictly; labels say Today, Tomorrow, Yesterday or the weekday; a range reads "Nov 25 - 29" or across a month', () => {
  assert.deepStrictEqual(['2026-11-25', '2026-02-29', '2028-02-29', '2026-11-31', '26-11-25', '2026-11-25T00:00', 20261125].map(C.isDay), [true, false, true, false, false, false, false]);
  assert.deepStrictEqual([C.addDays('2026-11-29', 3), C.addDays('2026-03-01', -1), C.daysBetween('2026-11-25', '2026-12-02'), C.weekday('2026-11-26')], ['2026-12-02', '2026-02-28', 7, 'Thursday']);
  assert.deepStrictEqual(['2026-11-25', '2026-11-26', '2026-11-24', '2026-11-28'].map((d) => C.dayLabel(d, '2026-11-25')), ['Today', 'Tomorrow', 'Yesterday', 'Saturday, Nov 28']);
  assert.deepStrictEqual([C.dateRange('2026-11-25', '2026-11-29'), C.dateRange('2026-11-29', '2026-12-02'), C.dateRange('2026-11-25', '2026-11-25')], ['Nov 25 - 29', 'Nov 29 - Dec 2', 'Nov 25']);
});

test('a gathering’s details: a place, dates in order, at most 30 days, from this week to about a year out, a real time zone; nothing personal in the name', () => {
  const ok = C.cleanGathering({ place: ' Mom’s  house ', from: '2026-11-25', to: '2026-11-29', tz: CHI }, '2026-11-25');
  assert.deepStrictEqual(ok, { title: 'Mom’s house', place: 'Mom’s house', from: '2026-11-25', to: '2026-11-29', tz: CHI });
  assert.strictEqual(C.cleanGathering({ place: 'The lake', title: 'Reunion', from: '2026-11-25', tz: CHI }, '2026-11-25').to, '2026-11-25', 'one day by default');
  const bad = (b, re) => assert.throws(() => C.cleanGathering({ place: 'Mom’s', from: '2026-11-25', to: '2026-11-29', tz: CHI, ...b }, '2026-11-25'), (e) => e.status === 400 && e.expose && re.test(e.message), JSON.stringify(b));
  bad({ place: '' }, /where everyone is headed/); bad({ from: 'soon' }, /first day/); bad({ to: '2026-11-20' }, /before the first/);
  bad({ to: '2026-12-31' }, /up to 30 days/); bad({ from: '2026-11-01', to: '2026-11-02' }, /this week/); bad({ from: '2028-01-01', to: '2028-01-02' }, /a year ahead/);
  bad({ tz: 'Mars/Olympus' }, /time zone/); bad({ tz: undefined }, /time zone/);
  bad({ place: `mom${AT}example.com` }, /No email/); bad({ title: `Call ${PHONE}` }, /No phone numbers/); bad({ title: 'see www.example.com' }, /No links/); bad({ place: `mom${FW_AT}home` }, /No email/);
});

test('a trip: the instant is worked out from the wall-clock time and its zone (a sent one is ignored); the zone defaults to the gathering’s; a drive has no carrier, airport or pickup; the day must be near the dates; nothing personal in any field', () => {
  const g = gathering();
  const t = C.cleanTrip({ who: ' Ana + the kids ', mode: 'flight', from: 'Denver', carrier: 'UA', number: 'ua-1482!', hub: 'ORD', local: at('15:10'), party: 3, bags: 2, seat: true, note: 'Door 3', at: 12345, status: 'here', delay: 99, ride: { k: 'driver', mid: 'mrosa111' } }, g, null);
  assert.deepStrictEqual(t, { dir: 'in', who: 'Ana + the kids', mode: 'flight', from: 'Denver', carrier: 'UA', number: 'UA1482', hub: 'ORD', local: at('15:10'), tz: CHI, at: utc('2026-11-25T21:10Z'), party: 3, bags: 2, seat: true, note: 'Door 3', status: 'sched', delay: 0, ride: { k: 'none' } });
  // The same wall-clock time typed in another zone is another instant.
  const la = C.cleanTrip({ who: 'Ben', mode: 'flight', local: at('15:10'), tz: 'America/Los_Angeles' }, g, null);
  assert.strictEqual(la.at - t.at, 2 * 3600000);
  assert.strictEqual(la.tz, 'America/Los_Angeles');
  const car = C.cleanTrip({ who: 'Priya', mode: 'car', from: 'Minneapolis', carrier: 'x', number: '9', hub: 'ORD', local: at('18:30'), own: true }, g, null);
  assert.deepStrictEqual([car.carrier, car.number, car.hub, car.ride], ['', '', '', { k: 'self' }]);
  assert.deepStrictEqual(C.cleanTrip({ who: 'Mei', mode: 'train', local: at('09:00'), own: true }, g, null).ride, { k: 'own' });
  assert.deepStrictEqual(C.cleanTrip({ dir: 'out', who: 'Mei', mode: 'bus', local: at('09:00', '2026-11-29'), party: 99, bags: -1 }, g, null), { dir: 'out', who: 'Mei', mode: 'bus', from: '', carrier: '', number: '', hub: '', local: '2026-11-29T09:00', tz: CHI, at: utc('2026-11-29T15:00Z'), party: 1, bags: 0, seat: false, note: '', status: 'sched', delay: 0, ride: { k: 'none' } });
  const bad = (b, re) => assert.throws(() => C.cleanTrip({ who: 'Ana', mode: 'flight', local: at('15:10'), ...b }, g, null), (e) => e.status === 400 && e.expose && re.test(e.message), JSON.stringify(b));
  bad({ who: '' }, /who is travelling/); bad({ who: '12' }, /who is travelling/); bad({ mode: 'rocket' }, /how they are travelling/); bad({ mode: 'constructor' }, /how/);
  bad({ local: '3pm' }, /day and the time/); bad({ local: undefined }, /day and the time/); bad({ tz: 'Mars/Olympus' }, /time zone/);
  bad({ local: '2026-11-17T10:00' }, /more than a week outside/); bad({ local: '2026-12-07T10:00' }, /more than a week outside/);
  assert.ok(C.cleanTrip({ who: 'Early', mode: 'flight', local: '2026-11-18T10:00' }, g, null), 'a week early is fine');
  for (const f of ['who', 'from', 'carrier', 'hub', 'note']) {
    bad({ [f]: `write ana${AT}example.com` }, /No email/); bad({ [f]: `ring ${PHONE}` }, /No phone numbers/); bad({ [f]: 'https://example.com/x' }, /No links/); bad({ [f]: 'a <b>c' }, /No markup/);
  }
  bad({ number: '12345678' }, /No phone numbers|long numbers/);
  assert.strictEqual(C.cleanTrip({ who: `A${RLO}n${ZW}a`, mode: 'flight', local: at('15:10') }, g, null).who, 'Ana', 'invisible characters go');
  assert.strictEqual(Array.from(C.cleanTrip({ who: 'x'.repeat(300), mode: 'flight', local: at('15:10'), note: 'y'.repeat(500) }, g, null).note).length, 140);
  // Editing keeps where they are, how late, and who is driving.
  const prev = { ...t, status: 'way', delay: 40, ride: { k: 'driver', mid: 'msam2222' } };
  const ed = C.cleanTrip({ who: 'Ana', mode: 'flight', hub: 'MDW', local: at('16:00') }, g, prev);
  assert.deepStrictEqual([ed.status, ed.delay, ed.ride, ed.hub], ['way', 40, { k: 'driver', mid: 'msam2222' }, 'MDW']);
  assert.deepStrictEqual(C.cleanTrip({ who: 'Ana', mode: 'car', local: at('16:00') }, g, { ...prev, status: 'landed' }).status, 'sched', 'a drive has no "landed"');
});

test('where they are: an arrival goes scheduled, on the way, landed, here (a drive skips landed); a trip home scheduled, left; a delay shows until they land; the next step is one tap', () => {
  const t = { dir: 'in', mode: 'flight', status: 'sched', delay: 0, at: NOON };
  assert.deepStrictEqual([C.statuses(t), C.statuses({ dir: 'in', mode: 'car' }), C.statuses({ dir: 'out', mode: 'flight' })], [['sched', 'way', 'landed', 'here'], ['sched', 'way', 'here'], ['sched', 'left']]);
  assert.deepStrictEqual([C.stateOf(t), C.stateLabel(t), C.nextStep(t)], ['sched', 'Scheduled', { status: 'way', label: 'On the way' }]);
  assert.deepStrictEqual([C.stateLabel({ ...t, delay: 40 }), C.stateLabel({ ...t, delay: 60 }), C.stateLabel({ ...t, delay: 95 }), C.stateLabel({ ...t, delay: 120 })], ['Delayed 40 min', 'Delayed 1 hour', 'Delayed 1 h 35 min', 'Delayed 2 hours']);
  assert.strictEqual(C.stateOf({ ...t, status: 'way', delay: 20 }), 'delayed');
  assert.deepStrictEqual([C.stateOf({ ...t, status: 'landed', delay: 20 }), C.stateLabel({ ...t, status: 'landed' }), C.stateLabel({ ...t, mode: 'train', status: 'landed' }), C.nextStep({ ...t, status: 'landed' })], ['landed', 'Landed', 'At the station', { status: 'here', label: 'Here' }]);
  assert.deepStrictEqual([C.nextStep({ ...t, status: 'way' }).label, C.nextStep({ ...t, mode: 'bus', status: 'way' }).label, C.nextStep({ ...t, mode: 'car', status: 'way' }).label, C.nextStep({ ...t, status: 'here' }), C.nextStep({ dir: 'out', mode: 'flight', status: 'sched' }).label], ['Landed', 'Arrived', 'Here', null, 'Left']);
  assert.strictEqual(C.expected({ at: NOON, delay: 40 }) - NOON, 40 * 60000);
  // When to be there for a trip home: 90 minutes before a flight, 30 before a train or bus.
  assert.deepStrictEqual([NOON - C.meetAt({ dir: 'out', mode: 'flight', at: NOON, delay: 0 }), NOON - C.meetAt({ dir: 'out', mode: 'train', at: NOON, delay: 0 }), NOON - C.meetAt({ dir: 'in', mode: 'flight', at: NOON, delay: 0 })], [90 * 60000, 30 * 60000, 0]);
});

test('the one door: add, edit, remove, a status, a delay (added by taps, or set), who is driving (one or several at once), the details (the host only) - each naming only the keys it changes; anything else refused', () => {
  let doc = gathering();
  const ctx = (id) => ({ now: NOON, id: id || 'tnew00001', today: '2026-11-25' });
  const add = C.act(doc, 'msam2222', { t: 'add', trip: { who: 'Ana', mode: 'flight', hub: 'ORD', local: at('15:10') } }, ctx());
  assert.deepStrictEqual([Object.keys(add.set), add.del], [['trips.tnew00001'], []]);
  assert.deepStrictEqual([add.set['trips.tnew00001'].by, add.set['trips.tnew00001'].ts, add.set['trips.tnew00001'].at], ['msam2222', NOON, utc('2026-11-25T21:10Z')]);
  const before = JSON.stringify(doc);
  doc = C.patch(doc, add);
  assert.strictEqual(JSON.stringify(gathering()), before, 'nothing changes in place');
  assert.strictEqual(doc.v, 2);
  const run = (mid, a) => { doc = C.patch(doc, C.act(doc, mid, a, ctx('tnew00002'))); return doc.trips.tnew00001; };
  assert.deepStrictEqual(Object.keys(C.act(doc, 'mmei3333', { t: 'status', id: 'tnew00001', status: 'way' }, ctx()).set), ['trips.tnew00001.status', 'trips.tnew00001.ts'], 'a status is its own key');
  assert.strictEqual(run('mmei3333', { t: 'status', id: 'tnew00001', status: 'way' }).status, 'way', 'anyone in the family may say so');
  assert.throws(() => C.act(doc, 'msam2222', { t: 'status', id: 'tnew00001', status: 'left' }, ctx()), /isn’t a step/);
  assert.strictEqual(run('msam2222', { t: 'delay', id: 'tnew00001', add: 20 }).delay, 20);
  assert.strictEqual(run('mrosa111', { t: 'delay', id: 'tnew00001', add: 20 }).delay, 40, 'two taps of +20 make +40');
  assert.strictEqual(run('mrosa111', { t: 'delay', id: 'tnew00001', add: -100 }).delay, 0, 'never before time');
  assert.strictEqual(run('mrosa111', { t: 'delay', id: 'tnew00001', add: 700 }).delay, 700);
  assert.strictEqual(run('mrosa111', { t: 'delay', id: 'tnew00001', add: 700 }).delay, 720, 'twelve hours at most');
  assert.strictEqual(run('mrosa111', { t: 'delay', id: 'tnew00001', set: 0 }).delay, 0);
  for (const a of [{ add: 1.5 }, { add: 'lots' }, { set: -5 }, { set: 9999 }, {}]) assert.throws(() => C.act(doc, 'msam2222', { t: 'delay', id: 'tnew00001', ...a }, ctx()), /whole minutes/);
  assert.deepStrictEqual(run('msam2222', { t: 'ride', id: 'tnew00001', k: 'driver' }).ride, { k: 'driver', mid: 'msam2222' }, 'claiming is me by default');
  assert.deepStrictEqual(run('mrosa111', { t: 'ride', id: 'tnew00001', k: 'driver', mid: 'mmei3333' }).ride, { k: 'driver', mid: 'mmei3333' });
  assert.throws(() => C.act(doc, 'msam2222', { t: 'ride', id: 'tnew00001', k: 'driver', mid: 'mnobody99' }, ctx()), /isn’t in this gathering/);
  assert.throws(() => C.act(doc, 'msam2222', { t: 'ride', id: 'tnew00001', k: 'driver', mid: 'constructor' }, ctx()), /isn’t in this gathering/);
  assert.deepStrictEqual(run('msam2222', { t: 'ride', id: 'tnew00001', k: 'own' }).ride, { k: 'own' });
  assert.deepStrictEqual(run('msam2222', { t: 'ride', id: 'tnew00001', k: 'anything' }).ride, { k: 'none' });
  // Several at once (one run), and a drive can never be given a driver.
  doc = C.patch(doc, C.act(doc, 'msam2222', { t: 'add', trip: { who: 'Ben', mode: 'flight', hub: 'ORD', local: at('15:35') } }, ctx('tnew00003')));
  doc = C.patch(doc, C.act(doc, 'msam2222', { t: 'add', trip: { who: 'Priya', mode: 'car', local: at('18:00') } }, ctx('tnew00004')));
  const both = C.act(doc, 'msam2222', { t: 'ride', ids: ['tnew00001', 'tnew00003'], k: 'driver' }, ctx());
  assert.deepStrictEqual(Object.keys(both.set), ['trips.tnew00001.ride', 'trips.tnew00001.ts', 'trips.tnew00003.ride', 'trips.tnew00003.ts']);
  assert.throws(() => C.act(doc, 'msam2222', { t: 'ride', ids: ['tnew00001', 'tnew00004'], k: 'driver' }, ctx()), /is driving - no ride needed/);
  assert.throws(() => C.act(doc, 'msam2222', { t: 'ride', ids: [], k: 'driver' }, ctx()), /Pick a trip/);
  // Edit keeps the author and the state; a driver who is gone is dropped.
  doc = C.patch(doc, both);
  doc.members.msam2222.left = true;
  const ed = C.act(doc, 'mmei3333', { t: 'edit', id: 'tnew00001', trip: { who: 'Ana + Leo', mode: 'flight', hub: 'MDW', local: at('16:00') } }, ctx()).set['trips.tnew00001'];
  assert.deepStrictEqual([ed.by, ed.who, ed.status, ed.ride], ['msam2222', 'Ana + Leo', 'way', { k: 'none' }]);
  assert.deepStrictEqual(C.act(doc, 'mmei3333', { t: 'del', id: 'tnew00003' }, ctx()), { set: {}, del: ['trips.tnew00003'] });
  for (const id of ['tgone0001', 'constructor', '__proto__', '', null, 5]) assert.throws(() => C.act(doc, 'mmei3333', { t: 'del', id }, ctx()), (e) => e.status === 404 && e.code === 'no-trip');
  // The details: the host only.
  assert.throws(() => C.act(doc, 'mmei3333', { t: 'details', place: 'Elsewhere', from: '2026-11-25', to: '2026-11-29', tz: CHI }, ctx()), (e) => e.status === 403 && e.code === 'not-host');
  assert.deepStrictEqual(C.act(doc, 'mrosa111', { t: 'details', place: 'The lake', title: 'Reunion', from: '2026-11-24', to: '2026-11-30', tz: 'America/Denver' }, ctx()).set, { title: 'Reunion', place: 'The lake', from: '2026-11-24', to: '2026-11-30', tz: 'America/Denver' });
  for (const a of [null, 5, [], {}, { t: 'drop' }, { t: 'constructor' }, { t: ['add'] }]) assert.throws(() => C.act(doc, 'mrosa111', a, ctx()), (e) => e.status === 400);
  // 120 trips, then refused - never cut.
  let full = gathering();
  for (let i = 0; i < C.LIMITS.trips; i++) full.trips['tfull' + String(i).padStart(4, '0')] = { dir: 'in' };
  assert.throws(() => C.act(full, 'mrosa111', { t: 'add', trip: { who: 'One more', mode: 'flight', local: at('15:10') } }, ctx()), (e) => e.status === 409 && e.code === 'full');
});

test('the board: every trip by its expected time, grouped by the day it is AT THE GATHERING whatever zone it was typed in; a delay moves it (even past midnight) and keeps the old time; what it read where it was typed; "due" when past its time with no update; the counts', () => {
  const doc = gathering([
    { who: 'Leo', hub: 'MDW', local: at('11:05'), status: 'here', party: 2 },
    { who: 'Ana', hub: 'ORD', local: at('15:10'), status: 'way', party: 3 },
    { who: 'Ben', hub: 'ORD', local: at('13:35'), tz: 'America/Los_Angeles' },         // 3:35 PM at Mom's
    { who: 'Kai', hub: 'ORD', local: at('22:30'), tz: 'America/Los_Angeles' },         // 12:30 AM Thursday at Mom's
    { who: 'Mei', hub: 'ORD', local: at('23:40'), delay: 40, driver: 'msam2222' },     // 12:20 AM Thursday once late
    { who: 'Priya', mode: 'car', local: at('18:30') },
    { dir: 'out', who: 'Ben', hub: 'ORD', local: at('17:10', '2026-11-29') },
  ]);
  const b = C.board(vw(doc), NOON + 3600000);
  assert.strictEqual(b.today, '2026-11-25');
  assert.strictEqual(b.zone, 'Chicago time (CST)');
  assert.deepStrictEqual(b.days.map((d) => [d.day, d.label, d.rows.map((r) => r.t.who + ' ' + r.clock)]), [
    ['2026-11-25', 'Today', ['Leo 11:05 AM', 'Ana 3:10 PM', 'Ben 3:35 PM', 'Priya 6:30 PM']],
    ['2026-11-26', 'Tomorrow', ['Mei 12:20 AM', 'Kai 12:30 AM']],
  ]);
  assert.deepStrictEqual(b.out.map((d) => [d.label, d.rows.map((r) => r.t.who + ' ' + r.clock)]), [['Sunday, Nov 29', ['Ben 5:10 PM']]]);
  const row = (who) => b.days.concat(b.out).flatMap((d) => d.rows).find((r) => r.t.who === who && r.t.dir === 'in');
  assert.deepStrictEqual([row('Mei').was, row('Mei').state, row('Mei').label, row('Ana').was], ['11:40 PM', 'delayed', 'Delayed 40 min', '']);
  assert.deepStrictEqual([row('Ben').there, row('Kai').there, row('Ana').there], ['1:35 PM PST', '10:30 PM PST', '']);
  assert.deepStrictEqual([row('Leo').ride.text, row('Ana').ride.text, row('Mei').ride.text, row('Priya').ride.text], ['No ride noted', 'Needs a ride', 'You’re picking up', 'Driving']);
  assert.strictEqual(C.board(vw(doc, 'mrosa111'), NOON).days[1].rows[0].ride.text, 'Sam is picking up');
  assert.deepStrictEqual(b.counts, { coming: 9, here: 2, delayed: 1, noRide: 4 });
  // Due: 20 minutes past with nobody saying anything; never once landed or here.
  assert.deepStrictEqual(b.days[0].rows.map((r) => r.due), [false, false, false, false]);
  const later = C.board(vw(doc), C.zonedToUtc(at('15:31'), CHI));
  assert.deepStrictEqual(later.days[0].rows.map((r) => r.due), [false, true, false, false], 'Ana, 21 minutes past; Leo is here');
  // A trip typed in a zone with the same offset as the gathering's says nothing extra.
  const same = gathering([{ who: 'Tom', local: at('10:00'), tz: 'America/Mexico_City' }]);
  assert.strictEqual(C.board(vw(same), NOON).days[0].rows[0].there, '');
  // The phone's own zone never enters: the same view gives the same board.
  assert.deepStrictEqual(C.board(vw(doc), NOON), C.board(JSON.parse(JSON.stringify(vw(doc))), NOON));
});

test('who needs a ride: an arrival by air, rail or bus with nobody down to drive - not a drive, not someone making their own way, not someone already here, not a driver who left, not a ride six hours past', () => {
  const doc = gathering([
    { who: 'Ana', hub: 'ORD', local: at('15:10') },
    { who: 'Ben', hub: 'ORD', local: at('15:20'), driver: 'msam2222' },
    { who: 'Priya', mode: 'car', local: at('15:30') },
    { who: 'Mei', hub: 'ORD', local: at('15:25'), own: true },
    { who: 'Leo', hub: 'ORD', local: at('11:00'), status: 'here' },
    { dir: 'out', who: 'Kai', hub: 'ORD', local: at('16:40') },
    { dir: 'out', who: 'Gone', hub: 'ORD', local: at('13:00'), status: 'left' },
  ]);
  const v = vw(doc);
  assert.deepStrictEqual(C.issues(v, NOON).filter((i) => i.kind === 'noride').map((i) => i.a.who), ['Ana', 'Kai']);
  assert.strictEqual(C.issueText(v, C.issues(v, NOON)[0]), 'Ana needs a ride from ORD - 3:10 PM.');
  assert.strictEqual(C.issueText(v, C.issues(v, NOON)[1]), 'Kai needs a lift to ORD - there by 3:10 PM.', 'be there 90 minutes before the flight');
  doc.members.msam2222.left = true;
  assert.deepStrictEqual(C.issues(vw(doc, 'mrosa111'), NOON).map((i) => i.a.who), ['Ana', 'Kai', 'Ben'], 'the driver left: Ben needs a ride again');
  delete doc.members.msam2222;
  assert.strictEqual(C.board(vw(doc, 'mrosa111'), NOON).counts.noRide, 3, 'the driver was removed: the same');
  assert.deepStrictEqual(kinds(vw(doc, 'mrosa111'), C.zonedToUtc(at('21:11'), CHI)), ['noride'], 'six hours and a minute after 3:10: Ana and Kai no longer raise a flag');
  assert.deepStrictEqual(kinds(vw(doc, 'mrosa111'), C.zonedToUtc(at('21:21'), CHI)), [], 'and then none do');
});

test('clashes: ONE driver due at two different places less than 90 minutes apart is a clash - at 90 it is not, at the same place it never is, with two drivers it never is; a delay can make or clear one', () => {
  const two = (b, extra) => gathering([{ who: 'Ana', hub: 'ORD', local: at('15:00'), driver: 'msam2222' }, { who: 'Joe', mode: 'train', hub: 'Union Station', local: at('15:30'), driver: 'msam2222', ...b }].concat(extra || []));
  let v = vw(two());
  assert.deepStrictEqual(C.issues(v, NOON).map((i) => [i.kind, i.a.who, i.b.who, i.driver, i.gap]), [['clash', 'Ana', 'Joe', 'msam2222', 30]]);
  assert.strictEqual(C.issueText(v, C.issues(v, NOON)[0]), 'You are down for Ana at ORD (3:00 PM) and Joe at Union Station (3:30 PM) - 30 minutes apart, two different places.');
  assert.strictEqual(C.issueText(vw(two(), 'mrosa111'), C.issues(vw(two(), 'mrosa111'), NOON)[0]).slice(0, 15), 'Sam is down for');
  assert.deepStrictEqual(kinds(vw(two({ local: at('16:29') }))), ['clash'], '89 minutes');
  assert.deepStrictEqual(kinds(vw(two({ local: at('16:30') }))), [], '90 minutes is enough');
  assert.deepStrictEqual(kinds(vw(two({ local: at('13:31') }))), ['clash'], 'either order');
  assert.deepStrictEqual(kinds(vw(two({ local: at('15:00') }))), ['clash']);
  assert.match(C.issueText(vw(two({ local: at('15:00') })), C.issues(vw(two({ local: at('15:00') })), NOON)[0]), /at the same time, two different places/);
  assert.deepStrictEqual(kinds(vw(two({ hub: 'ORD', mode: 'flight' }))), [], 'the same place is one run, not a clash');
  assert.deepStrictEqual(kinds(vw(two({ driver: 'mmei3333' }))), [], 'two drivers: fine');
  assert.deepStrictEqual(kinds(vw(two({ status: 'here' }))), [], 'already here');
  assert.deepStrictEqual(kinds(vw(two({ hub: '' }))), [], 'no place given: nothing to compare');
  // A delay makes one, and clears one.
  assert.deepStrictEqual(kinds(vw(two({ local: at('17:00') }))), []);
  const late = two({ local: at('17:00') }); late.trips.ttest000.delay = 60;
  assert.deepStrictEqual(kinds(vw(late)), ['clash'], 'Ana an hour late lands an hour before Joe');
  const clear = two(); clear.trips.ttest001.delay = 60;
  assert.deepStrictEqual(kinds(vw(clear)), [], 'Joe an hour late: 90 minutes apart now');
  // A pickup and a trip home: the drop-off counts from when to be there.
  const mix = gathering([{ who: 'Ana', hub: 'MDW', local: at('15:00'), driver: 'msam2222' }, { dir: 'out', who: 'Kai', hub: 'ORD', local: at('16:40'), driver: 'msam2222' }]);
  assert.deepStrictEqual(C.issues(vw(mix), NOON).map((i) => [i.kind, i.gap]), [['clash', 10]], 'at ORD by 3:10, at MDW at 3:00');
});

test('two places in one hour: rides at different places within 60 minutes with a driver missing take two drivers - said once per pair of places, the closest pair; 61 minutes apart, or two drivers down, and nothing is said', () => {
  const base = (b, c) => gathering([{ who: 'Ana', hub: 'ORD', local: at('15:00') }, { who: 'Joe', mode: 'train', hub: 'Union Station', local: at('15:25'), ...b }].concat(c || []));
  let v = vw(base());
  assert.deepStrictEqual(C.issues(v, NOON).map((i) => i.kind), ['twoplaces', 'noride', 'noride']);
  assert.strictEqual(C.issueText(v, C.issues(v, NOON)[0]), 'Ana at ORD (3:00 PM) and Joe at Union Station (3:25 PM) are 25 minutes apart at different places - that takes two drivers.');
  assert.deepStrictEqual(kinds(vw(base({ driver: 'msam2222' }))), ['twoplaces', 'noride'], 'one driver down: still needs a second');
  assert.deepStrictEqual(kinds(vw(base({ local: at('16:00') }))), ['twoplaces', 'noride', 'noride'], '60 minutes');
  assert.deepStrictEqual(kinds(vw(base({ local: at('16:01') }))), ['noride', 'noride'], '61 is not');
  const covered = base({ driver: 'msam2222' }); covered.trips.ttest000.ride = { k: 'driver', mid: 'mmei3333' };
  assert.deepStrictEqual(kinds(vw(covered)), [], 'two drivers, two places: sorted');
  // Three at the airport and one at the station is one thing to sort out.
  v = vw(base({}, [{ who: 'Ben', hub: 'ORD', local: at('15:20') }, { who: 'Kai', hub: 'O’Hare (ORD)', local: at('15:40') }]));
  const tp = C.issues(v, NOON).filter((i) => i.kind === 'twoplaces');
  assert.deepStrictEqual(tp.map((i) => [i.a.who, i.b.who, i.gap]), [['Ben', 'Joe', 5]], 'the closest pair, once');
  // Three places: one line per pair of places.
  v = vw(base({}, [{ who: 'Leo', hub: 'MDW', local: at('15:10') }]));
  assert.strictEqual(C.issues(v, NOON).filter((i) => i.kind === 'twoplaces').length, 3);
  // Worst first.
  const all = gathering([{ who: 'Ana', hub: 'ORD', local: at('15:00'), driver: 'msam2222' }, { who: 'Joe', hub: 'MDW', local: at('15:30'), driver: 'msam2222' }, { who: 'Leo', mode: 'train', hub: 'Union Station', local: at('15:45') }]);
  assert.deepStrictEqual(kinds(vw(all)), ['clash', 'twoplaces', 'twoplaces', 'noride']);
});

test('the same place: "ORD", "ord", "O’Hare (ORD)" and "ORD Terminal 3" are one airport; a station by its words; no place is no place', () => {
  assert.deepStrictEqual(['ORD', 'ord', ' Ord ', 'O’Hare (ORD)', 'Chicago O’Hare (ord)', 'ORD Terminal 3', 'Terminal 5, ORD', 'ORD/T1'].map(C.hubKey), Array(8).fill('ORD'));
  assert.deepStrictEqual(['Union Station', 'union station', 'The Union  Station', 'Union Stn'].map(C.hubKey), ['union', 'union', 'union', 'union stn']);
  assert.notStrictEqual(C.hubKey('MDW'), C.hubKey('ORD'));
  assert.deepStrictEqual([C.hubKey(''), C.hubKey(null), C.hubKey('<b>')], ['', '', '']);
  assert.strictEqual(C.hubKey('Downtown bus station'), 'downtown');
});

test('runs that could be one: rides at the same place within 45 minutes of the first - 46 is two runs; already with one driver is nothing to suggest; the suggestion names the one driver already down; a pickup and a drop-off can share a run; never across places or days', () => {
  const g2 = (b, more) => gathering([{ who: 'Ana', hub: 'ORD', local: at('15:10'), party: 3 }, { who: 'Ben', hub: 'O’Hare (ORD)', local: at('15:35'), ...b }].concat(more || []));
  let v = vw(g2());
  let c = C.combos(v, NOON);
  assert.deepStrictEqual(c.map((x) => [x.hub, x.trips.map((t) => t.who), x.people, x.span, x.driver]), [['ORD', ['Ana', 'Ben'], 4, 25, null]]);
  assert.strictEqual(C.comboText(v, c[0]), 'Ana (3:10 PM) and Ben (3:35 PM) are both at ORD within 25 minutes - one run could get both (4 people).');
  assert.strictEqual(C.combos(vw(g2({ local: at('15:55') })), NOON).length, 1, '45 minutes');
  assert.strictEqual(C.combos(vw(g2({ local: at('15:56') })), NOON).length, 0, '46 is two runs');
  assert.strictEqual(C.combos(vw(g2({ driver: 'mmei3333' })), NOON)[0].driver, 'mmei3333', 'Mei is already going: she could take both');
  const one = g2({ driver: 'mmei3333' }); one.trips.ttest000.ride = { k: 'driver', mid: 'mmei3333' };
  assert.deepStrictEqual(C.combos(vw(one), NOON), [], 'already one run');
  const split = g2({ driver: 'mmei3333' }); split.trips.ttest000.ride = { k: 'driver', mid: 'msam2222' };
  assert.deepStrictEqual(C.combos(vw(split), NOON).map((x) => x.driver), [null], 'two drivers to one place: worth saying, nobody named');
  assert.deepStrictEqual(C.combos(vw(g2({ hub: 'MDW' })), NOON), [], 'different places');
  assert.deepStrictEqual(C.combos(vw(g2({ local: at('15:35', '2026-11-26') })), NOON), [], 'different days');
  assert.deepStrictEqual(C.combos(vw(g2({ own: true })), NOON), [], 'making their own way');
  assert.deepStrictEqual(C.combos(vw(g2({ hub: '' }, [{ who: 'Kai', hub: '', local: at('15:40') }])), NOON), [], 'no place given is never "the same place"');
  // Greedy from the first: 3:10, 3:35, 3:50 are one run; 4:00 starts the next.
  v = vw(g2({}, [{ who: 'Kai', hub: 'ORD', local: at('15:50') }, { who: 'Leo', hub: 'ORD', local: at('16:00') }, { who: 'Mia', hub: 'ORD', local: at('16:30') }]));
  c = C.combos(v, NOON);
  assert.deepStrictEqual(c.map((x) => x.trips.map((t) => t.who)), [['Ana', 'Ben', 'Kai'], ['Leo', 'Mia']]);
  assert.match(C.comboText(v, c[0]), /are all at ORD within 40 minutes - one run could get everyone \(5 people\)/);
  // A delay moves a ride out of a run - and into one.
  const d = g2(); d.trips.ttest001.delay = 30;
  assert.deepStrictEqual(C.combos(vw(d), NOON), [], 'Ben is now 55 minutes after Ana');
  // A drop-off (be there 90 minutes before a 5:05 flight = 3:35) and a pickup at 3:10.
  v = vw(gathering([{ who: 'Ana', hub: 'ORD', local: at('15:10') }, { dir: 'out', who: 'Kai', hub: 'ORD', local: at('17:05') }]));
  assert.deepStrictEqual(C.combos(v, NOON).map((x) => [x.trips.map((t) => t.dir + ' ' + t.who), x.span]), [[['in Ana', 'out Kai'], 25]]);
});

test('a driver’s runs: their rides in order, rides at one place within 45 minutes as one run with the people, bags and car seat added up; finished rides gone; everyone who is driving, in member order', () => {
  const doc = gathering([
    { who: 'Ana', hub: 'ORD', local: at('15:10'), party: 3, bags: 2, seat: true, driver: 'msam2222' },
    { who: 'Ben', hub: 'ORD', local: at('15:35'), bags: 1, driver: 'msam2222' },
    { who: 'Joe', mode: 'train', hub: 'Union Station', local: at('19:00'), driver: 'msam2222' },
    { who: 'Leo', hub: 'MDW', local: at('11:00'), status: 'here', driver: 'msam2222' },
    { who: 'Mei', hub: 'ORD', local: at('09:15', '2026-11-26'), driver: 'mrosa111' },
    { dir: 'out', who: 'Ben', hub: 'ORD', local: at('17:10', '2026-11-29'), driver: 'msam2222' },
    { who: 'Kai', hub: 'ORD', local: at('15:20') },
  ]);
  const r = C.runs(vw(doc), 'msam2222', NOON);
  assert.deepStrictEqual(r.map((x) => [x.day, x.clock, x.hub, x.trips.map((t) => t.who), x.people, x.bags, x.seat]), [
    ['2026-11-25', '3:10 PM - 3:35 PM', 'ORD', ['Ana', 'Ben'], 4, 3, true],
    ['2026-11-25', '7:00 PM', 'Union Station', ['Joe'], 1, 0, false],
    ['2026-11-29', '3:40 PM', 'ORD', ['Ben'], 1, 0, false],
  ]);
  assert.deepStrictEqual(C.drivers(vw(doc), NOON).map((d) => [d.m.name, d.runs.length]), [['Rosa', 1], ['Sam', 3]]);
  assert.deepStrictEqual(C.runs(vw(doc), 'mmei3333', NOON), []);
});

test('what a phone is shown: names, colours and trips - never a key hash or an account tag; members in join order; whether a trip is mine; the day it is kept until. Kept 14 days past the last day or the latest trip, then gone', () => {
  const doc = gathering([{ who: 'Ana', hub: 'ORD', local: at('15:10') }]);
  doc.trips.ttest000.by = 'msam2222';
  const v = C.view(doc, 'msam2222');
  assert.ok(!/keyHash|owner|k1|k2|o1|"by"|"ts"/.test(JSON.stringify(v)));
  assert.deepStrictEqual(v.members, [{ id: 'mrosa111', name: 'Rosa', c: 0, host: true, left: false, me: false }, { id: 'msam2222', name: 'Sam', c: 1, host: false, left: false, me: true }, { id: 'mmei3333', name: 'Mei', c: 2, host: false, left: false, me: false }]);
  assert.deepStrictEqual([v.me, v.host, v.trips[0].mine, C.view(doc, 'mrosa111').host, C.view(doc, 'mrosa111').trips[0].mine, v.keptUntil], ['msam2222', false, true, true, false, '2026-12-13']);
  assert.deepStrictEqual([C.lastDay(doc), C.expired(doc, '2026-12-13'), C.expired(doc, '2026-12-14')], ['2026-11-29', false, true]);
  doc.trips.tlate0001 = { local: '2026-12-03T10:00' };
  assert.deepStrictEqual([C.lastDay(doc), C.expired(doc, '2026-12-17'), C.expired(doc, '2026-12-18')], ['2026-12-03', false, true], 'someone staying on keeps it alive');
});

test('the day’s plan in words: every arrival and departure that day in the gathering’s zone, who is driving, what is still open - rules, the same every time', () => {
  const v = C.view(D.doc(), D.ME);
  const wed = C.briefing(v, '2026-11-25', D.NOW);
  assert.strictEqual(wed, [
    'Thanksgiving at Mom’s - Wednesday, Nov 25, Chicago time (CST)',
    '11:05 AM  Uncle Leo lands at MDW - WN 918 from Phoenix - Rosa picked them up (1 bag).',
    '3:10 PM  Ana + the kids lands at ORD - UA 1482 from Denver - needs a ride (3 people, 2 bags, car seat).',
    '3:25 PM  Grandpa Joe pulls in at Union Station - Amtrak 302 from St. Louis - needs a ride (1 bag).',
    '3:35 PM  Ben lands at ORD - DL 2210 from Atlanta - you’re picking up (1 bag).',
    '6:30 PM  Priya + Dev rolls in - Driving from Minneapolis - driving (2 people).',
    '',
    'Still open:',
    '- Grandpa Joe at Union Station (3:25 PM) and Ben at ORD (3:35 PM) are 10 minutes apart at different places - that takes two drivers.',
    '- Ana + the kids needs a ride from ORD - 3:10 PM.',
    '- Grandpa Joe needs a ride from Union Station - 3:25 PM.',
    '- Ana + the kids (3:10 PM) and Ben (3:35 PM) are both at ORD within 25 minutes - one run could get both (4 people).',
  ].join('\n'));
  assert.match(C.briefing(v, '2026-11-26', D.NOW), /9:55 AM {2}Mei lands at ORD - AA 2374 from Boston - delayed 40 min - making their own way\.$/);
  assert.match(C.briefing(v, '2026-11-27', D.NOW), /Nobody is arriving or leaving\.$/);
  assert.strictEqual(C.briefing(v, '2026-11-25', D.NOW), wed);
});

test('the example’s planted story: nine people coming and one here; Ana and Ben could be one run and Sam is already going; Grandpa Joe at the station takes a second driver; Mei is delayed and making her own way; the trips home pair up; changed by the same one door, never in place', () => {
  const doc = D.doc();
  const v = C.view(doc, D.ME);
  assert.deepStrictEqual(C.board(v, D.NOW).counts, { coming: 9, here: 1, delayed: 1, noRide: 4 });
  assert.deepStrictEqual(C.issues(v, D.NOW).map((i) => [i.kind, i.a.who]), [['twoplaces', 'Grandpa Joe'], ['noride', 'Ana + the kids'], ['noride', 'Grandpa Joe'], ['noride', 'Ana + the kids'], ['noride', 'Ben']]);
  const combos = C.combos(v, D.NOW);
  assert.deepStrictEqual(combos.map((c) => [c.trips.map((t) => t.dir + ' ' + t.who), c.driver]), [[['in Ana + the kids', 'in Ben'], D.ME], [['out Ana + the kids', 'out Ben'], null]]);
  assert.deepStrictEqual(C.runs(v, D.ME, D.NOW).map((r) => [r.clock, r.hub, r.people]), [['3:35 PM', 'ORD', 1]]);
  // "I'll take both", then Grandpa: the clash appears, as it would for a real driver.
  let d2 = C.patch(doc, C.act(doc, D.ME, { t: 'ride', ids: combos[0].trips.map((t) => t.id), k: 'driver' }, { now: D.NOW, id: 'tx000001', today: '2026-11-25' }));
  assert.deepStrictEqual(C.runs(C.view(d2, D.ME), D.ME, D.NOW).map((r) => [r.clock, r.people, r.seat]), [['3:10 PM - 3:35 PM', 4, true]]);
  d2 = C.patch(d2, C.act(d2, D.ME, { t: 'ride', id: 'tjoe4444a', k: 'driver' }, { now: D.NOW, id: 'tx000001', today: '2026-11-25' }));
  assert.deepStrictEqual(C.issues(C.view(d2, D.ME), D.NOW).filter((i) => i.kind === 'clash').length, 2, 'Sam cannot be at ORD and Union Station at once');
  assert.strictEqual(JSON.stringify(doc), JSON.stringify(D.doc()), 'the example never changes in place');
  for (const t of Object.values(doc.trips)) assert.strictEqual(C.refuse(t.who + t.from + t.note + t.hub), '');
  for (const f of ['public/arrivals-core.js', 'public/demo.js']) assert.ok(!/Date\.now|new Date\(\)|Math\.random|crypto\./.test(read(f)), `${f}: no clock or dice`);
});

test('text: first names letters only (any script); refused for an @ of any width, a link, seven digits in any script or markup; esc escapes all five; codes six characters with no I, O, 0 or 1, typed any way', () => {
  assert.deepStrictEqual(['  rosa ', 'José-María', 'O’Neil', 'Мария', 'R2D2', '1234', `<b>Sam</b>`, `Sa${ZW}m${RLO}`, 'x'.repeat(50)].map(C.cleanName), ['rosa', 'José-María', 'O’Neil', 'Мария', 'R D', '', 'Sam', 'Sam', 'x'.repeat(20)]);
  assert.deepStrictEqual(['Mom’s house', `a${AT}b.co`, `a${FW_AT}b`, 'http://x.y', 'www.x.y', PHONE, '١٢٣٤٥٦٧', 'UA 1482', 'Gate B12, door 3', 'a<b'].map((s) => Boolean(C.refuse(s))), [false, true, true, true, true, true, true, false, false, true]);
  assert.strictEqual(C.esc(`<a href="x" title='y'>&`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;');
  assert.deepStrictEqual([C.normalizeCode('abc-def'), C.normalizeCode(' a b c d e f '), C.formatCode('abcdef'), C.isCode('ABCDEF'), C.isCode('ABCDE0'), C.isCode('ABCDEFG'), C.isGid('a'.repeat(16)), C.isGid('a'.repeat(15))], ['ABCDEF', 'ABCDEF', 'ABC-DEF', true, false, false, true, false]);
  for (let i = 0; i < 200; i++) { const c = G.newCode(); assert.ok(C.isCode(c) && !/[IO01]/.test(c)); }
  assert.ok(C.isGid(G.newGid()) && /^[A-Za-z0-9_-]{22}$/.test(G.newKey()));
  assert.deepStrictEqual([C.initials('Ana + the kids'), C.initials('Rosa'), C.initials('Grandpa Joe')], ['AK', 'RO', 'GJ']);
});

test('storage: one module; the list and prefs cleaned on every read; a throwing or missing localStorage falls back to memory; nothing but ids, names and dates is kept', () => {
  const mem = {}; const ls = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const s = S.create(ls);
  assert.ok(s.persistent());
  s.putList([{ id: 'a'.repeat(16), title: 'T<b>', place: 'P', from: '2026-11-25', to: 'x', code: 'ABCDEF', key: 'secret' }, { id: 'bad' }, { id: 'a'.repeat(16), title: 'dup' }]);
  assert.deepStrictEqual(s.getList(), [{ id: 'a'.repeat(16), title: 'T', place: 'P', from: '2026-11-25', to: '' }]);
  assert.ok(!/secret|ABCDEF/.test(mem[S.KEYS.list]));
  s.putPrefs({ name: 'Sam<', cur: 'nope', tab: 'x', extra: 1 });
  assert.deepStrictEqual(s.getPrefs(), { name: 'Sam', cur: '', tab: 'board' });
  mem[S.KEYS.list] = '{not json';
  assert.deepStrictEqual(s.getList(), []);
  const broken = S.create({ getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); }, removeItem() {} });
  assert.strictEqual(broken.persistent(), false);
  broken.putPrefs({ name: 'Mei', cur: 'b'.repeat(16), tab: 'pickups' });
  assert.deepStrictEqual(broken.getPrefs(), { name: 'Mei', cur: 'b'.repeat(16), tab: 'pickups' });
  assert.strictEqual(S.create(null).persistent(), false);
  s.clearAll(); assert.deepStrictEqual(Object.keys(mem), []);
});

/* ================================================================== *
 * The look, the page, the copy
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes; the ten people’s colours hold white text; the lab card is 20+ in CIE Lab from every other card with white text at 4.5:1, its emoji on no other card, drop #71; 44px targets; no sideways scroll; motion only when asked for', () => {
  const css = read('public/app.css');
  const tokens = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));
  const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
  const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));
  const dark = tokens(darkBlock.slice(0, darkBlock.indexOf('}')));
  assert.deepStrictEqual(tokens(css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf(':root[data-theme="dark"]'))), dark, 'both dark blocks agree');
  assert.deepStrictEqual([light.bg, dark.bg], ['#ffffff', '#000000']);
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg) => assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const fg of ['text', 'muted', 'link']) for (const bg of ['bg', 'card2', 'sheet']) ok(fg, bg);
    ok('accent-ink', 'accent'); ok('link', 'accent-bg'); ok('bg', 'text'); ok('accent', 'bg');
    for (const k of ['good', 'warn', 'bad']) { ok(k, `${k}-bg`); ok(k, 'bg'); ok(k, 'sheet'); }
  }
  assert.strictEqual(C.COLORS.length, 10);
  C.COLORS.forEach((c, i) => { assert.ok(ratio('#ffffff', c) >= 4.5, `white on ${c}`); assert.ok(css.includes(`.c${i} { background: ${c}; }`), `colour ${i} in the CSS`); });
  const LAB = require('../../../lab');
  const lab = LAB.get('arrivals');
  assert.ok(lab, 'Arrivals is in lab.js');
  assert.deepStrictEqual([lab.color, lab.color2, lab.dropped, lab.status, lab.emoji, lab.audience], ['#8660d6', '#be44a8', '2026-11-25', 'testing', '\u{1F6EC}', 'Families and friends travelling to one place']);
  assert.strictEqual(lab.tagline, 'Who lands when, and who’s picking them up - the whole family’s arrival board on every phone.');
  assert.ok(ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  assert.ok(labDist(lab.color, lab.color2) >= 20);
  for (const other of LAB.APPS.filter((x) => x.slug !== 'arrivals')) {
    for (const c of [other.color, other.color2]) assert.ok(labDist(lab.color, c) >= 20 && labDist(lab.color2, c) >= 20, `away from ${other.slug} ${c}: ${labDist(lab.color, c).toFixed(1)} / ${labDist(lab.color2, c).toFixed(1)}`);
    assert.notStrictEqual(other.emoji, lab.emoji, `${other.slug} has the same emoji`);
  }
  assert.strictEqual(LAB.APPS.findIndex((x) => x.slug === 'arrivals') + 1, 71, 'drop #71');
  assert.strictEqual(lab.features.length, 4);
  assert.strictEqual(light.brand, lab.color, 'the brand dot is the card’s violet');
  for (const sel of ['.btn', '.btn.small', '.link-btn', '.input', '.tabbar button', '.seg button', '.check', '.lablink', '.brand']) assert.ok(new RegExp('\\n' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: (4[4-9]|[5-9]\\d)px').test(css), `${sel}: 44px`);
  assert.ok(/\.trow-main \{[^}]*min-height: 72px/.test(css) && /\.item \{[^}]*min-height: 56px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'), css.indexOf('@media print'));
  assert.ok(!/animation|transition/.test(css.replace(motion, '')), 'every animation and transition sits inside prefers-reduced-motion: no-preference');
  assert.ok(/-apple-system, BlinkMacSystemFont, system-ui/.test(css) && !/@font-face|url\(/.test(css), 'system fonts only, nothing bundled or fetched');
  assert.ok(!/(linear|radial|conic)-gradient/.test(css), 'no gradients');
});

test('the page: relative links, no inline script, handlers or style attributes, the banner; storage only through arrivals-store.js; one BASE-relative fetch and only the listed routes; polling only while visible and in a gathering; every received string escaped; no location, contacts or tracking', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(!/\sstyle\s*=/i.test(html), 'no style attribute');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(!/(src|href)="(\/|https?:)/.test(html.replace(/<!-- lab:og[\s\S]*?\/lab:og -->/, '')), 'relative asset links only');
  assert.ok(!/desktop\.css/.test(html) && /<body>/.test(html), 'the HOA look: no left rail');
  const js = read('public/app.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/style=|\.style\./.test(js), 'no style attribute written by script');
  assert.ok(!/\.on(click|submit|change|input|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(js), 'the page touches no storage itself');
  assert.match(js, /var BASE = new URL\('\.', document\.baseURI\)\.pathname;/);
  assert.match(js, /return fetch\(BASE \+ path, \{/);
  assert.strictEqual((js.match(/fetch\(/g) || []).length, 1, 'one fetch, through api()');
  const routes = new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[1] + ' ' + m[2]));
  assert.ok(routes.size >= 8);
  for (const r of routes) assert.ok(/^(GET api\/g\/|POST api\/g\/|POST api\/gatherings$|GET api\/join\/|POST api\/join\/|GET api\/me$|GET api\/mine$|POST api\/read$|POST api\/auth\/)/.test(r), r);
  assert.match(js, /function wantPoll\(\) \{ return Boolean\(state\.g && !state\.demo && document\.visibilityState === 'visible' && TABS\.indexOf\(state\.view\) >= 0\); \}/);
  assert.match(js, /if \(document\.visibilityState === 'visible'\) schedulePoll\(0\); else clearTimeout\(pollTimer\);/);
  assert.match(js, /t\.textContent = msg;/);
  const marked = js.split('\n').filter((l) => !/^\s*(else )?toast\(|\bsay\(|textContent = |confirm\(|var text = /.test(l)).join('\n');
  for (const field of ['.title', '.name', '.who', '.place', '.hub', '.from', '.note', '.carrier', '.number', 'err.message', 'g.code', 'p.by', 'p.dates', 'state.prefs.name', 'r.clock', 'r.label', 'r.ride.text', 'r.there']) {
    const re = new RegExp("'\\s*\\+\\s*[a-z.]*" + field.replace(/\./g, '\\.') + '\\s*\\+\\s*\'', 'g');
    assert.ok(!re.test(marked), `${field} concatenated into markup unescaped`);
  }
  assert.ok(!/geolocation|watchPosition|getUserMedia|contacts\.select|DeviceMotion|sendBeacon|capture=/i.test(js + html), 'no location, no contacts, no camera stream, no beacon');
  const raw = read('public/app.js');
  assert.ok(/accept="image\/\*"/.test(raw) && /c\.toDataURL\('image\/jpeg', 0\.85\)/.test(raw) && /1600 \/ Math\.max/.test(raw), 'a screenshot is shrunk on the phone before it is sent');
  assert.match(js, /if \(state\.demo\) \{\s*try \{[\s\S]{0,200}C\.patch\(state\.demo, C\.act\(state\.demo, D\.ME, action/, 'the example runs the same one door, in memory');
  // The join code travels in the fragment only.
  assert.match(js, /location\.origin \+ BASE \+ '#join=' \+ state\.g\.code/);
});

test('the copy: no email addresses, phone numbers or session links in any file; the shared files are the lab’s copies and listed for syncing; CLAUDE.md documents the time-zone rule, the 45/60/90-minute rules, the 14-day expiry and the AI gates', () => {
  const files = ['server.js', 'lib/gatherings.js', 'lib/store.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/photo.js', 'public/app.js', 'public/arrivals-core.js', 'public/demo.js', 'public/arrivals-store.js', 'public/index.html', 'public/app.css', 'CLAUDE.md', 'test/run.js'];
  for (const f of files) {
    const s = read(f);
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(s), `${f}: an email address`);
    assert.ok(!/\b\d{3}[ .-]\d{3}[ .-]\d{4}\b/.test(s), `${f}: a phone number`);
    assert.ok(!/claude\.ai\/code/.test(s), `${f}: a session link`);
    assert.ok(!/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/.test(s), `${f}: an invisible character`);
    assert.ok(!new RegExp(['sk', 'ant', ''].join('-') + '|AIza[0-9A-Za-z_-]{20}').test(s), `${f}: a key-shaped string`);
  }
  for (const f of ['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']) assert.strictEqual(read('lib/' + f), fs.readFileSync(path.join(ROOT, '..', 'trek', 'lib', f), 'utf8'), f);
  for (const f of ['passkey-client.js', 'verify-banner.js']) assert.strictEqual(read('public/' + f), fs.readFileSync(path.join(ROOT, '..', 'trek', 'public', f), 'utf8'), f);
  const sync = fs.readFileSync(path.join(ROOT, '..', '..', '..', 'scripts', 'sync-shared.js'), 'utf8');
  assert.ok(sync.includes("['eriks-projects/challenge/apps/arrivals/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']]") && sync.includes("['eriks-projects/challenge/apps/arrivals/public',['passkey-client.js', 'verify-banner.js']]"));
  const doc = read('CLAUDE.md');
  for (const s of ['zonedToUtc', '45 minutes', '60 minutes', '90 minutes', '14 days', 'requireBudget', 'LAB_AI_GUARD', 'No flight-status', 'arrivals_k', 'everyday']) assert.ok(doc.includes(s), s);
  assert.ok(JSON.parse(read('package.json')).scripts.test.startsWith('REQUIRE_VERIFIED_FOR_FREE_AI=0 '));
});

test('local-only switches throw on Cloud Run; the lab prefix is read; gatherings found by one field; the hashes are labelled and per gathering', () => {
  for (const [mod, env] of [['./lib/store', { ARRIVALS_MEMORY: '1' }], ['./server', { ARRIVALS_FAKE_AI: '1', ARRIVALS_MEMORY: '' }], ['./lib/fakeai', { ARRIVALS_FAKE_AI: '1', ARRIVALS_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, ARRIVALS_MEMORY: '', ARRIVALS_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, ARRIVALS_MEMORY: '', ARRIVALS_COLLECTION_PREFIX: 'arrivals_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'arrivals_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g))].sort(), ["store.get('gatherings'", "store.get('mine'", "store.list('gatherings'", "store.remove('gatherings'", "store.transact('gatherings'", "store.transact('mine'", "store.transactKeys('gatherings'"]);
  assert.ok([...server.matchAll(/where: \[(\[[^\]]*\])\]/g)].every((m) => m[1] === "['code', '==', c]" || m[1] === "['code', '==', code]"), 'single-field equality only: no composite index');
  assert.notStrictEqual(G.keyHash('k'.repeat(22), 'a'.repeat(16)), G.keyHash('k'.repeat(22), 'b'.repeat(16)), 'one phone, two gatherings, two hashes');
  assert.notStrictEqual(G.seatTag('uid', 'a'.repeat(16), 's'), G.seatTag('uid', 'b'.repeat(16), 's'));
  assert.notStrictEqual(G.ownerTag('uid', 's'), G.seatTag('uid', 'a'.repeat(16), 's'));
  assert.deepStrictEqual(MODELS, { free: ['claude', 'haiku', '4', '5'].join('-'), paid: ['claude', 'sonnet', '5'].join('-') });
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
async function register(who, c) {
  c = c || client();
  const r = await c('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const DAY = todayUtc();
const NEW = () => ({ name: 'Rosa', place: 'Mom’s house', title: 'Thanksgiving', from: DAY, to: C.addDays(DAY, 4), tz: CHI });
async function start(host, extra) {
  const r = await host('POST', '/api/gatherings', { ...NEW(), ...(extra || {}) });
  assert.strictEqual(r.status, 200, r.text);
  return { id: r.data.id, code: r.data.g.code, g: r.data.g };
}
async function family(n, extra) {
  const host = client();
  const g = await start(host, extra);
  const members = [];
  for (let i = 0; i < n; i++) {
    const c = client();
    const j = await c('POST', `/api/join/${g.code}`, { name: ['Sam', 'Mei', 'Ben', 'Ana', 'Leo'][i % 5] });
    assert.strictEqual(j.status, 200, j.text);
    members.push(c);
  }
  return { host, members, ...g };
}
const trip = (o) => ({ who: 'Ana', mode: 'flight', hub: 'ORD', local: `${DAY}T15:10`, ...(o || {}) });
const actOn = (c, id, action) => c('POST', `/api/g/${id}/act`, { action });
const settle = () => new Promise((r) => setTimeout(r, 15));
const HUGE = { x: 'x'.repeat(1.2 * 1024 * 1024) };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]).toString('base64');

test('signed out: the page and its files load; the CSP and no-referrer; the app shell for any page path; the account’s routes and the metered one answer 401 before reading a body', async () => {
  const anon = client();
  const page = await anon('GET', '/');
  assert.strictEqual(page.status, 200);
  assert.ok(page.text.includes('<main class="wrap" id="main"'));
  assert.strictEqual(page.headers.get('content-security-policy'), "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
  for (const f of ['app.js', 'app.css', 'arrivals-core.js', 'arrivals-store.js', 'demo.js', 'verify-banner.js', 'passkey-client.js', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await anon('GET', '/' + f)).status, 200, f);
  assert.ok((await anon('GET', '/some/deep/path')).text.includes('<main class="wrap"'));
  assert.deepStrictEqual((await anon('GET', '/api/me')).data, { signedIn: false });
  assert.deepStrictEqual((await anon('GET', '/api/health')).data, { ok: true, store: 'memory' });
  assert.strictEqual((await anon('GET', '/api/nope')).status, 404);
  assert.strictEqual((await anon('GET', '/api/mine')).status, 401);
  assert.strictEqual((await anon('POST', `/api/g/${'a'.repeat(16)}/keep`, {})).status, 401);
  const calls = fakeClient.calls.length;
  assert.strictEqual((await anon('POST', '/api/read', HUGE)).status, 401, 'a megabyte from a stranger is never parsed');
  assert.strictEqual(fakeClient.calls.length, calls);
  assert.strictEqual((await anon('GET', `/api/g/${'a'.repeat(16)}`)).headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('writes come from this page: another site’s request (Sec-Fetch-Site or Origin) is 403 and a body that is not JSON 415, before anything else', async () => {
  const c = client();
  assert.strictEqual((await c('POST', '/api/gatherings', NEW(), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await c('POST', '/api/gatherings', NEW(), { 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.strictEqual((await c('POST', '/api/gatherings', NEW(), { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await c('POST', '/api/gatherings', 'name=Rosa', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.strictEqual((await c('POST', '/api/gatherings', NEW(), { 'Sec-Fetch-Site': 'same-origin', Origin: base.replace(/\/arrivals$/, '') })).status, 200);
  assert.strictEqual((await c('POST', '/api/gatherings', '{bad', {})).status, 400);
  assert.strictEqual((await c('POST', '/api/gatherings', { x: 'x'.repeat(20000) })).status, 413);
});

test('a gathering: started with a first name, a place and dates and no account; joined with the code (any case, a dash) and a first name; the key an HttpOnly cookie on the app’s path, stored only as a per-gathering hash; a repeated name numbered; the preview shows no other name and no trip', async () => {
  const host = client();
  const r = await host('POST', '/api/gatherings', NEW());
  assert.strictEqual(r.status, 200, r.text);
  const { id, g } = r.data;
  assert.ok(C.isGid(id) && C.isCode(g.code));
  assert.deepStrictEqual([g.title, g.place, g.tz, g.host, g.members.map((m) => [m.name, m.host, m.me]), g.trips, g.keptUntil], ['Thanksgiving', 'Mom’s house', CHI, true, [['Rosa', true, true]], [], C.addDays(DAY, 18)]);
  assert.match(r.set[0], /^arrivals_k=[A-Za-z0-9_-]{22}; Path=\/arrivals\/; Max-Age=34560000; SameSite=Lax; HttpOnly$/);
  const stored = await store.get('gatherings', id);
  const key = host.cookies.arrivals_k;
  assert.strictEqual(Object.values(stored.members)[0].keyHash, G.keyHash(key, id));
  assert.ok(!JSON.stringify(stored).includes(key), 'the key itself is never stored');
  await actOn(host, id, { t: 'add', trip: trip({ who: 'Grandpa Joe' }) });
  const sam = client();
  const peek = await sam('GET', `/api/join/${g.code.toLowerCase().slice(0, 3)}-${g.code.toLowerCase().slice(3)}`);
  assert.deepStrictEqual(peek.data, { title: 'Thanksgiving', place: 'Mom’s house', dates: C.dateRange(DAY, C.addDays(DAY, 4)), by: 'Rosa', members: 1, full: false, already: null });
  assert.ok(!/Grandpa/.test(peek.text), 'no trip before joining');
  assert.strictEqual((await sam('GET', `/api/g/${id}`)).status, 404, 'knowing the id is not enough');
  assert.strictEqual((await sam('POST', `/api/join/${g.code}`, { name: '' })).status, 400);
  assert.strictEqual((await sam('POST', `/api/join/${g.code}`, { name: '12345' })).status, 400);
  const j = await sam('POST', `/api/join/${g.code}`, { name: 'Rosa' });
  assert.deepStrictEqual(j.data, { id, isNew: true });
  const seen = (await sam('GET', `/api/g/${id}`)).data.g;
  assert.deepStrictEqual(seen.members.map((m) => [m.name, m.me, m.c]), [['Rosa', false, 0], ['Rosa 2', true, 1]]);
  assert.deepStrictEqual([seen.host, seen.trips.map((t) => [t.who, t.mine])], [false, [['Grandpa Joe', false]]]);
  assert.deepStrictEqual((await sam('POST', `/api/join/${g.code}`, { name: 'Again' })).data, { id, isNew: false }, 'the same browser joins once');
  assert.strictEqual((await sam('GET', `/api/join/${g.code}`)).data.already, id);
  assert.strictEqual((await host('POST', '/api/gatherings', { ...NEW(), name: '' })).status, 400);
  assert.strictEqual((await host('POST', '/api/gatherings', { ...NEW(), place: `mom${AT}example.com` })).status, 400);
  assert.strictEqual((await host('POST', '/api/gatherings', { ...NEW(), tz: 'Mars/Olympus' })).status, 400);
  assert.strictEqual((await host('POST', '/api/gatherings', { ...NEW(), from: C.addDays(DAY, -30), to: C.addDays(DAY, -29) })).status, 400);
});

test('the board over HTTP: the instant is worked out on the server from the wall-clock time and its zone - a sent instant, status, delay or author is ignored; anyone in the family updates in one call; polling with ?since answers {same} until something moves', async () => {
  const f = await family(2);
  const [sam, mei] = f.members;
  const a = await actOn(sam, f.id, { t: 'add', trip: { ...trip({ local: `${DAY}T13:10`, tz: 'America/Los_Angeles', party: 3, seat: true }), at: 1, status: 'here', delay: 500, by: 'mrosa', ride: { k: 'driver', mid: 'x' } } });
  assert.strictEqual(a.status, 200, a.text);
  const t = a.data.g.trips[0];
  assert.ok(C.isId(a.data.id) && t.id === a.data.id);
  assert.deepStrictEqual([t.at, t.tz, t.status, t.delay, t.ride, t.mine, t.party, t.seat], [C.zonedToUtc(`${DAY}T13:10`, 'America/Los_Angeles'), 'America/Los_Angeles', 'sched', 0, { k: 'none' }, true, 3, true]);
  assert.strictEqual(C.clockAt(t.at, CHI), '3:10 PM', '1:10 on the coast is 3:10 at Mom’s');
  const v0 = a.data.g.v;
  assert.deepStrictEqual((await mei('GET', `/api/g/${f.id}?since=${v0}`)).data, { same: true, v: v0 });
  assert.strictEqual((await actOn(mei, f.id, { t: 'status', id: t.id, status: 'way' })).data.g.trips[0].status, 'way');
  assert.strictEqual((await actOn(f.host, f.id, { t: 'delay', id: t.id, add: 40 })).data.g.trips[0].delay, 40);
  const claimed = await actOn(mei, f.id, { t: 'ride', id: t.id, k: 'driver' });
  const meiId = claimed.data.g.me;
  assert.deepStrictEqual(claimed.data.g.trips[0].ride, { k: 'driver', mid: meiId });
  const polled = (await sam('GET', `/api/g/${f.id}?since=${v0}`)).data.g;
  assert.deepStrictEqual([polled.v, polled.trips[0].status, polled.trips[0].delay, polled.trips[0].mine], [v0 + 3, 'way', 40, true]);
  assert.strictEqual(C.board(polled, t.at).days[0].rows[0].ride.text, 'Mei is picking up');
  const ed = await actOn(mei, f.id, { t: 'edit', id: t.id, trip: trip({ who: 'Ana + Leo', hub: 'MDW', local: `${DAY}T16:00` }) });
  assert.deepStrictEqual([ed.data.g.trips[0].who, ed.data.g.trips[0].hub, ed.data.g.trips[0].status, ed.data.g.trips[0].delay, ed.data.g.trips[0].tz, ed.data.g.trips[0].mine], ['Ana + Leo', 'MDW', 'way', 40, CHI, false]);
  for (const bad of [{ t: 'add', trip: trip({ local: 'noon' }) }, { t: 'add', trip: trip({ who: `a${AT}b.co` }) }, { t: 'status', id: t.id, status: 'left' }, { t: 'nope' }, null, 'add']) assert.strictEqual((await actOn(sam, f.id, bad)).status, 400, JSON.stringify(bad));
  assert.strictEqual((await actOn(sam, f.id, { t: 'del', id: 'tnothere1' })).status, 404);
  assert.strictEqual((await actOn(sam, f.id, { t: 'details', place: 'X', from: DAY, to: DAY, tz: CHI })).status, 403);
  assert.strictEqual((await actOn(f.host, f.id, { t: 'details', place: 'The lake', title: 'Reunion', from: DAY, to: C.addDays(DAY, 2), tz: 'America/Denver' })).data.g.tz, 'America/Denver');
  assert.strictEqual((await actOn(sam, f.id, { t: 'del', id: t.id })).data.g.trips.length, 0);
  assert.strictEqual((await store.get('gatherings', f.id)).v, v0 + 6, 'only the changes that landed moved the version');
});

test('phones updating at once never lose a thing: twelve phones each add a trip while others tap +20, change a status and claim a ride - every trip lands, six taps of +20 make exactly 120, and nothing is overwritten', async () => {
  const f = await family(11);
  const all = [f.host, ...f.members];
  const first = (await actOn(f.host, f.id, { t: 'add', trip: trip({ who: 'Grandpa Joe' }) })).data.id;
  const second = (await actOn(f.host, f.id, { t: 'add', trip: trip({ who: 'Ben', hub: 'MDW' }) })).data.id;
  const work = [];
  all.forEach((c, i) => work.push(actOn(c, f.id, { t: 'add', trip: trip({ who: 'Traveller ' + ch(65 + i), local: `${DAY}T${String(8 + i).padStart(2, '0')}:00` }) })));
  for (let i = 0; i < 6; i++) work.push(actOn(all[i], f.id, { t: 'delay', id: first, add: 20 }));
  work.push(actOn(all[6], f.id, { t: 'status', id: first, status: 'way' }));
  work.push(actOn(all[7], f.id, { t: 'ride', id: first, k: 'driver' }));
  work.push(actOn(all[8], f.id, { t: 'status', id: second, status: 'landed' }));
  work.push(actOn(all[9], f.id, { t: 'ride', id: second, k: 'own' }));
  const res = await Promise.all(work);
  assert.ok(res.every((r) => r.status === 200), res.filter((r) => r.status !== 200).map((r) => r.text).join());
  const doc = await store.get('gatherings', f.id);
  assert.strictEqual(Object.keys(doc.trips).length, 14);
  assert.deepStrictEqual(Object.values(doc.trips).map((t) => t.who).filter((w) => /^Traveller/.test(w)).sort(), all.map((_, i) => 'Traveller ' + ch(65 + i)));
  assert.deepStrictEqual([doc.trips[first].delay, doc.trips[first].status, doc.trips[first].ride.k, doc.trips[second].status, doc.trips[second].ride], [120, 'way', 'driver', 'landed', { k: 'own' }]);
  assert.strictEqual(doc.v, 1 + 11 + 2 + work.length, 'every change moved the version once');
  // Without the queue a whole-document write would lose trips.
  const fresh = await start(client());
  await Promise.all([0, 1, 2, 3].map((i) => store._unsafeUpdate('gatherings', fresh.id, (cur) => ({ ...cur, trips: { ...cur.trips, ['tunsafe0' + i]: { who: 'x' } } }))));
  assert.ok(Object.keys((await store.get('gatherings', fresh.id)).trips).length < 4, 'the unsafe way drops writes - which is why the app never does it');
});

test('leaving and removing: only the host removes, deletes or renames; a member who leaves can no longer open it and rejoins their seat; a removed or departed driver’s rides are open again while the trips stay; the host deletes instead of leaving', async () => {
  const f = await family(2);
  const [sam, mei] = f.members;
  const tid = (await actOn(sam, f.id, { t: 'add', trip: trip() })).data.id;
  const samId = (await actOn(sam, f.id, { t: 'ride', id: tid, k: 'driver' })).data.g.me;
  assert.strictEqual((await mei('DELETE', `/api/g/${f.id}/members/${samId}`)).status, 403);
  assert.strictEqual((await mei('DELETE', `/api/g/${f.id}`)).status, 403);
  assert.strictEqual((await f.host('DELETE', `/api/g/${f.id}/me`)).status, 409);
  assert.strictEqual((await sam('DELETE', `/api/g/${f.id}/me`)).status, 200);
  assert.strictEqual((await sam('GET', `/api/g/${f.id}`)).status, 404, 'left: a stranger now');
  assert.strictEqual((await actOn(sam, f.id, { t: 'add', trip: trip() })).status, 404);
  let g = (await mei('GET', `/api/g/${f.id}`)).data.g;
  assert.deepStrictEqual([g.members.find((m) => m.id === samId).left, g.trips.length, C.issues(g, g.trips[0].at - 3600000).map((i) => i.kind)], [true, 1, ['noride']]);
  assert.strictEqual((await actOn(mei, f.id, { t: 'ride', id: tid, k: 'driver', mid: samId })).status, 400, 'someone who left cannot be made the driver');
  assert.deepStrictEqual((await sam('POST', `/api/join/${f.code}`, { name: 'Sam' })).data, { id: f.id, isNew: false }, 'the same seat');
  g = (await sam('GET', `/api/g/${f.id}`)).data.g;
  assert.deepStrictEqual([g.me, g.trips[0].mine, C.issues(g, g.trips[0].at - 3600000)], [samId, true, []], 'back, and still the driver');
  assert.strictEqual((await f.host('DELETE', `/api/g/${f.id}/members/${g.members[0].id}`)).status, 409, 'not yourself');
  assert.strictEqual((await f.host('DELETE', `/api/g/${f.id}/members/mnobody99`)).status, 404);
  const after = await f.host('DELETE', `/api/g/${f.id}/members/${samId}`);
  assert.deepStrictEqual([after.status, after.data.g.members.length, after.data.g.trips.length, after.data.g.trips[0].ride], [200, 2, 1, { k: 'driver', mid: samId }]);
  assert.strictEqual(C.board(after.data.g, after.data.g.trips[0].at - 3600000).counts.noRide, 1, 'the ride is open again');
  assert.strictEqual((await sam('GET', `/api/g/${f.id}`)).status, 404);
  assert.strictEqual((await f.host('DELETE', `/api/g/${f.id}`)).status, 200);
  assert.strictEqual(await store.get('gatherings', f.id), null, 'deleted means gone');
  assert.strictEqual((await mei('GET', `/api/g/${f.id}`)).status, 404);
});

test('the same 404, word for word, for an unknown id, a malformed one, one not yours and one gone; a gathering is deleted by the read that finds it 14 days after its last day - by id or by code; a day earlier it is fine; a later trip keeps it', async () => {
  const f = await family(1);
  const stranger = client();
  const gone = [await stranger('GET', `/api/g/${f.id}`), await stranger('GET', `/api/g/${'z'.repeat(16)}`), await stranger('GET', '/api/g/nope'), await stranger('GET', '/api/g/constructor')];
  assert.deepStrictEqual(gone.map((r) => r.status), [404, 404, 404, 404]);
  assert.strictEqual(new Set(gone.map((r) => r.text)).size, 1, 'one answer for all four');
  assert.strictEqual(gone[0].data.code, 'gone');
  const age = async (id, lastDay, tripDay) => { const d = await store.get('gatherings', id); const { id: _id, ...rest } = d; await store.set('gatherings', id, { ...rest, from: C.addDays(lastDay, -2), to: lastDay, trips: tripDay ? { told00001: { local: `${tripDay}T10:00`, dir: 'in', who: 'Late', mode: 'car', party: 1, bags: 0, ride: { k: 'self' }, status: 'sched', at: 1 } } : {} }); };
  await age(f.id, C.addDays(DAY, -14));
  assert.strictEqual((await f.host('GET', `/api/g/${f.id}`)).status, 200, '14 days after: still there');
  await age(f.id, C.addDays(DAY, -15));
  assert.deepStrictEqual([(await f.host('GET', `/api/g/${f.id}`)).status, await store.get('gatherings', f.id)], [404, null], '15 days after: deleted by the read');
  const g2 = await family(0);
  await age(g2.id, C.addDays(DAY, -15));
  assert.strictEqual((await client()('GET', `/api/join/${g2.code}`)).status, 404);
  assert.strictEqual(await store.get('gatherings', g2.id), null, 'found by its code: deleted too');
  const g3 = await family(0);
  await age(g3.id, C.addDays(DAY, -20), C.addDays(DAY, -10));
  assert.strictEqual((await g3.host('GET', `/api/g/${g3.id}`)).status, 200, 'someone left ten days ago: kept four more');
});

test('limits: 30 distinct wrong codes or ids from one address in 15 minutes, then even the right one waits - the same dead id polled over and over counts once; 10 new gatherings an address an hour; 40 people, refused not cut; another address is not affected', async () => {
  const f = await family(0);
  const guesser = client('203.0.113.7');
  for (let i = 0; i < 40; i++) assert.strictEqual((await guesser('GET', `/api/g/${'d'.repeat(16)}`)).status, 404, 'the same dead id is one miss');
  for (let i = 0; i < 29; i++) assert.strictEqual((await guesser('GET', `/api/join/ZZZZ${C.CODE_ALPHABET[i]}${C.CODE_ALPHABET[i]}`)).status, 404);
  assert.strictEqual((await guesser('GET', `/api/join/${f.code}`)).status, 429, 'thirty misses: the right code waits');
  assert.strictEqual((await guesser('POST', `/api/join/${f.code}`, { name: 'Eve' })).status, 429);
  assert.strictEqual((await client('203.0.113.8')('GET', `/api/join/${f.code}`)).status, 200);
  misses.clear();
  const busy = client('203.0.113.20');
  for (let i = 0; i < 10; i++) assert.strictEqual((await busy('POST', '/api/gatherings', NEW())).status, 200);
  assert.strictEqual((await busy('POST', '/api/gatherings', NEW())).status, 429);
  const doc = await store.get('gatherings', f.id);
  const { id: _id, ...rest } = doc;
  for (let i = 0; i < C.LIMITS.members - 1; i++) rest.members['mfill' + String(i).padStart(4, '0')] = { name: 'Guest', c: 0, keyHash: 'x' + i, joinedAt: new Date().toISOString() };
  await store.set('gatherings', f.id, rest);
  const late = await client()('POST', `/api/join/${f.code}`, { name: 'Late' });
  assert.deepStrictEqual([late.status, /40 people/.test(late.data.error)], [409, true]);
  assert.strictEqual((await client()('GET', `/api/join/${f.code}`)).data.full, true);
});

test('hostile input end to end: markup, bidi and zero-width names, an email or a phone number anywhere, prototype keys as a mode, a status or an id, a body that is not an object, a megabyte - refused or cleaned, and nothing odd stored', async () => {
  const f = await family(1, { name: `<b>Ro${ZW}sa</b>${RLO}`, place: `Mom’s${ZW} house${RLO}` });
  assert.deepStrictEqual([f.g.members[0].name, f.g.place], ['Rosa', 'Mom’s house']);
  assert.strictEqual((await client()('POST', '/api/gatherings', { ...NEW(), place: 'Mom’s <i>house</i>' })).status, 400, 'markup is refused, not tidied');
  const [sam] = f.members;
  const ok = await actOn(sam, f.id, { t: 'add', trip: trip({ who: `A${RLO}na`, note: `door${ZW} 3`, number: 'ua 1482;--', carrier: '  U A  ', __proto__: { polluted: 1 }, constructor: 'x' }) });
  assert.deepStrictEqual([ok.status, ok.data.g.trips[0].who, ok.data.g.trips[0].note, ok.data.g.trips[0].number, ok.data.g.trips[0].carrier], [200, 'Ana', 'door 3', 'UA 1482', 'U A']);
  const tid = ok.data.id;
  for (const t of [trip({ who: '<script>alert(1)</script>' }), trip({ note: `text me ${PHONE}` }), trip({ from: `ana${FW_AT}example` }), trip({ hub: 'javascript://x' }), trip({ mode: '__proto__' }), trip({ mode: 'toString' }), trip({ tz: 'constructor' }), trip({ local: { $gt: '' } }), 'trip', null, []]) {
    assert.strictEqual((await actOn(sam, f.id, { t: 'add', trip: t })).status, 400, JSON.stringify(t));
  }
  for (const a of [{ t: 'status', id: tid, status: '__proto__' }, { t: 'status', id: '__proto__', status: 'way' }, { t: 'delay', id: tid, add: 1e9 }, { t: 'delay', id: tid, add: '20' }, { t: 'ride', id: tid, k: 'driver', mid: '__proto__' }, { t: 'ride', ids: 'all', k: 'driver' }, { t: '__proto__' }]) {
    const r = await actOn(sam, f.id, a);
    assert.ok(r.status === 400 || r.status === 404, JSON.stringify(a) + ' ' + r.status);
  }
  assert.strictEqual((await sam('POST', `/api/g/${f.id}/act`, '[]')).status, 400);
  assert.strictEqual((await sam('POST', `/api/g/${f.id}/act`, HUGE)).status, 413);
  assert.strictEqual({}.polluted, undefined);
  const dump = store._dump();
  assert.ok(!/<script|<b>|<i>|onerror|javascript:/.test(dump) && !dump.includes(RLO) && !dump.includes(ZW) && !dump.includes(PHONE) && !dump.includes(AT), 'nothing odd in the store');
  assert.strictEqual(Object.keys((await store.get('gatherings', f.id)).trips).length, 1);
});

test('signed in (free): a gathering kept on the account opens on the other phone with no key cookie, as the same member; filed under HMACs of the account id that differ per gathering; the list follows; leaving or deleting takes it off; a stranger’s account opens nothing', async () => {
  const phone = await register('arr.rosa');
  assert.deepStrictEqual((await phone('GET', '/api/mine')).data, { list: [] });
  const g = await start(phone);
  const tid = (await actOn(phone, g.id, { t: 'add', trip: trip() })).data.id;
  assert.strictEqual((await phone('POST', `/api/g/${g.id}/keep`, {})).status, 200);
  const v0 = (await store.get('gatherings', g.id)).v;
  assert.strictEqual((await phone('POST', `/api/g/${g.id}/keep`, {})).status, 200);
  assert.strictEqual((await store.get('gatherings', g.id)).v, v0, 'keeping it changes nothing anyone is shown');
  const g2 = await start(phone, { title: 'New Year', place: 'The cabin' });
  await phone('POST', `/api/g/${g2.id}/keep`, {});
  // The other phone: same account, no key cookie.
  const other = client();
  assert.strictEqual((await other('GET', `/api/g/${g.id}`)).status, 404);
  assert.strictEqual((await other('POST', '/api/auth/login', { email: mail('arr.rosa'), password: 'a long enough password' })).status, 200);
  assert.strictEqual(other.cookies.arrivals_k, undefined);
  const list = (await other('GET', '/api/mine')).data.list;
  assert.deepStrictEqual(list.map((x) => [x.id, x.title, x.place]), [[g2.id, 'New Year', 'The cabin'], [g.id, 'Thanksgiving', 'Mom’s house']]);
  const seen = (await other('GET', `/api/g/${g.id}`)).data.g;
  assert.deepStrictEqual([seen.me, seen.host, seen.trips[0].mine], [g.g.me, true, true], 'the same member, and still the host');
  assert.strictEqual((await actOn(other, g.id, { t: 'status', id: tid, status: 'way' })).status, 200);
  assert.deepStrictEqual((await other('POST', `/api/join/${g.code}`, { name: 'Rosa' })).data, { id: g.id, isNew: false }, 'joining by code on the other phone is the same seat, not a second Rosa');
  // What is stored: tags, never the id or the email.
  const uid = (await identityStore.list('users')).find((u) => u.email === mail('arr.rosa')).id;
  const d1 = await store.get('gatherings', g.id), d2 = await store.get('gatherings', g2.id);
  const s1 = d1.members[g.g.me].owner, s2 = d2.members[g2.g.me].owner;
  assert.deepStrictEqual([s1, s2], [G.seatTag(uid, g.id, 'local-dev-secret'), G.seatTag(uid, g2.id, 'local-dev-secret')]);
  assert.notStrictEqual(s1, s2, 'two gatherings cannot be linked through the account');
  const tag = G.ownerTag(uid, 'local-dev-secret');
  assert.deepStrictEqual(Object.keys((await store.get('mine', tag)).g).sort(), [g.id, g2.id].sort());
  const dump = store._dump();
  assert.ok(!dump.includes(uid) && !dump.includes(mail('arr.rosa')) && !dump.includes('arr.rosa'), 'no account id and no email in Arrivals’ own store');
  assert.ok(!JSON.stringify(seen).includes(s1), 'and the tag is never sent to a phone');
  // Someone else's account opens nothing; a member's own keep is theirs alone.
  const eve = await register('arr.eve');
  assert.strictEqual((await eve('GET', `/api/g/${g.id}`)).status, 404);
  assert.strictEqual((await eve('POST', `/api/g/${g.id}/keep`, {})).status, 404);
  assert.deepStrictEqual((await eve('GET', '/api/mine')).data, { list: [] });
  // Forgetting, and deleting.
  assert.strictEqual((await other('DELETE', `/api/mine/${g2.id}`)).status, 200);
  assert.deepStrictEqual((await phone('GET', '/api/mine')).data.list.map((x) => x.id), [g.id]);
  assert.strictEqual((await other('DELETE', '/api/mine/nope')).status, 400);
  assert.strictEqual((await other('DELETE', `/api/g/${g.id}`)).status, 200);
  assert.deepStrictEqual((await phone('GET', '/api/mine')).data, { list: [] });
});

const usageRows = async () => (await identityStore.list('usage')).length;
const READ = (o) => ({ place: 'Mom’s house', from: DAY, to: C.addDays(DAY, 4), tz: CHI, ...o });

test('fill from a confirmation: signed in and metered; pasted text or one screenshot becomes DRAFT trips with the local time and zone, never saved; a round trip gives an arrival and a trip home; a request that cannot work costs nothing; nothing of the confirmation is stored or logged', async () => {
  const c = await register('arr.reader');
  const f = await start(c);
  const calls = fakeClient.calls.length, rows = await usageRows();
  const text = `Your trip is confirmed\nPassenger Ana, 3 passengers\nFlight UA 1482 from Denver\nArrives ORD ${DAY} 15:10\nConfirmation code QX7K2P`;
  const r = await c('POST', '/api/read', READ({ text }));
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.data.drafts, [{ dir: 'in', who: 'Ana', mode: 'flight', from: 'Denver', carrier: 'UA', number: '1482', hub: 'ORD', local: `${DAY}T15:10`, tz: CHI, party: 3 }]);
  assert.ok(!/QX7K2P/.test(r.text));
  await settle();
  assert.deepStrictEqual([fakeClient.calls.length - calls, (await usageRows()) - rows], [1, 1], 'one forced-tool call, one usage row');
  assert.match(fakeClient.seen[fakeClient.seen.length - 1], /The gathering is at \\"Mom’s house\\", \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d, time zone America\/Chicago/);
  assert.strictEqual((await store.get('gatherings', f.id)).v, 1, 'a draft is not on the board until the person saves it');
  // The draft, checked and saved, is an ordinary trip.
  const saved = await actOn(c, f.id, { t: 'add', trip: r.data.drafts[0] });
  assert.deepStrictEqual([saved.status, saved.data.g.trips[0].at], [200, C.zonedToUtc(`${DAY}T15:10`, CHI)]);
  const rt = await c('POST', '/api/read', READ({ text: text + '\nROUNDTRIP' }));
  assert.deepStrictEqual(rt.data.drafts.map((d) => [d.dir, d.number, d.hub, d.local]), [['in', '1482', 'ORD', `${DAY}T15:10`], ['out', '1483', 'ORD', `${C.addDays(DAY, 4)}T17:05`]]);
  const shot = await c('POST', '/api/read', READ({ photo: { type: 'image/png', data: `data:image/png;base64,${PNG}` } }));
  assert.deepStrictEqual([shot.status, shot.data.drafts.length, shot.data.drafts[0].hub, shot.data.drafts[0].local, shot.data.drafts[0].party], [200, 1, 'ORD', `${DAY}T15:10`, 2]);
  assert.ok(fakeClient.seen[fakeClient.seen.length - 1].includes('"type":"image"'), 'the screenshot went to the model as an image block');
  // What costs nothing.
  const free = fakeClient.calls.length;
  for (const [body, re] of [[READ({}), /Paste the confirmation/], [READ({ text, photo: { data: PNG } }), /one at a time/], [READ({ text: 'hello there' }), /doesn’t look like a confirmation/], [READ({ text: 'x1 '.repeat(3000) }), /a lot of text/],
    [READ({ photo: { type: 'image/png', data: Buffer.from('%PDF-1.4 not an image').toString('base64') } }), /JPEG, PNG or WebP/], [READ({ photo: { data: '!!!' } }), /could not be read/], [{ text }, /Open the gathering first/], [READ({ text, tz: 'Mars/Olympus' }), /Open the gathering first/]]) {
    const bad = await c('POST', '/api/read', body);
    assert.deepStrictEqual([bad.status, re.test(bad.data.error)], [400, true], bad.text);
  }
  assert.strictEqual(fakeClient.calls.length, free, 'none of those reached the model');
  // Nothing of it is kept.
  const dump = store._dump() + JSON.stringify(await identityStore.list('usage'));
  assert.ok(!/QX7K2P|Your trip is confirmed|Passenger Ana/.test(dump) && !dump.includes(PNG.slice(0, 40)));
  assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|b\.text|photo|drafts)/.test(read('server.js') + read('lib/ai.js')), 'no log line carries the confirmation');
  assert.deepStrictEqual([ai.TOOL.name, Object.keys(ai.TOOL.input_schema.properties.trips.items.properties).some((k) => /confirm|record|ticket|email|phone/i.test(k))], ['record_trips', false], 'the tool has no field that could hold a booking reference');
  assert.match(ai.SYSTEM, /Never return a booking reference/);
});

test('what the model sends back is never trusted: markup, an email, a phone number, an unknown mode or zone, an impossible time, a party of 99 and invented keys are cleaned or blanked; nothing usable is a 422; a provider failure never shows the provider’s words; running long is said plainly', async () => {
  const c = await register('arr.hostile');
  const inj = await c('POST', '/api/read', READ({ text: 'Flight 12 INJECT' }));
  assert.strictEqual(inj.status, 200, inj.text);
  assert.deepStrictEqual(inj.data.drafts, [{ dir: 'in', who: '', mode: 'flight', from: '', carrier: '', number: '', hub: 'ORD', local: '', tz: CHI, party: 1 }]);
  assert.ok(!/ABC123|0162345678901|onerror|example\.com|3344/.test(inj.text));
  const blank = await c('POST', '/api/read', READ({ text: 'Flight 12 BLANK' }));
  assert.deepStrictEqual([blank.status, blank.data.code], [422, 'nothing']);
  for (const [code, want] of [[401, 502], [400, 502], [500, 502], [429, 503], [529, 503]]) {
    const up = await c('POST', '/api/read', READ({ text: `Flight 12 UPSTREAM${code}` }));
    assert.strictEqual(up.status, want, `${code}`);
    assert.ok(!/fake_upstream_error|stand-in|"type"/.test(up.text) && /type it in|typing it in/.test(up.data.error), up.text);
  }
  const long = await c('POST', '/api/read', READ({ text: 'Flight 12 MAXTOKENS' }));
  assert.deepStrictEqual([long.status, /ran long/.test(long.data.error)], [502, true]);
  // cleanDraft itself: a time outside the gathering is blanked, a car has no airport.
  const g = { ...GATH };
  assert.strictEqual(C.cleanDraft({ local: '2027-06-01T10:00', hub: 'ORD' }, g).local, '');
  assert.deepStrictEqual(C.cleanDraft({ mode: 'car', hub: 'ORD', carrier: 'UA', number: '1', local: '2026-11-25T10:00', tz: 'America/Denver', party: 4, dir: 'out', who: 'Priya' }, g), { dir: 'out', who: 'Priya', mode: 'car', from: '', carrier: '', number: '', hub: '', local: '2026-11-25T10:00', tz: 'America/Denver', party: 4 });
  for (const junk of [null, 5, 'x', [], { who: { a: 1 }, local: [] }]) assert.doesNotThrow(() => C.cleanDraft(junk, g));
  assert.deepStrictEqual(ai.cleanDrafts({ trips: 'no' }, g), []);
  assert.strictEqual(ai.cleanDrafts({ trips: Array(9).fill({ direction: 'arrival', hub: 'ORD' }) }, g).length, C.LIMITS.drafts, 'four at most');
  assert.throws(() => photo.validate({ data: 'A'.repeat(6 * 1024 * 1024) }), /too large/);
});

test('the usual gates and the lab’s guard: no budget, no call (402); the guard is asked after the request is checked and before the model, a "no" calls nothing and says what still works; the cost is recorded once per call at the model’s price, also when the call fails; with no guard the identity gates stand alone', async () => {
  const c = await register('arr.gates');
  const text = `Flight UA 1482 from Denver\nArrives ORD ${DAY} 15:10`;
  const log = [];
  const guard = (answer) => ({
    allow: async (a) => { log.push(['allow', a.provider, a.app, Boolean(a.req && a.req.user)]); return answer || { ok: true }; },
    priceUsd: (p) => { log.push(['price', p.provider, p.model, p.inputTokens, p.outputTokens]); return 0.0017; },
    record: async (r) => { log.push(['record', r.provider, r.app, r.usd]); return true; },
  });
  try {
    global.LAB_AI_GUARD = guard();
    let calls = fakeClient.calls.length;
    assert.strictEqual((await c('POST', '/api/read', READ({ text }))).status, 200);
    assert.deepStrictEqual(log, [['allow', 'claude', 'arrivals', true], ['price', 'claude', MODELS.free, 900, 160], ['record', 'claude', 'arrivals', 0.0017]]);
    assert.strictEqual(fakeClient.calls.length, calls + 1);
    log.length = 0;
    assert.strictEqual((await c('POST', '/api/read', READ({ text: 'nope' }))).status, 400);
    assert.deepStrictEqual(log, [], 'a request that cannot work never uses one of the person’s calls');
    await c('POST', '/api/read', READ({ text: 'Flight 12 UPSTREAM500' }));
    assert.deepStrictEqual(log.map((l) => l[0]), ['allow'], 'a call that never came back had no usage to record');
    log.length = 0;
    await c('POST', '/api/read', READ({ text: 'Flight 12 BLANK' }));
    assert.deepStrictEqual(log.map((l) => l[0]), ['allow', 'price', 'record'], 'a call that came back useless was still paid for');
    for (const [answer, status] of [[{ ok: false, status: 429, code: 'burst-minute', message: 'Lots of people are using AI right now - try again in a minute.' }, 429], [{ ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' }, 503]]) {
      global.LAB_AI_GUARD = guard(answer); log.length = 0; calls = fakeClient.calls.length;
      const no = await c('POST', '/api/read', READ({ text }));
      assert.deepStrictEqual([no.status, no.data.code, no.data.error], [status, answer.code, `${answer.message} Typing the trip in still works.`]);
      assert.deepStrictEqual([log.map((l) => l[0]), fakeClient.calls.length - calls], [['allow'], 0]);
    }
    global.LAB_AI_GUARD = { ...guard(), record: async () => { throw new Error('store down'); } };
    assert.strictEqual((await c('POST', '/api/read', READ({ text }))).status, 200, 'a failed record never fails the answer');
  } finally { delete global.LAB_AI_GUARD; }
  // The identity gates: out of budget is a 402 before the body is read.
  const poor = await register('arr.broke');
  const uid = (await identityStore.list('users')).find((u) => u.email === mail('arr.broke')).id;
  await identityStore.merge('users', uid, { spentUsd: 100 });
  const calls = fakeClient.calls.length;
  const broke = await poor('POST', '/api/read', HUGE);
  assert.strictEqual(broke.status, 402, broke.text);
  assert.strictEqual(fakeClient.calls.length, calls);
  const server = read('server.js');
  assert.match(server, /app\.post\('\/api\/read', \.\.\.spend, readJson, route\(/);
  assert.match(server, /const spend = \[identity\.requireUser, identity\.requireBudget, identity\.requireDailyCap\];/);
  assert.ok(server.indexOf('const b = ai.brief(req.body, photo);') < server.indexOf('await guardAllow(req);') && server.indexOf('await guardAllow(req);') < server.indexOf('const client = await clientFor(req);'));
  assert.strictEqual((server.match(/messages\.create|\.read\(client/g) || []).length, 1, 'one model call in the whole app');
  // Everything else never needs an account: the whole board, signed out.
  const anon = client();
  const g = await start(anon);
  assert.strictEqual((await actOn(anon, g.id, { t: 'add', trip: trip() })).status, 200);
});

test('a hostile pass leaves nothing identifying in the store: no browser key, no email, no account id, no markup, no confirmation - only gatherings and the accounts’ lists are kept', async () => {
  const dump = store._dump();
  const cols = JSON.parse(dump).map((c) => c[0]).sort();
  assert.deepStrictEqual(cols, ['gatherings', 'mine']);
  for (const u of await identityStore.list('users')) { assert.ok(!dump.includes(u.id), 'an account id'); assert.ok(!dump.includes(u.email), 'an email'); }
  assert.ok(!/arrivals_k|example\.com|<script|password/.test(dump));
  for (const [, docs] of JSON.parse(dump).filter((c) => c[0] === 'gatherings')) for (const [, d] of docs) {
    for (const m of Object.values(d.members)) assert.deepStrictEqual(Object.keys(m).filter((k) => !['name', 'c', 'keyHash', 'owner', 'joinedAt', 'host', 'left'].includes(k)), []);
    for (const t of Object.values(d.trips)) assert.deepStrictEqual(Object.keys(t).filter((k) => !['dir', 'who', 'mode', 'from', 'carrier', 'number', 'hub', 'local', 'tz', 'at', 'party', 'bags', 'seat', 'note', 'status', 'delay', 'ride', 'by', 'ts'].includes(k)), [], JSON.stringify(t));
  }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/arrivals', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/arrivals`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
