// SEC EDGAR: a watched company's new 8-K filings, as company events.
//
// EDGAR's fair-access policy asks every automated client for a User-Agent
// that names who is asking and how to reach them, and to stay under ten
// requests a second. The contact belongs to the operator, so it is read from
// the SEC_USER_AGENT env var and never written into this repo (which is
// public) - and without it this module refuses to call EDGAR at all, rather
// than calling it anonymously and being blocked.
//
//   company_tickers.json  -> name / ticker -> CIK
//   submissions/CIK##########.json -> recent filings; 8-K items mapped:
//     2.05 costs of exit or disposal  -> layoff
//     5.02 officer departures/appointments -> exec_change
//     2.01 completed acquisition or disposition -> acquisition
//     2.02 results of operations      -> earnings
//     1.01 material definitive agreement -> other

const crypto = require('crypto');
const { clean } = require('./text');

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SUBMISSIONS = (cik) => `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`;

// Highest first: a filing with 2.05 and 9.01 is a layoff.
const ITEM_TYPES = [['2.05', 'layoff'], ['5.02', 'exec_change'], ['2.01', 'acquisition'], ['2.02', 'earnings'], ['1.01', 'other']];
const ITEM_LABELS = { '1.01': 'material agreement', '2.01': 'acquisition or disposition completed', '2.02': 'results of operations', '2.05': 'exit or disposal costs', '5.02': 'officer or director change', '7.01': 'Reg FD disclosure', '8.01': 'other events', '9.01': 'exhibits' };

/** The SEC-required User-Agent, or a thrown refusal. */
function userAgent(env = process.env) {
  const ua = String(env.SEC_USER_AGENT || '').trim();
  // SEC asks for a name and an email address. Insist on the address.
  if (!ua || !/@/.test(ua) || ua.length < 8 || ua.length > 200) {
    throw Object.assign(new Error('SEC_USER_AGENT is not set (a name and contact address, as SEC EDGAR requires) - not calling EDGAR.'), { code: 'sec-ua' });
  }
  return ua;
}

/** "Acme Holdings, Inc." -> "acme holdings"; the corporate suffixes go. */
function normName(n) {
  return String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(inc|incorporated|corp|corporation|co|company|ltd|limited|llc|plc|the|holdings?|group|sa|nv|ag|se)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** company_tickers.json -> lookup {byName: Map, byTicker: Map}. A name two CIKs share maps to null. */
function tickerIndex(json) {
  const byName = new Map();
  const byTicker = new Map();
  for (const v of Object.values(json || {})) {
    if (!v || !Number.isFinite(Number(v.cik_str))) continue;
    const cik = Number(v.cik_str);
    const n = normName(v.title);
    if (n) byName.set(n, byName.has(n) && byName.get(n).cik !== cik ? null : { cik, title: clean(v.title, 120), ticker: v.ticker });
    if (v.ticker) byTicker.set(String(v.ticker).toUpperCase(), { cik, title: clean(v.title, 120), ticker: v.ticker });
  }
  return { byName, byTicker };
}

/** A company name (or a ticker typed as the name) -> {cik, title} or null. Exact matches only. */
function cikFor(index, name, ticker) {
  if (!index) return null;
  if (ticker && index.byTicker.get(String(ticker).toUpperCase())) return index.byTicker.get(String(ticker).toUpperCase());
  const hit = index.byName.get(normName(name));
  if (hit) return hit;
  // Someone typed "NVDA".
  if (/^[A-Z.]{1,6}$/.test(String(name || '').trim())) return index.byTicker.get(String(name).trim()) || null;
  return null;
}

function typeFor(items) {
  for (const [item, type] of ITEM_TYPES) if (items.includes(item)) return type;
  return 'other';
}

/**
 * New 8-Ks in a submissions document since `sinceIso`, as company_events rows.
 */
function eventsFrom(json, companyKey, sinceIso) {
  const r = json && json.filings && json.filings.recent;
  if (!r || !Array.isArray(r.form)) return [];
  const cik = Number(json.cik);
  // EDGAR spells names in capitals; a headline reads better in title case.
  let name = clean(json.name, 120);
  if (name && name === name.toUpperCase()) name = name.toLowerCase().replace(/(^|[\s.,&-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  const since = Date.parse(sinceIso || 0) || 0;
  const out = [];
  for (let i = 0; i < r.form.length && i < 400; i++) {
    const form = String(r.form[i] || '');
    if (form !== '8-K' && form !== '8-K/A') continue;
    const when = r.acceptanceDateTime && r.acceptanceDateTime[i] ? r.acceptanceDateTime[i] : r.filingDate && r.filingDate[i];
    const at = Date.parse(when);
    if (!Number.isFinite(at) || at < since) continue;
    const accession = String(r.accessionNumber && r.accessionNumber[i] || '');
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const items = String(r.items && r.items[i] || '').split(',').map((s) => s.trim()).filter((s) => /^\d\.\d{2}$/.test(s));
    const doc = String(r.primaryDocument && r.primaryDocument[i] || '');
    const folder = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}`;
    const url = /^[A-Za-z0-9._-]{1,120}$/.test(doc) ? `${folder}/${doc}` : `${folder}/`;
    const labels = items.filter((it) => ITEM_LABELS[it] && it !== '9.01').map((it) => ITEM_LABELS[it]);
    out.push({
      event_id: crypto.createHash('sha256').update(`sec|${accession}`).digest('hex').slice(0, 32),
      company_key: companyKey,
      source: 'sec',
      event_type: typeFor(items),
      headline: clean(`${name} filed an ${form}${labels.length ? `: ${labels.join(', ')}` : ''}`, 300),
      url,
      published_at: new Date(at).toISOString(),
      sec_form: form,
      sec_items: items,
    });
  }
  return out;
}

async function loadTickers(http, env = process.env) {
  const ua = userAgent(env);
  const json = await http.json(TICKERS_URL, { userAgent: ua, timeoutMs: 30000, maxBytes: 20 * 1024 * 1024 });
  return tickerIndex(json);
}

async function filings(http, cik, companyKey, sinceIso, env = process.env) {
  const ua = userAgent(env);
  const json = await http.json(SUBMISSIONS(cik), { userAgent: ua, timeoutMs: 20000 });
  return json ? eventsFrom(json, companyKey, sinceIso) : [];
}

module.exports = { userAgent, normName, tickerIndex, cikFor, eventsFrom, loadTickers, filings, typeFor, TICKERS_URL, SUBMISSIONS, ITEM_TYPES };
