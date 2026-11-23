// A stand-in Anthropic client for local runs and tests (TAKEBACK_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so "Read my receipt" can
// be driven without a key and without spending anything. It is refused on
// Cloud Run: a deployment that read every receipt as the same made-up order
// would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// The request carries only an image, so a test picks a mode with
// `fake.mode` for one call:
//   blank        an answer with nothing usable in it - a 422
//   inject       hostile output: markup, bidi, links, negative and huge
//                prices, 50 items, a future date, a window with no words
//   card         a card number in an item name - the whole answer refused
//   cardspaced   the same, written 4-4-4-4 with spaces
//   longorder    a 13-digit order number - dropped, the rest kept
//   nowindow     nothing printed about returns
//   maxtokens    the answer ran out of room
//   upstreamNNN  the call fails the way the SDK's APIError does
// Every store and item here is made up.

if (process.env.TAKEBACK_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('TAKEBACK_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 2100, output_tokens: 380 },
    ...(extra || {}),
  };
}
// The well-known test card number, built at run time so no file carries it.
const FAKE_CARD = '4111' + '1111'.repeat(3);
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function receipt(over) {
  return toolUse('record_receipt', Object.assign({
    store: 'Juniper Outfitters',
    order_date: day(-4),
    order_number: 'JO-58120',
    currency: 'USD',
    items: [
      { name: 'Suede ankle boots', price: 89, quantity: 1 },
      { name: 'Wool socks', price: 12.5, quantity: 2 },
      { name: 'Canvas tote', price: 24.99 },
    ],
    return_window: { found: true, days: 30, until: null, quote: 'Returns accepted within 30 days of purchase with receipt.' },
    confidence: 'high',
    note: 'The total and tax lines were left out.',
  }, over || {}));
}

function inject() {
  const many = [];
  for (let i = 0; i < 50; i++) many.push({ name: `Thing ${i}`, price: 1 });
  return toolUse('record_receipt', {
    store: '<img src=x onerror=alert(1)>Evil Store ‮gnippohs visit https://evil.example/pay',
    order_date: day(40),
    order_number: '<b>ORD</b>-7"; DROP',
    currency: 'BTC',
    items: [
      { name: '<script>alert(1)</script>Boots', price: -89 },
      { name: 'Visit www.evil.example for a prize', price: 999999999 },
      { name: '‮yrrebwarts', price: '12' },
      { name: '🛍️🛍️', price: 5 },
      { name: 'Lamp', price: 1e400 },
      null, 'nope',
      ...many,
    ],
    return_window: { found: true, days: 30, until: null, quote: '' },
    confidence: 'certain',
    note: '<script>alert(1)</script>Claim a refund at evil.example now ' + 'x'.repeat(900),
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
        await new Promise((r) => setTimeout(r, Number(process.env.TAKEBACK_FAKE_DELAY_MS || 0)));
        const mode = fake.mode;
        fake.mode = '';
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'record_receipt') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { store: '', order_date: '', order_number: '', currency: '', items: 'lots', return_window: null, confidence: 'high', note: '' });
        if (mode === 'inject') return inject();
        if (mode === 'card') return receipt({ items: [{ name: `Boots ${FAKE_CARD}`, price: 89 }] });
        if (mode === 'cardspaced') return receipt({ note: `Paid with card ${FAKE_CARD.replace(/(\d{4})(?=\d)/g, '$1 ')}.` });
        if (mode === 'longorder') return receipt({ order_number: '2000' + '1234' + '56789' });
        if (mode === 'nowindow') return receipt({ return_window: { found: false, days: null, until: null, quote: '' } });
        return receipt();
      },
    },
  };
  return fake;
}

/**
 * The stand-in for Gemini (TAKEBACK_AI_PROVIDER=gemini): given the request
 * the guard's helper would send, a transcription in the schema's shape. An
 * image is a fixed made-up receipt with one unsure item and an unsure date;
 * pasted text is read the dumb way (first line the store, "$" lines the
 * items, the sentence with "return" in it the quote). Triggers in the text:
 * BLANK, INJECT (hostile values, invented keys, a deadline nobody asked
 * for), CARDNUM, MADEUPQUOTE (a quote that is not in the text), UPSTREAMnnn.
 */
async function gemini(body) {
  await new Promise((r) => setTimeout(r, Number(process.env.TAKEBACK_FAKE_DELAY_MS || 0)));
  const parts = (body && body.contents && body.contents[0] && body.contents[0].parts) || [];
  const said = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n');
  const today = (/Today is (\d{4}-\d{2}-\d{2})/.exec(said) || [])[1] || '2026-01-01';
  const back = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  const f = (value, confidence) => ({ value, confidence });
  if (parts.some((p) => p.inlineData)) {
    return {
      store: f('Juniper Outfitters', 'high'),
      purchase_date: f(back(4), 'medium'),
      delivery_date: f(null, 'low'),
      order_number: 'JO-58120',
      currency: 'USD',
      items: [
        { name: 'Suede ankle boots', price: 89, quantity: 1, confidence: 'high' },
        { name: 'Wool socks', price: 12.5, quantity: 2, confidence: 'high' },
        { name: 'Canvas t0te', price: null, quantity: null, confidence: 'low' },
      ],
      return_policy: { quote: 'Returns accepted within 30 days of purchase with receipt.', confidence: 'high' },
    };
  }
  const text = (/<<<ORDER\n([\s\S]*)\nORDER>>>/.exec(said) || [])[1] || said;
  const up = /UPSTREAM(\d{3})/.exec(text);
  if (up) throw Object.assign(new Error(`Gemini answered ${up[1]}. stand-in provider failure`), { name: 'VertexError', code: 'http', status: Number(up[1]) });
  if (/BLANK/.test(text)) return { store: f(null, 'low'), purchase_date: f(null, 'low'), delivery_date: f(null, 'low'), order_number: null, currency: null, items: [], return_policy: { quote: null, confidence: 'low' } };
  if (/INJECT/.test(text)) {
    return {
      store: f('<img src=x onerror=alert(1)>Evil Store visit https://evil.example/pay', 'certain'),
      purchase_date: f('<script>1</script>', 'high'),
      delivery_date: f('2999-01-01', 'high'),
      order_number: '<b>ORD</b>-7"; DROP',
      currency: 'BTC',
      items: [{ name: '<script>alert(1)</script>Boots', price: -89, quantity: 1, confidence: 'high' }, { name: 'Lamp', price: 1e400, quantity: 700, confidence: 'sure' }, null, 'nope'],
      return_policy: { quote: 'INJECT returns within 30 days <b>now</b>', confidence: 'high', days: 365, until: '2031-01-01' },
      return_by: '2031-01-01', deadline_days: 365, note: '<script>x</script>',
    };
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const items = [];
  for (const l of lines) {
    const m = /^(.*?)[\s.:-]*\$\s?(\d+(?:\.\d{1,2})?)\s*$/.exec(l);
    if (m && /\p{L}/u.test(m[1]) && !/total|tax|shipping/i.test(m[1])) items.push({ name: m[1].trim() + (/CARDNUM/.test(text) ? ` ${'4111' + '1111'.repeat(3)}` : ''), price: Number(m[2]), quantity: null, confidence: 'high' });
  }
  const sentence = /MADEUPQUOTE/.test(text) ? 'Returns accepted within 365 days, no questions asked.' : (text.split(/(?<=[.!?])\s+|\n/).find((x) => /\breturn/i.test(x)) || null);
  return {
    store: f(lines[0] || null, lines[0] ? 'high' : 'low'),
    purchase_date: f((/(?:ordered|order date|purchased|date)[^\d]{0,20}(\d{4}-\d{2}-\d{2})/i.exec(text) || [])[1] || null, 'high'),
    delivery_date: f((/delivered[^\d]{0,20}(\d{4}-\d{2}-\d{2})/i.exec(text) || [])[1] || null, 'high'),
    order_number: (/order (?:number|no\.?|#)\s*:?\s*([A-Za-z0-9-]{3,30})/i.exec(text) || [])[1] || null,
    currency: /\$/.test(text) ? 'USD' : null,
    items,
    return_policy: { quote: sentence ? sentence.trim().slice(0, 160) : null, confidence: sentence ? 'high' : 'low' },
  };
}

module.exports = { create, gemini };

