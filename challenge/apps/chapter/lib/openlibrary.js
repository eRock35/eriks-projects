// Looking a book up by ISBN in Open Library (openlibrary.org - free, no key).
//
//   GET https://openlibrary.org/isbn/<isbn13>.json   the edition (redirects to /books/OL…M.json)
//   GET https://openlibrary.org/authors/OL…A.json     an author's name
//   GET https://openlibrary.org/works/OL…W.json      the work, when the edition names no author
//
// What comes back is someone else's data, so it is treated like anything a
// stranger typed:
//   - one overall time budget for the whole lookup (AbortSignal, no timer
//     left running after the response), a size cap on every body, and the
//     final address must still be openlibrary.org after any redirect;
//   - a key is followed only if it has exactly the shape of an author or a
//     work key - nothing in a response can choose where the next request goes;
//   - title, author and pages go through the same cleaners as a club's book,
//     and a cover is only ever a numeric id on covers.openlibrary.org.
//
// "Not found" and "Open Library didn't answer" are different answers: the
// page offers manual entry for both, but only says "not in Open Library"
// when that is true. Results are cached in memory (per instance), found ones
// for a week and misses for an hour; failures are not cached.

const Core = require('../public/chapter-core');
const Lib = require('../public/library-core');

const HOST = 'https://openlibrary.org';
const UA = 'Chapter book club (challenge.strongtechnicalconsulting.com/chapter)';
const AUTHOR_KEY = /^\/authors\/OL\d{1,12}A$/;
const WORK_KEY = /^\/works\/OL\d{1,12}W$/;
const MAX_BYTES = 256 * 1024;
const FOUND_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_MS = 60 * 60 * 1000;
const CACHE_MAX = 2000;

function create(opts) {
  const o = opts || {};
  const client = {
    fetchImpl: o.fetchImpl || null,   // tests hand in a fake; otherwise the global fetch
    timeoutMs: o.timeoutMs || 6000,   // the whole lookup, every request in it
    calls: 0,                         // requests made (tests read it)
  };
  const cache = new Map();

  async function getJson(path, signal) {
    client.calls++;
    const f = client.fetchImpl || fetch;
    const url = HOST + path;
    const res = await f(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, redirect: 'follow', signal });
    let final;
    try { final = new URL(res.url || url); } catch (e) { final = null; }
    if (!final || final.protocol !== 'https:' || final.hostname !== 'openlibrary.org') throw Object.assign(new Error('Open Library sent us elsewhere.'), { lookup: 'unavailable' });
    if (res.status === 404) return null;
    if (!res.ok) throw Object.assign(new Error(`Open Library answered ${res.status}.`), { lookup: 'unavailable' });
    const text = await readCapped(res);
    try { return JSON.parse(text); } catch (e) { throw Object.assign(new Error('Open Library sent something unreadable.'), { lookup: 'unavailable' }); }
  }

  async function authorName(key, signal) {
    if (!AUTHOR_KEY.test(String(key || ''))) return '';
    const a = await getJson(`${key}.json`, signal);
    return a && typeof a === 'object' ? Core.plain(a.name || a.personal_name, 60) : '';
  }
  async function authorsOf(keys, signal) {
    const names = [];
    for (const k of keys.slice(0, 2)) { const n = await authorName(k, signal); if (n && !names.includes(n)) names.push(n); }
    return names;
  }

  /** {found: true, book} / {found: false, reason: 'notfound' | 'unavailable'}. */
  async function lookup(isbn13) {
    if (!Lib.isbn13Ok(isbn13)) return { found: false, reason: 'notfound' };
    const hit = cache.get(isbn13);
    if (hit && hit.until > Date.now()) return hit.value;
    if (hit) cache.delete(isbn13);
    const signal = AbortSignal.timeout(client.timeoutMs);
    let value;
    try {
      value = await find(isbn13, signal);
    } catch (e) {
      // Timeouts, network errors, a bad redirect, a body too big or garbled:
      // "unavailable", never cached, never shown to the page in its own words.
      return { found: false, reason: 'unavailable' };
    }
    cache.set(isbn13, { until: Date.now() + (value.found ? FOUND_MS : MISS_MS), value });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
  }

  async function find(isbn13, signal) {
    const ed = await getJson(`/isbn/${isbn13}.json`, signal);
    if (!ed || typeof ed !== 'object' || Array.isArray(ed)) return { found: false, reason: 'notfound' };
    const main = Core.plain(ed.title, Lib.LIMITS.title);
    if (!main) return { found: false, reason: 'notfound' };
    const sub = Core.plain(ed.subtitle, Lib.LIMITS.title);
    const title = Core.plain(sub && !main.endsWith(sub) ? `${main}: ${sub}` : main, Lib.LIMITS.title);
    const pages = Core.intIn(ed.number_of_pages, 1, Lib.LIMITS.pages);
    const covers = Array.isArray(ed.covers) ? ed.covers.filter((c) => Number.isInteger(c) && c > 0) : [];
    // The edition's own authors, else the work's, else its "by" line.
    let names = await authorsOf((Array.isArray(ed.authors) ? ed.authors : []).map((a) => a && a.key), signal);
    if (!names.length && Array.isArray(ed.works) && ed.works[0] && WORK_KEY.test(String(ed.works[0].key || ''))) {
      const w = await getJson(`${ed.works[0].key}.json`, signal);
      const wa = w && Array.isArray(w.authors) ? w.authors.map((a) => a && a.author && a.author.key) : [];
      names = await authorsOf(wa, signal);
    }
    let author = Core.plain(names.join(' and '), Lib.LIMITS.author);
    if (!author) author = Core.plain(String(typeof ed.by_statement === 'string' ? ed.by_statement : '').replace(/^\s*by\s+/i, '').replace(/[.;,\s]+$/, ''), Lib.LIMITS.author);
    return { found: true, book: { isbn: isbn13, title, author, pages, cover: Lib.coverUrl(covers[0]) } };
  }

  client.lookup = lookup;
  client.clear = () => cache.clear();
  return client;
}

/** The body as text, refusing anything past MAX_BYTES without reading it all. */
async function readCapped(res) {
  const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (len > MAX_BYTES) throw Object.assign(new Error('Too big.'), { lookup: 'unavailable' });
  if (!res.body || !res.body.getReader) {
    const t = await res.text();
    if (t.length > MAX_BYTES) throw Object.assign(new Error('Too big.'), { lookup: 'unavailable' });
    return t;
  }
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { try { await reader.cancel(); } catch (e) { /* gone */ } throw Object.assign(new Error('Too big.'), { lookup: 'unavailable' }); }
    parts.push(value);
  }
  return Buffer.concat(parts.map((p) => Buffer.from(p))).toString('utf8');
}

module.exports = { create, HOST, AUTHOR_KEY, WORK_KEY, MAX_BYTES };
