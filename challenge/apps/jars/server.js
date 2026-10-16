// Jars - pocket money in three jars: spend, save, give. See CLAUDE.md.
//
// NOTHING ABOUT ANY CHILD IS EVER SENT HERE. A family lives on the phone
// that made it (localStorage), and the page runs public/jars-core.js itself:
// paydays, the split, interest, goals, the moves, the CSV, the calendar file
// and the export are all worked out on the phone. A grandparents' snapshot
// and a gift note travel inside a link's FRAGMENT (the part after '#'), which
// browsers never send to a server.
//
// And there is NO MODEL CALL, anywhere, on purpose: a children's money app
// has nothing it needs a model for, and nothing about a child should be sent
// to one. No Anthropic client, no metered route, no AI button.
//
// What the server does:
//   - serves the page, the grandparents' page and the service worker;
//   - the shared account at /api/auth (for the verify banner and so the lab
//     is consistent; nothing in Jars needs an account).

const path = require('path');
const express = require('express');

const { MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/jars-core');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
// The lab's `npm run dev` sets <SLUG>_FAKE_AI=1 for every app. Jars has no
// model to fake, so the switch does nothing here - but like every sibling's
// it is refused on Cloud Run, so a dev setting can never ship.
if (process.env.JARS_FAKE_AI === '1' && process.env.K_SERVICE) throw new Error('JARS_FAKE_AI=1 is for local use only and is refused on Cloud Run (Jars has no model to fake anyway).');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // The grandparents' page: its snapshot is in the fragment, which never
  // travels in a Referer anyway - but the page should not be indexed either.
  if (/^\/gran(\.html)?$/.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});
// Nothing here takes more than an account form.
app.use(express.json({ limit: '16kb' }));

/* ------------------------------------------------------------------ *
 * The shared account (no Jars feature uses it)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'jars',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Jars',
  mountPath: '/api/auth',
});
identity.mount(app);

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, stores: 'nothing', model: 'none' }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: Core.LIMITS, currencies: Core.CURRENCIES });
});

// The service worker must be re-checked on every load, or a fix would wait
// for its cache to expire. Its scope is this app's base, its own folder.
app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// The grandparents' page. The snapshot is everything after '#', which the
// browser keeps to itself: this route only ever sees "/gran".
app.get('/gran', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'gran.html'));
});

const INDEX = path.join(__dirname, 'public', 'index.html');
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
// There is deliberately no route that takes a child, a jar or an amount.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Never log a parse error's message: V8 quotes the start of the body in it.
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too big.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // JARS_DEV_MOUNT=/jars runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.JARS_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`jars listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}`));
}

module.exports = { app, identity, identityStore };
