# For Claude: Rave

Answer every review like a pro — even the ones that sting. A restaurant,
salon, contractor, clinic or shop pastes in its Google and Yelp reviews (or
drops a screenshot); Rave triages each one, drafts a reply in the owner's
voice, checks it against a no-model checklist, and — the signature move —
cools down the angry reply the owner *wants* to send into the one they'll be
glad they posted. A scoreboard keeps response rate, time to reply, the rating
trend and an inbox-zero streak; a wall of love turns the best reviews into a
public page for the business's own website.

Built 2026-09-24 as the fourth of Erik's lab drops, after Spar, Snapquote and
Chaser. **Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab — `challenge/apps/rave`,
served at `challenge.strongtechnicalconsulting.com/rave/`, data in `rave_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

Small businesses live on their stars, and replying to reviews measurably
helps: readers trust a business that answers, and platforms reward it. Most
owners still don't — replying is a chore, the bad ones are painful to read,
and the angry reply typed at 11pm is the one that gets screenshotted and goes
viral. Big reputation suites (Birdeye, Podium, Yext) solve this for chains at
hundreds of dollars a month with platform integrations; a single café or
barbershop has nothing.

Rave makes the chore quick and the painful part safe: the inbox is already
sorted by what needs you most, the words are already written in your voice,
a checklist catches the mistakes (full names, order numbers, arguing, no way
to reach you offline, copy-paste), and Cool down lets you vent first. The fun
— the thermometer dropping, confetti at inbox zero, a streak, badges — is the
point: a chore that feels like a win gets done.

**Who pays.** Owners with a steady trickle of reviews. A draft or a cool-down
costs a fraction of a cent; templates, the checklist and the thermometer are
free forever, so the free tier is genuinely useful and the membership buys the
better model and the credit.

**How it becomes an iOS app.** The inbox is a notification ("New 1★ on
Google — handle offline?"); the screenshot import is the share sheet (share a
screenshot straight from Photos to Rave); Copy is the clipboard handoff back to
the Google Business / Yelp apps. A home-screen widget with the streak and the
waiting count is the obvious next step.

**The honest risk.** Without platform integrations, reviews are typed or
screenshotted in and replies are pasted out. That's the price of zero OAuth,
zero scraping and zero platform-terms risk; the Google Business Profile API
would remove it but needs verification, a Cloud project approval and a
standing liability. If the manual loop is too much friction, that's the
integration to consider — with Erik, not in a daily drop.

## The decisions that matter

- **Rave never posts, reads or logs into anything.** No Google or Yelp
  connection, no scraping, no OAuth. A review arrives by paste or screenshot;
  a reply leaves by Copy, and the owner posts it. The reply box says so in one
  line. "I posted it" is the owner's own tap (`POST …/replied`) — it is what
  the scoreboard counts, and drafting or copying never counts by itself.
- **One rules file, run twice.** `public/rules.js` is UMD: the page loads it
  as `window.RaveRules`, the server `require`s it. It holds the **heat meter**
  (`heat`), the **checklist** (`lint`) and the **quick triage** (`quickTriage`).
  The page runs lint and heat live as you type (free, instant, even signed
  out); the server runs the same code on everything it saves or returns. They
  cannot disagree about what "too hot" means.
- **The thermometer is ours, not the model's.** Cool down's before/after heat
  is `R.heat()` on the owner's draft and on the model's calm version. The model
  lists what it removed (validated against the `KINDS` enum); anything the
  rules saw leave that the model forgot to list is added with `by: 'rules'`.
  Same principle as Chaser's "the model never decides a number".
- **The vent is never stored.** `/api/cooldown` writes nothing — the tests
  dump the whole memory store to prove it. Only the calm version is kept, and
  only when the owner taps "Use as my reply" (saved with `source: 'cooled'`,
  which is what the Cool head badge counts).
- **Risk flags are a union.** The keyword rules flag health, safety, legal,
  discrimination, harassment and privacy mentions. A model triage can *add* a
  reason the words missed, never remove one they raised, and urgency never
  drops below the rules' floor (`triageOf`). A flagged review shows "Handle
  this one offline — call them", gets a short, detail-free template, and the
  checklist warns if a reply reads as admitting fault.
- **Every model call is a forced tool** (`triage_review`, `write_reply`,
  `cool_down`, `read_review`), then checked: enums against their lists,
  strings `clean()`ed (angle brackets, control characters, lengths), the
  reply non-empty. Everything is escaped again when drawn. Review text is
  data: the prompts say so, and the fake model's `INJECT` trigger proves
  markup never survives.
- **`requireUser, requireBudget, requireDailyCap` on every model route**
  (`spend` in `server.js`): `/reviews/:id/triage`, `/reviews/:id/draft`,
  `/cooldown`, `/reviews/read`. The 402 comes before any model call — the
  tests count usage rows to prove it.
- **Templates are always there and always free.** `reviews.template()` writes
  a reply per star bucket (5 / 4 / 3 / 1–2 / risk) × tone (warm /
  professional / playful), naming what they praised or complained about,
  offline for the unhappy, signed off from settings. Two variants each,
  seeded per review so two reviews answered the same day don't read
  identical; "Template" again cycles. Playful turns warm for a 1–2★ or a risk.
- **No model call for a signed-out visitor.** The demo (`lib/demo.js`:
  Juniper & Rye, an invented café, 12 reviews including a furious 1★ and a
  food-poisoning report) runs through the real `view`, `triageOf`,
  `scoreboard`, `template`, `lint` and `heat`. Its "deeper read" on three
  reviews and the cool-down example are hand-written and pass the same
  validators. The thermometer works signed out because it runs on the device.
- **The screenshot is read once and kept nowhere.** Shrunk in the browser
  (1600px JPEG), checked by magic number and size *before* anything is spent
  (`lib/photo.js`, 400), read by the model, dropped with the request. Not a
  review, or no readable stars → 422. The model reports the date **as
  printed** ("3 days ago"); `reviews.dayFromText` does the arithmetic. The
  result fills the Add form; only Save stores anything.
- **The wall is frozen.** `POST /api/wall` snapshots the hearted 4–5★
  reviews that have words, built field by field (`wallOf`): business name,
  title, stars, text, **first name and last initial**, platform, date, and —
  only if asked, and only once marked replied — the owner's reply. Never
  surnames, ids, triage, drafts, timings or the account. One wall per
  account under a 22-character token (`shares/<token>`); Update re-freezes the
  same link, Revoke deletes it for good. `/s/*` and `/api/shared/*` are
  `no-store`, `noindex` and `no-referrer`; GET is the only verb there. The
  wall says "Hand-picked by <business>" and shows **no average rating** —
  an average of cherry-picked reviews would be a lie.
- **Time to reply is honest.** A review "lands" at the later of its posted
  date and when it was added, so importing a backlog doesn't read as weeks of
  slow replies. A review logged as already answered before it was added
  (`replied {on}`) has no reply time at all.
- **Everything is computed, nothing is counted.** Status, urgency, triage,
  the scoreboard and the streak are derived from stored reviews on every read.
  Badges are the one exception: earned once, stamped with the day, kept.
- **Another user gets 404 on everything**, never 403.

### The heat meter

`R.heat(text, {reviewer, contactLine})` → `{score 0–100, level, flags}`.
Points per kind, capped per kind: shouting (whole-word capitals minus common
acronyms, 6 each, max 20), exclamation storms (max 12), swearing (12, max 30),
name-calling (12, max 30), blaming the customer (10, max 25), sarcasm (8,
max 16), threats or legal talk (14, max 28), arguing the facts (8, max 16),
"don't come back" (12, max 20), defensiveness (6, max 12), private details —
someone else's phone or email, order/booking numbers, the reviewer's full name
(14, max 28). The owner's own contact line is never private. Levels: cool
< 15, warm < 35, hot < 60, boiling. Curly quotes are straightened first.

### The checklist

`R.lint(reply, {stars, reviewer, contactLine, risk, others})`: error for
empty or a placeholder (`[name]`); warn for over 150 words, copy-paste (word
trigram Jaccard ≥ 0.8 against the last 60 replies), full name, private
details, arguing, no offline invitation on 1–2★ or a risk (any email or phone
from the contact line counts), possible admission of fault on a risk, heat ≥
35; tips for short replies to unhappy reviews, warmth, and "say thank you" on
4–5★. `ok` means no errors or warnings.

### The scoreboard

Response rate (all time and last 30 days), median hours to reply, average
rating with the last-30 vs previous-30 delta, a six-month bar chart of
monthly averages, the star distribution, topics as loved vs stings (from each
review's effective triage), the inbox-zero streak — a day counts when every
review that had landed by its end was answered by its end; the current streak
runs from today, or from yesterday while something new waits today ("at
risk") — and badges: First reply, Inbox zero (3+), Week of zero, Cool head,
Rescue (a 1–2★ answered inside 24 hours), Quick draw (median under a day over
10+), Fifty answered, Wall of love.

Models: free tier Haiku 4.5, members Sonnet 5, via `identity.planFor` — the
same split as the siblings. A draft or cool-down is ~1k input / ~300 output
tokens: well under a cent on Haiku. A screenshot is ~1.5k input: about a cent.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8093/rave/
npm test        # pure rules first, then end to end over HTTP under a /rave mount
```

`RAVE_MEMORY=1` and `RAVE_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`
set) — in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests spawn
each with `K_SERVICE` to prove it. `RAVE_COLLECTION_PREFIX` (set to `rave_` by
the lab host) prefixes every top-level collection; the default database is
`challenge`. The fake model answers all four tools deterministically and
refuses any call that does not force a tool. Triggers: `INJECT` in a review or
a draft puts markup and junk enums in the answer; `SUBTLE` in a review makes
the model flag a health risk the keywords miss; a screenshot whose bytes
contain `BLANK` reads as "not a review".

## Data (Firestore: `rave_*` in the lab database `challenge`)

- `settings/<uid>` — the voice (businessName, what, ownerName, signOff, tone
  warm|professional|playful, alwaysSay, neverSay, contactLine), `badges {key:
  day earned}`, `wallToken`, `wallSharedAt`, `wallTitle`, `wallReplies`.
- `reviews/<uid>/items/<id>` — platform (google|yelp|facebook|tripadvisor|
  other), stars 1–5, reviewer, text, date (posted, ISO day), source
  (paste|snap), addedAt, addedDay, `triage` (the model's, validated) | null,
  `reply {text, source ai|template|cooled|own, at}` | null, repliedAt,
  repliedDay, replySource, favourite. Under the uid, so "mine" is a path and
  needs no composite index.
- `shares/<token>` — `{uid, createdAt, wall}`: the frozen wall.

Limits (`reviews.LIMITS`): 1,000 reviews an inbox, 5,000 characters a review,
2,000 a reply, 3,000 a vent, 12 reviews on the wall. JSON bodies 128 KB except
the screenshot route (6 MB, mounted after the gates; image 4 MB decoded).

Accounts are the shared identity (`identity` database), mounted at
`/api/auth` — one account and one $2 credit across the lab and every app.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/demo`, `/api/shared/:token`,
page `s/:token`, and `rules.js` (static). Signed in: `GET /api/me`,
`GET|PUT /api/settings`, `GET|POST /api/reviews`,
`GET|PUT|DELETE /api/reviews/:id`, `PUT /api/reviews/:id/reply`,
`POST /api/reviews/:id/replied` (`{replied:false}` undoes, `{on}` backdates),
`POST /api/reviews/:id/favourite`, `POST /api/reviews/:id/template`,
`GET /api/scoreboard`, `GET|POST|DELETE /api/wall`. Metered:
`POST /api/reviews/read`, `POST /api/reviews/:id/triage`,
`POST /api/reviews/:id/draft`, `POST /api/cooldown`.

## Ideas not built yet

- **Share-sheet import on iOS**: a screenshot shared from Photos lands in Add.
- **Google Business Profile API** to pull reviews and post replies — the real
  fix for the paste loop, but it is OAuth, verification and a standing
  liability; a decision for Erik, not a daily drop.
- **A weekly digest** ("3 new, 1 needs a call, streak at 12") — needs a
  sender, which the platform deliberately doesn't have.
- **Suggested replies to praise in bulk** ("answer all 5★ with templates"),
  with the copy-paste check keeping them varied.
- No beacon/analytics until it has a subdomain and a place in `lib/views.js`.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
