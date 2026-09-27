// A stand-in Anthropic client for local runs and tests (TELLS_FAKE_AI=1).
//
// It answers the three Tells tools deterministically, so every check can be
// driven without a key and without spending anything. It is refused on Cloud
// Run: a deployment that quietly answered with canned readings would look
// like it works and tell real people made-up things about real posts.
//
// It always includes some output the server must clean up: a quote that is
// not in the text (a fabrication the server drops), a duplicate quote, and
// for originality an http link and a URL the search never returned.
//
// Trigger words in the text (or, for pictures, in the image bytes):
//   INJECT        hostile output everywhere: markup, javascript: and http
//                 links, huge strings, bad enums, numbers out of range
//   NOSOURCES     originality finds nothing
//   PAUSE         originality's first turn comes back as pause_turn
//   NORECORD      originality ends a turn without recording; the server has
//                 to ask once more with the tool forced
//   UPSTREAMnnn   the call fails the way the SDK's APIError does

if (process.env.TELLS_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('TELLS_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

const Core = require('../public/tells-core');

function message(content, stop, usage) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: stop || 'tool_use',
    content, usage: usage || { input_tokens: 1800, output_tokens: 240 },
  };
}
const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_${name}`, name, input });

function textOf(params) {
  const m = params.messages[0];
  const c = typeof m.content === 'string' ? m.content : (m.content.find((b) => b.type === 'text') || {}).text || '';
  const inner = c.match(/<<<TEXT\n([\s\S]*)\nTEXT>>>/);
  return inner ? inner[1] : c;
}
function imageBytes(params) {
  const blocks = (params.messages[0].content || []).filter((b) => b.type === 'image');
  return blocks.map((b) => Buffer.from(b.source.data, 'base64').toString('latin1')).join('');
}

function reading(params) {
  const text = textOf(params);
  if (/INJECT/.test(text)) {
    return message([toolUse('record_reading', {
      likelihood: 4000, confidence: 'certain', summary: `<img src=x onerror=alert(1)>This IS AI. ${'x'.repeat(5000)}`,
      human_signs: ['<b>none</b>', 42],
      spans: [
        { quote: 'INJECT', category: '<script>', reason: '<a href="javascript:alert(1)">click</a>', strength: 'extreme' },
        { quote: 'words that never appear anywhere in the submitted text', category: 'stock', reason: 'made up', strength: 'high' },
        { quote: 'x'.repeat(2000), category: 'stock', reason: 'too long', strength: 'high' },
        { quote: 12, category: 'stock', reason: 'not a string', strength: 'high' },
        ...Array.from({ length: 40 }, () => ({ quote: 'INJECT', category: 'stock', reason: 'r'.repeat(900), strength: 'low' })),
      ],
    })]);
  }
  const quick = Core.scan(text);
  const hits = quick.hits.filter((h) => h.counted).slice(0, 12);
  const spans = hits.map((h) => ({ quote: h.quote, category: h.category, reason: `${h.label}: ${h.reason}`, strength: h.weight >= 3 ? 'high' : 'medium' }));
  if (hits[0]) spans.push({ ...spans[0] });
  spans.push({ quote: 'This sentence is not in the text at all.', category: 'generic', reason: 'A fabricated quote the server must drop.', strength: 'high' });
  const likelihood = Math.min(95, quick.score + 8);
  return message([toolUse('record_reading', {
    likelihood,
    confidence: likelihood >= 70 ? 'medium' : 'low',
    summary: hits.length ? 'Several stock phrases and a templated layout; little specific detail.' : 'Few of the usual tells; uneven rhythm and specific detail read as a person.',
    human_signs: hits.length ? [] : ['Specific, local detail', 'Uneven sentence rhythm'],
    spans,
  })]);
}

function originality(params) {
  const text = textOf(params);
  const forced = params.tool_choice && params.tool_choice.type === 'tool';
  const usage = { input_tokens: 4200, output_tokens: 600, server_tool_use: { web_search_requests: 2 } };
  const search = [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'earlier posts' } },
    {
      type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [
        { type: 'web_search_result', url: 'https://example.com/blog/lessons-from-year-one', title: 'Ten lessons from year one', page_age: '2024-05-02', encrypted_content: 'x' },
        { type: 'web_search_result', url: 'https://example.org/guides/growth-culture', title: 'Building a growth culture', page_age: null, encrypted_content: 'y' },
      ],
    },
  ];
  // Paused once per conversation: the resumed call carries the paused turn.
  if (/PAUSE/.test(text) && params.messages.length === 1) {
    return message(search, 'pause_turn', usage);
  }
  if (/NORECORD/.test(text) && !forced) return message([...search, { type: 'text', text: 'I searched and found a couple of similar posts.' }], 'end_turn', usage);
  if (/NOSOURCES/.test(text)) {
    return message([...search, toolUse('record_originality', { originality: 88, confidence: 'low', summary: 'Nothing close turned up.', sources: [], adds: 'Its specific details.' })], 'tool_use', usage);
  }
  if (/INJECT/.test(text)) {
    return message([...search, toolUse('record_originality', {
      originality: -40, confidence: 'sure', summary: '<script>alert(1)</script>'.repeat(40),
      sources: [
        { title: '<img src=x onerror=alert(1)>Real one', url: 'https://example.com/blog/lessons-from-year-one#frag', date: 'yesterday', overlap: 'total', note: 'n'.repeat(900) },
        { title: 'Plain http', url: 'http://example.com/blog/lessons-from-year-one', overlap: 'idea', note: 'http is dropped' },
        { title: 'Script', url: 'javascript:alert(1)', overlap: 'idea', note: 'dropped' },
        { title: 'Invented', url: 'https://made-up.example.net/never-in-results', overlap: 'near-copy', note: 'not in the search results' },
      ],
      adds: '<b>bold</b>',
    })], 'tool_use', usage);
  }
  return message([...search, toolUse('record_originality', {
    originality: 42, confidence: 'medium',
    summary: 'The central idea is common advice; the wording is mostly the author’s own.',
    sources: [
      { title: 'Ten lessons from year one', url: 'https://example.com/blog/lessons-from-year-one', date: '2024-05-02', overlap: 'idea', note: 'Makes the same “people over numbers” point.' },
      { title: 'Building a growth culture', url: 'https://example.org/guides/growth-culture', date: null, overlap: 'phrasing', note: 'Uses the same three-bullet list almost word for word.' },
      { title: 'Not in the results', url: 'https://invented.example.net/post', date: null, overlap: 'near-copy', note: 'The server must drop this one.' },
    ],
    adds: 'A personal announcement wrapped around the advice.',
  })], 'tool_use', usage);
}

function visual(params) {
  const bytes = imageBytes(params);
  const frames = (params.messages[0].content || []).filter((b) => b.type === 'image').length;
  if (/INJECT/.test(bytes)) {
    return message([toolUse('record_visual', {
      likelihood: 250, confidence: 'high', summary: '<svg onload=alert(1)>',
      artefacts: [{ where: '<b>hands</b>', frame: 99, what: 'x'.repeat(900) }, { where: 'sky', frame: -1, what: '' }, 'junk'],
    })]);
  }
  if (/BLANK/.test(bytes)) return message([toolUse('record_visual', { likelihood: 20, confidence: 'high', summary: 'Nothing unusual is visible.', artefacts: [] })]);
  return message([toolUse('record_visual', {
    likelihood: 64, confidence: 'high',
    summary: 'A few details look generated, but nothing is conclusive.',
    artefacts: frames > 1
      ? [{ where: 'left hand', frame: 1, what: 'Six fingers for a moment, then five.' }, { where: 'sign in the background', frame: 3, what: 'The lettering changes between frames.' }]
      : [{ where: 'left hand', frame: null, what: 'The fingers merge into each other.' }, { where: 'shop sign', frame: null, what: 'The lettering is garbled.' }],
  })]);
}

function create() {
  return {
    messages: {
      async create(params) {
        const name = params.tools && params.tools.map((t) => t.name).find((n) => /^record_/.test(n));
        const all = JSON.stringify(params.messages);
        const bytes = (() => { try { return imageBytes(params); } catch (e) { return ''; } })();
        const hit = all.match(/UPSTREAM(\d{3})/) || bytes.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (name === 'record_originality') {
          if (!params.tools.some((t) => t.name === 'web_search')) throw new Error('fake ai: originality must carry web_search');
          return originality(params);
        }
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call but originality must force its tool');
        await new Promise((r) => setTimeout(r, Number(process.env.TELLS_FAKE_DELAY_MS || 0)));
        if (name === 'record_reading') return reading(params);
        if (name === 'record_visual') return visual(params);
        throw new Error(`fake ai: no answer for ${name}`);
      },
    },
  };
}

module.exports = { create };
