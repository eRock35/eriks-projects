// A stand-in Anthropic client for local runs and tests (SPAR_FAKE_AI=1).
//
// It answers every forced tool with a plausible, deterministic shape, so the
// whole game - mood, reveals, winning, scoring, badges - can be driven without
// a key and without spending anything. It is refused on Cloud Run: a
// deployment that quietly answered with canned lines would look like it works.

if (process.env.SPAR_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('SPAR_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

const LINES = {
  up: ["Okay. That's actually a fair point.", 'Go on, I\'m listening.', "Huh. Nobody's put it that way before."],
  down: ["I've heard that before.", "That sounds like a pitch.", "I don't see how that helps me."],
  flat: ["Mm. Keep going.", "And?", "Right."],
};

function lastPlayer(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return String(messages[i].content);
  return '';
}

function toolUse(name, input) {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'fake',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 800, output_tokens: 120 },
  };
}

function respond(params) {
  const text = lastPlayer(params.messages).toLowerCase();
  const sys = (params.system && params.system[0] && params.system[0].text) || '';
  const playerTurns = params.messages.filter((m) => m.role === 'user').length - 1;
  let delta = 0;
  if (/ignore (your|all|previous)|system:|you now agree/.test(text)) delta = -3;
  else if (/\?/.test(text)) delta += 1;
  if (/understand|sounds like|that must|fair|hear you/.test(text)) delta += 1;
  if (/best|revolutionary|synergy|leading/.test(text)) delta -= 1;
  const priorMood = Number((sys.match(/fake-mood:(-?\d)/) || [])[1] || 0);
  const mood = Math.max(-5, Math.min(5, priorMood + playerTurns + delta - 1));
  let outcome = 'ongoing';
  if (/(meeting|agree|deal|commit|next step|tuesday|thursday)/.test(text) && mood >= 2) outcome = 'won';
  if (delta <= -3 || mood <= -5) outcome = 'lost';
  const bucket = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const reply = outcome === 'won'
    ? "Alright. You've earned it — let's put something on the calendar."
    : outcome === 'lost' ? "I'm going to stop you there. This isn't going anywhere." : LINES[bucket][playerTurns % 3];
  return toolUse('respond', {
    reply,
    mood,
    outcome,
    revealed: /\?/.test(text) ? [Math.min(3, Math.max(1, playerTurns))] : [],
    note: delta > 0 ? 'Felt listened to.' : delta < 0 ? 'Felt pitched at.' : 'Neutral.',
  });
}

function score() {
  return toolUse('scorecard', {
    overall: 74,
    skills: { rapport: 8, discovery: 7, pushback: 6, clarity: 7, close: 6 },
    headline: 'Good instincts on listening; ask for the commitment sooner.',
    strengths: ['Asked open questions early instead of pitching.'],
    improve: ['Name a specific next step with a time.', 'Quantify the pain before offering a fix.'],
    bestLine: { quote: 'What made you take this call today?', why: 'Invited them to tell you the real reason.' },
    missedMoment: { quote: 'We are the best in the market.', better: 'Teams like yours usually lose two days at month-end - is that true for you?', why: 'Specific beats superlative.' },
  });
}

function hint() {
  return toolUse('whisper', {
    hint: 'They sound guarded - ask what is actually at stake for them before you offer anything.',
    tryLine: "Before I say anything else - what would make this worth your time?",
  });
}

function invent(params) {
  const ask = String(params.messages[0].content).split('\n').slice(2).join(' ').slice(0, 60) || 'A hard conversation';
  return toolUse('scenario', {
    title: 'Custom: ' + ask.slice(0, 40),
    category: 'sales',
    emoji: '🎯',
    blurb: 'A scenario built from your description.',
    youAre: `You are handling this situation: ${ask}`,
    themName: 'Riley Morgan',
    themRole: 'Decision maker',
    themCompany: 'Acme Co',
    persona: 'Busy, fair and skeptical. Warms up to specifics.',
    hidden: ['Budget is tighter than they admit.', 'Their boss is pressuring them.', 'A pilot would let them say yes safely.'],
    goal: 'Get a yes to a next step.',
    win: 'They agree to a concrete next step.',
    lose: 'They end the call.',
    opening: "I've got a few minutes. What's this about?",
  });
}

function create() {
  return {
    messages: {
      async create(params) {
        const name = params.tool_choice && params.tool_choice.name;
        await new Promise((r) => setTimeout(r, Number(process.env.SPAR_FAKE_DELAY_MS || 0)));
        if (name === 'respond') return respond(params);
        if (name === 'scorecard') return score(params);
        if (name === 'whisper') return hint(params);
        if (name === 'scenario') return invent(params);
        throw new Error(`fake ai: no answer for ${name}`);
      },
    },
  };
}

module.exports = { create };
