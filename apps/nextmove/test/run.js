// Next Move's tests: pure rules first, then the jobs and the web app end to
// end against the memory stores, the fake BigQuery and the fake model.
//
//   npm test   (REQUIRE_VERIFIED_FOR_FREE_AI=0 NEXTMOVE_MEMORY=1 NEXTMOVE_FAKE_AI=1)
//
// No network: every outside call goes through test/helpers' fakeFetch, which
// throws on anything it has no route for (local HTTP to the app under test
// passes through).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

if (process.env.NEXTMOVE_MEMORY !== '1' || process.env.NEXTMOVE_FAKE_AI !== '1') {
  console.error('run with NEXTMOVE_MEMORY=1 NEXTMOVE_FAKE_AI=1 (npm test)');
  process.exit(1);
}

const h = require('./helpers');
const ROOT = path.join(__dirname, '..');

// The network, for the whole run: fixtures for every source, pass-through to
// the app under test, and a switchboard tests can change.
const realFetch = globalThis.fetch;
const swap = {};       // url regex source -> answer, checked first
const swapped = [];
const LCA_URL = 'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2026_Q2.xlsx';
const LCA_CSV_URL = 'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2019_Q4.csv';
const OEWS_NAT = 'https://www.bls.gov/oes/special-requests/oesm25nat.zip';
const OEWS_ST = 'https://www.bls.gov/oes/special-requests/oesm25st.zip';
const routes = h.sourceRoutes([
  [LCA_URL, () => new Response(h.xlsx(h.lcaRows(30), { title: 'LCA Disclosure Data FY2026 Q2' }), { status: 200 })],
  [LCA_CSV_URL, () => new Response(h.lcaRows(12).map((r) => r.map((c) => (c === null ? '' : `"${String(c).replace(/"/g, '""')}"`)).join(',')).join('\r\n'), { status: 200 })],
  [OEWS_NAT, () => new Response(h.zip([['oesm25nat/national_M2025_dl.xlsx', h.xlsx(h.oewsRows().slice(0, 3)), false], ['oesm25nat/field_descriptions.xlsx', h.xlsx([['x']]), false]]), { status: 200 })],
  [OEWS_ST, () => new Response(h.zip([['oesm25st/state_M2025_dl.xlsx', h.xlsx([h.oewsRows()[0]].concat(h.oewsRows().slice(3)))]]), { status: 200 })],
]);
const fakeNet = h.fakeFetch(routes);
globalThis.fetch = async (u, init) => {
  const s = String(u);
  if (/^http:\/\/127\.0\.0\.1/.test(s)) return realFetch(u, init);
  for (const [k, v] of Object.entries(swap)) if (new RegExp(k).test(s)) { swapped.push({ url: s, headers: (init || {}).headers || {} }); const out = await v(s, init); return out instanceof Response ? out : h.response(out === null ? 404 : 200, out === null ? { error: 'nf' } : out); }
  return fakeNet(u, init);
};
const outside = () => fakeNet.calls.concat(swapped).filter((c) => !/^http:\/\/127\.0\.0\.1/.test(c.url));

process.env.SEC_USER_AGENT = 'Next Move tests test-contact@example.com';

const { app, ctx } = require('../server');
const jobs = require('../jobs/run');
const httpLib = require('../lib/http');
const pay = require('../lib/pay');
const titles = require('../lib/titles');
const boards = require('../lib/boards');
const sec = require('../lib/sec');
const gdelt = require('../lib/gdelt');
const lca = require('../lib/lca');
const xlsx = require('../lib/xlsx');
const prefilter = require('../lib/prefilter');
const fit = require('../lib/fit');
const sweep = require('../lib/sweep');
const profileLib = require('../lib/profile');
const insights = require('../lib/insights');
const { keyFor } = require('../lib/userkey');
const { Q, ALL } = require('../lib/queries');
const { P } = require('../lib/bq');
const { schemaJson, TABLES } = require('../lib/schema');
const S = require('../public/sample');

const bq = ctx.bqClient();
const uidOf = (email) => Buffer.from(email).toString('base64url');
const settle = () => new Promise((r) => setTimeout(r, 20));
const usage = async () => ctx.identityStore.list('usage');
const fastHttp = () => ({
  boards: httpLib.create({ hostGapMs: 0, backoffMs: 1 }),
  sec: httpLib.create({ hostGapMs: 0, backoffMs: 1, userAgent: process.env.SEC_USER_AGENT }),
  gdelt: httpLib.create({ hostGapMs: 0, backoffMs: 1 }),
});
const daily = (o = {}) => jobs.main('daily', { quiet: true, http: fastHttp(), ...o });

let base;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function register(email) {
  const c = h.client(base);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, r.text);
  return c;
}
async function setUp(c, watch = ['https://job-boards.greenhouse.io/harborview', 'Northwind Logistics', 'jobs.ashbyhq.com/copperline']) {
  assert.strictEqual((await c('PUT', '/api/profile', h.demoProfile())).status, 200);
  for (const input of watch) {
    const r = await c('POST', '/api/watchlist', { input });
    assert.strictEqual(r.status, 200, r.text);
  }
}

/* ================================================================== *
 * Pure: pay
 * ================================================================== */

test('pay ranges: the formats postings use, read the same way every time', () => {
  const cases = [
    ['The base salary range for this role is $180,000 - $220,000 per year.', [180000, 220000, 'USD', 'year']],
    ['Pay: $180K–$220K', [180000, 220000, 'USD', 'year']],
    ['Pay: $180k—$220k + equity', [180000, 220000, 'USD', 'year']],
    ['USD 150K–190K plus equity', [150000, 190000, 'USD', 'year']],
    ['150,000 to 190,000 USD annually', [150000, 190000, 'USD', 'year']],
    ['The salary for this role is 150-190K.', [150000, 190000, 'USD', 'year']],
    ['$85/hr', [85, 85, 'USD', 'hour']],
    ['$40.50 - $55.25 per hour', [40.5, 55.25, 'USD', 'hour']],
    ['Hourly rate of 25 - 30 depending on experience', [25, 30, 'USD', 'hour']],
    ['Salary up to $200,000', [null, 200000, 'USD', 'year']],
    ['Starting at $120,000 base salary', [120000, null, 'USD', 'year']],
    ['€70.000 - €90.000 gross per year', [70000, 90000, 'EUR', 'year']],
    ['CA$150,000 - CA$170,000', [150000, 170000, 'CAD', 'year']],
    ['£55k-£65k', [55000, 65000, 'GBP', 'year']],
    ['$8,000 - $9,500 per month', [8000, 9500, 'USD', 'month']],
    ['Pay range\n$190,000 — $225,000 USD', [190000, 225000, 'USD', 'year']],
  ];
  for (const [text, [min, max, cur, period]] of cases) {
    const p = pay.parsePay(text);
    assert.ok(p, text);
    assert.deepStrictEqual([p.min, p.max, p.currency, p.period], [min, max, cur, period], text);
  }
  assert.deepStrictEqual([pay.parsePay('$85/hr').annualMin, pay.parsePay('$40.50 - $55.25 per hour').annualMax, pay.parsePay('$8,000 - $9,500 per month').annualMin], [176800, 114920, 96000], 'hourly x2080, monthly x12');
  const multi = pay.parsePay('San Francisco: $200,000-$240,000; New York: $190,000-$230,000; Remote: $170,000-$210,000');
  assert.deepStrictEqual([multi.min, multi.max, multi.ranges], [170000, 240000, 3], 'several ranges: one envelope, counted');
  const mixed = pay.parsePay('US: $150,000 - $180,000. UK: £90,000 - £110,000. Elsewhere in the US: $140,000 - $170,000.');
  assert.deepStrictEqual([mixed.currency, mixed.min, mixed.max, mixed.ranges], ['USD', 140000, 180000, 2], 'the common currency wins; others are not mixed in');
  for (const junk of ['We raised $50M in our Series B led by X.', '$5,000 signing bonus', '401(k) with 4% match', 'Our ARR grew to $20-30 million', 'Experience: 2019 - 2024', 'We have 200 - 300 employees.', '$2 billion in revenue', 'compensation $95,000 - $1,200,000', 'A $1,500 home-office stipend', 'Relocation assistance up to $10,000', '', null, 42, 'Call 404-555-0100']) {
    assert.strictEqual(pay.parsePay(junk), null, String(junk));
  }
  assert.strictEqual(pay.parsePay('We offer a $10,000 signing bonus. Base pay: $130,000 - $150,000.').min, 130000, 'the bonus is skipped, the base read');
  assert.deepStrictEqual([pay.annualise('$40.00', 'Hour'), pay.annualise('3,000', 'Bi-Weekly'), pay.annualise(6500, 'Month'), pay.annualise('1,000', 'Week'), pay.annualise('85000', 'Year'), pay.annualise('x', 'Year'), pay.annualise('10', 'Fortnight')], [83200, 78000, 78000, 52000, 85000, null, null]);
  const ash = pay.fromAshby(JSON.parse(h.fixture('ashby-board.json')).jobs[0].compensation);
  assert.deepStrictEqual([ash.min, ash.max, ash.period, ash.currency], [205000, 240000, 'year', 'USD'], 'Ashby: the salary component, not equity');
  assert.deepStrictEqual(pay.fromLever({ min: 40, max: 50, currency: 'USD', interval: 'per-hour-wage' }).annualMax, 104000);
  assert.strictEqual(pay.fromLever({ min: 5, max: 6, interval: 'per-year-salary' }), null, 'implausible structured pay is refused too');
});

/* ================================================================== *
 * Pure: titles and the prefilter
 * ================================================================== */

test('titles: role and grade separated, so filings and postings compare role to role', () => {
  const t = (s) => titles.normTitle(s);
  assert.deepStrictEqual([t('Sr. Director of Analytics (Remote, US)').title_norm, t('Director, Analytics').title_norm, t('Head of Analytics').title_norm, t('DIRECTOR, ANALYTICS').title_norm], Array(4).fill('analytics director'));
  assert.deepStrictEqual([t('Director of Analytics, Network Planning').title_norm, t('Software Engineer, Payments').title_norm, t('Senior Manager, Analytics').title_norm], ['analytics director', 'software engineer', 'analytics manager'], 'a team after the comma is not the role');
  assert.deepStrictEqual([t('Senior Data Scientist').title_norm, t('Data Scientist II').title_norm, t('DATA SCIENTIST').title_norm], Array(3).fill('data scientist'));
  assert.deepStrictEqual([t('Senior Data Scientist').seniority, t('Staff Software Engineer').seniority, t('Engineering Manager').seniority, t('VP, Data & Analytics').seniority, t('Chief Data Officer').seniority, t('Software Engineering Intern').seniority], ['senior', 'staff', 'manager', 'vp', 'c_level', 'intern']);
  assert.strictEqual(t('Senior Product Manager').title_norm, 'product manager', 'a product manager is a role, not a people manager');
  assert.strictEqual(titles.ladderDistance('director', 'manager'), 1);
  assert.ok(titles.titleSimilarity('Director of Analytics', 'Director, Marketing Analytics') > 0.6);
  assert.strictEqual(titles.titleSimilarity('Director of Analytics', 'Registered Nurse, ICU'), 0);
});

const P0 = { posting_id: 'p', company_key: 'greenhouse:x', company_name: 'X', title: '', location: '', remote: false, pay_min_annual: null, pay_max_annual: null, pay_currency: null, description_text: '' };
const post = (o) => ({ ...P0, ...o, posting_id: o.posting_id || o.title });

test('the prefilter: title, level, place, pay floor and keywords decide the top N - for free', () => {
  const prof = h.demoProfile();
  const list = [
    post({ title: 'Director, Analytics & Insights', location: 'Atlanta, GA', pay_min_annual: 190000, pay_max_annual: 225000, description_text: 'SQL, Python and Looker. Forecasting.', company_key: 'greenhouse:harborview' }),
    post({ title: 'Analytics Manager', location: 'Atlanta, GA', description_text: 'SQL' }),
    post({ title: 'VP, Analytics', location: 'Remote', remote: true }),
    post({ title: 'Director of Analytics', location: 'Boise, ID', pay_max_annual: 120000, pay_min_annual: 100000 }),
    post({ title: 'Registered Nurse', location: 'Atlanta, GA', company_key: 'greenhouse:other' }),
    post({ title: 'Head of Data', location: 'Remote (US)', remote: true, pay_max_annual: 240000 }),
  ];
  const ranked = prefilter.rank(prof, list, { n: 10, watched: new Set(['greenhouse:harborview']), min: 0 });
  const order = ranked.map((r) => r.posting.title);
  assert.strictEqual(order[0], 'Director, Analytics & Insights', 'title + level + place + pay + keywords + watched');
  assert.ok(!order.includes('Registered Nurse'), 'unrelated titles at unwatched companies never reach the model');
  assert.ok(order.indexOf('Director of Analytics') > order.indexOf('Head of Data'), 'pay posted well under the floor ranks down');
  const top2 = prefilter.rank(prof, list, { n: 2, watched: new Set() });
  assert.strictEqual(top2.length, 2, 'only the top N');
  const remoteOnly = { ...prof, targets: { ...prof.targets, remote: 'remote_only' } };
  const r2 = prefilter.rank(remoteOnly, list, { n: 10, watched: new Set(), min: 0 }).map((r) => r.posting.title);
  assert.ok(r2.indexOf('Head of Data') < r2.indexOf('Director, Analytics & Insights'), 'remote-only: on-site roles fall');
  assert.deepStrictEqual(prefilter.rank({ targets: { titles: [] } }, list), [], 'no titles, nothing ranked');
  assert.deepStrictEqual(prefilter.rank(prof, list, { n: 10 }).map((r) => r.posting.title), prefilter.rank(prof, list.slice().reverse(), { n: 10 }).map((r) => r.posting.title), 'order-independent');
});

/* ================================================================== *
 * Pure: boards
 * ================================================================== */

test('career-board links resolve to a provider and token; anything else does not', () => {
  const cases = {
    'https://boards.greenhouse.io/acme': ['greenhouse', 'acme'],
    'https://job-boards.greenhouse.io/acme/jobs/123': ['greenhouse', 'acme'],
    'boards.greenhouse.io/embed/job_board?for=acme': ['greenhouse', 'acme'],
    'https://jobs.lever.co/acme': ['lever', 'acme'],
    'https://jobs.eu.lever.co/acme/abc-123': ['lever', 'acme'],
    'https://jobs.ashbyhq.com/Acme%20Labs': null,
    'https://jobs.ashbyhq.com/acme-labs': ['ashby', 'acme-labs'],
  };
  for (const [u, want] of Object.entries(cases)) {
    const r = boards.parseCareersUrl(u);
    assert.deepStrictEqual(r ? [r.provider, r.token] : null, want, u);
  }
  assert.strictEqual(boards.parseCareersUrl('https://jobs.lever.co.evil.example/acme'), null);
  assert.strictEqual(boards.parseCareersUrl('https://www.linkedin.com/company/acme/jobs'), null);
  assert.strictEqual(boards.parseCareersUrl('https://boards.greenhouse.io/%2e%2e%2fetc'), null);
  assert.deepStrictEqual(boards.slugCandidates('Acme Corp, Inc.'), ['acme', 'acmecorpinc']);
  assert.ok(boards.slugCandidates('Northwind Logistics').includes('northwind'));
  assert.strictEqual(boards.companyKeyFor('greenhouse', 'Acme'), 'greenhouse:acme');
  assert.strictEqual(boards.companyKeyFor(null, 'Brightwater Insurance'), 'name:brightwater-insurance');
  assert.deepStrictEqual([boards.stateOf('Atlanta, GA'), boards.stateOf('Remote - US'), boards.stateOf('Austin, Texas'), boards.stateOf('NYC')], ['GA', null, 'TX', 'NY']);
});

test('resolving: a URL is checked against its API; a name probes Greenhouse, Lever and Ashby; nothing found is said', async () => {
  const hc = httpLib.create({ hostGapMs: 0, retries: 0 });
  const a = await boards.resolve(hc, 'https://job-boards.greenhouse.io/harborview');
  assert.deepStrictEqual([a.companyKey, a.name, a.found], ['greenhouse:harborview', 'Harborview Health', true], 'the board API names the company');
  const b = await boards.resolve(hc, 'Northwind Logistics');
  assert.deepStrictEqual([b.companyKey, b.provider, b.name], ['lever:northwind', 'lever', 'Northwind Logistics']);
  const c = await boards.resolve(hc, 'Brightwater Insurance');
  assert.deepStrictEqual([c.companyKey, c.found, c.provider], ['name:brightwater-insurance', false, null]);
  const d = await boards.resolve(hc, 'https://jobs.lever.co/doesnotexist');
  assert.strictEqual(d.found, false, 'a board URL that 404s is not a board');
});

test('Greenhouse, Lever and Ashby postings normalise to one row shape', () => {
  const now = '2026-10-02T11:15:00.000Z';
  const gh = boards.fromGreenhouse(JSON.parse(h.fixture('greenhouse-jobs.json')), { companyKey: 'greenhouse:harborview', name: 'Harborview Health', token: 'harborview' }, now);
  assert.strictEqual(gh.length, 3);
  const d = gh[0];
  assert.deepStrictEqual([d.source, d.title, d.title_norm, d.seniority, d.location_state, d.remote, d.pay_min, d.pay_max, d.pay_source, d.department], ['greenhouse', 'Director, Analytics & Insights', 'analytics insight director', 'director', 'GA', false, 190000, 225000, 'posted', 'Data & Analytics']);
  assert.ok(/Build and lead the demand forecasting function/.test(d.description_text) && !/[<>]|&lt;|&quot;/.test(d.description_text), 'the double-escaped HTML is plain text');
  assert.strictEqual(d.posted_at, '2026-09-29T14:00:00.000Z');
  assert.ok(/^[0-9a-f]{32}$/.test(d.posting_id) && /^[0-9a-f]{32}$/.test(d.content_hash));
  assert.deepStrictEqual([gh[1].remote, gh[1].pay_min, gh[2].pay_period, gh[2].pay_min_annual], [true, 150000, 'hour', 99840]);
  const lv = boards.fromLever(JSON.parse(h.fixture('lever-postings.json')), { companyKey: 'lever:northwind', name: 'Northwind Logistics', token: 'northwind' }, now);
  assert.deepStrictEqual([lv[0].pay_source, lv[0].pay_min, lv[0].url, lv[0].posted_at.slice(0, 10)], ['lever_salary', 175000, 'https://jobs.lever.co/northwind/8f2b6a1c-1d2e-4f00-9a77-2c1b0e5d9a01', '2025-09-29']);
  assert.ok(/linear programming/.test(lv[0].description_text), 'the lists are part of the text');
  assert.deepStrictEqual([lv[1].pay_period, lv[1].pay_min], ['hour', 24]);
  const ab = boards.fromAshby(JSON.parse(h.fixture('ashby-board.json')), { companyKey: 'ashby:copperline', name: 'Copperline', token: 'copperline' }, now);
  assert.strictEqual(ab.length, 2, 'an unlisted Ashby job is not a posting');
  assert.deepStrictEqual([ab[0].pay_source, ab[0].pay_min, ab[0].pay_max, ab[0].remote], ['ashby_comp', 205000, 240000, true], 'Ashby\'s structured compensation wins');
  const hostile = boards.fromGreenhouse({ jobs: [{ id: 1, title: '<img src=x onerror=alert(1)>Analyst\u202e', absolute_url: 'javascript:alert(1)', content: '&lt;script&gt;alert(1)&lt;/script&gt;Hi', location: { name: 'x'.repeat(500) } }] }, { companyKey: 'greenhouse:x', name: 'X', token: 'x' }, now)[0];
  assert.ok(!/[<>\u202e]/.test(hostile.title) && hostile.url === null && hostile.location.length <= 160 && !/alert/.test(hostile.description_text));
});

/* ================================================================== *
 * Pure: SEC, GDELT
 * ================================================================== */

test('SEC: 8-K items become event types; the UA is required and never invented', async () => {
  const idx = sec.tickerIndex(JSON.parse(h.fixture('sec-tickers.json')));
  assert.strictEqual(sec.cikFor(idx, 'Northwind Logistics').cik, 1990001);
  assert.strictEqual(sec.cikFor(idx, 'Harborview Health Corporation').cik, 1990002, 'corporate suffixes fold');
  assert.strictEqual(sec.cikFor(idx, 'NWLX').cik, 1990001, 'a ticker typed as the name');
  assert.strictEqual(sec.cikFor(idx, 'Twin Name'), null, 'a name two CIKs share is no match');
  assert.strictEqual(sec.cikFor(idx, 'Northwind'), null, 'exact names only - no guessing');
  const ev = sec.eventsFrom(JSON.parse(h.fixture('sec-submissions.json')), 'lever:northwind', '2026-09-01T00:00:00Z');
  assert.deepStrictEqual(ev.map((e) => [e.event_type, e.sec_form, e.sec_items.join(',')]), [['layoff', '8-K', '2.05,9.01'], ['exec_change', '8-K', '5.02']], '10-Qs and older 8-Ks are left out');
  assert.strictEqual(ev[0].url, 'https://www.sec.gov/Archives/edgar/data/1990001/000199000126000041/nwlx-8k_20260930.htm');
  assert.match(ev[0].headline, /exit or disposal costs/);
  assert.deepStrictEqual(['2.01', '2.02', '1.01', '8.01'].map((i) => sec.typeFor([i])), ['acquisition', 'earnings', 'other', 'other']);
  assert.strictEqual(sec.typeFor(['2.02', '5.02']), 'exec_change', 'the most telling item wins');
  for (const bad of ['', 'Next Move', 'x@']) assert.throws(() => sec.userAgent({ SEC_USER_AGENT: bad }), /SEC_USER_AGENT/);
  const before = outside().length;
  await assert.rejects(sec.loadTickers(httpLib.create({ hostGapMs: 0 }), {}), /SEC_USER_AGENT/);
  await assert.rejects(sec.filings(httpLib.create({ hostGapMs: 0 }), 1990001, 'k', null, { SEC_USER_AGENT: '' }), /SEC_USER_AGENT/);
  assert.strictEqual(outside().length, before, 'no request to EDGAR without the User-Agent');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'sec.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'jobs', 'run.js'), 'utf8');
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(src), 'no contact address in the code');
});

test('GDELT: headlines naming the company, classified by rule, links checked', () => {
  const ev = gdelt.eventsFrom(JSON.parse(h.fixture('gdelt-artlist.json')), 'lever:northwind', 'Northwind Logistics');
  assert.deepStrictEqual(ev.map((e) => e.event_type), ['layoff', 'exec_change'], 'roundup without the name, a javascript: link and a duplicate are dropped');
  assert.strictEqual(ev[0].published_at, '2026-09-30T14:15:00.000Z');
  const cases = {
    'Acme to lay off 300 workers': 'layoff', 'Acme cuts 1,200 jobs': 'layoff', 'Acme announces restructuring': 'layoff',
    'Acme to acquire Beta for $2B': 'acquisition', 'Acme and Beta agree to merge': 'acquisition',
    'Acme raises $50 million Series C': 'funding', 'Acme files to go public': 'funding',
    'Acme CEO steps down': 'exec_change', 'Acme appoints new chief financial officer': 'exec_change',
    'Acme beats estimates on strong quarter': 'earnings', 'Acme Q3 results': 'earnings', 'Acme opens new office': 'other',
  };
  for (const [t, want] of Object.entries(cases)) assert.strictEqual(gdelt.classify(t), want, t);
  assert.match(gdelt.urlFor('Acme "Corp"'), /query=%22Acme%20Corp%22%20sourcelang%3Aenglish&mode=artlist&format=json/);
  assert.strictEqual(gdelt.urlFor('AB'), null, 'too short to search');
});

/* ================================================================== *
 * Pure: xlsx, LCA, OEWS
 * ================================================================== */

async function collect(gen) { const out = []; for await (const x of gen) out.push(x); return out; }
const tmp = (name, buf) => { const f = path.join(os.tmpdir(), `nextmove-test-${process.pid}-${name}`); fs.writeFileSync(f, buf); return f; };

test('the xlsx reader: shared strings, rich text, inline strings, a title row; CSV with quotes', async () => {
  const rows = [['A', 'B', 'C'], ['x, "y"', 1.5, null], ['Ünïcode & <b>', 'rich text', 42]];
  const f = tmp('a.xlsx', h.xlsx(rows, { title: 'Report title' }));
  const recs = await collect(xlsx.records(xlsx.rowsOf(f)));
  assert.deepStrictEqual(recs, [{ A: 'x, "y"', B: '1.5', C: null }, { A: 'Ünïcode & <b>', B: 'rich text', C: '42' }]);
  assert.deepStrictEqual(xlsx.colIndex('AA12'), 26);
  const csv = tmp('a.csv', '\ufeffA,B\r\n"one, two","say ""hi"""\r\n"multi\nline",3\r\n');
  assert.deepStrictEqual(await collect(xlsx.records(xlsx.rowsOf(csv), { headerScan: 1 })), [{ A: 'one, two', B: 'say "hi"' }, { A: 'multi\nline', B: '3' }]);
  fs.rmSync(f); fs.rmSync(csv);
  const bad = tmp('bad.xlsx', Buffer.from('not a zip at all'));
  assert.throws(() => xlsx.openZip(bad), /not a zip/);
  fs.rmSync(bad);
});

test('LCA rows: certified full-time only, wages annualised by unit, implausible ones and every contact column dropped', async () => {
  const f = tmp('lca.xlsx', h.xlsx(h.lcaRows(4)));
  const period = lca.lcaPeriod('LCA_Disclosure_Data_FY2026_Q2.xlsx');
  assert.deepStrictEqual(period, { year: 2026, quarter: 2 });
  const out = [];
  for await (const rec of xlsx.records(xlsx.rowsOf(f))) { const r = lca.lcaRow(rec, period); if (r) out.push(r); }
  fs.rmSync(f);
  assert.deepStrictEqual(out.map((r) => [r.employer, r.wage_annual]), [
    ['EXAMPLE ANALYTICS LLC', 160000], ['EXAMPLE ANALYTICS LLC', 161000], ['EXAMPLE ANALYTICS LLC', 162000], ['EXAMPLE ANALYTICS LLC', 163000],
    ['HOURLY CO', 83200], ['BIWEEKLY CO', 78000], ['E3 CO', 78000],
  ], 'denied, withdrawn, part-time and an $85 "salary" are gone');
  assert.deepStrictEqual([out[0].title_norm, out[1].title_norm, out[0].soc_code, out[0].worksite_city, out[0].worksite_state, out[0].case_status], ['analytics director', 'analytics director', '11-3021', 'Atlanta', 'GA', 'Certified']);
  for (const r of out) assert.deepStrictEqual(Object.keys(r).sort(), lca.COMP_COLUMNS.slice().sort());
  assert.ok(!/@|555-0100/.test(JSON.stringify(out)), 'no employer contact, attorney email or phone');
  const oews = h.oewsRows();
  const hdr = oews[0];
  const recs = oews.slice(1).map((r) => Object.fromEntries(hdr.map((k, i) => [k, r[i]])));
  const o = recs.map((r) => lca.oewsRow(r, 2025)).filter(Boolean);
  assert.deepStrictEqual(o.map((r) => [r.worksite_state, r.wage_annual, r.wage_p75, r.employment]), [[null, 172000, 214000, 591000], ['GA', 161000, null, 18900]], 'major groups, metro areas and suppressed (*) rows skipped; # is no figure');
  assert.deepStrictEqual([lca.oewsYear('oesm25nat.zip'), lca.oewsYear('state_M2024_dl.xlsx')], [2025, 2024]);
});

/* ================================================================== *
 * Pure: score_fit and the sweep's finds
 * ================================================================== */

const POSTING = { posting_id: 'x', description_text: 'You will build and lead the demand forecasting function across our hospitals.\nLead a team of 10-15 analysts and data scientists.' };

test('score_fit output is untrusted: quotes must be in the posting, scores in range, strings clean and bounded', () => {
  const ok = fit.cleanFit({ score: 88, verdict: 'strong', strengths: [{ point: 'Forecasting', quote: 'build and lead the demand forecasting function' }, { point: 'Made up', quote: 'expert in quantum blockchain systems' }, { point: 'Whitespace differs', quote: 'Lead  a team of\n10-15 analysts' }], gaps: ['Epic'], positioning: 'Lead with it.' }, POSTING);
  assert.deepStrictEqual(ok.strengths.map((s) => s.point), ['Forecasting', 'Whitespace differs'], 'a quote not in the posting is dropped');
  assert.strictEqual(ok.dropped, 1);
  for (const bad of [{ score: 140, verdict: 'strong' }, { score: -1 }, { score: '90' }, { score: NaN }, null, 'text', { verdict: 'strong' }]) assert.strictEqual(fit.cleanFit(bad, POSTING), null, JSON.stringify(bad));
  const hostile = fit.cleanFit({
    score: 77.6, verdict: 'definitely_hire',
    strengths: [{ point: '<img src=x onerror=alert(1)>Matches\u202e', quote: 'Lead a team of 10-15 analysts and data scientists.' }, { point: 'x'.repeat(5000), quote: 'build and lead the demand forecasting function' }, 'nope', { point: 'short', quote: 'Lead' }],
    gaps: ['<script>alert(1)</script>SQL', 'y'.repeat(4000), 42, null, 'a', 'b', 'c', 'd'],
    positioning: `<b>Lead</b> ${'z'.repeat(5000)}`,
  }, POSTING);
  assert.strictEqual(hostile.score, 78);
  assert.strictEqual(hostile.verdict, 'worth_a_look', 'a bad verdict is derived from the score');
  assert.ok(!/[<>\u202e]/.test(JSON.stringify(hostile)));
  assert.ok(hostile.strengths.length === 2 && hostile.strengths[1].point.length <= 220 && hostile.gaps.length <= 5 && hostile.gaps.every((g) => g.length <= 220) && hostile.positioning.length <= 1200);
  assert.strictEqual(fit.request('m', h.demoProfile(), { ...POSTING, title: 'T', company_name: 'C' }).tool_choice.name, 'score_fit', 'forced');
  assert.match(fit.SYSTEM, /data/);
});

test('the sweep: https links on the company\'s own site only, bounded, deduplicated, filed under the watchlist key', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const keyOf = (n) => (/peachtree/i.test(n) ? 'greenhouse:peachtree' : boards.companyKeyFor(null, n));
  const f = sweep.cleanFinds(require('../lib/fakeai').FINDS, { companyKeyOf: keyOf, now });
  assert.deepStrictEqual(f.postings.map((p) => [p.url, p.company_key, p.source]), [
    ['https://careers.peachtree-payments.example/jobs/4411', 'greenhouse:peachtree', 'websearch'],
    ['https://jobs.already-known.example/123', 'name:already-known-inc', 'websearch'],
  ], 'LinkedIn, javascript: and the duplicate are dropped');
  assert.deepStrictEqual(f.events.map((e) => [e.event_type, e.source]), [['layoff', 'websearch']]);
  assert.strictEqual(f.dropped, 4);
  assert.deepStrictEqual(sweep.cleanFinds(null, { companyKeyOf: keyOf }).postings, []);
  const future = sweep.cleanFinds({ postings: [], news: [{ company: 'A', headline: 'A news', url: 'https://a.example/x', type: 'bogus', date: '2031-01-01' }] }, { companyKeyOf: keyOf, now });
  assert.deepStrictEqual([future.events[0].published_at, future.events[0].event_type], [new Date(now).toISOString(), 'other'], 'a future date is today; a bad type is classified');
});

test('the sweep loop: pause_turn resumes with the paused turn; prose gets one forced follow-up', async () => {
  const fake = require('../lib/fakeai').create();
  const plan = { model: 'claude-haiku-4-5', webSearch: { type: 'web_search_20250305', name: 'web_search', max_uses: 4 } };
  const paused = await sweep.run(fake, plan, { targets: { titles: ['Pauser Director'] } }, []);
  assert.strictEqual(paused.responses.length, 2);
  assert.strictEqual(paused.responses[0].stop_reason, 'pause_turn');
  const resumed = fake.calls[1];
  assert.strictEqual(resumed.messages[resumed.messages.length - 1].role, 'assistant', 'resumed by re-sending the paused turn - no "continue" message');
  assert.ok(paused.raw && paused.raw.postings.length);
  const prose = await sweep.run(fake, plan, { targets: { titles: ['Prose Director'] } }, []);
  const last = fake.calls[fake.calls.length - 1];
  assert.deepStrictEqual([prose.responses.length, last.tool_choice, last.tools.map((t) => t.name)], [2, { type: 'tool', name: 'record_finds' }, ['record_finds']]);
  assert.ok(last.messages.every((m) => !Array.isArray(m.content) || m.content.every((b) => b.type === 'text')), 'server-tool blocks are not sent back to a request without the tool');
  assert.ok(prose.raw);
  assert.strictEqual(fake.calls[0].tool_choice.type, 'auto', 'the first call may search');
});

/* ================================================================== *
 * Pure: schema, queries, keys, local switches
 * ================================================================== */

test('the schema file matches the definitions; every query is parameterised and nothing is spliced into SQL', () => {
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'bq', 'schema.json'), 'utf8')), schemaJson(), 'run: node jobs/run.js schema > bq/schema.json');
  assert.deepStrictEqual(TABLES.postings.timePartitioning, { type: 'DAY', field: 'first_seen' });
  assert.deepStrictEqual(TABLES.postings.clustering.fields, ['company_key']);
  assert.deepStrictEqual(TABLES.company_events.timePartitioning.field, 'published_at');
  assert.deepStrictEqual(TABLES.fits.timePartitioning.field, 'scored_at');
  const fitCols = TABLES.fits.fields.map((f) => f.name);
  for (const forbidden of ['uid', 'email', 'name', 'user_id', 'background']) assert.ok(!fitCols.includes(forbidden), forbidden);
  for (const q of [...ALL, Q.mergePostings('postings_stage_abc123'), Q.replaceComp('comp_stage_abc123')]) {
    assert.ok(!/\$\{/.test(q.sql), `${q.name}: no template splices`);
    assert.ok(/@[a-zA-Z]/.test(q.sql), `${q.name}: parameterised`);
  }
  assert.throws(() => Q.mergePostings('postings; DROP TABLE x'), /bad stage/);
  const src = ['server.js', 'lib/insights.js', 'lib/daily.js', 'lib/weekly.js', 'lib/comprefresh.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  assert.ok(!/\.run\(\s*\{\s*sql/.test(src) && !/sql:\s*`[^`]*\$\{(?!stage)/.test(src), 'every run() is a registered query');
  const rest = require('../lib/bq').toRestParam('companies', P.strs(['a', 'b']));
  assert.deepStrictEqual(rest.parameterType, { type: 'ARRAY', arrayType: { type: 'STRING' } });
  assert.deepStrictEqual(require('../lib/bq').toRestParam('since', P.ts('2026-10-01T00:00:00Z')).parameterValue.value, '2026-10-01 00:00:00.000+00:00');
});

test('the real BigQuery client: parameters, maximumBytesBilled, polling, row types, and the resumable load', async () => {
  const sent = [];
  const fake = async (url, init) => {
    sent.push({ url, init, body: init && init.body && !String(init.body).startsWith('{"a"') && init.method !== 'PUT' ? JSON.parse(init.body) : init.body });
    if (/\/queries$/.test(url)) return h.response(200, { jobComplete: false, jobReference: { jobId: 'j1' } });
    if (/\/queries\/j1/.test(url)) return h.response(200, { jobComplete: true, schema: { fields: [{ name: 'n', type: 'INTEGER' }, { name: 'at', type: 'TIMESTAMP' }, { name: 'r', type: 'JSON' }, { name: 'ok', type: 'BOOLEAN' }, { name: 'tags', type: 'STRING', mode: 'REPEATED' }] }, rows: [{ f: [{ v: '7' }, { v: '1759400000000000' }, { v: '{"a":1}' }, { v: 'true' }, { v: [{ v: 'x' }] }] }], totalBytesBilled: '10485760' });
    if (/uploadType=resumable/.test(url)) return new Response('{}', { status: 200, headers: { location: 'https://upload.example/session1' } });
    if (url === 'https://upload.example/session1') return h.response(200, {});
    if (/\/jobs\/nextmove_load_/.test(url)) return h.response(200, { status: { state: 'DONE' } });
    throw new Error(`unexpected ${url}`);
  };
  process.env.NEXTMOVE_BQ_TOKEN = 'test-token';
  try {
    const real = require('../lib/bq').client({ memory: false, fresh: true, fetch: fake, project: 'p1', dataset: 'nextmove', location: 'us-central1' });
    const rows = await real.run(Q.FITS, { key: P.str('k'), since: P.ts('2026-10-01T00:00:00Z') });
    assert.deepStrictEqual(rows[0], { n: 7, at: '2025-10-02T10:13:20.000Z', r: { a: 1 }, ok: true, tags: ['x'] });
    const q = sent[0].body;
    assert.strictEqual(q.maximumBytesBilled, String(2e9));
    assert.strictEqual(q.parameterMode, 'NAMED');
    assert.match(q.query, /FROM `p1\.nextmove\.fits`/);
    assert.deepStrictEqual(q.queryParameters.map((x) => x.name), ['key', 'since']);
    assert.strictEqual(sent[0].init.headers.Authorization, 'Bearer test-token');
    await real.load('fits', [{ user_key: 'k', posting_id: 'p', scored_at: '2026-10-01T00:00:00Z', score: 1 }]);
    const start = sent.find((s) => /uploadType=resumable/.test(s.url)).body;
    assert.deepStrictEqual([start.configuration.load.sourceFormat, start.configuration.load.writeDisposition, start.configuration.load.createDisposition], ['NEWLINE_DELIMITED_JSON', 'WRITE_APPEND', 'CREATE_NEVER']);
    assert.strictEqual(start.jobReference.location, 'us-central1');
    assert.throws(() => require('../lib/bq').client({ memory: false, fresh: true, dataset: 'next-move; drop' }), /bad BigQuery/);
  } finally { delete process.env.NEXTMOVE_BQ_TOKEN; }
});

test('the HTTP client is polite: its User-Agent, a gap per host, retries with backoff on 429/5xx only, a size ceiling', async () => {
  let n = 0;
  const seen = [];
  const slept = [];
  let clock = 0;
  const f = async (url, init) => {
    seen.push({ url, ua: init.headers['User-Agent'], at: clock });
    if (/flaky/.test(url)) { n++; return n < 3 ? h.response(503, { e: 1 }, { 'retry-after': '2' }) : h.response(200, { ok: true }); }
    if (/missing/.test(url)) return h.response(404, { e: 1 });
    if (/huge/.test(url)) return h.response(200, 'x'.repeat(5000));
    if (/broken/.test(url)) throw new Error('ECONNRESET');
    return h.response(200, { ok: true });
  };
  const c = httpLib.create({ fetch: f, hostGapMs: 1000, retries: 2, backoffMs: 100, sleep: async (ms) => { slept.push(ms); clock += ms; }, now: () => clock });
  assert.deepStrictEqual(await c.json('https://a.example/flaky'), { ok: true });
  assert.strictEqual(n, 3, 'two retries');
  assert.ok(slept.includes(2000), 'Retry-After is honoured');
  assert.strictEqual(await c.json('https://a.example/missing'), null, '404 is an answer, not retried');
  assert.strictEqual(seen.filter((s) => /missing/.test(s.url)).length, 1);
  await assert.rejects(c.json('https://b.example/huge', { maxBytes: 100 }), /too large/);
  await assert.rejects(c.json('https://b.example/broken'), /network/);
  assert.strictEqual(seen.filter((s) => /broken/.test(s.url)).length, 3, 'network errors are retried, then thrown');
  const at = seen.filter((s) => s.url.startsWith('https://a.example')).map((s) => s.at);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 1000, `requests to one host are spaced: ${at}`);
  assert.ok(seen.every((s) => /^NextMove\/1\.0 \(\+https:/.test(s.ua)), 'an identifying User-Agent');
  assert.ok(!/@/.test(httpLib.DEFAULT_UA), 'and no contact address in the default');
});

test('an unknown job exits non-zero with one JSON line', async () => {
  assert.strictEqual(await jobs.main('nonsense', { quiet: true }), 1);
  const r = spawnSync(process.execPath, ['jobs/run.js', 'nonsense'], { cwd: ROOT, env: process.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  const line = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepStrictEqual([line.job, line.ok, line.errors], ['nonsense', false, 1]);
});

test('user keys are an HMAC of the uid under a derived key - never the uid, and none without the secret', () => {
  const k = keyFor('dXNlckBleGFtcGxlLmNvbQ', 'secret-one');
  assert.ok(/^[0-9a-f]{40}$/.test(k));
  assert.strictEqual(k, keyFor('dXNlckBleGFtcGxlLmNvbQ', 'secret-one'), 'stable');
  assert.notStrictEqual(k, keyFor('dXNlckBleGFtcGxlLmNvbQ', 'secret-two'), 'keyed');
  assert.notStrictEqual(k, require('crypto').createHash('sha256').update('dXNlckBleGFtcGxlLmNvbQ').digest('hex').slice(0, 40), 'not a plain hash anyone could compute');
  assert.throws(() => keyFor('u', ''), /refusing/);
});

test('local-only switches throw on Cloud Run, service and job alike', () => {
  for (const runEnv of [{ K_SERVICE: 'nextmove' }, { CLOUD_RUN_JOB: 'nextmove-daily' }]) {
    for (const [mod, env] of [['./lib/store', { NEXTMOVE_MEMORY: '1' }], ['./lib/bq', { NEXTMOVE_MEMORY: '1' }], ['./lib/fakeai', { NEXTMOVE_FAKE_AI: '1' }], ['./lib/context', { NEXTMOVE_FAKE_AI: '1', NEXTMOVE_MEMORY: '' }]]) {
      const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, NEXTMOVE_MEMORY: '', NEXTMOVE_FAKE_AI: '', ...env, ...runEnv }, encoding: 'utf8' });
      assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
      assert.match(r.stderr, /refused on Cloud Run/);
    }
  }
});

test('the page: no inline script or handlers, the banner, relative links, the honest lines, storage wrapped, contrast', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links');
  assert.match(html, /never scrapes LinkedIn, Indeed or Glassdoor/);
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(html) && !/mailto:/i.test(html), 'no email address in the page');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(!/<script/i.test(js) && !/\son[a-z]+=\\?["']/.test(js.replace(/\.on[a-z]+ =/g, '')), 'no handler written into markup');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js));
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 2, 'only the remembered tab is kept in the browser');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  const tokens = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
  const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
  const dark = tokens(css.slice(css.indexOf(':root:not([data-theme="light"])'), css.indexOf(':root[data-theme="dark"]')));
  const dark2 = tokens(css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('* { box-sizing')));
  assert.deepStrictEqual(dark2, dark, 'the forced dark theme matches the system one');
  const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs = [['text', 'bg'], ['text', 'card'], ['text', 'card2'], ['muted', 'card'], ['muted', 'bg'], ['muted', 'card2'], ['link', 'card'], ['link', 'bg'], ['link', 'card2'], ['accent-ink', 'accent'], ['text', 'accent-soft'], ['muted', 'accent-soft'], ['text', 'input'],
    ['strong', 'strong-bg'], ['worth', 'worth-bg'], ['stretch', 'stretch-bg'], ['skip', 'skip-bg'], ['layoff', 'layoff-bg'], ['exec', 'exec-bg'], ['deal', 'deal-bg'], ['money', 'money-bg'], ['err', 'card'], ['err', 'card2'], ['layoff', 'card'],
    ['hero-ink', 'hero-a'], ['hero-ink', 'hero-b'], ['hero-soft', 'hero-a'], ['hero-soft', 'hero-b'], ['hero-gold', 'hero-a'], ['hero-gold', 'hero-b'], ['text', 'card']];
  for (const [name, t] of [['light', light], ['dark', { ...light, ...dark }]]) {
    for (const [fg, bg] of pairs) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name}: --${fg} on --${bg} is ${ratio(t[fg], t[bg]).toFixed(2)}:1`);
    assert.ok(ratio(t['bar-mid'], t.card2) >= 3, `${name}: the median mark is visible on its track`);
  }
  assert.ok(ratio('#0f2a3d', '#ffffff') >= 4.5, 'the white button on the strip');
  assert.match(css, /min-height: 44px/);
});

test('the sample: made up, complete, and consistent with what the API returns', () => {
  assert.match(S.who, /^Example/);
  assert.ok(S.fits.length >= 5 && S.companies.length >= 4 && S.comps.length >= 2);
  for (const f of S.fits) {
    assert.ok(fit.VERDICTS.includes(f.verdict) && f.score >= 0 && f.score <= 100 && f.strengths.every((s) => s.point && s.quote), f.title);
    assert.deepStrictEqual(Object.keys(f).filter((k) => k !== 'example').sort(), Object.keys(insights.fitView({ reasons: {} })).sort(), 'same shape as a live fit');
  }
  assert.ok(S.comps.some((c) => c.posted.byState.some((r) => !r.enough)), 'shows what "not enough data" looks like');
  assert.ok(!/@/.test(JSON.stringify(S)), 'no addresses in the sample');
});

/* ================================================================== *
 * Over HTTP: gates, the profile, the watchlist
 * ================================================================== */

const BIG = () => ({ pdf: { data: 'A'.repeat(13 * 1024 * 1024) } });
const RESUME = 'Jordan Example\nDirector of Analytics, Example Health (2021-present)\nBuilt the demand forecasting program; led a team of 14.\nSenior Manager, Analytics, Example Retail (2016-2021).\nSkills: SQL, Python, Looker, dbt.';

test('signed out: the page and the sample work with no BigQuery query and no model call; nothing private does', async () => {
  const anon = h.client(base);
  const before = { bq: bq._calls.length, ai: (await usage()).length };
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  for (const f of ['app.js', 'app.css', 'sample.js', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.deepStrictEqual((await anon('GET', '/api/me')).data, { signedIn: false });
  assert.strictEqual((await anon('GET', '/api/meta')).status, 200);
  for (const [m, p] of [['GET', '/api/profile'], ['PUT', '/api/profile'], ['POST', '/api/watchlist'], ['DELETE', '/api/watchlist/greenhouse:x'], ['GET', '/api/today'], ['GET', '/api/companies'], ['GET', '/api/comp'], ['GET', '/api/week'], ['POST', '/api/score-now'], ['DELETE', '/api/me'], ['POST', '/api/profile/extract']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  assert.strictEqual((await anon('POST', '/api/profile/extract', BIG())).status, 401, 'the gate answers before the 12 MB parser');
  assert.strictEqual((await anon('PUT', '/api/profile', { x: 'x'.repeat(100 * 1024) })).status, 413, 'everything else keeps the small limit');
  await settle();
  assert.deepStrictEqual({ bq: bq._calls.length, ai: (await usage()).length }, before, 'no BigQuery query, no model call');
});

test('the model routes\' gates come before their parsers and before any call, in order', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/profile/extract', 'post').route.stack.map((l) => l.handle.name).slice(0, 5), ['requireUser', 'requireBudget', 'requireDailyCap', 'sameOriginOnly', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/score-now', 'post').route.stack.map((l) => l.handle.name).slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'sameOriginOnly']);
  for (const [p, m] of [['/api/profile', 'get'], ['/api/profile', 'put'], ['/api/watchlist', 'post'], ['/api/watchlist/:key', 'delete'], ['/api/today', 'get'], ['/api/companies', 'get'], ['/api/comp', 'get'], ['/api/week', 'get'], ['/api/me', 'delete']]) {
    assert.strictEqual(layer(p, m).route.stack[0].handle.name, 'requireUser', `${m} ${p}`);
  }
  for (const [p, m] of [['/api/profile', 'put'], ['/api/watchlist', 'post'], ['/api/watchlist/:key', 'delete'], ['/api/me', 'delete']]) {
    assert.ok(layer(p, m).route.stack.some((l) => l.handle.name === 'sameOriginOnly'), `${m} ${p} is same-origin only`);
  }
});

let ana;
test('reading a resume: checked before any spend, one metered call, contact details scrubbed, nothing stored', async () => {
  ana = await register('ana.analytics@example.com');
  const calls = (await usage()).length;
  for (const bad of [{}, { text: 'too short' }, { text: 'x'.repeat(40001) }, { pdf: { data: Buffer.from('hello world').toString('base64') } }, { pdf: { data: Buffer.from('%PDF-1.7 /Encrypt 5 0 R ' + 'x'.repeat(300)).toString('base64') } }]) {
    assert.strictEqual((await ana('POST', '/api/profile/extract', bad)).status, 400, JSON.stringify(bad).slice(0, 50));
  }
  assert.strictEqual((await ana('POST', '/api/profile/extract', BIG())).status, 413);
  assert.strictEqual((await ana('POST', '/api/profile/extract', { text: RESUME }, { Origin: 'https://evil.example' })).status, 403, 'cross-site is refused');
  await settle();
  assert.strictEqual((await usage()).length, calls, 'no model call for a bad request');
  const dump = ctx.store._dump();
  const r = await ana('POST', '/api/profile/extract', { text: RESUME });
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(r.text.startsWith(' '), 'streamed whitespace first');
  assert.strictEqual(r.data.background.headline, 'Director of Analytics, healthcare and retail');
  assert.ok(!/@|555-0134/.test(r.text), 'the email and phone the model returned are scrubbed');
  assert.ok(!r.text.includes('<script>') && r.data.background.roles.every((x) => x.title && !/[<>]/.test(x.title)));
  assert.deepStrictEqual(r.data.background.skills.filter((s) => s === 'SQL').length, 1, 'deduplicated');
  assert.deepStrictEqual(r.data.suggested.titles.slice(0, 1), ['Director of Analytics']);
  await settle();
  const rows = (await usage()).slice(calls);
  assert.deepStrictEqual(rows.map((u) => [u.uid, u.app]), [[uidOf('ana.analytics@example.com'), 'nextmove']], 'one call, charged to her');
  assert.strictEqual(ctx.store._dump(), dump, 'reading stores nothing');
  const pdf = Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n${RESUME}\n%%EOF`, 'latin1').toString('base64');
  assert.strictEqual((await ana('POST', '/api/profile/extract', { pdf: { data: pdf } })).status, 200);
  const nope = await ana('POST', '/api/profile/extract', { text: `NOTARESUME ${'lorem ipsum '.repeat(20)}` });
  assert.deepStrictEqual([nope.status, /does not look like a resume/.test(nope.data.error)], [200, true], 'after the stream starts, a failure is a 200 {error}');
});

test('out of credit or unconfirmed: 402 / 403 before any call or big body', async () => {
  const cal = await register('cal.broke@example.com');
  await ctx.identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = (await usage()).length;
  const r = await cal('POST', '/api/profile/extract', { text: RESUME });
  assert.strictEqual(r.status, 402);
  assert.ok(r.data.topUpUrl !== undefined);
  assert.strictEqual((await cal('POST', '/api/profile/extract', BIG())).status, 402, '402, not 413');
  assert.strictEqual((await cal('POST', '/api/score-now', {})).status, 402);
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const v = await eve('POST', '/api/profile/extract', { text: RESUME });
    assert.deepStrictEqual([v.status, v.data.code], [403, 'verify-email']);
    assert.strictEqual((await eve('POST', '/api/profile/extract', BIG())).status, 403);
    assert.strictEqual((await eve('PUT', '/api/profile', h.demoProfile())).status, 200, 'setting up needs no AI and no confirmed address');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  await settle();
  assert.strictEqual((await usage()).length, calls);
});

test('the profile and the watchlist: cleaned, bounded, cached probes, nobody else\'s', async () => {
  const bad = await ana('PUT', '/api/profile', { targets: { titles: [] } });
  assert.strictEqual(bad.status, 400);
  const p = h.demoProfile();
  p.background.summary = `<img src=x onerror=alert(1)>${'z'.repeat(5000)}`;
  p.targets.compFloor = '$185k';
  p.targets.titles.push('A', 'B', 'C', 'D', 'E');
  p.extra = 'ignored'; p.watchlist = [{ companyKey: 'greenhouse:evil' }];
  const r = await ana('PUT', '/api/profile', p);
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual([r.data.profile.targets.compFloor, r.data.profile.targets.titles.length, r.data.profile.background.summary.length <= 1200, /[<>]/.test(r.data.profile.background.summary), r.data.profile.watchlist.length], [185000, 5, true, false, 0], 'a watchlist cannot be written through the profile');
  await ana('PUT', '/api/profile', h.demoProfile());
  const before = outside().length;
  const a1 = await ana('POST', '/api/watchlist', { input: 'https://job-boards.greenhouse.io/harborview' });
  assert.deepStrictEqual([a1.status, a1.data.added.companyKey, a1.data.added.name, /Greenhouse board/.test(a1.data.message)], [200, 'greenhouse:harborview', 'Harborview Health', true]);
  assert.strictEqual((await ana('POST', '/api/watchlist', { input: 'boards.greenhouse.io/harborview' })).status, 409, 'already watched');
  const n1 = await ana('POST', '/api/watchlist', { input: 'Northwind Logistics' });
  assert.strictEqual(n1.data.added.companyKey, 'lever:northwind');
  const b1 = await ana('POST', '/api/watchlist', { input: 'Brightwater Insurance' });
  assert.deepStrictEqual([b1.data.added.found, /No public careers board/.test(b1.data.message)], [false, true]);
  const probes = outside().length - before;
  const bob = await register('bob.second@example.com');
  await bob('POST', '/api/watchlist', { input: 'Brightwater Insurance' });
  assert.strictEqual(outside().length - before, probes, 'a name probed before is answered from the cache');
  assert.ok(outside().slice(before).every((c) => /^https:\/\/(boards-api\.greenhouse\.io|api\.lever\.co|api\.ashbyhq\.com)\//.test(c.url)), 'probes go only to the three board APIs');
  assert.ok(outside().slice(before).every((c) => /^NextMove\//.test(c.headers['User-Agent'])), 'with an identifying User-Agent');
  assert.strictEqual((await bob('DELETE', `/api/watchlist/${encodeURIComponent('greenhouse:harborview')}`, {})).status, 404, 'removing what you do not watch is a 404');
  assert.strictEqual((await ana('POST', '/api/watchlist', { input: 'x' })).status, 400);
  assert.strictEqual((await ana('POST', '/api/watchlist', { input: 'jobs.ashbyhq.com/copperline' })).status, 200);
  const prof = (await ana('GET', '/api/profile')).data.profile;
  assert.deepStrictEqual(prof.watchlist.map((w) => w.companyKey), ['greenhouse:harborview', 'lever:northwind', 'name:brightwater-insurance', 'ashby:copperline']);
  assert.ok(!JSON.stringify((await bob('GET', '/api/profile')).data).includes('Harborview'), 'bob sees only his own');
});

/* ================================================================== *
 * The daily job
 * ================================================================== */

test('daily: boards upserted, filings and news stored, the top N scored and charged to each person', async () => {
  const before = (await usage()).length;
  const code = await daily({ now: '2026-10-01T11:15:00.000Z' });
  assert.strictEqual(code, 0);
  const last = await ctx.store.get('control', 'last-run');
  assert.ok(last.ok && last.counts.boards === 3, JSON.stringify(last));
  assert.deepStrictEqual([last.counts.postingsNew, last.counts.postingsClosed], [7, 0]);
  const postings = bq._tables.get('postings');
  assert.strictEqual(postings.filter((p) => p.source !== 'websearch').length, 7);
  assert.ok(!bq._tables.has(`postings_stage_${last.runId}`), 'the stage table is dropped');
  const events = bq._tables.get('company_events');
  assert.deepStrictEqual(events.filter((e) => e.source === 'sec').map((e) => e.event_type).sort(), ['exec_change', 'layoff']);
  assert.ok(events.some((e) => e.source === 'gdelt' && e.event_type === 'layoff'));
  const secCalls = outside().filter((c) => /sec\.gov/.test(c.url));
  assert.ok(secCalls.length && secCalls.every((c) => c.headers['User-Agent'] === process.env.SEC_USER_AGENT), 'EDGAR is called with the configured User-Agent');
  const anaKey = keyFor(uidOf('ana.analytics@example.com'));
  const fits = bq._tables.get('fits').filter((f) => f.user_key === anaKey);
  assert.ok(fits.length >= 1 && fits.length <= 5, `free tier: at most 5 (${fits.length})`);
  for (const f of fits) {
    assert.ok(f.cost_usd > 0 && f.model === 'claude-haiku-4-5' && f.reasons.strengths.every((s) => !/not anywhere in the posting/.test(s.quote)));
  }
  await settle();
  const charged = (await usage()).slice(before);
  assert.ok(charged.length >= fits.length && charged.every((u) => u.uid && u.route === 'nextmove-score'), 'every call charged to a person');
  assert.strictEqual(charged.filter((u) => u.uid === uidOf('ana.analytics@example.com')).length, fits.length);
  const board = await ctx.store.get('boards', 'greenhouse:harborview');
  assert.deepStrictEqual([board.openCount, board.newThisWeek], [3, 3]);
  const nw = await ctx.store.get('boards', 'lever:northwind');
  assert.strictEqual(nw.cik, 1990001, 'the CIK is resolved once and kept');
  // Again: nothing new, nothing paid for twice.
  const before2 = (await usage()).length;
  await daily({ now: '2026-10-02T11:15:00.000Z' });
  await settle();
  const again = await ctx.store.get('control', 'last-run');
  assert.deepStrictEqual([again.counts.postingsNew, again.counts.postingsChanged, again.counts.postingsClosed], [0, 0, 0]);
  assert.strictEqual((await usage()).length, before2, 'the second run scores nothing: already scored, nothing changed');
  assert.strictEqual(bq._tables.get('company_events').length, events.length, 'events are not stored twice');
});

test('the MERGE: a changed posting is updated, a gone one closed, a returning one reopened - and a board that failed closes nothing', async () => {
  const jobsFix = JSON.parse(h.fixture('greenhouse-jobs.json'));
  const id = (ext) => boards.sha(`greenhouse|harborview|${ext}`);
  const rowOf = (ext) => bq._tables.get('postings').find((p) => p.posting_id === id(ext));
  const firstSeen = rowOf(4012001).first_seen;
  // Changed text on one, one gone.
  const changed = JSON.parse(JSON.stringify(jobsFix));
  changed.jobs[0].content += '&lt;p&gt;Now hiring two.&lt;/p&gt;';
  changed.jobs = changed.jobs.slice(0, 2);
  swap['boards-api\\.greenhouse\\.io/v1/boards/harborview/jobs'] = () => changed;
  await daily({ now: '2026-10-03T11:15:00.000Z' });
  let last = await ctx.store.get('control', 'last-run');
  assert.deepStrictEqual([last.counts.postingsChanged, last.counts.postingsClosed], [1, 1]);
  assert.ok(/Now hiring two/.test(rowOf(4012001).description_text) && rowOf(4012001).first_seen === firstSeen, 'updated in place, first_seen kept');
  assert.strictEqual(rowOf(4012001).last_seen, '2026-10-03T11:15:00.000Z');
  assert.strictEqual(rowOf(4012003).closed_at, '2026-10-03T11:15:00.000Z');
  // The board fails: nothing of it is closed.
  swap['boards-api\\.greenhouse\\.io/v1/boards/harborview/jobs'] = () => h.response(500, { error: 'down' });
  await daily({ now: '2026-10-04T11:15:00.000Z' });
  last = await ctx.store.get('control', 'last-run');
  assert.deepStrictEqual([last.counts.boardsFailed, rowOf(4012001).closed_at, last.ok], [1, null, true], 'a failed board is an error in the run, not a closure');
  assert.match((await ctx.store.get('boards', 'greenhouse:harborview')).lastError, /500/);
  // Back, with the gone posting returning: reopened, one row each.
  delete swap['boards-api\\.greenhouse\\.io/v1/boards/harborview/jobs'];
  await daily({ now: '2026-10-05T11:15:00.000Z' });
  assert.strictEqual(rowOf(4012003).closed_at, null);
  const ids = bq._tables.get('postings').map((p) => p.posting_id);
  assert.strictEqual(ids.length, new Set(ids).size, 'never a duplicate row');
});

test('daily metering: skipped with no credit or unconfirmed, members get more on Sonnet, the run caps hold', async () => {
  const mo = await register('mo.member@example.com');
  await setUp(mo);
  await ctx.identityStore.merge('users', uidOf('mo.member@example.com'), { plan: 'member', currentPeriodEnd: '2099-01-01T00:00:00Z', toppedUpUsd: 5 });
  const nia = await register('nia.nocredit@example.com');
  await setUp(nia);
  await ctx.identityStore.merge('users', uidOf('nia.nocredit@example.com'), { spentUsd: 50 });
  for (const e of ['nia.nocredit@example.com', 'mo.member@example.com']) await ctx.identityStore.merge('users', uidOf(e), { emailVerifiedAt: new Date().toISOString() });
  const uma = await register('uma.unconfirmed@example.com');
  await setUp(uma);
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  const before = (await usage()).length;
  try { await daily({ now: '2026-10-06T11:15:00.000Z' }); } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  await settle();
  const last = await ctx.store.get('control', 'last-run');
  assert.ok(last.counts.skipped['no-credit'] >= 1 && last.counts.skipped.unverified >= 1, JSON.stringify(last.counts.skipped));
  const rows = (await usage()).slice(before);
  assert.ok(!rows.some((u) => u.uid === uidOf('nia.nocredit@example.com') || u.uid === uidOf('uma.unconfirmed@example.com')), 'no call charged to the skipped');
  const moFits = bq._tables.get('fits').filter((f) => f.user_key === keyFor(uidOf('mo.member@example.com')));
  assert.ok(moFits.length >= 1 && moFits.every((f) => f.model === 'claude-sonnet-5'), 'members on Sonnet');
  assert.strictEqual(rows.filter((u) => u.uid === uidOf('mo.member@example.com')).length, moFits.length);
  assert.strictEqual((await ctx.store.get('users', uidOf('nia.nocredit@example.com'))).lastRun.skipped, 'no-credit', 'the page can say why');
  // The run-wide cap.
  const zed = await register('zed.capped@example.com');
  await setUp(zed);
  const b2 = (await usage()).length;
  await daily({ now: '2026-10-07T11:15:00.000Z', env: { ...process.env, NEXTMOVE_MAX_CALLS_PER_RUN: '2', NEXTMOVE_SCORE_CONCURRENCY: '1' } });
  await settle();
  const capped = await ctx.store.get('control', 'last-run');
  assert.ok(capped.counts.calls <= 2 && (await usage()).length - b2 <= 2, `cap held: ${capped.counts.calls}`);
  assert.ok(capped.counts.skipped['run-cap'] >= 1);
});

test('nothing that identifies a person ever reaches BigQuery', async () => {
  const dump = bq._dump();
  for (const email of ['ana.analytics@example.com', 'mo.member@example.com', 'bob.second@example.com']) {
    assert.ok(!dump.includes(email), email);
    assert.ok(!dump.includes(uidOf(email)), `uid of ${email}`);
  }
  for (const word of ['Twelve years building analytics teams', 'MS Statistics', 'Jordan']) assert.ok(!dump.includes(word), `background: ${word}`);
  const keys = new Set(bq._tables.get('fits').map((f) => f.user_key));
  for (const k of keys) assert.ok(/^[0-9a-f]{40}$/.test(k));
});

/* ================================================================== *
 * Reading it back
 * ================================================================== */

test('Today, Companies, Pay and This week read only your own rows', async () => {
  const t = await ana('GET', '/api/today');
  assert.strictEqual(t.status, 200);
  assert.ok(t.data.fits.length >= 1);
  const f0 = t.data.fits[0];
  assert.ok(f0.title && f0.company && f0.strengths.length && f0.verdictLabel && f0.url.startsWith('https://'));
  const theirs = new Set(t.data.fits.map((f) => f.postingId));
  const bob = h.client(base);
  await bob('POST', '/api/auth/login', { email: 'bob.second@example.com', password: 'a long enough password' });
  const bt = await bob('GET', '/api/today');
  assert.deepStrictEqual(bt.data.fits, [], 'bob has no fits, and cannot see ana\'s');
  assert.ok(!bq._calls.filter((c) => c.name === 'fits_for_user').some((c) => c.params.key.value === uidOf('ana.analytics@example.com')));
  assert.ok(bq._calls.filter((c) => c.kind === 'query').every((c) => c.maxBytes > 0), 'every query carried maximumBytesBilled');
  const c = await ana('GET', '/api/companies');
  const nw = c.data.companies.find((x) => x.companyKey === 'lever:northwind');
  assert.ok(nw.events.some((e) => e.type === 'layoff') && nw.openCount === 2);
  assert.strictEqual(c.data.companies.find((x) => x.companyKey === 'name:brightwater-insurance').found, false);
  const w = await ana('GET', '/api/week');
  assert.ok(w.data.digest.counts.fits >= 1 && w.data.digest.topFits.every((x) => theirs.has(x.postingId)));
  assert.strictEqual((await ana('GET', '/api/comp')).status, 200);
});

test('comp-refresh: LCA (xlsx and CSV) and OEWS loaded, each file replacing its own period; Pay reads them with sample sizes', async () => {
  const env = { ...process.env, LCA_URLS: `${LCA_URL}, ${LCA_CSV_URL}`, OEWS_URLS: `${OEWS_NAT},${OEWS_ST}` };
  assert.strictEqual(await jobs.main('comp-refresh', { quiet: true, env }), 0);
  const rows = () => bq._tables.get('comp_public');
  const lcaRows = rows().filter((r) => r.source === 'h1b_lca');
  assert.strictEqual(lcaRows.filter((r) => r.year === 2026 && r.quarter === 2).length, 33);
  assert.strictEqual(lcaRows.filter((r) => r.year === 2019).length, 15, 'the CSV file too');
  assert.deepStrictEqual(rows().filter((r) => r.source === 'bls_oews').map((r) => r.worksite_state).sort(), ['GA', null].sort(), 'national and state files of one year swapped in together');
  assert.ok(!JSON.stringify(rows()).includes('@'), 'no contact columns loaded');
  // Again: replaced, not doubled.
  await jobs.main('comp-refresh', { quiet: true, env });
  assert.strictEqual(rows().filter((r) => r.source === 'h1b_lca' && r.year === 2026).length, 33);
  assert.strictEqual(rows().filter((r) => r.source === 'bls_oews').length, 2);
  assert.ok(![...bq._tables.keys()].some((k) => k.startsWith('comp_stage_')), 'stage tables dropped');
  const lcaCall = outside().find((c) => c.url === LCA_URL);
  assert.ok(lcaCall && /@example\.com/.test(lcaCall.headers['User-Agent']), 'downloads carry the contact User-Agent');
  // Pay for a title with H-1B data and a benchmark.
  const comp = await insights.comp(bq, 'Director of Analytics', '2026-10-07T00:00:00Z');
  assert.ok(comp.h1b.all.n >= 30 && comp.h1b.all.enough && comp.h1b.all.p50 > 160000);
  assert.ok(comp.h1b.byState.every((s) => s.enough === s.n >= 10), 'below 10, "not enough data"');
  assert.deepStrictEqual([comp.oews.soc, comp.oews.national.p50, comp.oews.byState[0].state], ['11-3021', 172000, 'GA']);
  assert.strictEqual(comp.posted.all.n >= 1, true);
  const none = await insights.comp(bq, 'Underwater Basket Weaver', '2026-10-07T00:00:00Z');
  assert.deepStrictEqual([none.h1b.all.n, none.h1b.all.enough, none.oews], [0, false, null]);
  // A file with no FYyyyy in its name is refused, not guessed.
  await jobs.main('comp-refresh', { quiet: true, env: { ...env, LCA_URLS: 'https://www.dol.gov/x/latest.xlsx', OEWS_URLS: '' } });
  assert.match(JSON.stringify(await ctx.store.get('control', 'last-comp-refresh')), /no FYyyyy_Qn/);
});

/* ================================================================== *
 * Weekly
 * ================================================================== */

test('weekly: one sweep per eligible person, charged to them; finds validated and deduplicated; a digest for everyone', async () => {
  // A posting the boards already hold, at the URL the sweep will return.
  await bq.load('postings', [{ ...bq._tables.get('postings')[0], posting_id: 'knownurl', url: 'https://jobs.already-known.example/123' }]);
  const before = (await usage()).length;
  const anaKey = keyFor(uidOf('ana.analytics@example.com'));
  await ctx.identityStore.merge('users', uidOf('nia.nocredit@example.com'), { spentUsd: 50 });
  assert.strictEqual(await jobs.main('weekly', { quiet: true, now: '2026-10-11T12:15:00.000Z' }), 0);
  await settle();
  const last = await ctx.store.get('control', 'last-weekly');
  assert.ok(last.counts.swept >= 2 && last.counts.skipped['no-credit'] >= 1, JSON.stringify(last.counts));
  const rows = (await usage()).slice(before);
  assert.ok(rows.length && rows.every((u) => u.route === 'nextmove-sweep' && u.uid), 'each sweep charged to its person');
  assert.ok(!rows.some((u) => u.uid === uidOf('nia.nocredit@example.com')));
  const ws = bq._tables.get('postings').filter((p) => p.source === 'websearch');
  assert.deepStrictEqual(ws.map((p) => p.url), ['https://careers.peachtree-payments.example/jobs/4411'], 'one new posting: aggregators, junk links, duplicates and known URLs dropped - across people too');
  assert.ok(bq._tables.get('company_events').some((e) => e.source === 'websearch'));
  const digest = await ctx.store.get(`users/${uidOf('ana.analytics@example.com')}/digests`, '2026-10-05');
  assert.ok(digest && digest.counts && Array.isArray(digest.topFits), 'the digest snapshot is stored under the person');
  assert.ok((await ctx.store.get(`users/${uidOf('nia.nocredit@example.com')}/digests`, '2026-10-05')), 'no credit still gets a digest - it costs nothing');
  // The next daily run scores the sweep's posting.
  await daily({ now: '2026-10-12T11:15:00.000Z' });
  assert.ok(bq._tables.get('fits').some((f) => f.user_key === anaKey && f.source === 'websearch'), 'a websearch posting is scored like any other');
});

/* ================================================================== *
 * Score now, delete
 * ================================================================== */

test('score now: metered, once a day, and only what was not scored yet', async () => {
  const sam = await register('sam.scorenow@example.com');
  assert.strictEqual((await sam('POST', '/api/score-now', {})).status, 400, 'not set up yet');
  await setUp(sam);
  const before = (await usage()).length;
  const r = await sam('POST', '/api/score-now', {});
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(r.data.scored >= 1 && r.data.scored <= 3, JSON.stringify(r.data));
  await settle();
  assert.deepStrictEqual((await usage()).slice(before).map((u) => u.uid), Array(r.data.scored).fill(uidOf('sam.scorenow@example.com')));
  assert.strictEqual((await sam('GET', '/api/today')).data.fits.length, r.data.scored);
  assert.strictEqual((await sam('POST', '/api/score-now', {})).status, 429, 'once a day');
});

test('delete my data: the profile, digests and every fit row go; the shared account stays; nobody else\'s is touched', async () => {
  const anaUid = uidOf('ana.analytics@example.com');
  const anaKey = keyFor(anaUid);
  const moKey = keyFor(uidOf('mo.member@example.com'));
  const moBefore = bq._tables.get('fits').filter((f) => f.user_key === moKey).length;
  const n = bq._tables.get('fits').filter((f) => f.user_key === anaKey).length;
  assert.ok(n > 0);
  assert.strictEqual((await ana('DELETE', '/api/me', {})).status, 400, 'needs the confirmation');
  assert.strictEqual((await ana('DELETE', '/api/me', { confirm: 'delete' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const r = await ana('DELETE', '/api/me', { confirm: 'delete' });
  assert.deepStrictEqual([r.status, r.data.fitsDeleted, r.data.digestsDeleted >= 1], [200, n, true]);
  assert.strictEqual(bq._tables.get('fits').filter((f) => f.user_key === anaKey).length, 0);
  assert.strictEqual(bq._tables.get('fits').filter((f) => f.user_key === moKey).length, moBefore, 'others untouched');
  assert.strictEqual(await ctx.store.get('users', anaUid), null);
  assert.deepStrictEqual(await ctx.store.list(`users/${anaUid}/digests`), []);
  assert.ok(await ctx.identityStore.get('users', anaUid), 'the shared account is not this app\'s to delete');
  const me = await ana('GET', '/api/me');
  assert.deepStrictEqual([me.data.signedIn, me.data.onboarded], [true, false]);
  assert.deepStrictEqual((await ana('GET', '/api/today')).data.fits, []);
});

test('nothing logged carries a body, a resume or an address', () => {
  for (const f of ['server.js', 'lib/daily.js', 'lib/weekly.js', 'lib/comprefresh.js', 'lib/score.js', 'jobs/run.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|resume|profile|background|email|\.text\b)/.test(src), `${f} logs something personal`);
  }
  const all = ['server.js', 'jobs/run.js', 'CLAUDE.md', 'package.json', 'Dockerfile'].concat(fs.readdirSync(path.join(ROOT, 'lib')).map((f) => `lib/${f}`)).filter((f) => fs.existsSync(path.join(ROOT, f)));
  for (const f of all) {
    if (/identity|stripe|webauthn|byok/.test(f)) continue;
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const emails = (s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}/g) || []).filter((e) => !/@example\.(com|org)$|\.iam\.gserviceaccount\.com$/.test(e));
    assert.deepStrictEqual(emails, [], `${f} names an address`);
  }
});

/* ---------------- run ---------------- */

(async () => {
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${String(err.stack).split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
