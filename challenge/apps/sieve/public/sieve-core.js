/* Sieve - every rule, in one dependency-free file.
 *
 * UMD: window.SieveCore in the page, importScripts() in sieve-worker.js,
 * require() in the server and the tests. It holds the detectors, the
 * normaliser, the guardrail (what a rule set does to one message), the score
 * (what it did against what was expected), the suggested fixes and their
 * previewed effect, the evasion pack, import and export, the rule-set checks
 * the server applies before syncing, and the checks on what a model writes.
 *
 * It makes no request, touches no storage, reads no clock and rolls no dice:
 * everything it needs is handed in, so the same rules give the same answer in
 * the page, in the worker, on the server and in the tests.
 *
 * User regexes are compiled here but only ever RUN inside the worker, under
 * the page's watchdog (sieve-runner.js): a catastrophic pattern freezes a
 * worker that is then terminated, never the page. The server compiles them to
 * check the syntax and never runs one.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SieveCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    cases: 2000,          // test cases in one set
    caseBytes: 8192,      // UTF-8 bytes in one case
    custom: 40,           // custom rules
    allow: 40,            // allow-list entries
    source: 400,          // characters in one regex
    words: 100,           // keywords in one rule
    wordChars: 80,        // characters in one keyword
    ctxWords: 20,         // context words on one detector
    nameChars: 40,        // a rule's name
    noteChars: 160,       // a case's note
    spans: 40,            // marked spans in one case
    history: 20,          // runs on the chart
    matchesPerCase: 200,  // matches one rule may make in one case
    ruleMs: 1500,         // what one user regex may take over the whole set, per run
    runMs: 20000,         // what a whole run may take
    attackCases: 60,      // sensitive cases the evasion pack attacks
    aiCases: 20,          // cases the model may propose
    aiText: 600,          // characters in one proposed case
    aboutChars: 160,      // the agent description sent to the model
    rulesBytes: 48 * 1024 // a rule set, as JSON
  };

  /* ------------------------------------------------------------------ *
   * Small text helpers
   * ------------------------------------------------------------------ */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function plural(n, word, many) { return n + ' ' + (n === 1 ? word : (many || word + 's')); }
  // Invisible characters: zero-width, bidi controls and the like. Kept in a
  // case's text (they are often the trick being tested) but drawn visibly.
  var INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/;
  var INVISIBLE_G = new RegExp(INVISIBLE.source, 'g');
  var BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
  var CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  /** One line of typed or file text: no control, bidi or zero-width characters, trimmed, capped. */
  function line(s, max) {
    return String(s == null ? '' : s).replace(CONTROL, '').replace(INVISIBLE_G, '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
  }
  /** A test case's text: line endings folded, control characters removed. Zero-width and bidi stay - they may be the point. */
  function caseText(s) {
    return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(CONTROL, '');
  }
  function utf8Bytes(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2; else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; } else n += 3;
    }
    return n;
  }
  function charName(ch) {
    var cp = ch.codePointAt(0);
    var hex = 'U+' + ('0000' + cp.toString(16).toUpperCase()).slice(-4);
    var names = { 0x200B: 'zero-width space', 0x200C: 'zero-width non-joiner', 0x200D: 'zero-width joiner', 0x2060: 'word joiner', 0xFEFF: 'zero-width no-break space', 0x00AD: 'soft hyphen', 0x202E: 'right-to-left override', 0x202D: 'left-to-right override', 0x202A: 'left-to-right embedding', 0x202B: 'right-to-left embedding', 0x202C: 'pop directional formatting', 0x200E: 'left-to-right mark', 0x200F: 'right-to-left mark', 0x2066: 'left-to-right isolate', 0x2067: 'right-to-left isolate', 0x2068: 'first strong isolate', 0x2069: 'pop directional isolate', 0x061C: 'Arabic letter mark' };
    return hex + (names[cp] ? ' ' + names[cp] : ' invisible character');
  }
  function isAlnum(c) { return /[A-Za-z0-9]/.test(c); }
  function digitsOf(s) { return String(s).replace(/\D/g, ''); }
  function reEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&'); }
  function clampInt(v, lo, hi, def) { var n = parseInt(v, 10); if (!isFinite(n)) return def; return Math.max(lo, Math.min(hi, n)); }

  /* ------------------------------------------------------------------ *
   * Checks the detectors use
   * ------------------------------------------------------------------ */

  function luhn(digits) {
    var s = 0, alt = false;
    for (var i = digits.length - 1; i >= 0; i--) {
      var n = digits.charCodeAt(i) - 48;
      if (n < 0 || n > 9) return false;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      s += n; alt = !alt;
    }
    return digits.length > 0 && s % 10 === 0;
  }
  function mod97(iban) {
    var s = String(iban).replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
    s = s.slice(4) + s.slice(0, 4);
    var r = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      var v = c >= 65 ? String(c - 55) : String(c - 48);
      for (var j = 0; j < v.length; j++) r = (r * 10 + (v.charCodeAt(j) - 48)) % 97;
    }
    return r === 1;
  }
  /** An SSN that the Social Security Administration could have issued: never area 000, 666 or 900-999, group 00 or serial 0000. */
  function ssnValid(s) {
    var d = digitsOf(s);
    if (d.length !== 9) return false;
    var area = +d.slice(0, 3), group = +d.slice(3, 5), serial = +d.slice(5);
    return area !== 0 && area !== 666 && area < 900 && group !== 0 && serial !== 0;
  }
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function utf8Encode(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var cp = s.codePointAt(i);
      if (cp > 0xFFFF) i++;
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return out;
  }
  function utf8Decode(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b < 0x80) s += String.fromCharCode(b);
      else if (b >= 0xC0 && b < 0xE0 && i + 1 < bytes.length) { s += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63)); i += 1; }
      else if (b >= 0xE0 && b < 0xF0 && i + 2 < bytes.length) { s += String.fromCharCode(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)); i += 2; }
      else if (b >= 0xF0 && i + 3 < bytes.length) { s += String.fromCodePoint(((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63)); i += 3; }
      else s += '�';
    }
    return s;
  }
  function b64encode(s) {
    var b = utf8Encode(s), out = '';
    for (var i = 0; i < b.length; i += 3) {
      var n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
    }
    return out;
  }
  /** base64 or base64url to bytes; null when it is not base64. */
  function b64bytes(s) {
    var t = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/]*$/.test(t) || t.length % 4 === 1) return null;
    var out = [], buf = 0, bits = 0;
    for (var i = 0; i < t.length; i++) {
      buf = (buf << 6) | B64.indexOf(t[i]); bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 255); }
    }
    return out;
  }
  function jwtHeaderOk(token) {
    var head = String(token).split('.')[0];
    var bytes = b64bytes(head);
    if (!bytes) return false;
    try { var h = JSON.parse(utf8Decode(bytes)); return Boolean(h && typeof h === 'object' && typeof h.alg === 'string'); } catch (e) { return false; }
  }
  function jwtPayload(token) {
    var bytes = b64bytes(String(token).split('.')[1] || '');
    if (!bytes) return '';
    return utf8Decode(bytes);
  }

  /* ------------------------------------------------------------------ *
   * The normaliser: what a message is turned into before the rules read it.
   * Every character of the result remembers which original characters it
   * came from, so a match is always reported - and redacted - on the text
   * as it arrived.
   * ------------------------------------------------------------------ */

  var ZW = /[\u00AD\u034F\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
  // Cyrillic and Greek letters that look like Latin ones.
  var HOMO = {
    'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ї': 'i', 'ј': 'j', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'l', 'һ': 'h', 'ɡ': 'g',
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'Ѕ': 'S', 'І': 'I', 'Ј': 'J', 'Ԛ': 'Q', 'Ԝ': 'W', 'Ү': 'Y', 'Һ': 'H',
    'α': 'a', 'ο': 'o', 'ν': 'v', 'ρ': 'p', 'υ': 'u', 'χ': 'x', 'ι': 'i', 'κ': 'k', 'ε': 'e', 'τ': 't',
    'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X'
  };
  var TO_HOMO = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', i: 'і', s: 'ѕ', j: 'ј', A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', X: 'Х', I: 'І', S: 'Ѕ', J: 'Ј', Y: 'У' };
  var NORM_KEYS = ['nfkc', 'zw', 'homo', 'url', 'b64'];
  var NORM_WORDS = { nfkc: 'Fold look-alike forms (NFKC): full-width digits, ligatures, circled letters', zw: 'Remove zero-width and direction characters', homo: 'Fold Cyrillic and Greek look-alikes into Latin letters', url: 'Decode %-escapes (%34%31 is 41)', b64: 'Read base64 runs of 12 characters or more as their decoded text too' };
  function normSig(n) { return NORM_KEYS.map(function (k) { return n && n[k] ? '1' : '0'; }).join(''); }
  function anyNorm(n) { return normSig(n) !== '00000'; }

  /** {t, S, E}: the normalised text and, per character of it, the original start and end. S is null when nothing changed. */
  function normalise(text, n) {
    if (!anyNorm(n)) return { t: text, S: null, E: null };
    var t = '', S = [], E = [];
    var push = function (s, a, b) { for (var k = 0; k < s.length; k++) { t += s[k]; S.push(a); E.push(b); } };
    var i = 0;
    while (i < text.length) {
      var cp = text.codePointAt(i), w = cp > 0xFFFF ? 2 : 1, ch = text.slice(i, i + w);
      if (n.zw && ZW.test(ch)) { i += w; continue; }
      if (n.url && ch === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
        var code = parseInt(text.slice(i + 1, i + 3), 16);
        if (code >= 0x20 && code < 0x7F) { push(String.fromCharCode(code), i, i + 3); i += 3; continue; }
      }
      var out = n.nfkc ? ch.normalize('NFKC') : ch;
      if (n.homo) { var o2 = ''; for (var q = 0; q < out.length; q++) o2 += HOMO[out[q]] || out[q]; out = o2; }
      push(out, i, i + w);
      i += w;
    }
    if (n.b64) {
      var re = /[A-Za-z0-9+/]{12,4000}={0,2}/g, m, t2 = '', S2 = [], E2 = [], last = 0;
      while ((m = re.exec(t))) {
        var raw = m[0], bytes = raw.length % 4 === 1 ? null : b64bytes(raw);
        if (!bytes || bytes.length < 8) continue;
        // Part of a dotted token (a JWT's header or payload): leave it whole.
        if (t[m.index - 1] === '.' || t[m.index + raw.length] === '.') continue;
        var printable = 0;
        for (var b = 0; b < bytes.length; b++) if ((bytes[b] >= 0x20 && bytes[b] < 0x7F) || bytes[b] === 10) printable++;
        if (printable / bytes.length < 0.95) continue;
        // The decoded text goes in BESIDE the run, not instead of it: a JWT's
        // payload is base64 too, and replacing it would hide the JWT itself.
        for (var k = last; k < m.index + raw.length; k++) { t2 += t[k]; S2.push(S[k]); E2.push(E[k]); }
        var dec = ' | ' + utf8Decode(bytes) + ' | ', a = S[m.index], z = E[m.index + raw.length - 1];
        for (var d = 0; d < dec.length; d++) { t2 += dec[d]; S2.push(a); E2.push(z); }
        last = m.index + raw.length;
      }
      if (last) { for (var r = last; r < t.length; r++) { t2 += t[r]; S2.push(S[r]); E2.push(E[r]); } t = t2; S = S2; E = E2; }
    }
    if (t === text) return { t: text, S: null, E: null };
    return { t: t, S: S, E: E };
  }
  function toOrig(nm, s, e) {
    if (!nm.S) return [s, e];
    if (e <= s) return [nm.S[s] || 0, nm.S[s] || 0];
    return [nm.S[s], nm.E[e - 1]];
  }

  /* ------------------------------------------------------------------ *
   * The detectors
   * ------------------------------------------------------------------ */

  var CATS = {
    contact: 'Contact details', payment: 'Cards and bank accounts', govid: 'Government ids', secret: 'Keys, tokens and secrets', network: 'Network addresses', custom: 'Custom', other: 'Not a known kind'
  };
  var CAT_KEYS = Object.keys(CATS);
  var ACTS = ['redact', 'block', 'flag'];
  var ACT_WORD = { redact: 'Redact', block: 'Block', flag: 'Flag' };
  var DIRS = ['in', 'out', 'both'];
  var DIR_WORD = { in: 'Input to the agent', out: 'Output from the agent', both: 'Input and output' };
  var DIR_SHORT = { in: 'In', out: 'Out', both: 'Both' };

  // Every pattern here has bounded repeats, so none of them can backtrack
  // its way through an 8 KB message (tested against hostile input).
  var LB = '(?<![A-Za-z0-9])', LA = '(?![A-Za-z0-9])';
  var OCT = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  var CTX = {
    card: ['card', 'visa', 'mastercard', 'amex', 'credit', 'debit', 'cc', 'cvv', 'cvc', 'exp', 'payment', 'pay'],
    phone: ['phone', 'call', 'text', 'mobile', 'cell', 'tel', 'reach', 'number', 'whatsapp'],
    ssn: ['ssn', 'social', 'security', 'tax', 'tin'],
    iban: ['iban', 'bank', 'account', 'transfer', 'refund'],
    ipv4: ['ip', 'address', 'host', 'server', 'addr'],
    email: ['email', 'mail', 'contact', 'reach']
  };

  var DETECTORS = [
    { id: 'email', short: 'email addresses', label: 'Email addresses', cat: 'contact', example: 'dana.r' + String.fromCharCode(64) + 'example.com', opts: ['wb', 'ctx'],
      def: { act: 'redact', dir: 'both' },
      pattern: function () { return '[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\\.){1,8}[A-Za-z]{2,24}'; }, wbBefore: '(?<![A-Za-z0-9._%+-])' },
    { id: 'phone', short: 'phone numbers', label: 'Phone numbers', cat: 'contact', example: '(303) 555-0142, +1 303 555 0187', opts: ['mode', 'wb', 'ctx', 'min'],
      def: { act: 'redact', dir: 'both', mode: 'strict', min: 10 }, minRange: [7, 15],
      pattern: function (o) {
        if (o.mode === 'loose') return '\\+?\\(?\\d(?:[ ().-]{0,2}\\d){' + (Math.max(7, o.min || 10) - 1) + ',14}';
        return '(?:(?:\\+?1[ .-]?)?(?:\\(\\d{3}\\)[ .-]?|\\d{3}[ .-])\\d{3}[ .-]\\d{4}|\\+[1-9]\\d{7,14})';
      }, wbBefore: '(?<![A-Za-z0-9+])(?<!\\d[ ().-])', wbAfter: '(?![A-Za-z0-9])(?![ ().-]\\d)' },
    { id: 'card', short: 'card numbers', label: 'Payment cards', cat: 'payment', example: '4111 1111 1111 1111', opts: ['luhn', 'lines', 'wb', 'ctx', 'min'],
      def: { act: 'block', dir: 'both', luhn: true, lines: false, min: 13 }, minRange: [12, 19],
      pattern: function (o) { var sep = o.lines ? '(?:[ -]|[ \\t]*\\n[ \\t]*)?' : '[ -]?'; return '\\d(?:' + sep + '\\d){' + (Math.max(12, o.min || 13) - 1) + ',18}'; },
      keep: function (m, o) { var d = digitsOf(m); return !/^(\d)\1+$/.test(d) && (!o.luhn || luhn(d)); } },
    { id: 'iban', short: 'IBANs', label: 'Bank accounts (IBAN)', cat: 'payment', example: 'GB82 WEST 1234 5698 7654 32', opts: ['mod97', 'wb', 'ctx'],
      def: { act: 'redact', dir: 'both', mod97: true } },
    { id: 'ssn', short: 'SSNs', label: 'US Social Security numbers', cat: 'govid', example: '219-09-9999', opts: ['strict', 'seps', 'wb', 'ctx'],
      def: { act: 'redact', dir: 'both', strict: true, seps: 'any' },
      pattern: function (o) { return o.seps === 'dash' ? '\\d{3}-\\d{2}-\\d{4}' : '\\d{3}([ .-])\\d{2}\\1\\d{4}'; },
      keep: function (m, o) { return !o.strict || ssnValid(m); } },
    { id: 'aws', short: 'AWS keys', label: 'AWS access key ids', cat: 'secret', example: 'AKIAIOSFODNN7EXAMPLE', opts: ['wb'],
      def: { act: 'block', dir: 'both' }, pattern: function () { return '(?:AKIA|ASIA)[A-Z0-9]{16}'; } },
    { id: 'github', short: 'GitHub tokens', label: 'GitHub tokens', cat: 'secret', example: 'ghp_ + 36 characters', opts: ['wb', 'min'],
      def: { act: 'block', dir: 'both', min: 20 }, minRange: [8, 80],
      pattern: function (o) { var n = Math.max(8, o.min || 20); return '(?:gh[pous]_[A-Za-z0-9]{' + n + ',255}|github_pat_[A-Za-z0-9_]{' + n + ',255})'; } },
    { id: 'slack', short: 'Slack tokens', label: 'Slack tokens', cat: 'secret', example: 'xoxb-...', opts: ['wb', 'min'],
      def: { act: 'block', dir: 'both', min: 10 }, minRange: [6, 80],
      pattern: function (o) { return 'xox[abpr]-[A-Za-z0-9-]{' + Math.max(6, o.min || 10) + ',250}'; } },
    { id: 'stripe', short: 'Stripe keys', label: 'Stripe-style secret keys', cat: 'secret', example: 'sk_live_...', opts: ['wb', 'min'],
      def: { act: 'block', dir: 'both', min: 10 }, minRange: [6, 80],
      pattern: function (o) { return '(?:sk|rk)_live_[A-Za-z0-9]{' + Math.max(6, o.min || 10) + ',250}'; } },
    { id: 'privkey', short: 'private keys', label: 'Private key blocks', cat: 'secret', example: '-----BEGIN PRIVATE KEY-----', opts: [],
      def: { act: 'block', dir: 'both' } },
    { id: 'jwt', short: 'JWTs', label: 'JSON Web Tokens', cat: 'secret', example: 'eyJ....eyJ....sig', opts: ['alg', 'wb'],
      def: { act: 'redact', dir: 'both', alg: true },
      pattern: function () { return 'eyJ[A-Za-z0-9_-]{2,2000}\\.[A-Za-z0-9_-]{2,4000}\\.[A-Za-z0-9_-]{0,1000}'; }, wbBefore: '(?<![A-Za-z0-9_.-])', wbAfter: '(?![A-Za-z0-9_-])',
      keep: function (m, o) { return !o.alg || jwtHeaderOk(m); } },
    { id: 'ipv4', short: 'IP addresses', label: 'IPv4 addresses', cat: 'network', example: '203.0.113.7', opts: ['priv', 'wb', 'ctx'],
      def: { act: 'redact', dir: 'out', priv: false },
      pattern: function () { return OCT + '(?:\\.' + OCT + '){3}'; }, wbBefore: '(?<![0-9.])', wbAfter: '(?![0-9]|\\.\\d)',
      keep: function (m, o) { return !o.priv || !privateIp(m); } }
  ];
  var DET = {};
  DETECTORS.forEach(function (d) { DET[d.id] = d; });
  var DET_IDS = DETECTORS.map(function (d) { return d.id; });
  var OPT_WORD = {
    wb: 'Require word boundaries', ctx: 'Only near context words', mode: 'Formats', min: 'Minimum length', luhn: 'Luhn check (real cards pass it)', lines: 'Allow a line break inside the number',
    mod97: 'mod-97 check (real IBANs pass it)', strict: 'Skip impossible SSNs (000, 666, 9xx, 00, 0000)', seps: 'Separators', alg: 'Header must decode to JSON with "alg"', priv: 'Skip private, loopback and documentation ranges'
  };

  function privateIp(ip) {
    var p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 169 && p[1] === 254) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 2) || (p[0] === 198 && p[1] === 51 && p[2] === 100) || (p[0] === 203 && p[1] === 0 && p[2] === 113);
  }

  function detDefaults(id) {
    var d = DET[id];
    var o = { on: true, act: d.def.act, dir: d.def.dir, wb: true, ctx: false, words: (CTX[id] || []).slice(), near: 40 };
    Object.keys(d.def).forEach(function (k) { o[k] = d.def[k]; });
    return o;
  }

  /** A detector's own defaults, switched on, with a caller's overrides on top - for the checks that read text wide open. */
  function wide(id, over) {
    var o = detDefaults(id);
    o.on = true; o.ctx = false; o.wb = true;
    Object.keys(over || {}).forEach(function (k) { if (k in o || k === 'mode' || k === 'priv') o[k] = over[k]; });
    if (over && over.mins && over.mins[id]) o.min = over.mins[id];
    return o;
  }

  var compiled = {};
  function detRegex(d, o) {
    if (!d.pattern) return null;
    var p = d.pattern(o);
    var src = o.wb ? (d.wbBefore || LB) + p + (d.wbAfter || LA) : p;
    if (!compiled[src]) compiled[src] = new RegExp(src, 'g');
    var re = compiled[src];
    re.lastIndex = 0;
    return re;
  }

  function nearWords(text, s, e, words, near) {
    if (!words || !words.length) return false;
    var a = Math.max(0, s - near), z = Math.min(text.length, e + near);
    var win = text.slice(a, z).toLowerCase();
    for (var i = 0; i < words.length; i++) {
      var w = String(words[i]).toLowerCase();
      if (!w) continue;
      var at = win.indexOf(w);
      while (at >= 0) {
        var before = at === 0 ? '' : win[at - 1], after = win[at + w.length] || '';
        if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
        at = win.indexOf(w, at + 1);
      }
    }
    return false;
  }

  function findIban(text, o) {
    var out = [], re = /[A-Z]{2}\d{2}/g, m;
    while ((m = re.exec(text)) && out.length < LIMITS.matchesPerCase) {
      var s = m.index;
      if (o.wb && s > 0 && isAlnum(text[s - 1])) continue;
      // Up to 30 more letters and digits after the check digits, single spaces allowed between them.
      var ends = [], j = s + 4, n = 0;
      while (j < text.length && n < 30) {
        if (text[j] === ' ' && j + 1 < text.length && /[A-Z0-9]/.test(text[j + 1])) j++;
        if (!/[A-Z0-9]/.test(text[j] || '')) break;
        j++; n++;
        if (n >= 11) ends.push(j);
      }
      var got = -1;
      for (var k = ends.length - 1; k >= 0; k--) {
        var e = ends[k];
        if (o.wb && e < text.length && isAlnum(text[e])) continue;
        if (o.mod97 && !mod97(text.slice(s, e))) continue;
        got = e; break;
      }
      if (got > 0) { out.push([s, got]); re.lastIndex = got; }
    }
    return out;
  }
  function findPrivkey(text) {
    var out = [], re = /-----BEGIN (?:[A-Z0-9]{1,12} ){0,3}PRIVATE KEY-----/g, m;
    while ((m = re.exec(text)) && out.length < LIMITS.matchesPerCase) {
      var foot = /-----END (?:[A-Z0-9]{1,12} ){0,3}PRIVATE KEY-----/g;
      foot.lastIndex = m.index + m[0].length;
      var f = foot.exec(text);
      var e = f ? f.index + f[0].length : text.length;
      out.push([m.index, e]);
      re.lastIndex = e;
    }
    return out;
  }

  function shorterCard(text, s, m, o) {
    var pos = [];
    for (var k = 0; k < m.length; k++) if (m[k] >= '0' && m[k] <= '9') pos.push(k);
    for (var n = pos.length - 1; n >= Math.max(12, o.min || 13); n--) {
      var end = s + pos[n - 1] + 1;
      if (o.wb && end < text.length && isAlnum(text[end])) continue;
      if (luhn(digitsOf(m.slice(0, pos[n - 1] + 1)))) return end;
    }
    return -1;
  }
  /** Where one detector, with these options, finds something in this (already normalised) text. */
  function detect(id, o, text) {
    var d = DET[id], out = [];
    if (id === 'iban') out = findIban(text, o);
    else if (id === 'privkey') out = findPrivkey(text);
    else {
      var re = detRegex(d, o), m;
      while ((m = re.exec(text)) && out.length < LIMITS.matchesPerCase) {
        var s = m.index, e = s + m[0].length;
        if (e === s) { re.lastIndex++; continue; }
        if (d.keep && !d.keep(m[0], o)) {
          // A card that runs into the next number ("... 1111 12/29"): try it shorter, a digit at a time, before moving on.
          var e2 = id === 'card' && o.luhn ? shorterCard(text, s, m[0], o) : -1;
          if (e2 < 0) { re.lastIndex = s + 1; continue; }
          e = e2; re.lastIndex = e;
        }
        out.push([s, e]);
      }
    }
    if (o.min && (id === 'card' || id === 'phone')) out = out.filter(function (r) { return digitsOf(text.slice(r[0], r[1])).length >= o.min; });
    if (o.ctx && d.opts.indexOf('ctx') >= 0) out = out.filter(function (r) { return nearWords(text, r[0], r[1], o.words, o.near); });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Custom rules and the allow-list
   * ------------------------------------------------------------------ */

  var NESTED = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/;
  /** A pattern that can backtrack for ever on the wrong text: a repeat inside a repeated group, like (a+)+ or (\w+\s?)*. */
  function riskyRegex(src) { return NESTED.test(String(src)); }
  function compileRegex(src, flags) {
    var f = String(flags || '').replace(/[^imsu]/g, '').split('').filter(function (c, i, a) { return a.indexOf(c) === i; }).join('');
    try { return { re: new RegExp(String(src), f + 'g'), flags: f }; } catch (e) { return { error: String(e && e.message || 'Not a valid regex').replace(/^Invalid regular expression: /, '').slice(0, 160) }; }
  }
  function findWords(text, words, wb, cs) {
    var out = [], hay = cs ? text : text.toLowerCase();
    for (var i = 0; i < words.length && out.length < LIMITS.matchesPerCase; i++) {
      var w = cs ? words[i] : String(words[i]).toLowerCase();
      if (!w) continue;
      var at = hay.indexOf(w);
      while (at >= 0 && out.length < LIMITS.matchesPerCase) {
        if (!wb || ((at === 0 || !isAlnum(hay[at - 1])) && !isAlnum(hay[at + w.length] || ''))) out.push([at, at + w.length]);
        at = hay.indexOf(w, at + Math.max(1, w.length));
      }
    }
    return out.sort(function (a, b) { return a[0] - b[0]; });
  }
  function findRegex(re, text) {
    var out = [], m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) && out.length < LIMITS.matchesPerCase) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out.push([m.index, m.index + m[0].length]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Rule sets
   * ------------------------------------------------------------------ */

  function defaults() {
    var det = {};
    DET_IDS.forEach(function (id) { det[id] = detDefaults(id); });
    return { v: 1, name: '', normalise: { nfkc: false, zw: false, homo: false, url: false, b64: false }, det: det, custom: [], allow: [] };
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** The rules a run applies, in order, each with a key the match cache and the watchdog know it by. */
  function ruleList(rules) {
    var out = [];
    DET_IDS.forEach(function (id) {
      var o = rules.det[id];
      out.push({ key: 'd:' + id, type: 'det', id: id, name: DET[id].label, cat: DET[id].cat, on: o.on, act: o.act, dir: o.dir, o: o });
    });
    rules.custom.forEach(function (c) {
      out.push({ key: 'u:' + c.id, type: c.kind === 'words' ? 'words' : 'regex', id: c.id, name: c.name || 'Custom rule', cat: c.cat || 'custom', on: c.on, act: c.act, dir: c.dir, o: c });
    });
    return out;
  }
  function allowList(rules) {
    return rules.allow.map(function (a) { return { key: 'a:' + a.id, type: a.kind === 'text' ? 'atext' : 'aregex', id: a.id, name: a.name || 'Allow-list entry', on: a.on, o: a }; });
  }
  /** What a rule's matches depend on - its cache key. */
  function matchSig(r) {
    var o = r.o;
    if (r.type === 'det') {
      var keys = ['wb', 'ctx', 'words', 'near', 'min', 'mode', 'luhn', 'lines', 'mod97', 'strict', 'seps', 'alg', 'priv'];
      return 'd:' + r.id + ':' + JSON.stringify(keys.map(function (k) { return o[k]; }));
    }
    if (r.type === 'words') return 'w:' + JSON.stringify([o.words, o.wb, o.cs]);
    if (r.type === 'regex') return 'r:' + o.flags + '/' + o.src;
    if (r.type === 'atext') return 't:' + o.src;
    return 'r:' + (o.flags || '') + '/' + o.src;
  }
  /** The key a user pattern is known by to the watchdog - its source, not its id, so an edit gets a fresh chance. */
  function watchKey(r) { return (r.type === 'regex' || r.type === 'aregex') ? 'r:' + (r.o.flags || '') + '/' + r.o.src : null; }
  function applies(dir, caseDir) { return dir === 'both' || dir === caseDir; }

  /* ------------------------------------------------------------------ *
   * Cleaning: rules and cases from a file, the page or another device.
   * ------------------------------------------------------------------ */

  var ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
  var RULE_TOP = ['v', 'name', 'normalise', 'det', 'custom', 'allow', 'updatedAt', 'sieve'];
  var DET_KEYS = ['on', 'act', 'dir', 'wb', 'ctx', 'words', 'near', 'min', 'mode', 'luhn', 'lines', 'mod97', 'strict', 'seps', 'alg', 'priv'];
  var CUSTOM_KEYS = ['id', 'name', 'kind', 'src', 'flags', 'words', 'wb', 'cs', 'cat', 'act', 'dir', 'on'];
  var ALLOW_KEYS = ['id', 'name', 'kind', 'src', 'flags', 'on'];
  function isObj(x) { return Boolean(x) && typeof x === 'object' && !Array.isArray(x); }
  function wordList(raw, max, chars, errs, where, strict) {
    if (raw == null) return [];
    var list = Array.isArray(raw) ? raw : String(raw).split(/\n|,/);
    if (strict && !Array.isArray(raw)) errs.push(where + ': send the words as a list.');
    var out = [];
    list.forEach(function (w) {
      if (typeof w !== 'string' && strict) { errs.push(where + ': every word must be text.'); return; }
      var s = line(w, 1000);
      if (strict && s.length > chars) { errs.push(where + ': "' + s.slice(0, 20) + '…" is longer than ' + chars + ' characters.'); return; }
      s = s.slice(0, chars);
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    if (out.length > max) { if (strict) errs.push(where + ': at most ' + max + ' words.'); out = out.slice(0, max); }
    return out;
  }
  function pick(v, allowed, def) { return allowed.indexOf(v) >= 0 ? v : def; }

  /**
   * A rule set, rebuilt key by key. `strict` (the server, and anything synced)
   * refuses what is unknown or out of bounds instead of fixing it, and refuses
   * a rule set that carries a secret or a personal id (secretIn) - a rule must
   * not smuggle a value. Regexes are compiled to check them, never run.
   */
  function cleanRules(raw, strict) {
    var errs = [], out = defaults();
    if (!isObj(raw)) return { rules: out, errors: ['That is not a rule set.'] };
    if (strict) Object.keys(raw).forEach(function (k) { if (RULE_TOP.indexOf(k) < 0) errs.push('Unknown field "' + line(k, 30) + '" - a rule set holds rules, never test cases or matched text.'); });
    out.name = line(raw.name, 60);
    if (isObj(raw.normalise)) NORM_KEYS.forEach(function (k) { out.normalise[k] = raw.normalise[k] === true; });
    if (strict && isObj(raw.normalise)) Object.keys(raw.normalise).forEach(function (k) { if (NORM_KEYS.indexOf(k) < 0) errs.push('Unknown normaliser option "' + line(k, 30) + '".'); });
    if (isObj(raw.det)) {
      Object.keys(raw.det).forEach(function (id) {
        if (!DET[id]) { if (strict) errs.push('Unknown detector "' + line(id, 30) + '".'); return; }
        var r = raw.det[id], o = out.det[id], d = DET[id];
        if (!isObj(r)) { if (strict) errs.push(d.label + ': not a set of options.'); return; }
        if (strict) Object.keys(r).forEach(function (k) { if (DET_KEYS.indexOf(k) < 0) errs.push(d.label + ': unknown option "' + line(k, 30) + '".'); });
        if ('on' in r) o.on = r.on === true;
        o.act = pick(r.act, ACTS, o.act);
        o.dir = pick(r.dir, DIRS, o.dir);
        if ('wb' in r) o.wb = r.wb !== false;
        if ('ctx' in r) o.ctx = r.ctx === true;
        if ('words' in r) o.words = wordList(r.words, LIMITS.ctxWords, 30, errs, d.label + ' context words', strict);
        if ('near' in r) o.near = clampInt(r.near, 5, 200, 40);
        if ('min' in r && d.minRange) o.min = clampInt(r.min, d.minRange[0], d.minRange[1], d.def.min);
        if (id === 'phone' && 'mode' in r) o.mode = pick(r.mode, ['strict', 'loose'], 'strict');
        if (id === 'card') { if ('luhn' in r) o.luhn = r.luhn === true; if ('lines' in r) o.lines = r.lines === true; }
        if (id === 'iban' && 'mod97' in r) o.mod97 = r.mod97 === true;
        if (id === 'ssn') { if ('strict' in r) o.strict = r.strict === true; if ('seps' in r) o.seps = pick(r.seps, ['dash', 'any'], 'any'); }
        if (id === 'jwt' && 'alg' in r) o.alg = r.alg === true;
        if (id === 'ipv4' && 'priv' in r) o.priv = r.priv === true;
        if (strict && r.act !== undefined && ACTS.indexOf(r.act) < 0) errs.push(d.label + ': the action is redact, block or flag.');
        if (strict && r.dir !== undefined && DIRS.indexOf(r.dir) < 0) errs.push(d.label + ': the direction is in, out or both.');
      });
    }
    var seen = {};
    var rid = function (x, n, pre) { var id = typeof x.id === 'string' && ID_RE.test(x.id) ? x.id : pre + n; while (seen[id]) id = id + 'x'; seen[id] = true; return id; };
    if (Array.isArray(raw.custom)) {
      if (raw.custom.length > LIMITS.custom) { if (strict) errs.push('At most ' + LIMITS.custom + ' custom rules.'); }
      raw.custom.slice(0, LIMITS.custom).forEach(function (c, n) {
        if (!isObj(c)) { if (strict) errs.push('Custom rule ' + (n + 1) + ' is not a rule.'); return; }
        if (strict) Object.keys(c).forEach(function (k) { if (CUSTOM_KEYS.indexOf(k) < 0) errs.push('Custom rule ' + (n + 1) + ': unknown field "' + line(k, 30) + '".'); });
        var kind = c.kind === 'words' ? 'words' : 'regex';
        var name = line(c.name, LIMITS.nameChars) || ('Custom rule ' + (n + 1));
        var r = { id: rid(c, n + 1, 'u'), name: name, kind: kind, src: '', flags: '', words: [], wb: c.wb !== false, cs: c.cs === true, cat: pick(c.cat, CAT_KEYS.filter(function (k) { return k !== 'other'; }), 'custom'), act: pick(c.act, ACTS, 'redact'), dir: pick(c.dir, DIRS, 'both'), on: c.on !== false };
        if (kind === 'regex') {
          var src = typeof c.src === 'string' ? c.src.replace(CONTROL, '') : '';
          if (src.length > LIMITS.source) { if (strict) errs.push(name + ': the regex is longer than ' + LIMITS.source + ' characters.'); src = src.slice(0, LIMITS.source); }
          r.src = src;
          var comp = compileRegex(src, c.flags);
          r.flags = comp.flags || String(c.flags || '').replace(/[^imsu]/g, '').slice(0, 4);
          if (strict && comp.error) errs.push(name + ': ' + comp.error);
          if (strict && !src) errs.push(name + ': the regex is empty.');
        } else {
          r.words = wordList(c.words, LIMITS.words, LIMITS.wordChars, errs, name, strict);
          if (strict && !r.words.length) errs.push(name + ': no keywords.');
        }
        out.custom.push(r);
      });
    } else if (strict && raw.custom !== undefined) errs.push('Custom rules are a list.');
    if (Array.isArray(raw.allow)) {
      if (raw.allow.length > LIMITS.allow && strict) errs.push('At most ' + LIMITS.allow + ' allow-list entries.');
      raw.allow.slice(0, LIMITS.allow).forEach(function (a, n) {
        if (!isObj(a)) { if (strict) errs.push('Allow-list entry ' + (n + 1) + ' is not an entry.'); return; }
        if (strict) Object.keys(a).forEach(function (k) { if (ALLOW_KEYS.indexOf(k) < 0) errs.push('Allow-list entry ' + (n + 1) + ': unknown field "' + line(k, 30) + '".'); });
        var kind = a.kind === 'text' ? 'text' : 'regex';
        var src = typeof a.src === 'string' ? (kind === 'text' ? line(a.src, LIMITS.source + 1) : a.src.replace(CONTROL, '')) : '';
        var name = line(a.name, LIMITS.nameChars) || ('Allow ' + (n + 1));
        if (src.length > LIMITS.source) { if (strict) errs.push(name + ': longer than ' + LIMITS.source + ' characters.'); src = src.slice(0, LIMITS.source); }
        var r = { id: rid(a, n + 1, 'a'), name: name, kind: kind, src: src, flags: '', on: a.on !== false };
        if (kind === 'regex') {
          var comp = compileRegex(src, a.flags);
          r.flags = comp.flags || '';
          if (strict && comp.error) errs.push(name + ': ' + comp.error);
        }
        if (strict && !src) errs.push(name + ': empty.');
        out.allow.push(r);
      });
    } else if (strict && raw.allow !== undefined) errs.push('The allow-list is a list.');
    if (strict) {
      var hits = secretsInRules(out);
      if (hits.length) errs.push('A rule carries what looks like ' + (hits.length > 1 ? hits.slice(0, -1).join(', ') + ' and ' + hits[hits.length - 1] : hits[0]) + '. Rules hold patterns, never the values themselves - write a pattern instead.');
      if (utf8Bytes(JSON.stringify(out)) > LIMITS.rulesBytes) errs.push('That rule set is too big to keep.');
    }
    if (typeof raw.updatedAt === 'number' && isFinite(raw.updatedAt)) out.updatedAt = raw.updatedAt;
    return { rules: out, errors: errs };
  }

  /** Every string a rule set holds - names, patterns, keywords, context words. */
  function ruleStrings(r) {
    var out = [r.name];
    DET_IDS.forEach(function (id) { out = out.concat(r.det[id].words || []); });
    r.custom.forEach(function (c) { out.push(c.name, c.src); out = out.concat(c.words); });
    r.allow.forEach(function (a) { out.push(a.name, a.src); });
    return out.filter(Boolean);
  }
  var SECRET_WORD = { card: 'a payment card number', iban: 'a bank account number (IBAN)', ssn: 'a Social Security number', aws: 'an AWS key', github: 'a GitHub token', slack: 'a Slack token', stripe: 'a Stripe key', privkey: 'a private key', jwt: 'a JSON Web Token' };
  /** The secret classes a string holds: a Luhn-valid card, a mod-97-valid IBAN, a possible SSN, a key or token. Contact details are allowed (an allow-list needs the support address). */
  function secretKinds(text) {
    var found = [];
    var o = { luhn: true, lines: false, mod97: true, strict: true, seps: 'any', alg: true };
    ['privkey', 'jwt', 'aws', 'github', 'slack', 'stripe', 'iban', 'card', 'ssn'].forEach(function (id) {
      var opt = wide(id, o);
      opt.wb = false;
      if (detect(id, opt, String(text)).length) found.push(id);
    });
    // Nine digits on their own that could be an SSN.
    var bare = String(text).match(/(?:^|[^\d])\d{9}(?!\d)/g) || [];
    if (found.indexOf('ssn') < 0 && bare.some(function (x) { return ssnValid(digitsOf(x)); })) found.push('ssn');
    return found;
  }
  function secretsInRules(r) {
    var hits = [];
    ruleStrings(r).forEach(function (s) { secretKinds(s).forEach(function (k) { if (hits.indexOf(SECRET_WORD[k]) < 0) hits.push(SECRET_WORD[k]); }); });
    return hits;
  }

  /** Two copies of one rule set: this device's, and the account's. Keeps this device's settings and adds the custom and allow-list rules only the other has. */
  function mergeRules(account, local) {
    var a = cleanRules(account).rules, l = cleanRules(local).rules, out = clone(l), added = 0;
    var ids = {};
    out.custom.forEach(function (c) { ids[c.id] = true; });
    a.custom.forEach(function (c) {
      var same = out.custom.some(function (x) { return x.kind === c.kind && x.src === c.src && JSON.stringify(x.words) === JSON.stringify(c.words); });
      if (!ids[c.id] && !same && out.custom.length < LIMITS.custom) { out.custom.push(c); ids[c.id] = true; added++; }
    });
    var aids = {};
    out.allow.forEach(function (x) { aids[x.id] = true; });
    a.allow.forEach(function (x) {
      var same = out.allow.some(function (y) { return y.kind === x.kind && y.src === x.src; });
      if (!aids[x.id] && !same && out.allow.length < LIMITS.allow) { out.allow.push(x); aids[x.id] = true; added++; }
    });
    NORM_KEYS.forEach(function (k) { out.normalise[k] = l.normalise[k] || a.normalise[k]; });
    if (!out.name) out.name = a.name;
    return { rules: out, added: added };
  }

  function spanList(raw, text) {
    var out = [];
    (Array.isArray(raw) ? raw : []).forEach(function (sp) {
      var s, e;
      if (Array.isArray(sp)) { s = sp[0]; e = sp[1]; } else if (isObj(sp)) { s = sp.start; e = sp.end; } else if (typeof sp === 'string' && sp) {
        var at = text.indexOf(sp);
        while (at >= 0 && out.length < LIMITS.spans) { out.push([at, at + sp.length]); at = text.indexOf(sp, at + sp.length); }
        return;
      } else return;
      s = Number(s); e = Number(e);
      if (Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e <= text.length && e > s) out.push([s, e]);
    });
    return mergeRanges(out).slice(0, LIMITS.spans);
  }
  function mergeRanges(list) {
    var r = list.map(function (x) { return [x[0], x[1]]; }).sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }), out = [];
    r.forEach(function (x) { var l = out[out.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else out.push(x); });
    return out;
  }
  var DIR_IN = { in: 'in', input: 'in', 'to-agent': 'in', 'to agent': 'in', user: 'in', inbound: 'in', out: 'out', output: 'out', 'from-agent': 'out', 'from agent': 'out', agent: 'out', assistant: 'out', outbound: 'out' };
  var EXPECT_IN = { pass: 'pass', allow: 'pass', ok: 'pass', clean: 'pass', none: 'pass', redact: 'redact', redacted: 'redact', mask: 'redact', block: 'block', blocked: 'block', refuse: 'block', deny: 'block' };
  /** One case, rebuilt. Returns {case} or {error}. */
  function cleanCase(raw, n) {
    if (!isObj(raw)) return { error: 'not a case' };
    var text = caseText(typeof raw.text === 'string' ? raw.text : raw.text == null ? '' : String(raw.text));
    if (!text.trim()) return { error: 'no text' };
    if (utf8Bytes(text) > LIMITS.caseBytes) return { error: 'over 8 KB' };
    var dir = DIR_IN[String(raw.dir || raw.direction || 'in').toLowerCase().trim()];
    if (!dir) return { error: 'the direction is input or output' };
    var expect = EXPECT_IN[String(raw.expect || raw.expected || 'pass').toLowerCase().trim()];
    if (!expect) return { error: 'expect is pass, redact or block' };
    var spans = expect === 'pass' ? [] : spanList(raw.spans, text);
    var c = { id: typeof raw.id === 'string' && /^[A-Za-z0-9:_-]{1,48}$/.test(raw.id) ? raw.id : 'c' + (n == null ? 1 : n + 1), text: text, dir: dir, expect: expect, spans: spans };
    var note = line(raw.note, LIMITS.noteChars); if (note) c.note = note;
    if (typeof raw.src === 'string' && /^(demo|you|import|attack|ai)$/.test(raw.src)) c.src = raw.src;
    if (typeof raw.trick === 'string' && TRICKS[raw.trick]) c.trick = raw.trick;
    return { case: c };
  }

  /* ------------------------------------------------------------------ *
   * The guardrail: what a rule set does to one message.
   * ------------------------------------------------------------------ */

  /**
   * The match cache. Matches depend on a rule's matching options and the
   * normaliser, never on its action or direction, so changing an action
   * re-scores without re-matching, and a suggestion that touches one detector
   * re-matches only that one. User regexes are reported to `hooks` before and
   * after they run - the worker passes those on to the page's watchdog.
   */
  function createMatcher() {
    var cases = [], version = 0, cache = {}, norms = {};
    function setCases(list) { cases = list; version++; cache = {}; norms = {}; }
    function normFor(sig, n, i) {
      if (sig === '00000') return { t: cases[i].text, S: null, E: null };
      var arr = norms[sig] || (norms[sig] = []);
      return arr[i] || (arr[i] = normalise(cases[i].text, n));
    }
    function matches(r, n, hooks) {
      var sig = normSig(n), key = matchSig(r) + '|' + sig;
      if (cache[key]) return cache[key];
      var res = { per: [], error: null };
      var re = null;
      if (r.type === 'regex' || r.type === 'aregex') {
        var c = compileRegex(r.o.src, r.o.flags);
        if (c.error) { res.error = c.error; cache[key] = res; return res; }
        if (!r.o.src) { res.error = 'empty'; cache[key] = res; return res; }
        re = c.re;
        if (hooks && hooks.begin) hooks.begin(watchKey(r), r.name);
      }
      for (var i = 0; i < cases.length; i++) {
        var nm = normFor(sig, n, i), found;
        if (r.type === 'det') found = detect(r.id, r.o, nm.t);
        else if (r.type === 'words') found = findWords(nm.t, r.o.words, r.o.wb, r.o.cs);
        else if (r.type === 'atext') found = findWords(nm.t, [r.o.src], false, false);
        else found = findRegex(re, nm.t);
        res.per.push(found.map(function (m) { return toOrig(nm, m[0], m[1]); }));
      }
      if (re && hooks && hooks.end) hooks.end(watchKey(r));
      cache[key] = res;
      return res;
    }
    return { setCases: setCases, matches: matches, cases: function () { return cases; }, version: function () { return version; } };
  }

  function overlaps(a, b) { return a[0] < b[1] && b[0] < a[1]; }

  /** One message through the guardrail: what fired, what was refused, what was redacted. */
  function combine(c, i, active, allowed) {
    var allowSpans = [];
    allowed.forEach(function (a) { (a.m.per[i] || []).forEach(function (x) { allowSpans.push({ r: x, key: a.key }); }); });
    var dets = [];
    active.forEach(function (r) {
      if (!applies(r.dir, c.dir)) return;
      (r.m.per[i] || []).forEach(function (x) {
        var hit = allowSpans.filter(function (a) { return overlaps(a.r, x); })[0];
        dets.push({ s: x[0], e: x[1], key: r.key, name: r.name, act: r.act, cat: r.cat, allowed: hit ? true : false, allowKey: hit ? hit.key : null });
      });
    });
    var live = dets.filter(function (d) { return !d.allowed; });
    var actual = live.some(function (d) { return d.act === 'block'; }) ? 'block' : live.some(function (d) { return d.act === 'redact'; }) ? 'redact' : 'pass';
    return { dets: dets, live: live, actual: actual, allowed: dets.filter(function (d) { return d.allowed; }) };
  }

  function covered(span, ranges, text) {
    for (var k = span[0]; k < span[1]; k++) {
      var ch = text[k];
      if (!isAlnum(ch) && !/[^\s\-_.,:;'"()]/.test(ch)) continue; // separators at the edges don't count
      if (!ranges.some(function (r) { return k >= r[0] && k < r[1]; })) return false;
    }
    return true;
  }

  /** What the guardrail did, against what was expected. */
  function compare(c, g) {
    var red = g.live.filter(function (d) { return d.act === 'redact'; });
    var redR = mergeRanges(red.map(function (d) { return [d.s, d.e]; }));
    var caught = [], leaked = [], extra = [];
    c.spans.forEach(function (sp, k) {
      if (g.actual === 'block' || (g.actual === 'redact' && covered(sp, redR, c.text))) caught.push(k); else leaked.push(k);
    });
    if (g.actual === 'redact') redR.forEach(function (r) { if (!c.spans.some(function (sp) { return overlaps(sp, r); })) extra.push(r); });
    var outcome, why;
    if (c.expect === 'pass') {
      if (g.actual === 'pass') { outcome = 'correct'; why = g.live.length ? 'Went through untouched (flagged).' : 'Went through untouched.'; }
      else if (g.actual === 'block') { outcome = 'break'; why = 'Legit text was blocked.'; }
      else { outcome = 'break'; why = 'Legit text was redacted.'; }
    } else if (c.expect === 'redact') {
      if (g.actual === 'block') { outcome = 'break'; why = 'Blocked a message that only needed redacting.'; }
      else if (!c.spans.length) { outcome = g.actual === 'redact' ? 'correct' : 'leak'; why = g.actual === 'redact' ? 'Redacted (no spans marked to compare).' : 'Nothing was redacted.'; }
      else if (!caught.length) { outcome = 'leak'; why = c.spans.length === 1 ? 'The sensitive span got through.' : 'None of the ' + c.spans.length + ' sensitive spans were caught.'; }
      else if (leaked.length) { outcome = 'partial'; why = caught.length + ' of ' + c.spans.length + ' sensitive spans caught - ' + leaked.length + ' got through.'; }
      else if (extra.length) { outcome = 'break'; why = 'Caught the sensitive span, but also redacted text that is not sensitive.'; }
      else { outcome = 'correct'; why = 'Redacted exactly what was sensitive.'; }
    } else {
      if (g.actual === 'block') { outcome = 'correct'; why = 'Blocked, as expected.'; }
      else if (g.actual === 'pass') { outcome = 'leak'; why = 'Went through - this one should have been blocked.'; }
      else if (c.spans.length && !redR.some(function (r) { return c.spans.some(function (sp) { return overlaps(sp, r); }); })) { outcome = 'leak'; why = 'Redacted the wrong thing - the sensitive part got through.'; }
      else { outcome = 'partial'; why = 'Redacted, but this one should have been blocked.'; }
    }
    return { outcome: outcome, why: why, actual: g.actual, caught: caught, leaked: leaked, extra: extra, red: redR };
  }

  /** The text after the guardrail: redacted spans replaced, or null when the message was refused. */
  function outputText(c, g) {
    if (g.actual === 'block') return null;
    var red = g.live.filter(function (d) { return d.act === 'redact'; }).sort(function (a, b) { return a.s - b.s || b.e - a.e; });
    var out = '', at = 0;
    red.forEach(function (d) {
      if (d.s < at) { return; }
      out += c.text.slice(at, d.s) + '[REDACTED:' + tag(d.name) + ']';
      at = d.e;
    });
    return out + c.text.slice(at);
  }
  function tag(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'rule'; }

  /* ------------------------------------------------------------------ *
   * The run: every case through the guardrail, scored.
   * ------------------------------------------------------------------ */

  var OUTCOMES = ['leak', 'partial', 'break', 'correct'];
  var OUTCOME_WORD = { leak: 'Leak', partial: 'Partial', break: 'Break', correct: 'Correct' };
  var OUTCOME_ICON = { leak: '!', partial: '◐', break: '✕', correct: '✓' };

  var CLASS_ORDER = ['privkey', 'jwt', 'aws', 'github', 'slack', 'stripe', 'iban', 'card', 'ssn', 'email', 'ipv4', 'phone'];
  var classMemo = {}, classN = 0;
  function classify(text) {
    if (Object.prototype.hasOwnProperty.call(classMemo, text)) return classMemo[text];
    if (classN > 20000) { classMemo = {}; classN = 0; }
    classN++;
    return (classMemo[text] = classifyNow(text));
  }
  function classifyNow(text) {
    var o = { luhn: false, lines: true, mod97: false, strict: false, seps: 'any', alg: true, mode: 'loose', priv: false, mins: { github: 8, slack: 6, stripe: 6, phone: 7 } };
    var nm = normalise(text, { nfkc: true, zw: true, homo: true, url: true, b64: true });
    // Most specific first: a loose phone rule would take an SSN or a card for itself.
    for (var i = 0; i < CLASS_ORDER.length; i++) {
      var id = CLASS_ORDER[i];
      var found = detect(id, wide(id, o), nm.t);
      if (found.length) return DET[id].cat;
    }
    return 'other';
  }

  /** What the built-in detectors, set wide open, would mark in a text - the editor's "Find likely spans". */
  function likelySpans(text) {
    var o = { luhn: true, lines: false, mod97: true, strict: true, seps: 'any', alg: true, mode: 'strict', priv: false };
    var nm = normalise(String(text), FULL_NORM), out = [];
    DET_IDS.forEach(function (id) {
      detect(id, wide(id, o), nm.t).forEach(function (r) { out.push(toOrig(nm, r[0], r[1])); });
    });
    return mergeRanges(out).slice(0, LIMITS.spans);
  }

  /**
   * Run every case through these rules. `skip` names user patterns the
   * watchdog has already stopped (they count as off). Returns per-case
   * results and the score.
   */
  function evaluate(matcher, rules, skip, hooks) {
    var cases = matcher.cases(), list = ruleList(rules), errors = [], skipped = [];
    var active = [];
    list.forEach(function (r) {
      if (!r.on) return;
      var wk = watchKey(r);
      if (wk && skip && skip[wk]) { skipped.push({ key: r.key, name: r.name }); return; }
      if (r.type === 'words' && !r.o.words.length) return;
      var m = matcher.matches(r, rules.normalise, hooks);
      if (m.error) { if (m.error !== 'empty') errors.push({ key: r.key, name: r.name, error: m.error }); return; }
      active.push(Object.assign({ m: m }, r));
    });
    var allowed = [];
    allowList(rules).forEach(function (a) {
      if (!a.on || !a.o.src) return;
      var wk = watchKey(a);
      if (wk && skip && skip[wk]) { skipped.push({ key: a.key, name: a.name }); return; }
      var m = matcher.matches(a, rules.normalise, hooks);
      if (m.error) { errors.push({ key: a.key, name: a.name, error: m.error }); return; }
      allowed.push(Object.assign({ m: m }, a));
    });
    var results = cases.map(function (c, i) {
      var g = combine(c, i, active, allowed);
      var cmp = compare(c, g);
      return { id: c.id, i: i, g: g, outcome: cmp.outcome, why: cmp.why, actual: cmp.actual, caught: cmp.caught, leaked: cmp.leaked, extra: cmp.extra, red: cmp.red };
    });
    return { results: results, score: scoreOf(cases, results, list, allowList(rules)), errors: errors, skipped: skipped };
  }

  function scoreOf(cases, results, list, allows) {
    var s = { total: cases.length, leak: 0, partial: 0, break: 0, correct: 0, flagged: 0, rules: {}, uncaught: [], cats: {} };
    list.concat(allows || []).forEach(function (r) { s.rules[r.key] = { key: r.key, name: r.name, cat: r.cat || 'allow', act: r.act || 'allow', dir: r.dir || 'both', on: r.on, hits: 0, tp: 0, fp: 0, caught: 0, breaks: 0, flags: 0, allowed: 0 }; });
    CAT_KEYS.forEach(function (k) { s.cats[k] = { spans: 0, caught: 0, tp: 0, fp: 0 }; });
    results.forEach(function (r) {
      var c = cases[r.i];
      s[r.outcome]++;
      if (r.g.live.some(function (d) { return d.act === 'flag'; })) s.flagged++;
      var judged = c.expect !== 'block' || c.spans.length > 0;
      var caughtBy = {};
      r.g.live.forEach(function (d) {
        var R = s.rules[d.key];
        if (!R) return;
        R.hits++;
        if (d.act === 'flag') R.flags++;
        var tp = c.spans.some(function (sp) { return overlaps(sp, [d.s, d.e]); });
        if (judged && d.act !== 'flag') { if (tp) { R.tp++; s.cats[R.cat] && s.cats[R.cat].tp++; } else { R.fp++; s.cats[R.cat] && s.cats[R.cat].fp++; } }
        if (tp && d.act !== 'flag') caughtBy[d.key] = true;
      });
      r.g.allowed.forEach(function (d) { var key = allowKeyFor(r, d); if (key && s.rules[key]) s.rules[key].allowed++; });
      if (r.outcome !== 'leak' && r.outcome !== 'partial') Object.keys(caughtBy).forEach(function (k) { s.rules[k].caught++; });
      if (r.outcome === 'break') {
        blamed(c, r).forEach(function (k) { if (s.rules[k]) s.rules[k].breaks++; });
      }
      c.spans.forEach(function (sp, k) {
        var cat = classify(c.text.slice(sp[0], sp[1]));
        s.cats[cat].spans++;
        if (r.caught.indexOf(k) >= 0) s.cats[cat].caught++;
        else s.uncaught.push({ id: c.id, k: k, cat: cat });
      });
    });
    Object.keys(s.cats).forEach(function (k) {
      var x = s.cats[k];
      x.precision = x.tp + x.fp ? x.tp / (x.tp + x.fp) : null;
      x.recall = x.spans ? x.caught / x.spans : null;
    });
    return s;
  }
  function allowKeyFor(r, d) { return d.allowKey || null; }
  /** Which rules caused a Break. */
  function blamed(c, r) {
    var keys = {};
    r.g.live.forEach(function (d) {
      if (d.act === 'flag') return;
      if (c.expect === 'pass') keys[d.key] = true;
      else if (c.expect === 'redact' && d.act === 'block') keys[d.key] = true;
      else if (d.act === 'redact' && r.extra.some(function (x) { return overlaps(x, [d.s, d.e]); })) keys[d.key] = true;
    });
    return Object.keys(keys);
  }
  function scoreLine(s) {
    var parts = ['Leaks ' + s.leak];
    if (s.partial) parts.push('Partial ' + s.partial);
    parts.push('Breaks ' + s.break);
    return parts.join(' · ') + ' · ' + s.correct + ' correct of ' + s.total;
  }

  /* ------------------------------------------------------------------ *
   * Suggested fixes. Each is a concrete change, simulated against the whole
   * set before it is offered; only changes that add no new leak are shown,
   * with what they would do ("-2 breaks, no new leaks").
   * ------------------------------------------------------------------ */

  function applyPatch(rules, patch) {
    var r = clone(rules);
    (patch.det ? Object.keys(patch.det) : []).forEach(function (id) { Object.assign(r.det[id], patch.det[id]); });
    if (patch.normalise) Object.assign(r.normalise, patch.normalise);
    (patch.custom ? Object.keys(patch.custom) : []).forEach(function (id) { r.custom.forEach(function (c) { if (c.id === id) Object.assign(c, patch.custom[id]); }); });
    (patch.addAllow || []).forEach(function (a) { if (r.allow.length < LIMITS.allow && !r.allow.some(function (x) { return x.src === a.src && x.kind === a.kind; })) r.allow.push(clone(a)); });
    return r;
  }
  function nextId(list, pre) { var n = list.length + 1, ids = {}; list.forEach(function (x) { ids[x.id] = true; }); while (ids[pre + n]) n++; return pre + n; }

  /** The token a broken span sits in: "ORD-8812004410093317" around "8812004410093317". */
  function tokenAround(text, s, e) {
    var a = s, z = e;
    while (a > 0 && /[A-Za-z0-9#_-]/.test(text[a - 1])) a--;
    while (z < text.length && /[A-Za-z0-9#_-]/.test(text[z])) z++;
    return text.slice(a, z);
  }
  /** An allow-list pattern for an id like ORD-8812004410093317: the letters as written, the digits counted. */
  function idPattern(tok) {
    var m = /^([A-Za-z]{2,8})([-#_]?)(\d{4,24})$/.exec(tok);
    if (!m) return null;
    return { prefix: m[1], sep: m[2], n: m[3].length };
  }

  function effectOf(before, after) {
    var b = before.results, a = after.results, fixed = { leak: 0, partial: 0, break: 0 }, made = { leak: 0, partial: 0, break: 0 }, fixedIds = [], better = 0;
    var leaky = function (o) { return o === 'leak' || o === 'partial'; };
    for (var i = 0; i < b.length; i++) {
      var x = b[i].outcome, y = a[i].outcome;
      if (x === y) continue;
      if (y === 'correct') { fixed[x]++; fixedIds.push(b[i].id); }
      else if (leaky(y) && (!leaky(x) || (x === 'partial' && y === 'leak'))) made[y]++;
      else if (y === 'break' && x === 'correct') made.break++;
      else if (leaky(x) && (y === 'partial' || y === 'break')) { better++; if (y === 'break') made.break++; }
    }
    return { fixed: fixed, made: made, better: better, ids: fixedIds, leak: after.score.leak - before.score.leak, partial: after.score.partial - before.score.partial, break: after.score.break - before.score.break, correct: after.score.correct - before.score.correct, score: after.score };
  }
  function effectLine(e) {
    var parts = [];
    var d = function (n, w) { if (n) parts.push((n > 0 ? '+' : '−') + plural(Math.abs(n), w)); };
    d(e.leak, 'leak'); d(e.partial, 'partial'); d(e.break, 'break');
    var newLeaks = e.made.leak + e.made.partial;
    if (!newLeaks) parts.push('no new leaks');
    return parts.join(', ');
  }

  function candidates(cases, rules, ev) {
    var out = [], seen = {};
    var add = function (c) { var k = JSON.stringify(c.patch); if (seen[k]) return; seen[k] = true; out.push(c); };
    var det = rules.det;
    var onPatches = {}, looked = 0;
    ev.results.forEach(function (r) {
      var c = cases[r.i];
      if (r.outcome === 'correct' || ++looked > 200) return;
      // Breaks: what fired on text that is not sensitive.
      if (r.outcome === 'break') {
        r.g.live.forEach(function (d) {
          if (d.act === 'flag') return;
          var isFp = c.expect === 'pass' || r.extra.some(function (x) { return overlaps(x, [d.s, d.e]); });
          var span = c.text.slice(d.s, d.e);
          if (d.key.indexOf('d:') === 0) {
            var id = d.key.slice(2), o = det[id];
            if (isFp) {
              if (id === 'card' && !o.luhn && !luhn(digitsOf(span))) add({ id: 'luhn', patch: { det: { card: { luhn: true } } }, title: 'Turn on the Luhn check for cards', why: span.trim() + ' fails it, so it is not a card number.' });
              if (id === 'iban' && !o.mod97 && !mod97(span)) add({ id: 'mod97', patch: { det: { iban: { mod97: true } } }, title: 'Turn on the mod-97 check for IBANs', why: span.trim() + ' fails it, so it is not a bank account.' });
              if (id === 'ssn' && !o.strict && !ssnValid(span)) add({ id: 'ssnstrict', patch: { det: { ssn: { strict: true } } }, title: 'Skip SSNs that cannot exist', why: span.trim() + ' is in a range the SSA never issues.' });
              if (id === 'phone' && o.mode === 'loose') add({ id: 'phonestrict', patch: { det: { phone: { mode: 'strict' } } }, title: 'Match phone numbers by their formats (NANP and E.164)', why: span.trim() + ' is a run of digits, not a phone number.' });
              if (id === 'jwt' && !o.alg) add({ id: 'jwtalg', patch: { det: { jwt: { alg: true } } }, title: 'Check JWT headers', why: 'A real JWT header decodes to JSON with "alg".' });
              if (id === 'ipv4' && !o.priv) add({ id: 'ippriv', patch: { det: { ipv4: { priv: true } } }, title: 'Skip private and documentation IP ranges', why: span.trim() + ' is not a public address.' });
              if (!o.wb && DET[id].opts.indexOf('wb') >= 0) add({ id: 'wb-' + id, patch: { det: (function () { var p = {}; p[id] = { wb: true }; return p; }()) }, title: 'Require word boundaries for ' + DET[id].short, why: span.trim() + ' sits inside a longer word or number.' });
              if (!o.ctx && CTX[id] && DET[id].opts.indexOf('ctx') >= 0) add({ id: 'ctx-' + id, patch: { det: (function () { var p = {}; p[id] = { ctx: true }; return p; }()) }, risk: 5, title: 'Only match ' + DET[id].short + ' near words like “' + CTX[id].slice(0, 3).join('”, “') + '”', why: 'Nothing near ' + span.trim() + ' says it is one.' });
              if (id === 'email') {
                var addr = span.trim();
                add({ id: 'allow-' + addr.toLowerCase(), patch: { addAllow: [{ id: '', name: 'Our own address', kind: 'text', src: addr, flags: '', on: true }] }, title: 'Add an allow-list entry for ' + addr, why: 'It is your own address - redacting it breaks the agent.' });
              }
            }
            if (c.expect === 'redact' && d.act === 'block') add({ id: 'act-' + id, patch: { det: (function () { var p = {}; p[id] = { act: 'redact' }; return p; }()) }, title: 'Redact ' + DET[id].short + ' instead of blocking', why: 'The message should go through with the value hidden.' });
          } else if (d.key.indexOf('u:') === 0) {
            var cid = d.key.slice(2);
            if (isFp) add({ id: 'off-' + cid, risk: 1, patch: { custom: (function () { var p = {}; p[cid] = { on: false }; return p; }()) }, title: 'Turn off “' + d.name + '”', why: 'It matched ' + span.trim().slice(0, 40) + ', which is not sensitive.' });
            if (c.expect === 'redact' && d.act === 'block') add({ id: 'uact-' + cid, patch: { custom: (function () { var p = {}; p[cid] = { act: 'redact' }; return p; }()) }, title: 'Redact with “' + d.name + '” instead of blocking', why: 'The message should go through with the value hidden.' });
          }
          if (isFp) {
            var idp = idPattern(tokenAround(c.text, d.s, d.e));
            if (idp) {
              // Every broken id with this prefix, so one entry covers them all.
              var lens = [];
              ev.results.forEach(function (r2) {
                if (r2.outcome !== 'break') return;
                r2.g.live.forEach(function (d2) { var p2 = idPattern(tokenAround(cases[r2.i].text, d2.s, d2.e)); if (p2 && p2.prefix === idp.prefix && p2.sep === idp.sep && lens.indexOf(p2.n) < 0) lens.push(p2.n); });
              });
              lens.sort(function (a, b) { return a - b; });
              var q = lens.length > 1 ? '{' + lens[0] + ',' + lens[lens.length - 1] + '}' : '{' + idp.n + '}';
              var src = '\\b' + reEscape(idp.prefix) + reEscape(idp.sep) + '\\d' + q + '\\b';
              add({ id: 'allowid-' + idp.prefix, patch: { addAllow: [{ id: '', name: idp.prefix + idp.sep + ' ids', kind: 'regex', src: src, flags: '', on: true }] }, title: 'Add an allow-list rule ' + idp.prefix + idp.sep + '\\d' + q, why: tokenAround(c.text, d.s, d.e) + ' is one of your ids, not ' + (d.cat === 'payment' ? 'a card' : 'sensitive') + '.' });
            }
          }
        });
      }
      // Leaks: a sensitive span nothing caught (or only redacted when it should block).
      if (r.outcome === 'leak' || r.outcome === 'partial') {
        if (c.expect === 'block' && r.actual === 'redact') {
          r.g.live.forEach(function (d) {
            if (d.act !== 'redact' || !c.spans.some(function (sp) { return overlaps(sp, [d.s, d.e]); })) return;
            if (d.key.indexOf('d:') === 0) { var id = d.key.slice(2), p = { det: {} }; p.det[id] = { act: 'block' }; add({ id: 'block-' + id, patch: p, title: 'Block messages with ' + DET[id].short, why: 'These should never go through, even redacted.' }); }
          });
        }
        var want = c.expect === 'block' ? 'block' : 'redact';
        var spans = r.leaked.length ? r.leaked.map(function (k) { return c.spans[k]; }) : c.spans;
        spans.forEach(function (sp) {
          var nm = normalise(c.text, rules.normalise);
          DET_IDS.forEach(function (id) {
            var o = det[id];
            var tries = [];
            if (!o.on) tries.push({ p: { on: true, act: want }, kind: 'on' });
            else if (!applies(o.dir, c.dir)) tries.push({ p: { dir: 'both' }, kind: 'dir' });
            else {
              if (id === 'ssn' && o.seps === 'dash') tries.push({ p: { seps: 'any' }, kind: 'opt', title: 'Allow spaces and dots in SSNs', why: 'Customers type them as 219 09 9999 too.' });
              if (id === 'card' && !o.lines) tries.push({ p: { lines: true }, kind: 'opt', title: 'Catch card numbers broken across lines' });
              if (id === 'phone' && o.mode === 'strict') tries.push({ p: { mode: 'loose' }, kind: 'opt', risk: 2, title: 'Match any run of digits as a phone number' });
              if (o.ctx) tries.push({ p: { ctx: false }, kind: 'opt', risk: 1, title: 'Match ' + DET[id].short + ' without context words' });
              if (o.wb && DET[id].opts.indexOf('wb') >= 0) tries.push({ p: { wb: false }, kind: 'opt', risk: 2, title: 'Drop the word-boundary rule for ' + DET[id].short });
              if (DET[id].minRange && o.min > DET[id].def.min) tries.push({ p: { min: DET[id].def.min }, kind: 'opt', title: 'Lower the minimum length for ' + DET[id].short + ' to ' + DET[id].def.min });
            }
            tries.forEach(function (t) {
              var o2 = Object.assign({}, o, t.p);
              var hit = detect(id, o2, nm.t).map(function (x) { return toOrig(nm, x[0], x[1]); });
              if (!hit.some(function (x) { return overlaps(x, sp); })) return;
              var p = { det: {} }; p.det[id] = t.p;
              if (t.kind === 'on') onPatches[id] = t.p;
              else if (t.kind === 'dir') add({ id: 'dir-' + id, patch: p, title: 'Check ' + (c.dir === 'out' ? 'the agent’s output' : 'input to the agent') + ' for ' + DET[id].short + ' too', why: 'It only checks ' + (o.dir === 'in' ? 'input to the agent' : 'output from the agent') + ' - this one was ' + (c.dir === 'out' ? 'in the agent’s output' : 'in the input') + '.' });
              else add({ id: 'opt-' + id + '-' + Object.keys(t.p)[0], patch: p, risk: t.risk || 0, title: t.title, why: t.why || ('That would catch ' + c.text.slice(sp[0], sp[1]).trim().slice(0, 40) + '.') });
            });
          });
          // The normaliser: would the current rules catch it once the text is folded?
          var more = { nfkc: true, zw: true, homo: true };
          if (!rules.normalise.nfkc || !rules.normalise.zw || !rules.normalise.homo) add({ id: 'norm', patch: { normalise: more }, title: 'Turn on the normaliser', why: '', normTricks: true });
        });
      }
    });
    var onIds = Object.keys(onPatches);
    if (onIds.length) {
      var p = { det: {} };
      onIds.forEach(function (id) { p.det[id] = onPatches[id]; });
      var names = onIds.map(function (id) { return DET[id].short; });
      add({ id: 'on-' + onIds.join('-'), patch: p, title: onIds.length === 1 ? 'Turn on ' + names[0] : 'Turn on the ' + onIds.length + ' detectors that are off: ' + names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1], why: 'Each one would have caught something that leaked.' });
    }
    return out.slice(0, 40);
  }

  /** What tricks the leaked spans use - for the normaliser's "3 leaks used full-width digits". */
  function tricksIn(cases, ev) {
    var t = { fullwidth: 0, zerowidth: 0, homoglyph: 0 };
    ev.results.forEach(function (r) {
      if (r.outcome !== 'leak' && r.outcome !== 'partial') return;
      var c = cases[r.i], spans = r.leaked.map(function (k) { return c.spans[k]; });
      var txt = spans.map(function (sp) { return c.text.slice(sp[0], sp[1]); }).join(' ');
      if (/[！-～]/.test(txt)) t.fullwidth++;
      if (ZW.test(txt)) t.zerowidth++;
      if (/[Ͱ-ϿЀ-ӿԀ-ԯ]/.test(txt)) t.homoglyph++;
    });
    return t;
  }

  /** Every suggestion, simulated, keeping only the safe ones, best first. */
  function suggest(matcher, rules, skip, ev, hooks) {
    var cases = matcher.cases(), out = [];
    var tricks = tricksIn(cases, ev);
    candidates(cases, rules, ev).forEach(function (cand) {
      var patch = clone(cand.patch);
      (patch.addAllow || []).forEach(function (a) { a.id = nextId(rules.allow, 'a'); });
      var after = evaluate(matcher, applyPatch(rules, patch), skip, hooks);
      var e = effectOf(ev, after);
      var gained = e.fixed.leak + e.fixed.partial + e.fixed.break + e.better;
      var lost = e.made.leak + e.made.partial;
      if (!gained || lost) return;
      var why = cand.why;
      if (cand.normTricks) {
        var bits = [];
        if (tricks.fullwidth) bits.push(plural(tricks.fullwidth, 'leak') + ' used full-width digits');
        if (tricks.zerowidth) bits.push(plural(tricks.zerowidth, 'leak') + ' hid zero-width characters');
        if (tricks.homoglyph) bits.push(plural(tricks.homoglyph, 'leak') + ' used look-alike letters');
        why = bits.length ? bits.join('; ') + '.' : 'Fold look-alike characters before the rules read the text.';
      }
      out.push({ id: cand.id, title: cand.title, why: why, patch: patch, effect: e, line: effectLine(e), ids: e.ids, gain: e.fixed.leak * 3 + e.fixed.partial * 2 + e.better + e.fixed.break - e.made.break * 2 - (cand.risk || 0) });
    });
    out.sort(function (a, b) { return b.gain - a.gain || a.title.localeCompare(b.title); });
    return out.filter(function (s) { return s.gain > 0; }).slice(0, 12).map(function (s) { delete s.gain; s.effect = { fixed: s.effect.fixed, made: s.effect.made, leak: s.effect.leak, partial: s.effect.partial, break: s.effect.break, correct: s.effect.correct }; return s; });
  }

  /* ------------------------------------------------------------------ *
   * Attack my rules: the evasion pack. From each sensitive case the rules
   * catch now, variants that hide the same value - and which get through.
   * ------------------------------------------------------------------ */

  var NUM_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  var TRICKS = {
    spaced: { label: 'Digits spaced out', when: function (s) { return digitsOf(s).length >= 6 && /^[\d\s().+-]+$/.test(s); }, make: function (s) { return digitsOf(s).split('').join(' '); } },
    dashed: { label: 'Digits dashed in threes', when: function (s) { return digitsOf(s).length >= 6 && /^[\d\s().+-]+$/.test(s); }, make: function (s) { return digitsOf(s).match(/.{1,3}/g).join('-'); } },
    fullwidth: { label: 'Full-width characters', when: function (s) { return /[A-Za-z0-9]/.test(s); }, make: function (s) { return s.replace(/[A-Za-z0-9]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 0xFEE0); }); } },
    zerowidth: { label: 'Zero-width characters inserted', when: function (s) { return s.length >= 4; }, make: function (s) { return Array.from(s).join('\u200B'); } },
    homoglyph: { label: 'Cyrillic and Greek look-alikes', when: function (s) { return (s.match(/[aeopcxyisjABEKMHOPCTXISJY]/g) || []).length >= 2; }, make: function (s) { return s.replace(/[aeopcxyisjABEKMHOPCTXISJY]/g, function (c) { return TO_HOMO[c] || c; }); } },
    base64: { label: 'Base64-encoded', when: function () { return true; }, make: function (s) { return b64encode(s); }, hint: ' (base64)' },
    split: { label: 'Split across two lines', when: function (s) { return s.length >= 8; }, make: function (s) { var mid = Math.floor(s.length / 2), sp = s.lastIndexOf(' ', mid); if (sp < s.length / 4) sp = mid; return s.slice(0, sp).replace(/\s+$/, '') + '\n' + s.slice(sp).replace(/^\s+/, ''); } },
    urlenc: { label: 'URL-encoded', when: function () { return true; }, make: function (s) { return utf8Encode(s).map(function (b) { return '%' + ('0' + b.toString(16).toUpperCase()).slice(-2); }).join(''); } },
    reversed: { label: 'Reversed, with a “read it backwards” hint', when: function (s) { return s.length >= 6; }, make: function (s) { return Array.from(s).reverse().join(''); }, hint: ' (read it backwards)' },
    words: { label: 'Written as words', when: function (s) { return digitsOf(s).length >= 4 || s.indexOf('@') > 0; }, make: function (s) { return s.replace(/\d/g, function (d) { return ' ' + NUM_WORDS[+d] + ' '; }).replace(/@/g, ' at ').replace(/\./g, ' dot ').replace(/-/g, ' dash ').replace(/\s+/g, ' ').trim(); } }
  };
  var TRICK_IDS = Object.keys(TRICKS);

  /** The variants of one case: the span at k rewritten each way, the other spans moved with it. */
  function variantsOf(c, k) {
    var sp = c.spans[k], span = c.text.slice(sp[0], sp[1]), out = [];
    TRICK_IDS.forEach(function (t) {
      var T = TRICKS[t];
      if (!T.when(span)) return;
      var made = T.make(span);
      if (made === span) return;
      var text = c.text.slice(0, sp[0]) + made + (T.hint || '') + c.text.slice(sp[1]);
      if (utf8Bytes(text) > LIMITS.caseBytes) return;
      var shift = made.length + (T.hint || '').length - (sp[1] - sp[0]);
      var spans = c.spans.map(function (x, j) { if (j === k) return [sp[0], sp[0] + made.length]; return x[0] >= sp[1] ? [x[0] + shift, x[1] + shift] : x; });
      out.push({ id: c.id + ':' + t + (k ? k : ''), text: text, dir: c.dir, expect: c.expect, spans: spans, trick: t, from: c.id, src: 'attack' });
    });
    return out;
  }
  function attackSet(cases, ev) {
    var out = [];
    ev.results.forEach(function (r) {
      var c = cases[r.i];
      if (out.length >= LIMITS.attackCases * TRICK_IDS.length || c.expect === 'pass' || !c.spans.length || r.outcome !== 'correct' || c.trick) return;
      if (out.filter(function (v) { return v.from === c.id; }).length) return;
      out = out.concat(variantsOf(c, 0));
    });
    return out;
  }
  var FULL_NORM = { nfkc: true, zw: true, homo: true, url: false, b64: false };
  var DEEP_NORM = { nfkc: true, zw: true, homo: true, url: true, b64: true };
  /** Run the pack: which variants survive these rules, with the normaliser as set, with the basic normaliser and with the deep one. */
  function attack(matcher, rules, skip, ev, hooks) {
    var base = matcher.cases(), vars = attackSet(base, ev);
    var m2 = createMatcher();
    m2.setCases(vars);
    var runs = {
      now: evaluate(m2, rules, skip, hooks),
      norm: evaluate(m2, applyPatch(rules, { normalise: FULL_NORM }), skip, hooks),
      deep: evaluate(m2, applyPatch(rules, { normalise: DEEP_NORM }), skip, hooks)
    };
    var by = {};
    TRICK_IDS.forEach(function (t) { by[t] = { trick: t, label: TRICKS[t].label, tried: 0, now: 0, norm: 0, deep: 0 }; });
    var survivors = [];
    vars.forEach(function (v, i) {
      var b = by[v.trick];
      b.tried++;
      var lk = function (r) { return r.outcome === 'leak' || r.outcome === 'partial'; };
      if (lk(runs.now.results[i])) { b.now++; survivors.push({ v: v, outcome: runs.now.results[i].outcome, normCatches: !lk(runs.norm.results[i]), deepCatches: !lk(runs.deep.results[i]) }); }
      if (lk(runs.norm.results[i])) b.norm++;
      if (lk(runs.deep.results[i])) b.deep++;
    });
    return {
      tried: vars.length, from: vars.reduce(function (n, v, i, a) { return n + (i === 0 || a[i - 1].from !== v.from ? 1 : 0); }, 0),
      survive: survivors.length, normSurvive: runs.norm.results.filter(function (r) { return r.outcome === 'leak' || r.outcome === 'partial'; }).length,
      deepSurvive: runs.deep.results.filter(function (r) { return r.outcome === 'leak' || r.outcome === 'partial'; }).length,
      normBreaks: runs.norm.score.break - runs.now.score.break,
      tricks: TRICK_IDS.map(function (t) { return by[t]; }).filter(function (b) { return b.tried; }),
      survivors: survivors.slice(0, 400)
    };
  }

  /** The demo's normaliser comparison on the test set itself: what turning it on buys, and costs. */
  function normEffect(matcher, rules, skip, ev, hooks) {
    var on = evaluate(matcher, applyPatch(rules, { normalise: FULL_NORM }), skip, hooks);
    return effectOf(ev, on);
  }

  /* ------------------------------------------------------------------ *
   * The engine: what the worker runs (and the page, without one).
   * ------------------------------------------------------------------ */

  function createEngine() {
    var m = createMatcher();
    function ok(rules) { return cleanRules(rules).rules; }
    // Without a worker there is no watchdog, so user regexes are not run at all.
    function skipOf(rules, data) {
      var skip = Object.assign({}, data.skip || {});
      if (data.noUserRegex) ruleList(rules).concat(allowList(rules)).forEach(function (r) { var k = watchKey(r); if (k) skip[k] = true; });
      return skip;
    }
    return {
      cases: function (data) {
        var list = (data.cases || []).slice(0, LIMITS.cases).map(function (c, i) { return cleanCase(c, i).case; }).filter(Boolean);
        m.setCases(list);
        return { n: list.length };
      },
      run: function (data, hooks) {
        var rules = ok(data.rules), skip = skipOf(rules, data);
        var ev = evaluate(m, rules, skip, hooks);
        var sugg = data.suggest === false ? [] : suggest(m, rules, skip, ev, hooks);
        var norm = data.norm ? normEffect(m, rules, skip, ev, hooks) : null;
        return { results: ev.results.map(slim), score: ev.score, errors: ev.errors, skipped: ev.skipped, suggestions: sugg, norm: norm ? { leak: norm.leak, partial: norm.partial, break: norm.break, fixed: norm.fixed, made: norm.made } : null };
      },
      attack: function (data, hooks) {
        var rules = ok(data.rules), skip = skipOf(rules, data);
        var ev = evaluate(m, rules, skip, hooks);
        return attack(m, rules, skip, ev, hooks);
      },
      /** Apply the best safe fix, again and again, until none is left. */
      fixall: function (data, hooks) {
        var rules = ok(data.rules), skip = skipOf(rules, data), applied = [];
        for (var n = 0; n < 16; n++) {
          var ev = evaluate(m, rules, skip, hooks);
          var s = suggest(m, rules, skip, ev, hooks);
          if (!s.length) break;
          rules = applyPatch(rules, s[0].patch);
          applied.push({ title: s[0].title, line: s[0].line });
        }
        return { rules: rules, applied: applied };
      }
    };
  }
  function slim(r) { return { id: r.id, i: r.i, outcome: r.outcome, why: r.why, actual: r.actual, caught: r.caught, leaked: r.leaked, extra: r.extra, red: r.red, dets: r.g.dets.map(function (d) { return { s: d.s, e: d.e, key: d.key, name: d.name, act: d.act, cat: d.cat, allowed: d.allowed, by: d.allowKey || undefined }; }) }; }
  // The page's view of one result, with the guardrail's output text.
  function outputOf(c, r) { return outputText(c, { actual: r.actual, live: r.dets.filter(function (d) { return !d.allowed; }) }); }

  /* ------------------------------------------------------------------ *
   * Drawing helpers the page uses: segments of a text by what covers it.
   * ------------------------------------------------------------------ */

  /** Cut a text into runs, each with the set of layer names covering it. `layers` is {name: [[s,e],...]}. */
  function segments(text, layers) {
    var cuts = [0, text.length];
    Object.keys(layers).forEach(function (k) { layers[k].forEach(function (r) { cuts.push(Math.max(0, Math.min(text.length, r[0])), Math.max(0, Math.min(text.length, r[1]))); }); });
    cuts = cuts.filter(function (x, i, a) { return a.indexOf(x) === i; }).sort(function (a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < cuts.length - 1; i++) {
      var s = cuts[i], e = cuts[i + 1];
      if (e <= s) continue;
      var on = Object.keys(layers).filter(function (k) { return layers[k].some(function (r) { return r[0] <= s && r[1] >= e; }); });
      out.push({ s: s, e: e, t: text.slice(s, e), on: on });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Import and export
   * ------------------------------------------------------------------ */

  function parseCsv(text, maxRows) {
    var rows = [], row = [], cell = '', q = false, i = 0, s = String(text).replace(/^\uFEFF/, '');
    var max = maxRows || 1e9;
    for (; i < s.length; i++) {
      var ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); cell = ''; rows.push(row); row = [];
        if (rows.length > max) break;
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return { rows: rows.filter(function (r) { return r.some(function (c) { return c !== ''; }); }), openQuote: q };
  }
  // A leading ' that Sieve's own export put in front of = + - @ comes off again on import.
  function unquoteFormula(s) { return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s; }
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows) { return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n'; }

  function readSpansCell(v, text) {
    var s = String(v || '').trim();
    if (!s) return [];
    if (/^\d+\s*-\s*\d+(\s*[;,]\s*\d+\s*-\s*\d+)*$/.test(s)) return s.split(/[;,]/).map(function (p) { var m = /(\d+)\s*-\s*(\d+)/.exec(p); return [+m[1], +m[2]]; });
    return s.split('|').map(function (x) { return x.trim(); }).filter(Boolean);
  }
  /** A test set from a CSV, JSONL or JSON file. Returns {cases, problems, skipped, format}. */
  function parseCases(text, opts) {
    var src = String(text || '').replace(/^\uFEFF/, ''), out = [], problems = [], skipped = 0, format;
    var first = opts && typeof opts.first === 'number' ? opts.first : 0;
    var take = function (raw, where) {
      if (out.length >= LIMITS.cases) { skipped++; return; }
      var r = cleanCase(raw, first + out.length);
      if (r.error) { skipped++; if (problems.length < 20) problems.push(where + ': ' + r.error + '.'); return; }
      if (r.case.expect !== 'pass' && !r.case.spans.length && raw.spans && (Array.isArray(raw.spans) ? raw.spans.length : String(raw.spans).trim())) { if (problems.length < 20) problems.push(where + ': the spans did not match the text, so none are marked.'); }
      out.push(r.case);
    };
    var t = src.trim();
    if (/^[[{]/.test(t)) {
      format = 'json';
      var parsed = null;
      try { parsed = JSON.parse(t); } catch (e) { parsed = null; }
      if (Array.isArray(parsed)) parsed.forEach(function (x, n) { take(x, 'Item ' + (n + 1)); });
      else if (parsed && Array.isArray(parsed.cases)) parsed.cases.forEach(function (x, n) { take(x, 'Item ' + (n + 1)); });
      else if (parsed && isObj(parsed)) take(parsed, 'Item 1');
      else {
        format = 'jsonl';
        t.split(/\r?\n/).forEach(function (l, n) {
          if (!l.trim()) return;
          var x; try { x = JSON.parse(l); } catch (e) { skipped++; if (problems.length < 20) problems.push('Line ' + (n + 1) + ': not JSON.'); return; }
          take(x, 'Line ' + (n + 1));
        });
      }
    } else {
      format = 'csv';
      var csv = parseCsv(src, LIMITS.cases + 1);
      if (csv.openQuote) problems.push('A quote was never closed - check the last rows.');
      var head = (csv.rows[0] || []).map(function (h) { return h.trim().toLowerCase(); });
      var col = function (names) { for (var i = 0; i < head.length; i++) if (names.indexOf(head[i]) >= 0) return i; return -1; };
      var ti = col(['text', 'message', 'input', 'content', 'prompt']), di = col(['direction', 'dir', 'side']), ei = col(['expect', 'expected', 'outcome', 'label']), si = col(['spans', 'span', 'sensitive', 'secrets']);
      var rows = csv.rows.slice(1);
      if (ti < 0) { ti = 0; rows = csv.rows; problems.push('No "text" column - the first column was read as the text, and every row as a case to pass.'); }
      rows.forEach(function (r, n) {
        var text = unquoteFormula(r[ti] || '');
        take({ text: text, dir: di >= 0 ? r[di] : 'in', expect: ei >= 0 ? r[ei] : 'pass', spans: si >= 0 ? readSpansCell(unquoteFormula(r[si] || ''), text) : [] }, 'Row ' + (n + 2));
      });
    }
    return { cases: out, problems: problems, skipped: skipped, format: format };
  }
  function exportJsonl(cases) {
    return cases.map(function (c) { var o = { text: c.text, direction: c.dir === 'out' ? 'output' : 'input', expect: c.expect, spans: c.spans }; if (c.note) o.note = c.note; if (c.trick) o.trick = c.trick; return JSON.stringify(o); }).join('\n') + '\n';
  }
  function exportCsv(cases) {
    return toCsv([['text', 'direction', 'expect', 'spans']].concat(cases.map(function (c) { return [c.text, c.dir === 'out' ? 'output' : 'input', c.expect, c.spans.map(function (s) { return s[0] + '-' + s[1]; }).join(';')]; })));
  }
  function exportRules(rules) {
    var r = cleanRules(rules).rules;
    delete r.updatedAt;
    return JSON.stringify(Object.assign({ sieve: 'rules' }, r), null, 2) + '\n';
  }
  function importRules(text) {
    var raw;
    try { raw = JSON.parse(String(text || '')); } catch (e) { return { error: 'That file is not JSON.' }; }
    if (!isObj(raw) || (raw.sieve && raw.sieve !== 'rules') || !isObj(raw.det)) return { error: 'That is not a Sieve rule set (exported from the Export tab).' };
    var c = cleanRules(raw, false);
    return { rules: c.rules };
  }

  /** A value for the report: the first two and last two characters, the rest dotted. */
  function shorten(s) {
    var a = Array.from(String(s).replace(/\s+/g, ' ').trim());
    if (a.length <= 6) return a.map(function (c, i) { return i === 0 ? c : '•'; }).join('');
    return a.slice(0, 2).join('') + a.slice(2, -2).map(function (c) { return /\s/.test(c) ? ' ' : '•'; }).join('') + a.slice(-2).join('');
  }
  function mdText(s) { return String(s).replace(/[\\`*_{}\[\]<>|#]/g, '\\$&').replace(/\n/g, ' ⏎ ').replace(INVISIBLE_G, '·'); }
  /** The case's text near one span: every other sensitive or matched part masked, the span itself shortened. */
  function maskedAround(c, r, sp) {
    var a = Math.max(0, sp[0] - 50), z = Math.min(c.text.length, sp[1] + 50);
    var hide = c.spans.concat((r.dets || []).map(function (d) { return [d.s, d.e]; }));
    var out = '';
    for (var k = a; k < z; k++) {
      if (k === sp[0]) { out += '【' + shorten(c.text.slice(sp[0], sp[1])) + '】'; k = sp[1] - 1; continue; }
      var ch = c.text[k];
      out += hide.some(function (h) { return k >= h[0] && k < h[1]; }) ? (/\s/.test(ch) ? ' ' : '•') : ch;
    }
    return (a > 0 ? '…' : '') + out + (z < c.text.length ? '…' : '');
  }
  function pct(x) { return x == null ? '-' : Math.round(x * 100) + '%'; }
  /** The run, as Markdown to share: scoreboard, rules, every leak and break - values masked. */
  function reportMarkdown(cases, rules, run, when) {
    var s = run.score, byId = {};
    cases.forEach(function (c) { byId[c.id] = c; });
    var L = [];
    L.push('# Sieve report' + (rules.name ? ' - ' + mdText(rules.name) : ''));
    L.push('');
    if (when) L.push('Run ' + mdText(when) + ' · ' + plural(cases.length, 'test case') + '. Sensitive values are masked and shortened so this report can be shared.');
    L.push('');
    L.push('**' + scoreLine(s) + '**');
    L.push('');
    L.push('## Rules');
    L.push('');
    L.push('| Rule | Action | Direction | Matches | Caught | Breaks |');
    L.push('|---|---|---|---:|---:|---:|');
    Object.keys(s.rules).forEach(function (k) {
      var R = s.rules[k];
      if (!R.on || k.indexOf('a:') === 0) return;
      L.push('| ' + mdText(R.name) + ' | ' + ACT_WORD[R.act] + ' | ' + DIR_SHORT[R.dir] + ' | ' + R.hits + ' | ' + R.caught + ' | ' + R.breaks + ' |');
    });
    var allows = rules.allow.filter(function (a) { return a.on; });
    if (allows.length) { L.push(''); L.push('Allow-list: ' + allows.map(function (a) { return '`' + mdText(a.kind === 'text' ? shorten(a.src) : a.src) + '`'; }).join(', ') + '.'); }
    var norm = NORM_KEYS.filter(function (k) { return rules.normalise[k]; });
    L.push(''); L.push('Normaliser: ' + (norm.length ? norm.map(function (k) { return NORM_WORDS[k].split(' (')[0].split(':')[0]; }).join('; ') : 'off') + '.');
    L.push('');
    L.push('## Precision and recall');
    L.push('');
    L.push('| Kind | Sensitive spans | Caught | Recall | Precision |');
    L.push('|---|---:|---:|---:|---:|');
    CAT_KEYS.forEach(function (k) { var x = s.cats[k]; if (!x.spans && !(x.tp + x.fp)) return; L.push('| ' + CATS[k] + ' | ' + x.spans + ' | ' + x.caught + ' | ' + pct(x.recall) + ' | ' + pct(x.precision) + ' |'); });
    ['leak', 'partial', 'break'].forEach(function (o) {
      var list = run.results.filter(function (r) { return r.outcome === o; });
      if (!list.length) return;
      L.push('');
      L.push('## ' + (o === 'leak' ? 'Leaks' : o === 'partial' ? 'Partial' : 'Breaks') + ' (' + list.length + ')');
      list.forEach(function (r) {
        var c = byId[r.id];
        if (!c) return;
        L.push('');
        L.push('### ' + mdText(c.id) + ' · ' + (c.dir === 'out' ? 'output' : 'input') + ' · expected ' + c.expect + ', got ' + r.actual);
        L.push('');
        L.push(mdText(r.why));
        if (o === 'break') {
          var firing = r.dets.filter(function (d) { return !d.allowed && d.act !== 'flag'; });
          firing.slice(0, 5).forEach(function (d) { L.push('- ' + mdText(d.name) + ' (' + d.act + ') matched: ' + mdText(maskedAround(c, r, [d.s, d.e]))); });
        } else {
          r.leaked.slice(0, 5).forEach(function (k) { var sp = c.spans[k]; L.push('- Got through (' + CATS[classify(c.text.slice(sp[0], sp[1]))] + '): ' + mdText(maskedAround(c, r, sp))); });
          if (!r.leaked.length && c.spans[0]) L.push('- ' + mdText(maskedAround(c, r, c.spans[0])));
        }
      });
    });
    if (s.uncaught.length) {
      L.push('');
      L.push('## Spans no rule caught');
      L.push('');
      var tally = {};
      s.uncaught.forEach(function (u) { tally[u.cat] = (tally[u.cat] || 0) + 1; });
      Object.keys(tally).forEach(function (k) { L.push('- ' + CATS[k] + ': ' + tally[k]); });
    }
    L.push('');
    L.push('_Made by Sieve on this device. Nothing in this report was sent anywhere._');
    return L.join('\n') + '\n';
  }

  /* ------------------------------------------------------------------ *
   * The one AI feature: "Write tricky test cases". What is sent, and what
   * may come back.
   * ------------------------------------------------------------------ */

  var AI_CATS = {
    cards: { label: 'Cards and bank accounts', ask: 'payment card numbers and bank account numbers (IBANs)' },
    govid: { label: 'Government ids', ask: 'US Social Security numbers and other government id numbers' },
    keys: { label: 'API keys and tokens', ask: 'API keys, access tokens, JWTs and private keys' },
    contact: { label: 'Contact details', ask: 'email addresses and phone numbers' },
    lookalike: { label: 'Legit text that looks sensitive', ask: 'legitimate text that a naive filter would wrongly catch: order numbers, tracking numbers, version numbers, serial numbers, the company’s own support details' }
  };
  /** Anything a detector would find in a short piece of text - a description must carry none of it. */
  function sensitiveIn(text) {
    var o = { luhn: false, lines: false, mod97: false, strict: false, seps: 'any', alg: true, mode: 'strict', priv: false, mins: { github: 8, slack: 6, stripe: 6 } };
    var nm = normalise(String(text), DEEP_NORM), found = [];
    DET_IDS.forEach(function (id) {
      if (detect(id, wide(id, o), nm.t).length) found.push(id);
    });
    if (/\d{7,}/.test(nm.t.replace(/[ -]/g, '')) && found.indexOf('card') < 0) found.push('number');
    return found;
  }
  var KIND_WORD = { email: 'an email address', phone: 'a phone number', card: 'a card number', iban: 'a bank account number', ssn: 'an SSN', aws: 'an AWS key', github: 'a GitHub token', slack: 'a Slack token', stripe: 'a Stripe key', privkey: 'a private key', jwt: 'a JWT', ipv4: 'an IP address', number: 'a long number' };
  /** The request, rebuilt: a category code and an optional one-sentence description. Returns {req} or {error}. */
  function aiRequest(body) {
    if (!isObj(body)) return { error: 'Choose what kind of cases to write.' };
    var keys = Object.keys(body);
    if (keys.some(function (k) { return k !== 'category' && k !== 'about'; })) return { error: 'Only the category and a one-sentence description are sent - nothing else.' };
    if (typeof body.category !== 'string' || !AI_CATS[body.category]) return { error: 'Choose what kind of cases to write.' };
    if (body.about !== undefined && typeof body.about !== 'string') return { error: 'Describe the agent in a sentence.' };
    var raw = body.about || '';
    if (raw.length > LIMITS.aboutChars) return { error: 'Keep the description to one sentence (' + LIMITS.aboutChars + ' characters).' };
    var about = line(raw, LIMITS.aboutChars);
    var found = sensitiveIn(raw);
    if (found.length) return { error: 'That description contains ' + KIND_WORD[found[0]] + '. Describe the agent in words - never paste data.', code: 'data-in-description' };
    return { req: { category: body.category, about: about } };
  }

  // Values that are documented as fake or for testing.
  var TEST_CARDS = ['4111111111111111', '4242424242424242', '4000056655665556', '4012888888881881', '4222222222222', '5555555555554444', '5105105105105100', '2223003122003222', '5200828282828210', '378282246310005', '371449635398431', '378734493671000', '6011111111111117', '6011000990139424', '3056930009020004', '36227206271667', '3566002020360505', '6200000000000005', '4000000000000002', '4000000000009995', '6250941006528599', '30569309025904', '38520000023237', '3530111333300000'].filter(function (n) { return luhn(n); });
  var TEST_IBANS = ['GB82WEST12345698765432', 'GB33BUKB20201555555555', 'DE89370400440532013000', 'FR1420041010050500013M02606', 'NL91ABNA0417164300', 'ES9121000418450200051332', 'IT60X0542811101000000123456', 'CH9300762011623852957', 'BE68539007547034', 'AT611904300234573201', 'IE29AIBK93115212345678', 'DK5000400440116243', 'FI2112345600000785', 'NO9386011117947'].filter(function (n) { return mod97(n); });
  var TEST_SSNS = ['078051120', '219099999', '123456789'];
  var FAKE_MARK = /EXAMPLE|FAKE|DUMMY|SAMPLE|TEST|NOTREAL|XXXX|(.)\1{7,}/i;
  var JWT_EXAMPLE_SIGS = ['SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'];
  function exampleEmail(addr) { var dom = String(addr).split('@')[1] || ''; return /(^|\.)example\.(com|org|net)$/i.test(dom) || /\.(example|test|invalid|localhost)$/i.test(dom); }
  function fictionalPhone(m) {
    var d = digitsOf(m);
    if (/^\+/.test(m.trim()) && !/^\+\s*1/.test(m.trim())) return false;
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    return d.length === 10 && d.slice(3, 6) === '555' && d.slice(6, 8) === '01';
  }
  function insideIban(t, m) {
    var at = t.indexOf(m);
    return findIban(t, { wb: true, mod97: false }).some(function (r) { return r[0] <= at && r[1] >= at + m.length; });
  }
  /** Why a piece of text holds something that could be real - or '' when every value in it is obviously fake. */
  function realLooking(text) {
    var t = normalise(String(text), DEEP_NORM).t;
    var base = { luhn: false, lines: true, mod97: false, strict: false, seps: 'any', alg: false, mode: 'strict', priv: false };
    var get = function (id, extra) { var o = wide(id, base); Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; }); return detect(id, o, t).map(function (r) { return t.slice(r[0], r[1]); }); };
    var bad = '';
    get('iban').some(function (m) { var s = m.replace(/\s+/g, ''); if (mod97(s) && TEST_IBANS.indexOf(s) < 0) { bad = 'an IBAN that could be real'; return true; } return false; });
    if (bad) return bad;
    // Card networks issue numbers starting 1 to 6; an id starting 0, 7, 8 or 9 that happens to pass Luhn is not one.
    get('card').some(function (m) { var d = digitsOf(m); if (/^[1-6]/.test(d) && luhn(d) && TEST_CARDS.indexOf(d) < 0 && !insideIban(t, m)) { bad = 'a card number that could be real (it passes the Luhn check and is not a documented test number)'; return true; } return false; });
    if (bad) return bad;
    get('ssn').some(function (m) { var d = digitsOf(m); if (ssnValid(d) && TEST_SSNS.indexOf(d) < 0) { bad = 'an SSN that could be real (use an impossible one, like 900-xx-xxxx)'; return true; } return false; });
    if (bad) return bad;
    (t.match(/\b\d{9}\b/g) || []).some(function (d) { if (ssnValid(d) && TEST_SSNS.indexOf(d) < 0 && /\bssn|social/i.test(t)) { bad = 'an SSN that could be real'; return true; } return false; });
    if (bad) return bad;
    get('aws').some(function (m) { if (!/EXAMPLE/.test(m)) { bad = 'an AWS key without EXAMPLE in it'; return true; } return false; });
    if (bad) return bad;
    [['github', { min: 8 }], ['slack', { min: 6 }], ['stripe', { min: 6 }]].some(function (x) {
      return get(x[0], x[1]).some(function (m) { if (!FAKE_MARK.test(m)) { bad = 'a ' + DET[x[0]].label.replace(/s$/, '').replace(/ies$/, 'y') + ' that is not clearly fake'; return true; } return false; });
    });
    if (bad) return bad;
    get('privkey').some(function (m) { var body = m.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''); if (body.length > 120 && !FAKE_MARK.test(m)) { bad = 'a private key that is not clearly fake'; return true; } return false; });
    if (bad) return bad;
    get('jwt').some(function (m) {
      var parts = m.split('.'), sig = parts[2] || '', payload = jwtPayload(m);
      if (!FAKE_MARK.test(sig) && sig.length > 16 && JWT_EXAMPLE_SIGS.indexOf(sig) < 0) { bad = 'a JWT whose signature is not clearly fake'; return true; }
      var inner = realLooking(payload.replace(/eyJ/g, ''));
      if (inner) { bad = 'a JWT carrying ' + inner; return true; }
      return false;
    });
    if (bad) return bad;
    get('email').some(function (m) { if (!exampleEmail(m)) { bad = 'an email address outside example.com, .org or .net'; return true; } return false; });
    if (bad) return bad;
    get('phone').some(function (m) { if (!fictionalPhone(m)) { bad = 'a phone number outside the fictional 555-01xx range'; return true; } return false; });
    if (bad) return bad;
    // A public address next to words that make it one ("server", "host", "IP"); a version number like 4.12.0.118 is left alone.
    detect('ipv4', wide('ipv4', { priv: true }), t).some(function (r) { if (!nearWords(t, r[0], r[1], CTX.ipv4.concat(['connect', 'proxy', 'dns', 'ping', 'port', 'firewall']), 40)) return false; bad = 'a public IP address (use 192.0.2.x, 198.51.100.x or 203.0.113.x)'; return true; });
    return bad;
  }
  /** The model's cases, checked: shape, spans that are really in the text, and nothing that could be a real value. */
  function cleanAiCases(raw, req) {
    var list = isObj(raw) && Array.isArray(raw.cases) ? raw.cases : [];
    var out = [], dropped = [];
    list.slice(0, LIMITS.aiCases + 10).forEach(function (x, n) {
      if (out.length >= LIMITS.aiCases) return;
      if (!isObj(x)) { dropped.push('Case ' + (n + 1) + ' was not a case.'); return; }
      var text = caseText(typeof x.text === 'string' ? x.text : '').replace(BIDI, '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
      if (!text.trim() || text.length > LIMITS.aiText) { dropped.push('Case ' + (n + 1) + ': ' + (text.trim() ? 'too long.' : 'no text.')); return; }
      if (/<\s*\/?\s*[a-z!]/i.test(text) || /javascript:/i.test(text)) { dropped.push('Case ' + (n + 1) + ': it carried markup.'); return; }
      var why = realLooking(text);
      if (why) { dropped.push('Case ' + (n + 1) + ': it held ' + why + '.'); return; }
      var expect = EXPECT_IN[String(x.expect || '').toLowerCase()];
      var dir = DIR_IN[String(x.direction || x.dir || '').toLowerCase()];
      if (!expect || !dir) { dropped.push('Case ' + (n + 1) + ': no clear expected outcome or direction.'); return; }
      var sens = Array.isArray(x.sensitive) ? x.sensitive.filter(function (s) { return typeof s === 'string' && s.length >= 3 && s.length <= 300; }).slice(0, 6) : [];
      var spans = expect === 'pass' ? [] : spanList(sens, text);
      if (expect !== 'pass' && !spans.length) { dropped.push('Case ' + (n + 1) + ': its sensitive part was not in its text.'); return; }
      var note = line(x.why, LIMITS.noteChars);
      out.push({ id: 'ai' + (n + 1), text: text, dir: dir, expect: expect, spans: spans, note: note, src: 'ai' });
    });
    if (list.length > LIMITS.aiCases + 10) dropped.push((list.length - LIMITS.aiCases - 10) + ' more were left out.');
    return { cases: out, dropped: dropped, category: req && req.category };
  }

  /* ------------------------------------------------------------------ *
   * History: the chart of the last runs.
   * ------------------------------------------------------------------ */

  function pushHistory(hist, s, sig) {
    var h = Array.isArray(hist) ? hist.slice() : [];
    var last = h[h.length - 1];
    var row = { leak: s.leak + s.partial, brk: s.break, ok: s.correct, n: s.total, sig: String(sig || '').slice(0, 64) };
    if (last && last.sig === row.sig && last.leak === row.leak && last.brk === row.brk && last.n === row.n) return h;
    h.push(row);
    return h.slice(-LIMITS.history);
  }
  function cleanHistory(h) {
    return (Array.isArray(h) ? h : []).slice(-LIMITS.history).map(function (x) { return isObj(x) ? { leak: clampInt(x.leak, 0, 1e5, 0), brk: clampInt(x.brk, 0, 1e5, 0), ok: clampInt(x.ok, 0, 1e5, 0), n: clampInt(x.n, 0, 1e5, 0), sig: line(x.sig, 64) } : null; }).filter(Boolean);
  }
  /** A short fingerprint of a rule set, so the chart records a run only when the rules changed. */
  function rulesSig(rules, nCases) {
    var s = JSON.stringify(cleanRules(rules).rules) + '#' + nCases, h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  return {
    LIMITS: LIMITS, DETECTORS: DETECTORS, DET: DET, DET_IDS: DET_IDS, CATS: CATS, CAT_KEYS: CAT_KEYS, ACTS: ACTS, ACT_WORD: ACT_WORD, DIRS: DIRS, DIR_WORD: DIR_WORD, DIR_SHORT: DIR_SHORT, OPT_WORD: OPT_WORD, CTX: CTX,
    NORM_KEYS: NORM_KEYS, NORM_WORDS: NORM_WORDS, FULL_NORM: FULL_NORM, DEEP_NORM: DEEP_NORM, OUTCOMES: OUTCOMES, OUTCOME_WORD: OUTCOME_WORD, OUTCOME_ICON: OUTCOME_ICON, TRICKS: TRICKS, TRICK_IDS: TRICK_IDS, AI_CATS: AI_CATS,
    TEST_CARDS: TEST_CARDS, TEST_IBANS: TEST_IBANS, INVISIBLE: INVISIBLE,
    esc: esc, plural: plural, line: line, caseText: caseText, utf8Bytes: utf8Bytes, charName: charName, digitsOf: digitsOf, reEscape: reEscape,
    luhn: luhn, mod97: mod97, ssnValid: ssnValid, b64encode: b64encode, b64bytes: b64bytes, utf8Decode: utf8Decode, jwtHeaderOk: jwtHeaderOk,
    normalise: normalise, normSig: normSig, detect: detect, detDefaults: detDefaults, riskyRegex: riskyRegex, compileRegex: compileRegex,
    defaults: defaults, clone: clone, cleanRules: cleanRules, mergeRules: mergeRules, secretKinds: secretKinds, secretsInRules: secretsInRules, ruleList: ruleList, watchKey: watchKey,
    cleanCase: cleanCase, spanList: spanList, likelySpans: likelySpans, mergeRanges: mergeRanges, createMatcher: createMatcher, evaluate: evaluate, combine: combine, compare: compare, outputText: outputText, outputOf: outputOf, classify: classify, scoreLine: scoreLine,
    applyPatch: applyPatch, suggest: suggest, effectLine: effectLine, idPattern: idPattern, tokenAround: tokenAround,
    variantsOf: variantsOf, attack: attack, createEngine: createEngine, segments: segments,
    parseCsv: parseCsv, toCsv: toCsv, csvCell: csvCell, parseCases: parseCases, exportJsonl: exportJsonl, exportCsv: exportCsv, exportRules: exportRules, importRules: importRules, reportMarkdown: reportMarkdown, shorten: shorten, maskedAround: maskedAround,
    aiRequest: aiRequest, sensitiveIn: sensitiveIn, realLooking: realLooking, cleanAiCases: cleanAiCases, exampleEmail: exampleEmail,
    pushHistory: pushHistory, cleanHistory: cleanHistory, rulesSig: rulesSig
  };
}));
