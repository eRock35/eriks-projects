/* Punch - the rules, in one file run three times: in the page
 * (window.PunchCore), in the server (require) and in the tests. No clock,
 * no dice, no network, no storage: every time stamp, id and "today" is
 * passed in.
 *
 * THE BOOK - everything one person's punch lists hold, as TEXT only:
 *
 *   jobs   {<jid>: {name, client, t}}                      a job
 *   areas  {<aid>: {job, name, ar, t}}                     a room or area;
 *          ar is the photo's width / height x 1000, so a phone without
 *          the photo still draws the pins in the right shape
 *   items  {<pid>: {job, area, n, c, x, y, tp, trade, pri, due, note, tw,
 *                   state, sd, ts}}                         one fix, one pin
 *          n     its number on the job (#1, #2...), never reused
 *          c     when it was made (orders duplicates; never changes)
 *          x, y  where the pin sits on the photo, per mille (0-1000)
 *          tp    when the pin last moved
 *          trade, pri (high | normal | low), due (YYYY-MM-DD or ''),
 *          note  the work, and tw, when it last changed
 *          state open | fixed | verified, sd the day it got there, and
 *          ts    when that changed
 *   signs  {<jid>: {name, date, open, fixed, verified, t}}  the client's
 *          sign-off: their typed name, the date and the counts it covered.
 *          The signature itself is a picture and stays on the phone.
 *
 * A removal is a record of its own (`del: true` with its time), so it
 * travels to the other phone like any change. Photos - the "before" of an
 * area, each fix's "after", the signature - never enter the book: they
 * stay on the phone that took them (punch-store.js).
 *
 * TWO PHONES, ONE JOB: merged ITEM BY ITEM, and inside an item by its three
 * parts - where the pin is, what the work is, and how far it has got - each
 * by its own time. So one phone marking #4 fixed while the other rewrites
 * #4's note keeps both. The rules (and the tests that hold them):
 *   - each part of an item: the later change wins; at the same time, the
 *     larger value, compared canonically (so both phones pick the same);
 *   - a removed item against an edited one: the edit wins only if it came
 *     AFTER the removal - a fix changed after someone removed it is kept,
 *     and said so; otherwise it stays removed;
 *   - two new pins given the same number on two phones: the older keeps it,
 *     the newer gets the next free number (numbers only ever go up, so the
 *     merge of two numberings is their larger);
 *   - a job or area removed on one phone while the other added or changed a
 *     pin in it later: it comes back, so the pin is not lost;
 *   - the sign-off and every job and area: the later one wins.
 * Symmetric, idempotent and convergent (tested over hundreds of random
 * pairs and triples).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PunchCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    jobs: 60, areas: 400, items: 3000,
    jobName: 60, client: 60, areaName: 40, trade: 30, note: 240, signer: 60,
    storedBytes: 900 * 1024,
    arMin: 250, arMax: 4000,
    photoSide: 1600, afterSide: 1280,
  };
  var STATES = ['open', 'fixed', 'verified'];
  var STATE = {
    open: { label: 'Open', verb: 'Reopen', what: 'Still to do' },
    fixed: { label: 'Fixed', verb: 'Mark fixed', what: 'Done - waiting to be checked' },
    verified: { label: 'Verified', verb: 'Verify', what: 'Checked and signed off on the walk' },
  };
  var PRIS = ['high', 'normal', 'low'];
  var PRI = { high: 'High', normal: 'Normal', low: 'Low' };
  var TRADES = ['General', 'Carpentry', 'Drywall', 'Paint', 'Electrical', 'Plumbing', 'HVAC', 'Tile', 'Flooring', 'Cabinets', 'Doors and windows', 'Roofing', 'Exterior', 'Cleaning'];

  /* ================================================================== *
   * Small helpers
   * ================================================================== */

  var BAD_RANGES = [[0, 8], [11, 12], [14, 31], [0x7F, 0x9F], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2069], [0xFEFF, 0xFEFF]];
  function hx4(n) { return '\\u' + ('000' + n.toString(16)).slice(-4); }
  var BAD_CLASS = '[' + BAD_RANGES.map(function (p) { return hx4(p[0]) + '-' + hx4(p[1]); }).join('') + ']';
  var BAD = new RegExp(BAD_CLASS, 'g');
  var BAD1 = new RegExp(BAD_CLASS);
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  function esc(v) { return str(v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function clip(s, n) { var a = Array.from(s); return a.length <= n ? s : a.slice(0, Math.max(0, n - 1)).join('').replace(/\s+$/, '') + '…'; }
  function noMarkup(s) { return str(s).replace(/<[^>]{0,200}>/g, '').replace(/[<>]/g, ''); }
  function line(v, max) { return clip(noMarkup(str(v).replace(BAD, '')).replace(/\s+/g, ' ').trim(), max || 200); }
  function nf(s) { s = str(s); try { return s.normalize('NFKC'); } catch (e) { return s; } }
  function isObj(o) { return Boolean(o) && typeof o === 'object' && !Array.isArray(o); }
  function isInt(v) { return typeof v === 'number' && Math.round(v) === v && isFinite(v); }
  function isTime(v) { return isInt(v) && v >= 0; }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function len(s) { return Array.from(str(s)).length; }

  /* ================================================================== *
   * The text door: refused, never cleaned
   * ================================================================== */

  var AT_ANY = new RegExp('[@' + String.fromCharCode(0xFF20, 0xFE6B) + ']');
  function hasAt(s) { return AT_ANY.test(str(s)) || /@/.test(nf(s)); }
  var LINK = /(https?:|ftp:|mailto:|www\.|:\/\/|\b[a-z0-9-]{2,}\.(com|net|org|io|co|uk|us|app|dev|ly|me|info|biz|tv|gg|xyz|site|online|link|pro|build|homes|house)\b)/i;
  function hasLink(s) { return LINK.test(nf(s)); }
  /** Seven or more digits, in any script, in one run of digits and phone
   *  punctuation (a date like 2026-11-22 is not a phone). */
  function hasPhone(s) {
    var t = nf(s).replace(/\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}/gu, ' ');
    return (t.match(/\+?\p{Nd}[\p{Nd} ()\/.-]{5,}\p{Nd}/gu) || []).some(function (m) { return m.replace(/[^\p{Nd}]/gu, '').length >= 7; });
  }
  function nineDigits(s) { var t = nf(s); return /\p{Nd}{9,}/u.test(t) || /\p{Nd}{3}[ -]\p{Nd}{2}[ -]\p{Nd}{4}(?!\p{Nd})/u.test(t); }
  function hasCard(s) {
    return (nf(s).match(/\p{Nd}(?:[ -]?\p{Nd}){12,18}/gu) || []).some(function (m) {
      var d = m.replace(/[ -]/g, '');
      if (!/^[0-9]+$/.test(d)) return true;
      var sum = 0;
      for (var i = 0; i < d.length; i++) { var x = +d.charAt(d.length - 1 - i); if (i % 2) { x *= 2; if (x > 9) x -= 9; } sum += x; }
      return sum % 10 === 0;
    });
  }
  /** A spreadsheet formula: a leading = or @, or + or - straight before a
   *  letter or a bracket. */
  function isFormula(s) { s = str(s); return /^[\t\r]/.test(s) || /^\s*[=@]/.test(nf(s)) || /^\s*[+\-][^\s\p{Nd}.]/u.test(nf(s)); }
  function hasInvisible(s) { return BAD1.test(str(s)); }
  function hasMarkup(s) { return /[<>]/.test(str(s)); }

  var WHY = {
    invisible: 'That has an invisible character in it - type it again.',
    markup: 'Leave out < and > - Punch keeps plain words.',
    at: 'That looks like an email address - Punch never keeps one.',
    link: 'That looks like a link - Punch keeps plain words.',
    formula: 'Start it with a letter or a number - a leading = + - or @ is how a spreadsheet runs a formula.',
    card: 'That looks like a card number - never write one down here.',
    phone: 'That looks like a phone number - Punch never keeps one. Keep numbers to the sub’s own list.',
    nine: 'Nine digits in a row looks like a tax id or an account number - Punch never keeps one.',
  };
  /** The general door: '' when `s` may be kept, else why not. */
  function refuse(s, max) {
    s = str(s);
    if (hasInvisible(s.replace(/[\n\t]/g, ' '))) return WHY.invisible;
    if (hasMarkup(s)) return WHY.markup;
    if (hasAt(s)) return WHY.at;
    if (hasLink(s)) return WHY.link;
    if (s.split('\n').some(isFormula)) return WHY.formula;
    if (hasCard(s)) return WHY.card;
    if (nineDigits(s)) return WHY.nine;
    if (hasPhone(s)) return WHY.phone;
    if (max && len(s.trim()) > max) return 'Up to ' + max + ' characters.';
    return '';
  }
  function oneLine(s, max, empty) {
    s = str(s).trim();
    if (!s) return empty || '';
    if (/\n/.test(s)) return 'One line.';
    return refuse(s, max);
  }
  function jobNameProblem(s) { return oneLine(s, LIMITS.jobName, 'Name the job - “Kitchen remodel”, “Unit 4 turnover”.'); }
  function clientProblem(s) { return oneLine(s, LIMITS.client, ''); }
  function areaNameProblem(s) { return oneLine(s, LIMITS.areaName, 'Name the area - “Kitchen”, “Main bath”, “Front porch”.'); }
  function tradeProblem(s) { return oneLine(s, LIMITS.trade, 'Pick the trade.'); }
  function noteProblem(s) {
    s = str(s).trim();
    if (!s) return 'Say what needs fixing, in a few words.';
    return refuse(s, LIMITS.note);
  }
  function signerProblem(s) { return oneLine(s, LIMITS.signer, 'Type the client’s name as they sign.'); }

  /* ================================================================== *
   * Days (strings only; "today" is always passed in)
   * ================================================================== */

  var DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
  function isDay(s) {
    var m = DAY.exec(str(s));
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 2000 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
    var dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
    return d <= dim;
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDay(s) { if (!isDay(s)) return ''; var m = DAY.exec(s); return MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1]; }
  function shortDay(s) { if (!isDay(s)) return ''; var m = DAY.exec(s); return MONTHS[+m[2] - 1] + ' ' + (+m[3]); }
  function overdue(it, today) { return Boolean(it && it.state === 'open' && isDay(it.due) && isDay(today) && it.due < today); }

  /* ================================================================== *
   * The book and its one door
   * ================================================================== */

  var ID = { job: /^j[a-z0-9]{6,12}$/, area: /^a[a-z0-9]{6,12}$/, item: /^p[a-z0-9]{6,12}$/ };
  var JOB_KEYS = ['name', 'client', 't'];
  var AREA_KEYS = ['job', 'name', 'ar', 't'];
  var ITEM_KEYS = ['job', 'area', 'n', 'c', 'x', 'y', 'tp', 'trade', 'pri', 'due', 'note', 'tw', 'state', 'sd', 'ts'];
  var SIGN_KEYS = ['name', 'date', 'open', 'fixed', 'verified', 't'];
  var GROUPS = { tp: ['x', 'y'], tw: ['trade', 'pri', 'due', 'note'], ts: ['state', 'sd'] };

  function newBook(t) { return { v: 1, t: t || 0, jobs: {}, areas: {}, items: {}, signs: {} }; }
  function itemTime(it) { return it.del ? it.t : Math.max(it.tp, it.tw, it.ts); }

  function onlyKeys(o, keys, extra) { return Object.keys(o).filter(function (k) { return keys.indexOf(k) < 0 && (extra || []).indexOf(k) < 0; }); }
  function tomb(raw, where, errs, strict, keep) {
    if (strict && onlyKeys(raw, ['del', 't'].concat(keep || [])).length) errs.push(where + ': a removed one keeps only its time.');
    if (!isTime(raw.t)) { errs.push(where + ': its time is not a number.'); return null; }
    var out = { del: true, t: raw.t };
    (keep || []).forEach(function (k) { if (raw[k] !== undefined) out[k] = raw[k]; });
    return out;
  }
  function cleanJob(raw, strict, errs, where) {
    if (!isObj(raw)) { errs.push(where + ' is not in shape.'); return null; }
    var dead = raw.del === true;
    var extra = onlyKeys(raw, JOB_KEYS, ['del']);
    if (extra.length) { errs.push(where + ': unknown field ' + line(extra[0], 20) + '.'); if (strict) return null; }
    if (typeof raw.name !== 'string' || typeof raw.client !== 'string' || !isTime(raw.t)) { if (dead) return tomb(raw, where, errs, strict); errs.push(where + ' is not in shape.'); return null; }
    var j = { name: strict ? raw.name : line(raw.name, LIMITS.jobName), client: strict ? raw.client : line(raw.client, LIMITS.client), t: raw.t };
    var p = jobNameProblem(j.name) || clientProblem(j.client);
    if (p) { errs.push(where + ': ' + p); return null; }
    if (dead) j.del = true;
    return j;
  }
  function cleanArea(raw, strict, errs, where, jobs) {
    if (!isObj(raw)) { errs.push(where + ' is not in shape.'); return null; }
    var dead = raw.del === true;
    var extra = onlyKeys(raw, AREA_KEYS, ['del']);
    if (extra.length) { errs.push(where + ': unknown field ' + line(extra[0], 20) + '.'); if (strict) return null; }
    if (typeof raw.name !== 'string' || typeof raw.job !== 'string' || !isTime(raw.t)) { if (dead) return tomb(raw, where, errs, strict); errs.push(where + ' is not in shape.'); return null; }
    if (!jobs[raw.job]) { errs.push(where + ': its job is missing.'); return null; }
    var a = { job: raw.job, name: strict ? raw.name : line(raw.name, LIMITS.areaName), ar: raw.ar, t: raw.t };
    if (!isInt(a.ar) || a.ar < LIMITS.arMin || a.ar > LIMITS.arMax) { if (strict) { errs.push(where + ': its shape is not a number.'); return null; } a.ar = 1333; }
    var p = areaNameProblem(a.name);
    if (p) { errs.push(where + ': ' + p); return null; }
    if (dead) a.del = true;
    return a;
  }
  function itemProblems(it) {
    var p = [];
    if (!isInt(it.n) || it.n < 1 || it.n > 99999) p.push('its number is not in shape');
    if (!isInt(it.x) || it.x < 0 || it.x > 1000 || !isInt(it.y) || it.y < 0 || it.y > 1000) p.push('the pin is off the photo');
    var tr = tradeProblem(it.trade); if (tr) p.push(tr);
    if (PRIS.indexOf(it.pri) < 0) p.push('the priority is high, normal or low');
    if (!(it.due === '' || isDay(it.due))) p.push('the due date is not a date');
    var nt = noteProblem(it.note); if (nt) p.push(nt);
    if (STATES.indexOf(it.state) < 0) p.push('the state is open, fixed or verified');
    if (!(it.sd === '' || isDay(it.sd))) p.push('the state’s date is not a date');
    ['c', 'tp', 'tw', 'ts'].forEach(function (k) { if (!isTime(it[k])) p.push('a time is not a number'); });
    return p;
  }
  function cleanItem(raw, strict, errs, where, areas) {
    if (!isObj(raw)) { errs.push(where + ' is not in shape.'); return null; }
    if (raw.del === true) return tomb(raw, where, errs, strict);
    var extra = onlyKeys(raw, ITEM_KEYS);
    if (extra.length) { errs.push(where + ': unknown field ' + line(extra[0], 20) + '.'); if (strict) return null; }
    var it = {};
    ITEM_KEYS.forEach(function (k) { it[k] = raw[k]; });
    if (typeof it.job !== 'string' || typeof it.area !== 'string' || typeof it.trade !== 'string' || typeof it.note !== 'string' || typeof it.due !== 'string' || typeof it.sd !== 'string') { errs.push(where + ' is not in shape.'); return null; }
    var a = areas[it.area];
    if (!a || a.job !== it.job) { errs.push(where + ': its area is missing.'); return null; }
    if (!strict) { it.trade = line(it.trade, LIMITS.trade); it.note = line(it.note, LIMITS.note); }
    var p = itemProblems(it);
    if (p.length) { errs.push(where + ': ' + p[0].charAt(0).toUpperCase() + p[0].slice(1).replace(/\.$/, '') + '.'); return null; }
    return it;
  }
  function cleanSign(raw, strict, errs, where) {
    if (!isObj(raw)) { errs.push(where + ' is not in shape.'); return null; }
    if (raw.del === true) return tomb(raw, where, errs, strict);
    var extra = onlyKeys(raw, SIGN_KEYS);
    if (extra.length) { errs.push(where + ': unknown field ' + line(extra[0], 20) + '.'); if (strict) return null; }
    var s = { name: raw.name, date: raw.date, open: raw.open, fixed: raw.fixed, verified: raw.verified, t: raw.t };
    if (typeof s.name !== 'string' || !isDay(s.date) || !isTime(s.t) || [s.open, s.fixed, s.verified].some(function (n) { return !isInt(n) || n < 0 || n > LIMITS.items; })) { errs.push(where + ' is not in shape.'); return null; }
    if (!strict) s.name = line(s.name, LIMITS.signer);
    var p = signerProblem(s.name);
    if (p) { errs.push(where + ': ' + p); return null; }
    return s;
  }
  /** The one door for a whole book. Strict (the server): anything out of
   *  shape is an error and nothing is kept. Lenient (this phone's own
   *  copy): the bad record is dropped and the rest kept. */
  function cleanBook(raw, strict) {
    var errs = [], out = newBook(0);
    if (!isObj(raw)) return { book: out, errors: ['The punch lists are not in shape.'] };
    var extra = onlyKeys(raw, ['v', 't', 'jobs', 'areas', 'items', 'signs']);
    if (extra.length) errs.push('Unknown field ' + line(extra[0], 20) + '.');
    if (raw.v !== 1) errs.push('Unknown version.');
    out.t = isTime(raw.t) ? raw.t : 0;
    var parts = [['jobs', LIMITS.jobs, ID.job, 'A job', cleanJob], ['areas', LIMITS.areas, ID.area, 'An area', cleanArea], ['items', LIMITS.items, ID.item, 'A pin', cleanItem], ['signs', LIMITS.jobs, ID.job, 'A sign-off', cleanSign]];
    for (var i = 0; i < parts.length; i++) {
      var P = parts[i], src = raw[P[0]];
      if (src === undefined && !strict) continue;
      if (!isObj(src)) { errs.push('The ' + P[0] + ' are not in shape.'); continue; }
      var ids = Object.keys(src);
      if (ids.length > P[1] * 2) { errs.push('More than ' + P[1] + ' ' + P[0] + '.'); if (strict) return { book: out, errors: errs }; ids = ids.slice(0, P[1] * 2); }
      for (var k = 0; k < ids.length; k++) {
        var id = ids[k], r = src[id];
        if (!P[2].test(id)) { errs.push(P[3] + '’s id is not in shape.'); continue; }
        var where = P[3] + (r && typeof r.name === 'string' ? ' “' + line(r.name, 30) + '”' : r && isInt(r.n) ? ' #' + r.n : '');
        var ctx = P[0] === 'areas' ? out.jobs : out.areas;
        var x = P[4](r, strict, errs, where, ctx);
        if (x) out[P[0]][id] = x;
      }
      var live = Object.keys(out[P[0]]).filter(function (q) { return !out[P[0]][q].del; }).length;
      if (P[0] !== 'signs' && live > P[1]) errs.push('More than ' + P[1] + ' ' + P[0] + '.');
    }
    if (strict && !errs.length) Object.keys(out.signs).forEach(function (j) { if (!out.jobs[j]) errs.push('A sign-off has no job.'); });
    return { book: out, errors: errs };
  }
  /** What the server refuses whole before the door looks. */
  function bodyProblem(v, depth) {
    depth = depth || 0;
    if (depth > 8) return 'That is nested too deeply.';
    if (typeof v === 'string') {
      if (hasAt(v)) return 'Something in it has an @ - Punch keeps no email addresses.';
      if (nineDigits(v)) return 'Something in it has nine digits in a row - Punch keeps no tax ids or account numbers.';
      if (hasLink(v)) return 'Something in it looks like a link.';
      if (hasMarkup(v)) return 'Something in it has markup.';
      if (hasInvisible(v)) return 'Something in it has an invisible character.';
      if (/^data:|base64/i.test(v)) return 'Something in it looks like a picture - photos and signatures stay on the phone.';
      return '';
    }
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) { var p = bodyProblem(v[i], depth + 1); if (p) return p; } return ''; }
    if (isObj(v)) {
      var ks = Object.keys(v);
      for (var j = 0; j < ks.length; j++) { var q = bodyProblem(ks[j], depth + 1) || bodyProblem(v[ks[j]], depth + 1); if (q) return q; }
    }
    return '';
  }

  /* ================================================================== *
   * Reading the book
   * ================================================================== */

  function live(map) { return Object.keys(map || {}).filter(function (id) { return !map[id].del; }); }
  function jobs(b) {
    return live(b.jobs).map(function (id) { var j = clone(b.jobs[id]); j.id = id; return j; })
      .sort(function (x, y) { return y.t - x.t || x.name.localeCompare(y.name); });
  }
  function areasOf(b, jid) {
    return live(b.areas).filter(function (id) { return b.areas[id].job === jid; }).map(function (id) { var a = clone(b.areas[id]); a.id = id; return a; })
      .sort(function (x, y) { return x.t - y.t || x.name.localeCompare(y.name) || (x.id < y.id ? -1 : 1); });
  }
  var PRANK = { high: 0, normal: 1, low: 2 };
  function itemsOf(b, jid, aid) {
    return live(b.items).filter(function (id) { var it = b.items[id]; return it.job === jid && (!aid || it.area === aid); })
      .map(function (id) { var it = clone(b.items[id]); it.id = id; return it; })
      .sort(function (x, y) { return x.n - y.n; });
  }
  function counts(items) {
    var c = { open: 0, fixed: 0, verified: 0, total: items.length };
    items.forEach(function (it) { c[it.state]++; });
    return c;
  }
  function nextNumber(b, jid) {
    var n = 0;
    Object.keys(b.items).forEach(function (id) { var it = b.items[id]; if (!it.del && it.job === jid && it.n > n) n = it.n; });
    return n + 1;
  }
  function areaName(b, aid) { var a = b.areas[aid]; return a && !a.del ? a.name : ''; }

  /* ================================================================== *
   * Changes (each returns a new book; times passed in)
   * ================================================================== */

  function bump(n, t) { n.t = Math.max(n.t, t); return n; }
  function putJob(b, jid, name, client, t) { var n = clone(b); n.jobs[jid] = { name: str(name).trim(), client: str(client).trim(), t: t }; return bump(n, t); }
  function putArea(b, aid, jid, name, ar, t) {
    var n = clone(b), old = n.areas[aid];
    n.areas[aid] = { job: jid, name: str(name).trim(), ar: isInt(ar) ? Math.max(LIMITS.arMin, Math.min(LIMITS.arMax, ar)) : (old && old.ar) || 1333, t: t };
    return bump(n, t);
  }
  function clampPm(v) { v = Math.round(Number(v)); return isFinite(v) ? Math.max(0, Math.min(1000, v)) : 500; }
  /** A new pin: numbered next on its job, open, made now. */
  function addItem(b, pid, f, t) {
    var n = clone(b), a = n.areas[f.area];
    n.items[pid] = { job: a.job, area: f.area, n: nextNumber(n, a.job), c: t, x: clampPm(f.x), y: clampPm(f.y), tp: t, trade: str(f.trade).trim(), pri: PRIS.indexOf(f.pri) >= 0 ? f.pri : 'normal', due: isDay(f.due) ? f.due : '', note: str(f.note).trim(), tw: t, state: 'open', sd: '', ts: t };
    return bump(n, t);
  }
  function moveItem(b, pid, x, y, t) { var n = clone(b), it = n.items[pid]; it.x = clampPm(x); it.y = clampPm(y); it.tp = t; return bump(n, t); }
  function editItem(b, pid, f, t) {
    var n = clone(b), it = n.items[pid];
    it.trade = str(f.trade).trim(); it.pri = PRIS.indexOf(f.pri) >= 0 ? f.pri : 'normal'; it.due = isDay(f.due) ? f.due : ''; it.note = str(f.note).trim(); it.tw = t;
    return bump(n, t);
  }
  function setState(b, pid, state, day, t) {
    var n = clone(b), it = n.items[pid];
    if (STATES.indexOf(state) < 0) return n;
    it.state = state; it.sd = state === 'open' ? '' : (isDay(day) ? day : ''); it.ts = t;
    return bump(n, t);
  }
  function removeItem(b, pid, t) { var n = clone(b); n.items[pid] = { del: true, t: t }; return bump(n, t); }
  function removeArea(b, aid, t) {
    var n = clone(b), a = n.areas[aid];
    if (!a) return n;
    Object.keys(n.items).forEach(function (id) { if (!n.items[id].del && n.items[id].area === aid) n.items[id] = { del: true, t: t }; });
    a.del = true; a.t = t;
    return bump(n, t);
  }
  function removeJob(b, jid, t) {
    var n = clone(b);
    Object.keys(n.areas).forEach(function (id) { if (!n.areas[id].del && n.areas[id].job === jid) n = removeArea(n, id, t); });
    if (n.jobs[jid]) { n.jobs[jid].del = true; n.jobs[jid].t = t; }
    if (n.signs[jid]) n.signs[jid] = { del: true, t: t };
    return bump(n, t);
  }
  function sign(b, jid, name, date, t) {
    var n = clone(b), c = counts(itemsOf(n, jid));
    n.signs[jid] = { name: str(name).trim(), date: date, open: c.open, fixed: c.fixed, verified: c.verified, t: t };
    return bump(n, t);
  }
  function unsign(b, jid, t) { var n = clone(b); n.signs[jid] = { del: true, t: t }; return bump(n, t); }
  /** The sign-off, and how many pins changed after it. */
  function signOf(b, jid) {
    var s = b.signs[jid];
    if (!s || s.del) return null;
    var changed = itemsOf(b, jid).filter(function (it) { return itemTime(it) > s.t; }).length;
    var out = clone(s); out.changed = changed;
    return out;
  }

  /* ================================================================== *
   * Two phones: the merge
   * ================================================================== */

  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function same(a, b) { return canon(a) === canon(b); }
  function later(x, y) {
    if (!x) return y; if (!y) return x;
    if (x.t !== y.t) return x.t > y.t ? x : y;
    return canon(x) >= canon(y) ? x : y;
  }
  function pick(o, keys) { var r = {}; keys.forEach(function (k) { r[k] = o[k]; }); return r; }
  /** Two live copies of one pin: each part by its own time. */
  function mergeLive(x, y, since, notes) {
    var out = clone(x), mixed = [];
    out.n = Math.max(x.n, y.n);
    out.c = Math.min(x.c, y.c);
    Object.keys(GROUPS).forEach(function (g) {
      var ks = GROUPS[g], a = pick(x, ks), b = pick(y, ks), w;
      if (x[g] !== y[g]) w = x[g] > y[g] ? x : y;
      else w = canon(a) >= canon(b) ? x : y;
      ks.forEach(function (k) { out[k] = w[k]; });
      out[g] = w[g];
      if (x[g] > since && y[g] > since && canon(a) !== canon(b)) mixed.push(g);
    });
    if (notes && mixed.length) {
      var what = { tp: 'where the pin sits', tw: 'the work', ts: 'how far it has got' };
      notes.push('Both phones changed ' + mixed.map(function (g) { return what[g]; }).join(' and ') + ' on pin #' + out.n + ' - the later change is kept.');
    }
    return out;
  }
  /**
   * Two copies of one book, made one - item by item, and each item by its
   * parts. `since` is the time both phones last agreed (the sync base): a
   * note is written only for what both changed after it. Returns
   * {book, notes}.
   */
  function merge(a, b, since) {
    a = cleanBook(a).book; b = cleanBook(b).book;
    since = since || 0;
    var out = newBook(Math.max(a.t, b.t)), notes = [];
    ['jobs', 'areas', 'signs'].forEach(function (part) {
      var ids = Object.keys(a[part]).concat(Object.keys(b[part]));
      ids.forEach(function (id) { if (!out[part][id]) out[part][id] = clone(later(a[part][id], b[part][id])); });
    });
    Object.keys(a.items).concat(Object.keys(b.items)).forEach(function (id) {
      if (out.items[id]) return;
      var x = a.items[id], y = b.items[id];
      if (!x || !y) { out.items[id] = clone(x || y); return; }
      if (x.del && y.del) { out.items[id] = clone(later(x, y)); return; }
      if (!x.del && !y.del) { out.items[id] = mergeLive(x, y, since, notes); return; }
      var dead = x.del ? x : y, alive = x.del ? y : x;
      if (itemTime(alive) > dead.t) {
        out.items[id] = clone(alive);
        if (dead.t > since) notes.push('Pin #' + alive.n + ' was removed on one phone but changed on the other after that - it is kept.');
      } else out.items[id] = clone(dead);
    });
    // A pin whose area or job was removed: kept (and the area brought
    // back) if it changed after the removal, else removed with it.
    Object.keys(out.items).sort().forEach(function (id) {
      var it = out.items[id];
      if (it.del) return;
      var ar = out.areas[it.area], jb = out.jobs[it.job];
      if (!ar || !jb || ar.job !== it.job) { delete out.items[id]; return; }
      var gone = false;
      [[ar, 'area “' + ar.name + '”'], [jb, 'job “' + jb.name + '”']].forEach(function (p) {
        var rec = p[0];
        if (!rec.del || gone) return;
        if (itemTime(it) > rec.t) { delete rec.del; if (rec.t > since) notes.push('The ' + p[1] + ' was removed on one phone, but pin #' + it.n + ' in it changed later - both are kept.'); }
        else { out.items[id] = { del: true, t: rec.t }; gone = true; }
      });
    });
    Object.keys(out.areas).forEach(function (id) { var ar = out.areas[id]; if (!ar.del && out.jobs[ar.job] && out.jobs[ar.job].del) delete out.jobs[ar.job].del; });
    Object.keys(out.signs).forEach(function (j) { if (!out.jobs[j] || (out.jobs[j].del && !out.signs[j].del)) out.signs[j] = { del: true, t: out.jobs[j] ? out.jobs[j].t : 0 }; });
    renumber(out, notes);
    return { book: out, notes: notes };
  }
  /** Two live pins on one job with one number: the older (by when it was
   *  made, then its id) keeps it; the others get the next free numbers. */
  function renumber(b, notes) {
    var byJob = {};
    Object.keys(b.items).forEach(function (id) { var it = b.items[id]; if (!it.del) (byJob[it.job] = byJob[it.job] || []).push(id); });
    Object.keys(byJob).sort().forEach(function (j) {
      var ids = byJob[j].sort(function (p, q) { var x = b.items[p], y = b.items[q]; return x.n - y.n || x.c - y.c || (p < q ? -1 : 1); });
      var top = 0, seen = {};
      ids.forEach(function (id) { top = Math.max(top, b.items[id].n); });
      ids.forEach(function (id) {
        var it = b.items[id];
        if (!seen[it.n]) { seen[it.n] = true; return; }
        var was = it.n; top += 1; it.n = top; seen[top] = true;
        if (notes) notes.push('Both phones made a pin #' + was + ' - the newer one is now #' + it.n + '.');
      });
    });
  }

  /* ================================================================== *
   * Lists by trade, and the closeout
   * ================================================================== */

  /** Each trade's pins on a job, the trades A-Z, each list by priority then
   *  number. `which`: 'open' (default: still to do), 'fixed' (to check),
   *  'all'. */
  function byTrade(b, jid, which) {
    which = which || 'open';
    var g = {};
    itemsOf(b, jid).forEach(function (it) {
      if (which === 'open' && it.state !== 'open') return;
      if (which === 'fixed' && it.state !== 'fixed') return;
      var k = it.trade.toLowerCase();
      if (!g[k]) g[k] = { trade: it.trade, items: [] };
      it.areaName = areaName(b, it.area);
      g[k].items.push(it);
    });
    return Object.keys(g).sort().map(function (k) {
      g[k].items.sort(function (x, y) { return PRANK[x.pri] - PRANK[y.pri] || (x.due || '9999') .localeCompare(y.due || '9999') || x.n - y.n; });
      return g[k];
    });
  }
  /** One trade's list as text to copy or share with the sub. */
  function tradeText(b, jid, trade, today, which) {
    var j = b.jobs[jid], grp = byTrade(b, jid, which).filter(function (x) { return x.trade.toLowerCase() === str(trade).toLowerCase(); })[0];
    if (!j || !grp) return '';
    var head = j.name + ' - ' + grp.trade + ' (' + plural(grp.items.length, 'item') + (which === 'fixed' ? ' to check' : '') + ')';
    var rows = grp.items.map(function (it) {
      var bits = ['#' + it.n, it.areaName, it.note];
      if (it.pri !== 'normal') bits.push(PRI[it.pri] + ' priority');
      if (it.due) bits.push('due ' + shortDay(it.due) + (overdue(it, today) ? ' (overdue)' : ''));
      if (it.state !== 'open') bits.push(STATE[it.state].label.toLowerCase());
      return '[ ] ' + bits.join(' - ');
    });
    return head + '\n' + rows.join('\n') + '\n';
  }
  /** The closeout: each area with its pins, the before/after pairs and the
   *  sign-off. */
  function closeout(b, jid) {
    var areas = areasOf(b, jid).map(function (a) { var its = itemsOf(b, jid, a.id); return { area: a, items: its, counts: counts(its) }; });
    var all = itemsOf(b, jid);
    return { job: b.jobs[jid], areas: areas, counts: counts(all), pairs: all.filter(function (it) { return it.state !== 'open'; }), sign: signOf(b, jid) };
  }

  /** Where to draw the "before" close-up of a pin: the area photo scaled
   *  by `zoom` inside a 4:3 box, moved so the pin is as near the middle as
   *  the photo's edges allow. Percentages of the box. */
  function crop(x, y, ar, zoom) {
    zoom = zoom || 2.5; ar = ar || 1333;
    var hPct = zoom * 100 * (1000 / ar) * (4 / 3);   // photo height as % of the box height
    var wPct = zoom * 100;
    var clampTo = function (v, size) { return size <= 100 ? (100 - size) / 2 : Math.max(100 - size, Math.min(0, v)); };
    var left = clampTo(50 - x / 1000 * wPct, wPct), top = clampTo(50 - y / 1000 * hPct, hPct);
    var r = function (v) { return Math.round(v * 100) / 100; };
    return { left: r(left), top: r(top), width: r(wPct), height: r(hPct), px: r(left + x / 1000 * wPct), py: r(top + y / 1000 * hPct) };
  }

  return {
    LIMITS: LIMITS, STATES: STATES, STATE: STATE, PRIS: PRIS, PRI: PRI, TRADES: TRADES, ID: ID, GROUPS: GROUPS,
    str: str, esc: esc, line: line, clip: clip, clone: clone, plural: plural, isInt: isInt, isObj: isObj,
    refuse: refuse, jobNameProblem: jobNameProblem, clientProblem: clientProblem, areaNameProblem: areaNameProblem, tradeProblem: tradeProblem, noteProblem: noteProblem, signerProblem: signerProblem,
    isDay: isDay, fmtDay: fmtDay, shortDay: shortDay, overdue: overdue,
    newBook: newBook, cleanBook: cleanBook, bodyProblem: bodyProblem, itemTime: itemTime,
    jobs: jobs, areasOf: areasOf, itemsOf: itemsOf, counts: counts, nextNumber: nextNumber, areaName: areaName,
    putJob: putJob, putArea: putArea, addItem: addItem, moveItem: moveItem, editItem: editItem, setState: setState,
    removeItem: removeItem, removeArea: removeArea, removeJob: removeJob, sign: sign, unsign: unsign, signOf: signOf,
    canon: canon, same: same, merge: merge, renumber: renumber,
    byTrade: byTrade, tradeText: tradeText, closeout: closeout, crop: crop,
  };
}));
