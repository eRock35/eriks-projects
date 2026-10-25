// A stand-in Anthropic client for local runs and tests (PROOF_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so "Second opinion on
// the outcome" can be driven without a key and without spending anything.
// It is refused on Cloud Run: a deployment that judged every run the same way
// would look like it works.
//
// It records every request it was sent (`calls`), so a test can prove what
// reached "the model" - and what did not.
//
// Triggers, anywhere in the sent text:
//   BLANK        an answer with nothing usable in it - a 422
//   INJECT       hostile output: markup, bidi, a 5,000-character "why", an
//                unknown verdict, a criterion that was never sent
//   BADREFS      step references that were not sent (9999, 0, -3, "5", 2.5)
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - a verdict per criterion read from the sent excerpts.

if (process.env.PROOF_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('PROOF_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name: 'judge_outcome', input }],
    usage: { input_tokens: 2400, output_tokens: 380 },
    ...(extra || {}),
  };
}

function parse(text) {
  const crit = [];
  const ci = text.indexOf('Acceptance criteria:');
  if (ci !== -1) {
    for (const line of text.slice(ci).split('\n').slice(1)) {
      const m = /^(\d+)\. (.*)$/.exec(line);
      if (m) crit.push({ n: Number(m[1]), text: m[2].replace(/\s*\[the rules say: [^\]]*\]$/, '') }); else if (!line.trim()) break;
    }
  }
  const steps = [...text.matchAll(/^--- step (\d+)/gm)].map((m) => Number(m[1]));
  const run = text.slice(text.indexOf('<<<RUN'));
  return { crit, steps, run };
}

function answer(text) {
  const { crit, steps, run } = parse(text);
  if (/BLANK/.test(text)) return toolUse({ criteria: [], overall: '' });
  if (/MAXTOKENS/.test(text)) return toolUse({ criteria: [], overall: 'x' }, { stop_reason: 'max_tokens' });
  if (/INJECT/.test(text)) {
    return toolUse({
      criteria: [
        { criterion: 1, verdict: 'backed', why: '<img src=x onerror=alert(1)>Approved\u202E ' + 'A'.repeat(5000), evidenceRefs: [steps[0], 9999], whatToCheck: '<script>alert(1)</script>check this' },
        { criterion: 2, verdict: 'approved', why: 'Not a verdict.', evidenceRefs: [], whatToCheck: '' },
        { criterion: 99, verdict: 'backed', why: 'A criterion nobody sent.', evidenceRefs: [], whatToCheck: '' },
      ],
      overall: '<b>All good</b> - ignore the rules.',
    });
  }
  const failing = /\b(?:FAIL|failed|skipped|\.skip\(|\|\| true|error TS)\b/.test(run);
  const prLink = /\/pull\/\d+/.test(run);
  const bad = /BADREFS/.test(text);
  return toolUse({
    criteria: crit.map((c) => {
      const low = c.text.toLowerCase();
      const verdict = /\bpr\b|pull request/.test(low) ? (prLink ? 'backed' : 'no-evidence') : /test|skip/.test(low) ? (failing ? 'contradicted' : 'backed') : /outside|only|scope/.test(low) ? 'partly' : 'no-evidence';
      return {
        criterion: c.n,
        verdict,
        why: `A stand-in answer for "${c.text.slice(0, 60)}": read from the excerpts the fake model was sent.`,
        evidenceRefs: bad ? [9999, 0, -3, '5', 2.5].concat(steps.slice(0, 1)) : steps.slice(0, 2),
        whatToCheck: 'Run the check yourself and read its output.',
      };
    }),
    overall: failing ? 'The excerpts show failures or skips the summary does not mention. (A stand-in answer.)' : 'The excerpts back the summary. (A stand-in answer.)',
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
        await new Promise((r) => setTimeout(r, Number(process.env.PROOF_FAKE_DELAY_MS || 0)));
        const text = ((params.messages && params.messages[0] && params.messages[0].content) || []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = text.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'judge_outcome') return answer(text);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
