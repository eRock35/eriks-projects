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

/**
 * The stand-in for Gemini (DULY_AI_PROVIDER=gemini): given the request the
 * guard's helper would send, the four fields the schema asks for. A photo is
 * a fixed made-up card statement due twelve days from the request's "today";
 * text is read the dumb way. Triggers in the text: BLANK, INJECT (hostile
 * values and invented keys), UPSTREAMnnn.
 */
async function gemini(body) {
  await new Promise((r) => setTimeout(r, Number(process.env.DULY_FAKE_DELAY_MS || 0)));
  const parts = (body && body.contents && body.contents[0] && body.contents[0].parts) || [];
  const source = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n');
  const today = (/Today is (\d{4}-\d{2}-\d{2})/.exec(source) || [])[1] || '2026-01-01';
  if (parts.some((p) => p.inlineData)) {
    const due = new Date(Date.parse(`${today}T00:00:00Z`) + 12 * 86400000).toISOString().slice(0, 10);
    return { dueDate: due, amountDue: 868.4, minimumDue: 35, autopay: 'on' };
  }
  const text = (/<<<BILL\n([\s\S]*)\nBILL>>>/.exec(source) || [])[1] || source;
  const hit = text.match(/UPSTREAM(\d{3})/);
  if (hit) throw Object.assign(new Error(`Gemini answered ${hit[1]}. stand-in provider failure`), { name: 'VertexError', code: 'http', status: Number(hit[1]) });
  if (/BLANK/.test(text)) return { dueDate: '', amountDue: null, minimumDue: null, autopay: 'not_stated' };
  if (/INJECT/.test(text)) {
    return { dueDate: '<img src=x onerror=alert(1)>', amountDue: '4111 1111 1111 1111', minimumDue: -5, autopay: 'definitely', payee: 'Harbor Card 4111 1111 1111 1111', accountNumber: '123456789012', note: '<script>x</script>' };
  }
  const amount = (/\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(text) || [])[1];
  const min = (/minimum[^$\d]{0,30}\$\s?([\d,]+(?:\.\d{1,2})?)/i.exec(text) || [])[1];
  return {
    dueDate: (/due[^\d]{0,40}(\d{4}-\d{2}-\d{2})/i.exec(text) || [])[1] || '',
    amountDue: amount ? Number(amount.replace(/,/g, '')) : null,
    minimumDue: min ? Number(min.replace(/,/g, '')) : null,
    autopay: /autopay|automatic payment/i.test(text) ? (/not enrolled|autopay:\s*off/i.test(text) ? 'off' : 'on') : 'not_stated',
  };
}

module.exports = { create, gemini };
