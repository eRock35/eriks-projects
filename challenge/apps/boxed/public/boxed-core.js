/* Boxed - the rules. One file, run twice: the page loads it as
 * window.BoxedCore, the server and the tests `require` it, so the checks a
 * preparer sees on a phone are the checks the tests hold.
 *
 * What is here:
 *   - the Schedule K-1 (Form 1065) model: Part III's boxes in the form's own
 *     order with a plain label each, and the common codes of the coded boxes;
 *   - money as integer cents (K-1s print whole dollars; negatives are often
 *     in parentheses), shares as integer millionths of a percent;
 *   - cleaning: a model's reading, a typed K-1, a saved or local client file
 *     all pass through the same whitelist. Partner TINs are masked to their
 *     last four wherever they appear, and a partner's name, TIN and address
 *     are never part of a stored K-1;
 *   - the checks (Item L reconciles, Item L vs the boxes, box 19 vs
 *     withdrawals, Item J, the final/amended/PTP/K-3 flags, year over year,
 *     low-confidence values, "see statement" lines, 4a+4b=4c, 6b <= 6a);
 *   - the client roll-up, the status board and its time-saved estimate,
 *     what is still missing, the .ics reminders and the CSV exports.
 *
 * Nothing here gives tax advice: the checks find keying and reading errors
 * and say where to look.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoxedCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    files: 10,               // files queued for reading at once (the page)
    pdfBytes: 10 * 1024 * 1024,
    pdfPages: 30,
    photos: 6,               // photos of one K-1
    photoBytes: 3 * 1024 * 1024,
    photoTotal: 12 * 1024 * 1024,
    lines: 80,               // box/code lines on one K-1
    k1s: 150,                // K-1s in one client file (this year's and last year's)
    clients: 25,             // client files per person
    expected: 150,           // expected partnerships in one client file
    name: 120,
    label: 80,
    maxCents: 10000000000000, // $100,000,000,000 - any one figure
    minYear: 2000,
    maxYear: 2100,
  };

  // Minutes a preparer takes to key one K-1 by hand - the page states it.
  var MINUTES_BY_HAND = 20;

  /* ---------------- the form ---------------- */

  // Part III in the form's own order. `col` is the column it sits in on the
  // printed form (left: 1-13, right: 14-23). `kind`: amount, coded (a list
  // of code + amount), or check (a checkbox).
  var BOXES = [
    { box: '1', label: 'Ordinary business income (loss)', col: 1, kind: 'amount' },
    { box: '2', label: 'Net rental real estate income (loss)', col: 1, kind: 'amount' },
    { box: '3', label: 'Other net rental income (loss)', col: 1, kind: 'amount' },
    { box: '4a', label: 'Guaranteed payments for services', col: 1, kind: 'amount' },
    { box: '4b', label: 'Guaranteed payments for capital', col: 1, kind: 'amount' },
    { box: '4c', label: 'Total guaranteed payments', col: 1, kind: 'amount' },
    { box: '5', label: 'Interest income', col: 1, kind: 'amount' },
    { box: '6a', label: 'Ordinary dividends', col: 1, kind: 'amount' },
    { box: '6b', label: 'Qualified dividends', col: 1, kind: 'amount' },
    { box: '6c', label: 'Dividend equivalents', col: 1, kind: 'amount' },
    { box: '7', label: 'Royalties', col: 1, kind: 'amount' },
    { box: '8', label: 'Net short-term capital gain (loss)', col: 1, kind: 'amount' },
    { box: '9a', label: 'Net long-term capital gain (loss)', col: 1, kind: 'amount' },
    { box: '9b', label: 'Collectibles (28%) gain (loss)', col: 1, kind: 'amount' },
    { box: '9c', label: 'Unrecaptured section 1250 gain', col: 1, kind: 'amount' },
    { box: '10', label: 'Net section 1231 gain (loss)', col: 1, kind: 'amount' },
    { box: '11', label: 'Other income (loss)', col: 1, kind: 'coded' },
    { box: '12', label: 'Section 179 deduction', col: 1, kind: 'amount' },
    { box: '13', label: 'Other deductions', col: 1, kind: 'coded' },
    { box: '14', label: 'Self-employment earnings (loss)', col: 2, kind: 'coded' },
    { box: '15', label: 'Credits', col: 2, kind: 'coded' },
    { box: '16', label: 'Schedule K-3 is attached if checked', col: 2, kind: 'check' },
    { box: '17', label: 'Alternative minimum tax (AMT) items', col: 2, kind: 'coded' },
    { box: '18', label: 'Tax-exempt income and nondeductible expenses', col: 2, kind: 'coded' },
    { box: '19', label: 'Distributions', col: 2, kind: 'coded' },
    { box: '20', label: 'Other information', col: 2, kind: 'coded' },
    { box: '21', label: 'Foreign taxes paid or accrued', col: 2, kind: 'amount' },
    { box: '22', label: 'More than one activity for at-risk purposes', col: 2, kind: 'check' },
    { box: '23', label: 'More than one activity for passive activity purposes', col: 2, kind: 'check' },
  ];
  var BOX = {};
  BOXES.forEach(function (b, i) { b.order = i; BOX[b.box] = b; });
  var VALUE_BOXES = BOXES.filter(function (b) { return b.kind !== 'check'; }).map(function (b) { return b.box; });
  var CHECK_BOXES = { '16': 'k3', '22': 'atRisk', '23': 'passive' };
  var CHECK_PHRASE = { '16': 'Schedule K-3 attached', '22': 'more than one activity (at-risk)', '23': 'more than one activity (passive)' };

  // The common codes of the coded boxes, from the partner's instructions.
  // Not every code: one that is not here is kept with its letter and read as
  // "(see the partnership's statement)".
  var CODES = {
    '11': {
      A: 'Other portfolio income (loss)', B: 'Involuntary conversions', C: 'Section 1256 contracts and straddles',
      D: 'Mining exploration costs recapture', E: 'Cancellation of debt', F: 'Section 743(b) positive income adjustments',
      ZZ: 'Other income (loss)',
    },
    '13': {
      A: 'Cash contributions (60%)', B: 'Cash contributions (30%)', C: 'Noncash contributions (50%)', D: 'Noncash contributions (30%)',
      E: 'Capital gain property to a 50% organization (30%)', F: 'Capital gain property (20%)', G: 'Contributions (100%)',
      H: 'Investment interest expense', I: 'Deductions - royalty income', J: 'Section 59(e)(2) expenditures', ZZ: 'Other deductions',
    },
    '14': { A: 'Net earnings (loss) from self-employment', B: 'Gross farming or fishing income', C: 'Gross nonfarm income' },
    '15': {
      A: 'Low-income housing credit (section 42(j)(5)), pre-2008 buildings', B: 'Low-income housing credit (other), pre-2008 buildings',
      C: 'Low-income housing credit (section 42(j)(5)), post-2007 buildings', D: 'Low-income housing credit (other), post-2007 buildings',
      E: 'Qualified rehabilitation expenditures (rental real estate)', F: 'Other rental real estate credits', G: 'Other rental credits',
      H: 'Undistributed capital gains credit', ZZ: 'Other credits',
    },
    '17': {
      A: 'Post-1986 depreciation adjustment', B: 'Adjusted gain or loss', C: 'Depletion (other than oil & gas)',
      D: 'Oil, gas & geothermal - gross income', E: 'Oil, gas & geothermal - deductions', F: 'Other AMT items',
    },
    '18': { A: 'Tax-exempt interest income', B: 'Other tax-exempt income', C: 'Nondeductible expenses' },
    '19': { A: 'Distributions of cash and marketable securities', B: 'Distribution subject to section 737', C: 'Distributions of other property' },
    '20': {
      A: 'Investment income', B: 'Investment expenses', C: 'Fuel tax credit information', N: 'Business interest expense (section 163(j))',
      Z: 'Section 199A information', AG: 'Gross receipts for section 448(c)', ZZ: 'Other information',
    },
  };
  var CODE_RE = /^([A-Z]|[A-Z]{2})$/;
  var UNKNOWN_CODE = '(see the partnership’s statement)';

  // Items J, K and L: the fields, their labels and their kind.
  var ITEMS = [
    { key: 'j.profitBeg', item: 'J', label: 'Profit - beginning', kind: 'pct' },
    { key: 'j.profitEnd', item: 'J', label: 'Profit - ending', kind: 'pct' },
    { key: 'j.lossBeg', item: 'J', label: 'Loss - beginning', kind: 'pct' },
    { key: 'j.lossEnd', item: 'J', label: 'Loss - ending', kind: 'pct' },
    { key: 'j.capitalBeg', item: 'J', label: 'Capital - beginning', kind: 'pct' },
    { key: 'j.capitalEnd', item: 'J', label: 'Capital - ending', kind: 'pct' },
    { key: 'k.nonrecourseBeg', item: 'K', label: 'Nonrecourse - beginning', kind: 'money' },
    { key: 'k.nonrecourseEnd', item: 'K', label: 'Nonrecourse - ending', kind: 'money' },
    { key: 'k.qualifiedBeg', item: 'K', label: 'Qualified nonrecourse financing - beginning', kind: 'money' },
    { key: 'k.qualifiedEnd', item: 'K', label: 'Qualified nonrecourse financing - ending', kind: 'money' },
    { key: 'k.recourseBeg', item: 'K', label: 'Recourse - beginning', kind: 'money' },
    { key: 'k.recourseEnd', item: 'K', label: 'Recourse - ending', kind: 'money' },
    { key: 'l.beginning', item: 'L', label: 'Beginning capital account', kind: 'money' },
    { key: 'l.contributed', item: 'L', label: 'Capital contributed during the year', kind: 'money' },
    { key: 'l.currentYear', item: 'L', label: 'Current year net income (loss)', kind: 'money' },
    { key: 'l.other', item: 'L', label: 'Other increase (decrease)', kind: 'money' },
    { key: 'l.withdrawals', item: 'L', label: 'Withdrawals and distributions', kind: 'money' },
    { key: 'l.ending', item: 'L', label: 'Ending capital account', kind: 'money' },
  ];
  var ITEM = {};
  ITEMS.forEach(function (f) { ITEM[f.key] = f; });
  var ITEM_KEYS = ITEMS.map(function (f) { return f.key; });
  var BASES = ['tax', 'gaap', '704b', 'other'];
  var BASIS_LABEL = { tax: 'Tax basis', gaap: 'GAAP', '704b': 'Section 704(b) book', other: 'Other' };
  var CONF = ['high', 'medium', 'low'];
  var STAGES = ['received', 'read', 'checked', 'exported'];
  var STAGE_LABEL = { received: 'Received', read: 'Read', checked: 'Checked', exported: 'Exported' };
  var SOURCES = ['pdf', 'photo', 'manual'];
  var ENTITY_TYPES = ['individual', 'corporation', 's_corporation', 'partnership', 'trust', 'estate', 'ira', 'exempt', 'llc', 'other'];

  /* ---------------- text ---------------- */

  /** Plain text only: markup, control and direction-override characters
   *  out, whitespace collapsed, cut to `max` with an ellipsis. */
  function clean(v, max) {
    var s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 2000) s = s.slice(0, max * 4 + 2000);
    s = s.replace(/<[^>]*>?/g, ' ')
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (s.length > max) s = s.slice(0, max - 1).replace(/\s+$/, '') + '…';
    return s;
  }
  function oneOf(v, list, dflt) { return list.indexOf(v) >= 0 ? v : dflt; }
  function bool(v) { return v === true; }

  /* ---------------- TINs: last four only ---------------- */

  /** Every SSN- or EIN-shaped number in a string, masked to its last four:
   *  123-45-6789 -> •••-••-6789, 12-3456789 -> ••-•••6789, and a bare
   *  nine-digit run -> •••-••-6789. Applied to every string a model returns. */
  function scrubTins(s) {
    return String(s)
      .replace(/(^|[^\d])(\d{2})[-‐–\s](\d{3})(\d{4})(?!\d)/g, function (_m, pre, _a, _b, last) { return pre + '••-•••' + last; })
      .replace(/(^|[^\d])(\d{3})[-‐–\s]?(\d{2})[-‐–\s]?(\d{4})(?!\d)/g, function (_m, pre, _a, _b, last) { return pre + '•••-••-' + last; });
  }
  /** The last four digits of anything typed or read as a TIN, or ''. */
  function last4(v) {
    var d = String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
    return d.length >= 4 ? d.slice(-4) : '';
  }
  /** A partner's TIN as the page may show it - the last four, masked in the
   *  shape it was printed in (EIN shape for an entity). */
  function maskTin(v, entityType) {
    var s = String(v === null || v === undefined ? '' : v);
    var four = last4(s);
    if (!four) return '';
    var einShape = /\d{2}[-‐–\s]\d{7}/.test(s) || (!/\d{3}[-‐–\s]\d{2}[-‐–\s]\d{4}/.test(s) && entityType && entityType !== 'individual');
    return einShape ? '••-•••' + four : '•••-••-' + four;
  }
  function maskEin(ein4) { return ein4 ? '••-•••' + ein4 : ''; }

  /* ---------------- money and shares ---------------- */

  /**
   * A K-1 figure as integer cents, or null. "48,210", "$48,210", "48210.00",
   * "(1,250)", "-1,250", "1,250-", "−1,250" and whole numbers all read; a
   * third decimal rounds half up. Read from the digits as text, never as a
   * float. Words, "STMT" and an empty box are no figure.
   */
  function toCents(v) {
    if (typeof v === 'number') {
      if (!isFinite(v)) return null;
      v = v.toFixed(3);
    }
    if (typeof v !== 'string') return null;
    var s = v.replace(/[\s,$]/g, '').replace(/^USD/i, '').replace(/[\u2212\u2012\u2013\u2014]/g, '-');
    var neg = false;
    var paren = /^\((.*)\)$/.exec(s);
    if (paren) { neg = true; s = paren[1]; }
    if (s.charAt(0) === '-') { neg = !neg; s = s.slice(1); } else if (s.charAt(s.length - 1) === '-') { neg = !neg; s = s.slice(0, -1); }
    if (s.charAt(0) === '+') s = s.slice(1);
    if (s.charAt(0) === '$') s = s.slice(1);
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
    var parts = s.split('.');
    var whole = parts[0] || '0';
    var frac = (parts[1] || '') + '000';
    if (whole.replace(/^0+/, '').length > 14) return null;
    var cents = Number(whole) * 100 + Number(frac.slice(0, 2)) + (Number(frac.charAt(2)) >= 5 ? 1 : 0);
    if (!isFinite(cents) || cents > LIMITS.maxCents) return null;
    return neg && cents ? -cents : cents;
  }

  function groups(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /** $48,210 - with cents only when there are any; negatives with a minus. */
  function money(cents, opts) {
    if (cents === null || cents === undefined) return '';
    var o = opts || {};
    var neg = cents < 0;
    var a = Math.abs(cents);
    var body = (o.whole || a % 100 === 0) ? groups(Math.round(a / 100)) : groups(Math.floor(a / 100)) + '.' + String(a % 100).padStart(2, '0');
    if (o.paren) return neg ? '(' + body + ')' : body;
    return (neg ? '−' : '') + (o.bare ? '' : '$') + body;
  }
  /** The way a K-1 prints it, for an input box: 48,210 or (1,250). */
  function formMoney(cents) { return money(cents, { paren: true }); }
  /** For a CSV: 48210.00 / -1250.00, no symbols. */
  function plainMoney(cents) {
    if (cents === null || cents === undefined) return '';
    var a = Math.abs(cents);
    return (cents < 0 ? '-' : '') + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
  }

  var PCT_SCALE = 1000000;  // millionths of a percent: K-1s print up to six decimals
  /** A share as integer millionths of a percent: "2.5", "2.500000%" and
   *  "2.5 %" are 2500000. Always read as a percent; null if not a number. */
  function toPct(v) {
    if (typeof v === 'number') { if (!isFinite(v)) return null; v = v.toFixed(7); }
    if (typeof v !== 'string') return null;
    var s = v.replace(/[\s%]/g, '');
    var neg = false;
    if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
    var parts = s.split('.');
    var whole = parts[0] || '0';
    if (whole.replace(/^0+/, '').length > 6) return null;
    var frac = ((parts[1] || '') + '0000000').slice(0, 7);
    var n = Number(whole) * PCT_SCALE + Number(frac.slice(0, 6)) + (Number(frac.charAt(6)) >= 5 ? 1 : 0);
    return neg && n ? -n : n;
  }
  /** 2500000 -> "2.5%". */
  function pctText(n, bare) {
    if (n === null || n === undefined) return '';
    var neg = n < 0; var a = Math.abs(n);
    var w = Math.floor(a / PCT_SCALE); var f = String(a % PCT_SCALE).padStart(6, '0').replace(/0+$/, '');
    return (neg ? '−' : '') + w + (f ? '.' + f : '') + (bare ? '' : '%');
  }

  /* ---------------- dates ---------------- */

  function isoDay(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var d = new Date(v + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === v;
  }
  function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(iso) {
    if (!isoDay(iso)) return '';
    return MONTHS[Number(iso.slice(5, 7)) - 1] + ' ' + Number(iso.slice(8, 10)) + ', ' + iso.slice(0, 4);
  }
  function cleanYear(v) {
    var n = typeof v === 'number' ? v : Number(String(v === null || v === undefined ? '' : v).replace(/\D/g, '').slice(0, 4));
    return Number.isInteger(n) && n >= LIMITS.minYear && n <= LIMITS.maxYear ? n : null;
  }
  /** March 15 after the tax year: the deadline for a calendar-year partnership. */
  function defaultDue(taxYear) { return (Number(taxYear) + 1) + '-03-15'; }

  /* ---------------- ids ---------------- */

  /** 64 bits of FNV-1a as hex: a stable id from a string, the same in the
   *  browser and on the server. */
  function hash(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8);
  }
  var ID_RE = /^[a-z0-9]{6,24}$/;
  function newId(prefix) {
    var r = '';
    for (var i = 0; i < 12; i++) r += 'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36));
    return (prefix || 'k') + r;
  }

  /** A partnership's name folded for matching: case, punctuation, "&",
   *  "The" and the entity suffix (LP, L.P., LLC, Ltd, Inc) do not count. */
  function partnershipKey(name) {
    return String(name || '').toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/\bl\.\s*l\.\s*c\.?|\bl\.\s*l\.\s*l\.\s*p\.?|\bl\.\s*l\.\s*p\.?|\bl\.\s*p\.?/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(the|lp|llc|llp|lllp|ltd|inc|co|corp)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  /* ---------------- a K-1, cleaned ---------------- */

  function codeLabel(box, code) {
    if (!code) return '';
    var t = CODES[box];
    return (t && t[code]) || UNKNOWN_CODE;
  }
  function lineLabel(line) {
    var b = BOX[line.box];
    if (!b) return '';
    if (b.kind === 'coded') return 'Box ' + line.box + (line.code ? ' code ' + line.code : '') + (line.code ? ' - ' + codeLabel(line.box, line.code) : ' - ' + b.label);
    return 'Box ' + line.box + ' - ' + b.label;
  }
  function cleanCode(v) {
    var s = String(v === null || v === undefined ? '' : v).trim().toUpperCase().replace(/^CODE\s*/, '');
    return CODE_RE.test(s) ? s : null;
  }
  function cleanBox(v) {
    var s = String(v === null || v === undefined ? '' : v).trim().toLowerCase().replace(/^box\s*/, '');
    return BOX[s] ? s : null;
  }
  function cleanPage(v) { var n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null; }

  /** An empty K-1 for a tax year. */
  function blankK1(taxYear, id) {
    var j = {}, k = {}, l = { basis: null };
    ITEMS.forEach(function (f) { var p = f.key.split('.'); ({ j: j, k: k, l: l })[p[0]][p[1]] = null; });
    return {
      id: id || newId('k'), taxYear: cleanYear(taxYear) || null,
      p: { name: '', ein4: '', center: '', ptp: false },
      final: false, amended: false, k3: false, atRisk: false, passive: false,
      j: j, k: k, l: l, lines: [], at: {},
      src: 'manual', stage: 'read', reviewSecs: 0, result: null,
    };
  }

  /**
   * A stored-shape K-1 (typed, saved, local, or a model's reading after
   * fromModel), cleaned field by field. Whatever else it carried - a
   * partner's name, TIN, address, a transcript - is not copied: this is the
   * whitelist. Returns null if it is not an object.
   */
  function cleanK1(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var k1 = blankK1(raw.taxYear, typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : undefined);
    var p = raw.p && typeof raw.p === 'object' ? raw.p : {};
    k1.p.name = scrubTins(clean(p.name, LIMITS.name));
    k1.p.ein4 = /^\d{4}$/.test(String(p.ein4 || '')) ? String(p.ein4) : '';
    k1.p.center = scrubTins(clean(p.center, 40));
    k1.p.ptp = bool(p.ptp);
    ['final', 'amended', 'k3', 'atRisk', 'passive'].forEach(function (f) { k1[f] = bool(raw[f]); });
    ITEMS.forEach(function (f) {
      var parts = f.key.split('.');
      var src = raw[parts[0]] && typeof raw[parts[0]] === 'object' ? raw[parts[0]][parts[1]] : null;
      var val = null;
      if (Number.isInteger(src)) val = src;
      else if (typeof src === 'string') val = f.kind === 'pct' ? toPct(src) : toCents(src);
      if (val !== null && f.kind === 'money' && Math.abs(val) > LIMITS.maxCents) val = null;
      if (val !== null && f.kind === 'pct' && Math.abs(val) > 1000 * PCT_SCALE) val = null;
      k1[parts[0]][parts[1]] = val;
    });
    k1.l.basis = oneOf(raw.l && raw.l.basis, BASES, null);
    var at = raw.at && typeof raw.at === 'object' ? raw.at : {};
    ITEM_KEYS.forEach(function (key) {
      var a = at[key];
      if (a && typeof a === 'object' && k1FieldValue(k1, key) !== null) {
        var pg = cleanPage(a.p); var c = oneOf(a.c, CONF, null);
        if (pg || c) k1.at[key] = { p: pg, c: c };
      }
    });
    var lines = Array.isArray(raw.lines) ? raw.lines : [];
    lines.slice(0, LIMITS.lines).forEach(function (ln) {
      if (!ln || typeof ln !== 'object') return;
      var box = cleanBox(ln.box);
      if (!box || BOX[box].kind === 'check') return;
      var coded = BOX[box].kind === 'coded';
      var cents = Number.isInteger(ln.cents) && Math.abs(ln.cents) <= LIMITS.maxCents ? ln.cents : (typeof ln.cents === 'string' ? toCents(ln.cents) : null);
      var stmt = bool(ln.stmt);
      if (cents === null && !stmt) return;
      k1.lines.push({ box: box, code: coded ? cleanCode(ln.code) : null, cents: cents, stmt: stmt, page: cleanPage(ln.page), conf: oneOf(ln.conf, CONF, null) });
    });
    sortLines(k1.lines);
    k1.src = oneOf(raw.src, SOURCES, 'manual');
    k1.stage = oneOf(raw.stage, STAGES, 'read');
    k1.reviewSecs = Number.isInteger(raw.reviewSecs) && raw.reviewSecs >= 0 ? Math.min(raw.reviewSecs, 24 * 3600) : 0;
    k1.result = oneOf(raw.result, ['pass', 'look', 'fail'], null);
    return k1;
  }
  function sortLines(lines) {
    lines.sort(function (a, b) {
      return (BOX[a.box].order - BOX[b.box].order) || ((a.code || '').length - (b.code || '').length) || ((a.code || '') < (b.code || '') ? -1 : (a.code || '') > (b.code || '') ? 1 : 0);
    });
    return lines;
  }
  function k1FieldValue(k1, key) { var p = key.split('.'); return k1[p[0]] ? k1[p[0]][p[1]] : null; }

  /** What a stored K-1 holds, and nothing else (for saving and for this
   *  browser's storage). */
  function toSaved(raw) {
    var k = cleanK1(raw);
    if (!k) return null;
    k.result = summarize(checkK1(k)).result;
    return k;
  }

  /**
   * A model's record_k1 answer -> {k1, partner, notes, dropped} or null when
   * it read no K-1. Every string has its markup, control and bidi characters
   * stripped, is bounded, and has any SSN- or EIN-shaped number masked to its
   * last four - including fields that should never have held one. The
   * partner's details come back for the page to show beside this one reading
   * and are never part of the K-1 (cleanK1 does not copy them).
   */
  function fromModel(raw, opts) {
    if (!raw || typeof raw !== 'object' || raw.readable === false) return null;
    var o = opts || {};
    var notes = [];
    var dropped = 0;
    var note = function (s) { if (notes.length < 12) notes.push(s); dropped++; };
    var str = function (v, max) { return scrubTins(clean(v, max)); };
    var part1 = raw.partnership && typeof raw.partnership === 'object' ? raw.partnership : {};
    var part2 = raw.partner && typeof raw.partner === 'object' ? raw.partner : {};
    var k1 = blankK1(raw.taxYear || o.taxYear);
    k1.src = oneOf(o.src, SOURCES, 'pdf');
    k1.p.name = str(part1.name, LIMITS.name);
    k1.p.ein4 = last4(part1.ein);
    k1.p.center = str(part1.irsCenter, 40);
    k1.p.ptp = bool(part1.ptp);
    k1.final = bool(raw.final); k1.amended = bool(raw.amended);
    k1.k3 = bool(raw.k3); k1.atRisk = bool(raw.box22); k1.passive = bool(raw.box23);
    k1.l.basis = oneOf(raw.capitalBasis, BASES, null);
    (Array.isArray(raw.items) ? raw.items : []).slice(0, ITEMS.length * 2).forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var f = ITEM[it.field];
      if (!f) { note('An item that is not on the form was left out.'); return; }
      var v = f.kind === 'pct' ? toPct(typeof it.value === 'number' ? it.value : String(it.value === null || it.value === undefined ? '' : it.value)) : toCents(typeof it.value === 'number' ? it.value : String(it.value === null || it.value === undefined ? '' : it.value));
      if (v === null) { if (it.value !== null && it.value !== undefined && String(it.value).trim() !== '') note('Item ' + f.item + ' ' + f.label.toLowerCase() + ' was not a number and was left out.'); return; }
      var parts = f.key.split('.');
      k1[parts[0]][parts[1]] = v;
      var pg = cleanPage(it.page); var c = oneOf(it.confidence, CONF, null);
      if (pg || c) k1.at[f.key] = { p: pg, c: c };
    });
    var lines = Array.isArray(raw.lines) ? raw.lines : [];
    if (lines.length > LIMITS.lines) { note((lines.length - LIMITS.lines) + ' lines past the ' + LIMITS.lines + '-line limit were left out.'); }
    lines.slice(0, LIMITS.lines).forEach(function (ln) {
      if (!ln || typeof ln !== 'object') { note('A line that could not be read was left out.'); return; }
      var box = cleanBox(ln.box);
      if (!box) { note('Box ' + clean(ln.box, 8) + ' is not on the K-1 and was left out.'); return; }
      var b = BOX[box];
      if (b.kind === 'check') {
        var said = ln.value === true || (typeof ln.value === 'string' && ln.value.trim() !== '' && !/^(no|false|0|unchecked|blank|empty|n)$/i.test(ln.value.trim()));
        k1[CHECK_BOXES[box]] = k1[CHECK_BOXES[box]] || said;
        return;
      }
      var code = null;
      if (b.kind === 'coded') {
        var rawCode = ln.code === null || ln.code === undefined ? '' : String(ln.code).trim();
        code = cleanCode(rawCode);
        if (rawCode && !code) { note('Box ' + box + ' had a code that is not a code ("' + clean(rawCode, 8) + '") and was left out.'); return; }
      }
      var rawVal = ln.value === null || ln.value === undefined ? '' : (typeof ln.value === 'number' ? ln.value : String(ln.value));
      var cents = toCents(rawVal);
      var stmt = bool(ln.seeStatement) || (typeof rawVal === 'string' && /^\s*\*?\s*(stmt|statement|see\s+st(m)?t|see\s+statement|see\s+attached|\*)\s*\*?\s*$/i.test(rawVal));
      if (cents === null && !stmt) {
        if (String(rawVal).trim()) note('Box ' + box + (code ? ' code ' + code : '') + ' was not a number and was left out.');
        return;
      }
      k1.lines.push({ box: box, code: code, cents: cents, stmt: stmt, page: cleanPage(ln.page), conf: oneOf(ln.confidence, CONF, null) });
    });
    sortLines(k1.lines);
    var hasAnything = k1.p.name || k1.lines.length || ITEM_KEYS.some(function (key) { return k1FieldValue(k1, key) !== null; });
    if (!hasAnything) return null;
    var partner = {
      name: str(part2.name, 80),
      tin: maskTin(part2.tinLast4, oneOf(part2.entityType, ENTITY_TYPES, null)),
      type: oneOf(part2.entityType, ENTITY_TYPES, null),
      general: part2.generalOrLimited === 'general' ? true : part2.generalOrLimited === 'limited' ? false : null,
      foreign: part2.domesticOrForeign === 'foreign' ? true : part2.domesticOrForeign === 'domestic' ? false : null,
    };
    return { k1: cleanK1(k1), partner: partner, notes: notes, dropped: dropped, note: str(raw.note, 240) };
  }

  /* ---------------- sums ---------------- */

  function sumBox(k1, box, code) {
    var s = 0, n = 0;
    (k1.lines || []).forEach(function (l) {
      if (l.box === box && (code === undefined || l.code === code) && l.cents !== null) { s += l.cents; n++; }
    });
    return n ? s : null;
  }
  function has(v) { return v !== null && v !== undefined; }

  /** The boxes Item L's current-year line should roughly tie to: income and
   *  loss boxes 1-11 less 12, 13 and 21. 6b, 6c, 9b and 9c are parts of 6a
   *  and 9a, and 4c is 4a + 4b, so none is counted twice. */
  function boxesIncome(k1) {
    var total = 0, any = false;
    var add = function (v, sign) { if (has(v)) { total += sign * v; any = true; } };
    ['1', '2', '3', '5', '6a', '7', '8', '9a', '10', '11'].forEach(function (b) { add(sumBox(k1, b), 1); });
    var c4 = sumBox(k1, '4c');
    if (has(c4)) add(c4, 1); else { add(sumBox(k1, '4a'), 1); add(sumBox(k1, '4b'), 1); }
    ['12', '13', '21'].forEach(function (b) { var v = sumBox(k1, b); if (has(v)) add(Math.abs(v), -1); });
    return any ? total : null;
  }

  /* ---------------- the checks ---------------- */

  function m(c) { return money(c, { whole: c % 100 === 0 }); }
  function where(k1, key) { var a = k1.at && k1.at[key]; return a && a.p ? a.p : null; }

  /**
   * Every check on one K-1: [{id, status: pass|look|fail, title, text, page}].
   * `opts.prior` is last year's K-1 from the same partnership, when the
   * client file holds one.
   */
  function checkK1(k1, opts) {
    var o = opts || {};
    var out = [];
    var add = function (id, status, title, text, page) { out.push({ id: id, status: status, title: title, text: text, page: page || null }); };
    var L = k1.l || {};

    var emptyK1 = !(k1.lines || []).length && !ITEM_KEYS.some(function (key) { return has(k1FieldValue(k1, key)); });
    if (emptyK1) {
      add('empty', 'look', 'Nothing entered yet', 'No boxes or items on this K-1 yet - read it or type it in.');
      return out;
    }

    // Item L reconciles, to the cent.
    var lPresent = ['beginning', 'contributed', 'currentYear', 'other', 'withdrawals', 'ending'].filter(function (f) { return has(L[f]); });
    if (!lPresent.length) {
      add('itemL', 'look', 'No Item L', 'Item L (the capital account) is blank - check the form; most K-1s fill it in.');
    } else if (!has(L.beginning) || !has(L.ending)) {
      add('itemL', 'look', 'Item L is incomplete', 'Item L needs a beginning and an ending capital account to reconcile.');
    } else {
      var w = has(L.withdrawals) ? Math.abs(L.withdrawals) : 0;
      var want = L.beginning + (L.contributed || 0) + (L.currentYear || 0) + (L.other || 0) - w;
      var diff = L.ending - want;
      if (diff === 0) {
        add('itemL', 'pass', 'Item L reconciles', 'Beginning ' + m(L.beginning) + ' + contributed ' + m(L.contributed || 0) + ' + income ' + m(L.currentYear || 0) + ' + other ' + m(L.other || 0) + ' − withdrawals ' + m(w) + ' = ending ' + m(L.ending) + '.');
      } else {
        add('itemL', 'fail', 'Item L doesn’t reconcile', 'Off by ' + m(Math.abs(diff)) + ': beginning ' + m(L.beginning) + ' + contributed ' + m(L.contributed || 0) + ' + income ' + m(L.currentYear || 0) + ' + other ' + m(L.other || 0) + ' − withdrawals ' + m(w) + ' is ' + m(want) + ', but the ending says ' + m(L.ending) + '. Check each figure against the form.', where(k1, 'l.ending'));
        out[out.length - 1].short = 'off by ' + m(Math.abs(diff));
        out[out.length - 1].diff = diff;
      }
    }

    // Item L's current-year line vs the boxes: a look, never a fail.
    var bx = boxesIncome(k1);
    if (has(L.currentYear) && has(bx)) {
      var d = L.currentYear - bx;
      if (d === 0) add('lVsBoxes', 'pass', 'Item L income ties to the boxes', 'Item L’s current-year income (' + m(L.currentYear) + ') matches boxes 1-11 less 12, 13 and 21.');
      else add('lVsBoxes', 'look', 'Item L income vs the boxes', 'Item L’s current-year income (' + m(L.currentYear) + ') differs from boxes 1-11 less 12, 13 and 21 (' + m(bx) + ') by ' + m(Math.abs(d)) + ' - often book-tax or 704(b) differences; check the partnership’s reconciliation.', where(k1, 'l.currentYear'));
    }

    // Box 19 distributions vs Item L withdrawals.
    var b19 = sumBox(k1, '19');
    var wd = has(L.withdrawals) ? Math.abs(L.withdrawals) : null;
    if (has(b19) || (has(wd) && wd !== 0)) {
      if (has(b19) && has(wd) && Math.abs(b19) === wd) add('box19', 'pass', 'Distributions match', 'Box 19 (' + m(Math.abs(b19)) + ') matches Item L withdrawals.');
      else add('box19', 'look', 'Box 19 vs Item L withdrawals', 'Box 19 shows ' + m(Math.abs(b19 || 0)) + ' of distributions; Item L withdrawals show ' + m(wd || 0) + '. Property distributions, timing or a 704(b) capital account can explain it - worth a look.', where(k1, 'l.withdrawals'));
    }

    // Item J: shares between 0 and 100%, and what changed.
    var J = k1.j || {};
    var bad = ['profit', 'loss', 'capital'].filter(function (s) { return [J[s + 'Beg'], J[s + 'End']].some(function (v) { return has(v) && (v < 0 || v > 100 * PCT_SCALE); }); });
    if (bad.length) {
      add('itemJ', 'fail', 'Item J share out of range', 'The ' + bad.join(' and ') + ' share' + (bad.length > 1 ? 's are' : ' is') + ' outside 0-100% - a misread or mistyped percentage.', where(k1, 'j.' + bad[0] + 'End') || where(k1, 'j.' + bad[0] + 'Beg'));
    } else if (['profit', 'loss', 'capital'].some(function (s) { return has(J[s + 'Beg']) || has(J[s + 'End']); })) {
      var moved = ['profit', 'loss', 'capital'].filter(function (s) { return has(J[s + 'Beg']) && has(J[s + 'End']) && J[s + 'Beg'] !== J[s + 'End']; });
      var zeroEnd = ['profit', 'loss', 'capital'].every(function (s) { return !has(J[s + 'End']) || J[s + 'End'] === 0; }) && ['profit', 'loss', 'capital'].some(function (s) { return has(J[s + 'End']); });
      if (zeroEnd && !k1.final) add('itemJ', 'look', 'Item J ends at 0%', 'The ending shares are 0% but the K-1 isn’t marked final - was the interest sold or redeemed?');
      else if (zeroEnd) add('itemJ', 'pass', 'Item J ends at 0%', 'The shares end at 0%, as a final K-1’s should.');
      else if (moved.length) {
        // "Your profit, loss and capital shares went from 2.5% to 3%" when
        // they moved together; one clause per distinct move otherwise.
        var groupsOf = {};
        var orderOf = [];
        moved.forEach(function (s) { var key = J[s + 'Beg'] + '>' + J[s + 'End']; if (!groupsOf[key]) { groupsOf[key] = []; orderOf.push(key); } groupsOf[key].push(s); });
        var said = orderOf.map(function (key) {
          var names = groupsOf[key]; var s0 = names[0];
          var list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
          return list + ' share' + (names.length > 1 ? 's' : '') + ' went from ' + pctText(J[s0 + 'Beg']) + ' to ' + pctText(J[s0 + 'End']);
        });
        var sentence = said.join('; ');
        add('itemJ', 'look', 'Item J share changed', 'Your ' + sentence + ' - a purchase, a sale or new capital usually explains it.');
      }
      else add('itemJ', 'pass', 'Item J shares are steady', 'Profit, loss and capital shares are within 0-100%' + (has(J.profitEnd) ? ' (profit ' + pctText(J.profitEnd) + ')' : '') + '.');
    }

    // Keying errors the form's own arithmetic catches.
    var a4 = sumBox(k1, '4a'), b4 = sumBox(k1, '4b'), c4 = sumBox(k1, '4c');
    if (has(c4) && (has(a4) || has(b4)) && (a4 || 0) + (b4 || 0) !== c4) add('box4', 'fail', 'Box 4c isn’t 4a + 4b', 'Guaranteed payments: 4a ' + m(a4 || 0) + ' + 4b ' + m(b4 || 0) + ' should equal 4c, which says ' + m(c4) + '.');
    var d6a = sumBox(k1, '6a'), d6b = sumBox(k1, '6b');
    if (has(d6b) && (!has(d6a) || d6b > d6a)) add('box6b', 'fail', 'Qualified dividends exceed ordinary', 'Box 6b (' + m(d6b) + ') can’t be more than box 6a (' + m(d6a || 0) + ') - qualified dividends are part of ordinary dividends.');

    // The flags, loudly.
    if (k1.final) add('final', 'look', 'Final K-1', 'Marked final: the partner’s interest ended this year. Expect a sale or liquidation - check basis, suspended losses and any gain.');
    if (k1.amended) add('amended', 'look', 'Amended K-1', 'Marked amended: it replaces the original. Key these figures instead of the first K-1’s, not on top of them.');
    if (k1.p && k1.p.ptp) add('ptp', 'look', 'Publicly traded partnership', 'A PTP: its losses only offset its own income, and a sale usually comes with an ordinary-income (section 751) statement.');
    if (k1.k3) add('k3', 'look', 'Box 16 checked: Schedule K-3', 'Foreign items - expect a Schedule K-3 with this K-1 for foreign tax credit and other international reporting.');

    // Year over year, before the notes: a swing is the likelier keying error.
    if (o.prior && (o.prior.lines || []).length) yoy(k1, o.prior).forEach(function (c) { out.push(c); });

    // Coded boxes need their codes; "see statement" lines point at pages.
    (k1.lines || []).forEach(function (l) {
      if (BOX[l.box].kind === 'coded' && !l.code) add('code:' + l.box, 'look', 'Box ' + l.box + ' has no code', 'Box ' + l.box + ' has an amount (' + (has(l.cents) ? m(l.cents) : 'see statement') + ') but no code letter - the code says where it goes.', l.page);
      if (l.stmt) add('stmt:' + l.box + (l.code || ''), 'look', lineShort(l) + ': see statement', lineShort(l) + ' says “see statement” - the figures are on the partnership’s statement' + (l.page ? ' (page ' + l.page + ')' : '') + '.', l.page);
    });


    // Every value read with low confidence, with its page.
    (k1.lines || []).forEach(function (l) {
      if (l.conf === 'low') add('conf:' + l.box + (l.code || '') + ':' + (l.cents === null ? 's' : l.cents), 'look', 'Read with low confidence', lineShort(l) + (has(l.cents) ? ' (' + m(l.cents) + ')' : '') + ' was hard to read' + (l.page ? ' - check page ' + l.page + ' of the file' : '') + '.', l.page);
    });
    ITEM_KEYS.forEach(function (key) {
      var a = k1.at && k1.at[key];
      var v = k1FieldValue(k1, key);
      if (a && a.c === 'low' && has(v)) add('conf:' + key, 'look', 'Read with low confidence', 'Item ' + ITEM[key].item + ' ' + ITEM[key].label.toLowerCase() + ' (' + (ITEM[key].kind === 'pct' ? pctText(v) : m(v)) + ') was hard to read' + (a.p ? ' - check page ' + a.p + ' of the file' : '') + '.', a.p);
    });
    return out;
  }
  function lineShort(l) { return 'Box ' + l.box + (l.code ? ' code ' + l.code : ''); }

  /** Big swings (over 50% and over $1,000) and codes that appeared or went,
   *  against last year's K-1 from the same partnership. */
  function yoy(k1, prior) {
    var out = [];
    var tally = function (x) {
      var t = {};
      (x.lines || []).forEach(function (l) {
        var key = l.box + '|' + (l.code || '');
        if (!t[key]) t[key] = { box: l.box, code: l.code, cents: null, page: l.page };
        if (l.cents !== null) t[key].cents = (t[key].cents || 0) + l.cents;
      });
      return t;
    };
    var now = tally(k1), then = tally(prior);
    var keys = Object.keys(now).concat(Object.keys(then).filter(function (k) { return !now[k]; }));
    keys.sort(function (a, b) { var x = (now[a] || then[a]), y = (now[b] || then[b]); return (BOX[x.box].order - BOX[y.box].order) || ((x.code || '') < (y.code || '') ? -1 : 1); });
    var swings = 0;
    keys.forEach(function (k) {
      var a = then[k], b = now[k];
      var name = 'Box ' + (b || a).box + ((b || a).code ? ' code ' + (b || a).code : '');
      // A code that came or went always counts; a plain box only when the
      // amount itself would have been a big swing from nothing.
      var big = function (x) { return BOX[x.box].kind === 'coded' || (has(x.cents) && Math.abs(x.cents) > 100000); };
      if (a && !b) {
        if (big(a)) { out.push({ id: 'yoy:' + k, status: 'look', title: 'Gone this year', text: name + ' was on last year’s K-1' + (has(a.cents) ? ' (' + m(a.cents) + ')' : '') + ' and isn’t on this one.', page: null }); swings++; }
        return;
      }
      if (b && !a) {
        if (big(b)) { out.push({ id: 'yoy:' + k, status: 'look', title: 'New this year', text: name + ' is new this year' + (has(b.cents) ? ' (' + m(b.cents) + ')' : '') + ' - it wasn’t on last year’s K-1.', page: b.page }); swings++; }
        return;
      }
      if (!has(a.cents) || !has(b.cents)) return;
      var change = b.cents - a.cents;
      if (Math.abs(change) > 100000 && Math.abs(change) * 2 > Math.abs(a.cents)) {
        var pct = a.cents === 0 ? null : Math.round(100 * change / Math.abs(a.cents));
        out.push({ id: 'yoy:' + k, status: 'look', title: 'Big swing from last year', text: name + ' went from ' + m(a.cents) + ' to ' + m(b.cents) + (pct === null ? '' : ' (' + (pct > 0 ? '+' : '−') + Math.abs(pct) + '%)') + ' - worth a look before you key it.', page: b.page });
        swings++;
      }
    });
    if (!swings) out.push({ id: 'yoy', status: 'pass', title: 'In line with last year', text: 'No box moved more than 50% and $1,000 from last year’s K-1, and no codes came or went.', page: null });
    return out;
  }

  function summarize(checks) {
    var c = { pass: 0, look: 0, fail: 0 };
    (checks || []).forEach(function (x) { c[x.status]++; });
    return { pass: c.pass, look: c.look, fail: c.fail, result: c.fail ? 'fail' : c.look ? 'look' : 'pass' };
  }
  /** Fails first, then looks, then passes - the order a preparer reads. */
  function sortChecks(checks) {
    var w = { fail: 0, look: 1, pass: 2 };
    return checks.map(function (c, i) { return [c, i]; }).sort(function (a, b) { return (w[a[0].status] - w[b[0].status]) || (a[1] - b[1]); }).map(function (x) { return x[0]; });
  }

  /* ---------------- a client file ---------------- */

  function cleanExpected(raw, taxYear) {
    if (!raw || typeof raw !== 'object') return null;
    var name = scrubTins(clean(raw.name, LIMITS.name));
    if (!name) return null;
    return { name: name, ein4: /^\d{4}$/.test(String(raw.ein4 || '')) ? String(raw.ein4) : '', due: isoDay(raw.due) ? raw.due : defaultDue(taxYear) };
  }

  /** A client file as stored: {label, taxYear, k1s, expected}. Throws a
   *  plain Error (with .status 400) when it is not one. */
  function cleanFile(raw) {
    var err = function (msg) { return Object.assign(new Error(msg), { status: 400, expose: true }); };
    if (!raw || typeof raw !== 'object') throw err('That isn’t a client file.');
    var label = clean(raw.label, LIMITS.label);
    if (!label) throw err('Give the client file a label, like “Client A - 2025”.');
    var taxYear = cleanYear(raw.taxYear);
    if (!taxYear) throw err('The tax year is a year, like 2025.');
    if (raw.k1s !== undefined && !Array.isArray(raw.k1s)) throw err('K-1s come as a list.');
    var list = raw.k1s || [];
    if (list.length > LIMITS.k1s) throw err('A client file holds up to ' + LIMITS.k1s + ' K-1s. Start another file for the rest.');
    var seen = {};
    var k1s = list.map(cleanK1).filter(Boolean).map(function (k) {
      if (!k.taxYear) k.taxYear = taxYear;
      if (seen[k.id]) k.id = newId('k');
      seen[k.id] = true;
      return k;
    });
    k1s.forEach(function (k) { k.result = summarize(checkK1(k, { prior: priorFor(k, k1s) })).result; });
    var exp = Array.isArray(raw.expected) ? raw.expected : [];
    if (exp.length > LIMITS.expected) throw err('Up to ' + LIMITS.expected + ' expected partnerships in one file.');
    var keys = {};
    var expected = exp.map(function (e) { return cleanExpected(e, taxYear); }).filter(function (e) {
      if (!e) return false;
      var key = partnershipKey(e.name);
      if (keys[key]) return false;
      keys[key] = true; return true;
    });
    return { label: label, taxYear: taxYear, k1s: k1s, expected: expected };
  }

  /** Last year's K-1 from the same partnership in this list, if any. */
  function priorFor(k1, list) {
    if (!k1 || !k1.taxYear) return null;
    var key = partnershipKey(k1.p && k1.p.name);
    var four = k1.p && k1.p.ein4;
    var hit = null;
    (list || []).forEach(function (x) {
      if (!x || x === k1 || x.taxYear !== k1.taxYear - 1 || !x.p) return;
      var same = (four && x.p.ein4 && four === x.p.ein4) || (key && partnershipKey(x.p.name) === key);
      if (same && !hit) hit = x;
    });
    return hit;
  }
  function checksFor(k1, file) { return checkK1(k1, { prior: priorFor(k1, file ? file.k1s : []) }); }

  function yearK1s(file) { return (file.k1s || []).filter(function (k) { return k.taxYear === file.taxYear; }); }
  function priorK1s(file) { return (file.k1s || []).filter(function (k) { return k.taxYear === file.taxYear - 1; }); }

  /**
   * The expected partnerships, each with whether its K-1 has arrived:
   * [{name, ein4, due, received, k1Id, overdue}].
   */
  function missing(file, today) {
    var got = yearK1s(file);
    return (file.expected || []).map(function (e) {
      var key = partnershipKey(e.name);
      var hit = null;
      got.forEach(function (k) { if (!hit && ((e.ein4 && k.p.ein4 === e.ein4) || (key && partnershipKey(k.p.name) === key))) hit = k; });
      return { name: e.name, ein4: e.ein4, due: e.due, received: Boolean(hit), k1Id: hit ? hit.id : null, overdue: !hit && isoDay(today) && e.due < today };
    });
  }

  /** The status board: counts per stage and an honest time-saved figure. */
  function board(file, today) {
    var ks = yearK1s(file);
    var n = function (stages) { return ks.filter(function (k) { return stages.indexOf(k.stage) >= 0; }).length; };
    var miss = missing(file, today).filter(function (x) { return !x.received; });
    var results = { pass: 0, look: 0, fail: 0 };
    ks.forEach(function (k) { var r = summarize(checksFor(k, file)); results[r.result]++; });
    // Time saved: only K-1s read for you (not typed) and checked, each the
    // stated minutes by hand less the time you spent checking it here.
    var counted = ks.filter(function (k) { return (k.stage === 'checked' || k.stage === 'exported') && k.src !== 'manual'; });
    var spent = counted.reduce(function (s, k) { return s + Math.min(k.reviewSecs || 0, MINUTES_BY_HAND * 60); }, 0);
    var savedSecs = counted.length * MINUTES_BY_HAND * 60 - spent;
    return {
      received: ks.length, read: n(['read', 'checked', 'exported']), checked: n(['checked', 'exported']), exported: n(['exported']),
      missing: miss.length, overdue: miss.filter(function (x) { return x.overdue; }).length,
      results: results, counted: counted.length, spentSecs: spent, savedSecs: Math.max(0, savedSecs),
    };
  }
  /** "about 2 hours", "about 45 minutes", "about 1.5 hours". */
  function duration(secs) {
    var mins = Math.round(secs / 60);
    if (mins < 1) return 'under a minute';
    if (mins < 60) return 'about ' + mins + ' minute' + (mins === 1 ? '' : 's');
    var halfHours = Math.round(mins / 30) / 2;
    return 'about ' + (halfHours % 1 ? halfHours.toFixed(1) : String(halfHours)) + ' hour' + (halfHours === 1 ? '' : 's');
  }
  function minutesText(secs) {
    var mins = Math.max(1, Math.round(secs / 60));
    return mins + ' minute' + (mins === 1 ? '' : 's');
  }
  function boardLine(b) {
    var parts = [b.received + ' received', b.checked + ' checked'];
    if (b.missing) parts.push(b.missing + ' still missing');
    if (b.savedSecs >= 60) parts.push(duration(b.savedSecs) + ' saved');
    return parts.join(' · ');
  }

  /**
   * The roll-up: every box and code summed across this year's K-1s, in the
   * form's order. [{box, code, label, total, n, values, stmts, items:
   * [{id, name, cents, stmt}]}], plus rows for the checkbox boxes and flags.
   */
  function rollup(file) {
    var ks = yearK1s(file);
    var rows = {};
    ks.forEach(function (k) {
      (k.lines || []).forEach(function (l) {
        var key = l.box + '|' + (l.code || '');
        var r = rows[key] || (rows[key] = { box: l.box, code: l.code, label: l.code ? codeLabel(l.box, l.code) : BOX[l.box].label, total: 0, values: 0, stmts: 0, items: [], ids: {} });
        if (l.cents !== null) { r.total += l.cents; r.values++; }
        if (l.stmt) r.stmts++;
        var it = r.ids[k.id];
        if (!it) { it = { id: k.id, name: k.p.name || 'Unnamed partnership', cents: null, stmt: false }; r.ids[k.id] = it; r.items.push(it); }
        if (l.cents !== null) it.cents = (it.cents || 0) + l.cents;
        if (l.stmt) it.stmt = true;
      });
      Object.keys(CHECK_BOXES).forEach(function (box) {
        if (!k[CHECK_BOXES[box]]) return;
        var key = box + '|';
        var r = rows[key] || (rows[key] = { box: box, code: null, label: BOX[box].label, total: 0, values: 0, stmts: 0, items: [], ids: {}, check: true });
        r.items.push({ id: k.id, name: k.p.name || 'Unnamed partnership', cents: null, stmt: false });
      });
    });
    var list = Object.keys(rows).map(function (k) { var r = rows[k]; delete r.ids; r.n = r.items.length; r.items.sort(function (a, b) { return Math.abs(b.cents || 0) - Math.abs(a.cents || 0) || (a.name < b.name ? -1 : 1); }); return r; });
    list.sort(function (a, b) { return (BOX[a.box].order - BOX[b.box].order) || ((a.code || '').length - (b.code || '').length) || ((a.code || '') < (b.code || '') ? -1 : 1); });
    return list;
  }
  /** "Box 1: $48,210 across 9 K-1s"; "Box 20 code Z: 6 partnerships report
   *  Section 199A information". */
  function rollupSentence(r) {
    var name = 'Box ' + r.box + (r.code ? ' code ' + r.code : '');
    var k = function (n) { return n + ' K-1' + (n === 1 ? '' : 's'); };
    if (r.check) return name + ': ' + CHECK_PHRASE[r.box] + ' on ' + k(r.n);
    if (!r.values) return name + ': ' + r.n + ' partnership' + (r.n === 1 ? ' reports ' : 's report ') + (r.label === UNKNOWN_CODE ? 'it on a statement' : r.label.charAt(0).toLowerCase() + r.label.slice(1) + ' on a statement');
    return name + ': ' + m(r.total) + ' across ' + k(r.n) + (r.stmts ? ' (' + r.stmts + ' also “see statement”)' : '');
  }

  /* ---------------- the calendar file (RFC 5545) ---------------- */

  function icsText(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n');
  }
  function utf8Len(ch) { var c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  /** Lines of at most 75 octets, continued with CRLF + space, never
   *  splitting a UTF-8 character. */
  function fold(line) {
    var out = [], cur = '', len = 0;
    Array.from(line).forEach(function (ch) {
      var l = utf8Len(ch);
      if (len + l > 75) { out.push(cur); cur = ' '; len = 1; }
      cur += ch; len += l;
    });
    out.push(cur);
    return out.join('\r\n');
  }
  function stamp(iso) {
    var d = new Date(iso || Date.now());
    if (isNaN(d)) d = new Date();
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  /**
   * A reminder per missing K-1: an all-day event on its expected date with
   * an alarm that morning. The UID comes from the client file, the
   * partnership and the tax year (not the date), so importing again after
   * moving a date moves the event instead of adding a second one.
   */
  function ics(items, opts) {
    var o = opts || {};
    var label = clean(o.label || 'Client', LIMITS.label);
    var key = String(o.fileKey || label);
    var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Challenge Lab//Boxed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsText('K-1s due - ' + label)];
    var dt = stamp(o.now);
    (items || []).forEach(function (it) {
      if (!it || !isoDay(it.due) || it.received) return;
      var d = it.due.replace(/-/g, '');
      var next = addDays(it.due, 1).replace(/-/g, '');
      var desc = 'Still waiting on the ' + o.taxYear + ' Schedule K-1 from ' + it.name + ' for ' + label + '.\nMany K-1s arrive after March 15 and extensions are common - check the partnership’s investor portal, then chase it.';
      L.push('BEGIN:VEVENT',
        'UID:' + hash(key + '|' + partnershipKey(it.name) + '|' + o.taxYear) + '@boxed.challenge.strongtechnicalconsulting.com',
        'DTSTAMP:' + dt,
        'DTSTART;VALUE=DATE:' + d,
        'DTEND;VALUE=DATE:' + next,
        'SUMMARY:' + icsText('K-1 due: ' + it.name),
        'DESCRIPTION:' + icsText(desc),
        'TRANSP:TRANSPARENT',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText('Chase the K-1 from ' + it.name), 'TRIGGER;RELATED=START:PT9H', 'END:VALARM',
        'END:VEVENT');
    });
    L.push('END:VCALENDAR');
    return L.map(fold).join('\r\n') + '\r\n';
  }
  function fileSlug(s) { return String(s || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'client'; }

  /** The chase list, ready to paste into an email. */
  function chaseText(file, today) {
    var miss = missing(file, today).filter(function (x) { return !x.received; });
    if (!miss.length) return 'Every expected K-1 for ' + file.label + ' (' + file.taxYear + ') has arrived.';
    return 'Still waiting on these ' + file.taxYear + ' Schedule K-1s for ' + file.label + ':\n' +
      miss.map(function (x) { return '- ' + x.name + (x.ein4 ? ' (EIN ending ' + x.ein4 + ')' : '') + ' - expected by ' + fmtDate(x.due) + (x.overdue ? ' (overdue)' : ''); }).join('\n') +
      '\n\nCould you send them, or let us know when to expect them? Thank you.';
  }

  /* ---------------- CSV ---------------- */

  /**
   * One cell. Text that a spreadsheet would run as a formula (starting
   * =, +, -, @, tab or CR) gets a leading apostrophe; a plain number such as
   * -1250.00 is a number and is left alone. Quoted when it holds a quote,
   * comma or line break.
   */
  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function csvRows(rows) { return '\ufeff' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n'; }

  /** Every K-1 of the year, one row per box/code (and per Item J/K/L field). */
  function k1Csv(file) {
    var rows = [['Client', 'Tax year', 'Partnership', 'EIN (last 4)', 'Stage', 'Checks', 'Final', 'Amended', 'PTP', 'Line', 'Code', 'Description', 'Amount', 'See statement', 'Page', 'Confidence']];
    yearK1s(file).forEach(function (k) {
      var r = summarize(checksFor(k, file));
      var head = [file.label, file.taxYear, k.p.name, k.p.ein4 ? 'xx-xxx' + k.p.ein4 : '', STAGE_LABEL[k.stage], r.fail ? r.fail + ' to fix' : r.look ? r.look + ' to look at' : 'all pass', k.final ? 'Yes' : '', k.amended ? 'Yes' : '', k.p.ptp ? 'Yes' : ''];
      ITEMS.forEach(function (f) {
        var v = k1FieldValue(k, f.key);
        if (!has(v)) return;
        var a = k.at[f.key] || {};
        rows.push(head.concat(['Item ' + f.item, '', f.label, f.kind === 'pct' ? pctText(v, true) : plainMoney(v), '', a.p || '', a.c || '']));
      });
      if (has(k.l.basis)) rows.push(head.concat(['Item L', '', 'Capital account basis', BASIS_LABEL[k.l.basis], '', '', '']));
      k.lines.forEach(function (l) {
        rows.push(head.concat([l.box, l.code || '', l.code ? codeLabel(l.box, l.code) : BOX[l.box].label, plainMoney(l.cents), l.stmt ? 'Yes' : '', l.page || '', l.conf || '']));
      });
      Object.keys(CHECK_BOXES).forEach(function (box) { if (k[CHECK_BOXES[box]]) rows.push(head.concat([box, '', BOX[box].label, 'Checked', '', '', ''])); });
    });
    return csvRows(rows);
  }
  /** The roll-up sheet: one row per box/code, totalled. */
  function rollupCsv(file) {
    var rows = [['Client', 'Tax year', 'Line', 'Code', 'Description', 'Total', 'K-1s', 'See statement', 'Partnerships']];
    rollup(file).forEach(function (r) {
      rows.push([file.label, file.taxYear, r.box, r.code || '', r.label, r.check ? '' : (r.values ? plainMoney(r.total) : ''), r.n, r.stmts || '', r.items.map(function (i) { return i.name; }).join('; ')]);
    });
    return csvRows(rows);
  }

  /** Next year's file from this one: the label's year moved on, this year's
   *  K-1s carried as last year's (so year over year works), and every
   *  partnership expected again by March 15. */
  function nextYear(file) {
    var y = file.taxYear + 1;
    var label = /\b(19|20)\d{2}\b/.test(file.label) ? file.label.replace(/\b(19|20)\d{2}\b/, function (s) { return Number(s) === file.taxYear ? String(y) : s; }) : file.label + ' - ' + y;
    if (label === file.label) label = clean(file.label + ' - ' + y, LIMITS.label);
    var carried = yearK1s(file).map(function (k) { var c = cleanK1(k); c.id = newId('k'); return c; });
    var names = {};
    var expected = [];
    carried.concat(file.expected || []).forEach(function (x) {
      var name = x.p ? x.p.name : x.name; var ein4 = x.p ? x.p.ein4 : x.ein4;
      if (x.p && x.final) return; // a final K-1's partnership won't send another
      var key = partnershipKey(name);
      if (!name || names[key]) return;
      names[key] = true;
      expected.push({ name: name, ein4: ein4 || '', due: defaultDue(y) });
    });
    return { label: clean(label, LIMITS.label), taxYear: y, k1s: carried.slice(0, LIMITS.k1s), expected: expected.slice(0, LIMITS.expected) };
  }

  return {
    LIMITS: LIMITS, MINUTES_BY_HAND: MINUTES_BY_HAND, BOXES: BOXES, BOX: BOX, VALUE_BOXES: VALUE_BOXES, CHECK_BOXES: CHECK_BOXES, CODES: CODES, CODE_RE: CODE_RE, UNKNOWN_CODE: UNKNOWN_CODE,
    ITEMS: ITEMS, ITEM: ITEM, ITEM_KEYS: ITEM_KEYS, BASES: BASES, BASIS_LABEL: BASIS_LABEL, CONF: CONF, STAGES: STAGES, STAGE_LABEL: STAGE_LABEL, SOURCES: SOURCES, ENTITY_TYPES: ENTITY_TYPES, PCT_SCALE: PCT_SCALE, ID_RE: ID_RE,
    clean: clean, scrubTins: scrubTins, last4: last4, maskTin: maskTin, maskEin: maskEin,
    toCents: toCents, money: money, formMoney: formMoney, plainMoney: plainMoney, toPct: toPct, pctText: pctText,
    isoDay: isoDay, addDays: addDays, daysBetween: daysBetween, fmtDate: fmtDate, cleanYear: cleanYear, defaultDue: defaultDue,
    hash: hash, newId: newId, partnershipKey: partnershipKey,
    codeLabel: codeLabel, lineLabel: lineLabel, lineShort: lineShort, cleanCode: cleanCode, cleanBox: cleanBox,
    blankK1: blankK1, cleanK1: cleanK1, toSaved: toSaved, fromModel: fromModel, sortLines: sortLines, fieldValue: k1FieldValue,
    sumBox: sumBox, boxesIncome: boxesIncome, checkK1: checkK1, yoy: yoy, summarize: summarize, sortChecks: sortChecks,
    cleanExpected: cleanExpected, cleanFile: cleanFile, priorFor: priorFor, checksFor: checksFor, yearK1s: yearK1s, priorK1s: priorK1s,
    missing: missing, board: board, boardLine: boardLine, duration: duration, minutesText: minutesText, rollup: rollup, rollupSentence: rollupSentence,
    icsText: icsText, fold: fold, ics: ics, fileSlug: fileSlug, chaseText: chaseText,
    csvCell: csvCell, csvRows: csvRows, k1Csv: k1Csv, rollupCsv: rollupCsv, nextYear: nextYear,
  };
}));
