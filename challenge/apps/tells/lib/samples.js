// Two made-up posts and a made-up picture result, with baked answers, so the
// page shows what every check looks like without a model call or an account.
//
// Both posts are invented for this page; neither is anyone's real post. The
// baked deep reads go through the same cleanReading() as a live answer (every
// quote located in the text, offsets computed here), and the quick scans are
// run live on load - so a sample can never show a highlight the text does not
// contain. The originality sources are labelled as illustrations and point at
// example.com, not at real authors.

const Core = require('../public/tells-core');
const ai = require('./ai');

const TEMPLATED = `I'm thrilled to announce that I've joined Northwind as Head of Growth. 🚀

In today's fast-paced world, growth isn't just about numbers — it's about people.

Here's what I learned in my first 90 days:

✅ Leverage data to unlock real insights
✅ Foster a culture of experimentation
✅ Elevate every customer touchpoint

The result? A seamless, robust, and transformative journey.

It's not about the destination. It's about the journey.

Let that sink in.

Agree? Thoughts? 👇

#Growth #Leadership #Innovation #Mindset`;

const HUMAN = `Took the 6:40 ferry this morning because the bridge is shut again (third time this month, don't get me started). Sat next to a guy repairing a fishing reel with a paperclip. He had it working by the time we docked, which is more than I can say for the coffee machine on the upper deck.

Anyway the thing I actually wanted to say: our team shipped the invoice export yesterday. It took us eleven weeks instead of three, mostly because the old PDF library chokes on anything with a Czech character in it. Big thanks to Maren, who found that at 11pm on a Sunday and did not tell anyone until Monday. We owe you a proper lunch, not the sad sandwiches.`;

const TEMPLATED_DEEP = {
  likelihood: 86, confidence: 'medium',
  summary: 'A stack of stock phrases, an emoji-bullet list of generic advice and a one-line-per-thought layout, with almost no specific detail about the job itself.',
  human_signs: [],
  spans: [
    { quote: "I'm thrilled to announce", category: 'stock', reason: 'The standard opener of templated announcement posts.', strength: 'medium' },
    { quote: "In today's fast-paced world", category: 'stock', reason: 'A stock opener models reach for; it says nothing specific.', strength: 'high' },
    { quote: "growth isn't just about numbers — it's about people", category: 'construction', reason: 'The “not X, it’s Y” turn, with an em dash.', strength: 'high' },
    { quote: 'Leverage data to unlock real insights', category: 'vocabulary', reason: 'Two over-used words and no detail: which data, which insight?', strength: 'medium' },
    { quote: 'Foster a culture of experimentation', category: 'generic', reason: 'Generic advice that fits any job at any company.', strength: 'medium' },
    { quote: 'A seamless, robust, and transformative journey', category: 'list', reason: 'Three stacked buzzwords as a list of three.', strength: 'high' },
    { quote: "It's not about the destination. It's about the journey.", category: 'construction', reason: 'A second “not X, it’s Y”, as a cliché.', strength: 'medium' },
    { quote: 'Let that sink in.', category: 'hype', reason: 'A set-up line that adds emphasis, not content.', strength: 'medium' },
    { quote: 'Agree? Thoughts?', category: 'stock', reason: 'Engagement bait as a closer.', strength: 'medium' },
  ],
};

const HUMAN_DEEP = {
  likelihood: 9, confidence: 'medium',
  summary: 'Specific, checkable detail (the 6:40 ferry, a paperclip, a Czech character, 11pm on a Sunday), uneven rhythm and a wry aside read as a person.',
  human_signs: ['Specific, local detail', 'Uneven sentence rhythm', 'A digression that goes nowhere, on purpose', 'A named colleague and a real problem'],
  spans: [],
};

const TEMPLATED_ORIGINALITY = {
  score: 18, confidence: 'medium',
  summary: 'Illustration: the advice is the same three bullets found in countless growth posts; only the announcement is new.',
  sources: [
    { title: 'Illustration: “Growth is about people, not numbers”', url: 'https://example.com/illustration/growth-is-people', host: 'example.com', date: '2023-02-14', overlap: 'idea', note: 'The same central claim, word for word in places.', matched: true },
    { title: 'Illustration: “3 lessons from my first 90 days”', url: 'https://example.com/illustration/first-90-days', host: 'example.com', date: '2024-06-03', overlap: 'phrasing', note: 'Near-identical emoji-bullet list: leverage data, foster experimentation.', matched: true },
    { title: 'Illustration: “It’s not about the destination”', url: 'https://example.org/illustration/journey-quote', host: 'example.org', date: null, overlap: 'near-copy', note: 'A widely repeated saying.', matched: true },
  ],
  adds: 'The news that the author joined a new company; nothing about how growth will be done there.',
  none: null, dropped: 0,
};

const HUMAN_ORIGINALITY = {
  score: 91, confidence: 'low',
  summary: 'Illustration: a personal story with its own specifics; nothing close turned up.',
  sources: [], adds: 'A first-hand account of a specific bug and who fixed it.', none: Core.ORIGINAL_NONE, dropped: 0,
};

const PICTURE = {
  name: 'A made-up image file with Content Credentials',
  meta: {
    format: 'image/png', c2pa: true, points: 'ai',
    findings: [
      { id: 'c2pa', strength: 'strong', points: 'ai', label: 'Content Credentials name OpenAI (not verified here)', detail: 'Claim generator: an example generator · Action: created', where: 'PNG caBX' },
      { id: 'source-type', strength: 'strong', points: 'ai', label: 'Made by a generative AI model', detail: 'Digital source type: trainedAlgorithmicMedia (Content Credentials)', where: 'Content Credentials' },
    ],
    notes: ['We read the Content Credentials but do not verify their signature. Check the file at contentcredentials.org/verify.'],
    scanned: { bytes: 48213, of: 48213, partial: false },
  },
  visual: {
    likelihood: 58, confidence: 'low', frames: 1, note: Core.VISUAL_NOTE,
    summary: 'Illustration: smooth, even lighting and a slightly garbled sign; nothing conclusive on its own.',
    artefacts: [{ where: 'shop sign, top left', frame: null, what: 'The letters do not quite form words.' }, { where: 'railing', frame: null, what: 'The bars merge into the wall.' }],
  },
};

let built = null;
function samples() {
  if (built) return built;
  const make = (id, title, blurb, text, deep, originality) => {
    const quick = Core.scan(text);
    const d = ai.cleanReading(deep, text);
    return { id, title, blurb, text, quick, deep: d, originality, combined: Core.combine({ quick, deep: d }) };
  };
  built = {
    posts: [
      make('templated', 'A templated LinkedIn post', 'Made up for this page. Every tell in the book.', TEMPLATED, TEMPLATED_DEEP, TEMPLATED_ORIGINALITY),
      make('human', 'A person’s post', 'Made up for this page, the way people actually write.', HUMAN, HUMAN_DEEP, HUMAN_ORIGINALITY),
    ],
    picture: { ...PICTURE, combined: Core.combine({ meta: PICTURE.meta, visual: PICTURE.visual }) },
    sample: true,
  };
  return built;
}

module.exports = { samples, TEMPLATED, HUMAN, TEMPLATED_DEEP };
