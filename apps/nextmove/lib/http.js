// A polite HTTP client for every public source this app reads.
//
// Career boards, SEC EDGAR, GDELT, the Department of Labor and BLS are all
// free public services run by someone else. So, for every request:
//   - an identifying User-Agent (SEC and BLS require contact details in it;
//     see sec.js - that one is never hardcoded);
//   - a concurrency limit across the process and a minimum gap between two
//     requests to the same host (GDELT asks for one every five seconds);
//   - a timeout, and a size ceiling on what is read;
//   - retries with exponential backoff on 429 / 5xx / network errors only,
//     honouring Retry-After. A 4xx is an answer, not a flake.
//
// `fetch` is injectable so tests run with no network at all.

const DEFAULT_UA = 'NextMove/1.0 (+https://nextmove.strongtechnicalconsulting.com; career postings reader)';

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

function create(opts = {}) {
  const fetchImpl = opts.fetch || ((...a) => globalThis.fetch(...a));
  const concurrency = Math.max(1, opts.concurrency || 4);
  const hostGapMs = opts.hostGapMs === undefined ? 250 : opts.hostGapMs;
  const hostGaps = opts.hostGaps || {};       // host -> ms, overriding hostGapMs
  const timeoutMs = opts.timeoutMs || 20000;
  const retries = opts.retries === undefined ? 2 : opts.retries;
  const backoffMs = opts.backoffMs === undefined ? 1000 : opts.backoffMs;
  const userAgent = opts.userAgent || DEFAULT_UA;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now || (() => Date.now());

  let active = 0;
  const waiting = [];
  const nextAt = new Map(); // host -> earliest time the next request may start
  let requests = 0;

  async function slot() {
    if (active < concurrency) { active++; return; }
    await new Promise((r) => waiting.push(r));
    active++;
  }
  function release() {
    active--;
    const w = waiting.shift();
    if (w) w();
  }
  async function hostTurn(host) {
    const gap = hostGaps[host] !== undefined ? hostGaps[host] : hostGapMs;
    if (!gap) return;
    const t = now();
    const at = Math.max(t, nextAt.get(host) || 0);
    nextAt.set(host, at + gap);
    if (at > t) await sleep(at - t);
  }

  async function readCapped(res, maxBytes) {
    const len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
    if (len && len > maxBytes) throw httpError(413, `response too large (${len} bytes)`);
    if (!res.body || !res.body.getReader) {
      const text = await res.text();
      if (Buffer.byteLength(text) > maxBytes) throw httpError(413, 'response too large');
      return text;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch (e) { /* ignore */ }
        throw httpError(413, 'response too large');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * GET (or other) a URL; resolves {status, text, headers}. Throws on network
   * failure after retries, and on a status listed in `opts.throwOn` (default
   * every non-2xx except 404, which callers often treat as "no such board").
   */
  async function request(url, o = {}) {
    const u = new URL(url);
    const maxBytes = o.maxBytes || 15 * 1024 * 1024;
    const headers = { 'User-Agent': o.userAgent || userAgent, Accept: o.accept || 'application/json', ...(o.headers || {}) };
    let attempt = 0;
    for (;;) {
      await slot();
      let res;
      let err = null;
      try {
        await hostTurn(u.host);
        requests++;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), o.timeoutMs || timeoutMs);
        try {
          res = await fetchImpl(url, { method: o.method || 'GET', headers, body: o.body, signal: ctl.signal, redirect: 'follow' });
          const text = o.stream ? null : await readCapped(res, maxBytes);
          clearTimeout(timer);
          if (o.stream) return { status: res.status, res, headers: res.headers };
          if ((res.status === 429 || res.status >= 500) && attempt < retries) {
            err = httpError(res.status, `upstream ${res.status}`);
            err.retryAfter = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : 0) || 0;
          } else {
            return { status: res.status, text, headers: res.headers };
          }
        } finally { clearTimeout(timer); }
      } catch (e) {
        if (e && e.status === 413) throw e;
        err = e && e.name === 'AbortError' ? httpError(504, 'timed out') : (e.status ? e : httpError(0, `network: ${e && e.message ? e.message.slice(0, 120) : 'error'}`));
        if (attempt >= retries) throw err;
      } finally { release(); }
      attempt++;
      const wait = Math.min(30000, (err && err.retryAfter ? err.retryAfter * 1000 : backoffMs * 2 ** (attempt - 1)));
      await sleep(wait);
    }
  }

  /** GET JSON. null on 404 (and on `o.nullOn` statuses); throws on other non-2xx. */
  async function json(url, o = {}) {
    const r = await request(url, o);
    if (r.status === 404 || (o.nullOn || []).includes(r.status)) return null;
    if (r.status < 200 || r.status >= 300) throw httpError(r.status, `${new URL(url).host} answered ${r.status}`);
    try { return JSON.parse(r.text); } catch (e) { throw httpError(502, `${new URL(url).host} sent something that is not JSON`); }
  }

  return { request, json, stats: () => ({ requests }), userAgent };
}

module.exports = { create, httpError, DEFAULT_UA };
