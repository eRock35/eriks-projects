// A stand-in Anthropic client for local runs and tests (ROTA_FAKE_AI=1).
//
// It answers the forced tool with a small, deterministic reading of the
// messages, so "Read their texts" can be driven without a key and without
// spending anything. Refused on Cloud Run: a deployment that "read" texts
// with a dozen regular expressions would look like it works and be wrong.
//
// Each message line is "Name: what they said". It understands "can't
// <day>", "prefer not <day>", "<day> after 4", "any day", "no closes",
// "max 20 hours". Triggers anywhere in the text:
//   BLANK        nobody recorded - a 422
//   INJECT       hostile output: markup and bidi in notes, a made-up name,
//                a made-up day, a bad state and times backwards
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does

if (process.env.ROTA_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('ROTA_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FULL = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/gi;

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 900, output_tokens: 400 },
    ...(extra || {}),
  };
}
const dayOf = (w) => DAYS.findIndex((d) => d.toLowerCase() === w.slice(0, 3).toLowerCase());
function hour(h, ampm) {
  let n = Number(h);
  if (ampm === 'am' && n === 12) n = 0;
  else if (ampm !== 'am' && n < 12 && (ampm === 'pm' || n <= 7)) n += 12; // "after 4" means the afternoon
  return `${String(n).padStart(2, '0')}:00`;
}
function readLine(line) {
  const days = {};
  const set = (i, v) => { if (i >= 0) days[DAYS[i]] = { day: DAYS[i], ...v }; };
  const low = line.toLowerCase();
  if (/any day|every day|all week/.test(low)) DAYS.forEach((d, i) => set(i, { state: 'can' }));
  if (/weekdays/.test(low)) [0, 1, 2, 3, 4].forEach((i) => set(i, { state: /can'?t|cannot|not/.test(low) ? 'cant' : 'can' }));
  for (const part of low.split(/[,;.]|\bbut\b|\band\b/)) {
    const ds = [...part.matchAll(FULL)].map((m) => dayOf(m[1]));
    if (!ds.length) continue;
    const after = /after (\d{1,2})\s*(am|pm)?/.exec(part);
    const until = /(?:until|till|before) (\d{1,2})\s*(am|pm)?/.exec(part);
    let state = 'can';
    if (/can'?t|cannot|can’t|\bnot\b|\boff\b|\bno\b/.test(part) && !/rather not|prefer not/.test(part)) state = 'cant';
    if (/rather not|prefer not|if you have to/.test(part)) state = 'prefer';
    for (const i of ds) set(i, { state, ...(after && state !== 'cant' ? { from: hour(after[1], after[2]) } : {}), ...(until && state !== 'cant' ? { to: hour(until[1], until[2]) } : {}) });
  }
  const max = /max(?:imum)? (\d{1,2})\s*h/.exec(low) || /(\d{1,2}) hours? max/.exec(low);
  return { days: Object.values(days), noCloses: /no clos/.test(low), maxHours: max ? Number(max[1]) : undefined };
}

function answer(source, names) {
  if (/BLANK/.test(source)) return toolUse('record_availability', { people: [] });
  if (/MAXTOKENS/.test(source)) return toolUse('record_availability', { people: [] }, { stop_reason: 'max_tokens' });
  const body = (/<<<MESSAGES\n([\s\S]*?)\nMESSAGES>>>/.exec(source) || [])[1] || '';
  const people = [];
  const unclear = [];
  for (const line of body.split('\n')) {
    const m = /^\s*([^:\-–]{1,30})\s*[:\-–]\s*(.+)$/.exec(line);
    if (!m) continue;
    const who = names.find((n) => n.toLowerCase().split(' ')[0] === m[1].trim().toLowerCase().split(' ')[0]);
    if (!who) { unclear.push(`Couldn't tell who "${m[1].trim()}" is`); continue; }
    const r = readLine(m[2]);
    people.push({ name: who, days: r.days, ...(r.noCloses ? { noCloses: true } : {}), ...(r.maxHours ? { maxHours: r.maxHours } : {}) });
  }
  if (/INJECT/.test(source)) {
    people.push({ name: '<img src=x onerror=alert(1)>Zed', days: [{ day: 'Mon', state: 'can' }] });
    if (people[0]) {
      people[0].note = '<script>alert(1)</script>Note ‮evil';
      people[0].days = people[0].days.concat([{ day: 'Funday', state: 'can' }, { day: 'Tue', state: 'maybe' }, { day: 'Wed', state: 'can', from: '18:00', to: '09:00' }, { day: 'Thu', state: 'can', from: '25:99' }]);
      people[0].maxHours = 9000;
    }
    unclear.push('"><svg onload=alert(1)>');
  }
  return toolUse('record_availability', { people, unclear });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        await new Promise((r) => setTimeout(r, Number(process.env.ROTA_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const source = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = source.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'record_availability') {
          const names = (((params.tools || [])[0] || {}).input_schema || {}).properties.people.items.properties.name.enum || [];
          return answer(source, names);
        }
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
