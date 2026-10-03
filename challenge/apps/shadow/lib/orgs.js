// Organisations, request links and staff requests: the pure rules the
// server runs inside its routes. No store, no clock of its own.
//
// What is kept, and nothing else:
//   orgs/<uid>/items/<orgId>  {name, kind, tools, done, rid, createdAt, updatedAt}
//       tools are Core.toSaved rows (never a transaction, a statement or an
//       export), done is the fixes applied [{id, text, at}].
//   links/<rid>               {orgName, accepting, createdAt}
//       what a staff member's link needs to say whose it is - no account id,
//       no email, nothing from the inventory.
//   requests/<rid>/items/<qid>  {tool, name, why, data, trial, users, status,
//       conditions, keyHash, at, decidedAt}
//       keyHash is sha256(the staff member's browser key + rid): it lets them
//       see and withdraw their own requests and nobody else's, and it cannot
//       be turned back into the key or linked across two orgs.

const crypto = require('crypto');
const Core = require('../public/shadow-core');

const KINDS = ['company', 'school', 'nonprofit', 'public'];
const KIND_LABEL = { company: 'Company', school: 'School or district', nonprofit: 'Nonprofit', public: 'Public agency' };
const ORG_ID_RE = /^o[0-9a-f]{12}$/;
const RID_RE = /^[A-Za-z0-9_-]{22}$/;
const QID_RE = /^q[0-9a-f]{16}$/;
const KEY_RE = /^[A-Za-z0-9_-]{22}$/;
const STATUS = ['open', 'approved', 'declined', 'withdrawn'];

const LIMITS = {
  orgs: Core.LIMITS.orgs,
  openRequests: Core.LIMITS.openRequests,  // waiting in one org's queue
  openPerGuest: 20,                        // one browser's open requests at one org
  newRequestsPerIp: 10,                    // new requests one address may send...
  newRequestsWindowMs: 60 * 60 * 1000,     // ...an hour
  missesPerIp: 30,                         // distinct wrong links one address may try...
  missWindowMs: 15 * 60 * 1000,            // ...in 15 minutes
  savesPerUser: 120,                       // inventory saves...
  savesWindowMs: 10 * 60 * 1000,           // ...in 10 minutes
  decided: 300,                            // decided requests kept per link
};

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}

const newOrgId = () => `o${crypto.randomBytes(6).toString('hex')}`;
const newRid = () => crypto.randomBytes(16).toString('base64url');
const newQid = () => `q${crypto.randomBytes(8).toString('hex')}`;
const newKey = () => crypto.randomBytes(16).toString('base64url');
const keyHash = (key, rid) => crypto.createHash('sha256').update(`${key}|${rid}`).digest('base64url');

/** The fixes applied, as the page records them: a stable id, its words,
 *  when. Nothing else. */
function cleanDone(arr) {
  const out = [];
  const seen = new Set();
  (Array.isArray(arr) ? arr : []).forEach((d) => {
    if (!d || typeof d !== 'object') return;
    const id = typeof d.id === 'string' && /^[a-z]{2,12}:t[0-9a-f]{12}$/.test(d.id) ? d.id : null;
    if (!id || seen.has(id) || out.length >= Core.LIMITS.done) return;
    seen.add(id);
    out.push({ id, text: Core.clean(d.text, 200), at: Core.isoDay(d.at) ? d.at : null });
  });
  return out;
}

/** An org as the page sends it -> what is stored. Unknown fields dropped. */
function cleanOrg(body, today) {
  const b = body && typeof body === 'object' ? body : {};
  const name = Core.clean(b.name, 80);
  if (!name) throw httpError(400, 'Give your organisation a name.');
  if (b.tools !== undefined && !Array.isArray(b.tools)) throw httpError(400, 'Send the tools as a list.');
  if (Array.isArray(b.tools) && b.tools.length > Core.LIMITS.tools) throw httpError(400, `An inventory keeps up to ${Core.LIMITS.tools} tools. Retire a few first.`);
  return {
    name,
    kind: KINDS.includes(b.kind) ? b.kind : 'company',
    tools: Core.cleanTools(b.tools).map(Core.toSaved),
    done: cleanDone(b.done).map((d) => ({ ...d, at: d.at && d.at <= today ? d.at : today })),
  };
}

/** A stored org on its way out: cleaned again, never trusted. */
function viewOrg(id, doc) {
  return {
    id,
    name: Core.clean(doc.name, 80),
    kind: KINDS.includes(doc.kind) ? doc.kind : 'company',
    tools: Core.cleanTools(doc.tools).map(Core.toSaved),
    done: cleanDone(doc.done),
    rid: RID_RE.test(doc.rid || '') ? doc.rid : null,
    updatedAt: doc.updatedAt || null,
  };
}
function summary(id, doc) {
  const tools = Core.cleanTools(doc.tools);
  const sc = Core.scoreAll(tools);
  return { id, name: Core.clean(doc.name, 80), kind: KINDS.includes(doc.kind) ? doc.kind : 'company', tools: tools.length, score: sc.score, band: sc.band, updatedAt: doc.updatedAt || null };
}

/** A request as its owner sees it: everything the staff member typed, the
 *  decision, never the key hash. */
function ownerView(id, r) {
  return {
    id,
    tool: Core.clean(r.tool, Core.LIMITS.name),
    name: Core.clean(r.name, Core.LIMITS.owner),
    why: Core.clean(r.why, Core.LIMITS.reason),
    data: Core.cleanTool({ name: 'x', data: r.data }).data,
    trial: Core.TRIAL_ANSWERS.includes(r.trial) ? r.trial : 'unsure',
    users: Number.isInteger(r.users) ? r.users : null,
    status: STATUS.includes(r.status) ? r.status : 'open',
    conditions: Core.clean(r.conditions, Core.LIMITS.conditions),
    at: r.at || null,
    decidedAt: r.decidedAt || null,
  };
}
/** The same request as the staff member who sent it sees it. */
function guestView(id, r) {
  const v = ownerView(id, r);
  return { id: v.id, tool: v.tool, why: v.why, data: v.data, trial: v.trial, status: v.status, conditions: v.conditions, at: v.at, decidedAt: v.decidedAt };
}

module.exports = {
  KINDS, KIND_LABEL, ORG_ID_RE, RID_RE, QID_RE, KEY_RE, STATUS, LIMITS,
  httpError, newOrgId, newRid, newQid, newKey, keyHash,
  cleanDone, cleanOrg, viewOrg, summary, ownerView, guestView,
};
