// The shared account's security fixes of 2026-09-27, held against the landing
// service (which mounts shared/identity.js at /api/id) and against identity
// on its own:
//
// - writes from a sibling subdomain's form are refused (same-site CSRF);
// - a password change or reset ends every other session, not just the form;
// - a user-record write never carries an old balance over a spend charge;
// - sign-in, password change and reset requests are counted and limited;
// - requireBudget refuses a request with no account;
// - the landing parses cookies, so a passkey's challenge cookie is found;
// - the landing's headers, trust proxy and cron key compare.
const h = require('./harness.js');
h.install();
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

const PORT = 9231;
const SECRET = 'identity-secret-abcdefghijklmn';
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: SECRET,
  SESSION_SECRET: 'landing-secret-abcdefghijklm',
  ADMIN_PASSWORD: 'admin-password-here-1',
  ADMIN_EMAIL: 'boss@example.com',
  CRON_SECRET: 'cron-secret-for-the-test-1234',
  FIRESTORE_DATABASE_ID: 'eriks-projects',
  IDENTITY_DATABASE_ID: 'identity',
  GOOGLE_CLOUD_PROJECT: 'test',
  PASSKEY_RP_ID: 'strongtechnicalconsulting.com',
  RESEND_API_KEY: 're_test_not_real',
  NEWSLETTER_FROM: 'Test <news@example.com>',
  PORT: String(PORT),
});

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
const resetLib = require(path.join(__dirname, '..', 'shared', 'reset.js'));

const B = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
let ipN = 0;
const freshIp = () => `198.18.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
/** A JSON request the way an app's own page sends it, from a fresh address
 *  unless one is given (so the limiters only bite where a test means them to). */
function send(method, p, body, { cookie, headers = {}, ip } = {}) {
  const hd = { ...J, 'x-forwarded-for': ip || freshIp(), ...headers };
  if (cookie) hd.cookie = cookie;
  return realFetch(B + p, { method, headers: hd, body: body === undefined ? undefined : JSON.stringify(body) });
}
const post = (p, b, o) => send('POST', p, b, o);
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const cookieNamed = (r, name) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '=')) || '';
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');
const users = () => h.bag('identity');
const me = async (cookie) => (await (await send('GET', '/api/id/me', undefined, { cookie })).json());

/** A token as it was minted before pwv existed: no pwv, no iat. */
function legacyToken(email, { exp = Math.floor(Date.now() / 1000) + 30 * 86400, via = 'password' } = {}) {
  const body = Buffer.from(JSON.stringify({ sub: uidOf(email), exp, via })).toString('base64url');
  return 'stc_session=' + encodeURIComponent(body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url'));
}
function passkeyToken(email, record) {
  const now = Date.now();
  const payload = { sub: uidOf(email), exp: Math.floor(now / 1000) + 3600, via: 'passkey', iat: now,
    pwv: identityLib.passwordVersion(record, SECRET) };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return 'stc_session=' + encodeURIComponent(body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url'));
}

async function register(email, password = 'a-long-password-1') {
  const r = await post('/api/id/register', { email, password });
  return { status: r.status, cookie: jar(r) };
}

(async () => {
  for (let i = 0; i < 60; i++) { try { await realFetch(B + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  /* ================= 1. same-site CSRF ================= */
  const a = await register('csrf@example.com');
  ok('an account registers from its own page', a.status === 200, String(a.status));

  let r = await post('/api/id/profile', { displayName: 'From a sibling' },
    { cookie: a.cookie, headers: { 'sec-fetch-site': 'same-site' } });
  ok('a write marked Sec-Fetch-Site: same-site is refused', r.status === 403, String(r.status));
  r = await post('/api/id/profile', { displayName: 'From a sibling' },
    { cookie: a.cookie, headers: { origin: 'https://evil.strongtechnicalconsulting.com' } });
  ok('a write whose Origin is another host is refused', r.status === 403, String(r.status));
  r = await post('/api/id/profile', { displayName: 'x' }, { cookie: a.cookie, headers: { origin: 'null' } });
  ok('...and Origin: null is refused', r.status === 403, String(r.status));

  // The attack itself: a plain HTML form, which cannot send JSON and which an
  // old browser might send with neither header.
  r = await realFetch(B + '/api/id/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: a.cookie },
    body: 'displayName=Owned',
  });
  ok('a form-encoded body is refused even with no Origin header', r.status === 403, String(r.status));
  r = await realFetch(B + '/api/id/profile', {
    method: 'POST', headers: { 'content-type': 'text/plain', cookie: a.cookie }, body: '{"displayName":"Owned"}',
  });
  ok('...and so is text/plain (a no-cors fetch)', r.status === 403, String(r.status));
  ok('...and the profile was not changed', !users().get('users/' + uidOf('csrf@example.com')).displayName);

  r = await post('/api/id/profile', { displayName: 'Mine' },
    { cookie: a.cookie, headers: { origin: B, 'sec-fetch-site': 'same-origin' } });
  ok('the same write from the site\'s own page works', r.status === 200, String(r.status));
  r = await post('/api/id/profile', { displayName: 'Mine too' }, { cookie: a.cookie, headers: { 'sec-fetch-site': 'none' } });
  ok('...and Sec-Fetch-Site: none (typed, bookmarked) is allowed', r.status === 200, String(r.status));

  // The finding's headline: a passkey-proved session may set a password
  // without the old one, so a sibling's form could have taken the account.
  const pkRecord = users().get('users/' + uidOf('csrf@example.com'));
  const pk = passkeyToken('csrf@example.com', pkRecord);
  r = await realFetch(B + '/api/id/password', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: pk }, body: 'next=attacker-chosen-pass',
  });
  ok('a passkey session\'s password cannot be changed by a sibling\'s form', r.status === 403, String(r.status));
  r = await post('/api/id/login', { email: 'csrf@example.com', password: 'a-long-password-1' });
  ok('...the password is still the owner\'s', r.status === 200, String(r.status));

  r = await send('DELETE', '/api/id/account', { password: 'a-long-password-1' },
    { cookie: a.cookie, headers: { 'sec-fetch-site': 'same-site' } });
  ok('account deletion from a sibling is refused', r.status === 403 && users().has('users/' + uidOf('csrf@example.com')), String(r.status));
  r = await send('DELETE', '/api/id/byok', undefined, { cookie: a.cookie, headers: { origin: 'https://evil.example' } });
  ok('removing the key from another origin is refused', r.status === 403, String(r.status));
  r = await post('/api/id/billing/portal', {}, { cookie: a.cookie, headers: { 'sec-fetch-site': 'cross-site' } });
  ok('billing from another site is refused', r.status === 403, String(r.status));
  r = await post('/api/id/access/request', { note: 'hi' }, { cookie: a.cookie, headers: { 'sec-fetch-site': 'same-site' } });
  ok('an access request from a sibling is refused', r.status === 403, String(r.status));
  r = await post('/api/id/passkey/register/options', { password: 'a-long-password-1' },
    { cookie: a.cookie, headers: { 'sec-fetch-site': 'same-site' } });
  ok('passkey enrolment from a sibling is refused', r.status === 403, String(r.status));
  r = await realFetch(B + '/api/id/passkey/login/options', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  ok('...and so is a form-posted passkey sign-in', r.status === 403, String(r.status));
  r = await post('/api/id/login', { email: 'csrf@example.com', password: 'a-long-password-1' },
    { headers: { 'sec-fetch-site': 'same-site' } });
  ok('signing someone in from a sibling (login CSRF) is refused', r.status === 403, String(r.status));
  r = await post('/api/id/reset/request', { email: 'csrf@example.com' }, { headers: { 'sec-fetch-site': 'same-site' } });
  ok('a reset request from a sibling is refused', r.status === 403, String(r.status));

  // sitepass: the landing admin's password change.
  r = await realFetch(B + '/api/admin/password/change', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': freshIp() },
    body: 'current=admin-password-here-1&next=attacker-chosen-pass',
  });
  ok('the admin password cannot be changed by a form', r.status === 403, String(r.status));
  r = await post('/api/admin/login', { password: 'admin-password-here-1' });
  ok('...it is still the admin password', r.status === 200, String(r.status));

  // Body-less writes from a page's own fetch still work.
  r = await realFetch(B + '/api/id/logout', { method: 'POST', headers: { cookie: a.cookie } });
  ok('a body-less logout (no content type) still works', r.status === 200, String(r.status));

  /* ================= 2. a password change ends other sessions ================= */
  await register('pwv@example.com', 'first-password-123');
  const phone = jar(await post('/api/id/login', { email: 'pwv@example.com', password: 'first-password-123' }));
  const laptop = jar(await post('/api/id/login', { email: 'pwv@example.com', password: 'first-password-123' }));
  const oldLegacy = legacyToken('pwv@example.com');
  ok('two browsers are signed in', (await me(phone)).signedIn && (await me(laptop)).signedIn);
  ok('...as is a session from before pwv existed', (await me(oldLegacy)).signedIn === true);

  r = await post('/api/id/password', { current: 'first-password-123', next: 'second-password-456' }, { cookie: phone });
  ok('the password changes', r.status === 200, String(r.status));
  const phoneNow = jar(r);
  ok('...and the browser that changed it gets a fresh session', /stc_session=/.test(phoneNow));
  ok('...which is signed in', (await me(phoneNow)).signedIn === true);
  ok('the other browser is signed out', (await me(laptop)).signedIn === false);
  ok('the changing browser\'s OLD cookie is dead too', (await me(phone)).signedIn === false);
  ok('a pre-pwv session is ended by the change (passwordChangedAt is after it)', (await me(oldLegacy)).signedIn === false);
  r = await post('/api/id/profile', { displayName: 'late' }, { cookie: laptop });
  ok('...and cannot act on the account', r.status === 401, String(r.status));
  ok('a session issued after the change, even without pwv, stands',
     (await me(legacyToken('pwv@example.com', { exp: Math.floor(Date.now() / 1000) + 30 * 86400 + 5 }))).signedIn === true);

  // A passkey-proved session keeps its proof when re-issued.
  const pwvRec = users().get('users/' + uidOf('pwv@example.com'));
  const pwvPk = passkeyToken('pwv@example.com', pwvRec);
  r = await post('/api/id/password', { next: 'third-password-789' }, { cookie: pwvPk });
  ok('a passkey session changes the password without the old one', r.status === 200, String(r.status));
  ok('...and stays a passkey session', (await me(jar(r))).via === 'passkey');
  ok('...while the session from the change before is gone', (await me(phoneNow)).signedIn === false);

  // Someone else changing it (an admin reset in another app writes a new
  // hash straight to the record) ends the session too.
  const before = jar(await post('/api/id/login', { email: 'pwv@example.com', password: 'third-password-789' }));
  ok('signed in again', (await me(before)).signedIn === true);
  const rec = users().get('users/' + uidOf('pwv@example.com'));
  users().set('users/' + uidOf('pwv@example.com'), { ...rec, password: identityLib.makeHash('temporary-by-admin') });
  ok('an admin writing a new hash elsewhere signs that browser out', (await me(before)).signedIn === false);

  // A reset by emailed link: the old sessions die, the one it issues works.
  users().set('users/' + uidOf('pwv@example.com'), { ...users().get('users/' + uidOf('pwv@example.com')), password: identityLib.makeHash('before-reset-000') });
  const preReset = jar(await post('/api/id/login', { email: 'pwv@example.com', password: 'before-reset-000' }));
  const hashNow = users().get('users/' + uidOf('pwv@example.com')).password.hash;
  r = await post('/api/id/reset/complete', { token: resetLib.makeToken(uidOf('pwv@example.com'), hashNow), password: 'after-reset-1111' });
  ok('a reset link sets a new password', r.status === 200, String(r.status));
  ok('...signs in the browser that used it', (await me(jar(r))).signedIn === true);
  ok('...and ends the session from before it', (await me(preReset)).signedIn === false);

  // No pwv and a password changed BEFORE the token was issued: untouched.
  await register('old@example.com');
  ok('a legacy session on an account whose password never changed still works',
     (await me(legacyToken('old@example.com'))).signedIn === true);

  /* ================= 3. writes never erase a spend charge ================= */
  // Over HTTP on the landing: a charge between a route's read and its write.
  // The in-memory Firestore answers synchronously, so the read is held open
  // by wrapping the identity store the landing uses.
  const identityStore = require(path.join(__dirname, '..', 'lib', 'identity-store.js')).store;
  const realGet = identityStore.get;
  let hold = null;
  function holdNthUserRead(n) {
    let count = 0, release, reached;
    const released = new Promise((res) => { release = res; });
    const arrived = new Promise((res) => { reached = res; });
    hold = { released, arrived };
    identityStore.get = async function (col, id) {
      const v = await realGet.call(this, col, id);
      if (col === 'users' && ++count === n) { reached(); await released; }
      return v;
    };
    return { arrived, release: () => { identityStore.get = realGet; hold = null; release(); } };
  }
  async function raceWith(n, request) {
    const gate = holdNthUserRead(n);
    const pending = request();
    await gate.arrived;
    await identityStore.bump('users', uidOf('spend@example.com'), { spentUsd: 0.75, callCount: 1 });
    gate.release();
    return pending;
  }
  const spend = await register('spend@example.com', 'spend-password-1');
  const spentNow = () => Number(users().get('users/' + uidOf('spend@example.com')).spentUsd || 0);

  r = await raceWith(1, () => post('/api/id/login', { email: 'spend@example.com', password: 'spend-password-1' }));
  ok('signing in while a charge lands', r.status === 200, String(r.status));
  ok('...keeps the charge', Math.abs(spentNow() - 0.75) < 1e-9, String(spentNow()));
  const spendCookie = jar(r);

  // attachUser reads the record first; the route's own read is the second.
  r = await raceWith(2, () => post('/api/id/profile', { displayName: 'Spender' }, { cookie: spendCookie }));
  ok('a profile change while a charge lands keeps it', r.status === 200 && Math.abs(spentNow() - 1.5) < 1e-9, `${r.status} ${spentNow()}`);
  r = await raceWith(2, () => post('/api/id/access/request', { note: 'please' }, { cookie: spendCookie }));
  ok('an access request while a charge lands keeps it', r.status === 200 && Math.abs(spentNow() - 2.25) < 1e-9, `${r.status} ${spentNow()}`);
  r = await raceWith(2, () => post('/api/id/password', { current: 'spend-password-1', next: 'spend-password-2' }, { cookie: spendCookie }));
  ok('a password change while a charge lands keeps it', r.status === 200 && Math.abs(spentNow() - 3) < 1e-9, `${r.status} ${spentNow()}`);
  const recNow = users().get('users/' + uidOf('spend@example.com'));
  ok('...and every other field survives the partial writes',
     recNow.displayName === 'Spender' && recNow.requests && recNow.requests.landing && recNow.email === 'spend@example.com' && recNow.callCount === 4,
     JSON.stringify(Object.keys(recNow)));

  // The same through identity alone, on stores with and without patch/merge.
  async function unitStore({ withPatch, withMerge }) {
    const bag = new Map();
    const s = {
      async get(c, id) { const v = bag.get(c + '/' + id); return v ? JSON.parse(JSON.stringify(v)) : null; },
      async set(c, id, v) { bag.set(c + '/' + id, JSON.parse(JSON.stringify(v))); },
      async list(c) { return [...bag].filter(([k]) => k.startsWith(c + '/')).map(([k, v]) => ({ id: k.slice(c.length + 1), ...v })); },
      async remove(c, id) { bag.delete(c + '/' + id); },
      async add() {},
      async bump(c, id, d) { const cur = bag.get(c + '/' + id) || {}; for (const [k, by] of Object.entries(d)) cur[k] = Number(cur[k] || 0) + by; bag.set(c + '/' + id, cur); },
    };
    if (withPatch) s.patch = async (c, id, f) => { bag.set(c + '/' + id, { ...(bag.get(c + '/' + id) || {}), ...JSON.parse(JSON.stringify(f)) }); };
    if (withMerge) s.merge = async (c, id, f) => { bag.set(c + '/' + id, { ...(bag.get(c + '/' + id) || {}), ...JSON.parse(JSON.stringify(f)) }); };
    return { s, bag };
  }
  for (const kind of [{ withPatch: true }, { withMerge: true }]) {
    const { s, bag } = await unitStore(kind);
    const id = identityLib.create({ store: s, secret: () => SECRET, app: 'unit' });
    bag.set('users/u1', { email: 'u@example.com', access: { a: 'member', b: 'member' }, requests: {} });
    await s.bump('users', 'u1', { spentUsd: 1 });
    await id.setAccess('u1', 'b', null);
    const after = bag.get('users/u1');
    ok(`setAccess (${kind.withPatch ? 'patch' : 'merge-only store'}) removes the grant and keeps the balance`,
       !('b' in after.access) && after.access.a === 'member' && after.spentUsd === 1, JSON.stringify(after));
  }

  /* ================= 4. guessing limits ================= */
  await register('target@example.com', 'the-right-password');
  // Ten wrong answers for one account, each from a different address...
  await Promise.all(Array.from({ length: 10 }, () => post('/api/id/login', { email: 'target@example.com', password: 'wrong-guess-xx' })));
  r = await post('/api/id/login', { email: 'target@example.com', password: 'the-right-password' });
  ok('ten failures for one account lock it for a while, from any address', r.status === 429, String(r.status));
  ok('...saying so, with Retry-After', Number(r.headers.get('retry-after')) > 0);
  r = await post('/api/id/login', { email: 'nobody-here@example.com', password: 'wrong-guess-xx' });
  ok('another account is unaffected', r.status === 401, String(r.status));
  await Promise.all(Array.from({ length: 10 }, () => post('/api/id/login', { email: 'ghost@example.com', password: 'wrong-guess-xx' })));
  r = await post('/api/id/login', { email: 'ghost@example.com', password: 'wrong-guess-xx' });
  ok('an address with no account is limited the same way (no oracle)', r.status === 429, String(r.status));

  // Thirty failures from one address, across accounts.
  const oneIp = '203.0.113.77';
  await register('ipvictim@example.com', 'ipvictim-password');
  await Promise.all(Array.from({ length: 30 }, (_, i) => post('/api/id/login', { email: `spray${i}@example.com`, password: 'wrong-guess-xx' }, { ip: oneIp })));
  r = await post('/api/id/login', { email: 'ipvictim@example.com', password: 'ipvictim-password' }, { ip: oneIp });
  ok('thirty failures from one address stop that address', r.status === 429, String(r.status));
  r = await post('/api/id/login', { email: 'ipvictim@example.com', password: 'ipvictim-password' }, { ip: `9.9.9.9, ${oneIp}` });
  ok('...and a forged X-Forwarded-For in front does not get round it', r.status === 429, String(r.status));
  r = await post('/api/id/login', { email: 'ipvictim@example.com', password: 'ipvictim-password' });
  ok('...while another address signs the same account in', r.status === 200, String(r.status));

  // Reset requests: three per address per hour, twenty per IP. Same answer.
  await register('inbox@example.com');
  const sentBefore = sent.length;
  const answers = [];
  for (let i = 0; i < 5; i++) answers.push(await (await post('/api/id/reset/request', { email: 'inbox@example.com' })).json());
  ok('only three reset emails go to one address in an hour', sent.length - sentBefore === 3, String(sent.length - sentBefore));
  ok('...and every answer is the same', answers.every((x) => x.ok === true && x.message === answers[0].message));
  const resetIp = '203.0.113.90';
  const before2 = sent.length;
  for (let i = 0; i < 22; i++) {
    await register(`many${i}@example.com`);
    await post('/api/id/reset/request', { email: `many${i}@example.com` }, { ip: resetIp });
  }
  ok('twenty per address per hour from one IP', sent.length - before2 === 20, String(sent.length - before2));

  // The landing admin: ten failures from one address.
  const adminIp = '203.0.113.120';
  await Promise.all(Array.from({ length: 10 }, () => post('/api/admin/login', { password: 'not-the-password' }, { ip: adminIp })));
  r = await post('/api/admin/login', { password: 'admin-password-here-1' }, { ip: adminIp });
  ok('ten failed admin sign-ins stop that address', r.status === 429, String(r.status));
  // sitepass's change route checks the CURRENT password with no session.
  const spIp = '203.0.113.130';
  await Promise.all(Array.from({ length: 10 }, () => post('/api/admin/password/change', { current: 'guess-guess-1', next: 'whatever-new-1' }, { ip: spIp })));
  r = await post('/api/admin/password/change', { current: 'admin-password-here-1', next: 'whatever-new-1' }, { ip: spIp });
  ok('the admin password-change route is not a guessing oracle', r.status === 429, String(r.status));

  // A wrong current password on /api/id/password counts toward the account.
  await register('stolen@example.com', 'stolen-password-1');
  const thief = jar(await post('/api/id/login', { email: 'stolen@example.com', password: 'stolen-password-1' }));
  for (let i = 0; i < 10; i++) await post('/api/id/password', { current: 'guess-' + i + '-xxxx', next: 'thief-password-1' }, { cookie: thief });
  r = await post('/api/id/password', { current: 'stolen-password-1', next: 'thief-password-1' }, { cookie: thief });
  ok('guessing the current password with a stolen session is limited too', r.status === 429, String(r.status));

  /* ================= 5. requireBudget needs an account ================= */
  {
    const { s, bag } = await unitStore({ withPatch: true });
    const id = identityLib.create({ store: s, secret: () => SECRET, app: 'unit' });
    const app = express();
    app.use(express.json());
    id.mount(app);
    app.post('/spend', id.requireBudget, id.requireDailyCap, (_req, res) => res.json({ spent: true }));
    const srv = await new Promise((res) => { const x = app.listen(0, () => res(x)); });
    const U = `http://127.0.0.1:${srv.address().port}`;
    let x = await realFetch(U + '/spend', { method: 'POST', headers: J, body: '{}' });
    ok('requireBudget refuses a request with no account', x.status === 401, String(x.status));
    x = await realFetch(U + '/api/id/register', { method: 'POST', headers: J, body: JSON.stringify({ email: 'b@example.com', password: 'budget-password' }) });
    const c = jar(x);
    x = await realFetch(U + '/spend', { method: 'POST', headers: { ...J, cookie: c }, body: '{}' });
    ok('...and lets an account with credit through', x.status === 200, String(x.status));
    await s.bump('users', uidOf('b@example.com'), { spentUsd: 50 });
    x = await realFetch(U + '/spend', { method: 'POST', headers: { ...J, cookie: c }, body: '{}' });
    ok('...and stops one without', x.status === 402, String(x.status));
    srv.close();
    void bag;
  }

  /* ================= a malformed cookie cannot take the process down ================= */
  for (const p of ['/api/id/me', '/api/admin/me', '/', '/api/id/billing']) {
    r = await realFetch(B + p, { headers: { cookie: 'x=%E0%A4%A; stc_session=%E0%A4%A; esadmin=%zz' } });
    ok(`a malformed cookie on ${p} gets an answer`, r.status < 500, String(r.status));
  }
  r = await realFetch(B + '/api/id/me', { headers: { cookie: 'x=%E0%A4%A; ' + a.cookie } });
  ok('...and a good cookie beside a bad one still signs in', (await r.json()).signedIn === true);
  await new Promise((res) => setTimeout(res, 100));
  r = await realFetch(B + '/api/health');
  ok('the server is still up afterwards', r.status === 200, String(r.status));

  /* ================= free-tier counting follows the payer ================= */
  {
    const { s, bag } = await unitStore({ withPatch: true });
    const id = identityLib.create({ store: s, secret: () => SECRET, app: 'sweep' });
    bag.set('users/member', { email: 'm@example.com', plan: 'member', currentPeriodEnd: new Date(Date.now() + 864e5).toISOString() });
    bag.set('users/free', { email: 'f@example.com' });
    const capKey = () => [...bag.keys()].find((k) => k.startsWith('control/free-spend-sweep-'));
    const usage = { input_tokens: 100000, output_tokens: 1000 };
    await id.recordUsage({ model: 'claude-haiku-4-5', usage, uid: 'member' });
    ok('a sweep charging a member by uid does not count as free tier', !capKey(), String(capKey()));
    ok('...but the member is charged', Number(bag.get('users/member').spentUsd) > 0);
    await id.recordUsage({ model: 'claude-haiku-4-5', usage, uid: 'free' });
    ok('a sweep charging a free account counts as free tier', !!capKey() && Number(bag.get(capKey()).usd) > 0);
  }

  /* ================= 11. the passkey challenge cookie is read ================= */
  await register('face@example.com', 'face-id-password');
  const face = jar(await post('/api/id/login', { email: 'face@example.com', password: 'face-id-password' }));
  r = await post('/api/id/passkey/register/options', { password: 'face-id-password' }, { cookie: face });
  ok('passkey enrolment starts', r.status === 200, String(r.status));
  const regCookies = [cookieNamed(r, 'pk_reg'), cookieNamed(r, 'pk_who')].filter(Boolean).join('; ');
  ok('...and sets its challenge cookies', /pk_reg=/.test(regCookies) && /pk_who=/.test(regCookies));
  r = await post('/api/id/passkey/register/verify', { id: 'x', rawId: 'x', type: 'public-key', response: {} },
    { cookie: `${face}; ${regCookies}` });
  let body = await r.json();
  ok('the verify step finds that challenge (it used to say "took too long")', !/took too long/i.test(body.error || ''), JSON.stringify(body));
  r = await post('/api/id/passkey/register/verify', { id: 'x', rawId: 'x', type: 'public-key', response: {} }, { cookie: face });
  body = await r.json();
  ok('...and without the cookie it still says so', r.status === 400 && /took too long/i.test(body.error || ''), JSON.stringify(body));

  users().set('webauthn-credentials/cred-1', { ownerId: uidOf('face@example.com'), publicKey: Buffer.from('k').toString('base64'), counter: 0, rpID: '127.0.0.1' });
  r = await post('/api/id/passkey/login/options');
  ok('passkey sign-in starts', r.status === 200, String(r.status));
  const authCookie = cookieNamed(r, 'pk_auth');
  r = await post('/api/id/passkey/login/verify', { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {} }, { cookie: authCookie });
  body = await r.json();
  ok('...and its verify step finds the challenge cookie', !/took too long/i.test(body.error || ''), JSON.stringify(body));

  /* ================= 10. headers ================= */
  r = await realFetch(B + '/');
  ok('pages carry nosniff', r.headers.get('x-content-type-options') === 'nosniff');
  ok('...and may only be framed by this site', /frame-ancestors 'self'/.test(r.headers.get('content-security-policy') || ''));
  r = await realFetch(B + '/account');
  ok('the account page too', /frame-ancestors 'self'/.test(r.headers.get('content-security-policy') || ''));
  const adminCookie = jar(await post('/api/admin/login', { password: 'admin-password-here-1' }));
  r = await realFetch(B + '/admin/inbox', { headers: { cookie: adminCookie } });
  ok('/admin/inbox keeps its stricter policy', r.status === 200 && /frame-ancestors 'none'/.test(r.headers.get('content-security-policy') || '') && /default-src 'self'/.test(r.headers.get('content-security-policy') || ''), r.headers.get('content-security-policy'));

  /* ================= 8. the cron key ================= */
  r = await post('/api/cron/notify', {}, { headers: { 'x-cron-key': 'cron-secret-for-the-test-123X' } });
  ok('a wrong cron key is a 404', r.status === 404, String(r.status));
  r = await post('/api/cron/notify', {}, { headers: { 'x-cron-key': 'cron' } });
  ok('...so is a short one', r.status === 404, String(r.status));
  r = await post('/api/cron/notify', {}, { headers: { 'x-cron-key': 'cron-secret-for-the-test-1234' } });
  ok('the right one is accepted', r.status !== 404, String(r.status));

  void hold;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
