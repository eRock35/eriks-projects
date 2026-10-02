// Reading a Hopscotch crawl share link into a poll option.
//
// Hopscotch (the portfolio's beer passport, eRock35/beer-app) lets anyone
// share a planned crawl as https://beer.strongtechnicalconsulting.com/c/<id>,
// and serves its public data at GET /api/shared-crawl/<id>: a title, a city,
// the stops' names, the distance and a first name. That public endpoint is
// the ONLY thing Flight reads from Hopscotch - never its database, never
// anyone's passport or journal.
//
// The fetch is the server's, so it is fenced in:
//   - https only, the one Hopscotch host only (FLIGHT_HOPSCOTCH_HOST, default
//     beer.strongtechnicalconsulting.com), no port, no userinfo, the path
//     /c/<id> with Hopscotch's own id pattern. Anything else - http, another
//     host, an IP, a look-alike - is never fetched.
//   - redirects are refused (redirect: 'manual'; a 3xx is a failure), so the
//     allowlist cannot be walked around by a hop.
//   - a 4-second timeout and a 64 KB cap on what is read.
// On any failure the option simply keeps the text that was typed.

const Core = require('../public/flight-core');

const HOST = () => String(process.env.FLIGHT_HOPSCOTCH_HOST || 'beer.strongtechnicalconsulting.com').toLowerCase();
const TIMEOUT_MS = 4000;
let timeoutMs = TIMEOUT_MS;
const MAX_BYTES = 64 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,60}$/;

let fetcher = (...a) => globalThis.fetch(...a);
/** Tests only: put a stand-in where the network would be. */
function _setFetch(f, ms) { fetcher = f || ((...a) => globalThis.fetch(...a)); timeoutMs = ms || TIMEOUT_MS; }

/** The share id from a pasted link, or null if it is not a Hopscotch crawl
 *  link on the allowed host. Nothing is fetched to decide this. */
function shareIdFrom(text) {
  const s = String(text || '').trim();
  const m = /https?:\/\/\S+/i.exec(s);
  if (!m) return null;
  let u;
  try { u = new URL(m[0]); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.port) return null;
  if (u.hostname.toLowerCase() !== HOST()) return null;
  const p = /^\/c\/([^/]+)\/?$/.exec(u.pathname);
  if (!p || !ID_RE.test(p[1])) return null;
  return p[1];
}

/** Read up to MAX_BYTES of a response body, then stop. */
async function readCapped(res) {
  const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BYTES) throw new Error('too large');
  if (!res.body || !res.body.getReader) {
    const t = await res.text();
    if (t.length > MAX_BYTES) throw new Error('too large');
    return t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BYTES) { try { await reader.cancel(); } catch (e) { /* gone */ } throw new Error('too large'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Hopscotch's answer, cleaned to what a poll option shows. Nothing from it
 *  is trusted: every string is bounded and stripped, numbers range-checked. */
function cleanCrawl(raw, id) {
  const c = raw && typeof raw === 'object' && raw.crawl && typeof raw.crawl === 'object' ? raw.crawl : null;
  if (!c) return null;
  const title = Core.clean(c.title, 60);
  const stops = (Array.isArray(c.stops) ? c.stops : []).slice(0, 12)
    .map((s) => Core.clean(s && typeof s === 'object' ? s.name : '', 50)).filter(Boolean);
  if (!title && !stops.length) return null;
  const miles = typeof c.totalMiles === 'number' && Number.isFinite(c.totalMiles) && c.totalMiles >= 0 && c.totalMiles < 1000 ? Math.round(c.totalMiles * 10) / 10 : null;
  return {
    title: title || 'A crawl',
    place: [Core.clean(c.city, 40), Core.clean(c.state, 30)].filter(Boolean).join(', '),
    stops,
    miles,
    by: Core.clean(c.by, 20),
    url: `https://${HOST()}/c/${id}`,
  };
}

/** {crawl} on success, or null on any failure - the caller keeps the text. */
async function readCrawl(text) {
  const id = shareIdFrom(text);
  if (!id) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetcher(`https://${HOST()}/api/shared-crawl/${encodeURIComponent(id)}`, {
      redirect: 'manual',
      signal: ctl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'Flight (Challenge Lab) poll option reader' },
    });
    if (!res || res.status !== 200 || res.redirected) return null;
    const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
    if (!/application\/json/i.test(type)) return null;
    const body = await readCapped(res);
    return cleanCrawl(JSON.parse(body), id);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { shareIdFrom, readCrawl, cleanCrawl, _setFetch, HOST, TIMEOUT_MS, MAX_BYTES };
