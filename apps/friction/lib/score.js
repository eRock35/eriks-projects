// Turning raw complaints into scored problems.
//
// The hard part is not finding complaints, it is refusing to promote noise.
// A model asked "find opportunities in this text" will always find ten. The
// prompt below therefore sets a floor - corroboration or unusual specificity -
// and says plainly that returning nothing is a correct answer. Scores mean
// nothing if everything scores well.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.SCAN_MODEL || 'claude-opus-5';
const BATCH_SIZE = 24;
// A hard ceiling on one run, so a burst of matching posts can never turn into
// an unbounded Anthropic bill overnight while nobody is watching.
const MAX_ITEMS_PER_RUN = Number(process.env.MAX_ITEMS_PER_RUN || 240);

const WEIGHTS = { intensity: 0.3, budget: 0.3, frequency: 0.15, whitespace: 0.15, feasibility: 0.1 };

let client = null;
function anthropic() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const SYSTEM = `You read what people write online and identify problems worth building a product around.

You are reading on behalf of one specific person, and the fit matters:
he is a senior data and analytics leader in financial services - lending,
mortgage, auto, card, consumer finance, debt management, risk, fraud, and
public sector. He can reach buyers in those markets directly and has shipped
revenue-generating internal products. He builds small and ships fast. He
cannot outspend an incumbent or buy a data moat.

Rules you must follow:

- Only record a problem if at least TWO separate items describe it, or ONE
  describes it with unusual operational specificity (named tool, named
  workflow, a number, a real cost). Vague dissatisfaction is not a problem.
- Never invent evidence. Every quote must appear verbatim in the items given
  to you, and must carry the item id it came from.
- Returning an empty list is a correct and expected answer. Most batches do
  not contain a real opportunity. Say so rather than manufacturing one.
- Describe the problem, not a product. "Reconciling three payment processors
  by hand every month" is a problem. "An AI reconciliation platform" is not.
- Be skeptical about existing tools. If something already solves this well,
  say so in existingTools and score whitespace low.

Scoring, each 0-10, and use the whole range:
  frequency   how often this comes up, judged from these items alone
  intensity   how much it actually hurts - money, hours, risk, or headcount
  budget      whether whoever has it can authorize spend to fix it
  feasibility whether a small team could ship something useful in weeks
  whitespace  how poorly current tools cover it (10 = nothing good exists)`;

const TOOL = {
  name: 'record_problems',
  description: 'Record the distinct, corroborated problems found in this batch. May be empty.',
  input_schema: {
    type: 'object',
    properties: {
      problems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'Short kebab-case identifier for the problem, stable across batches, e.g. "orphaned-saas-access-after-offboarding".' },
            title: { type: 'string', description: 'Plain description of the problem, under 80 characters.' },
            summary: { type: 'string', description: 'One or two sentences on what goes wrong and why it persists.' },
            who: { type: 'string', description: 'Who specifically has this problem and would pay to fix it.' },
            existingTools: { type: 'string', description: 'What people already use and where it falls short. Say "none named" if nobody mentioned one.' },
            angle: { type: 'string', description: 'Why someone with financial-services distribution and fast shipping could win this specifically. Say "no particular edge" when that is the honest answer.' },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  itemId: { type: 'string', description: 'The id of the item this quote came from.' },
                  quote: { type: 'string', description: 'A verbatim quote, under 300 characters.' },
                },
                required: ['itemId', 'quote'],
              },
            },
            scores: {
              type: 'object',
              properties: {
                frequency: { type: 'number' },
                intensity: { type: 'number' },
                budget: { type: 'number' },
                feasibility: { type: 'number' },
                whitespace: { type: 'number' },
              },
              required: ['frequency', 'intensity', 'budget', 'feasibility', 'whitespace'],
            },
          },
          required: ['slug', 'title', 'summary', 'who', 'existingTools', 'angle', 'evidence', 'scores'],
        },
      },
    },
    required: ['problems'],
  },
};

function composite(scores) {
  let total = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    total += (Number(scores[k]) || 0) * w;
  }
  return Math.round(total * 10) / 10;
}

function renderItems(items) {
  return items.map((it) => [
    `<item id="${it.id}" from="${it.channel}" votes="${it.votes}" comments="${it.comments}">`,
    it.title ? `TITLE: ${it.title}` : '',
    it.text ? `BODY: ${it.text.slice(0, 1200)}` : '',
    '</item>',
  ].filter(Boolean).join('\n')).join('\n\n');
}

/** One batch through the model. Returns problems with a composite score added. */
async function scoreBatch(items, lensLabel) {
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'record_problems' },
    messages: [{
      role: 'user',
      content: `These are recent posts and comments from the "${lensLabel}" market.\n\n`
        + `${renderItems(items)}\n\n`
        + `Record the problems that clear the bar. Empty is fine.`,
    }],
  });

  const call = res.content.find((b) => b.type === 'tool_use' && b.name === 'record_problems');
  const problems = (call && call.input && call.input.problems) || [];
  const validIds = new Set(items.map((i) => i.id));

  return problems.map((p) => {
    // Drop evidence pointing at items that were not in this batch: that is
    // the signature of a fabricated quote, and it is cheap to check.
    const evidence = (p.evidence || []).filter((e) => validIds.has(e.itemId));
    return Object.assign({}, p, { evidence, score: composite(p.scores || {}) });
  }).filter((p) => p.evidence.length > 0);
}

/** Every batch for one lens, capped. */
async function scoreItems(items, lensLabel) {
  const capped = items.slice(0, MAX_ITEMS_PER_RUN);
  const out = [];
  const errors = [];
  for (let i = 0; i < capped.length; i += BATCH_SIZE) {
    const batch = capped.slice(i, i + BATCH_SIZE);
    try {
      out.push(...await scoreBatch(batch, lensLabel));
    } catch (err) {
      errors.push({ lens: lensLabel, message: err.message });
    }
  }
  return { problems: out, errors, examined: capped.length, skipped: items.length - capped.length };
}

module.exports = { scoreItems, scoreBatch, composite, MODEL, BATCH_SIZE, MAX_ITEMS_PER_RUN, WEIGHTS };
