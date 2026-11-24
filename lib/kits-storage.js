// Where the kit archives live: one private Cloud Storage bucket, read with
// the service's own runtime identity. No key file and no client library: a
// token from the metadata server and one GET on the JSON API, which is the
// shape every other outbound call here has.
//
// The bucket is never public and nothing here signs a URL. A download is
// served by this service (lib/kits.js, GET /kits/download), which checks its
// own expiring token AND the licence on every request, then streams the
// object through - so a refund stops a download link the moment it lands,
// which a pre-signed URL could not do.
//
// KITS_BUCKET unset (or not a bucket name): enabled() is false and every
// caller says "downloads unavailable" instead of failing.

const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const API = 'https://storage.googleapis.com/storage/v1';

function bucket() {
  const name = String(process.env.KITS_BUCKET || '').trim();
  return BUCKET_NAME.test(name) ? name : '';
}

function enabled() { return Boolean(bucket()); }

// The metadata token lasts about an hour; keep it until a minute before it
// ends. In memory, per instance - nothing is written anywhere.
let cached = { token: '', until: 0 };
async function accessToken(signal) {
  if (cached.token && Date.now() < cached.until) return cached.token;
  const res = await fetch(TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal });
  if (!res.ok) throw new Error(`metadata token ${res.status}`);
  const body = await res.json();
  if (!body || !body.access_token) throw new Error('metadata token missing');
  cached = { token: body.access_token, until: Date.now() + Math.max(0, (Number(body.expires_in) || 0) - 60) * 1000 };
  return cached.token;
}

/** Open one object for reading. Answers { ok, status, body (a web stream),
 *  length } and never throws for a missing object: 404 is a normal answer
 *  while a kit has not been uploaded yet. */
async function open(objectName, { signal } = {}) {
  const name = bucket();
  if (!name) return { ok: false, status: 503, body: null, length: null };
  const token = await accessToken(signal);
  const url = `${API}/b/${encodeURIComponent(name)}/o/${encodeURIComponent(objectName)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
  if (!res.ok) {
    // Drain so the socket is released; the body is an error document.
    try { await res.arrayBuffer(); } catch (e) { /* nothing to drain */ }
    return { ok: false, status: res.status, body: null, length: null };
  }
  const length = Number(res.headers.get('content-length'));
  return { ok: true, status: 200, body: res.body, length: Number.isFinite(length) && length > 0 ? length : null };
}

function _reset() { cached = { token: '', until: 0 }; }

module.exports = { enabled, bucket, open, _reset };
