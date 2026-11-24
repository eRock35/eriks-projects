#!/usr/bin/env node
// Step 1: download the raw public sources into the cache (outside the repo).
//
//   - XBRL company facts for each company (data.sec.gov)
//   - each company's submissions index, to find its latest annual report
//   - that annual report's main document and its XBRL instance
//   - a previous registrant's company facts, where companies.js names one
//     (`priorCiks`)
//
// Nothing is written inside the repo. Run with SEC_USER_AGENT set.
//
// FILINGS_ONLY=KLAC,TER,... fetches just those companies (batches); the
// manifest keeps every other company's entry. The cache is kept small:
// company facts are cut down to the tags the build reads (xbrl.slimFacts),
// and a report's main document is not fetched again once its text has been
// extracted (tools/extract.js deletes the raw document after reading it).

const fs = require('fs');
const path = require('path');
const { FILERS } = require('./companies');
const { slimFacts, SLIM } = require('./xbrl');
const sec = require('./sec');

const ANNUALS = Number(process.env.FILINGS_ANNUALS || 1);   // how many annual reports' text to read

/** Company facts into the cache, cut down (xbrl.slimFacts). A copy cut by
 *  an older version of the tag list is read again. */
async function slim(url, rel) {
  const file = path.join(sec.CACHE, rel);
  if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).slim !== SLIM) fs.unlinkSync(file);
  await sec.cached(url, rel);
  const facts = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (facts.slim !== SLIM) fs.writeFileSync(file, JSON.stringify(slimFacts(facts)));
  return file;
}

async function main() {
  sec.agent();
  const manFile = path.join(sec.CACHE, 'manifest.json');
  const manifest = fs.existsSync(manFile) ? JSON.parse(fs.readFileSync(manFile, 'utf8')) : {};
  const only = process.env.FILINGS_ONLY ? new Set(process.env.FILINGS_ONLY.split(',').map((x) => x.trim())) : null;
  for (const c of FILERS) {
    if (only && !only.has(c.id)) continue;
    const cik10 = sec.pad10(c.cik);
    const factsFile = await slim(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`, `facts/${c.id}.json`);
    // A previous registrant's company facts (companies.js `priorCiks`).
    for (const p of c.priorCiks || []) {
      await slim(`https://data.sec.gov/api/xbrl/companyfacts/CIK${sec.pad10(p.cik)}.json`, `facts/${c.id}.${p.cik}.json`);
    }
    const subsFile = await sec.cached(`https://data.sec.gov/submissions/CIK${cik10}.json`, `subs/${c.id}.json`);
    const subs = JSON.parse(fs.readFileSync(subsFile, 'utf8'));
    const r = subs.filings.recent;
    const annual = [];
    for (let i = 0; i < r.form.length && annual.length < ANNUALS; i += 1) {
      if (r.form[i] !== c.form) continue;
      annual.push({ accn: r.accessionNumber[i], form: r.form[i], filed: r.filingDate[i], period: r.reportDate[i], doc: r.primaryDocument[i] });
    }
    if (!annual.length) throw new Error(`${c.id}: no ${c.form} found`);
    for (const a of annual) {
      const dir = `docs/${c.id}/${a.accn}`;
      if (!fs.existsSync(path.join(sec.CACHE, 'text', `${c.id}-${a.accn}.txt`))) await sec.cached(sec.docUrl(c.cik, a.accn, a.doc), `${dir}/${a.doc}`);
      const idx = await sec.cached(`https://www.sec.gov/Archives/edgar/data/${c.cik}/${sec.nodash(a.accn)}/index.json`, `${dir}/index.json`);
      const items = JSON.parse(fs.readFileSync(idx, 'utf8')).directory.item.map((x) => x.name);
      const inst = items.find((n) => /_htm\.xml$/.test(n)) || null;
      const lab = items.find((n) => /_lab\.xml$/.test(n)) || items.find((n) => /\.xsd$/.test(n)) || null;   // some filers embed the labels in the schema
      if (lab) { await sec.cached(sec.docUrl(c.cik, a.accn, lab), `${dir}/${lab}`); a.labels = lab; }
      if (inst) { await sec.cached(sec.docUrl(c.cik, a.accn, inst), `${dir}/${inst}`); a.instance = inst; }
      // An annual report whose main document is a short wrapper carries the
      // report itself as an exhibit (some 20-Fs do): keep the big ones too.
      a.files = items;
    }
    manifest[c.id] = { cik: c.cik, name: subs.name, fiscalYearEnd: subs.fiscalYearEnd, annual };
    console.log(`${c.id}: ${annual.map((a) => `${a.form} ${a.period} (${a.accn})`).join(', ')}`);
  }
  fs.writeFileSync(manFile, JSON.stringify(manifest, null, 1));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
