// Link-preview tags, written into index.html on the server.
//
// iMessage, X, LinkedIn and Slack read the HTML they are served and run no
// script, so a share link that falls through to the same static page unfolds
// as "DataViz" with no picture. These tags are the only thing they see.
//
// Everything that goes in is a project's title and subtitle - text a signed-in
// stranger typed, or a model wrote - so every value is escaped for an HTML
// attribute, stripped of control characters and cut to length. The origin
// comes from the Host header, so it is checked against a hostname shape
// before it is trusted to build an absolute URL.

const FALLBACK_HOST = 'dataviz.strongtechnicalconsulting.com';
const START = '<!-- og:start -->';
const END = '<!-- og:end -->';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** One line of plain text, bounded. Control characters (including newlines
 *  and the bidi overrides) go, so a title cannot break a preview's layout. */
function clean(s, max) {
  const t = String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** https://<host> for this request. PUBLIC_ORIGIN wins when set; otherwise
 *  the Host header, but only when it looks like a hostname - anything else
 *  falls back to the custom domain rather than being echoed into a URL. */
function originOf(req) {
  const env = String(process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(env)) return env;
  const host = String((req.get && req.get('host')) || '');
  const ok = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(host);
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  // Local runs are http; everything deployed is behind TLS.
  const proto = local ? (req.protocol || 'http') : 'https';
  return `${proto}://${ok ? host.toLowerCase() : FALLBACK_HOST}`;
}

/** The tag block. `image` is an absolute URL; width/height say what it is. */
function tags({ title, description, url, image, imageAlt, imageType, width, height }) {
  const t = clean(title, 110) || 'DataViz';
  const d = clean(description, 200);
  const lines = [
    `<title>${esc(t)}</title>`,
    `<meta name="description" content="${esc(d)}">`,
    '<meta property="og:site_name" content="DataViz">',
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${esc(t)}">`,
    `<meta property="og:description" content="${esc(d)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:width" content="${Number(width) || 1200}">`,
    `<meta property="og:image:height" content="${Number(height) || 630}">`,
    `<meta property="og:image:type" content="${esc(imageType || 'image/png')}">`,
    `<meta property="og:image:alt" content="${esc(clean(imageAlt || t, 200))}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(t)}">`,
    `<meta name="twitter:description" content="${esc(d)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
  ];
  return lines.join('\n');
}

/** index.html with the block between the markers replaced. A page without
 *  the markers is returned untouched rather than guessed at. */
function inject(html, block) {
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a < 0 || b < a) return html;
  return html.slice(0, a + START.length) + '\n' + block + '\n' + html.slice(b);
}

const HOME = {
  title: 'DataViz — make your data move',
  description: 'Point at a table or a link and get a chart that plays: bars overtaking, lines drawing themselves, traffic flowing. The samples are free, no account needed.',
};

module.exports = { esc, clean, originOf, tags, inject, HOME, START, END };
