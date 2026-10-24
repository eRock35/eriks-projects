// Pawlog - fed? walked? meds given? The whole house knows. See CLAUDE.md.
//
// The rules - routines and what is due, the Today board, the double-done
// guard, undo, medicines, health records, the week, the calendar file and
// what each link shows - live in public/pawlog-core.js and run on the phone
// too: a household that is only on one phone (and the sample home) never
// reaches this server at all. This holds:
//
//   - shared homes: the owner shares their household (no account), keeps a
//     key on their phone, and hands out one household link everyone opens
//     with no account, plus sitter links that close on a chosen day;
//   - signed in (free): the owner's household (or the keys to the shared
//     one) is kept in their account, so it follows them to another phone;
//   - "Read the vet paperwork", the one model call, metered.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/pawlog-core');
const H = require('./lib/homes');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.PAWLOG_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('PAWLOG_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A household or sitter code is a key to someone's home routine. It must
  // not ride out in a Referer header, and none of these pages should be
  // indexed.
  if (/^\/(h|s|o)\//.test(req.path) || /^\/api\/(homes|l)(\/|$)/.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// The metered route mounts its own 9 MB parser AFTER sign-in, budget and the
// daily cap, so a stranger's photo is never read. Sharing a whole household
// and keeping it in an account mount 512 KB on their own routes; everything
// else 64 KB.
const paperJson = express.json({ limit: '9mb' });
const homeJson = express.json({ limit: '512kb' });
const smallJson = express.json({ limit: '64kb' });
const BIG = new Set(['/api/read-paperwork', '/api/mine', '/api/homes']);
app.use((req, res, next) => (BIG.has(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (sync and "Read the vet paperwork" need it)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'pawlog',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Pawlog',
  mountPath: '/api/auth',
});
identity.mount(app);

// The fake (local runs and tests only) is kept so a test can read what it
// was sent.
const fakeClient = FAKE_AI ? require('./lib/fakeai').create() : null;
const sharedClient = FAKE_AI
  ? identity.meter(fakeClient)
  : identity.meter(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

function clientFor(req) {
  if (FAKE_AI) return Promise.resolve(sharedClient);
  return identity.clientFor(req.user, sharedClient, (apiKey) => new Anthropic({ apiKey }));
}
const modelFor = (req) => identityLib.planFor(req.user, MODELS).model;

// Never put a model call behind a sign-in alone: it goes through the budget
// and the free tier's daily ceiling as well.
const spend = [identity.requireUser, identity.requireBudget, identity.requireDailyCap];

/* ------------------------------------------------------------------ *
 * Errors: only the app's own (marked `expose`) reach the page in their own
 * words. Anything else is logged - the first lines of its stack, never a
 * body: a household's routine and its pets' health are nobody else's
 * business - and answered with the route's fallback. A provider error is a
 * 502, or 503 when busy.
 * ------------------------------------------------------------------ */

const httpError = H.httpError;
const EXTRA = ['code', 'by', 'at', 'when', 'mine', 'key', 'dose'];
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  const body = { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - you can add records by hand meanwhile.' : fallback) };
  if (mine) for (const k of EXTRA) if (err[k] !== undefined) body[k] = err[k];
  return { status, body };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/* ------------------------------------------------------------------ *
 * Limits, per address and per instance, in memory: they slow a script,
 * they do not stop a determined one - CLAUDE.md says so.
 * ------------------------------------------------------------------ */

function ipKey(req) {
  const ip = identityLib.clientIp(req);
  if (ip.includes(':') && !ip.includes('.')) return ip.split(':').slice(0, 4).join(':'); // IPv6 by its /64
  return ip;
}
const opens = identityLib.createLimiter({ max: H.LIMITS.homesPerIp, windowMs: H.LIMITS.homesWindowMs });
const opensAll = identityLib.createLimiter({ max: H.LIMITS.homesPerInstance, windowMs: H.LIMITS.homesWindowMs });
const writes = identityLib.createLimiter({ max: H.LIMITS.writesPerIp, windowMs: H.LIMITS.writesWindowMs });
const joins = identityLib.createLimiter({ max: H.LIMITS.joinsPerIp, windowMs: H.LIMITS.joinsWindowMs });
const saves = identityLib.createLimiter({ max: H.LIMITS.savesPerAccount, windowMs: H.LIMITS.savesWindowMs });

// A wrong code counts once per DISTINCT value: a phone left open on a link
// that was replaced asks for the same dead code again, and that is not
// guessing.
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
  if (missState(ipKey(req)).seen.size >= H.LIMITS.missesPerIp) throw httpError(429, 'Too many wrong links from here. Try again in a few minutes.');
}
function countWrite(req) {
  if (!writes.hit(ipKey(req))) throw httpError(429, 'That’s a lot of taps from here. Wait a minute and try again.');
}

/* ------------------------------------------------------------------ *
 * Who is asking
 * ------------------------------------------------------------------ */

// This phone's key: an HttpOnly cookie scoped to the app, minted when it
// shares a home. A home keeps only a hash of it (the creator tag), to count
// how many live homes one phone runs. Links need no cookie.
function readDevice(req) {
  const m = /(?:^|;\s*)pawlog_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintDevice(req, res) {
  const have = readDevice(req);
  if (have) return have;
  const key = H.newKey();
  res.append('Set-Cookie', `pawlog_k=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}
/** The owner's key rides in a header, never in a URL the server sees. */
function ownerKey(req) {
  const k = req.get('X-Pawlog-Key');
  return H.isKey(k) ? k : null;
}
function isOwner(doc, req) {
  const k = ownerKey(req);
  return Boolean(k) && H.sameHash(H.ownerHash(k, doc.code), doc.ownerHash);
}

const GONE = 'There’s no household at that link. It may have been replaced with a new one, closed, or it expired - ask for the current link.';
/** Delete a home and every link to it. */
async function dropHome(doc) {
  if (doc.link) await store.remove('links', doc.link);
  for (const c of Object.keys(doc.sitters || {})) await store.remove('links', c);
  await store.remove('homes', doc.code);
}
/** A home by its own code, for the owner's key only; anyone else gets the
 *  404 a missing code gets. One past its expiry is deleted by the read that
 *  finds it (there is no timer). */
async function loadOwned(req) {
  checkMisses(req);
  const code = H.normalizeCode(req.params.code);
  const doc = H.isCode(code) ? await store.get('homes', code) : null;
  if (!doc || !isOwner(doc, req)) { missed(ipKey(req), code || String(req.params.code || '').slice(0, 16)); throw httpError(404, GONE); }
  if (H.expired(doc, Date.now())) { await dropHome(doc); throw httpError(404, GONE); }
  return doc;
}
/** A link: the home it names and the role, if the home still carries this
 *  code for that role - and, for a sitter, if the link's day has not ended.
 *  Unknown, malformed, replaced, closed and expired all read the same. */
async function loadLink(req) {
  checkMisses(req);
  const code = H.normalizeCode(req.params.code);
  const link = H.isCode(code) ? await store.get('links', code) : null;
  const doc = link && ['member', 'sitter'].includes(link.role) && H.isCode(link.home) ? await store.get('homes', link.home) : null;
  const live = doc && (link.role === 'member' ? doc.link === code : Boolean(doc.sitters && doc.sitters[code]));
  if (!live) { missed(ipKey(req), code || String(req.params.code || '').slice(0, 16)); throw httpError(404, GONE); }
  if (H.expired(doc, Date.now())) { await dropHome(doc); throw httpError(404, GONE); }
  if (link.role === 'sitter' && Date.parse(doc.sitters[code].expiresAt) <= Date.now()) {
    await change(doc.code, (d) => { delete d.sitters[code]; });
    await store.remove('links', code);
    throw httpError(404, GONE);
  }
  return { doc, role: link.role, code, sitter: link.role === 'sitter' ? { code, ...doc.sitters[code] } : null };
}
/** Change a home inside a transaction: read, run the rules, write. Every
 *  write pushes the expiry out again and drops expired sitter links. */
async function change(code, fn) {
  let out = null;
  let result = null;
  await store.transact('homes', code, (cur) => {
    if (!cur || H.expired(cur, Date.now())) throw httpError(404, GONE);
    const doc = { ...cur };
    delete doc.id;
    doc.sitters = { ...(doc.sitters || {}) };
    result = fn(doc);
    H.extend(doc, Date.now());
    out = doc;
    return doc;
  });
  return { doc: out, result };
}
function sittersOf(doc, now) {
  return Object.entries(doc.sitters || {}).filter(([, s]) => Date.parse(s.expiresAt) > now)
    .map(([code, s]) => ({ code, name: s.name, until: s.until })).sort((a, b) => (a.until < b.until ? -1 : 1));
}
function ownerOut(doc) {
  const now = Date.now();
  return { role: 'owner', code: doc.code, link: doc.link, expiresAt: doc.expiresAt, sitters: sittersOf(doc, now), home: Core.memberView(doc) };
}
function linkOut(doc, role, sitter) {
  return role === 'sitter' ? { role, home: Core.sitterView(doc, sitter, Date.now()) } : { role, home: Core.memberView(doc) };
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: { ...Core.LIMITS, homesPerDevice: H.LIMITS.openPerCreator }, kinds: Core.KINDS, tasks: Core.TASKS, health: Core.HEALTH_TYPES });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Shared homes: no account to share one, none to open a link
 * ------------------------------------------------------------------ */

async function openCount(tag, now) {
  const rows = await store.list('homes', { where: [['creator', '==', tag]], limit: H.LIMITS.openPerCreator * 4 });
  return rows.filter((r) => !H.expired(r, now)).length;
}
/** A fresh link code no other link holds. */
async function freshLink(homeCode, role) {
  for (let i = 0; i < 5; i++) {
    const code = H.newCode();
    try {
      await store.transact('links', code, (cur) => { if (cur) throw Object.assign(new Error('taken'), { taken: true }); return { home: homeCode, role }; });
      return code;
    } catch (e) { if (!e.taken) throw e; }
  }
  throw httpError(503, 'Could not find a free link. Try again.');
}

/** Share a household: {home} as this phone holds it. The sample stays on
 *  the phone. */
app.post('/api/homes', (req, res, next) => {
  try {
    countWrite(req);
    const ip = ipKey(req);
    if (opens.blocked(ip)) throw httpError(429, `That’s ${H.LIMITS.homesPerIp} shared homes from here this hour. Try again later.`);
    if (opensAll.blocked('all')) throw httpError(429, 'Lots of homes are being shared right now. Try again in a few minutes.');
  } catch (err) { return fail(res, err); }
  return next();
}, homeJson, route('Could not share that household.', async (req, res) => {
  const ip = ipKey(req);
  const raw = (req.body || {}).home;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Send the household.');
  if (raw.sample === true) throw httpError(400, 'The sample home stays on this phone - start your own to share it.');
  const now = Date.now();
  const home = Core.cleanHome(raw, now, raw.tz);
  if (!home.pets.length) throw httpError(400, 'Add a pet first.');
  if (!home.members.length) throw httpError(400, 'Add your first name first.');
  const device = mintDevice(req, res);
  const creator = H.deviceTag(device);
  if (await openCount(creator, now) >= H.LIMITS.openPerCreator) throw httpError(429, `This phone shares ${H.LIMITS.openPerCreator} homes already. Delete one first.`);
  const key = H.newKey();
  let saved = null;
  for (let i = 0; i < 5 && !saved; i++) {
    const code = H.newCode();
    const fresh = H.extend({ ...home, v: 1, code, ownerHash: H.ownerHash(key, code), creator, link: null, sitters: {} }, now);
    try {
      await store.transact('homes', code, (cur) => { if (cur) throw Object.assign(new Error('taken'), { taken: true }); return fresh; });
      saved = fresh;
    } catch (e) { if (!e.taken) throw e; }
  }
  if (!saved) throw httpError(503, 'Could not find a free code. Try again.');
  const link = await freshLink(saved.code, 'member');
  const { doc } = await change(saved.code, (d) => { d.link = link; });
  opens.hit(ip);
  opensAll.hit('all');
  res.set('Cache-Control', 'no-store');
  res.json({ key, ...ownerOut(doc) });
}));

/** The home, for the owner's key. `?since=v` answers {same: true} when
 *  nothing moved - a poll every 20 seconds is one small read. */
app.get('/api/homes/:code', route('Could not load that household.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await loadOwned(req);
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === doc.v) return res.json({ same: true, v: doc.v });
  res.json(ownerOut(doc));
}));

function checkJoin(req, b) {
  if (b.action === 'join' && !joins.hit(ipKey(req))) throw httpError(429, 'That’s a lot of new names from here. Try again later.');
}

/** The owner's changes: every rule in the core, plus the links - replace
 *  the household link, open a sitter link until a day, close one. */
app.post('/api/homes/:code/act', route('Could not save that.', async (req, res) => {
  countWrite(req);
  const doc0 = await loadOwned(req);
  const b = req.body || {};
  if (typeof b.action !== 'string') throw httpError(400, 'Unknown change.');
  checkJoin(req, b);
  if (b.action === 'relink') {
    const code = await freshLink(doc0.code, 'member');
    let old = null;
    const { doc } = await change(doc0.code, (d) => { old = d.link; d.link = code; d.v = (d.v || 0) + 1; });
    if (old) await store.remove('links', old);
    return res.json({ result: { link: code }, ...ownerOut(doc) });
  }
  if (b.action === 'sitter') {
    const name = Core.firstName(b.name);
    if (!name) throw httpError(400, 'Add the sitter’s first name.');
    const today = Core.zoned(Date.now(), doc0.tz).day;
    if (!Core.isDay(b.until) || b.until < today || b.until > Core.addDays(today, Core.LIMITS.sitterDays)) throw httpError(400, `Pick the last day - today or up to ${Core.LIMITS.sitterDays} days ahead.`);
    if (sittersOf(doc0, Date.now()).length >= Core.LIMITS.sitterLinks) throw httpError(409, `That’s ${Core.LIMITS.sitterLinks} sitter links open. Close one first.`);
    const code = await freshLink(doc0.code, 'sitter');
    const expiresAt = new Date(Core.instantOf(Core.addDays(b.until, 1), 0, doc0.tz)).toISOString();
    const { doc } = await change(doc0.code, (d) => {
      for (const [c, s] of Object.entries(d.sitters)) if (Date.parse(s.expiresAt) <= Date.now()) delete d.sitters[c];
      if (Object.keys(d.sitters).length >= Core.LIMITS.sitterLinks) throw httpError(409, `That’s ${Core.LIMITS.sitterLinks} sitter links open. Close one first.`);
      d.sitters[code] = { name, until: b.until, expiresAt };
      d.v = (d.v || 0) + 1;
    });
    return res.json({ result: { sitter: code }, ...ownerOut(doc) });
  }
  if (b.action === 'unsitter') {
    const code = H.normalizeCode(b.code);
    const { doc } = await change(doc0.code, (d) => { delete d.sitters[code]; d.v = (d.v || 0) + 1; });
    if (H.isCode(code)) await store.remove('links', code);
    return res.json({ result: { closed: code }, ...ownerOut(doc) });
  }
  const { doc, result } = await change(doc0.code, (d) => Core.act(d, { role: 'owner' }, b.action, b, Date.now(), H.ids));
  res.json({ result, ...ownerOut(doc) });
}));

app.delete('/api/homes/:code', route('Could not delete that.', async (req, res) => {
  countWrite(req);
  const doc = await loadOwned(req);
  await dropHome(doc);
  res.json({ ok: true });
}));

/** A link: the household's whole board, or a sitter's slice of it. */
app.get('/api/l/:code', route('Could not load that link.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { doc, role, sitter } = await loadLink(req);
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === doc.v) return res.json({ same: true, v: doc.v });
  res.json(linkOut(doc, role, sitter));
}));

/** What a link may change: everyone in the household all of the care; a
 *  sitter ticks things off and takes back their own tick. */
app.post('/api/l/:code/act', route('Could not save that.', async (req, res) => {
  countWrite(req);
  const { doc: doc0, role, sitter } = await loadLink(req);
  const b = req.body || {};
  if (typeof b.action !== 'string') throw httpError(400, 'Unknown change.');
  checkJoin(req, b);
  const { doc, result } = await change(doc0.code, (d) => Core.act(d, { role, sitter }, b.action, b, Date.now(), H.ids));
  res.json({ result, ...linkOut(doc, role, sitter) });
}));

/* ------------------------------------------------------------------ *
 * Signed in, free: the owner's household follows them to another phone
 * ------------------------------------------------------------------ */

function accountTag(req) {
  if (!SECRET()) throw httpError(503, 'Syncing isn’t available right now. Your household is safe on this phone.');
  return H.accountTag(req.user.id, SECRET());
}
function accountView(doc) {
  if (!doc) return { home: null, shared: null, updatedAt: null };
  return { home: doc.home || null, shared: doc.shared || null, updatedAt: doc.updatedAt || null };
}

app.get('/api/mine', identity.requireUser, route('Could not load your household.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await store.get('accounts', accountTag(req));
  res.json(accountView(doc));
}));

/** Keep this phone's household in the account: the whole thing while it is
 *  only on the phone ({home}), or the keys to the shared one ({shared}). A
 *  copy older than the account's is refused, so a stale phone cannot undo a
 *  newer one; the sample never comes along. */
app.put('/api/mine', identity.requireUser, homeJson, route('Could not save that. It is still on this phone.', async (req, res) => {
  const tag = accountTag(req);
  if (!saves.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - it’s all still on this phone.');
  const b = req.body || {};
  const now = Date.now();
  const at = Number.isFinite(b.updatedAt) && b.updatedAt > 0 && b.updatedAt <= now + 60000 ? Math.round(b.updatedAt) : now;
  let next;
  if (b.shared) {
    const code = H.normalizeCode(b.shared.code);
    if (!H.isCode(code) || !H.isKey(b.shared.key)) throw httpError(400, 'That isn’t a shared household.');
    next = { home: null, shared: { code, key: b.shared.key }, updatedAt: at };
  } else if (b.home && typeof b.home === 'object' && !Array.isArray(b.home)) {
    if (b.home.sample === true) throw httpError(400, 'The sample home stays on this phone.');
    const home = Core.cleanHome(b.home, now, b.home.tz);
    if (!home.pets.length) throw httpError(400, 'Add a pet first.');
    next = { home, shared: null, updatedAt: at };
  } else throw httpError(400, 'Send the household.');
  let out = null;
  let stale = false;
  await store.transact('accounts', tag, (cur) => {
    if (cur && Number(cur.updatedAt || 0) > at) { stale = true; out = cur; return undefined; }
    out = next;
    return next;
  });
  res.json({ ...accountView(out), stale });
}));

/** Forget the account's copy (this phone keeps its own). */
app.delete('/api/mine', identity.requireUser, route('Could not clear it.', async (req, res) => {
  await store.remove('accounts', accountTag(req));
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Metered: "Read the vet paperwork"
 * ------------------------------------------------------------------ */

/** Gates, then the 9 MB parser, then the request checked (a 400 costs
 *  nothing), then one forced tool. The answer is a proposal, validated and
 *  stripped; nothing here writes to the store, and nothing logged carries a
 *  word of the paper. Not streamed: one page reads in seconds. */
app.post('/api/read-paperwork', ...spend, paperJson, route('The paperwork can’t be read right now. Try again in a minute - or add it by hand.', async (req, res) => {
  const b = ai.brief(req.body, photo);
  const today = Core.isDay(req.body && req.body.today) && Math.abs(Core.daysBetween(new Date().toISOString().slice(0, 10), req.body.today)) <= 1 ? req.body.today : new Date().toISOString().slice(0, 10);
  const proposal = ai.cleanProposal(await ai.read(await clientFor(req), modelFor(req), b, today), today);
  if (!proposal.vaccinations.length && !proposal.medicines.length && !proposal.weight && !proposal.nextVisit) {
    throw httpError(422, 'Nothing about vaccinations, medicines, weight or a next visit could be read. Try a clearer photo, or paste the text.');
  }
  res.set('Cache-Control', 'no-store');
  res.json({ proposal: { ...proposal, stripped: proposal.stripped || b.stripped } });
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A household link (h/<CODE>), a sitter link (s/<CODE>) and the owner's own
// link (o/<CODE>#k=...) are the same single-page app served one level down;
// <base href="../"> resolves every relative asset and API path against the
// app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function deepIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get(['/h/:code', '/s/:code', '/o/:code'], (_req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(deepIndex()); });
app.all(['/h/:code', '/s/:code', '/o/:code'], (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));

// The service worker must be re-checked on every load, or a fix would wait
// for its cache to expire. Its scope is this app's base, its own folder.
app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Never log a parse error's message: V8 quotes the start of the body in it.
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // PAWLOG_DEV_MOUNT=/pawlog runs it the way the lab host does: mounted under
  // a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.PAWLOG_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`pawlog listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fakeClient };
