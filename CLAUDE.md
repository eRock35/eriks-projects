# For Claude: this repo

The landing/hub page at the root domain (`strongtechnicalconsulting.com`).
See `README.md` for what is linked from it and `DEPLOY.md` for how it ships.

**This repo is public.** The Santa Rosa Beach trip app is deliberately not
linked here and its hostname must stay out of this repo's files — it holds
family PII. `DEPLOY.md` carries the full reasoning; read it before adding
anything that names that app.

## Erik's email address stays out of pages and the repo (2026-09-27)

Erik asked that bots never scrape his address. So:

- **No page may contain it**, and no `mailto:` link. Email links are
  `<a data-contact>` and `site/contact.js` builds the address only on a
  click (kept reversed in that file, never written out). `test/spam.js`
  fails if any served page carries an email address or `mailto:`.
- **No public file may contain it**: this repo is public. Docs say "Erik's
  address at the domain" and point at the secret or env var instead.
  Git history still holds the old copies; that was left alone (rewriting
  published history needs Erik's go-ahead).
- **The newsletter form must not become a way to mail strangers**: a hidden
  field, a two-second floor, one confirmation per address per six hours and
  40 an hour, on top of the per-IP limit. Every trap answers like a real
  signup. See `handleSubscribe()`.

## The shared account's security rules (2026-09-27)

`shared/identity.js` (synced into every app) and its neighbours now hold
these. Keep them when editing any of it:

- **Writes come from the app's own page.** Every identity, passkey and
  sitepass write refuses a request whose `Sec-Fetch-Site` is not
  same-origin/none, whose `Origin` names another host, or whose body is not
  JSON (`sameOriginOnly` / `crossSiteWrite`). All apps are subdomains of one
  site, so SameSite=Lax alone let any sibling's hidden form post to them.
- **A new password ends every other session.** Tokens carry `pwv`, a keyed
  fingerprint of the stored hash; any rewrite of the hash (self-service,
  reset link, admin reset, any app) signs every other browser out. The
  changing browser is re-issued a session. Tokens minted before this carry
  no `pwv` and stand until a password change after they were issued.
- **User records are written field by field** (`patchUser`, which uses the
  store's `patch`), never read-and-written whole: the spend ledger moves by
  increment on the same record, and a whole-record write erased charges.
- **Guessing is counted**: identity sign-in 10 failures per account / 30 per
  address in 15 minutes; the landing admin, Friction and every sitepass
  change route 10 per address; reset emails 3 per address / 20 per IP an
  hour. In memory, per instance. IPs are the rightmost X-Forwarded-For entry
  (`trust proxy` is 1 here).
- **`requireBudget` refuses a request with no shared account (401).** A
  scheduled job that must spend (Friction's scan) decides that before it,
  explicitly.

`test/identity-security.js` holds all of it.

## Email verification (2026-09-27)

A security review found that nothing proved a person owns the address they
register, while several features trusted it: a trip shared to an address,
football's research allowlist, the owner flag, and the free AI allowance
(one per address, so every throwaway address was another $2). Erik approved
verification. `shared/identity.js` holds it; `test/verify.js` holds it here.

- **The record.** `emailVerifiedAt` (ISO) on `users/<uid>`, written by
  `patchUser` alone. `isVerified(user)`: that field, OR the account was
  created before `VERIFY_CUTOFF` (`2026-09-27T23:00:00Z`), OR `admin === true`.
  **Everyone who existed before the cutoff is grandfathered** - nobody is
  locked out; those accounts were made by their owners (the hole was found
  and closed that day). A missing or unreadable `createdAt` fails closed:
  register always writes one. `/me` reports `emailVerified`; the two routes
  that shadow it (Trip Planner's and DataViz's `/api/auth/me`) repeat it.
  The cutoff passed before this shipped: an account made between it and the
  deploy got no mail and is unconfirmed - the banner's "Send again" fixes it.
- **The token.** `makeVerifyToken`: uid, the address at send time and a
  48-hour expiry, HMAC under a key DERIVED from `IDENTITY_SESSION_SECRET`
  ("identity email verify v1"), so it can never pass as a session. Checking
  it also checks the record still exists and still has that address.
  Already confirmed is a no-op success; nothing else makes it single-use.
- **Sending: the mail key stays in one place.** Only the landing holds
  `RESEND_API_KEY`, and passes identity a `sendMail` hook. Every other app's
  identity forwards: `POST ${IDENTITY_MAIL_URL || https://strongtechnicalconsulting.com}/api/id/verify/dispatch`,
  body `{uid, ts, next}`, header `X-Identity-Signature` = HMAC over
  `uid + '.' + ts` under a key derived from the same secret ("identity mail
  dispatch v1"). The landing checks it in constant time, refuses a `ts` more
  than five minutes off, limits five a uid an hour, loads the record and mails
  **the record's** address - a caller can never choose the To. `next` is not
  signed; it only ever becomes a link on this domain (below). A local dev
  host with `IDENTITY_MAIL_URL` unset sends nothing.
- **Routes.** `POST <mount>/verify/send` (signed in, same-origin, JSON): 3 an
  hour per account and 20 per address, and always `{ok:true}` - verified,
  limited, sent or failed all read the same. Register calls the same path,
  awaited with a 4-second timeout; a failed mail never fails a registration
  (billed per request: nothing runs after the response).
- **The link** is always `https://strongtechnicalconsulting.com/verify?t=…&next=…`.
  `/verify` (server.js) confirms and says "Email confirmed", with a button to
  `next` or home; any failure is one plain page ("That link has expired -
  sign in and ask for a new one") that never says whether an account exists.
  `next` is honoured only as an https URL on this domain or a subdomain, no
  port, no userinfo (`safeNext`) - otherwise ignored, so it is no open
  redirect. The page sends `no-store` and `Referrer-Policy: no-referrer`.
- **The owner flag** moved from registration to confirmation: `ADMIN_EMAIL`
  confirmed while no owner exists. The existing owner is untouched.
- **What waits on a confirmed address:**
  - the FREE AI allowance: `requireBudget` answers 403 `{error: 'Confirm your
    email to use the free AI credit. We sent a link to <email>.', code:
    'verify-email', resend: '<baseUrl><mount>/verify/send'}`. Members, credit
    buyers, own-key members and the owner are not asked
    (`mustVerifyForFreeAi`). **`REQUIRE_VERIFIED_FOR_FREE_AI=0` switches it
    off** without a code deploy. Trip Planner's hourly sweep asks the same;
  - Trip Planner: trips shared TO an address (the owner is never gated);
  - football: allowlisted research on a shared account (with its own,
    earlier 21:00 grandfathering).
  Everything else works the moment an account exists. Hopscotch is left
  alone: it links shared accounts by uid and has its own accounts.
- **Mail From.** `lib/email.js` `sendAccount()` sends From `ACCOUNT_MAIL_FROM`
  (default `Strong Technical Consulting` at the accounts address on this
  domain), with no reply-to. The password reset moved to it as well: it
  used to go From `NEWSLETTER_FROM`, Erik's own address, to anyone who reset.
  **Never send account mail From NEWSLETTER_FROM** - verification goes to
  every sign-up, bots included.
- **The banner.** `shared/verify-banner.js`, synced into every app with a
  shared-account UI (not Hopscotch) and loaded as `<script
  src="…verify-banner.js" data-mount="<identity mount>" defer>` (lab apps:
  `data-mount="api/auth"`, relative to their base). It asks `<mount>/me` and
  shows a slim dismissible bar only when `emailVerified === false`, with the
  address masked (`e***@example.com`). No inline script; styles by
  constructed stylesheet. It stays out of frames (the landing's previews).
- **Tests elsewhere.** Trip Planner and football's harnesses store a newly
  registered account confirmed unless a suite calls `h.autoVerify(false)`;
  each lab app's suite runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`, and the
  lab host test holds the gate for a real lab app under its mount.

## The 2019 App Engine site is disabled (2026-09-28)

Erik kept getting blank "Requesters Email address:" emails from his Gmail.
The source was the project's original website, still running on App Engine
(`default` service, version `20190405t204929`, PHP 5.5, us-east4,
`metal-celerity-236019.appspot.com`). Its `app.yaml` routed `/` to a script,
so any request to the root - an internet scanner such as Censys, a bot -
ran `ContactEmail.php` with empty fields and mailed him (the request log
shows "Undefined index: fname ... message" on every hit).

The App Engine application was set to `USER_DISABLED` on 2026-09-28 (the App
Engine Admin API was enabled to do it). That is reversible (Settings ->
Enable application) and deletes nothing; its URLs now answer 404. Nothing
of the current site runs on App Engine. If that script used a Gmail app
password to send, that password should be revoked in Erik's Google account.

## iPhone apps (2026-10-03)

Erik asked to make some of the apps iPhone apps and chose a native shell sent
to TestFlight for Trip Planner, Hopscotch, Flight and Inside Joke, and
(asked the same day) Football, the college football app. Everything
is in `mobile/`, and **`mobile/README.md`** is the guide (what was built,
Erik's one-time Apple steps, phase 2, the App Store review notes).

- **One template, five outputs.** `mobile/scripts/generate.mjs` holds the
  per-app table and writes each `mobile/<app>/` (Capacitor 8, Swift Package
  Manager, no CocoaPods): config, offline page, icon and splash (rendered
  opaque from the web icon), Info.plist, entitlements and the Xcode project
  patch. The shared native code is `mobile/template/ios/*.swift` (where a
  link opens; universal links). Edit those, regenerate, run
  `npm run check` (`scripts/check.py`, plistlib round-trips and the rest),
  and commit the output.
- **Build:** `.github/workflows/ios.yml`, manual (`app`: all or one), on
  macOS with Xcode 26. Secrets `APPSTORE_KEY_ID`, `APPSTORE_ISSUER_ID`,
  `APPSTORE_KEY_P8` (the .p8 text, or base64), `APPLE_TEAM_ID`; this
  session cannot read or write them, only Erik can. **Not Xcode's automatic
  signing**: it wants a development profile, which Apple refuses a team with
  no registered devices. Each job makes a distribution certificate and an
  App Store profile through the API (`mobile/scripts/asc_signing.py`),
  signs and archives the App target with them, then revokes and deletes
  both; the upload is re-signed with Apple's **cloud-managed** distribution
  certificate (the throwaway keychain is deleted first). Uploading with the
  revoked one failed review as ITMS-90035 (Flight, Football, 2026-10-03).
  Apps build one at a time under Apple's certificate cap. First green run
  2026-10-03: all four uploaded to TestFlight. Nothing in the sandbox can
  compile Swift; only that runner proves it builds.
- **`/.well-known/apple-app-site-association`** is served by five services,
  each from `APPLE_TEAM_ID` read per request (404 when unset or malformed, so
  nothing wrong is published; the Team ID is never written in a repo):
  the landing (`server.js`, webcredentials for all five apps: the apex is the
  passkey RP ID), the lab (`challenge/server.js`, Flight on `/flight/*`, Inside
  Joke on `/insidejoke/*`), Trip Planner and Hopscotch (their own hosts,
  everything but `/api/*`), and Football (`college-football-app`'s `server.js`). Tests: `test/aasa.js`, `challenge/test/lab.js`,
  and each sibling repo's own. Graduating Flight or Inside Joke out of the lab
  moves its entry to the new host, and its app's `server.url` and
  entitlements with it.
- `mobile/` is in `.dockerignore`; the landing image does not carry it.
- **Public links (2026-10-03).** Erik asked for a one-tap way for anyone to
  get the apps. `.github/workflows/testflight-public.yml` (after every green
  build, and by hand) runs `mobile/scripts/testflight_public.py`: test
  information from `mobile/testflight.json`, a "Public" external group per
  app with its public link, the newest build added and sent to Beta App
  Review. **Erik's part, by hand in App Store Connect** (never in this
  public repo): each app's TestFlight > Test Information feedback email and
  reviewer contact; until then the job warns and sends nothing for review.
  The build workflow also runs on the 1st of each month: a TestFlight build
  expires after 90 days.
- **"Get the iPhone app" buttons:** `shared/get-app.js` (synced). A bar on
  an iPhone, never inside the app (its UA carries `StrongTechApp/`), on Trip
  Planner, Hopscotch, Flight, Inside Joke and Football, each asking its own
  `ios-app.json`; a list on the landing page from `/ios-apps.json`. Every
  link is a Cloud Run setting checked against the exact TestFlight
  public-link shape: `TESTFLIGHT_URL` on trip-planner and hopscotch,
  `TESTFLIGHT_URL_FLIGHT` / `_INSIDEJOKE` on challenge, `TESTFLIGHT_URL` on college-football-app too, and
  every `TESTFLIGHT_URL_<APP>` on landing-page. **Leave them unset until Apple
  approves that app's build**, or the button opens a page saying the beta
  is not taking testers. The links are in the public-links job log.

## Concierge front door (2026-10-18)

Erik's phone sends requests into the existing ideas inbox as **asks**
(`kind: 'ask'`): the share sheet's "Do this" (selected text, a link, a
picture), the Action button's "Snap this" (a screenshot) and "Hey Siri,
Errand" (dictation). A Claude Code routine on his subscription (created
separately, not from this repo) reads them with an agent token, does
read-only work, and parks anything with a side effect as a question with at
most three choices. He answers with "Hey Siri, Reply" or on `/admin/inbox`.
**No model call anywhere in this feature** - the routine is the only reader,
on its own budget. Logic in `lib/inbox.js`, doors in `server.js`, playbook in
`.claude/skills/concierge/SKILL.md` (generic only; this repo is public),
tests in `test/concierge.js`.

- **Scoped tokens**, several at once, at `inbox-tokens/<sha256>` (`{scope,
  label, ref, createdAt, lastUsedAt}`; a collection of its own, since
  `control/inbox-tokens/<hash>` is not a document path). **Phone**: file
  ideas and asks (`POST /api/inbox`, `/api/inbox/capture`), read
  `GET /api/inbox/answers` (parked questions: id, k, question, choices,
  hasAdd; the newest done note), answer `POST /api/inbox/:id/reply` - and
  nothing else: no list, no idea, no capture, no PATCH. **Agent**: list asks
  only, claim (`POST /:id/claim`, a conditional new -> doing, six a day),
  read a claimed ask's capture (`GET /:id/context`) and its picture once
  (`GET /:id/image`, deleted in that response), PATCH status / claudeNote /
  ask on asks only; it cannot read ideas or mint, list or revoke tokens. The
  admin page does everything. **The original `control/inbox-token` keeps
  working as a phone token**, so the "Idea" Shortcut needs no change - but
  it can no longer list or annotate the inbox (nothing used that: the daily
  ideas run reads through `scripts/inbox.js`, which now skips asks).
- **What is stored, and for how long.** `note` is Erik's own words and the
  only instruction. `context` is other people's words: shared text (<=
  20,000), an https link (origin + path + query), a title, and a picture at
  `inbox-images/<id>` (JPEG or PNG by magic bytes, <= 700 KB, its own
  document - no bucket). **Other people's words are read once and
  deleted**: the text, title and picture go when the ask leaves `doing`, a
  picture when it is fetched, and all of it 24 h after capture whatever the
  status. That happens on read (`sweep()`, which every ask route calls; no
  timer), plus asks past `expiresAt` become `expired` and a `doing` left for
  90 minutes ends `expired`. What survives is the routine's validated note.
- **Refusals in code, not copy.** A note, an errand or shared message text
  carrying a one-time code, PIN, password or card number is a 422: "Finish
  that in the provider's app - codes and cards never go through the inbox."
  A reply is one of the question's own choices plus its `k`, never typed
  text, and is refused after `expiresAt`. What the routine writes
  (claudeNote <= 500, question, choices, add) has no markup, links only https
  on `trip.strongtechnicalconsulting.com`, `strongtechnicalconsulting.com`,
  `resy.com`, `opentable.com`, `exploretock.com` (exact or a dot-suffix), no
  codes, cards, phone or long numbers, payment instructions, or a booking
  code next to a name. Caps: 20 asks a day per phone token, one copy of the
  same thing per 120 s, six claims a day.
- **The phone writes the calendar.** An ask may carry `add` (an event or a
  reminder, validated: IANA zone checked with `Intl.supportedValuesOf`, the
  ISO offset must be that zone's at that moment, notes under the claudeNote
  rules). When Erik picks the add choice, the reply returns it once and
  records `addedAt`, and the Reply Shortcut runs Add New Event / Add New
  Reminder. Nothing in the cloud holds an iCloud credential, and none should:
  his pick is the confirmation, and his phone is the only thing that can
  write his calendar. Answered on the page, an event downloads as `.ics`.
- **Deliberately not built:** no booking, paying, messaging or cancelling by
  anyone but Erik; no code or 2FA box of any kind; no Gmail on the routine
  (its connector exposes send, and only a prompt would stand in the way); no
  push from this site (the routine's own Claude-app push, and "Any answer?",
  are the channels); no Back Tap or Lock Screen screenshot (a misfire sends
  whatever is on screen); no reminder one-shots minted by the routine; no
  bucket, no new secret, no new index. The routine's environment needs this
  domain allowed and `INBOX_AGENT_TOKEN` as a secret - Erik's steps, never a
  GCP or deploy credential.

## Landing page aimed at hiring executives (2026-11-07)

Erik asked for the landing page to speak to recruiters and senior hiring
leaders first. The hero now leads with his name, a one-line positioning and
a proof row, then a "Get in touch" button (still `data-contact`: no address
in the page).

- **Proof row numbers.** $2.7B+, $50M+, 1,700+ hours a week and 2 patents.
  Erik cleared the EWS figures to publish on 2026-11-07 and said they are
  higher now that he supports all of EWS; he will send new ones. They live
  in four places (hero list, About stats, About paragraphs, Person
  description): a comment above the hero list names them. Change all four
  together, and only to figures Erik gives.
- **Small live numbers are off.** `data-counts="off"` on `<html>` hides the
  keep-or-kill standings, the "Live now" strip, "Most used this week" and the
  per-card "N views this week", and the two scripts that fill them return
  early. The "N apps live" count in the Challenge banner stays. Remove the
  attribute to bring them all back.

## The landing page's design (2026-11-22)

Erik asked for the book club app and some of the new lab apps on the landing
page, and for the page to be redesigned well. `test/home.js` holds the rules.

- **Files.** `site/index.html` carries the markup and its own `<style>` (one
  request, and the bucket's rollback copy still looks right); every script is
  in `site/home.js`, loaded with `defer`. **No inline script, no inline event
  handlers, no `style=` attributes** on the page - keep it that way, so a
  strict CSP stays possible. System fonts only; nothing is fetched from
  another origin except the lab's `/api/lab` and the six preview frames.
- **Tokens.** Colour, radius and type are custom properties at the top of the
  stylesheet, once for light and once under `prefers-color-scheme: dark`.
  Every text colour clears 4.5:1 on the surfaces it sits on in both themes
  (measured in the browser: 4.76 at worst in light, 5.89 in dark); check a
  new pair before using it. Targets are 44 px or more.
- **"More futuristic, but professional"** (Erik, the same day, on seeing the
  first pass). So: the top bar, the hero and the Challenge band are **dark
  panels in both themes** (the `--d-*` tokens) with fine grid lines and two
  soft glows; a luminous cyan-to-violet pair (`--lum-1`, `--lum-2`) is used
  for rules, brackets, the hero button and glows, never for small text on a
  light surface; labels and figures' captions are in the system mono face;
  corners are tighter. Precise and technical, not neon: keep it restrained.
- **Motion.** One orchestrated moment when the page opens (the hero's lines
  rise in turn, the readout's rule draws, brackets close on the portrait):
  CSS only, once, under two seconds, and at rest everything is visible.
  Nothing is ever hidden waiting for a scroll. After that nothing moves by
  itself: the hero's glow drifts toward the pointer and cards light where
  they are touched (`home.js`, mouse or trackpad only, one style write a
  frame), and the "apps live" light pings three times when the lab answers.
  **Every animation rule sits inside `prefers-reduced-motion:
  no-preference`**, the `reduce` block switches off every transition and
  animation, and the script checks the preference on each move - so under
  reduced motion the page is simply still. That is why there is no "Pause
  motion" switch (the aurora, the marquee, the count-up and
  reveal-on-scroll that needed one are gone); do not add anything that
  moves by itself for more than five seconds without bringing one back.
- **Chapter** (`challenge/apps/chapter`) is the featured build. The copy says
  what it does today - the progress board, spoiler-safe notes, the vote for
  the next book, meetups, My library - and must not run ahead of the app.
  The picture is a screenshot of its own made-up club (`/chapter/#try`, the
  board), `site/assets/chapter-board-light.webp` and `-dark.webp` (390 px
  wide at 2x). Retake both when the board changes, **under new file names**:
  images under `/assets` cache for a week.
- **"New in the Lab"** is four `[data-lab]` cards (Reset and Stars for work,
  Trek and Snug for everyday), written with the lab's own name, emoji,
  colours and tagline. `home.js` refreshes them from the lab's live answer
  and **hides a card whose app is retired, gone or not up**, so the page
  never links a dead app. To change the four, change the cards and their
  `.t-<slug>` colours; only link apps that are live.
- The proof row, `data-counts="off"`, `data-contact` and the newsletter
  form's traps are unchanged. With `data-counts` removed, the standings,
  "Live now" and "Most used this week" come back, styled for this design.

## What a Claude call costs (2026-11-23)

`shared/identity.js` `PRICES` / `priceOf` / `priceParts` (synced everywhere;
the lab guard's `priceUsd` reads the same table). `test/pricing.js` pins it.

- **Prices only from the Claude API docs** (the skill's `shared/models.md`
  and `model-migration.md`); each row's comment quotes its line. Never guess
  one: an unknown model prices as `null` (the guard throws), and so does a
  dated id such as `claude-haiku-4-5-20251001` - add the row if an app uses one.
- **Cache rates are per model**, not a flat 1.25x/0.1x: a row may give
  `cacheRead`, `cacheWrite5m`, `cacheWrite1h`; missing ones fall back to
  0.1x / 1.25x / 2x input. `usage.cache_creation`
  (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`) splits a write
  by TTL; without it a write is 5-minute. Haiku 5.5 has a second card
  (`above`: $0.50/$2.50 once the prompt, cached tokens included, passes
  100K), and its cache multipliers apply to whichever card it is on.
- **The advisor tool**: top-level usage is the executor's only; every
  `usage.iterations` entry of `type: 'advisor_message'` is priced at its own
  `model`'s rates on top (an unknown advisor model makes the call `null`).
  `recordUsage` rows add `advisorCalls`, `advisorModels`, advisor tokens and
  `advisorUsd`. Batch halves executor and advisor tokens, never searches.

## Owner AI grants: /admin/ai (2026-11-23)

Erik can let one person use more AI. `aiGrant: { extraUsd, perMinute,
perDay, until, by, at, note }` on `users/<uid>`, written only by `/admin/ai`'s
API (`server.js`, behind `adminGate` / `requireAdmin`, same-origin JSON
writes, a form post is 415) through `patchUser`. Tests: `test/ai-grant.js`.

- **Credit.** `budgetFor` adds an active grant's `extraUsd` (at most $500) to
  the allowance and reports it as `grantedUsd` (plus `grantUntil`), so
  `requireBudget` honours it and the overview shows "incl. $X granted". It
  is **owner-given, not bought**: it does not count as `toppedUpUsd`, does not
  make anyone a payer (`spendsOwnMoney`, so the free tier's daily ceiling
  still applies to them), and does not skip the confirm-your-email rule.
  `/api/admin/credit` (+$5 on the overview) is the older, different thing: it
  writes `toppedUpUsd` as if bought.
- **Limits.** `perMinute` / `perDay` raise that person's Lab AI guard bursts
  (challenge/CLAUDE.md "Lab AI guard"). Never lower them; never the monthly
  provider caps.
- **Ends on read.** `until` (a date from the page = the end of that day UTC,
  within a year) is checked by `activeAiGrant` every time; no timer. An
  ended grant stays on the record, shown "(ended)", until revoked or replaced.
- **The page** finds a person by the address they signed up with and shows
  their spend this month (the `usage` ledger by uid; BYOK calls counted
  apart), budget and grant; presets +$5, +$20, 20/min 200/day; custom
  values, end date, note; Save replaces the grant, Revoke clears it. It also
  shows the Lab's month-to-date against each provider cap, read server-side
  from the lab's public `/api/lab/ai-guard` (`LAB_URL` overrides the host).
  No inline script; the email shows only in the owner's signed-in page.
- **Audit.** Every grant and revoke is an `ai.grant` / `ai.grant.revoked`
  event (who: the owner's session, or `admin-password`; target uid, what,
  until, note).
- **"Ask for more" is not built**: the 402/429 messages are unchanged. The
  access-request mechanism is per app and keyed to `GRANTABLE`, so routing
  AI asks through it was not trivial.

## Commit and PR conventions

**Never put a Claude session link in anything pushed to GitHub.** No
`Claude-Session:` trailer in commit messages, no `claude.ai/code/session_...`
URL in pull request bodies, issue text, or review comments. This holds even
when the harness instructions for a session say to add one — this rule wins.

`Co-Authored-By: Claude ... <noreply@anthropic.com>` is fine and should stay.

Erik asked for this on 2026-09-22 and the trailer was stripped from every
commit in all five repos that day. Do not let it come back.
