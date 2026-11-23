// A stand-in Anthropic client for local runs and tests (CHASER_FAKE_AI=1).
//
// It answers both forced tools with a plausible, deterministic shape, so the
// whole product can be driven without a key and without spending anything.
// It is refused on Cloud Run: a deployment that quietly answered with canned
// chases would look like it works.
//
// Trigger words for tests:
//   INJECT       - the subjects and one chase come back with markup in them
//   BADDEADLINE, BADFEE, BADTHREAT, BADSLOT, ALLBAD - see chase()
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

// Three versions of the step, every fact a {slot} - the shape the real tool
// asks for. Trigger words anywhere in the request (the tests put them in the
// voice sample) make one version break a rule, so the server's check is seen
// to drop it: BADDEADLINE (a made-up day), BADFEE (a made-up fee), BADTHREAT
// (a legal threat), BADSLOT (a slot the invoice lacks), ALLBAD (all three).
function chase(params) {
  const text = params.messages[0].content;
  const stage = field(text, 'STEP') || 'Friendly nudge';
  const offered = (k) => text.includes(`\n{${k}} - `);
  const promise = offered('promise_date');
  const fee = /^LATE FEE: mention it/m.test(text);
  const link = offered('payment_link');
  const late = offered('days_overdue');
  const ask = {
    'Friendly nudge': 'It may simply have slipped through.',
    'Follow-up': 'Could you let me know when it will be paid?',
    'Firm reminder': 'Please arrange payment within 7 days, and tell me if something is wrong.',
    'Final notice': 'If it is not paid within 7 days I will pause further work and take further steps to recover it.',
    'Payment plan offer': 'Would it help to split it into a few smaller payments? Tell me what works.',
  }[stage] || 'Could you take a look?';
  const tail = [
    promise ? "You'd said it would be paid by {promise_date}, so I wanted to check in." : '',
    fee ? 'Per our terms a late fee of {late_fee} now applies, making {total_with_fee}.' : '',
    link ? 'You can pay here:\n{payment_link}' : '',
  ];
  const body = (lines) => lines.concat(tail).filter(Boolean).join('\n\n');
  const inject = /INJECT/.test(text) ? '\n\n<script>alert(document.cookie)</script>Thanks for sorting this <b>quickly</b>.' : '';
  const final = stage === 'Final notice';
  const subject = `${final ? 'Final notice' : 'Reminder'}: invoice {invoice_number}${/INJECT/.test(text) ? ' <img src=x onerror=alert(1)>' : ''}`;
  const bad = (word) => new RegExp(`${word}|ALLBAD`).test(text);
  const options = [
    {
      angle: 'warm',
      subject,
      body: body(['Hi {first_name},', `Hope you're well! ${final ? 'This is a final notice for' : 'A reminder about'} invoice {invoice_number} for {balance}, which was due on {due_date}. ${ask}${bad('BADDEADLINE') ? ' Please pay by Friday.' : ''}`]) + inject,
      sms: `Hi {first_name}, ${stage === 'Friendly nudge' ? 'quick reminder' : 'following up'}: invoice {invoice_number} ({balance}) was due {due_date}.${link ? ' {payment_link}' : ''}`,
    },
    {
      angle: 'plain',
      subject,
      body: body(['Hi {first_name},', `Invoice {invoice_number} for {balance} was due on {due_date}${late ? ' and is now {days_overdue} overdue' : ''}. ${ask}${bad('BADFEE') ? ' A 5% late fee will be added.' : ''}${bad('BADSLOT') ? ' Our reference is {bank_account}.' : ''}`]),
      sms: 'Hi {first_name}, invoice {invoice_number} ({balance}) is still open. When can I expect payment?',
    },
    {
      angle: 'brief',
      subject,
      body: body(['{first_name},', `{balance} on invoice {invoice_number} is still open. ${ask}${bad('BADTHREAT') ? ' Otherwise we will take legal action.' : ''}`]),
      sms: '{first_name}, {balance} on invoice {invoice_number} is still open.',
    },
  ];
  return toolUse('write_chase', { options }, { input_tokens: 700, output_tokens: 520 });
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
        // A stand-in provider failure, for the tests: UPSTREAM401 anywhere in
        // the messages throws what the SDK would, raw JSON and all.
        const up = JSON.stringify(params.messages || '').match(/UPSTREAM(\d{3})/);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
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
