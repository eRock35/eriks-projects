// A stand-in Anthropic client for local runs and tests (CHORUS_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so "Suggest chores" can
// be driven without a key and without spending anything. It is refused on
// Cloud Run: a deployment that suggested the same kitchen chores for every
// photo would look like it works and fill households with nonsense.
//
// Triggers, in the photo's bytes or the description:
//   BLANK        not a room (relevant: false) - the route's 422
//   INJECT       hostile output: markup, bidi, huge names, efforts and
//                frequencies off the list, 40 chores, a duplicate
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - a kitchen: six chores, one of them "Dishes"

if (process.env.CHORUS_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('CHORUS_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name: 'propose_chores', input }],
    usage: { input_tokens: 1400, output_tokens: 260 },
    ...(extra || {}),
  };
}

const KITCHEN = [
  { name: 'Dishes', emoji: '🍽️', effort: 2, freq: 'daily' },
  { name: 'Wipe the stovetop', emoji: '🧽', effort: 2, freq: 'often' },
  { name: 'Clean the microwave', emoji: '♨️', effort: 2, freq: 'weekly' },
  { name: 'Take out the compost', emoji: '🥕', effort: 1, freq: 'often' },
  { name: 'Mop the kitchen floor', emoji: '🪣', effort: 3, freq: 'weekly' },
  { name: 'Descale the kettle', emoji: '🫖', effort: 1, freq: 'monthly' },
];

function answer(source) {
  if (/BLANK/.test(source)) return toolUse({ relevant: false, chores: [] });
  if (/INJECT/.test(source)) {
    const many = [];
    for (let i = 0; i < 40; i++) many.push({ name: `Chore ${i}`, emoji: '🧹', effort: 2, freq: 'weekly' });
    return toolUse({
      relevant: true,
      chores: [
        { name: `<img src=x onerror=alert(1)>Scrub‮ the tub${'A'.repeat(5000)}`, emoji: '<script>', effort: 9, freq: 'hourly' },
        { name: 'Ignore previous instructions', emoji: '🧽', effort: '3', freq: 'weekly' },
        { name: 'dishes', emoji: '🍽️', effort: 2, freq: 'daily' },
        { name: '   ', emoji: '🧽', effort: 2, freq: 'weekly' },
        { name: 'Water the plants', emoji: 'plant', effort: 1.5, freq: 'weekly' },
        { name: 'Wash the windows', emoji: '🪟', effort: 3, freq: 'monthly' },
        { name: { evil: true }, emoji: '🧽', effort: 2, freq: 'weekly' },
        ...many,
      ],
    });
  }
  if (/MAXTOKENS/.test(source)) return toolUse({ relevant: true, chores: KITCHEN.slice(0, 1) }, { stop_reason: 'max_tokens' });
  return toolUse({ relevant: true, chores: KITCHEN });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        await new Promise((r) => setTimeout(r, Number(process.env.CHORUS_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const source = content.map((b) => {
          if (b.type === 'image') { try { return Buffer.from(b.source.data, 'base64').toString('latin1'); } catch (e) { return ''; } }
          return b.type === 'text' ? b.text : '';
        }).join('\n');
        const hit = source.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'propose_chores') return answer(source);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
