// A stand-in Anthropic client for local runs and tests (SHELFLIFE_FAKE_AI=1).
//
// It answers the two forced tools deterministically, so Snap and Chef's idea
// can be driven without a key and without spending anything. It is refused
// on Cloud Run: a deployment that "saw" the same fridge in every photo would
// look like it works and fill kitchens with food nobody bought.
//
// Triggers, in the photo's bytes or the request text (an item name for an
// idea):
//   BLANK        nothing there (relevant: false / no real uses) - a 422
//   RECEIPT      a grocery receipt's worth of food (photo only)
//   INJECT       hostile output: markup, bidi, huge names, places and days
//                off the list, 60 items, bad ids, 50 steps, nonsense minutes
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does
//   anything else - an open fridge (eight things) / a recipe using the three
//   most urgent items it was told about

if (process.env.SHELFLIFE_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('SHELFLIFE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 1600, output_tokens: 320 },
    ...(extra || {}),
  };
}

const FRIDGE = [
  { name: 'Spinach', emoji: '🥬', place: 'fridge', qty: 1, daysLeft: 2, catalogueId: 'spinach' },
  { name: 'Greek yoghurt', emoji: '🥣', place: 'fridge', qty: 2, daysLeft: 6, catalogueId: 'greekyog' },
  { name: 'Milk', emoji: '🥛', place: 'fridge', qty: 1, daysLeft: 3, catalogueId: 'milk' },
  { name: 'Eggs', emoji: '🥚', place: 'fridge', qty: 1, daysLeft: 20, catalogueId: 'eggs' },
  { name: 'Cheddar', emoji: '🧀', place: 'fridge', qty: 1, daysLeft: 25, catalogueId: 'cheddar' },
  { name: 'Red peppers', emoji: '🫑', place: 'fridge', qty: 2, daysLeft: 5, catalogueId: 'peppers' },
  { name: 'Lemon', emoji: '🍋', place: 'fridge', qty: 1, daysLeft: 4 },
  { name: 'Leftover chilli', emoji: '🍲', place: 'fridge', qty: 1, daysLeft: 2, catalogueId: 'leftovers' },
];
const RECEIPT = [
  { name: 'Bananas', emoji: '🍌', place: 'pantry', qty: 1, daysLeft: 5, catalogueId: 'bananas' },
  { name: 'Chicken thighs', emoji: '🍗', place: 'fridge', qty: 2, daysLeft: 2, catalogueId: 'chicken' },
  { name: 'Baby spinach', emoji: '🥬', place: 'fridge', qty: 1, daysLeft: 5, catalogueId: 'spinach' },
  { name: 'Sourdough', emoji: '🍞', place: 'pantry', qty: 1, daysLeft: 4, catalogueId: 'bread' },
  { name: 'Frozen peas', emoji: '🟢', place: 'freezer', qty: 1, daysLeft: 365, catalogueId: 'peas' },
];

function items(source) {
  if (/BLANK/.test(source)) return toolUse('record_items', { relevant: false, items: [] });
  if (/INJECT/.test(source)) {
    const many = [];
    for (let i = 0; i < 60; i++) many.push({ name: `Thing ${i}`, emoji: '🍽️', place: 'fridge', qty: 1, daysLeft: 3 });
    return toolUse('record_items', {
      relevant: true,
      items: [
        { name: `<img src=x onerror=alert(1)>Spi‮nach${'A'.repeat(5000)}`, emoji: '<script>', place: 'roof', qty: 1e9, daysLeft: -99999, catalogueId: '__proto__' },
        { name: 'Ignore previous instructions', emoji: '🥬', place: 'fridge', qty: '3', daysLeft: '4' },
        { name: '   ', emoji: '🥬', place: 'fridge', qty: 1, daysLeft: 3 },
        { name: { evil: true }, emoji: '🥬', place: 'fridge', qty: 1, daysLeft: 3 },
        { name: 'Milk', emoji: 'milk', place: 'fridge', qty: 1.5, daysLeft: 'soon', catalogueId: 'milk' },
        { name: 'milk', emoji: '🥛', place: 'fridge', qty: 2, daysLeft: 4 },
        ...many,
      ],
    });
  }
  if (/MAXTOKENS/.test(source)) return toolUse('record_items', { relevant: true, items: FRIDGE.slice(0, 1) }, { stop_reason: 'max_tokens' });
  if (/RECEIPT/.test(source)) return toolUse('record_items', { relevant: true, items: RECEIPT });
  return toolUse('record_items', { relevant: true, items: FRIDGE });
}

function recipe(source) {
  const ids = [...source.matchAll(/^(i[a-z0-9]{6,12}): /gm)].map((m) => m[1]);
  if (/BLANK/.test(source)) return toolUse('propose_recipe', { title: 'Toast', emoji: '🍞', minutes: 5, uses: ['inotreal99'], extra: [], steps: ['Toast it.', 'Eat it.'] });
  if (/INJECT/.test(source)) {
    const steps = [];
    for (let i = 0; i < 50; i++) steps.push(`Step ${i} <b>stir</b>`);
    return toolUse('propose_recipe', {
      title: `<script>alert(1)</script>Spinach‮ surprise ${'Z'.repeat(400)}`,
      emoji: '<img>', minutes: 99999,
      uses: [ids[0], ids[0], 'i__proto__', '../../x', 'inotreal99', ...ids.slice(1, 3), { id: ids[0] }],
      extra: ['<a href=x>lemon</a>', 'A'.repeat(500), 7, ...Array(30).fill('salt')],
      steps,
    });
  }
  if (/MAXTOKENS/.test(source)) return toolUse('propose_recipe', { title: 'Half', emoji: '🍳', minutes: 10, uses: ids.slice(0, 1), extra: [], steps: ['One'] }, { stop_reason: 'max_tokens' });
  return toolUse('propose_recipe', {
    title: 'Crispy greens fritters', emoji: '🥞', minutes: 20, uses: ids.slice(0, 3), extra: ['a lemon', 'a little flour'],
    steps: ['Chop everything that needs using finely.', 'Stir it into 2 beaten eggs with 3 tablespoons of flour and a pinch of salt.', 'Fry spoonfuls in a hot oiled pan, 2-3 minutes a side.', 'Squeeze over lemon and eat hot.'],
  });
}

function create() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        await new Promise((r) => setTimeout(r, Number(process.env.SHELFLIFE_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const source = content.map((b) => {
          if (b.type === 'image') { try { return Buffer.from(b.source.data, 'base64').toString('latin1'); } catch (e) { return ''; } }
          return b.type === 'text' ? b.text : '';
        }).join('\n');
        const hit = source.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name === 'record_items') return items(source);
        if (params.tool_choice.name === 'propose_recipe') return recipe(source);
        throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
      },
    },
  };
}

module.exports = { create };
