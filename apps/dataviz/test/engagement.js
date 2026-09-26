// Share-link stills, link-preview tags and the sample play counter
// (2026-09-26). Uses the repo's shared in-memory Firestore harness, like
// eriks-projects/test/dataviz.js; run with `node apps/dataviz/test/engagement.js`
// from the repo root, or `npm test` in apps/dataviz.
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const h = require(path.join(__dirname, '..', '..', '..', 'test', 'harness.js'));
h.install();
const SECRET = 'identity-secret-abcdefghijklmn';
process.env.IDENTITY_SESSION_SECRET = SECRET;
process.env.SESSION_SECRET = 'dataviz-secret-abcdefghijklmn';
process.env.FIRESTORE_DATABASE_ID = 'dataviz';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.PORT = '9213';
delete process.env.PUBLIC_ORIGIN;
require(path.join(__dirname, '..', 'server.js'));
const still = require(path.join(__dirname, '..', 'lib', 'still.js'));
const og = require(path.join(__dirname, '..', 'lib', 'og.js'));

const B = 'http://127.0.0.1:9213';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b) });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const bag = () => h.bag('dataviz');

/* ---- real images, made here ---- */
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function png(w, h, noise = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = 1 + w * 3;
  const raw = Buffer.alloc(row * h);
  if (noise) { require('crypto').randomFillSync(raw, 0, Math.min(raw.length, noise)); for (let y = 0; y < h; y++) raw[y * row] = 0; }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function jpeg(w, h) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, sos, Buffer.from([0xff, 0xd9])]);
}
const GOOD = png(1200, 630);
const GOOD_JPG = jpeg(1200, 630);

function status(fn) { try { fn(); return 200; } catch (e) { return e.status || 500; } }

function rawGet(p, host) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: 9213, path: p, headers: { host } }, (res) => {
      let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject); r.end();
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 800));

  console.log('lib/still.js');
  ok('a real 1200x630 PNG is accepted', status(() => still.validate(GOOD, 'image/png')) === 200);
  ok('...its size is read from the IHDR', JSON.stringify(still.sniff(GOOD)).includes('"width":1200'));
  ok('a real 1200x630 JPEG is accepted', status(() => still.validate(GOOD_JPG, 'image/jpeg')) === 200);
  ok('no declared type is fine; the bytes decide', status(() => still.validate(GOOD, '')) === 200);
  ok('HTML is refused (415)', status(() => still.validate(Buffer.from('<html><script>alert(1)</script></html>'), 'image/png')) === 415);
  ok('an SVG is refused (415)', status(() => still.validate(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/svg+xml')) === 415);
  ok('a GIF is refused (415)', status(() => still.validate(Buffer.from('GIF89a\x04\x00\x02\x00'), 'image/gif')) === 415);
  ok('an empty body is refused', status(() => still.validate(Buffer.alloc(0), 'image/png')) === 415);
  ok('a PNG that says it is a JPEG is refused', status(() => still.validate(GOOD, 'image/jpeg')) === 415);
  ok('a truncated PNG (no IEND) is refused', status(() => still.validate(GOOD.subarray(0, GOOD.length - 12), 'image/png')) === 415);
  ok('a PNG with a page appended is refused', status(() => still.validate(Buffer.concat([GOOD, Buffer.from('<script>x</script>')]), 'image/png')) === 415);
  ok('a JPEG with no EOI is refused', status(() => still.validate(GOOD_JPG.subarray(0, GOOD_JPG.length - 2), 'image/jpeg')) === 415);
  ok('a 1200x631 PNG is refused (422)', status(() => still.validate(png(1200, 631), 'image/png')) === 422);
  ok('a 630x1200 PNG is refused (422)', status(() => still.validate(png(630, 1200), 'image/png')) === 422);
  ok('a 600x315 JPEG is refused (422)', status(() => still.validate(jpeg(600, 315), 'image/jpeg')) === 422);
  const big = png(1200, 630, 1200 * 630 * 3);
  ok('the oversize fixture really is over 400 KB', big.length > still.MAX_BYTES, String(big.length));
  ok('over 400 KB is refused (413)', status(() => still.validate(big, 'image/png')) === 413);
  ok('toBuffer reads a JSON round trip', still.toBuffer(JSON.parse(JSON.stringify(GOOD))).equals(GOOD));
  ok('toBuffer refuses a string', still.toBuffer('iVBORw0KGgo=') === null);

  console.log('lib/og.js');
  const hostile = '"><script>alert(1)</script><meta x=\'';
  const tagged = og.tags({ title: hostile, description: hostile + '\nline two', url: 'https://x.test/v/a"b', image: 'https://x.test/i.png"' });
  ok('titles are escaped for an attribute', !tagged.includes('<script>') && tagged.includes('&quot;&gt;&lt;script&gt;'));
  ok('every line is one well-formed tag (no quote broke out)', tagged.split('\n').every((l) =>
    /^(<title>[^<>"]*<\/title>|<meta (name|property)="[a-z:_]+" content="[^"<>]*">)$/.test(l)), tagged);
  ok('newlines inside a description are flattened', tagged.split('\n').length === 16);
  ok('summary_large_image is set', tagged.includes('twitter:card" content="summary_large_image"'));
  ok('long titles are cut', og.clean('x'.repeat(500), 110).length === 110);
  ok('bidi overrides are stripped', !og.clean('abc‮evil', 50).includes('‮'));
  ok('a sane Host becomes the origin', og.originOf({ get: () => 'dataviz.example.com', protocol: 'http' }) === 'https://dataviz.example.com');
  ok('a hostile Host falls back to the real domain', og.originOf({ get: () => 'evil.com"><script>', protocol: 'http' }) === 'https://dataviz.strongtechnicalconsulting.com');

  console.log('routes: stills');
  let r = await post('/api/auth/register', { email: 'owner@example.com', password: 'a-long-password-1' });
  const A = jar(r);
  r = await post('/api/auth/register', { email: 'stranger@example.com', password: 'a-long-password-2' });
  const S = jar(r);

  r = await post('/api/projects', { title: hostile, subtitle: 'Visits & <b>stuff</b>', viz: { type: 'bars', items: [] } }, A);
  const p1 = await r.json();
  r = await post('/api/projects', { title: 'No picture yet', viz: { type: 'bars', items: [] } }, A);
  const p2 = await r.json();
  ok('two projects saved', p1.id && p2.id && p1.shareId && p2.shareId);

  const put = (id, body, type, cookie) => fetch(B + '/api/projects/' + id + '/still', {
    method: 'PUT', headers: Object.assign({ 'content-type': type }, cookie ? { cookie } : {}), body });

  r = await put(p1.id, GOOD, 'image/png');
  ok('signed out: 401', r.status === 401, String(r.status));
  r = await put(p1.id, GOOD, 'image/png', S);
  ok("someone else's project: 404, not 403", r.status === 404, String(r.status));
  ok('...and nothing was stored', !bag().has('stills/' + p1.id) && !(bag().get('projects/' + p1.id) || {}).still);
  r = await put('nope-not-an-id', GOOD, 'image/png', A);
  ok('a project that does not exist: 404', r.status === 404);

  r = await put(p2.id, Buffer.from('<html><script>alert(1)</script></html>'), 'image/png', A);
  ok('a non-image upload: 415', r.status === 415, String(r.status));
  r = await put(p2.id, png(1200, 631), 'image/png', A);
  ok('wrong dimensions: 422', r.status === 422, String(r.status));
  r = await put(p2.id, big, 'image/png', A);
  ok('oversize: 413 ...', r.status === 413, String(r.status));
  ok('... as JSON, not an HTML error page', /json/.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
  r = await fetch(B + '/api/projects/' + p2.id + '/still', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: A }, body: JSON.stringify({ data: GOOD.toString('base64') }) });
  ok('a JSON body is not a picture: 415', r.status === 415, String(r.status));
  ok('none of the refused uploads stored anything', !bag().has('stills/' + p2.id) && !(bag().get('projects/' + p2.id) || {}).still);

  r = await put(p1.id, GOOD, 'image/png', A);
  const up = await r.json();
  ok('the owner can store a still', r.status === 200 && up.still && /^[a-f0-9]{16}$/.test(up.still.hash), JSON.stringify(up));
  const sdoc = bag().get('stills/' + p1.id);
  ok('it is kept in its own document, owned', sdoc && sdoc.ownerId === Buffer.from('owner@example.com').toString('base64url') && sdoc.width === 1200);
  ok('the project points at it (hash, not bytes)', (bag().get('projects/' + p1.id) || {}).still.hash === up.still.hash && !(bag().get('projects/' + p1.id) || {}).still.data);
  r = await fetch(B + '/api/projects', { headers: { cookie: A } });
  const list = (await r.json()).projects;
  ok('the list says which have a still', list.find((p) => p.id === p1.id).hasStill === true && list.find((p) => p.id === p2.id).hasStill === false);
  ok('the list carries no picture bytes', !JSON.stringify(list).includes('"data"'));

  r = await fetch(B + up.url);
  const served = Buffer.from(await r.arrayBuffer());
  ok('the still is served at its URL', r.status === 200 && served.equals(GOOD), String(r.status));
  ok('as image/png', r.headers.get('content-type') === 'image/png');
  ok('with nosniff', r.headers.get('x-content-type-options') === 'nosniff');
  ok('cached for a year, immutable', /max-age=31536000/.test(r.headers.get('cache-control')) && /immutable/.test(r.headers.get('cache-control')));
  ok('with a CSP that runs nothing', /default-src 'none'/.test(r.headers.get('content-security-policy') || ''));
  r = await fetch(B + '/still/' + p1.shareId + '/0123456789abcdef.png');
  ok('an old hash still answers, briefly cached', r.status === 200 && /max-age=300/.test(r.headers.get('cache-control')) && !/immutable/.test(r.headers.get('cache-control')));
  r = await fetch(B + '/still/' + p2.shareId + '/0123456789abcdef.png', { redirect: 'manual' });
  ok('a share with no still falls back to the app card', r.status === 302 && /\/og-card\.png$/.test(r.headers.get('location') || ''));
  r = await fetch(B + '/still/..%2F..%2Fetc/passwd.png', { redirect: 'manual' });
  ok('a junk share id is not looked up', r.status === 302 || r.status === 404);
  r = await fetch(B + '/og-card.png');
  const card = still.sniff(Buffer.from(await r.arrayBuffer()));
  ok('the app card itself is a 1200x630 PNG', r.status === 200 && card && card.type === 'image/png' && card.width === 1200 && card.height === 630, JSON.stringify(card));

  // JPEG replaces PNG and moves the URL
  r = await put(p1.id, GOOD_JPG, 'image/jpeg', A);
  const up2 = await r.json();
  ok('a JPEG replaces it under a new URL', r.status === 200 && up2.url !== up.url && /\.jpg$/.test(up2.url));
  r = await fetch(B + up2.url);
  ok('served as image/jpeg', r.headers.get('content-type') === 'image/jpeg');

  console.log('routes: share pages');
  r = await fetch(B + '/v/' + p1.shareId);
  let html = await r.text();
  const head = html.slice(0, html.indexOf('</head>'));
  ok('the share page is served', r.status === 200);
  ok('og:image is an absolute URL to this still', head.includes('property="og:image" content="http://127.0.0.1:9213' + up2.url + '"'), (head.match(/og:image" content="[^"]*"/) || [''])[0]);
  ok('og:image:type follows the still', head.includes('og:image:type" content="image/jpeg"'));
  ok('twitter:card summary_large_image', head.includes('name="twitter:card" content="summary_large_image"'));
  ok('the hostile title is escaped in <head>', !head.includes('<script>alert(1)') && head.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  ok('...and in <title>', /<title>&quot;&gt;&lt;script&gt;/.test(head));
  ok('the subtitle is the description, escaped', head.includes('og:description" content="Visits &amp; &lt;b&gt;stuff&lt;/b&gt;"'));
  ok('exactly one og block', (head.match(/og:image" /g) || []).length === 1);
  ok('the page itself still loads the app', html.includes('/render.js') && html.includes('id="stage"'));

  r = await fetch(B + '/v/' + p2.shareId);
  html = await r.text();
  ok('a share with no still uses the app card', html.includes('og:image" content="http://127.0.0.1:9213/og-card.png"'));
  ok('...titled with its own title', html.includes('og:title" content="No picture yet"'));
  r = await fetch(B + '/v/doesnotexist1');
  html = await r.text();
  ok('an unknown share is a 404 with the generic tags', r.status === 404 && html.includes('og-card.png') && html.includes('make your data move'));

  r = await fetch(B + '/');
  html = await r.text();
  ok('the front page carries og tags', r.status === 200 && html.includes('og:image" content="http://127.0.0.1:9213/og-card.png"') && html.includes('summary_large_image'));
  const evil = await rawGet('/', 'evil.test"><script>alert(1)</script>');
  ok('a hostile Host header never reaches the page', !evil.body.includes('<script>alert(1)') && evil.body.includes('https://dataviz.strongtechnicalconsulting.com/og-card.png'));
  r = await fetch(B + '/index.html');
  ok('/index.html still works', r.status === 200);

  console.log('routes: delete');
  r = await fetch(B + '/api/projects/' + p1.id, { method: 'DELETE', headers: { cookie: S } });
  ok("a stranger cannot delete it", r.status === 404 && bag().has('stills/' + p1.id));
  r = await fetch(B + '/api/projects/' + p1.id, { method: 'DELETE', headers: { cookie: A } });
  ok('deleting a project deletes its still', r.status === 200 && !bag().has('stills/' + p1.id));
  r = await fetch(B + up2.url, { redirect: 'manual' });
  ok('...and its URL stops serving it', r.status === 302);

  console.log('routes: plays');
  r = await fetch(B + '/api/datasets');
  let ds = (await r.json()).datasets;
  ok('every sample reports plays, starting at 0', ds.length >= 6 && ds.every((d) => d.plays === 0), JSON.stringify(ds.map((d) => d.plays)));
  r = await post('/api/datasets/city-visits/play', {});
  ok('a play is counted', (await r.json()).counted === true);
  r = await post('/api/datasets/city-visits/play', {});
  ok('the same address again is not (throttled)', (await r.json()).counted === false);
  r = await post('/api/datasets/channels/play', {});
  ok('a different sample is', (await r.json()).counted === true);
  r = await post('/api/datasets/no-such-sample/play', {});
  ok('an unknown sample is a 404', r.status === 404);
  r = await post('/api/datasets/__proto__/play', {});
  ok('a prototype key is a 404', r.status === 404);
  const counter = bag().get('counters/samples');
  ok('one counters document, incremented', counter && counter['city-visits'] === 1 && counter.channels === 1, JSON.stringify(counter));
  ok('it holds nothing but sample counts', Object.keys(counter).every((k) => ds.some((d) => d.id === k)) && Object.values(counter).every((v) => typeof v === 'number'));
  r = await fetch(B + '/api/datasets');
  ds = (await r.json()).datasets;
  ok('the gallery reads the counts back', ds.find((d) => d.id === 'city-visits').plays === 1 && ds.find((d) => d.id === 'hub-traffic').plays === 0);

  console.log('\n' + pass + '/' + (pass + fail) + ' assertions passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
