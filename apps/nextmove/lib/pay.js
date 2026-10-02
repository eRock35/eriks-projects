// Posted pay, read out of a job description. Pure and deterministic - no
// model, because a number someone might negotiate against must come from the
// posting's own words, and the same words must always give the same number.
//
//   parsePay('The base salary range is $180,000 - $220,000 per year.')
//     -> { min: 180000, max: 220000, currency: 'USD', period: 'year',
//          annualMin: 180000, annualMax: 220000, ranges: 1, text: '$180,000 - $220,000' }
//
// What it reads: "$180,000 - $220,000", "$180K–$220K", "USD 150K-190K",
// "150,000 to 190,000 USD", "$85/hr", "$40.50 - $55.25 per hour",
// "up to $200,000", "starting at $120,000", "€70.000 - €90.000",
// "CA$150,000 - CA$170,000", "£55k-£65k". Several ranges (by city or by
// level) become one envelope - lowest minimum, highest maximum - in the most
// common currency and period, with `ranges` saying how many there were.
//
// What it refuses: bonuses, stipends, 401(k), funding rounds and revenue
// ("raised $50M", "$2 billion"), single figures with no salary words around
// them, and anything outside a plausible pay band for its period. When in
// doubt it returns null: no pay is better than wrong pay.

const CURRENCY_SYMBOL = [
  ['CA$', 'CAD'], ['C$', 'CAD'], ['A$', 'AUD'], ['AU$', 'AUD'], ['NZ$', 'NZD'], ['S$', 'SGD'], ['HK$', 'HKD'], ['US$', 'USD'],
  ['$', 'USD'], ['€', 'EUR'], ['£', 'GBP'], ['¥', 'JPY'], ['₹', 'INR'],
];
const CODES = ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD', 'SGD', 'HKD', 'JPY', 'INR', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'ILS'];

// Plausible pay per period, in the posting's own currency units. Wide on
// purpose (JPY and INR are big numbers); what it catches is "$5" and "$50M".
const BOUNDS = {
  hour: [7, 1000],
  week: [200, 40000],
  month: [800, 200000],
  year: [10000, 5000000],
};
const BIG_CURRENCY = new Set(['JPY', 'INR']);
const PER_YEAR = { hour: 2080, week: 52, month: 12, year: 1 };

const SYM_RE = '(?:CA\\$|C\\$|AU\\$|A\\$|NZ\\$|S\\$|HK\\$|US\\$|\\$|€|£|¥|₹)';
const CODE_RE = `(?:${CODES.join('|')})`;
const NUM_RE = '\\d{1,3}(?:[,.\\s]\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?';
// One amount: optional currency (symbol or code) before, the number, an
// optional K, optional currency code after.
const AMOUNT = `(?:(${CODE_RE})\\s?)?(${SYM_RE})?\\s?(${NUM_RE})\\s?([kK](?![a-zA-Z]))?(?:\\s?(${CODE_RE})\\b)?`;
const DASH = '\\s*(?:-|–|—|to|and)\\s*';
const RANGE_RE = new RegExp(`${AMOUNT}${DASH}${AMOUNT}`, 'g');
const SINGLE_RE = new RegExp(`(up to|starting (?:at|from)|from|as much as|minimum of|at least)\\s+${AMOUNT}`, 'gi');
const PERIOD_SINGLE_RE = new RegExp(`${AMOUNT}\\s*(?:\\/\\s?|per\\s+|an?\\s+)(hour|hr|year|yr|annum|month|mo|week|wk)\\b`, 'gi');

const JUNK_BEFORE = /(bonus|signing|sign-on|relocation|stipend|reimburs|allowance|401|match|equity|stock|rsu|raised|funding|series [a-f]|valuation|revenue|arr\b|budget|grant|award|donat|fee|deposit|credit|tuition|fund\b|assets|aum)/i;
const JUNK_AFTER = /^\s*(million|billion|mm\b|bn\b|m\b|b\b|in (funding|revenue|assets)|bonus|signing|stipend|equity|in stock|per (employee|month stipend)|annual bonus|relocation)/i;
const PAY_WORDS = /(salary|pay|compensation|base|wage|rate|range|ote|earn|annual|hourly|per hour|per year|\/hr|\/yr|\/hour|\/year)/i;

function currencyOf(symbol, codeBefore, codeAfter) {
  if (codeBefore) return codeBefore.toUpperCase();
  if (codeAfter) return codeAfter.toUpperCase();
  if (symbol) {
    for (const [s, c] of CURRENCY_SYMBOL) if (s === symbol) return c;
  }
  return null;
}

/** "180,000" -> 180000; "70.000" (EUR thousands) -> 70000; "40.50" -> 40.5. */
function readNumber(s) {
  let t = String(s).replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');          // 70.000
  else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); // 70.000,50
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function amountFrom(m, i) {
  // groups: codeBefore, symbol, number, k, codeAfter
  const n = readNumber(m[i + 2]);
  if (n === null) return null;
  return { value: m[i + 3] ? n * 1000 : n, hasK: Boolean(m[i + 3]), currency: currencyOf(m[i + 1], m[i], m[i + 4]), marked: Boolean(m[i] || m[i + 1] || m[i + 4]) };
}

function periodAfter(text, from) {
  const tail = text.slice(from, from + 40).toLowerCase();
  if (/^[\s,.)]*(?:\/\s?|per\s+|an?\s+|\s)(hour|hr)\b|^[\s,.)]*hourly/.test(tail)) return 'hour';
  if (/^[\s,.)]*(?:\/\s?|per\s+|an?\s+)(week|wk)\b|^[\s,.)]*weekly/.test(tail)) return 'week';
  if (/^[\s,.)]*(?:\/\s?|per\s+|an?\s+)(month|mo)\b|^[\s,.)]*monthly/.test(tail)) return 'month';
  if (/^[\s,.)]*(?:\/\s?|per\s+|an?\s+)(year|yr|annum)\b|^[\s,.)]*(annually|annual|yearly|per annum)/.test(tail)) return 'year';
  return null;
}
function periodBefore(text, at) {
  const head = text.slice(Math.max(0, at - 60), at).toLowerCase();
  if (/hourly|per hour|hourly rate|pay rate/.test(head)) return 'hour';
  if (/annual|yearly|per year|salary/.test(head)) return 'year';
  return null;
}
function guessPeriod(value, currency) {
  if (BIG_CURRENCY.has(currency)) return value >= 1000000 ? 'year' : value >= 100000 ? 'month' : 'hour';
  if (value < 1000) return 'hour';
  if (value >= 10000) return 'year';
  return null;
}

function plausible(min, max, period, currency) {
  const b = BOUNDS[period];
  if (!b) return false;
  const k = BIG_CURRENCY.has(currency) ? 150 : 1;
  const lo = b[0] * k;
  const hi = b[1] * k;
  if (min !== null && (min < lo || min > hi)) return false;
  if (max !== null && (max < lo || max > hi)) return false;
  if (min !== null && max !== null && (max < min || max > min * 4)) return false;
  return true;
}

function sentenceBefore(text, at) {
  const head = text.slice(Math.max(0, at - 80), at);
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('\n'), head.lastIndexOf('; '));
  return cut >= 0 ? head.slice(cut + 1) : head;
}

/** Every pay range in the text, in order, each validated on its own. */
function findRanges(text) {
  const out = [];
  const taken = [];
  const overlaps = (a, b) => taken.some(([x, y]) => a < y && b > x);
  RANGE_RE.lastIndex = 0;
  let m;
  while ((m = RANGE_RE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    const a = amountFrom(m, 1);
    const b = amountFrom(m, 6);
    if (!a || !b) continue;
    // "150K-190K" is 150000-190000; "150-190K" means the same.
    if (b.hasK && !a.hasK && a.value < 1000) a.value *= 1000;
    if (!a.marked && !b.marked) {
      // Two bare numbers are a range only with pay words close by.
      if (!PAY_WORDS.test(sentenceBefore(text, start)) && !periodAfter(text, end)) continue;
    }
    const before = sentenceBefore(text, start);
    if (JUNK_BEFORE.test(before.slice(-45))) continue;
    if (JUNK_AFTER.test(text.slice(end, end + 30))) continue;
    // Years ("2019 - 2024") and the like are not money.
    if (!a.marked && !b.marked && a.value >= 1900 && a.value <= 2100 && b.value >= 1900 && b.value <= 2100) continue;
    const currency = a.currency || b.currency || 'USD';
    const period = periodAfter(text, end) || periodBefore(text, start) || guessPeriod(Math.max(a.value, b.value), currency);
    if (!period) continue;
    const min = Math.min(a.value, b.value);
    const max = Math.max(a.value, b.value);
    if (!plausible(min, max, period, currency)) continue;
    out.push({ min, max, currency, period, at: start, text: m[0].trim() });
    taken.push([start, end]);
  }
  SINGLE_RE.lastIndex = 0;
  while ((m = SINGLE_RE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(start, end)) continue;
    const a = amountFrom(m, 2);
    if (!a || !a.marked) continue;
    const before = sentenceBefore(text, start);
    if (JUNK_BEFORE.test(before.slice(-45)) || JUNK_AFTER.test(text.slice(end, end + 30))) continue;
    if (!PAY_WORDS.test(before + text.slice(end, end + 30))) continue;
    const currency = a.currency || 'USD';
    const period = periodAfter(text, end) || periodBefore(text, start) || guessPeriod(a.value, currency);
    if (!period) continue;
    const upTo = /up to|as much as/i.test(m[1]);
    const min = upTo ? null : a.value;
    const max = upTo ? a.value : null;
    if (!plausible(min, max, period, currency)) continue;
    out.push({ min, max, currency, period, at: start, text: m[0].trim() });
    taken.push([start, end]);
  }
  PERIOD_SINGLE_RE.lastIndex = 0;
  while ((m = PERIOD_SINGLE_RE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(start, end)) continue;
    const a = amountFrom(m, 1);
    if (!a || !a.marked) continue;
    const before = sentenceBefore(text, start);
    if (JUNK_BEFORE.test(before.slice(-45))) continue;
    const unit = m[6].toLowerCase();
    const period = unit.startsWith('h') ? 'hour' : unit.startsWith('w') ? 'week' : unit.startsWith('mo') ? 'month' : 'year';
    const currency = a.currency || 'USD';
    if (!plausible(a.value, a.value, period, currency)) continue;
    out.push({ min: a.value, max: a.value, currency, period, at: start, text: m[0].trim() });
    taken.push([start, end]);
  }
  return out.sort((x, y) => x.at - y.at);
}

/**
 * The posting's pay, or null.
 * @returns {min, max, currency, period, annualMin, annualMax, ranges, text}
 */
function parsePay(text) {
  if (typeof text !== 'string' || !text) return null;
  const ranges = findRanges(text.slice(0, 40000));
  if (!ranges.length) return null;
  // The most common currency, then period, among what was found.
  const count = (key) => {
    const c = {};
    for (const r of ranges) c[r[key]] = (c[r[key]] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
  };
  const currency = count('currency');
  const period = count('period');
  const same = ranges.filter((r) => r.currency === currency && r.period === period);
  const mins = same.map((r) => r.min).filter((v) => v !== null);
  const maxs = same.map((r) => r.max).filter((v) => v !== null);
  const min = mins.length ? Math.min(...mins) : null;
  const max = maxs.length ? Math.max(...maxs) : null;
  return withAnnual({ min, max, currency, period, ranges: same.length, text: same[0].text.slice(0, 80) });
}

function withAnnual(p) {
  const k = PER_YEAR[p.period] || null;
  const round = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
  return {
    ...p,
    min: round(p.min),
    max: round(p.max),
    annualMin: k && p.min !== null ? Math.round(p.min * k) : null,
    annualMax: k && p.max !== null ? Math.round(p.max * k) : null,
  };
}

/** Ashby's structured compensation (includeCompensation=true), or null. */
function fromAshby(comp) {
  if (!comp || typeof comp !== 'object') return null;
  const comps = [];
  for (const c of [].concat(comp.summaryComponents || [], ...(comp.compensationTiers || []).map((t) => t.components || []))) {
    if (c && /salary|hourly/i.test(String(c.compensationType || '')) && (Number.isFinite(c.minValue) || Number.isFinite(c.maxValue))) comps.push(c);
  }
  if (!comps.length) return null;
  const c0 = comps[0];
  const interval = String(c0.interval || '').toUpperCase();
  const period = /HOUR/.test(interval) ? 'hour' : /WEEK/.test(interval) ? 'week' : /MONTH/.test(interval) ? 'month' : /YEAR/.test(interval) ? 'year' : null;
  if (!period) return null;
  const currency = /^[A-Z]{3}$/.test(String(c0.currencyCode || '')) ? c0.currencyCode : 'USD';
  const same = comps.filter((c) => String(c.interval || '').toUpperCase() === interval && (c.currencyCode || 'USD') === currency);
  const mins = same.map((c) => c.minValue).filter(Number.isFinite);
  const maxs = same.map((c) => c.maxValue).filter(Number.isFinite);
  const min = mins.length ? Math.min(...mins) : null;
  const max = maxs.length ? Math.max(...maxs) : null;
  if (!plausible(min, max, period, currency)) return null;
  return withAnnual({ min, max, currency, period, ranges: same.length, text: String(comp.compensationTierSummary || '').slice(0, 80) });
}

/** Lever's salaryRange ({min, max, currency, interval}), or null. */
function fromLever(r) {
  if (!r || typeof r !== 'object') return null;
  const interval = String(r.interval || '');
  const period = /hour/.test(interval) ? 'hour' : /week/.test(interval) ? 'week' : /month/.test(interval) ? 'month' : /year|annual/.test(interval) ? 'year' : null;
  const min = Number.isFinite(r.min) ? r.min : null;
  const max = Number.isFinite(r.max) ? r.max : null;
  const currency = /^[A-Z]{3}$/.test(String(r.currency || '')) ? r.currency : 'USD';
  if (!period || (min === null && max === null) || !plausible(min, max, period, currency)) return null;
  return withAnnual({ min, max, currency, period, ranges: 1, text: '' });
}

/** A wage figure and its unit (LCA's WAGE_UNIT_OF_PAY) as annual, or null. */
function annualise(value, unit) {
  const n = typeof value === 'number' ? value : readNumber(String(value || '').replace(/[$\s]/g, ''));
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  const u = String(unit || '').toLowerCase().replace(/[^a-z]/g, '');
  const k = { hour: 2080, week: 52, biweekly: 26, month: 12, year: 1 }[u];
  if (!k) return null;
  return Math.round(n * k * 100) / 100;
}

module.exports = { parsePay, findRanges, fromAshby, fromLever, annualise, readNumber, PER_YEAR };
