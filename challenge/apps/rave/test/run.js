// End to end, against the memory store and the fake model:
//   RAVE_MEMORY=1 RAVE_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// Drives the real Express app over HTTP, mounted under /rave the way the lab
// mounts it, so the auth cookie, the budget gate, every ownership check and
// the public wall are exercised as deployed rather than as unit-tested
// pieces. The pure rules (heat, lint, triage, templates, scoreboard, streaks)
// get fixed-date tests first.

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.RAVE_MEMORY !== '1' || process.env.RAVE_FAKE_AI !== '1') {
  console.error('run with RAVE_MEMORY=1 RAVE_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const V = require('../lib/reviews');
const R = require('../public/rules');
const aiLib = require('../lib/ai');
const photo = require('../lib/photo');
const { demo, ANGRY, CALM } = require('../lib/demo');

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
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, headers: res.headers };
  };
}

const uidOf = (email) => Buffer.from(email).toString('base64url');
const spentBy = async (email) => Number(((await identityStore.get('users', uidOf(email))) || {}).spentUsd || 0);
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15)); // the meter writes usage rows fire-and-forget
const TODAY = V.utcToday();
const day = (n) => V.addDays(TODAY, n);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]).toString('base64');
const BLANK = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('BLANK page'), Buffer.alloc(500, 3)]).toString('base64');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- pure rules ---------------- */

const T = '2026-09-24';

test('heat: a calm reply is cool; an angry one is hot, with every reason named', () => {
  const calm = R.heat('Hi Maya, thank you so much for the kind words - see you soon!', {});
  assert.strictEqual(calm.level, 'cool');
  assert.strictEqual(calm.score, 0);
  const h = R.heat(ANGRY, { reviewer: 'Brett Lawson' });
  assert.ok(h.score >= 35, `angry draft only ${h.score}`);
  const kinds = h.flags.map((f) => f.kind);
  for (const k of ['blame', 'caps', 'exclaim', 'argue', 'dismiss']) assert.ok(kinds.includes(k), `missing ${k}`);
  assert.ok(h.flags.find((f) => f.kind === 'dismiss').sample.includes('bother coming back'), 'curly quotes are straightened');
  const insult = R.heat('You are an entitled idiot and a liar. WTF.', {});
  assert.ok(insult.flags.some((f) => f.kind === 'insult') && insult.flags.some((f) => f.kind === 'profanity'));
  assert.ok(insult.score >= 35);
  // Private details: someone else's number and their full name heat it; the owner's own line does not.
  assert.strictEqual(R.heat('Call me on (555) 010-2277.', { contactLine: '(555) 010-2277' }).score, 0);
  assert.ok(R.heat('Brett Lawson called 555-201-3344 about order #88231.', { reviewer: 'Brett Lawson' }).flags.some((f) => f.kind === 'private'));
  assert.strictEqual(R.heat('THANK YOU!', {}).flags.filter((f) => f.kind === 'caps').length, 1);
  assert.strictEqual(R.heat('We use an IPA from a local BBQ spot in the USA.', {}).score, 0, 'acronyms are not shouting');
});

test('lint: every rule fires, and a good reply passes clean', () => {
  const keys = (res) => res.issues.map((i) => i.key);
  assert.deepStrictEqual(keys(R.lint('', { stars: 5 })), ['empty']);
  assert.ok(keys(R.lint('Hi [name], thanks for visiting us, we loved having you.', { stars: 5 })).includes('placeholder'));
  const long = Array(160).fill('word').join(' ');
  assert.ok(keys(R.lint(long, { stars: 5 })).includes('long'));
  const a = 'Hi Maya, thank you so much for the kind words about our buns and lattes, we hope to see you again soon at the cafe.';
  const b = 'Hi Tom, thank you so much for the kind words about our buns and lattes, we hope to see you again soon at the cafe.';
  assert.ok(R.similarity(a, b) >= R.COPY_LINE, 'only the name differs');
  assert.ok(R.similarity(a, 'Thanks for coming by! The patio is dog friendly all year round.') < 0.2);
  assert.ok(keys(R.lint(b, { stars: 5, others: [{ label: 'Maya R.', text: a }] })).includes('copy'));
  const bad = R.lint("Hi Brett Lawson, that's not true. Your order #12345 was on time.", { stars: 1, reviewer: 'Brett Lawson', contactLine: 'ana@cafe.example' });
  for (const k of ['fullname', 'private', 'argue', 'offline']) assert.ok(keys(bad).includes(k), `missing ${k}`);
  assert.ok(!bad.ok);
  assert.ok(bad.issues.find((i) => i.key === 'offline').detail.includes('ana@cafe.example'), 'suggests the contact line');
  const withLine = R.lint("Hi Brett, I'm so sorry about your visit. I'd like to hear more: ana@cafe.example.", { stars: 1, reviewer: 'Brett Lawson', contactLine: 'ana@cafe.example or (555) 010-2277' });
  assert.ok(!keys(withLine).includes('offline'), 'the contact line counts as an invitation');
  assert.ok(!keys(withLine).includes('private'), 'the owner\'s own email is not private');
  assert.ok(keys(R.lint("Hi Jo, we're so sorry - it was our fault that the chicken made you ill. Please call me.", { stars: 1, risk: true })).includes('admit'));
  assert.ok(keys(R.lint(ANGRY, { stars: 1, reviewer: 'Brett Lawson' })).includes('heat'));
  assert.ok(keys(R.lint('Hi Maya, so glad you enjoyed the buns. See you soon, Ana', { stars: 5 })).includes('thanks'));
  const good = R.lint(CALM, { stars: 1, reviewer: 'Brett Lawson', contactLine: 'ana@juniperandrye.example or (555) 010-2277' });
  assert.ok(good.ok, JSON.stringify(good.issues));
  assert.strictEqual(good.heat.level, 'cool');
});

test('quick triage: topics, praise vs complaints, risk flags and urgency from words alone', () => {
  const t = R.quickTriage({ stars: 1, text: 'Worst brunch of my life. Waited 50 minutes for cold eggs, and the waiter was rude.' });
  assert.strictEqual(t.sentiment, 'negative');
  for (const k of ['food', 'wait', 'staff']) assert.ok(t.complaints.includes(k), k);
  assert.strictEqual(t.praise.length, 0);
  assert.strictEqual(t.urgency, 'high');
  assert.strictEqual(t.risk.flag, false);
  const mixed = R.quickTriage({ stars: 4, text: 'Great sourdough and a lovely patio. Only knock: we waited 20 minutes for a table.' });
  assert.ok(mixed.praise.includes('food') && mixed.praise.includes('atmosphere'));
  assert.ok(mixed.complaints.includes('wait'));
  assert.strictEqual(mixed.sentiment, 'mixed');
  assert.deepStrictEqual(R.quickTriage({ stars: 1, text: 'We both got sick after the chicken.' }).risk.reasons, ['health']);
  assert.deepStrictEqual(R.quickTriage({ stars: 1, text: 'I will be talking to my lawyer.' }).risk.reasons, ['legal']);
  assert.deepStrictEqual(R.quickTriage({ stars: 1, text: 'They refused to seat us, it felt racist.' }).risk.reasons, ['discrimination']);
  assert.strictEqual(R.quickTriage({ stars: 1, text: 'We both got sick.' }).urgency, 'urgent');
  assert.strictEqual(R.quickTriage({ stars: 5, text: '' }).sentiment, 'positive');
  assert.strictEqual(R.firstName('brett lawson'), 'Brett');
  assert.strictEqual(R.firstName('A Google User'), '');
  assert.strictEqual(R.displayName('Brett Lawson'), 'Brett L.');
  assert.strictEqual(R.displayName(''), 'A customer');
});

test('model triage: enums checked, risk is a union, urgency never below the rules', () => {
  const v = V.validateTriage({ sentiment: 'furious', topics: ['food', 'nonsense', 'FOOD'], praise: ['aliens'], complaints: ['wait'], riskReasons: ['health', 'aliens'], urgency: 'apocalyptic', summary: '<b>hi</b> there', approach: 'x'.repeat(500) }, 1);
  assert.strictEqual(v.sentiment, 'negative', 'unknown sentiment falls back to the stars');
  assert.deepStrictEqual(v.topics, ['food']);
  assert.deepStrictEqual(v.praise, []);
  assert.deepStrictEqual(v.risk.reasons, ['health']);
  assert.strictEqual(v.urgency, 'normal');
  assert.strictEqual(v.summary, 'bhi/b there');
  assert.strictEqual(v.approach.length, 220);
  // The model says no risk and low urgency; the words say health and 1 star.
  const merged = V.triageOf({ stars: 1, text: 'I got food poisoning here.', triage: { sentiment: 'negative', topics: [], praise: [], complaints: [], risk: { reasons: [] }, urgency: 'low', summary: '', approach: '' } });
  assert.deepStrictEqual(merged.risk.reasons, ['health'], 'the model cannot remove a rules flag');
  assert.strictEqual(merged.urgency, 'urgent');
  assert.strictEqual(merged.by, 'ai');
  // The model catches one the words missed.
  const added = V.triageOf({ stars: 2, text: 'Felt awful after.', triage: { ...V.validateTriage({ riskReasons: ['health'], urgency: 'high' }, 2) } });
  assert.deepStrictEqual(added.risk.reasons, ['health']);
});

test('templates: per stars and tone, first name only, offline for the unhappy, no details on a risk', () => {
  const s = { ...V.SETTINGS_DEFAULTS, businessName: 'Juniper & Rye', ownerName: 'Ana', signOff: 'Warmly,', tone: 'warm', contactLine: 'ana@jr.example' };
  const five = V.template({ id: 'a', stars: 5, reviewer: 'Maya Reyes', text: 'Loved the cardamom buns and the staff were so friendly.' }, s);
  assert.ok(five.startsWith('Hi Maya,'));
  assert.ok(!five.includes('Reyes'), 'never the surname');
  assert.ok(five.endsWith('Warmly,\nAna, Juniper & Rye'));
  assert.ok(R.lint(five, { stars: 5, reviewer: 'Maya Reyes', contactLine: s.contactLine }).ok);
  const low = V.template({ id: 'b', stars: 1, reviewer: 'Brett Lawson', text: 'Waited an hour and the food was cold.' }, { ...s, tone: 'playful' });
  assert.ok(low.startsWith('Hi Brett,'), 'playful goes warm for a 1-star');
  assert.ok(low.includes('ana@jr.example'));
  assert.ok(R.lint(low, { stars: 1, reviewer: 'Brett Lawson', contactLine: s.contactLine }).ok, JSON.stringify(R.lint(low, { stars: 1, reviewer: 'Brett Lawson', contactLine: s.contactLine }).issues));
  const risk = V.template({ id: 'c', stars: 1, reviewer: 'J. M.', text: 'We got food poisoning from the chicken.' }, { ...s, tone: 'professional' });
  assert.ok(risk.startsWith('Hello,'), 'no usable name, no name');
  assert.ok(!/chicken|poison/i.test(risk), 'a risky review gets no details in public');
  assert.ok(risk.includes('ana@jr.example'));
  assert.ok(R.lint(risk, { stars: 1, risk: true, contactLine: s.contactLine }).ok);
  const r = { id: 'd', stars: 4, reviewer: 'Dev', text: 'Great sourdough, but we waited 20 minutes.' };
  assert.notStrictEqual(V.template(r, s, 0), V.template(r, s, 1), 'another template is another template');
  assert.strictEqual(V.template(r, s, 0), V.template(r, s, 0), 'deterministic');
  assert.ok(V.template({ id: 'e', stars: 5, reviewer: '', text: '' }, {}).includes('The team'));
});

test('scoreboard: response rate, median reply time, rating trend, stars and topics', () => {
  const mk = (id, stars, posted, added, repliedAt, text = '') => ({ id, stars, date: posted, addedAt: `${added}T08:00:00.000Z`, addedDay: added, repliedAt, repliedDay: repliedAt ? repliedAt.slice(0, 10) : null, text });
  const reviews = [
    mk('a', 5, V.addDays(T, -2), V.addDays(T, -2), `${V.addDays(T, -2)}T12:00:00.000Z`, 'Great coffee'), // 4h
    mk('b', 1, V.addDays(T, -3), V.addDays(T, -3), `${V.addDays(T, -1)}T08:00:00.000Z`, 'Rude staff'), // 48h
    mk('c', 4, V.addDays(T, -40), V.addDays(T, -40), `${V.addDays(T, -39)}T08:00:00.000Z`, 'Lovely atmosphere'), // 24h
    // Posted months ago, added today: the clock starts when it landed, not when it was posted.
    mk('d', 3, V.addDays(T, -100), T, `${T}T10:00:00.000Z`, 'Fine'), // 2h
    mk('e', 2, V.addDays(T, -1), V.addDays(T, -1), null, 'Cold food'),
  ];
  const s = V.scoreboard(reviews, T);
  assert.strictEqual(s.total, 5);
  assert.strictEqual(s.replied, 4);
  assert.strictEqual(s.responseRate, 80);
  assert.strictEqual(s.medianReplyHours, 14, 'median of 2, 4, 24, 48');
  assert.strictEqual(s.avgRating, 3);
  assert.strictEqual(s.avg30, 2.7, '5, 1, 2');
  assert.strictEqual(s.avgPrev30, 4);
  assert.strictEqual(s.trend30, -1.3);
  assert.deepStrictEqual(s.distribution, { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 });
  assert.strictEqual(s.months.length, 6);
  assert.strictEqual(s.months[5].month, T.slice(0, 7));
  assert.strictEqual(s.months[5].count, 3);
  assert.strictEqual(s.waiting, 1);
  assert.strictEqual(s.urgentWaiting, 1);
  const staff = s.topics.find((t) => t.key === 'staff');
  assert.deepStrictEqual([staff.praise, staff.complaints], [0, 1]);
  assert.strictEqual(s.topics.find((t) => t.key === 'drink').praise, 1);
  assert.strictEqual(V.scoreboard([], T).responseRate, null);
  // A backlog logged as answered before it was added has no reply time at all.
  const backlog = mk('f', 5, V.addDays(T, -10), T, `${V.addDays(T, -9)}T12:00:00.000Z`, 'Great');
  assert.strictEqual(V.replyHours(backlog), null);
  assert.strictEqual(V.scoreboard([...reviews, backlog], T).medianReplyHours, 14, 'and does not drag the median to zero');
  assert.strictEqual(V.scoreboard([...reviews, backlog], T).responseRate, 83);
  assert.strictEqual(R.quickTriage({ stars: 1, text: '$45 for this? The barber was rude and the fade was uneven.' }).complaints.join(), 'staff,price,quality');
});

test('streaks: inbox zero day by day, at risk while today has something waiting', () => {
  const mk = (arrived, replied) => ({ date: arrived, addedDay: arrived, addedAt: `${arrived}T09:00:00Z`, repliedAt: replied ? `${replied}T10:00:00Z` : null, repliedDay: replied });
  // Arrived 10 days ago, answered 7 days ago; zero every day since.
  let s = V.streaks([mk(V.addDays(T, -10), V.addDays(T, -7))], T);
  assert.deepStrictEqual(s, { current: 8, best: 8, atRisk: false, todayZero: true });
  // A new one this morning: the streak holds from yesterday, at risk.
  s = V.streaks([mk(V.addDays(T, -10), V.addDays(T, -7)), mk(T, null)], T);
  assert.deepStrictEqual(s, { current: 7, best: 7, atRisk: true, todayZero: false });
  // One left unanswered since yesterday breaks it.
  s = V.streaks([mk(V.addDays(T, -10), V.addDays(T, -7)), mk(V.addDays(T, -1), null)], T);
  assert.strictEqual(s.current, 0);
  assert.strictEqual(s.best, 6);
  assert.strictEqual(V.streaks([], T).current, 0);
  const got = V.earnedBadges([mk(V.addDays(T, -10), V.addDays(T, -7))], T);
  assert.ok(got.has('first_reply') && got.has('streak_7'));
  assert.ok(!got.has('inbox_zero'), 'inbox zero needs three reviews');
});

test('dates as printed: relative and absolute, never the future', () => {
  assert.strictEqual(V.dayFromText('3 days ago', T), '2026-09-21');
  assert.strictEqual(V.dayFromText('a week ago', T), '2026-09-17');
  assert.strictEqual(V.dayFromText('yesterday', T), '2026-09-23');
  assert.strictEqual(V.dayFromText('2 hours ago', T), T);
  assert.strictEqual(V.dayFromText('Sep 3, 2026', T), '2026-09-03');
  assert.strictEqual(V.dayFromText('2026-09-30', T), null);
  assert.strictEqual(V.dayFromText('soon', T), null);
  assert.strictEqual(V.dayFromText('', T), null);
});

test('model answers are checked: cool-down kinds, screenshot readings, replies', () => {
  const c = aiLib.validateCool({ calm: 'Hi Brett,\n\n<script>x</script>Thank you for the feedback, truly.', removed: [{ kind: 'blame', quote: 'maybe if <b>you</b>', why: 'ok' }, { kind: 'bogus', quote: 'x', why: 'y' }, { kind: 'blame', quote: 'MAYBE IF <b>YOU</b>', why: 'dup' }, 'junk'], kept: '<i>k</i>' });
  assert.ok(!/[<>]/.test(c.calm));
  assert.deepStrictEqual(c.removed.map((x) => x.kind), ['blame'], 'unknown kinds and duplicates dropped');
  assert.strictEqual(c.kept, 'ik/i');
  assert.throws(() => aiLib.validateCool({ calm: '', removed: [] }), /empty/);
  assert.throws(() => aiLib.validateReply({ reply: 'hi' }), /empty/);
  assert.strictEqual(aiLib.validateRead({ readable: true, stars: 7, text: 'x' }, T), null, 'stars must be 1-5');
  assert.strictEqual(aiLib.validateRead({ readable: true, stars: 3.5, text: 'x' }, T), null);
  assert.strictEqual(aiLib.validateRead({ readable: false, stars: 3, text: 'x' }, T), null);
  const r = aiLib.validateRead({ readable: true, platform: 'YELP', stars: 2, reviewer: 'Dana <b>K</b>', dateText: '3 days ago', text: 'Slow.' }, T);
  assert.deepStrictEqual([r.platform, r.stars, r.reviewer, r.date, r.dateGuessed], ['yelp', 2, 'Dana bK/b', '2026-09-21', false]);
  assert.strictEqual(aiLib.validateRead({ readable: true, platform: 'myspace', stars: 4, dateText: 'whenever', text: 'ok' }, T).platform, 'other');
  for (const tool of [aiLib.TRIAGE_TOOL, aiLib.REPLY_TOOL, aiLib.COOL_TOOL, aiLib.READ_TOOL]) assert.strictEqual(tool.input_schema.type, 'object');
});

test('screenshots: JPEG passes; lies, wrong types and oversize are refused', () => {
  assert.strictEqual(photo.validate({ type: 'image/jpeg', data: JPEG }).mediaType, 'image/jpeg');
  assert.strictEqual(photo.validate({ data: 'data:image/jpeg;base64,' + JPEG }).mediaType, 'image/jpeg');
  assert.throws(() => photo.validate({ type: 'image/jpeg', data: Buffer.from('%PDF-1.7').toString('base64') }), /JPEG, PNG or WebP/);
  assert.throws(() => photo.validate({ type: 'image/gif', data: JPEG }), /JPEG, PNG or WebP/);
  assert.throws(() => photo.validate(null), /screenshot/);
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(photo.MAX_BYTES + 10)]).toString('base64');
  assert.throws(() => photo.validate({ type: 'image/jpeg', data: big }), /too large/);
});

test('the wall: favourites of 4+ stars only, first name and initial, nothing private', () => {
  const reviews = [
    { id: 'x1', stars: 5, reviewer: 'Maya Reyes', text: 'Loved it', date: '2026-09-20', platform: 'google', favourite: true, repliedAt: '2026-09-21T10:00:00Z', reply: { text: 'Thanks Maya!' }, triage: { summary: 'secret' } },
    { id: 'x2', stars: 3, reviewer: 'Priya Shah', text: 'Fine', date: '2026-09-19', platform: 'yelp', favourite: true },
    { id: 'x3', stars: 5, reviewer: 'Tom Hughes', text: 'Great', date: '2026-09-18', platform: 'yelp', favourite: false },
    { id: 'x4', stars: 4, reviewer: 'Sam', text: 'Good', date: '2026-09-22', platform: 'facebook', favourite: true, reply: { text: 'draft not posted' } },
  ];
  const w = V.wallOf({ businessName: 'JR', contactLine: 'secret line', ownerName: 'Ana' }, reviews, { title: 'Love <3', showReplies: true }, T);
  assert.deepStrictEqual(w.reviews.map((r) => r.name), ['Sam', 'Maya R.']);
  assert.strictEqual(w.title, 'Love 3');
  assert.strictEqual(w.reviews[1].reply, 'Thanks Maya!');
  assert.strictEqual(w.reviews[0].reply, '', 'an unposted draft never goes public');
  const s = JSON.stringify(w);
  for (const bad of ['Reyes', 'x1', 'secret', 'Ana', 'favourite', 'triage']) assert.ok(!s.includes(bad), `wall leaked ${bad}`);
  assert.strictEqual(V.wallOf({}, reviews, { showReplies: false }, T).reviews[1].reply, '');
});

test('the demo: a café inbox with a furious 1-star, a health flag and a cooled reply - no model', () => {
  const d = demo(T);
  assert.strictEqual(d.demo, true);
  assert.strictEqual(d.settings.businessName, 'Juniper & Rye');
  assert.ok(d.reviews.length >= 8);
  assert.strictEqual(d.reviews[0].triage.risk.reasons[0], 'health', 'the health scare is first in the inbox');
  assert.strictEqual(d.reviews[0].urgency, 'urgent');
  const brett = d.reviews.find((r) => r.reviewer === 'Brett Lawson');
  assert.strictEqual(brett.stars, 1);
  assert.strictEqual(brett.status, 'waiting');
  assert.ok(d.cooldown.heatBefore.score >= 35 && d.cooldown.heatAfter.level === 'cool');
  assert.ok(d.cooldown.lint.ok);
  assert.ok(d.drafts[brett.id].lint.ok, 'the free template for the furious one passes the checklist');
  assert.ok(d.scoreboard.responseRate > 50 && d.scoreboard.total === d.reviews.length);
  assert.ok(d.wall.reviews.length >= 3 && d.wall.reviews.every((r) => r.stars >= 4));
  assert.ok(d.badges.some((b) => b.earnedAt));
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { RAVE_MEMORY: '1' }], ['./lib/fakeai', { RAVE_FAKE_AI: '1' }], ['./server', { RAVE_FAKE_AI: '1', RAVE_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, RAVE_MEMORY: '', RAVE_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

/* ---------------- over HTTP ---------------- */

test('signed out: health, meta, the demo and rules.js work with zero model calls; nothing else does', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = await anon('GET', '/api/meta');
  assert.strictEqual(meta.data.kinds.length, R.KINDS.length);
  const d = await anon('GET', '/api/demo');
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.data.demo, true);
  assert.ok(d.data.cooldown.calm && d.data.scoreboard.total > 0);
  const rules = await fetch(`${base}/rules.js`);
  assert.strictEqual(rules.status, 200);
  assert.ok((await rules.text()).includes('RaveRules'), 'the page runs the same rules the server does');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/reviews'], ['POST', '/api/reviews'], ['GET', '/api/reviews/x'], ['POST', '/api/reviews/read'], ['POST', '/api/reviews/x/triage'], ['POST', '/api/reviews/x/draft'], ['POST', '/api/reviews/x/template'], ['POST', '/api/cooldown'], ['PUT', '/api/settings'], ['GET', '/api/scoreboard'], ['GET', '/api/wall'], ['POST', '/api/wall']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  // A stranger's 5 MB screenshot is turned away at the door, unread.
  const big = await anon('POST', '/api/reviews/read', { image: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } });
  assert.strictEqual(big.status, 401);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

let alice, bob;
const ids = {};

test('register, sign in; settings are cleaned', async () => {
  alice = client();
  const reg = await alice('POST', '/api/auth/register', { email: 'alice@example.com', password: 'correct horse battery' });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.data));
  let me = await alice('GET', '/api/me');
  assert.strictEqual(me.data.signedIn, true);
  assert.strictEqual(me.data.settings.setUp, false);
  assert.strictEqual(me.data.budget.remainingUsd, 2);
  await alice('POST', '/api/auth/logout');
  assert.strictEqual((await alice('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await alice('POST', '/api/auth/login', { email: 'alice@example.com', password: 'wrong password!!' })).status, 401);
  assert.strictEqual((await alice('POST', '/api/auth/login', { email: 'alice@example.com', password: 'correct horse battery' })).status, 200);
  const s = await alice('PUT', '/api/settings', { businessName: 'Alpine <Bakery>', ownerName: 'Alice', signOff: 'Cheers,', tone: 'sarcastic', contactLine: 'alice@alpine.example or 555-010-9999', alwaysSay: 'We bake daily.', neverSay: 'x'.repeat(900) });
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.data.businessName, 'Alpine Bakery');
  assert.strictEqual(s.data.tone, 'warm', 'an unknown tone is not stored');
  assert.strictEqual(s.data.neverSay.length, 300);
  const s2 = await alice('PUT', '/api/settings', { tone: 'professional' });
  assert.strictEqual(s2.data.tone, 'professional');
  assert.strictEqual(s2.data.businessName, 'Alpine Bakery', 'a partial save keeps the rest');
  assert.ok(!('badges' in s2.data) && !('wallToken' in s2.data));
  me = await alice('GET', '/api/me');
  assert.strictEqual(me.data.settings.setUp, true);
});

test('reviews: add with validation, markup stripped, sorted by what needs you most', async () => {
  for (const bad of [{ text: 'x' }, { stars: 0, text: 'x' }, { stars: 6, text: 'x' }, { stars: 'five', text: 'x' }, { stars: 2.5, text: 'x' }, { stars: 3, date: day(1) }, { stars: 3, date: '2026-02-30' }, { stars: 3, text: 'x'.repeat(12000) }]) {
    assert.strictEqual((await alice('POST', '/api/reviews', bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  const happy = await alice('POST', '/api/reviews', { stars: 5, platform: 'google', reviewer: 'Maya Reyes', date: day(-2), text: 'Loved the <script>cardamom</script> buns and the friendly staff.' }, { 'X-Local-Date': TODAY });
  assert.strictEqual(happy.status, 200, JSON.stringify(happy.data));
  assert.strictEqual(happy.data.displayName, 'Maya R.');
  assert.ok(!/[<>]/.test(happy.data.text));
  assert.strictEqual(happy.data.status, 'waiting');
  assert.strictEqual(happy.data.triage.by, 'rules');
  assert.ok(happy.data.triage.praise.includes('staff'));
  ids.happy = happy.data.id;
  const angry = await alice('POST', '/api/reviews', { stars: 1, platform: 'yelp', reviewer: 'Brett Lawson', text: 'Waited 50 minutes for cold eggs and the waiter rolled his eyes. Never again.' });
  ids.angry = angry.data.id;
  assert.strictEqual(angry.data.urgency, 'high');
  const sick = await alice('POST', '/api/reviews', { stars: 2, platform: 'myspace', reviewer: 'J. M.', text: 'Got sick after the chicken sandwich.' });
  ids.sick = sick.data.id;
  assert.strictEqual(sick.data.platform, 'other');
  assert.strictEqual(sick.data.urgency, 'urgent');
  assert.strictEqual(sick.data.triage.risk.reasons[0], 'health');
  const quiet = await alice('POST', '/api/reviews', { stars: 4, reviewer: '', text: '' });
  assert.strictEqual(quiet.status, 200, 'a rating-only review is allowed');
  assert.strictEqual(quiet.data.date, TODAY);
  ids.quiet = quiet.data.id;
  const list = await alice('GET', '/api/reviews');
  assert.deepStrictEqual(list.data.reviews.slice(0, 2).map((r) => r.id), [ids.sick, ids.angry], 'risk, then the unhappy');
  assert.strictEqual(list.data.counts.waiting, 4);
  assert.strictEqual(list.data.counts.urgent, 2);
  assert.ok(!('text' in list.data.reviews[0]) && 'excerpt' in list.data.reviews[0], 'the list sends excerpts');
  const ed = await alice('PUT', `/api/reviews/${ids.quiet}`, { stars: 5, repliedAt: 'hacked', favourite: true, triage: { risk: { reasons: ['legal'] } } });
  assert.strictEqual(ed.data.stars, 5);
  assert.strictEqual(ed.data.repliedAt, null, 'only the review facts are editable');
  assert.strictEqual(ed.data.favourite, false);
  assert.strictEqual(ed.data.triage.risk.flag, false);
  assert.strictEqual((await alice('PUT', `/api/reviews/${ids.quiet}`, { stars: 9 })).status, 400);
  assert.strictEqual((await alice('DELETE', `/api/reviews/${ids.quiet}`)).status, 200);
  assert.strictEqual((await alice('GET', `/api/reviews/${ids.quiet}`)).status, 404);
  assert.strictEqual((await alice('POST', '/api/reviews', 'x'.repeat(200 * 1024))).status, 413, 'the small parser everywhere else');
});

test('templates are free; a saved reply is linted; "I posted it" counts and earns', async () => {
  const calls = await modelCalls();
  const spent = await spentBy('alice@example.com');
  const t = await alice('POST', `/api/reviews/${ids.angry}/template`, {});
  assert.strictEqual(t.status, 200);
  assert.strictEqual(t.data.source, 'template');
  assert.ok(t.data.text.startsWith('Dear Brett,'), 'professional tone');
  assert.ok(t.data.text.includes('alice@alpine.example'));
  assert.ok(t.data.lint.ok, JSON.stringify(t.data.lint.issues));
  const t2 = await alice('POST', `/api/reviews/${ids.angry}/template`, { variant: 1 });
  assert.notStrictEqual(t2.data.text, t.data.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'templates never call a model');
  assert.strictEqual(await spentBy('alice@example.com'), spent);
  let r = await alice('PUT', `/api/reviews/${ids.happy}/reply`, { text: 'Hi Maya Reyes, <b>thanks</b>! Your order #55512 was a joy.', source: 'weird' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.reply.text, 'Hi Maya Reyes, bthanks/b! Your order #55512 was a joy.');
  assert.strictEqual(r.data.reply.source, 'own');
  assert.ok(r.data.lint.issues.some((i) => i.key === 'private'));
  assert.strictEqual(r.data.status, 'waiting', 'saving a draft is not replying');
  r = await alice('POST', `/api/reviews/${ids.happy}/replied`, { text: 'Hi Maya, thank you so much for the kind words about the buns - see you soon!', source: 'own' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.status, 'replied');
  assert.strictEqual(r.data.repliedDay, TODAY);
  assert.strictEqual(r.data.justReplied, true);
  assert.strictEqual(r.data.waitingLeft, 2);
  assert.ok(r.data.newBadges.some((b) => b.key === 'first_reply'));
  const again = await alice('POST', `/api/reviews/${ids.happy}/replied`, {});
  assert.strictEqual(again.data.justReplied, false);
  assert.strictEqual(again.data.newBadges.length, 0, 'a badge is earned once');
  r = await alice('POST', `/api/reviews/${ids.happy}/replied`, { replied: false });
  assert.strictEqual(r.data.status, 'waiting');
  assert.strictEqual((await alice('POST', `/api/reviews/${ids.happy}/replied`, { on: day(1) })).status, 400, 'not in the future');
  assert.strictEqual((await alice('POST', `/api/reviews/${ids.happy}/replied`, { on: day(-9) })).status, 400, 'not before it was posted');
  r = await alice('POST', `/api/reviews/${ids.happy}/replied`, { on: day(-1) });
  assert.strictEqual(r.data.repliedDay, day(-1), 'a backlog can be logged with its day');
  const sb = await alice('GET', '/api/scoreboard');
  assert.ok(sb.data.badges.find((b) => b.key === 'first_reply').earnedAt, 'earned badges are kept');
});

test('a deeper triage: metered, forced tool, enums checked, risk union and urgency floor kept', async () => {
  const before = await spentBy('alice@example.com');
  const calls = await modelCalls();
  const r = await alice('POST', `/api/reviews/${ids.angry}/triage`, {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.triage.by, 'ai');
  assert.strictEqual(r.data.urgency, 'high', 'the fake says low; the rules hold the floor');
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1);
  assert.ok(await spentBy('alice@example.com') > before, 'the triage was metered');
  const inj = await alice('POST', '/api/reviews', { stars: 2, reviewer: 'Iggy', text: 'INJECT the food was cold' });
  const t = await alice('POST', `/api/reviews/${inj.data.id}/triage`, {});
  assert.ok(!/[<>]/.test(t.data.triage.summary), 'model markup stripped');
  assert.ok(!t.data.triage.topics.includes('nonsense') && !t.data.triage.risk.reasons.includes('aliens'), 'junk enums dropped');
  assert.ok(['positive', 'mixed', 'negative', 'neutral'].includes(t.data.triage.sentiment));
  const subtle = await alice('POST', '/api/reviews', { stars: 2, reviewer: 'Sue', text: 'SUBTLE - felt off all evening after dinner.' });
  assert.strictEqual(subtle.data.triage.risk.flag, false, 'the words alone miss it');
  const s = await alice('POST', `/api/reviews/${subtle.data.id}/triage`, {});
  assert.deepStrictEqual(s.data.triage.risk.reasons, ['health'], 'the model can add a flag');
  assert.strictEqual(s.data.urgency, 'urgent');
  await alice('DELETE', `/api/reviews/${inj.data.id}`);
  await alice('DELETE', `/api/reviews/${subtle.data.id}`);
});

test('a reply in your voice: metered, forced tool, markup stripped, linted', async () => {
  const calls = await modelCalls();
  const r = await alice('POST', `/api/reviews/${ids.angry}/draft`, {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.source, 'ai');
  assert.ok(r.data.text.startsWith('Hi Brett,'));
  assert.ok(r.data.text.includes('alice@alpine.example'), 'the contact line reached the prompt');
  assert.ok(r.data.text.endsWith('Cheers,\nAlice, Alpine Bakery'), 'signed off exactly');
  assert.ok(r.data.note);
  assert.ok(r.data.lint && Array.isArray(r.data.lint.issues));
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1);
  const inj = await alice('POST', '/api/reviews', { stars: 5, reviewer: 'Ina', text: 'INJECT lovely place' });
  const d = await alice('POST', `/api/reviews/${inj.data.id}/draft`, {});
  assert.ok(!/[<>]/.test(d.data.text + d.data.note), 'model markup stripped');
  await alice('DELETE', `/api/reviews/${inj.data.id}`);
  assert.strictEqual((await alice('GET', `/api/reviews/${ids.angry}`)).data.status, 'waiting', 'drafting is not replying');
});

test('cool down: metered, measured by the rules on both sides, and the vent is never stored', async () => {
  const calls = await modelCalls();
  const dump = store._dump();
  const vent = 'Brett, maybe if you had come in on time you would not have WAITED!! People like you are why we hate Yelp. Don\'t bother coming back. zebra-vent-5521';
  const r = await alice('POST', '/api/cooldown', { text: vent, reviewId: ids.angry });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.heatBefore.score >= 35);
  assert.strictEqual(r.data.heatBefore.score, R.heat(vent, { reviewer: 'Brett Lawson', contactLine: 'alice@alpine.example or 555-010-9999' }).score, 'the number is the rules\', not the model\'s');
  assert.ok(r.data.heatAfter.score < r.data.heatBefore.score);
  assert.strictEqual(r.data.heatAfter.level, 'cool');
  assert.ok(r.data.calm.startsWith('Hi Brett,'));
  assert.ok(r.data.removed.length >= 3);
  assert.ok(r.data.removed.every((x) => R.KIND_KEYS.includes(x.kind) && x.label && x.emoji));
  assert.ok(r.data.removed.some((x) => x.kind === 'dismiss'));
  assert.ok(r.data.lint.ok, JSON.stringify(r.data.lint.issues));
  assert.strictEqual(r.data.reviewId, ids.angry);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1);
  assert.strictEqual(store._dump(), dump, 'cooling down writes nothing');
  assert.ok(!store._dump().includes('zebra-vent-5521'), 'the vent is nowhere');
  const inj = await alice('POST', '/api/cooldown', { text: 'INJECT oh wow, sorry you feel that way. Thanks for nothing!!' });
  assert.strictEqual(inj.status, 200);
  assert.ok(!/[<>]/.test(inj.data.calm + JSON.stringify(inj.data.removed)), 'markup stripped');
  assert.ok(!inj.data.removed.some((x) => x.kind === 'bogus'), 'unknown kinds dropped');
  assert.ok(inj.data.removed.some((x) => x.by === 'rules'), 'what the rules saw leave is listed even when the model forgot');
  assert.strictEqual((await alice('POST', '/api/cooldown', { text: 'meh' })).status, 400);
  assert.strictEqual((await alice('POST', '/api/cooldown', { text: 'long enough to cool', reviewId: 'nope' })).status, 404);
  const used = await alice('PUT', `/api/reviews/${ids.angry}/reply`, { text: r.data.calm, source: 'cooled' });
  assert.strictEqual(used.data.reply.source, 'cooled');
  const posted = await alice('POST', `/api/reviews/${ids.angry}/replied`, {});
  assert.strictEqual(posted.data.replySource, 'cooled');
  assert.ok(posted.data.newBadges.some((b) => b.key === 'cool_head'));
  assert.ok(posted.data.newBadges.some((b) => b.key === 'rescue'), 'a 1-star answered inside a day');
});

test('out of credit: 402 before any model call; templates, replies and scores stay free', async () => {
  bob = client();
  await bob('POST', '/api/auth/register', { email: 'bob@example.com', password: 'another long password' });
  const rv = await bob('POST', '/api/reviews', { stars: 2, reviewer: 'Kim', text: 'The coffee was cold.' });
  await identityStore.merge('users', uidOf('bob@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  for (const [p, body] of [[`/api/reviews/${rv.data.id}/triage`, {}], [`/api/reviews/${rv.data.id}/draft`, {}], ['/api/cooldown', { text: 'You clearly have no taste at all!!' }], ['/api/reviews/read', { image: { type: 'image/jpeg', data: JPEG } }]]) {
    const r = await bob('POST', p, body);
    assert.strictEqual(r.status, 402, p);
    assert.ok('topUpUrl' in r.data);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call was made');
  const t = await bob('POST', `/api/reviews/${rv.data.id}/template`, {});
  assert.strictEqual(t.status, 200);
  assert.ok(t.data.text.includes('Kim'));
  assert.strictEqual((await bob('PUT', `/api/reviews/${rv.data.id}/reply`, { text: t.data.text, source: 'template' })).status, 200);
  assert.strictEqual((await bob('POST', `/api/reviews/${rv.data.id}/replied`, {})).status, 200, 'replying is free');
  assert.strictEqual((await bob('GET', '/api/scoreboard')).data.responseRate, 100);
  assert.strictEqual(await spentBy('bob@example.com'), 100, 'nothing free ever spends');
  await identityStore.merge('users', uidOf('bob@example.com'), { spentUsd: 0 });
});

test('snap a review: bad image 400 before the model, unreadable 422, a proposal and nothing stored', async () => {
  const calls = await modelCalls();
  const spent = await spentBy('alice@example.com');
  assert.strictEqual((await alice('POST', '/api/reviews/read', { image: { type: 'image/jpeg', data: Buffer.from('not an image at all').toString('base64') } })).status, 400);
  assert.strictEqual((await alice('POST', '/api/reviews/read', {})).status, 400);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'refused before anything was spent');
  assert.strictEqual(await spentBy('alice@example.com'), spent);
  assert.strictEqual((await alice('POST', '/api/reviews/read', { image: { type: 'image/jpeg', data: BLANK } })).status, 422);
  const dump = store._dump();
  const r = await alice('POST', '/api/reviews/read', { image: { type: 'image/jpeg', data: JPEG } }, { 'X-Local-Date': TODAY });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual([r.data.platform, r.data.stars, r.data.reviewer, r.data.date], ['yelp', 2, 'Dana bKowalski/b', day(-3)]);
  assert.ok(r.data.text.startsWith('Waited 40 minutes'));
  assert.strictEqual(store._dump(), dump, 'reading saves nothing');
  assert.ok(!store._dump().includes(JPEG.slice(0, 60)), 'the image is nowhere in the store');
  const bigOk = await alice('POST', '/api/reviews/read', { image: { type: 'image/jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024 * 1024)]).toString('base64') } });
  assert.strictEqual(bigOk.status, 200, 'the snap route takes a real screenshot');
  const saved = await alice('POST', '/api/reviews', { ...r.data, source: 'snap' });
  assert.strictEqual(saved.data.source, 'snap');
  ids.snapped = saved.data.id;
});

let token;
test('the wall of love: frozen, revocable, first names only, GET only', async () => {
  assert.strictEqual((await alice('POST', '/api/wall', {})).status, 400, 'nothing hearted yet');
  assert.strictEqual((await alice('POST', `/api/reviews/${ids.angry}/favourite`, {})).status, 400, 'a 1-star cannot go on the wall');
  const t = await alice('POST', '/api/reviews', { stars: 5, reviewer: 'Tom Hughes', text: 'Dog-friendly patio and excellent coffee.', date: day(-4) });
  ids.tom = t.data.id;
  assert.strictEqual((await alice('POST', `/api/reviews/${ids.happy}/favourite`, {})).data.favourite, true);
  const w0 = await alice('GET', '/api/wall');
  assert.strictEqual(w0.data.share, null);
  assert.deepStrictEqual(w0.data.preview.reviews.map((r) => r.name), ['Maya R.']);
  const pub = await alice('POST', '/api/wall', { title: 'Why people <3 Alpine', showReplies: true });
  assert.strictEqual(pub.status, 200, JSON.stringify(pub.data));
  token = pub.data.share.token;
  assert.ok(/^[A-Za-z0-9_-]{22}$/.test(token), '128 random bits');
  assert.strictEqual(pub.data.share.url, `s/${token}`, 'relative to the app, never absolute');
  assert.ok(pub.data.newBadges.some((b) => b.key === 'wall'));
  const anon = client();
  const w = await anon('GET', `/api/shared/${token}`);
  assert.strictEqual(w.status, 200);
  assert.strictEqual(w.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual(w.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.strictEqual(w.data.title, 'Why people 3 Alpine');
  assert.strictEqual(w.data.reviews.length, 1);
  assert.ok(w.data.reviews[0].reply.startsWith('Hi Maya'), 'a posted reply, when asked for');
  const s = JSON.stringify(w.data);
  for (const bad of ['alice@example.com', uidOf('alice@example.com'), 'Reyes', 'Kowalski', 'Brett', '555-010-9999', 'alice@alpine.example', ids.happy, 'triage', 'favourite', 'repliedAt']) {
    assert.ok(!s.includes(bad), `the wall leaked ${bad}`);
  }
  await alice('POST', `/api/reviews/${ids.tom}/favourite`, { favourite: true });
  assert.strictEqual((await anon('GET', `/api/shared/${token}`)).data.reviews.length, 1, 'the copy is frozen');
  for (const m of ['POST', 'PUT', 'DELETE']) assert.strictEqual((await anon(m, `/api/shared/${token}`, {})).status, 404, `${m} is not a thing a wall does`);
  assert.strictEqual((await anon('GET', '/api/shared/AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
  assert.strictEqual((await anon('GET', '/api/shared/short')).status, 404);
  const up = await alice('POST', '/api/wall', {});
  assert.strictEqual(up.data.share.token, token, 'updating keeps the link');
  assert.strictEqual(up.data.title, 'Why people 3 Alpine', 'and the title');
  assert.strictEqual((await anon('GET', `/api/shared/${token}`)).data.reviews.length, 2);
  const page = await fetch(`${base}/s/${token}`);
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('<base href="../">'));
  assert.ok(!/(href|src)="\//.test(html), 'no absolute asset paths');
  assert.strictEqual(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.strictEqual((await alice('DELETE', '/api/wall')).status, 200);
  assert.strictEqual((await anon('GET', `/api/shared/${token}`)).status, 404, 'revoked');
  const fresh = await alice('POST', '/api/wall', {});
  assert.notStrictEqual(fresh.data.share.token, token, 'a revoked link never comes back');
  token = fresh.data.share.token;
});

test('the scoreboard over HTTP adds up', async () => {
  const sb = await alice('GET', '/api/scoreboard', undefined, { 'X-Local-Date': TODAY });
  assert.strictEqual(sb.status, 200);
  const list = (await alice('GET', '/api/reviews')).data;
  assert.strictEqual(sb.data.total, list.counts.all);
  assert.strictEqual(sb.data.replied, list.counts.replied);
  assert.strictEqual(sb.data.responseRate, Math.round(100 * list.counts.replied / list.counts.all));
  assert.ok(sb.data.medianReplyHours != null);
  assert.strictEqual(sb.data.badges.length, V.BADGES.length);
  assert.ok(sb.data.topics.length > 0);
  assert.strictEqual((await alice('GET', '/api/reviews?today=1999-01-01')).data.today, TODAY, 'an implausible local date is ignored');
});

test('another user gets 404 on everything of yours', async () => {
  const eve = client();
  await eve('POST', '/api/auth/register', { email: 'eve@example.com', password: 'eve has a password' });
  const id = ids.sick;
  const calls = await modelCalls();
  for (const [m, p, body] of [
    ['GET', `/api/reviews/${id}`], ['PUT', `/api/reviews/${id}`, { stars: 5 }], ['DELETE', `/api/reviews/${id}`],
    ['PUT', `/api/reviews/${id}/reply`, { text: 'mine now' }], ['POST', `/api/reviews/${id}/replied`, {}],
    ['POST', `/api/reviews/${id}/favourite`, {}], ['POST', `/api/reviews/${id}/template`, {}],
    ['POST', `/api/reviews/${id}/triage`, {}], ['POST', `/api/reviews/${id}/draft`, {}],
    ['POST', '/api/cooldown', { text: 'this is long enough to try', reviewId: id }],
  ]) {
    assert.strictEqual((await eve(m, p, body)).status, 404, `${m} ${p}`);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'a stranger\'s id never reaches a model');
  assert.strictEqual((await eve('GET', '/api/reviews')).data.reviews.length, 0);
  assert.strictEqual((await eve('GET', '/api/wall')).data.share, null);
  assert.strictEqual((await eve('GET', '/api/scoreboard')).data.total, 0);
  assert.strictEqual((await eve('DELETE', '/api/wall')).status, 200);
  assert.strictEqual((await client()('GET', `/api/shared/${token}`)).status, 200, 'and cannot revoke yours');
  assert.strictEqual((await alice('GET', `/api/reviews/${id}`)).data.stars, 2);
});

test('caps: 1000 reviews an inbox', async () => {
  const dave = client();
  await dave('POST', '/api/auth/register', { email: 'dave@example.com', password: 'dave long password' });
  const uid = uidOf('dave@example.com');
  for (let i = 0; i < V.LIMITS.reviews; i++) {
    await store.add(`reviews/${uid}/items`, { stars: 1 + (i % 5), reviewer: `R${i}`, text: 'ok', date: day(-(i % 300)), addedAt: `${day(-(i % 300))}T08:00:00Z`, addedDay: day(-(i % 300)), repliedAt: null, repliedDay: null });
  }
  const r = await dave('POST', '/api/reviews', { stars: 5, text: 'one more' });
  assert.strictEqual(r.status, 409);
  assert.ok(/1000/.test(r.data.error));
  const sb = await dave('GET', '/api/scoreboard');
  assert.strictEqual(sb.status, 200, 'a full inbox still scores');
  assert.strictEqual(sb.data.total, 1000);
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use('/rave', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/rave`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
