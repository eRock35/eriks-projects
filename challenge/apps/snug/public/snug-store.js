/* Snug - the ONE storage module. Nothing else on the page touches browser
 * storage, and nothing goes through here without passing SnugCore's door
 * (cleanHome) or a check of its own:
 *
 *   home    the one home on this phone - its chips, when each job was done,
 *           the breaker panel, the house facts and the appliances - through
 *           SnugCore.cleanHome
 *   photo:* a photo of a house fact or an appliance, kept ON THIS PHONE
 *           ONLY: redrawn through a canvas first (EXIF and location gone),
 *           a JPEG data URL, never sent, never synced
 *   device  this phone's own flags: the tour seen, the label paper
 *   sync    the account copy's time this phone last saw, and when
 *
 * Two backends: IndexedDB (what the page uses) and memory (the example -
 * never saved - and the tests). Every IndexedDB access is wrapped: a
 * private window, a blocked database, one that throws or a full disk falls
 * back to memory and says so (`persistent()` turns false), and the page
 * still works.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./snug-core'));
  else root.SnugStore = factory(root.SnugCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var PHOTO_MAX = 700 * 1024;    // characters of data URL, about 512 KB of JPEG
  var PHOTOS_MAX = 30;
  var REF = /^(water|gas|power|heater|filter|bins|paint|other|a[a-z0-9]{4,12})$/;

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
          var req = IDB.open(name || 'snug', 1);
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
    return { tour: v.tour === true, paper: v.paper === 'letter' || v.paper === 'a4' ? v.paper : '' };
  }
  function cleanSync(v) {
    v = v && typeof v === 'object' ? v : {};
    return { base: typeof v.base === 'number' && isFinite(v.base) ? v.base : null, at: typeof v.at === 'number' && isFinite(v.at) ? v.at : 0 };
  }
  /** A photo is a JPEG data URL the page made, and nothing else. */
  function isPhoto(url) { return typeof url === 'string' && url.length <= PHOTO_MAX && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(url); }
  function cleanRefs(v) { return (Array.isArray(v) ? v : []).filter(function (r, i, a) { return typeof r === 'string' && REF.test(r) && a.indexOf(r) === i; }).slice(0, PHOTOS_MAX); }

  function create(backend) {
    var b = backend || memory();
    var api = {
      backend: b,
      persistent: function () { return Boolean(b.persistent); },
      /** The home, through the one door - or null. */
      getHome: function () {
        return b.get('home').then(function (v) {
          if (!v || typeof v !== 'object') return null;
          var h = C.cleanHome(v).home;
          delete h.updatedAt;
          return h;
        }, function () { return null; });
      },
      putHome: function (h) {
        if (!h) return b.del('home');
        var clean = C.cleanHome(h).home;
        delete clean.updatedAt;
        return b.put('home', clean);
      },
      getDevice: function () { return b.get('device').then(cleanDevice, function () { return cleanDevice({}); }); },
      putDevice: function (v) { return b.put('device', cleanDevice(v)); },
      getSync: function () { return b.get('sync').then(cleanSync, function () { return cleanSync({}); }); },
      putSync: function (v) { return b.put('sync', cleanSync(v)); },
      /** Which facts and appliances have a photo on this phone. */
      photoRefs: function () { return b.get('photos').then(cleanRefs, function () { return []; }); },
      getPhoto: function (ref) {
        if (!REF.test(String(ref))) return Promise.resolve(null);
        return b.get('photo:' + ref).then(function (v) { return isPhoto(v) ? v : null; }, function () { return null; });
      },
      putPhoto: function (ref, url) {
        if (!REF.test(String(ref))) return Promise.reject(new Error('That photo has nowhere to go.'));
        if (!isPhoto(url)) return Promise.reject(new Error('That photo could not be kept - try another.'));
        return api.photoRefs().then(function (refs) {
          if (refs.indexOf(ref) < 0 && refs.length >= PHOTOS_MAX) throw new Error('This phone keeps up to ' + PHOTOS_MAX + ' house photos - remove one first.');
          return b.put('photo:' + ref, url).then(function () { return b.put('photos', cleanRefs(refs.concat([ref]))); });
        });
      },
      delPhoto: function (ref) {
        return api.photoRefs().then(function (refs) {
          return b.del('photo:' + ref).then(function () { return b.put('photos', refs.filter(function (r) { return r !== ref; })); });
        });
      },
      clearAll: function () { return b.clear(); },
    };
    return api;
  }

  return { create: create, memory: memory, idb: idb, cleanDevice: cleanDevice, cleanSync: cleanSync, isPhoto: isPhoto, PHOTO_MAX: PHOTO_MAX, PHOTOS_MAX: PHOTOS_MAX };
}));
