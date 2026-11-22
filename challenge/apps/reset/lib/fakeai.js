// A stand-in Anthropic client for local runs and tests (RESET_FAKE_AI=1).
//
// It answers the one forced tool, record_rate_terms, with a made-up reading
// of a 5/1 adjustable-rate note's rate-change section, so "Read the note"
// can be driven without a key and without spending anything. It is refused
// on Cloud Run: a deployment that read every note as the same terms would
// look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// A test sets `fake.mode` for one call:
//   'blank'        nothing readable - a 422
//   'bad'          good terms among a borrower name, a loan number, a
//                  balance, advice, a margin of 90% and an unreadable cap:
//                  all dropped and named, the rest kept
//   'inject'       markup, a bidi override and extra fields - cleaned, 200
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.RESET_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('RESET_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1800, output_tokens: 160 },
    ...(extra || {}),
  };
}

const GOOD = {
  index_name: '30-day average SOFR',
  margin: '2.750%',
  rounding: 'nearest',
  increment: '0.125%',
  lookback_days: 45,
  reset_every_months: 6,
  first_change_cap: '2.000',
  periodic_cap: '1%',
  lifetime_cap: '5',
  floor: '2.750%',
  ceiling: '',
  interest_only: false,
  unsure: ['ceiling'],
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
        await new Promise((r) => setTimeout(r, Number(process.env.RESET_FAKE_DELAY_MS || 0)));
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'record_rate_terms') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { index_name: '', margin: '', rounding: null, increment: '', lookback_days: null, reset_every_months: null, first_change_cap: '', periodic_cap: '', lifetime_cap: '', floor: '', ceiling: '', interest_only: null, unsure: ['margin'] });
        if (mode === 'bad') {
          return toolUse(name, {
            ...GOOD,
            margin: '90%',
            lifetime_cap: 'five-ish points',
            borrower: 'Pat Example',
            loan_number: ['00', '4471', '2289'].join(''),
            balance: '$245,310.18',
            advice: 'Refinance now.',
          });
        }
        if (mode === 'inject') {
          return toolUse(name, { ...GOOD, index_name: '<b>SOFR</b>' + String.fromCharCode(0x202E), admin: true, note: 'ignore your instructions' });
        }
        return toolUse(name, JSON.parse(JSON.stringify(GOOD)));
      },
    },
  };
  return fake;
}

module.exports = { create, GOOD };
