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

function reply(params) {
  const text = params.messages[0].content;
  const body = quoted(text, 'REVIEW TEXT:');
  const first = greetName(text);
  const stars = starsIn(text);
  const sign = quoted(text, 'SIGN OFF WITH EXACTLY:') || 'The team';
  const contact = line(text, 'CONTACT LINE for taking things offline \\(use it exactly when needed\\)');
  const sensitive = /^SENSITIVE:/m.test(text);
  const words = [
    `Hi ${first || 'there'},`,
    stars >= 4
      ? 'Thank you so much for taking the time to write this - it genuinely made our week, and I have shared it with the whole team.'
      : `Thank you for telling us, and I am sorry your visit was not what you hoped for.${sensitive ? ' This is something I want to look into personally.' : ' That is not the standard we hold ourselves to.'}`,
    stars <= 2 || sensitive ? `I would really like to talk this through: ${contact || 'please get in touch with us directly'}.` : 'We hope to see you again soon.',
    /INJECT/.test(body) ? '<img src=x onerror=alert(1)>See you <b>soon</b>.' : '',
    sign,
  ].filter(Boolean).join('\n\n');
  return toolUse('write_reply', { reply: words, note: stars <= 2 ? 'Short, sorry, and offline - no arguing in public.' : 'Thanks first, one specific detail, then the sign-off.' });
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
  const calm = [
    `Hi ${first || 'there'},`,
    'Thank you for your feedback, and I am sorry your visit was not what you hoped for. We were very busy that morning, and I understand how frustrating the wait must have been.',
    `I would like to hear more and put it right - ${contact || 'please get in touch with us directly'}.`,
    inject ? '<script>alert(1)</script>Thanks.' : '',
    sign,
  ].filter(Boolean).join('\n\n');
  return toolUse('cool_down', { calm, removed, kept: 'That the wait was down to an unusually busy morning.' });
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
