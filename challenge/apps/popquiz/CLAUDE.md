# For Claude: Pop Quiz

Staff training that plays like a daily game. A manager at a restaurant, shop,
salon, clinic, gym or hotel pastes the material that has to stick — the menu
and allergens, opening and closing, safety rules, the returns policy — or
snaps a photo of the binder page. A model drafts quiz questions; the manager
reviews, edits and publishes them. Staff join with an 8-character code and get
**five questions a day**: the ones they miss come back tomorrow, the ones they
know fade out. Streaks, XP, badges and a weekly leaderboard make it a habit;
the manager's dashboard shows who is done today, who knows what, and the
team's **blind spots** — the questions everyone keeps getting wrong, with the
wrong answer they pick instead.

Built 2026-09-24 as the fifth of Erik's lab drops, after Spar, Snapquote,
Chaser and Rave. **Staging only**: no custom domain until Erik decides it is
worth one.

**Where it lives:** a trial app in the Challenge Lab — `challenge/apps/popquiz`,
served at `challenge.strongtechnicalconsulting.com/popquiz/`, data in
`popquiz_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

Every small business with turnover has rules that must stick and a training
binder nobody reads. The cost of a new hire not knowing is real — a nut allergy
served the cashew cheese, a walk-in left at 45°F, a cash drawer counted alone —
and the manager has no idea who actually knows what until something goes wrong.
LMS products (Trainual, 7shifts' training, Axonify) exist for chains; a single
pizza place or salon has a laminated sheet by the door.

Pop Quiz makes the material into a two-minute daily habit and gives the manager
the one view they never had: what the team, as a group, believes that is
wrong. "7 people picked *Nothing on the menu has cashews*" is a pre-shift talk.

**Who pays.** The manager, and barely: one deck is about a cent of model time.
Playing — which is all staff ever do — never calls a model and is free forever,
so a team of 30 costs nothing to run day to day. Writing questions by hand is
free too. The membership buys the better model for drafting.

**How it becomes an iOS app.** The daily five is a notification at the start of
a shift; the streak is a widget; "snap a page" is the camera. Nothing about the
data model changes.

**The honest risk.** Quizzes test recall, not behaviour: someone can know the
walk-in must read 41°F and still not check it. The dashboard says "knows", not
"does". Also, the daily habit depends on staff opening the app with no push
notifications yet — the streak is the only pull until there is a sender.

## The decisions that matter

- **A model only proposes.** `POST …/generate` (text) and `…/generate/photo`
  return a proposal and write **nothing** — the tests dump the whole store
  before and after to prove it. The manager edits it in the review screen
  (the draft lives in that device's localStorage until then) and only
  `POST …/decks` stores a question. The same confirm-before-save shape as
  trip-planner's itinerary.
- **One rules file, run twice.** `public/quiz.js` is UMD: the page loads it as
  `window.PopQuiz`, the server `require`s it. It holds `validateQuestion`, the
  Leitner `review`, `pickDaily`, streaks, XP, badges, the leaderboard, mastery,
  blind spots and join-code formatting. The editor validates live with it; the
  server validates every save with it; the sample quiz checks answers with its
  `check()`. They cannot disagree.
- **A valid question has exactly one right answer.** From the model, options
  arrive as `{text, correct}` so "none right" and "two right" are refused rather
  than guessed at. Multiple choice is exactly 4 options, true/false is always
  `["True","False"]` in that order, "which one is it?" is 2–4. Options must be
  distinct (case, spacing and end punctuation ignored). Lengths are bounded, tags
  and stray angle brackets stripped. A model question must also explain its
  answer; a hand-written one may skip it. Invalid model questions are dropped
  and counted ("2 didn't pass our checks"); multiple choice and which-one
  options are **shuffled** server-side, because models put the answer first.
- **Every model call is a forced tool** (`write_questions`) behind
  `requireUser, requireBudget, requireDailyCap` (`spend` in `server.js`), then
  the manager check. The 402 comes before any model call; a stranger's team id
  404s before one; staff get 403 before one. The tests count usage rows to
  prove all three.
- **Taking a quiz never calls a model**, and the page never has the answer
  before answering: `GET …/quiz` sends questions without `answer` or
  `explanation`; `POST …/quiz/answer` checks, and returns the answer, why, the
  source quote and when it comes back.
- **Today's five are picked once and kept** on the person's progress document
  (`today: {day, ids, answers}`), so a reload shows the same quiz and an answer
  cannot be re-rolled. A second answer to the same question scores nothing. A
  page left open overnight gets a 409 and reloads the new day.
- **One progress document per person** (`teams/<id>/progress/<uid>`), written
  only by that person's own answers — two staff answering at once write two
  documents (tested with concurrent requests). A per-person in-process queue
  (`exclusive`) serialises one person's double taps. Membership is its own
  document per member plus `memberIds` updated with `arrayUnion`/`arrayRemove`,
  so two people joining at once both land.
- **Spaced repetition is plain Leitner.** Boxes 1–5, back in 1 / 2 / 4 / 7 / 14
  days. A miss goes to box 1 and returns tomorrow; a first-time right answer
  starts in box 2. "Known" means box 3+ (right twice in a row since the last
  miss). `pickDaily`: due reviews first (lowest box first), then new questions
  in deck order, then the soonest due — and when reviews would fill all five,
  one slot is kept for something new, so a bad week never stops anyone reaching
  the next deck. The order is shuffled per person per day by a seeded hash.
- **Editing keeps history only for the same fact.** A reworded question keeps
  its id (and everyone's progress on it); change the options or the right
  answer and it is a new question, because the old history was about something
  else (`Q.sameFact`).
- **What each role sees.** Everyone on a team: the leaderboard — name, XP this
  week, streak, nothing else. Staff: their own stats and badges. Managers: the
  join code, the member list, the dashboard (per-person done-today, mastery,
  accuracy, and per-question blind spots) and the decks with answers. Staff get
  **403** on manager routes; anyone not on the team gets **404** on every team
  route, never 403.
- **Join codes** are 8 characters from a 32-letter alphabet with no 0/O/1/I
  (~1.1 trillion), drawn with `crypto.randomBytes` and rejection sampling. Typed
  any way (`abcd efgh`). A wrong code — malformed or not — always gets the same
  404 message and says nothing about any team. Wrong codes are capped: 8 per
  person per 15 minutes (stored, so it holds across instances) and 30 per
  address (in memory); once blocked, even the right code is refused, so the
  limit is not an oracle. A manager can reset the code; the old one dies at once.
- **The photo is read once and kept nowhere.** Shrunk in the browser (1600px
  JPEG), checked by magic number and size *before* anything is spent
  (`lib/photo.js`, 400), read by the model, dropped with the request. Nothing
  readable → 422. The 6 MB parser mounts **after** the gates on that one route;
  every other route keeps 128 KB.
- **Everything is computed on read.** Streaks, mastery, the leaderboard, blind
  spots and topic roll-ups are derived from progress documents every time.
  Badges are the one exception: earned once, stamped with the day, kept.
- **No model call for a signed-out visitor.** The demo (`lib/demo.js`: Slice
  Society, an invented pizza place with a menu & allergens deck and a closing
  checklist, seven invented staff) replays deterministic answer histories
  through the real `review()`, so its dashboard, blind spots and leaderboard
  come from the same code as a real team's. The sample quiz is five of its
  questions, checked in the page by `quiz.js`.

### Numbers

XP: 10 right, 2 for a miss (you showed up), 10 for finishing the day, 20 more
for a perfect day. Weeks start Monday. Badges: First quiz, Perfect day, On a
roll (3-day streak), Week streak (7), Comeback (right after a miss), Sharp (5
perfect days), 500 XP, Know-it-all (80% mastery with 10+ questions). Blind spots
need 3 answers on a question across the team before they count.

Models: free tier Haiku 4.5, members Sonnet 5, via `identity.planFor` — the same
split as the siblings. A deck of 8 is ~1.5k input / ~1.5k output tokens: under
a cent on Haiku. A photo adds ~1.5k input.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8096/popquiz/
npm test        # pure rules first, then end to end over HTTP under a /popquiz mount
```

`POPQUIZ_MEMORY=1` and `POPQUIZ_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE` set) — in `lib/store.js`, `lib/fakeai.js` and `server.js`; the
tests spawn each with `K_SERVICE` to prove it. `POPQUIZ_COLLECTION_PREFIX` (set
to `popquiz_` by the lab host) prefixes every top-level collection; the default
database is `challenge`. The fake model builds questions from the material's own
sentences and refuses any call that does not force a tool. Triggers: `INJECT`
in the material adds markup, a question with two right answers, one with none,
duplicate options and a junk type; `NOT TRAINING` reads as nothing usable
(422); a photo whose bytes contain `BLANK` is unreadable (422).

## Data (Firestore: `popquiz_*` in the lab database `challenge`)

- `teams/<id>` — name, emoji, code, ownerId, `memberIds` (array-contains is how
  "my teams" is found — no composite index), createdAt, updatedAt.
- `teams/<id>/members/<uid>` — name (as the team sees it), role
  `manager | staff`, joinedAt. The creator is the owner and a manager.
- `teams/<id>/decks/<id>` — title, emoji, source `text | photo | hand`,
  `questions: [{id, type mcq|tf|which, prompt, options, answer, explanation,
  source, topic}]`, createdBy, createdAt, publishedAt, updatedAt.
- `teams/<id>/progress/<uid>` — `cards {qid: {box, due, right, wrong, last,
  lastRight, picks {optionIndex: n}}}`, xp, `xpByDay` (70 days kept), streak,
  best, lastDoneDay, daysDone, perfectDays, comebacks, `badges {key: day}`,
  `today {day, ids, answers {qid: {choice, correct, at}}}`.
- `codes/<CODE>` — `{teamId}`: the join-code lookup.
- `joinfails/<uid>` — `{count, since}`: wrong-code attempts in the window.

Limits (`lib/teams.js` LIMITS): 50 people a team, 5 teams run per manager, 12
teams per person, 20 decks and 300 questions a team, 40 a deck, 12,000
characters of pasted material, 4–12 questions a generation. JSON bodies 128 KB
except the photo route (6 MB, after the gates; image 4 MB decoded).

Removing someone deletes their progress on that team; deleting a team deletes
its decks, members, progress and code.

Accounts are the shared identity (`identity` database), mounted at `/api/auth`
— one account and one $2 credit across the lab and every app.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/demo`, and `quiz.js` (static).
Signed in: `GET /api/me`, `POST /api/teams`, `POST /api/join`,
`GET|PUT|DELETE /api/teams/:id` (PUT manager, DELETE owner),
`PUT /api/teams/:id/me` (your name), `POST /api/teams/:id/code` (manager),
`DELETE /api/teams/:id/members/:uid|me`, `GET /api/teams/:id/quiz`,
`POST /api/teams/:id/quiz/answer`, `GET /api/teams/:id/leaderboard`,
`GET /api/teams/:id/dashboard` (manager), `GET|PUT|DELETE
/api/teams/:id/decks/:deckId` and `POST /api/teams/:id/decks` (manager).
Metered (manager): `POST /api/teams/:id/generate`,
`POST /api/teams/:id/generate/photo`.

## Ideas not built yet

- **A shift-start nudge** ("3 of 7 done — 2 minutes before doors open") — needs
  a sender (push or SMS), which the platform deliberately doesn't have.
- **Co-managers**: the role field exists; promoting staff to manager needs a
  route and a button.
- **Assign a deck to a new hire** as a first-week track, ahead of the daily mix.
- **Retrain from a blind spot**: one tap to pin that question into everyone's
  next quiz, or to open it in the editor to reword.
- **Printable certificate** when someone masters a deck (for inspections).
- No beacon/analytics until it has a subdomain and a place in `lib/views.js`.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
