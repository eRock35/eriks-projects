// Text helpers shared by every source and every model answer.
//
// Everything that arrives here is someone else's text - a career board's
// HTML, a news headline, a model's tool input - so the rule is the same
// everywhere: strip markup, control and bidi-override characters, collapse
// whitespace, and bound the length. The page escapes again on render.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥', copy: '©', reg: '®', trade: '™' };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return ' ';
      try { return String.fromCodePoint(n); } catch (err) { return ' '; }
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

// C0/C1 controls except tab/newline, and the bidi overrides/isolates that can
// make a string read differently from what it says.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/**
 * A career board's HTML (Greenhouse sends it entity-escaped, so it is decoded
 * twice when it still looks escaped) as plain text with paragraph breaks.
 */
function htmlToText(html, max = 20000) {
  let s = String(html || '');
  if (/&lt;[a-z/!]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\/\s*(p|div|h[1-6]|li|ul|ol|tr|section|article|header|footer|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s).replace(CONTROL, '');
  s = s.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** One line of untrusted text: no markup, no controls, bounded. */
function clean(v, max = 200) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  s = s.replace(/<[^>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return s;
}

/** Several lines of untrusted text (a paragraph): as clean(), keeping newlines. */
function cleanBlock(v, max = 2000) {
  if (typeof v !== 'string') return '';
  let s = v.replace(/<[^>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(CONTROL, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return s;
}

/** An https URL or '' - never javascript:, data:, a username or a bare host. */
function httpsUrl(v, { allowHttp = false } = {}) {
  if (typeof v !== 'string' || v.length > 2000) return '';
  let u;
  try { u = new URL(v.trim()); } catch (e) { return ''; }
  if (!(u.protocol === 'https:' || (allowHttp && u.protocol === 'http:'))) return '';
  if (u.username || u.password || !u.hostname.includes('.')) return '';
  return u.toString();
}

/** Whitespace collapsed, for comparing a quoted phrase with its source. */
function squash(s) {
  return String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
}

/** A stable slug: lowercase ascii letters, digits and dashes. */
function slug(v, max = 60) {
  return String(v || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

module.exports = { decodeEntities, htmlToText, clean, cleanBlock, httpsUrl, squash, slug, CONTROL };
