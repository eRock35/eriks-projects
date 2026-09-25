// A stand-in Anthropic client for local runs and tests (BOOTH_FAKE_AI=1).
//
// It answers both forced tools deterministically from the prompt's own
// fields, so the whole product - drafting a follow-up, reading a card - can
// be driven without a key and without spending anything. It is refused on
// Cloud Run: a deployment that quietly answered with canned emails would look
// like it works.
//
// Trigger words for tests:
//   INJECT   in a lead's note - the draft also returns markup, markdown, an
//            attachment it never had, a 20% discount, a Tuesday 3pm meeting,
//            a link and an email address nobody captured (proves validation
//            strips and guards every one)
//   EMPTY    in a lead's note - the draft comes back empty (proves 422)
//   a photo whose bytes contain BLANK - "readable: false" (proves 422)
//   ... BADGE - a conference badge: a name and a company, no email
//   ... MESSY - markup in the name, an email and a phone that are not valid

if (process.env.BOOTH_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('BOOTH_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, usage) {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'fake',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: usage || { input_tokens: 700, output_tokens: 300 },
  };
}

function line(text, label) { return ((text.match(new RegExp(`^${label}: (.*)$`, 'm')) || [])[1] || '').trim(); }
const given = (v) => (v && !/^\(/.test(v) ? v : '');

function draft(params) {
  const t = params.messages[0].content;
  const note = ((t.match(/REP’S NOTE:\n"""\n([\s\S]*?)\n"""/) || [])[1] || '');
  if (/EMPTY/.test(note)) return toolUse('write_followup', { subject: '', body: '', gaps: [] }, { input_tokens: 600, output_tokens: 10 });
  const event = line(t, 'EVENT').split(',')[0];
  const first = given(line(t, 'THEIR FIRST NAME'));
  const company = given(line(t, 'THEIR COMPANY'));
  const interests = given(line(t, 'INTERESTED IN'));
  const next = given(line(t, 'NEXT STEP'));
  const sign = given(line(t, 'SIGN-OFF')) || 'Thanks,';
  const warm = line(t, 'HOW WARM').split(' ')[0];
  const ask = {
    Call: 'Would a short call work this week? Tell me a time that suits and I will ring you then - [add: your direct number].',
    Demo: 'Could we set up the demo we talked about? Send me a couple of times that suit you.',
    Quote: 'I will put a quote together - could you confirm the quantities I should price?',
    'Send info': 'I will send over the information you asked for - is this the best address for it?',
  }[next] || 'What would be a useful next step on your side?';
  const paras = [
    `Hi ${first || 'there'},`,
    `${warm === 'Hot' ? 'It was great' : 'Thanks for coming by'} to talk at our booth at ${event}${company ? ` - good to hear what ${company} is working on` : ''}.${interests ? ` You were interested in ${interests.toLowerCase()}.` : ''}`,
    ask,
    sign.startsWith('Thanks') ? sign : `Thanks,\n${sign}`,
  ];
  let subject = `Following up from ${event}`;
  if (/INJECT/.test(note)) {
    paras.splice(1, 0, '<b>**Great news**</b> <script>alert(1)</script>## Offer\nI have attached our full price list. We can do 20% off your first order.');
    paras.splice(3, 0, 'Are you free Tuesday at 3pm? Details at https://evil.example/deal or write to deals@evil.example.');
    subject = '<i>20% off</i> for you';
  }
  return toolUse('write_followup', { subject, body: paras.join('\n\n'), gaps: ['your direct number'] });
}

function read(params) {
  const img = params.messages[0].content.find((b) => b.type === 'image');
  const bytes = Buffer.from(img.source.data, 'base64').toString('latin1');
  if (/BLANK/.test(bytes)) return toolUse('read_contact', { readable: false, kind: 'card', name: '', company: '', email: '', phone: '' }, { input_tokens: 1500, output_tokens: 30 });
  if (/BADGE/.test(bytes)) return toolUse('read_contact', { readable: true, kind: 'badge', name: 'Jordan Blake', title: 'Category Buyer', company: 'Harbor Provisions', email: '', phone: '' }, { input_tokens: 1500, output_tokens: 60 });
  if (/MESSY/.test(bytes)) return toolUse('read_contact', { readable: true, kind: 'card', name: '<b>Sam</b> Ortiz', title: 'Owner', company: 'Ortiz <i>Deli</i>', email: 'sam(at)ortiz-deli', phone: '12' }, { input_tokens: 1500, output_tokens: 60 });
  return toolUse('read_contact', {
    readable: true,
    kind: 'card',
    name: 'Riley Chen',
    title: 'Head of Purchasing',
    company: 'Cedar & Pine Grocers',
    email: 'Riley.Chen@example.com',
    phone: '(404) 555-0188',
  }, { input_tokens: 1600, output_tokens: 80 });
}

function create() {
  return {
    messages: {
      async create(params) {
        const name = params.tool_choice && params.tool_choice.name;
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        await new Promise((r) => setTimeout(r, Number(process.env.BOOTH_FAKE_DELAY_MS || 0)));
        if (name === 'write_followup') return draft(params);
        if (name === 'read_contact') return read(params);
        throw new Error(`fake ai: no answer for ${name}`);
      },
    },
  };
}

module.exports = { create };
