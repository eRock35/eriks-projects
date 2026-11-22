// Is there a legal copy of the club's book to read right here?
//
// Chapter never hosts, copies or proxies a book's text. What it does:
//
//   1. asks Open Library's search (openlibrary.org/search.json - free, no
//      key) for the title and author, and takes the best match;
//   2. if Open Library marks that work `ebook_access: public` - a scan the
//      Internet Archive lets anyone read in full, which is how public-domain
//      books appear there - asks the Internet Archive for that one item's
//      metadata and checks it is a text that is not access-restricted and
//      not in a lending or print-disabled collection;
//   3. answers {kind: 'read', ia} - and the PAGE puts the Internet Archive's
//      own reader (archive.org/embed/<id>) in a frame, after a tap. The text
//      travels from the Archive to the reader's browser, never through here.
//      Or {kind: 'borrow', work} (a link out to Open Library, where a reader
//      borrows with their own account), or {kind: 'none'} (links out only).
//
// Why not Project Gutenberg or Standard Ebooks text, fetched and cached
// here? Gutenberg's site is for people, not programs (it answers automated
// requests with 503 and tells robots to use mirrors and its offline
// catalogue instead - a whole catalogue is too much for a 512 MiB instance
// shared by every lab app), and Standard Ebooks keeps its feeds and bulk
// downloads for its patrons and disallows fetching its text pages. Both are
// linked for the reader to open themselves (ChapterCore.readLinks).
//
// Both services ask automated callers to say who they are, cache, and go
// slowly: one identified User-Agent, answers cached in memory (found a week,
// not found a day, failures never; 500 entries of a few hundred bytes - no
// Firestore read or write at all), at most two requests per lookup, and the
// route is limited per address. Everything that comes back is a stranger's
// data: one time budget for the whole lookup (AbortSignal, no timer left
// running), a size cap on each body, the final address must still be the
// host that was asked, and every field goes through the club's cleaners.

const Core = require('../public/chapter-core');

const UA = 'Chapter/1.1 (book club app; https://challenge.strongtechnicalconsulting.com/chapter/)';
const MAX_BYTES = 256 * 1024;
const FOUND_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const FIELDS = 'key,title,author_name,first_publish_year,ebook_access,public_scan_b,ia,lending_identifier_s,editions,editions.ebook_access,editions.ia';
// Collections the Archive lends from or keeps for print-disabled readers:
// an item in one of them is not free for anyone to read, whatever else says so.
const CLOSED = /^(inlibrary|printdisabled|internetarchivebooks_restricted|lendinglibrary|browserlending)$/i;

const fold = (s) => Core.plain(s, 200).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const noArticle = (s) => s.replace(/^(the|a|an) /, '');
/** The same book? The title must be the one asked for (or the one before
 *  its subtitle, as in "Frankenstein; or, The Modern Prometheus"), and when
 *  the club named an author, a name in common. */
function matches(doc, title, author) {
  const want = noArticle(fold(title));
  const full = Core.plain(doc && doc.title, 200);
  // The whole title, or the part before a subtitle - never just the same
  // first words ("Frankenstein Unbound" is another book).
  const got = [full, full.split(/[:;(\u2014]| - /)[0]].map((t) => noArticle(fold(t)));
  if (!want || !got[0]) return false;
  if (got.indexOf(want) < 0) return false;
  const a = fold(author);
  if (!a) return true;
  const names = (Array.isArray(doc.author_name) ? doc.author_name : []).map(fold).join(' ').split(' ');
  return a.split(' ').some((w) => w.length > 2 && names.includes(w));
}
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);

function create(opts) {
  const o = opts || {};
  const client = {
    fetchImpl: o.fetchImpl || null,   // tests hand in a fake; otherwise the global fetch
    timeoutMs: o.timeoutMs || 6000,   // the whole lookup, both requests
    calls: 0,                         // requests made (tests read it)
  };
  const cache = new Map();

  async function getJson(url, host, signal) {
    client.calls++;
    const f = client.fetchImpl || fetch;
    const res = await f(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, redirect: 'follow', signal });
    let final;
    try { final = new URL(res.url || url); } catch (e) { final = null; }
    if (!final || final.protocol !== 'https:' || final.hostname !== host) throw new Error('Sent elsewhere.');
    if (!res.ok) throw new Error(`Answered ${res.status}.`);
    const text = await readCapped(res);
    return JSON.parse(text);
  }

  /** Whether the Archive lets anyone read this item in full. */
  async function openItem(id, signal) {
    if (!Core.isIaId(id)) return null;
    const d = await getJson(`https://archive.org/metadata/${id}/metadata`, 'archive.org', signal);
    const m = d && typeof d === 'object' && d.result && typeof d.result === 'object' ? d.result : null;
    if (!m || m.mediatype !== 'texts') return null;
    if (m['access-restricted-item'] !== undefined && String(m['access-restricted-item']).toLowerCase() !== 'false') return null;
    if (list(m.collection).some((c) => CLOSED.test(String(c)))) return null;
    return { year: Core.intIn(String(m.date || m.year || '').slice(0, 4), 1, 2999) };
  }

  async function find(title, author, signal) {
    const q = new URLSearchParams({ title: Core.plain(title, Core.LIMITS.title), fields: FIELDS, limit: '5' });
    if (Core.plain(author, Core.LIMITS.author)) q.set('author', Core.plain(author, Core.LIMITS.author));
    const d = await getJson(`https://openlibrary.org/search.json?${q}`, 'openlibrary.org', signal);
    const docs = (d && Array.isArray(d.docs) ? d.docs : []).filter((x) => x && typeof x === 'object' && matches(x, title, author)).slice(0, 5);
    if (!docs.length) return { kind: 'none' };
    const about = (x) => ({ work: Core.workUrl(x.key) ? x.key : '', title: Core.plain(x.title, Core.LIMITS.title), author: Core.plain(list(x.author_name)[0], Core.LIMITS.author) });
    const open = docs.find((x) => x.ebook_access === 'public' && x.public_scan_b === true);
    if (open) {
      const ed = open.editions && Array.isArray(open.editions.docs) ? open.editions.docs[0] : null;
      const ids = [...(ed && ed.ebook_access === 'public' ? list(ed.ia) : []), ...list(open.lending_identifier_s), ...list(open.ia)].filter(Core.isIaId);
      const id = ids[0];
      const item = id ? await openItem(id, signal) : null;
      if (item) return { kind: 'read', ia: id, year: item.year || Core.intIn(open.first_publish_year, 1, 2999), ...about(open) };
    }
    const lend = docs.find((x) => x.ebook_access === 'borrowable' && Core.workUrl(x.key));
    if (lend) return { kind: 'borrow', year: Core.intIn(lend.first_publish_year, 1, 2999), ...about(lend) };
    return { kind: 'none', ...about(docs[0]) };
  }

  /** {kind: 'read' | 'borrow' | 'none', ...} - never throws; a failure is
   *  {kind: 'none', reason: 'unavailable'} and is not cached. */
  async function lookup(title, author) {
    const key = `${fold(title)}|${fold(author)}`;
    if (!fold(title)) return Core.cleanRead({ kind: 'none' });
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    if (hit) cache.delete(key);
    let value;
    try {
      value = Core.cleanRead(await find(title, author, AbortSignal.timeout(client.timeoutMs)));
    } catch (e) {
      return Core.cleanRead({ kind: 'none', reason: 'unavailable' });
    }
    cache.set(key, { until: Date.now() + (value.kind === 'none' ? MISS_MS : FOUND_MS), value });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
  }

  client.lookup = lookup;
  client.clear = () => cache.clear();
  client.size = () => cache.size;
  return client;
}

/** The body as text, refusing anything past MAX_BYTES without reading it all. */
async function readCapped(res) {
  const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (len > MAX_BYTES) throw new Error('Too big.');
  if (!res.body || !res.body.getReader) {
    const t = await res.text();
    if (t.length > MAX_BYTES) throw new Error('Too big.');
    return t;
  }
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { try { await reader.cancel(); } catch (e) { /* gone */ } throw new Error('Too big.'); }
    parts.push(value);
  }
  return Buffer.concat(parts.map((p) => Buffer.from(p))).toString('utf8');
}

module.exports = { create, matches, UA, MAX_BYTES, CACHE_MAX };
