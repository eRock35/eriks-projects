// A small Markdown renderer.
//
// Deliberately hand-rolled rather than a dependency: the input is only ever
// Erik's own writing, the output has to work in an email client as well as a
// browser, and the whole landing service is meant to stay dependency-light.
//
// Everything is HTML-escaped FIRST and tags are only introduced afterwards, so
// a stray `<script>` in a draft renders as text instead of running. Link URLs
// are restricted to http, https and mailto, which blocks `javascript:` hrefs.

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function safeUrl(url) {
  const trimmed = String(url || '').trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed.replace(/"/g, '%22');
  return '';
}

function inline(text) {
  let out = text;
  // Images before links: the syntaxes differ only by a leading '!'.
  out = out.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    const href = safeUrl(url);
    return href ? `<img src="${href}" alt="${alt}" loading="lazy">` : alt;
  });
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const href = safeUrl(url);
    if (!href) return label;
    const external = /^https?:/i.test(href);
    return `<a href="${href}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
  });
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
  return out;
}

function render(src) {
  if (!src) return '';
  const lines = escapeHtml(String(src).replace(/\r\n/g, '\n')).split('\n');
  const out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'
  let quote = [];
  let fence = null;

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`</${list}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    if (/^```/.test(line.trim())) {
      if (fence === null) {
        flushAll();
        fence = [];
      } else {
        out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
        fence = null;
      }
      continue;
    }
    if (fence !== null) { fence.push(rawLine); continue; }

    if (!line.trim()) { flushAll(); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushAll();
      // h1 belongs to the page title, so a body heading starts at h2 and a
      // lone `#` is treated as `##` rather than competing with the title.
      const level = Math.min(Math.max(heading[1].length, 2), 5);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

    const quoted = line.match(/^&gt;\s?(.*)$/);
    if (quoted) { flushPara(); flushList(); quote.push(quoted[1]); continue; }
    flushQuote();

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const want = bullet ? 'ul' : 'ol';
      if (list && list !== want) flushList();
      if (!list) { list = want; out.push(`<${want}>`); }
      out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      continue;
    }
    flushList();

    para.push(line.trim());
  }
  if (fence !== null) out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
  flushAll();
  return out.join('\n');
}

/** First paragraph, flattened, for an excerpt or meta description. */
function firstParagraph(src, maxChars = 200) {
  const text = String(src || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+.*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : cut.length)}…`;
}

function readingMinutes(src) {
  const words = String(src || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || `post-${Date.now()}`;
}

module.exports = { render, escapeHtml, firstParagraph, readingMinutes, slugify };
