# iPhone apps

Four of the web apps as iPhone apps, built in the cloud and sent to TestFlight:

| App | Opens | Bundle ID |
|---|---|---|
| Trip Planner | trip.strongtechnicalconsulting.com | `com.strongtechnicalconsulting.trip` |
| Hopscotch | beer.strongtechnicalconsulting.com | `com.strongtechnicalconsulting.hopscotch` |
| Flight | challenge.strongtechnicalconsulting.com/flight/ | `com.strongtechnicalconsulting.flight` |
| Inside Joke | challenge.strongtechnicalconsulting.com/insidejoke/ | `com.strongtechnicalconsulting.insidejoke` |

## What was built (phase 1)

Each app is a native shell ([Capacitor](https://capacitorjs.com) 8) around the
live site. A web deploy shows up in the app straight away, with no new App Store build.

- **Its own icon and launch screen**, drawn from the web app's icon.
- **Links stay where they belong.** The app's own pages and the shared
  sign-in (`*.strongtechnicalconsulting.com`) open inside the app. Anything
  else opens in a Safari sheet with a Done button, and closing it puts you
  back where you were. That covers Stripe checkout, booking sites and brewery
  websites. If you have the app for a link installed (Google Maps, Uber,
  Untappd, DraftKings), that app opens instead, and Apple Maps links open
  Maps. After a Stripe checkout the page reloads, so a purchase shows at once.
- **Links open the app.** A trip, crawl or crew link tapped in Messages or
  Mail opens that page in the app, as long as the app is installed.
- **Face ID sign-in works in the app.** Passkeys you already saved in Safari
  work too, because they are tied to the domain, not to the browser.
- **Offline page.** If the site can't be reached, the app says so and
  offers "Try again" instead of showing a blank screen.
- **Ready for phase 2, not yet switched on**: notifications, the share sheet,
  haptics, the in-app browser, deep-link events, splash and status-bar
  control are installed and configured. The web apps don't call them yet.
- iPhone only, portrait, iOS 15 and later.

### What you need to know

- **The app has its own cookies.** Sign in once in each app. Being signed in
  in Safari doesn't carry over.
- **Connecting Gmail (Trip Planner) won't work in the app yet.** Google's sign-in
  opens in the Safari sheet, which doesn't share the app's cookies, so the
  last step can't find your account. Connect Gmail on the website for now.
  Phase 2 fixes this with Apple's sign-in sheet for exactly this case.
- **Hopscotch's "Near me"** asks twice the first time: once for the app's
  location permission, and once for the site.

## Your one-time steps

Do these in order. All of them happen in the browser apart from (h).

**(a) Find your Team ID.** Go to developer.apple.com/account, then
**Membership details**. It's 10 letters and digits.

**(b) Register the four bundle IDs.** In **Certificates, Identifiers &
Profiles**, open **Identifiers**, click **+**, then choose **App IDs** and **App**.
For each app:
- Description: the app's name.
- Bundle ID: **Explicit**, using the ID from the table above.
- Capabilities: tick **Associated Domains**.

The build does not register bundle IDs; it stops with a clear error if one
is missing. It does turn on Associated Domains for a bundle ID that lacks it.

**How the build signs.** Not with Xcode's automatic signing: that makes a
development profile first, which Apple refuses to a team with no registered
devices, and a TestFlight upload never needs one. Instead each build job asks
the App Store Connect API for a distribution certificate (its key made on the
runner, kept in a throwaway keychain) and an App Store profile, signs the App
target manually and archives. That certificate is revoked when the job ends,
so the upload is **not** signed with it: the keychain holding it is deleted
first and the export re-signs with Apple's cloud-managed distribution
certificate (automatic signing, which the Admin key allows and which needs no
device for an App Store profile). A build left signed with the revoked
certificate fails at review as ITMS-90035 "Invalid Signature", which is what
happened to Flight and Football on 2026-10-03. Apps build one at a time because Apple caps how many
distribution certificates a team holds at once; if a cancelled run ever
leaves one behind and the next run reports the limit, revoke the stray one
under **Certificates** at developer.apple.com.

**Football (added 2026-10-03, after the first four).** The same (b) and (c)
for one more app: bundle ID `com.strongtechnicalconsulting.football` with
Associated Domains, and its App Store Connect record (any name, e.g.
"College Football Board", since the store name must be unique; the home
screen says "Football"). Its age rating needs the gambling references
answered: it shows picks and links to DraftKings, though it takes no bets.

**(c) Create the four apps in App Store Connect.** Apple offers no API for
this step. In appstoreconnect.apple.com, go to **Apps**, click **+**, then
**New App**:
- Platform: iOS.
- Name: the app's name. Store names must be unique across the whole App
  Store, so "Flight" and "Hopscotch" may be taken. If they are, use a longer
  store name such as "Flight: Beer Tasting Games". The name under the icon
  on the phone stays short either way.
- Primary language: English (U.S.).
- Bundle ID: pick it from the list.
- SKU: anything unique, for example `stc-trip`.
- User Access: Full Access.

**(d) Create an App Store Connect API key.** Go to **Users and Access**, then
**Integrations**, **App Store Connect API**, **Team Keys**. If this is your
first key you'll need to click "Request Access" once. Generate a key named
"GitHub Actions":
- **Access: Admin.** App Manager is enough to upload. However, the build
  signs with Apple's cloud-managed distribution certificate, and API keys
  below Admin are commonly refused that ("Cloud signing permission error").
  The key only lives in GitHub's encrypted secrets. If you'd rather start
  with App Manager, do that, and switch to Admin only if the upload step
  fails with that error.
- **Download the .p8 file.** Apple only lets you download it once. Note the
  **Key ID** next to the key, and the **Issuer ID** above the list.

**(e) Add four secrets to GitHub.** In `eRock35/eriks-projects`, go to
**Settings**, then **Secrets and variables**, **Actions**, **New repository secret**:

| Secret | Value |
|---|---|
| `APPSTORE_KEY_ID` | the Key ID |
| `APPSTORE_ISSUER_ID` | the Issuer ID |
| `APPSTORE_KEY_P8` | the .p8 file: open it as text and paste all of it, BEGIN and END lines included (base64 of the file also works: on a Mac, `base64 -i AuthKey_XXXX.p8 \| pbcopy`) |
| `APPLE_TEAM_ID` | the Team ID from (a) |

**(f) Tell Claude your Team ID.** It gets set as `APPLE_TEAM_ID` on four
Cloud Run services: `trip-planner`, `hopscotch`, `challenge` and
`landing-page`. That switches on each site's
`/.well-known/apple-app-site-association`, which is what makes links open
the apps and Face ID work in them. A Team ID isn't secret (every app you
sign carries it), but it stays out of this public repo anyway. **Do this
before installing the apps.** iPhones read that file when the app is
installed, and Apple caches it for up to a day.

**(g) Run the build.** Go to **Actions**, open **iPhone apps to TestFlight**,
click **Run workflow**, and choose `all` or one app. Each app takes about
15 to 25 minutes, and they build side by side. Apple then needs another
5 to 30 minutes to process the build before it appears in TestFlight. Each run may
add an "Apple Development" certificate to your account (the cloud machine
starts fresh every time), and Apple may email you about it. That's
expected. Revoke old ones now and then if the list grows.

**(h) Install them.** In App Store Connect, open each app, go to
**TestFlight**, then **Internal Testing**, and add a group with yourself in it.
Internal testers need no review. Install **TestFlight** from the App Store
on your iPhone, then open the invite. To bring in friends who aren't on your
team, use an External group, which needs a light one-time Beta App Review.

## Letting anyone install them: TestFlight public links

One link per app that anyone can tap on an iPhone to join the beta: no
invites, no adding people by hand, up to 10,000 testers an app.

- **Automatic:** the "TestFlight public links" workflow runs after every
  green build (and from the Actions tab by hand). It writes each app's beta
  description and privacy policy (`mobile/testflight.json`), makes a
  **Public** tester group with its public link, adds the newest build with
  "What to Test", and sends it to Apple's Beta App Review (usually under a
  day). Its log ends with the four links.
- **Your part, once per app:** App Store Connect > the app > **TestFlight >
  Test Information**: the feedback email and the reviewer's first name, last
  name, phone and email. They are typed there, not in this repo, because the
  repo is public. Then run the workflow again (or wait for the next build).
  For Hopscotch and Flight, set the age rating (App Information > Age
  Rating) to cover alcohol references.
- **The buttons:** a "Get the iPhone app" bar shows on iPhones on each app's
  site, and an "On your iPhone" list on the landing page, once each service
  has its link (`TESTFLIGHT_URL...`, see CLAUDE.md). Those are set after
  Apple approves, so no button ever opens a beta that is not taking testers.
- **Builds expire after 90 days.** The build workflow runs on the 1st of
  every month, so the public links always have a live build behind them.

## Making changes

- **Content and features** ship with the web app as they always have.
- **The app itself** (name, icon, links, permissions): edit
  `scripts/generate.mjs` or `template/ios/*.swift`, then run
  `npm install && npm run generate && npm run check` here and commit the
  output. The Xcode projects under `<app>/ios/` are generated, but they are
  committed so the build only has to sync them.
- **A new version number**: `version` in `<app>/package.json` (then
  `npm run generate`). The build number is the workflow's run number.
- Nothing here runs on Linux beyond generating and checking. Compiling and
  signing happen on GitHub's macOS machines.

## Phase 2: what makes them real apps

- **Daily reminders** with local notifications: Inside Joke's daily round,
  a Same-Can Challenge closing, a trip starting. None of these need a server.
- **The share sheet** for recap cards, invite links and passport cards,
  plus **haptics** on check-ins, votes and reveals.
- **Push notifications** for a price drop on a watch, or a crew starting a
  tasting. This needs a push key and a sender.
- **A home-screen widget**: the trip countdown, your Inside Joke streak.
- **Gmail connect** through Apple's sign-in sheet (ASWebAuthenticationSession).

## App Store review (before going public, not for TestFlight)

Internal TestFlight needs no review. A public App Store listing does:

- **Guideline 4.2, minimum functionality.** Apple rejects an app that is
  only a website in a frame. Phase 2 is what earns approval: notifications,
  widgets and the share sheet are the native value reviewers look for.
- **Guideline 3.1.1, in-app purchase.** Credit and membership are digital,
  and Apple normally requires its own In-App Purchase for those. In the US
  storefront, apps may now link out to the web to buy. Elsewhere, the
  simplest answer is to hide the buy buttons inside the app. Pages can tell
  they're in the app from `window.Capacitor` or the `StrongTechApp/` user-agent tag.
- **Guideline 5.1.1, account deletion.** An app that lets people create an
  account must let them delete it in the app. The shared account already
  can (on the account page), but Hopscotch's own accounts have no delete yet.
