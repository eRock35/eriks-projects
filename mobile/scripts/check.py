#!/usr/bin/env python3
"""Checks the four iPhone projects without Xcode.

    cd mobile && npm run check        (or: python3 scripts/check.py)

Runs on Linux (where they are generated) and as the first step of the macOS
build in .github/workflows/ios.yml, so a malformed file fails in seconds rather
than twenty minutes into an archive. It checks what can be checked from text:
every plist round-trips through plistlib, the storyboards and scheme parse as
XML, the icons are opaque 1024px PNGs, the Xcode project's brackets balance
and it names the right bundle ID, entitlements and sources, and nothing
personal or account-specific (an email address, a Team ID) is in the folder.
What it cannot check - that Swift compiles and the app signs - is the macOS
runner's job.
"""

import json
import os
import plistlib
import re
import struct
import sys
import zlib
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOMAIN = "strongtechnicalconsulting.com"
APPS = {
    "trip": ("Trip Planner", "com.strongtechnicalconsulting.trip", "https://trip.%s/" % DOMAIN),
    "hopscotch": ("Hopscotch", "com.strongtechnicalconsulting.hopscotch", "https://beer.%s/" % DOMAIN),
    "flight": ("Flight", "com.strongtechnicalconsulting.flight", "https://challenge.%s/flight/" % DOMAIN),
    "football": ("Football", "com.strongtechnicalconsulting.football", "https://footballapp.%s/" % DOMAIN),
    "insidejoke": ("Inside Joke", "com.strongtechnicalconsulting.insidejoke", "https://challenge.%s/insidejoke/" % DOMAIN),
}
SWIFT = ["AppViewController.swift", "ShellPlugin.swift", "SceneDelegate.swift"]

failures = []
passes = 0


def ok(name, cond, extra=""):
    global passes
    if cond:
        passes += 1
    else:
        failures.append(name + ((" <- " + str(extra)) if extra else ""))
        print("  FAIL  " + name + ((" <- " + str(extra)) if extra else ""))


def roundtrip(path):
    """Load a plist, write it back, load it again: the same value both times."""
    try:
        with open(path, "rb") as f:
            value = plistlib.load(f)
    except Exception as e:  # noqa: BLE001 - any parse error is the finding
        print("  (%s: %s)" % (os.path.relpath(path, ROOT), e))
        return {}, False
    again = plistlib.loads(plistlib.dumps(value, fmt=plistlib.FMT_XML))
    return value, value == again


def png_info(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, ihdr, idat = 8, None, b""
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        (crc,) = struct.unpack(">I", data[pos + 8 + length:pos + 12 + length])
        if zlib.crc32(kind + body) & 0xFFFFFFFF != crc:
            raise ValueError("bad CRC in " + kind.decode())
        if kind == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    w, h, depth, colour = ihdr[0], ihdr[1], ihdr[2], ihdr[3]
    raw = zlib.decompress(idat)
    channels = {2: 3, 6: 4}.get(colour, 0)
    if channels and len(raw) != h * (w * channels * depth // 8 + 1):
        raise ValueError("pixel data is the wrong length")
    return w, h, depth, colour


def balanced(text):
    """Braces and parentheses balance outside quoted strings and comments."""
    depth = {"{": 0, "(": 0}
    pairs = {"}": "{", ")": "("}
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            i += 1
            while i < n and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
        elif text.startswith("/*", i):
            i = text.index("*/", i) + 1
        elif text.startswith("//", i):
            i = text.index("\n", i)
        elif c in depth:
            depth[c] += 1
        elif c in pairs:
            depth[pairs[c]] -= 1
            if depth[pairs[c]] < 0:
                return False
        i += 1
    return all(v == 0 for v in depth.values())


def check_app(slug, name, bundle, url):
    print("== " + slug)
    d = os.path.join(ROOT, slug)
    app = os.path.join(d, "ios", "App", "App")
    host = url.split("/")[2]

    # capacitor.config.json
    with open(os.path.join(d, "capacitor.config.json")) as f:
        cfg = json.load(f)
    ok(slug + ": appId", cfg.get("appId") == bundle, cfg.get("appId"))
    ok(slug + ": appName", cfg.get("appName") == name, cfg.get("appName"))
    server = cfg.get("server", {})
    ok(slug + ": server.url is the live site", server.get("url") == url, server.get("url"))
    ok(slug + ": allowNavigation is the app host plus the shared sign-in",
       server.get("allowNavigation") == [host, "*." + DOMAIN], server.get("allowNavigation"))
    ok(slug + ": no cleartext", not server.get("cleartext"))
    ok(slug + ": offline page exists", os.path.isfile(os.path.join(d, "www", server.get("errorPath", "-"))))
    ok(slug + ": every plugin phase 2 needs is installed",
       all(p in json.load(open(os.path.join(d, "package.json")))["dependencies"] for p in [
           "@capacitor/local-notifications", "@capacitor/share", "@capacitor/haptics", "@capacitor/browser",
           "@capacitor/app", "@capacitor/splash-screen", "@capacitor/status-bar"]))
    version = json.load(open(os.path.join(d, "package.json")))["version"]
    ok(slug + ": version is 1.2 or 1.2.3", re.fullmatch(r"\d+\.\d+(\.\d+)?", version) is not None, version)

    # Info.plist
    info, same = roundtrip(os.path.join(app, "Info.plist"))
    ok(slug + ": Info.plist round-trips", same)
    ok(slug + ": display name", info.get("CFBundleDisplayName") == name, info.get("CFBundleDisplayName"))
    ok(slug + ": bundle id comes from the build", info.get("CFBundleIdentifier") == "$(PRODUCT_BUNDLE_IDENTIFIER)")
    ok(slug + ": version and build come from the build",
       info.get("CFBundleShortVersionString") == "$(MARKETING_VERSION)" and info.get("CFBundleVersion") == "$(CURRENT_PROJECT_VERSION)")
    ok(slug + ": export compliance answered", info.get("ITSAppUsesNonExemptEncryption") is False)
    # Football takes no pictures, so it asks for no camera or library;
    # every app keeps "Add", without which Save Image crashes it.
    keys = ["NSPhotoLibraryAddUsageDescription"] + ([] if slug == "football" else ["NSCameraUsageDescription", "NSPhotoLibraryUsageDescription"])
    for key in keys:
        ok(slug + ": " + key, isinstance(info.get(key), str) and len(info[key]) > 30 and name in info[key], info.get(key))
    if slug == "football":
        ok(slug + ": no camera or library prompt it would never use",
           "NSCameraUsageDescription" not in info and "NSPhotoLibraryUsageDescription" not in info)
    if slug == "hopscotch":
        ok(slug + ": location text for Near me", name in str(info.get("NSLocationWhenInUseUsageDescription")))
    ok(slug + ": scene delegate", "SceneDelegate" in json.dumps(info.get("UIApplicationSceneManifest")))
    ok(slug + ": arm64", info.get("UIRequiredDeviceCapabilities") == ["arm64"])

    # Entitlements
    ent, same = roundtrip(os.path.join(app, "App.entitlements"))
    ok(slug + ": entitlements round-trip", same)
    ok(slug + ": associated domains", ent.get("com.apple.developer.associated-domains") == [
        "applinks:" + host, "webcredentials:" + host, "webcredentials:" + DOMAIN], ent)
    ok(slug + ": nothing else is entitled", list(ent) == ["com.apple.developer.associated-domains"], list(ent))

    for p in [os.path.join(d, "ios", "App", "App.xcodeproj", "project.xcworkspace", "xcshareddata", "IDEWorkspaceChecks.plist")]:
        ok(slug + ": " + os.path.basename(p) + " round-trips", roundtrip(p)[1])

    # XML that is not a plist
    for p in [os.path.join(app, "Base.lproj", "LaunchScreen.storyboard"),
              os.path.join(app, "Base.lproj", "Main.storyboard"),
              os.path.join(d, "ios", "App", "App.xcodeproj", "xcshareddata", "xcschemes", "App.xcscheme")]:
        try:
            ET.parse(p)
            ok(slug + ": " + os.path.basename(p) + " parses", True)
        except ET.ParseError as e:
            ok(slug + ": " + os.path.basename(p) + " parses", False, e)
    main = open(os.path.join(app, "Base.lproj", "Main.storyboard")).read()
    ok(slug + ": storyboard names AppViewController", 'customClass="AppViewController"' in main)

    # Images
    for rel, size in [("Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png", 1024),
                      ("Assets.xcassets/Splash.imageset/splash-2732x2732.png", 2732)]:
        try:
            w, h, depth, colour = png_info(os.path.join(app, rel))
            ok(slug + ": " + os.path.basename(rel) + " is %dpx" % size, (w, h) == (size, size), (w, h))
            ok(slug + ": " + os.path.basename(rel) + " has no alpha channel", colour == 2 and depth == 8, (depth, colour))
        except Exception as e:  # noqa: BLE001
            ok(slug + ": " + rel, False, e)
    for cat in ["AppIcon.appiconset", "Splash.imageset"]:
        contents = json.load(open(os.path.join(app, "Assets.xcassets", cat, "Contents.json")))
        files = [i.get("filename") for i in contents["images"]]
        ok(slug + ": " + cat + " lists only files that exist",
           files and all(os.path.isfile(os.path.join(app, "Assets.xcassets", cat, f)) for f in files), files)

    # The Xcode project
    pbx = open(os.path.join(d, "ios", "App", "App.xcodeproj", "project.pbxproj")).read()
    ok(slug + ": project.pbxproj brackets balance", balanced(pbx))
    ok(slug + ": bundle id in both configurations", pbx.count("PRODUCT_BUNDLE_IDENTIFIER = %s;" % bundle) == 2)
    ok(slug + ": entitlements in both configurations", pbx.count("CODE_SIGN_ENTITLEMENTS = App/App.entitlements;") == 2)
    ok(slug + ": marketing version matches package.json", pbx.count("MARKETING_VERSION = %s;" % version) == 2)
    ok(slug + ": iPhone only", pbx.count("TARGETED_DEVICE_FAMILY = 1;") == 2)
    ok(slug + ": automatic signing", pbx.count("CODE_SIGN_STYLE = Automatic;") == 2)
    ok(slug + ": no Team ID in the project", "DEVELOPMENT_TEAM" not in pbx)
    for f in ["AppViewController.swift", "ShellPlugin.swift"]:
        ok(slug + ": " + f + " is compiled", ("/* %s in Sources */," % f) in pbx and pbx.count("/* %s in Sources */" % f) == 2)
    for f in SWIFT:
        ok(slug + ": " + f + " matches the template",
           open(os.path.join(app, f)).read() == open(os.path.join(ROOT, "template", "ios", f)).read())
    pkg_swift = open(os.path.join(d, "ios", "App", "CapApp-SPM", "Package.swift")).read()
    ok(slug + ": Swift Package Manager, every plugin listed",
       all(("Capacitor" + p) in pkg_swift for p in ["App", "Browser", "Haptics", "LocalNotifications", "Share", "SplashScreen", "StatusBar"]))


def check_private():
    """Nothing personal or account-specific in a public folder."""
    email = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}")
    team = re.compile(r"\b[A-Z0-9]{10}\.com\.strongtechnicalconsulting\.")
    bad = []
    for base, dirs, files in os.walk(ROOT):
        # Skipped: installed packages, and what ios/.gitignore leaves out (sync output).
        dirs[:] = [x for x in dirs if x not in ("node_modules", "public", ".git", "capacitor-cordova-ios-plugins")]
        for f in files:
            if f.endswith((".png", ".jpg")):
                continue
            p = os.path.join(base, f)
            text = open(p, encoding="utf-8", errors="ignore").read()
            for m in email.finditer(text):
                bad.append("%s: %s" % (os.path.relpath(p, ROOT), m.group(0)))
            if team.search(text):
                bad.append("%s: a Team ID" % os.path.relpath(p, ROOT))
    ok("no email address or Team ID anywhere under mobile/", not bad, bad[:5])


for slug, (name, bundle, url) in APPS.items():
    check_app(slug, name, bundle, url)
check_private()

print("\n%d passed, %d failed" % (passes, len(failures)))
sys.exit(1 if failures else 0)
