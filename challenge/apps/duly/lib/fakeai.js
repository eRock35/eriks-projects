// A stand-in Anthropic client for local runs and tests (DULY_FAKE_AI=1).
//
// It answers the forced tool deterministically, so "Read a statement" can be
// driven without a key and without spending anything. It is refused on
// Cloud Run: a deployment that read the same bill for everyone would look
// like it works and be useless.
//
// It reads a pasted bill the dumb way - the first line is the payee, the
// first $ amount is the amount, the first YYYY-MM-DD after "due" is the due
// date, "autopay" anywhere means on - and a photo as a fixed made-up bill.
// Triggers, in the text:
//   BLANK        nothing usable came back - a 422
//   INJECT       hostile output: markup, bidi, account and card numbers in
//                every field, an accountNumber key, an unknown category,
//                impossible dates and amounts
//   LEAK         a payee carrying a card number and an "acct #"
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does

if (process.env.DULY_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('DULY_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 820, output_tokens: 140 },
    ...(extra || {}),
  };
}

function readText(source) {
  const body = (/<<<BILL\n([\s\S]*)\nBILL>>>/.exec(source) || [])[1] || source;
  if (/BLANK/.test(body)) return toolUse('record_bill', { payee: '', category: 'other', amount: null, dueDate: '', statementDate: '', autopay: 'unknown' });
  if (/INJECT/.test(body)) {
    return toolUse('record_bill', {
      payee: '<img src=x onerror=alert(1)>City‮ Power 4111 1111 1111 1111',
      category: '<script>',
      amount: '$99,999,999,999',
      minimumDue: -5,
      dueDate: '2099-13-45',
      statementDate: 'yesterday',
      autopay: 'definitely',
      accountNumber: '123456789012',
      routingNumber: '021000021',
    });
  }
  if (/MAXTOKENS/.test(body)) return toolUse('record_bill', { payee: 'x' }, { stop_reason: 'max_tokens' });
  if (/LEAK/.test(body)) {
    return toolUse('record_bill', { payee: 'Harbor Card acct # 5500 0000 0000 0004', category: 'card', amount: 642.1, minimumDue: 35, dueDate: '', statementDate: '', autopay: 'on' });
  }
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const amount = (/\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(body) || [])[1];
  const due = (/due[^\d]{0,40}(\d{4}-\d{2}-\d{2})/i.exec(body) || [])[1] || '';
  const stmt = (/statement date[^\d]{0,20}(\d{4}-\d{2}-\d{2})/i.exec(body) || [])[1] || '';
  return toolUse('record_bill', {
    payee: lines[0] || '',
    category: /power|electric/i.test(body) ? 'electric' : 'other',
    amount: amount ? Number(amount.replace(/,/g, '')) : null,
    minimumDue: null,
    dueDate: due,
    statementDate: stmt,
    autopay: /autopay|automatic payment/i.test(body) ? (/not enrolled|autopay:\s*off/i.test(body) ? 'off' : 'on') : 'unknown',
  });
}

function create() {
  const calls = [];
  const seen = [];
  return {
    calls,
    seen,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        seen.push(JSON.stringify(params.messages));
        await new Promise((r) => setTimeout(r, Number(process.env.DULY_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const source = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = source.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name !== 'record_bill') throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
        if (content.some((b) => b.type === 'image')) {
          return toolUse('record_bill', { payee: 'Sample Power Co', category: 'electric', amount: 87.42, minimumDue: null, dueDate: '', statementDate: '', autopay: 'unknown' });
        }
        return readText(source);
      },
    },
  };
}

module.exports = { create };
