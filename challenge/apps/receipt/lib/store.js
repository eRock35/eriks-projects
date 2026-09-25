// Receipt's own data, and a memory stand-in for running it without Google.
//
// Two backends behind one small interface:
//
//   - Firestore, the lab database `challenge` (Native mode). What Cloud Run uses.
//   - Memory, when RECEIPT_MEMORY=1. What tests and a laptop use. It exists so
//     the whole app - sign-in included - can be driven end to end with no
//     project, no key and no network. It is refused on Cloud Run (K_SERVICE is
//     set there), because a deployment that silently kept its data in a
//     process that restarts whenever it scales to zero would lose every
//     meeting's receipt and look fine doing it.
//
// Collections are paths: `meetings/<uid>/items/<id>/votes` is a real Firestore
// subcollection, and the memory backend just keys on the same string. A
// person's meetings live under their own uid, so nobody else's id can even
// name them. Each attendee's vote and each logged decision is its own
// document, so two people voting at the same moment write two different
// documents and can never overwrite each other.

const MEMORY = process.env.RECEIPT_MEMORY === '1';
if (MEMORY && process.env.K_SERVICE) {
  throw new Error('RECEIPT_MEMORY=1 is for local use only and is refused on Cloud Run.');
}

function autoId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */

function memoryBackend() {
  const cols = new Map(); // path -> Map(id -> doc)
  const col = (path) => {
    if (!cols.has(path)) cols.set(path, new Map());
    return cols.get(path);
  };
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

  // Firestore's merge is deep for nested maps and replaces arrays. Matching it
  // matters: a test that passes against a shallow merge can hide a write that
  // drops a nested field in production.
  function deepMerge(into, patch) {
    const out = { ...into };
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  return {
    kind: 'memory',
    async get(path, id) {
      const d = col(path).get(String(id));
      return d ? { id: String(id), ...clone(d) } : null;
    },
    async set(path, id, data) {
      col(path).set(String(id), clone(data));
      return { id: String(id), ...clone(data) };
    },
    async merge(path, id, patch) {
      const cur = col(path).get(String(id)) || {};
      col(path).set(String(id), deepMerge(cur, clone(patch)));
    },
    async remove(path, id) {
      col(path).delete(String(id));
    },
    async add(path, data) {
      const id = autoId();
      col(path).set(id, clone(data));
      return id;
    },
    async bump(path, id, deltas) {
      const cur = col(path).get(String(id)) || {};
      for (const [k, by] of Object.entries(deltas)) {
        if (typeof by === 'number' && Number.isFinite(by)) cur[k] = Number(cur[k] || 0) + by;
      }
      col(path).set(String(id), cur);
    },
    /** Add to / remove from an array field without reading it first -
     *  Firestore's arrayUnion / arrayRemove. */
    async arrayAdd(path, id, field, value) {
      const cur = col(path).get(String(id)) || {};
      const arr = Array.isArray(cur[field]) ? cur[field] : [];
      if (!arr.includes(value)) arr.push(value);
      cur[field] = arr;
      col(path).set(String(id), cur);
    },
    async arrayRemove(path, id, field, value) {
      const cur = col(path).get(String(id));
      if (!cur) return;
      cur[field] = (Array.isArray(cur[field]) ? cur[field] : []).filter((x) => x !== value);
      col(path).set(String(id), cur);
    },
    async list(path, { where, orderBy, dir = 'desc', limit } = {}) {
      let rows = [...col(path).entries()].map(([id, d]) => ({ id, ...clone(d) }));
      for (const [f, op, v] of where || []) {
        rows = rows.filter((r) => {
          if (op === '==') return r[f] === v;
          if (op === 'array-contains') return Array.isArray(r[f]) && r[f].includes(v);
          if (op === '>=') return r[f] >= v;
          throw new Error(`memory store: unsupported op ${op}`);
        });
      }
      if (orderBy) {
        rows.sort((a, b) => {
          const x = a[orderBy]; const y = b[orderBy];
          if (x === y) return 0;
          return (x > y ? 1 : -1) * (dir === 'desc' ? -1 : 1);
        });
      }
      return limit ? rows.slice(0, limit) : rows;
    },
    /** Tests only. */
    _reset() { cols.clear(); },
    /** Tests only: every document, so a test can prove what was NOT stored. */
    _dump() { return JSON.stringify([...cols.entries()].map(([p, m]) => [p, [...m.entries()]])); },
  };
}

/* ------------------------------------------------------------------ *
 * Firestore
 * ------------------------------------------------------------------ */

// Receipt shares the lab's database with its sibling apps; a prefix keeps its
// collections apart there (`receipt_meetings`, `receipt_codes`, ...). Letters,
// digits and underscores only, so it can never introduce a path separator.
const PREFIX = String(process.env.RECEIPT_COLLECTION_PREFIX || '').replace(/[^a-z0-9_]/gi, '');

function firestoreBackend() {
  const { Firestore, FieldValue } = require('@google-cloud/firestore');
  const db = new Firestore({
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    databaseId: process.env.FIRESTORE_DATABASE_ID || 'challenge',
    ignoreUndefinedProperties: true,
  });
  return {
    kind: 'firestore',
    async get(path, id) {
      const snap = await db.collection(PREFIX + path).doc(String(id)).get();
      return snap.exists ? { id: snap.id, ...snap.data() } : null;
    },
    async set(path, id, data) {
      await db.collection(PREFIX + path).doc(String(id)).set(data);
      return { id: String(id), ...data };
    },
    async merge(path, id, patch) {
      await db.collection(PREFIX + path).doc(String(id)).set(patch, { merge: true });
    },
    async remove(path, id) {
      await db.collection(PREFIX + path).doc(String(id)).delete();
    },
    async add(path, data) {
      const id = autoId();
      await db.collection(PREFIX + path).doc(id).set(data);
      return id;
    },
    async bump(path, id, deltas) {
      const patch = {};
      for (const [k, by] of Object.entries(deltas)) {
        if (typeof by === 'number' && Number.isFinite(by)) patch[k] = FieldValue.increment(by);
      }
      if (Object.keys(patch).length) await db.collection(PREFIX + path).doc(String(id)).set(patch, { merge: true });
    },
    async arrayAdd(path, id, field, value) {
      await db.collection(PREFIX + path).doc(String(id)).set({ [field]: FieldValue.arrayUnion(value) }, { merge: true });
    },
    async arrayRemove(path, id, field, value) {
      await db.collection(PREFIX + path).doc(String(id)).set({ [field]: FieldValue.arrayRemove(value) }, { merge: true });
    },
    async list(path, { where, orderBy, dir = 'desc', limit } = {}) {
      let q = db.collection(PREFIX + path);
      for (const [f, op, v] of where || []) q = q.where(f, op, v);
      if (orderBy) q = q.orderBy(orderBy, dir);
      if (limit) q = q.limit(limit);
      const snap = await q.get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
  };
}

const store = MEMORY ? memoryBackend() : firestoreBackend();

/** The shared account's store when running in memory. In production identity
 *  uses lib/identity-store.js against the `identity` database, exactly as
 *  every sibling app does. */
function memoryIdentityStore() {
  const m = memoryBackend();
  return {
    async get(c, id) { const d = await m.get(c, id); if (!d) return null; delete d.id; return d; },
    set: m.set, merge: m.merge, remove: m.remove, bump: m.bump, add: m.add,
    async list(c) { return m.list(c); },
  };
}

module.exports = { store, MEMORY, autoId, memoryBackend, memoryIdentityStore };
