#!/usr/bin/env node
// Peers: who else files under a company's SIC code, and how its tagged
// figures rank among them. Two public SEC sources, nothing else:
//
//   - XBRL frames (data.sec.gov/api/xbrl/frames/<taxonomy>/<tag>/USD/CY<year>):
//     one fact per registrant for a calendar-year frame - the SEC assigns a
//     fiscal year to the calendar year it mostly falls in - each with its
//     period and the accession number of the filing it was read from.
//   - each registrant's submissions index: its SIC code and its latest
//     annual report (Form 10-K or 20-F).
//
// `node tools/peers.js` (npm run data:peers) downloads both into the cache,
// cut down as they arrive (a frame keeps cik -> value, period, accession; a
// submissions index keeps five fields; neither raw file is written).
// tools/build.js calls `parts()` to write public/data/sic/<code>.json.
//
// WHO IS A PEER, exactly (said on the page too): a registrant with the same
// SIC code in its SEC submissions index, that has a revenue fact in US
// dollars in the calendar-year frame, and whose latest Form 10-K or 20-F
// was filed in the 18 months before the day the index was read. A registrant
// that reports in another currency is not in the US-dollar frames at all.

const fs = require('fs');
const path = require('path');
const sec = require('./sec');
const X = require('./xbrl');

const YEAR = 2025;                      // the latest calendar year whose annual reports are all in (roll forward each autumn)
const WINDOW_DAYS = 548;                // 18 months
const DIR = path.join(sec.CACHE, 'peers');
const ANNUAL = ['10-K', '20-F'];

// The tags a peer figure may come from, in the build's own order of
// preference (tools/xbrl.js). One calendar-year frame per tag; revenue also
// for the year before, for growth.
const METRICS = {
  revenue: X.TAGS.revenue.filter((t) => t !== 'us-gaap:SalesRevenueNet'),
  op: ['us-gaap:OperatingIncomeLoss', 'ifrs-full:ProfitLossFromOperatingActivities'],
  ocf: ['us-gaap:NetCashProvidedByUsedInOperatingActivities', 'ifrs-full:CashFlowsFromUsedInOperatingActivities'],
  capex: X.TAGS.capex,
  rd: X.TAGS.rd,
};
const frameFile = (qname, year) => path.join(DIR, 'frames', `${qname.replace(':', '.')}.CY${year}.json`);
const universeFile = () => path.join(DIR, 'universe.json');
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

async function getJson(url, maxBytes) {
  for (let attempt = 0; ; attempt += 1) {
    try { return JSON.parse(await sec.get(url, { maxBytes, timeoutMs: 60000 })); } catch (e) {
      if (e instanceof sec.SecError && (e.code === 'not-found' || e.code === 'no-agent' || e.code === 'too-large')) throw e;
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
  }
}

async function fetchAll() {
  sec.agent();
  fs.mkdirSync(path.join(DIR, 'frames'), { recursive: true });
  const wanted = [];
  for (const [metric, tags] of Object.entries(METRICS)) for (const q of tags) { wanted.push([q, YEAR]); if (metric === 'revenue') wanted.push([q, YEAR - 1]); }
  for (const [q, year] of wanted) {
    const file = frameFile(q, year);
    if (fs.existsSync(file)) continue;
    const [tax, tag] = q.split(':');
    let rows = {}; const names = {};
    try {
      const fr = await getJson(`https://data.sec.gov/api/xbrl/frames/${tax}/${tag}/USD/CY${year}.json`, 64 * 1024 * 1024);
      for (const r of fr.data || []) {
        if (!Number.isFinite(r.val) || !r.start || !r.end || !/^\d{10}-\d{2}-\d{6}$/.test(String(r.accn))) continue;
        rows[r.cik] = [r.val, r.start, r.end, r.accn];
        names[r.cik] = r.entityName;
      }
    } catch (e) {
      if (!(e instanceof sec.SecError && e.code === 'not-found')) throw e;
      rows = {};                         // no registrant used this tag for the year
    }
    fs.writeFileSync(file, JSON.stringify({ tag: q, frame: `CY${year}`, read: new Date().toISOString().slice(0, 10), rows, names }));
    console.log(`${q} CY${year}: ${Object.keys(rows).length} registrants`);
  }
  // The universe: every registrant with a revenue fact in the year's frame.
  const ciks = new Set();
  for (const q of METRICS.revenue) for (const k of Object.keys(readJson(frameFile(q, YEAR), { rows: {} }).rows)) ciks.add(Number(k));
  const uni = readJson(universeFile(), { read: new Date().toISOString().slice(0, 10), ciks: {} });
  const todo = [...ciks].filter((k) => !uni.ciks[k]).sort((a, b) => a - b);
  console.log(`${ciks.size} registrants with CY${YEAR} revenue in US dollars; ${todo.length} submissions indexes to read`);
  let n = 0;
  for (const cik of todo) {
    let rec;
    try {
      const s = await getJson(`https://data.sec.gov/submissions/CIK${sec.pad10(cik)}.json`, 32 * 1024 * 1024);
      const r = (s.filings && s.filings.recent) || { form: [] };
      let annual = null;
      for (let i = 0; i < r.form.length && !annual; i += 1) if (ANNUAL.includes(r.form[i])) annual = [r.form[i], r.filingDate[i]];
      rec = { n: String(s.name || '').slice(0, 80), s: String(s.sic || ''), d: String(s.sicDescription || '').slice(0, 90), a: annual, t: (s.tickers || [])[0] || '' };
    } catch (e) {
      if (e instanceof sec.SecError && e.code === 'no-agent') throw e;
      rec = { err: e instanceof sec.SecError ? e.code : 'error' };
    }
    uni.ciks[cik] = rec;
    n += 1;
    if (n % 200 === 0) { fs.writeFileSync(universeFile(), JSON.stringify(uni)); console.log(`${n} of ${todo.length}`); }
  }
  uni.read = uni.read || new Date().toISOString().slice(0, 10);
  fs.writeFileSync(universeFile(), JSON.stringify(uni));
  console.log(`universe: ${Object.keys(uni.ciks).length} registrants -> ${universeFile()}`);
}

module.exports = { YEAR, WINDOW_DAYS, METRICS, DIR, frameFile, universeFile, readJson, days, ANNUAL };
if (require.main === module) fetchAll().catch((e) => { console.error(e.message); process.exit(1); });
