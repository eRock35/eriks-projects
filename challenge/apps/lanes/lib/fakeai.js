// A stand-in Anthropic client for local runs and tests (LANES_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so "Split this into
// lanes for me" can be driven without a key and without spending anything.
// It is refused on Cloud Run: a deployment that gave every team the same
// lanes would look like it works.
//
// It records every request it was sent (`calls`), so a test can prove what
// reached "the model" - and what did not.
//
// Triggers, in a task's text:
//   BLANK        an answer with nothing usable in it - a 422
//   INJECT       hostile output: markup, bidi, made-up paths, 40 lanes
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - one lane per task, owning folders whose names share a
//   word with it (or a new folder under src/), plus rules for lockfiles

if (process.env.LANES_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('LANES_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name: 'propose_lanes', input }],
    usage: { input_tokens: 2400, output_tokens: 520 },
    ...(extra || {}),
  };
}

function section(text, head) {
  const at = text.indexOf(head);
  if (at === -1) return [];
  const rest = text.slice(at + head.length).split('\n').slice(1);
  const out = [];
  for (const l of rest) { if (!l.trim()) break; out.push(l); }
  return out;
}

const STOP = new Set(['with', 'from', 'that', 'this', 'into', 'list', 'page', 'make', 'build', 'polish', 'and', 'the']);
function answer(text) {
  const tasks = section(text, 'Tasks (one per line):');
  const paths = section(text, 'Files (').concat(section(text, 'Folders, summarised').map((l) => `${l.split('\t')[0]}/x`));
  if (tasks.some((t) => /BLANK/.test(t))) return toolUse({ lanes: [{ name: '', task: '', owns: ['made/up/**'], readOnly: [], notes: '' }], hotspots: [] });
  if (tasks.some((t) => /INJECT/.test(t))) {
    return toolUse({
      lanes: [
        { name: '<img src=x onerror=alert(1)>Billing‮', task: `<script>alert(1)</script>Do billing ${'A'.repeat(900)}`, owns: ['src/**', 'nowhere/at/all/**', '../../etc/passwd', 42, '<b>src</b>'], readOnly: ['src/lib/**'], notes: '<i>notes</i>' },
        ...Array(40).fill(0).map((_, i) => ({ name: `lane ${i}`, task: `Task ${i}`, owns: ['src/**'], readOnly: [], notes: '' })),
      ],
      hotspots: [{ path: 'package-lock.json', rule: '<b>Only</b> the lead.' }, { path: 'imaginary.lock', rule: 'x' }, 'nope'],
    });
  }
  if (tasks.some((t) => /MAXTOKENS/.test(t))) return toolUse({ lanes: [], hotspots: [] }, { stop_reason: 'max_tokens' });
  const dirs = [...new Set(paths.map((p) => p.split('/').slice(0, -1).join('/')).filter(Boolean))];
  const hasSrc = dirs.some((d) => d === 'src' || d.startsWith('src/'));
  const taken = new Set();
  const lanes = tasks.map((t, i) => {
    const words = t.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !STOP.has(w));
    const owns = [];
    for (const d of dirs) {
      const last = d.split('/').pop().toLowerCase();
      if (words.some((w) => last.startsWith(w.slice(0, 5)) || w.startsWith(last.slice(0, 5))) && !taken.has(d)) { owns.push(`${d}/**`); taken.add(d); }
    }
    if (!owns.length && hasSrc && words[0]) owns.push(`src/${words[0]}/**`);
    owns.push('nowhere/at/all/**');
    return { name: words.slice(0, 2).join('-') || `lane-${i + 1}`, task: t, owns, readOnly: dirs.includes('src/lib') ? ['src/lib/**'] : [], notes: 'Ask the lead for any dependency.' };
  });
  const locks = paths.filter((p) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Gemfile\.lock|poetry\.lock|Cargo\.lock|go\.sum)$/.test(p));
  return toolUse({ lanes, hotspots: locks.map((p) => ({ path: p, rule: `Only the lead edits ${p}; ask for dependencies in the PR description.` })) });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(JSON.parse(JSON.stringify(params)));
        await new Promise((r) => setTimeout(r, Number(process.env.LANES_FAKE_DELAY_MS || 0)));
        const text = ((params.messages && params.messages[0] && params.messages[0].content) || []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = text.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'propose_lanes') return answer(text);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
