// Tells: pure checks first, then end to end against the memory store and the
// fake model:
//   TELLS_MEMORY=1 TELLS_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /tells, the way the
// lab mounts it, so the cookie, the device keys, the budget gate, the body
// parsers and the streamed answers are exercised as deployed. Model calls
// are counted from the identity's usage rows - the rows that bill a real
// account. DNS and the network are faked for link fetching: the sandbox
// cannot reach the web, and a test must never depend on it.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { Readable } = require('stream');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.TELLS_MEMORY !== '1' || process.env.TELLS_FAKE_AI !== '1') {
  console.error('run with TELLS_MEMORY=1 TELLS_FAKE_AI=1');
  process.exit(1);
}
process.env.DAILY_CAP_CACHE_MS = '0';

const ROOT = path.join(__dirname, '..');
const { app, identityStore, store, setFetcher } = require('../server');
const Core = require('../public/tells-core');
const Meta = require('../public/tells-meta');
const ai = require('../lib/ai');
const F = require('./fixtures');
const LF = require('../lib/linkfetch');
const { extract } = require('../lib/extract');
const BM = require('../lib/bookmarklet');
const EXT = require('../scripts/extension');
const { samples, TEMPLATED, HUMAN } = require('../lib/samples');
const devicesLib = require('../lib/devices');

let base;
function client() {
  const cookies = {};
  const call = async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) { data = { text }; }
    return { status: res.status, data, text, headers: res.headers };
  };
  call.cookie = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  return call;
}
const uidOf = (email) => Buffer.from(email).toString('base64url');
const usage = async () => identityStore.list('usage');
const modelCalls = async () => (await usage()).length;
const settle = () => new Promise((r) => setTimeout(r, 20)); // the meter writes usage rows fire-and-forget
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const FORMAL = 'The committee reviewed the proposal in detail. It is important to note that the budget, the timeline and the staffing plan were each examined against the department’s current obligations. The findings underscore the need for a robust review process. Furthermore, the committee recommends that the proposal be resubmitted with a revised timeline, a clearer budget and additional staffing detail before the next meeting of the board.';
const CASUAL = 'ok so the dishwasher died again lol. third time since march. i called the guy and he said maybe thursday?? which means friday which means next week tbh. anyway we are doing dishes by hand like its 1952, kids think its hilarious for about four minutes and then they vanish. if anyone knows a repair person in the north end who actually shows up, pls send them my way. will pay in cookies. or money. probably money';
const VERDICT = /\b(is|was) (AI|fake)\b|written by AI|\bfake\b/i;

/* ================================================================== *
 * Pure: the quick scan
 * ================================================================== */

test('quick scan: casual human text scores low, the templated post high', () => {
  const human = Core.scan(CASUAL);
  const bro = Core.scan(TEMPLATED);
  assert.ok(human.score < 20, `casual human text scored ${human.score}`);
  assert.ok(bro.score >= 70, `templated post scored ${bro.score}`);
  assert.ok(Core.scan(HUMAN).score < 20, 'the sample human post scores low too');
  for (const r of [human, bro]) {
    assert.strictEqual(r.confidence, 'low', 'the quick scan is always low confidence');
    assert.ok(r.score >= 0 && r.score <= 97);
    assert.strictEqual(r.limits, Core.LIMITS_LINE);
  }
  const rules = new Set(bro.hits.map((h) => h.rule));
  for (const id of ['opener', 'closer', 'setup', 'notxbuty', 'vocab', 'emoji-bullets', 'hashtags']) assert.ok(rules.has(id), `templated post hits ${id}`);
  assert.ok(bro.signals.some((s) => s.rule === 'broetry'), 'one line per thought');
});

test('quick scan: every hit is an exact span with a category and a reason', () => {
  for (const t of [TEMPLATED, FORMAL, CASUAL, 'In today’s fast-paced world — it’s not a tool — it’s a partner.']) {
    for (const h of Core.scan(t).hits) {
      assert.strictEqual(t.slice(h.start, h.end), h.quote);
      assert.ok(h.category && h.label && h.reason && h.reason.length > 10, JSON.stringify(h));
    }
  }
  const curly = Core.scan('Let’s dive in. In today’s fast-paced world, it’s not a product, it’s a movement.');
  assert.ok(curly.hits.some((h) => h.rule === 'opener' && /dive/.test(h.quote)), 'curly apostrophes match');
  assert.ok(curly.hits.some((h) => h.rule === 'notxbuty'));
});

test('quick scan: formal human writing is not promised a low score; the limits line always travels with it', () => {
  const r = Core.scan(FORMAL);
  assert.strictEqual(r.limits, 'A signal, not proof. Formal human writing can score high; edited AI text can score low.');
  const c = Core.combine({ quick: r });
  assert.strictEqual(c.limits, Core.LIMITS_LINE);
  assert.strictEqual(c.confidence, 'low');
  assert.ok(Core.plainSummary({ quick: r }).includes(Core.LIMITS_LINE));
  // The scan's own words never pass a verdict.
  const words = [Core.LIMITS_LINE, r.how, ...Core.RULES.map((x) => x.reason), ...r.hits.map((h) => h.reason)].join(' ');
  assert.ok(!VERDICT.test(words), 'no "is AI", "written by AI" or "fake" as a verdict');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes(Core.LIMITS_LINE), 'the page states the limits');
});

test('quick scan: hostile and huge input stays bounded', () => {
  const t0 = Date.now();
  const r = Core.scan(`${'—'.repeat(30000)}${'✅ a\n'.repeat(5000)}${'#tag '.repeat(5000)}`);
  assert.ok(Date.now() - t0 < 2000, 'linear enough');
  assert.ok(r.score <= 97);
  assert.strictEqual(Core.scan('').score, 0);
  assert.ok(Core.scan('x'.repeat(50000)).words <= 1);
});

test('segments: overlapping highlights cut into runs that rebuild the text', () => {
  const text = 'abcdefghij';
  const segs = Core.segments(text, [{ id: 'a', start: 1, end: 6 }, { id: 'b', start: 4, end: 9 }, { id: 'bad', start: 8, end: 99 }]);
  assert.strictEqual(segs.map((s) => s.text).join(''), text);
  assert.deepStrictEqual(segs.find((s) => s.start === 4).ids.sort(), ['a', 'b']);
  assert.ok(!segs.some((s) => s.ids.includes('bad')), 'a span past the end is ignored');
});

test('combine: metadata naming a generator dominates; bands follow confidence; a camera is noted', () => {
  const quick = Core.scan(CASUAL);
  const strong = { findings: [{ strength: 'strong', points: 'ai', label: 'x' }] };
  const c = Core.combine({ quick, meta: strong });
  assert.deepStrictEqual([c.driver, c.confidence, c.score >= 95], ['meta', 'high', true]);
  const d = Core.combine({ quick, deep: { likelihood: 60, confidence: 'medium' } });
  assert.deepStrictEqual([d.driver, d.lo, d.hi], ['deep', 45, 75]);
  const v = Core.combine({ visual: { likelihood: 80, confidence: 'high' } });
  assert.strictEqual(v.confidence, 'medium', 'a visual read alone is never high confidence');
  assert.strictEqual(Core.combine({ meta: { findings: [{ strength: 'weak', points: 'camera' }] } }), null, 'metadata without AI makes no meter on its own');
  assert.strictEqual(Core.combine({ quick, meta: { findings: [{ strength: 'weak', points: 'camera' }] } }).camera, true);
});

test('?q=: text or link, cleaned, capped, and never a spend', () => {
  assert.deepStrictEqual(Core.parseQ('?q=https%3A%2F%2Fexample.com%2Fpost%3Fa%3D1&src=bm'), { kind: 'link', value: 'https://example.com/post?a=1', https: true, cut: false, src: 'bookmarklet', autoSpend: false });
  assert.strictEqual(Core.parseQ('?q=http%3A%2F%2Fexample.com').https, false, 'http is a link, flagged');
  const t = Core.parseQ(`?q=${encodeURIComponent('Hello\u0000 there‮\nworld')}&src=shortcut`);
  assert.deepStrictEqual([t.kind, t.value, t.src, t.autoSpend], ['text', 'Hello there\nworld', 'shortcut', false]);
  const long = Core.parseQ(`?q=${encodeURIComponent('word '.repeat(6000))}`);
  assert.deepStrictEqual([long.kind, long.value.length <= Core.LIMITS.text, long.cut], ['text', true, true]);
  assert.strictEqual(Core.parseQ(`?q=${encodeURIComponent(`https://example.com/${'a'.repeat(3000)}`)}`).kind, 'text', 'an over-long "link" is just text');
  assert.strictEqual(Core.parseQ('?q=%20%20'), null);
  assert.strictEqual(Core.parseQ('?x=1'), null);
  assert.strictEqual(Core.parseQ('?q=hi&cut=1').cut, true);
  assert.doesNotThrow(() => Core.parseQ('?q=%E0%A4%A&q2=%'), 'a broken escape does not throw');
  assert.strictEqual(Core.parseQ('?q=x&src=evil').src, null);
});

/* ================================================================== *
 * Pure: what a model returns is checked
 * ================================================================== */

test('highlights: fabricated quotes dropped, offsets computed here, duplicates each find their own place', () => {
  const text = 'Let that sink in. The plan is simple. Let that sink in.';
  const r = ai.cleanReading({
    likelihood: 70, confidence: 'high', summary: 'ok',
    spans: [
      { quote: 'Let that sink in.', category: 'hype', reason: 'first', strength: 'high' },
      { quote: 'Let that sink in.', category: 'hype', reason: 'second', strength: 'high' },
      { quote: 'Let that sink in.', category: 'hype', reason: 'third: only two exist', strength: 'high' },
      { quote: 'The plan is brilliant.', category: 'generic', reason: 'not in the text', strength: 'high' },
      { quote: '  The plan is simple.  ', category: 'generic', reason: 'trimmed then found', strength: 'medium' },
      { quote: 'ab', category: 'stock', reason: 'too short', strength: 'low' },
    ],
  }, text);
  assert.deepStrictEqual(r.spans.map((s) => [s.start, s.end]), [[0, 17], [18, 37], [38, 55]]);
  for (const s of r.spans) assert.strictEqual(text.slice(s.start, s.end), s.quote);
  assert.strictEqual(r.dropped, 3);
  assert.strictEqual(r.confidence, 'medium', 'never high under 80 words');
  assert.strictEqual(ai.locate('abc abc', [{ quote: 'abc' }, { quote: 'abc' }]).spans.map((s) => s.start).join(), '0,4');
});

test('hostile model output is cleaned: markup, bad links, huge strings, bad enums, out-of-range numbers', () => {
  const text = 'INJECT this text please, it is long enough to read.';
  const r = ai.cleanReading({
    likelihood: 4000, confidence: 'certain', summary: `<img src=x onerror=alert(1)>${'x'.repeat(5000)}`,
    spans: [{ quote: 'INJECT', category: '<script>', reason: '<a href="javascript:alert(1)">x</a>', strength: 'extreme' }, ...Array.from({ length: 50 }, () => ({ quote: 'INJECT', category: 'stock', reason: 'r', strength: 'low' }))],
  }, text);
  assert.strictEqual(r.likelihood, 100);
  assert.strictEqual(r.confidence, 'low');
  assert.ok(r.summary.length <= 400 && !/[<>]/.test(r.summary));
  assert.strictEqual(r.spans.length, 1, 'only one INJECT exists in the text');
  assert.deepStrictEqual([r.spans[0].category, r.spans[0].strength], ['other', 'low']);
  assert.ok(!/[<>]/.test(r.spans[0].reason));
  const seen = ai.searchUrls([[{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.com/a' }] }]]);
  const o = ai.cleanOriginality({
    originality: -5, confidence: 'sure', summary: '<b>x</b>', adds: 'y'.repeat(1000),
    sources: [
      { title: '<img src=x>Real', url: 'https://example.com/a#frag', date: 'last week', overlap: 'total', note: 'n' },
      { title: 'http', url: 'http://example.com/a', overlap: 'idea', note: '' },
      { title: 'js', url: 'javascript:alert(1)', overlap: 'idea', note: '' },
      { title: 'creds', url: 'https://u:p@example.com/a', overlap: 'idea', note: '' },
      { title: 'made up', url: 'https://nowhere.example/b', overlap: 'near-copy', note: '' },
    ],
  }, seen);
  assert.deepStrictEqual(o.sources.map((s) => [s.url, s.date, s.overlap, s.title]), [['https://example.com/a', null, 'idea', 'Real']]);
  assert.deepStrictEqual([o.score, o.confidence, o.dropped], [0, 'low', 4]);
  assert.ok(o.adds.length <= 400);
  const none = ai.cleanOriginality({ originality: 90, confidence: 'low', summary: '', sources: [], adds: '' }, seen);
  assert.strictEqual(none.none, 'No close earlier match found in a web search.');
  const near = ai.cleanOriginality({ originality: 95, confidence: 'high', summary: '', sources: [{ title: 't', url: 'https://example.com/a', overlap: 'near-copy', note: '' }], adds: '' }, seen);
  assert.strictEqual(near.score, 30, 'a near-copy caps originality');
  const v = ai.cleanVisual({ likelihood: 250, confidence: 'high', summary: '<svg onload=x>', artefacts: [{ where: '<b>hands</b>', frame: 99, what: 'x'.repeat(900) }, { where: 'sky', frame: 2, what: 'ok' }, 'junk'] }, 3);
  assert.deepStrictEqual([v.likelihood, v.confidence, v.artefacts.length, v.artefacts[0].frame, v.artefacts[1].frame], [100, 'medium', 2, null, 2]);
  assert.ok(!/[<>]/.test(JSON.stringify(v)));
  assert.strictEqual(ai.cleanVisual({ likelihood: 50, confidence: 'high', summary: '', artefacts: [] }, 1).confidence, 'low', 'nothing named, low');
});

test('the prompts carry the honesty spine', () => {
  assert.match(ai.READING_SYSTEM, /non-native English/);
  assert.match(ai.READING_SYSTEM, /never raise the likelihood for formality/);
  assert.match(ai.READING_SYSTEM, /EXACTLY/);
  assert.match(ai.ORIGINALITY_SYSTEM, /Never invent a source/);
  assert.match(ai.VISUAL_SYSTEM, /weak signal/);
  for (const s of [ai.READING_SYSTEM, ai.ORIGINALITY_SYSTEM, ai.VISUAL_SYSTEM]) assert.match(s, /data/, 'input is data, not instructions');
});

test('samples: every baked quote is in its text, and the pages say they are made up', () => {
  const s = samples();
  for (const p of s.posts) {
    for (const sp of p.deep.spans) assert.strictEqual(p.text.slice(sp.start, sp.end), sp.quote);
    assert.strictEqual(p.deep.dropped, 0);
    assert.match(p.blurb, /Made up/);
  }
  assert.ok(s.posts[0].combined.score > 70 && s.posts[1].combined.score < 25);
  assert.ok(s.posts[0].originality.sources.every((x) => /example\.(com|org)/.test(x.url) && /Illustration/.test(x.title)));
});

/* ================================================================== *
 * Pure: the metadata scanner
 * ================================================================== */

const strongAi = (r) => r.findings.some((f) => f.strength === 'strong' && f.points === 'ai');

test('metadata: JPEG with APP11 JUMBF Content Credentials naming OpenAI is strong, and says not verified', () => {
  const r = Meta.scan(F.jpeg(F.app11(F.jumbf(F.claim('OpenAI-API/1.0 c2pa-rs/0.31.1', 'c2pa.actions', 'c2pa.created')))));
  assert.deepStrictEqual([r.format, r.c2pa, r.points, strongAi(r)], ['image/jpeg', true, 'ai', true]);
  assert.match(r.findings[0].label, /Content Credentials name OpenAI \(not verified here\)/);
  assert.match(r.findings[0].detail, /Claim generator: OpenAI-API\/1\.0/);
  assert.ok(r.notes.some((n) => /do not verify/.test(n)));
  const camera = Meta.scan(F.jpeg(F.app11(F.jumbf(F.claim('Pixel Camera', 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture')))));
  assert.deepStrictEqual([camera.c2pa, camera.points, strongAi(camera)], [true, 'camera', false], 'credentials from a camera are not an AI signal');
});

test('metadata: PNG tEXt "parameters" (Automatic1111) and ComfyUI graphs are strong', () => {
  const a = Meta.scan(F.png(F.tEXt('parameters', 'a lighthouse at dusk\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 7, Seed: 1234')));
  assert.deepStrictEqual([a.format, a.points, strongAi(a)], ['image/png', 'ai', true]);
  assert.match(a.findings[0].label, /Automatic1111/);
  assert.ok(strongAi(Meta.scan(F.png(F.tEXt('prompt', '{"3":{"class_type":"KSampler"}}')))));
  assert.ok(strongAi(Meta.scan(F.png(F.tEXt('Software', 'NovelAI')))));
  assert.ok(!strongAi(Meta.scan(F.png(F.tEXt('Comment', 'holiday in Crete')))), 'ordinary text is not a signal');
});

test('metadata: PNG XMP with trainedAlgorithmicMedia is strong; digitalCapture points to a camera', () => {
  const r = Meta.scan(F.png(F.iTXt('XML:com.adobe.xmp', F.XMP_AI)));
  assert.ok(strongAi(r));
  assert.match(r.findings[0].detail, /trainedAlgorithmicMedia/);
  const cam = Meta.scan(F.jpeg(F.app1Xmp(F.XMP_CAMERA)));
  assert.deepStrictEqual([cam.points, strongAi(cam)], ['camera', false]);
  const comp = Meta.scan(F.jpeg(F.app1Xmp(F.XMP_AI.replace('trainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia'))));
  assert.match(comp.findings[0].label, /partly/);
});

test('metadata: JPEG EXIF Make/Model is a weak camera signal; EXIF Software naming a generator is strong', () => {
  const r = Meta.scan(F.jpeg(F.app1Exif({ make: 'Canon', model: 'Canon EOS R6', dateOriginal: '2026:09:20 18:02:11', lens: 'RF24-105mm F4 L IS USM' })));
  assert.deepStrictEqual([r.points, r.findings[0].strength], ['camera', 'weak']);
  assert.match(r.findings[0].label, /Canon EOS R6/);
  assert.match(r.findings[0].detail, /not proof/);
  assert.deepStrictEqual([r.exif.Make, r.exif.DateTimeOriginal, r.exif.LensModel], ['Canon', '2026:09:20 18:02:11', 'RF24-105mm F4 L IS USM']);
  assert.ok(strongAi(Meta.scan(F.jpeg(F.app1Exif({ software: 'Adobe Firefly' })))));
  assert.ok(!strongAi(Meta.scan(F.jpeg(F.app1Exif({ software: 'Adobe Photoshop 25.0' })))), 'an editor is not a generator');
});

test('metadata: MP4 uuid box with C2PA, and a generator encoder tag', () => {
  const r = Meta.scan(F.mp4({ c2paClaim: F.claim('Sora/2 c2pa-rs', 'softwareAgent', 'Sora') }));
  assert.deepStrictEqual([r.format, r.c2pa, strongAi(r)], ['video/mp4', true, true]);
  assert.match(r.findings[0].label, /Sora/);
  assert.ok(strongAi(Meta.scan(F.mp4({ encoder: 'Google Veo 3' }))));
  // Chunks, as the page sends a big video: the head, then a uuid box far in.
  const whole = F.mp4({ c2paClaim: F.claim('Adobe Firefly Video') });
  const boxes = Meta.bmffBoxes(whole, 0);
  assert.deepStrictEqual(boxes.map((b) => b.type), ['ftyp', 'uuid', 'moov', 'mdat']);
  assert.strictEqual(boxes[1].uuid, Meta.C2PA_UUID);
  const u = boxes[1];
  const chunked = Meta.scan([{ offset: 0, bytes: whole.subarray(0, 40) }, { offset: u.start, bytes: whole.subarray(u.start, u.start + u.size), box: 'uuid' }], { size: whole.length });
  assert.deepStrictEqual([chunked.c2pa, strongAi(chunked), chunked.scanned.partial], [true, true, true]);
});

test('metadata: a file with nothing says so, and that it means nothing', () => {
  for (const b of [F.jpeg(), F.png(), Buffer.from('not an image at all')]) {
    const r = Meta.scan(b);
    assert.strictEqual(r.points, 'none');
    assert.strictEqual(r.findings.length, 1);
    assert.match(r.findings[0].detail, /strip metadata on upload, so finding none means nothing either way/);
  }
  const junk = crypto.randomBytes(200000);
  junk.write('ÿØÿ', 0, 'latin1');
  assert.doesNotThrow(() => Meta.scan(junk), 'random bytes behind a JPEG header do not throw');
  assert.doesNotThrow(() => Meta.scan(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xeb, 0xff, 0xff]), Buffer.alloc(10)])), 'a lying segment length');
  assert.strictEqual(Meta.cleanFindings([{ strength: 'nuclear', points: 'x', label: '<b>' + 'y'.repeat(900) }])[0].label.length <= 140, true);
});

/* ================================================================== *
 * Pure: the SSRF guard and the page reader
 * ================================================================== */

test('ssrf: private, loopback, link-local, metadata and reserved addresses are refused, v4 and v6', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:0:0:1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', 'ff02::1', 'not-an-ip']) {
    assert.strictEqual(LF.addressAllowed(a), false, a);
  }
  for (const a of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) assert.strictEqual(LF.addressAllowed(a), true, a);
  const refused = (u, code) => assert.throws(() => LF.checkUrl(u), (e) => e.status === 400 && e.code === code, u);
  refused('http://example.com/', 'https-only');
  refused('ftp://example.com/', 'https-only');
  refused('javascript:alert(1)', 'https-only');
  refused('https://user:pw@example.com/', 'bad-url');
  refused('https://example.com:8443/', 'bad-url');
  refused('not a url', 'bad-url');
  for (const u of ['https://localhost/', 'https://metadata.google.internal/computeMetadata/v1/', 'https://169.254.169.254/latest/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://2130706433/', 'https://0x7f.1/', 'https://intranet/', 'https://printer.local/', 'https://db.corp/']) refused(u, 'private-address');
  assert.strictEqual(LF.checkUrl('https://Example.com/a#b').href, 'https://example.com/a');
});

/** A fake network: DNS answers and responses by URL, recording every call. */
function fakeNet(routes, dns) {
  const calls = [];
  const resolve = async (host) => {
    const a = (dns || {})[host];
    if (!a) throw new Error('ENOTFOUND');
    return (Array.isArray(a) ? a : [a]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  const request = async (url, opts) => {
    calls.push({ url: url.href, address: opts.address, ua: opts.headers['User-Agent'] });
    const r = routes[url.href];
    if (!r) return { status: 404, headers: {}, body: Readable.from([]) };
    if (r.hang) return new Promise((_res, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    return { status: r.status || 200, headers: r.headers || { 'content-type': 'text/html; charset=utf-8' }, body: Readable.from(r.chunks || [Buffer.from(r.body || '')]) };
  };
  return { calls, resolve, request };
}
const PAGE = '<html><head><title>A title</title><meta property="og:description" content="The preview &amp; more"><meta property="og:image" content="/img/card.jpg"></head><body><nav>Home About</nav><script>evil()</script><article><h1>Heading</h1><p>' + 'A real paragraph of text with enough words to check. '.repeat(10) + '</p><p>Second &mdash; paragraph.</p></article><footer>foot</footer></body></html>';

test('ssrf: the fetcher resolves, checks every address, pins the connection and re-checks every redirect', async () => {
  const pub = '93.184.216.34';
  let n = fakeNet({ 'https://example.com/post': { body: PAGE } }, { 'example.com': pub });
  let f = LF.createFetcher(n);
  const ok = await f.get('https://example.com/post');
  assert.strictEqual(n.calls[0].address, pub, 'the connection goes to the address that was checked');
  assert.match(n.calls[0].ua, /^TellsBot\/1\.0/);
  assert.match(ok.text, /A real paragraph/);
  // A name that resolves to a private address, or to a mix: refused before any connection.
  for (const dns of [{ 'example.com': '10.0.0.5' }, { 'example.com': [pub, '127.0.0.1'] }, { 'example.com': '::ffff:169.254.169.254' }]) {
    n = fakeNet({ 'https://example.com/post': { body: PAGE } }, dns);
    await assert.rejects(LF.createFetcher(n).get('https://example.com/post'), (e) => e.code === 'private-address');
    assert.strictEqual(n.calls.length, 0, 'never connected');
  }
  // A redirect to a private address, to http, and too many redirects.
  n = fakeNet({ 'https://example.com/a': { status: 302, headers: { location: 'https://inside.example/b' } } }, { 'example.com': pub, 'inside.example': '192.168.0.2' });
  await assert.rejects(LF.createFetcher(n).get('https://example.com/a'), (e) => e.code === 'private-address');
  assert.strictEqual(n.calls.length, 1);
  n = fakeNet({ 'https://example.com/a': { status: 301, headers: { location: 'http://example.com/b' } } }, { 'example.com': pub });
  await assert.rejects(LF.createFetcher(n).get('https://example.com/a'), (e) => e.code === 'https-only');
  n = fakeNet({ 'https://example.com/a': { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } } }, { 'example.com': pub });
  await assert.rejects(LF.createFetcher(n).get('https://example.com/a'), (e) => e.code === 'private-address');
  const loop = {};
  for (let i = 0; i < 6; i++) loop[`https://example.com/${i}`] = { status: 307, headers: { location: `/${i + 1}` } };
  n = fakeNet(loop, { 'example.com': pub });
  await assert.rejects(LF.createFetcher(n).get('https://example.com/0'), (e) => e.code === 'redirects');
  assert.strictEqual(n.calls.length, 4, 'three redirects followed, then refused');
  n = fakeNet({ 'https://example.com/a': { status: 302, headers: { location: '/b' } }, 'https://example.com/b': { body: PAGE } }, { 'example.com': pub });
  assert.strictEqual((await LF.createFetcher(n).get('https://example.com/a')).url, 'https://example.com/b', 'a relative redirect is followed');
});

test('ssrf: size, type, time and encoding limits', async () => {
  const pub = '93.184.216.34';
  let n = fakeNet({ 'https://example.com/big': { headers: { 'content-type': 'text/html', 'content-length': String(5 * 1024 * 1024) }, body: 'x' } }, { 'example.com': pub });
  await assert.rejects(LF.createFetcher(n).get('https://example.com/big'), (e) => e.status === 413);
  n = fakeNet({ 'https://example.com/big2': { headers: { 'content-type': 'text/html' }, chunks: Array.from({ length: 40 }, () => Buffer.alloc(100 * 1024, 97)) } }, { 'example.com': pub });
  await assert.rejects(LF.createFetcher(n).get('https://example.com/big2'), (e) => e.status === 413, 'counted as it arrives, not trusted from a header');
  const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 32));
  n = fakeNet({ 'https://example.com/gz': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: bomb } }, { 'example.com': pub });
  await assert.rejects(LF.createFetcher(n).get('https://example.com/gz'), (e) => e.status === 413, 'counted after decompression');
  n = fakeNet({ 'https://example.com/ok.gz': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: zlib.gzipSync(Buffer.from(PAGE)) } }, { 'example.com': pub });
  assert.match((await LF.createFetcher(n).get('https://example.com/ok.gz')).text, /Second/);
  n = fakeNet({ 'https://example.com/pdf': { headers: { 'content-type': 'application/pdf' }, body: '%PDF' } }, { 'example.com': pub });
  await assert.rejects(LF.createFetcher(n).get('https://example.com/pdf'), (e) => e.status === 415);
  n = fakeNet({ 'https://example.com/img': { headers: { 'content-type': 'text/html' }, body: PAGE } }, { 'example.com': pub });
  await assert.rejects(LF.createFetcher(n).get('https://example.com/img', 'image'), (e) => e.status === 415, 'an image fetch takes images only');
  n = fakeNet({ 'https://example.com/slow': { hang: true } }, { 'example.com': pub });
  const t0 = Date.now();
  await assert.rejects(LF.createFetcher({ ...n, timeoutMs: 120 }).get('https://example.com/slow'), (e) => e.status === 504);
  assert.ok(Date.now() - t0 < 2000);
  n = fakeNet({ 'https://example.com/403': { status: 403 } }, { 'example.com': pub });
  await assert.rejects(LF.createFetcher(n).get('https://example.com/403'), (e) => e.code === 'walled');
  await assert.rejects(LF.createFetcher(fakeNet({}, {})).get('https://nowhere.example/'), (e) => e.code === 'dns');
});

test('page reader: main text without scripts or chrome; walls on LinkedIn and X said plainly', () => {
  const p = extract(PAGE, 'https://example.com/post', 'text/html');
  assert.strictEqual(p.title, 'A title');
  assert.strictEqual(p.description, 'The preview & more');
  assert.strictEqual(p.image, 'https://example.com/img/card.jpg');
  assert.ok(p.text.startsWith('Heading') && p.text.includes('Second — paragraph.'));
  assert.ok(!/evil|Home About|foot/.test(p.text));
  assert.strictEqual(p.wall, null);
  const li = extract('<html><head><meta property="og:description" content="Excited to share that..."></head><body>Sign in to view more</body></html>', 'https://www.linkedin.com/posts/someone_activity-1', 'text/html');
  assert.strictEqual(li.wall.message, 'LinkedIn and X hide posts from servers. Paste the text, or use the Tells extension on the post.');
  assert.strictEqual(li.wall.preview, 'Excited to share that...');
  assert.strictEqual(extract('<body>Log in to continue</body>', 'https://x.com/a/status/1', 'text/html').wall.reason, 'social');
  assert.strictEqual(extract('<body><p>Short.</p></body>', 'https://example.com/', 'text/html').wall.reason, 'little-text');
  assert.strictEqual(extract(PAGE.replace('/img/card.jpg', 'http://example.com/x.jpg'), 'https://example.com/', 'text/html').image, null, 'only an https preview image');
  const plain = extract('Hello <b>there</b>\n\n\n\nfriend', 'https://example.com/a.txt', 'text/plain');
  assert.ok(plain.text.includes('<b>there</b>'), 'plain text is text, not markup');
});

/* ================================================================== *
 * The bookmarklet and the extension
 * ================================================================== */

function runBookmarklet(href, { selection = '', url = 'https://www.linkedin.com/feed/', openBlocked = false } = {}) {
  const opened = [];
  const loc = { href: url };
  const ctx = {
    window: { getSelection: () => ({ toString: () => selection }), open: (u) => { opened.push(u); return openBlocked ? null : {}; } },
    location: loc, encodeURIComponent, String, Math,
  };
  vm.runInNewContext(decodeURIComponent(href.slice('javascript:'.length)), ctx);
  return { opened, navigated: loc.href !== url ? loc.href : null };
}

test('bookmarklet: one source, served as a javascript: link, under the length budget', async () => {
  const src = fs.readFileSync(BM.SRC, 'utf8');
  const pub = BM.build(BM.PUBLIC_BASE);
  assert.strictEqual(decodeURIComponent(pub.href.slice('javascript:'.length)), BM.minify(src).replace('__TELLS_BASE__', BM.PUBLIC_BASE));
  assert.ok(pub.href.startsWith('javascript:') && pub.href.length <= BM.MAX_LENGTH, `${pub.href.length} chars`);
  // What the page is served is that build, for the address it was asked on.
  const served = (await client()('GET', '/api/bookmarklet')).data;
  assert.strictEqual(decodeURIComponent(served.href.slice('javascript:'.length)), BM.minify(src).replace('__TELLS_BASE__', served.base));
  assert.ok(!/fetch|XMLHttpRequest|sendBeacon|import\(/.test(src.replace(/\/\/.*$/gm, '')), 'it navigates; it never fetches from the page');
  assert.match(served.base, /^http:\/\/127\.0\.0\.1:\d+\/tells\/$/, 'a local run points back at itself');
});

test('bookmarklet: selection or address, cut to fit, new tab or same tab', () => {
  const { href } = BM.build(BM.PUBLIC_BASE);
  let r = runBookmarklet(href, { selection: '  I’m thrilled to announce… 🚀  ' });
  const u = new URL(r.opened[0]);
  assert.strictEqual(`${u.origin}${u.pathname}`, BM.PUBLIC_BASE);
  assert.deepStrictEqual([u.searchParams.get('q'), u.searchParams.get('src'), u.searchParams.get('cut')], ['I’m thrilled to announce… 🚀', 'bm', null]);
  r = runBookmarklet(href, {});
  assert.strictEqual(new URL(r.opened[0]).searchParams.get('q'), 'https://www.linkedin.com/feed/', 'nothing selected: the address');
  r = runBookmarklet(href, { selection: '😀'.repeat(5000) + 'é'.repeat(4000) });
  assert.ok(r.opened[0].length < 7000, `${r.opened[0].length}`);
  assert.strictEqual(new URL(r.opened[0]).searchParams.get('cut'), '1');
  assert.ok(!/�/.test(new URL(r.opened[0]).searchParams.get('q')), 'never a broken surrogate');
  r = runBookmarklet(href, { selection: 'hello there', openBlocked: true });
  assert.ok(r.navigated && new URL(r.navigated).searchParams.get('q') === 'hello there', 'a blocked pop-up falls back to this tab');
});

test('extension: MV3, exactly the permissions intended, Safari-ready, no offscreen, core copies identical', () => {
  const dir = EXT.EXT;
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.strictEqual(m.manifest_version, 3);
  assert.deepStrictEqual(m.permissions, ['contextMenus', 'storage', 'activeTab', 'scripting']);
  assert.deepStrictEqual(m.host_permissions, ['https://www.linkedin.com/*', 'https://x.com/*', 'https://twitter.com/*', 'https://media.licdn.com/*', 'https://pbs.twimg.com/*', 'https://challenge.strongtechnicalconsulting.com/*']);
  assert.deepStrictEqual(m.optional_host_permissions, ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'], '<all_urls> is never required up front');
  assert.ok(!JSON.stringify(m).includes('<all_urls>'));
  assert.strictEqual(m.content_scripts.length, 1);
  assert.deepStrictEqual(m.content_scripts[0].matches, ['https://www.linkedin.com/*', 'https://x.com/*', 'https://twitter.com/*']);
  assert.deepStrictEqual(m.content_scripts[0].js, ['tells-core.js', 'ui.js', 'content.js']);
  assert.strictEqual(m.background.service_worker, 'background.js');
  assert.ok(!m.background.type, 'a classic worker: importScripts works in Chrome and after Safari’s converter');
  assert.ok(m.action && m.action.default_popup === 'popup.html', 'a toolbar popup, for iOS where there is no context menu');
  for (const bad of ['offscreen', 'tabs', 'webRequest', 'history', 'cookies', 'debugger', 'nativeMessaging', 'declarativeNetRequest']) assert.ok(!m.permissions.includes(bad), bad);
  const code = ['background.js', 'content.js', 'ui.js', 'popup.js', 'options.js'].map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  for (const [f, src] of code) {
    const live = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/offscreen\./i.test(live) && !/chrome\.offscreen/.test(live), `${f}: no offscreen documents`);
    assert.ok(/globalThis\.browser \|\| globalThis\.chrome/.test(live) || f === 'ui.js', `${f}: browser namespace first, then chrome`);
    assert.ok(!/\.innerHTML\s*=/.test(live), `${f}: no innerHTML`);
    assert.ok(!/<script[^>]+src=["']https?:/.test(live) && !/\beval\(|new Function\(/.test(live), `${f}: no remote or generated code`);
  }
  assert.ok(/typeof OffscreenCanvas === 'undefined'/.test(code[0][1]), 'OffscreenCanvas is feature-detected');
  assert.ok(/api\.contextMenus && api\.contextMenus\.onClicked/.test(code[0][1]), 'the menu is optional');
  for (const f of EXT.SHARED) assert.ok(fs.readFileSync(path.join(ROOT, 'public', f)).equals(fs.readFileSync(path.join(dir, f))), `${f} is byte-identical to public/${f}`);
  const referenced = [m.background.service_worker, m.action.default_popup, m.options_ui.page, ...m.content_scripts[0].js, ...Object.values(m.icons)];
  for (const f of referenced) assert.ok(fs.existsSync(path.join(dir, f)), `${f} exists`);
  // The download is current: every file in extension/ (docs aside), byte for byte.
  const zip = EXT.unzip(fs.readFileSync(EXT.ZIP));
  assert.deepStrictEqual(Object.keys(zip).sort(), EXT.files(dir).sort());
  for (const [name, e] of Object.entries(zip)) {
    assert.ok(e.data.equals(fs.readFileSync(path.join(dir, name))), `${name} in the zip is current (npm run extension)`);
    assert.strictEqual(e.crc, EXT.crc32(e.data));
  }
  for (const doc of ['README.md', 'SAFARI.md']) assert.ok(fs.existsSync(path.join(dir, doc)), `extension/${doc}`);
});

test('extension: the content script adds one button per post and a quick-scan panel (DOM stand-in)', () => {
  // A small DOM: enough of document, elements and shadow roots for content.js.
  function Node(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.style = {}; this.parentNode = null; this.listeners = {};
    this.textContent = ''; this.innerText = '';
  }
  Node.prototype = {
    get parentElement() { return this.parentNode && this.parentNode.tagName ? this.parentNode : null; },
    get childNodes() { return this.children; },
    get firstChild() { return this.children[0] || null; },
    get nextSibling() { const s = this.parentNode ? this.parentNode.children : []; return s[s.indexOf(this) + 1] || null; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }, hasAttribute(k) { return k in this.attrs; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; },
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    attachShadow() { this.shadow = new Node('#shadow'); return this.shadow; },
    all() { return this.children.reduce((a, c) => a.concat([c], c.all()), []); },
    matches(sel) { return sel.split(',').some((s) => match(this, s.trim())); },
    querySelectorAll(sel) { return this.all().filter((n) => n.matches(sel)); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    closest(sel) { let n = this; while (n && n.tagName) { if (n.matches(sel)) return n; n = n.parentNode; } return null; },
    focus() {},
  };
  function match(n, sel) {
    const m = sel.match(/^([a-z]*)(?:\.([\w-]+))?(?:\[([\w-]+)(?:([\^]?=)"([^"]*)")?\])?$/i);
    if (!m) return false;
    if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && !String(n.attrs.class || '').split(/\s+/).includes(m[2])) return false;
    if (m[3]) {
      const v = n.attrs[m[3]];
      if (v == null) return false;
      if (m[4] === '=' && v !== m[5]) return false;
      if (m[4] === '^=' && !v.startsWith(m[5])) return false;
    }
    return true;
  }
  const el = (tag, attrs, kids) => { const n = new Node(tag); Object.assign(n.attrs, attrs || {}); (kids || []).forEach((k) => n.appendChild(k)); return n; };
  const body = el('body');
  const root = el('html', {}, [body]);
  const tweetText = el('div', { 'data-testid': 'tweetText' });
  tweetText.innerText = TEMPLATED;
  const tweet = el('article', { 'data-testid': 'tweet' }, [tweetText]);
  const tweet2Text = el('div', { 'data-testid': 'tweetText' }); tweet2Text.innerText = CASUAL;
  const tweet2 = el('article', { 'data-testid': 'tweet' }, [tweet2Text]);
  body.appendChild(tweet); body.appendChild(tweet2);
  const sent = [];
  const document = {
    documentElement: root, body,
    createElement: (t) => new Node(t), createTextNode: (t) => { const n = new Node('#text'); n.textContent = t; return n; },
    querySelectorAll: (s) => root.querySelectorAll(s), querySelector: (s) => root.querySelector(s),
    addEventListener() {},
  };
  const chromeStub = { storage: { local: { get: async () => ({}) } }, runtime: { sendMessage: (m, cb) => { sent.push(m); cb({}); }, onMessage: { addListener() {} } } };
  const ctx = { document, location: { hostname: 'x.com' }, requestAnimationFrame: (f) => f(), MutationObserver: function () { this.observe = () => {}; }, Promise, console };
  ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx; ctx.chrome = chromeStub;
  vm.createContext(ctx);
  for (const f of ['tells-core.js', 'ui.js', 'content.js']) vm.runInContext(fs.readFileSync(path.join(EXT.EXT, f), 'utf8'), ctx);
  const buttons = () => root.all().filter((n) => n.attrs['data-tells'] === 'btn');
  assert.strictEqual(buttons().length, 2, 'one button per tweet');
  vm.runInContext(fs.readFileSync(path.join(EXT.EXT, 'content.js'), 'utf8'), ctx);
  assert.strictEqual(buttons().length, 2, 'loading twice changes nothing');
  const btn = buttons()[0].shadow.children.find((c) => c.tagName === 'BUTTON');
  btn.listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
  const panel = root.children.find((c) => c.attrs['data-tells'] === 'panel');
  assert.ok(panel, 'the panel opened');
  const texts = panel.shadow.all().map((n) => n.textContent).join(' ');
  assert.ok(/Reads as AI/.test(texts) && texts.includes(Core.LIMITS_LINE), 'with the quick scan and the limits line');
  assert.ok(/Deep read \(uses credit\)/.test(texts), 'a deep read waits for a tap');
  assert.strictEqual(sent.length, 0, 'nothing was sent anywhere');
});

/* ================================================================== *
 * Page contrast
 * ================================================================== */

function lum(hex) {
  const c = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

test('contrast: every text colour on every surface it sits on, both themes, 4.5:1 or better', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  const block = (re) => Object.fromEntries([...css.match(re)[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
  const light = block(/:root \{([\s\S]*?)\n\}/);
  const dark = { ...light, ...block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}/) };
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const fg of ['text', 'muted', 'link', 'bad']) {
      for (const bg of ['bg', 'card', 'card2', 'hl-low', 'hl-med', 'hl-high', 'strong-bg', 'camera-bg', 'accent-soft']) {
        if (fg !== 'text' && fg !== 'muted' && /^hl-/.test(bg)) continue;
        const r = ratio(t[fg], t[bg]);
        assert.ok(r >= 4.5, `${name}: --${fg} on --${bg} is ${r.toFixed(2)}:1`);
      }
    }
    assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, `${name}: button text`);
  }
});

/* ================================================================== *
 * Local-only switches and the prefix
 * ================================================================== */

test('local-only switches throw on Cloud Run; the collection prefix is honoured', () => {
  for (const [mod, env] of [['./lib/store', { TELLS_MEMORY: '1' }], ['./lib/fakeai', { TELLS_FAKE_AI: '1' }], ['./server', { TELLS_FAKE_AI: '1', TELLS_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, TELLS_MEMORY: '', TELLS_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'store.js'), 'utf8');
  assert.ok(/TELLS_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 8, 'every Firestore path is prefixed');
});

/* ================================================================== *
 * Over HTTP
 * ================================================================== */

async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const pngB64 = (s = '') => F.png(F.tEXt('Comment', s)).toString('base64');
const jpegB64 = (s = '') => F.jpeg(F.segment(0xfe, Buffer.from(s || 'plain'))).toString('base64');
const pub = '93.184.216.34';
const NET = fakeNet({
  'https://example.com/post': { body: PAGE },
  'https://www.linkedin.com/posts/x': { body: '<html><head><meta property="og:description" content="Thrilled to share..."></head><body>Sign in to view</body></html>' },
  'https://example.com/img/card.jpg': { headers: { 'content-type': 'image/jpeg' }, body: F.jpeg(F.app11(F.jumbf(F.claim('Adobe Firefly')))) },
}, { 'example.com': pub, 'www.linkedin.com': pub, 'inside.example': '10.0.0.8' });

test('signed out: the page, samples, meta and the quick scan work with zero model calls; everything else is 401 first', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const page = await anon('GET', '/');
  assert.ok(page.text.includes('src="app.js"') && page.text.includes('href="app.css"') && !/(src|href)="\//.test(page.text), 'relative asset links only');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
  for (const f of ['tells-core.js', 'tells-meta.js', 'bookmarklet.src.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const zip = await fetch(`${base}/tells-extension.zip`);
  assert.deepStrictEqual([zip.status, /attachment/.test(zip.headers.get('content-disposition'))], [200, true]);
  assert.strictEqual((await anon('GET', '/api/samples')).data.posts.length, 2);
  assert.ok((await anon('GET', '/api/meta')).data.notes.limits === Core.LIMITS_LINE);
  const scan = await anon('POST', '/api/scan', { text: TEMPLATED });
  assert.deepStrictEqual([scan.status, scan.data.quick.score >= 70, scan.data.combined.confidence], [200, true, 'low']);
  const txt = await anon('POST', '/api/scan?format=text', { text: TEMPLATED });
  assert.ok(txt.text.includes('Reads as AI:') && txt.text.includes(Core.LIMITS_LINE));
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['POST', '/api/check/deep'], ['POST', '/api/check/originality'], ['POST', '/api/check/picture'], ['POST', '/api/check/video'], ['POST', '/api/check/link'], ['POST', '/api/check/link-image'], ['POST', '/api/check/metadata'], ['GET', '/api/devices'], ['POST', '/api/devices'], ['DELETE', `/api/devices/${'a'.repeat(64)}`]]) {
    assert.strictEqual((await anon(m, p, m === 'GET' || m === 'DELETE' ? undefined : { text: TEMPLATED })).status, 401, `${m} ${p}`);
  }
  const big = await anon('POST', '/api/check/picture', { preview: { data: 'A'.repeat(15 * 1024 * 1024) } });
  assert.strictEqual(big.status, 401, 'the gate answers before the big parser reads anything');
  assert.strictEqual((await anon('POST', '/api/check/link', { url: 'x'.repeat(40 * 1024) })).status, 413, 'everything else keeps a small body limit');
  // ?q= loads the page and the free scan only: no model call can come from an address.
  const q = await anon('GET', `/?q=${encodeURIComponent(TEMPLATED)}&src=bm`);
  assert.strictEqual(q.status, 200);
  assert.ok(q.text.includes('app.js'));
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('every metered route puts sign-in, budget and the daily cap before its body parser', () => {
  for (const p of ['/api/check/deep', '/api/check/originality', '/api/check/picture', '/api/check/video', '/api/check/link-image']) {
    const layer = app._router.stack.find((l) => l.route && l.route.path === p);
    const names = layer.route.stack.map((l) => l.handle.name || '(anon)');
    assert.deepStrictEqual(names.slice(0, 3), ['requireUser', 'requireBudget', 'requireDailyCap'], p);
    if (p !== '/api/check/link-image') assert.strictEqual(names[3], 'jsonParser', `${p}: its parser only after the gates`);
  }
  const meta = app._router.stack.find((l) => l.route && l.route.path === '/api/check/metadata').route.stack.map((l) => l.handle.name);
  assert.deepStrictEqual(meta.slice(0, 2), ['requireUser', 'jsonParser']);
});

let ada, ben;
const SENTINEL = 'Zyxwvut quokka sentinel';

test('deep read: streamed, every highlight in the text, the fabricated one dropped, one metered call', async () => {
  ada = await register('ada@example.com');
  let calls = await modelCalls();
  for (const bad of [{}, { text: '' }, { text: 'too short' }, { text: 'x '.repeat(12000) }]) {
    assert.strictEqual((await ada('POST', '/api/check/deep', bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'a 400 spends nothing');
  const text = `${TEMPLATED}\n\n${SENTINEL}`;
  const raw = await fetch(`${base}/api/check/deep`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ada.cookie() }, body: JSON.stringify({ text }) });
  const body = await raw.text();
  assert.strictEqual(raw.status, 200);
  assert.ok(body.startsWith(' '), 'whitespace first, so a phone keeps the connection');
  const d = JSON.parse(body);
  assert.ok(d.deep.spans.length >= 5);
  for (const s of d.deep.spans) assert.strictEqual(text.slice(s.start, s.end), s.quote);
  assert.ok(d.deep.dropped >= 1, 'the fake always invents one quote; it was dropped');
  assert.ok(!d.deep.spans.some((s) => /not in the text/.test(s.quote)));
  assert.strictEqual(d.combined.driver, 'deep');
  await settle();
  const rows = await usage();
  assert.strictEqual(rows.length, calls + 1, 'one call');
  assert.strictEqual(rows[rows.length - 1].uid, uidOf('ada@example.com'), 'charged to Ada');
  assert.ok((await identityStore.get('users', uidOf('ada@example.com'))).spentUsd > 0);
  calls += 1;
  const up = await ada('POST', '/api/check/deep', { text: `${CASUAL} UPSTREAM500` });
  assert.deepStrictEqual([up.status, typeof up.data.error, /fake_upstream/.test(up.text)], [200, 'string', false], 'after the stream starts, a failure is a 200 {error}, and the provider’s words stay inside');
  const hostile = await ada('POST', '/api/check/deep', { text: `${CASUAL} INJECT` });
  assert.strictEqual(hostile.status, 200);
  assert.ok(!/<img|<script|javascript:|onerror/i.test(hostile.text));
  assert.deepStrictEqual([hostile.data.deep.likelihood, hostile.data.deep.confidence, hostile.data.deep.spans.length], [100, 'low', 1]);
});

test('originality: web search charged, sources checked against the results, pause and a missing record handled', async () => {
  const before = await usage();
  const r = await ada('POST', '/api/check/originality', { text: `${TEMPLATED}\n${SENTINEL}` });
  assert.strictEqual(r.status, 200, r.text);
  const o = r.data.originality;
  assert.deepStrictEqual(o.sources.map((s) => s.url), ['https://example.com/blog/lessons-from-year-one', 'https://example.org/guides/growth-culture']);
  assert.ok(o.sources.every((s) => s.matched === true));
  assert.strictEqual(o.dropped, 1, 'the source the search never returned was dropped');
  await settle();
  const rows = (await usage()).slice(before.length);
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].costUsd >= 0.02, `two searches are billed on top of tokens (${rows[0].costUsd})`);
  const paused = await ada('POST', '/api/check/originality', { text: `${CASUAL} PAUSE` });
  assert.strictEqual(paused.data.originality.sources.length, 2, 'a paused turn is resumed');
  const norecord = await ada('POST', '/api/check/originality', { text: `${CASUAL} NORECORD` });
  assert.strictEqual(norecord.data.originality.sources.length, 2, 'a turn that ends without recording is asked once more, forced');
  const none = await ada('POST', '/api/check/originality', { text: `${CASUAL} NOSOURCES` });
  assert.deepStrictEqual([none.data.originality.sources.length, none.data.originality.none], [0, 'No close earlier match found in a web search.']);
  const bad = await ada('POST', '/api/check/originality', { text: `${CASUAL} INJECT` });
  assert.ok(!/<script|<img|javascript:|http:\/\//.test(bad.text));
  assert.strictEqual(bad.data.originality.sources.length, 1);
});

test('picture: bytes checked before any spend; metadata read from the original; ?format=text for the Shortcut', async () => {
  const calls = await modelCalls();
  for (const body of [{}, { preview: { data: Buffer.from('%PDF-1.4').toString('base64') } }, { preview: { data: '!!!' } }, { original: { data: Buffer.from('GIF but not').toString('base64') } }]) {
    assert.strictEqual((await ada('POST', '/api/check/picture', body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a non-picture');
  const good = await ada('POST', '/api/check/picture', { preview: { data: jpegB64() } });
  assert.strictEqual(good.status, 200, good.text);
  assert.deepStrictEqual([good.data.visual.confidence, good.data.visual.artefacts.length, good.data.meta], ['medium', 2, null]);
  assert.strictEqual(good.data.combined.driver, 'visual');
  const orig = F.png(F.tEXt('parameters', 'a cat\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1'));
  const both = await ada('POST', '/api/check/picture', { original: { data: orig.toString('base64') } });
  assert.deepStrictEqual([both.data.meta.points, both.data.combined.driver, both.data.combined.score >= 95], ['ai', 'meta', true], 'the original doubles as the preview when it is small');
  const withGps = F.jpeg(F.app1Exif({ make: 'Apple', model: 'iPhone 16' }), F.app1Xmp(F.XMP_CAMERA), F.segment(0xfe, Buffer.from('a comment')));
  const bare = require('../lib/images').stripMeta(withGps, 'image/jpeg');
  assert.ok(bare.length < withGps.length && Meta.scan(bare).points === 'none' && Meta.sniff(bare) === 'image/jpeg', 'metadata cut out, still a JPEG');
  assert.strictEqual(Meta.scan(require('../lib/images').stripMeta(orig, 'image/png')).points, 'none');
  const txt = await ada('POST', '/api/check/picture?format=text', { original: { data: orig.toString('base64') } });
  assert.match(txt.headers.get('content-type'), /text\/plain/);
  assert.ok(txt.text.startsWith('Reads as AI: ') && /Strong: Stable Diffusion generation settings/.test(txt.text) && /Visual read \(weak\)/.test(txt.text));
  const hostile = await ada('POST', '/api/check/picture', { preview: { data: jpegB64('INJECT') } });
  assert.ok(!/<svg|<b>|onload/.test(hostile.text));
  assert.deepStrictEqual([hostile.data.visual.likelihood, hostile.data.visual.artefacts.length], [100, 1]);
  const up = await ada('POST', '/api/check/picture', { preview: { data: jpegB64('UPSTREAM401') } });
  assert.deepStrictEqual([up.status, /fake_upstream/.test(up.text)], [502, false], 'a provider 401 is not "sign in", and its body is not passed on');
  assert.strictEqual((await ada('POST', '/api/check/picture', { preview: { data: 'A'.repeat(18 * 1024 * 1024) } })).status, 413);
});

test('video: only frames arrive, at most 8, each checked; artefacts keep their frame', async () => {
  const frame = { data: jpegB64(), t: 1.5 };
  assert.strictEqual((await ada('POST', '/api/check/video', { frames: [] })).status, 400);
  assert.strictEqual((await ada('POST', '/api/check/video', { frames: Array(9).fill(frame) })).status, 400);
  assert.strictEqual((await ada('POST', '/api/check/video', { frames: [frame, { data: pngB64().slice(0, 10) }] })).status, 400);
  const r = await ada('POST', '/api/check/video', { frames: Array(6).fill(frame) });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.data.visual.artefacts.map((a) => a.frame), [1, 3]);
  assert.strictEqual(r.data.visual.frames, 6);
});

test('link: fetched through the guard, walls said plainly, no model call; the page image is metered', async () => {
  setFetcher({ resolve: NET.resolve, request: NET.request });
  const calls = await modelCalls();
  const r = await ada('POST', '/api/check/link', { url: 'https://example.com/post' });
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(r.data.text.startsWith('Heading') && r.data.quick && r.data.image === 'https://example.com/img/card.jpg');
  const li = await ada('POST', '/api/check/link', { url: 'https://www.linkedin.com/posts/x' });
  assert.deepStrictEqual([li.data.wall.message, li.data.text, li.data.quick], ['LinkedIn and X hide posts from servers. Paste the text, or use the Tells extension on the post.', '', null]);
  assert.strictEqual((await ada('POST', '/api/check/link', { url: 'http://example.com/post' })).status, 400);
  const priv = await ada('POST', '/api/check/link', { url: 'https://inside.example/' });
  assert.deepStrictEqual([priv.status, priv.data.code], [400, 'private-address']);
  assert.strictEqual((await ada('POST', '/api/check/link', { url: 'https://169.254.169.254/computeMetadata/v1/' })).status, 400);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'reading a link calls no model');
  const img = await ada('POST', '/api/check/link-image', { url: 'https://example.com/img/card.jpg' });
  assert.strictEqual(img.status, 200, img.text);
  assert.deepStrictEqual([img.data.meta.points, img.data.combined.driver], ['ai', 'meta']);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1);
});

let adaKey;
test('device keys: shown once, stored only as a hash, five at most, session-only to manage', async () => {
  const made = await ada('POST', '/api/devices', { label: '<b>Work</b> laptop' });
  assert.strictEqual(made.status, 200, made.text);
  adaKey = made.data.key;
  assert.match(adaKey, devicesLib.KEY_RE);
  assert.strictEqual(made.data.device.label, 'bWork/b laptop');
  const list = await ada('GET', '/api/devices');
  assert.ok(!list.text.includes(adaKey), 'the list never shows the key');
  assert.strictEqual(list.data.devices[0].id, devicesLib.hashKey(adaKey));
  const dump = store._dump();
  assert.ok(!dump.includes(adaKey) && !dump.includes(adaKey.slice(6, 30)), 'the key is nowhere in the store');
  assert.ok(dump.includes(crypto.createHash('sha256').update(adaKey).digest('hex')), 'only its SHA-256, as the id');
  for (let i = 0; i < 4; i++) assert.strictEqual((await ada('POST', '/api/devices', { label: `k${i}` })).status, 200);
  assert.strictEqual((await ada('POST', '/api/devices', { label: 'sixth' })).status, 409);
  const bearer = { Authorization: `Bearer ${adaKey}` };
  const anon = client();
  const me = await anon('GET', '/api/me', undefined, bearer);
  assert.deepStrictEqual([me.data.signedIn, me.data.email, me.data.via], [true, 'ada@example.com', 'device']);
  assert.strictEqual((await anon('POST', '/api/devices', { label: 'x' }, bearer)).status, 403, 'a key cannot make keys');
  assert.strictEqual((await anon('GET', '/api/devices', undefined, bearer)).status, 403);
  ben = await register('ben@example.com');
  assert.strictEqual((await ben('DELETE', `/api/devices/${devicesLib.hashKey(adaKey)}`)).status, 404, 'nobody else can revoke it');
});

test('device keys: a bearer check is charged to the key’s account and stopped when it is out of credit', async () => {
  const bearer = { Authorization: `Bearer ${adaKey}` };
  const anon = client();
  const before = await modelCalls();
  const spentBefore = (await identityStore.get('users', uidOf('ada@example.com'))).spentUsd;
  const r = await anon('POST', '/api/check/picture?format=text', { preview: { data: jpegB64() } }, bearer);
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  const rows = await usage();
  assert.strictEqual(rows.length, before + 1);
  assert.strictEqual(rows[rows.length - 1].uid, uidOf('ada@example.com'));
  assert.ok((await identityStore.get('users', uidOf('ada@example.com'))).spentUsd > spentBefore, 'Ada paid');
  await identityStore.merge('users', uidOf('ada@example.com'), { spentUsd: 100 });
  const broke = await anon('POST', '/api/check/deep', { text: TEMPLATED }, bearer);
  assert.strictEqual(broke.status, 402, 'out of credit: 402 before any model call');
  const bigBroke = await anon('POST', '/api/check/picture', { preview: { data: 'A'.repeat(18 * 1024 * 1024) } }, bearer);
  assert.strictEqual(bigBroke.status, 402, '402, not 413: the budget gate runs before the parser');
  await settle();
  assert.strictEqual(await modelCalls(), before + 1);
  assert.strictEqual((await anon('POST', '/api/scan', { text: TEMPLATED }, bearer)).status, 200, 'the quick scan stays free');
  await identityStore.merge('users', uidOf('ada@example.com'), { spentUsd: 0 });
});

test('device keys: revoked, unknown and malformed keys are 401; too fast is 429', async () => {
  const anon = client();
  const id = devicesLib.hashKey(adaKey);
  assert.strictEqual((await ada('DELETE', `/api/devices/${id}`)).status, 200);
  assert.strictEqual((await anon('GET', '/api/me', undefined, { Authorization: `Bearer ${adaKey}` })).status, 401, 'revoked');
  assert.strictEqual((await anon('POST', '/api/check/deep', { text: TEMPLATED }, { Authorization: `Bearer ${adaKey}` })).status, 401);
  assert.strictEqual((await anon('GET', '/api/me', undefined, { Authorization: `Bearer tells_${'A'.repeat(43)}` })).status, 401, 'unknown');
  assert.strictEqual((await anon('GET', '/api/me', undefined, { Authorization: 'Bearer nope' })).status, 401, 'malformed');
  assert.strictEqual((await ada('DELETE', `/api/devices/${id}`)).status, 404, 'twice is a 404');
  const fresh = (await ben('POST', '/api/devices', { label: 'phone' })).data.key;
  let last;
  for (let i = 0; i < 31; i++) last = await anon('GET', '/api/me', undefined, { Authorization: `Bearer ${fresh}` });
  assert.strictEqual(last.status, 429, '30 a minute per key');
});

test('nothing a user checked is stored or logged: the store holds device keys and nothing else', async () => {
  const dump = store._dump();
  const cols = JSON.parse(dump).map(([p]) => p);
  assert.deepStrictEqual([...new Set(cols)], ['devices'], `collections: ${cols.join(', ')}`);
  for (const needle of [SENTINEL, 'thrilled to announce', 'Heading', 'example.com/post', 'lessons-from-year-one', 'Automatic1111', 'dishwasher']) {
    assert.ok(!dump.includes(needle), `store: ${needle}`);
  }
  const identityDump = JSON.stringify([await identityStore.list('usage'), await identityStore.list('events'), await identityStore.list('users')]);
  for (const needle of [SENTINEL, 'thrilled to announce', 'example.com/post', 'dishwasher']) assert.ok(!identityDump.includes(needle), `identity: ${needle}`);
  const rows = await usage();
  assert.ok(rows.every((r) => r.app === 'tells' && r.inputTokens > 0 && !('text' in r)));
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use('/tells', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/tells`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
