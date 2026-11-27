/* Doorbuster - what this phone keeps, in one module. The page never touches
 * storage itself.
 *
 *   doorbuster-list-v1   the sales this phone has opened: [{id, shop, title,
 *                        from, to}] - the ids alone open nothing (the
 *                        browser's key is an HttpOnly cookie the page
 *                        cannot read)
 *   doorbuster-prefs-v1  {name (the first name last used), cur (the sale on
 *                        screen), tab}
 *   doorbuster-last-v1   the last copy of the sale on screen, as the server
 *                        sent it to THIS phone (a staff phone's copy has no
 *                        costs in it, because it was never sent any), with
 *                        when it was read - so the deals, the signs and the
 *                        last counts still open with the network off. One
 *                        sale, replaced by the next; cleared on leave/delete.
 *
 * Taps on the tally are NOT kept here for later: a tally needs the network,
 * and the page says so.
 *
 * localStorage, every access wrapped: in a private window or with storage
 * blocked it works in memory.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./doorbuster-core'));
  else root.DoorbusterStore = factory(root.DoorbusterCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var KEYS = { list: 'doorbuster-list-v1', prefs: 'doorbuster-prefs-v1', last: 'doorbuster-last-v1' };
  var MAX = 30;
  var TABS = ['today', 'deals', 'items', 'signs', 'team'];

  function cleanList(v) {
    var seen = {};
    return (Array.isArray(v) ? v : []).filter(function (g) { if (!g || !C.isGid(g.id) || seen[g.id]) return false; seen[g.id] = 1; return true; }).slice(0, MAX).map(function (g) {
      return { id: g.id, shop: C.line(g.shop, C.LIMITS.shop), title: C.line(g.title, C.LIMITS.title), from: C.isDay(g.from) ? g.from : '', to: C.isDay(g.to) ? g.to : '' };
    });
  }
  function cleanPrefs(v) {
    var o = v && typeof v === 'object' ? v : {};
    return { name: C.cleanName(o.name), cur: C.isGid(o.cur) ? o.cur : '', tab: TABS.indexOf(o.tab) >= 0 ? o.tab : 'today' };
  }
  /** The last copy: kept only if it still has the shape of a sale. */
  function cleanLast(v) {
    var o = v && typeof v === 'object' ? v : {}, g = o.g;
    if (!g || typeof g !== 'object' || !C.isGid(g.id) || !C.isDay(g.from) || !C.isDay(g.to) || !Array.isArray(g.items) || !Array.isArray(g.deals) || !Array.isArray(g.members)) return null;
    return { g: g, at: typeof o.at === 'number' && o.at > 0 ? o.at : 0 };
  }

  /** A backend: `ls` is window.localStorage (or a stand-in); anything that
   *  throws falls back to memory. */
  function create(ls) {
    var mem = {}, ok = true;
    try { var k = '__doorbuster_probe'; ls.setItem(k, '1'); ls.removeItem(k); } catch (e) { ok = false; }
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
