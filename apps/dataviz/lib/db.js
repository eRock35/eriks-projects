const { Firestore } = require('@google-cloud/firestore');

const db = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  databaseId: process.env.FIRESTORE_DATABASE_ID || 'dataviz',
});

async function get(col, id) {
  const snap = await db.collection(col).doc(String(id)).get();
  return snap.exists ? Object.assign({ id: snap.id }, snap.data()) : null;
}
async function set(col, id, data) {
  await db.collection(col).doc(String(id)).set(data);
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

module.exports = { db, get, set, merge, remove, list };
