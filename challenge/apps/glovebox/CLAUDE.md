# For Claude: Glovebox

Know what your car needs next - and what that warning light means. For any
driver whose only record is the oil-change sticker on the windscreen, who
can't remember when the tyres were rotated, panics at an orange light on the
dash, and has no service history to show when selling. Glovebox keeps each
car's **maintenance plan and service log on the phone**, sorts what's due
into **Overdue / Due soon / Coming up / All good** - by miles or months,
**whichever comes first**, the miles projected from how far the car is
actually driven - explains **42 dashboard warning lights** by colour (red:
stop safely now; amber: get it checked soon; green/blue: information), adds
up what the car has cost, and hands a buyer a tidy **service history in one
link** that is carried inside the link itself.

Built 2026-10-12 as an **everyday** drop: Lanes (2026-10-11) was a business
one, so today was the other kind. A free pick from ordinary life (money,
time, home) - not from the inbox, not a holiday. Not a repeat: nothing in the
lab or the portfolio deals with cars. **Staging only**: no custom domain
until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/glovebox`,
served at `challenge.strongtechnicalconsulting.com/glovebox/` once it has a
`lab.js` entry, deployed with `gcpdeploy ship challenge`. See
`challenge/CLAUDE.md` for mounting, prefixes and graduation. Every browser
URL is relative to `BASE`; keep it that way. **It stores nothing in the lab
database** (see Data).

## Why it exists

Cars die expensively from the boring things: an oil change done a year
late, a timing belt nobody knew was due, tyres run down to the cords, brake
fluid never changed. The manual's schedule is in a book in the glovebox
nobody opens, and it is written in miles *or* months - which means doing the
sum against how much you drive. Then a light comes on, it's orange and
shaped like a horseshoe, and there's no way to know if it means "stop now"
or "next week". And when the car is sold, the history is a shoebox of
receipts or nothing at all. Glovebox is the one screen that does the sum,
the plain-words answer to the light, and the history a buyer can read.

**Who pays.** Almost nobody. The example garage, adding cars, the plan, the
board, every action and undo, the pace, costs, the light finder, the history
report and its link, printing, the calendar file and export/import are
free, need no account, and make no request. The one metered thing is **"Read
my dashboard" / "Read a receipt"** (Haiku for the free tier, Sonnet for
members via `identity.planFor`), about a cent.

## The decisions that matter

- **One rules file, run four times.** `public/glovebox-core.js` (UMD:
  `window.GloveboxCore` in both pages, `require` in the server and tests)
  holds the plan, `cleanCar`, dates, units, pace, the due sums, bands and
  headline, every action and undo, costs, the report and its link codec, the
  calendar, export/import and the AI answers' cleaners.
  `public/glovebox-lights.js` (`window.GloveboxLights`) is the light
  catalogue and its icons. The tests check those two files.
- **Distances are kilometres, always.** `toKm` on the way in (kept to the
  hundredth, so every whole mile comes back as the same whole mile - tested
  over 0-300,000 both ways) and `fromKm`/`dist` on the way out. Switching
  miles/km (More; automatic from the phone's region: miles in the US, the UK,
  Liberia, Myanmar and US territories) never rewrites a number. Currency is
  automatic from the region too, with a picker. US English gets "tire" and
  "Gas" (`spell`, `fuelWord`).
- **Dates are 'YYYY-MM-DD' in the phone's time zone**; months are calendar
  months (`addMonths`: the 31st clamps to the month's end); the page redraws
  when the date turns.
- **The plan** (`ITEMS`, 16 items): oil & filter, tyre rotation, tyre
  replacement (by age and tread), brake check, brake fluid, coolant, air and
  cabin filters, spark plugs, fuel filter (diesel), timing belt, 12V battery
  check, wipers, and three **renewals by date** - inspection/MOT,
  registration/road tax, insurance. Intervals are cautious generic middles,
  some per fuel (oil 12,000 km petrol / 15,000 diesel and hybrid; tyres
  45,000 km on an EV). **EVs skip** oil, plugs, the air filter, the fuel
  filter and the timing belt; a timing belt is in the plan only when the
  owner says the car has one (the board asks "belt or chain?" until then; an
  EV is a chain). **Every interval is editable** per car (`plan`: distance,
  months, or off; back to generic), and "your manual wins" is said wherever
  intervals show.
- **Where history starts** (`lastDone`): the latest logged service for the
  item; else, if the owner said when the last service was, that date for the
  **routine** items only (oil, rotation, brake check, filters, battery,
  wipers) - a routine service is not new tyres or a timing belt; a car "new
  to me" starts everything fresh; anything else counts from the day the car
  was added and is marked **"No record"**.
- **Driving pace** (`paceOf`): every odometer point (readings, a service's
  mileage, a known last-service mileage), one per day, **never going down** -
  a lower reading (a typo, miles typed as km, a swapped cluster) is set aside
  and counted, and the board says so. Pace is from the earliest point in the
  last year to the latest; after a **long gap** it reaches back for the point
  before the year. Fewer than two points a fortnight apart: a typical
  18,000 km (≈11,000 mi) year, **labelled a guess**. Today's odometer is
  estimated from the latest reading plus the pace; past 30 days the board
  asks for a reading with a one-tap **Update mileage**. Adding a reading lower
  than the one before (or higher than a later one), or an impossible jump, is
  a 409 the sheet turns into "Save it anyway".
- **Due, whichever comes first** (`statusOf`): months from the last time,
  and the last time's odometer plus the interval (a service logged without
  mileage gets its odometer interpolated from the readings), projected to a
  date by the pace. **Overdue** when past either; **Due soon** within 30 days
  or about 10% of the distance interval (800-1,600 km); **Coming up** within
  90 days or a quarter of the interval; else **All good**. Renewals: the date
  the owner gave, else a year (the interval) on from the last one logged;
  logging one moves the date on. Bands always carry their word and icon;
  cards have a coloured edge as well, never instead.
- **The headline**: "Oil & filter change due in about 3 weeks (≈ 600
  miles)." / "Tire rotation is overdue - by about 1,400 miles." / "All good.
  Next up: ...". Distances in a sentence round to the hundred.
- **Actions and undo** (`act`/`undo`): log a service, add a reading, set a
  renewal date, change an interval, belt/chain, edit, delete an entry. Each
  returns a new car, a message and a token holding the car before; `undo`
  puts it back exactly, **only if nothing has happened since** (`rev`). Every
  toast has Undo; removing a car undoes too (its receipt photos are deleted
  only after the undo window).
- **Costs** (`costs`): this year, all logged, and per mile/km over the
  distance the readings cover since the first cost. Only the garage's
  currency is added up; entries in another (a receipt from abroad) are
  counted and said so.
- **Receipt photos stay on the phone**: shrunk to 1400px, kept in IndexedDB
  (`glovebox-receipts`), keyed by the entry, shown as a thumbnail in the log,
  deleted with their entry or car. Never uploaded unless the person asks AI to
  read one - and then read once and dropped.

### The warning-light finder (`public/glovebox-lights.js`)

42 symbols as inline SVG (24x24, stroked in `currentColor`, plain paths,
circles, rects and a few letters - tested), drawn lit in their colour on a
dark "dash" tile in both themes. **Pick the colour, then the shape**, or
search by name or by what it looks like ("horseshoe", "oil can"). Groups:
**red - stop safely now** (11: oil pressure, engine temperature, battery,
brake, parking brake, airbag, power steering, seat belt, door, bonnet, EV
fault), **amber - get it checked soon** (22, including check engine, ABS,
TPMS, traction/ESC, low fuel, glow plug, DPF, AdBlue/DEF, service due, oil
level, washer fluid, lane assist, transmission, limp mode, and rear fog -
amber but information, and says so), **green/blue - information** (9). Each
has what it means, how urgent, **what to do now** (first, because someone
reading may be at the roadside), **what not to do**, a typical cause, and
what flashing means where it matters. Rules held by the tests:

- every red's urgency and first step say to **stop safely** (oil and heat:
  "find a safe place and stop ... turn the engine off");
- nothing anywhere says a warning is safe or fine to ignore or drive on;
- no repair instructions beyond basic safe checks (the dipstick with the
  engine off and cool, tyre pressures, the fuel cap, topping up washer fluid
  or AdBlue);
- "Guidance, not a diagnosis ... check your owner's manual" wherever advice
  shows.

### The example garage (`public/demo.js`)

Two cars, every date worked out from today in the viewer's zone. **The
family SUV** (2018 Honda CR-V, bought used three years ago at 12,000 miles,
about 1,000 miles a month): sixteen log entries - oil changes, rotations, new
tyres, a battery, brake fluid, pads, filters, wipers, an inspection, a
pre-purchase check - with shops, notes and costs; the tyre rotation is
**overdue** by about 1,400 miles, the oil change **due soon** (about three
weeks, ≈ 600 miles), brake fluid, wipers and registration coming up. **The
runaround** (2012 Ford Fiesta, bought eight months ago with no paperwork):
one oil change, two readings - the latest six weeks old, so it asks for one -
belt or chain unknown, no inspection date, "No record" items. The test holds
both stories on **every day of a year**. Costs follow the viewer's currency
(scaled for yen, rupees and the like). Taps work and are never saved.

### The service-history link (selling or handing over)

- **History** tab: a preview of exactly what the buyer sees - car, odometer,
  entries, first and latest, "At a glance" (oil changes, tyres, brakes,
  timing belt, battery, brake fluid, coolant, inspection: how many and the
  last), and every entry with date, mileage, work and shop. **Costs and notes
  are off by default** (two ticks). Never: receipts, the nickname, ids.
  The footer says it is the owner's own record, not checked by a garage -
  ask for receipts, get an inspection.
- **The fragment** (`packReport` -> `encodeReport`): compact JSON, deflated
  with `CompressionStream` and base64url'd, `history#v1.z.<...>`; plain
  `v1.p.<...>` where a browser cannot compress. At most 16,000 characters: a
  log too long for one link leaves the oldest entries off and says how many
  ("print a PDF for the full history"). **Browsers never send a fragment to
  a server**: the test records every request while a link is fetched and
  finds only `/glovebox/history`.
- **Decoded defensively** (`decodeReport`, never throws): version and
  charset checked, 16,000 characters, inflate capped at 96 KB (a deflate bomb
  is refused), strict UTF-8 and JSON, then `cleanReport` - names and text
  cleaned, items only if real, numbers bounded, currencies from the list.
  The buyer's page (`history.html`, `history.js`) makes **no request**,
  escapes everything, offers miles/km and **Print or save as PDF** (print
  CSS). A cut or garbled link gets a kind sentence.

### The calendar, and moving phones

- **No reminders** (no sender on the platform). **Add due dates to my
  calendar**: `icsFor` writes an .ics of everything due in the next year,
  one all-day event per item (overdue ones today), mileage items at their
  **projected** dates and said so, RFC 5545 folded at 75 octets on whole
  characters, escaped, CRLF. A snapshot, said so.
- **Export / import** a JSON file (`exportGarage`, `importGarage`): every car
  through `cleanCar`, 10 at most, duplicate ids made unique, 2 MB cap.
  Receipt photos stay behind (said so).
- A service worker (`sw.js`, Sprout's pattern) keeps the app, the light
  finder and the buyer's page working offline once opened: network first,
  own scope only, never `api/`, only `glovebox-*` caches.

## The one model call (metered)

`POST /api/read {kind: 'dash'|'receipt', photo, today}`:
`requireUser, requireBudget, requireDailyCap` **then** a 6 MB parser
(401/402/403, never 413 - tested), then the kind and the photo checked by its
magic bytes (JPEG/PNG/WebP, 4 MB decoded) before anything is spent, then one
forced tool:

- **`read_dash`** `{relevant, lights: [{catalogueId?, colour, description}],
  odometer?: {value, unit?}, notes}`. The tool does not even ask for urgency.
  `cleanDash`: a catalogue id only if real; every sentence claiming a light
  is fine, safe to ignore, not serious, and anything about urgency or
  severity, dropped; a light's group is the **more serious** of the
  catalogue's and the colour seen (a check-engine light lit red is treated as
  red; an unmatched one with no colour is treated as red). The page shows
  **the catalogue's advice**, never the model's, and "Save as today's
  reading" for the odometer (assuming the user's units if the photo didn't
  say).
- **`read_receipt`** `{relevant, date, mileage?, mileageUnit?, shop, items:
  [{catalogueItem?, description, cost?}], total?, currency?}`.
  `cleanReceipt`: a date not in the future (the phone's `today`, trusted only
  within a day of the server's), items matched only if real, costs bounded,
  a currency from the list. It opens the **log form, filled in and editable;
  nothing is saved until Add**. A receipt in another currency keeps it and is
  left out of the totals, said so.

Both cleaners are idempotent (the page cleans the server's answer again).
Not a dashboard / not a receipt: 422. The photo is shrunk on the phone to
1600px JPEG, read once, never stored or logged. Signed out, the sheet
explains and offers a free account (and, for the dash, the free finder); 402
opens the credit sheet; 403 `verify-email` shows its sentence and a resend.

## Local run and tests

```
npm run dev     # memory identity + fake model, at http://localhost:8129/glovebox/
npm test        # pure rules, the pages, then end to end over HTTP under /glovebox
```

`GLOVEBOX_MEMORY=1` (the shared account in memory - Glovebox has no store of
its own) and `GLOVEBOX_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`) -
in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests spawn each with
`K_SERVICE` to prove it. `npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`
(run `npm run dev` with it too to try the AI flows without confirming an
address). The fake model refuses a call that does not force a tool, logs
each request with the photo replaced by its length, and reads triggers from
the photo's bytes: `BLANK`, `REDOIL` (the red oil light with the model
insisting it's fine to drive), `INJECT` (markup, bidi, made-up ids, urgency
fields, "safe to ignore", 40 lights or lines, absurd numbers), `MAXTOKENS`,
`UPSTREAMnnn`; otherwise check engine + TPMS and 48,212 mi, or an oil change,
rotation and wipers receipt. Screenshots at 390px and 1280px, light and dark,
were taken with playwright-core against `npm run dev`.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`.

## Data

**None in the lab database.** No car, reading, service, photo, report or
answer is stored (tested: the identity store holds only `users`, `usage`,
`events`, `control`). `lib/store.js` reads `GLOVEBOX_COLLECTION_PREFIX` so
that anything Glovebox ever stores is prefixed from its first write. **On the
phone:** `localStorage` `glovebox-garage-v1` (settings and cars; every access
in try/catch, read back through `cleanCar`; a browser that refuses storage is
told once), IndexedDB `glovebox-receipts` (receipt photos).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, `/sw.js`, `/history` (the
buyer's page), the page. Metered: `POST /api/read`. The shared account at
`/api/auth`. There is deliberately no route for cars.

## Ideas not built yet

- **Reminders** - a push sender would need infrastructure; the .ics covers it.
- **Recalls** by make/model/year (NHTSA's API is free, keyless, US only) - a
  network call per car; worth it if the app graduates.
- **Fuel log** (mpg / L/100km from fill-ups) - a natural second tab.
- **Two drivers, one car** - Shelf Life's online-kitchen pattern would fit.
- **The iPhone shape:** a widget with the headline, the light finder as an
  App Clip, a Siri "what's that light" shortcut, CarPlay's odometer.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=` in
  either page; handlers by `data-act` from one listener.
- No model call for a signed-out visitor, ever; the metered route's gates run
  before its parser.
- Nicknames, shops, notes, imported files, history links and model output
  are untrusted: cleaned, bounded, stripped of markup, control and bidi
  characters, and escaped on render. The history link is attacker-writable
  and decoded with caps and no `eval`, never drawn as HTML.
- `/history` answers `Referrer-Policy: no-referrer` and `noindex`.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body or a photo.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
