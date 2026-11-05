// A stand-in Anthropic client for local runs and tests (FEEDFIX_FAKE_AI=1).
//
// It answers the one forced tool deterministically from the column names and
// shape codes it is sent, so "Help me read these columns" can be driven
// without a key and without spending anything. It is refused on Cloud Run: a
// deployment that gave everyone the same canned mapping would look like it
// works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not (no value, no
// amount, no payee).
//
// A test sets `fake.mode` for one call:
//   'blank'        nothing placed - a 422
//   'inject'       hostile output: unknown fields, a column out of range, a
//                  column used twice, amount together with debit and
//                  credit, a confidence not on the list, markup and a link
//                  in the note - and a few clean entries, which are all that
//                  may come back
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.FEEDFIX_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('FEEDFIX_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 600, output_tokens: 200 },
    ...(extra || {}),
  };
}

/** A plausible mapping from the words it was sent. */
function readColumns(text) {
  const body = ((/<<<COLUMNS\n([\s\S]*?)\nCOLUMNS>>>/.exec(text) || [])[1]) || '';
  const cols = body.split('\n').map((l) => {
    const m = /^(\d+)\. "(.*)" - (.*)$/.exec(l);
    return m ? { n: Number(m[1]), header: m[2].toLowerCase(), shape: m[3].toLowerCase() } : null;
  }).filter(Boolean);
  const used = {};
  const mapping = [];
  const place = (field, test, confidence) => {
    if (mapping.some((x) => x.field === field)) return;
    const c = cols.find((x) => !used[x.n] && test(x));
    if (c) { used[c.n] = 1; mapping.push({ column: c.n, field, confidence }); }
  };
  place('date', (c) => /date/.test(c.header), 'high');
  place('date', (c) => /date-like/.test(c.shape), 'medium');
  place('balance', (c) => /balance/.test(c.header), 'high');
  place('debit', (c) => /debit|withdraw|money out|paid out/.test(c.header), 'high');
  place('credit', (c) => /credit|deposit|money in|paid in/.test(c.header), 'high');
  if (!mapping.some((x) => x.field === 'debit' || x.field === 'credit')) {
    place('amount', (c) => /\bamount\b|^value$/.test(c.header), 'high');
    place('amount', (c) => /negative/.test(c.shape) && /number|amount/.test(c.shape), 'medium');
  }
  place('payee', (c) => /payee|merchant|name/.test(c.header), 'medium');
  place('description', (c) => /desc|detail|memo|narrative/.test(c.header), 'high');
  place('description', (c) => /text, (1 to 4|5 or more) words/.test(c.shape), 'low');
  place('reference', (c) => /ref|check|cheque|number/.test(c.header), 'medium');
  place('type', (c) => /type/.test(c.header) || /words like debit/.test(c.shape), 'medium');
  cols.forEach((c) => { if (!used[c.n]) mapping.push({ column: c.n, field: 'ignore', confidence: 'medium' }); });
  return toolUse('read_columns', { mapping, note: 'Placed from the column names and shapes.' });
}

function inject(text) {
  const n = ((/<<<COLUMNS\n([\s\S]*?)\nCOLUMNS>>>/.exec(text) || [])[1] || '').split('\n').length;
  return toolUse('read_columns', {
    mapping: [
      { column: 1, field: 'date', confidence: 'high' },
      { column: 1, field: 'description', confidence: 'high' },
      { column: 2, field: 'password', confidence: 'high' },
      { column: n + 5, field: 'amount', confidence: 'high' },
      { column: 3, field: 'amount', confidence: 'certain' },
      { column: 4, field: 'debit', confidence: 'high' },
      { column: 0, field: 'credit', confidence: 'low' },
      { column: 1.5, field: 'balance', confidence: 'low' },
      'not an object',
      { column: 2, field: '<img src=x onerror=alert(1)>', confidence: 'high' },
    ],
    note: '<b>Click</b> https://evil.example/steal to confirm \u202E mapping',
    extra: 'hunter2',
  });
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
        await new Promise((r) => setTimeout(r, Number(process.env.FEEDFIX_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { mapping: [] });
        if (mode === 'inject') return inject(text);
        if (name === 'read_columns') return readColumns(text);
        throw new Error(`fake ai: no answer for ${name}`);
      },
    },
  };
  return fake;
}

module.exports = { create };
