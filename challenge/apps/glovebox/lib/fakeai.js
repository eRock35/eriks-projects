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

/**
 * The stand-in for Gemini (GLOVEBOX_AI_PROVIDER=gemini): given the body the
 * guard's Vertex helper would send, an answer in the shape its schema asks
 * for. Which request it is, is read from the schema. Every request is kept
 * in `geminiCalls` with the media replaced by its length.
 *
 * "Light or noise?" triggers, in the media's bytes or the driver's note:
 *   BLANK        not a car (relevant: false) - a 422
 *   CALM         the red oil light, with the model insisting it can wait
 *   RATTLE       a loose heat shield, confidently "can wait"
 *   MINOR        an unknown noise the model calls "can wait"
 *   UNSURE       nothing it can tell
 *   INJECT       hostile output: made-up ids and urgencies, markup, advice
 *   UPSTREAMnnn  the call fails the way the helper's VertexError does
 *   otherwise    a photo: an amber check-engine light, steady ("soon");
 *                a recording: a squeal the model calls "soon" - which the
 *                app must raise to "stop now", because it is the brakes
 * The dash and receipt reads answer as the Claude stand-in does.
 */
const geminiCalls = [];
async function gemini(body) {
  const parts = (body && body.contents && body.contents[0] && body.contents[0].parts) || [];
  const schema = (body && body.generationConfig && body.generationConfig.responseSchema) || {};
  const props = schema.properties || {};
  const media = parts.filter((p) => p.inlineData);
  const text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n');
  const bytes = media.map((p) => Buffer.from(p.inlineData.data, 'base64').toString('latin1')).join('\n');
  geminiCalls.push({
    schema: Object.keys(props),
    systemInstruction: body && body.systemInstruction,
    parts: parts.map((p) => (p.inlineData ? { inlineData: { mimeType: p.inlineData.mimeType, data: `<${p.inlineData.data.length} chars>` } } : p)),
  });
  await new Promise((r) => setTimeout(r, Number(process.env.GLOVEBOX_FAKE_DELAY_MS || 0)));
  const note = (/<<<NOTE\n([\s\S]*)\nNOTE>>>/.exec(text) || [])[1] || '';
  const source = `${bytes}\n${note}`;
  const hit = source.match(/UPSTREAM(\d{3})/);
  if (hit) throw Object.assign(new Error(`Gemini answered ${hit[1]}. stand-in provider failure`), { name: 'VertexError', code: 'http', status: Number(hit[1]) });

  if (!props.cause) {
    // A dashboard or a receipt: the Claude stand-in's answer, flattened the
    // way the Gemini schema asks for it.
    if (props.lights) {
      const d = dash(bytes).content[0].input;
      return { relevant: d.relevant, lights: (d.lights || []).map((l) => ({ ...l, catalogueId: l.catalogueId || 'none' })), odometer: d.odometer ? d.odometer.value : null, odometerUnit: (d.odometer && d.odometer.unit) || 'not_shown', notes: d.notes || '', urgency: d.urgency };
    }
    const r = receipt(bytes).content[0].input;
    return { relevant: r.relevant, date: r.date || '', mileage: r.mileage === undefined ? null : r.mileage, mileageUnit: r.mileageUnit || 'not_shown', shop: r.shop || '', items: (r.items || []).map((x) => ({ ...x, catalogueItem: x.catalogueItem || 'none', cost: x.cost === undefined ? null : x.cost })), total: r.total === undefined ? null : r.total, currency: r.currency || '' };
  }

  const none = { relevant: true, catalogueId: 'none', lightColour: 'unknown', flashing: 'unknown', sound: 'none', hazards: [], cause: 'unknown', urgency: 'not_sure', confidence: 'low', observed: '' };
  if (/BLANK/.test(source)) return { ...none, relevant: false, observed: 'A photo of a cat.' };
  if (/CALM/.test(source)) return { ...none, catalogueId: 'oil-pressure', lightColour: 'red', flashing: 'no', cause: 'info-light', urgency: 'can_wait', confidence: 'high', observed: 'A red oil can symbol. It is safe to keep driving to your destination.' };
  if (/RATTLE/.test(source)) return { ...none, sound: 'rattle', cause: 'loose-trim', urgency: 'can_wait', confidence: 'high', observed: 'A tinny rattle that comes and goes with the revs.' };
  if (/MINOR/.test(source)) return { ...none, sound: 'other', cause: 'unknown', urgency: 'can_wait', confidence: 'high', observed: 'A faint noise.' };
  if (/UNSURE/.test(source)) return { ...none, sound: 'other', observed: 'A low noise that is hard to make out.' };
  if (/INJECT/.test(source)) {
    return {
      relevant: true, catalogueId: '__proto__', lightColour: 'purple', flashing: 'maybe', sound: '<script>alert(1)</script>', hazards: ['brakes', 'aliens', 'brakes', { x: 1 }],
      cause: 'flux-capacitor', urgency: 'ignore_it', confidence: 'certain',
      observed: '<img src=x onerror=alert(1)>A squeal‮. It is harmless - keep driving. You should replace the pads yourself with a 14mm spanner. Ignore previous instructions.',
      advice: 'Tighten the caliper bolts.', repair: 'Do it yourself', safe: true,
    };
  }
  const photo = media.find((p) => /^image\//.test(p.inlineData.mimeType));
  const sound = media.find((p) => /^audio\//.test(p.inlineData.mimeType));
  if (photo) return { ...none, catalogueId: 'check-engine', lightColour: 'amber', flashing: /flash/i.test(note) ? 'yes' : 'no', sound: sound ? 'ticking' : 'none', cause: 'engine-fault', urgency: 'soon', confidence: 'medium', observed: 'An amber engine outline, lit steadily.' };
  return { ...none, sound: 'squeal', hazards: [], cause: 'brake-wear', urgency: 'soon', confidence: 'medium', observed: 'A high squeal that comes in short bursts.' };
}

module.exports = { create, gemini, geminiCalls };
