// The challenge lab: challenge.strongtechnicalconsulting.com
//
// One Cloud Run service that serves a landing page at / and every trial app
// at /<slug>/. Why one service rather than one per app: a new app then needs
// no new infrastructure at all - no service, no database, no runtime account,
// no IAM change for Erik to make - it is a folder and a registry entry. An app
// that earns it graduates to its own subdomain and service (CLAUDE.md).
//
// Each app is an ordinary Express app exported from apps/<slug>/server.js and
// mounted as a sub-app. Before it is required, the host sets
// <SLUG>_COLLECTION_PREFIX so its data lands in `<slug>_*` collections of the
// shared `challenge` database - apps never see each other's collections by
// name, and graduating one is a copy of its prefix.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const lab = require('./lab');

const PORT = process.env.PORT || 8080;
const MEMORY = process.env.LAB_MEMORY === '1';
if (MEMORY && process.env.K_SERVICE) throw new Error('LAB_MEMORY=1 is for local use only.');

const host = express();
host.set('trust proxy', 1);
host.disable('x-powered-by');

/* ---------------- mount the apps ---------------- */

const mounted = [];
for (const a of lab.APPS) {
  if (a.status !== 'testing') continue;
  const dir = path.join(__dirname, 'apps', a.slug);
  if (!fs.existsSync(path.join(dir, 'server.js'))) {
    console.warn(`[lab] ${a.slug}: no apps/${a.slug}/server.js, not mounted`);
    continue;
  }
  const KEY = a.slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  if (process.env[`${KEY}_COLLECTION_PREFIX`] === undefined) process.env[`${KEY}_COLLECTION_PREFIX`] = `${a.slug}_`;
  if (MEMORY) {
    process.env[`${KEY}_MEMORY`] = '1';
    process.env[`${KEY}_FAKE_AI`] = '1';
  }
  try {
    const sub = require(path.join(dir, 'server.js')).app;
    // A relative asset link only resolves under the trailing slash.
    // Express matches /spar and /spar/ alike, so check the raw path or this
    // redirects /spar/ to itself forever.
    host.use((req, res, next) => {
      const [p, q = ''] = req.originalUrl.split(/\?(.*)/s);
      if (p !== `/${a.slug}`) return next();
      res.redirect(301, `/${a.slug}/${q ? `?${q}` : ''}`);
    });
    host.use(`/${a.slug}`, sub);
    mounted.push(a.slug);
  } catch (err) {
    // One broken app must never take the lab down with it.
    console.error(`[lab] ${a.slug} failed to load:`, err.message);
  }
}
console.log(`[lab] mounted: ${mounted.join(', ') || 'none'}`);

/* ---------------- the lab's own data: votes and notes ---------------- */

const store = (() => {
  if (MEMORY) {
    const m = new Map();
    return {
      async get(c, id) { return m.get(`${c}/${id}`) || null; },
      async set(c, id, v) { m.set(`${c}/${id}`, v); },
      async bump(c, id, d) { const cur = m.get(`${c}/${id}`) || {}; for (const [k, v] of Object.entries(d)) cur[k] = (cur[k] || 0) + v; m.set(`${c}/${id}`, cur); },
      async add(c, v) { m.set(`${c}/${Date.now()}${Math.random()}`, v); },
    };
  }
  const { Firestore, FieldValue } = require('@google-cloud/firestore');
  const db = new Firestore({
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    databaseId: process.env.FIRESTORE_DATABASE_ID || 'challenge',
    ignoreUndefinedProperties: true,
  });
  return {
    async get(c, id) { const s = await db.collection(c).doc(id).get(); return s.exists ? s.data() : null; },
    async set(c, id, v) { await db.collection(c).doc(id).set(v); },
    async bump(c, id, d) {
      const patch = {};
      for (const [k, v] of Object.entries(d)) patch[k] = FieldValue.increment(v);
      await db.collection(c).doc(id).set(patch, { merge: true });
    },
    async add(c, v) { await db.collection(c).add(v); },
  };
})();

// An opaque random visitor id, first-party, so a vote can be changed but not
// stuffed from one browser. No IP, no user agent, nothing tied to an account.
const VID = 'lab_vid';
function visitor(req, res) {
  const m = /(?:^|;\s*)lab_vid=([A-Za-z0-9_-]{16,40})/.exec(req.headers.cookie || '');
  if (m) return m[1];
  const id = crypto.randomBytes(16).toString('base64url');
  res.append('Set-Cookie', `${VID}=${id}; Path=/; Max-Age=${60 * 60 * 24 * 400}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return id;
}

const lj = express.json({ limit: '8kb' });

host.get('/api/health', (_req, res) => res.json({ ok: true, apps: mounted }));
host.get('/healthz', (_req, res) => res.json({ ok: true }));

host.get('/api/lab', async (req, res) => {
  try {
    const vid = visitor(req, res);
    const apps = [];
    for (const a of lab.APPS) {
      const tally = (await store.get('lab_votes', a.slug)) || {};
      const mine = await store.get('lab_voters', `${a.slug}:${vid}`);
      apps.push({ ...a, live: mounted.includes(a.slug), votes: { keep: tally.keep || 0, kill: tally.kill || 0 }, myVote: mine ? mine.v : null });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ apps, now: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the lab.' });
  }
});

host.post('/api/lab/:slug/vote', lj, async (req, res) => {
  try {
    const a = lab.get(req.params.slug);
    if (!a) return res.status(404).json({ error: 'No such app.' });
    const v = (req.body || {}).v;
    if (!['keep', 'kill', null].includes(v)) return res.status(400).json({ error: 'Vote keep or kill.' });
    const vid = visitor(req, res);
    const key = `${a.slug}:${vid}`;
    const prev = await store.get('lab_voters', key);
    const d = {};
    if (prev && prev.v) d[prev.v] = -1;
    if (v) d[v] = (d[v] || 0) + 1;
    if (Object.keys(d).length) await store.bump('lab_votes', a.slug, d);
    await store.set('lab_voters', key, { v, at: new Date().toISOString() });
    const tally = (await store.get('lab_votes', a.slug)) || {};
    res.json({ votes: { keep: Math.max(0, tally.keep || 0), kill: Math.max(0, tally.kill || 0) }, myVote: v });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not record that.' });
  }
});

// Feedback goes to Erik, not to the page: it is never displayed, so there is
// nothing to moderate and nothing for a stranger to deface.
host.post('/api/lab/:slug/note', lj, async (req, res) => {
  try {
    const a = lab.get(req.params.slug);
    if (!a) return res.status(404).json({ error: 'No such app.' });
    const text = String((req.body || {}).text || '').replace(/[<>]/g, '').trim().slice(0, 600);
    if (text.length < 3) return res.status(400).json({ error: 'Say a little more.' });
    await store.add('lab_notes', { slug: a.slug, text, vid: visitor(req, res), at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send that.' });
  }
});

host.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  next();
});
host.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
host.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
host.use((_req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  host.listen(PORT, () => console.log(`[lab] listening on ${PORT}${MEMORY ? ' (memory)' : ''}`));
}

module.exports = { host, mounted };
