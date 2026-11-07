/* Replay - the reader and checker, in a Web Worker, so a 20 MB decision log
 * never freezes the page. It reads the file the person chose (the File
 * itself is handed over - its bytes never travel through the page), keeps
 * the records, and answers the page's questions: load, analyze, pack, find,
 * sample, flagged, drop. Every rule is ReplayCore's (createEngine); this
 * file carries messages and hands the engine SubtleCrypto's SHA-256.
 * Nothing here makes a request or touches storage.
 */
/* global importScripts */
importScripts('replay-core.js', 'demo.js');
var C = self.ReplayCore;
var D = self.ReplayDemo;
var enc = new TextEncoder();
function digest(text) {
  if (!self.crypto || !self.crypto.subtle) return Promise.reject(new Error('This page cannot hash here - open it at its https address.'));
  return self.crypto.subtle.digest('SHA-256', enc.encode(text)).then(C.hex);
}
var engine = C.createEngine({ digest: digest });

self.addEventListener('message', function (e) {
  var m = e.data || {};
  var id = m.id;
  Promise.resolve().then(function () {
    if (m.op === 'load' && m.data && m.data.file) {
      var f = m.data.file;
      if (f.size > C.LIMITS.fileBytes) throw new Error('That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Check a shorter period - a month at a time.');
      return f.arrayBuffer().then(function (buf) { return engine.load({ id: m.data.id, name: m.data.name || f.name, bytes: new Uint8Array(buf) }); });
    }
    if (m.op === 'load' && m.data && m.data.demo) {
      return D.build(digest).then(function (d) { return engine.load({ id: m.data.id, name: d.name, text: d.text }); });
    }
    if (m.op === 'analyze') {
      return engine.analyze(m.data || {}, function (p) { self.postMessage({ id: id, progress: p }); });
    }
    if (typeof engine[m.op] !== 'function') throw new Error('Unknown step.');
    return engine[m.op](m.data || {});
  }).then(function (out) {
    self.postMessage({ id: id, ok: true, out: out });
  }, function (err) {
    self.postMessage({ id: id, ok: false, error: String((err && err.message) || 'The reader stopped.') });
  });
});
