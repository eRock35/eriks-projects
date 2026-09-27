/* Tipout's rules - everything that needs no model, in one file that runs in the
 * browser AND on the server (server.js requires it).
 *
 *   validateRules / validateSetup   the pool rules, set once: a method (hours,
 *                          points, or tip-outs first), roles with points and
 *                          a manager flag, tip-outs, and the roster of first
 *                          names.
 *   validateShift          one end-of-shift: who worked and for how long, card
 *                          tips, cash tips, food sales, the drawer count.
 *   split(shift)           every share in whole cents, with the arithmetic
 *                          written out in words. Largest-remainder rounding,
 *                          so the total paid out is ALWAYS the total in.
 *   envelopes              which bills and coins go in whose envelope, from
 *                          the cash actually on hand - or a plain "the drawer
 *                          can't make exact change", and what to break.
 *   headsUp                the FLSA fairness note when a manager is in a pool.
 *   week, exportCsv        the week view and the spreadsheet.
 *   shareCard              the frozen, numbers-and-first-names receipt a
 *                          link shows.
 *
 * Money is integer cents everywhere; typed money is read digit by digit
 * (toCents), never through a float. Weights are integers too: hours in
 * quarter-hours, points in hundredths, percentages in basis points. No
 * product of them gets near 2^53.
 *
 * One implementation on purpose: the shift lead's phone, the staff member's
 * receipt link, the saved history and the tests all compute the same cents
 * from the same code.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TipoutRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- vocabulary ---------------- */

  var LIMITS = {
    roster: 60,          // people on the team
    crew: 40,            // people on one shift (the brief says 3 to 30)
    roles: 12,
    tipouts: 6,
    name: 20,            // a first name (and maybe an initial)
    role: 24,
    maxCents: 10000000,  // $100,000 of card tips, cash tips or sales in one shift
    maxQuarters: 96,     // 24 hours
    maxPts: 500,         // 5.00 points
    maxBp: 5000,         // a tip-out of at most 50%
    denomCount: 5000,    // bills of one kind in a drawer
    days: 3660,          // how far back a shift may be dated
  };

  var METHODS = [
    { key: 'hours', emoji: '⏱️', label: 'By hours', blurb: 'Everyone in the pool shares by hours worked.' },
    { key: 'points', emoji: '⚖️', label: 'By points', blurb: 'Each role has points; a share is points × hours.' },
    { key: 'tipout', emoji: '🍸', label: 'Tip-outs first', blurb: 'Other roles get a percentage first, then the rest is split.' },
  ];
  var METHOD_KEYS = METHODS.map(function (m) { return m.key; });

  var PARTS = [
    { key: 'brunch', label: 'Brunch' },
    { key: 'lunch', label: 'Lunch' },
    { key: 'dinner', label: 'Dinner' },
    { key: 'late', label: 'Late' },
    { key: 'allday', label: 'All day' },
  ];
  var PART_KEYS = PARTS.map(function (p) { return p.key; });

  // Largest first. The $2 bill exists but no drawer has one.
  var DENOMS = [
    { c: 10000, label: '$100', kind: 'bill' },
    { c: 5000, label: '$50', kind: 'bill' },
    { c: 2000, label: '$20', kind: 'bill' },
    { c: 1000, label: '$10', kind: 'bill' },
    { c: 500, label: '$5', kind: 'bill' },
    { c: 100, label: '$1', kind: 'bill' },
    { c: 25, label: '25¢', kind: 'coin' },
    { c: 10, label: '10¢', kind: 'coin' },
    { c: 5, label: '5¢', kind: 'coin' },
    { c: 1, label: '1¢', kind: 'coin' },
  ];
  var DENOM_CENTS = DENOMS.map(function (d) { return d.c; });

  /** The three starting points. Every number in them is editable afterwards. */
  var TEMPLATES = [
    {
      key: 'hours', emoji: '⏱️', label: 'Hours-based', blurb: 'Everyone front-of-house shares by hours worked. The simplest pool, and the most common.',
      rules: {
        method: 'hours', restBy: 'hours', cashDollars: true,
        roles: [
          { key: 'server', name: 'Server', pts: 100 },
          { key: 'bartender', name: 'Bartender', pts: 100 },
          { key: 'busser', name: 'Busser', pts: 100 },
          { key: 'host', name: 'Host', pts: 100 },
        ],
        tipouts: [],
      },
    },
    {
      key: 'points', emoji: '⚖️', label: 'Points', blurb: 'Role points × hours: server 1.0, bartender 1.2, busser 0.5, host 0.4.',
      rules: {
        method: 'points', restBy: 'points', cashDollars: true,
        roles: [
          { key: 'server', name: 'Server', pts: 100 },
          { key: 'bartender', name: 'Bartender', pts: 120 },
          { key: 'busser', name: 'Busser', pts: 50 },
          { key: 'host', name: 'Host', pts: 40 },
        ],
        tipouts: [],
      },
    },
    {
      key: 'tipout', emoji: '🍸', label: 'Tip-outs first', blurb: 'The bar gets 10% of tips and the kitchen 3% of food sales, then the rest is split by hours.',
      rules: {
        method: 'tipout', restBy: 'hours', cashDollars: true,
        roles: [
          { key: 'server', name: 'Server', pts: 100 },
          { key: 'bartender', name: 'Bartender', pts: 120 },
          { key: 'busser', name: 'Busser', pts: 50 },
          { key: 'host', name: 'Host', pts: 40 },
          { key: 'kitchen', name: 'Kitchen', pts: 100 },
        ],
        tipouts: [
          { to: 'bartender', bp: 1000, of: 'tips' },
          { to: 'kitchen', bp: 300, of: 'sales' },
        ],
      },
    },
  ];

  function template(key) {
    for (var i = 0; i < TEMPLATES.length; i++) if (TEMPLATES[i].key === key) return JSON.parse(JSON.stringify(TEMPLATES[i].rules));
    return null;
  }
  function methodInfo(k) { for (var i = 0; i < METHODS.length; i++) if (METHODS[i].key === k) return METHODS[i]; return METHODS[0]; }
  function partLabel(k) { for (var i = 0; i < PARTS.length; i++) if (PARTS[i].key === k) return PARTS[i].label; return ''; }

  /* ---------------- text ---------------- */

  /** Plain text: tags and stray angle brackets out, control characters out,
   *  whitespace collapsed, bounded. Cut to four times the limit BEFORE any
   *  pattern runs, and the tag pattern stops at the next "<", so a hostile
   *  run of "<" costs linear time. */
  function clean(v, max) {
    var s = String(v == null ? '' : v).slice(0, (max || 200) * 4);
    s = s.replace(/<[^<>]*>/g, ' ').replace(/[<>]/g, '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
    return s.slice(0, max || 200).trim();
  }

  /**
   * A first name, and at most an initial to tell two Sams apart: "Sam R.".
   * Letters, marks, apostrophes, hyphens and dots only. A surname typed in by
   * habit is dropped here, so it can never reach a receipt link.
   */
  function cleanName(v) {
    var s = clean(v, 60).replace(/[^\p{L}\p{M}'’.\- ]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    var w = s.split(' ');
    var out = w[0];
    if (w[1] && /^\p{L}\.?$/u.test(w[1])) out += ' ' + w[1].charAt(0).toUpperCase() + '.';
    out = out.replace(/^[.'’-]+/, '');
    return out.slice(0, LIMITS.name);
  }

  function slug(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 12);
  }

  /** Titles that, under the FLSA, usually mean someone may not keep pooled tips. */
  var MANAGER_RE = /\b(manager|mgr|supervisor|owner|proprietor|gm|agm|general manager|director|boss)\b/i;
  function looksManager(name) { return MANAGER_RE.test(String(name || '')); }

  /* ---------------- numbers ---------------- */

  var MONEY_RE = /^\$?((?:\d{1,3}(?:,\d{3})+)|\d+)?(?:\.(\d*))?$/;

  /**
   * "$1,284.50" -> 128450. A number or text; more than two decimals round
   * half up on the third digit, read from the digits, never from a float.
   * Negative, empty or anything else is null.
   */
  function toCents(v) {
    if (v == null) return null;
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || v < 0) return null;
      v = Math.abs(v) < 1e-6 ? '0' : String(v);
      if (/e/i.test(v)) return null;
    }
    var s = String(v).trim().replace(/\s+/g, '').replace(/^usd/i, '').replace(/usd$/i, '');
    if (!s) return null;
    var m = MONEY_RE.exec(s);
    if (!m || (m[1] === undefined && !m[2])) return null;
    var whole = Number((m[1] || '0').replace(/,/g, ''));
    var frac = (m[2] || '') + '000';
    var cents = whole * 100 + Number(frac.slice(0, 2)) + (Number(frac.charAt(2)) >= 5 ? 1 : 0);
    return Number.isSafeInteger(cents) ? cents : null;
  }

  /** A decimal with at most two places, as an integer count of hundredths:
   *  "1.2" -> 120, 0.5 -> 50. For points and percentages. */
  function toHundredths(v) {
    if (v == null || v === '') return null;
    var s = typeof v === 'number' ? (Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '') : String(v).trim().replace(/%$/, '');
    var m = /^(\d{1,6})?(?:\.(\d{0,6}))?$/.exec(s);
    if (!m || (m[1] === undefined && !m[2])) return null;
    var frac = (m[2] || '') + '000';
    return Number(m[1] || 0) * 100 + Number(frac.slice(0, 2)) + (Number(frac.charAt(2)) >= 5 ? 1 : 0);
  }

  /** Hours as whole quarter-hours: 6.5 -> 26. Rounded to the nearest quarter. */
  function toQuarters(v) {
    if (v == null || v === '') return null;
    var n = typeof v === 'number' ? v : Number(String(v).trim().replace(/h(ou)?r?s?$/i, ''));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 4);
  }

  function group3(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /** 128450 -> "$1,284.50". */
  function money(c) {
    c = Math.round(Number(c) || 0);
    var a = Math.abs(c);
    return (c < 0 ? '−' : '') + '$' + group3(Math.floor(a / 100)) + '.' + String(a % 100).padStart(2, '0');
  }
  /** "$1,285" when there are no cents, else money(). */
  function moneyTight(c) { return Math.round(c) % 100 === 0 ? '$' + group3(Math.round(Math.abs(c) / 100)) : money(c); }
  /** 128450 -> "1284.50", for inputs and CSV. */
  function plain(c) { c = Math.round(Number(c) || 0); return (c < 0 ? '-' : '') + Math.floor(Math.abs(c) / 100) + '.' + String(Math.abs(c) % 100).padStart(2, '0'); }
  /** 26 quarter-hours -> "6.5". */
  function hoursText(q) { var h = q / 4; return String(Math.round(h * 100) / 100); }
  /** 120 hundredths -> "1.2". */
  function ptsText(p) { return String(Math.round(p) / 100); }
  /** 1000 basis points -> "10%". */
  function bpText(bp) { return String(Math.round(bp) / 100) + '%'; }
  function pctOf(w, W) { return W ? (Math.round((w / W) * 10000) / 100).toFixed(2) + '%' : '0.00%'; }
  function plural(n, w, ws) { return n + ' ' + (n === 1 ? w : (ws || w + 's')); }

  /* ---------------- dates ---------------- */

  function isoDay(v) {
    var s = String(v == null ? '' : v).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s ? s : null;
  }
  function addDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
  function dow(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); }
  /** The Monday that starts iso's week. */
  function weekStart(iso) { return addDays(iso, -((dow(iso) + 6) % 7)); }
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayShort(iso) { var d = new Date(iso + 'T00:00:00Z'); return WEEKDAYS[d.getUTCDay()] + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate(); }
  function rangeText(a, b) {
    var x = new Date(a + 'T00:00:00Z'); var y = new Date(b + 'T00:00:00Z');
    if (x.getUTCMonth() === y.getUTCMonth()) return MONTHS[x.getUTCMonth()] + ' ' + x.getUTCDate() + '–' + y.getUTCDate();
    return MONTHS[x.getUTCMonth()] + ' ' + x.getUTCDate() + ' – ' + MONTHS[y.getUTCMonth()] + ' ' + y.getUTCDate();
  }

  /* ---------------- rules and roster ---------------- */

  function fail(field, error) { return { error: error, field: field }; }

  /**
   * The pool rules: {method, restBy, cashDollars, roles, tipouts}. Roles get a
   * stable key; a tip-out names a role that exists. Returns {rules} or
   * {error, field}.
   */
  function validateRules(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var method = METHOD_KEYS.indexOf(raw.method) >= 0 ? raw.method : null;
    if (!method) return fail('method', 'Pick how the pool splits: by hours, by points, or tip-outs first.');
    var restBy = raw.restBy === 'points' ? 'points' : 'hours';
    var list = Array.isArray(raw.roles) ? raw.roles : [];
    if (!list.length) return fail('roles', 'Add at least one role.');
    if (list.length > LIMITS.roles) return fail('roles', 'Up to ' + LIMITS.roles + ' roles.');
    var roles = [];
    var keys = {};
    for (var i = 0; i < list.length; i++) {
      var r = list[i] || {};
      var name = clean(r.name, LIMITS.role);
      if (!name) return fail('roles', 'Every role needs a name.');
      var pts = r.pts !== undefined ? (Number.isInteger(r.pts) ? r.pts : null) : toHundredths(r.points);
      if (pts === null || pts === undefined) pts = 100;
      if (!(pts >= 0 && pts <= LIMITS.maxPts)) return fail('roles', name + ': points are between 0 and ' + LIMITS.maxPts / 100 + '.');
      var key = /^[a-z0-9]{1,12}$/.test(r.key || '') ? r.key : (slug(name) || 'role');
      var k = key; var n = 2;
      while (keys[k]) k = key.slice(0, 10) + n++;
      keys[k] = true;
      roles.push({ key: k, name: name, pts: pts, manager: r.manager === true || (r.manager === undefined && looksManager(name)) });
    }
    var tl = Array.isArray(raw.tipouts) ? raw.tipouts : [];
    if (tl.length > LIMITS.tipouts) return fail('tipouts', 'Up to ' + LIMITS.tipouts + ' tip-outs.');
    var tipouts = [];
    var seen = {};
    for (var j = 0; j < tl.length; j++) {
      var t = tl[j] || {};
      if (!keys[t.to]) return fail('tipouts', 'A tip-out goes to a role that doesn’t exist any more.');
      var of = t.of === 'sales' ? 'sales' : 'tips';
      var bp = t.bp !== undefined ? (Number.isInteger(t.bp) ? t.bp : null) : toHundredths(t.pct);
      if (!(bp > 0 && bp <= LIMITS.maxBp)) return fail('tipouts', 'A tip-out is between 0.01% and ' + LIMITS.maxBp / 100 + '%.');
      if (seen[t.to + '/' + of]) return fail('tipouts', 'That role already has a tip-out of ' + (of === 'sales' ? 'food sales' : 'the tips') + '.');
      seen[t.to + '/' + of] = true;
      tipouts.push({ to: t.to, bp: bp, of: of });
    }
    return { rules: { method: method, restBy: restBy, cashDollars: raw.cashDollars !== false, roles: roles, tipouts: tipouts } };
  }

  var PID_RE = /^[A-Za-z0-9_-]{3,24}$/;
  function newPid() {
    var a = 'abcdefghijkmnpqrstuvwxyz23456789';
    var s = 'p';
    var buf = null;
    try { buf = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(9)) : null; } catch (e) { buf = null; }
    for (var i = 0; i < 9; i++) s += a.charAt((buf ? buf[i] : Math.floor(Math.random() * 256)) % a.length);
    return s;
  }

  /** Rules plus the roster. Returns {setup} or {error, field}. */
  function validateSetup(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var r = validateRules(raw);
    if (r.error) return r;
    var roleKeys = r.rules.roles.map(function (x) { return x.key; });
    var list = Array.isArray(raw.people) ? raw.people : [];
    if (list.length > LIMITS.roster) return fail('people', 'Up to ' + LIMITS.roster + ' people on a team.');
    var people = [];
    var ids = {};
    for (var i = 0; i < list.length; i++) {
      var p = list[i] || {};
      var name = cleanName(p.name);
      if (!name) return fail('people', 'Everyone on the team needs a first name.');
      var id = PID_RE.test(p.id || '') && !ids[p.id] ? p.id : newPid();
      ids[id] = true;
      people.push({ id: id, name: name, role: roleKeys.indexOf(p.role) >= 0 ? p.role : roleKeys[0] });
    }
    var out = r.rules;
    out.people = people;
    return { setup: out };
  }

  /* ---------------- a shift ---------------- */

  /**
   * One end-of-shift, checked: {date, part, card, cash, sales, crew, drawer,
   * rules}. Money in cents; `sales` null when not entered. The crew carries
   * each person's name and role as they were that night, so a later edit to
   * the roster never rewrites history. Returns {shift} or {error, field}.
   */
  function validateShift(raw, today) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var date = isoDay(raw.date);
    if (!date) return fail('date', 'Pick the shift’s date.');
    if (today && (date > addDays(today, 1) || date < addDays(today, -LIMITS.days))) return fail('date', 'That date is out of range.');
    var part = PART_KEYS.indexOf(raw.part) >= 0 ? raw.part : 'dinner';
    var r = validateRules(raw.rules);
    if (r.error) return r;
    var rules = r.rules;
    var amt = {};
    var names = { card: 'Card tips', cash: 'Cash tips', sales: 'Food sales' };
    for (var k in names) {
      var v = raw[k];
      if (v === undefined || v === null || v === '') { amt[k] = k === 'sales' ? null : 0; continue; }
      var c = typeof v === 'number' && Number.isInteger(v) && raw.cents === true ? v : toCents(v);
      if (c === null) return fail(k, names[k] + ' should be an amount like 412.50.');
      if (c > LIMITS.maxCents) return fail(k, names[k] + ' can be up to ' + money(LIMITS.maxCents) + '.');
      amt[k] = c;
    }
    var roleKeys = {};
    rules.roles.forEach(function (x) { roleKeys[x.key] = true; });
    var list = Array.isArray(raw.crew) ? raw.crew : [];
    if (!list.length) return fail('crew', 'Tick who worked.');
    if (list.length > LIMITS.crew) return fail('crew', 'Up to ' + LIMITS.crew + ' people on one shift.');
    var crew = [];
    var ids = {};
    for (var i = 0; i < list.length; i++) {
      var p = list[i] || {};
      var name = cleanName(p.name);
      if (!name) return fail('crew', 'Everyone who worked needs a first name.');
      var pid = PID_RE.test(p.pid || '') ? p.pid : null;
      if (!pid || ids[pid]) return fail('crew', 'Someone is on this shift twice.');
      ids[pid] = true;
      if (!roleKeys[p.role]) return fail('crew', name + ' needs a role.');
      var q = p.q !== undefined && Number.isInteger(p.q) ? p.q : toQuarters(p.hours);
      if (q === null || q < 0 || q > LIMITS.maxQuarters) return fail('crew', name + ': hours are between 0 and 24.');
      crew.push({ pid: pid, name: name, role: p.role, q: q });
    }
    var drawer = null;
    if (raw.drawer && typeof raw.drawer === 'object') {
      drawer = {};
      var any = false;
      for (var d = 0; d < DENOMS.length; d++) {
        var key = String(DENOMS[d].c);
        var n = raw.drawer[key];
        if (n === undefined || n === null || n === '') continue;
        n = Number(n);
        if (!Number.isInteger(n) || n < 0 || n > LIMITS.denomCount) return fail('drawer', DENOMS[d].label + ': count whole bills and coins.');
        if (n) { drawer[key] = n; any = true; }
      }
      if (!any) drawer = null;
    }
    return { shift: { date: date, part: part, card: amt.card, cash: amt.cash, sales: amt.sales, crew: crew, drawer: drawer, rules: rules } };
  }

  /* ---------------- rounding that never loses a cent ---------------- */

  /**
   * Split `amount` whole units over integer `weights` in proportion, by the
   * largest-remainder method: everyone gets the floor of their exact share,
   * then the units left over go one each to the largest remainders (ties to
   * the larger weight, then to list order - deterministic). The result sums
   * to `amount` exactly. `caps` (optional) bounds each person; a unit that
   * fits under nobody's cap is returned as `left`.
   */
  function allocate(amount, weights, caps) {
    var n = weights.length;
    var W = 0;
    for (var i = 0; i < n; i++) W += weights[i];
    var out = new Array(n).fill(0);
    var extra = new Array(n).fill(0);
    if (!amount || !W) return { parts: out, extra: extra, left: amount || 0 };
    var used = 0;
    var rem = [];
    for (var j = 0; j < n; j++) {
      var num = amount * weights[j];
      var base = Math.floor(num / W);
      if (caps && base > caps[j]) base = caps[j];
      out[j] = base;
      used += base;
      rem.push({ i: j, r: num - base * W, w: weights[j] });
    }
    rem.sort(function (a, b) { return b.r - a.r || b.w - a.w || a.i - b.i; });
    var left = amount - used;
    for (var k = 0; k < rem.length && left > 0; k++) {
      var x = rem[k];
      if (!x.w || (caps && out[x.i] + 1 > caps[x.i])) continue;
      out[x.i] += 1; extra[x.i] += 1; left--;
    }
    return { parts: out, extra: extra, left: left };
  }

  /* ---------------- the split ---------------- */

  function roleMap(rules) {
    var m = {};
    rules.roles.forEach(function (r) { m[r.key] = r; });
    return m;
  }

  /**
   * Every share of one shift. Input is a validated shift. Returns
   *   { totalIn, card, cash, sales, pieces: [...], people: [...],
   *     cashPaid, toCard, check: {in, out, balanced}, notes, headsUp }
   * where each person is
   *   { pid, name, role, roleName, q, total, card, cash, rounding, lines }
   * and `lines` is the arithmetic in words, the way it is shown to staff.
   */
  function split(shift) {
    var rules = shift.rules;
    var roles = roleMap(rules);
    var crew = shift.crew;
    var T = shift.card + shift.cash;
    var notes = [];
    var people = crew.map(function (p) {
      var role = roles[p.role] || { name: p.role, pts: 100 };
      return { pid: p.pid, name: p.name, role: p.role, roleName: role.name, manager: Boolean(role.manager || looksManager(role.name)), q: p.q, pts: role.pts, total: 0, card: 0, cash: 0, rounding: 0, lines: [] };
    });
    var pieces = [];
    var weightOf = function (p, by) { return by === 'points' ? p.pts * p.q : p.q; };
    var unitText = function (by) { return by === 'points' ? 'points' : 'hours'; };
    var measure = function (p, by) {
      return by === 'points'
        ? p.roleName + ' ' + ptsText(p.pts) + ' pts × ' + hoursText(p.q) + ' h = ' + fmtW(p.pts * p.q, 'points')
        : hoursText(p.q);
    };
    function fmtW(w, by) { return by === 'points' ? String(Math.round(w / 4) / 100) : hoursText(w); }

    var stuck = null;
    /** Give `amount` to `group` by weight; write each person's line. */
    function share(amount, group, by, label) {
      var ws = group.map(function (p) { return weightOf(p, by); });
      var W = ws.reduce(function (a, b) { return a + b; }, 0);
      if (!W && amount > 0) { stuck = stuck || 'Nobody in the pool has any ' + unitText(by) + ' to share ' + money(amount) + ' by. Add hours, or give the role some points.'; }
      var a = allocate(amount, ws);
      group.forEach(function (p, i) {
        p.total += a.parts[i];
        p.rounding += a.extra[i];
        if (!ws[i]) { p.lines.push(label + ': no ' + (by === 'points' && p.q ? 'points' : 'hours') + ' this shift, so no share.'); return; }
        p.lines.push(label + ': ' + measure(p, by) + ' of ' + fmtW(W, by) + ' ' + unitText(by) + ' = ' + pctOf(ws[i], W) + ' of ' + money(amount) + ' → ' + money(a.parts[i]) +
          (a.extra[i] ? ' (incl. ' + a.extra[i] + '¢ rounding)' : ''));
      });
      return { W: W, by: by };
    }

    var working = people.filter(function (p) { return p.q > 0; });
    if (!working.length) {
      return { error: 'Add hours for at least one person.', field: 'crew' };
    }

    if (rules.method === 'tipout') {
      var left = T;
      rules.tipouts.forEach(function (t) {
        var role = roles[t.to];
        var group = people.filter(function (p) { return p.role === t.to; });
        var base = t.of === 'sales' ? shift.sales : T;
        var label = role.name + ' tip-out';
        var piece = { kind: 'tipout', to: t.to, roleName: role.name, bp: t.bp, of: t.of, base: base, amount: 0, people: group.length };
        var hrs = group.reduce(function (s, p) { return s + p.q; }, 0);
        if (!hrs) { piece.skipped = 'Nobody on ' + role.name + ' worked, so their ' + bpText(t.bp) + ' stays in the pool.'; notes.push(piece.skipped); pieces.push(piece); return; }
        if (t.of === 'sales' && (base === null || base === undefined)) {
          piece.skipped = 'Enter food sales to work out the ' + role.name + ' tip-out (' + bpText(t.bp) + ' of sales). Until then it stays in the pool.';
          notes.push(piece.skipped); pieces.push(piece);
          group.forEach(function (p) { p.lines.push(label + ': waiting on food sales, so nothing yet.'); });
          return;
        }
        var want = Math.floor((t.bp * base + 5000) / 10000);
        var amount = Math.min(want, left);
        if (amount < want) { piece.capped = want; notes.push('The tip-outs ask for more than the tips hold, so ' + role.name + ' gets the ' + money(amount) + ' that was left, not ' + money(want) + '.'); }
        left -= amount;
        piece.amount = amount;
        piece.formula = bpText(t.bp) + ' of ' + (t.of === 'sales' ? money(base) + ' food sales' : money(base) + ' tips') + ' = ' + money(want);
        share(amount, group, 'hours', label + ' (' + piece.formula + ')');
        pieces.push(piece);
      });
      // A tip-out role is paid by its tip-out, never from the rest - even on a
      // night its tip-out is skipped (no food sales typed yet).
      var outRoles = {};
      rules.tipouts.forEach(function (t) { outRoles[t.to] = true; });
      var rest = people.filter(function (p) { return !outRoles[p.role]; });
      var restWorking = rest.filter(function (p) { return weightOf(p, rules.restBy) > 0; });
      var restPiece = { kind: 'rest', amount: left, by: rules.restBy, people: rest.length };
      if (!restWorking.length && left > 0) {
        notes.push('Only tip-out roles worked, so the ' + money(left) + ' left after tip-outs is shared by everyone by ' + unitText(rules.restBy) + '.');
        rest = people;
        restPiece.people = people.length;
        restPiece.everyone = true;
      }
      var info = share(left, rest, rules.restBy, 'The rest after tip-outs');
      restPiece.W = info.W;
      pieces.push(restPiece);
    } else {
      var by = rules.method === 'points' ? 'points' : 'hours';
      var info2 = share(T, people, by, 'Share of the pool');
      pieces.push({ kind: 'pool', amount: T, by: by, W: info2.W, people: people.length });
    }

    if (stuck) return { error: stuck, field: 'crew' };

    // Card and cash, separately. Cash goes out in proportion to each share,
    // never more than the share; in whole dollars when the house pays cash in
    // whole dollars, the coins moving to card (payroll). Card is what is left
    // of each share, so card + cash is the share to the cent.
    var unit = rules.cashDollars ? 100 : 1;
    var cashUnits = Math.floor(shift.cash / unit);
    var shares = people.map(function (p) { return p.total; });
    var capUnits = shares.map(function (s) { return Math.floor(s / unit); });
    var c = allocate(cashUnits, shares, capUnits);
    var cashPaid = 0;
    people.forEach(function (p, i) {
      p.cash = c.parts[i] * unit;
      p.card = p.total - p.cash;
      cashPaid += p.cash;
      if (p.total) p.lines.push('Paid as ' + money(p.card) + ' card + ' + money(p.cash) + ' cash = ' + money(p.total) + '.');
    });
    var toCard = shift.cash - cashPaid;
    if (toCard > 0) {
      notes.push(rules.cashDollars
        ? money(toCard) + ' of the cash tips can’t go out as whole dollars, so it stays in the drawer and is paid with the card tips (payroll).'
        : money(toCard) + ' of the cash tips stays in the drawer and is paid with the card tips.');
    }
    var out = people.reduce(function (s, p) { return s + p.total; }, 0);
    var result = {
      totalIn: T, card: shift.card, cash: shift.cash, sales: shift.sales,
      method: rules.method, restBy: rules.restBy, cashDollars: rules.cashDollars,
      pieces: pieces, people: people, cashPaid: cashPaid, toCard: toCard,
      check: { in: T, out: out, cardOut: out - cashPaid, cashOut: cashPaid, balanced: out === T },
      notes: notes,
    };
    result.headsUp = headsUp(result);
    return result;
  }

  /**
   * The fairness note. Informational only: it never changes a number. Under
   * the US Fair Labor Standards Act (as amended in 2018) managers and
   * supervisors may not keep any employee's tips, including from a pool.
   */
  function headsUp(result) {
    var who = result.people.filter(function (p) { return p.manager && p.total > 0; });
    if (!who.length) return null;
    var names = who.map(function (p) { return p.name + ' (' + p.roleName + ')'; });
    return {
      people: who.map(function (p) { return p.pid; }),
      title: 'Heads-up: ' + (who.length === 1 ? 'a manager is' : 'managers are') + ' in this pool',
      text: names.join(', ') + (who.length === 1 ? ' is' : ' are') + ' marked as a manager or supervisor and would take ' + money(who.reduce(function (s, p) { return s + p.total; }, 0)) + ' from the pool. ' +
        'Under the US federal Fair Labor Standards Act (since 2018), managers and supervisors may not keep tips from a tip pool. ' +
        'Check your state and local rules before paying this out. This is a heads-up, not legal advice.',
    };
  }

  /* ---------------- cash envelopes ---------------- */

  function drawerCents(drawer) {
    var t = 0;
    DENOMS.forEach(function (d) { t += d.c * ((drawer && drawer[String(d.c)]) || 0); });
    return t;
  }

  /** Bills and coins for one amount, largest first, from unlimited stock. */
  function greedyOne(cents, stock) {
    var bills = [];
    var rem = cents;
    for (var k = 0; k < DENOMS.length && rem > 0; k++) {
      var d = DENOMS[k].c;
      var n = Math.floor(rem / d);
      if (stock) n = Math.min(n, stock[k]);
      if (n > 0) { bills.push({ c: d, n: n }); rem -= n * d; if (stock) stock[k] -= n; }
    }
    return { bills: bills, short: rem };
  }

  /**
   * Exact change for every envelope from a limited drawer, if there is a way.
   * A depth-first search: people largest first, each envelope filled from the
   * largest bill down, backing off a bill at a time when what is left of the
   * drawer cannot make the rest. Bounded by `budget` steps; when the search
   * finishes without a way, the answer is PROVEN impossible.
   */
  function solveExact(amounts, stock, budget) {
    var n = amounts.length;
    var order = amounts.map(function (a, i) { return i; }).sort(function (a, b) { return amounts[b] - amounts[a] || a - b; });
    var res = amounts.map(function () { return DENOMS.map(function () { return 0; }); });
    var steps = budget || 200000;
    var STOP = {};
    function valueFrom(k) { var v = 0; for (var j = k; j < DENOMS.length; j++) v += DENOMS[j].c * stock[j]; return v; }
    function need(pi) { var v = 0; for (var j = pi; j < n; j++) v += amounts[order[j]]; return v; }
    function person(pi) {
      if (pi === n) return true;
      if (need(pi) > valueFrom(0)) return false;
      return fill(order[pi], amounts[order[pi]], 0, pi);
    }
    function fill(p, rem, k, pi) {
      if (--steps < 0) throw STOP;
      if (rem === 0) return person(pi + 1);
      if (k === DENOMS.length) return false;
      var d = DENOMS[k].c;
      var max = Math.min(stock[k], Math.floor(rem / d));
      var after = valueFrom(k + 1);
      for (var c = max; c >= 0; c--) {
        if (rem - c * d > after) break;       // fewer of this bill can only leave more to make
        stock[k] -= c; res[p][k] = c;
        if (fill(p, rem - c * d, k + 1, pi)) return true;
        stock[k] += c; res[p][k] = 0;
      }
      return false;
    }
    try {
      return person(0) ? { found: true, res: res } : { found: false, proven: true };
    } catch (e) {
      if (e === STOP) return { found: false, proven: false };
      throw e;
    }
  }

  /**
   * The envelopes. `pays` is [{pid, name, cents}]; `drawer` is {"2000": 12,
   * ...} or null (not counted - then the envelopes are the ideal ones and
   * say so). Returns
   *   { counted, need, exact, proven, people: [{pid, name, cents, bills, short}],
   *     left: [{c, n}], leftCents, status, message, advice: [...] }
   */
  function envelopes(pays, drawer) {
    var list = pays.filter(function (p) { return p.cents > 0; });
    var need = list.reduce(function (s, p) { return s + p.cents; }, 0);
    var out = { counted: null, need: need, exact: true, proven: true, people: [], left: [], leftCents: 0, advice: [] };
    if (!drawer) {
      out.people = list.map(function (p) { var g = greedyOne(p.cents, null); return { pid: p.pid, name: p.name, cents: p.cents, bills: g.bills, short: 0 }; });
      out.status = 'ideal';
      out.message = need ? 'Fewest bills for each envelope. Count the drawer to check you can make them.' : 'No cash to hand out.';
      return out;
    }
    var stock = DENOMS.map(function (d) { return Number(drawer[String(d.c)]) || 0; });
    out.counted = drawerCents(drawer);
    var toBills = function (row) { var b = []; row.forEach(function (n, k) { if (n) b.push({ c: DENOMS[k].c, n: n }); }); return b; };
    var solved = out.counted >= need ? solveExact(list.map(function (p) { return p.cents; }), stock.slice(), 200000) : { found: false, proven: true };
    if (solved.found) {
      var used = DENOMS.map(function () { return 0; });
      out.people = list.map(function (p, i) {
        solved.res[i].forEach(function (n, k) { used[k] += n; });
        return { pid: p.pid, name: p.name, cents: p.cents, bills: toBills(solved.res[i]), short: 0 };
      });
      out.left = toBills(stock.map(function (s, k) { return s - used[k]; }));
      out.leftCents = out.counted - need;
      out.status = 'exact';
      out.message = need ? 'Exact change for every envelope.' + (out.leftCents ? ' ' + money(out.leftCents) + ' stays in the drawer.' : ' The drawer comes out to zero.') : 'No cash to hand out.';
      return out;
    }
    // No exact way (or none found in time): the best the drawer can do,
    // largest envelopes first, and what is missing from each.
    out.exact = false;
    out.proven = solved.proven;
    var st = stock.slice();
    var order = list.map(function (p, i) { return i; }).sort(function (a, b) { return list[b].cents - list[a].cents || a - b; });
    var rows = [];
    order.forEach(function (i) { var g = greedyOne(list[i].cents, st); rows[i] = { pid: list[i].pid, name: list[i].name, cents: list[i].cents, bills: g.bills, short: g.short }; });
    out.people = rows;
    out.left = toBills(st);
    out.leftCents = st.reduce(function (s, n, k) { return s + n * DENOMS[k].c; }, 0);
    var shortTotal = rows.reduce(function (s, r) { return s + r.short; }, 0);
    out.status = 'short';
    if (out.counted < need) {
      out.message = 'The drawer holds ' + money(out.counted) + ' but the envelopes need ' + money(need) + ' — ' + money(need - out.counted) + ' short.';
      out.advice.push('Recount the cash, or pay the missing ' + money(need - out.counted) + ' with the card tips (payroll).');
    } else {
      out.message = (solved.proven ? 'The drawer can’t make exact change' : 'We couldn’t find a way to make exact change') + ': the envelopes come out ' + money(shortTotal) + ' short, with ' + money(out.leftCents) + ' left in the drawer in bills too big to use.';
      var biggestShort = rows.reduce(function (m, r) { return Math.max(m, r.short); }, 0);
      var lefts = out.left.map(function (b) { return b.c; });
      var pick = null;
      for (var i = lefts.length - 1; i >= 0; i--) if (lefts[i] >= biggestShort) { pick = lefts[i]; break; }
      if (pick === null && lefts.length) pick = lefts[0];
      if (pick !== null) out.advice.push('Swap one ' + denomLabel(pick) + ' from the drawer for smaller bills (at the bar till or the safe), add them to the count, and the envelopes will rebuild.');
    }
    return out;
  }

  function denomLabel(c) { for (var i = 0; i < DENOMS.length; i++) if (DENOMS[i].c === c) return DENOMS[i].label; return money(c); }
  function billsText(bills) {
    if (!bills.length) return 'nothing';
    return bills.map(function (b) { return b.n + ' × ' + denomLabel(b.c); }).join(', ');
  }

  /** Envelopes straight from a split result. */
  function envelopesFor(result, drawer) {
    return envelopes(result.people.map(function (p) { return { pid: p.pid, name: p.name, cents: p.cash }; }), drawer);
  }

  /* ---------------- words ---------------- */

  function methodLine(result) {
    if (result.method === 'hours') return 'Split by hours worked.';
    if (result.method === 'points') return 'Split by role points × hours worked.';
    return 'Tip-outs first, then the rest split by ' + (result.restBy === 'points' ? 'points × hours.' : 'hours worked.');
  }

  /** The whole shift as plain text, for Copy and the share sheet. */
  function receiptText(shift, result) {
    var L = [];
    L.push('TIP RECEIPT · ' + dayShort(shift.date) + ' · ' + partLabel(shift.part));
    L.push('Pool: ' + money(result.totalIn) + ' (card ' + money(result.card) + ' + cash ' + money(result.cash) + ')' + (result.sales !== null && result.sales !== undefined ? ' · food sales ' + money(result.sales) : ''));
    L.push(methodLine(result));
    result.pieces.forEach(function (p) {
      if (p.kind === 'tipout') L.push(p.skipped ? '- ' + p.skipped : '- ' + p.roleName + ' tip-out: ' + p.formula + (p.capped ? ' (capped at ' + money(p.amount) + ')' : ''));
    });
    L.push('');
    result.people.forEach(function (p) {
      L.push(p.name + ' (' + p.roleName + ', ' + hoursText(p.q) + ' h): ' + money(p.total) + '  [card ' + money(p.card) + ', cash ' + money(p.cash) + ']');
      p.lines.forEach(function (l) { L.push('   ' + l); });
    });
    L.push('');
    L.push('Paid out ' + money(result.check.out) + ' = tips in ' + money(result.check.in) + (result.check.balanced ? ' ✓ balanced to the cent' : ' ✗ NOT balanced'));
    result.notes.forEach(function (n) { L.push('Note: ' + n); });
    return L.join('\n');
  }

  /* ---------------- the frozen receipt a link shows ---------------- */

  /**
   * Field by field, never a spread of the shift: the date, the part of the
   * day, the pool's totals, the method and its pieces, and for each person
   * their first name, role, hours and money with the arithmetic. No notes,
   * no account, no venue. `pid` narrows it to one person (their own link):
   * the pool's totals and the pieces stay, everyone else's line goes.
   */
  function shareCard(shift, result, pid, at) {
    var pieces = result.pieces.map(function (p) {
      return p.kind === 'tipout'
        ? { kind: 'tipout', roleName: p.roleName, bp: p.bp, of: p.of, amount: p.amount, formula: p.formula || '', skipped: p.skipped || '' }
        : { kind: p.kind, amount: p.amount, by: p.by, W: p.W, people: p.people };
    });
    var person = function (p) {
      return { pid: p.pid, name: p.name, roleName: p.roleName, hours: hoursText(p.q), total: p.total, card: p.card, cash: p.cash, lines: p.lines.slice(0, 8) };
    };
    var who = pid ? result.people.filter(function (p) { return p.pid === pid; }) : result.people;
    return {
      v: 1,
      kind: pid ? 'person' : 'shift',
      date: shift.date,
      part: shift.part,
      partLabel: partLabel(shift.part),
      method: result.method,
      methodLine: methodLine(result),
      pool: { total: result.totalIn, card: result.card, cash: result.cash, sales: result.sales === undefined ? null : result.sales },
      pieces: pieces,
      headcount: result.people.length,
      people: who.map(person),
      check: { in: result.check.in, out: result.check.out, balanced: result.check.balanced },
      sharedAt: at || null,
    };
  }

  /* ---------------- history: the week ---------------- */

  /**
   * A week of saved shifts (each {id, shift, result}) -> totals per person
   * and per day. Tips per hour is the person's tips over their hours that
   * week, rounded to the cent.
   */
  function week(items, start) {
    var end = addDays(start, 6);
    var days = [];
    for (var i = 0; i < 7; i++) days.push({ date: addDays(start, i), total: 0, shifts: 0 });
    var by = {};
    var total = 0; var q = 0; var shifts = 0;
    items.forEach(function (it) {
      var s = it.shift; var r = it.result;
      if (!s || !r || r.error || s.date < start || s.date > end) return;
      shifts++;
      total += r.totalIn;
      var day = days[Math.round((Date.parse(s.date) - Date.parse(start)) / 864e5)];
      day.total += r.totalIn; day.shifts++;
      r.people.forEach(function (p) {
        var key = p.pid;
        if (!by[key]) by[key] = { pid: p.pid, name: p.name, shifts: 0, q: 0, total: 0, card: 0, cash: 0 };
        var row = by[key];
        row.name = p.name;
        row.shifts++; row.q += p.q; row.total += p.total; row.card += p.card; row.cash += p.cash;
        q += p.q;
      });
    });
    var people = Object.keys(by).map(function (k) {
      var r = by[k];
      r.hours = hoursText(r.q);
      r.perHour = r.q ? Math.round((r.total * 4) / r.q) : null;
      return r;
    }).sort(function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); });
    return { start: start, end: end, label: rangeText(start, end), days: days, people: people, total: total, shifts: shifts, q: q, hours: hoursText(q), perHour: q ? Math.round((total * 4) / q) : null };
  }

  /* ---------------- CSV ---------------- */

  /** One CSV cell. Text a spreadsheet would run as a formula gets a leading
   *  apostrophe; numbers WE formatted stay numbers. */
  function csvCell(v, isNumber) {
    var s = String(v == null ? '' : v);
    if (!(isNumber && /^-?\d+(\.\d+)?$/.test(s)) && /^[=+\-@\t\r]/.test(s)) s = '\'' + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv(items) {
    var head = ['Date', 'Shift', 'Name', 'Role', 'Hours', 'Card tips', 'Cash tips', 'Total tips', 'Tips per hour', 'Pool total', 'Method'];
    var lines = [head.map(function (h) { return csvCell(h); }).join(',')];
    items.slice().sort(function (a, b) { return a.shift.date < b.shift.date ? -1 : a.shift.date > b.shift.date ? 1 : PART_KEYS.indexOf(a.shift.part) - PART_KEYS.indexOf(b.shift.part); })
      .forEach(function (it) {
        var s = it.shift; var r = it.result;
        if (!r || r.error) return;
        r.people.forEach(function (p) {
          lines.push([
            csvCell(s.date), csvCell(partLabel(s.part)), csvCell(p.name), csvCell(p.roleName), csvCell(hoursText(p.q), true),
            csvCell(plain(p.card), true), csvCell(plain(p.cash), true), csvCell(plain(p.total), true),
            csvCell(p.q ? plain(Math.round((p.total * 4) / p.q)) : '', true), csvCell(plain(r.totalIn), true), csvCell(methodInfo(r.method).label),
          ].join(','));
        });
      });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  return {
    LIMITS: LIMITS, METHODS: METHODS, PARTS: PARTS, DENOMS: DENOMS, DENOM_CENTS: DENOM_CENTS, TEMPLATES: TEMPLATES,
    template: template, methodInfo: methodInfo, partLabel: partLabel,
    clean: clean, cleanName: cleanName, slug: slug, looksManager: looksManager,
    toCents: toCents, toHundredths: toHundredths, toQuarters: toQuarters,
    money: money, moneyTight: moneyTight, plain: plain, hoursText: hoursText, ptsText: ptsText, bpText: bpText, pctOf: pctOf, plural: plural,
    isoDay: isoDay, addDays: addDays, weekStart: weekStart, dayShort: dayShort, rangeText: rangeText,
    validateRules: validateRules, validateSetup: validateSetup, validateShift: validateShift, newPid: newPid, PID_RE: PID_RE,
    allocate: allocate, split: split, headsUp: headsUp,
    drawerCents: drawerCents, envelopes: envelopes, envelopesFor: envelopesFor, solveExact: solveExact, denomLabel: denomLabel, billsText: billsText,
    methodLine: methodLine, receiptText: receiptText, shareCard: shareCard,
    week: week, csvCell: csvCell, exportCsv: exportCsv,
  };
});
