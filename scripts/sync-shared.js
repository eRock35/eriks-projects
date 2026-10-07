#!/usr/bin/env node
/**
 * The shared modules are copied into each app rather than packaged, because
 * each app is its own repo and its own container. That is a deliberate choice
 * (see DEPLOY.md), but copies drift: sitepass.js was already different in
 * three places before this script existed, and identity.js has been re-synced
 * by hand four times in one working session.
 *
 *   node scripts/sync-shared.js          copy shared/ -> every app
 *   node scripts/sync-shared.js --check  exit 1 if any copy differs (for CI)
 *
 * The one legitimate difference is the webauthn require path: two apps have a
 * file called webauthn.js already, so identity's import is renamed there.
 * That rename is applied on copy and undone before comparing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');      // /home/user
const SHARED = path.join(__dirname, '..', 'shared');

// Which shared files each app carries, and where they live inside it.
const TARGETS = [
  // Server-side modules, per app, exactly as each app actually carries them.
  ['eriks-projects/apps/friction/lib', ['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js', 'sitepass.js', 'analytics.js']],
  ['eriks-projects/apps/dataviz/lib',  ['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js', 'analytics.js']],
  ['eriks-projects/challenge/apps/spar/lib',['identity.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/snapquote/lib',['identity.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/chaser/lib',['identity.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/rave/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/popquiz/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/glowup/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/booth/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/receipt/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/tally/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/tipout/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/tells/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/covenant/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/hike/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/dibs/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/leash/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/drip/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/boxed/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/flight/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/insidejoke/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/shadow/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/chorus/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/tieout/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/shelflife/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  ['eriks-projects/challenge/apps/burnrate/lib',['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  // Next Move (2026-10-02): a service of its own with Cloud Run jobs on the
  // same image, like Friction but on the shared account alone.
  ['eriks-projects/apps/nextmove/lib', ['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  // `webauthn.js:identity-webauthn.js` copies shared/webauthn.js in under
  // the name identity.js requires there (see RENAME_WEBAUTHN). Those copies
  // were made by hand and never synced, so a change to the passkey module
  // could reach every app but the two that renamed it (fixed 2026-09-27).
  ['trip-planner',                     ['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'analytics.js', 'gmail.js', 'receipts.js', 'statement.js', 'photostore.js', 'webauthn.js:identity-webauthn.js']],
  ['college-football-app',             ['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'sitepass.js', 'analytics.js', 'webauthn.js:identity-webauthn.js']],
  // Spellbook takes identity's webauthn plainly: it has no webauthn.js of its
  // own to collide with, unlike trip-planner and football. It does not take
  // shared/analytics.js - not because of a name collision any more (its own
  // analytics.js was the view tracker and moved to lib/views.js on
  // 2026-09-22), but because GA was never wired into its pages. Adding it is
  // a page change as well as a copy; don't list it here until that is done.
  ['spellbook',                        ['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  // Santa Rosa (santa-rosa-beach-trip) was retired on 2026-09-27 and takes
  // no more copies. Put its line back if it is ever redeployed.
  // The browser-side tour helper.
  // get-app.js (2026-10-03) goes to the four iPhone apps' pages and the
  // landing page: the "Get the iPhone app" bar and list.
  // verify-banner.js (2026-09-27) goes to every page with a shared-account
  // UI - not Hopscotch, which links shared accounts by uid and has its own.
  // The view beacon rides along with the browser helpers: every app that
  // appears in the trending ranking has to report itself, or the ranking is
  // just whichever app happens to carry the file.
  ['eriks-projects/site', ['passkey-client.js', 'beacon.js', 'verify-banner.js', 'get-app.js']],
  ['eriks-projects/apps/friction/public', ['tour.js', 'desktop.css', 'beacon.js', 'verify-banner.js']],
  ['eriks-projects/apps/dataviz/public',  ['tour.js', 'desktop.css', 'beacon.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/spar/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/snapquote/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/chaser/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/rave/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/popquiz/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/glowup/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/booth/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/receipt/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/tally/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/tipout/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/tells/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/covenant/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/hike/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/dibs/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/leash/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/drip/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/boxed/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/flight/public',['desktop.css', 'passkey-client.js', 'verify-banner.js', 'get-app.js']],
  ['eriks-projects/challenge/apps/insidejoke/public',['desktop.css', 'passkey-client.js', 'verify-banner.js', 'get-app.js']],
  ['eriks-projects/challenge/apps/shadow/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/chorus/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/tieout/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/shelflife/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/challenge/apps/burnrate/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['eriks-projects/apps/nextmove/public', ['desktop.css', 'passkey-client.js', 'verify-banner.js']],
  ['trip-planner/public',                 ['tour.js', 'desktop.css', 'beacon.js', 'photo-tools.js', 'verify-banner.js', 'get-app.js']],
  ['college-football-app/public',         ['tour.js', 'desktop.css', 'beacon.js', 'verify-banner.js', 'get-app.js']],
  ['beer-app/web/public',                 ['tour.js', 'beacon.js', 'get-app.js']],
  ['spellbook/public',                    ['beacon.js', 'verify-banner.js']],
  ['santa-rosa-beach-trip/public',        ['desktop.css', 'photo-tools.js']],
];

// Apps that already had a webauthn.js of their own; identity.js is copied in
// with its import renamed so the two do not collide.
const RENAME_WEBAUTHN = new Set(['trip-planner', 'college-football-app']);

const FROM = "const webauthn = require('./webauthn');";
const TO = "const webauthn = require('./identity-webauthn');";

// identity-store.js is canonical in lib/ rather than shared/ - it is the
// Firestore adapter the server side uses, not a browser-facing module.
const LIB = path.join(__dirname, '..', 'lib');
const sourceOf = (file) => (file === 'identity-store.js' ? path.join(LIB, file) : path.join(SHARED, file));

function render(file, dir) {
  const src = fs.readFileSync(sourceOf(file), 'utf8');
  const app = dir.split('/')[0];
  if (file === 'identity.js' && RENAME_WEBAUTHN.has(app)) return src.replace(FROM, TO);
  return src;
}

const check = process.argv.includes('--check');
let drifted = [];
let copied = 0;
let missingSource = [];

for (const [dir, files] of TARGETS) {
  for (const entry of files) {
    // 'source.js:dest.js' copies a shared file in under another name.
    const [file, destName = file] = entry.split(':');
    const srcPath = sourceOf(file);
    if (!fs.existsSync(srcPath)) { missingSource.push(file); continue; }
    const destDir = path.join(ROOT, dir);
    if (!fs.existsSync(destDir)) continue;           // repo not checked out here
    const dest = path.join(destDir, destName);
    const want = render(file, dir);
    const have = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
    if (have === want) continue;
    if (check) { drifted.push(`${dir}/${destName}`); continue; }
    fs.writeFileSync(dest, want);
    console.log(`  updated  ${dir}/${destName}`);
    copied++;
  }
}

if (missingSource.length) {
  console.error(`shared/ is missing: ${[...new Set(missingSource)].join(', ')}`);
  process.exit(2);
}
if (check) {
  if (drifted.length) {
    console.error('These copies differ from shared/:\n' + drifted.map((d) => '  ' + d).join('\n'));
    console.error('\nFix the file in shared/, then run: node scripts/sync-shared.js');
    process.exit(1);
  }
  console.log('shared/ and every copy agree.');
} else {
  console.log(copied ? `\n${copied} file(s) updated.` : 'Everything already in sync.');
}
