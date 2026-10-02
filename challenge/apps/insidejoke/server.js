// Inside Joke - trivia made from a group's own photos and group chat, played
// together on a call or apart, one round a day. See CLAUDE.md.
//
// A model is used for two things, both metered and signed in, both paid by
// whoever asks: writing questions about a photo, and picking "who said it?"
// quotes from a stripped excerpt of a chat. Everything else - the chat stats,
// writing your own questions, the daily round, the board, live game night -
// is free, and members never need an account: a host with a free account
// makes the group, everyone else joins by link, QR or code with a name and
// an emoji.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/ij-core');
const G = require('./lib/groups');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const { streamedJson } = require('./lib/stream');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.INSIDEJOKE_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('INSIDEJOKE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor. Both read photos.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere in these pages: every app in the lab shares
  // one origin, so one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A join code or a group id is a key to the group. Neither may ride out
  // in a Referer header, and no group page should ever be indexed.
  if (/^\/(?:j|g)\//.test(req.path) || /^\/api\/(?:code|groups)\//.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// Two routes carry more than 64 KB - a photo (thumbnail plus the model's
// copy) and a chat excerpt - and each mounts its own parser AFTER sign-in,
// budget, the daily cap and membership, so a stranger's body is never read.
const BIG_ROUTE = /^\/api\/groups\/[a-z0-9]{16}\/(?:photos|chat)$/;
const photoJson = express.json({ limit: '4mb' });
const chatJson = express.json({ limit: '512kb' });
const smallJson = express.json({ limit: '64kb' });
app.use((req, res, next) => (req.method === 'POST' && BIG_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'insidejoke',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Inside Joke',
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

// Never put a model call behind a sign-in alone: it goes through the budget
// and the free tier's daily ceiling as well.
const spend = [identity.requireUser, identity.requireBudget, identity.requireDailyCap];
const user = identity.requireUser;

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

const httpError = G.httpError;

// Only the app's own errors (marked `expose`) reach the client with their
// status and words. Anything else is logged - its stack's first lines only,
// never a body: a name, a message or a photo is nobody's business - and
// answered with the route's fallback. An upstream failure is a 502, or 503
// when the provider is overloaded or rate-limited.
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - writing your own questions is free meanwhile.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}

/* ------------------------------------------------------------------ *
 * Limits, per address, in memory (per instance: they slow a script, they
 * do not stop a determined one - CLAUDE.md says so)
 * ------------------------------------------------------------------ */

function ipKey(req) {
  const ip = identityLib.clientIp(req);
  if (ip.includes(':') && !ip.includes('.')) return ip.split(':').slice(0, 4).join(':');
  return ip;
}
const newMembers = identityLib.createLimiter({ max: G.LIMITS.newMembersPerIp, windowMs: G.LIMITS.newMembersWindowMs });
const writes = identityLib.createLimiter({ max: G.LIMITS.writesPerIp, windowMs: G.LIMITS.writesWindowMs });

// A wrong code is counted once per DISTINCT code: a phone polling a rotated
// code is not guessing. Guessing needs many different codes.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > G.LIMITS.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, code) {
  const e = missState(ip);
  e.seen.add(code);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
const blockedByMisses = (ip) => missState(ip).seen.size >= G.LIMITS.missesPerIp;
function wrote(req) { if (!writes.hit(ipKey(req))) throw httpError(429, 'That’s a lot of taps from here. Wait a minute and try again.'); }

/* ------------------------------------------------------------------ *
 * The browser's key: one random value per browser, HttpOnly, scoped to this
 * app's path. Never stored - each group keeps sha256(key + group id).
 * ------------------------------------------------------------------ */

const KEY_COOKIE = 'ij_k';
function readKey(req) {
  const m = /(?:^|;\s*)ij_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintKey(req, res) {
  const have = readKey(req);
  if (have) return have;
  const key = G.newKey();
  res.append('Set-Cookie', `${KEY_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 400}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}
function tagOf(req) {
  const secret = SECRET();
  return req.user && secret ? G.acctTag(req.user.id, secret) : null;
}
function needTag(req) {
  const t = tagOf(req);
  if (!t) throw httpError(SECRET() ? 401 : 503, SECRET() ? 'Sign in first.' : 'Groups are switched off on this server right now.');
  return t;
}

const NOT_HERE = 'No group here - ask whoever invited you for the link again.';

/** The group and who is asking, or the 404 a stranger gets for a group that
 *  does not exist. */
async function loadGroup(req) {
  const gid = String(req.params.gid || '');
  const doc = G.isId(gid) ? await store.get('groups', gid) : null;
  if (!doc) throw httpError(404, NOT_HERE);
  delete doc.id;
  doc.id = gid;
  const key = readKey(req);
  const actor = G.actorOf(doc, { hash: key ? G.keyHash(key, gid) : null, tag: tagOf(req) });
  if (!actor.member) throw httpError(404, NOT_HERE);
  return { doc, actor };
}
async function loadHost(req) {
  const g = await loadGroup(req);
  if (!g.actor.host) throw httpError(g.actor.member ? 403 : 404, g.actor.member ? 'Only the host can do that.' : NOT_HERE);
  return g;
}

/** One change to the group document, as a transaction. */
async function changeGroup(req, fn) {
  wrote(req);
  const { doc: first } = await loadGroup(req);
  const gid = first.id;
  let out = {};
  let actor = null;
  const saved = await store.transact('groups', gid, (cur) => {
    if (!cur) throw httpError(404, NOT_HERE);
    const doc = { ...cur, id: gid };
    const key = readKey(req);
    actor = G.actorOf(doc, { hash: key ? G.keyHash(key, gid) : null, tag: tagOf(req) });
    if (!actor.member) throw httpError(404, NOT_HERE);
    out = fn(doc, actor) || {};
    if (out.remove) return null;
    return doc;
  });
  if (!saved) return { removed: true, ...out };
  const a2 = G.actorOf(saved, { hash: readKey(req) ? G.keyHash(readKey(req), gid) : null, tag: tagOf(req) });
  return { group: G.groupView(saved, a2, Core.dayIn(saved.tz, Date.now())), ...out };
}

const today = (doc) => Core.dayIn(doc.tz, Date.now());

/** Membership for the metered routes, after the spend gates and before the
 *  big parser: a stranger's body is never read, and a group id that is not
 *  yours costs nothing. */
function memberGate(req, res, next) {
  loadGroup(req).then((g) => { req.group = g; next(); }, (err) => fail(res, err));
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: { ...Core.LIMITS, groupsPerHost: G.LIMITS.groupsPerHost, timers: G.LIMITS.timers, liveCounts: G.LIMITS.liveCounts }, colors: Core.COLORS, emoji: Core.EMOJI });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier });
});

/* ------------------------------------------------------------------ *
 * Joining by code (no account)
 * ------------------------------------------------------------------ */

async function groupByCode(req) {
  const ip = ipKey(req);
  if (blockedByMisses(ip)) throw httpError(429, 'Too many wrong codes from here. Try again in a few minutes.');
  const code = G.normalizeCode(req.params.code);
  const map = G.isCode(code) ? await store.get('codes', code) : null;
  const doc = map && G.isId(map.gid) ? await store.get('groups', map.gid) : null;
  if (!doc || doc.code !== code) {
    missed(ip, code);
    throw httpError(404, 'No group has that code. Check it with whoever invited you - the host can see it under Invite.');
  }
  doc.id = map.gid;
  return doc;
}

/** What a join link shows before you join: the group's name and who is in
 *  it (names and emoji). The code is the key; this is what it opens. */
app.get('/api/code/:code', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const doc = await groupByCode(req);
    const key = readKey(req);
    const actor = G.actorOf(doc, { hash: key ? G.keyHash(key, doc.id) : null, tag: tagOf(req) });
    res.json({ gid: doc.id, name: doc.name, members: doc.members.map((m) => ({ name: m.name, emoji: m.emoji, color: m.color })), full: doc.members.length >= G.LIMITS.members, member: Boolean(actor.member) });
  } catch (err) { fail(res, err); }
});

app.post('/api/code/:code/join', async (req, res) => {
  try {
    wrote(req);
    const b = req.body || {};
    const ip = ipKey(req);
    const doc = await groupByCode(req);
    const tag = tagOf(req);
    const key0 = readKey(req);
    const already = doc.members.some((m) => (key0 && m.keyHash === G.keyHash(key0, doc.id)) || (tag && m.acct === tag));
    if (!already && newMembers.blocked(ip)) throw httpError(429, 'Too many new members from here. Try again later.');
    const key = mintKey(req, res);
    const hash = G.keyHash(key, doc.id);
    let r = null;
    await store.transact('groups', doc.id, (cur) => {
      if (!cur || cur.code !== doc.code) throw httpError(404, 'That code was just changed. Ask for the new one.');
      const d = { ...cur };
      delete d.id;
      r = G.join(d, { hash, tag, name: b.name, emoji: b.emoji, color: b.color }, Date.now());
      return d;
    });
    if (r.isNew) newMembers.hit(ip);
    res.json({ gid: doc.id, me: r.mid, isNew: r.isNew });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Groups: a host with a free account makes one
 * ------------------------------------------------------------------ */

app.post('/api/groups', user, async (req, res) => {
  try {
    wrote(req);
    const tag = needTag(req);
    const b = req.body || {};
    const mine = await store.list('groups', { where: [['ownerTag', '==', tag]], limit: G.LIMITS.groupsPerHost + 1 });
    if (mine.length >= G.LIMITS.groupsPerHost) throw httpError(409, `You can run ${G.LIMITS.groupsPerHost} groups at once. Delete one first.`);
    let code = null;
    for (let i = 0; i < 8 && !code; i++) { const c = G.newCode(); if (!(await store.get('codes', c))) code = c; }
    if (!code) throw httpError(503, 'Could not make a join code. Try again.');
    const gid = G.newId();
    const key = mintKey(req, res);
    const doc = G.createGroup({ gid, code, name: b.name, tz: b.tz, host: b.host || {}, tag, hash: G.keyHash(key, gid), now: Date.now() });
    const { id: _drop, ...data } = doc;
    await store.transact('codes', code, (cur) => { if (cur) throw httpError(409, 'That code was just taken. Try again.'); return { gid }; });
    await store.set('groups', gid, data);
    await store.set('boards', gid, G.newBoard(gid));
    const actor = G.actorOf(doc, { hash: G.keyHash(key, gid), tag });
    res.json({ group: G.groupView(doc, actor, today(doc)) });
  } catch (err) { fail(res, err, 'Could not make the group.'); }
});

/** The groups this account has a seat in. (A browser's other groups are in
 *  its own storage; the page asks for each.) */
app.get('/api/groups', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const tag = needTag(req);
    const rows = await store.list('groups', { where: [['accountTags', 'array-contains', tag]], limit: 50 });
    res.json({ groups: rows.map((d) => ({ id: d.id, name: d.name, members: d.members.length, host: d.ownerTag === tag, emoji: d.members.slice(0, 5).map((m) => m.emoji) })) });
  } catch (err) { fail(res, err); }
});

app.get('/api/groups/:gid', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { doc, actor } = await loadGroup(req);
    const since = Number(req.query.since);
    if (Number.isInteger(since) && since === (doc.v || 0)) return res.json({ same: true, v: doc.v || 0 });
    const live = await store.get('lives', doc.id);
    const view = G.groupView(doc, actor, today(doc));
    view.live = live && !(Date.now() - live.updatedAt > G.LIMITS.liveIdleMs) ? { state: live.state } : null;
    res.json({ group: view });
  } catch (err) { fail(res, err); }
});

app.post('/api/groups/:gid/link', user, async (req, res) => {
  try {
    const tag = needTag(req);
    res.json(await changeGroup(req, (d, a) => { G.link(d, a, tag, Date.now()); }));
  } catch (err) { fail(res, err); }
});

app.post('/api/groups/:gid/me', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await changeGroup(req, (d, a) => { G.editMember(d, a, { mid: typeof b.mid === 'string' ? b.mid : null, name: b.name, emoji: b.emoji, color: b.color }, Date.now()); }));
  } catch (err) { fail(res, err); }
});

app.delete('/api/groups/:gid/members/:mid', async (req, res) => {
  try {
    const mid = String(req.params.mid);
    const out = await changeGroup(req, (d, a) => { G.removeMember(d, a, mid, Date.now()); });
    await store.transact('boards', req.params.gid, (b) => { if (!b) return undefined; const x = { ...b }; delete x.id; G.dropMember(x, mid); return x; });
    res.json(out);
  } catch (err) { fail(res, err); }
});

app.put('/api/groups/:gid', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await changeGroup(req, (d, a) => { G.settings(d, a, { name: b.name, tz: b.tz }, Date.now()); }));
  } catch (err) { fail(res, err); }
});

/** A new join code; the old one stops working at once. Members already in
 *  are not affected - they come back by the group's own link. */
app.post('/api/groups/:gid/code', async (req, res) => {
  try {
    wrote(req);
    const { doc } = await loadHost(req);
    let code = null;
    for (let i = 0; i < 8 && !code; i++) { const c = G.newCode(); if (!(await store.get('codes', c))) code = c; }
    if (!code) throw httpError(503, 'Could not make a code. Try again.');
    await store.transact('codes', code, (cur) => { if (cur) throw httpError(409, 'Try again.'); return { gid: doc.id }; });
    const old = doc.code;
    const out = await changeGroup(req, (d, a) => { G.need(a.host, 403, 'Only the host can do that.'); d.code = code; G.touch(d, Date.now()); });
    await store.remove('codes', old);
    res.json(out);
  } catch (err) { fail(res, err); }
});

/** Delete the group and everything in it: members, questions, photos,
 *  rounds, the board and any live game. */
app.delete('/api/groups/:gid', async (req, res) => {
  try {
    wrote(req);
    const { doc } = await loadHost(req);
    const gid = doc.id;
    for (const col of ['questions', 'photos', 'rounds']) {
      for (;;) {
        const rows = await store.list(col, { where: [['gid', '==', gid]], limit: 200 });
        if (!rows.length) break;
        for (const r of rows) await store.remove(col, r.id);
      }
    }
    await store.remove('boards', gid);
    await store.remove('lives', gid);
    await store.remove('codes', doc.code);
    await store.remove('groups', gid);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Could not delete the group. Try again.'); }
});

/* ------------------------------------------------------------------ *
 * The daily round
 * ------------------------------------------------------------------ */

/** Today's round document, drawn the first time anyone asks for it. */
async function roundFor(doc) {
  const date = today(doc);
  const rid = G.roundId(doc.id, date);
  const have = await store.get('rounds', rid);
  if (have) return have;
  const board = (await store.get('boards', doc.id)) || G.newBoard(doc.id);
  const ids = Core.pickRound(G.bankList(board), doc.id, date, board.used || {});
  if (!ids.length) return null;
  const qs = [];
  for (const id of ids) { const q = await store.get('questions', id); if (q && q.gid === doc.id && q.status === 'live') qs.push(q); }
  if (!qs.length) return null;
  let created = false;
  const round = await store.transact('rounds', rid, (cur) => { if (cur) return undefined; created = true; return G.newRound(doc.id, date, qs); });
  if (created) {
    await store.transact('boards', doc.id, (b) => { const x = b ? { ...b } : G.newBoard(doc.id); delete x.id; G.markUsed(x, qs.slice(0, Core.LIMITS.daily).map((q) => q.id), date); return x; });
  }
  return round;
}

app.get('/api/groups/:gid/today', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { doc, actor } = await loadGroup(req);
    const round = await roundFor(doc);
    if (!round) return res.json({ empty: true, date: today(doc), label: Core.dateLabel(today(doc)), closesInMs: Core.msToMidnight(doc.tz, Date.now()) });
    const since = Number(req.query.since);
    if (Number.isInteger(since) && since === (round.v || 0)) return res.json({ same: true, v: round.v || 0 });
    res.json(G.roundView(round, doc, actor, Date.now()));
  } catch (err) { fail(res, err); }
});

app.post('/api/groups/:gid/today', async (req, res) => {
  try {
    wrote(req);
    const b = req.body || {};
    const { doc, actor } = await loadGroup(req);
    const date = today(doc);
    if (b.date && b.date !== date) throw httpError(409, 'That round closed at midnight. Here’s today’s.', { code: 'closed' });
    const round0 = await roundFor(doc);
    if (!round0) throw httpError(404, 'There’s no round today - add some questions first.');
    let result = null;
    const saved = await store.transact('rounds', G.roundId(doc.id, date), (cur) => {
      if (!cur) throw httpError(409, 'That round closed. Here’s today’s.', { code: 'closed' });
      const r = { ...cur };
      delete r.id;
      // Only ever as yourself: the member comes from the cookie or the
      // account, never from the request body.
      result = G.answerDaily(r, actor.member, { qid: String(b.qid || ''), a: b.a, from: b.from }, Date.now());
      return r;
    });
    if (result.finished) {
      await store.transact('boards', doc.id, (cur) => { const x = cur ? { ...cur } : G.newBoard(doc.id); delete x.id; G.recordDay(x, date, actor.mid, result.score, result.of); return x; });
    }
    res.json(G.roundView(saved, doc, actor, Date.now()));
  } catch (err) { fail(res, err); }
});

app.get('/api/groups/:gid/board', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { doc, actor } = await loadGroup(req);
    const board = (await store.get('boards', doc.id)) || G.newBoard(doc.id);
    const t = today(doc);
    const lb = Core.leaderboard(board, doc.members, t);
    const mine = lb.rows.find((r) => r.id === actor.mid) || null;
    res.json({ today: t, week: lb.week, month: lb.month, all: lb.all, me: mine, waiting: lb.rows.filter((r) => !r.playedToday).map((r) => ({ id: r.id, name: r.name, emoji: r.emoji })) });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The question bank
 * ------------------------------------------------------------------ */

function ownView(q) {
  return { id: q.id, status: q.status, source: q.source, kind: q.kind, style: q.style, label: Core.STYLE_LABEL[q.style], prompt: q.prompt, quote: q.quote, options: q.options, members: q.members, answer: q.answer, tolerance: q.tolerance, unit: q.unit, photoId: q.photoId, createdAt: q.createdAt };
}

async function adjustCounts(gid, dq, dp) {
  await store.transact('groups', gid, (cur) => {
    if (!cur) return undefined;
    const d = { ...cur };
    delete d.id;
    d.questionCount = Math.max(0, (d.questionCount || 0) + dq);
    d.photoCount = Math.max(0, (d.photoCount || 0) + dp);
    return d;
  });
}

/** Save questions: cleaned, given ids, counted. Live ones join the board's
 *  index of the bank; drafts wait for their author's review. */
async function saveQuestions(doc, actor, list, { status, source }) {
  if ((doc.questionCount || 0) + list.length > Core.LIMITS.questions) throw httpError(409, `A group can hold ${Core.LIMITS.questions} questions. Delete some old ones first.`);
  const now = new Date().toISOString();
  const saved = [];
  for (const q of list) {
    const id = G.newId();
    const row = { ...q, gid: doc.id, status, source, createdBy: actor.mid, createdAt: now };
    await store.set('questions', id, row);
    saved.push({ id, ...row });
  }
  if (status === 'live') await store.transact('boards', doc.id, (cur) => { const x = cur ? { ...cur } : G.newBoard(doc.id); delete x.id; for (const q of saved) G.bankAdd(x, q); return x; });
  await adjustCounts(doc.id, saved.length, 0);
  return saved;
}

app.get('/api/groups/:gid/questions', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { doc, actor } = await loadGroup(req);
    const board = (await store.get('boards', doc.id)) || G.newBoard(doc.id);
    const bank = G.bankList(board);
    const counts = { photo: 0, chat: 0, own: 0, live: bank.length };
    for (const q of bank) counts[Core.family(q.style)]++;
    const rows = await store.list('questions', { where: [['gid', '==', doc.id]], limit: Core.LIMITS.questions + 50 });
    // Your own questions with their answers (you wrote them); the host also
    // sees everyone's prompts - never their answers - to tidy the bank.
    const mine = rows.filter((q) => q.createdBy === actor.mid).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(ownView);
    const names = Object.fromEntries(doc.members.map((m) => [m.id, m.name]));
    const others = actor.host ? rows.filter((q) => q.createdBy !== actor.mid && q.status === 'live').map((q) => ({ id: q.id, style: q.style, label: Core.STYLE_LABEL[q.style], prompt: q.prompt, photoId: q.photoId, by: names[q.createdBy] || 'Someone who left' })) : null;
    res.json({ counts, mine, others });
  } catch (err) { fail(res, err); }
});

/** Write your own (free), or save the free questions the page computed
 *  from a chat export. Both are live at once: the author reviewed them. */
app.post('/api/groups/:gid/questions', async (req, res) => {
  try {
    wrote(req);
    const b = req.body || {};
    const { doc, actor } = await loadGroup(req);
    const raw = Array.isArray(b.questions) ? b.questions : [];
    if (!raw.length) throw httpError(400, 'Add a question first.');
    if (raw.length > G.LIMITS.questionsPerPost) throw httpError(400, `Up to ${G.LIMITS.questionsPerPost} at a time.`);
    const source = b.source === 'chat' ? 'chat' : 'own';
    const allowed = source === 'chat' ? ['chat_stat'] : ['own', 'own_tf', 'own_number', 'own_who'];
    const clean = raw.map((r) => (r && allowed.includes(r.style) ? Core.cleanQuestion(r, { members: doc.members }) : null));
    const bad = clean.findIndex((q) => !q);
    if (bad >= 0) throw httpError(400, raw.length > 1 ? `Question ${bad + 1} needs a prompt and at least two different answers, with the right one marked.` : 'That question needs a prompt and at least two different answers, with the right one marked.');
    const saved = await saveQuestions(doc, actor, clean, { status: 'live', source });
    res.json({ saved: saved.map(ownView) });
  } catch (err) { fail(res, err, 'Could not save the questions.'); }
});

async function ownQuestion(req, { hostToo } = {}) {
  const { doc, actor } = await loadGroup(req);
  const qid = String(req.params.qid || '');
  const q = G.isId(qid) ? await store.get('questions', qid) : null;
  if (!q || q.gid !== doc.id) throw httpError(404, 'That question is gone.');
  if (q.createdBy !== actor.mid && !(hostToo && actor.host)) throw httpError(q.status === 'draft' ? 404 : 403, q.status === 'draft' ? 'That question is gone.' : 'Only whoever wrote it can change it.');
  return { doc, actor, q: { ...q, id: qid } };
}

app.put('/api/groups/:gid/questions/:qid', async (req, res) => {
  try {
    wrote(req);
    const { doc, q } = await ownQuestion(req);
    const b = (req.body || {}).question || {};
    // The facts that make a photo question right are not editable here:
    // where-answers stay the typed place, who-took stays the uploader.
    const merged = { ...b, style: q.style, photoId: q.photoId, aboutName: q.aboutName };
    if (q.style === 'who_said') { merged.quote = q.quote; merged.options = q.options; merged.answer = q.answer; }
    if (q.style === 'who_took' || q.style === 'when' || q.style === 'where') { merged.members = q.members; merged.options = q.options; merged.answer = q.answer; merged.tolerance = q.tolerance; }
    if (q.kind === 'number' && q.style === 'chat_stat') { merged.kind = 'number'; merged.answer = q.answer; merged.tolerance = q.tolerance; merged.unit = q.unit; }
    const clean = Core.cleanQuestion(merged, { members: doc.members, allowNoPhoto: !q.photoId });
    if (!clean) throw httpError(400, 'That question needs a prompt and at least two different answers, with the right one marked.');
    const row = { ...q, ...clean };
    delete row.id;
    await store.set('questions', q.id, row);
    res.json({ question: ownView({ id: q.id, ...row }) });
  } catch (err) { fail(res, err); }
});

/** A member's reviewed drafts join the bank. */
app.post('/api/groups/:gid/questions/publish', async (req, res) => {
  try {
    wrote(req);
    const { doc, actor } = await loadGroup(req);
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.filter(G.isId).slice(0, 50) : [];
    const done = [];
    for (const id of ids) {
      const q = await store.get('questions', id);
      if (!q || q.gid !== doc.id || q.createdBy !== actor.mid || q.status !== 'draft') continue;
      await store.merge('questions', id, { status: 'live' });
      done.push({ ...q, id });
    }
    if (done.length) await store.transact('boards', doc.id, (cur) => { const x = cur ? { ...cur } : G.newBoard(doc.id); delete x.id; for (const q of done) G.bankAdd(x, q); return x; });
    res.json({ published: done.length });
  } catch (err) { fail(res, err); }
});

app.delete('/api/groups/:gid/questions/:qid', async (req, res) => {
  try {
    wrote(req);
    const { doc, q } = await ownQuestion(req, { hostToo: true });
    await store.remove('questions', q.id);
    await store.transact('boards', doc.id, (cur) => { if (!cur) return undefined; const x = { ...cur }; delete x.id; G.bankRemove(x, [q.id]); return x; });
    await adjustCounts(doc.id, -1, 0);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Photos: thumbnails served to members only
 * ------------------------------------------------------------------ */

app.get('/api/groups/:gid/photos/:pid', async (req, res) => {
  try {
    const { doc } = await loadGroup(req);
    const pid = String(req.params.pid || '');
    const p = G.isId(pid) ? await store.get('photos', pid) : null;
    if (!p || p.gid !== doc.id) throw httpError(404, 'That photo is gone.');
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Type', 'image/jpeg');
    res.set('Content-Disposition', 'inline');
    res.send(Buffer.from(p.thumb, 'base64'));
  } catch (err) { fail(res, err); }
});

/** Delete a photo and every question made from it (its uploader or the host). */
app.delete('/api/groups/:gid/photos/:pid', async (req, res) => {
  try {
    wrote(req);
    const { doc, actor } = await loadGroup(req);
    const pid = String(req.params.pid || '');
    const p = G.isId(pid) ? await store.get('photos', pid) : null;
    if (!p || p.gid !== doc.id) throw httpError(404, 'That photo is gone.');
    if (p.by !== actor.mid && !actor.host) throw httpError(403, 'Only whoever added it (or the host) can delete it.');
    const qs = (await store.list('questions', { where: [['gid', '==', doc.id]], limit: Core.LIMITS.questions + 50 })).filter((q) => q.photoId === pid);
    for (const q of qs) await store.remove('questions', q.id);
    await store.remove('photos', pid);
    await store.transact('boards', doc.id, (cur) => { if (!cur) return undefined; const x = { ...cur }; delete x.id; G.bankRemove(x, qs.map((q) => q.id)); return x; });
    await adjustCounts(doc.id, -qs.length, -1);
    res.json({ ok: true, removed: qs.length });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Metered: questions from a photo, and from a chat excerpt
 * ------------------------------------------------------------------ */

/**
 * Gates, membership, then the 4 MB parser, then the checks (400s cost
 * nothing) - and only then the whitespace stream, after which a failure is
 * a 200 {error}. The model's copy of the photo is read once and dropped;
 * only the thumbnail and the questions (as drafts) are stored.
 */
app.post('/api/groups/:gid/photos', ...spend, memberGate, photoJson, async (req, res) => {
  const { doc, actor } = req.group;
  let thumb; let image; let facts;
  try {
    wrote(req);
    const b = req.body || {};
    if ((doc.photoCount || 0) >= Core.LIMITS.photos) throw httpError(409, `A group can hold ${Core.LIMITS.photos} photos. Delete some old ones first.`);
    thumb = photo.thumbnail(b.thumb);
    image = photo.forModel(b.image);
    const year = Number.isInteger(b.year) && b.year >= 1900 && b.year <= new Date().getUTCFullYear() ? b.year : null;
    const place = Core.clean(b.place, Core.LIMITS.place) || null;
    const hint = Core.clean(b.hint, Core.LIMITS.hint);
    facts = { year, place, hint, uploader: actor.member, members: doc.members, photoId: G.newId() };
    facts.seed = facts.photoId;
  } catch (err) { return fail(res, err); }
  const send = streamedJson(res);
  try {
    const raw = await ai.photoQuestions(await clientFor(req), modelFor(req), image, facts);
    const qs = ai.cleanPhotoQuestions(raw, facts);
    if (!qs.length) throw httpError(422, 'No fair questions came out of that one. Try another photo, or add a hint like “Lake Lanier, 2019, Dad’s birthday”.');
    await store.set('photos', facts.photoId, { gid: doc.id, by: actor.mid, thumb: thumb.data, bytes: thumb.bytes, width: thumb.width, height: thumb.height, createdAt: new Date().toISOString() });
    await adjustCounts(doc.id, 0, 1);
    const saved = await saveQuestions(doc, actor, qs, { status: 'draft', source: 'photo' });
    send({ photo: { id: facts.photoId }, questions: saved.map(ownView) });
  } catch (err) { send(failure(err, 'That photo could not be read. Try again in a minute.').body); }
});

/**
 * The "who said it?" round: the page sends a sampled excerpt (names kept,
 * phone numbers, emails and links already stripped - and stripped again
 * here). Each quote must be an exact substring of it; the speaker is read
 * from the excerpt. The excerpt is never stored; the questions are drafts.
 */
app.post('/api/groups/:gid/chat', ...spend, memberGate, chatJson, async (req, res) => {
  const { doc, actor } = req.group;
  let excerpt;
  try {
    wrote(req);
    excerpt = Core.cleanExcerpt((req.body || {}).excerpt);
    if (excerpt.length < 20) throw httpError(400, 'That chat is too short for a “who said it?” round - it needs at least 20 messages.');
    if (new Set(excerpt.map((l) => l.n)).size < 2) throw httpError(400, 'A “who said it?” round needs at least two people in the chat.');
  } catch (err) { return fail(res, err); }
  const send = streamedJson(res);
  try {
    const raw = await ai.chatQuestions(await clientFor(req), modelFor(req), excerpt);
    const qs = ai.cleanChatQuestions(raw, excerpt, `${doc.id}|${Date.now()}`);
    if (!qs.length) throw httpError(422, 'No quotes could be checked against the chat. Try again, or use the free chat stats.');
    const saved = await saveQuestions(doc, actor, qs, { status: 'draft', source: 'chat-ai' });
    send({ questions: saved.map(ownView) });
  } catch (err) { send(failure(err, 'The chat could not be read. Try again in a minute - the free chat stats still work.').body); }
});

/* ------------------------------------------------------------------ *
 * Live game night
 * ------------------------------------------------------------------ */

async function liveOf(gid) {
  const live = await store.get('lives', gid);
  if (!live) return null;
  if (Date.now() - live.updatedAt > G.LIMITS.liveIdleMs) { await store.remove('lives', gid); return null; }
  return live;
}

/** One change to the live game, as a transaction - with any timer moves
 *  that fell due applied first, as of when they were due. */
async function changeLive(gid, fn) {
  return store.transact('lives', gid, (cur) => {
    if (!cur) throw httpError(404, 'No game is running. The host can start one.');
    const l = { ...cur };
    delete l.id;
    const moved = G.liveAdvanceDue(l, Date.now());
    if (fn(l) === false && !moved) return undefined;
    return l;
  });
}

app.get('/api/groups/:gid/live', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { doc, actor } = await loadGroup(req);
    let live = await liveOf(doc.id);
    if (!live) return res.json({ none: true, serverNow: Date.now() });
    const probe = { ...live };
    if (G.liveAdvanceDue(probe, Date.now())) live = await changeLive(doc.id, () => true);
    const since = Number(req.query.since);
    if (Number.isInteger(since) && since === (live.v || 0)) return res.json({ same: true, v: live.v || 0, serverNow: Date.now() });
    res.json(G.liveView(live, doc, actor, Date.now()));
  } catch (err) { fail(res, err); }
});

app.post('/api/groups/:gid/live', async (req, res) => {
  try {
    wrote(req);
    const { doc, actor } = await loadHost(req);
    const b = req.body || {};
    const count = G.LIMITS.liveCounts.includes(b.count) ? b.count : 10;
    const seconds = G.LIMITS.timers.includes(b.seconds) ? b.seconds : 20;
    const fams = Array.isArray(b.families) ? b.families.filter((f) => ['photo', 'chat', 'own'].includes(f)) : [];
    const cur = await liveOf(doc.id);
    if (cur && cur.state !== 'podium') throw httpError(409, 'A game is already running. End it first.');
    const board = (await store.get('boards', doc.id)) || G.newBoard(doc.id);
    const pool = G.bankList(board).filter((q) => !fams.length || fams.includes(Core.family(q.style)));
    if (!pool.length) throw httpError(409, 'There are no questions of those kinds yet. Add some first.');
    const order = Core.shuffled(pool.sort((x, y) => (x.id < y.id ? -1 : 1)), Core.rng(`${doc.id}|live|${Date.now()}`));
    const qs = [];
    for (const r of order) {
      if (qs.length >= count) break;
      const q = await store.get('questions', r.id);
      if (q && q.gid === doc.id && q.status === 'live') qs.push({ ...q, id: r.id });
    }
    const live = G.newLive(doc.id, { qs, seconds, by: actor.mid, now: Date.now() });
    G.liveJoin(live, actor.mid, Date.now());
    await store.set('lives', doc.id, live);
    res.json(G.liveView(live, doc, actor, Date.now()));
  } catch (err) { fail(res, err, 'Could not start the game.'); }
});

app.post('/api/groups/:gid/live/join', async (req, res) => {
  try {
    wrote(req);
    const { doc, actor } = await loadGroup(req);
    const saved = await changeLive(doc.id, (l) => { G.liveJoin(l, actor.mid, Date.now()); });
    res.json(G.liveView(saved, doc, actor, Date.now()));
  } catch (err) { fail(res, err); }
});

app.post('/api/groups/:gid/live/next', async (req, res) => {
  try {
    wrote(req);
    const { doc, actor } = await loadHost(req);
    const idx = (req.body || {}).idx;
    const saved = await changeLive(doc.id, (l) => {
      // A double tap (or two host devices) must not skip a question: the
      // press names the question it meant to move on from.
      if (Number.isInteger(idx) && idx !== l.idx) return false;
      G.liveNext(l, Date.now());
    });
    res.json(G.liveView(saved, doc, actor, Date.now()));
  } catch (err) { fail(res, err); }
});

app.post('/api/groups/:gid/live/answer', async (req, res) => {
  try {
    wrote(req);
    const b = req.body || {};
    const { doc, actor } = await loadGroup(req);
    const saved = await changeLive(doc.id, (l) => { G.liveAnswer(l, actor.mid, { idx: b.idx, a: b.a }, Date.now()); });
    res.json(G.liveView(saved, doc, actor, Date.now()));
  } catch (err) { fail(res, err); }
});

app.delete('/api/groups/:gid/live', async (req, res) => {
  try {
    wrote(req);
    const { doc } = await loadHost(req);
    await store.remove('lives', doc.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A group link (g/<id>) and a join link (j/<code>) are the same single-page
// app served one level down. <base href="../"> makes every relative asset
// and API path in it resolve against the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function deepIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get(['/g/:id', '/j/:code'], (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(deepIndex());
});
app.all(['/g/:id', '/j/:code'], (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Never log a parse error's message: V8 quotes the start of the body in it.
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once. Try one photo, or a shorter chat.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // INSIDEJOKE_DEV_MOUNT=/insidejoke runs it the way the lab host does:
  // mounted under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.INSIDEJOKE_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`insidejoke listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
