// The on-request lookup and "Find relationships". No network: sec.gov is a
// directory of made-up files in the real shapes (test/fixtures/sec, written
// by test/fixtures/make.js), and the model is lib/fakeai.js.

process.env.ASFILED_MEMORY = '1';
process.env.ASFILED_FAKE_AI = '1';
process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0';
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.env.ASFILED_FAKE_SEC = path.join(__dirname, 'fixtures', 'sec');
const AGENT = process.env.SEC_USER_AGENT;          // a real one may be set on this machine; never used here
process.env.SEC_USER_AGENT = 'asfiled tests';
process.env.ASFILED_LOOKUP_PER_IP_HOUR = '4';

const assert = require('assert');
const fs = require('fs');
const express = require('express');
const Core = require('../public/asfiled-core');
const T = require('../tools/text');
const V = require('../tools/verify');
const sec = require('../tools/sec');
const Names = require('../lib/names');
const Lookup = require('../lib/lookup');
const Relations = require('../lib/relations');
const { memoryBackend } = require('../lib/store');

let n = 0;
const ok = (m) => { n += 1; console.log(`  ok ${n} - ${m}`); };
const H = 9900001; const ID = `X${H}`;
const DOC = fs.readFileSync(path.join(process.env.ASFILED_FAKE_SEC, 'www.sec.gov/Archives/edgar/data/9900001/000990000126000007/hbld-20251231.htm'), 'utf8');
const TEXT = T.norm(T.htmlToText(DOC));

(async () => {
  /* ---------- names: conservative by rule ---------- */
  assert.deepStrictEqual(Names.coresOf('EQUIFAX INC'), [['equifax']]);
  assert.deepStrictEqual(Names.coresOf('QUILLFEATHER SYSTEMS INC /DE/'), [['quillfeather', 'systems'], ['quillfeather']]);
  for (const t of ['TARGET CORP', 'Block, Inc.', 'Summit Corp', 'ON Semiconductor'.slice(0, 2), 'General Motors Co', 'Visa Inc.', 'Global Payments Inc', 'IT Corp']) assert.deepStrictEqual(Names.coresOf(t), [], t);
  const ix = Names.buildIndex([{ id: 'a', title: 'EQUIFAX INC' }, { id: 'b', title: 'Fair Isaac Corp' }, { id: 'c', title: 'Twin Name Inc' }, { id: 'd', title: 'TWIN NAME CORP' }, { id: 'f', title: 'Twin Name Ltd' }, { id: 'e', title: 'Tidewater Analytics Corp' }]);
  assert.deepStrictEqual(Names.find(ix, 'We compete with Equifax’s unit and Fair Isaac Corporation, but not the fair isaac of old.'), [{ id: 'a', surface: 'Equifax' }, { id: 'b', surface: 'Fair Isaac' }]);
  assert.deepStrictEqual(Names.find(ix, 'Equifax is the first word here, and Twin Name belongs to two registrants.'), []);
  assert.deepStrictEqual(Names.find(ix, 'Tidewater, Analytics and other words apart are not the name.'), []);
  assert.strictEqual(Names.display('AT&T INC.'), 'AT&T Inc.'); assert.strictEqual(Names.display('QUILLFEATHER SYSTEMS INC /DE/'), 'Quillfeather Systems Inc');
  ok('registrant names are looked for by rule: no tickers, no common single words, capitals required, a one-word name never as a sentence’s first word, a shared name is nobody’s');

  /* ---------- refused on Cloud Run ---------- */
  process.env.K_SERVICE = 'x';
  delete require.cache[require.resolve('../tools/sec')];
  assert.throws(() => require('../tools/sec'), /refused on Cloud Run/);
  delete process.env.K_SERVICE;
  delete require.cache[require.resolve('../tools/sec')];
  require.cache[require.resolve('../tools/sec')] = { id: require.resolve('../tools/sec'), filename: require.resolve('../tools/sec'), loaded: true, exports: sec };
  ok('ASFILED_FAKE_SEC is refused on Cloud Run');

  /* ---------- the server, mounted as the lab mounts it ---------- */
  const { app, store, fakeClient } = require('../server.js');
  const host = express();
  host.set('trust proxy', 1);
  host.use('/asfiled', app);
  const server = await new Promise((r) => { const s = host.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/asfiled/`;
  const get = (p, ip = '10.0.0.1') => fetch(base + p, { headers: { 'X-Forwarded-For': ip } });
  const json = async (p, ip) => { const r = await get(p, ip); return { status: r.status, body: await r.json() }; };
  try {
    /* ---------- Part 1: resolution ---------- */
    let r = await json('api/lookup?q=hbld');
    assert.deepStrictEqual(r.body.matches, [{ cik: H, ticker: 'HBLD', name: 'Harborlight Data Inc', inSet: null }]);
    assert.strictEqual(r.body.label, 'Looked up on request - not in the reviewed set');
    assert.strictEqual(sec.stats.requests, 1, 'the registrant list is fetched once');
    r = await json('api/lookup?q=Harborlight%20Data');
    assert.strictEqual(r.body.matches[0].cik, H);
    r = await json('api/lookup?q=msft');
    assert.deepStrictEqual(r.body.matches, [{ cik: 789019, ticker: 'MSFT', name: 'Microsoft Corp', inSet: 'MSFT' }]);
    assert.deepStrictEqual((await json('api/lookup?q=zzzz')).body.matches, []);
    assert.deepStrictEqual((await json(`api/lookup?q=${H}`)).body.matches.map((m) => m.ticker), ['HBLD']);
    assert.strictEqual(sec.stats.requests, 1);
    assert.ok((await store.get('tickers', 'meta')).parts >= 1 && /\tHBLD\t/.test((await store.get('tickers', 'p0')).text));
    ok('a name, ticker or CIK resolves against the SEC’s registrant list, fetched once and stored; a company of the reviewed set is pointed back to it');

    /* ---------- Part 1: the built part ---------- */
    r = await json(`api/lookup/${H}`);
    assert.strictEqual(r.status, 200);
    const part = r.body;
    assert.strictEqual(part.label, 'Looked up on request - not in the reviewed set');
    const co = part.company;
    assert.deepStrictEqual([co.id, co.cik, co.ticker, co.lookup, co.filer, co.layer, co.form, co.currency, co.latest], [ID, H, 'HBLD', true, true, 'lookup', '10-K', 'USD', 2025]);
    assert.deepStrictEqual(co.years, [2019, 2020, 2021, 2022, 2023, 2024, 2025]);
    assert.deepStrictEqual(co.annual, { accn: '0009900001-26-000007', period: '2025-12-31', filed: '2026-02-20', source: `${ID}-0009900001-26-000007` });
    const facts = JSON.parse(fs.readFileSync(path.join(process.env.ASFILED_FAKE_SEC, 'data.sec.gov/api/xbrl/companyfacts/CIK0009900001.json'), 'utf8')).facts['us-gaap'];
    for (const [fid, f] of Object.entries(part.figures)) {
      assert.ok(f.c === ID && /^\d{10}-\d{2}-\d{6}$/.test(f.a) && /^\d{4}-12-31$/.test(f.end) && f.fy === Core.fiscalYear(f.end) && f.tag && Number.isFinite(f.v), fid);
      assert.deepStrictEqual(part.filings[f.a].form, '10-K', fid);
      if (!f.x) {
        const rows = facts[f.tag.split(':')[1]].units.USD;
        assert.ok(rows.some((x) => x.accn === f.a && x.end === f.end && x.val === f.v && x.form === '10-K'), `${fid} is a row of company facts`);
      }
    }
    // The year rule: the full year, not the quarter or the 10-Q row beside it.
    assert.strictEqual(part.figures[`${ID}.revenue.2025`].v, 3234000000);
    assert.ok(!JSON.stringify(part).includes('Assets'), 'only the tags the build reads');
    const data = { figures: part.figures, filings: part.filings, mixes: part.mixes, concentration: part.concentration, companies: [co], others: [], edges: [] };
    assert.ok(Core.figureSource(data, `${ID}.revenue.2025`).url === 'https://www.sec.gov/Archives/edgar/data/9900001/000990000126000007/0009900001-26-000007-index.htm');
    // Revenue mix: shown because the tagged parts add up to reported revenue.
    const mix = part.mixes[ID][0];
    assert.deepStrictEqual([mix.kind, mix.parts.map((p) => p.label)], ['segment', ['Workforce Solutions', 'Consumer Information']]);
    assert.strictEqual(mix.parts[0].vals[2] + mix.parts[1].vals[2], part.figures[`${ID}.revenue.2025`].v);
    // Insight sentences are the shared templates', word for word.
    assert.deepStrictEqual(part.insights[ID], Core.companyInsights(data, co));
    assert.ok(part.insights[ID].length >= 5 && part.insights[ID].every((s) => s.cites.every((c) => part.figures[c])));
    assert.strictEqual(part.insights[ID][0].text, 'Revenue was $3.2 billion in FY2025, up 6.2% from FY2024. In FY2019 it was $2.1 billion: the FY2025 figure is 1.5 times that.');
    const src = part.sources[co.annual.source];
    assert.deepStrictEqual([src.by, src.form, src.url], [ID, '10-K', 'https://www.sec.gov/Archives/edgar/data/9900001/000990000126000007/hbld-20251231.htm']);
    assert.strictEqual(part.relations, null);
    ok(`a company outside the set is built by the build’s own code: ${Object.keys(part.figures).length} figures each with tag, period, accession number and filing; revenue mix where the parts add up; the shared insight templates; labelled`);

    /* ---------- Part 1: stored, and a repeat view asks sec.gov nothing ---------- */
    const after = sec.stats.requests;
    assert.strictEqual(after, 1 + 5, 'facts, submissions, the filing index, its instance and its labels');
    r = await json(`api/lookup/${H}`, '10.0.0.9');
    assert.deepStrictEqual(r.body.figures, part.figures);
    assert.strictEqual(sec.stats.requests, after, 'a repeat view makes no request to sec.gov');
    const doc = await store.get('lookups', String(H));
    assert.ok(doc && doc.cik === H && typeof doc.json === 'string' && doc.json.length < 60000 && Date.now() - doc.at < 60000);
    // Past the freshness window it is built again.
    await store.set('lookups', String(H), { ...doc, at: Date.now() - 8 * 86400000 });
    await json(`api/lookup/${H}`);
    assert.strictEqual(sec.stats.requests, after + 5);
    assert.ok(Date.now() - (await store.get('lookups', String(H))).at < 60000);
    ok('a built part is stored by CIK: a repeat view makes no request to sec.gov, and one older than seven days is read again');

    // Two requests at once for one company share one build.
    let before = sec.stats.requests;
    const [a1, a2] = await Promise.all([json('api/lookup/9900002', '10.0.0.2'), json('api/lookup/9900002', '10.0.0.3')]);
    assert.ok(a1.status === 200 && a2.status === 200 && a1.body.company.name === 'Tidewater Analytics Corp');
    assert.strictEqual(sec.stats.requests - before, 3, 'facts, submissions and one (missing) filing index, once');
    assert.deepStrictEqual(a1.body.mixes, { X9900002: [] });
    ok('two requests for one company share one build; with no XBRL instance the revenue mix is simply absent');

    assert.deepStrictEqual((await json('api/lookup/789019')).body, { inSet: 'MSFT' });
    assert.strictEqual((await json('api/lookup/12345')).status, 404);
    r = await json('api/lookup/9900007', '10.0.0.4');
    assert.deepStrictEqual([r.status, r.body.code], [422, 'no-annual']);
    assert.strictEqual(await store.get('lookups', '9900007'), null);
    ok('a company of the set is not looked up; an unknown number is a 404; a registrant with no 10-K or 20-F is a plain 422 and nothing is stored');

    /* ---------- Part 1: limits ---------- */
    // This address has built two (Harborlight, twice): two more, then a 429.
    for (const cik of [9900003, 9900005]) {
      r = await json(`api/lookup/${cik}`);
      assert.deepStrictEqual([r.status, r.body.code], [422, 'no-facts']);
    }
    before = sec.stats.requests;
    r = await json('api/lookup/9900004');
    assert.deepStrictEqual([r.status, r.body.code], [429, 'limit-ip']);
    assert.strictEqual(sec.stats.requests, before, 'a limited request reaches nothing');
    assert.strictEqual((await json(`api/lookup/${H}`)).status, 200, 'a stored company still opens at the limit');
    {
      const day = Lookup.create({ store: memoryBackend(), env: { ASFILED_LOOKUP_PER_DAY: '1' } });
      await day.company(9900002, { ip: '10.1.0.1' });
      await assert.rejects(() => day.company(H, { ip: '10.1.0.2' }), (e) => e.status === 429 && e.code === 'limit-day');
      assert.strictEqual((await day.company(9900002, { ip: '10.1.0.3' })).cached, true);
    }
    ok('lookups are limited per address an hour and across the instance a day; stored companies still open');

    /* ---------- Part 1: without the User-Agent ---------- */
    delete process.env.SEC_USER_AGENT;
    before = sec.stats.requests;
    r = await json('api/lookup/9900005', '10.0.0.5');
    assert.deepStrictEqual([r.status, r.body.error, r.body.code], [503, 'Lookups are not available right now', 'unavailable']);
    assert.strictEqual((await json(`api/lookup/${H}`, '10.0.0.5')).status, 200, 'what is stored still opens');
    {
      const cold = Lookup.create({ store: memoryBackend() });
      await assert.rejects(() => cold.resolve('hbld'), (e) => e instanceof sec.SecError && e.code === 'no-agent');
      assert.strictEqual(cold.secFail(new sec.SecError('no-agent')).status, 503);
    }
    await assert.rejects(() => sec.get('https://www.sec.gov/files/company_tickers.json'), (e) => e.code === 'no-agent');
    assert.strictEqual(sec.stats.requests, before);
    process.env.SEC_USER_AGENT = 'asfiled tests';
    await assert.rejects(() => sec.get('https://example.com/x'), (e) => e.code === 'host');
    await assert.rejects(() => sec.get('http://www.sec.gov/files/company_tickers.json'), (e) => e.code === 'host');
    ok('without SEC_USER_AGENT a lookup answers 503 "Lookups are not available right now" and nothing crashes; the reader goes to sec.gov over https and nowhere else');

    /* ---------- Part 2: signed in only ---------- */
    const post = (cik, cookie, ip = '10.0.0.7') => fetch(`${base}api/lookup/${cik}/relations`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) }, body: '{}' });
    const lines = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    r = await post(H);
    assert.strictEqual(r.status, 401);
    assert.strictEqual((await fetch(`${base}api/lookup/${H}/relations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' }, body: '{}' })).status, 403);
    assert.strictEqual(fakeClient.calls.length, 0);
    ok('"Find relationships" is refused signed out (401) and from another site (403); no model was called');
    const reg = await fetch(`${base}api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reader@example.com', password: 'correct horse battery' }) });
    assert.strictEqual(reg.status, 200);
    const cookie = reg.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

    /* ---------- Part 2: Claude picks, the verifier decides ---------- */
    before = sec.stats.requests;
    r = await post(H, cookie);
    assert.strictEqual(r.status, 200); assert.ok(/ndjson/.test(r.headers.get('content-type')));
    let out = await lines(r);
    assert.deepStrictEqual(out.filter((o) => o.step).map((o) => o.step), ['Fetching the Form 10-K from sec.gov', 'Reading it for sentences that name another company', 'Asking Claude which of 3 sentences state a relationship', 'Checking 4 proposed quotes against the report, word for word']);
    const rel = out[out.length - 1].relations;
    assert.strictEqual(sec.stats.requests - before, 1, 'the annual report, once');
    assert.strictEqual(fakeClient.calls.length, 1);
    const sent = fakeClient.calls[0];
    assert.deepStrictEqual([sent.model, sent.thinking, sent.max_tokens <= 4096, sent.output_config.format.type], ['claude-haiku-5-5', { type: 'disabled' }, true, 'json_schema']);
    const prompt = sent.messages[0].content;
    assert.ok(prompt.includes('We compete with Tidewater Analytics and Quillfeather Systems') && prompt.includes('AMZN = Amazon') && prompt.includes('X9900002 = Tidewater Analytics Corp'));
    assert.ok(!prompt.includes('complaint') && !prompt.includes('headquarters') && !prompt.includes('Summit') && !prompt.includes('disclosure controls'), 'only sentences that name a company and use a relationship word are sent');
    assert.deepStrictEqual(rel.edges.map((e) => [e.from, e.to, e.type]), [[ID, 'X9900002', 'competitor'], [ID, 'X9900003', 'competitor'], [ID, 'X9900003', 'customer'], ['AMZN', ID, 'supplier']]);
    const sha = T.sha(TEXT);
    assert.strictEqual(rel.source.sha, sha);
    for (const e of rel.edges) {
      assert.ok(TEXT.includes(e.quote), 'the quote is in the report word for word');
      assert.deepStrictEqual([e.by, e.lookup, e.source, e.section, e.proof], [ID, true, co.annual.source, 'Item 1. Business', V.proof(sha, e.quote)]);
      assert.ok(e.url === src.url && e.date === '2026-02-20' && e.quote.length <= 620);
    }
    assert.deepStrictEqual(rel.nodes.map((x) => [x.id, x.cik, x.lookup, x.present]), [['X9900002', 9900002, true, true], ['X9900003', 9900003, true, false]]);
    assert.deepStrictEqual(rel.stats, { sentences: 5, sent: 3, proposed: 4, kept: 4, dropped: {} });
    ok('a member’s run sends Claude (Haiku 5.5, thinking off, JSON output) three sentences and keeps four edges, each quote in the report word for word with the build’s proof hash');

    // What is kept: the sentences that were sent and the edges - not the report.
    const pas = await store.get('passages', String(H));
    assert.ok(pas.json.length < 2000 && pas.sha === sha && !pas.json.includes('disclosure controls') && !pas.json.includes('headquarters'));
    assert.ok((await store.get('relations', String(H))).json.length < 6000);
    // A second ask, and the public read, cost nothing.
    r = await post(H, cookie);
    assert.ok(/application\/json/.test(r.headers.get('content-type')));
    assert.deepStrictEqual((await r.json()).relations.edges, rel.edges);
    assert.deepStrictEqual((await json(`api/lookup/${H}`)).body.relations.edges, rel.edges);
    assert.strictEqual(fakeClient.calls.length, 1);
    // A stored edge that no longer matches a stored sentence is not served.
    const good = await store.get('relations', String(H));
    const bad = JSON.parse(good.json); bad.edges[0].quote = bad.edges[0].quote.replace('compete', 'partner');
    await store.set('relations', String(H), { ...good, json: JSON.stringify(bad) });
    assert.strictEqual((await json(`api/lookup/${H}`)).body.relations.edges.length, 3);
    await store.set('relations', String(H), good);
    ok('only the sentences sent and the kept edges are stored; a repeat ask calls no model; an edge altered in the store fails its proof and is not served');

    /* ---------- Part 2: the tripwire - a model is never a source ---------- */
    const again = async (mode) => {
      await store.remove('relations', String(H));
      fakeClient.mode = mode;
      const o = await lines(await post(H, cookie));
      return o[o.length - 1];
    };
    let t = await again('badquote');
    assert.deepStrictEqual(t.relations.stats.dropped, { 'quote not found verbatim in the source': 1 });
    assert.deepStrictEqual(t.relations.edges, rel.edges);
    assert.ok(!JSON.stringify(t.relations).includes('sole supplier of the data'));
    t = await again('wrongname');
    assert.deepStrictEqual(t.relations.stats.dropped, { 'that company is not named in the sentence': 1 });
    assert.strictEqual(t.relations.edges.length, 4);
    t = await again('stitched');
    assert.deepStrictEqual(Object.values(t.relations.stats.dropped), [1]);
    assert.strictEqual(t.relations.edges.length, 4);
    for (const mode of ['garbage', 'refusal']) { t = await again(mode); assert.deepStrictEqual([t.done, t.relations.edges, t.relations.stats.kept], [true, [], 0], mode); }
    t = await again('error');
    assert.deepStrictEqual([t.error, t.code, t.done], ['The relationships could not be read just now. Nothing was added.', 'ai', undefined]);
    assert.strictEqual(await store.get('relations', String(H)), null);
    // The rule itself, without a server.
    const ctx = { speaker: { id: ID, name: 'Harborlight Data Inc' }, docId: 'd', src: { by: ID, kind: 'annual-report', form: '10-K', sha, url: src.url, date: '2026-02-20' }, passages: [{ n: 1, section: null, sentence: 'We compete with Tidewater Analytics in every market we serve today.', named: [{ id: 'X9900002', name: 'Tidewater Analytics Corp', aliases: ['Tidewater Analytics'] }] }] };
    assert.ok(Relations.decide({ n: 1, counterparty: 'X9900002', type: 'competitor', quote: 'We compete with Tidewater Analytics in every market we serve today.' }, ctx).edge);
    assert.strictEqual(Relations.decide({ n: 1, counterparty: 'X9900002', type: 'competitor', quote: 'We compete with Tidewater Analytics in every market we serve.' }, ctx).drop, 'quote not found verbatim in the source');
    assert.strictEqual(Relations.decide({ n: 1, counterparty: 'X9900002', type: 'competitor', quote: 'we compete with tidewater analytics in every market' }, ctx).drop, 'quote not found verbatim in the source');
    assert.strictEqual(Relations.decide({ n: 1, counterparty: 'X9900002', type: 'competitor', quote: 'in every market we serve today.' }, ctx).drop, 'the quote does not name Tidewater Analytics Corp');
    assert.strictEqual(Relations.decide({ n: 1, counterparty: 'MSFT', type: 'competitor', quote: 'We compete with Tidewater Analytics in every market we serve today.' }, ctx).drop, 'that company is not named in the sentence');
    assert.strictEqual(Relations.decide({ n: 2, counterparty: 'X9900002', type: 'competitor', quote: 'x' }, ctx).drop, 'no such sentence');
    assert.deepStrictEqual(Relations.proposalsOf({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"edges":[{"n":1,"counterparty":"A","type":"investor","quote":"q"},{"n":"1","counterparty":"A","type":"partner","quote":"q"}]}' }] }), []);
    ok('a model proposing a quote that is in no sentence, a quote that does not name the company, or one stitched from two sentences yields no edge; an unreadable answer, a refusal or a failed call adds nothing');

    /* ---------- Part 2: the lab's AI guard ---------- */
    const guardLib = require('../../../lib/ai-guard');
    const guard = guardLib.create({ store: guardLib.memoryStore(), env: { LAB_AI_CAP_CLAUDE_USD: '0.00001' }, log: { error() {}, warn() {}, log() {}, info() {} } });
    global.LAB_AI_GUARD = guard;
    const calls = fakeClient.calls.length;
    t = await again(null);
    assert.strictEqual(t.relations.edges.length, 4);
    assert.strictEqual(fakeClient.calls.length, calls + 1);
    const usage = { input_tokens: Math.ceil((Relations.SYSTEM.length + fakeClient.calls[calls].messages[0].content.length) / 4), output_tokens: Math.ceil(JSON.stringify({ edges: rel.edges.map((e, i) => ({ n: [1, 1, 2, 3][i], counterparty: e.from === ID ? e.to : e.from, type: e.type, quote: e.quote })) }).length / 4) };
    const spent = guard.priceUsd({ provider: 'claude', model: 'claude-haiku-5-5', usage });
    assert.ok(spent > 0 && spent < 0.001, `one run on the fixture costs $${spent}`);
    // The run's cost was recorded and is over this test's tiny cap: the next ask is refused before any call.
    await store.remove('relations', String(H));
    r = await post(H, cookie);
    assert.strictEqual(r.status, 503);
    const refused = await r.json();
    assert.deepStrictEqual([refused.code, refused.error], ['monthly-cap', guard.MESSAGES['monthly-cap'] || refused.error]);
    assert.strictEqual(fakeClient.calls.length, calls + 1, 'no model call once the cap is reached');
    assert.strictEqual(await store.get('relations', String(H)), null);
    delete global.LAB_AI_GUARD;
    console.log(`     (one run on the fixture: ${usage.input_tokens} tokens in, ${usage.output_tokens} out, $${spent.toFixed(6)} at Haiku 5.5 prices)`);
    ok('the run goes through the lab’s AI guard: its cost is recorded from the response’s usage, and over the Claude cap the request is refused (503) before any model call');

    /* ---------- nothing of the reviewed set moved ---------- */
    const meta = await (await get('api/meta')).json();
    assert.strictEqual(meta.companies, 81);
    for (const f of ['index.json', 'patterns.json']) assert.ok(!/X99000\d\d/.test(fs.readFileSync(path.join(ROOT, 'public', 'data', f), 'utf8')));
    const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.ok(js.includes("var LABEL = 'Looked up on request - not in the reviewed set';") && /cls: 'flag', text: LABEL/.test(js) && /data\.lookups/.test(js) && !/data\.companies\.push/.test(js));
    assert.ok(/connect-src 'self'/.test((await get('')).headers.get('content-security-policy')));
    ok('the 81 stay 81: a looked-up company never joins data.companies, the patterns or the published files, and the page labels it');

    /* ---------- who may reach outward ---------- */
    const code = (rel2) => fs.readFileSync(path.join(ROOT, rel2), 'utf8').replace(/\/\/.*$/gm, '');
    for (const f of ['server.js', 'lib/lookup.js', 'lib/relations.js', 'lib/names.js', 'lib/fakeai.js']) {
      assert.ok(!/\bfetch\(|https?\.request|XMLHttpRequest/.test(code(f)), `${f} makes no request of its own`);
      assert.ok(!/process\.env\.SEC_USER_AGENT/.test(code(f)), `${f} does not read the User-Agent`);
    }
    assert.ok(/process\.env\.SEC_USER_AGENT/.test(code('tools/sec.js')) && !/console\.[a-z]+\([^)]*(ua|agent\(\)|SEC_USER_AGENT\b(?! is not set))/.test(code('tools/sec.js').replace(/console\.error\('SEC_USER_AGENT is not set[^']*'\)/, '')));
    assert.ok(/messages\.create/.test(code('server.js')) && code('server.js').match(/messages\.create/g).length === 1 && !/messages\.create|anthropic/i.test(code('lib/lookup.js')));
    if (AGENT) for (const f of ['lib/lookup.js', 'lib/relations.js', 'test/lookup.js', 'test/fixtures/make.js']) assert.ok(!fs.readFileSync(path.join(ROOT, f), 'utf8').includes(AGENT));
    ok('only tools/sec.js reads SEC_USER_AGENT or reaches sec.gov, and the one model call is the relations route');
  } finally { server.close(); }

  console.log(`\n${n} checks passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
