// The rate card: where every price on a read job comes from.
//
// The Gemini reader describes work - a task, a quantity, a unit, the materials
// it could name. It is never asked for money and has no field to put any in.
// This file prices each line from the tradesperson's OWN numbers, in this
// order:
//
//   1. their price list (Business -> Price list)
//   2. a line on one of their saved templates
//   3. a line on one of their recent quotes
//   4. their hourly rate, for a labor line measured in hours
//
// and when none of those fits, the line is left at 0 and flagged "needs a
// price" for the person to fill in. A price is never guessed. A match needs
// the same unit (a price per gallon is not a price per each) and the same
// side of the labor line (markup treats them differently).
//
// Pure functions, no database, no model.

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'with', 'in', 'on', 'at', 'per', 'by', 'from', 'approx', 'about', 'incl', 'including', 'new', 'all', 'as', 'needed', 'etc', 'x']);

/** The words that carry meaning in a line: lower case, plurals folded. */
function tokens(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
    if (w.length < 2 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return out;
}

const unitKey = (u) => String(u || '').trim().toLowerCase();
const RANK = { list: 3, template: 2, quote: 1 };
const MAX_CARD = 400;

/**
 * @param profile    the pro's profile (rates, hourlyRate)
 * @param templates  their saved templates
 * @param quotes     their recent quotes, newest first
 */
function buildCard(profile, templates = [], quotes = []) {
  const card = [];
  const add = (it, source, label) => {
    if (card.length >= MAX_CARD || !it || !(Number(it.unitPrice) > 0)) return;
    const t = tokens(it.description || it.name);
    if (!t.size) return;
    card.push({ tokens: t, unit: unitKey(it.unit), labor: it.category === 'labor', unitPrice: Number(it.unitPrice), source, label });
  };
  for (const r of (profile && profile.rates) || []) add(r, 'list', 'Your price list');
  for (const t of templates || []) {
    const label = `Your template “${t.name || t.title || 'untitled'}”`;
    for (const it of t.items || []) add(it, 'template', label);
    for (const tier of t.tiers || []) for (const it of tier.items || []) add(it, 'template', label);
  }
  for (const q of quotes || []) {
    const label = `Your quote ${q.number || ''}`.trim();
    for (const it of q.items || []) add(it, 'quote', label);
    for (const tier of q.tiers || []) for (const it of tier.items || []) add(it, 'quote', label);
  }
  return card;
}

/** The pro's own price for one described line, and where it came from. */
function priceFor(line, card, profile) {
  const want = tokens(`${line.description || ''} ${line.materials || ''}`);
  const unit = unitKey(line.unit);
  const labor = line.category === 'labor';
  let best = null;
  for (const e of card || []) {
    if (e.unit !== unit || e.labor !== labor) continue;
    let inter = 0;
    for (const t of e.tokens) if (want.has(t)) inter += 1;
    if (!inter) continue;
    const small = Math.min(e.tokens.size, want.size);
    const contain = inter / small;
    const fits = (inter >= 2 && contain >= 0.66) || (e.source === 'list' && inter === e.tokens.size);
    if (!fits) continue;
    const score = RANK[e.source] * 100 + contain * 10 + inter / (e.tokens.size + want.size - inter);
    if (!best || score > best.score) best = { score, e };
  }
  if (best) return { unitPrice: best.e.unitPrice, source: best.e.source, label: best.e.label };
  const rate = Number(profile && profile.hourlyRate) || 0;
  if (labor && unit === 'hr' && rate > 0) return { unitPrice: rate, source: 'rate', label: 'Your hourly rate' };
  return { unitPrice: 0, source: 'none', label: 'Needs your price' };
}

/** Price every line of a reading. A line with no price of the pro's own is
 *  flagged rather than filled in. */
function priceLines(lines, card, profile) {
  return (lines || []).map((l) => {
    const p = priceFor(l, card, profile);
    const flags = [...(l.flags || [])];
    if (p.source === 'none' && !flags.includes('price')) flags.push('price');
    return { ...l, unitPrice: p.unitPrice, priceSource: { kind: p.source, label: p.label }, flags };
  });
}

module.exports = { tokens, buildCard, priceFor, priceLines };
