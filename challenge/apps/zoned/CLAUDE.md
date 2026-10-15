# For Claude: Zoned

Find the building and fridge controllers on your till network - and fence
them off. For IT directors and single-site IT generalists at grocers,
convenience stores, restaurants, clinics, small offices and warehouses,
where the HVAC or refrigeration contractor plugged their controllers - and
often a cellular remote-access box - into the same flat network as the
tills, the office PCs and the guest Wi-Fi.

Bring a scan you already ran - nmap (`-oX`, `-oG` or the screen output), the
computer's ARP table, or the router's DHCP lease list - **read on the device,
never uploaded; Zoned itself never scans, pings or connects to anything** -
and get:

- a verdict: "4 refrigeration and HVAC controllers share a network with your
  5 tills - anyone who gets into one can reach the others", with "now" (one
  flat network, every role counted) beside "the plan" (six zones);
- every device with a **role, a confidence and why** ("Network card made by
  Danfoss - Danfoss makes supermarket refrigeration controllers", "Answers
  BACnet/IP on 47808"), conflicting evidence shown, and an "Is this right?"
  override that re-runs the findings and the plan;
- **findings** ranked worst first, in words, each with its devices and a fix;
- **the zone plan**: Payments, Office, Building & OT, Cameras, Guest,
  Management - VLANs, subnets, every device placed - a default-deny **rule
  table** between zones, and the steps for a managed switch, UniFi, Meraki,
  pfSense/OPNsense and FortiGate;
- a **contractor checklist** and an editable **letter** to the HVAC /
  refrigeration contractor naming the ports their remote access will get;
- a **report**: print / PDF, Markdown and JSON.

Built 2026-10-15 as a **business** drop: Settle (2026-10-14) was everyday,
so today was the other kind. **Staging only**: no custom domain until Erik
decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/zoned`,
served at `challenge.strongtechnicalconsulting.com/zoned/` once it has a
`lab.js` entry, deployed with `gcpdeploy ship challenge`. See
`challenge/CLAUDE.md` for mounting, prefixes and graduation. Every browser
URL is relative to `BASE`; keep it that way. **It stores nothing in the lab
database** (see Data).

## Why it exists

It answers Friction's rising problem **"Building/refrigeration controllers
installed on flat networks by HVAC contractors"**. The contractor needs
remote access to the rack controller, so it goes on the network that is
there - the tills' network - with a factory password, Telnet, and often a
cellular router of its own that the firewall never sees. The store's IT
person usually does not know it is there, and nobody has a list. Zoned turns
a scan they can already make into that list, says what is wrong in plain
words, and hands them a plan they can build and a letter they can send.

Not a repeat: **Shadow** finds unapproved SaaS from card statements; nothing
in the lab or the portfolio looks at a network.

**Who pays.** Almost nobody. The example, the commands, reading the files,
the roles, the findings, the plan, the rules, the steps, the checklist, the
letter and the report are free, need no account, and make no request. The
one metered thing is **"Help me identify the unknowns"** (Haiku for the free
tier, Sonnet for members via `identity.planFor`), about a cent.

**The honest risk.** Roles are worked out from clues - a maker's name, a
port, a banner, a hostname - so a device can be mis-labelled, and the footer
says "check a device before you move it". Weights and the confidence word
are shown; anything below the threshold is "Not identified yet" rather than
a guess, and goes to the Guest zone (internet only) until someone says what
it is. A scan from inside cannot see a cellular router's port forwards; the
finding and the letter say so and ask the contractor. The PCI note is a
plain-words summary that says "not legal or compliance advice - check with
your acquirer or a QSA". The rules and steps are general ("menu names vary
by version"); no exact menu path is claimed.

**How it becomes an iPhone app.** Not for scanning from a phone. For the IT
person walking the store: the device list with "check on site" hints, a
camera to read a controller's label into a note, and the letter sent from
the share sheet. The core is one UMD file already.

## The decisions that matter

- **Nothing is scanned and no scan reaches the server.** `public/zoned-core.js`
  (UMD: `window.ZonedCore` in the page, `require` in the server and tests)
  holds every rule and contains no `require`, `fetch`, XHR, WebSocket,
  `DOMParser` or storage (tested). There is **no route** that accepts a file
  (POSTs to `/api/upload`, `/api/scan`, `/api/devices`, `/api/analyse`,
  `/api/report`, `/api/nmap`, `/api/leases`, `/api/ping` are 404s, tested);
  `server.js` has no `child_process`, `net`, `dgram`, `dns` or `http`
  client (tested). The test holds every request `app.js` makes to `api/me`,
  `api/identify` and the auth/billing routes, and the headless browser pass
  captured every request body while real files (the example's, a hostile
  XML and a UTF-16 ARP table) were loaded through the page: only
  `api/auth/register` and `api/identify`, neither with an address in it.
- **The commands** (`gatherCommands`): the user's network as a CIDR (/16 to
  /32 only, normalised, so nothing typed reaches the shell) and a plain file
  name. Full: `sudo nmap -sV -O --max-rate 200 -p T:<1-1024 + building and
  remote-access ports> -oX store.xml <net>`; quick: `nmap -sn`; building
  UDP: `nmap -sU -sV --max-rate 100 -p U:47808,1628,1629,3671`; ARP:
  `arp -a` (or `ip neigh`); DHCP: the router's export, or
  `Get-DhcpServerv4Lease ... | Export-Csv` on a Windows server. No sudo on
  Windows. `--open` is deliberately left out so quiet devices (card readers,
  phones) still appear. The page says to scan only networks you are
  responsible for, out of hours, with the contractor told - old controllers
  can misbehave under heavy scanning - and offers the gentle options. Tested:
  no curl/wget/ssh/iwr/irm/iex/eval/URL/pipe into a shell/rm; injection
  attempts in the network or file name are refused.
- **Reading** (`readInput` -> `detectKind`):
  - **nmap XML** by `xmlWalk`, a small tokenizer used by the page AND the
    tests (deliberately not `DOMParser`, so the browser runs exactly the
    tested code): it skips the DOCTYPE and its internal subset, decodes only
    the five named entities and numeric references, and leaves any custom
    entity as literal text - so a billion-laughs bomb, `SYSTEM "file:..."`
    or `SYSTEM "http://169.254..."` expands nothing and fetches nothing, and
    the page says "Zoned never expands or fetches them". Element (2M) and
    depth (64) limits; a file cut off mid-host keeps what it has and says so;
    malformed tags are counted, never thrown. Hosts down are counted and
    skipped; a host with no MAC is kept; IPv4, IPv6 and MAC addresses; the
    most accurate `osmatch`; `devicetype`; `http-title` and banner-style
    scripts; the scanned range from `args`.
  - **nmap normal output** (`-oN`, or pasted from the terminal), **grepable**
    (`-oG`; it carries no MAC, and the page says so), **ARP tables** (Windows
    `arp -a`, macOS with its dropped leading zeros, Linux `arp -a`, `arp -n`,
    `ip neigh`; broadcast, multicast, incomplete and `.255` skipped), **DHCP
    lease CSVs** (`automapLeases`: header synonyms confirmed by values,
    headerless files by values; comma/semicolon/tab, quotes, BOM, CRLF; MACs
    as `00-1A-...`, Cisco dotted, Windows `Unique ID` and `01`+MAC client
    ids; a column picker in the page that wins over the automatic mapping),
    and **dnsmasq lease files**. PowerShell's UTF-16 output is decoded.
- **Merging** (`merge`): one device per MAC across files; a device known only
  by IP joins the one device with that IP; an IP claimed by two MACs keeps
  both, with a note on each ("an old DHCP lease, or two devices fighting").
- **No MAC prefix (OUI) is mapped to a maker.** The only maker names used are
  the ones nmap or a DHCP export already resolved. The two MAC facts used are
  bits of the address defined by IEEE 802: the multicast bit (skip) and the
  locally-administered bit ("a private, randomised Wi-Fi address - phones
  and laptops use these").
- **Roles** (`ROLES`: payment/POS, office, printer, camera/NVR, network,
  guest, and building & OT - refrigeration, HVAC/building controller, BMS
  workstation, lighting/energy, remote-access gateway, smart/IoT - and
  unknown). `evidence()` collects weighted reasons from: maker names
  (`VENDOR_RULES` - Danfoss, Copeland, Emerson, Carel, Dixell, Johnson
  Controls, Honeywell, Siemens, Schneider, Tridium, Distech, Delta Controls,
  Automated Logic, Trane, Carrier, Daikin, Mitsubishi, Lutron, Sierra
  Wireless, Cradlepoint, Digi, Teltonika, Moxa, Hikvision, Dahua, Axis,
  Verifone, Ingenico, PAX, NCR...), model names (`MODEL_RULES` - XWEB,
  AK-SM, pCOWeb, JACE, NAE, IBR, RUT, ACEmanager, DS-2CD...), hostnames
  (`HOSTNAME_RULES`), ports (BACnet 47808, Niagara Fox 1911/4911, Modbus 502,
  LonWorks 1628-1629, KNX 3671, DNP3 20000, S7 102, EtherNet/IP 44818, MQTT,
  RTSP 554, JetDirect 9100, SMB, RDP, TeamViewer, DNS - with BACnet or Fox on
  a Windows PC meaning a BMS workstation), nmap's device-type and OS guess,
  and the private-address bit. Words are matched as words (`PAX` is not
  `paxos`, `Digi` is not `digital`); some maker names (Carrier, Axis, Digi,
  PAX, NCR, Square, Microsoft) count only as the scan's maker name, never in a
  banner or hostname. `classify`: the top score wins at 3+; Sure (7+, and
  the runner-up at most half), Likely, A guess; a strong runner-up is shown
  as "Could also be". Each rule's explanation is given once per device.
  The user's override wins (`conf: 'you'`) and the auto guess is kept for
  "Back to our guess".
- **Findings** (`findings`, worst first, each with devices and a fix):
  `ot-with-pos` (the headline, counting refrigeration and HVAC controllers
  against tills, and naming the rest of the OT), `ot-with-office` (no tills),
  `remote-gateway`, `open-ot-protocols` (BACnet, Modbus, Fox, LonWorks, KNX,
  DNP3, S7, EtherNet/IP - no password of their own), `cleartext` (Telnet,
  FTP), `guest-on-business` (high when it shares the tills' network),
  `remote-desktop` (RDP, VNC, TeamViewer), `cameras-on-pos`, `http-admin`
  (OT, network gear and cameras with HTTP and no HTTPS), `default-names` (a
  hostname still a factory model name), `unknowns`, `no-pos`, `pci-scope`
  (a note, "not legal or compliance advice"), `separate` (already on
  different subnets: check the firewall blocks both ways). "Same network" is
  the smallest scanned range holding the address, else its /24.
- **The plan** (`zonePlan`, `firewallRules`): every device in exactly one
  zone by its role; unknowns wait in Guest. VLANs 20/10/30/40/50/99 on
  `10.10.<vlan>.0/24`, or `172.16.` when the network in use is already in
  10.10. Rules: Payments to the processor on 443 only; Office -> Payments
  denied; the BMS PC to the controllers and the contractor's VPN to Building
  & OT on **the ports the controllers actually answered on** (minus Telnet,
  FTP and remote control); Building & OT -> Internet to the makers' cloud on
  443; **Building & OT -> Payments: Deny, said explicitly**; cameras viewed
  from one PC and kept off the internet; Guest internet only; Management
  from one admin PC; last row "Any zone -> Any other zone: Deny". Tested:
  every allow names its service, nothing allows OT -> Payments.
- **The checklist and the letter** (`checklist`, `letter`) name this
  network's controllers, their addresses and ports, the remote-access box
  ("list any port forwards... do not install another modem or router without
  asking us first"), Telnet by device, and ask how temperature alarms reach
  the contractor - with a test alarm after each change, so a failing freezer
  is never missed. Plain text for a textarea; fields cleaned to one line.

### The example (`public/demo.js`)

"Corner Market", a made-up grocery: one flat 192.168.1.0/24 with 45
devices, written out as the three files the commands produce (`store.xml`,
`store-udp.xml`, the router's `leases.csv` with its own odd headers) and
read by the same parsers. Every MAC is from **RFC 7042's documentation
range** (`00-00-5E-00-53-xx`) or locally administered, so no real maker's
prefix is implied. Planted, and asserted to be exactly what Zoned finds:
four NCR tills and a Verifone PIN pad; a Danfoss AK-SM 800 rack controller
(Modbus), two case controllers (Carel with BACnet, Dixell XWEB with Telnet),
a Johnson Controls BACnet HVAC controller; a Dell BMS PC with Niagara Fox,
RDP and TeamViewer (the conflicting-evidence case: BMS PC, Likely, could be
an office PC); a Lutron controller with Telnet; a Sierra Wireless AirLink
cellular router; an ecobee thermostat; a Hikvision NVR and six cameras, two
Dahua cameras; a back-office PC, a Synology NAS, two printers; the gateway,
a switch and an AP; thirteen phones (guest Wi-Fi bridged in, mostly from the
lease list); three unknowns. Verdict: "4 refrigeration and HVAC controllers
share a network with your 5 tills"; eleven findings in a fixed order. Never
saved.

## The one model call (metered)

**Help me identify the unknowns** - `POST /api/identify`: `requireUser,
requireBudget, requireDailyCap` **then** a 64 KB parser (401/402/403, never
413 - tested), then `ZonedCore.cleanIdentifyRequest` rebuilds the body - up
to 12 devices, each a ref (`d1`...), the maker name, up to three hostnames,
up to 20 services (port, protocol, service, product, title), the OS guess -
with **anything shaped like an IPv4, IPv6 or MAC address replaced by
`[address]`** (also inside hostnames and banners) and devices with nothing to
go on dropped; nothing usable is a 400 before anything is spent. One forced
tool, `identify_devices` `{devices: [{ref, role, confidence, why, check}]}`
with `role` an enum of the fixed list, then `cleanIdentification`: only refs
that were sent, roles on the list, confidence a known word, sentences
bounded and stripped. Nothing usable is a 422. The prompt fences the devices
and says banners and hostnames are untrusted data.

The page builds the payload with `ZonedCore.identifyPayload` (the same
scrubbing; the IP-to-device map stays in the page as `refs`), lists the
unknowns with ticks (a device with no clues cannot be ticked), and **shows
the exact JSON** before sending, updating as ticks change. Signed out, the
sheet explains, shows the payload and offers a free account. 402 opens the
credit sheet; 403 `verify-email` shows its sentence and "Send the link
again". Suggestions show with "Use this" (sets the override); nothing is
applied without a tap. The test proves an IP, a MAC, a whole scan and a
`system` field sent alongside never reach the fake model, and that the
demo's other devices (tills, Danfoss) are not described to it.

## Local run and tests

```
npm run dev     # memory identity + fake model, at http://localhost:8132/zoned/
npm test        # pure rules, then end to end over HTTP under /zoned
```

`ZONED_MEMORY=1` (the shared account in memory - Zoned has no store of its
own) and `ZONED_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`) - in
`lib/store.js`, `lib/fakeai.js` and `server.js`; the tests spawn each with
`K_SERVICE` to prove it. `npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`
(the dev server does not, so a new dev account sees the verify-email
sentence - set it to 0 to try Identify). The fake model refuses a call that
does not force a tool, logs each request (`fakeCalls`) and guesses from a
few keywords; triggers in a vendor or hostname: `BLANK`, `INJECT`,
`MAXTOKENS`, `UPSTREAMnnn`. Screenshots at 390px and 1280px, light and dark
(first run, Check my network, the findings, the device list, an OT device
opened, the conflicting-evidence device, the zone plan and rule table, the
contractor checklist and letter, the report, the identify sheet signed out
and signed in, the answer), plus a pass that loads files through the page
(a hostile XML with markup, bidi, a 3,000-character name and an external
entity; a UTF-16 ARP table): no dialog, no injected element, no horizontal
scroll, no scan data in any request.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Data

**None in the lab database.** No scan, device, address or answer is stored
(tested: the identity store holds only `users`, `usage`, `events`,
`control`, and no address, maker or answer text). `lib/store.js` reads
`ZONED_COLLECTION_PREFIX` so that anything ever stored is prefixed from its
first write. **In the browser:** roles you set, device notes, checklist
ticks and an edited letter in `localStorage` `zoned-saved-v1`, keyed by a
hash of the input files (`hashText`, never sent), the twenty most recent
sets; the letter's name fields in `zoned-letter-v1`; the command settings in
`zoned-cmd-v1`. Every access in try/catch; Clear on the Report tab. The
example is never saved. Loaded files live only in the tab.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page. Metered:
`POST /api/identify`. The shared account at `/api/auth`. There is
deliberately no route for a scan.

## Ideas not built yet

- **Read the firewall's own config** (a pfSense/OPNsense XML backup, a
  FortiGate config) and check the zones and rules are really in place - the
  "already separate" case deserves more than a note.
- **A walk-the-store mode**: the unknowns as a checklist with "check on site"
  hints, a photo of a controller's label read into a note (on the device).
- **A summary card** (canvas PNG, two taps to share) for the owner.
- **Before/after**: load a scan made after the change and show what moved.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`;
  handlers by `data-act` from one listener (tested here and by
  `challenge/test/lab.js` once mounted).
- No model call for a signed-out visitor, ever; the metered route's gates run
  before its parser.
- Hostnames, makers, banners and page titles are written by whoever controls
  the device: `clean()` bounds them and strips control, bidi and zero-width
  characters when read; `esc()` escapes every render (quotes too); long
  strings wrap or are cut; tables and commands scroll in their own box; the
  Markdown export escapes prose and code spans (a pipe cannot break a
  table, a name cannot become a link); the letter is plain text in a
  textarea.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
