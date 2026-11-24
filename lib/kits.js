// Lab Kits, phase 1: the licence and delivery service (2026-11-24).
//
// Two setup-code kits are sold from this site. A buyer pays on a Stripe
// Payment Link; Stripe tells this service; it issues a licence key, mails the
// key and an expiring download link, and afterwards answers the installer's
// "is this key good?" at setup and on --update. A refund revokes the key.
//
// It lives on the landing service because everything it needs is already
// here and nowhere else: the mail key (only the landing holds
// RESEND_API_KEY), the site the kit pages are part of, and a store. A new
// Cloud Run service would have meant a new runtime account, new secrets and
// a second copy of the mail key to say what this file says.
//
// What is where:
//   config/kits.json      prices (null until Erik sets them), brand, tax code
//   lib/kits-storage.js   reading the private bucket
//   lib/kits-pages.js     /kits and the two kit pages
//   scripts/kits-stripe.js  creates the Stripe products, prices and links
//   test/kits*.js
//
// Stripe delivers to this service on an endpoint OF ITS OWN
// (/api/kits/stripe/webhook), with its own signing secret, mounted here as
// STRIPE_WEBHOOK_SECRET so the signature check is shared/stripe.js's
// verifyWebhook, unchanged. DataViz's endpoint and its secret are untouched.
// Both endpoints receive every event of the types they subscribe to, so each
// ignores what is not its own: this one acts only on `metadata.kind ===
// 'kit'`, and a kit link never carries `metadata.uid` or a
// client_reference_id, which is what DataViz reads as an account.

const crypto = require('crypto');
const { Readable } = require('stream');
const path = require('path');

const stripe = require('../shared/stripe');
const storage = require('./kits-storage');

const CONFIG = require(path.join(__dirname, '..', 'config', 'kits.json'));

// The brand is a placeholder until Erik names it: change it in
// config/kits.json and every page, email and Stripe product follows.
const BRAND = String(CONFIG.brand || 'Lab Kits');
const SELLER = String(CONFIG.seller || 'Strong Technical Consulting');
const REFUND_DAYS = Number(CONFIG.refundDays) || 14;
const UPDATES_MONTHS = Number(CONFIG.updatesMonths) || 12;

// What can be bought. `updates`: does the purchase come with a year of
// updates. `artifact`: which archive in the bucket it downloads. Hosted is
// phase 4 and is not sold here at all.
const TIERS = {
  scripts: { name: 'Scripts only', updates: false, artifact: 'scripts' },
  kit: { name: 'Self-setup kit', updates: true, artifact: 'kit' },
  dfy: { name: 'Done-for-you', updates: true, artifact: 'kit' },
};
const RENEWAL = 'renewal';
const KIT_SLUGS = Object.keys(CONFIG.kits || {});

const LICENSES = 'kit-licenses';
const EVENTS = 'kit-events';

const KEY_SHAPE = /^lk_[a-z2-7]{32}$/;
const EMAIL_LINK_HOURS = 48;
const FRESH_LINK_MINUTES = 15;
// A key can fetch its archive again for this long after buying even with no
// updates (the scripts tier has none). After that, only while updates run -
// otherwise a lapsed licence could take every new release as a "re-download".
const REDOWNLOAD_DAYS = 30;
const MAIL_TIMEOUT_MS = 8000;

function kitName(slug) { return (CONFIG.kits[slug] && CONFIG.kits[slug].name) || slug; }
function isKit(slug) { return typeof slug === 'string' && KIT_SLUGS.includes(slug); }

/* ------------------------------------------------------------------ *
 * Keys and tokens
 * ------------------------------------------------------------------ */

// One secret, KITS_SECRET, and every use takes a key DERIVED from it under
// its own label, so a download token can never pass as anything else.
function secret() {
  const s = String(process.env.KITS_SECRET || '');
  return s.length >= 32 ? s : '';
}
function enabled() { return Boolean(secret()); }
function derived(label) {
  return crypto.createHmac('sha256', secret()).update(label).digest();
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The licence key for one purchase.
 *
 * It is not random: it is an HMAC of the Checkout Session id, 160 bits,
 * under a key only this service holds. Nobody without KITS_SECRET can tell
 * it from random or guess one, and it buys two things a random key cannot.
 * Stripe may deliver an event again, or a mail may fail and be retried: the
 * same purchase always makes the same key, so nothing is issued twice. And
 * the store keeps only the key's SHA-256, never the key - a read of the
 * database gives nobody a working licence - yet the mail can still be sent
 * again, because the key can be made again from the session id.
 */
function keyFor(sessionId) {
  const mac = crypto.createHmac('sha256', derived('kits license key v1')).update(String(sessionId)).digest();
  return 'lk_' + base32(mac.subarray(0, 20));
}
function hashKey(key) { return crypto.createHash('sha256').update(String(key)).digest('hex'); }
// A name for a licence that is safe to put in a link or a log: it is not the
// key and cannot be turned into it.
function publicId(keyHash) { return 'lic_' + keyHash.slice(0, 20); }

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

/** `<licence id>.<expiry, seconds>.<mac>` - what a download link carries. */
function makeDownloadToken(licenseId, ttlSeconds, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const body = `${licenseId}.${exp}`;
  const mac = crypto.createHmac('sha256', derived('kits download v1')).update(body).digest();
  return `${body}.${b64url(mac)}`;
}
function readDownloadToken(token, now = Date.now()) {
  if (!enabled() || typeof token !== 'string' || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, mac] = parts;
  if (!/^lic_[0-9a-f]{20}$/.test(id) || !/^\d{9,11}$/.test(exp)) return null;
  const want = crypto.createHmac('sha256', derived('kits download v1')).update(`${id}.${exp}`).digest();
  let got;
  try { got = Buffer.from(mac, 'base64url'); } catch (e) { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  if (Number(exp) * 1000 <= now) return null;
  return { id, exp: Number(exp) };
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

function addMonths(from, months) {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // 31 Jan + 1 month is not 3 March.
  if (d.getUTCDate() !== day) d.setUTCDate(0);
  return d;
}
function updatesActive(license, now = Date.now()) {
  const until = Date.parse(license && license.updatesUntil);
  return Number.isFinite(until) && until > now;
}
function longDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/* ------------------------------------------------------------------ *
 * The mail
 * ------------------------------------------------------------------ */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function siteOrigin() {
  return String(process.env.SITE_ORIGIN || 'https://strongtechnicalconsulting.com').replace(/\/+$/, '');
}
function downloadUrl(token) { return `${siteOrigin()}/kits/download?t=${encodeURIComponent(token)}`; }

/** The one message a buyer gets. It carries their own key and their own
 *  download link and nothing else that is secret. */
function deliveryMail({ license, key, link }) {
  const kit = kitName(license.kit);
  const tier = (TIERS[license.tier] || {}).name || license.tier;
  const again = `${siteOrigin()}/kits/download`;
  const lines = [
    `Thanks for buying the ${kit} (${tier}) from ${SELLER}.`,
    '',
    'Your license key:',
    `    ${key}`,
    '',
  ];
  if (link) {
    lines.push(`Download (this link works for ${EMAIL_LINK_HOURS} hours):`, `    ${link}`, '',
      `If it has expired, get a new one with your key at ${again}`);
  } else {
    lines.push('The download is not available at this moment.',
      `Get it with your key at ${again} - nothing more is needed from you.`);
  }
  lines.push('');
  if (license.tier === 'scripts') {
    lines.push('Unzip it and read README.md first. The scripts tier does not include updates.');
  } else {
    lines.push('Unzip it and run ./setup.sh - it asks for this key once.',
      `Updates are included until ${longDate(license.updatesUntil)} (./setup.sh --update).`,
      'After that the kit keeps working; only --update stops until you renew.');
  }
  if (license.tier === 'dfy') lines.push('', 'Done-for-you: Erik will write to this address to arrange your setup.');
  lines.push('',
    'Keep this message: the key is not shown anywhere else.',
    `Refunds: ${REFUND_DAYS} days, no questions. A refund switches the key off.`,
    `Help is self-service: the README, ./setup.sh --doctor and ${siteOrigin()}/kits`,
    '', `- ${SELLER}`);
  const text = lines.join('\n');

  const p = (s) => `<p style="margin:0 0 14px">${s}</p>`;
  const html = [
    '<div style="font:16px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#0b1020;max-width:34em">',
    p(`Thanks for buying the <b>${esc(kit)}</b> (${esc(tier)}) from ${esc(SELLER)}.`),
    p('Your license key:'),
    `<p style="margin:0 0 18px;padding:12px 14px;background:#e9edf4;border-radius:8px;font:15px ui-monospace,Menlo,Consolas,monospace;word-break:break-all">${esc(key)}</p>`,
    link
      ? p(`<a href="${esc(link)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#2343d8;color:#fff;font-weight:600;text-decoration:none">Download the kit</a>`)
        + p(`That link works for ${EMAIL_LINK_HOURS} hours. If it has expired, get a new one with your key at <a href="${esc(again)}">${esc(again)}</a>.`)
      : p(`The download is not available at this moment. Get it with your key at <a href="${esc(again)}">${esc(again)}</a> - nothing more is needed from you.`),
    license.tier === 'scripts'
      ? p('Unzip it and read <code>README.md</code> first. The scripts tier does not include updates.')
      : p(`Unzip it and run <code>./setup.sh</code> - it asks for this key once. Updates are included until <b>${esc(longDate(license.updatesUntil))}</b> (<code>./setup.sh --update</code>). After that the kit keeps working; only <code>--update</code> stops until you renew.`),
    license.tier === 'dfy' ? p('Done-for-you: Erik will write to this address to arrange your setup.') : '',
    p(`Keep this message: the key is not shown anywhere else.<br>Refunds: ${REFUND_DAYS} days, no questions. A refund switches the key off.<br>Help is self-service: the README, <code>./setup.sh --doctor</code> and <a href="${esc(siteOrigin())}/kits">${esc(siteOrigin().replace(/^https?:\/\//, ''))}/kits</a>.`),
    `<p style="margin:18px 0 0;color:#566078">${esc(SELLER)}</p>`,
    '</div>',
  ].join('\n');

  return { to: license.email, subject: `Your ${kit}: license key and download`, text, html };
}

/* ------------------------------------------------------------------ *
 * The service. `make()` takes its two outside things - the store and the
 * mail sender - so the tests can hand it stand-ins.
 * ------------------------------------------------------------------ */

function make({ store, sendMail, now = () => Date.now() }) {
  const db = () => (typeof store === 'function' ? store() : store);
  const iso = () => new Date(now()).toISOString();

  async function byField(field, value) {
    if (!value) return [];
    return db().list(LICENSES, { where: [[field, '==', value]], limit: 20 });
  }
  async function byId(id) {
    const rows = await byField('id', id);
    return rows[0] || null;
  }

  /** Send (or send again) the buyer's mail. Records how it went; throws when
   *  it did not go, so the webhook answers 500 and Stripe tries again. */
  async function deliver(license, sessionId) {
    if (!license.email) {
      await db().update(LICENSES, license.keyHash, { deliveryError: 'no email on the checkout session' });
      console.error('[kits] no buyer email on', license.id);
      return { sent: false };
    }
    const key = keyFor(sessionId);
    const link = storage.enabled()
      ? downloadUrl(makeDownloadToken(license.id, EMAIL_LINK_HOURS * 3600, now()))
      : null;
    let result;
    try {
      result = await sendMail(Object.assign(deliveryMail({ license, key, link }), { signal: AbortSignal.timeout(MAIL_TIMEOUT_MS) }));
    } catch (err) {
      await db().update(LICENSES, license.keyHash, { deliveryError: String(err && err.message || err).slice(0, 200) }).catch(() => {});
      throw new Error('delivery mail failed');
    }
    if (result && result.skipped) {
      // No mail provider on this deployment. The buyer has paid: fail, so
      // Stripe keeps retrying and its dashboard shows the endpoint failing.
      await db().update(LICENSES, license.keyHash, { deliveryError: String(result.skipped) }).catch(() => {});
      throw new Error('delivery mail is not configured');
    }
    await db().update(LICENSES, license.keyHash, { deliveredAt: iso(), deliveryError: null, downloadInMail: Boolean(link) });
    return { sent: true };
  }

  /** A paid one-time purchase: one licence, once, and its mail. */
  async function issue(session, { kit, tier }) {
    const key = keyFor(session.id);
    const keyHash = hashKey(key);
    const createdAt = iso();
    const email = String((session.customer_details && session.customer_details.email) || session.customer_email || '').trim().toLowerCase();
    const record = {
      id: publicId(keyHash),
      keyHash,
      kit,
      tier,
      email,
      status: 'active',
      updatesUntil: TIERS[tier].updates ? addMonths(now(), UPDATES_MONTHS).toISOString() : null,
      createdAt,
      refundedAt: null,
      revokedReason: null,
      livemode: Boolean(session.livemode),
      stripeSessionId: session.id,
      stripePaymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
      stripeCustomerId: typeof session.customer === 'string' ? session.customer : null,
      stripeSubscriptionId: null,
      subscriptionStatus: null,
      deliveredAt: null,
      deliveryError: null,
    };
    // Write-if-absent: a second delivery of the same purchase changes nothing.
    await db().updateIf(LICENSES, keyHash, (current) => (current ? null : record));
    const license = await db().get(LICENSES, keyHash);
    if (license.status !== 'active' || license.deliveredAt) return 'issued-already';
    await deliver(license, session.id);
    return 'issued';
  }

  /** A paid "Updates renewal" subscription: tie it to the buyer's licence
   *  for that kit, found by the address they paid with, and give the year. */
  async function linkRenewal(session, { kit }) {
    const email = String((session.customer_details && session.customer_details.email) || session.customer_email || '').trim().toLowerCase();
    const sub = typeof session.subscription === 'string' ? session.subscription : null;
    if (!sub) return 'renewal-without-subscription';
    const already = await byField('stripeSubscriptionId', sub);
    if (already.length) return 'renewal-already-linked';
    const mine = (await byField('email', email))
      .filter((l) => l.kit === kit && l.status === 'active' && TIERS[l.tier] && TIERS[l.tier].updates)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!mine.length) {
      // Paid, and nothing to attach it to (another address, or a scripts-only
      // licence). Nothing can be granted; it is recorded and logged, and it
      // is Erik's to refund in Stripe.
      console.error('[kits] renewal paid with no matching licence', session.id, kit);
      return 'renewal-unmatched';
    }
    const license = mine[0];
    const from = Math.max(now(), Date.parse(license.updatesUntil) || 0);
    await db().update(LICENSES, license.keyHash, {
      stripeSubscriptionId: sub,
      stripeCustomerId: typeof session.customer === 'string' ? session.customer : license.stripeCustomerId || null,
      subscriptionStatus: 'active',
      updatesUntil: addMonths(from, UPDATES_MONTHS).toISOString(),
      renewedAt: iso(),
    });
    return 'renewal-linked';
  }

  async function revoke(license, reason) {
    if (license.status === 'revoked') return 'revoked-already';
    await db().update(LICENSES, license.keyHash, {
      status: 'revoked', revokedReason: reason, revokedAt: iso(),
      refundedAt: reason === 'refund' ? iso() : license.refundedAt || null,
    });
    return 'revoked';
  }

  /**
   * Fold one verified Stripe event in. Returns a short note for the event
   * record; throws only when something of ours failed and Stripe should
   * send it again. Everything that is not a kit's is acknowledged and left
   * alone - this endpoint sees the account's other checkouts too.
   */
  async function applyEvent(event) {
    const obj = (event.data && event.data.object) || {};
    const meta = obj.metadata || {};

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      if (meta.kind !== 'kit') return 'not-a-kit';
      if (!isKit(meta.kit)) return 'unknown-kit';
      // Completing the form is not paying: a delayed method completes
      // `unpaid` and settles (or not) days later as async_payment_succeeded.
      const settled = obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required';
      if (!settled) return 'awaiting-payment';
      if (meta.tier === RENEWAL) {
        if (obj.mode !== 'subscription') return 'renewal-wrong-mode';
        return linkRenewal(obj, { kit: meta.kit });
      }
      if (!TIERS[meta.tier]) return 'unknown-tier';
      if (obj.mode !== 'payment') return 'kit-wrong-mode';
      return issue(obj, { kit: meta.kit, tier: meta.tier });
    }

    // A refund revokes the licence. A FULL refund: `refunded` is true only
    // when the whole charge has gone back. A partial one is recorded and the
    // key left alone - Erik chose to give some back, not to end the licence.
    if (event.type === 'charge.refunded') {
      const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
      const rows = await byField('stripePaymentIntent', pi);
      if (!rows.length) return 'no-licence';
      if (obj.refunded !== true) {
        await db().update(LICENSES, rows[0].keyHash, { partialRefundAt: iso() });
        return 'partial-refund';
      }
      return revoke(rows[0], 'refund');
    }
    if (event.type === 'charge.dispute.created') {
      const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
      const rows = await byField('stripePaymentIntent', pi);
      if (!rows.length) return 'no-licence';
      return revoke(rows[0], 'dispute');
    }

    // A renewal that was actually paid adds a year, from the later of today
    // and where updates already ran to. Only a paid invoice does this - a
    // subscription rolls its period forward before the card is charged. The
    // first invoice is the checkout itself, which linkRenewal already gave.
    if (event.type === 'invoice.paid') {
      if (obj.billing_reason !== 'subscription_cycle') return 'not-a-renewal-cycle';
      const details = obj.parent && obj.parent.subscription_details;
      const sub = (typeof obj.subscription === 'string' && obj.subscription)
        || (details && typeof details.subscription === 'string' && details.subscription) || null;
      const rows = await byField('stripeSubscriptionId', sub);
      if (!rows.length) return 'no-licence';
      const license = rows[0];
      const paid = Array.isArray(license.paidInvoices) ? license.paidInvoices : [];
      if (paid.includes(obj.id)) return 'invoice-already-counted';
      if (license.status !== 'active') return 'licence-revoked';
      const from = Math.max(now(), Date.parse(license.updatesUntil) || 0);
      await db().update(LICENSES, license.keyHash, {
        updatesUntil: addMonths(from, UPDATES_MONTHS).toISOString(),
        paidInvoices: paid.concat(obj.id).slice(-24),
        renewedAt: iso(),
      });
      return 'renewed';
    }

    // The subscription's own state is recorded, never acted on: a cancelled
    // or lapsed renewal takes nothing away. Updates simply end at
    // updatesUntil, and the kit keeps working.
    if (/^customer\.subscription\.(created|updated|deleted)$/.test(event.type)) {
      const rows = await byField('stripeSubscriptionId', obj.id);
      if (!rows.length) return 'no-licence';
      await db().update(LICENSES, rows[0].keyHash, {
        subscriptionStatus: event.type.endsWith('deleted') ? 'canceled' : String(obj.status || ''),
        cancelAtPeriodEnd: Boolean(obj.cancel_at_period_end),
      });
      return 'subscription-recorded';
    }

    return 'ignored';
  }

  /**
   * One delivery from Stripe: verify, claim, apply.
   *
   * The same shape as DataViz's webhook. The claim is a write-if-absent on
   * kit-events/<event id>, so exactly one delivery applies an event; a claim
   * whose apply fails is released for Stripe's retry; a delivery that meets
   * a claim still being applied is told to come back (409) rather than told
   * "done"; a claim left by a dead instance is taken over after two minutes.
   */
  async function handleWebhook(rawBody, signature) {
    let event;
    try {
      event = stripe.verifyWebhook(rawBody, signature);
    } catch (err) {
      return { status: err.status || 400, body: { error: err.message } };
    }
    if (!enabled()) return { status: 503, body: { error: 'Kits are not configured.' } };
    if (!event || typeof event.id !== 'string' || !/^[A-Za-z0-9_]{6,120}$/.test(event.id)) {
      return { status: 400, body: { error: 'Malformed event.' } };
    }
    const claim = { type: String(event.type || ''), state: 'applying', claimedAt: iso() };
    try {
      let got = await db().updateIf(EVENTS, event.id, (current) => (current ? null : claim));
      if (!got.ok) {
        const seen = got.doc || {};
        if (seen.state !== 'applying') return { status: 200, body: { received: true, duplicate: true } };
        const stale = now() - Date.parse(seen.claimedAt || 0) > 2 * 60 * 1000;
        if (!stale) return { status: 409, body: { error: 'That event is being applied; try again.' } };
        got = await db().updateIf(EVENTS, event.id, (current) => (
          current && current.state === 'applying' && current.claimedAt === seen.claimedAt ? claim : null));
        if (!got.ok) return { status: 409, body: { error: 'That event is being applied; try again.' } };
      }
    } catch (err) {
      console.error('[kits] webhook claim failed:', event.type, err.message);
      return { status: 500, body: { error: 'Could not record that event.' } };
    }
    try {
      const note = await applyEvent(event);
      await db().update(EVENTS, event.id, { state: 'applied', appliedAt: iso(), note });
      return { status: 200, body: { received: true } };
    } catch (err) {
      // Never 200 an event that was not applied; release the claim so the
      // retry is not mistaken for a duplicate.
      console.error('[kits] webhook handling failed:', event.type, err.message);
      await db().remove(EVENTS, event.id).catch(() => {});
      return { status: 500, body: { error: 'Could not apply that event.' } };
    }
  }

  /** Find the licence a key names, for a kit. The lookup is by the key's
   *  SHA-256, so no comparison ever runs over the key itself; the kit is
   *  compared in constant time, and every miss looks the same. */
  async function lookup(key, kit) {
    const shaped = typeof key === 'string' && KEY_SHAPE.test(key);
    const keyHash = hashKey(shaped ? key : 'lk_not-a-key');
    const license = await db().get(LICENSES, keyHash);
    const a = crypto.createHash('sha256').update(String((license && license.kit) || '')).digest();
    const b = crypto.createHash('sha256').update(String(kit || '')).digest();
    const sameKit = crypto.timingSafeEqual(a, b);
    if (!shaped || !license || !sameKit || !isKit(kit)) return null;
    return license;
  }

  /** What the installer asks at setup and on --update. */
  async function check({ key, kit, purpose }) {
    if (purpose !== 'setup' && purpose !== 'update') return { status: 400, body: { ok: false, reason: 'bad-request' } };
    const license = await lookup(key, kit);
    if (!license) return { status: 403, body: { ok: false, reason: 'invalid' } };
    if (license.status !== 'active') return { status: 403, body: { ok: false, reason: 'revoked' } };
    const active = updatesActive(license, now());
    const body = { ok: true, kit: license.kit, tier: license.tier, updatesUntil: license.updatesUntil || null, updatesActive: active };
    // Setup works for as long as the licence stands. Only --update needs
    // updates to be running.
    if (purpose === 'update' && !active) {
      return { status: 403, body: Object.assign(body, { ok: false, reason: 'updates-lapsed', renew: `${siteOrigin()}/kits/${license.kit}#renew` }) };
    }
    return { status: 200, body };
  }

  function mayDownload(license) {
    if (!license || license.status !== 'active') return false;
    if (updatesActive(license, now())) return true;
    return now() - Date.parse(license.createdAt) < REDOWNLOAD_DAYS * 24 * 3600 * 1000;
  }

  /** A fresh, short download link for a key holder. */
  async function freshLink({ key, kit }) {
    const license = await lookup(key, kit);
    if (!license) return { status: 403, body: { ok: false, reason: 'invalid' } };
    if (license.status !== 'active') return { status: 403, body: { ok: false, reason: 'revoked' } };
    if (!mayDownload(license)) return { status: 403, body: { ok: false, reason: 'updates-lapsed', renew: `${siteOrigin()}/kits/${license.kit}#renew` } };
    if (!storage.enabled()) return { status: 503, body: { ok: false, reason: 'downloads-unavailable' } };
    const token = makeDownloadToken(license.id, FRESH_LINK_MINUTES * 60, now());
    return { status: 200, body: { ok: true, url: downloadUrl(token), expiresAt: new Date(now() + FRESH_LINK_MINUTES * 60000).toISOString() } };
  }

  /** Turn a link's token into the object to stream, or a reason not to.
   *  The licence is read again here: a refunded key's link stops at once. */
  async function redeem(token) {
    const t = readDownloadToken(token, now());
    if (!t) return { ok: false, status: 410, reason: 'expired' };
    const license = await byId(t.id);
    if (!license || license.status !== 'active' || !TIERS[license.tier]) return { ok: false, status: 410, reason: 'expired' };
    if (!storage.enabled()) return { ok: false, status: 503, reason: 'downloads-unavailable' };
    const artifact = TIERS[license.tier].artifact;
    return { ok: true, object: `${license.kit}/${artifact}.zip`, filename: `${license.kit}-${artifact}.zip` };
  }

  return { applyEvent, handleWebhook, check, freshLink, redeem, deliver, byId };
}

/* ------------------------------------------------------------------ *
 * Counting guesses. In memory, per instance, like every other limiter here.
 * ------------------------------------------------------------------ */

function limiter(max, windowMs) {
  const hits = new Map();
  return {
    /** Count one and say whether it is still within the limit. */
    take(id, at = Date.now()) {
      const list = (hits.get(id) || []).filter((t) => at - t < windowMs);
      list.push(at);
      hits.set(id, list);
      if (hits.size > 5000) hits.clear();
      return list.length <= max;
    },
    over(id, at = Date.now()) {
      return (hits.get(id) || []).filter((t) => at - t < windowMs).length >= max;
    },
    reset() { hits.clear(); },
  };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

const QUARTER = 15 * 60 * 1000;
// Every licence question from one address, and the wrong answers among them.
const asks = limiter(60, QUARTER);
const misses = limiter(10, QUARTER);

/** Mount the webhook. This MUST run before express.json(): the signature is
 *  over the raw bytes, and a parsed-and-rewritten body never matches. */
function mountWebhook(app, express, service) {
  app.post('/api/kits/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    const out = await service.handleWebhook(req.body, req.get('Stripe-Signature'));
    res.status(out.status).json(out.body);
  });
}

function mountRoutes(app, service, pages) {
  const hidden = (res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', pages.CSP);
  };

  // Shared by the three key-taking routes. A limited caller is told so
  // before anything is looked up.
  const guarded = (handler) => async (req, res) => {
    hidden(res);
    const ip = req.ip || 'unknown';
    if (!asks.take(ip) || misses.over(ip)) {
      res.set('Retry-After', '900');
      return res.status(429).json({ ok: false, reason: 'rate-limited' });
    }
    if (!enabled()) return res.status(503).json({ ok: false, reason: 'unavailable' });
    try {
      const out = await handler(req.body && typeof req.body === 'object' ? req.body : {});
      if (out.status === 403 && out.body.reason === 'invalid') misses.take(ip);
      return res.status(out.status).json(out.body);
    } catch (err) {
      console.error('[kits]', req.path, err && err.message);
      return res.status(500).json({ ok: false, reason: 'error' });
    }
  };

  app.post('/api/kits/license/check', guarded((b) => service.check({ key: b.key, kit: b.kit, purpose: b.purpose })));
  app.post('/api/kits/license/download', guarded((b) => service.freshLink({ key: b.key, kit: b.kit })));

  // The same thing for a person: paste the key, get the archive. A plain
  // form post, no script.
  app.post('/kits/download', async (req, res) => {
    hidden(res);
    const ip = req.ip || 'unknown';
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    let out = { status: 429, body: { reason: 'rate-limited' } };
    if (asks.take(ip) && !misses.over(ip)) {
      if (!enabled()) out = { status: 503, body: { reason: 'downloads-unavailable' } };
      else {
        try { out = await service.freshLink({ key: String(b.key || '').trim().toLowerCase(), kit: b.kit }); }
        catch (err) { console.error('[kits] download form', err && err.message); out = { status: 500, body: { reason: 'error' } }; }
        if (out.status === 403 && out.body.reason === 'invalid') misses.take(ip);
      }
    }
    if (out.status === 200) return res.redirect(303, new URL(out.body.url).pathname + new URL(out.body.url).search);
    return res.status(out.status).type('html').send(pages.downloadPage({ problem: out.body.reason }));
  });

  app.get('/kits/download', async (req, res) => {
    hidden(res);
    if (typeof req.query.t !== 'string') return res.type('html').send(pages.downloadPage({}));
    let ticket;
    try { ticket = await service.redeem(req.query.t); }
    catch (err) { console.error('[kits] redeem', err && err.message); ticket = { ok: false, status: 500, reason: 'error' }; }
    if (!ticket.ok) return res.status(ticket.status).type('html').send(pages.downloadPage({ problem: ticket.reason }));
    let file;
    try { file = await storage.open(ticket.object, { signal: AbortSignal.timeout(20000) }); }
    catch (err) { console.error('[kits] storage', err && err.message); file = { ok: false }; }
    if (!file.ok) return res.status(503).type('html').send(pages.downloadPage({ problem: 'downloads-unavailable' }));
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${ticket.filename}"`);
    if (file.length) res.set('Content-Length', String(file.length));
    const stream = Readable.fromWeb(file.body);
    stream.on('error', (err) => { console.error('[kits] stream', err && err.message); res.destroy(); });
    stream.pipe(res);
  });

  const page = (render) => (req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'no-store');
    res.set('Content-Security-Policy', pages.CSP);
    res.type('html').send(render());
  };
  app.get('/kits', page(() => pages.indexPage()));
  app.get('/kits/thanks', page(() => pages.thanksPage()));
  for (const slug of KIT_SLUGS) app.get(`/kits/${slug}`, page(() => pages.kitPage(slug)));
}

module.exports = {
  make, mountWebhook, mountRoutes, enabled, limiter,
  keyFor, hashKey, publicId, makeDownloadToken, readDownloadToken, deliveryMail, addMonths, updatesActive,
  CONFIG, BRAND, SELLER, TIERS, RENEWAL, KIT_SLUGS, REFUND_DAYS, UPDATES_MONTHS, kitName, isKit,
  LICENSES, EVENTS, EMAIL_LINK_HOURS, FRESH_LINK_MINUTES, REDOWNLOAD_DAYS,
  _limits: { asks, misses },
};
