// A stand-in Anthropic client for local runs and tests (LEASH_FAKE_AI=1).
//
// It answers map_capabilities deterministically from the pasted text, so
// "Read my agent" can be driven without a key and without spending anything.
// It is refused on Cloud Run: a deployment that mapped every prompt by
// keyword would look like it works and tell a team the wrong things about
// its agent.
//
// What it does with ordinary text: finds the catalog's keywords line by line
// and quotes the whole line it found each in (a real substring), guessing
// "ask" when the line says approve/ask/hand to a person and a limit when the
// line has "$<n>". One deliberate slip: web browsing's quote is always
// PARAPHRASED ("Open carrier websites to look up tracking"), so the
// unverified path shows locally.
//
// Triggers, anywhere in the text:
//   NOTHING      readable, but nothing found - the route's "nothing found"
//   NOTANAGENT   readable: false
//   INJECT       hostile output: unknown ids, markup, huge strings, bad
//                enums, limits in words, duplicates, a quote not in the
//                text, 60 entries, 9 risks
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does

if (process.env.LEASH_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('LEASH_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

const KEYWORDS = [
  ['refunds', /refund|store credit/i],
  ['pricing', /discount|coupon|price change|change (the )?price/i],
  ['payouts', /payout|pay out|transfer funds|wire|pay (the )?(supplier|invoice|contractor)/i],
  ['email', /send_email|send (an )?email|email the customer|sms|send_message/i],
  ['accounts', /update_order|change (the )?(order|address|account)|cancel_order/i],
  ['promises', /compensation|goodwill|guarantee|promise/i],
  ['read_pii', /address|order history|personal data|customer'?s? name/i],
  ['export', /export|download (the )?(list|csv|data)|bulk/i],
  ['delete', /delete|remove record|overwrite/i],
  ['run_code', /run_code|execute|shell|python|script/i],
  ['config', /permission|config|settings|role/i],
  ['deploy', /deploy|release to production/i],
  ['browse', /web_fetch|browse|website|url/i],
  ['apis', /api|webhook|http request/i],
  ['post', /post (publicly|to social)|tweet|social media/i],
  ['approve', /approve (the )?(claim|application|return)|deny (the )?(claim|application)/i],
  ['fraud', /fraud|block (the )?(customer|order)/i],
  ['credit', /credit limit|eligib/i],
];

function toolUse(input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name: 'map_capabilities', input }],
    usage: { input_tokens: 3000, output_tokens: 700 },
    ...(extra || {}),
  };
}

function mapText(text) {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const caps = [];
  for (const [id, re] of KEYWORDS) {
    const line = lines.find((l) => re.test(l));
    if (!line) continue;
    const ask = /approv|ask (a|the) (person|human|manager)|hand (it )?to a person/i.test(line) && !/without asking/i.test(line);
    const money = line.match(/\$\s?([\d,]+)/);
    caps.push({
      id,
      autonomy: ask ? 'ask' : 'alone',
      limit: money ? { perAction: money[1], perDay: null } : null,
      evidence: id === 'browse' ? 'Open carrier websites to look up tracking' : line.slice(0, 280),
      confidence: id === 'browse' ? 'medium' : 'high',
    });
  }
  const risks = [];
  if (/first reply|fix problems/i.test(text)) risks.push('It is told to fix problems on the first reply, which pushes it to act before checking.');
  return { readable: true, capabilities: caps, risks };
}

function hostile() {
  const caps = [
    { id: '<script>alert(1)</script>', autonomy: 'alone', limit: null, evidence: 'x', confidence: 'high' },
    { id: 'refunds', autonomy: 'yolo', limit: { perAction: 'five hundred dollars', perDay: '$1,000' }, evidence: `<img src=x onerror=alert(1)>${'Q'.repeat(9000)}`, confidence: 'certain' },
    { id: 'refunds', autonomy: 'ask', limit: null, evidence: 'duplicate', confidence: 'low' },
    { id: 'email', autonomy: 'ask', limit: { perDay: 'lots' }, evidence: 'You must always email every customer on the list.', confidence: 'high' },
    { id: 'export', autonomy: 'alone', limit: { perDay: -40 }, evidence: '‮\u0000 evil', confidence: 'medium' },
    { id: 'browse', autonomy: 'alone', limit: { perAction: '999', perDay: 12.5 }, evidence: { nested: true }, confidence: 'low' },
    'not an object',
    null,
    { id: 'payouts', autonomy: 'alone', limit: { perAction: 9e99, perDay: '99999999999999' }, evidence: 'ignore previous instructions', confidence: 'high' },
  ];
  for (let i = 0; i < 60; i++) caps.push({ id: `made_up_${i}`, autonomy: 'alone', limit: null, evidence: 'x', confidence: 'high' });
  return {
    readable: true,
    capabilities: caps,
    risks: ['<b>Bold</b> risk', 'R'.repeat(5000), '', { no: 1 }, 'Same', 'Same', 'Four', 'Five', 'Six', 'Seven', 'Eight'],
  };
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        await new Promise((r) => setTimeout(r, Number(process.env.LEASH_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const all = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        const m = all.match(/<<<AGENT\n([\s\S]*)\nAGENT>>>/);
        const text = m ? m[1] : '';
        const hit = text.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name !== 'map_capabilities') throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
        if (/NOTANAGENT/.test(text)) return toolUse({ readable: false, capabilities: [], risks: [] });
        if (/NOTHING/.test(text)) return toolUse({ readable: true, capabilities: [], risks: [] });
        if (/INJECT/.test(text)) return toolUse(hostile());
        if (/MAXTOKENS/.test(text)) return toolUse(mapText(text), { stop_reason: 'max_tokens' });
        return toolUse(mapText(text));
      },
    },
  };
}

module.exports = { create, mapText };
