/* Ajar - the ONE storage module. Nothing else on the page touches browser
 * storage, and nothing goes through here without passing AjarCore's door
 * (cleanCountdown) or a check of its own:
 *
 *   countdowns  up to three countdowns, each through AjarCore.cleanCountdown
 *   current     which one is open
 *   device      this phone's own flags: the tour seen, kid mode on, the paper
 *   sync        per countdown, the account copy's time this phone last saw
 *               and when (this phone's clock) it last synced
 *   photos      the photos of done doors, ON THIS PHONE ONLY - shrunk through
 *               a canvas first (no EXIF, no location), never sent and never
 *               synced. A JPEG data URL and its thumbnail, keyed by countdown
 *               and day.
 *
 * Two backends: IndexedDB (what the page uses) and memory (the demo - never
 * saved - and the tests). Every IndexedDB access is wrapped: a private
 * window, a blocked database or a full disk falls back to memory and says
 * so (`persistent()` turns false), and the page still works.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ajar-core'));
  else root.AjarStore = factory(root.AjarCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var STORES = ['kv', 'photos'];

  function memory() {
    var m = { kv: {}, photos: {} };
    return {
      kind: 'memory', persistent: false,
      has: function (s, k) { return m[s][k] !== undefined; },
      get: function (s, k) { return Promise.resolve(m[s][k] === undefined ? null : JSON.parse(m[s][k])); },
      put: function (s, k, v) { m[s][k] = JSON.stringify(v); return Promise.resolve(true); },
      del: function (s, k) { delete m[s][k]; return Promise.resolve(true); },
      keys: function (s) { return Promise.resolve(Object.keys(m[s])); },
      clear: function () { m = { kv: {}, photos: {} }; return Promise.resolve(true); },
      dump: function () { return JSON.stringify(m); },
    };
  }

  /** IndexedDB, two object stores. Falls back to memory on any failure.
   *  `factory` is the IndexedDB to use (the tests hand in a broken one). */
  function idb(name, factory) {
    var fallback = memory(), dead = false, dbp = null, api;
    var IDB = factory;
    try { if (!IDB && typeof self !== 'undefined') IDB = self.indexedDB; } catch (e) { IDB = null; }
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        try {
          var req = IDB.open(name || 'ajar', 1);
          req.onupgradeneeded = function () { STORES.forEach(function (s) { try { req.result.createObjectStore(s); } catch (e) { /* exists */ } }); };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error || new Error('blocked')); };
          req.onblocked = function () { reject(new Error('blocked')); };
        } catch (e) { reject(e); }
      }).catch(function (e) { dead = true; api.persistent = false; throw e; });
      return dbp;
    }
    function run(store, mode, fn) {
      if (dead) return Promise.reject(new Error('no database'));
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          try {
            var tx = db.transaction(store, mode), st = tx.objectStore(store), out;
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
      get: function (s, k) { if (fallback.has(s, k)) return fallback.get(s, k); return run(s, 'readonly', function (st) { return st.get(k); }).then(function (v) { return v === undefined ? null : v; }, function () { lost(); return fallback.get(s, k); }); },
      put: function (s, k, v) { return run(s, 'readwrite', function (st) { return st.put(v, k); }).then(function () { return true; }, function () { lost(); return fallback.put(s, k, v); }); },
      del: function (s, k) { fallback.del(s, k); return run(s, 'readwrite', function (st) { return st.delete(k); }).then(function () { return true; }, function () { return true; }); },
      keys: function (s) {
        return Promise.all([run(s, 'readonly', function (st) { return st.getAllKeys(); }).then(function (ks) { return ks || []; }, function () { lost(); return []; }), fallback.keys(s)])
          .then(function (r) { return r[0].map(String).concat(r[1]).filter(function (k, i, a) { return a.indexOf(k) === i; }); });
      },
      clear: function () { fallback.clear(); return Promise.all(STORES.map(function (s) { return run(s, 'readwrite', function (st) { return st.clear(); }); })).then(function () { return true; }, function () { return true; }); },
    };
    if (!IDB) { dead = true; api.persistent = false; }
    return api;
  }

  /* ---------------- what may be kept ---------------- */

  function cleanDevice(v) {
    v = v || {};
    return { tour: v.tour === true, kid: v.kid === true, paper: v.paper === 'letter' || v.paper === 'a4' ? v.paper : '', photoLine: v.photoLine === true };
  }
  function cleanSync(v) {
    var out = {};
    if (!v || typeof v !== 'object') return out;
    Object.keys(v).slice(0, 6).forEach(function (id) {
      var x = v[id];
      if (!C.ID.cd.test(id) || !x || typeof x !== 'object') return;
      out[id] = { base: typeof x.base === 'number' && isFinite(x.base) ? x.base : null, at: typeof x.at === 'number' && isFinite(x.at) ? x.at : 0 };
    });
    return out;
  }
  var JPEG = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
  /** A photo: a JPEG data URL (the canvas's), under 2.5 MB, and its thumbnail. */
  function cleanPhoto(p) {
    if (!p || typeof p !== 'object') return null;
    if (typeof p.full !== 'string' || typeof p.thumb !== 'string' || !JPEG.test(p.full) || !JPEG.test(p.thumb)) return null;
    if (p.full.length > 2500000 || p.thumb.length > 200000) return null;
    return { full: p.full, thumb: p.thumb, at: typeof p.at === 'number' && isFinite(p.at) ? p.at : 0 };
  }
  var pkey = function (id, d) { return id + '|' + d; };

  function create(backend) {
    var b = backend || memory();
    return {
      backend: b,
      persistent: function () { return Boolean(b.persistent); },
      getCountdowns: function () {
        return b.get('kv', 'countdowns').then(function (v) {
          return (Array.isArray(v) ? v : []).map(function (x) { return C.cleanCountdown(x).countdown; }).filter(function (x) { return x.id; }).slice(0, C.LIMITS.countdowns);
        });
      },
      putCountdowns: function (list) {
        var clean = (list || []).map(function (x) { return C.cleanCountdown(x).countdown; }).filter(function (x) { return x.id; }).slice(0, C.LIMITS.countdowns);
        return b.put('kv', 'countdowns', clean);
      },
      getCurrent: function () { return b.get('kv', 'current').then(function (v) { return typeof v === 'string' && C.ID.cd.test(v) ? v : ''; }); },
      putCurrent: function (id) { return b.put('kv', 'current', C.ID.cd.test(String(id)) ? id : ''); },
      getDevice: function () { return b.get('kv', 'device').then(cleanDevice); },
      putDevice: function (v) { return b.put('kv', 'device', cleanDevice(v)); },
      getSync: function () { return b.get('kv', 'sync').then(cleanSync); },
      putSync: function (v) { return b.put('kv', 'sync', cleanSync(v)); },
      photoGet: function (id, d) { return b.get('photos', pkey(id, d)).then(cleanPhoto); },
      photoPut: function (id, d, p) {
        var ok = cleanPhoto(p);
        if (!ok || !C.ID.cd.test(String(id)) || !C.isIso(d)) return Promise.resolve(false);
        return b.put('photos', pkey(id, d), ok);
      },
      photoDel: function (id, d) { return b.del('photos', pkey(id, d)); },
      /** The days of this countdown that have a photo on this phone. */
      photoDays: function (id) {
        return b.keys('photos').then(function (ks) { return ks.map(String).filter(function (k) { return k.indexOf(id + '|') === 0; }).map(function (k) { return k.slice(id.length + 1); }).filter(C.isIso).sort(); });
      },
      photoClear: function (id) {
        var self2 = this;
        return self2.photoDays(id).then(function (ds) { return Promise.all(ds.map(function (d) { return b.del('photos', pkey(id, d)); })); });
      },
      clearAll: function () { return b.clear(); },
    };
  }

  return { create: create, memory: memory, idb: idb, cleanDevice: cleanDevice, cleanSync: cleanSync, cleanPhoto: cleanPhoto };
}));
