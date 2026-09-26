// Days, deposits and settings: the server-side shapes, ids and views.
//
// The rules the page also needs (money in cents, the settlement calendar, the
// fee model, matching, the month, CSV in and out) live in public/rules.js and
// are required from here; this file holds what only the server does - ids,
// errors, the views it answers with and "today" as the browser sees it.

const crypto = require('crypto');
const R = require('../public/rules');

const LIMITS = { ...R.LIMITS };

/** An error the app means the client to see, status and words as given.
 *  `expose` is what tells it apart from anything else carrying a `.status` -
 *  an Anthropic SDK error has one too, and its status and raw body are not
 *  ours to pass on. */
function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}

const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
/** 12 url-safe characters from 9 random bytes. */
const newId = () => crypto.randomBytes(9).toString('base64url');

const utcToday = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
/** The browser's own calendar day (sent as a header), within a day of UTC -
 *  so a café closing at 9pm in California closes the right day. */
function todayFrom(v, now = Date.now()) {
  const d = R.isoDay(v);
  const utc = utcToday(now);
  return d && Math.abs(R.daysBetween(utc, d)) <= 1 ? d : utc;
}

/** A name for someone who has not given one: the front of their email. */
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0].split(/[._+-]/).filter(Boolean)[0] || 'there';
  return R.clean(local.charAt(0).toUpperCase() + local.slice(1), 30);
}

const dayView = (d) => ({
  date: d.date, grossCents: d.grossCents, refundsCents: d.refundsCents || 0, tipsCents: d.tipsCents || 0,
  txCount: d.txCount || 0, note: d.note || '', source: d.source || 'typed', updatedAt: d.updatedAt || null,
});
const depositView = (d) => ({
  id: d.id, date: d.date, amountCents: d.amountCents, description: d.description || 'Card deposit',
  source: d.source || 'typed', createdAt: d.createdAt || null,
});

module.exports = { LIMITS, httpError, ID_RE, newId, todayFrom, utcToday, nameFromEmail, dayView, depositView };
