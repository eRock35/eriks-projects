// This app's whole point is that anyone can use it without signing up, and
// the interpret step costs Anthropic tokens. An open, model-backed endpoint
// on the public internet with no ceiling is how a hobby project produces a
// four-figure bill overnight.
//
// Two ceilings, because they fail differently: a per-visitor cap stops one
// person hammering it, and a global cap stops a thousand people doing it
// politely. Counters live in Firestore under today's date and are never
// cleaned up by hand - yesterday's document simply stops being read.

const db = require('./db');

const PER_VISITOR = Number(process.env.QUOTA_PER_VISITOR || 15);
const PER_USER = Number(process.env.QUOTA_PER_USER || 60);
const GLOBAL = Number(process.env.QUOTA_GLOBAL || 600);

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** A visitor key that is not a stored IP address. The salt is the session
 *  secret, so this cannot be reversed into an address, and it rotates with
 *  the date so nothing accumulates across days. */
function visitorKey(req) {
  const crypto = require('crypto');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  return crypto.createHmac('sha256', (process.env.SESSION_SECRET || 'salt') + today())
    .update(ip).digest('base64url').slice(0, 22);
}

async function check(req) {
  const day = today();
  const doc = (await db.get('usage', day)) || { total: 0, visitors: {}, users: {} };
  const limitLabel = req.user ? 'today' : 'today — sign in for more';

  if ((doc.total || 0) >= GLOBAL) {
    const err = new Error('This has been busy today and has hit its daily ceiling. It resets at midnight UTC.');
    err.status = 429;
    throw err;
  }
  if (req.user) {
    const used = (doc.users || {})[req.user.id] || 0;
    if (used >= PER_USER) {
      const err = new Error(`You have made ${PER_USER} visuals ${limitLabel}. It resets at midnight UTC.`);
      err.status = 429;
      throw err;
    }
  } else {
    const key = visitorKey(req);
    const used = (doc.visitors || {})[key] || 0;
    if (used >= PER_VISITOR) {
      const err = new Error(`You have made ${PER_VISITOR} visuals ${limitLabel}. It resets at midnight UTC.`);
      err.status = 429;
      throw err;
    }
  }
  return doc;
}

async function record(req) {
  const day = today();
  const doc = (await db.get('usage', day)) || { total: 0, visitors: {}, users: {} };
  doc.total = (doc.total || 0) + 1;
  if (req.user) {
    doc.users = doc.users || {};
    doc.users[req.user.id] = (doc.users[req.user.id] || 0) + 1;
  } else {
    const key = visitorKey(req);
    doc.visitors = doc.visitors || {};
    doc.visitors[key] = (doc.visitors[key] || 0) + 1;
  }
  await db.set('usage', day, doc);
  return doc;
}

async function remaining(req) {
  const doc = (await db.get('usage', today())) || { total: 0, visitors: {}, users: {} };
  if (req.user) return Math.max(0, PER_USER - ((doc.users || {})[req.user.id] || 0));
  return Math.max(0, PER_VISITOR - ((doc.visitors || {})[visitorKey(req)] || 0));
}

module.exports = { check, record, remaining, PER_VISITOR, PER_USER, GLOBAL };
