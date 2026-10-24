// Best Buy: the official Products API (api.bestbuy.com), with a free key
// from developer.bestbuy.com in BESTBUY_API_KEY. Unset, the card says "Not
// connected yet" and links to bestbuy.com's search; no request is made.
//
// Two calls, both through upstream.js's cache, sharing and cap:
//   1. the iPhone Duo search, one shared answer for everyone (key "search"):
//      GET /v1/products(manufacturer=apple&search=iphone&search=duo)
//      -> {products: [{sku, name, salePrice, onlineAvailability,
//          onlineAvailabilityText, inStoreAvailability, url, color}]}
//      Best Buy names carry the details: "Apple - iPhone Duo 256GB - Star
//      White (Verizon)". The storage, colour and carrier are read from it.
//   2. stores near the ZIP for the matching SKU (key "<sku>|<zip>"):
//      GET /v1/products/<sku>/stores.json?postalCode=<zip>
//      -> {ispuEligible, stores: [{storeID, name, city, state, distance, lowStock}]}
//      Listed stores are the ones with it for pickup. If this endpoint is
//      refused for the key, the card shows online availability and the link.
//
// The key is never logged and never leaves the server: errors carry a
// reason word only, and every link drawn is a bestbuy.com one.

const Core = require('../public/duohunt-core');
const { getJson, UpstreamError } = require('./upstream');

const API = 'https://api.bestbuy.com/v1';
const SHOW = 'sku,name,salePrice,regularPrice,onlineAvailability,onlineAvailabilityText,inStoreAvailability,url,color';
const MAX_STORES = 10;

const keyNow = () => String(process.env.BESTBUY_API_KEY || '').trim();
const validKey = (k) => /^[A-Za-z0-9]{8,64}$/.test(k);

function searchUrl(key) {
  return `${API}/products(manufacturer=apple&search=iphone&search=duo)?${new URLSearchParams({ apiKey: key, format: 'json', show: SHOW, pageSize: '50' })}`;
}
function storesUrl(sku, zip, key) {
  return `${API}/products/${sku}/stores.json?${new URLSearchParams({ postalCode: zip, apiKey: key })}`;
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/** Read storage, colour and carrier out of a Best Buy product name. */
function describe(name) {
  const n = String(name || '').toLowerCase();
  if (!/iphone\s*duo/.test(n)) return null;
  const storage = /\b2\s?tb\b/.test(n) ? '2tb' : /\b1\s?tb\b/.test(n) ? '1tb' : /\b512\s?gb\b/.test(n) ? '512gb' : /\b256\s?gb\b/.test(n) ? '256gb' : null;
  const colour = /star\s*white/.test(n) ? 'star-white' : /night\s*sky/.test(n) ? 'night-sky' : null;
  const carrier = /verizon/.test(n) ? 'verizon' : /at\s?&\s?t|\bat&amp;t\b/.test(n) ? 'att' : /t-?\s?mobile/.test(n) ? 'tmobile' : /unlocked/.test(n) ? 'unlocked' : null;
  return { storage, colour, carrier };
}

/** One product -> a clean row, or null. */
function productRow(p) {
  p = obj(p);
  if (!p) return null;
  const sku = typeof p.sku === 'number' || typeof p.sku === 'string' ? String(p.sku) : '';
  if (!/^\d{5,9}$/.test(sku)) return null;
  const name = Core.clean(p.name, 120);
  const d = describe(name);
  if (!d) return null;
  const price = typeof p.salePrice === 'number' && p.salePrice > 0 && p.salePrice < 100000 ? Math.round(p.salePrice * 100) / 100 : null;
  return {
    sku,
    name,
    ...d,
    price,
    online: p.onlineAvailability === true,
    onlineText: Core.clean(p.onlineAvailabilityText, 80),
    inStore: p.inStoreAvailability === true,
    url: Core.safeUrl(p.url, ['bestbuy.com']) || Core.BESTBUY_SEARCH,
  };
}

function parseSearch(json) {
  const root = obj(json);
  if (!root || !Array.isArray(root.products)) throw new UpstreamError('parse');
  return root.products.slice(0, 100).map(productRow).filter(Boolean);
}

function parseStores(json) {
  const root = obj(json);
  if (!root || !Array.isArray(root.stores)) throw new UpstreamError('parse');
  const out = [];
  for (const s of root.stores.slice(0, 40)) {
    const o = obj(s);
    if (!o) continue;
    const name = Core.clean(o.name || o.longName, 60);
    if (!name) continue;
    const dist = typeof o.distance === 'number' ? o.distance : Number(o.distance);
    out.push({
      name,
      city: Core.clean(o.city, 40),
      state: Core.clean(o.state || o.region, 4),
      distance: Number.isFinite(dist) && dist >= 0 && dist < 10000 ? `${Math.round(dist * 10) / 10} mi` : '',
      lowStock: o.lowStock === true,
    });
    if (out.length >= MAX_STORES) break;
  }
  return out;
}

/** The product that matches the pick, best first. */
function match(products, pick) {
  const same = products.filter((p) => p.storage === pick.storage && p.colour === pick.colour);
  return same.find((p) => p.carrier === pick.carrier)
    || (pick.carrier === 'unlocked' ? same.find((p) => p.carrier === null) : null)
    || null;
}

const FAIL = 'Couldn’t check Best Buy right now - open Best Buy’s page.';
const BUSY = 'Lots of people are checking Best Buy right now - try again in a few minutes, or open Best Buy’s page.';

/** Never throws: every outcome is a card. */
async function check({ pick, zip, search, stores, fetchImpl, timeoutMs }) {
  const key = keyNow();
  if (!validKey(key)) {
    return { state: 'not-connected', message: 'Not connected yet - open Best Buy to check.', link: Core.BESTBUY_SEARCH };
  }
  let found;
  try {
    found = await search.get('search', async () => parseSearch(await getJson(searchUrl(key), { fetchImpl, timeoutMs })));
  } catch (err) {
    const busy = err && err.reason === 'busy';
    return { state: busy ? 'busy' : 'error', message: busy ? BUSY : FAIL, link: Core.BESTBUY_SEARCH };
  }
  const product = match(found.value, pick);
  if (!product) {
    const others = found.value.filter((p) => p.storage === pick.storage && p.colour === pick.colour).map((p) => p.carrier).filter(Boolean);
    return {
      state: 'not-listed',
      message: others.length
        ? `Best Buy lists this one for ${[...new Set(others)].map((c) => Core.find(Core.CARRIERS, c).label).join(' and ')} - not ${Core.find(Core.CARRIERS, pick.carrier).label}.`
        : 'Best Buy doesn’t list this model right now.',
      checkedAt: found.at,
      link: Core.BESTBUY_SEARCH,
    };
  }
  let storeList = null;
  let storesNote = '';
  try {
    const r = await stores.get(`${product.sku}|${zip}`, async () => parseStores(await getJson(storesUrl(product.sku, zip, key), { fetchImpl, timeoutMs })));
    storeList = r.value;
  } catch (err) {
    storesNote = 'Store stock isn’t available right now - open Best Buy’s page to pick a store.';
  }
  return {
    state: 'ok',
    product,
    stores: storeList,
    storesNote,
    checkedAt: found.at,
    cached: found.cached,
    link: product.url,
  };
}

module.exports = { searchUrl, storesUrl, describe, productRow, parseSearch, parseStores, match, check, FAIL, BUSY, validKey };
