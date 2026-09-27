// Fetching a URL a stranger typed, from inside Google's network.
//
// This is the single most dangerous thing this app does. Cloud Run instances
// can reach the GCP metadata server at 169.254.169.254, which will hand out
// an access token for the runtime service account to anyone who asks from
// inside. An unguarded "paste a URL and I'll read it" feature is therefore a
// direct path from a text box on the public internet to this project's
// credentials.
//
// So: resolve the hostname ourselves, refuse anything that resolves into a
// private, loopback, link-local or otherwise internal range, CONNECT TO THE
// ADDRESS THAT WAS CHECKED, and re-check on every redirect hop - because a
// public hostname can redirect to a private one. Redirects are followed
// manually for exactly that reason.
//
// Two holes closed on 2026-09-27, both ported from Tells' linkfetch.js:
//
//  - IPv6 spellings of an IPv4 address. The URL parser rewrites
//    [::ffff:169.254.169.254] as [::ffff:a9fe:a9fe], which the old dotted-only
//    check never matched, so the metadata server was one bracketed literal
//    away. NAT64 (64:ff9b::/96), IPv4-compatible (::a.b.c.d) and 6to4
//    (2002::/16) forms are unwrapped too and judged as the IPv4 inside. Node's
//    BlockList treats ::ffff:0:0/96 as every IPv4 address, so the mapped range
//    is unwrapped by embeddedV4() rather than listed.
//  - DNS rebinding. The check resolved the name, then fetch() resolved it
//    AGAIN to connect, and a name with a short TTL can answer "public" to the
//    first and "169.254.169.254" to the second. The socket's `lookup` is now
//    pinned to the address that passed, so no second answer is ever used.

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 12000;
const USER_AGENT = 'dataviz/1.0 (+https://strongtechnicalconsulting.com)';

const refuse = (message) => Object.assign(new Error(message), { status: 400 });
const UNREACHABLE = 'That address is not reachable from here.';

/* ---------------- addresses ---------------- */

const BLOCK = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, incl. GCP metadata
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // documentation
  ['192.88.99.0', 24],   // 6to4 relay
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // documentation
  ['203.0.113.0', 24],   // documentation
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, broadcast
]) BLOCK.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 96],            // unspecified, loopback and IPv4-compatible (deprecated)
  ['64:ff9b::', 96],     // NAT64
  ['64:ff9b:1::', 48],   // local-use NAT64
  ['100::', 64],         // discard
  ['2001::', 32],        // Teredo
  ['2001:db8::', 32],    // documentation
  ['2002::', 16],        // 6to4
  ['fc00::', 7],         // unique local
  ['fe80::', 10],        // link-local
  ['fec0::', 10],        // site-local (deprecated)
  ['ff00::', 8],         // multicast
]) BLOCK.addSubnet(a, p, 'ipv6');

const hexPair = (hi, lo) => {
  const a = parseInt(hi, 16), b = parseInt(lo, 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
};

/** The IPv4 address an IPv6 one carries (mapped, NAT64, IPv4-compatible,
 *  6to4), or null. */
function embeddedV4(v6) {
  // Canonical form first (the URL parser compresses and lower-cases), so
  // 0:0:0:0:0:ffff:a9fe:a9fe reads the same as ::ffff:a9fe:a9fe.
  let s = String(v6).toLowerCase();
  try { s = new URL(`http://[${s}]/`).hostname.replace(/^\[|\]$/g, ''); } catch (e) { /* keep as given */ }
  let m = s.match(/^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  m = s.match(/^(?:::ffff:|64:ff9b::|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) return hexPair(m[1], m[2]);
  m = s.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  if (m) return hexPair(m[1], m[2]);
  return null;
}

/** True when this address must not be fetched from here. */
function addressBlocked(ip) {
  const a = String(ip || '').replace(/^\[|\]$/g, '').split('%')[0];
  const kind = net.isIP(a);
  if (kind === 4) return BLOCK.check(a, 'ipv4');
  if (kind === 6) {
    const inner = embeddedV4(a);
    if (inner && BLOCK.check(inner, 'ipv4')) return true;
    return BLOCK.check(a, 'ipv6');
  }
  return true;
}

// Names that only mean something inside a network. They would resolve to a
// blocked address anyway; refusing them by name costs nothing.
const LOCAL_NAME = /(^|\.)(localhost|internal|local|localdomain|home\.arpa)$/i;

async function systemResolve(host) {
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

/**
 * Check a host and return the address to connect to.
 * @returns {address, family}
 */
async function assertPublic(rawHost, resolve = systemResolve) {
  // URL keeps an IPv6 literal in brackets; strip them so it is recognised as
  // an address rather than falling through to a DNS lookup.
  const hostname = String(rawHost).replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  // A literal IP skips DNS entirely and must still be judged.
  if (net.isIP(hostname)) {
    if (addressBlocked(hostname)) throw refuse(UNREACHABLE);
    return { address: hostname, family: net.isIP(hostname) };
  }
  if (!hostname || LOCAL_NAME.test(hostname) || hostname === 'metadata') throw refuse(UNREACHABLE);
  let records;
  try {
    records = await resolve(hostname);
  } catch (e) {
    throw refuse('That hostname could not be resolved.');
  }
  const list = (Array.isArray(records) ? records : [records]).filter((r) => r && r.address);
  if (!list.length) throw refuse('That hostname could not be resolved.');
  // EVERY address must be public. One private answer is enough to refuse.
  for (const r of list) {
    if (addressBlocked(r.address)) throw refuse(UNREACHABLE);
  }
  return { address: list[0].address, family: net.isIP(list[0].address) || list[0].family || 4 };
}

/* ---------------- the transport ---------------- */

/** One GET to an address already checked. The socket's `lookup` answers with
 *  that address and nothing else, so DNS is never asked a second time. */
function pinnedGet(url, { address, family, headers, signal }) {
  const lib = url.protocol === 'https:' ? https : http;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method: 'GET',
      hostname: host,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, Host: url.host },
      servername: net.isIP(host) ? undefined : host,
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
      signal,
    }, (res) => resolve({ status: res.statusCode, headers: res.headers, body: res }));
    req.on('error', reject);
    req.end();
  });
}

function destroy(s) { try { if (s && s.destroy) s.destroy(); } catch (e) { /* gone */ } }

/** Read with a ceiling (after decompression), never trusting the declared
 *  length. Over the ceiling, what arrived so far is kept, as before. */
async function readCapped(res) {
  const declared = Number(res.headers['content-length'] || 0);
  if (declared && declared > MAX_BYTES) { destroy(res.body); throw refuse('That page is too large to read.'); }
  const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
  let stream = res.body;
  if (enc === 'gzip' || enc === 'x-gzip') stream = res.body.pipe(zlib.createGunzip());
  else if (enc === 'deflate') stream = res.body.pipe(zlib.createInflate());
  else if (enc === 'br') stream = res.body.pipe(zlib.createBrotliDecompress());
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > MAX_BYTES) {
      chunks.push(Buffer.from(chunk).subarray(0, chunk.length - (total - MAX_BYTES)));
      destroy(res.body); destroy(stream);
      break;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param opts.resolve  (host) => [{address, family}]   tests fake DNS here
 * @param opts.request  (url, {address, family, headers, signal}) =>
 *                      {status, headers, body}           and the socket here
 */
function createFetcher(opts = {}) {
  const resolve = opts.resolve || systemResolve;
  const request = opts.request || pinnedGet;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;

  /** Fetch a public URL as text, with redirects checked at every hop. */
  async function fetchText(rawUrl) {
    let url;
    try { url = new URL(String(rawUrl).trim()); } catch (e) { throw refuse('That is not a valid URL.'); }

    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw refuse('Only http and https addresses work here.');
        }
        if (url.username || url.password) throw refuse('Links with a username or password in them are not fetched.');
        const where = await assertPublic(url.hostname, resolve);

        let res;
        try {
          res = await request(url, {
            ...where,
            signal: ctl.signal,
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'text/html,application/json,text/csv,text/plain;q=0.9,*/*;q=0.8',
              'Accept-Encoding': 'gzip, deflate, br',
            },
          });
        } catch (err) {
          if (err && err.status) throw err;
          throw refuse(timedOut ? 'That page took too long to answer.' : 'That page could not be reached.');
        }

        const location = res.headers.location;
        if (res.status >= 300 && res.status < 400 && location) {
          destroy(res.body);
          try { url = new URL(String(location), url); } catch (e) { throw refuse('That page sent a broken redirect.'); }
          continue;   // re-checked, and re-pinned, at the top of the loop
        }
        if (res.status < 200 || res.status >= 300) {
          destroy(res.body);
          throw refuse(`That page returned ${res.status}.`);
        }
        let text;
        try {
          text = await readCapped(res);
        } catch (err) {
          if (err && err.status) throw err;
          throw refuse(timedOut ? 'That page took too long to answer.' : 'That page could not be read.');
        }
        return { url: url.toString(), contentType: String(res.headers['content-type'] || ''), text };
      }
      throw refuse('That address redirected too many times.');
    } finally {
      clearTimeout(timer);
    }
  }

  return { fetchText };
}

const defaultFetcher = createFetcher();

module.exports = {
  fetchText: (url) => defaultFetcher.fetchText(url),
  createFetcher,
  pinnedGet,
  addressBlocked,
  assertPublic,
  embeddedV4,
  MAX_BYTES,
};
