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
//
// 96 is four batches, which at six runs a day is ~24 model calls. The first
// value here was 240, and ten verification runs at that size were enough to
// exhaust the API credit shared across every app on this account. A monitor
// that takes the whole budget is not a monitor. Read less, more often: the
// seen-set means nothing is read twice anyway, so a lower cap costs coverage
// only on the day a topic suddenly floods.
const MAX_ITEMS_PER_RUN = Number(process.env.MAX_ITEMS_PER_RUN || 96);

const WEIGHTS = { intensity: 0.3, budget: 0.3, frequency: 0.15, whitespace: 0.15, feasibility: 0.1 };

let client = null;
// Set by the server once identity exists - see the note in dataviz/lib/shape.js.
let metering = (c) => c;
function useMeter(fn) { metering = fn || ((c) => c); client = null; }
function anthropic() {
  if (!client) client = metering(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
  return client;
}

const SYSTEM = `You read what people write online and identify problems worth building a product around.

What you are reading: a TOPICAL feed, not a curated list of complaints. The
items were pulled by subject keyword, so most of them are ordinary discussion,
news or opinion with no problem in them at all. Your job is to find the few
where somebody describes a concrete operational problem they actually have.

You are reading on behalf of one specific person, and the fit matters:
he is a senior data and analytics leader in financial services - lending,
mortgage, auto, card, consumer finance, debt management, risk, fraud, and
public sector. He can reach buyers in those markets directly and has shipped
revenue-generating internal products. He builds small and ships fast. He
cannot outspend an incumbent or buy a data moat.

The bar is SPECIFICITY, not repetition. Record a problem when a single item
describes it concretely enough to act on: a named tool, a named workflow, an
hour count, a cost, a headcount, a number. Two items describing the same
problem is stronger evidence and worth saying so, but it is NOT required -
this system tracks how often a problem recurs across days by itself, so one
well-specified sighting today is worth recording and will be confirmed or
forgotten on its own.

What does not clear the bar: vague dissatisfaction, "X is bad", predictions,
opinions about an industry, or anything where you cannot name who has the
problem and what it costs them.

Other rules you must follow:

- Never invent evidence. Every quote must appear verbatim in the items given
  to you, and must carry the item id it came from.
- An empty list is a correct and expected answer for a batch that is all
  discussion and no problems. Say so rather than manufacturing something.
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

/** A 400 with a JSON blob in it tells you nothing at a glance, and the one
 *  failure that matters most - no credit left - looks like every other 400. */
function explain(err) {
  const raw = String((err && err.message) || err);
  if (/credit balance is too low/i.test(raw)) {
    return 'Anthropic credit exhausted. Scans cannot score anything until the account is topped up '
      + '(this key is shared with every other app on the account).';
  }
  if (/rate_limit|429/i.test(raw)) return 'Anthropic rate limit hit. The next scheduled run will pick these items up.';
  if (/overloaded|529/i.test(raw)) return 'Anthropic overloaded. The next scheduled run will pick these items up.';
  return raw.slice(0, 200);
}

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
      errors.push({ lens: lensLabel, message: explain(err) });
    }
  }
  return { problems: out, errors, examined: capped.length, skipped: items.length - capped.length };
}

module.exports = { useMeter, scoreItems, scoreBatch, composite, MODEL, BATCH_SIZE, MAX_ITEMS_PER_RUN, WEIGHTS };
