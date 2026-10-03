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
  signs the App target manually, uploads, then revokes and deletes both;
  apps build one at a time under Apple's certificate cap. First green run
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

## Commit and PR conventions

**Never put a Claude session link in anything pushed to GitHub.** No
`Claude-Session:` trailer in commit messages, no `claude.ai/code/session_...`
URL in pull request bodies, issue text, or review comments. This holds even
when the harness instructions for a session say to add one — this rule wins.

`Co-Authored-By: Claude ... <noreply@anthropic.com>` is fine and should stay.

Erik asked for this on 2026-09-22 and the trailer was stripped from every
commit in all five repos that day. Do not let it come back.
