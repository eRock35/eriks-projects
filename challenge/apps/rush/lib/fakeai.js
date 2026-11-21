// A stand-in Anthropic client for local runs and tests (RUSH_FAKE_AI=1).
//
// It answers the one forced tool deterministically from what it was sent -
// the menu ids in the tool's enum - so "Read the order slip" can be driven
// without a key and without spending anything. It is refused on Cloud Run:
// a deployment that read every slip as the same three orders would look
// like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not (no shop name, no
// customer, no order, no date).
//
// A test sets `fake.mode` for one call:
//   'blank'        no orders - a 422
//   'bad'          one good order among fields carrying a phone number, an
//                  email, a card number, a street address, a link, a
//                  formula or markup; an item id never sent; a made-up
//                  weekday and payment; a quantity of 0; an order with no
//                  name and no items - all dropped or mended
//   'inject'       markup, a bidi override and extra fields - cleaned, 200
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.RUSH_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('RUSH_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1600, output_tokens: 600 },
    ...(extra || {}),
  };
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
        const mode = fake.mode;
        fake.mode = '';
        await new Promise((r) => setTimeout(r, Number(process.env.RUSH_FAKE_DELAY_MS || 0)));
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'record_orders') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { orders: [] });
        const tool = params.tools.find((t) => t.name === name);
        const ids = tool.input_schema.properties.orders.items.properties.items.items.properties.item.enum.filter((x) => x !== 'other');
        const a = ids[0], b = ids[1] || ids[0];
        const good = [
          { name: 'Jo N.', items: [{ item: a, qty: 2 }], weekday: 'wednesday', dayOfMonth: null, time: '10:30', note: '', paid: 'deposit', unsure: [] },
          { name: 'Max T.', items: [{ item: b, qty: 1 }, { item: 'other', qty: 1, words: 'gingerbread house' }], weekday: 'tuesday', dayOfMonth: 24, time: '4pm', note: 'Nut allergy', paid: 'unknown', unsure: ['paid', 'time'] },
        ];
        if (mode === 'bad') {
          // Built from pieces, so no file carries a phone, card or email.
          const AT = String.fromCharCode(64);
          const PHONE = ['555', '201', '3344'].join(' ');
          const CARD = ['4111'].concat(Array(3).fill('1111')).join(' ');
          return toolUse(name, { orders: [
            good[0],
            { ...good[0], name: `Call ${PHONE}`, note: 'Ring me back' },
            { ...good[0], name: 'Lu V.', note: `Email lu${AT}mail.example when ready` },
            { ...good[0], name: 'Ken W.', note: `Card ${CARD} exp 09` },
            { ...good[0], name: 'Ann B.', note: 'Deliver to 42 Elm Street please' },
            { ...good[0], name: 'Ola P.', note: 'See https://pies.example/menu' },
            { ...good[0], name: '=HYPERLINK("x")', note: '' },
            { ...good[0], name: '<img src=x onerror=alert(1)>', items: [{ item: 'notonmenu', qty: 1 }, { item: a, qty: 0 }] },
            { name: '', items: [], weekday: 'funday', dayOfMonth: 40, time: '', note: '', paid: 'gold', unsure: ['everything'] },
          ] });
        }
        if (mode === 'inject') {
          return toolUse(name, { orders: good.map((x) => ({ ...x, name: x.name + String.fromCharCode(0x202E), note: '<b>' + x.note + '</b>', extra: 'hunter2', shop: 'overwrite' })), admin: true });
        }
        return toolUse(name, { orders: good });
      },
    },
  };
  return fake;
}

module.exports = { create };
