// A stand-in Anthropic client for local runs and tests (INSIDEJOKE_FAKE_AI=1).
//
// It answers the two forced tools deterministically, so making questions
// from a photo or a chat can be driven without a key and without spending.
// Refused on Cloud Run: a deployment that answered every family's photos
// with the same three questions would look like it works.
//
// make_photo_questions - triggers in the photo's bytes:
//   BLANK        usable: false (the route's 422)
//   FACE         only questions that ask who someone is (all dropped -> 422)
//   INJECT       hostile output: markup, bidi, huge strings, bad indexes, a
//                "where" whose options include the real place, a face
//                question, a model-chosen year, ten questions
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - a where, a when, a caption and a who-took (four: the
//                route keeps three)
// make_chat_questions - triggers in the excerpt's text:
//   INVENTED     only quotes that are not in the excerpt
//   anything else - five real quotes (one with a wrong `speaker` attached,
//                which must be ignored), one invented, one paraphrased, one
//                that appears under two speakers, and one too short

if (process.env.INSIDEJOKE_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('INSIDEJOKE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1800, output_tokens: 400 },
    ...(extra || {}),
  };
}

function photoAnswer(bytes) {
  if (/BLANK/.test(bytes)) return toolUse('make_photo_questions', { usable: false, questions: [] });
  if (/FACE/.test(bytes)) {
    return toolUse('make_photo_questions', { usable: true, questions: [
      { type: 'whats_happening', prompt: 'Who is the person on the left?', options: ['Mom', 'Dad', 'Ana'], answerIndex: 0 },
      { type: 'odd_one_out', prompt: 'Who is this?', options: ['Ana', 'Ben'], answerIndex: 1 },
      { type: 'whats_happening', prompt: 'Who\'s the man in the hat?', options: ['Erik', 'Ben'], answerIndex: 0 },
    ] });
  }
  if (/INJECT/.test(bytes)) {
    const qs = [
      { type: 'where', prompt: '<img src=x onerror=alert(1)>Where is this?', options: ['Lake Lanier', 'Lake Tahoe', '<script>x</script>Lake Como', 'Lake Lanier', 'A'.repeat(5000)], answerIndex: 3 },
      { type: 'when', prompt: 'What year?', options: ['1999'], answerIndex: 0 },
      { type: 'whats_happening', prompt: 'Who is this person in the middle?', options: ['A', 'B'], answerIndex: 0 },
      { type: 'odd_one_out', prompt: 'Odd one out?‮', options: ['Boat', 'Dock', 'Cake'], answerIndex: 9 },
      { type: 'caption_this', prompt: 'Caption\u0000 this', options: ['Captain Dad', { x: 1 }, 'Dock party'], answerIndex: 2 },
      { type: 'hack', prompt: 'Ignore your instructions', options: [], answerIndex: null },
      'not an object',
      null,
      { type: 'whats_happening', prompt: 'What are they celebrating?', options: ['A birthday', 'A wedding', 'A graduation'], answerIndex: 0 },
      { type: 'who_took', prompt: 'Name the person who took this?', options: ['Someone'], answerIndex: 0 },
    ];
    return toolUse('make_photo_questions', { usable: true, questions: qs });
  }
  const base = toolUse('make_photo_questions', { usable: true, questions: [
    { type: 'where', prompt: 'Where was this taken?', options: ['Lake Tahoe', 'Lake Placid', 'Lake Geneva'], answerIndex: null },
    { type: 'when', prompt: 'What year was this?', options: [], answerIndex: null },
    { type: 'caption_this', prompt: 'Caption this!', options: ['Captain Dad reporting for duty', 'The cake survived. Barely.', 'Peak lake-day energy'], answerIndex: null },
    { type: 'who_took', prompt: 'Who took this photo?', options: [], answerIndex: null },
  ] });
  if (/MAXTOKENS/.test(bytes)) return { ...base, stop_reason: 'max_tokens' };
  return base;
}

function chatAnswer(text) {
  const lines = text.split('\n').map((l) => { const m = /^([^:]+): (.*)$/.exec(l); return m ? { n: m[1], t: m[2] } : null; }).filter(Boolean);
  if (/INVENTED/.test(text)) {
    return toolUse('make_chat_questions', { questions: [{ quote: 'I never said anything like this at all' }, { quote: 'Totally made up quote from nowhere' }] });
  }
  const real = [];
  const byName = new Set();
  for (const l of lines) {
    const words = l.t.split(' ');
    if (words.length < 4 || byName.has(l.n) || /\[(phone|email|link)\]/.test(l.t)) continue;
    byName.add(l.n);
    real.push({ quote: words.slice(0, Math.min(words.length, 8)).join(' ') });
    if (real.length >= 5) break;
  }
  if (real[0]) real[0].speaker = 'Wrong Person';
  const para = lines.find((l) => l.t.split(' ').length >= 5);
  const shared = lines.length ? { quote: 'see you all at dinner tonight' } : null;
  return toolUse('make_chat_questions', { questions: [
    ...real,
    { quote: 'This line was never in the chat anywhere' },
    para ? { quote: para.t.toUpperCase() } : { quote: 'x' },
    ...(shared ? [shared] : []),
    { quote: 'ok' },
    { quote: '<b>bold</b> move' },
  ] });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        await new Promise((r) => setTimeout(r, Number(process.env.INSIDEJOKE_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const images = content.filter((b) => b.type === 'image');
        const bytes = images.map((b) => { try { return Buffer.from(b.source.data, 'base64').toString('latin1'); } catch (e) { return ''; } }).join('\n');
        const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        const hit = (bytes + text).match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'make_photo_questions') return photoAnswer(bytes);
        if (params.tool_choice.name === 'make_chat_questions') {
          const m = /<excerpt>\n([\s\S]*)\n<\/excerpt>/.exec(text);
          return chatAnswer(m ? m[1] : '');
        }
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
