// Listings on the server: what a saved listing may contain, how it is shown,
// and the frozen card a share link serves.
//
// The score itself is public/rules.js - the same file the page runs - so
// nothing here decides a number. This file cleans what arrives (a listing is
// text the seller pasted, a screenshot the model read, or a rewrite the model
// wrote, and all of it is drawn back into a page), bounds it, and shapes the
// views.

const crypto = require('crypto');
const R = require('../public/rules');

const LIMITS = {
  listings: 200,        // per person
  versions: 50,         // per listing; the original is always kept
  title: 200,           // raw input; the platform limit is scored, not refused
  description: 6000,
  tags: 30,
  tag: 60,
  keywords: 8,
  keyword: 40,
  price: 40,
  photos: 100,
  competitor: 6000,
  improvedDays: 120,
};

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status }, extra);
}

/** One line of text: tags and stray angle brackets out, control characters
 *  and runs of space collapsed, bounded. */
function clean(v, max = 200) {
  return String(v == null ? '' : v)
    .replace(/<(script|style)\b[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Many lines: the same, but newlines kept (at most one blank line in a row),
 *  and markdown emphasis dropped - no listing platform renders it, so
 *  "**Hot tub**" would show its asterisks to every buyer. */
function cleanText(v, max = LIMITS.description) {
  return String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/<(script|style)\b[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function cleanList(v, { max, each, lower = false }) {
  const out = [];
  const seen = new Set();
  for (const raw of R.list(v)) {
    let s = clean(raw, each);
    if (lower) s = s.toLowerCase();
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

const FIELDS = ['type', 'platform', 'title', 'description', 'tags', 'keywords', 'price', 'photoCount', 'shots'];

/**
 * A listing as it may be stored. `prev` fills anything the body leaves out,
 * so a PUT can send just what changed. 400 for a type we do not know or a
 * listing with no words at all.
 */
function cleanListing(body, prev = null) {
  const b = body && typeof body === 'object' ? body : {};
  const pick = (k) => (b[k] !== undefined ? b[k] : (prev ? prev[k] : undefined));
  const type = String(pick('type') || '');
  if (!R.TYPE_KEYS.includes(type)) throw httpError(400, 'Pick what kind of listing this is: a rental, a product, a resale item or a service.');
  const platform = R.platformOf(type, pick('platform')).key;
  const title = clean(pick('title'), LIMITS.title);
  const description = cleanText(pick('description'), LIMITS.description);
  if (!title && !description) throw httpError(400, 'Paste at least a title or a description.');
  const photos = Math.floor(Number(pick('photoCount')));
  const shotKeys = R.SHOTS[type].map((s) => s.key);
  return {
    type,
    platform,
    title,
    description,
    tags: cleanList(pick('tags'), { max: LIMITS.tags, each: LIMITS.tag }),
    keywords: cleanList(pick('keywords'), { max: LIMITS.keywords, each: LIMITS.keyword, lower: true }),
    price: clean(pick('price'), LIMITS.price),
    photoCount: Number.isFinite(photos) ? Math.max(0, Math.min(LIMITS.photos, photos)) : 0,
    shots: R.list(pick('shots')).filter((k, i, a) => shotKeys.includes(k) && a.indexOf(k) === i),
  };
}

function fieldsOf(l) {
  const out = {};
  for (const k of FIELDS) out[k] = l[k];
  return out;
}

/** Same content? Decides whether a save is a new version or a no-op. */
function sameContent(a, b) {
  return JSON.stringify(fieldsOf(a)) === JSON.stringify(fieldsOf(b));
}

/** A competitor's listing, pasted to compare against. Scored as the same
 *  type and platform as yours. */
function cleanCompetitor(body, mine) {
  const b = body && typeof body === 'object' ? body : {};
  const title = clean(b.title, LIMITS.title);
  const description = cleanText(b.description, LIMITS.competitor);
  if ((title + description).length < 40) throw httpError(400, 'Paste their title and description - at least a couple of lines - so there is something to compare.');
  const n = Math.floor(Number(b.photoCount));
  const photoCount = Number.isFinite(n) ? Math.max(0, Math.min(LIMITS.photos, n)) : 0;
  // We cannot see their photos, only how many there are. Their shot list is
  // credited in proportion to the count, so the Photos ring neither punishes
  // them for what we cannot see nor hands them points for photos they lack.
  const rec = R.typeInfo(mine.type).photosRec;
  const credited = Math.round(R.SHOTS[mine.type].length * Math.min(1, photoCount / rec));
  return {
    type: mine.type,
    platform: mine.platform,
    title,
    description,
    tags: cleanList(b.tags, { max: LIMITS.tags, each: LIMITS.tag }),
    keywords: mine.keywords || [],
    price: clean(b.price, LIMITS.price),
    photoCount,
    shots: R.SHOTS[mine.type].slice(0, credited).map((s) => s.key),
  };
}

/* ---------------- days and tokens ---------------- */

function utcToday() { return new Date().toISOString().slice(0, 10); }
function isoDay(v) {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}
/** The page's own date, when it is plausible (within a day of UTC). */
function todayFrom(v) {
  const d = isoDay(v);
  const utc = utcToday();
  if (!d) return utc;
  const diff = Math.abs(Date.parse(`${d}T12:00:00Z`) - Date.parse(`${utc}T12:00:00Z`)) / 864e5;
  return diff <= 1 ? d : utc;
}

/** 22 url-safe characters from 16 random bytes. */
const newToken = () => crypto.randomBytes(16).toString('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{22,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

/* ---------------- views ---------------- */

function versionRow(v) {
  return { id: v.id, n: v.n, at: v.at, source: v.source, score: v.score, title: clean(v.fields && v.fields.title, 80) };
}

/** A row in "my listings". */
function summaryOf(l) {
  const type = R.typeInfo(l.type);
  const plat = R.platformOf(l.type, l.platform);
  return {
    id: l.id,
    type: l.type,
    typeLabel: type.short,
    emoji: type.emoji,
    platform: plat.key,
    platformLabel: plat.label,
    title: l.title || '(no title yet)',
    score: l.score,
    firstScore: l.firstScore,
    grade: R.gradeOf(l.score),
    cats: l.cats,
    versions: l.versionCount || 1,
    trail: (l.trail || []).slice(-12),
    shared: Boolean(l.shareToken),
    updatedAt: l.updatedAt,
  };
}

/** Everything the listing page draws. `versions` newest first. */
function detailOf(l, versions) {
  const rows = versions.map(versionRow);
  const scores = rows.slice().reverse().map((v) => v.score);
  return {
    id: l.id,
    ...fieldsOf(l),
    result: R.score(l),
    firstScore: l.firstScore,
    bestScore: l.bestScore,
    versions: rows,
    trail: scores,
    streak: R.improvementStreak(scores),
    share: l.shareToken ? { token: l.shareToken, url: `s/${l.shareToken}`, sharedAt: l.sharedAt, includeText: Boolean(l.shareText) } : null,
    compare: l.compare || null,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

/**
 * The glow-up card: built field by field, frozen when shared. Scores, rings,
 * the type and platform, the CURRENT title (it is already public on the
 * platform), and the score trail. The description and tags only when the
 * seller ticks "include the text"; never the original title or description,
 * the keywords, the account or any id.
 */
function shareCard(l, versions, { includeText = false } = {}) {
  const oldest = versions[versions.length - 1] || { score: l.score, cats: l.cats };
  const type = R.typeInfo(l.type);
  const plat = R.platformOf(l.type, l.platform);
  return {
    type: type.key,
    typeLabel: type.label,
    emoji: type.emoji,
    platformLabel: plat.label,
    title: clean(l.title, 200),
    before: { score: oldest.score, cats: oldest.cats, grade: R.gradeOf(oldest.score) },
    after: { score: l.score, cats: l.cats, grade: R.gradeOf(l.score) },
    trail: versions.slice().reverse().map((v) => v.score).slice(-LIMITS.versions),
    saves: versions.length,
    text: includeText ? { description: cleanText(l.description), tags: (l.tags || []).map((t) => clean(t, LIMITS.tag)) } : null,
    frozenAt: new Date().toISOString(),
  };
}

/**
 * A validated glow-up, scored by the rules: the listing as it is, each title
 * option applied with the new description and tags, and the whole rewrite
 * (first option) as the "after". Photos and search words are the seller's
 * own and carry over - a rewrite cannot take a photo.
 */
function glowResult(src, proposal) {
  const before = R.summary(src);
  const apply = (title) => ({ ...fieldsOf(src), title, description: proposal.description, tags: proposal.tags.length ? proposal.tags : src.tags });
  const titles = proposal.titles.map((t) => ({ ...t, score: R.score(apply(t.text)).score }));
  const best = titles.length ? titles[0].text : src.title;
  const afterFields = apply(best);
  return {
    before: { score: before.score, grade: R.gradeOf(before.score), cats: before.cats },
    after: R.score(afterFields),
    fields: { title: afterFields.title, description: afterFields.description, tags: afterFields.tags },
    titles,
    shots: proposal.shots,
    gaps: proposal.gaps,
    summary: proposal.summary,
    removed: proposal.removed,
    trimmed: proposal.trimmed,
  };
}

/** Both listings through the same rules, beside what the model noticed. */
function compareResult(mine, theirs, verdict, at, version) {
  const a = R.summary(mine);
  const b = R.summary(theirs);
  return {
    at,
    version,
    me: { score: a.score, cats: a.cats, grade: R.gradeOf(a.score) },
    them: { title: clean(theirs.title, 140), score: b.score, cats: b.cats, grade: R.gradeOf(b.score), photos: theirs.photoCount || 0 },
    theyDoBetter: verdict.theyDoBetter,
    youDoBetter: verdict.youDoBetter,
    verdict: verdict.verdict,
  };
}

module.exports = {
  glowResult,
  compareResult,
  LIMITS,
  FIELDS,
  httpError,
  clean,
  cleanText,
  cleanList,
  cleanListing,
  cleanCompetitor,
  fieldsOf,
  sameContent,
  utcToday,
  isoDay,
  todayFrom,
  newToken,
  TOKEN_RE,
  ID_RE,
  versionRow,
  summaryOf,
  detailOf,
  shareCard,
};
