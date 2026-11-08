#!/usr/bin/env python3
"""Checks the five iPhone projects and their workflows without Xcode.

    cd mobile && npm run check        (or: python3 scripts/check.py)

Runs on Linux (where they are generated) and as the first step of the macOS
build in .github/workflows/ios.yml, so a malformed file fails in seconds rather
than twenty minutes into an archive. It checks what can be checked from text:
every plist round-trips through plistlib, the storyboards and scheme parse as
XML, the icons are opaque 1024px PNGs, the Xcode project's brackets balance
and it names the right bundle ID, entitlements and sources, and nothing
personal or account-specific (an email address, a Team ID) is in the folder.
It also holds the workflows (check_workflows): the build job's signing,
archive, upload and clean-up steps byte for byte, the read-only App Store
Connect guard in the plan job before any macOS job, check_only stopping
after it, Lab Pulse's permissions and push, and that no workflow prints a
secret. `npm run check` then runs scripts/test_pulse.py.
What it cannot check - that Swift compiles and the app signs - is the macOS
runner's job.
"""

import hashlib
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
        dirs[:] = [x for x in dirs if x not in ("node_modules", "public", ".git", "capacitor-cordova-ios-plugins", "__pycache__")]
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


WORKFLOWS = os.path.join(os.path.dirname(ROOT), ".github", "workflows")

# The build job's steps that sign, archive, export, upload and clean up, held
# byte for byte (sha256 of each step's YAML, as it was on 2026-11-08). The
# guard and check_only were added around them without touching them. A change
# to one of these is a change to how the apps are signed: make it on purpose,
# then put the new digest here.
HELD_STEPS = {
    "Version and build number": "072fb6c080929340302a8f01cafc41be184d60403ae05bce9fbc4d20178d9aee",
    "App Store Connect key": "d573d08dea7c817beaac6e789ac9babc7db3d66934baad287941b5a5aec58053",
    "Signing": "02b05b15d92ad001fe7bac0436bd321d9516435411552f6ac42811cbd2705288",
    "Archive": "b541b2ad1aac687df155b20d03d3f90e173b908b64ee5cb06e905cd2b91e34ad",
    "Upload to TestFlight": "92f2a9522a8f590119f4eb7bd425375ef220239ebe72b78c79fd3b2c7edbe127",
    "Revoke the CI certificate": "36b50fd8b492c5e88d8277afdbe37b55d19668792ffc335ce988a500223fedf4",
    "Remove the key": "b2e1d00c82257cb7778df9afac106a55e3e3d5527cdc1b02a95e18b174fc55ab",
}
SECRET_VARS = ("APPSTORE_KEY_P8", "APPSTORE_KEY_ID", "APPSTORE_ISSUER_ID", "APPLE_TEAM_ID", "GITHUB_TOKEN")


def wf_jobs(text):
    """{job id: [its lines]} for the top-level `jobs:` block (stdlib, no YAML)."""
    out, cur, inside = {}, None, False
    for line in text.split("\n"):
        if line == "jobs:":
            inside = True
            continue
        if inside:
            m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
            if m:
                cur = m.group(1)
                out[cur] = []
            elif cur is not None:
                out[cur].append(line)
    return out


def wf_steps(lines):
    """[(name, its YAML)] for one job's steps; a comment above a step is not part of it."""
    raw, cur = [], None
    for line in lines:
        if line.startswith("      - "):
            cur = [line]
            raw.append(cur)
        elif cur is not None and (line.startswith("        ") or not line.strip() or line.startswith("      #")):
            cur.append(line)
        else:
            cur = None
    steps = []
    for s in raw:
        while s and (not s[-1].strip() or s[-1].lstrip().startswith("#")):
            s.pop()
        m = re.match(r"^      - (?:name: (.+)|uses: (.+))$", s[0])
        steps.append(((m.group(1) or m.group(2)).strip() if m else s[0].strip(), "\n".join(s)))
    return steps


def job_value(lines, key):
    for line in lines:
        m = re.match(r"^    %s: (.+)$" % re.escape(key), line)
        if m:
            return m.group(1).strip()
    return None


def run_blocks(text):
    """The shell of every `run: |` block (and one-line `run:`), as lines."""
    blocks, cur, indent = [], None, 0
    for line in text.split("\n"):
        m = re.match(r"^(\s*)run: (.*)$", line)
        if m:
            if m.group(2).strip() == "|":
                cur, indent = [], len(m.group(1))
                blocks.append(cur)
            else:
                blocks.append([m.group(2)])
                cur = None
            continue
        if cur is not None:
            if line.strip() and len(line) - len(line.lstrip()) <= indent:
                cur = None
            else:
                cur.append(line)
    return blocks


def check_workflows():
    """ios.yml's guard and check_only, the held steps, Lab Pulse, and that no
    workflow prints a secret. Text checks, so they also run on the macOS runner."""
    print("== workflows")
    read = lambda f: open(os.path.join(WORKFLOWS, f)).read()  # noqa: E731
    ios = read("ios.yml")
    jobs = wf_jobs(ios)
    ok("ios.yml: a plan job and a build job", set(jobs) == {"plan", "build"}, sorted(jobs))
    plan, build = jobs.get("plan", []), jobs.get("build", [])
    built = dict(wf_steps(build))
    for name, digest in HELD_STEPS.items():
        got = hashlib.sha256(built.get(name, "").encode()).hexdigest()
        ok("ios.yml: build step '%s' is unchanged" % name, got == digest, got[:16])
    order = [n for n, _ in wf_steps(build)]
    ok("ios.yml: key, signing, archive, upload, revoke, remove, in that order",
       [n for n in order if n in HELD_STEPS] == list(HELD_STEPS), order)

    # The guard: on ubuntu, after the secrets check, before any macOS job.
    ok("ios.yml: plan runs on ubuntu", (job_value(plan, "runs-on") or "").startswith("ubuntu-"), job_value(plan, "runs-on"))
    names = [n for n, _ in wf_steps(plan)]
    guard = "App Store Connect answers (read-only)"
    ok("ios.yml: the guard comes after the secrets check and before the apps are picked",
       guard in names and names.index("Check the four secrets are set") < names.index(guard) < names.index("Pick the apps"), names)
    gstep = dict(wf_steps(plan)).get(guard, "")
    ok("ios.yml: the guard runs asc_read.py preflight", "scripts/asc_read.py preflight" in gstep)
    ok("ios.yml: the plan job removes its key copy, always",
       "rm -f \"$RUNNER_TEMP/AuthKey.p8\"" in dict(wf_steps(plan)).get("Remove the key", "")
       and "if: always()" in dict(wf_steps(plan)).get("Remove the key", ""))
    ok("ios.yml: the plan job is not skipped by check_only", job_value(plan, "if") is None)
    for jid, lines in jobs.items():
        if "macos" in (job_value(lines, "runs-on") or ""):
            ok("ios.yml: macOS job '%s' needs plan" % jid, job_value(lines, "needs") == "plan", job_value(lines, "needs"))
    ok("ios.yml: plan's name is the one pulse.py reads", job_value(plan, "name") == "Check secrets, pick apps", job_value(plan, "name"))
    ok("ios.yml: the matrix job is named by the app (pulse.py reads it)", job_value(build, "name") == "${{ matrix.app }}")
    ok("ios.yml: the monthly schedule pulse.py and /pulse assume", "    - cron: '23 9 1 * *'" in ios)

    # check_only: a boolean, off by default, and it stops after plan.
    m = re.search(r"\n      check_only:\n((?:        .*\n)+)", ios)
    body = m.group(1) if m else ""
    ok("ios.yml: check_only is a boolean input, default false",
       "type: boolean" in body and "default: false" in body, body)
    ok("ios.yml: check_only stops after the plan job", job_value(build, "if") == "${{ !inputs.check_only }}", job_value(build, "if"))
    ok("ios.yml: a check_only run says 'check only' in its title",
       re.search(r"^run-name: .*inputs\.check_only && '[^']*check only[^']*'", ios, re.M) is not None)
    tf = read("testflight-public.yml")
    ok("testflight-public.yml: does not follow a check_only run",
       "!contains(github.event.workflow_run.display_title, 'check only')" in tf)

    # The guard and the gatherer only read.
    for f in ("asc_read.py", "pulse.py"):
        src = open(os.path.join(ROOT, "scripts", f)).read()
        methods = re.findall(r"method=['\"](\w+)['\"]", src)
        ok("%s: only GET requests" % f, set(methods) <= {"GET"} and "data=" not in src and "asc_signing.api(" not in src, methods)
        ok("%s: prints no token, key or environment value" % f,
           not [l for l in src.split("\n") if "print(" in l and ("environ" in l or "token(" in l or "read_text" in l)])

    # Lab Pulse.
    pw = read("pulse.yml")
    pj = wf_jobs(pw)
    ok("pulse.yml: every three hours, and by hand", re.search(r"cron: '\d+ \*/3 \* \* \*'", pw) is not None and "workflow_dispatch:" in pw)
    ok("pulse.yml: workflow permissions are actions: read, contents: write",
       "\npermissions:\n  actions: read\n  contents: write\n" in pw)
    ok("pulse.yml: the job holding the key cannot write to the repo",
       "    permissions:\n      actions: read\n      contents: read\n" in "\n".join(pj.get("gather", [])))
    pub = "\n".join(pj.get("publish", []))
    ok("pulse.yml: publish checks the file and installs nothing",
       "pulse.py --check" in pub and "pip" not in pub and "npm" not in pub and "secrets." not in pub)
    ok("pulse.yml: pushes only the pulse-data branch",
       re.findall(r"git push[^\n]*", pw) == ["git push --force --quiet origin pulse-data"], re.findall(r"git push[^\n]*", pw))
    ok("pulse.yml: runs on ubuntu", all((job_value(l, "runs-on") or "").startswith("ubuntu-") for l in pj.values()))

    # Every workflow: current action majors, no secret printed, nothing personal.
    email = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}")
    for f in sorted(os.listdir(WORKFLOWS)):
        text = read(f)
        uses = re.findall(r"uses: (actions/(?:checkout|setup-node))@(\S+)", text)
        ok("%s: checkout and setup-node are v7 (Node 24)" % f, all(v == "v7" for _, v in uses), uses)
        printed = []
        for block in run_blocks(text):
            for line in block:
                if "${{ secrets." in line or re.search(r"\bset -[a-z]*x", line):
                    printed.append(line.strip())
                if re.match(r"^\s*(echo|printf|cat)\b", line) and any("$" + v in line or "${" + v in line for v in SECRET_VARS):
                    if not re.search(r"[|>]", line):
                        printed.append(line.strip())
        ok("%s: no secret is echoed (secrets only in env:, never printed)" % f, not printed, printed[:3])
        ok("%s: no email address or Team ID" % f,
           not email.search(text) and not re.search(r"\b[A-Z0-9]{10}\.com\.strongtechnicalconsulting\.", text))


for slug, (name, bundle, url) in APPS.items():
    check_app(slug, name, bundle, url)
check_workflows()
check_private()

print("\n%d passed, %d failed" % (passes, len(failures)))
sys.exit(1 if failures else 0)
