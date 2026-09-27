// Device keys: how the Chrome extension and the iPhone Shortcut act for a
// signed-in person without a browser cookie.
//
// Modelled on the site's ideas-inbox token (eriks-projects lib/inbox.js):
//
//   - 32 random bytes, base64url, with a `tells_` prefix so it is
//     recognisable in a Shortcut and to a secret scanner.
//   - Shown ONCE, when it is made. Only its SHA-256 is stored, as the
//     document id: devices/<sha256 hex> = {uid, label, createdAt, lastUsedAt}.
//     Nobody - not the owner, not the database - can read a key back.
//   - At most 5 per account; list and revoke from the Settings sheet.
//   - A key resolves to its account and nothing else. The request is then
//     treated exactly like a signed-in one, so requireBudget and
//     requireDailyCap charge and stop THAT account. It cannot mint or revoke
//     keys (that needs the real session).
//   - Rate limited per key, and wrong keys per address (each costs a read).

const crypto = require('crypto');

const COLLECTION = 'devices';
const KEY_PREFIX = 'tells_';
const MAX_PER_USER = 5;
const HASH_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^tells_[A-Za-z0-9_-]{43}$/;

function hashKey(key) { return crypto.createHash('sha256').update(String(key)).digest('hex'); }
function newKey() {
  const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { key, hash: hashKey(key) };
}

/** The bearer key from an Authorization header, or null. Bounded, so a
 *  megabyte of header is never hashed. */
function bearer(req) {
  const h = String((req.headers && req.headers.authorization) || '');
  const m = h.match(/^Bearer\s+(\S{1,200})\s*$/i);
  return m ? m[1] : null;
}

function cleanLabel(v) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || 'A device';
}

/** In memory, per instance - it caps one runaway Shortcut, not a determined
 *  attacker spread over instances. No timer: old hits are dropped when next
 *  looked at. */
function createLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  const prune = (key, t) => {
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };
  return {
    hit(key) {
      const t = now();
      const list = prune(key, t);
      if (list.length >= max) return false;
      list.push(t);
      hits.set(key, list);
      if (hits.size > 5000) hits.clear();
      return true;
    },
    blocked(key) { return prune(key, now()).length >= max; },
  };
}

function fail(status, message) { return Object.assign(new Error(message), { status, expose: true }); }

function createDevices(store, { now = () => new Date() } = {}) {
  const locks = new Map();
  async function exclusive(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const chain = prev.then(() => mine);
    locks.set(key, chain);
    await prev;
    try { return await fn(); } finally { release(); if (locks.get(key) === chain) locks.delete(key); }
  }

  const view = (d) => ({ id: d.id, label: d.label, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt || null });

  async function list(uid) {
    const rows = await store.list(COLLECTION, { where: [['uid', '==', uid]] });
    return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(view);
  }

  /** A new key for this account. The key itself is in the answer and
   *  nowhere else, ever. */
  async function mint(uid, label) {
    return exclusive(`mint/${uid}`, async () => {
      const mine = await store.list(COLLECTION, { where: [['uid', '==', uid]] });
      if (mine.length >= MAX_PER_USER) throw fail(409, `You can have ${MAX_PER_USER} device keys. Revoke one you no longer use first.`);
      const { key, hash } = newKey();
      const at = now().toISOString();
      const doc = { uid, label: cleanLabel(label), createdAt: at, lastUsedAt: null };
      await store.set(COLLECTION, hash, doc);
      return { key, device: view({ id: hash, ...doc }) };
    });
  }

  async function revoke(uid, id) {
    if (!HASH_RE.test(String(id || ''))) throw fail(404, 'No such device key.');
    const doc = await store.get(COLLECTION, id);
    if (!doc || doc.uid !== uid) throw fail(404, 'No such device key.');
    await store.remove(COLLECTION, id);
    return true;
  }

  /** {id, uid, lastUsedAt} for a presented key, or null. */
  async function resolve(key) {
    if (!KEY_RE.test(String(key || ''))) return null;
    const id = hashKey(key);
    const doc = await store.get(COLLECTION, id);
    if (!doc || !doc.uid) return null;
    return { id, uid: doc.uid, lastUsedAt: doc.lastUsedAt || null };
  }

  /** Stamp lastUsedAt, at most every ten minutes per key. */
  async function touch(found) {
    const t = now();
    if (found.lastUsedAt && t - new Date(found.lastUsedAt) < 10 * 60 * 1000) return;
    try { await store.merge(COLLECTION, found.id, { lastUsedAt: t.toISOString() }); } catch (e) { /* a stamp must not fail a request */ }
  }

  return { list, mint, revoke, resolve, touch };
}

module.exports = { createDevices, createLimiter, bearer, hashKey, newKey, cleanLabel, MAX_PER_USER, KEY_RE, HASH_RE, COLLECTION };
