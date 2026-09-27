// A teammate's id as the page sees it (2026-09-27).
//
// An account's uid is base64url(lowercased email), so a uid sent to a page is
// that person's email address. Teammates see each other's names, never their
// uids: people rows, removals and the leaderboard carry this instead - an
// HMAC of the event (or team) id and the uid under a key derived from the
// identity session secret. It is stable, so the page can name a person to
// remove; it differs per event, so two events cannot be joined on it; and
// nobody without the secret can turn it back into an email or test a guess.
// The server maps it back by computing it for each member.

const crypto = require('crypto');

/**
 * @param secret  () => the identity session secret ('' when unset)
 * @param label   what the key is for, e.g. 'booth member id v1'
 * @returns (scope, uid) => a 22-character opaque id
 */
function create(secret, label) {
  let key = null;
  let from = null;
  const keyOf = () => {
    const s = secret() || '';
    if (key && from === s) return key;
    // No secret means no signed-in user can exist (identity cannot sign a
    // session), but never derive from an empty key: then anyone could test
    // a guessed email against an id. A random key per process instead.
    from = s;
    key = crypto.createHmac('sha256', s || crypto.randomBytes(32)).update(label).digest();
    return key;
  };
  return (scope, uid) => crypto.createHmac('sha256', keyOf()).update(`${scope}\n${uid}`).digest('base64url').slice(0, 22);
}

const MEMBER_ID_RE = /^[A-Za-z0-9_-]{22}$/;

module.exports = { create, MEMBER_ID_RE };
