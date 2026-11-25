// Owner AI grants (2026-11-23): /admin/ai and its API, the grant on the user
// record, budgetFor / requireBudget honouring it, expiry on read, revoke,
// owner-only, the event log, and the Lab's caps shown from its status.
const http = require('http');
const h = require('./harness.js');
h.install();
const SECRET = 'identity-secret-abcdefghijklmn';
process.env.IDENTITY_SESSION_SECRET = SECRET;
process.env.SESSION_SECRET = 'landing-secret-abcdefghijklm';
process.env.ADMIN_PASSWORD = 'admin-password-here-1';
process.env.ADMIN_EMAIL = 'boss@example.com';
process.env.FIRESTORE_DATABASE_ID = 'eriks-projects';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.PORT = '9231';
process.env.LAB_URL = 'http://127.0.0.1:9232';

// A stand-in for the lab's public cap status.
http.createServer((req, res) => {
  if (req.url === '/api/lab/ai-guard') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ claude: { capUsd: 25, monthUsd: 3.21 }, gemini: { capUsd: 25, monthUsd: null } }));
  }
  res.writeHead(404); res.end();
}).listen(9232, '127.0.0.1');

const identityLib = require('../shared/identity.js');
require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9231';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c, extra = {}) => fetch(B + p, { method: 'POST', headers: { ...J, ...(c ? { cookie: c } : {}), ...extra }, body: JSON.stringify(b) });
const get = (p, c) => fetch(B + p, { headers: c ? { cookie: c } : {} });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');
const users = () => h.bag('identity');
const near = (a, b) => Math.abs(a - b) < 1e-9;

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  let r = await post('/api/id/register', { email: 'boss@example.com', password: 'a-long-password-1' });
  const admin = jar(r);
  r = await post('/api/id/register', { email: 'friend@example.com', password: 'a-long-password-2' });
  const friend = jar(r);
  const uid = uidOf('friend@example.com');
  ok('two accounts exist', r.status === 200);

  /* ---- owner only ---- */
  r = await fetch(B + '/admin/ai', { redirect: 'manual' });
  ok('the page sends a stranger to sign in', r.status === 302 && /\/admin\/login/.test(r.headers.get('location') || ''), String(r.status));
  r = await fetch(B + '/admin/ai', { redirect: 'manual', headers: { cookie: friend } });
  ok('...and an ordinary account too', r.status === 302, String(r.status));
  r = await get('/admin/ai', admin);
  const html = await r.text();
  ok('the owner gets the page, with a strict script CSP', r.status === 200 && /script-src 'self'/.test(r.headers.get('content-security-policy') || ''));
  // A second account of the owner's, carrying the shared owner flag rather than
  // being ADMIN_EMAIL, is an owner here too (2026-11-25), as in Football, Trip
  // Planner and the Lab.
  r = await post('/api/id/register', { email: 'second@example.com', password: 'a-long-password-3' });
  const second = jar(r);
  const secondKey = 'users/' + uidOf('second@example.com');
  r = await fetch(B + '/admin/ai', { redirect: 'manual', headers: { cookie: second } });
  ok('...an account without the flag is not', r.status === 302 || r.status === 404, String(r.status));
  users().set(secondKey, { ...users().get(secondKey), admin: true });
  r = await fetch(B + '/admin/ai', { redirect: 'manual', headers: { cookie: second } });
  ok('...but one carrying the owner flag is', r.status === 200, String(r.status));
  r = await get('/api/admin/ai?email=friend@example.com', second);
  ok('...and may use the API', r.status === 200, String(r.status));
  ok('...no inline script and no email address in it', !/<script>/.test(html) && !/[\w.+-]+@[\w-]+\.[\w.]+/.test(html));
  r = await get('/api/admin/ai?email=friend@example.com', friend);
  ok('a non-owner cannot look anyone up (404, not advertised)', r.status === 404, String(r.status));
  r = await post('/api/admin/ai/grant', { uid, extraUsd: 5 }, friend);
  ok('a non-owner cannot grant (404)', r.status === 404, String(r.status));
  r = await post('/api/admin/ai/grant', { uid: uidOf('boss@example.com'), extraUsd: 5 });
  ok('an anonymous grant is refused', r.status === 404, String(r.status));

  /* ---- write rules ---- */
  r = await post('/api/admin/ai/grant', { uid, extraUsd: 5 }, admin, { 'sec-fetch-site': 'same-site' });
  ok('a grant from another page on the domain is refused (403)', r.status === 403, String(r.status));
  r = await fetch(B + '/api/admin/ai/grant', { method: 'POST', headers: { cookie: admin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'uid=' + uid + '&extraUsd=5' });
  ok('a form post is refused (JSON only)', r.status === 415, String(r.status));

  /* ---- look up ---- */
  r = await get('/api/admin/ai?email=Friend@Example.com', admin);
  let d = await r.json();
  ok('the owner finds a person by email', r.status === 200 && d.person.uid === uid && d.person.email === 'friend@example.com', JSON.stringify(d).slice(0, 200));
  ok('...with budget and no grant', d.person.budget && near(d.person.budget.allowanceUsd, 2) && d.person.aiGrant === null && d.person.grantActive === false);
  r = await get('/api/admin/ai?email=nobody@example.com', admin);
  ok('an unknown address is a 404', r.status === 404);

  /* ---- grant ---- */
  r = await post('/api/admin/ai/grant', { uid, extraUsd: 'lots' }, admin);
  ok('a bad amount is a 400', r.status === 400, String(r.status));
  r = await post('/api/admin/ai/grant', { uid, extraUsd: 0 }, admin);
  ok('an empty grant is a 400', r.status === 400, String(r.status));
  r = await post('/api/admin/ai/grant', { uid, until: '2001-01-01', extraUsd: 5 }, admin);
  ok('an end date in the past is a 400', r.status === 400, String(r.status));
  r = await post('/api/admin/ai/grant', { uid, perMinute: 50, perDay: 10 }, admin);
  ok('per day under per minute is a 400', r.status === 400, String(r.status));
  const until = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  r = await post('/api/admin/ai/grant', { uid, extraUsd: 20, perMinute: 20, perDay: 200, until, note: 'beta tester <b>' }, admin);
  d = await r.json();
  ok('the owner grants +$20 and 20/min, 200/day until a date', r.status === 200 && d.person.grantActive, JSON.stringify(d).slice(0, 300));
  let rec = users().get('users/' + uid);
  ok('the grant lands on the user record', rec.aiGrant && rec.aiGrant.extraUsd === 20 && rec.aiGrant.perMinute === 20 && rec.aiGrant.perDay === 200, JSON.stringify(rec.aiGrant));
  ok('...ending at the end of that day UTC, with who and when', rec.aiGrant.until === until + 'T23:59:59.999Z' && /^uid:/.test(rec.aiGrant.by) && rec.aiGrant.at);
  ok('...and a note with no markup', rec.aiGrant.note === 'beta tester  b', JSON.stringify(rec.aiGrant.note));
  ok('the budget now shows it as granted, not bought', near(d.person.budget.allowanceUsd, 22) && near(d.person.budget.grantedUsd, 20) && !d.person.budget.toppedUpUsd, JSON.stringify(d.person.budget));

  /* ---- the event log ---- */
  const events = () => [...users().entries()].filter(([k]) => k.startsWith('events/')).map(([, v]) => v);
  let ev = events().filter((e) => e.kind === 'ai.grant');
  ok('the grant is in the identity event log', ev.length === 1 && ev[0].detail.includes('uid:' + uid) && /\+\$20\.00 20\/min 200\/day until /.test(ev[0].detail), JSON.stringify(ev));
  ok('...with who (the owner) and when', ev[0].email === 'boss@example.com' && ev[0].at && / by uid:/.test(ev[0].detail));

  /* ---- the budget and requireBudget honour it ---- */
  const idn = identityLib.create({ store: { get: async () => null, set: async () => {}, add: async () => {}, list: async () => [] }, secret: () => 'x'.repeat(20), app: 'test' });
  const verified = { id: uid, email: 'friend@example.com', emailVerifiedAt: '2026-11-01T00:00:00Z', createdAt: '2026-11-01T00:00:00Z', spentUsd: 3 };
  const gate = (user) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    idn.requireBudget({ user, baseUrl: '', get: () => '' }, res, () => resolve({ status: 'next' }));
  });
  let g = await gate(verified);
  ok('without a grant, $3 spent of $2 is refused (402)', g.status === 402, JSON.stringify(g));
  g = await gate({ ...verified, aiGrant: { extraUsd: 5 } });
  ok('with +$5 granted it goes through', g.status === 'next', JSON.stringify(g));
  g = await gate({ ...verified, aiGrant: { extraUsd: 5, until: '2026-01-01T00:00:00Z' } });
  ok('an expired grant counts for nothing, checked on read', g.status === 402, JSON.stringify(g));
  ok('budgetFor ignores an expired grant', identityLib.budgetFor({ ...verified, aiGrant: { extraUsd: 5, until: '2026-01-01T00:00:00Z' } }).grantedUsd === 0);
  ok('budgetFor caps a hand-edited grant', identityLib.budgetFor({ ...verified, aiGrant: { extraUsd: 1e9 } }).grantedUsd === identityLib.GRANT_MAX_USD);

  /* ---- the lab's ceiling ---- */
  r = await get('/api/admin/ai/lab', admin);
  d = await r.json();
  ok("the page shows the lab's month-to-date against each cap", d.ok && d.claude.capUsd === 25 && d.claude.monthUsd === 3.21 && d.gemini.monthUsd === null, JSON.stringify(d));
  r = await get('/api/admin/ai/lab', friend);
  ok('...to the owner only', r.status === 404);

  /* ---- revoke ---- */
  r = await post('/api/admin/ai/revoke', { uid }, friend);
  ok('a non-owner cannot revoke', r.status === 404);
  r = await post('/api/admin/ai/revoke', { uid }, admin);
  d = await r.json();
  rec = users().get('users/' + uid);
  ok('the owner revokes', r.status === 200 && !rec.aiGrant && d.person.grantActive === false && near(d.person.budget.allowanceUsd, 2), JSON.stringify(rec.aiGrant));
  ev = events().filter((e) => e.kind === 'ai.grant.revoked');
  ok('...and the revoke is logged with who', ev.length === 1 && ev[0].detail.includes('uid:' + uid) && ev[0].email === 'boss@example.com');

  /* ---- the dashboard shows grants ---- */
  await post('/api/admin/ai/grant', { uid, extraUsd: 5 }, admin);
  r = await get('/api/admin/insights', admin);
  const dash = await r.json();
  const row = dash.users && dash.users.list.find((u) => u.uid === uid);
  ok('the overview lists the grant and the granted part of the budget', row && row.aiGrant && near(row.budget.grantedUsd, 5), JSON.stringify(row && row.budget));

  console.log('\n' + pass + '/' + (pass + fail) + ' assertions passed');
  process.exit(fail ? 1 : 0);
})();
