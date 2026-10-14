// Settle - where are we eating? Everyone swipes, nobody argues. See CLAUDE.md.
//
// A decision is made by a browser with NO account: the creator types a
// question and some options (or picks a built-in deck), shares a link, a QR
// code or a six-character code, and everyone swipes Yes / No / Love (or ranks
// a top 3) on their own phone - also with no account. The browser is
// recognised by an HttpOnly key, stored only as a hash per decision.
//
// A model is used for ONE thing, metered and signed in: "Fill the deck for
// me" - a short ask turned into 8-20 options. Everything else - the decks,
// the votes, the vetoes, the match, the runoff, the tie-break wheel - is the
// core file and costs nothing.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/settle-core');
const D = require('./lib/decisions');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.SETTLE_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('SETTLE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A join code and a decision id are keys. They must not ride out in a
  // Referer header, and a decision should never be indexed.
  if (/^\/(d|j)\//.test(req.path) || /^\/api\/(d|join|decisions)(\/|$)/.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// The metered route mounts its own 16 KB parser AFTER sign-in, budget and
// the daily cap, so a stranger's body is never read. Everything else 32 KB
// (a decision with thirty options and notes fits with room to spare).
const suggestJson = express.json({ limit: '16kb' });
const smallJson = express.json({ limit: '32kb' });
app.use((req, res, next) => {
  if (req.path === '/api/suggest') return next();
  return smallJson(req, res, next);
});

/* ------------------------------------------------------------------ *
 * The shared account (only "Fill the deck for me" needs it)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'settle',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Settle',
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

/* ------------------------------------------------------------------ *
 * Errors: only the app's own (marked `expose`) reach the page in their own
 * words. Anything else is logged - the first lines of its stack, never a
 * body: what a group is choosing and who voted for what are nobody's
 * business - and answered with the route's fallback. A provider error is a
 * 502, or 503 when it is busy.
 * ------------------------------------------------------------------ */

const httpError = D.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - the decks and typing your own still work.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
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
const newDecisions = identityLib.createLimiter({ max: D.LIMITS.decisionsPerIp, windowMs: D.LIMITS.decisionsWindowMs });
const newVoters = identityLib.createLimiter({ max: D.LIMITS.newVotersPerIp, windowMs: D.LIMITS.newVotersWindowMs });
const writes = identityLib.createLimiter({ max: D.LIMITS.writesPerIp, windowMs: D.LIMITS.writesWindowMs });

// A wrong code or id counts once per DISTINCT value: a phone left open on a
// deleted decision polls the same dead id every few seconds, and that is not
// guessing. Guessing needs many different codes.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > D.LIMITS.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, what) {
  const e = missState(ip);
  e.seen.add(what);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
function checkMisses(req) {
  if (missState(ipKey(req)).seen.size >= D.LIMITS.missesPerIp) throw httpError(429, 'Too many wrong codes from here. Try again in a few minutes.');
}
function countWrite(req) {
  if (!writes.hit(ipKey(req))) throw httpError(429, 'That’s a lot of taps from here. Wait a minute and try again.');
}

/* ------------------------------------------------------------------ *
 * Who is asking: this browser's key (an HttpOnly cookie, 22 characters,
 * stored only as sha256(key + decision id)).
 * ------------------------------------------------------------------ */

const KEY_COOKIE = 'settle_k';
function readKey(req) {
  const m = /(?:^|;\s*)settle_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintKey(req, res) {
  const have = readKey(req);
  if (have) return have;
  const key = D.newKey();
  res.append('Set-Cookie', `${KEY_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}

/** The decision, if the id names a live one. One nobody has touched in 14
 *  days is deleted by the read that finds it (there is no timer). */
async function loadDecision(req) {
  checkMisses(req);
  const id = String(req.params.id || '');
  const doc = D.isId(id) ? await store.get('decisions', id) : null;
  if (!doc) { missed(ipKey(req), `d:${id.slice(0, 20)}`); throw httpError(404, 'Nothing here.'); }
  if (D.idle(doc, Date.now())) { await store.remove('decisions', doc.id); throw httpError(404, 'Nothing here.'); }
  return doc;
}
/** The decision and who is asking - and a stranger gets the same 404 a
 *  decision that does not exist gets, so nobody learns an id is real. */
async function memberDecision(req) {
  const doc = await loadDecision(req);
  const actor = D.actorOf(doc, readKey(req));
  if (!actor.vid && !actor.host) throw httpError(404, 'Nothing here.');
  return { doc, actor };
}

/** Every vote: read the decision inside a transaction, let the core decide,
 *  then write ONLY the keys it changed (and the version). Many phones at
 *  once never write back a copy missing someone else's vote. */
async function voteWrite(req, fn) {
  countWrite(req);
  const { doc } = await memberDecision(req);
  const key = readKey(req);
  const now = Date.now();
  let out = null;
  let actor = null;
  await store.transactKeys('decisions', doc.id, (cur) => {
    if (!cur) throw httpError(404, 'Nothing here.');
    actor = D.actorOf(cur, key);
    if (!actor.vid && !actor.host) throw httpError(404, 'Nothing here.');
    out = fn(cur, actor, now);
    return { set: { ...out.patch.set, ...D.touchKeys(cur, now) }, del: out.patch.del };
  });
  const fresh = await store.get('decisions', doc.id);
  return { d: D.view(fresh, actor, now), msg: out.msg || '', ...(out.status ? { status: out.status } : {}) };
}
const hostOnly = (fn) => (cur, actor, now) => { if (!actor.host) throw httpError(404, 'Nothing here.'); return fn(cur, actor, now); };
const voterOnly = (fn) => (cur, actor, now) => { if (!actor.vid) throw httpError(404, 'Nothing here.'); return fn(cur, actor, now); };

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: Core.LIMITS, decks: Core.DECKS.map((d) => ({ id: d.id, name: d.name, emoji: d.emoji, count: d.items.length })) });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier });
});

/* ------------------------------------------------------------------ *
 * Metered: fill the deck for me
 * ------------------------------------------------------------------ */

/** Gates, then a 16 KB parser, then the ask checked (a 400 costs
 *  nothing), then one forced tool. The ask is read once and dropped;
 *  nothing here writes to the store. */
app.post('/api/suggest', ...spend, suggestJson, route('Ideas aren’t available right now. Try again in a minute - the decks still work.', async (req, res) => {
  const b = req.body || {};
  const prompt = ai.cleanPrompt(b.prompt);
  const have = ai.cleanHave(b.have);
  const options = ai.cleanSuggestions(await ai.suggest(await clientFor(req), modelFor(req), { prompt, have }), have);
  if (options.length < Core.LIMITS.suggestMin) throw httpError(422, 'Nothing usable came back. Try saying it another way - “board games for six adults”.');
  res.set('Cache-Control', 'no-store');
  res.json({ options });
}));

/* ------------------------------------------------------------------ *
 * Starting a decision: no account
 * ------------------------------------------------------------------ */

async function freshCode() {
  for (let i = 0; i < 8; i++) {
    const c = D.newCode();
    if (!(await store.list('decisions', { where: [['code', '==', c]], limit: 1 })).length) return c;
  }
  throw httpError(503, 'Could not make a code. Try again.');
}

app.post('/api/decisions', route('Could not start that decision.', async (req, res) => {
  countWrite(req);
  const ip = ipKey(req);
  if (newDecisions.blocked(ip)) throw httpError(429, `That’s ${D.LIMITS.decisionsPerIp} new decisions from here this hour. Try again later - or re-open one you made.`);
  const b = req.body || {};
  const now = Date.now();
  const hostVid = Core.newVoterId(D.rand);
  const doc = Core.newDecision(b, { now, hostVid });
  const key = mintKey(req, res);
  const id = D.newId();
  doc.code = await freshCode();
  doc.hostHash = D.keyHash(key, id);
  doc.voters[hostVid].keyHash = doc.hostHash;
  await store.transact('decisions', id, (cur) => { if (cur) throw httpError(409, 'Try again.'); return doc; });
  newDecisions.hit(ip);
  // "Settle another with the same people": the old decision points at this
  // one, so everyone still on its reveal gets a one-tap way in.
  const after = typeof b.after === 'string' && D.isId(b.after) ? b.after : null;
  if (after) {
    await store.transactKeys('decisions', after, (cur) => {
      if (!cur || cur.hostHash !== D.keyHash(key, after)) return undefined;
      return { set: { next: { code: doc.code, question: doc.question }, ...D.touchKeys(cur, now) }, del: [] };
    }).catch(() => null);
  }
  res.json({ id, d: D.view({ ...doc, id }, { vid: hostVid, host: true }, now) });
}));

/* ------------------------------------------------------------------ *
 * Joining: no account
 * ------------------------------------------------------------------ */

async function byCode(req) {
  checkMisses(req);
  const code = D.normalizeCode(req.params.code);
  const rows = D.isCode(code) ? await store.list('decisions', { where: [['code', '==', code]], limit: 1 }) : [];
  const doc = rows[0];
  if (!doc) { missed(ipKey(req), `j:${code}`); throw httpError(404, 'No decision has that code. Check it with whoever sent it - it’s under their QR code.'); }
  if (D.idle(doc, Date.now())) { await store.remove('decisions', doc.id); throw httpError(404, 'That decision has expired.'); }
  return doc;
}

/** What a code opens: the question, how many options and how it's decided,
 *  how many are in - not who, not anyone's votes. */
app.get('/api/join/:code', route('Could not look that up.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await byCode(req);
  const a = D.actorOf(doc, readKey(req));
  const st = Core.status(doc, Date.now());
  res.json({
    question: doc.question, mode: doc.mode, options: Core.live(doc).length, named: Boolean(doc.named), vetoes: Core.vetoesOn(doc),
    joined: st.joined, max: doc.max || null, open: st.open, full: st.joined >= Core.LIMITS.voters || Boolean(doc.max && st.joined >= doc.max),
    deadline: doc.deadline || null, already: a.vid || a.host ? doc.id : null,
    preview: Core.live(doc).slice(0, 4).map((id) => { const o = Core.optionOf(doc, id); return { label: o.label, emoji: o.emoji }; }),
  });
}));

app.post('/api/join/:code', route('Could not join.', async (req, res) => {
  countWrite(req);
  const b = req.body || {};
  const ip = ipKey(req);
  const doc = await byCode(req);
  const pre = D.actorOf(doc, readKey(req));
  if (pre.vid) return res.json({ id: doc.id, me: pre.vid, isNew: false });
  if (newVoters.blocked(ip)) throw httpError(429, 'Too many new people from here. Try again later.');
  const key = mintKey(req, res);
  const hash = D.keyHash(key, doc.id);
  const vid = Core.newVoterId(D.rand);
  let mine = null;
  await store.transactKeys('decisions', doc.id, (cur) => {
    if (!cur) throw httpError(404, 'That decision has expired.');
    const already = Object.keys(cur.voters || {}).find((v) => cur.voters[v].keyHash === hash);
    if (already) { mine = already; return undefined; }
    const r = Core.join(cur, { vid, name: b.name, keyHash: hash }, Date.now());
    mine = vid;
    return { set: { ...r.patch.set, ...D.touchKeys(cur, Date.now()) }, del: [] };
  });
  if (mine === vid) newVoters.hit(ip);
  res.json({ id: doc.id, me: mine, isNew: mine === vid });
}));

/* ------------------------------------------------------------------ *
 * A decision, as its members see it
 * ------------------------------------------------------------------ */

/** Poll: `?since=<v>` answers {same: true} when nothing moved (and no
 *  deadline has passed since), so an idle decision costs one read. */
app.get('/api/d/:id', route('Could not load that.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { doc, actor } = await memberDecision(req);
  const now = Date.now();
  const since = Number(req.query.since);
  const deadlinePassed = doc.deadline && !doc.closed && now >= doc.deadline;
  if (Number.isInteger(since) && since === (doc.v || 0) && !deadlinePassed) return res.json({ same: true, v: doc.v || 0 });
  res.json({ d: D.view(doc, actor, now) });
}));

/** A swipe: one option, Yes / No / Love (or null to take it back). */
app.put('/api/d/:id/vote', route('Could not save that swipe.', async (req, res) => {
  const b = req.body || {};
  const oid = String(b.oid || '');
  const v = b.v === null ? null : String(b.v || '');
  res.json(await voteWrite(req, voterOnly((cur, a, now) => Core.swipe(cur, a.vid, oid, v, now))));
}));
/** A top 3, in order (rank mode). */
app.put('/api/d/:id/rank', route('Could not save your top 3.', async (req, res) => {
  const order = Array.isArray((req.body || {}).order) ? req.body.order.slice(0, 10).map(String) : [];
  res.json(await voteWrite(req, voterOnly((cur, a, now) => Core.rank(cur, a.vid, order, now))));
}));
/** Your one veto (null takes it back). First come: the second veto of the
 *  same option changes nothing and its voter keeps theirs. */
app.put('/api/d/:id/veto', route('Could not save that veto.', async (req, res) => {
  const b = req.body || {};
  const oid = b.oid === null ? null : String(b.oid || '');
  res.json(await voteWrite(req, voterOnly((cur, a, now) => Core.veto(cur, a.vid, oid, now))));
}));
/** The host closes voting now - the reveal. */
app.post('/api/d/:id/close', route('Could not close it.', async (req, res) => {
  res.json(await voteWrite(req, hostOnly((cur, _a, now) => Core.close(cur, now))));
}));
/** The host re-opens with the top 3, for a second round. */
app.post('/api/d/:id/reopen', route('Could not re-open it.', async (req, res) => {
  res.json(await voteWrite(req, hostOnly((cur, _a, now) => Core.reopenTop({ ...cur }, now))));
}));
app.delete('/api/d/:id', route('Could not delete it.', async (req, res) => {
  countWrite(req);
  const { doc, actor } = await memberDecision(req);
  if (!actor.host) throw httpError(404, 'Nothing here.');
  await store.remove('decisions', doc.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A decision link (d/<id>) and a join link (j/<code>) are the same
// single-page app served one level down; <base href="../"> resolves every
// relative asset and API path against the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function deepIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
for (const p of ['/d/:id', '/j/:code']) {
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
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // SETTLE_DEV_MOUNT=/settle runs it the way the lab host does: mounted under
  // a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.SETTLE_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`settle listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
