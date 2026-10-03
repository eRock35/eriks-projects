#!/usr/bin/env node
// Builds the four iPhone app projects from one template.
//
//   cd mobile && npm install && npm run generate          # all four
//   cd mobile && npm run generate -- trip                  # one
//
// What is shared lives once: template/ios/*.swift (the link rule), the Info.plist
// and entitlements shapes, the icon and splash recipe. What differs per app is
// the APPS table below. Each app folder (trip/, hopscotch/, flight/, insidejoke/)
// holds the OUTPUT, committed, so the macOS build in .github/workflows/ios.yml
// only has to `npm ci` and `npx cap sync ios`. Re-running this is safe: every
// step overwrites or checks before adding.
//
// The one thing kept per app by hand is its version: `version` in
// <app>/package.json. That is the App Store version (CFBundleShortVersionString);
// the build number comes from the workflow run.
//
// Runs on Linux. `npx cap add ios` scaffolds the Xcode project without Xcode,
// and Capacitor 8 uses Swift Package Manager, so there is no `pod install`.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOMAIN = 'strongtechnicalconsulting.com';

// Plain words, because they are what the iPhone shows when it asks. Camera and
// photo library: every app takes a photo through a file picker. "Add" is the
// share sheet's "Save Image" - without it, saving a shared card crashes the app.
// Notifications have no Info.plist text: iOS writes that prompt itself.
const APPS = {
  trip: {
    name: 'Trip Planner',
    bundleId: 'com.strongtechnicalconsulting.trip',
    url: `https://trip.${DOMAIN}/`,
    brand: '#0047C8',
    usage: {
      camera: 'Trip Planner uses the camera when you photograph a receipt or add a photo to a trip.',
      photos: 'Trip Planner opens your photo library when you choose a receipt or photos for a trip.',
      photosAdd: 'Trip Planner saves an image to your photo library only when you ask it to, such as a crawl recap card.',
    },
  },
  hopscotch: {
    name: 'Hopscotch',
    bundleId: 'com.strongtechnicalconsulting.hopscotch',
    url: `https://beer.${DOMAIN}/`,
    brand: '#B3730A',
    usage: {
      camera: 'Hopscotch uses the camera when you photograph a beer or its label to log it.',
      photos: 'Hopscotch opens your photo library when you choose a photo of a beer to log.',
      photosAdd: 'Hopscotch saves an image to your photo library only when you ask it to, such as your passport card.',
      location: 'Hopscotch uses your location when you tap Near me, to find breweries around you.',
    },
  },
  flight: {
    name: 'Flight',
    bundleId: 'com.strongtechnicalconsulting.flight',
    url: `https://challenge.${DOMAIN}/flight/`,
    brand: '#16110B',
    usage: {
      camera: 'Flight uses the camera when you snap a beer label to add it to a tasting.',
      photos: 'Flight opens your photo library when you choose a label photo to add to a tasting.',
      photosAdd: 'Flight saves an image to your photo library only when you ask it to.',
    },
  },
  insidejoke: {
    name: 'Inside Joke',
    bundleId: 'com.strongtechnicalconsulting.insidejoke',
    url: `https://challenge.${DOMAIN}/insidejoke/`,
    brand: '#120E19',
    usage: {
      camera: 'Inside Joke uses the camera when you take a photo to turn into trivia questions for your group.',
      photos: 'Inside Joke opens your photo library when you choose photos to turn into trivia questions for your group.',
      photosAdd: 'Inside Joke saves an image to your photo library only when you ask it to.',
    },
  },
};

const hostOf = (app) => new URL(app.url).host;

/* ------------------------------------------------------------------ *
 * Small writers: plist, PNG, deterministic Xcode ids
 * ------------------------------------------------------------------ */

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plistValue(v, ind) {
  const pad = '\t'.repeat(ind);
  if (v === true) return `${pad}<true/>`;
  if (v === false) return `${pad}<false/>`;
  if (typeof v === 'number') return `${pad}<integer>${v}</integer>`;
  if (typeof v === 'string') return `${pad}<string>${xml(v)}</string>`;
  if (Array.isArray(v)) return `${pad}<array>\n${v.map((x) => plistValue(x, ind + 1)).join('\n')}\n${pad}</array>`;
  const body = Object.entries(v).map(([k, x]) => `${pad}\t<key>${xml(k)}</key>\n${plistValue(x, ind + 1)}`).join('\n');
  return `${pad}<dict>\n${body}\n${pad}</dict>`;
}

function plist(obj) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">\n${plistValue(obj, 0)}\n</plist>\n`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGBA pixels -> an RGB PNG (colour type 2). The App Store refuses an app
 *  icon with an alpha channel, so every image here is flattened first. */
function rgbPng(width, height, rgba) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (width * 3 + 1);
    rows[o] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const a = rgba[s + 3];
      if (a !== 255) throw new Error(`pixel ${x},${y} is not opaque - the image needs a full background`);
      rows[o + 1 + x * 3] = rgba[s];
      rows[o + 2 + x * 3] = rgba[s + 1];
      rows[o + 3 + x * 3] = rgba[s + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderSvg(svg, size) {
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render();
  if (img.width !== size || img.height !== size) throw new Error(`rendered ${img.width}x${img.height}, wanted ${size}`);
  return rgbPng(img.width, img.height, img.pixels);
}

/** An svg placed inside another, at x,y with a given size. */
function nested(svg, x, y, size) {
  return svg.replace(/^\s*<svg\b/, `<svg x="${x}" y="${y}" width="${size}" height="${size}"`);
}

/** The web icons are drawn as a rounded tile. iOS cuts its own corners, so
 *  the app icon is the same art with a square, full-bleed background. */
function fullBleed(svg) {
  return svg.replace(/<rect\b[^>]*>/, (tag) => tag.replace(/\s+r[xy]="[^"]*"/g, ''));
}

/** Same object, same id, every run: 24 hex digits from a name. */
const xid = (name) => crypto.createHash('sha1').update(`eriks-projects mobile ${name}`).digest('hex').slice(0, 24).toUpperCase();

/* ------------------------------------------------------------------ *
 * The pieces of one app
 * ------------------------------------------------------------------ */

function capacitorConfig(app) {
  return {
    appId: app.bundleId,
    appName: app.name,
    webDir: 'www',
    backgroundColor: app.brand,
    appendUserAgent: `StrongTechApp/${app.slug}`,
    server: {
      // The live site: a web deploy reaches the app with no store build.
      url: app.url,
      // In-app: this app's host and the shared sign-in's subdomains. Anything
      // else opens outside (template/ios/ShellPlugin.swift).
      allowNavigation: [hostOf(app), `*.${DOMAIN}`],
      // www/index.html, shown when the site cannot be reached.
      errorPath: 'index.html',
    },
    ios: {
      // The pages already pad with env(safe-area-inset-*) under
      // viewport-fit=cover, so the web view runs edge to edge.
      contentInset: 'never',
      backgroundColor: app.brand,
    },
    plugins: {
      SplashScreen: {
        launchShowDuration: 1200,
        launchAutoHide: true,
        launchFadeOutDuration: 300,
        backgroundColor: app.brand,
        showSpinner: false,
      },
      StatusBar: {
        // Dark text on a light page, light text on a dark one, following the
        // phone's appearance - the same rule the pages' own themes follow.
        style: 'DEFAULT',
        overlaysWebView: true,
      },
    },
  };
}

function offlinePage(app) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${xml(app.name)}</title>
<style>
  :root { color-scheme: light dark; --brand: ${app.brand}; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
    padding: env(safe-area-inset-top) 24px env(safe-area-inset-bottom);
    background: var(--brand); color: #fff; text-align: center;
    font: 17px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  }
  h1 { font-size: 22px; margin: 0; }
  p { margin: 0; max-width: 30em; opacity: .92; }
  a.btn {
    margin-top: 12px; display: inline-block; padding: 12px 22px; border-radius: 12px;
    background: #fff; color: #111; font-weight: 600; text-decoration: none;
  }
</style>
</head>
<body>
  <h1>${xml(app.name)} can’t connect</h1>
  <p>It needs the internet to load. Check your connection, then try again.</p>
  <a class="btn" href="${xml(app.url)}">Try again</a>
</body>
</html>
`;
}

function infoPlist(app) {
  const u = app.usage;
  return {
    CAPACITOR_DEBUG: '$(CAPACITOR_DEBUG)',
    CFBundleDevelopmentRegion: 'en',
    CFBundleDisplayName: app.name,
    CFBundleExecutable: '$(EXECUTABLE_NAME)',
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: '$(PRODUCT_NAME)',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: '$(MARKETING_VERSION)',
    CFBundleVersion: '$(CURRENT_PROJECT_VERSION)',
    // HTTPS only, which is exempt: no export-compliance question per build.
    ITSAppUsesNonExemptEncryption: false,
    LSRequiresIPhoneOS: true,
    NSCameraUsageDescription: u.camera,
    ...(u.location ? { NSLocationWhenInUseUsageDescription: u.location } : {}),
    NSPhotoLibraryAddUsageDescription: u.photosAdd,
    NSPhotoLibraryUsageDescription: u.photos,
    UIApplicationSceneManifest: {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [{
          UISceneConfigurationName: 'Default Configuration',
          UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          UISceneStoryboardFile: 'Main',
        }],
      },
    },
    UILaunchStoryboardName: 'LaunchScreen',
    UIMainStoryboardFile: 'Main',
    UIRequiredDeviceCapabilities: ['arm64'],
    // The pages are phone layouts; every manifest that says so says portrait.
    UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait'],
    UIViewControllerBasedStatusBarAppearance: true,
  };
}

function entitlements(app) {
  const host = hostOf(app);
  return {
    'com.apple.developer.associated-domains': [
      // Links to the site open the app (each server's apple-app-site-association).
      `applinks:${host}`,
      // Saved passwords for the app's own sign-in form.
      `webcredentials:${host}`,
      // Passkeys: the shared account's relying party is the apex
      // (PASSKEY_RP_ID). Without this, Face ID sign-in fails in the web view.
      `webcredentials:${DOMAIN}`,
    ],
  };
}

function scheme() {
  const ref = `
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "504EC3031FED79650016851F"
               BuildableName = "App.app"
               BlueprintName = "App"
               ReferencedContainer = "container:App.xcodeproj">
            </BuildableReference>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1600"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">${ref}
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      shouldUseLaunchSchemeArgsEnv = "YES">
   </TestAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">${ref.replace(/^ {3}/gm, '')}
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction
      buildConfiguration = "Release"
      shouldUseLaunchSchemeArgsEnv = "YES"
      savedToolIdentifier = ""
      useCustomWorkingDirectory = "NO"
      debugDocumentVersioning = "YES">
   </ProfileAction>
   <AnalyzeAction
      buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
`;
}

/** Adds the template's Swift files and the entitlements to the Xcode project,
 *  and sets the build settings that differ from Capacitor's scaffold. */
function patchPbxproj(text, version) {
  const files = [
    { name: 'AppViewController.swift', type: 'sourcecode.swift', source: true },
    { name: 'ShellPlugin.swift', type: 'sourcecode.swift', source: true },
    { name: 'App.entitlements', type: 'text.plist.entitlements', source: false },
  ];
  for (const f of files) {
    const ref = xid(`fileref ${f.name}`);
    const build = xid(`buildfile ${f.name}`);
    if (!text.includes(`${ref} /* ${f.name} */ = {isa = PBXFileReference`)) {
      text = text.replace('/* End PBXFileReference section */',
        `\t\t${ref} /* ${f.name} */ = {isa = PBXFileReference; lastKnownFileType = ${f.type}; path = ${f.name}; sourceTree = "<group>"; };\n/* End PBXFileReference section */`);
      text = text.replace(/(504EC3061FED79650016851F \/\* App \*\/ = \{\s*isa = PBXGroup;\s*children = \(\n)/,
        `$1\t\t\t\t${ref} /* ${f.name} */,\n`);
    }
    if (f.source && !text.includes(`${build} /* ${f.name} in Sources */ = {isa = PBXBuildFile`)) {
      text = text.replace('/* End PBXBuildFile section */',
        `\t\t${build} /* ${f.name} in Sources */ = {isa = PBXBuildFile; fileRef = ${ref} /* ${f.name} */; };\n/* End PBXBuildFile section */`);
      text = text.replace(/(504EC3001FED79650016851F \/\* Sources \*\/ = \{\s*isa = PBXSourcesBuildPhase;\s*buildActionMask = \d+;\s*files = \(\n)/,
        `$1\t\t\t\t${build} /* ${f.name} in Sources */,\n`);
    }
  }

  // The App target's two configurations are the blocks with INFOPLIST_FILE.
  text = text.replace(/(\{\s*isa = XCBuildConfiguration;[^{}]*?buildSettings = \{)([^{}]*?INFOPLIST_FILE = App\/Info\.plist;[^{}]*?)(\};)/g, (all, head, settings, tail) => {
    const set = (s, key, value) => {
      const re = new RegExp(`(\\n\\t+)${key} = [^;]*;`);
      if (re.test(s)) return s.replace(re, `$1${key} = ${value};`);
      return s.replace(/(\n\t+)(INFOPLIST_FILE = )/, `$1${key} = ${value};$1$2`);
    };
    let s = settings;
    s = set(s, 'CODE_SIGN_ENTITLEMENTS', 'App/App.entitlements');
    s = set(s, 'MARKETING_VERSION', version);
    // iPhone only: the pages are phone layouts, and an iPad build would need
    // its own App Store screenshots.
    s = set(s, 'TARGETED_DEVICE_FAMILY', '1');
    return head + s + tail;
  });
  return text;
}

function launchStoryboard(text, brand) {
  const [r, g, b] = [1, 3, 5].map((i) => (parseInt(brand.slice(i, i + 2), 16) / 255).toFixed(4));
  return text
    .replace(/<color key="backgroundColor"[^>]*\/>/, `<color key="backgroundColor" red="${r}" green="${g}" blue="${b}" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>`);
}

function mainStoryboard(text) {
  // The scene delegate builds AppViewController in code; if the storyboard is
  // ever used instead, it should make the same controller.
  return text.replace('customClass="CAPBridgeViewController" customModule="Capacitor"', 'customClass="AppViewController" customModule="App" customModuleProvider="target"');
}

/* ------------------------------------------------------------------ *
 * One app, end to end
 * ------------------------------------------------------------------ */

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function generate(slug) {
  const app = { ...APPS[slug], slug };
  const dir = path.join(ROOT, slug);
  const pkgFile = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const version = pkg.version || '1.0.0';
  if (!/^\d+\.\d+(\.\d+)?$/.test(version)) throw new Error(`${slug}: version "${version}" is not 1.2 or 1.2.3`);
  console.log(`\n== ${slug} (${app.name} ${version}, ${app.bundleId})`);

  write(path.join(dir, 'capacitor.config.json'), JSON.stringify(capacitorConfig(app), null, 2) + '\n');
  write(path.join(dir, 'www', 'index.html'), offlinePage(app));

  const ios = path.join(dir, 'ios');
  if (!fs.existsSync(ios)) {
    execFileSync('npx', ['cap', 'add', 'ios'], { cwd: dir, stdio: 'inherit' });
  }
  const appDir = path.join(ios, 'App', 'App');

  // Native code, shared.
  for (const f of ['AppViewController.swift', 'ShellPlugin.swift', 'SceneDelegate.swift']) {
    fs.copyFileSync(path.join(ROOT, 'template', 'ios', f), path.join(appDir, f));
  }
  write(path.join(appDir, 'Info.plist'), plist(infoPlist(app)));
  write(path.join(appDir, 'App.entitlements'), plist(entitlements(app)));

  const pbx = path.join(ios, 'App', 'App.xcodeproj', 'project.pbxproj');
  write(pbx, patchPbxproj(fs.readFileSync(pbx, 'utf8'), version));
  write(path.join(ios, 'App', 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'App.xcscheme'), scheme());

  const launch = path.join(appDir, 'Base.lproj', 'LaunchScreen.storyboard');
  write(launch, launchStoryboard(fs.readFileSync(launch, 'utf8'), app.brand));
  const main = path.join(appDir, 'Base.lproj', 'Main.storyboard');
  write(main, mainStoryboard(fs.readFileSync(main, 'utf8')));

  // Icon: one 1024 universal image, which current Xcode turns into every size.
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  const iconSet = path.join(appDir, 'Assets.xcassets', 'AppIcon.appiconset');
  for (const f of fs.readdirSync(iconSet)) if (f.endsWith('.png')) fs.unlinkSync(path.join(iconSet, f));
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${app.brand}"/>${nested(fullBleed(svg), 0, 0, 1024)}</svg>`;
  write(path.join(iconSet, 'AppIcon-1024.png'), renderSvg(iconSvg, 1024));
  write(path.join(iconSet, 'Contents.json'), JSON.stringify({
    images: [{ filename: 'AppIcon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
    info: { author: 'xcode', version: 1 },
  }, null, 2) + '\n');

  // Splash: the brand colour, the tile in the middle. Drawn square and filled
  // to the screen, so the middle is what every phone shows.
  const S = 2732, T = 640;
  const splashSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}"><rect width="${S}" height="${S}" fill="${app.brand}"/>${nested(svg, (S - T) / 2, (S - T) / 2, T)}</svg>`;
  const splash = renderSvg(splashSvg, S);
  const splashSet = path.join(appDir, 'Assets.xcassets', 'Splash.imageset');
  for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) write(path.join(splashSet, f), splash);

  // Copies www and capacitor.config.json into the native project and writes
  // the Swift package list. CI runs the same command.
  execFileSync('npx', ['cap', 'sync', 'ios'], { cwd: dir, stdio: 'inherit' });
}

const only = process.argv.slice(2);
for (const slug of only.length ? only : Object.keys(APPS)) {
  if (!APPS[slug]) { console.error(`unknown app "${slug}" - one of ${Object.keys(APPS).join(', ')}`); process.exit(1); }
  generate(slug);
}
console.log('\nDone. Check with: npm run check');
