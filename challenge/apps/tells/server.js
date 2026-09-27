// Tells - see the tells of AI in a post, a page, a picture or a video.
//
// Paste text, give a link, drop a picture or a video, and Tells shows the
// EVIDENCE: the exact passages that read as model-written and why, what the
// file's metadata says about where it came from, what a visual read noticed,
// and - separately - how original the ideas are, with the earlier sources a
// web search found. A likelihood with a confidence band, never a verdict.
// See CLAUDE.md for the honesty spine and why there are no share links.
//
// Free, no account: the quick scan (public/tells-core.js) and the metadata
// scanner (public/tells-meta.js), both of which run in the browser and in the
// extension too. Free with an account: fetching a link. Metered (a model
// call): the deep read, originality (with web search), and the visual read of
// a picture or video frames.
//
// NOTHING A USER CHECKS IS STORED. No text, link, image, frame or result is
// written to Firestore or to a log. The only documents are device keys, as
// hashes. History lives in the browser's localStorage and nowhere else.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/tells-core');
const Meta = require('./public/tells-meta');
const ai = require('./lib/ai');
const images = require('./lib/images');
const { extract } = require('./lib/extract');
const { createFetcher } = require('./lib/linkfetch');
const { createDevices, createLimiter, bearer } = require('./lib/devices');
const { streamedJson } = require('./lib/stream');
const bookmarklet = require('./lib/bookmarklet');
const { samples } = require('./lib/samples');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.TELLS_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('TELLS_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor. Both read images and search.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };
// Originality searches per check. The search is billed per use ($0.01 each,
// charged through the shared ledger by identity's meter), so it is kept to
// what a check needs rather than the tier's research budget.
const SEARCHES = { free: 3, paid: 5 };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// The page draws text other people wrote (a pasted post, a fetched page, a
// model's reasons), so it carries a CSP with no inline script at all and no
// third-party anything. Every string is escaped as well; this is the net.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'", "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com",
].join('; ');
app.use((req, res, next) => {
  res.set('Content-Security-Policy', CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  // A ?q= address carries what someone was checking; it must not ride out
  // in a Referer to wherever they click next.
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

// Routes that carry a file mount their own parser AFTER their gates, so a
// stranger's 12 MB is never read. Everything else stays small.
const BIG = /^\/api\/check\/(picture|video|metadata)$/;
const TEXT_ROUTE = /^\/api\/(check\/(deep|originality)|scan)$/;
const smallJson = express.json({ limit: '32kb' });
app.use((req, res, next) => (BIG.test(req.path) || TEXT_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));
const textJson = express.json({ limit: '160kb' });
const pictureJson = express.json({ limit: '17mb' });
const videoJson = express.json({ limit: '7mb' });
const metaJson = express.json({ limit: '12mb' });

/* ------------------------------------------------------------------ *
 * The shared account, and device keys
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'tells',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Tells',
  mountPath: '/api/auth',
});
identity.mount(app);

const devices = createDevices(store);
const perKey = createLimiter({ max: 30, windowMs: 60 * 1000 });
const badKeys = createLimiter({ max: 20, windowMs: 60 * 1000 });

/**
 * A device key (Authorization: Bearer tells_...) as an alternative to the
 * cookie. It resolves to an account and loads it exactly as identity's
 * attachUser does, so everything after - requireUser, requireBudget,
 * requireDailyCap, the meter that charges the call - sees the same req.user
 * a cookie would have produced. It adds a door; it bypasses nothing.
 */
async function deviceAuth(req, res, next) {
  if (req.user) return next();
  const key = bearer(req);
  if (!key) return next();
  const ip = req.ip || 'unknown';
  if (badKeys.blocked(ip)) return res.status(429).json({ error: 'Too many wrong device keys. Wait a minute.' });
  let found;
  try { found = await devices.resolve(key); } catch (e) {
    console.error('device key check failed', e && e.code ? e.code : 'error');
    return res.status(503).json({ error: 'Tells cannot check device keys right now. Try again shortly.' });
  }
  if (!found) {
    badKeys.hit(ip);
    return res.status(401).json({ error: 'That device key did not work. Make a new one in Tells → Settings.' });
  }
  if (!perKey.hit(found.id)) return res.status(429).json({ error: 'Slow down - that is 30 checks in a minute from this device.' });
  const user = await identity.getUser(found.uid).catch(() => null);
  if (!user || user.disabled) return res.status(401).json({ error: 'The account for that device key is gone.' });
  req.user = { id: found.uid, via: 'device', device: found.id, ...user };
  delete req.user.password;
  await devices.touch(found);
  return next();
}
app.use(deviceAuth);

const sharedClient = FAKE_AI
  ? identity.meter(require('./lib/fakeai').create())
  : identity.meter(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
function clientFor(req) {
  if (FAKE_AI) return Promise.resolve(sharedClient);
  return identity.clientFor(req.user, sharedClient, (apiKey) => new Anthropic({ apiKey }));
}
const planOf = (req) => identityLib.planFor(req.user, MODELS);
const modelFor = (req) => planOf(req).model;

// Never a model call behind a sign-in alone: budget and the free tier's daily
// ceiling as well, and all three before any body is read.
const spend = [identity.requireUser, identity.requireBudget, identity.requireDailyCap];
const user = identity.requireUser;
function sessionOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in first.' });
  if (req.user.via === 'device') return res.status(403).json({ error: 'Manage device keys from the Tells page, signed in.' });
  return next();
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function httpError(status, message) { return Object.assign(new Error(message), { status, expose: true }); }

// Only the app's own errors (marked `expose`) reach the client with their
// words. Anything else is logged by its first stack lines - never a request
// body, never the text or picture someone was checking - and answered with a
// plain sentence. An upstream model failure is a 502 (503 when overloaded).
function logErr(err) {
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
}
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) logErr(err);
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : fallback, ...(err && err.code && mine ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}

/** The text to check, cleaned and capped - a 400 before anything is spent. */
function textOf(body) {
  const raw = body && typeof body.text === 'string' ? body.text : '';
  const text = Core.clean(raw).trim();
  if (!text) throw httpError(400, 'Paste some text to check.');
  if (raw.length > Core.LIMITS.text + 2000) throw httpError(400, `That is too long. Tells checks up to ${Core.LIMITS.text.toLocaleString('en-US')} characters at a time.`);
  if (Core.words(text).length < 8) throw httpError(400, 'That is too short to read for tells. Paste at least a couple of sentences.');
  return text.slice(0, Core.LIMITS.text);
}
const wantsText = (req) => req.query.format === 'text';

const fetcher = createFetcher();
/** Tests swap DNS and the transport here; the guard itself is unchanged. */
function setFetcher(opts) { Object.assign(fetcher, createFetcher(opts)); }

const scanLimit = createLimiter({ max: 60, windowMs: 60 * 1000 });

/* ------------------------------------------------------------------ *
 * Public: health, meta, samples, the quick scan, the bookmarklet
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    limits: { ...Core.LIMITS, picture: images.PREVIEW_BYTES, original: images.ORIGINAL_BYTES, frames: images.MAX_FRAMES, frame: images.FRAME_BYTES },
    notes: { limits: Core.LIMITS_LINE, metadata: Core.METADATA_NOTE, visual: Core.VISUAL_NOTE, originalNone: Core.ORIGINAL_NONE, c2pa: Meta.NOTE_C2PA },
    verifyUrl: Meta.VERIFY_URL, categories: Core.CATEGORIES,
  });
});

app.get('/api/samples', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(samples());
});

/** The quick scan, server side: free, no account, no model. The page and the
 *  extension run the same code themselves; this is for anything that cannot. */
app.post('/api/scan', textJson, (req, res) => {
  try {
    if (!scanLimit.hit(req.ip || 'unknown')) throw httpError(429, 'Slow down - that is 60 scans in a minute.');
    const text = textOf(req.body);
    const quick = Core.scan(text);
    if (wantsText(req)) return res.type('text/plain').send(Core.plainSummary({ quick }));
    res.set('Cache-Control', 'no-store');
    res.json({ quick, combined: Core.combine({ quick }) });
  } catch (err) { fail(res, err); }
});

app.get('/api/bookmarklet', (req, res) => {
  // The public link everywhere but a local run, where it points back here.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(req.hostname);
  const base = local ? `${req.protocol}://${req.get('host')}${req.baseUrl || ''}/` : bookmarklet.PUBLIC_BASE;
  res.set('Cache-Control', local ? 'no-store' : 'public, max-age=300');
  res.json(bookmarklet.build(base));
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({
    signedIn: true,
    email: req.user.email,
    via: req.user.via,
    budget: identityLib.budgetFor(req.user),
    tier: planOf(req).tier,
  });
});

/* ------------------------------------------------------------------ *
 * Device keys (signed in with the real session)
 * ------------------------------------------------------------------ */

app.get('/api/devices', sessionOnly, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ devices: await devices.list(req.user.id) });
  } catch (err) { fail(res, err); }
});
app.post('/api/devices', sessionOnly, async (req, res) => {
  try {
    const made = await devices.mint(req.user.id, (req.body || {}).label);
    res.set('Cache-Control', 'no-store');
    res.json({ ...made, shownOnce: true });
  } catch (err) { fail(res, err); }
});
app.delete('/api/devices/:id', sessionOnly, async (req, res) => {
  try {
    await devices.revoke(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Free with an account: fetch a link, scan a file's metadata
 * ------------------------------------------------------------------ */

/**
 * Fetch a page through the SSRF guard and hand back its main text with the
 * quick scan. No model call. Signed in, because it makes our server fetch
 * something on the asker's behalf. Nothing fetched is kept.
 */
app.post('/api/check/link', user, async (req, res) => {
  try {
    const got = await fetcher.get((req.body || {}).url, 'page');
    const page = extract(got.text, got.url, got.type);
    const quick = page.wall ? null : Core.scan(page.text);
    res.set('Cache-Control', 'no-store');
    res.json({
      url: page.url, host: page.host, title: page.title, description: page.description, siteName: page.siteName,
      published: page.published, image: page.image, wall: page.wall, cut: page.cut,
      text: page.wall ? '' : page.text, quick, combined: quick ? Core.combine({ quick }) : null,
    });
  } catch (err) { fail(res, err, 'That page could not be read.'); }
});

/** The metadata scan on the server, for callers that cannot run the scanner
 *  (the Shortcut). Free; signed in only so a stranger cannot make us buffer
 *  12 MB. The browser and the extension scan locally and never send this. */
app.post('/api/check/metadata', user, metaJson, (req, res) => {
  try {
    const orig = images.original((req.body || {}).image);
    const meta = Meta.scan(orig.buf);
    if (wantsText(req)) return res.type('text/plain').send(Core.plainSummary({ meta }));
    res.set('Cache-Control', 'no-store');
    res.json({ meta, combined: Core.combine({ meta }) });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Metered: the deep read, originality, the visual read
 * ------------------------------------------------------------------ */

/** Deep read. Gates, then the parser, then the 400s - and only then the
 *  whitespace stream, after which a failure is a 200 {error}. */
app.post('/api/check/deep', ...spend, textJson, async (req, res) => {
  let text;
  try { text = textOf(req.body); } catch (err) { return fail(res, err); }
  const send = streamedJson(res);
  try {
    const quick = Core.scan(text);
    const deep = await ai.deepRead(await clientFor(req), modelFor(req), text, quick);
    send({ deep, quick, combined: Core.combine({ quick, deep }) });
  } catch (err) { send(failure(err, 'The deep read did not finish. Try again.').body); }
});

app.post('/api/check/originality', ...spend, textJson, async (req, res) => {
  let text;
  try { text = textOf(req.body); } catch (err) { return fail(res, err); }
  const send = streamedJson(res);
  try {
    const plan = planOf(req);
    const search = identityLib.webSearchFor(plan.model, SEARCHES[plan.tier] || SEARCHES.free);
    const originality = await ai.originality(await clientFor(req), plan.model, search, text);
    send({ originality });
  } catch (err) { send(failure(err, 'The originality check did not finish. Try again.').body); }
});

/**
 * A picture: `preview` is what the model sees (the page draws it ~1024 px);
 * `original`, when sent (the Shortcut), is scanned here for metadata. Read
 * once, dropped. Not streamed: 5-15 s is far short of what drops a phone,
 * and plain status codes suit the Shortcut. ?format=text answers a short
 * plain summary for "Show Result".
 */
app.post('/api/check/picture', ...spend, pictureJson, async (req, res) => {
  try {
    const body = req.body || {};
    const orig = body.original ? images.original(body.original) : null;
    let prev = body.preview ? images.preview(body.preview) : null;
    if (!prev && !orig) throw httpError(400, 'Add a picture.');
    if (!prev && orig.buf.length <= images.PREVIEW_BYTES) {
      // The original doubles as the preview, with its EXIF (GPS included),
      // XMP and text chunks cut out first: the model needs the pixels only.
      const bare = images.stripMeta(orig.buf, orig.mediaType);
      if (bare) prev = { mediaType: orig.mediaType, data: bare.toString('base64') };
    }
    const meta = orig ? Meta.scan(orig.buf) : null;
    const visual = prev ? await ai.visualRead(await clientFor(req), modelFor(req), [prev], 'picture') : null;
    const out = {
      meta, visual, combined: Core.combine({ meta, visual }),
      note: prev ? null : 'This picture is too large or in a format the visual read cannot take; send a smaller JPEG as `preview` for that part.',
    };
    if (wantsText(req)) return res.type('text/plain').send(Core.plainSummary(out) + (out.note ? `\n${out.note}` : ''));
    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (err) {
    if (wantsText(req)) { const f = failure(err, 'Could not check that picture.'); return res.status(f.status).type('text/plain').send(f.body.error); }
    fail(res, err, 'Could not check that picture. Try again.');
  }
});

/** Video: the browser pulls ~6 frames and reads the metadata itself; only
 *  the frames come here, for the visual read. The video never does. */
app.post('/api/check/video', ...spend, videoJson, async (req, res) => {
  try {
    const frames = images.frames((req.body || {}).frames);
    const visual = await ai.visualRead(await clientFor(req), modelFor(req), frames, 'video');
    res.set('Cache-Control', 'no-store');
    res.json({ visual, combined: Core.combine({ visual }) });
  } catch (err) { fail(res, err, 'Could not check those frames. Try again.'); }
});

/** A page's preview image (og:image), fetched through the same guard (image
 *  types only, 8 MB), scanned for metadata here and read by the model when
 *  it is a size and type the model takes. */
app.post('/api/check/link-image', ...spend, async (req, res) => {
  try {
    const got = await fetcher.get((req.body || {}).url, 'image');
    const meta = Meta.scan(got.bytes);
    const type = Meta.sniff(got.bytes);
    const usable = images.MODEL_TYPES.includes(type) && got.bytes.length <= images.PREVIEW_BYTES;
    const bare = usable ? (images.stripMeta(got.bytes, type) || got.bytes) : null;
    const visual = usable ? await ai.visualRead(await clientFor(req), modelFor(req), [{ mediaType: type, data: bare.toString('base64') }], 'picture') : null;
    res.set('Cache-Control', 'no-store');
    res.json({ url: got.url, meta, visual, combined: Core.combine({ meta, visual }), note: usable ? null : 'The image is too large or in a format the visual read cannot take, so only its metadata was read.' });
  } catch (err) { fail(res, err, 'Could not check that image.'); }
});

/* ------------------------------------------------------------------ *
 * The page, and the extension download
 * ------------------------------------------------------------------ */

const INDEX = path.join(__dirname, 'public', 'index.html');
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: '5m',
  setHeaders(res, file) {
    if (file.endsWith('.zip')) res.set('Content-Disposition', 'attachment; filename="tells-extension.zip"');
  },
}));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  logErr(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // TELLS_DEV_MOUNT=/tells runs it the way the lab host does.
  const mount = String(process.env.TELLS_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`tells listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fetcher, setFetcher, devices };
