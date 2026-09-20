// Server-rendered pages for the writing section.
//
// These are rendered on the server rather than fetched by script so that a
// post is a real HTML document: crawlable, shareable with a preview card, and
// readable before any JavaScript runs.

const { escapeHtml, render: renderMarkdown, readingMinutes } = require('./markdown');

const SITE_NAME = 'Erik Strong';

function origin() {
  return (process.env.SITE_ORIGIN || 'https://www.strongtechnicalconsulting.com').replace(/\/$/, '');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function page({ title, description, body, canonical, image, noindex }) {
  const desc = description || 'Writing from Erik Strong on data, applied AI and building things that ship.';
  const url = canonical ? `${origin()}${canonical}` : origin();
  const img = image || `${origin()}/assets/erik.jpg`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
${noindex ? '<meta name="robots" content="noindex">' : ''}
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#F2F2F7">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${escapeHtml(img)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${escapeHtml(url)}">
<link rel="alternate" type="application/rss+xml" title="${SITE_NAME}" href="${origin()}/feed.xml">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/erik-320.jpg">
<link rel="stylesheet" href="/assets/reader.css">
</head>
<body>
<nav class="nav">
  <div class="nav-inner">
    <a class="brand" href="/"><img src="/assets/erik-320.jpg" alt="" width="28" height="28"><span>Erik Strong</span></a>
    <div class="nav-links">
      <a href="/writing">Writing</a>
      <a href="/#projects">Projects</a>
      <a href="/#contact">Contact</a>
    </div>
  </div>
</nav>
<main class="wrap">
${body}
</main>
<footer>
  <a href="/">strongtechnicalconsulting.com</a> &middot; <a href="/feed.xml">RSS</a><br>
  Built and run by Erik Strong in Atlanta.
</footer>
</body>
</html>`;
}

function subscribeBox(message) {
  return `<section class="subscribe" id="subscribe">
  <h2>Get new posts by email</h2>
  <p>Occasional writing on data, applied AI and building things that ship. No schedule, no spam, unsubscribe in one tap.</p>
  <form class="subscribe-form" method="POST" action="/api/subscribe">
    <input type="email" name="email" inputmode="email" autocomplete="email" autocapitalize="none"
           spellcheck="false" enterkeyhint="go" placeholder="you@example.com" aria-label="Your email" required>
    <button type="submit">Subscribe</button>
  </form>
  <p class="subscribe-note">${message ? escapeHtml(message) : 'You will get one email to confirm. That is the only one until there is something to read.'}</p>
</section>`;
}

function postCard(post) {
  const date = formatDate(post.publishedAt);
  return `<a class="post-card" href="/writing/${encodeURIComponent(post.slug)}">
  <div class="post-card-meta">${escapeHtml(date)}${date ? ' &middot; ' : ''}${readingMinutes(post.body)} min read</div>
  <h3>${escapeHtml(post.title)}</h3>
  <p>${escapeHtml(post.excerpt || '')}</p>
  <span class="post-card-more">Read <svg viewBox="0 0 8 14" aria-hidden="true"><path d="M1.5 1.5L6.5 7l-5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
</a>`;
}

function writingIndex(posts) {
  const list = posts.length
    ? `<div class="post-list">${posts.map(postCard).join('\n')}</div>`
    : `<div class="empty"><h3>Nothing published yet</h3><p>The first post is coming. Subscribe below and it will land in your inbox.</p></div>`;
  return page({
    title: `Writing · ${SITE_NAME}`,
    description: 'Writing from Erik Strong on data, applied AI and building things that ship.',
    canonical: '/writing',
    body: `<header class="page-head">
  <p class="eyebrow">Writing</p>
  <h1>Thoughts, mostly on data and AI</h1>
  <p class="lede">Short pieces on what actually works when you put data and AI in front of a business.</p>
</header>
${list}
${subscribeBox()}`,
  });
}

function postPage(post) {
  const date = formatDate(post.publishedAt);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt || post.publishedAt,
    author: { '@type': 'Person', name: 'Erik Strong', url: origin() },
    mainEntityOfPage: `${origin()}/writing/${post.slug}`,
  };
  return page({
    title: `${post.title} · ${SITE_NAME}`,
    description: post.excerpt,
    canonical: `/writing/${post.slug}`,
    body: `<article class="post">
  <header class="post-head">
    <p class="eyebrow"><a href="/writing">Writing</a></p>
    <h1>${escapeHtml(post.title)}</h1>
    ${post.subtitle ? `<p class="lede">${escapeHtml(post.subtitle)}</p>` : ''}
    <p class="post-meta">${escapeHtml(date)}${date ? ' &middot; ' : ''}${readingMinutes(post.body)} min read</p>
  </header>
  <div class="prose">${renderMarkdown(post.body)}</div>
</article>
${subscribeBox()}
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
  });
}

function notice({ title, heading, message, noindex = true }) {
  return page({
    title: `${title} · ${SITE_NAME}`,
    canonical: null,
    noindex,
    body: `<div class="notice">
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(message)}</p>
  <p><a class="btn" href="/writing">Back to the writing</a></p>
</div>`,
  });
}

function unsubscribeConfirm(token, email) {
  return page({
    title: `Unsubscribe · ${SITE_NAME}`,
    noindex: true,
    body: `<div class="notice">
  <h1>Unsubscribe?</h1>
  <p>${escapeHtml(email)} will stop receiving new posts.</p>
  <form method="POST" action="/unsubscribe">
    <input type="hidden" name="t" value="${escapeHtml(token)}">
    <button class="btn btn-danger" type="submit">Yes, unsubscribe me</button>
  </form>
  <p><a href="/writing">No, keep me on the list</a></p>
</div>`,
  });
}

/* ---------- email bodies ---------- */

// Inline styles, a table-free single column and a light background: the safest
// shape across Gmail, Apple Mail and Outlook.
function emailShell(innerHtml, { unsubscribeUrl, preheader }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f2f2f7;">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>` : ''}
<div style="max-width:600px;margin:0 auto;padding:28px 20px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1d1d1f;line-height:1.55;font-size:17px;">
${innerHtml}
<div style="margin-top:36px;padding-top:18px;border-top:1px solid #d8d8dd;font-size:13px;color:#6e6e73;">
  You are getting this because you subscribed at
  <a href="${origin()}" style="color:#6e6e73;">strongtechnicalconsulting.com</a>.<br>
  <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6e6e73;">Unsubscribe</a>
</div>
</div>
</body></html>`;
}

function confirmEmail({ confirmUrl, unsubscribeUrl }) {
  const inner = `<h1 style="font-size:24px;font-weight:700;margin:0 0 14px;">Confirm your subscription</h1>
<p style="margin:0 0 18px;">Tap the button and you are on the list. If you did not sign up, ignore this and nothing happens.</p>
<p style="margin:0 0 22px;">
  <a href="${escapeHtml(confirmUrl)}" style="display:inline-block;background:#007aff;color:#ffffff;text-decoration:none;font-weight:600;padding:13px 22px;border-radius:12px;">Confirm subscription</a>
</p>
<p style="margin:0;font-size:14px;color:#6e6e73;">Or paste this into your browser:<br>${escapeHtml(confirmUrl)}</p>`;
  return {
    subject: 'Confirm your subscription',
    html: emailShell(inner, { unsubscribeUrl, preheader: 'One tap and you are on the list.' }),
    text: `Confirm your subscription\n\n${confirmUrl}\n\nIf you did not sign up, ignore this email.`,
  };
}

function postEmail(post, { unsubscribeUrl }) {
  const inner = `<h1 style="font-size:26px;font-weight:700;letter-spacing:-0.02em;margin:0 0 6px;">${escapeHtml(post.title)}</h1>
${post.subtitle ? `<p style="margin:0 0 6px;color:#6e6e73;font-size:18px;">${escapeHtml(post.subtitle)}</p>` : ''}
<p style="margin:0 0 24px;color:#8e8e93;font-size:14px;">${escapeHtml(formatDate(post.publishedAt))}</p>
<div class="prose">${renderMarkdown(post.body)}</div>
<p style="margin:28px 0 0;">
  <a href="${origin()}/writing/${encodeURIComponent(post.slug)}" style="color:#007aff;font-weight:600;text-decoration:none;">Read it on the site</a>
</p>`;
  return {
    subject: post.emailSubject || post.title,
    html: emailShell(inner, { unsubscribeUrl, preheader: post.excerpt }),
    text: `${post.title}\n\n${post.body}\n\n---\nRead online: ${origin()}/writing/${post.slug}\nUnsubscribe: ${unsubscribeUrl}`,
  };
}

function feed(posts) {
  const items = posts.map((p) => `  <item>
    <title>${escapeHtml(p.title)}</title>
    <link>${origin()}/writing/${encodeURIComponent(p.slug)}</link>
    <guid isPermaLink="true">${origin()}/writing/${encodeURIComponent(p.slug)}</guid>
    <pubDate>${new Date(p.publishedAt).toUTCString()}</pubDate>
    <description>${escapeHtml(p.excerpt || '')}</description>
  </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${SITE_NAME}</title>
  <link>${origin()}/writing</link>
  <atom:link href="${origin()}/feed.xml" rel="self" type="application/rss+xml"/>
  <description>Writing from Erik Strong on data, applied AI and building things that ship.</description>
  <language>en-us</language>
${items}
</channel>
</rss>`;
}

module.exports = {
  origin,
  page,
  writingIndex,
  postPage,
  notice,
  unsubscribeConfirm,
  confirmEmail,
  postEmail,
  feed,
  formatDate,
};
