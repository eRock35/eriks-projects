// Setups, shifts and share links: the server-side shapes, ids and views.
//
// The rules the page also needs (money in cents, validation, the split, the
// envelopes, the week, the CSV, the share card) live in public/rules.js and
// are required from here; this file holds what only the server does - ids,
// tokens, errors, caps and "today" as the browser sees it.

const crypto = require('crypto');
const R = require('../public/rules');

const LIMITS = {
  ...R.LIMITS,
  shifts: 2000,        // saved shifts per manager
  weekShifts: 60,      // shifts one week's view reads
  exportDays: 400,     // how many days one CSV covers
};

/** An error the app means the client to see, status and words as given.
 *  `expose` is what tells it apart from anything else carrying a `.status` -
 *  an Anthropic SDK error has one too, and its status and raw body are not
 *  ours to pass on. */
function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
/** 12 url-safe characters from 9 random bytes. */
const newId = () => crypto.randomBytes(9).toString('base64url');

/** A share link's secret: 22 url-safe characters from 16 random bytes (128
 *  bits). Nothing else about a shift or a person is in it or derivable from
 *  it, so links cannot be walked or guessed. */
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const newToken = () => crypto.randomBytes(16).toString('base64url');

const utcToday = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
/** The browser's own calendar day (sent as a header), within a day of UTC -
 *  so a bar closing at 1 a.m. in California files the right night. */
function todayFrom(v, now = Date.now()) {
  const d = R.isoDay(v);
  const utc = utcToday(now);
  if (!d) return utc;
  const diff = Math.round((Date.parse(d) - Date.parse(utc)) / 864e5);
  return Math.abs(diff) <= 1 ? d : utc;
}

/** A name for someone who has not given one: the front of their email. */
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0].split(/[._+-]/).filter(Boolean)[0] || 'there';
  return R.clean(local.charAt(0).toUpperCase() + local.slice(1), 30);
}

/** A stored shift, re-validated and recomputed: what every read answers
 *  with. Stored numbers are never trusted as the answer; the split is
 *  worked out again from the inputs with the same rules each time. */
function computed(doc) {
  const v = R.validateShift({ ...doc, cents: true }, null);
  if (v.error) return { id: doc.id, error: v.error };
  const result = R.split(v.shift);
  if (result.error) return { id: doc.id, error: result.error };
  return { id: doc.id, shift: v.shift, result, share: doc.share || null, createdAt: doc.createdAt || null, updatedAt: doc.updatedAt || null };
}

/** A shift as stored: the validated inputs only. */
function toStore(shift) {
  return {
    date: shift.date,
    part: shift.part,
    card: shift.card,
    cash: shift.cash,
    sales: shift.sales,
    crew: shift.crew.map((p) => ({ pid: p.pid, name: p.name, role: p.role, q: p.q })),
    drawer: shift.drawer,
    rules: shift.rules,
  };
}

/** The list row for history: totals only. */
function summary(c) {
  if (c.error) return { id: c.id, error: c.error };
  return {
    id: c.id,
    date: c.shift.date,
    part: c.shift.part,
    total: c.result.totalIn,
    card: c.result.card,
    cash: c.result.cash,
    people: c.result.people.length,
    hours: R.hoursText(c.shift.crew.reduce((s, p) => s + p.q, 0)),
    shared: Boolean(c.share && c.share.token),
    headsUp: Boolean(c.result.headsUp),
  };
}

function csvFilename(from, to) {
  return `tipout-${from}-to-${to}.csv`;
}

module.exports = { LIMITS, httpError, ID_RE, newId, TOKEN_RE, newToken, todayFrom, utcToday, nameFromEmail, computed, toStore, summary, csvFilename };
