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

## Same subdirectory arrangement as Friction and DataViz

Lives in `eriks-projects/apps/spar` because the installed GitHub App cannot
create repositories. `apps.json` has a `spar` entry; moving it to its own repo
is a `git mv` and one line.

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
npm test        # 24 end-to-end tests over HTTP, same mode
```

`SPAR_MEMORY=1` and `SPAR_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`
set). A deployment that silently kept data in memory or answered with canned
lines would look fine and be broken.

## Data (Firestore, database `spar`)

- `players/<uid>` — handle, xp, streak, badges, skill sums, best per scenario,
  teamIds.
- `players/<uid>/sessions/<id>` — a round: scenario snapshot (with hidden),
  transcript, mood trail, revealed, scorecard, award. Under the player so
  "mine, newest first" needs no composite index.
- `players/<uid>/custom/<id>` — scenarios they built (max 30).
- `daily/<YYYY-MM-DD>/scores/<uid>` — best daily score. Public board.
- `shares/<id>` — a published scorecard snapshot.
- `teams/<id>`, `teamcodes/<CODE>`, `teams/<id>/results/<auto>`.

Accounts are the shared identity (`identity` database), mounted at `/api/auth`.

## Deploy (first time — not done yet)

Built in a session with no GCP key, so it has **never been deployed**. The
first deploy needs these, in order:

1. Firestore database `spar`, Native mode, `us-central1`.
2. Runtime service account `spar-run@` holding `logging.logWriter`,
   `datastore.user` conditioned to the `spar` **and** `identity` databases, and
   `secretAccessor` on `anthropic-api-key` and `identity-session-secret`. The
   deployer cannot grant IAM — **this step is Erik's**, same as every other
   runtime account (`docs/phase4-runtime-service-accounts.md`).
3. Build the image (Cloud Build, as `gcpdeploy ship` does) and `POST` the
   service once (DEPLOY.md → "Creating a service") with `cpuIdle: true`,
   `minInstanceCount: 0`, `allUsers` as invoker, and env:
   `GOOGLE_CLOUD_PROJECT=metal-celerity-236019`, `FIRESTORE_DATABASE_ID=spar`,
   `IDENTITY_DATABASE_ID=identity`, `ANTHROPIC_API_KEY` (secret
   `anthropic-api-key`), `IDENTITY_SESSION_SECRET` (secret
   `identity-session-secret`).
4. Leave `PASSKEY_RP_ID` **unset** while it lives on `*.run.app`: the shared
   cookie and passkeys are scoped to `strongtechnicalconsulting.com`, which a
   run.app host cannot use. Accounts still work (host-only cookie). Set it when
   the subdomain is mapped — then sessions are shared with the other apps.
5. No Stripe env yet: without `STRIPE_SECRET_KEY` the 402 links to a service
   that can sell. Add `stripe-secret-key` / `stripe-member-price` with the
   subdomain.

After that, `gcpdeploy ship spar` handles every later deploy.

## Ideas not built yet

- Voice is browser-only (Web Speech API): push-to-talk in, `speechSynthesis`
  out. A real-time voice mode would be the iOS app's headline feature.
- Team owners cannot yet see a member's scorecard detail — only scores.
- No beacon/analytics until it has a subdomain and a place in `lib/views.js`.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
