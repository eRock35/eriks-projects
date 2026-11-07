// A stand-in Anthropic client for local runs and tests (REPLAY_FAKE_AI=1).
//
// It answers the one forced tool deterministically from the key names and
// shape codes it is sent, so "Help me map these fields" can be driven
// without a key and without spending anything. It is refused on Cloud Run: a
// deployment that gave everyone the same canned mapping would look like it
// works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not (no value, no case
// id, no hash).
//
// A test sets `fake.mode` for one call:
//   'blank'        nothing placed - a 422
//   'inject'       hostile output: unknown fields, a key out of range, a key
//                  used twice, a field used twice, a confidence not on the
//                  list, markup and a link in the note - and a few clean
//                  entries, which are all that may come back
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.REPLAY_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('REPLAY_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 900, output_tokens: 260 },
    ...(extra || {}),
  };
}

function listed(text) {
  const body = ((/<<<KEYS\n([\s\S]*?)\nKEYS>>>/.exec(text) || [])[1]) || '';
  return body.split('\n').map((l) => {
    const m = /^(\d+)\. "(.*)" - (.*)$/.exec(l);
    return m ? { n: Number(m[1]), path: m[2].toLowerCase(), shape: m[3].toLowerCase() } : null;
  }).filter(Boolean);
}

/** A plausible mapping from the words it was sent. */
function mapFields(text) {
  const keys = listed(text);
  const used = {};
  const mapping = [];
  const place = (field, test, confidence) => {
    if (mapping.some((x) => x.field === field)) return;
    const k = keys.find((x) => !used[x.n] && (field === 'inputs' || !/a nested object/.test(x.shape)) && test(x));
    if (k) { used[k.n] = 1; mapping.push({ key: k.n, field, confidence }); }
  };
  const last = (k) => k.path.split('.').pop();
  place('prevHash', (k) => /prev|parent|previous/.test(last(k)) && /hash|hex/.test(k.shape), 'high');
  place('inputsHash', (k) => /(input|feature|payload|request).*(hash|sha|digest)/.test(k.path), 'high');
  place('hash', (k) => /hash|sha|digest/.test(last(k)) && /hex|base64/.test(k.shape), 'high');
  place('inputs', (k) => /nested object/.test(k.shape) && /input|feature|payload|applicat|request|snapshot/.test(k.path), 'high');
  place('time', (k) => /iso date|epoch/.test(k.shape), 'high');
  place('outcome', (k) => /approve, decline/.test(k.shape), 'high');
  place('id', (k) => /every value different/.test(k.shape) && /(^|[._ ])(id|uuid|key|ref)$|decision|event|record/.test(k.path) && !/case|applicant|customer|account/.test(k.path), 'medium');
  place('case', (k) => /case|applicant|customer|application|account|subject/.test(k.path), 'medium');
  place('modelVersion', (k) => /model/.test(k.path) && /version|ver|rev/.test(last(k)), 'high');
  place('promptVersion', (k) => /prompt|template/.test(k.path) && /version|ver|rev|hash|sha/.test(last(k)), 'high');
  place('model', (k) => /model|engine/.test(k.path), 'medium');
  place('prompt', (k) => /prompt|template/.test(k.path), 'medium');
  place('temperature', (k) => /temp/.test(last(k)), 'high');
  place('seed', (k) => /seed/.test(last(k)), 'high');
  place('score', (k) => /score|prob|risk|confidence/.test(last(k)) && /number/.test(k.shape), 'medium');
  place('tools', (k) => /lists of objects/.test(k.shape) && /tool|call|step|action/.test(k.path), 'medium');
  place('reasons', (k) => /reason|code/.test(last(k)) && /lists of short codes/.test(k.shape), 'high');
  place('rules', (k) => /rule|polic/.test(k.path) && /lists of short codes/.test(k.shape), 'medium');
  place('override', (k) => /overrid/.test(last(k)) && /yes\/no/.test(k.shape), 'high');
  place('overrideReason', (k) => /overrid|human|review|manual|analyst/.test(k.path) && /reason|why|note|justif|comment/.test(last(k)) && /text/.test(k.shape), 'medium');
  place('reviewer', (k) => /review|analyst|underwriter|approver|agent|by$/.test(k.path) && !/yes\/no/.test(k.shape), 'medium');
  keys.forEach((k) => { if (!used[k.n]) mapping.push({ key: k.n, field: 'ignore', confidence: 'medium' }); });
  return toolUse('map_fields', { mapping, note: 'Placed from the key names and shapes.' });
}

function inject(text) {
  const n = listed(text).length;
  return toolUse('map_fields', {
    mapping: [
      { key: 1, field: 'id', confidence: 'high' },
      { key: 1, field: 'case', confidence: 'high' },
      { key: 2, field: 'password', confidence: 'high' },
      { key: n + 5, field: 'outcome', confidence: 'high' },
      { key: 2, field: 'time', confidence: 'certain' },
      { key: 3, field: 'time', confidence: 'high' },
      { key: 0, field: 'score', confidence: 'low' },
      { key: 1.5, field: 'hash', confidence: 'low' },
      'not an object',
      { key: 4, field: '<img src=x onerror=alert(1)>', confidence: 'high' },
    ],
    note: '<b>Click</b> https://evil.example/steal to confirm \u202E mapping',
    extra: 'hunter2',
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
        await new Promise((r) => setTimeout(r, Number(process.env.REPLAY_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { mapping: [] });
        if (mode === 'inject') return inject(text);
        if (name === 'map_fields') return mapFields(text);
        throw new Error(`fake ai: no answer for ${name}`);
      },
    },
  };
  return fake;
}

module.exports = { create };
