/* Stars - the ONE storage module. Nothing else on the page touches browser
 * storage, and nothing goes through here without passing StarsCore's door
 * (cleanBook) or a check of its own:
 *
 *   book    the menu on this phone - dishes, sections, prices, plate costs,
 *           units sold and the period - through StarsCore.cleanBook
 *   device  this phone's own flags: the tour seen, the restaurant's name
 *           for the printed report (never synced)
 *   sync    the account copy's time this phone last saw, and when
 *
 * Never kept: a photo of a menu or pasted menu text (read once for "Read
 * the menu" and dropped with the tab), or a sales CSV (read in the tab, its
 * good rows applied to the menu, and the file gone when it closes).
 *
 * Two backends: IndexedDB (what the page uses) and memory (the example -
 * never saved - and the tests). Every IndexedDB access is wrapped: a
 * private window, a blocked database, one that throws or a full disk falls
 * back to memory and says so (`persistent()` turns false), and the page
 * still works.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stars-core'));
  else root.StarsStore = factory(root.StarsCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  function memory() {
    var m = {};
    return {
      kind: 'memory', persistent: false,
      has: function (k) { return m[k] !== undefined; },
      get: function (k) { return Promise.resolve(m[k] === undefined ? null : JSON.parse(m[k])); },
      put: function (k, v) { m[k] = JSON.stringify(v); return Promise.resolve(true); },
      del: function (k) { delete m[k]; return Promise.resolve(true); },
      clear: function () { m = {}; return Promise.resolve(true); },
      dump: function () { return JSON.stringify(m); },
    };
  }

  /** IndexedDB, one object store. Falls back to memory on any failure.
   *  `factory` is the IndexedDB to use (the tests hand in broken ones). */
  function idb(name, factory) {
    var fallback = memory(), dead = false, dbp = null, api;
    var IDB = factory;
    try { if (IDB === undefined && typeof self !== 'undefined') IDB = self.indexedDB; } catch (e) { IDB = null; }
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        try {
          var req = IDB.open(name || 'stars', 1);
          req.onupgradeneeded = function () { try { req.result.createObjectStore('kv'); } catch (e) { /* exists */ } };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error || new Error('blocked')); };
          req.onblocked = function () { reject(new Error('blocked')); };
        } catch (e) { reject(e); }
      }).catch(function (e) { dead = true; api.persistent = false; throw e; });
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
    var lost = function () { api.persistent = false; };
    api = {
      kind: 'indexeddb', persistent: true,
      // Anything a failed write left in memory is newer than the database's copy.
      get: function (k) { if (fallback.has(k)) return fallback.get(k); return run('readonly', function (st) { return st.get(k); }).then(function (v) { return v === undefined ? null : v; }, function () { lost(); return fallback.get(k); }); },
      put: function (k, v) { return run('readwrite', function (st) { return st.put(v, k); }).then(function () { return true; }, function () { lost(); return fallback.put(k, v); }); },
      del: function (k) { fallback.del(k); return run('readwrite', function (st) { return st.delete(k); }).then(function () { return true; }, function () { return true; }); },
      clear: function () { fallback.clear(); return run('readwrite', function (st) { return st.clear(); }).then(function () { return true; }, function () { return true; }); },
    };
    if (!IDB) { dead = true; api.persistent = false; }
    return api;
  }

  /* ---------------- what may be kept ---------------- */

  function cleanDevice(v) {
    v = v && typeof v === 'object' ? v : {};
    var place = typeof v.place === 'string' ? C.line(v.place, 80) : '';
    return { tour: v.tour === true, place: place && !C.refuse(place, 80) ? place : '' };
  }
  function cleanSync(v) {
    v = v && typeof v === 'object' ? v : {};
    return { base: typeof v.base === 'number' && isFinite(v.base) ? v.base : null, at: typeof v.at === 'number' && isFinite(v.at) ? v.at : 0 };
  }

  function create(backend) {
    var b = backend || memory();
    var api = {
      backend: b,
      persistent: function () { return Boolean(b.persistent); },
      /** The book, through the one door - or null. */
      getBook: function () {
        return b.get('book').then(function (v) {
          if (!v || typeof v !== 'object') return null;
          return C.cleanBook(v).book;
        }, function () { return null; });
      },
      putBook: function (book) {
        if (!book) return b.del('book');
        return b.put('book', C.cleanBook(book).book);
      },
      getDevice: function () { return b.get('device').then(cleanDevice, function () { return cleanDevice({}); }); },
      putDevice: function (v) { return b.put('device', cleanDevice(v)); },
      getSync: function () { return b.get('sync').then(cleanSync, function () { return cleanSync({}); }); },
      putSync: function (v) { return b.put('sync', cleanSync(v)); },
      clearAll: function () { return b.clear(); },
    };
    return api;
  }

  return { create: create, memory: memory, idb: idb, cleanDevice: cleanDevice, cleanSync: cleanSync };
}));
