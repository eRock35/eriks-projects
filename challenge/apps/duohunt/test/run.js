// Duo Hunt: the parsers against hand-written fixtures in Apple's and Best
// Buy's shapes, the cache / in-flight / cap / timeout machinery, then the
// real Express app mounted under /duohunt the way the lab mounts it, with
// global fetch intercepted so nothing leaves the process (the sandbox cannot
// reach apple.com or bestbuy.com anyway).
//
//   DUOHUNT_MEMORY=1 node test/run.js   (or `npm test`)

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.DUOHUNT_MEMORY !== '1') {
  console.error('run with DUOHUNT_MEMORY=1');
  process.exit(1);
}
delete process.env.DUOHUNT_FAKE_UPSTREAM;
delete process.env.DUOHUNT_FAKE_AI;
delete process.env.BESTBUY_API_KEY;

/* ---- every outbound request is seen here; only our own test server is real ---- */
const realFetch = globalThis.fetch;
const outbound = [];
let upstreamHandler = null;
globalThis.fetch = async function intercepted(url, opts) {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return realFetch(url, opts);
  outbound.push({ url: String(url), host: u.host, headers: (opts && opts.headers) || {} });
  if (!upstreamHandler) throw new Error('no upstream in this test');
  return upstreamHandler(url, opts);
};

/* ---- every log line is kept, to prove a ZIP or a key never reaches one ---- */
const logged = [];
for (const k of ['log', 'warn', 'error', 'info']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { logged.push(a.map(String).join(' ')); if (process.env.DUOHUNT_TEST_VERBOSE) orig(...a); };
}
const say = (s) => process.stdout.write(s + '\n');

const Core = require('../public/duohunt-core');
const upstream = require('../lib/upstream');
const apple = require('../lib/apple');
const bestbuy = require('../lib/bestbuy');
const parts = require('../lib/parts');
const fx = require('../lib/fixtures');
const server = require('../server');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const PART = 'AAAA1LL/A';
const ZIP = '94103';
const ANGLE = /[<>‪-‮⁦-⁩]/;

/* ---------------- Apple's parser ---------------- */

test('Apple: two stores available today, a later date is a quote, the rest unavailable; fields picked by name', () => {
  const r = apple.parse(fx.appleAvailable(PART), PART);
  assert.strictEqual(r.available, 2);
  assert.deepStrictEqual(r.stores.map((s) => [s.name, s.distance, s.status, s.label]), [
    ['Union Square', '1.2 mi', 'available', 'Available today'],
    ['Stonestown', '5.8 mi', 'unavailable', 'Unavailable'],
    ['Burlingame', '14.9 mi', 'available', 'Available today'],
    ['Bay Street', '9.6 mi', 'quote', 'Available Tue, Nov 4'],
  ]);
  assert.deepStrictEqual(Object.keys(r.stores[0]).sort(), ['city', 'distance', 'label', 'name', 'state', 'status', 'store'], 'nothing but the known fields');
  assert.strictEqual(r.stores[0].store, 'R075');
});

test('Apple: none available, and a quote only (no store today) - nothing is called available', () => {
  const none = apple.parse(fx.appleNone(PART), PART);
  assert.strictEqual(none.available, 0);
  assert.ok(none.stores.every((s) => s.status === 'unavailable'));
  const q = apple.parse(fx.appleQuoteOnly(PART), PART);
  assert.strictEqual(q.available, 0);
  assert.deepStrictEqual([q.stores[0].status, q.stores[0].label], ['quote', 'Available Mon, Nov 10']);
  // A part the store row does not mention is not available.
  assert.ok(apple.parse(fx.appleAvailable(PART), 'OTHER1LL/A').stores.every((s) => s.status === 'unavailable'));
});

test('Apple: a malformed or unknown answer is a failure, never a guess', () => {
  for (const bad of [null, 42, 'x', [], {}, { body: {} }, { body: { content: { pickupMessage: 'nope' } } }, { body: { content: { pickupMessage: { stores: {} } } } }]) {
    assert.throws(() => apple.parse(bad, PART), (e) => e.reason === 'parse');
  }
});

test('Apple: hostile strings are stripped and bounded; junk rows are skipped; a bad store number or distance is dropped', () => {
  const r = apple.parse(fx.appleHostile(PART), PART);
  assert.strictEqual(r.stores.length, 4, 'null, 42, a string, an empty and an array name are not stores');
  const s = r.stores[0];
  assert.ok(!ANGLE.test(JSON.stringify(r)), 'no markup or direction characters survive');
  assert.ok(!/script|onerror/i.test(s.name) || !/</.test(s.name));
  assert.strictEqual(s.name.length <= 60, true);
  assert.strictEqual(s.store, null, 'a store number that is not R + digits is dropped');
  assert.strictEqual(s.distance, '1.2 mi', 'an odd distance string falls back to the number');
  assert.ok(s.city.length <= 40);
  assert.strictEqual(s.status, 'available');
  // Many stores are bounded.
  const many = fx.appleAvailable(PART);
  for (let i = 0; i < 50; i++) many.body.content.pickupMessage.stores.push({ ...many.body.content.pickupMessage.stores[0], storeName: `S${i}` });
  assert.ok(apple.parse(many, PART).stores.length <= 12);
});

test('Apple: the request asks by part number and ZIP on apple.com, and the links are apple.com', () => {
  const u = new URL(apple.requestUrl(PART, ZIP));
  assert.strictEqual(u.host, 'www.apple.com');
  assert.strictEqual(u.pathname, '/shop/fulfillment-messages');
  assert.strictEqual(u.searchParams.get('parts.0'), PART);
  assert.strictEqual(u.searchParams.get('location'), ZIP);
  assert.strictEqual(apple.productUrl('MK1E4LL/A'), 'https://www.apple.com/shop/product/MK1E4LL/A');
  assert.strictEqual(apple.productUrl(null), Core.APPLE_BUY);
});

/* ---------------- Best Buy's parser ---------------- */

test('Best Buy: names read into storage, colour and carrier; accessories and junk skipped; links only bestbuy.com', () => {
  assert.deepStrictEqual(bestbuy.describe('Apple - iPhone Duo 1TB - Night Sky (AT&T)'), { storage: '1tb', colour: 'night-sky', carrier: 'att' });
  assert.deepStrictEqual(bestbuy.describe('Apple - iPhone Duo 256GB - Star White (Verizon)'), { storage: '256gb', colour: 'star-white', carrier: 'verizon' });
  assert.deepStrictEqual(bestbuy.describe('Apple iPhone Duo 512 GB Star White T-Mobile'), { storage: '512gb', colour: 'star-white', carrier: 'tmobile' });
  assert.strictEqual(bestbuy.describe('Apple - iPhone 18 Pro 256GB'), null);
  const rows = bestbuy.parseSearch(fx.bestbuySearch());
  assert.strictEqual(rows.length, 8, 'the case names iPhone Duo too, but has no storage...');
  const phones = rows.filter((r) => r.storage);
  assert.strictEqual(phones.length, 7);
  const hostile = bestbuy.parseSearch({ products: [
    { sku: 1234567, name: '<img src=x onerror=1>Apple - iPhone Duo 256GB - Star White (AT&T)‮', salePrice: 1999.99, onlineAvailability: 'yes', url: 'javascript:alert(1)' },
    { sku: 'abc', name: 'Apple - iPhone Duo 256GB' }, null, 7, { sku: 1234568, name: 'Apple - iPhone Duo 2TB - Night Sky (Verizon)', salePrice: -5, url: 'https://evil.example/bestbuy.com' },
  ] });
  assert.strictEqual(hostile.length, 2);
  assert.ok(!ANGLE.test(JSON.stringify(hostile)));
  assert.strictEqual(hostile[0].online, false, 'only a real true is online');
  assert.strictEqual(hostile[0].url, Core.BESTBUY_SEARCH, 'a javascript: url never becomes a link');
  assert.strictEqual(hostile[1].url, Core.BESTBUY_SEARCH, 'nor another host');
  assert.strictEqual(hostile[1].price, null);
  assert.throws(() => bestbuy.parseSearch({ nope: 1 }), (e) => e.reason === 'parse');
  assert.throws(() => bestbuy.parseStores({ stores: 'x' }), (e) => e.reason === 'parse');
});

test('Best Buy: the pick matches its carrier version; stores are bounded and clean', () => {
  const rows = bestbuy.parseSearch(fx.bestbuySearch());
  assert.strictEqual(bestbuy.match(rows, { storage: '256gb', colour: 'star-white', carrier: 'att' }).sku, '6612003');
  assert.strictEqual(bestbuy.match(rows, { storage: '256gb', colour: 'star-white', carrier: 'unlocked' }), null);
  assert.strictEqual(bestbuy.match(rows, { storage: '2tb', colour: 'night-sky', carrier: 'verizon' }), null);
  const st = bestbuy.parseStores(fx.bestbuyStores(6612003));
  assert.deepStrictEqual(st.map((s) => [s.name, s.distance, s.lowStock]), [['San Francisco', '0.8 mi', true], ['Colma', '7.4 mi', false]]);
  const many = { stores: Array.from({ length: 30 }, (_, i) => ({ name: `<b>S${i}</b>`, distance: 'far' })) };
  const out = bestbuy.parseStores(many);
  assert.strictEqual(out.length, 10);
  assert.strictEqual(out[0].name, 'S0');
  assert.strictEqual(out[0].distance, '');
});

/* ---------------- cache, in-flight, cap, timeout ---------------- */

test('a source: one shared in-flight request for ten taps, five minutes of cache, then a fresh fetch', async () => {
  let t = 1000;
  const src = upstream.createSource({ name: 't', now: () => t });
  let loads = 0;
  const load = async () => { loads++; await new Promise((r) => setTimeout(r, 20)); return { n: loads }; };
  const ten = await Promise.all(Array.from({ length: 10 }, () => src.get('k', load)));
  assert.strictEqual(loads, 1, 'ten at once are one fetch');
  assert.ok(ten.every((r) => r.value.n === 1));
  t += 4 * 60 * 1000;
  assert.strictEqual((await src.get('k', load)).cached, true);
  assert.strictEqual(loads, 1);
  await src.get('other', load);
  assert.strictEqual(loads, 2, 'another key is its own fetch');
  t += 2 * 60 * 1000;
  await src.get('k', load);
  assert.strictEqual(loads, 3, 'after five minutes it asks again');
});

test('a source: a failure is remembered for a minute, not five; the cap answers "busy" without fetching', async () => {
  let t = 0;
  const src = upstream.createSource({ name: 't', now: () => t, capPerWindow: 2 });
  let loads = 0;
  const bad = async () => { loads++; throw new upstream.UpstreamError('http 503', 503); };
  await assert.rejects(src.get('a', bad), (e) => e.reason === 'http 503');
  await assert.rejects(src.get('a', bad));
  assert.strictEqual(loads, 1);
  t += 61 * 1000;
  await assert.rejects(src.get('a', bad));
  assert.strictEqual(loads, 2, 'a minute later it tries again');
  await assert.rejects(src.get('b', bad), (e) => e.reason === 'busy', 'the third real fetch in the window is refused');
  assert.strictEqual(loads, 2);
});

test('getJson: a 6 s style timeout aborts, a non-JSON or error answer fails, other hosts are refused, the User-Agent says who', async () => {
  const hang = (_u, o) => new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const t0 = Date.now();
  await assert.rejects(upstream.getJson('https://www.apple.com/x', { fetchImpl: hang, timeoutMs: 60 }), (e) => e.reason === 'timeout');
  assert.ok(Date.now() - t0 < 1000);
  await assert.rejects(upstream.getJson('https://www.apple.com/x', { fetchImpl: async () => fx.respond(200, '<html>no</html>') }), (e) => e.reason === 'parse');
  await assert.rejects(upstream.getJson('https://www.apple.com/x', { fetchImpl: async () => fx.respond(503, '{}') }), (e) => e.reason === 'http 503');
  await assert.rejects(upstream.getJson('https://www.apple.com/x', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), (e) => e.reason === 'network');
  for (const h of ['https://www.att.com/x', 'https://www.verizon.com/x', 'https://www.t-mobile.com/x', 'https://evil.example/x']) {
    let called = false;
    await assert.rejects(upstream.getJson(h, { fetchImpl: async () => { called = true; return fx.respond(200, '{}'); } }), (e) => e.reason === 'host not allowed');
    assert.strictEqual(called, false, `${h} is never fetched`);
  }
  let ua = '';
  await upstream.getJson('https://www.apple.com/x', { fetchImpl: async (_u, o) => { ua = o.headers['User-Agent']; return fx.respond(200, '{}'); } });
  assert.ok(/^DuoHunt\/1\.0 \(\+https:\/\/challenge\.strongtechnicalconsulting\.com\/duohunt\//.test(ua), ua);
  assert.ok(upstream.USER_AGENT && upstream.ALLOWED_HOSTS.size === 2);
});

test('Apple and Best Buy checks: a timeout, an outage or a parse failure become the friendly sentence with a link', async () => {
  const hang = (_u, o) => new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const a = await apple.check({ part: PART, zip: ZIP, source: upstream.createSource({ name: 'x' }), fetchImpl: hang, timeoutMs: 50 });
  assert.deepStrictEqual([a.state, a.message], ['error', 'Couldn’t check Apple right now - open Apple’s page.']);
  assert.ok(a.link.startsWith('https://www.apple.com/'));
  for (const scenario of ['down', 'malformed', 'notjson']) {
    const r = await apple.check({ part: PART, zip: ZIP, source: upstream.createSource({ name: 'x' }), fetchImpl: fx.createFakeFetch({ apple: scenario }) });
    assert.strictEqual(r.state, 'error', scenario);
    assert.strictEqual(r.message, apple.FAIL);
  }
  const busy = upstream.createSource({ name: 'x', capPerWindow: 0 });
  assert.strictEqual((await apple.check({ part: PART, zip: ZIP, source: busy, fetchImpl: fx.createFakeFetch() })).state, 'busy');
  process.env.BESTBUY_API_KEY = 'testkey12345';
  try {
    const mk = () => ({ search: upstream.createSource({ name: 's' }), stores: upstream.createSource({ name: 't' }) });
    const down = await bestbuy.check({ pick: { storage: '256gb', colour: 'star-white', carrier: 'att' }, zip: ZIP, ...mk(), fetchImpl: fx.createFakeFetch({ bestbuy: 'down' }) });
    assert.deepStrictEqual([down.state, down.message, down.link], ['error', bestbuy.FAIL, Core.BESTBUY_SEARCH]);
    const slow = await bestbuy.check({ pick: { storage: '256gb', colour: 'star-white', carrier: 'att' }, zip: ZIP, ...mk(), fetchImpl: hang, timeoutMs: 50 });
    assert.strictEqual(slow.state, 'error');
    // The store endpoint refused for the key: online availability and the link still show.
    const ns = await bestbuy.check({ pick: { storage: '256gb', colour: 'star-white', carrier: 'att' }, zip: ZIP, ...mk(), fetchImpl: fx.createFakeFetch({ bestbuy: 'nostores' }) });
    assert.deepStrictEqual([ns.state, ns.stores, ns.product.sku], ['ok', null, '6612003']);
    assert.ok(/open Best Buy/.test(ns.storesNote));
    const nl = await bestbuy.check({ pick: { storage: '256gb', colour: 'star-white', carrier: 'unlocked' }, zip: ZIP, ...mk(), fetchImpl: fx.createFakeFetch() });
    assert.deepStrictEqual([nl.state, nl.message], ['not-listed', 'Best Buy lists this one for Verizon and AT&T - not Unlocked.']);
  } finally { delete process.env.BESTBUY_API_KEY; }
});

/* ---------------- part numbers ---------------- */

test('part numbers: nothing guessed - every row starts unset, so the live check says it is not set up; a filled row must look like an Apple US part', async () => {
  assert.strictEqual(Object.keys(parts.PARTS).length, 32, 'every storage x colour x carrier');
  assert.ok(Object.values(parts.PARTS).every((r) => r.part === null), 'no part number is shipped unconfirmed');
  assert.strictEqual(parts.partFor({ storage: '256gb', colour: 'star-white', carrier: 'unlocked' }), null);
  const t = { '256gb:star-white:unlocked': { part: 'mk1e4ll/a' }, '512gb:star-white:unlocked': { part: 'not a part' } };
  assert.strictEqual(parts.partFor({ storage: '256gb', colour: 'star-white', carrier: 'unlocked' }, { table: t }), 'MK1E4LL/A');
  assert.strictEqual(parts.partFor({ storage: '512gb', colour: 'star-white', carrier: 'unlocked' }, { table: t }), null);
  assert.ok(/^Z/.test(parts.partFor({ storage: '2tb', colour: 'night-sky', carrier: 'tmobile' }, { fake: true })), 'fakes start with Z, which no Apple part does');
  const r = await apple.check({ part: null, zip: ZIP, source: upstream.createSource({ name: 'x' }) });
  assert.strictEqual(r.state, 'not-configured');
  assert.ok(/isn’t set up for this model/.test(r.message));
  assert.strictEqual(r.link, Core.APPLE_BUY);
});

/* ---------------- the shared core ---------------- */

test('the core: ZIPs are five digits, picks are only known values, "2 min ago", what counts as newly available', () => {
  assert.strictEqual(Core.cleanZip('94103'), '94103');
  assert.strictEqual(Core.cleanZip(' 94103 '), '94103');
  assert.strictEqual(Core.cleanZip('94103-1234'), '94103');
  for (const bad of ['9410', '941034', 'abcde', '94 103', '', null, undefined, 94103.5, '<9410>', '94103\n1']) assert.strictEqual(Core.cleanZip(bad), null, String(bad));
  assert.deepStrictEqual(Core.cleanPick({ storage: '1tb', colour: 'night-sky', carrier: 'verizon', extra: 1 }), { storage: '1tb', colour: 'night-sky', carrier: 'verizon' });
  assert.strictEqual(Core.cleanPick({ storage: '128gb', colour: 'night-sky', carrier: 'att' }), null);
  assert.strictEqual(Core.cleanPick({ storage: '1tb', colour: 'gold', carrier: 'att' }), null);
  assert.strictEqual(Core.ago(0, 10 * 1000), 'just now');
  assert.strictEqual(Core.ago(0, 2 * 60 * 1000), '2 min ago');
  assert.strictEqual(Core.ago(0, 3 * 3600 * 1000), '3 h ago');
  assert.strictEqual(Core.ago(0, 26 * 3600 * 1000), 'yesterday');
  const none = { apple: { state: 'ok', stores: [{ name: 'A', status: 'unavailable' }] }, bestbuy: { state: 'not-connected' } };
  const one = { apple: { state: 'ok', stores: [{ name: 'A', status: 'available' }] }, bestbuy: { state: 'not-connected' } };
  assert.deepStrictEqual(Core.newlyAvailable(none, one), ['apple:A']);
  assert.deepStrictEqual(Core.newlyAvailable(one, one), [], 'still available is not news');
  let h = [];
  for (let i = 0; i < 25; i++) h = Core.pushHistory(h, { at: i });
  assert.strictEqual(h.length, 20);
  assert.strictEqual(h[0].at, 24);
  assert.deepStrictEqual(Core.cleanNotes({ att: { at: 5, result: 'in-stock' }, verizon: { at: 'x', result: 'nothing' }, tmobile: { at: 1, result: '<b>' }, evil: { at: 1, result: 'nothing' } }), { att: { at: 5, result: 'in-stock' } });
  assert.strictEqual(Core.safeUrl('https://www.att.com/buy/phones/apple-iphone-duo.html', ['att.com']), 'https://www.att.com/buy/phones/apple-iphone-duo.html');
  assert.strictEqual(Core.safeUrl('https://www.att.com.evil.example/', ['att.com']), null);
  assert.strictEqual(Core.safeUrl('https://evilatt.com/', ['att.com']), null);
  assert.strictEqual(Core.safeUrl('javascript:alert(1)', ['att.com']), null);
});

test('the carrier links are https on each carrier’s own site', () => {
  const host = { att: 'www.att.com', verizon: 'www.verizon.com', tmobile: 'www.t-mobile.com' };
  for (const id of Core.CARRIER_IDS) {
    const c = Core.CARRIER_LINKS[id];
    for (const u of [c.product, c.stores]) assert.strictEqual(new URL(u).host, host[id], u);
    assert.ok(/iphone-duo/.test(c.product));
  }
});

/* ---------------- the page ---------------- */

function luminance(hex) {
  const c = hex.replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
function tokens(block) { const out = {}; for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[m[1]] = m[2]; return out; }

test('every text colour holds 4.5:1 on its surface in both themes (and the lab card colours hold white)', () => {
  const css = read('public/app.css');
  const light = tokens(css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)')));
  const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('* { box-sizing'));
  const dark = { ...light, ...tokens(darkBlock) };
  const pairs = [['text', 'bg'], ['text', 'card'], ['text', 'card2'], ['muted', 'bg'], ['muted', 'card'], ['muted', 'card2'], ['accent-ink', 'accent'], ['accent-text', 'accent-soft'], ['accent-text', 'card'], ['link', 'card'], ['link', 'bg'],
    ['good', 'good-bg'], ['warn', 'warn-bg'], ['bad', 'bad-bg'], ['info', 'info-bg'], ['idle', 'idle-bg'], ['good', 'card2'], ['warn', 'card2'], ['bad', 'card'], ['info', 'card'], ['accent', 'card']];
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const [f, b] of pairs) {
      const r = contrast(t[f], t[b]);
      assert.ok(r >= 4.5, `${name}: --${f} on --${b} is ${r.toFixed(2)}:1`);
    }
  }
  const lab = require('../../../lab').get('duohunt');
  for (const c of [lab.color, lab.color2]) assert.ok(contrast('#ffffff', c) >= 4.5, c);
});

test('the page: relative links, no inline script or handlers, the banner and passkey client, storage wrapped, nothing drawn with innerHTML, no email', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline script');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<script src="passkey-client.js"></script>'));
  assert.ok(!/(href|src)="\//.test(html), 'every asset is relative to the base');
  assert.ok(html.includes('desktop.css') && html.includes('class="dk"'));
  const js = read('public/app.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js), 'nothing is drawn as markup');
  assert.ok(!/fetch\(\s*['"`]\//.test(js), 'no root-relative fetch: BASE + path');
  assert.ok(/BASE \+ 'api\/check'/.test(js));
  const storageUses = js.match(/(localStorage|sessionStorage)\b/g) || [];
  assert.ok(storageUses.length >= 2 && !/window\.localStorage\.|\blocalStorage\.(get|set)Item/.test(js.replace(/window\[store\]\.(get|set)Item/g, '')), 'storage only through the wrapped load/save');
  assert.ok(/try \{ var v = window\[store\]\.getItem/.test(js) && /try \{ window\[store\]\.setItem/.test(js));
  for (const f of ['public/index.html', 'public/app.js', 'public/duohunt-core.js', 'server.js', 'CLAUDE.md', 'lib/apple.js', 'lib/bestbuy.js', 'lib/parts.js', 'lib/fixtures.js', 'lib/upstream.js']) {
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(read(f).replace(/@(google-cloud|simplewebauthn|anthropic-ai)\b/g, '')), `${f} carries an email address`);
    assert.ok(!/claude\.ai\/code\/session/.test(read(f)), `${f} carries a session link`);
  }
  const sw = read('public/sw.js');
  assert.ok(/if \(rel\.indexOf\('api\/'\) === 0\) return;/.test(sw), 'the service worker never answers api/');
  const code = ['server.js', 'lib/apple.js', 'lib/bestbuy.js', 'lib/upstream.js', 'lib/parts.js', 'public/app.js'].map(read).join('\n');
  assert.ok(!/require\(['"]@anthropic-ai|messages\.create|claude-(haiku|sonnet|opus)/.test(code), 'no model anywhere');
  assert.ok(!fs.existsSync(path.join(ROOT, 'lib/ai.js')) && !/anthropic/.test(read('package.json')));
});

test('local-only switches throw on Cloud Run', () => {
  for (const env of [{ DUOHUNT_MEMORY: '1' }, { DUOHUNT_FAKE_UPSTREAM: '1' }, { DUOHUNT_FAKE_AI: '1' }]) {
    const r = spawnSync(process.execPath, ['-e', "require('./server.js')"], { cwd: ROOT, env: { ...process.env, DUOHUNT_MEMORY: '', DUOHUNT_FAKE_UPSTREAM: '', DUOHUNT_FAKE_AI: '', GOOGLE_CLOUD_PROJECT: 'x', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, JSON.stringify(env));
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const ok = spawnSync(process.execPath, ['-e', "require('./server.js')"], { cwd: ROOT, env: { ...process.env, DUOHUNT_MEMORY: '1', DUOHUNT_FAKE_UPSTREAM: '1' }, encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stderr);
});

test('the collection prefix is read and nothing is stored: there is no app collection', () => {
  const r = spawnSync(process.execPath, ['-e', "console.log(require('./lib/store').PREFIX)"], { cwd: ROOT, env: { ...process.env, DUOHUNT_COLLECTION_PREFIX: 'duohunt_' }, encoding: 'utf8' });
  assert.strictEqual(r.stdout.trim(), 'duohunt_');
  const src = ['server.js', 'lib/apple.js', 'lib/bestbuy.js', 'lib/upstream.js'].map(read).join('\n');
  assert.ok(!/\.collection\(|identityStore\.(set|add|merge|bump)/.test(src), 'nothing writes a document');
});

/* ---------------- over HTTP ---------------- */

let base;
let ipN = 1;
async function call(method, p, body, ip) {
  const res = await realFetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || `203.0.113.${ipN++ % 250}` },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { text }; }
  return { status: res.status, data, text, headers: res.headers };
}
const PICK = { storage: '256gb', colour: 'star-white', carrier: 'unlocked' };
function configure(on) {
  for (const k of Object.keys(parts.PARTS)) parts.PARTS[k].part = null;
  if (on) parts.PARTS['256gb:star-white:unlocked'].part = PART;
}

test('signed out, one tap: Apple is asked once by part and ZIP, two stores show; Best Buy with no key is "Not connected yet" and asked nothing', async () => {
  server._reset(); configure(true); outbound.length = 0;
  upstreamHandler = fx.createFakeFetch();
  const r = await call('POST', '/api/check', { ...PICK, zip: ZIP });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  assert.deepStrictEqual([r.data.apple.state, r.data.apple.available, r.data.apple.stores.length], ['ok', 2, 4]);
  assert.deepStrictEqual([r.data.bestbuy.state, r.data.bestbuy.message, r.data.bestbuy.link], ['not-connected', 'Not connected yet - open Best Buy to check.', Core.BESTBUY_SEARCH]);
  assert.deepStrictEqual(outbound.map((o) => o.host), ['www.apple.com'], 'Best Buy is never asked without a key');
  assert.ok(/^DuoHunt\//.test(outbound[0].headers['User-Agent']));
  const meta = await call('GET', '/api/meta');
  assert.strictEqual(meta.data.bestbuy, false);
  assert.strictEqual(meta.data.apple['256gb:star-white:unlocked'], true);
  assert.strictEqual(meta.data.apple['2tb:night-sky:tmobile'], false);
});

test('a crowd: twenty people tapping the same model and ZIP at once are one request to Apple; a second ZIP is its own', async () => {
  server._reset(); configure(true); outbound.length = 0;
  upstreamHandler = fx.createFakeFetch({ delayMs: 40 });
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', '/api/check', { ...PICK, zip: ZIP }, `198.51.100.${i + 1}`)));
  assert.ok(rs.every((r) => r.status === 200 && r.data.apple.available === 2));
  assert.strictEqual(outbound.length, 1);
  await call('POST', '/api/check', { ...PICK, zip: '10001' });
  assert.strictEqual(outbound.length, 2);
  await call('POST', '/api/check', { ...PICK, zip: '10001' });
  assert.strictEqual(outbound.length, 2, 'cached for five minutes');
});

test('Best Buy connected: the AT&T version online and two stores; the key never reaches the page or a log', async () => {
  server._reset(); configure(true); outbound.length = 0;
  process.env.BESTBUY_API_KEY = 'secretkey987654';
  try {
    upstreamHandler = fx.createFakeFetch();
    const r = await call('POST', '/api/check', { storage: '256gb', colour: 'star-white', carrier: 'att', zip: ZIP });
    assert.strictEqual(r.status, 200);
    const b = r.data.bestbuy;
    assert.deepStrictEqual([b.state, b.product.sku, b.product.online, b.stores.length], ['ok', '6612003', false, 2]);
    assert.ok(Core.safeUrl(b.link, ['bestbuy.com']));
    assert.strictEqual(r.data.apple.state, 'not-configured', 'that version has no part number yet');
    assert.deepStrictEqual(outbound.map((o) => o.host).sort(), ['api.bestbuy.com', 'api.bestbuy.com']);
    assert.ok(!r.text.includes('secretkey987654'));
    assert.strictEqual((await call('GET', '/api/meta')).data.bestbuy, true);
    // A failing Best Buy logs a reason word, never its URL (which holds the key and the ZIP).
    server._reset(); upstreamHandler = fx.createFakeFetch({ bestbuy: 'down' });
    const f = await call('POST', '/api/check', { storage: '256gb', colour: 'star-white', carrier: 'att', zip: '30301' });
    assert.strictEqual(f.data.bestbuy.message, bestbuy.FAIL);
    assert.ok(!logged.join('\n').includes('secretkey987654'));
  } finally { delete process.env.BESTBUY_API_KEY; }
});

test('no request ever goes to AT&T, Verizon or T-Mobile, whatever is picked', async () => {
  server._reset(); configure(true); outbound.length = 0;
  process.env.BESTBUY_API_KEY = 'secretkey987654';
  try {
    upstreamHandler = fx.createFakeFetch();
    for (const s of Core.STORAGES) for (const c of Core.COLOURS) for (const k of Core.CARRIERS) {
      const r = await call('POST', '/api/check', { storage: s.id, colour: c.id, carrier: k.id, zip: ZIP }, `192.0.2.${(ipN++ % 200) + 1}`);
      assert.strictEqual(r.status, 200);
    }
    assert.ok(outbound.length > 0);
    assert.ok(outbound.every((o) => ['www.apple.com', 'api.bestbuy.com'].includes(o.host)), [...new Set(outbound.map((o) => o.host))].join(','));
    assert.ok(!outbound.some((o) => /att\.com|verizon\.com|t-mobile\.com/.test(o.host)));
  } finally { delete process.env.BESTBUY_API_KEY; }
});

test('the ZIP: five digits or a 400 before anything is asked; never logged, never stored, never in a URL our logs see', async () => {
  server._reset(); configure(true); outbound.length = 0;
  upstreamHandler = fx.createFakeFetch();
  for (const zip of ['1234', '123456', 'abcde', '', '<script>', '9410 3', null]) {
    const r = await call('POST', '/api/check', { ...PICK, zip });
    assert.deepStrictEqual([r.status, r.data.error], [400, 'Enter a 5-digit US ZIP code.'], String(zip));
  }
  assert.strictEqual((await call('POST', '/api/check', { storage: '128gb', colour: 'gold', carrier: 'sprint', zip: ZIP })).status, 400);
  assert.strictEqual((await call('POST', '/api/check', '{"zip": ')).status, 400, 'a broken body is a 400');
  assert.strictEqual(outbound.length, 0, 'nothing asked for a bad request');
  assert.strictEqual((await call('GET', `/api/check?zip=${ZIP}`)).status, 404, 'there is no GET: a ZIP never rides in a URL');
  logged.length = 0;
  const z = '60614';
  upstreamHandler = fx.createFakeFetch({ apple: 'down' });
  await call('POST', '/api/check', { ...PICK, zip: z });
  upstreamHandler = fx.createFakeFetch({ apple: 'notjson' });
  await call('POST', '/api/check', { ...PICK, zip: '60615' });
  await call('POST', '/api/check', '{"zip":"60616","storage":');
  const all = logged.join('\n');
  assert.ok(logged.length > 0, 'the failures were logged...');
  assert.ok(!/6061[456]/.test(all), '...without the ZIP');
  assert.ok(!/fulfillment-messages|location=/.test(all), '...or the URL');
  assert.ok(!/6061[456]|94103|10001/.test(server.identityStore._dump()), 'nothing stored');
});

test('limits: 20 checks per address in ten minutes, then a 429 that asks for nothing; another address still checks', async () => {
  server._reset(); configure(true); outbound.length = 0;
  upstreamHandler = fx.createFakeFetch();
  const ip = '203.0.113.250';
  for (let i = 0; i < 20; i++) assert.strictEqual((await call('POST', '/api/check', { ...PICK, zip: ZIP }, ip)).status, 200);
  const before = outbound.length;
  const r = await call('POST', '/api/check', { ...PICK, zip: '73301' }, ip);
  assert.strictEqual(r.status, 429);
  assert.ok(/ten minutes/.test(r.data.error));
  assert.strictEqual(outbound.length, before);
  assert.strictEqual((await call('POST', '/api/check', { ...PICK, zip: ZIP }, '203.0.113.251')).status, 200);
});

test('Apple down or slow over HTTP: a 200 whose card says "Couldn’t check Apple right now" with the link - never a 500', async () => {
  server._reset(); configure(true);
  upstreamHandler = fx.createFakeFetch({ apple: 'down' });
  const r = await call('POST', '/api/check', { ...PICK, zip: ZIP });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.data.apple.state, r.data.apple.message], ['error', apple.FAIL]);
  upstreamHandler = fx.createFakeFetch({ apple: 'hostile' });
  server._reset();
  const h = await call('POST', '/api/check', { ...PICK, zip: ZIP });
  assert.ok(!ANGLE.test(JSON.stringify(h.data.apple)), 'hostile upstream strings never reach the page');
});

test('the shared account is mounted at api/auth; the page, worker and assets load under the base; security headers', async () => {
  const me = await call('GET', '/api/auth/me');
  assert.ok([200, 401].includes(me.status), String(me.status));
  const page = await call('GET', '/');
  assert.strictEqual(page.status, 200);
  assert.ok(/script-src 'self'/.test(page.headers.get('content-security-policy')));
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  for (const f of ['app.js', 'app.css', 'desktop.css', 'duohunt-core.js', 'verify-banner.js', 'passkey-client.js', 'icon.svg', 'manifest.webmanifest']) {
    assert.strictEqual((await call('GET', `/${f}`)).status, 200, f);
  }
  const sw = await call('GET', '/sw.js');
  assert.deepStrictEqual([sw.status, sw.headers.get('cache-control')], [200, 'no-cache']);
  assert.strictEqual((await call('GET', '/api/nope')).status, 404);
  assert.strictEqual((await call('POST', '/api/check', { x: 'y'.repeat(20000) })).status, 413);
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use((req, res, next) => (req.path === '/duohunt' ? res.redirect(301, '/duohunt/') : next()));
  host.use('/duohunt', server.app);
  const srv = http.createServer(host).listen(0);
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}/duohunt`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); say(`  ok  ${t.name}`); } catch (e) { failed++; say(`  FAIL ${t.name}\n${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e}`); }
  }
  srv.close();
  say(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
