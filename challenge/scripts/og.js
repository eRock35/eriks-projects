#!/usr/bin/env node
/**
 * Link previews for the lab (2026-09-26): the picture a pasted link unfolds
 * into on LinkedIn, X, iMessage and Slack.
 *
 *   npm run og            (in challenge/) - draw every card, write every tag
 *   npm run og -- --check - change nothing; exit 1 if anything is stale
 *
 * What it writes, all committed:
 *   public/og/<slug>.png  one 1200x630 card per live app, from its lab.js
 *                         entry: its two colours, its emoji, name, tagline
 *   public/og/lab.png     the landing page's card: how many apps, the
 *                         newest nine as tiles
 *   og-manifest.json      per card, a hash of what it was drawn FROM and a
 *                         hash of the PNG itself (the ?v= on its URL)
 *   the <!-- lab:og --> block in public/index.html and in each app's
 *   apps/<slug>/public/index.html: og:* and twitter:* tags with ABSOLUTE
 *   https URLs, because an unfurler resolves nothing relative
 *
 * Static on purpose. The runtime image carries no renderer (resvg and the
 * emoji set are devDependencies, and the Dockerfile installs --omit=dev):
 * a card only changes when lab.js does, and lab.js only changes with a
 * deploy. test/og.js fails when a card is missing or was drawn from an older
 * lab.js entry, so the daily run cannot ship a drop without its picture.
 *
 * The emoji: Inter's Latin subset has none, and resvg does not draw colour
 * emoji fonts, so each emoji is drawn from Noto Emoji's own SVGs
 * (@iconify-json/noto, Apache-2.0) - vector, so it is crisp at 360px. An
 * emoji the set does not have becomes the app's initial on a white tile.
 * No model call anywhere in this.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LAB_ORIGIN = 'https://challenge.strongtechnicalconsulting.com';
const W = 1200;
const H = 630;
const FONT_FILES = ['Inter-Regular.ttf', 'Inter-Bold.ttf', 'Inter-Black.ttf'].map((f) => path.join(__dirname, 'fonts', f));
const MANIFEST = path.join(ROOT, 'og-manifest.json');
const SITE_NAME = 'The Challenge Lab';
const BEGIN = '<!-- lab:og (written by scripts/og.js from lab.js; npm run og, never by hand) -->';
const END = '<!-- /lab:og -->';

/* ---------------- pure: what a card is drawn from, and its tags ---------------- */

const HEX = /^#[0-9a-f]{6}$/i;
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** The apps that get a card: live in the lab (testing) and not retired. */
function cardApps(apps) {
  return apps.map((a, i) => ({ a, drop: i + 1 })).filter(({ a }) => a.status === 'testing');
}

/** Exactly the fields a card is drawn from. A change to any of them is a new card. */
function appInputs(a, drop) {
  return {
    kind: 'app', slug: a.slug, drop, name: clean(a.name, 40), emoji: clean(a.emoji, 16),
    color: HEX.test(a.color) ? a.color : '#7c3aed', color2: HEX.test(a.color2) ? a.color2 : '#ec4899',
    tagline: clean(a.tagline, 140),
  };
}
function landingInputs(apps) {
  // Shipped counts every drop, as the page's own "apps shipped" does; the
  // tiles are the newest nine still standing.
  const standing = apps.map((a, i) => ({ a, drop: i + 1 })).filter(({ a }) => a.status !== 'retired');
  return {
    kind: 'lab', count: apps.length,
    tiles: standing.slice(-9).map(({ a, drop }) => ({ drop, name: clean(a.name, 40), emoji: clean(a.emoji, 16), color: HEX.test(a.color) ? a.color : '#7c3aed', color2: HEX.test(a.color2) ? a.color2 : '#ec4899' })),
  };
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** Stable hash of a card's inputs (key order is fixed by the builders above). */
const inputHash = (inputs) => sha(JSON.stringify(inputs)).slice(0, 16);

/** Text for an HTML attribute or an SVG text node. */
function esc(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** What each page says about itself when pasted. */
function appMeta(a, drop, v) {
  const name = clean(a.name, 40);
  return {
    title: `${name} — ${clean(a.tagline, 140)}`,
    description: clean(a.blurb, 280) || clean(a.tagline, 140),
    url: `${LAB_ORIGIN}/${a.slug}/`,
    image: `${LAB_ORIGIN}/og/${a.slug}.png?v=${v}`,
    alt: `${name}, drop #${String(drop).padStart(2, '0')} in the Challenge Lab: ${clean(a.tagline, 140)}`,
  };
}
function landingMeta(count, v) {
  return {
    title: 'The Challenge Lab — a new app every day',
    description: `${count} app${count === 1 ? '' : 's'} so far, each trying to fix a real business headache in a way that’s fun to use. Try them free, then vote: keep it or kill it.`,
    url: `${LAB_ORIGIN}/`,
    image: `${LAB_ORIGIN}/og/lab.png?v=${v}`,
    alt: `The Challenge Lab: a new app every day. ${count} apps shipped so far.`,
  };
}

/** The <!-- lab:og --> block. Every value escaped. */
function tagsBlock(m) {
  const p = (k, v) => `  <meta property="${k}" content="${esc(v)}">`;
  const n = (k, v) => `  <meta name="${k}" content="${esc(v)}">`;
  return [
    `  ${BEGIN}`,
    p('og:type', 'website'), p('og:site_name', SITE_NAME), p('og:title', m.title), p('og:description', m.description),
    p('og:url', m.url), p('og:image', m.image), p('og:image:type', 'image/png'), p('og:image:width', W), p('og:image:height', H),
    p('og:image:alt', m.alt),
    n('twitter:card', 'summary_large_image'), n('twitter:title', m.title), n('twitter:description', m.description),
    n('twitter:image', m.image), n('twitter:image:alt', m.alt),
    `  ${END}`,
  ].join('\n');
}

/** The page with its block replaced, or added just before </head>. */
function withBlock(html, block) {
  const re = /[ \t]*<!-- lab:og[\s\S]*?<!-- \/lab:og -->/;
  if (re.test(html)) return html.replace(re, () => block);
  if (!/<\/head>/i.test(html)) throw new Error('no </head> to put the tags before');
  return html.replace(/<\/head>/i, () => `${block}\n</head>`);
}
/** The block a page carries now, or null. */
function blockOf(html) {
  const m = /[ \t]*<!-- lab:og[\s\S]*?<!-- \/lab:og -->/.exec(html);
  return m ? m[0] : null;
}

/* ---------------- drawing (build time only) ---------------- */

let Resvg = null;
function resvg() {
  if (!Resvg) ({ Resvg } = require('@resvg/resvg-js'));
  return Resvg;
}
const FONT = { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' };

// Real widths from the renderer itself, so text is fitted, not guessed.
const widths = new Map();
function measure(s, size, weight) {
  const key = `${size}|${weight}|${s}`;
  if (!widths.has(key)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="400"><text x="0" y="300" font-family="Inter" font-size="${size}" font-weight="${weight}">${esc(s)}</text></svg>`;
    const R = resvg();
    const box = new R(svg, { font: FONT }).getBBox();
    widths.set(key, box ? box.width : 0);
  }
  return widths.get(key);
}
/** Greedy word wrap to `px`; the last allowed line ends in … when cut. */
function wrap(s, size, weight, px, maxLines) {
  const words = clean(s, 400).split(' ').filter(Boolean);
  const lines = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (!cur || measure(next, size, weight) <= px) { cur = next; continue; }
    lines.push(cur); cur = words[i];
    if (lines.length === maxLines) { cur = null; break; }
  }
  if (cur) lines.push(cur);
  if (cur === null) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && measure(`${last}…`, size, weight) > px) last = last.replace(/\s*\S+$/, '') || last.slice(0, -1);
    lines[maxLines - 1] = `${last.replace(/[\s,.;:—–-]+$/, '')}…`;
  }
  return lines;
}
/** The biggest size, down to `min`, at which `s` fits `px` on one line. */
function fitSize(s, max, min, weight, px) {
  for (let size = max; size > min; size -= 2) if (measure(s, size, weight) <= px) return size;
  return min;
}

// Noto Emoji as vector art. Ids inside an emoji are prefixed, so two emoji
// on one card (the landing's tiles) cannot share a gradient by accident.
let noto = null;
function emojiArt(emoji, x, y, size, uid) {
  if (!noto) {
    try { noto = { chars: require('@iconify-json/noto/chars.json'), set: require('@iconify-json/noto/icons.json') }; } catch (e) { noto = false; }
  }
  if (!noto) return null;
  const cps = [...String(emoji)].map((c) => c.codePointAt(0).toString(16));
  const name = noto.chars[cps.join('-')] || noto.chars[cps.filter((c) => c !== 'fe0f').join('-')];
  const icon = name && (noto.set.icons[name] || (noto.set.aliases && noto.set.aliases[name] && noto.set.icons[noto.set.aliases[name].parent]));
  if (!icon) return null;
  const w = icon.width || noto.set.width || 128, h = icon.height || noto.set.height || 128;
  const body = icon.body
    .replace(/\bid="([^"]+)"/g, (_, id) => `id="${uid}-${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${uid}-${id})`)
    .replace(/href="#([^"]+)"/g, (_, id) => `href="#${uid}-${id}"`);
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${icon.left || 0} ${icon.top || 0} ${w} ${h}">${body}</svg>`;
}
/** The emoji, or the app's initial on a white tile when the set lacks it. */
function mark(emoji, name, x, y, size, uid, ink) {
  const art = emojiArt(emoji, x, y, size, uid);
  if (art) return art;
  const r = Math.round(size * 0.22);
  return `<rect x="${x + size * 0.08}" y="${y + size * 0.08}" width="${size * 0.84}" height="${size * 0.84}" rx="${r}" fill="#fff"/>` +
    `<text x="${x + size / 2}" y="${y + size * 0.68}" font-family="Inter" font-weight="900" font-size="${Math.round(size * 0.5)}" fill="${ink}" text-anchor="middle">${esc(clean(name, 40).charAt(0).toUpperCase())}</text>`;
}

// White text must hold 4.5:1 on the card. Most lab colours already do (lab.js
// says so beside each); a light pair (Spar's orange, Snapquote's teal) is
// darkened towards black just enough, so the card stays that app's colour.
function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function deepen(hex) {
  let rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let k = 0; k < 40 && 1.05 / (lum(`#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`) + 0.05) < 4.6; k++) rgb = rgb.map((v) => Math.round(v * 0.96));
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function appSvg(inp) {
  const LEFT = 72, TEXT_W = 660;
  const nameSize = fitSize(inp.name, 136, 64, 900, TEXT_W);
  let tagSize = 48, lines = wrap(inp.tagline, tagSize, 700, TEXT_W, 3);
  if (lines.length === 3) { tagSize = 40; lines = wrap(inp.tagline, tagSize, 700, TEXT_W + 20, 3); }
  const c1 = deepen(inp.color), c2 = deepen(inp.color2);
  const pill = `THE CHALLENGE LAB  ·  DROP #${String(inp.drop).padStart(2, '0')}`;
  const pillW = Math.ceil(measure(pill, 22, 700) + 3 * pill.length) + 44;
  const nameY = 146 + nameSize * 0.86;
  const tagTop = nameY + 34;
  const url = `challenge.strongtechnicalconsulting.com/${inp.slug}`;
  const cta = 'Try it free, then vote: keep it or kill it';
  const ctaW = Math.ceil(measure(cta, 26, 700)) + 52;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    '<defs>' +
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>` +
    '<radialGradient id="hi" cx="1" cy="0" r="0.75"><stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.55" stop-color="#fff" stop-opacity="0"/></radialGradient>' +
    '<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.22"/></linearGradient>' +
    '<filter id="drop" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#000" flood-opacity="0.32"/></filter>' +
    '</defs>' +
    `<rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#hi)"/><rect width="${W}" height="${H}" fill="url(#shade)"/>` +
    '<circle cx="960" cy="300" r="215" fill="#fff" fill-opacity="0.13"/><circle cx="960" cy="300" r="160" fill="#fff" fill-opacity="0.10"/>' +
    `<g filter="url(#drop)" transform="rotate(-8 960 300)">${mark(inp.emoji, inp.name, 790, 130, 340, 'e', c1)}</g>` +
    `<rect x="${LEFT}" y="68" width="${pillW}" height="46" rx="23" fill="#000" fill-opacity="0.24"/>` +
    `<text x="${LEFT + 22}" y="99" font-family="Inter" font-size="22" font-weight="700" letter-spacing="3" fill="#fff">${esc(pill)}</text>` +
    `<text x="${LEFT - 4}" y="${nameY}" font-family="Inter" font-size="${nameSize}" font-weight="900" letter-spacing="-${Math.round(nameSize * 0.035)}" fill="#fff">${esc(inp.name)}</text>` +
    lines.map((l, i) => `<text x="${LEFT}" y="${Math.round(tagTop + tagSize * 1.02 + i * tagSize * 1.2)}" font-family="Inter" font-size="${tagSize}" font-weight="700" fill="#fff">${esc(l)}</text>`).join('') +
    `<rect x="${LEFT}" y="472" width="${ctaW}" height="58" rx="18" fill="#fff"/>` +
    `<text x="${LEFT + 26}" y="510" font-family="Inter" font-size="26" font-weight="700" fill="#16131f">${esc(cta)}</text>` +
    `<text x="${LEFT}" y="580" font-family="Inter" font-size="24" font-weight="700" fill="#fff" fill-opacity="0.9">${esc(url)}</text>` +
    '</svg>';
}

function landingSvg(inp) {
  const tiles = inp.tiles;
  const T = 124, G = 18, cols = 3;
  const gx = W - 72 - (cols * T + (cols - 1) * G), gy = 118;
  const grid = tiles.map((t, i) => {
    const x = gx + (i % cols) * (T + G), y = gy + Math.floor(i / cols) * (T + G);
    const newest = i === tiles.length - 1;
    return `<linearGradient id="t${i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.color}"/><stop offset="1" stop-color="${t.color2}"/></linearGradient>` +
      `<rect x="${x}" y="${y}" width="${T}" height="${T}" rx="30" fill="url(#t${i})"/>` +
      `<rect x="${x}" y="${y}" width="${T}" height="${T}" rx="30" fill="url(#tileHi)"/>` +
      (newest ? `<rect x="${x - 7}" y="${y - 7}" width="${T + 14}" height="${T + 14}" rx="36" fill="none" stroke="#fff" stroke-width="4"/>` : '') +
      mark(t.emoji, t.name, x + 24, y + 24, T - 48, `t${i}e`, t.color) +
      (newest ? `<rect x="${x + T - 62}" y="${y - 16}" width="72" height="32" rx="16" fill="#fff"/><text x="${x + T - 26}" y="${y + 6}" font-family="Inter" font-size="17" font-weight="900" letter-spacing="1.5" fill="#16131f" text-anchor="middle">NEW</text>` : '');
  }).join('');
  const count = `${inp.count} app${inp.count === 1 ? '' : 's'} shipped.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    '<defs>' +
    '<radialGradient id="b1" cx="0.08" cy="0.05" r="0.55"><stop offset="0" stop-color="#7c3aed" stop-opacity="0.55"/><stop offset="1" stop-color="#7c3aed" stop-opacity="0"/></radialGradient>' +
    '<radialGradient id="b2" cx="0.98" cy="0.45" r="0.5"><stop offset="0" stop-color="#ec4899" stop-opacity="0.42"/><stop offset="1" stop-color="#ec4899" stop-opacity="0"/></radialGradient>' +
    '<radialGradient id="b3" cx="0.35" cy="1.05" r="0.5"><stop offset="0" stop-color="#f59e0b" stop-opacity="0.30"/><stop offset="1" stop-color="#f59e0b" stop-opacity="0"/></radialGradient>' +
    '<linearGradient id="word" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#a78bfa"/><stop offset="0.5" stop-color="#f472b6"/><stop offset="1" stop-color="#fbbf24"/></linearGradient>' +
    '<linearGradient id="flask" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#ec4899"/></linearGradient>' +
    '<radialGradient id="tileHi" cx="1" cy="0" r="0.9"><stop offset="0" stop-color="#fff" stop-opacity="0.28"/><stop offset="0.6" stop-color="#fff" stop-opacity="0"/></radialGradient>' +
    '</defs>' +
    `<rect width="${W}" height="${H}" fill="#120f24"/><rect width="${W}" height="${H}" fill="url(#b1)"/><rect width="${W}" height="${H}" fill="url(#b2)"/><rect width="${W}" height="${H}" fill="url(#b3)"/>` +
    '<rect x="72" y="64" width="64" height="64" rx="18" fill="url(#flask)"/>' +
    (emojiArt('🧪', 84, 76, 40, 'flask') || '') +
    '<text x="154" y="107" font-family="Inter" font-size="30" font-weight="700" fill="#f4f1ff">The Challenge Lab</text>' +
    '<text x="66" y="268" font-family="Inter" font-size="104" font-weight="900" letter-spacing="-4" fill="#f4f1ff">A new app</text>' +
    '<text x="66" y="380" font-family="Inter" font-size="104" font-weight="900" letter-spacing="-4" fill="url(#word)">every day.</text>' +
    `<text x="72" y="450" font-family="Inter" font-size="32" font-weight="700" fill="#f4f1ff">${esc(count)}</text>` +
    '<text x="72" y="494" font-family="Inter" font-size="30" font-weight="400" fill="#c9c4de">Try them free, then vote: keep it or kill it.</text>' +
    grid +
    '<text x="72" y="578" font-family="Inter" font-size="24" font-weight="700" fill="#c9c4de">challenge.strongtechnicalconsulting.com</text>' +
    '</svg>';
}

function png(svg) {
  const R = resvg();
  return new R(svg, { font: FONT, fitTo: { mode: 'width', value: W } }).render().asPng();
}

/* ---------------- the run ---------------- */

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) { return { cards: {} }; }
}

/** Everything a run would write: [{file, data}], plus the new manifest. */
function plan(apps, { redraw } = {}) {
  const old = readManifest().cards || {};
  const cards = {};
  const out = [];
  const card = (key, inputs, svgOf) => {
    const h = inputHash(inputs);
    const file = path.join(ROOT, 'public', 'og', `${key}.png`);
    if (!redraw && old[key] && old[key].inputs === h && fs.existsSync(file)) {
      cards[key] = old[key];
      return old[key].v;
    }
    const data = png(svgOf(inputs));
    cards[key] = { inputs: h, v: sha(data).slice(0, 10) };
    out.push({ file, data });
    return cards[key].v;
  };
  for (const { a, drop } of cardApps(apps)) {
    const page = path.join(ROOT, 'apps', a.slug, 'public', 'index.html');
    if (!fs.existsSync(page)) continue;
    const v = card(a.slug, appInputs(a, drop), appSvg);
    out.push({ file: page, data: withBlock(fs.readFileSync(page, 'utf8'), tagsBlock(appMeta(a, drop, v))) });
  }
  const li = landingInputs(apps);
  const v = card('lab', li, landingSvg);
  const landing = path.join(ROOT, 'public', 'index.html');
  out.push({ file: landing, data: withBlock(fs.readFileSync(landing, 'utf8'), tagsBlock(landingMeta(li.count, v))) });
  return { out, manifest: { note: 'Written by scripts/og.js. inputs = hash of the lab.js fields a card is drawn from; v = hash of the PNG (its ?v=).', cards } };
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const { APPS } = require('../lab');
  const { out, manifest } = plan(APPS, { redraw: process.argv.includes('--redraw') });
  const changed = out.filter(({ file, data }) => !fs.existsSync(file) || !Buffer.from(data).equals(fs.readFileSync(file)));
  const mText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!fs.existsSync(MANIFEST) || fs.readFileSync(MANIFEST, 'utf8') !== mText) changed.push({ file: MANIFEST, data: mText });
  if (check) {
    changed.forEach(({ file }) => console.log(`stale: ${path.relative(ROOT, file)}`));
    process.exit(changed.length ? 1 : 0);
  }
  fs.mkdirSync(path.join(ROOT, 'public', 'og'), { recursive: true });
  for (const { file, data } of changed) { fs.writeFileSync(file, data); console.log(`wrote ${path.relative(ROOT, file)}`); }
  if (!changed.length) console.log('Every card and tag is current.');
}

module.exports = {
  LAB_ORIGIN, W, H, BEGIN, END, cardApps, appInputs, landingInputs, inputHash, esc, appMeta, landingMeta, tagsBlock, withBlock, blockOf,
  appSvg, landingSvg, deepen, lum,
};
