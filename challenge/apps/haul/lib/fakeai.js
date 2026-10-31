// A stand-in Anthropic client for local runs and tests (HAUL_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so "Count it from a
// photo" can be driven without a key and without spending anything. It is
// refused on Cloud Run: a deployment that gave everyone the same canned count
// would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// The request carries only a photo, so a test picks a mode with `fake.mode`
// for one call:
//   blank        an answer with nothing usable in it - a 422
//   inject       hostile output: unknown ids, markup, bidi, links, huge and
//                negative counts, too many others, an unknown confidence
//   maxtokens    the answer ran out of room
//   upstreamNNN  the call fails the way the SDK's APIError does

if (process.env.HAUL_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('HAUL_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1900, output_tokens: 320 },
    ...(extra || {}),
  };
}

function count() {
  return toolUse('record_counts', {
    counts: [
      { id: 'pbcups', count: 6 }, { id: 'chocbar', count: 9 }, { id: 'wafer', count: 4 }, { id: 'skittles', count: 3 },
      { id: 'lollipop', count: 5 }, { id: 'candycorn', count: 12 }, { id: 'gummybears', count: 2 }, { id: 'fullbar', count: 1 },
    ],
    others: [{ name: 'Candy necklace', category: 'hard', count: 2 }],
    confidence: 'medium',
    note: 'A few pieces overlap near the middle, so one or two may be hiding.',
  });
}

function inject() {
  const many = [];
  for (let i = 0; i < 30; i++) many.push({ name: `Thing ${i}`, category: 'hard', count: 1 });
  return toolUse('record_counts', {
    counts: [
      { id: 'evil', count: 50 }, { id: '__proto__', count: 5 }, { id: 'pbcups', count: -4 }, { id: 'chocbar', count: 99999 },
      { id: 'lollipop', count: '7' }, { id: 'lollipop', count: 3 }, { id: 'skittles', count: 2.5 }, { id: 'twix', count: 300 }, 'nope', null,
    ],
    others: [
      { name: '<img src=x onerror=alert(1)>Free candy', category: 'hard', count: 3 },
      { name: '\u202eyrrebwarts visit evil.example', category: 'gummy', count: 2 },
      { name: 'https://evil.example/pay', category: 'choc', count: 2 },
      { name: 'Other: Snickers', category: 'choc', count: 2 },
      { name: '🍬🍬🍬', category: 'hard', count: 1 },
      { name: 'Mystery chew', category: 'poison', count: 4 },
      ...many,
    ],
    confidence: 'certain',
    note: '<script>alert(1)</script>Counted! Claim a prize at www.evil.example now ' + 'x'.repeat(900),
    extra: 'not asked for',
  });
}

function create() {
  const calls = [];
  const fake = {
    calls,
    mode: '',
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params);
        await new Promise((r) => setTimeout(r, Number(process.env.HAUL_FAKE_DELAY_MS || 0)));
        const mode = fake.mode;
        fake.mode = '';
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'record_counts') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { counts: 'lots', others: null, confidence: 'high', note: '' });
        if (mode === 'inject') return inject();
        return count();
      },
    },
  };
  return fake;
}

module.exports = { create };
