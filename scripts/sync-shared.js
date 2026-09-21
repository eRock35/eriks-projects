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
  ['eriks-projects/apps/friction/lib', ['identity.js', 'identity-store.js', 'byok.js', 'webauthn.js', 'sitepass.js', 'analytics.js']],
  ['eriks-projects/apps/dataviz/lib',  ['identity.js', 'identity-store.js', 'byok.js', 'webauthn.js', 'analytics.js']],
  ['trip-planner',                     ['identity.js', 'identity-store.js', 'byok.js', 'analytics.js']],
  ['college-football-app',             ['identity.js', 'identity-store.js', 'byok.js', 'sitepass.js', 'analytics.js']],
  // Santa Rosa is single-account on purpose and shares only these two.
  ['santa-rosa-beach-trip',            ['sitepass.js', 'analytics.js']],
  // The browser-side tour helper.
  // The account page's passkey half. The landing site serves site/ statically.
  ['eriks-projects/site', ['passkey-client.js']],
  ['eriks-projects/apps/friction/public', ['tour.js', 'desktop.css']],
  ['eriks-projects/apps/dataviz/public',  ['tour.js', 'desktop.css']],
  ['trip-planner/public',                 ['tour.js', 'desktop.css']],
  ['college-football-app/public',         ['tour.js', 'desktop.css']],
  ['beer-app/web/public',                 ['tour.js']],
  ['santa-rosa-beach-trip/public',        ['desktop.css']],
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
