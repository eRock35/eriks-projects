// Keeping Erik's address away from bots, and the signup form from being used
// to make this domain mail strangers (2026-09-27).
//
// - No page the site serves carries an email address or a mailto: link; the
//   address is built by /contact.js only when someone clicks.
// - The newsletter form's bot traps answer exactly like a real signup, and
//   send nothing: a hidden field filled, a form submitted within two seconds
//   of being drawn, the same address again within six hours, and more than
//   40 confirmations an hour.
//
// Booted on the in-memory store. Resend is faked at global.fetch, so every
// confirmation the server tries to send is counted.
const h = require('./harness.js');
h.install();
const path = require('path');
const vm = require('vm');
const fs = require('fs');

const PORT = 8311;
process.env.IDENTITY_SESSION_SECRET = 'identity-secret-abcdefghijklmn';
process.env.SESSION_SECRET = 'landing-secret-abcdefghijklm';
process.env.ADMIN_PASSWORD = 'admin-password-here-1';
delete process.env.FIRESTORE_DATABASE_ID;
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.RESEND_API_KEY = 're_test_not_real';
process.env.NEWSLETTER_FROM = 'Test <news@example.com>';
process.env.PORT = String(PORT);

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
const db = require('../lib/store').store();
const tokens = require('../lib/tokens');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const base = 'http://127.0.0.1:' + PORT;
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
let ipN = 0;
const subscribe = (body, ip) => realFetch(base + '/api/subscribe', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': ip || `203.0.113.${(ipN++ % 250) + 1}` },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const later = () => Date.now() - 5000;
const DONE = 'Check your inbox to confirm.';

(async () => {
  for (let i = 0; i < 60; i++) { try { await realFetch(base + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  /* ---------- no address in any page ---------- */
  // /account draws the (masked) address in the browser, never in the page (2026-09-27).
  for (const p of ['/', '/privacy', '/terms', '/writing', '/challenge', '/account']) {
    const r = await realFetch(base + p);
    const html = await r.text();
    const found = (html.match(ADDRESS) || []).filter((a) => !/example\.com$/.test(a) && !/^[^@]*@\d/.test(a) && !a.endsWith('.png') && !a.endsWith('.jpg'));
    ok(`${p} carries no email address`, r.status === 200 && found.length === 0, `${r.status} ${found.join(', ')}`);
    ok(`${p} carries no mailto: link`, !/mailto:/i.test(html));
  }
  const js = await (await realFetch(base + '/contact.js')).text();
  ok('/contact.js is served', /data-contact/.test(js));
  ok('...and the address is not written in it', !(js.match(ADDRESS) || []).length && !/strongtechnicalconsulting\.com/.test(js));

  // Run contact.js against a stand-in page and click an Email link.
  let listener = null;
  const show = { textContent: 'Tap to email Erik' };
  const link = { closest: (sel) => (sel === '[data-contact]' ? link : null), querySelector: () => show, hasAttribute: () => false };
  const win = { location: { href: '' } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'site', 'contact.js'), 'utf8'), {
    window: win, String,
    document: { addEventListener: (type, fn) => { if (type === 'click') listener = fn; } },
  });
  let prevented = false;
  listener({ target: link, preventDefault: () => { prevented = true; } });
  ok('a click opens a mailto: at the site domain', /^mailto:[a-z.]+@strongtechnicalconsulting\.com$/.test(win.location.href), win.location.href.replace(/^mailto:[^@]+/, 'mailto:…'));
  ok('...shows the address for someone with no mail app', show.textContent === win.location.href.slice(7) && prevented, show.textContent);
  listener({ target: { closest: () => null }, preventDefault: () => { throw new Error('no'); } });
  ok('other clicks are left alone', true);

  /* ---------- the signup form's traps ---------- */
  const idOf = (a) => tokens.emailId(a);
  let r = await subscribe({ email: 'honeypot@example.com', website: 'http://spam.example', t: later() });
  ok('a filled hidden field gets the normal answer', r.status === 200 && r.body.message === DONE, JSON.stringify(r));
  ok('...sends nothing and stores nothing', sent.length === 0 && !(await db.get('subscribers', idOf('honeypot@example.com'))));

  r = await subscribe({ email: 'fast@example.com', website: '', t: Date.now() });
  ok('a form sent within two seconds gets the normal answer', r.status === 200 && r.body.message === DONE);
  ok('...sends nothing and stores nothing', sent.length === 0 && !(await db.get('subscribers', idOf('fast@example.com'))));

  r = await subscribe({ email: 'person@example.com', website: '', t: later() });
  ok('a person signs up', r.status === 200 && r.body.message === DONE && sent.length === 1 && sent[0].to[0] === 'person@example.com', JSON.stringify(r));
  const doc = await db.get('subscribers', idOf('person@example.com'));
  ok('...pending, with when the confirmation went', doc && doc.status === 'pending' && !!doc.lastSentAt);

  r = await subscribe({ email: 'person@example.com', website: '', t: later() });
  ok('the same address again within six hours: normal answer, no second email', r.status === 200 && r.body.message === DONE && sent.length === 1);

  await db.set('subscribers', idOf('person@example.com'), { ...doc, lastSentAt: new Date(Date.now() - 7 * 3600e3).toISOString() });
  r = await subscribe({ email: 'person@example.com', t: later() });
  ok('...and after six hours it may be sent again', r.status === 200 && sent.length === 2);

  r = await subscribe({ email: 'nojs@example.com' });
  ok('a form posted without JavaScript (no t) still works', r.status === 200 && sent.length === 3);

  const ip = '198.51.100.7';
  for (let i = 0; i < 5; i++) await subscribe({ email: `same-ip-${i}@example.com`, t: later() }, ip);
  r = await subscribe({ email: 'same-ip-6@example.com', t: later() }, ip);
  ok('one IP sending many signups is still limited', r.status === 429);
  // `trust proxy` is one hop (2026-09-27): the address is the RIGHTMOST
  // X-Forwarded-For entry, the one Cloud Run's front end appends. Writing a
  // different address in front of it used to reset the limit every time.
  r = await subscribe({ email: 'same-ip-7@example.com', t: later() }, `10.9.8.7, ${ip}`);
  ok('...and a forged address in front of it does not get round the limit', r.status === 429, String(r.status));

  /* ---------- the admin probe route carries no address ---------- */
  const probe = await realFetch(base + '/api/admin/me');
  const probeText = await probe.text();
  ok('/api/admin/me answers signed out', probe.status === 200, String(probe.status));
  ok('...without the sending address', !(probeText.match(ADDRESS) || []).length && !/"from"/.test(probeText), probeText);
  const adminCookie = (await realFetch(base + '/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'admin-password-here-1' }),
  })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const asAdmin = await (await realFetch(base + '/api/admin/me', { headers: { cookie: adminCookie } })).json();
  ok('...while the admin still sees it', asAdmin.signedIn === true && asAdmin.email && asAdmin.email.from === 'Test <news@example.com>', JSON.stringify(asAdmin.email));

  // The hourly cap across all addresses: 40 confirmations, then a refusal
  // that sends nothing.
  const before = sent.length;
  let refused = null;
  for (let i = 0; i < 45 && !refused; i++) {
    const x = await subscribe({ email: `bulk-${i}@example.com`, t: later() });
    if (x.status === 429) refused = x;
  }
  ok('no more than 40 confirmations go out in an hour', sent.length <= 40 && sent.length - before >= 30, String(sent.length));
  ok('...past that, signups are refused with a plain sentence', refused && /busy/i.test(refused.body.error || ''), JSON.stringify(refused));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
