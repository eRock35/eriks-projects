// As Filed - what public company filings say, with the filing beside every
// number and the exact words beside every relationship. See CLAUDE.md.
//
// THE APP IS A STATIC DATASET AND A PAGE. Everything a reader sees was
// worked out at build time by the tools in tools/, from public sources
// cached outside this repo, and checked by tools/verify.js: a relationship
// whose quote is not in its source word for word never reaches
// public/data/ (index.json, patterns.json, c/<ID>.json). At run time
// this server:
//
//   - serves the page and the dataset;
//   - mounts the shared account at /api/auth (the lab's usual identity, so
//     the email-verification banner has something to ask) - nothing in the
//     app needs a sign-in;
//   - makes NO model call and NO outbound request. The page never calls
//     sec.gov either: links open it.
//
// ASFILED_FAKE_AI exists only because every lab app has the switch (the lab
// host sets it locally); nothing here calls a model, real or fake.

const fs = require('fs');
const path = require('path');
const express = require('express');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const identityLib = require('./lib/identity');

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
app.get(/^\/data\/(index|patterns|c\/[A-Z]{1,6})\.json$/, (req, res, next) => {
  if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return next();
  const file = path.join(__dirname, 'public', req.path);
  let body = gz.get(file);
  if (!body) {
    try { body = zlib.gzipSync(fs.readFileSync(file), { level: 9 }); } catch (e) { return next(); }
    gz.set(file, body);
  }
  res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Cache-Control': 'public, max-age=300' });
  res.send(body);
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

module.exports = { app, identity, identityStore, store };
