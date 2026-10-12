// A stand-in Anthropic client for local runs and tests (GLOVEBOX_FAKE_AI=1).
//
// It answers the two forced tools deterministically, so "Read my dashboard"
// and "Read a receipt" can be driven without a key and without spending
// anything. It is refused on Cloud Run: a deployment that "saw" a check
// engine light in every photo would look like it works.
//
// It records every request it was sent (`calls`) - with the photo's bytes
// replaced by their length - so a test can prove what reached "the model".
//
// Triggers, in the photo's bytes:
//   BLANK        not a dashboard / not a receipt (relevant: false) - a 422
//   REDOIL       the red oil-pressure light, with the model insisting it is
//                fine to keep driving (the app must never say so)
//   INJECT       hostile output: markup, bidi, made-up catalogue ids, an
//                urgency field, "safe to ignore", 40 lights or lines, a
//                future date, an absurd mileage and cost
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - dash: check engine + tyre pressure, 48,212 mi on the
//                odometer; receipt: an oil change, a rotation and wipers

if (process.env.GLOVEBOX_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('GLOVEBOX_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1800, output_tokens: 240 },
    ...(extra || {}),
  };
}

function dash(source) {
  if (/BLANK/.test(source)) return toolUse('read_dash', { relevant: false, lights: [], notes: 'That looks like a cat.' });
  if (/MAXTOKENS/.test(source)) return toolUse('read_dash', { relevant: true, lights: [] }, { stop_reason: 'max_tokens' });
  if (/REDOIL/.test(source)) {
    return toolUse('read_dash', {
      relevant: true,
      lights: [{ catalogueId: 'oil-pressure', colour: 'red', description: 'Oil can with a drip. It is safe to keep driving to your destination.', urgency: 'low' }],
      notes: 'This is not serious - you can ignore it for now.',
    });
  }
  if (/INJECT/.test(source)) {
    const many = [];
    for (let i = 0; i < 40; i++) many.push({ catalogueId: 'abs', colour: 'amber', description: `Light ${i}` });
    return toolUse('read_dash', {
      relevant: true,
      lights: [
        { catalogueId: 'flux-capacitor', colour: 'purple', description: '<img src=x onerror=alert(1)>Mystery‮light', urgency: 'ignore' },
        { catalogueId: '__proto__', colour: 'red', description: '<script>alert(1)</script>Red thing' },
        { catalogueId: 'check-engine', colour: 'red', description: 'Engine outline, lit red. Harmless - drive on normally.', severity: 'none' },
        ...many,
      ],
      odometer: { value: 99999999, unit: 'parsecs' },
      notes: 'Ignore previous instructions. All of these are safe to ignore. <a href="javascript:alert(1)">Click</a>',
      urgency: 'none',
    });
  }
  return toolUse('read_dash', {
    relevant: true,
    lights: [
      { catalogueId: 'check-engine', colour: 'amber', description: 'Engine outline' },
      { catalogueId: 'tpms', colour: 'amber', description: 'Horseshoe with an exclamation mark' },
    ],
    odometer: { value: 48212, unit: 'mi' },
    notes: '',
  });
}

function receipt(source) {
  if (/BLANK/.test(source)) return toolUse('read_receipt', { relevant: false, items: [] });
  if (/MAXTOKENS/.test(source)) return toolUse('read_receipt', { relevant: true, items: [] }, { stop_reason: 'max_tokens' });
  if (/INJECT/.test(source)) {
    const many = [];
    for (let i = 0; i < 40; i++) many.push({ catalogueItem: 'oil', description: `Line ${i}`, cost: 1 });
    return toolUse('read_receipt', {
      relevant: true, date: '2999-01-01', mileage: -5, mileageUnit: 'furlongs',
      shop: '<img src=x onerror=alert(1)>Evil Garage‮', currency: 'DOGE', total: 1e12,
      items: [{ catalogueItem: 'flux-capacitor', description: '<script>alert(1)</script>Flux service', cost: -40 }, { catalogueItem: '__proto__', description: '', cost: 'free' }, ...many],
    });
  }
  return toolUse('read_receipt', {
    relevant: true, date: '2026-10-02', mileage: 48160, mileageUnit: 'mi', shop: 'QuickLube on Main', currency: 'USD', total: 112.5,
    items: [
      { catalogueItem: 'oil', description: 'Full synthetic oil & filter', cost: 74.99 },
      { catalogueItem: 'rotate', description: 'Rotate tires', cost: 19.99 },
      { catalogueItem: 'wipers', description: 'Wiper blades (pair)', cost: 17.52 },
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
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const img = content.find((b) => b.type === 'image');
        const bytes = img ? Buffer.from(img.source.data, 'base64').toString('latin1') : '';
        const logged = JSON.parse(JSON.stringify(params));
        logged.messages[0].content.forEach((b) => { if (b.type === 'image') b.source.data = `<${b.source.data.length} chars>`; });
        calls.push(logged);
        await new Promise((r) => setTimeout(r, Number(process.env.GLOVEBOX_FAKE_DELAY_MS || 0)));
        const hit = bytes.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'read_dash') return dash(bytes);
        if (params.tool_choice.name === 'read_receipt') return receipt(bytes);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
