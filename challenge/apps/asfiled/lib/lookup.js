// A company looked up on request: any SEC registrant with a listed ticker,
// built into the same per-company part the page already draws, by the same
// code the build uses (tools/build.js addCompany, tools/xbrl.js slimFacts,
// the insight templates in public/asfiled-core.js). No model anywhere here.
//
// What is different from the reviewed set, and said on the page: nobody has
// read this company's filings. So its part is labelled, it is kept out of
// the 81's patterns and sums (those are built files; nothing here can change
// them), and it has no layer on the map but "Looked up".
//
//   - sec.gov is reached only through tools/sec.js (the one reader of
//     SEC_USER_AGENT), and only inside a request. Without the variable a
//     lookup that is not already stored answers 503.
//   - A built part is stored (the lab's store; memory in tests) by CIK and
//     served from there for FRESH_DAYS; a repeat view asks sec.gov nothing.
//   - Limits, in memory, per instance: builds per address an hour and
//     across the instance a day. Two requests for one CIK share one build,
//     and builds run one at a time (a company-facts file can be tens of MB).

const sec = require('../tools/sec');
const X = require('../tools/xbrl');
const B = require('../tools/build');
const Core = require('../public/asfiled-core');
const { FILERS } = require('../tools/companies');
const Names = require('./names');
const T = require('../tools/text');
const Verify = require('../tools/verify');
const People = require('../tools/people');
const Insiders = require('../tools/insiders');
const Proxy = require('../tools/proxy');

const V = 2;                                      // the stored part's shape (2: cash, quarters and the rest of f/)
const LABEL = 'Looked up on request - not in the reviewed set';
const UNAVAILABLE = 'Lookups are not available right now';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const ANNUAL = ['10-K', '20-F'];
const ACCN = /^\d{10}-\d{2}-\d{6}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const MB = 1024 * 1024;
const MORE_V = 1;                                 // the stored second reading's shape
const FORM4_MAX = 40;                             // Form 4s read for one looked-up company

class LookupError extends Error {
  constructor(status, message, code) { super(message); this.name = 'LookupError'; this.status = status; this.code = code || 'lookup'; }
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/** A sliding-window counter: take(key) is true while under `max`. */
function limiter(max, windowMs, now) {
  const hits = new Map();
  return {
    take(key) {
      const t = now();
      const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
      if (list.length >= max) { hits.set(key, list); return false; }
      list.push(t);
      if (hits.size > 10000) hits.clear();
      hits.set(key, list);
      return true;
    },
  };
}

/** The address a limit counts: IPv6 by its /64, like the lab's vote limiter. */
function ipKey(ip) {
  const s = String(ip || 'unknown');
  return s.includes(':') && !s.includes('.') ? s.split(':').slice(0, 4).join(':') : s;
}

/** The set's own registrants (current and prior CIKs): never "looked up". */
const SET = new Map();
for (const c of FILERS) { SET.set(c.cik, c.id); for (const p of c.priorCiks || []) SET.set(p.cik, c.id); }

/** The unit a company reports revenue in: the one with the most annual
 *  rows across the revenue tags (US dollars for every 10-K filer). */
function currencyOf(facts) {
  const count = {};
  for (const q of X.TAGS.revenue) {
    const [tax, tag] = q.split(':');
    const units = ((facts.facts[tax] || {})[tag] || {}).units || {};
    for (const [u, rows] of Object.entries(units)) if (/^[A-Z]{3}$/.test(u)) count[u] = (count[u] || 0) + rows.filter((r) => ANNUAL.includes(r.form)).length;
  }
  const best = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
  return best || 'USD';
}

function create({ store, now = Date.now, env = process.env } = {}) {
  const FRESH_MS = num(env.ASFILED_LOOKUP_FRESH_DAYS, 7) * 86400000;
  const perIp = limiter(num(env.ASFILED_LOOKUP_PER_IP_HOUR, 20), 3600000, now);
  const perDay = limiter(num(env.ASFILED_LOOKUP_PER_DAY, 300), 86400000, now);
  const searches = limiter(num(env.ASFILED_SEARCH_PER_IP_HOUR, 240), 3600000, now);

  /* ---------------- the registrant list ---------------- */

  let mem = null; let loading = null; let failedAt = 0;

  function parse(text, at) {
    const list = []; const byCik = new Map(); const byTicker = new Map();
    for (const line of text.split('\n')) {
      const [cik, ticker, title] = line.split('\t');
      const n = Number(cik);
      if (!n || !ticker || !title) continue;
      let e = byCik.get(n);
      if (!e) { e = { cik: n, ticker, title, tickers: [] }; byCik.set(n, e); list.push(e); }
      e.tickers.push(ticker);
      if (!byTicker.has(ticker)) byTicker.set(ticker, e);
    }
    return { at, list, byCik, byTicker, index: null };
  }
  async function stored() {
    try {
      const meta = await store.get('tickers', 'meta');
      if (!meta || !meta.parts || meta.v !== V) return null;
      const parts = await Promise.all(Array.from({ length: meta.parts }, (_, i) => store.get('tickers', `p${i}`)));
      if (parts.some((p) => !p || typeof p.text !== 'string')) return null;
      return { at: meta.at, text: parts.map((p) => p.text).join('') };
    } catch (e) { return null; }
  }
  async function loadTickers() {
    const have = await stored();
    if (have && now() - have.at < FRESH_MS) return (mem = parse(have.text, have.at));
    try {
      if (now() - failedAt < 60000) throw new sec.SecError('http');
      const raw = JSON.parse(await sec.get(TICKERS_URL, { maxBytes: 6 * MB }));
      const lines = [];
      for (const r of Object.values(raw)) {
        const cik = Number(r.cik_str); const ticker = String(r.ticker || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 12); const title = String(r.title || '').replace(/[\t\n\r]/g, ' ').trim().slice(0, 120);
        if (Number.isInteger(cik) && cik > 0 && ticker && title) lines.push(`${cik}\t${ticker}\t${title}`);
      }
      if (!lines.length) throw new sec.SecError('http');
      const text = lines.join('\n');
      // Stored in pieces: one Firestore document holds at most 1 MB.
      try {
        const size = 600000; const n = Math.ceil(text.length / size);
        for (let i = 0; i < n; i += 1) await store.set('tickers', `p${i}`, { text: text.slice(i * size, (i + 1) * size) });
        await store.set('tickers', 'meta', { v: V, at: now(), parts: n });
      } catch (e) { console.error('asfiled: registrant list not stored'); }
      return (mem = parse(text, now()));
    } catch (e) {
      if (!(e instanceof sec.SecError && e.code === 'no-agent')) failedAt = now();
      // An old list beats none: tickers change slowly.
      if (have) return (mem = parse(have.text, now() - FRESH_MS + 600000));
      if (mem) return mem;
      throw e;
    }
  }
  function tickers() {
    if (mem && now() - mem.at < FRESH_MS) return Promise.resolve(mem);
    if (!loading) loading = loadTickers().finally(() => { loading = null; });
    return loading;
  }

  /** Name or ticker -> up to eight registrants, best first. */
  async function resolve(query) {
    const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!q) return [];
    const t = await tickers();
    const out = []; const seen = new Set();
    const push = (e) => { if (e && !seen.has(e.cik) && out.length < 8) { seen.add(e.cik); out.push({ cik: e.cik, ticker: e.ticker, name: Names.display(e.title), inSet: SET.get(e.cik) || null }); } };
    push(t.byTicker.get(q.toUpperCase().replace(/\./g, '-')));
    if (/^\d{1,10}$/.test(q)) push(t.byCik.get(Number(q)));
    const low = q.toLowerCase();
    if (low.length >= 2) {
      for (const e of t.list) if (e.title.toLowerCase().startsWith(low)) push(e);
      if (low.length >= 3) for (const e of t.list) if (e.title.toLowerCase().includes(` ${low}`)) push(e);
    }
    return out;
  }

  /* ---------------- one company ---------------- */

  const building = new Map();          // cik -> the one build in flight
  let line = Promise.resolve();        // builds, one at a time
  const serial = (fn) => { const p = line.then(fn, fn); line = p.catch(() => {}); return p; };

  const secFail = (e) => {
    if (e instanceof LookupError) return e;
    if (e instanceof sec.SecError) {
      if (e.code === 'no-agent') return new LookupError(503, UNAVAILABLE, 'unavailable');
      if (e.code === 'too-large') return new LookupError(422, 'That company’s filings are too large to read here.', 'too-large');
      return new LookupError(502, 'sec.gov did not answer. Try again in a minute.', 'upstream');
    }
    console.error('asfiled: lookup failed:', e && e.name ? e.name : 'error');
    return new LookupError(500, 'That company could not be read.', 'failed');
  };

  async function build(entry) {
    const cik = entry.cik; const cik10 = sec.pad10(cik);
    let facts;
    try {
      facts = X.slimFacts(JSON.parse(await sec.get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`, { maxBytes: 64 * MB })));
    } catch (e) {
      if (e instanceof sec.SecError && e.code === 'not-found') throw new LookupError(422, 'That company has no tagged financial data on sec.gov.', 'no-facts');
      throw e;
    }
    const subs = JSON.parse(await sec.get(`https://data.sec.gov/submissions/CIK${cik10}.json`, { maxBytes: 16 * MB }));
    const r = (subs.filings && subs.filings.recent) || { form: [] };
    let a = null;
    for (let i = 0; i < r.form.length && !a; i += 1) {
      if (!ANNUAL.includes(r.form[i])) continue;
      a = { accn: r.accessionNumber[i], form: r.form[i], filed: r.filingDate[i], period: r.reportDate[i], doc: r.primaryDocument[i] };
    }
    if (!a || !ACCN.test(a.accn) || !FILE.test(String(a.doc)) || !/^\d{4}-\d\d-\d\d$/.test(a.period) || !/^\d{4}-\d\d-\d\d$/.test(a.filed)) {
      throw new LookupError(422, 'No annual report (Form 10-K or 20-F) is among that company’s recent filings.', 'no-annual');
    }
    // The report's own XBRL instance and labels: revenue mix and customer
    // concentration come from them. Missing or unreadable, those are simply
    // not shown - the annual figures do not depend on them.
    let inst = { facts: [] }; let labels = {};
    try {
      const items = JSON.parse(await sec.get(`https://www.sec.gov/Archives/edgar/data/${cik}/${sec.nodash(a.accn)}/index.json`, { maxBytes: 2 * MB })).directory.item.map((x) => String(x.name));
      const instName = items.find((n) => /_htm\.xml$/.test(n) && FILE.test(n));
      const labName = items.find((n) => /_lab\.xml$/.test(n) && FILE.test(n));
      if (instName) inst = { facts: X.parseInstance(await sec.get(sec.docUrl(cik, a.accn, instName), { maxBytes: 48 * MB })).facts };
      if (labName) labels = X.parseLabels(await sec.get(sec.docUrl(cik, a.accn, labName), { maxBytes: 16 * MB }));
    } catch (e) {
      if (e instanceof sec.SecError && e.code === 'no-agent') throw e;
      inst = { facts: [] }; labels = {};
    }
    const legal = String(subs.name || entry.title).slice(0, 120);
    const id = `X${cik}`;
    const c = { id, cik, name: Names.display(legal), legal, layer: 'lookup', form: a.form, sic: subs.sic };
    const data = { figures: {}, filings: {}, mixes: {}, concentration: {}, companies: [], edges: [], fin: {}, quotes: {} };
    try {
      B.addCompany(data, c, a, { facts: [{ cik, facts }], inst, labels, currency: currencyOf(facts) });
    } catch (e) {
      throw new LookupError(422, 'That company’s tagged figures could not be read into fiscal years.', 'unreadable');
    }
    const co = data.companies[0];
    if (!co.years.length || !Core.fig(data, id, 'revenue', co.latest)) throw new LookupError(422, 'That company’s filings carry no tagged annual revenue this app reads.', 'no-revenue');
    co.lookup = true; co.ticker = entry.ticker;
    co.spark = co.years.map((fy) => { const f = Core.fig(data, id, 'revenue', fy); return f ? f.v : null; });
    const insights = Core.companyInsights(data, co).filter((s) => B.citedOnly(data, s));
    const src = { kind: 'annual-report', by: id, form: a.form, period: a.period, date: a.filed, accn: a.accn, title: `${c.name} ${a.form} for the fiscal year ended ${a.period}`, url: sec.docUrl(cik, a.accn, a.doc) };
    return {
      v: V, id, cik, ticker: entry.ticker, label: LABEL, company: co,
      figures: data.figures, filings: data.filings, mixes: data.mixes, concentration: data.concentration,
      insights: { [id]: insights }, finsights: { [id]: Core.finInsights(data, co).filter((s) => B.citedOnly(data, s)) }, fin: { [id]: data.fin[id] || {} },
      sources: { [co.annual.source]: src },
    };
  }

  /** The stored part for a CIK, whatever its age: {part, at} or null. */
  async function read(cik) {
    try {
      const doc = await store.get('lookups', String(cik));
      if (doc && doc.v === V && typeof doc.json === 'string') return { part: JSON.parse(doc.json), at: doc.at };
    } catch (e) { /* treated as not stored */ }
    return null;
  }

  /** One company by CIK: {inSet} for one of the reviewed set, else {part,
   *  at, cached}. Throws LookupError (404, 422, 429, 502, 503). */
  async function company(cikIn, { ip } = {}) {
    const cik = Number(cikIn);
    if (!Number.isInteger(cik) || cik <= 0 || cik > 9999999999) throw new LookupError(404, 'No such company.', 'not-found');
    if (SET.has(cik)) return { inSet: SET.get(cik) };
    const have = await read(cik);
    if (have && now() - have.at < FRESH_MS) return { ...have, cached: true };
    if (!sec.available()) {
      if (have) return { ...have, cached: true, stale: true };
      throw new LookupError(503, UNAVAILABLE, 'unavailable');
    }
    if (building.has(cik)) return building.get(cik);
    let entry;
    try { entry = (await tickers()).byCik.get(cik); } catch (e) { throw secFail(e); }
    if (!entry) throw new LookupError(404, 'No SEC registrant with a listed ticker has that number.', 'not-found');
    if (!perIp.take(ipKey(ip))) throw new LookupError(429, 'That is a lot of lookups from one place - try again in an hour.', 'limit-ip');
    if (!perDay.take('all')) throw new LookupError(429, 'Lookups have reached today’s limit. Companies already looked up still open.', 'limit-day');
    const p = serial(() => build(entry)).then(async (part) => {
      const at = now();
      const json = JSON.stringify(part);
      if (json.length < 900000) { try { await store.set('lookups', String(cik), { v: V, at, cik, json }); } catch (e) { console.error('asfiled: lookup not stored'); } }
      return { part, at, cached: false };
    }).catch((e) => {
      if (have) return { ...have, cached: true, stale: true };
      throw secFail(e);
    }).finally(() => building.delete(cik));
    building.set(cik, p);
    return p;
  }

  /* ---------------- the second reading: what needs the documents ----------------
   * Employees (one sentence of the latest annual report), risk factors (that
   * report beside the one before), pay (the latest proxy statement's tagged
   * table) and insider transactions (the latest Form 4s). Read when a visitor
   * asks, by the build's own functions and the same verifier; no model. The
   * reports are held in memory one at a time and never stored. */

  const moreBuilding = new Map();

  async function buildMore(part) {
    const co = part.company; const id = part.id; const cik = part.cik;
    const today = new Date(now()).toISOString().slice(0, 10);
    const subs = JSON.parse(await sec.get(`https://data.sec.gov/submissions/CIK${sec.pad10(cik)}.json`, { maxBytes: 16 * MB }));
    const r = (subs.filings && subs.filings.recent) || { form: [] };
    const annual = [];
    for (let i = 0; i < r.form.length && annual.length < 2; i += 1) {
      if (r.form[i] !== co.form) continue;
      const a = { accn: r.accessionNumber[i], form: r.form[i], filed: r.filingDate[i], period: r.reportDate[i], doc: r.primaryDocument[i] };
      if (ACCN.test(a.accn) && FILE.test(String(a.doc))) annual.push(a);
    }
    const cur = annual[0] && annual[0].accn === co.annual.accn ? annual[0] : null;
    if (!cur) throw new LookupError(409, 'This company has filed a newer annual report. Open it again to read that one.', 'stale');
    const prior = annual[1] || null;
    const curId = co.annual.source;
    const data = { figures: {}, filings: {}, sources: {}, quotes: {}, fin: { [id]: {} } };
    const rawTexts = {}; const texts = {};
    const report = async (a) => T.htmlToText(await sec.get(sec.docUrl(cik, a.accn, a.doc), { maxBytes: 40 * MB, timeoutMs: 45000 }));
    rawTexts[curId] = await report(cur);
    texts[curId] = T.norm(rawTexts[curId]);
    data.sources[curId] = { ...part.sources[curId], sha: T.sha(texts[curId]) };
    const qctx = { sources: data.sources, texts, rawTexts, sectionsOf: {}, ranges: {} };
    // Employees: proposed by the strict rule, decided by the verifier.
    const found = People.findEmployees(rawTexts[curId]);
    if (found) {
      const q = { c: id, kind: 'employees', n: found.n, quote: found.quote, source: curId };
      const res = Verify.checkQuote(q, qctx);
      if (res.ok) data.quotes[`${id}.q.employees`] = { ...q, section: res.section, date: cur.filed, proof: Verify.proof(data.sources[curId].sha, found.quote) };
    }
    // Risk factors: this report beside the one before.
    if (prior) {
      try { rawTexts[`${id}-${prior.accn}`] = await report(prior); } catch (e) { if (e instanceof sec.SecError && e.code === 'no-agent') throw e; }
    }
    const dropped = { quotes: 0, dropped: [] };
    data.fin[id].risks = B.riskChanges(data, { id, cik, name: co.name }, cur, prior, { texts, rawTexts, qctx, report: dropped });
    delete rawTexts[curId]; if (prior) delete rawTexts[`${id}-${prior.accn}`];
    // Pay: the latest proxy statement's own tagged table.
    try { B.payFigures(data, { id }, await Proxy.read(cik, subs, today, (url, o) => sec.get(url, o))); } catch (e) { if (e instanceof sec.SecError && e.code === 'no-agent') throw e; }
    // Insiders: the latest Form 4s (at most FORM4_MAX of the last twelve months').
    const listed = Insiders.listForm4(subs, today);
    const rec = await Insiders.collect(cik, listed, (url) => sec.get(url, { maxBytes: 4 * MB }), { max: FORM4_MAX });
    if (listed.list.length > FORM4_MAX) rec.capped = FORM4_MAX;
    data.fin[id].insiders = Insiders.compact(rec);
    // The sentences again, now that the quotes and pay figures are there.
    const all = { figures: { ...part.figures, ...data.figures }, filings: { ...part.filings, ...data.filings }, mixes: part.mixes, concentration: part.concentration, quotes: data.quotes, fin: data.fin, companies: [co], others: [], edges: [] };
    const finsights = Core.finInsights(all, co).filter((s) => B.citedOnly(all, s));
    for (const k of Object.keys(data.sources)) if (k !== curId && data.sources[k].kind !== 'prior-annual-report') delete data.sources[k];
    return { v: MORE_V, id, cik, accn: cur.accn, figures: data.figures, filings: data.filings, quotes: data.quotes, sources: data.sources, fin: data.fin, finsights: { [id]: finsights } };
  }

  /** The stored second reading for a CIK, if it is of this annual report. */
  async function readMore(cik, accn) {
    try {
      const doc = await store.get('more', String(cik));
      if (doc && doc.v === MORE_V && doc.accn === accn && typeof doc.json === 'string') return { ...JSON.parse(doc.json), at: new Date(doc.at).toISOString() };
    } catch (e) { /* treated as not stored */ }
    return null;
  }

  /** Read it now (or return the stored one). Counts as a lookup for the limits. */
  async function more(cikIn, { ip } = {}) {
    const cik = Number(cikIn);
    const have = Number.isInteger(cik) && cik > 0 ? await read(cik) : null;
    if (!have) throw new LookupError(404, 'Look the company up first.', 'not-found');
    const stored = await readMore(cik, have.part.company.annual.accn);
    if (stored && now() - Date.parse(stored.at) < FRESH_MS) return stored;
    if (!sec.available()) { if (stored) return stored; throw new LookupError(503, UNAVAILABLE, 'unavailable'); }
    if (moreBuilding.has(cik)) return moreBuilding.get(cik);
    if (!perIp.take(ipKey(ip))) throw new LookupError(429, 'That is a lot of lookups from one place - try again in an hour.', 'limit-ip');
    if (!perDay.take('all')) throw new LookupError(429, 'Lookups have reached today’s limit. Companies already looked up still open.', 'limit-day');
    const p = serial(() => buildMore(have.part)).then(async (out) => {
      const at = now(); const json = JSON.stringify(out);
      if (json.length < 900000) { try { await store.set('more', String(cik), { v: MORE_V, at, cik, accn: out.accn, json }); } catch (e) { console.error('asfiled: second reading not stored'); } }
      return { ...out, at: new Date(at).toISOString() };
    }).catch((e) => { if (stored) return stored; throw secFail(e); }).finally(() => moreBuilding.delete(cik));
    moreBuilding.set(cik, p);
    return p;
  }

  return { company, resolve, tickers, read, more, readMore, secFail, searches, ipKey, FRESH_MS };
}

module.exports = { create, LookupError, LABEL, UNAVAILABLE, SET, V, MORE_V, FORM4_MAX, ipKey, currencyOf };
