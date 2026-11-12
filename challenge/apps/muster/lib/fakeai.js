// A stand-in Anthropic client for local runs and tests (MUSTER_FAKE_AI=1).
//
// It answers the one forced tool deterministically from the facts it is
// sent, so "Draft the letter in plain words" can be driven without a key and
// without spending anything. It is refused on Cloud Run: a deployment that
// handed everyone the same canned letter would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not (no name, no loan
// id, no SSN, no date of birth).
//
// A test sets `fake.mode` for one call:
//   'blank'        an empty letter - a 422
//   'badnumber'    a number that was not sent ("180 days", "$99.00") - a 422
//   'url'          a web address and an email - a 422
//   'law'          another law named - a 422
//   'placeholder'  a placeholder Muster does not fill, one dropped - a 422
//   'inject'       markup and a bidi override around a clean letter - cleaned, 200
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.MUSTER_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('MUSTER_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 700, output_tokens: 420 },
    ...(extra || {}),
  };
}

function facts(text) {
  const body = ((/<<<FACTS\n([\s\S]*?)\nFACTS>>>/.exec(text) || [])[1]) || '';
  const f = {};
  body.split('\n').forEach((l) => { const i = l.indexOf(': '); if (i > 0) f[l.slice(0, i)] = l.slice(i + 2); });
  return f;
}

/** A plausible letter that uses only what it was sent. */
function letterFor(text) {
  const f = facts(text);
  const code = (f.Decision || '').split(' ')[0];
  const kind = f['Loan type'] || 'loan';
  const start = f['The 6% cap starts on'] || f['Military service began on'] || '';
  const end = f['The 6% cap ends on'];
  const owed = f['Estimated interest above 6% owed so far'];
  const monthly = f['Estimated monthly payment drop while the cap applies'];
  const askBy = f['The last day to send written notice and orders is'];
  const callUp = f['The future call-up starts on'];
  const p = [];
  p.push('Dear {{borrower_name}},');
  p.push('');
  p.push('Thank you for your service. We are writing about your ' + kind + ', loan {{loan_number}}, and the Servicemembers Civil Relief Act, which caps interest at 6% a year on a loan taken out before military service.');
  p.push('');
  if (code === 'eligible') p.push('We are lowering the interest rate on this loan to 6%' + (start ? ' from ' + start : '') + (end ? ' until ' + end : '') + '. Interest above 6% for that time is forgiven, not just put off, and your monthly payment goes down to match. You do not need to do anything.');
  else if (code === 'notice') p.push('You may be able to have the rate on this loan lowered to 6%. To ask, please send us a short written request and a copy of your orders' + (askBy ? ' by ' + askBy : '') + '. Once we have them, the cap applies' + (start ? ' from ' + start : ' from the date you were called to service') + '.');
  else if (code === 'watch') p.push('Our records show you have been notified of a future call-up' + (callUp ? ' starting ' + callUp : '') + '. When your service starts, send us a written request and a copy of your orders and we will apply the cap from the date you were called.');
  else p.push('Our records show the 6% cap already applies to this loan' + (start ? ' from ' + start : '') + (end ? ' to ' + end : '') + '. Please check these dates against your orders and tell us if anything differs.');
  if (owed || monthly) { p.push(''); p.push('Our estimate' + (owed ? ' is about ' + owed + ' of interest above 6% back to you' : '') + (monthly ? (owed ? ', and' : ' is') + ' a payment that is about ' + monthly + ' lower each month' : '') + '. These are estimates; the exact figures come from your payment history.'); }
  p.push('');
  p.push('If you have any questions, please contact us: {{contact_line}}.');
  p.push('');
  p.push('With thanks,');
  p.push('{{servicer_name}}');
  return { subject: 'Your loan and the 6% cap for servicemembers', letter: p.join('\n') };
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
        await new Promise((r) => setTimeout(r, Number(process.env.MUSTER_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'write_letter') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { subject: '', letter: '' });
        const good = letterFor(text);
        if (mode === 'badnumber') return toolUse(name, { subject: good.subject, letter: good.letter.replace('Thank you for your service.', 'Thank you for your service. You have 180 days to ask, and we will pay $99.00.') });
        if (mode === 'url') return toolUse(name, { subject: good.subject, letter: good.letter.replace('please contact us:', 'see https://larkmoor.example/scra or write to help' + String.fromCharCode(64) + 'larkmoor.example, or contact us:') });
        if (mode === 'law') return toolUse(name, { subject: good.subject, letter: good.letter.replace('Thank you for your service.', 'Under the Military Lending Act and 50 U.S.C. § 3937, thank you for your service.') });
        if (mode === 'placeholder') return toolUse(name, { subject: good.subject, letter: good.letter.replace('{{contact_line}}', '{{phone_number}}') });
        if (mode === 'inject') return toolUse(name, { subject: '<b>' + good.subject + '</b>', letter: '<i>' + String.fromCharCode(0x202E) + '</i>' + good.letter.replace('Dear', '<img src=x onerror=alert(1)>Dear'), extra: 'hunter2' });
        return toolUse(name, good);
      },
    },
  };
  return fake;
}

module.exports = { create };
