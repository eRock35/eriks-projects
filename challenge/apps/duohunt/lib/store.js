// Duo Hunt keeps NO data of its own. A check is a question asked of Apple
// and Best Buy on someone's tap and answered straight back; the ZIP rides in
// that one request's body and nowhere else - never in a URL our logs record,
// never in a document, never in a log line. The pick, the ZIP, the carrier
// notes and the tab's history live in the person's browser.
//
// The only store is the shared account's (lib/identity-store.js, the
// `identity` database, like every sibling), mounted for the verify banner and
// for consistency - nothing in Duo Hunt needs an account - and a memory
// stand-in for it when DUOHUNT_MEMORY=1, so tests and a laptop need no
// project and no network.
//
// DUOHUNT_COLLECTION_PREFIX (set by the lab host to `duohunt_`) has nothing
// to prefix: there is no app collection. It is read here so that anything
// Duo Hunt ever stores goes through it from its first write. Storing a ZIP
// would need a reason good enough to undo this file's first line.

const MEMORY = process.env.DUOHUNT_MEMORY === '1';
const PREFIX = process.env.DUOHUNT_COLLECTION_PREFIX || '';
if (MEMORY && process.env.K_SERVICE) {
  throw new Error('DUOHUNT_MEMORY=1 is for local use only and is refused on Cloud Run.');
}

/** The shared account, in memory (tests and local runs only). */
function memoryIdentityStore() {
  const cols = new Map();
  const col = (c) => { if (!cols.has(c)) cols.set(c, new Map()); return cols.get(c); };
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const deepMerge = (into, patch) => {
    const out = { ...into };
    for (const [k, v] of Object.entries(patch)) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
    }
    return out;
  };
  return {
    async get(c, id) { const d = col(c).get(String(id)); return d ? clone(d) : null; },
    async set(c, id, data) { col(c).set(String(id), clone(data)); },
    async merge(c, id, patch) { col(c).set(String(id), deepMerge(col(c).get(String(id)) || {}, clone(patch))); },
    async remove(c, id) { col(c).delete(String(id)); },
    async add(c, data) { const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; col(c).set(id, clone(data)); return id; },
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
