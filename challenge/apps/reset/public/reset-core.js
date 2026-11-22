/* Reset - the rules, in one file run three times: in the page
 * (window.ResetCore), in the server (require) and in the tests. No clock,
 * no dice, no network, no storage: every date, time stamp and id is passed
 * in.
 *
 * THE ARITHMETIC IS EXACT. Nothing about money or a rate is ever a float:
 *
 *   - a rate is a whole number of RATE UNITS, 1 unit = 0.00001 percentage
 *     point (100000 units = 1%). 7.125% is 712500; a SOFR average quoted to
 *     five places, 4.31234%, is 431234. Typed rates are read digit by digit
 *     ("7.125", "7 1/8", "0.125%"), never through parseFloat; a rate with
 *     more than five decimals, or a fraction that is not exact in five
 *     (1/3), is refused rather than rounded.
 *   - money is a whole number of CENTS.
 *   - the payment and each month's interest are worked out with BigInt as
 *     exact fractions and rounded ONCE, to the cent, at the end.
 *
 * The conventions (see CLAUDE.md, "The arithmetic"):
 *
 *   1. index + margin = the fully indexed rate.
 *   2. rounded to the note's increment: nearest (a half rounds up), up
 *      (toward the higher rate) or down; or not rounded.
 *   3. the change limit: at the FIRST change the first-change cap (or, if
 *      the note has none, the periodic cap); after it the periodic cap. The
 *      new rate stays within that many points of the CURRENT rate, up or
 *      down. Caps never compound or carry over: an unused part of one
 *      period's cap is not saved for the next.
 *   4. the lifetime cap: never above the START rate + the lifetime cap.
 *   5. the ceiling (a stated maximum rate), if lower.
 *   6. the floor: never below it. Floor and ceiling are absolute and come
 *      last, so they win over the change limit if the two disagree.
 *   7. never below zero (the zero guard).
 *   The rule that BOUND the rate is the last one that moved it; if none
 *   did, it is index + margin (or rounding, if rounding moved it).
 *
 *   The payment: P = B x r / (1 - (1 + r)^-n), r = the annual rate / 12,
 *   n = the months left, B = the balance - as one exact fraction,
 *     P = B x R x (D + R)^n / (D x ((D + R)^n - D^n)),  D = 120,000,000
 *   (R in rate units, so r = R / D), then rounded to the cent: to the
 *   nearest (a half cent rounds up) or up, as the note says. At 0% it is
 *   B / n; interest-only it is B x r. A month's interest is B x r rounded
 *   to the nearest cent.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ResetCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PCT = 100000;                // rate units in one percentage point
  var DEN = BigInt(1200) * BigInt(PCT);   // r = R / DEN (a year's rate in a month)

  var LIMITS = {
    nick: 40, indexName: 60, loans: 500, storedBytes: 400 * 1024,
    rateMin: -10 * PCT, rateMax: 50 * PCT, capMax: 20 * PCT, marginMin: -5 * PCT, marginMax: 25 * PCT,
    balMax: 100000000000,          // $1,000,000,000.00, in cents
    monthsMax: 600, lookbackMax: 120, everyMax: 120, futureMax: 40, whatList: 12,
    csvBytes: 1024 * 1024, csvRows: 2000, pasteChars: 6000,
    aiImages: 2, aiImageBytes: 1.5 * 1024 * 1024, aiImageSide: 1600,
  };
  var ROUNDS = ['nearest', 'up', 'down', 'none'];
  var PAYROUNDS = ['nearest', 'up'];
  var RULES = ['index+margin', 'rounding', 'first-change cap', 'periodic cap', 'lifetime cap', 'ceiling', 'floor', 'zero'];
  var RULE_LABEL = {
    'index+margin': 'Index + margin', rounding: 'Rounding', 'first-change cap': 'First-change cap', 'periodic cap': 'Periodic cap',
    'lifetime cap': 'Lifetime cap', ceiling: 'Ceiling', floor: 'Floor', zero: 'Zero guard',
  };

  /* ================================================================== *
   * Text
   * ================================================================== */

  // Control characters, bidi overrides and zero-width characters: built
  // from code points so no invisible character ever sits in this file.
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
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function list(xs) { return xs.length <= 1 ? (xs[0] || '') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  var AT_ANY = new RegExp('[@' + String.fromCharCode(0xFF20, 0xFE6B) + ']');
  function hasAt(s) { return AT_ANY.test(str(s)) || /@/.test(nf(s)); }
  var LINK = /(https?:|ftp:|mailto:|www\.|:\/\/|\b[a-z0-9-]{2,}\.(com|net|org|io|co|uk|us|app|dev|ly|me|info|biz|tv|gg|xyz|bank|loan|loans|finance|credit|site|online|link)\b)/i;
  function hasLink(s) { return LINK.test(nf(s)); }
  /** Seven or more digits, in any script, in one run of digits and phone
   *  punctuation. Dates (2026-12-01, 12/01/2026) and short fractions are
   *  taken out first: a rate-change section is full of them. */
  function hasPhone(s) {
    var t = nf(s).replace(/\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}/gu, ' ').replace(/\p{Nd}{1,2}\/\p{Nd}{1,2}\/\p{Nd}{2,4}/gu, ' ');
    return (t.match(/\+?\p{Nd}[\p{Nd} ()\/-]{5,}\p{Nd}/gu) || []).some(function (m) { return m.replace(/\p{Nd}{1,2}\/\p{Nd}{1,2}(?!\p{Nd})/gu, ' ').replace(/[^\p{Nd}]/gu, '').length >= 7; });
  }
  /** Nine digits in a row, in any script, or written the way a tax id is
   *  (123-45-6789). */
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
  /** An account-number-like run: `min` or more digits (any script) with
   *  nothing but spaces, dashes or dots between them - or a number written
   *  after "loan no.", "account #" and the like. */
  function accountLike(s, min) {
    var t = nf(s);
    var runs = t.match(/\p{Nd}(?:[ .-]?\p{Nd})*/gu) || [];
    if (runs.some(function (m) { return m.replace(/[^\p{Nd}]/gu, '').length >= min; })) return true;
    return /\b(loan|account|acct|acc|member|customer|policy|reference|ref)\.?\s*(no|nbr|num|number|#|id)?\.?\s*[:#]?\s*[A-Z]{0,3}[ -]?\p{Nd}{3,}/iu.test(t);
  }
  /** A spreadsheet formula: a leading = or @, or + or - straight before a
   *  letter or a bracket. (-0.150 is a number and fine.) */
  function isFormula(s) { s = str(s); return /^[\t\r]/.test(s) || /^\s*[=@]/.test(nf(s)) || /^\s*[+\-][^\s\p{Nd}.]/u.test(nf(s)); }
  function hasInvisible(s) { return BAD1.test(str(s)); }
  function hasMarkup(s) { return /[<>]/.test(str(s)); }

  // Personal names. A guard, not a guarantee: honorifics, "Borrower: ...",
  // a "Smith, John" or "John Smith Jr." shape, and common given names and
  // surnames as capitalised words. Names that are also ordinary words a
  // nickname uses (Grant, Mark, May, Rose, Hill, Brown, King, Lane, Glen,
  // Dale, Chase, Parker ...) are left out on purpose.
  var GIVEN = ('James John Robert Michael William David Richard Joseph Thomas Charles Christopher Daniel Matthew Anthony Donald Steven Paul Andrew Joshua Kenneth Kevin Brian George Timothy Ronald Edward Jason Jeffrey Ryan Jacob Gary Nicholas Eric Jonathan Stephen Larry Justin Scott Brandon Benjamin Samuel Gregory Alexander Patrick Jack Dennis Jerry Tyler Aaron Jose Henry Adam Douglas Nathan Peter Zachary Kyle Noah Ethan Jeremy Walter Christian Keith Roger Terry Gerald Harold Sean Arthur Lawrence Jesse Dylan Bryan Joe Jordan Billy Bruce Albert Willie Gabriel Logan Alan Juan Wayne Elijah Randy Roy Vincent Ralph Eugene Russell Bobby Philip Johnny Liam Lucas Mason Oliver ' +
    'Mary Patricia Jennifer Linda Elizabeth Barbara Susan Jessica Sarah Karen Lisa Nancy Betty Margaret Sandra Ashley Kimberly Emily Donna Michelle Carol Amanda Dorothy Melissa Deborah Stephanie Rebecca Sharon Laura Cynthia Kathleen Amy Angela Shirley Anna Brenda Pamela Emma Nicole Helen Samantha Katherine Christine Debra Rachel Carolyn Janet Catherine Maria Heather Diane Julie Joyce Victoria Kelly Christina Lauren Joan Evelyn Olivia Judith Megan Cheryl Martha Andrea Frances Hannah Jacqueline Ann Gloria Jean Kathryn Alice Teresa Sara Janice Doris Madison Julia Judy Abigail Marie Denise Beverly Danielle Theresa Sophia Marilyn Natalie Diana Brittany Charlotte Isabella Ava Mia Harper Amelia Chloe Ella Avery Sofia Camila Aria Scarlett Layla Nora Zoey Riley Hazel Aurora Savannah Audrey Brooklyn Bella Claire Skylar Lucy Paisley Anna Caroline Genesis Kennedy Kinsley Allison Maya Naomi Elena Ruby Eva Ariana Serenity Autumn Adeline Hailey Gianna Valentina Isla Eliana Quinn Nevaeh Ivy Sadie Piper Lydia Alexa Josephine Emery Julia Delilah Arianna Vivian Kaylee Sophie Brielle Madeline').split(' ');
  var FAMILY = 'Smith Johnson Williams Jones Garcia Miller Davis Rodriguez Martinez Hernandez Lopez Gonzalez Wilson Anderson Thompson Harris Sanchez Ramirez Lewis Robinson Walker Allen Torres Nguyen Flores Adams Nelson Rivera Campbell Mitchell Roberts Gomez Phillips Evans Turner Diaz Cruz Edwards Collins Reyes Stewart Morris Morales Murphy Cook Rogers Gutierrez Ortiz Morgan Peterson Kim Cooper Ramos Howard Richardson Cox Ward Watson Brooks Sanders Price Bennett Myers Long Ross Foster Jimenez Patel Singh Chen Wang Li Zhang Liu Yang Huang Zhao Wu Zhou Kumar Shah Khan Ali Ahmed Cohen Murray Sullivan Kelly Ryan Walsh Byrne'.split(' ');
  var NAME_WORDS = {};
  GIVEN.concat(FAMILY).forEach(function (w) { NAME_WORDS[w] = true; });
  var HONORIFIC = /\b(Mr|Mrs|Ms|Mx|Miss|Dr|Prof)\.?\s+\p{Lu}/u;
  var NAME_LABEL = /\b(borrowers?|co-?borrowers?|mortgagors?|obligors?|guarantors?|customer|member|owner|name)\s*(name)?\s*[:=]\s*\p{Lu}/iu;
  var SUFFIX = /\p{Lu}\p{Ll}+,?\s+(Jr|Sr|II|III|IV)\b/u;
  /** The first thing that reads as a person's name, or ''. */
  function nameIn(s) {
    var t = nf(s);
    var m = HONORIFIC.exec(t) || NAME_LABEL.exec(t) || SUFFIX.exec(t);
    if (m) return m[0];
    var words = t.match(/\p{Lu}\p{Ll}+(?:['’]s)?/gu) || [];
    for (var i = 0; i < words.length; i++) { var w = words[i].replace(/['’]s$/, ''); if (NAME_WORDS[w]) return w; }
    return '';
  }

  var WHY = {
    invisible: 'That has an invisible character in it - type it again.',
    markup: 'Leave out < and > - Reset keeps plain words.',
    at: 'That looks like an email address - Reset never keeps one.',
    link: 'That looks like a link - Reset keeps plain words.',
    formula: 'Start it with a letter or a number - a leading = + - or @ is how a spreadsheet runs a formula.',
    card: 'That looks like a card number - never write one down here.',
    phone: 'That looks like a phone number - Reset never keeps one.',
    nine: 'Nine digits in a row looks like a tax id or an account number - Reset never keeps one.',
    account: 'That looks like an account or loan number - use a nickname, like “Maple duplex 5/1”.',
    name: 'That looks like a person’s name - use a nickname for the loan, like “Maple duplex 5/1”. Reset never keeps a borrower’s name.',
  };
  /** The general text door: '' when `s` may be kept, else why not.
   *  Refused, never cleaned. */
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
    if (max && Array.from(s.trim()).length > max) return 'Up to ' + max + ' characters.';
    return '';
  }
  /** A loan's nickname: the text door, then no account-like digit run (six
   *  or more digits) and nothing that reads as a person's name. */
  function nickProblem(s) {
    s = str(s).trim();
    if (!s) return 'Give the loan a nickname, like “Maple duplex 5/1”.';
    var why = refuse(s, LIMITS.nick);
    if (why) return why;
    if (/\n/.test(s)) return 'One line.';
    if (accountLike(s, 6)) return WHY.account;
    if (nameIn(s)) return WHY.name;
    return '';
  }
  /** Pasted note text for the AI: the text door, no account-like run of
   *  seven digits or a "loan no." number, no name. (Amounts like
   *  250,000.00 and dates pass.) */
  function pasteProblem(s) {
    s = str(s);
    if (!s.trim()) return 'Paste the note’s rate-change section first.';
    if (Array.from(s).length > LIMITS.pasteChars) return 'That is more than the rate-change section - paste up to ' + LIMITS.pasteChars + ' characters.';
    var why = refuse(s.replace(/\r/g, ''), 0);
    if (why) return why;
    if (accountLike(s.replace(/\p{Nd}{1,3}(,\p{Nd}{3})+(\.\p{Nd}+)?/gu, ' ').replace(/\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}|\p{Nd}{1,2}\/\p{Nd}{1,2}\/\p{Nd}{2,4}/gu, ' '), 7)) return 'That has what looks like a loan or account number in it - take it out (and any names) and paste again.';
    var n = nameIn(s);
    if (n) return 'That has what looks like a person’s name in it (“' + line(n, 30) + '”) - take out the names and paste only the rate-change section.';
    return '';
  }

  /* ================================================================== *
   * Exact numbers: rates in units of 0.00001%, money in cents
   * ================================================================== */

  /** Whole-number division rounded toward minus infinity, exact for any
   *  safe integers (a float quotient can land a hair the wrong side). */
  function floorDiv(a, b) {
    var q = Math.trunc(a / b);
    while (q * b > a) q--;
    while ((q + 1) * b <= a) q++;
    return q;
  }
  function bigRound(num, den, mode) {
    // num >= 0, den > 0 (BigInt). 'nearest': a half rounds up; 'up': ceiling; 'down': floor.
    if (mode === 'up') return (num + den - BigInt(1)) / den;
    if (mode === 'down') return num / den;
    return (BigInt(2) * num + den) / (BigInt(2) * den);
  }
  /** "7.125", "7.125%", "7 1/8", "1/8", "-0.15", "+2" -> rate units. */
  function parseRate(v, what) {
    var label = what || 'That rate';
    var s = nf(str(v)).trim().replace(/\s*(%|percent|pct)\.?$/i, '').replace(/^\+/, '').replace(/\s+/g, ' ');
    if (!s) return { error: label + ' is empty.' };
    var neg = false;
    if (/^[-−]/.test(s)) { neg = true; s = s.slice(1).trim(); }
    var units;
    var m = /^(\d{1,3})?(?:\.(\d{1,5}))?$/.exec(s);
    if (m && (m[1] !== undefined || m[2] !== undefined)) {
      units = Number(m[1] || 0) * PCT + Number(((m[2] || '') + '00000').slice(0, 5));
    } else {
      var f = /^(?:(\d{1,3}) )?(\d{1,3})\/(\d{1,4})$/.exec(s);
      if (!f) {
        if (/^\d*\.\d{6,}$/.test(s)) return { error: label + ' has more than five decimals - Reset works to 0.00001%.' };
        return { error: label + ' should be a percent, like 7.125 or 7 1/8.' };
      }
      var num = Number(f[2]), den = Number(f[3]);
      if (!den) return { error: label + ' divides by zero.' };
      if ((num * PCT) % den) return { error: label + ' is not exact to 0.00001% (' + num + '/' + den + ') - type it as a decimal.' };
      units = Number(f[1] || 0) * PCT + (num * PCT) / den;
    }
    return { v: neg ? -units : units };
  }
  /** "$250,000.00", "250000", "1,234.5" -> cents. */
  function parseMoney(v, what) {
    var label = what || 'That amount';
    var s = nf(str(v)).trim().replace(/^\$\s*/, '').replace(/^usd\s*/i, '');
    if (!s) return { error: label + ' is empty.' };
    var m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s);
    if (!m) return { error: label + ' should be dollars and cents, like 245,310.18.' };
    var dollars = m[1].replace(/,/g, '');
    if (dollars.length > 10) return { error: label + ' is too large.' };
    return { v: Number(dollars) * 100 + Number(((m[2] || '') + '00').slice(0, 2)) };
  }
  function parseWhole(v, what, lo, hi) {
    var s = nf(str(v)).trim();
    if (!/^\d{1,4}$/.test(s)) return { error: (what || 'That') + ' should be a whole number.' };
    var n = Number(s);
    if (n < lo || n > hi) return { error: (what || 'That') + ' should be ' + lo + ' to ' + hi + '.' };
    return { v: n };
  }
  /** 712500 -> "7.125%"; at least three decimals, up to five. */
  function fmtRate(u, bare) {
    if (!isInt(u)) return '';
    var neg = u < 0, a = Math.abs(u);
    var frac = ('00000' + (a % PCT)).slice(-5).replace(/0{1,2}$/, '');
    frac = frac.replace(/^(\d{3}\d*?)0+$/, '$1');
    var s = (neg ? '-' : '') + Math.floor(a / PCT) + '.' + frac;
    return bare ? s : s + '%';
  }
  /** A rate as a plain number for a form field or a CSV ("7.125"). */
  function rateField(u) { return isInt(u) ? fmtRate(u, true) : ''; }
  function fmtPts(u, long) { return fmtRate(u, true) + (long ? (u === PCT ? ' percentage point' : ' percentage points') : ' pts'); }
  function fmtMoney(c) {
    if (!isInt(c)) return '';
    var neg = c < 0, a = Math.abs(c);
    var d = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-$' : '$') + d + '.' + ('0' + (a % 100)).slice(-2);
  }
  function moneyField(c) { return isInt(c) ? (Math.floor(c / 100) + '.' + ('0' + (c % 100)).slice(-2)) : ''; }
  /** num/den (BigInt, num >= 0) as a decimal string with `places`
   *  digits, cut (not rounded) and marked "…" when it goes on. */
  function decimal(num, den, places) {
    var whole = num / den, rem = num % den, out = '';
    for (var i = 0; i < places; i++) { rem *= BigInt(10); out += String(rem / den); rem %= den; }
    return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (places ? '.' + out : '') + (rem > BigInt(0) ? '…' : '');
  }

  /* ================================================================== *
   * Days: YYYY-MM-DD, on day numbers (no clock, no time zone)
   * ================================================================== */

  function daysFrom(y, m, d) {
    y -= m <= 2 ? 1 : 0;
    var era = Math.floor(y / 400), yoe = y - era * 400;
    var doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }
  function civil(z) {
    z += 719468;
    var era = Math.floor(z / 146097), doe = z - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var y = yoe + era * 400, doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153), d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp + (mp < 10 ? 3 : -9);
    return [y + (m <= 2 ? 1 : 0), m, d];
  }
  function pad2(n) { return ('0' + n).slice(-2); }
  function isDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s));
    if (!m) return false;
    var c = civil(daysFrom(+m[1], +m[2], +m[3]));
    return c[0] === +m[1] && c[1] === +m[2] && c[2] === +m[3] && +m[1] >= 1990 && +m[1] <= 2100;
  }
  function dayNum(s) { var p = s.split('-').map(Number); return daysFrom(p[0], p[1], p[2]); }
  function dayStr(n) { var c = civil(n); return c[0] + '-' + pad2(c[1]) + '-' + pad2(c[2]); }
  function addDays(s, n) { return dayStr(dayNum(s) + n); }
  /** Months later, the day held where the month has it, else its last day
   *  (31 Jan + 1 month = 28 or 29 Feb). */
  function addMonths(s, n) {
    var p = s.split('-').map(Number), t = p[0] * 12 + (p[1] - 1) + n, y = Math.floor(t / 12), m = t - y * 12 + 1;
    var last = civil(daysFrom(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - 1)[2];
    return y + '-' + pad2(m) + '-' + pad2(Math.min(p[2], last));
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function fmtDay(s, long) { if (!isDay(s)) return ''; var p = s.split('-').map(Number); return long ? MONTHS_LONG[p[1] - 1] + ' ' + p[2] + ', ' + p[0] : p[2] + ' ' + MONTHS[p[1] - 1] + ' ' + p[0]; }

  /* ================================================================== *
   * The new rate
   * ================================================================== */

  /** A fully indexed rate rounded to the note's increment. */
  function roundRate(v, how, step) {
    if (how === 'none' || !step) return v;
    if (how === 'up') return -floorDiv(-v, step) * step + 0;   // + 0: never -0
    if (how === 'down') return floorDiv(v, step) * step;
    return floorDiv(2 * v + step, 2 * step) * step;
  }
  function roundWords(t) {
    if (t.round === 'none') return 'not rounded';
    var inc = t.step === 12500 ? '⅛ point (0.125%)' : t.step === 25000 ? '¼ point (0.25%)' : fmtRate(t.step);
    return t.round === 'nearest' ? 'rounded to the nearest ' + inc + ' (a half rounds up)' : 'rounded ' + t.round + ' to the next ' + inc;
  }

  /**
   * The new rate for one change, with the working: each rule in order, what
   * it allowed and what it did. `L` is a checked loan (loanFrom / cleanLoan).
   */
  function newRate(L) {
    var T = L.terms, steps = [], bound = 'index+margin';
    var fully = L.index + T.margin;
    steps.push({ rule: 'index+margin', value: fully, moved: false, text: 'Index ' + fmtRate(L.index) + ' + margin ' + fmtRate(T.margin) + ' = ' + fmtRate(fully) + ' (the fully indexed rate).' });
    var x = roundRate(fully, T.round, T.step);
    if (T.round !== 'none') {
      steps.push({ rule: 'rounding', value: x, moved: x !== fully, text: 'Rounding: ' + roundWords(T) + ' - ' + fmtRate(fully) + (x !== fully ? ' becomes ' + fmtRate(x) + '.' : ' is already on the increment.') });
      if (x !== fully) bound = 'rounding';
    }
    var rounded = x;
    var useFirst = L.first && T.firstCap !== null;
    var cap = L.first ? (T.firstCap !== null ? T.firstCap : T.periodicCap) : T.periodicCap;
    var capRule = useFirst ? 'first-change cap' : 'periodic cap';
    var lo = null, hi = null;
    if (cap !== null) {
      lo = L.rate - cap; hi = L.rate + cap;
      var y = Math.min(hi, Math.max(lo, x));
      var which = useFirst ? 'First-change cap' : (L.first ? 'Periodic cap (the note has no separate first-change cap)' : 'Periodic cap');
      steps.push({ rule: capRule, value: y, moved: y !== x, text: which + ': within ' + fmtPts(cap) + ' of the current ' + fmtRate(L.rate) + ', so ' + fmtRate(lo) + ' to ' + fmtRate(hi) + ' - ' + (y === x ? fmtRate(x) + ' is inside.' : fmtRate(x) + ' is ' + (x > y ? 'above' : 'below') + ', so ' + fmtRate(y) + '.') });
      if (y !== x) bound = capRule;
      x = y;
      if (L.first && useFirst && T.periodicCap !== null && T.periodicCap !== T.firstCap) steps[steps.length - 1].text += ' (The periodic cap of ' + fmtPts(T.periodicCap) + ' applies from the next change.)';
    }
    if (T.lifetimeCap !== null) {
      var max = L.start + T.lifetimeCap, z = Math.min(x, max);
      steps.push({ rule: 'lifetime cap', value: z, moved: z !== x, text: 'Lifetime cap: never above the start rate ' + fmtRate(L.start) + ' + ' + fmtPts(T.lifetimeCap) + ' = ' + fmtRate(max) + ' - ' + (z === x ? fmtRate(x) + ' is under it.' : fmtRate(x) + ' is over, so ' + fmtRate(z) + '.') });
      if (z !== x) bound = 'lifetime cap';
      x = z;
    }
    if (T.ceiling !== null) {
      var c = Math.min(x, T.ceiling);
      steps.push({ rule: 'ceiling', value: c, moved: c !== x, text: 'Ceiling: never above ' + fmtRate(T.ceiling) + ' - ' + (c === x ? fmtRate(x) + ' is under it.' : fmtRate(x) + ' is over, so ' + fmtRate(c) + '.') });
      if (c !== x) bound = 'ceiling';
      x = c;
    }
    if (T.floor !== null) {
      var f = Math.max(x, T.floor);
      steps.push({ rule: 'floor', value: f, moved: f !== x, text: 'Floor: never below ' + fmtRate(T.floor) + ' - ' + (f === x ? fmtRate(x) + ' is above it.' : fmtRate(x) + ' is under, so ' + fmtRate(f) + '.') });
      if (f !== x) bound = 'floor';
      x = f;
    }
    if (x < 0) {
      steps.push({ rule: 'zero', value: 0, moved: true, text: 'Zero guard: ' + fmtRate(x) + ' is below zero and the note sets no floor, so 0.000% - the payment is the balance spread over the months left.' });
      bound = 'zero'; x = 0;
    }
    return { rate: x, fully: fully, rounded: rounded, bound: bound, change: x - L.rate, steps: steps, lo: lo, hi: hi, first: L.first };
  }
  /** One plain sentence: which rule bit, and what it would have been. */
  function boundSentence(res) {
    var b = res.bound;
    if (b === 'index+margin') return 'Index + margin set it: ' + fmtRate(res.rate) + ', no cap or limit needed.';
    if (b === 'rounding') return 'Rounding set it: index + margin is ' + fmtRate(res.fully) + ', rounded to ' + fmtRate(res.rate) + '. No cap or limit bit.';
    if (b === 'zero') return 'The zero guard set it: index + margin is ' + fmtRate(res.fully) + ', below zero.';
    return 'The ' + RULE_LABEL[b].toLowerCase() + ' bit: without it the rate would be ' + fmtRate(res.rounded) + '; it is ' + fmtRate(res.rate) + '.';
  }

  /* ================================================================== *
   * The payment, exact
   * ================================================================== */

  /**
   * The payment in cents for balance B (cents) at rate R (units) over n
   * months. `how`: {io, payRound}. Returns {cents, exact (a decimal string
   * of the unrounded payment), kind}.
   */
  function payment(B, R, n, how) {
    how = how || {};
    var mode = how.payRound === 'up' ? 'up' : 'nearest';
    if (!isInt(n) || n < 1) throw new Error('No months left to pay over.');
    if (R < 0) throw new Error('A rate below zero has no payment.');
    var b = BigInt(B), r = BigInt(R), num, den, kind;
    if (B === 0) return { cents: 0, exact: '0.00', kind: 'paid' };
    if (how.io) { num = b * r; den = DEN * BigInt(100); kind = 'io'; }
    else if (R === 0) { num = b; den = BigInt(n) * BigInt(100); kind = 'zero'; }
    else {
      var a = (DEN + r) ** BigInt(n), d = DEN ** BigInt(n);
      num = b * r * a; den = DEN * (a - d) * BigInt(100); kind = 'amortising';
    }
    // num/den is the payment in DOLLARS; cents = round(num * 100 / den).
    return { cents: Number(bigRound(num * BigInt(100), den, mode)), exact: decimal(num, den, 4), kind: kind };
  }
  /** One month's interest on balance B at rate R, to the nearest cent. */
  function monthInterest(B, R) { return Number(bigRound(BigInt(B) * BigInt(R), DEN, 'nearest')); }
  /** The working for the payment, line by line. */
  function paymentWorking(B, R, n, how, p) {
    how = how || {};
    var out = [];
    var rStr = decimal(BigInt(R), DEN, 10);
    if (B === 0) return ['The balance is $0.00 - nothing to pay.'];
    if (how.io) {
      out.push('Interest-only: P = B × r, r = ' + fmtRate(R) + ' ÷ 12 = ' + rStr);
      out.push('P = ' + fmtMoney(B) + ' × ' + rStr + ' = $' + p.exact);
    } else if (R === 0) {
      out.push('At 0.000% there is no interest: P = B ÷ n.');
      out.push('P = ' + fmtMoney(B) + ' ÷ ' + n + ' = $' + p.exact);
    } else {
      out.push('P = B × r ÷ (1 − (1 + r)^−n), with B = ' + fmtMoney(B) + ', n = ' + n + ' months, r = ' + fmtRate(R) + ' ÷ 12 = ' + rStr);
      var a = (DEN + BigInt(R)) ** BigInt(n), d = DEN ** BigInt(n);
      out.push('(1 + r)^' + n + ' = ' + decimal(a, d, 8));
      out.push('P = $' + p.exact + ' (worked as one exact fraction)');
    }
    out.push('Rounded ' + (how.payRound === 'up' ? 'up to the next cent' : 'to the nearest cent (a half cent rounds up)') + ': ' + fmtMoney(p.cents) + '.');
    return out;
  }

  /* ================================================================== *
   * A loan: the form, checked
   * ================================================================== */

  var FIELDS = ['nick', 'rate', 'start', 'bal', 'months', 'index', 'first', 'date', 'name', 'margin', 'round', 'step', 'lookback', 'every', 'firstCap', 'periodicCap', 'lifetimeCap', 'floor', 'ceiling', 'io', 'payRound'];
  var FIELD_LABEL = {
    nick: 'Nickname', rate: 'Current rate', start: 'Start rate', bal: 'Balance', months: 'Months left', index: 'Index value', first: 'First change', date: 'Change date',
    name: 'Index', margin: 'Margin', round: 'Rounding', step: 'Increment', lookback: 'Lookback', every: 'Resets every', firstCap: 'First-change cap', periodicCap: 'Periodic cap',
    lifetimeCap: 'Lifetime cap', floor: 'Floor', ceiling: 'Ceiling', io: 'Interest-only', payRound: 'Payment rounding',
  };
  function emptyFields() { return { nick: '', rate: '', start: '', bal: '', months: '', index: '', first: '0', date: '', name: '', margin: '', round: 'nearest', step: '0.125', lookback: '45', every: '12', firstCap: '', periodicCap: '', lifetimeCap: '', floor: '', ceiling: '', io: '0', payRound: 'nearest' }; }

  /** Every rule a loan's numbers must keep, as [{field, msg}]. */
  function loanProblems(L) {
    var e = [], T = L.terms;
    var p = function (f, m) { e.push({ field: f, msg: m }); };
    var nick = nickProblem(L.nick);
    if (nick) p('nick', nick);
    if (!(L.rate >= 0 && L.rate <= LIMITS.rateMax)) p('rate', 'The current rate should be 0% to 50%.');
    if (L.start !== null && !(L.start >= 0 && L.start <= LIMITS.rateMax)) p('start', 'The start rate should be 0% to 50%.');
    if (!(L.bal >= 0 && L.bal <= LIMITS.balMax)) p('bal', 'The balance should be $0.00 to $1,000,000,000.00.');
    if (!(L.months >= 1 && L.months <= LIMITS.monthsMax)) p('months', 'Months left should be 1 to ' + LIMITS.monthsMax + '.');
    if (!(L.index >= LIMITS.rateMin && L.index <= LIMITS.rateMax)) p('index', 'The index value should be -10% to 50%.');
    if (L.date && !isDay(L.date)) p('date', 'The change date should be a real day.');
    var nm = refuse(T.name, LIMITS.indexName);
    if (nm) p('name', nm);
    if (!(T.margin >= LIMITS.marginMin && T.margin <= LIMITS.marginMax)) p('margin', 'The margin should be -5% to 25%.');
    if (ROUNDS.indexOf(T.round) < 0) p('round', 'Pick how the note rounds.');
    if (T.round !== 'none' && !(T.step >= 1 && T.step <= PCT)) p('step', 'The rounding increment should be 0.00001% to 1%.');
    if (!(T.lookback >= 0 && T.lookback <= LIMITS.lookbackMax)) p('lookback', 'The lookback should be 0 to 120 days.');
    if (!(T.every >= 1 && T.every <= LIMITS.everyMax)) p('every', 'Resets every 1 to 120 months.');
    ['firstCap', 'periodicCap', 'lifetimeCap'].forEach(function (k) { if (T[k] !== null && !(T[k] >= 0 && T[k] <= LIMITS.capMax)) p(k, FIELD_LABEL[k] + ' should be 0 to 20 points.'); });
    ['floor', 'ceiling'].forEach(function (k) { if (T[k] !== null && !(T[k] >= 0 && T[k] <= LIMITS.rateMax)) p(k, FIELD_LABEL[k] + ' should be 0% to 50%.'); });
    if (T.floor !== null && T.ceiling !== null && T.floor > T.ceiling) p('floor', 'The floor is above the ceiling.');
    if (T.lifetimeCap !== null && L.start === null) p('start', 'A lifetime cap counts from the start rate - fill it in.');
    if (T.lifetimeCap !== null && L.start !== null && T.floor !== null && L.start + T.lifetimeCap < T.floor) p('lifetimeCap', 'The lifetime cap is below the floor.');
    if (PAYROUNDS.indexOf(T.payRound) < 0) p('payRound', 'Pick how the payment rounds.');
    if (typeof T.io !== 'boolean') p('io', 'Interest-only is yes or no.');
    if (typeof L.first !== 'boolean') p('first', 'First change is yes or no.');
    return e;
  }

  /** The form's strings -> {loan, errors: [{field, msg}]}. */
  function loanFrom(F, t) {
    F = Object.assign(emptyFields(), F || {});
    var errors = [];
    function rd(k, opt) {
      var s = str(F[k]).trim();
      if (!s) { if (!opt) errors.push({ field: k, msg: FIELD_LABEL[k] + ' is needed.' }); return null; }
      var r = parseRate(s, FIELD_LABEL[k]);
      if (r.error) { errors.push({ field: k, msg: r.error }); return null; }
      return r.v;
    }
    function wh(k, lo, hi) { var r = parseWhole(F[k], FIELD_LABEL[k], lo, hi); if (r.error) { errors.push({ field: k, msg: r.error }); return null; } return r.v; }
    var bal = parseMoney(F.bal, 'The balance');
    if (bal.error) errors.push({ field: 'bal', msg: bal.error });
    var round = ROUNDS.indexOf(F.round) >= 0 ? F.round : 'nearest';
    var L = {
      nick: line(F.nick, 80), rate: rd('rate'), start: rd('start', true), bal: bal.error ? null : bal.v, months: wh('months', 1, LIMITS.monthsMax),
      index: rd('index'), first: F.first === '1' || F.first === true, date: str(F.date).trim(),
      terms: {
        name: line(F.name, 80), margin: rd('margin'), round: round, step: round === 'none' ? 0 : rd('step'), lookback: str(F.lookback).trim() ? wh('lookback', 0, LIMITS.lookbackMax) : 0,
        every: wh('every', 1, LIMITS.everyMax), firstCap: rd('firstCap', true), periodicCap: rd('periodicCap', true), lifetimeCap: rd('lifetimeCap', true),
        floor: rd('floor', true), ceiling: rd('ceiling', true), io: F.io === '1' || F.io === true, payRound: F.payRound === 'up' ? 'up' : 'nearest',
      },
      t: t || 0,
    };
    if (errors.length) {
      // Report the shape errors, and any rule the parts that did read break.
      var seen = {};
      errors.forEach(function (x) { seen[x.field] = 1; });
      var nick = nickProblem(L.nick);
      if (nick && !seen.nick) errors.unshift({ field: 'nick', msg: nick });
      return { loan: null, errors: errors };
    }
    var probs = loanProblems(L);
    return probs.length ? { loan: null, errors: probs } : { loan: L, errors: [] };
  }
  /** A loan back into the form's strings. */
  function fieldsOf(L) {
    var T = L.terms;
    return {
      nick: L.nick, rate: rateField(L.rate), start: L.start === null ? '' : rateField(L.start), bal: moneyField(L.bal), months: String(L.months), index: rateField(L.index),
      first: L.first ? '1' : '0', date: L.date || '', name: T.name, margin: rateField(T.margin), round: T.round, step: T.round === 'none' ? '0.125' : rateField(T.step),
      lookback: String(T.lookback), every: String(T.every), firstCap: T.firstCap === null ? '' : rateField(T.firstCap), periodicCap: T.periodicCap === null ? '' : rateField(T.periodicCap),
      lifetimeCap: T.lifetimeCap === null ? '' : rateField(T.lifetimeCap), floor: T.floor === null ? '' : rateField(T.floor), ceiling: T.ceiling === null ? '' : rateField(T.ceiling),
      io: T.io ? '1' : '0', payRound: T.payRound,
    };
  }

  /** Everything about one change: the rate, the payment, the dates. */
  function work(L) {
    var res = newRate(L);
    var how = { io: L.terms.io, payRound: L.terms.payRound };
    var p = payment(L.bal, res.rate, L.months, how);
    var was = payment(L.bal, L.rate, L.months, how);
    res.payment = p.cents;
    res.paymentWas = was.cents;
    res.paymentWorking = paymentWorking(L.bal, res.rate, L.months, how, p);
    res.kind = p.kind;
    if (L.date) {
      res.lookbackDay = addDays(L.date, -L.terms.lookback);
      res.firstPayDay = addMonths(L.date, 1);
      res.nextChange = addMonths(L.date, L.terms.every);
    }
    return res;
  }

  /* ================================================================== *
   * Future resets under a what-if index path
   * ================================================================== */

  var WHAT_KINDS = ['flat', 'step', 'list'];
  function defaultWhat() { return { kind: 'flat', by: 25000, list: [] }; }
  /** The index at reset k (0 = this change) under the path. */
  function indexAt(L, what, k) {
    if (k === 0) return L.index;
    if (what.kind === 'step') return Math.max(LIMITS.rateMin, Math.min(LIMITS.rateMax, L.index + what.by * k));
    if (what.kind === 'list' && what.list.length) return what.list[Math.min(k, what.list.length) - 1];
    return L.index;
  }
  /**
   * This change and the ones after it, every `every` months while months
   * are left: at each, the index from the path, the rate by the same rules
   * (the first change only once), the payment re-amortised over the months
   * left, then that many months paid at exact cents to the next change.
   */
  function future(L, what, count) {
    what = what || defaultWhat();
    count = Math.max(1, Math.min(LIMITS.futureMax, count || 10));
    var rows = [], cur = clone(L), every = L.terms.every;
    for (var k = 0; k < count && cur.months >= 1; k++) {
      cur.index = indexAt(L, what, k);
      cur.first = k === 0 ? L.first : false;
      var res = newRate(cur);
      var how = { io: cur.terms.io, payRound: cur.terms.payRound };
      var p = payment(cur.bal, res.rate, cur.months, how);
      rows.push({ k: k, day: L.date ? addMonths(L.date, every * k) : '', index: cur.index, rate: res.rate, bound: res.bound, payment: p.cents, balance: cur.bal, months: cur.months });
      // Pay `every` months at this rate to the next change.
      var bal = cur.bal, n = Math.min(every, cur.months), paid = 0, interest = 0;
      for (var i = 0; i < n && bal > 0; i++) {
        var int = monthInterest(bal, res.rate);
        var due = cur.terms.io ? int : Math.min(p.cents, bal + int);
        if (i === n - 1 && n === cur.months && !cur.terms.io) due = bal + int;   // the last payment clears it
        bal = bal + int - due; paid += due; interest += int;
      }
      rows[rows.length - 1].paid = paid; rows[rows.length - 1].interest = interest;
      cur.bal = Math.max(0, bal); cur.months -= n; cur.rate = res.rate;
    }
    return rows;
  }

  /* ================================================================== *
   * The draft notice (plain text)
   * ================================================================== */

  function noticeText(L, res, opts) {
    opts = opts || {};
    var lender = line(opts.lender, 80) || '[Lender name]';
    var T = L.terms, out = [];
    var day = L.date ? fmtDay(L.date, true) : '[change date]';
    out.push('DRAFT - FOR REVIEW BEFORE SENDING. Not legal advice. Check every figure against the note, and the notice against the rules that apply to this loan (for many US consumer loans, Regulation Z) before anything is sent.');
    out.push('');
    out.push(lender);
    out.push('Interest rate and payment change notice');
    out.push('');
    out.push('To: [Borrower name and address]');
    out.push('Loan: [Loan number]' + (opts.withNick ? '  (internal nickname: ' + L.nick + ')' : ''));
    out.push('');
    out.push('Under the terms of your loan, your interest rate and monthly payment are changing on ' + day + '.');
    out.push('');
    out.push('                      Current        New');
    out.push('Interest rate         ' + pad(fmtRate(L.rate), 15) + fmtRate(res.rate));
    out.push('Monthly payment       ' + pad(fmtMoney(res.paymentWas), 15) + fmtMoney(res.payment) + (T.io ? '  (interest only)' : ''));
    out.push('');
    out.push('How your new rate was set');
    out.push('- Index: ' + (T.name || '[index name]') + ', ' + fmtRate(L.index) + (res.lookbackDay ? ', the value as of ' + fmtDay(res.lookbackDay, true) + ' (' + T.lookback + ' days before the change date)' : '') + '.');
    out.push('- Margin: ' + fmtRate(T.margin) + '. Index plus margin: ' + fmtRate(res.fully) + '.');
    if (T.round !== 'none') out.push('- That figure is ' + roundWords(T) + ': ' + fmtRate(res.rounded) + '.');
    var lim = [];
    if (L.first && T.firstCap !== null) lim.push('at this first change, the rate cannot move more than ' + fmtPts(T.firstCap, true) + ' from ' + fmtRate(L.rate));
    else if (T.periodicCap !== null) lim.push('the rate cannot move more than ' + fmtPts(T.periodicCap, true) + ' at one change');
    if (T.lifetimeCap !== null) lim.push('it can never be more than ' + fmtRate(L.start + T.lifetimeCap) + ' over the life of the loan');
    if (T.ceiling !== null) lim.push('it can never be more than ' + fmtRate(T.ceiling));
    if (T.floor !== null) lim.push('it can never be less than ' + fmtRate(T.floor));
    if (lim.length) out.push('- Limits in your loan: ' + lim.join('; ') + '.');
    if (['first-change cap', 'periodic cap', 'lifetime cap', 'ceiling', 'floor'].indexOf(res.bound) >= 0) {
      out.push('- Because of the ' + RULE_LABEL[res.bound].toLowerCase() + ', your new rate is ' + fmtRate(res.rate) + ' and not ' + fmtRate(res.rounded) + '.');
      if (res.bound !== 'floor' && res.rounded > res.rate) out.push('  [Check the note: if it lets the rate rise later by the amount not applied now (carryover), say so here. Reset does not carry it over.]');
    } else out.push('- No limit in your loan changed the rate this time.');
    out.push('');
    out.push('Your new payment of ' + fmtMoney(res.payment) + ' is first due on ' + (res.firstPayDay ? fmtDay(res.firstPayDay, true) : '[first payment date]') + '. It is ' + (T.io ? 'interest only on' : 'worked out to pay off') + ' your balance of ' + fmtMoney(L.bal) + ' over the remaining ' + plural(L.months, 'month') + (T.io ? ' at the new rate' : ' at the new rate') + '.');
    if (res.nextChange) out.push('Your rate may change again on ' + fmtDay(res.nextChange, true) + ', and every ' + plural(T.every, 'month') + ' after that.');
    out.push('');
    out.push('[Add here anything else the rules require for this kind of loan - for example a prepayment penalty, how to reach us with questions, and contact details for housing counseling.]');
    out.push('');
    out.push('Questions: [phone number and hours]');
    out.push(lender);
    return out.join('\n');
  }
  function pad(s, n) { while (s.length < n) s += ' '; return s; }

  /* ================================================================== *
   * A batch from CSV (parsed on the phone)
   * ================================================================== */

  /** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. */
  function parseCsv(text) {
    text = str(text).replace(/^\uFEFF/, '');
    var rows = [], row = [], f = '', q = false, i = 0;
    for (; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"' && f === '') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return x.trim() !== ''; }); });
  }
  var COLS = {
    nick: ['nickname', 'nick', 'loan'], bal: ['balance', 'bal', 'principal'], rate: ['rate', 'current_rate', 'current rate'], start: ['start_rate', 'start rate', 'start', 'initial_rate'],
    months: ['months', 'months_left', 'remaining_months', 'remaining term'], index: ['index', 'index_value', 'index value'], margin: ['margin'], round: ['rounding', 'round'],
    step: ['increment', 'step', 'rounding_increment'], periodicCap: ['periodic_cap', 'periodic cap'], firstCap: ['first_change_cap', 'first_cap', 'first change cap'],
    lifetimeCap: ['lifetime_cap', 'lifetime cap'], floor: ['floor'], ceiling: ['ceiling', 'max_rate'], first: ['first_change', 'first'], io: ['interest_only', 'io'],
    date: ['change_date', 'date'], every: ['reset_every', 'every', 'reset_months'], name: ['index_name'], lookback: ['lookback', 'lookback_days'], payRound: ['payment_rounding'],
  };
  var NEED = ['nick', 'bal', 'rate', 'months', 'index', 'margin'];
  var TEMPLATE = 'nickname,balance,rate,months,index,margin,rounding,increment,periodic_cap,first_change_cap,lifetime_cap,start_rate,floor,ceiling,first_change,interest_only\n';
  function yes(s) { return /^(1|y|yes|true|x)$/i.test(str(s).trim()); }
  /**
   * The batch: the header names the columns (in any order, case and spaces
   * ignored); each row is checked like the form and worked out, or says
   * what is wrong with it. A row whose nickname is refused is never echoed.
   */
  function batch(text) {
    if (Array.from(str(text)).length > LIMITS.csvBytes) return { error: 'That file is over 1 MB - split it.' };
    var rows = parseCsv(text);
    if (rows.length < 2) return { error: 'The file needs a header row and at least one loan.' };
    if (rows.length - 1 > LIMITS.csvRows) return { error: 'Up to ' + LIMITS.csvRows + ' loans at a time - split the file.' };
    var head = rows[0].map(function (h) { return h.trim().toLowerCase().replace(/\s+/g, ' '); });
    var at = {};
    Object.keys(COLS).forEach(function (k) { var i = -1; COLS[k].forEach(function (n) { if (i < 0) i = head.indexOf(n); if (i < 0) i = head.indexOf(n.replace(/ /g, '_')); }); if (i >= 0) at[k] = i; });
    var missing = NEED.filter(function (k) { return at[k] === undefined; });
    if (missing.length) return { error: 'The header needs ' + list(missing.map(function (k) { return COLS[k][0]; })) + '.' };
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var cells = rows[r], F = emptyFields();
      F.round = 'none'; F.step = ''; F.lookback = '0'; F.every = '12';
      Object.keys(at).forEach(function (k) { var v = str(cells[at[k]]).trim(); if (k === 'first' || k === 'io') F[k] = yes(v) ? '1' : '0'; else if (v !== '' || NEED.indexOf(k) >= 0) F[k] = v; });
      if (at.round !== undefined) { F.round = str(cells[at.round]).trim().toLowerCase() || 'none'; if (ROUNDS.indexOf(F.round) < 0) F.round = 'bad'; }
      if (F.round !== 'none' && !F.step) F.step = '0.125';
      var got = F.round === 'bad' ? { errors: [{ field: 'round', msg: 'Rounding should be nearest, up, down or none.' }] } : loanFrom(F, 0);
      var nickBad = nickProblem(F.nick);
      var shown = nickBad ? '(refused nickname)' : line(F.nick, 40);
      if (got.errors.length) { out.push({ row: r + 1, nick: shown, error: got.errors.map(function (x) { return x.msg; }).slice(0, 3).join(' ') }); continue; }
      var res = work(got.loan);
      out.push({ row: r + 1, nick: shown, loan: got.loan, res: res });
    }
    var ok = out.filter(function (x) { return !x.error; });
    return { rows: out, ok: ok.length, bad: out.length - ok.length, counts: RULES.reduce(function (m, k) { m[k] = ok.filter(function (x) { return x.res.bound === k; }).length; return m; }, {}) };
  }
  /** A cell for a CSV: quoted when it must be; anything that could start a
   *  formula gets a leading ' (a plain number such as -0.150 is left). */
  function csvCell(v) {
    var s = str(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function batchCsv(b) {
    var head = ['row', 'nickname', 'status', 'fully_indexed', 'rounded', 'new_rate', 'bound_by', 'rate_change', 'payment_at_current_rate', 'new_payment', 'payment_change', 'error'];
    var lines = [head.join(',')];
    b.rows.forEach(function (x) {
      var cells = x.error ? [x.row, x.nick, 'error', '', '', '', '', '', '', '', '', x.error]
        : [x.row, x.nick, 'ok', rateField(x.res.fully), rateField(x.res.rounded), rateField(x.res.rate), x.res.bound, rateField(x.res.change), moneyField(x.res.paymentWas), moneyField(x.res.payment), (x.res.payment - x.res.paymentWas < 0 ? '-' : '') + moneyField(Math.abs(x.res.payment - x.res.paymentWas)), ''];
      lines.push(cells.map(csvCell).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  /* ================================================================== *
   * The book of loans: the one door, and two phones
   * ================================================================== */

  var ID = /^l[a-z0-9]{6,12}$/;
  var LOAN_KEYS = ['nick', 'rate', 'start', 'bal', 'months', 'index', 'first', 'date', 'terms', 'what', 't'];
  var TERM_KEYS = ['name', 'margin', 'round', 'step', 'lookback', 'every', 'firstCap', 'periodicCap', 'lifetimeCap', 'floor', 'ceiling', 'io', 'payRound'];
  function newBook(t) { return { v: 1, t: t || 0, loans: {} }; }
  function cleanWhat(w, strict, errs, where) {
    if (w === undefined || w === null) return defaultWhat();
    if (!isObj(w)) { errs.push(where + ': the what-if path is not in shape.'); return defaultWhat(); }
    var extra = Object.keys(w).filter(function (k) { return ['kind', 'by', 'list'].indexOf(k) < 0; });
    if (extra.length && strict) errs.push(where + ': unknown field ' + line(extra[0], 20) + '.');
    var out = defaultWhat();
    if (WHAT_KINDS.indexOf(w.kind) >= 0) out.kind = w.kind; else if (strict) errs.push(where + ': unknown what-if kind.');
    if (isInt(w.by) && Math.abs(w.by) <= 5 * PCT) out.by = w.by; else if (w.by !== undefined && strict) errs.push(where + ': the what-if step is out of range.');
    if (Array.isArray(w.list) && w.list.length <= LIMITS.whatList && w.list.every(function (x) { return isInt(x) && x >= LIMITS.rateMin && x <= LIMITS.rateMax; })) out.list = w.list.slice();
    else if (w.list !== undefined && strict) errs.push(where + ': the what-if index list is out of shape.');
    return out;
  }
  /** One loan through the door: {loan} or null, problems into `errs`. */
  function cleanLoan(raw, strict, errs, where) {
    if (!isObj(raw)) { errs.push(where + ' is not in shape.'); return null; }
    if (raw.del === true) {
      if (strict && Object.keys(raw).some(function (k) { return k !== 'del' && k !== 't'; })) errs.push(where + ': a removed loan keeps only its time.');
      if (!isInt(raw.t) || raw.t < 0) { errs.push(where + ': its time is not a number.'); return null; }
      return { del: true, t: raw.t };
    }
    var extra = Object.keys(raw).filter(function (k) { return LOAN_KEYS.indexOf(k) < 0; });
    if (extra.length) { errs.push(where + ': unknown field ' + line(extra[0], 20) + '.'); if (strict) return null; }
    var T = raw.terms;
    if (!isObj(T)) { errs.push(where + ': its terms are not in shape.'); return null; }
    var tx = Object.keys(T).filter(function (k) { return TERM_KEYS.indexOf(k) < 0; });
    if (tx.length) { errs.push(where + ': unknown term ' + line(tx[0], 20) + '.'); if (strict) return null; }
    var ints = ['rate', 'bal', 'months', 'index', 't'].filter(function (k) { return !isInt(raw[k]); });
    var tints = ['margin', 'step', 'lookback', 'every'].filter(function (k) { return !isInt(T[k]); });
    var nulls = ['firstCap', 'periodicCap', 'lifetimeCap', 'floor', 'ceiling'].filter(function (k) { return !(T[k] === null || isInt(T[k])); });
    if (ints.length || tints.length || nulls.length || !(raw.start === null || isInt(raw.start)) || typeof raw.nick !== 'string' || typeof T.name !== 'string' || typeof raw.date !== 'string') {
      errs.push(where + ': ' + (ints.concat(tints, nulls)[0] || 'a field') + ' is not a whole number.'); return null;
    }
    var L = {
      nick: raw.nick, rate: raw.rate, start: raw.start, bal: raw.bal, months: raw.months, index: raw.index, first: raw.first, date: raw.date,
      terms: { name: T.name, margin: T.margin, round: T.round, step: T.step, lookback: T.lookback, every: T.every, firstCap: T.firstCap, periodicCap: T.periodicCap, lifetimeCap: T.lifetimeCap, floor: T.floor, ceiling: T.ceiling, io: T.io, payRound: T.payRound },
      what: null, t: raw.t,
    };
    var probs = loanProblems(L);
    if (probs.length) { errs.push(where + ': ' + probs[0].msg); return null; }
    var werrs = [];
    L.what = cleanWhat(raw.what, strict, werrs, where);
    if (werrs.length) { errs.push(werrs[0]); if (strict) return null; }
    return L;
  }
  /**
   * The one door for a whole book. Strict (the server): anything out of
   * shape is an error and nothing is kept. Lenient (this phone's own copy):
   * the bad loan is dropped and the rest kept.
   */
  function cleanBook(raw, strict) {
    var errs = [], out = newBook(0);
    if (!isObj(raw)) return { book: out, errors: ['The book is not in shape.'] };
    var extra = Object.keys(raw).filter(function (k) { return ['v', 't', 'loans'].indexOf(k) < 0; });
    if (extra.length) errs.push('Unknown field ' + line(extra[0], 20) + '.');
    if (raw.v !== 1) errs.push('Unknown version.');
    out.t = isInt(raw.t) && raw.t >= 0 ? raw.t : 0;
    if (!isObj(raw.loans)) { errs.push('No loans.'); return { book: out, errors: errs }; }
    var ids = Object.keys(raw.loans);
    if (ids.length > LIMITS.loans) { errs.push('More than ' + LIMITS.loans + ' loans.'); if (strict) return { book: out, errors: errs }; ids = ids.slice(0, LIMITS.loans); }
    ids.forEach(function (id) {
      if (!ID.test(id)) { errs.push('A loan id is not in shape.'); return; }
      var L = cleanLoan(raw.loans[id], strict, errs, 'Loan ' + (raw.loans[id] && typeof raw.loans[id].nick === 'string' ? '“' + line(raw.loans[id].nick, 30) + '”' : id));
      if (L) out.loans[id] = L;
    });
    return { book: out, errors: errs };
  }
  /** What the server refuses whole before the door looks: any string
   *  anywhere with an @, nine digits in a row, a link, markup or an
   *  invisible character. */
  function bodyProblem(v, depth) {
    depth = depth || 0;
    if (depth > 8) return 'That is nested too deeply.';
    if (typeof v === 'string') {
      if (hasAt(v)) return 'Something in it has an @ - Reset keeps no email addresses.';
      if (nineDigits(v)) return 'Something in it has nine digits in a row - Reset keeps no tax ids or account numbers.';
      if (hasLink(v)) return 'Something in it looks like a link.';
      if (hasMarkup(v)) return 'Something in it has markup.';
      if (hasInvisible(v)) return 'Something in it has an invisible character.';
      return '';
    }
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) { var p = bodyProblem(v[i], depth + 1); if (p) return p; } return ''; }
    if (isObj(v)) {
      var ks = Object.keys(v);
      for (var j = 0; j < ks.length; j++) { var q = bodyProblem(ks[j], depth + 1) || bodyProblem(v[ks[j]], depth + 1); if (q) return q; }
    }
    return '';
  }
  function liveLoans(b) { return b ? Object.keys(b.loans).filter(function (id) { return !b.loans[id].del; }).map(function (id) { var L = clone(b.loans[id]); L.id = id; return L; }).sort(function (x, y) { return x.nick.localeCompare(y.nick); }) : []; }
  function putLoan(b, id, L, t) { var n = clone(b); var x = clone(L); delete x.id; x.t = t; n.loans[id] = x; n.t = Math.max(n.t, t); return n; }
  function removeLoan(b, id, t) { var n = clone(b); n.loans[id] = { del: true, t: t }; n.t = Math.max(n.t, t); return n; }

  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function later(x, y) {
    if (!x) return y; if (!y) return x;
    if (x.t !== y.t) return x.t > y.t ? x : y;
    return canon(x) >= canon(y) ? x : y;
  }
  function same(a, b) { return canon(a) === canon(b); }
  function contentOf(L) { var x = clone(L); delete x.t; return x; }
  /**
   * Two copies of one book, made one. Each loan by its own time (a removal
   * is a change like any other). A loan both phones changed since they last
   * agreed (`since`, the sync base) keeps the later one; the other is kept
   * beside it as "<nickname> (other phone)" when they really differ, so no
   * typing is lost. Symmetric and idempotent.
   */
  function merge(a, b, since) {
    a = cleanBook(a).book; b = cleanBook(b).book;
    since = since || 0;
    var out = newBook(Math.max(a.t, b.t)), notes = [];
    Object.keys(a.loans).concat(Object.keys(b.loans)).forEach(function (id) {
      if (out.loans[id]) return;
      var x = a.loans[id], y = b.loans[id], w = later(x, y);
      out.loans[id] = clone(w);
      var lose = w === x ? y : x;
      if (lose && x && y && !lose.del && !w.del && lose.t > since && w.t > since && canon(contentOf(lose)) !== canon(contentOf(w))) {
        var cid = copyIdOf(id);
        if (!a.loans[cid] && !b.loans[cid]) {
          var c = clone(lose); c.nick = clip(lose.nick, LIMITS.nick - 14) + ' (other phone)';
          out.loans[cid] = c;
          notes.push('Both phones changed “' + w.nick + '”. The other phone’s version is kept as “' + c.nick + '”.');
        }
      }
    });
    return { book: out, notes: notes };
  }
  function copyIdOf(id) { return (id.slice(0, 9) + 'cp').slice(0, 13); }

  /* ================================================================== *
   * The AI: "Read the note"
   * ================================================================== */

  var IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  /** The request, rebuilt: exactly {images: [{type, data}]} (one or two
   *  photos of the note's rate-change section) OR exactly {text} (that
   *  section pasted, through pasteProblem). Anything else is refused. */
  function termsRequest(body) {
    var bad = function (msg, code) { return { error: msg, code: code || 'bad-request' }; };
    if (!isObj(body)) return bad('Send a photo of the rate-change section, or paste it.');
    var keys = Object.keys(body);
    if (keys.length === 1 && keys[0] === 'text') {
      if (typeof body.text !== 'string') return bad('Paste the text.', 'text');
      var why = pasteProblem(body.text);
      if (why) return bad(why, 'personal');
      return { req: { text: body.text.replace(/\r\n?/g, '\n').trim() } };
    }
    var extra = keys.filter(function (k) { return k !== 'images'; });
    if (extra.length) return bad('Only the photos, or only the pasted text, are sent - not ' + extra.slice(0, 3).map(function (x) { return line(x, 20); }).join(', ') + '.', 'extra-field');
    var ims = body.images;
    if (!Array.isArray(ims) || ims.length < 1 || ims.length > LIMITS.aiImages) return bad('Send one photo of the rate-change section, or two.', 'image');
    var out = [];
    for (var i = 0; i < ims.length; i++) {
      var im = ims[i];
      if (!isObj(im) || Object.keys(im).sort().join() !== 'data,type') return bad('Send each photo as {type, data}.', 'image');
      if (IMAGE_TYPES.indexOf(im.type) < 0) return bad('A photo must be a JPEG, PNG or WebP.', 'image');
      if (typeof im.data !== 'string' || im.data.length < 16 || im.data.length > Math.ceil(LIMITS.aiImageBytes * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+=*$/.test(im.data)) return bad('That photo is too large or not a photo. The page shrinks it first - try again from the page.', 'image');
      out.push({ type: im.type, data: im.data });
    }
    return { req: { images: out } };
  }
  var AI_RATES = ['margin', 'increment', 'first_change_cap', 'periodic_cap', 'lifetime_cap', 'floor', 'ceiling'];
  var AI_FIELDS = ['index_name', 'margin', 'rounding', 'increment', 'lookback_days', 'reset_every_months', 'first_change_cap', 'periodic_cap', 'lifetime_cap', 'floor', 'ceiling', 'interest_only', 'unsure'];
  var UNSURE = ['index_name', 'margin', 'rounding', 'lookback_days', 'reset_every_months', 'first_change_cap', 'periodic_cap', 'lifetime_cap', 'floor', 'ceiling', 'interest_only'];
  var AI_TO_FIELD = { index_name: 'name', margin: 'margin', rounding: 'round', increment: 'step', lookback_days: 'lookback', reset_every_months: 'every', first_change_cap: 'firstCap', periodic_cap: 'periodicCap', lifetime_cap: 'lifetimeCap', floor: 'floor', ceiling: 'ceiling', interest_only: 'io' };
  /**
   * A model's reading, checked. Only the terms' own fields are kept; any
   * other field (a name, an address, a loan number, a balance, advice) is
   * dropped and named. Every rate goes through Reset's own reader and its
   * range; one it cannot read is dropped and named. The result is FORM
   * STRINGS for a person to check - it never sets a balance, a current
   * rate, an index value or a nickname. Nothing readable is an error.
   */
  function cleanAiTerms(raw) {
    if (!isObj(raw)) return { error: 'Nothing readable came back. Try a clearer photo, or type the terms in.', code: 'unreadable' };
    var dropped = [], fields = {}, got = 0;
    Object.keys(raw).forEach(function (k) { if (AI_FIELDS.indexOf(k) < 0) dropped.push(line(k, 24)); });
    if (typeof raw.index_name === 'string' && raw.index_name.trim()) {
      var nm = line(raw.index_name, LIMITS.indexName);
      if (refuse(nm, LIMITS.indexName) || nameIn(nm) || accountLike(nm, 6)) dropped.push('index_name'); else { fields.name = nm; got++; }
    }
    AI_RATES.forEach(function (k) {
      var v = raw[k];
      if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return;
      var r = typeof v === 'string' && v.length <= 24 ? parseRate(v) : { error: 'x' };
      var lim = k === 'margin' ? [LIMITS.marginMin, LIMITS.marginMax] : k === 'increment' ? [1, PCT] : k === 'floor' || k === 'ceiling' ? [0, LIMITS.rateMax] : [0, LIMITS.capMax];
      if (r.error || r.v < lim[0] || r.v > lim[1]) { dropped.push(k); return; }
      fields[AI_TO_FIELD[k]] = rateField(r.v); got++;
    });
    if (raw.rounding !== undefined && raw.rounding !== null) {
      if (ROUNDS.indexOf(raw.rounding) >= 0) { fields.round = raw.rounding; got++; } else dropped.push('rounding');
    }
    [['lookback_days', 0, LIMITS.lookbackMax], ['reset_every_months', 1, LIMITS.everyMax]].forEach(function (p) {
      var v = raw[p[0]];
      if (v === undefined || v === null) return;
      if (isInt(v) && v >= p[1] && v <= p[2]) { fields[AI_TO_FIELD[p[0]]] = String(v); got++; } else dropped.push(p[0]);
    });
    if (raw.interest_only !== undefined && raw.interest_only !== null) {
      if (typeof raw.interest_only === 'boolean') fields.io = raw.interest_only ? '1' : '0'; else dropped.push('interest_only');
    }
    var unsure = (Array.isArray(raw.unsure) ? raw.unsure : []).filter(function (u, i, a) { return UNSURE.indexOf(u) >= 0 && a.indexOf(u) === i; }).map(function (u) { return AI_TO_FIELD[u]; });
    if (!got) return { error: 'Nothing on that page read as rate-change terms. Try a clearer photo of the section, or type them in.', code: 'unreadable' };
    return { fields: fields, unsure: unsure, dropped: dropped.filter(function (d, i, a) { return a.indexOf(d) === i; }).slice(0, 16) };
  }

  return {
    PCT: PCT, LIMITS: LIMITS, ROUNDS: ROUNDS, PAYROUNDS: PAYROUNDS, RULES: RULES, RULE_LABEL: RULE_LABEL, FIELDS: FIELDS, FIELD_LABEL: FIELD_LABEL, WHAT_KINDS: WHAT_KINDS, UNSURE: UNSURE, TEMPLATE: TEMPLATE,
    str: str, esc: esc, line: line, clip: clip, clone: clone, list: list, plural: plural, isObj: isObj,
    hasAt: hasAt, hasLink: hasLink, hasPhone: hasPhone, nineDigits: nineDigits, hasCard: hasCard, accountLike: accountLike, isFormula: isFormula, nameIn: nameIn,
    refuse: refuse, nickProblem: nickProblem, pasteProblem: pasteProblem,
    floorDiv: floorDiv, parseRate: parseRate, parseMoney: parseMoney, fmtRate: fmtRate, rateField: rateField, fmtPts: fmtPts, fmtMoney: fmtMoney, moneyField: moneyField,
    isDay: isDay, addDays: addDays, addMonths: addMonths, fmtDay: fmtDay,
    roundRate: roundRate, roundWords: roundWords, newRate: newRate, boundSentence: boundSentence, payment: payment, monthInterest: monthInterest, paymentWorking: paymentWorking,
    emptyFields: emptyFields, loanProblems: loanProblems, loanFrom: loanFrom, fieldsOf: fieldsOf, work: work,
    defaultWhat: defaultWhat, indexAt: indexAt, future: future, noticeText: noticeText,
    parseCsv: parseCsv, batch: batch, batchCsv: batchCsv, csvCell: csvCell,
    newBook: newBook, cleanBook: cleanBook, cleanWhat: cleanWhat, bodyProblem: bodyProblem, liveLoans: liveLoans, putLoan: putLoan, removeLoan: removeLoan,
    canon: canon, same: same, merge: merge, copyIdOf: copyIdOf,
    termsRequest: termsRequest, cleanAiTerms: cleanAiTerms,
  };
}));
