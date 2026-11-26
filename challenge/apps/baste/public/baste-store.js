/* Baste - what this phone keeps, in one module. The page never touches
 * storage itself.
 *
 *   baste-list-v1   the dinners this phone has opened: [{id, title,
 *                   eatLocal}] - the ids alone open nothing (the browser's
 *                   key is an HttpOnly cookie the page cannot read)
 *   baste-prefs-v1  {name (the first name last used), cur (the dinner on
 *                   screen), tab}
 *   baste-last-v1   the last copy of the dinner on screen, as the server
 *                   sent it, with when it was read - so the timeline and
 *                   its countdowns still open with the network off. One
 *                   dinner, replaced by the next; cleared on leave/delete.
 *
 * localStorage, every access wrapped: in a private window or with storage
 * blocked it works in memory.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./baste-core'));
  else root.BasteStore = factory(root.BasteCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var KEYS = { list: 'baste-list-v1', prefs: 'baste-prefs-v1', last: 'baste-last-v1' };
  var MAX = 30;
  var TABS = ['today', 'plan', 'dishes', 'helpers'];

  function cleanList(v) {
    var seen = {};
    return (Array.isArray(v) ? v : []).filter(function (g) { if (!g || !C.isGid(g.id) || seen[g.id]) return false; seen[g.id] = 1; return true; }).slice(0, MAX).map(function (g) {
      return { id: g.id, title: C.line(g.title, C.LIMITS.title), eatLocal: C.isLocal(g.eatLocal) ? g.eatLocal : '' };
    });
  }
  function cleanPrefs(v) {
    var o = v && typeof v === 'object' ? v : {};
    return { name: C.cleanName(o.name), cur: C.isGid(o.cur) ? o.cur : '', tab: TABS.indexOf(o.tab) >= 0 ? o.tab : 'today' };
  }
  /** The last copy: kept only if it still has the shape of a dinner. */
  function cleanLast(v) {
    var o = v && typeof v === 'object' ? v : {}, g = o.g;
    if (!g || typeof g !== 'object' || !C.isGid(g.id) || !C.isLocal(g.eatLocal) || !C.isZone(g.tz) || typeof g.eatAt !== 'number' || !Array.isArray(g.dishes) || !Array.isArray(g.members) || !C.isObj(g.done) || !C.isObj(g.claims)) return null;
    return { g: g, at: typeof o.at === 'number' && o.at > 0 ? o.at : 0 };
  }

  /** A backend: `ls` is window.localStorage (or a stand-in); anything that
   *  throws falls back to memory. */
  function create(ls) {
    var mem = {}, ok = true;
    try { var k = '__baste_probe'; ls.setItem(k, '1'); ls.removeItem(k); } catch (e) { ok = false; }
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
      getLast: function () { return cleanLast(json(KEYS.last)); },
      putLast: function (g, at) { var c = cleanLast({ g: g, at: at }); if (c) set(KEYS.last, JSON.stringify(c)); },
      clearLast: function () { del(KEYS.last); },
      clearAll: function () { Object.keys(KEYS).forEach(function (k) { del(KEYS[k]); }); },
    };
  }
  function local() { try { return create(window.localStorage); } catch (e) { return create(null); } }

  return { KEYS: KEYS, MAX: MAX, TABS: TABS, create: create, local: local, cleanList: cleanList, cleanPrefs: cleanPrefs, cleanLast: cleanLast };
}));
