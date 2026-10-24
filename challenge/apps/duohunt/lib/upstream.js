// The one way Duo Hunt talks to anyone else. Every upstream request goes
// through `createSource()`:
//
//   - a five-minute cache per key (Apple: part + ZIP; Best Buy: the search,
//     and SKU + ZIP for stores), so a crowd tapping "Check now" costs the
//     upstream one request per key per five minutes;
//   - one shared in-flight request per key: ten taps at once are one fetch;
//   - a cap on real fetches per instance per window (a cache hit is free);
//   - a 6 s timeout, an identifying User-Agent, a bounded body;
//   - an allow-list of hosts. AT&T, Verizon and T-Mobile are not on it and
//     never will be: they have no public stock API and heavy bot protection,
//     so the page links to them instead (tested by intercepting fetch).
//
// Nothing is logged but the source name and a reason word ("timeout",
// "http 503", "parse"): a URL here carries a ZIP, and Best Buy's carries the
// API key. Billed per request: nothing here runs after a response - a fetch
// is always awaited inside the request that asked for it.

const USER_AGENT = 'DuoHunt/1.0 (+https://challenge.strongtechnicalconsulting.com/duohunt/; one stock check per person’s tap)';
const ALLOWED_HOSTS = new Set(['www.apple.com', 'api.bestbuy.com']);
const MAX_BODY = 2 * 1024 * 1024;

class UpstreamError extends Error {
  constructor(reason, status) { super(reason); this.reason = reason; this.status = status || null; }
}

/** GET a JSON document with a timeout. `fetchImpl` is read per call so a
 *  test (or the fake upstream) can stand in for the network. */
async function getJson(url, { fetchImpl, timeoutMs = 6000, headers = {} } = {}) {
  let host;
  try { host = new URL(url).host; } catch { throw new UpstreamError('bad url'); }
  if (!ALLOWED_HOSTS.has(host)) throw new UpstreamError('host not allowed');
  const f = fetchImpl || globalThis.fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
      signal: ctl.signal,
      redirect: 'error',
    });
    if (!res || !res.ok) throw new UpstreamError(`http ${res ? res.status : 0}`, res ? res.status : 0);
    const text = await res.text();
    if (text.length > MAX_BODY) throw new UpstreamError('too big');
    try { return JSON.parse(text); } catch { throw new UpstreamError('parse'); }
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    if (ctl.signal.aborted) throw new UpstreamError('timeout');
    throw new UpstreamError('network');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A cached, de-duplicated, capped source.
 * `load(key)` does the real work and returns a value (or throws).
 * `get(key)` -> {value, cached, at}; throws UpstreamError('busy') at the cap.
 */
function createSource({ name, ttlMs = 5 * 60 * 1000, errorTtlMs = 60 * 1000, capPerWindow = 300, windowMs = 10 * 60 * 1000, now = () => Date.now(), maxKeys = 5000 }) {
  const cache = new Map(); // key -> {at, value} | {at, error}
  const inflight = new Map(); // key -> Promise
  let window = { since: now(), n: 0 };
  let fetches = 0;

  function fresh(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    const age = now() - hit.at;
    if (hit.error ? age < errorTtlMs : age < ttlMs) return hit;
    cache.delete(key);
    return null;
  }

  async function get(key, load) {
    const hit = fresh(key);
    if (hit) {
      if (hit.error) throw hit.error;
      return { value: hit.value, cached: true, at: hit.at };
    }
    if (inflight.has(key)) return inflight.get(key);
    const t = now();
    if (t - window.since > windowMs) window = { since: t, n: 0 };
    if (window.n >= capPerWindow) throw new UpstreamError('busy');
    window.n++;
    fetches++;
    const p = (async () => {
      try {
        const value = await load(key);
        const at = now();
        cache.set(key, { at, value });
        return { value, cached: false, at };
      } catch (err) {
        const e = err instanceof UpstreamError ? err : new UpstreamError('parse');
        // A failure is remembered briefly, so a broken upstream is not asked
        // again by every tap - but not for the full five minutes.
        cache.set(key, { at: now(), error: e });
        console.warn(`[duohunt] ${name} check failed: ${e.reason}`);
        throw e;
      } finally {
        inflight.delete(key);
        if (cache.size > maxKeys) cache.delete(cache.keys().next().value);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  return {
    name, get,
    /** Tests only. */
    _reset() { cache.clear(); inflight.clear(); window = { since: now(), n: 0 }; fetches = 0; },
    get fetches() { return fetches; },
  };
}

module.exports = { getJson, createSource, UpstreamError, USER_AGENT, ALLOWED_HOSTS };
