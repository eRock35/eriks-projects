# For Claude: As Filed

Drop #70 in the Challenge Lab, 2026-11-23. **Built on Erik's own ask** ("an
app that reads public company filings and shows what you can learn from
them"), so it took the next drop slot whatever the business/everyday
alternation said. The next daily run still takes the opposite of the newest
drop in `lab.js` as usual; treat this one as a business drop.

What it is: 81 technology companies read from their own annual reports -
the whole S&P 500 Information Technology sector plus the five the first
version had from outside it (Amazon, Alphabet, Meta, TSMC, ASML). Seven
layers: equipment -> chips -> components -> devices -> software -> cloud
-> IT services. Three views: each company's reported figures over up to
twelve fiscal years; patterns across companies; and a map of relationships
a primary document actually states.

## The company set (expanded 2026-11-23, Erik's choice)

The first drop had nineteen. Erik chose to add the full S&P 500
Information Technology sector, with both figures and quoted relationships.

- **The list: 76 companies**, from two sources that agree exactly: the
  State Street Technology Select Sector SPDR (XLK) daily holdings file
  (ssga.com, "As of 20-Nov-2026"; XLK holds the S&P 500 IT sector) and
  Wikipedia's "List of S&P 500 companies" (GICS sector column; page last
  edited 8 November 2026), both read 2026-11-23. Fourteen were already in
  the set; the other 62: ACN ADBE ADI ADSK AKAM ANET APH CDNS CDW CIEN
  COHR CRM CRWD CTSH DDOG FFIV FICO FLEX FSLR FTNT GDDY GEN GLW HPE IBM
  INTU IT JBL KEYS KLAC LITE MCHP MPWR MRVL MSI NOW NTAP NXPI OKTA ON ORCL
  P (Everpure, formerly Pure Storage) PANW PLTR PTC Q (Qnity) ROP SMCI SNDK
  SNPS STX SWKS TDY TEL (TE Connectivity) TER TRMB TWLO TYL VRSN WDAY WDC
  ZBRA. All file 10-Ks. Ids are tickers; Tokyo Electron (not a filer) is
  `TOKYOEL` because TEL is TE Connectivity's ticker.
- **Layers** are this app's, not GICS: design software (Synopsys, Cadence)
  and materials (Qnity) sit with equipment; First Solar and Sandisk with
  chips; connectors, optics, glass, test gear and contract manufacturers in
  `components`; storage and networks in `devices`; Oracle, Akamai, GoDaddy
  and Verisign in `cloud`; Accenture, Cognizant, IBM, Gartner and CDW in
  `services`.
- **Fewer than ten years** where the registrant has fewer: Qnity 3
  (spun off 2025), Sandisk 4 (2025), CrowdStrike 9, Datadog 9, Palantir 8.
  Marvell has 12 since its two registrants were joined (below). Each
  company shows `min(12, years its company facts holds)`; the build records
  `periods` and the test holds it.
- A 52/53-week year ending in the first week of January belongs to the
  year before (`Core.fiscalYear`: Cadence's FY2015 ended 2016-01-02), and a
  year restated under a period end a few days off (Ciena's FY2018:
  2018-10-31, later 2018-11-03) is one year, from the earlier filing.

## Joined registrants: `priorCiks` (2026-11-23, Erik's ask)

A company that re-domiciles or reorganises files under a new CIK, and its
earlier years stay under the old one. `tools/companies.js` joins them only
where an entry says so: `priorCiks: [{ cik, legal, why }]`. `fetch.js`
fetches each prior CIK's company facts to `facts/<ID>.<CIK>.json`;
`build.js` reads them beside the current CIK's under the same year rule
(the earliest annual report that reported the period wins, whichever
registrant filed it); a figure filed under the old CIK has `cik` on its
filing, so it links to that filing under that CIK; the verifier re-reads it
from that CIK's facts and refuses a CIK the company does not list. The
company record carries `prior`, and its page says which years came from the
earlier registrant.

- **Marvell (MRVL)**: Marvell Technology, Inc., CIK 1835632, since the
  re-domicile from Bermuda to Delaware in April 2021 (its first 10-K was
  for FY2022, ended 2022-01-29); before that Marvell Technology Group
  Ltd., CIK 1058057. FY2015-FY2021 come from the old registrant's own
  10-Ks, FY2022-FY2026 from the new one's: 12 years (19 periods held).

## Auditors (2026-11-23, Erik's ask)

Each company's latest annual report names its independent registered
public accounting firm. That is a **service** link, type `auditor`
("Auditor": firm -> company), one per company, 81 in all, verified like
every edge. The quote is the signature on the auditor's report with its
tenure line ("/s/ Ernst & Young LLP We have served as the Company's auditor
since 2009."), or, where the text has no such line (Meta, Applied
Materials, First Solar), the report's own sentence naming its firm; IBM's
10-K carries only PwC's report on the financial statement schedule (its
statements are in the Annual Report to Stockholders), quoted under that
report's heading. The firms are "others" (one node per network: Deloitte,
PwC, EY, KPMG, BDO; TSMC's Deloitte & Touche in Taipei, ASML's
PricewaterhouseCoopers Accountants N.V. and NXP's EY Accountants B.V. are
named exactly in their quotes). The Auditor chip is **off by default** on
the map, like Competitors, so the default map is unchanged; company pages
list the auditor under "Named in the filings".

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
  that fails is dropped and never reaches `public/data/`.**
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
- **A previous registrant's company facts**, where a company re-domiciled
  or reorganised under a new CIK (`priorCiks` in `tools/companies.js`; see
  "Joined registrants" above).
- Nothing else. Apple's Supplier List (a 2022 PDF on apple.com) was a
  source until 2026-11-23, when Erik dropped it: the 17 supplier -> Apple
  edges that rested only on it went with it, and so did the PDF reader.
  Every source is now a company's own annual report (or its XBRL labels).
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

The cache is kept small (the VM's disk is nearly full; 394 MB for 81
companies): `fetch.js` cuts company facts down to the tags the build reads
(`xbrl.slimFacts`; add a tag to `xbrl.TAGS` -> delete that company's
`facts/` file and fetch again), and `extract.js` deletes each report's
main document once its text is written (the text is what quotes are checked
against; a report is not fetched again while its text is there). The XBRL
instance and label files stay for the build. `FILINGS_ONLY=KLAC,TER`
fetches just those companies; the manifest keeps everyone else.

```
set -a; . ~/.config/lab-secrets/filings.env; set +a   # SEC_USER_AGENT
npm run data:fetch      # facts (and any prior CIK's), submissions, latest annual report
npm run data:extract    # text per source; candidate sentences -> cache/candidates.json
# read the candidates; edit tools/curated-edges.json (quote = exact substring)
npm run data:build      # figures + verified edges + insights -> public/data/
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
that reads it and never logs it. The build tools exit if it is missing; the
running app (`sec.get`) answers "Lookups are not available right now" (503).
**On Cloud Run it is a secret on the `challenge` service.** It must never be
written into any file here, any committed log or any report. The suite
scans every file in the app for any email address (only `@example.com` test
addresses pass) and, when the variable is set, for the value itself. The
tools stay under four requests a second.

## The published data: an index and parts (since 2026-11-23)

One `dataset.json` would have been well over 2 MB at 81 companies, so the
build writes parts (`Core.split`), and the page merges them as it needs
them (`Core.start`, `Core.merge`; `tools/dataset.js` does the same for the
verifier and tests):

- `data/index.json` (424 KB; about 66 KB gzipped): every company with its
  headline figures (latest revenue, gross or cost) and a revenue sparkline,
  the others, every edge (its link is its source's, put back by `start`)
  and every source. Home and the map need nothing else.
- `data/patterns.json` (301 KB; 43 KB gzipped): the patterns and every
  figure they cite. Loaded on the Patterns view.
- `data/c/<ID>.json` (29 KB at most; ZBRA): one company's figures and
  filings, revenue mix, customer concentration and insight sentences.
  Loaded when a company is opened.

`Core.partPath` is the only way the page names a file (`index`,
`patterns`, `c/<TICKER>`; anything else throws). The integrity hash is over
canonical (key-sorted) JSON, so the order parts load in does not matter.
`server.js` sends the data files gzipped with node's own zlib (the lab
host does not compress).

## At run time

The reviewed set is static: `server.js` serves the page and the data files
and mounts the shared account at `/api/auth`. Since 2026-11-23 (Erik's ask:
he searched for Equifax and it was not there) two things happen on request,
and nothing else. **No timer anywhere; all of it runs inside a request.**

- **sec.gov, for a company looked up on request** ("Look up any company"
  below): only through `tools/sec.js` `get()`, only from the server, rate
  limited. The page never talks to sec.gov; the CSP stays
  `connect-src 'self'`.
- **One model call**, in one route (`POST api/lookup/<cik>/relations`),
  for a signed-in member, behind the budget gates and the Lab AI guard. The
  model picks sentences; `tools/verify.js` decides. It is never a source.

`ASFILED_MEMORY`, `ASFILED_FAKE_AI` and `ASFILED_FAKE_SEC` (a directory of
files standing in for sec.gov) are for tests and a laptop; all three throw
on Cloud Run.

## Look up any company (2026-11-23, Erik approved)

The 81 are read and reviewed by hand. Any other SEC registrant with a
listed ticker can be looked up; it is **labelled "Looked up on request - not
in the reviewed set"** on its page, on its rows, in the quote sheet and on
the map (a dotted violet ring, a "Looked up" layer of its own), and it is
**kept out of the 81's counts, patterns and sums**: those are built files,
and the page holds lookups in `data.lookups`, never `data.companies`.

### Part 1: figures, no model (`lib/lookup.js`)

- `GET api/lookup?q=` resolves a name, ticker or CIK against the SEC's
  `company_tickers.json` (kept in memory and in the store for seven days;
  one request a week). A company of the set answers with `inSet`.
- `GET api/lookup/<cik>` answers the same per-company part the page already
  draws: `tools/build.js` `addCompany` (the build's own per-company step,
  moved into a function - the built dataset is byte-for-byte unchanged),
  `xbrl.slimFacts`, the report's XBRL instance and labels for revenue mix
  (same 0.5% rule) and concentration, and `Core.companyInsights`. Five
  requests to sec.gov: company facts, submissions, the filing's index, its
  instance, its labels. 10-K, or 20-F (the currency is the unit the revenue
  tags are filed in). Ids are `X<cik>`: a ticker can collide with an id in
  `companies.js`. Routes: `#/x/<cik>`, `#/map/X<cik>`.
- What a company lacks is said, not guessed: no annual report among its
  recent filings, no tagged revenue, or a file too large to read here is a
  plain 422. Equifax tags no cost of revenue under the tags the build
  reads, so its page shows revenue, capital spending and two revenue mixes,
  and says the rest is not tagged.
- **Stored** in `asfiled_lookups/<cik>` (`{v, at, cik, json}`), fresh for
  seven days (`ASFILED_LOOKUP_FRESH_DAYS`); a repeat view asks sec.gov
  nothing; past that it is read again (and the stored copy still serves if
  sec.gov does not answer).
- **Limits**, in memory, per instance: 20 builds an hour per address
  (IPv6 by /64) and 300 a day in all (`ASFILED_LOOKUP_PER_IP_HOUR`,
  `ASFILED_LOOKUP_PER_DAY`); searches 240 an hour per address. Two requests
  for one CIK share one build, builds run one at a time, and `sec.get`
  shares one request per URL and stays under four a second.
- **Without `SEC_USER_AGENT`** a lookup that is not stored answers 503
  "Lookups are not available right now". Nothing exits or crashes.
- Memory: Equifax's lookup peaked at 114 MB RSS in a bare process
  (company facts is a few MB of JSON; a large bank's is tens). Files are
  capped (64 MB facts, 48 MB instance, 40 MB report) and refused past
  that. The lab instance has 512 MiB: watch it if large filers are looked
  up often.

### Part 2: relationships (`lib/relations.js`): Claude picks, the verifier decides

`POST api/lookup/<cik>/relations`, same-origin JSON, `requireUser`,
`requireBudget`, `requireDailyCap`, then `guard.allow({provider: 'claude',
app: 'asfiled'})`, then, inside the request (progress goes out as lines of
JSON):

1. the latest annual report is fetched and turned into text with
   `tools/text.js` (in memory; **the report is never stored**);
2. `tools/extract.js` `sentencesNaming` (the extract step's own reader)
   finds sentences that name another company: the set's aliases from
   `companies.js` (not the audit firms), and every other registrant by the
   conservative rule in `lib/names.js` (legal endings dropped; two or more
   words, or one word of six letters or more that is not a common word;
   never a ticker; capitals required; a name two registrants share is
   nobody's). Only sentences with a relationship word (`extract.KEY`) are
   kept, 60 at most;
3. Claude Haiku 5.5 (`claude-haiku-5-5`, thinking off, effort low, JSON
   schema output, `max_tokens` 4096) is shown those sentences and returns
   `{n, counterparty, type, quote}` for competitor / customer / supplier /
   partner;
4. **every proposal goes through `verify.checkEdge`**, against the one
   sentence it points at (so a quote cannot be stitched from two): word for
   word, the quote names the counterparty, the document is the speaker's
   own. What fails is dropped and counted (`stats.dropped`);
5. kept edges get the build's proof hash (sha256 of the report text's hash
   and the quote) and are stored in `asfiled_relations/<cik>`; the
   sentences that were sent (a few KB) in `asfiled_passages/<cik>`. Every
   read re-checks each edge against those sentences and its proof, and
   drops one that no longer matches.

- One run per company per annual report: a stored result is returned to
  anyone, signed in or not, without a model call.
- Usage: the client is `identity.meter`ed, and `guard.record` gets
  `guard.priceUsd({provider: 'claude', model, usage: res.usage})`.
  Measured on the fixture: 397 tokens in, 175 out, $0.0001. A real 10-K
  sends at most 60 sentences: roughly 6,000-9,000 tokens in and up to
  4,096 out, under half a cent at Haiku 5.5's prices.
- Not read here: lead-ins for bulleted lists (a bullet is too short to be a
  sentence), XBRL labels, auditors. A looked-up company's map is what its
  own report's sentences state, nothing more.
- **The tripwire still holds for the committed dataset**, and
  `test/lookup.js` holds the same for a model: a proposed quote that is in
  no sentence, that does not name the company, or that is stitched from
  two sentences yields no edge.

## The page

`public/app.js` (routes `#/`, `#/c/<ID>`, `#/x/<cik>` for a company looked
up on request, `#/patterns`, `#/map[/<ID>]`),
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
- **The map**: layered columns on a wide screen (two staggered columns in
  a layer with more than eight), bands of three or four on a phone. By
  default it shows the companies with the most stated links under the
  current filters (24; 16 on a phone); "All companies" shows every company
  in the layers that are on; searching or tapping a company shows it, every
  company a document links it to, and its supply chain up and down. Labels
  are cut to fit with the full name spoken. One line per pair and family; lines and companies are keyboard
  buttons with spoken labels; tap a line for the sheet (quote, who said it,
  document, section, date, link). Filters by relationship type and layer
  (competitors and auditors start off: competitors are the clutter, and
  an audit firm draws a line to every company it audits). "Follow the flow" walks
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
  sideways. Re-measured at 81 companies (390, 320, 1440): the same. Every view is one tap from home.

## What is notably NOT on the map (because no source here states it)

The expansion (2026-11-23: 381 new edges, 511 in all) was curated from
each new company's latest 10-K text and re-read for the original nineteen
for newly added names. The same day Erik dropped Apple's Supplier List (17
edges) and the investor line type (9 edges), and added the auditors (81
edges): 566 in all. Litigation, whole-company acquisitions, investments
and former parents (HP/HPE, WDC/Sandisk) are not drawn.

- Most of the 62 name no customer in the set: only KLA (TSMC), Qnity
  (Samsung, TSMC), NXP (Apple, Samsung among its ten largest end
  customers), Skyworks (Apple, 61% of revenue), Coherent (NVIDIA supply
  agreement), Akamai (Adobe, Autodesk, Sony) and Flex (Amazon, through a
  warrant) do; Lumentum names Huawei as a past customer.
- Supermicro's 10-K does not name NVIDIA, Intel or AMD as suppliers (only
  "we work closely with"), and names no customer. Arista names Broadcom as
  its merchant silicon vendor but not Microsoft or Meta (two customers at
  26% and 16%, unnamed). Marvell names no foundry. Jabil, Amphenol, TE,
  Keysight, Teledyne, Seagate and Western Digital name no customer or
  supplier in the set.
- Salesforce, Adobe, Accenture and Gartner name no company in the set
  (Adobe only in a director's biography). Oracle names no customer and no
  chip supplier, and does not mention OpenAI. Datadog and ServiceNow name
  no hosting provider; Synopsys names no competitor.
- HPE names Intel, AMD, Broadcom and NVIDIA as single-source suppliers;
  Fortinet names its component suppliers; CDW names the vendors its sales
  rest on - these are among the few supplier statements in the sector.

- Apple's 10-K names no supplier, and Apple's Supplier List is no longer a
  source, so the only lines into Apple are the sellers' own statements
  (Qualcomm, NXP and Skyworks name Apple as a customer; CDW names Apple as
  a vendor). TSMC, Samsung and Foxconn are not drawn as Apple suppliers.
- TSMC's 20-F names no customer (it tags "Customer A" and "Customer B") and
  no equipment supplier. So TSMC -> NVIDIA/AMD/Qualcomm/Broadcom rest
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
field by field, the prior-CIK join (Marvell's years, links under the CIK
each was filed under, the join rule on made-up facts), one verified auditor
edge per company and the Auditor chip off by default, no investor type
anywhere, no Supplier List source or copy, the split (sizes, every part rebuilt from the merged data,
the loader merging in any order, `partPath` refusing anything else, the
gzipped index), the tripwire, insights rebuilt and compared, the verifier
on made-up sources, the cache re-read when the cache is on the machine, the
email / User-Agent scan, the server under its mount (CSP, banner, no inline
anything, requests only to its own base), and the lab entry.

`test/lookup.js` (run by `npm test` after it; no network - sec.gov is
`test/fixtures/sec`, a made-up registrant in the real response shapes,
written by `test/fixtures/make.js`; the model is `lib/fakeai.js`): the name
rule, resolution, the built part against the fixture's company facts, the
store (a repeat view makes no request; seven days), one build for two
requests, the limits, 503 without the User-Agent, the label, signed-out and
cross-site refusals, the run's four edges with their proofs, what is stored,
the model tripwires, the AI guard's refusal over the cap, and that only
`tools/sec.js` reaches outward.
