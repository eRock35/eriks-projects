#!/usr/bin/env node
// Pay versus performance, from a company's latest proxy statement (Form
// DEF 14A). Since 2023 the table is tagged (the SEC's `ecd` taxonomy): the
// principal executive officer's total from the summary compensation table,
// the "compensation actually paid", the averages for the other named
// executive officers, and the value of a $100 holding (total shareholder
// return) beside the company's chosen peer group.
//
// Read from the proxy's own XBRL instance - company facts carries these for
// some filers and not for others. Only facts with no dimension are kept: a
// year with two principal executive officers is tagged per person, and
// nothing is shown for it. `node tools/proxy.js` (npm run data:proxy)
// keeps the few facts per company in the cache (proxy/<ID>.json).

const fs = require('fs');
const path = require('path');
const sec = require('./sec');
const X = require('./xbrl');

const DIR = path.join(sec.CACHE, 'proxy');
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const WINDOW_DAYS = 548;               // a proxy older than 18 months is not "the latest"

/** The latest DEF 14A in a submissions index, filed in the window before `asOf`. */
function latestProxy(subs, asOf) {
  const r = (subs.filings && subs.filings.recent) || { form: [] };
  const from = new Date(Date.parse(asOf) - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  for (let i = 0; i < r.form.length; i += 1) {
    if (r.form[i] !== 'DEF 14A') continue;
    if (r.filingDate[i] < from || !/^\d{10}-\d{2}-\d{6}$/.test(r.accessionNumber[i])) return null;
    return { accn: r.accessionNumber[i], filed: r.filingDate[i] };
  }
  return null;
}

/** The pay facts of one proxy statement: {accn, filed, facts: [{tag, start, end, val}]},
 *  or null when the company has no recent DEF 14A or it carries no tagged table. */
async function read(cik, subs, asOf, get) {
  const p = latestProxy(subs, asOf);
  if (!p) return null;
  const items = JSON.parse(await get(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${sec.nodash(p.accn)}/index.json`, { maxBytes: 2 * 1024 * 1024 })).directory.item.map((x) => String(x.name));
  const inst = items.find((n) => /_htm\.xml$/.test(n) && FILE.test(n));
  if (!inst) return { ...p, facts: [] };
  const wanted = new Set(Object.values(X.PAY));
  const facts = [];
  for (const f of X.parseInstance(await get(sec.docUrl(cik, p.accn, inst), { maxBytes: 32 * 1024 * 1024 })).facts) {
    if (!wanted.has(f.tag) || f.unit !== 'USD' || f.ctx.dims.length || f.ctx.typed || !f.ctx.start || !f.ctx.end) continue;
    facts.push({ tag: f.tag, start: f.ctx.start, end: f.ctx.end, val: f.val });
  }
  return { ...p, facts };
}

async function main() {
  sec.agent();
  const { FILERS } = require('./companies');
  fs.mkdirSync(DIR, { recursive: true });
  const only = process.env.FILINGS_ONLY ? new Set(process.env.FILINGS_ONLY.split(',').map((x) => x.trim())) : null;
  const get = (url, o) => sec.get(url, { timeoutMs: 60000, ...o });
  for (const c of FILERS) {
    if (only && !only.has(c.id)) continue;
    const file = path.join(DIR, `${c.id}.json`);
    if (fs.existsSync(file)) continue;
    const subsFile = path.join(sec.CACHE, 'subs', `${c.id}.json`);
    const asOf = fs.statSync(subsFile).mtime.toISOString().slice(0, 10);
    const rec = await read(c.cik, JSON.parse(fs.readFileSync(subsFile, 'utf8')), asOf, get);
    fs.writeFileSync(file, JSON.stringify(rec || { none: true }));
    console.log(`${c.id}: ${rec ? `DEF 14A ${rec.filed} (${rec.accn}), ${rec.facts.length} pay facts` : 'no proxy statement (DEF 14A) in the last 18 months'}`);
  }
}

module.exports = { read, latestProxy, DIR, WINDOW_DAYS };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
