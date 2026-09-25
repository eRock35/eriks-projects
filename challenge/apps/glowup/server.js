// Glowup - give your listing a glow-up, and watch the score climb.
//
// Airbnb and Vrbo hosts, Etsy and eBay sellers, and local service pages all
// live or die on one listing's title, description and photos - written once,
// usually badly, and never touched again, because nobody tells the seller
// what is wrong with it. Glowup scores a listing 0-100 like a credit score,
// with five rings and a fix for every point lost, re-scoring live as the
// seller types. A model can rewrite it (three titles, a description, tags and
// a shot list) or compare it with a competitor's - and the rules score the
// result, so the before/after is honest. See CLAUDE.md.
//
// Scoring never calls a model: public/rules.js runs in the page and here.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const R = require('./public/rules');
const L = require('./lib/listings');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const { demo, winsOf } = require('./lib/demo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.GLOWUP_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('GLOWUP_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor. Both read screenshots.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A share link is the credential for that card. It must not ride out in a
  // Referer header, and it must not be indexed under Glowup's name.
  if (req.path.startsWith('/s/') || req.path.startsWith('/api/shared/')) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// One screenshot rides in the snap request as base64. Only that route gets
// the big limit, and it mounts its own parser AFTER the sign-in and budget
// checks, so a stranger's 6 MB is never read. Everything else stays small.
const SNAP_ROUTE = '/api/listings/read';
const bigJson = express.json({ limit: '6mb' });
const smallJson = express.json({ limit: '128kb' });
app.use((req, res, next) => (req.path === SNAP_ROUTE ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'glowup',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Glowup',
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

// Never put a model call behind a sign-in alone: every one of these goes
// through the budget and the free tier's daily ceiling as well.
const spend = [identity.requireUser, identity.requireBudget, identity.requireDailyCap];
const user = identity.requireUser;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const now = () => new Date().toISOString();
const httpError = L.httpError;
const fail = (res, err, fallback = 'Something went wrong.') => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : fallback });
};

/** The page sends its own local date, so "today" and the streak mean the
 *  person's day; anything implausible falls back to UTC. */
const todayOf = (req) => L.todayFrom(req.get('x-local-date') || req.query.today);

const itemsOf = (uid) => `listings/${uid}/items`;
const versionsOf = (uid, id) => `listings/${uid}/items/${id}/versions`;

async function loadListing(req) {
  const id = String(req.params.id || '');
  // 404, never 403: another person's listing id is not confirmed to exist -
  // and it could not be found anyway, because "mine" is a path under my uid.
  const l = L.ID_RE.test(id) ? await store.get(itemsOf(req.user.id), id) : null;
  if (!l) throw httpError(404, 'No such listing.');
  return l;
}
const loadVersions = (uid, id) => store.list(versionsOf(uid, id), { orderBy: 'n', dir: 'desc', limit: L.LIMITS.versions + 10 });
const loadAll = (uid) => store.list(itemsOf(uid), { limit: L.LIMITS.listings + 1 });

async function loadSettings(uid) {
  const s = (await store.get('settings', uid)) || {};
  return { improvedDays: Array.isArray(s.improvedDays) ? s.improvedDays : [] };
}

/**
 * One write at a time per listing, queued rather than refused: a double-tapped
 * Save waits its turn, finds its content already saved, and adds nothing.
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

/**
 * Save new content as the next version. History is append-only: an edit, an
 * applied glow-up and a revert are all new versions. The original (n = 1) is
 * always kept, so "before" never moves; past the cap the oldest after it go.
 */
async function saveVersion(uid, l, fields, source, today) {
  const sm = R.summary(fields);
  const n = (l.versionCount || 0) + 1;
  const at = now();
  await store.set(versionsOf(uid, l.id), `v${String(n).padStart(4, '0')}`, { n, at, day: today, source, fields, score: sm.score, cats: sm.cats });
  const prevScore = l.score;
  const next = {
    ...l,
    ...fields,
    score: sm.score,
    cats: sm.cats,
    firstScore: l.firstScore == null ? sm.score : l.firstScore,
    bestScore: Math.max(l.bestScore || 0, sm.score),
    versionCount: n,
    trail: [...(l.trail || []), sm.score].slice(-L.LIMITS.versions),
    createdAt: l.createdAt || at,
    updatedAt: at,
  };
  delete next.id;
  await store.set(itemsOf(uid), l.id, next);

  const all = await loadVersions(uid, l.id);
  if (all.length > L.LIMITS.versions) {
    const byAge = all.slice().sort((a, b) => a.n - b.n);
    const extra = byAge.filter((v) => v.n !== 1).slice(0, all.length - L.LIMITS.versions);
    for (const v of extra) await store.remove(versionsOf(uid, l.id), v.id);
  }

  let improved = null;
  if (prevScore != null && sm.score > prevScore) {
    improved = sm.score - prevScore;
    const s = await loadSettings(uid);
    if (!s.improvedDays.includes(today)) {
      const days = [...s.improvedDays, today].sort().slice(-L.LIMITS.improvedDays);
      await store.merge('settings', uid, { improvedDays: days, updatedAt: at });
    }
  }
  return { listing: { id: l.id, ...next }, improved, newBest: sm.score > (l.bestScore || 0) && prevScore != null };
}

async function detail(uid, l) {
  return L.detailOf(l, await loadVersions(uid, l.id));
}

async function winsFor(uid, today, all) {
  const rows = (all || await loadAll(uid)).map(L.summaryOf);
  return winsOf(rows, (await loadSettings(uid)).improvedDays, today);
}

/* ------------------------------------------------------------------ *
 * Public: health, meta, the sample
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    types: R.TYPES,
    platforms: R.PLATFORMS,
    essentials: Object.fromEntries(Object.entries(R.ESSENTIALS).map(([k, v]) => [k, v.map(({ key, label, hint }) => ({ key, label, hint }))])),
    shots: R.SHOTS,
    cats: R.CATS,
    grades: R.GRADES,
    limits: L.LIMITS,
  });
});

// Three invented listings run through the real rules and validators. No
// model call for a signed-out visitor, ever.
app.get('/api/demo', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(demo(todayOf(req)));
});

/* ------------------------------------------------------------------ *
 * Me, and my listings
 * ------------------------------------------------------------------ */

app.get('/api/me', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.json({ signedIn: false });
    const s = await loadSettings(req.user.id);
    res.json({
      signedIn: true,
      email: req.user.email,
      budget: identityLib.budgetFor(req.user),
      tier: identityLib.planFor(req.user, MODELS).tier,
      streak: R.dayStreak(s.improvedDays, todayOf(req)),
    });
  } catch (err) { fail(res, err); }
});

app.get('/api/listings', user, async (req, res) => {
  try {
    const all = await loadAll(req.user.id);
    res.set('Cache-Control', 'no-store');
    res.json({
      listings: all.map(L.summaryOf).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
      wins: await winsFor(req.user.id, todayOf(req), all),
      limit: L.LIMITS.listings,
    });
  } catch (err) { fail(res, err); }
});

app.post('/api/listings', user, async (req, res) => {
  try {
    const b = req.body || {};
    const fields = L.cleanListing(b);
    const all = await loadAll(req.user.id);
    if (all.length >= L.LIMITS.listings) throw httpError(409, `You have ${L.LIMITS.listings} listings - the most Glowup holds. Delete an old one first.`);
    const id = await store.add(itemsOf(req.user.id), { createdAt: now() });
    const out = await saveVersion(req.user.id, { id, versionCount: 0 }, fields, b.source === 'snap' ? 'snap' : 'paste', todayOf(req));
    res.json(await detail(req.user.id, out.listing));
  } catch (err) { fail(res, err); }
});

app.get('/api/listings/:id', user, async (req, res) => {
  try {
    const l = await loadListing(req);
    res.set('Cache-Control', 'no-store');
    res.json(await detail(req.user.id, l));
  } catch (err) { fail(res, err); }
});

/** Save: a new version when anything changed, nothing when it did not.
 *  `source: 'glowup'` marks an applied rewrite. */
app.put('/api/listings/:id', user, async (req, res) => {
  try {
    const out = await exclusive(`l/${req.user.id}/${req.params.id}`, async () => {
      const l = await loadListing(req);
      const fields = L.cleanListing(req.body, l);
      if (L.sameContent(fields, l)) return { ...(await detail(req.user.id, l)), unchanged: true };
      const source = (req.body || {}).source === 'glowup' ? 'glowup' : 'edit';
      const r = await saveVersion(req.user.id, l, fields, source, todayOf(req));
      return { ...(await detail(req.user.id, r.listing)), improved: r.improved, newBest: r.newBest };
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

app.delete('/api/listings/:id', user, async (req, res) => {
  try {
    const l = await loadListing(req);
    for (const v of await store.list(versionsOf(req.user.id, l.id))) await store.remove(versionsOf(req.user.id, l.id), v.id);
    if (l.shareToken) await store.remove('shares', l.shareToken);
    await store.remove(itemsOf(req.user.id), l.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

app.get('/api/listings/:id/versions/:vid', user, async (req, res) => {
  try {
    const l = await loadListing(req);
    const vid = String(req.params.vid || '');
    const v = L.ID_RE.test(vid) ? await store.get(versionsOf(req.user.id, l.id), vid) : null;
    if (!v) throw httpError(404, 'No such version.');
    res.json({ ...L.versionRow(v), fields: v.fields, result: R.score(v.fields) });
  } catch (err) { fail(res, err); }
});

/** Go back to an earlier version - as a NEW version, so nothing is lost. */
app.post('/api/listings/:id/revert', user, async (req, res) => {
  try {
    const out = await exclusive(`l/${req.user.id}/${req.params.id}`, async () => {
      const l = await loadListing(req);
      const vid = String((req.body || {}).versionId || '');
      const v = L.ID_RE.test(vid) ? await store.get(versionsOf(req.user.id, l.id), vid) : null;
      if (!v) throw httpError(404, 'No such version.');
      const fields = L.cleanListing(v.fields);
      if (L.sameContent(fields, l)) return { ...(await detail(req.user.id, l)), unchanged: true };
      const r = await saveVersion(req.user.id, l, fields, 'revert', todayOf(req));
      return { ...(await detail(req.user.id, r.listing)), improved: r.improved, revertedTo: v.n };
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

app.get('/api/wins', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await winsFor(req.user.id, todayOf(req)));
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Metered: snap, glow it up, compare
 * ------------------------------------------------------------------ */

/**
 * Snap a listing: one screenshot in, a proposed listing out. Nothing is saved -
 * the page fills the Add form and only its Save (an ordinary POST
 * /api/listings) stores anything. Validated before anything is spent, read
 * once, dropped with the request.
 */
app.post(SNAP_ROUTE, ...spend, bigJson, async (req, res) => {
  try {
    const image = photo.validate((req.body || {}).image);
    const client = await clientFor(req);
    const raw = await ai.readListing(client, modelFor(req), image);
    const proposal = ai.validateRead(raw);
    if (!proposal) throw httpError(422, 'We couldn’t read a listing in that screenshot. Try a tighter shot of the title and description - or paste them in.');
    res.json(proposal);
  } catch (err) { fail(res, err, 'Could not read that screenshot. Try again, or paste it in.'); }
});

/**
 * Glow it up: the saved listing in, a rewrite out - three titles, a
 * description, tags, a shot list - checked (platform limits, markup, the
 * invented-fact guard) and scored by the rules. Nothing is saved: the seller
 * picks, edits, and applies it with an ordinary PUT.
 */
app.post('/api/listings/:id/glowup', ...spend, async (req, res) => {
  try {
    const l = await loadListing(req);
    const src = L.fieldsOf(l);
    const client = await clientFor(req);
    const raw = await ai.glowUp(client, modelFor(req), src);
    const proposal = ai.validateGlow(raw, src);
    if (!proposal) throw httpError(422, 'The rewrite came back empty. Try again - or add a little more to the description first.');
    res.json({ listingId: l.id, basedOn: l.versionCount, ...L.glowResult(src, proposal) });
  } catch (err) { fail(res, err, 'Could not glow that up. Try again.'); }
});

/** Compare with a competitor's listing: both scored by the rules, and what
 *  the model noticed in each direction. The comparison is kept on the listing
 *  (their title and scores only - never their full text). */
app.post('/api/listings/:id/compare', ...spend, async (req, res) => {
  try {
    const l = await loadListing(req);
    const mine = L.fieldsOf(l);
    const theirs = L.cleanCompetitor(req.body, mine);
    const client = await clientFor(req);
    const raw = await ai.compare(client, modelFor(req), mine, theirs);
    const verdict = ai.validateCompare(raw);
    if (!verdict) throw httpError(422, 'The comparison came back empty. Try again with more of their listing.');
    const result = L.compareResult(mine, theirs, verdict, now(), l.versionCount);
    await store.merge(itemsOf(req.user.id), l.id, { compare: result });
    res.json(result);
  } catch (err) { fail(res, err, 'Could not compare those. Try again.'); }
});

/* ------------------------------------------------------------------ *
 * The glow-up card: a frozen, public, read-only share
 * ------------------------------------------------------------------ */

/**
 * Publish or refresh the card. It freezes the listing as it is now - later
 * edits change nothing until the seller taps Update, which re-freezes the
 * same link. The text rides along only when `includeText` is ticked.
 */
app.post('/api/listings/:id/share', user, async (req, res) => {
  try {
    const out = await exclusive(`share/${req.user.id}/${req.params.id}`, async () => {
      const l = await loadListing(req);
      const includeText = (req.body || {}).includeText === true;
      const card = L.shareCard(l, await loadVersions(req.user.id, l.id), { includeText });
      let token = l.shareToken;
      if (!token) {
        token = L.newToken();
        while (await store.get('shares', token)) token = L.newToken();
      }
      const at = now();
      await store.set('shares', token, { uid: req.user.id, listingId: l.id, createdAt: at, card });
      await store.merge(itemsOf(req.user.id), l.id, { shareToken: token, sharedAt: at, shareText: includeText });
      return { token, url: `s/${token}`, sharedAt: at, includeText, card };
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

app.delete('/api/listings/:id/share', user, async (req, res) => {
  try {
    const l = await loadListing(req);
    if (l.shareToken) await store.remove('shares', l.shareToken);
    await store.merge(itemsOf(req.user.id), l.id, { shareToken: null, sharedAt: null, shareText: false });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// The public card. No account, no model call, read-only.
app.get('/api/shared/:token', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const token = String(req.params.token || '');
    if (!L.TOKEN_RE.test(token)) throw httpError(404, 'This link is not valid.');
    const s = await store.get('shares', token);
    if (!s || !s.card) throw httpError(404, 'This link is not valid any more.');
    res.json({ ...s.card, preview: Boolean(req.user && req.user.id === s.uid) });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// The card is the same single-page app served one level down at s/<token>.
// <base href="../"> makes every relative asset and API path in it resolve
// against the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function publicIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get('/s/:token', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(publicIndex());
});
// GET is the only verb the public paths answer.
app.all(['/s/:token', '/api/shared/:token'], (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once - try a smaller screenshot or less text.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // GLOWUP_DEV_MOUNT=/glowup runs it the way the lab host does: mounted under
  // a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.GLOWUP_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`glowup listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
