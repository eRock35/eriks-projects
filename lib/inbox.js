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
//
// Since 2026-10-18 the same collection also carries ASKS (kind 'ask'), the
// concierge's front door: requests from the phone for a Claude Code routine
// to work on, answered by Erik with a tap. Scoped tokens (inbox-tokens/<hash>,
// 'phone' or 'agent') sit beside the original single token, which keeps
// working as a phone token. See "the concierge" below and CLAUDE.md.

const crypto = require('crypto');

const COLLECTION = 'inbox';
const TOKEN_COLLECTION = 'control';
const TOKEN_DOC = 'inbox-token';

const KINDS = ['idea', 'app idea', 'feature', 'bug', 'note'];
// Ideas use the first five; an ask (the concierge, below) moves through
// new -> doing -> parked -> answered -> done, or ends expired / cancelled.
const IDEA_STATUSES = ['new', 'seen', 'doing', 'done', 'parked'];
const ASK_STATUSES = ['new', 'doing', 'parked', 'answered', 'done', 'expired', 'cancelled'];
const STATUSES = ['new', 'seen', 'doing', 'done', 'parked', 'answered', 'expired', 'cancelled'];
const ASK = 'ask';

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

/* ---------- the concierge: rules for asks ---------- */
//
// An ask is a request Erik sends from his phone - a shared message, a link,
// a screenshot, or a dictated errand - for the Concierge routine (a Claude
// Code run on his subscription, holding an agent-scoped token) to work on.
// The routine does read-only work and parks anything with a side effect as
// a question with at most three choices; Erik answers with one tap or one
// spoken word. Nothing here calls a model.
//
// Three kinds of text, three rules:
//   - `note` is Erik's own words, the ONLY instruction on an ask.
//   - `context` is other people's words (a message, a page, a picture). It
//     is data, read once by one run, and deleted when the item leaves
//     'doing' and in any case 24 hours after it was captured.
//   - `claudeNote`, `ask.question`, `ask.choices` and `ask.add` are what the
//     routine writes back. The routine has read untrusted text, so what it
//     writes is validated here rather than trusted: no markup, links only to
//     a short list of hosts, nothing shaped like a code, a card, a long
//     number or a payment instruction.

const MAX_CONTEXT = 20000;
const MAX_URL = 2000;
const MAX_TITLE = 300;
const MAX_ASK_NOTE = 500;
const MAX_QUESTION = 300;
const MAX_CHOICE = 40;
const MAX_CHOICES = 3;
const IMAGE_MAX = 700 * 1024;
const CAPTURE_BODY_LIMIT = '1.5mb';
const CAPTURES_PER_TOKEN_DAY = 20;
const DEDUPE_MS = 120 * 1000;
const CLAIMS_PER_DAY = 6;
const CONTEXT_TTL_MS = 24 * 3600 * 1000;
const STALE_DOING_MS = 90 * 60 * 1000;
const MAX_EXPIRY_MS = 7 * 24 * 3600 * 1000;
const MAX_TOKENS = 10;
const IMAGES = 'inbox-images';
const TOKENS = 'inbox-tokens';
const CLAIMS_DOC = 'inbox-claims';
const SCOPES = ['phone', 'agent'];
const OPEN_ASK = ['new', 'doing', 'parked'];

// Exact host or a subdomain of it. Erik's own sites, and the three booking
// sites a restaurant answer may point at. Nothing else: the routine read
// pages written by strangers, and a link in a note is one tap from Erik.
const ALLOWED_HOSTS = [
  'trip.strongtechnicalconsulting.com',
  'strongtechnicalconsulting.com',
  'resy.com',
  'opentable.com',
  'exploretock.com',
];

const CODE_REFUSAL = 'Finish that in the provider\u2019s app \u2014 codes and cards never go through the inbox.';

function luhnOk(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// A 4-8 digit number near a word that means "code" - but not a year, which
// is the commonest four-digit number in an errand ("Oct 24 2026").
const NUM = '(?!(?:19|20)\\d\\d\\b)\\d{4,8}';
const CODE_WORDS = '(?:code|pin|otp|passcode|verification|verify|2fa|one[- ]?time|security code|auth(?:entication)? code)';
const OTP_RE = new RegExp(`\\b${CODE_WORDS}\\b[^\\n]{0,40}?\\b${NUM}\\b|\\b${NUM}\\b[^\\n]{0,30}?\\b(?:is your|${CODE_WORDS})\\b`, 'i');
const PASSWORD_RE = /\b(?:password|passwd|pwd|passcode)\b\s*(?:is|:|=)\s*\S+/i;
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

/** A one-time code, a PIN, a password or a card number. */
function looksSecret(text) {
  const s = String(text || '');
  if (OTP_RE.test(s) || PASSWORD_RE.test(s)) return true;
  for (const m of s.match(CARD_RE) || []) {
    const d = m.replace(/\D/g, '');
    if (d.length >= 13 && d.length <= 19 && luhnOk(d)) return true;
  }
  return false;
}

const NOT_NAMES = new Set(['mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'today', 'tonight', 'tomorrow', 'needs', 'you', 'add', 'skip', 'book', 'the', 'a', 'and']);

/** A booking reference (5-8 capitals and digits with at least one of each,
 *  or six capitals) next to something that names a person: an honorific, a
 *  "name" label, an airline-style SMITH/JOHN, or two capitalised words in a
 *  row that are not days or months. The pair is what checks someone in or
 *  cancels their trip, so the pair never goes in a note. */
function codeWithName(text) {
  const s = String(text || '');
  const code = /\b(?=[A-Z0-9]{5,8}\b)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,8}\b|\b[A-Z]{6}\b/.test(s);
  if (!code) return false;
  if (/\b(?:mr|mrs|ms|mx|dr|surname|last ?name|passenger|traveller|traveler|guest name|name)\b/i.test(s)) return true;
  if (/\b[A-Z]{2,}\/[A-Z]{2,}\b/.test(s)) return true;
  const runs = s.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  return runs.some((run) => run.split(/\s+/).filter((w) => !NOT_NAMES.has(w.toLowerCase())).length >= 2);
}

function hostAllowed(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return ALLOWED_HOSTS.some((a) => h === a || h.endsWith('.' + a));
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const BARE_DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|app|me|ly|link|info|biz|us|uk|xyz|site|online|page|to|gg)\b(?:\/[^\s]*)?/gi;
const PHONE_RE = /(?:\+?\d{1,3}[ .-]?)?\(?\b\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/;
const MONEY_RE = /\b(?:venmo|zelle|cash ?app|paypal|wire (?:it|money|the money|transfer)|bank transfer|gift ?cards?|bitcoin|crypto|western union)\b/i;

/** https, no credentials, an allowed host - or null. Reduced to origin +
 *  path + query, so a fragment cannot smuggle anything. */
function allowedLink(raw) {
  let u;
  try { u = new URL(String(raw).replace(/[.,;:!?]+$/, '')); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (!hostAllowed(u.hostname)) return null;
  return u.origin + u.pathname + u.search;
}

/** A link someone shared: https only, origin + path + query, bounded. Any
 *  host - it is context, not something the routine sends back. */
function cleanUrl(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let u;
  try { u = new URL(String(raw).trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const out = u.origin + u.pathname + u.search;
  return out.length > MAX_URL ? null : out;
}

/**
 * What the routine writes back: claudeNote, a question, a choice, an add's
 * title, location and notes. Refused (422) rather than cut or cleaned, so the
 * run learns what it may not say instead of having it quietly changed.
 */
function checkAgentText(value, max, label, { links = true } = {}) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw fail(400, `${label} must be text.`);
  const s = cleanText(value, Infinity);
  if (s.length > max) throw fail(422, `${label} is over ${max} characters.`);
  if (/[<>]/.test(s)) throw fail(422, `${label} may not carry markup.`);
  if (looksSecret(s)) throw fail(422, CODE_REFUSAL);
  if (codeWithName(s)) throw fail(422, `${label} may not put a confirmation code together with a name.`);
  if (MONEY_RE.test(s)) throw fail(422, `${label} may not ask for money to be sent anywhere.`);
  const urls = s.match(URL_RE) || [];
  if (urls.length && !links) throw fail(422, `${label} may not carry a link.`);
  for (const u of urls) {
    if (!allowedLink(u)) throw fail(422, `${label} may only link to ${ALLOWED_HOSTS.join(', ')} (https).`);
  }
  const rest = s.replace(URL_RE, ' ');
  for (const d of rest.match(BARE_DOMAIN_RE) || []) {
    const host = d.split('/')[0];
    if (!hostAllowed(host)) throw fail(422, `${label} may only name links on ${ALLOWED_HOSTS.join(', ')}.`);
    if (!links) throw fail(422, `${label} may not carry a link.`);
  }
  if (/\d{7,}/.test(rest) || PHONE_RE.test(rest)) {
    throw fail(422, `${label} may not carry a long number (a phone, account or booking number).`);
  }
  return s;
}

/** Erik's own words (a note, an errand): kept as typed, refused only when
 *  they carry a code or a card. */
function checkErikText(value, max = MAX_TEXT) {
  const s = cleanText(value, max);
  if (s && looksSecret(s)) throw fail(422, CODE_REFUSAL);
  return s;
}

/* ---------- pictures ---------- */

/** JPEG or PNG by its bytes, never by what the request says it is, with
 *  its size read from the header. */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.slice(1, 8).toString('latin1') === 'PNG\r\n\x1a\n') {
    if (buf.slice(12, 16).toString('latin1') !== 'IHDR') return null;
    return { mediaType: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mediaType: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (len < 2) break;
      i += 2 + len;
    }
    return { mediaType: 'image/jpeg', width: 0, height: 0 };
  }
  return null;
}

function readImage(image) {
  if (!image || typeof image !== 'object' || typeof image.data !== 'string') throw fail(400, 'The picture did not come through.');
  const b64 = image.data.replace(/^data:[^,]{0,100},/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || !b64) throw fail(400, 'The picture did not come through.');
  if (b64.length > Math.ceil(IMAGE_MAX / 3) * 4 + 4) throw fail(413, 'That picture is over 700 KB. Shrink it (Resize Image to 1280, JPEG quality 60%).');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > IMAGE_MAX) throw fail(413, 'That picture is over 700 KB. Shrink it (Resize Image to 1280, JPEG quality 60%).');
  const kind = sniffImage(buf);
  if (!kind) throw fail(415, 'Only a JPEG or PNG picture can be sent.');
  return { ...kind, bytes: buf.length, data: buf.toString('base64'), sha: crypto.createHash('sha256').update(buf).digest('hex') };
}

/* ---------- calendar and reminders: proposed here, written by the phone ---------- */

// Nothing in the cloud holds an iCloud credential. The routine proposes an
// event or a reminder as part of a parked question; when Erik picks the add
// choice, the reply hands the validated object to the Shortcut that asked,
// and the PHONE writes it with Add New Event / Add New Reminder. His pick is
// the confirmation.

const ZONES = new Set(Intl.supportedValuesOf('timeZone').concat(['UTC']));
const ISO_OFFSET_RE = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/;

function parseOffsetIso(value) {
  const m = ISO_OFFSET_RE.exec(String(value || ''));
  if (!m) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return { t, offset: m[7] === 'Z' ? '+00:00' : m[7] };
}

function zoneOffsetAt(zone, t) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName');
  const m = /GMT([+-]\d\d)(?::(\d\d))?/.exec(part ? part.value : 'GMT');
  return m ? `${m[1]}:${m[2] || '00'}` : '+00:00';
}

function withOffset(t, offset) {
  const sign = offset[0] === '-' ? -1 : 1;
  const mins = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  return new Date(t + mins * 60000).toISOString().slice(0, 19) + offset;
}

function whenLabel(t, zone) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone || 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(t));
  } catch (e) { return ''; }
}

function checkZone(zone, label) {
  if (typeof zone !== 'string' || !ZONES.has(zone)) throw fail(422, `${label} needs a real IANA time zone, like America/New_York.`);
  return zone;
}

function checkMoment(value, zone, label, nowMs) {
  const p = parseOffsetIso(value);
  if (!p) throw fail(422, `${label} must be an ISO time with its offset, like 2026-10-24T19:45:00-04:00.`);
  if (zone && zoneOffsetAt(zone, p.t) !== p.offset) throw fail(422, `${label}'s offset ${p.offset} is not ${zone}'s at that moment (${zoneOffsetAt(zone, p.t)}).`);
  if (p.t < nowMs - 24 * 3600 * 1000) throw fail(422, `${label} is in the past.`);
  if (p.t > nowMs + 400 * 24 * 3600 * 1000) throw fail(422, `${label} is more than a year away.`);
  return p;
}

/**
 * The event or reminder the routine proposes, checked field by field.
 * `choices` are the question's choices; `choice` names the one that adds it
 * (default: the first that starts with "Add").
 */
function validateAdd(raw, choices, nowMs = Date.now()) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(422, 'An add must be an object.');
  const type = raw.type;
  if (type !== 'event' && type !== 'reminder') throw fail(422, 'An add is an event or a reminder.');
  const title = checkAgentText(raw.title, 120, 'The title', { links: false });
  if (!title) throw fail(422, 'An add needs a title.');
  const notes = checkAgentText(raw.notes, 500, 'The notes');
  let url = null;
  if (raw.url !== undefined && raw.url !== null && raw.url !== '') {
    url = allowedLink(raw.url);
    if (!url) throw fail(422, `The add's link may only point at ${ALLOWED_HOSTS.join(', ')} (https).`);
  }
  const list = Array.isArray(choices) ? choices : [];
  const choice = raw.choice !== undefined ? raw.choice : list.find((c) => /^add\b/i.test(c));
  if (typeof choice !== 'string' || !list.includes(choice)) throw fail(422, 'An add needs one of the choices to be the one that adds it (for example "Add to calendar").');
  const out = { type, title, notes, url, choice };
  if (type === 'event') {
    out.timeZone = checkZone(raw.timeZone, 'An event');
    const start = checkMoment(raw.start, out.timeZone, 'The start', nowMs);
    out.start = raw.start;
    if (raw.end !== undefined && raw.end !== null && raw.end !== '') {
      const end = checkMoment(raw.end, out.timeZone, 'The end', nowMs);
      if (end.t <= start.t) throw fail(422, 'The end must be after the start.');
      if (end.t - start.t > 14 * 24 * 3600 * 1000) throw fail(422, 'An event may not run longer than 14 days.');
      out.end = raw.end;
    } else {
      out.end = withOffset(start.t + 2 * 3600 * 1000, start.offset);
    }
    out.location = checkAgentText(raw.location, 200, 'The location', { links: false });
    if (raw.alertMinutes === undefined || raw.alertMinutes === null) out.alertMinutes = null;
    else {
      const a = raw.alertMinutes;
      if (!Number.isInteger(a) || a < 0 || a > 1440) throw fail(422, 'alertMinutes is a whole number from 0 to 1440.');
      out.alertMinutes = a;
    }
  } else {
    out.timeZone = raw.timeZone === undefined || raw.timeZone === null ? null : checkZone(raw.timeZone, 'A reminder');
    checkMoment(raw.due, out.timeZone, 'The due time', nowMs);
    out.due = raw.due;
  }
  return out;
}

/** What the Shortcut gets: the add plus a spoken "when". */
function addForPhone(add) {
  if (!add) return null;
  const at = parseOffsetIso(add.type === 'event' ? add.start : add.due);
  const base = { type: add.type, title: add.title, notes: add.notes || '', url: add.url || '', when: at ? whenLabel(at.t, add.timeZone || 'UTC') : '' };
  if (add.type === 'event') {
    return { ...base, start: add.start, end: add.end, timeZone: add.timeZone, location: add.location || '', alertMinutes: add.alertMinutes };
  }
  return { ...base, due: add.due, timeZone: add.timeZone || '' };
}

/* ---------- what each reader sees of an ask ---------- */

function hasContent(ctx) {
  return !!(ctx && (ctx.text || ctx.title || ctx.image));
}

function clearedContext(ctx) {
  if (!ctx) return null;
  return { type: ctx.type, text: '', url: ctx.url || null, title: '', app: ctx.app || '', image: null, captured: ctx.captured || null };
}

/** An ask for the page and the agent's list: never the context's text, and
 *  the image only as its size. `detail` adds the text, for the agent's one
 *  read of a claimed item (and the page). */
function askView(doc, { detail = false } = {}) {
  if (!doc) return null;
  const ctx = doc.context || null;
  const ask = doc.ask || {};
  const view = {
    id: doc.id,
    kind: ASK,
    status: ASK_STATUSES.includes(doc.status) ? doc.status : 'new',
    note: String(doc.note || ''),
    source: ['share', 'screen', 'siri', 'page'].includes(doc.source) ? doc.source : 'page',
    claudeNote: String(doc.claudeNote || ''),
    context: ctx ? {
      type: ctx.type,
      url: ctx.url || null,
      title: String(ctx.title || ''),
      app: String(ctx.app || ''),
      hasText: !!ctx.text,
      image: ctx.image ? { bytes: ctx.image.bytes, width: ctx.image.width, height: ctx.image.height } : null,
      captured: ctx.captured || null,
    } : null,
    ask: {
      k: ask.k || null,
      question: String(ask.question || ''),
      choices: Array.isArray(ask.choices) ? ask.choices.slice(0, MAX_CHOICES) : [],
      expiresAt: ask.expiresAt || null,
      add: ask.add ? addForPhone(ask.add) : null,
      addChoice: ask.add ? ask.add.choice : null,
    },
    answer: doc.answer || null,
    addedAt: doc.addedAt || null,
    claimedAt: doc.claimedAt || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || doc.createdAt || null,
  };
  if (detail && ctx) view.context.text = String(ctx.text || '');
  return view;
}

/** What Siri says back for an ask: what kind of thing arrived, and the
 *  whole of Erik's words up to 200 characters, so a misheard date is heard. */
function savedAskMessage(item) {
  const what = { image: 'a screenshot', url: 'a link', text: 'a message' }[item && item.context && item.context.type] || null;
  const note = String((item && item.note) || '').replace(/\s+/g, ' ').trim();
  const said = note ? `: ${note.length > 200 ? `${note.slice(0, 200).trimEnd()}…` : note}` : '';
  return `Got it${what ? ` - ${what}` : ''}${said}. Back within the hour.`;
}

/** "Errand: ..." or "Ask: ..." spoken first, or kind 'ask' in the body. */
function askNoteFrom(body) {
  if (body && typeof body === 'object' && String(body.kind || '').trim().toLowerCase() === ASK) {
    return cleanText(typeof body.text === 'string' ? body.text : '');
  }
  const text = cleanText(typeof body === 'string' ? body : (body && typeof body.text === 'string' ? body.text : ''));
  const m = text.match(/^\s*(?:ask|errand)\s*[:,.\-–—]\s*/i);
  return m ? text.slice(m[0].length).trim() : null;
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
   *  than in Firestore, so no composite index is needed. `kind` is 'ideas'
   *  (everything but asks, the default - the page's list and the ideas
   *  run), 'ask', or 'all'. */
  async function list({ status = 'all', limit = LIST_LIMIT, kind = 'ideas', order = 'newest' } = {}) {
    if (kind === ASK) return listAsks({ status, limit, order: order === 'newest' ? 'updated' : order });
    const n = Math.max(1, Math.min(LIST_LIMIT, Number(limit) || LIST_LIMIT));
    const s = normaliseStatus(status);
    const rows = s
      ? await db().list(COLLECTION, { where: [['status', '==', s]] })
      : await db().list(COLLECTION, { orderBy: 'createdAt', desc: true, limit: n });
    return rows
      .filter((r) => kind === 'all' || r.kind !== ASK)
      .sort(order === 'updated' ? ORDERS.updated : ORDERS.newest)
      .slice(0, n)
      .map((r) => (r.kind === ASK ? askView(r) : publicItem(r)));
  }

  /** Per status. Asks are counted on their own (two equality filters, which
   *  Firestore serves without a composite index) and taken out of the ideas'
   *  numbers, so each list's filters count only that list. */
  async function counts({ kind = 'ideas' } = {}) {
    const pairs = await Promise.all(STATUSES.map(async (s) => {
      const [all, asks] = await Promise.all([
        kind === ASK ? Promise.resolve(0) : db().count(COLLECTION, [['status', '==', s]]),
        db().count(COLLECTION, [['status', '==', s], ['kind', '==', ASK]]),
      ]);
      return [s, kind === ASK ? asks : kind === 'all' ? all : Math.max(0, all - asks)];
    }));
    const out = Object.fromEntries(pairs);
    out.all = pairs.reduce((sum, [, c]) => sum + c, 0);
    return out;
  }

  /** Status, Claude's note, kind and tags. The text itself is what Erik
   *  said and is not rewritten by anyone. */
  async function patch(id, fields = {}, { scope = 'admin' } = {}) {
    const key = String(id || '');
    if (!/^[a-z0-9]{8,40}$/.test(key)) throw fail(404, 'No such item.');
    const current = await db().get(COLLECTION, key);
    if (!current) throw fail(404, 'No such item.');
    // An ask has its own rules; an idea is never the agent's.
    if (current.kind === ASK) return patchAsk(key, fields, { scope });
    if (scope !== 'admin') throw fail(404, 'No such ask.');
    const change = {};
    if (fields.status !== undefined) {
      const s = normaliseStatus(fields.status);
      if (!s || !IDEA_STATUSES.includes(s)) throw fail(400, `Status must be one of: ${IDEA_STATUSES.join(', ')}.`);
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


  /* ---------- asks (the concierge) ---------- */

  const isoNow = () => now().toISOString();
  const nowMs = () => now().getTime();
  const validId = (id) => /^[a-z0-9]{8,40}$/.test(String(id || ''));

  /** The pure half of the sweep: what an ask should become now. */
  function settle(doc, t) {
    let status = doc.status;
    const change = {};
    const ask = doc.ask || {};
    if (OPEN_ASK.includes(status) && ask.expiresAt && t > Date.parse(ask.expiresAt)) {
      status = 'expired';
    } else if (status === 'doing' && doc.claimedAt && t - Date.parse(doc.claimedAt) > STALE_DOING_MS) {
      status = 'expired';
      change.claudeNote = 'The run stopped partway - say it again.';
    }
    if (status !== doc.status) change.status = status;
    const ctx = doc.context || null;
    const old = ctx && ctx.captured && t - Date.parse(ctx.captured) > CONTEXT_TTL_MS;
    if (hasContent(ctx) && (old || !['new', 'doing'].includes(status))) change.context = clearedContext(ctx);
    const after = change.context !== undefined ? change.context : ctx;
    const live = OPEN_ASK.includes(status) || hasContent(after);
    if (live !== doc.live) change.live = live;
    return Object.keys(change).length ? change : null;
  }

  async function dropImage(id) {
    await db().remove(IMAGES, id).catch(() => {});
  }

  /** Expiry and forgetting, on read: every route that reads asks calls it
   *  first. Only items marked live are read - open ones, or ones still
   *  holding someone else's words - so it stays a handful of reads. No
   *  timer (the service is billed per request). */
  async function sweep() {
    const t = nowMs();
    const rows = await db().list(COLLECTION, { where: [['live', '==', true]] });
    for (const r of rows) {
      const change = settle(r, t);
      if (!change) continue;
      if (change.status && change.status !== r.status) change.updatedAt = new Date(t).toISOString();
      await db().update(COLLECTION, r.id, change);
      if (r.context && r.context.image && change.context) await dropImage(r.id);
    }
    // A picture never outlives a day, whatever its item says.
    for (const img of await db().list(IMAGES)) {
      if (!img.createdAt || t - Date.parse(img.createdAt) > CONTEXT_TTL_MS) await dropImage(img.id);
    }
  }

  /**
   * A new ask. `by` is the token's ref (or 'admin'); a phone token is held to
   * 20 a day and to one copy of the same thing per 120 seconds (a Shortcut
   * retrying a POST, a second press of the button).
   */
  async function addAsk({ note = '', capture = null, source = 'page', by = 'admin', limited = false } = {}) {
    const cleanNote = checkErikText(note);
    let context = null;
    let image = null;
    const at = now();
    const iso = at.toISOString();
    if (capture && typeof capture === 'object') {
      const text = cleanText(capture.text, MAX_CONTEXT);
      const url = cleanUrl(capture.url);
      if (capture.url && !url && !text && !capture.image) throw fail(400, 'Only an https link can be sent.');
      if (capture.image !== undefined && capture.image !== null) image = readImage(capture.image);
      const type = image ? 'image' : url ? 'url' : text ? 'text' : null;
      // Shared message text is checked like Erik's own: a code or a card in
      // it is refused rather than stored. A page's article body is not - a
      // menu or a news story may well say "code 1234" about nothing.
      if (type === 'text' && looksSecret(text)) throw fail(422, CODE_REFUSAL);
      if (type) {
        context = {
          type,
          text,
          url,
          title: cleanText(capture.title, MAX_TITLE),
          app: cleanText(capture.app, 60).replace(/[^\w .\-]/g, ''),
          image: image ? { bytes: image.bytes, width: image.width, height: image.height, mediaType: image.mediaType } : null,
          captured: iso,
        };
      }
    }
    if (!cleanNote && !context) throw fail(400, 'Nothing to save - send some words, a link or a picture.');
    const day = iso.slice(0, 10);
    const dedupe = crypto.createHash('sha256').update([by, cleanNote, context ? context.text : '', context ? context.url || '' : '', image ? image.sha : ''].join('\u0000')).digest('hex');
    if (limited) {
      const same = await db().list(COLLECTION, { where: [['dedupe', '==', dedupe]] });
      const recent = same.find((r) => at.getTime() - Date.parse(r.createdAt || 0) < DEDUPE_MS);
      if (recent) return { duplicate: true, item: askView(recent) };
      const mine = await db().count(COLLECTION, [['by', '==', by], ['day', '==', day]]);
      if (mine >= CAPTURES_PER_TOKEN_DAY) throw fail(429, `That is ${CAPTURES_PER_TOKEN_DAY} asks today from this token, the daily limit.`);
    }
    const [total, today] = await Promise.all([db().count(COLLECTION), db().count(COLLECTION, [['day', '==', day]])]);
    if (total >= MAX_TOTAL) throw fail(409, `The inbox is full (${MAX_TOTAL}). Delete some done ones to make room.`);
    if (today >= MAX_PER_DAY) throw fail(429, `That is ${MAX_PER_DAY} today, the daily limit. Try again tomorrow.`);
    const id = newId();
    const doc = {
      kind: ASK,
      text: '',
      note: cleanNote,
      source: ['share', 'screen', 'siri', 'page'].includes(source) ? source : 'page',
      status: 'new',
      claudeNote: '',
      tags: [],
      context,
      ask: { k: null, question: '', choices: [], expiresAt: new Date(at.getTime() + CONTEXT_TTL_MS).toISOString(), add: null },
      answer: null,
      addedAt: null,
      claimedAt: null,
      by,
      dedupe,
      live: true,
      createdAt: iso,
      updatedAt: iso,
      day,
    };
    // The picture first, so an item never points at one that is not there.
    if (image) await db().set(IMAGES, id, { data: image.data, mediaType: image.mediaType, bytes: image.bytes, createdAt: iso });
    try {
      await db().set(COLLECTION, id, doc);
    } catch (err) {
      if (image) await dropImage(id);
      throw err;
    }
    return { duplicate: false, item: askView({ id, ...doc }) };
  }

  const ORDERS = {
    newest: (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
    oldest: (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')),
    updated: (a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')),
  };

  /** Asks, filtered and ordered in memory after one equality query, so no
   *  composite index is needed. */
  async function listAsks({ status = 'all', limit = LIST_LIMIT, order = 'updated' } = {}) {
    await sweep();
    const n = Math.max(1, Math.min(LIST_LIMIT, Number(limit) || LIST_LIMIT));
    const s = normaliseStatus(status);
    const rows = s
      ? await db().list(COLLECTION, { where: [['status', '==', s]] })
      : await db().list(COLLECTION, { where: [['kind', '==', ASK]] });
    return rows.filter((r) => r.kind === ASK).sort(ORDERS[order] || ORDERS.updated).slice(0, n).map((r) => askView(r));
  }

  async function getAsk(id) {
    if (!validId(id)) throw fail(404, 'No such ask.');
    const doc = await db().get(COLLECTION, String(id));
    if (!doc || doc.kind !== ASK) throw fail(404, 'No such ask.');
    return { id: String(id), ...doc };
  }

  /** new -> doing, for one run only, and at most six a day. */
  async function claim(id) {
    await sweep();
    const cur = await getAsk(id);
    if (cur.status !== 'new') throw fail(409, `That one is already ${cur.status}.`);
    const iso = isoNow();
    const day = iso.slice(0, 10);
    const cap = await db().updateIf(TOKEN_COLLECTION, CLAIMS_DOC, (c) => {
      const n = c && c.day === day ? Number(c.n) || 0 : 0;
      return n >= CLAIMS_PER_DAY ? null : { day, n: n + 1 };
    });
    if (!cap.ok) throw fail(429, `That is ${CLAIMS_PER_DAY} asks worked today, the daily limit. The rest wait for tomorrow.`);
    const r = await db().updateIf(COLLECTION, cur.id, (c) => (c && c.kind === ASK && c.status === 'new'
      ? { status: 'doing', claimedAt: iso, updatedAt: iso, live: true } : null));
    if (!r.ok) {
      await db().updateIf(TOKEN_COLLECTION, CLAIMS_DOC, (c) => (c && c.day === day && c.n > 0 ? { day, n: c.n - 1 } : null));
      throw fail(409, `That one is already ${(r.doc && r.doc.status) || 'gone'}.`);
    }
    return askView({ id: cur.id, ...r.doc });
  }

  /** The one read of someone else's words, for the run that claimed it. */
  async function askDetail(id, { scope = 'admin' } = {}) {
    await sweep();
    const cur = await getAsk(id);
    if (scope === 'agent' && cur.status !== 'doing') throw fail(409, 'Claim it first - only an ask in doing can be read.');
    return askView(cur, { detail: true });
  }

  /** The picture, once: whoever clears the item's pointer reads it, and the
   *  picture is deleted in the same response. */
  async function takeImage(id, { scope = 'admin' } = {}) {
    await sweep();
    const cur = await getAsk(id);
    if (scope === 'agent' && cur.status !== 'doing') throw fail(409, 'Claim it first - only an ask in doing can be read.');
    const iso = isoNow();
    const r = await db().updateIf(COLLECTION, cur.id, (c) => (c && c.context && c.context.image
      ? { context: { ...c.context, image: null }, imageReadAt: iso, updatedAt: iso } : null));
    if (!r.ok) throw fail(410, 'That picture has been read already, or it is gone.');
    const img = await db().get(IMAGES, cur.id);
    await dropImage(cur.id);
    if (!img || typeof img.data !== 'string') throw fail(410, 'That picture has been read already, or it is gone.');
    return { buffer: Buffer.from(img.data, 'base64'), mediaType: img.mediaType === 'image/png' ? 'image/png' : 'image/jpeg' };
  }

  function newK() {
    return crypto.randomBytes(3).toString('hex');
  }

  function checkChoices(list) {
    if (!Array.isArray(list)) throw fail(422, 'Choices are a list of up to three short answers.');
    if (list.length > MAX_CHOICES) throw fail(422, `At most ${MAX_CHOICES} choices.`);
    const out = list.map((c) => checkAgentText(c, MAX_CHOICE, 'A choice', { links: false }));
    if (out.some((c) => !c)) throw fail(422, 'A choice may not be empty.');
    if (new Set(out.map((c) => c.toLowerCase())).size !== out.length) throw fail(422, 'Two choices are the same.');
    return out;
  }

  /**
   * What the agent (and the page) may change on an ask: its status, Claude's
   * note, and the question - never Erik's note or the capture.
   */
  async function patchAsk(id, fields = {}, { scope = 'admin' } = {}) {
    const cur = await getAsk(id);
    const t = nowMs();
    const iso = new Date(t).toISOString();
    if (scope === 'agent' && !['doing', 'answered', 'parked'].includes(cur.status)) {
      throw fail(409, cur.status === 'new' ? 'Claim it first.' : `That one is ${cur.status}; it is finished.`);
    }
    const known = ['status', 'claudeNote', 'ask'];
    const extra = Object.keys(fields).filter((k) => !known.includes(k));
    if (extra.length) throw fail(400, `An ask takes only status, claudeNote and ask (not ${extra.join(', ')}).`);
    const change = {};
    let status = cur.status;
    if (fields.status !== undefined) {
      const s = normaliseStatus(fields.status);
      const allowed = scope === 'agent' ? ['doing', 'parked', 'done', 'cancelled'] : ['new', 'doing', 'parked', 'done', 'cancelled', 'expired'];
      if (!s || !allowed.includes(s)) throw fail(400, `Status must be one of: ${allowed.join(', ')}.`);
      if (scope === 'agent' && s === 'doing' && cur.status !== 'doing') throw fail(400, 'Use claim to start on an ask.');
      status = s;
      change.status = s;
    }
    if (fields.claudeNote !== undefined) change.claudeNote = checkAgentText(fields.claudeNote, MAX_ASK_NOTE, 'The note');
    const ask = { k: null, question: '', choices: [], expiresAt: null, add: null, ...(cur.ask || {}) };
    if (fields.ask !== undefined) {
      const a = fields.ask;
      if (!a || typeof a !== 'object' || Array.isArray(a)) throw fail(400, 'ask is an object: {question, choices, expiresAt, add}.');
      let asked = false;
      if (a.question !== undefined) { ask.question = checkAgentText(a.question, MAX_QUESTION, 'The question'); asked = true; }
      if (a.choices !== undefined) { ask.choices = checkChoices(a.choices); asked = true; }
      if (asked) ask.k = newK();
      if (a.expiresAt !== undefined) {
        const e = Date.parse(a.expiresAt);
        if (!Number.isFinite(e) || e <= t || e > t + MAX_EXPIRY_MS) throw fail(422, 'expiresAt must be in the next seven days.');
        ask.expiresAt = new Date(e).toISOString();
      }
      if (a.add !== undefined) ask.add = validateAdd(a.add, ask.choices, t);
      change.ask = ask;
    }
    if (ask.add && !ask.choices.includes(ask.add.choice)) throw fail(422, 'The add’s choice is no longer one of the choices.');
    if (status === 'parked' && change.status) {
      if (!ask.question || ask.choices.length < 2) throw fail(422, 'Parking needs a question and two or three choices.');
      if (!ask.expiresAt || Date.parse(ask.expiresAt) <= t) ask.expiresAt = new Date(t + CONTEXT_TTL_MS).toISOString();
      if (!ask.k) ask.k = newK();
      if (cur.status === 'answered') change.answer = null;
      change.ask = ask;
    }
    if (!Object.keys(change).length) throw fail(400, 'Nothing to change.');
    let ctx = cur.context || null;
    if (hasContent(ctx) && cur.status === 'doing' && status !== 'doing') { ctx = clearedContext(ctx); change.context = ctx; }
    if (hasContent(ctx) && !['new', 'doing'].includes(status)) { ctx = clearedContext(ctx); change.context = ctx; }
    change.live = OPEN_ASK.includes(status) || hasContent(ctx);
    change.updatedAt = iso;
    await db().update(COLLECTION, cur.id, change);
    if (change.context && cur.context && cur.context.image) await dropImage(cur.id);
    return askView({ ...cur, ...change });
  }

  /** For the phone: the questions waiting on Erik and the newest answer,
   *  and nothing else - no capture, no idea, no other item's text. */
  async function answers() {
    await sweep();
    const parked = (await db().list(COLLECTION, { where: [['status', '==', 'parked']] }))
      .filter((r) => r.kind === ASK).sort(ORDERS.updated).slice(0, 5)
      .map((r) => ({
        id: r.id,
        k: (r.ask && r.ask.k) || null,
        question: String((r.ask && r.ask.question) || ''),
        choices: (r.ask && Array.isArray(r.ask.choices)) ? r.ask.choices : [],
        hasAdd: !!(r.ask && r.ask.add),
        addType: r.ask && r.ask.add ? r.ask.add.type : null,
        expiresAt: (r.ask && r.ask.expiresAt) || null,
      }));
    const done = (await db().list(COLLECTION, { where: [['status', '==', 'done']] }))
      .filter((r) => r.kind === ASK && r.claudeNote).sort(ORDERS.updated)[0];
    const latest = done ? { id: done.id, note: String(done.claudeNote || ''), updatedAt: done.updatedAt || null } : null;
    const say = parked.length ? parked[0].question : latest ? latest.note : 'Nothing yet.';
    return { parked, next: parked[0] || null, latest, say };
  }

  /** Erik's answer: exactly one of the choices, to the question he heard
   *  (k), before it expires. Picking the add choice hands back the event
   *  or reminder once, for the phone to write. */
  async function reply(id, body = {}, { via = 'phone' } = {}) {
    const b = body && typeof body === 'object' ? body : {};
    if (b.text !== undefined) {
      if (looksSecret(b.text)) throw fail(422, CODE_REFUSAL);
      throw fail(400, 'A reply is one of the choices, not text.');
    }
    const cur = await getAsk(id);
    const t = nowMs();
    const iso = new Date(t).toISOString();
    const ask = cur.ask || {};
    const expired = (a) => !!(a && a.expiresAt && t > Date.parse(a.expiresAt));
    if (cur.status === 'parked' && expired(ask)) {
      await db().update(COLLECTION, cur.id, { status: 'expired', updatedAt: iso, live: hasContent(cur.context) });
      throw fail(410, 'That one expired - ask again.');
    }
    if (cur.status !== 'parked') throw fail(409, cur.status === 'answered' ? 'That one is answered already.' : 'That one is not waiting on you.');
    if (typeof b.k !== 'string' || b.k !== ask.k) throw fail(409, 'That is an older question - ask for the newest one.');
    const choices = Array.isArray(ask.choices) ? ask.choices : [];
    if (typeof b.choice !== 'string' || !choices.includes(b.choice)) throw fail(400, `Pick one of: ${choices.join(', ')}.`);
    const isAdd = !!(ask.add && ask.add.choice === b.choice);
    const r = await db().updateIf(COLLECTION, cur.id, (c) => (c && c.status === 'parked' && c.ask && c.ask.k === b.k && !expired(c.ask)
      ? {
        status: 'answered',
        answer: { choice: b.choice, at: iso, via: via === 'admin' ? 'page' : 'phone' },
        ask: { ...c.ask, expiresAt: null },
        addedAt: isAdd ? iso : (c.addedAt || null),
        live: hasContent(c.context),
        updatedAt: iso,
      } : null));
    if (!r.ok) throw fail(409, 'That one is answered already.');
    const out = { item: askView({ id: cur.id, ...r.doc }), message: isAdd ? (via === 'admin' ? (ask.add.type === 'event' ? 'Got it - tap Add to Calendar to add it.' : 'Got it - copy it into Reminders.') : 'Got it - adding it now.') : `Got it: ${b.choice}.` };
    if (isAdd) out.add = addForPhone(ask.add);
    return out;
  }

  /* ---------- scoped tokens ---------- */

  async function mintToken({ scope, label } = {}) {
    if (!SCOPES.includes(scope)) throw fail(400, 'A token is for the phone or for the agent.');
    const name = cleanText(label, 40) || (scope === 'phone' ? 'iPhone' : 'Concierge');
    const live = await db().count(TOKENS);
    if (live >= MAX_TOKENS) throw fail(409, `That is ${MAX_TOKENS} tokens. Revoke one first.`);
    const { token, hash } = newToken();
    const ref = crypto.randomBytes(6).toString('hex');
    const createdAt = isoNow();
    await db().set(TOKENS, hash, { scope, label: name, ref, createdAt, lastUsedAt: null });
    return { token, ref, scope, label: name, createdAt };
  }

  /** Labels, scopes and dates; of the hash, six characters to tell two
   *  apart. The token itself was never stored. */
  async function listTokens() {
    const rows = (await db().list(TOKENS)).map((r) => ({
      ref: r.ref, scope: r.scope, label: r.label || '', prefix: String(r.id).slice(0, 6), createdAt: r.createdAt || null, lastUsedAt: r.lastUsedAt || null, legacy: false,
    }));
    const old = await db().get(TOKEN_COLLECTION, TOKEN_DOC);
    if (old && old.hash) rows.push({ ref: 'legacy', scope: 'phone', label: 'Siri (original)', prefix: String(old.hash).slice(0, 6), createdAt: old.createdAt || null, lastUsedAt: old.lastUsedAt || null, legacy: true });
    return rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  async function revokeRef(ref) {
    const key = String(ref || '');
    if (key === 'legacy') { await revokeToken(); return; }
    if (!/^[0-9a-f]{12}$/.test(key)) throw fail(404, 'No such token.');
    const rows = await db().list(TOKENS, { where: [['ref', '==', key]] });
    if (!rows.length) throw fail(404, 'No such token.');
    for (const r of rows) await db().remove(TOKENS, r.id);
  }

  /** Which token, and what it may do. The original single token is a phone
   *  token: it keeps working, and it can no longer read the inbox. */
  async function checkScoped(presented) {
    if (!presented) return null;
    const hash = hashToken(presented);
    const rec = await db().get(TOKENS, hash);
    if (rec && SCOPES.includes(rec.scope)) return { hash, scope: rec.scope, ref: rec.ref, legacy: false };
    const old = await checkToken(presented);
    return old ? { hash: old, scope: 'phone', ref: 'legacy', legacy: true } : null;
  }

  async function touchScoped(info) {
    if (!info) return;
    if (info.legacy) return touchToken();
    await db().update(TOKENS, info.hash, { lastUsedAt: isoNow() }).catch(() => {});
  }

  return {
    add, list, counts, patch, remove, tokenInfo, issueToken, revokeToken, checkToken, touchToken,
    addAsk, listAsks, claim, askDetail, takeImage, patchAsk, answers, reply, sweep, settle,
    mintToken, listTokens, revokeRef, checkScoped, touchScoped,
  };
}

module.exports = {
  COLLECTION, TOKEN_COLLECTION, TOKEN_DOC, IMAGES, TOKENS, CLAIMS_DOC,
  KINDS, STATUSES, IDEA_STATUSES, ASK_STATUSES, ASK, SCOPES, ALLOWED_HOSTS, CODE_REFUSAL,
  MAX_CONTEXT, MAX_ASK_NOTE, IMAGE_MAX, CAPTURE_BODY_LIMIT, CAPTURES_PER_TOKEN_DAY, DEDUPE_MS, CLAIMS_PER_DAY, CONTEXT_TTL_MS, MAX_TOKENS,
  looksSecret, codeWithName, checkAgentText, checkErikText, allowedLink, cleanUrl, hostAllowed,
  sniffImage, readImage, validateAdd, addForPhone, zoneOffsetAt, askView, askNoteFrom, savedAskMessage,
  MAX_TEXT, MAX_NOTE, MAX_TOTAL, MAX_PER_DAY, LIST_LIMIT, BODY_LIMIT,
  cleanText, guessKind, readInput, savedMessage, cleanTags, tagsIn,
  normaliseKind, normaliseStatus,
  newToken, hashToken, tokenMatches, bearer,
  createLimiter, createInbox, publicItem,
};
