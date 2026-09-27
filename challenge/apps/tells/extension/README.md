# Tells for Chrome (and, after conversion, Safari)

A **Tells** button on every LinkedIn and X post, and three right-click
items on any page: *Check selected text with Tells*, *Check this image with
Tells*, *Check this page with Tells*. The toolbar button offers the same
checks (it is the only way in on iPhone and iPad, which have no context
menu).

The quick scan (`tells-core.js`) and the metadata scanner (`tells-meta.js`)
run inside the extension, free, with no network. They are byte-for-byte the
files the Tells page runs; `npm run extension` copies them in and rebuilds
`../public/tells-extension.zip`, and the test suite fails if either drifts.

A deep read, an originality check or a visual read happen only when you
press their buttons. They go through the background worker to the Tells
API with your **device key** (Tells → Settings → Device keys), and are
charged to that account exactly as on the site.

## Permissions, and why each

| Permission | Why |
|---|---|
| `contextMenus` | The three right-click items. Optional in practice: the code checks it exists (iOS has none). |
| `storage` | Your device key and, for local testing, the Tells address. `storage.local` only, never synced. |
| `activeTab` | Right-click or the toolbar button grants access to *that tab, that once*, so the panel can be drawn on sites other than LinkedIn and X. |
| `scripting` | To put the panel into that tab (with the activeTab grant) and to read the selection from the popup. |
| host `www.linkedin.com`, `x.com`, `twitter.com` | The per-post buttons (content scripts). |
| host `media.licdn.com`, `pbs.twimg.com` | Downloading a post's image to read its metadata and draw a small preview. |
| host `challenge.strongtechnicalconsulting.com` | The Tells API. |
| optional `https://*/*` | Only if you ask to check pictures on *other* sites: requested the first time you right-click one (or from the options page), and never needed for anything else. Required-from-install `<all_urls>` was avoided on purpose. |
| optional `http://localhost/*`, `http://127.0.0.1/*` | Only when you point the options at a local Tells for testing. |

Not requested: `tabs`, `history`, `cookies`, `webRequest`, `offscreen`,
`nativeMessaging`. Nothing reads pages in the background: the extension
reads the post you click, and what you right-click, and nothing else.

## Load it unpacked

1. Unzip `tells-extension.zip` (or use this folder).
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the folder.
3. Options → paste a device key → Save → **Test the key**.

## Chrome Web Store

Not listed. Listing it is Erik's step: a developer account ($5 once), a
listing with screenshots and a privacy disclosure (what is sent: the text or
picture you ask to check, to Tells; stored: nothing), then Google's review,
which takes longer for extensions with host permissions.

See `SAFARI.md` for Safari on Mac, iPhone and iPad.
