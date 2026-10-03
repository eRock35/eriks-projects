// Flight - a beer crew's game night: blind-tasting showdowns, "guess who
// brought it", a Same-Can Challenge for a crew spread across cities, a vote
// on the next brewery, and a crew leaderboard. See CLAUDE.md.
//
// A model is used for ONE thing, metered and signed in: reading a can or
// bottle label from a photo. Everything else is public/flight-core.js and
// free. A crew's host needs a free account (so the crew is theirs to run and
// delete); members join by link, QR or code with a name and an emoji and no
// account, and never trigger a model call unless they sign in to snap.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/flight-core');
const K = require('./lib/crews');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const hopscotch = require('./lib/hopscotch');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.FLIGHT_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('FLIGHT_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. Both read photos.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A join code and a crew id are keys. They must not ride out in a Referer
  // header, and a crew page should never be indexed.
  if (/^\/(c|j)\//.test(req.path) || /^\/api\/(crews|join)\//.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// One route carries more than 64 KB - snapping a label - and it mounts its
// own 6 MB parser AFTER sign-in, budget and the daily cap, so a stranger's
// body is never read.
const SNAP_ROUTE = /^\/api\/snap$/;
const snapJson = express.json({ limit: '6mb' });
const smallJson = express.json({ limit: '64kb' });
app.use((req, res, next) => (SNAP_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'flight',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Flight',
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
 * Errors: only the app's own (marked `expose`) reach the page in their own
 * words. Anything else is logged - the first lines of its stack, never a
 * body: names, notes and photos are nobody's business - and answered with
 * the route's fallback. A provider error is a 502, or 503 when it is busy.
 * ------------------------------------------------------------------ */

const httpError = K.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - or type the beer in, which is free.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/* ------------------------------------------------------------------ *
 * Limits, per address, in memory (per instance: they slow a script, they
 * do not stop a determined one - CLAUDE.md says so)
 * ------------------------------------------------------------------ */

function ipKey(req) {
  const ip = identityLib.clientIp(req);
  if (ip.includes(':') && !ip.includes('.')) return ip.split(':').slice(0, 4).join(':'); // IPv6 by its /64
  return ip;
}
const newMembers = identityLib.createLimiter({ max: K.LIMITS.newMembersPerIp, windowMs: K.LIMITS.newMembersWindowMs });
const writes = identityLib.createLimiter({ max: K.LIMITS.writesPerIp, windowMs: K.LIMITS.writesWindowMs });

// A wrong code or crew id counts once per DISTINCT value: a phone left open
// on a deleted crew polls the same dead id every few seconds, and that is
// not guessing. Guessing needs many different codes.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > K.LIMITS.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, what) {
  const e = missState(ip);
  e.seen.add(what);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
const blockedByMisses = (ip) => missState(ip).seen.size >= K.LIMITS.missesPerIp;
function checkMisses(req) {
  if (blockedByMisses(ipKey(req))) throw httpError(429, 'Too many wrong codes from here. Try again in a few minutes.');
}
function countWrite(req) {
  if (!writes.hit(ipKey(req))) throw httpError(429, 'That’s a lot of taps from here. Wait a minute and try again.');
}

/* ------------------------------------------------------------------ *
 * Who is asking. A member is this browser (an HttpOnly key, stored only as
 * sha256(key + crew id)) or a signed-in account that kept its seat (an
 * HMAC tag). The host is the account that made the crew.
 * ------------------------------------------------------------------ */

const KEY_COOKIE = 'flight_k';
function readKey(req) {
  const m = /(?:^|;\s*)flight_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintKey(req, res) {
  const have = readKey(req);
  if (have) return have;
  const key = K.newKey();
  res.append('Set-Cookie', `${KEY_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}
function tagOf(req) {
  if (!req.user) return null;
  const secret = SECRET();
  return secret ? K.acctTag(req.user.id, secret) : null;
}
function tagFor(req) {
  const tag = tagOf(req);
  if (!tag) throw httpError(503, 'Crews are switched off on this server right now.');
  return tag;
}

/** {mid, host} for this request in this crew. */
function actorOf(req, crew) {
  const tag = tagOf(req);
  const key = readKey(req);
  const hash = key ? K.keyHash(key, crew.id) : null;
  const m = (hash && crew.members.find((x) => x.keyHash === hash)) || (tag && crew.members.find((x) => x.acct === tag)) || null;
  return { mid: m ? m.id : null, host: Boolean(m && m.host && tag && crew.ownerTag === tag && m.acct === tag) };
}

/** Delete a crew and everything in it: its sessions, polls, cellars and
 *  swaps first. */
async function purgeCrew(id) {
  for (const c of ['sessions', 'polls', 'cellars', 'swaps']) {
    for (const d of await store.list(c, { where: [['crewId', '==', id]] })) await store.remove(c, d.id);
  }
  await store.remove('crews', id);
}

/** The crew, if the id names a live one. A crew nobody has touched in 180
 *  days is deleted by the read that finds it (there is no timer). */
async function loadCrew(req) {
  checkMisses(req);
  const id = String(req.params.cid || '');
  const doc = K.isCrewId(id) ? await store.get('crews', id) : null;
  if (!doc) { missed(ipKey(req), `c:${id.slice(0, 20)}`); throw httpError(404, 'No crew here.'); }
  if (K.idle(doc, Date.now())) { await purgeCrew(doc.id); throw httpError(404, 'This crew closed after six months with nothing new.', { code: 'expired' }); }
  return doc;
}
/** The crew and who is asking - and a stranger gets the same 404 a crew
 *  that does not exist gets, so nobody learns a crew id is real. */
async function memberCrew(req) {
  const crew = await loadCrew(req);
  const actor = actorOf(req, crew);
  if (!actor.mid) throw httpError(404, 'No crew here.');
  return { crew, actor };
}
const bumpCrew = (id) => store.bump('crews', id, { v: 1 }, { mustExist: true });

/** One change to the crew document, as a transaction. */
async function crewChange(req, fn) {
  countWrite(req);
  const { crew } = await memberCrew(req);
  let out = {};
  let actor = null;
  const saved = await store.transact('crews', crew.id, (cur) => {
    if (!cur) throw httpError(404, 'No crew here.');
    const doc = { ...cur };
    actor = actorOf(req, doc);
    if (!actor.mid) throw httpError(404, 'No crew here.');
    out = fn(doc, actor) || {};
    return doc;
  });
  return { crew: saved, actor, out };
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    limits: { ...Core.LIMITS, crewsPerHost: K.LIMITS.crewsPerHost },
    styles: Core.STYLES, families: Core.FAMILIES, chips: Core.CHIPS, emoji: Core.EMOJI,
    points: Core.POINTS, awards: Core.AWARDS, hopscotchHost: hopscotch.HOST(),
  });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier });
});

/* ------------------------------------------------------------------ *
 * Metered: snap a label
 * ------------------------------------------------------------------ */

/** Gates, then the 6 MB parser, then the photo checks (a 400 costs
 *  nothing), then one forced tool. The photo is read once and dropped;
 *  nothing here writes to the store. */
app.post('/api/snap', ...spend, snapJson, route('The label could not be read. Try again in a minute - or type it in.', async (req, res) => {
  const [p] = photo.validateAll([(req.body || {}).photo]);
  const raw = await ai.readLabel(await clientFor(req), modelFor(req), p);
  const out = ai.cleanLabel(raw);
  if (!out) throw httpError(422, 'No beer name could be read from that. Try a closer, well-lit photo of the front of the can - or type it in.');
  res.set('Cache-Control', 'no-store');
  res.json({ label: out });
}));

/* ------------------------------------------------------------------ *
 * Crews: the host (a free account; no model call)
 * ------------------------------------------------------------------ */

app.post('/api/crews', user, route('Could not start the crew.', async (req, res) => {
  countWrite(req);
  const tag = tagFor(req);
  const b = req.body || {};
  const mine = await store.list('crews', { where: [['ownerTag', '==', tag]], limit: K.LIMITS.crewsPerHost * 2 });
  if (mine.length >= K.LIMITS.crewsPerHost) throw httpError(409, `You can run ${K.LIMITS.crewsPerHost} crews at once. Delete an old one first.`);
  const now = Date.now();
  const doc = K.create({ name: b.name, hostName: b.hostName, emoji: b.emoji, tag, now });
  let code = null;
  for (let i = 0; i < 8 && !code; i++) {
    const c = K.newCode();
    if (!(await store.list('crews', { where: [['code', '==', c]], limit: 1 })).length) code = c;
  }
  if (!code) throw httpError(503, 'Could not make a crew code. Try again.');
  doc.code = code;
  const id = K.newCrewId();
  await store.transact('crews', id, (cur) => { if (cur) throw httpError(409, 'Try again.'); return doc; });
  res.json({ id, crew: K.view({ ...doc, id }, doc.members[0].id, true) });
}));

/** Every crew this account runs or kept a seat in. */
app.get('/api/crews', user, route('Could not load your crews.', async (req, res) => {
  const tag = tagFor(req);
  const now = Date.now();
  const rows = [];
  for (const d of await store.list('crews', { where: [['acctTags', 'array-contains', tag]], limit: 60 })) {
    if (K.idle(d, now)) { await purgeCrew(d.id); continue; }
    rows.push({ id: d.id, name: d.name, members: d.members.length, host: d.ownerTag === tag, updatedAt: d.updatedAt });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ crews: rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) });
}));

/** A host-only change: the host is recognised by account, so these need a
 *  sign-in - and anyone else gets the 404 a missing crew gets. */
async function hostChange(req, fn) {
  const r = await crewChange(req, (doc, actor) => { if (!actor.host) throw httpError(404, 'No crew here.'); return fn(doc, actor); });
  return r;
}

app.patch('/api/crews/:cid', user, route('Could not rename the crew.', async (req, res) => {
  const { crew, actor } = await hostChange(req, (d, a) => { K.rename(d, a, (req.body || {}).name, Date.now()); });
  res.json(K.view(crew, actor.mid, actor.host));
}));

/** A new join code: the old link and QR stop working; nobody already in the
 *  crew is affected. */
app.post('/api/crews/:cid/code', user, route('Could not change the code.', async (req, res) => {
  let code = null;
  for (let i = 0; i < 8 && !code; i++) {
    const c = K.newCode();
    if (!(await store.list('crews', { where: [['code', '==', c]], limit: 1 })).length) code = c;
  }
  if (!code) throw httpError(503, 'Could not make a code. Try again.');
  const { crew, actor } = await hostChange(req, (d) => { d.code = code; d.updatedAt = new Date().toISOString(); d.v = (d.v || 0) + 1; });
  res.json(K.view(crew, actor.mid, actor.host));
}));

app.delete('/api/crews/:cid', user, route('Could not delete the crew.', async (req, res) => {
  countWrite(req);
  const { crew, actor } = await memberCrew(req);
  if (!actor.host) throw httpError(404, 'No crew here.');
  await purgeCrew(crew.id);
  res.json({ ok: true });
}));

/** The host removes someone, or someone leaves. Everything they put in the
 *  crew's sessions, polls and cellars goes with them. No sign-in needed to
 *  leave. */
app.delete('/api/crews/:cid/members/:mid', route('Could not remove them.', async (req, res) => {
  const mid = String(req.params.mid || '');
  const { crew, actor } = await crewChange(req, (d, a) => { K.remove(d, a, mid, Date.now()); });
  for (const c of ['sessions', 'polls']) {
    for (const d of await store.list(c, { where: [['crewId', '==', crew.id]] })) {
      await store.transact(c, d.id, (cur) => {
        if (!cur) return undefined;
        const doc = { ...cur };
        let changed = false;
        if (c === 'sessions') changed = Core.scrubMember(doc, mid);
        else {
          if (doc.votes && doc.votes[mid]) { delete doc.votes[mid]; changed = true; }
          (doc.options || []).forEach((o) => { if (o.addedBy === mid) { o.addedBy = null; changed = true; } });
          if (doc.runner === mid) { doc.runner = null; changed = true; }
        }
        if (!changed) return undefined;
        doc.v = (doc.v || 0) + 1;
        return doc;
      });
    }
  }
  await scrubCellars(crew.id, mid);
  if (mid === actor.mid) return res.json({ ok: true, left: true });
  res.json(K.view(crew, actor.mid, actor.host));
}));

/* ------------------------------------------------------------------ *
 * Joining: no account
 * ------------------------------------------------------------------ */

async function crewByCode(req) {
  checkMisses(req);
  const code = K.normalizeCode(req.params.code);
  const rows = K.isCode(code) ? await store.list('crews', { where: [['code', '==', code]], limit: 1 }) : [];
  const doc = rows[0];
  if (!doc) { missed(ipKey(req), `j:${code}`); throw httpError(404, 'No crew has that code. Check it with whoever invited you - it’s under their QR code.'); }
  if (K.idle(doc, Date.now())) { await purgeCrew(doc.id); throw httpError(404, 'That crew has closed.'); }
  return doc;
}

/** What a code opens: the crew's name and size - not who is in it. */
app.get('/api/join/:code', route('Could not look that up.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await crewByCode(req);
  const a = actorOf(req, doc);
  res.json({ name: doc.name, members: doc.members.length, full: doc.members.length >= K.LIMITS.members, already: a.mid ? doc.id : null, takenEmoji: doc.members.map((m) => m.emoji) });
}));

app.post('/api/join/:code', route('Could not join.', async (req, res) => {
  countWrite(req);
  const b = req.body || {};
  const ip = ipKey(req);
  const doc = await crewByCode(req);
  const pre = actorOf(req, doc);
  if (!pre.mid && newMembers.blocked(ip)) throw httpError(429, 'Too many new members from here. Try again later.');
  const key = mintKey(req, res);
  const hash = K.keyHash(key, doc.id);
  const tag = tagOf(req);
  let r = null;
  await store.transact('crews', doc.id, (cur) => {
    if (!cur) throw httpError(404, 'That crew has closed.');
    const d = { ...cur };
    r = K.join(d, { hash, tag, name: b.name, emoji: b.emoji }, Date.now());
    return d;
  });
  if (r.isNew) newMembers.hit(ip);
  res.json({ crewId: doc.id, me: r.mid, isNew: r.isNew });
}));

/* ------------------------------------------------------------------ *
 * A crew, as its members see it
 * ------------------------------------------------------------------ */

const byNewest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));

/** Poll: the crew, its sessions and polls and its leaderboard. `?since=<v>`
 *  answers {same: true} when nothing moved, so an idle crew costs one read. */
app.get('/api/crews/:cid', route('Could not load the crew.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { crew, actor } = await memberCrew(req);
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === (crew.v || 0)) return res.json({ same: true, v: crew.v || 0 });
  const now = Date.now();
  const ids = K.memberIds(crew);
  const sessions = (await store.list('sessions', { where: [['crewId', '==', crew.id]] })).sort(byNewest);
  const polls = (await store.list('polls', { where: [['crewId', '==', crew.id]] })).sort(byNewest);
  res.json({
    crew: K.view(crew, actor.mid, actor.host),
    sessions: sessions.map((s) => Core.sessionSummary(s, ids, now)),
    polls: polls.map((p) => Core.pollView(p, ids, actor.mid, actor.host || p.runner === actor.mid)),
    board: Core.board(sessions, ids, now),
  });
}));

app.post('/api/crews/:cid/me', route('Could not save that.', async (req, res) => {
  const b = req.body || {};
  const { crew, actor } = await crewChange(req, (d, a) => { K.editMe(d, a, { name: b.name, emoji: b.emoji }, Date.now()); });
  res.json(K.view(crew, actor.mid, actor.host));
}));

/** Keep my seat: sign in, and this member follows the account to any
 *  device. */
app.post('/api/crews/:cid/seat', user, route('Could not keep your seat.', async (req, res) => {
  const tag = tagFor(req);
  const { crew, actor } = await crewChange(req, (d, a) => { K.keepSeat(d, a, tag, Date.now()); });
  res.json(K.view(crew, actor.mid, actor.host));
}));

/* ------------------------------------------------------------------ *
 * Sessions: blind tastings and Same-Can Challenges
 * ------------------------------------------------------------------ */

const ids = { beer: () => K.newId('b'), option: () => K.newId('o') };

app.post('/api/crews/:cid/sessions', route('Could not start that.', async (req, res) => {
  countWrite(req);
  const { crew, actor } = await memberCrew(req);
  const n = (await store.list('sessions', { where: [['crewId', '==', crew.id]], limit: Core.LIMITS.sessionsPerCrew + 1 })).length;
  if (n >= Core.LIMITS.sessionsPerCrew) throw httpError(409, `A crew keeps ${Core.LIMITS.sessionsPerCrew} sessions. Delete an old one first.`);
  const now = Date.now();
  const s = Core.newSession(req.body || {}, actor, now, ids);
  s.crewId = crew.id;
  const sid = K.newId('s');
  await store.transact('sessions', sid, (cur) => { if (cur) throw httpError(409, 'Try again.'); return s; });
  await bumpCrew(crew.id);
  res.json(Core.sessionView({ ...s, id: sid }, K.memberIds(crew), actor.mid, true, now));
}));

async function loadSession(req, crew) {
  const sid = String(req.params.sid || '');
  const s = K.isId(sid) ? await store.get('sessions', sid) : null;
  if (!s || s.crewId !== crew.id) throw httpError(404, 'No such session.');
  return s;
}

app.get('/api/crews/:cid/sessions/:sid', route('Could not load that.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { crew, actor } = await memberCrew(req);
  const s = await loadSession(req, crew);
  const since = Number(req.query.since);
  const now = Date.now();
  // A Same-Can window closes on a read with nothing written, so "same" also
  // has to agree on the stage.
  if (Number.isInteger(since) && since === (s.v || 0) && req.query.stage === Core.stageOf(s, now)) return res.json({ same: true, v: s.v || 0 });
  res.json(Core.sessionView(s, K.memberIds(crew), actor.mid, Core.mayRun(s, actor), now));
}));

/** One change to one session, as a transaction: loaded fresh inside it, so
 *  two phones scoring at once both stick. */
async function sessionChange(req, fn) {
  countWrite(req);
  const { crew, actor } = await memberCrew(req);
  const sid = String(req.params.sid || '');
  if (!K.isId(sid)) throw httpError(404, 'No such session.');
  const memberIds = K.memberIds(crew);
  const now = Date.now();
  const saved = await store.transact('sessions', sid, (cur) => {
    if (!cur || cur.crewId !== crew.id) throw httpError(404, 'No such session.');
    const s = { ...cur };
    fn(s, actor, memberIds, now);
    return s;
  });
  await bumpCrew(crew.id);
  return Core.sessionView(saved, memberIds, actor.mid, Core.mayRun(saved, actor), now);
}
const sessionRoute = (method, p, fallback, fn) => app[method](`/api/crews/:cid/sessions/:sid${p}`, route(fallback, async (req, res) => {
  res.json(await sessionChange(req, (s, a, m, now) => fn(req, s, a, m, now)));
}));

sessionRoute('post', '/beers', 'Could not add the beer.', (req, s, a, m, now) => { Core.addBeer(s, a, req.body || {}, now, ids, m); });
sessionRoute('patch', '/beers/:bid', 'Could not save the beer.', (req, s, a, m, now) => { Core.editBeer(s, a, String(req.params.bid), req.body || {}, now); });
sessionRoute('delete', '/beers/:bid', 'Could not take it out.', (req, s, a, m, now) => { Core.removeBeer(s, a, String(req.params.bid), now); });
sessionRoute('post', '/start', 'Could not start the tasting.', (req, s, a, m, now) => { Core.startTasting(s, a, now, K.randInt); });
sessionRoute('put', '/scores/:bid', 'Could not save your score.', (req, s, a, m, now) => { Core.setScore(s, a, String(req.params.bid), req.body || {}, now); });
sessionRoute('put', '/guesses/:bid', 'Could not save your guess.', (req, s, a, m, now) => {
  const who = (req.body || {}).who;
  Core.setGuess(s, a, String(req.params.bid), typeof who === 'string' ? who : null, m, now);
});
sessionRoute('put', '/city', 'Could not save that.', (req, s, a, m, now) => { Core.setCity(s, a, (req.body || {}).city, now); });
sessionRoute('post', '/reveal', 'Could not reveal it.', (req, s, a, m, now) => { Core.reveal(s, a, now); });

app.delete('/api/crews/:cid/sessions/:sid', route('Could not delete that.', async (req, res) => {
  countWrite(req);
  const { crew, actor } = await memberCrew(req);
  const s = await loadSession(req, crew);
  if (!Core.mayRun(s, actor)) throw httpError(403, 'Only whoever runs it, or the host, can delete it.');
  await store.remove('sessions', s.id);
  await bumpCrew(crew.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Polls: vote on the next one (approval voting)
 * ------------------------------------------------------------------ */

/** A typed option, and - when it is a Hopscotch crawl link - what that
 *  crawl's public share says. Read before the transaction (a network call
 *  never sits inside one); any failure keeps the typed text. */
async function optionFrom(text) {
  const t = Core.clean(text, Core.LIMITS.pollOption);
  const crawl = await hopscotch.readCrawl(String(text || '').slice(0, 300));
  return { text: crawl && /^https?:\/\//i.test(t) ? Core.clean(crawl.title + (crawl.place ? ` · ${crawl.place}` : ''), Core.LIMITS.pollOption) : t, crawl };
}

app.post('/api/crews/:cid/polls', route('Could not start the vote.', async (req, res) => {
  countWrite(req);
  const { crew, actor } = await memberCrew(req);
  const n = (await store.list('polls', { where: [['crewId', '==', crew.id]], limit: Core.LIMITS.pollsPerCrew + 1 })).length;
  if (n >= Core.LIMITS.pollsPerCrew) throw httpError(409, `A crew keeps ${Core.LIMITS.pollsPerCrew} votes. Delete an old one first.`);
  const b = req.body || {};
  const now = Date.now();
  const p = Core.newPoll({ question: b.question, options: [] }, actor, now, ids);
  for (const o of (Array.isArray(b.options) ? b.options : []).slice(0, Core.LIMITS.pollOptions)) {
    const opt = await optionFrom(o);
    if (opt.text) p.options.push({ id: ids.option(), text: opt.text, crawl: opt.crawl, addedBy: actor.mid });
  }
  p.crewId = crew.id;
  const pid = K.newId('p');
  await store.transact('polls', pid, (cur) => { if (cur) throw httpError(409, 'Try again.'); return p; });
  await bumpCrew(crew.id);
  res.json(Core.pollView({ ...p, id: pid }, K.memberIds(crew), actor.mid, true));
}));

async function pollChange(req, fn) {
  countWrite(req);
  const { crew, actor } = await memberCrew(req);
  const pid = String(req.params.pid || '');
  if (!K.isId(pid)) throw httpError(404, 'No such vote.');
  const memberIds = K.memberIds(crew);
  const now = Date.now();
  const saved = await store.transact('polls', pid, (cur) => {
    if (!cur || cur.crewId !== crew.id) throw httpError(404, 'No such vote.');
    const p = { ...cur };
    fn(p, actor, memberIds, now);
    return p;
  });
  await bumpCrew(crew.id);
  return Core.pollView(saved, memberIds, actor.mid, actor.host || saved.runner === actor.mid);
}

app.post('/api/crews/:cid/polls/:pid/options', route('Could not add that.', async (req, res) => {
  await memberCrew(req); // a stranger's link is never fetched
  const opt = await optionFrom((req.body || {}).text);
  res.json(await pollChange(req, (p, a, m, now) => { Core.addOption(p, a, opt.text, opt.crawl, now, ids); }));
}));
app.delete('/api/crews/:cid/polls/:pid/options/:oid', route('Could not take that out.', async (req, res) => {
  res.json(await pollChange(req, (p, a, m, now) => { Core.removeOption(p, a, String(req.params.oid), now); }));
}));
app.put('/api/crews/:cid/polls/:pid/vote', route('Could not save your vote.', async (req, res) => {
  res.json(await pollChange(req, (p, a, m, now) => { Core.vote(p, a, (req.body || {}).options, now); }));
}));
app.post('/api/crews/:cid/polls/:pid/close', route('Could not close the vote.', async (req, res) => {
  const pick = (req.body || {}).pick;
  res.json(await pollChange(req, (p, a, m, now) => { Core.closePoll(p, a, typeof pick === 'string' ? pick : null, m, now); }));
}));
app.delete('/api/crews/:cid/polls/:pid', route('Could not delete the vote.', async (req, res) => {
  countWrite(req);
  const { crew, actor } = await memberCrew(req);
  const pid = String(req.params.pid || '');
  const p = K.isId(pid) ? await store.get('polls', pid) : null;
  if (!p || p.crewId !== crew.id) throw httpError(404, 'No such vote.');
  if (!(actor.host || p.runner === actor.mid)) throw httpError(403, 'Only whoever started it, or the host, can delete it.');
  await store.remove('polls', pid);
  await bumpCrew(crew.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Cellar & Swap: have/want lists, in-person swaps, gifts through a
 * licensed seller, and a friendly IOU tally. No model call, no money, no
 * address, no shipping between people - see CLAUDE.md "Cellar & Swap".
 *
 * One document per member's lists, `cellars/<crewId>_<memberId>` (their
 * haves, wants, the gifts made to them and their squared-up marks), and
 * one per swap, `swaps/<id>`. Every write is a transaction on one of them.
 * ------------------------------------------------------------------ */

const cellarDocId = (crewId, mid) => `${crewId}_${mid}`;
const cellarIds = { item: () => K.newId('i'), gift: () => K.newId('g'), square: () => K.newId('q') };

async function cellarBundle(crew, actor) {
  const memberIds = K.memberIds(crew);
  const [cellars, swaps] = await Promise.all([
    store.list('cellars', { where: [['crewId', '==', crew.id]] }),
    store.list('swaps', { where: [['crewId', '==', crew.id]] }),
  ]);
  return { v: crew.v || 0, ...Core.cellarView(cellars, swaps, memberIds, actor.mid, Date.now()) };
}

/** A member leaving or removed: their lists and every swap they are in are
 *  deleted; the gifts they claimed and the squared-up marks naming them
 *  come off everyone else's lists. */
async function scrubCellars(crewId, mid) {
  for (const d of await store.list('cellars', { where: [['crewId', '==', crewId]] })) {
    if (d.member === mid) { await store.remove('cellars', d.id); continue; }
    await store.transact('cellars', d.id, (cur) => {
      if (!cur) return undefined;
      const doc = { ...cur };
      if (!Core.scrubCellar(doc, mid)) return undefined;
      doc.v = (doc.v || 0) + 1;
      return doc;
    });
  }
  for (const w of await store.list('swaps', { where: [['crewId', '==', crewId]] })) {
    if (w.from === mid || w.to === mid) await store.remove('swaps', w.id);
  }
}

app.get('/api/crews/:cid/cellar', route('Could not load the cellar.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { crew, actor } = await memberCrew(req);
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === (crew.v || 0)) return res.json({ same: true, v: crew.v || 0 });
  res.json(await cellarBundle(crew, actor));
}));

/** One change to one member's lists, as a transaction. `owner` is whose
 *  lists ('me' for the caller's own); the rules in flight-core decide who
 *  may change what (only you your own lines; anyone else a gift claim). */
async function cellarChange(req, owner, fn) {
  countWrite(req);
  const { crew, actor } = await memberCrew(req);
  const memberIds = K.memberIds(crew);
  const mid = owner === 'me' ? actor.mid : String(owner || '');
  if (!memberIds.includes(mid)) throw httpError(404, 'No such member.');
  const now = Date.now();
  await store.transact('cellars', cellarDocId(crew.id, mid), (cur) => {
    const doc = cur ? { ...cur } : Core.newCellar(crew.id, mid, now);
    if (doc.crewId !== crew.id || doc.member !== mid) throw httpError(404, 'No such list.');
    fn(doc, actor, memberIds, now);
    return doc;
  });
  await bumpCrew(crew.id);
  return cellarBundle(crew, actor);
}

app.post('/api/crews/:cid/cellar/:list', route('Could not add that.', async (req, res) => {
  const list = Core.cellarList(String(req.params.list));
  res.json(await cellarChange(req, 'me', (d, a, m, now) => { Core.addItem(d, a, list, req.body || {}, now, cellarIds); }));
}));
app.patch('/api/crews/:cid/cellar/:list/:iid', route('Could not save that.', async (req, res) => {
  Core.cellarList(String(req.params.list));
  res.json(await cellarChange(req, 'me', (d, a, m, now) => { Core.editItem(d, a, String(req.params.iid), req.body || {}, now); }));
}));
app.delete('/api/crews/:cid/cellar/:list/:iid', route('Could not take that off.', async (req, res) => {
  Core.cellarList(String(req.params.list));
  res.json(await cellarChange(req, 'me', (d, a, m, now) => { Core.removeItem(d, a, String(req.params.iid), now); }));
}));

/** "I'll gift this" on a crew-mate's wish, letting it go, and the
 *  recipient's "It arrived". */
app.post('/api/crews/:cid/cellar/wants/:mid/:iid/gift', route('Could not claim that.', async (req, res) => {
  res.json(await cellarChange(req, req.params.mid, (d, a, m, now) => { Core.claimGift(d, a, String(req.params.iid), now, cellarIds); }));
}));
app.delete('/api/crews/:cid/cellar/wants/:mid/:iid/gift', route('Could not let that go.', async (req, res) => {
  res.json(await cellarChange(req, req.params.mid, (d, a, m, now) => { Core.unclaimGift(d, a, String(req.params.iid), now); }));
}));
app.post('/api/crews/:cid/cellar/wants/:mid/:iid/arrived', route('Could not save that.', async (req, res) => {
  res.json(await cellarChange(req, req.params.mid, (d, a, m, now) => { Core.giftArrived(d, a, String(req.params.iid), now); }));
}));

/** Squared up: one beer settled between the caller and a crew-mate. The
 *  tally is read first (it spans every list and swap), then the mark goes
 *  on the caller's own document. */
app.post('/api/crews/:cid/ious/square', route('Could not save that.', async (req, res) => {
  const { crew, actor } = await memberCrew(req);
  const withMid = typeof (req.body || {}).with === 'string' ? req.body.with : '';
  const memberIds = K.memberIds(crew);
  const [cellars, swaps] = await Promise.all([
    store.list('cellars', { where: [['crewId', '==', crew.id]] }),
    store.list('swaps', { where: [['crewId', '==', crew.id]] }),
  ]);
  const net = actor.mid && memberIds.includes(withMid) ? Core.owedBetween(Core.tallies(cellars, swaps, memberIds), actor.mid, withMid) : 0;
  res.json(await cellarChange(req, 'me', (d, a, m, now) => { Core.squareUp(d, a, withMid, net, m, now, cellarIds); }));
}));

/** Propose a swap: in person, at a tasting the crew has on or a place in a
 *  few words. 30 open a crew; 200 kept, the oldest declined or cancelled
 *  making room. */
app.post('/api/crews/:cid/swaps', route('Could not propose that.', async (req, res) => {
  countWrite(req);
  const { crew, actor } = await memberCrew(req);
  const b = req.body || {};
  const memberIds = K.memberIds(crew);
  const to = typeof b.to === 'string' && memberIds.includes(b.to) ? b.to : null;
  const [mine, theirs] = await Promise.all([
    actor.mid ? store.get('cellars', cellarDocId(crew.id, actor.mid)) : null,
    to ? store.get('cellars', cellarDocId(crew.id, to)) : null,
  ]);
  let session = null;
  if (b.session !== null && b.session !== undefined && b.session !== '') {
    const sid = String(b.session);
    const s = K.isId(sid) ? await store.get('sessions', sid) : null;
    session = s && s.crewId === crew.id ? s : null;
  }
  const now = Date.now();
  const w = Core.newSwap(b, actor, mine, theirs, memberIds, session, now);
  const all = await store.list('swaps', { where: [['crewId', '==', crew.id]] });
  if (all.filter(Core.swapOpen).length >= Core.LIMITS.swapsOpen) throw httpError(409, `The crew has ${Core.LIMITS.swapsOpen} swaps open - settle or cancel one first.`);
  if (all.length >= Core.LIMITS.swapsKept) {
    const old = all.filter((x) => x.state === 'declined' || x.state === 'cancelled').sort((x, y) => String(x.updatedAt).localeCompare(String(y.updatedAt)))[0];
    if (!old) throw httpError(409, `A crew keeps ${Core.LIMITS.swapsKept} swaps.`);
    await store.remove('swaps', old.id);
  }
  w.crewId = crew.id;
  const wid = K.newId('w');
  await store.transact('swaps', wid, (cur) => { if (cur) throw httpError(409, 'Try again.'); return w; });
  await bumpCrew(crew.id);
  res.json(await cellarBundle(crew, actor));
}));

/** Accept, decline, cancel, or tick "we swapped" (both ticks and it is
 *  done). Only the two people in it; to anyone else it is a 404. */
app.post('/api/crews/:cid/swaps/:wid/:action', route('Could not save that.', async (req, res) => {
  countWrite(req);
  const { crew, actor } = await memberCrew(req);
  const wid = String(req.params.wid || '');
  const action = String(req.params.action || '');
  if (!K.isId(wid) || !Core.SWAP_ACTIONS.includes(action)) throw httpError(404, 'No such swap.');
  await store.transact('swaps', wid, (cur) => {
    if (!cur || cur.crewId !== crew.id) throw httpError(404, 'No such swap.');
    const w = { ...cur, ticks: { ...(cur.ticks || {}) } };
    Core.swapAct(w, actor, action, Date.now());
    return w;
  });
  await bumpCrew(crew.id);
  res.json(await cellarBundle(crew, actor));
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A crew link (c/<id>) and a join link (j/<code>) are the same single-page
// app served one level down; <base href="../"> resolves every relative
// asset and API path against the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function deepIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
for (const p of ['/c/:id', '/j/:code']) {
  app.get(p, (_req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(deepIndex()); });
  app.all(p, (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));
}

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Never log a parse error's message: V8 quotes the start of the body in it.
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once. Try a smaller photo.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // FLIGHT_DEV_MOUNT=/flight runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.FLIGHT_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`flight listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
