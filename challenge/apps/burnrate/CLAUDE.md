# For Claude: Burnrate

See where your coding agent's tokens go - and cut the waste. For engineering
leaders, founders and developers paying for Claude Code (one seat or a
team's worth) who get a bill and have no idea what drove it. Drop in the
`~/.claude/projects` folder - **read on the device, never uploaded** - and
Burnrate prices every turn at dated list prices and shows the spend by day,
project, model, session and person, subagents apart, with a projected month.
Then the **waste finder**: seven deterministic patterns, each with tokens and
dollars attached and a concrete fix ("You paused 19 min in 'api-refactor';
351K tokens of context were written again ($1.68)"), ranked by dollars, with
"about 21% of this spend looks avoidable" and the method stated plainly.

Built 2026-10-07 as a **business** drop: Shelf Life (2026-10-06) was
everyday, so today was the other kind. **Staging only**: no custom domain
until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/burnrate`,
served at `challenge.strongtechnicalconsulting.com/burnrate/`, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.
**It stores nothing in the lab database** (see Data).

## Why it exists

It answers Friction's rising problem **"Nobody tracks or trims token spend on
coding agents; 20-60% waste"**. A coding agent's bill arrives as one number;
nothing says that most of it was one session left to grow to 600K tokens, a
test log printed in full and carried for a hundred turns, or a cache that went
cold over lunch. Burnrate turns the transcripts people already have on disk
into that explanation, and each finding into a fix they can paste.

Not a repeat: **Leash** is about what an agent may *do*; **Shadow** finds
unapproved SaaS; **Drip** finds personal subscriptions. Nothing in the lab
or the portfolio measures agent spend.

**Who pays.** Almost nobody. The example team, reading files, the dashboard,
every finding and its fix, the team view, the Markdown/CSV/PNG report and the
price editor are free and need no account - there is no server step in any
of them. The one metered thing is **Write our fixes** (Haiku for the free
tier, Sonnet for members via `identity.planFor`), about a cent.

**The honest risk.** Every dollar is an estimate: list prices (a subscription
seat is billed differently, and the page says so), result sizes converted at
~4 characters per token, and "avoidable" is a model of what a better habit
would have cost. So each number is labelled "estimate", the method is on the
page, "big model for small turns" says "up to", findings never claim more
than was spent (capped per session, per person and in total), and the share
is rounded down.

**How it becomes an iPhone app.** The interesting part is a team lead's
weekly glance, not reading files on a phone. A macOS menu-bar or `claude`
hook companion that reads `~/.claude/projects` on the developer's own machine
and keeps the same aggregates (never transcripts) would feed a phone widget:
"This week: $184, 21% avoidable - Maya's long sessions". Same core file.

## The decisions that matter

- **Transcripts never reach the server.** `public/burn-core.js` (UMD:
  `window.BurnCore` in the page, `require` in the server and tests) reads
  them in the browser. There is **no route** that accepts one (POSTs to
  `/api/upload`, `/api/transcripts`, `/api/analyse` are 404s, tested); the
  test reads `app.js` and holds every request it makes to `api/me`,
  `api/fixes` and the auth/billing routes.
- **Reading** (`createCollector`): one file at a time, **streamed**
  (`file.stream()` through `TextDecoderStream`, split by `splitLines`), so a
  300 MB transcript is never held at once. Per line: `JSON.parse` in a
  try/catch - a malformed line is counted and skipped, a line over 32 MB is
  counted and skipped, a `<synthetic>` model line carries no cost. Kept per
  API response: model, time, the five token counts (`input_tokens`, the 5m
  and 1h halves of `cache_creation` - all 5-minute when an older transcript
  has no split - `cache_read_input_tokens`, `output_tokens`), fast mode; per
  tool call: name, a short label (a file path, a command's first 60
  characters, a search pattern), an FNV hash of the full input, the result's
  size and whether it failed. **Never** message text, thinking, file contents
  or command output (tested with markers in every one of them).
- **The classic double-count.** Claude Code writes one streamed API response
  as several lines - one per content block (thinking, text, tool_use) -
  sharing `message.id`, each repeating the usage (an early line can carry a
  smaller output count). Burnrate keys every response by `message.id` (else
  `requestId`, else `uuid`) and keeps the largest of each count, the earliest
  time and each tool call once. The same response in two files or two
  people's folders counts once, for whoever had it first. Measured on a real
  transcript on the build machine: about half the assistant lines were
  repeats, so a naive sum nearly doubles the bill.
- **Where things are** (checked against this machine's `~/.claude/projects`
  and stated as "usually" on the page): one `<session>.jsonl` per session in a
  folder per project (`-Users-maya-code-api` - the path with `/` as `-`);
  subagent transcripts in `<session>/subagents/agent-<id>.jsonl`, lines with
  `isSidechain: true` and `agentId` (older versions wrote sidechains into the
  main file; both are read). A compaction is a `system` line with
  `subtype: "compact_boundary"` (or a user line with `isCompactSummary`). The
  project is the `cwd`'s basename, else the folder name. Windows:
  `%USERPROFILE%\.claude\projects\`.
- **Threads.** A session's main thread and each subagent are separate
  threads (each has its own context and cache); a session's cost rolls its
  subagents in, labelled. Turns are ordered by time; context size per turn is
  input + cache writes + cache reads.
- **Prices** (`DEFAULT_PRICES`): Anthropic API **list prices** as published
  on **2026-09-25** (the claude-api reference's dated table), US$ per million
  tokens: input, output, cache write 5m (1.25x input), cache write 1h (2x),
  cache read (by model: $0.20 on Opus 5.5 and the Sonnet 5s, $0.25 on Fable
  5.1, $0.50 on Opus 5/4.x, $0.10 on Haiku 4.5); fast mode 2x on Opus 5 and
  5.5. The table is dated and labelled on the page, **editable** (edits are
  cleaned - known fields, 0-1000, to the cent - and kept in this browser
  only), and a model not in it is reported ("12 turns on claude-x count as
  $0 - add its price"), never guessed. `rowFor` matches the longest id that
  the model is or that is followed only by a date stamp, so
  `claude-opus-5-5` is never priced as `claude-opus-5`; `[1m]`, `us.anthropic.`
  and `-v1:0` are folded away. Web-search fees are not counted (said so).
- **Money is integer units** of 1e-8 dollars (tokens x cents per million), so
  a total of 50,000 turns is exact to the cent (tested).
- **The dashboard**: total, tokens in/out, cache hit rate (reads / all
  input), by day (main and subagent stacked), by project, by model, by session
  (sortable: cost, newest, peak context, waste, turns; a sparkline of context
  size with the 150K line), subagents vs main, and a projected month (spend
  per calendar day of the range x 30). Charts are SVG drawn by hand at the
  box's real width (redrawn on resize), the validated categorical slots 1
  and 2 (blue main, orange subagent) with legends and value labels, tabular
  numbers.

### The waste finder (`analyse`, pure, in the core)

Each detector works on threads and returns instances with tokens and units;
thresholds are in `T` and stated in `METHOD` on the page. A token added to a
context is priced as **one cache write plus a cache read on every later turn
until the next compaction** (`carryUnits`).

| Finding | Rule | Waste |
|---|---|---|
| Cache went cold | a turn > 5 min (60 with 1-hour caching) after the last that wrote 20K+ tokens, not after a compaction, not mostly read | the prior context x (write - read price) |
| Re-reading | the same Read (path, offset, limit) 3+ times with no edit to it or compaction between | each repeat's result, carried |
| Giant tool output | one result over 40K characters | everything past a 2K-token trimmed version, carried |
| Context bloat | turns after a thread passed 150K without compacting (the crossing turn excluded) | the context above 150K on each, at that turn's input rate |
| Loops | the same tool call (by input hash) failing 3+ times in a thread | every repeat's whole turn |
| Big model for small turns | 8+ Opus/Fable turns, 60%+ of the thread, under 600 output tokens that only read or searched | re-priced at Sonnet 5.5 - an upper bound ("up to") |
| Duplicate subagent work | a read or search one subagent ran that another subagent of the same session had already run | the duplicate result, carried |

A tool result counts toward one finding at most (re-read, then giant, then
duplicate). Findings rank by dollars; the share is capped and rounded down;
an estimate never exceeds what a session or a person spent. Every finding
has a fix in words and, where it fits, a one-line CLAUDE.md rule with Copy.

### The example team (`public/demo.js`)

Maya, Dev and Sam, a week ending yesterday: **generated deterministically**
(a seeded generator from an anchor day) as JSONL lines in the real shape -
streamed responses as two lines sharing an id, tool calls and results,
subagent files, compactions - and fed through the same collector. It shows
every finding (Maya's 636K session and pauses, Dev's full test logs, three
Opus subagents with the same brief, Sam's `terraform plan` retried, Opus on a
read-only release script) beside tidy sessions (compacted, Haiku explorers),
so not everything is a problem: $192 for the week, ~21% avoidable. Every
name, path and command is invented. It is never saved.

### The team, the report, the device

- **Team**: load each person's folder under a name typed on the page (kept
  in this browser), up to 12 people; small multiples of spend by day on one
  scale, each person's biggest finding, and a seat-cost line ("worth about
  $274 a month per person at list prices; you pay $100 a seat").
- **Report**: Markdown (labels from transcripts in code spans or with `<>`
  as entities, so a path cannot become markup or a link), CSV of sessions and
  of findings (RFC 4180 quoting, formula-looking cells get an apostrophe), and
  a 1200x630 PNG summary card drawn on a canvas - **two taps**: Make the card
  shows it, Share (a fresh tap, which iOS needs) shares the file or saves it.
  Nothing is uploaded.
- **Remembered on this device**: the last analysis of your own files - the
  aggregates (totals, breakdowns, findings with their short labels, session
  sparklines), never a transcript - in `localStorage` `burnrate-last-v1`, read
  back through `cleanSaved`, with Clear on the start page and the Report.
  Also `burnrate-prices-v1`, `-seat-v1`, `-name-v1`. Every access in
  try/catch.

## The one model call (metered)

**Write our fixes** - `POST /api/fixes {summary}`: `requireUser,
requireBudget, requireDailyCap` **then** a 64 KB parser (a stranger's body is
never read; 401/402/403, never 413), then `ai.cleanSummary` **rebuilds the
summary field by field** (known kinds, numbers, tool names matching
`^[A-Za-z]\w*$`, file basenames matching `^[A-Za-z0-9._@+-]+$`, model names),
so whatever else a request carries is dropped; nothing to fix is a 400 before
anything is spent. One forced tool `propose_fixes` `{claudeMd: [lines],
settings: [{setting, value, why}], habits: [lines]}`; `cleanFixes` bounds and
strips it (10 lines, 6 settings, 8 habits, 200 characters, no markup, bidi or
control characters); nothing usable is a 422.

The page builds the payload with `BurnCore.fixesSummary` - spend, avoidable
%, cache hit, model shares, and per finding its dollars, tokens, cases and up
to three examples with only a file basename, a tool name, a pause length or
a peak - and **shows it in full before sending**. The answer echoes what was
sent. Signed out, the button explains and offers a free account; 402 opens
the credit sheet; 403 `verify-email` shows its sentence and "Send the link
again". The test proves markers planted in a summary (code, a path, a
command, a headline) never reach the fake model's request.

## Local run and tests

```
npm run dev     # memory identity + fake model, at http://localhost:8125/burnrate/
npm test        # pure rules first, then end to end over HTTP under a /burnrate mount
```

`BURNRATE_MEMORY=1` (the shared account in memory - Burnrate has no store of
its own) and `BURNRATE_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`) -
in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests spawn each with
`K_SERVICE` to prove it. `npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`.
The fake model refuses a call that does not force a tool and logs every
request it gets (`fakeCalls`). Triggers in a file name in the summary:
`BLANK`, `INJECT`, `MAXTOKENS`, `UPSTREAMnnn`; anything else is three
CLAUDE.md lines, two settings and two habits.

`test/fixtures/projects/` is **synthetic**, written by hand in the real
shape: a session with a three-line streamed response, a malformed line, a
`<synthetic>` line, an unsplit cache write, a failed command, a compaction,
array tool-result content and a subagent file; and a hostile project (markup,
bidi and control characters in its cwd, paths and commands). **Never copy a
real transcript into this repo** - they contain private work.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`.

## Data

**None in the lab database.** No analysis, no summary, no answer is stored
(tested: the identity store holds only `users`, `usage`, `events`,
`control`). The only server-side records are the shared account's own -
sign-in and the usage row that bills the one metered call. There is no app
collection, so `BURNRATE_COLLECTION_PREFIX` has nothing to prefix; if
Burnrate ever stores something, it gets a Firestore backend that prefixes
every collection, as Drip's does.

## Routes

Public: `GET /api/health`, `/api/meta` (limits, the dated price table),
`/api/me`, the page. Metered: `POST /api/fixes`. The shared account at
`/api/auth`. There is deliberately no route for a transcript.

## Ideas not built yet

- **A local companion** (a `claude` hook or a CLI) that writes the same
  aggregates nightly, so a team lead sees the week without anyone dragging a
  folder.
- **Before / after**: compare two weeks to show a fix worked ("cold caches
  down 70% since the CLAUDE.md change").
- **Per-repo budgets** and an alert line - needs a sender.
- **Admin API usage reports** for API-key teams - would need a key on the
  server, which this app deliberately does not hold.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`,
  handlers by one `data-act` listener (tested here and by
  `challenge/test/lab.js` once mounted).
- No model call for a signed-out visitor, ever; the metered route's gates run
  before its parser.
- Transcript strings are hostile: `clean()` removes control, bidi and
  zero-width characters and bounds length; every render goes through one
  `esc()`; Markdown and CSV have their own escaping (tested with a hostile
  fixture, and in headless Chromium: no injected element, no dialog).
- Failures (`fail()`/`failure()`): only the app's own errors reach the page in
  their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a summary or a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
