/* Muster - the ONE storage module. Nothing else on the page touches
 * browser storage, and nothing goes through here without passing one of
 * MusterCore's guards first:
 *
 *   settings    layouts and preferences (MusterCore.cleanSettings)
 *   device      initials, the dismissed hint (plain flags and a few letters)
 *   batch:<id>  a batch record (MusterCore.safeBatch): the customer record
 *               id -> loan id, borrower number, origination date, rate,
 *               balance, payment, fees, loan type and "already applied".
 *               NO SSN, date of birth or name - rebuilt field by field, and
 *               refused outright if a loan id carries someone's SSN or name.
 *   results:<id> what DMDC's file said per record (MusterCore.safeResults):
 *               statuses and dates; any SSN, date-of-birth or name column
 *               was ignored on reading, and free text is scrubbed.
 *   audit:<id>  the append-only, SHA-256-chained audit log
 *               (MusterCore.safeEvent / nextEvent): steps, dates, amounts,
 *               initials and notes scrubbed of borrower data.
 *
 * SSNs, dates of birth and names live only in the reader's memory (the
 * worker) for as long as the page is open.
 *
 * Two backends: IndexedDB (what the page uses, so a 250,000-loan batch fits)
 * and memory (the demo - never saved - and the tests). Every IndexedDB
 * access is wrapped: a private window or a blocked database falls back to
 * memory and says so, and the page still works.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./muster-core'));
  else root.MusterStore = factory(root.MusterCore);
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
          var req = self.indexedDB.open(name || 'muster', 1);
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

  function create(backend) {
    var b = backend || memory();
    var queue = Promise.resolve();
    // Appends to one log go one at a time, so no two events claim the same place in the chain.
    function serial(fn) { var p = queue.then(fn, fn); queue = p.catch(function () { /* keep going */ }); return p; }
    function meta(batch) { return { id: batch.id, createdAt: batch.createdAt, statusDate: batch.statusDate, count: batch.count, loans: batch.loans, demo: batch.demo, files: batch.files.map(function (f) { return { name: f.name, records: f.records }; }) }; }
    var s = {
      backend: b,
      persistent: function () { return Boolean(b.persistent); },
      getSettings: function () { return b.get('settings').then(function (v) { return v ? C.cleanSettings(v).settings : null; }); },
      putSettings: function (v) { return b.put('settings', C.cleanSettings(v).settings); },
      getSyncBase: function () { return b.get('syncBase').then(function (v) { return typeof v === 'number' && isFinite(v) ? v : null; }); },
      putSyncBase: function (n) { return b.put('syncBase', typeof n === 'number' && isFinite(n) ? n : null); },
      getDevice: function () { return b.get('device').then(function (v) { return v ? { initials: C.initials(v.initials), hint: v.hint === true, results: v.results === true } : null; }); },
      putDevice: function (v) { return b.put('device', { initials: C.initials(v.initials), hint: v.hint === true, results: v.results === true }); },
      /** Every saved batch, newest first, without its map. */
      listBatches: function () {
        return b.get('index').then(function (ix) {
          var list = Array.isArray(ix) ? ix : [];
          return list.slice().sort(function (x, y) { return String(y.createdAt).localeCompare(String(x.createdAt)); });
        });
      },
      getBatch: function (id) { return b.get('batch:' + id).then(function (v) { return v ? C.safeBatch(v) : null; }); },
      /** Save a batch record. `people` (from the reader) refuses one whose loan ids carry an SSN or a name. */
      putBatch: function (batch, people) {
        var safe = C.safeBatch(batch, people);
        return serial(function () {
          return b.put('batch:' + safe.id, safe).then(function () { return b.get('index'); }).then(function (ix) {
            var list = (Array.isArray(ix) ? ix : []).filter(function (x) { return x.id !== safe.id; });
            list.push(meta(safe));
            return b.put('index', list);
          }).then(function () { return safe; });
        });
      },
      delBatch: function (id) {
        return serial(function () {
          return Promise.all([b.del('batch:' + id), b.del('results:' + id), b.del('audit:' + id)]).then(function () { return b.get('index'); }).then(function (ix) {
            return b.put('index', (Array.isArray(ix) ? ix : []).filter(function (x) { return x.id !== id; }));
          });
        });
      },
      getResults: function (id) { return b.get('results:' + id).then(function (v) { return v ? { results: C.safeResults(v.results), at: C.line(v.at, 30), file: C.line(v.file, 120) } : null; }); },
      putResults: function (id, list, at, file, people) { return b.put('results:' + id, { results: C.safeResults(list, people), at: C.line(at, 30), file: C.line(file, 120).replace(/[^A-Za-z0-9 ._()-]/g, '') }); },
      getAudit: function (id) { return b.get('audit:' + id).then(function (v) { return Array.isArray(v) ? v.map(function (e) { return C.safeEvent(e); }) : []; }); },
      /** Append one event to a batch's log, chained to the last. There is no edit and no delete of one event. */
      appendAudit: function (id, fields, digest, people) {
        return serial(function () {
          return s.getAudit(id).then(function (events) {
            if (events.length >= C.LIMITS.auditEvents) throw new Error('This batch’s audit log is full. Export it and start a new batch.');
            var f = Object.assign({}, fields, { batch: id });
            if (f.kind === 'note') f.value = C.scrubText(C.para(f.value, C.LIMITS.noteChars), people).text;
            return C.nextEvent(events, f, digest).then(function (ev) {
              events.push(ev);
              return b.put('audit:' + id, events).then(function () { return ev; });
            });
          });
        });
      },
      /** A log carried over from another device: checked link by link, written whole, or refused. */
      restoreAudit: function (id, events, digest) {
        var list = (events || []).map(function (e) { return C.safeEvent(e); });
        return C.verifyAudit(list, digest).then(function (ch) {
          if (!ch.ok) throw new Error('That audit log does not verify: ' + ch.broken.why);
          return serial(function () { return b.put('audit:' + id, list); });
        });
      },
      clearAll: function () { return b.clear(); },
    };
    return s;
  }

  return { create: create, memory: memory, idb: idb };
}));
