/* Stroll - what this phone keeps, in one module. The page never touches
 * storage itself.
 *
 *   stroll-list-v1   the passports this phone has opened: [{id, title,
 *                    place, from, to, role}] - the ids alone open nothing
 *                    (the browser's key is an HttpOnly cookie the page
 *                    cannot read)
 *   stroll-prefs-v1  {name (the first name last used), cur (the passport on
 *                    screen), tab}
 *   stroll-last-v1   the last copy of the passport on screen, as the server
 *                    sent it to THIS phone (a shopper's copy has no counter
 *                    codes in it, because it was never sent any) - so the
 *                    stamps, the shops and the perks still open on a street
 *                    with no signal. One passport, replaced by the next.
 *
 * A stamp is NOT kept here for later: stamping needs the network, and the
 * page says so.
 *
 * localStorage, every access wrapped: in a private window or with storage
 * blocked it works in memory.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stroll-core'));
  else root.StrollStore = factory(root.StrollCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var KEYS = { list: 'stroll-list-v1', prefs: 'stroll-prefs-v1', last: 'stroll-last-v1' };
  var MAX = 30;
  var HOST_TABS = ['overview', 'shops', 'signs', 'draw'];
  var CARD_TABS = ['passport', 'perks', 'about'];
  var TABS = HOST_TABS.concat(CARD_TABS);

  function cleanList(v) {
    var seen = {};
    return (Array.isArray(v) ? v : []).filter(function (g) { if (!g || !C.isGid(g.id) || seen[g.id]) return false; seen[g.id] = 1; return true; }).slice(0, MAX).map(function (g) {
      return { id: g.id, title: C.line(g.title, C.LIMITS.title), place: C.line(g.place, C.LIMITS.place), from: C.isDay(g.from) ? g.from : '', to: C.isDay(g.to) ? g.to : '', role: g.role === 'host' ? 'host' : 'card' };
    });
  }
  function cleanPrefs(v) {
    var o = v && typeof v === 'object' ? v : {};
    return { name: C.cleanName(o.name), cur: C.isGid(o.cur) ? o.cur : '', tab: TABS.indexOf(o.tab) >= 0 ? o.tab : '' };
  }
  /** The last copy: kept only if it still has the shape of a passport. */
  function cleanLast(v) {
    var o = v && typeof v === 'object' ? v : {}, g = o.g;
    if (!g || typeof g !== 'object' || !C.isGid(g.id) || !C.isDay(g.from) || !C.isDay(g.to) || !Array.isArray(g.shops) || (g.role !== 'host' && g.role !== 'card')) return null;
    if (g.role === 'card' && (!g.me || typeof g.me !== 'object')) return null;
    if (g.role === 'host' && (!g.counts || !Array.isArray(g.winners))) return null;
    return { g: g, at: typeof o.at === 'number' && o.at > 0 ? o.at : 0 };
  }

  /** A backend: `ls` is window.localStorage (or a stand-in); anything that
   *  throws falls back to memory. */
  function create(ls) {
    var mem = {}, ok = true;
    try { var k = '__stroll_probe'; ls.setItem(k, '1'); ls.removeItem(k); } catch (e) { ok = false; }
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

  return { KEYS: KEYS, MAX: MAX, TABS: TABS, HOST_TABS: HOST_TABS, CARD_TABS: CARD_TABS, create: create, local: local, cleanList: cleanList, cleanPrefs: cleanPrefs, cleanLast: cleanLast };
}));
