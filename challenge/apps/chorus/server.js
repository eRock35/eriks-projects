// Chorus - chores split fairly, and everyone can see it. See CLAUDE.md.
//
// A household on one phone needs nothing from this server: the page keeps it
// in localStorage and runs public/chorus-core.js itself. The server is for a
// household ONLINE, shared across phones: the host has a free account (so the
// household is theirs to run and delete); everyone else joins by link, QR or
// a six-character code with a name and an emoji and no account.
//
// A model is used for ONE thing, metered and signed in: suggesting chores
// from a photo of a room or a few words about the home.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/chorus-core');
const H = require('./lib/homes');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.CHORUS_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('CHORUS_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

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
  // A join code and a household id are keys. They must not ride out in a
  // Referer header, and a household page should never be indexed.
  if (/^\/(h|j)\//.test(req.path) || /^\/api\/(homes|join)\//.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// One route carries more than 64 KB - a photo for "Suggest chores" - and it
// mounts its own 6 MB parser AFTER sign-in, budget and the daily cap, so a
// stranger's body is never read. Putting a household online carries its
// past weeks, so that one route gets 256 KB - also after its sign-in;
// everything else 64 KB.
const SUGGEST_ROUTE = /^\/api\/suggest$/;
const bigJson = express.json({ limit: '6mb' });
const homeJson = express.json({ limit: '256kb' });
const smallJson = express.json({ limit: '64kb' });
app.use((req, res, next) => {
  if (SUGGEST_ROUTE.test(req.path)) return next();
  if (req.method === 'POST' && req.path === '/api/homes') return next();
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
  app: 'chorus',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Chorus',
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
 * body: names, chores and photos are nobody's business - and answered with
 * the route's fallback. A provider error is a 502, or 503 when it is busy.
 * ------------------------------------------------------------------ */

const httpError = H.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - or pick from the starter chores, which is free.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
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
const newMembers = identityLib.createLimiter({ max: H.LIMITS.newMembersPerIp, windowMs: H.LIMITS.newMembersWindowMs });
const writes = identityLib.createLimiter({ max: H.LIMITS.writesPerIp, windowMs: H.LIMITS.writesWindowMs });

// A wrong code or household id counts once per DISTINCT value: a phone left
// open on a deleted household polls the same dead id every few seconds, and
// that is not guessing. Guessing needs many different codes.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > H.LIMITS.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, what) {
  const e = missState(ip);
  e.seen.add(what);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
function checkMisses(req) {
  if (missState(ipKey(req)).seen.size >= H.LIMITS.missesPerIp) throw httpError(429, 'Too many wrong codes from here. Try again in a few minutes.');
}
function countWrite(req) {
  if (!writes.hit(ipKey(req))) throw httpError(429, 'That’s a lot of taps from here. Wait a minute and try again.');
}

/* ------------------------------------------------------------------ *
 * Who is asking. A member is this browser (an HttpOnly key, stored only as
 * sha256(key + household id)) or a signed-in account that holds a seat (an
 * HMAC tag). The host is the account that made the household.
 * ------------------------------------------------------------------ */

const KEY_COOKIE = 'chorus_k';
function readKey(req) {
  const m = /(?:^|;\s*)chorus_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintKey(req, res) {
  const have = readKey(req);
  if (have) return have;
  const key = H.newKey();
  res.append('Set-Cookie', `${KEY_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}
function tagOf(req) {
  if (!req.user) return null;
  const secret = SECRET();
  return secret ? H.acctTag(req.user.id, secret) : null;
}
function tagFor(req) {
  const tag = tagOf(req);
  if (!tag) throw httpError(503, 'Sharing a household is switched off on this server right now.');
  return tag;
}

/** {mid, host} for this request in this household. */
function actorOf(req, home) {
  const tag = tagOf(req);
  const key = readKey(req);
  const hash = key ? H.keyHash(key, home.id) : null;
  const m = (hash && home.members.find((x) => x.keyHash === hash)) || (tag && home.members.find((x) => x.acct === tag)) || null;
  return { mid: m ? m.id : null, host: Boolean(m && m.host && tag && home.ownerTag === tag && m.acct === tag) };
}

/** Delete a household and every week of it. */
async function purgeHome(id) {
  for (const d of await store.list('weeks', { where: [['homeId', '==', id]] })) await store.remove('weeks', d.id);
  await store.remove('homes', id);
}

/** The household, if the id names a live one. One nobody has touched in
 *  180 days is deleted by the read that finds it (there is no timer). */
async function loadHome(req) {
  checkMisses(req);
  const id = String(req.params.hid || '');
  const doc = H.isHomeId(id) ? await store.get('homes', id) : null;
  if (!doc) { missed(ipKey(req), `h:${id.slice(0, 20)}`); throw httpError(404, 'No household here.'); }
  if (H.idle(doc, Date.now())) { await purgeHome(doc.id); throw httpError(404, 'This household closed after six months with nothing new.', { code: 'expired' }); }
  return doc;
}
/** The household and who is asking - and a stranger gets the same 404 a
 *  household that does not exist gets, so nobody learns an id is real. */
async function memberHome(req) {
  const home = await loadHome(req);
  const actor = actorOf(req, home);
  if (!actor.mid) throw httpError(404, 'No household here.');
  return { home, actor };
}

/** One change to the household document, as a transaction. */
async function homeChange(req, fn) {
  countWrite(req);
  const { home } = await memberHome(req);
  let actor = null;
  let out;
  const saved = await store.transact('homes', home.id, (cur) => {
    if (!cur) throw httpError(404, 'No household here.');
    const doc = JSON.parse(JSON.stringify(cur));
    actor = actorOf(req, doc);
    if (!actor.mid) throw httpError(404, 'No household here.');
    out = fn(doc, actor);
    return doc;
  });
  return { home: saved, actor, out };
}

/* ------------------------------------------------------------------ *
 * Weeks: this week's deal and the ones before it
 * ------------------------------------------------------------------ */

const stripWeek = (d) => (d ? { week: d.week, basis: d.basis, assign: d.assign || {}, ticks: d.ticks || {}, swaps: d.swaps || {} } : null);

/** This week and the ones before it, newest first (null where a week was
 *  never online). Deals this week, or re-deals it after a change to people
 *  or chores - keeping whatever is done or swapped - inside a transaction,
 *  so two phones arriving at once deal it once (the deal is deterministic
 *  anyway). */
async function weekDocs(home, now) {
  const wk = Core.weekKey(now, home.tz);
  const keys = [];
  for (let i = 0; i < Core.LIMITS.keepWeeks; i++) keys.push(Core.addWeeks(wk, -i));
  const docs = (await Promise.all(keys.map((k) => store.get('weeks', H.weekId(home.id, k))))).map(stripWeek);
  if (Core.needsDeal(home, docs[0])) {
    const history = docs.slice(1);
    const saved = await store.transact('weeks', H.weekId(home.id, wk), (cur) => {
      const plain = stripWeek(cur);
      const next = Core.ensureWeek(home, plain, wk, history);
      if (next === plain) return undefined;
      return { ...next, homeId: home.id, createdAt: (cur && cur.createdAt) || new Date(now).toISOString() };
    });
    docs[0] = stripWeek(saved);
  }
  return { week: wk, docs };
}

async function bundle(home, actor, now = Date.now()) {
  const { week, docs } = await weekDocs(home, now);
  return { home: H.view(home, actor.mid, actor.host), week, today: Core.dayIndex(now, home.tz), weeks: docs };
}
const bumpHome = (id) => store.bump('homes', id, { v: 1 }, { mustExist: true });

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: { ...Core.LIMITS, homesPerHost: H.LIMITS.homesPerHost }, freqs: Core.FREQS, emoji: Core.EMOJI, weights: Core.WEIGHTS, templates: Core.TEMPLATES.map((t) => ({ id: t.id, name: t.name, emoji: t.emoji })) });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier });
});

/* ------------------------------------------------------------------ *
 * Metered: suggest chores from a photo or a few words
 * ------------------------------------------------------------------ */

/** Gates, then the 6 MB parser, then the input checks (a 400 costs
 *  nothing), then one forced tool. The photo is read once and dropped;
 *  nothing here writes to the store. */
app.post('/api/suggest', ...spend, bigJson, route('Suggestions are not available right now. Try again in a minute - or pick from the starter chores.', async (req, res) => {
  const b = req.body || {};
  const text = Core.clean(b.text, Core.LIMITS.suggestText);
  const p = b.photo ? photo.validateAll([b.photo])[0] : null;
  if (!p && !/[\p{L}\p{N}]{3}/u.test(text)) throw httpError(400, 'Add a photo of a room, or a few words about your home.');
  const have = ai.cleanHave(b.have);
  const raw = await ai.suggestChores(await clientFor(req), modelFor(req), { photo: p, text, have });
  const chores = ai.cleanSuggestions(raw, have);
  if (!chores.length) throw httpError(422, p ? 'No chores came out of that photo. Try one room, in good light - or describe it in a few words.' : 'No new chores came out of that. Try describing the rooms and who lives there.');
  res.set('Cache-Control', 'no-store');
  res.json({ chores });
}));

/* ------------------------------------------------------------------ *
 * Households: the host (a free account; no model call)
 * ------------------------------------------------------------------ */

async function freshCode() {
  for (let i = 0; i < 8; i++) {
    const c = H.newCode();
    if (!(await store.list('homes', { where: [['code', '==', c]], limit: 1 })).length) return c;
  }
  throw httpError(503, 'Could not make a code. Try again.');
}

/** Put a phone's household online: its name, people and chores, which one
 *  of them is the host, and its past weeks (so the rotation remembers). */
app.post('/api/homes', user, homeJson, route('Could not put the household online.', async (req, res) => {
  countWrite(req);
  const tag = tagFor(req);
  const b = req.body || {};
  const mine = await store.list('homes', { where: [['ownerTag', '==', tag]], limit: H.LIMITS.homesPerHost * 2 });
  if (mine.length >= H.LIMITS.homesPerHost) throw httpError(409, `You can host ${H.LIMITS.homesPerHost} households at once. Delete an old one first.`);
  const now = Date.now();
  const doc = H.create({ home: b.home, me: b.me, tz: b.tz, tag, now });
  doc.code = await freshCode();
  const id = H.newHomeId();
  await store.transact('homes', id, (cur) => { if (cur) throw httpError(409, 'Try again.'); return doc; });
  const weeks = H.cleanWeeks(b.weeks, doc, now);
  for (const [wk, w] of Object.entries(weeks)) await store.set('weeks', H.weekId(id, wk), { ...w, homeId: id, createdAt: new Date(now).toISOString() });
  const me = doc.members.find((m) => m.host).id;
  res.json({ id, ...(await bundle({ ...doc, id }, { mid: me, host: true }, now)) });
}));

/** Every household this account hosts or holds a seat in. */
app.get('/api/homes', user, route('Could not load your households.', async (req, res) => {
  const tag = tagFor(req);
  const now = Date.now();
  const rows = [];
  for (const d of await store.list('homes', { where: [['acctTags', 'array-contains', tag]], limit: 40 })) {
    if (H.idle(d, now)) { await purgeHome(d.id); continue; }
    rows.push({ id: d.id, name: d.name, members: d.members.length, host: d.ownerTag === tag, updatedAt: d.updatedAt });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ homes: rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) });
}));

/** A host-only change: the host is recognised by account, so these need a
 *  sign-in - and anyone else gets the 404 a missing household gets. */
const hostChange = (req, fn) => homeChange(req, (doc, actor) => { if (!actor.host) throw httpError(404, 'No household here.'); return fn(doc, actor); });

app.patch('/api/homes/:hid', user, route('Could not rename the household.', async (req, res) => {
  const { home, actor } = await hostChange(req, (d, a) => { H.rename(d, a, (req.body || {}).name, Date.now()); });
  res.json(await bundle(home, actor));
}));

/** A new join code: the old link and QR stop working; nobody already in the
 *  household is affected. */
app.post('/api/homes/:hid/code', user, route('Could not change the code.', async (req, res) => {
  const code = await freshCode();
  const { home, actor } = await hostChange(req, (d) => { d.code = code; H.touch(d, Date.now()); });
  res.json(await bundle(home, actor));
}));

app.delete('/api/homes/:hid', user, route('Could not delete the household.', async (req, res) => {
  countWrite(req);
  const { home, actor } = await memberHome(req);
  if (!actor.host) throw httpError(404, 'No household here.');
  await purgeHome(home.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Joining: no account
 * ------------------------------------------------------------------ */

async function homeByCode(req) {
  checkMisses(req);
  const code = H.normalizeCode(req.params.code);
  const rows = H.isCode(code) ? await store.list('homes', { where: [['code', '==', code]], limit: 1 }) : [];
  const doc = rows[0];
  if (!doc) { missed(ipKey(req), `j:${code}`); throw httpError(404, 'No household has that code. Check it with whoever invited you - it’s under their QR code.'); }
  if (H.idle(doc, Date.now())) { await purgeHome(doc.id); throw httpError(404, 'That household has closed.'); }
  return doc;
}

/** What a code opens: the household's name, its size, and the open seats
 *  (people the host typed in who have not joined), so a roommate can say
 *  "that's me". Not who has joined. */
app.get('/api/join/:code', route('Could not look that up.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await homeByCode(req);
  const a = actorOf(req, doc);
  res.json({
    name: doc.name, members: doc.members.length, full: doc.members.length >= H.LIMITS.members, already: a.mid ? doc.id : null,
    seats: doc.members.filter(H.isOpen).map((m) => ({ id: m.id, name: m.name, emoji: m.emoji })),
    takenEmoji: doc.members.map((m) => m.emoji),
  });
}));

app.post('/api/join/:code', route('Could not join.', async (req, res) => {
  countWrite(req);
  const b = req.body || {};
  const ip = ipKey(req);
  const doc = await homeByCode(req);
  const pre = actorOf(req, doc);
  if (!pre.mid && newMembers.blocked(ip)) throw httpError(429, 'Too many new people from here. Try again later.');
  const key = mintKey(req, res);
  const hash = H.keyHash(key, doc.id);
  const tag = tagOf(req);
  let r = null;
  await store.transact('homes', doc.id, (cur) => {
    if (!cur) throw httpError(404, 'That household has closed.');
    const d = JSON.parse(JSON.stringify(cur));
    r = H.join(d, { hash, tag, seat: typeof b.seat === 'string' ? b.seat : null, name: b.name, emoji: b.emoji }, Date.now());
    return d;
  });
  if (r.isNew) newMembers.hit(ip);
  res.json({ homeId: doc.id, me: r.mid, isNew: r.isNew });
}));

/* ------------------------------------------------------------------ *
 * A household, as its members see it
 * ------------------------------------------------------------------ */

/** Poll: the household and its weeks. `?since=<v>&week=<key>` answers
 *  {same: true} when nothing moved and it is still the same week, so an
 *  idle household costs one read. */
app.get('/api/homes/:hid', route('Could not load the household.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { home, actor } = await memberHome(req);
  const now = Date.now();
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === (home.v || 0) && req.query.week === Core.weekKey(now, home.tz)) return res.json({ same: true, v: home.v || 0 });
  res.json(await bundle(home, actor, now));
}));

/** People: your own name, emoji, can't-do and least-liked; the host sets
 *  anyone's, and how much each person takes on. */
app.patch('/api/homes/:hid/members/:mid', route('Could not save that.', async (req, res) => {
  const { home, actor } = await homeChange(req, (d, a) => { H.editMember(d, a, String(req.params.mid), req.body || {}, Date.now()); });
  res.json(await bundle(home, actor));
}));
app.post('/api/homes/:hid/members', route('Could not add them.', async (req, res) => {
  const { home, actor } = await homeChange(req, (d, a) => { H.addSeat(d, a, req.body || {}, Date.now()); });
  res.json(await bundle(home, actor));
}));
/** The host removes someone, or someone leaves. The week is re-dealt
 *  without them; what they already ticked stays theirs in the history. */
app.delete('/api/homes/:hid/members/:mid', route('Could not remove them.', async (req, res) => {
  const mid = String(req.params.mid || '');
  const { home, actor } = await homeChange(req, (d, a) => { H.remove(d, a, mid, Date.now()); });
  if (mid === actor.mid) return res.json({ ok: true, left: true });
  res.json(await bundle(home, actor));
}));

/** Chores: anyone in the household. */
app.post('/api/homes/:hid/chores', route('Could not add that.', async (req, res) => {
  const b = req.body || {};
  const { home, actor } = await homeChange(req, (d) => H.addChores(d, Array.isArray(b.chores) ? b.chores : [b], Date.now()));
  res.json(await bundle(home, actor));
}));
app.patch('/api/homes/:hid/chores/:cid', route('Could not save that.', async (req, res) => {
  const { home, actor } = await homeChange(req, (d) => { H.editChore(d, String(req.params.cid), req.body || {}, Date.now()); });
  res.json(await bundle(home, actor));
}));
app.delete('/api/homes/:hid/chores/:cid', route('Could not take that off.', async (req, res) => {
  const { home, actor } = await homeChange(req, (d) => { H.removeChore(d, String(req.params.cid), Date.now()); });
  res.json(await bundle(home, actor));
}));

/* ------------------------------------------------------------------ *
 * Ticks and swaps: each writes ONE key of this week's document, inside a
 * transaction - two phones ticking at once both stick, and one swap offer
 * has one taker.
 * ------------------------------------------------------------------ */

async function weekWrite(req, fn) {
  countWrite(req);
  const { home, actor } = await memberHome(req);
  const now = Date.now();
  const { week } = await weekDocs(home, now);
  await store.transactKeys('weeks', H.weekId(home.id, week), (cur) => {
    if (!cur) throw httpError(409, 'This week just changed - try again.');
    return fn(home, stripWeek(cur), actor, now);
  });
  await bumpHome(home.id);
  return bundle({ ...home, v: (home.v || 0) + 1 }, actor);
}
const slotParam = (req) => String(req.params.slot || '');

app.put('/api/homes/:hid/ticks/:slot', route('Could not tick that.', async (req, res) => {
  res.json(await weekWrite(req, (home, doc, actor, now) => Core.tick(home, doc, slotParam(req), actor, now)));
}));
app.delete('/api/homes/:hid/ticks/:slot', route('Could not undo that.', async (req, res) => {
  res.json(await weekWrite(req, (home, doc) => Core.untick(home, doc, slotParam(req))));
}));
app.post('/api/homes/:hid/swaps/:slot', route('Could not save that.', async (req, res) => {
  const action = String((req.body || {}).action || '');
  if (!['offer', 'cancel', 'claim'].includes(action)) throw httpError(400, 'Offer, cancel or claim.');
  res.json(await weekWrite(req, (home, doc, actor, now) => Core.swap(home, doc, slotParam(req), actor, action, now)));
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A household link (h/<id>) and a join link (j/<code>) are the same
// single-page app served one level down; <base href="../"> resolves every
// relative asset and API path against the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function deepIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
for (const p of ['/h/:id', '/j/:code']) {
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
  // CHORUS_DEV_MOUNT=/chorus runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.CHORUS_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`chorus listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
