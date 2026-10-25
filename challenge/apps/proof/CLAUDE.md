# For Claude: Proof

Did the agent actually do it? Check its claims against its own receipts. For
engineers and leads running coding or ops agents - Claude Code, Codex,
Cursor-style agents, their own tool-calling agents - who get a confident
"Done! All tests pass" summary and need to know whether it is true before
they merge it or trust it.

Drop a run - a Claude Code transcript (`.jsonl`), an Anthropic or OpenAI
messages export (JSON), OpenAI Responses items or a Codex session (`.jsonl`),
a generic tool-call log (JSON lines), or the terminal output and the agent's
final message pasted. It is **read on the device, never uploaded**, and you
get:

- a **verdict**: one line ("1 of 7 claims backed - tests were never re-run
  after the last edit"), a **trust score** out of 100 with every reason that
  took points off, and **what to check before merging** (the three most
  important, concrete, with step numbers);
- **claims vs receipts**: every checkable sentence in the agent's final
  message - tests pass (and how many), fixed, N files changed, named files,
  tests added, lint / types / build clean, no errors, verified, committed,
  pushed, PR opened (and its number), deployed, migrated, coverage - each
  **Backed / Partly / No evidence / Contradicted**, with the exact steps and
  lines that decided it;
- **acceptance criteria** the person writes (one per line), checked the same
  way: tests pass, scope ("no changes outside src/billing", "don't touch
  lib/x.ts"), no skipped tests, PR opened, migration applied, coverage >= N%,
  and the rest marked "check by hand" with the steps that mention it;
- **patterns worth a look** - only what the run ADDED: tests skipped,
  focused, commented out, removed or deleted; assertions weakened; an
  expected value edited to match; a mock of the module under test; a source
  file returning the exact value a test checks for; code that branches on
  being under test; empty `catch` / `except: pass` / `.catch(() => {})`;
  silenced checkers; raised timeouts; retries; a weaker test setup or a lower
  coverage bar; `|| true` and `2>/dev/null` on a check, `set +e`,
  `--passWithNoTests`, `--no-verify`, force pushes, rewritten snapshots;
- **errors it kept going after** - failures nothing later fixed or re-ran;
- **what it says it didn't do** - admissions kept and shown, no points off;
- a **timeline** of every step (tool, what it touched, ok / error / hidden,
  duration), filterable, each opening to its command, diff and output;
- **Copy as PR comment** (Markdown), a one-paragraph summary, `.md` and
  `.json` downloads.

Built 2026-10-25 as a **business** drop (the day's kind, per the lab's
alternation). **Staging only**: no custom domain until Erik decides it is
worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/proof`,
served at `challenge.strongtechnicalconsulting.com/proof/`, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.
**It stores nothing in the lab database** (see Data).

## Why it exists

It answers Friction's rising problem **"No way to tell whether an agent run
actually achieved the intended outcome"**. An agent's last message is the
only part most people read, and it is written by the thing being checked.
The run itself already holds the receipts - every command, its output and
exit code, every edit - but nobody reads 400 steps before merging. Proof does
the reading and lines each claim up against them.

Not a repeat: **Burnrate** (2026-10-07) is what an agent *costs*;
**Triage** (2026-10-13) is how to review one big diff you already trust the
author of; **Lanes** (2026-10-11) is parallel agents colliding; **Leash** is
what an agent *may* do; **Sniff** is code from a stranger before you run it.
Proof is whether one run *did what it said*. It follows Sniff's shape: heavy
parsing on the device in a Web Worker, nothing uploaded, and a metered AI
second opinion that sends only snippets the person saw and confirmed.

**Who pays.** Almost nobody. Reading the run, the claims, the receipts, the
criteria, the patterns, the score, the timeline and every export are free,
need no account and make no request. The one metered thing is **"Second
opinion on the outcome"** - a cent or two, Haiku for the free tier, Sonnet
for members via `identity.planFor`.

**The honest risk, said on the page.** Proof checks claims against what the
run recorded; it cannot say the code is right ("Rules, not a judge... read
the diff too"). "No evidence" means the run does not show it, not that it is
false. Its own false positives are kept down on purpose:

- a test run counts only after the last change to **code** - a README edit
  afterwards does not make it stale, and a failed edit changed nothing;
- a passing test named "fails cleanly…" is not a failure, and "0 failed" is
  zero; unknown output stays unknown (exit code only);
- a `grep` that found nothing, a `diff` that found a difference and a failed
  file read are looking around, not errors it ignored;
- `|| true` on `rm` / `mkdir` / `kill` cleanup is not hiding a failure;
- negated, conditional and future sentences ("I didn't run the tests",
  "once it is merged it will be released") are not claims; hedged ones
  ("should be fixed") are marked and weigh half;
- a pattern already in the code before the run (an existing `it.skip`) is
  not listed - only what the run added;
- `.skip(` outside a test file, mocking a dependency, and a test config that
  checks `NODE_ENV` are not flagged.

**How it becomes an iPhone app.** Not for reading transcripts on a phone. A
`claude` / Codex hook (or a CI step) runs the same UMD core on the run that
just finished and posts the verdict and the three checks as a PR comment and
a push: "Agent says done - 1 of 7 claims backed. Tests never re-ran." The
phone is where you get told before you merge.

## The decisions that matter

- **No run reaches the server.** `public/proof-core.js` (UMD:
  `window.ProofCore` in the page and its worker, `require` in the server and
  tests) holds every rule. There is **no route** that accepts a run (POSTs to
  `/api/check`, `/api/run`, `/api/upload`, `/api/analyze`, `/api/transcript`
  are 404s, tested). The core and the demos contain no `fetch` and touch no
  storage. The one model route receives only the payload the person saw and
  confirmed.
- **The run is read in a Web Worker** (`public/parse-worker.js`): a Claude
  Code transcript can run to tens of megabytes. The worker returns the parsed
  run (bounded); the page runs `analyze()` itself, which is cheap, so editing
  the goal or a criterion re-checks instantly without re-reading. If the
  worker cannot start, pasted text and the demos still read on the main
  thread.
- **Formats** (`parseRun`, detected by shape, not by file name): Claude Code
  `.jsonl` (user / assistant lines, `tool_use` / `tool_result`, `isMeta`,
  `isSidechain`, summaries and snapshots skipped and counted), Claude Code's
  terminal pasted (`> prompt`, `⏺ Bash(cmd)` with `⎿` output, `⏺ Update(path)`
  diffs, folded "+N lines" noted), Anthropic messages (including the
  `str_replace_based_edit_tool` and `bash` tools), OpenAI chat
  (`tool_calls` + `role: tool`, JSON replies with `stdout`/`exit_code`),
  OpenAI Responses items and Codex rollouts (`function_call` shell arrays,
  `apply_patch` envelopes, `Exit code: / Wall time:` and `metadata.exit_code`),
  generic tool logs (`tool`, `input`, `output`, `exit_code`, `duration_ms`,
  `role` messages), and plain terminal text (`$` prompts; the summary after a
  `Summary:` line, in its own box, or the trailing paragraph - each said).
- **Every tool call becomes a step** (`describe`, `analyzeCommand`): its kind
  (test / lint / types / build / edit / write / delete / commit / push / pr /
  deploy / migrate / install / run / read / search) from the most telling
  segment of a shell command (split outside quotes, `npx` / `poetry run` /
  env assignments taken off, heredoc bodies read as file content not
  commands), every check it runs, the files it writes or deletes (`sed -i`,
  redirects, `tee`, `mv`, `git rm`, heredocs), the flags that hide failures,
  and whether a test run was only part of the suite (a file, `-t`, `-k`, a Go
  package). Exit codes come from the transcript's own fields or the output
  ("Exit code 1", npm's "Test failed", make's "Error 2").
- **Outputs are read in full, then cut.** Test summaries (Jest, Vitest,
  Mocha, pytest, cargo, Go, node:test, RSpec, unittest, PHPUnit, dotnet,
  Playwright) and checker summaries (ESLint, Ruff, flake8, RuboCop, Prettier,
  clippy, tsc, mypy, pyright, webpack and friends) are parsed from the whole
  output; what is kept for the timeline is the first 3,000 and last 6,000
  characters. A failure printed under exit 0 (`|| true`) is a failed check
  marked **hidden**.
- **Paths** are made relative only to a working directory the run states
  (Claude Code's and Codex's `cwd`, or the agent's own `cd /path`). Guessing
  a common root would turn `src/billing/a.ts` into `a.ts` and break every
  scope check; scope and file matching work on absolute paths too.
- **Bounds, and what was skipped is said**: 32 MB a file, 80,000 lines, 2 MB
  a JSON line, 4,000 steps on the timeline (the rest counted, and the
  verdict says it may be wrong after that point), 24,000 characters of an
  edit kept. Every skip is counted under a reason (`SKIP_WORD`) in "What Proof
  read".

### The verdict rules (`judge*`)

- **Tests**: no test run is No evidence; the last run before the last code
  edit is **No evidence** ("never re-run after the last edit" - the headline
  when it applies); after it: failures, errors, a hidden failure or no tests
  found are **Contradicted**; "all" with skips, or a count that does not
  match, is Contradicted; "all" over only part of the suite is Partly.
- **Lint / types / build**: the same, per checker.
- **Fixed**: the named file must have changed; then the tests after the last
  change decide (failed: Contradicted; passed: Backed; passed with skips, or
  only static checks ran, or nothing ran: Partly).
- **Verified**: a test run or a run of the code after the last change.
- **Files**: a count against every distinct path edited, written or deleted
  (a failed edit is not a change); named files by path suffix. In a complete
  run, a file it names but never touched is Contradicted.
- **New tests**: net test cases added to test files (`it(`, `def test_`,
  `func Test`, …), not merely a touched test file.
- **Commit / push / PR**: the commit's own `[branch hash]` line, a push that
  was not rejected or "Everything up-to-date", a PR link in an output (number
  checked). Changes after the last commit, or a commit after the last push,
  are Partly.
- **Deploy / migrate / coverage / no errors**: their commands' results, the
  coverage figure in the output, and the unaddressed errors.
- The **score** starts at 100; each reason (claims weighted, criteria,
  patterns capped at 45, errors capped at 18) takes its share of what is left,
  so it approaches zero without slamming into it. Bands: 80+ "Looks backed",
  50+ "Check before merging", below "Don't trust this yet". The band must
  agree with the headline, so it is capped: anything Contradicted or a high
  pattern caps it at 49; a tests / fixed / verified claim with no receipt, an
  error it walked past or a medium pattern caps it at 79 (a hostile-input
  pass once showed "tests were never re-run" next to "Looks backed" before
  this). With nothing to check against, it is never above 60.

### The example (`public/demo.js`)

Two **made-up** Claude Code transcripts, labelled so everywhere ("made-up
example"), built as real `.jsonl` so they go through the same parser.
**"The confident one"** fixes a rounding bug, skips the failing discount test
(`it.skip`), adds an empty `catch`, edits a file outside its scope, walks past
a type error, hides a lint failure with `2>/dev/null || true`, commits with
`--no-verify`, and then says all 40 tests pass, no lint errors, 2 files,
verified, PR #128 - "1 of 7 claims backed - tests were never re-run after the
last edit". **"The honest one"** adds a `--dry-run` flag with two tests,
fixes what its own test caught, runs the suite, lint and the type check,
commits, pushes and opens PR #57, and says the README still needs a line -
every claim backed, score 100. The tests pin both outcomes.

## The model call (metered)

`POST /api/opinion`: `requireUser, requireBudget, requireDailyCap` **then**
the 256 KB parser (401 / 402 / 403 / 503, never 413 - tested), then
`ai.cleanRequest` rebuilds the body field by field (anything sent alongside -
the whole run, a `system` field - is dropped; nothing usable is a 400 before
anything is spent). One forced tool, `judge_outcome` `{criteria: [{criterion,
verdict ∈ backed / partly / no-evidence / contradicted, why, evidenceRefs,
whatToCheck}], overall}`, then `ProofCore.cleanJudgement`: unknown criteria,
duplicate answers and unknown verdicts dropped, markup / bidi / control
stripped and bounded, and **step references that were not in the snippets
dropped and counted** (shown on the page). No criteria: the goal is the one
criterion.

- The page builds the payload with `opinionPayload` - the goal, the
  criteria, the claims (with the rules' verdicts) and up to 40 snippets of at
  most 12 lines x 300 characters, the steps the rules leaned on first - shows
  it **in full** with a warning, and a box must be ticked before Send. Signed
  out, the sheet shows exactly what would be sent and offers a free account.
  402 opens the credit sheet; 403 `verify-email` shows its sentence and "Send
  the link again".
- The prompt says the agent's own messages are claims, never evidence; the
  goal and the run are fenced (`<<<GOAL`, `<<<RUN`, with `<<<`/`>>>` inside
  them broken up) as untrusted data that may try to instruct a reviewer. The
  test proves markers sent as extra fields never reach the fake model.

## Local run and tests

```
npm run dev     # memory identity + fake model, at http://localhost:8138/proof/
npm test        # every parser, claims, every verdict, patterns, bounds, escaping, then HTTP under /proof
```

`PROOF_MEMORY=1` (the shared account in memory - Proof has no store of its
own) and `PROOF_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`) - in
`lib/store.js`, `lib/fakeai.js` and `server.js`; the tests spawn each with
`K_SERVICE` to prove it. `npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`
(the dev server does not). The fake model refuses a call that does not force
a tool, logs each request (`fakeCalls`) and reads a verdict per criterion from
the excerpts; triggers `BLANK`, `INJECT`, `BADREFS`, `MAXTOKENS`,
`UPSTREAMnnn`. Screenshots at 390px and 1280px, light and dark (first run,
both demos, a claim open, the timeline, the second-opinion sheet signed out
and answered) and a hostile-input pass were taken with Playwright.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Data

**None in the lab database.** No run, claim, snippet or answer is stored
(tested: the identity store holds only `users`, `usage`, `events`,
`control`). `lib/store.js` reads `PROOF_COLLECTION_PREFIX` so that anything
ever stored is prefixed from its first write. **In the browser:** the last
acceptance criteria typed for a real run, in `localStorage`
`proof-criteria-v1` (a convenience, never sent; the demos do not touch it),
every access in try/catch. A dropped run lives only in the tab.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, the worker, the
service worker. Metered: `POST /api/opinion`. The shared account at
`/api/auth`. There is deliberately no route that takes a run.

## Ideas not built yet

- **A CLI / CI step** (`npx proof check <run.jsonl>`) that posts the
  Markdown as a PR comment - the core is already one UMD file with no
  dependencies.
- **Reading the diff too** (`git diff` alongside the run) to check edits the
  shell made that the transcript cannot show (`git apply`, generated files).
- **Watching a session live** through a Claude Code hook.
- **Per-team rules** ("a migration must be followed by `migrate status`").

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`;
  handlers by `data-act` from one listener (tested here and by
  `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the metered route's gates
  run before its parser.
- A run is hostile by definition: every string from it is drawn through
  `esc()` (control, bidi and zero-width characters stripped, quotes escaped);
  evidence and timeline text shows invisible characters as `⟨U+202E⟩`;
  evidence lines are cut at 240 characters; commands, outputs, diffs and
  evidence scroll in their own box; exports escape for Markdown (a `|` in a
  table cell is escaped even inside a code span). The test greps `app.js` for
  run fields concatenated into markup without `esc()` / `rich()`.
- Failures (`fail()` / `failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
