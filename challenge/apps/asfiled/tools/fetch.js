#!/usr/bin/env node
// Step 1: download the raw public sources into the cache (outside the repo).
//
//   - XBRL company facts for each company (data.sec.gov)
//   - each company's submissions index, to find its latest annual report
//   - that annual report's main document and its XBRL instance
//
// Nothing is written inside the repo. Run with SEC_USER_AGENT set.

const fs = require('fs');
const path = require('path');
const { FILERS } = require('./companies');
const sec = require('./sec');

const ANNUALS = Number(process.env.FILINGS_ANNUALS || 1);   // how many annual reports' text to read

async function main() {
  sec.agent();
  const manifest = {};
  for (const c of FILERS) {
    const cik10 = sec.pad10(c.cik);
    await sec.cached(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`, `facts/${c.id}.json`);
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
      await sec.cached(sec.docUrl(c.cik, a.accn, a.doc), `${dir}/${a.doc}`);
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
  // Apple's own Supplier List, from apple.com (not the SEC: no declared
  // identity is sent there, only a generic client name).
  await sec.cached('https://www.apple.com/supply-chain/pdf/Apple-Supplier-List.pdf', 'apple/Apple-Supplier-List.pdf', { binary: true });
  console.log('Apple Supplier List: cached');
  fs.writeFileSync(path.join(sec.CACHE, 'manifest.json'), JSON.stringify(manifest, null, 1));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
