// A stand-in Anthropic client for local runs and tests (ZONED_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so "Help me identify"
// can be driven without a key and without spending anything. It is refused
// on Cloud Run: a deployment that identified every device the same way
// would look like it works.
//
// It records every request it was sent (`calls`), so a test can prove what
// reached "the model" - and what did not.
//
// Triggers, anywhere in a vendor, hostname or banner:
//   BLANK        an answer with nothing usable in it - a 422
//   INJECT       hostile output: markup, bidi, a bad role, a ref never sent
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - a guess from a few keywords, low confidence otherwise

if (process.env.ZONED_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('ZONED_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name: 'identify_devices', input }],
    usage: { input_tokens: 900, output_tokens: 300 },
    ...(extra || {}),
  };
}

function guess(d) {
  const t = JSON.stringify(d).toLowerCase();
  if (/10001|scp-config|lantronix|serial/.test(t)) return { role: 'remote', confidence: 'low', why: 'Port 10001 is often a serial-to-network server - the kind of box that connects an older controller to the network. (A stand-in answer: the fake model is running.)', check: 'Find the switch port it is on and follow the cable; look for a small box with a serial cable next to a controller.' };
  if (/bilian|goahead|login/.test(t)) return { role: 'iot', confidence: 'low', why: 'Bilian makes Wi-Fi modules used inside cheap smart devices, and the GoAhead web server is common on them. (A stand-in answer.)', check: 'Open its web page from a PC on site: the login page usually names the product.' };
  if (/rtsp|554/.test(t)) return { role: 'camera', confidence: 'medium', why: 'It streams video over RTSP. (A stand-in answer.)', check: 'Open its web page; cameras show a live view after login.' };
  return { role: 'unknown', confidence: 'low', why: 'There is too little to go on. (A stand-in answer.)', check: 'Find it on the switch or router by its address and follow the cable.' };
}

function answer(text) {
  const at = text.indexOf('<<<DEVICES\n');
  const end = text.lastIndexOf('\nDEVICES>>>');
  let devices = [];
  try { devices = JSON.parse(text.slice(at + 11, end)); } catch (e) { devices = []; }
  if (/BLANK/.test(text)) return toolUse({ devices: [] });
  if (/INJECT/.test(text)) {
    return toolUse({
      devices: [
        { ref: devices[0] && devices[0].ref, role: 'refrigeration', confidence: 'certain', why: `<img src=x onerror=alert(1)>A controller‮ ${'A'.repeat(3000)}`, check: '<script>alert(1)</script>Look at it' },
        { ref: 'd99', role: 'camera', confidence: 'high', why: 'A ref that was never sent', check: 'x' },
        { ref: devices[1] ? devices[1].ref : 'd2', role: 'toaster', confidence: 'high', why: 'Not a role', check: 'x' },
        'nope',
      ],
    });
  }
  if (/MAXTOKENS/.test(text)) return toolUse({ devices: [] }, { stop_reason: 'max_tokens' });
  return toolUse({ devices: devices.map((d) => ({ ref: d.ref, ...guess(d) })) });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(JSON.parse(JSON.stringify(params)));
        await new Promise((r) => setTimeout(r, Number(process.env.ZONED_FAKE_DELAY_MS || 0)));
        const text = ((params.messages && params.messages[0] && params.messages[0].content) || []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = text.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'identify_devices') return answer(text);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
