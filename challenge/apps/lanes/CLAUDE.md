# For Claude: Lanes

Run coding agents in parallel without them stepping on each other. For
developers and engineering leads running several coding agents at once
(Claude Code, Codex, Cursor background agents...) - or several people on
parallel branches and worktrees - who end up with two agents rewriting the
same file, both bumping the lockfile, two migrations numbered 0042, the same
helper written twice, and an afternoon of merge conflicts. Two modes:

- **Check the branches** (agents already running): copy one command, run it
  in the repo, drop in the file it writes - **read on the device, never
  uploaded** - and get a verdict ("2 branches merge clean · 3 collide on 4
  files · 1 migration number clash"), the collisions file by file with the
  exact line ranges, shared state, duplicate work, and a merge order with the
  commands.
- **Plan the lanes** (about to start): tasks, the paths each lane owns
  (picked from the real tree), overlaps flagged, rules for shared files,
  migration numbers reserved per lane, and a brief per agent with its
  `git worktree add` command.

Built 2026-10-11 as a **business** drop: Sprout (2026-10-10) was everyday,
so today was the other kind. **Staging only**: no custom domain until Erik
decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/lanes`,
served at `challenge.strongtechnicalconsulting.com/lanes/` once it has a
`lab.js` entry, deployed with `gcpdeploy ship challenge`. See
`challenge/CLAUDE.md` for mounting, prefixes and graduation. Every browser
URL is relative to `BASE`; keep it that way. **It stores nothing in the lab
database** (see Data).

## Why it exists

It answers Friction's rising problem **"Parallel coding agents duplicate or
conflict on shared state and branches"**. Running agents in parallel is
cheap; merging what they made is not. Git tells you about a conflict only
when you merge, one pair at a time, and tells you nothing about the clashes
that merge cleanly - two migrations with one number, two version bumps, the
same helper in two files. Lanes reads every branch's diff against the base
at once, before anyone merges, and turns it into an order and the commands.

Not a repeat: **Burnrate** measures what agents cost; **Leash** is about
what an agent may *do*; nothing in the lab or the portfolio plans or checks
parallel work.

**Who pays.** Almost nobody. The example, the command, reading the file, the
whole check, the merge order, the planner, the picker, the briefs and the
Markdown/JSON report are free, need no account, and make no request. The one
metered thing is **"Split this into lanes for me"** (Haiku for the free
tier, Sonnet for members via `identity.planFor`), a cent or two.

**The honest risk.** The check reads diffs, not code. It knows which base
lines each branch changed and applies git's own rule for when two changes
conflict, so "will conflict" is reliable for branches cut from the same
base; it cannot say whether code that merges cleanly still works together
(the footer says so). Duplicate detection reads names of things defined in
added lines - a helper written under two different names is missed, and the
page does not claim otherwise.

**How it becomes an iPhone app.** Not for reading diffs on a phone. For the
lead: a widget of "3 agents running, 1 collision" fed by a small CLI or a
`claude` hook that runs the gather command on a schedule and keeps only the
verdict. The core is one UMD file already.

## The decisions that matter

- **No diff reaches the server.** `public/lanes-core.js` (UMD:
  `window.LanesCore` in the page, `require` in the server and tests) holds
  every rule. There is **no route** that accepts a diff (POSTs to
  `/api/upload`, `/api/diff`, `/api/check`, `/api/gather`, `/api/plan` are
  404s, tested); the test holds every request `app.js` makes to `api/me`,
  `api/split` and the auth/billing routes. The core and the demo contain no
  `fetch` and touch no storage.
- **The gather command** (`gatherCommand`), POSIX sh and PowerShell, built
  from the base branch and either a pattern (`git for-each-ref` over
  `refs/heads/<p>` and `refs/remotes/<p>`, so `origin/agent/*` works after a
  fetch) or a list of names. It runs `git ls-files`, then per branch
  `git log --format='%h%x09%an%x09%aI%x09%s' base..branch` and
  `git diff --no-color --no-ext-diff --unified=0 -M base...branch`, between
  `#lanes` marker lines, into `lanes.txt`. `printf '%s\n'` rather than
  `echo` (dash interprets backslashes). Inputs are checked against a narrow
  character set and single-quoted, so nothing typed can change what runs.
  **No network**: the test refuses curl, wget, any URL, `iwr`/`irm`/`iex`,
  `eval`, ssh, `git push/fetch/pull/clone/remote`, a pipe into a shell,
  `rm`. The page explains it line by line.
- **The real command is tested against real git**: the suite makes a
  throwaway repo (two branches touching adjacent lines, a rename, a binary,
  a delete, CRLF, two `0002_` migrations, an empty branch), runs the exact
  sh command, parses the file, and then asks git to merge the branches -
  git's own `CONFLICT (content)` agrees with the check. Skipped (said so)
  where git is missing.
- **Reading** (`createGatherParser`, `createDiffParser`, `parseInput`):
  streamed by line, chunk boundaries anywhere (tested at 1..64), CRLF and a
  BOM, hunks consumed **by their header counts** (so a content line
  `--- x` is content), git's C-quoted paths decoded, renames (`rename
  from/to`, else differing `---`/`+++`, else the header), binary (`Binary
  files`, `GIT binary patch` skipped), deletes, mode changes, empty
  branches, a file cut off before `#lanes end`. Anything broken is counted
  and listed under "Read with notes", never thrown. The same parser takes
  one pasted diff (git's or a plain one, with context lines - runs are then
  walked from the lines) and a bare `git ls-files` list.
- **Change runs, git's merge rule.** Each file keeps its changes as runs in
  BASE coordinates (`i` first base line index, `chg` base lines replaced;
  `chg 0` is an insertion before line `i`) plus a hash of the added text.
  `runRelation` is xdiff's own test: two runs conflict unless one ends
  strictly before the other starts - so **touching lines conflict too**
  (line 10 vs line 11; an insertion right before or after a changed line),
  an insertion after line 10 and one after line 11 do not, and an
  identical change on both sides is `same` (git merges it). Labelled
  `overlap` (a shared line, or one spot) vs `adjacent` (touching).
- **Collisions** (`collisions`): every base path touched by 2+ branches
  (renames keyed by their base path), each pair judged: overlap, adjacent,
  clean, same, both-added, delete-modify, binary on both, rename-rename,
  rename-vs-edit (usually fine). Sorted worst first, code before lockfiles.
  The matrix counts shared and conflicting files per pair.
- **Shared state** (`sharedState`, `hotspotKind`, `migrationOf`):
  lockfiles (npm, yarn, pnpm, bun, Gemfile, poetry, Pipfile, uv, Cargo,
  go.sum, composer, mix, Podfile, NuGet, flake, pubspec), each with its
  regenerate command; dependencies read from the edited lines of
  package.json/composer.json, requirements/pyproject/setup, Gemfile,
  go.mod, Cargo.toml (both add = warn, one dependency to two versions =
  clash); version bumps of the same field; migrations by scheme - Rails
  `db/migrate/<14 digits>_`, Django `<app>/migrations/NNNN_` (per app),
  Prisma `migrations/<ts>_x/migration.sql`, Knex/TypeORM timestamps,
  Flyway `V42__`, plain `NNNN_*.sql` and golang-migrate `.up.sql` (0042 and
  42 are one number), and Alembic by two new files with the same
  `down_revision` (two heads); schema files; generated files by path
  (`dist/`, `__generated__/`, `.pb.go`, `_pb2.py`, `.g.dart`, `.min.js`,
  snapshots) or by a marker in the diff (`@generated`, `DO NOT EDIT`...);
  CI config; agent instructions (CLAUDE.md anywhere, AGENTS.md, GEMINI.md,
  .cursorrules, .cursor/rules, copilot-instructions, .claude/); changelogs;
  registries every feature appends to (route indexes, urls.py, routes.rb,
  app.module.ts, settings.py).
- **Duplicate work** (`duplicates`, `definedName`): names defined in ADDED
  lines of code files (JS/TS functions, classes, function-valued and
  exported consts, interfaces/types; Python and Ruby `def`/`class`; Go
  `func`; Rust `fn`; Java/C#/Kotlin classes), folded case- and
  underscore-insensitively, on 2+ branches. A name also on a removed line
  of that file is a modification, not new; test files, generated files,
  migrations and a stop list of generic names (`setup`, `handler`,
  `render`...) never count. Plus new files with the same or a near-same
  name (containment for 5+ characters, one edit for 6+), generic stems
  skipped.
- **Merge order** (`mergeOrder`): conflicting pairs (files and clash-level
  shared state) form a graph. Clean branches go first, smallest first. Then
  the **fewest branches do the rebasing**: a minimum vertex cover of the
  graph (exact up to 16 colliding branches, greedy past that; ties go to
  the cover whose contested changes are smaller, so the smaller edit is the
  one redone), and a branch others are stacked on (all its commits in
  theirs) never waits. Each rebase step lists what to resolve and with
  whom (line ranges), takes the base's lockfile during the rebase and
  regenerates it once (`git checkout --ours` - during a rebase, ours is the
  base), renumbers a clashing migration with `git mv` to the next free
  number past everything in the tree and every branch, and says when a
  helper is already in from an earlier merge or a generated file needs
  regenerating. Branch names that are not shell-safe are single-quoted.
- **The verdict**: "N branches merge clean · M collide on F files · K
  migration number clashes" (+ "with no changes yet"), and a second line
  for lockfiles, version clashes, helpers written twice and generated
  files edited by hand. Tone: collide / check / clean.

### The example (`public/demo.js`)

"shopfront", a made-up web shop: 121 files (41 migrations up to 0041) and
five branches, written out as **the exact text the command produces** and
read by the same parser. Planted, and asserted to be exactly what the check
finds: `agent/auth` and `agent/billing` change lines 40-45 and 44-51 of
`src/lib/db.ts`, both add `0042_*.sql`, both bump package.json's version
(1.9.0 vs 1.8.1) and add a dependency, both rewrite package-lock.json;
`agent/search` changes the line right after `agent/billing`'s new route in
`src/routes/index.ts` (touching) while `agent/auth`'s is further up
(clean); `agent/search` and `agent/ui-polish` each write `debounce`, in
different files; `agent/search` hand-edits a generated API client; and
`agent/docs` touches nothing anyone else does. Verdict: "2 branches merge
clean · 3 collide on 4 files · 1 migration number clash"; merge order
docs, ui-polish, auth, search, then billing rebases once. The example plan
is the same repo before the agents started: four lanes with one planted
overlap (`src/components/Header.tsx` owned by search and ui-polish) and a
negation (`!src/components/ProductList.tsx`). Never saved.

### Planning

- **Globs** (`compileGlob`), gitignore-style: `*` and `?` inside one
  folder, `**` across folders (and zero of them), `[abc]`, `{a,b}`, a
  pattern with no slash matches at any depth, a leading `/` anchors, a
  folder matches everything under it (`src/lib` is not `src/lib2`), a
  leading `!` takes files back out. `..` is refused. A pattern that matches
  nothing yet is "new" (inside an existing folder) or "no files yet" -
  never an error, because new code has no files.
- **The picker**: the real tree with file counts per folder, which other
  lane already owns how much of it, "+ Own"/"+ Read" per folder (`dir/**`)
  or file, and a typed pattern with a live count and examples.
- **The check** (`checkPlan`): overlaps between lanes (hotspots excluded),
  lanes that own nothing, files nobody owns (read-only for everyone), and
  **hotspots** (`hotspots`: the same kinds as shared state, grouped - one
  row per migrations folder or generated folder, one per basename past six
  of them) each with an editable **rule** ("Only the lead touches
  package-lock.json...") and a warning when a lane's patterns reach it.
  Hotspots belong to no lane even when a pattern covers them.
- **Migration numbers** (`reserveMigrations`): per numbered migrations
  folder, the next free numbers, handed out in lane order; "Auto" gives one
  to a lane whose task mentions the database, else none; 0-3 on the lane.
  Timestamped schemes get a rule instead.
- **Briefs** (`brief`, `allBriefs`): Markdown to paste into an agent's first
  message - branch, worktree and its `git worktree add -b`, the task, owned
  paths (with counts or "new"), read-only paths including every other
  lane's, the hotspot rules, its migration number, and a pre-PR checklist.
  Escaped lightly on purpose (`mdPlain`: one line, no control or bidi
  characters, nothing that starts a block), because an agent reads it raw.
  One file for the whole team with a warning at the top for any overlap.

## The one model call (metered)

**Split this into lanes for me** - `POST /api/split`: `requireUser,
requireBudget, requireDailyCap` **then** a 512 KB parser (5,000 paths fit;
401/402/403, never 413 - tested), then `ai.cleanRequest` rebuilds the body
field by field - tasks (12, 300 characters), paths (5,000, each a clean
path no longer than 300 with no `..`), folder counts (1,500) - so a diff, a
branch or file contents sent alongside are dropped; nothing usable is a 400
before anything is spent. One forced tool, `propose_lanes` `{lanes: [{name,
task, owns, readOnly, notes}], hotspots: [{path, rule}]}`, then
`LanesCore.cleanProposal`: **every pattern must match a file in what was
sent, or be one new folder or file directly inside a folder that exists**
(`src/billing/**` when `src` exists; `lib/x/y/**` with no `lib/x` is
dropped and reported), names slugged and unique, text bounded and stripped
of markup, bidi and control characters. Nothing usable is a 422. The page
re-checks the proposal against the full tree, shows its overlaps, the rules
and what was left out, and only "Use this split" replaces the lanes.

The page builds the payload with `LanesCore.splitPayload` - the tasks and the
file paths, or past 5,000 paths the folders with counts plus the shared
files by name - and **shows it in full before sending** (signed out, the
sheet explains, shows what would be sent and offers a free account). 402
opens the credit sheet; 403 `verify-email` shows its sentence and "Send the
link again". The test proves markers planted as `diff`, `branches`,
`contents` and a hostile path never reach the fake model's request, and that
the demo payload carries no diff text, commit, author or branch name.

## Local run and tests

```
npm run dev     # memory identity + fake model, at http://localhost:8128/lanes/
npm test        # pure rules, real git, then end to end over HTTP under /lanes
```

`LANES_MEMORY=1` (the shared account in memory - Lanes has no store of its
own) and `LANES_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`) - in
`lib/store.js`, `lib/fakeai.js` and `server.js`; the tests spawn each with
`K_SERVICE` to prove it. `npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`
(the dev server does not, so a new dev account sees the verify-email
sentence - set it to 0 to try the split). The fake model refuses a call
that does not force a tool, logs each request (`fakeCalls`) and proposes one
lane per task from folders sharing a word with it (plus a made-up folder, to
exercise dropping); triggers in a task: `BLANK`, `INJECT`, `MAXTOKENS`,
`UPSTREAMnnn`. Screenshots at 390px and 1280px, light and dark (first run,
the command, the verdict, the matrix, a collision opened, shared state,
duplicates, merge order, the planner, the picker, a brief, the AI sheet
signed out and signed in, the proposal) and a hostile-input pass (markup,
bidi and a 3,000-character line in branch names, paths and diff lines: no
dialog, no injected element, no horizontal scroll) were taken with
playwright-core against the dev server.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Data

**None in the lab database.** No diff, path, plan, payload or answer is
stored (tested: the identity store holds only `users`, `usage`, `events`,
`control`). `lib/store.js` reads `LANES_COLLECTION_PREFIX` so that anything
ever stored is prefixed from its first write. **In the browser:** the last
plan of your own (tasks, lanes, settings, rules - and the file PATHS, up to
20,000, so the checks still work when you come back; never a diff) in
`localStorage` `lanes-plan-v1`, and the command's settings in
`lanes-cmd-v1`. Every access in try/catch; Clear on the first run and the
planner. The example is never saved. A loaded gather file lives only in the
tab.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page. Metered:
`POST /api/split`. The shared account at `/api/auth`. There is deliberately
no route for a diff.

## Ideas not built yet

- **A summary card** (canvas PNG, two taps to share) like Burnrate's - the
  Markdown export covers the PR comment for now.
- **A CLI / `claude` hook** that runs the gather command on a schedule and
  warns in the terminal when two running agents start touching the same
  lines - the core is already one file.
- **Semantic duplicates** (the same helper under two names) - would need
  the code itself, which this app deliberately never sends anywhere.
- **Reading PRs from GitHub** instead of a command - needs a token on the
  server, which this app does not hold.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`;
  handlers by `data-act` from one listener (tested here and by
  `challenge/test/lab.js` once mounted).
- No model call for a signed-out visitor, ever; the metered route's gates run
  before its parser.
- Paths, branch names, commit messages and diff lines are hostile:
  `clean()`/`esc()` strip control, bidi and zero-width characters (and
  escape quotes), every render goes through `esc()`, long lines are cut for
  display, diff and code blocks scroll in their own box, and each export
  escapes for its own format (code spans that survive backticks and pipes;
  prose with markup and link syntax escaped). Exports carry paths, line
  numbers, branch names and commands only - never a line of code (tested).
- Commands built from a repo's names quote anything not plainly safe.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
