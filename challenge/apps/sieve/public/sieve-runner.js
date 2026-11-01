/* Sieve - the watchdog around the checker worker.
 *
 * UMD: window.SieveRunner in the page, require() in the tests (which hand it
 * a worker_threads stand-in). It sends one job at a time to the worker and
 * listens for the worker's {begin: key} / {end: key} around each user
 * regex. A pattern that is still running after `ruleMs` is catastrophic
 * backtracking, or close enough: the worker is terminated (the only way to
 * stop a regex mid-match), the pattern is recorded as timed out by name, a
 * fresh worker gets the cases again, and the same job is re-run with that
 * pattern skipped. A whole job that runs past `runMs` is stopped the same
 * way and refused.
 *
 * The page never runs a user regex itself, so a bad one can cost a second
 * and a half, never the tab.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SieveRunner = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function create(opts) {
    var ruleMs = opts.ruleMs || 1500, runMs = opts.runMs || 20000;
    var w = null, seq = 0, cases = null, timedOut = {}, queue = [], busy = null;

    function start() {
      w = opts.spawn();
      w.addEventListener('message', function (e) { onMsg(e.data || {}); });
      w.addEventListener('error', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        if (busy) fail(new Error('The checker stopped. Try again.'));
      });
      if (cases) w.postMessage({ id: 0, op: 'cases', data: { cases: cases } });
    }
    function kill() { try { if (w) w.terminate(); } catch (e) { /* already gone */ } w = null; }

    function arm(kind, ms, key, name) {
      clearTimeout(busy[kind]);
      busy[kind] = setTimeout(function () { onTimeout(kind, key, name); }, ms);
    }
    function disarm() { if (busy) { clearTimeout(busy.rule); clearTimeout(busy.run); } }

    function onMsg(m) {
      if (!busy || m.id !== busy.id) return;
      if (m.begin) { busy.rule = null; busy.cur = { key: m.begin, name: m.name, at: Date.now() }; arm('rule', ruleMs, m.begin, m.name); return; }
      if (m.end) { clearTimeout(busy.rule); busy.cur = null; return; }
      var job = busy;
      disarm();
      busy = null;
      if (m.ok) {
        var out = m.out;
        if (out && typeof out === 'object' && !Array.isArray(out)) out.timedOut = list();
        job.resolve(out);
      } else job.reject(new Error(m.error || 'The checker stopped.'));
      next();
    }
    function onTimeout(kind, key, name) {
      if (!busy) return;
      var job = busy;
      disarm();
      busy = null;
      kill();
      start();
      if (kind === 'rule' && key && job.tries < 8) {
        timedOut[key] = { key: key, name: name || 'A rule', ms: ruleMs };
        job.tries++;
        queue.unshift(job);
        next();
        return;
      }
      job.reject(Object.assign(new Error('That took too long to check - try fewer or shorter test cases.'), { code: 'timeout' }));
      next();
    }
    function fail(err) {
      var job = busy;
      disarm();
      busy = null;
      kill();
      start();
      job.reject(err);
      next();
    }
    function next() {
      if (busy || !queue.length) return;
      if (!w) start();
      busy = queue.shift();
      busy.id = ++seq;
      var data = Object.assign({}, busy.data);
      if (busy.op !== 'cases') {
        var skip = Object.assign({}, data.skip || {});
        Object.keys(timedOut).forEach(function (k) { skip[k] = true; });
        data.skip = skip;
      }
      arm('run', runMs, null, null);
      w.postMessage({ id: busy.id, op: busy.op, data: data });
    }
    function call(op, data) {
      return new Promise(function (resolve, reject) {
        if (op === 'cases') cases = data.cases;
        // A newer job of the same kind replaces one still waiting: only the latest rules matter.
        if (op !== 'cases') queue = queue.filter(function (j) { if (j.op === op && j.replace) { j.reject(Object.assign(new Error('replaced'), { code: 'replaced' })); return false; } return true; });
        queue.push({ op: op, data: data || {}, resolve: resolve, reject: reject, tries: 0, replace: op === 'run' || op === 'attack' });
        next();
      });
    }
    function list() { return Object.keys(timedOut).map(function (k) { return timedOut[k]; }); }
    return {
      call: call,
      setCases: function (c) { return call('cases', { cases: c }); },
      timedOut: list,
      retry: function (key) { delete timedOut[key]; },
      forget: function () { timedOut = {}; },
      stop: function () { disarm(); kill(); }
    };
  }

  return { create: create };
}));
