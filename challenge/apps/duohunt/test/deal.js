// Duo Hunt, "Check a deal": the one model call, driven through the stand-in
// (lib/fakeai.js). The real Express app is mounted under /duohunt the way
// the lab mounts it; global fetch is intercepted so nothing leaves the
// process. Northwind Mobile and its offer are made up.
//
//   DUOHUNT_MEMORY=1 DUOHUNT_FAKE_AI=1 DUOHUNT_FAKE_UPSTREAM=0 node test/deal.js

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.DUOHUNT_MEMORY !== '1' || process.env.DUOHUNT_FAKE_AI !== '1') {
  console.error('run with DUOHUNT_MEMORY=1 DUOHUNT_FAKE_AI=1');
  process.exit(1);
}

/* ---- nothing but our own test server is ever fetched ---- */
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async function intercepted(url, opts) {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return realFetch(url, opts);
  outbound.push(String(url));
  throw new Error('the deal tests never touch the network');
};
const logged = [];
for (const k of ['log', 'warn', 'error', 'info']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { logged.push(a.map(String).join(' ')); if (process.env.DUOHUNT_TEST_VERBOSE) orig(...a); };
}
const say = (s) => process.stdout.write(s + '\n');

const D = require('../public/deal-core');
const ai = require('../lib/ai');
const fakeai = require('../lib/fakeai');
const server = require('../server');
const { identityStore, fakeClient } = server;

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
const mail = (who) => `${who}${AT}example.com`;
const uidOf = (email) => Buffer.from(email).toString('base64url');
const settle = () => new Promise((r) => setTimeout(r, 20));

let base;
let ipN = 1;
function client() {
  const cookies = {};
  const addr = `198.51.100.${ipN++ % 250}`;
  return async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await realFetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { text }; }
    return { status: res.status, data, text, headers: res.headers };
  };
}
async function register(who) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' });
  assert.strictEqual(r.status, 200, r.text);
  return c;
}
const GOOD = { text: D.SAMPLE };
const HUGE = { text: 'x'.repeat(200000) };

/* ---------------- the rules, with no server ---------------- */

test('the sum is done here, in whole cents: the sample’s “$0 a month” phone is $3,275.00 over 36 months, $5,634.80 if the conditions slip', () => {
  const b = ai.brief({ text: D.SAMPLE });
  const out = ai.answer(JSON.parse(JSON.stringify(fakeai.GOOD)), b);
  assert.strictEqual(out.cost.months, 36);
  assert.deepStrictEqual(out.cost.lines.map((l) => [l.label, l.working, l.cents]), [
    ['iPhone Duo 256GB', '36 × $55.55', 199980],
    ['The plan', '36 × $90.00', 324000],
    ['Activation fee', 'once', 3500],
    ['Trade-in bill credits', '36 × $55.55', -199980],
  ]);
  assert.strictEqual(out.cost.totalCents, 199980 + 324000 + 3500 - 199980);
  assert.deepStrictEqual([out.cost.total, out.cost.perMonth, out.cost.ifMissed, out.cost.complete], ['$3,275.00', '$90.97', '$5,634.80', true]);
  assert.strictEqual(out.cost.ifMissedCents, 199980 + 36 * 10000 + 3500, 'no monthly credits, and the plan at its price without AutoPay');
  assert.strictEqual(out.catches.length, 6);
  assert.deepStrictEqual(out.dropped, { catches: 0, numbers: [] });
});

test('the sum’s edges: a longer installment counts 36 payments and says what is left; a full-price phone; a missing plan price is named and the total called partial; credits never push it below zero', () => {
  const T = (o) => ({ deviceName: 'Phone', devicePrice: null, downPayment: null, monthlyDevice: null, installmentMonths: null, monthlyLine: null, monthlyLineWithout: null, autopayRequired: null, termMonths: null, tradeInRequired: null, tradeInNote: '', credits: [], fees: [], ...o });
  const long = D.cost(T({ monthlyDevice: 4000, installmentMonths: 48, downPayment: 10000, monthlyLine: 5000 }));
  assert.deepStrictEqual([long.lines[0].cents, long.lines[0].working, long.totalCents], [10000 + 36 * 4000, '$100.00 down + 36 × $40.00', 10000 + 36 * 4000 + 36 * 5000]);
  assert.ok(/12 more phone payments of \$40\.00 \(\$480\.00\) come after month 36/.test(long.after[0]));
  const full = D.cost(T({ devicePrice: 199900, fees: [{ label: 'Insurance', kind: 'monthly', amount: 1700 }] }));
  assert.deepStrictEqual([full.lines[0].working, full.lines[1].cents, full.totalCents, full.complete, full.missing], ['full price', 36 * 1700, 199900 + 36 * 1700, false, ['the monthly plan price']]);
  const partialCredit = D.cost(T({ devicePrice: 100000, monthlyLine: 1000, credits: [{ label: 'Card', kind: 'prepaid_card', total: 20000, monthly: null, months: null, condition: '' }, { label: 'Slow credit', kind: 'bill_credit', total: 48000, monthly: null, months: 48, condition: '' }] }));
  assert.strictEqual(partialCredit.totalCents, 100000 + 36000 - 20000 - 36000);
  assert.strictEqual(partialCredit.ifMissedCents, 100000 + 36000 - 20000, 'a prepaid card is kept; the bill credit is what is at risk');
  const over = D.cost(T({ devicePrice: 1000, credits: [{ label: 'Huge', kind: 'instant', total: 999900, monthly: null, months: null, condition: '' }] }));
  assert.strictEqual(over.totalCents, 0);
  assert.strictEqual(D.usd(123456789), '$1,234,567.89');
  assert.strictEqual(D.usd(-5), '-$0.05');
});

test('what comes back is untrusted: a number the offer never wrote is dropped and named, an invented quote is dropped, extra fields and the model’s own total are ignored', () => {
  const b = ai.brief({ text: D.SAMPLE });
  const raw = { ...JSON.parse(JSON.stringify(fakeai.GOOD)), monthly_line_cost: 49.99, device_price: '1999.80', installment_months: 36.5, total_36_months: 1, advice: 'buy' };
  raw.catches.push({ text: 'Invented.', quote: 'You must also sign a five-year contract.' });
  raw.catches.push({ text: 'Too short a quote.', quote: 'due' });
  raw.catches.push({ text: 'Case matters.', quote: 'CREDITS START WITHIN 3 BILL CYCLES.' });
  raw.fees.push({ label: 'Invented', kind: 'weekly', amount: 77.77 });
  const out = ai.answer(raw, b);
  assert.strictEqual(out.terms.monthlyLine, null);
  assert.strictEqual(out.terms.devicePrice, null, 'a string is not a number');
  assert.strictEqual(out.terms.installmentMonths, null);
  assert.ok(out.dropped.numbers.includes('the monthly plan price') && out.dropped.numbers.includes('a fee (Invented)'));
  assert.strictEqual(out.dropped.catches, 3);
  assert.strictEqual(out.catches.length, 6);
  assert.ok(!('total_36_months' in out.terms) && !('advice' in out.terms) && !JSON.stringify(out).includes('five-year'));
  assert.deepStrictEqual([out.cost.complete, out.cost.missing], [false, ['the phone’s price', 'the monthly plan price']]);
  // Every kept quote is, whitespace aside, a substring of what was sent.
  for (const c of out.catches) assert.ok(D.norm(b.text).includes(c.quote), c.quote);
  // A quote split across a line break in the paste still counts as word for word.
  assert.strictEqual(D.verifyQuote('Credits start within 3 bill cycles.', 'Credits start\n   within 3 bill   cycles.'), 'Credits start within 3 bill cycles.');
  assert.strictEqual(D.verifyQuote('Credits begin within 3 bill cycles.', D.SAMPLE), '');
  // Nothing usable at all is an error in words.
  assert.throws(() => ai.answer({ catches: [{ text: 'x', quote: 'Credits start within 3 bill cycles.' }] }, b), (e) => e.status === 422 && /Couldn’t find a deal’s prices/.test(e.message));
  for (const junk of [null, 'x', [], 7]) assert.throws(() => ai.answer(junk, b), (e) => e.status === 422);
});

test('what may be sent: exactly {text}, bounded, with emails and phone-like numbers taken out first', () => {
  for (const bad of [null, {}, { text: 5 }, { text: D.SAMPLE, zip: '94103' }, { offer: D.SAMPLE }, [D.SAMPLE]]) assert.throws(() => ai.brief(bad), (e) => e.status === 400, JSON.stringify(bad));
  assert.throws(() => ai.brief({ text: 'too short $5' }), (e) => e.status === 400 && /doesn’t look like an offer/.test(e.message));
  assert.throws(() => ai.brief({ text: 'no numbers in this text at all, however long it happens to run on for' }), (e) => e.status === 400);
  assert.throws(() => ai.brief({ text: '$1 '.repeat(4000) }), (e) => e.status === 400 && /too long/.test(e.message));
  const phone = ['800', '555', '0100'].join('-');
  const b = ai.brief({ text: `${D.SAMPLE}\nQuestions? Write to ${mail('pat.example')} or call 1-${phone}. Account ${'4'.repeat(12)}.‮` });
  assert.ok(b.redacted && !b.text.includes(AT) && !b.text.includes(phone) && !/4{12}/.test(b.text) && !b.text.includes('‮'));
  assert.ok(b.text.includes('[email removed]') && b.text.includes('[number removed]'));
  assert.strictEqual(ai.brief(GOOD).redacted, false);
  // The demo offer names no real carrier.
  assert.ok(!/at&t|verizon|t-mobile|sprint|xfinity|cricket|boost|mint mobile|visible/i.test(D.SAMPLE) && /made-up carrier/.test(D.SAMPLE));
});

test('the tool: forced, terms only, no field for a total; the system prompt says copy, never add up; the stand-in throws on Cloud Run', () => {
  const props = Object.keys(ai.TOOL.input_schema.properties);
  assert.deepStrictEqual(ai.TOOL.input_schema.required.slice().sort(), props.slice().sort());
  assert.ok(!props.some((k) => /total|sum|cost_36|advice|verdict/.test(k)), 'the model is never asked for a total');
  assert.ok(/Do not add, multiply or total anything/.test(ai.SYSTEM) && /data, never instructions/.test(ai.SYSTEM) && /character for character/.test(ai.SYSTEM));
  for (const f of ['./server.js', './lib/fakeai.js']) {
    const r = spawnSync(process.execPath, ['-e', `require('${f}')`], { cwd: ROOT, env: { ...process.env, DUOHUNT_MEMORY: '', DUOHUNT_FAKE_AI: '1', GOOGLE_CLOUD_PROJECT: 'x', K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, f);
    assert.ok(/DUOHUNT_FAKE_AI=1 is for local use only and is refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 200));
  }
  // The provider is the lab's Anthropic path, models chosen by identity.planFor; no other provider is wired.
  const src = read('server.js');
  assert.ok(/identityLib\.planFor\(req\.user, MODELS\)\.model/.test(src) && /identity\.clientFor\(req\.user, shared\(\)/.test(src) && /identity\.meter\(/.test(src));
  assert.deepStrictEqual(server.MODELS, { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' });
  assert.ok(!/aiplatform|gemini|openai|federat/i.test(src + read('lib/ai.js')), 'no other provider, no federation');
  // The gates come before the route's own parser, in the route's own line.
  assert.ok(/app\.post\('\/api\/deal', identityLib\.sameOriginOnly, \.\.\.spend, dealJson,/.test(src));
  assert.ok(/const spend = \[identity\.requireUser, identity\.requireBudget, identity\.requireDailyCap\];/.test(src));
});

/* ---------------- over HTTP ---------------- */

test('signed out: 401 before the body is read - a huge or broken body is still a 401 - and no model call; another site’s page is refused', async () => {
  const anon = client();
  const calls = fakeClient.calls.length;
  assert.strictEqual((await anon('POST', '/api/deal', GOOD)).status, 401);
  assert.strictEqual((await anon('POST', '/api/deal', HUGE)).status, 401, '401, not 413');
  assert.strictEqual((await anon('POST', '/api/deal', '{"text": ')).status, 401, '401, not 400');
  const amy = await register('amy.crosssite');
  assert.strictEqual((await amy('POST', '/api/deal', GOOD, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await amy('POST', '/api/deal', GOOD, { Origin: 'https://elsewhere.example' })).status, 403);
  await settle();
  assert.strictEqual(fakeClient.calls.length, calls);
});

test('signed in, the sample offer: one forced tool call that saw the offer and nothing else; the answer carries the server’s sum, six quoted catches, and is not cached', async () => {
  const bea = await register('bea.shopper');
  const calls = fakeClient.calls.length;
  const r = await bea('POST', '/api/deal', GOOD);
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  assert.strictEqual(fakeClient.calls.length, calls + 1);
  const sent = fakeClient.calls[fakeClient.calls.length - 1];
  assert.deepStrictEqual(sent.tool_choice, { type: 'tool', name: 'record_deal_terms' });
  assert.strictEqual(sent.model, 'claude-haiku-4-5', 'a free account reads on the free tier’s model');
  assert.strictEqual(sent.tools.length, 1);
  assert.strictEqual(sent.messages.length, 1);
  const text = sent.messages[0].content.map((c) => c.text).join('');
  assert.ok(text.includes(D.SAMPLE) && text.startsWith(ai.ASK));
  assert.ok(!JSON.stringify(sent).includes(mail('bea.shopper')) && !JSON.stringify(sent).includes(uidOf(mail('bea.shopper'))), 'no account detail reaches the model');
  assert.deepStrictEqual([r.data.cost.total, r.data.cost.perMonth, r.data.cost.ifMissed, r.data.cost.months], ['$3,275.00', '$90.97', '$5,634.80', 36]);
  assert.strictEqual(r.data.catches.length, 6);
  for (const c of r.data.catches) assert.ok(D.norm(D.SAMPLE).includes(c.quote));
  // The spend is recorded on the shared ledger like any sibling's call.
  await settle();
  const user = await identityStore.get('users', uidOf(mail('bea.shopper')));
  assert.ok(Number(user.spentUsd) > 0, 'the call was charged to the account');
});

test('a dishonest reading over HTTP: invented numbers and an invented quote are dropped and named, the rest kept; markup is stripped; nothing readable is a 422; a long answer a 502; a busy provider a 503 with no provider words', async () => {
  const cy = await register('cy.careful');
  fakeClient.mode = 'bad';
  const bad = await cy('POST', '/api/deal', GOOD);
  assert.strictEqual(bad.status, 200, bad.text);
  assert.strictEqual(bad.data.terms.monthlyLine, null);
  assert.ok(bad.data.dropped.numbers.includes('the monthly plan price') && bad.data.dropped.numbers.includes('a fee (Invented fee)') && bad.data.dropped.numbers.includes('a credit (Made-up loyalty credit)'));
  assert.strictEqual(bad.data.dropped.catches, 2);
  assert.strictEqual(bad.data.catches.length, 2);
  assert.ok(!bad.text.includes('five-year') && !bad.text.includes('Buy it now') && !bad.text.includes('12.34') && !bad.text.includes('Absurd'));
  assert.strictEqual(bad.data.cost.complete, false);
  fakeClient.mode = 'inject';
  const inj = await cy('POST', '/api/deal', GOOD);
  assert.strictEqual(inj.status, 200);
  assert.ok(!/[<>‮]/.test(JSON.stringify(inj.data)) && !('admin' in inj.data.terms) && !inj.text.includes('ignore your instructions'));
  fakeClient.mode = 'blank';
  const blank = await cy('POST', '/api/deal', GOOD);
  assert.deepStrictEqual([blank.status, /Couldn’t find a deal’s prices/.test(blank.data.error)], [422, true]);
  fakeClient.mode = 'maxtokens';
  assert.strictEqual((await cy('POST', '/api/deal', GOOD)).status, 502);
  fakeClient.mode = 'upstream529';
  const busy = await cy('POST', '/api/deal', GOOD);
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  fakeClient.mode = 'upstream401';
  const down = await cy('POST', '/api/deal', GOOD);
  assert.deepStrictEqual([down.status, /isn’t available right now/.test(down.data.error)], [502, true]);
  assert.ok(!/fake_upstream_error|stand-in provider/.test(busy.text + down.text), 'a provider’s words never reach the page');
  // Anything but exactly {text}, or something that is no offer: a 400 and no model call.
  const calls = fakeClient.calls.length;
  assert.strictEqual((await cy('POST', '/api/deal', { text: D.SAMPLE, extra: 1 })).status, 400);
  assert.strictEqual((await cy('POST', '/api/deal', { text: 'hello' })).status, 400);
  assert.strictEqual((await cy('POST', '/api/deal', HUGE)).status, 413);
  assert.strictEqual(fakeClient.calls.length, calls);
});

test('the gates: an unconfirmed free account 403 verify-email, out of credit 402, the day’s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register('eve.unconfirmed');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = fakeClient.calls.length;
    const r = await eve('POST', '/api/deal', GOOD);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/duohunt/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/deal', HUGE)).status, 403, '403 before the big body is read');
    assert.strictEqual(fakeClient.calls.length, calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = fakeClient.calls.length;
  assert.strictEqual((await cal('POST', '/api/deal', GOOD)).status, 402);
  assert.strictEqual((await cal('POST', '/api/deal', HUGE)).status, 402, '402, not 413');
  assert.strictEqual(fakeClient.calls.length, calls);
  const dan = await register('dan.capped');
  const today = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-duohunt-${today}`, { usd: 5000 });
  try {
    calls = fakeClient.calls.length;
    const capped = await dan('POST', '/api/deal', GOOD);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/deal', HUGE)).status, 503, 'the ceiling answers before the parser too');
    assert.strictEqual(fakeClient.calls.length, calls);
  } finally { await identityStore.remove('control', `free-spend-duohunt-${today}`); }
});

test('the lab’s AI guard, when the host has one: asked after the identity gates and before the call; a no is its own friendly message and no model call; a yes is recorded with the priced usage; without a guard the app just runs', async () => {
  const gus = await register('gus.guarded');
  const seen = [];
  global.LAB_AI_GUARD = {
    allow: async (a) => { seen.push(['allow', a.provider, a.app, Boolean(a.req && a.req.user)]); return { ok: false, status: 429, message: 'The lab’s AI is resting for a bit. Try again soon.', code: 'lab-ai-cap' }; },
    record: async (r) => { seen.push(['record', r]); },
    priceUsd: (p) => { seen.push(['price', p]); return 0.0042; },
  };
  try {
    let calls = fakeClient.calls.length;
    const no = await gus('POST', '/api/deal', GOOD);
    assert.deepStrictEqual([no.status, no.data.error, no.data.code], [429, 'The lab’s AI is resting for a bit. Try again soon.', 'lab-ai-cap']);
    assert.strictEqual(fakeClient.calls.length, calls, 'a denied call never reaches the model');
    assert.deepStrictEqual(seen, [['allow', 'claude', 'duohunt', true]]);
    // Signed out, the identity gate answers first: the guard is not even asked.
    seen.length = 0;
    assert.strictEqual((await client()('POST', '/api/deal', GOOD)).status, 401);
    assert.strictEqual(seen.length, 0);
    // A bad body is a free 400 before the guard too.
    assert.strictEqual((await gus('POST', '/api/deal', { text: 'hello' })).status, 400);
    assert.strictEqual(seen.length, 0);
    global.LAB_AI_GUARD.allow = async () => { seen.push(['allow']); return { ok: true }; };
    calls = fakeClient.calls.length;
    const yes = await gus('POST', '/api/deal', GOOD);
    assert.strictEqual(yes.status, 200, yes.text);
    assert.strictEqual(fakeClient.calls.length, calls + 1);
    assert.deepStrictEqual(seen, [['allow'], ['price', { provider: 'claude', model: 'claude-haiku-4-5', inputTokens: 1400, outputTokens: 520 }], ['record', { provider: 'claude', app: 'duohunt', usd: 0.0042 }]]);
    // A guard that fails to record never loses the answer.
    global.LAB_AI_GUARD.record = async () => { throw new Error('ledger down'); };
    assert.strictEqual((await gus('POST', '/api/deal', GOOD)).status, 200);
  } finally { delete global.LAB_AI_GUARD; }
  assert.strictEqual((await gus('POST', '/api/deal', GOOD)).status, 200, 'no guard: the app still runs');
});

test('per account: eight readings in ten minutes, then a 429 with no model call; another account still reads', async () => {
  server._reset();
  const hal = await register('hal.hasty');
  for (let i = 0; i < server.LIMITS.dealsPerUser; i++) assert.strictEqual((await hal('POST', '/api/deal', GOOD)).status, 200, String(i));
  const calls = fakeClient.calls.length;
  const r = await hal('POST', '/api/deal', GOOD);
  assert.deepStrictEqual([r.status, /lot of deals/.test(r.data.error)], [429, true]);
  assert.strictEqual(fakeClient.calls.length, calls);
  assert.strictEqual((await (await register('ivy.other'))('POST', '/api/deal', GOOD)).status, 200);
  server._reset();
});

test('nothing of an offer is stored or logged, the stock check still needs no account, and nothing left the process', async () => {
  const jo = await register('jo.private');
  const marker = 'Zephyrline Wireless secret offer 7421';
  const r = await jo('POST', '/api/deal', { text: `${D.SAMPLE}\n${marker}` });
  assert.strictEqual(r.status, 200);
  fakeClient.mode = 'upstream529';
  await jo('POST', '/api/deal', { text: `${D.SAMPLE}\n${marker}` });
  await settle();
  const dump = identityStore._dump();
  assert.ok(!dump.includes(marker) && !dump.includes('Northwind') && !dump.includes('55.55'), 'no word of the offer is stored');
  assert.ok(!logged.some((l) => l.includes(marker) || l.includes('Northwind')), 'no word of the offer is logged');
  // Finding a phone: still no account, no model (Best Buy has no key here, Apple is not asked).
  const calls = fakeClient.calls.length;
  const chk = await client()('POST', '/api/check', { storage: '256gb', colour: 'star-white', carrier: 'unlocked', zip: '94103' });
  assert.strictEqual(chk.status, 200, chk.text);
  assert.strictEqual(chk.data.apple.state, 'blocked');
  assert.strictEqual(fakeClient.calls.length, calls);
  assert.strictEqual(server.FAKE, false, 'DUOHUNT_FAKE_UPSTREAM=0 keeps the upstream real here');
  assert.deepStrictEqual(outbound, []);
  const health = await client()('GET', '/api/health');
  assert.deepStrictEqual(health.data, { ok: true, stores: 'nothing', model: 'deal check only' });
});

test('the page: the deal form, the sample button, the account sheet; the answer drawn as text only; the hint says who does the sum', () => {
  const html = read('public/index.html');
  for (const id of ['dealForm', 'dealText', 'dealBtn', 'dealSample', 'dealOut', 'account', 'acctForm', 'acctBtn']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(/An AI model reads the terms out of your text; Duo Hunt does the arithmetic itself and shows its working\. Nothing is stored\./.test(html));
  assert.ok(html.includes('<script src="deal-core.js"></script>') && html.includes('<script src="deal.js"></script>'));
  const js = read('public/deal.js');
  assert.ok(/api\('POST', 'api\/deal', \{ text: \$\('dealText'\)\.value \}\)/.test(js), 'the page sends the text and nothing else');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage/.test(js), 'drawn as text, and nothing kept in the browser');
  assert.ok(/if \(!me\.signedIn\) \{ openAccount\(/.test(js), 'signed out: the sheet opens and nothing is sent');
  assert.ok(/u\.origin === location\.origin/.test(js), 'a top-up link is only ever on this site');
  const sw = read('public/sw.js');
  assert.ok(sw.includes("'deal.js'") && sw.includes("'deal-core.js'") && /if \(rel\.indexOf\('api\/'\) === 0\) return;/.test(sw));
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
