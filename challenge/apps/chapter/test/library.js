// The personal library: ISBNs, entries and edition tags, the barcode reader,
// then the ISBN lookup and the library end to end over HTTP, against the
// memory store and a FAKE Open Library (no request ever leaves the machine:
// the fake answers every one, and the test fails if anything else is asked).
//   CHAPTER_MEMORY=1 CHAPTER_FAKE_AI=1 node test/library.js   (part of `npm test`)
//
// Every book here is public domain or made up; every account is on the
// reserved example domain.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

if (process.env.CHAPTER_MEMORY !== '1' || process.env.CHAPTER_FAKE_AI !== '1') {
  console.error('run with CHAPTER_MEMORY=1 CHAPTER_FAKE_AI=1');
  process.exit(1);
}

const { app, store, books } = require('../server');
const C = require('../public/chapter-core');
const Lib = require('../public/library-core');
const K = require('../lib/clubs');
const OL = require('../lib/openlibrary');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const NOW = Date.parse('2026-11-11T15:00:00Z');
let seq = 0;
const ids = () => C.newId('l', (n) => (seq++ * 7 + 3) % n, 10);

const P_AND_P = '9780141439518';   // Pride and Prejudice (Penguin Classics)
const P_AND_P_10 = '0-14-143951-3';
const FRANK = '9780486282114';     // Frankenstein (Dover Thrift)

/* ================================================================== *
 * ISBNs
 * ================================================================== */

test('ISBNs: typed however, checked by the check digit, kept as ISBN-13; ISBN-10 (with an X) converts; only 978/979 are books', () => {
  assert.strictEqual(Lib.normalizeIsbn(' ISBN-13: 978-0-14-143951-8 '), P_AND_P);
  assert.strictEqual(Lib.toIsbn13(P_AND_P), P_AND_P);
  assert.strictEqual(Lib.toIsbn13('978 0141 439518'), P_AND_P);
  assert.strictEqual(Lib.toIsbn13(P_AND_P_10), P_AND_P, 'ISBN-10 to ISBN-13');
  assert.strictEqual(Lib.toIsbn13('0-8044-2957-X'), '9780804429573', 'an ISBN-10 ending in X');
  assert.strictEqual(Lib.toIsbn13('080442957x'), '9780804429573', 'a lower-case x');
  assert.strictEqual(Lib.toIsbn13('9780141439517'), null, 'one digit off');
  assert.strictEqual(Lib.toIsbn13('0141439514'), null, 'an ISBN-10 one digit off');
  assert.strictEqual(Lib.toIsbn13('4006381333931'), null, 'a valid EAN-13 that is not a book (a pen)');
  assert.ok(Lib.ean13Ok('4006381333931'));
  for (const bad of ['', null, undefined, {}, [], 'abc', '12345', '9'.repeat(200), 978014143951]) assert.strictEqual(Lib.toIsbn13(bad), null, String(bad));
  assert.match(Lib.isbnProblem(''), /above the barcode/);
  assert.match(Lib.isbnProblem('12345'), /10 or 13 digits\. That has 5/);
  assert.match(Lib.isbnProblem('4006381333931'), /starts with 978 or 979/);
  assert.match(Lib.isbnProblem('9780141439517'), /one digit may be off/);
  assert.strictEqual(Lib.showIsbn(P_AND_P), '978-0141439518');
});

/* ================================================================== *
 * Entries and edition tags
 * ================================================================== */

test('an entry: a title is needed; markup, bidi and zero-width characters go; pages are a number; a cover is only an Open Library cover id; a bad ISBN is refused in words', () => {
  const e = Lib.cleanEntry({ isbn: P_AND_P_10, title: '<b>Pride</b> and \u202EPrejudice\u200B', author: 'Jane <script>x</script>Austen', pages: '480', cover: 'https://covers.openlibrary.org/b/id/12645114-M.jpg', source: 'openlibrary' });
  assert.deepStrictEqual(e, { isbn: P_AND_P, title: 'Pride and Prejudice', author: 'Jane x Austen', pages: 480, cover: 'https://covers.openlibrary.org/b/id/12645114-M.jpg', source: 'openlibrary' });
  assert.strictEqual(Lib.cleanEntry({ title: 'A Book With No ISBN' }).isbn, '', 'an ISBN is optional');
  assert.strictEqual(Lib.cleanEntry({ title: 'X', source: 'evil' }).source, 'manual');
  for (const cover of ['http://covers.openlibrary.org/b/id/1-M.jpg', 'https://evil.example/b/id/1-M.jpg', 'https://covers.openlibrary.org.evil.example/b/id/1-M.jpg', 'https://covers.openlibrary.org/b/id/../../x-M.jpg', 'https://covers.openlibrary.org/b/id/0-M.jpg', 'javascript:alert(1)', 'https://covers.openlibrary.org/b/isbn/9780141439518-M.jpg', { toString: () => 'x' }]) {
    assert.strictEqual(Lib.cleanEntry({ title: 'X', cover }).cover, '', String(cover));
  }
  assert.strictEqual(Lib.coverUrl(12645114), 'https://covers.openlibrary.org/b/id/12645114-M.jpg');
  for (const bad of [-1, 0, 1.5, '12x', '../1', null, {}, 1e13]) assert.strictEqual(Lib.coverUrl(bad), '', String(bad));
  assert.throws(() => Lib.cleanEntry({ title: '  ' }), (err) => err.status === 400 && /called/.test(err.message));
  assert.throws(() => Lib.cleanEntry({ title: 'X', isbn: '9780141439517' }), (err) => err.status === 400 && /one digit may be off/.test(err.message));
  assert.throws(() => Lib.cleanEntry({ title: 'X', pages: 0 }), (err) => err.status === 400 && /Pages/.test(err.message));
  assert.throws(() => Lib.cleanEntry({ title: 'X', pages: 10001 }), (err) => err.status === 400);
  assert.strictEqual(Lib.cleanEntry({ title: 'x'.repeat(500) }).title.length, Lib.LIMITS.title);
  assert.throws(() => Lib.cleanEntry({ title: {} }), (err) => err.status === 400, 'an object is no title');
});

test('edition tags: special edition and/or signed - only true is true; a note needs a tag, is one plain line and is cut at 200; a tag change writes three keys and nothing else', () => {
  assert.deepStrictEqual(Lib.cleanTags({ special: true, signed: false, note: 'Folio Society, slipcase' }), { special: true, signed: false, note: 'Folio Society, slipcase' });
  assert.deepStrictEqual(Lib.cleanTags({ special: 'true', signed: 1, note: 'x' }), { special: false, signed: false, note: '' }, 'only true is true');
  assert.deepStrictEqual(Lib.cleanTags({ note: 'a note with no tag' }), { special: false, signed: false, note: '' }, 'a note belongs to a tagged edition');
  assert.deepStrictEqual(Lib.cleanTags(null), { special: false, signed: false, note: '' });
  const t = Lib.cleanTags({ signed: true, note: 'Signed at the <i>launch</i>\nline two\u202E' + 'y'.repeat(400) });
  assert.ok(t.signed && !/[<>\n\u202E]/.test(t.note) && Array.from(t.note).length <= Lib.LIMITS.editionNote, t.note);
  assert.deepStrictEqual(Lib.tagLabels({ special: true, signed: true }), ['Special edition', 'Signed']);
  assert.deepStrictEqual(Lib.tagLabels({}), []);

  let lib = { books: {} };
  const add = Lib.addBook(lib, { isbn: P_AND_P, title: 'Pride and Prejudice', author: 'Jane Austen', special: true, note: 'Clothbound' }, { id: 'labcdefgh12', now: NOW });
  assert.deepStrictEqual(Object.keys(add.patch.set), ['books.labcdefgh12'], 'adding writes one key');
  assert.deepStrictEqual(add.patch.set['books.labcdefgh12'], { isbn: P_AND_P, title: 'Pride and Prejudice', author: 'Jane Austen', pages: null, cover: '', source: 'manual', special: true, signed: false, note: 'Clothbound', addedAt: '2026-11-11T15:00:00.000Z' });
  lib = C.applyPatch(lib, add.patch);
  const tag = Lib.setTags(lib, 'labcdefgh12', { special: true, signed: true, note: 'Signed too' });
  assert.deepStrictEqual(tag.patch, { set: { 'books.labcdefgh12.special': true, 'books.labcdefgh12.signed': true, 'books.labcdefgh12.note': 'Signed too' }, del: [] });
  lib = C.applyPatch(lib, tag.patch);
  lib = C.applyPatch(lib, Lib.setTags(lib, 'labcdefgh12', { special: false, signed: false, note: 'stray' }).patch);
  assert.deepStrictEqual([lib.books.labcdefgh12.special, lib.books.labcdefgh12.signed, lib.books.labcdefgh12.note], [false, false, ''], 'clearing both tags clears the note');
  assert.strictEqual(lib.books.labcdefgh12.title, 'Pride and Prejudice', 'tags never touch the entry');
  assert.throws(() => Lib.setTags(lib, 'lnothere123', { special: true }), (err) => err.status === 404);
  assert.throws(() => Lib.setTags(lib, '__proto__', { special: true }), (err) => err.status === 404);
  assert.throws(() => Lib.setTags(lib, 'constructor', { special: true }), (err) => err.status === 404);
  assert.deepStrictEqual(Lib.removeBook(lib, 'labcdefgh12').patch, { set: {}, del: ['books.labcdefgh12'] });
  assert.strictEqual(Lib.copiesOf(lib, P_AND_P), 1);
  assert.strictEqual(Lib.copiesOf(lib, FRANK), 0);
});

test('the library: newest first, counts of special and signed; a stored book is cleaned again on the way out; 500 books at most; moving a phone onto an account keeps every book', () => {
  const lib = { books: {
    lold1234567: { title: 'Older', addedAt: '2026-01-01T00:00:00.000Z', special: true },
    lnew1234567: { title: 'Newer<script>', author: '\u202Eevil', cover: 'https://evil.example/x.jpg', pages: -5, isbn: 'nonsense', signed: true, special: 'yes', note: 'n', addedAt: '2026-02-01T00:00:00.000Z' },
    'BAD KEY': { title: 'never shown' },
  } };
  const v = Lib.view(lib);
  assert.deepStrictEqual(v.books.map((b) => b.id), ['lnew1234567', 'lold1234567']);
  const n = v.books[0];
  assert.ok(!/[<>\u202E]/.test(JSON.stringify(v)) && n.cover === '' && n.isbn === '' && n.pages === null && n.special === false && n.signed === true, JSON.stringify(n));
  assert.deepStrictEqual(v.counts, { total: 2, special: 1, signed: 1, pages: 0 });
  assert.deepStrictEqual(Lib.view(null).books, []);

  const full = { books: {} };
  for (let i = 0; i < Lib.LIMITS.books; i++) full.books['l' + String(i).padStart(9, '0')] = { title: 'Book ' + i };
  assert.throws(() => Lib.addBook(full, { title: 'One too many' }, { id: 'lonetoomany', now: NOW }), (err) => err.status === 409 && /500/.test(err.message));

  const acct = { books: { lsame123456: { title: 'On the account' } } };
  const phone = { books: { lsame123456: { title: 'Clashing id' }, lother12345: { title: 'Other' } } };
  const m = Lib.mergeInto(acct, phone, ids);
  assert.strictEqual(m.moved, 2);
  const after = C.applyPatch(acct, m.patch);
  assert.deepStrictEqual(Object.values(after.books).map((b) => b.title).sort(), ['Clashing id', 'On the account', 'Other'], 'nothing overwritten');
  assert.throws(() => Lib.mergeInto(full, phone, ids), (err) => err.status === 409);
});

/* ================================================================== *
 * The barcode reader
 * ================================================================== */

/** One row of a printed barcode: quiet zones, `mod` pixels a module, with
 *  optional ink spread (bars wider by `spread` px), blur, noise, a lighting
 *  slope and an offset into a wider row. */
function barcodeRow(code, mod, o) {
  const x = Object.assign({ spread: 0, blur: 0, noise: 0, slope: 0, lead: 0, trail: 0, dark: 30, light: 230 }, o || {});
  const bits = Lib.ean13Modules(code);
  const quiet = 11 * mod;
  const ink = [];
  for (let i = 0; i < x.lead + quiet; i++) ink.push(0);
  for (const b of bits) for (let k = 0; k < mod; k++) ink.push(b);
  for (let i = 0; i < quiet + x.trail; i++) ink.push(0);
  const spread = ink.map((v, i) => (v || (x.spread > 0 && ink.slice(Math.max(0, i - x.spread), i + x.spread + 1).some(Boolean)) ? 1 : 0));
  let r = 1;
  const noise = () => { r = (r * 16807) % 2147483647; return ((r / 2147483647) - 0.5) * 2 * x.noise; };
  let px = spread.map((v, i) => (v ? x.dark : x.light) + x.slope * (i / spread.length) + noise());
  for (let k = 0; k < x.blur; k++) px = px.map((v, i) => ((px[i - 1] ?? v) + v + (px[i + 1] ?? v)) / 3);
  return px.map((v) => Math.max(0, Math.min(255, Math.round(v))));
}

test('the barcode reader: an EAN-13 from 1 to 8 pixels a module, either way round, through ink spread, blur, noise and uneven light - and nothing from a row with no barcode', () => {
  for (const code of [P_AND_P, FRANK, '9798888888886'.slice(0, 12) + Lib.eanCheck('979888888888'), '9780000000002']) {
    if (!Lib.ean13Ok(code)) continue;
    for (const mod of [1, 2, 3, 5, 8]) {
      const row = barcodeRow(code, mod, { lead: 37, trail: 21 });
      assert.strictEqual(Lib.decodeRow(row), code, `${code} at ${mod}px`);
      assert.strictEqual(Lib.decodeRow(row.slice().reverse()), code, `${code} at ${mod}px, upside down`);
    }
    assert.strictEqual(Lib.decodeRow(barcodeRow(code, 4, { spread: 1 })), code, `${code} with ink spread`);
    assert.strictEqual(Lib.decodeRow(barcodeRow(code, 4, { blur: 2 })), code, `${code} blurred`);
    assert.strictEqual(Lib.decodeRow(barcodeRow(code, 4, { noise: 25 })), code, `${code} noisy`);
    assert.strictEqual(Lib.decodeRow(barcodeRow(code, 4, { slope: 70, dark: 40, light: 200 })), code, `${code} in uneven light`);
    assert.strictEqual(Lib.decodeRow(barcodeRow(code, 3, { dark: 90, light: 170 })), code, `${code} low contrast`);
  }
  assert.strictEqual(Lib.decodeRow(new Array(800).fill(200)), null, 'a blank row');
  assert.strictEqual(Lib.decodeRow(Array.from({ length: 800 }, (_, i) => (Math.floor(i / 7) % 2 ? 30 : 230))), null, 'even stripes are not a barcode');
  assert.strictEqual(Lib.decodeRow([1, 2, 3]), null);
  // A damaged code never reads as another book: flip modules one at a time.
  const bits = Lib.ean13Modules(P_AND_P);
  let wrong = 0;
  for (let i = 3; i < 92; i++) {
    const b = bits.slice(); b[i] = 1 - b[i];
    const row = [...new Array(40).fill(230), ...b.flatMap((v) => [v ? 30 : 230, v ? 30 : 230, v ? 30 : 230]), ...new Array(40).fill(230)];
    const got = Lib.decodeRow(row);
    if (got && got !== P_AND_P) wrong++;
  }
  assert.strictEqual(wrong, 0, 'a one-module error is read as nothing (or the right book), never another book');
  assert.throws(() => Lib.ean13Modules('9780141439517'));
});

test('a camera frame: rows across the middle, then columns (a book held sideways); a code read on two lines counts twice; RGBA to grey', () => {
  const w = 640, h = 360;
  const row = barcodeRow(P_AND_P, 4, { lead: 60 });
  const gray = new Uint8Array(w * h).fill(215);
  for (let y = 100; y < 260; y++) for (let x = 0; x < row.length && x < w; x++) gray[y * w + x] = row[x];
  const f = Lib.decodeFrame(gray, w, h);
  assert.strictEqual(f.code, P_AND_P);
  assert.ok(f.votes >= 2, 'read on several lines');
  // The same barcode turned on its side.
  const col = barcodeRow(FRANK, 2, { lead: 20 });
  const side = new Uint8Array(w * h).fill(215);
  for (let x = 200; x < 460; x++) for (let y = 0; y < col.length && y < h; y++) side[y * w + x] = col[y];
  assert.strictEqual(Lib.decodeFrame(side, w, h).code, FRANK);
  assert.strictEqual(Lib.decodeFrame(new Uint8Array(w * h).fill(128), w, h), null, 'a plain frame');
  assert.strictEqual(Lib.decodeFrame(null, 0, 0), null);
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
  assert.deepStrictEqual(Array.from(Lib.toGray(rgba, 3, 1)), [255, 0, 76]);
});

test('the rules file touches no network, storage, clock or dice, and has no lookbehind; the page loads it after the club rules', () => {
  const src = read('public/library-core.js');
  assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.|indexedDB|WebSocket/.test(src));
  assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(src));
  assert.ok(!/\(\?<[=!]/.test(src));
  const html = read('public/index.html');
  assert.ok(html.indexOf('<script src="chapter-core.js"></script>') < html.indexOf('<script src="library-core.js"></script>') && html.indexOf('<script src="library-core.js"></script>') < html.indexOf('<script src="app.js"></script>'));
  assert.ok(read('public/sw.js').includes("'library-core.js'"), 'it opens offline too');
});

/* ================================================================== *
 * A fake Open Library
 * ================================================================== */

const fake = {
  log: [],
  routes: {},
  reset() { this.log = []; this.routes = {}; books.clear(); books.timeoutMs = 6000; },
};
function json(body, status, extra) {
  const r = new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  if (extra && extra.url) Object.defineProperty(r, 'url', { value: extra.url });
  return r;
}
books.fetchImpl = async (url, opts) => {
  fake.log.push(url);
  const u = new URL(url);
  assert.strictEqual(u.origin, 'https://openlibrary.org', `only Open Library is asked: ${url}`);
  assert.ok(opts && opts.signal, 'every request carries the time budget');
  const h = fake.routes[u.pathname];
  if (typeof h === 'function') return h(opts);
  if (h) return json(h);
  return json({ error: 'notfound' }, 404);
};
const EDITION = {
  title: 'Pride and Prejudice', subtitle: '', number_of_pages: 480, covers: [12645114, 999],
  authors: [{ key: '/authors/OL21594A' }], works: [{ key: '/works/OL66554W' }],
};
function standard() {
  fake.routes[`/isbn/${P_AND_P}.json`] = EDITION;
  fake.routes['/authors/OL21594A.json'] = { name: 'Jane Austen' };
}

/* ================================================================== *
 * Over HTTP
 * ================================================================== */

let base;
let ip6 = 1;
function client(addrIn) {
  const cookies = {};
  const addr = addrIn || `2001:db8:1b:${(ip6++).toString(16)}::1`;
  const call = async function (method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); call.raw.push(c); }
    const t = await res.text();
    let data = {}; try { data = JSON.parse(t); } catch (e) { data = { text: t }; }
    return { status: res.status, data, text: t, headers: res.headers };
  };
  call.cookies = cookies;
  call.raw = [];
  return call;
}
const mail = (who) => `${who}${String.fromCharCode(64)}example.com`;
async function register(who, c) {
  const u = c || client();
  const r = await u('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return u;
}

test('looking up an ISBN: title, author, pages and cover from Open Library; ISBN-10 works; a second lookup comes from the cache; "have" counts the copies already in your library', async () => {
  fake.reset(); standard();
  const a = client();
  const r = await a('GET', `/api/isbn/${encodeURIComponent(P_AND_P_10)}`);
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.data, { isbn: P_AND_P, found: true, book: { isbn: P_AND_P, title: 'Pride and Prejudice', author: 'Jane Austen', pages: 480, cover: 'https://covers.openlibrary.org/b/id/12645114-M.jpg' }, have: 0 });
  assert.deepStrictEqual(fake.log, [`https://openlibrary.org/isbn/${P_AND_P}.json`, 'https://openlibrary.org/authors/OL21594A.json']);
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.ok(!a.raw.length, 'a lookup mints no cookie');
  await a('GET', `/api/isbn/${P_AND_P}`);
  assert.strictEqual(fake.log.length, 2, 'cached');
  assert.strictEqual((await a('POST', '/api/library/books', r.data.book)).status, 200);
  assert.strictEqual((await a('GET', `/api/isbn/${P_AND_P}`)).data.have, 1);
});

test('the author from the work when the edition names none, else the "by" line; a subtitle joins the title', async () => {
  fake.reset();
  fake.routes[`/isbn/${FRANK}.json`] = { title: 'Frankenstein', subtitle: 'or, The Modern Prometheus', works: [{ key: '/works/OL450063W' }] };
  fake.routes['/works/OL450063W.json'] = { authors: [{ author: { key: '/authors/OL25342A' } }] };
  fake.routes['/authors/OL25342A.json'] = { name: 'Mary Wollstonecraft Shelley' };
  const r = await client()('GET', `/api/isbn/${FRANK}`);
  assert.strictEqual(r.data.book.title, 'Frankenstein: or, The Modern Prometheus');
  assert.strictEqual(r.data.book.author, 'Mary Wollstonecraft Shelley');
  assert.strictEqual(r.data.book.pages, null);
  assert.strictEqual(r.data.book.cover, '');
  fake.reset();
  fake.routes[`/isbn/${FRANK}.json`] = { title: 'Frankenstein', by_statement: 'by Mary Shelley.' };
  assert.strictEqual((await client()('GET', `/api/isbn/${FRANK}`)).data.book.author, 'Mary Shelley');
});

test('not in Open Library, or Open Library not answering (an error, a timeout, a body too big, garbage, a redirect elsewhere): still a 200 that says which, with the ISBN for manual entry - and a failure is not cached', async () => {
  const c = client();
  fake.reset();
  let r = await c('GET', `/api/isbn/${FRANK}`);
  assert.deepStrictEqual(r.data, { isbn: FRANK, found: false, reason: 'notfound', book: { isbn: FRANK, title: '', author: '', pages: null, cover: '' }, have: 0 });
  const cases = {
    'an error': () => json({ error: 'busy' }, 503),
    'a timeout': (opts) => new Promise((_, no) => opts.signal.addEventListener('abort', () => no(opts.signal.reason))),
    'too big': () => json({ title: 'x'.repeat(OL.MAX_BYTES + 10) }),
    'garbage': () => json('<html>not json'),
    'a redirect to another host': () => json(EDITION, 200, { url: 'https://evil.example/isbn.json' }),
    'a network failure': () => { throw new TypeError('fetch failed'); },
  };
  for (const [what, h] of Object.entries(cases)) {
    fake.reset(); books.timeoutMs = 80;
    fake.routes[`/isbn/${P_AND_P}.json`] = h;
    r = await c('GET', `/api/isbn/${P_AND_P}`);
    assert.strictEqual(r.status, 200, what);
    assert.strictEqual(r.data.found, false, what);
    assert.strictEqual(r.data.reason, 'unavailable', what);
    assert.strictEqual(r.data.book.isbn, P_AND_P, what);
    assert.ok(!/evil|busy|fetch failed/.test(r.text), `${what}: nothing of theirs reaches the page`);
    fake.routes[`/isbn/${P_AND_P}.json`] = EDITION; fake.routes['/authors/OL21594A.json'] = { name: 'Jane Austen' };
    assert.strictEqual((await c('GET', `/api/isbn/${P_AND_P}`)).data.found, true, `${what}: not cached, so it works once Open Library is back`);
  }
});

test('Open Library is untrusted: markup and bidi in its fields are stripped; a cover is only a numeric id; a key that is not an author or work key is never followed', async () => {
  fake.reset();
  fake.routes[`/isbn/${P_AND_P}.json`] = {
    title: '<img src=x onerror=alert(1)>Pride\u202E and Prejudice', number_of_pages: '480; DROP', covers: ['../../x', -4, 1.5],
    authors: [{ key: '/authors/../../admin' }, { key: 'https://evil.example/authors/OL1A' }], works: [{ key: '/works/OL1W?x=y' }],
    by_statement: { toString: () => 'x' },
  };
  const r = await client()('GET', `/api/isbn/${P_AND_P}`);
  assert.strictEqual(r.data.found, true);
  assert.strictEqual(r.data.book.title, 'Pride and Prejudice');
  assert.deepStrictEqual([r.data.book.pages, r.data.book.cover, r.data.book.author], [null, '', '']);
  assert.deepStrictEqual(fake.log, [`https://openlibrary.org/isbn/${P_AND_P}.json`], 'no key of theirs chose a request');
  fake.reset();
  fake.routes[`/isbn/${P_AND_P}.json`] = { title: '   ' };
  assert.strictEqual((await client()('GET', `/api/isbn/${P_AND_P}`)).data.reason, 'notfound', 'an edition with no title is not a find');
  fake.reset();
  fake.routes[`/isbn/${P_AND_P}.json`] = [1, 2];
  assert.strictEqual((await client()('GET', `/api/isbn/${P_AND_P}`)).data.found, false);
});

test('a bad ISBN is a 400 in words and asks nobody; lookups are limited per address', async () => {
  fake.reset(); standard();
  const c = client();
  for (const [isbn, re] of [['12345', /10 or 13 digits/], ['9780141439517', /one digit may be off/], ['4006381333931', /978 or 979/], ['abc', /above the barcode/]]) {
    const r = await c('GET', `/api/isbn/${isbn}`);
    assert.strictEqual(r.status, 400, isbn);
    assert.match(r.data.error, re);
  }
  assert.strictEqual(fake.log.length, 0);
  const busy = client();
  for (let i = 0; i < K.LIMITS.lookupsPerIp; i++) assert.strictEqual((await busy('GET', `/api/isbn/${P_AND_P}`)).status, 200);
  const over = await busy('GET', `/api/isbn/${P_AND_P}`);
  assert.strictEqual(over.status, 429);
  assert.match(over.data.error, /Type the book in instead/);
});

test('your library is yours: another phone sees its own (empty) library and gets a 404 for your book ids; reading mints no cookie; the store keeps no key and no address', async () => {
  fake.reset(); standard();
  const me = client(), them = client();
  const empty = await me('GET', '/api/library');
  assert.deepStrictEqual([empty.data.library.books, empty.data.library.where], [[], 'phone']);
  assert.ok(!me.raw.length, 'reading an empty library mints no key');
  const add = await me('POST', '/api/library/books', { isbn: P_AND_P, title: 'Pride and Prejudice', author: 'Jane Austen', pages: 480, cover: 'https://covers.openlibrary.org/b/id/12645114-M.jpg', source: 'openlibrary', signed: true, note: 'Signed by the illustrator' });
  assert.strictEqual(add.status, 200, add.text);
  assert.ok(me.raw.some((c) => /^chapter_k=[A-Za-z0-9_-]{22}; Path=\/chapter\/;[^]*HttpOnly/.test(c)), 'the first book mints the key cookie on the app path');
  const bid = add.data.id;
  assert.ok(C.isId(bid));
  const mine = (await me('GET', '/api/library')).data.library;
  assert.strictEqual(mine.books.length, 1);
  assert.deepStrictEqual([mine.books[0].signed, mine.books[0].special, mine.books[0].note], [true, false, 'Signed by the illustrator']);
  // Someone else.
  assert.deepStrictEqual((await them('GET', '/api/library')).data.library.books, []);
  assert.strictEqual((await them('PATCH', `/api/library/books/${bid}`, { special: true })).status, 404);
  assert.strictEqual((await them('DELETE', `/api/library/books/${bid}`)).status, 404);
  await them('POST', '/api/library/books', { title: 'Their own book' });
  assert.strictEqual((await them('PATCH', `/api/library/books/${bid}`, { special: true })).status, 404, 'even with a library of their own');
  assert.strictEqual((await them('DELETE', `/api/library/books/${bid}`)).status, 404);
  assert.strictEqual((await me('GET', '/api/library')).data.library.books[0].special, false, 'untouched');
  assert.deepStrictEqual((await them('GET', '/api/library')).data.library.books.map((b) => b.title), ['Their own book']);
  // Nothing identifying is stored or sent.
  const dump = store._dump();
  assert.ok(!dump.includes(me.cookies.chapter_k) && !dump.includes(them.cookies.chapter_k), 'no browser key in the store');
  assert.ok(!/2001:db8/.test(dump), 'no address in the store');
  const shown = JSON.stringify((await me('GET', '/api/library')).data);
  assert.ok(!shown.includes(K.phoneLibId(me.cookies.chapter_k)) && !shown.includes(me.cookies.chapter_k), 'the library id never reaches the page');
  // The library id is not any club seat's hash.
  assert.notStrictEqual(K.phoneLibId(me.cookies.chapter_k).slice(1), K.keyHash(me.cookies.chapter_k, ''));
});

test('edition tags over HTTP: set either or both with a note, change them, clear them (the note goes); hostile text is stripped; a tag change touches nothing else', async () => {
  const me = client();
  const add = await me('POST', '/api/library/books', { isbn: FRANK, title: 'Frankenstein', author: 'Mary Shelley' });
  const bid = add.data.id;
  let r = await me('PATCH', `/api/library/books/${bid}`, { special: true, note: 'Illustrated, <b>numbered</b> 41/500\u200B' });
  let b = r.data.library.books[0];
  assert.deepStrictEqual([b.special, b.signed, b.note], [true, false, 'Illustrated, numbered 41/500']);
  r = await me('PATCH', `/api/library/books/${bid}`, { special: true, signed: true, note: b.note });
  b = r.data.library.books[0];
  assert.deepStrictEqual([b.special, b.signed], [true, true]);
  assert.strictEqual(r.data.library.counts.signed, 1);
  r = await me('PATCH', `/api/library/books/${bid}`, { special: false, signed: false, note: 'still here?' });
  b = r.data.library.books[0];
  assert.deepStrictEqual([b.special, b.signed, b.note], [false, false, '']);
  assert.deepStrictEqual([b.title, b.author, b.isbn], ['Frankenstein', 'Mary Shelley', FRANK], 'the entry is untouched');
  for (const body of [{ special: 'true' }, { signed: 1 }, { special: ['x'] }]) {
    r = await me('PATCH', `/api/library/books/${bid}`, body);
    assert.deepStrictEqual([r.data.library.books[0].special, r.data.library.books[0].signed], [false, false], JSON.stringify(body));
  }
  assert.strictEqual((await me('PATCH', '/api/library/books/__proto__', { special: true })).status, 404);
  assert.strictEqual((await me('DELETE', `/api/library/books/${bid}`)).data.library.books.length, 0);
  assert.strictEqual((await me('DELETE', `/api/library/books/${bid}`)).status, 404, 'removed once');
});

test('adding: typed in with no ISBN is fine; a bad ISBN, no title or bad pages is a 400 in words; markup is stripped before it is stored; another site cannot add; 500 books at most', async () => {
  const me = client();
  let r = await me('POST', '/api/library/books', { title: 'Grandma’s Recipes', author: '', pages: '120' });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual([r.data.library.books[0].isbn, r.data.library.books[0].pages, r.data.library.books[0].source], ['', 120, 'manual']);
  for (const [body, re] of [[{ title: 'X', isbn: '9780141439517' }, /one digit may be off/], [{ title: '' }, /called/], [{ title: 'X', pages: 'lots' }, /Pages/]]) {
    r = await me('POST', '/api/library/books', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, re);
  }
  r = await me('POST', '/api/library/books', { title: '<script>alert(1)</script>Dracula\u202E', author: '<b>Bram</b> Stoker', cover: 'https://evil.example/c.jpg' });
  assert.ok(!/[<>\u202E]|evil/.test(store._dump()), 'stripped before it is stored');
  assert.strictEqual((await me('POST', '/api/library/books', { title: 'X' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await me('POST', '/api/library/books', { title: 'X' }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await me('POST', '/api/library/books', 'title=X', { 'Content-Type': 'text/plain' })).status, 415);
  const pid = K.phoneLibId(me.cookies.chapter_k);
  const doc = await store.get('libraries', pid);
  for (let i = Object.keys(doc.books).length; i < Lib.LIMITS.books; i++) doc.books['l' + String(i).padStart(9, '0')] = { title: 'Filler ' + i, addedAt: '2026-01-01T00:00:00.000Z' };
  await store.set('libraries', pid, doc);
  r = await me('POST', '/api/library/books', { title: 'One too many' });
  assert.strictEqual(r.status, 409);
  assert.match(r.data.error, /500 books/);
  assert.strictEqual((await me('DELETE', '/api/library')).data.library.books.length, 0, 'delete the whole library');
  assert.strictEqual(await store.get('libraries', pid), null);
});

test('signed in: the library is the account’s, on every device; books already on the phone move across when asked (and the phone’s copy goes); no email or account id is stored', async () => {
  const phone = client();
  await phone('POST', '/api/library/books', { isbn: P_AND_P, title: 'Pride and Prejudice', special: true, note: 'Clothbound' });
  await phone('POST', '/api/library/books', { title: 'Grandma’s Recipes' });
  await register('lib-reader', phone);
  let v = (await phone('GET', '/api/library')).data.library;
  assert.deepStrictEqual([v.where, v.books.length, v.phone], ['account', 0, 2], 'signed in, it offers to move the two phone books');
  const keep = await phone('POST', '/api/library/keep', {});
  assert.strictEqual(keep.status, 200, keep.text);
  assert.strictEqual(keep.data.moved, 2);
  v = keep.data.library;
  assert.deepStrictEqual([v.where, v.books.length, v.phone], ['account', 2, 0]);
  assert.deepStrictEqual(v.books.map((b) => b.title).sort(), ['Grandma’s Recipes', 'Pride and Prejudice']);
  assert.strictEqual(v.books.find((b) => b.special).note, 'Clothbound', 'tags move with the books');
  assert.strictEqual(await store.get('libraries', K.phoneLibId(phone.cookies.chapter_k)), null, 'the phone’s copy is gone');
  // Another device, signed in to the same account.
  const laptop = client();
  const login = await laptop('POST', '/api/auth/login', { email: mail('lib-reader'), password: 'a long enough password' });
  assert.strictEqual(login.status, 200, login.text);
  assert.strictEqual((await laptop('GET', '/api/library')).data.library.books.length, 2);
  const bid = v.books[0].id;
  assert.strictEqual((await laptop('PATCH', `/api/library/books/${bid}`, { signed: true })).status, 200, 'and can tag it');
  // Signed out, the laptop is a stranger again.
  await laptop('POST', '/api/auth/logout', {});
  assert.deepStrictEqual((await laptop('GET', '/api/library')).data.library.books, []);
  assert.strictEqual((await laptop('PATCH', `/api/library/books/${bid}`, { signed: false })).status, 404);
  const dump = store._dump();
  assert.ok(!dump.includes(mail('lib-reader')) && !dump.includes(Buffer.from(mail('lib-reader')).toString('base64url')), 'no email or account id in the store');
  assert.strictEqual((await client()('POST', '/api/library/keep', {})).status, 401, 'keeping needs an account');
});

test('a phone’s library nobody opens in 400 days is deleted by the read that finds it; an account’s is not', async () => {
  const me = client();
  await me('POST', '/api/library/books', { title: 'Forgotten' });
  const pid = K.phoneLibId(me.cookies.chapter_k);
  const doc = await store.get('libraries', pid);
  doc.updatedAt = new Date(Date.now() - (Lib.LIMITS.idleDays + 1) * 86400000).toISOString();
  await store.set('libraries', pid, doc);
  assert.deepStrictEqual((await me('GET', '/api/library')).data.library.books, []);
  assert.strictEqual(await store.get('libraries', pid), null);
});

test('the page asks only for these library paths, escapes every field it draws, and handles a denied camera by offering to type the ISBN', () => {
  const js = read('public/app.js');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|PATCH|DELETE)', '(api\/(?:library|isbn)[^']*)'/g)].map((m) => `${m[1]} ${m[2]}`))].sort();
  assert.deepStrictEqual(calls, ['DELETE api/library', 'DELETE api/library/books/', 'GET api/isbn/', 'GET api/library', 'PATCH api/library/books/', 'POST api/library/books', 'POST api/library/keep'].sort());
  assert.match(js, /getUserMedia\(\{ video: \{ facingMode: \{ ideal: 'environment' \} \}, audio: false \}\)/, 'the back camera, no microphone');
  assert.match(js, /NotAllowedError/, 'a denied camera is handled');
  assert.match(js, /Type the ISBN instead/);
  assert.match(js, /getTracks\(\)\.forEach\(function \(t\) \{ t\.stop\(\); \}\)/, 'the camera is switched off when the scanner closes');
  assert.match(js, /ChapterLibrary\.decodeFrame/, 'the built-in reader where there is no BarcodeDetector');
  const unesc = (src) => { let out = '', i = 0; for (;;) { const at2 = src.indexOf('esc(', i); if (at2 < 0) return out + src.slice(i); out += src.slice(i, at2) + 'ESC'; let depth = 0, j = at2 + 3; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; } };
  const risky = unesc(js).split('\n').filter((l) => !/toast\(|say\(|confirm\(|textContent|\.value = /.test(l)).join('\n')
    .match(/['"]\s*\+\s*(b\.title|b\.author|b\.note|b\.isbn|b\.cover|b\.pages|d\.book\.title|d\.book\.author|d\.book\.cover|d\.isbn|lb\.\w+|isbn|code)\s*\+/g);
  assert.strictEqual(risky, null, `unescaped: ${risky}`);
  assert.ok(!/fetch\(['"]https?:/.test(js) && !/openlibrary\.org/.test(js.replace(/covers\.openlibrary\.org/g, '')), 'the page never calls Open Library itself; covers come from its cover host');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/chapter', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/chapter`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
