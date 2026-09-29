// A table: one shared bill that friends claim from their own phones.
//
// Pure rules, no store: the server reads the document, runs one of these
// inside a transaction, and writes what comes back. Every change bumps `v`,
// so a phone polling with `?since=v` gets a one-line "nothing new" answer.
//
// What a table document holds - and nothing else:
//   {code, ownerTag, createdAt, updatedAt, expiresAt, v, locked,
//    bill,                         the bill (dibs-core cleanBill)
//    people: [{id, name, color, keyHash|null, host}],
//    claims: {itemId: {personId: weight}},
//    everyone: {itemId: true},
//    paid: {personId: {at, confirmed}}}
//
// - `ownerTag` is an HMAC of the host's account id under a key derived from
//   the identity secret: it proves who the host is without the table holding
//   an account id or an email.
// - `keyHash` is sha256(the guest's browser key + the table code). The key
//   lives in an HttpOnly cookie; the hash cannot be turned back into it, and
//   it differs per table, so two tables cannot be linked to one phone.
// - Person ids are random per table. That is all any guest ever learns about
//   anyone else: a name they typed, a colour, a random id.

const crypto = require('crypto');
const Core = require('../public/dibs-core');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const CODE_LEN = 6;                                         // 32^6 ≈ 1.07 billion
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);

const LIMITS = {
  tablesPerHost: 20,
  people: Core.LIMITS.people,       // 20 at one table, the host included
  ttlMs: 14 * 24 * 60 * 60 * 1000,  // a table lasts 14 days
  newGuestsPerIp: 30,               // new guests one address may add...
  newGuestsWindowMs: 60 * 60 * 1000, // ...an hour
  missesPerIp: 30,                  // distinct wrong codes one address may try...
  missWindowMs: 15 * 60 * 1000,     // ...in 15 minutes
  writesPerIp: 600,                 // any table writes, per address...
  writesWindowMs: 10 * 60 * 1000,   // ...in 10 minutes
};

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}

/** A fresh code: 6 characters, each uniform over the 32 (rejection
 *  sampling, so no character is likelier than another). */
function newCode() {
  let out = '';
  while (out.length < CODE_LEN) {
    for (const b of crypto.randomBytes(12)) {
      if (b < 256 - (256 % CODE_ALPHABET.length)) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === CODE_LEN) break;
    }
  }
  return out;
}
/** What someone typed or scanned -> a code: case, spaces and dashes don't
 *  matter, and the look-alikes O/0 and I/1 read as nothing (not in codes). */
function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
function isCode(v) { return CODE_RE.test(String(v || '')); }
function formatCode(c) { const s = normalizeCode(c); return s.length === CODE_LEN ? `${s.slice(0, 3)}-${s.slice(3)}` : s; }

function derived(secret, purpose) { return crypto.createHmac('sha256', String(secret)).update(purpose).digest(); }
function ownerTag(uid, secret) {
  return crypto.createHmac('sha256', derived(secret, 'dibs table owner v1')).update(String(uid)).digest('base64url').slice(0, 27);
}
function keyHash(key, code) { return crypto.createHash('sha256').update(`${key}:${code}`).digest('base64url').slice(0, 32); }
function newKey() { return crypto.randomBytes(16).toString('base64url'); }
function newPid() {
  let s = '';
  while (s.length < 8) s += crypto.randomBytes(8).toString('base64').replace(/[^a-z0-9]/g, '');
  return `p${s.slice(0, 9)}`;
}

function expired(doc, now) { return !doc || !doc.expiresAt || Date.parse(doc.expiresAt) <= now; }

/** People as a guest may see them: never a key hash. */
function peopleView(doc) {
  return (doc.people || []).map((p) => ({ id: p.id, name: p.name, color: p.color, host: Boolean(p.host), joined: Boolean(p.keyHash || p.host) }));
}

/** The whole table as one viewer sees it. `me` is their person id (or
 *  null until they join); `host` says whether they run it. */
function view(doc, me, host) {
  return {
    code: doc.code,
    display: formatCode(doc.code),
    v: doc.v || 0,
    locked: Boolean(doc.locked),
    expiresAt: doc.expiresAt,
    bill: doc.bill,
    people: peopleView(doc),
    claims: doc.claims || {},
    everyone: doc.everyone || {},
    paid: doc.paid || {},
    me: me || null,
    host: Boolean(host),
  };
}

/** The host's list: codes, titles and how far along each is. */
function summaryOf(doc) {
  const people = Core.cleanPeople(doc.people || []);
  const r = Core.split(doc.bill, people, doc.claims || {}, doc.everyone || {});
  return {
    code: doc.code, display: formatCode(doc.code), title: doc.bill.title || 'Untitled bill', people: people.length,
    grand: r.grand, currency: doc.bill.currency, unclaimed: r.unclaimed.total, locked: Boolean(doc.locked),
    createdAt: doc.createdAt, expiresAt: doc.expiresAt,
  };
}

function pickColor(doc, wanted) {
  const taken = new Set((doc.people || []).map((p) => p.color));
  if (Core.COLOR_IDS.includes(wanted) && !taken.has(wanted)) return wanted;
  return Core.COLOR_IDS.find((c) => !taken.has(c)) || (Core.COLOR_IDS.includes(wanted) ? wanted : Core.COLOR_IDS[0]);
}

/** A new table from the host's bill (as it stood on their phone). */
function create({ code, tag, bill, people, claims, everyone, hostPid, now }) {
  const b = Core.cleanBill(bill);
  if (!b.items.length) throw httpError(400, 'Add at least one item before sharing the bill.');
  let ps = Core.cleanPeople(people);
  if (!ps.length) ps = [{ id: newPid(), name: 'Me', color: Core.COLOR_IDS[0] }];
  // Fresh random ids for everyone: a phone's local ids are not the table's.
  const map = {};
  ps = ps.map((p) => { const id = newPid(); map[p.id] = id; return { ...p, id }; });
  const hostId = map[hostPid] || (b.payerId && map[b.payerId]) || ps[0].id;
  const remap = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      const row = {};
      for (const [pid, w] of Object.entries(v || {})) if (map[pid]) row[map[pid]] = w;
      out[k] = row;
    }
    return out;
  };
  b.payerId = b.payerId && map[b.payerId] ? map[b.payerId] : hostId;
  const at = new Date(now).toISOString();
  return {
    code, ownerTag: tag, createdAt: at, updatedAt: at, expiresAt: new Date(now + LIMITS.ttlMs).toISOString(), v: 1, locked: false,
    bill: b,
    people: ps.map((p) => ({ id: p.id, name: p.name, color: p.color, keyHash: null, host: p.id === hostId })),
    claims: Core.cleanClaims(remap(claims), b, ps),
    everyone: Core.cleanEveryone(everyone, b),
    paid: {},
  };
}

/** Whose change is this? {pid, host}. */
function need(cond, status, message) { if (!cond) throw httpError(status, message); }

function touch(doc, now) { doc.v = (doc.v || 0) + 1; doc.updatedAt = new Date(now).toISOString(); return doc; }

/**
 * A guest joins: as one of the names the host already typed ("I'm Ana"), or
 * as someone new. A browser that already joined gets its own person back.
 * Returns {doc, pid, isNew}.
 */
function join(doc, { hash, pid, name, color }, now) {
  const mine = doc.people.find((p) => p.keyHash && p.keyHash === hash);
  if (mine) return { doc, pid: mine.id, isNew: false };
  if (pid) {
    const p = doc.people.find((x) => x.id === pid);
    need(p, 404, 'That name is not at this table any more.');
    need(!p.keyHash && !p.host, 409, `${p.name} has already joined on another phone. Pick another name, or add yours.`);
    p.keyHash = hash;
    if (Core.COLOR_IDS.includes(color)) p.color = color;
    return { doc: touch(doc, now), pid: p.id, isNew: true };
  }
  const n = Core.cleanName(name);
  need(n, 400, 'Add your name (or an emoji) first.');
  need(doc.people.length < LIMITS.people, 409, `This table is full - ${LIMITS.people} people at most.`);
  const p = { id: newPid(), name: n, color: pickColor(doc, color), keyHash: hash, host: false };
  doc.people.push(p);
  return { doc: touch(doc, now), pid: p.id, isNew: true };
}

function actorCan(actor, pid) { return actor.host || (actor.pid && actor.pid === pid); }

/** Call dibs: set one person's weight on one line (0 takes it back). */
function claim(doc, actor, { itemId, pid, weight }, now) {
  const who = pid || actor.pid;
  need(who, 403, 'Pick your name first.');
  need(actorCan(actor, who), 403, 'You can only change your own dibs.');
  need(!doc.locked || actor.host, 409, 'The bill is locked - ask whoever is running it to unlock it.');
  const it = doc.bill.items.find((x) => x.id === itemId);
  need(it, 404, 'That item is not on the bill any more.');
  need(doc.people.some((p) => p.id === who), 404, 'That person is not at this table.');
  let w = Number(weight);
  need(Number.isInteger(w) && w >= 0 && w <= Core.LIMITS.weight, 400, `A share is a whole number from 0 to ${Core.LIMITS.weight}.`);
  const row = { ...(doc.claims[itemId] || {}) };
  if (w) row[who] = w; else delete row[who];
  if (Object.keys(row).length) doc.claims[itemId] = row; else delete doc.claims[itemId];
  return touch(doc, now);
}

/** Share what is left of a line among everyone (host only). */
function everyone(doc, actor, { itemId, on }, now) {
  need(actor.host, 403, 'Only whoever is running the table can split a line among everyone.');
  need(doc.bill.items.some((x) => x.id === itemId), 404, 'That item is not on the bill any more.');
  if (on) doc.everyone[itemId] = true; else delete doc.everyone[itemId];
  return touch(doc, now);
}

/** Rename or recolour: yourself, or anyone if you are the host. */
function person(doc, actor, { pid, name, color }, now) {
  const who = pid || actor.pid;
  need(who, 403, 'Pick your name first.');
  need(actorCan(actor, who), 403, 'You can only change your own name.');
  const p = doc.people.find((x) => x.id === who);
  need(p, 404, 'That person is not at this table.');
  if (name !== undefined) { const n = Core.cleanName(name); need(n, 400, 'A name needs a letter, a number or an emoji.'); p.name = n; }
  if (color !== undefined) { need(Core.COLOR_IDS.includes(color), 400, 'Pick one of the colours.'); p.color = color; }
  return touch(doc, now);
}

/** The host adds someone who has no phone with them. */
function addPerson(doc, actor, { name, color }, now) {
  need(actor.host, 403, 'Only whoever is running the table can add people.');
  const n = Core.cleanName(name);
  need(n, 400, 'Add a name (or an emoji) first.');
  need(doc.people.length < LIMITS.people, 409, `This table is full - ${LIMITS.people} people at most.`);
  const p = { id: newPid(), name: n, color: pickColor(doc, color), keyHash: null, host: false };
  doc.people.push(p);
  return { doc: touch(doc, now), pid: p.id };
}

/** The host removes someone (and their dibs and paid mark), or frees a name
 *  a phone took by mistake so the right phone can take it. */
function removePerson(doc, actor, { pid, release }, now) {
  need(actor.host, 403, 'Only whoever is running the table can do that.');
  const p = doc.people.find((x) => x.id === pid);
  need(p, 404, 'That person is not at this table.');
  need(!p.host, 409, 'You can’t remove yourself from your own table.');
  if (release) { p.keyHash = null; return touch(doc, now); }
  doc.people = doc.people.filter((x) => x.id !== pid);
  for (const k of Object.keys(doc.claims)) { delete doc.claims[k][pid]; if (!Object.keys(doc.claims[k]).length) delete doc.claims[k]; }
  delete doc.paid[pid];
  if (doc.bill.payerId === pid) doc.bill.payerId = (doc.people.find((x) => x.host) || doc.people[0] || {}).id || null;
  return touch(doc, now);
}

/** "I've paid" (yourself), or the host's confirmation (anyone). */
function paid(doc, actor, { pid, paid: isPaid, confirmed }, now) {
  const who = pid || actor.pid;
  need(who, 403, 'Pick your name first.');
  need(actorCan(actor, who), 403, 'You can only mark your own payment.');
  need(doc.people.some((p) => p.id === who), 404, 'That person is not at this table.');
  need(doc.bill.payerId !== who, 400, 'That’s who paid - they don’t owe themselves.');
  if (!isPaid) { delete doc.paid[who]; return touch(doc, now); }
  const cur = doc.paid[who] || { at: new Date(now).toISOString(), confirmed: false };
  cur.confirmed = actor.host ? confirmed !== false : Boolean(cur.confirmed);
  doc.paid[who] = cur;
  return touch(doc, now);
}

/** The host replaces the bill: dibs on lines that are gone are dropped. */
function replaceBill(doc, actor, bill, now) {
  need(actor.host, 403, 'Only whoever is running the table can change the bill.');
  const b = Core.cleanBill(bill);
  need(b.items.length, 400, 'A bill needs at least one item.');
  if (!doc.people.some((p) => p.id === b.payerId)) b.payerId = (doc.bill && doc.people.some((p) => p.id === doc.bill.payerId)) ? doc.bill.payerId : (doc.people.find((p) => p.host) || {}).id || null;
  doc.bill = b;
  const ps = Core.cleanPeople(doc.people);
  doc.claims = Core.cleanClaims(doc.claims, b, ps);
  doc.everyone = Core.cleanEveryone(doc.everyone, b);
  if (doc.paid[b.payerId]) delete doc.paid[b.payerId];
  return touch(doc, now);
}

function lock(doc, actor, locked, now) {
  need(actor.host, 403, 'Only whoever is running the table can lock it.');
  doc.locked = Boolean(locked);
  return touch(doc, now);
}

module.exports = {
  CODE_ALPHABET, CODE_LEN, LIMITS, httpError,
  newCode, normalizeCode, isCode, formatCode, ownerTag, keyHash, newKey, newPid, expired,
  view, summaryOf, create, join, claim, everyone, person, addPerson, removePerson, paid, replaceBill, lock,
};
