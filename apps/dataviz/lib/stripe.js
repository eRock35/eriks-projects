// Stripe, without the SDK.
//
// Two calls and one signature check is the whole surface here, and the REST
// API is plain form-encoded POSTs. Pulling in the SDK for that would add a
// dependency tree to a container that currently has three packages, and this
// container cannot reach api.stripe.com at all - so the code has to be
// written to be correct from the docs rather than poked at interactively.
//
// The webhook signature check is the security-critical part. Anyone can POST
// to a webhook URL; only Stripe can sign the body.

const crypto = require('crypto');

const API = 'https://api.stripe.com/v1';
const TOLERANCE_SECONDS = 300;

function secretKey() { return process.env.STRIPE_SECRET_KEY || ''; }
function priceId() { return process.env.STRIPE_PRICE_ID || ''; }
function webhookSecret() { return process.env.STRIPE_WEBHOOK_SECRET || ''; }

function enabled() { return Boolean(secretKey() && priceId()); }

/** Stripe wants nested params as a[b][c]=v, not JSON. */
function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) form(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => {
      if (typeof item === 'object') form(item, `${key}[${i}]`, out);
      else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`);
    });
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}

async function call(path, body, method = 'POST') {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2026-08-27.basil',
    },
    body: body ? form(body).join('&') : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data.error && data.error.message) || `Stripe ${res.status}`;
    throw Object.assign(new Error(message), { status: 502, stripe: data.error || null });
  }
  return data;
}

/** A hosted checkout page for one subscription. */
async function createCheckout({ uid, email, successUrl, cancelUrl, customerId }) {
  const payload = {
    mode: 'subscription',
    line_items: [{ price: priceId(), quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    // The uid is what the webhook uses to find the account again. Stripe
    // echoes it back on every event for this subscription.
    client_reference_id: uid,
    metadata: { uid },
    subscription_data: { metadata: { uid } },
    allow_promotion_codes: true,
  };
  if (customerId) payload.customer = customerId;
  else if (email) payload.customer_email = email;
  return call('/checkout/sessions', payload);
}

/** The Stripe-hosted page where someone cancels or changes their card. Doing
 *  this ourselves would mean handling card details, which is the one thing
 *  using Stripe is meant to avoid. */
async function createPortal({ customerId, returnUrl }) {
  return call('/billing_portal/sessions', { customer: customerId, return_url: returnUrl });
}

/**
 * Verify a webhook came from Stripe.
 *
 * The signed payload is `${timestamp}.${rawBody}` - the RAW body, byte for
 * byte. If express.json() has already parsed and re-serialised it, the
 * signature will not match and the reason will not be obvious, so the webhook
 * route must be mounted with a raw body parser BEFORE the JSON one.
 */
function verifyWebhook(rawBody, signatureHeader) {
  const secret = webhookSecret();
  if (!secret) throw Object.assign(new Error('No STRIPE_WEBHOOK_SECRET is set.'), { status: 500 });
  if (!signatureHeader) throw Object.assign(new Error('No signature.'), { status: 400 });

  const parts = {};
  for (const piece of String(signatureHeader).split(',')) {
    const [k, v] = piece.split('=');
    if (k === 'v1') (parts.v1 = parts.v1 || []).push(v);
    else if (k) parts[k] = v;
  }
  if (!parts.t || !parts.v1 || !parts.v1.length) {
    throw Object.assign(new Error('Malformed signature.'), { status: 400 });
  }

  // A replayed old event is still correctly signed, so the age matters.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    throw Object.assign(new Error('Signature timestamp is outside the tolerance.'), { status: 400 });
  }

  const expected = crypto.createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody.toString('utf8')}`)
    .digest('hex');

  // Stripe may send several v1 signatures during a secret rotation; any one
  // matching is enough.
  const ok = parts.v1.some((sig) => {
    if (typeof sig !== 'string' || sig.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
  if (!ok) throw Object.assign(new Error('Signature did not match.'), { status: 400 });

  return JSON.parse(rawBody.toString('utf8'));
}

module.exports = { enabled, createCheckout, createPortal, verifyWebhook, call, form, priceId };
