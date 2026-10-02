# For Claude: Boxed

Every K-1 box read, checked and rolled up - in minutes, not hours. A
preparer drops in a client's **Schedule K-1 (Form 1065) PDFs** (or photos of
one), and one model call per K-1 reads every box and code **with the page it
came from and a confidence**. Free, deterministic **checks** catch keying and
reading errors (Item L doesn't reconcile, Item L income vs the boxes, box 19
vs withdrawals, Item J, 4c = 4a + 4b, 6b <= 6a, final / amended / PTP / K-3,
big swings from last year, low-confidence values, "see statement" lines). A
**review** draws the K-1 the way the printed form is laid out, every value
editable, the checks re-running as you type, and "Mark checked". The client
file has a **status board** (Received -> Read -> Checked -> Exported, with an
honest time-saved figure), a **roll-up** of every box and code across the
client with drill-down, **CSV exports** and a printable summary, and **What's
missing**: the K-1s still expected, March 15 by default, an .ics reminder for
each and a chase list to paste into an email. K-1s can be **typed in** for
free, with no account. Signed in, client files are **saved** (and duplicated
to next year).

Built 2026-10-02 as the seventeenth of Erik's lab drops - a **business** day
in the alternation (Drip, the newest before it, was everyday). **Staging
only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/boxed`,
served at `challenge.strongtechnicalconsulting.com/boxed/`, data in `boxed_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

Inspired by the Friction problem titled **"Accountants hand-key 10-100+
Schedule K-1s per return, hours each"** (title only), rising that week.
Every partnership investment produces a Schedule K-1, and a client with a
fund portfolio can have dozens. Preparers read each one and key its boxes,
codes and footnotes into tax software by hand, then chase the ones that
haven't arrived. Boxed reads them, checks them, rolls them up and tracks
what's missing.

Not a repeat: **Covenant** reads loan agreements; nothing in the lab or the
portfolio touches tax documents.

**Who it is for.** CPA firms, enrolled agents and tax preparers with
partnership-heavy clients; also individual investors and family offices who
receive many K-1s.

**Who pays.** Nobody, for almost all of it: the example, the checks, the
review, typing a K-1 in, the roll-up, the CSVs, what's missing and the
reminders are `public/boxed-core.js` in the browser - no account, no model
call. One thing is metered and signed in: **reading a K-1** (Haiku for the
free tier, Sonnet for members, via `identity.planFor`), a few cents each.
Saving client files is free with an account.

**The honest risk.** A model can misread a figure or put it in the wrong
box, and the cost of that is a wrong return. So: the prompt says read what is
printed and never compute or invent; every value carries its page and a
confidence, and a low one is a "look" naming the page; the checks are the
form's own arithmetic, which catches most misreads; nothing counts as done
until a person marks it checked (and editing a checked K-1 un-checks it). The
page says once, in the footer: "Boxed reads and checks K-1s. It is not tax
advice, and you are responsible for what you file." and "Your files are read
once and not kept."

**How it becomes an iOS app.** The checks, roll-up and form are already one
UMD file; a share-sheet extension takes the K-1 PDF from Mail or Files;
VisionKit's document camera replaces the photo path; reminders go to EventKit
instead of an .ics.

## The decisions that matter

- **One rules file, run twice.** `public/boxed-core.js` is UMD
  (`window.BoxedCore` in the page, `require` in the server and tests): the
  box/code table, money, cleaning, every check, the roll-up, the board,
  missing, the .ics and the CSVs. The phone and the tests compute the same
  answer.
- **The form.** `BOXES` is Part III in the printed order, each with its
  column on the form (1-13 left, 14-23 right), a plain label and a kind:
  amount, coded (11, 13, 14, 15, 17, 18, 19, 20) or check (16 "Schedule K-3
  is attached", 22, 23). That is the real form; the brief's list of "coded"
  boxes included 16 and 21-23, which on the current form are a checkbox, an
  amount and two checkboxes. `CODES` holds the **common** codes with labels
  (13 H "Investment interest expense", 20 A "Investment income", 20 Z
  "Section 199A information", ...) - deliberately not every code: an unknown
  letter is kept and labelled "(see the partnership's statement)". Codes are
  `A`-`ZZ` (`CODE_RE`). Items J (shares), K (liabilities) and L (capital
  account) are `ITEMS`.
- **Money is integer cents, shares integer millionths of a percent.**
  `toCents` reads "48,210", "$48,210", "(1,250)", "-1,250", "1,250-" and
  "−1,250" from the digits, never as a float; words, "STMT" and blanks are no
  figure. The form shows amounts as the K-1 prints them ("(1,250)"); a CSV
  has plain numbers ("-1250.00"). K-1 shares print to six decimals, hence
  `toPct`'s scale.
- **The checks** (`checkK1`), each pass / look / fail with a sentence:
  - **Item L reconciles**, exactly in cents: beginning + contributed +
    current-year + other - |withdrawals| = ending (withdrawals print in
    parentheses, so either sign is read as a subtraction). A difference is a
    **fail** showing every figure ("Off by $1,250: ... is $286,930, but the
    ending says $288,180").
  - **Item L income vs the boxes**: boxes 1-11 (4c, or 4a + 4b without it;
    6b, 6c, 9b, 9c are parts of 6a and 9a so not counted again) less 12, 13
    and 21. A difference is only ever a **look** - "often book-tax or 704(b)
    differences; check the partnership's reconciliation".
  - **Box 19 vs Item L withdrawals** (look); **Item J** in 0-100% (fail),
    a change said in words ("Your profit, loss and capital shares went from
    2.5% to 3%"), 0% at the end only on a final K-1; **4c = 4a + 4b** and
    **6b <= 6a** (fails: the form's own arithmetic).
  - **Final, amended, PTP and box 16 (K-3)** each a loud look with what to
    expect; a coded box with no code; every "see statement" line and every
    low-confidence value, with its page.
  - **Year over year**, when last year's K-1 from the same partnership is in
    the file (matched by EIN last four, else by a folded name -
    `partnershipKey` drops case, punctuation, "The", LP/L.P./LLC):
    a box or code that moved more than 50% **and** more than $1,000, a code
    that appeared or went, and a plain box that appeared or went with over
    $1,000.
- **Reading: one K-1 per request, the page runs the batch.** Up to 10 PDFs
  are queued in the browser and sent one at a time, with a progress list
  ("Reading 2 of 3...", then each K-1's result and a Review button). One bad
  file stops nothing; a 401, 402 or 403 `verify-email` stops the rest and
  says why. Each request still **streams whitespace** (`lib/stream.js`):
  a 30-page PDF can take a minute, which drops an idle phone connection. So
  sign-in, budget, cap, the 25 MB parser and every 400 come first with real
  statuses; after that a failure is a 200 `{error}` and the page checks
  `data.error`.
- **What the read accepts** (`lib/files.js`): `{pdf: {data}}` - checked by
  its bytes (`%PDF-`), at most 10 MB, at most 30 pages (page objects
  counted, else the page tree's `/Count`), not password-protected - or
  `{photos: [...]}`, up to 6 JPEG/PNG/WebP by their bytes (the page shrinks
  each to 2000px first, so small print stays legible), 3 MB each. A PDF goes
  to the model as a `document` block (SDK 0.68 takes them), photos as
  `image` blocks. Over 25 MB is a plain 413, after the gates.
- **Model output is untrusted** (`Core.fromModel`, then `cleanK1`): known
  boxes only (anything else dropped, with a note the review shows), codes
  `A`-`ZZ` on coded boxes, every value through `toCents` (words dropped with
  a note), strings bounded and stripped of markup, control and bidi
  characters, at most 80 lines, confidence and entity type from fixed lists.
  A form other than 1065 (1120-S, 1041) is a 422 sentence.
- **TINs: the last four, only in the browser.** The prompt and the tool ask
  for the last four digits only. The server does not trust that:
  `scrubTins` masks **every** SSN- or EIN-shaped number in **every** string
  the model returns (`•••-••-1234` / `••-•••1234`), the partner's TIN
  becomes `maskTin(...)`, and the partnership's EIN is kept as `ein4`. The
  fake model deliberately returns a full SSN to prove it.
- **Never stored, anywhere: a partner's TIN, name or address.** The
  partner's name and masked TIN come back beside one reading for the
  preparer to confirm it is the right client; the page holds them in memory
  (`state.partners`) while it is open and never writes them anywhere -
  `cleanK1`/`toSaved` are a whitelist with no partner field. The review's
  Part II says "Not kept" for a saved K-1.
- **A saved client file** is one document, `clients/<uid>/items/<id>`:
  `{label, taxYear, k1s, expected, createdAt, updatedAt}`. Each K-1 is only
  `{id, taxYear, p: {name, ein4, center, ptp}, final, amended, k3, atRisk,
  passive, j, k, l, lines, at, src, stage, reviewSecs, result}` - the
  partnership's name and the last four of its EIN, the box/code values,
  Items J/K/L, where each value was read (`at`, page + confidence), the check
  result and the stage. The label is what the person types ("Client A -
  2025"): Boxed never asks for the client's name. Tested by dumping the store
  after a real read and a save whose body carries the partner, a TIN, an
  address, the PDF and a transcript. Under the owner's uid, so another
  account's id is a 404. Written whole under a per-file lock (a merge would
  keep a removed K-1). Limits: 25 files a person, 150 K-1s a file (this
  year's and last year's together), 80 lines a K-1, 150 expected
  partnerships, 900 KB a document (a 413 sentence past it). 120 writes per
  account per 10 minutes.
- **Signed out**, client files live in `localStorage` `boxed-v1` (every
  access in try/catch) in exactly the saved shape (`savedShape` ->
  `C.toSaved`). Signed in, "Save to my account" moves them over.
- **The status board.** Received (every K-1 of the year, including one
  marked "It arrived" but not yet read), Read, Checked, Exported (a CSV
  download marks the checked ones exported). **Time saved** is stated, not
  guessed: 20 minutes to key a K-1 by hand (`MINUTES_BY_HAND`), counted only
  for K-1s read for you (not typed) and checked, less the time actually
  spent reviewing each here (`reviewSecs`, counted only while the review is
  on screen and the tab visible, capped at 20 minutes). "Here 6 K-1s were
  read for you and checked in 12 minutes - about 2 hours saved."
- **What's missing.** The expected list comes from what is typed or pasted,
  "Expect last year's partnerships again", or **Next year** (duplicate),
  which carries this year's K-1s as last year's (so year over year works)
  and expects every partnership again by March 15 - except one whose K-1 was
  final. The default date is March 15 after the tax year, with a note that
  many arrive later and extensions to September 15 are common; each date is
  editable. The .ics (`Core.ics`) is RFC 5545: CRLF, 75-octet folding
  without splitting UTF-8, TEXT escaping, all-day `VALUE=DATE` with `DTEND`
  the next day, a 9am alarm, and a UID from the file, the partnership and the
  tax year - not the date - so moving a date moves the event.
- **CSV** (`k1Csv`: one row per K-1 per box/code, plus Items J/K/L rows and
  the checkbox boxes; `rollupCsv`: one row per box/code, totalled), UTF-8
  with a BOM, CRLF. **Formula guard:** a cell starting `=`, `+`, `-`, `@`,
  tab or CR gets a leading `'` - except a plain number such as `-1250.00`,
  which cannot be a formula and must stay a number for a spreadsheet to sum.
  Quoted when it holds a quote, comma or line break. No tax-software formats.
- **Failures** (`fail()`/`failure()`): only the app's own errors reach the
  page with their words; a provider error is a 502 (503 "The AI is busy")
  sentence. Nothing logged carries a figure, a name or a byte of a file:
  logs are a stack's first lines, and parse errors (whose message V8 fills
  with the body) are never logged.

## The first run

The page opens on the made-up **"Example client - tax year 2025"**
(`public/sample.js`, UMD, invented partnerships and EINs, the partner shown
as "Example Client (made up)"): 8 K-1s, 6 checked, 3 exported; Harborline
Credit Fund's Item L off by $1,250; Summit Ridge with 20 Z, 13 H and a $575
Item L vs boxes look; Bluefield a PTP; Cedar Mill with box 16 checked and a
low-confidence 11 ZZ; Old Quarry final; Tidewater's box 1 from $12,400 (last
year's K-1 is in the file) to $41,900; Lakeshore's share from 2.5% to 3%; two
partnerships still missing. On a 390px phone the first screen is the dark
strip ("This is an example client - tap a K-1 to see how it was read and
checked", a big **Start a client**, "or type one in - free"), the status
board ("8 received · 6 checked · 2 still missing · about 2 hours saved") and
**Needs you**, led by "Item L doesn't reconcile on Harborline Credit Fund LP:
off by $1,250". Then the tabs: K-1s (to do first), Roll-up, Missing.

**Start a client** asks a label, the tax year (last year by default) and
optionally the expected partnerships, then reads K-1s (signed in; signed out
it offers the free account or typing one in; 402 opens the credit sheet; 403
`verify-email` shows its sentence and "Send the link again" in the progress
card) or types one in. The review on a phone is the checks first, then the
form (empty boxes one line each, label left and amount right, as printed);
on a desktop the form and a sticky checks column side by side. Tapping a
value shows "Read from page 3 of the file · low confidence"; "Show on the
form" on a check scrolls to and focuses the figure it is about.

The lab card and the in-app mark are 🗂️, not 📦: Noto's 📦 SVG makes resvg
2.6.2 panic (`geom.rs` unwrap), so the og script cannot draw it.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8116/boxed/
npm test        # pure rules first, then end to end over HTTP under a /boxed mount
```

`BOXED_MEMORY=1` and `BOXED_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `BOXED_COLLECTION_PREFIX` (set to
`boxed_` by the lab host) prefixes every top-level collection. The fake model
refuses a call that does not force a tool. Triggers in a file's bytes:
`BLANK` (not a K-1: 422), `SCORP` (Form 1120-S: 422), `INJECT` (hostile:
unknown boxes, bad codes, markup, huge strings, values in words, 81 lines,
SSNs in names and notes), `MAXTOKENS`, `UPSTREAMnnn`; `COPPERLINE`,
`WESTBROOK`, `GRANITE` (Granite Peak, one of the example's missing K-1s) or,
for anything else, one of those three by the bytes. Every fake answer gives
a full SSN in `tinLast4`. `npm run dev` leaves the free-AI email gate on, so
a fresh local account sees the 403; add `REQUIRE_VERIFIED_FOR_FREE_AI=0` to
read.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page. Signed in, free:
`GET|POST /api/clients`, `GET|PUT|PATCH|DELETE /api/clients/:id`,
`POST /api/clients/:id/duplicate`. Metered (`requireUser, requireBudget,
requireDailyCap`, then the 25 MB parser): `POST /api/read` `{pdf: {data}}` or
`{photos: [{type, data}]}`, plus `taxYear`.

## Ideas not built yet

- **Statement footnotes**: reading the attached statements' sub-lines
  (20 Z's QBI, W-2 wages and UBIA per activity) rather than "see statement".
- **Schedule K-3** reading.
- **K-1s from Form 1120-S and 1041**: the same shape with their own boxes.
- **Basis tracking** across years from Item L and the distributions.
- **A preparer's share link** for a client to upload their own K-1s - needs
  a link and revocation story like Tipout's.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`
  (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the read's gates run before
  its 25 MB parser (tested: 401/402/403, not 413).
- Model output and typed text are untrusted: cleaned in the core, escaped on
  render (`esc()` on every string), escaped again in the .ics and the CSV.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
