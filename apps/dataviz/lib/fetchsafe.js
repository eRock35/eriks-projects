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
// private, loopback, link-local or otherwise internal range, and re-check on
// every redirect hop - because a public hostname can redirect to a private
// one, and a DNS record can change between the check and the connection.
// Redirects are followed manually for exactly that reason.

const dns = require('dns').promises;
const net = require('net');

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 12000;

function ipv4Blocked(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 0) return true;                        // "this network"
  if (a === 10) return true;                       // private
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local, incl. GCP metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true;         // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true;           // IETF protocol assignments
  if (a >= 224) return true;                       // multicast, reserved, broadcast
  return false;
}

function ipv6Blocked(ip) {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;              // unspecified, loopback
  if (v.startsWith('fe80')) return true;                   // link-local
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique local
  if (v.startsWith('ff')) return true;                     // multicast
  // IPv4-mapped (::ffff:a.b.c.d) must be judged by its IPv4 rules.
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  return false;
}

function addressBlocked(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4Blocked(ip);
  if (kind === 6) return ipv6Blocked(ip);
  return true;
}

async function assertPublic(rawHost) {
  // URL keeps an IPv6 literal in brackets; strip them so it is recognised as
  // an address rather than falling through to a DNS lookup that happens to
  // fail. It was blocked either way, but for the wrong reason.
  const hostname = String(rawHost).replace(/^\[(.*)\]$/, '$1');
  // A literal IP skips DNS entirely and must still be judged.
  if (net.isIP(hostname)) {
    if (addressBlocked(hostname)) throw Object.assign(new Error('That address is not reachable from here.'), { status: 400 });
    return;
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw Object.assign(new Error('That hostname could not be resolved.'), { status: 400 });
  }
  if (!records.length) throw Object.assign(new Error('That hostname could not be resolved.'), { status: 400 });
  // EVERY address must be public. One private answer is enough to refuse.
  for (const r of records) {
    if (addressBlocked(r.address)) throw Object.assign(new Error('That address is not reachable from here.'), { status: 400 });
  }
}

/** Fetch a public URL as text, with redirects checked at every hop. */
async function fetchText(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl).trim()); } catch (e) { throw Object.assign(new Error('That is not a valid URL.'), { status: 400 }); }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw Object.assign(new Error('Only http and https addresses work here.'), { status: 400 });
    }
    await assertPublic(url.hostname);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url.toString(), {
        redirect: 'manual', // followed by hand so each hop is re-checked
        signal: ctl.signal,
        headers: {
          'User-Agent': 'dataviz/1.0 (+https://strongtechnicalconsulting.com)',
          Accept: 'text/html,application/json,text/csv,text/plain;q=0.9,*/*;q=0.8',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`That page returned ${res.status}.`), { status: 400 });

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > MAX_BYTES) throw Object.assign(new Error('That page is too large to read.'), { status: 400 });

    // Read with a ceiling rather than trusting the declared length.
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) {
      const text = await res.text();
      return { url: url.toString(), contentType: res.headers.get('content-type') || '', text: text.slice(0, MAX_BYTES) };
    }
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { try { await reader.cancel(); } catch (e) {} break; }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    return { url: url.toString(), contentType: res.headers.get('content-type') || '', text };
  }
  throw Object.assign(new Error('That address redirected too many times.'), { status: 400 });
}

module.exports = { fetchText, addressBlocked, assertPublic, MAX_BYTES };
