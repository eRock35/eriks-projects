// Pure rules first (templates, the start-time maths, today's status, the
// clocks-change helper with fixed clocks and fixed zones, the calendar file,
// progress, stickers and streaks, cleaning hostile input, the AI briefs and
// answers), then the page's own promises, then end to end against the memory
// store and the fake model:
//   TADA_MEMORY=1 TADA_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /tada, the way the
// lab mounts it, so the auth cookie, the budget gate and each route's parser
// order are exercised as deployed. Model calls are counted from the identity
// usage rows, and what reached "the model" is read from the fake's own log.
//
// Every family, child and routine here is made up.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.TADA_MEMORY !== '1' || process.env.TADA_FAKE_AI !== '1') {
  console.error('run with TADA_MEMORY=1 TADA_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient, ownerTag, LIMITS } = require('../server');
const C = require('../public/tada-core');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- helpers ---------------- */

const HOSTILE = ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', 'Ma\u202eya', 'zero\u200bwidth', 'line\nbreak', 'x'.repeat(500)];
let n = 0;
const ids = () => `t${(++n).toString(36)}`;
const NY = 'America/New_York';
const LONDON = 'Europe/London';
const at = (iso) => Date.parse(iso);
function family() {
  n = 0;
  const maya = { id: 'cmaya', name: 'Maya', avatar: '🐼', color: 'sun', band: 'middle', routines: [C.fromTemplate('school-morning', 'middle', ids, { doneBy: '08:10', today: '2026-10-20' }), C.fromTemplate('bedtime', 'middle', ids, { doneBy: '20:00', today: '2026-10-20' })] };
  const leo = { id: 'cleo', name: 'Leo', avatar: '🦁', color: 'sea', band: 'little', routines: [C.fromTemplate('bedtime', 'little', ids, { doneBy: '19:30', today: '2026-10-20' })] };
  return C.cleanFamily({ children: [maya, leo], settings: {} });
}

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/* ================================================================== *
 * Templates, emoji, times
 * ================================================================== */

test('templates: four, each in three ages, every step valid, from the emoji set, 1-30 minutes, and never a gendered word', () => {
  assert.deepStrictEqual(C.TEMPLATES.map((t) => t.id), ['school-morning', 'weekend-morning', 'bedtime', 'bath-night']);
  for (const t of C.TEMPLATES) {
    for (const band of ['little', 'middle', 'big']) {
      const r = C.fromTemplate(t.id, band, ids, { today: '2026-10-28' });
      const clean = C.cleanRoutine(r);
      assert.deepStrictEqual(clean, r, `${t.id}/${band} survives cleaning unchanged`);
      assert.ok(r.steps.length >= 5 && r.steps.length <= 9, `${t.id}/${band}: ${r.steps.length} steps`);
      for (const s of r.steps) {
        assert.strictEqual(C.emojiOf(s.emoji), s.emoji, `${s.emoji} is in the set`);
        assert.ok(s.minutes >= 1 && s.minutes <= 30);
        assert.ok(!/\b(he|she|his|her|him|boy|girl|son|daughter)\b/i.test(s.name), s.name);
      }
      assert.strictEqual(new Set(r.steps.map((s) => s.id)).size, r.steps.length, 'ids unique');
      assert.ok(C.ROUTINE_ICONS.includes(r.emoji));
    }
  }
  // ages differ where they should: potty for the littlest, packing their own bag for the biggest
  const names = (id, b) => C.fromTemplate(id, b, ids).steps.map((s) => s.name).join('|');
  assert.match(names('bedtime', 'little'), /Potty/);
  assert.match(names('bedtime', 'big'), /Pack your bag/);
  assert.ok(!/Potty/.test(names('bedtime', 'big')));
  // lights-out moves with age
  assert.deepStrictEqual(['little', 'middle', 'big'].map((b) => C.fromTemplate('bedtime', b, ids).doneBy), ['19:30', '20:00', '20:45']);
  assert.strictEqual(C.fromTemplate('bedtime', 'middle', ids, { doneBy: '19:15' }).doneBy, '19:15');
  assert.strictEqual(C.fromTemplate('nope', 'middle', ids), null);
  const demo = C.demoRoutine();
  assert.ok(demo.demo && demo.steps.length === 5 && demo.steps.every((s) => s.minutes === 1));
});

test('the emoji set: about sixty, unique, all for children; names find the right one; a missing variation selector still matches', () => {
  assert.ok(C.EMOJI.length >= 55 && C.EMOJI.length <= 70, `${C.EMOJI.length} emoji`);
  assert.strictEqual(new Set(C.EMOJI.map((e) => e.e)).size, C.EMOJI.length);
  assert.ok(C.EMOJI.every((e) => e.label && e.words.length));
  assert.ok(!C.EMOJI.some((e) => /[\u200d]/.test(e.e)), 'no joined sequences, which older phones draw as two');
  assert.strictEqual(C.emojiOf('\u{1F6CF}'), '🛏️', 'bed without FE0F');
  assert.strictEqual(C.emojiOf('🛏️'), '🛏️');
  assert.strictEqual(C.emojiOf('🦩'), null);
  assert.strictEqual(C.emojiOf('<b>'), null);
  for (const [name, e] of [['Brush your teeth', '🪥'], ['Shoes on', '👟'], ['Pack your bag', '🎒'], ['Pajamas on', '🌛'], ['Story time', '📖'], ['Feed the dog', '🐶'], ['Catch the bus', '🚌'], ['Something odd', '⭐'], ['Toys away', '🧸'], ['Make your bed', '🛏️'], ['Into bed', '🛌']]) {
    assert.strictEqual(C.emojiFor(name), e, name);
  }
  assert.strictEqual(C.STICKERS.length, new Set(C.STICKERS).size);
  assert.strictEqual(C.stickerFor('cmaya', '2026-10-28', 'r1'), C.stickerFor('cmaya', '2026-10-28', 'r1'), 'the same sticker on every device');
  assert.ok(new Set(Array.from({ length: 40 }, (_, i) => C.stickerFor('cmaya', C.addDays('2026-10-01', i), 'r1'))).size > 12, 'and they vary');
});

test('times: start worked back from done-by, 12 and 24 hour, a start before midnight, plurals', () => {
  const r = C.fromTemplate('bedtime', 'middle', ids, { doneBy: '20:00' });
  assert.strictEqual(C.totalMinutes(r), 35);
  assert.deepStrictEqual(C.timesFor(r, 0), { start: 1165, doneBy: 1200 });
  assert.strictEqual(C.fmtTime(1165), '7:25 PM');
  assert.strictEqual(C.fmtTime(1165, false), '19:25');
  assert.strictEqual(C.fmtTime(0), '12:00 AM');
  assert.strictEqual(C.fmtTime(720), '12:00 PM');
  assert.strictEqual(C.fmtTime(-30), '11:30 PM', 'wraps');
  assert.deepStrictEqual(C.timesFor(r, 15), { start: 1180, doneBy: 1215 }, 'a plan shift moves both');
  const m = C.fromTemplate('school-morning', 'middle', ids, { doneBy: '08:10' });
  assert.strictEqual(C.fmtTime(C.timesFor(m, 0).start), '7:33 AM');
  assert.strictEqual(C.toMin('7:05'), 425);
  assert.strictEqual(C.toMin('24:00'), null);
  assert.strictEqual(C.toMin('7pm'), null);
  assert.strictEqual(C.fmtMinutes(6), '6 minutes');
  assert.strictEqual(C.fmtMinutes(1), '1 minute');
  assert.strictEqual(C.fmtMinutes(70), '1 hour 10 minutes');
  assert.deepStrictEqual([C.fmtDays([0, 1, 2, 3, 4, 5, 6]), C.fmtDays([1, 2, 3, 4, 5]), C.fmtDays([6, 0]), C.fmtDays([3, 0])], ['Every day', 'Weekdays', 'Weekends', 'Wed, Sun']);
  assert.strictEqual(C.weekday('2026-11-01'), 0);
  assert.strictEqual(C.niceDay('2026-11-01'), 'Sun Nov 1');
});

test('today\u2019s status: starts later, on track for a time, about N minutes behind (never red words), all done, past', () => {
  const r = C.fromTemplate('bedtime', 'middle', ids, { doneBy: '20:00' }); // 35 min, starts 7:25
  const done = (k) => new Set(r.steps.slice(0, k).map((s) => s.id));
  assert.strictEqual(C.status(r, done(0), 18 * 60 + 50, 0).line, 'Starts 7:25 PM');
  let st = C.status(r, done(4), 19 * 60 + 40, 0); // 4 of 8 done, 21 minutes left at 7:40 -> 8:01
  assert.deepStrictEqual([st.state, st.line], ['behind', '4 of 8 - about 1 minute behind']);
  st = C.status(r, done(4), 19 * 60 + 45, 0);
  assert.strictEqual(st.line, '4 of 8 - about 6 minutes behind');
  st = C.status(r, done(4), 19 * 60 + 30, 0);
  assert.deepStrictEqual([st.state, st.line], ['ontrack', '4 of 8 - on track for 7:51 PM']);
  st = C.status(r, done(0), 19 * 60 + 31, 0);
  assert.strictEqual(st.line, '0 of 8 - about 6 minutes behind', 'not started, six minutes past its start');
  assert.strictEqual(C.status(r, done(8), 19 * 60 + 58, 0).line, 'All done');
  assert.strictEqual(C.status(r, done(3), 23 * 60, 0).line, '3 of 8 done', 'long past: just the count, no "behind"');
  assert.strictEqual(C.status(r, done(0), 18 * 60 + 50, 30).line, 'Starts 7:55 PM', 'a plan day moves the start');
  assert.strictEqual(C.status(r, done(0), 19 * 60, 0, false).line, 'Starts 19:25');
  // which routine kid mode opens
  const f = family();
  const maya = f.children[0];
  const p = C.emptyProgress();
  assert.strictEqual(C.currentRoutine(maya, '2026-10-28', 7 * 60 + 40, p, null).kind, 'morning');
  assert.strictEqual(C.currentRoutine(maya, '2026-10-28', 19 * 60, p, null).kind, 'bedtime');
  assert.strictEqual(C.currentRoutine(maya, '2026-10-28', 13 * 60, p, null).kind, 'bedtime', 'the next one today');
  assert.strictEqual(C.currentRoutine(maya, '2026-11-01', 7 * 60 + 40, p, null).kind, 'bedtime', 'no school morning on a Sunday');
  C.applyTap(p, { day: '2026-10-28', c: maya.id, r: maya.routines[1].id, fin: at('2026-10-28T23:50:00Z') });
  assert.strictEqual(C.currentRoutine(maya, '2026-10-28', 20 * 60, p, null).kind, 'morning', 'finished ones are skipped; the morning was missed');
  assert.strictEqual(C.sayFor({ name: 'Brush your teeth' }), 'Time to brush your teeth!');
  assert.strictEqual(C.sayFor({ name: 'Story time' }), "It's story time!");
  assert.strictEqual(C.sayFor({ name: 'Coat on' }), 'Time to get your coat on!');
  assert.strictEqual(C.sayFor({ name: 'Toys away' }), 'Time to put your toys away!');
  assert.strictEqual(C.sayFor({ name: 'Hugs' }), 'Time for hugs!');
});

/* ================================================================== *
 * The clocks change, with fixed clocks and fixed zones
 * ================================================================== */

test('clocks: New York on 2026-10-28 finds Sun Nov 1, 2:00 AM back to 1:00 AM - from Intl alone', () => {
  const now = at('2026-10-28T16:00:00Z');
  assert.strictEqual(C.offsetAt(now, NY), -240);
  const ch = C.nextChange(now, NY, 60);
  assert.deepStrictEqual(ch, { at: at('2026-11-01T06:00:00Z'), before: -240, after: -300, delta: -60, day: '2026-11-01', wallFrom: 120, wallTo: 60, kind: 'back' });
  assert.strictEqual(C.dayOf(now, NY), '2026-10-28');
  assert.strictEqual(C.minuteOf(now, NY), 12 * 60);
  // the next one after that is in March - beyond 60 days, so none
  assert.strictEqual(C.nextChange(at('2026-11-02T12:00:00Z'), NY, 60), null);
  const spring = C.nextChange(at('2027-02-20T12:00:00Z'), NY, 60);
  assert.deepStrictEqual([spring.day, spring.kind, spring.delta, C.fmtTime(spring.wallFrom), C.fmtTime(spring.wallTo)], ['2027-03-14', 'forward', 60, '2:00 AM', '3:00 AM']);
  // zones that never change, or change by half an hour
  assert.strictEqual(C.nextChange(now, 'Asia/Tokyo', 60), null);
  assert.strictEqual(C.nextChange(now, 'UTC', 60), null);
  const lh = C.nextChange(at('2026-09-20T00:00:00Z'), 'Australia/Lord_Howe', 60);
  assert.deepStrictEqual([lh.delta, lh.kind, lh.day], [30, 'forward', '2026-10-04']);
  // the machine's own zone plays no part
  const prog = `const C=require(${JSON.stringify(path.join(ROOT, 'public/tada-core.js'))});console.log(JSON.stringify([C.nextChange(${now},'${NY}',60),C.nextChange(${at('2027-03-20T12:00:00Z')},'${LONDON}',60)]))`;
  const outs = ['Asia/Tokyo', 'America/Los_Angeles', 'UTC'].map((TZ) => spawnSync(process.execPath, ['-e', prog], { env: { ...process.env, TZ }, encoding: 'utf8' }).stdout);
  assert.ok(outs.every((o) => o === outs[0] && o.includes('"day":"2026-11-01"') && o.includes('"day":"2027-03-28"')), 'the same answer whatever the machine\u2019s zone');
  assert.ok(C.zoneOk(NY) && !C.zoneOk('Mars/Olympus') && !C.zoneOk('../etc') && !C.zoneOk(''));
});

test('clocks: the fall-back plan moves lights-out 15 minutes LATER each night over the four days before, and fewer days left means bigger steps', () => {
  const ch = C.nextChange(at('2026-10-28T16:00:00Z'), NY, 60);
  const p = C.clockPlan(ch, '2026-10-28');
  assert.deepStrictEqual(p.days, [{ day: '2026-10-28', shift: 15 }, { day: '2026-10-29', shift: 30 }, { day: '2026-10-30', shift: 45 }, { day: '2026-10-31', shift: 60 }]);
  assert.deepStrictEqual([p.day, p.kind, p.mornings], ['2026-11-01', 'back', false]);
  // made early: it starts on the first of the four days, not today
  assert.strictEqual(C.clockPlan(ch, '2026-10-10').days[0].day, '2026-10-28');
  // made late: the same hour over the days that are left
  assert.deepStrictEqual(C.clockPlan(ch, '2026-10-30').days, [{ day: '2026-10-30', shift: 30 }, { day: '2026-10-31', shift: 60 }]);
  assert.deepStrictEqual(C.clockPlan(ch, '2026-10-29').days.map((d) => d.shift), [20, 40, 60]);
  assert.strictEqual(C.clockPlan(ch, '2026-11-01'), null, 'on the day itself it is too late');
  assert.strictEqual(C.clockPlan(null, '2026-10-28'), null);
  // what each routine does on each day
  const r = C.fromTemplate('bedtime', 'middle', ids, { doneBy: '20:00' });
  assert.strictEqual(C.fmtTime(C.timesFor(r, C.shiftFor(p, '2026-10-31', 'bedtime')).doneBy), '9:00 PM', 'Saturday: 9:00 PM old clock = 8:00 PM new');
  assert.strictEqual(C.shiftFor(p, '2026-11-01', 'bedtime'), 0, 'Sunday: the usual time');
  // Thu and Fri are school days: moving out-the-door would make a child late
  assert.strictEqual(C.shiftFor(p, '2026-10-29', 'morning'), 0, 'mornings stay put by default');
  assert.strictEqual(C.shiftFor({ ...p, mornings: true }, '2026-10-29', 'morning'), 30, 'unless the parent asks');
  assert.strictEqual(C.clockPlan(ch, '2026-10-28', { mornings: true }).mornings, true);
  assert.strictEqual(C.cleanPlan({ ...p, mornings: undefined }).mornings, false, 'a stored plan without the field keeps mornings put');
  assert.strictEqual(C.shiftFor(p, '2026-10-29', 'other'), 0, 'an after-school routine never moves');
  assert.strictEqual(C.shiftFor(null, '2026-10-29', 'bedtime'), 0);
});

test('clocks: the spring-forward plan (London, 2027-03-28) moves bedtime 15 minutes EARLIER each night', () => {
  const ch = C.nextChange(at('2027-03-20T12:00:00Z'), LONDON, 60);
  assert.deepStrictEqual(ch, { at: at('2027-03-28T01:00:00Z'), before: 0, after: 60, delta: 60, day: '2027-03-28', wallFrom: 60, wallTo: 120, kind: 'forward' });
  const p = C.clockPlan(ch, '2027-03-20');
  assert.deepStrictEqual(p.days, [{ day: '2027-03-24', shift: -15 }, { day: '2027-03-25', shift: -30 }, { day: '2027-03-26', shift: -45 }, { day: '2027-03-27', shift: -60 }]);
  const r = C.fromTemplate('bedtime', 'little', ids, { doneBy: '19:00' });
  assert.strictEqual(C.fmtTime(C.timesFor(r, C.shiftFor(p, '2027-03-27', 'bedtime')).doneBy, false), '18:00', 'the night before: 6 PM GMT = 7 PM BST');
  // a stored plan is cleaned like everything else
  assert.deepStrictEqual(C.cleanPlan(JSON.parse(JSON.stringify(p))), p);
  assert.strictEqual(C.cleanPlan({ ...p, delta: 999 }), null);
  assert.strictEqual(C.cleanPlan({ ...p, days: [{ day: '2027-04-01', shift: -15 }] }), null, 'plan days are before the change');
  assert.deepStrictEqual(C.cleanPlan({ ...p, days: [...p.days, { day: 'x', shift: 5 }, { day: '2027-03-23', shift: 9999 }] }).days, p.days);
  assert.strictEqual(C.cleanPlan('<script>'), null);
});

/* ================================================================== *
 * The calendar file
 * ================================================================== */

test('.ics: a weekly floating event at the start time on the chosen days, with a reminder, escaped and folded', () => {
  const r = C.cleanRoutine({ ...C.fromTemplate('bedtime', 'middle', ids, { doneBy: '20:00' }), days: [1, 2, 3, 4, 0] });
  const child = { id: 'cmaya', name: 'Maya, "the; boss"\\ <b>\n2' };
  const ics = C.buildIcs(child, r, { today: '2026-10-31', nowMs: at('2026-10-28T12:00:00Z') });
  assert.ok(ics.endsWith('\r\n') && !/[^\r]\n/.test(ics), 'CRLF line endings throughout');
  const lines = ics.replace(/\r\n /g, '').split('\r\n');
  assert.strictEqual(lines[0], 'BEGIN:VCALENDAR');
  assert.ok(lines.includes('VERSION:2.0') && lines.includes('END:VCALENDAR') && lines.includes('BEGIN:VALARM') && lines.includes('TRIGGER:PT0M'));
  assert.ok(lines.includes('DTSTART:20261101T192500'), 'floating local time: no TZID, no Z; the first matching day on or after today (Sun Nov 1)');
  assert.ok(!/TZID|VTIMEZONE|DTSTART[^\n]*Z\r?$/m.test(ics));
  assert.ok(lines.includes('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,SU'));
  assert.ok(lines.includes('DURATION:PT35M'));
  assert.ok(lines.includes('DTSTAMP:20261028T120000Z'));
  assert.ok(lines.includes(`UID:tada-cmaya-${r.id}@tada`));
  const summary = lines.find((l) => l.startsWith('SUMMARY:'));
  assert.strictEqual(summary, 'SUMMARY:Start bedtime - Maya\\, "the\\; boss"\\\\ <b>\\n2', 'commas, semicolons, backslashes and newlines escaped');
  for (const l of ics.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, `folded: ${l}`);
  // morning wording, every day, no name
  const m = C.fromTemplate('school-morning', 'big', ids, { doneBy: '08:00' });
  const ics2 = C.buildIcs({ id: 'cleo', name: '' }, m, { today: '2026-10-28', nowMs: 0 });
  assert.match(ics2, /SUMMARY:Start the morning routine\r\n/);
  assert.match(ics2, /DTSTART:20261028T072100\r\n/);
  // a start before midnight is the evening before
  const early = C.cleanRoutine({ id: 'early', kind: 'morning', name: 'Early', doneBy: '00:20', days: [1], steps: [{ id: 's1', name: 'Wake up', minutes: 30 }] });
  const ics3 = C.buildIcs({ id: 'x' }, early, { today: '2026-10-28', nowMs: 0 });
  assert.match(ics3, /DTSTART:20261101T235000\r\n/, 'Sunday 11:50 PM for a Monday 12:20 AM finish');
  assert.match(ics3, /BYDAY=SU\r\n/);
});

/* ================================================================== *
 * Cleaning, progress, stickers and streaks
 * ================================================================== */

test('cleaning: hostile names stay text (escaped when drawn), invisible characters go, everything bounded, unknown keys dropped', () => {
  const evil = {
    v: 9, extra: 'dropped', __proto__: { polluted: true },
    children: [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `c${i}`, name: HOSTILE[i % HOSTILE.length], avatar: '<svg>', color: 'red', band: 'teen', secret: 'x',
        routines: Array.from({ length: 9 }, (_, j) => ({
          id: `r${j}`, kind: 'party', name: HOSTILE[j % HOSTILE.length], emoji: '<b>', doneBy: '25:99', days: [9, -1, 'x', 3, 3],
          steps: Array.from({ length: 30 }, (_, k) => ({ id: `s${k}`, name: k === 0 ? '' : HOSTILE[k % HOSTILE.length], emoji: '🦩', minutes: k === 1 ? 999 : k === 2 ? -4 : 'lots', game: 'Visit https://evil.example <b>now</b>' })),
        })),
      })),
      { id: 'BAD ID', name: 'x', routines: [] },
    ],
  };
  const f = C.cleanFamily(evil);
  assert.deepStrictEqual(Object.keys(f).sort(), ['children', 'settings', 'updatedAt', 'v']);
  assert.strictEqual(f.v, 1);
  assert.strictEqual(f.children.length, 4, 'four children at most');
  assert.ok(!('polluted' in f) && !('polluted' in {}), 'no prototype pollution');
  const c0 = f.children[0];
  assert.deepStrictEqual(Object.keys(c0).sort(), ['avatar', 'band', 'color', 'id', 'name', 'routines']);
  assert.deepStrictEqual([c0.avatar, c0.color, c0.band], [C.AVATARS[0], 'sun', 'middle']);
  assert.strictEqual(c0.name, '<img src=x onerror=alert', 'markup is kept as text (every draw escapes it), cut to 24 characters');
  assert.strictEqual(f.children[2].name, 'Maya', 'bidi override removed');
  assert.strictEqual(f.children[3].name, 'zerowidth');
  assert.strictEqual(c0.routines.length, C.LIMITS.routinesPerChild);
  const r0 = c0.routines[0];
  assert.deepStrictEqual([r0.kind, r0.emoji, r0.doneBy, r0.days], ['other', '⭐', '17:00', [3]]);
  assert.strictEqual(r0.steps.length, C.LIMITS.steps, 'twenty steps at most; the nameless one is dropped');
  assert.ok(r0.steps.every((s) => s.minutes >= 1 && s.minutes <= 30 && C.emojiOf(s.emoji) === s.emoji && s.name.length <= 40));
  assert.deepStrictEqual(r0.steps.slice(0, 2).map((s) => s.minutes), [30, 1]);
  assert.ok(r0.steps.every((s) => s.game === 'Visit now'), 'a kept game idea loses links and markup');
  assert.ok(!/[\u200b\u202e\n]/.test(JSON.stringify(f)));
  assert.strictEqual(C.cleanFamily('nope'), null);
  assert.strictEqual(C.cleanFamily([]), null);
  assert.strictEqual(C.cleanRoutine({ id: 'r1', steps: [] }), null, 'a routine needs a step');
  assert.ok(C.familyBytes(family()) < 8000, 'a real family is small');
});

test('progress: one key per child, routine and step; a later undo beats an earlier done; 14 days of taps and 400 of stickers', () => {
  const p = C.emptyProgress();
  C.applyTap(p, { day: '2026-10-28', c: 'cmaya', r: 'r1', s: 's1', v: at('2026-10-28T23:00:00Z') });
  C.applyTap(p, { day: '2026-10-28', c: 'cmaya', r: 'r1', s: 's2', v: at('2026-10-28T23:01:00Z') });
  assert.deepStrictEqual([...C.doneIds(p, '2026-10-28', 'cmaya', 'r1')], ['s1', 's2']);
  const other = C.emptyProgress();
  C.applyTap(other, { day: '2026-10-28', c: 'cmaya', r: 'r1', s: 's2', v: -at('2026-10-28T23:05:00Z') });
  C.applyTap(other, { day: '2026-10-28', c: 'cleo', r: 'r9', s: 's1', v: at('2026-10-28T23:02:00Z') });
  const merged = C.mergeProgress(p, other);
  assert.deepStrictEqual([...C.doneIds(merged, '2026-10-28', 'cmaya', 'r1')], ['s1'], 'the later undo wins');
  assert.deepStrictEqual([...C.doneIds(merged, '2026-10-28', 'cleo', 'r9')], ['s1'], 'and both devices\u2019 taps are kept');
  assert.deepStrictEqual(C.mergeProgress(other, p), merged, 'in either order');
  const old = { steps: { '2026-10-14': { cmaya_r1_s1: at('2026-10-14T23:00:00Z') }, '2026-10-15': { cmaya_r1_s1: at('2026-10-15T23:00:00Z') }, 'x<b>': { a: 1 } }, fin: { '2025-09-23': { cmaya_r1: at('2025-09-23T23:00:00Z') }, '2025-09-24': { cmaya_r1: at('2025-09-24T23:00:00Z'), 'bad key': 5, cmaya_r2: -5 } } };
  const kept = C.cleanProgress(old, '2026-10-28');
  assert.deepStrictEqual(Object.keys(kept.steps), ['2026-10-15'], 'fourteen days of taps, today included');
  assert.deepStrictEqual(Object.keys(kept.fin), ['2025-09-24'], 'four hundred days of stickers');
  assert.deepStrictEqual(Object.keys(kept.fin['2025-09-24']), ['cmaya_r1']);
  assert.deepStrictEqual(C.cleanTap({ day: '2026-10-28', c: 'cmaya', r: 'r1', s: 's1', v: 5 }, '2026-10-28'), null, 'a time that is not a time');
  assert.strictEqual(C.cleanTap({ day: '2026-10-01', c: 'cmaya', r: 'r1', s: 's1', v: at('2026-10-01T00:00:00Z') }, '2026-10-28'), null, 'outside the window');
  assert.strictEqual(C.cleanTap({ day: '2026-10-28', c: 'c_x', r: 'r1', s: 's1', v: at('2026-10-28T00:00:00Z') }, '2026-10-28'), null, 'an id with an underscore would break the key');
  assert.deepStrictEqual(C.cleanTap({ day: '2026-10-28', c: 'cmaya', r: 'r1', fin: at('2026-10-28T23:00:00Z'), extra: 1 }, '2026-10-28'), { day: '2026-10-28', c: 'cmaya', r: 'r1', fin: at('2026-10-28T23:00:00Z') });
  assert.strictEqual(C.cleanTap({ day: '2026-10-28', c: 'cmaya', r: 'r1', fin: -at('2026-10-28T23:00:00Z') }, '2026-10-28'), null, 'a sticker is never taken back');
});

test('stickers and streaks: counted in routine runs on their own days; today\u2019s unfinished run is pending, not a miss; no ranking between children', () => {
  const f = family();
  const maya = f.children[0];
  const [morning, bedtime] = maya.routines;
  const p = C.emptyProgress();
  const fin = (day, r) => C.applyTap(p, { day, c: maya.id, r: r.id, fin: at(`${day}T23:00:00Z`) });
  // since Tue Oct 20: every bedtime and every weekday morning, except the morning of Thu Oct 22
  for (let d = '2026-10-20'; d <= '2026-10-27'; d = C.addDays(d, 1)) {
    fin(d, bedtime);
    if (C.runsOn(morning, d) && d !== '2026-10-22') fin(d, morning);
  }
  fin('2026-10-28', morning); // today: morning done, bedtime still to come
  const s = C.streaks(maya, p, '2026-10-28');
  // runs: Oct 20 m b, 21 m b, 22 [m missed] b, 23 m b, 24 b, 25 b, 26 m b, 27 m b, 28 m (b pending)
  assert.deepStrictEqual(s, { current: 10, best: 10, total: 14 });
  const book = C.stickerBook(maya, p);
  assert.strictEqual(book.length, 14);
  assert.strictEqual(book[0].day, '2026-10-28');
  assert.strictEqual(book[0].sticker, C.stickerFor(maya.id, '2026-10-28', morning.id));
  assert.strictEqual(book[0].routineName, 'School morning');
  // Thursday morning: Thursday's runs are still pending, but Wednesday's bedtime was missed
  const missed = C.streaks(maya, p, '2026-10-29');
  assert.deepStrictEqual([missed.current, missed.best, missed.total], [0, 10, 14], 'a fresh start; the best and the stickers stay');
  fin('2026-10-28', bedtime);
  assert.strictEqual(C.streaks(maya, p, '2026-10-29').current, 11, 'finished after all (say, on the other device): the run goes on');
  // a routine added later has no misses before it existed
  const fresh = C.cleanChild({ ...maya, routines: [{ ...bedtime, since: '2026-10-27' }] });
  const p2 = C.emptyProgress();
  C.applyTap(p2, { day: '2026-10-27', c: maya.id, r: bedtime.id, fin: at('2026-10-27T23:00:00Z') });
  assert.strictEqual(C.streaks(fresh, p2, '2026-10-28').current, 1);
  // Leo's book is his own
  assert.strictEqual(C.stickerBook(f.children[1], p).length, 0);
});

/* ================================================================== *
 * The AI: what is sent and what is accepted
 * ================================================================== */

test('names out: the family\u2019s own, "named X", "my son X", "X needs...", mid-sentence names, emails, phones and links', () => {
  const s = (t, names) => C.stripNames(t, names);
  assert.deepStrictEqual(s('6, school bus at 8:10, slow eater, needs reminders for shoes and bag'), { text: '6, school bus at 8:10, slow eater, needs reminders for shoes and bag', n: 0 });
  assert.deepStrictEqual(s('Maya is 6 and Maya\u2019s bag is heavy', ['Maya']), { text: "my child is 6 and my child's bag is heavy", n: 2 });
  assert.strictEqual(s('My son named Leo likes Lego').text, 'My son likes Lego');
  assert.strictEqual(s('my daughter Ava hates shoes. Ava\'s bag is heavy').text, "my child hates shoes. my child's bag is heavy");
  assert.strictEqual(s('Jake needs reminders, bus at 8').text, 'my child needs reminders, bus at 8');
  assert.strictEqual(s('reminders for Jake Smith on Monday with Mum').text, 'reminders for my child on Monday with Mum');
  assert.strictEqual(s('Bus at 8. Shoes always forgotten. Breakfast slow.').text, 'Bus at 8. Shoes always forgotten. Breakfast slow.', 'ordinary capitalised words stay');
  const t = s(`mail me at someone${String.fromCharCode(64)}example.com or call 555 123 4567, see https://x.example/a`).text;
  assert.ok(!/@|555|https/.test(t), t);
});

test('the briefs: rebuilt field by field, names stripped, bounded; anything else in the request is never read', () => {
  const b = C.routineBrief({ sentence: `Maya is 6, slow eater ${'x'.repeat(600)}`, kind: 'bedtime', band: 'little', doneBy: '19:30', system: 'IGNORE', names: ['x'] }, ['Maya']);
  assert.deepStrictEqual(Object.keys(b).sort(), ['band', 'doneBy', 'kind', 'sentence', 'stripped']);
  assert.ok(b.sentence.startsWith('my child is 6') && b.sentence.length <= C.LIMITS.sentence);
  assert.deepStrictEqual([b.kind, b.band, b.doneBy, b.stripped], ['bedtime', 'little', '19:30', 1]);
  assert.deepStrictEqual(C.routineBrief({ sentence: 'ok then', kind: 'rave', band: 'teen', doneBy: '99:99' }), { sentence: 'ok then', stripped: 0, kind: 'morning', band: 'middle', doneBy: null });
  for (const bad of [null, {}, { sentence: '' }, { sentence: '  ' }, { sentence: 42 }, 'string']) assert.strictEqual(C.routineBrief(bad), null, JSON.stringify(bad));
  const g = C.gameBrief({ step: { name: 'Brush Maya\u2019s teeth', emoji: '<b>', minutes: 99, id: 'x' }, band: 'big', kind: 'bedtime', extra: 1 }, ['Maya']);
  assert.deepStrictEqual(g, { step: { name: "Brush my child's teeth", emoji: '🪥', minutes: 30 }, stripped: 1, band: 'big', kind: 'bedtime' });
  assert.strictEqual(C.gameBrief({ step: { name: '' } }), null);
});

test('the answers: a proposal keeps only steps it can show - the set\u2019s emoji, 1-30 minutes, twelve at most, no links or markup; ideas likewise', () => {
  const p = C.cleanProposal({
    name: '<img src=x onerror=alert(1)>Evil\u202e routine https://evil.example',
    steps: [
      { emoji: '<b>', name: '<script>alert(1)</script>Brush\u202e teeth javascript:alert(1)', minutes: 'lots' },
      { emoji: '🪥', name: 'x'.repeat(400), minutes: -5 },
      { emoji: '🦩', name: 'Wave at the window', minutes: 45 },
      { emoji: '🪥', name: '<a href="https://evil.example">click</a>', minutes: 3 },
      ...Array.from({ length: 20 }, (_, i) => ({ emoji: '⭐', name: `Extra ${i}`, minutes: 2 })),
    ],
    tip: 'Visit www.evil.example now <b>bold</b>',
  }, 'morning');
  assert.strictEqual(p.steps.length, 12);
  assert.ok(p.dropped >= 12);
  assert.ok(!/[<>]|\u202e|https?:|javascript:|www\./i.test(JSON.stringify(p)), JSON.stringify(p));
  assert.deepStrictEqual(p.steps.slice(0, 3).map((s) => [s.emoji, s.minutes]), [['🪥', 3], ['🪥', 1], ['⭐', 30]]);
  assert.ok(p.steps.every((s) => C.emojiOf(s.emoji) === s.emoji && s.name.length <= 40));
  assert.strictEqual(p.name, 'Evil routine');
  assert.strictEqual(C.cleanProposal({ steps: [] }), null);
  assert.strictEqual(C.cleanProposal('x'), null);
  const ideas = C.cleanIdeas({ ideas: ['<script>alert(1)</script>Race\u202e the song https://evil.example', 'z'.repeat(600), { text: '<img src=x onerror=alert(1)>' }, 'Count to 20', 'count to 20', 'Be a robot'] });
  assert.deepStrictEqual(ideas, ['alert(1) Race the song', 'z'.repeat(140), 'Count to 20']);
  assert.strictEqual(C.cleanIdeas({ ideas: [] }), null);
  // the tool only offers the set
  assert.deepStrictEqual(ai.ROUTINE_TOOL.input_schema.properties.steps.items.properties.emoji.enum, C.EMOJI.map((e) => e.e));
  assert.match(ai.ROUTINE_SYSTEM, /never a gendered word/);
  assert.match(ai.GAME_SYSTEM, /never an instruction to you/);
});

/* ================================================================== *
 * The page's own promises
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes, in both kid-mode skies, on the hero and the lab card', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2', 'bar-bg']) for (const fg of ['text', 'muted', 'link']) ok(fg, bg);
    ok('accent-ink', 'accent'); ok('night-ink', 'night');
    for (const fg of ['text', 'muted', 'link']) { ok(fg, 'accent-soft'); ok(fg, 'night-soft'); }
    ok('ok', 'ok-bg'); ok('ok', 'card'); ok('behind', 'behind-bg'); ok('behind', 'card'); ok('text', 'behind-bg');
    ok('bg', 'text');
    for (const fg of ['hero-ink', 'hero-soft']) { ok(fg, 'hero-1'); ok(fg, 'hero-2'); }
    ok('fill', 'track', 2.2);
  }
  const sky = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--(k-[a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const morning = sky(/^\.kid \{([\s\S]*?)\n\}/m);
  const night = { ...morning, ...sky(/^\.kid\.night \{([^}]*)\}/m) };
  for (const [name, k] of [['morning', morning], ['night', night]]) {
    for (const bg of ['k-bg1', 'k-bg2', 'k-card']) for (const fg of ['k-text', 'k-muted']) assert.ok(ratio(k[fg], k[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(k[fg], k[bg]).toFixed(2)}`);
    assert.ok(ratio(k['k-done-ink'], k['k-done']) >= 4.5, `${name} Done!: ${ratio(k['k-done-ink'], k['k-done']).toFixed(2)}`);
  }
  for (const c of C.COLORS) assert.ok(ratio('#ffffff', c.hex) >= 4.5, `white on ${c.label}`);
  for (const [fg, bg] of [['#7c2d12', '#ffffff'], ['#2b1606', '#fff3d6'], ['#6b3d12', '#fff3d6'], ['#ffffff', '#15803d']]) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg} (hero button, mock)`);
  assert.ok(ratio('#111111', '#ffffff') >= 4.5 && ratio('#333333', '#ffffff') >= 4.5, 'the printed chart');
  const lab = require('../../../lab').get('tada');
  assert.ok(lab && ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  // tap targets
  for (const sel of ['\\.btn', '\\.link-btn', '\\.seg button, \\.chip', '\\.days button', '\\.tabbar button', '\\.ticks button', '\\.k-sub button', '\\.k-hint button']) {
    assert.ok(new RegExp(`(^|\\n)${sel} \\{[^}]*min-height: (4[4-9]|[5-9]\\d)px`).test(css), `${sel}: 44px`);
  }
  assert.ok(/\.k-done \{[^}]*min-height: 96px/.test(css), 'kid mode\u2019s Done! is 96px tall');
  assert.ok(/\.k-exit \{[^}]*width: 48px; height: 48px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(css), 'motion respects the setting');
  assert.ok(/@media print \{[\s\S]*body > \*:not\(#print\) \{ display: none !important; \}/.test(css), 'printing prints the chart alone');
  assert.ok(!/#(?:ef4444|dc2626|b91c1c|f87171|ff0000)\b/i.test(css.replace(/\.confetti[\s\S]*?\}/, '').replace(/var cols[\s\S]*?;/, '')), 'nothing in the page is red');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, no email, no clock or network in the core, every typed string escaped', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js) && /localStorage\.removeItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/sessionStorage|indexedDB/.test(js));
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^'?]+)/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/game', 'api/ai/routine', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/family', 'api/me', 'api/progress'].sort(), 'the page asks for nothing else');
  const files = ['public/index.html', 'public/app.js', 'public/tada-core.js', 'public/app.css', 'server.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/store.js', 'CLAUDE.md', 'test/run.js'];
  for (const f of files) assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read(f)), `no email address in ${f}`);
  const core = read('public/tada-core.js');
  assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.|indexedDB/.test(core), 'the core touches no network or storage');
  assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(core), 'the core has no dice and no clock');
  assert.ok(!/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/.test(core), 'the core carries no invisible characters of its own');
  assert.ok(!/\(\?<[=!]/.test(core + js), 'no lookbehind: older iPhones cannot parse it');
  // Every interpolation of something a person, the server or a model wrote goes through esc().
  const risky = js.split('\n').filter((l) => !/toast\(|confirm\(|textContent|say\(|speak\(|download\(|\/\/ plain text, escaped whole/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(c\.name|r\.name|s\.name|st\.name|sm\.name|s3\.name|p\.name|e\.message|me\.email|nm|t\.name|t\.blurb|x\.label|b\.routineName|line|lines?\.join\('[^']*'\)|w\.title|w\.when|a\.sentence|shown|safeName|p\.tip|tip|t)\s*\+/g);
  assert.strictEqual(risky, null, `unescaped: ${risky}`);
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bsentence|\bfamily|\bbrief)\b/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /tada-shell-v1/.test(sw) && sw.includes("'tada-core.js'") && /k\.indexOf\('tada-'\) === 0/.test(sw), 'the service worker never answers api/, and owns tada-* caches only');
  // kid mode: nothing in it leads anywhere
  const kid = js.slice(js.indexOf('/* ---------------- kid mode ---------------- */'), js.indexOf('/* ---------------- sheets ---------------- */'));
  assert.ok(kid.length > 4000 && !/<a[\s>]|href=/.test(kid), 'no link in kid mode');
  assert.ok(/hold = setTimeout\(function \(\) \{[^}]*closeKid\(\); \}, 2000\)/.test(kid), 'leaving is a two-second hold');
  assert.ok(/data-act="k-gate"/.test(kid) && /k-gateans/.test(js), 'with a grown-up question as the accessible way out');
  assert.ok(/navigator\.wakeLock/.test(kid), 'the screen stays on');
  // copy never assumes a child's gender
  const words = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').match(/'[^'\n]*'/g).join(' ');
  for (const [f, text] of [['app.js', words(js)], ['index.html', html.replace(/<[^>]+>/g, ' ')], ['tada-core.js templates', JSON.stringify(C.TEMPLATES)]]) {
    const hit = text.match(/\b(he|she|his|hers|him|himself|herself|he's|she's)\b/i);
    assert.strictEqual(hit, null, `${f} uses "${hit && hit[0]}"`);
  }
  assert.match(js, /Your child/);
});

test('local-only switches throw on Cloud Run; the lab prefix is read; there is no query at all', () => {
  for (const [mod, env] of [['./lib/store', { TADA_MEMORY: '1' }], ['./lib/fakeai', { TADA_FAKE_AI: '1' }], ['./server', { TADA_FAKE_AI: '1', TADA_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, TADA_MEMORY: '', TADA_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, TADA_MEMORY: '', TADA_COLLECTION_PREFIX: 'tada_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'tada_ firestore');
  const src = read('lib/store.js');
  assert.ok((src.match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.ok(!/store\.list\(|orderBy|\.where\(/.test(server), 'no query, so no index');
  assert.ok(/mergeDeep\('progress'/.test(server) && !/transact\('progress'/.test(server), 'taps are merged in, never read-and-written whole');
});

/* ================================================================== *
 * Over HTTP
 * ================================================================== */

let base;
let ip6 = 1;
function client() {
  const cookies = {};
  const addr = `2001:db8:${(ip6++).toString(16)}::1`;
  return async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const t = await res.text();
    let data = {}; try { data = JSON.parse(t); } catch (e) { data = { text: t }; }
    return { status: res.status, data, text: t, headers: res.headers };
  };
}
// Test accounts on the reserved example domain, built here so no address is written into a file.
const mail = (who) => `${who}${String.fromCharCode(64)}example.com`;
const uidOf = (email) => Buffer.from(email).toString('base64url');
async function register(who) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
async function login(who) {
  const c = client();
  assert.strictEqual((await c('POST', '/api/auth/login', { email: mail(who), password: 'a long enough password' })).status, 200);
  return c;
}
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const BIG = { x: 'x'.repeat(900 * 1024) };
const today = () => new Date().toISOString().slice(0, 10);
const routineBody = (extra) => ({ sentence: '6, school bus at 8:10, slow eater, needs reminders for shoes and bag', kind: 'morning', band: 'middle', doneBy: '08:10', ...(extra || {}) });
const gameBody = (extra) => ({ step: { name: 'Brush your teeth', emoji: '🪥', minutes: 3 }, band: 'little', kind: 'bedtime', ...(extra || {}) });

test('signed out: the page works with zero model calls; sync, progress and both AI routes answer 401 before reading a body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  assert.strictEqual((await anon('GET', '/api/meta')).data.templates.length, 4);
  for (const f of ['tada-core.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/family'], ['PUT', '/api/family'], ['DELETE', '/api/family'], ['GET', '/api/progress?today=2026-10-28'], ['POST', '/api/progress'], ['POST', '/api/ai/routine'], ['POST', '/api/ai/game']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : { ok: 1 })).status, 401, `${m} ${p}`);
  }
  for (const [m, p] of [['PUT', '/api/family'], ['POST', '/api/progress'], ['POST', '/api/ai/routine'], ['POST', '/api/ai/game']]) assert.strictEqual((await anon(m, p, BIG)).status, 401, `${p}: the gate answers before the parser, so never 413`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the gates come before each parser, in order; one model client, one call site; Haiku free, Sonnet members via planFor', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  for (const p of ['/api/ai/routine', '/api/ai/game']) assert.deepStrictEqual(layer(p, 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser'], p);
  assert.deepStrictEqual(layer('/api/family', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/progress', 'post').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one door to the model');
  assert.strictEqual((read('lib/ai.js').match(/\.messages\.create\(/g) || []).length, 1, 'one call site');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
});

test('sync: the family follows the account; a stale device gets 409 with the account copy; "keep mine" overwrites on purpose; nothing identifying is stored', async () => {
  const phone = await register('sam.sync');
  assert.deepStrictEqual((await phone('GET', '/api/family')).data, { family: null, version: null });
  assert.strictEqual((await phone('PUT', '/api/family', { family: 'nope' })).status, 400);
  assert.strictEqual((await phone('PUT', '/api/family', { family: { children: [] } })).status, 400, 'no children, nothing to keep');
  const f = family();
  f.children[0].name = '<b onclick=x>Maya\u202e';
  const put = await phone('PUT', '/api/family', { family: { ...f, extra: 'dropped' }, base: null });
  assert.strictEqual(put.status, 200, put.text);
  assert.strictEqual(put.data.version, 1);
  assert.strictEqual(put.data.family.children[0].name, '<b onclick=x>Maya', 'kept as text without the bidi character - escaped wherever it is drawn');
  assert.ok(!('extra' in put.data.family));
  const tablet = await login('sam.sync');
  const got = await tablet('GET', '/api/family');
  assert.strictEqual(got.data.version, 1);
  got.data.family.children[1].name = 'Leo from the tablet';
  const fromTablet = await tablet('PUT', '/api/family', { family: got.data.family, base: 1 });
  assert.deepStrictEqual([fromTablet.status, fromTablet.data.version], [200, 2]);
  const stale = await phone('PUT', '/api/family', { family: { ...f, children: [f.children[0]] }, base: 1 });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.data.code, 'conflict');
  assert.strictEqual(stale.data.version, 2);
  assert.strictEqual(stale.data.family.children[1].name, 'Leo from the tablet', 'the 409 carries the account copy, for "use theirs"');
  assert.strictEqual((await phone('PUT', '/api/family', { family: f, base: null })).status, 409, 'a device that never synced cannot overwrite an account copy');
  const keepMine = await phone('PUT', '/api/family', { family: { ...f, children: [f.children[0]] }, base: 2 });
  assert.deepStrictEqual([keepMine.status, keepMine.data.version, keepMine.data.family.children.length], [200, 3, 1], '"keep mine" is a save against the version it was shown');
  const dump = store._dump();
  assert.ok(!dump.includes('sam.sync') && !dump.includes(uidOf(mail('sam.sync'))), 'filed under an HMAC, never the account id or email');
  assert.ok(dump.includes(ownerTag(uidOf(mail('sam.sync')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  const other = await register('kim.other');
  assert.deepStrictEqual((await other('GET', '/api/family')).data, { family: null, version: null }, 'another account sees nothing of it');
  assert.strictEqual((await phone('DELETE', '/api/family')).status, 200);
  assert.deepStrictEqual((await tablet('GET', '/api/family')).data, { family: null, version: null });
});

test('sync: a family over the size cap is refused; saves are limited per account', async () => {
  const a = await register('ana.big');
  const big = C.cleanFamily({
    children: Array.from({ length: 4 }, (_, i) => ({
      id: `c${i}`, name: 'x'.repeat(24),
      routines: Array.from({ length: 6 }, (_, j) => ({ id: `r${j}`, kind: 'other', name: 'y'.repeat(40), steps: Array.from({ length: 20 }, (_, k) => ({ id: `s${k}`, name: 'z'.repeat(40), minutes: 5, game: 'Count to twenty while you do it, then switch sides and count back down again slowly. '.repeat(2) })) })),
    })),
  });
  assert.ok(C.familyBytes(big) > LIMITS.familyBytes);
  const r = await a('PUT', '/api/family', { family: big, base: null });
  assert.deepStrictEqual([r.status, /too much/.test(r.data.error)], [413, true]);
  const f = family();
  let v = null;
  for (let i = 0; i < LIMITS.familyWrites; i++) {
    const s = await a('PUT', '/api/family', { family: f, base: v });
    assert.strictEqual(s.status, 200, `save ${i + 1}`);
    v = s.data.version;
  }
  const over = await a('PUT', '/api/family', { family: f, base: v });
  assert.deepStrictEqual([over.status, /a lot of saving/.test(over.data.error)], [429, true]);
});

test('progress: taps from a phone and a tablet at the same moment all stick; a later undo wins; old days are dropped on write', async () => {
  const phone = await register('pat.taps');
  const tablet = await login('pat.taps');
  const day = today();
  const t0 = Date.now();
  const taps = (who, k) => ({ day, c: who, r: 'rbed', s: `s${k}`, v: t0 + k });
  const sends = [];
  for (let k = 0; k < 10; k++) {
    sends.push(phone('POST', '/api/progress', { today: day, taps: [taps('cmaya', k)] }));
    sends.push(tablet('POST', '/api/progress', { today: day, taps: [taps('cleo', k)] }));
  }
  const results = await Promise.all(sends);
  assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join());
  let got = (await phone('GET', `/api/progress?today=${day}`)).data.progress;
  assert.strictEqual(Object.keys(got.steps[day]).length, 20, 'twenty taps at once, twenty keys');
  assert.deepStrictEqual([...C.doneIds(got, day, 'cleo', 'rbed')].length, 10);
  // the same step undone later on the tablet
  await tablet('POST', '/api/progress', { today: day, taps: [{ day, c: 'cmaya', r: 'rbed', s: 's3', v: -(t0 + 1000) }] });
  got = (await phone('GET', `/api/progress?today=${day}`)).data.progress;
  assert.ok(!C.doneIds(got, day, 'cmaya', 'rbed').has('s3'));
  // a sticker, and the window
  const old = C.addDays(day, -20);
  const tag = ownerTag(uidOf(mail('pat.taps')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret');
  await store.mergeDeep('progress', tag, { steps: { [old]: { cmaya_rbed_s1: t0 - 20 * 86400000 } }, fin: { [old]: { cmaya_rbed: t0 - 20 * 86400000 } } });
  assert.strictEqual((await phone('POST', '/api/progress', { today: day, taps: [{ day, c: 'cmaya', r: 'rbed', fin: t0 + 5 }] })).status, 200);
  const doc = await store.get('progress', tag);
  assert.ok(!(old in doc.steps), 'taps past fourteen days are deleted by the next write');
  assert.ok(old in doc.fin, 'stickers are kept for 400 days');
  assert.ok(doc.fin[day].cmaya_rbed > 0);
  // refusals
  assert.strictEqual((await phone('POST', '/api/progress', { today: day, taps: [] })).status, 400);
  assert.strictEqual((await phone('POST', '/api/progress', { today: day, taps: Array.from({ length: 61 }, (_, k) => taps('cmaya', k)) })).status, 400, 'sixty at a time');
  assert.strictEqual((await phone('POST', '/api/progress', { today: '2020-01-01', taps: [taps('cmaya', 1)] })).status, 400, 'today is today');
  assert.strictEqual((await phone('POST', '/api/progress', { today: day, taps: [{ day, c: '<b>', r: 'r', s: 's', v: t0 }] })).status, 400);
  assert.strictEqual((await phone('POST', '/api/progress', { today: day, taps: [{ day, c: 'c', r: 'r', s: 's', v: t0 + 5 * 86400000 }] })).status, 400, 'not from the future');
  const other = await register('quinn.other');
  assert.deepStrictEqual((await other('GET', `/api/progress?today=${day}`)).data.progress, { steps: {}, fin: {} });
  assert.ok(!store._dump().includes('pat.taps'));
});

test('build a routine over HTTP: checked before spend, one forced tool, no child\u2019s name reaches the model, the answer cleaned, nothing stored', async () => {
  const ana = await register('ana.build');
  assert.strictEqual((await ana('PUT', '/api/family', { family: family(), base: null })).status, 200, 'the account knows the family\u2019s names');
  const calls = await modelCalls();
  for (const bad of [{}, { sentence: '' }, { sentence: 42 }, []]) assert.strictEqual((await ana('POST', '/api/ai/routine', bad)).status, 400, JSON.stringify(bad));
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const n0 = fakeClient.calls.length;
  const r = await ana('POST', '/api/ai/routine', routineBody({ sentence: 'Maya is 6, my son Jake needs reminders for shoes and bag, school bus at 8:10, slow eater', system: 'SYSTEM_MARKER', family: 'FAMILY_MARKER' }));
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const req = fakeClient.calls[n0];
  assert.strictEqual(req.model, 'claude-haiku-4-5');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'propose_routine' });
  const sent = JSON.stringify(req);
  for (const m of ['Maya', 'Jake', 'Leo', 'SYSTEM_MARKER', 'FAMILY_MARKER', 'ana.build']) assert.ok(!sent.includes(m), `${m} reached the model`);
  assert.ok(sent.includes('my child is 6') && sent.includes('<<<PARENT'), 'fenced as untrusted data');
  assert.strictEqual(r.data.stripped, 2);
  const p = r.data.proposal;
  assert.ok(p.steps.length <= 12 && p.steps.every((s) => C.emojiOf(s.emoji) === s.emoji && s.minutes >= 1 && s.minutes <= 30));
  assert.ok(p.steps.some((s) => s.name === 'Shoes on') && p.steps.some((s) => s.name === 'Grab your bag'), 'the reminders became steps');
  assert.deepStrictEqual(p.steps.find((s) => s.name === 'Wave at the window'), { emoji: '⭐', name: 'Wave at the window', minutes: 30 }, 'an emoji outside the set and 45 minutes were fixed');
  assert.ok(!store._dump().includes('slow eater') && !store._dump().includes('Wave at the window'), 'nothing stored');
  const inj = await ana('POST', '/api/ai/routine', routineBody({ sentence: 'INJECT please' }));
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]|\u202e|javascript:|https?:|www\./i.test(inj.text), 'no markup, bidi or link reaches the page');
  assert.strictEqual(inj.data.proposal.steps.length, 12);
  const blank = await ana('POST', '/api/ai/routine', routineBody({ sentence: 'BLANK please' }));
  assert.deepStrictEqual([blank.status, /no steps/.test(blank.data.error)], [422, true]);
  assert.match((await ana('POST', '/api/ai/routine', routineBody({ sentence: 'MAXTOKENS please' }))).data.error, /ran long/);
  const up = await ana('POST', '/api/ai/routine', routineBody({ sentence: 'UPSTREAM401 please' }));
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await ana('POST', '/api/ai/routine', routineBody({ sentence: 'UPSTREAM529 please' }));
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('make a step a game over HTTP: three ideas, each 140 characters at most, no links, no name', async () => {
  const kim = await register('kim.game');
  const n0 = fakeClient.calls.length;
  const r = await kim('POST', '/api/ai/game', gameBody({ step: { name: 'Help Jake brush his teeth', emoji: '🪥', minutes: 3 } }));
  assert.strictEqual(r.status, 200, r.text);
  const req = fakeClient.calls[n0];
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'game_ideas' });
  assert.ok(!JSON.stringify(req).includes('Jake'));
  assert.strictEqual(r.data.ideas.length, 3);
  assert.ok(r.data.ideas.every((t) => t.length <= 140 && !/https?:|<|>/.test(t)));
  const inj = await kim('POST', '/api/ai/game', gameBody({ step: { name: 'INJECT', emoji: '🪥', minutes: 3 } }));
  assert.strictEqual(inj.status, 200);
  assert.ok(!/<[a-z/!]|\u202e|javascript:|https?:/i.test(inj.text));
  assert.ok(inj.data.ideas.length <= 3 && inj.data.ideas.every((t) => t.length <= 140));
  assert.strictEqual((await kim('POST', '/api/ai/game', gameBody({ step: { name: 'BLANK' } }))).status, 422);
  assert.strictEqual((await kim('POST', '/api/ai/game', { step: {} })).status, 400);
});

test('the gates: unconfirmed free account 403, out of credit 402, the day\u2019s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register('eve.unconfirmed');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    for (const [p, body] of [['/api/ai/routine', routineBody()], ['/api/ai/game', gameBody()]]) {
      const r = await eve('POST', p, body);
      assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email'], p);
      assert.strictEqual(r.data.resend, '/tada/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
      assert.strictEqual((await eve('POST', p, BIG)).status, 403, `${p}: 403 before the big body is read`);
    }
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  for (const [p, body] of [['/api/ai/routine', routineBody()], ['/api/ai/game', gameBody()]]) {
    const r = await cal('POST', p, body);
    assert.strictEqual(r.status, 402, p);
    assert.ok(r.data.topUpUrl || r.data.detail || r.data.error, 'the 402 says where credit comes from');
    assert.strictEqual((await cal('POST', p, BIG)).status, 402, `${p}: 402, not 413`);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-tada-${day}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    for (const [p, body] of [['/api/ai/routine', routineBody()], ['/api/ai/game', gameBody()]]) {
      const capped = await dan('POST', p, body);
      assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true], p);
      assert.strictEqual((await dan('POST', p, BIG)).status, 503, `${p}: the ceiling answers before the parser too`);
    }
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-tada-${day}`); }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/tada', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/tada`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
