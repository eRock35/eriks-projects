// A stand-in Anthropic client for local runs and tests (WATERFALL_FAKE_AI=1).
//
// It answers the one forced tool deterministically from the products it is
// sent, so "Suggest rules for my products" can be driven without a key and
// without spending anything. It is refused on Cloud Run: a deployment that
// handed everyone the same canned suggestions would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not (no customer, no
// invoice id, no amount, no date).
//
// A test sets `fake.mode` for one call:
//   'blank'        no suggestions - a 422
//   'bad'          numbers that were not sent, a rule not on the list, N
//                  out of range - dropped; one good one kept
//   'inject'       markup, a bidi override and a link in the reasons, an
//                  extra field - cleaned, 200
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.WATERFALL_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('WATERFALL_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 900, output_tokens: 600 },
    ...(extra || {}),
  };
}

/** The products, read back from the prompt. */
function products(text) {
  const body = ((/<<<PRODUCTS\n([\s\S]*?)\nPRODUCTS>>>/.exec(text) || [])[1]) || '';
  return body.split('\n').map((l) => /^(\d+)\. "(.*)" - (\d+)% of its lines have a service period; line types: ([^;]*); (.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ n: Number(m[1]), d: m[2], period: Number(m[3]), types: m[4], len: m[5] }));
}

/** A plausible suggestion that uses only what it was sent. */
function suggest(p) {
  const d = p.d.toLowerCase();
  if (/onboard|setup|set-up|implementation|training/.test(d)) return { n: p.n, rule: 'months', months: 12, reason: 'Setup fees are often spread over the expected customer relationship - your accountant decides how long.' };
  if (/deposit|pass.?through|reimburse/.test(d)) return { n: p.n, rule: 'exclude', reason: 'Deposits and pass-through charges are usually not revenue.' };
  if (/usage|overage|metered|api/.test(p.types + ' ' + d)) return { n: p.n, rule: 'period', reason: 'Usage is usually recognised over the period it was used in, even when billed after.' };
  if (/credit|refund/.test(p.types + ' ' + d)) return { n: p.n, rule: p.period >= 50 ? 'period' : 'invoice', reason: 'Credits usually follow the period they apply to, or the day they are given when there is none.' };
  if (p.period >= 50) return { n: p.n, rule: 'period', reason: 'A subscription with a service period is commonly recognised over that period, by day.' };
  if (p.period === 0) return { n: p.n, rule: 'invoice', reason: 'No service period - a one-off charge usually lands on its invoice date.' };
  return { n: p.n, rule: 'unsure', reason: 'Some lines have a period and some do not - check one invoice.' };
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
        await new Promise((r) => setTimeout(r, Number(process.env.WATERFALL_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'suggest_rules') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { suggestions: [] });
        const good = products(text).map(suggest);
        if (mode === 'bad') return toolUse(name, { suggestions: [good[0], { n: 0, rule: 'period', reason: 'x' }, { n: 999, rule: 'period', reason: 'x' }, { n: 2, rule: 'maybe', reason: 'x' }, { n: 3, rule: 'months', months: 99, reason: 'x' }, { ...good[0], reason: 'again' }] });
        if (mode === 'inject') return toolUse(name, { suggestions: good.map((s) => ({ ...s, reason: '<b>' + String.fromCharCode(0x202E) + s.reason + '</b> see https://evil.example/x and mail ops' + String.fromCharCode(64) + 'evil.example <img src=x onerror=alert(1)>', extra: 'hunter2' })) });
        return toolUse(name, { suggestions: good });
      },
    },
  };
  return fake;
}

module.exports = { create };
