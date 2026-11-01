// Sieve - tune an AI agent's guardrail filters until nothing leaks and
// nothing legitimate is blocked. See CLAUDE.md.
//
// THE SERVER NEVER SEES A TEST CASE. Test cases can hold real secrets and
// personal data, so they are written, imported, run, scored, attacked and
// exported in the browser by public/sieve-core.js (in a worker, under a
// watchdog). There is no route that takes a message, a case, a match or a
// test set - /api/run, /api/check, /api/cases, /api/scan and friends are
// 404s, tested. What the server does:
//
//   - serves the page, its worker and its service worker;
//   - signed in (free): keeps the account's RULE SET - detector settings,
//     custom regexes and keyword lists, the allow-list, actions and
//     directions - filed under an HMAC of the account id, and refuses a rule
//     set that carries anything a test case would (SieveCore.cleanRules,
//     strict: unknown fields, oversize lists, and any secret or id the
//     built-in detectors find in a pattern, a keyword or a name);
//   - ONE metered, signed-in model call: "Write tricky test cases", told a
//     category code and one sentence about the agent, never data;
//   - the shared account (sign-in, credit) at /api/auth.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/sieve-core');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.SIEVE_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('SIEVE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. The call forces its tool.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const LIMITS = {
  ruleWrites: 120,               // rule-set saves per account...
  ruleWindowMs: 10 * 60 * 1000,  // ...in 10 minutes
};

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others. The worker is a
  // same-origin file, which script-src 'self' allows.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// The routes that take a body mount their own parser AFTER the sign-in check
// (and, for the model call, after budget and the daily cap), so a stranger's
// body is never read. Everything else: 16 KB.
const rulesJson = express.json({ limit: '64kb' });
const aiJson = express.json({ limit: '4kb' });
const smallJson = express.json({ limit: '16kb' });
const OWN_PARSER = /^\/api\/(rules|ai\/cases)$/;
app.use((req, res, next) => (OWN_PARSER.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (rule sync and the AI need it; nothing else)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'sieve',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Sieve',
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
 * body - and answered with the route's fallback. A provider error is a 502,
 * or 503 when busy.
 * ------------------------------------------------------------------ */

const httpError = ai.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - everything else works without it.' : fallback), ...(mine && err.code ? { code: err.code } : {}), ...(mine && err.problems ? { problems: err.problems } : {}), ...(mine && err.dropped ? { dropped: err.dropped } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    limits: Core.LIMITS,
    detectors: Core.DETECTORS.map((d) => ({ id: d.id, label: d.label, cat: d.cat, opts: d.opts })),
    categories: Object.keys(Core.AI_CATS),
    tricks: Core.TRICK_IDS,
  });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Signed in, free: the rule set follows you to another device.
 *
 *   rules/<tag> = {owner: tag, rules, updatedAt}
 *
 * The tag is an HMAC of the account id under a key derived from the session
 * secret - never the id or the email. The rule set holds patterns and
 * settings, never a test case or a matched value: cleanRules(strict) refuses
 * unknown fields and any secret or personal id the detectors find in it.
 * ------------------------------------------------------------------ */

const ruleWrites = identityLib.createLimiter({ max: LIMITS.ruleWrites, windowMs: LIMITS.ruleWindowMs });
function ownerTag(uid, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('sieve owner v1').digest();
  return crypto.createHmac('sha256', key).update(String(uid)).digest('base64url').slice(0, 27);
}
function tagOf(req, write) {
  if (!SECRET()) throw httpError(503, 'Saving rules to your account isn’t available right now. They are still on this device.');
  if (write && !ruleWrites.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - your rules are still on this device.');
  return ownerTag(req.user.id, SECRET());
}
function rulesOut(doc) {
  if (!doc || !doc.rules) return null;
  const r = Core.cleanRules(doc.rules).rules;
  r.updatedAt = Number(doc.updatedAt) || 0;
  return r;
}

app.get('/api/rules', identity.requireUser, route('Could not load your rules.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ rules: rulesOut(await store.get('rules', tagOf(req, false))) });
}));

/** Save the rule set. `base` is the account copy's updatedAt this device last
 *  saw: if the account has moved on since (another device saved), the answer
 *  is 409 with the account's copy, and the page offers to merge, take that
 *  copy, or keep this one. */
app.put('/api/rules', identity.requireUser, rulesJson, route('Could not save your rules. They are still on this device.', async (req, res) => {
  const tag = tagOf(req, true);
  const b = req.body || {};
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'rules' && k !== 'base')) throw httpError(400, 'Send the rule set and nothing else - never test cases.');
  const raw = b.rules;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Send the rule set.');
  const { rules, errors } = Core.cleanRules(raw, true);
  if (errors.length) throw httpError(400, 'That rule set was not saved: ' + errors[0], { problems: errors.slice(0, 10) });
  delete rules.updatedAt;
  const base = b.base === null || b.base === undefined ? null : Number(b.base);
  let conflict = null;
  let saved = null;
  await store.transact('rules', tag, (cur) => {
    if (cur && Number(cur.updatedAt) !== base) { conflict = cur; return undefined; }
    const now = Math.max(Date.now(), (cur && Number(cur.updatedAt) + 1) || 0);
    saved = { owner: tag, rules, updatedAt: now };
    return saved;
  });
  res.set('Cache-Control', 'no-store');
  if (conflict) return res.status(409).json({ error: 'Your rules changed on another device.', code: 'conflict', rules: rulesOut(conflict) });
  res.json({ rules: rulesOut(saved) });
}));

app.delete('/api/rules', identity.requireUser, route('Could not remove them.', async (req, res) => {
  await store.remove('rules', tagOf(req, true));
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Metered: "Write tricky test cases"
 *
 * Gates, then the parser, then the request rebuilt field by field (a 400
 * costs nothing), then one forced tool, then the answer checked. Nothing
 * here writes to the store, and nothing logged carries a word of it.
 * ------------------------------------------------------------------ */

app.post('/api/ai/cases', ...spend, aiJson, route('Writing test cases isn’t available right now. Try again in a minute - you can write your own meanwhile.', async (req, res) => {
  const brief = ai.brief(req.body);
  const raw = await ai.ask(await clientFor(req), modelFor(req), brief);
  res.set('Cache-Control', 'no-store');
  res.json(ai.answer(raw, brief));
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

const INDEX = path.join(__dirname, 'public', 'index.html');

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
  // SIEVE_DEV_MOUNT=/sieve runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.SIEVE_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`sieve listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fakeClient, ownerTag, LIMITS };
