// scripts/kits-stripe.js: creating the Lab Kits' Stripe products, prices and
// Payment Links. Stripe here is a stand-in at global.fetch that remembers
// what it was sent; nothing reaches the network, and a request to anywhere
// else fails the suite.
//
// - Test mode by default: a live key is refused without both flags.
// - Nothing is invented: a null price is skipped, and no tax code means
//   nothing is created at all. The shipped config creates nothing.
// - Running it again creates nothing; changing a price replaces the price
//   and the link and switches the old link off.
// - Every link carries the metadata the licence service reads, and never a
//   uid or a client_reference_id (DataViz's webhook reads those).
const script = require('../scripts/kits-stripe.js');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };

const calls = [];
const state = { products: new Map(), prices: [], links: [] };
function reset() { calls.length = 0; state.products.clear(); state.prices.length = 0; state.links.length = 0; }
const json = (status, body) => new Response(JSON.stringify(body), { status });
function nest(params) {
  const out = {};
  for (const [k, v] of params) {
    const keys = k.replace(/\]/g, '').split('[');
    let o = out;
    keys.forEach((key, i) => { if (i === keys.length - 1) o[key] = v; else o = o[key] = o[key] || {}; });
  }
  return out;
}
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.origin !== 'https://api.stripe.com') throw new Error('test tried to reach ' + u.origin);
  const method = opts.method || 'GET';
  const body = opts.body ? nest(new URLSearchParams(opts.body)) : null;
  calls.push({ method, path: u.pathname, query: u.search, body, auth: opts.headers.Authorization });
  const p = u.pathname.replace('/v1', '');
  let m;
  if (method === 'GET' && (m = /^\/products\/(.+)$/.exec(p))) {
    return state.products.has(m[1]) ? json(200, state.products.get(m[1])) : json(404, { error: { code: 'resource_missing', message: 'No such product' } });
  }
  if (method === 'POST' && p === '/products') { state.products.set(body.id, body); return json(200, body); }
  if (method === 'GET' && p === '/prices') {
    const key = u.searchParams.get('lookup_keys[0]');
    return json(200, { data: state.prices.filter((x) => x.lookup_key === key && x.active) });
  }
  if (method === 'POST' && p === '/prices') {
    if (body.transfer_lookup_key) state.prices.forEach((x) => { if (x.lookup_key === body.lookup_key) x.lookup_key = null; });
    const price = { id: `price_${state.prices.length + 1}`, active: true, product: body.product, currency: body.currency, unit_amount: Number(body.unit_amount), lookup_key: body.lookup_key, recurring: body.recurring || null, tax_behavior: body.tax_behavior };
    state.prices.push(price); return json(200, price);
  }
  if (method === 'GET' && p === '/payment_links') return json(200, { data: state.links.filter((l) => l.active), has_more: false });
  if (method === 'POST' && p === '/payment_links') {
    const link = Object.assign({ id: `plink_${state.links.length + 1}`, active: true, url: `https://buy.stripe.com/test_${String(state.links.length + 1).padStart(10, 'a')}` }, body);
    state.links.push(link); return json(200, link);
  }
  if (method === 'POST' && (m = /^\/payment_links\/(.+)$/.exec(p))) {
    const link = state.links.find((l) => l.id === m[1]); link.active = body.active !== 'false'; return json(200, link);
  }
  return json(400, { error: { message: 'unexpected ' + method + ' ' + p } });
};

const shipped = require('../config/kits.json');
const priced = (over = {}) => {
  const c = JSON.parse(JSON.stringify(shipped));
  c.taxCode = 'txcd_10000000';
  c.kits['app-stack'].tiers.scripts.price = 4900;
  c.kits['app-stack'].tiers.kit.price = 14900;
  c.kits['app-stack'].tiers.renewal.price = 3900;
  c.kits['chief-of-staff'].tiers.kit.price = 9900;
  return Object.assign(c, over);
};
const quiet = () => {};
const run = async (argv, key, config) => {
  const lines = [];
  process.env.STRIPE_SECRET_KEY = key || '';
  const r = await script.run({ argv, env: { STRIPE_SECRET_KEY: key }, log: (s) => lines.push(String(s)), config });
  return Object.assign(r, { out: lines.join('\n') });
};
const writes = () => calls.filter((c) => c.method === 'POST');

(async () => {
  /* ---------- refusals ---------- */
  let r = await run([], 'sk_live_abc', priced());
  ok('a live key alone is refused', r.code === 2 && calls.length === 0 && /LIVE key/.test(r.out));
  r = await run(['--live'], 'sk_live_abc', priced());
  ok('...and with --live but no confirmation', r.code === 2 && calls.length === 0);
  r = await run(['--confirm-live=create-real-stripe-objects'], 'rk_live_abc', priced());
  ok('...and with the confirmation but no --live', r.code === 2 && calls.length === 0);
  r = await run(['--live', '--confirm-live=yes'], 'sk_live_abc', priced());
  ok('...and with the wrong confirmation', r.code === 2 && calls.length === 0);
  r = await run(['--live', '--confirm-live=create-real-stripe-objects'], 'sk_test_abc', priced());
  ok('--live with a test key is refused', r.code === 2 && calls.length === 0);
  for (const key of ['', 'pk_test_abc', 'whsec_abc', 'sk_abc']) {
    r = await run([], key, priced());
    if (r.code !== 2 || calls.length) ok('a key that is not a secret key is refused: ' + key, false);
  }
  ok('a missing key, or one that is not a secret key, is refused', true);
  r = await run([], 'sk_test_abc', priced({ taxCode: null }));
  ok('no tax code: nothing is created', r.code === 2 && calls.length === 0 && /taxCode/.test(r.out));
  r = await run([], 'sk_test_abc', shipped);
  ok('the shipped config (every price null) creates nothing', r.code === 2 && calls.length === 0);
  r = await run([], 'sk_test_abc', Object.assign(JSON.parse(JSON.stringify(shipped)), { taxCode: 'txcd_10000000' }));
  ok('...even with a tax code: no price, no product', r.code === 3 && calls.length === 0 && /every price .* is null/.test(r.out));
  r = await run(['--dry-run'], 'sk_live_abc', priced());
  ok('a dry run sends nothing, whatever the key', r.code === 0 && calls.length === 0 && r.items.length === 4);

  /* ---------- the first run ---------- */
  r = await run([], 'sk_test_abc', priced());
  ok('four priced tiers: four products, prices and links', state.products.size === 4 && state.prices.length === 4 && state.links.length === 4, `${state.products.size} ${state.prices.length} ${state.links.length}`);
  ok('...and it ends non-zero, naming the tiers it skipped for having no price', r.code === 3 && /chief-of-staff \/ scripts: its price is null/.test(r.out) && r.skipped.filter((s) => s.blocking).length === 2);
  ok('done-for-you is skipped while it is switched off', /app-stack \/ dfy: switched off/.test(r.out) && !state.products.has('labkit_app_stack_dfy'));
  ok('every call used the given key, on api.stripe.com', calls.length > 0 && calls.every((c) => c.auth === 'Bearer sk_test_abc'));
  ok('prices are the config\'s cents, in its currency', state.prices.map((p) => p.unit_amount).sort((a, b) => a - b).join() === '3900,4900,9900,14900' && state.prices.every((p) => p.currency === 'usd' && p.tax_behavior === 'exclusive'));
  const renewal = state.prices.find((p) => p.lookup_key === 'labkit_app_stack_renewal');
  ok('only the renewal is recurring, yearly', renewal.recurring.interval === 'year' && state.prices.filter((p) => p.recurring).length === 1);
  ok('products carry the tax code and the brand', [...state.products.values()].every((p) => p.tax_code === 'txcd_10000000' && p.name.startsWith(shipped.brand + ' - ')));
  const kitLink = state.links.find((l) => l.metadata.kit === 'app-stack' && l.metadata.tier === 'kit');
  ok('a link carries kind, kit and tier - on the link and on the payment', kitLink.metadata.kind === 'kit' && kitLink.payment_intent_data.metadata.kind === 'kit' && kitLink.payment_intent_data.metadata.tier === 'kit');
  const renLink = state.links.find((l) => l.metadata.tier === 'renewal');
  ok('...the renewal on its subscription instead', renLink.subscription_data.metadata.tier === 'renewal' && !renLink.payment_intent_data && !renLink.customer_creation);
  ok('...with automatic tax, and the thank-you page after', state.links.every((l) => l.automatic_tax.enabled === 'true' && l.after_completion.redirect.url === 'https://strongtechnicalconsulting.com/kits/thanks'));
  ok('no link carries a uid or a client_reference_id', !/"uid"|client_reference_id/.test(JSON.stringify(calls)));
  ok('it prints the settings for the landing-page service', /KIT_LINK_APP_STACK_KIT=https:\/\/buy\.stripe\.com\/test_/.test(r.out) && /KIT_LINK_CHIEF_OF_STAFF_KIT=/.test(r.out) && /KIT_LINK_APP_STACK_RENEWAL=/.test(r.out));
  const pages = require('../lib/kits-pages');
  ok('...under the names, and in the shape, the pages read', r.links.every((l) => pages.PAYMENT_LINK.test(l.url)) && r.links.some((l) => l.env === pages.envName('KIT_LINK', 'app-stack', 'kit')));
  ok('the output never shows the key', !/sk_test_abc/.test(r.out));

  /* ---------- again ---------- */
  calls.length = 0;
  r = await run([], 'sk_test_abc', priced());
  ok('a second run creates and changes nothing', writes().length === 0 && state.links.length === 4 && r.links.length === 4, writes().length);

  /* ---------- a price change ---------- */
  calls.length = 0;
  const dearer = priced(); dearer.kits['app-stack'].tiers.kit.price = 19900;
  r = await run([], 'sk_test_abc', dearer);
  const made = writes();
  ok('a changed price: one new price, one new link, the old link switched off', made.length === 3 && state.prices.length === 5 && state.links.length === 5 && state.links.filter((l) => l.active).length === 4, made.map((c) => c.path).join(' '));
  const newLink = state.links[4];
  ok('...the new link is for the new price, and the old price lost the lookup key', newLink.metadata.tier === 'kit' && state.prices.find((p) => p.id === newLink.metadata.price).unit_amount === 19900 && state.prices.filter((p) => p.lookup_key === 'labkit_app_stack_kit').length === 1);
  ok('...and no product was made twice', state.products.size === 4);

  /* ---------- live, on purpose ---------- */
  reset();
  r = await run(['--live', '--confirm-live=create-real-stripe-objects'], 'rk_live_abc', priced());
  ok('a live key with both flags runs (against the stand-in)', r.code === 3 && state.links.length === 4 && /LIVE mode/.test(r.out));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
