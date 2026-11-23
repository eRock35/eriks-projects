// End to end, against the memory store and the fake model:
//   POPQUIZ_MEMORY=1 POPQUIZ_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// Drives the real Express app over HTTP, mounted under /popquiz the way the
// lab mounts it, so the auth cookie, the budget gate, every membership and
// role check, and the quiz's own bookkeeping are exercised as deployed. The
// pure rules (validation, Leitner, the daily pick, streaks, XP, the
// leaderboard, blind spots, join codes) get fixed-date tests first.

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.POPQUIZ_MEMORY !== '1' || process.env.POPQUIZ_FAKE_AI !== '1') {
  console.error('run with POPQUIZ_MEMORY=1 POPQUIZ_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const Q = require('../public/quiz');
const T = require('../lib/teams');
const aiLib = require('../lib/ai');
const gemini = require('../lib/gemini');
const fakeai = require('../lib/fakeai');
const { demo, SAMPLE } = require('../lib/demo');

let base;
function client() {
  let cookie = '';
  return async function call(method, p, body, headers = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Local-Date': TODAY, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, headers: res.headers };
  };
}

const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15)); // the meter writes usage rows fire-and-forget
const TODAY = T.utcToday();
const TOMORROW = Q.addDays(TODAY, 1);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]).toString('base64');
const BLANK = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('BLANK page'), Buffer.alloc(500, 3)]).toString('base64');

const MATERIAL = [
  'OPENING CHECKLIST - Harbour Coffee',
  'Unlock the back door first and switch off the alarm within thirty seconds.',
  'Turn on the espresso machine and let it heat for twenty minutes before the first shot.',
  'Check the milk fridge thermometer reads below forty one degrees.',
  'Count the float in the till with a second person and sign the sheet.',
  'Put the sandwich board outside by seven o’clock sharp.',
  'Oat milk contains gluten unless the carton says certified gluten free.',
  'Almond croissants contain nuts and must be kept on the top shelf.',
].join('\n');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const mcq = (prompt, options, answer, extra = {}) => ({ type: 'mcq', prompt, options, answer, explanation: 'Because the handbook says so.', ...extra });

/* ---------------- pure rules ---------------- */

const D = '2026-09-24'; // a Thursday

test('validateQuestion: a good one of each type, cleaned', () => {
  const a = Q.validateQuestion(mcq('What temperature must the fridge be?', ['41°F', '45°F', '50°F', '38°F'], 0));
  assert.ok(a.q && a.q.answer === 0 && a.q.options.length === 4);
  const tf = Q.validateQuestion({ type: 'tf', prompt: 'Garlic knots are vegan.', options: [{ text: 'false', correct: true }, { text: 'TRUE', correct: false }] });
  assert.deepStrictEqual([tf.q.options, tf.q.answer], [['True', 'False'], 1], 'true/false is always True, False in that order');
  const w = Q.validateQuestion({ type: 'which', prompt: 'Which one has walnuts?', options: ['Pesto', 'Margherita'], answer: 0 });
  assert.ok(w.q);
  const dirty = Q.validateQuestion(mcq('<b>Which</b> <script>x</script>is right?', ['<i>A</i>', 'B', 'C', 'D<'], 0, { explanation: 'x <img src=x onerror=1> y', topic: '<u>Allergens</u>' }));
  assert.ok(!JSON.stringify(dirty.q).includes('<') && !JSON.stringify(dirty.q).includes('>'), JSON.stringify(dirty.q));
  assert.strictEqual(dirty.q.options[0], 'A');
  assert.strictEqual(dirty.q.topic, 'Allergens');
  const long = Q.validateQuestion(mcq('Why? '.repeat(100), ['a'.repeat(300), 'b', 'c', 'd'], 1));
  assert.strictEqual(long.q.prompt.length, Q.LIMITS.prompt);
  assert.strictEqual(long.q.options[0].length, Q.LIMITS.option);
});

test('validateQuestion: refuses zero or two right answers, duplicates and bad shapes', () => {
  const err = (raw, opts) => Q.validateQuestion(raw, opts).error;
  const opts4 = (flags) => ['One', 'Two', 'Three', 'Four'].map((text, i) => ({ text, correct: flags[i] }));
  assert.match(err({ type: 'mcq', prompt: 'Which one is right?', options: opts4([false, false, false, false]) }), /Mark the right answer/);
  assert.match(err({ type: 'mcq', prompt: 'Which one is right?', options: opts4([true, true, false, false]) }), /Only one answer/);
  assert.match(err({ type: 'tf', prompt: 'The oven stays on.', options: [{ text: 'True', correct: true }, { text: 'False', correct: true }] }), /Only one answer/);
  assert.match(err(mcq('Which one is right?', ['Same', ' same.', 'Other', 'Else'], 0)), /same thing/);
  assert.match(err(mcq('Which one is right?', ['A', 'B', 'C'], 0)), /exactly 4/);
  assert.match(err({ type: 'which', prompt: 'Which one is it?', options: ['A'], answer: 0 }), /2 to 4/);
  assert.match(err(mcq('Which one is right?', ['A', 'B', 'C', 'D'], 7)), /Mark the right answer/);
  assert.match(err(mcq('Which one is right?', ['A', '', 'C', 'D'], 0)), /every option/);
  assert.match(err(mcq('Short', ['A', 'B', 'C', 'D'], 0)), /Write the question/);
  assert.match(err({ type: 'essay', prompt: 'Write an essay', options: ['A', 'B'], answer: 0 }), /type/);
  assert.match(err({ type: 'tf', prompt: 'The oven stays on overnight.', options: ['Yes please', 'No'], answer: 0 }), /True and False/);
  assert.match(err({ ...mcq('Which one is right?', ['A', 'B', 'C', 'D'], 0), explanation: '' }, { strict: true }), /Explain/);
  assert.ok(Q.validateQuestion({ ...mcq('Which one is right?', ['A', 'B', 'C', 'D'], 0), explanation: '' }).q, 'hand-written may skip the explanation');
});

test('Leitner: right moves up a box and further away; wrong goes back to box 1, tomorrow', () => {
  let r = Q.review(null, true, D);
  assert.deepStrictEqual([r.card.box, r.card.due, r.card.right], [2, Q.addDays(D, 2), 1], 'a new card known already jumps to box 2');
  r = Q.review(r.card, true, Q.addDays(D, 2));
  assert.deepStrictEqual([r.card.box, r.card.due], [3, Q.addDays(D, 6)]);
  r = Q.review(r.card, true, Q.addDays(D, 6)); assert.strictEqual(r.card.box, 4);
  r = Q.review(r.card, true, D); assert.strictEqual(r.card.box, 5);
  r = Q.review(r.card, true, D); assert.deepStrictEqual([r.card.box, r.card.due], [5, Q.addDays(D, 14)], 'the top box holds');
  r = Q.review(r.card, false, D, 2);
  assert.deepStrictEqual([r.card.box, r.card.due, r.card.wrong, r.card.picks], [1, Q.addDays(D, 1), 1, { 2: 1 }], 'a miss comes back tomorrow, and what they picked is counted');
  assert.strictEqual(r.comeback, false);
  r = Q.review(r.card, true, Q.addDays(D, 1));
  assert.strictEqual(r.comeback, true, 'right after a miss is a comeback');
  assert.strictEqual(r.card.box, 2);
  const miss = Q.review(null, false, D, 1);
  assert.deepStrictEqual([miss.card.box, miss.card.due], [1, Q.addDays(D, 1)]);
});

test('pickDaily: missed ones first, new ones in order, one slot kept for something new, stable per day', () => {
  const qs = Array.from({ length: 12 }, (_, i) => ({ id: `q${String(i).padStart(2, '0')}` }));
  const cards = {
    q00: { box: 1, due: D }, q01: { box: 3, due: Q.addDays(D, -2) }, q02: { box: 2, due: D },
    q03: { box: 1, due: Q.addDays(D, -1) }, q04: { box: 4, due: Q.addDays(D, 5) }, q05: { box: 5, due: Q.addDays(D, 9) },
  };
  const ids = Q.pickDaily(qs, cards, D, 'alice' + D);
  assert.strictEqual(ids.length, 5);
  assert.deepStrictEqual([...ids].sort(), ['q00', 'q01', 'q02', 'q03', 'q06'], 'four due reviews plus the first new question');
  assert.deepStrictEqual(Q.pickDaily(qs, cards, D, 'alice' + D), ids, 'the same five on every reload');
  // Five due and nothing new: all five are reviews, lowest box first.
  const lots = Object.fromEntries(qs.map((q, i) => [q.id, { box: 1 + (i % 5), due: D }]));
  const r = Q.pickDaily(qs, lots, D, 's');
  assert.ok(r.every((id) => lots[id].box <= 2), JSON.stringify(r));
  // Nothing due, nothing new: the soonest due fill the day.
  const later = Object.fromEntries(qs.map((q, i) => [q.id, { box: 3, due: Q.addDays(D, 1 + i) }]));
  assert.deepStrictEqual([...Q.pickDaily(qs, later, D, 's')].sort(), ['q00', 'q01', 'q02', 'q03', 'q04']);
  assert.strictEqual(Q.pickDaily(qs.slice(0, 3), {}, D, 's').length, 3, 'a small team plays what it has');
  assert.deepStrictEqual(Q.pickDaily([], {}, D, 's'), []);
});

test('streaks and XP', () => {
  assert.strictEqual(Q.nextStreak(4, Q.addDays(D, -1), D), 5);
  assert.strictEqual(Q.nextStreak(4, Q.addDays(D, -2), D), 1, 'a missed day starts again');
  assert.strictEqual(Q.nextStreak(4, D, D), 4, 'twice in a day counts once');
  assert.strictEqual(Q.nextStreak(0, null, D), 1);
  assert.strictEqual(Q.streakNow({ streak: 6, lastDoneDay: D }, D), 6);
  assert.strictEqual(Q.streakNow({ streak: 6, lastDoneDay: Q.addDays(D, -1) }, D), 6, 'alive until today ends');
  assert.strictEqual(Q.streakAtRisk({ streak: 6, lastDoneDay: Q.addDays(D, -1) }, D), true);
  assert.strictEqual(Q.streakNow({ streak: 6, lastDoneDay: Q.addDays(D, -2) }, D), 0);
  assert.deepStrictEqual([Q.xpForAnswer(true), Q.xpForAnswer(false)], [10, 2]);
  assert.strictEqual(Q.xpForFinish(5, 5), 30);
  assert.strictEqual(Q.xpForFinish(4, 5), 10);
  assert.strictEqual(Q.weekStart(D), '2026-09-21', 'weeks start on Monday');
  assert.strictEqual(Q.weekStart('2026-09-27'), '2026-09-21', 'Sunday belongs to the week before');
  assert.strictEqual(Q.weekXp({ '2026-09-20': 99, '2026-09-21': 10, '2026-09-24': 30, '2026-09-25': 50 }, D), 40);
  assert.strictEqual(Q.doneToday({ today: { day: D, ids: ['a', 'b'], answers: { a: {}, b: {} } } }, D), true);
  assert.strictEqual(Q.doneToday({ today: { day: D, ids: ['a', 'b'], answers: { a: {} } } }, D), false);
  assert.strictEqual(Q.doneToday({ today: { day: Q.addDays(D, -1), ids: ['a'], answers: { a: {} } } }, D), false);
});

test('leaderboard: this week’s XP, streak breaks ties, equal XP shares a rank', () => {
  const p = (xp, streak) => ({ xpByDay: { [D]: xp, '2026-09-14': 500 }, streak, lastDoneDay: D });
  const rows = Q.leaderboard([
    { uid: 'a', name: 'Ann', progress: p(50, 1) },
    { uid: 'b', name: 'Ben', progress: p(80, 2) },
    { uid: 'c', name: 'Cat', progress: p(50, 9) },
    { uid: 'd', name: 'Dev', progress: null },
  ], D);
  assert.deepStrictEqual(rows.map((r) => [r.name, r.weekXp, r.rank]), [['Ben', 80, 1], ['Cat', 50, 2], ['Ann', 50, 2], ['Dev', 0, 4]]);
});

test('blind spots: miss rate, a floor on answers, and the wrong answer people pick', () => {
  const qs = [
    { id: 'q1', prompt: 'Fridge temp?', options: ['41', '45', '50', '60'], answer: 0, topic: 'Safety' },
    { id: 'q2', prompt: 'Oven overnight?', options: ['True', 'False'], answer: 1, topic: 'Safety' },
    { id: 'q3', prompt: 'Rare one?', options: ['a', 'b', 'c', 'd'], answer: 2, topic: 'Menu' },
    { id: 'q4', prompt: 'Easy one?', options: ['a', 'b', 'c', 'd'], answer: 0, topic: 'Menu' },
  ];
  const people = [
    { q1: { right: 1, wrong: 2, picks: { 1: 2 }, lastRight: false }, q2: { right: 2, wrong: 1, picks: { 0: 1 } }, q3: { right: 0, wrong: 1, picks: { 0: 1 } }, q4: { right: 3, wrong: 0 } },
    { q1: { right: 0, wrong: 2, picks: { 1: 1, 3: 1 }, lastRight: false }, q2: { right: 3, wrong: 0 }, q4: { right: 2, wrong: 0 } },
    { q1: { right: 1, wrong: 0, picks: { 0: 5 } } },
  ];
  const b = Q.blindSpots(qs, people);
  assert.deepStrictEqual(b.map((x) => [x.id, x.missRate, x.attempts, x.people, x.stuck]), [['q1', 67, 6, 3, 2], ['q2', 17, 6, 2, 0]], 'q3 has too few answers, q4 is never missed');
  assert.strictEqual(b[0].commonWrong, '45', 'the most-picked wrong option - never the right one, even if it was counted');
  assert.strictEqual(b[0].commonWrongCount, 3);
  const topics = Q.topicSpots(qs, people);
  assert.deepStrictEqual(topics.map((t) => [t.topic, t.missRate]), [['Safety', 42], ['Menu', 17]]);
  assert.strictEqual(Q.mastery(qs, { q1: { box: 3 }, q2: { box: 2 }, q3: { box: 5 } }), 50);
  assert.strictEqual(Q.mastery([], {}), 0);
});

test('badges come from the numbers', () => {
  assert.deepStrictEqual(Q.badgesFor({}), []);
  assert.deepStrictEqual(Q.badgesFor({ daysDone: 1, perfectDays: 5, best: 7, comebacks: 1, xp: 600 }, { questions: 12, mastery: 85 }),
    ['first', 'perfect', 'streak3', 'streak7', 'comeback', 'sharp', 'xp500', 'master']);
  assert.ok(!Q.badgesFor({}, { questions: 5, mastery: 100 }).includes('master'), 'mastering five questions is not a know-it-all');
});

test('join codes: 8 unambiguous characters, random, forgiving to type', () => {
  const codes = new Set();
  const chars = new Set();
  for (let i = 0; i < 400; i++) { const c = T.newCode(); assert.ok(Q.isCode(c), c); codes.add(c); for (const ch of c) chars.add(ch); }
  assert.strictEqual(codes.size, 400, 'no repeats');
  assert.strictEqual(chars.size, 32, 'every character of the alphabet turns up');
  for (const bad of ['O', '0', 'I', '1']) assert.ok(!Q.isCode(`ABCDEFG${bad}`), bad);
  assert.strictEqual(Q.normalizeCode(' abcd-efgh '), 'ABCDEFGH');
  assert.strictEqual(Q.formatCode('abcdefgh'), 'ABCD-EFGH');
  assert.ok(!Q.isCode('ABCDEFG') && !Q.isCode('ABCDEFGHJ'));
});

test('the model’s proposal: invalid questions dropped and counted, markup gone, answers still right after the shuffle', () => {
  const opt = (texts, right) => texts.map((text, i) => ({ text, correct: i === right }));
  const raw = {
    readable: true,
    title: '<b>Closing</b>',
    questions: [
      { type: 'mcq', prompt: 'What must the cooler read?', options: opt(['41°F', '45°F', '50°F', '60°F'], 0), explanation: 'The checklist says 41°F.', source: '41°F or below', topic: 'Safety' },
      { type: 'mcq', prompt: 'Two right answers here?', options: opt(['a', 'b', 'c', 'd'], -1).map((o, i) => ({ ...o, correct: i < 2 })), explanation: 'Nope, not allowed.', source: '', topic: '' },
      { type: 'tf', prompt: 'The oven stays on overnight.', options: opt(['True', 'False'], 1), explanation: 'It is switched fully off.', source: '', topic: '' },
      { type: 'tf', prompt: 'The oven stays on overnight.', options: opt(['True', 'False'], 1), explanation: 'A duplicate prompt.', source: '', topic: '' },
      { type: 'mcq', prompt: 'No explanation given?', options: opt(['a', 'b', 'c', 'd'], 1), explanation: '', source: '', topic: '' },
    ],
  };
  for (let i = 0; i < 20; i++) {
    const out = aiLib.validateGenerated(JSON.parse(JSON.stringify(raw)), {});
    assert.strictEqual(out.questions.length, 2);
    assert.strictEqual(out.dropped, 3);
    assert.strictEqual(out.title, 'Closing');
    assert.strictEqual(out.questions[0].options[out.questions[0].answer], '41°F', 'the shuffle carries the answer with it');
    assert.deepStrictEqual(out.questions[1].options, ['True', 'False'], 'true/false is never shuffled');
  }
  assert.strictEqual(aiLib.validateGenerated({ ...raw, readable: false }), null);
  assert.strictEqual(aiLib.validateGenerated({ readable: true, questions: [raw.questions[1]] }), null, 'nothing valid is nothing');
  assert.strictEqual(aiLib.validateGenerated(raw, { title: 'Mine' }).title, 'Mine', 'the manager’s own title wins');
});

test('editing a deck: an unchanged fact keeps its id (and history); a changed answer is a new question', () => {
  const first = T.cleanQuestions([mcq('What must the cooler read?', ['41', '45', '50', '60'], 0), mcq('How many people close?', ['One', 'Two', 'Three', 'Four'], 1)]);
  assert.ok(first.every((q) => /^[A-Za-z0-9_-]{12}$/.test(q.id)));
  const edited = T.cleanQuestions([
    { ...first[0], prompt: 'What must the walk-in cooler read?' },
    { ...first[1], answer: 2 },
  ], first);
  assert.strictEqual(edited[0].id, first[0].id, 'rewording keeps the history');
  assert.notStrictEqual(edited[1].id, first[1].id, 'a new right answer is a new question');
  assert.throws(() => T.cleanQuestions([mcq('Same question twice?', ['a', 'b', 'c', 'd'], 0), mcq('Same question twice?', ['a', 'b', 'c', 'd'], 1)]), /same as an earlier/);
  assert.throws(() => T.cleanQuestions([]), /at least one/);
});

test('the demo runs through the real arithmetic', () => {
  const d = demo(D);
  assert.strictEqual(d.demo, true);
  assert.strictEqual(d.team.name, 'Slice Society');
  assert.strictEqual(d.decks.length, 2);
  for (const deck of d.decks) for (const q of deck.questions) assert.ok(!Q.validateQuestion(q).error, q.prompt);
  assert.ok(d.dashboard.blindSpots.length >= 3 && d.dashboard.blindSpots.every((b) => b.commonWrong && b.missRate > 0));
  assert.ok(d.dashboard.done > 0 && d.dashboard.done < d.dashboard.total, 'some done today, some not');
  assert.strictEqual(d.leaderboard.rows[0].rank, 1);
  assert.ok(d.leaderboard.rows.every((r, i, a) => !i || a[i - 1].weekXp >= r.weekXp));
  assert.deepStrictEqual(d.sample.map((q) => q.id), SAMPLE);
  assert.deepStrictEqual([...new Set(d.sample.map((q) => q.type))].sort(), ['mcq', 'tf', 'which']);
  assert.ok(d.sample.every((q) => Number.isInteger(q.answer) && q.explanation));
  assert.deepStrictEqual(demo(D).dashboard, d.dashboard, 'the same every time');
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { POPQUIZ_MEMORY: '1' }], ['./lib/fakeai', { POPQUIZ_FAKE_AI: '1' }], ['./server', { POPQUIZ_FAKE_AI: '1', POPQUIZ_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, POPQUIZ_MEMORY: '', POPQUIZ_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

/* ---------------- over HTTP ---------------- */

test('signed out: health, meta, the demo and quiz.js work with zero model calls; nothing else does', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = await anon('GET', '/api/meta');
  assert.strictEqual(meta.data.types.length, 3);
  const d = await anon('GET', '/api/demo');
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.data.demo, true);
  assert.ok(d.data.dashboard.blindSpots.length && d.data.sample.length === 5 && d.data.leaderboard.rows.length);
  const js = await fetch(`${base}/quiz.js`);
  assert.strictEqual(js.status, 200);
  assert.ok((await js.text()).includes('PopQuiz'), 'the page runs the same rules the server does');
  const page = await fetch(`${base}/`);
  assert.ok((await page.text()).includes('src="app.js"'), 'relative asset links');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['POST', '/api/teams'], ['POST', '/api/join'], ['GET', '/api/teams/abcdef'], ['GET', '/api/teams/abcdef/quiz'], ['POST', '/api/teams/abcdef/quiz/answer'],
    ['GET', '/api/teams/abcdef/leaderboard'], ['GET', '/api/teams/abcdef/dashboard'], ['POST', '/api/teams/abcdef/decks'], ['POST', '/api/teams/abcdef/generate'],
    ['POST', '/api/teams/abcdef/generate/photo'], ['POST', '/api/teams/abcdef/code'], ['DELETE', '/api/teams/abcdef']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  // A stranger's 5 MB photo is turned away at the door, unread.
  const big = await anon('POST', '/api/teams/abcdef/generate/photo', { image: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } });
  assert.strictEqual(big.status, 401);
  // ...and every other route keeps the small limit.
  const fat = await anon('POST', '/api/teams', { name: 'x'.repeat(200 * 1024) });
  assert.strictEqual(fat.status, 413);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

let gio, priya, marcus, jess, stranger;
const team = {};
const answers = {}; // qid -> right answer, from the manager's own decks

async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}

test('a manager signs up and makes a team; the code is theirs to share', async () => {
  gio = await register('gio@example.com');
  let me = await gio('GET', '/api/me');
  assert.deepStrictEqual([me.data.signedIn, me.data.teams, me.data.name], [true, [], 'Gio']);
  assert.strictEqual((await gio('POST', '/api/teams', { name: ' ' })).status, 400);
  const t = await gio('POST', '/api/teams', { name: 'Harbour <b>Coffee</b>', emoji: '☕', yourName: 'Gio M.' });
  assert.strictEqual(t.status, 200, JSON.stringify(t.data));
  assert.deepStrictEqual([t.data.name, t.data.emoji, t.data.role, t.data.owner, t.data.you], ['Harbour Coffee', '☕', 'manager', true, 'Gio M.']);
  assert.match(t.data.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  team.id = t.data.id;
  team.code = t.data.code;
  me = await gio('GET', '/api/me');
  assert.deepStrictEqual(me.data.teams.map((x) => [x.name, x.role]), [['Harbour Coffee', 'manager']]);
  const view = await gio('GET', `/api/teams/${team.id}`);
  assert.strictEqual(view.data.people.length, 1);
  assert.strictEqual(view.data.questions, 0);
  const quiz = await gio('GET', `/api/teams/${team.id}/quiz`);
  assert.strictEqual(quiz.data.empty, true, 'no decks yet, nothing to play');
});

test('a provider failure is a plain sentence: 502, or 503 when it is overloaded - never the provider’s words (2026-09-27)', async () => {
  const quiet = console.error; console.error = () => {};
  let a, b;
  try {
    a = await gio('POST', `/api/teams/${team.id}/generate`, { text: `${MATERIAL} UPSTREAM401` });
    b = await gio('POST', `/api/teams/${team.id}/generate`, { text: `${MATERIAL} UPSTREAM529` });
  } finally { console.error = quiet; }
  assert.deepStrictEqual([a.status, b.status], [502, 503], 'an upstream 401 is not "sign in"');
  assert.strictEqual(a.data.error, 'Could not write questions from that. Try again, or write them by hand.');
  assert.ok(!JSON.stringify([a.data, b.data]).includes('fake_upstream_error'), 'no provider body reaches the page');
});

test('generate a deck: a proposal comes back and NOTHING is stored until the manager publishes', async () => {
  const calls = await modelCalls();
  assert.strictEqual((await gio('POST', `/api/teams/${team.id}/generate`, { text: 'too short' })).status, 400);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'refused before anything was spent');
  const dump = store._dump();
  const r = await gio('POST', `/api/teams/${team.id}/generate`, { text: MATERIAL, title: 'Opening', count: 6 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1);
  assert.strictEqual(r.data.title, 'Opening');
  assert.strictEqual(r.data.source, 'text');
  assert.ok(r.data.questions.length >= 5, JSON.stringify(r.data));
  for (const q of r.data.questions) assert.ok(!Q.validateQuestion(q, { strict: true }).error, q.prompt);
  assert.strictEqual(store._dump(), dump, 'a proposal saves nothing');
  assert.strictEqual((await gio('GET', `/api/teams/${team.id}`)).data.questions, 0);
  team.proposal = r.data;

  const inj = await gio('POST', `/api/teams/${team.id}/generate`, { text: `${MATERIAL}\nINJECT` });
  assert.strictEqual(inj.status, 200);
  assert.ok(inj.data.dropped >= 4, `two right, none right, duplicate options and a junk type are all dropped (${inj.data.dropped})`);
  assert.ok(!JSON.stringify(inj.data).includes('<'), 'no markup survives');
  assert.ok(inj.data.questions.some((q) => /wash hands/.test(q.prompt)), 'a valid question with markup is cleaned, not lost');
  assert.strictEqual(inj.data.title, 'Suggested title', 'the model’s title, cleaned, when the manager gave none');
  const junk = await gio('POST', `/api/teams/${team.id}/generate`, { text: 'NOT TRAINING. '.repeat(20) });
  assert.strictEqual(junk.status, 422);
  assert.strictEqual(store._dump(), dump, 'still nothing stored');
});

test('review, edit and publish: every question validated again, all or nothing', async () => {
  const qs = team.proposal.questions.map((q) => ({ ...q }));
  const bad = qs.map((q, i) => (i === 2 ? { ...q, options: q.options.map((o) => ({ text: o, correct: true })) } : q));
  const refused = await gio('POST', `/api/teams/${team.id}/decks`, { title: 'Opening', source: 'text', questions: bad });
  assert.strictEqual(refused.status, 400);
  assert.strictEqual(refused.data.index, 2, 'the editor is told which question');
  assert.strictEqual((await gio('GET', `/api/teams/${team.id}`)).data.questions, 0, 'nothing half-saved');
  qs[0].prompt = 'Edited by Gio: ' + qs[0].prompt;
  qs.pop();
  const pub = await gio('POST', `/api/teams/${team.id}/decks`, { title: 'Opening', emoji: '☕', source: 'text', questions: qs });
  assert.strictEqual(pub.status, 200, JSON.stringify(pub.data));
  assert.strictEqual(pub.data.questions.length, team.proposal.questions.length - 1);
  assert.ok(pub.data.questions[0].prompt.startsWith('Edited by Gio'));
  team.deckA = pub.data.id;
  // A second deck, written by hand - free, no model.
  const calls = await modelCalls();
  const hand = await gio('POST', `/api/teams/${team.id}/decks`, {
    title: 'Allergens',
    source: 'hand',
    questions: [
      mcq('Which pastry contains nuts?', ['Almond croissant', 'Plain croissant', 'Pain au chocolat', 'Cinnamon bun'], 0),
      { type: 'tf', prompt: 'Oat milk is always gluten free.', options: ['True', 'False'], answer: 1, explanation: 'Only when the carton says certified.' },
      { type: 'which', prompt: 'Which one goes on the top shelf?', options: ['Almond croissants', 'Muffins', 'Scones'], answer: 0 },
    ],
  });
  assert.strictEqual(hand.status, 200, JSON.stringify(hand.data));
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'writing by hand is free');
  team.deckB = hand.data.id;
  for (const id of [team.deckA, team.deckB]) {
    const d = await gio('GET', `/api/teams/${team.id}/decks/${id}`);
    for (const q of d.data.questions) answers[q.id] = q.answer;
  }
  assert.strictEqual(Object.keys(answers).length, pub.data.questions.length + 3);
  const view = await gio('GET', `/api/teams/${team.id}`);
  assert.deepStrictEqual(view.data.decks.map((d) => d.title), ['Opening', 'Allergens']);
});

test('staff join by code - typed any old way - and nothing else about the team leaks', async () => {
  priya = await register('priya@example.com');
  marcus = await register('marcus@example.com');
  jess = await register('jess@example.com');
  const messy = ` ${team.code.toLowerCase().replace('-', ' ')} `;
  const j = await priya('POST', '/api/join', { code: messy, name: 'Priya' });
  assert.strictEqual(j.status, 200, JSON.stringify(j.data));
  assert.deepStrictEqual([j.data.id, j.data.name, j.data.already], [team.id, 'Harbour Coffee', false]);
  assert.strictEqual((await priya('POST', '/api/join', { code: team.code })).data.already, true, 'joining twice is harmless');
  assert.strictEqual((await marcus('POST', '/api/join', { code: team.code, name: 'Marcus' })).status, 200);
  assert.strictEqual((await jess('POST', '/api/join', { code: team.code })).status, 200);
  const me = await priya('GET', '/api/me');
  assert.deepStrictEqual(me.data.teams.map((t) => [t.id, t.role]), [[team.id, 'staff']]);
  const view = await priya('GET', `/api/teams/${team.id}`);
  assert.strictEqual(view.data.role, 'staff');
  assert.strictEqual(view.data.code, undefined, 'staff do not see the code');
  assert.strictEqual(view.data.people, undefined, 'or the member list');
  assert.strictEqual(view.data.members, 4);
  assert.strictEqual((await jess('GET', `/api/teams/${team.id}`)).data.you, 'Jess', 'a name from the email when none is given');
});

test('a wrong code says nothing, and guessing is capped', async () => {
  stranger = await register('eve@example.com');
  const wrong = await stranger('POST', '/api/join', { code: 'ABCD-EFGH' });
  assert.strictEqual(wrong.status, 404);
  assert.ok(!/Harbour/.test(JSON.stringify(wrong.data)));
  const malformed = await stranger('POST', '/api/join', { code: 'hello' });
  assert.deepStrictEqual([malformed.status, malformed.data.error], [404, wrong.data.error], 'a malformed code gets the very same answer');
  for (let i = 0; i < T.LIMITS.joinTries - 2; i++) assert.strictEqual((await stranger('POST', '/api/join', { code: T.newCode() })).status, 404);
  const blocked = await stranger('POST', '/api/join', { code: T.newCode() });
  assert.strictEqual(blocked.status, 429);
  const real = await stranger('POST', '/api/join', { code: team.code });
  assert.strictEqual(real.status, 429, 'once blocked, even the right code is refused - no oracle');
  assert.ok(!(await gio('GET', `/api/teams/${team.id}`)).data.people.some((p) => p.name === 'Eve'));
});

test('a stranger gets 404 on every team route, and never reaches a model', async () => {
  const calls = await modelCalls();
  const id = team.id;
  for (const [m, p, body] of [
    ['GET', `/api/teams/${id}`], ['PUT', `/api/teams/${id}`, { name: 'Mine now' }], ['DELETE', `/api/teams/${id}`],
    ['GET', `/api/teams/${id}/quiz`], ['POST', `/api/teams/${id}/quiz/answer`, { qid: 'x', choice: 0 }],
    ['GET', `/api/teams/${id}/leaderboard`], ['GET', `/api/teams/${id}/dashboard`],
    ['GET', `/api/teams/${id}/decks/${team.deckA}`], ['POST', `/api/teams/${id}/decks`, { title: 'x', questions: [] }],
    ['PUT', `/api/teams/${id}/decks/${team.deckA}`, {}], ['DELETE', `/api/teams/${id}/decks/${team.deckA}`],
    ['POST', `/api/teams/${id}/generate`, { text: MATERIAL }], ['POST', `/api/teams/${id}/generate/photo`, { image: { type: 'image/jpeg', data: JPEG } }],
    ['POST', `/api/teams/${id}/code`], ['DELETE', `/api/teams/${id}/members/me`], ['PUT', `/api/teams/${id}/me`, { name: 'x' }],
    ['GET', '/api/teams/nope-nope'], ['GET', '/api/teams/..%2F..%2Fx/quiz'],
  ]) {
    assert.strictEqual((await stranger(m, p, body)).status, 404, `${m} ${p}`);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'a stranger’s request never reaches a model');
  assert.strictEqual((await gio('GET', `/api/teams/${id}`)).data.name, 'Harbour Coffee');
});

test('staff cannot edit decks, see answers, the dashboard or the code (403); and never spend on generation', async () => {
  const calls = await modelCalls();
  const id = team.id;
  for (const [m, p, body] of [
    ['PUT', `/api/teams/${id}`, { name: 'Mine now' }], ['GET', `/api/teams/${id}/decks/${team.deckA}`],
    ['POST', `/api/teams/${id}/decks`, { title: 'Sneaky', questions: [mcq('Which is right?', ['a', 'b', 'c', 'd'], 0)] }],
    ['PUT', `/api/teams/${id}/decks/${team.deckA}`, { title: 'Hacked' }], ['DELETE', `/api/teams/${id}/decks/${team.deckA}`],
    ['GET', `/api/teams/${id}/dashboard`], ['POST', `/api/teams/${id}/code`],
    ['POST', `/api/teams/${id}/generate`, { text: MATERIAL }], ['POST', `/api/teams/${id}/generate/photo`, { image: { type: 'image/jpeg', data: JPEG } }],
    ['DELETE', `/api/teams/${id}/members/${uidOf('marcus@example.com')}`], ['DELETE', `/api/teams/${id}`],
  ]) {
    assert.strictEqual((await priya(m, p, body)).status, 403, `${m} ${p}`);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  assert.strictEqual((await gio('GET', `/api/teams/${id}`)).data.decks.length, 2, 'nothing changed');
});

test('the daily quiz: five questions without answers, checked on the server, remembered on reload', async () => {
  const q = await priya('GET', `/api/teams/${team.id}/quiz`);
  assert.strictEqual(q.status, 200, JSON.stringify(q.data));
  assert.strictEqual(q.data.questions.length, 5);
  assert.ok(q.data.questions.every((x) => x.answer === undefined && x.explanation === undefined), 'the page never has the answer before answering');
  assert.deepStrictEqual(q.data.answers, {});
  assert.strictEqual(q.data.done, false);
  const again = await priya('GET', `/api/teams/${team.id}/quiz`);
  assert.deepStrictEqual(again.data.questions.map((x) => x.id), q.data.questions.map((x) => x.id), 'the same five on reload');
  team.priyaIds = q.data.questions.map((x) => x.id);
  const calls = await modelCalls();
  const [first, second] = team.priyaIds;
  const right = await priya('POST', `/api/teams/${team.id}/quiz/answer`, { qid: first, choice: answers[first] });
  assert.deepStrictEqual([right.data.correct, right.data.answer, right.data.xpGained, right.data.done], [true, answers[first], 10, false]);
  assert.ok('explanation' in right.data && 'source' in right.data);
  assert.strictEqual(right.data.nextIn, 2, 'known already: back in two days');
  const wrongChoice = (answers[second] + 1) % 2;
  const wrong = await priya('POST', `/api/teams/${team.id}/quiz/answer`, { qid: second, choice: wrongChoice });
  assert.deepStrictEqual([wrong.data.correct, wrong.data.answer, wrong.data.xpGained, wrong.data.nextIn], [false, answers[second], 2, 1]);
  const twice = await priya('POST', `/api/teams/${team.id}/quiz/answer`, { qid: first, choice: answers[first] });
  assert.deepStrictEqual([twice.data.repeat, twice.data.xpGained], [true, 0], 'answering twice scores once');
  assert.strictEqual((await priya('POST', `/api/teams/${team.id}/quiz/answer`, { qid: team.priyaIds[2], choice: 9 })).status, 400);
  assert.strictEqual((await priya('POST', `/api/teams/${team.id}/quiz/answer`, { qid: 'not-today', choice: 0 })).status, 404);
  const reload = await priya('GET', `/api/teams/${team.id}/quiz`);
  assert.deepStrictEqual(Object.keys(reload.data.answers).sort(), [first, second].sort(), 'progress persists');
  assert.strictEqual(reload.data.answers[second].correct, false);
  let last;
  for (const id of team.priyaIds.slice(2)) last = await priya('POST', `/api/teams/${team.id}/quiz/answer`, { qid: id, choice: answers[id] });
  assert.strictEqual(last.data.done, true);
  assert.deepStrictEqual([last.data.summary.score, last.data.summary.total, last.data.summary.perfect, last.data.summary.streak], [4, 5, false, 1]);
  assert.strictEqual(last.data.summary.xpToday, 4 * 10 + 2 + 10);
  assert.ok(last.data.newBadges.some((b) => b.key === 'first'));
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'taking a quiz never calls a model');
  const done = await priya('GET', `/api/teams/${team.id}/quiz`);
  assert.deepStrictEqual([done.data.done, done.data.score, done.data.stats.streak, done.data.stats.xp], [true, 4, 1, 52]);
});

test('two staff answering at the same moment: both answers stick', async () => {
  const [a, b] = await Promise.all([marcus('GET', `/api/teams/${team.id}/quiz`), jess('GET', `/api/teams/${team.id}/quiz`)]);
  team.marcusIds = a.data.questions.map((x) => x.id);
  team.jessIds = b.data.questions.map((x) => x.id);
  // The blind spot: the one Priya missed, and these two miss it as well.
  team.spot = team.priyaIds[1];
  assert.ok(team.marcusIds.includes(team.spot) && team.jessIds.includes(team.spot), 'a question all three were asked');
  for (let i = 0; i < 5; i++) {
    const pick = (ids) => {
      const id = ids[i];
      const choice = id === team.spot ? (answers[id] + 1) % 2 : answers[id];
      return { qid: id, choice };
    };
    const [x, y] = await Promise.all([
      marcus('POST', `/api/teams/${team.id}/quiz/answer`, pick(team.marcusIds)),
      jess('POST', `/api/teams/${team.id}/quiz/answer`, pick(team.jessIds)),
    ]);
    assert.strictEqual(x.status, 200, JSON.stringify(x.data));
    assert.strictEqual(y.status, 200, JSON.stringify(y.data));
  }
  const pm = await store.get(`teams/${team.id}/progress`, uidOf('marcus@example.com'));
  const pj = await store.get(`teams/${team.id}/progress`, uidOf('jess@example.com'));
  assert.strictEqual(Object.keys(pm.today.answers).length, 5);
  assert.strictEqual(Object.keys(pj.today.answers).length, 5);
  assert.strictEqual(pm.cards[team.spot].wrong, 1);
  assert.strictEqual(pj.cards[team.spot].wrong, 1);
  // One person racing themselves: the second tap waits, then scores nothing.
  const [r1, r2] = await Promise.all([
    marcus('POST', `/api/teams/${team.id}/quiz/answer`, { qid: team.marcusIds[0], choice: 0 }),
    marcus('POST', `/api/teams/${team.id}/quiz/answer`, { qid: team.marcusIds[0], choice: 0 }),
  ]);
  assert.ok(r1.data.repeat && r2.data.repeat);
  assert.strictEqual((await store.get(`teams/${team.id}/progress`, uidOf('marcus@example.com'))).xp, pm.xp);
});

test('leaderboard for everyone: name, XP this week and streak - nothing else', async () => {
  const lb = await jess('GET', `/api/teams/${team.id}/leaderboard`);
  assert.strictEqual(lb.status, 200);
  assert.strictEqual(lb.data.rows.length, 4);
  assert.strictEqual(lb.data.week, Q.weekStart(TODAY));
  for (const r of lb.data.rows) assert.deepStrictEqual(Object.keys(r).sort(), ['name', 'rank', 'streak', 'weekXp', 'you']);
  assert.strictEqual(lb.data.rows.filter((r) => r.you).length, 1);
  assert.strictEqual(lb.data.rows.find((r) => r.name === 'Gio M.').weekXp, 0);
  assert.ok(lb.data.rows[0].weekXp >= lb.data.rows[1].weekXp);
});

test('the manager’s dashboard: who is done, mastery, and the blind spot everyone missed', async () => {
  const d = await gio('GET', `/api/teams/${team.id}/dashboard`);
  assert.strictEqual(d.status, 200, JSON.stringify(d.data));
  assert.deepStrictEqual([d.data.done, d.data.total], [3, 4]);
  assert.strictEqual(d.data.people.find((p) => p.name === 'Gio M.').doneToday, false);
  assert.ok(d.data.people.every((p) => typeof p.mastery === 'number'));
  const spot = d.data.blindSpots[0];
  assert.strictEqual(spot.id, team.spot, 'the question all three missed tops the list');
  assert.deepStrictEqual([spot.missRate, spot.misses, spot.people], [100, 3, 3]);
  assert.ok(spot.commonWrong, 'with what they picked instead');
  assert.strictEqual(d.data.decks.length, 2);
});

test('a manager is never sent a teammate’s uid or email - an opaque per-team id instead (2026-09-27)', async () => {
  const bodies = [];
  for (const p of [`/api/teams/${team.id}`, `/api/teams/${team.id}/dashboard`, `/api/teams/${team.id}/leaderboard`]) {
    const r = await gio('GET', p);
    assert.strictEqual(r.status, 200, p);
    bodies.push(JSON.stringify(r.data));
  }
  const text = bodies.join('\n');
  for (const who of ['gio', 'priya', 'marcus', 'jess']) {
    assert.ok(!text.includes(uidOf(`${who}@example.com`)), `uid of ${who}`);
    assert.ok(!text.includes(`${who}@example.com`), `email of ${who}`);
  }
  const people = JSON.parse(bodies[0]).people;
  assert.ok(people.length >= 4 && people.every((p) => /^[A-Za-z0-9_-]{22}$/.test(p.id) && p.uid === undefined));
  assert.deepStrictEqual(people.filter((p) => p.you).map((p) => p.name), ['Gio M.']);
  const dash = JSON.parse(bodies[1]).people;
  assert.deepStrictEqual(dash.map((p) => p.id).sort(), people.map((p) => p.id).sort(), 'one id per person on both');
  assert.ok(dash.every((p) => p.uid === undefined));
  // Staff see neither list.
  assert.strictEqual((await priya('GET', `/api/teams/${team.id}`)).data.people, undefined);
});

test('tomorrow: the missed question comes back, and the streak grows', async () => {
  const missed = team.priyaIds[1];
  const q = await priya('GET', `/api/teams/${team.id}/quiz`, undefined, { 'X-Local-Date': TOMORROW });
  assert.strictEqual(q.data.day, TOMORROW);
  assert.ok(q.data.questions.some((x) => x.id === missed), 'a miss is due the next day');
  assert.strictEqual(q.data.done, false);
  const stale = await priya('POST', `/api/teams/${team.id}/quiz/answer`, { qid: missed, choice: answers[missed] });
  assert.strictEqual(stale.status, 409, 'yesterday’s page cannot answer today’s quiz');
  let last;
  for (const x of q.data.questions) last = await priya('POST', `/api/teams/${team.id}/quiz/answer`, { qid: x.id, choice: answers[x.id] }, { 'X-Local-Date': TOMORROW });
  assert.deepStrictEqual([last.data.summary.perfect, last.data.summary.streak], [true, 2]);
  assert.ok(last.data.newBadges.some((b) => b.key === 'perfect'));
  const again = await priya('GET', `/api/teams/${team.id}/quiz`, undefined, { 'X-Local-Date': TOMORROW });
  assert.ok(again.data.stats.badges.find((b) => b.key === 'comeback').earnedAt, 'right after a miss is a comeback');
});

test('editing and deleting decks never breaks a day already under way', async () => {
  const d = (await gio('GET', `/api/teams/${team.id}/decks/${team.deckB}`)).data;
  const put = await gio('PUT', `/api/teams/${team.id}/decks/${team.deckB}`, { title: 'Allergens & dietary', questions: d.questions.map((q, i) => (i === 0 ? { ...q, prompt: 'Which pastry has nuts in it?' } : q)) });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.data.questions[0].id, d.questions[0].id, 'a rewording keeps its history');
  assert.strictEqual((await gio('PUT', `/api/teams/${team.id}/decks/${team.deckB}`, { questions: [{ ...d.questions[0], answer: null, options: d.questions[0].options.map((o) => ({ text: o, correct: false })) }] })).status, 400);
  const before = await marcus('GET', `/api/teams/${team.id}/quiz`);
  assert.strictEqual(before.data.done, true);
  assert.strictEqual((await gio('DELETE', `/api/teams/${team.id}/decks/${team.deckB}`)).status, 200);
  const after = await marcus('GET', `/api/teams/${team.id}/quiz`);
  assert.strictEqual(after.status, 200);
  assert.strictEqual(after.data.done, true, 'finished stays finished');
  assert.strictEqual((await gio('GET', `/api/teams/${team.id}`)).data.decks.length, 1);
});

test('out of credit: 402 before any model call, while hand-written decks and quizzes still work', async () => {
  await identityStore.merge('users', uidOf('gio@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  for (const [p, body] of [[`/api/teams/${team.id}/generate`, { text: MATERIAL }], [`/api/teams/${team.id}/generate/photo`, { image: { type: 'image/jpeg', data: JPEG } }]]) {
    const r = await gio('POST', p, body);
    assert.strictEqual(r.status, 402, p);
    assert.ok('topUpUrl' in r.data);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call was made');
  const hand = await gio('POST', `/api/teams/${team.id}/decks`, { title: 'Returns', questions: [mcq('How many days do customers have to return?', ['7', '14', '30', '60'], 2)] });
  assert.strictEqual(hand.status, 200, 'writing by hand is free');
  const q = await gio('GET', `/api/teams/${team.id}/quiz`);
  assert.strictEqual(q.status, 200);
  const x = q.data.questions[0];
  const a = await gio('POST', `/api/teams/${team.id}/quiz/answer`, { qid: x.id, choice: 0 });
  assert.strictEqual(a.status, 200, 'playing is free');
  assert.strictEqual((await gio('GET', `/api/teams/${team.id}/dashboard`)).status, 200);
  await identityStore.merge('users', uidOf('gio@example.com'), { spentUsd: 0 });
});

test('snap a page: non-image 400 before the model, unreadable 422, a proposal and nothing stored', async () => {
  const calls = await modelCalls();
  assert.strictEqual((await gio('POST', `/api/teams/${team.id}/generate/photo`, { image: { type: 'image/jpeg', data: Buffer.from('%PDF-1.7 not an image').toString('base64') } })).status, 400);
  assert.strictEqual((await gio('POST', `/api/teams/${team.id}/generate/photo`, { image: { type: 'application/pdf', data: JPEG } })).status, 400);
  assert.strictEqual((await gio('POST', `/api/teams/${team.id}/generate/photo`, {})).status, 400);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'refused before anything was spent');
  const dump = store._dump();
  assert.strictEqual((await gio('POST', `/api/teams/${team.id}/generate/photo`, { image: { type: 'image/jpeg', data: BLANK } })).status, 422);
  const r = await gio('POST', `/api/teams/${team.id}/generate/photo`, { image: { type: 'image/jpeg', data: JPEG }, title: 'Closing' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual([r.data.source, r.data.title], ['photo', 'Closing']);
  assert.ok(r.data.questions.length >= 3);
  const big = await gio('POST', `/api/teams/${team.id}/generate/photo`, { image: { type: 'image/jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024 * 1024)]).toString('base64') } });
  assert.strictEqual(big.status, 200, 'the photo route takes a real photo');
  assert.strictEqual(store._dump(), dump, 'reading a photo saves nothing');
  assert.ok(!store._dump().includes(JPEG.slice(0, 60)), 'the image is nowhere in the store');
});

test('the page: no inline script, handler or style attribute, in the HTML or written by script; motion only when allowed', () => {
  const fs = require('fs');
  const pub = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(pub, 'app.css'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html) && !/\son[a-z]+\s*=/i.test(html) && !/\sstyle\s*=/i.test(html));
  assert.ok(!/style\s*=\s*["']/.test(js) && !/\.style\b/.test(js) && !/setAttribute\(\s*['"]style/.test(js), 'the script writes no style');
  assert.ok(!/@import|url\(\s*["']?https?:/i.test(css) && !/@font-face/i.test(css), 'system fonts, nothing fetched');
  const still = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*$/, '');
  assert.ok(!/\b(animation|transition)\s*:/.test(still) && !/@keyframes/.test(still), 'every animation sits inside prefers-reduced-motion: no-preference');
  assert.ok(/--bg: #ffffff;/.test(css) && /--bg: #000000;/.test(css) && !/gradient\(/.test(css), 'a white page, a black one in dark, no gradients');
  assert.ok(html.includes('verify-banner.js" data-mount="api/auth"') && html.includes('<!-- lab:og'));
});

/* ---------------- Snap a page on Gemini (POPQUIZ_AI_PROVIDER=gemini) ---------------- */

const jpegWith = (word) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`${word} page`), Buffer.alloc(500, 3)]).toString('base64');
const flatOf = (s) => String(s).replace(/\s+/g, ' ').trim();

/** A stand-in for the lab's AI guard, so the route can be watched from the
 *  outside. Nothing here touches the network. */
function fakeGuard(opts = {}) {
  const log = { allow: [], record: [], requests: [], order: [] };
  return {
    log,
    allow: async (a) => { log.order.push('allow'); log.allow.push({ provider: a.provider, app: a.app, uid: a.req && a.req.user && a.req.user.id }); return opts.deny || { ok: true }; },
    record: async (r) => { log.order.push('record'); log.record.push(r); return true; },
    priceUsd: ({ provider, model, inputTokens, outputTokens }) => { log.priced = { provider, model }; return provider === 'gemini' ? gemini.priceUsd({ inputTokens, outputTokens, at: new Date('2026-11-23T00:00:00Z') }) : (inputTokens + 5 * outputTokens) / 1e6; },
    gemini: {
      generate: async (r) => {
        log.order.push('generate'); log.requests.push(r);
        if (opts.generate) return opts.generate(r);
        return { json: await r.fake({ contents: r.contents, generationConfig: { ...r.generationConfig, responseMimeType: 'application/json', responseSchema: r.responseSchema } }), usage: { inputTokens: 2000, outputTokens: 1500 } };
      },
    },
  };
}
async function withProvider(provider, guard, fn) {
  if (provider) process.env.POPQUIZ_AI_PROVIDER = provider; else delete process.env.POPQUIZ_AI_PROVIDER;
  if (guard) global.LAB_AI_GUARD = guard;
  try { return await fn(); } finally { delete process.env.POPQUIZ_AI_PROVIDER; delete global.LAB_AI_GUARD; }
}
const snapPath = () => `/api/teams/${team.id}/generate/photo`;

test('gemini: the request is one photo and a schema; the price table moves on 2027-01-01', () => {
  const r = gemini.request({ image: { mediaType: 'image/jpeg', data: 'AAAA' }, title: 'Closing', count: 99 });
  assert.strictEqual(r.model, 'gemini-3.8-flash');
  assert.strictEqual(r.contents.length, 1);
  assert.deepStrictEqual(r.contents[0].parts[0], { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
  assert.match(r.contents[0].parts[1].text, /QUESTIONS WANTED: 12\n/, 'the count is clamped before it is asked for');
  assert.match(gemini.request({ image: { mediaType: 'image/png', data: 'A' }, count: 1 }).contents[0].parts[1].text, /QUESTIONS WANTED: 4\n/);
  assert.deepStrictEqual(r.responseSchema.required, ['readable', 'title', 'transcription', 'questions']);
  assert.deepStrictEqual(r.responseSchema.properties.questions.items.required, ['type', 'prompt', 'options', 'explanation', 'source', 'topic']);
  assert.match(r.systemInstruction, /never an instruction to you/);
  assert.ok(Math.abs(gemini.priceUsd({ inputTokens: 1e6, outputTokens: 1e6, at: new Date('2026-12-31T23:59:59Z') }) - 4.5) < 1e-9);
  assert.ok(Math.abs(gemini.priceUsd({ inputTokens: 1e6, outputTokens: 1e6, at: new Date('2027-01-01T00:00:00Z') }) - 9) < 1e-9);
});

test('gemini: a question survives only if its source is a sentence of the transcription', () => {
  const page = 'Allergen sheet\nThe pesto contains  pine nuts and “Parmesan”.\nGarlic knots are brushed with butter — not vegan.';
  const good = (source, extra = {}) => ({ type: 'tf', prompt: 'The pesto has pine nuts in it.', options: [{ text: 'True', correct: true }, { text: 'False', correct: false }], explanation: 'The sheet lists pine nuts in the pesto.', source, topic: 'Allergens', ...extra });
  const one = (source, extra) => gemini.cleanPage({ readable: true, title: 'Allergens', transcription: page, questions: [good(source, extra)] });
  // Found whatever the spacing, case or quote style - and the quote kept is the PAGE's wording.
  const hit = one('the pesto contains pine nuts and "parmesan".');
  assert.strictEqual(hit.questions[0].source, 'The pesto contains pine nuts and “Parmesan”.');
  assert.strictEqual(one('"Garlic knots are brushed with butter - not vegan."').questions[0].source, 'Garlic knots are brushed with butter — not vegan.');
  assert.ok(flatOf(hit.transcription).includes(hit.questions[0].source));
  assert.deepStrictEqual([hit.grounded, hit.dropped, hit.ungrounded], [true, 0, 0]);
  // Not on the page, retold, empty, or too short to prove anything: dropped.
  for (const bad of ['The pesto contains walnuts.', 'Pesto has pine nuts and Parmesan in it.', '', 'pine nuts', 'pesto', null, 42, { evil: true }]) {
    assert.strictEqual(one(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
  // A sentence spanning two lines of the page still counts (it IS on the page).
  assert.ok(one('pine nuts and “Parmesan”. Garlic knots are brushed with butter'));
  // Nothing readable, no transcription, or a shape that is not an answer: null.
  for (const raw of [null, 'text', [], { readable: false, transcription: page, questions: [good('The pesto contains pine nuts')] }, { readable: true, transcription: '', questions: [good('The pesto contains pine nuts')] }, { readable: true, transcription: page, questions: 'none' }]) {
    assert.strictEqual(gemini.cleanPage(raw), null);
  }
  // Counted: one grounded, one invented, one that is not a question.
  const mix = gemini.cleanPage({ readable: true, title: '<b>Allergens</b>', transcription: `${page}<script>x</script>`, questions: [good('The pesto contains pine nuts'), good('The oven is at 500 degrees.', { prompt: 'The oven runs at five hundred.' }), { type: 'essay' }, good('The pesto contains pine nuts')] }, { count: 4 });
  assert.deepStrictEqual([mix.questions.length, mix.dropped, mix.ungrounded, mix.title], [1, 3, 1, 'Allergens']);
  assert.ok(!/[<>]/.test(mix.transcription));
  // A long sentence is cut at a word, still the page's own words.
  const long = `Rule one says that ${'every single closing shift '.repeat(12)}ends with the alarm.`;
  const cut = gemini.cleanPage({ readable: true, title: 'x', transcription: long, questions: [good(long)] });
  assert.ok(cut.questions[0].source.length <= Q.LIMITS.source && long.startsWith(cut.questions[0].source));
});

test('the provider switch: Claude reads the photo unless POPQUIZ_AI_PROVIDER=gemini, and pasted text is always Claude', async () => {
  for (const value of [undefined, '', 'claude', 'GEMINI', 'off', 'vertex']) {
    const g = fakeGuard();
    const r = await withProvider(value, g, () => gio('POST', snapPath(), { image: { type: 'image/jpeg', data: JPEG } }));
    assert.strictEqual(r.status, 200, String(value));
    assert.deepStrictEqual(g.log.order, ['allow', 'record'], `${value}: allow, the call, record - and no Gemini`);
    assert.deepStrictEqual([g.log.allow[0].provider, g.log.allow[0].app, g.log.record[0].provider, g.log.record[0].app], ['claude', 'popquiz', 'claude', 'popquiz']);
    assert.ok(g.log.record[0].usd > 0);
    assert.ok(!('transcription' in r.data) && !('grounded' in r.data), 'the Claude answer is the shape it always was');
    assert.strictEqual((await gio('GET', '/api/me')).data.photoReader, 'claude');
  }
  const g = fakeGuard();
  await withProvider('gemini', g, async () => {
    assert.strictEqual((await gio('GET', '/api/me')).data.photoReader, 'gemini');
    const t = await gio('POST', `/api/teams/${team.id}/generate`, { text: MATERIAL });
    assert.strictEqual(t.status, 200);
    assert.deepStrictEqual([g.log.order, g.log.allow[0].provider], [['allow', 'record'], 'claude'], 'text stays on Claude');
  });
  // No guard at all (the app on its own): Claude works exactly as before.
  assert.strictEqual((await gio('POST', snapPath(), { image: { type: 'image/jpeg', data: JPEG } })).status, 200);
});

test('gemini snap: transcription back, every question quotes it, clamped, charged to the ledger, nothing stored', async () => {
  const g = fakeGuard();
  const calls = await modelCalls();
  const dump = store._dump();
  const r = await withProvider('gemini', g, () => gio('POST', snapPath(), { image: { type: 'image/jpeg', data: JPEG }, title: 'Closing', count: 6 }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(g.log.order, ['allow', 'generate', 'record']);
  assert.deepStrictEqual(g.log.allow[0], { provider: 'gemini', app: 'popquiz', uid: uidOf('gio@example.com') });
  assert.deepStrictEqual([r.data.source, r.data.title, r.data.grounded, r.data.teamId], ['photo', 'Closing', true, team.id]);
  assert.strictEqual(r.data.transcription, fakeai.PAGE.join('\n'), 'the model\'s reading of the page comes back');
  assert.strictEqual(r.data.questions.length, 6, 'as many as asked for');
  const page = flatOf(r.data.transcription);
  for (const q of r.data.questions) {
    assert.ok(q.source.length >= 12 && page.includes(q.source), `"${q.source}" is on the page`);
    assert.ok(!Q.validateQuestion(q, { strict: true }).error);
    assert.deepStrictEqual(Object.keys(q).sort(), ['answer', 'explanation', 'options', 'prompt', 'source', 'topic', 'type']);
  }
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  // The request the helper got: the photo inline, the schema, and nothing else of the person's.
  const sent = g.log.requests[0];
  assert.strictEqual(sent.model, 'gemini-3.8-flash');
  assert.strictEqual(sent.contents[0].parts[0].inlineData.data, JPEG);
  assert.ok(sent.responseSchema && !JSON.stringify(sent).includes('gio@example.com'));
  // The cap's book and the person's own ledger are both charged, at Gemini's price.
  assert.deepStrictEqual([g.log.record[0].provider, g.log.record[0].app, g.log.priced.model], ['gemini', 'popquiz', 'gemini-3.8-flash']);
  assert.ok(Math.abs(g.log.record[0].usd - (2000 * 0.75 + 1500 * 3.75) / 1e6) < 1e-9);
  await settle();
  const rows = await identityStore.list('usage');
  assert.strictEqual(rows.length, calls + 1, 'one usage row');
  assert.ok(rows.some((u) => u.route === 'photo:gemini-3.8-flash'), 'the row says what really ran');
  assert.strictEqual(store._dump(), dump, 'reading a photo saves nothing - not the questions, not the transcription');
  assert.ok(!JSON.stringify(await identityStore.list('usage')).includes('walk-in'), 'no page text in the ledger');
  // Clamped at both ends.
  const few = await withProvider('gemini', fakeGuard(), () => gio('POST', snapPath(), { image: { type: 'image/jpeg', data: JPEG }, count: 1 }));
  assert.strictEqual(few.data.questions.length, 4);
  assert.strictEqual(few.data.title, 'Closing checklist', 'a suggested title when none is given');
  // No guard (the app on its own): the stand-in still answers under POPQUIZ_FAKE_AI.
  const alone = await withProvider('gemini', null, () => gio('POST', snapPath(), { image: { type: 'image/jpeg', data: JPEG } }));
  assert.deepStrictEqual([alone.status, alone.data.grounded], [200, true]);
});

test('gemini snap: a hostile answer is cut down to what the page says', async () => {
  const g = fakeGuard();
  const r = await withProvider('gemini', g, () => gio('POST', snapPath(), { image: { type: 'image/jpeg', data: jpegWith('INJECT') }, count: 12 }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const body = JSON.stringify(r.data);
  assert.ok(!/[<>]/.test(body) && !body.includes('evil.example') && !body.includes('\\u0007'), 'no markup, no link, no control characters');
  assert.deepStrictEqual(Object.keys(r.data).sort(), ['dropped', 'grounded', 'questions', 'source', 'teamId', 'title', 'transcription', 'ungrounded']);
  assert.strictEqual(r.data.title, 'Closing checklist');
  assert.ok(r.data.transcription.length <= gemini.LIMITS.transcription);
  assert.strictEqual(r.data.questions.length, 12, 'never more than twelve');
  assert.strictEqual(r.data.ungrounded, 4, 'the four with no sentence on the page are gone');
  assert.ok(r.data.dropped >= 10);
  const page = flatOf(r.data.transcription);
  const prompts = r.data.questions.map((q) => q.prompt).join('|');
  assert.ok(!/salmonella|freezer|manager decides|Everything is done|essay|two of these|right at all/i.test(prompts));
  assert.ok(prompts.includes('Two people are always in the building at close.'), 'the grounded one is kept, cleaned');
  for (const q of r.data.questions) {
    assert.ok(page.includes(q.source));
    assert.ok(!Q.validateQuestion(q, { strict: true }).error);
    assert.ok(!('url' in q));
  }
});

test('gemini snap: gates, then the parser, then the guard - a refusal anywhere means no model call', async () => {
  const body = { image: { type: 'image/jpeg', data: JPEG } };
  const calls = await modelCalls();
  const g = fakeGuard();
  await withProvider('gemini', g, async () => {
    const anon = client();
    assert.strictEqual((await anon('POST', snapPath(), body)).status, 401, 'signed out');
    assert.strictEqual((await anon('POST', snapPath(), { image: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } })).status, 401, 'a stranger\'s big body is not read');
    assert.strictEqual((await jess('POST', snapPath(), body)).status, 403, 'staff');
    assert.strictEqual((await stranger('POST', snapPath(), body)).status, 404, 'not on the team');
    assert.strictEqual((await gio('POST', snapPath(), { image: { type: 'image/jpeg', data: Buffer.from('%PDF-1.7 not an image').toString('base64') } })).status, 400, 'not an image');
    assert.strictEqual((await gio('POST', snapPath(), {})).status, 400);
    await identityStore.merge('users', uidOf('gio@example.com'), { spentUsd: 100 });
    assert.strictEqual((await gio('POST', snapPath(), body)).status, 402, 'out of credit');
    await identityStore.merge('users', uidOf('gio@example.com'), { spentUsd: 0 });
  });
  assert.deepStrictEqual(g.log.order, [], 'the guard was never asked and nothing was called');
  // The guard says no: its own words, its status and code, and no call.
  for (const deny of [{ ok: false, status: 429, code: 'burst-minute', message: 'Lots of people are using AI right now - try again in a minute.' }, { ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' }]) {
    const d = fakeGuard({ deny });
    const r = await withProvider('gemini', d, () => gio('POST', snapPath(), body));
    assert.deepStrictEqual([r.status, r.data.error, r.data.code], [deny.status, deny.message, deny.code]);
    // The Gemini cap falls back to Claude's own allow (capped too here); a burst does not.
    assert.deepStrictEqual(d.log.order, deny.code === 'monthly-cap' ? ['allow', 'allow'] : ['allow']);
    const c = fakeGuard({ deny });
    assert.strictEqual((await withProvider(undefined, c, () => gio('POST', snapPath(), body))).status, deny.status, 'the same for Claude');
    assert.deepStrictEqual(c.log.order, ['allow']);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'not one usage row');
  const dump = store._dump();
  // Unreadable on Gemini (paid for) -> Claude reads it too, and its 422 stands.
  const blank = fakeGuard();
  assert.strictEqual((await withProvider('gemini', blank, () => gio('POST', snapPath(), { image: { type: 'image/jpeg', data: BLANK } }))).status, 422);
  assert.deepStrictEqual(blank.log.order, ['allow', 'generate', 'record', 'allow', 'record']);
  // A provider failure falls back to Claude: never the provider's words.
  for (const word of ['UPSTREAM401', 'UPSTREAM429', 'UPSTREAM500']) {
    const u = fakeGuard();
    const r = await withProvider('gemini', u, () => gio('POST', snapPath(), { image: { type: 'image/jpeg', data: jpegWith(word) } }));
    assert.deepStrictEqual([r.status, r.data.reader, 'grounded' in r.data], [200, 'claude', false], word);
    assert.ok(!JSON.stringify(r.data).includes('stand-in'));
    assert.deepStrictEqual(u.log.order, ['allow', 'generate', 'allow', 'record'], 'Gemini billed nothing; Claude recorded');
  }
  // A call that failed after the model billed it is still recorded, then Claude answers.
  const billed = fakeGuard({ generate: async () => { throw Object.assign(new Error('Gemini gave no answer.'), { name: 'VertexError', code: 'blocked', usage: { inputTokens: 1500, outputTokens: 10 } }); } });
  assert.strictEqual((await withProvider('gemini', billed, () => gio('POST', snapPath(), body))).status, 200);
  assert.deepStrictEqual([billed.log.order, billed.log.record.map((x) => x.provider)], [['allow', 'generate', 'record', 'allow', 'record'], ['gemini', 'claude']]);
  const slow = fakeGuard({ generate: async () => { throw Object.assign(new Error('Gemini took too long.'), { name: 'VertexError', code: 'timeout' }); } });
  assert.strictEqual((await withProvider('gemini', slow, () => gio('POST', snapPath(), body))).data.reader, 'claude');
  // A junk answer (not the schema's shape at all) is unusable: Claude answers, no crash.
  const junk = fakeGuard({ generate: async () => ({ json: ['nope'], usage: { inputTokens: 10, outputTokens: 1 } }) });
  const jr = await withProvider('gemini', junk, () => gio('POST', snapPath(), body));
  assert.deepStrictEqual([jr.status, jr.data.reader], [200, 'claude']);
  assert.strictEqual(store._dump(), dump, 'none of it saved anything');
});

test('gemini snap fallback: only the Gemini cap -> Claude answers, logged once; a burst -> the guard\'s 429 and no Claude call', async () => {
  const body = { image: { type: 'image/jpeg', data: JPEG } };
  const cap = { ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' };
  const g = fakeGuard();
  g.allow = async (a) => { g.log.order.push('allow:' + a.provider); return a.provider === 'gemini' ? cap : { ok: true }; };
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let r;
  try { r = await withProvider('gemini', g, () => gio('POST', snapPath(), body)); } finally { console.log = orig; }
  assert.deepStrictEqual([r.status, r.data.reader, r.data.source, g.log.order], [200, 'claude', 'photo', ['allow:gemini', 'allow:claude', 'record']]);
  assert.ok(r.data.questions.length > 0);
  assert.deepStrictEqual(logs.filter((l) => l.startsWith('[popquiz]')), ['[popquiz] gemini failed (monthly-cap); used claude']);
  const calls = await modelCalls();
  const b = fakeGuard({ deny: { ok: false, status: 429, code: 'burst-day', message: 'Lots of people are using AI right now - try again in a minute.' } });
  const br = await withProvider('gemini', b, () => gio('POST', snapPath(), body));
  await settle();
  assert.deepStrictEqual([br.status, br.data.code, b.log.order, await modelCalls()], [429, 'burst-day', ['allow'], calls]);
  // Switch off: no reader field, as before.
  const off = await withProvider(undefined, fakeGuard(), () => gio('POST', snapPath(), body));
  assert.deepStrictEqual([off.status, 'reader' in off.data], [200, false]);
});

test('gemini is refused without the lab: no guard and no stand-in means no call', () => {
  const dir = path.join(__dirname, '..');
  const code = `process.env.POPQUIZ_MEMORY='1';process.env.POPQUIZ_AI_PROVIDER='gemini';
    const { app, identityStore } = require('./server');
    const http = require('http');
    const s = http.createServer(app).listen(0, async () => {
      const b = 'http://127.0.0.1:' + s.address().port;
      const h = { 'Content-Type': 'application/json' };
      const reg = await fetch(b + '/api/auth/register', { method: 'POST', headers: h, body: JSON.stringify({ email: 'solo@example.com', password: 'correct horse battery' }) });
      const cookie = reg.headers.get('set-cookie').split(';')[0];
      const t = await (await fetch(b + '/api/teams', { method: 'POST', headers: { ...h, Cookie: cookie }, body: JSON.stringify({ name: 'Solo' }) })).json();
      const img = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7)]).toString('base64');
      const r = await fetch(b + '/api/teams/' + t.id + '/generate/photo', { method: 'POST', headers: { ...h, Cookie: cookie }, body: JSON.stringify({ image: { type: 'image/jpeg', data: img } }) });
      console.log(JSON.stringify({ status: r.status, body: await r.json(), usage: (await identityStore.list('usage')).length }));
      s.close();
    });`;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: dir, env: { ...process.env, POPQUIZ_FAKE_AI: '', REQUIRE_VERIFIED_FOR_FREE_AI: '0' }, encoding: 'utf8' });
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  // No helper falls back to Claude, which (no key here) fails the usual way: 500 with the route's sentence.
  assert.deepStrictEqual(out, { status: 500, body: { error: 'Could not read that photo. Try again, or paste the text.' }, usage: 0 });
});

test('managing the team: rename, a fresh code kills the old one, remove and leave', async () => {
  const ren = await gio('PUT', `/api/teams/${team.id}`, { name: 'Harbour Coffee Co.', emoji: '🍕' });
  assert.deepStrictEqual([ren.data.name, ren.data.emoji], ['Harbour Coffee Co.', '🍕']);
  const code = await gio('POST', `/api/teams/${team.id}/code`);
  assert.notStrictEqual(code.data.code, team.code);
  const newbie = await register('newbie@example.com');
  assert.strictEqual((await newbie('POST', '/api/join', { code: team.code })).status, 404, 'the old code is dead');
  assert.strictEqual((await newbie('POST', '/api/join', { code: code.data.code })).status, 200);
  assert.strictEqual((await priya('PUT', `/api/teams/${team.id}/me`, { name: 'Priya N.' })).data.name, 'Priya N.');
  // The manager removes Marcus; his progress goes with him.
  const marcusUid = uidOf('marcus@example.com');
  assert.strictEqual((await gio('DELETE', `/api/teams/${team.id}/members/${marcusUid}`)).status, 404, 'a raw uid names nobody');
  const marcusId = (await gio('GET', `/api/teams/${team.id}`)).data.people.find((p) => p.name === 'Marcus').id;
  assert.strictEqual((await gio('DELETE', `/api/teams/${team.id}/members/${marcusId}`)).status, 200);
  assert.strictEqual((await marcus('GET', `/api/teams/${team.id}/quiz`)).status, 404);
  assert.strictEqual(await store.get(`teams/${team.id}/progress`, marcusUid), null);
  assert.deepStrictEqual((await marcus('GET', '/api/me')).data.teams, []);
  assert.strictEqual((await gio('DELETE', `/api/teams/${team.id}/members/nobody-here`)).status, 404);
  // Newbie leaves on their own; the owner cannot.
  assert.strictEqual((await newbie('DELETE', `/api/teams/${team.id}/members/me`)).data.left, true);
  assert.strictEqual((await gio('DELETE', `/api/teams/${team.id}/members/me`)).status, 400);
  const lb = await gio('GET', `/api/teams/${team.id}/leaderboard`);
  assert.deepStrictEqual(lb.data.rows.map((r) => r.name).sort(), ['Gio M.', 'Jess', 'Priya N.']);
});

test('caps: a full team, and teams per manager', async () => {
  const boss = await register('boss@example.com');
  const ids = [];
  for (let i = 0; i < T.LIMITS.ownedTeams; i++) {
    const r = await boss('POST', '/api/teams', { name: `Shop ${i}` });
    assert.strictEqual(r.status, 200);
    ids.push(r.data);
  }
  const over = await boss('POST', '/api/teams', { name: 'One too many' });
  assert.strictEqual(over.status, 409);
  await store.set('teams', ids[0].id, { ...(await store.get('teams', ids[0].id)), memberIds: Array.from({ length: T.LIMITS.members }, (_, i) => `fake${i}`) });
  const late = await register('late@example.com');
  const full = await late('POST', '/api/join', { code: ids[0].code });
  assert.strictEqual(full.status, 409);
  assert.match(full.data.error, /full/);
});

test('deleting a team takes everything with it; only its owner can', async () => {
  assert.strictEqual((await jess('DELETE', `/api/teams/${team.id}`)).status, 403);
  const code = (await gio('GET', `/api/teams/${team.id}`)).data.code;
  assert.strictEqual((await gio('DELETE', `/api/teams/${team.id}`)).status, 200);
  assert.strictEqual((await gio('GET', `/api/teams/${team.id}`)).status, 404);
  assert.deepStrictEqual((await jess('GET', '/api/me')).data.teams, []);
  assert.strictEqual(await store.get('codes', Q.normalizeCode(code)), null);
  assert.deepStrictEqual(await store.list(`teams/${team.id}/progress`), []);
  assert.deepStrictEqual(await store.list(`teams/${team.id}/decks`), []);
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use('/popquiz', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/popquiz`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
