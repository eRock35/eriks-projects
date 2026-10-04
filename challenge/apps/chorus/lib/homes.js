// A household online: a host with a free account, and up to twelve people
// who joined by link, QR code or a six-character code - with no account.
//
// Pure rules, no store: the server reads the document, runs one of these
// inside a transaction, and writes what comes back.
//
// What a household document holds - and nothing else:
//   {name, code, tz, since, ownerTag, acctTags: [tag], createdAt, updatedAt, v,
//    members: [{id, name, emoji, weight, cant, dislikes, host, keyHash|null,
//               acct|null, joinedAt}],
//    chores: [{id, name, emoji, effort, freq, start, nudge?}]}
//
// - `ownerTag` and a member's `acct` are an HMAC of an account id under a key
//   derived from the identity secret ("chorus account v1"): they prove an
//   account holds a seat without the household holding an account id or an
//   email. `acctTags` repeats them so "my households" is one array-contains.
// - `keyHash` is sha256(the browser's key + the household id). The key lives
//   in an HttpOnly cookie and is never stored; the hash differs per
//   household, so two households cannot be linked to one phone.
// - A seat with neither keyHash nor acct is open: someone the host typed in
//   (a kid with no phone, a roommate who has not opened the link yet).
//   Whoever joins can say "that's me" and take it.

const crypto = require('crypto');
const Core = require('../public/chorus-core');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const CODE_LEN = 6;                                         // 32^6 ≈ 1.07 billion
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);
const HOME_ID_RE = /^[A-Za-z0-9_-]{16}$/;

const LIMITS = {
  homesPerHost: 5,
  members: Core.LIMITS.members,
  chores: Core.LIMITS.chores,
  idleMs: 180 * 24 * 60 * 60 * 1000, // a household nobody has touched in 180 days goes
  newMembersPerIp: 30,                // new people one address may add...
  newMembersWindowMs: 60 * 60 * 1000, // ...an hour
  missesPerIp: 30,                    // distinct wrong codes one address may try...
  missWindowMs: 15 * 60 * 1000,       // ...in 15 minutes
  writesPerIp: 600,                   // any writes, per address...
  writesWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
};

const httpError = Core.fail;

function randomFrom(alphabet, len) {
  let out = '';
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      if (b < 256 - (256 % alphabet.length)) out += alphabet[b % alphabet.length];
      if (out.length === len) break;
    }
  }
  return out;
}
const newCode = () => randomFrom(CODE_ALPHABET, CODE_LEN);
const newHomeId = () => crypto.randomBytes(12).toString('base64url'); // 96 bits, 16 characters
const newKey = () => crypto.randomBytes(16).toString('base64url');
const rand = (n) => crypto.randomInt(n);

function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
function isCode(v) { return CODE_RE.test(String(v || '')); }
function formatCode(c) { const s = normalizeCode(c); return s.length === CODE_LEN ? `${s.slice(0, 3)}-${s.slice(3)}` : s; }
function isHomeId(v) { return HOME_ID_RE.test(String(v || '')); }

function derived(secret, purpose) { return crypto.createHmac('sha256', String(secret)).update(purpose).digest(); }
/** One account's tag - the same in every household, so "my households" can
 *  find them; an HMAC, so the household never holds the account id. */
function acctTag(uid, secret) {
  return crypto.createHmac('sha256', derived(secret, 'chorus account v1')).update(String(uid)).digest('base64url').slice(0, 27);
}
function keyHash(key, homeId) { return crypto.createHash('sha256').update(`${key}:${homeId}`).digest('base64url').slice(0, 32); }

function idle(doc, now) { return !doc || !doc.updatedAt || Date.parse(doc.updatedAt) + LIMITS.idleMs <= now; }
function touch(doc, now) { doc.updatedAt = new Date(now).toISOString(); doc.v = (doc.v || 0) + 1; }
const weekId = (homeId, week) => `${homeId}_${week}`;

/**
 * A new household from a phone's own: the cleaned name, people and chores,
 * with `me` (one of the people) as the host's seat.
 */
function create({ home, me, tz, tag, now }) {
  const week = Core.weekKey(now, tz);
  const h = Core.cleanHome(home, { week, rand });
  const meIdx = h.members.findIndex((m) => m.id === me);
  if (meIdx < 0) throw httpError(400, 'Say which person is you.');
  const at = new Date(now).toISOString();
  return {
    name: h.name,
    tz: Core.cleanTz(tz),
    ownerTag: tag,
    acctTags: [tag],
    createdAt: at,
    updatedAt: at,
    v: 1,
    since: h.since && h.since <= Core.localDate(now, tz) ? h.since : Core.localDate(now, tz),
    members: h.members.map((m, i) => ({ ...m, host: i === meIdx, keyHash: null, acct: i === meIdx ? tag : null, joinedAt: i === meIdx ? at : null })),
    chores: h.chores,
  };
}

/** Past weeks a phone brings along when it puts its household online, so
 *  the rotation remembers who had what. Only well-formed weeks up to this
 *  one, only this household's people and chores, at most LIMITS.keepWeeks. */
function cleanWeeks(raw, doc, now) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const cur = Core.weekKey(now, doc.tz);
  const mids = doc.members.map((m) => m.id);
  const cids = doc.chores.map((c) => c.id);
  const slotOk = (k) => Core.isSlotId(k) && cids.includes(k.split('_')[0]);
  const keys = Object.keys(raw).filter((k) => Core.isWeek(k) && Core.weeksBetween(k, cur) >= 0 && Core.weeksBetween(k, cur) < Core.LIMITS.keepWeeks && Core.weekday(k) === 0).slice(0, Core.LIMITS.keepWeeks);
  for (const wk of keys) {
    const d = raw[wk] && typeof raw[wk] === 'object' ? raw[wk] : {};
    const assign = {}; const ticks = {}; const swaps = {};
    for (const [k, v] of Object.entries(d.assign || {}).slice(0, 600)) if (slotOk(k)) assign[k] = mids.includes(v) ? v : null;
    for (const [k, t] of Object.entries(d.ticks || {}).slice(0, 600)) {
      if (!slotOk(k) || !t || !mids.includes(t.who)) continue;
      const pts = Core.cleanEffort(t.pts);
      if (!pts) continue;
      const at = typeof t.at === 'string' && !isNaN(Date.parse(t.at)) ? new Date(Date.parse(t.at)).toISOString() : new Date(now).toISOString();
      ticks[k] = { who: t.who, by: mids.includes(t.by) ? t.by : t.who, pts, at };
    }
    for (const [k, s] of Object.entries(d.swaps || {}).slice(0, 600)) {
      if (!slotOk(k) || !s || !mids.includes(s.from)) continue;
      if (s.state === 'claimed' && mids.includes(s.to)) swaps[k] = { from: s.from, to: s.to, state: 'claimed', at: new Date(now).toISOString() };
      else if (s.state === 'offered') swaps[k] = { from: s.from, state: 'offered', at: new Date(now).toISOString() };
    }
    out[wk] = { week: wk, basis: wk === cur ? '' : String(d.basis || '').slice(0, 16), assign, ticks, swaps };
  }
  return out;
}

function pickEmoji(doc, wanted) {
  const taken = new Set((doc.members || []).map((m) => m.emoji));
  if (Core.cleanEmoji(wanted) && !taken.has(wanted)) return wanted;
  return Core.EMOJI.find((e) => !taken.has(e)) || Core.cleanEmoji(wanted) || Core.EMOJI[0];
}
function nameTaken(doc, name, except) {
  const k = name.toLocaleLowerCase();
  return (doc.members || []).some((m) => m.id !== except && m.name.toLocaleLowerCase() === k);
}
const isOpen = (m) => !m.keyHash && !m.acct && !m.host;

/**
 * Join: a browser (its key hash) and, when signed in, an account (its tag).
 * Someone already in the household gets their own seat back. Otherwise they
 * take an open seat ("I'm Sam") or join as someone new.
 */
function join(doc, { hash, tag, seat, name, emoji }, now) {
  const already = doc.members.find((m) => (hash && m.keyHash === hash) || (tag && m.acct === tag));
  if (already) {
    if (hash && !already.keyHash) already.keyHash = hash;
    return { mid: already.id, isNew: false };
  }
  if (seat) {
    const m = doc.members.find((x) => x.id === seat);
    if (!m || !isOpen(m)) throw httpError(409, 'Someone already took that seat. Pick another, or join as someone new.');
    m.keyHash = hash || null;
    m.acct = tag || null;
    m.joinedAt = new Date(now).toISOString();
    if (emoji !== undefined && Core.cleanEmoji(emoji) && !doc.members.some((x) => x.id !== m.id && x.emoji === emoji)) m.emoji = emoji;
    if (tag && !doc.acctTags.includes(tag)) doc.acctTags.push(tag);
    touch(doc, now);
    return { mid: m.id, isNew: true };
  }
  if (doc.members.length >= LIMITS.members) throw httpError(409, `This household is full - ${LIMITS.members} people is the most.`);
  const n = Core.cleanName(name);
  if (!n) throw httpError(400, 'Add your name - a first name or a nickname.');
  if (nameTaken(doc, n)) throw httpError(409, `Someone here is already called ${n}. If that’s you, tap your name above; otherwise add an initial.`);
  const m = { id: Core.newId('m', rand), name: n, emoji: pickEmoji(doc, emoji), weight: 1, cant: [], dislikes: [], host: false, keyHash: hash || null, acct: tag || null, joinedAt: new Date(now).toISOString() };
  doc.members.push(m);
  if (tag && !doc.acctTags.includes(tag)) doc.acctTags.push(tag);
  touch(doc, now);
  return { mid: m.id, isNew: true };
}

/** The host adds a seat for someone (a kid with no phone, say). */
function addSeat(doc, actor, { name, emoji, weight }, now) {
  if (!actor.host) throw httpError(403, 'Only the host can add someone.');
  if (doc.members.length >= LIMITS.members) throw httpError(409, `A household has ${LIMITS.members} people at most.`);
  const n = Core.cleanName(name);
  if (!n) throw httpError(400, 'Add their name.');
  if (nameTaken(doc, n)) throw httpError(409, `Someone here is already called ${n}.`);
  const m = { id: Core.newId('m', rand), name: n, emoji: pickEmoji(doc, emoji), weight: Core.cleanWeight(weight) || 1, cant: [], dislikes: [], host: false, keyHash: null, acct: null, joinedAt: null };
  doc.members.push(m);
  touch(doc, now);
  return m.id;
}

/** A person's own settings, or anyone's for the host. Weight (capacity) is
 *  the host's to set: a kid should not be able to make themselves "a
 *  little" for the week. */
function editMember(doc, actor, mid, b, now) {
  const m = doc.members.find((x) => x.id === mid);
  if (!m) throw httpError(404, 'No such person.');
  if (mid !== actor.mid && !actor.host) throw httpError(403, 'You can only change your own settings.');
  if (b.name !== undefined) {
    const n = Core.cleanName(b.name);
    if (!n) throw httpError(400, 'Add a name.');
    if (nameTaken(doc, n, mid)) throw httpError(409, `Someone here is already called ${n}.`);
    m.name = n;
  }
  if (b.emoji !== undefined) {
    if (!Core.cleanEmoji(b.emoji)) throw httpError(400, 'Pick one of the emoji.');
    m.emoji = b.emoji;
  }
  if (b.weight !== undefined) {
    if (!actor.host) throw httpError(403, 'Only the host sets how much each person takes on.');
    const w = Core.cleanWeight(b.weight);
    if (!w) throw httpError(400, 'Pick a share from the list.');
    m.weight = w;
  }
  const ids = doc.chores.map((c) => c.id);
  const f = Core.cleanMemberFields({ cant: b.cant !== undefined ? b.cant : m.cant, dislikes: b.dislikes !== undefined ? b.dislikes : m.dislikes }, ids);
  if (b.cant !== undefined) m.cant = f.cant;
  if (b.dislikes !== undefined) m.dislikes = f.dislikes;
  touch(doc, now);
}

/** The host removes someone, or someone leaves. The host can't leave their
 *  own household (delete it instead). */
function remove(doc, actor, mid, now) {
  const target = doc.members.find((m) => m.id === mid);
  if (!target) throw httpError(404, 'No such person.');
  if (mid !== actor.mid && !actor.host) throw httpError(403, 'Only the host can remove someone.');
  if (target.host) throw httpError(409, 'The host can’t leave - delete the household instead.');
  doc.members = doc.members.filter((m) => m.id !== mid);
  doc.acctTags = doc.members.map((m) => m.acct).filter(Boolean);
  if (!doc.acctTags.includes(doc.ownerTag)) doc.acctTags.push(doc.ownerTag);
  touch(doc, now);
}

/** Chores: anyone in the household may add, change or remove one - it is
 *  everyone's house, and every change shows on everyone's board. */
function addChores(doc, list, now) {
  const items = Array.isArray(list) ? list : [list];
  if (!items.length) throw httpError(400, 'Add a chore.');
  if (doc.chores.length + items.length > LIMITS.chores) throw httpError(409, `A household keeps ${LIMITS.chores} chores at most.`);
  const week = Core.weekKey(now, doc.tz);
  const added = [];
  for (const raw of items.slice(0, LIMITS.chores)) {
    const c = Core.cleanChore({ ...(raw || {}), id: undefined, start: undefined }, { week, rand });
    doc.chores.push(c);
    added.push(c.id);
  }
  touch(doc, now);
  return added;
}
function editChore(doc, cid, b, now) {
  const c = doc.chores.find((x) => x.id === cid);
  if (!c) throw httpError(404, 'No such chore.');
  const next = Core.cleanChore({ ...c, ...pick(b, ['name', 'emoji', 'effort', 'freq']), id: c.id }, { week: c.start });
  // A new frequency starts counting from this week.
  if (next.freq !== c.freq) next.start = Core.weekKey(now, doc.tz);
  Object.assign(c, next);
  touch(doc, now);
}
function removeChore(doc, cid, now) {
  if (!doc.chores.some((x) => x.id === cid)) throw httpError(404, 'No such chore.');
  doc.chores = doc.chores.filter((x) => x.id !== cid);
  for (const m of doc.members) { m.cant = (m.cant || []).filter((x) => x !== cid); m.dislikes = (m.dislikes || []).filter((x) => x !== cid); }
  touch(doc, now);
}
function pick(o, keys) { const out = {}; for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k]; return out; }

function rename(doc, actor, name, now) {
  if (!actor.host) throw httpError(404, 'No household here.');
  const n = Core.clean(name, Core.LIMITS.homeName);
  if (!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(n)) throw httpError(400, 'Give the household a name.');
  doc.name = n;
  touch(doc, now);
}

/** The household as one member sees it: never a key hash or a tag. */
function view(doc, me, host) {
  return {
    id: doc.id,
    name: doc.name,
    code: doc.code,
    display: formatCode(doc.code),
    tz: doc.tz,
    since: doc.since || null,
    v: doc.v || 0,
    members: (doc.members || []).map((m) => ({ id: m.id, name: m.name, emoji: m.emoji, weight: m.weight, cant: m.cant || [], dislikes: m.dislikes || [], host: Boolean(m.host), joined: Boolean(m.keyHash || m.acct) })),
    chores: doc.chores || [],
    me: me || null,
    host: Boolean(host),
    createdAt: doc.createdAt,
  };
}

module.exports = {
  LIMITS, CODE_ALPHABET, httpError, newCode, newHomeId, newKey, rand, normalizeCode, isCode, formatCode, isHomeId,
  acctTag, keyHash, idle, touch, weekId, create, cleanWeeks, join, addSeat, editMember, remove,
  addChores, editChore, removeChore, rename, view, isOpen,
};
