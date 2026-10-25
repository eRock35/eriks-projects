// Proof keeps NO data of its own. A run is read in the browser, in a Web
// Worker; the report lives in that tab; the snippets a person chooses to
// send for a second opinion are sent once and not kept. The only store on
// the server side is the shared account's (lib/identity-store.js, the
// `identity` database, like every sibling app) - and a memory stand-in for
// it when PROOF_MEMORY=1, so tests and a laptop can drive sign-in, the budget
// and the metered call with no project, no key and no network.
//
// PROOF_MEMORY=1 is refused on Cloud Run (K_SERVICE is set there): a
// deployment whose accounts and spend ledger lived in a process that
// restarts whenever it scales to zero would hand out the free credit again
// on every cold start.
//
// There is no app collection, so PROOF_COLLECTION_PREFIX (set by the lab
// host) has nothing to prefix yet; PREFIX is read here so that anything Proof
// ever stores goes through it from its first write.

const MEMORY = process.env.PROOF_MEMORY === '1';
const PREFIX = process.env.PROOF_COLLECTION_PREFIX || '';
if (MEMORY && process.env.K_SERVICE) {
  throw new Error('PROOF_MEMORY=1 is for local use only and is refused on Cloud Run.');
}

function autoId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function memoryIdentityStore() {
  const cols = new Map(); // collection -> Map(id -> doc)
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
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
      else out[k] = v;
    }
    return out;
  }
  return {
    kind: 'memory',
    async get(c, id) { const d = col(c).get(String(id)); return d ? clone(d) : null; },
    async set(c, id, data) { col(c).set(String(id), clone(data)); },
    async merge(c, id, patch) { col(c).set(String(id), deepMerge(col(c).get(String(id)) || {}, clone(patch))); },
    async remove(c, id) { col(c).delete(String(id)); },
    async add(c, data) { const id = autoId(); col(c).set(id, clone(data)); return id; },
    async bump(c, id, deltas) {
      const cur = col(c).get(String(id)) || {};
      for (const [k, by] of Object.entries(deltas)) if (typeof by === 'number' && Number.isFinite(by)) cur[k] = Number(cur[k] || 0) + by;
      col(c).set(String(id), cur);
    },
    async list(c) { return [...col(c).entries()].map(([id, d]) => ({ id, ...clone(d) })); },
    /** Tests only: every record, to prove what was NOT stored. */
    _dump() { return JSON.stringify([...cols.entries()].map(([p, m]) => [p, [...m.entries()]])); },
  };
}

module.exports = { MEMORY, PREFIX, memoryIdentityStore };
