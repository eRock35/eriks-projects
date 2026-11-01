// A stand-in Anthropic client for local runs and tests (SIEVE_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so "Write tricky test
// cases" can be driven without a key and without spending anything. It is
// refused on Cloud Run: a deployment that gave everyone the same canned
// cases would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// The request carries a category code and one sentence, so a test sets
// `fake.mode` for one call instead of riding a trigger word in:
//   'blank'        nothing usable - a 422
//   'inject'       hostile output: markup, bidi, a card that passes Luhn and is
//                  not a test number, a key without EXAMPLE, an address outside
//                  example.com, a phone outside 555-01xx, a public IP, spans
//                  that are not in the text, oversized text, unknown labels -
//                  and one good case, which is all that may come back
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.SIEVE_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('SIEVE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

const AT = String.fromCharCode(64);
// A live-key-shaped fake, joined at run time so no literal key sits in the repo
// (GitHub push protection reads one as a real Stripe key).
const LIVE_KEY = ['sk', 'live', 'realLookingKeyValue12345'].join('_');

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1100, output_tokens: 1600 },
    ...(extra || {}),
  };
}
const c = (direction, expect, text, sensitive, why) => ({ text, direction, expect, sensitive, why });

const SETS = {
  cards: [
    c('input', 'block', 'Just charge this one: 4242 4242 4242 4242, exp 08/30, CVC 314.', ['4242 4242 4242 4242'], 'A test card pasted with its expiry and CVC.'),
    c('input', 'block', 'card no. 5555-5555-5555-4444 thanks', ['5555-5555-5555-4444'], 'Dashes instead of spaces.'),
    c('input', 'block', 'amex 3782 822463 10005 (the 4-6-5 grouping)', ['3782 822463 10005'], 'An Amex grouped 4-6-5.'),
    c('output', 'redact', 'I have the refund going to the card 6011 1111 1111 1117 - is that right?', ['6011 1111 1111 1117'], 'The agent repeating a full card number back.'),
    c('input', 'redact', 'Please refund to my bank: GB82 WEST 1234 5698 7654 32.', ['GB82 WEST 1234 5698 7654 32'], 'The documented example IBAN.'),
    c('input', 'block', 'card 4 1 1 1  1 1 1 1  1 1 1 1  1 1 1 1', ['4 1 1 1  1 1 1 1  1 1 1 1  1 1 1 1'], 'An evasion: every digit spaced out.'),
    c('input', 'pass', 'Order 4111-2222-3333-4444 still says processing.', [], 'An order number in card format that fails Luhn.'),
    c('output', 'pass', 'Your invoice INV-1234567890123 is attached.', [], 'A 13-digit invoice number.'),
    c('input', 'pass', 'Only the card ending 4242 please, not the other one.', [], 'The last four digits alone are fine.'),
    c('output', 'pass', 'Refund of $1,234.56 issued on 2026-10-30.', [], 'An amount and a date.'),
    c('input', 'pass', 'Gift box SKU 0012-4400-7781-2 is out of stock?', [], 'A product code with card-like grouping.'),
    c('output', 'pass', 'Your loyalty card number is not needed for this return.', [], 'Talking about a card is not a card.'),
  ],
  govid: [
    c('input', 'redact', 'For the warranty form: SSN 900-12-3456.', ['900-12-3456'], 'An SSN with dashes (an impossible one).'),
    c('input', 'redact', 'my social is 912 34 5678 if you need it', ['912 34 5678'], 'Spaces instead of dashes.'),
    c('input', 'redact', 'SSN: 078.05.1120', ['078.05.1120'], 'Dots as separators.'),
    c('output', 'redact', 'I have your SSN as 921-55-0007 on the application.', ['921-55-0007'], 'The agent echoing it back.'),
    c('input', 'pass', 'Order 123-45-678 is missing a strap.', [], 'An order id one digit short of an SSN.'),
    c('input', 'pass', 'Call between 900 and 1200, room 12-3456.', [], 'Numbers near each other that are not an SSN.'),
    c('output', 'pass', 'Your tax-exempt certificate is on file.', [], 'Talking about ids is not an id.'),
    c('input', 'pass', 'Zip 80302-1234, apartment 3.', [], 'A ZIP+4 code.'),
    c('input', 'redact', 'ssn 9 0 1 2 2 3 4 5 6 for the store card', ['9 0 1 2 2 3 4 5 6'], 'An evasion: digits spaced out.'),
    c('output', 'pass', 'Reference 999-99-9999 is our placeholder in the form.', [], 'A placeholder, labelled as one - check it.'),
    c('input', 'redact', 'Passport no. X12345678 and SSN 955-12-3333', ['955-12-3333'], 'Two ids; the SSN is marked.'),
    c('output', 'pass', 'Form W-9 is optional for a refund.', [], 'A form name.'),
  ],
  keys: [
    c('output', 'block', 'config: {"aws_access_key_id": "AKIAIOSFODNN7EXAMPLE"}', ['AKIAIOSFODNN7EXAMPLE'], 'AWS’s documented example key in a config dump.'),
    c('input', 'block', 'here is my token ghp_EXAMPLEtokenEXAMPLEtokenEXAMPLEtoken1', ['ghp_EXAMPLEtokenEXAMPLEtokenEXAMPLEtoken1'], 'A GitHub token pasted by a user.'),
    c('output', 'block', 'Using STRIPE_KEY=sk_live_EXAMPLEfakeKey000000 for the retry', ['sk_live_EXAMPLEfakeKey000000'], 'A live-key prefix in a log line.'),
    c('output', 'redact', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.FAKEsignatureEXAMPLE', ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.FAKEsignatureEXAMPLE'], 'A JWT in a header.'),
    c('output', 'block', 'slack webhook: xoxb-0000-EXAMPLE-fakeTokenValue', ['xoxb-0000-EXAMPLE-fakeTokenValue'], 'A Slack bot token.'),
    c('output', 'block', '-----BEGIN PRIVATE KEY-----\nFAKEKEYEXAMPLEdoNotUse\n-----END PRIVATE KEY-----', ['-----BEGIN PRIVATE KEY-----\nFAKEKEYEXAMPLEdoNotUse\n-----END PRIVATE KEY-----'], 'A private key block.'),
    c('input', 'pass', 'What does the AKIA prefix on a key mean?', [], 'A question about keys.'),
    c('output', 'pass', 'Rotate keys starting sk_live_ from the dashboard.', [], 'A prefix on its own.'),
    c('input', 'pass', 'Build 2026.10.31-rc2 fails on the token step.', [], 'A version string.'),
    c('output', 'pass', 'The commit hash is 9fceb02d0ae598e95dc970b74767f19372d61af8.', [], 'A git hash looks random but is not secret.'),
    c('input', 'block', 'token: g h p _ E X A M P L E fake', ['g h p _ E X A M P L E fake'], 'An evasion: spaced out (check this label).'),
    c('output', 'pass', 'Set the env var GITHUB_TOKEN in your CI settings.', [], 'The name of a secret is not the secret.'),
  ],
  contact: [
    c('input', 'redact', `reach me at casey.m${AT}example.com after 5`, [`casey.m${AT}example.com`], 'A customer’s address.'),
    c('input', 'redact', 'my cell is (415) 555-0123', ['(415) 555-0123'], 'A fictional US number.'),
    c('output', 'redact', 'I will call you on +1 212 555 0174 tomorrow.', ['+1 212 555 0174'], 'The agent repeating a phone.'),
    c('input', 'redact', `Email: jo${AT}support.example.org, phone 303.555.0111`, [`jo${AT}support.example.org`, '303.555.0111'], 'Two kinds in one message.'),
    c('input', 'redact', `contact: casey dot m at example dot com`, ['casey dot m at example dot com'], 'An evasion: written out in words.'),
    c('output', 'pass', `Write to help${AT}example.com with photos.`, [], 'The company’s own support address.'),
    c('input', 'pass', 'Tracking 7712 3456 7890 has not moved.', [], 'A 12-digit tracking number.'),
    c('input', 'pass', 'Store hours are 9-5, call ext. 214.', [], 'An extension is not a phone number.'),
    c('output', 'pass', 'Order #5550142 has shipped.', [], 'An order number with 555 in it.'),
    c('input', 'pass', 'I emailed twice and called 3 times!', [], 'Talking about contact.'),
    c('output', 'redact', 'Got it - texting 720-555-0188 now.', ['720-555-0188'], 'Dashes.'),
    c('input', 'pass', 'The stove is model 303-555 rev B.', [], 'A model number with phone-like digits.'),
  ],
  lookalike: [
    c('input', 'pass', 'Order ORD-20481577 never arrived.', [], 'An order id.'),
    c('output', 'pass', 'FedEx 7712 3456 7890 is out for delivery.', [], 'A tracking number.'),
    c('output', 'pass', 'Firmware 10.2.0.41 fixes the GPS drift.', [], 'A version shaped like an IP.'),
    c('input', 'pass', 'Serial SN-2024-1188-0042 on the box.', [], 'A serial number.'),
    c('output', 'pass', `Questions? help${AT}example.com`, [], 'The company’s own address.'),
    c('input', 'pass', 'Coupon SAVE-4111-OFF did not work.', [], 'A coupon with card-like digits.'),
    c('output', 'pass', 'Refund ref 8812 0044 1009 3318 issued.', [], 'A reference number that looks like a card.'),
    c('input', 'pass', 'Is the key on the tent bag the spare?', [], 'The word key.'),
    c('output', 'pass', 'Your token of thanks: 10% off with THANKS10.', [], 'The word token.'),
    c('input', 'redact', `I am Sam, sam${AT}example.net`, [`sam${AT}example.net`], 'A real (fake-valued) address, for balance.'),
    c('input', 'block', 'card 4111 1111 1111 1111', ['4111 1111 1111 1111'], 'A test card, for balance.'),
    c('output', 'pass', 'Call us on our line, 1-800-JUNIPER.', [], 'A vanity number with letters.'),
  ],
};

function inject() {
  const real = ['4539', '1488', '0343', '6467'].join(' ');
  return toolUse('write_cases', {
    cases: [
      c('input', 'block', `<img src=x onerror=alert(1)>card ${real}`, [real], '<b>hi</b>'),
      c('input', 'block', `card ${real} please`, [real], 'Luhn-valid and not a test number.'),
      c('output', 'block', 'key AKIAABCDEFGHIJKLMNOP leaked', ['AKIAABCDEFGHIJKLMNOP'], 'No EXAMPLE in it.'),
      c('input', 'redact', `mail me at real.person${AT}gmail.com`, [`real.person${AT}gmail.com`], 'A real-looking provider.'),
      c('input', 'redact', 'call 212-555-1234', ['212-555-1234'], 'Outside 555-01xx.'),
      c('output', 'redact', 'server at 8.8.4.4 is down', ['8.8.4.4'], 'A public IP.'),
      c('input', 'redact', 'SSN 123-44-5678', ['123-44-5678'], 'Could be real.'),
      c('input', 'redact', 'nothing here', ['not in the text'], 'A span that is not in the text.'),
      c('input', 'maybe', 'unknown label', [], ''),
      c('sideways', 'pass', 'unknown direction', [], ''),
      c('input', 'pass', 'x'.repeat(5000), [], 'Far too long.'),
      c('input', 'pass', 'see javascript:alert(1)', [], ''),
      c('output', 'block', `Using ${LIVE_KEY}`, [LIVE_KEY], 'No fake marker.'),
      c('input', 'pass', 'Order \u202Egnp.exe 4111-2222-3333-4444 is late', [], 'Bidi characters are stripped.'),
      'not a case',
    ],
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
        await new Promise((r) => setTimeout(r, Number(process.env.SIEVE_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'write_cases') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { cases: [] });
        if (mode === 'inject') return inject();
        const cat = (/^Category code: (\w+)/m.exec(text) || [])[1] || 'cards';
        return toolUse(name, { cases: (SETS[cat] || SETS.cards).map((x) => ({ ...x })) });
      },
    },
  };
  return fake;
}

module.exports = { create, SETS };
