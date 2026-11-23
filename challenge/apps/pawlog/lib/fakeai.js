// A stand-in Anthropic client for local runs and tests (PAWLOG_FAKE_AI=1).
//
// It answers the forced tool deterministically, so "Read the vet paperwork"
// can be driven without a key and without spending anything. It is refused
// on Cloud Run: a deployment that read the same rabies booster off every
// photo would look like it works and be useless.
//
// It keeps everything it was sent in `seen` (images as a marker, not their
// bytes), so a test can prove what the model was (and was not) told.
// Triggers, in the pasted text:
//   BLANK        nothing usable - a 422
//   INJECT       hostile output: markup, bidi, an address, an account
//                number, a phone, an email, a price, bad dates, duplicates,
//                too many rows, unknown keys
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does

if (process.env.PAWLOG_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('PAWLOG_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 900, output_tokens: 260 },
    ...(extra || {}),
  };
}

function shift(today, days) {
  const d = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000);
  return d.toISOString().slice(0, 10);
}

function answer(text) {
  const today = (/Today is (\d{4}-\d{2}-\d{2})/.exec(text) || [])[1] || '2026-10-24';
  if (/BLANK/.test(text)) return toolUse('record_paperwork', { vaccinations: [], medicines: [], weight: null, nextVisit: null });
  if (/MAXTOKENS/.test(text)) return toolUse('record_paperwork', { vaccinations: [] }, { stop_reason: 'max_tokens' });
  if (/INJECT/.test(text)) {
    const bad = { name: '<img src=x onerror=alert(1)>Rabies‮ 12 Elm Street, Springfield', kind: 'evil', given: shift(today, -2), due: shift(today, 365), owner: 'Jane Doe' };
    return toolUse('record_paperwork', {
      vaccinations: [bad, bad, { name: 'Lepto Acct # 99887766', kind: 'vaccine', given: 'yesterday', due: '2099-01-01' },
        { name: 'Call 555-010-9988 or jo@example.com', kind: 'vaccine', given: shift(today, -1), due: '' },
        ...Array.from({ length: 20 }, (_, i) => ({ name: `Booster ${String.fromCharCode(65 + i)}`, kind: 'vaccine', given: shift(today, -i), due: '' }))],
      medicines: [{ name: '<script>x</script>Apoquel', dose: '16mg $45.00', schedule: 'twice daily', until: shift(today, 9), price: 45 },
        { name: 'Invoice No 4455667788', dose: '', schedule: '', until: '' }],
      weight: { value: 9999, unit: 'kg' },
      nextVisit: { what: 'Recheck at 1 Main Road, SW1A 1AA', day: shift(today, 14) },
      link: 'https://evil.example',
    });
  }
  return toolUse('record_paperwork', {
    vaccinations: [
      { name: 'Rabies booster', kind: 'vaccine', given: shift(today, -1), due: shift(today, 364) },
      { name: 'DHPP', kind: 'vaccine', given: shift(today, -1), due: shift(today, 364) },
      { name: 'Flea & tick tablet', kind: 'flea', given: shift(today, -1), due: shift(today, 29) },
    ],
    medicines: [{ name: 'Ear drops', dose: '4 drops in the left ear', schedule: 'twice daily', until: shift(today, 9) }],
    weight: { value: 11.4, unit: 'kg' },
    nextVisit: { what: 'Recheck ears', day: shift(today, 14) },
  });
}

function create() {
  const calls = [];
  const seen = [];
  return {
    calls,
    seen,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        seen.push(JSON.stringify({ system: params.system, messages: [{ content: content.map((b) => (b.type === 'image' ? { type: 'image', bytes: b.source.data.length } : b)) }] }));
        await new Promise((r) => setTimeout(r, Number(process.env.PAWLOG_FAKE_DELAY_MS || 0)));
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = text.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name !== 'record_paperwork') throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
        return answer(text);
      },
    },
  };
}

/**
 * The stand-in for Gemini (PAWLOG_AI_PROVIDER=gemini): given the request the
 * guard's helper would send, an answer in the schema's shape. A photo is a
 * fixed made-up discharge sheet: one medicine printed clearly, one with
 * gaps (so the review has something to ask about), a booster, a weight and
 * a recheck. Every name is generic and invented - no real product. Triggers
 * in pasted text: BLANK, INJECT (hostile values, invented keys, doses that
 * would need mending), UPSTREAMnnn.
 */
const R = (text, confidence) => ({ text, confidence });
async function gemini(body) {
  await new Promise((r) => setTimeout(r, Number(process.env.PAWLOG_FAKE_DELAY_MS || 0)));
  const parts = (body && body.contents && body.contents[0] && body.contents[0].parts) || [];
  const source = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n');
  const today = (/Today is (\d{4}-\d{2}-\d{2})/.exec(source) || [])[1] || '2026-10-24';
  const text = (/<<<PAPER\n([\s\S]*)\nPAPER>>>/.exec(source) || [])[1] || '';
  const hit = text.match(/UPSTREAM(\d{3})/);
  if (hit) throw Object.assign(new Error(`Gemini answered ${hit[1]}. stand-in provider failure`), { name: 'VertexError', code: 'http', status: Number(hit[1]) });
  if (/BLANK/.test(text)) return { medicines: [], vaccinations: [], weight: null, nextVisit: null };
  if (/INJECT/.test(text)) {
    return {
      medicines: [
        { name: R('<script>x</script>Itch tablets', 'high'), strength: R('16 mg $45.00', 'high'), amount: R('1 tablet - call 555-010-9988 with questions', 'high'), frequency: R('twice daily', 'certain'), days: { value: 10.5, confidence: 'high' }, food: { value: 'always', confidence: 'high' }, startDate: R('yesterday', 'high'), suggestedDose: '2 tablets', times: ['08:00'] },
        { name: R('Invoice No 4455667788', 'high'), strength: R(null, 'low'), amount: R(null, 'low'), frequency: R(null, 'low'), days: { value: null, confidence: 'low' }, food: { value: 'not_stated', confidence: 'low' }, startDate: R(null, 'low') },
        { name: R('Calm chews', 'high'), strength: R('x'.repeat(80), 'high'), amount: R('1 chew‮', 'high'), frequency: R('once daily', 'high'), days: { value: 9999, confidence: 'high' }, food: { value: 'with_food', confidence: 'high' }, startDate: R('2099-01-01', 'high') },
        ...Array.from({ length: 14 }, (_, i) => ({ name: R(`Drops ${String.fromCharCode(65 + i)}`, 'high'), strength: R(null, 'low'), amount: R('2 drops', 'high'), frequency: R('once daily', 'high'), days: { value: 5, confidence: 'high' }, food: { value: 'not_stated', confidence: 'high' }, startDate: R(null, 'low') })),
      ],
      vaccinations: [{ name: 'Lepto Acct # 99887766 <b>x</b>', kind: 'evil', given: shift(today, -1), due: '2099-01-01', owner: 'Jane Doe' }],
      weight: { value: 9999, unit: 'kg' },
      nextVisit: { what: 'Recheck at 1 Main Road, SW1A 1AA', day: shift(today, 14) },
      link: 'https://evil.example',
    };
  }
  return {
    medicines: [
      { name: R('Pain relief tablets', 'high'), strength: R('25 mg', 'high'), amount: R('1 tablet', 'high'), frequency: R('twice daily', 'high'), days: { value: 7, confidence: 'high' }, food: { value: 'with_food', confidence: 'high' }, startDate: R(today, 'high') },
      { name: R('Ear drops', 'high'), strength: R(null, 'low'), amount: R('4 drops in the left ear', 'medium'), frequency: R('every 12 hours', 'high'), days: { value: null, confidence: 'low' }, food: { value: 'not_stated', confidence: 'medium' }, startDate: R(null, 'low') },
    ],
    vaccinations: [{ name: 'Rabies booster', kind: 'vaccine', given: shift(today, -1), due: shift(today, 364) }],
    weight: { value: 11.4, unit: 'kg' },
    nextVisit: { what: 'Recheck ears', day: shift(today, 14) },
  };
}

module.exports = { create, gemini };
