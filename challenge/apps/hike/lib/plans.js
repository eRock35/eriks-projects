// Saved plans: the server-side shapes, ids, limits and views.
//
// A plan is ONE document under its owner's uid, `plans/<uid>/items/<id>`:
//
//   { name, meter, lines: [...], settings, rollout, announce, draft, tracker,
//     createdAt, updatedAt }
//
// Never a photo: a snapped menu's lines reach a plan only after the person
// has reviewed them and added them, and the photos themselves were dropped
// with the request that read them. Everything is cleaned on the way in
// (Core.cleanPlan) and again on the way out - the page sends back what it
// was given, but a request body is a request body.

const crypto = require('crypto');
const Core = require('../public/hike-core');

const LIMITS = { ...Core.LIMITS };

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}

const ID_RE = /^[A-Za-z0-9_-]{12}$/;
/** 12 url-safe characters from 9 random bytes. */
const newId = () => crypto.randomBytes(9).toString('base64url');

const today = () => new Date().toISOString().slice(0, 10);

function defaultName(plan) {
  return Core.clean(plan.announce && plan.announce.business ? `${plan.announce.business} price rise` : 'My price rise', LIMITS.planName);
}

/** A plan from a request body. A body with more lines or tracker weeks than
 *  a plan keeps is refused rather than silently cut, so the person knows. */
function fromBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (Array.isArray(b.lines) && b.lines.length > LIMITS.lines) throw httpError(400, `A plan keeps up to ${LIMITS.lines} lines. Split the list into two plans.`);
  if (b.tracker && Array.isArray(b.tracker.entries) && b.tracker.entries.length > LIMITS.tracker) throw httpError(400, `The tracker keeps up to ${LIMITS.tracker} weeks.`);
  const plan = Core.cleanPlan(b, today());
  plan.name = plan.name || defaultName(plan);
  return plan;
}

/** A stored plan, cleaned on the way out too. */
function view(doc) {
  const plan = Core.cleanPlan(doc, today());
  return { id: doc.id, ...plan, name: plan.name || defaultName(plan), createdAt: doc.createdAt || null, updatedAt: doc.updatedAt || null };
}

/** The list row: enough to pick one. */
function summary(doc) {
  const v = view(doc);
  const pl = Core.priceList(v.lines, v.settings);
  return {
    id: v.id,
    name: v.name,
    business: v.announce.business,
    lines: v.lines.length,
    blendedBp: pl.blended ? pl.blended.bp : null,
    effective: v.rollout.effective,
    weeks: v.tracker.entries.length,
    updatedAt: v.updatedAt,
  };
}

module.exports = { LIMITS, httpError, ID_RE, newId, fromBody, view, summary, defaultName, today };
