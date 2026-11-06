// A stand-in Anthropic client for local runs and tests (CHAPTER_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so "Suggest discussion
// questions" can be driven without a key and without spending anything. It
// is refused on Cloud Run: a deployment that asked every book the same six
// questions would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// A test picks a mode with `fake.mode` for one call:
//   blank        nothing usable - a 422
//   unknown      knowsBook false, with general questions
//   inject       hostile output: markup, links, long quotes, chapters out of
//                range, 30 questions, a control character
//   maxtokens    the answer ran out of room
//   upstreamNNN  the call fails the way the SDK's APIError does

if (process.env.CHAPTER_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('CHAPTER_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 420, output_tokens: 380 },
    ...(extra || {}),
  };
}

const ASKS = [
  'Whose first impression in these chapters do you trust least, and why?',
  'Which choice so far would you have made differently in that character’s place?',
  'Where did the book make you laugh, and where did it make you wince?',
  'How does the setting shape what the characters feel free to say?',
  'Which minor character would you most like to hear more from?',
  'What do you think the book is setting up for the chapters ahead?',
];

function rangeOf(text) {
  const m = /(?:chapters|pages) (\d+) to (\d+)/.exec(text);
  return m ? { from: Number(m[1]), to: Number(m[2]) } : { from: 1, to: 1 };
}

function create() {
  const calls = [];
  const fake = {
    calls,
    mode: '',
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params);
        await new Promise((r) => setTimeout(r, Number(process.env.CHAPTER_FAKE_DELAY_MS || 0)));
        const mode = fake.mode;
        fake.mode = '';
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'suggest_questions') throw new Error(`fake ai: no answer for ${name}`);
        const text = params.messages[0].content.map((b) => b.text || '').join('\n');
        const r = rangeOf(text);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { knowsBook: true, questions: 'lots' });
        if (mode === 'inject') {
          const many = [];
          for (let i = 0; i < 30; i++) many.push({ text: `Filler question number ${i} for the group?`, chapter: r.to + 5 });
          return toolUse(name, {
            knowsBook: true,
            questions: [
              { text: '<img src=x onerror=alert(1)>What did you think of the ball?', chapter: r.from },
              { text: 'Read the full answer at https://evil.example/answers - what do you think?', chapter: r.from },
              { text: 'Visit www.evil.example to see the ending. Thoughts?', chapter: r.from },
              { text: 'Why does the narrator say "it is a truth that everyone in the whole wide world knows very well indeed" so early?', chapter: r.from },
              { text: 'What happens to the sisters in the very last chapter?', chapter: r.to + 30 },
              { text: 'A question with a control\u0007character in it?', chapter: r.from },
              { text: 'Too short?', chapter: r.from },
              { text: 'Who would you cast as the lead in a film of these chapters?', chapter: r.to },
              { text: 'Who would you cast as the lead in a film of these chapters?', chapter: r.to },
              ...many,
            ],
          });
        }
        if (mode === 'unknown') return toolUse(name, { knowsBook: false, questions: ASKS.slice(0, 4).map((t) => ({ text: t, chapter: r.to })) });
        const span = Math.max(0, r.to - r.from);
        return toolUse(name, { knowsBook: true, questions: ASKS.map((t, i) => ({ text: t, chapter: r.from + Math.round((span * i) / (ASKS.length - 1)) })) });
      },
    },
  };
  return fake;
}

module.exports = { create, ASKS };
