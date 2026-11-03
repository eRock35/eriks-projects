/* Lastday - the reader and matcher, in a Web Worker, so a 50,000-row export
 * never freezes the page. It reads the file the person chose (the File itself
 * is handed over - its text never travels through the page), keeps the
 * parsed tables and the last result, and answers the page's questions. Every
 * rule is LastdayCore's (createEngine); this file only carries messages.
 * Nothing here makes a request or touches storage.
 */
/* global importScripts */
importScripts('lastday-core.js');
var C = self.LastdayCore;
var engine = C.createEngine();

self.addEventListener('message', function (e) {
  var m = e.data || {};
  var id = m.id;
  Promise.resolve().then(function () {
    if (m.op === 'parse' && m.data && m.data.file) {
      var f = m.data.file;
      if (f.size > C.LIMITS.fileBytes) throw new Error('That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Export fewer columns, or split it.');
      return f.text().then(function (text) { return engine.parse({ id: m.data.id, role: m.data.role, name: m.data.name || f.name, n: m.data.n, text: text }); });
    }
    if (typeof engine[m.op] !== 'function') throw new Error('Unknown step.');
    return engine[m.op](m.data || {});
  }).then(function (out) {
    self.postMessage({ id: id, ok: true, out: out });
  }, function (err) {
    self.postMessage({ id: id, ok: false, error: String((err && err.message) || 'The reader stopped.') });
  });
});
