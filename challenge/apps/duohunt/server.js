// Duo Hunt - find an iPhone Duo near you: Apple, Best Buy and the carriers
// in one place. See CLAUDE.md.
//
// What the server does, and all it does:
//   - serves the page and the service worker;
//   - POST /api/check: on a person's tap, asks Apple's public pickup JSON and
//     Best Buy's Products API (when BESTBUY_API_KEY is set) about one model
//     near one ZIP, in parallel, through lib/upstream.js (5-minute cache per
//     key, one shared in-flight request, a per-address limit, an instance cap,
//     a 6 s timeout). Never polled, never on a timer: the "Watch on this tab"
//     re-check is the browser's, and only while the tab is open and visible;
//   - the shared account at /api/auth (the verify banner; nothing here needs
//     an account).
//
// AT&T, Verizon and T-Mobile get NO request from this server, ever: no public
// stock API, heavy bot protection. The page links to them.
//
// NO MODEL CALL anywhere: no Anthropic client, no metered route.
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

const PORT = process.env.PORT || 8080;
const FAKE_UPSTREAM = process.env.DUOHUNT_FAKE_UPSTREAM === '1';
if (FAKE_UPSTREAM && process.env.K_SERVICE) throw new Error('DUOHUNT_FAKE_UPSTREAM=1 is for local use only and is refused on Cloud Run.');
// The lab's `npm run dev` sets <SLUG>_FAKE_AI=1 for every app. Duo Hunt has
// no model to fake; like every sibling's, the switch is refused on Cloud Run.
if (process.env.DUOHUNT_FAKE_AI === '1' && process.env.K_SERVICE) throw new Error('DUOHUNT_FAKE_AI=1 is for local use only and is refused on Cloud Run (Duo Hunt has no model to fake anyway).');
// The lab's dev mode sets FAKE_AI, not FAKE_UPSTREAM; let it imply the fake
// upstream locally so `npm run dev` in challenge/ shows working cards.
const FAKE = FAKE_UPSTREAM || (process.env.DUOHUNT_FAKE_AI === '1' && MEMORY);
const fakeFetch = FAKE ? require('./lib/fixtures').createFakeFetch({
  apple: process.env.DUOHUNT_FAKE_APPLE || 'available',
  bestbuy: process.env.DUOHUNT_FAKE_BESTBUY || 'ok',
  delayMs: Number(process.env.DUOHUNT_FAKE_DELAY_MS) || 0,
}) : null;

const LIMITS = {
  checksPerIp: Number(process.env.DUOHUNT_CHECKS_PER_IP) || 20,
  checksWindowMs: 10 * 60 * 1000,
  checksPerInstance: 2000,
  // Real upstream fetches (cache misses) per instance per ten minutes.
  appleFetches: 300,
  bestbuyFetches: 300,
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
app.use(express.json({ limit: '8kb' }));

/* ------------------------------------------------------------------ *
 * The shared account (no Duo Hunt feature uses it)
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
  const [a, b] = await Promise.all([
    want.apple ? apple.check({ part: parts.partFor(pick, { fake: FAKE }), zip, source: sources.apple, fetchImpl }) : null,
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

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, stores: 'nothing', model: 'none' }));

// What the page needs to draw the cards before any check.
app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const configured = {};
  for (const s of Core.STORAGES) for (const c of Core.COLOURS) for (const k of Core.CARRIERS) {
    configured[`${s.id}:${c.id}:${k.id}`] = Boolean(parts.partFor({ storage: s.id, colour: c.id, carrier: k.id }, { fake: FAKE }));
  }
  res.json({
    bestbuy: bestbuy.validKey(String(process.env.BESTBUY_API_KEY || '').trim()),
    apple: configured,
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
  server.listen(PORT, () => console.log(`duohunt listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE ? ' (fake upstream)' : ''}`));
}

/** Tests only: fresh limits and caches. */
function _reset() {
  perIp = identityLib.createLimiter({ max: LIMITS.checksPerIp, windowMs: LIMITS.checksWindowMs });
  perInstance = identityLib.createLimiter({ max: LIMITS.checksPerInstance, windowMs: LIMITS.checksWindowMs });
  for (const s of Object.values(sources)) s._reset();
}

module.exports = { app, identity, identityStore, sources, LIMITS, runCheck, _reset, FAKE };
