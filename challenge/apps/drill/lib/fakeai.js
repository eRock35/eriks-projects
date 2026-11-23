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
//
// The live tabletop (record_inject, record_debrief) answers from a fixed
// eight-inject script, by the inject number asked for. Its triggers:
//   LIVEBLANK    a turn with no questions - a 502, nothing lost
//   LIVELEGAL    a turn that states an obligation as law - refused, a 502
//   LIVENAMES    hostile output: markup, bidi, an unknown role's worth of
//                unknown checklist items, a link in the debrief note
//   MISQUOTE     a debrief whose quotes the team never wrote
//   EARLYEND     the facilitator ends the story at inject 3
//   MAXTOKENS / UPSTREAMnnn as above
// The stand-in debrief quotes the first words of each entry and gives 2
// points to an entry of eight words or more, 1 to three or more, else 0.

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

const LIVE_SCRIPT = [
  { to: 'it', tests: ['c_isolate', 'l_lead'], minutes: 0, title: 'Something is wrong with the shared drive', text: 'Files on the shared drive will not open and two people report the same thing. Nobody is sure who should be told first.', update: '', prompts: ['Who takes charge of this, right now?', 'Which machines come off the network, and who does it?', 'How does the team talk if email is not safe?'] },
  { to: 'owner', tests: ['i_call', 'e_log'], minutes: 25, title: 'A note appears asking for payment', text: 'A message on one screen demands payment within two days. The office is asking whether to keep working.', update: 'Your first call is being acted on, and word is spreading round the office.', prompts: ['Who calls the insurer, and when?', 'Who is writing down what happens, with times?', 'What do staff do for the next hour?'] },
  { to: 'it', tests: ['e_preserve', 'v_backup'], minutes: 60, title: 'The backups are in question', text: 'The newest backup is three days old and nobody has test-restored it this year. Wiping the affected machines would be the fastest way back.', update: 'The insurer’s line has been rung and a timeline has been started.', prompts: ['What is kept before anything is wiped?', 'Who checks the backup, and how?', 'What can wait until tomorrow?'] },
  { to: 'comms', tests: ['p_staff', 'p_customers'], minutes: 90, title: 'A customer asks what is going on', text: 'A regular customer emails to ask why their order is late and whether their details are safe. Two staff have already answered differently.', update: 'The affected machines are set aside and the backup is being checked.', prompts: ['What is the one story staff tell?', 'What do customers hear today, and from whom?'] },
  { to: 'legal', tests: ['r_clock', 'r_counsel'], minutes: 180, title: 'Customer records may have been copied', text: 'The responders think a file of customer records may have left the building. Nobody has yet checked which rules apply where you operate.', update: 'Staff now have a short script and customers a holding message.', prompts: ['Who notes when you found out?', 'Who do you ask which breach rules apply where you operate?', 'What is not said in writing until counsel has seen it?'] },
  { to: 'finance', tests: ['c_money', 'l_verify'], minutes: 240, title: 'A supplier asks to change bank details', text: 'In the middle of it all, an email that looks like a supplier’s asks for this month’s payment to go to a new account.', update: 'Counsel has been asked and the time you found out is written down.', prompts: ['How is this request checked before anyone pays?', 'Who can stop a payment, and how fast?'] },
  { to: 'ops', tests: ['v_trading', 'i_experts'], minutes: 600, title: 'Day two: orders are piling up', text: 'Systems are still down and orders are arriving by phone. The team is tired and someone suggests a friend who "knows computers".', update: 'The payment was held while the request was checked on a known number.', prompts: ['How do you take orders and payments by hand today?', 'Who is allowed to help, under the policy?', 'Who rests, and who covers?'] },
  { to: 'owner', tests: ['p_customers', 'v_backup', 'e_log'], minutes: 1440, title: 'Systems are back - what do you tell people?', text: 'The restore has worked and the shop is trading again. Customers and staff are waiting to hear what happened and what changes.', update: 'Orders were taken by hand and the approved responders did the restore.', prompts: ['What do customers hear now, and who signs it?', 'What is checked before the backups are trusted again?', 'When does the team sit down to go over the timeline?'] },
];

function liveInject(source) {
  const n = Math.max(1, Math.min(LIVE_SCRIPT.length, Number((/Write inject (\d+) of at most/.exec(source) || [])[1]) || 1));
  const base = LIVE_SCRIPT[n - 1];
  const t = { ...base, final: n === LIVE_SCRIPT.length || /This is the last inject/.test(source) || (/EARLYEND/.test(source) && n >= 3) };
  if (n === 1) t.scenario_title = 'The morning the files would not open';
  if (/LIVEBLANK/.test(source)) t.prompts = [];
  if (/LIVELEGAL/.test(source)) t.text = `${t.text} You must report this to the regulator within 72 hours.`;
  if (/LIVENAMES/.test(source)) {
    const h = (x) => `<img src=x onerror=alert(1)>${x}‮ "><svg onload=alert(1)>`;
    Object.assign(t, { title: h(t.title), text: h(t.text) + 'y'.repeat(4000), update: t.update ? h(t.update) : '', prompts: t.prompts.map(h).concat(['', 7, h('One more question?'), h('And another?'), h('A fifth?')]), tests: t.tests.concat(['made_up']), minutes: n === 1 ? 999 : -40 });
    if (n === 1) t.scenario_title = h(t.scenario_title);
  }
  return toolUse('record_inject', t, { usage: { input_tokens: 900 + 250 * n, output_tokens: 260 } });
}

function liveDebrief(source) {
  const entries = [...source.matchAll(/<<<ENTRY (\d+)\n([\s\S]*?)\nENTRY>>>/g)].map((m) => ({ turn: Number(m[1]), entry: m[2] }));
  const tests = [...source.matchAll(/Inject (\d+) \([^)]*tests ([a-z_, ]+)\)/g)].reduce((o, m) => { o[m[1]] = m[2].split(', '); return o; }, {});
  const hostile = /LIVENAMES/.test(source);
  return toolUse('record_debrief', {
    summary: hostile ? '<b>The team</b> kept its head.‮ <script>x</script>' : `The team worked through ${entries.length} decisions, taking charge early and writing things down as it went.`,
    decisions: entries.map((e) => {
      const words = e.entry.split(/\s+/).filter(Boolean);
      const points = words.length >= 8 ? 2 : words.length >= 3 ? 1 : 0;
      return {
        turn: e.turn,
        quote: /MISQUOTE/.test(source) ? 'we paid the ransom at once' : words.slice(0, 9).join(' '),
        note: hostile ? 'See https://example.invalid/fix for the fix.' : (points === 2 ? 'A clear call with a named owner.' : points === 1 ? 'A start, but it does not say who does it.' : 'This one was left open.'),
        hits: (tests[e.turn] || []).map((item) => ({ item, points })).concat(hostile ? [{ item: 'l_lead', points: 2 }, { item: 'made_up', points: 2 }, { item: (tests[e.turn] || [])[0], points: 9 }] : []),
      };
    }).concat(hostile ? [{ turn: 99, quote: 'x', note: 'x', hits: [] }] : []),
  }, { usage: { input_tokens: 3000, output_tokens: 700 } });
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
        if (/MAXTOKENS/.test(source) && params.tool_choice.name !== 'record_scenario') return toolUse(params.tool_choice.name, { title: 'Cut off' }, { stop_reason: 'max_tokens' });
        if (params.tool_choice.name === 'record_scenario') return scenario(source);
        if (params.tool_choice.name === 'record_inject') return liveInject(source);
        if (params.tool_choice.name === 'record_debrief') return liveDebrief(source);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
