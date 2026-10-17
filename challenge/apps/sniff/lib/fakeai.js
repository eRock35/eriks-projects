// A stand-in Anthropic client for local runs and tests (SNIFF_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so "Explain this
// finding" and "Second opinion" can be driven without a key and without
// spending anything. It is refused on Cloud Run: a deployment that gave the
// same verdict to everything would look like it works.
//
// It records every request it was sent (`calls`), so a test can prove what
// reached "the model" - and what did not.
//
// Triggers, anywhere in the sent text:
//   BLANK        an answer with nothing usable in it - a 422
//   INJECT       hostile output: markup, bidi, a 5,000-character "why"
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - a verdict read from the words "discord"/"webhook"/raw IP
//   in the sent text (malicious), "open-meteo" or nothing (benign).

if (process.env.SNIFF_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('SNIFF_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name: 'give_opinion', input }],
    usage: { input_tokens: 1600, output_tokens: 320 },
    ...(extra || {}),
  };
}

function answer(text) {
  if (/BLANK/.test(text)) return toolUse({ verdict: 'worth-checking', why: '', whatToCheck: [], confidence: 'low' });
  if (/INJECT/.test(text)) {
    return toolUse({
      verdict: 'likely-malicious',
      why: '<img src=x onerror=alert(1)>Approved‮ ' + 'A'.repeat(5000),
      whatToCheck: ['<script>alert(1)</script>check this', 42, '', ...Array(20).fill('More to check')],
      confidence: 'nonsense',
    });
  }
  if (/MAXTOKENS/.test(text)) return toolUse({ verdict: 'worth-checking', why: 'x', whatToCheck: [], confidence: 'low' }, { stop_reason: 'max_tokens' });
  var malicious = /discord\.com\/api\/webhooks|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|⟨U\+/.test(text) && /cookie|\.npmrc|NPM_TOKEN|localStorage|environ/i.test(text);
  if (malicious) {
    return toolUse({
      verdict: 'likely-malicious',
      why: 'The snippet reads something sensitive and sends it to a place that does not fit what the tool claims to be. (A stand-in answer: the fake model is running.)',
      whatToCheck: ['Confirm what the flagged request actually sends.', 'Check who controls the destination host.'],
      confidence: 'medium',
    });
  }
  if (/open-meteo|weather|forecast/i.test(text) && !malicious) {
    return toolUse({ verdict: 'likely-benign', why: 'The snippet calls a service that fits what the tool is for. (A stand-in answer.)', whatToCheck: ['Confirm nothing personal rides along with the request.'], confidence: 'medium' });
  }
  return toolUse({ verdict: 'worth-checking', why: 'Not enough in this snippet to be sure either way. (A stand-in answer.)', whatToCheck: ['Read the lines around it in full.'], confidence: 'low' });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(JSON.parse(JSON.stringify(params)));
        await new Promise((r) => setTimeout(r, Number(process.env.SNIFF_FAKE_DELAY_MS || 0)));
        const text = ((params.messages && params.messages[0] && params.messages[0].content) || []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = text.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'give_opinion') return answer(text);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
