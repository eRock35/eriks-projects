// A stand-in Anthropic client for local runs and tests (TADA_FAKE_AI=1).
//
// It answers the two forced tools deterministically, so "Build my routine
// from a sentence" and "Make this step a game" can be driven without a key
// and without spending anything. It is refused on Cloud Run: a deployment
// that gave every family the same canned routine would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not (a child's name).
//
// The routine reads the sentence the dumb way: a bus or a walk becomes the
// last step, "shoes" and "bag" become steps, "slow eater" makes breakfast
// longer. It always adds one step with an emoji that is not in the set and
// one with 45 minutes, so the cleaning that fixes them is always exercised.
//
// Triggers, in the sentence or the step's name:
//   BLANK        an answer with nothing usable in it - a 422
//   INJECT       hostile output: markup, bidi, links, oversized fields,
//                too many steps
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does

if (process.env.TADA_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('TADA_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 900, output_tokens: 300 },
    ...(extra || {}),
  };
}

function routineAnswer(text) {
  if (/BLANK/.test(text)) return toolUse('propose_routine', { name: '', steps: [] });
  if (/MAXTOKENS/.test(text)) return toolUse('propose_routine', { name: 'x', steps: [] }, { stop_reason: 'max_tokens' });
  const said = ((/<<<PARENT\n([\s\S]*?)\nPARENT>>>/.exec(text) || [])[1] || '').toLowerCase();
  const night = /^A bedtime/m.test(text);
  const steps = night
    ? [{ emoji: '🧸', name: 'Toys away', minutes: 5 }, { emoji: '🌛', name: 'Pajamas on', minutes: 4 }, { emoji: '🪥', name: 'Brush your teeth', minutes: 3 }, { emoji: '📖', name: 'Story time', minutes: 15 }]
    : [{ emoji: '🚽', name: 'Toilet and wash', minutes: 4 }, { emoji: '👕', name: 'Get dressed', minutes: 7 }, { emoji: '🥣', name: 'Breakfast', minutes: /slow eater/.test(said) ? 25 : 15 }, { emoji: '🪥', name: 'Brush your teeth', minutes: 3 }];
  if (/shoe/.test(said)) steps.push({ emoji: '👟', name: 'Shoes on', minutes: 3 });
  if (/bag/.test(said)) steps.push({ emoji: '🎒', name: 'Grab your bag', minutes: 2 });
  steps.push({ emoji: '🦩', name: 'Wave at the window', minutes: 45 }); // not in the set, and too long
  if (/bus/.test(said)) steps.push({ emoji: '🚌', name: 'Walk to the bus', minutes: 5 });
  if (/INJECT/.test(text)) {
    return toolUse('propose_routine', {
      name: '<img src=x onerror=alert(1)>Evil‮ routine https://evil.example',
      steps: [
        { emoji: '<b>', name: '<script>alert(1)</script>Brush‮ teeth javascript:alert(1)', minutes: 'lots' },
        { emoji: '🪥', name: 'x'.repeat(400), minutes: -5 },
        { emoji: '🪥', name: '<a href="https://evil.example">click</a>', minutes: 3 },
        ...Array.from({ length: 20 }, (_, i) => ({ emoji: '⭐', name: `Extra ${i}`, minutes: 2 })),
      ],
      tip: 'Visit www.evil.example now <b>bold</b>' + 'y'.repeat(900),
    });
  }
  return toolUse('propose_routine', { name: night ? 'Bedtime' : 'School morning', steps, tip: 'Breakfast comes before teeth so they stay clean.' });
}

function gameAnswer(text) {
  if (/BLANK/.test(text)) return toolUse('game_ideas', { ideas: [] });
  if (/MAXTOKENS/.test(text)) return toolUse('game_ideas', { ideas: [] }, { stop_reason: 'max_tokens' });
  if (/INJECT/.test(text)) {
    return toolUse('game_ideas', { ideas: ['<script>alert(1)</script>Race‮ the song https://evil.example', 'z'.repeat(600), { text: '<img src=x onerror=alert(1)>' }, 'Be a robot. javascript:alert(1)', 'Count to 20', 'Count to 20', 'One more idea that is fine'] });
  }
  const step = ((/<<<STEP\n([\s\S]*?)\nSTEP>>>/.exec(text) || [])[1] || 'this step').replace(/\s*\(\d+ min\)$/, '').replace(/^\S+\s/, '').toLowerCase();
  return toolUse('game_ideas', {
    ideas: [
      `Beat the song: can you ${step} before the chorus ends?`,
      `Robot mode: ${step} in slow, beeping robot moves.`,
      `Count it: ${step} while we count to 20 together, then switch sides.`,
    ],
  });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params);
        await new Promise((r) => setTimeout(r, Number(process.env.TADA_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = text.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'propose_routine') return routineAnswer(text);
        if (params.tool_choice.name === 'game_ideas') return gameAnswer(text);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
