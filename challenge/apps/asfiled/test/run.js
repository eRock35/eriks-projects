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
const Dataset = require('../tools/dataset');
const data = Dataset.load();
const DATA = path.join(ROOT, 'public', 'data');
const readPart = (rel) => JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const INDEX_MAX = 450 * 1024;          // the phone's first data load (about a sixth of that over the wire, gzipped)
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
  assert.strictEqual(data.companies.length, 81);
  assert.deepStrictEqual(data.companies.map((c) => c.id).sort(), FILERS.map((c) => c.id).sort());
  // The original nineteen are all still here.
  for (const id of ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'DELL', 'HPQ', 'CSCO', 'NVDA', 'AMD', 'INTC', 'QCOM', 'AVGO', 'MU', 'TXN', 'TSM', 'AMAT', 'LRCX', 'ASML']) assert.ok(data.companies.some((c) => c.id === id), id);
  const ACCN = /^\d{10}-\d{2}-\d{6}$/;
  const FILING_URL = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/\d{10}-\d{2}-\d{6}-index\.htm$/;
  for (const [id, f] of Object.entries(data.figures)) {
    assert.ok(ACCN.test(f.a), `${id}: accession number`);
    const filing = data.filings[f.a];
    assert.ok(filing && /^(10-K|20-F)$/.test(filing.form) && /^\d{4}-\d\d-\d\d$/.test(filing.filed), `${id}: filing`);
    assert.strictEqual(filing.c, f.c, `${id}: the filing is that company's own`);
    assert.ok(Number.isFinite(f.v) && /^\d{4}-\d\d-\d\d$/.test(f.end) && f.fy === Core.fiscalYear(f.end) && f.tag, `${id}: value, period, tag`);
    const src = Core.figureSource(data, id);
    assert.ok(FILING_URL.test(src.url), `${id}: link ${src.url}`);
    const prior = (byId[f.c].priorCiks || []).map((p) => p.cik);
    if (filing.cik) assert.ok(prior.includes(filing.cik), `${id}: filed under CIK ${filing.cik}, not listed as ${f.c}'s prior registrant`);
    assert.ok(src.url.includes(`/${filing.cik || byId[f.c].cik}/`), `${id}: link is under the CIK it was filed under`);
  }
  ok(`all ${Object.keys(data.figures).length} figures carry a form, a fiscal period, an accession number and a sec.gov filing link under the CIK the filing was made under (the company's own, or a prior registrant companies.js names)`);
  for (const c of data.companies) {
    assert.ok(Core.fig(data, c.id, 'revenue', c.latest), `${c.id}: latest revenue`);
    // Twelve fiscal years where company facts holds them; a recent listing
    // or spin-off shows every year its registrant has filed.
    assert.ok(c.years.length === Math.min(12, c.periods) && (c.years.length >= 10 || c.periods < 10), `${c.id}: ${c.years.length} fiscal years of ${c.periods}`);
    assert.strictEqual(new Set(c.years).size, c.years.length, `${c.id}: one figure per fiscal year`);
  }
  assert.ok(data.companies.filter((c) => c.years.length >= 10).length >= 72);
  assert.strictEqual(Core.fiscalYear('2016-01-02'), 2015); assert.strictEqual(Core.fiscalYear('2026-01-25'), 2026);
  ok(`every company has a latest revenue figure and twelve fiscal years, or every year its registrant has (${data.companies.filter((c) => c.years.length < 10).map((c) => `${c.id} ${c.years.length}`).join(', ')})`);

  /* ---------- the dataset: edges ---------- */
  const SOURCE_URL = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/[A-Za-z0-9._-]+\.htm$/;
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
    assert.ok(/^https:\/\/www\.sec\.gov\//.test(Core.quoteUrl(e)));
  }
  ok(`all ${data.edges.length} edges have a speaker, the speaker's own source, a section, a date, a working-format link, and a verbatim quote that names the other company`);
  assert.ok(!data.edges.some((e) => e.from === 'NVDA' && e.to === 'MSFT' && e.by === 'MSFT'), 'the tripwire reached the dataset');
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'build-report.json'), 'utf8'));
  assert.ok(report.edges.dropped.some((d) => d.tripwire && /not found verbatim/.test(d.why)));
  assert.strictEqual(report.edges.kept, data.edges.length);
  ok('the tripwire (a plausible, unstated NVIDIA -> Microsoft link kept in the curated file) was dropped by the verifier and is not in the dataset');
  const named = new Set(data.edges.flatMap((e) => [e.from, e.to]));
  for (const o of data.others) { assert.ok(named.has(o.id), `${o.id} is on the map with no edge`); assert.ok(OTHERS.some((x) => x.id === o.id)); }
  ok('a company outside the set appears only because an edge names it');

  /* ---------- Apple's Supplier List is not a source (dropped 2026-11-23) ---------- */
  {
    const curated = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'curated-edges.json'), 'utf8'));
    assert.ok(!curated.some((e) => e.doc), 'a curated edge names a document other than the speaker\'s annual report');
    assert.ok(!Object.keys(data.sources).some((k) => /APPLE-SUPPLIER-LIST/.test(k)));
    assert.ok(Object.values(data.sources).every((s) => s.kind === 'annual-report' || s.kind === 'xbrl'), 'a source that is not an annual report or its XBRL labels');
    assert.ok(!fs.existsSync(path.join(ROOT, 'tools', 'pdftext.js')));
    for (const f of ['tools/build.js', 'tools/fetch.js', 'tools/extract.js', 'tools/verify.js', 'public/app.js', 'public/asfiled-core.js', 'public/index.html']) {
      const body = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.ok(!/apple\.com|Supplier List|supplier-list|APPLE-SUPPLIER/i.test(body), `${f} still mentions Apple's Supplier List`);
    }
    // Who sells to Apple: only what the seller's own filing says (Qualcomm, NXP, Skyworks).
    const toApple = data.edges.filter((e) => e.to === 'AAPL' && (e.type === 'supplier' || e.type === 'customer'));
    assert.ok(toApple.every((e) => e.by === e.from), 'a supply edge into Apple said by Apple (its 10-K names no supplier)');
    assert.ok(['QCOM', 'NXPI', 'SWKS'].every((id) => toApple.some((e) => e.from === id)), 'the edges into Apple stated in the suppliers\' own filings stay');
    assert.ok(!data.edges.some((e) => e.from === 'FOXCONN' && e.to === 'AAPL'), 'Foxconn -> Apple rested only on the list');
  }
  ok('Apple\'s Supplier List is gone as a source: no edge rests on it, no tool fetches or reads it, no copy mentions it; supplier -> Apple edges stated in the suppliers\' own filings stay');

  /* ---------- no "investor" relationship type (dropped 2026-11-23) ---------- */
  {
    assert.ok(!V.TYPES.includes('investor') && !Core.TYPE_NAMES.investor && !Core.DIRECTED.investor);
    assert.ok(!data.edges.some((e) => e.type === 'investor'));
    const curated = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'curated-edges.json'), 'utf8'));
    assert.ok(!curated.some((e) => e.type === 'investor'));
    const appjs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.ok(!/investor|invested/i.test(appjs), 'app.js still has the investor type (filter, legend or copy)');
    assert.ok(!V.checkEdge({ by: 'NVDA', from: 'NVDA', to: 'INTC', type: 'investor', quote: 'x', source: 'none' }, { sources: {}, texts: {}, byId }).ok);
  }
  ok('the investor line type is gone: no type, no edge, no curated entry, no filter, legend or copy, and the verifier refuses it');

  /* ---------- auditors: a service link, verified, off by default ---------- */
  {
    const FIRMS = ['DELOITTE', 'PWC', 'EY', 'KPMG', 'BDO'];
    const aud = data.edges.filter((e) => e.type === 'auditor');
    for (const c of data.companies) {
      const mine = aud.filter((e) => e.to === c.id);
      assert.strictEqual(mine.length, 1, `${c.id}: one auditor edge`);
      const e = mine[0];
      assert.ok(FIRMS.includes(e.from) && !byId[e.from].cik, `${c.id}: the auditor is an audit firm outside the set`);
      assert.ok(e.by === c.id && e.source === c.annual.source, `${c.id}: named in its own latest annual report`);
      assert.ok(V.names(byId[e.from], e.quote), `${c.id}: the quote names the firm`);
      assert.ok(/auditor|independent registered public accounting firm|\/s\//i.test(e.quote + ' ' + (e.lead || '')), `${c.id}: the quote is the auditor's own report or names the firm as the auditor`);
      assert.ok(data.others.some((o) => o.id === e.from && o.filer === false), `${e.from}: shown as another company`);
    }
    assert.strictEqual(aud.length, data.companies.length);
    assert.ok(report.edges.dropped.every((d) => d.type !== 'auditor'), 'an auditor edge failed the verifier');
    assert.ok(Core.DIRECTED.auditor && Core.TYPE_NAMES.auditor === 'Auditor');
    const appjs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const types = /var mapState = \{ types: (\{[^}]*\})/.exec(appjs);
    const defaults = JSON.parse(types[1].replace(/(\w+):/g, '"$1":'));
    assert.deepStrictEqual(Object.keys(defaults).sort(), Object.keys(Core.TYPE_NAMES).sort(), 'every type has a filter chip default');
    assert.strictEqual(defaults.auditor, false, 'auditors start off on the map');
    assert.strictEqual(defaults.competitor, false);
    assert.ok(['supplier', 'customer', 'service', 'partner'].every((t) => defaults[t] === true));
    // The default map is the one it was before the auditors: what it draws
    // under the default filters holds no auditor line and no audit firm.
    const onByDefault = data.edges.filter((e) => defaults[e.type]);
    assert.ok(!onByDefault.some((e) => FIRMS.includes(e.from) && e.type === 'auditor'));
  }
  ok(`auditors: all ${data.companies.length} companies have one verified "Auditor" edge from the audit firm their own annual report names (${['DELOITTE', 'PWC', 'EY', 'KPMG', 'BDO'].map((f) => `${f} ${data.edges.filter((e) => e.type === 'auditor' && e.from === f).length}`).join(', ')}), and the Auditor chip starts off like Competitors`);

  /* ---------- a company's history across two registrants (priorCiks) ---------- */
  {
    const withPrior = FILERS.filter((c) => c.priorCiks);
    assert.deepStrictEqual(withPrior.map((c) => c.id), ['MRVL']);
    assert.deepStrictEqual(byId.MRVL.priorCiks.map((p) => p.cik), [1058057]);
    const m = data.companies.find((c) => c.id === 'MRVL');
    assert.ok(m.years.length >= 10 && m.years.length === Math.min(12, m.periods), `MRVL: ${m.years.length} years`);
    assert.deepStrictEqual(m.prior, [{ cik: 1058057, legal: 'Marvell Technology Group Ltd.' }]);
    const revs = m.years.map((fy) => Core.fig(data, 'MRVL', 'revenue', fy));
    assert.ok(revs.every(Boolean));
    const old = revs.filter((f) => data.filings[f.a].cik === 1058057);
    const cur = revs.filter((f) => !data.filings[f.a].cik);
    assert.ok(old.length >= 5 && cur.length >= 4, `${old.length} years from the old registrant, ${cur.length} from the new`);
    assert.ok(Math.max(...old.map((f) => f.fy)) < Math.min(...cur.map((f) => f.fy)), 'the old registrant\'s years come first');
    for (const f of old) {
      const fid = `MRVL.revenue.${f.fy}`;
      const s = Core.figureSource(data, fid);
      assert.ok(s.url.includes('/edgar/data/1058057/') && s.prior && s.prior.cik === 1058057, `${fid}: links to the old registrant's filing`);
    }
    for (const f of cur) assert.ok(Core.figureSource(data, `MRVL.revenue.${f.fy}`).url.includes('/edgar/data/1835632/'));
    assert.ok(Object.values(data.filings).every((x) => !x.cik || x.c === 'MRVL'), 'only a company with priorCiks has a filing under another CIK');
    // The join itself, on made-up company facts: the earliest annual report
    // that reported a period wins, whichever registrant filed it, and the
    // winner remembers its CIK.
    const { annualSeries } = require('../tools/build');
    const row = (end, val, accn, filed) => ({ start: `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`, end, val, accn, form: '10-K', filed });
    const factsOf = (rows) => ({ facts: { 'us-gaap': { Revenues: { units: { USD: rows } } } } });
    const s = annualSeries([
      { cik: 2, facts: factsOf([row('2021-01-30', 30, '0000000002-22-000001', '2022-03-10'), row('2022-01-29', 40, '0000000002-22-000001', '2022-03-10')]) },
      { cik: 1, facts: factsOf([row('2020-02-01', 20, '0000000001-20-000001', '2020-03-10'), row('2021-01-30', 31, '0000000001-21-000001', '2021-03-10')]) },
    ], 'revenue', 'USD');
    assert.deepStrictEqual(Object.keys(s).sort(), ['2020-02-01', '2021-01-30', '2022-01-29']);
    assert.deepStrictEqual([s['2020-02-01'].cik, s['2021-01-30'].cik, s['2021-01-30'].val, s['2022-01-29'].cik], [1, 1, 31, 2]);
  }
  ok('Marvell\'s history is joined across its two registrants (CIK 1058057 before the 2021 re-domicile, 1835632 after) by companies.js priorCiks: ten years or more, each figure linking to the filing it came from under the CIK it was filed under, the earliest-report rule unchanged');

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
    // An auditor edge is checked like every other: the firm must be named in the quote, word for word.
    const at = 'Item 8. Financial Statements\n/s/ Ernst & Young LLP\nWe have served as the Company’s auditor since 2009.';
    const actx = { ...ctx, sources: { A: { by: 'NVDA', kind: 'annual-report', form: '10-K', sha: sha(T.norm(at)) } }, texts: { A: T.norm(at) }, rawTexts: { A: at } };
    const ae = (o) => ({ by: 'NVDA', from: 'EY', to: 'NVDA', type: 'auditor', source: 'A', quote: '/s/ Ernst & Young LLP We have served as the Company’s auditor since 2009.', ...o });
    assert.ok(V.checkEdge(ae({}), actx).ok);
    assert.ok(!V.checkEdge(ae({ from: 'KPMG' }), actx).ok);
    assert.ok(!V.checkEdge(ae({ quote: 'We have served as the Company’s auditor since 2009.' }), actx).ok);
    assert.ok(!V.checkEdge(ae({ quote: '/s/ Ernst & Young LLP We have served as the Company’s auditor since 2008.' }), actx).ok);
    ok('verifier: an auditor edge needs the firm named in a verbatim quote, like every edge');
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
  assert.ok(Math.max(...data.edges.map((e) => e.quote.length)) <= 620);
  assert.deepStrictEqual(fs.readdirSync(DATA).sort(), ['c', 'index.json', 'patterns.json']);
  assert.deepStrictEqual(fs.readdirSync(path.join(DATA, 'c')).sort(), data.companies.map((c) => `${c.id}.json`).sort());
  ok('only the derived dataset is committed: an index, the patterns and one file per company; no filing text beyond short quotes');

  /* ---------- the split: a small index, the rest on demand ---------- */
  const index = readPart('index.json');
  const sizeOf = (rel) => fs.statSync(path.join(DATA, rel)).size;
  const biggest = Math.max(...data.companies.map((c) => sizeOf(`c/${c.id}.json`)));
  assert.ok(sizeOf('index.json') < INDEX_MAX, `index.json is ${sizeOf('index.json')} bytes`);
  assert.ok(sizeOf('patterns.json') < 600 * 1024, 'patterns.json');
  assert.ok(biggest < 64 * 1024, `largest company file ${biggest} bytes`);
  ok(`the first load is small: index.json ${(sizeOf('index.json') / 1024).toFixed(0)} KB; patterns.json ${(sizeOf('patterns.json') / 1024).toFixed(0)} KB and company files up to ${(biggest / 1024).toFixed(0)} KB load only when opened`);
  const fresh2 = Core.split(data);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(fresh2.index)), index);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(fresh2.patterns)), readPart('patterns.json'));
  for (const c of data.companies) assert.deepStrictEqual(JSON.parse(JSON.stringify(fresh2.companies[c.id])), readPart(`c/${c.id}.json`), c.id);
  ok('splitting the merged dataset again gives the committed files byte for byte in content: nothing is lost or added between the parts');
  for (const c of index.companies) {
    for (const fid of Core.headIds(c)) if (data.figures[fid]) assert.deepStrictEqual(index.figures[fid], data.figures[fid], `${fid} in the index`);
    assert.deepStrictEqual(c.spark, c.years.map((fy) => { const f = Core.fig(data, c.id, 'revenue', fy); return f ? f.v : null; }), `${c.id}: spark is its revenue figures`);
    const part = readPart(`c/${c.id}.json`);
    assert.ok(Object.values(part.figures).every((f) => f.c === c.id), `${c.id}: only its own figures`);
    assert.strictEqual(Object.keys(part.figures).length, Object.values(data.figures).filter((f) => f.c === c.id).length, `${c.id}: all its figures`);
    for (const f of Object.values(part.figures)) assert.ok(part.filings[f.a], `${c.id}: the filing of every figure`);
  }
  for (const e of index.edges) if (e.fig) assert.ok(index.figures[e.fig], `${e.id}: its tagged figure is in the index`);
  const edgeFigs = new Set(index.edges.map((e) => e.fig).filter(Boolean));
  assert.ok(!Object.keys(index.figures).some((k) => /\.(rd|capex|inventory|mix|conc)\./.test(k) && !edgeFigs.has(k)), 'the index carries only headline figures and those an edge cites');
  assert.deepStrictEqual([index.counts.figures, index.counts.sources, index.counts.filings], [Object.keys(data.figures).length, Object.keys(data.sources).length, Object.keys(data.filings).length]);
  ok('the index holds every company with its headline figures and sparkline, every edge and source; each company file holds exactly that company\'s figures and their filings');
  // The loader: the page merges parts in whatever order they arrive.
  {
    const parts = [readPart('patterns.json')].concat(data.companies.map((c) => readPart(`c/${c.id}.json`)));
    const rev = Core.start(index); parts.slice().reverse().forEach((p) => Core.merge(rev, p));
    const fwd = Core.start(index); parts.forEach((p) => Core.merge(fwd, p));
    assert.strictEqual(Core.integrity(rev, sha), index.integrity);
    assert.strictEqual(Core.integrity(fwd, sha), index.integrity);
    const only = Core.merge(Core.start(index), readPart('c/NVDA.json'));
    assert.ok(Core.fig(only, 'NVDA', 'rd', only.companies.find((c) => c.id === 'NVDA').latest) && !Core.fig(only, 'AMD', 'rd', 2024) && only.patterns === null);
    assert.ok(Core.companyInsights(only, only.companies.find((c) => c.id === 'NVDA')).length >= 4, 'a company page has what it needs from the index and its own file');
    for (const good of ['index', 'patterns', 'c/NVDA', 'c/P', 'c/GOOGL']) assert.strictEqual(Core.partPath(good), `data/${good}.json`);
    for (const bad of ['dataset', 'c/nvda', '../index', 'c/NVDA/../x', 'c/ABCDEFG', 'index.json', '', 'https://x.example.com/index']) assert.throws(() => Core.partPath(bad), bad);
    const twice = Core.merge(Core.merge(Core.start(index), readPart('c/AAPL.json')), readPart('c/AAPL.json'));
    assert.deepStrictEqual(twice.insights.AAPL, data.insights.AAPL);
  }
  ok('the loader: parts merge in any order to the same integrity hash, a company page works from the index plus its own file, and only data/index.json, patterns.json or c/<TICKER>.json can be requested');

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
    assert.deepStrictEqual(fetches, ['fetch(BASE + Core.partPath(part)']);
    assert.ok(!/XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(js));
    ok('the page script builds with textContent only, writes no style, and requests only its own data parts');
    for (const f of ['app.js', 'app.css', 'asfiled-core.js', 'verify-banner.js', 'icon.svg', 'manifest.webmanifest', 'data/index.json', 'data/patterns.json', 'data/c/NVDA.json', 'data/c/P.json']) assert.strictEqual((await fetch(`${base}/asfiled/${f}`)).status, 200, f);
    assert.strictEqual((await fetch(`${base}/asfiled/data/dataset.json`)).headers.get('content-type').startsWith('text/html'), true, 'the old single file is gone');
    {
      const http = require('http');
      const raw = await new Promise((res, rej) => http.get(`${base}/asfiled/data/index.json`, { headers: { 'Accept-Encoding': 'gzip' } }, (r) => { const b = []; r.on('data', (x) => b.push(x)); r.on('end', () => res({ r, body: Buffer.concat(b) })); }).on('error', rej));
      assert.strictEqual(raw.r.headers['content-encoding'], 'gzip');
      assert.ok(raw.body.length < 110 * 1024, `index.json is ${raw.body.length} bytes over the wire`);
      assert.deepStrictEqual(JSON.parse(require('zlib').gunzipSync(raw.body)), index);
      ok(`the data files are sent gzipped: index.json is ${(raw.body.length / 1024).toFixed(0)} KB over the wire`);
    }
    r = await fetch(`${base}/asfiled/api/meta`);
    const meta = await r.json();
    assert.deepStrictEqual([meta.companies, meta.edges, meta.figures, meta.integrity], [81, data.edges.length, Object.keys(data.figures).length, data.integrity]);
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
