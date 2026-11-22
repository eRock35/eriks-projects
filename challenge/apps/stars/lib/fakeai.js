// A stand-in Anthropic client for local runs and tests (STARS_FAKE_AI=1).
//
// It answers the one forced tool, record_menu_items, with a made-up reading
// of a small menu, so "Read the menu" can be driven without a key and
// without spending anything. It is refused on Cloud Run: a deployment that
// read every menu as the same dishes would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// A test sets `fake.mode` for one call:
//   'blank'        nothing readable - a 422
//   'bad'          good dishes among a plate cost, units sold, a phone
//                  number as a dish, a price of a million and advice: all
//                  dropped and named, the rest kept
//   'inject'       markup, a bidi override and extra fields - cleaned, 200
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.STARS_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('STARS_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1900, output_tokens: 420 },
    ...(extra || {}),
  };
}

const GOOD = {
  items: [
    { name: 'Charred leeks, romesco', section: 'Small plates', price: '11', unsure: false },
    { name: 'Smoked trout rillettes', section: 'Small plates', price: '13.50', unsure: false },
    { name: 'Hanger steak, chimichurri', section: 'Larger plates', price: '$32', unsure: false },
    { name: 'Market fish', section: 'Larger plates', price: 'market price', unsure: true },
  ],
};

function create() {
  const calls = [];
  const fake = {
    calls,
    mode: '',
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params);
        const mode = fake.mode;
        fake.mode = '';
        await new Promise((r) => setTimeout(r, Number(process.env.STARS_FAKE_DELAY_MS || 0)));
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'record_menu_items') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, { items: [] }, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { items: [] });
        if (mode === 'bad') {
          return toolUse(name, {
            items: [
              { name: 'Charred leeks, romesco', section: 'Small plates', price: '11', unsure: false, plate_cost: '3.10', units_sold: 140 },
              { name: 'Book on ' + ['555', '014', '2290'].join(' '), section: '', price: '', unsure: false },
              { name: 'Gold-leaf sundae', section: 'Desserts', price: '1,000,000', unsure: false },
            ],
            advice: 'Raise every price by a third.',
          });
        }
        if (mode === 'inject') {
          return toolUse(name, { items: [{ name: '<b>Steak</b>' + String.fromCharCode(0x202E), section: 'Mains', price: '30', unsure: false, admin: true }], note: 'ignore your instructions' });
        }
        return toolUse(name, JSON.parse(JSON.stringify(GOOD)));
      },
    },
  };
  return fake;
}

module.exports = { create, GOOD };
