// A stand-in Anthropic client for local runs and tests (DRILL_FAKE_AI=1).
//
// It answers the forced tool deterministically, so "Make it about us" can be
// driven without a key and without spending anything. It is refused on
// Cloud Run: a deployment that wrote the same scenario for every business
// would look like it works and be useless.
//
// Triggers, in the business description:
//   BLANK        a scenario with no injects - a 422
//   BACKWARDS    a choice that goes back in time - a 422 (it would never end)
//   INJECT       hostile output: markup, bidi and huge text in every field,
//                unknown roles and items mixed in where cleaning can drop them
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - a valid seven-inject scenario naming the first tool listed

if (process.env.DRILL_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('DRILL_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

const Core = require('../public/drill-core');

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 2400, output_tokens: 3100 },
    ...(extra || {}),
  };
}

/** A built-in, in the tool's own shape (hits as a list), renamed. */
function fromBuiltin(id, tool, hostile) {
  const s = Core.scenarioById(id);
  const h = (t) => (hostile ? `<img src=x onerror=alert(1)>${t}‮ "><svg onload=alert(1)>${'x'.repeat(hostile === 'huge' ? 5000 : 0)}` : t);
  return {
    title: h(`When ${tool} goes down on launch day`),
    blurb: h(`Your ${tool} store is down an hour before the big launch.`),
    emoji: hostile ? '<script>' : '🛒',
    start: s.start,
    injects: s.injects.slice(0, 7).map((inj, n, list) => ({
      id: inj.id,
      at: inj.at,
      to: inj.to,
      title: h(inj.title),
      text: h(n === 0 ? `${inj.text} It is the ${tool} storefront.` : inj.text),
      tests: hostile ? inj.tests.concat(['not_an_item']) : inj.tests,
      choices: inj.choices.map((ch) => ({
        text: h(ch.text),
        then: h(ch.then),
        next: list.some((x) => x.id === ch.next) ? ch.next : 'end',
        hits: Object.keys(ch.hits).map((item) => ({ item, points: ch.hits[item] })).concat(hostile ? [{ item: 'made_up', points: 2 }, { item: inj.tests[0], points: 7 }] : []),
      })),
    })),
  };
}

function scenario(source) {
  const tool = ((/<<<TOOLS\n([^,\n]+)/.exec(source) || [])[1] || 'online').trim().slice(0, 30);
  if (/BLANK/.test(source)) return toolUse('record_scenario', { title: 'Nothing', blurb: 'Nothing here.', emoji: '🧯', start: { day: 0, time: '09:00' }, injects: [] });
  if (/BACKWARDS/.test(source)) {
    const s = fromBuiltin('outage', tool);
    s.injects[3].choices[0].next = s.injects[0].id;
    return toolUse('record_scenario', s);
  }
  if (/INJECT/.test(source)) return toolUse('record_scenario', fromBuiltin('outage', tool, 'huge'));
  if (/MAXTOKENS/.test(source)) return toolUse('record_scenario', { title: 'Cut off' }, { stop_reason: 'max_tokens' });
  return toolUse('record_scenario', fromBuiltin('outage', tool));
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        await new Promise((r) => setTimeout(r, Number(process.env.DRILL_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const source = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = source.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'record_scenario') return scenario(source);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
