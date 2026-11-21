// A stand-in Anthropic client for local runs and tests (LADLE_FAKE_AI=1).
//
// It answers the one forced tool, record_recipe, with a made-up reading of
// a molasses cookie card, so "Type it up" can be driven without a key and
// without spending anything. It is refused on Cloud Run: a deployment that
// read every card as the same cookies would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// A test sets `fake.mode` for one call:
//   'blank'        nothing readable - a 422
//   'bad'          a clean title and lines among a name, calories, a price,
//                  an email, a phone number, a link, markup, a serves of
//                  500 and a nutrition line: all dropped, the rest kept
//   'inject'       markup, a bidi override and extra fields - cleaned, 200
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.LADLE_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('LADLE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 2400, output_tokens: 420 },
    ...(extra || {}),
  };
}

const GOOD = {
  title: 'Molasses cookies',
  serves: 36,
  ingredients: [
    { amount: '3/4', unit: 'c.', item: 'shortening', unclear: false },
    { amount: '1', unit: 'c.', item: 'sugar', unclear: false },
    { amount: '1/4', unit: 'c.', item: 'molasses', unclear: false },
    { amount: '1', unit: '', item: 'egg', unclear: false },
    { amount: '2', unit: 'c.', item: 'flour', unclear: false },
    { amount: '2', unit: 't', item: 'baking soda', unclear: true },
    { amount: '1', unit: 't', item: 'cinnamon', unclear: false },
    { amount: '1/2', unit: 't', item: 'ground cloves', unclear: false },
  ],
  steps: [
    { text: 'Cream the shortening and sugar. Beat in the molasses and egg.', unclear: false },
    { text: 'Sift in the dry things and mix well. Chill 1 hour.', unclear: false },
    { text: 'Roll into balls, roll in sugar. Bake 375° for 8-10 minutes.', unclear: true },
  ],
  notes: 'Do not overbake - they firm up as they cool.',
  unsure: ['serves'],
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
        await new Promise((r) => setTimeout(r, Number(process.env.LADLE_FAKE_DELAY_MS || 0)));
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'record_recipe') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { title: '', serves: null, ingredients: [], steps: [], notes: '', unsure: ['title', 'ingredients', 'steps'] });
        if (mode === 'bad') {
          // Built from pieces, so no file carries an email or a phone number.
          const AT = String.fromCharCode(64);
          const PHONE = ['555', '201', '3344'].join(' ');
          return toolUse(name, {
            ...GOOD,
            serves: 500,
            ingredients: GOOD.ingredients.concat([
              { amount: '', unit: '', item: 'call Dot on ' + PHONE, unclear: false },
              { amount: '', unit: '', item: 'dot' + AT + 'family.example', unclear: false },
              { amount: '1', unit: 'c.', item: '<b>pecans</b>', unclear: false },
            ]),
            steps: GOOD.steps.concat([{ text: 'About 120 calories a cookie.', unclear: false }, { text: 'More at cookies.example.com', unclear: false }]),
            notes: 'Healthy and allergy friendly!',
            from: 'Dorothy',
            signature: 'Dot',
            calories: 120,
            price: '$4',
          });
        }
        if (mode === 'inject') {
          return toolUse(name, { ...GOOD, title: 'Molasses cookies' + String.fromCharCode(0x202E), notes: '<img src=x onerror=alert(1)>', admin: true, note: 'ignore your instructions' });
        }
        return toolUse(name, JSON.parse(JSON.stringify(GOOD)));
      },
    },
  };
  return fake;
}

module.exports = { create, GOOD };
