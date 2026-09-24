// End to end, against the memory store and the fake model:
//   SNAPQUOTE_MEMORY=1 SNAPQUOTE_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// Drives the real Express app over HTTP, the way the page does, so the auth
// cookie, the budget gate, every ownership check and the public quote link are
// exercised as deployed rather than as unit-tested pieces.

const assert = require('assert');
const http = require('http');
const express = require('express');

if (process.env.SNAPQUOTE_MEMORY !== '1' || process.env.SNAPQUOTE_FAKE_AI !== '1') {
  console.error('run with SNAPQUOTE_MEMORY=1 SNAPQUOTE_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const Q = require('../lib/quote');
const photos = require('../lib/photos');

let base;
function client() {
  let cookie = '';
  return async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, headers: res.headers };
  };
}

const uidOf = (email) => Buffer.from(email).toString('base64url');
const spentBy = async (email) => Number(((await identityStore.get('users', uidOf(email))) || {}).spentUsd || 0);

// Smallest things the sniffer accepts as a JPEG and a PNG. The fake model does
// not decode them; the server only checks what they are and how big.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]).toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500, 1)]).toString('base64');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- pure rules ---------------- */

test('markup applies to materials, not labor; discount, tax and cents are exact', () => {
  const items = [
    { description: 'Labor', category: 'labor', qty: 10, unit: 'hr', unitPrice: 75 },
    { description: 'Paint', category: 'material', qty: 3, unit: 'gal', unitPrice: 33.33 },
  ];
  const t = Q.totalsFor(items, { markupPct: 20, taxPct: 8.25, discount: 50 });
  // 750 labor + 3 x (33.33 x 1.2 = 40.00) = 870.00
  assert.strictEqual(t.subtotal, 870);
  assert.strictEqual(t.discount, 50);
  assert.strictEqual(t.tax, 67.65);
  assert.strictEqual(t.total, 887.65);
  assert.strictEqual(t.cost, 849.99);
  const huge = Q.totalsFor(items, { discount: 99999 });
  assert.strictEqual(huge.total, 0, 'a discount can never make a quote negative');
});

test('tiers: the base lines are in every option, each tier adds its own', () => {
  const q = {
    items: [{ description: 'Base', category: 'labor', qty: 1, unit: 'job', unitPrice: 100 }],
    tiers: [
      { key: 'good', label: 'Good', items: [] },
      { key: 'better', label: 'Better', items: [{ description: 'Extra', category: 'labor', qty: 1, unit: 'ea', unitPrice: 50 }] },
    ],
    markupPct: 0, taxPct: 0, discount: 0,
  };
  const t = Q.computeTotals(q);
  assert.strictEqual(t.tiers.good.total, 100);
  assert.strictEqual(t.tiers.better.total, 150);
  assert.strictEqual(Q.valueOf(q), 150, 'the middle option is the headline value');
});

test('model numbers are clamped: negatives, NaN, strings and absurd values', () => {
  const items = Q.cleanItems([
    { description: 'neg', category: 'material', qty: -4, unitPrice: -100 },
    { description: 'nan', category: 'bogus', qty: 'lots', unitPrice: 1e12 },
    { description: 'money string', category: 'labor', qty: '2', unitPrice: '$1,250.50' },
    { description: '', qty: 1, unitPrice: 1 },
    { description: '<b>bold</b>', qty: Infinity, unitPrice: NaN },
  ]);
  assert.strictEqual(items.length, 4, 'a line with no description is dropped');
  assert.strictEqual(items[0].qty, 0);
  assert.strictEqual(items[0].unitPrice, 0);
  assert.strictEqual(items[1].category, 'other');
  assert.strictEqual(items[1].qty, 1);
  assert.strictEqual(items[1].unitPrice, Q.LIMITS.unitPrice);
  assert.strictEqual(items[2].unitPrice, 1250.5);
  assert.strictEqual(items[3].description, 'bbold/b');
  assert.ok(Number.isFinite(items[3].qty) && Number.isFinite(items[3].unitPrice));
});

test('scoreboard: win rate over decided quotes, weekly streak, 8-week chart', () => {
  const nowT = Date.parse('2026-09-24T12:00:00Z'); // a Thursday
  const day = 86400000;
  const mk = (daysAgo, status, total, extra = {}) => ({
    status, createdAt: new Date(nowT - daysAgo * day - 30 * 60000).toISOString(),
    sentAt: status === 'draft' ? undefined : new Date(nowT - daysAgo * day).toISOString(),
    validUntil: new Date(nowT + 10 * day).toISOString(),
    items: [{ description: 'x', category: 'labor', qty: 1, unit: 'job', unitPrice: total }], markupPct: 0, taxPct: 0, discount: 0, ...extra,
  });
  const s = Q.stats([
    mk(1, 'accepted', 1000),
    mk(8, 'declined', 500),
    mk(15, 'viewed', 300, { validUntil: new Date(nowT - day).toISOString() }), // expired
    mk(2, 'sent', 700),
    mk(0, 'draft', 50),
  ], nowT);
  assert.strictEqual(s.won, 1);
  assert.strictEqual(s.decided, 3);
  assert.strictEqual(s.winRate, 33);
  assert.strictEqual(s.totalQuoted, 2500);
  assert.strictEqual(s.totalWon, 1000);
  assert.strictEqual(s.pipelineValue, 700, 'only open, unexpired quotes are pipeline');
  assert.strictEqual(s.avgMinutesToSend, 30);
  assert.strictEqual(s.streakWeeks, 3);
  assert.strictEqual(s.chart.length, 8);
  assert.strictEqual(s.chart[7].quoted, 1700);
  assert.strictEqual(s.chart[7].won, 1000);
  assert.strictEqual(s.byStatus.expired, 1);
});

test('photos: real JPEG/PNG pass; wrong types, lies and oversize are refused', () => {
  assert.strictEqual(photos.validate([{ type: 'image/jpeg', data: JPEG }])[0].mediaType, 'image/jpeg');
  assert.strictEqual(photos.validate([{ data: 'data:image/png;base64,' + PNG }])[0].mediaType, 'image/png');
  assert.throws(() => photos.validate([{ type: 'image/jpeg', data: Buffer.from('%PDF-1.7 hello').toString('base64') }]), /JPEG, PNG or WebP/);
  assert.throws(() => photos.validate([{ type: 'image/gif', data: JPEG }]), /JPEG, PNG or WebP/);
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(photos.MAX_BYTES + 10)]).toString('base64');
  assert.throws(() => photos.validate([{ type: 'image/jpeg', data: big }]), /too large/);
  assert.throws(() => photos.validate(new Array(5).fill({ type: 'image/jpeg', data: JPEG })), /Up to 4/);
});

test('profile cleaning: color, logo, percentages and email', () => {
  const p = Q.cleanProfile({ color: 'red', logo: 'abcd', taxPct: 99, markupPct: -5, email: 'nope', hourlyRate: '85' });
  assert.strictEqual(p.color, Q.PROFILE_DEFAULTS.color);
  assert.strictEqual(p.logo, 'ABC');
  assert.strictEqual(p.taxPct, 30);
  assert.strictEqual(p.markupPct, 0);
  assert.strictEqual(p.email, '');
  assert.strictEqual(p.hourlyRate, 85);
});

/* ---------------- over HTTP ---------------- */

test('health, meta and the sample quote are public and make no model call', async () => {
  const anon = client();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  assert.strictEqual((await anon('GET', '/api/health')).status, 200);
  assert.ok((await anon('GET', '/api/meta')).data.trades.painter);
  const d = await anon('GET', '/api/demo');
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.data.demo, true);
  assert.strictEqual(d.data.tiers.length, 3);
  assert.ok(d.data.tiers[1].totals.total > d.data.tiers[0].totals.total);
  assert.ok(Date.parse(d.data.validUntil) > Date.now(), 'the sample never reads as expired');
  assert.ok(!JSON.stringify(d.data).includes('"cost"'));
});

test('signed-out visitors cannot draft, list, save a profile or read stats', async () => {
  const anon = client();
  assert.strictEqual((await anon('POST', '/api/quotes/draft', { description: 'paint a room please' })).status, 401);
  assert.strictEqual((await anon('POST', '/api/quotes', {})).status, 401);
  assert.strictEqual((await anon('GET', '/api/quotes')).status, 401);
  assert.strictEqual((await anon('PUT', '/api/profile', { name: 'x' })).status, 401);
  assert.strictEqual((await anon('GET', '/api/stats')).status, 401);
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
});

let alice, bob, quoteId, token;

test('register and set up the business profile', async () => {
  alice = client();
  const reg = await alice('POST', '/api/auth/register', { email: 'alice@example.com', password: 'correct horse battery' });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.data));
  const me = await alice('GET', '/api/me');
  assert.strictEqual(me.data.signedIn, true);
  assert.strictEqual(me.data.profile.setUp, false);
  const p = await alice('PUT', '/api/profile', {
    name: 'Alpine <Painting>', trade: 'painter', color: '#1E88E5', logo: '🎨', phone: '555-0100',
    email: 'jobs@alpine.example', license: 'PC-1', taxPct: 8, markupPct: 20, hourlyRate: 80, validDays: 14,
  });
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.data.name, 'Alpine Painting');
  assert.strictEqual(p.data.color, '#1e88e5');
  assert.strictEqual((await alice('GET', '/api/me')).data.profile.setUp, true);
});

test('a bad photo is refused before anything is spent', async () => {
  const r = await alice('POST', '/api/quotes/draft', { description: 'Repaint the living room', photos: [{ type: 'image/jpeg', data: Buffer.from('not an image').toString('base64') }] });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(await spentBy('alice@example.com'), 0);
  assert.strictEqual((await alice('POST', '/api/quotes/draft', { description: 'hi' })).status, 400, 'nothing to go on');
});

test('snap: photos + description become an itemized draft, totals computed by the server', async () => {
  const r = await alice('POST', '/api/quotes/draft', {
    customer: { name: 'Pat Lee', contact: 'pat@example.com', address: '1 Elm St' },
    description: 'Living room and hallway, walls only, some nail holes. Customer seemed price-sensitive.',
    trade: 'painter',
    photos: [{ type: 'image/jpeg', data: JPEG }, { type: 'image/png', data: PNG }],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const q = r.data;
  quoteId = q.id;
  assert.strictEqual(q.status, 'draft');
  assert.strictEqual(q.number, 'Q-1001');
  assert.ok(q.items.length >= 3);
  assert.ok(q.scope.includes('2 photos'), 'the model saw both photos');
  assert.strictEqual(q.markupPct, 20, 'profile markup applied');
  assert.strictEqual(q.taxPct, 8, 'profile tax applied');
  assert.deepStrictEqual(q.totals, Q.computeTotals(q), 'totals are the server\'s arithmetic');
  assert.ok(q.totals.single.total > 1, 'the model\'s own "total: 1" was ignored');
  assert.ok(await spentBy('alice@example.com') > 0, 'the draft was metered');
});

test('photos are never stored - only the quote is', async () => {
  const raw = await store.get(`pros/${uidOf('alice@example.com')}/quotes`, quoteId);
  const s = JSON.stringify(raw);
  assert.ok(!s.includes(JPEG.slice(0, 40)) && !s.includes(PNG.slice(0, 40)));
  assert.ok(!('photos' in raw));
  assert.strictEqual(raw.photoCount, 2);
});

test('Good / Better / Best drafts three options, each with its own total', async () => {
  const r = await alice('POST', '/api/quotes/draft', { description: 'Front yard cleanup and mulch, about 600 sq ft of beds', trade: 'landscaper', tiers: true });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.tiers.map((t) => t.key), ['good', 'better', 'best']);
  const t = r.data.totals.tiers;
  assert.ok(t.good.total < t.better.total && t.better.total < t.best.total);
  assert.strictEqual(r.data.value, t.better.total);
});

test('model text is cleaned and absurd numbers clamped before they are stored', async () => {
  const r = await alice('POST', '/api/quotes/draft', { description: 'INJECT BADNUMBERS fix a door', trade: 'handyman' });
  assert.strictEqual(r.status, 200);
  const s = JSON.stringify(r.data.items);
  assert.ok(!s.includes('<') && !s.includes('>'));
  const neg = r.data.items.find((i) => i.description === 'Negative line');
  assert.strictEqual(neg.qty, 0);
  assert.strictEqual(neg.unitPrice, 0);
  const absurd = r.data.items.find((i) => i.description === 'Absurd line');
  assert.strictEqual(absurd.category, 'other');
  assert.ok(absurd.unitPrice <= Q.LIMITS.unitPrice);
});

test('saving the editor recomputes totals whatever the page claims', async () => {
  const r = await alice('PUT', `/api/quotes/${quoteId}`, {
    items: [
      { description: 'Labor', category: 'labor', qty: 10, unit: 'hr', unitPrice: 80 },
      { description: 'Paint', category: 'material', qty: 4, unit: 'gal', unitPrice: 50 },
    ],
    discount: 40, notes: 'Private: offered a small discount', totals: { single: { total: 1 } }, status: 'accepted', publicId: 'mine',
  });
  assert.strictEqual(r.status, 200);
  // 800 + 4 x 60 = 1040, -40 = 1000, +8% = 1080
  assert.strictEqual(r.data.totals.single.total, 1080);
  assert.strictEqual(r.data.status, 'draft', 'status is not editable');
  assert.strictEqual(r.data.publicId, undefined, 'links are not editable');
});

test('another pro gets 404 on everything of yours', async () => {
  bob = client();
  await bob('POST', '/api/auth/register', { email: 'bob@example.com', password: 'another long password' });
  for (const [m, p, body] of [
    ['GET', `/api/quotes/${quoteId}`], ['PUT', `/api/quotes/${quoteId}`, { title: 'mine now' }],
    ['POST', `/api/quotes/${quoteId}/send`], ['POST', `/api/quotes/${quoteId}/duplicate`],
    ['POST', `/api/quotes/${quoteId}/polish`, { tone: 'friendly' }], ['POST', `/api/quotes/${quoteId}/template`],
    ['POST', `/api/quotes/${quoteId}/mark`, { status: 'accepted' }], ['DELETE', `/api/quotes/${quoteId}`],
  ]) {
    assert.strictEqual((await bob(m, p, body)).status, 404, `${m} ${p}`);
  }
  assert.strictEqual((await bob('GET', '/api/quotes')).data.quotes.length, 0);
  assert.strictEqual((await alice('GET', `/api/quotes/${quoteId}`)).data.title !== 'mine now', true);
});

test('polish returns a suggestion and saves nothing', async () => {
  const before = (await alice('GET', `/api/quotes/${quoteId}`)).data.scope;
  const r = await alice('POST', `/api/quotes/${quoteId}/polish`, { tone: 'friendly', scope: 'We will paint the room.' });
  assert.strictEqual(r.status, 200);
  assert.ok(/Thanks for having us/.test(r.data.scope));
  assert.strictEqual((await alice('GET', `/api/quotes/${quoteId}`)).data.scope, before);
});

test('a follow-up needs a sent quote', async () => {
  assert.strictEqual((await alice('POST', `/api/quotes/${quoteId}/follow-up`)).status, 409);
});

test('sending mints an unguessable link and starts the validity clock', async () => {
  const r = await alice('POST', `/api/quotes/${quoteId}/send`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.status, 'sent');
  token = r.data.publicId;
  assert.ok(/^[A-Za-z0-9_-]{22}$/.test(token), 'a 128-bit token');
  assert.strictEqual(r.data.publicUrl, `q/${token}`, 'relative to the app base, never absolute');
  const days = (Date.parse(r.data.validUntil) - Date.now()) / 86400000;
  assert.ok(days > 13.9 && days < 14.1, 'valid for the profile\'s 14 days');
  const again = await alice('POST', `/api/quotes/${quoteId}/send`);
  assert.strictEqual(again.data.publicId, token, 'one link per quote');
});

test('the public quote shows only customer-facing fields', async () => {
  const anon = client();
  const r = await anon('GET', `/api/public/${token}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
  const s = JSON.stringify(r.data);
  for (const bad of ['alice@example.com', uidOf('alice@example.com'), 'Private: offered', 'price-sensitive', 'pat@example.com', '"cost"', '"margin"', 'notes', 'description":"Living room']) {
    assert.ok(!s.includes(bad), `public view leaked ${bad}`);
  }
  assert.strictEqual(r.data.business.name, 'Alpine Painting');
  assert.strictEqual(r.data.business.email, 'jobs@alpine.example');
  // The customer sees the marked-up price, never the pro's cost.
  const paint = r.data.items.find((i) => i.description === 'Paint');
  assert.strictEqual(paint.unitPrice, 60);
  assert.strictEqual(r.data.totals.total, 1080);
  assert.strictEqual((await anon('GET', '/api/public/short')).status, 404);
  assert.strictEqual((await anon('GET', '/api/public/AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
});

test('first view is recorded once; the owner previewing does not count', async () => {
  const q1 = (await alice('GET', `/api/quotes/${quoteId}`)).data;
  assert.strictEqual(q1.status, 'viewed');
  const first = q1.viewedAt;
  assert.ok(first);
  await client()('GET', `/api/public/${token}`);
  const q2 = (await alice('GET', `/api/quotes/${quoteId}`)).data;
  assert.strictEqual(q2.viewedAt, first, 'first view is not overwritten');
  assert.strictEqual(q2.views, 2);
  const prev = await alice('GET', `/api/public/${token}`);
  assert.strictEqual(prev.data.preview, true);
  assert.strictEqual((await alice('GET', `/api/quotes/${quoteId}`)).data.views, 2);
});

test('customer requests changes; the owner sees the message', async () => {
  const cust = client();
  assert.strictEqual((await cust('POST', `/api/public/${token}/changes`, { message: '' })).status, 400);
  const r = await cust('POST', `/api/public/${token}/changes`, { message: 'Can you add the <b>stairwell</b>?' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.status, 'changes');
  const list = (await alice('GET', '/api/quotes')).data.quotes;
  assert.strictEqual(list.find((q) => q.id === quoteId).unread, true);
  const q = (await alice('GET', `/api/quotes/${quoteId}`)).data;
  assert.strictEqual(q.messages[0].text, 'Can you add the bstairwell/b?');
  assert.strictEqual((await alice('GET', '/api/quotes')).data.quotes.find((x) => x.id === quoteId).unread, false);
});

test('a follow-up is drafted for a sent quote, SMS-length', async () => {
  const r = await alice('POST', `/api/quotes/${quoteId}/follow-up`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.sms.length <= 320);
  assert.ok(r.data.emailBody.includes('Alpine Painting'));
  assert.ok((await alice('GET', `/api/quotes/${quoteId}`)).data.followUp.sms);
});

test('accepting needs a full-name signature, then locks the quote', async () => {
  await alice('POST', `/api/quotes/${quoteId}/send`); // revised and re-sent
  const cust = client();
  assert.strictEqual((await cust('POST', `/api/public/${token}/accept`, { name: 'Pat' })).status, 400);
  assert.strictEqual((await alice('POST', `/api/public/${token}/accept`, { name: 'Alice Owner' })).status, 403, 'the owner cannot accept for the customer');
  const r = await cust('POST', `/api/public/${token}/accept`, { name: 'Pat Lee' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.status, 'accepted');
  assert.strictEqual(r.data.response.name, 'Pat Lee');
  assert.strictEqual((await cust('POST', `/api/public/${token}/accept`, { name: 'Pat Lee' })).status, 409);
  assert.strictEqual((await cust('POST', `/api/public/${token}/changes`, { message: 'wait' })).status, 409);
  assert.strictEqual((await alice('PUT', `/api/quotes/${quoteId}`, { discount: 500 })).status, 409, 'accepted quotes are locked');
});

test('a tiered quote cannot be accepted without choosing an option', async () => {
  const d = await alice('POST', '/api/quotes/draft', { description: 'Deck repaint and trim', trade: 'painter', tiers: true, customer: { name: 'Sam Ortiz' } });
  const s = await alice('POST', `/api/quotes/${d.data.id}/send`);
  const cust = client();
  assert.strictEqual((await cust('POST', `/api/public/${s.data.publicId}/accept`, { name: 'Sam Ortiz' })).status, 400);
  assert.strictEqual((await cust('POST', `/api/public/${s.data.publicId}/accept`, { name: 'Sam Ortiz', tier: 'platinum' })).status, 400);
  const r = await cust('POST', `/api/public/${s.data.publicId}/accept`, { name: 'Sam Ortiz', tier: 'best' });
  assert.strictEqual(r.status, 200);
  const q = (await alice('GET', `/api/quotes/${d.data.id}`)).data;
  assert.strictEqual(q.value, q.totals.tiers.best.total, 'an accepted tier is what the quote is worth');
});

test('an expired quote says so and cannot be accepted', async () => {
  const d = await alice('POST', '/api/quotes', { customer: { name: 'Late Larry' } });
  await alice('PUT', `/api/quotes/${d.data.id}`, { items: [{ description: 'Gutter clean', category: 'labor', qty: 2, unit: 'hr', unitPrice: 80 }] });
  const s = await alice('POST', `/api/quotes/${d.data.id}/send`);
  await store.merge(`pros/${uidOf('alice@example.com')}/quotes`, d.data.id, { validUntil: new Date(Date.now() - 86400000).toISOString() });
  const pub = await client()('GET', `/api/public/${s.data.publicId}`);
  assert.strictEqual(pub.data.status, 'expired');
  assert.strictEqual((await client()('POST', `/api/public/${s.data.publicId}/accept`, { name: 'Larry Late' })).status, 410);
  assert.strictEqual((await alice('GET', '/api/quotes')).data.quotes.find((q) => q.id === d.data.id).status, 'expired');
  const re = await alice('POST', `/api/quotes/${d.data.id}/send`);
  assert.strictEqual(re.data.status, 'sent', 're-sending reopens it with a fresh date');
});

test('a customer can decline, and the owner can reopen it', async () => {
  const d = await alice('POST', '/api/quotes', {});
  await alice('PUT', `/api/quotes/${d.data.id}`, { items: [{ description: 'Fence repair', category: 'labor', qty: 3, unit: 'hr', unitPrice: 80 }] });
  const s = await alice('POST', `/api/quotes/${d.data.id}/send`);
  const r = await client()('POST', `/api/public/${s.data.publicId}/decline`, { message: 'Went with someone else' });
  assert.strictEqual(r.data.status, 'declined');
  const re = await alice('POST', `/api/quotes/${d.data.id}/mark`, { status: 'sent' });
  assert.strictEqual(re.data.status, 'sent');
});

test('duplicate makes a fresh draft with no link, no response and no messages', async () => {
  const r = await alice('POST', `/api/quotes/${quoteId}/duplicate`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.status, 'draft');
  assert.ok(!r.data.publicId && !r.data.response && !r.data.sentAt);
  assert.deepStrictEqual(r.data.messages, []);
  assert.ok(r.data.title.endsWith('(copy)'));
  assert.notStrictEqual(r.data.number, (await alice('GET', `/api/quotes/${quoteId}`)).data.number);
});

let templateId;
test('templates: save one, start a quote from it for free, and they are private', async () => {
  const before = await spentBy('alice@example.com');
  const t = await alice('POST', `/api/quotes/${quoteId}/template`, { name: 'Standard room repaint' });
  assert.strictEqual(t.status, 200);
  templateId = t.data.id;
  const list = await alice('GET', '/api/templates');
  assert.strictEqual(list.data.templates[0].name, 'Standard room repaint');
  const q = await alice('POST', '/api/quotes', { templateId, customer: { name: 'New Customer' } });
  assert.strictEqual(q.status, 200);
  assert.strictEqual(q.data.source, 'template');
  assert.strictEqual(q.data.items.length, 2);
  assert.strictEqual(q.data.customer.name, 'New Customer');
  assert.ok(!q.data.notes, 'private notes do not travel through a template');
  assert.strictEqual(await spentBy('alice@example.com'), before, 'templates never call a model');
  assert.strictEqual((await bob('POST', '/api/quotes', { templateId })).status, 404);
  assert.strictEqual((await bob('DELETE', `/api/templates/${templateId}`)).status, 404);
});

test('the scoreboard adds it all up', async () => {
  const s = await alice('GET', '/api/stats');
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.data.won, 2);
  assert.ok(s.data.sent >= 4);
  assert.ok(s.data.totalWon > 1000);
  assert.strictEqual(s.data.streakWeeks, 1);
  assert.ok(s.data.winRate > 0);
  assert.strictEqual(s.data.chart.length, 8);
});

test('deleting a quote kills its public link', async () => {
  const d = await alice('POST', '/api/quotes', {});
  await alice('PUT', `/api/quotes/${d.data.id}`, { items: [{ description: 'x', category: 'labor', qty: 1, unit: 'hr', unitPrice: 10 }] });
  const s = await alice('POST', `/api/quotes/${d.data.id}/send`);
  assert.strictEqual((await client()('GET', `/api/public/${s.data.publicId}`)).status, 200);
  await alice('DELETE', `/api/quotes/${d.data.id}`);
  assert.strictEqual((await client()('GET', `/api/public/${s.data.publicId}`)).status, 404);
});

test('an exhausted allowance gets a 402 with a way to top up; free actions still work', async () => {
  await identityStore.merge('users', uidOf('bob@example.com'), { spentUsd: 100 });
  const d = await bob('POST', '/api/quotes/draft', { description: 'Paint a bedroom, two coats' });
  assert.strictEqual(d.status, 402);
  assert.ok('topUpUrl' in d.data);
  const blank = await bob('POST', '/api/quotes', {});
  assert.strictEqual(blank.status, 200, 'a blank quote costs nothing');
  assert.strictEqual((await bob('POST', `/api/quotes/${blank.data.id}/polish`, { scope: 'We will do it.' })).status, 402);
  await bob('PUT', `/api/quotes/${blank.data.id}`, { items: [{ description: 'x', category: 'labor', qty: 1, unit: 'hr', unitPrice: 10 }] });
  assert.strictEqual((await bob('POST', `/api/quotes/${blank.data.id}/send`)).status, 200, 'sending costs nothing');
  assert.strictEqual((await bob('POST', `/api/quotes/${blank.data.id}/follow-up`)).status, 402);
});

test('the /q/ page works under the mount, is not indexed, and leaks no referrer', async () => {
  const res = await fetch(`${base}/q/${token}`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<base href="../">'), 'assets resolve against the app root');
  assert.ok(!/(href|src)="\//.test(html), 'no absolute asset paths - they would escape the mount');
  const css = await fetch(new URL('app.css', `${base}/q/${token}`.replace(/q\/[^/]+$/, '')));
  assert.strictEqual(css.status, 200);
  assert.strictEqual(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.strictEqual(res.headers.get('referrer-policy'), 'no-referrer');
});

/* ---------------- run ---------------- */

(async () => {
  // Mounted the way the combined host mounts it, so every path the tests use
  // is exercised under a prefix rather than at the root.
  const host = express();
  host.use('/snapquote', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/snapquote`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
