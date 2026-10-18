// A stand-in Anthropic client for local runs and tests (BOOMERANG_FAKE_AI=1).
//
// It answers the forced tool deterministically, so "Write it for me" can be
// driven without a key and without spending anything. It is refused on
// Cloud Run: a deployment that wrote the same three messages for everyone
// would look like it works and be useless.
//
// Triggers, in the hint:
//   BLANK        nothing usable came back - a 422
//   INJECT       hostile output: markup, bidi, huge text, non-strings,
//                unknown tones, repeats, twenty options
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - three messages in the tone asked for

if (process.env.BOOMERANG_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('BOOMERANG_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 310, output_tokens: 240 },
    ...(extra || {}),
  };
}

function write(source) {
  const tone = (/Tone: (\w+)/.exec(source) || [])[1] || 'friendly';
  const who = (/Write to (.+?) by name\./.exec(source) || [])[1] || 'friend';
  if (/BLANK/.test(source)) return toolUse('write_nudges', { options: [] });
  if (/INJECT/.test(source)) {
    const many = [];
    for (let i = 0; i < 20; i++) many.push({ text: `Message number ${i} for you`, tone });
    return toolUse('write_nudges', {
      options: [
        { text: `<img src=x onerror=alert(1)>Hi ${who}‮, my drill?${'A'.repeat(5000)}`, tone: '<script>' },
        { text: '   ', tone },
        { text: { evil: true }, tone },
        { text: '"><svg onload=alert(1)>', tone },
        { text: 'Hi there, can I have it back?', tone: 'menacing' },
        { text: 'hi THERE,   can I have it back?', tone },
        ...many,
      ],
    });
  }
  if (/MAXTOKENS/.test(source)) return toolUse('write_nudges', { options: [{ text: 'Hi', tone }] }, { stop_reason: 'max_tokens' });
  const birthday = /birthday/i.test(source);
  return toolUse('write_nudges', {
    options: [
      { text: `Hey ${who}! ${birthday ? 'Before your birthday chaos starts - ' : ''}could I grab it back this week? 😊`, tone },
      { text: `${who}, it misses me. ${birthday ? 'Consider returning it your birthday gift to me. ' : ''}Drop it round when you can?`, tone },
      { text: `Hi ${who} - no rush, but I'll need it back soon.${birthday ? ' Happy early birthday!' : ''}`, tone },
    ],
  });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        await new Promise((r) => setTimeout(r, Number(process.env.BOOMERANG_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const source = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = source.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'write_nudges') return write(source);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
