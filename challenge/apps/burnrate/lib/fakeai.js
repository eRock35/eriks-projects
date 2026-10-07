// A stand-in Anthropic client for local runs and tests (BURNRATE_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so "Write our fixes" can
// be driven without a key and without spending anything. It is refused on
// Cloud Run: a deployment that gave every team the same advice would look
// like it works.
//
// It records every request it was sent (`calls`), so a test can prove what
// reached "the model" - and what did not.
//
// Triggers, in the request text (a file name in the summary):
//   BLANK        an answer with nothing usable in it - a 422
//   INJECT       hostile output: markup, bidi, huge strings, 40 lines,
//                settings with missing fields
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - fixes aimed at the first finding

if (process.env.BURNRATE_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('BURNRATE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name: 'propose_fixes', input }],
    usage: { input_tokens: 900, output_tokens: 380 },
    ...(extra || {}),
  };
}

function answer(text) {
  if (/BLANK/.test(text)) return toolUse({ claudeMd: ['   ', 7], settings: [{ setting: 'x' }], habits: [] });
  if (/INJECT/.test(text)) {
    return toolUse({
      claudeMd: [`<script>alert(1)</script>Pipe‮ logs through tail ${'A'.repeat(900)}`, '<img src=x onerror=alert(1)>Read by range', ...Array(40).fill('Keep sessions short.')],
      settings: [{ setting: '<b>/compact</b>', value: 'at 150K', why: 'Context bloat cost <i>the most</i>.' }, { setting: 'model' }, 'nope', { setting: '/clear', value: { x: 1 }, why: 'ok' }],
      habits: [{ evil: true }, 'Take breaks after a /compact, not before.'],
    });
  }
  if (/MAXTOKENS/.test(text)) return toolUse({ claudeMd: ['Half'], settings: [], habits: [] }, { stop_reason: 'max_tokens' });
  const m = /"kind":"([a-z]+)"/.exec(text);
  const first = m ? m[1] : 'bloat';
  return toolUse({
    claudeMd: [
      'Pipe long command output through `| tail -40`; never print full test logs or lockfiles.',
      'Read files by range (offset/limit) and do not re-read a file you have not changed.',
      'If the same command fails twice, stop and explain the likely cause before retrying.',
    ],
    settings: [
      { setting: '/compact', value: 'when a session passes ~150K tokens', why: `The biggest finding (${first}) comes from long sessions carrying their whole history.` },
      { setting: 'model (subagent definition)', value: 'sonnet', why: 'Exploring subagents mostly read and search.' },
    ],
    habits: ['Run /clear between unrelated tasks.', 'Finish the step, or /compact, before a break longer than five minutes.'],
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
        await new Promise((r) => setTimeout(r, Number(process.env.BURNRATE_FAKE_DELAY_MS || 0)));
        const text = ((params.messages && params.messages[0] && params.messages[0].content) || []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = text.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'propose_fixes') return answer(text);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
