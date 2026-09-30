// Saved agents: the server-side shapes, ids, limits and views.
//
// An agent is ONE document under its owner's uid, `agents/<uid>/items/<id>`:
//
//   { name, profile, charter, drills: [{at, readiness, calls, rounds}],
//     createdAt, updatedAt }
//
// Never the text someone pasted for the AI to read: that went to the model
// once and was dropped with the request. Everything is cleaned on the way in
// (Core.cleanAgent) and again on the way out.

const crypto = require('crypto');
const Core = require('../public/leash-core');

const LIMITS = { agents: Core.LIMITS.agents, drills: Core.LIMITS.drills, name: Core.LIMITS.name };

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}

const ID_RE = /^[A-Za-z0-9_-]{12}$/;
/** 12 url-safe characters from 9 random bytes. */
const newId = () => crypto.randomBytes(9).toString('base64url');

function defaultName(a) {
  return a.name || a.profile.name || 'My AI agent';
}

/** An agent from a request body. Only the profile, the charter's fields and
 *  drill scores survive: anything else a body carries is dropped. */
function fromBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (Array.isArray(b.drills) && b.drills.length > LIMITS.drills * 2) throw httpError(400, `An agent keeps its last ${LIMITS.drills} drill results.`);
  const a = Core.cleanAgent(b);
  a.name = defaultName(a);
  return a;
}

/** A stored agent, cleaned on the way out too. */
function view(doc) {
  const a = Core.cleanAgent(doc);
  return { id: doc.id, ...a, name: defaultName(a), createdAt: doc.createdAt || null, updatedAt: doc.updatedAt || null };
}

/** The list row: enough to pick one. */
function summary(doc) {
  const v = view(doc);
  const sc = Core.score(v.profile);
  const last = v.drills[v.drills.length - 1];
  return {
    id: v.id,
    name: v.name,
    score: sc.score,
    band: sc.band.label,
    caps: Object.keys(v.profile.caps).length,
    drills: v.drills.length,
    readiness: last ? last.readiness : null,
    updatedAt: v.updatedAt,
  };
}

module.exports = { LIMITS, httpError, ID_RE, newId, fromBody, view, summary };
