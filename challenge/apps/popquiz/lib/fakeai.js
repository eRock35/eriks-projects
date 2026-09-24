// A stand-in Anthropic client for local runs and tests (POPQUIZ_FAKE_AI=1).
//
// It answers the forced `write_questions` tool with deterministic questions
// built from the material's own sentences, so the whole product - generate,
// review, edit, publish, play - can be driven without a key and without
// spending anything. It is refused on Cloud Run: a deployment that quietly
// answered with canned questions would look like it works.
//
// Trigger words for tests:
//   INJECT        in the material - also returns markup, a question with two
//                 right answers, one with none, duplicate options and a junk
//                 type (proves validation drops or cleans every one)
//   NOT TRAINING  in the material - "readable: false" (proves the 422)
//   a photo whose bytes contain BLANK - "readable: false"

if (process.env.POPQUIZ_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('POPQUIZ_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, usage) {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'fake',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: usage || { input_tokens: 1200, output_tokens: 900 },
  };
}

const STOP = new Set(['the', 'and', 'with', 'from', 'that', 'this', 'your', 'they', 'them', 'have', 'every', 'before', 'after', 'into', 'when', 'what', 'must', 'will', 'never', 'always', 'about', 'there', 'their', 'which', 'should']);

function sentencesOf(text) {
  return String(text)
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
    // A heading ("MENU & ALLERGENS - staff sheet") is not a fact to ask about.
    .filter((s) => s.split(/\s+/).length >= 5 && s.length <= 180 && !/^[A-Z0-9 &'’-]{8,}/.test(s));
}
function wordsOf(s) {
  return (s.match(/[A-Za-z][A-Za-z'-]{3,}/g) || []).filter((w) => !STOP.has(w.toLowerCase()) && w !== w.toUpperCase());
}

function fromText(text, title, n) {
  const sentences = sentencesOf(text);
  const pool = [...new Set(wordsOf(text))];
  const out = [];
  sentences.slice(0, n).forEach((s, i) => {
    const words = wordsOf(s);
    const key = words.slice().sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
    const others = pool.filter((w) => w.toLowerCase() !== (key || '').toLowerCase() && !s.includes(w));
    const pad = ['Weekly', 'Manager', 'Customer', 'Morning', 'Counter', 'Freezer'];
    const distract = [...others, ...pad].filter((w, j, a) => a.findIndex((x) => x.toLowerCase() === w.toLowerCase()) === j).slice(0, 3);
    const gap = key ? s.replace(key, '____') : s;
    const base = { explanation: `The ${title || 'material'} says so: "${s.slice(0, 120)}"`, source: s.slice(0, 140), topic: title || 'Training' };
    if (i % 3 === 1 || !key) {
      out.push({ ...base, type: 'tf', prompt: `True or false: ${s}`, options: [{ text: 'True', correct: true }, { text: 'False', correct: false }] });
    } else if (i % 3 === 0) {
      out.push({ ...base, type: 'mcq', prompt: `Fill the gap: "${gap}"`, options: [{ text: key, correct: true }, ...distract.map((w) => ({ text: w, correct: false }))] });
    } else {
      out.push({ ...base, type: 'which', prompt: `Which one is it? "${gap}"`, options: [{ text: key, correct: true }, ...distract.slice(0, 2).map((w) => ({ text: w, correct: false }))] });
    }
  });
  return out;
}

const INJECTED = [
  { type: 'mcq', prompt: 'Which <b>two</b> of these are right?', options: [{ text: 'One', correct: true }, { text: 'Two', correct: true }, { text: 'Three', correct: false }, { text: 'Four', correct: false }], explanation: 'Two right answers is not a question.', source: 'x', topic: 'Bad' },
  { type: 'mcq', prompt: 'Which of these is right at all?', options: [{ text: 'One', correct: false }, { text: 'Two', correct: false }, { text: 'Three', correct: false }, { text: 'Four', correct: false }], explanation: 'No right answer is not a question.', source: 'x', topic: 'Bad' },
  { type: 'mcq', prompt: 'Which option is duplicated here?', options: [{ text: 'Same', correct: true }, { text: 'same', correct: false }, { text: 'Other', correct: false }, { text: 'Else', correct: false }], explanation: 'Duplicates are refused.', source: 'x', topic: 'Bad' },
  { type: 'essay', prompt: 'Write an essay about the menu please', options: [{ text: 'Yes', correct: true }, { text: 'No', correct: false }], explanation: 'Not a type we have.', source: 'x', topic: 'Bad' },
  { type: 'tf', prompt: '<script>alert(1)</script>Staff must <i>always</i> wash hands before prep.', options: [{ text: 'True', correct: true }, { text: 'False', correct: false }], explanation: 'Hands are washed <img src=x onerror=alert(1)>before every prep shift.', source: '"Wash hands before prep."', topic: '<b>Safety</b>' },
];

function generate(params) {
  const msg = params.messages[0].content;
  const textPart = typeof msg === 'string' ? msg : msg.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const title = ((textPart.match(/^DECK TITLE: (.+)$/m) || [])[1] || '').replace('(suggest one)', '').trim();
  const n = Number((textPart.match(/^QUESTIONS WANTED: (\d+)/m) || [])[1] || 8);
  const img = typeof msg === 'string' ? null : msg.find((b) => b.type === 'image');
  if (img) {
    const bytes = Buffer.from(img.source.data, 'base64').toString('latin1');
    if (/BLANK/.test(bytes)) return toolUse('write_questions', { readable: false, title: '', questions: [] }, { input_tokens: 1400, output_tokens: 30 });
    const page = [
      'The walk-in cooler must read 41°F or below before anyone leaves.',
      'Two people are always in the building at close.',
      'The cash drawer is counted by two people and goes into the office safe.',
      'The oven is switched fully off at close and never left on low overnight.',
      'Tomorrow\'s dough goes in the walk-in labelled with today\'s date.',
    ].join('\n');
    return toolUse('write_questions', { readable: true, title: title || 'Closing checklist', questions: fromText(page, title || 'Closing checklist', n) }, { input_tokens: 1800, output_tokens: 900 });
  }
  const body = (textPart.match(/"""\n([\s\S]*?)\n"""/) || [])[1] || '';
  if (/NOT TRAINING/.test(body)) return toolUse('write_questions', { readable: false, title: '', questions: [] }, { input_tokens: 600, output_tokens: 30 });
  const questions = fromText(body, title, n);
  if (/INJECT/.test(body)) questions.push(...INJECTED);
  return toolUse('write_questions', { readable: true, title: title ? '' : 'Suggested <b>title</b>', questions });
}

function create() {
  return {
    messages: {
      async create(params) {
        const name = params.tool_choice && params.tool_choice.name;
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        await new Promise((r) => setTimeout(r, Number(process.env.POPQUIZ_FAKE_DELAY_MS || 0)));
        if (name === 'write_questions') return generate(params);
        throw new Error(`fake ai: no answer for ${name}`);
      },
    },
  };
}

module.exports = { create };
