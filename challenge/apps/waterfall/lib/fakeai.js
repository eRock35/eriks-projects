// A stand-in Anthropic client for local runs and tests (WATERFALL_FAKE_AI=1).
//
// It answers each forced tool deterministically from what it is sent, so
// "Describe your products" (propose_recognition) and "Suggest rules for my
// products" (suggest_rules) can be driven without a key and
// without spending anything. It is refused on Cloud Run: a deployment that
// handed everyone the same canned suggestions would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not (no customer, no
// invoice id, no amount, no date).
//
// A test sets `fake.mode` for one call:
//   'blank'        no suggestions - a 422
//   'bad'          numbers that were not sent, a rule not on the list, N
//                  out of range - dropped; one good one kept
//   'inject'       markup, a bidi override and a link in the reasons, an
//                  extra field - cleaned, 200
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.WATERFALL_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('WATERFALL_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 900, output_tokens: 600 },
    ...(extra || {}),
  };
}

/** The products, read back from the prompt. */
function products(text) {
  const body = ((/<<<PRODUCTS\n([\s\S]*?)\nPRODUCTS>>>/.exec(text) || [])[1]) || '';
  return body.split('\n').map((l) => /^(\d+)\. "(.*)" - (\d+)% of its lines have a service period; line types: ([^;]*); (.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ n: Number(m[1]), d: m[2], period: Number(m[3]), types: m[4], len: m[5] }));
}

/** A plausible suggestion that uses only what it was sent. */
function suggest(p) {
  const d = p.d.toLowerCase();
  if (/onboard|setup|set-up|implementation|training/.test(d)) return { n: p.n, rule: 'months', months: 12, reason: 'Setup fees are often spread over the expected customer relationship - your accountant decides how long.' };
  if (/deposit|pass.?through|reimburse/.test(d)) return { n: p.n, rule: 'exclude', reason: 'Deposits and pass-through charges are usually not revenue.' };
  if (/usage|overage|metered|api/.test(p.types + ' ' + d)) return { n: p.n, rule: 'period', reason: 'Usage is usually recognised over the period it was used in, even when billed after.' };
  if (/credit|refund/.test(p.types + ' ' + d)) return { n: p.n, rule: p.period >= 50 ? 'period' : 'invoice', reason: 'Credits usually follow the period they apply to, or the day they are given when there is none.' };
  if (p.period >= 50) return { n: p.n, rule: 'period', reason: 'A subscription with a service period is commonly recognised over that period, by day.' };
  if (p.period === 0) return { n: p.n, rule: 'invoice', reason: 'No service period - a one-off charge usually lands on its invoice date.' };
  return { n: p.n, rule: 'unsure', reason: 'Some lines have a period and some do not - check one invoice.' };
}

/** The typed descriptions, read back from the prompt. */
function described(text) {
  const body = ((/<<<LINES\n([\s\S]*?)\nLINES>>>/.exec(text) || [])[1]) || '';
  return body.split('\n').map((l) => /^(\d+)\. "(.*)"$/.exec(l)).filter(Boolean).map((m) => ({ n: Number(m[1]), d: m[2] }));
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** The term a description states, in months - "annual", "3-year", "6 month". */
function termOf(d) {
  const y = /(\d{1,2})[- ]?(?:year|yr)/.exec(d);
  if (y) return Math.min(60, Number(y[1]) * 12);
  const m = /(\d{1,2})[- ]?(?:month|mo\b)/.exec(d);
  if (m) return Math.min(60, Number(m[1]));
  if (/annual|yearly|per year/.test(d)) return 12;
  if (/quarter/.test(d)) return 3;
  if (/monthly|per month/.test(d)) return 1;
  return null;
}
/** The promises in one description - plausible, and only from its words. */
function propose(x) {
  const d = x.d.toLowerCase();
  const parts = [];
  const setup = /\b(onboarding|setup|set-up|implementation|installation|training)( fee| and implementation| services?)?/.exec(d);
  const milestone = /milestone|go-live|go live|deliverable|phase/.test(d);
  const main = x.d.replace(/\s*(with|plus|and|\+|incl\.?|including)\s+(an?\s+)?(one-time\s+|one-off\s+)?(onboarding|setup|set-up|implementation|installation|training).*$/i, '').replace(/\s+(prepaid|paid up front|paid upfront|billed annually|billed monthly|in advance)\b.*$/i, '').trim();
  const term = termOf(d);
  const name = cap(main || d).slice(0, 58);
  if (/deposit|pass.?through|reimburs|sales tax|vat\b/.test(d)) parts.push({ name, pattern: 'exclude', start: 'none', end: 'none', principle: 'not_revenue', reason: 'A deposit or pass-through is held for someone else, so it is usually not revenue.' });
  else if (milestone && !/subscription|support|saas|licen[cs]e|plan\b/.test(d)) parts.push({ name, pattern: 'milestone', start: 'milestone_met', end: 'final_milestone', principle: 'progress', reason: 'The work is delivered in stages, so revenue usually follows each milestone as it is met.' });
  else if (/usage|overage|metered|per seat|per call|pay as you go|consumption/.test(d)) parts.push({ name, pattern: 'usage', start: 'usage_occurs', end: 'usage_period_end', principle: 'as_used', reason: 'The customer pays for what they use, so it usually lands in the period of the usage.' });
  else if (/support|maintenance|warranty|hosting/.test(d)) parts.push({ name, pattern: 'ratable', ...(term ? { months: term } : {}), start: 'service_start', end: term ? 'term_end' : 'service_end', principle: 'stand_ready', reason: 'Support is a promise to be available every day of the term' + (/prepaid|up front|upfront|advance/.test(d) ? ' - paying up front does not make it earned.' : '.') });
  else if (/subscription|saas|plan\b|membership|access|retainer|licen[cs]e.*(annual|term|month)/.test(d)) parts.push({ name, pattern: 'ratable', ...(term ? { months: term } : {}), start: 'service_start', end: term ? 'term_end' : 'service_end', principle: 'over_time', reason: 'The customer gets the service each day of the term, so it is usually spread evenly across it.' });
  else if (/hardware|device|perpetual|one-time|one-off|report|ebook|download|ticket|book\b/.test(d)) parts.push({ name, pattern: 'point', start: 'delivery', end: 'same_day', principle: 'control', reason: 'A one-off deliverable is usually recognised when the customer has it.' });
  else if (!setup) parts.push({ name, pattern: 'unsure', start: 'none', end: 'none', principle: 'unclear', reason: 'The description does not say when this is delivered - check a contract.' });
  if (setup && !(parts[0] && parts[0].pattern === 'milestone')) {
    const alone = !parts.length;
    parts.push({ name: cap(setup[0]).slice(0, 58), pattern: 'ratable', months: 12, start: 'invoice_date', end: 'term_end', principle: 'setup', reason: alone ? 'Setup work usually hands over nothing on its own, so it is often spread over the service it sets up.' : 'The fee sets up the service rather than delivering something on its own, so it is often spread over it.' });
  }
  return { n: x.n, parts };
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
        await new Promise((r) => setTimeout(r, Number(process.env.WATERFALL_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'suggest_rules' && name !== 'propose_recognition') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (name === 'propose_recognition') {
          if (mode === 'blank') return toolUse(name, { lines: [] });
          const ok = described(text).map(propose);
          if (mode === 'bad') return toolUse(name, { lines: [ok[0], { n: 0, parts: ok[0].parts }, { n: 999, parts: ok[0].parts }, { n: 2, parts: [{ name: 'x', pattern: 'sometimes', start: 'none', end: 'none', principle: 'unclear', reason: 'x' }] }, { n: 3, parts: [{ name: 'y', pattern: 'ratable', months: 99, start: 'service_start', end: 'service_end', principle: 'over_time', reason: 'x' }] }, { ...ok[0] }] });
          if (mode === 'inject') return toolUse(name, { lines: ok.map((l) => ({ ...l, extra: 'hunter2', parts: l.parts.map((q) => ({ ...q, name: '<i>' + q.name + '</i>', start: 'whenever', principle: 'ASC', principleText: 'made up', rule: 'exclude', note: 'made up', reason: '<b>' + String.fromCharCode(0x202E) + q.reason + '</b> see https://evil.example/x and mail ops' + String.fromCharCode(64) + 'evil.example <img src=x onerror=alert(1)>' })) })) });
          return toolUse(name, { lines: ok });
        }
        if (mode === 'blank') return toolUse(name, { suggestions: [] });
        const good = products(text).map(suggest);
        if (mode === 'bad') return toolUse(name, { suggestions: [good[0], { n: 0, rule: 'period', reason: 'x' }, { n: 999, rule: 'period', reason: 'x' }, { n: 2, rule: 'maybe', reason: 'x' }, { n: 3, rule: 'months', months: 99, reason: 'x' }, { ...good[0], reason: 'again' }] });
        if (mode === 'inject') return toolUse(name, { suggestions: good.map((s) => ({ ...s, reason: '<b>' + String.fromCharCode(0x202E) + s.reason + '</b> see https://evil.example/x and mail ops' + String.fromCharCode(64) + 'evil.example <img src=x onerror=alert(1)>', extra: 'hunter2' })) });
        return toolUse(name, { suggestions: good });
      },
    },
  };
  return fake;
}

module.exports = { create };
