// As Filed - what public company filings say, with the filing beside every
// number and the exact words beside every relationship. See CLAUDE.md.
//
// THE REVIEWED SET IS A STATIC DATASET AND A PAGE. Everything a reader sees
// about the 81 companies was worked out at build time by the tools in
// tools/, from public sources cached outside this repo, and checked by
// tools/verify.js: a relationship whose quote is not in its source word for
// word never reaches public/data/ (index.json, patterns.json, c/<ID>.json).
//
// A COMPANY OUTSIDE THE SET CAN BE LOOKED UP ON REQUEST (lib/lookup.js): the
// same figures, by the same code, from sec.gov, inside the request, stored
// by CIK and labelled "Looked up on request - not in the reviewed set". And
// a signed-in member can ask for its relationships (lib/relations.js):
// Claude picks sentences from the company's own annual report, and the
// build's verifier decides which quotes stand. At run time this server:
//
//   - serves the page and the dataset;
//   - mounts the shared account at /api/auth;
//   - reaches sec.gov only through tools/sec.js, only for a lookup, rate
//     limited, and never from the page (connect-src stays 'self');
//   - calls a model through exactly one function (`modelCall`), for POST
//     api/lookup/<cik>/relations - behind the sign-in, the budget and the
//     lab's AI guard - and for the owner's batch, POST api/admin/prewarm,
//     which walks a list of likely lookups through the same two steps.
//
// ASFILED_FAKE_AI and ASFILED_FAKE_SEC are local stand-ins (tests, a
// laptop); both are refused on Cloud Run.

const fs = require('fs');
const path = require('path');
const express = require('express');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const identityLib = require('./lib/identity');
const Lookup = require('./lib/lookup');
const Relations = require('./lib/relations');
const Prewarm = require('./lib/prewarm');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.ASFILED_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('ASFILED_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin.
  // connect-src 'self' as well: the page talks to this app and nothing else.
  res.set('Content-Security-Policy', "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '16kb' }));

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'asfiled',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'As Filed',
  mountPath: '/api/auth',
});
identity.mount(app);

// The dataset is read once. A missing or unreadable file is a 503 on the
// data routes, never a crash: one broken app must not take the lab down.
const DATA_FILE = path.join(__dirname, 'public', 'data', 'index.json');
let summary = null;
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  summary = { built: d.built, companies: d.companies.length, figures: d.counts.figures, edges: d.edges.length, sources: d.counts.sources, integrity: d.integrity, disclaimer: d.disclaimer };
} catch (e) { console.error('asfiled: dataset not readable'); }

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind, data: Boolean(summary) }));
app.get('/api/meta', (_req, res) => {
  if (!summary) return res.status(503).json({ error: 'The dataset is not available right now.' });
  res.set('Cache-Control', 'public, max-age=300');
  res.json(summary);
});

// The data files are JSON that compresses about four to one, and the lab
// host does not compress: send them gzipped (node's own zlib, read once).
const zlib = require('zlib');
const gz = new Map();
app.get(/^\/data\/(index|patterns|[cf]\/[A-Z]{1,6}|sic\/\d{4})\.json$/, (req, res, next) => {
  if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return next();
  const file = path.join(__dirname, 'public', req.path);
  let body = gz.get(file);
  if (!body) {
    try { body = zlib.gzipSync(fs.readFileSync(file), { level: 9 }); } catch (e) { return next(); }
    if (gz.size >= 400) gz.delete(gz.keys().next().value);   // a few KB each: the oldest goes first
    gz.set(file, body);
  }
  res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Cache-Control': 'public, max-age=300' });
  res.send(body);
});

/* ------------------------------------------------------------------ *
 * A company looked up on request (no model)
 * ------------------------------------------------------------------ */

const lookup = Lookup.create({ store });
const relations = Relations.create({ store, lookup });
const failed = (res, e) => {
  const err = lookup.secFail(e);
  res.set('Cache-Control', 'no-store');
  return res.status(err.status).json({ error: err.message, code: err.code });
};

// Name or ticker -> registrants, from the SEC's own list (stored for a week).
app.get('/api/lookup', async (req, res) => {
  if (!lookup.searches.take(lookup.ipKey(req.ip))) return res.status(429).json({ error: 'That is a lot of searches - try again in a while.', code: 'limit-ip' });
  try {
    const matches = await lookup.resolve(req.query.q);
    res.set('Cache-Control', 'no-store');
    res.json({ matches, label: Lookup.LABEL });
  } catch (e) { failed(res, e); }
});

// One company's part: stored, or built from sec.gov inside this request.
app.get('/api/lookup/:cik(\\d{1,10})', async (req, res) => {
  try {
    const got = await lookup.company(req.params.cik, { ip: req.ip });
    res.set('Cache-Control', 'no-store');
    if (got.inSet) return res.json({ inSet: got.inSet });
    const rel = await relations.read(got.part.cik, got.part.company.annual.accn);
    const more = await lookup.readMore(got.part.cik, got.part.company.annual.accn);
    res.json({ ...got.part, at: new Date(got.at).toISOString(), stale: Boolean(got.stale), relations: rel, more });
  } catch (e) { failed(res, e); }
});

// The second reading of a looked-up company - what needs its documents:
// employees, risk factors, pay and Form 4s. No model; the build's own code
// and verifier, inside this request, under the lookup limits.
app.get('/api/lookup/:cik(\\d{1,10})/more', async (req, res) => {
  try {
    const out = await lookup.more(req.params.cik, { ip: req.ip });
    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) { failed(res, e); }
});

/* ------------------------------------------------------------------ *
 * Metered: "Find relationships" for a looked-up company
 *
 * Signed in, in budget, under the free tier's daily ceiling, then the lab's
 * AI guard (the month's Claude cap and the bursts), then one call - and
 * every answer through the verifier (lib/relations.js). A result already
 * stored for this annual report is returned without asking anyone anything.
 * Progress goes out as lines of JSON while the request runs; nothing runs
 * after it ends.
 * ------------------------------------------------------------------ */

const fakeClient = FAKE_AI ? require('./lib/fakeai').create() : null;
let sharedClient = null;
function claude() {
  if (!sharedClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    sharedClient = identity.meter(FAKE_AI ? fakeClient : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
  }
  return sharedClient;
}
const AI_FALLBACK = 'The relationships could not be read just now. Nothing was added.';
// The one model call. `seen(usage)` is told what the answer cost in tokens.
const modelCall = (seen) => (params) => claude().messages.create(params, { timeout: 120000, maxRetries: 1 }).then((r) => { seen(r && r.usage); return r; });
/** A call that came back is paid for whether or not anything was kept:
 *  add it to the lab's month (app `asfiled`). Resolves its cost in dollars. */
async function recordUsage(usage) {
  if (!usage) return 0;
  const guard = global.LAB_AI_GUARD;
  let usd = 0;
  try {
    if (guard && guard.record) {
      usd = guard.priceUsd({ provider: 'claude', model: Relations.MODEL, usage });
      await guard.record({ provider: 'claude', app: 'asfiled', usd });
    } else usd = Number(identityLib.priceOf(Relations.MODEL, usage)) || 0;   // on its own (tests, a laptop): priced, nowhere to record
  } catch (e) { console.error('asfiled: guard record failed'); }
  return usd;
}

app.post('/api/lookup/:cik(\\d{1,10})/relations', identity.sameOriginOnly, identity.requireUser, identity.requireBudget, identity.requireDailyCap, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const cik = Number(req.params.cik);
  try {
    const have = await lookup.read(cik);
    const stored = have && await relations.read(cik, have.part.company.annual.accn);
    if (stored) return res.json({ done: true, relations: stored });
  } catch (e) { return failed(res, e); }
  const guard = global.LAB_AI_GUARD;
  if (guard && guard.allow) {
    const a = await guard.allow({ provider: 'claude', req, app: 'asfiled' });
    if (!a || !a.ok) return res.status((a && a.status) || 503).json({ error: (a && a.message) || AI_FALLBACK, code: a && a.code });
  }
  res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
  const say = (o) => { try { res.write(`${JSON.stringify(o)}\n`); } catch (e) { /* the reader left; the run still finishes and is stored */ } };
  let usage = null;
  try {
    const out = await relations.find(cik, {
      ip: req.ip,
      step: (text) => say({ step: text }),
      call: modelCall((u) => { usage = u; }),
    });
    say({ done: true, relations: out.relations });
  } catch (e) {
    if (e instanceof Lookup.LookupError) say({ error: e.message, code: e.code });
    else { console.error('asfiled: relations failed:', e && e.name ? e.name : 'error'); say({ error: AI_FALLBACK, code: 'ai' }); }
  } finally {
    await recordUsage(usage);
    res.end();
  }
});

/* ------------------------------------------------------------------ *
 * The owner's batch: "Prepare likely lookups" (lib/prewarm.js)
 *
 * Owner only: the shared account's owner flag (`admin: true` on the
 * identity user, what /me reports as `admin`). Signed out is 401, a member
 * 403. Each request prepares a few companies (3; 5 at most) and answers;
 * the page asks again until none remain. For each company: the stored part
 * (no model), then - only when nothing is stored for its latest annual
 * report - the relations run above, gate for gate: the budget, the daily
 * ceiling, the lab's AI guard (cap and bursts), the metered client, the
 * verifier, the same record under app `asfiled`. No company is started
 * after START_MS, so a request ends well inside 240 seconds; no timer, and
 * nothing runs after the answer.
 *
 * The guard's burst book is asked for as `asfiledbatch`. With nothing set
 * on the service that is the shared book (5 a minute, 30 a day), exactly
 * as for a member; LAB_AI_BURST_APP_ASFILEDBATCH="<perMinute>/<perDay>"
 * gives the batch a book of its own without touching members' or the
 * month's cap. A refusal stops the request and is passed to the page.
 * ------------------------------------------------------------------ */

const prewarm = Prewarm.create({ lookup, relations });
const PREWARM_BOOK = 'asfiledbatch';
const START_MS = 150000;
const requireOwner = (req, res, next) => (req.user && req.user.admin === true ? next() : res.status(403).json({ error: 'This is for the site’s owner.', code: 'owner-only' }));

app.get('/api/admin/prewarm', identity.requireUser, requireOwner, async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await prewarm.status()); } catch (e) { failed(res, e); }
});

app.post('/api/admin/prewarm', identity.sameOriginOnly, identity.requireUser, requireOwner, identity.requireBudget, identity.requireDailyCap, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  let costUsd = 0;
  const relate = async (cik) => {
    const guard = global.LAB_AI_GUARD;
    if (guard && guard.allow) {
      const a = await guard.allow({ provider: 'claude', req, app: PREWARM_BOOK });
      if (!a || !a.ok) return { refused: { status: (a && a.status) || 503, code: (a && a.code) || 'ai', message: (a && a.message) || AI_FALLBACK } };
    }
    let usage = null;
    try {
      const out = await relations.find(cik, { ip: req.ip, call: modelCall((u) => { usage = u; }) });
      return { relations: out.relations };
    } catch (e) {
      if (!(e instanceof Lookup.LookupError)) console.error('asfiled: prewarm relations failed:', e && e.name ? e.name : 'error');
      throw e;
    } finally { costUsd += await recordUsage(usage); }
  };
  try {
    const out = await prewarm.run({ ciks: body.ciks, skip: body.skip, limit: body.limit, ip: req.ip, deadline: Date.now() + START_MS, relate });
    res.json({ ...out, costUsd: Math.round(costUsd * 1e6) / 1e6 });
  } catch (e) { failed(res, e); }
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
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // ASFILED_DEV_MOUNT=/asfiled runs it the way the lab host does.
  const mount = String(process.env.ASFILED_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`asfiled listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}`));
}

module.exports = { app, identity, identityStore, store, lookup, relations, prewarm, fakeClient };
