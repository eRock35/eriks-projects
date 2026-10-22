// A stand-in Anthropic client for local runs and tests (KINDLY_FAKE_AI=1).
//
// It answers the forced tool deterministically, so "Gift ideas for them" can
// be driven without a key and without spending anything. It is refused on
// Cloud Run: a deployment that suggested the same five gifts for everyone
// would look like it works and be useless.
//
// It reads the brief the dumb way - the first like becomes the theme - and
// keeps everything it was sent in `seen`, so a test can prove what the model
// was (and was not) told. Triggers, in the likes:
//   BLANK        five empty ideas - a 422
//   INJECT       hostile output: markup, bidi, links in every field, a
//                `link` key, duplicates, a sixth idea
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does

if (process.env.KINDLY_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('KINDLY_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 610, output_tokens: 320 },
    ...(extra || {}),
  };
}

function answer(text) {
  if (/BLANK/.test(text)) return toolUse('suggest_gifts', { ideas: Array.from({ length: 5 }, () => ({ title: '', why: '', priceRange: '', searchQuery: '' })) });
  if (/MAXTOKENS/.test(text)) return toolUse('suggest_gifts', { ideas: [] }, { stop_reason: 'max_tokens' });
  if (/INJECT/.test(text)) {
    const bad = { title: '<img src=x onerror=alert(1)>Mug‮ https://evil.example/x', why: 'Buy at www.evil.example now <script>x</script>', priceRange: 'javascript:alert(1)', searchQuery: 'mug https://evil.example', link: 'https://evil.example' };
    return toolUse('suggest_gifts', { ideas: [bad, bad, { ...bad, title: 'Candle evil.com' }, { title: 'Plant', why: 'Green', priceRange: '$20-30', searchQuery: 'plant' }, { title: 'Book', why: 'Reads', priceRange: '$15', searchQuery: 'book' }, { title: 'Sixth', why: 'x', priceRange: '$1', searchQuery: 'x' }, { title: 'Seventh', why: 'x', priceRange: '$1', searchQuery: 'x' }, { title: 'Eighth', why: 'x', priceRange: '$1', searchQuery: 'x' }] });
  }
  const like = ((/Likes: ([^\n,]+)/.exec(text) || [])[1] || 'something they love').trim();
  const budget = (/Budget: about \$([\d,]+)/.exec(text) || [])[1];
  const top = budget ? Number(budget.replace(/,/g, '')) : 60;
  const band = (lo, hi) => `$${Math.max(5, Math.round(top * lo))}-${Math.max(10, Math.round(top * hi))}`;
  return toolUse('suggest_gifts', { ideas: [
    { title: `A class in ${like.toLowerCase()}`, why: `They love ${like.toLowerCase()} - an afternoon of doing it beats another thing on a shelf.`, priceRange: band(0.6, 1), searchQuery: `${like} class near me` },
    { title: `${like} book, the good one`, why: 'A well-reviewed book on what they already love.', priceRange: band(0.2, 0.4), searchQuery: `best book about ${like}` },
    { title: 'Handwritten voucher for a day out together', why: 'Time together, planned around them.', priceRange: '$0-20', searchQuery: 'day out ideas' },
    { title: `Small-batch treat linked to ${like.toLowerCase()}`, why: 'Consumable, so it never adds clutter.', priceRange: band(0.3, 0.5), searchQuery: `${like} gift small batch` },
    { title: 'Framed photo from this year', why: 'Personal, and nobody else can give it.', priceRange: band(0.3, 0.6), searchQuery: 'custom photo frame print' },
  ] });
}

function create() {
  const calls = [];
  const seen = [];
  return {
    calls,
    seen,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        seen.push(JSON.stringify({ system: params.system, messages: params.messages }));
        await new Promise((r) => setTimeout(r, Number(process.env.KINDLY_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = text.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name !== 'suggest_gifts') throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
        return answer(text);
      },
    },
  };
}

module.exports = { create };
