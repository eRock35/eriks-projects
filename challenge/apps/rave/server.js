// Rave - answer every review like a pro, even the ones that sting.
//
// Restaurants, salons, contractors, clinics and shops live on their Google and
// Yelp stars, and most owners dread replying: they reply late, or never, or
// angrily - and the angry one is the one that gets screenshotted. Rave keeps
// an inbox of reviews, triages them, drafts replies in the owner's voice,
// cools an angry reply down before it goes public, and keeps score.
//
// There are no platform integrations: no Google or Yelp login, no scraping,
// no posting. A review arrives by paste or screenshot; a reply leaves by the
// clipboard, and the owner posts it themselves. See CLAUDE.md.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const V = require('./lib/reviews');
const R = require('./public/rules');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const { demo } = require('./lib/demo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.RAVE_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('RAVE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor. Both read screenshots.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A wall link is the credential for that wall. It must not ride out in a
  // Referer header, and it must not be indexed under Rave's name.
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
const bigJson = express.json({ limit: '6mb' });
const smallJson = express.json({ limit: '128kb' });
app.use((req, res, next) => (req.path === '/api/reviews/read' ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'rave',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Rave',
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
const httpError = V.httpError;
const fail = (res, err, fallback = 'Something went wrong.') => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : fallback });
};

/** The page sends its own local date, so "today" and the streak mean the
 *  person's day; anything implausible falls back to UTC. */
const todayOf = (req) => V.todayFrom(req.get('x-local-date') || req.query.today);

/** 22 url-safe characters from 16 random bytes. */
const newToken = () => crypto.randomBytes(16).toString('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{16,40}$/;

const reviewsOf = (uid) => `reviews/${uid}/items`;

async function loadSettings(uid) {
  const s = (await store.get('settings', uid)) || {};
  return {
    ...V.cleanSettings(s, V.SETTINGS_DEFAULTS),
    badges: s.badges || {},
    wallToken: s.wallToken || null,
    wallSharedAt: s.wallSharedAt || null,
    wallTitle: s.wallTitle || '',
    wallReplies: Boolean(s.wallReplies),
  };
}
function settingsView(s) {
  const { badges, wallToken, wallSharedAt, wallTitle, wallReplies, ...rest } = s; // eslint-disable-line no-unused-vars
  return { ...rest, setUp: Boolean(s.businessName || s.ownerName) };
}

const loadAll = (uid) => store.list(reviewsOf(uid), { limit: V.LIMITS.reviews + 1 });

async function loadReview(req) {
  const r = await store.get(reviewsOf(req.user.id), String(req.params.id || '').slice(0, 64));
  // 404, never 403: another person's review id is not confirmed to exist.
  if (!r) throw httpError(404, 'No such review.');
  return r;
}

/** One write at a time per review: a double-tapped "Mark replied" must not
 *  stamp twice, and two tabs must not race a draft. */
const busy = new Set();
async function exclusive(key, fn) {
  if (busy.has(key)) throw httpError(409, 'Still working on the last change.');
  busy.add(key);
  try { return await fn(); } finally { busy.delete(key); }
}

/**
 * Badges are earned once and kept. The set is computed from the inbox on
 * every write that could earn one, and any not already recorded is stamped
 * with the day.
 */
async function syncBadges(uid, reviews, settings, today) {
  const got = V.earnedBadges(reviews, today, { wall: Boolean(settings.wallToken) });
  const fresh = [...got].filter((k) => !settings.badges[k]);
  if (fresh.length) {
    const patch = {};
    for (const k of fresh) patch[k] = today;
    await store.merge('settings', uid, { badges: patch });
    Object.assign(settings.badges, patch);
  }
  return V.BADGES.filter((b) => fresh.includes(b.key));
}

/** A review as its owner sees it, with the checklist for its current reply
 *  and the earlier replies the page's live copy-paste check needs. */
function detail(r, all, settings, today) {
  const v = V.view(r, today);
  const others = V.othersFor(all, r.id);
  return {
    ...v,
    others,
    lint: v.reply ? V.lintFor(v.reply.text, r, all, settings) : null,
  };
}

async function saveReview(uid, r) {
  const { id, ...data } = r;
  data.updatedAt = now();
  await store.set(reviewsOf(uid), id, data);
  return { id, ...data };
}

/** A change to one review, done exclusively, answered with its fresh detail
 *  plus any badge it earned. */
async function mutate(req, res, fn) {
  try {
    const out = await exclusive(`r/${req.user.id}/${req.params.id}`, async () => {
      const r = await loadReview(req);
      const today = todayOf(req);
      const extra = (await fn(r, today)) || {};
      const saved = await saveReview(req.user.id, r);
      const settings = await loadSettings(req.user.id);
      const all = (await loadAll(req.user.id)).map((x) => (x.id === saved.id ? saved : x));
      const newBadges = await syncBadges(req.user.id, all, settings, today);
      return { ...detail(saved, all, settings, today), newBadges, ...extra };
    });
    res.json(out);
  } catch (err) { fail(res, err); }
}

/* ------------------------------------------------------------------ *
 * Public: health, meta, the sample
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    platforms: V.PLATFORMS,
    tones: V.TONES.map(({ key, label }) => ({ key, label })),
    topics: R.TOPICS,
    risks: R.RISKS,
    kinds: R.KINDS,
    badges: V.BADGES,
    limits: V.LIMITS,
  });
});

// A hand-made inbox run through the real arithmetic. No model call for a
// signed-out visitor, ever.
app.get('/api/demo', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(demo(todayOf(req)));
});

/* ------------------------------------------------------------------ *
 * Me and settings
 * ------------------------------------------------------------------ */

app.get('/api/me', async (req, res) => {
  try {
    if (!req.user) return res.json({ signedIn: false });
    const s = await loadSettings(req.user.id);
    res.json({
      signedIn: true,
      email: req.user.email,
      budget: identityLib.budgetFor(req.user),
      tier: identityLib.planFor(req.user, MODELS).tier,
      settings: settingsView(s),
    });
  } catch (err) { fail(res, err); }
});

app.get('/api/settings', user, async (req, res) => {
  try { res.json(settingsView(await loadSettings(req.user.id))); } catch (err) { fail(res, err); }
});

app.put('/api/settings', user, async (req, res) => {
  try {
    const prev = await loadSettings(req.user.id);
    const next = V.cleanSettings(req.body, prev);
    await store.merge('settings', req.user.id, { ...next, updatedAt: now() });
    res.json(settingsView({ ...prev, ...next }));
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The inbox
 * ------------------------------------------------------------------ */

app.get('/api/reviews', user, async (req, res) => {
  try {
    const today = todayOf(req);
    const all = await loadAll(req.user.id);
    const views = V.sortViews(all.map((r) => V.view(r, today, { full: false })));
    res.set('Cache-Control', 'no-store');
    res.json({
      today,
      reviews: views,
      counts: {
        all: views.length,
        waiting: views.filter((v) => v.status === 'waiting').length,
        urgent: views.filter((v) => ['urgent', 'high'].includes(v.urgency)).length,
        replied: views.filter((v) => v.status === 'replied').length,
        favourites: views.filter((v) => v.favourite).length,
      },
      streak: V.streaks(all, today),
    });
  } catch (err) { fail(res, err); }
});

app.post('/api/reviews', user, async (req, res) => {
  try {
    const b = req.body || {};
    const today = todayOf(req);
    const facts = V.cleanReview(b, null, today);
    const all = await loadAll(req.user.id);
    if (all.length >= V.LIMITS.reviews) throw httpError(409, `You have ${V.LIMITS.reviews} reviews - the most an inbox holds. Delete some old answered ones first.`);
    const at = now();
    const r = {
      ...facts,
      source: b.source === 'snap' ? 'snap' : 'paste',
      addedAt: at,
      addedDay: today,
      triage: null,
      reply: null,
      repliedAt: null,
      repliedDay: null,
      replySource: null,
      favourite: false,
      createdAt: at,
      updatedAt: at,
    };
    const id = await store.add(reviewsOf(req.user.id), r);
    const settings = await loadSettings(req.user.id);
    res.json(detail({ id, ...r }, [...all, { id, ...r }], settings, today));
  } catch (err) { fail(res, err); }
});

/**
 * Snap a review: one screenshot in, a proposed review out. Nothing is saved -
 * the page fills the Add form and only its Save (an ordinary POST
 * /api/reviews) stores anything. The image is validated before anything is
 * spent, read once, and dropped with the request.
 */
app.post('/api/reviews/read', ...spend, bigJson, async (req, res) => {
  try {
    const image = photo.validate((req.body || {}).image);
    const client = await clientFor(req);
    const raw = await ai.readReview(client, modelFor(req), image);
    const proposal = ai.validateRead(raw, todayOf(req));
    if (!proposal) throw httpError(422, 'That doesn’t look like a review we can read. Try a tighter screenshot that shows the stars - or paste it in.');
    res.json(proposal);
  } catch (err) { fail(res, err, 'Could not read that screenshot. Try again, or paste it in.'); }
});

/** Venting is free and never stored: the thermometer is public/rules.js,
 *  which the page runs itself. Cooling it down is a model call. */
app.post('/api/cooldown', ...spend, async (req, res) => {
  try {
    const b = req.body || {};
    const angry = V.cleanText(b.text, V.LIMITS.vent);
    if (angry.length < 10) throw httpError(400, 'Type the reply you want to send first - at least a sentence.');
    const today = todayOf(req);
    const settings = await loadSettings(req.user.id);
    let review = null;
    let all = [];
    if (b.reviewId) {
      review = await store.get(reviewsOf(req.user.id), String(b.reviewId).slice(0, 64));
      if (!review) throw httpError(404, 'No such review.');
      all = await loadAll(req.user.id);
    }
    const triage = review ? V.triageOf(review) : null;
    const client = await clientFor(req);
    const out = await ai.coolDown(client, modelFor(req), angry, review, triage, settings);
    // The thermometer is ours, not the model's: both sides measured by the
    // same rules the page runs, and anything the rules saw leave is listed
    // even when the model forgot to say so.
    const ctx = { reviewer: review ? review.reviewer : '', contactLine: settings.contactLine };
    const heatBefore = R.heat(angry, ctx);
    const heatAfter = R.heat(out.calm, ctx);
    const stillThere = new Set(heatAfter.flags.map((f) => f.kind));
    const listed = new Set(out.removed.map((x) => x.kind));
    for (const f of heatBefore.flags) {
      if (!stillThere.has(f.kind) && !listed.has(f.kind)) out.removed.push({ kind: f.kind, quote: V.clean(f.sample, 100), why: 'Rave’s heat check caught this in your draft.', by: 'rules' });
    }
    res.json({
      calm: out.calm,
      kept: out.kept,
      removed: out.removed.map((x) => ({ ...x, emoji: R.kindInfo(x.kind).emoji, label: R.kindInfo(x.kind).label })),
      heatBefore,
      heatAfter,
      reviewId: review ? review.id : null,
      lint: review ? V.lintFor(out.calm, review, all, settings) : R.lint(out.calm, { contactLine: settings.contactLine }),
    });
  } catch (err) { fail(res, err, 'Could not cool that down. Try again.'); }
});

app.get('/api/reviews/:id', user, async (req, res) => {
  try {
    const r = await loadReview(req);
    const settings = await loadSettings(req.user.id);
    res.json(detail(r, await loadAll(req.user.id), settings, todayOf(req)));
  } catch (err) { fail(res, err); }
});

app.put('/api/reviews/:id', user, (req, res) => mutate(req, res, async (r, today) => {
  Object.assign(r, V.cleanReview(req.body, r, today));
}));

app.delete('/api/reviews/:id', user, async (req, res) => {
  try {
    const r = await loadReview(req);
    await store.remove(reviewsOf(req.user.id), r.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/** Save the reply being written. Not posted anywhere - Rave cannot post. */
app.put('/api/reviews/:id/reply', user, (req, res) => mutate(req, res, async (r) => {
  const b = req.body || {};
  const text = V.cleanText(b.text, V.LIMITS.reply);
  const source = ['ai', 'template', 'cooled', 'own'].includes(b.source) ? b.source : 'own';
  r.reply = text ? { text, source, at: now() } : null;
}));

/** "I posted it." The person copies the reply, posts it on Google or Yelp
 *  themselves, and taps this - which is what the scoreboard counts. `on` lets
 *  a backlog of already-answered reviews be logged with the day they were. */
app.post('/api/reviews/:id/replied', user, (req, res) => mutate(req, res, async (r, today) => {
  const b = req.body || {};
  if (b.replied === false) {
    r.repliedAt = null; r.repliedDay = null; r.replySource = null;
    return;
  }
  if (b.text !== undefined) {
    const text = V.cleanText(b.text, V.LIMITS.reply);
    if (text) r.reply = { text, source: ['ai', 'template', 'cooled', 'own'].includes(b.source) ? b.source : ((r.reply && r.reply.source) || 'own'), at: now() };
  }
  let day = today;
  let at = now();
  if (b.on) {
    day = V.isoDay(b.on);
    if (!day) throw httpError(400, 'That date is not a real date.');
    if (day > today) throw httpError(400, 'You cannot have replied in the future.');
    if (day < r.date) throw httpError(400, 'That is before the review was posted.');
    if (day !== today) at = `${day}T12:00:00.000Z`;
  }
  const first = !r.repliedAt;
  r.repliedAt = at;
  r.repliedDay = day;
  r.replySource = (r.reply && r.reply.source) || 'own';
  const waitingLeft = (await loadAll(req.user.id)).filter((x) => x.id !== r.id && !x.repliedAt).length;
  return { justReplied: first, waitingLeft };
}));

app.post('/api/reviews/:id/favourite', user, (req, res) => mutate(req, res, async (r) => {
  const on = (req.body || {}).favourite !== false;
  if (on && r.stars < 4) throw httpError(400, 'The wall of love is for 4 and 5 star reviews.');
  if (on && !(r.text || '').trim()) throw httpError(400, 'A star rating with no words cannot go on the wall.');
  r.favourite = on;
}));

/** Free, always: the no-model reply for this review, in the owner's tone. */
app.post('/api/reviews/:id/template', user, async (req, res) => {
  try {
    const r = await loadReview(req);
    const settings = await loadSettings(req.user.id);
    const all = await loadAll(req.user.id);
    const text = V.template(r, settings, Number((req.body || {}).variant) || 0);
    res.json({ text, source: 'template', lint: V.lintFor(text, r, all, settings) });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Metered: a deeper triage, and a reply in your voice
 * ------------------------------------------------------------------ */

app.post('/api/reviews/:id/triage', ...spend, (req, res) => mutate(req, res, async (r) => {
  const client = await clientFor(req);
  const t = await ai.triage(client, modelFor(req), r);
  r.triage = { ...t, at: now() };
}));

app.post('/api/reviews/:id/draft', ...spend, async (req, res) => {
  try {
    const r = await loadReview(req);
    const settings = await loadSettings(req.user.id);
    const client = await clientFor(req);
    const out = await ai.reply(client, modelFor(req), r, V.triageOf(r), settings);
    const all = await loadAll(req.user.id);
    res.json({ text: out.text, note: out.note, source: 'ai', lint: V.lintFor(out.text, r, all, settings) });
  } catch (err) { fail(res, err, 'Could not write that reply. Try again, or use a template.'); }
});

/* ------------------------------------------------------------------ *
 * The scoreboard
 * ------------------------------------------------------------------ */

app.get('/api/scoreboard', user, async (req, res) => {
  try {
    const today = todayOf(req);
    const settings = await loadSettings(req.user.id);
    const all = await loadAll(req.user.id);
    await syncBadges(req.user.id, all, settings, today);
    res.set('Cache-Control', 'no-store');
    res.json({
      ...V.scoreboard(all, today),
      badges: V.BADGES.map((b) => ({ ...b, earnedAt: settings.badges[b.key] || null })),
    });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The wall of love
 * ------------------------------------------------------------------ */

function wallState(settings, all, today) {
  const candidates = V.sortViews(all.filter((r) => r.stars >= 4 && (r.text || '').trim()).map((r) => V.view(r, today, { full: false })))
    .sort((a, b) => Number(b.favourite) - Number(a.favourite) || String(b.date).localeCompare(String(a.date)));
  return {
    share: settings.wallToken ? { token: settings.wallToken, url: `s/${settings.wallToken}`, sharedAt: settings.wallSharedAt } : null,
    title: settings.wallTitle || '',
    showReplies: settings.wallReplies,
    candidates,
    preview: V.wallOf(settings, all, { title: settings.wallTitle, showReplies: settings.wallReplies }, today),
  };
}

app.get('/api/wall', user, async (req, res) => {
  try {
    const settings = await loadSettings(req.user.id);
    res.json(wallState(settings, await loadAll(req.user.id), todayOf(req)));
  } catch (err) { fail(res, err); }
});

/**
 * Publish: freeze a copy. The link shows the wall as it was when it was
 * published - a review hearted or deleted later changes nothing until the
 * owner taps Update, which re-freezes the same link. Revoking deletes the
 * copy and the link is dead for good.
 */
app.post('/api/wall', user, async (req, res) => {
  try {
    const out = await exclusive(`wall/${req.user.id}`, async () => {
      const b = req.body || {};
      const today = todayOf(req);
      const settings = await loadSettings(req.user.id);
      const all = await loadAll(req.user.id);
      const title = b.title !== undefined ? V.clean(b.title, 80) : settings.wallTitle;
      const showReplies = b.showReplies !== undefined ? b.showReplies === true : settings.wallReplies;
      const wall = V.wallOf(settings, all, { title, showReplies }, today);
      if (!wall.reviews.length) throw httpError(400, 'Heart at least one 4 or 5 star review first - those are what the wall shows.');
      let token = settings.wallToken;
      if (!token) {
        token = newToken();
        while (await store.get('shares', token)) token = newToken();
      }
      const at = now();
      await store.set('shares', token, { uid: req.user.id, createdAt: at, wall });
      await store.merge('settings', req.user.id, { wallToken: token, wallSharedAt: at, wallTitle: title, wallReplies: showReplies });
      Object.assign(settings, { wallToken: token, wallSharedAt: at, wallTitle: title, wallReplies: showReplies });
      const newBadges = await syncBadges(req.user.id, all, settings, today);
      return { ...wallState(settings, all, today), newBadges };
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

app.delete('/api/wall', user, async (req, res) => {
  try {
    const settings = await loadSettings(req.user.id);
    if (settings.wallToken) await store.remove('shares', settings.wallToken);
    await store.merge('settings', req.user.id, { wallToken: null, wallSharedAt: null });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// The public wall. No account, no model call, read-only: GET is the only
// verb this path answers.
app.get('/api/shared/:token', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) throw httpError(404, 'This link is not valid.');
    const s = await store.get('shares', token);
    if (!s || !s.wall) throw httpError(404, 'This link is not valid any more.');
    res.json({ ...s.wall, preview: Boolean(req.user && req.user.id === s.uid) });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// The wall is the same single-page app served one level down at s/<token>.
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

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once - try a smaller screenshot.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // RAVE_DEV_MOUNT=/rave runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.RAVE_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`rave listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
