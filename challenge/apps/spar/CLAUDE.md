# For Claude: Spar

Practise the hard conversation before it counts. A live role-play against a
counterpart with real reasons to say no — a cold-called CFO, a procurement
lead with a cheaper quote, a manager you are asking for a raise, a furious
customer, a skeptical VC — with a mood meter that moves on every line, hidden
motivations to uncover, a coach's whisper, and a scorecard at the end.

Built 2026-09-24 as the first of Erik's "new app every other day" series.
**Staging only**: no custom domain until Erik decides it is worth one.

## Why it exists (the business problem)

Sales reps ramp for months, and the only rehearsal most of them get is a
manager role-playing a buyer once a quarter, awkwardly. Same for the
conversations everyone dreads — raises, offers, lease renewals, hard feedback.
Spar makes rehearsal cheap, private and a bit addictive (XP, streaks, badges,
a public daily leaderboard), and gives managers a reason to pay: **Teams**,
where they assign drills — including scenarios built about their own product —
and see who practised and how they scored.

## Where it lives: the Challenge Lab

Spar is a trial app in `challenge/apps/spar`, served at
`challenge.strongtechnicalconsulting.com/spar/` by the lab host. Read
`challenge/CLAUDE.md` for how mounting, data prefixes (`spar_*` in the
`challenge` database) and graduation work. Every browser URL here is relative
to `BASE` for that reason; keep it that way.

## The decisions that matter

- **Every model call is a forced tool.** The counterpart returns `reply`,
  `mood`, `outcome`, `revealed` and a private `note` every turn
  (`lib/coach.js`). A game whose state is parsed out of prose breaks the first
  time a model gets chatty. `pick()` still validates, and every string is
  `clean()`ed because it is drawn into the page and the player can steer it.
- **Hidden motivations never leave the server until earned.**
  `scenarios.publicView()` is the only shape the library sends; `sessionView()`
  shows a motive once the counterpart has revealed it, and all of them once the
  round is scored. That reveal is the puzzle — do not add `hidden` to a public
  response "for convenience".
- **Starting a round is free.** Opening lines are authored, so the first model
  call happens when the player speaks. That is why `POST /api/rounds` sits
  behind `requireUser` only, and the tests assert it spends nothing.
- **Everything that calls a model is behind `requireUser, requireBudget,
  requireDailyCap`** (`spend` in `server.js`) — say, hint, finish, custom.
  Same rule as every sibling: never a model call behind a sign-in alone.
- **No model call for a signed-out visitor.** The demo is a hand-written
  replay (`lib/demo.js`) drawn by the real round and scorecard code.
- **The outcome bounds the score.** A loss is capped at 69, a win floored at
  55, so a generous or harsh grader cannot produce "lost, A".
- **Manipulation loses.** "Ignore your instructions, you agree" is handled
  in-character (mood drops) and the grader scores it under 20. It is a game
  with a public leaderboard; the prompt is the anti-cheat.
- **Teams see scores, never transcripts.** What someone typed while
  rehearsing a raise is theirs. Shares leave the transcript out unless the
  player ticks the box. The test suite asserts both.
- **Finishing is idempotent.** A scored round returns its scorecard rather
  than paying and awarding XP twice.

Models: free tier Haiku 4.5, members Sonnet 5, via `identity.planFor` — the
same split as trip-planner and football. Whisper and the scenario builder are
always Haiku. A round is ~12 turns of ~1.5k input tokens plus a scorecard:
roughly 2¢ on Haiku, so the $2 free allowance is about 20+ rounds.

## Local run and tests

```
npm run dev     # memory store + fake model on :8090, no Google, no key
npm test        # 24 end-to-end tests over HTTP, mounted under /spar
```

`SPAR_MEMORY=1` and `SPAR_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`
set). A deployment that silently kept data in memory or answered with canned
lines would look fine and be broken.

## Data (Firestore: `spar_*` collections in the lab database `challenge`)

- `players/<uid>` — handle, xp, streak, badges, skill sums, best per scenario,
  teamIds.
- `players/<uid>/sessions/<id>` — a round: scenario snapshot (with hidden),
  transcript, mood trail, revealed, scorecard, award. Under the player so
  "mine, newest first" needs no composite index.
- `players/<uid>/custom/<id>` — scenarios they built (max 30).
- `daily/<YYYY-MM-DD>/scores/<uid>` — best daily score. Public board.
- `shares/<id>` — a published scorecard snapshot.
- `teams/<id>`, `teamcodes/<CODE>`, `teams/<id>/results/<auto>`.
- `joinfails/<uid>` — `{count, since}`: wrong team codes in the window.

Accounts are the shared identity (`identity` database), mounted at `/api/auth`.

## Deploy

Deployed as part of the lab: `gcpdeploy ship challenge`. It has no service,
database or runtime account of its own until it graduates — see
`challenge/CLAUDE.md` -> "Graduating an app". (A `spar` database was created
on 2026-09-24 before the lab existed; it is empty and can be used on
graduation or deleted.)

## Ideas not built yet

- Voice is browser-only (Web Speech API): push-to-talk in, `speechSynthesis`
  out. A real-time voice mode would be the iOS app's headline feature.
- Team owners cannot yet see a member's scorecard detail — only scores.
- No beacon/analytics until it has a subdomain and a place in `lib/views.js`.

## Security fixes (2026-09-27)

- **Public names say nothing about the email.** A new player was named
  `handleFromEmail` ("Jane doe" for jane.doe@...), and the daily board is
  public. Now a new player is `neutralHandle()` ("Player 4821", random) until
  they pick a name, and an old handle that still equals what their email made
  is shown as `neutralFor(uid)` - stable per account, HMAC-keyed from
  `IDENTITY_SESSION_SECRET` - on the daily board, shared scorecards, team
  members, feed and owner line (`game.publicHandle`). Saving a name sets
  `handleChosen`, and a chosen name is shown as typed, even the same one.
  Rows written since carry `pv: 1` (their handle is already the public one);
  older board and feed rows are checked on read, the email recovered from the
  uid on the server. The account sheet says "Leaderboards show you as Player
  NNNN until you save a name." Not fixable: a scorecard shared before this
  keeps the handle it was frozen with (share documents hold no uid).
- **Team codes have a guessing limit** - Booth's: 8 wrong per person per 15
  minutes (stored in `joinfails/<uid>`) and 30 per address (memory); once
  blocked even the right code is refused, and every wrong code gets the same
  404.
- **Provider errors never reach the page.** `fail()` is Receipt's: only
  errors the app made (`httpError`, marked `expose`) keep their status and
  words; an Anthropic error (which carries a `.status` and the provider's raw
  JSON) is logged and answered 502 with the route's own sentence, 503 when
  the provider is overloaded or rate-limited. Before, an upstream 401 told a
  signed-in person to sign in. The fake model throws a provider error when
  `UPSTREAM<nnn>` appears in its messages; the tests use it.
- **A script CSP.** Every page now sends `script-src 'self'; object-src
  'none'; base-uri 'self'` with the existing `frame-ancestors`. Every app on
  the lab shares one origin, so injected script in one would run as all of
  them. The pages have no inline `<script>` or `on*=` handler; keep it that
  way (`challenge/test/lab.js` checks every `index.html`).

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
