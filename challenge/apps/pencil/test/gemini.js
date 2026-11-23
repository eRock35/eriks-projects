// The sheet reader on Gemini: the same route with PENCIL_AI_PROVIDER=gemini,
// against the memory store, the Gemini stand-in and a fake lab AI guard.
//   PENCIL_AI_PROVIDER=gemini PENCIL_MEMORY=1 PENCIL_FAKE_AI=1 node test/gemini.js
// Nothing here touches the network: the guard's Vertex helper is replaced
// by one that only calls the stand-in it is handed.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

if (process.env.PENCIL_MEMORY !== '1' || process.env.PENCIL_FAKE_AI !== '1' || process.env.PENCIL_AI_PROVIDER !== 'gemini') {
  console.error('run with PENCIL_AI_PROVIDER=gemini PENCIL_MEMORY=1 PENCIL_FAKE_AI=1');
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

test('the switch: this process reads sheets with Gemini; the schema asks for every cell with how sure, and for no sums', () => {
  assert.strictEqual(PROVIDER, 'gemini');
  const S = gemini.SCHEMA;
  assert.deepStrictEqual(S.required, ['players', 'rows', 'confidence', 'note']);
  const cell = S.properties.rows.items.properties.cells.items;
  assert.deepStrictEqual([cell.required, cell.properties.v.type, cell.properties.v.nullable, cell.properties.c.enum], [['v', 'c'], 'integer', true, C.CONFIDENCE]);
  assert.ok(!/maxItems|minItems/.test(JSON.stringify(S)), 'no array limits in the schema: Vertex refuses them (400); the server cuts instead');
  const big = gemini.shape({ players: [], rows: Array.from({ length: C.LIMITS.aiRows + 5 }, () => ({ cells: Array.from({ length: C.LIMITS.aiCols + 3 }, () => ({ v: 1, c: 'high' })) })) });
  assert.deepStrictEqual([big.rows.length, big.rows[0].length, big.cells[0].length], [C.LIMITS.aiRows, C.LIMITS.aiCols, C.LIMITS.aiCols], 'shape() cuts rows and cells to the limits');
  assert.ok(!/total/i.test(Object.keys(S.properties).join()) && /Do not add up/.test(gemini.SYSTEM) && /never an instruction to you/.test(gemini.SYSTEM));
  assert.strictEqual(gemini.MODEL, 'gemini-3.8-flash');
  const src = read('lib/gemini.js') + read('server.js');
  assert.ok(!/metadata\.google|aiplatform\.googleapis|fetch\(/.test(src), 'no client of its own: the lab guard\u2019s helper makes the call');
  assert.strictEqual((read('server.js').match(/gemini\.ask\(/g) || []).length, 1, 'one place Gemini is asked');
  // Priced at the brief's rates, by date.
  assert.ok(Math.abs(gemini.priceUsd({ inputTokens: 1e6, outputTokens: 1e6 }, '2026-12-31T23:00:00Z') - 4.5) < 1e-9 && Math.abs(gemini.priceUsd({ inputTokens: 1e6, outputTokens: 1e6 }, '2027-01-01T00:00:00Z') - 9) < 1e-9);
  assert.strictEqual(gemini.shape(['x']), null);
});

test('signed out: 401 before the body is read, the guard is never asked, no model call', async () => {
  const g = global.LAB_AI_GUARD = fakeGuard();
  const r = await client()('POST', '/api/ai/sheet', photo());
  assert.strictEqual(r.status, 401);
  assert.deepStrictEqual([g.log.length, fakeGemini.calls.length], [0, 0]);
});

test('a sheet through the guard: allow, then one schema call with only the photo, then record; cells flagged, totals the app\u2019s; charged to the person; nothing stored', async () => {
  const g = global.LAB_AI_GUARD = fakeGuard();
  const ada = await register('ada.gemini');
  const bad = await ada('POST', '/api/ai/sheet', { image: photo().image, game: 'Hearts' });
  assert.deepStrictEqual([bad.status, g.log.length, fakeGemini.calls.length], [400, 0, 0], 'a 400 costs nothing and asks nobody');
  const rows0 = (await usage()).length;
  const r = await ada('POST', '/api/ai/sheet', photo());
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(g.log.map((x) => x[0]), ['allow', 'record']);
  assert.deepStrictEqual(g.log[0], ['allow', 'gemini', 'pencil', true]);
  const usd = (1200 * 0.75 + 800 * 3.75) / 1e6;
  assert.ok(Math.abs(g.log[1][3] - usd) < 1e-12, 'recorded at the guard\u2019s price');
  // What reached the model: the photo (no location in it) and one fixed sentence.
  assert.strictEqual(fakeGemini.calls.length, 1);
  const body = fakeGemini.calls[0];
  assert.deepStrictEqual(body.contents.length, 1);
  const parts = body.contents[0].parts;
  assert.deepStrictEqual(parts.map((p) => Object.keys(p).join()), ['inlineData', 'text']);
  assert.strictEqual(parts[1].text, gemini.TEXT);
  const sent = Buffer.from(parts[0].inlineData.data, 'base64');
  assert.ok(parts[0].inlineData.mimeType === 'image/jpeg' && !sent.includes(Buffer.from('GPSLatitude')) && !sent.includes(Buffer.from('Marrow')));
  assert.ok(!/ada|gemini\.|example\.com|Hearts/i.test(JSON.stringify(body.contents).replace(parts[0].inlineData.data, '') + body.systemInstruction.parts[0].text.replace(/Gemini/g, '')), 'nothing about the person or a game');
  assert.strictEqual(body.generationConfig.responseSchema, gemini.SCHEMA);
  assert.strictEqual(g.generated[0].model, 'gemini-3.8-flash');
  assert.strictEqual(fakeClient.calls.length, 0, 'Claude is not called');
  // The answer: numbers, how sure, and nothing the model added up.
  const p = r.data.proposal;
  assert.deepStrictEqual([p.players.map((x) => x.name), p.rows, p.cells[0], p.cells[2]], [['Wren', 'Odile', 'Jules'], [[55, 20, 85], [40, 110, 15], [null, 35, 60], [90, 5, 45], [25, 70, 30]], ['high', 'high', 'medium'], ['low', 'high', 'high']]);
  assert.ok(!('totals' in p) && !('total' in p));
  assert.deepStrictEqual(C.sheetUnclear(p), [[0, 2], [2, 0]], 'two cells for the person to check before anything is added');
  assert.deepStrictEqual(C.sheetTotals(p.rows), [210, 240, 235]);
  // On the person's ledger, and the usage row says which provider.
  const rows = await usage();
  assert.strictEqual(rows.length, rows0 + 1);
  const row = rows[rows.length - 1] && rows.find((x) => x.provider === 'gemini');
  assert.deepStrictEqual([row.app, row.model, row.route, row.inputTokens, row.outputTokens, row.uid], ['pencil', 'gemini-3.8-flash', 'sheet', 1200, 800, uidOf(mail('ada.gemini'))]);
  assert.ok(Math.abs(row.costUsd - usd) < 1e-12 && Math.abs(await spent('ada.gemini') - usd) < 1e-12);
  assert.ok(!store._dump().includes('Odile') && !JSON.stringify(rows).includes(parts[0].inlineData.data.slice(0, 40)), 'no sheet and no photo in any store');
});

test('the guard says no: its own message and code, 429 or 503, and no model call', async () => {
  const g = global.LAB_AI_GUARD = fakeGuard();
  const bo = await register('bo.gemini');
  const n0 = fakeGemini.calls.length;
  g.deny = { ok: false, status: 429, code: 'burst-minute', message: 'Lots of people are using AI right now - try again in a minute.' };
  const a = await bo('POST', '/api/ai/sheet', photo());
  assert.deepStrictEqual([a.status, a.data.code, a.data.error], [429, 'burst-minute', g.deny.message]);
  g.deny = { ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' };
  const b = await bo('POST', '/api/ai/sheet', photo());
  assert.deepStrictEqual([b.status, b.data.code, b.data.error], [503, 'monthly-cap', g.deny.message]);
  assert.deepStrictEqual([fakeGemini.calls.length, g.log.filter((x) => x[0] === 'record').length, await spent('bo.gemini')], [n0, 0, 0]);
  // A guard that breaks does not take the reader down (the identity gates have passed).
  g.deny = null; g.allow = async () => { throw new Error('boom'); };
  assert.strictEqual((await bo('POST', '/api/ai/sheet', photo())).status, 200);
});

test('hostile, empty and broken answers: cut to the limits with nothing passed on; 422; 502; 503; a billed failure is still recorded', async () => {
  const g = global.LAB_AI_GUARD = fakeGuard();
  const cy = await register('cy.gemini');
  fakeGemini.mode = 'inject';
  const inj = await cy('POST', '/api/ai/sheet', photo());
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]|\u202e|javascript:|https?:|www\.|evil\.example/i.test(inj.text), inj.text.slice(0, 300));
  const p = inj.data.proposal;
  assert.ok(p.players.length === 12 && p.rows.length === 60 && p.cells.length === 60 && !('extra' in p));
  assert.ok(p.cells.every((r) => r.length === 12 && r.every((c) => C.CONFIDENCE.includes(c))) && p.rows.every((r) => r.every((v) => v === null || (Number.isInteger(v) && v >= -9999 && v <= 99999))));
  assert.deepStrictEqual([p.rows[1][0], p.cells[1][0], p.rows[1][1], p.cells[1][1], p.cells[1][2]], [1, 'high', null, 'low', 'low'], 'a word or a huge number where a score goes is a blank to check');
  // Each failure below now falls back to Claude (the stand-in), which answers.
  const c0 = fakeClient.calls.length;
  fakeGemini.mode = 'blank';
  assert.strictEqual((await cy('POST', '/api/ai/sheet', photo())).status, 200, 'nothing read by Gemini: Claude reads it');
  fakeGemini.mode = 'junk';
  assert.strictEqual((await cy('POST', '/api/ai/sheet', photo())).status, 200);
  fakeGemini.mode = 'upstream403';
  const up = await cy('POST', '/api/ai/sheet', photo());
  assert.ok(up.status === 200 && !/stand-in|Vertex|Gemini/i.test(up.text), 'a provider error is not passed on');
  fakeGemini.mode = 'upstream429';
  const busy = await cy('POST', '/api/ai/sheet', photo());
  assert.strictEqual(busy.status, 200);
  assert.strictEqual(fakeClient.calls.length, c0 + 4, 'Claude answered each');
  const before = await spent('cy.gemini');
  const recs = g.log.filter((x) => x[0] === 'record' && x[1] === 'gemini').length;
  fakeGemini.mode = 'billedfail';
  const bf = await cy('POST', '/api/ai/sheet', photo());
  assert.strictEqual(bf.status, 200);
  assert.strictEqual(g.log.filter((x) => x[0] === 'record' && x[1] === 'gemini').length, recs + 1, 'billed though it failed: on the lab\u2019s month');
  assert.ok(await spent('cy.gemini') > before, 'and on the person\u2019s ledger');
  // Both fail: Claude's own error, never provider text.
  fakeGemini.mode = 'upstream500'; fakeClient.mode = 'upstream500';
  const both = await cy('POST', '/api/ai/sheet', photo());
  assert.ok(both.status === 502 && !/stand-in|Vertex|Gemini/i.test(both.text), both.text);
});

test('Gemini fails, Claude answers: a thrown error, unusable output, Gemini\u2019s monthly cap; a burst refusal is the guard\u2019s 429 with no Claude call; one log line each', async () => {
  const g = global.LAB_AI_GUARD = fakeGuard();
  const ed = await register('ed.gemini');
  const warn = console.warn; const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    let c0 = fakeClient.calls.length;
    fakeGemini.mode = 'upstream500';
    let r = await ed('POST', '/api/ai/sheet', photo());
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(g.log.map((x) => x.slice(0, 2)), [['allow', 'gemini'], ['allow', 'claude'], ['record', 'claude']]);
    assert.strictEqual(fakeClient.calls.length, c0 + 1);
    g.log.length = 0;
    fakeGemini.mode = 'blank';
    r = await ed('POST', '/api/ai/sheet', photo());
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(g.log.map((x) => x.slice(0, 2)), [['allow', 'gemini'], ['record', 'gemini'], ['allow', 'claude'], ['record', 'claude']], 'the Gemini call that billed is recorded, then Claude');
    g.log.length = 0;
    g.denyFor = { gemini: { ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' } };
    const n0 = fakeGemini.calls.length;
    r = await ed('POST', '/api/ai/sheet', photo());
    assert.deepStrictEqual([r.status, fakeGemini.calls.length], [200, n0]);
    assert.deepStrictEqual(g.log.map((x) => x.slice(0, 2)), [['allow', 'gemini'], ['allow', 'claude'], ['record', 'claude']]);
    for (const code of ['burst-minute', 'burst-day']) {
      g.log.length = 0;
      g.denyFor = { gemini: { ok: false, status: 429, code, message: 'Lots of people are using AI right now - try again in a minute.' } };
      c0 = fakeClient.calls.length;
      r = await ed('POST', '/api/ai/sheet', photo());
      assert.deepStrictEqual([r.status, r.data.code, r.data.error, fakeClient.calls.length, g.log.length], [429, code, 'Lots of people are using AI right now - try again in a minute.', c0, 1]);
    }
  } finally { console.warn = warn; g.denyFor = null; }
  assert.deepStrictEqual(lines, ['[pencil] gemini failed (http); used claude', '[pencil] gemini failed (unusable); used claude', '[pencil] gemini failed (monthly-cap); used claude']);
});

test('no guard loaded (the app on its own): the stand-in still answers; and no request left this machine', async () => {
  delete global.LAB_AI_GUARD;
  const di = await register('di.gemini');
  const r = await di('POST', '/api/ai/sheet', photo());
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(C.sheetUnclear(r.data.proposal), [[0, 2], [2, 0]]);
  assert.ok(await spent('di.gemini') > 0);
  assert.strictEqual(outside, 0);
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
