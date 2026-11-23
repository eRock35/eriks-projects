#!/usr/bin/env node
// Step 3: build the dataset the app ships (public/data/dataset.json) from
// the cache, and only from the cache.
//
//   figures   - each company's annual numbers from its XBRL company facts,
//               each with the tag, period end and accession number it came
//               from; revenue mix and customer concentration from the latest
//               annual report's XBRL instance
//   edges     - tools/curated-edges.json, passed through the verifier
//               (tools/verify.js): an edge whose quote is not in its source
//               word for word is DROPPED here and never reaches the app
//   insights  - sentences written by public/asfiled-core.js from the
//               figures; a sentence whose cited figure is missing is dropped
//
// Nothing here calls a model, and nothing here reaches the network.

const fs = require('fs');
const path = require('path');
const { FILERS, OTHERS, LAYERS, byId } = require('./companies');
const sec = require('./sec');
const T = require('./text');
const X = require('./xbrl');
const V = require('./verify');
const Core = require('../public/asfiled-core');

const OUT = path.join(__dirname, '..', 'public', 'data', 'dataset.json');
const REPORT = path.join(__dirname, 'build-report.json');
const YEARS = 12;                       // fiscal years kept per company
const ANNUAL = new Set(['10-K', '20-F']);

// Tags tried for each number, in order of preference when one filing
// reports two of them for the same period.
const TAGS = {
  revenue: ['us-gaap:Revenues', 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', 'us-gaap:SalesRevenueNet', 'ifrs-full:Revenue', 'ifrs-full:RevenueFromContractsWithCustomers'],
  cost: ['us-gaap:CostOfRevenue', 'us-gaap:CostOfGoodsAndServicesSold', 'us-gaap:CostOfGoodsSold', 'ifrs-full:CostOfSales'],
  gross: ['us-gaap:GrossProfit', 'ifrs-full:GrossProfit'],
  rd: ['us-gaap:ResearchAndDevelopmentExpense', 'us-gaap:ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost', 'ifrs-full:ResearchAndDevelopmentExpense'],
  capex: ['us-gaap:PaymentsToAcquirePropertyPlantAndEquipment', 'us-gaap:PaymentsToAcquireProductiveAssets', 'ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'],
  inventory: ['us-gaap:InventoryNet', 'ifrs-full:Inventories', 'ifrs-full:CurrentInventories'],
};
const INSTANT = new Set(['inventory']);
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** One number per fiscal year for a metric: the value from the EARLIEST
 *  annual report that reported that period (the year's own report, as first
 *  filed), so every figure links to the filing it was first published in. */
function annualSeries(facts, metric, unit, ends) {
  const byEnd = {};
  TAGS[metric].forEach((qname, rank) => {
    const [tax, tag] = qname.split(':');
    const f = facts.facts[tax] && facts.facts[tax][tag];
    const rows = f && f.units[unit];
    if (!rows) return;
    for (const r of rows) {
      if (!ANNUAL.has(r.form) || !r.end || !Number.isFinite(r.val)) continue;
      if (INSTANT.has(metric)) { if (r.start || (ends && !ends.has(r.end))) continue; } else {
        if (!r.start) continue;
        const d = days(r.start, r.end);
        if (d < 340 || d > 380) continue;
      }
      const cur = byEnd[r.end];
      const cand = { end: r.end, val: r.val, accn: r.accn, form: r.form, filed: r.filed, tag: qname, rank };
      // Earliest filing wins; within one filing, revenue takes the largest
      // revenue-tagged total and everything else the preferred tag.
      const better = !cur || cand.filed < cur.filed || (cand.filed === cur.filed && (metric === 'revenue' ? cand.val > cur.val : cand.rank < cur.rank));
      if (better) byEnd[r.end] = cand;
    }
  });
  return byEnd;
}

function subsetToTotal(parts, total) {
  // The largest set of parts that adds up to the reported total (within
  // 0.5%). Parts that overlap (a subtotal and its lines) cannot both be in.
  const n = parts.length;
  if (!n || n > 18 || !(total > 0)) return null;
  let best = null;
  for (let mask = 1; mask < (1 << n); mask += 1) {
    let sum = 0; let count = 0;
    for (let i = 0; i < n; i += 1) if (mask & (1 << i)) { sum += parts[i].val; count += 1; }
    if (count < 2 || Math.abs(sum - total) > total * 0.005) continue;
    if (!best || count > best.count) best = { mask, count };
  }
  if (!best) return null;
  return parts.filter((_, i) => best.mask & (1 << i));
}

// A label as the report gives it, less the "[Member]" suffix; a label in
// capitals throughout ("UNITED STATES") is set in ordinary case.
const SMALL = new Set(['of', 'and', 'the']);
const cleanLabel = (s) => String(s || '').replace(/\s*\[Member\]\s*$/i, '').replace(/\s+/g, ' ').trim()
  .replace(/\b[A-Z]{4,}\b|\b(OF|AND|THE)\b/g, (w) => (SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w[0] + w.slice(1).toLowerCase()));
// "Three largest customers", "Four customers": a group, not one customer.
const isGroup = (s) => /\b(two|three|four|five|six|ten|\d+)\s+(largest\s+)?(customers|distributors)\b|largest customers/i.test(s);

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(sec.CACHE, 'manifest.json'), 'utf8'));
  const data = {
    app: 'asfiled', schema: 1, built: new Date().toISOString().slice(0, 10),
    disclaimer: 'From public filings. Not investment advice.',
    layers: LAYERS, companies: [], others: [], filings: {}, sources: {}, figures: {}, mixes: {}, concentration: {}, edges: [], insights: {}, patterns: [],
  };
  const report = { built: data.built, companies: 0, figures: 0, edges: { curated: 0, kept: 0, dropped: [] }, insights: { kept: 0, dropped: 0 }, notes: [] };
  const texts = {};          // source id -> normalised text (for the verifier)

  for (const c of FILERS) {
    const man = manifest[c.id];
    const a = man.annual[0];
    const facts = JSON.parse(fs.readFileSync(path.join(sec.CACHE, 'facts', `${c.id}.json`), 'utf8'));
    const currency = c.id === 'TSM' ? 'TWD' : c.id === 'ASML' ? 'EUR' : 'USD';
    // The latest annual report's own XBRL instance. Company facts can lag a
    // new filing (TSMC's latest 20-F is not in it yet): a number missing
    // for the latest period is then read from the report's instance itself.
    const dir = path.join(sec.CACHE, 'docs', c.id, a.accn);
    const inst = a.instance ? X.readInstance(path.join(dir, a.instance)) : { facts: [] };
    const series = (metric, unit, ends) => {
      const s = annualSeries(facts, metric, unit, ends);
      if (s[a.period]) return s;
      let best = null;
      TAGS[metric].forEach((qname, rank) => {
        for (const f of inst.facts) {
          if (f.tag !== qname || f.unit !== unit || f.ctx.dims.length || f.ctx.typed || f.ctx.end !== a.period) continue;
          if (INSTANT.has(metric) ? Boolean(f.ctx.start) : (!f.ctx.start || days(f.ctx.start, f.ctx.end) < 340 || days(f.ctx.start, f.ctx.end) > 380)) continue;
          const cand = { end: a.period, val: f.val, accn: a.accn, form: a.form, filed: a.filed, tag: qname, rank, x: 1 };
          if (!best || (metric === 'revenue' ? cand.val > best.val : cand.rank < best.rank)) best = cand;
        }
      });
      if (best) s[a.period] = best;
      return s;
    };
    const rev = series('revenue', currency);
    const ends = Object.keys(rev).sort().slice(-YEARS);
    const endSet = new Set(ends);
    const fyOf = (end) => Number(end.slice(0, 4));
    const put = (metric, row, unit) => {
      const id = `${c.id}.${metric}.${fyOf(row.end)}`;
      data.figures[id] = { c: c.id, m: metric, fy: fyOf(row.end), end: row.end, v: row.val, u: unit, tag: row.tag, a: row.accn };
      if (row.x) data.figures[id].x = 1;
      data.filings[row.accn] = { c: c.id, form: row.form, filed: row.filed };
    };
    for (const metric of Object.keys(TAGS)) {
      const s = metric === 'revenue' ? rev : series(metric, currency, endSet);
      for (const end of ends) if (s[end]) put(metric, s[end], currency);
    }
    if (currency !== 'USD') {
      // TSMC also tags its own US-dollar convenience translation of the
      // latest year in each report. Kept as separate figures, so anything
      // summed across companies in dollars uses the company's own number.
      for (const metric of ['revenue', 'capex']) {
        const s = series(metric, 'USD', endSet);
        for (const end of ends) if (s[end]) put(`${metric}Usd`, s[end], 'USD');
      }
    }

    // The latest annual report: its text, its XBRL instance, its labels.
    const docId = `${c.id}-${a.accn}`;
    data.filings[a.accn] = { c: c.id, form: a.form, filed: a.filed };
    const text = T.sourceText(docId);
    if (!text) throw new Error(`${docId}: no cached text. Run tools/extract.js first.`);
    texts[docId] = T.norm(text);
    data.sources[docId] = { kind: 'annual-report', by: c.id, form: a.form, period: a.period, date: a.filed, accn: a.accn, title: `${c.name} ${a.form} for the fiscal year ended ${a.period}`, url: sec.docUrl(c.cik, a.accn, a.doc), sha: T.sha(texts[docId]) };
    const labText = T.sourceText(`${docId}.labels`);
    if (labText) {
      texts[`${docId}.labels`] = T.norm(labText);
      data.sources[`${docId}.labels`] = { kind: 'xbrl', by: c.id, form: a.form, period: a.period, date: a.filed, accn: a.accn, title: `${c.name} ${a.form} for the fiscal year ended ${a.period} - XBRL data labels`, url: sec.filingIndexUrl(c.cik, a.accn), sha: T.sha(texts[`${docId}.labels`]) };
    }

    const labels = a.labels ? X.readLabels(path.join(dir, a.labels)) : {};
    const label = (q) => cleanLabel((labels[q] || {}).terse || (labels[q] || {}).std || q.replace(/^.*:/, '').replace(/Member$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'));
    const rawLabel = (q) => ((labels[q] || {}).std || (labels[q] || {}).terse || '');
    const fyEnds = ends.slice(-3);

    // Revenue mix, where the report tags revenue by segment, geography or product.
    const KIND = [
      ['segment', /(^|:)StatementBusinessSegmentsAxis$/, 'By segment'],
      ['geography', /(^|:)(StatementGeographicalAxis|GeographicalAreasAxis)$/, 'By geography'],
      ['product', /(^|:)(ProductOrServiceAxis|MarketsOfCustomersAxis)$/, 'By product or market'],
    ];
    const REV = /^(us-gaap:(Revenues|RevenueFromContractWithCustomerExcludingAssessedTax|SalesRevenueNet)|ifrs-full:(Revenue|RevenueFromContractsWithCustomers))$/;
    const PASS = /(ConsolidationItemsAxis|ConcentrationRiskByBenchmarkAxis|ConcentrationRiskByTypeAxis)$/;     // axes that do not split the number further
    data.mixes[c.id] = [];
    for (const [kind, axisRe, title] of KIND) {
      const per = {};      // member -> {end: val}
      for (const f of inst.facts) {
        if (!REV.test(f.tag) || f.unit !== currency || f.ctx.typed || !f.ctx.start || !fyEnds.includes(f.ctx.end)) continue;
        const d = days(f.ctx.start, f.ctx.end);
        if (d < 340 || d > 380) continue;
        const main = f.ctx.dims.filter((x) => axisRe.test(x[0]));
        const rest = f.ctx.dims.filter((x) => !axisRe.test(x[0]));
        if (main.length !== 1 || rest.some((x) => !PASS.test(x[0]))) continue;
        if (rest.some((x) => /ConsolidationItemsAxis$/.test(x[0]) && !/operating segments|total segments/i.test(rawLabel(x[1]) || x[1]))) continue;
        const key = main[0][1];
        (per[key] = per[key] || {})[f.ctx.end] = f.val;
      }
      const latest = fyEnds[fyEnds.length - 1];
      const total = rev[latest] && rev[latest].val;
      const parts = Object.keys(per).filter((k) => per[k][latest] > 0).map((k) => ({ key: k, val: per[k][latest] }));
      const chosen = subsetToTotal(parts, total);
      if (!chosen) continue;
      chosen.sort((p, q) => q.val - p.val);
      const mix = { kind, title, accn: a.accn, years: fyEnds.map(fyOf), parts: [] };
      chosen.forEach((p, i) => {
        const vals = fyEnds.map((e) => (Number.isFinite(per[p.key][e]) ? per[p.key][e] : null));
        mix.parts.push({ label: label(p.key), vals });
        fyEnds.forEach((e, j) => {
          if (vals[j] === null) return;
          data.figures[`${c.id}.mix.${kind}.${fyOf(e)}.${i}`] = { c: c.id, m: `mix.${kind}`, fy: fyOf(e), end: e, v: vals[j], u: currency, tag: `revenue by ${kind}: ${label(p.key)}`, a: a.accn, x: 1 };
        });
      });
      data.mixes[c.id].push(mix);
    }

    // Customer concentration, where the report tags a customer's share.
    const conc = [];
    for (const f of inst.facts) {
      if (!/ConcentrationRiskPercentage/.test(f.tag) || !fyEnds.includes(f.ctx.end)) continue;
      const dims = Object.fromEntries(f.ctx.dims.map((x) => [x[0].replace(/^.*:/, ''), x[1]]));
      if (!dims.MajorCustomersAxis || !dims.ConcentrationRiskByBenchmarkAxis) continue;
      const bench = rawLabel(dims.ConcentrationRiskByBenchmarkAxis) || dims.ConcentrationRiskByBenchmarkAxis;
      if (!/revenue|sales/i.test(bench) || /receivable/i.test(bench)) continue;
      const type = rawLabel(dims.ConcentrationRiskByTypeAxis || '') || String(dims.ConcentrationRiskByTypeAxis || '');
      if (!/customer/i.test(type)) continue;
      const extra = Object.keys(dims).filter((k) => !['MajorCustomersAxis', 'ConcentrationRiskByBenchmarkAxis', 'ConcentrationRiskByTypeAxis'].includes(k));
      if (extra.some((k) => k !== 'StatementBusinessSegmentsAxis')) continue;
      conc.push({ label: label(dims.MajorCustomersAxis), raw: rawLabel(dims.MajorCustomersAxis), within: extra.length ? label(dims[extra[0]]) : null, fy: fyOf(f.ctx.end), end: f.ctx.end, pct: f.val, group: isGroup(label(dims.MajorCustomersAxis)) });
    }
    if (c.id === 'TSM') {
      // TSMC tags the revenue from each major customer as an amount.
      for (const f of inst.facts) {
        if (!REV.test(f.tag) || f.unit !== currency || !fyEnds.includes(f.ctx.end) || f.ctx.dims.length !== 1 || !/MajorCustomersAxis$/.test(f.ctx.dims[0][0])) continue;
        const total = rev[f.ctx.end] && rev[f.ctx.end].val;
        if (total) conc.push({ label: label(f.ctx.dims[0][1]), raw: rawLabel(f.ctx.dims[0][1]), within: null, fy: fyOf(f.ctx.end), end: f.ctx.end, pct: Math.round((f.val / total) * 1000) / 1000, derived: true, amount: f.val });
      }
    }
    const seen = new Set();
    data.concentration[c.id] = conc.filter((x) => { const k = `${x.label}|${x.within}|${x.fy}`; if (seen.has(k) || !(x.pct > 0 && x.pct <= 1)) return false; seen.add(k); return true; })
      .sort((p, q) => q.fy - p.fy || Number(Boolean(p.group)) - Number(Boolean(q.group)) || q.pct - p.pct);
    data.concentration[c.id].forEach((x, i) => {
      x.id = `${c.id}.conc.${x.fy}.${i}`;
      data.figures[x.id] = { c: c.id, m: 'conc', fy: x.fy, end: x.end, v: x.pct, u: 'share', tag: `customer concentration: ${x.label}${x.derived ? ' (tagged amount ÷ revenue)' : ''}`, a: a.accn, x: 1 };
    });

    const fys = ends.map(fyOf);
    data.companies.push({ id: c.id, name: c.name, legal: c.legal, layer: c.layer, filer: true, cik: c.cik, form: c.form, currency, years: fys, latest: fys[fys.length - 1], annual: { accn: a.accn, period: a.period, filed: a.filed, source: docId } });
    report.companies += 1;
  }

  // Apple's own Supplier List.
  const list = manifest['APPLE-SUPPLIER-LIST'];
  const listText = T.sourceText('APPLE-SUPPLIER-LIST');
  if (list && listText) {
    texts['APPLE-SUPPLIER-LIST'] = T.norm(listText);
    data.sources['APPLE-SUPPLIER-LIST'] = { kind: 'supplier-list', by: 'AAPL', form: 'Supplier List', period: list.period, date: list.date, title: `Apple Supplier List (${list.period})`, url: list.url, sha: T.sha(texts['APPLE-SUPPLIER-LIST']) };
  } else report.notes.push('Apple Supplier List not in the cache: its edges will be dropped.');

  // Edges: curated, then verified. What fails is dropped and reported.
  const curated = JSON.parse(fs.readFileSync(path.join(__dirname, 'curated-edges.json'), 'utf8'));
  const sectionsOf = {};
  const rawTexts = {};
  for (const id of Object.keys(data.sources)) rawTexts[id] = T.sourceText(id);
  const expanded = V.expand(curated, data.companies);
  report.edges.curated = expanded.length;
  const usedOthers = new Set();
  for (const e of expanded) {
    const res = V.checkEdge(e, { sources: data.sources, texts, rawTexts, sectionsOf, concentration: data.concentration, byId });
    if (!res.ok) { report.edges.dropped.push({ by: e.by, from: e.from, to: e.to, type: e.type, why: res.why, tripwire: Boolean(e.tripwire) }); continue; }
    const src = data.sources[e.source];
    const edge = { id: `e${data.edges.length + 1}`, from: e.from, to: e.to, type: e.type, by: e.by, source: e.source, section: res.section, date: src.date, quote: T.norm(e.quote), gloss: e.gloss, url: src.url, proof: V.proof(src.sha, e.quote) };
    if (e.lead) { edge.lead = T.norm(e.lead); edge.leadProof = V.proof(src.sha, e.lead); }
    if (res.fig) edge.fig = res.fig;
    data.edges.push(edge);
    for (const id of [e.from, e.to]) if (!byId[id].cik) usedOthers.add(id);
  }
  report.edges.kept = data.edges.length;
  // A company outside the set is on the map only because an edge names it.
  data.others = OTHERS.filter((o) => usedOthers.has(o.id)).map((o) => ({ id: o.id, name: o.name, layer: o.layer, filer: false }));

  // Insights and cross-company patterns: written from the figures by the
  // shared core, each sentence with the figures or edges it rests on.
  const written = Core.writeAll(data);
  const keep = (s) => { const ok = s.cites.length > 0 && s.cites.every((id) => data.figures[id] || data.edges.some((e) => e.id === id)); if (ok) report.insights.kept += 1; else report.insights.dropped += 1; return ok; };
  for (const id of Object.keys(written.insights)) data.insights[id] = written.insights[id].filter(keep);
  data.patterns = written.patterns.map((p) => ({ ...p, sentences: p.sentences.filter(keep) }));

  report.figures = Object.keys(data.figures).length;
  data.integrity = Core.integrity(data, (s) => T.sha(s));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data));
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`${report.companies} companies, ${report.figures} figures, ${Object.keys(data.filings).length} filings cited`);
  console.log(`edges: ${report.edges.kept} kept of ${report.edges.curated} curated; ${report.edges.dropped.length} dropped`);
  for (const d of report.edges.dropped) console.log(`  dropped ${d.from} -> ${d.to} (${d.type}, said by ${d.by}): ${d.why}${d.tripwire ? ' [the tripwire: expected]' : ''}`);
  console.log(`insight sentences: ${report.insights.kept} kept, ${report.insights.dropped} dropped`);
  console.log(`${(fs.statSync(OUT).size / 1024).toFixed(0)} KB -> ${path.relative(process.cwd(), OUT)}`);
}

main();
