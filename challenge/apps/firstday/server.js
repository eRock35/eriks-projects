// Firstday - a new hire's first week, planned in ten minutes. See CLAUDE.md.
//
// The rules - templates, business-day due dates, readiness, check-ins, the
// views each link gets and the calendar file - live in
// public/firstday-core.js and run on the phone too: the sample cafe hire
// never reaches this server at all. This holds:
//
//   - plans: a manager opens one (no account), keeps a key on their phone,
//     and shares three role links - the new hire's (a welcome page, their
//     to-dos, their check-ins), the buddy's and IT/admin's (their tasks).
//   - "Tailor it to us", the one model call, metered.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/firstday-core');
const P = require('./lib/plans');
const ai = require('./lib/ai');
const { streamedJson } = require('./lib/stream');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.FIRSTDAY_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('FIRSTDAY_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

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
  // A plan or role code is a key to a person's first week. It must not ride
  // out in a Referer header, and none of these pages should be indexed.
  if (/^\/(p|l)\//.test(req.path) || /^\/api\/(plans|l)(\/|$)/.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// The metered route mounts its own 16 KB parser AFTER sign-in, budget and
// the daily cap, so a stranger's body is never read. Everything else 64 KB
// (a plan of 80 tasks copied for the next hire fits with room to spare).
const tailorJson = express.json({ limit: '16kb' });
const smallJson = express.json({ limit: '64kb' });
app.use((req, res, next) => (req.path === '/api/tailor' ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account ("Tailor it to us" needs it; nothing else does)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'firstday',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Firstday',
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
 * body: a new hire's plan is nobody else's business - and answered with
 * the route's fallback. A provider error is a 502, or 503 when busy.
 * ------------------------------------------------------------------ */

const httpError = P.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - the templates work meanwhile.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
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
const opens = identityLib.createLimiter({ max: P.LIMITS.plansPerIp, windowMs: P.LIMITS.plansWindowMs });
const opensAll = identityLib.createLimiter({ max: P.LIMITS.plansPerInstance, windowMs: P.LIMITS.plansWindowMs });
const writes = identityLib.createLimiter({ max: P.LIMITS.writesPerIp, windowMs: P.LIMITS.writesWindowMs });

// A wrong code counts once per DISTINCT value: a phone left open on a plan
// that expired asks for the same dead code again, and that is not guessing.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > P.LIMITS.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, what) {
  const e = missState(ip);
  e.seen.add(what);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
function checkMisses(req) {
  if (missState(ipKey(req)).seen.size >= P.LIMITS.missesPerIp) throw httpError(429, 'Too many wrong links from here. Try again in a few minutes.');
}
function countWrite(req) {
  if (!writes.hit(ipKey(req))) throw httpError(429, 'That’s a lot of changes from here. Wait a minute and try again.');
}

/* ------------------------------------------------------------------ *
 * Who is asking
 * ------------------------------------------------------------------ */

// This phone's key: an HttpOnly cookie scoped to the app, minted when it
// opens a plan. A plan keeps only a hash of it (the creator tag), to count
// how many live plans one phone runs.
function readDevice(req) {
  const m = /(?:^|;\s*)firstday_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintDevice(req, res) {
  const have = readDevice(req);
  if (have) return have;
  const key = P.newKey();
  res.append('Set-Cookie', `firstday_k=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}
/** The manager's key rides in a header, never in a URL the server sees. */
function ownerKey(req) {
  const k = req.get('X-Firstday-Key');
  return P.isKey(k) ? k : null;
}
function isOwner(doc, req) {
  const k = ownerKey(req);
  return Boolean(k) && P.sameHash(P.ownerHash(k, doc.code), doc.ownerHash);
}

const GONE = 'There’s no plan at that link. It may have been deleted, replaced with a new link, or finished - ask the manager for the current one.';
/** Delete a plan and its role links. */
async function dropPlan(doc) {
  for (const r of Core.ROLES) if (doc.links && doc.links[r]) await store.remove('links', doc.links[r]);
  await store.remove('plans', doc.code);
}
/** A plan by its own code, if it names a live one. One past its expiry is
 *  deleted by the read that finds it (there is no timer). Unknown,
 *  malformed and expired all answer the same 404. */
async function loadPlan(req) {
  checkMisses(req);
  const code = P.normalizeCode(req.params.code);
  const doc = P.isCode(code) ? await store.get('plans', code) : null;
  if (!doc) { missed(ipKey(req), code || String(req.params.code || '').slice(0, 16)); throw httpError(404, GONE); }
  if (P.expired(doc, Date.now())) { await dropPlan(doc); throw httpError(404, GONE); }
  return doc;
}
/** A plan the manager's key opens; anyone else gets the 404 a missing code
 *  gets. */
async function loadOwned(req) {
  const doc = await loadPlan(req);
  if (!isOwner(doc, req)) throw httpError(404, GONE);
  return doc;
}
/** A role link: the plan it names and the role, if the plan still carries
 *  this code for that role. */
async function loadLink(req) {
  checkMisses(req);
  const code = P.normalizeCode(req.params.code);
  const link = P.isCode(code) ? await store.get('links', code) : null;
  const doc = link && Core.ROLES.includes(link.role) && P.isCode(link.plan) ? await store.get('plans', link.plan) : null;
  if (!doc || !doc.links || doc.links[link.role] !== code) { missed(ipKey(req), code || String(req.params.code || '').slice(0, 16)); throw httpError(404, GONE); }
  if (P.expired(doc, Date.now())) { await dropPlan(doc); throw httpError(404, GONE); }
  return { doc, role: link.role, code };
}
/** Change a plan inside a transaction: read, run the rules, write. Every
 *  write pushes the expiry out again. */
async function change(code, fn) {
  let out = null;
  let result = null;
  await store.transact('plans', code, (cur) => {
    if (!cur || P.expired(cur, Date.now())) throw httpError(404, GONE);
    const doc = { ...cur };
    delete doc.id;
    result = fn(doc);
    P.extend(doc, Date.now());
    out = doc;
    return doc;
  });
  return { doc: out, result };
}
function managerOut(doc) {
  return { role: 'manager', code: doc.code, expiresAt: doc.expiresAt, links: { ...doc.links }, plan: Core.managerView(doc, Date.now()) };
}
function linkOut(doc, role) { return { role, plan: Core.roleView(doc, role, Date.now()) }; }

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: { ...Core.LIMITS, openPerDevice: P.LIMITS.openPerCreator }, templates: Object.entries(Core.TEMPLATES).map(([id, t]) => ({ id, label: t.label, emoji: t.emoji, blurb: t.blurb })) });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier });
});

/* ------------------------------------------------------------------ *
 * Plans: no account to open one, none to use a link
 * ------------------------------------------------------------------ */

async function openCount(tag, now) {
  const rows = await store.list('plans', { where: [['creator', '==', tag]], limit: P.LIMITS.openPerCreator * 4 });
  return rows.filter((r) => !P.expired(r, now)).length;
}
/** A fresh role-link code no other link holds. */
async function freshLink(planCode, role) {
  for (let i = 0; i < 5; i++) {
    const code = P.newCode();
    try {
      await store.transact('links', code, (cur) => { if (cur) throw Object.assign(new Error('taken'), { taken: true }); return { plan: planCode, role }; });
      return code;
    } catch (e) { if (!e.taken) throw e; }
  }
  throw httpError(503, 'Could not find a free link. Try again.');
}

/** Open a plan: {plan: {hire, role, start, manager, ...}, template?} - or
 *  {plan, tasks} to copy a plan (the sample's, or the last hire's). */
app.post('/api/plans', route('Could not start that plan.', async (req, res) => {
  countWrite(req);
  const ip = ipKey(req);
  if (opens.blocked(ip)) throw httpError(429, `That’s ${P.LIMITS.plansPerIp} new plans from here this hour. Try again later.`);
  if (opensAll.blocked('all')) throw httpError(429, 'Lots of plans are being started right now. Try again in a few minutes.');
  const b = req.body || {};
  const now = Date.now();
  const doc = Core.newDoc(b.plan, { template: b.template, tasks: Array.isArray(b.tasks) ? b.tasks : undefined }, now, P.ids);
  const device = mintDevice(req, res);
  const creator = P.deviceTag(device);
  if (await openCount(creator, now) >= P.LIMITS.openPerCreator) throw httpError(429, `This phone runs ${P.LIMITS.openPerCreator} plans already. Delete a finished one first.`);
  const key = P.newKey();
  let saved = null;
  for (let i = 0; i < 5 && !saved; i++) {
    const code = P.newCode();
    const fresh = P.extend({ ...doc, code, ownerHash: P.ownerHash(key, code), creator, links: {} }, now);
    try {
      await store.transact('plans', code, (cur) => { if (cur) throw Object.assign(new Error('taken'), { taken: true }); return fresh; });
      saved = fresh;
    } catch (e) { if (!e.taken) throw e; }
  }
  if (!saved) throw httpError(503, 'Could not find a free code. Try again.');
  const links = {};
  for (const r of Core.ROLES) links[r] = await freshLink(saved.code, r);
  const { doc: done } = await change(saved.code, (d) => { d.links = links; });
  opens.hit(ip);
  opensAll.hit('all');
  res.set('Cache-Control', 'no-store');
  res.json({ key, ...managerOut(done) });
}));

/** The plan, for the manager's key. `?since=v` answers {same: true} when
 *  nothing moved. */
app.get('/api/plans/:code', route('Could not load that plan.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await loadOwned(req);
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === doc.v) return res.json({ same: true, v: doc.v });
  res.json(managerOut(doc));
}));

/** The manager's changes; `relink` replaces one role's link (the old one
 *  stops working at once). */
app.post('/api/plans/:code/manage', route('Could not save that change.', async (req, res) => {
  countWrite(req);
  const doc0 = await loadOwned(req);
  const b = req.body || {};
  if (typeof b.action !== 'string') throw httpError(400, 'Unknown change.');
  if (b.action === 'relink') {
    if (!Core.ROLES.includes(b.role)) throw httpError(400, 'Unknown link.');
    const code = await freshLink(doc0.code, b.role);
    let old = null;
    const { doc } = await change(doc0.code, (d) => { old = d.links[b.role]; d.links = { ...d.links, [b.role]: code }; d.v = (d.v || 0) + 1; });
    if (old) await store.remove('links', old);
    return res.json({ result: { role: b.role }, ...managerOut(doc) });
  }
  const { doc, result } = await change(doc0.code, (d) => Core.manage(d, b.action, b, Date.now(), P.ids));
  res.json({ result, ...managerOut(doc) });
}));

app.delete('/api/plans/:code', route('Could not delete that.', async (req, res) => {
  countWrite(req);
  const doc = await loadOwned(req);
  await dropPlan(doc);
  res.json({ ok: true });
}));

/** A role link: the new hire's welcome page, or the buddy's or IT's tasks. */
app.get('/api/l/:code', route('Could not load that link.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { doc, role } = await loadLink(req);
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === doc.v) return res.json({ same: true, v: doc.v });
  res.json(linkOut(doc, role));
}));

/** What a role link may change: tick its own tasks; the new hire answers an
 *  open check-in. */
app.post('/api/l/:code/act', route('Could not save that.', async (req, res) => {
  countWrite(req);
  const { doc: doc0, role } = await loadLink(req);
  const b = req.body || {};
  if (typeof b.action !== 'string') throw httpError(400, 'Unknown change.');
  const { doc, result } = await change(doc0.code, (d) => Core.linkAct(d, role, b.action, b, Date.now()));
  res.json({ result, ...linkOut(doc, role) });
}));

/** This link's tasks (and, for the new hire, the first week) as a
 *  calendar file. */
app.get('/api/l/:code/calendar.ics', route('Could not make the calendar file.', async (req, res) => {
  const { doc, role } = await loadLink(req);
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${role === 'hire' ? 'my-first-week' : 'first-week-tasks'}.ics"`);
  res.send(Core.buildIcs(doc, role, Date.now()));
}));

/* ------------------------------------------------------------------ *
 * Metered: "Tailor it to us"
 * ------------------------------------------------------------------ */

/** Gates, then a 16 KB parser, then the ask checked (a 400 costs nothing),
 *  then whitespace streams while one forced tool drafts the plan. The
 *  answer is a proposal, validated; nothing is applied here. Failures after
 *  the stream starts are 200 with {error, status}. */
app.post('/api/tailor', ...spend, tailorJson, async (req, res) => {
  let b;
  try { b = ai.brief(req.body); } catch (err) { return fail(res, err, 'Could not start that.'); }
  const send = streamedJson(res);
  try {
    const raw = await ai.propose(await clientFor(req), modelFor(req), b);
    send({ proposal: ai.toProposal(raw) });
  } catch (err) {
    const f = failure(err, 'Tailoring isn’t available right now. Try again in a minute - the templates work meanwhile.');
    send({ ...f.body, status: f.status });
  }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A plan (p/<CODE>) or a role link (l/<CODE>) is the same single-page app
// served one level down; <base href="../"> resolves every relative asset
// and API path against the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function deepIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get(['/p/:code', '/l/:code'], (_req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(deepIndex()); });
app.all(['/p/:code', '/l/:code'], (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));

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
  // FIRSTDAY_DEV_MOUNT=/firstday runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.FIRSTDAY_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`firstday listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
