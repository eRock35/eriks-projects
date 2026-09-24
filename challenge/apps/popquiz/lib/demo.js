// A sample team, written by hand, for people who have not signed up.
//
// No app on this domain makes a model call for a signed-out visitor, so the
// way to show what Pop Quiz does is a real-looking team run through the real
// arithmetic: the decks pass validateQuestion, each person's history is built
// by replaying answers through the same Leitner review() a real answer goes
// through, and the dashboard, blind spots and leaderboard come out of the same
// functions a real team's do. The demo cannot drift from the product.
//
// Slice Society, its menu, its rules and everyone on its team are invented.
// Dates are relative to today so the streaks are always live.

const Q = require('../public/quiz');
const T = require('./teams');

const TEAM = { id: 'demo', name: 'Slice Society', emoji: '🍕', code: 'SLCE-DEMO' };

// [id, type, prompt, options, answer, explanation, source, topic, difficulty 0-1, the wrong answer people favour]
const DECKS = [
  {
    id: 'menu', title: 'Menu & allergens', emoji: '🍕', source: 'text', ago: 21,
    questions: [
      ['demo-m1', 'mcq', 'A guest has a cashew allergy. Which pizza must they avoid?', ['Margherita', 'Funghi', 'The Vegan Slice', 'Nothing on the menu has cashews'], 2,
        'Our vegan cheese is made from cashews, so The Vegan Slice is off-limits. (The Pesto Verde has walnuts, too.)', 'The Vegan Slice: tomato, cashew mozzarella, roasted peppers.', 'Allergens', 0.8, 3],
      ['demo-m2', 'tf', 'You can tell a coeliac guest the gluten-free base is “totally safe”.', ['True', 'False'], 1,
        'It is made without gluten but prepared in a kitchen that uses flour. Say exactly that and let the guest decide.', 'Gluten-free base (+$3): made without gluten, prepared in a kitchen that uses flour.', 'Allergens', 0.5, 0],
      ['demo-m3', 'which', 'Which one has walnuts in it?', ['Pesto Verde', 'Margherita', 'Garlic knots'], 0,
        'Our pesto is made with walnuts, not pine nuts.', 'Pesto Verde: walnut pesto, fior di latte, courgette.', 'Allergens', 0.14, 2],
      ['demo-m4', 'mcq', 'A guest mentions a nut allergy. What do you do first?', ['Suggest the Margherita', 'Type it in the order notes', 'Mark the ticket ALLERGY and tell the kitchen lead in person', 'Point them to the allergen board'], 2,
        'Notes get missed on a busy line. The ticket flag plus a word with the kitchen lead is the rule, every time.', 'Allergy: flag the ticket ALLERGY and tell the kitchen lead in person.', 'Allergens', 0.34, 1],
      ['demo-m5', 'tf', 'Garlic knots are vegan.', ['True', 'False'], 1,
        'They are brushed with butter, so they contain dairy.', 'Garlic knots: brushed with garlic butter.', 'Menu', 0.36, 0],
      ['demo-m6', 'mcq', 'What is in the tiramisu?', ['Egg, dairy, gluten and coffee liqueur', 'Dairy and coffee only', 'Egg and dairy, no alcohol', 'Gluten and dairy, no egg'], 0,
        'Ladyfingers (gluten, egg), mascarpone (dairy) and a splash of coffee liqueur - worth saying to anyone avoiding alcohol.', 'Tiramisu: contains egg, dairy, gluten, coffee liqueur.', 'Menu', 0.3, 2],
      ['demo-m7', 'mcq', 'How much does a gluten-free base add?', ['$1', '$2', '$3', '$4'], 2,
        'Any pizza can go on the gluten-free base for $3 more.', 'Gluten-free base (+$3)', 'Prices', 0.2, 1],
      ['demo-m8', 'which', 'Which pizza is vegetarian?', ['Hot Honey Pepperoni', 'Pesto Verde', 'Nduja & Burrata'], 1,
        'Pepperoni and nduja are both pork. The Pesto Verde has no meat.', 'Vegetarian: Margherita, Pesto Verde, Funghi.', 'Menu', 0.1, 2],
    ],
  },
  {
    id: 'close', title: 'Closing checklist', emoji: '🔒', source: 'photo', ago: 12,
    questions: [
      ['demo-c1', 'mcq', 'What must the walk-in cooler read before you leave?', ['45°F or below', '41°F or below', '50°F or below', 'Anything under 60°F'], 1,
        'Food held above 41°F grows bacteria fast. If it reads higher, tell the manager on duty before you go.', 'Walk-in reads 41°F or below - log it on the clipboard.', 'Food safety', 0.66, 0],
      ['demo-c2', 'tf', 'The oven can be left on low overnight to save warm-up time.', ['True', 'False'], 1,
        'Fully off, every night. It heats up in 40 minutes in the morning.', 'Oven: fully off. Never left on low.', 'Safety', 0.12, 0],
      ['demo-c3', 'mcq', 'Where does the cash drawer go at close?', ['Counted by the closer, then under the counter', 'Left in the till, locked', 'Taken to the bank by the closer', 'Counted by two people, then into the office safe'], 3,
        'Two people count, both initial the sheet, and it goes in the safe.', 'Cash: two-person count, initial the sheet, drawer to the office safe.', 'Cash', 0.34, 0],
      ['demo-c4', 'which', 'Which one is the very last step before you lock up?', ['Mop the floor', 'Arm the alarm', 'Take out the trash'], 1,
        'The alarm is last - after the floor, the trash and the final walk-round.', 'Last: arm the alarm, lock the front door, check it.', 'Closing', 0.24, 2],
      ['demo-c5', 'tf', 'Tomorrow’s dough goes in the walk-in labelled with today’s date.', ['True', 'False'], 0,
        'The label is the day it was made, so the morning crew knows how long it has proofed.', 'Dough: tray, cover, label with today’s date, into the walk-in.', 'Closing', 0.4, 1],
      ['demo-c6', 'mcq', 'How many people must be in the building at close?', ['One is fine', 'At least two', 'Three', 'Whoever is on the rota'], 1,
        'Nobody closes alone - it is a safety rule, not a staffing one.', 'Never close alone: at least two people until the door is locked.', 'Safety', 0.28, 0],
      ['demo-c7', 'mcq', 'When does the trash go out?', ['Last thing, by whoever closes', 'First thing in the morning', 'Before the last hour, and in pairs after dark', 'Whenever the bin is full'], 2,
        'Early, so nobody is out back alone at midnight.', 'Trash out before the last hour of service; after dark, go in pairs.', 'Safety', 0.52, 0],
    ],
  },
];

// [name, role, streak, done today, skill 0-1, days since last quiz when the streak is broken]
const PEOPLE = [
  ['Gio Marino', 'manager', 12, true, 0.92],
  ['Priya Nair', 'staff', 9, true, 0.84],
  ['Marcus Bell', 'staff', 5, true, 0.58],
  ['Aiyana Brooks', 'staff', 2, true, 0.55],
  ['Jess Okafor', 'staff', 3, false, 0.7],
  ['Tomás Ruiz', 'staff', 1, true, 0.5],
  ['Leo Tanaka', 'staff', 0, false, 0.38, 4],
];

// The sample quiz a visitor plays: one of each type, two of the team's blind spots.
const SAMPLE = ['demo-m1', 'demo-m2', 'demo-c4', 'demo-c1', 'demo-m5'];

const rand = (s) => (Q.hash(s) % 10000) / 10000;

function decksFor(today) {
  return DECKS.map((d) => {
    const questions = d.questions.map(([id, type, prompt, options, answer, explanation, source, topic]) => {
      const r = Q.validateQuestion({ id, type, prompt, options, answer, explanation, source, topic });
      if (r.error) throw new Error(`demo question ${id}: ${r.error}`);
      return r.q;
    });
    const at = `${Q.addDays(today, -d.ago)}T09:00:00.000Z`;
    return { id: d.id, title: d.title, emoji: d.emoji, source: d.source, questions, createdAt: at, publishedAt: at, updatedAt: at };
  });
}

/** One person's history, replayed through the real review(). */
function progressFor(person, questions, today) {
  const [name, , streak, done, skill, brokenFor] = person;
  const meta = {};
  DECKS.forEach((d) => d.questions.forEach((row) => { meta[row[0]] = { diff: row[8], trap: row[9] }; }));
  const p = T.emptyProgress();
  const cards = {};
  let comebacks = 0;
  questions.forEach((q) => {
    const { diff, trap } = meta[q.id];
    const tries = 2 + (Q.hash(name + q.id) % 4);
    let card = null;
    for (let k = 0; k < tries; k++) {
      const day = Q.addDays(today, -(tries - k) * 3 - 1);
      const wrong = rand(`${name}|${q.id}|${k}`) < Math.min(0.9, diff * (1.55 - skill) * (k ? 0.7 : 1.3));
      const choice = wrong ? (rand(`${name}|${q.id}|${k}|pick`) < 0.75 ? trap : [0, 1, 2, 3].filter((i) => i !== q.answer && i !== trap && i < q.options.length)[0]) : q.answer;
      const r = Q.review(card, !wrong, day, choice);
      card = r.card;
      if (r.comeback) comebacks++;
    }
    cards[q.id] = card;
  });
  p.cards = cards;
  p.comebacks = comebacks;
  // The streak: `streak` days ending today (or yesterday if not done yet).
  const last = streak ? (done ? today : Q.addDays(today, -1)) : Q.addDays(today, -(brokenFor || 3));
  const xpByDay = {};
  const days = Math.max(streak, 1);
  for (let i = 0; i < days + 6; i++) {
    const d = Q.addDays(last, -i);
    if (i >= days && rand(`${name}|gap|${i}`) < 0.5) continue;
    xpByDay[d] = 32 + Math.round(rand(`${name}|xp|${d}`) * 38 * (0.6 + skill));
  }
  p.xpByDay = xpByDay;
  p.xp = Object.values(xpByDay).reduce((a, b) => a + b, 0) + Math.round(skill * 900);
  p.streak = streak || 1;
  p.best = Math.max(p.streak, Math.round(skill * 14));
  p.lastDoneDay = last;
  p.daysDone = Object.keys(xpByDay).length + Math.round(skill * 10);
  p.perfectDays = Math.round(skill * skill * 8);
  if (done) {
    const ids = Q.pickDaily(questions, cards, today, name + today);
    p.today = { day: today, ids, answers: Object.fromEntries(ids.map((id) => [id, { choice: 0, correct: true }])) };
  }
  for (const k of Q.badgesFor(p, { questions: questions.length, mastery: Q.mastery(questions, cards) })) p.badges[k] = Q.addDays(today, -2);
  return p;
}

function demo(today) {
  const decks = decksFor(today);
  const questions = T.flatten(decks);
  const members = PEOPLE.map((row, i) => ({ uid: `demo${i}`, name: row[0], role: row[1], joinedAt: `${Q.addDays(today, -30 + i * 3)}T12:00:00.000Z` }));
  const progress = {};
  members.forEach((m, i) => { progress[m.uid] = progressFor(PEOPLE[i], questions, today); });
  const byId = new Map(questions.map((q) => [q.id, q]));
  const me = members[1]; // Priya: what a staff member's own tab looks like
  return {
    demo: true,
    today,
    team: { ...TEAM, role: 'manager', members: members.length },
    decks: decks.map((d) => ({ ...T.deckSummary(d), questions: d.questions })),
    dashboard: T.dashboard(members, progress, questions, decks, today),
    leaderboard: { week: Q.weekStart(today), rows: Q.leaderboard(members.map((m) => ({ uid: m.uid, name: m.name, progress: progress[m.uid] })), today) },
    sample: SAMPLE.map((id) => byId.get(id)).map((q) => ({ ...T.publicQuestion(q), answer: q.answer, explanation: q.explanation, source: q.source })),
    me: { name: me.name, ...T.statsOf(progress[me.uid], questions, today) },
    material: 'MENU & ALLERGENS - staff sheet\nThe Vegan Slice: tomato, cashew mozzarella, roasted peppers.\nPesto Verde: walnut pesto, fior di latte, courgette.\nGluten-free base (+$3): made without gluten, prepared in a kitchen that uses flour.\nGarlic knots: brushed with garlic butter.\nAllergy: flag the ticket ALLERGY and tell the kitchen lead in person.',
  };
}

module.exports = { demo, DECKS, PEOPLE, SAMPLE, TEAM };
