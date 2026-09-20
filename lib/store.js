// Tiny document store with two drivers behind one interface.
//
// In production this is Firestore (a NAMED Native-mode database — never
// `(default)`, which on this project is a legacy Datastore-mode database tied
// to old App Engine infrastructure). Locally, with no credentials and no
// FIRESTORE_DATABASE_ID set, it falls back to an in-process memory driver so
// the site runs and the writing flow can be exercised without GCP.
//
// The memory driver is deliberately NOT persisted. Cloud Run's container disk
// is ephemeral, so a file-backed fallback would look like it worked and then
// quietly lose every post and subscriber on the next revision.

const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '';

let driver = null;

function memoryDriver() {
  const data = new Map(); // collection -> Map(id -> doc)
  const col = (name) => {
    if (!data.has(name)) data.set(name, new Map());
    return data.get(name);
  };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    kind: 'memory',
    async get(collection, id) {
      return clone(col(collection).get(id)) || null;
    },
    async set(collection, id, value) {
      col(collection).set(id, clone(value));
    },
    async update(collection, id, patch) {
      const current = col(collection).get(id);
      if (!current) throw new Error('not found');
      col(collection).set(id, Object.assign({}, current, clone(patch)));
    },
    async remove(collection, id) {
      col(collection).delete(id);
    },
    async list(collection, { where = [], orderBy = null, desc = false, limit = 0 } = {}) {
      let rows = Array.from(col(collection).entries()).map(([id, v]) => Object.assign({ id }, clone(v)));
      for (const [field, op, value] of where) {
        rows = rows.filter((r) => (op === '==' ? r[field] === value : true));
      }
      if (orderBy) {
        rows.sort((a, b) => String(a[orderBy] || '').localeCompare(String(b[orderBy] || '')));
        if (desc) rows.reverse();
      }
      return limit ? rows.slice(0, limit) : rows;
    },
    async count(collection, where = []) {
      return (await this.list(collection, { where })).length;
    },
  };
}

function firestoreDriver() {
  const { Firestore } = require('@google-cloud/firestore');
  const db = new Firestore({
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    databaseId: DATABASE_ID,
  });
  const ref = (collection, id) => db.collection(collection).doc(id);
  return {
    kind: 'firestore',
    async get(collection, id) {
      const doc = await ref(collection, id).get();
      return doc.exists ? doc.data() : null;
    },
    async set(collection, id, value) {
      await ref(collection, id).set(value);
    },
    async update(collection, id, patch) {
      await ref(collection, id).set(patch, { merge: true });
    },
    async remove(collection, id) {
      await ref(collection, id).delete();
    },
    async list(collection, { where = [], orderBy = null, desc = false, limit = 0 } = {}) {
      let q = db.collection(collection);
      for (const [field, op, value] of where) q = q.where(field, op, value);
      if (orderBy) q = q.orderBy(orderBy, desc ? 'desc' : 'asc');
      if (limit) q = q.limit(limit);
      const snap = await q.get();
      return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    },
    async count(collection, where = []) {
      let q = db.collection(collection);
      for (const [field, op, value] of where) q = q.where(field, op, value);
      const snap = await q.count().get();
      return snap.data().count;
    },
  };
}

function store() {
  if (driver) return driver;
  driver = DATABASE_ID ? firestoreDriver() : memoryDriver();
  if (driver.kind === 'memory') {
    console.warn('[store] FIRESTORE_DATABASE_ID is unset — using the in-memory driver. Nothing is persisted.');
  }
  return driver;
}

module.exports = { store, databaseId: () => DATABASE_ID };
