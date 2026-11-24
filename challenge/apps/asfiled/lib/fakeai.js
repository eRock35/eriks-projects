// A stand-in Anthropic client for tests and a laptop (ASFILED_FAKE_AI=1).
// Refused on Cloud Run: a deployment that answered from a script would look
// like it works.
//
// It reads the numbered sentences it is sent (lib/relations.js prompt) and
// proposes an edge for each one whose own words fit a relationship word,
// quoting the whole sentence. That is all it knows; like the real model it
// decides nothing - every proposal still meets the verifier.
//
// `calls` keeps every request. A test sets `mode` for the next call:
//   'badquote'   adds a plausible relationship whose quote is in no sentence
//   'wrongname'  adds a real sentence as the quote for a company it does not name
//   'stitched'   adds a quote made of the end of one sentence and the start of the next
//   'garbage'    the answer is not JSON
//   'refusal'    stop_reason "refusal"
//   'error'      the call fails the way the SDK's APIError does

if (process.env.ASFILED_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('ASFILED_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function parse(text) {
  const out = [];
  const re = /\[(\d+)\] ([\s\S]*?)\nNamed: ([^\n]*)/g;
  let m;
  while ((m = re.exec(text))) out.push({ n: Number(m[1]), sentence: m[2], named: m[3].split('; ').map((x) => x.split(' = ')[0]) });
  return out;
}
function typeOf(s) {
  if (/compet/i.test(s)) return 'competitor';
  if (/\bcustomers?\b|accounted for/i.test(s)) return 'customer';
  if (/suppl|vendor|rel(y|ies) on|manufactur|purchas|provider/i.test(s)) return 'supplier';
  if (/partner|alliance|joint venture/i.test(s)) return 'partner';
  return null;
}

function create() {
  const fake = {
    calls: [], mode: null,
    messages: {
      create(params) {
        fake.calls.push(params);
        const mode = fake.mode; fake.mode = null;
        if (mode === 'error') { const e = new Error('529 overloaded'); e.status = 529; return Promise.reject(e); }
        const user = String(params.messages[0].content);
        const sent = parse(user);
        const edges = [];
        for (const p of sent) {
          const type = typeOf(p.sentence);
          if (!type || p.sentence.length > 600) continue;
          for (const id of p.named) edges.push({ n: p.n, counterparty: id, type, quote: p.sentence });
        }
        if (mode === 'badquote' && sent[0]) edges.push({ n: sent[0].n, counterparty: sent[0].named[0], type: 'supplier', quote: 'We depend on this company as the sole supplier of the data our products are built on.' });
        if (mode === 'wrongname' && sent.length > 1) { const other = sent.find((x) => !x.named.includes(sent[0].named[0])); if (other) edges.push({ n: other.n, counterparty: sent[0].named[0], type: 'partner', quote: other.sentence }); }
        if (mode === 'stitched' && sent.length > 1) edges.push({ n: sent[0].n, counterparty: sent[0].named[0], type: 'partner', quote: `${sent[0].sentence} ${sent[1].sentence}`.slice(0, 600) });
        const text = mode === 'garbage' ? 'Here are the relationships I found:' : JSON.stringify({ edges });
        return Promise.resolve({
          id: 'msg_fake', type: 'message', role: 'assistant', model: params.model,
          stop_reason: mode === 'refusal' ? 'refusal' : 'end_turn',
          content: mode === 'refusal' ? [] : [{ type: 'text', text }],
          // About four characters a token, so a test can read a size from it.
          usage: { input_tokens: Math.ceil((String(params.system).length + user.length) / 4), output_tokens: Math.ceil(text.length / 4) },
        });
      },
    },
  };
  return fake;
}

module.exports = { create, parse };
