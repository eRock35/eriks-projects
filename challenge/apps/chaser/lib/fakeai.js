// A stand-in Anthropic client for local runs and tests (CHASER_FAKE_AI=1).
//
// It answers both forced tools with a plausible, deterministic shape, so the
// whole product can be driven without a key and without spending anything.
// It is refused on Cloud Run: a deployment that quietly answered with canned
// chases would look like it works.
//
// Trigger words for tests:
//   INJECT       - the chase comes back with markup in it (proves clean())
//   a photo whose bytes contain BLANK - "not an invoice" (proves the 422)

if (process.env.CHASER_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('CHASER_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, usage) {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'fake',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: usage || { input_tokens: 900, output_tokens: 350 },
  };
}

const field = (text, key) => ((text.match(new RegExp(`^${key}: (.+)$`, 'm')) || [])[1] || '').trim();

function chase(params) {
  const text = params.messages[0].content;
  const stage = field(text, 'STAGE') || 'Friendly nudge';
  const first = (text.match(/greet them as "([^"]+)"/) || [])[1] || 'there';
  const number = field(text, 'INVOICE');
  const balance = field(text, 'BALANCE DUE');
  const due = field(text, 'DUE').replace(/ \(.*$/, '');
  const sign = (text.match(/"""\n([\s\S]*?)\n"""/) || [])[1] || 'Thanks';
  const link = field(text, 'PAYMENT LINK \\(include it exactly\\)');
  const promise = /BROKEN PROMISE: they promised to pay by ([^.]+?) and did not/.exec(text);
  const fee = /LATE FEE TO MENTION: (\S+)/.exec(text);
  const opener = {
    'Friendly nudge': `Hope you're well! Just a gentle reminder that invoice ${number} for ${balance} was due on ${due}.`,
    'Follow-up': `I'm following up on invoice ${number} for ${balance}, due on ${due}. Could you let me know when it will be paid?`,
    'Firm reminder': `Invoice ${number} for ${balance} is now well overdue. Please arrange payment within 7 days.`,
    'Final notice': `This is a final notice for invoice ${number} (${balance}, due ${due}). If it is not paid within 7 days I will pause further work.`,
    'Payment plan offer': `Would it help to split the ${balance} on invoice ${number} into a few smaller payments? Tell me what works.`,
  }[stage] || `A reminder about invoice ${number} for ${balance}.`;
  const body = [
    `Hi ${first},`,
    opener + (promise ? ` You'd said it would be paid by ${promise[1]}, so I wanted to check in.` : ''),
    fee ? `Per our terms a late fee of ${fee[1]} now applies.` : '',
    link ? `You can pay here: ${link}` : '',
    /INJECT/.test(text) ? '<script>alert(1)</script>Thanks for sorting this <b>quickly</b>.' : '',
    sign,
  ].filter(Boolean).join('\n\n');
  return toolUse('write_chase', {
    subject: `${stage === 'Final notice' ? 'Final notice' : 'Reminder'}: invoice ${number}${/INJECT/.test(text) ? ' <img src=x onerror=alert(1)>' : ''}`,
    body,
    sms: `Hi ${first}, ${stage === 'Friendly nudge' ? 'quick reminder' : 'following up'}: invoice ${number} (${balance}) was due ${due}.${link ? ` ${link}` : ''}`,
  });
}

function read(params) {
  const img = params.messages[0].content.find((b) => b.type === 'image');
  const bytes = img ? Buffer.from(img.source.data, 'base64').toString('latin1') : '';
  if (/BLANK/.test(bytes)) {
    return toolUse('read_invoice', { readable: false, clientName: '', invoiceNumber: '', amount: '', currency: '', issued: '', due: '', terms: '' }, { input_tokens: 1300, output_tokens: 60 });
  }
  return toolUse('read_invoice', {
    readable: true,
    clientName: 'Harbor & Pine <Design>',
    clientEmail: 'accounts@harborpine.example',
    invoiceNumber: 'HP-2291',
    amount: '$3,480.00',
    currency: 'USD',
    issued: '2026-08-14',
    due: '2026-09-13',
    terms: 'Net 30',
    summary: 'Brand refresh - phase 2',
  }, { input_tokens: 1500, output_tokens: 140 });
}

function create() {
  return {
    messages: {
      async create(params) {
        const name = params.tool_choice && params.tool_choice.name;
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        await new Promise((r) => setTimeout(r, Number(process.env.CHASER_FAKE_DELAY_MS || 0)));
        if (name === 'write_chase') return chase(params);
        if (name === 'read_invoice') return read(params);
        throw new Error(`fake ai: no answer for ${name}`);
      },
    },
  };
}

module.exports = { create };
