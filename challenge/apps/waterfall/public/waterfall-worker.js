/* Waterfall - the reader, in a Web Worker, so a 250,000-line billing export
 * never freezes the page. It reads the file the person chose (the File
 * itself is handed over - its text never travels through the page), keeps
 * the billing lines - customers, invoice ids, amounts and dates - in this
 * worker's memory only, and answers the page's questions: load, questions,
 * prepare, schedule, reconcile, customers, customer, exportFile, aiPayload,
 * drop, has. Every rule is WaterfallCore's (createEngine); this file only
 * carries messages. Nothing here makes a request or touches storage, and
 * nothing it holds outlives the page.
 */
/* global importScripts */
importScripts('waterfall-core.js', 'demo.js');
var C = self.WaterfallCore;
var D = self.WaterfallDemo;
var engine = C.createEngine();
var BIG = 'That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Export a shorter date range - 250,000 lines is the most one file can hold.';

self.addEventListener('message', function (e) {
  var m = e.data || {};
  var id = m.id;
  Promise.resolve().then(function () {
    var x = m.data || {};
    if (m.op === 'load' && x.file) {
      if (x.file.size > C.LIMITS.fileBytes) throw new Error(BIG);
      return x.file.text().then(function (text) { return engine.load({ text: text, name: x.name || x.file.name, presets: x.presets }); });
    }
    if (m.op === 'load' && x.demo) return engine.load({ text: D.csv(), name: D.FILE, demo: true });
    if (m.op === 'load') throw new Error('Choose a file.');
    if (typeof engine[m.op] !== 'function') throw new Error('Unknown step.');
    return engine[m.op](x);
  }).then(function (out) {
    self.postMessage({ id: id, ok: true, out: out });
  }, function (err) {
    self.postMessage({ id: id, ok: false, error: String((err && err.message) || 'The reader stopped.') });
  });
});
