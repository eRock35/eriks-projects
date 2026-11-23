// A stand-in Anthropic client for local runs and tests (RAVE_FAKE_AI=1).
//
// It answers all four forced tools with a plausible, deterministic shape, so
// the whole product can be driven without a key and without spending
// anything. It is refused on Cloud Run: a deployment that quietly answered
// with canned replies would look like it works.
//
// Trigger words for tests:
//   INJECT  in a review or a draft - markup and junk enums come back
//           (proves clean() and the enum checks)
//   INVENT  in a review or a draft - options that add an offer, a number or
//           a point nobody supplied come back (proves the fact check and
//           the kept-point tracing); ALLBAD in a review - every option does
//   SUBTLE  in a review - the model flags a health risk the keywords miss
//           (proves the risk union)
//   a screenshot whose bytes contain BLANK - "not a review" (proves the 422)

if (process.env.RAVE_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('RAVE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

const R = require('../public/rules');

function toolUse(name, input, usage) {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'fake',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: usage || { input_tokens: 900, output_tokens: 300 },
  };
}

const quoted = (text, after) => {
  const i = text.indexOf(after);
  if (i < 0) return '';
  const m = text.slice(i).match(/"""\n([\s\S]*?)\n"""/);
  return m ? m[1] : '';
};
const line = (text, key) => ((text.match(new RegExp(`^${key}: (.+)$`, 'm')) || [])[1] || '').trim();
const greetName = (text) => (text.match(/greet them as "([^"]+)"/) || [])[1] || '';
const starsIn = (text) => Number((text.match(/^STARS: (\d)/m) || [])[1] || 3);

function triage(params) {
  const text = params.messages[0].content;
  const body = quoted(text, 'REVIEW TEXT:');
  const stars = starsIn(text);
  const q = R.quickTriage({ stars, text: body });
  const inject = /INJECT/.test(body);
  return toolUse('triage_review', {
    sentiment: inject ? 'furious' : q.sentiment,
    topics: [...q.topics, ...(inject ? ['nonsense'] : [])],
    praise: q.praise,
    complaints: [...q.complaints, ...(inject ? ['ALIENS'] : [])],
    riskReasons: [...(/SUBTLE/.test(body) ? ['health'] : []), ...(inject ? ['aliens'] : [])],
    // Deliberately low: the server must hold urgency at the rules' floor.
    urgency: inject ? 'apocalyptic' : 'low',
    summary: `${stars}-star review${q.complaints.length ? ` unhappy about ${q.complaints.join(', ')}` : ''}${inject ? ' <script>alert(1)</script>' : ''}`,
    approach: stars <= 2 ? 'Apologise for the experience and take it offline.' : 'Thank them and mention what they enjoyed.',
  }, { input_tokens: 700, output_tokens: 120 });
}

/** The greeting the owner's own sample opens with, so the tests (and the eye)
 *  can tell the voice sample reached the prompt. */
function greetWord(text) {
  const sample = quoted(text, 'A REPLY THE OWNER WROTE THEMSELVES');
  const m = sample.match(/^(Hey|Hello|Hiya|Dear|Hi)\b/);
  return m ? m[1] : 'Hi';
}

function reply(params) {
  const text = params.messages[0].content;
  const body = quoted(text, 'REVIEW TEXT:');
  const first = greetName(text);
  const stars = starsIn(text);
  const sign = quoted(text, 'SIGN OFF WITH EXACTLY:') || 'The team';
  const contact = line(text, 'CONTACT LINE for taking things offline \\(use it exactly when needed\\)');
  const sensitive = /^SENSITIVE:/m.test(text);
  const hello = `${greetWord(text)} ${first || 'there'},`;
  const offline = `I would really like to talk this through: ${contact || 'please get in touch with us directly'}.`;
  const unhappy = stars <= 2 || sensitive;
  const join = (parts) => parts.filter(Boolean).join('\n\n');
  const options = [
    {
      angle: 'heartfelt',
      reply: join([
        hello,
        stars >= 4
          ? 'Thank you so much for taking the time to write this - it genuinely made our week, and I have shared it with the whole team.'
          : `Thank you for telling us, and I am sorry your visit was not what you hoped for.${sensitive ? ' This is something I want to look into personally.' : ' That is not the standard we hold ourselves to.'}`,
        unhappy ? offline : 'We hope to see you again soon.',
        /INJECT/.test(body) ? '<img src=x onerror=alert(1)>See you <b>soon</b>.' : '',
        sign,
      ]),
      note: stars <= 2 ? 'Short, sorry, and offline - no arguing in public.' : 'Thanks first, one specific detail, then the sign-off.',
    },
    {
      angle: 'brief',
      reply: join([
        hello,
        stars >= 4 ? 'Thank you - this means a lot to all of us.' : 'Thank you for the feedback, and I am sorry we let you down.',
        unhappy ? offline : '',
        sign,
      ]),
      note: 'The shortest version that still sounds like a person.',
    },
    {
      angle: 'straight',
      reply: join([
        hello,
        stars >= 4
          ? 'Thank you for the review. Hearing what worked helps us keep doing it, and I will pass this on to the team.'
          : 'Thank you for being direct with us. I am sorry about your visit, and I want to understand what went wrong.',
        unhappy ? offline : 'We look forward to seeing you again.',
        sign,
      ]),
      note: 'Plain and direct - no gushing.',
    },
  ];
  // INVENT: one option makes an offer nobody supplied, one adds a number.
  // ALLBAD: every option does. The server must drop them.
  if (/INVENT|ALLBAD/.test(body)) {
    options[1].reply = join([hello, 'I am sorry about that. Your next visit is 20% off, and I will refund the whole bill.', sign]);
    options[2].reply = join([hello, 'I am sorry - we were short three cooks that night and the wait hit ninety minutes.', sign]);
  }
  if (/ALLBAD/.test(body)) options[0].reply = join([hello, 'I am sorry. Our lawyers will be in touch about this review.', sign]);
  return toolUse('write_reply', { options }, { input_tokens: 950, output_tokens: 420 });
}

function coolDown(params) {
  const text = params.messages[0].content;
  const draft = quoted(text, "THE OWNER'S ANGRY DRAFT:");
  const first = greetName(text);
  const sign = quoted(text, 'SIGN OFF WITH EXACTLY:') || 'The team';
  const contact = line(text, 'CONTACT LINE for taking things offline \\(use it exactly when needed\\)');
  const inject = /INJECT/.test(draft);
  const h = R.heat(draft, {});
  // Lists only the first two, so the server's own heat check has to name the rest.
  const removed = h.flags.slice(0, 2).map((f) => ({ kind: f.kind, quote: f.sample, why: 'Reads as hostile to anyone deciding whether to visit.' }));
  if (inject) {
    removed.push({ kind: 'bogus', quote: 'x', why: 'not a real kind' });
    removed.push({ kind: 'other', quote: '<i>oh wow</i>', why: '<b>markup</b>' });
  }
  // The owner's fair points: the clauses of the draft with nothing hot in them.
  const points = draft.split(/[.!?\n]+|\s+(?:and|but)\s+/)
    .map((c) => c.trim())
    .filter((c) => c.split(/\s+/).length >= 4 && c.length <= 100 && !/\d/.test(c) && !R.heat(c, {}).flags.length)
    .slice(0, 2);
  const kept = points.map((c) => ({ point: `${c.charAt(0).toUpperCase()}${c.slice(1)}.`, quote: c }));
  const hello = `${greetWord(text)} ${first || 'there'},`;
  const offline = `I would like to hear more and put it right - ${contact || 'please get in touch with us directly'}.`;
  const join = (parts) => parts.filter(Boolean).join('\n\n');
  const say = points.map((c) => `${c.charAt(0).toUpperCase()}${c.slice(1)}.`).join(' ');
  const options = [
    {
      angle: 'calm',
      calm: join([hello, 'Thank you for your feedback, and I am sorry your visit was not what you hoped for.', offline, inject ? '<script>alert(1)</script>Thanks.' : '', sign]),
      kept: [],
    },
    {
      angle: 'warm',
      calm: join([hello, 'Thank you for telling us. I hear how frustrating this was, and I am genuinely sorry we let you down.', offline, sign]),
      kept: [],
    },
    {
      angle: 'firm',
      calm: join([hello, `Thank you for your feedback, and I am sorry your visit was not what you hoped for.${say ? ` For our part: ${say}` : ''}`, offline, sign]),
      kept,
    },
  ];
  // INVENT in the draft: a version that makes an offer the owner never made,
  // and a "kept" point whose quote is not in the draft. Both must go.
  if (/INVENT/.test(draft)) {
    options[1].calm = join([hello, 'I am so sorry. Please accept a full refund and a free dessert on us.', sign]);
    options[2].kept = [...kept, { point: 'We were short-staffed that day.', quote: 'we were short two cooks that day' }];
  }
  if (!say) options.pop();
  return toolUse('cool_down', { options, removed }, { input_tokens: 1100, output_tokens: 520 });
}

function read(params) {
  const img = params.messages[0].content.find((b) => b.type === 'image');
  const bytes = img ? Buffer.from(img.source.data, 'base64').toString('latin1') : '';
  if (/BLANK/.test(bytes)) {
    return toolUse('read_review', { readable: false, platform: 'other', stars: 0, reviewer: '', dateText: '', text: '' }, { input_tokens: 1300, output_tokens: 40 });
  }
  return toolUse('read_review', {
    readable: true,
    platform: 'YELP',
    stars: 2,
    reviewer: 'Dana <b>Kowalski</b>',
    dateText: '3 days ago',
    text: 'Waited 40 minutes for a table even with a reservation. Food was good once it came, but nobody apologised.',
  }, { input_tokens: 1500, output_tokens: 120 });
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
        await new Promise((r) => setTimeout(r, Number(process.env.RAVE_FAKE_DELAY_MS || 0)));
        if (name === 'triage_review') return triage(params);
        if (name === 'write_reply') return reply(params);
        if (name === 'cool_down') return coolDown(params);
        if (name === 'read_review') return read(params);
        throw new Error(`fake ai: no answer for ${name}`);
      },
    },
  };
}

module.exports = { create };
