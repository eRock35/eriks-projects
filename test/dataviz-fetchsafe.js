// DataViz's URL fetcher is the path from a public text box to the metadata
// server, so its guard is tested with the spellings an attacker would use
// (2026-09-27): IPv4 addresses written as IPv6 (mapped, NAT64, compatible,
// 6to4), the same in a redirect's Location, and a name whose DNS answer
// changes between the check and the connection.
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { Readable } = require('stream');
const fs = require(path.join(__dirname, '..', 'apps', 'dataviz', 'lib', 'fetchsafe.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };

const reply = (status, headers, body = '') => ({ status, headers, body: Readable.from([Buffer.from(body)]) });

async function refused(fetcher, url) {
  try { await fetcher.fetchText(url); return null; } catch (e) { return e; }
}

(async () => {
  /* ---------- addresses ---------- */
  const blocked = [
    '169.254.169.254', '127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1',
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:a9fe:a9fe', '[::ffff:a9fe:a9fe]',
    '64:ff9b::a9fe:a9fe', '64:ff9b::169.254.169.254', '::a9fe:a9fe', '::169.254.169.254', '::7f00:1',
    '2002:a9fe:a9fe::1',
  ];
  for (const a of blocked) ok(`${a} is refused`, fs.addressBlocked(a) === true);
  for (const a of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:808:808']) {
    ok(`${a} is allowed`, fs.addressBlocked(a) === false);
  }
  ok('the metadata address is unwrapped from its mapped form', fs.embeddedV4('::ffff:a9fe:a9fe') === '169.254.169.254');

  /* ---------- literal URLs never reach the network ---------- */
  let requests = 0;
  let resolves = 0;
  const publicDns = async () => { resolves++; return [{ address: '93.184.216.34', family: 4 }]; };
  const fetcher = fs.createFetcher({
    resolve: publicDns,
    request: async () => { requests++; return reply(200, { 'content-type': 'text/plain' }, 'a,b\n1,2'); },
  });
  for (const u of [
    'http://[::ffff:a9fe:a9fe]/computeMetadata/v1/',
    'http://[::ffff:169.254.169.254]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[::a9fe:a9fe]/',
    'http://169.254.169.254/',
    'http://[::1]:8080/',
    'http://localhost/',
    'http://metadata.google.internal/computeMetadata/v1/',
  ]) {
    const e = await refused(fetcher, u);
    ok(`${u} is refused`, e && e.status === 400, e ? e.message : 'fetched');
  }
  ok('...and none of them made a request', requests === 0, String(requests));

  const good = await fetcher.fetchText('https://example.com/data.csv');
  ok('a public address is fetched', good.text === 'a,b\n1,2' && requests === 1, JSON.stringify(good));

  /* ---------- redirects are re-checked, in every spelling ---------- */
  for (const loc of ['http://[::ffff:a9fe:a9fe]/', 'http://[64:ff9b::a9fe:a9fe]/latest/meta-data/', 'http://[::a9fe:a9fe]/', 'http://169.254.169.254/']) {
    let n = 0;
    const f = fs.createFetcher({
      resolve: publicDns,
      request: async () => { n++; return reply(302, { location: loc }); },
    });
    const e = await refused(f, 'https://example.com/start');
    ok(`a redirect to ${loc} is refused`, e && e.status === 400 && n === 1, e ? `${e.message} after ${n}` : 'followed');
  }

  /* ---------- DNS: every answer checked, the checked one used ---------- */
  let seen = null;
  const rebinding = (() => {
    let calls = 0;
    return async () => { calls++; return calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '169.254.169.254', family: 4 }]; };
  })();
  const f2 = fs.createFetcher({
    resolve: rebinding,
    request: async (_url, where) => { seen = where.address; return reply(200, { 'content-type': 'text/plain' }, 'ok'); },
  });
  await f2.fetchText('https://rebind.example/');
  ok('the connection is made to the address that was checked', seen === '93.184.216.34', String(seen));
  const mixed = fs.createFetcher({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
    request: async () => { throw new Error('should not connect'); },
  });
  let e = await refused(mixed, 'https://mixed.example/');
  ok('one private answer among public ones is refused', e && e.status === 400, e && e.message);
  const mapped = fs.createFetcher({
    resolve: async () => [{ address: '::ffff:a9fe:a9fe', family: 6 }],
    request: async () => { throw new Error('should not connect'); },
  });
  e = await refused(mapped, 'https://aaaa.example/');
  ok('a AAAA answer holding the metadata address is refused', e && e.status === 400, e && e.message);

  // The real transport: the socket's lookup answers with the pinned address,
  // so a name that does not resolve at all is still reached - proof DNS is
  // not asked again.
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end('host=' + req.headers.host); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const got = await fs.pinnedGet(new URL(`http://no-such-host.invalid:${port}/x`), { address: '127.0.0.1', family: 4, headers: {} });
  let body = '';
  for await (const c of got.body) body += c;
  ok('the transport connects to the pinned address, not a fresh lookup', got.status === 200 && body === `host=no-such-host.invalid:${port}`, body);
  srv.close();

  /* ---------- bodies ---------- */
  const gz = zlib.gzipSync(Buffer.from('x,y\n3,4'));
  const f3 = fs.createFetcher({
    resolve: publicDns,
    request: async () => ({ status: 200, headers: { 'content-type': 'text/csv', 'content-encoding': 'gzip' }, body: Readable.from([gz]) }),
  });
  ok('a gzipped body is read', (await f3.fetchText('https://example.com/z')).text === 'x,y\n3,4');
  const huge = Buffer.alloc(fs.MAX_BYTES + 1000, 97);
  const f4 = fs.createFetcher({ resolve: publicDns, request: async () => ({ status: 200, headers: {}, body: Readable.from([huge]) }) });
  ok('a body is cut at the ceiling', (await f4.fetchText('https://example.com/big')).text.length === fs.MAX_BYTES);
  e = await refused(fs.createFetcher({ resolve: publicDns, request: async () => reply(200, { 'content-length': String(fs.MAX_BYTES + 1) }) }), 'https://example.com/big');
  ok('...and a declared oversize is refused', e && e.status === 400);
  e = await refused(fetcher, 'ftp://example.com/');
  ok('only http and https', e && e.status === 400);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
