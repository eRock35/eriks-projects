// Polite access to sec.gov, shared by the tools.
//
// THE USER-AGENT COMES FROM THE ENVIRONMENT AND IS NEVER WRITTEN ANYWHERE.
// The SEC asks every automated client to identify itself; that identity
// holds a contact address, so it lives outside the repo (SEC_USER_AGENT)
// and these tools refuse to run without it. Nothing here logs it.
//
// Two callers. The build tools (`cached`) write raw downloads to a cache
// outside the repo and stop the process when the variable is missing. The
// running app (`get`, for a company looked up on request - lib/lookup.js)
// keeps nothing on disk, and a missing variable is an error the route turns
// into "Lookups are not available right now", never an exit.
//
// Raw downloads are cached outside the repo (FILINGS_CACHE, default
// ~/.cache/filings). Only the derived dataset is ever committed.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE = process.env.FILINGS_CACHE || path.join(os.homedir(), '.cache', 'filings');
// Under 4 requests a second (the SEC's limit is 10). SEC_GAP_MS can only
// slow it further (two tools running side by side each take half).
const GAP_MS = Math.max(260, Number(process.env.SEC_GAP_MS) || 0);
let last = 0;

function agent() {
  const ua = String(process.env.SEC_USER_AGENT || '').trim();
  if (!ua) {
    console.error('SEC_USER_AGENT is not set. The SEC requires a declared User-Agent; set it in the environment (never in a file in this repo).');
    process.exit(2);
  }
  return ua;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET a URL into the cache (once), returning the cache path. */
async function cached(url, rel, { binary = false, headers = {} } = {}) {
  const file = path.join(CACHE, rel);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  const isSec = /(^|\.)sec\.gov$/.test(new URL(url).hostname);
  const h = { 'Accept-Encoding': 'gzip, deflate', ...headers };
  if (isSec) h['User-Agent'] = agent(); else h['User-Agent'] = 'Mozilla/5.0 (compatible; research-fetch)';
  for (let attempt = 0; ; attempt += 1) {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetch(url, { headers: h, redirect: 'follow' });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, binary ? buf : buf.toString('utf8'));
      return file;
    }
    if (attempt >= 3 || ![429, 500, 502, 503].includes(res.status)) throw new Error(`GET ${new URL(url).hostname}${new URL(url).pathname} -> ${res.status}`);
    await sleep(2000 * (attempt + 1));
  }
}

const pad10 = (cik) => String(cik).padStart(10, '0');
const nodash = (accn) => String(accn).replace(/-/g, '');
const filingIndexUrl = (cik, accn) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${nodash(accn)}/${accn}-index.htm`;
const docUrl = (cik, accn, file) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${nodash(accn)}/${file}`;


/* ------------------------------------------------------------------ *
 * Run time: one GET, in memory
 * ------------------------------------------------------------------ */

class SecError extends Error {
  constructor(code, status) { super(`sec: ${code}${status ? ` ${status}` : ''}`); this.name = 'SecError'; this.code = code; this.status = status || 0; }
}

// ASFILED_FAKE_SEC=<dir> answers every request from files under that
// directory (<dir>/<host>/<path>), for tests and a laptop. Like the other
// local switches it is refused on Cloud Run.
const FAKE = String(process.env.ASFILED_FAKE_SEC || '');
if (FAKE && process.env.K_SERVICE) throw new Error('ASFILED_FAKE_SEC is for local use only and is refused on Cloud Run.');

const stats = { requests: 0 };          // how many requests left this process (tests read it)
const inflight = new Map();             // url -> the one request in flight for it
let queue = Promise.resolve();          // request starts, one at a time, GAP_MS apart

/** Whether the declared User-Agent is there. Its value is never returned. */
const available = () => Boolean(String(process.env.SEC_USER_AGENT || '').trim());

function turn() {
  const mine = queue.then(async () => {
    const wait = last + (FAKE ? 0 : GAP_MS) - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  });
  queue = mine.catch(() => {});
  return mine;
}

async function body(res, maxBytes) {
  if (Number(res.headers.get('content-length')) > maxBytes) throw new SecError('too-large');
  const chunks = []; let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) throw new SecError('too-large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** GET one sec.gov document as text. Only www.sec.gov and data.sec.gov;
 *  under four requests a second across the process; two callers asking for
 *  the same URL share one request; nothing is written anywhere and nothing
 *  is logged. Throws SecError: `no-agent` (the variable is missing),
 *  `not-found`, `too-large`, `timeout`, `http`. */
function get(url, { maxBytes = 8 * 1024 * 1024, timeoutMs = 25000 } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !/^(www|data)\.sec\.gov$/.test(u.hostname) || u.username || u.port) return Promise.reject(new SecError('host'));
  if (!available()) return Promise.reject(new SecError('no-agent'));
  if (inflight.has(u.href)) return inflight.get(u.href);
  const p = (async () => {
    for (let attempt = 0; ; attempt += 1) {
      await turn();
      stats.requests += 1;
      if (FAKE) {
        const file = path.join(FAKE, u.hostname, path.normalize(decodeURIComponent(u.pathname)));
        if (!file.startsWith(path.join(FAKE, u.hostname) + path.sep) || !fs.existsSync(file)) throw new SecError('not-found', 404);
        if (fs.statSync(file).size > maxBytes) throw new SecError('too-large');
        return fs.readFileSync(file, 'utf8');
      }
      let res;
      try {
        res = await fetch(u.href, { headers: { 'User-Agent': String(process.env.SEC_USER_AGENT).trim(), 'Accept-Encoding': 'gzip, deflate' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
        if (res.ok) return await body(res, maxBytes);
      } catch (e) {
        if (e instanceof SecError) throw e;
        throw new SecError(e && e.name === 'TimeoutError' ? 'timeout' : 'http');
      }
      if (res.status === 404) throw new SecError('not-found', 404);
      if (attempt >= 1 || ![429, 500, 502, 503].includes(res.status)) throw new SecError('http', res.status);
      await sleep(1500);
    }
  })().finally(() => inflight.delete(u.href));
  inflight.set(u.href, p);
  return p;
}

module.exports = { CACHE, cached, pad10, nodash, filingIndexUrl, docUrl, agent, get, available, stats, SecError };
