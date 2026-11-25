/* Arrivals - what this phone keeps, in one module. The page never touches
 * storage itself.
 *
 *   arrivals-list-v1   the gatherings this phone has opened: [{id, title,
 *                      place, from, to}] - the ids alone open nothing (the
 *                      browser's key is an HttpOnly cookie the page cannot
 *                      read)
 *   arrivals-prefs-v1  {name (the first name last used), cur (the gathering
 *                      on screen), tab}
 *
 * localStorage, every access wrapped: in a private window or with storage
 * blocked it works in memory.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./arrivals-core'));
  else root.ArrivalsStore = factory(root.ArrivalsCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var KEYS = { list: 'arrivals-list-v1', prefs: 'arrivals-prefs-v1' };
  var MAX = 30;

  function cleanList(v) {
    var seen = {};
    return (Array.isArray(v) ? v : []).filter(function (g) { if (!g || !C.isGid(g.id) || seen[g.id]) return false; seen[g.id] = 1; return true; }).slice(0, MAX).map(function (g) {
      return { id: g.id, title: C.line(g.title, C.LIMITS.title), place: C.line(g.place, C.LIMITS.place), from: C.isDay(g.from) ? g.from : '', to: C.isDay(g.to) ? g.to : '' };
    });
  }
  function cleanPrefs(v) {
    var o = v && typeof v === 'object' ? v : {};
    return { name: C.cleanName(o.name), cur: C.isGid(o.cur) ? o.cur : '', tab: ['board', 'pickups', 'group'].indexOf(o.tab) >= 0 ? o.tab : 'board' };
  }

  /** A backend: `ls` is window.localStorage (or a stand-in); anything that
   *  throws falls back to memory. */
  function create(ls) {
    var mem = {}, ok = true;
    try { var k = '__arrivals_probe'; ls.setItem(k, '1'); ls.removeItem(k); } catch (e) { ok = false; }
    function get(key) { if (ok) { try { return ls.getItem(key); } catch (e) { ok = false; } } return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null; }
    function set(key, val) { mem[key] = val; if (ok) { try { ls.setItem(key, val); } catch (e) { ok = false; } } }
    function del(key) { delete mem[key]; if (ok) { try { ls.removeItem(key); } catch (e) { ok = false; } } }
    function json(key) { try { var s = get(key); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
    return {
      persistent: function () { return ok; },
      getList: function () { return cleanList(json(KEYS.list)); },
      putList: function (l) { set(KEYS.list, JSON.stringify(cleanList(l))); },
      getPrefs: function () { return cleanPrefs(json(KEYS.prefs)); },
      putPrefs: function (p) { set(KEYS.prefs, JSON.stringify(cleanPrefs(p))); },
      clearAll: function () { Object.keys(KEYS).forEach(function (k) { del(KEYS[k]); }); },
    };
  }
  function local() { try { return create(window.localStorage); } catch (e) { return create(null); } }

  return { KEYS: KEYS, MAX: MAX, create: create, local: local, cleanList: cleanList, cleanPrefs: cleanPrefs };
}));
