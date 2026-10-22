// Wishlist links: made by a browser with no account, opened by the person
// the list is for, with no account.
//
// What a wishlist document holds - and nothing else:
//   wishlists/<tokenHash> = {first, adds: [{id, text, link, price, at}],
//     createdAt, expiresAt, ownerHash, creator}
//
// - `first` is the person's first name as the owner typed it (one word, and
//   all the friend's page ever shows). No surname, no relationship, no dates,
//   none of the owner's ideas - so a surprise stays a surprise.
// - `adds` are the friend's own ideas, waiting for the owner's phone to
//   collect them. Collecting removes them from here: once they are on the
//   owner's list, the server keeps no copy.
// - The document id is sha256(token): the link's token is never stored, so
//   someone reading the database (or a backup) cannot open or add to a list.
//   Tokens are 16 random bytes (128 bits), base64url, 22 characters.
// - `ownerHash` is sha256(owner key + id). The owner key is a second secret
//   handed only to the browser that made the link (kept with the person on
//   that phone, and in the account's circle when signed in), so the friend's
//   link can never collect or revoke.
// - `creator` is what the open-links cap counts by: an HMAC of the account
//   id when signed in, else a hash of this browser's HttpOnly device key.
//   Neither is shown to anyone, and neither is an id or an email.

const crypto = require('crypto');
const Core = require('../public/kindly-core');

const LIMITS = {
  createsPerIp: 20,                   // new links one address may make...
  createsWindowMs: 60 * 60 * 1000,    // ...an hour
  createsPerInstance: 2000,           // and all addresses together, per instance
  missesPerIp: 30,                    // distinct wrong tokens one address may try...
  missWindowMs: 15 * 60 * 1000,       // ...in 15 minutes
  writesPerIp: 300,                   // any writes, per address...
  writesWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
  addsPerIp: 40,                      // ideas one address may add, across links...
  addsWindowMs: 60 * 60 * 1000,       // ...an hour
  openPerCreator: 50,                 // live links per account or device
  pending: Core.LIMITS.wishAdds,      // ideas waiting on one link
  liveDays: Core.LIMITS.wishDays,     // a link lasts this long
  savesPerAccount: 240,               // circle writes per account...
  savesWindowMs: 10 * 60 * 1000,      // ...in 10 minutes
};

const httpError = Core.fail;

const newToken = () => crypto.randomBytes(16).toString('base64url'); // 128 bits, 22 characters
const newKey = () => crypto.randomBytes(16).toString('base64url');
const isToken = (v) => typeof v === 'string' && Core.TOKEN_RE.test(v);
const sha = (s) => crypto.createHash('sha256').update(s).digest('base64url');
/** The document id for a token. */
const docId = (token) => sha(`kindly wishlist v1:${token}`).slice(0, 32);
const ownerHash = (key, id) => sha(`${key}:${id}`).slice(0, 32);
/** A browser's device key as the cap counts it. */
const deviceTag = (key) => `d:${sha(`kindly device v1:${key}`).slice(0, 27)}`;

function derived(secret, purpose) { return crypto.createHmac('sha256', String(secret)).update(purpose).digest(); }
/** The account, as Kindly stores it: an HMAC of the account id under a key
 *  derived from the session secret. Never the id, never the email. */
function accountTag(uid, secret) {
  return crypto.createHmac('sha256', derived(secret, 'kindly circle owner v1')).update(String(uid)).digest('base64url').slice(0, 27);
}
function sameHash(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function expired(w, now) { return !w || !w.expiresAt || Date.parse(w.expiresAt) <= now; }

/** A new link's document (without the owner and creator fields). */
function newWishlist(input, now) {
  const first = Core.firstName(input && input.first);
  if (!first) throw httpError(400, 'Give the link a first name.');
  return { first, adds: [], createdAt: new Date(now).toISOString(), expiresAt: new Date(now + LIMITS.liveDays * Core.DAY_MS).toISOString() };
}

/** One idea from the friend, cleaned. */
function cleanAdd(input, now) {
  const b = input && typeof input === 'object' ? input : {};
  const text = Core.cleanText(b.text, Core.LIMITS.idea);
  if (!text) throw httpError(400, 'Write the idea first.');
  const price = typeof b.price === 'string' || typeof b.price === 'number' ? Core.parseMoney(typeof b.price === 'number' ? String(b.price) : b.price) : null;
  return { id: `w${crypto.randomBytes(6).toString('base64url').replace(/[_-]/g, 'x')}`, text, link: Core.cleanLink(b.link), price, at: now };
}

/** What each side sees. The friend: the first name, how long the link
 *  lasts and how many more ideas fit - nothing else. The owner: the ideas
 *  waiting too. Tested by the exact key list. */
function view(w, actor) {
  const room = Math.max(0, LIMITS.pending - (w.adds || []).length);
  const out = { first: w.first, expiresAt: w.expiresAt, room };
  if (actor === 'owner') out.adds = (w.adds || []).map((a) => ({ id: a.id, text: a.text, link: a.link || '', price: a.price ?? null, at: a.at }));
  return out;
}

module.exports = {
  LIMITS, httpError, newToken, newKey, isToken, docId, ownerHash, deviceTag, accountTag, sameHash, expired, newWishlist, cleanAdd, view,
};
