// Leash - know what your AI agent can do, before it does it.
//
// Teams are wiring AI agents to refunds, customer email, customer data and
// internal systems, and the first time anyone asks "what exactly can it do,
// how much damage on its worst day, who pulls the plug?" is after something
// has gone wrong. Leash answers those before launch: a capability checklist
// (or the agent's own prompt, read by AI), a blast-radius score and the
// worst-day sentence in dollars, fixes that drop the score, a bad-day drill,
// and a one-page charter with a kill switch. See CLAUDE.md.
//
// A model is used for ONE thing, metered and signed in: reading a pasted
// system prompt, tool definitions or runbook and mapping it onto the
// catalog. Everything else is public/leash-core.js and free, with or
// without an account.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/leash-core');
const A = require('./lib/agents');
const ai = require('./lib/ai');
const { streamedJson } = require('./lib/stream');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.LEASH_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('LEASH_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  // No inline script anywhere in these pages: every app in the lab shares
  // one origin, so one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// One route carries more than 64 KB - reading up to 40,000 characters of
// prompt - and it mounts its own parser AFTER sign-in, budget and the daily
// cap, so a stranger's body is never read. (512 KB: 40,000 characters of
// UTF-8, JSON-escaped, fit with room.)
const READ_ROUTE = /^\/api\/read$/;
const readJson = express.json({ limit: '512kb' });
const smallJson = express.json({ limit: '64kb' });
app.use((req, res, next) => (READ_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'leash',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Leash',
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

const now = () => new Date().toISOString();
const httpError = A.httpError;

// Only the app's own errors (marked `expose`) reach the client with their
// status and words. Anything else is logged - its stack's first lines only,
// never a body: a pasted prompt or an agent's profile is a company's own -
// and answered with the route's fallback. An upstream failure (the SDK's
// errors carry a `.status` and a raw body of their own) is a 502, or 503
// when the provider is overloaded or rate-limited.
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - or tick what it can do by hand, which is free.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}

/* ------------------------------------------------------------------ *
 * Saved agents live under their owner's uid: nobody else's id can name
 * them, so every route is a 404 for anyone else's.
 * ------------------------------------------------------------------ */

const agentsOf = (uid) => `agents/${uid}/items`;

async function loadAgent(req) {
  const id = String(req.params.id || '');
  const doc = A.ID_RE.test(id) ? await store.get(agentsOf(req.user.id), id) : null;
  if (!doc) throw httpError(404, 'No such agent.');
  return doc;
}

/**
 * One read-modify-write at a time per key on this instance, queued rather
 * than refused: a double-tapped Save must not store an agent twice, and two
 * saves at once must not make an eleventh.
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

async function createAgent(uid, agent) {
  return exclusive(`agents/${uid}`, async () => {
    const have = await store.list(agentsOf(uid), { limit: A.LIMITS.agents + 1 });
    if (have.length >= A.LIMITS.agents) throw httpError(409, `You can keep up to ${A.LIMITS.agents} agents. Delete one first.`);
    const at = now();
    const id = A.newId();
    const doc = { ...agent, createdAt: at, updatedAt: at };
    await store.set(agentsOf(uid), id, doc);
    return { id, ...doc };
  });
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: { agents: A.LIMITS.agents, drills: A.LIMITS.drills, text: Core.LIMITS.text }, catalog: Core.CATALOG.map((c) => ({ id: c.id, group: c.group, label: c.label })), cards: Core.CARDS.length });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({
    signedIn: true,
    email: req.user.email,
    budget: identityLib.budgetFor(req.user),
    tier: identityLib.planFor(req.user, MODELS).tier,
  });
});

/* ------------------------------------------------------------------ *
 * Metered: read my agent
 * ------------------------------------------------------------------ */

/**
 * Gates, then the 512 KB parser, then the text checks (400s cost nothing) -
 * and only then the whitespace stream, after which a failure is a 200
 * {error}. The text is read once and dropped; nothing here writes to the
 * store, and nothing logged carries a word of it.
 */
app.post('/api/read', ...spend, readJson, async (req, res) => {
  const text = (req.body || {}).text;
  if (typeof text !== 'string' || text.trim().length < Core.LIMITS.textMin) return fail(res, httpError(400, 'Paste the agent\'s system prompt, its tool definitions or a runbook - at least a few lines.'));
  if (text.length > Core.LIMITS.text) return fail(res, httpError(400, `That is over ${Core.groups(Core.LIMITS.text)} characters. Paste the tools and the rules first - they say the most.`));
  const send = streamedJson(res);
  try {
    const raw = await ai.mapCapabilities(await clientFor(req), modelFor(req), text);
    const out = ai.cleanReading(raw, text);
    if (!out) throw httpError(422, 'We could not find anything on the checklist in that. If it is an agent\'s prompt, tick what it can do by hand instead - it is free.');
    send(out);
  } catch (err) { send(failure(err, 'The reading did not finish. Try again in a minute - or tick what it can do by hand, which is free.').body); }
});

/* ------------------------------------------------------------------ *
 * Saved agents
 * ------------------------------------------------------------------ */

app.get('/api/agents', user, async (req, res) => {
  try {
    const rows = await store.list(agentsOf(req.user.id), { limit: A.LIMITS.agents + 5 });
    res.set('Cache-Control', 'no-store');
    res.json({ agents: rows.map(A.summary).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))), limit: A.LIMITS.agents });
  } catch (err) { fail(res, err); }
});

app.post('/api/agents', user, async (req, res) => {
  try {
    res.json({ agent: A.view(await createAgent(req.user.id, A.fromBody(req.body))) });
  } catch (err) { fail(res, err, 'Could not save that agent.'); }
});

app.get('/api/agents/:id', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ agent: A.view(await loadAgent(req)) });
  } catch (err) { fail(res, err); }
});

/** Save the agent: its name, profile and charter. Written whole (a switched-
 *  off capability stays off); the drill history is the server's copy. */
app.put('/api/agents/:id', user, async (req, res) => {
  try {
    const agent = A.fromBody(req.body);
    const out = await exclusive(`agent/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadAgent(req);
      const next = { ...agent, drills: Core.cleanDrills(doc.drills), createdAt: doc.createdAt || now(), updatedAt: now() };
      await store.set(agentsOf(req.user.id), doc.id, next);
      return { id: doc.id, ...next };
    });
    res.json({ agent: A.view(out) });
  } catch (err) { fail(res, err, 'Could not save that agent.'); }
});

/** Rename. */
app.patch('/api/agents/:id', user, async (req, res) => {
  try {
    const name = Core.clean((req.body || {}).name, A.LIMITS.name);
    if (!name) throw httpError(400, 'Give the agent a name.');
    const out = await exclusive(`agent/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadAgent(req);
      const { id, ...rest } = doc;
      const next = { ...rest, name, updatedAt: now() };
      await store.set(agentsOf(req.user.id), id, next);
      return { id, ...next };
    });
    res.json({ agent: A.view(out) });
  } catch (err) { fail(res, err); }
});

app.post('/api/agents/:id/duplicate', user, async (req, res) => {
  try {
    const v = A.view(await loadAgent(req));
    const copy = A.fromBody({ ...v, name: Core.clean(`${v.name} (copy)`, A.LIMITS.name) });
    res.json({ agent: A.view(await createAgent(req.user.id, copy)) });
  } catch (err) { fail(res, err); }
});

/** Record one drill's scores. Only the scores: the last 30 are kept. */
app.post('/api/agents/:id/drills', user, async (req, res) => {
  try {
    const d = Core.cleanDrill({ ...(req.body || {}), at: now() });
    if (!d) throw httpError(400, 'That drill result could not be read.');
    const out = await exclusive(`agent/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadAgent(req);
      const { id, ...rest } = doc;
      const next = { ...rest, drills: Core.cleanDrills([...(Array.isArray(doc.drills) ? doc.drills : []), d]), updatedAt: now() };
      await store.set(agentsOf(req.user.id), id, next);
      return { id, ...next };
    });
    res.json({ agent: A.view(out) });
  } catch (err) { fail(res, err); }
});

/** Delete an agent: it is one document, so this removes everything. */
app.delete('/api/agents/:id', user, async (req, res) => {
  try {
    await exclusive(`agent/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadAgent(req);
      await store.remove(agentsOf(req.user.id), doc.id);
    });
    res.json({ ok: true });
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
  // Never log a parse error's message: V8 quotes the start of the body in it.
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once. Paste the tools and the rules first.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // LEASH_DEV_MOUNT=/leash runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.LEASH_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`leash listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
