// The sheet reader with PENCIL_AI_PROVIDER=claude-first: Claude first, and
// Gemini only when Claude fails - against the memory store, both stand-ins
// and a fake lab AI guard.
//   PENCIL_AI_PROVIDER=claude-first PENCIL_MEMORY=1 PENCIL_FAKE_AI=1 node test/claude-first.js
// Nothing here touches the network: the guard's Vertex helper is replaced
// by one that only calls the stand-in it is handed.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

if (process.env.PENCIL_MEMORY !== '1' || process.env.PENCIL_FAKE_AI !== '1' || process.env.PENCIL_AI_PROVIDER !== 'claude-first') {
  console.error('run with PENCIL_AI_PROVIDER=claude-first PENCIL_MEMORY=1 PENCIL_FAKE_AI=1');
  process.exit(1);
}

// Any real request is a failure.
const realFetch = globalThis.fetch;
let outside = 0;
globalThis.fetch = (url, ...rest) => { if (!/^http:\/\/127\.0\.0\.1:/.test(String(url))) { outside++; return Promise.reject(new Error('network')); } return realFetch(url, ...rest); };

const C = require('../public/pencil-core');
const gemini = require('../lib/gemini');
const { app, identityStore, store, fakeClient, fakeGemini, PROVIDER } = require('../server');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/** A lab guard that records what it was asked, and can say no. */
function fakeGuard() {
  const g = {
    log: [], deny: null, generated: [],
    async allow(a) { g.log.push(['allow', a.provider, a.app, Boolean(a.req && a.req.user && a.req.user.id)]); return (g.denyFor && g.denyFor[a.provider]) || g.deny || { ok: true }; },
    async record(a) { g.log.push(['record', a.provider, a.app, a.usd]); return true; },
    priceUsd({ provider, model, inputTokens, outputTokens }) {
      if (provider === 'claude') { assert.ok(/^claude-/.test(model)); return (inputTokens + 5 * outputTokens) / 1e6; }
      assert.deepStrictEqual([provider, model], ['gemini', 'gemini-3.8-flash']); return (inputTokens * 0.75 + outputTokens * 3.75) / 1e6;
    },
    gemini: {
      async generate(args) {
        g.generated.push(args);
        assert.strictEqual(typeof args.fake, 'function', 'the stand-in is handed to the helper - no network');
        const body = { contents: args.contents, systemInstruction: { parts: [{ text: args.systemInstruction }] }, generationConfig: { ...args.generationConfig, responseMimeType: 'application/json', responseSchema: args.responseSchema } };
        return { json: await args.fake(body), usage: { inputTokens: 1200, outputTokens: 800 }, model: args.model, fake: true };
      },
    },
  };
  return g;
}

let base;
let n = 1;
function client() {
  const cookies = {};
  const addr = `2001:db8:${(n++).toString(16)}::1`;
  return async function (method, p, body) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const t = await res.text();
    let data = {}; try { data = JSON.parse(t); } catch (e) { data = {}; }
    return { status: res.status, data, text: t };
  };
}
const mail = (who) => `${who}${String.fromCharCode(64)}example.com`;
const uidOf = (email) => Buffer.from(email).toString('base64url');
async function register(who) { const u = client(); const r = await u('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' }); assert.strictEqual(r.status, 200, r.text); return u; }
const u16 = (v) => Buffer.from([(v >> 8) & 255, v & 255]);
function jpeg(w, h) {
  const seg = (m, payload) => Buffer.concat([Buffer.from([0xff, m]), u16(payload.length + 2), payload]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), seg(0xe1, Buffer.from('Exif\0\0GPSLatitude 51.5074 GPSLongitude -0.1278', 'latin1')), seg(0xfe, Buffer.from('game night at 22 Marrow Close', 'latin1')), seg(0xc0, Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0])), Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0]), Buffer.alloc(3000, 0x55), Buffer.from([0xff, 0xd9])]);
}
const photo = () => ({ image: { type: 'image/jpeg', data: jpeg(1200, 900).toString('base64') } });
const usage = () => identityStore.list('usage');
const spent = async (who) => Number(((await identityStore.get('users', uidOf(mail(who)))) || {}).spentUsd || 0);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const steps = (g) => g.log.map((x) => x.slice(0, 2));

test('claude-first: Claude reads the sheet; no Gemini call when it answers', async () => {
  assert.strictEqual(PROVIDER, 'claude-first');
  const g = global.LAB_AI_GUARD = fakeGuard();
  const al = await register('al.cf');
  const n0 = fakeGemini.calls.length;
  const r = await al('POST', '/api/ai/sheet', photo());
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual([steps(g), fakeGemini.calls.length], [[['allow', 'claude'], ['record', 'claude']], n0]);
});

test('Claude fails, Gemini answers: a thrown error, unusable output, Claude’s monthly cap; a burst refusal is the guard’s 429 with no Gemini call; one log line each', async () => {
  const g = global.LAB_AI_GUARD = fakeGuard();
  const bo = await register('bo.cf');
  const warn = console.warn; const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    fakeClient.mode = 'upstream500';
    let r = await bo('POST', '/api/ai/sheet', photo());
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.data.proposal && !/stand-in/.test(r.text));
    assert.deepStrictEqual(steps(g), [['allow', 'claude'], ['allow', 'gemini'], ['record', 'gemini']]);
    g.log.length = 0;
    fakeClient.mode = 'blank';
    r = await bo('POST', '/api/ai/sheet', photo());
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(steps(g), [['allow', 'claude'], ['record', 'claude'], ['allow', 'gemini'], ['record', 'gemini']], 'the Claude call that billed is recorded, then Gemini');
    g.log.length = 0;
    g.denyFor = { claude: { ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' } };
    const c0 = fakeClient.calls.length;
    r = await bo('POST', '/api/ai/sheet', photo());
    assert.deepStrictEqual([r.status, fakeClient.calls.length], [200, c0]);
    assert.deepStrictEqual(steps(g), [['allow', 'claude'], ['allow', 'gemini'], ['record', 'gemini']]);
    for (const code of ['burst-minute', 'burst-day']) {
      g.log.length = 0;
      g.denyFor = { claude: { ok: false, status: 429, code, message: 'Lots of people are using AI right now - try again in a minute.' } };
      const n0 = fakeGemini.calls.length;
      r = await bo('POST', '/api/ai/sheet', photo());
      assert.deepStrictEqual([r.status, r.data.code, r.data.error, fakeGemini.calls.length, g.log.length], [429, code, 'Lots of people are using AI right now - try again in a minute.', n0, 1]);
    }
    g.denyFor = null;
    // both fail: the friendly error, never provider text
    fakeClient.mode = 'upstream500'; fakeGemini.mode = 'upstream500';
    r = await bo('POST', '/api/ai/sheet', photo());
    assert.ok(r.status >= 500 && !/stand-in|Vertex/i.test(r.text), r.text);
  } finally { console.warn = warn; g.denyFor = null; }
  assert.deepStrictEqual(lines, ['[pencil] claude failed (http); used gemini', '[pencil] claude failed (unusable); used gemini', '[pencil] claude failed (monthly-cap); used gemini', '[pencil] claude failed (http); used gemini']);
  assert.strictEqual(outside, 0, 'no request left this machine');
});

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/pencil', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/pencil`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
