// The rules of a quote: what a line item is, how the money adds up, what a
// customer may see, and what the scoreboard counts.
//
// Pure functions, no database, no model - so the arithmetic can be tested on
// its own and the server applies it in exactly one place. The model PROPOSES
// line items; this file decides what they cost. A total that came out of a
// model is never stored, shown or sent: `computeTotals` recomputes every figure
// from quantities and unit prices each time a quote is drafted or saved.

const CATEGORIES = {
  labor: { label: 'Labor', emoji: '🛠️' },
  material: { label: 'Materials', emoji: '🧱' },
  equipment: { label: 'Equipment', emoji: '🚜' },
  other: { label: 'Other', emoji: '📎' },
};

const TRADES = {
  painter: { label: 'Painting', emoji: '🎨' },
  landscaper: { label: 'Landscaping', emoji: '🌿' },
  handyman: { label: 'Handyman', emoji: '🔧' },
  cleaner: { label: 'Cleaning', emoji: '🧽' },
  roofer: { label: 'Roofing', emoji: '🏠' },
  plumber: { label: 'Plumbing', emoji: '🚰' },
  electrician: { label: 'Electrical', emoji: '⚡' },
  photographer: { label: 'Photography', emoji: '📷' },
  events: { label: 'Events', emoji: '🎉' },
  other: { label: 'Other', emoji: '🧰' },
};

const UNITS = ['ea', 'hr', 'day', 'sq ft', 'ln ft', 'sq', 'gal', 'yd³', 'ton', 'lot', 'room', 'visit', 'job'];

const TIER_KEYS = ['good', 'better', 'best'];
const TIER_LABELS = { good: 'Good', better: 'Better', best: 'Best' };

// Statuses a quote can be stored in. `expired` is never stored: it is derived
// from validUntil at read time, so a quote does not need a sweep to expire and
// cannot be "expired" by a clock that was wrong when it was written.
const STATUSES = ['draft', 'sent', 'viewed', 'changes', 'accepted', 'declined'];
const OPEN = ['sent', 'viewed', 'changes'];

const LIMITS = {
  items: 40,
  tierItems: 20,
  qty: 100000,
  unitPrice: 1000000,
  discount: 10000000,
  pct: 100,
  listItems: 12,
};

/* ------------------------------------------------------------------ *
 * Cleaning
 * ------------------------------------------------------------------ */

/** Every string that came from a model or a stranger goes through here before
 *  it is stored: angle brackets and control characters out, length capped. The
 *  page escapes on top of this - belt and braces, because a quote page is
 *  shown to someone who never signed up for anything. */
function clean(v, max = 400) {
  return String(v == null ? '' : v)
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

/** Same, but keeps line breaks and collapses runs of blank lines. */
function cleanText(v, max = 2000) {
  return clean(String(v == null ? '' : v).replace(/\r\n?/g, '\n'), max * 2)
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, max);
}

/** A finite, non-negative number clamped to [0, hi], rounded to `dp` places.
 *  NaN, Infinity, strings like "12 bucks" and negatives all become something
 *  safe rather than poisoning a total. */
function num(v, hi, dp = 2, dflt = 0) {
  let n = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : Number(v);
  if (!Number.isFinite(n)) n = dflt;
  n = Math.max(0, Math.min(hi, n));
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

const cents = (n) => Math.round(n * 100) / 100;

function cleanList(a, n = LIMITS.listItems, max = 200) {
  return (Array.isArray(a) ? a : String(a || '').split('\n'))
    .map((x) => clean(x, max))
    .filter(Boolean)
    .slice(0, n);
}

let seq = 0;
function lineId() {
  seq = (seq + 1) % 1e6;
  return `l${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const description = clean(raw.description, 160);
  if (!description) return null;
  const unit = clean(raw.unit, 12) || 'ea';
  return {
    id: /^[a-z0-9]{4,24}$/i.test(String(raw.id || '')) ? String(raw.id) : lineId(),
    description,
    category: CATEGORIES[raw.category] ? raw.category : 'other',
    qty: num(raw.qty, LIMITS.qty, 2, 1),
    unit,
    unitPrice: num(raw.unitPrice, LIMITS.unitPrice, 2, 0),
  };
}

function cleanItems(a, max = LIMITS.items) {
  return (Array.isArray(a) ? a : []).map(cleanItem).filter(Boolean).slice(0, max);
}

function cleanTiers(a) {
  if (!Array.isArray(a) || !a.length) return null;
  const byKey = {};
  a.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const key = TIER_KEYS.includes(t.key) ? t.key : TIER_KEYS[i];
    if (!key || byKey[key]) return;
    byKey[key] = {
      key,
      label: clean(t.label, 40) || TIER_LABELS[key],
      summary: clean(t.summary, 280),
      items: cleanItems(t.items, LIMITS.tierItems),
    };
  });
  const tiers = TIER_KEYS.filter((k) => byKey[k]).map((k) => byKey[k]);
  // Two options is a choice; one is not. A model that only produced one tier
  // produced a single-price quote, and it is drawn as one.
  return tiers.length >= 2 ? tiers : null;
}

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */

/**
 * What a set of lines costs the customer.
 *
 * `unitPrice` is the pro's own price - their cost for materials, their rate for
 * labor. Markup is applied to everything that is NOT labor, because an hourly
 * rate already carries its margin and marking labor up again is how quotes
 * lose jobs. The customer only ever sees the marked-up price (`price`); the
 * cost and the margin stay on the owner's side.
 *
 * Rounded to the cent per line and again per total, so the page, the stored
 * quote and a calculator all agree to the penny.
 */
function priceLines(items, markupPct) {
  const m = num(markupPct, LIMITS.pct * 5, 2) / 100;
  return (items || []).map((it) => {
    const cost = cents(it.qty * it.unitPrice);
    const marked = it.category !== 'labor';
    const unit = marked ? cents(it.unitPrice * (1 + m)) : it.unitPrice;
    return { ...it, cost, customerUnit: unit, price: cents(it.qty * unit) };
  });
}

function totalsFor(items, { markupPct = 0, taxPct = 0, discount = 0 } = {}) {
  const lines = priceLines(items, markupPct);
  const cost = cents(lines.reduce((a, l) => a + l.cost, 0));
  const subtotal = cents(lines.reduce((a, l) => a + l.price, 0));
  const disc = cents(Math.min(num(discount, LIMITS.discount), subtotal));
  const taxable = cents(subtotal - disc);
  const tax = cents(taxable * (num(taxPct, LIMITS.pct, 3) / 100));
  const total = cents(taxable + tax);
  const byCategory = {};
  for (const l of lines) byCategory[l.category] = cents((byCategory[l.category] || 0) + l.price);
  return { cost, subtotal, discount: disc, taxable, tax, total, margin: cents(taxable - cost), byCategory };
}

/** Totals for a whole quote: one set, or one per tier (the base lines are in
 *  every tier; a tier's own lines are what it adds). */
function computeTotals(q) {
  const opts = { markupPct: q.markupPct, taxPct: q.taxPct, discount: q.discount };
  const base = q.items || [];
  if (q.tiers && q.tiers.length) {
    const tiers = {};
    for (const t of q.tiers) tiers[t.key] = totalsFor([...base, ...(t.items || [])], opts);
    return { tiers, base: totalsFor(base, opts) };
  }
  return { single: totalsFor(base, opts) };
}

/** The tier a quote is "worth" on the board: the one they accepted, or the
 *  middle option, which is the one most customers pick and the honest guess. */
function headlineTier(q) {
  if (!q.tiers || !q.tiers.length) return null;
  const accepted = q.response && q.response.tier;
  if (accepted && q.tiers.some((t) => t.key === accepted)) return accepted;
  return (q.tiers.find((t) => t.key === 'better') || q.tiers[0]).key;
}

function valueOf(q) {
  const totals = q.totals || computeTotals(q);
  if (totals.tiers) {
    const k = headlineTier(q);
    return (totals.tiers[k] || {}).total || 0;
  }
  return (totals.single || {}).total || 0;
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

function isExpired(q, now = Date.now()) {
  return OPEN.includes(q.status) && q.validUntil && Date.parse(q.validUntil) < now;
}

/** The status as the world should see it right now. */
function statusOf(q, now = Date.now()) {
  return isExpired(q, now) ? 'expired' : (q.status || 'draft');
}

/* ------------------------------------------------------------------ *
 * The profile
 * ------------------------------------------------------------------ */

const PROFILE_DEFAULTS = {
  name: '',
  trade: 'handyman',
  color: '#0fb58a',
  logo: '',
  phone: '',
  email: '',
  license: '',
  taxPct: 0,
  markupPct: 15,
  hourlyRate: 75,
  terms: '50% deposit to book, balance due on completion.',
  validDays: 30,
};

function cleanColor(v) {
  const s = String(v || '').trim();
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : null;
}

/** An emoji or one-to-three letters. Anything longer is not a logo. */
function cleanLogo(v) {
  const s = clean(v, 16).replace(/\s+/g, '');
  if (!s) return '';
  const chars = Array.from(s);
  if (/^[A-Za-z0-9&]+$/.test(s)) return s.slice(0, 3).toUpperCase();
  return chars.slice(0, 2).join('');
}

function cleanProfile(raw, prev = {}) {
  const r = raw || {};
  const base = { ...PROFILE_DEFAULTS, ...prev };
  const pick = (k, fn) => (k in r ? fn(r[k]) : base[k]);
  return {
    name: pick('name', (v) => clean(v, 60)),
    trade: pick('trade', (v) => (TRADES[v] ? v : base.trade)),
    color: pick('color', (v) => cleanColor(v) || base.color),
    logo: pick('logo', cleanLogo),
    phone: pick('phone', (v) => clean(v, 30).replace(/[^0-9+().\-\s x]/gi, '')),
    email: pick('email', (v) => {
      const e = clean(v, 120);
      return !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : base.email;
    }),
    license: pick('license', (v) => clean(v, 40)),
    taxPct: pick('taxPct', (v) => num(v, 30, 3)),
    markupPct: pick('markupPct', (v) => num(v, 200, 2)),
    hourlyRate: pick('hourlyRate', (v) => num(v, 2000, 2)),
    terms: pick('terms', (v) => cleanText(v, 400)),
    validDays: pick('validDays', (v) => Math.max(1, Math.round(num(v, 365, 0, 30)) || 30)),
  };
}

/* ------------------------------------------------------------------ *
 * Editing
 * ------------------------------------------------------------------ */

/** Apply an owner's edit to a stored quote. Only editable fields are read from
 *  the body - status, links, responses and totals are the server's. */
function applyEdit(q, body) {
  const b = body || {};
  const out = { ...q };
  if ('title' in b) out.title = clean(b.title, 90) || q.title;
  if ('scope' in b) out.scope = cleanText(b.scope, 1500);
  if ('customer' in b && b.customer && typeof b.customer === 'object') {
    out.customer = {
      name: clean(b.customer.name, 80),
      contact: clean(b.customer.contact, 120),
      address: clean(b.customer.address, 160),
    };
  }
  if ('items' in b) out.items = cleanItems(b.items);
  if ('tiers' in b) out.tiers = b.tiers ? cleanTiers(b.tiers) : null;
  if ('assumptions' in b) out.assumptions = cleanList(b.assumptions);
  if ('exclusions' in b) out.exclusions = cleanList(b.exclusions);
  if ('timeline' in b) out.timeline = clean(b.timeline, 200);
  if ('terms' in b) out.terms = cleanText(b.terms, 400);
  if ('notes' in b) out.notes = cleanText(b.notes, 1500);
  if ('markupPct' in b) out.markupPct = num(b.markupPct, 200, 2);
  if ('taxPct' in b) out.taxPct = num(b.taxPct, 30, 3);
  if ('discount' in b) out.discount = num(b.discount, LIMITS.discount, 2);
  if ('validDays' in b) out.validDays = Math.max(1, Math.round(num(b.validDays, 365, 0, 30)) || 30);
  if ('trade' in b && TRADES[b.trade]) out.trade = b.trade;
  out.totals = computeTotals(out);
  return out;
}

/* ------------------------------------------------------------------ *
 * What a customer may see
 * ------------------------------------------------------------------ */

/** A line as the customer sees it: their price, never the pro's cost. */
function publicLines(items, markupPct) {
  return priceLines(items, markupPct).map((l) => ({
    description: l.description,
    category: l.category,
    qty: l.qty,
    unit: l.unit,
    unitPrice: l.customerUnit,
    price: l.price,
  }));
}

function publicTotals(t) {
  return t ? { subtotal: t.subtotal, discount: t.discount, tax: t.tax, total: t.total } : null;
}

/**
 * The ONLY shape a public quote link returns. Built field by field, never by
 * copying the stored quote and deleting what should not go - a new private
 * field added next month would otherwise leak by default. What is absent on
 * purpose: the owner's uid and account email, internal notes, cost prices,
 * margin, the job description they dictated, and the follow-up drafts.
 */
function publicView(q, profile, now = Date.now()) {
  const p = profile || PROFILE_DEFAULTS;
  const totals = q.totals || computeTotals(q);
  const status = statusOf(q, now);
  return {
    business: {
      name: p.name || 'Your contractor',
      trade: TRADES[p.trade] ? TRADES[p.trade].label : '',
      color: cleanColor(p.color) || PROFILE_DEFAULTS.color,
      logo: p.logo || '',
      phone: p.phone || '',
      email: p.email || '',
      license: p.license || '',
    },
    number: q.number || '',
    title: q.title || '',
    customer: { name: (q.customer || {}).name || '', address: (q.customer || {}).address || '' },
    scope: q.scope || '',
    items: publicLines(q.items, q.markupPct),
    tiers: q.tiers ? q.tiers.map((t) => ({
      key: t.key,
      label: t.label,
      summary: t.summary,
      items: publicLines(t.items, q.markupPct),
      totals: publicTotals(totals.tiers && totals.tiers[t.key]),
    })) : null,
    recommended: q.tiers ? 'better' : null,
    totals: publicTotals(totals.single || null),
    taxPct: q.taxPct || 0,
    assumptions: q.assumptions || [],
    exclusions: q.exclusions || [],
    timeline: q.timeline || '',
    terms: q.terms || '',
    issuedAt: q.sentAt || q.createdAt || null,
    validUntil: q.validUntil || null,
    status,
    response: q.response && q.response.kind === 'accepted'
      ? { kind: 'accepted', name: q.response.name, tier: q.response.tier || null, at: q.response.at }
      : q.response && q.response.kind === 'declined' ? { kind: 'declined', at: q.response.at }
        : null,
    changesRequested: (q.messages || []).filter((m) => m.from === 'customer').length,
  };
}

/* ------------------------------------------------------------------ *
 * The scoreboard
 * ------------------------------------------------------------------ */

/** Monday 00:00 UTC of the week containing `t`, as YYYY-MM-DD. */
function weekKey(t) {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function prevWeek(key) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

/**
 * Everything the dashboard draws, from the quotes alone. Nothing is kept as a
 * running counter: counters drift the first time a quote is deleted or edited,
 * and a few hundred quotes is nothing to add up.
 *
 * - Win rate is accepted over DECIDED (accepted, declined, expired). Counting
 *   quotes still out as losses would punish sending one this morning.
 * - The streak is consecutive weeks with at least one quote sent, ending this
 *   week - or last week, so Monday morning does not reset it before anyone has
 *   had a chance to send.
 * - The chart buckets by the week a quote was SENT, for both bars, so "won"
 *   is always a part of "quoted" and the two bars read as one against the other.
 */
function stats(quotes, now = Date.now()) {
  const qs = (quotes || []).map((q) => ({ ...q, _status: statusOf(q, now), _value: valueOf(q) }));
  const sent = qs.filter((q) => q.sentAt);
  const won = qs.filter((q) => q._status === 'accepted');
  const lost = qs.filter((q) => q._status === 'declined' || q._status === 'expired');
  const open = qs.filter((q) => OPEN.includes(q._status));
  const decided = won.length + lost.length;
  const sum = (a) => cents(a.reduce((x, q) => x + q._value, 0));

  const sendTimes = sent
    .map((q) => (Date.parse(q.sentAt) - Date.parse(q.createdAt)) / 60000)
    .filter((m) => Number.isFinite(m) && m >= 0);
  const avgMinutesToSend = sendTimes.length ? Math.round(sendTimes.reduce((a, b) => a + b, 0) / sendTimes.length) : null;

  const weeksWithSends = new Set(sent.map((q) => weekKey(q.sentAt)));
  const thisWeek = weekKey(now);
  let cursor = weeksWithSends.has(thisWeek) ? thisWeek : prevWeek(thisWeek);
  let streak = 0;
  while (weeksWithSends.has(cursor)) { streak++; cursor = prevWeek(cursor); }

  const weeks = [];
  let wk = thisWeek;
  for (let i = 0; i < 8; i++) { weeks.unshift(wk); wk = prevWeek(wk); }
  const chart = weeks.map((w) => {
    const inWeek = sent.filter((q) => weekKey(q.sentAt) === w);
    return {
      week: w,
      quoted: sum(inWeek),
      won: sum(inWeek.filter((q) => q._status === 'accepted')),
      count: inWeek.length,
    };
  });

  const byStatus = {};
  for (const s of [...STATUSES, 'expired']) byStatus[s] = 0;
  for (const q of qs) byStatus[q._status] = (byStatus[q._status] || 0) + 1;

  return {
    quotes: qs.length,
    sent: sent.length,
    won: won.length,
    decided,
    winRate: decided ? Math.round((won.length / decided) * 100) : null,
    totalQuoted: sum(sent),
    totalWon: sum(won),
    averageQuote: sent.length ? cents(sum(sent) / sent.length) : 0,
    avgMinutesToSend,
    pipelineValue: sum(open),
    streakWeeks: streak,
    sentThisWeek: sent.filter((q) => weekKey(q.sentAt) === thisWeek).length,
    chart,
    byStatus,
  };
}

module.exports = {
  CATEGORIES, TRADES, UNITS, TIER_KEYS, TIER_LABELS, STATUSES, OPEN, LIMITS, PROFILE_DEFAULTS,
  clean, cleanText, cleanList, num, cleanItem, cleanItems, cleanTiers, cleanProfile, cleanColor, cleanLogo,
  priceLines, totalsFor, computeTotals, headlineTier, valueOf, isExpired, statusOf,
  applyEdit, publicView, stats, weekKey,
};
