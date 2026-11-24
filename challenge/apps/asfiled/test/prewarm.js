// The owner's batch, "Prepare likely lookups" (lib/prewarm.js and its two
// routes). No network: sec.gov is test/fixtures/sec and the model is
// lib/fakeai.js, as in test/lookup.js.

process.env.ASFILED_MEMORY = '1';
process.env.ASFILED_FAKE_AI = '1';
process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0';
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.env.ASFILED_FAKE_SEC = path.join(__dirname, 'fixtures', 'sec');
process.env.SEC_USER_AGENT = 'asfiled tests';
process.env.ASFILED_LOOKUP_PER_IP_HOUR = '1';      // a visitor's limit, which the batch must not meet

const assert = require('assert');
const fs = require('fs');
const express = require('express');
const sec = require('../tools/sec');
const T = require('../tools/text');
const V = require('../tools/verify');
const identityLib = require('../lib/identity');
const Prewarm = require('../lib/prewarm');
const { FILERS } = require('../tools/companies');

let n = 0;
const ok = (m) => { n += 1; console.log(`  ok ${n} - ${m}`); };
const H = 9900001; const TW = 9900002; const NF = 9900007; const MSFT = 789019;

(async () => {
  const { app, store, identityStore, lookup, relations, fakeClient } = require('../server.js');
  const host = express();
  host.set('trust proxy', 1);
  host.use('/asfiled', app);
  const server = await new Promise((r) => { const s = host.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/asfiled/`;
  const call = async (method, body, cookie, extra = {}) => {
    const r = await fetch(`${base}api/admin/prewarm`, { method, headers: { 'X-Forwarded-For': '10.9.0.1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const register = async (email) => {
    const r = await fetch(`${base}api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) });
    assert.strictEqual(r.status, 200);
    const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const me = await (await fetch(`${base}api/auth/me`, { headers: { Cookie: cookie } })).json();
    return { cookie, me };
  };
  const meOf = async (cookie) => (await fetch(`${base}api/auth/me`, { headers: { Cookie: cookie } })).json();
  try {
    /* ---------- the list ---------- */
    const inSet = new Set(FILERS.map((c) => c.id));
    const flat = Prewarm.DEFAULT.map((x) => [].concat(x)[0]);
    assert.strictEqual(flat.length, 28);
    assert.strictEqual(new Set(flat).size, 28);
    assert.deepStrictEqual(Prewarm.DEFAULT.flat().filter((t) => inSet.has(t)), [], 'nothing on the list is in the reviewed set');
    assert.ok(inSet.has('FICO') && inSet.has('INTU'));
    ok('the built-in list is 28 tickers, none of them in the reviewed set (FICO and INTU are, and are left off)');

    /* ---------- owner only ---------- */
    assert.strictEqual((await call('POST', {})).status, 401);
    assert.strictEqual((await call('GET')).status, 401);
    const member = await register('member@example.com');
    const owner = await register('owner@example.com');
    assert.strictEqual(member.me.admin, false);
    let r = await call('POST', { ciks: [H] }, member.cookie);
    assert.deepStrictEqual([r.status, r.body.code], [403, 'owner-only']);
    assert.strictEqual((await call('GET', null, member.cookie)).status, 403);
    await identityStore.merge(identityLib.USERS, owner.me.uid, { admin: true });
    assert.strictEqual((await meOf(owner.cookie)).admin, true);
    assert.strictEqual((await call('POST', { ciks: [H] }, owner.cookie, { Origin: 'https://evil.example.com' })).status, 403, 'another site cannot start it in the owner’s browser');
    assert.ok([403, 415].includes((await fetch(`${base}api/admin/prewarm`, { method: 'POST', headers: { Cookie: owner.cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'ciks=1' })).status), 'a form post is refused');
    assert.deepStrictEqual([sec.stats.requests, fakeClient.calls.length, await store.get('lookups', String(H))], [0, 0, null]);
    ok('signed out is 401, a member 403, another site 403 and a form post is refused - and none of them reached sec.gov, the model or the store');

    /* ---------- resolving the list by ticker ---------- */
    r = await call('GET', null, owner.cookie);
    assert.deepStrictEqual([r.status, r.body.total, r.body.ready, r.body.remaining, r.body.skipped.length, r.body.skipped.every((x) => x.code === 'not-found')], [200, 0, 0, 0, 28, true], 'none of the real tickers is in the fixture’s registrant list');
    const mine = Prewarm.create({ lookup, relations, list: ['HBLD', 'MSFT', ['NOPE', 'TDWA'], 'ZZZZ', 'HBLDW'] });
    const t = await mine.targets();
    assert.deepStrictEqual(t.list, [{ cik: H, ticker: 'HBLD' }, { cik: TW, ticker: 'TDWA' }]);
    assert.deepStrictEqual(t.skipped.map((x) => [x.ticker, x.code]), [['MSFT', 'in-set'], ['ZZZZ', 'not-found']]);
    ok('tickers are resolved by the lookup’s own registrant list; a company of the reviewed set and an unknown ticker are skipped, a second ticker is tried, a registrant is taken once');

    /* ---------- one company a call: remaining counts down ---------- */
    const ciks = [H, TW, NF, MSFT];
    r = await call('POST', { ciks, limit: 1 }, owner.cookie);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.done, [{ cik: H, ticker: 'HBLD', edges: 4 }]);
    assert.deepStrictEqual([r.body.total, r.body.ready, r.body.edges, r.body.remaining], [3, 1, 4, 2]);
    assert.deepStrictEqual(r.body.skipped, [{ cik: MSFT, ticker: 'MSFT', code: 'in-set', error: 'In the reviewed set already.' }]);
    assert.ok(r.body.costUsd > 0 && r.body.costUsd < 0.001, `one fixture run costs $${r.body.costUsd}`);
    assert.strictEqual(fakeClient.calls.length, 1);
    assert.strictEqual(fakeClient.calls[0].model, 'claude-haiku-5-5');
    // Exactly what a visitor's lookup and a member's run would have stored.
    const part = JSON.parse((await store.get('lookups', String(H))).json);
    const rel = await relations.read(H, part.company.annual.accn);
    assert.deepStrictEqual(rel.edges.map((e) => [e.from, e.to, e.type]), [[`X${H}`, `X${TW}`, 'competitor'], [`X${H}`, 'X9900003', 'competitor'], [`X${H}`, 'X9900003', 'customer'], ['AMZN', `X${H}`, 'supplier']]);
    const DOC = T.norm(T.htmlToText(fs.readFileSync(path.join(process.env.ASFILED_FAKE_SEC, 'www.sec.gov/Archives/edgar/data/9900001/000990000126000007/hbld-20251231.htm'), 'utf8')));
    for (const e of rel.edges) assert.ok(DOC.includes(e.quote) && e.proof === V.proof(T.sha(DOC), e.quote));
    const pub = await (await fetch(`${base}api/lookup/${H}`, { headers: { 'X-Forwarded-For': '10.9.0.50' } })).json();
    assert.deepStrictEqual(pub.relations.edges, rel.edges, 'a visitor opens it with the relationships there');
    // Recorded like a member's run: the identity's usage ledger, app asfiled.
    const usage = (await identityStore.list(identityLib.USAGE)).filter((u) => u.uid === owner.me.uid);
    assert.deepStrictEqual(usage.map((u) => [u.app, u.model, u.calls]), [['asfiled', 'claude-haiku-5-5', 1]]);
    ok('one call prepares one company - the stored part and four verified edges, as a visitor and a member would have left them - and says what remains and what it cost');

    /* ---------- the verifier still decides ---------- */
    fakeClient.mode = 'badquote';
    r = await call('POST', { ciks, limit: 1 }, owner.cookie);
    assert.deepStrictEqual(r.body.done, [{ cik: TW, ticker: 'TDWA', edges: 1 }]);
    assert.deepStrictEqual([r.body.ready, r.body.edges, r.body.remaining], [2, 5, 1]);
    const twPart = JSON.parse((await store.get('lookups', String(TW))).json);
    const twRel = await relations.read(TW, twPart.company.annual.accn);
    assert.deepStrictEqual(twRel.stats, { sentences: 2, sent: 1, proposed: 2, kept: 1, dropped: { 'quote not found verbatim in the source': 1 } });
    assert.deepStrictEqual(twRel.edges.map((e) => [e.from, e.to, e.type, e.quote]), [[`X${TW}`, `X${H}`, 'competitor', 'We compete with Harborlight Data in the market for income verification and consumer credit analytics.']]);
    assert.ok(!JSON.stringify(await store.get('relations', String(TW))).includes('sole supplier of the data'));
    ok('in the batch a quote the model made up is dropped by the verifier and never stored; the sentence that is in the report is kept');

    /* ---------- what cannot be read is skipped and said ---------- */
    r = await call('POST', { ciks }, owner.cookie);
    assert.deepStrictEqual(r.body.done, []);
    assert.deepStrictEqual(r.body.skipped.map((x) => [x.cik, x.code]), [[MSFT, 'in-set'], [NF, 'no-annual']]);
    assert.deepStrictEqual([r.body.total, r.body.ready, r.body.remaining, r.body.costUsd], [3, 2, 0, 0]);
    assert.strictEqual(fakeClient.calls.length, 2);
    ok('a company with no annual report is skipped with its reason, costs nothing, and remaining reaches 0');

    /* ---------- stored relations are never run again ---------- */
    let before = sec.stats.requests;
    r = await call('POST', { ciks, skip: [NF], limit: 5 }, owner.cookie);
    assert.deepStrictEqual([r.body.done, r.body.ready, r.body.remaining, r.body.costUsd], [[], 2, 0, 0]);
    assert.deepStrictEqual([sec.stats.requests - before, fakeClient.calls.length], [0, 2]);
    r = await call('GET', null, owner.cookie);
    assert.strictEqual(r.status, 200);
    // A stale part is read again (no model); its relations stand while the annual report is the same.
    const doc = await store.get('lookups', String(H));
    await store.set('lookups', String(H), { ...doc, at: Date.now() - 8 * 86400000 });
    before = sec.stats.requests;
    r = await call('POST', { ciks, skip: [NF] }, owner.cookie);
    assert.deepStrictEqual([r.body.done, r.body.costUsd, fakeClient.calls.length, sec.stats.requests - before], [[{ cik: H, ticker: 'HBLD', edges: 4 }], 0, 2, 5]);
    ok('a company whose relations are stored is skipped: no request to sec.gov and no model call; a part past seven days is refreshed without a model');

    /* ---------- the lab's AI guard is respected ---------- */
    const guardLib = require('../../../lib/ai-guard');
    const quiet = { error() {}, warn() {}, log() {}, info() {} };
    const forget = async () => { await store.remove('relations', String(H)); await store.remove('relations', String(TW)); };
    // The shared book, one a minute: the first company runs, the second is refused and the batch stops.
    const book = guardLib.memoryStore();
    let guard = guardLib.create({ store: book, env: { LAB_AI_BURST_MINUTE: '1' }, log: quiet });
    global.LAB_AI_GUARD = guard;
    await forget();
    r = await call('POST', { ciks, skip: [NF], limit: 5 }, owner.cookie);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual([r.body.done.map((x) => x.cik), r.body.stopped, r.body.remaining], [[H], { code: 'burst-minute', error: guard.MESSAGES['burst-minute'] }, 1]);
    assert.strictEqual(fakeClient.calls.length, 3, 'no model call for the refused company');
    assert.strictEqual(await store.get('relations', String(TW)), null);
    const month = (await book.get(guardLib.COLLECTION, `claude-${guardLib.monthOf(Date.now())}`)).usd;
    assert.ok(month > 0 && Math.abs(month - r.body.costUsd) < 1e-6, 'the run is recorded against the month’s Claude total, and costUsd is that amount');
    // The batch's own book, by the existing per-app setting: both run.
    guard = guardLib.create({ store: guardLib.memoryStore(), env: { LAB_AI_BURST_MINUTE: '1', LAB_AI_BURST_APP_ASFILEDBATCH: '5/50' }, log: quiet });
    global.LAB_AI_GUARD = guard;
    await forget();
    r = await call('POST', { ciks, skip: [NF], limit: 5 }, owner.cookie);
    assert.deepStrictEqual([r.body.done.map((x) => x.cik), r.body.stopped, r.body.remaining], [[H, TW], undefined, 0]);
    assert.strictEqual(fakeClient.calls.length, 5);
    // Over the month's cap: refused before any call, whatever the book.
    guard = guardLib.create({ store: guardLib.memoryStore(), env: { LAB_AI_CAP_CLAUDE_USD: '0.00001', LAB_AI_BURST_APP_ASFILEDBATCH: '5/50' }, log: quiet });
    global.LAB_AI_GUARD = guard;
    await guard.record({ provider: 'claude', app: 'asfiled', usd: 0.01 });
    await forget();
    r = await call('POST', { ciks, skip: [NF], limit: 5 }, owner.cookie);
    assert.deepStrictEqual([r.body.done, r.body.stopped.code, r.body.remaining, r.body.costUsd], [[], 'monthly-cap', 2, 0]);
    assert.strictEqual(fakeClient.calls.length, 5);
    assert.strictEqual(await store.get('relations', String(H)), null);
    delete global.LAB_AI_GUARD;
    ok('the AI guard decides: a burst refusal stops the batch after what it allowed, LAB_AI_BURST_APP_ASFILEDBATCH gives it its own book, and over the month’s cap nothing is asked of the model');

    /* ---------- a failed model call, and the time limit ---------- */
    fakeClient.mode = 'error';
    r = await call('POST', { ciks, skip: [NF], limit: 1 }, owner.cookie);
    assert.deepStrictEqual([r.body.done, r.body.skipped.filter((x) => x.code !== 'in-set').map((x) => [x.cik, x.code]), r.body.remaining], [[], [[H, 'ai']], 1]);
    assert.strictEqual(await store.get('relations', String(H)), null);
    let asked = 0;
    const late = await Prewarm.create({ lookup, relations }).run({ ciks, deadline: 0, relate: async () => { asked += 1; return {}; } });
    assert.deepStrictEqual([late.done, asked, late.remaining], [[], 0, 3]);
    r = await call('POST', { ciks: [H, TW], limit: 99 }, owner.cookie);
    assert.deepStrictEqual(r.body.done.map((x) => x.cik), [H, TW]);
    assert.strictEqual(Prewarm.PER_CALL_MAX, 5);
    assert.strictEqual((await call('POST', { ciks: ['x', -1, 1.5, null] }, owner.cookie)).body.total, 0);
    ok('a model call that fails skips that company and stores nothing; no company is started past the deadline; at most five a call; a malformed list prepares nothing');

    /* ---------- the page: a row only the owner is shown ---------- */
    const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.ok(!html.includes('Prepare likely lookups') && !html.includes('prewarm'));
    assert.strictEqual(js.match(/prepareRow\(\)/g).length, 2, 'defined once, drawn in one place');
    assert.ok(/if \(m && m\.signedIn && m\.admin === true\) ownerSlot\.appendChild\(prepareRow\(\)\)/.test(js), 'drawn only when /me says admin');
    assert.ok(js.includes("text: 'Prepare likely lookups'") && js.includes("' ready · '") && js.includes("btn.textContent = 'Stop'"));
    assert.ok(/api\('GET', 'api\/admin\/prewarm'\)/.test(js) && /api\('POST', 'api\/admin\/prewarm', \{ skip: skip \}\)/.test(js));
    assert.strictEqual((await meOf(member.cookie)).admin, false);
    assert.strictEqual((await (await fetch(`${base}api/auth/me`)).json()).signedIn, false);
    ok('the page draws "Prepare likely lookups" only when /me says admin: a member and a signed-out visitor get no row (and the routes refuse them)');

    /* ---------- one model call in the app; the batch makes no request of its own ---------- */
    const code = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/\bfetch\(|https?\.request|messages\.create|anthropic|setTimeout|setInterval|process\.env/i.test(code('lib/prewarm.js')));
    assert.strictEqual(code('server.js').match(/messages\.create/g).length, 1);
    assert.ok(!/setTimeout|setInterval/.test(code('server.js')));
    ok('lib/prewarm.js holds no model call, no request, no timer and reads no environment; the server still has one model call and no timer');
  } finally { server.close(); }

  console.log(`\n${n} checks passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
