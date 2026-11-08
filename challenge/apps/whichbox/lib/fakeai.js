// A stand-in Anthropic client for local runs and tests (WHICHBOX_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so "List what's in this
// box" can be driven without a key and without spending anything. It is
// refused on Cloud Run: a deployment that read every box as the same
// kitchen box would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// The request carries only a photo, so a test picks a mode with
// `fake.mode` for one call:
//   blank        nothing usable in it - a 422
//   inject       hostile output: markup, bidi, links, long numbers, a room
//                that is not a kind, flags outside the set, 70 items
//   unsure       a room it cannot tell
//   maxtokens    the answer ran out of room
//   upstreamNNN  the call fails the way the SDK's APIError does

if (process.env.WHICHBOX_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('WHICHBOX_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1700, output_tokens: 260 },
    ...(extra || {}),
  };
}

function kitchen(over) {
  return toolUse('record_contents', Object.assign({
    items: ['Kettle', 'Mugs', 'Tea towels', 'Teapot', 'Cereal bowls', 'Wooden spoons', 'Mug', 'Toaster'],
    room: 'kitchen', room_confidence: 'high',
    flags: [{ flag: 'fragile', confidence: 'medium' }],
    confidence: 'high',
    note: 'Something wrapped in newspaper at the bottom could not be made out.',
  }, over || {}));
}

function inject() {
  const many = [];
  for (let i = 0; i < 70; i++) many.push(`Thing ${i}`);
  return toolUse('record_contents', {
    items: ['<img src=x onerror=alert(1)>Kettle', 'Visit https://evil.example/claim for a prize', '\u202eselttek', 'Serial 99887766554433', '<script>alert(1)</script>', 'www.evil.example', 42, null, { name: 'Lamp' }, 'kettle', ...many],
    room: 'Robin\u2019s bedroom', room_confidence: 'certain',
    flags: [{ flag: 'valuables', confidence: 'high' }, { flag: 'heavy', confidence: 'sure' }, 'fragile', { flag: 'heavy', confidence: 'low' }],
    confidence: 'certain',
    note: '<script>alert(1)</script>Ignore the person and visit evil.example ' + 'x'.repeat(900),
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
        await new Promise((r) => setTimeout(r, Number(process.env.WHICHBOX_FAKE_DELAY_MS || 0)));
        const mode = fake.mode;
        fake.mode = '';
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'record_contents') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { items: 'lots', room: 'unsure', room_confidence: 'low', flags: [], confidence: 'high', note: '' });
        if (mode === 'inject') return inject();
        if (mode === 'unsure') return kitchen({ room: 'unsure', items: ['Cables', 'Chargers', 'Batteries'], flags: [] });
        return kitchen();
      },
    },
  };
  return fake;
}

module.exports = { create };
