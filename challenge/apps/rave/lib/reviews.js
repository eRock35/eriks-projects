// Rave's arithmetic and its words: everything about reviews that needs no model.
//
//   - cleaning what people type (settings, reviews, replies)
//   - checking what a model says (triage), and merging it with the rules
//   - the free reply templates, per star rating and tone
//   - the scoreboard: response rate, time to reply, the rating trend, the
//     inbox-zero streak, what people praise and complain about, badges
//   - the wall of love's frozen snapshot
//
// Everything is derived from stored reviews on every read. Nothing is a
// counter that can drift; badges are the one thing kept, because an earned
// badge should not vanish when tomorrow's 1-star arrives.

const R = require('../public/rules');

const DAY = 86400000;

const LIMITS = {
  reviews: 1000,     // a book
  text: 5000,        // one review
  reply: 2000,       // one reply
  reviewer: 80,
  vent: 3000,        // what goes into Cool down
  wall: 12,          // reviews on the wall of love
  others: 60,        // earlier replies the copy-paste check compares against
};

const PLATFORMS = [
  { key: 'google', label: 'Google' },
  { key: 'yelp', label: 'Yelp' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'tripadvisor', label: 'Tripadvisor' },
  { key: 'other', label: 'Other' },
];
const PLATFORM_KEYS = PLATFORMS.map((p) => p.key);

const TONES = [
  { key: 'warm', label: 'Warm', brief: 'warm, personal and friendly - like a small business owner who genuinely cares' },
  { key: 'professional', label: 'Professional', brief: 'polished, courteous and professional - calm and measured, no slang' },
  { key: 'playful', label: 'Playful', brief: 'upbeat and playful with a light touch of humour - never jokey about a complaint' },
];
const TONE_KEYS = TONES.map((t) => t.key);

const SENTIMENTS = ['positive', 'mixed', 'negative', 'neutral'];

/* ------------------------------------------------------------------ *
 * Cleaning
 * ------------------------------------------------------------------ */

/** One line: no angle brackets, no control characters, bounded. */
function clean(v, max = 400) {
  return String(v == null ? '' : v)
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
/** Paragraphs kept, everything else as clean(). */
function cleanText(v, max = 2000) {
  return String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function isoDay(v) {
  const s = String(v == null ? '' : v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + 'T00:00:00Z');
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10) === s ? s : null;
}
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const utcToday = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
/** The page's own date, accepted within a day of UTC; anything else is UTC. */
function todayFrom(v, now = Date.now()) {
  const u = utcToday(now);
  const d = isoDay(v);
  return d && Math.abs(daysBetween(u, d)) <= 1 ? d : u;
}

/**
 * A date as a review site prints it, into an ISO day: "2026-09-12",
 * "Sep 12, 2026", "3 days ago", "a week ago", "yesterday". The model reports
 * the words; this does the arithmetic. Unreadable -> null (the person picks).
 */
function dayFromText(text, today) {
  const s = clean(text, 60).toLowerCase();
  if (!s) return null;
  const iso = isoDay(s);
  if (iso) return iso <= today ? iso : null;
  if (/^(today|just now|now|\d+ (minutes?|hours?|mins?|hrs?) ago|an? (minute|hour) ago)$/.test(s)) return today;
  if (s === 'yesterday') return addDays(today, -1);
  const m = s.match(/^(a|an|one|\d+) (day|week|month|year)s? ago$/);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
    const per = { day: 1, week: 7, month: 30, year: 365 }[m[2]];
    return n * per > 3650 ? null : addDays(today, -n * per);
  }
  const t = Date.parse(s.replace(/(\d)(st|nd|rd|th)\b/, '$1') + ' 12:00 UTC');
  if (Number.isFinite(t)) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d <= today && d >= '2000-01-01') return d;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Settings: the voice
 * ------------------------------------------------------------------ */

const SETTINGS_DEFAULTS = {
  businessName: '',
  what: '',          // "neighbourhood café", "family dental practice"
  ownerName: '',
  signOff: '',
  tone: 'warm',
  alwaysSay: '',
  neverSay: '',
  contactLine: '',   // how an unhappy customer reaches you offline
};

function cleanSettings(raw, prev = SETTINGS_DEFAULTS) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const pick = (k, fn) => (b[k] === undefined ? prev[k] : fn(b[k]));
  return {
    businessName: pick('businessName', (v) => clean(v, 80)),
    what: pick('what', (v) => clean(v, 60)),
    ownerName: pick('ownerName', (v) => clean(v, 60)),
    signOff: pick('signOff', (v) => clean(v, 60)),
    tone: pick('tone', (v) => (TONE_KEYS.includes(v) ? v : prev.tone || 'warm')),
    alwaysSay: pick('alwaysSay', (v) => cleanText(v, 300)),
    neverSay: pick('neverSay', (v) => cleanText(v, 300)),
    contactLine: pick('contactLine', (v) => clean(v, 160)),
  };
}

/* ------------------------------------------------------------------ *
 * Reviews
 * ------------------------------------------------------------------ */

function starsOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

/** What a person typed or confirmed, checked. Throws 400 with a sentence. */
function cleanReview(raw, prev = null, today = utcToday()) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const has = (k) => b[k] !== undefined;
  const out = {};
  if (!prev || has('stars')) {
    out.stars = starsOf(b.stars);
    if (!out.stars) throw httpError(400, 'How many stars? Pick 1 to 5.');
  }
  if (!prev || has('platform')) {
    const p = String(b.platform || 'google').toLowerCase();
    out.platform = PLATFORM_KEYS.includes(p) ? p : 'other';
  }
  if (!prev || has('reviewer')) out.reviewer = clean(b.reviewer, LIMITS.reviewer);
  if (!prev || has('text')) {
    if (String(b.text || '').length > LIMITS.text * 2) throw httpError(400, `That review is too long - ${LIMITS.text.toLocaleString('en-US')} characters is the most Rave keeps.`);
    out.text = cleanText(b.text, LIMITS.text);
  }
  if (!prev || has('date')) {
    if (b.date === undefined || b.date === null || b.date === '') out.date = prev ? prev.date : today;
    else {
      out.date = isoDay(b.date);
      if (!out.date) throw httpError(400, 'That date is not a real date.');
      if (out.date > today) throw httpError(400, 'A review cannot be from the future.');
      if (out.date < '2000-01-01') throw httpError(400, 'That date is too far back.');
    }
  }
  return out;
}

/** The model's triage, checked: enums from the lists, strings bounded. */
function validateTriage(raw, stars) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const list = (v, allowed, max) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x || '').toLowerCase().trim()).filter((x) => allowed.includes(x)))].slice(0, max);
  const q = R.quickTriage({ stars, text: '' });
  return {
    sentiment: SENTIMENTS.includes(String(b.sentiment || '').toLowerCase()) ? String(b.sentiment).toLowerCase() : q.sentiment,
    topics: list(b.topics, R.TOPIC_KEYS, 6),
    praise: list(b.praise, R.TOPIC_KEYS, 6),
    complaints: list(b.complaints, R.TOPIC_KEYS, 6),
    risk: { reasons: list(b.riskReasons || (b.risk && b.risk.reasons), R.RISK_KEYS, 6) },
    urgency: R.URGENCY.includes(String(b.urgency || '').toLowerCase()) ? String(b.urgency).toLowerCase() : 'normal',
    summary: clean(b.summary, 160),
    approach: clean(b.approach, 220),
  };
}

const rank = (u) => R.URGENCY.indexOf(u);

/**
 * The triage a review is drawn with. The rules always run; a stored model
 * triage refines topics, sentiment and the summary, but risk reasons are a
 * UNION (the model can add one the words missed, never remove one they
 * raised) and urgency never drops below the rules' floor.
 */
function triageOf(review) {
  const q = R.quickTriage(review);
  const ai = review.triage;
  if (!ai) return q;
  const reasons = [...new Set([...(ai.risk && ai.risk.reasons) || [], ...q.risk.reasons])];
  const floor = R.urgencyOf(review.stars, reasons.length > 0);
  const topics = [...new Set([...(ai.topics || []), ...(ai.praise || []), ...(ai.complaints || [])])];
  return {
    sentiment: ai.sentiment || q.sentiment,
    topics: topics.length ? topics : q.topics,
    praise: ai.praise && (ai.praise.length || ai.complaints.length) ? ai.praise : q.praise,
    complaints: ai.complaints && (ai.praise.length || ai.complaints.length) ? ai.complaints : q.complaints,
    risk: { flag: reasons.length > 0, reasons },
    urgency: rank(ai.urgency) > rank(floor) ? ai.urgency : floor,
    summary: ai.summary || '',
    approach: ai.approach || '',
    by: 'ai',
    at: ai.at || null,
  };
}

/** When a review landed in front of the person: never before it was posted,
 *  never before they added it. A backlog imported today does not count as
 *  weeks of slow replies. */
function arrivalMs(r) {
  const posted = Date.parse((r.date || '2000-01-01') + 'T00:00:00Z');
  const added = Date.parse(r.addedAt || '') || posted;
  return Math.max(posted, added);
}
function arrivalDay(r) {
  const d = r.addedDay && r.addedDay > (r.date || '') ? r.addedDay : r.date;
  return d || utcToday();
}
const isReplied = (r) => Boolean(r.repliedAt);

/** A review as its owner sees it: stored facts plus everything derived. */
function view(r, today, { full = true } = {}) {
  const t = triageOf(r);
  const replied = isReplied(r);
  const v = {
    id: r.id,
    platform: r.platform,
    stars: r.stars,
    reviewer: r.reviewer || '',
    displayName: R.displayName(r.reviewer),
    firstName: R.firstName(r.reviewer),
    date: r.date,
    source: r.source || 'paste',
    status: replied ? 'replied' : 'waiting',
    waitingDays: replied ? null : Math.max(0, daysBetween(arrivalDay(r), today)),
    repliedAt: r.repliedAt || null,
    repliedDay: r.repliedDay || null,
    replySource: r.replySource || null,
    favourite: Boolean(r.favourite),
    triage: t,
    urgency: replied ? 'done' : t.urgency,
    hasDraft: Boolean(r.reply && r.reply.text),
    addedAt: r.addedAt || null,
  };
  if (full) {
    v.text = r.text || '';
    v.reply = r.reply && r.reply.text ? { text: r.reply.text, source: r.reply.source || 'own', at: r.reply.at || null } : null;
  } else {
    v.excerpt = (r.text || '').length > 280 ? `${r.text.slice(0, 277).trimEnd()}…` : r.text || '';
  }
  return v;
}

/** Waiting first - most urgent, then longest waiting - then the answered,
 *  newest answer first. */
function sortViews(vs) {
  const w = vs.filter((v) => v.status === 'waiting').sort((a, b) => rank(b.urgency) - rank(a.urgency) || b.waitingDays - a.waitingDays || a.stars - b.stars);
  const d = vs.filter((v) => v.status !== 'waiting').sort((a, b) => String(b.repliedAt).localeCompare(String(a.repliedAt)));
  return [...w, ...d];
}

/** The earlier replies the copy-paste check compares a reply against. */
function othersFor(reviews, id) {
  return reviews
    .filter((r) => r.id !== id && r.reply && r.reply.text)
    .sort((a, b) => String(b.repliedAt || b.reply.at || '').localeCompare(String(a.repliedAt || a.reply.at || '')))
    .slice(0, LIMITS.others)
    .map((r) => ({ id: r.id, label: `${R.displayName(r.reviewer)} (${r.stars}★)`, text: r.reply.text }));
}

function lintFor(text, review, reviews, settings) {
  const t = triageOf(review);
  return R.lint(text, {
    stars: review.stars,
    reviewer: review.reviewer,
    contactLine: settings.contactLine,
    risk: t.risk.flag,
    others: othersFor(reviews, review.id),
  });
}

/* ------------------------------------------------------------------ *
 * Templates: free, no model, per star rating and tone
 * ------------------------------------------------------------------ */

// Noun phrases, so they read in any sentence: "you enjoyed X", "X hit the mark".
const PRAISE_PHRASE = {
  food: 'the food', drink: 'the drinks', service: 'the service', staff: 'our team', wait: 'the quick service',
  price: 'the value', quality: 'the work', cleanliness: 'the spotless space', atmosphere: 'the atmosphere',
  booking: 'the easy booking', communication: 'the communication', location: 'the location',
};
const COMPLAINT_PHRASE = {
  food: 'the food', drink: 'your drinks', service: 'the service', staff: 'how you were treated', wait: 'the wait',
  price: 'the price', quality: 'the quality of the work', cleanliness: 'the cleanliness', atmosphere: 'the noise and the space',
  booking: 'the booking', communication: 'our communication', location: 'getting to us',
};

function joinAnd(list) {
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

const T = {
  five: {
    warm: [
      (p) => `Thank you so much for the five stars! We're so glad you loved ${p || 'your visit'} - it honestly makes the whole team's day. We can't wait to see you again.`,
      (p) => `This made our day - thank you! Hearing you enjoyed ${p || 'your visit'} is exactly why we do what we do. See you again soon.`,
    ],
    professional: [
      (p) => `Thank you for the excellent review. We are delighted that ${p || 'your experience'} met your expectations, and we look forward to welcoming you back.`,
      (p) => `Thank you for taking the time to share this. It is wonderful to hear you enjoyed ${p || 'your visit'}, and I will pass your kind words on to the team.`,
    ],
    playful: [
      (p) => `Five stars?! You've made our week. So happy ${p || 'your visit'} won you over - come back soon, we'll be here!`,
      (p) => `Cue the happy dance - thank you! ${p ? `${p.charAt(0).toUpperCase()}${p.slice(1)} getting a shout-out` : 'A review like this'} is the best thing to read with our morning coffee. See you next time!`,
    ],
  },
  four: {
    warm: [
      (p, c) => `Thank you for the lovely review! We're really glad you enjoyed ${p || 'your visit'}.${c ? ` Thanks too for the honest note about ${c} - we're on it, and we'd love to earn that fifth star next time.` : ' We hope to see you again soon.'}`,
      (p, c) => `Thanks so much for stopping by and for taking the time to write this.${p ? ` So happy you enjoyed ${p}.` : ''}${c ? ` We hear you on ${c}, and we're working on it.` : ''} Hope to see you again soon!`,
    ],
    professional: [
      (p, c) => `Thank you for your review. We are pleased you enjoyed ${p || 'your visit'}${c ? `, and we appreciate your feedback on ${c}, which we have shared with the team` : ''}. We look forward to seeing you again.`,
      (p, c) => `Thank you for the four stars and for your thoughtful feedback.${c ? ` Your comments on ${c} are noted and we are already looking at how to improve.` : ''} We hope to welcome you back soon.`,
    ],
    playful: [
      (p, c) => `Four stars - we'll take it, and we're coming for that fifth one!${p ? ` So glad you enjoyed ${p}.` : ''}${c ? ` Point taken on ${c}; we're on the case.` : ''} See you soon!`,
      (p, c) => `Thanks for the love!${p ? ` ${p.charAt(0).toUpperCase()}${p.slice(1)} for the win.` : ''}${c ? ` And thanks for the nudge on ${c} - noted with a big underline.` : ''} Come back and let us earn the full five!`,
    ],
  },
  three: {
    warm: [
      (p, c) => `Thanks for the honest review.${p ? ` I'm glad you enjoyed ${p}` : ' I appreciate you sharing it'}${c ? `, and I'm sorry ${c} let you down` : ''}. We'd love the chance to give you a better visit next time.`,
      (p, c) => `Thank you for taking the time to write this.${c ? ` I'm sorry ${c} wasn't what you hoped - that's useful to hear and we're looking at it.` : ''}${p ? ` Really glad you enjoyed ${p}.` : ''} I hope we can make your next visit a five-star one.`,
    ],
    professional: [
      (p, c) => `Thank you for your feedback.${p ? ` We are glad you enjoyed ${p}.` : ''}${c ? ` We are sorry that ${c} fell short of what you expected, and we are reviewing it with the team.` : ''} We hope to have the opportunity to serve you better next time.`,
      (p, c) => `Thank you for sharing a balanced review.${c ? ` Your comments on ${c} are helpful, and we are taking them seriously.` : ''}${p ? ` It is good to hear ${p} was a highlight.` : ''} We would welcome the chance to impress you on your next visit.`,
    ],
    playful: [
      (p, c) => `Thanks for keeping it real!${p ? ` Glad you enjoyed ${p}.` : ''}${c ? ` Sorry about ${c} - we've taken notes.` : ''} Give us another shot and we'll aim for the full five.`,
      (p, c) => `Three stars - noted, and we're not done trying!${c ? ` We hear you on ${c}.` : ''}${p ? ` Happy you enjoyed ${p}.` : ''} Hope to see you again soon.`,
    ],
  },
  low: {
    warm: [
      (p, c, o) => `I'm really sorry your visit wasn't what it should have been${c ? `, especially ${c}` : ''}. That's not the experience we want anyone to have, and I'd like to make it right. ${o}`,
      (p, c, o) => `Thank you for telling us, and I'm so sorry${c ? ` about ${c}` : ' we let you down'}. We take feedback like this to heart. I'd love the chance to talk it through and put things right. ${o}`,
    ],
    professional: [
      (p, c, o) => `Thank you for your feedback, and I apologise that your experience fell short${c ? ` - in particular ${c}` : ''}. This is not the standard we hold ourselves to, and I would like to understand what happened. ${o}`,
      (p, c, o) => `I am sorry to read this${c ? `, and particularly sorry about ${c}` : ''}. We take every review seriously and would appreciate the opportunity to look into this properly. ${o}`,
    ],
    playful: [
      // Playful is for the good days. An unhappy customer gets warm and straight.
      (p, c, o) => `I'm really sorry we missed the mark${c ? ` on ${c}` : ''} - that's not the visit we want anyone to have. I'd like to hear more and put it right. ${o}`,
      (p, c, o) => `Thanks for letting us know, and I'm sorry${c ? ` about ${c}` : ' it went wrong'}. We want to do better, and I'd love to talk it through. ${o}`,
    ],
  },
  // Health, safety, legal, discrimination: short, sincere, no details, no
  // admission, straight offline. Same in every tone.
  risk: [
    (o) => `Thank you for letting us know, and I'm very sorry to hear about your experience. This is something I take seriously and want to look into personally. ${o}`,
    (o) => `I'm sorry to read this, and I want to understand exactly what happened. I'd rather not discuss the details here, so that I can look into it properly. ${o}`,
  ],
};

function offlineLine(settings, tone) {
  const c = String(settings.contactLine || '').trim();
  if (c) {
    return tone === 'professional' ? `Please contact me directly: ${c.replace(/[.\s]+$/, '')}.` : `Please reach me directly - ${c.replace(/[.\s]+$/, '')}.`;
  }
  return tone === 'professional' ? 'Please contact us directly so we can discuss this.' : 'Please get in touch with us directly so we can talk it through.';
}

function greetingFor(first, tone) {
  if (tone === 'professional') return first ? `Dear ${first},` : 'Hello,';
  if (tone === 'playful') return first ? `Hey ${first}!` : 'Hey there!';
  return first ? `Hi ${first},` : 'Hi there,';
}

function signOffFor(settings) {
  const who = [settings.ownerName, settings.businessName].filter(Boolean).join(', ');
  const lines = [settings.signOff, who].filter(Boolean);
  if (!lines.length) return '— The team';
  if (!settings.signOff) return `— ${who}`;
  return lines.join('\n');
}

/** A stable per-review starting variant, so two reviews answered from the
 *  template on the same day do not get the same words. */
function variantSeed(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * The free reply: tone-aware, per star rating, naming what they praised or
 * complained about, offline for the unhappy and the risky, signed off.
 * Deterministic for a given (review, settings, variant).
 */
function template(review, settings, variant = 0) {
  const s = { ...SETTINGS_DEFAULTS, ...settings };
  const tone = TONE_KEYS.includes(s.tone) ? s.tone : 'warm';
  const t = triageOf(review);
  const first = R.firstName(review.reviewer);
  const n = variantSeed(review.id) + Number(variant || 0);
  const p = joinAnd(t.praise.slice(0, 2).map((k) => PRAISE_PHRASE[k]).filter(Boolean));
  const c = joinAnd(t.complaints.slice(0, 2).map((k) => COMPLAINT_PHRASE[k]).filter(Boolean));
  const o = offlineLine(s, tone);
  let body;
  if (t.risk.flag) {
    body = T.risk[n % T.risk.length](o);
  } else {
    const bucket = review.stars >= 5 ? 'five' : review.stars === 4 ? 'four' : review.stars === 3 ? 'three' : 'low';
    const set = T[bucket][tone];
    body = set[n % set.length](p, c, o);
  }
  // A playful "Hey Brett!" is wrong for someone who had a bad time.
  const greetTone = tone === 'playful' && (t.risk.flag || review.stars <= 2) ? 'warm' : tone;
  return cleanText(`${greetingFor(first, greetTone)}\n\n${body.replace(/ - /g, ' — ')}\n\n${signOffFor(s)}`, LIMITS.reply);
}

/* ------------------------------------------------------------------ *
 * The scoreboard
 * ------------------------------------------------------------------ */

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round1 = (n) => Math.round(n * 10) / 10;
const avg = (a) => (a.length ? round1(a.reduce((x, y) => x + y, 0) / a.length) : null);

/** Hours from landing to answered, for the answered. A review logged as
 *  already answered before it was added (a backlog) has no reply time: it
 *  would read as an instant reply, and it was not one Rave saw. */
function replyHours(r) {
  if (!r.repliedAt) return null;
  const replied = Date.parse(r.repliedAt);
  if (r.addedAt && replied < Date.parse(r.addedAt)) return null;
  const h = (replied - arrivalMs(r)) / 3600000;
  return Number.isFinite(h) ? Math.max(0, h) : null;
}

/**
 * Inbox zero, day by day: a day counts when every review that had landed by
 * its end had been answered by its end. The current streak runs back from
 * today - or from yesterday while today still has something waiting, which
 * the page shows as "at risk" rather than as a broken streak at 9am.
 */
function streaks(reviews, today) {
  if (!reviews.length) return { current: 0, best: 0, atRisk: false, todayZero: true };
  const first = reviews.map(arrivalDay).sort()[0];
  const span = Math.min(400, Math.max(0, daysBetween(first, today)));
  const zero = [];
  for (let i = span; i >= 0; i--) {
    const d = addDays(today, -i);
    const open = reviews.some((r) => arrivalDay(r) <= d && (!r.repliedDay || r.repliedDay > d));
    zero.push(!open);
  }
  let best = 0, run = 0;
  for (const z of zero) { run = z ? run + 1 : 0; best = Math.max(best, run); }
  const todayZero = zero[zero.length - 1];
  let current = 0;
  for (let i = zero.length - (todayZero ? 1 : 2); i >= 0 && zero[i]; i--) current++;
  return { current, best, atRisk: !todayZero && current > 0, todayZero };
}

function monthsBack(today, n) {
  const [y, m] = today.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/** Praise versus complaints per topic, across every review's triage. */
function topicBoard(reviews) {
  const tally = {};
  for (const r of reviews) {
    const t = triageOf(r);
    for (const k of t.praise) (tally[k] = tally[k] || { praise: 0, complaints: 0 }).praise++;
    for (const k of t.complaints) (tally[k] = tally[k] || { praise: 0, complaints: 0 }).complaints++;
  }
  return Object.entries(tally)
    .map(([key, c]) => ({ ...R.topicInfo(key), key, praise: c.praise, complaints: c.complaints, net: c.praise - c.complaints }))
    .sort((a, b) => (b.praise + b.complaints) - (a.praise + a.complaints) || b.net - a.net);
}

function scoreboard(reviews, today) {
  const total = reviews.length;
  const replied = reviews.filter(isReplied);
  const since30 = addDays(today, -29);
  const recent = reviews.filter((r) => arrivalDay(r) >= since30);
  const hours = replied.map(replyHours).filter((h) => h != null);
  const stars = reviews.map((r) => r.stars);
  const last30 = reviews.filter((r) => r.date >= since30).map((r) => r.stars);
  const prev30 = reviews.filter((r) => r.date < since30 && r.date >= addDays(today, -59)).map((r) => r.stars);
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const s of stars) dist[s]++;
  const months = monthsBack(today, 6).map((m) => {
    const inM = reviews.filter((r) => (r.date || '').slice(0, 7) === m).map((r) => r.stars);
    return { month: m, avg: avg(inM), count: inM.length };
  });
  const topics = topicBoard(reviews);
  return {
    today,
    total,
    replied: replied.length,
    waiting: total - replied.length,
    urgentWaiting: reviews.filter((r) => !isReplied(r) && ['urgent', 'high'].includes(triageOf(r).urgency)).length,
    responseRate: total ? Math.round((100 * replied.length) / total) : null,
    recentResponseRate: recent.length ? Math.round((100 * recent.filter(isReplied).length) / recent.length) : null,
    recentCount: recent.length,
    medianReplyHours: hours.length ? round1(median(hours)) : null,
    avgRating: avg(stars),
    avg30: avg(last30),
    avgPrev30: avg(prev30),
    trend30: last30.length && prev30.length ? round1(avg(last30) - avg(prev30)) : null,
    months,
    distribution: dist,
    streak: streaks(reviews, today),
    topics,
    topPraise: [...topics].filter((t) => t.praise).sort((a, b) => b.praise - a.praise)[0] || null,
    topComplaint: [...topics].filter((t) => t.complaints).sort((a, b) => b.complaints - a.complaints)[0] || null,
  };
}

/* ------------------------------------------------------------------ *
 * Badges: earned once, kept
 * ------------------------------------------------------------------ */

const BADGES = [
  { key: 'first_reply', emoji: '💬', label: 'First reply', desc: 'Answered your first review.' },
  { key: 'inbox_zero', emoji: '🧹', label: 'Inbox zero', desc: 'Every review answered (3 or more).' },
  { key: 'streak_7', emoji: '🔥', label: 'Week of zero', desc: 'Seven days in a row at inbox zero.' },
  { key: 'cool_head', emoji: '🧊', label: 'Cool head', desc: 'Posted a reply you cooled down first.' },
  { key: 'rescue', emoji: '🛟', label: 'Rescue', desc: 'Answered a 1–2★ review within 24 hours.' },
  { key: 'quick_draw', emoji: '🐇', label: 'Quick draw', desc: 'Median reply under a day, over 10+ replies.' },
  { key: 'fifty', emoji: '🏅', label: 'Fifty answered', desc: 'Replied to 50 reviews.' },
  { key: 'wall', emoji: '💛', label: 'Wall of love', desc: 'Published your wall of love.' },
];

function earnedBadges(reviews, today, extra = {}) {
  const got = new Set();
  const replied = reviews.filter(isReplied);
  if (replied.length) got.add('first_reply');
  if (reviews.length >= 3 && replied.length === reviews.length) got.add('inbox_zero');
  if (streaks(reviews, today).best >= 7) got.add('streak_7');
  if (replied.some((r) => r.replySource === 'cooled')) got.add('cool_head');
  if (replied.some((r) => r.stars <= 2 && replyHours(r) != null && replyHours(r) <= 24)) got.add('rescue');
  const hours = replied.map(replyHours).filter((h) => h != null);
  if (hours.length >= 10 && median(hours) < 24) got.add('quick_draw');
  if (replied.length >= 50) got.add('fifty');
  if (extra.wall) got.add('wall');
  return got;
}

/* ------------------------------------------------------------------ *
 * The wall of love
 * ------------------------------------------------------------------ */

/**
 * The public wall, built field by field - never by copying review records -
 * so a private field added later cannot leak by default. First name and last
 * initial only; no uid, email, ids, triage, drafts or reply timings. Only 4-
 * and 5-star reviews with words in them. The owner's public reply rides along
 * only when they ask, and only once it is marked replied (it is already
 * public on the platform by then).
 */
function wallOf(settings, reviews, { title, showReplies } = {}, today = utcToday()) {
  const picked = reviews
    .filter((r) => r.favourite && r.stars >= 4 && (r.text || '').trim())
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, LIMITS.wall);
  return {
    business: { name: settings.businessName || '', what: settings.what || '' },
    title: clean(title, 80) || 'What our customers say',
    asOf: today,
    reviews: picked.map((r) => ({
      stars: r.stars,
      text: r.text,
      name: R.displayName(r.reviewer),
      platform: (PLATFORMS.find((p) => p.key === r.platform) || PLATFORMS[4]).label,
      date: r.date,
      reply: showReplies && r.repliedAt && r.reply && r.reply.text ? r.reply.text : '',
    })),
  };
}

module.exports = {
  LIMITS,
  PLATFORMS,
  PLATFORM_KEYS,
  TONES,
  TONE_KEYS,
  SENTIMENTS,
  SETTINGS_DEFAULTS,
  BADGES,
  clean,
  cleanText,
  httpError,
  isoDay,
  addDays,
  daysBetween,
  utcToday,
  todayFrom,
  dayFromText,
  cleanSettings,
  cleanReview,
  starsOf,
  validateTriage,
  triageOf,
  arrivalMs,
  arrivalDay,
  isReplied,
  view,
  sortViews,
  othersFor,
  lintFor,
  template,
  replyHours,
  streaks,
  scoreboard,
  topicBoard,
  earnedBadges,
  wallOf,
  median,
};
