/* Trek - what this phone keeps, in one module. The page never touches
 * storage itself.
 *
 *   trek-treks-v1  the trek history ({id: trek}), through the one door
 *                  (TrekCore.cleanTreks, lenient) on every read
 *   trek-now-v1    what is on the go: {trek: id} for a trek on this phone,
 *                  or {crew: id, trek: id} for a crew (the crew id alone -
 *                  the browser's key is an HttpOnly cookie the page cannot
 *                  read)
 *   trek-prefs-v1  {name (the first name last used), tour (seen), unit
 *                  (km or mi), kind (the last activity logged)}
 *   trek-sync-v1   {base, at}: the account copy this phone last agreed with
 *
 * localStorage, every access wrapped: in a private window or with storage
 * blocked it works in memory and says once that nothing will be kept.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./trek-core'));
  else root.TrekStore = factory(root.TrekCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var KEYS = { treks: 'trek-treks-v1', now: 'trek-now-v1', prefs: 'trek-prefs-v1', sync: 'trek-sync-v1' };

  function cleanNow(v) {
    var o = v && typeof v === 'object' ? v : {};
    var out = {};
    if (C.isId(o.trek)) out.trek = o.trek;
    if (C.isGid(o.crew) && out.trek) out.crew = o.crew;
    return out;
  }
  function cleanPrefs(v) {
    var o = v && typeof v === 'object' ? v : {};
    return { name: C.cleanName(o.name), tour: o.tour === true, unit: o.unit === 'mi' ? 'mi' : 'km', kind: C.isKind(o.kind) ? o.kind : 'walk' };
  }
  function cleanSync(v) { var o = v && typeof v === 'object' ? v : {}; return { base: typeof o.base === 'number' && isFinite(o.base) ? o.base : null, at: typeof o.at === 'number' && isFinite(o.at) ? o.at : 0 }; }

  /** A backend: `ls` is window.localStorage (or a stand-in); anything that
   *  throws falls back to memory. */
  function create(ls) {
    var mem = {}, ok = true;
    try { var k = '__trek_probe'; ls.setItem(k, '1'); ls.removeItem(k); } catch (e) { ok = false; }
    function get(key) { if (ok) { try { return ls.getItem(key); } catch (e) { ok = false; } } return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null; }
    function set(key, val) { mem[key] = val; if (ok) { try { ls.setItem(key, val); } catch (e) { ok = false; } } }
    function del(key) { delete mem[key]; if (ok) { try { ls.removeItem(key); } catch (e) { ok = false; } } }
    function json(key) { try { var s = get(key); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
    return {
      persistent: function () { return ok; },
      getTreks: function () { return C.cleanTreks(json(KEYS.treks) || {}).treks; },
      putTreks: function (t) { set(KEYS.treks, JSON.stringify(C.trimTreks(t))); },
      getNow: function () { return cleanNow(json(KEYS.now)); },
      putNow: function (n) { set(KEYS.now, JSON.stringify(cleanNow(n))); },
      getPrefs: function () { return cleanPrefs(json(KEYS.prefs)); },
      putPrefs: function (p) { set(KEYS.prefs, JSON.stringify(cleanPrefs(p))); },
      getSync: function () { return cleanSync(json(KEYS.sync)); },
      putSync: function (s) { set(KEYS.sync, JSON.stringify(cleanSync(s))); },
      clearAll: function () { Object.keys(KEYS).forEach(function (k) { del(KEYS[k]); }); },
    };
  }
  function local() { try { return create(window.localStorage); } catch (e) { return create(null); } }

  return { KEYS: KEYS, create: create, local: local, cleanNow: cleanNow, cleanPrefs: cleanPrefs, cleanSync: cleanSync };
}));
