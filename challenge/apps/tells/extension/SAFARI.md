# Tells for Safari (Mac, iPhone, iPad)

Safari runs the same Manifest V3 code once it is wrapped in an app with
Apple's converter. That needs a Mac with Xcode and an Apple Developer
account ($99 a year) to distribute, so it is **Erik's step** - nothing in this
repo can do it. The code is written so the converter works unchanged:

- `globalThis.browser || globalThis.chrome` everywhere, promise-style calls.
- No Chrome-only APIs: no `offscreen` documents (a picture is shrunk with
  `OffscreenCanvas` in the worker where Safari has it - 16.4+ - and
  otherwise the original is sent if small, else only its metadata is read).
- A classic `background.service_worker` with `importScripts`.
- The right-click menu is optional (`api.contextMenus` is checked): iOS has
  no context menu, so the toolbar popup offers **Check selection** and
  **Check this page** through `activeTab` + `scripting`.

## Steps

1. On a Mac with Xcode 15 or later:
   ```
   xcrun safari-web-extension-converter path/to/challenge/apps/tells/extension \
     --app-name "Tells" --bundle-identifier com.strongtechnicalconsulting.tells \
     --swift --copy-resources
   ```
   Add `--macos-only` or `--ios-only` to target one platform; by default it
   makes both.
2. Open the generated Xcode project. Set the **Team** (the Apple Developer
   account) on both the app and the extension targets for signing.
3. Run it on a Mac: Safari → Settings → Advanced → *Show features for web
   developers*, then Develop → *Allow unsigned extensions* for local testing;
   enable **Tells** in Safari → Settings → Extensions and grant it
   linkedin.com, x.com and the Tells site.
4. On iPhone/iPad: run on a device from Xcode, then Settings → Safari →
   Extensions → Tells → allow, and grant the sites.
5. To distribute: Product → Archive, upload to App Store Connect, test with
   **TestFlight**, then submit for review.

## What Apple reviews

- That the app shell does something (a short page explaining how to turn
  the extension on is enough) and has a privacy policy URL:
  `https://strongtechnicalconsulting.com/privacy#tells`.
- The **privacy nutrition label**: the text or picture a person chooses to
  check is sent to Tells to be read and is not stored or used for tracking;
  no data is linked to identity beyond the account the device key belongs to.
- That website access is justified: the per-post buttons need linkedin.com
  and x.com; everything else is on request.
