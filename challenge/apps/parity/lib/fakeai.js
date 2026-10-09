// A stand-in Anthropic client for local runs and tests (PARITY_FAKE_AI=1).
//
// It answers the one forced tool deterministically - with Parity's own
// name-based auto-map, plus the rules the types make obvious - so "Suggest
// the mapping and rules" can be driven without a key and without spending
// anything. It is refused on Cloud Run: a deployment that answered every table
// with the free auto-map would look like it works.
//
// It records every request it was sent (`calls`), so a test can prove what
// reached "the model" - and what did not.
//
// Triggers, in a column name:
//   BLANK        an answer with nothing usable in it - a 422
//   INJECT       hostile output: markup, bidi, unknown columns, made-up rules
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does

if (process.env.PARITY_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('PARITY_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

const Core = require('../public/parity-core');

function toolUse(input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name: 'propose_mapping', input }],
    usage: { input_tokens: 1200, output_tokens: 420 },
    ...(extra || {}),
  };
}

function answer(text) {
  const json = text.split('\n')[1] || '{}';
  let req = {};
  try { req = JSON.parse(json); } catch (e) { req = {}; }
  const before = (req.before && req.before.columns) || [];
  const after = (req.after && req.after.columns) || [];
  if (/BLANK/.test(text)) return toolUse({ pairs: [{ from: ['nope'], to: ['nada'], rules: [], why: '' }], key: [] });
  if (/INJECT/.test(text)) {
    return toolUse({
      pairs: [
        { from: [before[0] && before[0].name], to: [after[0] && after[0].name], rules: [{ rule: 'eval', code: 'process.exit()' }, { rule: 'date', from: '%Y', to: 'YYYY-MM-DD' }, { rule: 'trim' }], why: '<img src=x onerror=alert(1)>Same ‮name ' + 'A'.repeat(900) },
        { from: ['not_a_column'], to: [after[1] && after[1].name], rules: [], why: 'invented' },
        'nonsense',
      ],
      key: ['<script>', after[0] && after[0].name],
    });
  }
  if (/MAXTOKENS/.test(text)) return toolUse({ pairs: [], key: [] }, { stop_reason: 'max_tokens' });
  const m = Core.automap(before, after);
  const bBy = Object.fromEntries(before.map((c) => [c.name, c]));
  const aBy = Object.fromEntries(after.map((c) => [c.name, c]));
  const pairs = m.pairs.map((p) => {
    const b = bBy[p.from[0]] || {};
    const a = p.to.length === 1 ? (aBy[p.to[0]] || {}) : {};
    const rules = [];
    if (b.format && a.format && b.format !== a.format) rules.push({ rule: 'date', from: b.format, to: a.format });
    if (b.type === 'int' && a.type === 'decimal' && /cent/i.test(p.from[0])) rules.push({ rule: 'scale', op: 'div100' });
    return { from: p.from, to: p.to, rules, why: p.to.length > 1 ? 'One name split into two columns.' : `Similar names (${p.conf}).` };
  });
  const key = Core.suggestKey(m.pairs, before.map((c) => ({ rows: req.before.rows, ...c })), after.map((c) => ({ rows: req.after.rows, ...c })));
  return toolUse({ pairs, key });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(JSON.parse(JSON.stringify(params)));
        await new Promise((r) => setTimeout(r, Number(process.env.PARITY_FAKE_DELAY_MS || 0)));
        const text = ((params.messages && params.messages[0] && params.messages[0].content) || []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = text.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'propose_mapping') return answer(text);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
