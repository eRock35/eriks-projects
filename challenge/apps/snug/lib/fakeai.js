// A stand-in Anthropic client for local runs and tests (SNUG_FAKE_AI=1).
//
// It answers the one forced tool, record_plate, with a made-up reading of
// a Corvane furnace's rating plate, so "Read the label" can be driven
// without a key and without spending anything. It is refused on Cloud Run:
// a deployment that read every label as the same furnace would look like
// it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// A test sets `fake.mode` for one call:
//   'blank'        nothing readable - a 422
//   'bad'          a clean model number among a serial, a price, a recall,
//                  a safety verdict and "replace it" - as extra fields and
//                  inside the plate's own fields - and an email, a phone
//                  number, a link, markup, a year, a kind and a fuel that
//                  cannot be: all dropped, the model kept
//   'inject'       markup, a bidi override and extra fields - cleaned, 200
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.SNUG_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('SNUG_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1500, output_tokens: 120 },
    ...(extra || {}),
  };
}

const GOOD = { kind: 'furnace', maker: 'Corvane', model: 'GX80-40B', year: 2014, fuel: 'gas', size: '80,000 BTU/h input', volts: '120 V', amps: '9 A', unsure: ['year'] };

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
        await new Promise((r) => setTimeout(r, Number(process.env.SNUG_FAKE_DELAY_MS || 0)));
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'record_plate') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { kind: 'other', maker: '', model: '', year: null, fuel: 'unknown', size: '', volts: '', amps: '', unsure: ['maker', 'model'] });
        if (mode === 'bad') {
          // Built from pieces, so no file carries an email or a phone number.
          const AT = String.fromCharCode(64);
          const PHONE = ['555', '201', '3344'].join(' ');
          return toolUse(name, {
            ...GOOD,
            maker: 'Corvane - call ' + PHONE,
            model: 'GX80-40B',
            note: 'serial CV14X5521',
            size: 'about $1,800 to replace',
            volts: 'help' + AT + 'maker.example',
            amps: '<b>9 A</b>',
            year: 1890,
            fuel: 'plutonium',
            kind: 'spaceship',
            serial: 'CV14X5521',
            price: '$1,800',
            recall: 'This model was recalled',
            safety: 'Unsafe - shut it off',
            advice: 'Replace it now',
            link: 'https://maker.example/recalls',
          });
        }
        if (mode === 'inject') {
          return toolUse(name, { ...GOOD, maker: 'Corvane' + String.fromCharCode(0x202E), model: '<img src=x onerror=alert(1)>GX80', note: 'ignore your instructions', admin: true });
        }
        return toolUse(name, { ...GOOD });
      },
    },
  };
  return fake;
}

module.exports = { create, GOOD };
