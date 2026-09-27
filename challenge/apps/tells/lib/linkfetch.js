// Fetching a link someone asked Tells to check - without letting that link
// point our server at anything it should not reach.
//
// The rules, each enforced here rather than trusted to a caller:
//
//   - https only, port 443 only, no user:password@ in the URL. Plain http is
//     refused and the page says so: a check over http could be altered on the
//     way, and a server that follows http links is easier to aim inward.
//   - The host is resolved HERE, every address it resolves to is checked, and
//     the connection is pinned to the address that was checked (the socket's
//     `lookup` returns it), so a DNS answer that changes between the check and
//     the connect ("rebinding") cannot slip a private address in. If ANY
//     address is private the host is refused.
//   - Refused: loopback, private (RFC 1918), carrier-grade NAT, link-local
//     (169.254.0.0/16, which holds the cloud metadata server at
//     169.254.169.254), multicast, reserved, documentation and benchmark
//     ranges; IPv6 loopback, unspecified, unique-local, link-local, site-local,
//     multicast, and IPv4-mapped / NAT64 / 6to4 / Teredo forms (checked as the
//     IPv4 address inside where there is one). Names that only mean something
//     inside a network are refused before any lookup: localhost,
//     metadata.google.internal and anything under .internal, .local,
//     .localhost, .lan, .home, .corp, single-label names.
//   - Every redirect goes back through all of the above. At most 3.
//   - 8 seconds for the whole thing, 2 MB of body for a page (8 MB for an
//     image), counted as it arrives (a lying Content-Length changes nothing),
//     and after decompression. Only text/html, application/xhtml+xml and
//     text/plain for a page; only image types for an image.
//   - An identifying User-Agent, so a site can see who is asking and why.
//
// Nothing fetched is stored or logged. The page's text goes back to the
// person who asked, once.

const dns = require('dns');
const net = require('net');
const https = require('https');
const zlib = require('zlib');

const USER_AGENT = 'TellsBot/1.0 (+https://challenge.strongtechnicalconsulting.com/tells/; fetches one page a person asked to check)';
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const PAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_BYTES = 8 * 1024 * 1024;
const PAGE_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/avif'];

function fail(status, message, code) {
  return Object.assign(new Error(message), { status, expose: true, code });
}

/* ---------------- addresses ---------------- */

const BLOCK = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCK.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  // Not ::ffff:0:0/96 here: Node's BlockList treats that range as every IPv4
  // address. Mapped forms are unwrapped by embeddedV4() and checked as v4.
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCK.addSubnet(a, p, 'ipv6');

/** The IPv4 address an IPv6 one carries (mapped, NAT64, 6to4), or null. */
function embeddedV4(v6) {
  // Canonical form first (the URL parser compresses and lower-cases), so
  // 0:0:0:0:0:ffff:7f00:1 is read the same as ::ffff:7f00:1.
  let s = v6.toLowerCase();
  try { s = new URL(`https://[${s}]/`).hostname.replace(/^\[|\]$/g, ''); } catch (e) { /* keep as given */ }
  let m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || s.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  m = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/) || s.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) { const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16); return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }
  m = s.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  if (m) { const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16); return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }
  return null;
}

/** True when our server may connect to this address. */
function addressAllowed(address) {
  const a = String(address || '').replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(a);
  if (!family) return false;
  if (family === 4) return !BLOCK.check(a, 'ipv4');
  const inner = embeddedV4(a);
  if (inner && BLOCK.check(inner, 'ipv4')) return false;
  return !BLOCK.check(a, 'ipv6');
}

const LOCAL_SUFFIX = /(^|\.)(localhost|local|internal|lan|home|corp|intranet|localdomain|home\.arpa|in-addr\.arpa|ip6\.arpa)$/i;

/** A URL we are willing to try, as a URL object; throws a 400 otherwise. */
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { throw fail(400, 'That is not a web address. Paste a full link starting with https://', 'bad-url'); }
  if (u.protocol === 'http:') throw fail(400, 'Tells only fetches https:// links. Try the https:// version of this page, or paste its text.', 'https-only');
  if (u.protocol !== 'https:') throw fail(400, 'Tells only fetches https:// links.', 'https-only');
  if (u.username || u.password) throw fail(400, 'Links with a username or password in them are not fetched.', 'bad-url');
  if (u.port && u.port !== '443') throw fail(400, 'Tells only fetches links on the standard https port.', 'bad-url');
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  if (!host || host.length > 253) throw fail(400, 'That link has no usable host.', 'bad-url');
  const literal = host.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) {
    if (!addressAllowed(literal)) throw fail(400, 'That address is on a private or reserved network, so Tells will not fetch it.', 'private-address');
  } else if (!host.includes('.') || LOCAL_SUFFIX.test(host) || host === 'metadata.google.internal' || host === 'metadata') {
    throw fail(400, 'That address is on a private or reserved network, so Tells will not fetch it.', 'private-address');
  }
  u.hash = '';
  if (u.href.length > 2048) throw fail(400, 'That link is too long.', 'bad-url');
  return u;
}

async function systemResolve(host) {
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

/* ---------------- the transport ---------------- */

/** One HTTPS GET to an address we already checked. The socket's `lookup` is
 *  pinned to that address, so no second DNS answer is ever used. */
function httpsGet(url, { address, family, headers, signal }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'GET',
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      headers,
      servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
      signal,
    }, (res) => resolve({ status: res.statusCode, headers: res.headers, body: res }));
    req.on('error', reject);
    req.end();
  });
}

/* ---------------- reading a body ---------------- */

async function readBody(res, max) {
  const len = Number(res.headers['content-length'] || 0);
  if (len && len > max) { destroy(res.body); throw fail(413, 'That page is too large to check (over 2 MB).', 'too-large'); }
  const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
  let stream = res.body;
  if (enc === 'gzip' || enc === 'x-gzip') stream = res.body.pipe(zlib.createGunzip());
  else if (enc === 'deflate') stream = res.body.pipe(zlib.createInflate());
  else if (enc === 'br') stream = res.body.pipe(zlib.createBrotliDecompress());
  const parts = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > max) { destroy(res.body); destroy(stream); throw fail(413, `That is too large to check (over ${Math.round(max / 1048576)} MB).`, 'too-large'); }
      parts.push(Buffer.from(chunk));
    }
  } catch (err) {
    if (err && err.expose) throw err;
    throw fail(502, 'The page could not be read.', 'read');
  }
  return Buffer.concat(parts);
}
function destroy(s) { try { if (s && s.destroy) s.destroy(); } catch (e) { /* gone */ } }

function charsetOf(type) {
  const m = String(type || '').match(/charset\s*=\s*"?([\w-]+)/i);
  return m ? m[1].toLowerCase() : null;
}
function decode(buf, type) {
  let cs = charsetOf(type);
  if (!cs) {
    const head = buf.subarray(0, 2048).toString('latin1');
    const m = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i);
    cs = m ? m[1].toLowerCase() : 'utf-8';
  }
  try { return new TextDecoder(cs).decode(buf); } catch (e) { return new TextDecoder('utf-8').decode(buf); }
}

/* ---------------- the fetcher ---------------- */

/**
 * @param opts.resolve  (host) => [{address, family}]   (tests fake DNS here)
 * @param opts.request  (url, {address, family, headers, signal}) => {status, headers, body}
 */
function createFetcher(opts = {}) {
  const resolve = opts.resolve || systemResolve;
  const request = opts.request || httpsGet;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;

  async function pin(url) {
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal)) return { address: literal, family: net.isIP(literal) };
    let found;
    try { found = await resolve(url.hostname); } catch (e) { throw fail(422, 'That site’s name could not be found.', 'dns'); }
    const list = (Array.isArray(found) ? found : [found]).filter((x) => x && x.address);
    if (!list.length) throw fail(422, 'That site’s name could not be found.', 'dns');
    if (list.some((x) => !addressAllowed(x.address))) {
      throw fail(400, 'That site points at a private or reserved network, so Tells will not fetch it.', 'private-address');
    }
    return { address: list[0].address, family: net.isIP(list[0].address) || list[0].family || 4 };
  }

  /**
   * GET a URL through every guard.
   * @param kind 'page' | 'image'
   * @returns {url (final), type, bytes (Buffer), text (pages)}
   */
  async function get(raw, kind = 'page') {
    const types = kind === 'image' ? IMAGE_TYPES : PAGE_TYPES;
    const max = kind === 'image' ? IMAGE_BYTES : PAGE_BYTES;
    const controller = new AbortController();
    let timedOut = false;
    // A timer inside the request, cleared before the response: nothing runs
    // after we answer.
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      let url = checkUrl(raw);
      for (let hop = 0; ; hop++) {
        const where = await pin(url);
        let res;
        try {
          res = await request(url, {
            ...where,
            signal: controller.signal,
            headers: {
              'User-Agent': USER_AGENT,
              Accept: kind === 'image' ? 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8' : 'text/html,application/xhtml+xml,text/plain;q=0.9',
              'Accept-Encoding': 'gzip, deflate, br',
              'Accept-Language': 'en;q=0.9, *;q=0.5',
            },
          });
        } catch (err) {
          if (timedOut) throw fail(504, 'The site took too long to answer (8 seconds).', 'timeout');
          if (err && err.expose) throw err;
          throw fail(502, 'The site could not be reached.', 'connect');
        }
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          destroy(res.body);
          if (hop >= MAX_REDIRECTS) throw fail(422, 'That link redirects too many times.', 'redirects');
          const loc = res.headers.location;
          if (!loc) throw fail(502, 'The site sent a redirect with nowhere to go.', 'redirects');
          let next;
          try { next = new URL(String(loc), url); } catch (e) { throw fail(502, 'The site sent a broken redirect.', 'redirects'); }
          url = checkUrl(next.href);
          continue;
        }
        if (res.status < 200 || res.status >= 300) {
          destroy(res.body);
          const walled = res.status === 401 || res.status === 403 || res.status === 999;
          throw fail(walled ? 422 : 502, walled ? 'That site refused to show the page to a server (it may need a sign-in).' : `The site answered with an error (${res.status}).`, walled ? 'walled' : 'status');
        }
        const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!types.includes(type)) {
          destroy(res.body);
          throw fail(415, kind === 'image' ? 'That link is not a picture Tells can read.' : 'That link is not a web page Tells can read (it is not HTML or plain text).', 'content-type');
        }
        const bytes = await readBody(res, max);
        return { url: url.href, type, bytes, text: kind === 'page' ? decode(bytes, res.headers['content-type']) : null };
      }
    } catch (err) {
      if (timedOut && !(err && err.code === 'timeout')) throw fail(504, 'The site took too long to answer (8 seconds).', 'timeout');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return { get, checkUrl, pin };
}

module.exports = { createFetcher, checkUrl, addressAllowed, embeddedV4, USER_AGENT, PAGE_BYTES, IMAGE_BYTES, TIMEOUT_MS, MAX_REDIRECTS };
