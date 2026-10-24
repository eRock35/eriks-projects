/* Duo Hunt - the rules both sides share. UMD: window.DuoCore in the page,
 * require() on the server and in the tests.
 *
 * The models, the carrier links, ZIP validation, Apple's URLs by part number
 * (the iPhone Shortcut recipe's among them), what the watch can watch, "2 min
 * ago", what counts as "available" and the diff that fires the watch alert
 * all live here, so the page and the server cannot disagree about them. No
 * clock of its own: "now" is always handed in.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DuoCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Checked 2026-10-24 (CLAUDE.md has the sources). Prices are Apple's US
  // list prices as retailers quote them; the 256GB "from $1,999" is Apple's.
  var STORAGES = [
    { id: '256gb', label: '256GB', price: 1999 },
    { id: '512gb', label: '512GB', price: 2199 },
    { id: '1tb', label: '1TB', price: 2599 },
    { id: '2tb', label: '2TB', price: 3199 },
  ];
  var COLOURS = [
    { id: 'star-white', label: 'Star White', swatch: '#f1efe8' },
    { id: 'night-sky', label: 'Night Sky', swatch: '#1d2433' },
  ];
  var CARRIERS = [
    { id: 'unlocked', label: 'Unlocked' },
    { id: 'att', label: 'AT&T' },
    { id: 'verizon', label: 'Verizon' },
    { id: 'tmobile', label: 'T-Mobile' },
  ];
  var DEFAULT_PICK = { storage: '256gb', colour: 'star-white', carrier: 'unlocked' };

  // Apple's own pages. The buy page is confirmed; a product page by part
  // number (/shop/product/<part>) is the shape apple.com uses.
  var APPLE_BUY = 'https://www.apple.com/shop/buy-iphone/iphone-duo';
  var APPLE_STORES = 'https://www.apple.com/retail/';
  // The pickup JSON apple.com's own product page asks when you tap "Check
  // availability". Apple answers it with a block page (HTTP 541) to anything
  // on Google's network (measured 2026-10-24), so the server only asks it
  // when DUOHUNT_APPLE_SERVER_CHECK=1; the iPhone Shortcut asks it from the
  // phone. Both build the URL here, so they ask the same question.
  var APPLE_FULFILLMENT = 'https://www.apple.com/shop/fulfillment-messages';
  // An Apple US part number: five letters or digits, then LL/A ("MK1E4LL/A").
  var PART_RE = /^[A-Z0-9]{5}LL\/A$/;
  var APPLE_BLOCKED = 'Apple turns away stock checks from servers, so we can’t ask it for you. Open Apple’s page for this model and tap Check availability, or let your iPhone ask.';
  var BESTBUY_SEARCH = 'https://www.bestbuy.com/site/searchpage.jsp?st=iphone+duo';
  var BESTBUY_STORES = 'https://www.bestbuy.com/site/store-locator';

  // The carriers: links only. No server request ever goes to these hosts.
  // Each product URL was found on the carrier's own site (2026-10-24).
  var CARRIER_LINKS = {
    att: {
      name: 'AT&T',
      product: 'https://www.att.com/buy/phones/apple-iphone-duo.html',
      stores: 'https://www.att.com/stores/',
    },
    verizon: {
      name: 'Verizon',
      product: 'https://www.verizon.com/smartphones/apple-iphone-duo/',
      stores: 'https://www.verizon.com/stores/',
    },
    tmobile: {
      name: 'T-Mobile',
      product: 'https://www.t-mobile.com/cell-phone/apple-iphone-duo',
      stores: 'https://www.t-mobile.com/stores',
    },
  };
  var CARRIER_IDS = ['att', 'verizon', 'tmobile'];

  function find(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /** A pick from anywhere (a request, localStorage) -> a valid pick, or null. */
  function cleanPick(p) {
    if (!p || typeof p !== 'object') return null;
    var s = find(STORAGES, p.storage), c = find(COLOURS, p.colour), k = find(CARRIERS, p.carrier);
    if (!s || !c || !k) return null;
    return { storage: s.id, colour: c.id, carrier: k.id };
  }
  function pickLabel(p) {
    var q = cleanPick(p);
    if (!q) return '';
    return 'iPhone Duo ' + find(STORAGES, q.storage).label + ' ' + find(COLOURS, q.colour).label + ' (' + find(CARRIERS, q.carrier).label + ')';
  }
  function priceOf(p) {
    var q = cleanPick(p);
    return q ? find(STORAGES, q.storage).price : null;
  }

  /** A US ZIP: exactly five digits, nothing else (ZIP+4 is cut to five). */
  function cleanZip(z) {
    var s = String(z == null ? '' : z).trim();
    if (/^\d{5}-\d{4}$/.test(s)) s = s.slice(0, 5);
    return /^\d{5}$/.test(s) ? s : null;
  }

  /** Text from upstream or storage: no markup, no control or direction
   *  characters, whitespace collapsed, bounded. */
  function clean(v, max) {
    if (typeof v !== 'string' && typeof v !== 'number') return '';
    var s = String(v).slice(0, 4000)
      .replace(/<[^>]*>?/g, ' ')
      .replace(/[<>]/g, '')
      .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return s.slice(0, max || 120);
  }

  /** A part number for a URL: encoded, the slash kept (legal in a path and a
   *  query, and what apple.com itself writes). Only ever a PART_RE match. */
  function encPart(part) { return encodeURIComponent(part).replace(/%2F/g, '/'); }
  function validPart(part) { return typeof part === 'string' && PART_RE.test(part); }

  /** Apple's page for one exact model; the buy page for anything else. */
  function appleProductUrl(part) {
    return validPart(part) ? 'https://www.apple.com/shop/product/' + encPart(part) : APPLE_BUY;
  }

  /** Apple's pickup question for one part near one ZIP - the URL the server
   *  asks (when switched on) and the one the iPhone Shortcut recipe hands
   *  out. Null unless the part is an Apple part and the ZIP five digits, so
   *  nothing else can be smuggled into it. */
  function fulfillmentUrl(part, zip) {
    var z = cleanZip(zip);
    if (!validPart(part) || !z) return null;
    return APPLE_FULFILLMENT + '?pl=true&mts.0=regular&parts.0=' + encPart(part) + '&location=' + encodeURIComponent(z);
  }

  /** What "Watch on this tab" can watch: only what the server checks live.
   *  Apple is live only when the server check is switched on; Best Buy only
   *  once its key is connected. Nothing live -> the switch is off, with why. */
  var WATCH_OFF = 'Nothing live to watch until Best Buy is connected - use ‘Check from my iPhone’ for Apple.';
  function watchPlan(meta) {
    var live = [];
    if (meta && meta.appleServerCheck === true) live.push('Apple');
    if (meta && meta.bestbuy === true) live.push('Best Buy');
    if (!meta) return { enabled: false, live: live, text: 'Re-checks Best Buy every 5 minutes while this tab stays open, and alerts you when it turns up.' };
    if (!live.length) return { enabled: false, live: live, text: WATCH_OFF };
    return { enabled: true, live: live, text: 'Re-checks ' + live.join(' and ') + ' every 5 minutes while this tab stays open, and alerts you when it turns up.' };
  }

  /** Only https links to a host we expect become links. */
  function safeUrl(u, hosts) {
    if (typeof u !== 'string' || u.length > 600) return null;
    var m = /^https:\/\/([a-z0-9.-]+)(\/[^\s"'<>]*)?$/i.exec(u);
    if (!m) return null;
    var host = m[1].toLowerCase();
    for (var i = 0; i < hosts.length; i++) {
      if (host === hosts[i] || host.slice(-(hosts[i].length + 1)) === '.' + hosts[i]) return u;
    }
    return null;
  }

  /** "just now", "2 min ago", "3 h ago", "yesterday", "4 days ago". */
  function ago(atMs, nowMs) {
    if (typeof atMs !== 'number' || !isFinite(atMs)) return '';
    var s = Math.max(0, Math.round((nowMs - atMs) / 1000));
    if (s < 45) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    var d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : d + ' days ago';
  }

  /** Is anything in a check result something you could buy now? */
  function availableIn(result) {
    var out = [];
    if (!result) return out;
    var a = result.apple;
    if (a && a.state === 'ok' && Array.isArray(a.stores)) {
      a.stores.forEach(function (s) { if (s.status === 'available') out.push('apple:' + s.name); });
    }
    var b = result.bestbuy;
    if (b && b.state === 'ok' && b.product) {
      if (b.product.online) out.push('bestbuy:online');
      (b.stores || []).forEach(function (s) { out.push('bestbuy:' + s.name); });
    }
    return out;
  }
  /** What is available now that was not in the previous check. */
  function newlyAvailable(prev, next) {
    var had = {};
    availableIn(prev).forEach(function (k) { had[k] = true; });
    return availableIn(next).filter(function (k) { return !had[k]; });
  }

  /** One line for the history list. */
  function summary(result) {
    if (!result) return '';
    var parts = [];
    var a = result.apple;
    if (a) {
      if (a.state === 'ok') {
        var n = (a.stores || []).filter(function (s) { return s.status === 'available'; }).length;
        parts.push(n ? 'Apple: ' + n + (n === 1 ? ' store' : ' stores') + ' today' : 'Apple: none today');
      } else if (a.state === 'blocked') parts.push('Apple: check from your iPhone');
      else if (a.state === 'not-configured') parts.push('Apple: not set up');
      else parts.push('Apple: couldn’t check');
    }
    var b = result.bestbuy;
    if (b) {
      if (b.state === 'ok') {
        var on = b.product && b.product.online;
        var st = (b.stores || []).length;
        parts.push('Best Buy: ' + (on ? 'online' : 'not online') + (st ? ', ' + st + (st === 1 ? ' store' : ' stores') : ''));
      } else if (b.state === 'not-connected') parts.push('Best Buy: not connected');
      else if (b.state === 'not-listed') parts.push('Best Buy: not listed');
      else parts.push('Best Buy: couldn’t check');
    }
    return parts.join(' · ');
  }

  var HISTORY_MAX = 20;
  function pushHistory(list, entry) {
    var l = Array.isArray(list) ? list.slice() : [];
    l.unshift(entry);
    return l.slice(0, HISTORY_MAX);
  }

  var CARRIER_RESULTS = ['nothing', 'in-stock'];
  /** The carriers' "I looked" notes from localStorage -> clean. */
  function cleanNotes(n) {
    var out = {};
    if (!n || typeof n !== 'object') return out;
    CARRIER_IDS.forEach(function (id) {
      var v = n[id];
      if (v && typeof v.at === 'number' && isFinite(v.at) && CARRIER_RESULTS.indexOf(v.result) >= 0) out[id] = { at: v.at, result: v.result };
    });
    return out;
  }

  var WATCH_MS = 5 * 60 * 1000;

  return {
    STORAGES: STORAGES, COLOURS: COLOURS, CARRIERS: CARRIERS, DEFAULT_PICK: DEFAULT_PICK,
    APPLE_BUY: APPLE_BUY, APPLE_STORES: APPLE_STORES, BESTBUY_SEARCH: BESTBUY_SEARCH, BESTBUY_STORES: BESTBUY_STORES,
    APPLE_FULFILLMENT: APPLE_FULFILLMENT, PART_RE: PART_RE, APPLE_BLOCKED: APPLE_BLOCKED, WATCH_OFF: WATCH_OFF,
    validPart: validPart, appleProductUrl: appleProductUrl, fulfillmentUrl: fulfillmentUrl, watchPlan: watchPlan,
    CARRIER_LINKS: CARRIER_LINKS, CARRIER_IDS: CARRIER_IDS, HISTORY_MAX: HISTORY_MAX, WATCH_MS: WATCH_MS,
    find: find, cleanPick: cleanPick, pickLabel: pickLabel, priceOf: priceOf, cleanZip: cleanZip,
    clean: clean, safeUrl: safeUrl, ago: ago, availableIn: availableIn, newlyAvailable: newlyAvailable,
    summary: summary, pushHistory: pushHistory, cleanNotes: cleanNotes,
  };
}));
