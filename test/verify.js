// Email verification for the shared account (2026-09-27).
//
// Held against the landing service (identity at /api/id, the one service with
// the mail key) and against identity mounted the way every other app mounts
// it (no mail hook: it forwards, signed, to the landing):
//
// - the link's token: signed, 48-hour, bound to the address it was sent to;
// - /verify: the success and failure pages, `next` only on this domain;
// - "send again": 3 an hour per account, 20 per address, one answer;
// - the landing's dispatch route: signature, freshness, unknown accounts;
// - register mails exactly one link, To the address, From ACCOUNT_MAIL_FROM;
// - reset mail comes From ACCOUNT_MAIL_FROM too, never NEWSLETTER_FROM;
// - the owner flag is granted at verification, not registration;
// - requireBudget: unverified free tier 403s, everyone who pays does not;
// - the shared banner script: masking, nothing drawn when verified.
//
// Resend is faked at global.fetch, so every message is caught and read.
const h = require('./harness.js');
h.install();
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const express = require('express');

const PORT = 9247;
const SECRET = 'identity-secret-abcdefghijklmn';
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: SECRET,
  SESSION_SECRET: 'landing-secret-abcdefghijklm',
  ADMIN_PASSWORD: 'admin-password-here-1',
  ADMIN_EMAIL: 'boss@example.com',
  FIRESTORE_DATABASE_ID: 'eriks-projects',
  IDENTITY_DATABASE_ID: 'identity',
  GOOGLE_CLOUD_PROJECT: 'test',
  PASSKEY_RP_ID: 'strongtechnicalconsulting.com',
  RESEND_API_KEY: 're_test_not_real',
  NEWSLETTER_FROM: 'Erik Personal <erik-personal@example.com>',
  NEWSLETTER_REPLY_TO: 'erik-personal@example.com',
  PORT: String(PORT),
});
delete process.env.ACCOUNT_MAIL_FROM;
delete process.env.IDENTITY_MAIL_URL;
delete process.env.REQUIRE_VERIFIED_FOR_FREE_AI;

const sent = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.resend.com')) {
    sent.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: 'em_' + sent.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};

require(path.join(__dirname, '..', 'server.js'));
const identityLib = require(path.join(__dirname, '..', 'shared', 'identity.js'));
const identityStore = require(path.join(__dirname, '..', 'lib', 'identity-store.js'));
const emailLib = require(path.join(__dirname, '..', 'lib', 'email.js'));

const B = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
let ipN = 0;
const freshIp = () => `198.19.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
function send(base, method, p, body, { cookie, headers = {}, ip } = {}) {
  const hd = { ...J, 'x-forwarded-for': ip || freshIp(), ...headers };
  if (cookie) hd.cookie = cookie;
  return realFetch(base + p, { method, headers: hd, body: body === undefined ? undefined : JSON.stringify(body) });
}
const post = (p, b, o) => send(B, 'POST', p, b, o);
const get = (p, o) => send(B, 'GET', p, undefined, o);
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');
const users = () => h.bag('identity');
const rec = (e) => users().get('users/' + uidOf(e));
const verifyMails = () => sent.filter((m) => m.subject === 'Confirm your email');
const mailsTo = (e) => verifyMails().filter((m) => (m.to || []).includes(e));
const linkIn = (m) => { const x = /https?:\/\/[^\s"<]+\/verify\?t=[^\s"<]+/.exec(m.text || ''); return x ? x[0] : ''; };
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

async function register(email, password = 'a-long-password-1', ip) {
  const r = await post('/api/id/register', { email, password }, { ip });
  return { status: r.status, cookie: jar(r), body: await r.json().catch(() => ({})) };
}

(async () => {
  for (let i = 0; i < 60; i++) { try { await realFetch(B + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  /* ================= 1. the token ================= */
  {
    const uid = uidOf('tok@example.com');
    const t = identityLib.makeVerifyToken(uid, 'Tok@Example.com', SECRET);
    const read = identityLib.readVerifyToken(t, SECRET);
    ok('a verify token reads back its uid and (lowercased) address', read && read.uid === uid && read.email === 'tok@example.com', JSON.stringify(read));
    ok('...and lives 48 hours', read && Math.abs(read.exp - (Math.floor(Date.now() / 1000) + 48 * 3600)) < 5);
    ok('a token under another secret does not read', identityLib.readVerifyToken(t, 'another-secret-entirely') === null);
    const old = identityLib.makeVerifyToken(uid, 'tok@example.com', SECRET, Date.now() - 49 * 3600 * 1000);
    ok('an expired token does not read', identityLib.readVerifyToken(old, SECRET) === null);
    const [body, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), em: 'x@example.com' })).toString('base64url') + '.' + mac;
    ok('an edited token does not read', identityLib.readVerifyToken(forged, SECRET) === null);
    // A session cookie is signed with the raw secret; the verify key is derived,
    // so one can never be passed off as the other.
    const sessionish = h.session(SECRET, 'tok@example.com').split('=')[1];
    ok('a session token is not a verify token', identityLib.readVerifyToken(decodeURIComponent(sessionish), SECRET) === null);
    let threw = false;
    try { identityLib.makeVerifyToken(uid, 'tok@example.com', ''); } catch (e) { threw = true; }
    ok('no secret, no token', threw);
  }

  /* ================= 2. register mails one link ================= */
  {
    const before = sent.length;
    const a = await register('Newbie@Example.com');
    ok('registering still works', a.status === 200 && a.body.emailVerified === false, JSON.stringify(a.body));
    const mine = sent.slice(before);
    ok('register sends exactly one mail', mine.length === 1, String(mine.length));
    const m = mine[0] || {};
    ok('...to the registered address', JSON.stringify(m.to) === JSON.stringify(['newbie@example.com']), JSON.stringify(m.to));
    ok('...From ACCOUNT_MAIL_FROM\'s default, the accounts address', m.from === emailLib.DEFAULT_ACCOUNT_FROM, m.from);
    ok('...never From NEWSLETTER_FROM', !String(m.from).includes('erik-personal'));
    ok('...with no reply-to (NEWSLETTER_REPLY_TO is not borrowed)', !('reply_to' in m), JSON.stringify(m.reply_to));
    ok('...and a link to /verify on the site', /^https:\/\/strongtechnicalconsulting\.com\/verify\?t=/.test(linkIn(m)), linkIn(m));
    ok('the new record is not verified yet', rec('newbie@example.com') && !rec('newbie@example.com').emailVerifiedAt);
    let me = await (await get('/api/id/me', { cookie: a.cookie })).json();
    ok('/me says emailVerified: false', me.emailVerified === false, JSON.stringify(me.emailVerified));

    // Clicking it.
    const t = new URL(linkIn(m)).searchParams.get('t');
    let r = await get('/verify?t=' + encodeURIComponent(t));
    let html = await r.text();
    ok('/verify with the link says Email confirmed', r.status === 200 && /Email confirmed/.test(html), String(r.status));
    ok('...marks the record verified', Boolean(rec('newbie@example.com').emailVerifiedAt));
    ok('...keeps the token out of caches and Referers', r.headers.get('cache-control') === 'no-store' && r.headers.get('referrer-policy') === 'no-referrer');
    ok('...and the page carries no email address', !(html.match(ADDRESS) || []).length && !/mailto:/i.test(html));
    ok('...offers the home page when no next was given', /href="\/"/.test(html));
    me = await (await get('/api/id/me', { cookie: a.cookie })).json();
    ok('/me now says emailVerified: true', me.emailVerified === true);
    const at = rec('newbie@example.com').emailVerifiedAt;
    r = await get('/verify?t=' + encodeURIComponent(t));
    ok('clicking again is a no-op success', r.status === 200 && rec('newbie@example.com').emailVerifiedAt === at);

    // Already verified: send again sends nothing.
    const b4 = sent.length;
    r = await post('/api/id/verify/send', {}, { cookie: a.cookie });
    ok('send again when verified answers ok and sends nothing', r.status === 200 && (await r.json()).ok === true && sent.length === b4);
  }

  /* ================= 3. /verify failures and `next` ================= */
  {
    const same = async (p) => { const r = await get(p); return { status: r.status, html: await r.text() }; };
    const bad = await same('/verify?t=garbage');
    ok('a garbage token is a plain failure page', bad.status === 400 && /That link has expired - sign in and ask for a new one\./.test(bad.html), String(bad.status));
    const none = await same('/verify');
    // A validly signed token for an account that does not exist reads exactly
    // like a garbage one, so the page is no oracle.
    const ghost = await same('/verify?t=' + encodeURIComponent(identityLib.makeVerifyToken(uidOf('ghost@example.com'), 'ghost@example.com', SECRET)));
    const expired = await register('late@example.com');
    const oldT = identityLib.makeVerifyToken(uidOf('late@example.com'), 'late@example.com', SECRET, Date.now() - 49 * 3600 * 1000);
    const exp = await same('/verify?t=' + encodeURIComponent(oldT));
    ok('no token, an unknown account and an expired link all read the same',
      none.html === bad.html && ghost.html === bad.html && exp.html === bad.html && ghost.status === 400 && exp.status === 400);
    ok('...and the expired one verified nothing', expired.status === 200 && !rec('late@example.com').emailVerifiedAt);

    // The address changed since the link was sent (an admin migration): the
    // link is for the old address and must not confirm the new one.
    await register('moved@example.com');
    const movedT = identityLib.makeVerifyToken(uidOf('moved@example.com'), 'moved@example.com', SECRET);
    users().set('users/' + uidOf('moved@example.com'), { ...rec('moved@example.com'), email: 'someone-else@example.com' });
    const moved = await same('/verify?t=' + encodeURIComponent(movedT));
    ok('a link for an address the record no longer has fails', moved.status === 400 && !rec('moved@example.com').emailVerifiedAt);

    // next: only https on this domain.
    await register('nexty@example.com');
    const nt = identityLib.makeVerifyToken(uidOf('nexty@example.com'), 'nexty@example.com', SECRET);
    const good = await same('/verify?t=' + encodeURIComponent(nt) + '&next=' + encodeURIComponent('https://trip.strongtechnicalconsulting.com/'));
    ok('next on a subdomain becomes the button', /href="https:\/\/trip\.strongtechnicalconsulting\.com\/"/.test(good.html) && /Back to the app/.test(good.html));
    for (const evil of ['https://evil.example/', 'http://trip.strongtechnicalconsulting.com/', '//evil.example/',
      'https://strongtechnicalconsulting.com.evil.example/', 'javascript:alert(1)', 'https://user@evil.example@trip.strongtechnicalconsulting.com/',
      'https://trip.strongtechnicalconsulting.com:8443/', 'https://evilstrongtechnicalconsulting.com/']) {
      const r = await same('/verify?t=' + encodeURIComponent(nt) + '&next=' + encodeURIComponent(evil));
      const host = (() => { try { return new URL(evil, 'https://x.invalid').hostname; } catch (e) { return evil; } })();
      ok(`next=${evil} is ignored (no open redirect)`, r.status === 200 && !r.html.includes('Back to the app') && (!host || host === 'trip.strongtechnicalconsulting.com' || !r.html.includes(host)) && !/javascript:/i.test(r.html));
    }
    ok('safeNext keeps the apex and subdomains', identityLib.safeNext('https://strongtechnicalconsulting.com/x') === 'https://strongtechnicalconsulting.com/x'
      && identityLib.safeNext('https://challenge.strongtechnicalconsulting.com/spar/') === 'https://challenge.strongtechnicalconsulting.com/spar/');
    ok('safeNext refuses everything else', [null, '', '/relative', 'ftp://strongtechnicalconsulting.com/', 'https://a.b@strongtechnicalconsulting.com/'].every((v) => identityLib.safeNext(v) === null));
  }

  /* ================= 4. send again: limits and one answer ================= */
  {
    const a = await register('limited@example.com');          // mail 1
    const answers = [];
    for (let i = 0; i < 5; i++) {
      const r = await post('/api/id/verify/send', {}, { cookie: a.cookie });
      answers.push({ status: r.status, body: await r.text() });
    }
    ok('three mails an hour per account (register counts as one)', mailsTo('limited@example.com').length === 3, String(mailsTo('limited@example.com').length));
    ok('...and every answer is identical', answers.every((x) => x.status === 200 && x.body === answers[0].body), JSON.stringify(answers[0]));
    let r = await post('/api/id/verify/send', {});
    ok('signed out, send again is a 401', r.status === 401, String(r.status));
    r = await post('/api/id/verify/send', {}, { cookie: a.cookie, headers: { 'sec-fetch-site': 'same-site' } });
    ok('...and a sibling site\'s form cannot trigger it', r.status === 403, String(r.status));

    const ip = '203.0.113.200';
    const before = verifyMails().length;
    for (let i = 0; i < 22; i++) {
      const c = await register(`spray${i}@example.com`);     // each register from its own address
      await post('/api/id/verify/send', {}, { cookie: c.cookie, ip });
    }
    // 22 from registration (fresh addresses) + 20 from the one IP.
    ok('twenty sends an hour from one address', verifyMails().length - before === 42, String(verifyMails().length - before));
  }

  /* ================= 5. the dispatch route ================= */
  {
    await register('dispatched@example.com');
    const uid = uidOf('dispatched@example.com');
    const dispatch = (body, sig) => realFetch(B + '/api/id/verify/dispatch', {
      method: 'POST', headers: { ...J, 'x-identity-signature': sig }, body: JSON.stringify(body),
    });
    const n0 = mailsTo('dispatched@example.com').length;
    let ts = Date.now();
    let r = await dispatch({ uid, ts, next: 'https://trip.strongtechnicalconsulting.com/', to: 'attacker@example.com', email: 'attacker@example.com' },
      identityLib.dispatchSignature(uid, ts, SECRET));
    ok('a signed dispatch is accepted', r.status === 200, String(r.status));
    const got = mailsTo('dispatched@example.com');
    ok('...and mails the address on the RECORD', got.length === n0 + 1);
    ok('...never one the body named', !sent.some((m) => (m.to || []).includes('attacker@example.com')));
    ok('...with the return link carried as next', /next=https%3A%2F%2Ftrip\.strongtechnicalconsulting\.com%2F/.test(linkIn(got[got.length - 1])), linkIn(got[got.length - 1]));
    ok('...From the accounts address', got[got.length - 1].from === emailLib.DEFAULT_ACCOUNT_FROM);

    const n1 = sent.length;
    ts = Date.now();
    r = await dispatch({ uid, ts }, identityLib.dispatchSignature(uid, ts, 'the-wrong-secret-xxxxxxxxxx'));
    ok('a bad signature is refused', r.status === 401 && sent.length === n1, String(r.status));
    r = await dispatch({ uid, ts }, '');
    ok('no signature is refused', r.status === 401 && sent.length === n1);
    r = await dispatch({ uid: uidOf('someone@example.com'), ts }, identityLib.dispatchSignature(uid, ts, SECRET));
    ok('a signature for another uid is refused', r.status === 401 && sent.length === n1);
    const stale = Date.now() - 6 * 60 * 1000;
    r = await dispatch({ uid, ts: stale }, identityLib.dispatchSignature(uid, stale, SECRET));
    ok('a timestamp over five minutes old is refused', r.status === 401 && sent.length === n1, String(r.status));
    const ahead = Date.now() + 6 * 60 * 1000;
    r = await dispatch({ uid, ts: ahead }, identityLib.dispatchSignature(uid, ahead, SECRET));
    ok('...and so is one from the future', r.status === 401 && sent.length === n1);
    const unknown = uidOf('never-registered@example.com');
    ts = Date.now();
    r = await dispatch({ uid: unknown, ts }, identityLib.dispatchSignature(unknown, ts, SECRET));
    ok('an unknown uid answers ok and mails nothing', r.status === 200 && sent.length === n1);
    // A verified account gets nothing.
    const vuid = uidOf('newbie@example.com');
    ts = Date.now();
    r = await dispatch({ uid: vuid, ts }, identityLib.dispatchSignature(vuid, ts, SECRET));
    ok('a verified account is mailed nothing', r.status === 200 && sent.length === n1);
    // The landing's own per-uid count: five an hour.
    for (let i = 0; i < 8; i++) {
      ts = Date.now() + i;
      await dispatch({ uid, ts }, identityLib.dispatchSignature(uid, ts, SECRET));
    }
    ok('the landing mails one account at most five times an hour', mailsTo('dispatched@example.com').length === n0 + 5, String(mailsTo('dispatched@example.com').length - n0));
  }

  /* ================= 6. an app without the mail key forwards ================= */
  {
    // Mounted as a lab app is: identity at /api/auth inside an app at /spar.
    const inner = express();
    inner.use(express.json());
    const other = identityLib.create({ store: identityStore.store, secret: () => SECRET, app: 'unit-app', mountPath: '/api/auth' });
    other.mount(inner);
    inner.post('/api/spend', other.requireBudget, (_req, res) => res.json({ spent: true }));
    const host = express();
    host.use('/spar', inner);
    const srv = await new Promise((res) => { const x = host.listen(0, () => res(x)); });
    const U = `http://127.0.0.1:${srv.address().port}`;

    // No IDENTITY_MAIL_URL and a local host: a dev server never mails production.
    let n = sent.length;
    let r = await send(U, 'POST', '/spar/api/auth/register', { email: 'local-dev@example.com', password: 'a-long-password-1' });
    ok('a local app with no IDENTITY_MAIL_URL registers without mailing', r.status === 200 && sent.length === n, String(r.status));

    process.env.IDENTITY_MAIL_URL = B;
    n = sent.length;
    r = await send(U, 'POST', '/spar/api/auth/register', { email: 'lab-user@example.com', password: 'a-long-password-1' });
    const cookie = jar(r);
    ok('registering on another app forwards to the landing', r.status === 200 && mailsTo('lab-user@example.com').length === 1 && sent.length === n + 1,
      `${r.status} ${sent.length - n}`);
    const m = mailsTo('lab-user@example.com')[0] || {};
    ok('...which mails it From the accounts address', m.from === emailLib.DEFAULT_ACCOUNT_FROM);

    // The free-credit gate, with the resend path under the app's own mount.
    r = await send(U, 'POST', '/spar/api/spend', {}, { cookie });
    const body = await r.json();
    ok('an unverified free account is refused a model call with 403', r.status === 403 && body.code === 'verify-email', `${r.status} ${JSON.stringify(body)}`);
    ok('...saying what to do, and where the link went', body.error === 'Confirm your email to use the free AI credit. We sent a link to lab-user@example.com.', body.error);
    ok('...with a resend path under the app\'s mount', body.resend === '/spar/api/auth/verify/send', body.resend);
    r = await send(U, 'POST', body.resend, {}, { cookie });
    ok('...which sends again through the landing', r.status === 200 && mailsTo('lab-user@example.com').length === 2);

    // Clicking the link opens the credit everywhere.
    const t = new URL(linkIn(m)).searchParams.get('t');
    await get('/verify?t=' + encodeURIComponent(t));
    r = await send(U, 'POST', '/spar/api/spend', {}, { cookie });
    ok('once confirmed, the same call goes through', r.status === 200, String(r.status));

    // A dispatch that fails (landing unreachable) never fails a registration.
    process.env.IDENTITY_MAIL_URL = 'http://127.0.0.1:1';
    r = await send(U, 'POST', '/spar/api/auth/register', { email: 'unreachable@example.com', password: 'a-long-password-1' });
    ok('a mail service that cannot be reached does not fail registration', r.status === 200, String(r.status));
    delete process.env.IDENTITY_MAIL_URL;
    srv.close();
  }

  /* ================= 7. reset mail From the accounts address ================= */
  {
    await register('forgetful@example.com');
    const n = sent.length;
    await post('/api/id/reset/request', { email: 'forgetful@example.com' });
    const m = sent.slice(n).find((x) => /reset/i.test(x.subject || ''));
    ok('a reset mail is sent', Boolean(m));
    ok('...From ACCOUNT_MAIL_FROM, not NEWSLETTER_FROM', m && m.from === emailLib.DEFAULT_ACCOUNT_FROM && !String(m.from).includes('erik-personal'), m && m.from);
    ok('...with no reply-to', m && !('reply_to' in m));
    process.env.ACCOUNT_MAIL_FROM = 'Accounts <no-reply@example.com>';
    await register('forgetful2@example.com');
    const n2 = sent.length;
    await post('/api/id/reset/request', { email: 'forgetful2@example.com' });
    const m2 = sent.slice(n2).find((x) => /reset/i.test(x.subject || ''));
    ok('ACCOUNT_MAIL_FROM overrides the default', m2 && m2.from === 'Accounts <no-reply@example.com>', m2 && m2.from);
    delete process.env.ACCOUNT_MAIL_FROM;
  }

  /* ================= 8. the owner flag waits for verification ================= */
  {
    // No owner exists in this database yet.
    const boss = await register('boss@example.com');
    ok('registering ADMIN_EMAIL no longer makes an owner', boss.status === 200 && rec('boss@example.com').admin !== true);
    const m = mailsTo('boss@example.com').slice(-1)[0];
    await get('/verify?t=' + encodeURIComponent(new URL(linkIn(m)).searchParams.get('t')));
    ok('confirming ADMIN_EMAIL makes the owner', rec('boss@example.com').admin === true);
    // With an owner in place, a second ADMIN_EMAIL confirmed makes no second one.
    process.env.ADMIN_EMAIL = 'boss2@example.com';
    await register('boss2@example.com');
    const m2 = mailsTo('boss2@example.com').slice(-1)[0];
    await get('/verify?t=' + encodeURIComponent(new URL(linkIn(m2)).searchParams.get('t')));
    ok('...and once there is one, confirming another ADMIN_EMAIL makes no second owner', rec('boss2@example.com').emailVerifiedAt && rec('boss2@example.com').admin !== true);
    ok('...and the existing owner is untouched', rec('boss@example.com').admin === true);
    process.env.ADMIN_EMAIL = 'boss@example.com';
    // An ordinary address confirmed is never an owner.
    ok('an ordinary confirmed account is not an owner', rec('newbie@example.com').admin !== true);
  }

  /* ================= 9. who the free-credit gate stops ================= */
  {
    const now = Date.now();
    const recent = new Date(now - 60 * 1000).toISOString();
    const future = new Date(now + 30 * 86400000).toISOString();
    const base = { email: 'x@example.com', createdAt: recent };
    const must = identityLib.mustVerifyForFreeAi;
    ok('a new unverified free account must verify', must(base) === true);
    ok('a verified one need not', must({ ...base, emailVerifiedAt: recent }) === false);
    ok('an account made before the cutoff is grandfathered', must({ ...base, createdAt: '2026-09-27T22:59:00Z' }) === false);
    ok('...but not one made at the cutoff', must({ ...base, createdAt: '2026-09-27T23:00:00Z' }) === true);
    ok('no readable createdAt fails closed', must({ email: 'x@example.com' }) === true && must({ ...base, createdAt: 'soon' }) === true);
    ok('the owner is never gated', must({ ...base, admin: true }) === false);
    ok('a member is not gated', must({ ...base, plan: 'member', currentPeriodEnd: future }) === false);
    ok('...but a lapsed one drawing on the free allowance is', must({ ...base, plan: 'member', currentPeriodEnd: '2026-01-01T00:00:00Z' }) === true);
    ok('someone who bought credit is not gated', must({ ...base, toppedUpUsd: 5 }) === false);
    ok('a member on their own key is not gated', must({ ...base, plan: 'member', currentPeriodEnd: future, byok: { blob: 'x' } }) === false);
    ok('nobody signed in is not this gate\'s question', must(null) === false);
    process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0';
    ok('REQUIRE_VERIFIED_FOR_FREE_AI=0 switches it off', must(base) === false);
    process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
    ok('...and 1 is on', must(base) === true);
    delete process.env.REQUIRE_VERIFIED_FOR_FREE_AI;

    // Through the middleware, against the landing's own mount.
    const inner = express();
    inner.use(express.json());
    const idm = identityLib.create({ store: identityStore.store, secret: () => SECRET, app: 'gate-unit' });
    idm.mount(inner);
    inner.post('/spend', idm.requireBudget, (_req, res) => res.json({ spent: true }));
    const srv = await new Promise((res) => { const x = inner.listen(0, () => res(x)); });
    const U = `http://127.0.0.1:${srv.address().port}`;
    const cases = [
      ['grandfathered', { createdAt: '2026-09-01T00:00:00Z' }, 200],
      ['verified', { createdAt: recent, emailVerifiedAt: recent }, 200],
      ['member', { createdAt: recent, plan: 'member', currentPeriodEnd: future }, 200],
      ['topped up', { createdAt: recent, toppedUpUsd: 5 }, 200],
      ['byok member', { createdAt: recent, plan: 'member', currentPeriodEnd: future, byok: { blob: 'x' } }, 200],
      ['owner', { createdAt: recent, admin: true }, 200],
      ['unverified free', { createdAt: recent }, 403],
    ];
    for (const [label, fields, want] of cases) {
      const email = `gate-${label.replace(/\W/g, '')}@example.com`;
      users().set('users/' + uidOf(email), { email, ...fields });
      const r = await send(U, 'POST', '/spend', {}, { cookie: h.session(SECRET, email) });
      ok(`requireBudget: ${label} -> ${want}`, r.status === want, String(r.status));
    }
    const r0 = await send(U, 'POST', '/spend', {}, { cookie: h.session(SECRET, 'gate-unverifiedfree@example.com') });
    const b0 = await r0.json();
    ok('the 403 carries the landing mount\'s resend path', b0.resend === '/api/id/verify/send', b0.resend);
    process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0';
    const r1 = await send(U, 'POST', '/spend', {}, { cookie: h.session(SECRET, 'gate-unverifiedfree@example.com') });
    ok('with the flag off the same account goes through', r1.status === 200, String(r1.status));
    delete process.env.REQUIRE_VERIFIED_FOR_FREE_AI;
    // Out of credit AND verified: still the 402, not this.
    users().set('users/' + uidOf('gate-spent@example.com'), { email: 'gate-spent@example.com', createdAt: recent, emailVerifiedAt: recent, spentUsd: 99 });
    const r2 = await send(U, 'POST', '/spend', {}, { cookie: h.session(SECRET, 'gate-spent@example.com') });
    ok('a verified account out of credit still gets the 402', r2.status === 402, String(r2.status));
    srv.close();
  }

  /* ================= 10. pages carry no address ================= */
  for (const p of ['/account', '/privacy', '/verify?t=x']) {
    const html = await (await get(p)).text();
    const found = (html.match(ADDRESS) || []).filter((a) => !a.endsWith('.png') && !a.endsWith('.jpg'));
    ok(`${p} carries no email address`, found.length === 0, found.join(', '));
  }
  {
    const acct = await (await get('/account')).text();
    ok('the account page has the verify card and its button', /id="verifyCard"/.test(acct) && /Send the link again/.test(acct));
    const priv = await (await get('/privacy')).text();
    ok('the privacy page explains the confirmation mail', /Confirming your email/.test(priv) && /accounts address/.test(priv));
    const home = await (await get('/')).text();
    ok('the landing loads the shared banner at /api/id', /<script src="\/verify-banner\.js" data-mount="\/api\/id" defer><\/script>/.test(home));
    const js = await (await get('/verify-banner.js')).text();
    ok('/verify-banner.js is served', /stc-verify-banner/.test(js));
  }

  /* ================= 11. the banner script ================= */
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'verify-banner.js'), 'utf8');
    const banner = require(path.join(__dirname, '..', 'shared', 'verify-banner.js'));
    ok('mask keeps the first letter and the domain', banner.mask('erik@example.com') === 'e***@example.com', banner.mask('erik@example.com'));
    ok('...and gives nothing for a non-address', banner.mask('') === '' && banner.mask('@x.com') === '' && banner.mask('nope') === '');
    ok('the shared copy matches identity\'s own masking', identityLib.maskEmail('erik@example.com') === banner.mask('erik@example.com'));
    ok('no inline handlers or eval in the script', !/on(click|load|error)\s*=|eval\(|new Function/.test(src));

    // A stand-in DOM, just enough for start() to run in a vm.
    function fakeDom() {
      const made = [];
      const mk = (tag) => {
        const el = { tagName: tag, children: [], attrs: {}, listeners: {}, textContent: '', className: '', id: '', parentNode: null,
          setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] || null; },
          appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
          removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
          addEventListener(t, fn) { this.listeners[t] = fn; } };
        made.push(el);
        return el;
      };
      const body = mk('body');
      const head = mk('head');
      const script = mk('script');
      script.setAttribute('data-mount', 'api/auth');
      const doc = { body, head, documentElement: head, currentScript: script, adoptedStyleSheets: [],
        createElement: mk, getElementById: (id) => made.find((e) => e.id === id && e.parentNode) || null,
        querySelectorAll: () => [script], addEventListener() {} };
      return { doc, body };
    }
    async function run(me) {
      const { doc, body } = fakeDom();
      const asked = [];
      const win = {
        document: doc,
        sessionStorage: { getItem: () => null, setItem() {} },
        CSSStyleSheet: function () { this.replaceSync = function () {}; },
        fetch: async (url, opts) => { asked.push({ url, opts }); return { ok: true, json: async () => me }; },
      };
      win.top = win;
      doc.defaultView = win;
      vm.runInNewContext(src, { window: win, Array, String, Promise, Boolean });
      await new Promise((r) => setTimeout(r, 20));
      return { body, asked };
    }
    let out = await run({ signedIn: true, email: 'erik@example.com', emailVerified: true });
    ok('the banner asks <mount>/me with the page\'s credentials', out.asked[0] && out.asked[0].url === 'api/auth/me' && out.asked[0].opts.credentials === 'same-origin', JSON.stringify(out.asked[0]));
    ok('...and draws nothing when verified', out.body.children.length === 0);
    out = await run({ signedIn: false });
    ok('...or signed out', out.body.children.length === 0);
    out = await run({ signedIn: true, email: 'erik@example.com' });
    ok('...or when /me does not report it at all', out.body.children.length === 0);
    out = await run({ signedIn: true, email: 'erik@example.com', emailVerified: false });
    const bar = out.body.children[0];
    const text = bar && bar.children[0] && bar.children[0].textContent;
    ok('an unverified account gets the bar', Boolean(bar) && bar.id === 'stc-verify-banner');
    ok('...naming the address masked', text === 'Confirm your email to unlock the free AI credit and shared items - we sent a link to e***@example.com.', text);
    ok('...never in full', !String(text).includes('erik@'));
    ok('...with Send again and Dismiss buttons', bar && bar.children[1].textContent === 'Send again' && bar.children[2].attrs['aria-label'] === 'Dismiss');
    // Send again posts JSON to the mount.
    const { asked } = out;
    await bar.children[1].listeners.click();
    await new Promise((r) => setTimeout(r, 20));
    const sendCall = asked.find((a) => /verify\/send$/.test(a.url));
    ok('Send again posts JSON to <mount>/verify/send', sendCall && sendCall.url === 'api/auth/verify/send' && sendCall.opts.method === 'POST'
      && sendCall.opts.headers['Content-Type'] === 'application/json', JSON.stringify(sendCall));
    bar.children[2].listeners.click();
    ok('Dismiss removes it', out.body.children.length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
