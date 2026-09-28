/* Covenant - the rules, in one file the page and the server both run.
 *
 * UMD: the page loads it as window.CovenantCore, the server and the tests
 * require() it. Everything that decides a number lives here - reading money,
 * the health check (ratios, pass / tight / breach, headroom in words), the
 * deadlines worked out from the fiscal year end, the .ics calendar - plus the
 * cleaning every covenant goes through, whether it came from a model or back
 * from the page to be saved. No DOM, no network, no clock of its own: "today"
 * and "now" are always passed in, so a test can pin them.
 *
 * Money is integer cents throughout, read from the typed digits and never
 * through a float. Ratios are compared exactly: a threshold of 1.25x is 1250
 * thousandths, and "EBITDA / debt service >= 1.25" is checked as
 * EBITDA * 1000 >= 1250 * debt service in BigInt, so a covenant is never
 * passed or failed by a rounding error.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CovenantCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    text: 60000,          // characters of agreement text per read
    minText: 200,         // shorter than this is not an agreement
    photos: 6,            // pages per read
    covenants: 40,        // per loan
    loans: 10,            // saved loans per person
    periods: 20,          // saved periods per loan
    maxCents: 1000000000000, // $10,000,000,000 - any one number
    maxRatio: 50,         // a ratio threshold above 50x is a misreading
    name: 80,
  };

  var KINDS = ['financial', 'reporting', 'negative', 'affirmative', 'insurance', 'other'];
  var KIND_LABEL = {
    financial: 'Financial tests',
    reporting: 'Reports you owe the lender',
    negative: 'Things you can’t do without asking',
    affirmative: 'Things you must keep doing',
    insurance: 'Insurance',
    other: 'Other terms',
  };
  var METRICS = ['dscr', 'leverage', 'current_ratio', 'min_net_worth', 'min_liquidity', 'fixed_charge', 'other'];
  var OPS = ['>=', '<=', '>', '<'];
  var UNITS = ['x', '$', '%'];
  var TESTED = ['quarterly', 'annually', 'monthly', 'ongoing'];
  var TESTED_LABEL = { quarterly: 'Tested quarterly', annually: 'Tested yearly', monthly: 'Monthly', ongoing: 'Ongoing' };
  var DUE_OF = ['fiscal_year_end', 'quarter_end', 'month_end'];
  var CONF = ['high', 'medium', 'low'];

  /* ---------------- text ---------------- */

  /** Plain text only: markup, control and direction-override characters
   *  out, whitespace collapsed, cut to `max` with an ellipsis. */
  function clean(v, max) {
    var s = typeof v === 'string' ? v : (v === null || v === undefined || typeof v === 'object' ? '' : String(v));
    if (s.length > max * 4 + 2000) s = s.slice(0, max * 4 + 2000);
    s = s.replace(/<[^>]*>?/g, ' ')
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (s.length > max) s = s.slice(0, max - 1).replace(/\s+$/, '') + '…';
    return s;
  }
  function oneOf(v, list, dflt) { return list.indexOf(v) >= 0 ? v : dflt; }

  /** How a quote is compared with the text: Unicode-normalised, curly quotes
   *  and dashes made plain, invisible characters dropped, whitespace
   *  collapsed. Everything else - spelling, case, punctuation, the numbers -
   *  must match exactly. */
  function normForMatch(s) {
    s = String(s || '');
    if (s.normalize) s = s.normalize('NFKC');
    return s
      .replace(/[\u2018\u2019\u201a\u201b\u2032\u00b4`]/g, "'")
      .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** A function that says whether a quote is in `text`, as an exact
   *  substring after normForMatch. Short quotes (under 12 characters) never
   *  count: "EBITDA" is in every agreement and proves nothing. */
  function matcher(text) {
    var hay = normForMatch(text);
    return function (quote) {
      var q = normForMatch(quote);
      if (q.length < 12) return false;
      return hay.indexOf(q) >= 0;
    };
  }

  /* ---------------- money ---------------- */

  /**
   * Typed money as integer cents, or null. "$1,234.56", "1234.5", "(1,200)"
   * and "-1200" (when negatives are allowed) all read; a third decimal rounds
   * half up. Read from the digits as text: 0.1 + 0.2 is 30 cents.
   */
  function toCents(v, allowNegative) {
    if (typeof v === 'number') {
      if (!isFinite(v)) return null;
      v = v.toFixed(3);
    }
    if (typeof v !== 'string') return null;
    var s = v.replace(/[\s$,]/g, '').replace(/^USD/i, '');
    var neg = false;
    var paren = /^\((.*)\)$/.exec(s);
    if (paren) { neg = true; s = paren[1]; }
    if (s.charAt(0) === '-') { neg = !neg; s = s.slice(1); }
    if (s.charAt(0) === '+' && !neg) s = s.slice(1);
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
    if (neg && !allowNegative) return null;
    var parts = s.split('.');
    var whole = parts[0] || '0';
    var frac = (parts[1] || '') + '000';
    if (whole.length > 13) return null;
    var cents = Number(whole) * 100 + Number(frac.slice(0, 2)) + (Number(frac.charAt(2)) >= 5 ? 1 : 0);
    if (!isFinite(cents) || cents > LIMITS.maxCents) return null;
    return neg && cents ? -cents : cents;
  }

  function groups(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /** $1,234.56 - or $1,235 with `whole` (rounded half away from zero). */
  function money(cents, whole) {
    var neg = cents < 0;
    var a = Math.abs(cents);
    var s = whole ? '$' + groups(Math.round(a / 100)) : '$' + groups(Math.floor(a / 100)) + '.' + String(a % 100).padStart(2, '0');
    return neg ? '−' + s : s;
  }
  /** Dollars for a headroom figure: rounded DOWN to the dollar, so "could
   *  fall by $5,800" is never a cent more than is really there. */
  function roomMoney(cents) { return '$' + groups(Math.floor(Math.max(0, cents) / 100)); }
  /** A shortfall: rounded UP to the dollar, so fixing it by that much fixes it. */
  function shortMoney(cents) { return '$' + groups(Math.ceil(Math.max(0, cents) / 100)); }
  /** Cents as the plain text a form field holds: "126300" -> "126,300". */
  function plainMoney(cents) {
    if (cents === null || cents === undefined) return '';
    var neg = cents < 0; var a = Math.abs(cents);
    var s = groups(Math.floor(a / 100)) + (a % 100 ? '.' + String(a % 100).padStart(2, '0') : '');
    return (neg ? '-' : '') + s;
  }

  /** A threshold's number from a model: 1.25, "1.25x", "$250,000", "3.0 to
   *  1.0", "25%", "$1.5 million". The first number, with its multiplier. */
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    var s = v.replace(/,/g, '');
    var m = /(-?\d+(?:\.\d+)?|-?\.\d+)/.exec(s);
    if (!m) return null;
    var n = Number(m[1]);
    var after = s.slice(m.index + m[1].length).toLowerCase();
    if (/^\s*(million|mm\b|m\b)/.test(after)) n *= 1e6;
    else if (/^\s*(thousand|k\b)/.test(after)) n *= 1e3;
    return isFinite(n) ? n : null;
  }

  /* ---------------- covenants: cleaning ---------------- */

  var RATIO_METRICS = { dscr: 1, leverage: 1, current_ratio: 1, fixed_charge: 1 };
  var MONEY_METRICS = { min_net_worth: 1, min_liquidity: 1 };

  function cleanThreshold(raw, metric) {
    if (!raw || typeof raw !== 'object') return null;
    var op = typeof raw.op === 'string' ? raw.op.replace(/\s/g, '').replace('≥', '>=').replace('≤', '<=') : '';
    if (OPS.indexOf(op) < 0) return null;
    var value = num(raw.value);
    if (value === null || value < 0) return null;
    var unit = oneOf(raw.unit, UNITS, null);
    if (unit === null && typeof raw.value === 'string') unit = /\$/.test(raw.value) ? '$' : /%/.test(raw.value) ? '%' : /x\b|to\s*1/i.test(raw.value) ? 'x' : null;
    if (unit === null && metric && RATIO_METRICS[metric]) unit = 'x';
    if (unit === null && metric && MONEY_METRICS[metric]) unit = '$';
    if (unit === 'x' && (value <= 0 || value > LIMITS.maxRatio)) return null;
    if (unit === '%' && value > 10000) return null;
    if (unit === '$' && value * 100 > LIMITS.maxCents) return null;
    // Three decimals for a ratio, cents for money: what the checks compare.
    value = unit === '$' ? Math.round(value * 100) / 100 : Math.round(value * 1000) / 1000;
    return { op: op, value: value, unit: unit };
  }

  function cleanDueRule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var of = oneOf(raw.of, DUE_OF, null);
    var n = typeof raw.daysAfter === 'string' ? num(raw.daysAfter) : raw.daysAfter;
    if (!of || typeof n !== 'number' || !isFinite(n)) return null;
    n = Math.round(n);
    if (n < 0 || n > 365) return null;
    var out = { daysAfter: n, of: of };
    if (raw.exceptFiscalYearEnd === true && of === 'quarter_end') out.exceptFiscalYearEnd = true;
    return out;
  }

  /**
   * One covenant made safe to store and draw: every enum from its list,
   * every string bounded and stripped of markup, numbers read and range-
   * checked. `verified` and `from` are carried as booleans / one of two words;
   * the server sets them from its own quote check on a read. Null when there
   * is nothing to show (no title and no explanation).
   */
  function cleanCovenant(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var kind = oneOf(raw.kind, KINDS, 'other');
    var title = clean(raw.title, 120);
    var plain = clean(raw.plain, 400);
    if (!title && !plain) return null;
    var metric = kind === 'financial' ? oneOf(raw.metric, METRICS, 'other') : null;
    return {
      kind: kind,
      title: title || plain.slice(0, 80),
      plain: plain,
      explainToCustomer: clean(raw.explainToCustomer, 700),
      metric: metric,
      threshold: kind === 'financial' || kind === 'negative' ? cleanThreshold(raw.threshold, metric) : null,
      testedWhen: oneOf(raw.testedWhen, TESTED, null),
      dueRule: cleanDueRule(raw.dueRule),
      definitionNotes: clean(raw.definitionNotes, 600),
      quote: clean(raw.quote, 1200),
      section: clean(raw.section, 40) || null,
      confidence: oneOf(raw.confidence, CONF, 'low'),
      verified: raw.verified === true,
      from: raw.from === 'photo' ? 'photo' : 'text',
    };
  }

  function cleanLoan(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var out = {
      lender: clean(r.lender, 100),
      borrower: clean(r.borrower, 100),
      amount: clean(r.amount, 60),
      type: clean(r.type, 80),
      maturity: clean(r.maturity, 60),
    };
    return out;
  }

  /** A list of covenants, cleaned, at most LIMITS.covenants, each with a
   *  stable id by position. */
  function cleanCovenants(list) {
    var out = [];
    var dropped = 0;
    var arr = Array.isArray(list) ? list.slice(0, 200) : [];
    for (var i = 0; i < arr.length; i++) {
      var c = cleanCovenant(arr[i]);
      if (!c) { dropped++; continue; }
      if (out.length >= LIMITS.covenants) { dropped++; continue; }
      c.id = 'c' + (out.length + 1);
      out.push(c);
    }
    return { covenants: out, dropped: dropped };
  }

  /* ---------------- the health check ---------------- */

  /** The numbers a health check can ask for, in the order the form shows. */
  var FIELDS = [
    { key: 'ebitda', label: 'EBITDA (or net operating income)', short: 'EBITDA', hint: 'Last 12 months, or the year the lender tests', negative: true },
    { key: 'debtService', label: 'Annual debt service', short: 'debt service', hint: 'Principal + interest paid on all loans over the same 12 months' },
    { key: 'totalDebt', label: 'Total funded debt', short: 'debt', hint: 'Loan balances that count toward leverage' },
    { key: 'fixedCharges', label: 'Fixed charges', short: 'fixed charges', hint: 'Debt service plus rent and leases, as your agreement counts them' },
    { key: 'currentAssets', label: 'Current assets', short: 'current assets', hint: 'Cash, receivables, inventory - from the balance sheet' },
    { key: 'currentLiabilities', label: 'Current liabilities', short: 'current liabilities', hint: 'Bills, payroll and loan payments due within a year' },
    { key: 'netWorth', label: 'Net worth (equity)', short: 'net worth', hint: 'Total assets minus total liabilities', negative: true },
    { key: 'cash', label: 'Cash and liquid funds', short: 'cash', hint: 'Unrestricted cash and cash equivalents' },
  ];
  var FIELD = {};
  FIELDS.forEach(function (f) { FIELD[f.key] = f; });

  var METRIC_DEF = {
    dscr: { name: 'Debt service coverage (DSCR)', short: 'DSCR', num: 'ebitda', den: 'debtService', formula: 'EBITDA ÷ annual debt service' },
    leverage: { name: 'Leverage (debt to EBITDA)', short: 'leverage', num: 'totalDebt', den: 'ebitda', formula: 'funded debt ÷ EBITDA' },
    current_ratio: { name: 'Current ratio', short: 'the current ratio', num: 'currentAssets', den: 'currentLiabilities', formula: 'current assets ÷ current liabilities' },
    fixed_charge: { name: 'Fixed charge coverage', short: 'fixed charge coverage', num: 'ebitda', den: 'fixedCharges', formula: 'EBITDA ÷ fixed charges' },
    min_net_worth: { name: 'Minimum net worth', short: 'net worth', num: 'netWorth', den: null, formula: 'net worth from the balance sheet' },
    min_liquidity: { name: 'Minimum liquidity', short: 'cash', num: 'cash', den: null, formula: 'unrestricted cash on hand' },
  };

  function isChecked(c) { return Boolean(c && c.kind === 'financial' && METRIC_DEF[c.metric]); }

  /** The input keys the loan's financial covenants need, in form order. */
  function fieldsFor(covenants) {
    var need = {};
    (covenants || []).forEach(function (c) {
      if (!isChecked(c)) return;
      var d = METRIC_DEF[c.metric];
      need[d.num] = 1;
      if (d.den) need[d.den] = 1;
    });
    return FIELDS.filter(function (f) { return need[f.key]; }).map(function (f) { return f.key; });
  }

  /** Stored / typed inputs as cents: {key: cents|null} for known keys only. */
  function cleanInputs(raw) {
    var out = {};
    var r = raw && typeof raw === 'object' ? raw : {};
    FIELDS.forEach(function (f) {
      var v = r[f.key];
      var c = typeof v === 'number' && Number.isInteger(v) ? v : (typeof v === 'string' ? toCents(v, f.negative) : null);
      if (c !== null && (Math.abs(c) > LIMITS.maxCents || (c < 0 && !f.negative))) c = null;
      out[f.key] = c;
    });
    return out;
  }

  // BigInt division that rounds the way it says, whatever the signs.
  function bFloor(a, b) { var q = a / b; return (a % b !== 0n && ((a < 0n) !== (b < 0n))) ? q - 1n : q; }
  function bCeil(a, b) { var q = a / b; return (a % b !== 0n && ((a < 0n) === (b < 0n))) ? q + 1n : q; }

  function ratioText(hundredths) {
    var neg = hundredths < 0; var a = Math.abs(hundredths);
    return (neg ? '−' : '') + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0') + 'x';
  }
  function thresholdText(t) {
    if (!t) return '';
    var word = { '>=': 'at least', '>': 'more than', '<=': 'at most', '<': 'less than' }[t.op];
    return word + ' ' + valueText(t);
  }
  function valueText(t) {
    if (t.unit === '$') return money(Math.round(t.value * 100), Math.round(t.value * 100) % 100 === 0);
    if (t.unit === '%') return trimNum(t.value) + '%';
    return trimNum(t.value) + (t.unit === 'x' ? 'x' : '');
  }
  function trimNum(n) {
    var s = (Math.round(n * 1000) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return s.indexOf('.') < 0 ? s + '.0' : s.replace(/(\.\d)$/, '$1');
  }
  function chipText(c) {
    if (!c.threshold) return '';
    var t = c.threshold;
    var sym = { '>=': '≥', '>': '>', '<=': '≤', '<': '<' }[t.op];
    var who = c.kind === 'financial' && METRIC_DEF[c.metric] ? (c.metric === 'dscr' ? 'DSCR' : c.metric === 'leverage' ? 'Leverage' : c.metric === 'current_ratio' ? 'Current ratio' : c.metric === 'fixed_charge' ? 'FCCR' : c.metric === 'min_net_worth' ? 'Net worth' : 'Liquidity') : 'Limit';
    return who + ' ' + sym + ' ' + valueText(t);
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function pct(part, whole) {
    if (!(whole > 0)) return '';
    var p = Number(bFloor(BigInt(part) * 100n, BigInt(whole)));
    return p >= 1 ? ' (' + p + '%)' : ' (under 1%)';
  }

  /**
   * One financial covenant against one period's numbers.
   *
   * Returns {id, status, name, value, valueText, threshold, need, headroom,
   * also, formula, definition, gauge}. status is one of
   *   pass     comfortably met
   *   tight    met, but within 10% of the threshold
   *   breach   not met
   *   missing  a number it needs has not been entered (need: [keys])
   *   cant     cannot be worked out (a zero or negative denominator, a
   *            threshold in a unit this metric does not use, no number)
   *   manual   not a test this app can check (metric "other")
   */
  function evaluate(c, inputs) {
    var out = { id: c.id, status: 'manual', name: c.title, headroom: '', also: '', formula: '', valueText: '', value: null, need: [], definition: c.definitionNotes || '' };
    var d = METRIC_DEF[c.metric];
    if (c.kind !== 'financial' || !d) {
      out.headroom = 'Covenant can’t work this one out for you - check it against your agreement’s own definition.';
      return out;
    }
    out.name = d.name;
    var t = c.threshold;
    var inp = cleanInputs(inputs);
    var isRatio = Boolean(d.den);
    if (!t) { out.status = 'cant'; out.headroom = 'No number was found for this test - check the agreement for the level it sets.'; return out; }
    out.threshold = thresholdText(t);
    var min = t.op === '>=' || t.op === '>';
    var strict = t.op === '>' || t.op === '<';
    if (isRatio && t.unit === '$') { out.status = 'cant'; out.headroom = 'This test is written as a dollar amount rather than a ratio - check it by hand.'; return out; }
    if (!isRatio && t.unit !== '$') { out.status = 'cant'; out.headroom = 'This test is not written as a dollar amount - check it by hand.'; return out; }
    out.need = [d.num].concat(d.den ? [d.den] : []).filter(function (k) { return inp[k] === null; });
    if (out.need.length) {
      out.status = 'missing';
      out.headroom = 'Enter ' + out.need.map(function (k) { return FIELD[k].short; }).join(' and ') + ' to check this.';
      return out;
    }
    var N = inp[d.num];
    var numF = FIELD[d.num], denF = d.den ? FIELD[d.den] : null;

    if (!isRatio) {
      var T = Math.round(t.value * 100);
      var ok = min ? (strict ? N > T : N >= T) : (strict ? N < T : N <= T);
      var room = min ? N - T - (strict ? 1 : 0) : T - N - (strict ? 1 : 0);
      out.value = N;
      out.valueText = money(N, true);
      out.formula = cap(numF.short) + ' ' + money(N, true) + ' against a ' + (min ? 'minimum' : 'maximum') + ' of ' + money(T, T % 100 === 0) + '.';
      out.gauge = { value: N, threshold: T, min: min };
      if (!ok) {
        out.status = 'breach';
        out.headroom = cap(numF.short) + ' is ' + shortMoney(min ? T - N + (strict ? 1 : 0) : N - T + (strict ? 1 : 0)) + (min ? ' short of' : ' over') + ' what the covenant allows.';
        return out;
      }
      out.status = (min ? N * 10 < T * 11 : N * 10 > T * 9) ? 'tight' : 'pass';
      out.headroom = min
        ? cap(numF.short) + ' could fall by ' + roomMoney(room) + pct(room, N) + ' before it ' + (strict ? 'reaches' : 'drops below') + ' the ' + money(T, T % 100 === 0) + ' minimum.'
        : cap(numF.short) + ' could rise by ' + roomMoney(room) + ' before it ' + (strict ? 'reaches' : 'goes over') + ' the ' + money(T, T % 100 === 0) + ' limit.';
      return out;
    }

    var D = inp[d.den];
    // A ratio threshold in thousandths: 1.25x is 1250. A percentage is the
    // same ratio written /100: 300% is 3.0x.
    var Tm = BigInt(Math.round(t.unit === '%' ? t.value * 10 : t.value * 1000));
    if (Tm <= 0n) { out.status = 'cant'; out.headroom = 'The threshold could not be read - check the agreement.'; return out; }
    if (D === 0) {
      out.status = 'cant';
      out.headroom = cap(denF.short) + ' is $0, so ' + d.short + ' can’t be worked out. Check the numbers - or ask your lender how they treat it.';
      return out;
    }
    if (D < 0) {
      out.status = 'cant';
      out.headroom = cap(denF.short) + ' is negative, so ' + d.short + ' can’t be measured. Lenders usually treat that as failing the test - talk to yours before the test date.';
      return out;
    }
    var bN = BigInt(N), bD = BigInt(D);
    var hundredths = Number(min ? bFloor(bN * 100n, bD) : bCeil(bN * 100n, bD));
    out.value = N / D;
    out.valueText = ratioText(hundredths);
    out.formula = cap(numF.short) + ' ' + money(N, true) + ' ÷ ' + denF.short + ' ' + money(D, true) + ' = ' + out.valueText + ' (' + d.formula + ').';
    out.gauge = { value: N / D, threshold: Number(Tm) / 1000, min: min };
    var lhs = bN * 1000n, rhs = Tm * bD;
    var ok2 = min ? (strict ? lhs > rhs : lhs >= rhs) : (strict ? lhs < rhs : lhs <= rhs);
    var tText = trimNum(Number(Tm) / 1000) + 'x';
    if (min) {
      // The least numerator, and the most denominator, that still pass.
      var numMin = strict ? bFloor(Tm * bD, 1000n) + 1n : bCeil(Tm * bD, 1000n);
      var denMax = strict ? bCeil(bN * 1000n, Tm) - 1n : bFloor(bN * 1000n, Tm);
      var room2 = Number(bN - numMin), denRoom = Number(denMax - bD);
      if (!ok2) {
        out.status = 'breach';
        out.headroom = cap(d.short) + ' is under ' + tText + '. ' + cap(numF.short) + ' would need to be ' + shortMoney(-room2) + ' higher' +
          (N > 0 ? ', or ' + denF.short + ' ' + shortMoney(-denRoom) + ' lower' : '') + ', to meet it.';
        return out;
      }
      out.status = lhs * 10n < rhs * 11n ? 'tight' : 'pass';
      out.headroom = cap(numF.short) + ' could fall by ' + roomMoney(room2) + pct(room2, N) + ' before ' + d.short + ' ' + (strict ? 'falls to ' : 'drops below ') + tText + '.';
      out.also = 'Or ' + denF.short + ' could rise by ' + roomMoney(denRoom) + pct(denRoom, D) + '.';
      return out;
    }
    // A maximum: the most numerator, and the least denominator, that pass.
    var numMax = strict ? bCeil(Tm * bD, 1000n) - 1n : bFloor(Tm * bD, 1000n);
    var denMin = strict ? bFloor(bN * 1000n, Tm) + 1n : bCeil(bN * 1000n, Tm);
    var room3 = Number(numMax - bN), denRoom2 = Number(bD - denMin);
    if (!ok2) {
      out.status = 'breach';
      out.headroom = cap(d.short) + ' is over ' + tText + '. ' + (d.num === 'totalDebt'
        ? 'You’d need to pay down ' + shortMoney(-room3) + ' of debt'
        : cap(numF.short) + ' would need to be ' + shortMoney(-room3) + ' lower') + ', or grow ' + denF.short + ' by ' + shortMoney(-denRoom2) + ', to meet it.';
      return out;
    }
    out.status = lhs * 10n > rhs * 9n ? 'tight' : 'pass';
    out.headroom = (d.num === 'totalDebt' ? 'You could add ' + roomMoney(room3) + ' of debt' : cap(numF.short) + ' could rise by ' + roomMoney(room3) + pct(room3, N)) +
      ' before ' + d.short + ' ' + (strict ? 'reaches ' : 'goes above ') + tText + '.';
    out.also = 'Or ' + denF.short + ' could fall by ' + roomMoney(denRoom2) + pct(denRoom2, D) + '.';
    return out;
  }

  var STATUS_LABEL = { pass: 'Comfortable', tight: 'Tight', breach: 'Breach', missing: 'Needs numbers', cant: 'Can’t measure', manual: 'Check by hand' };

  /** Every financial covenant against one period: results plus counts. */
  function health(covenants, inputs) {
    var results = (covenants || []).filter(function (c) { return c.kind === 'financial'; }).map(function (c) { return evaluate(c, inputs); });
    var counts = { pass: 0, tight: 0, breach: 0, missing: 0, cant: 0, manual: 0 };
    results.forEach(function (r) { counts[r.status]++; });
    return { results: results, counts: counts };
  }

  /* ---------------- periods ---------------- */

  var PERIOD_RE = /^(\d{4}) (Q[1-4]|FY)$/;
  function cleanPeriod(p) {
    var s = String(p || '').trim().toUpperCase().replace(/\s+/g, ' ');
    var m = PERIOD_RE.exec(s);
    if (!m) return null;
    var y = Number(m[1]);
    return y >= 1990 && y <= 2100 ? s : null;
  }
  /** Chronological: 2025 Q4 < 2025 FY < 2026 Q1. */
  function periodKey(p) {
    var m = PERIOD_RE.exec(p || '');
    if (!m) return '';
    return m[1] + (m[2] === 'FY' ? '5' : m[2].charAt(1));
  }
  function sortPeriods(list) { return list.slice().sort(function (a, b) { return periodKey(a) < periodKey(b) ? -1 : periodKey(a) > periodKey(b) ? 1 : 0; }); }

  /** A covenant's ratio (or dollars) across saved periods, oldest first,
   *  for the sparkline: [{period, value, status}], skipping periods that
   *  could not be worked out. */
  function history(c, periods) {
    var keys = sortPeriods(Object.keys(periods || {}));
    var out = [];
    keys.forEach(function (k) {
      var r = evaluate(c, (periods[k] || {}).inputs || {});
      if (r.value !== null && ['pass', 'tight', 'breach'].indexOf(r.status) >= 0) out.push({ period: k, value: r.value, status: r.status, text: r.valueText });
    });
    return out;
  }

  /* ---------------- dates and deadlines ---------------- */

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function isoDay(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    var d = new Date(v + 'T00:00:00Z');
    return isNaN(d) || d.toISOString().slice(0, 10) !== v ? null : v;
  }
  function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); }
  /** The last day of a month (1-12): Feb 29 in a leap year. */
  function monthEnd(year, month) {
    var d = new Date(Date.UTC(year, month, 0));
    return d.toISOString().slice(0, 10);
  }
  function fmtDate(iso) {
    var y = iso.slice(0, 4), m = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10));
    return MONTHS[m - 1] + ' ' + d + ', ' + y;
  }
  function cleanFye(v) { var n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 12; }

  /** Period ends of one kind between two dates (inclusive), oldest first. */
  function periodEnds(of, fyeMonth, from, to, exceptFye) {
    var out = [];
    var y0 = Number(from.slice(0, 4)) - 1, y1 = Number(to.slice(0, 4)) + 1;
    for (var y = y0; y <= y1; y++) {
      for (var m = 1; m <= 12; m++) {
        var isFye = m === fyeMonth;
        var isQuarter = ((m - fyeMonth) % 3 + 3) % 3 === 0;
        var take = of === 'month_end' || (of === 'fiscal_year_end' && isFye) || (of === 'quarter_end' && isQuarter && !(exceptFye && isFye));
        if (!take) continue;
        var e = monthEnd(y, m);
        if (e >= from && e <= to) out.push({ end: e, fye: isFye });
      }
    }
    return out;
  }
  var OF_WORDS = { fiscal_year_end: 'fiscal year end', quarter_end: 'quarter end', month_end: 'month end' };

  /**
   * The dated deadlines: every covenant with a due rule, one item per period
   * whose due date falls between today and `days` from now (default a year),
   * soonest first. {id, covId, title, section, due, periodEnd, rule, inDays}.
   */
  function deadlines(covenants, opts) {
    var o = opts || {};
    var today = isoDay(o.today) || new Date().toISOString().slice(0, 10);
    var fye = cleanFye(o.fyeMonth);
    var horizon = addDays(today, Math.max(1, Math.min(800, o.days || 366)));
    var out = [];
    (covenants || []).forEach(function (c) {
      var r = c.dueRule;
      if (!r || DUE_OF.indexOf(r.of) < 0) return;
      var ends = periodEnds(r.of, fye, addDays(today, -(r.daysAfter + 1)), horizon, r.exceptFiscalYearEnd);
      ends.forEach(function (pe) {
        var due = addDays(pe.end, r.daysAfter);
        if (due < today || due > horizon) return;
        out.push({
          id: c.id + '@' + pe.end,
          covId: c.id,
          title: c.title,
          section: c.section || null,
          due: due,
          periodEnd: pe.end,
          rule: r.daysAfter + ' day' + (r.daysAfter === 1 ? '' : 's') + ' after ' + (pe.fye && r.of !== 'month_end' ? 'fiscal year end' : OF_WORDS[r.of]) + ' (' + fmtDate(pe.end) + ')',
          inDays: daysBetween(today, due),
        });
      });
    });
    out.sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : a.title < b.title ? -1 : 1; });
    return out;
  }
  /** The deadlines folded to one row per covenant: its next date, and the
   *  dates after it. A monthly certificate would otherwise fill the list and
   *  hide the annual statements due in April. */
  function nextEach(items) {
    var by = {}, order = [];
    (items || []).forEach(function (it) {
      if (!by[it.covId]) { by[it.covId] = { next: it, later: [] }; order.push(it.covId); } else by[it.covId].later.push(it.due);
    });
    return order.map(function (k) { return by[k]; });
  }
  function inWords(n) {
    if (n === 0) return 'Due today';
    if (n === 1) return 'Tomorrow';
    if (n < 14) return 'In ' + n + ' days';
    if (n < 60) return 'In ' + Math.round(n / 7) + ' weeks';
    return 'In ' + Math.round(n / 30.4) + ' months';
  }

  /* ---------------- the calendar file (RFC 5545) ---------------- */

  /** TEXT escaping: backslash, semicolon, comma, and newlines as \n. */
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
    var out = [], cur = '', len = 0, limit = 75;
    Array.from(line).forEach(function (ch) {
      var l = utf8Len(ch);
      if (len + l > limit) { out.push(cur); cur = ' '; len = 1; limit = 75; }
      cur += ch; len += l;
    });
    out.push(cur);
    return out.join('\r\n');
  }
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
  function stamp(iso) {
    var d = new Date(iso || Date.now());
    if (isNaN(d)) d = new Date();
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  /**
   * The deadlines as an .ics calendar: one all-day event per deadline with a
   * reminder a week before. UIDs come from the loan, the covenant's title and
   * the due date, so importing the file again updates events rather than
   * doubling them.
   */
  function ics(items, opts) {
    var o = opts || {};
    var name = clean(o.name || 'Loan covenants', 80);
    var key = String(o.loanKey || name);
    var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Challenge Lab//Covenant//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsText(name)];
    var dt = stamp(o.now);
    (items || []).forEach(function (it) {
      if (!isoDay(it.due)) return;
      var d = it.due.replace(/-/g, '');
      var next = addDays(it.due, 1).replace(/-/g, '');
      var desc = (it.rule ? 'Due ' + it.rule + '.' : '') + (it.section ? ' Section ' + it.section + '.' : '') + '\nFrom ' + name + '. Your loan agreement is what counts - check the date there.';
      L.push('BEGIN:VEVENT',
        'UID:' + hash(key + '|' + it.title + '|' + it.due) + '@covenant.challenge.strongtechnicalconsulting.com',
        'DTSTAMP:' + dt,
        'DTSTART;VALUE=DATE:' + d,
        'DTEND;VALUE=DATE:' + next,
        'SUMMARY:' + icsText('Due: ' + it.title),
        'DESCRIPTION:' + icsText(desc),
        'TRANSP:TRANSPARENT',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText('Due in a week: ' + it.title), 'TRIGGER:-P7D', 'END:VALARM',
        'END:VEVENT');
    });
    L.push('END:VCALENDAR');
    return L.map(fold).join('\r\n') + '\r\n';
  }
  function icsFilename(name) {
    var s = String(name || 'loan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'loan';
    return s + '-deadlines.ics';
  }

  return {
    LIMITS: LIMITS, KINDS: KINDS, KIND_LABEL: KIND_LABEL, METRICS: METRICS, OPS: OPS, UNITS: UNITS, TESTED: TESTED, TESTED_LABEL: TESTED_LABEL,
    DUE_OF: DUE_OF, CONF: CONF, FIELDS: FIELDS, FIELD: FIELD, METRIC_DEF: METRIC_DEF, STATUS_LABEL: STATUS_LABEL, MONTHS_LONG: MONTHS_LONG,
    clean: clean, normForMatch: normForMatch, matcher: matcher,
    toCents: toCents, money: money, plainMoney: plainMoney, num: num,
    cleanThreshold: cleanThreshold, cleanDueRule: cleanDueRule, cleanCovenant: cleanCovenant, cleanCovenants: cleanCovenants, cleanLoan: cleanLoan,
    isChecked: isChecked, fieldsFor: fieldsFor, cleanInputs: cleanInputs, evaluate: evaluate, health: health,
    thresholdText: thresholdText, chipText: chipText,
    cleanPeriod: cleanPeriod, periodKey: periodKey, sortPeriods: sortPeriods, history: history,
    isoDay: isoDay, addDays: addDays, monthEnd: monthEnd, fmtDate: fmtDate, cleanFye: cleanFye, deadlines: deadlines, nextEach: nextEach, inWords: inWords, trimNum: trimNum,
    icsText: icsText, fold: fold, hash: hash, ics: ics, icsFilename: icsFilename,
  };
}));
