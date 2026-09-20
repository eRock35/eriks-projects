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

const PORT = process.env.PORT || 8080;
const SITE_DIR = path.join(__dirname, 'site');
const SESSION_COOKIE = 'esadmin';
const SESSION_DAYS = 30;
const CONFIRM_TTL_SECONDS = 14 * 24 * 60 * 60;
// One send call will not try to mail more than this. A big list is finished by
// pressing send again; every recipient is recorded, so nobody is mailed twice.
const MAX_SEND_PER_RUN = Number(process.env.MAX_SEND_PER_RUN || 500);

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/healthz', (req, res) => res.status(200).send('ok'));

/* ------------------------------------------------------------------ *
 * Admin session
 * ------------------------------------------------------------------ */

function adminPassword() {
  return process.env.ADMIN_PASSWORD || '';
}

function issueAdminSession(res) {
  tokens.setSessionCookie(res, SESSION_COOKIE, `admin|${Date.now()}`, SESSION_DAYS * 24 * 60 * 60);
}

function adminPasswordOk(supplied) {
  const expected = adminPassword();
  if (!expected || !supplied) return false;
  return tokens.safeEqual(String(supplied).padEnd(64).slice(0, 64), expected.padEnd(64).slice(0, 64));
}

function isAdmin(req) {
  const value = tokens.readSessionCookie(req, SESSION_COOKIE);
  if (!value) return false;
  const [marker, issuedAt] = value.split('|');
  if (marker !== 'admin') return false;
  const age = Date.now() - Number(issuedAt || 0);
  return age >= 0 && age < SESSION_DAYS * 24 * 60 * 60 * 1000;
}

// 404 rather than 401 for the admin surface, so its existence is not
// advertised to anyone poking at the site. The login route is the one door.
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  return res.status(404).send(view.notice({
    title: 'Not found', heading: 'Not found', message: 'There is nothing at this address.',
  }));
}

app.post('/api/admin/login', async (req, res) => {
  const supplied = String((req.body && req.body.password) || '');
  const expected = adminPassword();
  if (!expected) return res.status(503).json({ error: 'Admin access is not configured on this deployment.' });
  if (!supplied || !tokens.safeEqual(supplied.padEnd(64).slice(0, 64), expected.padEnd(64).slice(0, 64))) {
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
  issueSession: issueAdminSession,
  requireAdmin,
  adminPasswordOk,
}).mount(app);

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

app.get('/api/admin/me', (req, res) => {
  res.json({
    signedIn: isAdmin(req),
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
app.get('/admin', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin/login');
  res.sendFile(path.join(SITE_DIR, 'admin.html'));
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
