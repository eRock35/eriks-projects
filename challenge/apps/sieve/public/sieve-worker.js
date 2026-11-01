/* Sieve - the checker, in a Web Worker. Every rule is SieveCore's
 * (createEngine); this file only carries messages.
 *
 * It holds the test cases and the match cache, and runs the guardrail over
 * them. Before a user's regex runs over the set it says so ({begin}), and
 * after ({end}), so the page's watchdog (sieve-runner.js) can stop this
 * worker if a pattern backtracks for ever - the page never freezes, and the
 * rule is reported by name and skipped. Nothing here makes a request or
 * touches storage.
 */
/* global importScripts */
importScripts('sieve-core.js');
var engine = self.SieveCore.createEngine();

self.addEventListener('message', function (e) {
  var m = e.data || {};
  var id = m.id;
  var hooks = {
    begin: function (key, name) { self.postMessage({ id: id, begin: key, name: name }); },
    end: function (key) { self.postMessage({ id: id, end: key }); }
  };
  var out;
  try {
    if (typeof engine[m.op] !== 'function') throw new Error('Unknown step.');
    out = engine[m.op](m.data || {}, hooks);
  } catch (err) {
    self.postMessage({ id: id, ok: false, error: String((err && err.message) || 'The checker stopped.') });
    return;
  }
  self.postMessage({ id: id, ok: true, out: out });
});
