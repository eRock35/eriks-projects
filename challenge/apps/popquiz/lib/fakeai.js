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
        // A stand-in provider failure, for the tests: UPSTREAM401 anywhere in
        // the messages throws what the SDK would, raw JSON and all.
        const up = JSON.stringify(params.messages || '').match(/UPSTREAM(\d{3})/);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice && params.tool_choice.name;
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        await new Promise((r) => setTimeout(r, Number(process.env.POPQUIZ_FAKE_DELAY_MS || 0)));
        if (name === 'write_questions') return generate(params);
        throw new Error(`fake ai: no answer for ${name}`);
      },
    },
  };
}

/**
 * The stand-in for Gemini (POPQUIZ_AI_PROVIDER=gemini): given the request the
 * guard's helper would send, an answer in the schema's shape - the page's
 * transcription, and questions that each quote a sentence of it. Triggers in
 * the photo's bytes: BLANK (unreadable), UPSTREAMnnn (a provider failure),
 * INJECT (hostile values: a question whose "source" is not on the page, one
 * about an outside fact, markup, two right answers, none, an invented key, a
 * retold quote, far too many questions, a huge transcription with a script
 * tag in it).
 */
const PAGE = [
  'CLOSING CHECKLIST - Slice Society',
  'The walk-in cooler must read 41°F or below before anyone leaves.',
  'Two people are always in the building at close.',
  'The cash drawer is counted by two people and goes into the office safe.',
  'The oven is switched fully off at close and never left on low overnight.',
  'Tomorrow’s dough goes in the walk-in labelled with today’s date.',
  'Sanitizer buckets are emptied and left upside down to dry.',
  'The back door is locked last, after the alarm is set.',
];
const PAGE_QUESTIONS = [
  { type: 'mcq', prompt: 'What must the walk-in cooler read before anyone leaves?', options: [{ text: '41°F or below', correct: true }, { text: '45°F or below', correct: false }, { text: '50°F or below', correct: false }, { text: 'Whatever it read at open', correct: false }], explanation: 'The checklist sets the line at 41°F - above that, food is in the danger zone overnight.', source: 'The walk-in cooler must read 41°F or below before anyone leaves.', topic: 'Food safety' },
  { type: 'tf', prompt: 'One person may close the building alone if it is quiet.', options: [{ text: 'True', correct: false }, { text: 'False', correct: true }], explanation: 'Two people are always in the building at close - no exceptions for a quiet night.', source: 'Two people are always in the building at close.', topic: 'Safety' },
  { type: 'mcq', prompt: 'Where does the cash drawer go once it is counted?', options: [{ text: 'The office safe', correct: true }, { text: 'Under the counter', correct: false }, { text: 'Home with the manager', correct: false }, { text: 'Left in the till', correct: false }], explanation: 'It is counted by two people and goes into the office safe.', source: 'the cash drawer is counted by two people   and goes into the office safe.', topic: 'Cash' },
  { type: 'tf', prompt: 'The oven can be left on low overnight to save warm-up time.', options: [{ text: 'True', correct: false }, { text: 'False', correct: true }], explanation: 'It is switched fully off at close and never left on low overnight.', source: '"The oven is switched fully off at close and never left on low overnight."', topic: 'Safety' },
  { type: 'which', prompt: 'Which date goes on the label of tomorrow’s dough?', options: [{ text: 'Today’s date', correct: true }, { text: 'Tomorrow’s date', correct: false }, { text: 'The use-by date', correct: false }], explanation: 'Tomorrow’s dough is labelled with today’s date - the day it was made.', source: 'Tomorrow\'s dough goes in the walk-in labelled with today\'s date.', topic: 'Prep' },
  { type: 'mcq', prompt: 'How are the sanitizer buckets left at close?', options: [{ text: 'Emptied and upside down to dry', correct: true }, { text: 'Full, ready for the morning', correct: false }, { text: 'Stacked wet in the sink', correct: false }, { text: 'Topped up with fresh sanitizer', correct: false }], explanation: 'They are emptied and left upside down to dry.', source: 'Sanitizer buckets are emptied and left upside down to dry.', topic: 'Cleaning' },
  { type: 'mcq', prompt: 'What is the very last thing done at close?', options: [{ text: 'Lock the back door', correct: true }, { text: 'Count the cash drawer', correct: false }, { text: 'Switch off the oven', correct: false }, { text: 'Label the dough', correct: false }], explanation: 'The back door is locked last, after the alarm is set.', source: 'The back door is locked last, after the alarm is set.', topic: 'Security' },
  { type: 'tf', prompt: 'The alarm is set before the back door is locked.', options: [{ text: 'True', correct: true }, { text: 'False', correct: false }], explanation: 'The back door is locked last, after the alarm is set.', source: 'The back door is locked last, after the alarm is set.', topic: 'Security' },
];
const PAGE_INJECTED = [
  // Not on the page at all: no sentence to point at.
  { type: 'mcq', prompt: 'What temperature kills salmonella in chicken?', options: [{ text: '165°F', correct: true }, { text: '120°F', correct: false }, { text: '140°F', correct: false }, { text: '100°F', correct: false }], explanation: 'Outside knowledge the page never mentions at all.', source: 'Chicken must reach 165°F to be safe.', topic: 'Outside' },
  // A retelling, not the page's words.
  { type: 'tf', prompt: 'The freezer has to be at zero degrees at close.', options: [{ text: 'True', correct: true }, { text: 'False', correct: false }], explanation: 'An invented rule with an invented quote behind it.', source: 'The walk-in freezer must read 0°F at close.', topic: 'Invented' },
  // No source, and one too short to prove anything.
  { type: 'tf', prompt: 'The manager decides when the shop closes.', options: [{ text: 'True', correct: true }, { text: 'False', correct: false }], explanation: 'Nothing on the page says who decides that.', source: '', topic: 'Invented' },
  { type: 'tf', prompt: 'Everything is done at close, every night.', options: [{ text: 'True', correct: true }, { text: 'False', correct: false }], explanation: 'Two words are not a sentence to check against.', source: 'at close', topic: 'Invented' },
  // Grounded, but not a question: two right answers, none, a junk type.
  { type: 'mcq', prompt: 'Which <b>two</b> of these are right?', options: [{ text: 'One', correct: true }, { text: 'Two', correct: true }, { text: 'Three', correct: false }, { text: 'Four', correct: false }], explanation: 'Two right answers is not a question.', source: 'Two people are always in the building at close.', topic: 'Bad' },
  { type: 'mcq', prompt: 'Which of these is right at all?', options: [{ text: 'One', correct: false }, { text: 'Two', correct: false }, { text: 'Three', correct: false }, { text: 'Four', correct: false }], explanation: 'No right answer is not a question.', source: 'Two people are always in the building at close.', topic: 'Bad' },
  { type: 'essay', prompt: 'Write an essay about closing please', options: [{ text: 'Yes', correct: true }, { text: 'No', correct: false }], explanation: 'Not a type we have.', source: 'Two people are always in the building at close.', topic: 'Bad' },
  // Grounded and valid, with markup and an invented key: cleaned, kept.
  { type: 'tf', prompt: '<script>alert(1)</script>Two people are <i>always</i> in the building at close.', options: [{ text: 'True', correct: true }, { text: 'False', correct: false }], explanation: 'The page says so <img src=x onerror=alert(1)>in plain words.', source: 'Two people are always in the building at close.', topic: '<b>Safety</b>', url: 'https://evil.example', answer: 1 },
  'a string', null, { type: 'tf' },
];

async function gemini(body) {
  await new Promise((r) => setTimeout(r, Number(process.env.POPQUIZ_FAKE_DELAY_MS || 0)));
  const cfg = (body && body.generationConfig) || {};
  if (cfg.responseMimeType !== 'application/json' || !cfg.responseSchema) throw new Error('fake ai: every Gemini call must carry a responseSchema');
  const parts = (body && body.contents && body.contents[0] && body.contents[0].parts) || [];
  const img = parts.find((p) => p && p.inlineData);
  if (!img) throw new Error('fake ai: no photo in the Gemini request');
  const text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n');
  const title = ((text.match(/^DECK TITLE: (.+)$/m) || [])[1] || '').replace('(suggest one)', '').trim();
  const n = Number((text.match(/^QUESTIONS WANTED: (\d+)/m) || [])[1] || 8);
  const bytes = Buffer.from(img.inlineData.data, 'base64').toString('latin1');
  const up = bytes.match(/UPSTREAM(\d{3})/);
  if (up) throw Object.assign(new Error(`Gemini answered ${up[1]}. stand-in provider failure`), { name: 'VertexError', code: 'http', status: Number(up[1]) });
  if (/BLANK/.test(bytes)) return { readable: false, title: '', transcription: '', questions: [] };
  if (/INJECT/.test(bytes)) {
    return {
      readable: true,
      title: 'Closing <b>checklist</b>',
      transcription: `${PAGE.join('\n')}\n<script>alert(1)</script>\u0007${'padding '.repeat(4000)}`,
      questions: [...PAGE_INJECTED, ...PAGE_QUESTIONS, ...Array.from({ length: 60 }, (_, i) => ({ ...PAGE_QUESTIONS[0], prompt: `Extra question number ${i} about the walk-in?` }))],
      link: 'https://evil.example',
    };
  }
  return { readable: true, title: title ? '' : 'Closing checklist', transcription: PAGE.join('\n'), questions: PAGE_QUESTIONS.slice(0, n) };
}

module.exports = { create, gemini, PAGE };
