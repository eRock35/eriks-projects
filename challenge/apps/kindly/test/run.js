// Pure rules first, then end to end against the memory store and the fake
// model:
//   KINDLY_MEMORY=1 KINDLY_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /kindly, the way the
// lab mounts it, so the auth cookie, the budget gate, the sync routes, the
// wishlist links and the metered route's parser are exercised as deployed.
// Model calls are counted from the identity's usage rows - the same rows that
// bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.KINDLY_MEMORY !== '1' || process.env.KINDLY_FAKE_AI !== '1') {
  console.error('run with KINDLY_MEMORY=1 KINDLY_FAKE_AI=1');
  process.exit(1);
}
process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const { app, identityStore, store, fakeClient } = require('../server');
const C = require('../public/kindly-core');
const ai = require('../lib/ai');
const W = require('../lib/wishlists');

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

const T = '2026-10-22';
const NOW = Date.UTC(2026, 9, 22, 15);
const person = (o) => C.cleanPerson({ id: 'person0001', name: 'Maya Ortiz', relationship: 'friend', birthday: { month: 10, day: 26, year: 1993 }, leadDays: 10, ideas: [], ...o }, T);
const HOSTILE = ['<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', '\u202eMaya\u202c', 'Ma\u2066ya\u2069 <script>x</script>'];

/* ---------------- cleaning ---------------- */

test('typed strings go through one door: no markup, no control or bidi characters, bounded; links are https or nothing', () => {
  assert.strictEqual(C.cleanText('<b>Maya</b> Ortiz\u0007', 40), 'Maya Ortiz');
  assert.strictEqual(C.cleanText('<img src=x onerror=alert(1)>', 40), '', 'nothing left of pure markup');
  for (const h of HOSTILE) assert.ok(!/[<>\u202a-\u202e\u2066-\u2069]/.test(C.clean(h, 100)), h);
  assert.strictEqual(Array.from(C.cleanText('🎁'.repeat(300), 40)).length, 40, 'cut on a whole character');
  assert.strictEqual(C.cleanText('a'.repeat(5e6), 40).length, 40, 'a huge string costs linear time and comes back bounded');
  assert.strictEqual(C.cleanLink('www.etsy.com/listing/1'), 'https://www.etsy.com/listing/1');
  for (const bad of ['javascript:alert(1)', 'http://shop.example', 'https://user:pw@x.example/', 'https://x.example/"onmouseover=1', 'data:text/html,hi', 'https://nodot', 'https://a.example/' + 'x'.repeat(400)]) assert.strictEqual(C.cleanLink(bad), '', bad);
  assert.strictEqual(C.hostOf('https://www.Etsy.com/x'), 'etsy.com');
  const p = C.cleanPerson({ id: 'person0001', name: '<script>alert(1)</script>Maya', ideas: [{ id: 'idea0001', text: '<img src=x onerror=1>Mug', link: 'javascript:alert(1)', price: -5 }], notes: { likes: '<b>tea</b>', password: 'x' }, extra: 'dropped' }, T);
  assert.strictEqual(p.name, 'alert(1) Maya');
  assert.deepStrictEqual([p.ideas[0].text, p.ideas[0].link, p.ideas[0].price], ['Mug', '', null]);
  assert.strictEqual(p.notes.likes, 'tea');
  assert.ok(!('extra' in p) && !('password' in p.notes), 'unknown fields are dropped');
  assert.strictEqual(C.cleanPerson({ id: 'person0001', name: '<b></b>' }, T), null, 'a person needs a name');
  assert.strictEqual(C.cleanPerson({ id: '../x', name: 'Maya' }, T), null, 'ids are plain');
});

/* ---------------- dates ---------------- */

test('the next time a date falls: today counts, it rolls over the year end, and the countdown is in whole days', () => {
  const d = { month: 1, day: 2 };
  assert.deepStrictEqual(C.nextOf(d, '2026-12-31'), { day: '2027-01-02', year: 2027 });
  assert.deepStrictEqual(C.nextOf({ month: 12, day: 31 }, '2026-12-31'), { day: '2026-12-31', year: 2026 }, 'today is today, not next year');
  assert.deepStrictEqual(C.nextOf({ month: 12, day: 30 }, '2026-12-31'), { day: '2027-12-30', year: 2027 }, 'yesterday is a year away');
  const p = person({ birthday: { month: 1, day: 1, year: 1990 } });
  const o = C.occasionsOf(p, '2026-12-31')[0];
  assert.deepStrictEqual([o.day, o.inDays, o.n, o.year], ['2027-01-01', 1, 37, 2027], 'age is on the day it falls');
  assert.strictEqual(C.countdown(0), 'Today'); assert.strictEqual(C.countdown(1), 'Tomorrow'); assert.strictEqual(C.countdown(9), 'in 9 days');
  const up = C.upcoming([p, person({ id: 'person0002', name: 'Late', birthday: { month: 3, day: 5 } })], '2026-12-31');
  assert.deepStrictEqual(up.map((x) => x.name), ['Maya Ortiz'], 'only the next 60 days');
  assert.strictEqual(C.nextAfter([person({ birthday: { month: 3, day: 5 } })], '2026-12-31', 60).day, '2027-03-05');
});

test('Feb 29: Feb 28 or Mar 1 outside leap years, the person’s choice; Feb 29 itself in leap years; impossible years dropped', () => {
  const f28 = { month: 2, day: 29, leap: 'feb28' };
  const m1 = { month: 2, day: 29, leap: 'mar1' };
  assert.strictEqual(C.dayIn(f28, 2027), '2027-02-28');
  assert.strictEqual(C.dayIn(m1, 2027), '2027-03-01');
  assert.strictEqual(C.dayIn(m1, 2028), '2028-02-29');
  assert.strictEqual(C.dayIn(f28, 2100), '2100-02-28', '2100 is not a leap year');
  assert.strictEqual(C.dayIn(m1, 2000), '2000-02-29', '2000 is');
  assert.deepStrictEqual(C.nextOf(m1, '2027-02-28'), { day: '2027-03-01', year: 2027 });
  assert.deepStrictEqual(C.nextOf(f28, '2027-03-01'), { day: '2028-02-29', year: 2028 });
  assert.deepStrictEqual(C.nextOf(m1, '2028-03-01'), { day: '2029-03-01', year: 2029 });
  assert.deepStrictEqual(C.cleanDate({ month: 2, day: 29, year: 1944, leap: 'mar1' }, T), { month: 2, day: 29, year: 1944, leap: 'mar1' });
  assert.strictEqual(C.cleanDate({ month: 2, day: 29, year: 1943 }, T).year, null, '1943 had no Feb 29');
  assert.strictEqual(C.cleanDate({ month: 2, day: 29, leap: 'whatever' }, T).leap, 'feb28', 'Feb 28 by default');
  assert.strictEqual(C.cleanDate({ month: 2, day: 30 }, T), null);
  assert.strictEqual(C.cleanDate({ month: 4, day: 31 }, T), null);
  assert.strictEqual(C.cleanDate({ month: 11, day: 3, year: 2026 }, T).year, null, 'a year that puts it in the future is dropped');
  assert.ok(!('leap' in C.cleanDate({ month: 3, day: 1 }, T)));
  const rose = person({ birthday: { month: 2, day: 29, year: 1944, leap: 'mar1' } });
  const o = C.occasionsOf(rose, T)[0];
  assert.deepStrictEqual([o.day, o.n, o.leap], ['2027-03-01', 83, 'mar1']);
  assert.match(C.dateWords(rose.birthday), /kept on Mar 1 in other years/);
});

test('ages and milestones: "turns 40", the named anniversaries, every fifth year of a custom date', () => {
  assert.deepStrictEqual(C.milestone('birthday', 40), { n: 40, words: 'turns 40', short: 'turns 40' });
  for (const n of [1, 16, 18, 21, 30, 50, 100, 105]) assert.ok(C.milestone('birthday', n), `birthday ${n}`);
  for (const n of [2, 33, 41, 99]) assert.strictEqual(C.milestone('birthday', n), null, `birthday ${n}`);
  assert.strictEqual(C.milestone('anniversary', 25).words, '25th - the silver anniversary');
  assert.strictEqual(C.milestone('anniversary', 5).short, '5th anniversary');
  assert.strictEqual(C.milestone('anniversary', 7), null);
  assert.ok(C.milestone('custom', 5) && C.milestone('custom', 1) && !C.milestone('custom', 3));
  assert.strictEqual(C.milestone('birthday', null), null, 'no year, no age, no milestone');
  const p = person({ birthday: { month: 11, day: 24, year: 1986 }, anniversary: { month: 11, day: 10, year: 2001 }, dates: [{ id: 'date0001', label: 'Gotcha day', month: 11, day: 2, year: 2023 }] });
  const occ = C.occasionsOf(p, T);
  assert.deepStrictEqual(occ.map((o) => [o.key, o.n, o.milestone && o.milestone.short]), [['date0001', 3, null], ['anniversary', 25, '25th anniversary'], ['birthday', 40, 'turns 40']]);
  assert.strictEqual(occ[0].emoji, '🐾');
  assert.strictEqual(occ[0].title, 'Maya Ortiz’s gotcha day');
  assert.strictEqual(C.possessive('James'), 'James’');
});

test('lead times: the nudge starts N days before, "order by" counts back the shipping days, too late says so, a ready gift says nothing', () => {
  const p = person({ birthday: { month: 10, day: 31 }, leadDays: 10 });
  const o = C.occasionsOf(p, T, { shipDays: 5 })[0];
  assert.deepStrictEqual([o.inDays, o.nudge, o.orderBy], [9, true, '2026-10-26']);
  assert.strictEqual(C.whenWords(o, T), 'in 9 days · order by Oct 26 to arrive');
  assert.strictEqual(C.stageOf(o, T).words, 'Time to think of something');
  const far = C.occasionsOf({ ...p, leadDays: 3 }, T)[0];
  assert.deepStrictEqual([far.nudge, C.stageOf(far, T).words], [false, 'Nudge from Oct 28']);
  const soon = C.occasionsOf(person({ birthday: { month: 10, day: 24 } }), T, { shipDays: 5 })[0];
  assert.strictEqual(soon.orderBy, null);
  assert.match(C.whenWords(soon, T), /too late to ship/);
  const today = C.occasionsOf(person({ birthday: { month: 10, day: 27 } }), T, { shipDays: 5 })[0];
  assert.match(C.whenWords(today, T), /order today to arrive/);
  const ready = C.occasionsOf(person({ birthday: { month: 10, day: 24 }, ideas: [{ id: 'idea0001', text: 'Mug', status: 'bought', occasion: 'birthday', year: 2026 }] }), T)[0];
  assert.deepStrictEqual([ready.ready, C.whenWords(ready, T), C.stageOf(ready, T).words], [1, 'in 2 days', 'Gift ready']);
  assert.strictEqual(C.cleanPerson({ id: 'person0001', name: 'X', leadDays: 999 }, T).leadDays, 10, 'a lead time out of range is the default');
  assert.strictEqual(C.cleanPerson({ id: 'person0001', name: 'X', leadDays: 0 }, T).leadDays, 0, 'on the day is allowed');
});

test('time zones: the viewer’s own day decides "today", and the sums never drift across a clock change', () => {
  const script = `const C=require('./public/kindly-core');const s=C.sample('2026-10-31',${NOW});
    const t=C.localDay(new Date(Date.UTC(2026,9,22,3,0)));
    const up=C.upcoming(s,'2026-10-31').map(o=>o.title+'@'+o.day+'/'+o.inDays).join('|');
    console.log(JSON.stringify({t,up,dst:C.daysBetween('2026-10-31','2026-11-02'),ics:C.buildIcs(s,{today:'2026-10-31',nowMs:${NOW}})}));`;
  const out = {};
  for (const TZ of ['UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Pacific/Auckland']) {
    const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    out[TZ] = JSON.parse(r.stdout);
  }
  assert.strictEqual(out['America/Los_Angeles'].t, '2026-10-21', 'still the 21st in California at 03:00 UTC');
  assert.strictEqual(out['Asia/Tokyo'].t, '2026-10-22');
  const zones = Object.values(out);
  for (const z of zones) {
    assert.strictEqual(z.up, zones[0].up, 'the same Coming up in every zone for the same day');
    assert.strictEqual(z.ics, zones[0].ics, 'the same calendar file');
    assert.strictEqual(z.dst, 2, 'two days across the US clock change');
  }
});

/* ---------------- ideas, history, budgets ---------------- */

test('given before and the no-repeat rule: similar wording matches, different gifts do not, history is newest first', () => {
  assert.ok(C.similar('Grey cashmere scarf', 'cashmere scarf (grey)'));
  assert.ok(C.similar('Cashmere scarf', 'a scarf, cashmere'));
  assert.ok(C.similar('Pottery classes', 'pottery class'));
  assert.ok(!C.similar('scarf', 'sweater'));
  assert.ok(!C.similar('Coffee subscription', 'Coffee grinder'));
  assert.ok(!C.similar('', 'scarf'));
  const p = person({ ideas: [
    { id: 'idea0001', text: 'Grey cashmere scarf', status: 'given', year: 2024, occasion: 'birthday', price: 5500 },
    { id: 'idea0002', text: 'Coffee subscription, 3 months', status: 'given', year: 2025, occasion: 'birthday' },
    { id: 'idea0003', text: 'Pottery class', status: 'idea' },
    { id: 'idea0004', text: 'Speckled mug', status: 'bought', year: 2026, occasion: 'birthday', price: 3400 },
  ] });
  assert.deepStrictEqual(C.givenBefore(p).map((i) => i.year), [2025, 2024]);
  assert.strictEqual(C.repeatOf(p, 'cashmere scarf in grey').id, 'idea0001');
  assert.strictEqual(C.repeatOf(p, 'a speckled mug').id, 'idea0004', 'already bought counts too');
  assert.strictEqual(C.repeatOf(p, 'pottery class'), null, 'an open idea is not a repeat of itself');
  assert.strictEqual(C.repeatOf(p, 'Wool socks'), null);
  assert.strictEqual(C.cleanIdea({ id: 'idea0009', text: 'x', status: 'idea', year: 2020, occasion: 'birthday' }).year, null, 'an open idea has no year');
});

test('budgets: per occasion, spent counts what was bought or given for that occasion in that year only', () => {
  const p = person({ budgets: { birthday: 6000, anniversary: 9999, junk: 5 }, ideas: [
    { id: 'idea0001', text: 'Mug', status: 'bought', occasion: 'birthday', year: 2026, price: 3400 },
    { id: 'idea0002', text: 'Card', status: 'given', occasion: 'birthday', year: 2026, price: 500 },
    { id: 'idea0003', text: 'Old', status: 'given', occasion: 'birthday', year: 2025, price: 9000 },
    { id: 'idea0004', text: 'Idea', status: 'idea', price: 10000 },
  ] });
  assert.deepStrictEqual(p.budgets, { birthday: 6000 }, 'budgets only for dates the person has');
  const o = C.occasionsOf(p, T)[0];
  assert.deepStrictEqual([o.budget, o.spent], [6000, 3900]);
  assert.strictEqual(C.budgetWords(o), '$39 of $60 · $21 left');
  assert.strictEqual(C.budgetWords({ ...o, spent: 7050 }), '$70.50 of $60 · $10.50 over');
  assert.strictEqual(C.budgetWords({ ...o, budget: null, spent: 0 }), '');
  assert.strictEqual(C.parseMoney('$1,240.50'), 124050); assert.strictEqual(C.parseMoney('about 40'), 4000);
  assert.strictEqual(C.parseMoney('free'), null); assert.strictEqual(C.parseMoney('-40'), null);
  assert.strictEqual(C.fmtMoney(4000), '$40'); assert.strictEqual(C.fmtMoney(4250), '$42.50');
});

/* ---------------- the calendar file ---------------- */

function parseIcs(text) {
  const unfolded = text.replace(/\r\n /g, '');
  const events = unfolded.split('BEGIN:VEVENT').slice(1).map((e) => {
    const o = {};
    for (const line of e.split('\r\n')) { const i = line.indexOf(':'); if (i > 0 && !(line.slice(0, i) in o)) o[line.slice(0, i)] = line.slice(i + 1); }
    return o;
  });
  return { unfolded, events };
}
test('.ics: valid RFC 5545 - CRLF, folded at 75 octets, yearly rules (Feb 29 both ways), a reminder at the lead time, text escaped, no ideas', () => {
  const people = [
    person({ name: 'Maya, "the" ; potter\\', birthday: { month: 10, day: 26, year: 1993 }, leadDays: 14, ideas: [{ id: 'idea0001', text: 'SECRET surprise mug', status: 'idea' }], dates: [{ id: 'date0001', label: 'Gotcha day', month: 11, day: 2 }] }),
    person({ id: 'person0002', name: 'Rose', birthday: { month: 2, day: 29, year: 1944, leap: 'mar1' }, leadDays: 1 }),
    person({ id: 'person0003', name: 'Ann', birthday: { month: 2, day: 29, leap: 'feb28' }, anniversary: { month: 6, day: 1, year: 2010 }, leadDays: 0 }),
    person({ id: 'person0004', name: 'Nobody', birthday: null }),
  ];
  const ics = C.buildIcs(people, { today: T, nowMs: NOW });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'every line ends CRLF');
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `folded: ${line}`);
  assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 5);
  assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, (ics.match(/END:VEVENT/g) || []).length);
  assert.strictEqual((ics.match(/BEGIN:VALARM/g) || []).length, (ics.match(/END:VALARM/g) || []).length);
  const { events } = parseIcs(ics);
  const by = (uid) => events.find((e) => e.UID === uid);
  assert.deepStrictEqual([by('person0001-birthday@kindly')['DTSTART;VALUE=DATE'], by('person0001-birthday@kindly').RRULE], ['20261026', 'FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=26']);
  assert.deepStrictEqual([by('person0002-birthday@kindly')['DTSTART;VALUE=DATE'], by('person0002-birthday@kindly').RRULE], ['20270301', 'FREQ=YEARLY;BYYEARDAY=60']);
  assert.deepStrictEqual([by('person0003-birthday@kindly')['DTSTART;VALUE=DATE'], by('person0003-birthday@kindly').RRULE], ['20270228', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1']);
  assert.strictEqual(by('person0001-date0001@kindly').SUMMARY, '🐾 Maya\\, "the" \\; potter\\\\’s gotcha day', 'TEXT escaped');
  assert.ok(by('person0001-birthday@kindly').DTEND === 'VALUE=DATE:20261027' || /20261027/.test(ics), 'an all-day event');
  const raw = ics.replace(/\r\n /g, '');
  assert.ok(raw.includes('TRIGGER:-P13DT15H'), '14 days before at 9 am');
  assert.ok(raw.includes('TRIGGER:-PT15H'), '1 day before at 9 am');
  assert.ok(raw.includes('TRIGGER:PT9H'), 'and on the day');
  assert.ok(!/SECRET|surprise/.test(raw), 'no gift ideas in a calendar - calendars get shared');
  assert.strictEqual(new Set(events.map((e) => e.UID)).size, events.length, 'unique UIDs');
  // BYYEARDAY=60 is Feb 29 in leap years and Mar 1 in others - the same day dayIn() gives.
  for (const y of [2027, 2028, 2100]) { const jan1 = Date.UTC(y, 0, 1); assert.strictEqual(new Date(jan1 + 59 * 864e5).toISOString().slice(0, 10), C.dayIn({ month: 2, day: 29, leap: 'mar1' }, y)); }
});

/* ---------------- the sample ---------------- */

test('the sample circle: eight made-up people around any today - a birthday in 4 days, a 40th next month, an anniversary, a gotcha day', () => {
  for (const t of [T, '2026-12-31', '2027-01-01', '2028-02-29', '2027-02-25', '2026-06-30']) {
    const s = C.sample(t, NOW);
    assert.strictEqual(s.length, 8, t);
    assert.ok(s.every((p) => p && p.sample && /^sample-/.test(p.id)), t);
    const up = C.upcoming(s, t);
    const maya = up.find((o) => o.id === 'sample-maya');
    assert.ok(maya && maya.inDays === 4 && maya.kind === 'birthday', `${t}: a birthday in 4 days`);
    const forty = up.find((o) => o.milestone && o.milestone.n === 40);
    assert.ok(forty && forty.inDays >= 25 && forty.inDays <= 40, `${t}: a 40th next month`);
    assert.ok(up.some((o) => o.kind === 'anniversary'), `${t}: an anniversary`);
    assert.ok(up.some((o) => o.kind === 'custom' && /gotcha/i.test(o.label)), `${t}: a gotcha day`);
    assert.ok(s.some((p) => C.givenBefore(p).length), 'history');
    assert.ok(s.some((p) => p.ideas.some((i) => i.from === 'them')), 'an idea from them');
    assert.ok(s.some((p) => p.birthday && p.birthday.month === 2 && p.birthday.day === 29), 'a leap-day birthday');
    assert.ok(maya.budget && maya.spent && maya.ready, 'a budget with spending and a gift ready');
  }
});

/* ---------------- what the model may see ---------------- */

test('"Gift ideas for them": the brief carries no name - not as a field, not inside a note', () => {
  const p = person({ name: 'Zelda Quixote', relationship: 'family', notes: { likes: 'Zelda loves jazz; Quixote’s garden', dislikes: 'zelda hates noise', other: 'Ask Zelda’s sister', hasEverything: true } });
  const o = C.occasionsOf(p, T)[0];
  const b = C.aiBrief(p, o);
  const text = JSON.stringify(b);
  assert.ok(!/zelda|quixote/i.test(text), text);
  assert.ok(/them loves jazz/.test(b.likes) && /them garden/.test(b.likes), b.likes);
  assert.deepStrictEqual(Object.keys(b).sort(), ['age', 'allergies', 'budget', 'dislikes', 'hasEverything', 'likes', 'occasion', 'occasionLabel', 'other', 'relationship', 'sizes', 'years'].sort());
  assert.strictEqual(b.age, 33);
  const brief = ai.brief({ ...b, name: 'Zelda Quixote', email: 'z@example.com', notes: 'x' });
  assert.ok(!/zelda|example/i.test(JSON.stringify(brief) + ai.describe(brief)), 'the server reads only the known fields');
  assert.throws(() => ai.brief({}), /Pick who they are/);
  assert.throws(() => ai.brief({ relationship: 'boss', occasion: 'birthday' }), /Pick who they are/);
  assert.ok(!Object.keys(ai.TOOL.input_schema.properties.ideas.items.properties).some((k) => /url|link|href/i.test(k)), 'the tool has no field for a link');
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
    for (const bg of ['bg', 'card', 'card2']) for (const fg of ['text', 'muted', 'link']) ok(fg, bg);
    ok('text', 'accent-soft'); ok('link', 'accent-soft'); ok('muted', 'accent-soft');
    ok('accent-ink', 'accent'); ok('accent', 'card'); ok('accent', 'bg');
    for (const k of ['today', 'ready', 'shop', 'mile', 'info']) { ok(k, `${k}-bg`); ok(k, 'card'); ok(k, 'card2'); }
    ok('text', 'info-bg'); ok('text', 'ready-bg'); ok('text', 'shop-bg'); ok('ink2', 'card'); ok('ink2', 'bg');
    ok('err', 'card'); ok('err', 'bg');
    ok('strip-ink', 'strip'); ok('strip-btn-ink', 'strip-btn');
  }
  assert.ok(ratio('#ffffff', '#a3214a') >= 4.5 && ratio('#ffffff', '#5b2a86') >= 4.5, 'the lab card colours hold white text');
});

test('local-only switches throw on Cloud Run', () => {
  for (const [mod, env] of [['./lib/store', { KINDLY_MEMORY: '1' }], ['./lib/fakeai', { KINDLY_FAKE_AI: '1' }], ['./server', { KINDLY_FAKE_AI: '1', KINDLY_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, KINDLY_MEMORY: '', KINDLY_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured; the one query is a single equality filter, so no composite index', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: ROOT, env: { ...process.env, KINDLY_MEMORY: '', KINDLY_COLLECTION_PREFIX: 'kindly_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = read('lib/store.js');
  assert.ok(/KINDLY_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.deepStrictEqual(server.match(/store\.list\([^)]*\)/g), ["store.list('wishlists', { where: [['creator', '==', tag]], limit: W.LIMITS.openPerCreator * 4 })"]);
  assert.ok(!/orderBy/.test(server));
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, no email, the core has no clock', () => {
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
  assert.ok(/X-Kindly-Key/.test(js) && !/[?&]key=/.test(js), 'the owner key rides in a header, never a URL');
  const core = read('public/kindly-core.js');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js + core + read('server.js') + read('CLAUDE.md')), 'no email address in the files');
  assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(core), 'the core has no dice and no clock');
  assert.match(js, /prefers-reduced-motion/);
  // Every interpolation into markup goes through esc() (or is a number, a fixed string or core output that is itself escaped).
  // (toast() and the messages handed to it draw with textContent, so those lines are not markup.)
  const risky = js.split('\n').filter((l) => !/toast\(|savePerson\(|setIdea\(/.test(l)).join('\n').match(/'\s*\+\s*(p\.name|i\.text|o\.title|n\[k\]|s\.title|s\.why|w\.first|a\.text|rep\.text|x\.text)\s*\+/g);
  assert.strictEqual(risky, null, `unescaped: ${risky}`);
  for (const f of ['server.js', 'lib/ai.js', 'lib/wishlists.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|text|name|notes|likes)/.test(read(f)), `${f} logs a body`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(read('public/sw.js')), 'the service worker never caches the API');
});

/* ---------------- over HTTP ---------------- */

async function register(email, ip) {
  const c = client(ip);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const BRIEF = { relationship: 'friend', age: 33, years: null, occasion: 'birthday', occasionLabel: '', budget: 6000, likes: 'ceramics, coffee', dislikes: 'candles', sizes: '', allergies: '', other: '', hasEverything: false };
const PERSON = { name: 'Sam Lee', relationship: 'partner', birthday: { month: 3, day: 14, year: 1990 }, anniversary: null, dates: [], leadDays: 10, budgets: {}, notes: {}, ideas: [{ id: 'idea0001', text: 'Record crate', status: 'idea' }], wish: null, createdAt: 1, updatedAt: 5 };

test('signed out: everything is free and makes no model call; the metered and sync routes answer 401 before reading a big body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  assert.strictEqual((await anon('GET', '/api/meta')).data.relationships.length, 5);
  for (const f of ['kindly-core.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/ideas', BRIEF)).status, 401);
  assert.strictEqual((await anon('POST', '/api/ideas', { x: 'x'.repeat(12 * 1024 * 1024) })).status, 401, 'the gate answers before the parser');
  assert.strictEqual((await anon('GET', '/api/people')).status, 401);
  assert.strictEqual((await anon('PUT', '/api/people/person0001', { person: PERSON })).status, 401);
  assert.strictEqual((await anon('POST', '/api/people/merge', { people: 'x'.repeat(900 * 1024) })).status, 401, 'refused before its big parser');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the metered route’s gates come before its parser, in order; one model client in the whole server', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ideas', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/people/merge', 'post').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/people/:id', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one door to one metered call');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
});

test('signed in, the circle follows you: one at a time, newer wins on merge, two phones at once, nothing identifying stored', async () => {
  const phoneA = await register('sam.sync@example.com');
  const put = await phoneA('PUT', '/api/people/person0001', { person: { ...PERSON, sample: true, extra: 'dropped' }, today: T });
  assert.strictEqual(put.status, 200, put.text);
  assert.deepStrictEqual(Object.keys(put.data.person).sort(), [...C.SAVED_FIELDS].sort(), 'only the person’s own fields');
  assert.strictEqual((await phoneA('PUT', '/api/people/sample-maya', { person: PERSON })).status, 400, 'the sample stays on the phone');
  assert.strictEqual((await phoneA('PUT', '/api/people/person0002', { person: { name: '<b></b>' } })).status, 400);
  const phoneB = client();
  assert.strictEqual((await phoneB('POST', '/api/auth/login', { email: 'sam.sync@example.com', password: 'a long enough password' })).status, 200);
  assert.deepStrictEqual((await phoneB('GET', '/api/people')).data.people.map((p) => p.name), ['Sam Lee']);
  const m = await phoneB('POST', '/api/people/merge', { today: T, people: [
    { ...PERSON, id: 'person0001', name: 'Old name', updatedAt: 1 },
    { ...PERSON, id: 'person0004', name: 'Leo', updatedAt: Date.now() },
    { ...PERSON, id: 'sample-gas', sample: true },
    { ...PERSON, id: 'person0005', name: '' },
  ] });
  assert.strictEqual(m.status, 200, m.text);
  assert.deepStrictEqual(m.data.people.map((p) => p.name).sort(), ['Leo', 'Sam Lee'], 'the newer copy kept; the sample and the nameless left behind');
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? phoneA : phoneB)('PUT', `/api/people/race${String(i).padStart(6, '0')}`, { person: { ...PERSON, name: `Person ${i}` }, today: T })));
  assert.strictEqual((await phoneA('GET', '/api/people')).data.people.length, 14, 'twelve at once, none lost');
  assert.strictEqual((await phoneB('DELETE', '/api/people/person0004')).status, 200);
  assert.strictEqual((await phoneA('GET', '/api/people')).data.people.length, 13);
  const dump = store._dump();
  assert.ok(!dump.includes('sam.sync') && !dump.includes(uidOf('sam.sync@example.com')), 'filed under an HMAC, never the account id or email');
  const other = await register('kim.other@example.com');
  assert.deepStrictEqual((await other('GET', '/api/people')).data.people, [], 'another account sees its own, empty circle');
  assert.strictEqual((await phoneA('DELETE', '/api/people')).status, 200);
  assert.deepStrictEqual((await phoneB('GET', '/api/people')).data.people, []);
});

test('wishlist links: no account either side; the friend sees only a first name; ideas wait until collected; only the owner collects or closes', async () => {
  const owner = client();
  const made = await owner('POST', '/api/w', { first: 'Maya Ortiz <script>', today: T });
  assert.strictEqual(made.status, 200, made.text);
  const { token, key } = made.data;
  assert.ok(C.TOKEN_RE.test(token) && C.TOKEN_RE.test(key) && token !== key);
  assert.ok(owner.cookies.kindly_k, 'a device key for the open-links cap');
  const dump = store._dump();
  assert.ok(!dump.includes(token) && !dump.includes(key), 'neither the token nor the key is stored');
  assert.ok(!/Ortiz/.test(dump), 'only the first name');
  const friend = client();
  const seen = await friend('GET', `/api/w/${token}`);
  assert.strictEqual(seen.status, 200);
  assert.deepStrictEqual(Object.keys(seen.data.w).sort(), ['expiresAt', 'first', 'room'], 'what the friend sees, exactly');
  assert.deepStrictEqual([seen.data.w.first, seen.data.w.room], ['Maya', W.LIMITS.pending]);
  assert.strictEqual(seen.headers.get('referrer-policy'), 'no-referrer');
  assert.match(seen.headers.get('x-robots-tag'), /noindex/);
  const pageRes = await fetch(`${base}/w/${token}`);
  const pageHtml = await pageRes.text();
  assert.ok(pageHtml.includes('<base href="../">') && pageRes.headers.get('referrer-policy') === 'no-referrer');
  assert.ok(!pageHtml.includes('Maya'), 'the page itself carries nothing of the list');
  for (const bad of [{}, { text: '<img src=x onerror=1>' }]) assert.strictEqual((await friend('POST', `/api/w/${token}/add`, bad)).status, 400);
  const add = await friend('POST', `/api/w/${token}/add`, { text: '<b>Glaze</b> sampler \u202e', link: 'javascript:alert(1)', price: '$30' });
  assert.strictEqual(add.status, 200, add.text);
  assert.deepStrictEqual([add.data.added.text, add.data.added.link, add.data.added.price], ['Glaze sampler', '', 3000]);
  assert.deepStrictEqual(Object.keys(add.data.w).sort(), ['expiresAt', 'first', 'room']);
  await friend('POST', `/api/w/${token}/add`, { text: 'Monstera cutting', link: 'https://example.com/plant' });
  assert.strictEqual((await friend('GET', `/api/w/${token}`, undefined, { 'X-Kindly-Key': 'x'.repeat(22) })).data.w.adds, undefined, 'a wrong key is a friend');
  assert.strictEqual((await friend('POST', `/api/w/${token}/collect`, { ids: [] }, { 'X-Kindly-Key': 'x'.repeat(22) })).status, 404, 'a friend cannot collect');
  assert.strictEqual((await friend('DELETE', `/api/w/${token}`)).status, 404, 'or close it');
  const mine = await owner('GET', `/api/w/${token}`, undefined, { 'X-Kindly-Key': key });
  assert.deepStrictEqual(mine.data.w.adds.map((a) => a.text), ['Glaze sampler', 'Monstera cutting']);
  const col = await owner('POST', `/api/w/${token}/collect`, { ids: [mine.data.w.adds[0].id] }, { 'X-Kindly-Key': key });
  assert.deepStrictEqual(col.data.w.adds.map((a) => a.text), ['Monstera cutting'], 'collected ideas leave the server');
  // The cap.
  const many = await Promise.all(Array.from({ length: W.LIMITS.pending + 3 }, (_, i) => client()('POST', `/api/w/${token}/add`, { text: `Idea ${i}` })));
  assert.strictEqual(many.filter((r) => r.status === 200).length, W.LIMITS.pending - 1, 'never more than the cap waiting, even at once');
  assert.ok(many.filter((r) => r.status === 409).every((r) => /ideas waiting/.test(r.data.error)));
  // Closing, expiry and a wrong token all read the same.
  assert.strictEqual((await owner('DELETE', `/api/w/${token}`, undefined, { 'X-Kindly-Key': key })).status, 200);
  const gone = await friend('GET', `/api/w/${token}`);
  const never = await friend('GET', `/api/w/${'A'.repeat(22)}`);
  const junk = await friend('GET', '/api/w/not-a-token');
  assert.deepStrictEqual([gone.status, never.status, junk.status], [404, 404, 404]);
  assert.ok(gone.data.error === never.data.error && never.data.error === junk.data.error, 'one answer for all three');
  const t2 = (await owner('POST', '/api/w', { first: 'Leo' })).data.token;
  await store.transact('wishlists', W.docId(t2), (cur) => ({ ...cur, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  assert.strictEqual((await friend('GET', `/api/w/${t2}`)).status, 404, 'expired');
  assert.strictEqual(await store.get('wishlists', W.docId(t2)), null, 'and deleted by the read that found it');
  assert.strictEqual((await owner('POST', '/api/w', { first: '<i></i>' })).status, 400);
  assert.strictEqual((await fetch(`${base}/w/${token}`, { method: 'POST' })).status, 405);
});

test('wishlist limits: links per address an hour, distinct wrong tokens, ideas per address', async () => {
  const ip = '198.51.100.7';
  const c = client(ip);
  const made = [];
  for (let i = 0; i < W.LIMITS.createsPerIp + 2; i++) made.push((await c('POST', '/api/w', { first: `P${i}` })).status);
  assert.strictEqual(made.filter((s) => s === 200).length, W.LIMITS.createsPerIp);
  assert.strictEqual(made[made.length - 1], 429);
  const g = client('198.51.100.8');
  for (let i = 0; i < W.LIMITS.missesPerIp; i++) await g('GET', `/api/w/${String(i).padStart(22, 'B')}`);
  const real = (await client()('POST', '/api/w', { first: 'Ann' })).data.token;
  assert.strictEqual((await g('GET', `/api/w/${real}`)).status, 429, 'past 30 distinct wrong tokens, even a real one waits');
  const same = client('198.51.100.9');
  for (let i = 0; i < 40; i++) await same('GET', `/api/w/${'C'.repeat(22)}`);
  assert.strictEqual((await same('GET', `/api/w/${real}`)).status, 200, 'one dead link polled again is not guessing');
  const adder = client('198.51.100.10');
  const owners = [];
  for (let i = 0; i < 3; i++) owners.push((await client()('POST', '/api/w', { first: `Q${i}` })).data.token);
  let ok = 0, limited = 0;
  for (let i = 0; i < W.LIMITS.addsPerIp + 5; i++) { const r = await adder('POST', `/api/w/${owners[i % 3]}/add`, { text: `Idea ${i}` }); if (r.status === 200) ok++; if (r.status === 429) limited++; }
  assert.deepStrictEqual([ok, limited], [W.LIMITS.addsPerIp, 5]);
});

test('gift ideas: checked before any spend, one forced tool, cleaned (no links, no markup, five at most), nothing stored, the name never sent', async () => {
  const me = await register('ana.ideas@example.com');
  const dump = store._dump();
  const calls = await modelCalls();
  for (const body of [{}, { relationship: 'boss', occasion: 'birthday' }, { relationship: 'friend', occasion: 'wedding' }]) assert.strictEqual((await me('POST', '/api/ideas', body)).status, 400);
  assert.strictEqual((await me('POST', '/api/ideas', { x: 'x'.repeat(20 * 1024) })).status, 413, 'its own 8 KB parser, after the gates');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  fakeClient.seen.length = 0;
  const r = await me('POST', '/api/ideas', { ...BRIEF, name: 'Zelda Quixote', email: 'zelda@example.com', likes: 'Ceramics and jazz' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.data.ideas.length, 5);
  for (const i of r.data.ideas) assert.deepStrictEqual(Object.keys(i).sort(), ['priceRange', 'searchQuery', 'title', 'why']);
  assert.strictEqual(fakeClient.calls[fakeClient.calls.length - 1], 'suggest_gifts', 'one forced tool');
  assert.strictEqual(fakeClient.seen.length, 1);
  assert.ok(!/zelda|quixote|example\.com/i.test(fakeClient.seen[0]), 'the name never reaches the model');
  assert.ok(/Ceramics and jazz/.test(fakeClient.seen[0]) && /Age on the day: 33/.test(fakeClient.seen[0]) && /about \$60/.test(fakeClient.seen[0]));
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const inj = await me('POST', '/api/ideas', { ...BRIEF, likes: 'INJECT' });
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text), 'no markup or bidi');
  assert.ok(!/https?:|www\.|evil|javascript/i.test(inj.text), 'no links from the model, anywhere');
  assert.ok(inj.data.ideas.length <= 5 && new Set(inj.data.ideas.map((i) => i.title)).size === inj.data.ideas.length, 'five at most, no duplicates');
  assert.ok(inj.data.ideas.every((i) => !('link' in i)));
  assert.deepStrictEqual(['$30-50', 'about $20', '$100+', 'Free-$20', 'javascript:alert(1)', 'call 555 0100', '12 easy payments'].map((v) => ai.cleanSuggestions({ ideas: [{ title: 'X', priceRange: v }] })[0].priceRange), ['$30-50', 'about $20', '$100+', 'Free-$20', '', '', ''], 'a price range is a price range');
  assert.match(C.searchUrl('mug & "tea"'), /^https:\/\/duckduckgo\.com\/\?q=mug%20%26%20%22tea%22$/, 'the page builds a plain search link');
  assert.strictEqual((await me('POST', '/api/ideas', { ...BRIEF, likes: 'BLANK' })).status, 422);
  assert.match((await me('POST', '/api/ideas', { ...BRIEF, likes: 'MAXTOKENS' })).data.error, /ran long/);
  const up = await me('POST', '/api/ideas', { ...BRIEF, likes: 'UPSTREAM401' });
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await me('POST', '/api/ideas', { ...BRIEF, likes: 'UPSTREAM529' });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  assert.strictEqual(store._dump(), dump, 'suggesting stores nothing');
});

test('the gates: an unconfirmed free account gets verify-email 403, out of credit 402, the day’s free ceiling 503 - never a 413, never a model call', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/ideas', BRIEF);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/kindly/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/ideas', { x: 'x'.repeat(12 * 1024 * 1024) })).status, 403, '403 before the body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('PUT', '/api/people/person0001', { person: PERSON, today: T })).status, 200, 'syncing needs no AI and no confirmation');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ideas', BRIEF)).status, 402);
  assert.strictEqual((await cal('POST', '/api/ideas', { x: 'x'.repeat(12 * 1024 * 1024) })).status, 402, '402, not 413');
  const dan = await register('dan.capped@example.com');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-kindly-${day}`, { usd: 5000 });
  try {
    const capped = await dan('POST', '/api/ideas', BRIEF);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ideas', { x: 'x'.repeat(12 * 1024 * 1024) })).status, 503, 'the ceiling answers before the parser too');
  } finally { await identityStore.remove('control', `free-spend-kindly-${day}`); }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'none of them spent anything');
  assert.strictEqual((await dan('POST', '/api/ideas', BRIEF)).status, 200, 'and it lifts when the day’s tally is under it');
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use((req, res, next) => (req.path === '/kindly' ? res.redirect(301, '/kindly/') : next()));
  host.use('/kindly', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/kindly`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (e) { failed++; console.log(`  FAIL ${t.name}\n${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
