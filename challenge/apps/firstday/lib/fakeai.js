// A stand-in Anthropic client for local runs and tests (FIRSTDAY_FAKE_AI=1).
//
// It answers the forced tool with a small, deterministic plan built from the
// closest template and a few words of the description, so "Tailor it to us"
// can be driven without a key and without spending anything. Refused on
// Cloud Run: a deployment that "tailored" plans from a template would look
// like it works and be wrong.
//
// Triggers anywhere in the description:
//   BLANK        too few tasks - a 422
//   INJECT       hostile output: markup and bidi in titles, a made-up owner,
//                an offset out of range, a string offset, a time on day 3, a
//                salary and an ID number in titles, a duplicate check-in
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does

if (process.env.FIRSTDAY_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('FIRSTDAY_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

const Core = require('../public/firstday-core');

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1200, output_tokens: 900 },
    ...(extra || {}),
  };
}

function answer(source) {
  if (/MAXTOKENS/.test(source)) return toolUse('propose_plan', { tasks: [] }, { stop_reason: 'max_tokens' });
  if (/BLANK/.test(source)) return toolUse('propose_plan', { tasks: [{ title: 'Say hello', owner: 'manager', offset: 0 }] });
  const label = (/Closest built-in template: ([^(]+)\(/.exec(source) || [])[1] || '';
  const id = Object.keys(Core.TEMPLATES).find((k) => Core.TEMPLATES[k].label === label.trim()) || 'office';
  const about = (/<<<ABOUT\n([\s\S]*?)\nABOUT>>>/.exec(source) || [])[1] || '';
  const role = (/The role: (.+)\./.exec(source) || [])[1] || 'the role';
  const tasks = Core.TEMPLATES[id].tasks.map((t) => ({ title: t.title, owner: t.owner, offset: t.offset, unit: t.unit, ...(t.time ? { time: t.time } : {}), ...(t.miss ? { miss: t.miss } : {}), ...(t.checkin ? { checkin: t.checkin } : {}) }));
  // "Tailoring": one task per tool or thing the description names.
  const things = (about.match(/\b(?:uses?|using|with) ([A-Za-z][A-Za-z0-9 ]{2,24})/g) || []).slice(0, 3);
  things.forEach((m, i) => tasks.splice(14 + i, 0, { title: `Walk through ${m.replace(/^\w+ /, '')} together`, owner: 'buddy', offset: 1 + i }));
  tasks.splice(1, 0, { title: `Write down what a great first month as ${role} looks like`, owner: 'manager', offset: -6, miss: 'first month not written' });
  if (/INJECT/.test(source)) {
    tasks.push({ title: '<img src=x onerror=alert(1)>Meet the ‮team', owner: 'manager', offset: 2 });
    tasks.push({ title: 'Made-up owner', owner: 'ceo', offset: 1 });
    tasks.push({ title: 'Too far out', owner: 'manager', offset: 400 });
    tasks.push({ title: 'String offset', owner: 'manager', offset: '3' });
    tasks.push({ title: 'Timed on day 3', owner: 'hire', offset: 2, time: '10:00' });
    tasks.push({ title: 'Confirm salary of $48,000', owner: 'manager', offset: -3 });
    tasks.push({ title: 'Record their SSN 123-45-6789', owner: 'it', offset: -3 });
    tasks.push({ title: 'Second day-5 check-in', owner: 'manager', offset: 4, checkin: 'd5' });
    tasks.push({ title: 'x'.repeat(400), owner: 'hire', offset: 1 });
    for (let i = 0; i < 30; i++) tasks.push({ title: `Filler ${i}`, owner: 'hire', offset: 3 });
  }
  return toolUse('propose_plan', { summary: /INJECT/.test(source) ? '<b>Tailored</b> ‮for you' : `Tailored for ${role}: the tools you named, and a first-month picture before day 1.`, tasks });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        await new Promise((r) => setTimeout(r, Number(process.env.FIRSTDAY_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const source = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = source.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'propose_plan') return answer(source);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
