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
  ['trip-planner',                     ['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'analytics.js', 'gmail.js', 'receipts.js', 'statement.js', 'photostore.js']],
  ['college-football-app',             ['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'sitepass.js', 'analytics.js']],
  // Spellbook takes identity's webauthn plainly: it has no webauthn.js of its
  // own to collide with, unlike trip-planner and football. It does not take
  // shared/analytics.js - not because of a name collision any more (its own
  // analytics.js was the view tracker and moved to lib/views.js on
  // 2026-09-22), but because GA was never wired into its pages. Adding it is
  // a page change as well as a copy; don't list it here until that is done.
  ['spellbook',                        ['identity.js', 'identity-store.js', 'byok.js', 'stripe.js', 'webauthn.js']],
  // Santa Rosa is single-account on purpose. It takes gmail.js and byok.js
  // (the token vault) and nothing from identity: reading booking mail does
  // not need the shared account, and joining it would put a private app on
  // the domain-wide sign-in it deliberately stays off.
  ['santa-rosa-beach-trip',            ['sitepass.js', 'analytics.js', 'gmail.js', 'byok.js', 'receipts.js', 'statement.js', 'photostore.js']],
  // The browser-side tour helper.
  // The view beacon rides along with the browser helpers: every app that
  // appears in the trending ranking has to report itself, or the ranking is
  // just whichever app happens to carry the file.
  ['eriks-projects/site', ['passkey-client.js', 'beacon.js']],
  ['eriks-projects/apps/friction/public', ['tour.js', 'desktop.css', 'beacon.js']],
  ['eriks-projects/apps/dataviz/public',  ['tour.js', 'desktop.css', 'beacon.js']],
  ['eriks-projects/challenge/apps/spar/public',['desktop.css', 'passkey-client.js']],
  ['eriks-projects/challenge/apps/snapquote/public',['desktop.css', 'passkey-client.js']],
  ['eriks-projects/challenge/apps/chaser/public',['desktop.css', 'passkey-client.js']],
  ['eriks-projects/challenge/apps/rave/public',['desktop.css', 'passkey-client.js']],
  ['eriks-projects/challenge/apps/popquiz/public',['desktop.css', 'passkey-client.js']],
  ['eriks-projects/challenge/apps/glowup/public',['desktop.css', 'passkey-client.js']],
  ['eriks-projects/challenge/apps/booth/public',['desktop.css', 'passkey-client.js']],
  ['eriks-projects/challenge/apps/receipt/public',['desktop.css', 'passkey-client.js']],
  ['trip-planner/public',                 ['tour.js', 'desktop.css', 'beacon.js', 'photo-tools.js']],
  ['college-football-app/public',         ['tour.js', 'desktop.css', 'beacon.js']],
  ['beer-app/web/public',                 ['tour.js', 'beacon.js']],
  ['spellbook/public',                    ['beacon.js']],
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
  for (const file of files) {
    const srcPath = sourceOf(file);
    if (!fs.existsSync(srcPath)) { missingSource.push(file); continue; }
    const destDir = path.join(ROOT, dir);
    if (!fs.existsSync(destDir)) continue;           // repo not checked out here
    const dest = path.join(destDir, file);
    const want = render(file, dir);
    const have = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
    if (have === want) continue;
    if (check) { drifted.push(`${dir}/${file}`); continue; }
    fs.writeFileSync(dest, want);
    console.log(`  updated  ${dir}/${file}`);
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
