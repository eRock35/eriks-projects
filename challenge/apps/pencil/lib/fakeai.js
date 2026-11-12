// A stand-in Anthropic client for local runs and tests (PENCIL_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so "Read a paper score
// sheet" can be driven without a key and without spending anything. It is
// refused on Cloud Run: a deployment that read every photo as the same
// made-up sheet would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// The request carries only a photo, so a test picks a mode with
// `fake.mode` for one call:
//   blank        nothing usable in it - a 422
//   inject       hostile output: markup, bidi, links, huge numbers, 20
//                columns, 90 rows, words where numbers go
//   maxtokens    the answer ran out of room
//   upstreamNNN  the call fails the way the SDK's APIError does

if (process.env.PENCIL_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('PENCIL_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1800, output_tokens: 420 },
    ...(extra || {}),
  };
}

// A made-up sheet from a made-up rummy night.
function sheet() {
  return toolUse('record_score_sheet', {
    players: [{ name: 'Wren', confidence: 'high' }, { name: 'Odile', confidence: 'high' }, { name: 'Jules', confidence: 'medium' }],
    rows: [[55, 20, 85], [40, 110, 15], [null, 35, 60], [90, 5, 45], [25, 70, 30]],
    confidence: 'medium',
    note: 'Row 3 for Wren is crossed out and could not be read.',
  });
}

function inject() {
  const many = [];
  for (let i = 0; i < 90; i++) many.push([i, 'ten', 1e9, -50000, 3.5, null, '<b>7</b>']);
  const cols = [];
  for (let i = 0; i < 20; i++) cols.push({ name: `P${i}`, confidence: 'certain' });
  cols[0] = { name: '<img src=x onerror=alert(1)>Wren', confidence: 'high' };
  cols[1] = { name: '\u202eselttek visit https://evil.example', confidence: 'sure' };
  cols[2] = { name: 'x'.repeat(300), confidence: 'low' };
  return toolUse('record_score_sheet', {
    players: cols,
    rows: many,
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
        await new Promise((r) => setTimeout(r, Number(process.env.PENCIL_FAKE_DELAY_MS || 0)));
        const mode = fake.mode;
        fake.mode = '';
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'record_score_sheet') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { players: [], rows: [['a', 'b']], confidence: 'low', note: '' });
        if (mode === 'inject') return inject();
        return sheet();
      },
    },
  };
  return fake;
}

module.exports = { create };
