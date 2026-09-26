// Erik's ideas inbox: somewhere to text an idea from anywhere - "Hey Siri,
// Idea" on the phone, or the box at /admin/inbox - and have it kept, where
// the daily Claude run can read it, act on it and say what it did.
//
// Deliberately NOT reminders. Erik dropped them: nothing here has a due date,
// nothing pings anyone, and nothing runs on a timer. An item is text plus a
// status and a note. The service is billed per request, so all of it happens
// inside the request that asked for it.
//
// Two doors, one collection:
//   - the admin session (the page), exactly like the rest of /admin;
//   - a bearer token for the Siri Shortcut and the daily run. The token is
//     generated on the page, shown ONCE, and only its SHA-256 is kept
//     (control/inbox-token). Generating a new one replaces the old, so a
//     phone that is lost is one tap away from locked out.
//
// No model call anywhere in this file. "Maybe act on" is the daily run's job,
// on its own budget, reading through scripts/inbox.js.

const crypto = require('crypto');

const COLLECTION = 'inbox';
const TOKEN_COLLECTION = 'control';
const TOKEN_DOC = 'inbox-token';

const KINDS = ['idea', 'app idea', 'feature', 'bug', 'note'];
const STATUSES = ['new', 'seen', 'doing', 'done', 'parked'];

const MAX_TEXT = 2000;
const MAX_NOTE = 1000;
const MAX_TAGS = 8;
const MAX_TAG = 30;
// Enough for years of ideas, small enough that listing everything is a few
// hundred reads rather than a bill. Delete what is done to make room.
const MAX_TOTAL = 2000;
// A runaway Shortcut (or a leaked token) fills a day, not the inbox.
const MAX_PER_DAY = 100;
const LIST_LIMIT = 200;
const BODY_LIMIT = '128kb';

/* ---------- text ---------- */

/** Printable text only: control characters out (newlines and tabs kept),
 *  Windows line endings folded, runs of blank lines collapsed, trimmed, and
 *  cut at `max`. Angle brackets are KEPT - "a < b" is a fine idea - because
 *  every place that draws this escapes it; see site/assets/inbox.js. */
function cleanText(value, max = MAX_TEXT) {
  let s = typeof value === 'string' ? value : (value === null || value === undefined ? '' : String(value));
  s = s.replace(/\r\n?/g, '\n')
    // C0 controls except \t and \n, DEL, C1 controls, and the bidi overrides
    // that make text display in a different order from how it is stored.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (s.length > max) s = s.slice(0, max).trimEnd();
  return s;
}

// Order matters: the first rule that matches wins, so a sentence that says
// "bug" and "feature" is a bug. Word boundaries throughout - "debugging my
// app idea" is not a bug report, and "notebook" is not a note.
const KIND_RULES = [
  ['bug', /\b(bugs?|broken|crash(es|ed|ing)?|glitch(es|y)?|error|doesn[\u2019']?t work|does not work|not working|isn[\u2019']?t working|won[\u2019']?t (load|open|work)|fails?|failing)\b/i],
  ['app idea', /\b(app idea|an app|new app|app (that|for|where|which)|build an? (app|site|website|tool)|website (that|for|where))\b/i],
  ['feature', /\b(feature|add (a|an|the)\b|should (have|let|show|be able)|would be (nice|cool|great)|let me\b|option to|support for|setting for|a button)\b/i],
  ['note', /\b(note to self|note:|remember (that|to)|for the record|fyi|todo)\b/i],
];

/** A best guess, cheap and editable. Nobody should have to say a category
 *  out loud to Siri; if the guess is wrong, one tap on the page fixes it. */
function guessKind(text) {
  const s = String(text || '');
  for (const [kind, re] of KIND_RULES) if (re.test(s)) return kind;
  return 'idea';
}

// "Bug: the countdown is a day off" - saying the kind first files it there
// and the label is taken off the front.
const PREFIX_RE = /^\s*(app idea|idea|feature|bug|note)\s*[:,.\-–—]\s*/i;

function normaliseKind(value) {
  const k = String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (k === 'app') return 'app idea';
  return KINDS.includes(k) ? k : null;
}

function normaliseStatus(value) {
  const s = String(value || '').trim().toLowerCase();
  return STATUSES.includes(s) ? s : null;
}

/** #hashtags in the text, plus any given explicitly. Lower-case, a-z0-9 and
 *  dashes, bounded in count and length. */
function cleanTags(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = String(raw || '').toLowerCase().replace(/^#/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_TAG);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function tagsIn(text) {
  return cleanTags((String(text || '').match(/(?:^|\s)#([a-z0-9][a-z0-9-]{0,29})/gi) || []).map((m) => m.trim()));
}

/**
 * What arrived, whichever way it arrived: a JSON object ({text, kind}), a
 * form, or a bare text/plain body (the simplest Shortcut). An explicit kind
 * wins, then a spoken "Bug:" prefix, then the guess.
 */
function readInput(body) {
  let text = '';
  let kind = null;
  if (typeof body === 'string') text = body;
  else if (body && typeof body === 'object') {
    text = typeof body.text === 'string' ? body.text : (body.text === undefined || body.text === null ? '' : String(body.text));
    kind = normaliseKind(body.kind);
  }
  text = cleanText(text);
  const prefix = text.match(PREFIX_RE);
  if (prefix) {
    const rest = text.slice(prefix[0].length).trim();
    // "Idea:" with nothing after it is not an idea about nothing.
    if (rest) {
      if (!kind) kind = normaliseKind(prefix[1]);
      text = rest.charAt(0).toUpperCase() + rest.slice(1);
    }
  }
  return { text, kind: kind || guessKind(text), tags: tagsIn(text) };
}

/** What Siri reads back. Short enough to hear, long enough to know which. */
function savedMessage(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return `Saved: ${s.length > 60 ? `${s.slice(0, 60).trimEnd()}…` : s}`;
}

/* ---------- the token ---------- */

const TOKEN_PREFIX = 'ibx_';

/** 32 random bytes, base64url, with a prefix so it is recognisable in a
 *  Shortcut and in a secret scanner. */
function newToken() {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Constant-time: both sides are SHA-256 digests, so they are always the
 *  same length and timingSafeEqual never throws on the comparison itself. */
function tokenMatches(presented, storedHash) {
  if (!presented || typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashToken(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return crypto.timingSafeEqual(a, b);
}

/** The bearer token from an Authorization header, or null. Bounded, so a
 *  megabyte of header is not hashed. */
function bearer(req) {
  const h = String((req.headers && req.headers.authorization) || '');
  const m = h.match(/^Bearer\s+(\S{1,200})\s*$/i);
  return m ? m[1] : null;
}

/* ---------- rate limiting ---------- */

/**
 * In memory, per instance - Cloud Run may run more than one, so this caps the
 * common case (one Shortcut looping on one instance), not a determined
 * attacker. No timer: old windows are dropped when they are next looked at.
 */
function createLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  function prune(key, t) {
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  }
  return {
    /** Counts this request; false when it is over the limit. */
    hit(key) {
      const t = now();
      const list = prune(key, t);
      if (list.length >= max) return false;
      list.push(t);
      hits.set(key, list);
      if (hits.size > 5000) hits.clear();
      return true;
    },
    /** Without counting: is this key already at the limit? */
    blocked(key) { return prune(key, now()).length >= max; },
  };
}

/* ---------- the store ---------- */

function newId() {
  // Time first so ids sort roughly by creation in the console; random after
  // so two in the same millisecond never collide. Never "token".
  return Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}

function publicItem(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    text: String(doc.text || ''),
    kind: normaliseKind(doc.kind) || 'idea',
    source: doc.source === 'siri' ? 'siri' : 'page',
    status: normaliseStatus(doc.status) || 'new',
    claudeNote: String(doc.claudeNote || ''),
    tags: cleanTags(doc.tags),
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || doc.createdAt || null,
  };
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * The inbox over the site's document store (lib/store.js: Firestore in
 * production, memory locally). `getDb` is a function so the store is resolved
 * at call time, the way the rest of server.js does it.
 */
function createInbox(getDb, { now = () => new Date() } = {}) {
  const db = () => getDb();

  async function add({ text, kind, source, tags }) {
    const clean = cleanText(text);
    if (!clean) throw fail(400, 'Nothing to save - the text was empty.');
    const at = now();
    const iso = at.toISOString();
    const day = iso.slice(0, 10);
    const [total, today] = await Promise.all([
      db().count(COLLECTION),
      db().count(COLLECTION, [['day', '==', day]]),
    ]);
    if (total >= MAX_TOTAL) throw fail(409, `The inbox is full (${MAX_TOTAL}). Delete some done ones to make room.`);
    if (today >= MAX_PER_DAY) throw fail(429, `That is ${MAX_PER_DAY} today, the daily limit. Try again tomorrow.`);
    const id = newId();
    const doc = {
      text: clean,
      kind: normaliseKind(kind) || guessKind(clean),
      source: source === 'siri' ? 'siri' : 'page',
      status: 'new',
      claudeNote: '',
      tags: cleanTags((tags || []).concat(tagsIn(clean))),
      createdAt: iso,
      updatedAt: iso,
      day,
    };
    await db().set(COLLECTION, id, doc);
    return publicItem({ id, ...doc });
  }

  /** Newest first. A status filter is an equality query sorted here rather
   *  than in Firestore, so no composite index is needed. */
  async function list({ status = 'all', limit = LIST_LIMIT } = {}) {
    const n = Math.max(1, Math.min(LIST_LIMIT, Number(limit) || LIST_LIMIT));
    const s = normaliseStatus(status);
    const rows = s
      ? await db().list(COLLECTION, { where: [['status', '==', s]] })
      : await db().list(COLLECTION, { orderBy: 'createdAt', desc: true, limit: n });
    return rows
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, n)
      .map(publicItem);
  }

  async function counts() {
    const pairs = await Promise.all(STATUSES.map(async (s) => [s, await db().count(COLLECTION, [['status', '==', s]])]));
    const out = Object.fromEntries(pairs);
    out.all = pairs.reduce((sum, [, c]) => sum + c, 0);
    return out;
  }

  /** Status, Claude's note, kind and tags. The text itself is what Erik
   *  said and is not rewritten by anyone. */
  async function patch(id, fields = {}) {
    const key = String(id || '');
    if (!/^[a-z0-9]{8,40}$/.test(key)) throw fail(404, 'No such item.');
    const current = await db().get(COLLECTION, key);
    if (!current) throw fail(404, 'No such item.');
    const change = {};
    if (fields.status !== undefined) {
      const s = normaliseStatus(fields.status);
      if (!s) throw fail(400, `Status must be one of: ${STATUSES.join(', ')}.`);
      change.status = s;
    }
    if (fields.kind !== undefined) {
      const k = normaliseKind(fields.kind);
      if (!k) throw fail(400, `Kind must be one of: ${KINDS.join(', ')}.`);
      change.kind = k;
    }
    if (fields.claudeNote !== undefined) change.claudeNote = cleanText(fields.claudeNote, MAX_NOTE);
    if (fields.tags !== undefined) change.tags = cleanTags(fields.tags);
    if (!Object.keys(change).length) throw fail(400, 'Nothing to change.');
    change.updatedAt = now().toISOString();
    await db().update(COLLECTION, key, change);
    return publicItem({ id: key, ...current, ...change });
  }

  async function remove(id) {
    const key = String(id || '');
    if (!/^[a-z0-9]{8,40}$/.test(key)) throw fail(404, 'No such item.');
    await db().remove(COLLECTION, key);
  }

  /* The token record: its hash and when it was made and last used. The
     token itself never touches the store. */

  async function tokenInfo() {
    const rec = await db().get(TOKEN_COLLECTION, TOKEN_DOC);
    if (!rec || !rec.hash) return { configured: false };
    return { configured: true, createdAt: rec.createdAt || null, lastUsedAt: rec.lastUsedAt || null };
  }

  /** A new token, replacing any old one. The plaintext is returned to the
   *  caller exactly once and is not recoverable afterwards. */
  async function issueToken() {
    const { token, hash } = newToken();
    const createdAt = now().toISOString();
    await db().set(TOKEN_COLLECTION, TOKEN_DOC, { hash, createdAt, lastUsedAt: null });
    return { token, createdAt };
  }

  async function revokeToken() {
    await db().remove(TOKEN_COLLECTION, TOKEN_DOC);
  }

  /** Read on every request rather than cached, so a revoke on one instance
   *  takes effect on all of them at once. */
  async function checkToken(presented) {
    if (!presented) return null;
    const rec = await db().get(TOKEN_COLLECTION, TOKEN_DOC);
    if (!rec || !tokenMatches(presented, rec.hash)) return null;
    return rec.hash;
  }

  async function touchToken() {
    await db().update(TOKEN_COLLECTION, TOKEN_DOC, { lastUsedAt: now().toISOString() }).catch(() => {});
  }

  return { add, list, counts, patch, remove, tokenInfo, issueToken, revokeToken, checkToken, touchToken };
}

module.exports = {
  COLLECTION, TOKEN_COLLECTION, TOKEN_DOC,
  KINDS, STATUSES,
  MAX_TEXT, MAX_NOTE, MAX_TOTAL, MAX_PER_DAY, LIST_LIMIT, BODY_LIMIT,
  cleanText, guessKind, readInput, savedMessage, cleanTags, tagsIn,
  normaliseKind, normaliseStatus,
  newToken, hashToken, tokenMatches, bearer,
  createLimiter, createInbox, publicItem,
};
