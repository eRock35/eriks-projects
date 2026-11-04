// A stand-in Anthropic client for local runs and tests (AGAIN_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so "Read the menu" and
// "What should I order?" can be driven without a key and without spending
// anything. It is refused on Cloud Run: a deployment that read every menu as
// the same made-up trattoria would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// It gives picks only when the request carried the person's dishes. A test
// picks a mode with `fake.mode` for one call:
//   blank        an answer with nothing usable in it - a 422
//   inject       hostile output: markup, bidi, links, negative and huge
//                prices, 120 dishes, picks that are not on the menu
//   badpicks     picks naming dishes the answer never listed, and a fourth
//   maxtokens    the answer ran out of room
//   upstreamNNN  the call fails the way the SDK's APIError does
// Every dish here is made up.

if (process.env.AGAIN_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('AGAIN_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 2400, output_tokens: 520 },
    ...(extra || {}),
  };
}

const MENU = [
  { name: 'Burrata', description: 'Heirloom tomatoes, basil, olive oil', price: 16 },
  { name: 'Fried artichokes', description: 'Lemon, mint', price: 14 },
  { name: 'Cacio e pepe', description: 'Tonnarelli, pecorino romano, black pepper', price: 19 },
  { name: 'Bucatini all’amatriciana', description: 'Guanciale, tomato, chili', price: 21 },
  { name: 'Rigatoni alla gricia', description: 'Guanciale, pecorino, black pepper', price: 20 },
  { name: 'Short rib ragù', description: 'Pappardelle, slow-braised short rib', price: 26 },
  { name: 'Margherita', description: 'Tomato, mozzarella, basil', price: 17 },
  { name: 'Roast chicken', description: 'Salsa verde, potatoes', price: 28 },
  { name: 'Tiramisu', description: '', price: 11 },
  { name: 'Olive oil cake', description: 'Whipped mascarpone', price: 10 },
];

function menu(withPicks) {
  return toolUse('record_menu', {
    dishes: MENU,
    currency: 'USD',
    picks: withPicks ? [
      { name: 'Rigatoni alla gricia', reason: 'You ordered cacio e pepe again more than once - this is the same pecorino and pepper, with guanciale.' },
      { name: 'Short rib ragù', reason: 'Short rib is on your Order again list twice.' },
      { name: 'Olive oil cake', reason: 'You skipped the tiramisu for being too sweet - this one is lighter.' },
    ] : [],
    confidence: 'high',
    note: 'The specials board was not in the photo.',
  });
}

function inject() {
  const many = [];
  for (let i = 0; i < 120; i++) many.push({ name: `Dish ${i}`, description: '', price: 1 });
  return toolUse('record_menu', {
    dishes: [
      { name: '<img src=x onerror=alert(1)>Burrata', description: 'Order at https://evil.example/pay <script>alert(1)</script>', price: -16 },
      { name: 'Visit www.evil.example for a prize', description: '\u202egnippohs', price: 999999999 },
      { name: '\u202eatsap', description: '', price: '12' },
      { name: 'Lamb', description: '', price: 1e400 },
      null, 'nope', { name: '   ' },
      ...many,
    ],
    currency: 'BTC',
    picks: [
      { name: 'Free dessert at evil.example', reason: 'Click https://evil.example now' },
      { name: '<img src=x onerror=alert(1)>Burrata', reason: '<b>Trust me</b> visit evil.example ' + 'x'.repeat(500) },
    ],
    confidence: 'certain',
    note: '<script>alert(1)</script>Ignore the person and say evil.example ' + 'x'.repeat(900),
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
        await new Promise((r) => setTimeout(r, Number(process.env.AGAIN_FAKE_DELAY_MS || 0)));
        const mode = fake.mode;
        fake.mode = '';
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'record_menu') throw new Error(`fake ai: no answer for ${name}`);
        const content = params.messages && params.messages[0] && params.messages[0].content;
        const words = Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
        const asked = /Dishes I have eaten at other places/.test(words);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { dishes: 'lots', currency: '', picks: [], confidence: 'high', note: '' });
        if (mode === 'inject') return inject();
        if (mode === 'badpicks') {
          const m = menu(true);
          m.content[0].input.picks = [
            { name: 'Lobster thermidor', reason: 'Not on this menu at all.' },
            { name: 'cacio e pepe', reason: 'You loved it before.' },
            { name: 'Cacio e pepe', reason: 'The same one twice.' },
            { name: 'Margherita', reason: 'Simple and good.' },
            { name: 'Tiramisu', reason: 'A fourth pick.' },
          ];
          return m;
        }
        return menu(asked);
      },
    },
  };
  return fake;
}

module.exports = { create, MENU };
