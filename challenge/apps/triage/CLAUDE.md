# For Claude: Triage

Review the giant AI-written PR in the order that matters - and skim the rest
with a clear conscience. For engineering leads and reviewers whose teams
adopted coding agents and now face 3,000-line pull requests several times a
day, where the real change hides among renames, reformatting, snapshots and
lockfile churn, and nobody can honestly review all of it before release.

Paste `git diff main...HEAD` (or run one command that writes it, or save the
PR's `.diff` from GitHub) - **read on the device, never uploaded** - and get:

- a verdict: "2,380 lines changed - 177 worth reading closely, 2,083
  mechanical you can skim with checks", with a review-time estimate whose
  assumptions are printed;
- the review plan: **read these first** (high risk), **then these**, **read
  quickly**, each file with why it is there in words, a checklist of what to
  look for, and its hunks marked mechanical or meaningful - inside a
  meaningful hunk, line pairs that only changed formatting are quieted (≈) so
  the real change stands out;
- the **skim list**: every mechanical group with the one check that makes
  skimming it safe, and the command to run it; tick files as reviewed
  (kept in this browser only);
- **split it**: a stack of smaller PRs with the git commands, a comment
  asking the author (or agent) to split it, and rules for `CLAUDE.md` /
  `AGENTS.md`;
- a **report** (Markdown and JSON): risk map, what was skimmed and why, what
  was checked. Paths, counts and reasons only - never code.

Built 2026-10-13 as a **business** drop: Glovebox (2026-10-12) was everyday,
so today was the other kind. **Staging only**: no custom domain until Erik
decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/triage`,
served at `challenge.strongtechnicalconsulting.com/triage/` once it has a
`lab.js` entry, deployed with `gcpdeploy ship challenge`. See
`challenge/CLAUDE.md` for mounting, prefixes and graduation. Every browser
URL is relative to `BASE`; keep it that way. **It stores nothing in the lab
database** (see Data).

## Why it exists

It answers Friction's rising problem **"AI-generated PRs too large and
frequent to review before release"**. An agent's PR is big because it does
everything at once: the feature, a rename it fancied, a formatter run, a
regenerated client, a lockfile refresh. The few lines that change who may do
what are in there somewhere. Line counts and file lists treat all of it the
same; Triage separates what a human must read from what a check can vouch
for, and puts the riskiest change first.

Not a repeat: **Lanes** (2026-10-11) predicts collisions between parallel
branches *before merging*; Triage is about reviewing *one* big change well.
**Burnrate** measures what agents cost; **Leash** is what an agent may do.

**Who pays.** Almost nobody. The example, the command, reading the diff, the
sorting, the plan, the checks, the split and its commands, the comment, the
rules and the report are free, need no account, and make no request. The
one metered thing is **"Explain this change"** on one hunk (Haiku for the
free tier, Sonnet for members via `identity.planFor`), about a cent.

**The honest risk.** The rules read diffs, not programs. "Mechanical" means
"the same code by these rules" - and the rules are deliberately conservative
(below) - so every skim group carries a check to run, and the page says
"not safe, run the check" in its footer. Risk detection is by what a change
touches (paths, names, calls), so a logic bug in a file that touches nothing
risky lands in "Low" - read quickly, but still read. It never claims a
file is safe.

**How it becomes an iPhone app.** Not for reading diffs on a phone - for the
lead between meetings: the verdict and the plan read cleanly at 390px, and a
share-extension that takes a PR's `.diff` from Safari would be the obvious
next step. The core is one UMD file already.

## The decisions that matter

- **No diff reaches the server.** `public/triage-core.js` (UMD:
  `window.TriageCore` in the page, `require` in the server and tests) holds
  every rule. There is **no route** that accepts a diff (POSTs to
  `/api/upload`, `/api/diff`, `/api/analyse`, `/api/triage`, `/api/report`
  are 404s, tested); the test holds every request `app.js` makes to
  `api/me`, `api/explain` and the auth/billing routes. The core and the demo
  contain no `fetch` and touch no storage.
- **The command** (`gatherCommand`, sh and PowerShell): `git -c
  core.quotepath=off diff --stat=200 -M base...head` then the full `git diff
  --no-color --no-ext-diff -M` of the same range, into `triage.diff`.
  Branch names are checked against a narrow set and single-quoted. No
  network (tested: no curl/wget/URL/iwr/irm/iex/eval/ssh/push/fetch/pipe
  into a shell/rm). The `--stat` summary lets the parser say "the file may
  have been cut off" when the counts disagree. **Tested against real git**:
  the suite makes a throwaway repo (a 100% rename, a CRLF+spaces-only
  Python edit, a binary, a permission check), runs the exact sh command and
  checks the result; skipped (said so) where git is missing.
- **Reading** (`parseDiff`): git's format or a plain one, any context,
  CRLF, a BOM, a `--stat` block or mail header in front, hunks consumed **by
  their header counts** (a content line `--- x` is content), C-quoted
  paths, renames and copies with their similarity, binary (both forms),
  modes, new and deleted files. Lines kept up to 6,000 per file and 250,000
  in all, 4,000 characters per line; past that only the counts go on and
  the hunk is `cut` - **a cut hunk is never mechanical**. Broken hunks are
  counted ("Read with notes"), never thrown. Invisible characters are kept
  in the parsed text (they are a finding) and only ever drawn through
  `markInvisible` (shown as ⟨U+202E⟩) and `esc()`.

### Mechanical, conservatively

A hunk is split into change blocks (each run of -/+ lines with the context
line either side, so trailing commas and line joins can be judged but a line
moved past other code cannot look equal). A block is mechanical only if:

- **Whitespace / formatting** (`sameCode`, by language - `langOf`):
  - `free` (JS/TS, CSS, C-family, Java, C#, Rust, PHP, JSON, SQL): newlines
    and spaces interchangeable outside strings and comments, except that a
    space between two word characters stays one (`typeof x` is not
    `typeofx`) and in JS a newline after `return`/`throw`/`break`/
    `continue`/`yield` is kept (ASI).
  - `lines` (Go, Kotlin, Scala): newlines end statements (except inside
    brackets); spaces within a line do not matter.
  - `indent` (Python, YAML): newlines **and leading indentation** matter
    (except inside brackets and after `\`).
  - `text` (Markdown, HTML, Ruby, shell, Swift, anything unknown): only
    trailing spaces and line endings. Ruby is here because `foo -1` is not
    `foo - 1`.
  - `exact` (Makefiles, patches): only line endings - a trailing space is
    part of a make value.
  - **Strings are always compared exactly** - a space inside a literal is
    data, in every language, including JS template literals and Python
    triple quotes. A string or block comment that does not end inside the
    block cannot be judged, so the block is meaningful.
  - "Formatting" adds, for languages where it is harmless: quote style
    (JS/TS, CSS, Python; never when the string holds a quote or a
    backslash; never in C-family, where `'a'` is a char, or JSON), JS
    trailing commas before `)]}` (never JSON, never Python, where `(1,)` is a
    tuple), a JS semicolon only where ASI makes it redundant (before `}` or
    before a line starting with a word or string - never before `(`, `[`,
    `` ` ``, `+`, `-`, `/`), CSS's last semicolon.
  - Any invisible character in a block makes it meaningful.
- **Imports reordered** (`isImportBlock`): the same import lines (named
  specifiers sorted), in a different order, per language.
- **A rename across the PR** (`renameMap`): a name swapped for another on
  lines that change nothing else, in 3+ lines across 2+ files, one-to-one.
  Refused when the old name still appears on an added or unchanged line,
  when the new name was already on a removed or unchanged line (it names
  something that existed), or when either sounds like security
  (`SENSITIVE_NAME`: a renamed `requireAdmin` is always read).
- **An import that follows a move** (`followsMove`): a string on an import
  line whose old and new values resolve (relative to the importer's old and
  new paths, or through the same `@/`-style alias) to a file or folder this
  PR renamed - or to the same place, when the importer itself moved.

File-level mechanical kinds, by path: lockfiles, snapshots, vendored,
minified, generated (paths, or a `@generated` / `DO NOT EDIT` marker that
was already there near the top - **a marker added to an existing file is a
finding** (`genMarker`), not a pass), changelogs; a 100% rename or copy with
nothing inside; a binary image/font/media file. A file whose every hunk is
mechanical joins a group by its main kind. A rename with any edit, or a mode
change, is meaningful.

### Risk (`detect`, `REASONS`, `LOOK`)

Each meaningful file gets reasons in words (exports carry only these words;
the page also shows the matching lines and details such as "INVITE_TTL_DAYS:
default 7 → 30") and a checklist per reason. Levels: **High** (▲) - an
existing permission/sign-in condition changed or removed (`access`, the
heaviest), secrets, bidi/zero-width characters (in a line or the file
name), eval/exec/raw HTML, destructive SQL, validation removed, schema and
migrations, tests deleted or skipped, SQL built from strings, install
scripts, CI secrets/privileges/piped installs, binaries that cannot be read,
auth words or paths, payments, security headers/CORS/cookies, a new route
with no test (`routeNoTest`), a lockfile resolving from an odd host.
**Medium** (◆) - routes, infra/CI, config defaults and flags, dependencies,
network calls, raw SQL with parameters, very long lines, swallowed errors,
a non-image binary. **Low** (●) - no test alongside, deleted files, TODOs,
mode changes, or nothing at all. **Skim** (≈) - mechanical. Tests and docs
only get the test-deletion, secret and bidi checks; a `role=` attribute in
markup is not a role check; `RegExp#exec` is not `exec`; placeholders and
test fixtures are not secrets; the same default in other quotes is not a
changed default. Order: level, then the sum of reason weights (+ up to 4
for size). Risk is never colour alone: a word and a shape on every pill and
a coloured edge as well.

### The plan, the estimate, the split

- **Estimate** (`estimate`, printed in the page): high ~200 meaningful lines
  per 10 minutes (floor 3 min a file), medium ~400 (2 min), low ~800 (1
  min), a deleted line a third of an added one, a minute per skim group plus
  a few seconds a file, rounded up to 5; and "high-risk files alone".
- **Skim checks** (`skimCheck`): renames - `git diff -M --summary` shows
  100%; formatting - `git diff -w` / the formatter's `--check`; refactor -
  `git grep -w` the old names finds nothing, then build/type-check;
  lockfiles - the manager's frozen install (`npm ci`, `cargo build
  --locked`...) and no unknown hosts; generated - re-run the generator,
  `git status` clean; snapshots - the runner without rewriting.
- **Split** (`splitPlan`): mechanical first (not a lockfile that moves with a
  dependency change), then dependencies (manifest + its lockfile),
  migrations, then one per concern (permissions, payments, config, infra),
  then by area (`src/server`, `src/web`, ...), at most 7 (the smallest areas
  fold into one "Everything else"). **Tests travel with their code**
  (`testOf`: same stem, and the same folder, a `__tests__` beside it, or a
  test path naming the code's folder); docs and the changelog ride with the
  biggest area. Commands: `PR=$(git rev-parse HEAD)`, then per part `git
  switch -c triage/N-...` (the first from the base), `git restore
  --source="$PR" --staged --worktree -- <paths>`, `git rm` for deletions and
  a rename's old path, `git commit`; then `git diff "$PR" <last>` must print
  nothing; then the pushes. Paths are shell-quoted. Plus the comment for the
  author and `AGENT_RULES` for CLAUDE.md/AGENTS.md.

### The example (`public/demo.js`)

"Add team invitations" on a made-up app ("crewdeck"), by an AI coding agent:
43 files, ~2,380 lines, written out as the exact text the command produces
(a `--stat` block that agrees with the diff) and read by the same parser.
Planted, and asserted to be exactly what Triage finds: **the one that
matters** - `src/server/teams/access.ts` looks like a prettier reformat
(four of its five hunks are) but its third hunk turns "owner or admin" into
"anyone but a viewer" in `canManageTeam`; it ranks first. Also a migration,
a new route with no test (that also swallows an email error and leaves a
TODO), the invitation service with its test, a config default (7 → 30) and
a flag, a new dependency; and the noise - a folder moved (six 100% renames,
imports following it), `getTeamMembers` → `listTeamMembers` in six files,
nine files reformatted, four snapshots, a 1,000-line lockfile refresh, a
regenerated API client, imports reordered, the changelog. Never saved.

## The one model call (metered)

**Explain this change** - `POST /api/explain`: `requireUser,
requireBudget, requireDailyCap` **then** a 128 KB parser (401/402/403,
never 413 - tested), then `ai.cleanRequest` rebuilds the body - a clean path
and up to 400 diff lines (each `+`, `-`, space or `@@`, 1,000 characters,
64,000 in all, invisible characters made visible) - so anything sent
alongside (the rest of the diff, other files, contents, a "system" field)
is dropped; nothing usable is a 400 before anything is spent. One forced
tool, `explain_change` `{summary, risks: [{risk, line_hint}],
questions_for_author, tests_to_add}`, then `TriageCore.cleanExplanation`
(bounded, markup/bidi/control stripped; no summary is a 422). The prompt
fences the diff and says it is **untrusted data** whose comments may try to
instruct a reviewer or an AI - never instructions, and worth reporting as a
risk.

The page builds the payload with `TriageCore.explainPayload` (one hunk, or
the whole file when it fits in 400 lines; a hunk not fully kept in memory
is refused) and **shows it in full** with a warning that it sends that code
to an AI provider, and a checkbox that must be ticked before Send enables.
Signed out, the sheet explains, shows exactly what would be sent and offers
a free account. 402 opens the credit sheet; 403 `verify-email` shows its
sentence and "Send the link again". The answer shows under the hunk (this
tab only) with "Copy as a review comment". The test proves markers sent as
`diff`, `files`, `contents` and `system` never reach the fake model, and
that its user message is exactly the path and those lines.

## Local run and tests

```
npm run dev     # memory identity + fake model, at http://localhost:8130/triage/
npm test        # pure rules, real git, then end to end over HTTP under /triage
```

`TRIAGE_MEMORY=1` (the shared account in memory - Triage has no store of its
own) and `TRIAGE_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`) - in
`lib/store.js`, `lib/fakeai.js` and `server.js`; the tests spawn each with
`K_SERVICE` to prove it. `npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`
(the dev server does not, so a new dev account sees the verify-email
sentence - set it to 0 to try Explain). The fake model refuses a call that
does not force a tool, logs each request (`fakeCalls`) and answers with
line counts and one risk per removed condition; triggers in a diff line:
`BLANK`, `INJECT`, `MAXTOKENS`, `UPSTREAMnnn`. Screenshots at 390px and
1280px, light and dark (first run, the verdict, the plan, the hidden-change
hunk, a high-risk file and its checklist, the skim list, the split, the
report, the explain sheet signed out and signed in, the answer) and a
hostile-input pass (markup, bidi and a 3,000-character line in paths and
diff lines: no dialog, no injected element, no horizontal scroll) were
taken with playwright-core against the dev server.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Data

**None in the lab database.** No diff, path, hunk or answer is stored
(tested: the identity store holds only `users`, `usage`, `events`,
`control`). `lib/store.js` reads `TRIAGE_COLLECTION_PREFIX` so that anything
ever stored is prefixed from its first write. **In the browser:** the
"reviewed" ticks in `localStorage` `triage-reviewed-v1`, keyed by a hash of
the diff text (`hashText`, never sent), paths only, the twenty most recent
diffs; and the command's settings in `triage-cmd-v1`. Every access in
try/catch; "Clear ticks" on the plan. A loaded diff lives only in the tab.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page. Metered:
`POST /api/explain`. The shared account at `/api/auth`. There is
deliberately no route for a diff.

## Ideas not built yet

- **Reading a PR from GitHub by URL** - needs a token on the server (private
  repos), which this app does not hold; and it would mean uploading code.
- **Per-hunk ticks and reviewer notes** in the report.
- **A share-extension / CLI** that runs the command and opens the plan.
- **Semantic "mechanical"** (an AST diff) - would catch more reformatting
  safely, at the cost of a parser per language in the page.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`;
  handlers by `data-act` from one listener (tested here and by
  `challenge/test/lab.js` once mounted).
- No model call for a signed-out visitor, ever; the metered route's gates run
  before its parser.
- Paths and diff lines are hostile: `esc()` strips control, bidi and
  zero-width characters (and escapes quotes), diff lines show invisible
  characters as ⟨U+XXXX⟩, long lines are cut for display, diffs and commands
  scroll in their own box, and exports escape for Markdown (code spans that
  survive backticks and pipes). Exports carry paths, counts and reasons -
  never a line of code (tested against the demo's code).
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
