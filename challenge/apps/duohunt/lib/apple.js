// Apple Store pickup: the public JSON apple.com's own product page calls
// when you tap "Check availability" (`/shop/fulfillment-messages`), asked by
// part number and ZIP. Only on a person's tap, server-side, through
// upstream.js's cache, in-flight sharing, cap and timeout.
//
// OFF unless `enabled` (server.js: DUOHUNT_APPLE_SERVER_CHECK=1). Apple
// answered every request from Google's network with HTTP 541 - its bot
// block, a ~128 KB HTML page - on 2026-10-24, browser headers, buy-page
// cookies and all (CLAUDE.md, "Apple blocks servers (541)"). Asking anyway
// would spend a fetch per tap to learn nothing, so off, check() answers
// `blocked` at once, with Apple's page for the exact model, and asks nobody.
// The code below is kept, and tested, for the day Apple stops blocking.
//
// The parser trusts nothing: it picks fields by name, keeps only the ones it
// knows, strips and bounds every string, and treats a shape it does not
// recognise as a failure ("Couldn't check Apple right now") rather than
// guessing. The fields it reads, as apple.com sends them:
//
//   body.content.pickupMessage.stores[] = {
//     storeName, storeNumber ("R075"), city, state,
//     storeDistanceWithUnit ("2.4 mi") | storedistance (number, miles),
//     partsAvailability: { "<PART>": {
//       pickupDisplay: "available" | "unavailable" | "ineligible",
//       pickupSearchQuote: "Available Today" | "Unavailable for Pickup" | "Available Tue, Nov 4",
//       messageTypes: { regular: { storePickupQuote } } } } }

const Core = require('../public/duohunt-core');
const { getJson, UpstreamError } = require('./upstream');

const ENDPOINT = Core.APPLE_FULFILLMENT;
const MAX_STORES = 12;

/** The same URL the iPhone Shortcut recipe hands out (Core.fulfillmentUrl);
 *  null for anything but an Apple part and a five-digit ZIP. */
function requestUrl(part, zip) {
  return Core.fulfillmentUrl(part, zip);
}

function productUrl(part) {
  // A fake part (Z...) has no page on apple.com: link the buy page.
  return part && !part.startsWith('Z') ? Core.appleProductUrl(part) : Core.APPLE_BUY;
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/** One store's row, or null if it is not a store we can describe. */
function storeRow(s, part) {
  s = obj(s);
  if (!s) return null;
  const name = Core.clean(s.storeName || s.storeDisplayName, 60);
  if (!name) return null;
  const number = typeof s.storeNumber === 'string' && /^R\d{3,4}$/.test(s.storeNumber) ? s.storeNumber : null;
  let distance = Core.clean(s.storeDistanceWithUnit, 16);
  if (!/^\d{1,4}(\.\d{1,2})? ?(mi|km)$/i.test(distance)) {
    const n = typeof s.storedistance === 'number' ? s.storedistance : Number(s.storedistance);
    distance = Number.isFinite(n) && n >= 0 && n < 10000 ? `${Math.round(n * 10) / 10} mi` : '';
  }
  const pa = obj(s.partsAvailability);
  const p = pa ? obj(pa[part]) : null;
  const display = p && typeof p.pickupDisplay === 'string' ? p.pickupDisplay.toLowerCase() : '';
  const regular = p && obj(p.messageTypes) && obj(p.messageTypes.regular);
  const quote = Core.clean((p && p.pickupSearchQuote) || (regular && regular.storePickupQuote) || '', 80);
  let status = 'unavailable';
  let label = 'Unavailable';
  if (display === 'available') {
    if (/today/i.test(quote) || !quote) { status = 'available'; label = 'Available today'; } else { status = 'quote'; label = quote; }
  } else if (quote && /^available\b/i.test(quote) && !/today/i.test(quote)) {
    status = 'quote'; label = quote;
  }
  return {
    name,
    store: number,
    city: Core.clean(s.city, 40),
    state: Core.clean(s.state, 4),
    distance,
    status,
    label,
  };
}

/** The whole answer -> {stores, available}. Throws on an unknown shape. */
function parse(json, part) {
  const root = obj(json);
  const body = root && obj(root.body);
  const content = body && obj(body.content);
  const pm = content && obj(content.pickupMessage);
  if (!pm || !Array.isArray(pm.stores)) throw new UpstreamError('parse');
  const stores = [];
  for (const s of pm.stores.slice(0, 40)) {
    const row = storeRow(s, part);
    if (row) stores.push(row);
    if (stores.length >= MAX_STORES) break;
  }
  return { stores, available: stores.filter((s) => s.status === 'available').length };
}

const FAIL = 'Couldn’t check Apple right now - open Apple’s page.';
const BUSY = 'Lots of people are checking Apple right now - try again in a few minutes, or open Apple’s page.';

const BLOCKED = Core.APPLE_BLOCKED;

/**
 * Check a pick near a ZIP. Never throws: every outcome is a card.
 * `source` is upstream.createSource(); `part` comes from parts.partFor and is
 * the one the answer names and links; `ask` is the part put to Apple (a fake
 * one under DUOHUNT_FAKE_UPSTREAM), `part` by default. `enabled` false - the
 * default - is `blocked`, with no request of any kind.
 */
async function check({ part, ask = part, zip, source, fetchImpl, timeoutMs, enabled = false }) {
  const link = productUrl(part);
  if (!part) {
    return { state: 'not-configured', message: 'Apple’s live check isn’t set up for this model yet - open Apple’s page to check pickup.', link: Core.APPLE_BUY };
  }
  if (!enabled) return { state: 'blocked', part, message: BLOCKED, link };
  try {
    const r = await source.get(`${ask}|${zip}`, async () => parse(await getJson(requestUrl(ask, zip), { fetchImpl, timeoutMs, headers: { Referer: Core.APPLE_BUY } }), ask));
    return { state: 'ok', part, stores: r.value.stores, available: r.value.available, checkedAt: r.at, cached: r.cached, link };
  } catch (err) {
    const busy = err && err.reason === 'busy';
    return { state: busy ? 'busy' : 'error', part, message: busy ? BUSY : FAIL, link };
  }
}

module.exports = { requestUrl, productUrl, parse, storeRow, check, FAIL, BUSY, BLOCKED, ENDPOINT };
