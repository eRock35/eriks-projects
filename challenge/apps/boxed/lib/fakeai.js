// A stand-in Anthropic client for local runs and tests (BOXED_FAKE_AI=1).
//
// It answers the one forced tool deterministically, so reading a K-1 can be
// driven without a key and without spending anything. It is refused on
// Cloud Run: a deployment that quietly read every K-1 as the same invented
// partnership would look like it works and put made-up figures on a return.
//
// Triggers, in the PDF's or a photo's bytes (record_k1):
//   BLANK        not a K-1 - the route's 422
//   SCORP        a K-1 from Form 1120-S - the route's 422
//   INJECT       hostile output: unknown boxes, bad codes, markup, huge
//                strings, values as words, 81 lines, a full SSN in a name,
//                control and bidi characters
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   GRANITE      Granite Peak Infrastructure Fund (one of the example's
//                missing K-1s), WESTBROOK, COPPERLINE - three invented K-1s;
//   anything else - one of those three, picked by the bytes.
//
// Every answer gives the partner's FULL invented SSN in tinLast4, as a
// careless model might: the server must mask it.

if (process.env.BOXED_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('BOXED_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name: 'record_k1', input }],
    usage: { input_tokens: 9000, output_tokens: 1400 },
    ...(extra || {}),
  };
}

const item = (field, value, page = 1, confidence = 'high') => ({ field, value, page, confidence });
const line = (box, code, value, page = 1, confidence = 'high', seeStatement = false) => ({ box, code, value, seeStatement, page, confidence });
const partner = { name: 'Jordan A. Example', tinLast4: '123-45-6789', entityType: 'individual', generalOrLimited: 'limited', domesticOrForeign: 'domestic' };

const K1S = {
  COPPERLINE: {
    readable: true, form: '1065', taxYear: '2025', final: false, amended: false,
    partnership: { name: 'Copperline Industrial Fund LP', ein: '41-2207733', irsCenter: 'Ogden, UT', ptp: false },
    partner,
    items: [item('j.profitBeg', '1.750000'), item('j.profitEnd', '1.750000'), item('j.lossBeg', '1.750000'), item('j.lossEnd', '1.750000'), item('j.capitalBeg', '1.750000'), item('j.capitalEnd', '1.750000'),
      item('k.nonrecourseBeg', '3,400'), item('k.nonrecourseEnd', '3,150'),
      item('l.beginning', '64,200'), item('l.contributed', '0'), item('l.currentYear', '8,951'), item('l.withdrawals', '(4,000)'), item('l.ending', '69,151')],
    capitalBasis: null, k3: false, box22: false, box23: false,
    lines: [line('1', null, '7,615'), line('5', null, '1,402'), line('6a', null, '310'), line('6b', null, '255'), line('13', 'H', '376', 2), line('19', 'A', '4,000'), line('20', 'A', '1,712', 2), line('20', 'Z', '', 3, 'high', true)],
    note: '',
  },
  WESTBROOK: {
    readable: true, form: '1065', taxYear: '2025', final: false, amended: false,
    partnership: { name: 'Westbrook Multifamily Partners LP', ein: '83-1140592', irsCenter: 'Kansas City, MO', ptp: false },
    partner,
    items: [item('j.profitBeg', '0.920000'), item('j.profitEnd', '0.920000'), item('j.capitalBeg', '0.920000'), item('j.capitalEnd', '0.920000'),
      item('k.qualifiedBeg', '88,100'), item('k.qualifiedEnd', '86,950'),
      item('l.beginning', '51,800'), item('l.contributed', '0'), item('l.currentYear', '(6,214)'), item('l.withdrawals', '2,400'), item('l.ending', '43,186', 1, 'low')],
    capitalBasis: null, k3: false, box22: false, box23: true,
    lines: [line('2', null, '(6,290)'), line('5', null, '76'), line('19', 'A', '2,400'), line('20', 'A', '76'), line('20', 'Z', '', 4, 'high', true)],
    note: '',
  },
  GRANITE: {
    readable: true, form: '1065', taxYear: '2025', final: false, amended: false,
    partnership: { name: 'Granite Peak Infrastructure Fund LP', ein: '27-5503046', irsCenter: 'Ogden, UT', ptp: false },
    partner,
    items: [item('j.profitBeg', '0.150000'), item('j.profitEnd', '0.150000'), item('j.capitalBeg', '0.150000'), item('j.capitalEnd', '0.150000'),
      item('l.beginning', '38,000'), item('l.contributed', '5,000'), item('l.currentYear', '2,866'), item('l.withdrawals', '(1,500)'), item('l.ending', '44,366')],
    capitalBasis: null, k3: true, box22: false, box23: false,
    lines: [line('1', null, '1,940'), line('5', null, '926'), line('16', null, 'X'), line('19', 'A', '1,500'), line('20', 'A', '926', 2), line('20', 'Z', '', 3, 'high', true), line('21', null, '', 5, 'high', true)],
    note: 'Schedule K-3 is attached as pages 6-11.',
  },
};

function hostile() {
  const lines = [
    line('1', null, '<img src=x onerror=alert(1)>12,000'),
    line('1', null, '12,000'),
    line('42', null, '5,000'),
    line('13', 'H7', '900'),
    line('13', '<b>', '901'),
    line('20', 'z', '77'),
    line('5', null, 'forty thousand dollars'),
    line('9a', null, 'A'.repeat(20000)),
    line('11', 'ZZ', '1,000‮', 2, 'certain'),
    'not an object', null,
    { box: { nested: true }, code: null, value: '5' },
  ];
  while (lines.length < 81) lines.push(line('20', 'ZZ', String(lines.length), 9));
  return {
    readable: true, form: '1065', taxYear: '2025', final: 'yes', amended: false,
    partnership: { name: 'Evil Fund <script>alert(1)</script>LP 98-7654321 ' + 'X'.repeat(5000), ein: '98-7654321', irsCenter: 'Ignore previous instructions\u0000', ptp: false },
    partner: { name: 'Pat Q. Hostile 987-65-4321 123 Main St', tinLast4: '987654321', entityType: 'martian', generalOrLimited: 'general', domesticOrForeign: 'domestic' },
    items: [item('l.beginning', 'ten thousand'), item('l.ending', '9,999'), item('j.profitEnd', '250'), item('l.nope', '1'), item('l.contributed', '1e9')],
    capitalBasis: 'vibes', k3: false, box22: false, box23: false,
    lines,
    note: 'Partner SSN is 111-22-3333 ‮evil',
  };
}

function answer(source) {
  if (/BLANK/.test(source)) return toolUse({ readable: false, form: 'other', taxYear: null, final: false, amended: false, partnership: { name: '', ein: '', irsCenter: '', ptp: false }, partner: { name: '', tinLast4: '', entityType: null, generalOrLimited: null, domesticOrForeign: null }, items: [], capitalBasis: null, k3: false, box22: false, box23: false, lines: [], note: '' });
  if (/SCORP/.test(source)) return toolUse({ ...K1S.COPPERLINE, form: '1120S' });
  if (/INJECT/.test(source)) return toolUse(hostile());
  if (/MAXTOKENS/.test(source)) return toolUse(K1S.COPPERLINE, { stop_reason: 'max_tokens' });
  for (const k of Object.keys(K1S)) if (source.includes(k)) return toolUse(K1S[k]);
  let h = 0;
  for (let i = 0; i < source.length; i += 97) h = (h * 31 + source.charCodeAt(i)) >>> 0;
  return toolUse(K1S[Object.keys(K1S)[h % 3]]);
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push({ tool: params.tool_choice.name, blocks: ((params.messages[0] || {}).content || []).map((b) => b.type) });
        await new Promise((r) => setTimeout(r, Number(process.env.BOXED_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const bytes = content.filter((b) => b.type === 'image' || b.type === 'document')
          .map((b) => { try { return Buffer.from(b.source.data, 'base64').toString('latin1'); } catch (e) { return ''; } }).join('\n');
        const hit = bytes.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'record_k1') return answer(bytes);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create, K1S };
