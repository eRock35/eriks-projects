// Sending, via Resend.
//
// Resend is a plain REST API with a bearer key, which is the same shape as
// every other outbound call on this project. Two things about it are easy to
// get wrong and expensive to debug:
//
//  1. A User-Agent header is REQUIRED. Requests without one are rejected with
//     a 403, and Node's fetch does not set one by default.
//  2. The batch endpoint takes at most 100 messages per call, and the account
//     rate limit is per second, so batches are paced rather than fired at once.
//
// With no RESEND_API_KEY set the module reports itself as disabled and every
// send is a no-op that says so, rather than throwing. The site, the writing and
// the subscriber list all keep working without a mail provider configured.

const API = 'https://api.resend.com';
const BATCH_SIZE = 100;
const USER_AGENT = 'strongtechnicalconsulting.com (+https://www.strongtechnicalconsulting.com)';

function apiKey() {
  return process.env.RESEND_API_KEY || '';
}

function enabled() {
  return Boolean(apiKey() && from());
}

function from() {
  return process.env.NEWSLETTER_FROM || '';
}

function replyTo() {
  return process.env.NEWSLETTER_REPLY_TO || '';
}

// The last failure, kept in memory so the admin diagnostic can show what
// Resend actually said. Nothing on this project can read Cloud Run logs, so
// without this a failed send is a dead end: the visitor sees a polite message
// and the real reason is gone.
let lastError = null;
function lastFailure() {
  return lastError;
}

async function call(path, body, method = 'POST') {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error body */ }
  if (!res.ok) {
    const message = (parsed && (parsed.message || parsed.error)) || text || `HTTP ${res.status}`;
    const err = new Error(`Resend ${res.status}: ${message}`);
    err.status = res.status;
    lastError = { at: new Date().toISOString(), status: res.status, message, path };
    throw err;
  }
  return parsed;
}

/** Read-only: what Resend thinks of the sending domains. This is the
 *  authoritative answer to "is the domain verified yet".
 *
 *  The list endpoint returns summaries with no records, so each domain is
 *  fetched individually: knowing that a domain is unverified is much less
 *  useful than knowing which specific DNS record is missing. */
async function listDomains() {
  if (!apiKey()) return { error: 'No RESEND_API_KEY is set on this deployment.' };
  try {
    const body = await call('/domains', undefined, 'GET');
    const rows = (body && (body.data || body)) || [];
    const domains = [];
    for (const summary of Array.isArray(rows) ? rows : []) {
      const entry = {
        id: summary.id,
        name: summary.name,
        status: summary.status,
        region: summary.region,
        createdAt: summary.created_at,
        records: [],
      };
      if (summary.id) {
        try {
          const detail = await call(`/domains/${summary.id}`, undefined, 'GET');
          entry.status = detail.status || entry.status;
          entry.records = (detail.records || []).map((r) => ({
            type: r.type,
            name: r.name,
            status: r.status,
            value: typeof r.value === 'string' ? r.value.slice(0, 90) : r.value,
          }));
        } catch (err) {
          entry.recordsError = err.message;
        }
      }
      domains.push(entry);
    }
    return { domains };
  } catch (err) {
    return { error: err.message };
  }
}

/** One transactional message (confirmation, test send). */
async function sendOne({ to, subject, html, text, headers }) {
  if (!enabled()) return { skipped: 'email-disabled' };
  const payload = { from: from(), to: [to], subject, html };
  if (text) payload.text = text;
  if (headers) payload.headers = headers;
  if (replyTo()) payload.reply_to = replyTo();
  return call('/emails', payload);
}

/** Up to 100 messages in one request. The caller chunks and paces. */
async function sendBatch(messages) {
  if (!enabled()) return { skipped: 'email-disabled' };
  const payload = messages.map((m) => {
    const one = { from: from(), to: [m.to], subject: m.subject, html: m.html };
    if (m.text) one.text = m.text;
    if (m.headers) one.headers = m.headers;
    if (replyTo()) one.reply_to = replyTo();
    return one;
  });
  return call('/emails/batch', payload);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chunk, send and pace. Returns a per-recipient result so the caller can
 *  record exactly who received what and never send twice. */
async function sendMany(messages, { pauseMs = 600 } = {}) {
  const results = [];
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const chunk = messages.slice(i, i + BATCH_SIZE);
    try {
      const response = await sendBatch(chunk);
      const ids = (response && Array.isArray(response.data)) ? response.data : [];
      chunk.forEach((m, idx) => {
        results.push({ to: m.to, ok: true, id: (ids[idx] && ids[idx].id) || null });
      });
    } catch (err) {
      chunk.forEach((m) => results.push({ to: m.to, ok: false, error: err.message }));
    }
    if (i + BATCH_SIZE < messages.length) await sleep(pauseMs);
  }
  return results;
}

module.exports = { enabled, from, sendOne, sendMany, listDomains, lastFailure, BATCH_SIZE };
