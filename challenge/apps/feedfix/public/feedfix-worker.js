/* Feedfix - the reader and fixer, in a Web Worker, so a 20 MB statement
 * never freezes the page. It reads the file the person chose (the File
 * itself is handed over - its bytes never travel through the page), keeps
 * them, and answers the page's questions: load, diagnose, fix, drop. Every
 * rule is FeedfixCore's (createEngine); this file only carries messages.
 * Nothing here makes a request or touches storage.
 */
/* global importScripts */
importScripts('feedfix-core.js');
var C = self.FeedfixCore;
var engine = C.createEngine();

self.addEventListener('message', function (e) {
  var m = e.data || {};
  var id = m.id;
  Promise.resolve().then(function () {
    if (m.op === 'load' && m.data && m.data.file) {
      var f = m.data.file;
      if (f.size > C.LIMITS.fileBytes) throw new Error('That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Download a shorter period from the bank.');
      return f.arrayBuffer().then(function (buf) { return engine.load({ id: m.data.id, name: m.data.name || f.name, bytes: new Uint8Array(buf), opts: m.data.opts }); });
    }
    if (typeof engine[m.op] !== 'function') throw new Error('Unknown step.');
    return engine[m.op](m.data || {});
  }).then(function (out) {
    self.postMessage({ id: id, ok: true, out: out });
  }, function (err) {
    self.postMessage({ id: id, ok: false, error: String((err && err.message) || 'The reader stopped.') });
  });
});
