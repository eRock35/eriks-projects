// Pure rules first (every detector, the normaliser, the guardrail, the score,
// suggested fixes, the evasion pack, the demo, import and export, rule-set
// checks and the AI's checks), then the worker and its watchdog in a real
// worker thread, then the page's own promises, then end to end against the
// memory store and the fake model:
//   SIEVE_MEMORY=1 SIEVE_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /sieve, the way the
// lab mounts it, so the auth cookie, the budget gate and each route's parser
// order are exercised as deployed. Model calls are counted from the identity
// usage rows, and what reached "the model" is read from the fake's own log.
//
// Every value here is fake: test card numbers, AWS's example key, example.com
// addresses (built with AT so no address is written into a file), 555-01xx
// phones, impossible SSNs.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const express = require('express');

if (process.env.SIEVE_MEMORY !== '1' || process.env.SIEVE_FAKE_AI !== '1') {
  console.error('run with SIEVE_MEMORY=1 SIEVE_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient, ownerTag } = require('../server');
const C = require('../public/sieve-core');
const D = require('../public/demo');
const Runner = require('../public/sieve-runner');
const ai = require('../lib/ai');
const fakeai = require('../lib/fakeai');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
// A live-key-shaped fake, joined at run time so no literal key sits in the repo
// (GitHub push protection reads one as a real Stripe key).
const LIVE_KEY = ['sk', 'live', 'realLookingKeyValue12345'].join('_');

/* ---------------- helpers ---------------- */

const W = (id, over) => Object.assign(C.detDefaults(id), over || {});
const find = (id, text, over) => C.detect(id, W(id, over), text).map((r) => text.slice(r[0], r[1]));
function engineFor(cases, rules) {
  const e = C.createEngine();
  e.cases({ cases });
  return { e, run: (r) => e.run({ rules: r || rules }) };
}
const only = (id, over) => { const r = C.defaults(); C.DET_IDS.forEach((k) => { r.det[k].on = k === id; }); Object.assign(r.det[id], over || {}); return r; };
const kase = (text, expect, spans, dir) => ({ id: 'k' + Math.abs(hash(text + expect)), text, expect, spans: spans || [], dir: dir || 'in' });
function hash(s) { let h = 7; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; }
function scoreOf(cases, rules) { return engineFor(cases, rules).run(); }
function outcomes(cases, rules) { return scoreOf(cases, rules).results.map((r) => r.outcome); }

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/* ================================================================== *
 * The detectors
 * ================================================================== */

test('cards: 13-19 digits with spaces or dashes; the Luhn check; word boundaries; a card running into the next number is cut back', () => {
  assert.deepStrictEqual(find('card', 'pay with 4111 1111 1111 1111 now'), ['4111 1111 1111 1111']);
  assert.deepStrictEqual(find('card', 'amex 3782-822463-10005.'), ['3782-822463-10005']);
  assert.deepStrictEqual(find('card', '4111111111111111'), ['4111111111111111']);
  assert.deepStrictEqual(find('card', 'order 4111-2222-3333-4444'), [], 'fails Luhn: not a card');
  assert.deepStrictEqual(find('card', 'order 4111-2222-3333-4444', { luhn: false }), ['4111-2222-3333-4444'], 'without Luhn it is caught');
  assert.deepStrictEqual(find('card', 'zero 0000 0000 0000 0000', { luhn: false }), [], 'one digit repeated is never a card');
  assert.deepStrictEqual(find('card', 'tracking 94001118992233445566778', { luhn: false }), [], 'inside a longer number, with boundaries');
  assert.ok(find('card', 'x94001111111111111111x', { luhn: false, wb: false }).length, 'without boundaries it matches inside');
  assert.deepStrictEqual(find('card', 'card 4111 1111 1111 1111 12/29'), ['4111 1111 1111 1111'], 'Luhn cuts off the expiry that ran on');
  assert.deepStrictEqual(find('card', 'twelve 4111 1111 1111'), [], 'twelve digits are too few');
  assert.deepStrictEqual(find('card', 'card 4111 1111\n1111 1111'), [], 'a line break stops it…');
  assert.deepStrictEqual(find('card', 'card 4111 1111\n1111 1111', { lines: true }), ['4111 1111\n1111 1111'], '…unless line breaks are allowed');
  assert.deepStrictEqual(find('card', 'card 4111 1111 1111 1111', { ctx: true }), ['4111 1111 1111 1111']);
  assert.deepStrictEqual(find('card', 'ref 4111 1111 1111 1111', { ctx: true }), [], 'no context word near it');
  assert.strictEqual(C.luhn('4242424242424242'), true);
  assert.strictEqual(C.luhn('4242424242424241'), false);
  assert.ok(C.TEST_CARDS.length >= 20 && C.TEST_CARDS.every(C.luhn), 'every documented test number passes Luhn');
});

test('IBANs: mod-97, spaces in groups, the right length chosen when words follow; lower case is not one', () => {
  assert.deepStrictEqual(find('iban', 'IBAN GB82 WEST 1234 5698 7654 32 thanks'), ['GB82 WEST 1234 5698 7654 32']);
  assert.deepStrictEqual(find('iban', 'IBAN NL91ABNA0417164300.'), ['NL91ABNA0417164300']);
  assert.deepStrictEqual(find('iban', 'IBAN GB82 WEST 1234 5698 7654 32 OK'), ['GB82 WEST 1234 5698 7654 32'], 'mod-97 picks the length that checks');
  assert.deepStrictEqual(find('iban', 'IBAN GB82 WEST 1234 5698 7654 33'), [], 'one digit off fails mod-97');
  assert.deepStrictEqual(find('iban', 'IBAN GB82 WEST 1234 5698 7654 33', { mod97: false }), ['GB82 WEST 1234 5698 7654 33']);
  assert.deepStrictEqual(find('iban', 'code AB12CDEFGHIJKLMNO', { mod97: false, wb: true }), ['AB12CDEFGHIJKLMNO'], 'shaped like one, without the check');
  assert.deepStrictEqual(find('iban', 'gb82 west 1234 5698 7654 32'), []);
  assert.ok(C.TEST_IBANS.length >= 10 && C.TEST_IBANS.every(C.mod97));
  assert.strictEqual(C.mod97('DE89 3704 0044 0532 0130 00'), true);
});

test('SSNs: dashes, or any one separator used twice; the impossible ranges (000, 666, 9xx, group 00, serial 0000) skipped when asked', () => {
  assert.deepStrictEqual(find('ssn', 'SSN 219-09-9999'), ['219-09-9999']);
  assert.deepStrictEqual(find('ssn', 'SSN 219 09 9999 and 078.05.1120'), ['219 09 9999', '078.05.1120']);
  assert.deepStrictEqual(find('ssn', 'SSN 219 09 9999', { seps: 'dash' }), [], 'dashes only');
  assert.deepStrictEqual(find('ssn', 'mixed 219-09 9999'), [], 'one separator, used twice');
  assert.deepStrictEqual(find('ssn', '219099999 bare'), [], 'nine bare digits are not taken for one');
  for (const bad of ['000-12-3456', '666-12-3456', '900-12-3456', '999-12-3456', '123-00-4567', '123-45-0000']) {
    assert.deepStrictEqual(find('ssn', bad), [], bad + ' cannot exist');
    assert.deepStrictEqual(find('ssn', bad, { strict: false }), [bad], bad + ' still has the shape');
  }
  assert.strictEqual(C.ssnValid('078-05-1120'), true);
  assert.deepStrictEqual(find('ssn', 'id 1219-09-99999'), [], 'inside longer numbers');
});

test('emails, phones (NANP formats and E.164, or any run of digits), IPv4 (with private ranges optional)', () => {
  assert.deepStrictEqual(find('email', `mail dana.r${AT}example.com, or sam+tag${AT}mail.example.org.`), [`dana.r${AT}example.com`, `sam+tag${AT}mail.example.org`]);
  assert.deepStrictEqual(find('email', `not one: dana${AT}localhost or ${AT}example.com`), []);
  assert.deepStrictEqual(find('phone', 'call (303) 555-0142, 303.555.0199 or +1 303 555 0187 or +442079460958'), ['(303) 555-0142', '303.555.0199', '+1 303 555 0187', '+442079460958']);
  assert.deepStrictEqual(find('phone', 'FedEx 7712 3456 7890'), [], 'a 4-4-4 tracking number is no phone format');
  assert.deepStrictEqual(find('phone', 'FedEx 7712 3456 7890', { mode: 'loose' }), ['7712 3456 7890'], 'a loose rule takes it');
  assert.deepStrictEqual(find('phone', 'card 4111 1111 1111 1111', { mode: 'loose' }), [], 'a phone never stops inside a longer number');
  assert.deepStrictEqual(find('phone', 'order 2048157', { mode: 'loose' }), []);
  assert.deepStrictEqual(find('phone', 'order 2048157', { mode: 'loose', min: 7 }), ['2048157'], 'the minimum length is a tuning knob');
  assert.deepStrictEqual(find('ipv4', 'host 203.0.113.7 and 10.0.0.1'), ['203.0.113.7', '10.0.0.1']);
  assert.deepStrictEqual(find('ipv4', 'host 203.0.113.7 and 10.0.0.1 and 8.8.8.8', { priv: true }), ['8.8.8.8'], 'documentation and private ranges skipped');
  assert.deepStrictEqual(find('ipv4', 'version 1.2.3.4.5 and 256.1.1.1'), [], 'five parts, or an octet over 255');
});

test('keys and tokens: AWS (AKIA/ASIA + 16), GitHub, Slack, Stripe live keys, private key blocks, JWTs whose header decodes to JSON with "alg"', () => {
  assert.deepStrictEqual(find('aws', "key='AKIAIOSFODNN7EXAMPLE' and ASIAIOSFODNN7EXAMPLE"), ['AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE']);
  assert.deepStrictEqual(find('aws', 'AKIAIOSFODNN7EXAMPL short, xAKIAIOSFODNN7EXAMPLE inside'), []);
  assert.deepStrictEqual(find('github', 'ghp_EXAMPLE00000000000000000000000000000 and github_pat_11EXAMPLE0000000000000000_x'), ['ghp_EXAMPLE00000000000000000000000000000', 'github_pat_11EXAMPLE0000000000000000_x']);
  assert.deepStrictEqual(find('github', 'ghp_short'), []);
  assert.deepStrictEqual(find('slack', 'xoxb-1234-EXAMPLE-fakeToken xoxz-1234567890'), ['xoxb-1234-EXAMPLE-fakeToken']);
  assert.deepStrictEqual(find('stripe', 'sk_live_EXAMPLEnotARealKey0000 rk_live_EXAMPLE12345 sk_test_EXAMPLE12345 sk_live'), ['sk_live_EXAMPLEnotARealKey0000', 'rk_live_EXAMPLE12345']);
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpEXAMPLE\n-----END RSA PRIVATE KEY-----';
  assert.deepStrictEqual(find('privkey', `cfg:\n${key}\nend`), [key]);
  assert.deepStrictEqual(find('privkey', '-----BEGIN PRIVATE KEY-----\nMIIEtruncated'), ['-----BEGIN PRIVATE KEY-----\nMIIEtruncated'], 'with no END, to the end of the message');
  assert.deepStrictEqual(find('privkey', '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----'), [], 'a public key is not secret');
  const head = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), pay = Buffer.from('{"sub":"x"}').toString('base64url');
  const jwt = `${head}.${pay}.EXAMPLEsig`;
  assert.deepStrictEqual(find('jwt', `token=${jwt} end`), [jwt]);
  const noalg = `${Buffer.from('{"typ":"JWT"}').toString('base64url')}.${pay}.sig`;
  assert.deepStrictEqual(find('jwt', `t=${noalg}`), [], 'header without "alg"');
  assert.deepStrictEqual(find('jwt', `t=${noalg}`, { alg: false }), [noalg], 'the header check is a switch');
  assert.deepStrictEqual(find('jwt', 't=eyJub3Rqc29u.eyJ4.sig'), [], 'header that is not JSON');
  assert.strictEqual(C.jwtHeaderOk(jwt), true);
});

test('hostile input: every built-in pattern stays linear on 8 KB of the worst text for it', () => {
  const bad = ['a'.repeat(8000), '1'.repeat(8000), '1 '.repeat(4000), `${'a.'.repeat(3990)}${AT}`, 'eyJ' + 'a'.repeat(7990), '-----BEGIN PRIVATE KEY-----'.repeat(290), 'GB82 '.repeat(1600), '1.1.1.'.repeat(1300), ('xoxb-' + 'a'.repeat(30) + ' ').repeat(220)];
  const t0 = Date.now();
  for (const text of bad) for (const id of C.DET_IDS) { C.detect(id, W(id, { mode: 'loose', luhn: false, mod97: false, strict: false, alg: false }), text); C.detect(id, W(id), text); }
  assert.ok(Date.now() - t0 < 4000, `all detectors on hostile 8 KB texts in ${Date.now() - t0} ms`);
  const many = C.detect('card', W('card', { luhn: false }), '4111 1111 1111 1111 '.repeat(400));
  assert.strictEqual(many.length, C.LIMITS.matchesPerCase, 'matches per case are capped');
});

/* ================================================================== *
 * The normaliser, the guardrail and the score
 * ================================================================== */

test('the normaliser: NFKC, zero-width, look-alikes, %-escapes and base64 - and every match is mapped back onto the text as it arrived', () => {
  const fw = 'card ４１１１ １１１１ １１１１ １１１１ ok';
  const n = C.normalise(fw, { nfkc: true });
  assert.strictEqual(n.t, 'card 4111 1111 1111 1111 ok');
  const hit = C.detect('card', W('card'), n.t)[0];
  const [s, e] = [n.S[hit[0]], n.E[hit[1] - 1]];
  assert.strictEqual(fw.slice(s, e), '４１１１ １１１１ １１１１ １１１１', 'the match is on the original characters');
  const zw = 'x\u200Bo\u200Bx\u200Bb-1234-EXAMPLE-fake';
  assert.strictEqual(C.normalise(zw, { zw: true }).t, 'xoxb-1234-EXAMPLE-fake');
  assert.strictEqual(C.normalise('АКІАІОЅFODNN7EXAMPLE', { homo: true }).t, 'AKIAIOSFODNN7EXAMPLE', 'Cyrillic look-alikes folded');
  assert.strictEqual(C.normalise('%34%31%31%31', { url: true }).t, '4111');
  const b = C.normalise('x ' + C.b64encode('4111 1111 1111 1111') + ' y', { b64: true });
  assert.ok(b.t.includes('4111 1111 1111 1111'), 'base64 read as its decoded text');
  const head = Buffer.from('{"alg":"HS256"}').toString('base64url');
  const jwt = `${head}.${Buffer.from('{"sub":"user-1","n":"abc"}').toString('base64url')}.sig`;
  assert.strictEqual(C.normalise(jwt, { b64: true }).t, jwt, 'a JWT part is never decoded in place');
  assert.deepStrictEqual(C.normalise('plain', { nfkc: true, zw: true, homo: true, url: true, b64: true }), { t: 'plain', S: null, E: null }, 'unchanged text carries no map');
});

test('the guardrail: block beats redact beats flag; directions; the allow-list wins over every rule; redaction text', () => {
  const r = C.defaults();
  r.det.email.act = 'redact'; r.det.card.act = 'block'; r.det.phone.act = 'flag';
  const text = `mail me ${AT}x: dana.r${AT}example.com, call (303) 555-0142`;
  const c1 = kase(text, 'redact', [`dana.r${AT}example.com`]);
  const out = scoreOf([c1], r).results[0];
  assert.strictEqual(out.actual, 'redact', 'a flag lets it through');
  assert.strictEqual(out.outcome, 'correct');
  assert.strictEqual(C.outputOf(C.cleanCase(c1).case, out), `mail me ${AT}x: [REDACTED:email-addresses], call (303) 555-0142`);
  const c2 = kase('card 4111 1111 1111 1111 and dana.r' + AT + 'example.com', 'block', ['4111 1111 1111 1111']);
  assert.strictEqual(scoreOf([c2], r).results[0].actual, 'block');
  r.det.card.dir = 'in';
  assert.strictEqual(scoreOf([Object.assign({}, c2, { dir: 'out' })], r).results[0].actual, 'redact', 'an input-only rule does not read output');
  const allowed = C.clone(r);
  allowed.allow.push({ id: 'a1', name: 'Our address', kind: 'text', src: `dana.r${AT}EXAMPLE.com`, on: true });
  const res = scoreOf([kase(`write to dana.r${AT}example.com`, 'pass')], allowed).results[0];
  assert.deepStrictEqual([res.actual, res.outcome, res.dets[0].allowed, res.dets[0].by], ['pass', 'correct', true, 'a:a1'], 'the allow-list (any case) wins');
  const rx = C.clone(r);
  rx.allow.push({ id: 'a2', name: 'Orders', kind: 'regex', src: '\\bORD-\\d{16}\\b', on: true });
  rx.det.card.dir = 'both';
  assert.strictEqual(scoreOf([kase('quote ORD-8812004410093317', 'pass')], rx).results[0].actual, 'pass');
  assert.strictEqual(scoreOf([kase('quote 8812004410093317', 'pass')], rx).results[0].actual, 'block', 'without the prefix the allow-list does not apply');
});

test('the score: Leak, Partial, Break and Correct, judged span by span; separators at a span\u2019s edge do not count', () => {
  const r = C.defaults();
  r.det.ssn.seps = 'dash';
  const cases = [
    kase(`Jordan (jordan.p${AT}example.net), SSN 219 09 9999`, 'redact', [`jordan.p${AT}example.net`, '219 09 9999']),
    kase('SSN 219 09 9999', 'redact', ['219 09 9999']),
    kase(`legit: help${AT}example.com`, 'pass'),
    kase('card 4111 1111 1111 1111', 'redact', ['4111 1111 1111 1111']),
    kase(`dana.r${AT}example.com`, 'redact', [` dana.r${AT}example.com`.trim()]),
    kase('key AKIAIOSFODNN7EXAMPLE', 'block', ['AKIAIOSFODNN7EXAMPLE']),
    kase(`x dana.r${AT}example.com`, 'block', [`dana.r${AT}example.com`]),
    kase('nothing here', 'block', ['nothing']),
    kase(`a ${AT} b dana.r${AT}example.com and more help${AT}example.org`, 'redact', [`dana.r${AT}example.com`]),
  ];
  const out = scoreOf(cases, r);
  assert.deepStrictEqual(out.results.map((x) => x.outcome), ['partial', 'leak', 'break', 'break', 'correct', 'correct', 'partial', 'leak', 'break']);
  assert.match(out.results[3].why, /only needed redacting/);
  assert.match(out.results[6].why, /should have been blocked/);
  assert.match(out.results[8].why, /also redacted text that is not sensitive/);
  assert.deepStrictEqual([out.score.leak, out.score.partial, out.score.break, out.score.correct, out.score.total], [2, 2, 3, 2, 9]);
  assert.strictEqual(C.scoreLine(out.score), 'Leaks 2 · Partial 2 · Breaks 3 · 2 correct of 9');
  assert.strictEqual(out.score.rules['d:email'].breaks, 2, 'the email rule caused two breaks');
  assert.strictEqual(out.score.rules['d:card'].breaks, 1);
  assert.ok(out.score.uncaught.some((u) => u.cat === 'govid'), 'the SSN no rule caught is listed by kind');
  assert.strictEqual(out.score.cats.govid.recall, 0);
  assert.ok(out.score.cats.contact.precision > 0 && out.score.cats.contact.precision < 1, 'precision counts the support address against the email rule');
});

/* ================================================================== *
 * Suggested fixes, the demo, the evasion pack
 * ================================================================== */

test('suggested fixes: concrete, simulated before they are offered, never adding a leak, with their effect in words', () => {
  const r = C.defaults();
  r.det.card.luhn = false;
  const cases = [kase('order 4111-2222-3333-4444', 'pass'), kase('card 4111 1111 1111 1111', 'block', ['4111 1111 1111 1111']), kase('SN 2024-1188-0042-7731', 'pass')];
  const { e } = engineFor(cases, r);
  const out = e.run({ rules: r });
  const luhn = out.suggestions.find((s) => s.id === 'luhn');
  assert.ok(luhn, out.suggestions.map((s) => s.title).join(' | '));
  assert.strictEqual(luhn.title, 'Turn on the Luhn check for cards');
  assert.match(luhn.why, /4111-2222-3333-4444 fails it/);
  assert.strictEqual(luhn.line, '−2 breaks, no new leaks');
  assert.deepStrictEqual(luhn.patch, { det: { card: { luhn: true } } });
  // A change that would add a leak is never offered: Luhn on, when a sensitive "card" in the set fails it.
  const tricky = [kase('order 4111-2222-3333-4444', 'pass'), kase('my card 4111 1111 1111 1112 typo', 'block', ['4111 1111 1111 1112'])];
  assert.ok(!engineFor(tricky, r).run().suggestions.some((s) => s.id === 'luhn'), 'Luhn would let the mistyped card through, so it is not suggested');
  // An id prefix becomes an allow-list pattern covering every length seen.
  const ids = [kase('ref ORD-8812004410093317', 'pass'), kase('ref ORD-378282246310005', 'pass')];
  const allow = engineFor(ids, C.defaults()).run().suggestions.find((s) => s.patch.addAllow);
  assert.strictEqual(allow.title, 'Add an allow-list rule ORD-\\d{15,16}');
  assert.strictEqual(allow.patch.addAllow[0].src, '\\bORD\\-\\d{15,16}\\b');
  assert.strictEqual(new RegExp(allow.patch.addAllow[0].src).test('ORD-8812004410093317'), true);
  assert.deepStrictEqual(C.idPattern('ORD-8812004410093317'), { prefix: 'ORD', sep: '-', n: 16 });
  assert.strictEqual(C.idPattern('4111-2222-3333-4444'), null);
});

test('the demo: a naive guardrail scoring Leaks 6 · Partial 1 · Breaks 8 - and the suggested fixes, one tap each, reach 0 and 0', () => {
  const cases = D.cases();
  assert.strictEqual(cases.length, 40);
  const rules = D.rules(C.defaults);
  const { e } = engineFor(cases, rules);
  let out = e.run({ rules });
  assert.strictEqual(C.scoreLine(out.score), 'Leaks 6 · Partial 1 · Breaks 8 · 25 correct of 40');
  const want = { j01: 'break', j02: 'break', j03: 'break', j04: 'break', j05: 'break', j06: 'break', j07: 'break', j08: 'break', j28: 'partial', j30: 'leak', j31: 'leak', j32: 'leak', j33: 'leak', j34: 'leak', j35: 'leak' };
  out.results.forEach((r) => assert.strictEqual(r.outcome, want[r.id] || 'correct', r.id));
  assert.strictEqual(out.score.flagged, 1, 'the competitor mention is flagged, not blocked');
  // The first Break - the hint's - has its own fix: the Luhn check.
  const first = out.results.find((r) => r.outcome === 'break');
  assert.strictEqual(first.id, 'j01');
  assert.ok(out.suggestions.some((s) => s.id === 'luhn' && s.ids.includes('j01')));
  const titles = out.suggestions.map((s) => s.title);
  for (const t of ['Turn on the 3 detectors that are off: JWTs, IBANs and private keys', 'Turn on the normaliser', 'Add an allow-list rule ORD-\\d{16}', 'Check the agent’s output for AWS keys too', `Add an allow-list entry for help${AT}juniper.example.com`, 'Allow spaces and dots in SSNs', 'Turn on the Luhn check for cards', 'Match phone numbers by their formats (NANP and E.164)']) assert.ok(titles.includes(t), t);
  assert.ok(out.suggestions.every((s) => /no new leaks$/.test(s.line)), 'every one is safe');
  assert.match(out.suggestions.find((s) => s.id === 'norm').why, /1 leak used full-width digits; 1 leak hid zero-width characters/);
  // Tap the top one, again and again.
  let r = rules, taps = 0;
  while (out.suggestions.length && taps < 12) { r = C.applyPatch(r, out.suggestions[0].patch); out = e.run({ rules: r }); taps++; }
  assert.strictEqual(C.scoreLine(out.score), 'Leaks 0 · Breaks 0 · 40 correct of 40');
  assert.ok(taps <= 8, `${taps} taps`);
  assert.strictEqual(out.score.flagged, 1);
  // "Apply every safe fix" does the same in one.
  const all = e.fixall({ rules });
  assert.strictEqual(all.applied.length, 8);
  assert.strictEqual(C.scoreLine(e.run({ rules: all.rules }).score), 'Leaks 0 · Breaks 0 · 40 correct of 40');
  // Every value in the demo is fake by the AI's own standard.
  cases.forEach((c) => assert.strictEqual(C.realLooking(c.text), '', `${c.id}: ${C.realLooking(c.text)}`));
});

test('attack my rules: ten tricks from each caught case, spans carried; the normaliser and deep decoding measured; words and reversed survive', () => {
  const c = C.cleanCase({ id: 'x', text: 'card 4111 1111 1111 1111 ok', expect: 'block', spans: ['4111 1111 1111 1111'] }).case;
  const vs = C.variantsOf(c, 0);
  assert.deepStrictEqual(vs.map((v) => v.trick), C.TRICK_IDS.filter((x) => x !== 'homoglyph'), 'every trick that fits digits (look-alike letters need letters)');
  assert.ok(C.variantsOf(C.cleanCase({ id: 'k', text: 'key AKIAIOSFODNN7EXAMPLE', expect: 'block', spans: ['AKIAIOSFODNN7EXAMPLE'] }).case, 0).some((v) => v.trick === 'homoglyph'));
  for (const v of vs) {
    const sp = v.spans[0];
    assert.ok(v.text.startsWith('card ') && v.text.endsWith(' ok'), v.trick);
    assert.ok(sp[1] > sp[0] && sp[1] <= v.text.length, v.trick);
  }
  const by = Object.fromEntries(vs.map((v) => [v.trick, v.text.slice(v.spans[0][0], v.spans[0][1])]));
  assert.strictEqual(by.fullwidth, '４１１１ １１１１ １１１１ １１１１');
  assert.strictEqual(by.zerowidth.split('\u200B').join(''), '4111 1111 1111 1111');
  assert.strictEqual(by.urlenc.slice(0, 6), '%34%31');
  assert.strictEqual(by.base64, C.b64encode('4111 1111 1111 1111'));
  assert.ok(by.words.startsWith('four one one one'));
  assert.strictEqual(by.reversed, '1111 1111 1111 1114');
  const { e } = engineFor(D.cases(), null);
  const fixed = e.fixall({ rules: D.rules(C.defaults) }).rules;
  const a = e.attack({ rules: fixed });
  const t = Object.fromEntries(a.tricks.map((x) => [x.trick, x]));
  assert.ok(a.tried >= 100 && a.from >= 14, `${a.tried} variants of ${a.from} cases`);
  assert.deepStrictEqual([t.fullwidth.now, t.zerowidth.now, t.homoglyph.now], [0, 0, 0], 'the fixed rules have the normaliser on');
  assert.ok(t.base64.now === t.base64.tried && t.base64.deep === 0, 'base64 gets through until decoding is on');
  assert.ok(t.urlenc.now === t.urlenc.tried && t.urlenc.deep === 0);
  assert.ok(t.words.deep >= 10 && t.reversed.deep >= 10, 'no normaliser reads words or reversed text');
  assert.ok(a.deepSurvive < a.normSurvive && a.normSurvive <= a.survive);
  const naive = e.attack({ rules: D.rules(C.defaults) });
  const tn = Object.fromEntries(naive.tricks.map((x) => [x.trick, x]));
  assert.ok(tn.fullwidth.now > 0 && tn.fullwidth.norm === 0, 'what the normaliser buys, measured');
  assert.ok(a.survivors.every((s) => s.v.src === 'attack' && C.cleanCase(s.v).case), 'survivors come back as ordinary cases');
});

/* ================================================================== *
 * Import and export, rule sets, the AI's checks
 * ================================================================== */

test('import: CSV (quotes, offsets or substrings, Sieve\u2019s own formula guard undone), JSONL, a JSON array; problems said; caps', () => {
  const csv = 'text,direction,expect,spans\r\n"Card is 4111 1111 1111 1111, ok",input,block,4111 1111 1111 1111\r\n"hi ""there""",output,pass,\r\n"SSN 219-09-9999",in,redact,4-15\r\n"\'=SUM(1)",input,pass,\r\n"x",sideways,pass,\r\n';
  const r = C.parseCases(csv);
  assert.strictEqual(r.format, 'csv');
  assert.deepStrictEqual(r.cases.map((c) => [c.dir, c.expect, c.spans]), [['in', 'block', [[8, 27]]], ['out', 'pass', []], ['in', 'redact', [[4, 15]]], ['in', 'pass', []]]);
  assert.strictEqual(r.cases[1].text, 'hi "there"');
  assert.strictEqual(r.cases[3].text, '=SUM(1)', 'the leading quote Sieve adds on export comes off');
  assert.strictEqual(r.skipped, 1);
  assert.match(r.problems[0], /Row 6: the direction is input or output/);
  const jl = C.parseCases('{"text":"a dana.r' + AT + 'example.com b","direction":"output","expect":"redact","spans":[[2,20]]}\n{"text":"x","expect":"maybe"}\nnot json\n');
  assert.deepStrictEqual([jl.format, jl.cases.length, jl.skipped], ['jsonl', 1, 2]);
  assert.deepStrictEqual(jl.cases[0].spans, [[2, 20]]);
  const arr = C.parseCases(JSON.stringify([{ text: 'k AKIAIOSFODNN7EXAMPLE', dir: 'out', expect: 'block', spans: ['AKIAIOSFODNN7EXAMPLE'] }]));
  assert.deepStrictEqual([arr.format, arr.cases[0].spans], ['json', [[2, 22]]]);
  const big = C.parseCases(JSON.stringify([{ text: 'x'.repeat(9000) }, { text: 'é'.repeat(4100) }, { text: 'ok' }]));
  assert.deepStrictEqual([big.cases.length, big.skipped], [1, 2], 'over 8 KB (in UTF-8 bytes) is left out');
  const many = C.parseCases(Array.from({ length: 2100 }, (_, i) => JSON.stringify({ text: 'case ' + i })).join('\n'));
  assert.deepStrictEqual([many.cases.length, many.skipped], [C.LIMITS.cases, 100]);
  assert.match(C.parseCases('just,some\nrows,here\n').problems[0], /No "text" column/);
});

test('export round trips: the test set as JSONL and CSV, the rule set as JSON; CSV cells cannot run as formulas', () => {
  const cases = D.cases().map((c, i) => C.cleanCase(c, i).case).concat([C.cleanCase({ id: 'f', text: '=HYPERLINK("http://x","y") +1 -2 @3', expect: 'pass' }).case, C.cleanCase({ id: 'g', text: '-card 4111 1111 1111 1111\n\tsecond line', expect: 'block', spans: ['4111 1111 1111 1111'] }).case]);
  const strip = (l) => l.map((c) => [c.text, c.dir, c.expect, c.spans]);
  assert.deepStrictEqual(strip(C.parseCases(C.exportJsonl(cases)).cases), strip(cases), 'JSONL');
  const csv = C.exportCsv(cases);
  assert.deepStrictEqual(strip(C.parseCases(csv).cases), strip(cases), 'CSV');
  const lines = C.parseCsv(csv).rows;
  for (const row of lines) for (const cell of row) assert.ok(!/^[=+\-@\t\r]/.test(cell), `a cell starts with a formula character: ${cell.slice(0, 20)}`);
  assert.strictEqual(C.csvCell('=1+1'), "'=1+1");
  assert.strictEqual(C.csvCell('a,"b"'), '"a,""b"""');
  const rules = C.applyPatch(D.rules(C.defaults), { normalise: C.FULL_NORM, addAllow: [{ id: 'a9', name: 'Orders', kind: 'regex', src: '\\bORD-\\d{16}\\b', on: true }] });
  const back = C.importRules(C.exportRules(rules));
  assert.deepStrictEqual(back.rules, C.cleanRules(rules).rules, 'the rule set round-trips');
  assert.match(C.importRules('{"nope":1}').error, /not a Sieve rule set/);
  assert.match(C.importRules('not json').error, /not JSON/);
});

test('the run report (Markdown): scoreboard, rules, every leak and break - with every value masked and shortened', () => {
  const cases = D.cases().map((c, i) => C.cleanCase(c, i).case);
  const { e } = engineFor(cases, null);
  const rules = D.rules(C.defaults);
  const run = e.run({ rules });
  const md = C.reportMarkdown(cases, rules, run, '2026-11-01');
  assert.match(md, /^# Sieve report - Juniper Outfitters support agent/);
  assert.ok(md.includes('**Leaks 6 · Partial 1 · Breaks 8 · 25 correct of 40**'));
  assert.ok(md.includes('| Payment cards | Block | Both |'));
  assert.ok(md.includes('## Leaks (6)') && md.includes('## Breaks (8)') && md.includes('## Partial (1)'));
  for (const v of ['AKIAIOSFODNN7EXAMPLE', '4111 1111 1111 1111', 'GB82', 'NL91 ABNA 0417 1643 00', '219 09 9999', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'MIIEpAIBAAKCAQEA0EXAMPLE', `dana.r${AT}example.com`, `jordan.p${AT}example.net`, '8812004410093317']) assert.ok(!md.includes(v), `${v} is in the report`);
  assert.ok(md.includes('AK••••••••••••••••LE'), 'a value is shortened to its ends');
  assert.ok(!/<[a-z]/i.test(md.replace(/\\</g, '')), 'no raw markup');
  const hostile = [C.cleanCase({ id: 'h', text: '<img src=x onerror=alert(1)> | ` * [x](javascript:1) card 4111 1111 1111 1111', expect: 'block', spans: ['4111 1111 1111 1111'] }).case];
  const md2 = C.reportMarkdown(hostile, C.defaults(), engineFor(hostile, C.defaults()).run(), 'x');
  assert.ok(!md2.includes('<img') && !md2.includes('](javascript'), 'text from a case cannot write markup into the report');
});

test('rule sets: strict cleaning refuses unknown fields, oversize lists, bad regexes and anything carrying a secret; merge keeps both sides\u2019 rules', () => {
  const ok = C.cleanRules(D.rules(C.defaults), true);
  assert.deepStrictEqual(ok.errors, []);
  const bad = (mut) => { const r = JSON.parse(JSON.stringify(D.rules(C.defaults))); mut(r); return C.cleanRules(r, true).errors; };
  assert.match(bad((r) => { r.cases = [{ text: 'x' }]; })[0], /Unknown field "cases"/);
  assert.match(bad((r) => { r.det.card.sample = '4111'; })[0], /unknown option "sample"/);
  assert.match(bad((r) => { r.det.nope = {}; })[0], /Unknown detector/);
  assert.match(bad((r) => { r.custom[0].src = '(unclosed'; })[0], /Gift card codes: /);
  assert.match(bad((r) => { r.custom[0].src = 'x'.repeat(500); })[0], /longer than 400/);
  assert.match(bad((r) => { r.custom = Array.from({ length: 41 }, (_, i) => ({ name: 'r' + i, src: 'a' })); })[0], /At most 40/);
  for (const [secret, what] of [['4111 1111 1111 1111', 'card'], ['4111111111111111', 'card'], ['AKIAIOSFODNN7EXAMPLE', 'AWS'], ['GB82WEST12345698765432', 'IBAN'], ['219-09-9999', 'Social Security'], ['219099999', 'Social Security'], ['ghp_EXAMPLE00000000000000000000000000000', 'GitHub'], ['xoxb-1234-EXAMPLE-fakeToken', 'Slack'], ['sk_live_EXAMPLEnotARealKey0000', 'Stripe'], ['-----BEGIN PRIVATE KEY-----', 'private key']]) {
    assert.match(bad((r) => { r.custom[1].words = ['REI', secret]; }).join(' '), new RegExp(what), `a keyword holding ${what}`);
    assert.match(bad((r) => { r.allow = [{ name: 'x', kind: 'text', src: secret }]; }).join(' '), new RegExp(what), `an allow-list entry holding ${what}`);
    assert.match(bad((r) => { r.custom[0].name = 'see ' + secret; }).join(' '), new RegExp(what), `a name holding ${what}`);
  }
  assert.deepStrictEqual(bad((r) => { r.allow = [{ name: 'Our address', kind: 'text', src: `help${AT}juniper.example.com` }, { name: 'Orders', kind: 'regex', src: '\\bORD-\\d{16}\\b' }]; }), [], 'patterns and your own support address are fine');
  // Merge: this device's settings, plus what only the account had.
  const local = C.clone(D.rules(C.defaults)); local.det.card.luhn = true;
  const acc = C.clone(D.rules(C.defaults)); acc.allow = [{ id: 'a1', name: 'Orders', kind: 'regex', src: '\\bORD-\\d{16}\\b', on: true }]; acc.custom.push({ id: 'u9', name: 'Tickets', kind: 'regex', src: 'JUN-\\d{4}', act: 'flag', dir: 'both', on: true });
  const m = C.mergeRules(acc, local);
  assert.deepStrictEqual([m.added, m.rules.det.card.luhn, m.rules.allow.length, m.rules.custom.length], [2, true, 1, 3]);
});

test('the AI request is a category and one sentence; a description with data in it is refused; what comes back must be obviously fake', () => {
  assert.deepStrictEqual(C.aiRequest({ category: 'keys', about: '  A support bot\u202E for an outdoor shop ' }).req, { category: 'keys', about: 'A support bot for an outdoor shop' });
  assert.deepStrictEqual(C.aiRequest({ category: 'cards' }).req, { category: 'cards', about: '' });
  for (const bad of [{}, { category: 'all' }, { category: 'cards', cases: [] }, { category: 'cards', rules: {} }, { category: 'cards', about: 'x'.repeat(161) }, { category: 'cards', about: 5 }, []]) assert.ok(C.aiRequest(bad).error, JSON.stringify(bad).slice(0, 60));
  for (const about of [`bot, escalations to ops${AT}example.com`, 'bot for card 4111 1111 1111 1111', 'bot with key AKIAIOSFODNN7EXAMPLE', 'ring (303) 555-0142', 'order 20481577221', 'ssn 219-09-9999', 'host 203.0.113.9', 'bot with ４１１１ １１１１ １１１１ １１１１']) {
    const r = C.aiRequest({ category: 'cards', about });
    assert.ok(r.error && r.code === 'data-in-description', about);
  }
  // What may come back.
  const real = ['4539', '1488', '0343', '6467'].join(' ');
  for (const [text, why] of [[`card ${real}`, /Luhn/], ['key AKIAABCDEFGHIJKLMNOP', /EXAMPLE/], [`mail real${AT}gmail.com`, /example/], ['call 212-555-1234', /555-01xx/], ['host 8.8.4.4', /public IP/], ['SSN 123-44-5678', /SSN/], ['IBAN DE44 5001 0517 5407 3249 31', /IBAN/], [LIVE_KEY, /Stripe/]]) assert.match(C.realLooking(text), why, text);
  for (const ok of ['card 4242 4242 4242 4242', 'order 4111-2222-3333-4444', 'AKIAIOSFODNN7EXAMPLE', `x${AT}support.example.org`, '(303) 555-0142', '+1 212 555 0174', 'SSN 900-12-3456', 'GB82 WEST 1234 5698 7654 32', '198.51.100.4']) assert.strictEqual(C.realLooking(ok), '', ok);
  for (const [cat, set] of Object.entries(fakeai.SETS)) assert.strictEqual(C.cleanAiCases({ cases: set }, { category: cat }).cases.length, set.length, `the fake's ${cat} set is all clean`);
  const out = C.cleanAiCases({ cases: [{ text: 'card 4242 4242 4242 4242', direction: 'input', expect: 'block', sensitive: ['4242 4242 4242 4242', 'not there'], why: 'ok' }, { text: 'x', direction: 'input', expect: 'redact', sensitive: ['nope'] }, { text: '<b>bold</b>', direction: 'input', expect: 'pass', sensitive: [] }] });
  assert.deepStrictEqual(out.cases.map((c) => [c.dir, c.expect, c.spans, c.src]), [['in', 'block', [[5, 24]], 'ai']]);
  assert.strictEqual(out.dropped.length, 2);
});

/* ================================================================== *
 * The worker and its watchdog, in a real worker thread
 * ================================================================== */

function spawnWorker() {
  const w = new Worker(`
    const { parentPort } = require('worker_threads'); const fs = require('fs'); const vm = require('vm'); const path = require('path');
    const dir = ${JSON.stringify(PUB)};
    global.self = global; global.module = undefined; global.exports = undefined;
    global.importScripts = (...f) => f.forEach((x) => vm.runInThisContext(fs.readFileSync(path.join(dir, x), 'utf8'), { filename: x }));
    global.postMessage = (m) => parentPort.postMessage(m);
    global.addEventListener = (t, fn) => { if (t === 'message') parentPort.on('message', (data) => fn({ data })); };
    vm.runInThisContext(fs.readFileSync(path.join(dir, 'sieve-worker.js'), 'utf8'), { filename: 'sieve-worker.js' });
  `, { eval: true });
  return { postMessage: (m) => w.postMessage(m), terminate: () => w.terminate(), addEventListener: (t, fn) => { if (t === 'message') w.on('message', (data) => fn({ data })); if (t === 'error') w.on('error', fn); } };
}

test('the worker runs the real engine; a catastrophic regex is stopped by the watchdog, named, skipped - and the run still finishes', async () => {
  let spawned = 0;
  const run = Runner.create({ spawn: () => { spawned++; return spawnWorker(); }, ruleMs: 400, runMs: 15000 });
  try {
    await run.setCases(D.cases().concat([{ id: 'evil', text: 'a'.repeat(36) + '!', expect: 'pass' }]));
    const rules = D.rules(C.defaults);
    const first = await run.call('run', { rules });
    assert.strictEqual(C.scoreLine(first.score), 'Leaks 6 · Partial 1 · Breaks 8 · 26 correct of 41');
    assert.deepStrictEqual(first.timedOut, []);
    rules.custom.push({ id: 'u3', name: 'Nested groups', kind: 'regex', src: '(a+)+$', flags: '', act: 'redact', dir: 'both', on: true });
    const t0 = Date.now();
    const out = await run.call('run', { rules });
    const ms = Date.now() - t0;
    assert.ok(ms < 6000, `the run came back in ${ms} ms`);
    assert.deepStrictEqual(out.timedOut.map((t) => t.name), ['Nested groups']);
    assert.ok(out.skipped.some((s) => s.name === 'Nested groups'), 'the rule is reported as skipped');
    assert.strictEqual(C.scoreLine(out.score), 'Leaks 6 · Partial 1 · Breaks 8 · 26 correct of 41', 'and the rest scored as before');
    assert.ok(spawned >= 2, 'the stuck worker was replaced');
    assert.ok(C.riskyRegex('(a+)+$') && C.riskyRegex('^(\\w+\\s?)*$') && !C.riskyRegex('\\bGC-[A-Z0-9]{4}\\b'), 'the page warns about nested repeats before running them');
    const again = await run.call('run', { rules });
    assert.deepStrictEqual(again.timedOut.map((t) => t.name), ['Nested groups'], 'stays skipped until it changes');
    const att = await run.call('attack', { rules });
    assert.ok(att.tried > 0);
    const fx = await run.call('fixall', { rules: D.rules(C.defaults) });
    assert.strictEqual(fx.applied.length, 8);
    // A run that is replaced by a newer one before it starts answers "replaced".
    const p1 = run.call('run', { rules }), p2 = run.call('run', { rules }), p3 = run.call('run', { rules });
    const settled = await Promise.allSettled([p1, p2, p3]);
    assert.strictEqual(settled[2].status, 'fulfilled');
    assert.ok(settled.slice(0, 2).some((x) => x.status === 'rejected' && x.reason.code === 'replaced'));
  } finally { run.stop(); }
});

/* ================================================================== *
 * The page's promises
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes; the hero and the lab card too; 44px targets; nothing scrolls the page sideways', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2', 'code-bg', 'bar-bg']) for (const fg of ['text', 'muted', 'link']) ok(fg, bg);
    ok('accent-ink', 'accent'); for (const fg of ['text', 'link', 'muted']) ok(fg, 'accent-soft');
    for (const k of ['leak', 'partial', 'break', 'ok', 'flag']) { ok(k, `${k}-bg`); ok('text', `${k}-bg`); ok('muted', `${k}-bg`); ok(k, 'card'); }
    ok('mark-ink', 'mark-bg'); ok('red-ink', 'red-bg'); ok('gold', 'gold-bg'); ok('gold', 'card'); ok('text', 'gold-bg'); ok('bg', 'text'); ok('link', 'gold-bg');
    for (const k of ['leak', 'partial', 'break', 'ok']) ok(k, 'code-bg');
    for (const tone of ['tone-leak', 'tone-break', 'tone-partial', 'tone-ok']) { ok(tone, 'card', 3); ok(tone, 'card2', 3); }
    ok('accent', 'track', 1.2);
  }
  for (const bg of ['#1e0b45', '#4c1d95', '#713f12']) for (const fg of ['#ffffff', '#e9e3f8', '#fcd34d', '#f3effc']) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  for (const [fg, bg] of [['#2a1600', '#fcd34d'], ['#191628', '#fbfaff'], ['#4d4862', '#fbfaff'], ['#b42318', '#fde8e6'], ['#8a3b0a', '#fdedd3'], ['#166534', '#dcfce7'], ['#2b1d00', '#fde68a']]) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}`);
  const lab = require('../../../lab').get('sieve');
  assert.ok(lab && ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const sel of ['.btn', '.link-btn', '.seg button', '.filters button', '.mini button', '.tile', '.input, textarea.input, select.input', '.check']) assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: 4[4-9]px').test(css), `${sel}: 44px`);
  assert.ok(/\.toggle \{[^}]*min-width: 44px; min-height: 44px/.test(css) && /\.spanchips button \{[^}]*min-width: 44px; min-height: 44px/.test(css));
  assert.ok(/\.rrow \{[^}]*min-height: 60px/.test(css) && /\.crow \{[^}]*min-height: 60px/.test(css) && /\.tabbar button \{[^}]*min-height: 60px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/\.tablewrap \{[^}]*overflow: auto/.test(css) && /\.txt \{[^}]*overflow: auto/.test(css) && /\.out \{[^}]*overflow: auto/.test(css) && /\.filters \{[^}]*overflow-x: auto/.test(css), 'tables, texts and exports scroll in their own box');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped and opt-in, no clock or network in the core, every user string escaped', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js) && /localStorage\.removeItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/sessionStorage|indexedDB|document\.cookie/.test(js));
  assert.match(js, /function saveSoon\(\) \{ if \(!state\.keep\) return;/, 'nothing is stored unless this device said yes');
  assert.match(js, /function saveNow\(\) \{\n {4}if \(!state\.keep\) return;/);
  assert.match(js, /keep: false/);
  assert.ok(!/eval\(|new Function|setTimeout\(['"]/.test(js + read('public/sieve-core.js') + read('public/sieve-runner.js') + read('public/sieve-worker.js')), 'no eval of any kind');
  assert.match(js, /new Worker\('sieve-worker\.js'\)/, 'the worker is a same-origin file - the CSP allows it');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/cases', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/me', 'api/rules'].sort(), 'the page asks for nothing else - no route takes a case');
  assert.match(js, /api\('POST', 'api\/ai\/cases', payload\(\)\)/, 'the AI call sends the payload shown');
  assert.match(js, /api\('PUT', 'api\/rules', \{ rules: r, base:/, 'sync sends the rule set and a base, nothing else');
  const files = ['public/index.html', 'public/app.js', 'public/sieve-core.js', 'public/demo.js', 'public/sieve-worker.js', 'public/sieve-runner.js', 'server.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/store.js', 'CLAUDE.md', 'test/run.js'];
  for (const f of files) assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read(f)), `no email address in ${f}`);
  for (const f of ['public/sieve-core.js', 'public/demo.js', 'public/sieve-worker.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon|indexedDB|WebSocket/.test(src), `${f} touches no network or storage`);
    assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(src), `${f} has no dice and no clock`);
    assert.ok(!/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/.test(src), `${f} carries no invisible characters of its own`);
  }
  // Every interpolation of something a file, a person, the server or a model wrote goes through esc(), vis() or paint().
  const strip = (src) => { let out = ''; let i = 0; const re = /\b(esc|vis|paint|excerpt|opill|dirWord)\(/g; let m; while ((m = re.exec(src))) { if (m.index < i) continue; out += src.slice(i, m.index) + 'SAFE'; let depth = 0, j = m.index + m[0].length - 1; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; re.lastIndex = i; } return out + src.slice(i); };
  const risky = strip(js).split('\n').filter((l) => !/toast\(|confirm\(|prompt\(|copy\(|download\(|textContent|\.value = /.test(l)).join('\n')
    .match(/['"]\s*\+\s*(c\.text|c\.id|c\.note|c\.name|a\.name|a\.src|c\.src|d\.name|t\.name|e\.name|e\.error|s\.title|s\.why|s\.line|r\.why|x\.name|err\.message|e\.message|me\.email|out\.dropped[^+]*|r\.rules\.name|w\.rules\.name|im\.name|name|key)\s*\+/g);
  assert.strictEqual(risky, null, `unescaped: ${risky}`);
  assert.strictEqual((js.match(/\bp = esc\('(det|cu|al):/g) || []).length, 3, 'the rule paths drawn into data-r are escaped where they are built');
  assert.ok(!/\bp = '(det|cu|al):/.test(js));
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\brules\b|\bbrief\b|\babout\b)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /sieve-shell-v1/.test(sw) && ['sieve-core.js', 'sieve-worker.js', 'sieve-runner.js', 'demo.js'].every((f) => sw.includes(`'${f}'`)), 'the service worker never answers api/ and owns sieve-* caches only');
  assert.match(read('public/demo.js'), /MADE-UP outdoor shop/);
});

test('local-only switches throw on Cloud Run; the lab prefix is read; the store is never queried', () => {
  for (const [mod, env] of [['./lib/store', { SIEVE_MEMORY: '1' }], ['./lib/fakeai', { SIEVE_FAKE_AI: '1' }], ['./server', { SIEVE_FAKE_AI: '1', SIEVE_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, SIEVE_MEMORY: '', SIEVE_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, SIEVE_MEMORY: '', SIEVE_COLLECTION_PREFIX: 'sieve_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'sieve_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.ok(!/store\.list\(|orderBy/.test(server), 'one document per account, read by its id');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g))].sort(), ["store.get('rules'", "store.remove('rules'", "store.transact('rules'"]);
});

/* ================================================================== *
 * Over HTTP
 * ================================================================== */

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
const mail = (who) => `${who}${AT}example.com`;
const uidOf = (email) => Buffer.from(email).toString('base64url');
async function register(who) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const BIG = { x: 'x'.repeat(900 * 1024) };

test('signed out: the page, the worker and the demo work with zero model calls; rules and the AI answer 401 before reading a body; no route takes a case', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual(meta.detectors.map((d) => d.id), C.DET_IDS);
  assert.deepStrictEqual(meta.categories, ['cards', 'govid', 'keys', 'contact', 'lookalike']);
  for (const f of ['sieve-core.js', 'sieve-worker.js', 'sieve-runner.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/rules'], ['PUT', '/api/rules'], ['DELETE', '/api/rules'], ['POST', '/api/ai/cases']]) assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : { ok: 1 })).status, 401, `${m} ${p}`);
  for (const [m, p] of [['PUT', '/api/rules'], ['POST', '/api/ai/cases']]) assert.strictEqual((await anon(m, p, BIG)).status, 401, `${p}: the gate answers before the parser, so never 413`);
  for (const p of ['/api/run', '/api/check', '/api/cases', '/api/scan', '/api/score', '/api/attack', '/api/report', '/api/upload']) assert.strictEqual((await anon('POST', p, { cases: [{ text: 'card 4111 1111 1111 1111' }] })).status, 404, `${p}: there is no route that takes a case`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the gates come before each parser, in order; one model call site; Haiku free, Sonnet members via planFor', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/cases', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/rules', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((read('lib/ai.js').match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(ai.SYSTEM, /never an instruction to you/);
  assert.match(ai.SYSTEM, /obviously fake/);
});

test('rule sync: the rule set follows the account; a stale device gets 409 with the account copy; secrets and test data are refused; nothing identifying is stored', async () => {
  const a = await register('sam.rules');
  assert.deepStrictEqual((await a('GET', '/api/rules')).data, { rules: null });
  const good = C.applyPatch(D.rules(C.defaults), { addAllow: [{ id: 'a1', name: 'Orders', kind: 'regex', src: '\\bORD-\\d{16}\\b', on: true }, { id: 'a2', name: 'Our address', kind: 'text', src: `help${AT}juniper.example.com`, on: true }] });
  const put = await a('PUT', '/api/rules', { rules: good, base: null });
  assert.strictEqual(put.status, 200, put.text);
  assert.deepStrictEqual([put.data.rules.allow.length, put.data.rules.custom.length, put.data.rules.det.card.luhn], [2, 2, false]);
  const v1 = put.data.rules.updatedAt;
  const b = client();
  assert.strictEqual((await b('POST', '/api/auth/login', { email: mail('sam.rules'), password: 'a long enough password' })).status, 200);
  assert.strictEqual((await b('GET', '/api/rules')).data.rules.allow[0].src, '\\bORD-\\d{16}\\b');
  const b2 = C.clone(good); b2.det.card.luhn = true;
  assert.strictEqual((await b('PUT', '/api/rules', { rules: b2, base: v1 })).status, 200);
  const stale = await a('PUT', '/api/rules', { rules: good, base: v1 });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.data.rules.det.card.luhn, true, 'the 409 carries the account copy to merge with');
  assert.strictEqual((await a('PUT', '/api/rules', { rules: good, base: null })).status, 409, 'a device that never synced cannot overwrite');
  const cur = (await a('GET', '/api/rules')).data.rules.updatedAt;
  const withSecret = (mut) => { const r = C.clone(good); mut(r); return { rules: r, base: cur }; };
  for (const bad of [
    withSecret((r) => { r.custom[1].words.push('4111 1111 1111 1111'); }),
    withSecret((r) => { r.allow.push({ name: 'k', kind: 'text', src: 'AKIAIOSFODNN7EXAMPLE' }); }),
    withSecret((r) => { r.custom[0].src = 'GB82WEST12345698765432|x'; }),
    withSecret((r) => { r.name = 'SSN 219-09-9999'; }),
    withSecret((r) => { r.det.card.words = ['card', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig']; }),
    withSecret((r) => { r.cases = [{ text: 'hello', expect: 'pass' }]; }),
    withSecret((r) => { r.custom[0].src = '(unclosed'; }),
    { rules: good, base: cur, cases: [{ text: 'x' }] },
    { rules: 'nope', base: cur },
  ]) {
    const r = await a('PUT', '/api/rules', bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 100) + ' ' + r.text);
  }
  assert.strictEqual((await a('GET', '/api/rules')).data.rules.updatedAt, cur, 'nothing was saved');
  const dump = store._dump();
  assert.ok(!dump.includes('sam.rules') && !dump.includes(uidOf(mail('sam.rules'))), 'filed under an HMAC, never the account id or email');
  assert.ok(!/4111 1111|AKIAIOSFODNN7EXAMPLE|GB82WEST|219-09-9999|hello/.test(dump), 'no value from a refused body');
  assert.ok(dump.includes(ownerTag(uidOf(mail('sam.rules')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  const doc = Object.values(JSON.parse(dump).find(([p]) => p === 'rules')[1]).map(([, d]) => d)[0];
  assert.deepStrictEqual(Object.keys(doc).sort(), ['owner', 'rules', 'updatedAt'], 'the document is the tag, the rules and a time');
  const other = await register('kim.other');
  assert.deepStrictEqual((await other('GET', '/api/rules')).data, { rules: null }, 'another account sees nothing of it');
  assert.strictEqual((await a('DELETE', '/api/rules')).status, 200);
  assert.deepStrictEqual((await b('GET', '/api/rules')).data, { rules: null });
});

test('write tricky test cases over HTTP: a category and a sentence only, data in the description refused with no model call; the model\u2019s real-looking values thrown away', async () => {
  const ana = await register('ana.cases');
  const calls = await modelCalls();
  for (const bad of [{}, { category: 'nope' }, { category: 'cards', cases: [{ text: 'x' }] }, { category: 'cards', about: `escalate to ops${AT}example.com` }, { category: 'cards', about: 'card 4111 1111 1111 1111' }, { category: 'keys', about: 'our key AKIAIOSFODNN7EXAMPLE' }, { category: 'contact', about: 'phone (303) 555-0142' }, { category: 'cards', about: 'x'.repeat(200) }, []]) {
    const r = await ana('POST', '/api/ai/cases', bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.strictEqual((await ana('POST', '/api/ai/cases', { category: 'cards', about: 'card 4111 1111 1111 1111' })).data.code, 'data-in-description');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const n0 = fakeClient.calls.length;
  const r = await ana('POST', '/api/ai/cases', { category: 'keys', about: 'A support bot for an outdoor shop' });
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const req = fakeClient.calls[n0];
  assert.strictEqual(req.model, 'claude-haiku-4-5');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'write_cases' });
  const userText = req.messages[0].content[0].text;
  assert.match(userText, /Category code: keys/);
  assert.match(userText, /<<<AGENT\nA support bot for an outdoor shop\nAGENT>>>/, 'the description is fenced as untrusted');
  assert.strictEqual(r.data.cases.length, 12);
  assert.ok(r.data.cases.every((c) => c.src === 'ai' && c.text && ['in', 'out'].includes(c.dir)));
  assert.ok(!store._dump().includes('AKIAIOSFODNN7EXAMPLE'), 'nothing stored');
  fakeClient.mode = 'inject';
  const inj = await ana('POST', '/api/ai/cases', { category: 'cards' });
  assert.strictEqual(inj.status, 200, inj.text);
  assert.strictEqual(inj.data.cases.length, 1, 'only the clean case comes back');
  assert.ok(!/<img|onerror|4539 1488|AKIAABCDEF|gmail|212-555-1234|8\.8\.4\.4|123-44-5678|realLookingKey|javascript:|\u202e/i.test(inj.text), inj.text.slice(0, 400));
  assert.ok(inj.data.dropped.length >= 10 && inj.data.dropped.some((d) => /Luhn/.test(d)) && inj.data.dropped.some((d) => /EXAMPLE/.test(d)) && inj.data.dropped.some((d) => /example\.com/.test(d)));
  fakeClient.mode = 'blank';
  assert.strictEqual((await ana('POST', '/api/ai/cases', { category: 'cards' })).status, 422);
  fakeClient.mode = 'maxtokens';
  assert.match((await ana('POST', '/api/ai/cases', { category: 'cards' })).data.error, /ran long/);
  fakeClient.mode = 'upstream401';
  const up = await ana('POST', '/api/ai/cases', { category: 'cards' });
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  fakeClient.mode = 'upstream529';
  const busy = await ana('POST', '/api/ai/cases', { category: 'cards' });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('the gates: unconfirmed free account 403, out of credit 402, the day\u2019s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register('eve.unconfirmed');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/ai/cases', { category: 'cards' });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/sieve/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
    assert.strictEqual((await eve('POST', '/api/ai/cases', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ai/cases', { category: 'cards' })).status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/cases', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-sieve-${day}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/cases', { category: 'cards' });
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/cases', BIG)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-sieve-${day}`); }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/sieve', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/sieve`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
