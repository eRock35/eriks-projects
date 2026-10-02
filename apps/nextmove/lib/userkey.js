// The only thing about a person that ever reaches BigQuery: a keyed hash of
// their account id. HMAC-SHA256 under a key DERIVED from
// IDENTITY_SESSION_SECRET for this one purpose, so it can never be read as a
// session and is useless without the secret. Never the uid (which is the
// base64 of an email address), never an email, never a name.
//
// Without the secret there is no key - and no fallback key: an HMAC under ''
// would be a hash anyone reading this public repo could compute. Callers
// refuse to write instead.
//
// Rotating IDENTITY_SESSION_SECRET changes every key: old fits stop showing
// (they are still there, under keys nobody derives any more) and
// delete-account could no longer find them. Treat a rotation as needing a
// re-key: see CLAUDE.md.

const crypto = require('crypto');

const PURPOSE = 'nextmove user key v1';

function keyFor(uid, secret = process.env.IDENTITY_SESSION_SECRET) {
  if (!uid) throw new Error('no uid');
  if (!secret) throw Object.assign(new Error('IDENTITY_SESSION_SECRET is not set - refusing to derive user keys.'), { code: 'no-secret' });
  const k = crypto.createHmac('sha256', String(secret)).update(PURPOSE).digest();
  return crypto.createHmac('sha256', k).update(String(uid)).digest('hex').slice(0, 40);
}

module.exports = { keyFor, PURPOSE };
