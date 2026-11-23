// Takeback - never miss a return window, and make sure the refund lands.
// See CLAUDE.md.
//
// EVERYTHING STAYS ON THE DEVICE UNLESS THE PERSON TURNS SYNC ON. The
// purchases, the return checklist, the refunds, the store notes, the tally,
// the reminders (.ics) and the recap image are worked out in the browser by
// public/takeback-core.js and kept in localStorage; receipt and drop-off
// photos live in IndexedDB on the phone and never reach this server. What
// the server does:
//
//   - serves the page and its service worker;
//   - signed in (free), and only when the person turns it on: keeps a copy
//     of the purchase LIST (store, item, prices, dates, steps, refunds, store
//     notes - never a photo) so a phone and a laptop agree, filed under an
//     HMAC of the account id, with a version and a 409 when another device
//     saved first. Everything in it is cleaned and capped here;
//   - ONE metered, signed-in model call: "Read my receipt or order email",
//     told the one image (shrunk on the phone, location removed) and nothing
//     else;
//   - the shared account (sign-in, credit) at /api/auth.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/takeback-core');
const ai = require('./lib/ai');
const gemini = require('./lib/gemini');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.TAKEBACK_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('TAKEBACK_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. Both read an image and take a
// forced tool.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

// Which model reads a receipt. TAKEBACK_AI_PROVIDER=gemini moves it to Gemini
// on Vertex AI (through the lab's AI guard), where it only transcribes and
// can also take a pasted order email; anything else - unset included - is
// the provider Takeback has always used, so shipping this code changes
// nothing until the setting is made. Read per request, never cached.
const providerNow = () => (process.env.TAKEBACK_AI_PROVIDER === 'gemini' ? 'gemini' : 'claude');

const LIMITS = {
  listWrites: 120,                 // list saves per account...
  listWindowMs: 10 * 60 * 1000,    // ...in 10 minutes
  listBytes: Core.LIMITS.listBytes,
};

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// The routes that take more than a few KB mount their own parser AFTER the
// sign-in check (and, for the model call, after budget and the daily cap),
// so a stranger's body is never read. A 1 MB image is ~1.34 MB as base64.
// Everything else: 16 KB.
const aiJson = express.json({ limit: '1400kb' });
const listJson = express.json({ limit: '512kb' });
const smallJson = express.json({ limit: '16kb' });
const OWN_PARSER = /^\/api\/(ai\/receipt|list)$/;
app.use((req, res, next) => (OWN_PARSER.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (sync and the receipt reader need it; nothing else)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'takeback',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Takeback',
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
 * body or an image - and answered with the route's fallback. A provider
 * error is a 502, or 503 when busy.
 * ------------------------------------------------------------------ */

const httpError = ai.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - adding by hand always works.' : fallback), ...(mine && err.code ? { code: err.code } : {}), ...(mine && err.problems ? { problems: err.problems } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/** The server's own idea of today (UTC), for checking dates it is sent. The
 *  core allows a day past it, which covers every time zone. */
function serverDay() { return new Date().toISOString().slice(0, 10); }
const ctx = () => ({ today: serverDay(), nowMs: Date.now() });

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false, reader: providerNow() });
  res.json({ signedIn: true, reader: providerNow(), email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Signed in, free, opt-in: the list follows the person to another device.
 *
 *   lists/<tag> = {owner: tag, list: {purchases, notes, deleted}, version, updatedAt}
 *
 * The tag is an HMAC of the account id under a key derived from the session
 * secret - never the id or the email. Whole-document writes in a
 * transaction: PUT saves only if `base` is still the account copy's version,
 * else 409 with the account's copy, and the page asks "use theirs / keep
 * mine / merge by item". A device that never synced cannot overwrite one.
 * ------------------------------------------------------------------ */

const listWrites = identityLib.createLimiter({ max: LIMITS.listWrites, windowMs: LIMITS.listWindowMs });
function ownerTag(uid, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('takeback owner v1').digest();
  return crypto.createHmac('sha256', key).update(String(uid)).digest('base64url').slice(0, 27);
}
function tagOf(req, write) {
  if (!SECRET()) throw httpError(503, 'Sync isn’t available right now. Your list is safe on this device.');
  if (write && !listWrites.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - your list is still on this device.');
  return ownerTag(req.user.id, SECRET());
}
function listOut(doc) {
  if (!doc || !doc.list) return null;
  return Core.cleanList(doc.list, ctx()).list;
}

app.get('/api/list', identity.requireUser, route('Could not load your list.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await store.get('lists', tagOf(req, false));
  res.json({ list: listOut(doc), version: doc ? Number(doc.version) || 0 : null });
}));

app.put('/api/list', identity.requireUser, listJson, route('Could not save that. It is still on this device.', async (req, res) => {
  const tag = tagOf(req, true);
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'list' && k !== 'base')) throw httpError(400, 'Send the list and nothing else.');
  if (!b.list || typeof b.list !== 'object' || Array.isArray(b.list)) throw httpError(400, 'Send the list.');
  if (Array.isArray(b.list.purchases) && b.list.purchases.length > Core.LIMITS.purchases) throw httpError(413, `That’s more than ${Core.LIMITS.purchases} purchases. Remove a few old ones first.`);
  const { list, errors } = Core.cleanList(b.list, ctx(), true);
  if (errors.length) throw httpError(400, 'That list was not saved: ' + errors[0], { problems: errors.slice(0, 10) });
  if (Core.listBytes(list) > LIMITS.listBytes) throw httpError(413, 'That list is too big to keep in one account. Remove a few old purchases or shorten long notes.');
  const base = b.base === null || b.base === undefined ? null : Number(b.base);
  let conflict = null;
  let saved = null;
  await store.transact('lists', tag, (cur) => {
    if (cur && Number(cur.version) !== base) { conflict = cur; return undefined; }
    const version = (cur ? Number(cur.version) || 0 : 0) + 1;
    saved = { owner: tag, list, version, updatedAt: Date.now() };
    return saved;
  });
  res.set('Cache-Control', 'no-store');
  if (conflict) return res.status(409).json({ error: 'Your list changed on another device.', code: 'conflict', list: listOut(conflict), version: Number(conflict.version) || 0 });
  res.json({ list: saved.list, version: saved.version });
}));

app.delete('/api/list', identity.requireUser, route('Could not remove it.', async (req, res) => {
  await store.remove('lists', tagOf(req, true));
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Metered: "Read my receipt or order email"
 * ------------------------------------------------------------------ */

/** Gates, then the parser, then the request rebuilt (a 400 costs nothing),
 *  then the lab's AI guard (the month's cap per provider and the burst
 *  limits, when the host has one), then ONE call: a forced tool on Claude,
 *  or a transcription against a responseSchema on Gemini. Nothing here
 *  writes to any store, and nothing logged carries a byte of the image or a
 *  word of the email. */
const READ_FALLBACK = 'Reading a receipt isn’t available right now. Try again in a minute - adding by hand always works.';

async function guardAllow(provider, req) {
  const guard = global.LAB_AI_GUARD;
  if (!guard) return;
  const a = await guard.allow({ provider, req, app: 'takeback' });
  if (!a || !a.ok) throw httpError((a && a.status) || 503, (a && a.message) || 'AI is resting for now. Adding by hand always works.', { code: (a && a.code) || 'ai-guard' });
}
/** Tell the guard what a call cost. Never fails the answer it measured. */
async function guardRecord(provider, model, usage) {
  const guard = global.LAB_AI_GUARD;
  if (!guard || !usage) return;
  try { await guard.record({ provider, app: 'takeback', usd: guard.priceUsd({ provider, model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }) }); } catch (e) { console.error('ai guard: record failed'); }
}

/** Claude, as it has always been: the identity meter charges the person. */
async function readWithClaude(req, b, today) {
  await guardAllow('claude', req);
  const client = await clientFor(req);
  const model = modelFor(req);
  let used = null;
  try {
    const raw = await ai.ask(client, model, b, today, (u) => { used = u; });
    return ai.answer(raw, today);
  } finally {
    // A member's own key paid for theirs; the lab's cap counts the lab's key.
    if (!client.__byok) await guardRecord('claude', model, used);
  }
}

/** Gemini, through the guard's Vertex helper. With no guard (the app on its
 *  own) only the local stand-in can answer; a real call needs the lab. */
async function readWithGemini(req, b, today) {
  // Every failure past the burst limits carries `fallback` (a short code):
  // for a photo the route then reads it with Claude instead.
  try { await guardAllow('gemini', req); } catch (err) {
    if (err && err.code === 'monthly-cap') err.fallback = 'monthly-cap';
    throw err;
  }
  const guard = global.LAB_AI_GUARD;
  const request = gemini.request(b, today);
  const fake = FAKE_AI ? require('./lib/fakeai').gemini : undefined;
  let generate = guard && guard.gemini && guard.gemini.generate;
  if (!generate && fake) generate = async (r) => ({ json: await fake({ contents: r.contents }), usage: { inputTokens: 100, outputTokens: 50 } });
  if (!generate) throw Object.assign(new Error('no gemini helper'), { status: 503, fallback: 'no-helper' });
  let out = null;
  let usage = null;
  try {
    out = await generate({ ...request, ...(fake ? { fake } : {}) });
    usage = out && out.usage;
  } catch (err) {
    // A call that failed after the model billed it is still paid for. The
    // provider's own words never reach the page: a status only.
    usage = err && err.usage;
    throw Object.assign(new Error('gemini call failed'), { status: Number.isInteger(err && err.status) ? err.status : (err && err.code === 'timeout' ? 503 : 502), fallback: String((err && err.code) || 'error').slice(0, 20) });
  } finally {
    if (usage) {
      await guardRecord('gemini', gemini.MODEL, usage);
      await chargeGemini(req, usage);
    }
  }
  try {
    return ai.answer(out && out.json, today, (raw) => gemini.cleanReading(raw, today, b.text || ''));
  } catch (err) {
    if (err) err.fallback = 'unusable';
    throw err;
  }
}

/** The person's own ledger (their credit, and the free tier's daily
 *  ceiling) is the identity's, and its price table is Claude's. A Gemini
 *  call is charged there at its real dollars, written as the Haiku input
 *  tokens that cost the same, with the route saying what really ran. */
async function chargeGemini(req, usage) {
  try {
    const guard = global.LAB_AI_GUARD;
    const usd = guard ? guard.priceUsd({ provider: 'gemini', model: gemini.MODEL, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }) : gemini.priceUsd(usage);
    const perToken = identityLib.PRICES[MODELS.free].input / 1e6;
    await identity.recordUsage({ model: MODELS.free, usage: { input_tokens: Math.ceil(usd / perToken), output_tokens: 0 }, route: `receipt:${gemini.MODEL}`, uid: req.user.id });
  } catch (e) { console.error('usage: gemini charge failed'); }
}

app.post('/api/ai/receipt', ...spend, aiJson, route(READ_FALLBACK, async (req, res) => {
  const viaGemini = providerNow() === 'gemini';
  const b = viaGemini ? ai.briefAny(req.body) : ai.brief(req.body);
  const today = serverDay();
  let reader = viaGemini ? 'gemini' : 'claude';
  let out;
  try {
    out = viaGemini ? await readWithGemini(req, b, today) : await readWithClaude(req, b, today);
  } catch (err) {
    // A photo Gemini could not read goes to the Claude reader, unchanged (its
    // own guard, meter and record). Pasted text has no Claude reader, and a
    // burst refusal never falls back.
    if (!viaGemini || !b.image || !err || !err.fallback) throw err;
    console.log(`[takeback] gemini failed (${err.fallback}); used claude`);
    out = await readWithClaude(req, b, today);
    reader = 'claude';
  }
  res.set('Cache-Control', 'no-store');
  res.json(reader === 'gemini' ? { proposal: out.proposal, stripped: b.stripped || 0, reader } : { ...out, ...(viaGemini ? { reader } : {}) });
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// The service worker must be re-checked on every load, or a fix would wait
// for its cache to expire. Its scope is this app's base, its own folder.
app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

const INDEX = path.join(__dirname, 'public', 'index.html');
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
  // TAKEBACK_DEV_MOUNT=/takeback runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.TAKEBACK_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`takeback listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fakeClient, ownerTag, LIMITS };
