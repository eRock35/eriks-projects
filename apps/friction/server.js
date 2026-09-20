const path = require('path');
const express = require('express');

const db = require('./lib/db');
const auth = require('./lib/auth');
const scan = require('./lib/scan');
const score = require('./lib/score');

const app = express();
const PORT = process.env.PORT || 8080;

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));

// Express does not parse cookies and this app needs exactly one of them.
app.use((req, _res, next) => {
  req.cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  next();
});

/* ---------- open routes: health, login, cron ---------- */

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/api/auth/login', (req, res) => {
  if (!process.env.APP_PASSWORD || !process.env.SESSION_SECRET) {
    return res.status(500).json({ error: 'Sign-in is not configured on this deployment.' });
  }
  if (!auth.passwordOk((req.body || {}).password)) {
    return res.status(401).json({ error: 'That password is not right.' });
  }
  auth.issue(res);
  res.json({ ok: true });
});

// The one route Cloud Scheduler calls. Session OR cron key - never neither,
// because everything past here spends Anthropic tokens.
app.post('/api/cron/scan', auth.requireLoginOrCron, async (req, res) => {
  try {
    const summary = await scan.runScan({
      trigger: auth.hasSession(req) ? 'manual' : 'cron',
      scope: String(req.query.scope || 'next'),
    });
    res.json(summary);
  } catch (err) {
    console.error('POST /api/cron/scan', err);
    res.status(500).json({ error: err.message });
  }
});

/* ---------- everything below needs a session ---------- */

app.use(auth.requireLogin);
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth/logout', (_req, res) => { auth.clear(res); res.json({ ok: true }); });
app.get('/api/auth/me', (_req, res) => res.json({ signedIn: true }));

app.get('/api/signals', async (req, res) => {
  try {
    const all = await db.list('signals');
    const status = req.query.status;
    const lens = req.query.lens;
    let rows = all;
    if (status && status !== 'all') rows = rows.filter((r) => (r.status || 'new') === status);
    if (lens && lens !== 'all') rows = rows.filter((r) => r.lensId === lens);

    const sort = req.query.sort || 'score';
    rows.sort((a, b) => {
      if (sort === 'recent') return String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || ''));
      if (sort === 'recurrence') return (b.seenCount || 0) - (a.seenCount || 0) || (b.score || 0) - (a.score || 0);
      return (b.score || 0) - (a.score || 0);
    });

    res.json({
      signals: rows,
      counts: all.reduce((acc, r) => {
        const s = r.status || 'new';
        acc[s] = (acc[s] || 0) + 1;
        acc.all = (acc.all || 0) + 1;
        return acc;
      }, {}),
      weights: score.WEIGHTS,
    });
  } catch (err) {
    console.error('GET /api/signals', err);
    res.status(500).json({ error: 'Could not load the board.' });
  }
});

app.patch('/api/signals/:id', async (req, res) => {
  try {
    const existing = await db.get('signals', req.params.id);
    if (!existing) return res.status(404).json({ error: 'No such signal.' });
    const patch = {};
    if (typeof req.body.status === 'string') {
      if (!scan.STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Unknown status.' });
      patch.status = req.body.status;
    }
    if (typeof req.body.notes === 'string') patch.notes = req.body.notes.slice(0, 4000);
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });
    patch.decidedAt = new Date().toISOString();
    await db.merge('signals', req.params.id, patch);
    res.json(Object.assign({}, existing, patch));
  } catch (err) {
    console.error('PATCH /api/signals', err);
    res.status(500).json({ error: 'Could not save that.' });
  }
});

app.get('/api/lenses', async (_req, res) => {
  try {
    res.json({ lenses: await scan.loadLenses() });
  } catch (err) {
    console.error('GET /api/lenses', err);
    res.status(500).json({ error: 'Could not load lenses.' });
  }
});

app.patch('/api/lenses/:id', async (req, res) => {
  try {
    const existing = await db.get('lenses', req.params.id);
    if (!existing) return res.status(404).json({ error: 'No such lens.' });
    const patch = {};
    if (typeof req.body.enabled === 'boolean') patch.enabled = req.body.enabled;
    if (Array.isArray(req.body.subs)) patch.subs = req.body.subs.slice(0, 8).map(String);
    if (typeof req.body.hn === 'string') patch.hn = req.body.hn.slice(0, 300);
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });
    await db.merge('lenses', req.params.id, patch);
    res.json(Object.assign({}, existing, patch));
  } catch (err) {
    console.error('PATCH /api/lenses', err);
    res.status(500).json({ error: 'Could not save that.' });
  }
});

app.get('/api/runs', async (_req, res) => {
  try {
    const runs = await db.list('runs', { orderBy: 'startedAt', dir: 'desc', limit: 12 });
    res.json({ runs, last: await db.get('control', 'last-run') });
  } catch (err) {
    console.error('GET /api/runs', err);
    res.status(500).json({ error: 'Could not load runs.' });
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Friction listening on :${PORT}`));
