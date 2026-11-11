/* Chapter - the personal library's rules, in one file run three times:
 * `window.ChapterLibrary` in the page, `require` in the server and tests.
 *
 * Like chapter-core.js: NO CLOCK, NO DICE, NO NETWORK, NO STORAGE. "now" and
 * every new id are handed in. Text is cleaned with ChapterCore's own
 * cleaners, so a title in the library obeys the same rules as one in a club.
 *
 * What lives here:
 *   - ISBNs: typed however ("0-14-143951-3", "978 0141439518"), checked by
 *     their check digit, and kept as ISBN-13;
 *   - a library entry (title, author, pages, a cover from Open Library's
 *     cover host only) and its edition tags (special edition, signed, and a
 *     short note about the edition);
 *   - every write as a patch of keys, like the clubs, so two phones adding
 *     at once never undo each other;
 *   - an EAN-13 barcode reader for camera frames (iPhone Safari has no
 *     BarcodeDetector), so the page can scan the back cover.
 */
(function (root, factory) {
  const Core = typeof module === 'object' && module.exports ? require('./chapter-core') : root && root.ChapterCore;
  const api = factory(Core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChapterLibrary = api;
}(typeof window !== 'undefined' ? window : null, function (C) {
  'use strict';

  const LIMITS = {
    books: 500,        // books in one library
    title: 140,        // a title with its subtitle
    author: 120,       // "A and B" fits
    pages: 10000,
    editionNote: 200,  // "Folio Society, slipcase" / "Signed at the 2024 launch"
    idleDays: 400,     // a library on a phone nobody has opened in this long goes (the key cookie lasts as long)
  };
  const SOURCES = ['openlibrary', 'manual'];
  const fail = C.fail;

  /* ------------------------------------------------------------------ *
   * ISBNs
   * ------------------------------------------------------------------ */

  /** Digits (and a final X) only: spaces, hyphens and "ISBN" taken out. */
  function normalizeIsbn(v) {
    const s = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    return s.slice(0, 40).toUpperCase().replace(/^\s*ISBN(-1[03])?:?/, '').replace(/[^0-9X]/g, '');
  }
  function isbn10Ok(s) {
    if (!/^\d{9}[\dX]$/.test(s)) return false;
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (10 - i) * (s[i] === 'X' ? 10 : Number(s[i]));
    return sum % 11 === 0;
  }
  /** The EAN-13 check digit of twelve digits. */
  function eanCheck(twelve) {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (i % 2 ? 3 : 1);
    return String((10 - (sum % 10)) % 10);
  }
  function ean13Ok(s) { return /^\d{13}$/.test(s) && eanCheck(s.slice(0, 12)) === s[12]; }
  /** A book's EAN: 978 or 979 (Bookland). Other EANs are groceries. */
  function isbn13Ok(s) { return /^97[89]\d{10}$/.test(s) && ean13Ok(s); }
  /** Any valid ISBN-10 or ISBN-13, typed however, as ISBN-13 - or null. */
  function toIsbn13(v) {
    const s = normalizeIsbn(v);
    if (s.length === 13) return isbn13Ok(s) ? s : null;
    if (s.length === 10 && isbn10Ok(s)) { const t = '978' + s.slice(0, 9); return t + eanCheck(t); }
    return null;
  }
  /** "978-0141439518" style for display: the prefix, then the rest. */
  function showIsbn(isbn13) { return /^\d{13}$/.test(String(isbn13 || '')) ? isbn13.slice(0, 3) + '-' + isbn13.slice(3) : ''; }
  /** Why an ISBN was refused, in words. */
  function isbnProblem(v) {
    const s = normalizeIsbn(v);
    if (!s) return 'Type the ISBN - it’s above the barcode on the back, or on the copyright page.';
    if (s.length !== 10 && s.length !== 13) return 'An ISBN has 10 or 13 digits. That has ' + s.length + '.';
    if (s.length === 13 && !/^97[89]/.test(s)) return 'A book’s 13-digit ISBN starts with 978 or 979.';
    return 'That ISBN doesn’t check out - one digit may be off. Check it against the book.';
  }

  /* ------------------------------------------------------------------ *
   * A library entry and its edition tags
   * ------------------------------------------------------------------ */

  // Only Open Library's own cover host, and only a numeric cover id: nothing
  // a lookup (or a hand-made request) sends can point the page anywhere else.
  const COVER_RE = /^https:\/\/covers\.openlibrary\.org\/b\/id\/[1-9]\d{0,11}-[SML]\.jpg$/;
  function coverUrl(id) {
    const n = typeof id === 'number' ? id : typeof id === 'string' && /^\d{1,12}$/.test(id) ? Number(id) : NaN;
    return Number.isInteger(n) && n > 0 && n < 1e12 ? 'https://covers.openlibrary.org/b/id/' + n + '-M.jpg' : '';
  }
  function cleanCover(v) { const s = typeof v === 'string' ? v : ''; return COVER_RE.test(s) ? s : ''; }

  /** {isbn, title, author, pages, cover, source} or an error. The ISBN is
   *  optional (a typed-in book may have none) but must check out if given. */
  function cleanEntry(x) {
    const b = x && typeof x === 'object' ? x : {};
    const title = C.plain(b.title, LIMITS.title);
    const author = C.plain(b.author, LIMITS.author);
    const raw = normalizeIsbn(b.isbn);
    const isbn = raw ? toIsbn13(raw) : '';
    if (raw && !isbn) throw fail(400, isbnProblem(raw));
    if (!title) throw fail(400, 'What’s the book called?');
    const pages = b.pages === '' || b.pages === null || b.pages === undefined ? null : C.intIn(b.pages, 1, LIMITS.pages);
    if (b.pages !== '' && b.pages !== null && b.pages !== undefined && pages === null) throw fail(400, 'Pages is a number from 1 to ' + LIMITS.pages + '.');
    return { isbn: isbn || '', title, author, pages, cover: cleanCover(b.cover), source: SOURCES.indexOf(b.source) >= 0 ? b.source : 'manual' };
  }

  /** Special edition and/or signed, and a note about the edition. Only
   *  `true` is true. A note belongs to a tagged edition: with neither tag
   *  it is dropped, so an untagged book never carries stray text. */
  function cleanTags(x) {
    const t = x && typeof x === 'object' ? x : {};
    const special = t.special === true, signed = t.signed === true;
    const note = special || signed ? C.plain(t.note, LIMITS.editionNote) : '';
    return { special, signed, note };
  }
  function tagLabels(e) {
    const out = [];
    if (e && e.special) out.push('Special edition');
    if (e && e.signed) out.push('Signed');
    return out;
  }

  /* ------------------------------------------------------------------ *
   * The library: {books: {<id>: entry + tags + addedAt}, createdAt,
   * updatedAt, v}. Every write is a patch of keys.
   * ------------------------------------------------------------------ */

  function bookIds(lib) { return Object.keys((lib && lib.books) || {}).filter(C.isId); }
  function count(lib) { return bookIds(lib).length; }

  /** Add a book with its tags (both cleaned here). */
  function addBook(lib, input, opts) {
    if (count(lib) >= LIMITS.books) throw fail(409, 'Your library holds ' + LIMITS.books + ' books - that’s the most it can. Remove one to add another.');
    if (!C.isId(opts.id)) throw fail(500, 'Bad id.');
    const e = cleanEntry(input);
    const tags = cleanTags(input);
    const p = C.patch();
    p.set['books.' + opts.id] = Object.assign({}, e, tags, { addedAt: new Date(opts.now).toISOString() });
    return { patch: p, id: opts.id };
  }
  function bookOf(lib, id) {
    const b = C.isId(id) && lib && lib.books && Object.prototype.hasOwnProperty.call(lib.books, id) ? lib.books[id] : null;
    if (!b) throw fail(404, 'That book isn’t in your library any more.');
    return b;
  }
  /** New tags for one book: three keys, nothing else touched. */
  function setTags(lib, id, input) {
    bookOf(lib, id);
    const t = cleanTags(input);
    const p = C.patch();
    p.set['books.' + id + '.special'] = t.special;
    p.set['books.' + id + '.signed'] = t.signed;
    p.set['books.' + id + '.note'] = t.note;
    return { patch: p, tags: t };
  }
  function removeBook(lib, id) {
    bookOf(lib, id);
    const p = C.patch();
    p.del.push('books.' + id);
    return { patch: p };
  }
  /** How many copies of this ISBN the library already has. */
  function copiesOf(lib, isbn13) {
    if (!isbn13) return 0;
    return bookIds(lib).filter(function (id) { return lib.books[id].isbn === isbn13; }).length;
  }

  /** The library as its owner sees it: newest first, every field cleaned
   *  again on the way out (a document is never trusted to be well formed). */
  function view(lib) {
    const books = bookIds(lib).map(function (id) {
      const b = lib.books[id] || {};
      let e;
      try { e = cleanEntry(b); } catch (err) { e = { isbn: '', title: C.plain(b.title, LIMITS.title) || 'Untitled', author: '', pages: null, cover: '', source: 'manual' }; }
      const t = cleanTags(b);
      return Object.assign({ id: id }, e, t, { addedAt: typeof b.addedAt === 'string' ? b.addedAt.slice(0, 24) : '' });
    }).sort(function (a, b) { return a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : (a.id < b.id ? -1 : 1); });
    return {
      books: books,
      counts: {
        total: books.length,
        special: books.filter(function (b) { return b.special; }).length,
        signed: books.filter(function (b) { return b.signed; }).length,
        pages: books.reduce(function (s, b) { return s + (b.pages || 0); }, 0),
      },
      max: LIMITS.books,
    };
  }

  /** Moving a phone's books onto an account: the keys to add to the
   *  account's library (new ids where two would clash). Refuses past the cap. */
  function mergeInto(target, source, newId) {
    const have = count(target), add = bookIds(source);
    if (have + add.length > LIMITS.books) throw fail(409, 'That would be ' + (have + add.length) + ' books - a library holds ' + LIMITS.books + '. Remove some first.');
    const p = C.patch();
    const taken = {};
    bookIds(target).forEach(function (id) { taken[id] = true; });
    add.forEach(function (id) {
      let nid = id;
      while (taken[nid]) nid = newId();
      taken[nid] = true;
      p.set['books.' + nid] = source.books[id];
    });
    return { patch: p, moved: add.length };
  }

  /* ------------------------------------------------------------------ *
   * The barcode on the back cover: EAN-13, read from camera frames.
   *
   * A row of grey values -> bars and spaces -> 95 modules: a start guard,
   * six digits, a centre guard, six digits, an end guard. The first digit
   * is not drawn; it is the pattern of odd/even ("L"/"G") encodings of the
   * left six. Widths are matched per digit (each digit is seven modules),
   * so the scale and a little ink spread do not matter. A read counts only
   * when its check digit holds.
   * ------------------------------------------------------------------ */

  // Run widths of each digit's L code (space, bar, space, bar). The R code is
  // the same widths starting with a bar; the G code is the R code reversed.
  const L_W = [[3, 2, 1, 1], [2, 2, 2, 1], [2, 1, 2, 2], [1, 4, 1, 1], [1, 1, 3, 2], [1, 2, 3, 1], [1, 1, 1, 4], [1, 3, 1, 2], [1, 2, 1, 3], [3, 1, 1, 2]];
  const G_W = L_W.map(function (w) { return w.slice().reverse(); });
  const FIRST = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

  /** Best digit for four run widths against a table: [digit, error]. */
  function bestDigit(w, table) {
    const sum = w[0] + w[1] + w[2] + w[3];
    const unit = sum / 7;
    let best = -1, err = Infinity;
    for (let d = 0; d < 10; d++) {
      let e = 0;
      for (let i = 0; i < 4; i++) e += Math.abs(w[i] / unit - table[d][i]);
      if (e < err) { err = e; best = d; }
    }
    return [best, err];
  }
  function near(w, m, n) { return w > m * n * 0.3 && w < m * n * 1.8; }

  /** Runs [{w, bar}] -> thirteen digits, from a start guard at `i`.
   *  Ink spread (bars printed or seen wider than they are, spaces narrower)
   *  is measured on the guards, whose bars and spaces are all one module,
   *  and taken back out of every digit before it is matched. */
  function decodeAt(runs, i) {
    if (i + 59 > runs.length || !runs[i].bar) return null;
    const m = (runs[i].w + runs[i + 1].w + runs[i + 2].w) / 3;
    if (!(m > 0)) return null;
    for (let k = 0; k < 3; k++) if (!near(runs[i + k].w, m, 1)) return null;
    // A quiet zone before the start guard (or the edge of the frame).
    if (i > 0 && runs[i - 1].w < m * 4) return null;
    const c = i + 27, e = i + 56;
    for (let k = 0; k < 5; k++) if (!near(runs[c + k].w, m, 1)) return null;
    for (let k = 0; k < 3; k++) if (!near(runs[e + k].w, m, 1)) return null;
    const bars = [runs[i], runs[i + 2], runs[c + 1], runs[c + 3], runs[e], runs[e + 2]];
    const spaces = [runs[i + 1], runs[c], runs[c + 2], runs[c + 4], runs[e + 1]];
    const avg = function (a) { return a.reduce(function (s, r) { return s + r.w; }, 0) / a.length; };
    const d = (avg(bars) - avg(spaces)) / 2;
    const fix = function (r) { return Math.max(0.1, r.bar ? r.w - d : r.w + d); };
    let digits = '', parity = '', err = 0;
    let j = i + 3;
    for (let k = 0; k < 6; k++, j += 4) {
      const w = [fix(runs[j]), fix(runs[j + 1]), fix(runs[j + 2]), fix(runs[j + 3])];
      const l = bestDigit(w, L_W), g = bestDigit(w, G_W);
      if (l[1] <= g[1]) { digits += l[0]; parity += 'L'; err = Math.max(err, l[1]); } else { digits += g[0]; parity += 'G'; err = Math.max(err, g[1]); }
    }
    j = c + 5;
    for (let k = 0; k < 6; k++, j += 4) {
      const r = bestDigit([fix(runs[j]), fix(runs[j + 1]), fix(runs[j + 2]), fix(runs[j + 3])], L_W);
      digits += r[0]; err = Math.max(err, r[1]);
    }
    if (err > 1.6) return null;
    const first = FIRST.indexOf(parity);
    if (first < 0) return null;
    const code = String(first) + digits;
    return ean13Ok(code) ? code : null;
  }

  /** One row of grey values (0 dark - 255 light) -> an EAN-13, or null.
   *  Tried left to right and right to left (a book held upside down). */
  function decodeRow(values) {
    const n = values.length;
    if (n < 95) return null;
    // A light smoothing, then a threshold halfway between this row's dark
    // and light (the 5th and 95th percentiles, so a glint does not set it).
    const sm = new Array(n);
    for (let x = 0; x < n; x++) sm[x] = ((values[x - 1] === undefined ? values[x] : values[x - 1]) + 2 * values[x] + (values[x + 1] === undefined ? values[x] : values[x + 1])) / 4;
    const sorted = sm.slice().sort(function (a, b) { return a - b; });
    const lo = sorted[Math.floor(n * 0.05)], hi = sorted[Math.floor(n * 0.95)];
    if (hi - lo < 30) return null;
    const cut = (lo + hi) / 2;
    // Smoothed first (camera noise); then as captured (a barcode only a
    // pixel or two a bar wide, which smoothing would blur away).
    const raw = Array.prototype.slice.call(values);
    const tries = [sm, sm.slice().reverse(), raw, raw.slice().reverse()];
    for (let t = 0; t < tries.length; t++) {
      const row = tries[t];
      const runs = [];
      let bar = row[0] < cut, w = 0;
      for (let x = 0; x < n; x++) {
        const b = row[x] < cut;
        if (b === bar) w++;
        else { runs.push({ w: w, bar: bar }); bar = b; w = 1; }
      }
      runs.push({ w: w, bar: bar });
      for (let i = 0; i + 59 <= runs.length; i++) {
        if (!runs[i].bar) continue;
        const code = decodeAt(runs, i);
        if (code) return code;
      }
    }
    return null;
  }

  /** A greyscale frame (one byte a pixel, row by row) -> {code, votes} or
   *  null. Scans rows across the middle, then columns (a book held
   *  sideways); a code read on two lines counts twice. */
  function decodeFrame(gray, width, height) {
    if (!gray || !(width > 0) || !(height > 0)) return null;
    const votes = {};
    const add = function (code) { if (code) votes[code] = (votes[code] || 0) + 1; };
    const fr = [0.5, 0.42, 0.58, 0.34, 0.66, 0.46, 0.54, 0.26, 0.74];
    for (let k = 0; k < fr.length; k++) {
      const y = Math.floor(height * fr[k]);
      const row = new Array(width);
      for (let x = 0; x < width; x++) row[x] = gray[y * width + x];
      add(decodeRow(row));
    }
    if (!Object.keys(votes).length) {
      for (let k = 0; k < 5; k++) {
        const x = Math.floor(width * fr[k]);
        const col = new Array(height);
        for (let y = 0; y < height; y++) col[y] = gray[y * width + x];
        add(decodeRow(col));
      }
    }
    let best = null;
    Object.keys(votes).forEach(function (c) { if (!best || votes[c] > best.votes) best = { code: c, votes: votes[c] }; });
    return best;
  }
  /** RGBA pixels (a canvas's ImageData) -> one byte of grey a pixel. */
  function toGray(rgba, width, height) {
    const out = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    return out;
  }

  /** Tests only: the 95 modules (1 = bar) of an EAN-13, to draw a barcode
   *  and read it back. */
  function ean13Modules(code) {
    if (!ean13Ok(code)) throw new Error('not an EAN-13');
    const bits = [1, 0, 1];
    const runsToBits = function (w, startBar) { let b = startBar; w.forEach(function (n) { for (let i = 0; i < n; i++) bits.push(b ? 1 : 0); b = !b; }); };
    const par = FIRST[Number(code[0])];
    for (let k = 0; k < 6; k++) runsToBits(par[k] === 'L' ? L_W[Number(code[k + 1])] : G_W[Number(code[k + 1])], false);
    bits.push(0, 1, 0, 1, 0);
    for (let k = 0; k < 6; k++) runsToBits(L_W[Number(code[k + 7])], true);
    bits.push(1, 0, 1);
    return bits;
  }

  return {
    LIMITS, SOURCES,
    normalizeIsbn, isbn10Ok, ean13Ok, isbn13Ok, eanCheck, toIsbn13, showIsbn, isbnProblem,
    coverUrl, cleanCover, cleanEntry, cleanTags, tagLabels,
    bookIds, count, addBook, setTags, removeBook, copiesOf, view, mergeInto,
    decodeRow, decodeFrame, toGray, ean13Modules,
  };
}));
