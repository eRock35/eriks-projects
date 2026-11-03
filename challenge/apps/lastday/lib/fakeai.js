// A stand-in Anthropic client for local runs and tests (LASTDAY_FAKE_AI=1).
//
// It answers the one forced tool deterministically from the MASKED text it is
// sent, so "Read a messy request" can be driven without a key and without
// spending anything. It is refused on Cloud Run: a deployment that gave
// everyone the same canned reading would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not (no address, no
// name, no phone number).
//
// A test sets `fake.mode` for one call:
//   'blank'        nothing usable - a 422
//   'inject'       hostile output: markup, bidi, links, a real-looking
//                  address, a token the request never carried, a date years
//                  away, a time that is no time, a mailbox choice not on the
//                  list, hardware not on the list, unknown fields, a long
//                  string - and a few clean fields, which are all that may
//                  come back
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.LASTDAY_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('LASTDAY_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

const Core = require('../public/lastday-core');

const AT = String.fromCharCode(64);

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 700, output_tokens: 300 },
    ...(extra || {}),
  };
}

/** A plausible reading of a masked request, from its own words. */
function readMasked(text) {
  const today = (/Today is (\d{4}-\d{2}-\d{2})/.exec(text) || [])[1] || '2026-11-03';
  const body = ((/<<<REQUEST\n([\s\S]*?)\nREQUEST>>>/.exec(text) || [])[1]) || '';
  const out = { questions: [] };
  const who = /(\[person\d+\])(?:’s|'s)?\s+(?:last day|is leaving|won’t be back|won't be back|is finishing)/i.exec(body)
    || /(?:leaver|offboard|remove)\s*[:\-–]?\s*(\[person\d+\])/i.exec(body)
    || /(\[(?:person|word)\d+\])\s+from the/i.exec(body);
  if (who) out.name = { value: who[1], from: who[0] };
  else out.questions.push('Who is leaving?');
  const em = /address is (\[email\d+\])/i.exec(body) || /(\[email\d+\])/.exec(body.replace(/^(from|to|cc):.*$/gim, ''));
  if (em) out.email = { value: em[1], from: em[0] };
  else out.questions.push('What is their sign-in address?');
  const d = /\b(?:after|on|by)?\s*(the \d{1,2}(?:st|nd|rd|th)|monday|tuesday|wednesday|thursday|friday)\b/i.exec(body);
  if (d) {
    const r = Core.resolveDate(d[1], today, false);
    // "won't be back after the 14th": the 14th is the last day.
    if (r) out.last_day = { value: r.day, from: d[0].trim() };
  } else out.questions.push('What is their last day?');
  if (/morning of|before (?:they|he|she) come in/i.test(body)) out.last_time = { value: '08:00', from: (/the morning of|before (?:they|he|she) come in/i.exec(body) || [''])[0] };
  else out.questions.push('What time should their access end?');
  const inv = /not a happy exit|terminat\w*|let go|before (?:they|he|she) come in/i.exec(body);
  const vol = /resign\w*|moving on|retir\w*/i.exec(body);
  if (inv) out.involuntary = { value: true, from: inv[0] };
  else if (vol) out.involuntary = { value: false, from: vol[0] };
  else out.questions.push('Is this a resignation, or should access go at the moment of notice?');
  const files = /(?:stuff|files|drive)[^.]*?go to ([^.,]+)/i.exec(body);
  if (files) out.files_to = { value: files[1].trim().replace(/,? ask .*$/i, ''), from: files[0].trim() };
  else out.questions.push('Who takes over their files?');
  if (/keep their mailbox|shared mailbox/i.test(body)) out.mailbox = { value: 'shared', from: (/keep their mailbox|shared mailbox/i.exec(body) || [''])[0] };
  else out.questions.push('What happens to their mailbox?');
  if (/laptop/i.test(body)) out.hardware = { value: ['laptop'], from: 'laptop' };
  return toolUse('read_request', out);
}

function inject() {
  return toolUse('read_request', {
    name: { value: '<img src=x onerror=alert(1)>[person9]', from: 'https://evil.example/steal' },
    email: { value: `jo${AT}evil.example`, from: 'their address' },
    last_day: { value: '2031-01-01', from: 'someday' },
    last_time: { value: '25:99', from: 'late' },
    involuntary: { value: 'yes', from: 'not a happy exit' },
    mailbox: { value: 'exfiltrate', from: 'x' },
    hardware: { value: ['laptop', 'rocket', 'laptop'], from: 'their stuff' },
    files_to: { value: 'whoever covers hygiene \u202E www.evil.example', from: 'should probably go to whoever covers hygiene' },
    manager: { value: 'x'.repeat(500), from: 'x' },
    password: { value: 'hunter2' },
    questions: ['<b>Click</b> https://evil.example to confirm', 'Who covers hygiene now?', '', { not: 'a string' }],
  });
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
        const mode = fake.mode;
        fake.mode = '';
        await new Promise((r) => setTimeout(r, Number(process.env.LASTDAY_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { questions: [] });
        if (mode === 'inject') return inject();
        if (name === 'read_request') return readMasked(text);
        throw new Error(`fake ai: no answer for ${name}`);
      },
    },
  };
  return fake;
}

module.exports = { create };
