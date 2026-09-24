// Pop Quiz - staff training that plays like a daily game.
//
// Restaurants, shops, salons, clinics, gyms and hotels all have rules that
// must stick - allergens, opening and closing, safety, the returns policy -
// and a binder nobody reads. A manager pastes the material (or snaps a photo
// of the page), reviews the questions a model proposes, and publishes a deck.
// Staff get five questions a day, with streaks, XP and a weekly leaderboard;
// the questions they miss come back sooner. The manager sees who is keeping
// up and which questions the whole team keeps getting wrong. See CLAUDE.md.
//
// A model is used for one thing only: turning material into a proposal. Taking
// a quiz never calls one - answers are checked against what the manager
// published, by public/quiz.js.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Q = require('./public/quiz');
const T = require('./lib/teams');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const { demo } = require('./lib/demo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.POPQUIZ_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('POPQUIZ_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor. Both read photos.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// One photo rides in the snap request as base64. Only that route gets the
// big limit, and it mounts its own parser AFTER the sign-in and budget checks,
// so a stranger's 6 MB is never read. Everything else stays small.
const PHOTO_ROUTE = /^\/api\/teams\/[^/]+\/generate\/photo$/;
const bigJson = express.json({ limit: '6mb' });
const smallJson = express.json({ limit: '128kb' });
app.use((req, res, next) => (PHOTO_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'popquiz',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Pop Quiz',
  mountPath: '/api/auth',
});
identity.mount(app);

const sharedClient = FAKE_AI
  ? identity.meter(require('./lib/fakeai').create())
  : identity.meter(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

function clientFor(req) {
  if (FAKE_AI) return Promise.resolve(sharedClient);
  return identity.clientFor(req.user, sharedClient, (apiKey) => new Anthropic({ apiKey }));
}
const modelFor = (req) => identityLib.planFor(req.user, MODELS).model;

// Never put a model call behind a sign-in alone: every one of these goes
// through the budget and the free tier's daily ceiling as well.
const spend = [identity.requireUser, identity.requireBudget, identity.requireDailyCap];
const user = identity.requireUser;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const now = () => new Date().toISOString();
const httpError = T.httpError;
const fail = (res, err, fallback = 'Something went wrong.') => {
  if (!err.status) console.error(err);
  const body = { error: err.status ? err.message : fallback };
  if (err.index !== undefined) body.index = err.index;
  if (err.retryAfterMin) body.retryAfterMin = err.retryAfterMin;
  res.status(err.status || 500).json(body);
};
const todayOf = (req) => T.todayFrom(req.get('x-local-date') || req.query.today);

const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const membersOf = (tid) => `teams/${tid}/members`;
const decksOf = (tid) => `teams/${tid}/decks`;
const progressOf = (tid) => `teams/${tid}/progress`;

/**
 * The team, if the signed-in person is on it. 404 - never 403 - for anyone
 * who is not, so a team id is not confirmed to exist. `manager: true` then
 * turns away staff with a 403: they are on the team, so there is nothing to
 * hide from them about its existence.
 */
async function loadTeam(req, { manager = false, owner = false } = {}) {
  const id = String(req.params.id || '');
  const t = ID_RE.test(id) ? await store.get('teams', id) : null;
  if (!t || !(t.memberIds || []).includes(req.user.id)) throw httpError(404, 'No such team.');
  const me = await store.get(membersOf(t.id), req.user.id);
  if (!me) throw httpError(404, 'No such team.');
  t.me = me;
  t.viewer = req.user.id;
  t.role = t.ownerId === req.user.id ? 'manager' : (me.role === 'manager' ? 'manager' : 'staff');
  if (owner && t.ownerId !== req.user.id) throw httpError(403, 'Only the person who made this team can do that.');
  if (manager && t.role !== 'manager') throw httpError(403, 'Only a manager can do that.');
  return t;
}

async function loadDecks(tid) {
  return store.list(decksOf(tid), { limit: T.LIMITS.decks + 5 });
}
async function loadMembers(tid) {
  const rows = await store.list(membersOf(tid), { limit: T.LIMITS.members + 5 });
  return rows.map((m) => ({ uid: m.id, name: m.name, role: m.role, joinedAt: m.joinedAt }));
}
async function loadProgress(tid, uid) {
  const p = await store.get(progressOf(tid), uid);
  if (!p) return T.emptyProgress();
  delete p.id;
  return { ...T.emptyProgress(), ...p };
}

/**
 * One read-modify-write at a time per person per team, queued rather than
 * refused: a double-tapped answer waits its turn, finds the first one already
 * recorded, and scores nothing. Only this person ever writes their progress
 * document, so this is the whole of its concurrency story on one instance.
 */
const locks = new Map();
async function exclusive(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  locks.set(key, chain);
  await prev;
  try { return await fn(); } finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
}

function teamView(t, extra = {}) {
  const manager = t.role === 'manager';
  return {
    id: t.id,
    name: t.name,
    emoji: t.emoji,
    role: t.role,
    owner: t.ownerId === t.viewer,
    code: manager ? Q.formatCode(t.code) : undefined,
    members: (t.memberIds || []).length,
    you: t.me.name,
    ...extra,
  };
}

/* ------------------------------------------------------------------ *
 * Public: health, meta, the sample
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ types: Q.QTYPES, badges: Q.BADGES, emojis: T.EMOJIS, xp: Q.XP, intervals: Q.INTERVALS, limits: { ...T.LIMITS, question: Q.LIMITS } });
});

// A hand-made team run through the real arithmetic. No model call for a
// signed-out visitor, ever.
app.get('/api/demo', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(demo(todayOf(req)));
});

/* ------------------------------------------------------------------ *
 * Me and my teams
 * ------------------------------------------------------------------ */

async function myTeams(uid) {
  const rows = await store.list('teams', { where: [['memberIds', 'array-contains', uid]], limit: T.LIMITS.memberships + 5 });
  const out = [];
  for (const t of rows) {
    const me = await store.get(membersOf(t.id), uid);
    if (!me) continue;
    out.push({ id: t.id, name: t.name, emoji: t.emoji, role: t.ownerId === uid || me.role === 'manager' ? 'manager' : 'staff', owner: t.ownerId === uid, members: (t.memberIds || []).length, createdAt: t.createdAt });
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

app.get('/api/me', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.json({ signedIn: false });
    res.json({
      signedIn: true,
      email: req.user.email,
      name: T.nameFromEmail(req.user.email),
      budget: identityLib.budgetFor(req.user),
      tier: identityLib.planFor(req.user, MODELS).tier,
      teams: await myTeams(req.user.id),
    });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Teams: create, join, manage
 * ------------------------------------------------------------------ */

app.post('/api/teams', user, async (req, res) => {
  try {
    const b = req.body || {};
    const facts = T.cleanTeam(b);
    const mine = await myTeams(req.user.id);
    if (mine.filter((t) => t.owner).length >= T.LIMITS.ownedTeams) throw httpError(409, `You can run up to ${T.LIMITS.ownedTeams} teams.`);
    if (mine.length >= T.LIMITS.memberships) throw httpError(409, `You are on ${T.LIMITS.memberships} teams already - leave one first.`);
    let code = T.newCode();
    for (let i = 0; i < 5 && (await store.get('codes', code)); i++) code = T.newCode();
    const at = now();
    const id = T.newId();
    const name = T.cleanPersonName(b.yourName, T.nameFromEmail(req.user.email));
    await store.set('teams', id, { ...facts, code, ownerId: req.user.id, memberIds: [req.user.id], createdAt: at, updatedAt: at });
    await store.set(membersOf(id), req.user.id, { name, role: 'manager', joinedAt: at });
    await store.set('codes', code, { teamId: id, createdAt: at });
    const t = await loadTeam({ params: { id }, user: req.user });
    res.json(teamView(t));
  } catch (err) { fail(res, err); }
});

/**
 * Wrong codes are counted per person (in the store, so it holds across
 * instances) and per address (in memory, for someone with many accounts).
 * Every wrong code gets the same answer - there is no way to tell "no such
 * code" from "a code that used to work", and nothing about any team.
 */
const ipTries = new Map();
function ipBlocked(ip) {
  const e = ipTries.get(ip);
  if (!e) return false;
  if (Date.now() - e.since > T.LIMITS.joinWindowMs) { ipTries.delete(ip); return false; }
  return e.count >= T.LIMITS.joinTriesPerIp;
}
function ipMiss(ip) {
  const e = ipTries.get(ip);
  if (!e || Date.now() - e.since > T.LIMITS.joinWindowMs) ipTries.set(ip, { count: 1, since: Date.now() });
  else e.count++;
  if (ipTries.size > 5000) ipTries.delete(ipTries.keys().next().value);
}
async function userTries(uid) {
  const r = await store.get('joinfails', uid);
  if (!r || Date.now() - Date.parse(r.since) > T.LIMITS.joinWindowMs) return { count: 0, since: null };
  return r;
}
function tooMany(since) {
  const left = since ? Math.max(1, Math.ceil((Date.parse(since) + T.LIMITS.joinWindowMs - Date.now()) / 60000)) : 15;
  return httpError(429, `Too many wrong codes. Try again in ${left} minute${left === 1 ? '' : 's'}, and check the code with your manager.`, { retryAfterMin: left });
}

app.post('/api/join', user, async (req, res) => {
  try {
    const b = req.body || {};
    const tries = await userTries(req.user.id);
    if (tries.count >= T.LIMITS.joinTries || ipBlocked(req.ip)) throw tooMany(tries.since);
    const code = Q.normalizeCode(b.code);
    const link = Q.isCode(code) ? await store.get('codes', code) : null;
    const t = link && await store.get('teams', link.teamId);
    if (!t || t.code !== code) {
      await store.set('joinfails', req.user.id, { count: tries.count + 1, since: tries.since || now() });
      ipMiss(req.ip);
      throw httpError(404, 'That code didn’t match a team. Check it with your manager - codes change when they reset them.');
    }
    if ((t.memberIds || []).includes(req.user.id)) {
      return res.json({ id: t.id, name: t.name, emoji: t.emoji, already: true });
    }
    if ((t.memberIds || []).length >= T.LIMITS.members) throw httpError(409, `This team is full (${T.LIMITS.members} people). Ask your manager.`);
    const mine = await myTeams(req.user.id);
    if (mine.length >= T.LIMITS.memberships) throw httpError(409, `You are on ${T.LIMITS.memberships} teams already - leave one first.`);
    const name = T.cleanPersonName(b.name, T.nameFromEmail(req.user.email));
    await store.set(membersOf(t.id), req.user.id, { name, role: 'staff', joinedAt: now() });
    await store.arrayAdd('teams', t.id, 'memberIds', req.user.id);
    res.json({ id: t.id, name: t.name, emoji: t.emoji, already: false });
  } catch (err) { fail(res, err); }
});

app.get('/api/teams/:id', user, async (req, res) => {
  try {
    const t = await loadTeam(req);
    const decks = await loadDecks(t.id);
    res.set('Cache-Control', 'no-store');
    res.json(teamView(t, {
      decks: decks.map(T.deckSummary).sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt))),
      questions: decks.reduce((s, d) => s + (d.questions || []).length, 0),
      people: t.role === 'manager' ? await loadMembers(t.id) : undefined,
    }));
  } catch (err) { fail(res, err); }
});

app.put('/api/teams/:id', user, async (req, res) => {
  try {
    const t = await loadTeam(req, { manager: true });
    const patch = T.cleanTeam(req.body || {}, t);
    await store.merge('teams', t.id, { ...patch, updatedAt: now() });
    res.json(teamView({ ...t, ...patch }));
  } catch (err) { fail(res, err); }
});

/** Your own name on this team. */
app.put('/api/teams/:id/me', user, async (req, res) => {
  try {
    const t = await loadTeam(req);
    const name = T.cleanPersonName((req.body || {}).name, t.me.name);
    await store.merge(membersOf(t.id), req.user.id, { name });
    res.json({ name });
  } catch (err) { fail(res, err); }
});

/** A fresh code. The old one stops working at once - for when it leaked, or
 *  someone left who should not rejoin. */
app.post('/api/teams/:id/code', user, async (req, res) => {
  try {
    const t = await loadTeam(req, { manager: true });
    let code = T.newCode();
    for (let i = 0; i < 5 && (await store.get('codes', code)); i++) code = T.newCode();
    await store.set('codes', code, { teamId: t.id, createdAt: now() });
    await store.merge('teams', t.id, { code, updatedAt: now() });
    if (t.code) await store.remove('codes', t.code);
    res.json({ code: Q.formatCode(code) });
  } catch (err) { fail(res, err); }
});

/**
 * Remove someone, or leave (`me`). A manager removes staff; the owner can
 * remove anyone but themselves; everyone can leave except the owner, who
 * deletes the team instead. Their progress goes with them.
 */
app.delete('/api/teams/:id/members/:uid', user, async (req, res) => {
  try {
    const t = await loadTeam(req);
    const uid = req.params.uid === 'me' ? req.user.id : String(req.params.uid);
    if (uid === t.ownerId) throw httpError(400, uid === req.user.id ? 'You made this team - delete it instead of leaving.' : 'The team’s owner cannot be removed.');
    if (uid !== req.user.id) {
      if (t.role !== 'manager') throw httpError(403, 'Only a manager can do that.');
      const them = ID_RE.test(uid) && (t.memberIds || []).includes(uid) ? await store.get(membersOf(t.id), uid) : null;
      if (!them) throw httpError(404, 'They are not on this team.');
      if (them.role === 'manager' && t.ownerId !== req.user.id) throw httpError(403, 'Only the owner can remove a manager.');
    }
    await store.arrayRemove('teams', t.id, 'memberIds', uid);
    await store.remove(membersOf(t.id), uid);
    await store.remove(progressOf(t.id), uid);
    res.json({ ok: true, left: uid === req.user.id });
  } catch (err) { fail(res, err); }
});

app.delete('/api/teams/:id', user, async (req, res) => {
  try {
    const t = await loadTeam(req, { owner: true });
    for (const d of await loadDecks(t.id)) await store.remove(decksOf(t.id), d.id);
    for (const m of await store.list(membersOf(t.id))) await store.remove(membersOf(t.id), m.id);
    for (const p of await store.list(progressOf(t.id))) await store.remove(progressOf(t.id), p.id);
    if (t.code) await store.remove('codes', t.code);
    await store.remove('teams', t.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Decks: a manager's, published after review
 * ------------------------------------------------------------------ */

async function loadDeck(t, req) {
  const id = String(req.params.deckId || '');
  const d = ID_RE.test(id) ? await store.get(decksOf(t.id), id) : null;
  if (!d) throw httpError(404, 'No such deck.');
  return d;
}

/** The full deck, answers and all - for the manager's editor only. Staff
 *  would otherwise be one tap from every answer. */
app.get('/api/teams/:id/decks/:deckId', user, async (req, res) => {
  try {
    const t = await loadTeam(req, { manager: true });
    res.json(await loadDeck(t, req));
  } catch (err) { fail(res, err); }
});

/**
 * Publish. The body is whatever the manager ended up with in the editor - a
 * reviewed proposal or hand-written questions - and every question is
 * validated again here, all or nothing. This is the only route that stores a
 * question.
 */
app.post('/api/teams/:id/decks', user, async (req, res) => {
  try {
    const t = await loadTeam(req, { manager: true });
    const b = req.body || {};
    const meta = T.cleanDeckMeta(b);
    const questions = T.cleanQuestions(b.questions);
    const decks = await loadDecks(t.id);
    if (decks.length >= T.LIMITS.decks) throw httpError(409, `A team holds up to ${T.LIMITS.decks} decks.`);
    const total = decks.reduce((s, d) => s + (d.questions || []).length, 0);
    if (total + questions.length > T.LIMITS.questions) throw httpError(409, `A team holds up to ${T.LIMITS.questions} questions - you have room for ${Math.max(0, T.LIMITS.questions - total)} more.`);
    const at = now();
    const deck = { ...meta, source: ['text', 'photo', 'hand'].includes(b.source) ? b.source : 'hand', questions, createdBy: req.user.id, createdAt: at, publishedAt: at, updatedAt: at };
    const id = T.newId();
    await store.set(decksOf(t.id), id, deck);
    res.json({ id, ...deck });
  } catch (err) { fail(res, err); }
});

app.put('/api/teams/:id/decks/:deckId', user, async (req, res) => {
  try {
    const t = await loadTeam(req, { manager: true });
    const d = await loadDeck(t, req);
    const b = req.body || {};
    const meta = T.cleanDeckMeta({ title: b.title !== undefined ? b.title : d.title, emoji: b.emoji !== undefined ? b.emoji : d.emoji });
    const questions = b.questions !== undefined ? T.cleanQuestions(b.questions, d.questions || []) : d.questions;
    const others = (await loadDecks(t.id)).filter((x) => x.id !== d.id).reduce((s, x) => s + (x.questions || []).length, 0);
    if (others + questions.length > T.LIMITS.questions) throw httpError(409, `A team holds up to ${T.LIMITS.questions} questions.`);
    const next = { ...d, ...meta, questions, updatedAt: now() };
    delete next.id;
    await store.set(decksOf(t.id), d.id, next);
    res.json({ id: d.id, ...next });
  } catch (err) { fail(res, err); }
});

app.delete('/api/teams/:id/decks/:deckId', user, async (req, res) => {
  try {
    const t = await loadTeam(req, { manager: true });
    const d = await loadDeck(t, req);
    await store.remove(decksOf(t.id), d.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Metered: material in, a proposal out. Nothing is saved.
 * ------------------------------------------------------------------ */

app.post('/api/teams/:id/generate', ...spend, async (req, res) => {
  try {
    const t = await loadTeam(req, { manager: true });
    const b = req.body || {};
    const text = T.cleanText(b.text, T.LIMITS.source);
    if (text.length < T.LIMITS.sourceMin) throw httpError(400, 'Paste a bit more - a paragraph or a list at least, so there is something to ask about.');
    const title = T.clean(b.title, T.LIMITS.deckTitle);
    const client = await clientFor(req);
    const raw = await ai.generate(client, modelFor(req), { text, title, count: b.count });
    const proposal = ai.validateGenerated(raw, { title });
    if (!proposal) throw httpError(422, 'That doesn’t read like training material we can quiz on. Try a menu, a checklist or a policy - or write the questions yourself.');
    res.json({ ...proposal, source: 'text', teamId: t.id });
  } catch (err) { fail(res, err, 'Could not write questions from that. Try again, or write them by hand.'); }
});

/**
 * Snap a page: one photo in, a proposal out. Validated by its bytes before
 * anything is spent, read once by the model, dropped with the request.
 */
app.post('/api/teams/:id/generate/photo', ...spend, bigJson, async (req, res) => {
  try {
    const t = await loadTeam(req, { manager: true });
    const b = req.body || {};
    const image = photo.validate(b.image);
    const title = T.clean(b.title, T.LIMITS.deckTitle);
    const client = await clientFor(req);
    const raw = await ai.generate(client, modelFor(req), { image, title, count: b.count });
    const proposal = ai.validateGenerated(raw, { title });
    if (!proposal) throw httpError(422, 'We couldn’t read training material in that photo. Try a sharper, closer shot of one page - or paste the text.');
    res.json({ ...proposal, source: 'photo', teamId: t.id });
  } catch (err) { fail(res, err, 'Could not read that photo. Try again, or paste the text.'); }
});

/* ------------------------------------------------------------------ *
 * The daily quiz. No model call anywhere below this line.
 * ------------------------------------------------------------------ */

async function publishedQuestions(tid) {
  const decks = await loadDecks(tid);
  return { decks, questions: T.flatten(decks) };
}

/** Today's five for this person, picked once and kept for the day, so a
 *  reload shows the same quiz and an answered question cannot be re-rolled. */
function ensureToday(p, questions, uid, today) {
  const ids = new Set(questions.map((q) => q.id));
  const t = p.today;
  const stillThere = t && t.day === today ? t.ids.filter((id) => ids.has(id) || (t.answers || {})[id]) : [];
  if (t && t.day === today && stillThere.length && stillThere.length === t.ids.length) return false;
  if (t && t.day === today && stillThere.length && Object.keys(t.answers || {}).length) {
    // A deck was deleted mid-day: keep what was answered, drop what vanished.
    p.today = { ...t, ids: stillThere };
    return true;
  }
  p.today = { day: today, ids: Q.pickDaily(questions, p.cards, today, uid + today), answers: {} };
  return true;
}

function quizView(p, questions, today, extra = {}) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const t = p.today || { ids: [], answers: {} };
  const answers = {};
  for (const [id, a] of Object.entries(t.answers || {})) {
    const q = byId.get(id);
    if (q) answers[id] = T.resultOf(q, a);
    else answers[id] = { choice: a.choice, correct: a.correct, answer: null, explanation: 'This question has since been removed.', source: '' };
  }
  const shown = t.ids.filter((id) => byId.has(id) || answers[id]);
  const score = shown.filter((id) => answers[id] && answers[id].correct).length;
  return {
    day: today,
    empty: !questions.length,
    questions: shown.map((id) => (byId.has(id) ? T.publicQuestion(byId.get(id)) : { id, type: 'mcq', prompt: 'A question that has since been removed.', options: [], removed: true })),
    answers,
    done: Q.doneToday(p, today),
    score,
    total: shown.length,
    stats: T.statsOf(p, questions, today),
    ...extra,
  };
}

app.get('/api/teams/:id/quiz', user, async (req, res) => {
  try {
    const t = await loadTeam(req);
    const today = todayOf(req);
    const { questions } = await publishedQuestions(t.id);
    const out = await exclusive(`p/${t.id}/${req.user.id}`, async () => {
      const p = await loadProgress(t.id, req.user.id);
      if (questions.length && ensureToday(p, questions, req.user.id, today)) {
        await store.set(progressOf(t.id), req.user.id, { ...p, updatedAt: now() });
      }
      return quizView(p, questions, today);
    });
    res.set('Cache-Control', 'no-store');
    res.json({ team: teamView(t), ...out });
  } catch (err) { fail(res, err); }
});

/**
 * One answer. Checked here against the published answer (the page never has
 * it before answering), moved through the Leitner boxes, scored, and written
 * to this person's own progress document only - two people answering at the
 * same moment write two different documents.
 */
app.post('/api/teams/:id/quiz/answer', user, async (req, res) => {
  try {
    const t = await loadTeam(req);
    const today = todayOf(req);
    const b = req.body || {};
    const qid = String(b.qid || '');
    const choice = Number(b.choice);
    const { questions } = await publishedQuestions(t.id);
    const out = await exclusive(`p/${t.id}/${req.user.id}`, async () => {
      const p = await loadProgress(t.id, req.user.id);
      const day = p.today;
      if (!day || day.day !== today) throw httpError(409, 'It’s a new day - here are today’s questions.');
      if (!day.ids.includes(qid)) throw httpError(404, 'That question isn’t in today’s quiz.');
      const q = questions.find((x) => x.id === qid);
      if (!q) throw httpError(409, 'Your manager just removed that question - on to the next.');
      const prior = (day.answers || {})[qid];
      if (prior) return { ...T.resultOf(q, prior), xpGained: 0, repeat: true, done: Q.doneToday(p, today) };
      if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) throw httpError(400, 'Pick one of the options.');

      const correct = Q.check(q, choice);
      const r = Q.review(p.cards[qid], correct, today, choice);
      p.cards = { ...p.cards, [qid]: r.card };
      if (r.comeback) p.comebacks = (p.comebacks || 0) + 1;
      day.answers = { ...(day.answers || {}), [qid]: { choice, correct, at: now() } };
      let xp = Q.xpForAnswer(correct);
      const done = Q.doneToday(p, today);
      let summary = null;
      if (done) {
        const score = day.ids.filter((id) => day.answers[id] && day.answers[id].correct).length;
        const perfect = score === day.ids.length;
        xp += Q.xpForFinish(score, day.ids.length);
        p.streak = Q.nextStreak(p.streak, p.lastDoneDay, today);
        p.best = Math.max(p.best || 0, p.streak);
        p.lastDoneDay = today;
        p.daysDone = (p.daysDone || 0) + 1;
        if (perfect) p.perfectDays = (p.perfectDays || 0) + 1;
        summary = { score, total: day.ids.length, perfect };
      }
      p.xp = (p.xp || 0) + xp;
      p.xpByDay = T.trimXp({ ...(p.xpByDay || {}), [today]: ((p.xpByDay || {})[today] || 0) + xp }, today);

      const earned = Q.badgesFor(p, { questions: questions.length, mastery: Q.mastery(questions, p.cards) });
      const fresh = earned.filter((k) => !(p.badges || {})[k]);
      p.badges = { ...(p.badges || {}) };
      for (const k of fresh) p.badges[k] = today;
      await store.set(progressOf(t.id), req.user.id, { ...p, updatedAt: now() });

      return {
        ...T.resultOf(q, { choice, correct }),
        xpGained: xp,
        comeback: r.comeback,
        nextIn: Q.INTERVALS[r.card.box],
        done,
        summary: summary && { ...summary, streak: p.streak, best: p.best, xpToday: p.xpByDay[today] },
        newBadges: fresh.map((k) => Q.badgeInfo(k)),
        stats: T.statsOf(p, questions, today),
      };
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The leaderboard (everyone) and the dashboard (managers)
 * ------------------------------------------------------------------ */

async function allProgress(tid) {
  const rows = await store.list(progressOf(tid), { limit: T.LIMITS.members + 5 });
  return Object.fromEntries(rows.map((r) => { const { id, ...p } = r; return [id, { ...T.emptyProgress(), ...p }]; }));
}

/** Name, XP this week and streak - and nothing about anyone's answers. */
app.get('/api/teams/:id/leaderboard', user, async (req, res) => {
  try {
    const t = await loadTeam(req);
    const today = todayOf(req);
    const members = await loadMembers(t.id);
    const progress = await allProgress(t.id);
    const rows = Q.leaderboard(members.map((m) => ({ uid: m.uid, name: m.name, progress: progress[m.uid] })), today)
      .map((r) => ({ rank: r.rank, name: r.name, weekXp: r.weekXp, streak: r.streak, you: r.uid === req.user.id }));
    res.set('Cache-Control', 'no-store');
    res.json({ team: teamView(t), week: Q.weekStart(today), today, rows });
  } catch (err) { fail(res, err); }
});

/** Who's done today, per-person mastery, and the team's blind spots. All
 *  computed on each read; per-question misses are a manager's view only. */
app.get('/api/teams/:id/dashboard', user, async (req, res) => {
  try {
    const t = await loadTeam(req, { manager: true });
    const today = todayOf(req);
    const { decks, questions } = await publishedQuestions(t.id);
    const members = await loadMembers(t.id);
    const progress = await allProgress(t.id);
    res.set('Cache-Control', 'no-store');
    const d = T.dashboard(members, progress, questions, decks, today);
    d.people = d.people.map((x) => ({ ...x, you: x.uid === req.user.id }));
    res.json({ team: teamView(t), ...d });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

const INDEX = path.join(__dirname, 'public', 'index.html');
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once - try a smaller photo or less text.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // POPQUIZ_DEV_MOUNT=/popquiz runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.POPQUIZ_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`popquiz listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
