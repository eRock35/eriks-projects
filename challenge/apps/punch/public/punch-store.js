/* Punch - the ONE storage module. Nothing else on the page touches browser
 * storage, and nothing goes through here without passing PunchCore's door
 * (cleanBook) or a check of its own:
 *
 *   book       the punch lists on this phone - jobs, areas, pins and
 *              sign-offs, TEXT only - through PunchCore.cleanBook
 *   photo:<a>  an area's "before" photo
 *   after:<p>  a fix's "after" photo
 *   sign:<j>   the client's drawn signature on a job's closeout
 *              All three are kept ON THIS PHONE ONLY. A photo is redrawn
 *              through a canvas first (location, camera and every other
 *              detail the file carried are gone) and kept as a JPEG data
 *              URL; a signature is the PNG the signing pad drew. None of
 *              them is ever synced or sent: they leave the phone only
 *              inside a closeout the person prints or saves.
 *   device     this phone's own flags: the tour seen, the name printed on
 *              the closeout ("Prepared by") - never synced
 *   sync       the account copy's time this phone last saw, and when
 *
 * Two backends: IndexedDB (what the page uses) and memory (the example -
 * never saved - and the tests). Every IndexedDB access is wrapped: a
 * private window, a blocked database, one that throws or a full disk falls
 * back to memory and says so (`persistent()` turns false), and the page
 * still works.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./punch-core'));
  else root.PunchStore = factory(root.PunchCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var PHOTO_MAX = 2200 * 1024;   // characters of data URL, about 1.6 MB of JPEG
  var SIGN_MAX = 400 * 1024;     // a signature PNG
  var PICS_MAX = 900;            // photos, afters and signatures on one phone
  var REF = /^(photo:a|after:p|sign:j)[a-z0-9]{6,12}$/;

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
          var req = IDB.open(name || 'punch', 1);
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
    var by = typeof v.by === 'string' ? C.line(v.by, 60) : '';
    return { tour: v.tour === true, by: by && !C.refuse(by, 60) ? by : '' };
  }
  function cleanSync(v) {
    v = v && typeof v === 'object' ? v : {};
    return { base: typeof v.base === 'number' && isFinite(v.base) ? v.base : null, at: typeof v.at === 'number' && isFinite(v.at) ? v.at : 0 };
  }
  /** A photo is a JPEG data URL the page made; a signature a PNG one. */
  function isPhoto(url) { return typeof url === 'string' && url.length <= PHOTO_MAX && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(url); }
  function isSign(url) { return typeof url === 'string' && url.length <= SIGN_MAX && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(url); }
  function fits(ref, url) { return ref.indexOf('sign:') === 0 ? isSign(url) : isPhoto(url); }
  function cleanRefs(v) { return (Array.isArray(v) ? v : []).filter(function (r, i, a) { return typeof r === 'string' && REF.test(r) && a.indexOf(r) === i; }).slice(0, PICS_MAX); }

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
      /** Which pictures this phone holds ("photo:a...", "after:p...", "sign:j..."). */
      refs: function () { return b.get('pics').then(cleanRefs, function () { return []; }); },
      getPic: function (ref) {
        ref = String(ref);
        if (!REF.test(ref)) return Promise.resolve(null);
        return b.get(ref).then(function (v) { return fits(ref, v) ? v : null; }, function () { return null; });
      },
      putPic: function (ref, url) {
        ref = String(ref);
        if (!REF.test(ref)) return Promise.reject(new Error('That picture has nowhere to go.'));
        if (!fits(ref, url)) return Promise.reject(new Error(ref.indexOf('sign:') === 0 ? 'That signature could not be kept - sign again.' : 'That photo could not be kept - try another.'));
        return api.refs().then(function (refs) {
          if (refs.indexOf(ref) < 0 && refs.length >= PICS_MAX) throw new Error('This phone keeps up to ' + PICS_MAX + ' photos in Punch - remove an old job first.');
          return b.put(ref, url).then(function () { return b.put('pics', cleanRefs(refs.concat([ref]))); });
        });
      },
      delPic: function (ref) {
        return api.refs().then(function (refs) {
          return b.del(String(ref)).then(function () { return b.put('pics', refs.filter(function (r) { return r !== ref; })); });
        });
      },
      clearAll: function () { return b.clear(); },
    };
    return api;
  }

  return { create: create, memory: memory, idb: idb, cleanDevice: cleanDevice, cleanSync: cleanSync, isPhoto: isPhoto, isSign: isSign, PHOTO_MAX: PHOTO_MAX, SIGN_MAX: SIGN_MAX, PICS_MAX: PICS_MAX, REF: REF };
}));
