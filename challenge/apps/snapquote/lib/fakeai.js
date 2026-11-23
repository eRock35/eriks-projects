// A stand-in Anthropic client for local runs and tests (SNAPQUOTE_FAKE_AI=1).
//
// It answers every forced tool with a plausible, deterministic shape, so the
// whole product - draft, tiers, polish, follow-up, the public page, the
// scoreboard - can be driven without a key and without spending anything. It
// is refused on Cloud Run: a deployment that quietly answered with canned
// quotes would look like it works.

if (process.env.SNAPQUOTE_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('SNAPQUOTE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, usage) {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'fake',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: usage || { input_tokens: 1400, output_tokens: 600 },
  };
}

const BOOK = {
  Painting: {
    title: 'Interior repaint - living room & hallway',
    scope: 'We will protect floors and furniture, patch and sand wall damage, then apply two coats of premium eggshell to the living room and hallway walls, with ceilings and trim cut in cleanly. We clean up fully at the end of each day.',
    items: [
      { description: 'Surface prep: patch, sand & caulk', category: 'labor', qty: 5, unit: 'hr', unitPrice: 75 },
      { description: 'Paint walls, 2 coats (approx. 620 sq ft)', category: 'labor', qty: 14, unit: 'hr', unitPrice: 75 },
      { description: 'Premium eggshell paint', category: 'material', qty: 5, unit: 'gal', unitPrice: 52 },
      { description: 'Primer for patched areas', category: 'material', qty: 1, unit: 'gal', unitPrice: 34 },
      { description: 'Tape, plastic, drop cloths & sundries', category: 'material', qty: 1, unit: 'lot', unitPrice: 45 },
    ],
    tiers: [
      { key: 'good', label: 'Walls only', summary: 'Fresh walls in a durable eggshell - the essentials done right.', items: [] },
      { key: 'better', label: 'Walls + trim', summary: 'Walls plus baseboards and door frames in semi-gloss for a finished look.', items: [
        { description: 'Trim & door frames, semi-gloss', category: 'labor', qty: 6, unit: 'hr', unitPrice: 75 },
        { description: 'Semi-gloss trim enamel', category: 'material', qty: 1, unit: 'gal', unitPrice: 58 },
      ] },
      { key: 'best', label: 'Full refresh', summary: 'Walls, trim and ceilings - the whole room looks brand new.', items: [
        { description: 'Trim & door frames, semi-gloss', category: 'labor', qty: 6, unit: 'hr', unitPrice: 75 },
        { description: 'Ceilings, flat white, 1 coat', category: 'labor', qty: 6, unit: 'hr', unitPrice: 75 },
        { description: 'Trim enamel + ceiling paint', category: 'material', qty: 3, unit: 'gal', unitPrice: 48 },
      ] },
    ],
  },
  Landscaping: {
    title: 'Front yard cleanup & fresh mulch',
    scope: 'We will clear leaves and debris, edge every bed, prune shrubs back to shape, and lay three inches of fresh hardwood mulch across the front beds. All green waste is hauled away.',
    items: [
      { description: 'Cleanup, edging & pruning (2-person crew)', category: 'labor', qty: 8, unit: 'hr', unitPrice: 65 },
      { description: 'Double-shred hardwood mulch', category: 'material', qty: 6, unit: 'yd³', unitPrice: 38 },
      { description: 'Mulch install', category: 'labor', qty: 4, unit: 'hr', unitPrice: 65 },
      { description: 'Green waste haul-away', category: 'other', qty: 1, unit: 'lot', unitPrice: 85 },
    ],
    tiers: [
      { key: 'good', label: 'Cleanup + mulch', summary: 'A tidy, fresh-looking front yard.', items: [] },
      { key: 'better', label: 'Plus shrub care', summary: 'Adds shaping and fertilising every shrub.', items: [
        { description: 'Shrub shaping & slow-release fertiliser', category: 'labor', qty: 3, unit: 'hr', unitPrice: 65 },
        { description: 'Fertiliser', category: 'material', qty: 1, unit: 'lot', unitPrice: 40 },
      ] },
      { key: 'best', label: 'Plus seasonal color', summary: 'Adds a bed of seasonal annuals by the walk.', items: [
        { description: 'Shrub shaping & slow-release fertiliser', category: 'labor', qty: 3, unit: 'hr', unitPrice: 65 },
        { description: 'Seasonal annuals, 4" pots', category: 'material', qty: 36, unit: 'ea', unitPrice: 4.5 },
        { description: 'Planting', category: 'labor', qty: 3, unit: 'hr', unitPrice: 65 },
      ] },
    ],
  },
};

const GENERIC = {
  title: 'Repair & install work',
  scope: 'We will complete the repairs described, supply all materials listed, and leave the work area clean. Anything unexpected behind walls or under floors is discussed with you before we continue.',
  items: [
    { description: 'On-site labor', category: 'labor', qty: 6, unit: 'hr', unitPrice: 75 },
    { description: 'Materials & hardware', category: 'material', qty: 1, unit: 'lot', unitPrice: 180 },
    { description: 'Trip charge & disposal', category: 'other', qty: 1, unit: 'visit', unitPrice: 45 },
  ],
  tiers: [
    { key: 'good', label: 'Repair', summary: 'Fix what is broken.', items: [] },
    { key: 'better', label: 'Repair + upgrade', summary: 'Fix it and upgrade the fixture.', items: [
      { description: 'Upgraded fixture', category: 'material', qty: 1, unit: 'ea', unitPrice: 140 },
    ] },
    { key: 'best', label: 'Repair + upgrade + warranty', summary: 'Everything, with a 2-year workmanship warranty.', items: [
      { description: 'Upgraded fixture', category: 'material', qty: 1, unit: 'ea', unitPrice: 140 },
      { description: 'Extended 2-yr workmanship warranty', category: 'other', qty: 1, unit: 'job', unitPrice: 95 },
    ] },
  ],
};

function textOf(params) {
  const c = params.messages[0].content;
  if (typeof c === 'string') return c;
  return c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function draft(params) {
  const text = textOf(params);
  const images = Array.isArray(params.messages[0].content)
    ? params.messages[0].content.filter((b) => b.type === 'image').length : 0;
  const trade = (text.match(/TRADE: (.+)/) || [])[1] || '';
  const book = BOOK[trade.trim()] || GENERIC;
  const wantTiers = /OPTIONS REQUESTED: yes/.test(text);
  const items = JSON.parse(JSON.stringify(book.items));
  // Tests use this to prove model text is cleaned before it is stored.
  if (/INJECT/.test(text)) items[0].description = '<script>alert(1)</script>Prep work';
  // ...and this to prove the server clamps numbers rather than trusting them.
  if (/BADNUMBERS/.test(text)) {
    items.push({ description: 'Negative line', category: 'material', qty: -4, unit: 'ea', unitPrice: -100 });
    items.push({ description: 'Absurd line', category: 'nonsense', qty: 'lots', unitPrice: 1e12 });
  }
  return toolUse('draft_quote', {
    title: book.title,
    scope: book.scope + (images ? ` (Estimated from ${images} photo${images > 1 ? 's' : ''}.)` : ''),
    items,
    ...(wantTiers ? { tiers: JSON.parse(JSON.stringify(book.tiers)) } : {}),
    assumptions: ['Clear access to the work area during working hours.', 'Quantities estimated from photos; final measurements confirmed on day one.'],
    exclusions: ['Permits, if the city requires them.', 'Repairs to anything hidden that we find once work starts.'],
    timeline: '2 days on site; can start within a week of acceptance.',
    // A model that "helps" with totals. Ignored, and the tests prove it.
    total: 1,
  }, { input_tokens: 1400 + images * 1100, output_tokens: 900 });
}

function polish(params) {
  const text = textOf(params);
  const friendly = /friendly/.test(params.system);
  const scope = (text.match(/"""\n([\s\S]*?)\n"""/) || [])[1] || 'the work';
  return toolUse('polish_scope', {
    scope: friendly
      ? `Thanks for having us out! Here is the plan: ${scope.replace(/^We will/, 'we will')} We'll keep you in the loop every step of the way.`
      : `Scope of work: ${scope} All work is performed to manufacturer specifications and completed to a professional standard.`,
  }, { input_tokens: 500, output_tokens: 180 });
}

function followUp(params) {
  const text = textOf(params);
  const who = ((text.match(/CUSTOMER: (.+)/) || [])[1] || 'there').split(' ')[0];
  const biz = ((text.match(/BUSINESS: ([^(]+)/) || [])[1] || 'us').trim();
  return toolUse('follow_up', {
    sms: `Hi ${who}, it's ${biz} - just checking you got the quote OK. Any questions I can answer, or would you like to pick a start date?`,
    emailSubject: 'Following up on your quote',
    emailBody: `Hi ${who},\n\nJust following up on the quote we sent over. If anything in it needs adjusting - scope, timing or budget - reply here and we'll sort it out. If you're ready to go ahead, you can accept right from the quote page and we'll get you on the calendar.\n\nAnd if now isn't the right time, no problem at all - just let us know.\n\nThanks,\n${biz}`,
  }, { input_tokens: 400, output_tokens: 220 });
}

function create() {
  return {
    messages: {
      async create(params) {
        // A stand-in provider failure, for the tests: UPSTREAM401 anywhere in
        // the messages throws what the SDK would, raw JSON and all.
        const up = JSON.stringify(params.messages || '').match(/UPSTREAM(\d{3})/);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice && params.tool_choice.name;
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        await new Promise((r) => setTimeout(r, Number(process.env.SNAPQUOTE_FAKE_DELAY_MS || 0)));
        if (name === 'draft_quote') return draft(params);
        if (name === 'polish_scope') return polish(params);
        if (name === 'follow_up') return followUp(params);
        throw new Error(`fake ai: no answer for ${name}`);
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * The stand-in for Gemini (SNAPQUOTE_AI_PROVIDER=gemini): given the body the
 * guard's Vertex helper would send, an answer in the shape the schema asks
 * for - line items with a task, a quantity, a unit, materials and a
 * confidence. Every request is kept in `geminiCalls` with the media replaced
 * by its length.
 *
 * Triggers, in the media's bytes or the typed note:
 *   BLANK        not a job (relevant: false) - a 422
 *   EMPTY        a job, but no line items - a 422
 *   UNSURE       every line low confidence, quantities null
 *   MONEY        a model that prices anyway: amounts in its words, and
 *                unitPrice / total fields the schema never asked for
 *   INJECT       markup in a task
 *   UPSTREAMnnn  the call fails the way the helper's VertexError does
 * ------------------------------------------------------------------ */

const READS = {
  Painting: {
    title: 'Interior repaint - living room & hallway',
    items: [
      { task: 'Patch and sand nail holes, 2 walls', category: 'labor', quantity: 3, unit: 'hr', materials: '', confidence: 'high' },
      { task: 'Paint walls, 2 coats (approx. 620 sq ft)', category: 'labor', quantity: 14, unit: 'hr', materials: '', confidence: 'medium' },
      { task: 'Eggshell wall paint', category: 'material', quantity: 5, unit: 'gal', materials: 'premium eggshell', confidence: 'high' },
      { task: 'Primer for patched areas', category: 'material', quantity: 1, unit: 'gal', materials: '', confidence: 'medium' },
      { task: 'Seal and repaint ceiling water stain', category: 'labor', quantity: null, unit: 'hr', materials: 'stain-blocking primer', confidence: 'low' },
    ],
    questions: ['The size of the ceiling stain was not clear in the photos.', 'Ceiling height was not mentioned.'],
  },
  Landscaping: {
    title: 'Front yard cleanup & fresh mulch',
    items: [
      { task: 'Cleanup, edging and pruning', category: 'labor', quantity: 8, unit: 'hr', materials: '', confidence: 'medium' },
      { task: 'Hardwood mulch, 3 inches deep', category: 'material', quantity: 6, unit: 'yd³', materials: 'double-shred hardwood', confidence: 'high' },
      { task: 'Mulch install', category: 'labor', quantity: 4, unit: 'hr', materials: '', confidence: 'medium' },
      { task: 'Green waste haul-away', category: 'other', quantity: 1, unit: 'lot', materials: '', confidence: 'low' },
    ],
    questions: ['Bed area was estimated from one photo.'],
  },
};
const READ_GENERIC = {
  title: 'Repair & install work',
  items: [
    { task: 'On-site repair labor', category: 'labor', quantity: 6, unit: 'hr', materials: '', confidence: 'medium' },
    { task: 'Materials and hardware', category: 'material', quantity: 1, unit: 'lot', materials: '', confidence: 'low' },
    { task: 'Trip charge and disposal', category: 'other', quantity: 1, unit: 'visit', materials: '', confidence: 'medium' },
  ],
  questions: ['What is behind the wall was not visible.'],
};

const geminiCalls = [];
async function gemini(body) {
  const parts = (body && body.contents && body.contents[0] && body.contents[0].parts) || [];
  const media = parts.filter((p) => p.inlineData);
  const text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n');
  const bytes = media.map((p) => Buffer.from(p.inlineData.data, 'base64').toString('latin1')).join('\n');
  geminiCalls.push({
    schema: Object.keys((((body || {}).generationConfig || {}).responseSchema || {}).properties || {}),
    systemInstruction: body && body.systemInstruction,
    parts: parts.map((p) => (p.inlineData ? { inlineData: { mimeType: p.inlineData.mimeType, data: `<${p.inlineData.data.length} chars>` } } : p)),
  });
  await new Promise((r) => setTimeout(r, Number(process.env.SNAPQUOTE_FAKE_DELAY_MS || 0)));
  const note = (/<<<NOTE\n([\s\S]*)\nNOTE>>>/.exec(text) || [])[1] || '';
  const source = `${bytes}\n${note}`;
  const hit = source.match(/UPSTREAM(\d{3})/);
  if (hit) throw Object.assign(new Error(`Gemini answered ${hit[1]}. stand-in provider failure`), { name: 'VertexError', code: 'http', status: Number(hit[1]) });
  const trade = ((text.match(/The trade is ([A-Za-z]+)\./) || [])[1] || '').trim();
  const book = JSON.parse(JSON.stringify(READS[trade] || READ_GENERIC));
  const audio = media.some((p) => /^audio\//.test(p.inlineData.mimeType));
  const out = {
    relevant: true,
    title: book.title,
    heard: audio ? 'Walls only in the living room and hall, some nail holes to patch, and one water stain on the ceiling. They want it done before the 15th.' : '',
    items: book.items,
    questions: book.questions,
  };
  if (/BLANK/.test(source)) return { ...out, relevant: false, items: [], questions: [] };
  if (/EMPTY/.test(source)) return { ...out, items: [] };
  if (/UNSURE/.test(source)) out.items = out.items.map((it) => ({ ...it, quantity: null, confidence: 'low' }));
  if (/INJECT/.test(source)) out.items[0].task = '<script>alert(1)</script>Prep work';
  if (/MONEY/.test(source)) {
    out.items[0] = { ...out.items[0], task: `${out.items[0].task} for $1,200`, materials: 'about 45 dollars of filler', unitPrice: 999, price: 5000, total: 5000 };
    out.title = `${out.title} - $4,800 all in`;
    out.total = 4800; out.tax = 384; out.margin = 2000; out.subtotal = 4416;
    out.questions = ['Budget was said to be $5,000.'];
  }
  return out;
}

module.exports = { create, gemini, geminiCalls };
