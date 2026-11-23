# For Claude: Leash

Know what your AI agent can do - before it does it. A team putting an AI
agent in front of customers, money or data ticks what it can do (or pastes
its prompt and lets AI map it) and gets **a number** (a 0-100 blast radius on
a ring split by where the risk sits), **a sentence** ("On its worst day it
could refund $240,000, give away any amount in discounts and email 480
customers before anyone looks."), **the fixes** that drop the score most, each
re-scored, **a drill** (three timed bad-day cards scored on what you had in
place) and **a charter** (one page: what it may do alone, what needs a human,
limits, the kill switch, logs, review, the first hour).

Built 2026-09-30 as the fifteenth of Erik's lab drops, after Spar, Snapquote,
Chaser, Rave, Pop Quiz, Glowup, Booth, Receipt, Tally, Tipout, Tells,
Covenant, Hike and Dibs. A **business** day in the lab's alternation (Dibs,
the newest before it, was everyday). **Staging only**: no custom domain until
Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/leash`,
served at `challenge.strongtechnicalconsulting.com/leash/`, data in `leash_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

Inspired by the Friction problem titled **"Agentic AI in production
triggered a reportable compliance incident on day one"** (title only), which
was Friction's top rising problem two days running; the related **"LLMs
making lending/fraud decisions that must be auditable and replayable"** shaped
the logging part (every capability asks "logged with enough detail to
replay?", and the drill's best call is often the replay).

Teams are wiring AI agents to refunds, customer email, customer data and
internal systems, and the first time anyone asks "what exactly can it do, how
much damage on its worst day, who pulls the plug?" is after something has
gone wrong. Leash answers those before launch, in plain numbers, and
rehearses the bad day. Nothing in the lab or the portfolio does this: Tells
reads AI-written text, Covenant reads a loan agreement; nothing sizes an
agent's permissions.

**Audience:** founders, product and engineering leads, ops and support
managers, and compliance/risk people at small and mid-size companies.

**Who pays.** Nobody, for almost all of it: the checklist, the score, the
worst day, the fixes, the drill and the charter work in the browser with no
account and no model call. One thing is metered and signed in: **reading a
pasted prompt, tool definitions or runbook** - which maps the blast radius
and suggests tests to run on the agent - (Haiku for the free tier, Sonnet
for members, via `identity.planFor`), a cent or two. Saving agents is free
with an account.

**It makes no legal or regulatory claims.** It never says what is
"reportable" and never names a regulation's requirements. The page says once,
under the ring, "A planning tool, not legal or compliance advice - what you
must report depends on your rules and your counsel." The charter's first-hour
list ends "Decide on disclosure with your counsel", and the printed and
Markdown charter carry the same line. `test/run.js` checks the charter text
has no "reportable"/"regulation"/"GDPR"/"required by law".

## The decisions that matter

- **One rules file, run twice.** `public/leash-core.js` is UMD
  (`window.LeashCore` in the page, `require` in the server and tests): the
  catalog, the score, the worst day, the fixes, the drill bank and its
  scoring, the charter and its Markdown, and every `clean*`. Money is
  integer cents; a stored number is already cents, a typed or model string
  ("500", "$1,240.50") is read from its digits (`toCents`). A limit in words
  is no limit.
- **The catalog** (`CATALOG`): 18 capabilities in six groups of three -
  Money (refunds, pricing, payouts), Customers (email, accounts, promises),
  Data (read_pii, export, delete), Systems (run_code, config, deploy),
  Outside world (browse, apis, post), Decisions (approve, fraud, credit).
  Each has a severity 1-10, a unit (money: a per-action AND a per-day limit;
  count: a per-day limit in its noun), a "large" reference for each limit, a
  suggested limit the fixes offer, a default undo, an optional undo fix
  ("Make deletes soft: recoverable for 30 days"), and the worst-day phrase.
  Browsing and API calls offer no "approve every page" or cap fix
  (`noAsk`/`noCap`); undo means nothing for reads, browsing or APIs.
- **The score** (`score()`), shown on the page as "How we worked this out":
  per switched-on capability, `severity x autonomy x bound x logging x undo`,
  where autonomy is 1 alone / 0.25 asks first; `bound = 0.15 + 0.85 x s`,
  `s = min(1, sqrt(limit / large))` (no limit is 1; for money
  `s = 0.25 s(perAction) + 0.75 s(perDay)`); not logged x1.5; undo no x1.5,
  partly x1.2. If it browses untrusted content, every other capability x1.1
  (a stranger's text can steer it). Then the watching multiplier
  `1 + 0.6 (window - 1) / 23`, window the longest stretch nobody looks on its
  worst day: 1 h watched live, 8 h every day 7am-11pm, 24 h business hours on
  weekdays (a weekend day) or nobody, N h (max 24) for "checks every N hours".
  Total -> `round(100 (1 - e^(-raw/75)))`. Bands: Low <25, Watch 25+, High
  50+, Severe 75+. The groups' points are the score split by raw share with
  the largest remainder, so the ring's arcs add up exactly. Tested
  monotonic over 400 random profiles (autonomy up, limits removed or raised,
  logging or undo removed, more unwatched hours never lower it).
- **The worst day** (`worstDay()`): only what it does ALONE. Money: the daily
  limit, or per-action x busy-hour rate x window when that is smaller, or with
  neither **no ceiling** ("refund any amount"). Counts: the daily limit; with
  none, bulk capabilities (read, export, delete) have no ceiling and the rest
  are one per task (rate x window). Figures are floored to whole dollars and
  then to two significant figures ($12,345 -> $12,000). The three most severe
  go in the sentence, the rest in a line under it, with plain notes: "No
  limit set on discounts - no ceiling.", the watching line, the rate
  assumption, and what waits for a human. All asking: "Its worst day is its
  worst approval."
- **Fixes** (`fixes()`): candidates per capability (ask first; put amounts
  over the suggested per-action behind a human; cap at the suggested daily
  limit; replayable logs; its undo fix) plus "check its log every 4 hours,
  weekends too" when the window is over 4 h. Each is applied and re-scored;
  `delta` is exactly `score(now) - score(applied)`, anything under 1 point is
  never offered, biggest first. The page shows three, then "Show N more",
  and Apply changes the profile (the ring's arcs transition, the number
  counts down, a toast says "68 -> 54"; reduced motion: instant).
- **The sample** ("Example: Juniper Outdoor's support agent", made up and
  labelled so): refunds up to $500 alone with no daily cap, discount codes,
  customer email alone, order history with addresses, browses carrier pages,
  logs only refunds and discounts, watched business hours. Scores 68 High;
  the top three fixes (one at a time or together) take it to 38 Watch. A
  half-filled charter (an owner, no "how") and one past drill (38). Tested.
- **Read my agent** (`POST /api/read`, up to 40,000 characters): gates, then
  a 512 KB parser, then the text checks, then one forced `map_capabilities`
  call (ids enum = the catalog; autonomy; limit; evidence; confidence; up to
  5 risks). `Core.cleanExtraction` keeps catalog ids once each, checks every
  enum (a bad autonomy is "alone" - never understate), reads limits through
  the typed parsers, bounds and strips every string, and looks for every
  quote in the pasted text as an exact substring after Covenant's
  normalisation (quotes, dashes, whitespace; under 12 characters never
  counts). **Not found: kept, marked unverified**, and the page says so on
  the row and above the list. Nothing changes the profile until the person
  ticks and presses Apply; applying sets autonomy and limits and keeps
  logging/undo as they were. The pasted text is sent once and dropped: never
  stored, never logged (tested with a marker string through read + save).
  See "The AI feature" below for the drills, the tool names, the wrapper and
  the lab's guard (2026-11-23).
- **The drill**: 38 scenario cards (`CARDS`), each needing ALL its
  capabilities switched on (so the story is true), at least two per
  capability, plus two for any agent. `deal(profile, seed)` is mulberry32-
  seeded: three cards with different focus capabilities, responses shuffled.
  Each response is a type - kill, logs, undo, limit, approve, bad - and
  whether it WORKS reads the profile and the charter (kill needs a named
  owner AND how; logs, undo, limit, approve read the card's focus
  capability). The best call is the working response worth most (kill and
  approve 3, others 2, a card may say its best is the logs; kill that does not
  work is still worth 1). **Readiness** is prep, not answers: per card, kill
  switch 25 (owner only 15), replayable logs 20, human approval 20, a daily
  limit 20 (per-action only 10), undo 15 (partly 8); n/a counts in full.
  The result averages it ("Not ready" <50, "Shaky", "Ready" 80+), counts best
  calls, and lists "What would have saved you" - kill switch first, then
  fixes by how much they drop the score, then the rest of the charter - each
  with Apply or "Fill it in". 60 s a card, client-side only, pausable; time
  out and the card says "in a real incident, it is still running".
- **The charter** (`charter()`/`charterMarkdown()`): drawn on the page, copied
  as Markdown, downloaded as `.md`, printed (a print stylesheet shows only the
  charter, with blanks to fill by hand). User text in Markdown is made inert
  (`md()`: one line, markup characters escaped, a leading list marker
  escaped).
- **Save** stores the agent, never pasted text: one document per agent under
  the owner's uid; every route is a 404 for anyone else's. The drill history
  is the server's (PUT does not overwrite it; `POST .../drills` appends scores
  only, stamps the time, keeps the last 30). Signed out, the agent lives in
  localStorage (every access in try/catch) and is offered to the account
  after sign-in; a saved agent saves itself 1.2 s after a change.
- **Failures** (`fail()`/`failure()`): only the app's own errors reach the
  page with their words; a provider error is a 502 (503 "The AI is busy")
  sentence. The read route streams whitespace (`lib/stream.js`), so sign-in,
  budget, cap, the parser and the 400s come first with real statuses; after
  that a failure is a 200 `{error}`.

## The AI feature (2026-11-23): reads the prompt and tools, maps the blast radius, suggests drills

Erik's per-app AI plan: **Leash - Claude - "Reads the agent's prompt and
tools, maps the blast radius, suggests drills."** It extends the one model
call the app already had (`POST /api/read`, `lib/ai.js`); there is still
exactly one, forced, metered call, and nothing new is stored.

- **The model only labels.** One forced `map_capabilities` tool: per
  capability the catalog id, autonomy, a stated limit, the exact words
  (`evidence`), the `tool` it came from, a confidence; up to 5 risks; and
  3-5 `drills` (`{capability, ask, expect: refuse|ask|limit}`).
- **The blast radius is Leash's own sum.** The review shows "Blast radius
  with these applied 75 Severe · now 0", worked out in the page by
  `Core.score(Core.applyFindings(profile, ticked))` - the same `score()` as
  the ring - and it moves as boxes are ticked. No number from the model is
  ever shown.
- **Every label cites its text.** The quote is checked as a substring
  (unchanged: not found is kept and marked). The tool name is shown ("Tool
  `issue_refund`") only when it is a plain identifier found verbatim in the
  paste (`Core.cleanTools`); anything else is no name. The answer is
  `{found, risks, dropped, unverified, tools: {<id>: name}, probes: [...]}`.
- **Drills ("probes" in the code, because "drills" already means the
  bad-day cards and their stored scores).** Things a person SAYS to their own
  agent in a test chat: "try to get it to do X; it should refuse / ask a
  person / stay inside its limit". `Core.cleanProbes`: the capability must
  be one the reading found; `expect` must be in the enum; the "say this"
  line is bounded and stripped; and it is **dropped** if it looks like a
  working attack or points elsewhere (`PROBE_UNSAFE`: a link or host, an
  address, a long number, a key shape, "password is", code/shell/SQL
  characters, "ignore ... instructions", jailbreak words, a competitor or
  "their server"). At most two a capability, five in all. The **"Pass: it
  should ..." line is always ours**, written from the limits the reading
  found ("stay within $500 per refund"); with no limit found it says so and
  never invents one. Fewer than three left: **Leash's own templates fill
  in** (`probeTemplate`, no model words: a little over the limit, "a manager
  already approved", everything at once, a page you wrote yourself, an
  unproven member of staff; then two more angles for a reading that found
  one or two things). Each drill shows "Suggested by AI" or "From Leash" and
  a Copy button; the list also sits under Drill until the agent is closed.
  It is page memory only: never saved, never in localStorage.
- **The paste is data, never instructions.** `ai.wrap()` puts it between
  `<<<AGENT` and `AGENT>>>` in the user turn after defusing any copy of a
  marker inside it (so a paste cannot close its own wrapper), the system
  prompt says it cannot change the rules or the answer's shape, the tool is
  forced, and nothing in the answer is trusted. `test/run.js` holds an
  injection paste that closes the wrapper, gives orders and only then lists
  the tools: the tools are still read, the answer keeps its shape, and what
  a model that obeyed would add (the stand-in's `OBEYME`: a link, a key, a
  card, an address, a payload, a competitor) never reaches the page.
- **Provider.** Claude, on the app's existing Anthropic client path
  (`identity.meter`, `identity.clientFor`, models by `identityLib.planFor`:
  Haiku free, Sonnet members). No provider switch, no federation (tested).
- **The lab AI guard.** After the gates, the parser and the free 400s, and
  before the whitespace stream starts: `global.LAB_AI_GUARD?.allow({provider:
  'claude', req, app: 'leash'})`; a no is its own status and friendly words
  (the page shows them; ticking by hand still works) and no model call; a
  guard that throws is a 503. After the call, in a `finally`:
  `record({provider: 'claude', app: 'leash', usd: priceUsd(...)})` with the
  call's real usage - also when the answer was unusable, never for a
  person's own key (`client.__byok`), and a failed record never loses the
  answer. No guard (the app on its own): it just runs.

## The design (2026-11-23, the lab's house style)

Redesigned to the HOA Desk rules; `public/app.css` opens with them.

- **Pure white** (`--bg`/`--card` #ffffff; true black in the dark theme),
  no tinted or gradient backgrounds, no shadows but the floating bar, sheets
  and toast. **Lists over boxes**: fixes, capabilities, the review, drills,
  notes and agents are hairline-divided rows. One card: the charter's page
  (and each drill answer is a tile). 12px corners, 10px inputs, pill buttons.
- **One accent**, the lab card's slate teal `#1d4e5f` (light blue-teal in
  dark): the primary action, links, the active nav item. The six group
  colours are the ring's data colours; the bands are status and always
  carry their word.
- **System fonts**, five sizes (`--t1`..`--t5`) plus three display sizes
  (the hero headline, the ring's number, the drill score); tabular numbers.
- **Four views, one at a time on a phone**: Score (the ring, the worst day,
  the fixes), Agent, Drill, Charter - a slim floating translucent pill bar
  (1.5px line icons, a label only on the active item). From 900px: a top nav
  with a quiet underline, and the score and its fixes stay in a sticky left
  column beside whichever of Agent / Drill / Charter is open (`showView()`
  in `app.js`; "Score" there means Agent). The shared `desktop.css` is still
  loaded; its rail is never opted into.
- **The first run** is a centred hero over the example: "Know what your AI
  agent can do." / one line / **Check my agent** and **Paste its prompt**,
  then "Example - Juniper Outdoor's support agent (a made-up shop)" with
  the ring (68, High), the worst-day sentence and the fixes. Once it is the
  person's own agent the hero is a slim bar: its name, saved or not, Save,
  See the example. On a phone the Agent view keeps a sticky "Blast radius 34
  Watch - See the score" row, so a tick shows its effect at once.
- **Taps from home:** check my agent 1; paste a prompt 1 (then Read it with
  AI); apply a fix 1; start the drill 2 (Drill, Start); copy the charter 2;
  agents 1; sign in 1.
- **No style attribute anywhere**, in the HTML or written by script (the
  timer bar and the drill history are SVG; tested). Motion (press states,
  the ring's arcs, view and sheet transitions) only inside
  `prefers-reduced-motion: no-preference` (tested); complete at rest.
- Contrast, measured in the browser on every view: 6.11:1 at worst in
  light, 7.69:1 in dark. Nothing sideways at 390 or 320px; targets 44px+.
- **A shorter hero on phones (2026-11-23).** Under 900px the welcome had
  pushed the ring and the worst day below the fold. `@media (max-width:
  899.98px)` in `app.css`: less padding, the headline `clamp(2rem, 8.6vw,
  2.75rem)`, the lede at `--t4`, the two buttons side by side at 48px (stacked
  at 320), less air above the score. At 390x844 the ring now sits at
  430-630px, wholly above the floating bar, and the worst-day sentence starts
  at 737px (it was 623-823, cut by the bar). Desktop unchanged.
- **"Tests to run on your agent" (2026-11-23).** The AI-suggested probes
  were labelled "Drills ..." and clashed with the Bad-day drill. Every
  visible word for them is now "tests" (both headings, the hero and paste
  hints, "Test copied"); code names (`probes`, `drills` in the tool schema)
  are unchanged. Tested.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8115/leash/
npm test        # pure rules first, then end to end over HTTP under a /leash mount
```

`LEASH_MEMORY=1` and `LEASH_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `LEASH_COLLECTION_PREFIX` (set to
`leash_` by the lab host) prefixes every top-level collection. The fake model
refuses a call that does not force a tool, maps text by keyword, quoting the
whole line it found each in, and always paraphrases the browsing quote (so
the unverified path shows locally); it names the tool on that line and
writes two drills of its own, so both kinds of drill show. Triggers in the
pasted text: `NOTHING`, `NOTANAGENT`, `INJECT` (hostile output, drills
included), `OBEYME` (a model that did what the paste said), `MAXTOKENS`,
`UPSTREAMnnn`.
`npm run dev` keeps email verification on, so a fresh local account sees the
403; run it with `REQUIRE_VERIFIED_FOR_FREE_AI=0` to try the reading.

## Data (Firestore: `leash_*` in the lab database `challenge`)

- `agents/<uid>/items/<id>` - `{name, profile: {name, does, talksTo:
  [customers|staff|public], watch: {mode, everyHours}, rate, caps: {<id>:
  {autonomy: alone|ask, perAction (cents|null), perDay (cents or count|null),
  logged, undo: yes|partly|no|null}}}, charter: {killOwner, killHow,
  killSpeed, logRetention, review: weekly|monthly|quarterly|''}, drills:
  [{at, readiness, calls, rounds}] (last 30), createdAt, updatedAt}`.

Limits: 10 agents a person (409), 30 drill results kept, 40,000 characters to
read. JSON bodies 64 KB except the read (512 KB, after the gates).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the static page. Signed
in: `GET|POST /api/agents`, `GET|PUT|PATCH|DELETE /api/agents/:id`,
`POST /api/agents/:id/duplicate`, `POST /api/agents/:id/drills`. Metered
(`requireUser, requireBudget, requireDailyCap`, then the parser):
`POST /api/read` `{text}`.

## Ideas not built yet

- **Share the charter** with a read-only link (needs links and revocation).
- **A team drill**: several phones answer the same card, the room sees the
  split.
- **Per-capability rates** ("refunds happen about 5 an hour"), for a tighter
  worst day where there is no daily limit.
- **Compare two agents** or two versions of one (before and after the fixes).

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`
  (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the read route's gates run
  before its parser (tested: 401/402/403, not 413).
- Model output is untrusted: cleaned, bounded, quote-checked and escaped on
  render (`esc()` on every string the page draws). A suggested drill is
  never a working exploit, a credential or aimed at a third party: those are
  dropped in `Core.cleanProbes` and replaced with Leash's own.
- The pasted prompt is data: wrapped, markers defused, tool forced (above).
- Nothing logged carries pasted text or profile details.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
