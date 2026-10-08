// Pickup - who's in, fair teams, and who owes for the court. See CLAUDE.md.
//
// A group on one phone needs nothing from this server: the page keeps it in
// localStorage and runs public/pickup-core.js itself. The server is for a
// group ONLINE, shared across phones: the host has a free account (so the
// group is theirs to run and delete); everyone else joins by link, QR or a
// six-character code with a name and an emoji and no account.
//
// A model is used for ONE thing, metered and signed in: reading a pasted
// group chat (or a screenshot of one) into who is in, maybe or out. A free
// reader on the phone tries first. Everything else - answers, the waitlist,
// teams, results, the season, court money - is the core file and costs
// nothing.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/pickup-core');
const G = require('./lib/groups');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.PICKUP_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('PICKUP_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. Both read screenshots.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A join code and a group id are keys. They must not ride out in a
  // Referer header, and a group page should never be indexed.
  if (/^\/(g|j)\//.test(req.path) || /^\/api\/(groups|join)\//.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// The metered routes mount their own parser AFTER sign-in, budget and the
// daily cap, so a stranger's body is never read: a screenshot (4 MB) and
// pasted text (64 KB). Putting a group online carries its season, so that
// route gets 512 KB - also after its sign-in. Everything else 64 KB.
const OWN_PARSER = /^\/api\/replies\/(text|photo)$/;
const photoJson = express.json({ limit: '4mb' });
const textJson = express.json({ limit: '64kb' });
const groupJson = express.json({ limit: '512kb' });
const smallJson = express.json({ limit: '64kb' });
app.use((req, res, next) => {
  if (OWN_PARSER.test(req.path)) return next();
  if (req.method === 'POST' && req.path === '/api/groups') return next();
  return smallJson(req, res, next);
});

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'pickup',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Pickup',
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
 * body: who is coming and what a chat says are nobody's business - and
 * answered with the route's fallback. A provider error is a 502, or 503
 * when it is busy.
 * ------------------------------------------------------------------ */

const httpError = G.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - the free reader and tapping answers in still work.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
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
const newMembers = identityLib.createLimiter({ max: G.LIMITS.newMembersPerIp, windowMs: G.LIMITS.newMembersWindowMs });
const writes = identityLib.createLimiter({ max: G.LIMITS.writesPerIp, windowMs: G.LIMITS.writesWindowMs });

// A wrong code or group id counts once per DISTINCT value: a phone left open
// on a deleted group polls the same dead id every few seconds, and that is
// not guessing. Guessing needs many different codes.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > G.LIMITS.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, what) {
  const e = missState(ip);
  e.seen.add(what);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
function checkMisses(req) {
  if (missState(ipKey(req)).seen.size >= G.LIMITS.missesPerIp) throw httpError(429, 'Too many wrong codes from here. Try again in a few minutes.');
}
function countWrite(req) {
  if (!writes.hit(ipKey(req))) throw httpError(429, 'That’s a lot of taps from here. Wait a minute and try again.');
}

/* ------------------------------------------------------------------ *
 * Who is asking. A member is this browser (an HttpOnly key, stored only as
 * sha256(key + group id)) or a signed-in account that holds a seat (an HMAC
 * tag). The host is the account that made the group.
 * ------------------------------------------------------------------ */

const KEY_COOKIE = 'pickup_k';
function readKey(req) {
  const m = /(?:^|;\s*)pickup_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintKey(req, res) {
  const have = readKey(req);
  if (have) return have;
  const key = G.newKey();
  res.append('Set-Cookie', `${KEY_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}
function tagOf(req) {
  if (!req.user) return null;
  const secret = SECRET();
  return secret ? G.acctTag(req.user.id, secret) : null;
}
function tagFor(req) {
  const tag = tagOf(req);
  if (!tag) throw httpError(503, 'Groups online are switched off on this server right now.');
  return tag;
}

/** {mid, host, online} for this request in this group. */
function actorOf(req, doc) {
  const tag = tagOf(req);
  const key = readKey(req);
  const hash = key ? G.keyHash(key, doc.id) : null;
  const m = (hash && doc.members.find((x) => x.keyHash === hash)) || (tag && doc.members.find((x) => x.acct === tag)) || null;
  return { mid: m ? m.id : null, host: Boolean(m && m.host && tag && doc.ownerTag === tag && m.acct === tag), online: true };
}

/** The group, if the id names a live one. One nobody has touched in 180
 *  days is deleted by the read that finds it (there is no timer). */
async function loadGroup(req) {
  checkMisses(req);
  const id = String(req.params.gid || '');
  const doc = G.isGroupId(id) ? await store.get('groups', id) : null;
  if (!doc) { missed(ipKey(req), `g:${id.slice(0, 20)}`); throw httpError(404, 'No group here.'); }
  if (G.idle(doc, Date.now())) { await store.remove('groups', doc.id); throw httpError(404, 'This group closed after six months with nothing new.', { code: 'expired' }); }
  return doc;
}
/** The group and who is asking - and a stranger gets the same 404 a group
 *  that does not exist gets, so nobody learns an id is real. */
async function memberGroup(req) {
  const doc = await loadGroup(req);
  const actor = actorOf(req, doc);
  if (!actor.mid) throw httpError(404, 'No group here.');
  return { doc, actor };
}

/** This week's game exists: the read that finds last week's game over
 *  opens the next one (no timer - billed per request), in a transaction, so
 *  two phones arriving at once open it once. */
async function ensureCurrent(doc, now) {
  if (!Core.needsNext(doc, now)) return doc;
  let fresh = doc;
  await store.transactKeys('groups', doc.id, (cur) => {
    if (!cur) throw httpError(404, 'No group here.');
    const e = Core.ensureGame(cur, now);
    if (!e.patch) { fresh = cur; return undefined; }
    return { set: { ...e.patch.set, ...G.touchKeys(cur, now) }, del: e.patch.del };
  });
  return (await store.get('groups', doc.id)) || fresh;
}
const bundle = (doc, actor, extra, now = Date.now()) => ({ group: G.view(doc, actor.mid, actor.host, now), now, ...(extra || {}) });

/** A change to members, settings or lines: a whole-document transaction
 *  (rare). */
async function groupChange(req, fn) {
  countWrite(req);
  const { doc } = await memberGroup(req);
  let actor = null;
  let out;
  const saved = await store.transact('groups', doc.id, (cur) => {
    if (!cur) throw httpError(404, 'No group here.');
    const d = JSON.parse(JSON.stringify(cur));
    actor = actorOf(req, d);
    if (!actor.mid) throw httpError(404, 'No group here.');
    out = fn(d, actor);
    G.touch(d, Date.now());
    return d;
  });
  return { doc: await ensureCurrent(saved, Date.now()), actor, out };
}

/** The busy writes - an answer, a +1, teams, a score, Paid, a vote: read
 *  the group inside a transaction, let the core decide, then write ONLY the
 *  keys it changed (and the version). Two phones at once never write back a
 *  copy missing the other's change, and the last spot has one owner. */
async function gameWrite(req, fn) {
  countWrite(req);
  const { doc } = await memberGroup(req);
  const gid = String(req.params.game || '');
  if (!Core.isGameId(gid)) throw httpError(404, 'That game isn’t here any more.');
  const now = Date.now();
  let out = null;
  let actor = null;
  await store.transactKeys('groups', doc.id, (cur) => {
    if (!cur) throw httpError(404, 'No group here.');
    actor = actorOf(req, cur);
    if (!actor.mid) throw httpError(404, 'No group here.');
    Core.gameOf(cur, gid);
    out = fn(cur, gid, { now, rand: G.rand, actor });
    return { set: { ...out.patch.set, ...G.touchKeys(cur, now) }, del: out.patch.del };
  });
  const fresh = await ensureCurrent(await store.get('groups', doc.id), now);
  return bundle(fresh, actor, { msg: out.msg, ...(out.status ? { status: out.status } : {}) }, now);
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: { ...Core.LIMITS, groupsPerHost: G.LIMITS.groupsPerHost }, sports: Core.SPORTS.map((s) => ({ id: s.id, name: s.name, emoji: s.emoji, perSide: s.perSide, cap: s.cap })) });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier });
});

/* ------------------------------------------------------------------ *
 * Metered: read the group chat
 * ------------------------------------------------------------------ */

function chatAnswer(res, raw) {
  const replies = ai.cleanReplies(raw);
  if (!replies.length) throw httpError(422, 'Nobody’s answer came out of that. Paste the replies about this week’s game - or tap answers in by hand.');
  res.set('Cache-Control', 'no-store');
  res.json({ replies });
}

/** Gates, then a 64 KB parser, then the text checked (a 400 costs
 *  nothing), then one forced tool. The text is read once and dropped;
 *  nothing here writes to the store. */
app.post('/api/replies/text', ...spend, textJson, route('Reading the chat isn’t available right now. Try again in a minute - the free reader still works.', async (req, res) => {
  const b = req.body || {};
  const raw = typeof b.text === 'string' ? b.text : '';
  if (raw.length > Core.LIMITS.pasteText) throw httpError(400, 'That’s a lot of chat. Paste just this week’s replies.');
  const text = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim();
  if (!/[\p{L}\p{Extended_Pictographic}]{2}/u.test(text)) throw httpError(400, 'Paste the replies from the group chat first.');
  const names = ai.cleanNames(b.names);
  chatAnswer(res, await ai.readReplies(await clientFor(req), modelFor(req), { text, names }));
}));

/** Gates, then the 4 MB parser, then the screenshot checked by its bytes,
 *  then one forced tool. Read once and dropped. */
app.post('/api/replies/photo', ...spend, photoJson, route('Reading the screenshot isn’t available right now. Try again in a minute - pasting the text is free.', async (req, res) => {
  const b = req.body || {};
  const p = photo.validate(b.photo);
  const names = ai.cleanNames(b.names);
  chatAnswer(res, await ai.readReplies(await clientFor(req), modelFor(req), { photo: p, names }));
}));

/* ------------------------------------------------------------------ *
 * Groups: the host (a free account; no model call)
 * ------------------------------------------------------------------ */

async function freshCode() {
  for (let i = 0; i < 8; i++) {
    const c = G.newCode();
    if (!(await store.list('groups', { where: [['code', '==', c]], limit: 1 })).length) return c;
  }
  throw httpError(503, 'Could not make a code. Try again.');
}

/** Put a phone's group online: its name, sport, schedule, regulars, lines
 *  and season. The phone's host becomes the account's seat. */
app.post('/api/groups', user, groupJson, route('Could not put the group online.', async (req, res) => {
  countWrite(req);
  const tag = tagFor(req);
  const b = req.body || {};
  const mine = await store.list('groups', { where: [['ownerTag', '==', tag]], limit: G.LIMITS.groupsPerHost * 2 });
  if (mine.length >= G.LIMITS.groupsPerHost) throw httpError(409, `You can host ${G.LIMITS.groupsPerHost} groups at once. Delete an old one first.`);
  const now = Date.now();
  const doc = G.create({ group: b.group, tz: b.tz, tag, now });
  doc.code = await freshCode();
  const id = G.newGroupId();
  await store.transact('groups', id, (cur) => { if (cur) throw httpError(409, 'Try again.'); return doc; });
  const me = doc.members.find((m) => m.host).id;
  res.json({ id, ...bundle({ ...doc, id }, { mid: me, host: true }, null, now) });
}));

/** Every group this account hosts or holds a seat in. */
app.get('/api/groups', user, route('Could not load your groups.', async (req, res) => {
  const tag = tagFor(req);
  const now = Date.now();
  const rows = [];
  for (const d of await store.list('groups', { where: [['acctTags', 'array-contains', tag]], limit: 40 })) {
    if (G.idle(d, now)) { await store.remove('groups', d.id); continue; }
    rows.push({ id: d.id, name: d.name, sport: d.sport, members: d.members.length, host: d.ownerTag === tag, updatedAt: d.updatedAt });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ groups: rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) });
}));

/** A host-only change: the host is recognised by account, so these need a
 *  sign-in - and anyone else gets the 404 a missing group gets. */
const hostChange = (req, fn) => groupChange(req, (d, a) => { if (!a.host) throw httpError(404, 'No group here.'); return fn(d, a); });

app.patch('/api/groups/:gid', user, route('Could not save the group.', async (req, res) => {
  const { doc, actor } = await hostChange(req, (d, a) => { Core.editGroup(d, req.body || {}, a, Date.now()); });
  res.json(bundle(doc, actor, { msg: 'Saved.' }));
}));

/** A new join code: the old link and QR stop working; nobody already in the
 *  group is affected. */
app.post('/api/groups/:gid/code', user, route('Could not change the code.', async (req, res) => {
  const code = await freshCode();
  const { doc, actor } = await hostChange(req, (d) => { d.code = code; });
  res.json(bundle(doc, actor, { msg: 'New code ready.' }));
}));

app.delete('/api/groups/:gid', user, route('Could not delete the group.', async (req, res) => {
  countWrite(req);
  const { doc, actor } = await memberGroup(req);
  if (!actor.host) throw httpError(404, 'No group here.');
  await store.remove('groups', doc.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Joining: no account
 * ------------------------------------------------------------------ */

async function groupByCode(req) {
  checkMisses(req);
  const code = G.normalizeCode(req.params.code);
  const rows = G.isCode(code) ? await store.list('groups', { where: [['code', '==', code]], limit: 1 }) : [];
  const doc = rows[0];
  if (!doc) { missed(ipKey(req), `j:${code}`); throw httpError(404, 'No group has that code. Check it with whoever invited you - it’s under their QR code.'); }
  if (G.idle(doc, Date.now())) { await store.remove('groups', doc.id); throw httpError(404, 'That group has closed.'); }
  return doc;
}

/** What a code opens: the group's name, sport and when it plays, how many
 *  are in this week, and the open seats (regulars the host typed in who have
 *  not joined), so a friend can say "that's me". Not who has joined, not
 *  anyone's answer. */
app.get('/api/join/:code', route('Could not look that up.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await groupByCode(req);
  const a = actorOf(req, doc);
  const game = Core.latest(doc);
  const lu = game ? Core.lineup(doc, game) : null;
  res.json({
    name: doc.name, sport: doc.sport, members: doc.members.length, full: doc.members.length >= G.LIMITS.members, already: a.mid ? doc.id : null,
    sched: { wd: doc.sched.wd, time: doc.sched.time, place: doc.sched.place },
    game: game ? { date: game.date, time: game.time, place: game.place, in: lu.in.length, cap: lu.cap, waiting: lu.wait.length } : null,
    seats: doc.members.filter(G.isOpen).map((m) => ({ id: m.id, name: m.name, emoji: m.emoji })),
    takenEmoji: doc.members.map((m) => m.emoji),
  });
}));

app.post('/api/join/:code', route('Could not join.', async (req, res) => {
  countWrite(req);
  const b = req.body || {};
  const ip = ipKey(req);
  const doc = await groupByCode(req);
  const pre = actorOf(req, doc);
  if (!pre.mid && newMembers.blocked(ip)) throw httpError(429, 'Too many new people from here. Try again later.');
  const key = mintKey(req, res);
  const hash = G.keyHash(key, doc.id);
  const tag = tagOf(req);
  let r = null;
  await store.transact('groups', doc.id, (cur) => {
    if (!cur) throw httpError(404, 'That group has closed.');
    const d = JSON.parse(JSON.stringify(cur));
    r = G.join(d, { hash, tag, seat: typeof b.seat === 'string' ? b.seat : null, name: b.name, emoji: b.emoji, skill: b.skill }, Date.now());
    return d;
  });
  if (r.isNew) newMembers.hit(ip);
  res.json({ groupId: doc.id, me: r.mid, isNew: r.isNew });
}));

/* ------------------------------------------------------------------ *
 * A group, as its members see it
 * ------------------------------------------------------------------ */

/** Poll: `?since=<v>` answers {same: true} when nothing moved and this
 *  week's game is still this week's, so an idle group costs one read. */
app.get('/api/groups/:gid', route('Could not load the group.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { doc, actor } = await memberGroup(req);
  const now = Date.now();
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === (doc.v || 0) && !Core.needsNext(doc, now)) return res.json({ same: true, v: doc.v || 0 });
  res.json(bundle(await ensureCurrent(doc, now), actor, null, now));
}));

/** Regulars: your own name, emoji, skill and position; the host sets
 *  anyone's, adds open seats and adjusts skill quietly. */
app.patch('/api/groups/:gid/members/:mid', route('Could not save that.', async (req, res) => {
  const { doc, actor } = await groupChange(req, (d, a) => { Core.editMember(d, String(req.params.mid), req.body || {}, a); });
  res.json(bundle(doc, actor, { msg: 'Saved.' }));
}));
app.post('/api/groups/:gid/members', route('Could not add them.', async (req, res) => {
  const b = req.body || {};
  const { doc, actor, out } = await groupChange(req, (d, a) => G.addSeats(d, a, Array.isArray(b.names) ? b.names : [b.name], Date.now()));
  res.json(bundle(doc, actor, { msg: out.msg, added: out.members.map((m) => m.id) }));
}));
app.delete('/api/groups/:gid/members/:mid', route('Could not remove them.', async (req, res) => {
  const mid = String(req.params.mid || '');
  const { doc, actor } = await groupChange(req, (d, a) => { G.remove(d, a, mid, Date.now()); });
  if (mid === actor.mid) return res.json({ ok: true, left: true });
  res.json(bundle(doc, actor, { msg: 'Removed.' }));
}));
/** Split / together lines: the host's alone. */
app.put('/api/groups/:gid/lines', route('Could not save that.', async (req, res) => {
  const { doc, actor } = await groupChange(req, (d, a) => {
    if (!a.host) throw httpError(403, 'Only the host sets who plays with whom.');
    d.lines = Core.cleanLines(d, (req.body || {}).lines);
  });
  res.json(bundle(doc, actor, { msg: 'Saved.' }));
}));

/* ------------------------------------------------------------------ *
 * This week's game: a few keys per write, in a transaction
 * ------------------------------------------------------------------ */

const G_ = '/api/groups/:gid/games/:game';
const pidOf = (req) => String(req.params.pid || '');

app.put(`${G_}/rsvp/:pid`, route('Could not save your answer.', async (req, res) => {
  const a = (req.body || {}).a;
  res.json(await gameWrite(req, (cur, gid, ctx) => Core.rsvp(cur, gid, pidOf(req), a === null ? null : String(a || ''), ctx)));
}));
/** The host applies answers read from the group chat; names nobody matched
 *  become new regulars first. */
app.post(`${G_}/rsvps`, route('Could not apply those answers.', async (req, res) => {
  const b = req.body || {};
  const adds = (Array.isArray(b.add) ? b.add : []).slice(0, Core.LIMITS.replies);
  let added = [];
  if (adds.length) {
    const r = await groupChange(req, (d, a) => {
      if (!a.host) throw httpError(403, 'Only the host can apply answers for others.');
      return G.addSeats(d, a, adds.map((x) => x && x.name), Date.now());
    });
    added = r.out.members;
  }
  const answers = (Array.isArray(b.answers) ? b.answers : []).slice(0, Core.LIMITS.replies).concat(adds.map((x) => {
    const m = added.find((y) => Core.fold(y.name) === Core.fold(Core.cleanName(x && x.name)));
    return m ? { id: m.id, a: x.a, plus: x.plus } : null;
  }).filter(Boolean));
  res.json(await gameWrite(req, (cur, gid, ctx) => Core.rsvpMany(cur, gid, answers, ctx)));
}));
app.post(`${G_}/guests`, route('Could not add your guest.', async (req, res) => {
  const b = req.body || {};
  res.json(await gameWrite(req, (cur, gid, ctx) => Core.addGuest(cur, gid, { name: b.name, skill: b.skill, by: b.by }, ctx)));
}));
app.patch(G_, route('Could not save the game.', async (req, res) => {
  const b = req.body || {};
  const body = { ...b };
  if (b.cost !== undefined && typeof b.cost !== 'number') body.cost = Core.moneyIn(b.cost);
  res.json(await gameWrite(req, (cur, gid, ctx) => Core.editGame(cur, gid, body, ctx)));
}));
app.post(`${G_}/done`, route('Could not wrap up.', async (req, res) => {
  res.json(await gameWrite(req, (cur, gid, ctx) => Core.wrapUp(cur, gid, ctx)));
}));
app.post(`${G_}/teams`, route('Could not make teams.', async (req, res) => {
  const b = req.body || {};
  res.json(await gameWrite(req, (cur, gid, ctx) => Core.makeTeams(cur, gid, { sides: b.sides, n: b.n }, ctx)));
}));
app.delete(`${G_}/teams`, route('Could not clear the teams.', async (req, res) => {
  res.json(await gameWrite(req, (cur, gid, ctx) => Core.clearTeams(cur, gid, ctx)));
}));
app.put(`${G_}/played`, route('Could not save who played.', async (req, res) => {
  res.json(await gameWrite(req, (cur, gid, ctx) => Core.setPlayed(cur, gid, (req.body || {}).ids, ctx)));
}));
app.post(`${G_}/matches`, route('Could not save the result.', async (req, res) => {
  res.json(await gameWrite(req, (cur, gid, ctx) => Core.addMatch(cur, gid, req.body || {}, ctx)));
}));
app.delete(`${G_}/matches/:rid`, route('Could not remove that result.', async (req, res) => {
  res.json(await gameWrite(req, (cur, gid, ctx) => Core.removeMatch(cur, gid, String(req.params.rid || ''), ctx)));
}));
/** Your vote for Player of the Week (secret until voting closes). */
app.put(`${G_}/vote`, route('Could not save your vote.', async (req, res) => {
  const c = (req.body || {}).cand;
  res.json(await gameWrite(req, (cur, gid, ctx) => Core.vote(cur, gid, ctx.actor.mid, c === null ? null : String(c || ''), ctx)));
}));
app.post(`${G_}/vote/close`, route('Could not close the vote.', async (req, res) => {
  res.json(await gameWrite(req, (cur, gid, ctx) => Core.closeVotes(cur, gid, ctx)));
}));
/** Paid: tick yourself; the host can tick anyone. No money moves here. */
app.put(`${G_}/paid/:pid`, route('Could not save that.', async (req, res) => {
  const paid = (req.body || {}).paid !== false;
  res.json(await gameWrite(req, (cur, gid, ctx) => Core.markPaid(cur, gid, pidOf(req), paid, ctx)));
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A group link (g/<id>) and a join link (j/<code>) are the same single-page
// app served one level down; <base href="../"> resolves every relative asset
// and API path against the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function deepIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
for (const p of ['/g/:id', '/j/:code']) {
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
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once. Try a smaller screenshot, or paste just this week’s replies.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // PICKUP_DEV_MOUNT=/pickup runs it the way the lab host does: mounted under
  // a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.PICKUP_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`pickup listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
