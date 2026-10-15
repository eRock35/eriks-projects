// Zoned - find the building and fridge controllers on your till network,
// and fence them off. See CLAUDE.md.
//
// NO SCAN IS UPLOADED, AND NOTHING IS SCANNED. Zoned reads files the user
// already made (nmap output, an ARP table, a DHCP lease export) in the
// browser, with public/zoned-core.js, and there is no route here that
// accepts one. It never scans, pings or connects to anything on anyone's
// behalf. The devices, their roles, the findings, the zone plan, the rules,
// the contractor letter and the report all live on the device. What the
// server does:
//   - serves the page;
//   - ONE metered, signed-in model call: "Help me identify the unknowns",
//     which receives - for the devices the user picked, after seeing it -
//     the vendor name, hostnames and what answered on which port. No IP
//     address, no MAC address, nothing about any other device;
//   - the shared account (sign-in, credit) at /api/auth.
// It stores nothing of its own: no scan, no device, no answer.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/zoned-core');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.ZONED_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('ZONED_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. Both take a forced tool.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

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

// The metered route mounts its own 64 KB parser (twelve devices with twenty
// services each fit many times over) AFTER sign-in, budget and the daily
// cap, so a stranger's body is never read. Everything else: 16 KB (nothing
// else here takes more than an account form).
const IDENTIFY_ROUTE = /^\/api\/identify$/;
const identifyJson = express.json({ limit: '64kb' });
const smallJson = express.json({ limit: '16kb' });
app.use((req, res, next) => (IDENTIFY_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'zoned',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Zoned',
  mountPath: '/api/auth',
});
identity.mount(app);

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
 * or 503 when busy; its own text never reaches the page.
 * ------------------------------------------------------------------ */

const httpError = ai.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - the findings and the plan need no AI.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, stores: 'nothing', scans: 'nothing' }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: Core.LIMITS, roles: Core.ROLE_KEYS, zones: Core.ZONE_ORDER });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier });
});

/* ------------------------------------------------------------------ *
 * Metered: Help me identify the unknowns
 * ------------------------------------------------------------------ */

/** Gates, then the 64 KB parser, then the request rebuilt field by field
 *  (a 400 costs nothing), then one forced tool, then the answer checked
 *  against what was sent and the fixed role list. Nothing is stored and
 *  nothing from the body is logged. */
app.post('/api/identify', ...spend, identifyJson, async (req, res) => {
  try {
    const sent = Core.cleanIdentifyRequest(req.body);
    if (!sent) throw httpError(400, `Pick up to ${Core.LIMITS.identifyDevices} unidentified devices with at least a vendor name, a hostname or an open port to go on.`);
    const raw = await ai.identifyDevices(await clientFor(req), modelFor(req), sent);
    const refs = {};
    sent.devices.forEach((d) => { refs[d.ref] = 1; });
    const result = Core.cleanIdentification(raw, refs);
    if (!result) throw httpError(422, 'That answer had nothing usable in it. Try again - or open the device and set what it is yourself.');
    res.set('Cache-Control', 'no-store');
    res.json({ result, sent: sent.devices.length });
  } catch (err) { fail(res, err, 'Could not identify those right now. Try again in a minute - everything else here is free and works without it.'); }
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
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once. Pick fewer devices.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // ZONED_DEV_MOUNT=/zoned runs it the way the lab host does: mounted under
  // a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.ZONED_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`zoned listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, fakeCalls: fakeClient ? fakeClient.calls : null };
