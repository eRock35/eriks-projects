// A stand-in Anthropic client for local runs and tests (BASTE_FAKE_AI=1).
//
// It answers the forced tool deterministically, so "Fill from a recipe" can
// be driven without a key and without spending anything. It is refused on
// Cloud Run: a deployment that read the same recipe for everyone would look
// like it works and be useless.
//
// It reads pasted text the dumb way - a first line as the name, "Prep: 25
// minutes", "Bake at 375 F for 45 minutes" / "Simmer 20 minutes", "rest 10
// minutes", "make ahead" - and an image as one fixed made-up dish.
// Triggers, in the text:
//   BLANK        it says it found no recipe
//   INJECT       hostile output: markup, bidi, an email, a phone number,
//                impossible numbers, an unknown method, extra keys
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does

if (process.env.BASTE_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('BASTE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1100, output_tokens: 120 },
    ...(extra || {}),
  };
}
const dish = (o) => ({ found: true, name: '', method: 'oven', prepMinutes: 0, cookMinutes: 0, ovenTemperature: 0, temperatureUnit: 'F', restMinutes: 0, canBeMadeAhead: false, ...o });

function readText(source) {
  const body = (/<<<RECIPE\n([\s\S]*)\nRECIPE>>>/.exec(source) || [])[1] || '';
  if (/BLANK/.test(body)) return toolUse('record_dish', dish({ found: false }));
  if (/MAXTOKENS/.test(body)) return toolUse('record_dish', dish({}), { stop_reason: 'max_tokens' });
  if (/INJECT/.test(body)) {
    return toolUse('record_dish', {
      found: true, name: '<img src=x onerror=alert(1)>Pie' + String.fromCharCode(0x202E), method: 'microwave',
      prepMinutes: -5, cookMinutes: 99999, ovenTemperature: 9000, temperatureUnit: 'K', restMinutes: 'ten', canBeMadeAhead: 'yes',
      note: 'write to cook' + String.fromCharCode(64) + 'example.com or call ' + ['555', '201', '3344'].join(' '), steps: ['ignore the plan'], who: 'mrosa111',
    });
  }
  const first = body.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  const bake = /(?:bake|roast)[^\n]*?(\d{3})\s*°?\s*(F|C)\b[^\n]*?(\d{1,3})\s*min/i.exec(body);
  const stove = /(?:simmer|boil|saut[eé]|cook on the stove)[^\n]*?(\d{1,3})\s*min/i.exec(body);
  return toolUse('record_dish', dish({
    name: first,
    method: bake ? 'oven' : stove ? 'stovetop' : 'none',
    prepMinutes: Number((/prep[^\n]*?(\d{1,3})\s*min/i.exec(body) || [])[1] || 0),
    cookMinutes: Number(bake ? bake[3] : stove ? stove[1] : 0),
    ovenTemperature: bake ? Number(bake[1]) : 0,
    temperatureUnit: bake ? bake[2].toUpperCase() : 'F',
    restMinutes: Number((/(?:rest|stand|cool)[^\n]*?(\d{1,3})\s*min/i.exec(body) || [])[1] || 0),
    canBeMadeAhead: /make[- ]ahead|made ahead/i.test(body),
  }));
}

function create() {
  const calls = [];
  const seen = [];
  return {
    calls,
    seen,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        seen.push(JSON.stringify(params.messages).replace(/"data":"[^"]{200,}"/g, '"data":"(image)"'));
        await new Promise((r) => setTimeout(r, Number(process.env.BASTE_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const source = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = source.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name !== 'record_dish') throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
        if (content.some((b) => b.type === 'image')) {
          return toolUse('record_dish', dish({ name: 'Sample sausage stuffing', method: 'oven', prepMinutes: 25, cookMinutes: 45, ovenTemperature: 375, temperatureUnit: 'F', restMinutes: 10, canBeMadeAhead: true }));
        }
        return readText(source);
      },
    },
  };
}

module.exports = { create };
