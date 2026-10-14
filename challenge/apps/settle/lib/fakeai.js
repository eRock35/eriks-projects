// A stand-in Anthropic client for local runs and tests (SETTLE_FAKE_AI=1).
//
// It answers the forced tool deterministically, so "Fill the deck for me" can
// be driven without a key and without spending anything. It is refused on
// Cloud Run: a deployment that "suggested" the same ten winter dates for
// every ask would look like it works and be useless.
//
// Triggers, in the ask:
//   BLANK        nothing usable came back (an empty list) - a 422
//   INJECT       hostile output: markup, bidi, huge labels, non-strings,
//                repeats, 300 options, an option already on the list
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - ten cosy winter date ideas

if (process.env.SETTLE_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('SETTLE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 420, output_tokens: 380 },
    ...(extra || {}),
  };
}

const IDEAS = [
  { label: 'Ice skating', emoji: '⛸️', note: 'Then hot chocolate after' },
  { label: 'Homemade pizza night', emoji: '🍕', note: 'Cheap, and you choose the toppings' },
  { label: 'Board game café', emoji: '🎲', note: 'Warm and a few hours for one fee' },
  { label: 'Winter walk and a pub', emoji: '🧣', note: '' },
  { label: 'Movie marathon in a blanket fort', emoji: '🎬', note: 'Free if you own the films' },
  { label: 'Museum free day', emoji: '🏛️', note: 'Many have one a week' },
  { label: 'Bake something together', emoji: '🍪', note: '' },
  { label: 'Stargazing with flasks', emoji: '🌌', note: 'Clear cold nights are best' },
  { label: 'Karaoke at home', emoji: '🎤', note: '' },
  { label: 'Fondue dinner', emoji: '🫕', note: 'Bread, cheese, done' },
];

function suggest(source) {
  if (/BLANK/.test(source)) return toolUse('suggest_options', { options: [] });
  if (/INJECT/.test(source)) {
    const many = [];
    for (let i = 0; i < 300; i++) many.push({ label: `Idea ${i}`, emoji: '✨', note: '' });
    return toolUse('suggest_options', {
      options: [
        { label: `<img src=x onerror=alert(1)>Sk‮ating${'A'.repeat(5000)}`, emoji: '<script>', note: '<b>bold</b>\u0007' },
        { label: '   ', emoji: '🙂' },
        { label: { evil: true }, emoji: '🙂' },
        { label: 'Ice skating', emoji: '⛸️⛸️⛸️⛸️', note: 'x'.repeat(900) },
        { label: 'ice   SKATING', emoji: '⛸️' },
        { label: 'Pizza', emoji: '🍕' },
        ...many,
      ],
    });
  }
  if (/MAXTOKENS/.test(source)) return toolUse('suggest_options', { options: IDEAS.slice(0, 2) }, { stop_reason: 'max_tokens' });
  return toolUse('suggest_options', { options: IDEAS });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        await new Promise((r) => setTimeout(r, Number(process.env.SETTLE_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const source = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = source.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'suggest_options') return suggest(source);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
