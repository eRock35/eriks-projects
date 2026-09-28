// Saved loans: the server-side shapes, ids, limits and views.
//
// A saved loan is ONE document under its owner's uid,
// `loans/<uid>/items/<id>`:
//
//   { name, loan: {lender, borrower, amount, type, maturity},
//     covenants: [...cleaned covenants], fye: 1-12, from: 'text'|'photo'|'sample',
//     periods: { "2026 Q3": { inputs: {ebitda: cents, ...}, savedAt } },
//     createdAt, updatedAt }
//
// Never the agreement's text, never a photo, never a transcript: those are
// read once in the request that reads them and dropped. What is kept is the
// list a person chose to save and the numbers they typed. Everything is
// cleaned again on the way in (Core.cleanCovenants, Core.cleanInputs) - the
// page sends back what the server gave it, but a request body is a request
// body.

const crypto = require('crypto');
const Core = require('../public/covenant-core');
const Sample = require('../public/sample');

const LIMITS = { ...Core.LIMITS };

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}

const ID_RE = /^[A-Za-z0-9_-]{12}$/;
/** 12 url-safe characters from 9 random bytes. */
const newId = () => crypto.randomBytes(9).toString('base64url');

function defaultName(loan) {
  const who = loan.borrower || 'My business';
  return Core.clean(`${who}${loan.lender ? ` · ${loan.lender}` : ''}`, LIMITS.name);
}

/** Only non-null numbers are kept for a period. */
function periodInputs(raw) {
  const inp = Core.cleanInputs(raw);
  const out = {};
  for (const [k, v] of Object.entries(inp)) if (v !== null) out[k] = v;
  return out;
}

/** A new loan from a request body: {name, loan, covenants, fye, from}, or
 *  {sample: true} for the example. */
function fromBody(body, now) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.sample === true) return sampleLoan(now);
  const { covenants } = Core.cleanCovenants(b.covenants);
  if (!covenants.length) throw httpError(400, 'There are no covenants to save. Read the loan first.');
  const loan = Core.cleanLoan(b.loan);
  const periods = {};
  const period = Core.cleanPeriod(b.period);
  if (period && b.inputs) {
    const inputs = periodInputs(b.inputs);
    if (Object.keys(inputs).length) periods[period] = { inputs, savedAt: now };
  }
  return {
    name: Core.clean(b.name, LIMITS.name) || defaultName(loan),
    loan,
    covenants,
    fye: Core.cleanFye(b.fye),
    from: b.from === 'photo' ? 'photo' : 'text',
    periods,
  };
}

/** The example, as a saved loan - so someone can try the quarterly check-in
 *  without a real agreement. Its quotes are checked against its own text,
 *  the same way a read is. */
function sampleLoan(now) {
  const { covenants } = Core.cleanCovenants(Sample.RAW);
  const found = Core.matcher(Sample.TEXT);
  covenants.forEach((c) => { c.verified = found(c.quote); c.from = 'text'; });
  const periods = {};
  for (const [k, v] of Object.entries(Sample.PERIODS)) periods[k] = { inputs: periodInputs(v), savedAt: now };
  return { name: 'Riverbend Bakery (example)', loan: Core.cleanLoan(Sample.LOAN), covenants, fye: Sample.FYE, from: 'sample', periods };
}

/** A stored loan, cleaned on the way out too. */
function view(doc) {
  const periods = {};
  const raw = doc.periods && typeof doc.periods === 'object' ? doc.periods : {};
  for (const k of Core.sortPeriods(Object.keys(raw).filter((p) => Core.cleanPeriod(p) === p))) {
    periods[k] = { inputs: periodInputs(raw[k] && raw[k].inputs), savedAt: (raw[k] && raw[k].savedAt) || null };
  }
  return {
    id: doc.id,
    name: Core.clean(doc.name, LIMITS.name),
    loan: Core.cleanLoan(doc.loan),
    covenants: Core.cleanCovenants(doc.covenants).covenants,
    fye: Core.cleanFye(doc.fye),
    from: ['text', 'photo', 'sample'].includes(doc.from) ? doc.from : 'text',
    periods,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

/** The list row: enough to pick one. */
function summary(doc) {
  const v = view(doc);
  const keys = Object.keys(v.periods);
  return { id: v.id, name: v.name, lender: v.loan.lender, covenants: v.covenants.length, periods: keys.length, latest: keys[keys.length - 1] || null, updatedAt: v.updatedAt };
}

module.exports = { LIMITS, httpError, ID_RE, newId, fromBody, sampleLoan, view, summary, periodInputs, defaultName };
