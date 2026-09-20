// Erik's site: the landing page, the writing, and the newsletter.
//
// Why this exists as a Cloud Run service rather than a bucket: GCS static
// website hosting cannot do HTTPS on a custom domain at all — not a missing
// setting, the capability isn't there — which is why the root domain used to
// read "Not Secure". Cloud Run gets a free Google-managed certificate through
// a domain mapping.
//
// It must still scale to zero. A static page plus an occasional newsletter on
// Cloud Run with min-instances 0 sits inside the free tier, whereas an HTTPS
// load balancer would have been a standing ~$18-25/month. Do not add a
// min-instance count, a warmup, or anything else that keeps an instance alive.

const express = require('express');
const path = require('path');

const { store } = require('./lib/store');
const tokens = require('./lib/tokens');
const markdown = require('./lib/markdown');
const email = require('./lib/email');
const ai = require('./lib/ai');
const view = require('./lib/render');
const passkeys = require('./lib/passkeys');
const sitepass = require('./shared/sitepass');
const identityLib = require('./shared/identity');
const insights = require('./lib/insights');
const notify = require('./lib/notify');
const reset = require('./shared/reset');
const identityStore = require('./lib/identity-store');
const analytics = require('./shared/analytics');

const PORT = process.env.PORT || 8080;
const SITE_DIR = path.join(__dirname, 'site');
const SESSION_COOKIE = 'esadmin';
// Shared with the other apps' cron routes: a scheduler job config is readable
// by anyone with project access, so it is deliberately NOT the admin password.
const CRON_SECRET = process.env.CRON_SECRET || '';
const SESSION_DAYS = 30;
const CONFIRM_TTL_SECONDS = 14 * 24 * 60 * 60;
// One send call will not try to mail more than this. A big list is finished by
// pressing send again; every recipient is recorded, so nobody is mailed twice.
const MAX_SEND_PER_RUN = Number(process.env.MAX_SEND_PER_RUN || 500);

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Analytics. The public site only - the admin pages are one person, and
// their paths describe this site's own private structure. Serves an inert
// file unless GA_MEASUREMENT_ID is set on the service.
analytics.mount(app, 'landing');

app.get('/healthz', (req, res) => res.status(200).send('ok'));

/* ------------------------------------------------------------------ *
 * Admin session
 * ------------------------------------------------------------------ */

function adminPassword() {
  return process.env.ADMIN_PASSWORD || '';
}

// `via` records HOW the session was proved. A password-proved session must
// not be enough to replace the password - a stolen cookie would take the
// account permanently. A Face ID one is at least as strong as the password it
// is replacing, which is what makes "I forgot it" recoverable here without an
// email sender.
function issueAdminSession(res, via = 'password') {
  tokens.setSessionCookie(res, SESSION_COOKIE, `admin|${Date.now()}|${via}`, SESSION_DAYS * 24 * 60 * 60);
}

/** The CURRENT password: the stored one when there is one, the environment
 *  variable otherwise. Async for that reason - see shared/sitepass.js. */
async function adminPasswordOk(supplied) {
  return sitePassword.verify(supplied);
}

function adminSession(req) {
  const value = tokens.readSessionCookie(req, SESSION_COOKIE);
  if (!value) return null;
  // Sessions issued before `via` existed have two fields, not three. They are
  // treated as password-proved, which is the safe reading.
  const [marker, issuedAt, via] = value.split('|');
  if (marker !== 'admin') return null;
  const age = Date.now() - Number(issuedAt || 0);
  if (!(age >= 0 && age < SESSION_DAYS * 24 * 60 * 60 * 1000)) return null;
  return { issuedAt: Number(issuedAt || 0), via: via === 'passkey' ? 'passkey' : 'password' };
}

function isAdmin(req) {
  return !!adminSession(req);
}

// 404 rather than 401 for the admin surface, so its existence is not
// advertised to anyone poking at the site. The login route is the one door.
// Two doors, deliberately. The shared identity account is the new one; the
// original ADMIN_PASSWORD session stays working so a fault in the identity
// service cannot lock Erik out of the surface he would use to diagnose it.
// Retire the old door only once the new one has been used in anger.
function requireAdmin(req, res, next) {
  if (isAdmin(req) || isIdentityAdmin(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  return res.status(404).send(view.notice({
    title: 'Not found', heading: 'Not found', message: 'There is nothing at this address.',
  }));
}

app.post('/api/admin/login', async (req, res) => {
  const supplied = String((req.body && req.body.password) || '');
  if (!adminPassword() && !(await sitePassword.isCustom())) {
    return res.status(503).json({ error: 'Admin access is not configured on this deployment.' });
  }
  if (!(await adminPasswordOk(supplied))) {
    // A deliberate pause: this is the only password on the service, and it
    // makes a scripted guessing run expensive without affecting a real login.
    await new Promise((r) => setTimeout(r, 400));
    return res.status(401).json({ error: 'That password did not work.' });
  }
  issueAdminSession(res);
  res.json({ ok: true });
});

// Face ID / Touch ID for the admin. Mounted before the logout route only so
// it sits with the rest of the session handling; order does not matter here.
passkeys.create({
  store,
  tokens,
  rpName: 'Erik Strong',
  userName: 'admin',
  // A session minted by Face ID is marked as such, which is what lets it
  // stand in for a forgotten password below.
  issueSession: (res) => issueAdminSession(res, 'passkey'),
  requireAdmin,
  adminPasswordOk,
}).mount(app);

// The admin password can now be changed without a deploy. ADMIN_PASSWORD
// stays as the bootstrap: it is what works on a fresh deploy, and what still
// works if the stored one is ever cleared.
//
// There is no email sender on this service, so there is no reset link. The
// two doors are the current password and a Face ID session - the same trade
// documented in trip-planner's CLAUDE.md, and the reason enrolling a passkey
// is worth doing before you need it.
const sitePassword = sitepass.create({
  store: {
    get: (collection, id) => store().get(collection, id),
    set: (collection, id, value) => store().set(collection, id, value),
  },
  envPassword: adminPassword,
  canChange: async (req) => {
    const supplied = (req.body || {}).current;
    if (supplied && await sitePassword.verify(supplied)) return true;
    const session = adminSession(req);
    return !!(session && session.via === 'passkey');
  },
});
sitePassword.mount(app, '/api/admin/password');

// The shared account: one email + password + passkey for every app on this
// domain. See shared/identity.js for why santa-rosa-beach-trip is not on it
// and cannot be added by accident.
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const identity = identityLib.create({
  // The shared identity database, NOT this app's own store - every app has to
  // read the same user records for the account to actually be shared.
  store: identityStore.store,
  secret: () => process.env.IDENTITY_SESSION_SECRET || '',
  app: 'landing',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Erik Strong',
});
identity.mount(app);
// Price and record every model call this app makes.
ai.useMeter(identity.meter);

/** The shared account that owns the admin surface. One address, named by
 *  ADMIN_EMAIL - an ordinary signed-in user is not an admin. */
function isIdentityAdmin(req) {
  return Boolean(ADMIN_EMAIL && req.user && req.user.email === ADMIN_EMAIL);
}

app.post('/api/admin/logout', (req, res) => {
  tokens.clearSessionCookie(res, SESSION_COOKIE);
  res.json({ ok: true });
});

// Nothing on this project can read Cloud Run logs, and the container this was
// built from cannot reach Resend or a DNS resolver. So the app asks Resend
// itself and reports the answer: whether the domain is verified, and what the
// last send failure actually said.
app.get('/api/admin/email-check', requireAdmin, async (req, res) => {
  const result = await email.listDomains();
  res.json({
    from: email.from(),
    configured: email.enabled(),
    lastFailure: email.lastFailure(),
    ...result,
  });
});

app.get('/api/admin/me', async (req, res) => {
  const session = adminSession(req);
  res.json({
    signedIn: !!session,
    // How this session was proved, so the page knows whether to ask for the
    // current password before changing it.
    via: session ? session.via : null,
    password: { custom: await sitePassword.isCustom(), minLength: sitePassword.MIN_LENGTH },
    email: { enabled: email.enabled(), from: email.from() },
    ai: { enabled: ai.enabled(), model: ai.MODEL },
    store: store().kind,
  });
});

/* ------------------------------------------------------------------ *
 * Posts
 * ------------------------------------------------------------------ */

function postSummary(p) {
  return {
    slug: p.slug,
    title: p.title,
    subtitle: p.subtitle || '',
    excerpt: p.excerpt || '',
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    publishedAt: p.publishedAt || null,
    sentAt: p.sentAt || null,
    sentCount: p.sentCount || 0,
    words: String(p.body || '').trim().split(/\s+/).filter(Boolean).length,
  };
}

async function publishedPosts(limit = 0) {
  const db = store();
  const rows = await db.list('posts', {
    where: [['status', '==', 'published']],
    orderBy: 'publishedAt',
    desc: true,
    limit,
  });
  return rows;
}

app.get('/api/posts', requireAdmin, async (req, res) => {
  try {
    const rows = await store().list('posts', { orderBy: 'updatedAt', desc: true });
    res.json(rows.map(postSummary));
  } catch (err) {
    console.error('GET /api/posts', err);
    res.status(500).json({ error: 'Could not load posts.' });
  }
});

app.post('/api/posts', requireAdmin, async (req, res) => {
  try {
    const db = store();
    const title = String((req.body && req.body.title) || '').trim() || 'Untitled';
    let slug = markdown.slugify(req.body && req.body.slug ? req.body.slug : title);
    if (await db.get('posts', slug)) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const now = new Date().toISOString();
    const post = {
      slug,
      title,
      subtitle: String((req.body && req.body.subtitle) || '').trim(),
      body: String((req.body && req.body.body) || ''),
      excerpt: '',
      emailSubject: '',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      sentAt: null,
      sentCount: 0,
    };
    post.excerpt = markdown.firstParagraph(post.body);
    await db.set('posts', slug, post);
    res.json(postSummary(post));
  } catch (err) {
    console.error('POST /api/posts', err);
    res.status(500).json({ error: 'Could not create that post.' });
  }
});

app.get('/api/posts/:slug', requireAdmin, async (req, res) => {
  const post = await store().get('posts', req.params.slug);
  if (!post) return res.status(404).json({ error: 'Not found.' });
  res.json(post);
});

app.patch('/api/posts/:slug', requireAdmin, async (req, res) => {
  try {
    const db = store();
    const post = await db.get('posts', req.params.slug);
    if (!post) return res.status(404).json({ error: 'Not found.' });
    const patch = { updatedAt: new Date().toISOString() };
    for (const field of ['title', 'subtitle', 'body', 'excerpt', 'emailSubject']) {
      if (req.body && typeof req.body[field] === 'string') patch[field] = req.body[field];
    }
    if (patch.body !== undefined && !patch.excerpt && !post.excerpt) {
      patch.excerpt = markdown.firstParagraph(patch.body);
    }

    // While a post is still a draft its URL follows the title, so renaming
    // "Untitled" does not leave the post living at /writing/untitled forever.
    // Once published the slug is frozen: a live URL that moves is a broken
    // link in someone's inbox.
    let merged = Object.assign({}, post, patch);
    const frozen = post.status === 'published' || Boolean(post.publishedAt);
    const desired = markdown.slugify(merged.title);
    if (!frozen && desired && desired !== post.slug && !(await db.get('posts', desired))) {
      merged = Object.assign({}, merged, { slug: desired });
      await db.set('posts', desired, merged);
      await db.remove('posts', post.slug);
      return res.json(postSummary(merged));
    }

    await db.update('posts', req.params.slug, patch);
    res.json(postSummary(merged));
  } catch (err) {
    console.error('PATCH /api/posts', err);
    res.status(500).json({ error: 'Could not save that.' });
  }
});

app.post('/api/posts/:slug/publish', requireAdmin, async (req, res) => {
  const db = store();
  const post = await db.get('posts', req.params.slug);
  if (!post) return res.status(404).json({ error: 'Not found.' });
  const patch = {
    status: 'published',
    publishedAt: post.publishedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (!post.excerpt) patch.excerpt = markdown.firstParagraph(post.body);
  await db.update('posts', post.slug, patch);
  res.json(postSummary(Object.assign({}, post, patch)));
});

app.post('/api/posts/:slug/unpublish', requireAdmin, async (req, res) => {
  const db = store();
  const post = await db.get('posts', req.params.slug);
  if (!post) return res.status(404).json({ error: 'Not found.' });
  await db.update('posts', post.slug, { status: 'draft', updatedAt: new Date().toISOString() });
  res.json(postSummary(Object.assign({}, post, { status: 'draft' })));
});

app.delete('/api/posts/:slug', requireAdmin, async (req, res) => {
  await store().remove('posts', req.params.slug);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Subscribers
 * ------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Best effort only: Cloud Run may run several instances, so this throttles the
// common case (one bot hammering one instance) rather than acting as a real
// distributed limiter.
const recentSignups = new Map();
function signupAllowed(ip) {
  const now = Date.now();
  const hits = (recentSignups.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  hits.push(now);
  recentSignups.set(ip, hits);
  if (recentSignups.size > 5000) recentSignups.clear();
  return hits.length <= 5;
}

function unsubscribeUrlFor(id) {
  return `${view.origin()}/unsubscribe?t=${tokens.makeToken('unsub', id, 0)}`;
}

async function handleSubscribe(req) {
  const address = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!EMAIL_RE.test(address) || address.length > 254) {
    return { ok: false, status: 400, message: 'That does not look like an email address.' };
  }
  if (!signupAllowed(req.ip || 'unknown')) {
    return { ok: false, status: 429, message: 'Too many signups from here. Try again later.' };
  }

  const db = store();
  const id = tokens.emailId(address);
  const existing = await db.get('subscribers', id);
  const now = new Date().toISOString();

  if (existing && existing.status === 'confirmed') {
    // Deliberately the same answer as a new signup: telling a stranger that an
    // address is already subscribed leaks who is on the list.
    return { ok: true, message: 'Check your inbox to confirm.' };
  }

  await db.set('subscribers', id, {
    email: address,
    status: 'pending',
    createdAt: (existing && existing.createdAt) || now,
    confirmedAt: null,
    unsubscribedAt: null,
    source: String((req.body && req.body.source) || 'site'),
  });

  if (email.enabled()) {
    const confirmUrl = `${view.origin()}/subscribe/confirm?t=${tokens.makeToken('confirm', id, CONFIRM_TTL_SECONDS)}`;
    const body = view.confirmEmail({ confirmUrl, unsubscribeUrl: unsubscribeUrlFor(id) });
    try {
      await email.sendOne({
        to: address,
        subject: body.subject,
        html: body.html,
        text: body.text,
        headers: { 'List-Unsubscribe': `<${unsubscribeUrlFor(id)}>` },
      });
    } catch (err) {
      console.error('confirm email failed', err.message);
      return { ok: false, status: 502, message: 'Could not send the confirmation email. Try again shortly.' };
    }
  } else {
    console.warn(`[subscribe] no mail provider configured; ${address} is pending with no confirmation sent.`);
  }
  return { ok: true, message: 'Check your inbox to confirm.' };
}

app.post('/api/subscribe', async (req, res) => {
  try {
    const result = await handleSubscribe(req);
    // The form posts without JavaScript too, so answer in whichever shape the
    // caller can use.
    const wantsHtml = (req.headers.accept || '').includes('text/html') && !req.is('application/json');
    if (wantsHtml) {
      return res.status(result.ok ? 200 : (result.status || 400)).send(view.notice({
        title: result.ok ? 'Almost there' : 'That did not work',
        heading: result.ok ? 'Check your inbox' : 'That did not work',
        message: result.message,
      }));
    }
    return res.status(result.ok ? 200 : (result.status || 400)).json(result.ok ? { ok: true, message: result.message } : { error: result.message });
  } catch (err) {
    console.error('POST /api/subscribe', err);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

app.get('/subscribe/confirm', async (req, res) => {
  const id = tokens.readToken('confirm', req.query.t);
  if (!id) {
    return res.status(400).send(view.notice({
      title: 'Link expired', heading: 'That link has expired',
      message: 'Confirmation links are good for two weeks. Subscribe again and a fresh one will arrive.',
    }));
  }
  const db = store();
  const sub = await db.get('subscribers', id);
  if (!sub) {
    return res.status(404).send(view.notice({
      title: 'Not found', heading: 'We could not find that subscription',
      message: 'Try subscribing again from the writing page.',
    }));
  }
  await db.update('subscribers', id, {
    status: 'confirmed',
    confirmedAt: sub.confirmedAt || new Date().toISOString(),
    unsubscribedAt: null,
  });
  res.send(view.notice({
    title: 'Subscribed', heading: "You're on the list",
    message: 'New posts will land in your inbox. Every email has a one-tap unsubscribe.',
  }));
});

app.get('/unsubscribe', async (req, res) => {
  const id = tokens.readToken('unsub', req.query.t);
  if (!id) {
    return res.status(400).send(view.notice({
      title: 'Unsubscribe', heading: 'That link is not valid',
      message: 'Reply to any of the emails and it will be handled by hand.',
    }));
  }
  const sub = await store().get('subscribers', id);
  res.send(view.unsubscribeConfirm(String(req.query.t), (sub && sub.email) || tokens.emailFromId(id)));
});

// Both the button on the page above and the one-click header POST land here.
// Gmail and Yahoo require one-click unsubscribe to work without a login, so
// this route must never be behind any gate.
app.post('/unsubscribe', async (req, res) => {
  const token = (req.body && req.body.t) || req.query.t;
  const id = tokens.readToken('unsub', token);
  if (!id) return res.status(400).send('Invalid unsubscribe link.');
  const db = store();
  const sub = await db.get('subscribers', id);
  if (sub) {
    await db.update('subscribers', id, { status: 'unsubscribed', unsubscribedAt: new Date().toISOString() });
  }
  if ((req.headers['content-type'] || '').includes('form-urlencoded') && (req.headers.accept || '').includes('text/html')) {
    return res.send(view.notice({
      title: 'Unsubscribed', heading: 'Unsubscribed',
      message: 'You will not get any more emails. No hard feelings.',
    }));
  }
  res.status(200).send('Unsubscribed');
});

app.get('/api/subscribers', requireAdmin, async (req, res) => {
  try {
    const db = store();
    const [confirmed, pending, unsubscribed] = await Promise.all([
      db.count('subscribers', [['status', '==', 'confirmed']]),
      db.count('subscribers', [['status', '==', 'pending']]),
      db.count('subscribers', [['status', '==', 'unsubscribed']]),
    ]);
    res.json({ confirmed, pending, unsubscribed });
  } catch (err) {
    console.error('GET /api/subscribers', err);
    res.status(500).json({ error: 'Could not load subscribers.' });
  }
});

/* ------------------------------------------------------------------ *
 * Sending a post
 * ------------------------------------------------------------------ */

app.post('/api/posts/:slug/send', requireAdmin, async (req, res) => {
  try {
    const db = store();
    const post = await db.get('posts', req.params.slug);
    if (!post) return res.status(404).json({ error: 'Not found.' });
    if (post.status !== 'published') {
      return res.status(400).json({ error: 'Publish the post before sending it.' });
    }
    if (!email.enabled()) {
      return res.status(503).json({ error: 'No mail provider is configured on this deployment.' });
    }

    const testTo = req.body && req.body.testTo ? String(req.body.testTo).trim() : '';
    if (testTo) {
      if (!EMAIL_RE.test(testTo)) return res.status(400).json({ error: 'That test address is not valid.' });
      const body = view.postEmail(post, { unsubscribeUrl: `${view.origin()}/unsubscribe?t=test` });
      await email.sendOne({ to: testTo, subject: `[test] ${body.subject}`, html: body.html, text: body.text });
      return res.json({ test: true, to: testTo });
    }

    const subscribers = await db.list('subscribers', { where: [['status', '==', 'confirmed']] });
    const recipientsCollection = `posts_${post.slug}_recipients`;
    const alreadySent = await db.list(recipientsCollection, {});
    const done = new Set(alreadySent.filter((r) => r.ok).map((r) => r.id));

    const queue = subscribers.filter((s) => !done.has(s.id)).slice(0, MAX_SEND_PER_RUN);
    if (!queue.length) {
      return res.json({ sent: 0, alreadySent: done.size, remaining: 0, total: subscribers.length });
    }

    const messages = queue.map((sub) => {
      const unsubscribeUrl = unsubscribeUrlFor(sub.id);
      const body = view.postEmail(post, { unsubscribeUrl });
      return {
        to: sub.email,
        subject: body.subject,
        html: body.html,
        text: body.text,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        _id: sub.id,
      };
    });

    const results = await email.sendMany(messages);
    const now = new Date().toISOString();
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      const sub = queue[i];
      if (result.ok) sent += 1; else failed += 1;
      await db.set(recipientsCollection, sub.id, {
        email: sub.email,
        ok: Boolean(result.ok),
        messageId: result.id || null,
        error: result.error || null,
        at: now,
      });
    }

    const totalSent = done.size + sent;
    await db.update('posts', post.slug, {
      sentAt: post.sentAt || now,
      sentCount: totalSent,
      updatedAt: now,
    });

    res.json({
      sent,
      failed,
      alreadySent: done.size,
      total: subscribers.length,
      remaining: Math.max(0, subscribers.length - totalSent),
    });
  } catch (err) {
    console.error('POST /api/posts/:slug/send', err);
    res.status(500).json({ error: err.message || 'The send failed.' });
  }
});

/* ------------------------------------------------------------------ *
 * Claude
 * ------------------------------------------------------------------ */

app.post('/api/ai/assist', requireAdmin, async (req, res) => {
  try {
    const mode = String((req.body && req.body.mode) || '');
    const result = await ai.assist(mode, {
      title: req.body && req.body.title,
      body: req.body && req.body.body,
      notes: req.body && req.body.notes,
      instruction: req.body && req.body.instruction,
    });
    res.json(result);
  } catch (err) {
    const status = err.code === 'ai-quota' ? 429 : err.code === 'ai-disabled' ? 503 : err.code === 'bad-mode' ? 400 : 500;
    if (status === 500) console.error('POST /api/ai/assist', err);
    res.status(status).json({ error: err.message || 'That did not work.' });
  }
});

/* ------------------------------------------------------------------ *
 * Public pages
 * ------------------------------------------------------------------ */

app.get('/writing', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=120');
    res.send(view.writingIndex(await publishedPosts()));
  } catch (err) {
    console.error('GET /writing', err);
    res.status(500).send(view.notice({ title: 'Error', heading: 'Something broke', message: 'Try again in a moment.' }));
  }
});

app.get('/writing/:slug', async (req, res) => {
  try {
    const post = await store().get('posts', req.params.slug);
    if (!post || post.status !== 'published') {
      return res.status(404).send(view.notice({
        title: 'Not found', heading: 'No post here',
        message: 'It may have moved, or it may not be published yet.',
      }));
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.send(view.postPage(post));
  } catch (err) {
    console.error('GET /writing/:slug', err);
    res.status(500).send(view.notice({ title: 'Error', heading: 'Something broke', message: 'Try again in a moment.' }));
  }
});

app.get('/feed.xml', async (req, res) => {
  try {
    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=600');
    res.send(view.feed(await publishedPosts(50)));
  } catch (err) {
    console.error('GET /feed.xml', err);
    res.status(500).send('Feed unavailable');
  }
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nSitemap: ${view.origin()}/feed.xml\n`);
});

/* ------------------------------------------------------------------ *
 * Admin surface
 * ------------------------------------------------------------------ */

// The login page is public by necessity; everything behind it is not.
app.get('/admin/login', (req, res) => res.sendFile(path.join(SITE_DIR, 'admin-login.html')));
// /admin is the OVERVIEW, not the blog editor. Landing an admin panel on a
// text editor buries the things that actually need attention - an access
// request someone is waiting on, an app that has stopped running - behind a
// list of posts. Writing is one tool among several and lives at its own path.
const adminGate = (req, res, next) =>
  (isAdmin(req) || isIdentityAdmin(req)) ? next() : res.redirect('/admin/login');

app.get('/admin', adminGate, (_req, res) => res.sendFile(path.join(SITE_DIR, 'admin-insights.html')));
app.get('/admin/writing', adminGate, (_req, res) => res.sendFile(path.join(SITE_DIR, 'admin.html')));

// The dashboard: who is using the apps, what happened, what it cost, what is
// broken. Its own page rather than another tab inside admin.html, which is
// already carrying the whole writing flow.
// Kept so older links and bookmarks still land somewhere sensible.
app.get('/admin/insights', adminGate, (_req, res) => res.redirect(301, '/admin'));

// Granting per-app access. This is the other half of the `access` map: apps
// read it, and this is the only place it is written. Without it the map is
// unreachable and every app would be permanently closed to new accounts.
const GRANTABLE = {
  friction: ['member'],
  football: ['research'],
  dataviz: ['pro'],
  'trip-planner': ['member'],
};

app.post('/api/admin/access', requireAdmin, async (req, res) => {
  try {
    const { uid, app: appKey, level } = req.body || {};
    if (!uid || !appKey) return res.status(400).json({ error: 'uid and app are required.' });
    if (!Object.prototype.hasOwnProperty.call(GRANTABLE, appKey)) {
      return res.status(400).json({ error: 'Unknown app.' });
    }
    // null revokes. Anything else must be a level that app actually defines,
    // or the grant would sit in the record looking effective and do nothing.
    if (level !== null && level !== undefined && !GRANTABLE[appKey].includes(level)) {
      return res.status(400).json({ error: `${appKey} does not define the level "${level}".` });
    }
    const access = await identity.setAccess(uid, appKey, level ?? null);
    await identity.log('access.changed', req, {
      uid, detail: `${appKey}=${level || 'revoked'}`,
    });
    res.json({ ok: true, access });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not change that.' });
  }
});

app.post('/api/admin/access/deny', requireAdmin, async (req, res) => {
  try {
    const { uid, app: appKey } = req.body || {};
    if (!uid || !appKey) return res.status(400).json({ error: 'uid and app are required.' });
    await identity.denyRequest(uid, appKey);
    await identity.log('access.denied-request', req, { uid, detail: appKey });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not change that.' });
  }
});

app.get('/api/admin/grantable', requireAdmin, (_req, res) => res.json({ apps: GRANTABLE }));

// The notifier tick. Cloud Scheduler calls this; it sends only when there is
// something to say, so a quiet day produces no mail at all.
//
// Either a cron key or an admin session, so it can also be fired by hand from
// the dashboard to see what is currently outstanding.
/* ------------------------------------------------------------------ *
 * Forgotten passwords, self-service
 * ------------------------------------------------------------------ */

// Hosted here for every app on the domain. This is the only service with the
// Resend key, and one account means one place to reset it. The apps' sign-in
// pages link straight to /reset rather than each running their own flow.
//
// This replaces the admin-issues-a-temporary-password arrangement, which was
// written when there was no mail sender on the project. There is one now, and
// nobody should have to ask a person to get back into their own account.
const RESET_ORIGIN = process.env.SITE_ORIGIN || 'https://www.strongtechnicalconsulting.com';

app.post('/api/id/reset/request', async (req, res) => {
  const address = String((req.body || {}).email || '').trim().toLowerCase();
  // One answer for every input. Anything else turns this into a way of asking
  // which addresses have accounts.
  const same = { ok: true, message: 'If that address has an account, a reset link is on its way.' };
  try {
    const uid = identityLib.uidFor(address);
    const user = await identityStore.store.get('users', uid);
    if (user && user.password && user.password.hash && email.enabled()) {
      const link = `${RESET_ORIGIN}/reset?t=${encodeURIComponent(reset.makeToken(uid, user.password.hash))}`;
      const body = reset.emailBody({ link, origin: RESET_ORIGIN });
      await email.sendOne({ to: user.email, subject: body.subject, html: body.html, text: body.text });
      await identity.log('password.reset.requested', req, { uid, email: user.email });
    }
  } catch (err) {
    // A send failure must not change the answer either, or the timing and the
    // wording become the oracle the identical answer was protecting.
    console.error('reset/request', err.message);
  }
  res.json(same);
});

app.post('/api/id/reset/complete', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const raw = String(token || '');
    const uid = raw.includes('.')
      ? Buffer.from(raw.slice(0, raw.indexOf('.')), 'base64url').toString().split('.')[0]
      : '';
    const user = uid ? await identityStore.store.get('users', uid) : null;
    if (!user || !user.password || reset.readToken(raw, user.password.hash) !== uid) {
      return res.status(400).json({ error: 'That link has expired or has already been used.' });
    }
    const next = String(password || '');
    if (next.length < identityLib.MIN_PASSWORD) {
      return res.status(400).json({ error: `Use at least ${identityLib.MIN_PASSWORD} characters.` });
    }
    await identityStore.store.set('users', uid, {
      ...user,
      password: identityLib.makeHash(next),
      passwordChangedAt: new Date().toISOString(),
    });
    identity.issueSession(res, req, uid, 'password');
    await identity.log('password.reset', req, { uid, email: user.email });
    res.json({ ok: true, email: user.email });
  } catch (err) {
    console.error('reset/complete', err);
    res.status(500).json({ error: 'Could not set that password.' });
  }
});

app.get('/reset', (_req, res) => res.sendFile(path.join(SITE_DIR, 'reset.html')));

app.post('/api/cron/notify', async (req, res) => {
  const key = req.get('X-Cron-Key');
  const viaCron = CRON_SECRET && key && key === CRON_SECRET;
  if (!viaCron && !isAdmin(req) && !isIdentityAdmin(req)) {
    return res.status(404).json({ error: 'Not found.' });
  }
  try {
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json(await notify.run({ origin }));
  } catch (err) {
    console.error('POST /api/cron/notify', err);
    res.status(500).json({ error: 'Could not run the notifier.' });
  }
});

// What the notifier WOULD say right now, without sending or advancing the
// watermark. The dashboard uses it; it is also the way to check the thing
// works without waiting for a tick or spending a send.
app.get('/api/admin/notify/preview', requireAdmin, async (req, res) => {
  try {
    const found = await notify.gather();
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({
      count: found.count,
      since: found.since,
      mailConfigured: require('./lib/email').enabled(),
      to: process.env.ADMIN_EMAIL || null,
      preview: found.count ? notify.compose(found, origin) : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not build a preview.' });
  }
});

app.get('/api/admin/insights', requireAdmin, async (req, res) => {
  try {
    res.json(await insights.all());
  } catch (err) {
    console.error('GET /api/admin/insights', err);
    res.status(500).json({ error: 'Could not gather the dashboard data.' });
  }
});

/* ------------------------------------------------------------------ *
 * Static files and the landing page
 * ------------------------------------------------------------------ */

app.use(express.static(SITE_DIR, {
  extensions: ['html'],
  // The page changes rarely but should not go stale for long when it does.
  maxAge: '5m',
}));

// Anything unrecognised falls back to the landing page rather than a bare 404.
app.get('*', (req, res) => {
  res.sendFile(path.join(SITE_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Site listening on :${PORT} (store: ${store().kind}, mail: ${email.enabled() ? 'on' : 'off'}, ai: ${ai.enabled() ? 'on' : 'off'})`);
});
