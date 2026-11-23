// Inside Joke with INSIDEJOKE_AI_PROVIDER=claude-first: the photo and chat
// readers on Claude with Gemini as the fallback, and "Make a round" on.
//   INSIDEJOKE_AI_PROVIDER=claude-first INSIDEJOKE_MEMORY=1 INSIDEJOKE_FAKE_AI=1 node test/claude-first.js
//
// Driven over HTTP under an /insidejoke mount against the memory store, the
// stand-in and a fake lab guard. Any request that leaves 127.0.0.1 fails.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

if (process.env.INSIDEJOKE_MEMORY !== '1' || process.env.INSIDEJOKE_FAKE_AI !== '1' || process.env.INSIDEJOKE_AI_PROVIDER !== 'claude-first') {
  console.error('run with INSIDEJOKE_AI_PROVIDER=claude-first INSIDEJOKE_MEMORY=1 INSIDEJOKE_FAKE_AI=1');
  process.exit(1);
}

const realFetch = globalThis.fetch;
let outside = 0;
globalThis.fetch = (url, ...rest) => { if (!/^http:\/\/127\.0\.0\.1:/.test(String(url))) { outside++; return Promise.reject(new Error('network')); } return realFetch(url, ...rest); };

const C = require('../public/ij-core');
const gemini = require('../lib/gemini');
const { app, identityStore, store, PROVIDER, MODE, fakeGemini } = require('../server');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/** The contents with the Claude stand-in's UPSTREAMnnn trigger renamed, so
 *  only Claude fails. */
function scrubbed(contents) {
  const fix = (t) => t.replace(/UPSTREAM(\d{3})/g, 'UPSTRAAM$1');
  return contents.map((c) => ({ ...c, parts: c.parts.map((p) => (p.inlineData ? { inlineData: { ...p.inlineData, data: Buffer.from(fix(Buffer.from(p.inlineData.data, 'base64').toString('latin1')), 'latin1').toString('base64') } } : p.text ? { text: fix(p.text) } : p)) }));
}
/** A lab guard that records what it was asked, and can say no. */
function fakeGuard() {
  const g = {
    log: [], deny: null, denyFor: null, fail: null, json: null, scrub: false, generated: [],
    async allow(a) { g.log.push(['allow', a.provider, a.app, Boolean(a.req && a.req.user && a.req.user.id)]); return (g.denyFor && g.denyFor[a.provider]) || g.deny || { ok: true }; },
    async record(a) { g.log.push(['record', a.provider, a.app, a.usd]); return true; },
    priceUsd({ provider, model, inputTokens, outputTokens }) { if (provider === 'claude') return (inputTokens + 5 * outputTokens) / 1e6; assert.deepStrictEqual([provider, model], ['gemini', 'gemini-3.8-flash']); return (inputTokens * 0.75 + outputTokens * 3.75) / 1e6; },
    gemini: {
      async generate(args) {
        g.generated.push(args);
        if (g.fail) throw g.fail;
        if (g.json) return { json: g.json, usage: { inputTokens: 1200, outputTokens: 10 } };
        assert.strictEqual(typeof args.fake, 'function', 'the stand-in is handed to the helper - no network');
        const contents = g.scrub ? scrubbed(args.contents) : args.contents;
        const body = { contents, systemInstruction: { parts: [{ text: args.systemInstruction }] }, generationConfig: { ...args.generationConfig, responseMimeType: 'application/json', responseSchema: args.responseSchema } };
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
const usage = () => identityStore.list('usage');
const spent = async (who) => Number(((await identityStore.get('users', uidOf(mail(who)))) || {}).spentUsd || 0);
const settle = () => new Promise((r) => setTimeout(r, 15));

function jpg(w, h, marker = '') {
  const exifBody = Buffer.from(`Exif\0\0GPSLAT-33.7490-SECRET${marker}`);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(exifBody.length + 2) >> 8, (exifBody.length + 2) & 255]), exifBody]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const sos = Buffer.concat([Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), Buffer.from(`SCAN${marker}`), Buffer.alloc(800, 0x55), Buffer.from([0xff, 0xd9])]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, sos]).toString('base64');
}
const MARK = 'MODELCOPYBYTES';
const onePhoto = (marker = '', extra = {}) => ({ thumb: jpg(640, 480, 'THUMB'), image: { type: 'image/jpeg', data: jpg(1024, 768, MARK + marker) }, year: 2019, place: 'Lake Lanier', ...extra });
const QUOTES = [
  { n: 'Mom', t: 'Did everyone land ok? Text me when you do' },
  { n: 'Dad', t: 'Who moved my chair again, I had it just right' },
  { n: 'Ana', t: 'I am never camping with you people again lol' },
  { n: 'Dad', t: 'call me on +1 404 555 0143 about the boat trailer please' },
];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let host; let G;
const names = ['Mom', 'Dad', 'Ana', 'Ben'];
const excerpt = (extra = '') => Array.from({ length: 24 }, (_, i) => ({ n: names[i % 4], t: `message number ${i} from ${['the lake', 'the cabin', 'the car', 'the beach'][i % 4]} with love today${i === 0 ? extra : ''}` }));

test('the mode: Claude first, "Make a round" on', async () => {
  assert.deepStrictEqual([MODE, PROVIDER], ['claude-first', 'claude']);
  global.LAB_AI_GUARD = fakeGuard();
  host = await register('host.cf');
  const r = await host('POST', '/api/groups', { name: 'The Strongs', tz: 'America/New_York', host: { name: 'Erik', emoji: '🎸', color: 'ocean' } });
  assert.strictEqual(r.status, 200, r.text);
  G = `/api/groups/${r.data.group.id}`;
  for (const name of ['Mom', 'Dad', 'Ana']) assert.strictEqual((await client()('POST', `/api/code/${r.data.group.code}/join`, { name, emoji: '😀', color: 'basil' })).status, 200);
  assert.strictEqual((await client()('GET', '/api/meta')).data.ai.round, true);
});

test('Claude answers when it can: no Gemini call', async () => {
  const g = global.LAB_AI_GUARD = fakeGuard();
  const p = await host('POST', `${G}/photos`, onePhoto());
  assert.ok(p.status === 200 && p.data.questions.length, p.text.slice(0, 200));
  const c = await host('POST', `${G}/chat`, { excerpt: excerpt() });
  assert.ok(c.status === 200 && c.data.questions.length >= 3, c.text.slice(0, 200));
  assert.deepStrictEqual(g.log.filter((x) => x[0] === 'allow').map((x) => x[1]), ['claude', 'claude']);
  assert.strictEqual(g.generated.length, 0);
});

test('Claude throws -> Gemini answers 200; Claude unusable -> Gemini; Claude monthly cap -> Gemini; a burst refusal -> the guard’s 429 and no Gemini call', async () => {
  const g = global.LAB_AI_GUARD = fakeGuard();
  g.scrub = true;
  const providers = (kind) => g.log.filter((x) => x[0] === kind).map((x) => x[1]);
  // Claude throws (the SDK's 529): Gemini's questions, never the provider's words.
  let r = await host('POST', `${G}/photos`, onePhoto('UPSTREAM529'));
  assert.ok(r.status === 200 && r.data.questions && r.data.questions.length && !/stand-in/.test(r.text), r.text.slice(0, 300));
  assert.deepStrictEqual([providers('allow'), providers('record'), g.generated[0].responseSchema], [['claude', 'gemini'], ['gemini'], gemini.PHOTO_SCHEMA]);
  g.log.length = 0;
  r = await host('POST', `${G}/chat`, { excerpt: excerpt(' UPSTREAM529') });
  assert.ok(r.status === 200 && r.data.questions.length >= 3, r.text.slice(0, 300));
  assert.deepStrictEqual(providers('allow'), ['claude', 'gemini']);
  // Claude's quotes are all invented (the cleaners leave none): Gemini's, and Claude's billed call is recorded.
  g.log.length = 0;
  g.json = { questions: [{ quote: 'message number 1 from the cabin' }, { quote: 'message number 2 from the car' }, { quote: 'message number 3 from the beach' }] };
  r = await host('POST', `${G}/chat`, { excerpt: excerpt(' INVENTED') });
  g.json = null;
  assert.ok(r.status === 200 && r.data.questions.length === 3, r.text.slice(0, 300));
  assert.deepStrictEqual([providers('allow'), providers('record')], [['claude', 'gemini'], ['claude', 'gemini']]);
  // Claude's monthly cap: Gemini alone, before the stream; Claude never called.
  g.denyFor = { claude: { ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' } };
  g.log.length = 0;
  r = await host('POST', `${G}/photos`, onePhoto());
  assert.ok(r.status === 200 && r.data.questions.length, r.text.slice(0, 300));
  assert.deepStrictEqual([providers('allow'), providers('record')], [['claude', 'gemini'], ['gemini']]);
  // Both capped: the guard's own words.
  g.denyFor = { claude: g.denyFor.claude, gemini: g.denyFor.claude };
  g.log.length = 0;
  r = await host('POST', `${G}/chat`, { excerpt: excerpt() });
  assert.deepStrictEqual([r.status, r.data.code, providers('allow')], [503, 'monthly-cap', ['claude', 'gemini']]);
  // A burst refusal: the guard's 429, no Gemini call.
  for (const code of ['burst-minute', 'burst-day']) {
    g.denyFor = { claude: { ok: false, status: 429, code, message: 'Lots of people are using AI right now - try again in a minute.' } };
    g.log.length = 0;
    const gen = g.generated.length;
    for (const [p, body] of [['photos', onePhoto()], ['chat', { excerpt: excerpt() }]]) {
      r = await host('POST', `${G}/${p}`, body);
      assert.deepStrictEqual([r.status, r.data.code], [429, code], p);
    }
    assert.deepStrictEqual([providers('allow'), g.generated.length], [['claude', 'claude'], gen]);
  }
  g.denyFor = null;
  assert.match(read('server.js'), /console\.error\(`\[insidejoke\] claude failed \(\$\{code\}\); used gemini`\)/);
});

test('"Make a round" is on and Gemini only: answers, and a failure is its own friendly error', async () => {
  const g = global.LAB_AI_GUARD = fakeGuard();
  const r = await host('POST', `${G}/round`, { photos: [], quotes: QUOTES.slice(0, 2) });
  assert.deepStrictEqual(r.data.questions.map((q) => q.style), ['who_said', 'who_said'], r.text.slice(0, 200));
  assert.deepStrictEqual(g.log.filter((x) => x[0] === 'allow').map((x) => x[1]), ['gemini']);
  g.fail = Object.assign(new Error('SECRET-PROVIDER-TEXT'), { name: 'VertexError', code: 'timeout' });
  g.log.length = 0;
  const f = await host('POST', `${G}/round`, { photos: [], quotes: QUOTES.slice(0, 2) });
  assert.ok(f.data.error && !/SECRET|Vertex/.test(f.text), f.text);
  assert.deepStrictEqual(g.log.filter((x) => x[0] === 'allow').map((x) => x[1]), ['gemini'], 'never Claude');
  assert.strictEqual(outside, 0, 'nothing left 127.0.0.1');
});

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/insidejoke', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/insidejoke`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
