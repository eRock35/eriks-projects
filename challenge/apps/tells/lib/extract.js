// A fetched page, reduced to what Tells checks: its title, its main text and
// its preview tags. No DOM library (the lab image installs --omit=dev and
// avoids native binaries); a page is at most 2 MB and every pattern below is
// a bounded, non-nested scan.
//
// Also: whether the page is a login wall. LinkedIn and X serve logged-in
// pages only; a server that fetches a post gets a sign-in screen and at best
// a cut-down preview line. Tells says so plainly instead of checking the
// sign-in screen for tells.

const MAX_HTML = 2 * 1024 * 1024;
const MAX_TEXT = 20000;
const WALL_HOSTS = /(^|\.)(linkedin\.com|lnkd\.in|x\.com|twitter\.com|t\.co|instagram\.com|facebook\.com|threads\.net)$/i;
const WALL_MESSAGE = 'LinkedIn and X hide posts from servers. Paste the text, or use the Tells extension on the post.';
const WALL_WORDS = /(sign in|log in|join now|sign up)( to| and)? (see|view|continue|read|join)|you need to (sign|log) in|create an account to/i;

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', ouml: 'ö', uuml: 'ü', auml: 'ä', ccedil: 'ç', ntilde: 'ñ', zwj: '', zwnj: '', shy: '' };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n < 9 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '';
      try { return String.fromCodePoint(n); } catch (err) { return ''; }
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function cleanLine(s, max) {
  const out = decodeEntities(String(s || '')).replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** <meta property|name="key" content="..."> in either attribute order. */
function metaTag(html, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = new RegExp(`<meta\\b[^>]*?(?:property|name)\\s*=\\s*["']${k}["'][^>]*?content\\s*=\\s*(["'])([\\s\\S]{0,2000}?)\\1`, 'i');
  const b = new RegExp(`<meta\\b[^>]*?content\\s*=\\s*(["'])([\\s\\S]{0,2000}?)\\1[^>]*?(?:property|name)\\s*=\\s*["']${k}["']`, 'i');
  const m = html.match(a) || html.match(b);
  return m ? m[2] : '';
}

function httpsUrl(raw, base) {
  try {
    const u = new URL(decodeEntities(String(raw || '').trim()), base);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href.slice(0, 2048) : null;
  } catch (e) { return null; }
}

const DROP = ['script', 'style', 'noscript', 'template', 'svg', 'nav', 'header', 'footer', 'aside', 'form', 'iframe', 'button', 'select', 'textarea', 'canvas', 'video', 'audio', 'object', 'figcaption'];

function stripBlocks(html) {
  let out = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of DROP) out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ');
  // An unclosed one runs to the end; drop just its opening tag.
  for (const tag of DROP) out = out.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), ' ');
  return out;
}

/** The inner HTML of the longest element of this kind, or ''. */
function longest(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'gi');
  let best = '', m, guard = 0;
  while ((m = re.exec(html)) && guard++ < 50) if (m[1].length > best.length) best = m[1];
  return best;
}

function toText(fragment) {
  const s = fragment
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|pre|main|dd|dt|figure)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(s)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '')
    .replace(/[ \t ]+/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param body  the page as text (HTML or plain)
 * @param url   the final URL it came from
 * @param type  its content type
 */
function extract(body, url, type) {
  const src = String(body || '').slice(0, MAX_HTML);
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { /* none */ }
  if (type === 'text/plain') {
    const text = toText(src.replace(/</g, '&lt;')).slice(0, MAX_TEXT);
    return { url, host, title: '', text, description: '', image: null, siteName: '', published: null, wall: wallCheck(host, text, ''), cut: src.length > MAX_TEXT };
  }
  const title = cleanLine(metaTag(src, 'og:title') || (src.match(/<title\b[^>]*>([\s\S]{0,1000}?)<\/title>/i) || [])[1], 200);
  const description = cleanLine(metaTag(src, 'og:description') || metaTag(src, 'description') || metaTag(src, 'twitter:description'), 600);
  const image = httpsUrl(metaTag(src, 'og:image') || metaTag(src, 'og:image:url') || metaTag(src, 'twitter:image'), url);
  const siteName = cleanLine(metaTag(src, 'og:site_name'), 80);
  const publishedRaw = metaTag(src, 'article:published_time') || metaTag(src, 'datePublished');
  const published = /^\d{4}-\d{2}-\d{2}/.test(publishedRaw) ? publishedRaw.slice(0, 10) : null;
  const stripped = stripBlocks(src);
  const region = longest(stripped, 'article') || longest(stripped, 'main') || longest(stripped, 'body') || stripped;
  let text = toText(region);
  const cut = text.length > MAX_TEXT;
  if (cut) text = text.slice(0, MAX_TEXT);
  return { url, host, title, text, description, image, siteName, published, wall: wallCheck(host, text, description), cut };
}

/** null, or why this page is not the post itself. */
function wallCheck(host, text, description) {
  if (WALL_HOSTS.test(host)) {
    return { reason: 'social', message: WALL_MESSAGE, preview: description || null };
  }
  const t = String(text || '');
  if (t.length < 200 || (t.length < 1500 && WALL_WORDS.test(t))) {
    return { reason: t.length < 200 ? 'little-text' : 'login', message: 'This page shows too little text to check (it may be behind a sign-in). Paste the text instead.', preview: description || null };
  }
  return null;
}

module.exports = { extract, decodeEntities, wallCheck, WALL_MESSAGE, WALL_HOSTS };
