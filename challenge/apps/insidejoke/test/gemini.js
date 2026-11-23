// Inside Joke on Gemini: the same routes with INSIDEJOKE_AI_PROVIDER=gemini,
// plus "Make a round".
//   INSIDEJOKE_AI_PROVIDER=gemini INSIDEJOKE_MEMORY=1 INSIDEJOKE_FAKE_AI=1 node test/gemini.js
//
// Driven over HTTP under an /insidejoke mount against the memory store, the
// stand-in and a fake lab guard. Any request that leaves 127.0.0.1 fails.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

if (process.env.INSIDEJOKE_MEMORY !== '1' || process.env.INSIDEJOKE_FAKE_AI !== '1' || process.env.INSIDEJOKE_AI_PROVIDER !== 'gemini') {
  console.error('run with INSIDEJOKE_AI_PROVIDER=gemini INSIDEJOKE_MEMORY=1 INSIDEJOKE_FAKE_AI=1');
  process.exit(1);
}

const realFetch = globalThis.fetch;
let outside = 0;
globalThis.fetch = (url, ...rest) => { if (!/^http:\/\/127\.0\.0\.1:/.test(String(url))) { outside++; return Promise.reject(new Error('network')); } return realFetch(url, ...rest); };

const C = require('../public/ij-core');
const gemini = require('../lib/gemini');
const { app, identityStore, store, PROVIDER, fakeGemini } = require('../server');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/** A lab guard that records what it was asked, and can say no. */
function fakeGuard() {
  const g = {
    log: [], deny: null, generated: [],
    async allow(a) { g.log.push(['allow', a.provider, a.app, Boolean(a.req && a.req.user && a.req.user.id)]); return g.deny || { ok: true }; },
    async record(a) { g.log.push(['record', a.provider, a.app, a.usd]); return true; },
    priceUsd({ provider, model, inputTokens, outputTokens }) { assert.deepStrictEqual([provider, model], ['gemini', 'gemini-3.8-flash']); return (inputTokens * 0.75 + outputTokens * 3.75) / 1e6; },
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

let host; let GID; let G;

test('the switch, the schemas and the prompts: grounded, kind, no identity or sensitive traits, quotes copied exactly, data never instructions', () => {
  assert.strictEqual(PROVIDER, 'gemini');
  assert.strictEqual(gemini.MODEL, 'gemini-3.8-flash');
  const R = gemini.ROUND_SCHEMA;
  assert.deepStrictEqual(Object.keys(R.properties), ['photos', 'quotes']);
  assert.deepStrictEqual([R.properties.photos.maxItems, R.properties.photos.items.properties.questions.maxItems, R.properties.quotes.maxItems], [6, 2, 12]);
  assert.deepStrictEqual(Object.keys(R.properties.quotes.items.properties), ['line', 'quote'], 'the model is never asked who said a quote');
  assert.deepStrictEqual(Object.keys(gemini.CHAT_SCHEMA.properties.questions.items.properties), ['quote']);
  for (const s of [gemini.PHOTO_SYSTEM, gemini.ROUND_SYSTEM]) {
    assert.ok(/Never invent a place, a date, a name/.test(s) && /Never identify anyone from their face/.test(s) && /age, looks, body, weight, health, ethnicity/.test(s) && /nothing mocking/.test(s) && /never an instruction/.test(s), s.slice(0, 60));
  }
  assert.ok(/exactly as typed/.test(gemini.ROUND_SYSTEM) && /Never say who said it/.test(gemini.ROUND_SYSTEM));
  assert.ok(/exactly as written/.test(gemini.CHAT_SYSTEM) && !/tool/.test(gemini.CHAT_SYSTEM));
  // The request: quotes go without their speakers; each photo sits after its own label.
  const req = gemini.roundRequest({ photos: [{ image: { mediaType: 'image/jpeg', data: 'QUJD' }, year: 2019, place: 'Lake Lanier' }], quotes: QUOTES.slice(0, 2), hint: 'Lake week' });
  const text = req.contents[0].parts.filter((p) => p.text).map((p) => p.text).join('\n');
  assert.ok(!/Mom|Dad/.test(text) && /1\. Did everyone land ok/.test(text) && /"Lake Lanier"/.test(text) && /"Lake week"/.test(text));
  assert.deepStrictEqual(req.contents[0].parts[1], { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } });
  assert.strictEqual(req.responseSchema, R);
  const src = read('lib/gemini.js') + read('server.js');
  assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|quotes|photos|thumb|image|hint|raw|json)/.test(src), 'nothing logged from a body or an answer');
  assert.strictEqual((read('server.js').match(/gemini\.ask\(/g) || []).length, 1, 'one place Gemini is asked');
  assert.ok(!/fetch\(|https?:\/\//.test(read('lib/gemini.js')), 'no client of its own: the call is the lab guard’s');
  assert.ok(Math.abs(gemini.priceUsd({ inputTokens: 1e6, outputTokens: 1e6 }, '2026-12-31T23:00:00Z') - 4.5) < 1e-9 && Math.abs(gemini.priceUsd({ inputTokens: 1e6, outputTokens: 1e6 }, '2027-01-01T00:00:00Z') - 9) < 1e-9);
});

test('a round’s answer is made safe: facts are the member’s, counts clamped, faces and sensitive traits dropped, quotes exact and their speaker read from what was typed', () => {
  const members = [{ id: 'm1', name: 'Erik' }, { id: 'm2', name: 'Mom' }, { id: 'm3', name: 'Dad' }, { id: 'm4', name: 'Ana' }];
  const PID = Array.from({ length: 9 }, () => require('../lib/groups').newId());
  const photos = [1, 2].map((i) => ({ photoId: PID[i], seed: PID[i], year: i === 1 ? 2019 : null, place: i === 1 ? 'Lake Lanier' : null, uploader: members[0], members }));
  const quotes = C.cleanExcerpt(QUOTES);
  const raw = {
    photos: [
      { photo: 1, usable: true, questions: [
        { type: 'where', prompt: 'Where?', options: ['Lake Tahoe', 'Lake Lanier', 'Lake Como'], answerIndex: 0 },
        { type: 'when', prompt: 'What year?', options: ['1999'], answerIndex: 0 },
        { type: 'caption_this', prompt: 'Caption this!', options: ['A', 'B', 'C'], answerIndex: null },
      ] },
      { photo: 2, usable: true, questions: [
        { type: 'where', prompt: 'Where is this?', options: ['Rome', 'Paris', 'Oslo'], answerIndex: 0 },
        { type: 'whats_happening', prompt: 'Who is the woman on the left?', options: ['Mom', 'Ana'], answerIndex: 0 },
        { type: 'odd_one_out', prompt: 'Which of them looks the most overweight?', options: ['Left', 'Right', 'Middle'], answerIndex: 0 },
        { type: 'whats_happening', prompt: 'What is on the table?', options: ['A <b>cake</b>', 'A very old, sick dog', 'A map'], answerIndex: 0 },
        { type: 'caption_this', prompt: 'Caption this!', options: ['Snow day', 'Too cold', 'Send cocoa'], answerIndex: null },
      ] },
      { photo: 2, usable: true, questions: [{ type: 'caption_this', prompt: 'again', options: ['x', 'y', 'z'], answerIndex: null }] },
      { photo: 3, usable: true, questions: [{ type: 'caption_this', prompt: 'no such photo', options: ['x', 'y', 'z'], answerIndex: null }] },
      { photo: 'one', usable: true, questions: [] }, null,
    ],
    quotes: [
      { line: 1, quote: 'Did everyone land ok?', speaker: 'Dad' },
      { line: 2, quote: 'Who moved my chair again' },
      { line: 2, quote: 'Who moved my chair again' },
      { line: 3, quote: 'I am never camping with you again' },
      { line: 4, quote: 'call me on [phone] about the boat trailer' },
      { line: 1, quote: 'ok' }, { quote: 5 }, 'x',
    ],
  };
  const out = gemini.cleanRound(raw, { photos, quotes, members, seed: 's' });
  const p1 = out.questions.filter((q) => q.photoId === PID[1]);
  assert.deepStrictEqual(p1.map((q) => q.style), ['where', 'when'], 'two a photo');
  assert.strictEqual(p1[0].options[p1[0].answer], 'Lake Lanier');
  assert.strictEqual(p1[0].options.filter((o) => o === 'Lake Lanier').length, 1);
  assert.deepStrictEqual([p1[1].answer, p1[1].tolerance], [2019, 1], 'the year is the member’s, never the model’s');
  const p2 = out.questions.filter((q) => q.photoId === PID[2]);
  assert.deepStrictEqual(p2.map((q) => q.style), ['caption_this'], 'no place so no where; the face ask, the body ask and the one with a sensitive answer are dropped; a second go is ignored');
  const said = out.questions.filter((q) => q.style === 'who_said');
  assert.deepStrictEqual(said.map((q) => [q.quote, q.options[q.answer]]), [['Did everyone land ok?', 'Mom'], ['Who moved my chair again', 'Dad']], 'exact, once each, the speaker from the typed line');
  assert.ok(said.every((q) => q.options.length === 4 && new Set(q.options).size === 4), 'other answers: the other people quoted, then members');
  assert.deepStrictEqual(out.photoIds.slice().sort(), [PID[1], PID[2]].sort());
  assert.ok(!JSON.stringify(out).includes('<b>'));
  // One speaker only: the other answers come from the group.
  const solo = gemini.cleanRound({ photos: [], quotes: [{ line: 1, quote: 'Who moved my chair again' }] }, { photos: [], quotes: C.cleanExcerpt([QUOTES[1]]), members, seed: 's' });
  assert.deepStrictEqual(solo.questions[0].options.slice().sort(), ['Ana', 'Dad', 'Erik', 'Mom']);
  // Clamped: never more than 15 questions, however many came back.
  const many = { photos: [1, 2, 3, 4, 5, 6].map((i) => ({ photo: i, usable: true, questions: raw.photos[0].questions })), quotes: [] };
  const six = [1, 2, 3, 4, 5, 6].map((i) => ({ ...photos[0], photoId: PID[i + 2], seed: PID[i + 2] }));
  assert.strictEqual(gemini.cleanRound(many, { photos: six, quotes: [], members, seed: 's' }).questions.length, 12);
  for (const junk of [null, [], 'x', { photos: 'no', quotes: 7 }]) assert.deepStrictEqual(gemini.cleanRound(junk, { photos, quotes, members, seed: 's' }), { questions: [], photoIds: [] });
});

test('a host and a member; the page is told a round can be made', async () => {
  global.LAB_AI_GUARD = fakeGuard();
  host = await register('host.gem');
  const r = await host('POST', '/api/groups', { name: 'The Strongs', tz: 'America/New_York', host: { name: 'Erik', emoji: '🎸', color: 'ocean' } });
  assert.strictEqual(r.status, 200, r.text);
  GID = r.data.group.id;
  G = `/api/groups/${GID}`;
  for (const name of ['Mom', 'Dad', 'Ana']) assert.strictEqual((await client()('POST', `/api/code/${r.data.group.code}/join`, { name, emoji: '😀', color: 'basil' })).status, 200);
  const meta = (await client()('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.ai.round, meta.limits.roundPhotos, meta.limits.roundQuotes], [true, 6, 12]);
});

test('make a round: gates and membership before the body, checks before the guard, the guard before the model', async () => {
  const g = global.LAB_AI_GUARD = fakeGuard();
  const big = { photos: [{ thumb: 'A'.repeat(6 * 1024 * 1024) }] };
  assert.strictEqual((await client()('POST', `${G}/round`, big)).status, 401, 'signed out: 401, not 413');
  const stranger = await register('stranger.gem');
  assert.strictEqual((await stranger('POST', `${G}/round`, big)).status, 404, 'not a member: the 404 a missing group gets, not 413');
  assert.strictEqual((await host('POST', `${G}/round`, big)).status, 413);
  const before = (await usage()).length;
  for (const [body, why] of [
    [{ photos: [], quotes: [QUOTES[0]] }, 'one quote and no photo'],
    [{ photos: Array.from({ length: 7 }, () => onePhoto()) }, 'seven photos'],
    [{ photos: [], quotes: Array.from({ length: 13 }, () => QUOTES[0]) }, 'thirteen quotes'],
    [{ photos: [{ ...onePhoto(), image: { type: 'image/jpeg', data: Buffer.concat([Buffer.from(jpg(10, 10), 'base64'), Buffer.alloc(320 * 1024)]).toString('base64') } }] }, 'a photo over 300 KB'],
    [{ photos: [{ ...onePhoto(), thumb: jpg(1600, 1200) }] }, 'a thumbnail too big a side'],
    [{ photos: ['x'] }, 'not a photo'],
  ]) assert.strictEqual((await host('POST', `${G}/round`, body)).status, 400, why);
  assert.strictEqual(g.log.length, 0, 'a bad request never counts against the guard');
  g.deny = { ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' };
  const no = await host('POST', `${G}/round`, { photos: [onePhoto()], quotes: QUOTES });
  assert.deepStrictEqual([no.status, no.data.code, no.data.error], [503, 'monthly-cap', 'AI answers are resting until next month; everything else still works.']);
  await settle();
  assert.deepStrictEqual([fakeGemini.calls.length, g.generated.length, (await usage()).length, g.log.filter((x) => x[0] === 'record').length], [0, 0, before, 0], 'no call, nothing charged');
});

test('make a round: one call for photos and typed quotes; drafts to review; thumbnails only; charged to the lab’s month and the person’s ledger', async () => {
  const g = global.LAB_AI_GUARD = fakeGuard();
  const rows = (await usage()).length;
  const r = await host('POST', `${G}/round`, { photos: [onePhoto(), onePhoto('', { place: '', year: null }), onePhoto('BLANK'), onePhoto('FACE')], quotes: QUOTES, hint: 'Lake week, the cake fell in' });
  assert.strictEqual(r.status, 200, r.text.slice(0, 300));
  assert.ok(r.text.startsWith(' '), 'the answer streams whitespace first');
  assert.ok(!r.data.error, r.text.slice(0, 300));
  assert.deepStrictEqual([fakeGemini.calls.length, g.generated.length], [1, 1], 'one call');
  assert.deepStrictEqual(g.log[0], ['allow', 'gemini', 'insidejoke', true]);
  const body = g.generated[0];
  assert.strictEqual(body.model, 'gemini-3.8-flash');
  assert.strictEqual(body.responseSchema, gemini.ROUND_SCHEMA);
  assert.strictEqual(body.contents[0].parts.filter((p) => p.inlineData).length, 4);
  const told = body.contents[0].parts.filter((p) => p.text).map((p) => p.text).join('\n') + body.systemInstruction;
  assert.ok(!/Mom|Dad|Ana|Erik|host\.gem|example\.com|Strongs|404 555/.test(told), 'no speaker, member, group or account goes to the model; phone numbers are stripped first');
  assert.ok(/\[phone\]/.test(told));
  const qs = r.data.questions;
  assert.ok(qs.every((q) => q.status === 'draft'));
  assert.strictEqual(r.data.photos.length, 2, 'the blank and the faces-only photo are not kept');
  const byPhoto = r.data.photos.map((p) => qs.filter((q) => q.photoId === p.id).map((q) => q.style));
  assert.deepStrictEqual(byPhoto, [['where', 'when'], ['whats_happening', 'caption_this']], 'two a photo; no place and no year means no where and no when; the age question and the second go are dropped');
  const where = qs.find((q) => q.style === 'where');
  assert.strictEqual(where.options[where.answer], 'Lake Lanier');
  const said = qs.filter((q) => q.style === 'who_said');
  assert.deepStrictEqual(said.map((q) => [q.quote, q.options[q.answer]]), [['Did everyone land ok? Text me when you do', 'Mom'], ['Who moved my chair again, I had it just right', 'Dad'], ['I am never camping with you people again lol', 'Ana']], 'the invented, the paraphrased and the [phone] quote are dropped; speakers are the typed ones');
  // What is stored: thumbnails (stripped) and drafts. No model copy, no quotes list, no note.
  const dump = store._dump();
  assert.ok(!dump.includes(MARK) && !dump.includes(Buffer.from(MARK).toString('base64').slice(0, 12)), 'the model’s copies are not stored');
  assert.ok(!dump.includes('the cake fell in') && !dump.includes('boat trailer') && !dump.includes('GPSLAT'), 'the note, unused quotes and locations are not stored');
  const stored = await store.get('photos', r.data.photos[0].id);
  assert.deepStrictEqual(Object.keys(stored).sort(), ['by', 'bytes', 'createdAt', 'gid', 'height', 'id', 'thumb', 'width']);
  assert.strictEqual((await store.get('groups', GID)).photoCount, 2);
  // Paid for: the lab's month and the person's own ledger, at Gemini's price.
  await settle();
  const usd = (1200 * 0.75 + 800 * 3.75) / 1e6;
  const rec = g.log.filter((x) => x[0] === 'record');
  assert.deepStrictEqual(rec.map((x) => x.slice(0, 3)), [['record', 'gemini', 'insidejoke']]);
  assert.ok(Math.abs(rec[0][3] - usd) < 1e-12);
  const row = (await usage()).slice(rows);
  assert.strictEqual(row.length, 1);
  assert.deepStrictEqual([row[0].app, row[0].route, row[0].uid], ['insidejoke', 'round:gemini-3.8-flash', uidOf(mail('host.gem'))]);
  assert.ok(Math.abs(row[0].costUsd - usd) < 1e-6 && Math.abs(await spent('host.gem') - row[0].costUsd) < 1e-9);
  // The host reviews: edit, delete, publish. A typed speaker cannot be edited away.
  const before = (await host('GET', `${G}/questions`)).data.counts.live;
  const ed = await host('PUT', `${G}/questions/${said[0].id}`, { question: { prompt: 'Who texted this?', options: ['Nobody', 'Somebody'], answer: 0 } });
  assert.strictEqual(ed.data.question.options[ed.data.question.answer], 'Mom');
  assert.strictEqual((await host('DELETE', `${G}/questions/${said[2].id}`)).status, 200);
  assert.strictEqual((await host('POST', `${G}/questions/publish`, { ids: qs.map((q) => q.id) })).data.published, qs.length - 1);
  assert.strictEqual((await host('GET', `${G}/questions`)).data.counts.live, before + qs.length - 1);
});

test('make a round: quotes alone; nothing fair is a 422 sentence; a provider failure is never passed on, and one that billed is still paid for', async () => {
  const g = global.LAB_AI_GUARD = fakeGuard();
  const only = await host('POST', `${G}/round`, { photos: [], quotes: QUOTES.slice(0, 2) });
  assert.deepStrictEqual(only.data.questions.map((q) => q.style), ['who_said', 'who_said'], only.text.slice(0, 200));
  assert.strictEqual(g.generated[0].contents[0].parts.filter((p) => p.inlineData).length, 0);
  assert.match((await host('POST', `${G}/round`, { photos: [onePhoto('BLANK'), onePhoto('FACE')] })).data.error, /No fair questions/);
  assert.match((await host('POST', `${G}/round`, { photos: [], quotes: [{ n: 'Mom', t: 'INVENTED things are said here' }, QUOTES[1]] })).data.error, /No fair questions/);
  assert.match((await host('POST', `${G}/round`, { photos: [onePhoto('JUNK')] })).data.error, /expected shape/);
  const up = await host('POST', `${G}/round`, { photos: [onePhoto('UPSTREAM401')] });
  assert.ok(up.data.error && !/stand-in|Vertex|Gemini/i.test(up.text), up.text);
  assert.match((await host('POST', `${G}/round`, { photos: [onePhoto('UPSTREAM429')] })).data.error, /AI is busy/);
  const recs = g.log.filter((x) => x[0] === 'record').length;
  const was = await spent('host.gem');
  const bill = await host('POST', `${G}/round`, { photos: [onePhoto('BILLEDFAIL')] });
  assert.ok(bill.data.error && !/stand-in/.test(bill.text));
  await settle();
  assert.strictEqual(g.log.filter((x) => x[0] === 'record').length, recs + 1, 'billed although it failed: recorded');
  assert.ok(await spent('host.gem') > was, 'and on the person’s ledger');
  assert.strictEqual((await store.get('groups', GID)).photoCount, 2, 'a failed round keeps no photo');
});

test('one photo and a chat excerpt go to Gemini too, with the same cleaning and the same drafts', async () => {
  const g = global.LAB_AI_GUARD = fakeGuard();
  const p = await host('POST', `${G}/photos`, { ...onePhoto(), hint: 'Dad’s birthday' });
  assert.deepStrictEqual(p.data.questions.map((q) => q.style).sort(), ['caption_this', 'when', 'where'], p.text.slice(0, 200));
  assert.strictEqual(g.generated[0].responseSchema, gemini.PHOTO_SCHEMA);
  assert.match((await host('POST', `${G}/photos`, onePhoto('FACE'))).data.error, /No fair questions/);
  const inj = await host('POST', `${G}/photos`, onePhoto('INJECT'));
  assert.ok(inj.data.questions.length && !/<|onerror|A{200}/.test(JSON.stringify(inj.data.questions)) && inj.data.questions.every((q) => !C.FACE_ASK.test(q.prompt)));
  const names = ['Mom', 'Dad', 'Ana', 'Ben'];
  const excerpt = Array.from({ length: 24 }, (_, i) => ({ n: names[i % 4], t: `message number ${i} from ${['the lake', 'the cabin', 'the car', 'the beach'][i % 4]} with love today` }));
  const c = await host('POST', `${G}/chat`, { excerpt });
  assert.ok(c.data.questions.length >= 3 && c.data.questions.every((q) => q.style === 'who_said' && excerpt.some((l) => l.t.includes(q.quote) && l.n === q.options[q.answer])), c.text.slice(0, 300));
  assert.strictEqual(g.generated[g.generated.length - 1].responseSchema, gemini.CHAT_SCHEMA);
  await settle();
  const routes = (await usage()).map((r) => r.route);
  assert.ok(routes.includes('photo:gemini-3.8-flash') && routes.includes('chat:gemini-3.8-flash'));
  assert.ok(g.log.filter((x) => x[0] === 'allow').every((x) => x[1] === 'gemini'));
});

test('a member with no account never reaches the model; the app on its own (no lab guard) still answers from the stand-in', async () => {
  delete global.LAB_AI_GUARD;
  const calls = fakeGemini.calls.length;
  const code = (await host('GET', G)).data.group.code;
  const guest = client();
  assert.strictEqual((await guest('POST', `/api/code/${code}/join`, { name: 'Cleo', emoji: '🦊', color: 'plum' })).status, 200);
  assert.strictEqual((await guest('POST', `${G}/round`, { photos: [], quotes: QUOTES })).status, 401);
  assert.strictEqual(fakeGemini.calls.length, calls);
  const r = await host('POST', `${G}/round`, { photos: [], quotes: QUOTES.slice(0, 2) });
  assert.strictEqual(r.data.questions.length, 2, r.text.slice(0, 200));
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
