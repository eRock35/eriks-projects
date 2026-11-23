// As Filed's suite. No network: the app is static, and the tools are tested
// on made-up sources. When the raw-download cache is on this machine
// (~/.cache/filings) the committed dataset is also re-read against it, quote
// by quote and figure by figure; where it is not, that step says so and the
// tamper checks (proofs and the integrity hash) still hold.

process.env.ASFILED_MEMORY = '1';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const Core = require('../public/asfiled-core');
const V = require('../tools/verify');
const T = require('../tools/text');
const { FILERS, OTHERS, byId } = require('../tools/companies');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'dataset.json'), 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
let n = 0;
const ok = (m) => { n += 1; console.log(`  ok ${n} - ${m}`); };

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name === 'node_modules' || f.name === '.git') continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

(async () => {
  /* ---------- the dataset: figures ---------- */
  assert.strictEqual(data.companies.length, 19);
  assert.deepStrictEqual(data.companies.map((c) => c.id).sort(), FILERS.map((c) => c.id).sort());
  const ACCN = /^\d{10}-\d{2}-\d{6}$/;
  const FILING_URL = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/\d{10}-\d{2}-\d{6}-index\.htm$/;
  for (const [id, f] of Object.entries(data.figures)) {
    assert.ok(ACCN.test(f.a), `${id}: accession number`);
    const filing = data.filings[f.a];
    assert.ok(filing && /^(10-K|20-F)$/.test(filing.form) && /^\d{4}-\d\d-\d\d$/.test(filing.filed), `${id}: filing`);
    assert.strictEqual(filing.c, f.c, `${id}: the filing is that company's own`);
    assert.ok(Number.isFinite(f.v) && /^\d{4}-\d\d-\d\d$/.test(f.end) && f.fy === Number(f.end.slice(0, 4)) && f.tag, `${id}: value, period, tag`);
    const src = Core.figureSource(data, id);
    assert.ok(FILING_URL.test(src.url), `${id}: link ${src.url}`);
    assert.ok(src.url.includes(`/${byId[f.c].cik}/`), `${id}: link is under the company's own CIK`);
  }
  ok(`all ${Object.keys(data.figures).length} figures carry a form, a fiscal period, an accession number and a sec.gov filing link under the company's own CIK`);
  for (const c of data.companies) {
    assert.ok(Core.fig(data, c.id, 'revenue', c.latest), `${c.id}: latest revenue`);
    assert.ok(c.years.length >= 10, `${c.id}: ten or more fiscal years`);
  }
  ok('every company has ten or more fiscal years and a latest revenue figure');

  /* ---------- the dataset: edges ---------- */
  const SOURCE_URL = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/[A-Za-z0-9._-]+\.htm$|^https:\/\/www\.apple\.com\/supply-chain\/pdf\/Apple-Supplier-List\.pdf$/;
  const ids = new Set();
  for (const e of data.edges) {
    assert.ok(!ids.has(e.id)); ids.add(e.id);
    assert.ok(V.TYPES.includes(e.type), `${e.id}: type`);
    assert.ok(byId[e.from] && byId[e.to] && e.from !== e.to, `${e.id}: companies`);
    assert.ok(byId[e.by].cik && (e.by === e.from || e.by === e.to), `${e.id}: said by one of the two, and a filer`);
    const src = data.sources[e.source];
    assert.ok(src && src.by === e.by && /^[0-9a-f]{64}$/.test(src.sha), `${e.id}: a source that is the speaker's own document`);
    assert.ok(SOURCE_URL.test(e.url) && e.url === src.url, `${e.id}: link ${e.url}`);
    assert.ok(e.quote && e.quote.length >= 8 && e.quote.length <= 620 && e.quote === T.norm(e.quote), `${e.id}: a short quote`);
    assert.ok(e.section && /^\d{4}-\d\d-\d\d$/.test(e.date) && e.gloss, `${e.id}: section, date, gloss`);
    assert.strictEqual(e.proof, V.proof(src.sha, e.quote), `${e.id}: the quote is the one that was verified against its source`);
    if (e.lead) assert.strictEqual(e.leadProof, V.proof(src.sha, e.lead), `${e.id}: lead-in proof`);
    const other = byId[e.by === e.from ? e.to : e.from];
    assert.ok(V.names(other, e.quote), `${e.id}: the quote itself names ${other.name}`);
    if (e.fig) assert.ok(data.figures[e.fig] && data.figures[e.fig].c === e.by, `${e.id}: its tagged figure`);
    assert.ok(/^https:\/\/www\.(sec\.gov|apple\.com)\//.test(Core.quoteUrl(e)));
  }
  ok(`all ${data.edges.length} edges have a speaker, the speaker's own source, a section, a date, a working-format link, and a verbatim quote that names the other company`);
  assert.ok(!data.edges.some((e) => e.from === 'NVDA' && e.to === 'MSFT' && e.by === 'MSFT'), 'the tripwire reached the dataset');
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'build-report.json'), 'utf8'));
  assert.ok(report.edges.dropped.some((d) => d.tripwire && /not found verbatim/.test(d.why)));
  assert.strictEqual(report.edges.kept, data.edges.length);
  ok('the tripwire (a plausible, unstated NVIDIA -> Microsoft link kept in the curated file) was dropped by the verifier and is not in the dataset');
  const named = new Set(data.edges.flatMap((e) => [e.from, e.to]));
  for (const o of data.others) { assert.ok(named.has(o.id), `${o.id} is on the map with no edge`); assert.ok(OTHERS.some((x) => x.id === o.id)); }
  for (const [a, b] of [['SAMSUNG', 'AAPL'], ['FOXCONN', 'AAPL'], ['TSM', 'AAPL']]) {
    const e = data.edges.filter((x) => x.from === a && x.to === b);
    assert.ok(e.length && e.every((x) => data.sources[x.source].kind === 'supplier-list' || x.by === b || x.by === a));
  }
  ok('a company outside the nineteen appears only because an edge names it; the Apple supplier links rest on Apple\'s own list');

  /* ---------- the insights ---------- */
  const fresh = Core.writeAll(data);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(fresh.insights)), data.insights);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(fresh.patterns)), data.patterns);
  ok('every insight and pattern sentence is rebuilt from the committed figures and matches word for word');
  const sentences = [].concat(...Object.values(data.insights), ...data.patterns.map((p) => p.sentences));
  for (const s of sentences) {
    assert.ok(s.cites.length > 0, `no citation: ${s.text}`);
    for (const c of s.cites) assert.ok(data.figures[c] || ids.has(c), `${c} does not resolve: ${s.text}`);
    assert.ok(!/\b(will|forecast|expect|predict|should|undervalued|overvalued|buy|sell|bullish|bearish|target price)\b/i.test(s.text), `forecast or advice: ${s.text}`);
    // Every money amount and percentage in a sentence is one of its cited
    // figures, or worked out from them: rebuilt above, so only spot-check form.
    assert.ok(/[.]$/.test(s.text));
  }
  assert.ok(sentences.length >= 120);
  ok(`all ${sentences.length} sentences cite figures that exist; none forecasts or advises`);
  assert.strictEqual(data.integrity, Core.integrity(data, sha));
  ok('the integrity hash over figures, edges, insights, patterns, mixes and concentration matches');
  assert.strictEqual(data.disclaimer, 'From public filings. Not investment advice.');

  /* ---------- the verifier, on made-up sources ---------- */
  {
    const text = T.norm('Item 1. Business\nWe rely on third-party foundries.\nWe buy   wafers from\nTSMC under purchase orders. Our current competitors include:\n• makers of chips such as Intel');
    const ctx = { sources: { D: { by: 'NVDA', kind: 'annual-report', form: '10-K', sha: sha(text) } }, texts: { D: text }, rawTexts: { D: 'Item 1. Business\nWe rely on third-party foundries.\nWe buy   wafers from\nTSMC under purchase orders. Our current competitors include:\n• makers of chips such as Intel' }, sectionsOf: {}, concentration: {}, byId };
    const e = (o) => ({ by: 'NVDA', from: 'TSM', to: 'NVDA', type: 'supplier', source: 'D', quote: 'We buy wafers from TSMC under purchase orders.', ...o });
    let r = V.checkEdge(e({}), ctx);
    assert.ok(r.ok && r.section === 'Item 1. Business', JSON.stringify(r)); ok('verifier: a verbatim quote passes, whitespace aside, and gets its section');
    assert.ok(!V.checkEdge(e({ quote: 'We buy wafers from TSMC under long-term purchase orders.' }), ctx).ok); ok('verifier: one changed word drops the edge');
    assert.ok(!V.checkEdge(e({ quote: 'we buy wafers from TSMC under purchase orders.' }), ctx).ok); ok('verifier: a change of case drops the edge (whitespace is the only freedom)');
    r = V.checkEdge(e({ quote: 'We rely on third-party foundries.' }), ctx);
    assert.ok(!r.ok && /does not name/.test(r.why)); ok('verifier: a generic statement that names no counterparty is not an edge');
    assert.ok(!V.checkEdge(e({ from: 'SAMSUNG' }), ctx).ok); ok('verifier: a quote about one company cannot back a link to another');
    assert.ok(!V.checkEdge(e({ by: 'AMD', to: 'AMD' }), ctx).ok); ok('verifier: the source must be the speaker\'s own document');
    assert.ok(V.checkEdge(e({ from: 'NVDA', to: 'INTC', type: 'competitor', quote: 'makers of chips such as Intel', lead: 'Our current competitors include:' }), ctx).ok);
    assert.ok(!V.checkEdge(e({ from: 'NVDA', to: 'INTC', type: 'competitor', quote: 'makers of chips such as Intel', lead: 'Our partners include:' }), ctx).ok); ok('verifier: a lead-in must be verbatim too');
    assert.ok(!V.checkEdge(e({ type: 'friend' }), ctx).ok);
    assert.ok(!V.checkEdge(e({ source: 'missing' }), ctx).ok); ok('verifier: unknown types and missing sources are refused');
  }

  /* ---------- the cache, when it is here ---------- */
  const cache = process.env.FILINGS_CACHE || path.join(os.homedir(), '.cache', 'filings');
  if (fs.existsSync(path.join(cache, 'manifest.json'))) {
    const problems = V.recheck(data);
    assert.deepStrictEqual(problems.slice(0, 5), [], 'the dataset does not match the cache');
    ok(`re-read against the cached sources: ${data.edges.length} quotes found verbatim, ${Object.keys(data.figures).length} figures found in their filings`);
  } else {
    ok('(the raw-download cache is not on this machine: the cached-source re-read was skipped; proofs and the integrity hash were checked)');
  }

  /* ---------- no address, no secret, no whole filing ---------- */
  const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  // Allowed, as in the lab's own scan (root test/spam.js): a test address
  // at example.com, and "name@2x.png"-style file names. Nothing else.
  const ALLOWED = (a) => /@example\.(com|org)$/.test(a) || /^[^@]*@\d/.test(a) || /\.(png|jpg)$/.test(a);
  const ua = String(process.env.SEC_USER_AGENT || '');
  const uaParts = ua ? [ua].concat(ua.match(ADDRESS) || []) : [];
  let scanned = 0;
  for (const file of walk(ROOT)) {
    const body = fs.readFileSync(file, 'utf8');
    scanned += 1;
    const rel = path.relative(ROOT, file);
    const found = (body.match(ADDRESS) || []).filter((a) => !ALLOWED(a));
    assert.deepStrictEqual(found, [], `${rel} carries an email address`);
    for (const part of uaParts) assert.ok(!body.includes(part), `${rel} carries the SEC User-Agent value`);
    assert.ok(!new RegExp('mail' + 'to:', 'i').test(body) || /^lib\//.test(rel), `${rel} has a mailto link`);
  }
  ok(`no email address in any of the app's ${scanned} files or its data${ua ? ', and the SEC_USER_AGENT value appears nowhere' : ' (SEC_USER_AGENT not set here: the value check ran on addresses only)'}`);
  const tools = walk(path.join(ROOT, 'tools')).filter((f) => f.endsWith('.js'));
  for (const f of tools) {
    const body = fs.readFileSync(f, 'utf8');
    if (/SEC_USER_AGENT/.test(body) && !/sec\.js$/.test(f)) assert.ok(!/process\.env\.SEC_USER_AGENT/.test(body), `${f} reads the User-Agent itself`);
    assert.ok(!/console\.(log|error)\([^)]*\b(ua|agent\(\))/.test(body), `${f} may log the User-Agent`);
  }
  const secjs = fs.readFileSync(path.join(ROOT, 'tools', 'sec.js'), 'utf8');
  assert.ok(/process\.env\.SEC_USER_AGENT/.test(secjs) && /process\.exit\(2\)/.test(secjs) && !/User-Agent'\]\s*=\s*'[^']*@/.test(secjs));
  ok('only tools/sec.js reads SEC_USER_AGENT, from the environment, and refuses to run without it');
  assert.ok(fs.statSync(path.join(ROOT, 'public', 'data', 'dataset.json')).size < 900 * 1024);
  assert.ok(Math.max(...data.edges.map((e) => e.quote.length)) <= 620);
  assert.deepStrictEqual(fs.readdirSync(path.join(ROOT, 'public', 'data')), ['dataset.json']);
  ok('only the derived dataset is committed: no filing text beyond short quotes');

  /* ---------- the server, mounted as the lab mounts it ---------- */
  process.env.K_SERVICE = 'x'; process.env.ASFILED_FAKE_AI = '1';
  for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT) && !k.includes('node_modules')) delete require.cache[k];
  assert.throws(() => require('../server.js'), /refused on Cloud Run|local use only/); ok('ASFILED_MEMORY / ASFILED_FAKE_AI are refused on Cloud Run');
  delete process.env.K_SERVICE; delete process.env.ASFILED_FAKE_AI;
  for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT) && !k.includes('node_modules')) delete require.cache[k];
  const { app } = require('../server.js');
  const host = express();
  host.use((req, res, next) => (req.path === '/asfiled' ? res.redirect(301, '/asfiled/') : next()));
  host.use('/asfiled', app);
  const server = await new Promise((r) => { const s = host.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/asfiled`, { redirect: 'manual' });
    assert.strictEqual(r.status, 301); assert.strictEqual(r.headers.get('location'), '/asfiled/');
    r = await fetch(`${base}/asfiled/`);
    const html = await r.text();
    assert.strictEqual(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    assert.ok(/script-src 'self'/.test(csp) && /connect-src 'self'/.test(csp) && /object-src 'none'/.test(csp));
    assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html) && !/\son[a-z]+\s*=/i.test(html) && !/\sstyle\s*=/i.test(html));
    assert.ok(!/(src|href)="\//.test(html.replace(/<!-- lab:og[\s\S]*?\/lab:og -->/, '')), 'an absolute asset path');
    assert.ok(html.includes('From public filings. Not investment advice.'));
    ok('the page is served under its mount with a strict CSP, the verify banner, the disclaimer, relative assets and no inline script, handler or style attribute');
    const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\.|setAttribute\('style'|eval\(/.test(js));
    const fetches = js.match(/fetch\([^)]*\)/g) || [];
    assert.deepStrictEqual(fetches, ["fetch(BASE + 'data/dataset.json')"]);
    assert.ok(!/XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(js));
    ok('the page script builds with textContent only, writes no style, and makes one request: its own dataset');
    for (const f of ['app.js', 'app.css', 'asfiled-core.js', 'verify-banner.js', 'icon.svg', 'manifest.webmanifest', 'data/dataset.json']) assert.strictEqual((await fetch(`${base}/asfiled/${f}`)).status, 200, f);
    r = await fetch(`${base}/asfiled/api/meta`);
    const meta = await r.json();
    assert.deepStrictEqual([meta.companies, meta.edges, meta.integrity], [19, data.edges.length, data.integrity]);
    assert.strictEqual((await fetch(`${base}/asfiled/api/auth/me`)).status, 200);
    assert.strictEqual((await fetch(`${base}/asfiled/api/nope`)).status, 404);
    assert.strictEqual((await fetch(`${base}/asfiled/c/NVDA`)).status, 200);
    ok('assets, the dataset, /api/meta and the shared account answer; nothing else is an API');
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(!/anthropic|messages\.create|fetch\(|https?\.request|sec\.gov\/|generateContent/i.test(srv.replace(/\/\/.*$/gm, '')));
    ok('the server calls no model and makes no outbound request');
    const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
    assert.ok(!/@import|url\(|@font-face/.test(css) && /prefers-color-scheme: dark/.test(css));
    const motion = css.slice(0, css.indexOf('@media (prefers-reduced-motion: no-preference)'));
    assert.ok(!/\b(transition|animation)\s*:/.test(motion), 'motion outside the reduced-motion guard');
    ok('the stylesheet loads nothing, has a dark theme, and keeps all motion inside prefers-reduced-motion: no-preference');
  } finally { server.close(); }

  /* ---------- the lab entry ---------- */
  const lab = require('../../../lab.js');
  const me = lab.get('asfiled');
  assert.ok(me && me.status === 'testing' && me.dropped === '2026-11-23' && me.features.length === 4);
  assert.strictEqual(lab.APPS[lab.APPS.length - 1].slug, 'asfiled');
  assert.strictEqual(lab.APPS.findIndex((a) => a.slug === 'asfiled'), lab.APPS.findIndex((a) => a.slug === 'punch') + 1);
  assert.strictEqual(lab.APPS.filter((a) => a.emoji === me.emoji).length, 1);
  ok('the lab entry is the drop after Punch, with an emoji no other card has');

  console.log(`\n${n} checks passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
