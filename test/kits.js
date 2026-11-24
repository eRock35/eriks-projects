// Lab Kits, phase 1: the licence and delivery service (lib/kits.js).
//
// Booted on the in-memory store. Nothing leaves the process: Resend, the
// metadata server and Cloud Storage are faked at global.fetch, and Stripe is
// only ever a signed body this file makes itself.
//
// - The webhook is shared/stripe.js's verifyWebhook, not a second signature
//   check: unsigned, wrongly signed and stale deliveries are refused.
// - One purchase is one licence and one mail, however often Stripe says so.
// - The store holds the key's hash, never the key. The mail holds the
//   buyer's own key and link and no other secret, and is never From the
//   newsletter address.
// - A full refund revokes; a partial one does not. A revoked key fails the
//   check and its download link stops working at once.
// - Renewal: setup works after updates lapse, --update does not; a paid
//   renewal adds a year, once per invoice; a cancelled one takes nothing away.
// - Download links expire, cannot be altered, and say "unavailable" cleanly
//   with no bucket.
// - Guessing is limited per address.
const h = require('./harness.js');
h.install();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = 9377;
const WHSEC = 'whsec_test_kits_signing_secret';
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'landing-secret-abcdefghijklm',
  ADMIN_PASSWORD: 'admin-password-here-1', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  RESEND_API_KEY: 're_test_not_real', NEWSLETTER_FROM: 'Erik <personal@example.com>',
  STRIPE_WEBHOOK_SECRET: WHSEC, KITS_SECRET: 'kits-test-secret-0123456789abcdefghij', KITS_BUCKET: 'kits-test-bucket',
  PORT: String(PORT),
});
delete process.env.FIRESTORE_DATABASE_ID;
delete process.env.SITE_ORIGIN;

const ZIP = Buffer.from('PK\u0003\u0004 not really a zip, but the bytes must arrive unchanged');
const sent = [];
const storageAsked = [];
let mailFails = false;
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.resend.com')) {
    if (mailFails) return new Response(JSON.stringify({ message: 'down' }), { status: 500 });
    sent.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: 'em_' + sent.length }), { status: 200 });
  }
  if (u.startsWith('http://metadata.google.internal/')) {
    if ((opts.headers || {})['Metadata-Flavor'] !== 'Google') return new Response('no', { status: 403 });
    return new Response(JSON.stringify({ access_token: 'ya29.fake', expires_in: 3600 }), { status: 200 });
  }
  if (u.startsWith('https://storage.googleapis.com/')) {
    storageAsked.push({ url: u, auth: (opts.headers || {}).Authorization });
    if (!/\/o\/app-stack%2F(kit|scripts)\.zip\?alt=media$/.test(u)) return new Response('{}', { status: 404 });
    return new Response(ZIP, { status: 200, headers: { 'content-length': String(ZIP.length) } });
  }
  if (u.startsWith('http://127.0.0.1:')) return realFetch(url, opts);
  throw new Error('test tried to reach ' + u);
};

require(path.join(__dirname, '..', 'server.js'));
const db = require('../lib/store').store();
const kits = require('../lib/kits');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };
const base = 'http://127.0.0.1:' + PORT;

let evN = 0;
function sign(body, { secret = WHSEC, at = Math.floor(Date.now() / 1000) } = {}) {
  return `t=${at},v1=${crypto.createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;
}
async function hook(type, object, { id, signature, raw } = {}) {
  const body = raw || JSON.stringify({ id: id || `evt_test_${++evN}`, type, livemode: false, data: { object } });
  const r = await realFetch(base + '/api/kits/stripe/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature === undefined ? sign(body) : signature }, body,
  });
  return { status: r.status, body: await r.json() };
}
let ipN = 0;
const freshIp = () => `198.51.100.${(ipN++ % 250) + 1}`;
async function post(pathname, body, ip) {
  const r = await realFetch(base + pathname, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip || freshIp() }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json(), headers: r.headers };
}
const check = (key, kit, purpose, ip) => post('/api/kits/license/check', { key, kit, purpose }, ip);

let sessN = 0;
function session(over = {}) {
  const n = ++sessN;
  return Object.assign({
    id: `cs_test_${n}`, object: 'checkout.session', mode: 'payment', payment_status: 'paid', livemode: false,
    payment_intent: `pi_test_${n}`, customer: `cus_test_${n}`, customer_details: { email: `Buyer${n}@Example.com` },
    metadata: { kind: 'kit', kit: 'app-stack', tier: 'kit' },
  }, over);
}
const licenses = () => db.list(kits.LICENSES);
const keyIn = (mail) => (/lk_[a-z2-7]{32}/.exec(mail.text) || [])[0];
const linkIn = (mail) => (/https:\/\/strongtechnicalconsulting\.com\/kits\/download\?t=[^\s"<]+/.exec(mail.text) || [])[0];
const local = (url) => base + new URL(url).pathname + new URL(url).search;

(async () => {
  for (let i = 0; i < 60; i++) { try { await realFetch(base + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  /* ---------- the signature check is the shared one ---------- */
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kits.js'), 'utf8');
  ok('lib/kits.js verifies with shared/stripe.js verifyWebhook', /require\('\.\.\/shared\/stripe'\)/.test(src) && /stripe\.verifyWebhook\(rawBody, signature\)/.test(src));
  ok('...and has no signature parsing of its own', !/v1=|Stripe-Signature.*split|TOLERANCE/.test(src));
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('the webhook is mounted above the JSON body parser', serverSrc.indexOf('kits.mountWebhook(') > 0 && serverSrc.indexOf('kits.mountWebhook(') < serverSrc.indexOf('const jsonBody = express.json'));

  let r = await hook('checkout.session.completed', session(), { signature: '' });
  ok('no signature: refused', r.status === 400, r.status);
  let body = JSON.stringify({ id: 'evt_forged', type: 'checkout.session.completed', data: { object: session() } });
  r = await hook(null, null, { raw: body, signature: sign(body, { secret: 'whsec_someone_else' }) });
  ok('signed with another secret: refused', r.status === 400, r.status);
  r = await hook(null, null, { raw: body, signature: sign(body, { at: Math.floor(Date.now() / 1000) - 3600 }) });
  ok('an hour-old signature: refused', r.status === 400, r.status);
  r = await hook(null, null, { raw: body, signature: sign(body + ' ') });
  ok('a body changed after signing: refused', r.status === 400, r.status);
  ok('...and none of those issued or mailed anything', (await licenses()).length === 0 && sent.length === 0);

  /* ---------- events that are not a kit's ---------- */
  r = await hook('checkout.session.completed', session({ metadata: { uid: 'u_1', kind: 'membership' }, mode: 'subscription', subscription: 'sub_m' }));
  ok('a membership checkout is acknowledged and ignored', r.status === 200 && (await licenses()).length === 0 && sent.length === 0);
  r = await hook('checkout.session.completed', session({ metadata: { kind: 'kit', kit: 'not-a-kit', tier: 'kit' } }));
  ok('an unknown kit issues nothing', r.status === 200 && (await licenses()).length === 0);
  r = await hook('checkout.session.completed', session({ metadata: { kind: 'kit', kit: 'app-stack', tier: 'hosted' } }));
  ok('a tier that is not sold here issues nothing', r.status === 200 && (await licenses()).length === 0);
  r = await hook('charge.refunded', { id: 'ch_other', payment_intent: 'pi_somebody_else', refunded: true });
  ok('a refund of something else is acknowledged', r.status === 200);

  /* ---------- a purchase ---------- */
  const s1 = session({ customer_details: { email: 'Buyer1@Example.com' } });
  r = await hook('checkout.session.completed', s1, { id: 'evt_buy_1' });
  let all = await licenses();
  ok('a paid checkout issues one licence', r.status === 200 && all.length === 1, `${r.status} ${all.length}`);
  const L = all[0];
  ok('...for that kit and tier, active, to the buyer\'s address in lower case', L.kit === 'app-stack' && L.tier === 'kit' && L.status === 'active' && L.email === 'buyer1@example.com');
  const months = (Date.parse(L.updatesUntil) - Date.now()) / (30.44 * 86400000);
  ok('...with twelve months of updates', months > 11.9 && months < 12.1, months);
  ok('...and its Stripe ids', L.stripeSessionId === s1.id && L.stripePaymentIntent === s1.payment_intent && L.stripeCustomerId === s1.customer && L.createdAt && L.refundedAt === null);
  ok('one mail went to the buyer', sent.length === 1 && sent[0].to.length === 1 && sent[0].to[0] === 'buyer1@example.com');
  const mail = sent[0];
  const key = keyIn(mail);
  ok('...carrying a licence key', Boolean(key) && mail.html.includes(key));
  ok('...From the account address, never the newsletter one, with no reply-to', /accounts@strongtechnicalconsulting\.com/.test(mail.from) && !/personal@example\.com/.test(JSON.stringify(mail)) && !('reply_to' in mail));
  ok('the store keeps the key\'s hash, not the key', L.id === 'lic_' + kits.hashKey(key).slice(0, 20) && L.keyHash === kits.hashKey(key) && !JSON.stringify(all).includes(key));
  ok('...and the event record does not hold it either', !JSON.stringify(await db.list(kits.EVENTS)).includes(key));
  const whole = mail.text + mail.html + mail.subject;
  ok('the mail holds no secret but the buyer\'s own key and link', !whole.includes(process.env.KITS_SECRET) && !whole.includes(WHSEC) && !whole.includes('re_test_not_real') && !whole.includes(L.keyHash) && !whole.includes('pi_test') && !whole.includes('cs_test'));
  ok('...says what the refund policy and the update terms are', /Refunds: 14 days, no questions/.test(mail.text) && /--update/.test(mail.text) && /--doctor/.test(mail.text));
  const link = linkIn(mail);
  ok('...and has a download link on this site that names its lifetime', Boolean(link) && /works for 48 hours/.test(mail.text));

  /* ---------- idempotency ---------- */
  r = await hook('checkout.session.completed', s1, { id: 'evt_buy_1' });
  ok('the same event again: acknowledged as a duplicate', r.status === 200 && r.body.duplicate === true);
  r = await hook('checkout.session.completed', s1, { id: 'evt_buy_1_twin' });
  ok('a second event for the same purchase: still one licence, one mail', r.status === 200 && (await licenses()).length === 1 && sent.length === 1, sent.length);
  await db.set(kits.EVENTS, 'evt_busy', { type: 'x', state: 'applying', claimedAt: new Date().toISOString() });
  r = await hook('checkout.session.completed', session(), { id: 'evt_busy' });
  ok('an event another delivery is applying: come back later, nothing issued', r.status === 409 && (await licenses()).length === 1);
  await db.set(kits.EVENTS, 'evt_stale', { type: 'x', state: 'applying', claimedAt: new Date(Date.now() - 5 * 60000).toISOString() });
  r = await hook('checkout.session.completed', session({ metadata: { kind: 'kit', kit: 'chief-of-staff', tier: 'scripts' } }), { id: 'evt_stale' });
  ok('a claim left two minutes ago is taken over', r.status === 200 && (await licenses()).length === 2 && sent.length === 2);
  const scriptsKey = keyIn(sent[1]);
  ok('the scripts tier has no updates, and its mail says so', (await db.get(kits.LICENSES, kits.hashKey(scriptsKey))).updatesUntil === null && /does not include updates/.test(sent[1].text));

  /* ---------- paying later, and a mail that fails ---------- */
  const slow = session({ payment_status: 'unpaid' });
  r = await hook('checkout.session.completed', slow);
  ok('completed but unpaid: nothing issued', r.status === 200 && (await licenses()).length === 2);
  r = await hook('checkout.session.async_payment_succeeded', Object.assign({}, slow, { payment_status: 'paid' }));
  ok('...issued when the payment lands', r.status === 200 && (await licenses()).length === 3 && sent.length === 3);

  mailFails = true;
  const s4 = session();
  r = await hook('checkout.session.completed', s4, { id: 'evt_mail_down' });
  ok('the mail provider is down: 500, so Stripe sends it again', r.status === 500, r.status);
  const stuck = await db.get(kits.LICENSES, kits.hashKey(kits.keyFor(s4.id)));
  ok('...the licence exists, undelivered, and the claim was released', stuck && stuck.deliveredAt === null && Boolean(stuck.deliveryError) && (await db.get(kits.EVENTS, 'evt_mail_down')) === null);
  mailFails = false;
  r = await hook('checkout.session.completed', s4, { id: 'evt_mail_down' });
  ok('the retry delivers, with the same key and still one licence for it', r.status === 200 && sent.length === 4 && keyIn(sent[3]) === kits.keyFor(s4.id) && (await licenses()).length === 4);
  ok('...and is recorded as delivered', Boolean((await db.get(kits.LICENSES, kits.hashKey(kits.keyFor(s4.id)))).deliveredAt));

  /* ---------- the installer's question ---------- */
  r = await check(key, 'app-stack', 'setup');
  ok('setup with a good key', r.status === 200 && r.body.ok === true && r.body.tier === 'kit' && r.body.updatesUntil === L.updatesUntil && r.body.updatesActive === true, JSON.stringify(r.body));
  ok('...answered no-store and noindex', /no-store/.test(r.headers.get('cache-control')) && /noindex/.test(r.headers.get('x-robots-tag')));
  r = await check(key, 'app-stack', 'update');
  ok('update with a good key', r.status === 200 && r.body.ok === true);
  ok('the answer is the licence and nothing about the buyer', !('email' in r.body) && !JSON.stringify(r.body).includes('buyer1') && !JSON.stringify(r.body).includes('pi_test'));
  r = await check(key, 'chief-of-staff', 'setup');
  ok('a key for another kit: invalid', r.status === 403 && r.body.ok === false && r.body.reason === 'invalid');
  const wrong = await check('lk_' + 'a'.repeat(32), 'app-stack', 'setup');
  ok('an unknown key answers exactly the same', wrong.status === 403 && JSON.stringify(wrong.body) === JSON.stringify(r.body));
  for (const bad of ['', 'lk_short', key.toUpperCase(), key + 'a', { $ne: 1 }, null]) {
    r = await check(bad, 'app-stack', 'setup');
    if (!(r.status === 403 && r.body.reason === 'invalid')) ok('a malformed key is invalid: ' + JSON.stringify(bad), false, JSON.stringify(r.body));
  }
  ok('malformed keys are invalid, never an error', true);
  r = await check(key, 'app-stack', 'whatever');
  ok('a purpose that is neither setup nor update: 400', r.status === 400);
  r = await check(key, '__proto__', 'setup');
  ok('a kit name that is not a kit: invalid', r.status === 403 && r.body.reason === 'invalid');

  /* ---------- updates lapse ---------- */
  await db.update(kits.LICENSES, L.keyHash, { updatesUntil: new Date(Date.now() - 86400000).toISOString() });
  r = await check(key, 'app-stack', 'setup');
  ok('after updates lapse, setup still works', r.status === 200 && r.body.ok === true && r.body.updatesActive === false);
  r = await check(key, 'app-stack', 'update');
  ok('...and only --update stops, pointing at the renewal', r.status === 403 && r.body.reason === 'updates-lapsed' && r.body.tier === 'kit' && r.body.renew === 'https://strongtechnicalconsulting.com/kits/app-stack#renew', JSON.stringify(r.body));
  r = await check(scriptsKey, 'chief-of-staff', 'update');
  ok('the scripts tier never has --update', r.status === 403 && r.body.reason === 'updates-lapsed');
  r = await check(scriptsKey, 'chief-of-staff', 'setup');
  ok('...but sets up', r.status === 200 && r.body.tier === 'scripts');

  /* ---------- renewal ---------- */
  const ren = (over) => session(Object.assign({ mode: 'subscription', payment_intent: null, subscription: 'sub_ren_1', customer_details: { email: 'BUYER1@example.com' }, metadata: { kind: 'kit', kit: 'app-stack', tier: 'renewal' } }, over));
  r = await hook('checkout.session.completed', ren({ subscription: 'sub_stranger', customer_details: { email: 'nobody@example.com' } }));
  ok('a renewal paid from an address with no licence changes nothing', r.status === 200 && !(await licenses()).some((l) => l.stripeSubscriptionId === 'sub_stranger'));
  r = await hook('checkout.session.completed', ren({ subscription: 'sub_wrongkit', metadata: { kind: 'kit', kit: 'chief-of-staff', tier: 'renewal' } }));
  ok('...nor one for a kit that address does not own', r.status === 200 && !(await licenses()).some((l) => l.stripeSubscriptionId === 'sub_wrongkit'));
  const mailsBefore = sent.length;
  r = await hook('checkout.session.completed', ren());
  let R = await db.get(kits.LICENSES, L.keyHash);
  let m = (Date.parse(R.updatesUntil) - Date.now()) / (30.44 * 86400000);
  ok('a paid renewal finds the licence by address and adds a year from today', r.status === 200 && R.stripeSubscriptionId === 'sub_ren_1' && m > 11.9 && m < 12.1, m);
  ok('...issues no second licence and sends no second key', (await licenses()).length === 4 && sent.length === mailsBefore);
  r = await check(key, 'app-stack', 'update');
  ok('...and --update works again', r.status === 200 && r.body.ok === true);
  r = await hook('checkout.session.completed', ren({ id: 'cs_test_again' }));
  ok('the same subscription cannot be counted twice', (await db.get(kits.LICENSES, L.keyHash)).updatesUntil === R.updatesUntil);

  r = await hook('invoice.paid', { id: 'in_first', billing_reason: 'subscription_create', subscription: 'sub_ren_1' });
  ok('the first invoice adds nothing (the checkout already gave that year)', (await db.get(kits.LICENSES, L.keyHash)).updatesUntil === R.updatesUntil);
  r = await hook('customer.subscription.updated', { id: 'sub_ren_1', status: 'active', cancel_at_period_end: false, items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 5 * 365 * 86400 }] } });
  ok('a subscription rolling its period forward adds nothing: only a paid invoice does', (await db.get(kits.LICENSES, L.keyHash)).updatesUntil === R.updatesUntil);
  r = await hook('invoice.paid', { id: 'in_year2', billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_ren_1' } } });
  let R2 = await db.get(kits.LICENSES, L.keyHash);
  m = (Date.parse(R2.updatesUntil) - Date.parse(R.updatesUntil)) / (30.44 * 86400000);
  ok('a paid renewal invoice adds a year on top', r.status === 200 && m > 11.9 && m < 12.1, m);
  r = await hook('invoice.paid', { id: 'in_year2', billing_reason: 'subscription_cycle', subscription: 'sub_ren_1' });
  ok('...once per invoice, even as a new event', (await db.get(kits.LICENSES, L.keyHash)).updatesUntil === R2.updatesUntil);
  r = await hook('customer.subscription.deleted', { id: 'sub_ren_1', status: 'canceled' });
  R = await db.get(kits.LICENSES, L.keyHash);
  ok('a cancelled renewal is recorded and takes nothing away', r.status === 200 && R.subscriptionStatus === 'canceled' && R.status === 'active' && R.updatesUntil === R2.updatesUntil);

  /* ---------- downloads ---------- */
  let d = await realFetch(local(link));
  let bytes = Buffer.from(await d.arrayBuffer());
  ok('the mailed link downloads the archive, byte for byte', d.status === 200 && bytes.equals(ZIP) && d.headers.get('content-type') === 'application/zip' && /attachment; filename="app-stack-kit\.zip"/.test(d.headers.get('content-disposition')), d.status);
  ok('...read from the private bucket with the runtime identity', storageAsked.length === 1 && storageAsked[0].url.includes('/b/kits-test-bucket/o/app-stack%2Fkit.zip') && storageAsked[0].auth === 'Bearer ya29.fake');
  ok('...and is not cached or indexed', /no-store/.test(d.headers.get('cache-control')) && /noindex/.test(d.headers.get('x-robots-tag')) && d.headers.get('referrer-policy') === 'no-referrer');
  const t = new URL(link).searchParams.get('t');
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'a' ? 'b' : 'a') + s.slice(i + 1);
  const otherId = (await licenses()).find((l) => l.id !== L.id).id;
  for (const [name, bad] of [
    ['a changed signature', flip(t, t.length - 2)],
    ['a later expiry', t.replace(/\.(\d+)\./, (_, e) => `.${Number(e) + 99999}.`)],
    ['another licence\'s id', t.replace(L.id, otherId)],
    ['an expired one', kits.makeDownloadToken(L.id, -5)],
    ['a token signed with another secret', (() => { const keep = process.env.KITS_SECRET; process.env.KITS_SECRET = 'another-secret-another-secret-another!'; const x = kits.makeDownloadToken(L.id, 600); process.env.KITS_SECRET = keep; return x; })()],
    ['junk', 'lic_x.1.y'],
  ]) {
    d = await realFetch(base + '/kits/download?t=' + encodeURIComponent(bad));
    const page = await d.text();
    ok(`a link with ${name} downloads nothing`, d.status === 410 && !page.includes('PK') && /expired or is no longer valid/.test(page), d.status);
  }
  ok('...and the bucket was never asked for those', storageAsked.length === 1);

  r = await post('/api/kits/license/download', { key, kit: 'app-stack' });
  ok('a key gets a fresh link, good for fifteen minutes', r.status === 200 && r.body.ok && /\/kits\/download\?t=/.test(r.body.url) && Math.abs(Date.parse(r.body.expiresAt) - Date.now() - 15 * 60000) < 5000);
  d = await realFetch(local(r.body.url));
  ok('...which downloads', d.status === 200 && Buffer.from(await d.arrayBuffer()).equals(ZIP));
  d = await realFetch(base + '/kits/download', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': freshIp() }, body: `kit=app-stack&key=${encodeURIComponent('  ' + key.toUpperCase() + ' ')}` });
  ok('the download page\'s form sends a person to a fresh link', d.status === 303 && /^\/kits\/download\?t=/.test(d.headers.get('location') || ''), d.status);
  d = await realFetch(base + '/kits/download', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': freshIp() }, body: 'kit=app-stack&key=lk_' + 'b'.repeat(32) });
  ok('...and a wrong key back to the form, told so', d.status === 403 && /do not match a license/.test(await d.text()));
  r = await post('/api/kits/license/download', { key: scriptsKey, kit: 'chief-of-staff' });
  ok('a new purchase with no updates can still fetch its archive', r.status === 200);
  await db.update(kits.LICENSES, kits.hashKey(scriptsKey), { createdAt: new Date(Date.now() - 40 * 86400000).toISOString() });
  r = await post('/api/kits/license/download', { key: scriptsKey, kit: 'chief-of-staff' });
  ok('...but not a month on, with no updates running', r.status === 403 && r.body.reason === 'updates-lapsed');
  d = await realFetch(local(linkIn(sent[1])));
  ok('an archive that is not in the bucket: unavailable, not an error page', d.status === 503 && /unavailable right now/.test(await d.text()));

  // No bucket configured.
  delete process.env.KITS_BUCKET;
  r = await post('/api/kits/license/download', { key, kit: 'app-stack' });
  ok('no bucket: the link route says downloads are unavailable', r.status === 503 && r.body.reason === 'downloads-unavailable');
  d = await realFetch(local(link));
  ok('...and so does an old link', d.status === 503 && /unavailable right now/.test(await d.text()));
  r = await hook('checkout.session.completed', session());
  const noLink = sent[sent.length - 1];
  ok('...and a purchase still gets its key, with the way to fetch the kit later', r.status === 200 && Boolean(keyIn(noLink)) && !linkIn(noLink) && /not available at this moment/.test(noLink.text) && /\/kits\/download/.test(noLink.text));
  r = await check(keyIn(noLink), 'app-stack', 'setup');
  ok('...and the key works', r.status === 200);
  process.env.KITS_BUCKET = 'kits-test-bucket';

  /* ---------- refunds ---------- */
  r = await hook('charge.refunded', { id: 'ch_1', payment_intent: s1.payment_intent, refunded: false, amount_refunded: 500 });
  ok('a partial refund leaves the licence standing', r.status === 200 && (await db.get(kits.LICENSES, L.keyHash)).status === 'active');
  r = await hook('charge.refunded', { id: 'ch_1', payment_intent: s1.payment_intent, refunded: true }, { id: 'evt_refund_1' });
  R = await db.get(kits.LICENSES, L.keyHash);
  ok('a full refund revokes it', r.status === 200 && R.status === 'revoked' && R.revokedReason === 'refund' && Boolean(R.refundedAt));
  for (const purpose of ['setup', 'update']) {
    r = await check(key, 'app-stack', purpose);
    ok(`a revoked key fails ${purpose}`, r.status === 403 && r.body.ok === false && r.body.reason === 'revoked');
  }
  const asked = storageAsked.length;
  d = await realFetch(local(link));
  ok('its download link stops working at once', d.status === 410 && storageAsked.length === asked);
  r = await post('/api/kits/license/download', { key, kit: 'app-stack' });
  ok('...and it cannot get a new one', r.status === 403 && r.body.reason === 'revoked');
  r = await hook('charge.refunded', { id: 'ch_1', payment_intent: s1.payment_intent, refunded: true }, { id: 'evt_refund_1' });
  ok('the refund event again is a duplicate', r.status === 200 && r.body.duplicate === true);
  r = await hook('checkout.session.completed', s1, { id: 'evt_buy_1_late' });
  ok('a late copy of the purchase does not bring it back or mail again', (await db.get(kits.LICENSES, L.keyHash)).status === 'revoked' && sent.length === mailsBefore + 1);
  r = await hook('invoice.paid', { id: 'in_year3', billing_reason: 'subscription_cycle', subscription: 'sub_ren_1' });
  ok('...and a renewal invoice does not extend a revoked licence', (await db.get(kits.LICENSES, L.keyHash)).updatesUntil === R.updatesUntil);
  r = await hook('charge.dispute.created', { id: 'dp_1', payment_intent: s4.payment_intent });
  ok('a dispute revokes too', (await db.get(kits.LICENSES, kits.hashKey(kits.keyFor(s4.id)))).revokedReason === 'dispute');

  /* ---------- guessing ---------- */
  const guesser = '203.0.113.77';
  let last;
  for (let i = 0; i < 10; i++) last = await check('lk_' + B(i), 'app-stack', 'setup', guesser);
  ok('ten wrong keys from one address are each just invalid', last.status === 403 && last.body.reason === 'invalid');
  last = await check(scriptsKey, 'chief-of-staff', 'setup', guesser);
  ok('...then that address is limited, even with a good key', last.status === 429 && last.body.reason === 'rate-limited' && last.headers.get('retry-after') === '900');
  last = await post('/api/kits/license/download', { key: scriptsKey, kit: 'chief-of-staff' }, guesser);
  ok('...on the link route as well', last.status === 429);
  d = await realFetch(base + '/kits/download', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': guesser }, body: 'kit=chief-of-staff&key=' + scriptsKey });
  ok('...and on the form', d.status === 429 && /Too many tries/.test(await d.text()));
  r = await check(scriptsKey, 'chief-of-staff', 'setup');
  ok('another address is not affected', r.status === 200);
  const busy = '203.0.113.78';
  for (let i = 0; i < 60; i++) last = await check(scriptsKey, 'chief-of-staff', 'setup', busy);
  ok('sixty good checks in a quarter of an hour are fine', last.status === 200);
  last = await check(scriptsKey, 'chief-of-staff', 'setup', busy);
  ok('...the sixty-first is limited', last.status === 429);
  const lim = kits.limiter(2, 1000);
  ok('the limiter forgets after its window', lim.take('a', 0) && lim.take('a', 10) && !lim.take('a', 20) && lim.take('a', 2000));

  /* ---------- not configured ---------- */
  const keep = process.env.KITS_SECRET;
  process.env.KITS_SECRET = 'too-short';
  r = await check(scriptsKey, 'chief-of-staff', 'setup');
  ok('without KITS_SECRET the check is unavailable, not wrong', r.status === 503 && r.body.ok === false);
  r = await hook('checkout.session.completed', session(), { id: 'evt_unconfigured' });
  ok('...and a purchase is a 503, so Stripe keeps it for later', r.status === 503 && (await db.get(kits.EVENTS, 'evt_unconfigured')) === null);
  process.env.KITS_SECRET = keep;
  r = await hook('checkout.session.completed', session(), { id: 'evt_unconfigured' });
  ok('...which then applies', r.status === 200);
  delete process.env.STRIPE_WEBHOOK_SECRET;
  r = await hook('checkout.session.completed', session());
  ok('without a signing secret nothing is accepted', r.status === 500);
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;

  /* ---------- keys ---------- */
  ok('a key is lk_ and 32 base32 characters, the same for the same purchase', /^lk_[a-z2-7]{32}$/.test(kits.keyFor('cs_a')) && kits.keyFor('cs_a') === kits.keyFor('cs_a') && kits.keyFor('cs_a') !== kits.keyFor('cs_b'));
  process.env.KITS_SECRET = 'another-secret-another-secret-another!';
  const elsewhere = kits.keyFor('cs_a');
  process.env.KITS_SECRET = keep;
  ok('...and cannot be made without the secret', elsewhere !== kits.keyFor('cs_a'));
  ok('month arithmetic does not overshoot a short month', kits.addMonths(Date.UTC(2027, 0, 31), 1).toISOString().slice(0, 10) === '2027-02-28' && kits.addMonths(Date.UTC(2026, 10, 24), 12).toISOString().slice(0, 10) === '2027-11-24');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

function B(i) { return 'abcdefghijklmnopqrstuvwxyz234567'[i].repeat(32); }
