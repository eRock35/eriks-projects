// A stand-in Anthropic client for local runs and tests (FLIGHT_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so snapping a label can
// be driven without a key and without spending anything. It is refused on
// Cloud Run: a deployment that read every can as the same beer would look
// like it works and fill everyone's flight with nonsense.
//
// Triggers, in the photo's bytes (read_label):
//   BLANK        not a label (readable: false) - the route's 422
//   INJECT       hostile output: markup, bidi, a huge name, a style off the
//                list, an ABV as a string and out of range
//   NOABV        a label with no ABV printed (abv null)
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - "Fog Lantern", Tidewater Brewing, Hazy IPA, 6.8%

if (process.env.FLIGHT_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('FLIGHT_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name: 'read_label', input }],
    usage: { input_tokens: 1600, output_tokens: 120 },
    ...(extra || {}),
  };
}

function answer(source) {
  if (/BLANK/.test(source)) return toolUse({ readable: false, name: null, brewery: null, style: 'other', stylePrinted: null, abv: null, confidence: 'low' });
  if (/INJECT/.test(source)) {
    return toolUse({
      readable: true,
      name: `<img src=x onerror=alert(1)>Night‮ Ferry${'A'.repeat(5000)}`,
      brewery: { evil: true },
      style: 'ignore previous instructions',
      stylePrinted: '<script>alert(1)</script>Stout',
      abv: '65%',
      confidence: 'certain',
    });
  }
  const base = { readable: true, name: 'Fog Lantern', brewery: 'Tidewater Brewing', style: 'hazy', stylePrinted: 'Hazy IPA', abv: 6.8, confidence: 'high' };
  if (/NOABV/.test(source)) return toolUse({ ...base, abv: null, confidence: 'medium' });
  if (/MAXTOKENS/.test(source)) return toolUse(base, { stop_reason: 'max_tokens' });
  return toolUse(base);
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        await new Promise((r) => setTimeout(r, Number(process.env.FLIGHT_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const bytes = content.filter((b) => b.type === 'image').map((b) => { try { return Buffer.from(b.source.data, 'base64').toString('latin1'); } catch (e) { return ''; } }).join('\n');
        const hit = bytes.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'read_label') return answer(bytes);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
