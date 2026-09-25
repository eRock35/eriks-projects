// Events, members and leads: the server-side shapes, limits and exports.
//
// The rules the page also needs (lead validation, the cold clock, dedupe,
// status, leaderboard, scorecard, templates, join-code format) live in
// public/rules.js and are required from here; this file holds what only the
// server does - ids, codes, caps, cleaning an event, the CSV export and the
// frozen share card.

const crypto = require('crypto');
const B = require('../public/rules');

const LIMITS = {
  members: 25,          // people on one event's team
  ownedEvents: 20,      // events one person runs
  memberships: 40,      // events one person is on
  leads: 1000,          // leads at one event
  joinTries: 8,         // wrong codes per person per window
  joinTriesPerIp: 30,   // and per address, for someone with many accounts
  joinWindowMs: 15 * 60 * 1000,
  ...B.LIMITS,
};

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{22,40}$/;

/** 12 url-safe characters from 9 random bytes. */
const newId = () => crypto.randomBytes(9).toString('base64url');
/** 22 url-safe characters from 16 random bytes: a share link's secret. */
const newToken = () => crypto.randomBytes(16).toString('base64url');

/** A join code: 8 characters, each drawn uniformly from the 32 in the
 *  alphabet (rejection sampling, so no character is likelier than another). */
function newCode() {
  let out = '';
  while (out.length < B.CODE_LEN) {
    for (const b of crypto.randomBytes(16)) {
      if (b < 256 - (256 % B.CODE_ALPHABET.length)) out += B.CODE_ALPHABET[b % B.CODE_ALPHABET.length];
      if (out.length === B.CODE_LEN) break;
    }
  }
  return out;
}

const utcToday = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** A name for someone who has not given one: the front of their email. */
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0].split(/[._+-]/).filter(Boolean)[0] || 'Teammate';
  return B.clean(local.charAt(0).toUpperCase() + local.slice(1), LIMITS.personName);
}

/** The interests the owner defines per event: trimmed, distinct, bounded. */
function cleanChips(list) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(list) ? list : String(list || '').split(',')) {
    const t = B.clean(c, LIMITS.chip);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= LIMITS.chips) break;
  }
  return out;
}

/** An event from the create or edit form. Fields not sent keep `prev`. */
function cleanEvent(b, prev = {}, today = utcToday()) {
  b = b || {};
  const out = {};
  if (b.name !== undefined || !prev.name) {
    const name = B.clean(b.name, LIMITS.eventName);
    if (name.length < 2) throw httpError(400, 'Give the event a name.');
    out.name = name;
  }
  if (b.place !== undefined || prev.place === undefined) out.place = B.clean(b.place, LIMITS.place);
  const start = b.startDate !== undefined ? b.startDate : (prev.startDate || today);
  const end = b.endDate !== undefined ? b.endDate : (prev.endDate || start);
  if (!B.isoDay(start)) throw httpError(400, 'The start date is not a date.');
  if (!B.isoDay(end || start)) throw httpError(400, 'The end date is not a date.');
  const e = end || start;
  if (e < start) throw httpError(400, 'The show ends before it starts.');
  if (B.daysBetween(start, e) > LIMITS.eventDays) throw httpError(400, `A show runs ${LIMITS.eventDays} days at most - split a longer season into events.`);
  if (start < '2020-01-01' || start > '2100-01-01') throw httpError(400, 'The start date is out of range.');
  out.startDate = start;
  out.endDate = e;
  if (b.boothCost !== undefined || prev.boothCost === undefined) {
    const c = B.toNumber(b.boothCost);
    if (c !== null && (Number.isNaN(c) || c < 0 || c > LIMITS.boothCost)) throw httpError(400, 'Booth cost is a number of dollars.');
    out.boothCost = c === null ? 0 : Math.round(c);
  }
  if (b.chips !== undefined || !prev.chips) {
    out.chips = b.chips === undefined ? B.DEFAULT_CHIPS.slice() : cleanChips(b.chips);
  }
  return out;
}

/** Your name, sign-off and tone on one event's team. */
function cleanMember(b, prev = {}) {
  b = b || {};
  const out = {};
  if (b.name !== undefined) {
    const n = B.clean(b.name, LIMITS.personName);
    if (!n) throw httpError(400, 'Give yourself a name the team will recognise.');
    out.name = n;
  }
  if (b.signoff !== undefined) out.signoff = B.clean(b.signoff, LIMITS.signoff);
  if (b.tone !== undefined) out.tone = B.TONE_KEYS.includes(b.tone) ? b.tone : (prev.tone || 'friendly');
  return out;
}

/** The fields a lead document carries, for the page. Everything the team
 *  captured is visible to the whole team - it is the team's pipeline. */
function leadView(l, now) {
  return {
    id: l.id,
    name: l.name || '',
    company: l.company || '',
    title: l.title || '',
    email: l.email || '',
    phone: l.phone || '',
    temp: l.temp,
    chips: l.chips || [],
    next: l.next || '',
    note: l.note || '',
    source: l.source || 'typed',
    status: l.status || 'new',
    value: l.value == null ? null : l.value,
    capturedBy: l.capturedBy,
    capturedByName: l.capturedByName || '',
    capturedAt: l.capturedAt,
    sentAt: l.sentAt || null,
    sentBy: l.sentBy || null,
    repliedAt: l.repliedAt || null,
    bookedAt: l.bookedAt || null,
    wonAt: l.wonAt || null,
    lostAt: l.lostAt || null,
    mergedCount: l.mergedCount || 0,
    updatedAt: l.updatedAt || l.capturedAt,
    clock: B.clock(l, now),
  };
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

/**
 * One cell. A cell a spreadsheet would run as a formula - it starts with
 * =, +, -, @, a tab or a carriage return - gets a leading apostrophe, so
 * "=HYPERLINK(...)" typed into a badge's company field stays text when the
 * owner opens the export. Then the usual CSV quoting.
 */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const CSV_COLUMNS = [
  ['Name', (l) => l.name], ['Company', (l) => l.company], ['Title', (l) => l.title],
  ['Email', (l) => l.email], ['Phone', (l) => l.phone],
  ['Temperature', (l) => B.tempInfo(l.temp).label], ['Interests', (l) => (l.chips || []).join('; ')],
  ['Next step', (l) => (B.nextInfo(l.next) || {}).label || ''], ['Note', (l) => l.note],
  ['Captured by', (l) => l.capturedByName], ['Captured at', (l) => l.capturedAt],
  ['Follow-up', (l) => B.clockLabel(l.clock)], ['Status', (l) => B.statusInfo(l.status).label],
  ['Followed up at', (l) => l.sentAt], ['Replied at', (l) => l.repliedAt], ['Meeting booked at', (l) => l.bookedAt],
  ['Won at', (l) => l.wonAt], ['Lost at', (l) => l.lostAt], ['Deal value (USD)', (l) => (l.value == null ? '' : l.value)],
];

/** The event's leads as a CSV a spreadsheet opens cleanly (BOM, CRLF). */
function toCsv(leads) {
  const rows = [CSV_COLUMNS.map((c) => csvCell(c[0])).join(',')];
  for (const l of leads) rows.push(CSV_COLUMNS.map((c) => csvCell(c[1](l))).join(','));
  return `﻿${rows.join('\r\n')}\r\n`;
}

function csvFilename(name, day) {
  const slug = String(name || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'event';
  return `booth-${slug}-${day}.csv`;
}

/* ------------------------------------------------------------------ *
 * The share card
 * ------------------------------------------------------------------ */

/**
 * The frozen, public scorecard. Built field by field from the aggregates -
 * never from a lead - so no name, company, email, phone, note or teammate
 * can ride along by accident. Counts, rates, money and dates only.
 */
function shareCard(event, sc, teamSize, at) {
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  return {
    event: { name: event.name, place: event.place || '', startDate: event.startDate, endDate: event.endDate },
    teamSize,
    frozenAt: at,
    ...pick(sc, ['leads', 'followedUp', 'within48', 'within48Rate', 'onTime', 'onTimeRate', 'wentCold', 'replies', 'replyRate',
      'meetings', 'won', 'lost', 'wonValue', 'pipelineValue', 'boothCost', 'costPerLead', 'costPerMeeting', 'roi', 'coverage']),
    temps: { hot: sc.temps.hot || 0, warm: sc.temps.warm || 0, cold: sc.temps.cold || 0 },
    funnel: sc.funnel.map((f) => ({ key: f.key, label: f.label, n: f.n })),
    chips: sc.chips.slice(0, 8).map((c) => ({ chip: c.chip, n: c.n })),
    days: sc.days.map((d) => ({ day: d.day, n: d.n })),
    verdict: { key: sc.verdict.key, emoji: sc.verdict.emoji, text: sc.verdict.text },
  };
}

module.exports = {
  LIMITS, ID_RE, TOKEN_RE,
  httpError, newId, newToken, newCode, utcToday, nameFromEmail,
  cleanChips, cleanEvent, cleanMember, leadView,
  csvCell, toCsv, csvFilename, CSV_COLUMNS, shareCard,
};
