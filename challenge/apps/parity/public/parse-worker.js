/* Parity - the reader. A Web Worker, so a 1 GB file never freezes the page.
 *
 * Files are read with File.stream() and decoded as they arrive; rows go
 * straight into the profiler (and, for a file that fits LIMITS.memoryBytes,
 * into memory so later passes are instant). A bigger file is read again for
 * each pass instead of being held: the hash pass keeps a 53-bit key hash and
 * a 64-bit row hash per key, and the detail pass keeps only the rows worth
 * showing. Nothing here makes a request. All the rules are ParityCore's.
 */
/* global importScripts, ParityCore */
importScripts('parity-core.js');
var C = self.ParityCore;

var sides = { before: null, after: null };
var hashed = { id: null, before: null, after: null }; // the last hash passes, for fingerprints
var cancelled = false;

function post(m) { self.postMessage(m); }
function Cancelled() { var e = new Error('cancelled'); e.cancelled = true; return e; }

/* ---------------- reading ---------------- */

/** Stream a file's text in. onText(chunk) per decoded chunk. */
function streamText(file, onText, onBytes) {
  var reader = file.stream().getReader();
  var dec = new TextDecoder('utf-8');
  var bytes = 0;
  function step() {
    if (cancelled) { try { reader.cancel(); } catch (e) { /* ignore */ } return Promise.reject(Cancelled()); }
    return reader.read().then(function (r) {
      if (r.done) { var tail = dec.decode(); if (tail) onText(tail); return bytes; }
      bytes += r.value.byteLength;
      onText(dec.decode(r.value, { stream: true }));
      if (onBytes) onBytes(bytes);
      return step();
    });
  }
  return step();
}

function throttle(fn, ms) {
  var last = 0;
  return function () { var now = Date.now(); if (now - last >= ms) { last = now; fn.apply(null, arguments); } };
}

/** Read a side's file with the decisions made at load (format, delimiter,
 *  header, width, empty-as-null), calling onRow for every data row. */
function readRows(s, onRow, onBytes) {
  if (s.format === 'jsonl') {
    var jp = C.createJsonlParser({ onRow: onRow });
    return streamText(s.file, function (t) { jp.push(t); }, onBytes).then(function () { jp.end(); });
  }
  var skip = s.header, width = s.width;
  var p = C.createCsvParser({
    delimiter: s.delimiter, emptyNull: s.emptyNull,
    onRow: function (r) {
      if (skip) { skip = false; return; }
      if (r.length < width) while (r.length < width) r.push(null); else if (r.length > width) r.length = width;
      onRow(r);
    },
  });
  return streamText(s.file, function (t) { p.push(t); }, onBytes).then(function () { p.end(); });
}

/** Every row of a side, from memory when it was kept, else read again. */
function eachRow(side, fn, phase) {
  var s = sides[side];
  if (!s) return Promise.reject(new Error('Load the ' + side + ' file first.'));
  var prog = throttle(function (done, total) { post({ op: 'progress', phase: phase, side: side, done: done, total: total }); }, 120);
  if (s.rows) {
    var rows = s.rows, i = 0, n = rows.length;
    // In slices, so a cancel and progress get through.
    return new Promise(function (resolve, reject) {
      (function slice() {
        if (cancelled) return reject(Cancelled());
        var end = Math.min(n, i + 50000);
        for (; i < end; i++) fn(rows[i]);
        prog(i, n);
        if (i < n) setTimeout(slice, 0); else resolve();
      }());
    });
  }
  return readRows(s, fn, function (b) { prog(b, s.size); });
}

function load(m) {
  var file = m.file, side = m.side;
  var keep = file.size <= C.LIMITS.memoryBytes;
  var t0 = Date.now();
  return file.slice(0, 65536).text().then(function (head) {
    var sn = C.sniff(head, file.name);
    var s = { side: side, file: file, name: C.clean(file.name, 200), size: file.size, format: sn.format, delimiter: sn.delimiter, emptyNull: Boolean(m.emptyNull), rows: keep ? [] : null };
    var prof = null, early = [], short = 0, long = 0, count = 0;
    var prog = throttle(function (b) { post({ op: 'progress', phase: 'reading', side: side, done: b, total: file.size, rows: count }); }, 120);
    function take(r) {
      count++;
      if (s.rows) s.rows.push(r);
      prof.add(r);
    }
    if (sn.format === 'jsonl') {
      var jp = C.createJsonlParser({ onRow: function (r) {
        if (!prof) prof = C.createProfiler([]);
        // New keys appear as they are seen: earlier rows read them as null.
        while (prof.width() < jp.columns.length) prof.addColumn(jp.columns[prof.width()]);
        take(r);
      } });
      return streamText(file, function (t) { jp.push(t); }, prog).then(function () {
        jp.end();
        if (!prof) prof = C.createProfiler([]);
        while (prof.width() < jp.columns.length) prof.addColumn(jp.columns[prof.width()]);
        s.header = true; s.headerGuess = true;
        var names = C.nameColumns(jp.columns, jp.columns.length);
        return finishLoad(s, prof, names, C.summariseIssues(jp.issues, 0, 0), t0);
      });
    }
    var decided = false;
    function decide(final) {
      decided = true;
      var guess = C.detectHeader(early.slice(0, 20));
      s.headerGuess = guess;
      s.header = m.header === true || m.header === false ? m.header : guess;
      var head2 = s.header && early.length ? early[0] : null;
      var width = head2 ? head2.length : early.reduce(function (x, r) { return Math.max(x, r.length); }, 0);
      s.width = Math.min(width, C.LIMITS.maxColumns);
      s.columns = C.nameColumns(head2, s.width);
      prof = C.createProfiler(s.columns);
      early.slice(s.header ? 1 : 0).forEach(fit);
      early = null;
    }
    function fit(r) {
      if (r.length < s.width) { short++; while (r.length < s.width) r.push(null); } else if (r.length > s.width) { long++; r.length = s.width; }
      take(r);
    }
    var p = C.createCsvParser({ delimiter: sn.delimiter, emptyNull: s.emptyNull, onRow: function (r) {
      if (!decided) { early.push(r); if (early.length >= 21) decide(); return; }
      fit(r);
    } });
    return streamText(file, function (t) { p.push(t); }, prog).then(function () {
      p.end();
      if (!decided) decide(true);
      return finishLoad(s, prof, s.columns, C.summariseIssues(p.issues, short, long), t0);
    });
  });
}
function finishLoad(s, prof, names, issues, t0) {
  var P = prof.finish();
  P.columns.forEach(function (c, i) { c.name = names[i]; });
  s.columns = P.columns;
  s.count = P.rows;
  sides[s.side] = s;
  hashed = { id: null, before: null, after: null };
  var preview = P.preview.map(function (r) { return r.map(function (v) { return v === null || v === undefined ? null : C.clean(v, 200); }); });
  return {
    side: s.side, name: s.name, size: s.size, format: s.format, delimiter: s.delimiter, header: s.header, headerGuess: s.headerGuess,
    emptyNull: s.emptyNull, rows: P.rows, columns: P.columns, preview: preview, issues: issues, kept: Boolean(s.rows), ms: Date.now() - t0,
  };
}

/* ---------------- passes ---------------- */

function colsFor(side, recipe) {
  if (sides[side]) return sides[side].columns;
  if (side === 'after' && recipe.target && recipe.target.length) return recipe.target;
  // The other machine's side: its names are all a plan needs from it.
  var names = [];
  recipe.pairs.forEach(function (p) { (side === 'before' ? p.from : p.to).forEach(function (n) { names.push({ name: n, type: 'text' }); }); });
  return names;
}
function planFor(recipe) {
  var plan = C.compilePlan(recipe, colsFor('before', recipe), colsFor('after', recipe));
  if (plan.errors.length) throw Object.assign(new Error(plan.errors[0]), { expose: true });
  return plan;
}
function planId(recipe) { return JSON.stringify([recipe.pairs, recipe.key, colsFor('after', recipe).map(function (c) { return [c.name, c.type, c.format || '']; })]); }

function hashSide(plan, side, id) {
  if (hashed.id === id && hashed[side]) return Promise.resolve(hashed[side]);
  var h = C.createHasher(plan, side);
  return eachRow(side, h.add, 'hashing').then(function () {
    var out = h.finish();
    if (hashed.id !== id) hashed = { id: id, before: null, after: null };
    hashed[side] = out;
    return out;
  });
}

function compare(m) {
  var plan = planFor(m.recipe), id = planId(m.recipe);
  var B, A, d;
  return hashSide(plan, 'before', id).then(function (x) { B = x; return hashSide(plan, 'after', id); }).then(function (x) {
    A = x;
    d = C.diffHashers(B, A);
    var w = C.wantedKeys(d);
    var db = C.createDetail(plan, 'before', w, d.common), da = C.createDetail(plan, 'after', w, d.common);
    return eachRow('before', db.add, 'explaining').then(function () { return eachRow('after', da.add, 'explaining'); }).then(function () {
      var f = function (s) { return { name: s.name, size: s.size, rows: s.count, format: s.format }; };
      return C.diagnose(plan, d, B, A, db.finish(), da.finish(), { files: { before: f(sides.before), after: f(sides.after) } });
    });
  });
}

function learn(m) {
  var plan = planFor(m.recipe);
  var stride = C.learnStride(Math.max(sides.before.count, sides.after.count));
  var byKey = new Map(), joined = [];
  return eachRow('after', function (r) {
    if (byKey.size >= C.LIMITS.learnRows * 2) return;
    var kh = C.keyHashOf(plan, 'after', r);
    if (kh % stride === 0 && !byKey.has(kh)) byKey.set(kh, r);
  }, 'learning').then(function () {
    return eachRow('before', function (r) {
      if (joined.length >= C.LIMITS.learnRows) return;
      var kh = C.keyHashOf(plan, 'before', r);
      if (kh % stride !== 0) return;
      var a = byKey.get(kh);
      if (a) { joined.push([r, a]); byKey.delete(kh); }
    }, 'learning');
  }).then(function () {
    return { learned: C.learnRules(m.recipe, colsFor('before', m.recipe), colsFor('after', m.recipe), joined), joined: joined.length };
  });
}

var keys = { pass: null, words: null };
function keyFor(passphrase) {
  var p = C.clean(passphrase, 400);
  if (keys.pass === p && keys.words) return Promise.resolve(keys.words);
  return C.deriveKey(p).then(function (w) { keys = { pass: p, words: w }; return w; });
}

function fingerprint(m) {
  var plan = planFor(m.recipe), id = planId(m.recipe);
  return keyFor(m.passphrase).then(function (key) {
    return hashSide(plan, m.side, id).then(function (h) { return C.fingerprintFrom(h, plan, m.side, key, { includeValues: m.includeValues }); });
  });
}

/** The rows of some buckets on this side: the shareable list (keyed hashes,
 *  key values only when asked) and, for this machine only, the rows. */
function findRows(m) {
  var plan = planFor(m.recipe), id = planId(m.recipe);
  var key, h;
  var want = {}; m.buckets.forEach(function (b) { want[b] = 1; });
  return keyFor(m.passphrase).then(function (k) { key = k; return hashSide(plan, m.side, id); }).then(function (x) {
    h = x;
    var wanted = new Set();
    h.keys.forEach(function (slot, kh) { if (want[C.bucketOf(key, kh)] && wanted.size < C.LIMITS.rowListMax) wanted.add(kh); });
    var det = C.createDetail(plan, m.side, wanted, null);
    return eachRow(m.side, det.add, 'finding').then(function () {
      var rows = det.finish().rows, keyText = new Map(), local = [];
      rows.forEach(function (list, kh) {
        var k = list[0].key.map(function (v) { return v === null ? 'null' : C.clean(v, 80); }).join(' · ');
        keyText.set(kh, k);
        local.push({ k: C.keyedKeyHex(key, kh), key: k, line: list[0].line, values: list[0].raw.map(function (v) { return Array.isArray(v) ? v.join(' ') : v; }) });
      });
      var list = C.rowListFrom(h, plan, m.side, key, m.buckets, m.includeKeys ? { keys: keyText } : {});
      return { list: list, local: local };
    });
  });
}

/* ---------------- messages ---------------- */

var OPS = { load: load, compare: compare, learn: learn, fingerprint: fingerprint, findRows: findRows };
self.addEventListener('message', function (e) {
  var m = e.data || {};
  if (m.op === 'cancel') { cancelled = true; return; }
  if (m.op === 'forget') { sides[m.side] = null; hashed = { id: null, before: null, after: null }; return; }
  var fn = OPS[m.op];
  if (!fn) return;
  cancelled = false;
  Promise.resolve().then(function () { return fn(m); }).then(function (result) {
    post({ op: 'done', id: m.id, result: result });
  }).catch(function (err) {
    if (err && err.cancelled) return post({ op: 'cancelled', id: m.id });
    post({ op: 'error', id: m.id, message: err && err.expose ? err.message : 'That file could not be read: ' + C.clean((err && err.message) || 'unknown error', 160) });
  });
});
