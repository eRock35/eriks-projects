// The bookmarklet, built from its one readable source
// (public/bookmarklet.src.js): comments dropped, lines joined, the base URL
// written in, then URL-encoded behind `javascript:`. Deterministic, so the
// test can decode the served link and compare it with this build.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'public', 'bookmarklet.src.js');
const PUBLIC_BASE = 'https://challenge.strongtechnicalconsulting.com/tells/';
const MAX_LENGTH = 2000; // bookmark managers and iOS Safari handle far more; this keeps it honest

/** The source with comments and indentation gone. Only whole-line //
 *  comments are used in the source, so this is safe without a parser. */
function minify(src) {
  return String(src).split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .join('');
}

function build(base, src) {
  const b = String(base || PUBLIC_BASE);
  if (!/^https?:\/\/[^'"\\\s]+\/$/.test(b)) throw new Error('bookmarklet: bad base');
  const code = minify(src === undefined ? fs.readFileSync(SRC, 'utf8') : src).replace('__TELLS_BASE__', b);
  const href = `javascript:${encodeURIComponent(code)}`;
  if (href.length > MAX_LENGTH) throw new Error(`bookmarklet: ${href.length} characters, over ${MAX_LENGTH}`);
  return { href, code, base: b, length: href.length };
}

module.exports = { build, minify, PUBLIC_BASE, MAX_LENGTH, SRC };
