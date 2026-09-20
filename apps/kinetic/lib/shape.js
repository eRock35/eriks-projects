// Deciding what the data IS, and which animation suits it.
//
// The model never sees more than a sample and never emits a single data
// point. It returns a MAPPING - which column is the name, the time, the
// value - and the server builds every frame from the full table itself.
//
// That is the whole design. A model asked to re-emit a table will quietly
// round, reorder or invent numbers, and a chart that lies is worse than no
// chart. It also means a 2,000-row table costs exactly as much to interpret
// as a 20-row one.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.SHAPE_MODEL || 'claude-opus-5';
const SAMPLE_ROWS = 12;

let client = null;
function anthropic() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const VIZ_TYPES = ['race', 'line', 'bars', 'flow'];

const SYSTEM = `You look at a table and decide how to bring it to life.

The person wants motion. They are not after a static chart - they want the
thing that makes people stop scrolling: bars overtaking each other over time,
a line drawing itself, quantities flowing between places. Choose the type that
genuinely fits the data, not the flashiest one. A race with two time periods
is not a race, and a flow with no from/to pair is not a flow.

The four types, and what each needs:

  race   Ranked bars that reorder as time advances. Needs a NAME column, a
         TIME column with at least 3 distinct values, and a VALUE column.
         This is the most captivating option when the data supports it.
  line   One or more series drawn progressively left to right. Needs an X
         column (time or ordered) and at least one numeric column. Use when
         the shape of the trend matters more than the ranking.
  bars   A single ranked snapshot that grows in. Needs a NAME and a VALUE.
         The right answer when there is no time dimension at all.
  flow   Particles moving along links. Needs a FROM column, a TO column and a
         VALUE column. Only when the rows genuinely describe movement between
         places or categories.

Rules:
- Use the exact column names given to you. Do not invent or rename them.
- If a column holds numbers written as text ("1,234", "$5.2M", "12%"), it is
  still a value column; say so in valueFormat and the server will parse it.
- If nothing fits, choose bars and say why in note.
- The title should say what the data shows, not what the chart is. "Atlanta
  overtook Denver in 2023", not "Bar chart of cities".`;

const TOOL = {
  name: 'design_visual',
  description: 'Choose the animation and map the columns onto it.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What the data shows, under 70 characters.' },
      subtitle: { type: 'string', description: 'One short line of context, or empty.' },
      vizType: { type: 'string', enum: VIZ_TYPES },
      nameCol: { type: 'string', description: 'Column holding the thing being measured (race, bars). Empty if unused.' },
      timeCol: { type: 'string', description: 'Column holding time or order (race, line). Empty if unused.' },
      valueCol: { type: 'string', description: 'Column holding the number. Empty if unused.' },
      seriesCol: { type: 'string', description: 'Column splitting line series. Empty if unused.' },
      fromCol: { type: 'string', description: 'Origin column (flow). Empty if unused.' },
      toCol: { type: 'string', description: 'Destination column (flow). Empty if unused.' },
      valueFormat: { type: 'string', enum: ['number', 'currency', 'percent', 'compact'] },
      valueLabel: { type: 'string', description: 'What the number means, e.g. "visits" or "revenue".' },
      note: { type: 'string', description: 'Anything the person should know about the reading, or empty.' },
    },
    required: ['title', 'subtitle', 'vizType', 'nameCol', 'timeCol', 'valueCol', 'seriesCol', 'fromCol', 'toCol', 'valueFormat', 'valueLabel', 'note'],
  },
};

function sampleOf(table) {
  const [header, ...rows] = table;
  const body = rows.slice(0, SAMPLE_ROWS);
  return [
    `COLUMNS: ${header.map((h) => JSON.stringify(h)).join(', ')}`,
    `ROWS (${rows.length} total, first ${body.length} shown):`,
    ...body.map((r) => '  ' + r.map((c) => JSON.stringify(c)).join(', ')),
  ].join('\n');
}

/** Ask the model for a mapping onto the real column names. */
async function design(table, hint = '') {
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'design_visual' },
    messages: [{
      role: 'user',
      content: `${sampleOf(table)}\n\n${hint ? `What they asked for: ${hint}\n\n` : ''}Design the visual.`,
    }],
  });
  const call = res.content.find((b) => b.type === 'tool_use' && b.name === 'design_visual');
  if (!call || !call.input) throw new Error('Could not read this data.');

  const spec = call.input;
  const header = table[0].map(String);
  // A mapping onto a column that does not exist would fail silently later, so
  // drop it here and let the builder fall back.
  for (const key of ['nameCol', 'timeCol', 'valueCol', 'seriesCol', 'fromCol', 'toCol']) {
    if (spec[key] && !header.includes(spec[key])) spec[key] = '';
  }
  if (!VIZ_TYPES.includes(spec.vizType)) spec.vizType = 'bars';
  return spec;
}

/** Turn loose prose into a table, for the case where nothing parsed. This one
 *  DOES emit data, so it is the fallback rather than the path. */
async function tableFromProse(prose, hint = '') {
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: 'You pull the numbers out of text into a table. Use only figures that actually appear in the text. If there are none, return an empty table rather than inventing any.',
    tools: [{
      name: 'record_table',
      description: 'The table found in the text. May be empty.',
      input_schema: {
        type: 'object',
        properties: {
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
        required: ['columns', 'rows'],
      },
    }],
    tool_choice: { type: 'tool', name: 'record_table' },
    messages: [{ role: 'user', content: `${prose.slice(0, 10000)}\n\n${hint ? `They want: ${hint}\n\n` : ''}Pull out the table.` }],
  });
  const call = res.content.find((b) => b.type === 'tool_use');
  const input = (call && call.input) || {};
  if (!Array.isArray(input.columns) || !input.columns.length || !Array.isArray(input.rows) || !input.rows.length) {
    throw new Error('No numbers to chart in that.');
  }
  return [input.columns.map(String), ...input.rows.map((r) => r.map((c) => String(c == null ? '' : c)))];
}

module.exports = { design, tableFromProse, VIZ_TYPES, MODEL };
