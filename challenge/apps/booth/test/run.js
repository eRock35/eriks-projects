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
  assert.deepStrictEqual([l.email, l.chips, l.next, l.source, l.status, l.value, l.capturedByName, l.capturedBy], ['dana@example.com', ['Wholesale'], 'quote', 'card', 'new', null, 'Theo', uidOf('theo@example.com')], 'status, value and capturer are the server’s, not the body’s');
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
  assert.deepStrictEqual([sent.data.lead.status, sent.data.lead.clock.state, sent.data.lead.clock.onTime, sent.data.lead.sentBy], ['sent', 'done', true, uidOf('maya@example.com')]);
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

test('staff get 403 on owner-only routes - and can still do the booth work', async () => {
  for (const [m, p, b] of [['PUT', `/api/events/${EV.id}`, { name: 'Mine now' }], ['DELETE', `/api/events/${EV.id}`], ['POST', `/api/events/${EV.id}/code`],
    ['DELETE', `/api/events/${EV.id}/members/${uidOf('priya@example.com')}`], ['GET', `/api/events/${EV.id}/export.csv`],
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
  assert.strictEqual((await maya('DELETE', `/api/events/${EV.id}/members/${uidOf('theo@example.com')}`)).status, 200);
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
