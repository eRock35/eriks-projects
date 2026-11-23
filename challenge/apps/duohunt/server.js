// Duo Hunt - find an iPhone Duo near you: Apple, Best Buy and the carriers
// in one place. See CLAUDE.md.
//
// What the server does, and all it does:
//   - serves the page and the service worker;
//   - POST /api/check: on a person's tap, asks Best Buy's Products API (when
//     BESTBUY_API_KEY is set) - and Apple's public pickup JSON only when
//     DUOHUNT_APPLE_SERVER_CHECK=1 - about one model near one ZIP, in
//     parallel, through lib/upstream.js (5-minute cache per key, one shared
//     in-flight request, a per-address limit, an instance cap, a 6 s
//     timeout). Never polled, never on a timer: the "Watch on this tab"
//     re-check is the browser's, and only while the tab is open and visible;
//   - Apple, by default, gets NO request: it answers anything on Google's
//     network with HTTP 541, its bot block (measured 2026-10-24, CLAUDE.md).
//     The card links Apple's page for the exact model and hands out an
//     iPhone Shortcut recipe that asks Apple from the phone instead;
//   - POST /api/deal - "Check a deal", the ONE model call (lib/ai.js): a
//     signed-in person pastes a carrier offer; a forced tool copies its terms
//     out; the 36-month cost is then added up HERE (public/deal-core.js),
//     never by the model, and each "catch" is kept only if its quote is word
//     for word in the pasted text. Sign-in, budget and the daily cap come
//     before the body is even read. Nothing is stored or logged;
//   - the shared account at /api/auth (the verify banner, and the sign-in
//     "Check a deal" needs; finding a phone needs no account).
//
// AT&T, Verizon and T-Mobile get NO request from this server, ever: no public
// stock API, heavy bot protection. The page links to them.
//
// The stock check makes NO model call and needs no account.
//
// The ZIP travels in a POST body (never a URL, which request logs record), is
// used for that one check and is never stored or logged.

const path = require('path');
const express = require('express');

const { MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/duohunt-core');
const identityLib = require('./lib/identity');
const upstream = require('./lib/upstream');
const apple = require('./lib/apple');
const bestbuy = require('./lib/bestbuy');
const parts = require('./lib/parts');
const ai = require('./lib/ai');

const PORT = process.env.PORT || 8080;
const FAKE_UPSTREAM = process.env.DUOHUNT_FAKE_UPSTREAM === '1';
if (FAKE_UPSTREAM && process.env.K_SERVICE) throw new Error('DUOHUNT_FAKE_UPSTREAM=1 is for local use only and is refused on Cloud Run.');
// The stand-in model for "Check a deal" (lib/fakeai.js): local runs and
// tests only, refused on Cloud Run like every sibling's.
const FAKE_AI = process.env.DUOHUNT_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('DUOHUNT_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
// The lab's dev mode sets FAKE_AI, not FAKE_UPSTREAM; let it imply the fake
// upstream locally so `npm run dev` in challenge/ shows working cards
// (DUOHUNT_FAKE_UPSTREAM=0 keeps the upstream real, for the deal tests).
const FAKE = FAKE_UPSTREAM || (FAKE_AI && MEMORY && process.env.DUOHUNT_FAKE_UPSTREAM !== '0');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. The call forces its tool.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };
const fakeFetch = FAKE ? require('./lib/fixtures').createFakeFetch({
  apple: process.env.DUOHUNT_FAKE_APPLE || 'available',
  bestbuy: process.env.DUOHUNT_FAKE_BESTBUY || 'ok',
  delayMs: Number(process.env.DUOHUNT_FAKE_DELAY_MS) || 0,
}) : null;

// Off unless switched on, read per request: Apple blocks Cloud Run (541), so
// the request would only ever cost a fetch. For the day Apple stops blocking.
const appleServerCheck = () => process.env.DUOHUNT_APPLE_SERVER_CHECK === '1';

const LIMITS = {
  checksPerIp: Number(process.env.DUOHUNT_CHECKS_PER_IP) || 20,
  checksWindowMs: 10 * 60 * 1000,
  checksPerInstance: 2000,
  // Real upstream fetches (cache misses) per instance per ten minutes.
  appleFetches: 300,
  bestbuyFetches: 300,
  // "Check a deal": readings per account in ten minutes, on top of the
  // shared budget and daily cap.
  dealsPerUser: Number(process.env.DUOHUNT_DEALS_PER_USER) || 8,
};

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
// /api/deal mounts its own parser AFTER the sign-in, budget and daily-cap
// checks, so a stranger's body is never read. Everything else: 8 KB.
const smallJson = express.json({ limit: '8kb' });
const dealJson = express.json({ limit: '32kb' });
app.use((req, res, next) => (req.path === '/api/deal' ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account ("Check a deal" needs it; finding a phone does not)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'duohunt',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Duo Hunt',
  mountPath: '/api/auth',
});
identity.mount(app);

/* ------------------------------------------------------------------ *
 * The check
 * ------------------------------------------------------------------ */

const sources = {
  apple: upstream.createSource({ name: 'apple', capPerWindow: LIMITS.appleFetches }),
  bbSearch: upstream.createSource({ name: 'bestbuy', capPerWindow: LIMITS.bestbuyFetches }),
  bbStores: upstream.createSource({ name: 'bestbuy-stores', capPerWindow: LIMITS.bestbuyFetches }),
};

function ipKey(req) {
  const ip = identityLib.clientIp(req);
  if (ip.includes(':') && !ip.includes('.')) return ip.split(':').slice(0, 4).join(':'); // IPv6 by its /64
  return ip;
}
let perIp = identityLib.createLimiter({ max: LIMITS.checksPerIp, windowMs: LIMITS.checksWindowMs });
let perInstance = identityLib.createLimiter({ max: LIMITS.checksPerInstance, windowMs: LIMITS.checksWindowMs });

/** Run the live checks for one pick near one ZIP. Never throws. */
async function runCheck(pick, zip, want = { apple: true, bestbuy: true }) {
  const fetchImpl = fakeFetch || undefined; // undefined: globalThis.fetch, read per call
  // The card always names and links the real part; only the fake upstream is
  // asked about a fake one.
  const part = parts.partFor(pick);
  const ask = FAKE ? parts.partFor(pick, { fake: true }) : part;
  const [a, b] = await Promise.all([
    want.apple ? apple.check({ part, ask, zip, source: sources.apple, fetchImpl, enabled: appleServerCheck() }) : null,
    want.bestbuy ? bestbuy.check({ pick, zip, search: sources.bbSearch, stores: sources.bbStores, fetchImpl }) : null,
  ]);
  return { apple: a, bestbuy: b };
}

app.post('/api/check', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const pick = Core.cleanPick(body);
    if (!pick) return res.status(400).json({ error: 'Pick a storage size, colour and carrier.' });
    const zip = Core.cleanZip(body.zip);
    if (!zip) return res.status(400).json({ error: 'Enter a 5-digit US ZIP code.' });
    const only = Array.isArray(body.sources) ? body.sources : null;
    const want = { apple: !only || only.includes('apple'), bestbuy: !only || only.includes('bestbuy') };
    if (!perInstance.hit('*') || !perIp.hit(ipKey(req))) {
      return res.status(429).json({ error: 'That’s a lot of checks - give it ten minutes. The store links below still work.' });
    }
    const result = await runCheck(pick, zip, want);
    res.json({ pick, label: Core.pickLabel(pick), checkedAt: Date.now(), ...result });
  } catch (err) {
    // Never the error's message or the request: a ZIP must not reach a log.
    console.error('[duohunt] check failed:', err && err.name ? err.name : 'error');
    res.status(500).json({ error: 'Something went wrong. The store links below still work.' });
  }
});

/* ------------------------------------------------------------------ *
 * Metered: "Check a deal"
 *
 * Same-origin, then sign-in, budget and the daily cap, THEN the route's own
 * parser, then the body rebuilt to exactly {text} (bounded, emails and
 * phone-like numbers replaced; a 400 costs nothing), the account's own
 * limiter, the lab's AI guard when the host has one, one forced tool, and
 * the answer checked: numbers the text never wrote are dropped, quotes that
 * are not word for word are dropped, and the 36-month sum is done here.
 * Nothing is written to a store and nothing logged carries a word of it.
 * ------------------------------------------------------------------ */

// The fake (local runs and tests only) is kept so a test can read what it
// was sent. The real client is made on first use: finding a phone must work
// on a host with no model key at all.
const fakeClient = FAKE_AI ? require('./lib/fakeai').create() : null;
let sharedClient = null;
function shared() {
  if (!sharedClient) {
    // eslint-disable-next-line global-require
    sharedClient = identity.meter(FAKE_AI ? fakeClient : new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY }));
  }
  return sharedClient;
}
function clientFor(req) {
  if (FAKE_AI) return Promise.resolve(shared());
  // eslint-disable-next-line global-require
  return identity.clientFor(req.user, shared(), (apiKey) => new (require('@anthropic-ai/sdk'))({ apiKey }));
}
const modelFor = (req) => identityLib.planFor(req.user, MODELS).model;

// Never put a model call behind a sign-in alone: it goes through the budget
// and the free tier's daily ceiling as well.
const spend = [identity.requireUser, identity.requireBudget, identity.requireDailyCap];
let perUserDeals = identityLib.createLimiter({ max: LIMITS.dealsPerUser, windowMs: LIMITS.checksWindowMs });

const DEAL_FALLBACK = 'Checking a deal isn’t available right now. Try again in a minute.';
app.post('/api/deal', identityLib.sameOriginOnly, ...spend, dealJson, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const brief = ai.brief(req.body);
    if (!perUserDeals.hit(String(req.user.id))) throw ai.httpError(429, 'That’s a lot of deals - give it ten minutes.');
    // The lab-wide guard (monthly cap and bursts), when the host provides one.
    const guard = global.LAB_AI_GUARD;
    if (guard?.allow) {
      const a = await guard.allow({ provider: 'claude', req, app: 'duohunt' });
      if (!a || !a.ok) return res.status((a && a.status) || 503).json({ error: (a && a.message) || DEAL_FALLBACK, code: a && a.code });
    }
    const model = modelFor(req);
    const client = await clientFor(req);
    let used = null;
    let out;
    try {
      out = await ai.ask(client, model, brief, (u) => { used = u; });
    } finally {
      // A call that came back is paid for whether or not its answer was
      // usable. A person's own key is their spend, not the lab's.
      if (guard && used && !client.__byok) {
        try {
          await guard.record({ provider: 'claude', app: 'duohunt', usd: guard.priceUsd({ provider: 'claude', model, inputTokens: used.inputTokens, outputTokens: used.outputTokens }) });
        } catch (e) { console.error('[duohunt] guard record failed:', e && e.name ? e.name : 'error'); }
      }
    }
    return res.json(ai.answer(out.input, brief));
  } catch (err) {
    // Only the app's own errors reach the page in their own words. Anything
    // else is logged by name and status - never a message, which could quote
    // the offer - and answered with the fallback; a busy provider is a 503.
    const mine = Boolean(err && err.expose && err.status);
    if (mine) return res.status(err.status).json({ error: err.message });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too long. Paste just the offer and its fine print.' });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
    const up = err && Number.isInteger(err.status) ? err.status : 0;
    console.error('[duohunt] deal failed:', err && err.name ? err.name : 'error', up ? `(upstream ${up})` : '');
    const busy = [429, 503, 529].includes(up);
    return res.status(up ? (busy ? 503 : 502) : 500).json({ error: busy ? 'The AI is busy right now. Try again in a minute.' : DEAL_FALLBACK });
  }
});

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, stores: 'nothing', model: 'deal check only' }));

// What the page needs to draw the cards before any check: which sources the
// server checks live, and each pick's Apple part number (Apple publishes
// them on its own buy page) for "See this model on Apple" and the Shortcut.
app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const partsByPick = {};
  for (const s of Core.STORAGES) for (const c of Core.COLOURS) for (const k of Core.CARRIERS) {
    partsByPick[`${s.id}:${c.id}:${k.id}`] = parts.partFor({ storage: s.id, colour: c.id, carrier: k.id });
  }
  res.json({
    bestbuy: bestbuy.validKey(String(process.env.BESTBUY_API_KEY || '').trim()),
    appleServerCheck: appleServerCheck(),
    parts: partsByPick,
    watchMinutes: Core.WATCH_MS / 60000,
  });
});

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
  // Never log a parse error's message: V8 quotes the start of the body in it,
  // and the body carries a ZIP.
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too big.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error('[duohunt] error:', err && err.name ? err.name : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // DUOHUNT_DEV_MOUNT=/duohunt runs it the way the lab host does.
  const mount = String(process.env.DUOHUNT_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`duohunt listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE ? ' (fake upstream)' : ''}${FAKE_AI ? ' (fake AI)' : ''}${appleServerCheck() ? ' (Apple server check on)' : ''}`));
}

/** Tests only: fresh limits and caches. */
function _reset() {
  perIp = identityLib.createLimiter({ max: LIMITS.checksPerIp, windowMs: LIMITS.checksWindowMs });
  perInstance = identityLib.createLimiter({ max: LIMITS.checksPerInstance, windowMs: LIMITS.checksWindowMs });
  for (const s of Object.values(sources)) s._reset();
  perUserDeals = identityLib.createLimiter({ max: LIMITS.dealsPerUser, windowMs: LIMITS.checksWindowMs });
}

module.exports = { app, identity, identityStore, sources, LIMITS, MODELS, fakeClient, runCheck, appleServerCheck, _reset, FAKE, FAKE_AI };
