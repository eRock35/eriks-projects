# For Claude: Sniff

Before you install that app, see where it could send your data. For IT
generalists, security-minded power users and small-business owners about to
install a browser extension, an npm or PyPI package, a GitHub repo, or an
AI-built tool from one person, who want to know — before they run it —
whether it reads secrets and sends them somewhere.

Drop a folder, a `.zip` (extension or repo download), a `.crx` (Chrome
extension), or a `.tgz` / `.tar.gz` (npm tarball), or paste code. It is
**read on the device, never uploaded**, and you get:

- a **verdict**: "3 things to look at before you install" / "Nothing reaches
  out — still read it";
- a **data map**: what the code can read (cookies, keys, env vars, the
  clipboard, `~/.ssh` / `.npmrc` / `.env`, browser passwords, wallets) joined
  to where it could send each one, risky destinations first;
- **findings** by severity, each with file and line, a snippet, a
  plain-English sentence and why it matters — flows (a source meeting a sink)
  ranked highest, then destinations, install-time scripts, hiding, lone
  sources and sinks, and extension permissions;
- a **destinations** table, every host tagged (risky / its own site / known /
  unknown / local / built at run time);
- **what the extension asks for**, in plain words;
- what was **not read**, and why;
- Markdown and JSON **export**, and "Looked at — fine" marks per finding
  (kept in this browser).

Built 2026-10-17 as a **business** drop: Jars (2026-10-16) was everyday, so
today was the other kind. **Staging only**: no custom domain until Erik
decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab — `challenge/apps/sniff`,
served at `challenge.strongtechnicalconsulting.com/sniff/` once it has a
`lab.js` entry, deployed with `gcpdeploy ship challenge`. See
`challenge/CLAUDE.md` for mounting, prefixes and graduation. Every browser
URL is relative to `BASE`; keep it that way. **It stores nothing in the lab
database** (see Data).

## Why it exists

It answers Friction's rising problem **"No way to vet single-contributor /
AI-generated apps for exfiltration code"**. More software now comes from one
person or an agent, published straight to a store or a registry with no
review in between; the few lines that read a token and send it somewhere are
buried in ordinary code. Sniff is the quick first look a careful person would
do by hand — the sources worth stealing, the ways out, the hiding — done
consistently and explained in plain words, so the decision to install is made
with eyes open.

Not a repeat: **Triage** (2026-10-13) reviews one big AI-written *diff* you
already trust the author of; **Leash** is what an agent you run may do;
**Sniff** is about code from someone you do *not* know, before you run it at
all. **Zoned** (2026-10-15) and **Lanes** read a file you already have on
your device too, which is the lab pattern this follows.

**Who pays.** Almost nobody. The scan, the data map, the findings, the
destinations, the permissions, the export and the "looked at" marks are free,
need no account, and make no request. The two metered things are **"Explain
this finding"** (one finding) and **"Second opinion"** (the whole scan),
about a cent each — Haiku for the free tier, Sonnet for members via
`identity.planFor`.

**The honest risk, said on the page.** Sniff reads the code; it does not run
it. "It could read your cookies and send them to a webhook" means the text
contains both, near each other — not that it was watched happening. Code that
builds its calls at run time (a string assembled from pieces, a URL fetched
then `eval`-ed) can hide from any static reader, so the page says plainly:
read what it flags, and read the rest too. False positives are kept honest —
a `fetch` alone is `info`, a `fetch` to the package's own API is `low`,
`RegExp#exec` is not `child_process.exec`, `NODE_ENV` is not a secret.

**How it becomes an iPhone app.** A share-extension that takes a `.crx` or a
`.tgz` from Safari or Files and opens the report; the whole scanner is one
UMD file and a worker already, and it needs no network for the scan.

## The decisions that matter

- **No code reaches the server.** `public/sniff-core.js` (UMD:
  `window.SniffCore` in the page and its worker, `require` in the server and
  tests) holds every rule. There is **no route** that accepts a file, an
  archive or a line of code (POSTs to `/api/scan`, `/api/upload`,
  `/api/files`, `/api/analyse` are 404s, tested). The core and the demo
  contain no `fetch` and touch no storage. The two model routes receive only
  the snippet payloads the person saw and confirmed.
- **The scan runs in a Web Worker** (`public/scan-worker.js`), so a large
  folder or a heavy archive never freezes the page. It unpacks archives,
  reads files, runs the rules and posts back the report plus the text of
  **only the files a finding points at** (so the two AI buttons can build
  their snippets without the page holding every file). If the worker cannot
  start, paste still scans on the main thread.
- **Archives, read in the browser** (`openArchive`): `.zip` / `.xpi`
  (central-directory parse, stored and deflate entries, Zip64), `.crx` (the
  `Cr24` signature header set aside, the zip inside read — CRX2 and CRX3),
  `.tgz` / `.tar.gz` (`DecompressionStream('gzip')` then a tar reader, the
  npm `package/` root dropped), a plain `.tar`, and a single gzipped file.
  A zip bomb is cut at `LIMITS.unpacked`; encrypted and unsupported entries
  are listed, not silently dropped. Junk bytes are a one-sentence rejection.
- **Bounds, and what was skipped is said** (`collect`): file count, total
  bytes, per-file bytes (the rest cut and marked), entry count. `node_modules`
  and other dependency folders, lockfiles, images, fonts, media, binaries and
  docs are skipped unless the package *is* the thing; every skip is counted
  under a reason the page words (`REASON_WORDS`). One shared top folder is
  dropped from every path.

### The rules (`RULES`, run line by line with a keyword prefilter)

Languages: JS/TS/MJS/CJS/JSX/TSX (and HTML), Python, shell, PowerShell,
Windows batch, plus `manifest.json`, `package.json`, `setup.py`,
`pyproject.toml`. Categories:

- **Sources** — `document.cookie`, `chrome.cookies`, local/session storage
  (copying *all* of it is worse than reading one key), IndexedDB, the
  clipboard, keystroke listeners on the page, history/tabs/bookmarks, screen
  capture, env vars (a secret-looking name is a source, `NODE_ENV` and npm's
  own lowercase `npm_*` are not), credential files (`~/.ssh`,
  `~/.aws/credentials`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`,
  Docker/kube/gcloud/gh logins, `.gnupg`, shell history), `.env`, browser
  profile files (Login Data, key4.db, cookies.sqlite), crypto wallet dirs and
  wallet-extension ids, Python keyloggers and `CryptUnprotectData`.
- **Sinks** — `fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`,
  `EventSource`, an image `.src=` carrying data, a script added at run time, a
  remote `<script>`; Node `http(s)`/`net`/`dgram`/`tls`/`dns` and
  axios/got/etc; Python `requests`/`httpx`/`urllib`/`http.client`/`socket`/
  `smtplib`; `child_process`/`subprocess`/`os.system`; `curl`/`wget`/`nc`/
  `/dev/tcp`; PowerShell `Invoke-WebRequest`/`WebClient`/`TcpClient`,
  `certutil`/`bitsadmin`/`mshta`; and extension message passing as a handoff.
- **Hiding** — `eval`, `new Function`, `setTimeout` with a string, Python
  `exec`/`compile`; base64/char-code/escape-run text (decoded, and the URL or
  code inside it reported); a date gate or a not-in-CI check (a time bomb);
  encoded PowerShell, `IEX`, `curl … | sh`, `marshal`/`zlib`/`rot13`; and a
  one-line file that is not a known minified library.
- **Install-time** — npm `preinstall`/`install`/`postinstall`/`prepare`
  scripts (a risky one — curl, a pipe to a shell, `node -e` — is high), a
  URL/git dependency, `setup.py` `cmdclass` and an unusual build backend, and
  `__init__.py` code that runs on import. A source or sink in a file that runs
  at install is bumped.
- **Extension permissions** from `manifest.json` (MV2 and MV3), each in plain
  words (`PERMS`): `<all_urls>` and `*://*/*`, cookies, webRequest(+Blocking),
  history, tabs, clipboardRead, nativeMessaging, debugger, scripting,
  declarativeNetRequest, proxy, and the rest; a content script matching every
  site; `externally_connectable` to all; a loosened CSP.
- **Destinations** — every hard-coded host or URL, each tagged: **risky**
  (Discord/Telegram webhooks, paste sites, anonymous file drops, tunnels,
  request catchers, DNS catchers, dynamic DNS, raw IPs, `.onion`),
  **first-party** (matches the package's `homepage`/`repository` host),
  **known** (a big CDN or service — not "safe", just known), **unknown**,
  **local**, or **built at run time**.
- **Flows (the headline)** — a sensitive source and a sink that meet: on one
  line, through a variable (a light taint pass), within a bounded distance,
  across two extension scripts via a message, or across an `import`. Ranked by
  how sensitive the source is and how risky the destination. Several reads
  sent by the same line are one flow; the lone source and sink it joins are
  listed but counted once, as the flow.

### The example (`public/demo.js`)

Two **fabricated** samples, labelled as such everywhere, with endpoints that
go nowhere real (203.0.113.0/24 is TEST-NET-3; the webhook token is plainly
fake). **"Weather Pal"** is a made-up extension plus an npm build helper:
mostly ordinary (a popup that geolocates and calls a weather API, a usage
ping to its own site), with two planted problems — a content script that
reads cookies and storage and hands them to a background script that posts to
a fake Discord webhook, and a `postinstall` that reads `.npmrc` and
`$NPM_TOKEN` and curls them to a reserved IP. The tests assert Sniff finds
exactly those, ranks the two flows first, and tags both destinations risky.
**"Tidy Tabs"** is the clean one — it talks to no network — so the report
shows what "nothing found" looks like, and that it still says "read it".

## The two model calls (metered)

Both: `requireUser, requireBudget, requireDailyCap` **then** the parser (128
KB for explain, 256 KB for review — 401/402/403, never 413, tested), then
`ai.cleanExplain` / `ai.cleanReview` rebuild the body field by field so
anything sent alongside (whole files, other paths, a `system` field) is
dropped; nothing usable is a 400 before anything is spent. One forced tool,
`give_opinion` `{verdict ∈ {likely-benign, worth-checking, likely-malicious},
why, whatToCheck: [...], confidence}`, then `SniffCore.cleanOpinion` (bounded,
markup/bidi/control stripped; no `why` or a bad verdict is a 422).

- **Explain this finding** (`POST /api/explain`) sends `explainPayload` — the
  ~20 lines around the finding (both ends of a flow), at most 4 snippets,
  bounded. **Second opinion** (`POST /api/review`) sends `reviewPayload` —
  the scan's shape (findings, permissions, destinations) plus up to 40
  snippets around the findings that matter. Never a whole file.
- The page builds each payload with the core, **shows it in full** with a
  warning that it sends that code to an AI provider, and a checkbox that must
  be ticked before Send enables. Signed out, the sheet explains, shows exactly
  what would be sent and offers a free account. 402 opens the credit sheet;
  403 `verify-email` shows its sentence and "Send the link again".
- The prompt fences the code and says it is **untrusted data** whose comments
  may try to instruct a reviewer or an AI — never instructions, and worth
  flagging. The test proves markers sent as extra fields never reach the fake
  model, and that only the chosen snippets do.

## Local run and tests

```
npm run dev     # memory identity + fake model, at http://localhost:8133/sniff/
npm test        # pure rules, archive readers, then end to end over HTTP under /sniff
```

`SNIFF_MEMORY=1` (the shared account in memory — Sniff has no store of its
own) and `SNIFF_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`) — in
`lib/store.js`, `lib/fakeai.js` and `server.js`; the tests spawn each with
`K_SERVICE` to prove it. `npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`
(the dev server does not, so a new dev account sees the verify-email
sentence). The fake model refuses a call that does not force a tool, logs each
request (`fakeCalls`) and reads a verdict from the sent text; triggers:
`BLANK`, `INJECT`, `MAXTOKENS`, `UPSTREAMnnn`. The test suite builds its own
zip, crx and tgz fixtures (the sandbox has no sample archives) and drives the
real readers. Screenshots at 390px and 1280px, light and dark (the empty
state, the demo report, a finding expanded, the clean sample) and a
hostile-input pass (markup, bidi and a long line in paths and code) were taken
with playwright-core.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies — edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Data

**None in the lab database.** No file, path, finding or answer is stored
(tested: the identity store holds only `users`, `usage`, `events`,
`control`). `lib/store.js` reads `SNIFF_COLLECTION_PREFIX` so that anything
ever stored is prefixed from its first write. **In the browser:** the "looked
at — fine" marks in `localStorage` `sniff-fine-v1`, keyed by a hash of the
scan (never sent), the 30 most recent scans; every access in try/catch. A
scanned drop lives only in the tab, in the worker's memory.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, the worker, the
service worker. Metered: `POST /api/explain`, `POST /api/review`. The shared
account at `/api/auth`. There is deliberately no route that takes code.

## Ideas not built yet

- **Reading a package by name** (`npm view`, a PyPI download) — needs the
  server to fetch it, which means it leaves the device; keep it a drop.
- **An AST-based "mechanical vs meaningful"** read to cut false positives on
  minified bundles, at the cost of a parser per language in the page.
- **A share-extension / CLI** that opens the report from Files or a registry.
- **Comparing two versions** of a package to show what a new release added.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`;
  handlers by `data-act` from one listener (tested here and by
  `challenge/test/lab.js` once mounted).
- No model call for a signed-out visitor, ever; the metered routes' gates run
  before their parsers (an oversized signed-out body is a 401, not read).
- Scanned code is hostile by definition: `esc()` strips control, bidi and
  zero-width characters (and escapes quotes); invisible characters are shown
  as `⟨U+XXXX⟩` and sent to the model that way; snippets and wide tables
  scroll in their own box; exports escape for Markdown. Findings and exports
  carry titles, paths and short snippets — the report JSON does carry the
  snippet it drew, which is the person's own code staying on their device.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
