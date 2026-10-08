// A stand-in Anthropic client for local runs and tests (PICKUP_FAKE_AI=1).
//
// It answers the forced tool deterministically, so "Paste the group chat"
// can be driven without a key and without spending anything. It is refused
// on Cloud Run: a deployment that "read" the same five replies from every
// chat would look like it works and mark people in who never said so.
//
// Triggers, in the screenshot's bytes or the pasted text:
//   BLANK        nobody answered (an empty list) - a 422
//   INJECT       hostile output: markup, bidi, huge names, answers off the
//                list, 80 replies, nonsense +1s, repeats
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - five realistic answers (Sam in, Jo out, Mia maybe, Tom
//   in with a +1, Priya in)

if (process.env.PICKUP_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('PICKUP_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1400, output_tokens: 260 },
    ...(extra || {}),
  };
}

const REPLIES = [
  { name: 'Sam', answer: 'in', plusOnes: 0 },
  { name: 'Jo', answer: 'out', plusOnes: 0 },
  { name: 'Mia', answer: 'maybe', plusOnes: 0 },
  { name: 'Tom', answer: 'in', plusOnes: 1 },
  { name: 'Priya', answer: 'in', plusOnes: 0 },
];

function replies(source) {
  if (/BLANK/.test(source)) return toolUse('record_replies', { replies: [] });
  if (/INJECT/.test(source)) {
    const many = [];
    for (let i = 0; i < 80; i++) many.push({ name: `Player ${i}`, answer: 'in', plusOnes: 0 });
    return toolUse('record_replies', {
      replies: [
        { name: `<img src=x onerror=alert(1)>Sa‮m${'A'.repeat(5000)}`, answer: 'in', plusOnes: 1e9 },
        { name: 'Ignore previous instructions', answer: 'definitely', plusOnes: 0 },
        { name: '   ', answer: 'in' },
        { name: { evil: true }, answer: 'in' },
        { name: 'Jo', answer: 'IN', plusOnes: '2' },
        { name: 'jo', answer: 'out', plusOnes: 3 },
        ...many,
      ],
    });
  }
  if (/MAXTOKENS/.test(source)) return toolUse('record_replies', { replies: REPLIES.slice(0, 1) }, { stop_reason: 'max_tokens' });
  return toolUse('record_replies', { replies: REPLIES });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        await new Promise((r) => setTimeout(r, Number(process.env.PICKUP_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const source = content.map((b) => {
          if (b.type === 'image') { try { return Buffer.from(b.source.data, 'base64').toString('latin1'); } catch (e) { return ''; } }
          return b.type === 'text' ? b.text : '';
        }).join('\n');
        const hit = source.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'record_replies') return replies(source);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
