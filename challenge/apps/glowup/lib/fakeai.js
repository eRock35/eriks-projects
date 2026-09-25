// A stand-in Anthropic client for local runs and tests (GLOWUP_FAKE_AI=1).
//
// It answers all three forced tools deterministically from the listing's own
// words, so the whole product - glow-up, compare, snap - can be driven without
// a key and without spending anything. It is refused on Cloud Run: a
// deployment that quietly answered with canned rewrites would look like it
// works.
//
// Trigger words for tests:
//   INJECT       in a listing - the glow-up also returns markup, markdown, an
//                over-length title, an invented hot tub and a made-up Wi-Fi
//                speed, junk tags; compare returns markup (proves validation
//                strips, trims and guards every one)
//   EMPTY        in a listing - the glow-up returns nothing usable (proves 422)
//   a screenshot whose bytes contain BLANK - "readable: false" (proves 422)

if (process.env.GLOWUP_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('GLOWUP_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

const R = require('../public/rules');

function toolUse(name, input, usage) {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'fake',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: usage || { input_tokens: 1400, output_tokens: 900 },
  };
}

function textOf(params) {
  const msg = params.messages[0].content;
  return typeof msg === 'string' ? msg : msg.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}
function block(text, label) {
  const m = text.match(new RegExp(`^${label}:\\n"""\\n([\\s\\S]*?)\\n"""`, 'm'));
  const v = m ? m[1] : '';
  return v === '(none)' ? '' : v;
}
function line(text, label) { return ((text.match(new RegExp(`^${label}: (.*)$`, 'm')) || [])[1] || '').trim(); }
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

function glow(params) {
  const t = textOf(params);
  const type = R.typeInfo(line(t, 'TYPE').split(' ')[0]);
  const title = block(t, 'LISTING TITLE');
  const desc = block(t, 'LISTING DESCRIPTION');
  const tags = block(t, 'LISTING TAGS').split('\n').map((s) => s.trim()).filter(Boolean);
  const kwLine = line(t, 'SEARCH WORDS');
  const keywords = /^\(none/.test(kwLine) ? [] : kwLine.split(',').map((s) => s.trim()).filter(Boolean);
  const maxT = Number((line(t, 'PLATFORM').match(/Title at most (\d+)/) || [])[1] || 80);
  const maxD = Number((line(t, 'PLATFORM').match(/description at most (\d+)/) || [])[1] || 0);
  const missing = line(t, 'MISSING');
  const shotsMissing = line(t, 'PHOTOS').split('SHOTS MISSING: ')[1] || '';
  const all = `${title}\n${desc}`;
  if (/EMPTY/.test(all)) return toolUse('glow_up', { titles: [], description: '', tags: [], shots: [], gaps: [], summary: '' }, { input_tokens: 900, output_tokens: 20 });

  const kw = keywords[0] || tags[0] || title.split(/\s+/).slice(0, 2).join(' ') || type.short.toLowerCase();
  const feats = tags.filter((x) => x.toLowerCase() !== kw.toLowerCase()).slice(0, 3);
  const titles = [
    { text: `${cap(kw)}${feats[0] ? ` with ${feats[0]}` : ''}${feats[1] ? ` & ${feats[1]}` : ''}`, angle: 'Search first' },
    { text: `${cap(feats[0] || kw)}${feats[0] ? ` ${kw}` : ''}${feats[2] ? `, ${feats[2]}` : ''}`, angle: 'Feature first' },
    { text: `${cap(kw)} - ${title.replace(/[!]+/g, '').replace(/\b[A-Z]{4,}\b/g, (w) => w.toLowerCase()).slice(0, 40)}`, angle: 'Your words, calmer' },
  ];

  // The seller's own sentences, vague words out, as bullets.
  const VAGUE_RE = new RegExp(`\\b(really |very |so )?(${R.VAGUE.map((w) => w.replace(/[-]/g, '\\-')).join('|')})\\b,?\\s*`, 'gi');
  const sents = desc.replace(/([.!?])\s+/g, '$1\n').split(/\n+/)
    .map((s) => s.replace(/^[\s•*-]+/, '').replace(/!+/g, '.').replace(VAGUE_RE, '').replace(/\b(\w+)\s+\1\b/gi, '$1').replace(/\s+/g, ' ').trim())
    .filter((s) => s.split(' ').length >= 3 && !/^(welcome|this is|hello|hi|we are)\b/i.test(s) && !/\b(message|contact|call|book)\b/i.test(s));
  const hookSrc = sents.find((s) => /\d/.test(s)) || `${cap(kw)}${feats.length ? ` with ${feats.slice(0, 2).join(' and ')}` : ''}.`;
  const lines = [hookSrc.replace(/\.?$/, '.')];
  const bullets = sents.filter((s) => s !== hookSrc).slice(0, 6).map((s) => `• ${s.replace(/\.$/, '')}`);
  const gapBullets = missing === 'nothing from that list' ? [] : missing.split('; ').filter(Boolean).map((m) => {
    const mm = m.match(/^(.*?) \((.*)\)$/);
    return mm ? `• ${mm[1]}: [add: ${mm[2]}]` : `• [add: ${m}]`;
  });
  const cta = type.cta;
  let body = [...bullets, ...gapBullets];
  const build = () => [lines[0], ...body, cta].join('\n');
  while (maxD && build().length > maxD - 5 && body.length) {
    // Keep the gaps (they are the point); drop the longest of the seller's own lines.
    const own = body.filter((b) => !/\[add:/.test(b));
    if (!own.length) { body.pop(); continue; }
    const longest = own.reduce((a, b) => (b.length > a.length ? b : a));
    body = body.filter((b) => b !== longest);
  }
  let description = build();

  const shots = shotsMissing === 'none' ? [] : shotsMissing.split('; ').filter(Boolean).slice(0, 5).map((s) => ({ shot: s, why: `Buyers look for this before they ${type.key === 'stay' ? 'book' : type.key === 'service' ? 'call' : 'buy'}.` }));
  const gaps = gapBullets.map((b) => b.replace(/^.*\[add: (.*)\]$/, '$1'));
  const outTags = [...keywords, ...tags].filter((x, i, a) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i).slice(0, 13);

  if (/INJECT/.test(all)) {
    titles.unshift({ text: `<b>${'Huge '.repeat(Math.ceil((maxT + 30) / 5))}</b>`, angle: '<i>Loud</i>' });
    titles.push({ text: `${cap(kw)} with private hot tub`, angle: 'Invented' });
    description = `**${lines[0]}** <script>alert(1)</script>\n## Highlights\n• Blazing Wi-Fi at 900 Mbps\n• A private hot tub under the stars.\n${description}`;
    outTags.push('<img src=x onerror=alert(1)>tag', 'x'.repeat(45), 'hot tub');
    shots.push({ shot: 'The hot tub at dusk', why: 'Everyone loves a hot tub.' });
  }
  return toolUse('glow_up', { titles, description, tags: outTags, shots, gaps, summary: `Led with a fact, cut the adjectives, listed what is included and marked ${gaps.length} gap${gaps.length === 1 ? '' : 's'} for you to fill.` });
}

function compare(params) {
  const t = textOf(params);
  const mine = `${block(t, 'YOUR TITLE')}\n${block(t, 'YOUR DESCRIPTION')}`;
  const theirs = `${block(t, 'THEIR TITLE')}\n${block(t, 'THEIR DESCRIPTION')}`;
  const theirFirst = R.firstSentence(block(t, 'THEIR DESCRIPTION'));
  const out = {
    theyDoBetter: [
      { point: `Their first line gets to the point: “${theirFirst.slice(0, 80)}”`, move: 'Open with your most concrete fact instead of a welcome.' },
      { point: /[•\-*]\s/.test(theirs) ? 'They list what is included as bullets, easy to skim.' : 'Their description is shorter and easier to skim.', move: 'Turn your long paragraph into five short bullets.' },
    ],
    youDoBetter: [{ point: (mine.match(/\d/g) || []).length > (theirs.match(/\d/g) || []).length ? 'You give more numbers - buyers skim for them.' : 'Your title names what you are, plainly.' }],
    verdict: 'Lead with one concrete fact and turn the paragraph into bullets.',
  };
  if (/INJECT/.test(mine + theirs)) {
    out.theyDoBetter.push({ point: '<script>alert(1)</script>They use <b>bold</b> headings', move: '<img src=x onerror=alert(1)>Copy them' });
    out.verdict = `<b>${out.verdict}</b>`;
  }
  return toolUse('compare_listings', out, { input_tokens: 2200, output_tokens: 400 });
}

function read(params) {
  const img = params.messages[0].content.find((b) => b.type === 'image');
  const bytes = Buffer.from(img.source.data, 'base64').toString('latin1');
  if (/BLANK/.test(bytes)) return toolUse('read_listing', { readable: false, type: 'product', title: '', description: '' }, { input_tokens: 1500, output_tokens: 30 });
  return toolUse('read_listing', {
    readable: true,
    type: 'stay',
    platform: 'airbnb',
    title: 'Charming Cottage <b>by the Sea</b>',
    description: 'Welcome to our charming cottage! A lovely place to unwind near the beach.\nSleeps 4 in 2 bedrooms. Parking for one car.',
    tags: ['Beach access', 'Parking', 'Washer'],
    price: '$210 / night',
    photoCount: 11,
  }, { input_tokens: 1900, output_tokens: 300 });
}

function create() {
  return {
    messages: {
      async create(params) {
        const name = params.tool_choice && params.tool_choice.name;
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        await new Promise((r) => setTimeout(r, Number(process.env.GLOWUP_FAKE_DELAY_MS || 0)));
        if (name === 'glow_up') return glow(params);
        if (name === 'compare_listings') return compare(params);
        if (name === 'read_listing') return read(params);
        throw new Error(`fake ai: no answer for ${name}`);
      },
    },
  };
}

module.exports = { create };
