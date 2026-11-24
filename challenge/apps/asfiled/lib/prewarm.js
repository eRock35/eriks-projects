// The owner's batch: "Prepare likely lookups".
//
// Erik asked (2026-11-24) for the companies people are most likely to look
// up to be ready before anyone opens them. This walks a list and, for each
// company, does exactly what a visitor's two taps would do - by the same
// code, nothing of its own:
//
//   1. lib/lookup.js `company`: the stored part (figures; no model), built
//      or refreshed from sec.gov;
//   2. lib/relations.js `find`, only when nothing is stored for that
//      company's latest annual report: Claude picks sentences, and the
//      build's verifier decides which quotes stand.
//
// It decides nothing about what is shown. It holds no model call and makes
// no request of its own: the server passes `relate(cik)`, which is the
// member route's own gates and call. One company at a time, a few a request,
// inside the request - no timer, nothing after the answer.

const { LookupError, SET } = require('./lookup');

// Likely lookups outside the reviewed 81 (credit bureaus, payments, market
// data, exchanges, payroll, travel, consumer names). FICO and INTU were on
// Erik's list and are left out: both are in the reviewed set already. An
// entry may give a second ticker to try when the first is not listed.
const DEFAULT = [
  'EFX', 'TRU', 'V', 'MA', 'PYPL', 'AXP', 'COF', ['FI', 'FISV'], 'FIS', 'GPN',
  'SPGI', 'MCO', 'MSCI', 'BR', 'VRSK', 'TRV', 'CME', 'ICE', 'NDAQ',
  'ADP', 'PAYX', 'BKNG', 'ABNB', 'UBER', 'NFLX', 'DIS', 'TSLA', 'COST',
];
const PER_CALL = 3;                  // companies a request, unless asked
const PER_CALL_MAX = 5;
const MAX_CIKS = 40;                 // a list sent in the body
// Codes that end the request rather than one company: the next company
// would meet the same answer.
const STOP = new Set(['unavailable', 'limit-day']);
const AI_FAILED = 'The relationships could not be read just now. Nothing was added.';

const cikOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 9999999999 ? n : null; };

function create({ lookup, relations, list = DEFAULT, now = Date.now } = {}) {
  /** The companies to prepare: {list: [{cik, ticker}], skipped: [...]}.
   *  A company of the reviewed set, or one the SEC's list does not hold, is
   *  skipped and said. */
  async function targets(ciks) {
    const t = await lookup.tickers();
    const out = []; const skipped = []; const seen = new Set();
    const take = (e, asked) => {
      if (!e) { skipped.push({ ...asked, code: 'not-found', error: 'Not in the SEC’s list of registrants with a ticker.' }); return; }
      if (seen.has(e.cik)) return;
      seen.add(e.cik);
      if (SET.has(e.cik)) { skipped.push({ cik: e.cik, ticker: e.ticker, code: 'in-set', error: 'In the reviewed set already.' }); return; }
      out.push({ cik: e.cik, ticker: e.ticker });
    };
    if (Array.isArray(ciks) && ciks.length) {
      for (const v of ciks.slice(0, MAX_CIKS)) { const cik = cikOf(v); if (cik) take(t.byCik.get(cik), { cik }); }
    } else {
      for (const item of list) {
        const names = [].concat(item).map((x) => String(x).toUpperCase());
        take(names.map((x) => t.byTicker.get(x)).find(Boolean), { ticker: names[0] });
      }
    }
    return { list: out, skipped };
  }

  /** Whether one company is ready: its part stored and fresh, and relations
   *  stored for that part's annual report. Reads the store only. */
  async function stateOf(cik) {
    const have = await lookup.read(cik);
    if (!have || now() - have.at >= lookup.FRESH_MS) return { ready: false, edges: 0 };
    const rel = await relations.read(cik, have.part.company.annual.accn);
    return { ready: Boolean(rel), edges: rel ? rel.edges.length : 0 };
  }

  async function survey(ciks, skip = []) {
    const t = await targets(ciks);
    const skipSet = new Set((Array.isArray(skip) ? skip : []).map(cikOf).filter(Boolean));
    const rows = [];
    for (const x of t.list) rows.push({ ...x, ...(await stateOf(x.cik)), set: skipSet.has(x.cik) });
    return { rows, skipped: t.skipped };
  }
  const summary = (rows) => ({
    total: rows.length,
    ready: rows.filter((r) => r.ready).length,
    edges: rows.reduce((n, r) => n + r.edges, 0),
    remaining: rows.filter((r) => !r.ready && !r.set).length,
  });

  /** Where the list stands; nothing is fetched or asked. */
  async function status({ ciks, skip } = {}) {
    const s = await survey(ciks, skip);
    return { ...summary(s.rows), skipped: s.skipped };
  }

  /** Prepare up to `limit` companies that are not ready (and not in `skip`,
   *  the ones the caller already saw fail). `relate(cik)` resolves
   *  {relations} or {refused: {status, code, message}} (the AI guard said
   *  no: the batch stops there) and rejects when the model call failed. No
   *  company is started at or after `deadline`. */
  async function run({ ciks, skip, limit, ip, deadline = Infinity, relate } = {}) {
    const max = Math.min(PER_CALL_MAX, Math.max(1, Math.floor(Number(limit)) || PER_CALL));
    const s = await survey(ciks, skip);
    const done = []; const skipped = s.skipped.slice(); let stopped = null;
    for (const row of s.rows) {
      if (row.ready || row.set) continue;
      if (done.length + skipped.length - s.skipped.length >= max || now() >= deadline) break;
      try {
        const got = await lookup.company(row.cik, { ip, noIpLimit: true });
        let rel = await relations.read(row.cik, got.part.company.annual.accn);
        if (!rel) {
          let r;
          try { r = await relate(row.cik); } catch (e) {
            if (e instanceof LookupError) throw e;
            throw new LookupError(502, AI_FAILED, 'ai');
          }
          if (r && r.refused) { stopped = { code: r.refused.code || 'refused', error: r.refused.message || AI_FAILED }; break; }
          rel = r.relations;
        }
        row.ready = true; row.edges = rel.edges.length;
        done.push({ cik: row.cik, ticker: row.ticker, edges: row.edges });
      } catch (e) {
        const err = lookup.secFail(e);
        if (STOP.has(err.code)) { stopped = { code: err.code, error: err.message }; break; }
        row.set = true;
        skipped.push({ cik: row.cik, ticker: row.ticker, code: err.code, error: err.message });
      }
    }
    return { done, skipped, ...summary(s.rows), ...(stopped ? { stopped } : {}) };
  }

  return { targets, status, run };
}

module.exports = { create, DEFAULT, PER_CALL, PER_CALL_MAX, MAX_CIKS };
