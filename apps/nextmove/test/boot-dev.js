// A local Next Move with a signed-in demo account and real-shaped data:
//
//   npm run dev:seeded      (NEXTMOVE_MEMORY=1 NEXTMOVE_FAKE_AI=1)
//
// Every outside call is answered from test/fixtures (three invented
// companies' career boards, an SEC filing list, a GDELT answer, a small LCA
// and OEWS file); then the real daily, weekly and comp-refresh jobs run
// against the memory stores, so what the page shows went through the same
// code a deployment runs. Prints the demo sign-in when it is ready.


if (process.env.NEXTMOVE_MEMORY !== '1' || process.env.NEXTMOVE_FAKE_AI !== '1') {
  console.error('run with NEXTMOVE_MEMORY=1 NEXTMOVE_FAKE_AI=1 (npm run dev:seeded)');
  process.exit(1);
}

const h = require('./helpers');

const realFetch = globalThis.fetch;
const LCA_URL = 'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2026_Q4.xlsx';
const OEWS_URL = 'https://www.bls.gov/oes/special-requests/oesm25nat.zip';
const lcaFile = h.xlsx(h.lcaRows(40));
const oewsZip = h.zip([['oesm25nat/national_M2025_dl.xlsx', h.xlsx(h.oewsRows()), false]]);
const fake = h.fakeFetch(h.sourceRoutes([
  [/^http:\/\/(127\.0\.0\.1|localhost)/, (u, init) => realFetch(u, init)],
  [LCA_URL, () => new Response(lcaFile, { status: 200 })],
  [OEWS_URL, () => new Response(oewsZip, { status: 200 })],
]));
globalThis.fetch = fake;

process.env.SEC_USER_AGENT = process.env.SEC_USER_AGENT || 'Next Move dev test-contact@example.com';
process.env.LCA_URLS = LCA_URL;
process.env.OEWS_URLS = OEWS_URL;
process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0';

const { app, ctx } = require('../server');
const jobs = require('../jobs/run');
const http = require('../lib/http');

const PORT = Number(process.env.PORT || 8130);
const EMAIL = 'demo.director@example.com';
const PASSWORD = 'demo password 1234';

async function seed(base) {
  const c = h.client(base);
  let r = await c('POST', '/api/auth/register', { email: EMAIL, password: PASSWORD });
  if (r.status !== 200) r = await c('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (r.status !== 200) throw new Error(`demo sign-in failed: ${r.text}`);
  await ctx.identityStore.merge('users', Buffer.from(EMAIL).toString('base64url'), { emailVerifiedAt: new Date().toISOString() });
  await c('PUT', '/api/profile', h.demoProfile());
  for (const input of ['https://job-boards.greenhouse.io/harborview', 'Northwind Logistics', 'jobs.ashbyhq.com/copperline', 'Brightwater Insurance']) await c('POST', '/api/watchlist', { input });
  const fast = { boards: http.create({ fetch: fake, hostGapMs: 0 }), sec: http.create({ fetch: fake, hostGapMs: 0, userAgent: process.env.SEC_USER_AGENT }), gdelt: http.create({ fetch: fake, hostGapMs: 0 }) };
  // Older fits first, so the week has history.
  await jobs.main('comp-refresh', { quiet: true, fetch: fake });
  await jobs.main('daily', { quiet: true, http: fast, now: new Date(Date.now() - 2 * 864e5).toISOString() });
  await jobs.main('weekly', { quiet: true });
  await ctx.store.merge('users', Buffer.from(EMAIL).toString('base64url'), { profileUpdatedAt: new Date().toISOString() });
  await jobs.main('daily', { quiet: true, http: fast });
  // Comp needs postings with pay over a year; add a spread of past postings.
  const bq = ctx.bqClient();
  const rows = [];
  for (let i = 0; i < 90; i++) {
    const at = new Date(Date.now() - ((i * 4) % 360 + 3) * 864e5).toISOString();
    const st = ['GA', 'NY', 'CA', 'TX', null][i % 5];
    rows.push({ posting_id: `seedpay${i}`, source: 'greenhouse', company_key: 'greenhouse:seed', company_name: 'Seed Co', title: 'Director of Analytics', title_norm: 'analytics director', seniority: 'director', department: null, location: st ? `City, ${st}` : 'Remote', location_state: st, remote: !st, url: null, posted_at: at, first_seen: at, last_seen: at, closed_at: at, pay_min: 150000 + (i % 13) * 4000 + (st === 'NY' || st === 'CA' ? 20000 : 0), pay_max: 190000 + (i % 13) * 4000 + (st === 'NY' || st === 'CA' ? 25000 : 0), pay_currency: 'USD', pay_period: 'year', pay_min_annual: 150000 + (i % 13) * 4000 + (st === 'NY' || st === 'CA' ? 20000 : 0), pay_max_annual: 190000 + (i % 13) * 4000 + (st === 'NY' || st === 'CA' ? 25000 : 0), pay_source: 'posted', description_text: '', content_hash: `h${i}` });
  }
  await bq.load('postings', rows);
}

const server = app.listen(PORT, async () => {
  const base = `http://127.0.0.1:${PORT}`;
  try {
    await seed(base);
    console.log(`nextmove (seeded) on ${base}  sign in: ${EMAIL} / ${PASSWORD}`);
  } catch (err) {
    console.error(err);
    server.close();
    process.exit(1);
  }
});

module.exports = { EMAIL, PASSWORD };
