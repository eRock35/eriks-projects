#!/usr/bin/env node
// Writes test/fixtures/sec/: a made-up registrant (Harborlight Data Inc,
// CIK 9900001) in the shape sec.gov answers in - the ticker list, company
// facts, submissions, a filing's index, its XBRL instance and labels, and
// its annual report. Nothing here is a real filing. tools/sec.js reads them
// when ASFILED_FAKE_SEC points at the directory. Run: node test/fixtures/make.js

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'sec');
const write = (rel, body) => { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body)); };

const tickers = [
  [789019, 'MSFT', 'MICROSOFT CORP'],
  [9900001, 'HBLD', 'HARBORLIGHT DATA INC'],
  [9900002, 'TDWA', 'Tidewater Analytics Corp'],
  [9900003, 'QLFS', 'QUILLFEATHER SYSTEMS INC /DE/'],
  [9900004, 'TGT', 'TARGET CORP'],
  [9900005, 'SMMT', 'Summit Corp'],
  [9900006, 'HBLDW', 'HARBORLIGHT DATA INC'].map((x, i) => (i === 0 ? 9900001 : x)),   // a second ticker for the same registrant
  [9900007, 'NOFX', 'Nofacts Holdings Ltd'],
];
write('www.sec.gov/files/company_tickers.json', Object.fromEntries(tickers.map((t, i) => [i, { cik_str: t[0], ticker: t[1], title: t[2] }])));

function company(cik, name, base, accnOf) {
  const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
  const row = (fy, val, instant) => ({ ...(instant ? {} : { start: `${fy}-01-01` }), end: `${fy}-12-31`, val, accn: accnOf(fy), fy, fp: 'FY', form: '10-K', filed: `${fy + 1}-02-20`, frame: `CY${fy}` });
  const series = (f, instant) => ({ units: { USD: years.map((fy, i) => row(fy, Math.round(f(base * (1 + 0.09 * i), i)), instant)) } });
  // A quarter and a 10-Q row, which the year rule must ignore.
  const rev = series((v) => v);
  rev.units.USD.push({ start: '2025-10-01', end: '2025-12-31', val: Math.round(base * 0.4), accn: accnOf(2025), fy: 2025, fp: 'FY', form: '10-K', filed: '2026-02-20' });
  rev.units.USD.push({ start: '2025-01-01', end: '2025-03-31', val: Math.round(base * 0.38), accn: `${String(cik).padStart(10, '0')}-25-000003`, fy: 2025, fp: 'Q1', form: '10-Q', filed: '2025-04-25' });
  return {
    cik, entityName: name,
    facts: {
      dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: '2026-01-31', val: 120000000, accn: accnOf(2025), fy: 2025, fp: 'FY', form: '10-K', filed: '2026-02-20' }] } } },
      'us-gaap': {
        Revenues: { label: 'Revenues', ...rev },
        CostOfRevenue: series((v) => v * 0.44),
        GrossProfit: series((v) => v * 0.56),
        ResearchAndDevelopmentExpense: series((v, i) => v * (0.08 + 0.004 * i)),
        PaymentsToAcquirePropertyPlantAndEquipment: series((v) => v * 0.11),
        InventoryNet: series((v) => v * 0.03, true),
        // Cash and capital return. No dividend and no short-term investment
        // is tagged: the page must say "Not tagged", not zero.
        NetCashProvidedByUsedInOperatingActivities: series((v) => v * 0.31),
        ShareBasedCompensation: series((v) => v * 0.05),
        PaymentsForRepurchaseOfCommonStock: series((v) => v * 0.1),
        CashAndCashEquivalentsAtCarryingValue: series((v) => v * 0.2, true),
        LongTermDebtNoncurrent: series((v) => v * 0.5, true),
        LongTermDebtCurrent: series((v) => v * 0.04, true),
        CommercialPaper: series((v) => v * 0.01, true),
        Assets: series((v) => v * 2.4, true),          // not a tag the app reads: slimFacts drops it
      },
    },
  };
}
function submissions(cik, name, ticker, annual) {
  return {
    cik: String(cik), name, tickers: [ticker], fiscalYearEnd: '1231',
    filings: { recent: {
      accessionNumber: [`${String(cik).padStart(10, '0')}-26-000011`, annual.accn, `${String(cik).padStart(10, '0')}-25-000041`],
      form: ['8-K', '10-K', '10-Q'], filingDate: ['2026-03-02', '2026-02-20', '2025-10-24'], reportDate: ['2026-03-01', '2025-12-31', '2025-09-30'],
      primaryDocument: ['hbld-8k.htm', annual.doc, 'q3.htm'],
    } },
  };
}

/* Harborlight: everything. */
const H = 9900001; const HA = (fy) => `0009900001-${String(fy + 1).slice(2)}-000007`;
const accn = HA(2025); const dir = `www.sec.gov/Archives/edgar/data/${H}/${accn.replace(/-/g, '')}`;
const hf = company(H, 'HARBORLIGHT DATA INC', 2.1e9, HA);
write(`data.sec.gov/api/xbrl/companyfacts/CIK${String(H).padStart(10, '0')}.json`, hf);
write(`data.sec.gov/submissions/CIK${String(H).padStart(10, '0')}.json`, submissions(H, 'HARBORLIGHT DATA INC', 'HBLD', { accn, doc: 'hbld-20251231.htm' }));
write(`${dir}/index.json`, { directory: { name: `/Archives/edgar/data/${H}/${accn.replace(/-/g, '')}`, item: [{ name: 'hbld-20251231.htm', type: 'text.gif' }, { name: 'hbld-20251231_htm.xml', type: 'text.gif' }, { name: 'hbld-20251231_lab.xml', type: 'text.gif' }] } });

const total = hf.facts['us-gaap'].Revenues.units.USD.find((r) => r.end === '2025-12-31' && r.start === '2025-01-01').val;
const seg = [['hbld:WorkforceSolutionsMember', Math.round(total * 0.58)], ['hbld:ConsumerInformationMember', 0]];
seg[1][1] = total - seg[0][1];
const ctx = (id, member) => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0009900001</xbrli:identifier>${member ? `<xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">${member}</xbrldi:explicitMember></xbrli:segment>` : ''}</xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>`;
write(`${dir}/hbld-20251231_htm.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:us-gaap="http://fasb.org/us-gaap/2025" xmlns:hbld="http://example.com/hbld/20251231">
${ctx('c0')}${ctx('c1', seg[0][0])}${ctx('c2', seg[1][0])}
<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
<us-gaap:Revenues contextRef="c0" unitRef="usd" decimals="-3">${total}</us-gaap:Revenues>
<us-gaap:Revenues contextRef="c1" unitRef="usd" decimals="-3">${seg[0][1]}</us-gaap:Revenues>
<us-gaap:Revenues contextRef="c2" unitRef="usd" decimals="-3">${seg[1][1]}</us-gaap:Revenues>
</xbrli:xbrl>
`);
const lab = (el, text, n) => `<link:loc xlink:type="locator" xlink:href="hbld-20251231.xsd#${el}" xlink:label="loc_${n}"/><link:label xlink:type="resource" xlink:label="lab_${n}" xlink:role="http://www.xbrl.org/2003/role/label" xml:lang="en-US">${text}</link:label><link:labelArc xlink:type="arc" xlink:arcrole="http://www.xbrl.org/2003/arcrole/concept-label" xlink:from="loc_${n}" xlink:to="lab_${n}"/>`;
write(`${dir}/hbld-20251231_lab.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<link:linkbase xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink"><link:labelLink xlink:type="extended" xlink:role="http://www.xbrl.org/2003/role/link">
${lab('hbld_WorkforceSolutionsMember', 'Workforce Solutions [Member]', 1)}
${lab('hbld_ConsumerInformationMember', 'Consumer Information [Member]', 2)}
</link:labelLink></link:linkbase>
`);
const P = (s) => `<p>${s}</p>`;
write(`${dir}/hbld-20251231.htm`, `<html><head><title>hbld-20251231</title><style>p{margin:0}</style></head><body>
<div>${P('UNITED STATES SECURITIES AND EXCHANGE COMMISSION')}${P('FORM 10-K')}${P('HARBORLIGHT DATA INC')}</div>
${P('Item 1. Business')}
${P('Harborlight Data Inc. collects and sells employment, income and consumer credit data to lenders and employers in the United States.')}
${P('Our headquarters are near the offices of Tidewater Analytics in a business district that has grown quickly in recent years.')}
${P('Competition')}
${P('We compete with Tidewater Analytics and Quillfeather&#160;Systems in the market for consumer credit data and income verification.')}
${P('Customers')}
${P('Quillfeather Systems accounted for 12% of our revenue in 2025 under a multi-year data licensing contract.')}
${P('Technology')}
${P('We rely on AWS to host our data platform under an agreement that runs through 2028.')}
${P('Item 1A. Risk Factors')}
${P('Summit conditions in our Target markets may change what our suppliers charge us, and we may not be able to pass those costs on.')}
${P('We depend on a limited number of data suppliers, and the loss of any one of them could harm our business.')}
${P('Item 3. Legal Proceedings')}
${P('In 2024 Tidewater Analytics filed a complaint against us in federal court alleging infringement of two of its patents.')}
${P('Item 9A. Controls and Procedures')}
${P('Our management concluded that our disclosure controls and procedures were effective as of December 31, 2025.')}
</body></html>
`);

/* Tidewater: figures only (no filing index: revenue mix is then simply absent). */
const TW = 9900002; const TA = (fy) => `0009900002-${String(fy + 1).slice(2)}-000004`;
write(`data.sec.gov/api/xbrl/companyfacts/CIK${String(TW).padStart(10, '0')}.json`, company(TW, 'Tidewater Analytics Corp', 6.4e8, TA));
write(`data.sec.gov/submissions/CIK${String(TW).padStart(10, '0')}.json`, submissions(TW, 'Tidewater Analytics Corp', 'TDWA', { accn: TA(2025), doc: 'tdwa-10k.htm' }));

/* Nofacts: a registrant that files no annual report this app reads. */
const NF = 9900007;
write(`data.sec.gov/api/xbrl/companyfacts/CIK${String(NF).padStart(10, '0')}.json`, { cik: NF, entityName: 'Nofacts Holdings Ltd', facts: {} });
write(`data.sec.gov/submissions/CIK${String(NF).padStart(10, '0')}.json`, { cik: String(NF), name: 'Nofacts Holdings Ltd', tickers: ['NOFX'], filings: { recent: { accessionNumber: ['0009900007-26-000001'], form: ['6-K'], filingDate: ['2026-01-15'], reportDate: ['2025-12-31'], primaryDocument: ['six.htm'] } } });
console.log('fixtures written to', path.relative(process.cwd(), OUT));
