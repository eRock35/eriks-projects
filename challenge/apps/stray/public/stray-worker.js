/* Stray - the reader and matcher, in a Web Worker, so a 50,000-row account
 * list never freezes the page. It reads the file the person chose (the File
 * itself is handed over - its text never travels through the page), keeps
 * the parsed tables and the index, and answers the page's questions. Every
 * rule is StrayCore's (createEngine); this file only carries messages.
 * Nothing here makes a request or touches storage.
 */
/* global importScripts, StrayCore */
importScripts('stray-core.js');
var C = self.StrayCore;
var engine = C.createEngine();

self.addEventListener('message', function (e) {
  var m = e.data || {};
  var id = m.id;
  var progress = function (done, total) { self.postMessage({ id: id, progress: { done: done, total: total } }); };
  Promise.resolve().then(function () {
    if (m.op === 'parse' && m.data && m.data.file) {
      var f = m.data.file;
      if (f.size > C.LIMITS.fileBytes) throw new Error('That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Export fewer rows, or split it.');
      return f.text().then(function (text) { return engine.parse({ kind: m.data.kind, name: f.name, text: text }); });
    }
    if (typeof engine[m.op] !== 'function') throw new Error('Unknown step.');
    return engine[m.op](m.data || {}, progress);
  }).then(function (out) {
    self.postMessage({ id: id, ok: true, out: out });
  }, function (err) {
    self.postMessage({ id: id, ok: false, error: String((err && err.message) || 'The reader stopped.') });
  });
});
