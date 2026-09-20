const path = require('path');
const express = require('express');

const db = require('./lib/db');
const auth = require('./lib/auth');
const analytics = require('./lib/analytics');
const scan = require('./lib/scan');
const score = require('./lib/score');
const webauthn = require('./lib/webauthn');
const sitepass = require('./lib/sitepass');
const identityLib = require('./lib/identity');
const identityStore = require('./lib/identity-store');

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

// The login page needs these, and static files are served below the gate. A
// script the sign-in page cannot load is a sign-in page with no Face ID
// button, silently, with nothing in the log to say why.
app.get('/passkey.js', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'passkey.js')));
app.get('/icon.svg', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'icon.svg')));

/* ---------- password, changeable without a deploy ---------- */

const password = sitepass.create({
  store: db,
  envPassword: () => process.env.APP_PASSWORD || '',
  // The current password, OR a session that was itself proved by Face ID.
  // A password-proved session is deliberately NOT enough: a stolen cookie
  // could otherwise change the password and take the account for good.
  canChange: async (req) => {
    const supplied = (req.body || {}).current;
    if (supplied && await password.verify(supplied)) return true;
    return auth.sessionVia(req) === 'passkey';
  },
});
password.mount(app);

/* ---------- Face ID ---------- */

webauthn.create({
  store: db,
  secret: () => process.env.SESSION_SECRET || '',
  rpName: 'Friction',
  displayName: 'Friction',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  issueSession: (res) => auth.issue(res, 'passkey'),
  currentOwner: (req) => (auth.hasSession(req) ? 'site' : null),
  // Enrolling needs the password, not just a session.
  canEnrol: async (req) => (await password.verify((req.body || {}).password) ? 'site' : null),
}).mount(app);

app.post('/api/auth/login', async (req, res) => {
  if (!process.env.APP_PASSWORD || !process.env.SESSION_SECRET) {
    return res.status(500).json({ error: 'Sign-in is not configured on this deployment.' });
  }
  if (!(await password.verify((req.body || {}).password))) {
    return res.status(401).json({ error: 'That password is not right.' });
  }
  auth.issue(res, 'password');
  res.json({ ok: true });
});

// The one route Cloud Scheduler calls. Session OR cron key - never neither,
// because everything past here spends Anthropic tokens.
app.post('/api/cron/scan', auth.requireLoginOrCron, identity.requireBudget, async (req, res) => {
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

// Analytics. Mounted BEFORE the gate below: a gated /analytics.js is a 401,
// so the sign-in page - the page every visitor actually sees - would be the
// one page that never measures. Serves an inert file unless
// GA_MEASUREMENT_ID is set on the service.
analytics.mount(app, 'friction');

// The shared account. Signing in here signs you in across the domain, and a
// session made on any sibling app is accepted here.
const identity = identityLib.create({
  store: identityStore.store,
  secret: () => process.env.IDENTITY_SESSION_SECRET || '',
  app: 'friction',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Erik Strong',
});
identity.mount(app);
// Price and record every model call this app makes.
score.useMeter(identity.meter);

// Two doors, and they answer different questions.
//
// Identity says who you are. It does NOT say you may be here: this is a
// private research tool, and one account now opens five apps, so an ordinary
// registration on the public dataviz page must not walk straight in. Access is
// granted per app by the admin, and absent means no.
//
// The original APP_PASSWORD session stays working as the second door, so a
// fault in the shared identity service cannot lock Erik out of his own tool.
const APP_KEY = 'friction';
function gate(req, res, next) {
  if (auth.hasSession(req)) return next();               // the app's own password
  if (identityLib.hasAccess(req.user, APP_KEY)) return next();
  const wantsHtml = (req.get('Accept') || '').indexOf('text/html') !== -1;
  if (req.user) {
    // Signed in, just not entitled. Say so plainly rather than bouncing them
    // to a login page they have already passed.
    identity.log('access.denied', req, { detail: APP_KEY, ok: false });
    if (wantsHtml) {
      const who = String(req.user.email || '').replace(/[<>&"]/g, '');
      const asked = req.user.requests && req.user.requests[APP_KEY] && req.user.requests[APP_KEY].state !== 'denied';
      return res.status(403).send(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<meta name="color-scheme" content="light dark"><title>No access</title>' +
        '<script src="/analytics.js" async></script>' +
        '<body style="font:16px/1.5 -apple-system,sans-serif;max-width:32em;margin:16vh auto;padding:0 20px">' +
        '<h1 style="font-size:20px;margin:0 0 8px">Friction is invite-only</h1>' +
        '<p style="opacity:.7;margin:0 0 18px">Signed in as ' + who + '.</p>' +
        (asked
          ? '<p style="opacity:.7">Your request is in — Erik has been emailed. You will get in once he approves it.</p>'
          : '<label for="n" style="display:block;font-size:13px;opacity:.7;margin-bottom:6px">Why would you like access? (optional)</label>' +
            '<textarea id="n" rows="3" style="width:100%;font:inherit;padding:9px;border-radius:10px;border:1px solid #8884;background:transparent;color:inherit"></textarea>' +
            '<button id="go" style="font:inherit;margin-top:10px;padding:10px 16px;border-radius:10px;border:0;background:#2a78d6;color:#fff;cursor:pointer">Ask for access</button>' +
            '<p id="s" style="min-height:1.4em;font-size:14px;opacity:.75"></p>' +
            '<script>document.getElementById("go").onclick=function(){' +
            'var b=this,s=document.getElementById("s");b.disabled=true;s.textContent="Sending\u2026";' +
            'fetch("/api/id/access/request",{method:"POST",headers:{"Content-Type":"application/json"},' +
            'body:JSON.stringify({note:document.getElementById("n").value})})' +
            '.then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||"Could not send that.");return j;})})' +
            '.then(function(){s.textContent="Sent. Erik has been emailed.";})' +
            '.catch(function(e){s.textContent=e.message;b.disabled=false;});};</script>') +
        '<p style="margin-top:22px"><a href="/login" style="color:#2a78d6">Use the app password instead</a></p></body>');
    }
    return res.status(403).json({ error: 'Your account does not have access to Friction.' });
  }
  if (wantsHtml) return res.redirect('/login');
  return res.status(401).json({ error: 'not signed in' });
}

app.use(gate);
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth/logout', (_req, res) => { auth.clear(res); res.json({ ok: true }); });
app.get('/api/auth/me', async (req, res) => res.json({
  signedIn: true,
  via: auth.sessionVia(req),
  customPassword: await password.isCustom().catch(() => false),
}));

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
