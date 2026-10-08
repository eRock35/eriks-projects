// Pickup's own data, and a memory stand-in for running it without Google.
//
// Two backends behind one small interface:
//
//   - Firestore, the lab database `challenge` (Native mode). What Cloud Run uses.
//   - Memory, when PICKUP_MEMORY=1. What tests and a laptop use. It exists so
//     the whole app - sign-in included - can be driven end to end with no
//     project, no key and no network. It is refused on Cloud Run (K_SERVICE is
//     set there), because a deployment that silently kept its data in a
//     process that restarts whenever it scales to zero would lose every
//     group's week and look fine doing it.
//
// A group online is one document (`groups/<id>`) whose games are a map keyed
// by game id, and each game's answers, guests, payments and votes are maps
// keyed by person. The busy writes - In / Maybe / Out, a +1, Paid, a vote, a
// score - go through `transactKeys`: read the document inside a transaction,
// decide with the core, then write ONLY the keys that changed
// (`games.<gid>.rsvps.<pid>`, ...) with Firestore's update(), never the whole
// document. Two phones answering at the same moment therefore cannot write
// back a copy missing the other's answer (trip-planner's packing lesson, as
// Chorus and Shelf Life do it). Never a photo, never an email.

const MEMORY = process.env.PICKUP_MEMORY === '1';
if (MEMORY && process.env.K_SERVICE) {
  throw new Error('PICKUP_MEMORY=1 is for local use only and is refused on Cloud Run.');
}

function autoId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */

function memoryBackend() {
  const cols = new Map(); // path -> Map(id -> doc)
  const locks = new Map(); // path/id -> the queue of transactions on it
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

  /** Read, change, write as one step - see `transact` below. */
  async function transact(path, id, fn) {
    const key = `${path}/${id}`;
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const chain = prev.then(() => mine);
    locks.set(key, chain);
    await prev;
    try {
      const d = col(path).get(String(id));
      const cur = d ? { id: String(id), ...clone(d) } : null;
      // A turn of the event loop between the read and the write, as a real
      // network round trip would have: without the queue, a second call
      // would read the same version here and one write would be lost.
      await new Promise((r) => setImmediate(r));
      const next = await fn(cur);
      if (next === undefined) return cur;
      if (next === null) { col(path).delete(String(id)); return null; }
      const { id: _drop, ...data } = next;
      col(path).set(String(id), clone(data));
      return { id: String(id), ...clone(data) };
    } finally {
      release();
      if (locks.get(key) === chain) locks.delete(key);
    }
  }


  /** Read, decide, then write only the named keys: `fn(cur)` returns
   *  {set: {'a.b': value}, del: ['a.c']} or undefined to leave it alone.
   *  Queued with `transact`, like Firestore's transaction + update(). */
  async function transactKeys(path, id, fn) {
    let out = null;
    await transact(path, id, async (cur) => {
      const patch = await fn(cur);
      if (!patch) { out = cur; return undefined; }
      if (!cur) throw Object.assign(new Error('No such document.'), { status: 404, expose: true });
      const next = clone(cur);
      for (const [k, v] of Object.entries(patch.set || {})) setPath(next, k, clone(v));
      for (const k of patch.del || []) delPath(next, k);
      out = next;
      return next;
    });
    return out;
  }
  function setPath(o, key, v) {
    const parts = key.split('.');
    let at = o;
    for (const p of parts.slice(0, -1)) { if (!at[p] || typeof at[p] !== 'object') at[p] = {}; at = at[p]; }
    at[parts[parts.length - 1]] = v;
  }
  function delPath(o, key) {
    const parts = key.split('.');
    let at = o;
    for (const p of parts.slice(0, -1)) { if (!at[p] || typeof at[p] !== 'object') return; at = at[p]; }
    delete at[parts[parts.length - 1]];
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
    /** An increment, queued behind any transaction on the same document -
     *  Firestore's increment is atomic with them, so this must be too.
     *  `{mustExist: true}` leaves a missing document alone (a group deleted a
     *  moment ago must not come back as a stub). */
    async bump(path, id, deltas, opts) {
      await transact(path, id, (cur) => {
        if (!cur && opts && opts.mustExist) return undefined;
        const next = { ...(cur || {}) };
        for (const [k, by] of Object.entries(deltas)) {
          if (typeof by === 'number' && Number.isFinite(by)) next[k] = Number(next[k] || 0) + by;
        }
        return next;
      });
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
    /**
     * Read, change, write as one step: `fn(current or null)` returns the new
     * document, `null` to delete it, or `undefined` to leave it alone. Calls
     * for one document are queued, so none reads a version another is about
     * to replace - Firestore's transaction, in memory.
     */
    transact,
    transactKeys,
    /** Tests only: the same read-change-write WITHOUT the queue, to show the
     *  queue is what keeps two claims. */
    async _unsafeUpdate(path, id, fn) {
      const d = col(path).get(String(id));
      const cur = d ? { id: String(id), ...clone(d) } : null;
      await new Promise((r) => setImmediate(r));
      const next = await fn(cur);
      const { id: _drop, ...data } = next;
      col(path).set(String(id), clone(data));
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

// Pickup shares the lab's database with its sibling apps; a prefix keeps
// its collections apart there (`pickup_groups`). Letters,
// digits and underscores only, so it can never introduce a path separator.
const PREFIX = String(process.env.PICKUP_COLLECTION_PREFIX || '').replace(/[^a-z0-9_]/gi, '');

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
    async bump(path, id, deltas, opts) {
      const patch = {};
      for (const [k, by] of Object.entries(deltas)) {
        if (typeof by === 'number' && Number.isFinite(by)) patch[k] = FieldValue.increment(by);
      }
      if (!Object.keys(patch).length) return;
      const ref = db.collection(PREFIX + path).doc(String(id));
      // update(), not set(merge), when it must exist: bumping a group that
      // was just deleted must not bring back a stub of it (5 = NOT_FOUND).
      if (opts && opts.mustExist) await ref.update(patch).catch((e) => { if (!e || e.code !== 5) throw e; });
      else await ref.set(patch, { merge: true });
    },
    async arrayAdd(path, id, field, value) {
      await db.collection(PREFIX + path).doc(String(id)).set({ [field]: FieldValue.arrayUnion(value) }, { merge: true });
    },
    async arrayRemove(path, id, field, value) {
      await db.collection(PREFIX + path).doc(String(id)).set({ [field]: FieldValue.arrayRemove(value) }, { merge: true });
    },
    async transact(path, id, fn) {
      const ref = db.collection(PREFIX + path).doc(String(id));
      return db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        const cur = snap.exists ? { id: snap.id, ...snap.data() } : null;
        const next = await fn(cur);
        if (next === undefined) return cur;
        if (next === null) { t.delete(ref); return null; }
        const { id: _drop, ...data } = next;
        t.set(ref, data);
        return { id: String(id), ...data };
      });
    },
    async transactKeys(path, id, fn) {
      const ref = db.collection(PREFIX + path).doc(String(id));
      return db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        const cur = snap.exists ? { id: snap.id, ...snap.data() } : null;
        const patch = await fn(cur);
        if (!patch) return cur;
        if (!cur) throw Object.assign(new Error('No such document.'), { status: 404, expose: true });
        const fields = {};
        for (const [k, v] of Object.entries(patch.set || {})) fields[k] = v;
        for (const k of patch.del || []) fields[k] = FieldValue.delete();
        if (Object.keys(fields).length) t.update(ref, fields);
        return cur;
      });
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
