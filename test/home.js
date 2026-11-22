// The home page, site/index.html, as redesigned on 2026-11-22: the rules that
// are easy to lose in an edit. Read from the files; nothing is booted.
//
// - No inline script: everything the page does is in /home.js and the other
//   files it names (the JSON-LD block is data, not script). No inline event
//   handlers and no style attributes either.
// - Erik's address is not in the page or its script, and there is no mailto:.
// - The first screen: his name, the four proof figures exactly as he cleared
//   them, and a "Get in touch" button that is a [data-contact] link.
// - data-counts="off" stays on <html>, and the two scripts that fill the
//   small live numbers still return early while it is there.
// - Chapter and the "New in the Lab" cards link only apps the lab lists and
//   has not retired, under the lab's own name and emoji. (Taglines and
//   colours are the lab's too, as written that day; /home.js refreshes them
//   from the lab's live answer, so they are not pinned here.)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const lab = require('../challenge/lab.js');

const SITE = path.join(__dirname, '..', 'site');
const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(SITE, 'home.js'), 'utf8');
const body = html.slice(html.indexOf('<body'));
let n = 0;
const ok = (name) => { n++; console.log('  PASS  ' + name); };
const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&rsquo;/g, '’').replace(/\s+/g, ' ').trim();

/* ---------- no inline script ---------- */
const scripts = html.match(/<script\b[^>]*>/gi) || [];
const inline = scripts.filter((t) => !/\bsrc=/.test(t) && !/type="application\/ld\+json"/.test(t));
assert.deepStrictEqual(inline, []); ok('no inline script (JSON-LD is the only script element without a src)');
assert.ok(scripts.some((t) => /src="\/home\.js"/.test(t) && /\bdefer\b/.test(t))); ok('/home.js is loaded with defer');
assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(body)); ok('no inline event handlers');
assert.ok(!/\sstyle\s*=/i.test(body)); ok('no style attributes in the body');
for (const src of scripts.map((t) => (/src="([^"]+)"/.exec(t) || [])[1]).filter(Boolean)) {
  assert.ok(src.startsWith('/') && !src.startsWith('//'), src);
  assert.ok(fs.existsSync(path.join(SITE, src)) || src === '/analytics.js', src + ' exists');
}
ok('every script is this site\'s own file');
assert.ok(!/<link[^>]+rel="stylesheet"/i.test(html) && !/@import|url\(\s*["']?https?:/i.test(html)); ok('no external stylesheet, font or CSS url');

/* ---------- no address ---------- */
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
for (const [name, src] of [['index.html', html], ['home.js', js]]) {
  const found = (src.match(ADDRESS) || []).filter((a) => !/example\.com$/.test(a));
  assert.deepStrictEqual(found, [], name);
  assert.ok(!/mailto:/i.test(src), name);
}
ok('no email address and no mailto: in the page or its script');

/* ---------- the first screen ---------- */
assert.strictEqual((html.match(/<h1\b/g) || []).length, 1);
assert.ok(/<h1[^>]*>Erik Strong<\/h1>/.test(html)); ok('one h1, his name');
const proof = /<ul class="proof"[^>]*>([\s\S]*?)<\/ul>/.exec(html);
assert.ok(proof);
const items = (proof[1].match(/<li>[\s\S]*?<\/li>/g) || []).map((li) => [text(/<b>([\s\S]*?)<\/b>/.exec(li)[1]), text(/<span>([\s\S]*?)<\/span>/.exec(li)[1])]);
assert.deepStrictEqual(items, [
  ['$2.7B+', 'revenue supported'],
  ['$50M+', 'revenue grown & protected'],
  ['1,700+', 'hours a week saved by AI agents'],
  ['2', 'patents in fraud detection'],
]);
ok('the proof row is the four figures Erik cleared, unchanged');
const hero = /<section class="hero"[\s\S]*?<\/section>/.exec(html)[0];
assert.ok(hero.indexOf('class="proof"') > -1);
const cta = /<a class="btn btn-primary"[^>]*>[\s\S]*?<\/a>/.exec(hero);
assert.ok(cta && /\sdata-contact[\s>]/.test(cta[0]) && /Get in touch/.test(cta[0]) && /href="#contact"/.test(cta[0])); ok('"Get in touch" is a data-contact link, in the hero');
assert.ok((html.match(/\sdata-contact[\s>]/g) || []).length >= 2 && /data-contact-show/.test(html)); ok('...and the contact list has one too, which can show the address on a click');
assert.ok(/src="\/contact\.js"/.test(html)); ok('/contact.js is loaded');

/* ---------- counts off ---------- */
assert.ok(/<html lang="en" data-counts="off">/.test(html)); ok('data-counts="off" is on <html>');
assert.ok(/\[data-counts="off"\] \.cb-board, \[data-counts="off"\] \.livefeed, \[data-counts="off"\] \.trendbar, \[data-counts="off"\] \.views \{ display: none !important; \}/.test(html)); ok('...and hides the standings, Live now, Most used and per-card views');
assert.strictEqual((js.match(/if \(document\.documentElement\.getAttribute\('data-counts'\) === 'off'\) return;/g) || []).length, 2); ok('...and the two scripts that fill them return early');
for (const id of ['cbLive', 'cbDrop', 'cbEm', 'cbK', 'cbName', 'cbTag', 'cbCount', 'cbNext', 'cbBoard', 'cbBk', 'cbBl', 'cbBs', 'liveFeed', 'lfList', 'trendBar', 'trendWhen', 'trendList', 'previewStrip', 'previewDots', 'subForm', 'subEmail', 'subBtn', 'subNote', 'subWebsite', 'subT', 'iphoneApps', 'nav']) {
  assert.ok(html.includes(`id="${id}"`), 'missing #' + id);
}
ok('every element the scripts look for is in the page');

/* ---------- the newsletter form keeps its traps ---------- */
const form = /<form class="sub-form"[\s\S]*?<\/form>/.exec(html)[0];
assert.ok(/method="POST" action="\/api\/subscribe"/.test(form) && /name="website"/.test(form) && /type="hidden" name="t"/.test(form) && /tabindex="-1"/.test(form)); ok('the signup form posts on its own and carries the hidden field and the timer');
assert.ok(/website:/.test(js) && /\bt: Number/.test(js)); ok('...and the script sends both');

/* ---------- Chapter and the lab cards ---------- */
const LAB = 'https://challenge.strongtechnicalconsulting.com/';
const live = (slug) => { const a = lab.get(slug); return a && a.status !== 'retired' ? a : null; };
assert.ok(live('chapter') && html.includes(`href="${LAB}chapter/"`) && html.includes(`href="${LAB}chapter/#try"`)); ok('Chapter is featured, with its made-up club');
for (const word of ['progress board', 'Spoiler-safe notes', 'vote for the next book', 'Meetups', 'My library']) assert.ok(html.includes(word), word);
ok('...naming the board, the notes, the vote, meetups and My library');
for (const f of ['chapter-board-light.webp', 'chapter-board-dark.webp']) assert.ok(html.includes('/assets/' + f) && fs.existsSync(path.join(SITE, 'assets', f)), f);
ok('...with its picture in both themes');
const cards = body.match(/<a class="card lab-card"[\s\S]*?<\/a>/g) || [];
assert.ok(cards.length >= 3 && cards.length <= 5); ok(`${cards.length} lab apps are featured`);
for (const c of cards) {
  const slug = /data-lab="([a-z0-9-]+)"/.exec(c)[1];
  const a = live(slug);
  assert.ok(a, slug + ' is in the lab and not retired');
  assert.ok(c.includes(`href="${LAB}${slug}/"`), slug + ' links its own lab address');
  assert.strictEqual(text(/<h3 data-lab-name>([\s\S]*?)<\/h3>/.exec(c)[1]), a.name);
  assert.ok(text(/<p data-lab-tag>([\s\S]*?)<\/p>/.exec(c)[1]).length > 20, slug + ' tagline');
  assert.ok(c.includes(a.emoji), slug + ' emoji');
  assert.ok(new RegExp(`\\.t-${slug} \\{ --c1: #[0-9a-f]{6}; --c2: #[0-9a-f]{6}; \\}`, 'i').test(html), slug + ' colours');
}
ok('each links a live lab app, under the lab\'s own name and emoji');
for (const m of body.matchAll(/href="https:\/\/challenge\.strongtechnicalconsulting\.com\/([a-z0-9-]+)\//g)) assert.ok(live(m[1]), m[1]);
ok('no link to a lab app that is retired or unknown');
assert.ok(/el\.hidden = true/.test(js) && /\[data-lab\]/.test(js)); ok('the script takes a card away when the lab says its app is not live');

/* ---------- the rest of the page is still there ---------- */
for (const href of ['/challenge', '/writing', '/feed.xml', '/privacy', '/terms', 'https://acct.strongtechnicalconsulting.com', 'https://www.linkedin.com/in/eriksstrong', 'https://github.com/eRock35',
  'https://footballapp.strongtechnicalconsulting.com', 'https://beer.strongtechnicalconsulting.com', 'https://trip.strongtechnicalconsulting.com', 'https://dataviz.strongtechnicalconsulting.com',
  'https://friction.strongtechnicalconsulting.com/preview', 'https://spellbook.strongtechnicalconsulting.com']) {
  assert.ok(body.includes(`href="${href}"`), href);
}
ok('the Challenge, the blog, the legal pages, the account page and the six projects are linked');
for (const id of ['main', 'apps', 'chapter', 'lab', 'projects', 'about', 'writing', 'contact']) assert.ok(new RegExp(`<[a-z]+[^>]*\\sid="${id}"`).test(body), '#' + id);
assert.ok(/<a class="skip" href="#main">/.test(body) && /<main id="main"/.test(body) && /<footer/.test(body) && /<nav[^>]*aria-label=/.test(body)); ok('landmarks and a skip link');
const imgs = body.match(/<img\b[^>]*>/g) || [];
assert.ok(imgs.length && imgs.every((i) => /\salt="/.test(i) && /\swidth="/.test(i) && /\sheight="/.test(i))); ok('every image has alt text and its size');
const levels = (body.match(/<h[1-6]\b/g) || []).map((h) => Number(h[2]));
assert.ok(levels.every((l, i) => i === 0 || l <= levels[i - 1] + 1)); ok('headings never skip a level');
assert.ok(/prefers-color-scheme: dark/.test(html) && /prefers-reduced-motion: reduce/.test(html) && /:focus-visible/.test(html)); ok('dark theme, reduced motion and focus styles are in the stylesheet');

/* ---------- motion: all of it off under reduced motion ---------- */
const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
// Every @keyframes and every `animation:` that starts something sits inside
// the no-preference block, except the delayed reveal of the lab tile's copy
// (cb-late), which the reduce block answers by simply showing it.
const block = (open) => { const i = css.indexOf(open); assert.ok(i > -1, open); let d = 0, j = css.indexOf('{', i); for (let k = j; k < css.length; k++) { if (css[k] === '{') d++; else if (css[k] === '}' && --d === 0) return css.slice(j, k + 1); } throw new Error('unclosed ' + open); };
const moving = block('@media (prefers-reduced-motion: no-preference) {\n    @keyframes');
const still = block('@media (prefers-reduced-motion: reduce)');
const outside = css.replace(moving, '').replace(still, '');
assert.deepStrictEqual((outside.match(/@keyframes\s+([\w-]+)/g) || []), ['@keyframes cb-late']);
assert.deepStrictEqual((outside.match(/animation:[^;}]+/g) || []).filter((a) => !/cb-late/.test(a)), []);
ok('every animation is declared only for people who have not asked for less motion');
assert.ok(/transition: none !important; animation: none !important;/.test(still) && /\.cb-live\[data-state="wait"\] \.cb-drop > \*[^{]*\{ opacity: 1; \}/.test(still)); ok('...and reduced motion switches off every transition and animation, hiding nothing');
assert.ok(!/infinite/.test(css)); ok('nothing loops forever');
assert.ok(/prefers-reduced-motion: reduce/.test(js) && /calm\.matches/.test(js) && /pointer: fine/.test(js)); ok('the pointer light is for a mouse only, and never under reduced motion');
assert.ok(!/setInterval\([^)]*\b(16|33|50|100)\b\)/.test(js) && !/getContext\(/.test(js)); ok('no canvas and no fast timer');
assert.ok(/data-app="landing"/.test(html) && /src="\/get-app\.js" data-src="\/ios-apps\.json" data-list="#iphoneApps"/.test(html) && /data-get-apps/.test(html)); ok('the view beacon and the iPhone apps list are wired');

console.log(`\n${n}/${n} passed`);
