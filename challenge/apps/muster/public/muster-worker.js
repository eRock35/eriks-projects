/* Muster - the reader, in a Web Worker, so a 250,000-loan export never
 * freezes the page. It reads the file the person chose (the File itself is
 * handed over - its text never travels through the page), keeps the
 * portfolio - SSNs, dates of birth and names included - in this worker's
 * memory only, and answers the page's questions: loadPortfolio, questions,
 * prepare, checks, build, guard, person, scrub, loadResults, rawLines,
 * readResults, drop, has. Every rule is MusterCore's (createEngine); this
 * file carries messages and hands the engine SubtleCrypto's SHA-256.
 * Nothing here makes a request or touches storage, and nothing it holds
 * outlives the page.
 */
/* global importScripts */
importScripts('muster-core.js', 'demo.js');
var C = self.MusterCore;
var D = self.MusterDemo;
var enc = new TextEncoder();
function digest(text) {
  if (!self.crypto || !self.crypto.subtle) return Promise.reject(new Error('This page cannot hash here - open it at its https address.'));
  return self.crypto.subtle.digest('SHA-256', enc.encode(text)).then(C.hex);
}
var engine = C.createEngine({ digest: digest });
var BIG = 'That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Export fewer loans at a time - 250,000 is the most one file can hold.';

self.addEventListener('message', function (e) {
  var m = e.data || {};
  var id = m.id;
  Promise.resolve().then(function () {
    var x = m.data || {};
    if ((m.op === 'loadPortfolio' || m.op === 'loadResults') && x.file) {
      if (x.file.size > C.LIMITS.fileBytes) throw new Error(BIG);
      return x.file.text().then(function (text) { return engine[m.op]({ text: text, name: x.name || x.file.name, mode: x.mode }); });
    }
    if (m.op === 'loadPortfolio' && x.demo) return engine.loadPortfolio({ text: D.portfolio(x.today), name: D.FILE, demo: true });
    if (typeof engine[m.op] !== 'function') throw new Error('Unknown step.');
    return engine[m.op](x);
  }).then(function (out) {
    self.postMessage({ id: id, ok: true, out: out });
  }, function (err) {
    self.postMessage({ id: id, ok: false, error: String((err && err.message) || 'The reader stopped.') });
  });
});
