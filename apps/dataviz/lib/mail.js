// Just enough Resend to send a password reset.
//
// Two things about Resend are easy to get wrong and expensive to debug:
// a User-Agent header is REQUIRED (Node's fetch sends none, and requests
// without one are rejected with a 403), and the sending domain has to be
// verified or nothing leaves the building.
//
// With no RESEND_API_KEY set this reports itself disabled and every send is a
// no-op rather than a throw, so the rest of the app keeps working without a
// mail provider configured.

const API = 'https://api.resend.com';
const USER_AGENT = 'dataviz (+https://dataviz.strongtechnicalconsulting.com)';

function apiKey() { return process.env.RESEND_API_KEY || ''; }
function from() { return process.env.MAIL_FROM || ''; }
function enabled() { return Boolean(apiKey() && from()); }

let lastError = null;
function lastFailure() { return lastError; }

async function send({ to, subject, html, text }) {
  if (!enabled()) return { skipped: 'mail-disabled' };
  const res = await fetch(`${API}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ from: from(), to: [to], subject, html, text }),
  });
  const body = await res.text();
  if (!res.ok) {
    let message = body;
    try { const j = JSON.parse(body); message = j.message || j.error || body; } catch (e) {}
    lastError = { at: new Date().toISOString(), status: res.status, message };
    throw new Error(`Resend ${res.status}: ${message}`);
  }
  return JSON.parse(body || '{}');
}

module.exports = { enabled, from, send, lastFailure };
