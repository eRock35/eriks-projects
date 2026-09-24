// A finished round, written by hand, for people who have not signed up.
//
// No app on this domain makes a model call for a signed-out visitor, so the
// way to show what a round feels like is a replay. It is served as data and
// drawn by the same code that draws a real round, so it cannot drift from what
// the product actually looks like.

const scenarios = require('./scenarios');

const s = scenarios.get('cold-call-cfo');

const DEMO = {
  id: 'demo',
  demo: true,
  scenarioId: s.id,
  scenario: scenarios.publicView(s),
  difficulty: 'realistic',
  status: 'won',
  mood: 4,
  turns: 5,
  maxTurns: 12,
  hiddenCount: 3,
  revealed: [1, 3],
  revealedText: { 1: s.hidden[0], 3: s.hidden[2] },
  transcript: [
    { who: 'them', text: s.opening, mood: 0 },
    { who: 'you', text: "Hi Dana, it's Sam from Ledgerline. I'll be quick — I work with finance teams who are fighting the month-end close. Is close something that's on your mind right now, or am I off base?" },
    { who: 'them', text: "Everyone says that. Close is close. It's painful everywhere. What do you actually do?", mood: -1, note: 'Generic opener - sounded like every other rep.' },
    { who: 'you', text: "Fair. Honestly, I'd rather not pitch until I know if it's relevant. When a close slips at a company your size, who usually feels it first — you, or the board?" },
    { who: 'them', text: "...The board. We missed the last two deadlines and I got asked about it in front of everyone. Not fun.", mood: 1, note: 'A real question about consequences. Opened up.', revealed: [1] },
    { who: 'you', text: "That sounds brutal. Teams we work with usually find the slip isn't the people, it's the reconciliations piling up at the end. Is that what's happening for you, or is it something else?" },
    { who: 'them', text: "It's the reconciliations. And my senior accountant is running on fumes.", mood: 2, note: 'Specific to close pain, not "efficiency". Credible.' },
    { who: 'you', text: "Here's what I'd suggest: 30 minutes, I bring what a 400-person logistics company's close looks like before and after, and you tell me if it's worth a second look. Would Thursday at 10 work?" },
    { who: 'them', text: "If you can show me that with real numbers — fine. Thursday at 10. Don't waste it.", mood: 4, note: 'Concrete ask, relevant proof offered. Committed.', revealed: [3] },
  ],
  scorecard: {
    overall: 86,
    grade: 'A',
    skills: { rapport: 8, discovery: 9, pushback: 7, clarity: 8, close: 9 },
    headline: 'You earned the meeting by asking about consequences instead of features.',
    strengths: [
      'Turned the "what do you do?" challenge into a question about who feels the pain.',
      'Closed with one specific time and a clear promise of what the meeting would show.',
    ],
    improve: [
      'The opener was generic - lead with the close-deadline angle from the first sentence.',
      'You never learned about the accountant burnout; one more question would have found it.',
    ],
    bestLine: {
      quote: 'When a close slips at a company your size, who usually feels it first — you, or the board?',
      why: 'It made her name the real stakes herself.',
    },
    missedMoment: {
      quote: "Here's what I'd suggest: 30 minutes, I bring what a 400-person logistics company's close looks like before and after, and you tell me if it's worth a second look. Would Thursday at 10 work?",
      better: 'First: "Running on fumes - what happens to the next close if they leave?" Then ask for the meeting.',
      why: 'She handed you a second, sharper pain and you moved on.',
    },
  },
  xp: { gained: 146 },
};

module.exports = { DEMO };
