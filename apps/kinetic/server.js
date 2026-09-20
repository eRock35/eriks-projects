const crypto = require('crypto');
const path = require('path');
const express = require('express');

const db = require('./lib/db');
const accounts = require('./lib/accounts');
const extract = require('./lib/extract');
const shape = require('./lib/shape');
const builder = require('./lib/build');
const quota = require('./lib/quota');

const app = express();
const PORT = process.env.PORT || 8080;
const MAX_PROJECTS = 60;

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => {
  req.cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  next();
});
app.use(accounts.attachUser);

const fail = (res, err, fallback = 'Something went wrong.') =>
  res.status(err.status || 500).json({ error: err.status ? err.message : fallback });

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* ---------- accounts (only ever needed to SAVE) ---------- */

app.post('/api/auth/register', async (req, res) => {
  try {
    const uid = await accounts.register((req.body || {}).email, (req.body || {}).password);
    accounts.issue(res, uid);
    res.json({ ok: true, email: String((req.body || {}).email).trim().toLowerCase() });
  } catch (err) { fail(res, err, 'Could not create that account.'); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const uid = await accounts.signIn((req.body || {}).email, (req.body || {}).password);
    accounts.issue(res, uid);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Could not sign you in.'); }
});

app.post('/api/auth/logout', (_req, res) => { accounts.clear(res); res.json({ ok: true }); });

app.get('/api/auth/me', async (req, res) => {
  res.json({
    signedIn: Boolean(req.user),
    email: req.user ? req.user.email : null,
    remaining: await quota.remaining(req).catch(() => null),
  });
});

/* ---------- the one route that costs money ---------- */

app.post('/api/viz', async (req, res) => {
  try {
    await quota.check(req);

    const { url, text, hint } = req.body || {};
    let source;
    if (url && String(url).trim()) {
      source = await extract.fromUrl(String(url).trim());
    } else if (text && String(text).trim()) {
      source = Object.assign({ sourceUrl: null }, extract.fromText(String(text)));
    } else {
      return res.status(400).json({ error: 'Paste some data or give me a link.' });
    }

    let table = source.tables && source.tables[0];
    let fromProse = false;
    if (!table) {
      if (!source.prose || source.prose.length < 40) {
        return res.status(422).json({ error: "I couldn't find any data in that. Try a page with a table, or paste CSV." });
      }
      table = await shape.tableFromProse(source.prose, hint);
      fromProse = true;
    }

    const spec = await shape.design(table, hint);
    const viz = builder.build(table, spec);

    await quota.record(req);
    res.json({
      viz,
      title: spec.title,
      subtitle: spec.subtitle,
      note: spec.note,
      fromProse,
      sourceUrl: source.sourceUrl || null,
      rowCount: table.length - 1,
      columns: table[0],
      remaining: await quota.remaining(req).catch(() => null),
    });
  } catch (err) {
    console.error('POST /api/viz', err.message);
    fail(res, err, 'Could not build a visual from that.');
  }
});

/* ---------- saving (this is what an account is for) ---------- */

app.get('/api/projects', accounts.requireUser, async (req, res) => {
  try {
    const rows = await db.list('projects', { where: [['ownerId', '==', req.user.id]] });
    rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    res.json({ projects: rows.map((p) => ({
      id: p.id, title: p.title, type: p.viz && p.viz.type, updatedAt: p.updatedAt, shareId: p.shareId,
    })) });
  } catch (err) { fail(res, err, 'Could not load your work.'); }
});

app.post('/api/projects', accounts.requireUser, async (req, res) => {
  try {
    const { title, subtitle, note, viz, sourceUrl } = req.body || {};
    if (!viz || !viz.type) return res.status(400).json({ error: 'Nothing to save yet.' });
    const mine = await db.list('projects', { where: [['ownerId', '==', req.user.id]] });
    if (mine.length >= MAX_PROJECTS) {
      return res.status(409).json({ error: `You can keep ${MAX_PROJECTS} saved visuals. Delete one to make room.` });
    }
    const id = crypto.randomBytes(9).toString('base64url');
    const now = new Date().toISOString();
    const doc = {
      ownerId: req.user.id,
      title: String(title || 'Untitled').slice(0, 140),
      subtitle: String(subtitle || '').slice(0, 200),
      note: String(note || '').slice(0, 500),
      sourceUrl: sourceUrl || null,
      viz,
      shareId: crypto.randomBytes(9).toString('base64url'),
      createdAt: now,
      updatedAt: now,
    };
    await db.set('projects', id, doc);
    res.json({ id, shareId: doc.shareId });
  } catch (err) { fail(res, err, 'Could not save that.'); }
});

app.get('/api/projects/:id', accounts.requireUser, async (req, res) => {
  const p = await db.get('projects', req.params.id);
  // 404 rather than 403 on someone else's project, so the API will not
  // confirm that an id exists.
  if (!p || p.ownerId !== req.user.id) return res.status(404).json({ error: 'Not found.' });
  res.json(p);
});

app.delete('/api/projects/:id', accounts.requireUser, async (req, res) => {
  const p = await db.get('projects', req.params.id);
  if (!p || p.ownerId !== req.user.id) return res.status(404).json({ error: 'Not found.' });
  await db.remove('projects', req.params.id);
  res.json({ ok: true });
});

/** A share link is read-only and needs no account. It is a separate random id
 *  from the project id, so a shared link can be revoked later by rotating it
 *  without breaking the owner's own reference. */
app.get('/api/shared/:shareId', async (req, res) => {
  const rows = await db.list('projects', { where: [['shareId', '==', req.params.shareId]], limit: 1 });
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  const p = rows[0];
  res.json({ title: p.title, subtitle: p.subtitle, note: p.note, viz: p.viz, sourceUrl: p.sourceUrl });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Kinetic listening on :${PORT}`));
