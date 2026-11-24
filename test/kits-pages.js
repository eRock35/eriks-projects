// The kit pages (lib/kits-pages.js, site/kits.css), phase 1 of Lab Kits.
//
// - HIDDEN: nothing on the site links to them, they are not in the sitemap,
//   every one carries a noindex meta and an X-Robots-Tag header.
// - A buy button exists only when KIT_LINK_<KIT>_<TIER> holds exactly a
//   Stripe Payment Link; anything else reads "Coming soon".
// - A price is shown only from KIT_PRICE_* or config/kits.json, which ships
//   with every price null.
// - The landing's rules: no inline script, handlers or style attributes; one
//   stylesheet of this site's own, on the landing's tokens; no address.
const h = require('./harness.js');
h.install();
const fs = require('fs');
const path = require('path');

const PORT = 9378;
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'landing-secret-abcdefghijklm',
  ADMIN_PASSWORD: 'admin-password-here-1', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  KITS_SECRET: 'kits-test-secret-0123456789abcdefghij', PORT: String(PORT),
});
delete process.env.FIRESTORE_DATABASE_ID;
for (const k of Object.keys(process.env)) if (/^KIT_(LINK|PRICE)_/.test(k)) delete process.env[k];

require(path.join(__dirname, '..', 'server.js'));
const kits = require('../lib/kits');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };
const base = 'http://127.0.0.1:' + PORT;
const get = async (p) => { const r = await fetch(base + p, { redirect: 'manual' }); return { status: r.status, headers: r.headers, html: await r.text() }; };
const PAGES = ['/kits', '/kits/app-stack', '/kits/chief-of-staff', '/kits/thanks', '/kits/download'];
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SITE = path.join(__dirname, '..', 'site');

(async () => {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  /* ---------- hidden ---------- */
  for (const p of PAGES) {
    const r = await get(p);
    ok(`${p} is served`, r.status === 200 && /^text\/html/.test(r.headers.get('content-type')), r.status);
    ok(`${p} has a noindex meta and an X-Robots-Tag header`, /<meta name="robots" content="noindex, nofollow">/.test(r.html) && /noindex/.test(r.headers.get('x-robots-tag') || ''));
    ok(`${p} is not cached`, /no-store/.test(r.headers.get('cache-control') || ''));
    const body = r.html.slice(r.html.indexOf('<body'));
    const scripts = r.html.match(/<script\b[^>]*>/gi) || [];
    ok(`${p} has no inline script, handler or style`, scripts.every((t) => /\bsrc="\/[a-z.-]+"/.test(t)) && !/\son[a-z]+\s*=\s*["']/i.test(body) && !/\sstyle\s*=/i.test(body) && !/<style\b/i.test(r.html));
    const sheets = r.html.match(/<link[^>]+rel="stylesheet"[^>]*>/gi) || [];
    ok(`${p} loads one stylesheet, this site's own`, sheets.length === 1 && /href="\/kits\.css"/.test(sheets[0]));
    ok(`${p} carries no address and no mailto:`, !(r.html.match(ADDRESS) || []).length && !/mailto:/i.test(r.html));
    ok(`${p} sends a policy that allows nothing from elsewhere`, /default-src 'none'/.test(r.headers.get('content-security-policy') || '') && !/unsafe-inline/.test(r.headers.get('content-security-policy')));
    ok(`${p} has one h1, a skip link and landmarks`, (r.html.match(/<h1\b/g) || []).length === 1 && /<a class="skip" href="#main">/.test(r.html) && /<main id="main">/.test(r.html) && /<footer/.test(r.html));
    const levels = (body.match(/<h[1-6]\b/g) || []).map((x) => Number(x[2]));
    ok(`${p} never skips a heading level`, levels.every((l, i) => i === 0 || l <= levels[i - 1] + 1), levels.join(''));
    ok(`${p} shows no price and no buy button as shipped`, !/buy\.stripe\.com/.test(r.html) && !/\$\s?\d/.test(r.html) && !/class="price"/.test(r.html));
    for (const m of r.html.matchAll(/href="(\/[^"#?]*)/g)) {
      const t = await fetch(base + m[1], { redirect: 'manual' });
      if (t.status !== 200) ok(`${p} links ${m[1]}, which exists`, false, t.status);
    }
  }
  for (const f of ['index.html', 'home.js', 'challenge.html', 'privacy.html', 'terms.html', 'account.html']) {
    ok(`site/${f} does not link the kits`, !/\/kits\b/.test(fs.readFileSync(path.join(SITE, f), 'utf8')));
  }
  for (const p of ['/', '/writing', '/challenge', '/sitemap.xml', '/robots.txt', '/feed.xml']) {
    const r = await get(p);
    ok(`${p} as served does not mention the kits`, r.status === 200 && !/\/kits\b/.test(r.html), r.status);
  }
  ok('an unknown kit is not a page', (await get('/kits/another-kit')).status === 404);

  /* ---------- what the pages say ---------- */
  const index = (await get('/kits')).html;
  ok('/kits names both kits and links each', /App-Stack Kit/.test(index) && /Chief-of-Staff Kit/.test(index) && /href="\/kits\/app-stack"/.test(index) && /href="\/kits\/chief-of-staff"/.test(index));
  const table = /<table class="tiers">[\s\S]*?<\/table>/.exec(index)[0];
  ok('...with the tier table: scripts, self-setup, hosted, done-for-you', ['Scripts only', 'Self-setup kit', 'Hosted', 'Done-for-you'].every((t) => new RegExp(`<th scope="col">${t}`).test(table)) && /App-Stack only, later/.test(table));
  ok('...whose marks have words for a screen reader', /class="sr">Included</.test(table) && /class="sr">Not included</.test(table) && /role="region"[^>]*tabindex="0"/.test(index));
  ok('...a refund policy, bring-your-own-keys and an FAQ', /id="refunds"/.test(index) && /14 days\. No questions\./.test(index) && /Your accounts\. Your keys\. Your bill\./.test(index) && /id="faq"/.test(index) && (index.match(/<details>/g) || []).length >= 5);
  ok('...and the refund link is a data-contact link with /contact.js loaded', /<a class="arrow-link" href="#refunds" data-contact>/.test(index) && /<script src="\/contact\.js" defer>/.test(index));
  ok('the brand is one constant', kits.BRAND === kits.CONFIG.brand && index.includes(`>${kits.BRAND}<`) && !/Lab Kits/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'kits-pages.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '')));
  const cos = (await get('/kits/chief-of-staff')).html;
  const stack = (await get('/kits/app-stack')).html;
  ok('Chief-of-Staff is self-host only: no hosted tier', !/<h3>Hosted<\/h3>/.test(cos) && /<h3>Hosted<\/h3>/.test(stack) && /Not open yet/.test(stack));
  ok('each kit page shows the three commands', [cos, stack].every((x) => /\.\/setup\.sh\n/.test(x) && /\.\/setup\.sh --doctor/.test(x) && /\.\/setup\.sh --update/.test(x)));
  ok('...and "Coming soon" where a button would be', (stack.match(/class="soon">Coming soon</g) || []).length === 4 && (cos.match(/class="soon">Coming soon</g) || []).length === 4);

  /* ---------- buy buttons ---------- */
  const LINK = 'https://buy.stripe.com/test_aBcD1234eFgH5678';
  for (const bad of ['http://buy.stripe.com/abcdefgh1234', 'https://buy.stripe.com.evil.example/abcdefgh1234', 'https://buy.stripe.com/abc', 'https://buy.stripe.com/abcdefgh1234?x=1',
    'https://buy.stripe.com/abcdefgh1234/extra', 'javascript:alert(1)', 'https://example.com/"><script>', 'https://evil.example/https://buy.stripe.com/abcdefgh1234', ' ']) {
    process.env.KIT_LINK_APP_STACK_KIT = bad;
    const html = (await get('/kits/app-stack')).html;
    if (/buy\.stripe\.com|evil\.example|javascript:|<script>alert/.test(html) || (html.match(/Coming soon/g) || []).length !== 4) ok('a setting that is not a Payment Link makes no button: ' + bad, false);
  }
  ok('a setting that is not exactly a Payment Link makes no button', true);
  process.env.KIT_LINK_APP_STACK_KIT = LINK;
  let html = (await get('/kits/app-stack')).html;
  ok('a Payment Link makes that tier\'s button, and only that tier\'s', html.includes(`<a class="btn btn-primary" href="${LINK}" rel="noopener">Buy Self-setup kit</a>`) && (html.match(/buy\.stripe\.com/g) || []).length === 1 && (html.match(/Coming soon/g) || []).length === 3);
  ok('...a test-mode link says it is one', /Test mode: no real charge\./.test(html));
  ok('...with no price, because none is set', !/class="price"/.test(html));
  ok('...and the other kit is untouched', !/buy\.stripe\.com/.test((await get('/kits/chief-of-staff')).html));
  process.env.KIT_LINK_APP_STACK_KIT = 'https://buy.stripe.com/aBcD1234eFgH5678';
  ok('a live link has no test-mode note', !/Test mode/.test((await get('/kits/app-stack')).html));
  process.env.KIT_LINK_CHIEF_OF_STAFF_RENEWAL = LINK;
  ok('the renewal has its own setting', /rel="noopener">Renew updates<\/a>/.test((await get('/kits/chief-of-staff')).html));

  /* ---------- prices ---------- */
  ok('config/kits.json ships with every price null and no tax code', kits.CONFIG.taxCode === null && Object.values(kits.CONFIG.kits).every((k) => Object.values(k.tiers).every((t) => t.price === null)));
  process.env.KIT_PRICE_APP_STACK_KIT = '14900';
  process.env.KIT_PRICE_APP_STACK_SCRIPTS = '4950';
  html = (await get('/kits/app-stack')).html;
  ok('a price setting is shown, in dollars', /<b>\$149<\/b>/.test(html) && /<b>\$49\.50<\/b>/.test(html) && (html.match(/class="price"/g) || []).length === 2);
  ok('...and on the comparison table', /<b>\$149<\/b>/.test((await get('/kits')).html));
  for (const bad of ['free', '-5', '0', '12.50', '1e9', '99999999', '<b>']) {
    process.env.KIT_PRICE_APP_STACK_KIT = bad;
    if (/class="price"><b>(?!\$49\.50)/.test((await get('/kits/app-stack')).html)) ok('a price setting that is not whole cents is not shown: ' + bad, false);
  }
  ok('a price setting that is not whole cents is not shown', true);
  for (const k of Object.keys(process.env)) if (/^KIT_(LINK|PRICE)_/.test(k)) delete process.env[k];

  /* ---------- the stylesheet ---------- */
  const css = fs.readFileSync(path.join(SITE, 'kits.css'), 'utf8');
  const home = /<style>([\s\S]*?)<\/style>/.exec(fs.readFileSync(path.join(SITE, 'index.html'), 'utf8'))[1];
  const tokens = (src, dark) => {
    const block = dark ? /prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\}/.exec(src)[1] : /:root \{([\s\S]*?)\}/.exec(src)[1];
    return Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  for (const dark of [false, true]) {
    const mine = tokens(css, dark); const theirs = tokens(home, dark);
    const drift = Object.keys(mine).filter((k) => k in theirs && mine[k] !== theirs[k]);
    ok(`its ${dark ? 'dark' : 'light'} tokens are the landing's`, Object.keys(mine).length > 10 && drift.length === 0, drift.join(' '));
  }
  // WCAG contrast of every text token on every surface it is used on.
  const lum = (hex) => { const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  let worst = 99;
  for (const dark of [false, true]) {
    const t = Object.assign(tokens(css, false), dark ? tokens(css, true) : {});
    const pairs = [];
    for (const ink of ['--ink', '--ink-2', '--ink-3', '--link', '--ok']) for (const bg of ['--bg', '--surface', '--surface-2']) pairs.push([ink, bg]);
    pairs.push(['--on-btn', '--btn'], ['--on-btn', '--btn-hover'], ['--d-ink', '--d-bg'], ['--d-ink-2', '--d-bg'], ['--d-accent', '--d-bg'], ['--lum-ink', '--d-accent'], ['--ink', '--err-soft'], ['--err', '--bg'], ['--err', '--surface']);
    for (const [a, b] of pairs) { const c = ratio(t[a], t[b]); worst = Math.min(worst, c); if (c < 4.5) ok(`${a} on ${b} (${dark ? 'dark' : 'light'}) clears 4.5:1`, false, c.toFixed(2)); }
  }
  ok(`every text colour clears 4.5:1 on its surfaces in both themes (worst ${worst.toFixed(2)})`, worst >= 4.5);
  ok('it fetches nothing from another origin', !/@import|url\(/i.test(css));
  ok('dark theme, reduced motion and focus styles are there', /prefers-color-scheme: dark/.test(css) && /prefers-reduced-motion: reduce/.test(css) && /:focus-visible/.test(css));
  const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, '').replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g, '');
  ok('nothing animates, and every transition is inside reduced-motion: no-preference', !/@keyframes|animation:/.test(outside) && !/transition:/.test(outside));
  for (const sel of ['.btn', '.nav-links a', '.foot nav a', '.arrow-link', '.brand', '.faq summary', '.key-form input, .key-form select']) {
    const rule = new RegExp(sel.replace(/[.,]/g, '\\$&') + ' \\{[^}]*min-height: (\\d+)px').exec(css);
    if (!rule || Number(rule[1]) < 44) ok(`${sel} is at least 44 px tall`, false, rule && rule[1]);
  }
  ok('every control is at least 44 px tall', true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
