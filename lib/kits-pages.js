// The kit pages: /kits, /kits/app-stack, /kits/chief-of-staff, and the two
// small ones a buyer lands on (/kits/thanks, /kits/download).
//
// HIDDEN until Erik launches: nothing on the site links here, every page
// carries noindex (and the route adds X-Robots-Tag), and none is in the
// sitemap. Rendered per request, because three things on them are settings:
//
//   KIT_LINK_<KIT>_<TIER>   a Stripe Payment Link. A buy button exists only
//                           when this holds exactly such a link; anything
//                           else, or nothing, reads "Coming soon".
//   KIT_PRICE_<KIT>_<TIER>  whole cents, overriding config/kits.json.
//   config/kits.json        prices (null as shipped) and the brand.
//
// A price is shown only when one of those gives it. None is ever made up.
//
// The landing's rules hold here too (test/kits-pages.js): no inline script,
// no inline handlers, no style attributes, one stylesheet (/kits.css, the
// landing's tokens), system fonts, 44 px targets, no address in the page -
// the refund link is a [data-contact] link like every other.

const kits = require('./kits');

const { BRAND, SELLER, REFUND_DAYS, UPDATES_MONTHS, CONFIG } = kits;

const CSP = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Exactly a Payment Link: buy.stripe.com, one path segment. A test-mode link
// (test_...) is allowed so the flow can be rehearsed, and says so on the page.
const PAYMENT_LINK = /^https:\/\/buy\.stripe\.com\/(?:test_)?[A-Za-z0-9]{8,64}$/;

function envName(prefix, kit, tier) {
  return `${prefix}_${kit}_${tier}`.replace(/-/g, '_').toUpperCase();
}
function linkFor(kit, tier) {
  const url = String(process.env[envName('KIT_LINK', kit, tier)] || '').trim();
  return PAYMENT_LINK.test(url) ? url : '';
}
function priceFor(kit, tier) {
  const fromEnv = String(process.env[envName('KIT_PRICE', kit, tier)] || '').trim();
  if (/^[1-9]\d{1,6}$/.test(fromEnv)) return Number(fromEnv);
  const t = CONFIG.kits[kit] && CONFIG.kits[kit].tiers && CONFIG.kits[kit].tiers[tier];
  const cents = t ? t.price : null;
  return Number.isInteger(cents) && cents > 0 ? cents : null;
}
function money(cents) {
  const dollars = cents / 100;
  return '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

/* ------------------------------------------------------------------ *
 * What the pages say. The kits themselves are phase 2 and 3: this copy
 * describes what the spec commits to and nothing past it.
 * ------------------------------------------------------------------ */

const KITS = {
  'app-stack': {
    name: 'App-Stack Kit',
    line: 'The stack behind the Lab’s apps, as something you install.',
    summary: 'Hosting on Cloud Run, a Firestore database, sign-in, Stripe billing and Gemini, wired together and deployed to your own cloud account by one command.',
    parts: [
      ['Hosting', 'A Cloud Run service that scales to zero, in your own Google Cloud project.'],
      ['Data', 'A Firestore database, set up and connected.'],
      ['Sign-in', 'Accounts and sessions, ready for your first user.'],
      ['Billing', 'Stripe checkout and a verified webhook, on your own Stripe account.'],
      ['AI', 'Gemini calls, behind your own key.'],
    ],
    keys: ['A Google Cloud project with billing on', 'A Stripe account', 'A Gemini API key'],
    hosted: true,
  },
  'chief-of-staff': {
    name: 'Chief-of-Staff Kit',
    line: 'Personal automation that runs on your own machine or cloud.',
    summary: 'Four routines that keep a week in order: inbox triage, a daily debrief, a weekly reset and a subscription audit. Self-hosted only, on accounts that are yours.',
    parts: [
      ['Inbox triage', 'Sorts what came in, so what needs you is on top.'],
      ['Daily debrief', 'One short summary of the day, every day.'],
      ['Weekly reset', 'A weekly pass that clears the decks and sets up the next one.'],
      ['Subscription audit', 'Finds what you are paying for, and what you forgot you were.'],
    ],
    keys: ['Your own mailbox', 'Your own AI model API key', 'Somewhere to run it: your computer or your own cloud account'],
    hosted: false,
  },
};

// The tier table. `on`: which tiers include the row.
const TIER_ORDER = ['scripts', 'kit', 'hosted', 'dfy'];
const TIER_INFO = {
  scripts: { name: 'Scripts only', blurb: 'The raw scripts and a README. For people who would rather read the code than run a wizard.', pay: 'One-time' },
  kit: { name: 'Self-setup kit', blurb: `A guided setup, a doctor, a demo video, the help bot and ${UPDATES_MONTHS} months of updates.`, pay: 'One-time, then an optional yearly renewal' },
  hosted: { name: 'Hosted', blurb: 'We run it for you. App-Stack Kit only, and not open yet.', pay: 'Monthly' },
  dfy: { name: 'Done-for-you', blurb: 'Erik sets it up with you, on your accounts.', pay: 'One-time' },
};
const ROWS = [
  ['The scripts and a README', ['scripts', 'kit', 'dfy']],
  ['Guided <code>./setup.sh</code>', ['kit', 'dfy']],
  ['<code>--doctor</code>, which checks an install and says what is wrong', ['kit', 'dfy']],
  ['Demo video', ['kit', 'dfy']],
  ['AI help bot', ['kit', 'dfy']],
  [`${UPDATES_MONTHS} months of updates (<code>--update</code>)`, ['kit', 'dfy']],
  ['Runs on your own accounts, with your own keys', ['scripts', 'kit', 'dfy']],
  ['Hosted and run for you', ['hosted']],
  ['Set up for you by Erik', ['dfy']],
];

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

function shell({ title, description, body, path }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/kits.css">
<script src="/contact.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav">
  <nav class="wrap nav-inner" aria-label="${esc(BRAND)}">
    <a class="brand" href="/kits"><span class="brand-mark" aria-hidden="true"></span><span>${esc(BRAND)}</span></a>
    <div class="nav-links">
      <a href="/kits/app-stack"${path === '/kits/app-stack' ? ' aria-current="page"' : ''}>App-Stack</a>
      <a href="/kits/chief-of-staff"${path === '/kits/chief-of-staff' ? ' aria-current="page"' : ''}>Chief-of-Staff</a>
      <a href="/kits#faq">FAQ</a>
    </div>
  </nav>
</header>
<main id="main">
${body}
</main>
<footer class="foot">
  <div class="wrap foot-inner">
    <p>${esc(BRAND)} is sold by ${esc(SELLER)}.</p>
    <nav aria-label="Site">
      <a href="/kits">Kits</a>
      <a href="/kits#refunds">Refunds</a>
      <a href="/kits/download">Download</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </nav>
  </div>
</footer>
</body>
</html>`;
}

/** The buy button, or the words that stand in for it. */
function buy(kit, tier, label) {
  const url = linkFor(kit, tier);
  const cents = priceFor(kit, tier);
  const price = cents ? `<p class="price"><b>${money(cents)}</b><span>${tier === 'renewal' ? 'a year' : esc(TIER_INFO[tier].pay.toLowerCase())}</span></p>` : '';
  if (!url) return `${price}<p class="soon">Coming soon</p>`;
  const test = url.includes('/test_') ? '<p class="fine test">Test mode: no real charge.</p>' : '';
  return `${price}<a class="btn btn-primary" href="${esc(url)}" rel="noopener">${esc(label)}</a>${test}<p class="fine">Secure checkout by Stripe. Sales tax is added there if it applies.</p>`;
}

const yes = '<span class="yes" aria-hidden="true">&#10003;</span><span class="sr">Included</span>';
const no = '<span class="no" aria-hidden="true">&ndash;</span><span class="sr">Not included</span>';

function tierTable() {
  const head = TIER_ORDER.map((t) => `<th scope="col">${esc(TIER_INFO[t].name)}${t === 'hosted' ? '<span class="th-note">App-Stack only, later</span>' : ''}</th>`).join('');
  const rows = ROWS.map(([label, on]) => `<tr><th scope="row">${label}</th>${TIER_ORDER.map((t) => `<td>${on.includes(t) ? yes : no}</td>`).join('')}</tr>`).join('\n        ');
  const pay = `<tr><th scope="row">How you pay</th>${TIER_ORDER.map((t) => `<td class="pay">${esc(TIER_INFO[t].pay)}</td>`).join('')}</tr>`;
  const prices = Object.keys(KITS).map((slug) => `<tr><th scope="row"><a href="/kits/${slug}">${esc(KITS[slug].name)}</a></th>${TIER_ORDER.map((t) => {
    if (t === 'hosted') return `<td class="pay">${KITS[slug].hosted ? 'Not open yet' : no}</td>`;
    const cents = priceFor(slug, t);
    return `<td class="pay">${cents ? `<b>${money(cents)}</b>` : 'Coming soon'}</td>`;
  }).join('')}</tr>`).join('\n        ');
  return `<div class="table-scroll" role="region" aria-label="What each tier includes" tabindex="0">
      <table class="tiers">
        <thead><tr><th scope="col"><span class="sr">What you get</span></th>${head}</tr></thead>
        <tbody>
        ${rows}
        ${pay}
        ${prices}
        </tbody>
      </table>
    </div>`;
}

const REFUND = `<p>You have ${REFUND_DAYS} days from the day you buy. Ask, and all of it goes back to your card: no form, no questions, no need to say why. A refund switches the license key off, so the installer and the download stop accepting it.</p>
      <p><a class="arrow-link" href="#refunds" data-contact>Ask for a refund<span aria-hidden="true">&rarr;</span></a></p>`;

const FAQ = [
  ['What do I need before I start?', 'Your own accounts and your own API keys. Each kit page lists them. You pay those providers directly for what you use; none of that money passes through us, and your keys never leave your machine or your cloud.'],
  ['How is it delivered?', `Checkout is by Stripe. Within a minute or so you get one email with your license key and a download link. The link works for ${kits.EMAIL_LINK_HOURS} hours; after that, your key gets you a new one on the <a href="/kits/download">download page</a>.`],
  ['Is there support?', `It is self-service: the README, <code>--doctor</code> (which checks an install and tells you what is wrong) and an AI help bot. There is no email, chat or call support below done-for-you. If it does not work out, that is what the ${REFUND_DAYS}-day refund is for.`],
  ['What happens when my updates end?', `Nothing breaks. The self-setup kit comes with ${UPDATES_MONTHS} months of updates. After that everything you installed keeps working exactly as it is; only <code>--update</code> stops. A yearly renewal turns it back on, whenever you want it.`],
  ['Does the kit phone home?', 'The installer asks our server one question, at setup and on <code>--update</code>: is this license key good? It sends the key and the kit’s name, and nothing about you, your data or your keys.'],
  ['Can I get a refund?', `Yes: ${REFUND_DAYS} days, no questions. See <a href="#refunds">Refunds</a>.`],
];

/* ------------------------------------------------------------------ *
 * Pages
 * ------------------------------------------------------------------ */

function indexPage() {
  const cards = Object.keys(KITS).map((slug) => {
    const k = KITS[slug];
    return `<article class="card kit-card">
        <p class="kicker">${slug === 'app-stack' ? 'For builders' : 'For your own week'}</p>
        <h3>${esc(k.name)}</h3>
        <p class="kit-line">${esc(k.line)}</p>
        <p>${esc(k.summary)}</p>
        <ul class="ticks">${k.parts.map(([n]) => `<li>${esc(n)}</li>`).join('')}</ul>
        <a class="btn btn-secondary" href="/kits/${slug}">See the ${esc(k.name)}</a>
      </article>`;
  }).join('\n      ');

  const body = `  <section class="hero">
    <div class="hero-fx" aria-hidden="true"></div>
    <div class="wrap">
      <p class="kicker">${esc(BRAND)} &middot; ${esc(SELLER)}</p>
      <h1>The setup, done once, as a kit.</h1>
      <p class="lead">Two kits of setup code. One command installs everything, on accounts that are yours, with API keys that are yours.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="/kits/app-stack">App-Stack Kit</a>
        <a class="btn btn-secondary" href="/kits/chief-of-staff">Chief-of-Staff Kit</a>
      </div>
      <ul class="facts">
        <li><b>1</b><span>command to install</span></li>
        <li><b>0</b><span>of your keys sent to us</span></li>
        <li><b>${REFUND_DAYS}</b><span>days to ask for it all back</span></li>
      </ul>
    </div>
  </section>

  <section class="section wrap" aria-labelledby="kitsTitle">
    <div class="section-head">
      <p class="kicker">The kits</p>
      <h2 id="kitsTitle">Two kits. Each one installs in a command.</h2>
    </div>
    <div class="kit-grid">
      ${cards}
    </div>
  </section>

  <section class="section wrap" aria-labelledby="howTitle">
    <div class="section-head">
      <p class="kicker">How it works</p>
      <h2 id="howTitle">Pay, download, run one command.</h2>
    </div>
    <ol class="steps">
      <li><h3>Buy</h3><p>Checkout is by Stripe. No account to make here.</p></li>
      <li><h3>Get the email</h3><p>Your license key and a download link, in one message.</p></li>
      <li><h3>Run <code>./setup.sh</code></h3><p>It asks for your key and your own API keys, then installs everything.</p></li>
      <li><h3>Keep it healthy</h3><p><code>--doctor</code> checks an install. <code>--update</code> brings in what is new.</p></li>
    </ol>
  </section>

  <section class="section wrap" aria-labelledby="tiersTitle">
    <div class="section-head">
      <p class="kicker">Tiers</p>
      <h2 id="tiersTitle">Pick how much is done for you.</h2>
      <p class="lead">Every tier runs on your own accounts except Hosted, which is for the App-Stack Kit only and is not open yet.</p>
    </div>
    ${tierTable()}
  </section>

  <section class="section wrap duo" aria-labelledby="keysTitle">
    <div>
      <p class="kicker">Bring your own keys</p>
      <h2 id="keysTitle">Your accounts. Your keys. Your bill.</h2>
    </div>
    <div class="prose">
      <p>A kit installs into accounts you own: your cloud project, your Stripe account, your model API key. You type those keys into the installer on your own machine. They are never sent to us, and we could not see them if we wanted to.</p>
      <p>That also means the running costs are yours, paid straight to those providers at their prices. The kit is the setup, not a subscription to somebody else’s servers.</p>
    </div>
  </section>

  <section class="section wrap duo" id="refunds" aria-labelledby="refundsTitle">
    <div>
      <p class="kicker">Refunds</p>
      <h2 id="refundsTitle">${REFUND_DAYS} days. No questions.</h2>
    </div>
    <div class="prose">
      ${REFUND}
    </div>
  </section>

  <section class="section wrap" id="faq" aria-labelledby="faqTitle">
    <div class="section-head">
      <p class="kicker">Questions</p>
      <h2 id="faqTitle">Before you buy.</h2>
    </div>
    <div class="faq">
      ${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${a}</p></details>`).join('\n      ')}
    </div>
  </section>`;

  return shell({ title: `${BRAND}: setup code you install with one command`, description: `${BRAND} from ${SELLER}: the App-Stack Kit and the Chief-of-Staff Kit. One command installs everything, on your own accounts.`, body, path: '/kits' });
}

function kitPage(slug) {
  const k = KITS[slug];
  const tiers = TIER_ORDER.filter((t) => t !== 'hosted' || k.hosted);
  const tierCards = tiers.map((t) => {
    const info = TIER_INFO[t];
    const included = ROWS.filter(([, on]) => on.includes(t)).map(([label]) => `<li>${label}</li>`).join('');
    const action = t === 'hosted'
      ? '<p class="soon">Not open yet</p>'
      : buy(slug, t, `Buy ${info.name}`);
    return `<article class="card tier${t === 'kit' ? ' is-pick' : ''}">
        ${t === 'kit' ? '<p class="pick">Most people want this one</p>' : ''}
        <h3>${esc(info.name)}</h3>
        <p class="tier-blurb">${esc(info.blurb)}</p>
        <ul class="ticks">${included}</ul>
        <div class="tier-buy">${action}</div>
      </article>`;
  }).join('\n      ');

  const body = `  <section class="hero">
    <div class="hero-fx" aria-hidden="true"></div>
    <div class="wrap">
      <p class="kicker">${esc(BRAND)}</p>
      <h1>${esc(k.name)}</h1>
      <p class="lead">${esc(k.line)} ${esc(k.summary)}</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="#tiers">See the tiers</a>
        <a class="btn btn-secondary" href="/kits#faq">Questions</a>
      </div>
    </div>
  </section>

  <section class="section wrap" aria-labelledby="insideTitle">
    <div class="section-head">
      <p class="kicker">What it sets up</p>
      <h2 id="insideTitle">${slug === 'app-stack' ? 'A whole app stack, standing.' : 'Four routines, running.'}</h2>
    </div>
    <ul class="parts">
      ${k.parts.map(([n, d]) => `<li><h3>${esc(n)}</h3><p>${esc(d)}</p></li>`).join('\n      ')}
    </ul>
  </section>

  ${slug === 'app-stack' ? `<section class="section wrap" id="install" aria-labelledby="installTitle">
    <div class="section-head">
      <p class="kicker">Install</p>
      <h2 id="installTitle">Paste one line. Press Enter twice.</h2>
      <p class="lead">About five minutes, in your browser. Nothing to install, no keys to find, no settings to choose.</p>
    </div>
    <ol class="steps n3">
      <li><h3>Open Google Cloud Shell</h3>
        <p>A terminal in your browser, already signed in to your Google account.</p>
        <p><a class="btn btn-primary" href="https://shell.cloud.google.com/?show=terminal" target="_blank" rel="noopener">Open in Cloud Shell</a></p></li>
      <li><h3>Paste this line</h3>
        <p>Your license key is in your purchase email, already in the line.</p>
        <pre class="term wrap-cmd" tabindex="0" aria-label="The install command"><code>curl -fsSL https://strongtechnicalconsulting.com/kits/install.sh | bash -s -- lk_your_license_key</code></pre></li>
      <li><h3>Press Enter twice</h3>
        <p>It suggests a name for your app and uses your Google account as the admin. Then it builds everything and gives you your app's address and a one-click admin link.</p></li>
    </ol>
    <p class="fine">You need a Google account with billing on. An app nobody is using costs about nothing. Payments are one more command, when you want them. Already in a terminal? <code>./setup.sh</code>, <code>--doctor</code> and <code>--update</code> work as before.</p>
  </section>` : `  <section class="section wrap duo" aria-labelledby="runTitle">
    <div>
      <p class="kicker">Three commands</p>
      <h2 id="runTitle">Install it, check it, update it.</h2>
      <p class="lead">The self-setup kit and done-for-you come with all three. Scripts only is the code and a README.</p>
    </div>
    <pre class="term" tabindex="0" aria-label="The three commands"><code><span class="c"># install everything</span>
./setup.sh

<span class="c"># check an install and say what is wrong</span>
./setup.sh --doctor

<span class="c"># bring in what is new</span>
./setup.sh --update</code></pre>
  </section>

`}

  <section class="section wrap" id="tiers" aria-labelledby="tiersTitle">
    <div class="section-head">
      <p class="kicker">Tiers</p>
      <h2 id="tiersTitle">Pick how much is done for you.</h2>
    </div>
    <div class="tier-grid n${tiers.length}">
      ${tierCards}
    </div>
  </section>

  <section class="section wrap duo" id="renew" aria-labelledby="renewTitle">
    <div>
      <p class="kicker">Updates renewal</p>
      <h2 id="renewTitle">Keep the updates coming, if you want them.</h2>
    </div>
    <div class="prose">
      <p>The self-setup kit includes ${UPDATES_MONTHS} months of updates. When they end, nothing you installed stops working; only <code>--update</code> does. The renewal is yearly and adds another ${UPDATES_MONTHS} months each time it is paid. Cancel it whenever you like and keep what you have.</p>
      <p>Pay with the same email address you bought the kit with: that is how the renewal finds your license.</p>
      <div class="tier-buy">${buy(slug, 'renewal', 'Renew updates')}</div>
    </div>
  </section>

  <section class="section wrap duo" aria-labelledby="needTitle">
    <div>
      <p class="kicker">Bring your own keys</p>
      <h2 id="needTitle">What you need.</h2>
    </div>
    <div class="prose">
      <ul class="ticks">${k.keys.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <p>They stay yours. You type them into the installer on your own machine, and you pay those providers directly for what you use.</p>
    </div>
  </section>

  <section class="section wrap duo" id="refunds" aria-labelledby="refundsTitle">
    <div>
      <p class="kicker">Refunds</p>
      <h2 id="refundsTitle">${REFUND_DAYS} days. No questions.</h2>
    </div>
    <div class="prose">
      ${REFUND}
      <p><a class="arrow-link" href="/kits">All kits and the FAQ<span aria-hidden="true">&rarr;</span></a></p>
    </div>
  </section>`;

  return shell({ title: `${k.name} | ${BRAND}`, description: `${k.name}: ${k.line}`, body, path: `/kits/${slug}` });
}

function thanksPage() {
  const body = `  <section class="section wrap narrow">
    <p class="kicker">${esc(BRAND)}</p>
    <h1 class="plain">Thank you. Check your email.</h1>
    <p class="lead">Your license key and your download link are on their way to the address you paid with. It usually takes under a minute.</p>
    <div class="prose">
      <p>Nothing after ten minutes? Look in spam, then use the key from the message on the <a href="/kits/download">download page</a>.</p>
      <p><a class="arrow-link" href="/kits">Back to ${esc(BRAND)}<span aria-hidden="true">&rarr;</span></a></p>
    </div>
  </section>`;
  return shell({ title: `Thank you | ${BRAND}`, description: 'Your license key and download link are on their way.', body, path: '/kits/thanks' });
}

const PROBLEMS = {
  expired: 'That link has expired or is no longer valid. Enter your license key for a new one.',
  invalid: 'That key and kit do not match a license. Check both and try again.',
  revoked: 'That license was refunded, so its downloads are off.',
  'updates-lapsed': 'Updates for that license have ended, so the download is closed. What you installed keeps working; a renewal opens it again.',
  'downloads-unavailable': 'Downloads are unavailable right now. Your key is fine: try again later.',
  'rate-limited': 'Too many tries from here. Wait fifteen minutes and try again.',
  unavailable: 'Downloads are unavailable right now. Your key is fine: try again later.',
  error: 'Something went wrong on our side. Try again in a minute.',
};

function downloadPage({ problem } = {}) {
  const note = problem ? `<p class="alert" role="alert">${esc(PROBLEMS[problem] || PROBLEMS.error)}</p>` : '';
  const body = `  <section class="section wrap narrow">
    <p class="kicker">${esc(BRAND)}</p>
    <h1 class="plain">Download your kit</h1>
    <p class="lead">Enter the license key from your email. The download starts straight away.</p>
    ${note}
    <form class="key-form" method="POST" action="/kits/download">
      <label for="kit">Kit</label>
      <select id="kit" name="kit" required>
        ${Object.keys(KITS).map((s) => `<option value="${s}">${esc(KITS[s].name)}</option>`).join('')}
      </select>
      <label for="key">License key</label>
      <input id="key" name="key" type="text" required autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="lk_..." pattern="\\s*[lL][kK]_[A-Za-z2-7]{32}\\s*" aria-describedby="keyHelp">
      <p class="fine" id="keyHelp">It starts with <code>lk_</code> and is in the email you got when you bought.</p>
      <button class="btn btn-primary" type="submit">Download</button>
    </form>
  </section>`;
  return shell({ title: `Download | ${BRAND}`, description: 'Download your kit with your license key.', body, path: '/kits/download' });
}

module.exports = { indexPage, kitPage, thanksPage, downloadPage, linkFor, priceFor, money, envName, PAYMENT_LINK, CSP, KITS, TIER_ORDER };
