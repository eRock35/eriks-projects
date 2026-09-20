// Firestore, in its own named database so this app shares nothing with the
// others. `(default)` on this project is legacy Datastore mode and must never
// be used - see the note repeated in every sibling app's CLAUDE.md.

const { Firestore, FieldValue } = require('@google-cloud/firestore');

const db = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  databaseId: process.env.FIRESTORE_DATABASE_ID || 'friction',
});

async function get(col, id) {
  const snap = await db.collection(col).doc(String(id)).get();
  return snap.exists ? Object.assign({ id: snap.id }, snap.data()) : null;
}

async function set(col, id, data) {
  await db.collection(col).doc(String(id)).set(data, { merge: false });
  return Object.assign({ id: String(id) }, data);
}

async function merge(col, id, patch) {
  await db.collection(col).doc(String(id)).set(patch, { merge: true });
}

async function remove(col, id) {
  await db.collection(col).doc(String(id)).delete();
}

async function list(col, { where, orderBy, dir = 'desc', limit } = {}) {
  let q = db.collection(col);
  if (where) for (const [f, op, v] of where) q = q.where(f, op, v);
  if (orderBy) q = q.orderBy(orderBy, dir);
  if (limit) q = q.limit(limit);
  const snap = await q.get();
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}

/** Seen-item ids, so a scan never pays to re-read what it already read.
 *  Stored one doc per source batch rather than one per item: a scan checks
 *  a few hundred ids at a time and a single read beats hundreds. */
async function seenSet(source) {
  const doc = await get('seen', source);
  return new Set((doc && doc.ids) || []);
}

async function saveSeen(source, ids) {
  // Keep the window bounded. Anything older has long since fallen off the
  // "recent" feeds these sources return, so it cannot come back as new.
  const capped = ids.slice(-4000);
  await set('seen', source, { ids: capped, updatedAt: new Date().toISOString() });
}

module.exports = { db, FieldValue, get, set, merge, remove, list, seenSet, saveSeen };
