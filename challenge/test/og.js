// Link previews (2026-09-26): every live app and the landing page carry
// og/twitter tags with absolute image URLs, and every card is current.
process.env.LAB_MEMORY = '1';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const lab = require('../lab');
const og = require('../scripts/og');

const ROOT = path.join(__dirname, '..');
let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'og-manifest.json'), 'utf8')).cards;
const pngSize = (buf) => ({ sig: buf.slice(1, 4).toString(), w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
const RERUN = ' - run `npm run og` in challenge/ and commit what it writes';

/* ---------------- every card is there, and current ---------------- */

assert.ok(!lab.APPS.some((a) => a.slug === 'og'), '"og" is the cards\' own path; no app may take it');
assert.strictEqual(new Set(lab.APPS.map((a) => a.slug)).size, lab.APPS.length);
ok('no app is called "og" (the cards are served at /og/)');

function checkCard(key, inputs, page, metaOf) {
  const file = path.join(ROOT, 'public', 'og', `${key}.png`);
  assert.ok(fs.existsSync(file), `${key}: no public/og/${key}.png${RERUN}`);
  const buf = fs.readFileSync(file);
  assert.deepStrictEqual(pngSize(buf), { sig: 'PNG', w: 1200, h: 630 }, `${key}: not a 1200x630 PNG`);
  assert.ok(buf.length < 1024 * 1024, `${key}: card over 1 MB`);
  const m = manifest[key];
  assert.ok(m, `${key}: not in og-manifest.json${RERUN}`);
  assert.strictEqual(m.inputs, og.inputHash(inputs), `${key}: the card was drawn from an older lab.js entry${RERUN}`);
  const v = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
  assert.strictEqual(m.v, v, `${key}: the PNG changed since the manifest was written${RERUN}`);
  const html = fs.readFileSync(page, 'utf8');
  const block = og.blockOf(html);
  assert.ok(block, `${key}: ${path.relative(ROOT, page)} has no lab:og block${RERUN}`);
  assert.strictEqual(block, og.tagsBlock(metaOf(v)), `${key}: its tags are out of date${RERUN}`);
  assert.ok(block.includes(`<meta property="og:image" content="${og.LAB_ORIGIN}/og/${key}.png?v=${v}">`));
  assert.ok(html.indexOf(block) < html.indexOf('</head>'), `${key}: tags must be inside <head>`);
}
for (const { a, drop } of og.cardApps(lab.APPS)) {
  const page = path.join(ROOT, 'apps', a.slug, 'public', 'index.html');
  if (!fs.existsSync(page)) continue;
  checkCard(a.slug, og.appInputs(a, drop), page, (v) => og.appMeta(a, drop, v));
}
ok(`every live app (${og.cardApps(lab.APPS).length}) has a current 1200x630 card and tags pointing at it`);
const li = og.landingInputs(lab.APPS);
checkCard('lab', li, path.join(ROOT, 'public', 'index.html'), (v) => og.landingMeta(li.count, v));
ok('the landing page has a current card (with today\'s app count) and tags');

/* ---------------- the tags themselves ---------------- */

const meta = og.appMeta(lab.APPS[0], 1, 'abc1234567');
assert.ok(/^https:\/\/challenge\.strongtechnicalconsulting\.com\/og\/spar\.png\?v=abc1234567$/.test(meta.image)); ok('og:image is an absolute https URL with a version');
assert.strictEqual(meta.url, 'https://challenge.strongtechnicalconsulting.com/spar/'); ok('og:url is the app\'s absolute address');
const block = og.tagsBlock(meta);
for (const k of ['og:title', 'og:description', 'og:url', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt', 'og:type', 'og:site_name']) assert.ok(block.includes(`property="${k}"`), k);
for (const k of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) assert.ok(block.includes(`name="${k}"`), k);
assert.ok(block.includes('name="twitter:card" content="summary_large_image"')); ok('og and twitter tags are all there, as a large-image card');

const evil = { slug: 'evil', name: '"><script>alert(1)</script>', tagline: '\' onload=\'x\' <img src=x onerror=alert(1)>', blurb: '</title><svg onload=alert(1)>', emoji: '<b>', color: 'red;background:url(x)', color2: '#fff' };
const eb = og.tagsBlock(og.appMeta(evil, 3, 'v'));
assert.ok(!/<script|<img|<svg|<\/title>/i.test(eb)); assert.ok(!/content="[^"]*"[^>]*"/.test(eb.replace(/<meta [^>]*>/g, (m) => m.replace(/content="[^"]*"/, 'content=""'))));
eb.split('\n').filter((l) => l.includes('<meta')).forEach((l) => assert.ok(/^\s*<meta (property|name)="[a-z:_]+" content="[^"<>]*">$/.test(l), l));
ok('hostile names and taglines are escaped: one attribute per tag, no markup');
assert.strictEqual(og.appInputs(evil, 3).color, '#7c3aed'); ok('a colour that is not a hex never reaches the card');

const page = '<html><head>\n  <title>x</title>\n</head><body></body></html>';
const once = og.withBlock(page, block);
assert.strictEqual(og.withBlock(once, block), once); assert.strictEqual(once.split('lab:og (').length, 2);
assert.ok(og.withBlock(once, og.tagsBlock({ ...meta, title: 'New' })).includes('content="New"'));
ok('writing the block twice is a no-op; a new block replaces the old one');

let drew = false;
try { require.resolve('@resvg/resvg-js'); drew = true; } catch (e) { console.log('  --  @resvg/resvg-js not installed; skipping the drawing checks'); }
if (drew) {
  const svg = og.appSvg(og.appInputs(evil, 3));
  assert.ok(!/<script|<img|<b>|\sonerror=/i.test(svg)); ok('a hostile name drawn on a card is text, not markup');
  const lsvg = og.landingSvg(og.landingInputs([...lab.APPS, { ...evil, status: 'testing', dropped: '2026-09-27' }]));
  assert.ok(!/<script|<img|\sonerror=/i.test(lsvg)); ok('...and on the landing card');
}
for (const { a } of og.cardApps(lab.APPS)) {
  const c1 = og.deepen(og.appInputs(a, 1).color), c2 = og.deepen(og.appInputs(a, 1).color2);
  for (const c of [c1, c2]) assert.ok(1.05 / (og.lum(c) + 0.05) >= 4.5, `${a.slug}: white on ${c} under 4.5:1`);
}
ok('white text holds 4.5:1 on both ends of every app card');

/* ---------------- served ---------------- */

(async () => {
  const { host } = require('../server');
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const p of ['/', '/spar/', `/${lab.APPS[lab.APPS.length - 1].slug}/`]) {
    const res = await fetch(base + p);
    const html = await res.text();
    assert.strictEqual(res.status, 200, p);
    const img = /<meta property="og:image" content="([^"]+)">/.exec(html);
    assert.ok(img && /^https:\/\/challenge\.strongtechnicalconsulting\.com\/og\/[a-z0-9-]+\.png\?v=[0-9a-f]{10}$/.test(img[1]), `${p}: og:image ${img && img[1]}`);
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'), p);
    const pic = await fetch(base + img[1].replace(og.LAB_ORIGIN, ''));
    assert.strictEqual(pic.status, 200); assert.strictEqual(pic.headers.get('content-type'), 'image/png');
  }
  ok('/, /spar/ and the newest app serve their tags, and each og:image resolves to a PNG');
  server.close();
  console.log(`\n${n}/${n} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
