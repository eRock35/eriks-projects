// Pure rules first, then end to end against the memory store and the fake
// model:
//   BOOTH_MEMORY=1 BOOTH_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /booth, the way the
// lab mounts it, so the auth cookie, the budget gate, per-event membership and
// the share link are exercised as deployed. Model calls are counted from the
// identity's usage rows - the same rows that bill a real account.

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.BOOTH_MEMORY !== '1' || process.env.BOOTH_FAKE_AI !== '1') {
  console.error('run with BOOTH_MEMORY=1 BOOTH_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const B = require('../public/rules');
const E = require('../lib/events');
const ai = require('../lib/ai');
const { demo, build, ROWS, MEMBERS } = require('../lib/demo');

const H = B.HOUR;
let base;
function client() {
  let cookie = '';
  return async function call(method, p, body, headers = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) { data = { text }; }
    return { status: res.status, data, headers: res.headers };
  };
}

const uidOf = (email) => Buffer.from(email).toString('base64url');
/** The opaque id the people list gives a teammate. */
async function idOf(who, name) {
  const r = await who('GET', `/api/events/${EV.id}`);
  return r.data.people.find((p) => p.name === name).id;
}
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15)); // the meter writes usage rows fire-and-forget

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]).toString('base64');
const withText = (s) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(s), Buffer.alloc(500, 3)]).toString('base64');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const T0 = Date.parse('2026-09-22T15:00:00Z');
const at = (h) => new Date(T0 + h * H).toISOString();
const lead = (o) => ({ id: o.id || 'x', temp: 'warm', capturedAt: at(0), capturedBy: 'u1', status: 'new', ...o });

/* ---------------- pure: the clock ---------------- */

test('cold clocks: hot goes cold after 48h, warm after 5 days, cold after 14', () => {
  const hot = lead({ temp: 'hot' });
  assert.strictEqual(B.clock(hot, T0 + 1 * H).state, 'fresh');
  assert.strictEqual(B.clock(hot, T0 + 36.5 * H).state, 'cooling', 'under 12 hours left is cooling');
  assert.strictEqual(B.clock(hot, T0 + 47.9 * H).state, 'cooling');
  const c = B.clock(hot, T0 + 50 * H);
  assert.deepStrictEqual([c.state, c.overMs, c.dueAt], ['cold', 2 * H, at(48)]);
  assert.strictEqual(B.clockLabel(c), 'Went cold 2h ago');
  const warm = lead({ temp: 'warm' });
  assert.strictEqual(B.clock(warm, T0 + 119 * H).state, 'cooling');
  assert.strictEqual(B.clock(warm, T0 + 80 * H).state, 'fresh');
  assert.strictEqual(B.clock(warm, T0 + 121 * H).state, 'cold');
  assert.strictEqual(B.clock(lead({ temp: 'cold' }), T0 + 200 * H).state, 'fresh', 'cold leads get 14 days');
  assert.strictEqual(B.clock(lead({ temp: 'cold' }), T0 + 300 * H).state, 'cooling', 'the last quarter of any window is cooling');
  assert.strictEqual(B.clock(lead({ temp: 'cold' }), T0 + 337 * H).state, 'cold');
  assert.strictEqual(B.clockLabel(B.clock(hot, T0 + 10 * H)), 'Goes cold in 1d 14h');
  assert.strictEqual(Math.round(B.clock(hot, T0 + 12 * H).pct * 100), 75);
});

test('a follow-up stops the clock: on time, late, and closed', () => {
  const sent = B.clock(lead({ temp: 'hot', sentAt: at(3) }), T0 + 100 * H);
  assert.deepStrictEqual([sent.state, sent.onTime, sent.tookMs], ['done', true, 3 * H]);
  assert.strictEqual(B.clockLabel(sent), 'Followed up in 3h');
  const late = B.clock(lead({ temp: 'hot', sentAt: at(60) }), T0 + 100 * H);
  assert.deepStrictEqual([late.state, late.onTime], ['done', false]);
  assert.match(B.clockLabel(late), /late/);
  assert.strictEqual(B.clock(lead({ temp: 'hot', lostAt: at(2) }), T0 + 100 * H).state, 'closed', 'lost without a follow-up is closed, not cold');
  assert.deepStrictEqual([B.duration(0), B.duration(59 * 60000), B.duration(3 * H + 5 * 60000), B.duration(49 * H)], ['under a minute', '59m', '3h 5m', '2d 1h']);
});

test('going cold: savable leads first, soonest first; followed-up and closed leads never on it', () => {
  const leads = [
    lead({ id: 'a', temp: 'warm', capturedAt: at(0) }),
    lead({ id: 'b', temp: 'hot', capturedAt: at(0) }),
    lead({ id: 'c', temp: 'hot', capturedAt: at(-60) }),
    lead({ id: 'd', temp: 'hot', capturedAt: at(0), sentAt: at(1) }),
    lead({ id: 'e', temp: 'hot', capturedAt: at(-10), wonAt: at(5), sentAt: at(2) }),
    lead({ id: 'f', temp: 'hot', capturedAt: at(-50) }),
  ];
  assert.deepStrictEqual(B.goingCold(leads, T0 + 40 * H).map((r) => r.lead.id), ['b', 'a', 'f', 'c']);
});

/* ---------------- pure: a lead ---------------- */

test('validateLead: formats, bounds, markup, a temperature, and only the event’s chips', () => {
  const chips = ['Demo', 'Pricing'];
  const ok = B.validateLead({ name: ' <b>Dana</b>  Whitfield ', company: 'Magnolia', email: ' Dana@Example.COM ', phone: '+1 (404) 555-0142', temp: 'hot', chips: ['pricing', 'Nope', 'Pricing', '<i>Demo</i>'], next: 'call', note: 'Wants <script>x</script> 5 lb bags\n\n\n\nfor 3 stores' }, { chips });
  assert.ok(ok.lead, JSON.stringify(ok));
  assert.strictEqual(ok.lead.name, 'Dana Whitfield', 'markup stripped');
  assert.strictEqual(ok.lead.email, 'dana@example.com', 'email lowercased');
  assert.deepStrictEqual(ok.lead.chips, ['Pricing', 'Demo'], 'only the event’s chips, in its spelling, once');
  assert.ok(!/[<>]/.test(ok.lead.note) && !/\n\n\n/.test(ok.lead.note));
  const err = (raw) => B.validateLead({ temp: 'warm', name: 'X', ...raw }, { chips }).field;
  assert.strictEqual(B.validateLead({ temp: 'hot' }).field, 'name', 'somebody has to be named or reachable');
  assert.strictEqual(err({ email: 'dana(at)example' }), 'email');
  assert.strictEqual(err({ email: 'a..b@example.com' }), 'email');
  assert.strictEqual(err({ phone: '12' }), 'phone');
  assert.strictEqual(err({ phone: 'call me maybe' }), 'phone');
  assert.strictEqual(err({ temp: 'lukewarm' }), 'temp');
  assert.strictEqual(err({ next: 'fax' }), 'next');
  assert.strictEqual(err({ value: -5 }), 'value');
  assert.strictEqual(err({ value: 'lots' }), 'value');
  assert.strictEqual(B.validateLead({ temp: 'cold', email: 'solo@example.com' }).lead.email, 'solo@example.com', 'an email alone is enough');
  assert.ok(B.isPhone('404.555.0142 ext. 12') && B.isPhone('+44 20 7946 0958') && !B.isPhone('1234567890123456'));
  assert.strictEqual(B.validateLead({ temp: 'hot', name: 'x'.repeat(500) }).lead.name.length, B.LIMITS.name);
});

test('dedupe: the same email (any case) or phone (any punctuation) at one event', () => {
  const leads = [
    { id: 'a', email: 'dana@example.com', phone: '' },
    { id: 'b', email: '', phone: '(404) 555-0142' },
  ];
  assert.deepStrictEqual(B.findDuplicate(leads, { email: 'DANA@example.com' }).lead.id, 'a');
  assert.strictEqual(B.findDuplicate(leads, { email: 'DANA@example.com' }).by, 'email');
  assert.strictEqual(B.findDuplicate(leads, { phone: '+1 404.555.0142' }).lead.id, 'b');
  assert.strictEqual(B.findDuplicate(leads, { phone: '+1 404.555.0142' }).by, 'phone');
  assert.strictEqual(B.findDuplicate(leads, { phone: '404 555 0199' }), null);
  assert.strictEqual(B.findDuplicate(leads, { email: 'dana@example.com' }, 'a'), null, 'a lead is not its own twin');
  assert.strictEqual(B.findDuplicate(leads, { name: 'Dana' }), null, 'names alone are not matched - two Danas are common');
  assert.strictEqual(B.phoneKey('12'), '', 'too short to match on');
});

test('merge: gaps filled, nothing overwritten, hotter temperature, both notes', () => {
  const first = { name: 'Dana Whitfield', company: '', email: 'dana@example.com', phone: '', temp: 'warm', chips: ['Demo'], next: 'call', note: 'Asked about decaf.' };
  const second = { name: 'D. Whitfield', company: 'Magnolia', email: 'dana@example.com', phone: '404-555-0142', temp: 'hot', chips: ['Pricing', 'Demo'], next: 'quote', note: 'Wants a quote this week.' };
  const p = B.mergePatch(first, second, 'Theo');
  assert.deepStrictEqual(p, { company: 'Magnolia', phone: '404-555-0142', chips: ['Demo', 'Pricing'], temp: 'hot', note: 'Asked about decaf.\nTheo: Wants a quote this week.' });
  assert.deepStrictEqual(B.mergePatch({ ...first, temp: 'hot' }, { ...first, temp: 'cold', note: '' }), {}, 'a colder, emptier second capture changes nothing');
});

test('status: climbing the ladder stamps what it passes; stepping back clears; lost closes', () => {
  const l = { status: 'new' };
  const won = B.applyStatus(l, 'won', 'T1', 'u2', 4800);
  assert.deepStrictEqual([won.sentAt, won.repliedAt, won.bookedAt, won.wonAt, won.value, won.sentBy], ['T1', 'T1', 'T1', 'T1', 4800, 'u2']);
  const back = B.applyStatus({ ...l, ...won }, 'replied', 'T2', 'u3');
  assert.deepStrictEqual([back.bookedAt, back.wonAt, back.sentAt, back.repliedAt, back.sentBy], [null, null, undefined, undefined, undefined], 'earlier stamps kept, later ones cleared, sender kept');
  const lost = B.applyStatus({ ...l, sentAt: 'T0' }, 'lost', 'T3');
  assert.deepStrictEqual([lost.lostAt, lost.wonAt], ['T3', null]);
  assert.strictEqual(B.applyStatus(l, 'maybe'), null);
  const undo = B.applyStatus({ ...l, sentAt: 'T0', sentBy: 'u1' }, 'new', 'T4');
  assert.deepStrictEqual([undo.sentAt, undo.sentBy], [null, null]);
});

/* ---------------- pure: leaderboard and scorecard ---------------- */

test('leaderboard: points, attribution, streaks, badges and ties', () => {
  const members = [{ uid: 'maya', name: 'Maya', role: 'owner' }, { uid: 'theo', name: 'Theo', role: 'staff' }, { uid: 'priya', name: 'Priya', role: 'staff' }];
  const L = [
    lead({ id: '1', capturedBy: 'theo', temp: 'hot', capturedAt: at(0) }),
    lead({ id: '2', capturedBy: 'theo', temp: 'hot', capturedAt: at(1) }),
    lead({ id: '3', capturedBy: 'theo', temp: 'warm', capturedAt: at(2) }),
    lead({ id: '4', capturedBy: 'theo', temp: 'hot', capturedAt: at(3) }),
    lead({ id: '5', capturedBy: 'theo', temp: 'hot', capturedAt: at(4) }),
    lead({ id: '6', capturedBy: 'theo', temp: 'hot', capturedAt: at(5) }),
    // Theo captured it; Maya sent the follow-up in 30 minutes and won it.
    lead({ id: '7', capturedBy: 'theo', temp: 'warm', capturedAt: at(6), sentAt: at(6.5), sentBy: 'maya', repliedAt: at(8), bookedAt: at(9), wonAt: at(20), value: 5000 }),
  ];
  const rows = B.leaderboard(members, L, T0 + 100 * H, { boothCost: 3000 });
  const by = Object.fromEntries(rows.map((r) => [r.uid, r]));
  assert.deepStrictEqual([by.theo.captured, by.theo.hot, by.theo.warm, by.theo.wentCold], [7, 5, 2, 5], 'the unsent warm lead still has time');
  assert.deepStrictEqual([by.theo.streak, by.theo.bestStreak], [0, 3], 'the run broke on the last capture; the best run was three');
  assert.strictEqual(by.theo.points, 7 * B.POINTS.lead + 5 * B.POINTS.hot);
  assert.deepStrictEqual([by.maya.followUps, by.maya.onTime, by.maya.replies, by.maya.meetings, by.maya.won, by.maya.wonValue], [1, 1, 1, 1, 1, 5000]);
  assert.strictEqual(by.maya.points, B.POINTS.onTime + B.POINTS.reply + B.POINTS.meeting + B.POINTS.won);
  assert.deepStrictEqual(by.theo.badges, ['first', 'hothand']);
  assert.deepStrictEqual(by.maya.badges, ['quick', 'closer', 'rainmaker'], 'follow-up badges go to whoever followed up');
  assert.deepStrictEqual(rows.map((r) => [r.uid, r.rank]), [['theo', 1], ['maya', 2], ['priya', 3]]);
  const tie = B.leaderboard(members.slice(0, 2), [lead({ capturedBy: 'maya' }), lead({ id: 'y', capturedBy: 'theo' })], T0);
  assert.deepStrictEqual(tie.map((r) => r.rank), [1, 1], 'equal points share a rank');
  const ice = B.leaderboard([members[2]], [1, 2, 3, 4, 5].map((i) => lead({ id: `p${i}`, capturedBy: 'priya', temp: 'hot', capturedAt: at(i), sentAt: at(i + 1) })), T0 + 99 * H);
  assert.ok(ice[0].badges.includes('nocold') && ice[0].badges.includes('hothand'));
});

test('scorecard: temperatures, the 48-hour rate, the funnel, pipeline and ROI', () => {
  const L = [
    lead({ id: '1', temp: 'hot', sentAt: at(2), repliedAt: at(5), bookedAt: at(9), wonAt: at(30), value: 4800, chips: ['Demo'] }),
    lead({ id: '2', temp: 'hot', sentAt: at(60), value: 2000, chips: ['Demo', 'Pricing'] }),
    lead({ id: '3', temp: 'warm', sentAt: at(47), repliedAt: at(50), value: 1000, next: 'call' }),
    lead({ id: '4', temp: 'warm', lostAt: at(3), value: 9999 }),
    lead({ id: '5', temp: 'cold', capturedAt: at(24) }),
    lead({ id: '6', temp: 'hot', capturedAt: at(24) }),
  ];
  const s = B.scorecard({ boothCost: 3200 }, L, T0 + 80 * H);
  assert.deepStrictEqual(s.temps, { hot: 3, warm: 2, cold: 1 });
  assert.deepStrictEqual([s.leads, s.followedUp, s.within48, s.within48Rate, s.onTime, s.wentCold], [6, 3, 2, 33, 2, 1]);
  assert.deepStrictEqual([s.replies, s.meetings, s.won, s.lost], [2, 1, 1, 1]);
  assert.deepStrictEqual([s.wonValue, s.pipelineValue], [4800, 3000], 'pipeline is open deals only - not won, not lost');
  assert.strictEqual(s.costPerLead, 533.33);
  assert.strictEqual(s.costPerMeeting, 3200);
  assert.strictEqual(s.roi, 50, '(4800 - 3200) / 3200');
  assert.strictEqual(s.coverage, 2.4);
  assert.deepStrictEqual(s.funnel.map((f) => f.n), [6, 3, 2, 1, 1]);
  assert.deepStrictEqual(s.chips, [{ chip: 'Demo', n: 2 }, { chip: 'Pricing', n: 1 }]);
  assert.strictEqual(s.verdict.key, 'paid');
  assert.strictEqual(B.scorecard({ boothCost: 10000 }, L, T0 + 80 * H).verdict.key, 'cold');
  assert.strictEqual(B.scorecard({ boothCost: 7000 }, L, T0 + 80 * H).verdict.key, 'pipeline');
  assert.strictEqual(B.scorecard({ boothCost: 0 }, [], T0).verdict.key, 'empty');
  const free = B.scorecard({ boothCost: 0 }, L, T0 + 80 * H);
  assert.deepStrictEqual([free.roi, free.costPerLead, free.coverage], [null, null, null], 'no cost, no ROI - never a divide by zero');
  assert.strictEqual(B.money(1234567.4), '$1,234,567');
});

/* ---------------- pure: CSV ---------------- */

test('CSV: quoting, and formula injection kept as text', () => {
  assert.strictEqual(E.csvCell('plain'), 'plain');
  assert.strictEqual(E.csvCell('a, b'), '"a, b"');
  assert.strictEqual(E.csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(E.csvCell('two\nlines'), '"two\nlines"');
  assert.strictEqual(E.csvCell('=HYPERLINK("http://x","y")'), '"\'=HYPERLINK(""http://x"",""y"")"');
  for (const bad of ['=1+1', '+1 404 555 0142', '-2+3', '@SUM(A1)', '\tx', '\rx']) {
    assert.strictEqual(E.csvCell(bad).replace(/^"/, '').charAt(0), "'", JSON.stringify(bad));
  }
  assert.strictEqual(E.csvCell(null), '');
  assert.strictEqual(E.csvCell(4800), '4800');
  const csv = E.toCsv([{ ...E.leadView(lead({ name: '=cmd|calc', company: 'Acme, Inc.', note: 'line1\nline2', temp: 'hot', capturedByName: 'Theo', value: 10 }), T0) }]);
  assert.ok(csv.startsWith('﻿Name,Company,Title,Email,Phone,Temperature'), 'BOM and header');
  assert.ok(csv.includes('\r\n') && csv.endsWith('\r\n'));
  assert.ok(csv.includes("'=cmd|calc") && csv.includes('"Acme, Inc."') && csv.includes('"line1\nline2"'));
  assert.strictEqual(E.csvFilename('Food & Bev Expo 2026!', '2026-09-25'), 'booth-food-bev-expo-2026-2026-09-25.csv');
});

/* ---------------- pure: templates and the model's answers ---------------- */

test('templates: one per temperature, only what was captured, and a mailto that opens the rep’s mail app', () => {
  const ev = { name: 'Southeast Food & Bev Expo 2026' };
  const l = { name: 'Dana Whitfield', company: 'Magnolia', temp: 'hot', chips: ['Pricing', 'Samples'], next: 'quote', note: 'SECRET: budget is tight' };
  const hot = B.template(l, ev, { name: 'Maya', signoff: 'Maya · Brightline' });
  assert.strictEqual(hot.subject, 'Great to meet you at Southeast Food & Bev Expo 2026');
  assert.match(hot.body, /^Hi Dana,/);
  assert.match(hot.body, /You asked about pricing and samples\./);
  assert.match(hot.body, /quote/);
  assert.ok(hot.body.endsWith('Maya · Brightline'));
  assert.ok(!hot.body.includes('SECRET'), 'the rep’s private note is never quoted');
  const bodies = B.TEMP_KEYS.map((t) => B.template({ ...l, temp: t }, ev, {}).body);
  assert.strictEqual(new Set(bodies).size, 3, 'hot, warm and cold read differently');
  assert.ok(bodies.every((b) => !/\d/.test(b.replace('2026', ''))), 'no invented numbers');
  assert.match(B.template({ temp: 'warm' }, {}, {}).body, /^Hi there,/);
  const m = B.mailto('Dana@Example.com', 'Hi & bye', 'Line 1\nLine 2');
  assert.strictEqual(m, 'mailto:dana@example.com?subject=Hi%20%26%20bye&body=Line%201%0ALine%202');
  assert.strictEqual(B.mailto('not an email', 's', 'b'), '');
});

const SRC = ai.draftSource({ name: 'Southeast Food & Bev Expo 2026', place: 'Hall B' }, { name: 'Maya', signoff: 'Maya Okafor · Brightline', tone: 'friendly' },
  { name: 'Dana Whitfield', company: 'Magnolia Market', title: 'Buyer', temp: 'hot', chips: ['Samples'], next: 'quote', note: 'Wants 5 lb bags for 3 stores.', email: 'dana@example.com', phone: '(404) 555-0142' });

test('draft source: the model never sees the lead’s email or phone', () => {
  const p = ai.draftPrompt(SRC);
  assert.ok(!p.includes('dana@example.com') && !p.includes('555-0142') && !p.includes('Whitfield'), 'first name only, no contact details');
  assert.match(p, /THEIR FIRST NAME: Dana/);
  assert.match(p, /INTERESTED IN: Samples/);
});

test('validateDraft: markup out, invented claims and details out, captured facts kept', () => {
  const raw = {
    subject: '<b>Your 5 lb bags</b>',
    body: 'Hi Dana,\n\n**Great** to meet you at the Southeast Food & Bev Expo 2026. <script>alert(1)</script>\n## Offer\nI have attached our price list. We can do 20% off. Our samples are on the way.\n\nHappy to quote 5 lb bags for your 3 stores - free Tuesday at 3pm? See https://evil.example/x or email me at deals@evil.example.\n\nThanks,\nMaya Okafor · Brightline',
    gaps: [],
  };
  const d = ai.validateDraft(raw, SRC, 'fallback');
  assert.ok(d);
  const all = JSON.stringify([d.subject, d.body]);
  assert.ok(!/[<>*#]/.test(all), 'no markup or markdown');
  assert.strictEqual(d.subject, 'Your 5 lb bags', 'a number the rep captured is fine');
  for (const gone of ['attached', '20%', 'Tuesday', '3pm', 'evil.example', 'alert']) assert.ok(!all.includes(gone), gone);
  assert.match(d.body, /Our samples are on the way/, 'samples were ticked, so they may be mentioned');
  assert.match(d.body, /5 lb bags for your 3 stores/, 'numbers from the note survive');
  assert.match(d.body, /\[add: day\] at \[add: time\]/);
  assert.deepStrictEqual(d.gaps, ['day', 'time', 'link', 'email']);
  assert.ok(d.removed.some((r) => r.what === 'attached') && d.removed.some((r) => r.what === '% off'));
  assert.strictEqual(ai.validateDraft({ subject: 'x', body: 'Hi.' }, SRC), null, 'nothing usable is a 422');
  assert.strictEqual(ai.validateDraft({ subject: 'Special offer: 20% off', body: `Hi Dana, it was good to meet you at the expo and talk about samples.` }, SRC, 'Fallback subject').subject, 'Fallback subject', 'a subject that makes a claim is replaced');
});

test('validateContact: bad emails and phones dropped, not guessed; unreadable is null', () => {
  const c = ai.validateContact({ readable: true, kind: 'badge', name: '<b>Sam</b> Ortiz', company: 'Ortiz <i>Deli</i>', email: 'sam(at)ortiz', phone: '12' });
  assert.deepStrictEqual(c, { kind: 'badge', name: 'Sam Ortiz', title: '', company: 'Ortiz Deli', email: '', phone: '', dropped: ['email', 'phone'] });
  assert.strictEqual(ai.validateContact({ readable: true, kind: 'card', email: 'Riley@Example.com' }).email, 'riley@example.com');
  assert.strictEqual(ai.validateContact({ readable: false, name: 'x' }), null);
  assert.strictEqual(ai.validateContact({ readable: true, email: 'nope' }), null, 'nothing valid left');
});

test('join codes: 8 of 32 unambiguous characters, typed any way', () => {
  for (let i = 0; i < 200; i++) assert.ok(B.isCode(E.newCode()));
  assert.ok(!/[01IO]/.test(B.CODE_ALPHABET));
  assert.strictEqual(B.normalizeCode(' abcd-efgh '), 'ABCDEFGH');
  assert.strictEqual(B.formatCode('abcdefgh'), 'ABCD-EFGH');
  assert.ok(E.newToken().length >= 22 && E.TOKEN_RE.test(E.newToken()));
});

test('the sample show: fictional, twenty leads, three staff, live clocks, drafts that pass the validator untouched', () => {
  const d = demo(T0);
  assert.strictEqual(d.event.name, 'Southeast Food & Bev Expo 2026');
  assert.strictEqual(d.leads.length, ROWS.length);
  assert.ok(ROWS.length >= 18 && ROWS.length <= 24);
  assert.strictEqual(d.members.length, 3);
  assert.ok(d.leads.every((l) => !l.email || l.email.endsWith('.example.com')), 'example.com emails only');
  assert.ok(d.leads.every((l) => !l.phone || /555-01\d\d$/.test(l.phone)), '555-01xx numbers only');
  assert.ok(d.goingCold.some((g) => g.clock.state === 'cooling') && d.goingCold.some((g) => g.clock.state === 'cold'), 'some going cold right now, some already gone');
  assert.strictEqual(d.scorecard.verdict.key, 'paid');
  assert.strictEqual(d.leaderboard.length, 3);
  for (const [id, dr] of Object.entries(d.drafts)) assert.deepStrictEqual(dr.removed, [], `${id}: the guard removes nothing from a truthful draft`);
  assert.deepStrictEqual(Object.keys(d.drafts).sort(), ['d13', 'd16']);
  const card = E.shareCard(build(T0).event, d.scorecard, 3, 'now');
  const text = JSON.stringify(card);
  for (const l of d.leads) for (const v of [l.name, l.email, l.phone, l.company, l.note].filter((x) => x && x.length > 4)) assert.ok(!text.includes(v), v);
  for (const m of MEMBERS) assert.ok(!text.includes(m.name) && !text.includes(m.uid), m.name);
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { BOOTH_MEMORY: '1' }], ['./lib/fakeai', { BOOTH_FAKE_AI: '1' }], ['./server', { BOOTH_FAKE_AI: '1', BOOTH_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, BOOTH_MEMORY: '', BOOTH_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

/* ---------------- over HTTP ---------------- */

test('signed out: health, meta, the sample and rules.js work with zero model calls; nothing else does', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = await anon('GET', '/api/meta');
  assert.deepStrictEqual(meta.data.temps.map((t) => [t.key, t.hours]), [['hot', 48], ['warm', 120], ['cold', 336]]);
  const d = await anon('GET', '/api/demo');
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.data.demo, true);
  assert.strictEqual(d.data.leads.length, ROWS.length);
  assert.strictEqual(Object.keys(d.data.drafts).length, 2);
  const js = await fetch(`${base}/rules.js`);
  assert.ok((await js.text()).includes('BoothRules'), 'the page runs the same rules the server does');
  const page = await fetch(`${base}/`);
  const html = await page.text();
  assert.ok(html.includes('src="app.js"') && html.includes('href="app.css"'), 'relative asset links');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/events/abcdef'], ['POST', '/api/events'], ['POST', '/api/join'], ['PUT', '/api/events/abcdef'], ['DELETE', '/api/events/abcdef'],
    ['GET', '/api/events/abcdef/leads'], ['POST', '/api/events/abcdef/leads'], ['PUT', '/api/events/abcdef/leads/lead01'], ['POST', '/api/events/abcdef/leads/lead01/status'],
    ['POST', '/api/events/abcdef/leads/lead01/merge'], ['DELETE', '/api/events/abcdef/leads/lead01'], ['GET', '/api/events/abcdef/leads/lead01/template'],
    ['POST', '/api/events/abcdef/leads/lead01/draft'], ['POST', '/api/events/abcdef/read'], ['GET', '/api/events/abcdef/leaderboard'], ['GET', '/api/events/abcdef/scorecard'],
    ['GET', '/api/events/abcdef/export.csv'], ['POST', '/api/events/abcdef/share'], ['POST', '/api/events/abcdef/code'], ['PUT', '/api/events/abcdef/me']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' || m === 'DELETE' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  // A stranger's 5 MB photo is turned away at the door, unread.
  const big = await anon('POST', '/api/events/abcdef/read', { image: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } });
  assert.strictEqual(big.status, 401);
  // ...and every other route keeps the small limit.
  const fat = await anon('POST', '/api/events', { name: 'x'.repeat(200 * 1024) });
  assert.strictEqual(fat.status, 413);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

let maya, theo, priya, eve;
const EV = {};

async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}

test('the owner starts an event: validated, a join code, default interests', async () => {
  maya = await register('maya@example.com');
  assert.strictEqual((await maya('POST', '/api/events', { name: 'x' })).status, 400);
  assert.strictEqual((await maya('POST', '/api/events', { name: 'Expo', startDate: '2026-02-30' })).status, 400);
  assert.strictEqual((await maya('POST', '/api/events', { name: 'Expo', startDate: '2026-09-22', endDate: '2026-09-20' })).status, 400);
  assert.strictEqual((await maya('POST', '/api/events', { name: 'Expo', startDate: '2026-09-01', endDate: '2026-10-30' })).status, 400, 'a show is not two months');
  assert.strictEqual((await maya('POST', '/api/events', { name: 'Expo', boothCost: 'a lot' })).status, 400);
  const r = await maya('POST', '/api/events', { name: '<b>Southeast Food & Bev Expo</b>', startDate: '2026-09-22', endDate: '2026-09-24', place: 'Hall B', boothCost: '$3,200', chips: 'Wholesale, Samples, wholesale, <i>Pricing</i>', yourName: 'Maya' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  Object.assign(EV, { id: r.data.id, code: r.data.code });
  assert.strictEqual(r.data.name, 'Southeast Food & Bev Expo');
  assert.strictEqual(r.data.boothCost, 3200);
  assert.deepStrictEqual(r.data.chips, ['Wholesale', 'Samples', 'Pricing']);
  assert.deepStrictEqual([r.data.role, r.data.owner, r.data.me.name], ['owner', true, 'Maya']);
  assert.match(r.data.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const me = await maya('GET', '/api/me');
  assert.deepStrictEqual(me.data.events.map((e) => [e.id, e.role]), [[EV.id, 'owner']]);
});

test('staff join by code: typed any way; a wrong code says nothing; codes can be reset', async () => {
  theo = await register('theo@example.com');
  priya = await register('priya@example.com');
  const wrong = await theo('POST', '/api/join', { code: 'ZZZZ-ZZZZ' });
  assert.strictEqual(wrong.status, 404);
  const junk = await theo('POST', '/api/join', { code: 'hello' });
  assert.deepStrictEqual([junk.status, junk.data.error], [404, wrong.data.error], 'malformed or not, the same answer');
  const r = await theo('POST', '/api/join', { code: EV.code.toLowerCase().replace('-', ' '), name: 'Theo' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual([r.data.id, r.data.already], [EV.id, false]);
  assert.strictEqual((await theo('POST', '/api/join', { code: EV.code })).data.already, true);
  assert.strictEqual((await priya('POST', '/api/join', { code: EV.code, name: 'Priya' })).status, 200);
  const staffView = await theo('GET', `/api/events/${EV.id}`);
  assert.deepStrictEqual([staffView.data.role, staffView.data.code, staffView.data.share], ['staff', undefined, undefined], 'staff do not see the code');
  assert.deepStrictEqual(staffView.data.people.map((p) => p.name).sort(), ['Maya', 'Priya', 'Theo'], 'the team sees who is on it');
  // Reset: the old code dies at once.
  const reset = await maya('POST', `/api/events/${EV.id}/code`);
  assert.notStrictEqual(reset.data.code, EV.code);
  const late = await register('late@example.com');
  assert.strictEqual((await late('POST', '/api/join', { code: EV.code })).status, 404);
  EV.code = reset.data.code;
});

test('wrong codes are limited per person - and once blocked, even the right code is refused', async () => {
  const guesser = await register('guesser@example.com');
  for (let i = 0; i < E.LIMITS.joinTries; i++) assert.strictEqual((await guesser('POST', '/api/join', { code: `ABCD-EFG${'ABCDEFGH'[i]}` })).status, 404);
  const blocked = await guesser('POST', '/api/join', { code: EV.code });
  assert.strictEqual(blocked.status, 429);
  assert.ok(blocked.data.retryAfterMin >= 1);
});

test('two staff capturing at once: every lead is its own document and all of them stick', async () => {
  const mk = (who, i, temp) => who('POST', `/api/events/${EV.id}/leads`, { name: `Visitor ${who === theo ? 'T' : 'P'}${i}`, company: `Co ${i}`, email: `v${who === theo ? 't' : 'p'}${i}@example.com`, temp, chips: ['Samples'] });
  const results = await Promise.all([0, 1, 2, 3, 4, 5].flatMap((i) => [mk(theo, i, i % 2 ? 'hot' : 'warm'), mk(priya, i, 'hot')]));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  const list = await maya('GET', `/api/events/${EV.id}/leads`);
  assert.strictEqual(list.data.leads.length, 12, 'twelve captures, twelve leads');
  const by = (n) => list.data.leads.filter((l) => l.capturedByName === n).length;
  assert.deepStrictEqual([by('Theo'), by('Priya')], [6, 6]);
  assert.ok(list.data.leads.every((l) => l.clock.state === 'fresh' && l.status === 'new'));
  assert.strictEqual((await store.list(`events/${EV.id}/leads`)).length, 12);
  assert.strictEqual((await maya('GET', '/api/me')).data.events[0].leads, 12);
});

test('capture: validated, recorded who and how, and a 10-second qualify saved in full', async () => {
  assert.strictEqual((await theo('POST', `/api/events/${EV.id}/leads`, { temp: 'hot' })).status, 400);
  const bad = await theo('POST', `/api/events/${EV.id}/leads`, { name: 'X', temp: 'hot', email: 'nope' });
  assert.deepStrictEqual([bad.status, bad.data.field], [400, 'email']);
  const r = await theo('POST', `/api/events/${EV.id}/leads`, { name: 'Dana Whitfield', company: 'Magnolia Market', title: 'Buyer', email: 'Dana@Example.com', phone: '+1 (404) 555-0142', temp: 'hot', chips: ['Wholesale', 'Nope'], next: 'quote', note: 'Wants 5 lb bags for 3 stores.', source: 'card', status: 'won', capturedBy: 'someone-else', value: 99999 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const l = r.data.lead;
  EV.dana = l.id;
  assert.deepStrictEqual([l.email, l.chips, l.next, l.source, l.status, l.value, l.capturedByName, l.capturedBy], ['dana@example.com', ['Wholesale'], 'quote', 'card', 'new', null, 'Theo', undefined], 'status, value and capturer are the server’s, not the body’s');
  assert.deepStrictEqual([l.mine, l.sentBy], [true, undefined], 'mine, never a uid');
  assert.strictEqual((await store.get(`events/${EV.id}/leads`, l.id)).capturedBy, uidOf('theo@example.com'), 'the server still knows who');
  assert.strictEqual(l.clock.state, 'fresh');
  assert.strictEqual(l.clock.hours, 48);
});

test('dedupe: the same email or phone offers a merge; force saves a second; merge folds it in', async () => {
  const dup = await priya('POST', `/api/events/${EV.id}/leads`, { name: 'Dana W.', email: 'DANA@example.com', temp: 'warm', chips: ['Pricing'], note: 'Also wants decaf.' });
  assert.strictEqual(dup.status, 409);
  assert.deepStrictEqual([dup.data.duplicate.id, dup.data.duplicate.by, dup.data.duplicate.capturedByName], [EV.dana, 'email', 'Theo']);
  const byPhone = await priya('POST', `/api/events/${EV.id}/leads`, { name: 'Someone', phone: '404.555.0142', temp: 'cold' });
  assert.deepStrictEqual([byPhone.status, byPhone.data.duplicate.by], [409, 'phone']);
  const merged = await priya('POST', `/api/events/${EV.id}/leads/${EV.dana}/merge`, { name: 'Dana W.', email: 'dana@example.com', temp: 'warm', chips: ['Pricing'], note: 'Also wants decaf.' });
  assert.strictEqual(merged.status, 200, JSON.stringify(merged.data));
  const m = merged.data.lead;
  assert.deepStrictEqual([m.name, m.temp, m.chips, m.capturedByName, m.mergedCount], ['Dana Whitfield', 'hot', ['Wholesale', 'Pricing'], 'Theo', 1], 'nothing overwritten, hotter kept, still Theo’s');
  assert.match(m.note, /Wants 5 lb bags for 3 stores\.\nPriya: Also wants decaf\./);
  const forced = await priya('POST', `/api/events/${EV.id}/leads`, { name: 'Dana (her colleague)', phone: '404.555.0142', temp: 'cold', force: true });
  assert.strictEqual(forced.status, 200);
  // Editing one lead's email onto another's is a 409 too.
  const clash = await priya('PUT', `/api/events/${EV.id}/leads/${forced.data.lead.id}`, { email: 'dana@example.com' });
  assert.strictEqual(clash.status, 409);
  assert.strictEqual((await priya('DELETE', `/api/events/${EV.id}/leads/${forced.data.lead.id}`)).status, 200, 'whoever captured it can delete it');
});

test('follow-up status: sent stops the clock; won takes a deal value; the free template works', async () => {
  const tpl = await priya('GET', `/api/events/${EV.id}/leads/${EV.dana}/template`);
  assert.strictEqual(tpl.status, 200);
  assert.match(tpl.data.body, /^Hi Dana,/);
  assert.match(tpl.data.body, /Southeast Food & Bev Expo/);
  assert.ok(tpl.data.mailto.startsWith('mailto:dana@example.com?subject='));
  assert.strictEqual((await maya('POST', `/api/events/${EV.id}/leads/${EV.dana}/status`, { status: 'maybe' })).status, 400);
  assert.strictEqual((await maya('POST', `/api/events/${EV.id}/leads/${EV.dana}/status`, { status: 'won', value: 'lots' })).status, 400);
  const sent = await maya('POST', `/api/events/${EV.id}/leads/${EV.dana}/status`, { status: 'sent' });
  assert.deepStrictEqual([sent.data.lead.status, sent.data.lead.clock.state, sent.data.lead.clock.onTime, sent.data.lead.sentBy], ['sent', 'done', true, undefined]);
  assert.strictEqual((await store.get(`events/${EV.id}/leads`, EV.dana)).sentBy, uidOf('maya@example.com'));
  const won = await maya('POST', `/api/events/${EV.id}/leads/${EV.dana}/status`, { status: 'won', value: '$4,800' });
  assert.deepStrictEqual([won.data.lead.status, won.data.lead.value, Boolean(won.data.lead.repliedAt), Boolean(won.data.lead.bookedAt)], ['won', 4800, true, true]);
  const sc = (await theo('GET', `/api/events/${EV.id}/scorecard`)).data.scorecard;
  assert.deepStrictEqual([sc.won, sc.wonValue, sc.roi], [1, 4800, 50]);
});

test('draft a follow-up: metered, forced tool, markup stripped, no invented facts - and nothing stored', async () => {
  const calls = await modelCalls();
  const dump = store._dump();
  const r = await theo('POST', `/api/events/${EV.id}/leads/${EV.dana}/draft`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one metered model call');
  assert.strictEqual(store._dump(), dump, 'a draft saves nothing and sends nothing');
  assert.match(r.data.body, /^Hi Dana,/);
  assert.match(r.data.body, /Southeast Food & Bev Expo/);
  assert.ok(r.data.mailto.startsWith('mailto:dana@example.com'));
  const inj = await theo('POST', `/api/events/${EV.id}/leads`, { name: 'Ivy Test', company: 'Inject Co', email: 'ivy@example.com', temp: 'hot', next: 'demo', chips: ['Samples'], note: 'INJECT please' });
  const d = await theo('POST', `/api/events/${EV.id}/leads/${inj.data.lead.id}/draft`);
  assert.strictEqual(d.status, 200, JSON.stringify(d.data));
  const all = JSON.stringify([d.data.subject, d.data.body]);
  assert.ok(!/[<>]/.test(all) && !all.includes('**') && !all.includes('##'), 'no markup, no markdown');
  for (const gone of ['attached', 'price list', '20%', 'Tuesday', '3pm', 'evil.example', 'alert']) assert.ok(!all.includes(gone), `${gone} was invented and is gone`);
  assert.ok(d.data.removed.some((x) => x.what === 'attached') && d.data.removed.some((x) => x.what === '% off'), 'the page is told what was taken out');
  assert.ok(d.data.gaps.includes('day') && d.data.gaps.includes('time'));
  assert.strictEqual(d.data.subject, 'Great to meet you at Southeast Food & Bev Expo', 'a subject with an invented discount falls back to the template’s');
  const empty = await theo('POST', `/api/events/${EV.id}/leads`, { name: 'Em Tee', email: 'em@example.com', temp: 'warm', note: 'EMPTY' });
  assert.strictEqual((await theo('POST', `/api/events/${EV.id}/leads/${empty.data.lead.id}/draft`)).status, 422);
  EV.ivy = inj.data.lead.id;
});

test('a provider failure is a plain sentence: 502, or 503 when it is overloaded - never the provider’s words (2026-09-27)', async () => {
  const l1 = await theo('POST', `/api/events/${EV.id}/leads`, { name: 'Up Stream', email: 'up1@example.com', temp: 'warm', note: 'UPSTREAM401' });
  const l2 = await theo('POST', `/api/events/${EV.id}/leads`, { name: 'Up Stream Two', email: 'up2@example.com', temp: 'warm', note: 'UPSTREAM529' });
  const quiet = console.error; console.error = () => {};
  let a, b;
  try {
    a = await theo('POST', `/api/events/${EV.id}/leads/${l1.data.lead.id}/draft`);
    b = await theo('POST', `/api/events/${EV.id}/leads/${l2.data.lead.id}/draft`);
  } finally { console.error = quiet; }
  assert.deepStrictEqual([a.status, b.status], [502, 503], 'an upstream 401 is not "sign in"');
  assert.strictEqual(a.data.error, 'Could not draft that. Try again, or use the free template.');
  assert.ok(!JSON.stringify([a.data, b.data]).includes('fake_upstream_error'), 'no provider body reaches the page');
  for (const x of [l1, l2]) assert.strictEqual((await theo('DELETE', `/api/events/${EV.id}/leads/${x.data.lead.id}`)).status, 200);
});

test('snap a card: non-image 400 before the model, unreadable 422, a proposal and nothing stored', async () => {
  const calls = await modelCalls();
  const read = (image) => priya('POST', `/api/events/${EV.id}/read`, image === undefined ? {} : { image });
  assert.strictEqual((await read({ type: 'image/jpeg', data: Buffer.from('%PDF-1.7 not an image').toString('base64') })).status, 400);
  assert.strictEqual((await read({ type: 'application/pdf', data: JPEG })).status, 400);
  assert.strictEqual((await read()).status, 400);
  assert.strictEqual((await read({ type: 'image/jpeg', data: 'not base64 !!' })).status, 400);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'refused before anything was spent');
  const dump = store._dump();
  assert.strictEqual((await read({ type: 'image/jpeg', data: withText('BLANK wall') })).status, 422);
  const r = await read({ type: 'image/jpeg', data: JPEG });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual([r.data.kind, r.data.name, r.data.company, r.data.email, r.data.phone], ['card', 'Riley Chen', 'Cedar & Pine Grocers', 'riley.chen@example.com', '(404) 555-0188']);
  const badge = await read({ type: 'image/jpeg', data: withText('BADGE') });
  assert.deepStrictEqual([badge.data.kind, badge.data.name, badge.data.email], ['badge', 'Jordan Blake', '']);
  const messy = await read({ type: 'image/jpeg', data: withText('MESSY') });
  assert.deepStrictEqual([messy.data.name, messy.data.email, messy.data.phone, messy.data.dropped], ['Sam Ortiz', '', '', ['email', 'phone']]);
  const big = await read({ type: 'image/jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024 * 1024)]).toString('base64') });
  assert.strictEqual(big.status, 200, 'the snap route takes a real photo');
  await settle();
  assert.strictEqual(await modelCalls(), calls + 5);
  assert.strictEqual(store._dump(), dump, 'reading a card saves nothing');
  assert.ok(!store._dump().includes(JPEG.slice(0, 60)), 'the image is nowhere in the store');
});

test('out of credit: 402 before any model call, while capture, templates, the board, the scorecard and CSV still work', async () => {
  await identityStore.merge('users', uidOf('maya@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  for (const [p, body] of [[`/api/events/${EV.id}/leads/${EV.dana}/draft`, {}], [`/api/events/${EV.id}/read`, { image: { type: 'image/jpeg', data: JPEG } }]]) {
    const r = await maya('POST', p, body);
    assert.strictEqual(r.status, 402, p);
    assert.ok('topUpUrl' in r.data);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call was made');
  const cap = await maya('POST', `/api/events/${EV.id}/leads`, { name: 'Broke But Busy', email: 'bbb@example.com', temp: 'warm' });
  assert.strictEqual(cap.status, 200, 'capturing is free');
  assert.strictEqual((await maya('GET', `/api/events/${EV.id}/leads/${cap.data.lead.id}/template`)).status, 200, 'templates are free');
  assert.strictEqual((await maya('POST', `/api/events/${EV.id}/leads/${cap.data.lead.id}/status`, { status: 'sent' })).status, 200);
  assert.strictEqual((await maya('GET', `/api/events/${EV.id}/leaderboard`)).status, 200);
  assert.strictEqual((await maya('GET', `/api/events/${EV.id}/scorecard`)).status, 200);
  assert.strictEqual((await maya('GET', `/api/events/${EV.id}/export.csv`)).status, 200);
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  await identityStore.merge('users', uidOf('maya@example.com'), { spentUsd: 0 });
});

/* ================================================================== *
 * Scan a card with a voice memo on Gemini (BOOTH_AI_PROVIDER=gemini)
 * ================================================================== */

const fs = require('fs');
const gemini = require('../lib/gemini');
const audioLib = require('../lib/audio');
const fakeGemini = require('../lib/fakeai').gemini;
const { geminiCalls } = require('../server');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const WEBM = (s = '') => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(s), Buffer.alloc(400, 5)]).toString('base64');
function wav(seconds) {
  const rate = 1000; const n = Math.round(seconds * rate);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8, 'latin1'); h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.alloc(n, 1)]).toString('base64');
}

function fakeGuard(opts = {}) {
  const log = { order: [], allow: [], record: [], requests: [] };
  return {
    log,
    allow: async ({ provider, req, app: a }) => { log.order.push('allow'); log.allow.push({ provider, app: a, uid: req.user && req.user.id }); return (provider === 'gemini' && opts.denyGemini) || opts.deny || { ok: true }; },
    record: async (r) => { log.order.push('record'); log.record.push(r); return true; },
    priceUsd: ({ provider, inputTokens, outputTokens }) => (provider === 'gemini' ? gemini.priceUsd({ inputTokens, outputTokens, at: new Date('2026-11-23T00:00:00Z') }) : (inputTokens + 5 * outputTokens) / 1e6),
    gemini: { generate: async (r) => { log.order.push('generate'); log.requests.push(r); if (opts.generate) return opts.generate(r); return { json: await r.fake({ contents: r.contents, generationConfig: { responseSchema: r.responseSchema } }), usage: { inputTokens: 1500, outputTokens: 300 } }; } },
  };
}
async function withGemini(guard, fn) {
  process.env.BOOTH_AI_PROVIDER = 'gemini';
  if (guard) global.LAB_AI_GUARD = guard;
  try { return await fn(); } finally { delete process.env.BOOTH_AI_PROVIDER; delete global.LAB_AI_GUARD; }
}
const scanBody = (o = {}) => ({ image: { type: 'image/jpeg', data: o.photo || JPEG }, ...(o.memo === null ? {} : { memo: { type: 'audio/webm', data: o.memo || WEBM() } }) });
const scanPath = () => `/api/events/${EV.id}/scan`;

test('the provider switch: Claude unless BOOTH_AI_PROVIDER=gemini, read per request; the scan is off until then', async () => {
  const anon = client();
  assert.strictEqual(process.env.BOOTH_AI_PROVIDER, undefined);
  assert.deepStrictEqual([(await anon('GET', '/api/me')).data.ai, (await anon('GET', '/api/me')).data.scan], ['claude', false]);
  for (const v of ['', 'off', 'GEMINI', 'claude', 'vertex']) {
    process.env.BOOTH_AI_PROVIDER = v;
    try { assert.strictEqual((await theo('GET', '/api/me')).data.ai, 'claude', v); } finally { delete process.env.BOOTH_AI_PROVIDER; }
  }
  await withGemini(null, async () => {
    const me = (await theo('GET', '/api/me')).data;
    assert.deepStrictEqual([me.ai, me.scan, me.limits.memoSeconds], ['gemini', true, 12]);
  });
  assert.match(src('server.js'), /process\.env\.BOOTH_AI_PROVIDER === 'gemini' \? 'gemini' : 'claude'/);

  // Off: the scan route answers 404 "not switched on" - after the gates, before the big parser, with no model call.
  const calls = await modelCalls();
  const g = fakeGuard();
  global.LAB_AI_GUARD = g;
  try {
    const off = await theo('POST', scanPath(), scanBody());
    assert.deepStrictEqual([off.status, off.data.code], [404, 'ai-off']);
    assert.strictEqual((await theo('POST', scanPath(), { image: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } })).status, 404, 'not parsed while off');
    assert.strictEqual((await client()('POST', scanPath(), scanBody())).status, 401, 'signed out is told to sign in, not that it is off');
  } finally { delete global.LAB_AI_GUARD; }
  await settle();
  assert.deepStrictEqual([await modelCalls(), g.log.order], [calls, []]);
});

test('the Gemini schema only transcribes: five fields with a confidence each, null when unreadable; the memo and draft exist only with a memo', () => {
  assert.strictEqual(gemini.MODEL, 'gemini-3.8-flash');
  const plain = gemini.scanSchema();
  assert.deepStrictEqual(Object.keys(plain.properties), ['readable', 'kind', 'name', 'company', 'title', 'email', 'phone']);
  assert.deepStrictEqual(plain.required, Object.keys(plain.properties));
  for (const k of gemini.FIELDS) {
    assert.deepStrictEqual([Object.keys(plain.properties[k].properties), plain.properties[k].properties.value.nullable, plain.properties[k].properties.confidence.enum], [['value', 'confidence'], true, ['high', 'medium', 'low']], k);
    assert.match(plain.properties[k].properties.value.description, /exactly as printed\. null if it is not shown or not fully legible - never guess/);
  }
  assert.ok(!/address|website|linkedin|score|notes/i.test(JSON.stringify(plain, (k, v) => (k === 'description' ? undefined : v))), 'no field for anything else on the card');
  const full = gemini.scanSchema({ memo: true, chips: ['Wholesale', 'Samples'] });
  assert.deepStrictEqual(Object.keys(full.properties).slice(7), ['memo', 'draft']);
  assert.deepStrictEqual(Object.keys(full.properties.memo.properties), ['heard', 'summary', 'temp', 'next', 'interests']);
  assert.deepStrictEqual(full.properties.memo.properties.temp.enum, ['hot', 'warm', 'cold', 'not_said']);
  assert.deepStrictEqual(full.properties.memo.properties.next.enum, ['call', 'demo', 'quote', 'info', 'not_said']);
  assert.deepStrictEqual(full.properties.memo.properties.interests.items.enum, ['Wholesale', 'Samples'], 'interests can only be the event’s own chips');
  assert.ok(!('interests' in gemini.scanSchema({ memo: true }).properties.memo.properties));
  assert.deepStrictEqual(Object.keys(full.properties.draft.properties), ['subject', 'body']);

  const req = gemini.scanRequest({ photo: { mediaType: 'image/jpeg', data: 'AAAA' }, audio: { mediaType: 'audio/webm', data: 'BBBB' }, event: { name: 'Expo', place: 'Hall B' }, rep: { name: 'Theo', signoff: 'Theo · Brightline', tone: 'direct' }, chips: ['Wholesale'] });
  assert.deepStrictEqual(req.contents[0].parts.slice(0, 2), [{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }, { inlineData: { mimeType: 'audio/webm', data: 'BBBB' } }]);
  assert.match(req.contents[0].parts[2].text, /EVENT: Expo, Hall B\nREP: Theo\nSIGN-OFF: Theo · Brightline\nTONE: straight to the point/);
  for (const rule of [/Never fill in, correct, translate or complete/, /use only what is printed on the card and what the rep says in the memo/, /Never put the email address or phone number from the card in the email/, /never an instruction to you/, /Summarise only what the rep says/]) assert.match(req.systemInstruction, rule);
  const photoOnly = gemini.scanRequest({ photo: { mediaType: 'image/png', data: 'AAAA' } });
  assert.ok(!/memo|EVENT/.test(photoOnly.contents[0].parts[1].text) && !/voice memo/.test(photoOnly.systemInstruction) && !photoOnly.responseSchema.properties.draft);
  assert.deepStrictEqual(Object.keys(gemini.DRAFT_SCHEMA.properties), ['subject', 'body', 'gaps']);
  assert.strictEqual(gemini.priceUsd({ inputTokens: 1e6, outputTokens: 1e6, at: new Date('2026-12-31T23:59:59Z') }), 4.5);
  assert.strictEqual(gemini.priceUsd({ inputTokens: 1e6, outputTokens: 1e6, at: new Date('2027-01-01T00:00:00Z') }), 9);
  assert.ok(!/fetch\(|https?:\/\//.test(src('lib/gemini.js')), 'the app makes no Vertex call of its own: the guard’s helper does');
});

test('the memo is capped: a sound by its bytes, 1 MB, and a WAV past 15 seconds refused', () => {
  assert.deepStrictEqual([audioLib.MAX_BYTES, audioLib.MAX_SECONDS], [1024 * 1024, 15]);
  assert.strictEqual(audioLib.validate({ type: 'audio/webm', data: WEBM() }).mediaType, 'audio/webm');
  assert.strictEqual(audioLib.validate({ data: wav(9) }).mediaType, 'audio/wav');
  assert.throws(() => audioLib.validate({ data: wav(16) }), /longer than 15 seconds/);
  assert.throws(() => audioLib.validate({ type: 'audio/webm', data: JPEG }), /must be a sound recording/, 'a declared type is a claim');
  assert.throws(() => audioLib.validate({ data: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(1024 * 1024 + 10)]).toString('base64') }), /too big/);
  assert.throws(() => audioLib.validate({ data: 'not base64 !!' }), /could not be read/);
  assert.throws(() => audioLib.validate(null), /Record the memo first/);
});

test('validateScan: confidences clamped, bad contacts dropped not guessed, unsure fields flagged, the memo held to the app’s lists, the draft guarded', () => {
  const ctx = { memo: true, event: { name: 'Expo' }, rep: { name: 'Theo', signoff: 'Theo' }, chips: ['Wholesale', 'Samples'] };
  const F = (value, confidence) => ({ value, confidence });
  const base = { readable: true, kind: 'card', name: F('Riley Chen', 'high'), company: F('Cedar & Pine', 'medium'), title: F(null, 'high'), email: F('Riley.Chen@Example.com', 'certain'), phone: F('(404) 555-0188', 'low') };
  const r = ai.validateScan(base, {});
  assert.deepStrictEqual(r.fields, { name: F('Riley Chen', 'high'), company: F('Cedar & Pine', 'medium'), title: F(null, null), email: F('riley.chen@example.com', 'low'), phone: F('(404) 555-0188', 'low') });
  assert.deepStrictEqual([r.check, r.dropped, r.memo, r.draft], [['company', 'email', 'phone'], [], null, null], 'anything not "high" - or a confidence the app does not know - must be checked');
  assert.strictEqual(ai.validateScan({ ...base, readable: false }), null);
  assert.strictEqual(ai.validateScan({ readable: true, kind: 'card', title: F('Owner', 'high') }), null, 'a title alone is not a lead');
  for (const junk of [null, 'x', [], 7]) assert.strictEqual(ai.validateScan(junk), null);
  const bad = ai.validateScan({ ...base, email: F('riley(at)example', 'high'), phone: F('12', 'high'), name: F({ a: 1 }, 'high'), kind: 'passport' });
  assert.deepStrictEqual([bad.kind, bad.fields.email, bad.fields.phone, bad.fields.name, bad.dropped], ['card', F(null, null), F(null, null), F(null, null), ['email', 'phone']]);
  const withMemo = ai.validateScan({ ...base, memo: { heard: true, summary: `  <b>Wants</b> pricing for 3 stores. ${'x'.repeat(400)}`, temp: 'boiling', next: 'call', interests: ['samples', 'Free money', 4, 'Samples'] }, draft: { subject: 'Hello from Expo', body: 'Hi Riley,\n\nGood to meet you at Expo. You asked about pricing for 3 stores. I have attached a brochure.\n\nWould a call work on Tuesday at 3pm? Reach me on riley.chen@example.com.\n\nTheo' } }, ctx);
  assert.deepStrictEqual([withMemo.memo.heard, withMemo.memo.temp, withMemo.memo.next, withMemo.memo.chips, withMemo.memo.summary.length, /[<>]/.test(withMemo.memo.summary)], [true, null, 'call', ['Samples'], ai.MEMO_MAX, false]);
  assert.ok(withMemo.draft && !/attached|brochure|Tuesday|3pm|@example\.com/.test(withMemo.draft.body), 'the draft may use the card’s name and the memo, nothing else - not even the card’s email');
  assert.match(withMemo.draft.body, /pricing for 3 stores/);
  assert.ok(withMemo.draft.removed.some((x) => x.what === 'attached') && withMemo.draft.gaps.includes('email'));
  const silent = ai.validateScan({ ...base, memo: { heard: false, summary: 'something', temp: 'hot', next: 'call', interests: ['Samples'] }, draft: { subject: 'x', body: 'y'.repeat(80) } }, ctx);
  assert.deepStrictEqual([silent.memo, silent.draft], [{ heard: false, summary: '', temp: null, next: null, chips: [] }, null], 'no memo heard, no draft');
  assert.strictEqual(ai.validateScan({ ...base, memo: { heard: true, summary: 'x' }, draft: { subject: 'x', body: 'y' } }, {}).draft, null, 'without a memo sent there is never a draft');
  // The sample's scan is hand-written and passes the same validator untouched.
  const d = demo(Date.now()).scan;
  assert.deepStrictEqual([d.check, d.fields.phone.value, d.memo.temp, d.memo.chips, d.draft.removed, d.draft.gaps], [['email'], null, 'hot', ['Wholesale'], [], ['your direct number']]);
  assert.ok(/example\.com$/.test(d.fields.email.value));
});

test('scan a card on Gemini: gates, then the bytes, then guard allow -> one call -> record; a proposal with flags, a memo summary and a guarded draft - nothing stored, nothing sent', async () => {
  const calls = await modelCalls();
  const dump = store._dump();
  const g = fakeGuard();
  const seen = geminiCalls.length;
  const r = await withGemini(g, () => theo('POST', scanPath(), scanBody()));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  await settle();
  assert.deepStrictEqual(g.log.order, ['allow', 'generate', 'record']);
  assert.deepStrictEqual([g.log.allow[0].provider, g.log.allow[0].app, g.log.allow[0].uid], ['gemini', 'booth', uidOf('theo@example.com')]);
  assert.deepStrictEqual([g.log.record[0].provider, g.log.record[0].app, g.log.record[0].usd], ['gemini', 'booth', gemini.priceUsd({ inputTokens: 1500, outputTokens: 300, at: new Date('2026-11-23T00:00:00Z') })]);
  const q = g.log.requests[0];
  assert.deepStrictEqual([q.model, q.generationConfig.temperature, q.contents[0].parts.length, q.contents[0].parts[0].inlineData.mimeType, q.contents[0].parts[1].inlineData.mimeType], ['gemini-3.8-flash', 0, 3, 'image/jpeg', 'audio/webm']);
  assert.deepStrictEqual(q.responseSchema.properties.memo.properties.interests.items.enum, ['Wholesale', 'Samples', 'Pricing']);
  assert.match(q.contents[0].parts[2].text, /EVENT: Southeast Food & Bev Expo, Hall B\nREP: Theo/);
  assert.ok(!/dana|@example\.com|555/i.test(q.contents[0].parts[2].text + q.systemInstruction), 'no lead, no teammate and no contact rides along');
  assert.strictEqual(geminiCalls.length, seen + 1);
  assert.ok(!JSON.stringify(geminiCalls[seen]).includes(JPEG.slice(0, 40)), 'the stand-in keeps lengths, not media');

  assert.deepStrictEqual([r.data.kind, r.data.fields.name, r.data.fields.email, r.data.fields.phone, r.data.check, r.data.dropped, r.data.sent],
    ['card', { value: 'Riley Chen', confidence: 'high' }, { value: 'riley.chen@example.com', confidence: 'medium' }, { value: '(404) 555-0188', confidence: 'high' }, ['email'], [], { photo: true, memo: true }]);
  assert.deepStrictEqual(r.data.memo, { heard: true, summary: 'Wants pricing on the 5 lb bags for 3 stores. Asked for a call next week.', temp: 'hot', next: 'call', chips: ['Wholesale'] });
  assert.match(r.data.draft.body, /^Hi Riley,\n\nIt was great to talk at our booth at Southeast Food & Bev Expo/);
  assert.deepStrictEqual([r.data.draft.gaps, r.data.draft.removed], [['your direct number'], []]);
  assert.ok(!/riley\.chen@|555-0188/i.test(JSON.stringify(r.data.draft)), 'the draft never carries the email or phone');
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  assert.strictEqual(await modelCalls(), calls + 1, 'one metered call, charged to the person');
  const row = (await identityStore.list('usage')).find((u) => /^scan:gemini-3\.8-flash$/.test(u.route));
  assert.ok(row && row.uid === uidOf('theo@example.com'), 'the ledger row says what really ran');
  assert.strictEqual(store._dump(), dump, 'a scan saves nothing: no lead, no draft, no media');

  // The photo alone: no memo, no draft, and the model is not asked for one.
  const g2 = fakeGuard();
  const p = await withGemini(g2, () => theo('POST', scanPath(), scanBody({ memo: null })));
  assert.deepStrictEqual([p.status, p.data.memo, p.data.draft, p.data.sent, 'draft' in g2.log.requests[0].responseSchema.properties, g2.log.requests[0].contents[0].parts.length], [200, null, null, { photo: true, memo: false }, false, 2]);
  const badge = await withGemini(fakeGuard(), () => theo('POST', scanPath(), scanBody({ photo: withText('BADGE'), memo: null })));
  assert.deepStrictEqual([badge.data.kind, badge.data.fields.email.value, badge.data.check], ['badge', null, []]);
});

test('scan: refused before anything is spent - bad bytes, too big, too long, signed out, a stranger, an empty wallet, the guard saying no', async () => {
  const calls = await modelCalls();
  const g = fakeGuard();
  const go = (body, who = theo) => withGemini(g, () => who('POST', scanPath(), body));
  for (const [body, why] of [
    [{}, 'no photo'],
    [{ image: { type: 'image/jpeg', data: Buffer.from('%PDF-1.7 not an image').toString('base64') } }, 'not an image'],
    [{ image: { type: 'image/jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024 + 10)]).toString('base64') } }, 'a photo over 2 MB'],
    [{ ...scanBody(), memo: { type: 'audio/webm', data: JPEG } }, 'a memo that is not a sound'],
    [{ ...scanBody(), memo: { data: wav(16) } }, 'a 16-second memo'],
    [{ ...scanBody(), memo: { data: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(1024 * 1024 + 10)]).toString('base64') } }, 'a memo over 1 MB'],
  ]) assert.strictEqual((await go(body)).status, 400, why);
  assert.strictEqual((await go(scanBody(), client())).status, 401);
  const stranger = await register('scan-stranger@example.com');
  assert.strictEqual((await go(scanBody(), stranger)).status, 404);
  assert.strictEqual((await go({ image: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } }, stranger)).status, 404, 'a stranger’s upload is never parsed');
  await identityStore.merge('users', uidOf('theo@example.com'), { spentUsd: 100 });
  try { assert.strictEqual((await go(scanBody())).status, 402); } finally { await identityStore.merge('users', uidOf('theo@example.com'), { spentUsd: 0 }); }
  assert.deepStrictEqual(g.log.order, [], 'none of those reached the guard, let alone the model');

  const no = fakeGuard({ deny: { ok: false, status: 429, code: 'burst-minute', message: 'Lots of people are using AI right now - try again in a minute.' } });
  const denied = await withGemini(no, () => theo('POST', scanPath(), scanBody()));
  assert.deepStrictEqual([denied.status, denied.data.code, denied.data.error, no.log.order], [429, 'burst-minute', 'Lots of people are using AI right now - try again in a minute.', ['allow']]);
  // Both months capped: the draft falls back from Gemini to Claude, whose own cap says no too (2026-11-23).
  const cap = fakeGuard({ deny: { ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' } });
  const quietLog = console.log; console.log = () => {};
  try { assert.deepStrictEqual([(await withGemini(cap, () => theo('POST', `/api/events/${EV.id}/leads/${EV.dana}/draft`))).status, cap.log.order, cap.log.allow.map((a) => a.provider)], [503, ['allow', 'allow'], ['gemini', 'claude']]); } finally { console.log = quietLog; }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'nobody was charged');
});

test('scan: hostile or useless model output is cleaned, clamped or refused - and a provider failure is a plain sentence', async () => {
  const dump = store._dump();
  const scan = (o, guard = fakeGuard()) => withGemini(guard, () => theo('POST', scanPath(), scanBody(o)));
  const inj = await scan({ memo: WEBM('INJECT') });
  assert.strictEqual(inj.status, 200, JSON.stringify(inj.data));
  assert.deepStrictEqual([inj.data.memo.summary, inj.data.memo.temp, inj.data.memo.next, inj.data.memo.chips], ['Wants pricing on the 5 lb bags for 3 stores.', null, null, ['Wholesale']]);
  const all = JSON.stringify([inj.data.draft.subject, inj.data.draft.body]);
  assert.ok(!/[<>]/.test(all) && !all.includes('**'), 'no markup, no markdown');
  assert.ok(inj.data.draft.removed.some((x) => x.what === 'attached') && inj.data.draft.removed.some((x) => x.what === '% off'), 'the page is told what was taken out');
  for (const gone of ['attached', 'price list', '20%', 'Tuesday', '3pm', 'evil.example', 'riley.chen@', '555-0188']) assert.ok(!all.toLowerCase().includes(gone.toLowerCase()), `${gone} is gone`);
  assert.match(inj.data.draft.body, /pricing on the 5 lb bags for 3 stores/, 'what the rep did say stays');
  assert.strictEqual(inj.data.draft.subject, 'Good to meet you at Southeast Food & Bev Expo', 'a subject with an invented discount falls back to the template’s');
  assert.ok(!('advice' in inj.data) && !('score' in inj.data), 'only the known keys leave');
  const messy = await scan({ photo: withText('MESSY'), memo: null });
  assert.deepStrictEqual([messy.data.fields.name, messy.data.fields.company.value, messy.data.fields.email.value, messy.data.fields.phone.value, messy.data.dropped, messy.data.check], [{ value: 'Sam Ortiz', confidence: 'medium' }, 'Ortiz Deli', null, null, ['email', 'phone'], ['name']]);
  assert.strictEqual((await scan({ photo: withText('UNSURE'), memo: null })).data.fields.phone.value, null, 'unreadable is null, never a guess');
  const blank = await scan({ photo: withText('BLANK wall') });
  assert.deepStrictEqual([blank.status, /type it in/.test(blank.data.error)], [422, true]);
  const silent = await scan({ memo: WEBM('SILENT') });
  assert.deepStrictEqual([silent.status, silent.data.memo.heard, silent.data.draft, silent.data.fields.name.value], [200, false, null, 'Riley Chen']);
  for (const junk of [null, 'I am not JSON', [], { readable: true }]) {
    const j = await scan({}, fakeGuard({ generate: async () => ({ json: junk, usage: { inputTokens: 10, outputTokens: 1 } }) }));
    assert.strictEqual(j.status, 422, JSON.stringify(junk));
  }

  const quiet = console.error; console.error = () => {};
  try {
    let g = fakeGuard({ generate: async () => { throw Object.assign(new Error('Gemini answered 500. SECRET provider words'), { name: 'VertexError', code: 'http', status: 500, usage: { inputTokens: 900, outputTokens: 0 } }); } });
    const a = await scan({}, g);
    assert.deepStrictEqual([a.status, a.data.error, g.log.record.length], [502, 'Could not read that right now. Try again, or type it in.', 1], 'a call that billed before failing is recorded');
    assert.ok(!JSON.stringify(a.data).includes('SECRET'));
    g = fakeGuard({ generate: async () => { throw Object.assign(new Error('Gemini answered 429.'), { name: 'VertexError', code: 'http', status: 429 }); } });
    assert.deepStrictEqual([(await scan({}, g)).status, g.log.record.length], [503, 0]);
    g = fakeGuard({ generate: async () => { throw Object.assign(new Error('Gemini took too long.'), { name: 'VertexError', code: 'timeout' }); } });
    assert.strictEqual((await scan({}, g)).status, 503);
    assert.strictEqual((await scan({ photo: withText('UPSTREAM503') })).status, 503);
  } finally { console.error = quiet; }
  assert.strictEqual(store._dump(), dump);
});

test('with the switch on, the plain snap and the drafted follow-up are Gemini’s too; with it off they are Claude’s, through the guard when the lab has one', async () => {
  let g = fakeGuard();
  const read = await withGemini(g, () => priya('POST', `/api/events/${EV.id}/read`, { image: { type: 'image/jpeg', data: JPEG } }));
  assert.deepStrictEqual([read.status, read.data.kind, read.data.name, read.data.email, read.data.phone, read.data.dropped, read.data.check, g.log.order], [200, 'card', 'Riley Chen', 'riley.chen@example.com', '(404) 555-0188', [], ['email'], ['allow', 'generate', 'record']]);
  g = fakeGuard();
  const d = await withGemini(g, () => theo('POST', `/api/events/${EV.id}/leads/${EV.dana}/draft`));
  assert.strictEqual(d.status, 200, JSON.stringify(d.data));
  assert.match(d.data.body, /^Hi Dana,/);
  assert.deepStrictEqual([g.log.order, Object.keys(g.log.requests[0].responseSchema.properties)], [['allow', 'generate', 'record'], ['subject', 'body', 'gaps']]);
  assert.ok(!/dana@example\.com|555/.test(g.log.requests[0].contents[0].parts[0].text), 'the draft prompt still has no email or phone');
  const ivy = await withGemini(fakeGuard(), () => theo('POST', `/api/events/${EV.id}/leads/${EV.ivy}/draft`));
  for (const gone of ['attached', '20%', 'Tuesday', 'evil.example']) assert.ok(!JSON.stringify([ivy.data.subject, ivy.data.body]).includes(gone), `${gone} is guarded on Gemini as on Claude`);

  // No guard at all (the app on its own): the stand-in still answers.
  const alone = await withGemini(null, () => theo('POST', scanPath(), scanBody()));
  assert.deepStrictEqual([alone.status, alone.data.check], [200, ['email']]);
  assert.strictEqual(typeof fakeGemini, 'function');

  // Off: Claude, as ever - asked of the guard first, recorded after.
  g = fakeGuard();
  global.LAB_AI_GUARD = g;
  try {
    const c1 = await priya('POST', `/api/events/${EV.id}/read`, { image: { type: 'image/jpeg', data: JPEG } });
    const c2 = await theo('POST', `/api/events/${EV.id}/leads/${EV.dana}/draft`);
    assert.deepStrictEqual([c1.status, 'check' in c1.data, c2.status], [200, false, 200]);
  } finally { delete global.LAB_AI_GUARD; }
  assert.deepStrictEqual([g.log.order, g.log.allow.map((a) => a.provider), g.log.record.map((x) => x.provider), g.log.record.every((x) => x.usd > 0 && x.app === 'booth')], [['allow', 'record', 'allow', 'record'], ['claude', 'claude'], ['claude', 'claude'], true]);
});

test('Gemini fails, Claude answers: a thrown call, unusable output or the Gemini cap falls back for the read and the draft; a burst does not; the scan stays Gemini-only', async () => {
  const lines = [];
  const quietLog = console.log; const quietErr = console.error;
  console.log = (m) => lines.push(String(m)); console.error = () => {};
  const read = (g) => withGemini(g, () => priya('POST', `/api/events/${EV.id}/read`, { image: { type: 'image/jpeg', data: JPEG } }));
  const draft = (g) => withGemini(g, () => theo('POST', `/api/events/${EV.id}/leads/${EV.dana}/draft`));
  const thrown = () => fakeGuard({ generate: async () => { throw Object.assign(new Error('Gemini answered 500. SECRET'), { name: 'VertexError', code: 'http', status: 500, usage: { inputTokens: 900, outputTokens: 0 } }); } });
  try {
    // A thrown call (that billed first): recorded, then Claude answers with its own allow and record.
    let g = thrown();
    const r1 = await read(g);
    assert.deepStrictEqual([r1.status, r1.data.name, 'check' in r1.data, g.log.order, g.log.allow.map((a) => a.provider), g.log.record.map((x) => x.provider)],
      [200, 'Riley Chen', false, ['allow', 'generate', 'record', 'allow', 'record'], ['gemini', 'claude'], ['gemini', 'claude']]);
    g = thrown();
    const d1 = await draft(g);
    assert.deepStrictEqual([d1.status, /^Hi Dana,/.test(d1.data.body), g.log.allow.map((a) => a.provider)], [200, true, ['gemini', 'claude']]);
    assert.ok(!JSON.stringify([r1.data, d1.data]).includes('SECRET'));
    // Output the validator rejects.
    g = fakeGuard({ generate: async () => ({ json: { readable: false }, usage: { inputTokens: 10, outputTokens: 1 } }) });
    const r2 = await read(g);
    assert.deepStrictEqual([r2.status, r2.data.name, g.log.allow.map((a) => a.provider)], [200, 'Riley Chen', ['gemini', 'claude']]);
    g = fakeGuard({ generate: async () => ({ json: { subject: '', body: '' }, usage: { inputTokens: 10, outputTokens: 1 } }) });
    const d2 = await draft(g);
    assert.deepStrictEqual([d2.status, /^Hi Dana,/.test(d2.data.body), g.log.allow.map((a) => a.provider)], [200, true, ['gemini', 'claude']]);
    // The month's Gemini cap: Claude answers, Gemini never called.
    g = fakeGuard({ denyGemini: { ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' } });
    const r3 = await read(g);
    assert.deepStrictEqual([r3.status, r3.data.name, g.log.order], [200, 'Riley Chen', ['allow', 'allow', 'record']]);
    // A burst refusal goes out as it is: no Claude call.
    const before = await modelCalls();
    for (const code of ['burst-minute', 'burst-day']) {
      g = fakeGuard({ denyGemini: { ok: false, status: 429, code, message: 'Lots of people are using AI right now - try again in a minute.' } });
      const b = await draft(g);
      assert.deepStrictEqual([b.status, b.data.code, g.log.order], [429, code, ['allow']]);
    }
    await settle();
    assert.strictEqual(await modelCalls(), before, 'nobody charged for a burst');
    // The scan has no Claude path: a failure is its own friendly error.
    g = thrown();
    const s = await withGemini(g, () => theo('POST', scanPath(), scanBody()));
    assert.deepStrictEqual([s.status, s.data.error, g.log.allow.map((a) => a.provider)], [502, 'Could not read that right now. Try again, or type it in.', ['gemini']]);
  } finally { console.log = quietLog; console.error = quietErr; }
  assert.deepStrictEqual(lines.filter((l) => /gemini failed/.test(l)), ['[booth] gemini failed (http); used claude', '[booth] gemini failed (http); used claude', '[booth] gemini failed (unusable); used claude', '[booth] gemini failed (unusable); used claude', '[booth] gemini failed (monthly-cap); used claude']);
});

test('claude-first: Claude reads and drafts, Gemini answers when Claude throws, is unusable or capped; a burst does not fall back; the scan is on', async () => {
  const lines = [];
  const quietLog = console.log; const quietErr = console.error;
  console.log = (m) => lines.push(String(m)); console.error = () => {};
  const cf = async (g, fn) => { process.env.BOOTH_AI_PROVIDER = 'claude-first'; if (g) global.LAB_AI_GUARD = g; try { return await fn(); } finally { delete process.env.BOOTH_AI_PROVIDER; delete global.LAB_AI_GUARD; } };
  // A guard that can refuse Claude alone; Gemini reads a clean copy of what it was sent.
  const guardCF = (denyClaude) => {
    const g = fakeGuard({ generate: async (r) => ({ json: await fakeGemini({ contents: r.contents.map((c) => ({ ...c, parts: c.parts.map((p) => (p.text ? { text: p.text.replace(/UPSTREAM/g, 'UP-STREAM') } : p.inlineData && /^image/.test(p.inlineData.mimeType) ? { inlineData: { ...p.inlineData, data: JPEG } } : p)) })), generationConfig: { responseSchema: r.responseSchema } }), usage: { inputTokens: 1500, outputTokens: 300 } }) });
    const allow = g.allow;
    g.allow = async (a) => (a.provider === 'claude' && denyClaude ? (g.log.order.push('allow'), g.log.allow.push({ provider: 'claude' }), denyClaude) : allow(a));
    return g;
  };
  const up = await theo('POST', `/api/events/${EV.id}/leads`, { name: 'Up Stream', email: 'up9@example.com', temp: 'warm', note: 'UPSTREAM500' });
  try {
    const me = (await cf(null, () => theo('GET', '/api/me'))).data;
    assert.deepStrictEqual([me.ai, me.scan], ['claude-first', true]);
    // Claude answers when it can: Gemini never called.
    let g = guardCF();
    const r0 = await cf(g, () => priya('POST', `/api/events/${EV.id}/read`, { image: { type: 'image/jpeg', data: JPEG } }));
    assert.deepStrictEqual([r0.status, r0.data.name, 'check' in r0.data, g.log.allow.map((a) => a.provider)], [200, 'Riley Chen', false, ['claude']]);
    // Claude throws (the draft): Gemini answers 200.
    g = guardCF();
    const d1 = await cf(g, () => theo('POST', `/api/events/${EV.id}/leads/${up.data.lead.id}/draft`));
    assert.deepStrictEqual([d1.status, /^Hi Up,/.test(d1.data.body), g.log.allow.map((a) => a.provider), g.log.record.map((x) => x.provider)], [200, true, ['claude', 'gemini'], ['gemini']]);
    assert.ok(!JSON.stringify(d1.data).includes('fake_upstream_error'));
    // Claude unusable (a card it cannot read): Gemini.
    g = guardCF();
    const r1 = await cf(g, () => priya('POST', `/api/events/${EV.id}/read`, { image: { type: 'image/jpeg', data: withText('BLANK wall') } }));
    assert.deepStrictEqual([r1.status, r1.data.name, r1.data.check, g.log.allow.map((a) => a.provider), g.log.record.map((x) => x.provider)], [200, 'Riley Chen', ['email'], ['claude', 'gemini'], ['claude', 'gemini']], 'the Claude call that billed is still recorded');
    // Claude's monthly cap: Gemini, for the read and the draft.
    const cap = { ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' };
    g = guardCF(cap);
    const r2 = await cf(g, () => priya('POST', `/api/events/${EV.id}/read`, { image: { type: 'image/jpeg', data: JPEG } }));
    assert.deepStrictEqual([r2.status, r2.data.name, g.log.order], [200, 'Riley Chen', ['allow', 'allow', 'generate', 'record']]);
    g = guardCF(cap);
    const d2 = await cf(g, () => theo('POST', `/api/events/${EV.id}/leads/${EV.dana}/draft`));
    assert.deepStrictEqual([d2.status, /^Hi Dana,/.test(d2.data.body), g.log.allow.map((a) => a.provider)], [200, true, ['claude', 'gemini']]);
    // A burst refusal goes out as it is: no Gemini call.
    const before = await modelCalls();
    for (const code of ['burst-minute', 'burst-day']) {
      g = guardCF({ ok: false, status: 429, code, message: 'Lots of people are using AI right now - try again in a minute.' });
      const b = await cf(g, () => theo('POST', `/api/events/${EV.id}/leads/${EV.dana}/draft`));
      assert.deepStrictEqual([b.status, b.data.code, g.log.order], [429, code, ['allow']]);
    }
    await settle();
    assert.strictEqual(await modelCalls(), before, 'nobody charged for a burst');
    // The scan (Gemini only) is on in this mode.
    g = fakeGuard();
    const s = await cf(g, () => theo('POST', scanPath(), scanBody()));
    assert.deepStrictEqual([s.status, s.data.check, g.log.allow.map((a) => a.provider)], [200, ['email'], ['gemini']]);
  } finally { console.log = quietLog; console.error = quietErr; }
  assert.strictEqual((await theo('DELETE', `/api/events/${EV.id}/leads/${up.data.lead.id}`)).status, 200);
  assert.deepStrictEqual(lines.filter((l) => /claude failed/.test(l)), ['[booth] claude failed (500); used gemini', '[booth] claude failed (unusable); used gemini', '[booth] claude failed (monthly-cap); used gemini', '[booth] claude failed (monthly-cap); used gemini']);
  assert.match(src('public/app.js'), /me\.ai === 'claude-first' \? 'Claude drafts \(Gemini if Claude is busy\); Gemini scans'/);
});

test('the page: says what is sent, will not save an unchecked field, never sends, and writes no style attribute', () => {
  const js = src('public/app.js');
  const html = src('public/index.html');
  assert.match(js, /function scanOn\(\) \{ return Boolean\(state\.me && state\.me\.scan\); \}/, 'the scan is offered only when the server says so');
  assert.match(js, /What is sent: the photo and your memo go to Google’s Gemini to be read once/);
  assert.match(js, /What is sent: the photo goes to Anthropic’s Claude to be read once/);
  assert.match(js, /if \(save\) save\.disabled = left\.length > 0;/, 'nothing can be saved while an unsure field is unchecked');
  assert.match(js, /if \(Object\.keys\(scan\.marks\)\.some\(function \(k\) \{ return scan\.marks\[k\] === 'check'; \}\)\) return syncSave\(\);/);
  assert.match(js, /scan\.photo = null; scan\.memo = null;/, 'the page lets go of the media once it is read');
  assert.match(js, /You send it yourself: Booth never sends anything\./);
  assert.match(js, /var same = \['name', 'company', 'title'\]\.every/, 'a draft is dropped if the rep changed who it is for');
  assert.ok(!/localStorage\.setItem\([^)]*(memo|photo|image)/i.test(js), 'media is never kept in the browser');
  for (const [name, text] of [['app.js', js], ['index.html', html]]) {
    assert.ok(!/style\s*=\s*["']/.test(text) && !/\.style\./.test(text) && !/\bon[a-z]+\s*=\s*"/.test(text.replace(/<meta[^>]*>/g, '')), `${name}: no style= and no inline handler`);
  }
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), 'no inline script');
  assert.ok(html.includes('data-mount="api/auth"') && html.includes('verify-banner.js'));
});

test('leaderboard and going cold: the whole team sees names and counts; clocks come from capture time', async () => {
  // Back-date two leads: one hot and past 48 hours, one hot with 5 hours left.
  const leads = await store.list(`events/${EV.id}/leads`);
  const hotT = leads.filter((l) => l.temp === 'hot' && !l.sentAt && l.capturedByName === 'Theo');
  await store.merge(`events/${EV.id}/leads`, hotT[0].id, { capturedAt: new Date(Date.now() - 50 * H).toISOString() });
  await store.merge(`events/${EV.id}/leads`, hotT[1].id, { capturedAt: new Date(Date.now() - 43 * H).toISOString() });
  const sc = await priya('GET', `/api/events/${EV.id}/scorecard`);
  assert.strictEqual(sc.data.goingCold[0].id, hotT[1].id, 'the one about to go cold leads the list');
  assert.strictEqual(sc.data.goingCold[0].clock.state, 'cooling');
  assert.ok(sc.data.goingCold.some((g) => g.id === hotT[0].id && g.clock.state === 'cold'));
  assert.strictEqual(sc.data.scorecard.wentCold, 1);
  const board = await priya('GET', `/api/events/${EV.id}/leaderboard`);
  assert.strictEqual(board.status, 200);
  assert.deepStrictEqual(board.data.rows.map((r) => r.name).sort(), ['Maya', 'Priya', 'Theo']);
  const me = board.data.rows.find((r) => r.you);
  assert.strictEqual(me.name, 'Priya');
  const theoRow = board.data.rows.find((r) => r.name === 'Theo');
  assert.strictEqual(theoRow.wentCold, 1);
  assert.ok(theoRow.captured >= 8 && theoRow.badges.includes('first'));
  assert.ok(!JSON.stringify(board.data.rows).includes('@example.com'), 'the board carries names and counts, not contacts');
});

test('CSV export: the owner’s, every lead, formula injection kept as text', async () => {
  await theo('POST', `/api/events/${EV.id}/leads`, { name: '=HYPERLINK("http://evil.example","click")', company: '@SUM(1+1)', email: 'formula@example.com', temp: 'cold', note: '+cmd|calc' });
  const res = await fetch(`${base}/api/events/${EV.id}/export.csv`, { headers: { Cookie: (await cookieOf('maya@example.com')) } });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="booth-southeast-food-bev-expo-\d{4}-\d{2}-\d{2}\.csv"/);
  const csv = await res.text();
  const rows = csv.trim().split('\r\n');
  const total = (await store.list(`events/${EV.id}/leads`)).length;
  assert.strictEqual(rows.length, total + 1, 'a header and one row per lead');
  assert.ok(csv.includes('"\'=HYPERLINK(""http://evil.example"",""click"")"'), 'the formula is text');
  assert.ok(csv.includes("'@SUM(1+1)") && csv.includes("'+cmd|calc"));
  assert.ok(!/(^|,)[=+@]/m.test(csv.replace(/^﻿/, '')), 'no cell starts a formula');
  assert.ok(csv.includes('dana@example.com') && csv.includes('4800'));
});

// The same browser session, recreated for a raw fetch.
async function cookieOf(email) {
  const c = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'a long enough password' }) });
  return c.headers.get('set-cookie').split(';')[0];
}

test('no teammate is sent anyone else’s uid or email (2026-09-27)', async () => {
  const others = { maya: ['theo', 'priya'], theo: ['maya', 'priya'], priya: ['maya', 'theo'] };
  const who = { maya, theo, priya };
  for (const [me, them] of Object.entries(others)) {
    const c = who[me];
    const bodies = [];
    for (const p of [`/api/events/${EV.id}`, `/api/events/${EV.id}/leads`, `/api/events/${EV.id}/leads/${EV.dana}`, `/api/events/${EV.id}/leaderboard`,
      `/api/events/${EV.id}/scorecard`, `/api/events/${EV.id}/leads/${EV.dana}/template`, '/api/me']) {
      const r = await c('GET', p);
      assert.strictEqual(r.status, 200, p);
      bodies.push(JSON.stringify(r.data));
    }
    bodies.push(JSON.stringify((await c('POST', `/api/events/${EV.id}/leads/${EV.dana}/status`, { status: 'won', value: 4800 })).data));
    const text = bodies.join('\n');
    for (const o of them) {
      for (const needle of [uidOf(`${o}@example.com`), `${o}@example.com`]) assert.ok(!text.includes(needle), `${me} was sent ${needle}`);
    }
    // Not even their own uid: `you` and `mine` say it.
    assert.ok(!text.includes(uidOf(`${me}@example.com`)), `${me} was sent their own uid`);
  }
  const ev = (await theo('GET', `/api/events/${EV.id}`)).data;
  assert.ok(ev.people.every((p) => /^[A-Za-z0-9_-]{22}$/.test(p.id) && p.uid === undefined));
  assert.deepStrictEqual(ev.people.filter((p) => p.you).map((p) => p.name), ['Theo']);
  const lb = (await theo('GET', `/api/events/${EV.id}/leaderboard`)).data.rows;
  assert.ok(lb.every((r) => r.uid === undefined)); assert.deepStrictEqual(lb.filter((r) => r.you).map((r) => r.name), ['Theo']);
  // The id is per event: the same person has another one on another event.
  const other = await maya('POST', '/api/events', { name: 'Id Check Market', startDate: '2026-10-10' });
  const mayaHere = ev.people.find((p) => p.name === 'Maya').id;
  const mayaThere = (await maya('GET', `/api/events/${other.data.id}`)).data.people[0].id;
  assert.notStrictEqual(mayaHere, mayaThere, 'not joinable across events');
  assert.strictEqual((await maya('DELETE', `/api/events/${other.data.id}`)).status, 200);
});

test('staff get 403 on owner-only routes - and can still do the booth work', async () => {
  for (const [m, p, b] of [['PUT', `/api/events/${EV.id}`, { name: 'Mine now' }], ['DELETE', `/api/events/${EV.id}`], ['POST', `/api/events/${EV.id}/code`],
    ['DELETE', `/api/events/${EV.id}/members/${uidOf('priya@example.com')}`], ['DELETE', `/api/events/${EV.id}/members/${(await idOf(theo, 'Priya'))}`], ['GET', `/api/events/${EV.id}/export.csv`],
    ['POST', `/api/events/${EV.id}/share`], ['DELETE', `/api/events/${EV.id}/share`]]) {
    assert.strictEqual((await theo(m, p, b)).status, 403, `${m} ${p}`);
  }
  const own = await theo('POST', `/api/events/${EV.id}/leads`, { name: 'Theo’s Own', email: 'own@example.com', temp: 'cold' });
  assert.strictEqual((await theo('DELETE', `/api/events/${EV.id}/leads/${own.data.lead.id}`)).status, 200, 'staff delete their own leads');
  const priyaLead = (await store.list(`events/${EV.id}/leads`)).find((l) => l.capturedByName === 'Priya');
  assert.strictEqual((await theo('DELETE', `/api/events/${EV.id}/leads/${priyaLead.id}`)).status, 403, 'not someone else’s lead');
  assert.strictEqual((await theo('PUT', `/api/events/${EV.id}/me`, { signoff: 'Theo · Brightline', tone: 'direct' })).data.tone, 'direct');
  assert.strictEqual((await theo('PUT', `/api/events/${EV.id}/leads/${priyaLead.id}`, { temp: 'hot' })).status, 200, 'anyone on the team can re-qualify a lead');
  const ev = await maya('GET', `/api/events/${EV.id}`);
  assert.strictEqual(ev.data.name, 'Southeast Food & Bev Expo', 'untouched');
});

test('strangers get 404 on every event route, before any model call or big body', async () => {
  eve = await register('eve@example.com');
  const calls = await modelCalls();
  const lid = EV.dana;
  for (const [m, p, b] of [['GET', `/api/events/${EV.id}`], ['PUT', `/api/events/${EV.id}`, { name: 'x' }], ['DELETE', `/api/events/${EV.id}`], ['POST', `/api/events/${EV.id}/code`],
    ['PUT', `/api/events/${EV.id}/me`, { name: 'Eve' }], ['DELETE', `/api/events/${EV.id}/members/me`], ['GET', `/api/events/${EV.id}/leads`],
    ['POST', `/api/events/${EV.id}/leads`, { name: 'x', temp: 'hot' }], ['GET', `/api/events/${EV.id}/leads/${lid}`], ['PUT', `/api/events/${EV.id}/leads/${lid}`, { temp: 'cold' }],
    ['POST', `/api/events/${EV.id}/leads/${lid}/status`, { status: 'lost' }], ['POST', `/api/events/${EV.id}/leads/${lid}/merge`, { name: 'x', temp: 'hot' }],
    ['DELETE', `/api/events/${EV.id}/leads/${lid}`], ['GET', `/api/events/${EV.id}/leads/${lid}/template`], ['POST', `/api/events/${EV.id}/leads/${lid}/draft`, {}],
    ['POST', `/api/events/${EV.id}/read`, { image: { type: 'image/jpeg', data: JPEG } }], ['GET', `/api/events/${EV.id}/leaderboard`], ['GET', `/api/events/${EV.id}/scorecard`],
    ['GET', `/api/events/${EV.id}/export.csv`], ['POST', `/api/events/${EV.id}/share`], ['DELETE', `/api/events/${EV.id}/share`],
    ['GET', '/api/events/nope-nope'], ['GET', `/api/events/${EV.id}/leads/nope-nope`]]) {
    const r = await eve(m, p, b);
    assert.strictEqual(r.status, 404, `${m} ${p} -> ${r.status}`);
  }
  assert.strictEqual((await maya('GET', `/api/events/${EV.id}/leads/nope-nope`)).status, 404, 'a member asking for a missing lead');
  // A stranger's 5 MB upload is refused by membership before it is parsed.
  const big = await eve('POST', `/api/events/${EV.id}/read`, { image: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } });
  assert.strictEqual(big.status, 404);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'a stranger costs nothing');
  assert.deepStrictEqual((await eve('GET', '/api/me')).data.events, []);
});

test('the shared scorecard: aggregates only, frozen, GET-only, noindex, revocable', async () => {
  const s = await maya('POST', `/api/events/${EV.id}/share`);
  assert.strictEqual(s.status, 200);
  assert.ok(s.data.token.length >= 22 && E.TOKEN_RE.test(s.data.token));
  const anon = client();
  const pub = await anon('GET', `/api/shared/${s.data.token}`);
  assert.strictEqual(pub.status, 200);
  const text = JSON.stringify(pub.data);
  const leads = await store.list(`events/${EV.id}/leads`);
  for (const l of leads) for (const v of [l.name, l.email, l.phone, l.company, l.note, l.title].filter((x) => x && x.length > 3)) assert.ok(!text.includes(v), `leaked: ${v}`);
  for (const who of ['Maya', 'Theo', 'Priya', 'example.com', uidOf('maya@example.com')]) assert.ok(!text.includes(who), `leaked: ${who}`);
  assert.deepStrictEqual([pub.data.event.name, pub.data.leads, pub.data.wonValue, pub.data.teamSize, pub.data.preview], ['Southeast Food & Bev Expo', leads.length, 4800, 3, false]);
  assert.strictEqual(pub.headers.get('referrer-policy'), 'no-referrer');
  assert.match(pub.headers.get('x-robots-tag'), /noindex/);
  const page = await fetch(`${base}/s/${s.data.token}`);
  assert.ok((await page.text()).includes('<base href="../">'));
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.strictEqual((await anon('POST', `/api/shared/${s.data.token}`, {})).status, 405, 'GET only');
  assert.strictEqual((await anon('DELETE', `/api/shared/${s.data.token}`)).status, 405);
  assert.strictEqual((await anon('PUT', `/s/${s.data.token}`, {})).status, 405);
  // Frozen: a capture changes nothing until Update.
  await theo('POST', `/api/events/${EV.id}/leads`, { name: 'After Sharing', email: 'after@example.com', temp: 'hot' });
  assert.strictEqual((await anon('GET', `/api/shared/${s.data.token}`)).data.leads, leads.length);
  const up = await maya('POST', `/api/events/${EV.id}/share`);
  assert.strictEqual(up.data.token, s.data.token, 'Update re-freezes the same link');
  assert.strictEqual((await anon('GET', `/api/shared/${s.data.token}`)).data.leads, leads.length + 1);
  assert.strictEqual((await maya('GET', `/api/shared/${s.data.token}`)).data.preview, true, 'the owner sees a preview banner');
  assert.strictEqual((await maya('DELETE', `/api/events/${EV.id}/share`)).status, 200);
  assert.strictEqual((await anon('GET', `/api/shared/${s.data.token}`)).status, 404, 'revoked for good');
  assert.strictEqual((await anon('GET', '/api/shared/short')).status, 404);
  EV.token = (await maya('POST', `/api/events/${EV.id}/share`)).data.token;
});

test('leaving and removal: leads stay with the team; a removed member is a stranger', async () => {
  const before = (await store.list(`events/${EV.id}/leads`)).length;
  assert.strictEqual((await maya('DELETE', `/api/events/${EV.id}/members/me`)).status, 400, 'the owner deletes instead of leaving');
  assert.strictEqual((await priya('DELETE', `/api/events/${EV.id}/members/me`)).data.left, true);
  assert.strictEqual((await priya('GET', `/api/events/${EV.id}/leads`)).status, 404);
  assert.strictEqual((await maya('DELETE', `/api/events/${EV.id}/members/${uidOf('theo@example.com')}`)).status, 404, 'a raw uid names nobody');
  assert.strictEqual((await maya('DELETE', `/api/events/${EV.id}/members/${await idOf(maya, 'Theo')}`)).status, 200);
  assert.strictEqual((await theo('GET', `/api/events/${EV.id}`)).status, 404);
  assert.strictEqual((await store.list(`events/${EV.id}/leads`)).length, before, 'their leads are the team’s');
});

test('caps: team size and events a person runs', async () => {
  const ev2 = await maya('POST', '/api/events', { name: 'Small Market', startDate: '2026-10-03' });
  const raw = await store.get('events', ev2.data.id);
  await store.merge('events', ev2.data.id, { memberIds: [...raw.memberIds, ...Array.from({ length: E.LIMITS.members - 1 }, (_, i) => `filler${i}`)] });
  const full = await eve('POST', '/api/join', { code: raw.code });
  assert.strictEqual(full.status, 409);
  assert.match(full.data.error, /full/);
  const uid = uidOf('eve@example.com');
  for (let i = 0; i < E.LIMITS.ownedEvents; i++) {
    await store.set('events', `evefill${i}`, { name: `E${i}`, ownerId: uid, memberIds: [uid], startDate: '2026-01-01', code: 'X' });
    await store.set(`events/evefill${i}/members`, uid, { name: 'Eve', role: 'owner' });
  }
  const r = await eve('POST', '/api/events', { name: 'One Too Many' });
  assert.strictEqual(r.status, 409);
});

test('deleting an event takes its leads, members, code and share link with it', async () => {
  const raw = await store.get('events', EV.id);
  assert.strictEqual((await maya('DELETE', `/api/events/${EV.id}`)).status, 200);
  assert.strictEqual((await maya('GET', `/api/events/${EV.id}`)).status, 404);
  assert.deepStrictEqual(await store.list(`events/${EV.id}/leads`), []);
  assert.deepStrictEqual(await store.list(`events/${EV.id}/members`), []);
  assert.strictEqual(await store.get('codes', raw.code), null);
  assert.strictEqual(await store.get('shares', EV.token), null);
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use('/booth', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/booth`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
