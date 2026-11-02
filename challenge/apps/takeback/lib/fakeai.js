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

module.exports = { create };
