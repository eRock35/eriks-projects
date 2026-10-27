// A stand-in Anthropic client for local runs and tests (CANON_FAKE_AI=1).
//
// It answers the two forced tools deterministically, so "Draft definitions
// from my schema" and "Explain this answer" can be driven without a key and
// without spending anything. It is refused on Cloud Run: a deployment that
// gave everyone the same canned answer would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not.
//
// The draft reads the schema the dumb way and proposes a revenue metric on
// the first table with an amount, a count on its key - and, deliberately,
// one metric and one filter that name columns that are NOT in the schema, so
// the cleaning that drops them is always exercised.
//
// Triggers, in the business sentence or the question:
//   BLANK        an answer with nothing usable in it - a 422
//   INJECT       hostile output: markup, bidi, links, oversized fields,
//                unknown verdicts, a measure on an invented column
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does

if (process.env.CANON_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('CANON_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1800, output_tokens: 700 },
    ...(extra || {}),
  };
}

function schemaOf(text) {
  const tables = [];
  for (const m of text.matchAll(/^Table ([^\s(:]+)(?: \(key ([^)]+)\))?: (.*)$/gm)) {
    tables.push({ name: m[1], key: m[2] || '', cols: m[3].split(', ').map((c) => c.split(' ')[0]) });
  }
  return tables;
}

function draftAnswer(text) {
  if (/BLANK/.test(text)) return toolUse('propose_metrics', { metrics: [] });
  if (/MAXTOKENS/.test(text)) return toolUse('propose_metrics', { metrics: [] }, { stop_reason: 'max_tokens' });
  const tables = schemaOf(text);
  const money = tables.map((t) => ({ t, c: t.cols.find((c) => /amount|total|price|revenue/.test(c)) })).find((x) => x.c);
  const first = tables[0];
  const metrics = [];
  if (money) {
    const status = money.t.cols.includes('status') ? [{ sql: `${money.t.name}.status = 'paid'`, keepsOut: 'unpaid rows' }] : [];
    metrics.push({
      name: 'Revenue', synonyms: ['sales'], meaning: 'Money from paid rows.', tables: [money.t.name],
      measure: `SUM(${money.t.name}.${money.c})`,
      filters: [...status, { sql: `${money.t.name}.is_internal = false`, keepsOut: 'internal rows' }],
      date: { column: `${money.t.name}.${money.t.cols.find((c) => /_at$|date/.test(c)) || 'created_at'}`, tz: 'America/New_York' },
      grain: `one row per ${money.t.name.replace(/s$/, '')}`, dimensions: [`${money.t.name}.channel`, `${money.t.name}.no_such_dimension`], traps: 'Do not sum a total next to its lines.',
    });
  }
  if (first) metrics.push({ name: `${first.name} count`, synonyms: [], meaning: `Distinct ${first.name}.`, tables: [first.name], measure: `COUNT(DISTINCT ${first.name}.${first.key || first.cols[0]})`, filters: [], grain: `one row per ${first.name}` });
  metrics.push({ name: 'Gross margin', synonyms: ['margin'], meaning: 'Revenue minus cost.', tables: [first ? first.name : 'x'], measure: `SUM(${first ? first.name : 'x'}.cost_of_goods_invented)`, filters: [] });
  if (/INJECT/.test(text)) {
    metrics.unshift({
      name: '<img src=x onerror=alert(1)>Evil‮ metric https://evil.example', synonyms: ['<script>alert(1)</script>'], meaning: 'Visit javascript:alert(1) <b>now</b> ' + 'x'.repeat(5000),
      tables: [first ? first.name : 'x'], measure: `SUM(${first ? `${first.name}.${first.cols[0]}` : 'x.y'}); DROP TABLE users`, filters: [{ sql: '1=1; --', keepsOut: '<b>x</b>' }], date: { column: 'x', tz: '../../etc/passwd' },
    });
    metrics.push(...Array.from({ length: 20 }, (_, i) => ({ name: `Extra ${i}`, measure: `COUNT(*)`, tables: [first ? first.name : 'x'], filters: [] })));
  }
  return toolUse('propose_metrics', { metrics, note: /INJECT/.test(text) ? '<a href="https://evil.example">click</a>' : 'No refund column in this schema.' });
}

function explainAnswer(text) {
  if (/BLANK/.test(text)) return toolUse('explain_answer', { computes: '', verdict: 'matches', differences: [] });
  if (/MAXTOKENS/.test(text)) return toolUse('explain_answer', { computes: '', differences: [] }, { stop_reason: 'max_tokens' });
  if (/INJECT/.test(text)) {
    return toolUse('explain_answer', {
      computes: '<script>alert(1)</script>It adds up‮ things. javascript:alert(1) ' + 'y'.repeat(4000), verdict: 'totally-fine',
      differences: [{ what: '<img src=x onerror=alert(1)>Refunds', canon: 'x'.repeat(900), sql: '<b>sql</b>', effect: 'up' }, ...Array.from({ length: 12 }, (_, i) => ({ what: `d${i}`, canon: 'c', sql: 's', effect: 'e' })), { what: '' }],
      fix: '<a href="https://evil.example">fix</a>',
    });
  }
  const sql = (/<<<SQL\n([\s\S]*?)\nSQL>>>/.exec(text) || [])[1] || '';
  const bad = [...text.matchAll(/^- ([^/\n]+) \/ (.+?): (missing|different)\b/gm)];
  const differences = bad.map((m) => ({ what: m[2].trim(), canon: 'As the definition says.', sql: 'The SQL does it differently.', effect: 'The number is off.' }));
  return toolUse('explain_answer', {
    computes: `It ${/SUM\(/i.test(sql) ? 'adds up an amount' : /COUNT\(/i.test(sql) ? 'counts rows' : 'returns rows'} from ${(/FROM\s+([A-Za-z_."`]+)/i.exec(sql) || [])[1] || 'a table'}.`,
    verdict: differences.length ? 'differs' : 'matches',
    differences,
    fix: differences.length ? 'Apply the missing parts of the definition.' : '',
  });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params);
        await new Promise((r) => setTimeout(r, Number(process.env.CANON_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = text.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'propose_metrics') return draftAnswer(text);
        if (params.tool_choice.name === 'explain_answer') return explainAnswer(text);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
