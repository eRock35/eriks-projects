// Polite access to sec.gov, shared by the tools.
//
// THE USER-AGENT COMES FROM THE ENVIRONMENT AND IS NEVER WRITTEN ANYWHERE.
// The SEC asks every automated client to identify itself; that identity
// holds a contact address, so it lives outside the repo (SEC_USER_AGENT)
// and these tools refuse to run without it. Nothing here logs it.
//
// Raw downloads are cached outside the repo (FILINGS_CACHE, default
// ~/.cache/filings). Only the derived dataset is ever committed.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE = process.env.FILINGS_CACHE || path.join(os.homedir(), '.cache', 'filings');
const GAP_MS = 260;                    // under 4 requests a second (the SEC's limit is 10)
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

module.exports = { CACHE, cached, pad10, nodash, filingIndexUrl, docUrl, agent };
