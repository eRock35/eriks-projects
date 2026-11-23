# For Claude: As Filed

Drop #70 in the Challenge Lab, 2026-11-23. **Built on Erik's own ask** ("an
app that reads public company filings and shows what you can learn from
them"), so it took the next drop slot whatever the business/everyday
alternation said. The next daily run still takes the opposite of the newest
drop in `lab.js` as usual; treat this one as a business drop.

What it is: nineteen big technology companies (equipment -> chips -> devices
-> cloud) read from their own annual reports. Three views: each company's
reported figures over about twelve fiscal years; patterns across companies;
and a map of relationships a primary document actually states.

## The one rule: nothing is shown that a source does not say

- **A figure** is a number a company tagged in a filing. It carries its XBRL
  tag, period end, accession number and filing, and the page links it to the
  filing index on sec.gov.
- **A relationship (an edge)** exists only if a document written by one of the
  two companies names the other, and the app stores the exact words.
  `tools/verify.js` enforces it at build time: the quote must be in the
  cached source **word for word** (whitespace is the only freedom: not case,
  not punctuation), the quote itself must name the other company, the source
  must be the speaker's own document, and a lead-in (for a bulleted list
  under "Our current competitors include:") must be verbatim too. **An edge
  that fails is dropped and never reaches `public/data/dataset.json`.**
  "We rely on third-party foundries" is not an edge: no counterparty.
- **A commonly assumed link that no source states is not on the map.** Do
  not add one from general knowledge. `tools/curated-edges.json` keeps one
  deliberate fake (the `tripwire`: a plausible NVIDIA -> Microsoft supplier
  sentence that is in no filing); every build must drop it and the tests
  fail if it reaches the dataset.
- **An insight sentence** is written by a template in
  `public/asfiled-core.js` from figures, with the figures it rests on. The
  tests rebuild every sentence from the committed figures and compare word
  for word, so a number in a sentence cannot drift from its figure. No
  forecasts, no advice (a word list is tested). The page says "From public
  filings. Not investment advice."
- Tamper checks without the cache: each edge has `proof` =
  sha256(source text hash + quote); the dataset has one `integrity` hash
  over everything shown as fact. With the cache present, the suite re-reads
  every quote and every figure against the cached sources.

## Data sources (all public, all primary)

- **SEC EDGAR XBRL company facts** (`data.sec.gov/api/xbrl/companyfacts`):
  the annual numbers. One number per fiscal year per metric: the value from
  the **earliest** 10-K / 20-F that reported that period.
- **Each company's latest annual report** (10-K; 20-F for TSMC and ASML):
  its text for quotes, and its XBRL instance for revenue mix (segment,
  geography, product - shown only when the tagged parts add up to reported
  revenue within 0.5%), customer concentration, and any latest-year number
  company facts does not have yet (TSMC's newest 20-F was not in company
  facts; its figures come from the report's own instance, same accession).
- **A report's XBRL labels**: Intel names its three largest customers only
  in its tagged data (the page shows a chart image). Those three edges quote
  the label ("Dell Inc. [Member]") and cite the tagged percentage.
- **Apple's Supplier List** (the PDF on apple.com; the copy there is the
  fiscal-year-2022 list, PDF dated 2023-05-17): the only source for who
  supplies Apple, whose 10-K names no supplier. `tools/pdftext.js` is a
  small dependency-free PDF text reader written for it.
- Currency: TSMC reports in NT dollars and ASML in euros and the charts keep
  them. Nothing is converted. Sums across companies use US-dollar figures
  only: TSMC's own tagged dollar translation; ASML is left out of the
  equipment sum. Map circle sizes use ASML's euro figure unconverted (said
  on the page).

## The pipeline (tools/), and how to refresh

Raw downloads live **outside the repo** in `~/.cache/filings`
(`FILINGS_CACHE` to move it). Only the derived dataset is committed: numbers
with accession numbers and short quotes (620 characters at most) with their
locations. Never commit a filing.

```
set -a; . ~/.config/lab-secrets/filings.env; set +a   # SEC_USER_AGENT
npm run data:fetch      # facts, submissions, latest annual report, Apple's list
npm run data:extract    # text per source; candidate sentences -> cache/candidates.json
# read the candidates; edit tools/curated-edges.json (quote = exact substring)
npm run data:build      # figures + verified edges + insights -> public/data/dataset.json
npm run data:verify     # re-check the committed dataset against the cache
npm test
```

- `tools/companies.js` is the set and the names the extractor looks for.
  Adding a company: add it there, fetch, extract, curate, build.
- After a new annual report: delete that company's files under the cache
  (`facts/`, `subs/`, `docs/<ID>/`) and re-run; the old quotes will be
  dropped if the new report words them differently - re-curate from the new
  candidates rather than loosening the verifier.
- `tools/build-report.json` (committed) says what the last build kept and
  dropped, and why.
- Intel's and ASML's reports do not use the standard "Item 1A." headings, so
  their curated entries name the section; the verifier requires that heading
  to appear before the quote.

## The SEC_USER_AGENT rule

sec.gov requires a declared User-Agent, and that identity holds Erik's
contact address. **It lives only in the environment** (`SEC_USER_AGENT`,
from `~/.config/lab-secrets/filings.env`). `tools/sec.js` is the only file
that reads it, never logs it, and exits if it is missing. It must never be
written into any file here, any committed log or any report. The suite
scans every file in the app for any email address (only `@example.com` test
addresses pass) and, when the variable is set, for the value itself. The
tools stay under four requests a second. Apple's PDF is fetched with a
generic client name.

## At run time

Static. `server.js` serves the page and the dataset, mounts the shared
account at `/api/auth` (so the verify banner works; nothing needs a
sign-in), and stores nothing. **No model call, no outbound request**; the
page fetches only its own `data/dataset.json` (CSP `connect-src 'self'`),
and links open sec.gov / apple.com in a new tab (with a text fragment that
jumps to the quote where the browser supports it). `ASFILED_MEMORY` and
`ASFILED_FAKE_AI` exist because the lab host sets them; both throw on
Cloud Run; nothing calls a model. The all-apps redesign brief's "AI feature"
was deliberately not built here: the approved plan for this app is no
runtime AI, because every claim must trace to a source.

## The page

`public/app.js` (routes `#/`, `#/c/<ID>`, `#/patterns`, `#/map[/<ID>]`),
`public/asfiled-core.js` (pure: lookups, ratios, formatting, the insight
templates; shared with the tools and tests), `public/app.css`.

- Built with createElement/textContent only; no inline script, handlers or
  style attributes (sizes are SVG attributes, state is classes).
- **Charts** are hand-drawn SVG at the container's real width (redrawn on
  resize). Company charts are one series in the accent; every year is a
  focusable button that shows the value and opens its source; every chart
  has a table view. Categorical colour is used for three things only (blue,
  orange, aqua - validated for colour-vision separation on both surfaces
  with the dataviz validator): the three capex series and the three edge
  families, which also differ by dash pattern. The inventory heat table is
  one blue ramp, shaded within each company's own range, numbers in every
  cell.
- **The map**: layered columns on a wide screen, bands top to bottom on a
  phone. One line per pair and family; lines and companies are keyboard
  buttons with spoken labels; tap a line for the sheet (quote, who said it,
  document, section, date, link). Filters by relationship type and layer
  (competitors start off: they are the clutter). "Follow the flow" walks
  supply edges up and down from one company and says, plainly, that a chain
  is only as long as the documents say. **List view** is the same content
  as a table.
- **Design** (HOA Desk rules): pure white / true black, hairline cards with
  12 px corners, lists over boxes, system font, one accent (the card's
  violet), a floating pill bar on phones and an underlined top nav on
  desktop, centred hero, motion only under
  `prefers-reduced-motion: no-preference`. The nav is a sibling of the
  header, not a child: the header's backdrop filter would otherwise become
  the fixed bar's containing block. Measured in the browser at 390, 320 and
  1280, light and dark: minimum text contrast 5.39:1 (heat cells), nothing
  sideways. Every view is one tap from home.

## What is notably NOT on the map (because no source here states it)

- Apple's 10-K names no supplier; TSMC, Samsung, Foxconn and the rest are
  there only through Apple's own Supplier List (fiscal 2022).
- TSMC's 20-F names no customer (it tags "Customer A" and "Customer B") and
  no equipment supplier. So TSMC -> Apple/NVIDIA/AMD/Qualcomm/Broadcom rest
  on the customers' statements, and ASML -> TSMC only on ASML reporting a
  "TSMC Supplier" award.
- ASML names no customer otherwise; Applied Materials names none at all
  (so no Applied Materials -> TSMC/Samsung/Intel line); Lam names four.
- NVIDIA names no customer (Microsoft, Meta, Amazon, Alphabet and Dell are
  not drawn as NVIDIA customers); Dell names no chip supplier; Microsoft,
  Alphabet, Amazon and Meta name no chip supplier. Micron names no
  customer. Broadcom does not name its 32% customer. Alphabet's and Texas
  Instruments' 10-Ks name no company in the set at all.
- Only each company's latest annual report was read for text.

## Tests

`npm test` (`test/run.js`, no network): the dataset's figures and edges
field by field, the tripwire, insights rebuilt and compared, the verifier
on made-up sources, the cache re-read when the cache is on the machine, the
email / User-Agent scan, the server under its mount (CSP, banner, no inline
anything, one fetch, no model call), and the lab entry.
