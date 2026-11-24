#!/usr/bin/env node
/**
 * Lab Kits: create the Stripe products, prices and Payment Links.
 *
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/kits-stripe.js --dry-run
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/kits-stripe.js
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/kits-stripe.js --live --confirm-live=create-real-stripe-objects
 *
 * Erik runs this; nothing else does. It is safe to run again: a product is
 * found by its fixed id, a price by its lookup key, a link by its metadata,
 * and what already matches config/kits.json is left alone. Change a price in
 * the config and run it again: a new price takes the lookup key, a new link
 * is made for it, and the old link is switched off.
 *
 * TEST MODE BY DEFAULT. A live key is refused unless BOTH --live and
 * --confirm-live=create-real-stripe-objects are given. A key that is neither
 * a test nor a live key is refused.
 *
 * It refuses to invent anything: a tier whose price in config/kits.json is
 * null is skipped (and the run ends non-zero, saying which), and with
 * taxCode null nothing is created at all - Stripe Tax needs a product tax
 * code, and which one is Erik's decision.
 *
 * Every link carries metadata { kind: 'kit', kit, tier }, which is all the
 * licence service (lib/kits.js) reads. NEVER add metadata.uid or a
 * client_reference_id to a kit link: DataViz's webhook receives these events
 * too and reads either as an account id.
 *
 * It prints the KIT_LINK_* settings for the landing-page service at the end.
 */
const path = require('path');
const stripe = require('../shared/stripe');

const LIVE_PHRASE = 'create-real-stripe-objects';
const SITE = 'https://strongtechnicalconsulting.com';

const TIER_COPY = {
  scripts: { name: 'Scripts only', description: 'The raw scripts and a README. One-time purchase.' },
  kit: { name: 'Self-setup kit', description: 'Guided setup.sh, --doctor, demo video, help bot and 12 months of updates. One-time purchase.' },
  dfy: { name: 'Done-for-you', description: 'Set up for you, on your own accounts. One-time purchase.' },
  renewal: { name: 'Updates renewal', description: 'Another 12 months of updates for a kit you own. Yearly; cancel any time.' },
};

function keyMode(key) {
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  return null;
}

const ident = (kit, tier) => `labkit_${kit}_${tier}`.replace(/-/g, '_');
const envName = (kit, tier) => `KIT_LINK_${kit}_${tier}`.replace(/-/g, '_').toUpperCase();

/** What would be made, from the config alone. No network. */
function plan(config) {
  const items = []; const skipped = [];
  for (const [kit, k] of Object.entries(config.kits || {})) {
    for (const [tier, t] of Object.entries(k.tiers || {})) {
      if (!TIER_COPY[tier]) { skipped.push({ kit, tier, why: 'not a tier this script sells' }); continue; }
      if (t.enabled === false) { skipped.push({ kit, tier, why: 'switched off in the config ("enabled": false)' }); continue; }
      if (!Number.isInteger(t.price) || t.price <= 0) { skipped.push({ kit, tier, why: 'its price is null', blocking: true }); continue; }
      items.push({
        kit, tier, cents: t.price, recurring: tier === 'renewal',
        id: ident(kit, tier), env: envName(kit, tier),
        name: `${k.name}: ${TIER_COPY[tier].name}`,
        description: TIER_COPY[tier].description,
      });
    }
  }
  return { items, skipped };
}

async function findProduct(id) {
  try { return await stripe.call(`/products/${encodeURIComponent(id)}`, null, 'GET'); }
  catch (err) {
    if (err.stripe && err.stripe.code === 'resource_missing') return null;
    throw err;
  }
}

async function allLinks() {
  const out = []; let after = '';
  for (let page = 0; page < 50; page++) {
    const res = await stripe.call(`/payment_links?limit=100&active=true${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`, null, 'GET');
    const rows = res.data || [];
    out.push(...rows);
    if (!res.has_more || !rows.length) break;
    after = rows[rows.length - 1].id;
  }
  return out;
}

async function ensure(item, config, links, log) {
  const meta = { kind: 'kit', kit: item.kit, tier: item.tier };

  let product = await findProduct(item.id);
  if (!product) {
    product = await stripe.call('/products', { id: item.id, name: `${config.brand} - ${item.name}`, description: item.description, tax_code: config.taxCode, metadata: meta });
    log(`  created product ${product.id}`);
  } else log(`  product ${product.id} exists`);

  const found = await stripe.call(`/prices?active=true&limit=1&lookup_keys[0]=${encodeURIComponent(item.id)}`, null, 'GET');
  let price = (found.data || [])[0] || null;
  const same = price && price.unit_amount === item.cents && price.currency === config.currency
    && price.product === product.id && Boolean(price.recurring) === item.recurring
    && (!item.recurring || price.recurring.interval === 'year');
  if (!same) {
    const body = {
      product: product.id, currency: config.currency, unit_amount: item.cents,
      lookup_key: item.id, transfer_lookup_key: true, tax_behavior: config.taxBehavior || 'exclusive', metadata: meta,
    };
    if (item.recurring) body.recurring = { interval: 'year' };
    price = await stripe.call('/prices', body);
    log(`  created price ${price.id} (${item.cents} ${config.currency}${item.recurring ? ' a year' : ''})`);
  } else log(`  price ${price.id} exists`);

  const mine = links.filter((l) => l.metadata && l.metadata.kind === 'kit' && l.metadata.kit === item.kit && l.metadata.tier === item.tier);
  let link = mine.find((l) => l.metadata.price === price.id) || null;
  if (!link) {
    const body = {
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: Object.assign({ price: price.id }, meta),
      automatic_tax: { enabled: true },
      after_completion: { type: 'redirect', redirect: { url: `${SITE}/kits/thanks` } },
    };
    if (item.recurring) body.subscription_data = { metadata: meta };
    else { body.payment_intent_data = { metadata: meta }; body.customer_creation = 'always'; }
    link = await stripe.call('/payment_links', body);
    log(`  created link ${link.id}`);
  } else log(`  link ${link.id} exists`);
  for (const old of mine) {
    if (old.id === link.id) continue;
    await stripe.call(`/payment_links/${encodeURIComponent(old.id)}`, { active: false });
    log(`  switched off the superseded link ${old.id}`);
  }
  return { env: item.env, url: link.url };
}

async function run({ argv = [], env = process.env, log = console.log, config } = {}) {
  config = config || require(path.join(__dirname, '..', 'config', 'kits.json'));
  const flags = new Set(argv.filter((a) => !a.includes('=')));
  const confirm = (argv.find((a) => a.startsWith('--confirm-live=')) || '').split('=')[1] || '';
  const { items, skipped } = plan(config);

  for (const s of skipped) log(`skip  ${s.kit} / ${s.tier}: ${s.why}`);
  if (flags.has('--dry-run')) {
    for (const i of items) log(`would ensure  ${i.name}  ${i.cents} ${config.currency}${i.recurring ? ' a year' : ''}  -> ${i.env}`);
    log(`Dry run: nothing was sent to Stripe. ${items.length} to make, ${skipped.length} skipped.`);
    return { code: 0, items, skipped, links: [] };
  }

  const key = String(env.STRIPE_SECRET_KEY || '');
  const mode = keyMode(key);
  if (!mode) { log('Refused: STRIPE_SECRET_KEY is not a Stripe test or live key (sk_test_, rk_test_, sk_live_, rk_live_).'); return { code: 2 }; }
  if (mode === 'live' && !(flags.has('--live') && confirm === LIVE_PHRASE)) {
    log(`Refused: that is a LIVE key. Test mode is the default. To create real objects pass --live --confirm-live=${LIVE_PHRASE}`);
    return { code: 2 };
  }
  if (mode === 'test' && flags.has('--live')) { log('Refused: --live was given with a test key.'); return { code: 2 }; }
  if (!config.taxCode || !/^txcd_\d{8}$/.test(String(config.taxCode))) {
    log('Refused: config/kits.json has no taxCode. Stripe Tax needs a product tax code (txcd_...), and it is not guessed here.');
    return { code: 2 };
  }
  if (!items.length) { log('Nothing to create: every price in config/kits.json is null.'); return { code: 3, items, skipped, links: [] }; }

  log(`Stripe ${mode.toUpperCase()} mode.`);
  const links = await allLinks();
  const out = [];
  for (const item of items) {
    log(`${item.name}`);
    out.push(await ensure(item, config, links, log));
  }
  log('\nSet these on the landing-page service (a button appears only for a link that is set):');
  for (const o of out) log(`${o.env}=${o.url}`);
  const blocking = skipped.filter((s) => s.blocking);
  if (blocking.length) log(`\n${blocking.length} tier(s) were skipped because their price is null.`);
  return { code: blocking.length ? 3 : 0, items, skipped, links: out };
}

if (require.main === module) {
  run({ argv: process.argv.slice(2) }).then((r) => process.exit(r.code), (err) => { console.error('Failed:', err.message); process.exit(1); });
}

module.exports = { run, plan, keyMode, ident, envName, LIVE_PHRASE };
