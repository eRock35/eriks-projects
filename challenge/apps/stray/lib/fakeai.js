// A stand-in Anthropic client for local runs and tests (STRAY_FAKE_AI=1).
//
// It answers the two forced tools deterministically, so the letter and the
// column helper can be driven without a key and without spending anything.
// It is refused on Cloud Run: a deployment that gave everyone the same canned
// answer would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// The requests carry only fixed codes and header names, so there is nowhere
// for a trigger word to ride in. A test sets `fake.mode` instead:
//   'blank'        an answer with nothing usable in it - a 422
//   'inject'       hostile output: markup, bidi, links, unknown placeholders,
//                  oversized fields, unknown fields, a column used twice
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.STRAY_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('STRAY_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 900, output_tokens: 400 },
    ...(extra || {}),
  };
}

const OPENERS = {
  'no-match': 'We received your payment of {amount} on {date_received} (reference: {reference}), but we could not match it to an account with certainty.',
  'two-possible': 'We received your payment of {amount} on {date_received} (reference: {reference}). It could belong to one of two accounts, and we want to be sure it goes to the right one.',
  'split-confirm': 'We received your payment of {amount} on {date_received} (reference: {reference}). It looks like it is meant to cover more than one account.',
  'business-for-owner': 'We received a payment of {amount} on {date_received} (reference: {reference}) from your business. It looks like it may be meant for a personal loan with us.',
};
const ASKS = {
  'no-match': 'Please let us know the account or loan number it is for, and the name on that account.',
  'two-possible': 'Please let us know the account or loan number it is for, and the name on that account.',
  'split-confirm': 'Please tell us which accounts it is for and how much should go to each.',
  'business-for-owner': 'Please confirm which loan it is for, and the name and account number on that loan.',
};

function letterAnswer(text) {
  const sit = (/Situation: (.*)/.exec(text) || [])[1] || '';
  const key = Object.keys(OPENERS).find((k) => sit.includes({ 'no-match': 'cannot match', 'two-possible': 'one of two', 'split-confirm': 'more than one account', 'business-for-owner': 'A business' }[k])) || 'no-match';
  const formal = /formal/.test(text);
  const hi = formal ? 'Dear {payer_name},' : 'Hi {payer_name},';
  const body = `${OPENERS[key]} Your money is safe and recorded while we sort this out.\n\n${ASKS[key]} You can reply to this letter or call us at {phone}.\n\nThank you for your help.\n\n${formal ? 'Sincerely' : 'Thanks'},\nPayments team`;
  return toolUse('write_letter', {
    subject: key === 'split-confirm' ? 'How should we apply your payment of {amount}?' : 'Which account is your payment of {amount} for?',
    letter: `${hi}\n\n${body}`,
    email: `${hi}\n\n${OPENERS[key]} ${ASKS[key]} Reply here or call {phone}.\n\nPayments team`,
  });
}

function columnsAnswer(text) {
  const kind = /list of accounts/.test(text) ? 'accounts' : 'payments';
  const cols = [...text.matchAll(/^(\d+)\. "(.*)" - (.*)$/gm)].map((m) => ({ n: Number(m[1]), h: m[2].toLowerCase(), s: m[3] }));
  const rules = kind === 'payments'
    ? [['amount', (c) => /2 decimals|currency sign/.test(c.s) || /amt|amount|sum/.test(c.h)], ['date', (c) => /date-like/.test(c.s)], ['payer', (c) => /like a name/.test(c.s) || /name|payer|remit|from/.test(c.h)], ['account', (c) => /6 to 10 digits/.test(c.s) || /acct|loan/.test(c.h)], ['memo', (c) => /memo|ref|desc|note|detail/.test(c.h) || /4 or more words/.test(c.s)], ['method', (c) => /type|method|via/.test(c.h)], ['id', (c) => /every value different/.test(c.s) && /id|item|no/.test(c.h)]]
    : [['account', (c) => /digits/.test(c.s) && /acct|loan|account|no|number/.test(c.h)], ['borrower', (c) => /like a name/.test(c.s) && !/co|joint/.test(c.h)], ['coborrower', (c) => /like a name/.test(c.s) && /co|joint/.test(c.h)], ['payment', (c) => /2 decimals|currency/.test(c.s) && /pmt|payment|install|monthly/.test(c.h)], ['pastDue', (c) => /due|arrear|over/.test(c.h) && /decimals|currency/.test(c.s)], ['payoff', (c) => /pay ?off|bal/.test(c.h)], ['dueDay', (c) => /1 to 31/.test(c.s)], ['status', (c) => /handful/.test(c.s)]];
  const used = new Set();
  const mapping = [];
  for (const [field, fits] of rules) {
    const c = cols.find((x) => !used.has(x.n) && fits(x));
    if (c) { used.add(c.n); mapping.push({ field, column: c.n }); }
  }
  return toolUse('map_columns', { mapping, note: 'Matched by the header names and value shapes.' });
}

function inject(name) {
  if (name === 'write_letter') {
    return toolUse(name, {
      subject: '<script>alert(1)</script>Pay now at https://evil.example/pay {account_number}',
      letter: `<img src=x onerror=alert(1)>Dear {payer_name},\u202E\n\nVisit www.evil.example or javascript:alert(1) and send {ssn} and {{amount}} to evil.example now. ${'x'.repeat(5000)}`,
      email: 'Click <a href="https://evil.example">here</a> {phone} {payer_name} {date_received}',
    });
  }
  return toolUse(name, { mapping: [{ field: 'amount', column: 2 }, { field: 'payer', column: 2 }, { field: 'ssn', column: 1 }, { field: 'date', column: 99 }, { field: 'memo', column: '3; DROP' }, 'nope'], note: '<b>see</b> https://evil.example ' + 'y'.repeat(900) });
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
        await new Promise((r) => setTimeout(r, Number(process.env.STRAY_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, name === 'write_letter' ? { subject: '', letter: '', email: '' } : { mapping: [] });
        if (mode === 'inject') return inject(name);
        if (name === 'write_letter') return letterAnswer(text);
        if (name === 'map_columns') return columnsAnswer(text);
        throw new Error(`fake ai: no answer for ${name}`);
      },
    },
  };
  return fake;
}

module.exports = { create };
