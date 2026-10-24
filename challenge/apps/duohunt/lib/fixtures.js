// Hand-written answers in the shapes Apple and Best Buy send, for tests and
// for DUOHUNT_FAKE_UPSTREAM=1 (local runs and screenshots). Store names are
// real Apple Store and Best Buy locations near San Francisco, but every
// availability, quote and price here is made up.
//
// DUOHUNT_FAKE_UPSTREAM=1 is refused on Cloud Run (server.js), so a dev
// setting can never ship.

function appleStore({ name, number, city, state, dist, display, quote, part }) {
  return {
    storeName: name,
    storeNumber: number,
    city,
    state,
    storeDistanceWithUnit: dist,
    storedistance: parseFloat(dist),
    retailStore: { storeName: name, address: { city, stateCode: state } },
    partsAvailability: {
      [part]: {
        pickupDisplay: display,
        pickupSearchQuote: quote,
        pickupType: 'In-Store Pickup',
        messageTypes: { regular: { storePickupQuote: `${quote} at Apple ${name}`, storeSelectionEnabled: true, storePickupProductTitle: 'iPhone Duo' } },
      },
    },
  };
}

/** Two stores with it today, one with a later date, one without. */
function appleAvailable(part) {
  return {
    head: { status: '200', data: {} },
    body: {
      content: {
        pickupMessage: {
          location: 'San Francisco, CA',
          stores: [
            appleStore({ part, name: 'Union Square', number: 'R075', city: 'San Francisco', state: 'CA', dist: '1.2 mi', display: 'available', quote: 'Available Today' }),
            appleStore({ part, name: 'Stonestown', number: 'R014', city: 'San Francisco', state: 'CA', dist: '5.8 mi', display: 'unavailable', quote: 'Unavailable for Pickup' }),
            appleStore({ part, name: 'Burlingame', number: 'R303', city: 'Burlingame', state: 'CA', dist: '14.9 mi', display: 'available', quote: 'Available Today' }),
            appleStore({ part, name: 'Bay Street', number: 'R104', city: 'Emeryville', state: 'CA', dist: '9.6 mi', display: 'unavailable', quote: 'Available Tue, Nov 4' }),
          ],
        },
        deliveryMessage: { [part]: { regular: { deliveryOptionMessages: [{ displayName: 'Delivers Jan 12 - Jan 19' }] } } },
      },
    },
  };
}

function appleNone(part) {
  const a = appleAvailable(part);
  for (const s of a.body.content.pickupMessage.stores) {
    s.partsAvailability[part].pickupDisplay = 'unavailable';
    s.partsAvailability[part].pickupSearchQuote = 'Unavailable for Pickup';
  }
  return a;
}

function appleQuoteOnly(part) {
  const a = appleNone(part);
  a.body.content.pickupMessage.stores[0].partsAvailability[part].pickupSearchQuote = 'Available Mon, Nov 10';
  return a;
}

const HOSTILE = '<img src=x onerror=alert(1)>Union‮ Square<script>alert(2)</script>';
function appleHostile(part) {
  const a = appleAvailable(part);
  const s = a.body.content.pickupMessage.stores[0];
  s.storeName = HOSTILE;
  s.storeNumber = '"><svg onload=alert(1)>';
  s.storeDistanceWithUnit = '<b>1.2 mi</b>javascript:alert(1)';
  s.city = 'x'.repeat(5000);
  s.partsAvailability[part].pickupSearchQuote = 'Available Today <a href="javascript:alert(1)">tap</a>';
  a.body.content.pickupMessage.stores.push(null, 42, 'store', { storeName: '' }, { storeName: ['array'] });
  return a;
}

function bbProduct(sku, name, { price, online, text, inStore }) {
  return {
    sku,
    name,
    salePrice: price,
    regularPrice: price,
    onlineAvailability: online,
    onlineAvailabilityText: text,
    inStoreAvailability: inStore,
    url: `https://api.bestbuy.com/click/-/${sku}/pdp`,
    color: name.includes('Star White') ? 'Star White' : 'Night Sky',
  };
}

function bestbuySearch() {
  return {
    from: 1, to: 8, currentPage: 1, total: 8, totalPages: 1, queryTime: '0.004', totalTime: '0.021', partial: false,
    canonicalUrl: '/v1/products(manufacturer="apple"&search="iphone"&search="duo")?show=...&format=json&apiKey=REDACTED',
    products: [
      bbProduct(6612001, 'Apple - iPhone Duo 256GB - Star White (Verizon)', { price: 1999.99, online: true, text: 'Shipping: Get it by Nov 10', inStore: true }),
      bbProduct(6612002, 'Apple - iPhone Duo 256GB - Night Sky (Verizon)', { price: 1999.99, online: false, text: 'Sold Out Online', inStore: false }),
      bbProduct(6612003, 'Apple - iPhone Duo 256GB - Star White (AT&T)', { price: 1999.99, online: false, text: 'Sold Out Online', inStore: true }),
      bbProduct(6612004, 'Apple - iPhone Duo 256GB - Night Sky (AT&T)', { price: 1999.99, online: false, text: 'Sold Out Online', inStore: false }),
      bbProduct(6612005, 'Apple - iPhone Duo 512GB - Star White (Verizon)', { price: 2199.99, online: false, text: 'Sold Out Online', inStore: false }),
      bbProduct(6612006, 'Apple - iPhone Duo 1TB - Night Sky (AT&T)', { price: 2599.99, online: true, text: 'Shipping: Get it by Dec 14', inStore: false }),
      bbProduct(6612007, 'Apple - iPhone Duo 2TB - Star White (Verizon)', { price: 3199.99, online: false, text: 'Sold Out Online', inStore: false }),
      bbProduct(6612099, 'Apple - Clear Case with MagSafe for iPhone Duo - Clear', { price: 59.99, online: true, text: '', inStore: true }),
    ],
  };
}

function bestbuyStores(sku) {
  if (String(sku) === '6612003') {
    return { ispuEligible: true, stores: [
      { storeID: '1431', name: 'San Francisco', longName: 'San Francisco', city: 'San Francisco', region: 'CA', state: 'CA', postalCode: '94103', distance: 0.8, lowStock: true, storeType: 'Big Box' },
      { storeID: '1442', name: 'Colma', city: 'Colma', state: 'CA', distance: 7.4, lowStock: false },
    ] };
  }
  if (String(sku) === '6612001') {
    return { ispuEligible: true, stores: [{ storeID: '1442', name: 'Colma', city: 'Colma', state: 'CA', distance: 7.4, lowStock: true }] };
  }
  return { ispuEligible: true, stores: [] };
}

function respond(status, json) {
  const text = typeof json === 'string' ? json : JSON.stringify(json);
  return { ok: status >= 200 && status < 300, status, async text() { return text; }, async json() { return JSON.parse(text); } };
}

/** A fetch that answers apple.com and api.bestbuy.com from the fixtures
 *  above (scenario: available | none | quote | hostile | malformed | down). */
function createFakeFetch({ apple = 'available', bestbuy = 'ok', delayMs = 0 } = {}) {
  const calls = [];
  async function fakeFetch(url, opts = {}) {
    calls.push({ url: String(url), headers: opts.headers || {} });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const u = new URL(String(url));
    if (u.host === 'www.apple.com' && u.pathname === '/shop/fulfillment-messages') {
      const part = u.searchParams.get('parts.0');
      if (apple === 'down') return respond(503, '<html>busy</html>');
      if (apple === 'malformed') return respond(200, '{"head":{"status":"200"},"body":{"content":{"pickupMessage":"nope"}}}');
      if (apple === 'notjson') return respond(200, '<!doctype html><title>Access Denied</title>');
      const fn = { available: appleAvailable, none: appleNone, quote: appleQuoteOnly, hostile: appleHostile }[apple] || appleAvailable;
      return respond(200, fn(part));
    }
    if (u.host === 'api.bestbuy.com') {
      if (bestbuy === 'down') return respond(500, '{"error":{"code":500}}');
      const m = /^\/v1\/products\/(\d+)\/stores\.json$/.exec(u.pathname);
      if (m) {
        if (bestbuy === 'nostores') return respond(403, '{"errorCode":"403","errorMessage":"Not authorized for stores"}');
        return respond(200, bestbuyStores(m[1]));
      }
      if (u.pathname.startsWith('/v1/products(')) return respond(200, bestbuySearch());
      return respond(404, '{}');
    }
    throw new Error(`fake upstream: no fixture for ${u.host}`);
  }
  fakeFetch.calls = calls;
  return fakeFetch;
}

module.exports = { appleAvailable, appleNone, appleQuoteOnly, appleHostile, bestbuySearch, bestbuyStores, createFakeFetch, respond, HOSTILE };
