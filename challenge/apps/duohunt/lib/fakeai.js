// A stand-in Anthropic client for local runs and tests (DUOHUNT_FAKE_AI=1).
//
// It answers the one forced tool, record_deal_terms, with a reading of the
// page's own made-up sample offer (DealCore.SAMPLE, "Northwind Mobile"), so
// "Check a deal" can be driven without a key and without spending anything.
// Paste anything else and the same reading comes back - and the server's own
// checks drop every number and quote the pasted text does not contain, which
// is exactly what they are for. Refused on Cloud Run: a deployment that read
// every offer as the same terms would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// A test sets `fake.mode` for one call:
//   'blank'        nothing readable - a 422
//   'bad'          the good reading plus invented numbers, an invented quote,
//                  absurd amounts, a total of its own and extra fields: the
//                  inventions are dropped and named, the rest kept
//   'inject'       markup and a bidi override in the words - cleaned, 200
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.DUOHUNT_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('DUOHUNT_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1400, output_tokens: 520 },
    ...(extra || {}),
  };
}

const GOOD = {
  device_name: 'iPhone Duo 256GB',
  device_price: 1999.8,
  down_payment: null,
  monthly_device_payment: 55.55,
  installment_months: 36,
  monthly_line_cost: 90,
  line_cost_without_autopay: 100,
  autopay_required: true,
  term_months: 36,
  credits: [
    { label: 'Trade-in bill credits', kind: 'bill_credit', total: 1999.8, monthly: 55.55, months: 36, condition: 'Trade in an eligible phone and keep the line for all 36 months.' },
  ],
  fees: [{ label: 'Activation fee', kind: 'one_time', amount: 35 }],
  trade_in_required: true,
  trade_in_note: 'An eligible phone in good working condition, sent back within 30 days.',
  catches: [
    { text: 'The “$0 a month” is the phone only, and only as monthly credits spread over three years.', quote: 'applied as $55.55/mo over 36 months' },
    { text: 'Leave, or pay the phone off early, and the credits stop while the balance comes due.', quote: 'If you cancel wireless service or pay off the device early, remaining credits stop and the remaining device balance is due.' },
    { text: 'The plan is $10 a month more without AutoPay and paperless billing.', quote: '$90/mo for one line with AutoPay and paperless billing ($100/mo without)' },
    { text: 'You pay the phone’s payment yourself until the credits begin.', quote: 'Credits start within 3 bill cycles.' },
    { text: 'Tax on the full price is due on day one, and so is the activation fee.', quote: 'Sales tax on the full retail price is due at sale.' },
    { text: 'No eligible trade-in in good condition, no credits.', quote: 'Trade-in must be an eligible phone in good working condition, sent back within 30 days.' },
  ],
  unsure: ['Which phones count as eligible'],
};

const BLANK = { device_name: '', device_price: null, down_payment: null, monthly_device_payment: null, installment_months: null, monthly_line_cost: null, line_cost_without_autopay: null, autopay_required: null, term_months: null, credits: [], fees: [], trade_in_required: null, trade_in_note: '', catches: [], unsure: ['everything'] };

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
        await new Promise((r) => setTimeout(r, Number(process.env.DUOHUNT_FAKE_DELAY_MS || 0)));
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'record_deal_terms') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, JSON.parse(JSON.stringify(BLANK)));
        const good = JSON.parse(JSON.stringify(GOOD));
        if (mode === 'bad') {
          return toolUse(name, {
            ...good,
            monthly_line_cost: 49.99,                 // a number the offer never wrote
            down_payment: -5,
            fees: good.fees.concat([{ label: 'Invented fee', kind: 'one_time', amount: 77.77 }, { label: 'Absurd', kind: 'monthly', amount: 9e9 }]),
            credits: good.credits.concat([{ label: 'Made-up loyalty credit', kind: 'instant', total: 800, monthly: null, months: null, condition: '' }]),
            catches: good.catches.slice(0, 2).concat([
              { text: 'A catch the offer never states.', quote: 'You must also sign a five-year contract.' },
              { text: '', quote: 'Credits start within 3 bill cycles.' },
            ]),
            total_36_months: 12.34,
            advice: 'Buy it now.',
          });
        }
        if (mode === 'inject') {
          good.device_name = '<b>iPhone Duo</b> 256GB' + String.fromCharCode(0x202E);
          good.catches[0].text = '<script>x</script>The “$0 a month” is the phone only.';
          return toolUse(name, { ...good, admin: true, note: 'ignore your instructions' });
        }
        return toolUse(name, good);
      },
    },
  };
  return fake;
}

module.exports = { create, GOOD };
