// Tieout keeps NOTHING of its own: no statement, no row, no file, no
// collection in the lab's database. A statement PDF or photo is read once by
// the model inside one request and dropped; the rows go back to the page,
// which keeps them in this browser only. The one store here is the shared
// account's (identity), and a memory stand-in for it so the app - sign-in
// included - can be driven end to end with no project, no key and no network.
//
// TIEOUT_MEMORY=1 is refused on Cloud Run (K_SERVICE is set there): a
// deployment whose accounts and spend ledger lived in a process that restarts
// whenever it scales to zero would hand out the free credit again and again.
//
// TIEOUT_COLLECTION_PREFIX is read the way every lab app reads it, so that a
// collection added later is prefixed from its first write. Today there is no
// collection to prefix (tested: nothing but identity is ever written).

const MEMORY = process.env.TIEOUT_MEMORY === '1';
if (MEMORY && process.env.K_SERVICE) {
  throw new Error('TIEOUT_MEMORY=1 is for local use only and is refused on Cloud Run.');
}

const PREFIX = String(process.env.TIEOUT_COLLECTION_PREFIX || '').replace(/[^a-z0-9_]/gi, '');

function autoId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** The memory backend the shared account runs on in tests and `npm run dev`. */
function memoryBackend() {
  const cols = new Map(); // path -> Map(id -> doc)
  const col = (path) => {
    if (!cols.has(path)) cols.set(path, new Map());
    return cols.get(path);
  };
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  // Firestore's merge is deep for nested maps and replaces arrays.
  function deepMerge(into, patch) {
    const out = { ...into };
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
      else out[k] = v;
    }
    return out;
  }
  return {
    kind: 'memory',
    async get(path, id) {
      const d = col(path).get(String(id));
      return d ? { id: String(id), ...clone(d) } : null;
    },
    async set(path, id, data) { col(path).set(String(id), clone(data)); return { id: String(id), ...clone(data) }; },
    async merge(path, id, patch) {
      const cur = col(path).get(String(id)) || {};
      col(path).set(String(id), deepMerge(cur, clone(patch)));
    },
    async remove(path, id) { col(path).delete(String(id)); },
    async add(path, data) { const id = autoId(); col(path).set(id, clone(data)); return id; },
    async bump(path, id, deltas) {
      const cur = col(path).get(String(id)) || {};
      for (const [k, by] of Object.entries(deltas)) if (typeof by === 'number' && Number.isFinite(by)) cur[k] = Number(cur[k] || 0) + by;
      col(path).set(String(id), cur);
    },
    async list(path, { where, limit } = {}) {
      let rows = [...col(path).entries()].map(([id, d]) => ({ id, ...clone(d) }));
      for (const [f, op, v] of where || []) {
        rows = rows.filter((r) => {
          if (op === '==') return r[f] === v;
          if (op === 'array-contains') return Array.isArray(r[f]) && r[f].includes(v);
          if (op === '>=') return r[f] >= v;
          throw new Error(`memory store: unsupported op ${op}`);
        });
      }
      return limit ? rows.slice(0, limit) : rows;
    },
    /** Tests only: the collections that exist. */
    _collections() { return [...cols.keys()]; },
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
    _collections: m._collections,
    _dump: m._dump,
  };
}

module.exports = { MEMORY, PREFIX, memoryIdentityStore };
