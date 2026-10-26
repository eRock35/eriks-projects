// A stand-in Anthropic client for local runs and tests (REP_FAKE_AI=1).
//
// It answers the forced tool deterministically, so "Plan my next 4 weeks"
// can be driven without a key and without spending anything. It is refused
// on Cloud Run: a deployment that handed everyone the same plan would look
// like it works and be useless.
//
// It reads the brief the dumb way - the days a week, the allowed ids and the
// lifts in the history - and keeps everything it was sent in `seen`, so a
// test can prove what the model was (and was not) told. Triggers, in a
// custom lift's name:
//   BLANK        a plan with no days - a 422
//   INJECT       hostile output: markup, bidi and links in names, sets 99,
//                reps 0, pct 300, a negative weight, unknown keys, ten days,
//                twelve exercises, nine weeks, a machine on a barbell-only day
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does

if (process.env.REP_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('REP_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1400, output_tokens: 900 },
    ...(extra || {}),
  };
}

const WEEKS = (pct, w) => [
  { sets: 3, reps: 8, ...(pct ? { pct: 70 } : w ? { weight: w } : {}) },
  { sets: 3, reps: 6, ...(pct ? { pct: 75 } : w ? { weight: w + 2.5 } : {}) },
  { sets: 4, reps: 5, ...(pct ? { pct: 80 } : w ? { weight: w + 5 } : {}) },
  { sets: 2, reps: 5, ...(pct ? { pct: 65 } : w ? { weight: w } : {}) },
];

function answer(text) {
  if (/BLANK/.test(text)) return toolUse('plan_weeks', { summary: '', days: [] });
  if (/MAXTOKENS/.test(text)) return toolUse('plan_weeks', { summary: '', days: [] }, { stop_reason: 'max_tokens' });
  if (/INJECT/.test(text)) {
    const bad = { exercise: '<img src=x onerror=alert(1)>Squat‮ https://evil.example/x', rest: 99999, weeks: Array.from({ length: 9 }, () => ({ sets: 99, reps: 0, pct: 300, weight: -5, link: 'https://evil.example' })), note: '<script>x</script>' };
    const ok = { exercise: 'bench', rest: 120, weeks: WEEKS(true) };
    return toolUse('plan_weeks', {
      summary: 'Visit www.evil.example <b>now</b> javascript:alert(1)',
      link: 'https://evil.example',
      days: Array.from({ length: 10 }, (_, i) => ({
        name: i === 0 ? '<script>alert(1)</script>Upper https://evil.example' : `Day ${i}`,
        exercises: [bad, ok, ok, { exercise: 'leg-press', rest: 90, weeks: WEEKS(false, 100) }, { exercise: 'Totally made up thing www.evil.example', rest: 60, weeks: [{ sets: 3, reps: 10 }] }, ...Array.from({ length: 8 }, (_, j) => ({ exercise: `Extra move ${j}`, rest: 60, weeks: WEEKS(false) }))],
      })),
    });
  }
  const days = Number((/Days per week: (\d)/.exec(text) || [])[1] || 3);
  const allowed = ((/Allowed exercise ids: ([^\n]*)/.exec(text) || [])[1] || '').split('; ').map((x) => x.split(' (')[0]).filter(Boolean);
  const hist = [...text.matchAll(/^- ([a-z-]+) \(/gm)].map((m) => m[1]).filter((id) => allowed.includes(id));
  const withE1rm = new Set([...text.matchAll(/^- ([a-z-]+) \([^)]*\):[^\n]*e1RM/gm)].map((m) => m[1]));
  const pool = [...new Set([...hist, 'squat', 'bench', 'row', 'ohp', 'deadlift', 'goblet-squat', 'db-bench', 'db-row', 'push-up', 'pull-up', 'lunge'])].filter((id) => allowed.includes(id));
  const out = [];
  for (let d = 0; d < days; d++) {
    const picks = [0, 1, 2, 3].map((k) => pool[(d * 3 + k) % pool.length]).filter((v, i, a) => a.indexOf(v) === i);
    out.push({
      name: `Day ${'ABCDEF'[d]}`,
      exercises: picks.map((id) => ({ exercise: id, rest: 150, weeks: WEEKS(withE1rm.has(id), withE1rm.has(id) ? null : (/push-up|pull-up/.test(id) ? null : 20)) })),
    });
  }
  return toolUse('plan_weeks', { summary: 'Three building weeks, adding a little load each week, then a lighter fourth week to recover.', days: out });
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
        seen.push(JSON.stringify({ system: params.system, messages: params.messages }));
        await new Promise((r) => setTimeout(r, Number(process.env.REP_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = text.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name !== 'plan_weeks') throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
        return answer(text);
      },
    },
  };
}

module.exports = { create };
