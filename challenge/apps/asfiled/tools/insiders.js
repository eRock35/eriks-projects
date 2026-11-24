#!/usr/bin/env node
// Insider transactions, from Form 4 (the SEC's ownership XML). For each
// company: the Form 4s filed about it in the twelve months before its
// submissions index was read, and from each only the open-market purchases
// (transaction code P) and sales (code S) of non-derivative securities by a
// reporting person who is an officer or a director. Nothing else is kept:
// not grants, option exercises, tax withholding or gifts, not a holder who
// is only a ten-percent owner, and not an amended form (4/A), which would
// count a transaction twice.
//
// `node tools/insiders.js` (npm run data:insiders) reads each form from
// sec.gov, keeps a few fields per filing in the cache (insiders/<ID>.json)
// and never writes the form itself. FILINGS_ONLY=NVDA,MSFT as elsewhere.
//
// FILED BY INSIDERS; NOT A SIGNAL OR ADVICE. The page says so.

const fs = require('fs');
const path = require('path');
const sec = require('./sec');
const { unescape } = require('./xbrl');

const WINDOW_DAYS = 365;
const DIR = path.join(sec.CACHE, 'insiders');
const CODES = { P: 'Open-market purchase', S: 'Open-market sale' };

const one = (xml, tag) => { const m = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(xml); return m ? unescape(m[1]) : ''; };
const val = (xml, tag) => { const m = new RegExp(`<${tag}>[\\s\\S]*?<value>\\s*([^<]*?)\\s*</value>`).exec(xml); return m ? unescape(m[1]) : ''; };
const yes = (s) => s === '1' || /^true$/i.test(s);
const blocks = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);

/** One Form 4's ownership XML -> what the page may show of it, or null when
 *  it is not a Form 4. `rows`: one per transaction code kept (P, S), with
 *  the shares and the value (shares x price, line by line) added up. */
function parseForm4(xml) {
  if (one(xml, 'documentType') !== '4') return null;
  const owners = blocks(xml, 'reportingOwner').map((b) => ({
    name: one(b, 'rptOwnerName').replace(/\s+/g, ' ').slice(0, 80),
    director: yes(one(b, 'isDirector')), officer: yes(one(b, 'isOfficer')),
    title: one(b, 'officerTitle').replace(/\s+/g, ' ').slice(0, 80),
  }));
  const insiders = owners.filter((o) => o.director || o.officer);
  const out = { issuerCik: Number(one(xml, 'issuerCik')), owners, insider: insiders.length > 0, plan: yes(one(xml, 'aff10b5One')), rows: [] };
  if (!out.insider) return out;
  const by = {};
  const table = (/<nonDerivativeTable>([\s\S]*?)<\/nonDerivativeTable>/.exec(xml) || [])[1] || '';
  for (const t of blocks(table, 'nonDerivativeTransaction')) {
    const code = one(t, 'transactionCode');
    if (!CODES[code]) continue;
    const shares = Number(val(t, 'transactionShares')); const price = Number(val(t, 'transactionPricePerShare')); const date = val(t, 'transactionDate').slice(0, 10);
    const ad = val(t, 'transactionAcquiredDisposedCode');
    // A purchase acquires and a sale disposes; a line that says otherwise, or has no price, is left out and counted.
    if (!(shares > 0) || !(price > 0) || !/^\d{4}-\d\d-\d\d$/.test(date) || ad !== (code === 'P' ? 'A' : 'D')) { out.odd = (out.odd || 0) + 1; continue; }
    const r = by[code] = by[code] || { code, shares: 0, value: 0, from: date, to: date, lines: 0 };
    r.shares += shares; r.value += shares * price; r.lines += 1;
    if (date < r.from) r.from = date;
    if (date > r.to) r.to = date;
  }
  const who = insiders.map((o) => o.name).join(' and ');
  const role = insiders.length === 1 ? (insiders[0].officer && insiders[0].title ? insiders[0].title : insiders[0].officer ? 'Officer' : 'Director') + (insiders[0].officer && insiders[0].director ? ', director' : '') : 'Officers or directors';
  for (const r of Object.values(by)) out.rows.push({ ...r, shares: Math.round(r.shares * 1000) / 1000, value: Math.round(r.value * 100) / 100, who, role, plan: out.plan });
  return out;
}

/** The Form 4s in a submissions index, filed in the window before `asOf`:
 *  [{accn, filed, doc}] newest first, and whether the index reaches back
 *  that far. */
function listForm4(subs, asOf) {
  const r = (subs.filings && subs.filings.recent) || { form: [] };
  const from = new Date(Date.parse(asOf) - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const out = [];
  for (let i = 0; i < r.form.length; i += 1) {
    if (r.form[i] !== '4' || r.filingDate[i] < from || r.filingDate[i] > asOf) continue;
    const doc = String(r.primaryDocument[i] || '').replace(/^.*\//, '');
    if (!/^\d{10}-\d{2}-\d{6}$/.test(r.accessionNumber[i]) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.xml$/.test(doc)) continue;
    out.push({ accn: r.accessionNumber[i], filed: r.filingDate[i], doc });
  }
  const oldest = r.filingDate && r.filingDate.length ? r.filingDate[r.filingDate.length - 1] : asOf;
  return { from, to: asOf, list: out, complete: oldest <= from || r.form.length < 1000 };
}

/** Read the listed forms (through `get`, one at a time) into the record the
 *  build and the lookup both use. */
async function collect(cik, listed, get, { max = Infinity } = {}) {
  const rec = { from: listed.from, to: listed.to, complete: listed.complete, listed: listed.list.length, read: 0, other: 0, failed: 0, odd: 0, rows: [] };
  for (const f of listed.list.slice(0, max)) {
    let p = null;
    try { p = parseForm4(await get(sec.docUrl(cik, f.accn, f.doc))); } catch (e) {
      if (e instanceof sec.SecError && e.code === 'no-agent') throw e;
    }
    if (!p) { rec.failed += 1; continue; }
    rec.read += 1;
    // A form about another issuer (the company itself reporting a holding), or by a holder who is neither officer nor director.
    if (p.issuerCik !== Number(cik) || !p.insider) { rec.other += 1; continue; }
    rec.odd += p.odd || 0;
    for (const r of p.rows) rec.rows.push({ ...r, accn: f.accn, filed: f.filed });
  }
  return rec;
}

async function main() {
  sec.agent();
  const { FILERS } = require('./companies');
  fs.mkdirSync(DIR, { recursive: true });
  const only = process.env.FILINGS_ONLY ? new Set(process.env.FILINGS_ONLY.split(',').map((x) => x.trim())) : null;
  const get = async (url) => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await sec.get(url, { maxBytes: 4 * 1024 * 1024, timeoutMs: 40000 }); } catch (e) {
        if (attempt >= 2 || (e instanceof sec.SecError && (e.code === 'not-found' || e.code === 'no-agent'))) throw e;
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
  };
  for (const c of FILERS) {
    if (only && !only.has(c.id)) continue;
    const file = path.join(DIR, `${c.id}.json`);
    if (fs.existsSync(file)) continue;
    const subsFile = path.join(sec.CACHE, 'subs', `${c.id}.json`);
    const asOf = fs.statSync(subsFile).mtime.toISOString().slice(0, 10);
    const listed = listForm4(JSON.parse(fs.readFileSync(subsFile, 'utf8')), asOf);
    const rec = await collect(c.cik, listed, get);
    fs.writeFileSync(file, JSON.stringify(rec));
    console.log(`${c.id}: ${rec.listed} Form 4s, ${rec.read} read, ${rec.rows.length} purchase or sale rows, ${rec.other} not an officer's or director's, ${rec.failed} unread`);
  }
}

module.exports = { parseForm4, listForm4, collect, WINDOW_DAYS, CODES, DIR };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
