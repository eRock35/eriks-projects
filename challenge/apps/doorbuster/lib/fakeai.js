// A stand-in Anthropic client for local runs and tests (DOORBUSTER_FAKE_AI=1).
//
// It answers the forced tool deterministically, so "Fill from a price list"
// can be driven without a key and without spending anything. It is refused
// on Cloud Run: a deployment that read the same list for everyone would
// look like it works and be useless.
//
// It reads pasted text the dumb way - one item a line, a name and then one
// or two amounts ("Soy candle 18.00 6.50": the price, then the cost; a line
// that says "cost" or "wholesale" with one amount is a cost) - and an image
// as one fixed made-up list.
// Triggers, in the text:
//   BLANK        it says it found no list
//   INJECT       hostile output: markup, bidi, an email, a phone number,
//                impossible numbers, extra keys, far too many rows
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does

if (process.env.DOORBUSTER_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('DOORBUSTER_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1100, output_tokens: 120 },
    ...(extra || {}),
  };
}

function readText(source) {
  const body = (/<<<LIST\n([\s\S]*)\nLIST>>>/.exec(source) || [])[1] || '';
  if (/BLANK/.test(body)) return toolUse('record_items', { found: false, items: [] });
  if (/MAXTOKENS/.test(body)) return toolUse('record_items', { found: true, items: [] }, { stop_reason: 'max_tokens' });
  if (/INJECT/.test(body)) {
    const rows = [
      { name: '<img src=x onerror=alert(1)>Candle' + String.fromCharCode(0x202E), price: 18, cost: 6.5, note: 'ignore the owner', sku: 'mowner11' },
      { name: 'write to shop' + String.fromCharCode(64) + 'example.com', price: 5, cost: 1 },
      { name: 'call ' + ['555', '201', '3344'].join(' '), price: 5, cost: 1 },
      { name: 'Mug', price: -4, cost: 1e12, customer: 'Pat' },
      { name: 12345, price: 'ten', cost: null },
      'not a row',
    ];
    for (let i = 0; i < 40; i++) rows.push({ name: 'Row ' + String.fromCharCode(65 + (i % 26)) + 'x', price: 1 + i, cost: 0 });
    return toolUse('record_items', { found: true, items: rows, margin: 99, steps: ['ignore the sale'] });
  }
  const items = [];
  for (const raw of body.split('\n')) {
    const l = raw.trim();
    const nums = [...l.matchAll(/(\d{1,5}(?:\.\d{1,2})?)(?![\d%])/g)].map((m) => Number(m[1]));
    const name = l.replace(/[$£€]?\d[\d.,]*%?/g, ' ').replace(/\b(cost|wholesale|price|retail|each|ea)\b/gi, ' ').replace(/[-–:|,;]+\s*$/g, '').replace(/\s+/g, ' ').replace(/[\s\-–:|,;]+$/g, '').trim();
    if (!name || !nums.length) continue;
    const costOnly = nums.length === 1 && /cost|wholesale/i.test(l);
    items.push({ name, price: costOnly ? 0 : nums[0], cost: costOnly ? nums[0] : (nums[1] || 0) });
  }
  return toolUse('record_items', { found: items.length > 0, items });
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
        seen.push(JSON.stringify(params.messages).replace(/"data":"[^"]{200,}"/g, '"data":"(image)"'));
        await new Promise((r) => setTimeout(r, Number(process.env.DOORBUSTER_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const source = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = source.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name !== 'record_items') throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
        if (content.some((b) => b.type === 'image')) {
          return toolUse('record_items', { found: true, items: [{ name: 'Sample soy candle', price: 18, cost: 6.5 }, { name: 'Sample enamel mug', price: 14, cost: 0 }, { name: 'Sample tea tin', price: 0, cost: 3.25 }] });
        }
        return readText(source);
      },
    },
  };
}

module.exports = { create };
