// Burnrate keeps NO data of its own. Transcripts are read in the browser and
// never sent; the analysis lives in the browser that made it. The only store
// on the server side is the shared account's (lib/identity-store.js, the
// `identity` database, like every sibling app) - and a memory stand-in for
// it when BURNRATE_MEMORY=1, so tests and a laptop can drive sign-in, the
// budget and the one metered call with no project, no key and no network.
//
// BURNRATE_MEMORY=1 is refused on Cloud Run (K_SERVICE is set there): a
// deployment whose accounts and spend ledger lived in a process that
// restarts whenever it scales to zero would hand out the free credit again
// on every cold start.
//
// There is no app collection, so BURNRATE_COLLECTION_PREFIX (set by the lab
// host) has nothing to prefix. If Burnrate ever stores something, it goes
// through a Firestore backend that prefixes every top-level collection with
// it, as Drip's lib/store.js does.

const MEMORY = process.env.BURNRATE_MEMORY === '1';
if (MEMORY && process.env.K_SERVICE) {
  throw new Error('BURNRATE_MEMORY=1 is for local use only and is refused on Cloud Run.');
}

function autoId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

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
    /**
     * Read, change, write as one step: `fn(current or null)` returns the new
     * document, `null` to delete it, or `undefined` to leave it alone. Calls
     * for one document are queued, so none reads a version another is about
     * to replace - Firestore's transaction, in memory.
     */
    async transact(path, id, fn) {
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
    },
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

function memoryIdentityStore() {
  const m = memoryBackend();
  return {
    async get(c, id) { const d = await m.get(c, id); if (!d) return null; delete d.id; return d; },
    set: m.set, merge: m.merge, remove: m.remove, bump: m.bump, add: m.add,
    async list(c) { return m.list(c); },
    /** Tests only: every record, to prove what was NOT stored. */
    _dump: m._dump,
  };
}

module.exports = { MEMORY, memoryBackend, memoryIdentityStore };
