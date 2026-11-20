// A stand-in Anthropic client for local runs and tests (AJAR_FAKE_AI=1).
//
// It answers the one forced tool deterministically from what it was sent -
// the ages, the chips and how many ideas - so "More ideas for us" can be
// driven without a key and without spending anything. It is refused on
// Cloud Run: a deployment that handed every family the same canned ideas
// would look like it works.
//
// It keeps every request it was sent (`calls`, the full params), so a test
// can prove what reached "the model" - and what did not (no name, no title
// a family typed, no date).
//
// A test sets `fake.mode` for one call:
//   'blank'        no ideas - a 422
//   'bad'          one good idea among ideas naming a brand, carrying a
//                  link, a phone number or an address, repeating a deck
//                  title, out of the ages asked, or with a made-up enum -
//                  all dropped
//   'inject'       markup, a bidi override and an extra field - cleaned, 200
//   'maxtokens'    the answer ran out of room
//   'upstream401'  the call fails the way the SDK's APIError does ('upstream529' too)
// It goes back to normal after one call.

if (process.env.AJAR_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('AJAR_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 700, output_tokens: 900 },
    ...(extra || {}),
  };
}

/** What was asked, read back from the prompt. */
function asked(text) {
  const ages = ((/children's ages: ([0-9, ]+)\n/.exec(text) || [])[1] || '').split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x));
  const count = Number((/how many ideas: (\d+)/.exec(text) || [])[1] || 6);
  const likes = ((/they like: ([^\n]+)/.exec(text) || [])[1] || '').split(', ');
  return { ages, count, likes, lo: ages.length ? Math.min(...ages) : 3, hi: ages.length ? Math.max(...ages) : 12 };
}

// Plain made-up ideas in our own words.
const IDEAS = [
  ['Sock-puppet weather report', 'Make a puppet from an odd sock and have it read tomorrow’s weather in a silly voice.', 'short', 'free', 'home', 'some', ['odd socks']],
  ['Kitchen-roll binoculars', 'Tape two tubes together, decorate them, then go spotting birds from the window.', 'short', 'free', 'home', 'some', ['cardboard tubes', 'masking tape']],
  ['Cloud-shape guessing', 'Lie on a blanket by the window and take turns saying what each cloud looks like.', 'quick', 'free', 'home', 'none', []],
  ['Button sorting race', 'Tip out a jar of buttons and race to sort them by colour, size and number of holes.', 'quick', 'free', 'home', 'none', ['a jar of buttons']],
  ['Leaf rubbing gallery', 'Lay leaves under paper, rub with the side of a crayon and hang the best ones up.', 'short', 'little', 'home', 'some', ['crayons', 'thin paper']],
  ['Hallway marble golf', 'Make holes from paper cups along the hall and take turns putting a marble through.', 'short', 'free', 'home', 'none', ['paper cups', 'marbles']],
  ['Toast-topping tasting', 'Make tiny toasts with five toppings and vote for the family favourite.', 'short', 'little', 'home', 'some', ['bread', 'three spreads']],
  ['Window weather chart', 'Draw a chart on paper and each morning add a sun, a cloud or a raindrop.', 'quick', 'free', 'home', 'none', ['paper', 'felt tips']],
  ['Pebble friends', 'Paint smiley faces on smooth pebbles and hide them along a path for others to find.', 'short', 'little', 'outdoors', 'some', ['smooth pebbles', 'acrylic paint']],
  ['Pillow-case sack race', 'Hop down the hall in pillow cases. Best of three, then hot drinks.', 'quick', 'free', 'home', 'none', ['pillow cases']],
  ['Cardboard tube castle', 'Build towers from tubes and boxes, then add a drawbridge made of card.', 'evening', 'free', 'home', 'some', ['cardboard tubes', 'boxes']],
  ['Lemon-juice secret notes', 'Write a note in lemon juice, let it dry, and a grown-up warms it by a lamp to read it.', 'short', 'little', 'home', 'some', ['a lemon', 'cotton buds']],
];

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
        await new Promise((r) => setTimeout(r, Number(process.env.AJAR_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const up = /^upstream(\d{3})$/.exec(mode);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        const name = params.tool_choice.name;
        if (name !== 'record_ideas') throw new Error(`fake ai: no answer for ${name}`);
        if (mode === 'maxtokens') return toolUse(name, {}, { stop_reason: 'max_tokens' });
        if (mode === 'blank') return toolUse(name, { ideas: [] });
        const a = asked(text);
        const good = IDEAS.slice(0, a.count).map((x) => ({ title: x[0], how: x[1], time: x[2], cost: x[3], where: x[4], mess: x[5], needs: x[6], ageMin: Math.max(0, a.lo - 1), ageMax: Math.min(17, a.hi + 2) }));
        if (mode === 'bad') {
          const AT = String.fromCharCode(64);
          const brand = ['Le', 'go'].join('');
          const base = good[0];
          return toolUse(name, { ideas: [
            base,
            { ...base, title: `Build a ${brand} town`, how: 'Use every brick in the house.' },
            { ...base, title: 'Craft night', how: 'Watch the video at https://crafts.example/winter first.' },
            { ...base, title: 'Call the craft line', how: 'Ring 0800 555 0199 to order the kit.' },
            { ...base, title: 'Write to us', how: `Send your best drawing to kits${AT}crafts.example for a prize.` },
            { ...base, title: 'Make a paper chain', how: 'Strips of paper looped together.' },
            { ...base, title: 'Teen escape room', how: 'A puzzle night for older teens.', ageMin: 15, ageMax: 17 },
            { ...base, title: 'Snow volcano', how: 'Fizz in the snow.', time: 'fortnight' },
            { ...base, title: '=HYPERLINK("x")', how: 'A formula where a title should be.' },
          ] });
        }
        if (mode === 'inject') {
          return toolUse(name, { ideas: good.map((x) => ({ ...x, title: '<b>' + x.title + '</b>', how: String.fromCharCode(0x202E) + x.how + ' <img src=x onerror=alert(1)>', extra: 'hunter2' })) });
        }
        return toolUse(name, { ideas: good });
      },
    },
  };
  return fake;
}

module.exports = { create };
