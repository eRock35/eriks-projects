// Claude, as a writing partner for the blog.
//
// Admin-only. This is the one route on the whole service that spends money per
// request, so it sits behind the admin session AND a daily call cap — the same
// reasoning as the per-run caps on the other apps: a stuck client or a retry
// loop should cost a rounding error, not a bill.
//
// The model never publishes and never sends. It returns text into the editor,
// and a human presses the buttons. That mirrors the confirm-before-save shape
// used for itinerary changes in the trip apps, and it matters more here,
// because a newsletter cannot be recalled.

const Anthropic = require('@anthropic-ai/sdk');
const { store } = require('./store');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const DAILY_CALL_CAP = Number(process.env.AI_DAILY_CALL_CAP || 100);

let client = null;
// Set by the server once identity exists - see dataviz/lib/shape.js.
let metering = (c) => c;
function useMeter(fn) { metering = fn || ((c) => c); client = null; }
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('Claude is not configured on this deployment.');
    err.code = 'ai-disabled';
    throw err;
  }
  if (!client) client = metering(new Anthropic()); // reads ANTHROPIC_API_KEY from env
  return client;
}

function enabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function checkQuota() {
  const db = store();
  const today = new Date().toISOString().slice(0, 10);
  const current = (await db.get('control', 'ai-usage')) || {};
  const count = current.day === today ? Number(current.count || 0) : 0;
  if (count >= DAILY_CALL_CAP) {
    const err = new Error(`Daily limit of ${DAILY_CALL_CAP} Claude calls reached. It resets at midnight UTC.`);
    err.code = 'ai-quota';
    throw err;
  }
  await db.set('control', 'ai-usage', { day: today, count: count + 1 });
  return DAILY_CALL_CAP - count - 1;
}

const VOICE = `You are helping Erik Strong write for his personal site.

Who he is: Sr. Director of Sales Intelligence and Customer Insights at Equifax
Workforce Solutions, where he runs sales intelligence and customer insights across Commercial,
Government, Risk and Public Safety, has led AI adoption across the
organization, and still writes code. Two patents in synthetic fraud detection.
Based in Atlanta. He calls himself a coach player: he leads teams and still
builds alongside them.

How he sounds: direct, concrete, first person. Short sentences. Specific
examples over abstractions. He is writing for peers in data, AI and sales
leadership, not marketing copy for strangers.

Rules:
- No hype words: revolutionary, game-changing, unlock, leverage as a verb,
  "in today's fast-paced world", "it's not just X, it's Y".
- No em-dashes. Use a comma, a colon, or a new sentence.
- Never invent a fact, number, customer, or outcome. If a claim needs a number
  Erik has not given you, leave a clearly marked [TK] placeholder instead.
- Plain Markdown only: paragraphs, ## subheadings, - lists, **bold**, links.
  Never open with a level-one heading; the title is handled separately.`;

const MODES = {
  draft: {
    max: 16000,
    instruction: `Turn the notes below into a finished post. Keep every specific
Erik gave you and do not pad it out. Aim for the length the material actually
supports, usually 400 to 900 words. Return only the post body in Markdown.`,
  },
  tighten: {
    max: 16000,
    instruction: `Tighten the draft below. Cut repetition and filler, make the
weak sentences concrete, and keep his voice and every fact exactly as written.
Do not change the argument or add new claims. Return only the edited body.`,
  },
  expand: {
    max: 16000,
    instruction: `Develop the draft below: keep the structure and argument, but
give the thin sections the detail they are missing, using only what is already
here or is general knowledge. Mark anything that needs a real number as [TK].
Return only the edited body.`,
  },
  outline: {
    max: 4000,
    instruction: `Propose an outline for a post on this topic: a working title,
then four to six section headings with one line each on what that section
argues. Return it as Markdown.`,
  },
  ideas: {
    max: 4000,
    instruction: `Suggest six specific things Erik could write about, drawn from
what he actually does. One line each: the angle, and who it is for. Avoid
generic listicles.`,
  },
  meta: {
    max: 2000,
    instruction: `Read the post and return EXACTLY three lines, no preamble:
TITLE: a title under 70 characters, plain and specific, no colon-subtitle
EXCERPT: one sentence, under 160 characters, that makes a peer want to read it
SUBJECT: an email subject line under 60 characters, not clickbait`,
  },
};

/**
 * @param {string} mode  one of MODES
 * @param {{title?:string, body?:string, notes?:string, instruction?:string}} input
 */
async function assist(mode, input = {}) {
  const spec = MODES[mode];
  if (!spec) throw Object.assign(new Error(`Unknown mode "${mode}".`), { code: 'bad-mode' });

  const remaining = await checkQuota();

  const parts = [spec.instruction];
  if (input.title) parts.push(`\nWorking title: ${input.title}`);
  if (input.notes) parts.push(`\nNotes from Erik:\n"""\n${input.notes}\n"""`);
  if (input.body) parts.push(`\nCurrent draft:\n"""\n${input.body}\n"""`);
  if (input.instruction) parts.push(`\nExtra instruction from Erik: ${input.instruction}`);

  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: spec.max,
    system: VOICE,
    messages: [{ role: 'user', content: parts.join('\n') }],
  });

  if (response.stop_reason === 'refusal') {
    throw Object.assign(new Error('Claude declined that request.'), { code: 'refusal' });
  }

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  const out = { mode, text, remaining, model: response.model };
  if (mode === 'meta') {
    const pick = (label) => {
      const m = text.match(new RegExp(`^${label}:\\s*(.+)$`, 'mi'));
      return m ? m[1].trim() : '';
    };
    out.title = pick('TITLE');
    out.excerpt = pick('EXCERPT');
    out.subject = pick('SUBJECT');
  }
  return out;
}

module.exports = { useMeter, assist, enabled, MODEL, MODES: Object.keys(MODES) };
