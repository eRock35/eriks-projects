/* Stroll - the rules, in one file, run three times: in the page
 * (window.StrollCore), on the server and in the tests (require).
 *
 * A stroll is a shop-local passport: a street's shops, a few days, a number
 * of stamps to collect and a prize. A shopper's passport is a CARD: a first
 * name and one stamp per shop, each got by scanning (or typing) the code on
 * that shop's counter sign. A finished card is in the prize draw.
 *
 * What is decided here: what a stroll, a shop and a name may hold; when
 * stamping is open; what a stamp code opens; how far a card has got and how
 * many entries it has; who is in the draw and who is picked (the dice are
 * handed in); what each phone may see (a shopper is never sent a stamp
 * code); the words on a counter sign and the poster.
 *
 * NO CLOCK AND NO DICE: "today", "now", every new id, every new code and
 * the draw's pick are handed in (tested), so the same input gives the same
 * answer on every phone and on the server.
 *
 * NOTHING ABOUT A SHOPPER BUT A FIRST NAME: every text field passes
 * `refuse` (no email address, no link, no phone number, no markup).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StrollCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    name: 20,      // a first name
    title: 60,     // "Maple Street Shop Small Passport"
    place: 60,     // "Maple Street, Riverton"
    prize: 120,    // "A $100 basket from the shops"
    shop: 40,      // a shop's name
    perk: 80,      // "10% off candles when you show your passport"
    shops: 40,     // shops in a stroll (refused, never cut)
    batch: 40,     // shops added in one go
    cards: 1500,   // passports in a stroll
    days: 31,      // first to last day
    keepDays: 30,  // kept this long after the last day
    winners: 5,    // draws per stroll
    wrong: 10,     // wrong stamp codes one passport may try in 15 minutes
  };
  var HOST_ONLY = 'Only the organizer of this passport can do that.';

  function fail(status, message, extra) {
    var e = new Error(message);
    e.status = status; e.expose = true;
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    return e;
  }
  function own(o, k) { return Boolean(o) && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

  /* ------------------------------------------------------------------ *
   * Text
   * ------------------------------------------------------------------ */

  // Control characters, zero-width and bidirectional marks.
  var INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  function line(v, max) {
    var s = str(v).slice(0, (max || 200) * 8).replace(/<[^>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    var cps = Array.from(s);
    return cps.length > max ? cps.slice(0, max).join('').trim() : s;
  }
  function esc(v) { return str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function norm(v) { return line(v, 80).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  function cleanName(v) {
    var s = line(v, LIMITS.name * 2).replace(/[^\p{L}\p{M}' ’.-]/gu, ' ').replace(/\s+/g, ' ').replace(/^[ '.’-]+|[ '.’-]+$/g, '').trim();
    s = Array.from(s).slice(0, LIMITS.name).join('').trim();
    return /\p{L}/u.test(s) ? s : '';
  }
  /** Why a piece of free text is not kept - or ''. Stroll collects no email
   *  address, no phone number and nothing else about a shopper, and this is
   *  where that is held: every text field passes here. */
  function refuse(v) {
    var s = str(v);
    if (/[@＠﹫]/.test(s)) return 'No email addresses, please - Stroll keeps shop names and first names only.';
    if (/[a-z][a-z0-9+.-]*:\/\/|\bwww\./i.test(s)) return 'No links, please.';
    if (/\p{Nd}(?:[\s.\-()]*\p{Nd}){6}/u.test(s)) return 'No phone numbers or long numbers, please - Stroll keeps shop names and first names only.';
    if (/[<>]/.test(s)) return 'No markup, please.';
    return '';
  }
  /** A text field: refused with a reason, or cleaned to `max`. */
  function field(v, max, label) {
    var why = refuse(v);
    if (why) throw fail(400, (label ? label + ': ' : '') + why);
    return line(v, max);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function initials(name) { var w = String(name || '?').split(/[\s+&-]+/).filter(Boolean); return (w.length > 1 ? Array.from(w[0])[0] + Array.from(w[w.length - 1])[0] : Array.from(w[0] || '?').slice(0, 2).join('')).toUpperCase(); }

  /* ------------------------------------------------------------------ *
   * Ids and codes
   * ------------------------------------------------------------------ */

  var ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
  function newId(rand, n, prefix) { var s = prefix || ''; for (var i = 0; i < (n || 8); i++) s += ID_CHARS[rand(ID_CHARS.length)]; return s; }
  function isId(v) { return typeof v === 'string' && /^[a-z][a-z0-9]{5,24}$/.test(v); }
  // No 0/O, 1/I: a code is read off a sign and typed with thumbs.
  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var CODE_LEN = 6;   // the passport's join code
  var STAMP_LEN = 4;  // a shop's counter code
  function normalizeCode(v) { return str(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
  function inAlphabet(v, len) { return typeof v === 'string' && v.length === len && v.split('').every(function (c) { return CODE_ALPHABET.indexOf(c) >= 0; }); }
  function isCode(v) { return inAlphabet(v, CODE_LEN); }
  function isStamp(v) { return inAlphabet(v, STAMP_LEN); }
  function formatCode(v) { var c = normalizeCode(v); return c.slice(0, 3) + '-' + c.slice(3); }
  function isGid(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{16}$/.test(v); }
  function isTag(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{32}$/.test(v); }

  /* ------------------------------------------------------------------ *
   * Days: calendar dates as YYYY-MM-DD
   * ------------------------------------------------------------------ */

  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function isDay(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var d = new Date(v + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === v && v >= '2000-01-01' && v <= '2100-12-31';
  }
  function dayMs(day) { return Date.parse(day + 'T00:00:00Z'); }
  function addDays(day, n) { return new Date(dayMs(day) + n * 86400000).toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / 86400000); }
  function weekday(day) { return WEEKDAYS[new Date(dayMs(day)).getUTCDay()]; }
  function dayShort(day) { return MONTHS[Number(day.slice(5, 7)) - 1] + ' ' + Number(day.slice(8)); }
  /** "Saturday, Nov 28" */
  function dayLong(day) { return weekday(day) + ', ' + dayShort(day); }
  /** "Nov 27 - 30" or "Nov 29 - Dec 2" */
  function dateRange(from, to) {
    var a = dayShort(from);
    if (from === to) return a;
    return a + ' - ' + (from.slice(0, 7) === to.slice(0, 7) ? '' : MONTHS[Number(to.slice(5, 7)) - 1] + ' ') + Number(to.slice(8));
  }
  function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function intIn(v, lo, hi, dflt) {
    var n = typeof v === 'string' && /^\d{1,6}$/.test(v) ? Number(v) : v;
    return typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
  }

  /* ------------------------------------------------------------------ *
   * What a stroll and a shop may hold
   * ------------------------------------------------------------------ */

  /** The passport's details: its name, the street, the days, how many
   *  stamps finish a card, whether stamps past that are extra entries, and
   *  the prize. Refused with a reason, never quietly changed. */
  function cleanStroll(b, today) {
    b = isObj(b) ? b : {};
    var title = field(b.title, LIMITS.title, 'The passport’s name');
    if (!title) throw fail(400, 'Give the passport a name - “Maple Street Shop Small Passport”.');
    var place = field(b.place, LIMITS.place, 'The street or town');
    if (!isDay(b.from) || !isDay(b.to)) throw fail(400, 'Pick the first and the last day.');
    if (b.to < b.from) throw fail(400, 'The last day is before the first.');
    if (daysBetween(b.from, b.to) + 1 > LIMITS.days) throw fail(400, 'A passport runs for up to ' + LIMITS.days + ' days.');
    if (isDay(today) && b.to < addDays(today, -1)) throw fail(400, 'Those days are already over.');
    var goal = intIn(b.goal, 1, LIMITS.shops, null);
    if (goal === null) throw fail(400, 'How many stamps finish a passport? Type a number from 1 to ' + LIMITS.shops + '.');
    var prize = field(b.prize, LIMITS.prize, 'The prize');
    return { title: title, place: place, from: b.from, to: b.to, goal: goal, bonus: b.bonus !== false, prize: prize };
  }
  function cleanShop(b) {
    b = isObj(b) ? b : { name: b };
    var name = field(b.name, LIMITS.shop, 'The shop’s name');
    if (!name) throw fail(400, 'Type the shop’s name.');
    return { name: name, perk: field(b.perk, LIMITS.perk, 'The perk') };
  }

  /* ------------------------------------------------------------------ *
   * Reading a stroll
   * ------------------------------------------------------------------ */

  function shopIds(doc) {
    var m = (doc && doc.shops) || {};
    return Object.keys(m).filter(function (id) { return isObj(m[id]); }).sort(function (a, b) { var x = m[a].ts || 0, y = m[b].ts || 0; return x - y || (a < b ? -1 : 1); });
  }
  /** The stamps that finish a card: the goal, but never more than there are
   *  shops (a goal of 5 on a street of 3 is 3). 0 when there are no shops. */
  function goalOf(doc) { var n = shopIds(doc).length; return Math.min(intIn(doc.goal, 1, LIMITS.shops, 1), n); }
  /** before / on / after, by the day handed in. */
  function phase(doc, today) { return today < doc.from ? 'before' : today > doc.to ? 'after' : 'on'; }
  /** Stamping is open from the eve of the first day to the day after the
   *  last: the server's day is UTC, and a street may be a day either side. */
  function stampOpen(doc, today) { return isDay(doc.from) && isDay(doc.to) && today >= addDays(doc.from, -1) && today <= addDays(doc.to, 1); }
  function expired(doc, today) { return !isDay(doc.to) || today > addDays(doc.to, LIMITS.keepDays); }
  function whenLine(doc, today) {
    var p = phase(doc, today);
    if (p === 'before') { var d = daysBetween(today, doc.from); return 'Starts ' + (d === 1 ? 'tomorrow' : dayLong(doc.from)); }
    if (p === 'after') return 'Ended ' + dayShort(doc.to);
    if (doc.to === today) return doc.from === doc.to ? 'Today only' : 'Last day today';
    return 'On now - until ' + dayLong(doc.to);
  }

  /** How far a card has got. Only stamps for shops still on the passport
   *  count. A finished card has one entry in the draw - and, when the
   *  passport says so, one more for every stamp past the goal. */
  function progress(doc, card) {
    var ids = shopIds(doc), stamps = (card && isObj(card.stamps)) ? card.stamps : {};
    var n = ids.filter(function (id) { return own(stamps, id); }).length;
    var goal = goalOf(doc);
    var done = goal > 0 && n >= goal;
    return { n: n, goal: goal, of: ids.length, done: done, left: done ? 0 : goal - n, entries: done ? 1 + (doc.bonus !== false ? n - goal : 0) : 0, all: ids.length > 0 && n === ids.length };
  }
  function progressLine(p) {
    if (!p.of) return 'No shops on this passport yet.';
    if (p.all) return 'Every shop stamped. ' + (p.entries > 1 ? plural(p.entries, 'entry', 'entries') + ' in the draw.' : 'You’re in the draw.');
    if (p.done) return 'You’re in the draw' + (p.entries > 1 ? ' with ' + plural(p.entries, 'entry', 'entries') : '') + '.';
    return plural(p.left, 'more stamp') + ' to enter the draw.';
  }

  /* ------------------------------------------------------------------ *
   * A stamp
   * ------------------------------------------------------------------ */

  function shopByCode(doc, code) {
    var c = normalizeCode(code);
    if (!isStamp(c)) return null;
    var ids = shopIds(doc);
    for (var i = 0; i < ids.length; i++) if (doc.shops[ids[i]].k === c) return ids[i];
    return null;
  }
  var WRONG_CODE = 'That isn’t a code on this passport. It’s the four letters on the sign at the counter.';
  /** Stamp `card` with the code from a counter. Returns {shop, isNew, set}
   *  - `set` the keys to write on the card ({} when it was stamped already).
   *  Throws a 404 for a code that opens nothing (every wrong code reads the
   *  same), a 409 outside the stroll's days. */
  function stamp(doc, card, code, ctx) {
    if (!stampOpen(doc, ctx.today)) throw fail(409, phase(doc, ctx.today) === 'before' ? 'Stamps open ' + dayLong(doc.from) + '.' : 'This passport has ended - stamps are closed.', { code: 'closed' });
    var sid = shopByCode(doc, code);
    if (!sid) throw fail(404, WRONG_CODE, { code: 'wrong' });
    if (card.removed) throw fail(403, 'This passport was removed by the organizer.', { code: 'removed' });
    if (own(card.stamps || {}, sid)) return { shop: sid, isNew: false, set: {} };
    var set = {}; set['stamps.' + sid] = ctx.now;
    return { shop: sid, isNew: true, set: set };
  }

  /* ------------------------------------------------------------------ *
   * The draw
   * ------------------------------------------------------------------ */

  /** Who is in: every finished card that was not removed and has not won
   *  already, with its entries. `cards` is [{tag, name, stamps, removed}]. */
  function entrants(doc, cards) {
    var out = [];
    (cards || []).forEach(function (c) {
      if (!c || c.removed || !isTag(c.tag) || own(doc.winners || {}, c.tag)) return;
      var p = progress(doc, c);
      if (p.done) out.push({ tag: c.tag, name: cleanName(c.name) || 'A shopper', entries: p.entries });
    });
    out.sort(function (a, b) { return a.tag < b.tag ? -1 : 1; });
    return out;
  }
  /** Pick one. `pick(n)` returns a whole number from 0 to n-1 - the server
   *  hands in crypto.randomInt. Every ENTRY has the same chance. */
  function draw(doc, cards, pick) {
    if (Object.keys(doc.winners || {}).length >= LIMITS.winners) throw fail(409, 'That’s ' + LIMITS.winners + ' winners - the most one passport draws.');
    var list = entrants(doc, cards);
    var total = list.reduce(function (s, e) { return s + e.entries; }, 0);
    if (!total) throw fail(409, 'Nobody has finished a passport yet, so there is nobody to draw.', { code: 'nobody' });
    var at = pick(total);
    if (!Number.isInteger(at) || at < 0 || at >= total) throw new Error('bad pick');
    for (var i = 0; i < list.length; i++) { at -= list[i].entries; if (at < 0) return { tag: list[i].tag, name: list[i].name, entries: list[i].entries, of: total, people: list.length }; }
    throw new Error('unreachable');
  }
  function winnerList(doc) {
    var w = isObj(doc.winners) ? doc.winners : {};
    return Object.keys(w).filter(function (t) { return isObj(w[t]); }).sort(function (a, b) { return (w[a].at || 0) - (w[b].at || 0) || (a < b ? -1 : 1); }).map(function (t) { return { tag: t, name: w[t].name, claim: w[t].claim, at: w[t].at || 0, given: Boolean(w[t].given) }; });
  }

  /* ------------------------------------------------------------------ *
   * One door for every change the organizer makes
   *
   * act(doc, action, ctx) -> {set: {'a.b': v}, del: ['a.c']}. ctx hands in
   * `now`, `today`, `ids` (new shop ids) and `codes` (new stamp codes: more
   * than are needed, so a clash with one in use is skipped).
   * ------------------------------------------------------------------ */

  function freeCodes(doc, codes, n) {
    var used = {}; shopIds(doc).forEach(function (id) { used[doc.shops[id].k] = 1; });
    var out = [];
    (codes || []).forEach(function (c) { if (out.length < n && isStamp(c) && !used[c]) { used[c] = 1; out.push(c); } });
    if (out.length < n) throw fail(503, 'Could not make a counter code. Try again.');
    return out;
  }
  function act(doc, a, ctx) {
    if (!isObj(a) || typeof a.t !== 'string') throw fail(400, 'That change could not be read.');
    var set = {}, del = [], ids = shopIds(doc), id = str(a.id);
    function shop() { if (!isId(id) || ids.indexOf(id) < 0) throw fail(404, 'That shop isn’t on the passport any more.'); return doc.shops[id]; }
    function taken(name, but) { var n = norm(name); return ids.some(function (x) { return x !== but && norm(doc.shops[x].name) === n; }); }
    if (a.t === 'details') {
      var g = cleanStroll(a, null);
      if (g.to < addDays(ctx.today, -1) && g.to !== doc.to) throw fail(400, 'Those days are already over.');
      ['title', 'place', 'from', 'to', 'goal', 'bonus', 'prize'].forEach(function (k) { set[k] = g[k]; });
    } else if (a.t === 'addshops') {
      var list = Array.isArray(a.shops) ? a.shops : [];
      if (!list.length) throw fail(400, 'Type at least one shop.');
      if (list.length > LIMITS.batch || ids.length + list.length > LIMITS.shops) throw fail(400, 'A passport holds up to ' + LIMITS.shops + ' shops.');
      var codes = freeCodes(doc, ctx.codes, list.length), seen = {};
      list.forEach(function (raw, i) {
        var s = cleanShop(raw), n = norm(s.name);
        if (taken(s.name) || seen[n]) throw fail(409, '“' + s.name + '” is on the passport already.');
        seen[n] = 1;
        if (!isId(ctx.ids[i])) throw new Error('no id');
        set['shops.' + ctx.ids[i]] = { name: s.name, perk: s.perk, k: codes[i], ts: ctx.now + i };
      });
    } else if (a.t === 'editshop') {
      shop();
      var e = cleanShop(a);
      if (taken(e.name, id)) throw fail(409, '“' + e.name + '” is on the passport already.');
      set['shops.' + id + '.name'] = e.name; set['shops.' + id + '.perk'] = e.perk;
    } else if (a.t === 'delshop') {
      shop(); del.push('shops.' + id);
    } else if (a.t === 'newcode') {
      shop(); set['shops.' + id + '.k'] = freeCodes(doc, ctx.codes, 1)[0];
    } else if (a.t === 'given') {
      var tag = str(a.tag);
      if (!isTag(tag) || !own(doc.winners || {}, tag)) throw fail(404, 'That winner isn’t on the list.');
      set['winners.' + tag + '.given'] = a.on !== false;
    } else throw fail(400, 'That change could not be read.');
    return { set: set, del: del };
  }
  /** Apply a change to a copy (the example on the page, and the tests). */
  function patch(doc, change) {
    var next = clone(doc);
    Object.keys(change.set || {}).forEach(function (k) { var p = k.split('.'), at = next; for (var i = 0; i < p.length - 1; i++) { if (!isObj(at[p[i]])) at[p[i]] = {}; at = at[p[i]]; } at[p[p.length - 1]] = clone(change.set[k]); });
    (change.del || []).forEach(function (k) { var p = k.split('.'), at = next; for (var i = 0; i < p.length - 1; i++) { if (!isObj(at[p[i]])) return; at = at[p[i]]; } delete at[p[p.length - 1]]; });
    return next;
  }

  /* ------------------------------------------------------------------ *
   * What each phone is shown
   *
   * view(doc, who, ctx): who = {role: 'host'} or {role: 'card', card, tag}.
   * ctx = {today, counts}. A SHOPPER IS NEVER SENT A STAMP CODE, a count,
   * another shopper's name (but a winner's first name) or a claim code that
   * is not their own.
   * ------------------------------------------------------------------ */

  function count(counts, k) { return intIn(counts && counts[k], 0, 1e9, 0); }
  function view(doc, who, ctx) {
    var ids = shopIds(doc), host = who.role === 'host', counts = (ctx && ctx.counts) || {}, today = ctx && ctx.today;
    var winners = winnerList(doc);
    var v = {
      id: doc.id, role: host ? 'host' : 'card', code: doc.code, title: doc.title, place: doc.place || '', from: doc.from, to: doc.to,
      goal: goalOf(doc), goalSet: intIn(doc.goal, 1, LIMITS.shops, 1), bonus: doc.bonus !== false, prize: doc.prize || '', host: (doc.host && doc.host.name) || '',
      v: doc.v || 0, open: isDay(today) ? stampOpen(doc, today) : true,
    };
    if (host) {
      v.shops = ids.map(function (id) { var s = doc.shops[id]; return { id: id, name: s.name, perk: s.perk || '', k: s.k, count: count(counts, 's_' + id) }; });
      v.counts = { cards: count(counts, 'cards'), stamps: count(counts, 'stamps'), done: count(counts, 'done') };
      var days = [];
      for (var d = addDays(doc.from, -1); d <= addDays(doc.to, 1); d = addDays(d, 1)) { var n = count(counts, 'd_' + d.replace(/-/g, '')); if (n || (d >= doc.from && d <= doc.to)) days.push({ day: d, n: n }); }
      v.days = days;
      v.winners = winners;
      v.t = v.v + '.' + v.counts.cards + '.' + v.counts.stamps + '.' + v.counts.done;
    } else {
      var card = who.card || {}, p = progress(doc, card);
      v.shops = ids.map(function (id) { var s = doc.shops[id]; return { id: id, name: s.name, perk: s.perk || '', got: own(card.stamps || {}, id) }; });
      v.me = { name: card.name || '', n: p.n, done: p.done, left: p.left, entries: p.entries, all: p.all, removed: Boolean(card.removed) };
      v.winners = winners.map(function (w) { return { name: w.name }; });
      var mine = who.tag && own(doc.winners || {}, who.tag) ? doc.winners[who.tag] : null;
      v.won = mine ? { claim: mine.claim, given: Boolean(mine.given) } : null;
      v.t = v.v + '.' + p.n + '.' + winners.length;
    }
    return v;
  }
  function shopOf(v, id) { for (var i = 0; i < v.shops.length; i++) if (v.shops[i].id === id) return v.shops[i]; return null; }

  /* ------------------------------------------------------------------ *
   * Words: the counter sign, the poster, the invitation
   * ------------------------------------------------------------------ */

  function joinLink(base, code) { return base + '#join=' + code; }
  function stampLink(base, code, k) { return base + '#stamp=' + code + '.' + k; }
  function rules(v) {
    var out = ['Collect a stamp at ' + (v.goal >= v.shops.length && v.shops.length ? (v.shops.length === 1 ? 'the shop' : 'all ' + v.shops.length + ' shops') : plural(v.goal, 'shop')) + ' to enter the prize draw.'];
    if (v.bonus && v.shops.length > v.goal) out.push('Every stamp after that is one more entry.');
    out.push('One stamp per shop. No purchase is needed for a stamp unless a shop’s own sign says so.');
    return out;
  }
  /** A shop's counter sign. Host only: it carries the stamp code. */
  function sign(v, shop, base) {
    return {
      over: v.title, head: 'Get your stamp here', shop: shop.name, perk: shop.perk,
      how: 'Point your phone’s camera at the square. No app, no sign-up - just your first name.',
      code: shop.k, codeLine: 'Or open the passport and type ' + shop.k,
      url: stampLink(base, v.code, shop.k), when: dateRange(v.from, v.to), prize: v.prize,
    };
  }
  function poster(v, base) {
    return {
      head: v.title, place: v.place, when: dateRange(v.from, v.to), prize: v.prize, rules: rules(v),
      shops: v.shops.map(function (s) { return s.name; }), url: joinLink(base, v.code), code: formatCode(v.code),
      how: 'Point your phone’s camera here to start your passport. No app, no sign-up.',
    };
  }
  function invite(v, base) {
    return v.title + (v.place ? ' - ' + v.place : '') + ', ' + dateRange(v.from, v.to) + '. Collect ' + plural(v.goal, 'stamp') + (v.prize ? ' to be in the draw for: ' + v.prize : ' to enter the prize draw') + '. Start your passport: ' + joinLink(base, v.code);
  }

  return {
    LIMITS: LIMITS, HOST_ONLY: HOST_ONLY, WRONG_CODE: WRONG_CODE, CODE_ALPHABET: CODE_ALPHABET, CODE_LEN: CODE_LEN, STAMP_LEN: STAMP_LEN,
    fail: fail, own: own, isObj: isObj, clone: clone, str: str, line: line, esc: esc, norm: norm, cleanName: cleanName, refuse: refuse, field: field, plural: plural, initials: initials,
    newId: newId, isId: isId, normalizeCode: normalizeCode, isCode: isCode, isStamp: isStamp, formatCode: formatCode, isGid: isGid, isTag: isTag,
    isDay: isDay, addDays: addDays, daysBetween: daysBetween, weekday: weekday, dayShort: dayShort, dayLong: dayLong, dateRange: dateRange, utcDay: utcDay, intIn: intIn,
    cleanStroll: cleanStroll, cleanShop: cleanShop, shopIds: shopIds, goalOf: goalOf, phase: phase, stampOpen: stampOpen, expired: expired, whenLine: whenLine,
    progress: progress, progressLine: progressLine, shopByCode: shopByCode, stamp: stamp, entrants: entrants, draw: draw, winnerList: winnerList,
    act: act, patch: patch, view: view, shopOf: shopOf, joinLink: joinLink, stampLink: stampLink, rules: rules, sign: sign, poster: poster, invite: invite,
  };
});
