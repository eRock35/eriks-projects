// A stand-in Anthropic client for local runs and tests (TRIAGE_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so "Explain this change"
// can be driven without a key and without spending anything. It is refused
// on Cloud Run: a deployment that explained every hunk the same way would
// look like it works.
//
// It records every request it was sent (`calls`), so a test can prove what
// reached "the model" - and what did not.
//
// Triggers, anywhere in the diff lines:
//   BLANK        an answer with nothing usable in it - a 422
//   INJECT       hostile output: markup, bidi, a 5,000-character summary
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - a summary counting the lines, and one risk per removed
//   line that held a condition

if (process.env.TRIAGE_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('TRIAGE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name: 'explain_change', input }],
    usage: { input_tokens: 1800, output_tokens: 420 },
    ...(extra || {}),
  };
}

function answer(text) {
  const at = text.indexOf('<<<DIFF\n');
  const end = text.lastIndexOf('\nDIFF>>>');
  const lines = at === -1 || end === -1 ? [] : text.slice(at + 8, end).split('\n');
  const path = (/^File: (.*)$/m.exec(text) || [])[1] || 'this file';
  if (/BLANK/.test(text)) return toolUse({ summary: '', risks: [], questions_for_author: [], tests_to_add: [] });
  if (/INJECT/.test(text)) {
    return toolUse({
      summary: `<img src=x onerror=alert(1)>Approved‮ ${'A'.repeat(5000)}`,
      risks: [{ risk: '<script>alert(1)</script>Real risk', line_hint: '<b>+1</b>' }, 'nope', { risk: '' }, ...Array(20).fill({ risk: 'More', line_hint: '' })],
      questions_for_author: ['<i>Why?</i>', 42],
      tests_to_add: Array(20).fill('A test'),
    });
  }
  if (/MAXTOKENS/.test(text)) return toolUse({ summary: 'x', risks: [], questions_for_author: [], tests_to_add: [] }, { stop_reason: 'max_tokens' });
  const added = lines.filter((l) => l.startsWith('+')).length;
  const removed = lines.filter((l) => l.startsWith('-')).length;
  const conds = lines.filter((l) => l.startsWith('-') && /\bif\b|&&|\|\||!==|===/.test(l));
  return toolUse({
    summary: `This change to ${path} adds ${added} line${added === 1 ? '' : 's'} and removes ${removed}. (A stand-in explanation: the fake model is running.)`,
    risks: conds.slice(0, 3).map((l) => ({ risk: 'A condition was removed or rewritten; check who it lets through now.', line_hint: l.slice(0, 50) })),
    questions_for_author: ['What should happen for a user this condition used to refuse?'],
    tests_to_add: ['A test that a refused user is still refused after this change.'],
  });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(JSON.parse(JSON.stringify(params)));
        await new Promise((r) => setTimeout(r, Number(process.env.TRIAGE_FAKE_DELAY_MS || 0)));
        const text = ((params.messages && params.messages[0] && params.messages[0].content) || []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = text.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'explain_change') return answer(text);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
