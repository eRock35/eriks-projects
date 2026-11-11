/* Waterfall - the ONE storage module. Nothing else on the page touches
 * browser storage, and nothing goes through here without passing one of
 * WaterfallCore's guards first:
 *
 *   settings  column presets by header name, the rules table (product
 *             description -> rule), account names, the period-end choice,
 *             masking (WaterfallCore.cleanSettings - never a customer)
 *   device    this device's own flags: the dismissed hints and the last
 *             home currency (plain flags and a three-letter code)
 *   syncBase  the account copy's updatedAt this device last saw
 *
 * NO BILLING LINE IS EVER STORED: no customer, invoice id, amount or date.
 * A billing export lives only in the reader's memory (the worker) for as
 * long as the page is open; so do the figures typed into the tie-out.
 *
 * Two backends: IndexedDB (what the page uses) and memory (the demo - never
 * saved - and the tests). Every IndexedDB access is wrapped: a private
 * window or a blocked database falls back to memory and says so, and the
 * page still works.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./waterfall-core'));
  else root.WaterfallStore = factory(root.WaterfallCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  function memory() {
    var m = {};
    return {
      kind: 'memory', persistent: false,
      get: function (k) { return Promise.resolve(m[k] === undefined ? null : JSON.parse(m[k])); },
      put: function (k, v) { m[k] = JSON.stringify(v); return Promise.resolve(true); },
      del: function (k) { delete m[k]; return Promise.resolve(true); },
      keys: function () { return Promise.resolve(Object.keys(m)); },
      clear: function () { m = {}; return Promise.resolve(true); },
      dump: function () { return JSON.stringify(m); },
    };
  }

  /** IndexedDB, one object store of keys and values. Falls back to memory. */
  function idb(name) {
    var fallback = memory(), dead = false, dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        try {
          var req = self.indexedDB.open(name || 'waterfall', 1);
          req.onupgradeneeded = function () { try { req.result.createObjectStore('kv'); } catch (e) { /* exists */ } };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error || new Error('blocked')); };
          req.onblocked = function () { reject(new Error('blocked')); };
        } catch (e) { reject(e); }
      }).catch(function (e) { dead = true; throw e; });
      return dbp;
    }
    function run(mode, fn) {
      if (dead) return Promise.reject(new Error('no database'));
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          try {
            var tx = db.transaction('kv', mode), st = tx.objectStore('kv'), out;
            var r = fn(st);
            if (r) r.onsuccess = function () { out = r.result; };
            tx.oncomplete = function () { resolve(out); };
            tx.onerror = function () { reject(tx.error || new Error('write failed')); };
            tx.onabort = function () { reject(tx.error || new Error('write failed')); };
          } catch (e) { reject(e); }
        });
      });
    }
    var api = {
      kind: 'indexeddb', persistent: true,
      get: function (k) { return run('readonly', function (st) { return st.get(k); }).then(function (v) { return v === undefined ? null : v; }, function () { api.persistent = false; return fallback.get(k); }); },
      put: function (k, v) { return run('readwrite', function (st) { return st.put(v, k); }).then(function () { return true; }, function () { api.persistent = false; return fallback.put(k, v); }); },
      del: function (k) { return run('readwrite', function (st) { return st.delete(k); }).then(function () { return true; }, function () { return fallback.del(k); }); },
      keys: function () { return run('readonly', function (st) { return st.getAllKeys(); }).then(function (ks) { return ks || []; }, function () { api.persistent = false; return fallback.keys(); }); },
      clear: function () { return run('readwrite', function (st) { return st.clear(); }).then(function () { return true; }, function () { return fallback.clear(); }); },
    };
    try { if (!self.indexedDB) { dead = true; api.persistent = false; } } catch (e) { dead = true; api.persistent = false; }
    return api;
  }

  function cleanDevice(v) {
    v = v || {};
    return { hint: v.hint === true, rulesHint: v.rulesHint === true, home: C.isCcy(v.home) ? v.home : '' };
  }

  function create(backend) {
    var b = backend || memory();
    return {
      backend: b,
      persistent: function () { return Boolean(b.persistent); },
      getSettings: function () { return b.get('settings').then(function (v) { return v ? C.cleanSettings(v).settings : null; }); },
      putSettings: function (v) { return b.put('settings', C.cleanSettings(v).settings); },
      getSyncBase: function () { return b.get('syncBase').then(function (v) { return typeof v === 'number' && isFinite(v) ? v : null; }); },
      putSyncBase: function (n) { return b.put('syncBase', typeof n === 'number' && isFinite(n) ? n : null); },
      getDevice: function () { return b.get('device').then(function (v) { return v ? cleanDevice(v) : null; }); },
      putDevice: function (v) { return b.put('device', cleanDevice(v)); },
      clearAll: function () { return b.clear(); },
    };
  }

  return { create: create, memory: memory, idb: idb, cleanDevice: cleanDevice };
}));
