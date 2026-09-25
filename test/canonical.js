// One canonical host, the sitemap, robots.txt, and how the site is cached and
// compressed on the wire.
//
// The apex is the address; www. GETs 301 there. What must NOT move is asserted
// as carefully as what must: every app's view beacon POSTs to www/api/beacon,
// an old email's one-click unsubscribe POSTs to www/unsubscribe, and a redirect
// in front of either would lose the request without anyone noticing.
//
// Raw http throughout, because fetch will neither set Host (the entire thing
// under test) nor leave a redirect or a compressed body alone.
const h = require('./harness.js');
h.install();
const http = require('http');
const net = require('net');
const zlib = require('zlib');

const PORT = 8242;
const APEX = 'strongtechnicalconsulting.com';
const WWW = 'www.' + APEX;
process.env.IDENTITY_SESSION_SECRET = 'identity-secret-abcdefghijklmn';
process.env.SESSION_SECRET = 'landing-secret-abcdefghijklm';
process.env.ADMIN_PASSWORD = 'admin-password-here-1';
process.env.FIRESTORE_DATABASE_ID = 'eriks-projects';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.PASSKEY_RP_ID = APEX;
process.env.PORT = String(PORT);
// What production is configured with today. The links it produces must still
// come out on the apex.
process.env.SITE_ORIGIN = 'https://' + WWW;
// Mail on, into a fake Resend, so the links in real messages can be read.
process.env.RESEND_API_KEY = 're_test_key';
process.env.NEWSLETTER_FROM = 'Erik Strong <erik@' + APEX + '>';
const sent = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    const body = JSON.parse(opts.body);
    (Array.isArray(body) ? body : [body]).forEach((m) => sent.push(m));
    return new Response(JSON.stringify({ id: 'msg_' + sent.length }), { status: 200 });
  }
  return realFetch(url, opts);
};

require(require('path').join(__dirname, '..', 'server.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };

/** One request with a chosen Host, no redirect following, no decoding. */
function raw(method, path, { host = APEX, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { Host: host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
/** A request written byte for byte to a socket; the reply's head as text. */
function rawSocket(request) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, '127.0.0.1', () => sock.write(request));
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('latin1').split('\r\n\r\n')[0]));
    sock.on('error', reject);
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('socket timeout')); });
  });
}
const json = (method, path, value, opts = {}) => raw(method, path, {
  ...opts,
  headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  body: JSON.stringify(value),
});
const text = (r) => r.body.toString('utf8');

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  /* ---------- www -> apex ---------- */
  let r = await raw('GET', '/', { host: WWW, headers: { Accept: 'text/html' } });
  ok('www / is a 301', r.status === 301, String(r.status));
  ok('...to the apex', r.headers.location === `https://${APEX}/`, String(r.headers.location));
  ok('...with a bounded cache, so a mistake is not stuck in browsers forever',
    /max-age=86400/.test(r.headers['cache-control'] || ''), String(r.headers['cache-control']));

  r = await raw('GET', '/writing?utm_source=x&b=2', { host: WWW });
  ok('path and query survive the redirect', r.status === 301 && r.headers.location === `https://${APEX}/writing?utm_source=x&b=2`,
    `${r.status} ${r.headers.location}`);

  r = await raw('HEAD', '/challenge', { host: WWW });
  ok('HEAD on www redirects too', r.status === 301 && r.headers.location === `https://${APEX}/challenge`, `${r.status} ${r.headers.location}`);

  r = await raw('GET', '//evil.example/x', { host: WWW });
  ok('a path that looks like a host stays on the apex (no open redirect)',
    r.status === 301 && String(r.headers.location).startsWith(`https://${APEX}/`), String(r.headers.location));

  // Absolute-form request targets. Browsers never send them to an origin
  // server, but Node accepts them, and glued onto the origin they name another
  // host ("munity://x" -> strongtechnicalconsulting.community). Written to a
  // bare socket, since http.request is the thing that would tidy them up.
  for (const target of ['munity://x/y', 'http://evil.example/y', 'https://evil.example//x']) {
    const res = await rawSocket(`GET ${target} HTTP/1.1\r\nHost: ${WWW}\r\nConnection: close\r\n\r\n`);
    const loc = (res.match(/^location:\s*(.*)$/im) || [])[1];
    ok(`absolute-form ${target} on www never redirects off the apex`,
      /^HTTP\/1\.1 \d{3}/.test(res) && (loc === undefined || loc.trim().startsWith(`https://${APEX}/`)),
      `${res.split('\r\n')[0]} ${loc}`);
  }

  r = await raw('GET', '/sitemap.xml', { host: WWW });
  ok('www sitemap.xml redirects to the apex one', r.status === 301 && r.headers.location === `https://${APEX}/sitemap.xml`, String(r.headers.location));

  r = await raw('GET', '/', { host: 'WWW.StrongTechnicalConsulting.com' });
  ok('the host is matched case-insensitively', r.status === 301, String(r.status));

  /* ---------- what stays on www ---------- */
  r = await json('POST', '/api/beacon', { app: 'landing', path: '/', ref: '' }, { host: WWW, headers: { Origin: `https://${APEX}` } });
  ok('www POST /api/beacon is answered, not redirected', r.status === 204 && !r.headers.location, `${r.status} ${r.headers.location}`);
  ok('...with CORS for the apex page that sent it', r.headers['access-control-allow-origin'] === `https://${APEX}`, String(r.headers['access-control-allow-origin']));

  r = await raw('OPTIONS', '/api/beacon', { host: WWW, headers: { Origin: 'https://trip.' + APEX, 'Access-Control-Request-Method': 'POST' } });
  ok('the beacon preflight on www is answered too (a redirected preflight fails)', r.status === 204 && !r.headers.location, `${r.status} ${r.headers.location}`);

  r = await raw('GET', '/api/stats/public', { host: WWW, headers: { Origin: 'https://trip.' + APEX } });
  ok('www GET /api/stats/public is served, not redirected', r.status === 200 && !r.headers.location, `${r.status} ${r.headers.location}`);
  ok('...as JSON', /application\/json/.test(r.headers['content-type'] || ''), String(r.headers['content-type']));

  r = await raw('GET', '/api/health', { host: WWW });
  ok('www GET /api/health is served', r.status === 200 && text(r) === 'ok', `${r.status} ${text(r).slice(0, 40)}`);
  r = await raw('GET', '/healthz', { host: WWW });
  ok('www GET /healthz is served', r.status === 200 && text(r) === 'ok', `${r.status} ${text(r).slice(0, 40)}`);

  r = await json('POST', '/api/subscribe', { email: 'not-an-address' }, { host: WWW });
  ok('a form POST on www reaches its route (400 for a bad address, not a 301)', r.status === 400, String(r.status));

  r = await raw('POST', '/unsubscribe', {
    host: WWW, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
  });
  ok('a one-click unsubscribe POST on www reaches its route', r.status === 400 && !r.headers.location, `${r.status} ${r.headers.location}`);

  r = await raw('GET', '/robots.txt', { host: WWW });
  ok('www robots.txt is answered directly', r.status === 200, String(r.status));
  ok('...and points at the apex sitemap', text(r).includes(`Sitemap: https://${APEX}/sitemap.xml`), JSON.stringify(text(r)));

  r = await raw('GET', '/.well-known/security.txt', { host: WWW });
  ok('/.well-known/ on www is not redirected', r.status !== 301, String(r.status));

  /* ---------- the other hosts are untouched ---------- */
  r = await raw('GET', '/', { host: APEX, headers: { Accept: 'text/html' } });
  ok('the apex serves the landing page', r.status === 200, String(r.status));
  r = await raw('GET', '/', { host: 'acct.' + APEX, headers: { Accept: 'text/html' } });
  ok('the account host still serves its own page', r.status === 200 && /Your account/i.test(text(r)), String(r.status));
  r = await raw('GET', '/', { host: 'landing-page-abc123-uc.a.run.app' });
  ok('the run.app URL is served, not redirected', r.status === 200, String(r.status));
  r = await raw('GET', '/', { host: '127.0.0.1:' + PORT });
  ok('localhost is served, not redirected', r.status === 200, String(r.status));

  /* ---------- posts for the sitemap ---------- */
  r = await json('POST', '/api/admin/login', { password: process.env.ADMIN_PASSWORD });
  const cookie = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  ok('the admin signs in on the apex', r.status === 200 && /esadmin=/.test(cookie), String(r.status));
  const as = { headers: { cookie } };
  r = await json('POST', '/api/posts', { title: 'Hello sitemap', body: 'First paragraph.\n\nSecond.' }, as);
  const published = JSON.parse(text(r)).slug;
  await json('POST', `/api/posts/${published}/publish`, {}, as);
  r = await json('POST', '/api/posts', { title: 'Still a draft', body: 'Not yet.' }, as);
  const draft = JSON.parse(text(r)).slug;
  ok('a published post and a draft exist', published === 'hello-sitemap' && draft === 'still-a-draft', `${published} ${draft}`);

  /* ---------- sitemap ---------- */
  r = await raw('GET', '/sitemap.xml');
  const xml = text(r);
  ok('/sitemap.xml is served', r.status === 200, String(r.status));
  ok('...as XML', /^application\/xml/.test(r.headers['content-type'] || ''), String(r.headers['content-type']));
  ok('...in the sitemap protocol', xml.startsWith('<?xml') && xml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'), xml.slice(0, 120));
  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  for (const p of ['/', '/challenge', '/writing', '/privacy', '/terms', '/writing/hello-sitemap']) {
    ok(`...lists ${p}`, locs.includes(`https://${APEX}${p}`), locs.join(' '));
  }
  ok('...not the draft', !xml.includes('still-a-draft'));
  ok('...every URL on the apex', locs.length && locs.every((l) => l.startsWith(`https://${APEX}/`)), locs.join(' '));
  ok('...nothing from the admin or account surface', !/\/admin|\/account|acct\./.test(xml));
  ok('...the post carries a lastmod', /hello-sitemap<\/loc><lastmod>\d{4}-\d\d-\d\dT/.test(xml));
  ok('...and matches the writing index', text(await raw('GET', '/writing')).includes('hello-sitemap'));

  r = await raw('GET', '/sitemap.xml', { host: 'acct.' + APEX });
  ok('the account host has no sitemap', r.status === 404, String(r.status));

  /* ---------- robots ---------- */
  r = await raw('GET', '/robots.txt');
  ok('apex robots.txt still keeps crawlers out of /admin', /^Disallow: \/admin$/m.test(text(r)), JSON.stringify(text(r)));
  ok('...and names the sitemap', text(r).includes(`Sitemap: https://${APEX}/sitemap.xml\n`), JSON.stringify(text(r)));
  ok('...with no www address in it', !text(r).includes(WWW), JSON.stringify(text(r)));
  r = await raw('GET', '/robots.txt', { host: 'acct.' + APEX });
  ok('the account host still disallows everything', /Disallow: \/\s*$/m.test(text(r)) && !/Sitemap/.test(text(r)), JSON.stringify(text(r)));

  /* ---------- links point at the apex, even with SITE_ORIGIN on www ---------- */
  ok('SITE_ORIGIN on www is read as the apex', process.env.SITE_ORIGIN === `https://${APEX}`, process.env.SITE_ORIGIN);
  r = await raw('GET', '/feed.xml');
  const feedXml = text(r);
  const withoutGuids = feedXml.replace(/<guid\b[^>]*>[^<]*<\/guid>/g, '');
  ok('feed links are on the apex', feedXml.includes(`<link>https://${APEX}/writing/hello-sitemap</link>`) && !withoutGuids.includes(`https://${WWW}/writing`),
    feedXml.slice(0, 300));
  // A reader deduplicates on the GUID; the feed published www GUIDs, so moving
  // them to the apex would show every subscriber the whole archive as new.
  const guid = (feedXml.match(/<item>[\s\S]*?<guid\b([^>]*)>([^<]*)<\/guid>/) || []);
  ok('...but an item GUID stays the www URL it was first published with', guid[2] === `https://${WWW}/writing/hello-sitemap`, String(guid[2]));
  ok('...marked opaque rather than as the permalink', /isPermaLink="false"/.test(guid[1] || ''), String(guid[1]));
  r = await raw('GET', '/writing/hello-sitemap');
  ok('a post page does not name a www URL for itself', r.status === 200 && !text(r).includes(`https://${WWW}/writing`), String(r.status));
  ok('...and shares the 1200x630 card, not the square portrait',
    text(r).includes(`<meta property="og:image" content="https://${APEX}/assets/og-home.jpg">`)
    && text(r).includes('<meta property="og:image:width" content="1200">') && !text(r).includes('/assets/erik.jpg'),
    (text(r).match(/<meta property="og:image"[^>]*>/) || [])[0]);

  r = await raw('GET', '/challenge', { headers: { Accept: 'text/html' } });
  ok('/challenge names its apex URL as canonical', r.status === 200
    && text(r).includes(`<link rel="canonical" href="https://${APEX}/challenge" />`)
    && text(r).includes(`<meta property="og:url" content="https://${APEX}/challenge" />`), String(r.status));
  ok('...and names no www URL', !text(r).includes(WWW));

  sent.length = 0;
  r = await json('POST', '/api/subscribe', { email: 'reader@example.com' });
  ok('a signup sends a confirmation', r.status === 200 && sent.length === 1, `${r.status} ${sent.length}`);
  const confirm = sent[0] || {};
  const confirmText = `${confirm.html || ''}\n${confirm.text || ''}\n${JSON.stringify(confirm.headers || {})}`;
  ok('...whose links are on the apex', confirmText.includes(`https://${APEX}/subscribe/confirm?t=`) && confirmText.includes(`https://${APEX}/unsubscribe?t=`),
    confirmText.slice(0, 200));
  ok('...and never on www', !confirmText.includes(WWW));

  r = await json('POST', '/api/id/register', { email: 'forgetful@example.com', password: 'a-long-password-1' });
  ok('an account registers', r.status === 200, String(r.status));
  sent.length = 0;
  r = await json('POST', '/api/id/reset/request', { email: 'forgetful@example.com' });
  const resetMail = sent.find((m) => /reset\?t=/.test(`${m.html}${m.text}`)) || {};
  const resetText = `${resetMail.html || ''}\n${resetMail.text || ''}`;
  ok('a reset request sends a link on the apex', resetText.includes(`https://${APEX}/reset?t=`), resetText.slice(0, 200) || `${sent.length} sent`);
  ok('...and not on www', resetText && !resetText.includes(WWW));

  /* ---------- compression ---------- */
  r = await raw('GET', '/', { headers: { 'Accept-Encoding': 'br' } });
  ok('the landing page goes out brotli-compressed when asked', r.headers['content-encoding'] === 'br', String(r.headers['content-encoding']));
  ok('...and decodes to the page', /<html/i.test(zlib.brotliDecompressSync(r.body).toString()));
  ok('...varying on Accept-Encoding', /accept-encoding/i.test(r.headers.vary || ''), String(r.headers.vary));
  r = await raw('GET', '/', { headers: { 'Accept-Encoding': 'gzip' } });
  ok('...gzip when that is all the client takes', r.headers['content-encoding'] === 'gzip', String(r.headers['content-encoding']));
  ok('...and decodes to the page', /<html/i.test(zlib.gunzipSync(r.body).toString()));
  const plain = await raw('GET', '/');
  ok('...and plain when the client asks for nothing', !plain.headers['content-encoding'] && /<html/i.test(text(plain)), String(plain.headers['content-encoding']));
  ok('compressed is actually smaller', r.body.length < plain.body.length, `${r.body.length} vs ${plain.body.length}`);

  r = await raw('GET', '/assets/reader.css', { headers: { 'Accept-Encoding': 'gzip, br' } });
  ok('CSS is compressed', r.headers['content-encoding'] === 'br', String(r.headers['content-encoding']));
  r = await raw('GET', '/writing', { headers: { 'Accept-Encoding': 'gzip' } });
  ok('server-rendered HTML is compressed', r.headers['content-encoding'] === 'gzip', String(r.headers['content-encoding']));
  r = await raw('GET', '/assets/erik.jpg', { headers: { 'Accept-Encoding': 'gzip, br' } });
  ok('a JPEG is left alone (already compressed)', r.status === 200 && !r.headers['content-encoding'], String(r.headers['content-encoding']));
  r = await json('POST', '/api/beacon', { app: 'landing', path: '/' }, { headers: { 'Accept-Encoding': 'gzip' } });
  ok('the beacon still answers 204 with compression on', r.status === 204, String(r.status));

  /* ---------- caching ---------- */
  r = await raw('GET', '/assets/erik.jpg');
  ok('images under /assets keep for a week', r.headers['cache-control'] === 'public, max-age=604800', String(r.headers['cache-control']));
  ok('...with an ETag', Boolean(r.headers.etag));
  const etag = r.headers.etag;
  r = await raw('GET', '/assets/erik.jpg', { headers: { 'If-None-Match': etag } });
  ok('...that revalidates to a 304', r.status === 304, String(r.status));
  r = await raw('GET', '/assets/favicon.svg');
  ok('SVGs under /assets keep for a week too', r.headers['cache-control'] === 'public, max-age=604800', String(r.headers['cache-control']));
  r = await raw('GET', '/assets/reader.css');
  ok('CSS stays short, since it changes with the HTML', r.headers['cache-control'] === 'public, max-age=300', String(r.headers['cache-control']));
  r = await raw('GET', '/', { headers: { 'Accept-Encoding': 'gzip' } });
  ok('the landing HTML stays at five minutes', r.headers['cache-control'] === 'public, max-age=300', String(r.headers['cache-control']));
  ok('...with an ETag through compression', Boolean(r.headers.etag), String(r.headers.etag));
  r = await raw('GET', '/', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': r.headers.etag } });
  ok('...that revalidates to a 304', r.status === 304, String(r.status));
  r = await raw('GET', '/privacy', { headers: { Accept: 'text/html' } });
  ok('other pages stay short as well', r.status === 200 && r.headers['cache-control'] === 'public, max-age=300', `${r.status} ${r.headers['cache-control']}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
