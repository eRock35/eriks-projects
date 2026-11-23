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
        // A stand-in provider failure, for the tests: UPSTREAM401 anywhere in
        // the messages throws what the SDK would, raw JSON and all.
        const up = JSON.stringify(params.messages || '').match(/UPSTREAM(\d{3})/);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
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

/**
 * The stand-in for Gemini (BOOTH_AI_PROVIDER=gemini): given the body the
 * guard's Vertex helper would send, an answer in the shape its schema asks
 * for. Which request it is, is read from the schema. Every request is kept
 * in `geminiCalls` with the media replaced by its length.
 *
 * "Scan a card" triggers, in the photo's or the memo's bytes:
 *   BLANK        not a card (readable: false) - a 422
 *   BADGE        a badge: a name, a title and a company, no email or phone
 *   MESSY        markup in the name, an email and a phone that are not valid
 *   UNSURE       an email it is not sure of, a phone it could not read
 *   SILENT       (memo) nothing could be made out
 *   INJECT       (memo) hostile output: markup, an attachment, 20% off,
 *                "Tuesday at 3pm", a link, the card's email in the draft,
 *                a made-up temperature and interest
 *   UPSTREAMnnn  the call fails the way the helper's VertexError does
 *   otherwise    Riley Chen's card; with a memo, a summary, "hot", a call,
 *                the event's first interest and a draft from those facts
 * The draft request answers as the Claude stand-in does.
 */
const geminiCalls = [];
async function gemini(body) {
  const parts = (body && body.contents && body.contents[0] && body.contents[0].parts) || [];
  const schema = (body && body.generationConfig && body.generationConfig.responseSchema) || {};
  const props = schema.properties || {};
  const media = parts.filter((p) => p.inlineData);
  const text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n');
  geminiCalls.push({
    schema: Object.keys(props),
    systemInstruction: body && body.systemInstruction,
    parts: parts.map((p) => (p.inlineData ? { inlineData: { mimeType: p.inlineData.mimeType, data: `<${p.inlineData.data.length} chars>` } } : p)),
  });
  await new Promise((r) => setTimeout(r, Number(process.env.BOOTH_FAKE_DELAY_MS || 0)));
  const bytes = media.map((p) => Buffer.from(p.inlineData.data, 'base64').toString('latin1')).join('\n');
  const hit = `${bytes}\n${text}`.match(/UPSTREAM(\d{3})/);
  if (hit) throw Object.assign(new Error(`Gemini answered ${hit[1]}. stand-in provider failure`), { name: 'VertexError', code: 'http', status: Number(hit[1]) });

  // A follow-up for a saved lead: the Claude stand-in's answer.
  if (!props.readable) return draft({ messages: [{ content: text }] }).content[0].input;

  const F = (value, confidence) => ({ value, confidence: confidence || (value ? 'high' : 'low') });
  let card = { readable: true, kind: 'card', name: F('Riley Chen'), company: F('Cedar & Pine Grocers'), title: F('Head of Purchasing'), email: F('Riley.Chen@example.com'), phone: F('(404) 555-0188') };
  if (/BLANK/.test(bytes)) card = { readable: false, kind: 'card', name: F(null), company: F(null), title: F(null), email: F(null), phone: F(null) };
  else if (/BADGE/.test(bytes)) card = { readable: true, kind: 'badge', name: F('Jordan Blake'), company: F('Harbor Provisions'), title: F('Category Buyer'), email: F(null), phone: F(null) };
  else if (/MESSY/.test(bytes)) card = { readable: true, kind: 'card', name: F('<b>Sam</b> Ortiz', 'medium'), company: F('Ortiz <i>Deli</i>'), title: F('Owner'), email: F('sam(at)ortiz-deli', 'low'), phone: F('12', 'certain') };
  else if (/UNSURE/.test(bytes)) card = { ...card, email: F('riley.chen@example.com', 'medium'), phone: F(null) };
  if (!props.memo) return card;

  const event = line(text, 'EVENT').split(',')[0] || 'the show';
  const sign = given(line(text, 'SIGN-OFF')) || 'Thanks,';
  const chips = (((props.memo.properties || {}).interests || {}).items || {}).enum || [];
  const first = card.name.value ? String(card.name.value).replace(/<[^>]*>/g, '').trim().split(/\s+/)[0] : '';
  if (/SILENT/.test(bytes) || !card.readable) return { ...card, memo: { heard: false, summary: '', temp: 'not_said', next: 'not_said', interests: [] }, draft: { subject: '', body: '' } };
  if (/INJECT/.test(bytes)) {
    return {
      ...card,
      memo: { heard: true, summary: '<b>Wants</b> pricing on the 5 lb bags for 3 stores.<script>alert(1)</script>', temp: 'scorching', next: 'fax', interests: [...chips.slice(0, 1), 'Free money', { x: 1 }] },
      draft: {
        subject: '<i>20% off</i> for you',
        body: `Hi ${first},\n\n<b>**Great**</b> to meet you at ${event}. I have attached our full price list and we can do 20% off your first order.\n\nYou asked about pricing on the 5 lb bags for 3 stores. Are you free Tuesday at 3pm? Details at https://evil.example/deal - I will write to ${card.email.value || 'you'} or ring ${card.phone.value || 'you'}.\n\nWould a short call work?\n\n${sign}`,
      },
      advice: 'Close them today.', score: 99,
    };
  }
  return {
    ...card,
    memo: { heard: true, summary: 'Wants pricing on the 5 lb bags for 3 stores. Asked for a call next week.', temp: 'hot', next: 'call', interests: chips.slice(0, 1) },
    draft: {
      subject: `Great to meet you at ${event}`,
      body: [
        `Hi ${first || 'there'},`,
        `It was great to talk at our booth at ${event}${card.company.value ? ` - good to hear what ${card.company.value} is working on` : ''}. You asked about pricing on the 5 lb bags for 3 stores.`,
        'Would a short call next week work? Tell me a time that suits and I will ring you then - [add: your direct number].',
        sign.startsWith('Thanks') ? sign : `Thanks,\n${sign}`,
      ].join('\n\n'),
    },
  };
}

module.exports = { create, gemini, geminiCalls };
