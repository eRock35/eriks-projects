// "Most played" for the sample gallery.
//
// One document, counters/samples, one field per sample id, moved with
// FieldValue.increment so two plays at once both count and no read happens on
// the write path. Nothing about WHO played is stored: no uid, no IP, no
// cookie. The only per-visitor state is an in-memory throttle keyed by a
// salted hash of the address, which dies with the instance and exists so one
// person holding the button down cannot move the ranking by themselves.
//
// The page sends a play once per sample per browser session and never from a
// framed preview or the ?tour=1 demo (the landing page's phone previews tap
// samples on a loop, and counting those would rank scroll depth, which is the
// mistake beacon.js already made once).

const crypto = require('crypto');
const { FieldValue } = require('@google-cloud/firestore');

const DOC = ['counters', 'samples'];
const THROTTLE_MS = 30 * 60 * 1000;     // one play per sample per address per half hour
const MAX_KEYS = 20000;                 // bound the throttle's memory
const READ_TTL_MS = 60 * 1000;          // the gallery's counts may be a minute old

function create({ db, datasets, salt = () => process.env.SESSION_SECRET || 'dataviz' }) {
  const recent = new Map();
  let cached = null;
  let cachedAt = 0;
  let inflight = null;

  function keyFor(ip, id) {
    return crypto.createHmac('sha256', String(salt())).update(`${ip}|${id}`).digest('base64url').slice(0, 22);
  }

  /** Count one play. Returns {counted:boolean}. Unknown ids throw 404. */
  async function record(id, ip, now = Date.now()) {
    const ds = datasets.get(String(id || ''));
    if (!ds) throw Object.assign(new Error('No such sample.'), { status: 404 });
    const k = keyFor(String(ip || ''), ds.id);
    const last = recent.get(k);
    if (last && now - last < THROTTLE_MS) return { counted: false };
    if (recent.size >= MAX_KEYS) {
      for (const [kk, at] of recent) { if (now - at >= THROTTLE_MS) recent.delete(kk); }
      if (recent.size >= MAX_KEYS) recent.clear();
    }
    recent.set(k, now);
    await db.db.collection(DOC[0]).doc(DOC[1]).set({ [ds.id]: FieldValue.increment(1) }, { merge: true });
    if (cached) cached = Object.assign({}, cached, { [ds.id]: (cached[ds.id] || 0) + 1 });
    return { counted: true };
  }

  /** {<sampleId>: plays} for every sample, zero where none. Never throws: a
   *  gallery without counts is still a gallery. */
  async function counts(now = Date.now()) {
    if (cached && now - cachedAt < READ_TTL_MS) return cached;
    if (!inflight) {
      inflight = db.get(DOC[0], DOC[1]).then((doc) => {
        const out = {};
        for (const d of datasets.list()) {
          const n = doc ? Number(doc[d.id]) : 0;
          out[d.id] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
        }
        cached = out; cachedAt = Date.now();
        return out;
      }).catch((err) => {
        console.error('[plays] could not read counts', err.message);
        return cached || {};
      }).finally(() => { inflight = null; });
    }
    return inflight;
  }

  return { record, counts, _recent: recent };
}

module.exports = { create, THROTTLE_MS };
