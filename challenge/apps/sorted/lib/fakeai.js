// A stand-in Anthropic client for local runs and tests (SORTED_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so the price estimate
// can be driven without a key and without spending anything. It is refused
// on Cloud Run: a deployment that gave everyone the same canned answer would
// look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// A trigger word in the item's name, or `fake.mode` for one call:
//   BLANK        an answer with nothing usable in it - a 422
//   INJECT       hostile output: markup, bidi, links, high below low, an
//                unknown confidence, oversized, repeated and extra tips
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does

if (process.env.SORTED_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('SORTED_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1400, output_tokens: 260 },
    ...(extra || {}),
  };
}

// A rough, deterministic table: the first word that matches sets the range.
const TABLE = [
  [/dress|gown|coat|jacket|boots|handbag|bag/i, 25, 60, 'Clothes and bags in good condition sell steadily second-hand; a clear photo of any label helps.'],
  [/bike|guitar|camera|laptop|console|tablet|phone/i, 60, 160, 'Working electronics, bikes and instruments hold value - the model and condition matter most.'],
  [/chair|table|sofa|lamp|mirror/i, 15, 45, 'Furniture sells locally; buyers want measurements and pick-up details.'],
  [/lego|puzzle|game|toy|book/i, 5, 20, 'Toys, games and books sell best in bundles, complete with all their pieces.'],
];

function estimate(text, hasImage) {
  const name = ((/<<<ITEM\n([\s\S]*?)\nITEM>>>/.exec(text) || [])[1] || '').trim();
  const row = TABLE.find((r) => r[0].test(name)) || [null, 3, 12, 'Everyday things like this usually sell for a few pounds or dollars - or go faster as part of a bundle.'];
  const [, low, high, reason] = row;
  return toolUse('estimate_price', {
    low, high,
    confidence: hasImage ? 'medium' : 'low',
    reason,
    title: `${name.slice(0, 50)} - good condition`,
    tips: ['Photograph it in daylight against a plain background.', 'Mention any flaws up front so nobody haggles at the door.', 'Check what similar things actually sold for, not what they are listed at.'],
  });
}

function inject() {
  return toolUse('estimate_price', {
    low: 90, high: 25, confidence: 'certain',
    reason: '<img src=x onerror=alert(1)>Worth a fortune‮ - see https://evil.example/pay or www.evil.example now ' + 'x'.repeat(900),
    title: '<script>alert(1)</script>Designer original! visit evil.example',
    tips: ['<b>Click</b> javascript:alert(1)', 'List it at evil.example', 'List it at evil.example', 'Tip four', 'Tip five', 'y'.repeat(800)],
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
        await new Promise((r) => setTimeout(r, Number(process.env.SORTED_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hasImage = content.some((b) => b.type === 'image');
        const mode = fake.mode || ((/\b(BLANK|INJECT|MAXTOKENS|UPSTREAM\d{3})\b/.exec(text) || [])[1] || '').toLowerCase();
        fake.mode = '';
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'estimate_price') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { low: 'lots', high: null, reason: '', title: '', tips: [] });
        if (mode === 'inject') return inject();
        return estimate(text, hasImage);
      },
    },
  };
  return fake;
}

module.exports = { create };
