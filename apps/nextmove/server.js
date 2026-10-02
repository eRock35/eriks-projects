// Next Move - a career copilot. The web service (Cloud Run service `nextmove`).
//
// Daily, a job reads the career boards of the companies people watch, SEC
// filings and the news, and scores each person's best new matches against
// their background (jobs/run.js daily). Weekly, a web-search sweep finds what
// the boards missed and a digest is built. Quarterly, public pay data (H-1B
// filings, BLS) is loaded. This service shows all of it, and is where a
// person sets up their background, targets and watchlist.
//
// Data: a person's background lives ONLY in Firestore (`users/<uid>` in the
// `nextmove` database). BigQuery holds postings, public comp, company events
// and fit scores keyed by an HMAC of the account id - never an id, an email
// or a name. See CLAUDE.md.
//
// Model calls on this side: reading a resume (one call) and "score my top
// matches now" (a few score_fit calls). Both behind requireUser,
// requireBudget, requireDailyCap; the big body parser only after them.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const ctx = require('./lib/context');
const profileLib = require('./lib/profile');
const boards = require('./lib/boards');
const insights = require('./lib/insights');
const httpLib = require('./lib/http');
const { keyFor } = require('./lib/userkey');
const { Q } = require('./lib/queries');
const { P } = require('./lib/bq');
const { scoreUser, TOP_N } = require('./lib/score');
const spend = require('./lib/spend');
const { streamedJson } = require('./lib/stream');
const { slug } = require('./lib/text');

const { store, identity, identityLib, MODELS, FAKE_AI, MEMORY } = ctx;
const PORT = process.env.PORT || 8080;
const DAY = 864e5;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  // No inline script anywhere: every page's script is a file from this origin.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// One route carries a big body (a resume PDF), and it mounts its own parser
// AFTER its gates, so a stranger's 12 MB is never read. Everything else keeps
// a small limit.
const BIG_ROUTE = /^\/api\/profile\/extract$/;
const bigJson = express.json({ limit: '12mb' });
const smallJson = express.json({ limit: '64kb' });
app.use((req, res, next) => (BIG_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

// The shared account, at /api/auth (sign-in, passkeys, billing, verify).
identity.mount(app);

const spendGates = [identity.requireUser, identity.requireBudget, identity.requireDailyCap];
const user = identity.requireUser;
const sameOrigin = identityLib.sameOriginOnly;

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

const httpError = profileLib.httpError;

// Only the app's own errors (marked `expose`) reach the page with their
// words. Anything else is logged by its first stack lines only - never a
// body, a resume or a name - and answered with the route's fallback. A
// provider error is a 502, or 503 when it is overloaded.
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status) && !err.bq;
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : (err && err.code === 'no-secret' ? 503 : 500);
  const words = mine ? err.message : upstream && status === 503 ? 'The AI is busy right now. Try again in a minute.' : fallback;
  return { status, body: { error: words, ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}

/* ------------------------------------------------------------------ *
 * Small per-user memo (a few minutes) in front of BigQuery
 * ------------------------------------------------------------------ */

const memo = new Map();
const MEMO_MS = Number(process.env.NEXTMOVE_CACHE_MS || 5 * 60 * 1000);
async function cached(key, ms, fn) {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  if (memo.size > 5000) memo.clear();
  memo.set(key, { value, until: Date.now() + ms });
  return value;
}
function forget(userKey) {
  for (const k of memo.keys()) if (k.endsWith(`|${userKey}`)) memo.delete(k);
}

const userKeyOf = (req) => keyFor(req.user.id);
const writes = identityLib.createLimiter({ max: 60, windowMs: 10 * 60 * 1000 });
const lookups = identityLib.createLimiter({ max: 20, windowMs: 10 * 60 * 1000 });
function limited(limiter, req, what) {
  if (!limiter.hit(req.user.id)) throw httpError(429, `That is a lot of ${what} in a few minutes. Wait a moment and try again.`);
}

async function loadProfile(uid) {
  return profileLib.view(await store.get('users', uid));
}

/** When the next daily run is (11:15 UTC), for the empty states. */
function nextDaily(now = Date.now()) {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 11, 15);
  return new Date(t > now ? t : t + DAY).toISOString();
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind, bigquery: ctx.bqClient().kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    limits: { titles: profileLib.LIMITS.titles, locations: profileLib.LIMITS.locations, watchlist: profileLib.LIMITS.watchlist },
    topN: TOP_N,
    compThreshold: insights.THRESHOLD,
    schedule: { daily: '11:15 UTC', weekly: 'Sunday 12:15 UTC', comp: 'quarterly' },
  });
});

app.get('/api/me', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  try {
    const p = await loadProfile(req.user.id);
    res.json({
      signedIn: true,
      email: req.user.email,
      budget: identityLib.budgetFor(req.user),
      tier: identityLib.planFor(req.user, MODELS).tier,
      emailVerified: identityLib.isVerified(req.user),
      onboarded: p.onboarded,
      watching: p.watchlist.length,
    });
  } catch (err) { fail(res, err, 'Could not load your account.'); }
});

/* ------------------------------------------------------------------ *
 * The profile (signed in, free)
 * ------------------------------------------------------------------ */

app.get('/api/profile', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const p = await loadProfile(req.user.id);
    const states = await Promise.all(p.watchlist.map((w) => store.get('boards', w.companyKey).catch(() => null)));
    p.watchlist = p.watchlist.map((w, i) => ({ ...w, found: Boolean(w.provider), openCount: states[i] && Number.isFinite(states[i].openCount) ? states[i].openCount : null }));
    res.json({ profile: p, nextRun: nextDaily() });
  } catch (err) { fail(res, err, 'Could not load your profile.'); }
});

app.put('/api/profile', user, sameOrigin, async (req, res) => {
  try {
    limited(writes, req, 'saving');
    const patch = profileLib.fromBody(req.body);
    if (!Object.keys(patch).length) throw httpError(400, 'Nothing to save.');
    if (patch.targets && !patch.targets.titles.length) throw httpError(400, 'Add at least one title you are aiming for.');
    const now = new Date().toISOString();
    const cur = await store.get('users', req.user.id);
    await store.merge('users', req.user.id, { ...patch, profileUpdatedAt: now, updatedAt: now, ...(cur ? {} : { createdAt: now }) });
    forget(userKeyOf(req));
    res.json({ profile: await loadProfile(req.user.id) });
  } catch (err) { fail(res, err, 'Could not save your profile.'); }
});

/** Read a resume (pasted text or a PDF) into a structured background. Metered.
 *  Nothing is saved: the page shows it for review, and PUT /api/profile saves. */
app.post('/api/profile/extract', ...spendGates, sameOrigin, bigJson, async (req, res) => {
  let input;
  try { input = profileLib.extractInput(req.body); } catch (err) { return fail(res, err); }
  const send = streamedJson(res);
  try {
    const plan = identityLib.planFor(req.user, MODELS);
    const client = FAKE_AI ? ctx.requestClient : await identity.clientFor(req.user, ctx.requestClient, (k) => new Anthropic({ apiKey: k }));
    const r = await client.messages.create(profileLib.extractRequest(plan.model, input), { timeout: 120000, maxRetries: 1 });
    const block = (r.content || []).find((b) => b && b.type === 'tool_use' && b.name === 'record_background');
    const out = profileLib.cleanExtraction(block && block.input);
    if (!out) throw httpError(422, input.kind === 'pdf' ? 'That does not look like a resume. Try another file, or paste the text.' : 'That does not look like a resume. Paste the text of your resume, or type your background in.');
    send(out);
  } catch (err) { send(failure(err, 'Reading your resume did not finish. Try again, or type your background in.').body); }
});

/* ------------------------------------------------------------------ *
 * The watchlist
 * ------------------------------------------------------------------ */

const lookupHttp = httpLib.create({ concurrency: 3, hostGapMs: 100, timeoutMs: 8000, retries: 0 });

app.post('/api/watchlist', user, sameOrigin, async (req, res) => {
  try {
    limited(lookups, req, 'company lookups');
    const input = String((req.body || {}).input || '').trim();
    if (input.length < 2 || input.length > 300) throw httpError(400, 'Type a company name or paste its careers page link.');
    const p = await loadProfile(req.user.id);
    if (p.watchlist.length >= profileLib.LIMITS.watchlist) throw httpError(409, `You can watch up to ${profileLib.LIMITS.watchlist} companies. Remove one first.`);
    // A name looked up before is answered from the cache, not probed again.
    const nameKey = `name:${slug(input)}`;
    const looksUrl = /^https?:\/\//i.test(input) || /\.[a-z]{2,}(\/|$)/i.test(input);
    let found = null;
    if (!looksUrl && slug(input)) {
      const prev = await store.get('boards', nameKey).catch(() => null);
      if (prev && prev.probedAt && Date.parse(prev.probedAt) > Date.now() - 30 * DAY) {
        found = prev.resolvedTo ? await store.get('boards', prev.resolvedTo) : { companyKey: nameKey, name: prev.name || input, provider: null, token: null, found: false };
        if (found && prev.resolvedTo) found = { ...found, found: true };
      }
    }
    if (!found) {
      found = await boards.resolve(lookupHttp, input);
      if (!found) throw httpError(400, 'Type a company name or paste its careers page link.');
      const now = new Date().toISOString();
      if (!looksUrl && slug(input)) await store.set('boards', nameKey, { name: found.name, resolvedTo: found.found ? found.companyKey : null, probedAt: now });
      await store.merge('boards', found.companyKey, { companyKey: found.companyKey, name: found.name, provider: found.provider, token: found.token, eu: Boolean(found.eu), resolvedAt: now });
    }
    if (p.watchlist.some((w) => w.companyKey === found.companyKey)) throw httpError(409, `You already watch ${found.name}.`);
    const entry = profileLib.cleanWatch({ companyKey: found.companyKey, name: found.name, provider: found.provider, token: found.token, eu: found.eu, addedAt: new Date().toISOString() });
    const raw = (await store.get('users', req.user.id)) || {};
    const list = (Array.isArray(raw.watchlist) ? raw.watchlist : []).concat([entry]);
    const now = new Date().toISOString();
    await store.merge('users', req.user.id, { watchlist: list, watchlistUpdatedAt: now, updatedAt: now, ...(raw.createdAt ? {} : { createdAt: now }) });
    forget(userKeyOf(req));
    res.json({ added: { ...entry, found: Boolean(entry.provider) }, message: entry.provider ? `Found ${entry.name}'s ${entry.provider[0].toUpperCase() + entry.provider.slice(1)} board.` : `No public careers board found for ${entry.name} - Next Move will still watch its filings and news.` });
  } catch (err) { fail(res, err, 'Could not add that company.'); }
});

app.delete('/api/watchlist/:key', user, sameOrigin, async (req, res) => {
  try {
    limited(writes, req, 'changes');
    const key = String(req.params.key || '');
    const raw = (await store.get('users', req.user.id)) || {};
    const list = Array.isArray(raw.watchlist) ? raw.watchlist : [];
    if (!list.some((w) => w && w.companyKey === key)) throw httpError(404, 'You do not watch that company.');
    const now = new Date().toISOString();
    await store.merge('users', req.user.id, { watchlist: list.filter((w) => w && w.companyKey !== key), watchlistUpdatedAt: now, updatedAt: now });
    forget(userKeyOf(req));
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Could not remove that company.'); }
});

/* ------------------------------------------------------------------ *
 * Today, Companies, Comp, This week (signed in; reads BigQuery)
 * ------------------------------------------------------------------ */

app.get('/api/today', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const key = userKeyOf(req);
    const since = new Date(Date.now() - 14 * DAY).toISOString();
    const [list, p] = await Promise.all([cached(`today|${key}`, MEMO_MS, () => insights.fits(ctx.bqClient(), key, since)), loadProfile(req.user.id)]);
    res.json({ fits: list, lastRun: p.lastRun, lastScoredAt: p.lastScoredAt, nextRun: nextDaily(), onboarded: p.onboarded, watching: p.watchlist.length });
  } catch (err) { fail(res, err, 'Could not load your matches.'); }
});

app.get('/api/companies', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const key = userKeyOf(req);
    const p = await loadProfile(req.user.id);
    const keys = p.watchlist.map((w) => w.companyKey);
    const [states, evs] = await Promise.all([
      Promise.all(keys.map((k) => store.get('boards', k).catch(() => null))),
      cached(`events|${key}`, MEMO_MS, () => insights.events(ctx.bqClient(), keys, new Date(Date.now() - 30 * DAY).toISOString())),
    ]);
    const companies = p.watchlist.map((w, i) => {
      const s = states[i] || {};
      return {
        companyKey: w.companyKey,
        name: w.name,
        provider: w.provider,
        found: Boolean(w.provider),
        openCount: Number.isFinite(s.openCount) ? s.openCount : null,
        newThisWeek: Number.isFinite(s.newThisWeek) ? s.newThisWeek : null,
        newest: Array.isArray(s.newest) ? s.newest.slice(0, 4) : [],
        lastFetchedAt: s.lastFetchedAt || null,
        lastError: s.lastError || null,
        sec: s.cik ? { cik: s.cik, name: s.cikName || null } : null,
        events: evs.filter((e) => e.companyKey === w.companyKey).slice(0, 6),
      };
    });
    res.json({ companies, nextRun: nextDaily() });
  } catch (err) { fail(res, err, 'Could not load your companies.'); }
});

app.get('/api/comp', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const p = await loadProfile(req.user.id);
    const titles = p.targets.titles.slice(0, 3);
    // Public data, so cached per role for everyone, not per person.
    const comps = await Promise.all(titles.map((t) => cached(`comp|${slug(t)}`, 30 * 60 * 1000, () => insights.comp(ctx.bqClient(), t))));
    res.json({ comps: comps.filter(Boolean), threshold: insights.THRESHOLD });
  } catch (err) { fail(res, err, 'Could not load pay data.'); }
});

app.get('/api/week', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    // Built live (and memoised a few minutes) so it never lags Today. The
    // weekly job's stored snapshot (users/<uid>/digests/<week>) is for the
    // future email digest, not for this page.
    const key = userKeyOf(req);
    const p = await loadProfile(req.user.id);
    const d = await cached(`week|${key}`, MEMO_MS, () => insights.buildDigest(ctx.bqClient(), { userKey: key, watchlist: p.watchlist, targets: p.targets }));
    res.json({ digest: d });
  } catch (err) { fail(res, err, 'Could not build your week.'); }
});

/* ------------------------------------------------------------------ *
 * Score my top matches now (metered)
 * ------------------------------------------------------------------ */

const boardHttp = httpLib.create({ concurrency: 4, hostGapMs: 200, timeoutMs: 20000, retries: 1 });
const SCORE_NOW_HOURS = Number(process.env.NEXTMOVE_SCORE_NOW_HOURS || 20);

/** For someone who just set up: read their watched boards now and score the
 *  best few, instead of waiting for tomorrow's run. Once a day. */
app.post('/api/score-now', ...spendGates, sameOrigin, async (req, res) => {
  let p;
  try {
    p = await loadProfile(req.user.id);
    if (!p.onboarded) throw httpError(400, 'Add your background and at least one target title first.');
    const withBoards = p.watchlist.filter((w) => w.provider && w.token);
    if (!withBoards.length) throw httpError(400, 'Watch at least one company with a public careers board first.');
    const raw = (await store.get('users', req.user.id)) || {};
    if (raw.scoreNowAt && Date.parse(raw.scoreNowAt) > Date.now() - SCORE_NOW_HOURS * 36e5) throw httpError(429, 'You already scored today. New matches arrive with the daily run.');
    await store.merge('users', req.user.id, { scoreNowAt: new Date().toISOString() });
  } catch (err) { return fail(res, err, 'Could not start scoring.'); }
  const send = streamedJson(res);
  try {
    const now = new Date().toISOString();
    const key = userKeyOf(req);
    const lists = await Promise.all(p.watchlist.filter((w) => w.provider && w.token).slice(0, 8).map((w) => boards.fetchBoard(boardHttp, w, now).catch(() => [])));
    const postings = [].concat(...lists);
    const scored = new Map();
    for (const r of await ctx.bqClient().run(Q.SCORED, { keys: P.strs([key]), since: P.ts(new Date(Date.now() - 60 * DAY).toISOString()) })) scored.set(r.posting_id, r.content_hash);
    const plan = identityLib.planFor(req.user, MODELS);
    const b = identityLib.budgetFor(req.user);
    const client = FAKE_AI ? ctx.requestClient : await identity.clientFor(req.user, ctx.requestClient, (k) => new Anthropic({ apiKey: k }));
    const r = await scoreUser({
      client, plan, profile: p, userKey: key, postings, scored, now,
      caps: spend.runCaps(process.env, { calls: 8, usd: 1 }),
      remainingUsd: b.unlimited ? Infinity : b.remainingUsd,
      n: plan.tier === 'paid' ? 8 : 3,
    });
    if (r.rows.length) await ctx.bqClient().load('fits', r.rows);
    forget(key);
    send({ scored: r.scored, considered: r.considered, postings: postings.length, stopped: r.stopped });
  } catch (err) { send(failure(err, 'Scoring did not finish. Your matches will still arrive with the daily run.').body); }
});

/* ------------------------------------------------------------------ *
 * Delete my Next Move data
 * ------------------------------------------------------------------ */

/** Removes the profile (background, targets, watchlist), the digests and
 *  every fit row in BigQuery. The shared account itself is untouched: it is
 *  deleted from the account settings, and covers every app on the site. */
app.delete('/api/me', user, sameOrigin, async (req, res) => {
  try {
    if ((req.body || {}).confirm !== 'delete') throw httpError(400, 'Confirm with {"confirm": "delete"}.');
    const key = userKeyOf(req);
    const r = await ctx.bqClient().run(Q.DELETE_FITS, { key: P.str(key) });
    const digests = await store.list(`users/${req.user.id}/digests`).catch(() => []);
    for (const d of digests) await store.remove(`users/${req.user.id}/digests`, d.id);
    await store.remove('users', req.user.id);
    forget(key);
    res.json({ ok: true, fitsDeleted: r.affected || 0, digestsDeleted: digests.length });
  } catch (err) { fail(res, err, 'Could not delete your data. Nothing was half-deleted that cannot be retried - try again.'); }
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
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once. A resume PDF up to 8 MB, or paste the text.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`nextmove listening on ${PORT}${MEMORY ? ' (memory store, fake BigQuery)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, ctx, nextDaily };
