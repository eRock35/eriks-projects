// The book: invoices, clients and the arithmetic that turns them into "who to
// chase today".
//
// Everything here is a pure function of stored data and a date. Nothing is a
// counter: balances, statuses, broken promises, grades, streaks and the
// forecast are all recomputed on every read, because a counter drifts the
// first time something is edited or deleted, and a wrong balance on a money
// app is the one bug nobody forgives.
//
// Money is integer cents. Dates are ISO days ("2026-09-24"). A day is a UTC
// calendar day; the page sends its own local "today" so a freelancer in
// Sydney is not told an invoice is late a day early (see todayFrom()).

const DAY = 86400000;

const LIMITS = {
  cents: 10_000_000_000, // $100M: a typo guard, not a business limit
  invoices: 500,
  clients: 200,
  payments: 60,
  chases: 60,
  promises: 20,
};

// Every one of these has two decimal places, so "cents" is literally cents.
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'SGD', 'INR', 'ZAR', 'MXN', 'BRL'];

/* ------------------------------------------------------------------ *
 * Cleaning
 * ------------------------------------------------------------------ */

function clean(v, max = 400) {
  return String(v == null ? '' : v)
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Same, but keeps line breaks and collapses runs of blank lines. */
function cleanText(v, max = 2000) {
  return String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
function cleanEmail(v) {
  const s = clean(v, 120).toLowerCase();
  return EMAIL_RE.test(s) ? s : '';
}
function cleanPhone(v) {
  const s = String(v == null ? '' : v).replace(/[^0-9+()\-. ]/g, '').trim().slice(0, 24);
  return (s.match(/\d/g) || []).length >= 7 ? s : '';
}
/** https only. A payment link is drawn as a link on a page a stranger opens,
 *  so `javascript:` or plain http is not something to pass along. */
function cleanUrl(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 300);
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !/[<>"'\s]/.test(s) ? u.href : '';
  } catch (e) { return ''; }
}

/**
 * Money in, integer cents out - or null when there is no amount at all.
 *
 * "1,250.50" and "$1250.5" are 125050; "about 40" is 4000; "free", "" and
 * "n/a" are null, never 0 (`Number("")` is 0, which is how "free" once became
 * $0.00 in trip-planner's budget). Negative numbers are refused rather than
 * stripped: "-40" is not forty dollars owed.
 */
function toCents(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return null;
    return Math.min(LIMITS.cents, Math.round(v * 100));
  }
  const s = String(v).trim();
  if (/^\(|^-|\s-\d/.test(s)) return null;
  const m = s.replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  if (!Number.isFinite(n)) return null;
  return Math.min(LIMITS.cents, Math.round(n * 100));
}

/** Integer cents given directly (the page sends these), or parsed from an
 *  amount string. */
function centsFrom(body, centsKey, amountKey) {
  const c = body[centsKey];
  if (Number.isInteger(c) && c >= 0) return Math.min(LIMITS.cents, c);
  return toCents(body[amountKey]);
}

function isoDay(v) {
  const s = String(v == null ? '' : v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + 'T00:00:00Z');
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10) === s ? s : null;
}
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
/** Whole days from a to b: positive when b is later. */
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const utcToday = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** The page's own date if it is plausible (within a day of UTC, which covers
 *  every timezone), else UTC's. */
function todayFrom(v, now = Date.now()) {
  const u = utcToday(now);
  const d = isoDay(v);
  return d && Math.abs(daysBetween(u, d)) <= 1 ? d : u;
}

function currencyOf(v, dflt = 'USD') {
  const s = String(v || '').toUpperCase().trim();
  return CURRENCIES.includes(s) ? s : dflt;
}

function fmtMoney(cents, currency = 'USD') {
  const n = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
  } catch (e) { return `${currency} ${n.toFixed(2)}`; }
}
function fmtDay(iso, withWeekday = false) {
  if (!iso) return '';
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(withWeekday ? { weekday: 'short' } : {}) });
}

/* ------------------------------------------------------------------ *
 * Settings: the voice every chase is written in, and the late-fee policy
 * ------------------------------------------------------------------ */

const SETTINGS_DEFAULTS = {
  businessName: '',
  yourName: '',
  signOff: 'Thanks,',
  tone: 35, // 0 = warm and friendly, 100 = direct and firm
  paymentLink: '',
  paymentInstructions: '',
  contact: '', // what a statement shows about how to reach you - nothing else is shown
  currency: 'USD',
  termsDays: 30,
  lateFee: { mode: 'none', flatCents: 2500, pctPerMonth: 1.5, graceDays: 7 },
};

function clampNum(v, lo, hi, dflt, dp = 0) {
  let n = typeof v === 'string' ? Number(v.replace(/[%$,\s]/g, '')) : Number(v);
  if (!Number.isFinite(n)) n = dflt;
  const f = 10 ** dp;
  return Math.round(Math.max(lo, Math.min(hi, n)) * f) / f;
}

function cleanSettings(raw, prev = SETTINGS_DEFAULTS) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const p = { ...SETTINGS_DEFAULTS, ...prev, lateFee: { ...SETTINGS_DEFAULTS.lateFee, ...(prev.lateFee || {}) } };
  const lf = b.lateFee && typeof b.lateFee === 'object' ? b.lateFee : {};
  const lfHas = (k) => Object.prototype.hasOwnProperty.call(lf, k);
  const flat = lfHas('flatCents') || lfHas('flat') ? centsFrom(lf, 'flatCents', 'flat') : p.lateFee.flatCents;
  return {
    businessName: has('businessName') ? clean(b.businessName, 80) : p.businessName,
    yourName: has('yourName') ? clean(b.yourName, 60) : p.yourName,
    signOff: has('signOff') ? clean(b.signOff, 60) : p.signOff,
    tone: has('tone') ? clampNum(b.tone, 0, 100, 35) : p.tone,
    paymentLink: has('paymentLink') ? cleanUrl(b.paymentLink) : p.paymentLink,
    paymentInstructions: has('paymentInstructions') ? cleanText(b.paymentInstructions, 400) : p.paymentInstructions,
    contact: has('contact') ? clean(b.contact, 120) : p.contact,
    currency: has('currency') ? currencyOf(b.currency, p.currency) : p.currency,
    termsDays: has('termsDays') ? clampNum(b.termsDays, 0, 180, 30) : p.termsDays,
    lateFee: {
      mode: lfHas('mode') ? (['none', 'flat', 'percent'].includes(lf.mode) ? lf.mode : 'none') : p.lateFee.mode,
      flatCents: Math.min(1_000_000, flat == null ? p.lateFee.flatCents : flat),
      pctPerMonth: lfHas('pctPerMonth') ? clampNum(lf.pctPerMonth, 0, 10, 1.5, 2) : p.lateFee.pctPerMonth,
      graceDays: lfHas('graceDays') ? clampNum(lf.graceDays, 0, 90, 7) : p.lateFee.graceDays,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Clients and invoices: what the page may write
 * ------------------------------------------------------------------ */

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function cleanClient(raw, prev = {}) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const name = has('name') ? clean(b.name, 80) : (prev.name || '');
  if (!name) throw httpError(400, 'A client needs a name.');
  if (has('email') && clean(b.email) && !cleanEmail(b.email)) throw httpError(400, 'That email address does not look right.');
  if (has('phone') && clean(b.phone) && !cleanPhone(b.phone)) throw httpError(400, 'That phone number does not look right.');
  return {
    name,
    // The person you actually deal with. Chases greet them by first name;
    // without one they greet the business.
    contactName: has('contactName') ? clean(b.contactName, 60) : (prev.contactName || ''),
    email: has('email') ? cleanEmail(b.email) : (prev.email || ''),
    phone: has('phone') ? cleanPhone(b.phone) : (prev.phone || ''),
    notes: has('notes') ? cleanText(b.notes, 600) : (prev.notes || ''),
  };
}

/** "Net 30", "net-14", "30 days" -> 30. "Due on receipt" -> 0. */
function termsDaysOf(terms) {
  const s = String(terms || '').toLowerCase();
  if (/receipt|immediate/.test(s)) return 0;
  const m = s.match(/(\d{1,3})/);
  return m ? Math.min(180, Number(m[1])) : null;
}

/**
 * The editable facts of an invoice. Payments, promises, chases and the stage
 * are never taken from here - they have their own routes, so the page cannot
 * "edit" an invoice into paid.
 */
function cleanInvoice(raw, prev = null, settings = SETTINGS_DEFAULTS, today = utcToday()) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const p = prev || {};
  let amountCents = p.amountCents;
  if (!prev || has('amount') || has('amountCents')) {
    amountCents = centsFrom(b, 'amountCents', 'amount');
    if (!amountCents) throw httpError(400, 'Add the amount - a number like 1,250.00.');
  }
  const issued = has('issued') ? isoDay(b.issued) : (p.issued || null);
  if (has('issued') && b.issued && !issued) throw httpError(400, 'The issue date is not a real date.');
  const iss = issued || today;
  const terms = has('terms') ? clean(b.terms, 40) : (p.terms || '');
  let due = has('due') ? isoDay(b.due) : (p.due || null);
  if (has('due') && b.due && !due) throw httpError(400, 'The due date is not a real date.');
  if (!due) {
    const td = termsDaysOf(terms);
    due = addDays(iss, td == null ? settings.termsDays : td);
  }
  if (daysBetween(iss, due) < 0) throw httpError(400, 'The due date is before the issue date.');
  const paid = sumPayments(p);
  if (prev && amountCents < paid) throw httpError(400, `Payments of ${fmtMoney(paid, p.currency)} are already logged - the amount cannot be less than that.`);
  return {
    number: has('number') ? clean(b.number, 40) : (p.number || ''),
    amountCents,
    currency: has('currency') ? currencyOf(b.currency, settings.currency) : (p.currency || settings.currency),
    issued: iss,
    due,
    terms: terms || `Net ${daysBetween(iss, due)}`,
    notes: has('notes') ? cleanText(b.notes, 1000) : (p.notes || ''),
  };
}

function sumPayments(inv) {
  return (inv.payments || []).reduce((a, x) => a + (Number(x.cents) || 0), 0);
}

/** When the balance first reached zero: the date of the payment that cleared
 *  it, walking payments in date order. */
function paidAtOf(inv) {
  let left = inv.amountCents;
  const ps = [...(inv.payments || [])].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const x of ps) {
    left -= x.cents;
    if (left <= 0) return x.date;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The ladder
 * ------------------------------------------------------------------ */

const STAGES = [
  { key: 'nudge', label: 'Friendly nudge', short: 'Nudge', gapAfter: 5 },
  { key: 'followup', label: 'Follow-up', short: 'Follow-up', gapAfter: 7 },
  { key: 'firm', label: 'Firm reminder', short: 'Firm', gapAfter: 7 },
  { key: 'final', label: 'Final notice', short: 'Final', gapAfter: 7 },
];
const SIDE = {
  plan: { key: 'plan', label: 'Payment plan offer', short: 'Plan', gapAfter: 7 },
};
const KINDS = [...STAGES.map((s) => s.key), 'plan'];
const kindInfo = (k) => STAGES.find((s) => s.key === k) || SIDE[k] || null;

/** What "Chase" should write next. */
function nextKind(inv) {
  const stage = Math.max(0, Math.min(STAGES.length, Number(inv.stage) || 0));
  if (stage < STAGES.length) return STAGES[stage].key;
  // The ladder is climbed. Offer a plan, then (if that too is ignored) the
  // final notice again.
  const last = (inv.chases || [])[inv.chases.length - 1];
  return last && last.kind === 'plan' ? 'final' : 'plan';
}

/* ------------------------------------------------------------------ *
 * Deriving an invoice's state
 * ------------------------------------------------------------------ */

function promiseBroken(p, balanceCents, paidAt, today) {
  if (!p || !p.date || p.date >= today) return false;
  if (balanceCents > 0) return true;
  return Boolean(paidAt && paidAt > p.date);
}

/**
 * Everything the page and the ranking need, from what is stored.
 * @returns the invoice plus: paidCents, balanceCents, status, daysLate,
 *          overdue, promise (current), promiseBroken, brokenPromises,
 *          paidAt, stageLabel, nextKind, chaseDue, nextChaseOn
 */
function derive(inv, today) {
  const paidCents = sumPayments(inv);
  const balanceCents = Math.max(0, inv.amountCents - paidCents);
  const paidAt = balanceCents === 0 ? paidAtOf(inv) : null;
  const promises = inv.promises || [];
  const current = promises.length ? promises[promises.length - 1] : null;
  const brokenPromises = promises.filter((p) => promiseBroken(p, balanceCents, paidAt, today)).length;
  const keptPromises = promises.filter((p) => paidAt && p.date >= paidAt).length;
  const daysLate = daysBetween(inv.due, today);

  let status = 'open';
  if (inv.writtenOff) status = 'written_off';
  else if (balanceCents === 0) status = 'paid';
  else if (current && current.date >= today) status = 'promised';

  const live = status === 'open' || status === 'promised';
  const currentBroken = live && current ? promiseBroken(current, balanceCents, paidAt, today) : false;
  const stage = Math.max(0, Math.min(STAGES.length, Number(inv.stage) || 0));
  const kind = nextKind(inv);
  const lastDay = inv.lastChasedAt ? inv.lastChasedAt.slice(0, 10) : null;
  const lastKind = (inv.chases || []).length ? inv.chases[inv.chases.length - 1].kind : null;
  const gap = lastKind ? (kindInfo(lastKind) || STAGES[0]).gapAfter : 0;
  const nextChaseOn = lastDay ? addDays(lastDay, gap) : null;

  // Due for a chase: late, not waiting on a promise, not paused, and either
  // never chased, chased long enough ago, or a promise broke since.
  let chaseDue = false;
  if (status === 'open' && !inv.paused && daysLate >= 1) {
    if (!lastDay || nextChaseOn <= today) chaseDue = true;
    else if (currentBroken && current.date >= lastDay) chaseDue = true;
  }

  // When the next chase becomes due, if it is not due now.
  let waitUntil = null;
  if (status === 'open' && !inv.paused && !chaseDue) {
    if (daysLate < 1) waitUntil = addDays(inv.due, 1);
    else if (nextChaseOn && nextChaseOn > today) waitUntil = nextChaseOn;
  }

  return {
    ...inv,
    paidCents,
    balanceCents,
    paidAt,
    status,
    daysLate,
    overdue: live && daysLate > 0,
    promise: current,
    promiseBroken: currentBroken,
    brokenPromises,
    keptPromises,
    stage,
    stageLabel: stage === 0 ? 'Not chased yet' : `${STAGES[stage - 1].label} sent`,
    nextKind: kind,
    nextLabel: kindInfo(kind).label,
    chaseDue,
    nextChaseOn: waitUntil,
  };
}

/**
 * How urgent. Money times time is the core: a $5,000 invoice 45 days late
 * outranks a $200 one 3 days late by three orders of magnitude, which is the
 * point. Each broken promise multiplies it, because someone who said "Friday"
 * and didn't is the person most likely to keep sliding.
 */
function scoreOf(d) {
  if (d.status !== 'open' && d.status !== 'promised') return 0;
  const dollars = d.balanceCents / 100;
  const late = Math.max(0, d.daysLate);
  return Math.round(dollars * (late + 1) * (1 + 0.6 * d.brokenPromises));
}

function whyOf(d) {
  const out = [];
  if (d.promiseBroken) out.push(`Promised ${fmtDay(d.promise.date, true)} — didn't pay`);
  else if (d.brokenPromises) out.push(`${d.brokenPromises} broken promise${d.brokenPromises > 1 ? 's' : ''}`);
  if (d.daysLate > 0) out.push(`${d.daysLate} day${d.daysLate === 1 ? '' : 's'} late`);
  else if (d.daysLate === 0) out.push('Due today');
  else out.push(`Due in ${-d.daysLate} day${d.daysLate === -1 ? '' : 's'}`);
  if (d.partial) out.push('part paid');
  return out;
}

function row(d, clientsById) {
  const c = clientsById[d.clientId] || {};
  return {
    id: d.id,
    number: d.number,
    client: { id: d.clientId, name: c.name || 'Unknown client' },
    amountCents: d.amountCents,
    balanceCents: d.balanceCents,
    paidCents: d.paidCents,
    currency: d.currency,
    issued: d.issued,
    due: d.due,
    daysLate: d.daysLate,
    status: d.status,
    paused: Boolean(d.paused),
    stage: d.stage,
    stageLabel: d.stageLabel,
    nextKind: d.nextKind,
    nextLabel: d.nextLabel,
    promise: d.promise ? { date: d.promise.date } : null,
    promiseBroken: d.promiseBroken,
    brokenPromises: d.brokenPromises,
    lastChasedAt: d.lastChasedAt || null,
    nextChaseOn: d.nextChaseOn,
    chaseDue: d.chaseDue,
    paidAt: d.paidAt,
    score: scoreOf(d),
    why: whyOf({ ...d, partial: d.paidCents > 0 && d.balanceCents > 0 }),
  };
}

/* ------------------------------------------------------------------ *
 * History: per client
 * ------------------------------------------------------------------ */

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
}

/** The rung a paid invoice was paid after: ladder chases logged on or before
 *  the day it was cleared. */
function rungAtPayment(d) {
  return (d.chases || []).filter((c) => STAGES.some((s) => s.key === c.kind) && c.at.slice(0, 10) <= d.paidAt).length;
}

const STYLE_NOTES = [
  'Pays without being chased — a friendly reminder on the due date is plenty.',
  'Usually pays after a friendly nudge.',
  'Usually pays after the follow-up — send it on time rather than waiting.',
  'Only moves at the firm reminder — start there next time.',
  'Has needed a final notice — be firm early, and consider asking for a deposit.',
];

function mainCurrency(ds, dflt) {
  const n = {};
  for (const d of ds) n[d.currency] = (n[d.currency] || 0) + 1;
  const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : dflt;
}

/**
 * A client's scorecard, from their invoices (already derived).
 *
 * The grade is points out of 100, less: half a point per day late on
 * average (up to 35), up to 15 for how rarely they pay on time, half a
 * point per day they are late right now (up to 30), 10 per broken promise (up
 * to 30) and 25 per written-off invoice (up to 50). Nobody without a paid
 * invoice scores above 85 (a B), and a client with no history at all has no
 * grade - "New" is more honest than an A they have not earned.
 * A >= 90, B >= 80, C >= 65, D >= 50, F below.
 */
function scorecard(client, ds, dflt = 'USD') {
  const currency = mainCurrency(ds, dflt);
  const mine = ds.filter((d) => d.currency === currency);
  const paid = ds.filter((d) => d.status === 'paid' && d.paidAt);
  const lates = paid.map((d) => Math.max(0, daysBetween(d.due, d.paidAt)));
  const avgDaysLate = lates.length ? Math.round((lates.reduce((a, b) => a + b, 0) / lates.length) * 10) / 10 : null;
  const onTimePct = lates.length ? Math.round((100 * lates.filter((l) => l === 0).length) / lates.length) : null;
  const live = mine.filter((d) => d.status === 'open' || d.status === 'promised');
  const outstandingCents = live.reduce((a, d) => a + d.balanceCents, 0);
  const overdueCents = live.filter((d) => d.daysLate > 0).reduce((a, d) => a + d.balanceCents, 0);
  const maxDaysLate = live.reduce((a, d) => Math.max(a, d.daysLate), 0);
  const brokenPromises = ds.reduce((a, d) => a + d.brokenPromises, 0);
  const writtenOff = ds.filter((d) => d.status === 'written_off').length;
  const totalPaidCents = mine.reduce((a, d) => a + d.paidCents, 0);

  let points = 100;
  if (lates.length) {
    points -= Math.min(35, avgDaysLate / 2);
    points -= (100 - onTimePct) * 0.15;
  }
  points -= Math.min(30, Math.max(0, maxDaysLate) / 2);
  points -= Math.min(30, 10 * brokenPromises);
  points -= Math.min(50, 25 * writtenOff);
  // An A is earned by paying, not by being new and a little late.
  if (!lates.length) points = Math.min(points, 85);
  points = Math.max(0, Math.round(points * 10) / 10);
  const hasHistory = lates.length || maxDaysLate > 0 || brokenPromises || writtenOff;
  const grade = !hasHistory ? null : points >= 90 ? 'A' : points >= 80 ? 'B' : points >= 65 ? 'C' : points >= 50 ? 'D' : 'F';

  const rungs = paid.map(rungAtPayment);
  const m = median(rungs);
  const style = m == null ? 'Not enough history yet — start with a friendly nudge.' : STYLE_NOTES[Math.min(4, m)];

  return {
    id: client.id,
    name: client.name,
    contactName: client.contactName || '',
    email: client.email || '',
    phone: client.phone || '',
    notes: client.notes || '',
    currency,
    invoices: ds.length,
    paidCount: paid.length,
    openCount: live.length,
    avgDaysLate,
    onTimePct,
    totalPaidCents,
    outstandingCents,
    overdueCents,
    maxDaysLate: Math.max(0, maxDaysLate),
    brokenPromises,
    writtenOff,
    points: hasHistory ? points : null,
    grade,
    style,
    styleRung: m,
    // What is at stake with this client, weighted by how they pay. Sorts the
    // client list: a C with $8,000 open is a bigger worry than an F with $90.
    riskCents: Math.round(outstandingCents * (100 - (hasHistory ? points : 85)) / 100),
  };
}

/* ------------------------------------------------------------------ *
 * The forecast
 * ------------------------------------------------------------------ */

/**
 * The next four weeks of cash, from what is due and how each client pays.
 *
 * Each open invoice gets an expected date and a likelihood:
 *   - a live promise: its date, 0.85 less 0.1 per broken promise
 *   - otherwise: due date + the client's average days late (or the book's
 *     average, or 7 with no history at all). Paid clients start at
 *     0.95 - 0.005 x average days late (0.5..0.95); new clients at 0.75.
 *   - already later than that: a week from today, because it needs a chase
 *   - 60+ days late: x0.75; 90+: x0.5; a client with a write-off: x0.8
 * The balance x likelihood lands in the week of the expected date. It is a
 * planning number, labelled "likely", not a promise - the page says so.
 */
function forecast(ds, cards, today, currency, weeks = 4) {
  const byClient = {};
  for (const c of cards) byClient[c.id] = c;
  const paidLates = cards.filter((c) => c.avgDaysLate != null);
  const bookAvg = paidLates.length ? paidLates.reduce((a, c) => a + c.avgDaysLate, 0) / paidLates.length : 7;
  const buckets = [];
  for (let w = 0; w < weeks; w++) {
    const start = addDays(today, 7 * w);
    buckets.push({ start, end: addDays(start, 6), likelyCents: 0, dueCents: 0, count: 0 });
  }
  const end = buckets[buckets.length - 1].end;
  let laterCents = 0;
  const items = [];
  for (const d of ds) {
    // Paused invoices stay in: pausing stops the chasing, not the paying.
    if (d.currency !== currency || (d.status !== 'open' && d.status !== 'promised')) continue;
    const c = byClient[d.clientId] || {};
    let p;
    let expected;
    if (d.status === 'promised') {
      expected = d.promise.date;
      p = 0.85 - 0.1 * d.brokenPromises;
    } else {
      const avg = c.avgDaysLate != null ? c.avgDaysLate : bookAvg;
      expected = addDays(d.due, Math.round(avg));
      p = c.avgDaysLate != null ? Math.max(0.5, Math.min(0.95, 0.95 - 0.005 * c.avgDaysLate)) : 0.75;
      p -= 0.1 * d.brokenPromises;
      if (expected < today) expected = addDays(today, 7);
    }
    if (d.daysLate > 90) p *= 0.5;
    else if (d.daysLate > 60) p *= 0.75;
    if (c.writtenOff) p *= 0.8;
    p = Math.round(Math.max(0.1, Math.min(0.95, p)) * 100) / 100;
    const likely = Math.round(d.balanceCents * p);
    const w = Math.floor(daysBetween(today, expected) / 7);
    if (w >= 0 && w < weeks) {
      buckets[w].likelyCents += likely;
      buckets[w].count += 1;
    } else {
      laterCents += likely;
    }
    const dw = Math.floor(daysBetween(today, d.due) / 7);
    if (dw >= 0 && dw < weeks) buckets[dw].dueCents += d.balanceCents;
    items.push({ id: d.id, expected, likelihood: p, likelyCents: likely });
  }
  const likelyCents = buckets.reduce((a, b) => a + b.likelyCents, 0);
  return { currency, weeks: buckets, likelyCents, byDate: end, laterCents, items };
}

/* ------------------------------------------------------------------ *
 * Late fees - shown, offered, never added
 * ------------------------------------------------------------------ */

/**
 * What the settings' policy would add to this invoice today. It is a number
 * to show and, if the person ticks the box, to mention in a chase. It is never
 * added to the balance, the statement or the forecast.
 *
 * Percent is simple interest on the balance, pro rata by day on a 30-day
 * month, counted only after the grace days. Flat is charged once, after them.
 */
function lateFee(d, policy, today) {
  const pol = { ...SETTINGS_DEFAULTS.lateFee, ...(policy || {}) };
  const late = daysBetween(d.due, today);
  const days = Math.max(0, late - pol.graceDays);
  const base = { mode: pol.mode, cents: 0, days, graceDays: pol.graceDays, applies: false, rule: '' };
  if (pol.mode === 'none') return { ...base, rule: 'No late-fee policy set.' };
  if (d.balanceCents <= 0 || d.writtenOff) return { ...base, rule: 'Nothing is owed.' };
  if (days <= 0) {
    return { ...base, rule: late > 0 ? `Within the ${pol.graceDays}-day grace period.` : 'Not late yet.' };
  }
  if (pol.mode === 'flat') {
    return { ...base, cents: pol.flatCents, applies: true, rule: `Flat ${fmtMoney(pol.flatCents, d.currency)} after ${pol.graceDays} days' grace.` };
  }
  const cents = Math.round(d.balanceCents * (pol.pctPerMonth / 100) * (days / 30));
  return { ...base, cents, applies: cents > 0, rule: `${pol.pctPerMonth}% a month on ${fmtMoney(d.balanceCents, d.currency)}, for ${days} day${days === 1 ? '' : 's'} past the ${pol.graceDays}-day grace.` };
}

/* ------------------------------------------------------------------ *
 * Wins: the streak and the badges
 * ------------------------------------------------------------------ */

/** Monday of the ISO week, as an ISO day. */
function weekOf(iso) {
  const dow = (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}

/** Consecutive weeks with money in, ending this week or last - so a Monday
 *  with nothing yet does not reset a good run. */
function collectedStreak(ds, today) {
  const weeks = new Set();
  for (const d of ds) for (const p of d.payments || []) if (p.date <= today) weeks.add(weekOf(p.date));
  let w = weekOf(today);
  if (!weeks.has(w)) w = addDays(w, -7);
  let n = 0;
  while (weeks.has(w)) { n++; w = addDays(w, -7); }
  return n;
}

const BADGES = [
  { key: 'first_chase', emoji: '📣', label: 'First chase', desc: 'Sent your first chase. The hardest one.' },
  { key: 'first_paid', emoji: '💸', label: 'Paid!', desc: 'Your first invoice marked paid.' },
  { key: 'promise_kept', emoji: '🤝', label: 'Promise kept', desc: 'A client paid by the day they promised.' },
  { key: 'five_paid', emoji: '🖐️', label: 'High five', desc: 'Five invoices paid in full.' },
  { key: 'cleared_60', emoji: '🧗', label: 'Long haul', desc: 'Collected an invoice 60+ days late.' },
  { key: 'zero_overdue', emoji: '🧼', label: 'Clean slate', desc: 'Nothing overdue, with at least three invoices on the books.' },
  { key: 'streak_4', emoji: '🔥', label: 'On a roll', desc: 'Money in four weeks running.' },
];

function earnedBadges(ds, today) {
  const paid = ds.filter((d) => d.status === 'paid');
  const got = new Set();
  if (ds.some((d) => (d.chases || []).length)) got.add('first_chase');
  if (paid.length >= 1) got.add('first_paid');
  if (ds.some((d) => d.keptPromises > 0)) got.add('promise_kept');
  if (paid.length >= 5) got.add('five_paid');
  if (paid.some((d) => d.paidAt && daysBetween(d.due, d.paidAt) >= 60)) got.add('cleared_60');
  if (paid.length >= 1 && ds.length >= 3 && !ds.some((d) => d.overdue)) got.add('zero_overdue');
  if (collectedStreak(ds, today) >= 4) got.add('streak_4');
  return got;
}

/* ------------------------------------------------------------------ *
 * The whole book, for Today
 * ------------------------------------------------------------------ */

function deriveAll(invoices, today) {
  return invoices.map((i) => derive(i, today));
}

function indexClients(clients) {
  const m = {};
  for (const c of clients) m[c.id] = c;
  return m;
}

function scorecards(clients, ds, dflt) {
  const by = {};
  for (const d of ds) (by[d.clientId] = by[d.clientId] || []).push(d);
  return clients
    .map((c) => scorecard(c, by[c.id] || [], dflt))
    .sort((a, b) => b.riskCents - a.riskCents || b.outstandingCents - a.outstandingCents || a.name.localeCompare(b.name));
}

function todayView(invoices, clients, settings, today) {
  const currency = settings.currency || 'USD';
  const ds = deriveAll(invoices, today);
  const byId = indexClients(clients);
  const cards = scorecards(clients, ds, currency);
  const live = ds.filter((d) => d.status === 'open' || d.status === 'promised');
  const month = today.slice(0, 7);

  const perCurrency = {};
  for (const d of live) {
    const t = (perCurrency[d.currency] = perCurrency[d.currency] || { currency: d.currency, outstandingCents: 0, overdueCents: 0, openCount: 0, overdueCount: 0 });
    t.outstandingCents += d.balanceCents;
    t.openCount += 1;
    if (d.daysLate > 0) { t.overdueCents += d.balanceCents; t.overdueCount += 1; }
  }
  let collectedMonthCents = 0;
  for (const d of ds) {
    if (d.currency !== currency) continue;
    for (const p of d.payments || []) if (p.date.slice(0, 7) === month && p.date <= today) collectedMonthCents += p.cents;
  }
  const mine = perCurrency[currency] || { currency, outstandingCents: 0, overdueCents: 0, openCount: 0, overdueCount: 0 };

  const rows = live.map((d) => row(d, byId));
  const chase = rows.filter((r) => r.chaseDue).sort((a, b) => b.score - a.score);
  const waiting = rows.filter((r) => !r.chaseDue && !r.paused)
    .sort((a, b) => (a.nextChaseOn || a.promise?.date || a.due).localeCompare(b.nextChaseOn || b.promise?.date || b.due));
  const paused = rows.filter((r) => r.paused && r.status === 'open');

  return {
    today,
    currency,
    totals: {
      outstandingCents: mine.outstandingCents,
      overdueCents: mine.overdueCents,
      openCount: mine.openCount,
      overdueCount: mine.overdueCount,
      collectedMonthCents,
      others: Object.values(perCurrency).filter((t) => t.currency !== currency),
    },
    chase,
    waiting,
    paused,
    forecast: forecast(ds, cards, today, currency),
    streakWeeks: collectedStreak(ds, today),
    counts: { invoices: invoices.length, clients: clients.length },
  };
}

module.exports = {
  LIMITS, CURRENCIES, STAGES, SIDE, KINDS, BADGES, SETTINGS_DEFAULTS,
  clean, cleanText, cleanEmail, cleanPhone, cleanUrl, toCents, centsFrom, isoDay, addDays, daysBetween, utcToday, todayFrom,
  currencyOf, fmtMoney, fmtDay, clampNum, httpError, kindInfo, nextKind, termsDaysOf,
  cleanSettings, cleanClient, cleanInvoice, sumPayments, paidAtOf,
  derive, deriveAll, scoreOf, row, scorecard, scorecards, forecast, lateFee, weekOf, collectedStreak, earnedBadges,
  indexClients, todayView,
};
