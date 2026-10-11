/* Lanes - the rules. One file, run in two places: the page (window.LanesCore)
 * and the server and tests (require).
 *
 * Everything that decides a finding lives here and is pure and deterministic:
 * the same gather file gives the same collisions, shared state, duplicates
 * and merge order, in the same order, on every machine. Nothing here touches
 * the network or storage.
 *
 *   reading     createGatherParser, parseInput, createDiffParser, unquotePath
 *   the command gatherCommand
 *   classifying hotspotKind, migrationOf, isGenerated, LOCK_INSTALL
 *   checking    analyse -> collisions, matrix, shared, dupes, order, verdict
 *   planning    compileGlob, ownedSets, checkPlan, reserveMigrations, brief, allBriefs
 *   exports     toMarkdown, toJson
 *   the model   splitPayload, cleanProposal
 *
 * Paths, branch names, commit messages and diff lines are hostile: markup,
 * bidi overrides, control characters, very long lines. They are only ever
 * drawn through esc(), and every export escapes for its own format.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LanesCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    bytes: 80 * 1024 * 1024, // a gather file bigger than this is refused
    files: 50000,            // paths kept from git ls-files
    branches: 40,
    pathLen: 1000,
    nameLen: 120,
    commits: 500,            // commits kept per branch
    lineShow: 400,           // characters kept of a shown diff line
    hunkShow: 60,            // lines kept per hunk for display
    hunksShow: 40,           // hunks kept per file for display
    shownPerBranch: 20000,   // diff lines kept for display per branch
    runs: 20000,             // change runs kept per file
    symbolsPerBranch: 5000,
    tasks: 12,
    taskLen: 300,
    lanes: 12,
    globs: 30,
    globLen: 200,
    ruleLen: 240,
    aiPaths: 5000,
    aiDirs: 1500,
    aiHotspots: 300,
    pasteBranches: 20,
  };

  /* ---------------- text ---------------- */

  var CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF]/g;
  /** A string safe to show: control, bidi and zero-width characters removed, bounded. */
  function clean(v, max) {
    if (v === null || v === undefined) return '';
    var s = String(v).replace(/\t/g, ' ').replace(/[\r\n]+/g, ' ').replace(CTRL, '');
    var m = max || 500;
    return s.length > m ? s.slice(0, m - 1) + '…' : s;
  }
  /** HTML-escape, and drop control, bidi and zero-width characters: a branch
   *  name with a right-to-left override must not reorder the page around it. */
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(CTRL, '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtInt(n) {
    n = Math.round(Number(n) || 0);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function plural(n, one, many) { return fmtInt(n) + ' ' + (Number(n) === 1 ? one : (many || one + 's')); }
  function fnv(h, s) {
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= 10; return Math.imul(h, 16777619) >>> 0;
  }
  var FNV0 = 2166136261;
  function uniq(a) { var s = Object.create(null), out = []; a.forEach(function (x) { if (!s[x]) { s[x] = 1; out.push(x); } }); return out; }
  function basename(p) { var i = p.lastIndexOf('/'); return i === -1 ? p : p.slice(i + 1); }
  function dirname(p) { var i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); }
  function byName(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  /** A shell word: as is when plainly safe, else single-quoted. */
  function shq(s) {
    s = String(s);
    if (/^[A-Za-z0-9._/@+=:,-]+$/.test(s) && s.charAt(0) !== '-') return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  /* ---------------- paths ---------------- */

  /** git's C-style quoting ("caf\303\251.txt") back to the real name. */
  function unquotePath(s) {
    s = String(s);
    if (s.length < 2 || s.charAt(0) !== '"' || s.charAt(s.length - 1) !== '"') return s;
    var body = s.slice(1, -1), bytes = [], map = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
    for (var i = 0; i < body.length; i++) {
      var c = body.charAt(i);
      if (c === '\\' && i + 1 < body.length) {
        var d = body.charAt(i + 1);
        if (/[0-7]/.test(d)) { var oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))[0]; bytes.push(parseInt(oct, 8) & 255); i += oct.length; continue; }
        if (map[d] !== undefined) { bytes.push(map[d]); i++; continue; }
        bytes.push(92); continue;
      }
      var code = body.charCodeAt(i);
      if (code < 128) bytes.push(code);
      else { var enc = utf8(c); for (var k = 0; k < enc.length; k++) bytes.push(enc[k]); }
    }
    try { return new TextDecoder('utf-8').decode(new Uint8Array(bytes)); } catch (e) { return body; }
  }
  function utf8(c) { try { return Array.prototype.slice.call(new TextEncoder().encode(c)); } catch (e) { return [63]; } }

  /** A path as Lanes keeps it: unquoted, forward slashes, no ./, no
   *  control or bidi characters. '' when it is not a usable path. */
  function cleanPath(p) {
    var s = unquotePath(String(p || '').replace(/\r$/, '').trim());
    s = s.replace(CTRL, '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
    if (!s || s.length > LIMITS.pathLen || /[\n\r\t]/.test(s) || /(^|\/)\.\.(\/|$)/.test(s)) return '';
    return s;
  }
  function cleanBranch(n) {
    var s = String(n || '').replace(CTRL, '').trim().replace(/\s+/g, ' ');
    return s.length > LIMITS.nameLen ? s.slice(0, LIMITS.nameLen) : s;
  }

  /* ---------------- what a path is ---------------- */

  var LOCKFILES = {
    'package-lock.json': 'npm install', 'npm-shrinkwrap.json': 'npm install', 'yarn.lock': 'yarn install',
    'pnpm-lock.yaml': 'pnpm install', 'bun.lockb': 'bun install', 'bun.lock': 'bun install',
    'Gemfile.lock': 'bundle install', 'poetry.lock': 'poetry lock --no-update', 'Pipfile.lock': 'pipenv lock',
    'uv.lock': 'uv lock', 'Cargo.lock': 'cargo update --workspace', 'go.sum': 'go mod tidy',
    'composer.lock': 'composer update --lock', 'mix.lock': 'mix deps.get', 'Podfile.lock': 'pod install',
    'packages.lock.json': 'dotnet restore --force-evaluate', 'flake.lock': 'nix flake lock', 'pubspec.lock': 'dart pub get',
  };
  var MANIFESTS = /^(package\.json|pyproject\.toml|requirements(-[\w.-]+)?\.txt|Pipfile|Gemfile|go\.mod|Cargo\.toml|composer\.json|mix\.exs|build\.gradle(\.kts)?|pom\.xml|pubspec\.yaml|[\w.-]+\.csproj|setup\.py|setup\.cfg)$/;
  var GENERATED_PATH = [
    /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|node_modules|__generated__|generated)\//,
    /\.(min\.(js|css)|js\.map|css\.map|pb\.go|g\.dart|freezed\.dart|generated\.[a-z]+)$/i,
    /_pb2(_grpc)?\.pyi?$/,
    /(^|\/)__snapshots__\/|\.snap$/,
  ];
  var GENERATED_MARK = /@generated|DO NOT EDIT|Code generated .{0,80}DO NOT EDIT|\bauto-?generated\b|This file (is|was|has been) (automatically )?generated/i;
  var CI = /^(\.github\/workflows\/|\.gitlab-ci\.yml$|\.circleci\/|azure-pipelines\.ya?ml$|\.buildkite\/|bitbucket-pipelines\.yml$|\.travis\.yml$)|(^|\/)Jenkinsfile$/;
  var AGENT = /(^|\/)(CLAUDE|CLAUDE\.local|AGENTS|GEMINI)\.md$|(^|\/)\.cursorrules$|(^|\/)\.windsurfrules$|(^|\/)\.clinerules|^\.cursor\/rules\/|^\.github\/copilot-instructions\.md$|^\.claude\/|(^|\/)CONVENTIONS\.md$/;
  var CHANGELOG = /(^|\/)(CHANGELOG|CHANGES|HISTORY|RELEASES?|RELEASE_NOTES|NEWS)(\.(md|txt|rst|markdown))?$/i;
  var VERSIONFILE = /(^|\/)(VERSION|version\.txt|\.version)$/;
  var SCHEMA = /(^|\/)db\/(schema\.rb|structure\.sql)$|(^|\/)schema\.prisma$|(^|\/)migration_lock\.toml$/;
  var REGISTRY = /(^|\/)(routes?|router)\/index\.[cm]?[jt]sx?$|(^|\/)urls\.py$|(^|\/)config\/routes\.rb$|(^|\/)app\.module\.ts$|(^|\/)settings\.py$/;
  var CODE = /\.(m?[jt]sx?|cjs|py|rb|go|rs|java|kt|kts|cs|php|swift|scala|vue|svelte|ex|exs|dart|c|cc|cpp|h|hpp|m|mm)$/i;
  var TESTPATH = /(^|\/)(__tests__|tests?|spec|specs|e2e|__mocks__|fixtures?)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rb)$|(^|\/)test_[\w-]+\.py$/i;

  /** A migration file -> {scheme, dir, key, num, width, name} or null. */
  function migrationOf(path) {
    var m;
    if ((m = /^(.*\/)?db\/migrate\/(\d{14})_(\w+)\.rb$/.exec(path))) return { scheme: 'rails', dir: (m[1] || '') + 'db/migrate', key: m[2], num: null, width: 14, name: m[3] };
    if ((m = /^(.*\/)?migrations\/(\d{14})_([\w-]+)\/migration\.sql$/.exec(path))) return { scheme: 'prisma', dir: (m[1] || '') + 'migrations', key: m[2], num: null, width: 14, name: m[3] };
    if ((m = /^(.*\/)?(alembic|migrations)\/versions\/(\w+)\.py$/.exec(path))) return { scheme: 'alembic', dir: (m[1] || '') + m[2] + '/versions', key: m[3], num: null, width: 0, name: m[3] };
    if ((m = /^(.*\/)?migrations\/(\d{4})_(\w+)\.py$/.exec(path))) return { scheme: 'django', dir: (m[1] || '') + 'migrations', key: String(parseInt(m[2], 10)), num: parseInt(m[2], 10), width: 4, name: m[3] };
    if ((m = /^(.*\/)?V(\d+(?:[._]\d+)*)__([\w.-]+)\.sql$/.exec(path))) return { scheme: 'flyway', dir: (m[1] || '').replace(/\/$/, ''), key: m[2].replace(/_/g, '.').replace(/(^|\.)0+(\d)/g, '$1$2'), num: /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : null, width: m[2].length, name: m[3] };
    if ((m = /^(.*\/)?(migrations?|migrate)\/(\d{10,14})[_-]([\w.-]+)\.(c?m?[jt]s)$/.exec(path))) return { scheme: 'timestamp', dir: (m[1] || '') + m[2], key: m[3], num: null, width: m[3].length, name: m[4] };
    if ((m = /^(.*\/)?(\d{1,6})_([\w.-]+?)(\.up|\.down)?\.sql$/.exec(path))) {
      var dir = (m[1] || '').replace(/\/$/, '');
      if (m[2].length >= 10) return { scheme: 'timestamp', dir: dir, key: m[2], num: null, width: m[2].length, name: m[3] };
      return { scheme: 'sql', dir: dir, key: String(parseInt(m[2], 10)), num: parseInt(m[2], 10), width: m[2].length, name: m[3] };
    }
    return null;
  }
  function isGeneratedPath(p) { return GENERATED_PATH.some(function (re) { return re.test(p); }); }

  /** What kind of shared state a path is, or null. */
  function hotspotKind(p) {
    var b = basename(p);
    if (LOCKFILES[b]) return 'lockfile';
    if (isGeneratedPath(p)) return 'generated';
    if (migrationOf(p)) return 'migration';
    if (SCHEMA.test(p)) return 'schema';
    if (MANIFESTS.test(b)) return 'manifest';
    if (AGENT.test(p)) return 'agent';
    if (CI.test(p)) return 'ci';
    if (CHANGELOG.test(p)) return 'changelog';
    if (VERSIONFILE.test(p)) return 'version';
    if (REGISTRY.test(p)) return 'registry';
    return null;
  }
  var KIND_INFO = {
    lockfile: { icon: '🔒', title: 'Lockfile', plural: 'Lockfiles' },
    manifest: { icon: '📦', title: 'Dependency manifest', plural: 'Dependency manifests' },
    migration: { icon: '🗄️', title: 'Migrations', plural: 'Migrations' },
    schema: { icon: '🧬', title: 'Database schema', plural: 'Database schema files' },
    generated: { icon: '⚙️', title: 'Generated file', plural: 'Generated files' },
    ci: { icon: '🤖', title: 'CI config', plural: 'CI config' },
    agent: { icon: '📜', title: 'Agent instructions', plural: 'Agent instruction files' },
    changelog: { icon: '📰', title: 'Changelog', plural: 'Changelogs' },
    version: { icon: '🏷️', title: 'Version', plural: 'Version files' },
    registry: { icon: '🧭', title: 'Shared registry', plural: 'Shared registries' },
    deps: { icon: '📦', title: 'Dependencies', plural: 'Dependencies' },
  };

  /* ---------------- what an added line defines ---------------- */

  var SYM_RES = [
    /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/,
    /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{1,80})?=\s*(?:async\s+)?(?:function\b|\([^)]{0,200}\)\s*(?::[^=]{1,60})?=>|[A-Za-z_$][\w$]*\s*=>|(?:React\.)?(?:memo|forwardRef|useCallback)\s*\()/,
    /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:async\s+)?def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/,
    /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[([]/,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
    /^\s*(?:(?:public|private|protected|internal|static|final|sealed|abstract|data)\s+)+(?:class|interface|struct|record|enum)\s+([A-Z]\w*)/,
  ];
  var STOP = {};
  ('main init setup teardown handler handle render constructor default index test tests props state config options opts app run get set update create delete remove list load save up down change meta migration schema styles style router routes route client server db query data result response request req res err error logger log value values item items key keys name id type types args kwargs self cls call apply start stop reset close open read write parse format build make new use string str number num todo foo bar baz tmp temp helper helpers util utils wrapper component page layout children node event events callback cb fn func next prev then catch resolve reject module exports require default_ before after before_each after_each str repr eq hash iter len').split(' ').forEach(function (w) { STOP[w] = 1; });
  function symKey(name) { return String(name).toLowerCase().replace(/_/g, ''); }
  function definedName(line) {
    for (var i = 0; i < SYM_RES.length; i++) {
      var m = SYM_RES[i].exec(line);
      if (m) {
        var n = m[1];
        if (!n || n.length < 4 || /^__/.test(n) || STOP[symKey(n)] || STOP[n.toLowerCase()]) return null;
        return n;
      }
    }
    return null;
  }

  /* ---------------- dependency and version lines ---------------- */

  var NOT_DEP = { name: 1, version: 1, description: 1, main: 1, module: 1, types: 1, typings: 1, license: 1, type: 1, private: 1, author: 1, homepage: 1, repository: 1, engines: 1, packageManager: 1, node: 1, npm: 1, python: 1, edition: 1, 'rust-version': 1 };
  function depOf(file, line) {
    var b = basename(file), m;
    if (b === 'package.json' || b === 'composer.json') {
      m = /^\s*"(@?[a-z0-9][\w.\-/]*)"\s*:\s*"([^"]*)"\s*,?\s*$/i.exec(line);
      if (m && !NOT_DEP[m[1]] && /^([\^~><=]*\s*v?\d|\*$|latest$|workspace:|npm:|file:|link:|git|https?:|github:)/.test(m[2])) return { name: m[1], ver: m[2] };
      return null;
    }
    if (/^requirements/.test(b) || b === 'pyproject.toml' || b === 'setup.py' || b === 'setup.cfg' || b === 'Pipfile') {
      m = /^\s*['"]?([A-Za-z0-9][\w.\-[\]]*)\s*(==|>=|<=|~=|!=|>|<)\s*([\w.*+-]+)/.exec(line);
      if (m) return { name: m[1].toLowerCase(), ver: m[2] + m[3] };
      m = /^\s*([A-Za-z0-9][\w.-]*)\s*=\s*["']([\^~><=*\d][^"']*)["']\s*$/.exec(line);
      if (m && b !== 'setup.py' && !NOT_DEP[m[1]]) return { name: m[1].toLowerCase(), ver: m[2] };
      return null;
    }
    if (b === 'Gemfile') { m = /^\s*gem\s+['"]([\w.-]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/.exec(line); return m ? { name: m[1], ver: m[2] || '' } : null; }
    if (b === 'go.mod') { m = /^\s*(?:require\s+)?([\w.-]+\.[a-z]{2,}\/[\w.\-/]+)\s+(v[\w.+-]+)/.exec(line); return m ? { name: m[1], ver: m[2] } : null; }
    if (b === 'Cargo.toml') { m = /^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([\^~=<>]*\d[^"]*)"|\{[^}]*version\s*=\s*"([^"]+)")/.exec(line); return m && !NOT_DEP[m[1]] ? { name: m[1], ver: m[2] || m[3] || '' } : null; }
    return null;
  }
  function versionOf(file, line) {
    var b = basename(file), m;
    if (b === 'package.json' || b === 'composer.json') { m = /^\s*"version"\s*:\s*"([^"]{1,40})"/.exec(line); return m ? m[1] : null; }
    if (b === 'pyproject.toml' || b === 'Cargo.toml' || b === 'setup.cfg') { m = /^\s*version\s*=\s*["']?([\w.+-]{1,40})["']?\s*$/.exec(line); return m ? m[1] : null; }
    if (b === 'setup.py' || /(^|\/)(__init__|_version|version)\.py$/.test(file)) { m = /^\s*(?:__version__|version)\s*=\s*["']([\w.+-]{1,40})["']/.exec(line); return m ? m[1] : null; }
    if (VERSIONFILE.test(file)) { m = /^\s*v?(\d[\w.+-]{0,39})\s*$/.exec(line); return m ? m[1] : null; }
    if (b === 'pubspec.yaml' || b === 'Chart.yaml') { m = /^version:\s*["']?([\w.+-]{1,40})/.exec(line); return m ? m[1] : null; }
    return null;
  }

  /* ---------------- reading a diff ---------------- */

  function stripPrefix(p, pre) { return p.indexOf(pre) === 0 ? p.slice(pre.length) : p; }
  /** The two paths of "diff --git a/X b/Y" (quoted or not). */
  function gitHeaderPaths(rest) {
    var parts = [], s = rest;
    for (var k = 0; k < 2 && s; k++) {
      s = s.replace(/^\s+/, '');
      if (s.charAt(0) === '"') {
        var j = 1;
        while (j < s.length && !(s.charAt(j) === '"' && s.charAt(j - 1) !== '\\')) j++;
        parts.push(unquotePath(s.slice(0, j + 1))); s = s.slice(j + 1);
      } else if (k === 0) {
        if (s.indexOf('"') !== -1) { var q = s.indexOf(' "'); parts.push(s.slice(0, q)); s = s.slice(q); continue; }
        // a/P b/P: the symmetric split is the only safe one when P has spaces
        var n = s.length;
        if ((n - 5) % 2 === 0 && n > 5) {
          var p = (n - 5) / 2;
          if (s.slice(0, 2) === 'a/' && s.slice(p + 2, p + 5) === ' b/' && s.slice(2, p + 2) === s.slice(p + 5)) { parts.push(s.slice(0, p + 2)); parts.push(s.slice(p + 3)); s = ''; break; }
        }
        var at = s.lastIndexOf(' b/');
        if (at === -1) at = s.indexOf(' ');
        if (at === -1) { parts.push(s); s = ''; break; }
        parts.push(s.slice(0, at)); s = s.slice(at + 1);
      } else { parts.push(s.trim()); s = ''; }
    }
    return { a: parts[0] ? stripPrefix(parts[0], 'a/') : '', b: parts[1] ? stripPrefix(parts[1], 'b/') : '' };
  }
  function headerPath(rest) {
    var s = rest.replace(/\t.*$/, '').replace(/\s+$/, '');
    if (s === '/dev/null') return '/dev/null';
    return unquotePath(s);
  }

  /**
   * A streaming unified-diff reader: git's (`diff --git`, renames, binary,
   * modes) or a plain one (`--- x` / `+++ y`), with or without context
   * lines. For every file it keeps the CHANGE RUNS in base coordinates (the
   * form git's merge compares), a few lines of each hunk to show, the names
   * of definitions added, dependency and version edits, and whether the file
   * says it is generated. Never throws: a broken hunk is counted and skipped.
   */
  function createDiffParser() {
    var files = [];
    var f = null, h = null, run = null;
    var remOld = 0, remNew = 0, oldLine = 0, newLine = 0;
    var malformed = 0, shown = 0, skipBinary = false;

    function newFile() {
      endFile();
      f = { git: false, a: '', b: '', minus: '', plus: '', status: '', renameFrom: '', renameTo: '', binary: false, mode: false,
        hunks: [], runs: [], adds: 0, dels: 0, gen: false, defs: [], rmDefs: {}, deps: { add: {}, rm: {} }, ver: { from: null, to: null }, downRev: null, hunkCount: 0, classified: false };
    }
    function classify() {
      if (f.classified) return;
      f.classified = true;
      var p = pathOf(f);
      f._path = p;
      f.code = CODE.test(p) && !TESTPATH.test(p) && !isGeneratedPath(p) && !migrationOf(p);
      f.manifest = MANIFESTS.test(basename(p)) || VERSIONFILE.test(p) || /(^|\/)(__init__|_version|version)\.py$/.test(p) || /(^|\/)(pubspec\.yaml|Chart\.yaml)$/.test(p);
      f.alembic = (migrationOf(p) || {}).scheme === 'alembic';
    }
    function closeRun() {
      if (run) { if (f.runs.length < LIMITS.runs) f.runs.push(run); run = null; }
    }
    function endHunk() { closeRun(); h = null; remOld = remNew = 0; }
    function endFile() {
      if (!f) return;
      endHunk();
      var p = pathOf(f);
      if (p) {
        var status = f.status;
        if (!status) {
          // A rename is what git says it is ("rename from/to"), else differing
          // ---/+++ paths; the "diff --git" line only when there are neither.
          var renamed = f.renameFrom && f.renameTo ? f.renameFrom !== f.renameTo
            : f.minus && f.plus ? f.minus !== f.plus && f.minus !== '/dev/null' && f.plus !== '/dev/null'
              : Boolean(f.a && f.b && f.a !== f.b);
          status = renamed ? 'R' : 'M';
        }
        var oldPath = f.renameFrom || (f.minus && f.minus !== '/dev/null' ? f.minus : '') || f.a || p;
        var defs = f.defs.filter(function (d) { return !f.rmDefs[symKey(d.name)]; });
        var addDeps = [], rmDeps = [], chDeps = [];
        Object.keys(f.deps.add).forEach(function (k) { if (f.deps.rm[k] !== undefined) { if (f.deps.rm[k] !== f.deps.add[k]) chDeps.push({ name: k, from: f.deps.rm[k], to: f.deps.add[k] }); } else addDeps.push({ name: k, to: f.deps.add[k] }); });
        Object.keys(f.deps.rm).forEach(function (k) { if (f.deps.add[k] === undefined) rmDeps.push({ name: k, from: f.deps.rm[k] }); });
        files.push({
          path: cleanPath(p), oldPath: cleanPath(status === 'A' ? p : oldPath) || cleanPath(p), status: status, binary: f.binary,
          hunks: f.hunks, hunkCount: f.hunkCount, runs: f.runs, adds: f.adds, dels: f.dels,
          gen: f.gen || isGeneratedPath(p), defs: defs.slice(0, 500),
          deps: { added: addDeps, removed: rmDeps, changed: chDeps },
          version: f.ver.to !== null && f.ver.to !== f.ver.from ? { from: f.ver.from, to: f.ver.to } : null,
          downRev: f.downRev,
        });
      }
      f = null;
    }
    function pathOf(x) {
      if (x.status === 'D' || x.plus === '/dev/null') return x.renameFrom || (x.minus !== '/dev/null' && x.minus) || x.a || x.b;
      return x.renameTo || (x.plus && x.plus !== '/dev/null' ? x.plus : '') || x.b || x.a || (x.minus !== '/dev/null' ? x.minus : '');
    }
    function hunkLine(c, text) {
      if (!f.classified) classify();
      if (shown < LIMITS.shownPerBranch && h.keep && h.lines.length < LIMITS.hunkShow) {
        h.lines.push([c, text.length > LIMITS.lineShow ? text.slice(0, LIMITS.lineShow) + '…' : text]); shown++;
      } else if (h.keep) h.more++;
      if (!f.gen && f.hunkCount <= 3 && GENERATED_MARK.test(text.slice(0, 300))) f.gen = true;
      if (c === '-' || c === '+') {
        var t = text.length > 2000 ? text.slice(0, 2000) : text;
        if (f.code) {
          var n = definedName(t);
          if (n) {
            if (c === '-') f.rmDefs[symKey(n)] = 1;
            else if (f.defs.length < 2000) f.defs.push({ name: n, line: newLine - 1 });
          }
        }
        if (f.manifest) {
          var d = depOf(f._path, t);
          if (d) (c === '+' ? f.deps.add : f.deps.rm)[d.name] = d.ver;
          var v = versionOf(f._path, t);
          if (v !== null) { if (c === '+') f.ver.to = v; else f.ver.from = v; }
        }
        if (f.alembic && c === '+') {
          var m = /^\s*down_revision\b[^=]*=\s*['"]([\w]+)['"]/.exec(t);
          if (m) f.downRev = m[1];
        }
      }
    }
    function line(l) {
      if (h && (remOld > 0 || remNew > 0)) {
        var c = l.charAt(0);
        if (c === ' ' || l === '') {
          closeRun(); oldLine++; newLine++; remOld--; remNew--;
          hunkLine(' ', l.slice(1));
          if (remOld <= 0 && remNew <= 0) endHunk();
          return;
        }
        if (c === '-' && remOld > 0) {
          if (!run) run = { i: oldLine - 1, chg: 0, add: 0, h: FNV0 };
          run.chg++; oldLine++; remOld--; f.dels++;
          hunkLine('-', l.slice(1));
          if (remOld <= 0 && remNew <= 0) endHunk();
          return;
        }
        if (c === '+' && remNew > 0) {
          if (!run) run = { i: oldLine - 1, chg: 0, add: 0, h: FNV0 };
          run.add++; run.h = fnv(run.h, l.slice(1)); newLine++; remNew--; f.adds++;
          hunkLine('+', l.slice(1));
          if (remOld <= 0 && remNew <= 0) endHunk();
          return;
        }
        if (c === '\\') return;
        // The hunk ended before its header said: count it, read on as a header.
        malformed++;
        endHunk();
      }
      if (l.charAt(0) === '\\') return;
      if (l.indexOf('diff --git ') === 0) {
        newFile(); skipBinary = false; f.git = true;
        var ps = gitHeaderPaths(l.slice(11));
        f.a = ps.a; f.b = ps.b;
        return;
      }
      if (l.indexOf('diff --cc ') === 0 || l.indexOf('diff --combined ') === 0) { newFile(); skipBinary = false; f.a = f.b = unquotePath(l.replace(/^diff --(cc|combined) /, '')); return; }
      if (skipBinary) return;
      if (l.indexOf('--- ') === 0 && !(h)) {
        if (!f || f.hunkCount > 0 || f.minus || f.binary) newFile();
        f.minus = headerPath(l.slice(4));
        return;
      }
      if (l.indexOf('+++ ') === 0 && f && !h) {
        f.plus = headerPath(l.slice(4));
        if (!f.git) {
          if (f.minus !== '/dev/null' && f.plus !== '/dev/null' && /^a\//.test(f.minus) && /^b\//.test(f.plus)) { f.minus = f.minus.slice(2); f.plus = f.plus.slice(2); }
        } else {
          if (f.minus !== '/dev/null') f.minus = stripPrefix(f.minus, 'a/');
          if (f.plus !== '/dev/null') f.plus = stripPrefix(f.plus, 'b/');
        }
        if (f.minus === '/dev/null' && !f.status) f.status = 'A';
        if (f.plus === '/dev/null' && !f.status) f.status = 'D';
        return;
      }
      if (!f) { if (/^@@ /.test(l)) malformed++; return; }
      if (l.indexOf('new file mode') === 0) { f.status = 'A'; return; }
      if (l.indexOf('deleted file mode') === 0) { f.status = 'D'; return; }
      if (l.indexOf('rename from ') === 0 || l.indexOf('copy from ') === 0) { f.renameFrom = unquotePath(l.replace(/^(rename|copy) from /, '')); return; }
      if (l.indexOf('rename to ') === 0 || l.indexOf('copy to ') === 0) { f.renameTo = unquotePath(l.replace(/^(rename|copy) to /, '')); if (f.renameFrom && f.renameFrom !== f.renameTo && !f.status) f.status = 'R'; return; }
      if (l.indexOf('Binary files ') === 0) {
        f.binary = true;
        var bm = /^Binary files (.+) and (.+) differ$/.exec(l);
        if (bm) {
          if (bm[1] === '/dev/null') f.status = 'A';
          else if (bm[2] === '/dev/null') f.status = 'D';
        }
        return;
      }
      if (l.indexOf('GIT binary patch') === 0) { f.binary = true; skipBinary = true; return; }
      if (l.indexOf('@@ ') === 0) {
        var m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
        if (!m) { malformed++; return; }
        endHunk();
        var os = +m[1], oc = m[2] === undefined ? 1 : +m[2], ns = +m[3], nc = m[4] === undefined ? 1 : +m[4];
        if (oc > 1e7 || nc > 1e7) { malformed++; return; }
        f.hunkCount++;
        h = { os: os, oc: oc, ns: ns, nc: nc, lines: [], more: 0, keep: f.hunks.length < LIMITS.hunksShow };
        if (h.keep) f.hunks.push(h);
        remOld = oc; remNew = nc;
        oldLine = oc === 0 ? os + 1 : os;
        newLine = nc === 0 ? ns + 1 : ns;
        if (remOld === 0 && remNew === 0) endHunk();
        return;
      }
      if (/^(old|new) mode /.test(l)) { f.mode = true; return; }
      // index, similarity, anything else (a commit message in format-patch output): ignored
    }
    return {
      line: line,
      end: function () { endFile(); return { files: files, malformed: malformed }; },
    };
  }

  /* ---------------- reading the gather file ---------------- */

  var MARK = '#lanes';
  /**
   * The gather file, streamed: push() chunks in any size, end() for the
   * result. Sections: `#lanes v1 base=<ref>`, `#lanes files`, then per
   * branch `#lanes branch <name>`, `#lanes log`, `#lanes diff`, and
   * `#lanes end`. Anything unexpected is counted and skipped, never thrown.
   */
  function createGatherParser() {
    var st = { base: '', version: '', files: [], seen: Object.create(null), branches: [], warnings: [], header: false, ended: false, lines: 0, badLog: 0, unknown: 0, skippedPaths: 0, tooManyBranches: 0 };
    var section = null, cur = null, diff = null, carry = '', first = true;
    function finishBranch() {
      if (!cur) return;
      if (diff) { var r = diff.end(); cur.changes = r.files; cur.malformed += r.malformed; diff = null; }
      st.branches.push(cur); cur = null;
    }
    function line(l) {
      st.lines++;
      if (l.charCodeAt(l.length - 1) === 13) l = l.slice(0, -1);
      if (first) { l = l.replace(/^\uFEFF/, ''); if (l.trim()) first = false; else return; }
      if (l.indexOf(MARK) === 0 && (l.length === MARK.length || l.charAt(MARK.length) === ' ')) {
        var rest = l.slice(MARK.length + 1).trim();
        var word = rest.split(/\s+/)[0];
        if (/^v\d+$/.test(word)) {
          st.header = true; st.version = word;
          var bm = /\bbase=(\S+)/.exec(rest); if (bm) st.base = cleanBranch(bm[1]);
          return;
        }
        if (word === 'files') { finishBranch(); section = 'files'; return; }
        if (word === 'branch') {
          finishBranch();
          var name = cleanBranch(rest.slice(6));
          if (st.branches.length >= LIMITS.branches) { st.tooManyBranches++; section = 'skip'; return; }
          if (!name) { section = 'skip'; st.unknown++; return; }
          cur = { name: name, commits: [], changes: [], malformed: 0, hadLog: false, hadDiff: false };
          section = 'branch';
          return;
        }
        if (word === 'log') { section = cur ? 'log' : 'skip'; if (cur) cur.hadLog = true; return; }
        if (word === 'diff') { if (cur) { section = 'diff'; cur.hadDiff = true; diff = createDiffParser(); } else section = 'skip'; return; }
        if (word === 'end') { finishBranch(); section = null; st.ended = true; return; }
        st.unknown++; return;
      }
      if (section === 'files') {
        if (st.files.length >= LIMITS.files) { st.skippedPaths++; return; }
        var p = cleanPath(l);
        if (!p) { if (l.trim()) st.skippedPaths++; return; }
        if (!st.seen[p]) { st.seen[p] = 1; st.files.push(p); }
        return;
      }
      if (section === 'log') {
        if (!l.trim()) return;
        var parts = l.split('\t');
        if (parts.length < 2 || !/^[0-9a-f]{4,64}$/i.test(parts[0])) { st.badLog++; return; }
        if (cur.commits.length < LIMITS.commits) cur.commits.push({ sha: parts[0].toLowerCase(), author: clean(parts[1], 60), date: /^\d{4}-\d\d-\d\dT[\d:+\-Z.]+$/.test(parts[2] || '') ? parts[2] : '', subject: clean(parts.slice(3).join(' '), 160) });
        return;
      }
      if (section === 'diff') { diff.line(l); return; }
      // text before any section, or in a skipped one: ignored
    }
    return {
      push: function (chunk) {
        var s = carry + chunk, start = 0, i;
        while ((i = s.indexOf('\n', start)) !== -1) { line(s.slice(start, i)); start = i + 1; }
        carry = s.slice(start);
      },
      end: function () {
        if (carry) { line(carry); carry = ''; }
        finishBranch();
        if (st.header && !st.ended) st.warnings.push('The file stops before its end marker - it may have been cut off. What was there was read.');
        if (st.tooManyBranches) st.warnings.push('Only the first ' + LIMITS.branches + ' branches were read (' + plural(st.tooManyBranches, 'more was', 'more were') + ' skipped).');
        if (st.skippedPaths) st.warnings.push(plural(st.skippedPaths, 'path') + ' in the file list could not be read and ' + (st.skippedPaths === 1 ? 'was' : 'were') + ' skipped.');
        if (st.badLog) st.warnings.push(plural(st.badLog, 'commit line') + ' could not be read and ' + (st.badLog === 1 ? 'was' : 'were') + ' skipped.');
        if (st.unknown) st.warnings.push(plural(st.unknown, 'marker line') + ' were not understood and skipped.');
        var bad = 0;
        st.branches.forEach(function (b) { bad += b.malformed; });
        if (bad) st.warnings.push(plural(bad, 'diff hunk') + ' did not add up and ' + (bad === 1 ? 'was' : 'were') + ' read as far as it made sense.');
        var seenNames = Object.create(null);
        var branches = st.branches.filter(function (b) { if (seenNames[b.name]) return false; seenNames[b.name] = 1; return true; });
        if (branches.length < st.branches.length) st.warnings.push('A branch listed twice was read once.');
        return {
          kind: st.header ? 'gather' : 'unknown', base: st.base || 'main', files: st.files,
          branches: branches.map(finishBranchObject), warnings: st.warnings, stats: { lines: st.lines },
        };
      },
    };
  }
  function finishBranchObject(b) {
    var authors = uniq(b.commits.map(function (c) { return c.author; }).filter(Boolean));
    var adds = 0, dels = 0;
    b.changes.forEach(function (c) { adds += c.adds; dels += c.dels; });
    var dates = b.commits.map(function (c) { return c.date; }).filter(Boolean).sort();
    return { name: b.name, commits: b.commits, authors: authors, changes: b.changes, adds: adds, dels: dels, first: dates[0] || '', last: dates[dates.length - 1] || '', malformed: b.malformed };
  }

  /** Any text the person gives us: a gather file, one branch's diff, or a
   *  plain file list. */
  function parseInput(text) {
    var s = String(text || '');
    if (!s.trim()) return { kind: 'empty' };
    var p = createGatherParser(); p.push(s);
    var r = p.end();
    if (r.kind === 'gather') return r;
    if (/^(diff --git |--- \S|@@ -\d)/m.test(s) && /^(\+\+\+ |@@ -\d|Binary files |rename from )/m.test(s)) return { kind: 'diff', diff: parseDiff(s) };
    var files = [], seen = Object.create(null), skipped = 0;
    s.split(/\r?\n/).forEach(function (l, i) {
      if (i === 0) l = l.replace(/^\uFEFF/, '');
      if (!l.trim()) return;
      if (files.length >= LIMITS.files) { skipped++; return; }
      var c = cleanPath(l); if (!c) { skipped++; return; }
      if (!seen[c]) { seen[c] = 1; files.push(c); }
    });
    return { kind: 'files', files: files, skipped: skipped };
  }
  /** One branch's pasted diff -> {files, malformed}. */
  function parseDiff(text) {
    var d = createDiffParser();
    String(text || '').split('\n').forEach(function (l, i) { if (i === 0) l = l.replace(/^\uFEFF/, ''); d.line(l.charCodeAt(l.length - 1) === 13 ? l.slice(0, -1) : l); });
    return d.end();
  }
  /** A branch built from a pasted diff, in the gather file's shape. */
  function branchFromDiff(name, text) {
    var r = parseDiff(text);
    return finishBranchObject({ name: cleanBranch(name), commits: [], changes: r.files, malformed: r.malformed });
  }

  /* ---------------- the command ---------------- */

  var REF_OK = /^[A-Za-z0-9._/@+-]{1,120}$/;
  var PATTERN_OK = /^[A-Za-z0-9._/@+*?[\]-]{1,120}$/;
  /**
   * The one command the person runs in their repo. It reads git and writes
   * one text file: no network, nothing downloaded, nothing run from
   * anywhere else. {base, mode: 'pattern'|'list', pattern, branches, shell:
   * 'sh'|'ps', out} -> {command} or {error}.
   */
  function gatherCommand(o) {
    o = o || {};
    var base = String(o.base || 'main').trim();
    var out = String(o.out || 'lanes.txt').trim();
    if (!REF_OK.test(base) || base.charAt(0) === '-' || /\.\./.test(base)) return { error: 'The base branch can only use letters, numbers and . _ / @ + -' };
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(out)) return { error: 'The file name can only use letters, numbers and . _ -' };
    var list = null, pattern = '';
    if (o.mode === 'list') {
      list = String(Array.isArray(o.branches) ? o.branches.join(' ') : (o.branches || '')).split(/[\s,]+/).filter(Boolean);
      if (!list.length) return { error: 'Name at least one branch.' };
      if (list.length > LIMITS.branches) return { error: 'Up to ' + LIMITS.branches + ' branches at once.' };
      for (var i = 0; i < list.length; i++) if (!REF_OK.test(list[i]) || list[i].charAt(0) === '-' || /\.\./.test(list[i])) return { error: 'A branch name can only use letters, numbers and . _ / @ + -' };
    } else {
      pattern = String(o.pattern || 'agent/*').trim();
      if (!PATTERN_OK.test(pattern) || pattern.charAt(0) === '-' || /\.\./.test(pattern)) return { error: 'The pattern can only use letters, numbers, * ? and . _ / @ + -' };
    }
    var LOG = "--format='%h%x09%an%x09%aI%x09%s'";
    if (o.shell === 'ps') {
      var each = list ? '@(' + list.map(function (b) { return "'" + b + "'"; }).join(', ') + ')' : "(git for-each-ref --format='%(refname:short)' \"refs/heads/$P\" \"refs/remotes/$P\")";
      return { command: "$B='" + base + "'; " + (list ? '' : "$P='" + pattern + "'; ") +
        "& { \"#lanes v1 base=$B\"; '#lanes files'; git -c core.quotepath=off ls-files; " +
        'foreach ($b in ' + each + ') { "#lanes branch $b"; \'#lanes log\'; git log --no-color ' + LOG + ' "$B..$b"; ' +
        "'#lanes diff'; git -c core.quotepath=off diff --no-color --no-ext-diff --unified=0 -M \"$B...$b\" }; '#lanes end' } | Out-File -Encoding utf8 " + out };
    }
    var loop = list ? list.map(function (b) { return "'" + b + "'"; }).join(' ') : "$(git for-each-ref --format='%(refname:short)' \"refs/heads/$P\" \"refs/remotes/$P\")";
    return { command: "B='" + base + "'; " + (list ? '' : "P='" + pattern + "'; ") +
      "{ printf '%s\\n' \"#lanes v1 base=$B\" '#lanes files'; git -c core.quotepath=off ls-files; " +
      'for b in ' + loop + "; do printf '%s\\n' \"#lanes branch $b\" '#lanes log'; git log --no-color " + LOG + ' "$B..$b"; ' +
      "printf '%s\\n' '#lanes diff'; git -c core.quotepath=off diff --no-color --no-ext-diff --unified=0 -M \"$B...$b\"; done; printf '%s\\n' '#lanes end'; } > " + out };
  }

  /* ---------------- checking the branches ---------------- */

  /** Two change runs (base coordinates, git's merge form: i = first base
   *  line index, chg = base lines replaced; chg 0 = an insertion before line
   *  i). 'same' (identical edit), 'overlap' (a shared line, or one spot),
   *  'adjacent' (touching: git still calls it a conflict) or null. */
  function runRelation(a, b) {
    if (a.i === b.i && a.chg === b.chg && a.h === b.h && a.add === b.add) return 'same';
    var ae = a.i + a.chg, be = b.i + b.chg;
    if (ae < b.i || be < a.i) return null;
    if (a.chg > 0 && b.chg > 0 && a.i < be && b.i < ae) return 'overlap';
    if (a.chg === 0 && b.chg === 0 && a.i === b.i) return 'overlap';
    if (a.chg === 0 && b.chg > 0 && b.i < a.i && a.i < be) return 'overlap';
    if (b.chg === 0 && a.chg > 0 && a.i < b.i && b.i < ae) return 'overlap';
    return 'adjacent';
  }
  /** "lines 40-45" in the base file, 1-based, for people. */
  function runLabel(r) {
    if (r.chg === 0) return r.i === 0 ? 'adds at the top' : 'adds after line ' + r.i;
    return r.chg === 1 ? 'line ' + (r.i + 1) : 'lines ' + (r.i + 1) + '–' + (r.i + r.chg);
  }
  var SEVERITY = { overlap: 4, 'both-added': 4, 'delete-modify': 4, binary: 4, 'rename-rename': 4, adjacent: 3, rename: 1, clean: 1, same: 0 };
  var CONFLICT = { overlap: 1, adjacent: 1, 'both-added': 1, 'delete-modify': 1, binary: 1, 'rename-rename': 1 };
  var PAIR_TEXT = {
    overlap: 'Same lines changed - will conflict',
    adjacent: 'Touching lines - git calls this a conflict too',
    'both-added': 'Both add this file - will conflict',
    'delete-modify': 'One deletes it, one edits it - will conflict',
    binary: 'A binary file changed on both - git cannot merge it',
    'rename-rename': 'Renamed two different ways - will conflict',
    rename: 'Renamed on one, edited on the other - git usually follows the rename',
    clean: 'Different lines - should merge cleanly',
    same: 'The same change on both - git merges it',
  };

  function comparePair(x, y) {
    if (x.status === 'A' && y.status === 'A') {
      var same = x.runs.length === y.runs.length && x.runs.every(function (r, i) { return runRelation(r, y.runs[i]) === 'same'; }) && x.binary === y.binary && !x.binary;
      return { kind: same ? 'same' : 'both-added', spots: [] };
    }
    if (x.status === 'D' && y.status === 'D') return { kind: 'same', spots: [] };
    if (x.status === 'D' || y.status === 'D') return { kind: 'delete-modify', spots: [] };
    if (x.status === 'R' && y.status === 'R') {
      if (x.path !== y.path) return { kind: 'rename-rename', spots: [] };
      if (!x.runs.length && !y.runs.length) return { kind: 'same', spots: [] };
      return relRuns(x, y);
    }
    if ((x.binary && y.binary) && (x.status !== 'R' || y.status !== 'R')) return { kind: 'binary', spots: [] };
    var r = relRuns(x, y);
    if ((x.status === 'R' || y.status === 'R') && !CONFLICT[r.kind]) return { kind: 'rename', spots: r.spots };
    return r;
  }
  function relRuns(x, y) {
    var spots = [], worst = 'clean', allSame = x.runs.length > 0 && x.runs.length === y.runs.length;
    var j0 = 0;
    for (var i = 0; i < x.runs.length; i++) {
      var a = x.runs[i];
      while (j0 < y.runs.length && y.runs[j0].i + y.runs[j0].chg < a.i - 1) j0++;
      for (var j = j0; j < y.runs.length; j++) {
        var b = y.runs[j];
        if (b.i > a.i + a.chg + 1) break;
        var rel = runRelation(a, b);
        if (!rel) continue;
        if (rel !== 'same') { allSame = false; if (spots.length < 50) spots.push({ a: a, b: b, kind: rel }); if (SEVERITY[rel] > SEVERITY[worst]) worst = rel; }
      }
    }
    if (allSame) { for (var k = 0; k < x.runs.length; k++) if (runRelation(x.runs[k], y.runs[k]) !== 'same') { allSame = false; break; } }
    if (allSame && worst === 'clean') worst = 'same';
    return { kind: worst, spots: spots };
  }

  /** Collisions: every base path touched by 2+ branches, each pair judged. */
  function collisions(branches) {
    var byPath = Object.create(null), order = [];
    branches.forEach(function (b, bi) {
      b.changes.forEach(function (c) {
        var key = c.status === 'A' ? c.path : c.oldPath;
        if (!byPath[key]) { byPath[key] = []; order.push(key); }
        byPath[key].push({ bi: bi, c: c });
      });
    });
    var out = [];
    order.forEach(function (key) {
      var list = byPath[key];
      var bis = uniq(list.map(function (x) { return x.bi; }));
      if (bis.length < 2) return;
      var pairs = [];
      for (var i = 0; i < list.length; i++) for (var j = i + 1; j < list.length; j++) {
        if (list[i].bi === list[j].bi) continue;
        var r = comparePair(list[i].c, list[j].c);
        pairs.push({ a: list[i].bi, b: list[j].bi, kind: r.kind, spots: r.spots, text: PAIR_TEXT[r.kind] });
      }
      var worst = pairs.reduce(function (w, p) { return SEVERITY[p.kind] > SEVERITY[w] ? p.kind : w; }, 'same');
      out.push({ path: key, branches: bis, pairs: pairs, worst: worst, conflict: Boolean(CONFLICT[worst]), kind: hotspotKind(key), changes: list.map(function (x) { return { bi: x.bi, status: x.c.status, path: x.c.path, adds: x.c.adds, dels: x.c.dels }; }) });
    });
    // Worst first; among equals, code before lockfiles and other shared state.
    out.sort(function (p, q) { return (SEVERITY[q.worst] - SEVERITY[p.worst]) || ((p.kind ? 1 : 0) - (q.kind ? 1 : 0)) || (q.branches.length - p.branches.length) || byName(p.path, q.path); });
    return out;
  }

  /** Shared state: lockfiles, manifests and dependency edits, versions,
   *  migrations, schema, generated files, CI, agent instructions,
   *  changelogs, registries. */
  function sharedState(branches, files) {
    var items = [];
    var touch = Object.create(null), kinds = Object.create(null);
    branches.forEach(function (b, bi) {
      b.changes.forEach(function (c) {
        var k = c.gen ? 'generated' : hotspotKind(c.path);
        if (!k || k === 'migration') return;
        var key = k + '|' + c.path;
        if (!touch[key]) { touch[key] = { kind: k, path: c.path, branches: [] }; kinds[key] = 1; }
        if (touch[key].branches.indexOf(bi) === -1) touch[key].branches.push(bi);
      });
    });
    Object.keys(touch).forEach(function (key) {
      var t = touch[key], n = t.branches.length, info = KIND_INFO[t.kind];
      var sev = n >= 2 ? (t.kind === 'lockfile' ? 'clash' : 'warn') : (t.kind === 'generated' ? 'warn' : 'info');
      var detail, fix;
      if (t.kind === 'lockfile') {
        detail = n >= 2 ? 'Every branch that regenerates a lockfile rewrites it in its own way: it will conflict however the lines fall.' : 'Only one branch changes it. Fine, as long as it stays that way.';
        fix = 'Merge one of them, then on the others take the lockfile from main and regenerate it: `' + (LOCKFILES[basename(t.path)] || 'reinstall') + '`.';
      } else if (t.kind === 'generated') {
        detail = 'Written by a tool, not by hand' + (n >= 2 ? ' - and edited on ' + n + ' branches.' : '. A hand edit here is lost the next time it is regenerated.');
        fix = 'Change the source it is generated from and regenerate it after merging, instead of keeping hand edits.';
      } else if (t.kind === 'agent') {
        detail = n >= 2 ? 'Several agents rewrote the instructions every agent reads. The last merge wins, silently.' : 'One agent changed the instructions every agent reads.';
        fix = 'Review it like code: one owner, changes proposed in the PR description.';
      } else if (t.kind === 'ci') {
        detail = n >= 2 ? 'More than one branch changes how CI runs.' : 'One branch changes how CI runs.';
        fix = 'Let one person own CI changes; check the pipeline after each merge.';
      } else if (t.kind === 'changelog') {
        detail = n >= 2 ? 'Every branch adds its entry at the same spot near the top: a conflict every time.' : 'One branch adds a changelog entry.';
        fix = 'Write the entry in the PR description and add them all at release.';
      } else if (t.kind === 'schema') {
        detail = n >= 2 ? 'The schema file is regenerated by each migration, so each branch writes its own version.' : 'One branch changes the schema file.';
        fix = 'Merge one branch, then re-run the other\u2019s migrations on top and regenerate the schema file.';
      } else if (t.kind === 'manifest') {
        detail = n >= 2 ? 'More than one branch edits the dependency manifest.' : 'One branch edits the dependency manifest.';
        fix = 'Let one person add dependencies; ask for them in the PR description.';
      } else if (t.kind === 'registry') {
        detail = n >= 2 ? 'A shared list (routes, settings, modules) that every feature adds a line to.' : 'One branch adds to a shared list.';
        fix = 'Add your line at the end of the list and change nothing else in it.';
      } else {
        detail = n >= 2 ? 'More than one branch changes the version.' : 'One branch changes the version.';
        fix = 'Leave versions to the release.';
      }
      if (n < 2 && t.kind !== 'generated' && t.kind !== 'lockfile' && t.kind !== 'agent' && t.kind !== 'ci') return;
      items.push({ kind: t.kind, icon: info.icon, title: info.title, paths: [t.path], branches: t.branches, severity: sev, detail: detail, fix: fix });
    });

    // Dependencies and versions, read from the edited lines.
    var deps = Object.create(null), vers = Object.create(null);
    branches.forEach(function (b, bi) {
      b.changes.forEach(function (c) {
        var touched = c.deps.added.length + c.deps.changed.length + c.deps.removed.length;
        if (touched) { (deps[c.path] = deps[c.path] || []).push({ bi: bi, deps: c.deps }); }
        if (c.version) (vers[c.path] = vers[c.path] || []).push({ bi: bi, from: c.version.from, to: c.version.to });
      });
    });
    Object.keys(deps).forEach(function (p) {
      var list = deps[p];
      if (list.length < 2) return;
      var names = Object.create(null), clash = [];
      list.forEach(function (x) {
        x.deps.added.concat(x.deps.changed).forEach(function (d) {
          if (names[d.name] && names[d.name].bi !== x.bi && names[d.name].to !== d.to) clash.push(d.name);
          names[d.name] = { bi: x.bi, to: d.to };
        });
      });
      var parts = list.map(function (x) {
        var bits = [];
        if (x.deps.added.length) bits.push('adds ' + x.deps.added.map(function (d) { return d.name; }).slice(0, 6).join(', '));
        if (x.deps.changed.length) bits.push('changes ' + x.deps.changed.map(function (d) { return d.name + ' ' + d.from + ' → ' + d.to; }).slice(0, 4).join(', '));
        if (x.deps.removed.length) bits.push('removes ' + x.deps.removed.map(function (d) { return d.name; }).slice(0, 6).join(', '));
        return { bi: x.bi, text: bits.join('; ') };
      });
      items.push({ kind: 'deps', icon: '📦', title: 'Dependencies', paths: [p], branches: list.map(function (x) { return x.bi; }), severity: clash.length ? 'clash' : 'warn',
        detail: clash.length ? 'Both change ' + uniq(clash).join(', ') + ' - to different versions.' : 'Both add or change dependencies, so the lockfile will conflict even where this file does not.',
        each: parts, fix: 'Merge one branch, then install the other\u2019s dependencies on top and regenerate the lockfile.' });
    });
    Object.keys(vers).forEach(function (p) {
      var list = vers[p];
      if (list.length < 2) return;
      var tos = uniq(list.map(function (x) { return x.to; }));
      items.push({ kind: 'version', icon: '🏷️', title: 'Version bump', paths: [p], branches: list.map(function (x) { return x.bi; }), severity: 'clash',
        detail: tos.length === 1 ? 'Both claim version ' + tos[0] + ' - one release number for two changes.' : 'Each bumps the version its own way.',
        each: list.map(function (x) { return { bi: x.bi, text: (x.from || '?') + ' → ' + x.to }; }), fix: 'Leave the version to the release: drop the bump from all but one branch.' });
    });

    // Migrations: colliding numbers (or timestamps), and alembic heads.
    var mig = Object.create(null);
    branches.forEach(function (b, bi) {
      b.changes.forEach(function (c) {
        if (c.status !== 'A' && c.status !== 'R') return;
        var m = migrationOf(c.path);
        if (!m) return;
        var key = m.scheme === 'alembic' ? 'alembic|' + m.dir + '|' + (c.downRev || '?' + c.path) : m.scheme + '|' + m.dir + '|' + m.key;
        if (!mig[key]) mig[key] = { m: m, list: [] };
        if (!mig[key].list.some(function (x) { return x.bi === bi; })) mig[key].list.push({ bi: bi, path: c.path });
      });
    });
    Object.keys(mig).forEach(function (key) {
      var g = mig[key];
      if (g.list.length < 2) return;
      var label = g.m.scheme === 'alembic' ? 'two heads after ' + key.split('|')[2] : g.m.scheme === 'sql' || g.m.scheme === 'django' || (g.m.scheme === 'flyway' && g.m.num !== null) ? 'number ' + padNum(g.m.num, g.m.width) : g.m.key;
      items.push({ kind: 'migration', icon: '🗄️', title: 'Migration ' + (g.m.scheme === 'alembic' ? 'heads' : 'number clash'), paths: g.list.map(function (x) { return x.path; }), branches: g.list.map(function (x) { return x.bi; }), severity: 'clash', migration: { scheme: g.m.scheme, dir: g.m.dir, key: g.m.key, num: g.m.num, width: g.m.width },
        detail: g.m.scheme === 'alembic' ? 'Both new migrations follow ' + key.split('|')[2] + ': after merging, alembic has two heads.' : 'Both add migration ' + label + ' in ' + (g.m.dir || 'the root') + '. Whichever merges second has to be renumbered' + (g.m.scheme === 'django' ? ' (or given a merge migration)' : '') + '.',
        fix: g.m.scheme === 'alembic' ? 'Point the second migration\u2019s down_revision at the first one.' : 'Merge one, then renumber the other to the next free number.' });
    });

    // A manifest whose dependency or version edits were read says it better.
    items = items.filter(function (it) { return it.kind !== 'manifest' || !items.some(function (o) { return (o.kind === 'deps' || o.kind === 'version') && o.paths[0] === it.paths[0]; }); });
    var rank = { clash: 0, warn: 1, info: 2 };
    items.sort(function (p, q) { return (rank[p.severity] - rank[q.severity]) || (q.branches.length - p.branches.length) || byName(p.kind + p.paths[0], q.kind + q.paths[0]); });
    return items;
  }
  function padNum(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

  /** Duplicate work: the same definitions added on 2+ branches, and
   *  look-alike new files. */
  var STOP_STEMS = { index: 1, readme: 1, main: 1, mod: 1, init: 1, types: 1, type: 1, utils: 1, util: 1, helpers: 1, helper: 1, constants: 1, styles: 1, style: 1, config: 1, test: 1, spec: 1, setup: 1, package: 1, routes: 1, schema: 1, models: 1, model: 1, views: 1, view: 1, page: 1, layout: 1, app: 1, server: 1, client: 1, api: 1, gitkeep: 1, keep: 1, license: 1, changelog: 1 };
  function stemOf(p) { return basename(p).replace(/\.[^.]*$/, '').replace(/\.(test|spec|stories|module|d)$/i, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function lev1(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    var i = 0, j = 0, diff = 0;
    while (i < a.length && j < b.length) {
      if (a.charAt(i) === b.charAt(j)) { i++; j++; continue; }
      if (++diff > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return diff + (a.length - i) + (b.length - j) <= 1;
  }
  function duplicates(branches) {
    var syms = Object.create(null);
    branches.forEach(function (b, bi) {
      var n = 0;
      b.changes.forEach(function (c) {
        if (c.status === 'D' || c.gen) return;
        c.defs.forEach(function (d) {
          if (n++ > LIMITS.symbolsPerBranch) return;
          var k = symKey(d.name);
          (syms[k] = syms[k] || []).push({ bi: bi, name: d.name, path: c.path, line: d.line });
        });
      });
    });
    var symbols = [];
    Object.keys(syms).forEach(function (k) {
      var defs = syms[k];
      var bis = uniq(defs.map(function (d) { return d.bi; }));
      if (bis.length < 2) return;
      var one = bis.map(function (bi) { return defs.filter(function (d) { return d.bi === bi; })[0]; });
      symbols.push({ name: one[0].name, key: k, branches: bis, defs: one, samePath: uniq(one.map(function (d) { return d.path; })).length === 1 });
    });
    symbols.sort(function (p, q) { return (q.branches.length - p.branches.length) || byName(p.key, q.key); });

    var added = [];
    branches.forEach(function (b, bi) {
      b.changes.forEach(function (c) {
        if (c.status !== 'A' || c.gen || hotspotKind(c.path) || TESTPATH.test(c.path)) return;
        var s = stemOf(c.path);
        if (s.length < 4 || STOP_STEMS[s]) return;
        added.push({ bi: bi, path: c.path, stem: s });
      });
    });
    var files = [], seenPair = Object.create(null);
    for (var i = 0; i < added.length; i++) for (var j = i + 1; j < added.length; j++) {
      var x = added[i], y = added[j];
      if (x.bi === y.bi || x.path === y.path) continue;
      var why = null;
      if (x.stem === y.stem) why = 'same name';
      else {
        var sh = x.stem.length <= y.stem.length ? x.stem : y.stem, lo = sh === x.stem ? y.stem : x.stem;
        if ((sh.length >= 5 && lo.indexOf(sh) !== -1) || (sh.length >= 6 && lev1(sh, lo))) why = 'similar name';
      }
      if (!why) continue;
      var key = [x.bi + ':' + x.path, y.bi + ':' + y.path].sort().join('|');
      if (seenPair[key]) continue;
      seenPair[key] = 1;
      files.push({ a: { bi: x.bi, path: x.path }, b: { bi: y.bi, path: y.path }, why: why });
    }
    files.sort(function (p, q) { return (p.why === q.why ? 0 : p.why === 'same name' ? -1 : 1) || byName(p.a.path, q.a.path); });
    return { symbols: symbols.slice(0, 200), files: files.slice(0, 200) };
  }

  /* ---------------- merge order ---------------- */

  function mergeOrder(branches, cols, shared, dupes, base, files) {
    var n = branches.length;
    var edges = [];
    var key = function (i, j) { return i < j ? i + ',' + j : j + ',' + i; };
    var E = Object.create(null);
    function edge(i, j) { var k = key(i, j); if (!E[k]) { E[k] = { a: Math.min(i, j), b: Math.max(i, j), files: [], clashes: [] }; edges.push(E[k]); } return E[k]; }
    cols.forEach(function (c) {
      c.pairs.forEach(function (p) { if (CONFLICT[p.kind]) { var e = edge(p.a, p.b); if (e.files.indexOf(c.path) === -1) e.files.push(c.path); } });
    });
    shared.forEach(function (s) {
      if (s.severity !== 'clash') return;
      for (var i = 0; i < s.branches.length; i++) for (var j = i + 1; j < s.branches.length; j++) edge(s.branches[i], s.branches[j]).clashes.push(s);
    });
    // Contested size: lines a branch changed in files someone else also changed.
    var contested = new Array(n).fill(0), size = branches.map(function (b) { return b.adds + b.dels; });
    cols.forEach(function (c) { c.changes.forEach(function (x) { contested[x.bi] += x.adds + x.dels; }); });
    var deg = new Array(n).fill(0);
    edges.forEach(function (e) { deg[e.a]++; deg[e.b]++; });
    // Stacked branches: every commit of A is in B -> B was branched from A.
    var dep = branches.map(function () { return []; });
    branches.forEach(function (a, ai) {
      if (!a.commits.length) return;
      var shas = a.commits.map(function (c) { return c.sha; });
      branches.forEach(function (b, bi) {
        if (ai === bi || b.commits.length <= a.commits.length) return;
        var have = Object.create(null); b.commits.forEach(function (c) { have[c.sha] = 1; });
        if (shas.every(function (s) { return have[s]; })) dep[bi].push(ai);
      });
    });
    // Who resolves: the fewest branches that cover every conflicting pair
    // (a minimum vertex cover; the smaller contested change resolves on a tie).
    var colliding = []; for (var i = 0; i < n; i++) if (deg[i]) colliding.push(i);
    var cover = [];
    if (colliding.length && colliding.length <= 16) {
      var best = null;
      for (var mask = 1; mask < (1 << colliding.length); mask++) {
        var set = Object.create(null), cnt = 0, w = 0;
        for (var k = 0; k < colliding.length; k++) if (mask & (1 << k)) { set[colliding[k]] = 1; cnt++; w += contested[colliding[k]]; }
        if (best && cnt > best.cnt) continue;
        if (!edges.every(function (e) { return set[e.a] || set[e.b]; })) continue;
        // a branch that others depend on should not be the one that waits
        var depPenalty = 0; for (var q = 0; q < n; q++) dep[q].forEach(function (d) { if (set[d] && !set[q]) depPenalty++; });
        var score = [cnt, depPenalty, w];
        if (!best || score[0] < best.cnt || (score[0] === best.cnt && (score[1] < best.dp || (score[1] === best.dp && score[2] < best.w)))) best = { cnt: cnt, dp: depPenalty, w: w, set: set };
      }
      cover = Object.keys(best.set).map(Number);
    } else if (colliding.length) {
      var left = edges.slice(), inCover = Object.create(null);
      while (left.length) {
        var d2 = Object.create(null); left.forEach(function (e) { d2[e.a] = (d2[e.a] || 0) + 1; d2[e.b] = (d2[e.b] || 0) + 1; });
        var pick = Object.keys(d2).map(Number).sort(function (x, y) { return (d2[y] - d2[x]) || (contested[x] - contested[y]) || (x - y); })[0];
        inCover[pick] = 1; left = left.filter(function (e) { return e.a !== pick && e.b !== pick; });
      }
      cover = Object.keys(inCover).map(Number);
    }
    var inC = Object.create(null); cover.forEach(function (c) { inC[c] = 1; });
    var empty = [], clean = [], first = [], last = [];
    for (var b = 0; b < n; b++) {
      if (!branches[b].changes.length) empty.push(b);
      else if (!deg[b]) clean.push(b);
      else if (inC[b]) last.push(b);
      else first.push(b);
    }
    var nm = function (x) { return branches[x].name; };
    clean.sort(function (x, y) { return (size[x] - size[y]) || byName(nm(x), nm(y)); });
    first.sort(function (x, y) { return (contested[y] - contested[x]) || byName(nm(x), nm(y)); });
    last.sort(function (x, y) { return (contested[y] - contested[x]) || byName(nm(x), nm(y)); });
    var seq = clean.concat(first, last);
    // dependencies first, keeping the order otherwise
    var placed = [], done = Object.create(null), guard = 0;
    while (placed.length < seq.length && guard++ < 1000) {
      for (var s = 0; s < seq.length; s++) {
        var x = seq[s];
        if (done[x]) continue;
        if (dep[x].every(function (d) { return done[d] || seq.indexOf(d) === -1; })) { placed.push(x); done[x] = 1; break; }
      }
    }
    seq.forEach(function (x) { if (!done[x]) placed.push(x); });

    // next free migration numbers per folder, past everything any branch adds
    var maxNum = Object.create(null);
    (files || []).forEach(function (p) { var m = migrationOf(p); if (m && m.num !== null) { var k = m.scheme + '|' + m.dir; maxNum[k] = Math.max(maxNum[k] || 0, m.num); } });
    branches.forEach(function (br) { br.changes.forEach(function (c) { var m = migrationOf(c.path); if (m && m.num !== null) { var k = m.scheme + '|' + m.dir; maxNum[k] = Math.max(maxNum[k] || 0, m.num); } }); });

    var steps = [], merged = [];
    placed.forEach(function (bi) {
      var br = branches[bi];
      var against = merged.filter(function (m) { return E[key(m, bi)]; });
      var step = { branch: bi, name: br.name, action: against.length ? 'rebase' : 'merge', after: against, resolve: [], notes: [], commands: [] };
      if (!against.length) {
        var later = edges.filter(function (e) { return e.a === bi || e.b === bi; }).map(function (e) { return e.a === bi ? e.b : e.a; });
        step.why = !deg[bi] ? (merged.length ? 'Collides with nothing.' : 'Collides with nothing, so it goes in first.') :
          dep.some(function (d) { return d.indexOf(bi) !== -1; }) ? 'Other branches are built on it, so it goes in before them.' :
          'Collides with ' + later.map(nm).join(' and ') + ', which merge' + (later.length === 1 ? 's' : '') + ' later: this goes in as it is, and ' + (later.length === 1 ? 'that branch resolves' : 'they resolve') + ' the conflict on top' + (later.some(function (o) { return inC[o] && deg[o] > 1; }) ? ', all in one rebase.' : '.');
      } else {
        step.why = 'Collides with ' + against.map(nm).join(' and ') + ', which ' + (against.length === 1 ? 'is' : 'are') + ' already in: rebase it once and resolve everything together.';
      }
      var lockCmds = [], renames = [];
      against.forEach(function (m) {
        var e = E[key(m, bi)];
        e.files.forEach(function (p) {
          var col = cols.filter(function (c) { return c.path === p; })[0];
          var pair = col && col.pairs.filter(function (pp) { return (pp.a === m && pp.b === bi) || (pp.a === bi && pp.b === m); })[0];
          var lock = LOCKFILES[basename(p)];
          if (lock) { if (lockCmds.indexOf(p) === -1) lockCmds.push(p); return; }
          var where = pair && pair.spots.length ? pair.spots.slice(0, 3).map(function (s) { var mine = pair.a === bi ? s.a : s.b, theirs = pair.a === bi ? s.b : s.a; return 'this branch ' + runLabel(mine) + ', ' + nm(m) + ' ' + runLabel(theirs); }).join('; ') : '';
          var verClash = e.clashes.some(function (c) { return c.kind === 'version' && c.paths[0] === p; });
          step.resolve.push({ path: p, with: nm(m), kind: pair ? pair.kind : 'overlap', spots: where, text: (pair ? PAIR_TEXT[pair.kind] : 'Will conflict') + (where ? ' (' + where + ')' : '') + '. ' + (verClash ? 'Keep main\u2019s version line and both sides\u2019 other changes.' : pair && pair.kind === 'delete-modify' ? 'Decide whether the file stays.' : 'Keep both changes.') });
        });
        e.clashes.forEach(function (c) {
          if (c.kind === 'migration' && c.migration.num !== null) {
            var mine = c.paths.filter(function (p, i) { return c.branches[i] === bi; })[0];
            if (mine && renames.every(function (r) { return r.from !== mine; })) {
              var others = c.branches.filter(function (o) { return o !== bi && merged.indexOf(o) !== -1; }).map(nm);
              var mk = c.migration.scheme + '|' + c.migration.dir;
              maxNum[mk] = (maxNum[mk] || 0) + 1;
              var to = mine.replace(/(^|\/)(V?)0*(\d+)([_])(?=[^/]*$)/, function (all, pre, v, num, sep) { return pre + v + padNum(maxNum[mk], c.migration.width) + sep; });
              renames.push({ from: mine, to: to, after: others });
            }
          } else if (c.kind === 'migration') {
            step.notes.push('Migrations in ' + (c.migration.dir || 'the root') + ': ' + c.detail + ' ' + c.fix);
          } else if (c.kind === 'version') {
            step.notes.push(c.paths[0] + ': ' + nm(m) + ' already bumped the version. Keep main\u2019s and drop this branch\u2019s bump.');
          } else if (c.kind === 'lockfile') {
            if (lockCmds.indexOf(c.paths[0]) === -1) lockCmds.push(c.paths[0]);
          }
        });
      });
      // look-alike helpers already merged
      dupes.symbols.forEach(function (d) {
        if (d.branches.indexOf(bi) === -1) return;
        var earlier = d.branches.filter(function (o) { return merged.indexOf(o) !== -1; })[0];
        if (earlier === undefined) return;
        var theirs = d.defs.filter(function (x) { return x.bi === earlier; })[0], mine = d.defs.filter(function (x) { return x.bi === bi; })[0];
        step.notes.push(d.name + ' is already in from ' + nm(earlier) + ' (' + theirs.path + '). Use that one and delete this branch\u2019s copy in ' + mine.path + '.');
      });
      shared.forEach(function (s) {
        if (s.kind === 'generated' && s.branches.indexOf(bi) !== -1) step.notes.push(s.paths[0] + ' is generated: regenerate it after merging instead of keeping the hand edit.');
      });
      var q = shq(br.name), bq = shq(base);
      if (step.action === 'merge') {
        step.commands = ['git switch ' + bq, 'git pull --ff-only', 'git merge --no-ff ' + q];
      } else {
        step.commands = ['git switch ' + q, 'git rebase ' + bq];
        if (step.resolve.length) step.commands.push('# fix ' + uniq(step.resolve.map(function (r) { return r.path; })).join(', ') + ' then: git add <file> && git rebase --continue');
        lockCmds.forEach(function (p) {
          step.commands.push('# when it stops on ' + p + ': git checkout --ours ' + shq(p) + ' && git add ' + shq(p) + ' && git rebase --continue');
        });
        lockCmds.forEach(function (p) {
          var dir = dirname(p);
          step.commands.push((dir ? 'cd ' + shq(dir) + ' && ' : '') + (LOCKFILES[basename(p)] || 'reinstall') + (dir ? ' && cd -' : '') + ' && git commit -am ' + shq('Regenerate ' + basename(p)));
        });
        renames.forEach(function (r) {
          step.commands.push('git mv ' + shq(r.from) + ' ' + shq(r.to));
          step.commands.push('git commit -m ' + shq('Renumber migration ' + basename(r.from) + ' after ' + (r.after.length ? r.after : against.map(nm)).join(', ')));
        });
        step.commands.push('git push --force-with-lease');
        step.commands.push('git switch ' + bq + ' && git pull --ff-only && git merge --no-ff ' + q);
        step.locks = lockCmds;
        step.renames = renames;
      }
      steps.push(step);
      merged.push(bi);
    });
    empty.forEach(function (bi) { steps.push({ branch: bi, name: branches[bi].name, action: 'skip', after: [], resolve: [], notes: [], commands: [], why: 'No changes against ' + base + ' yet - nothing to merge.' }); });
    return { steps: steps, edges: edges.map(function (e) { return { a: e.a, b: e.b, files: e.files, clashes: e.clashes.map(function (c) { return c.kind; }) }; }), resolvers: cover, deps: dep };
  }

  /* ---------------- the whole check ---------------- */

  function analyse(parsed) {
    var branches = (parsed.branches || []).slice(0, LIMITS.branches);
    var base = parsed.base || 'main';
    var cols = collisions(branches);
    var shared = sharedState(branches, parsed.files || []);
    var dupes = duplicates(branches);
    var order = mergeOrder(branches, cols, shared, dupes, base, parsed.files || []);
    var n = branches.length;
    var matrix = [];
    for (var i = 0; i < n; i++) { matrix.push([]); for (var j = 0; j < n; j++) matrix[i].push({ shared: 0, conflicts: 0 }); }
    cols.forEach(function (c) {
      c.pairs.forEach(function (p) {
        var cellA = matrix[p.a][p.b], cellB = matrix[p.b][p.a];
        cellA.shared++; cellB.shared++;
        if (CONFLICT[p.kind]) { cellA.conflicts++; cellB.conflicts++; }
      });
    });
    var clashBy = branches.map(function () { return 0; });
    shared.forEach(function (s) { if (s.severity === 'clash') s.branches.forEach(function (b) { clashBy[b]++; }); });
    var conflictFiles = cols.filter(function (c) { return c.conflict; });
    var summaries = branches.map(function (b, bi) {
      var with_ = [];
      for (var j = 0; j < n; j++) if (j !== bi && (matrix[bi][j].conflicts || order.edges.some(function (e) { return (e.a === bi && e.b === j) || (e.b === bi && e.a === j); }))) with_.push(j);
      var dupN = dupes.symbols.filter(function (d) { return d.branches.indexOf(bi) !== -1; }).length + dupes.files.filter(function (d) { return d.a.bi === bi || d.b.bi === bi; }).length;
      var notes = shared.filter(function (s) { return s.branches.indexOf(bi) !== -1 && s.severity !== 'clash'; }).length;
      var state = !b.changes.length ? 'empty' : with_.length ? 'collides' : (dupN || notes) ? 'check' : 'clean';
      return { name: b.name, authors: b.authors, commits: b.commits.length, files: b.changes.length, adds: b.adds, dels: b.dels, collidesWith: with_, conflictFiles: conflictFiles.filter(function (c) { return c.branches.indexOf(bi) !== -1; }).length, clashes: clashBy[bi], dupes: dupN, notes: notes, state: state, last: b.last, subjects: b.commits.slice(0, 3).map(function (c) { return c.subject; }) };
    });
    var cleanN = summaries.filter(function (s) { return s.state === 'clean' || s.state === 'check'; }).length;
    var colliding = summaries.filter(function (s) { return s.state === 'collides'; }).length;
    var emptyN = summaries.filter(function (s) { return s.state === 'empty'; }).length;
    var migClash = shared.filter(function (s) { return s.kind === 'migration'; }).length;
    var parts = [];
    if (!n) parts.push('No branches to check');
    else {
      if (cleanN) parts.push(plural(cleanN, 'branch', 'branches') + ' merge' + (cleanN === 1 ? 's' : '') + ' clean');
      if (colliding) parts.push(fmtInt(colliding) + ' collide' + (colliding === 1 ? 's' : '') + (conflictFiles.length ? ' on ' + plural(conflictFiles.length, 'file') : ''));
      if (migClash) parts.push(plural(migClash, 'migration number clash', 'migration number clashes'));
      if (emptyN) parts.push(fmtInt(emptyN) + ' with no changes yet');
    }
    var sub = [];
    var lockClash = shared.filter(function (s) { return s.kind === 'lockfile' && s.severity === 'clash'; }).length;
    var verClash = shared.filter(function (s) { return s.kind === 'version'; }).length;
    if (lockClash) sub.push(plural(lockClash, 'lockfile') + ' changed on several branches');
    if (verClash) sub.push(plural(verClash, 'version bump clash', 'version bump clashes'));
    if (dupes.symbols.length) sub.push(plural(dupes.symbols.length, 'helper') + ' written twice');
    else if (dupes.files.length) sub.push(plural(dupes.files.length, 'look-alike new file'));
    var gen = shared.filter(function (s) { return s.kind === 'generated'; }).length;
    if (gen) sub.push(plural(gen, 'generated file') + ' edited by hand');
    var tone = !n ? 'none' : colliding || migClash ? 'collide' : (dupes.symbols.length || dupes.files.length || gen) ? 'check' : 'clean';
    return {
      base: base, branches: summaries, raw: branches, collisions: cols, matrix: matrix, shared: shared, dupes: dupes, order: order,
      verdict: { headline: parts.join(' · '), sub: sub.join(' · '), tone: tone, clean: cleanN, colliding: colliding, conflictFiles: conflictFiles.length, migrationClashes: migClash, empty: emptyN },
      fileCount: (parsed.files || []).length,
    };
  }

  /* ---------------- globs ---------------- */

  function expandBraces(s, depth) {
    var m = /\{([^{}]*)\}/.exec(s);
    if (!m || (depth || 0) > 4) return [s];
    var out = [];
    m[1].split(',').slice(0, 16).forEach(function (alt) { expandBraces(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length), (depth || 0) + 1).forEach(function (x) { if (out.length < 64) out.push(x); }); });
    return out;
  }
  function globBody(s) {
    var re = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '*') {
        if (s.charAt(i + 1) === '*') {
          var atStart = i === 0 || s.charAt(i - 1) === '/';
          if (atStart && s.charAt(i + 2) === '/') { re += '(?:.*/)?'; i += 2; continue; }
          if (atStart && i + 2 === s.length) { re += '.*'; i += 1; continue; }
          re += '[^/]*'; i += 1; continue;
        }
        re += '[^/]*'; continue;
      }
      if (c === '?') { re += '[^/]'; continue; }
      if (c === '[') {
        var j = s.indexOf(']', i + 2);
        if (j !== -1) {
          var cls = s.slice(i + 1, j).replace(/\\/g, '\\\\');
          if (cls.charAt(0) === '!') cls = '^' + cls.slice(1);
          re += '[' + cls + ']'; i = j; continue;
        }
      }
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return re;
  }
  /**
   * A path pattern, gitignore-style: `*` and `?` stay inside one folder,
   * `**` crosses folders, `[abc]` and `{a,b}` work, a pattern with no slash
   * matches at any depth, a folder matches everything under it, and a
   * leading `!` takes files back out. -> {src, neg, re, error}
   */
  function compileGlob(raw) {
    var src = String(raw === undefined || raw === null ? '' : raw).replace(CTRL, '').trim();
    var out = { src: src, neg: false, re: null, error: '' };
    if (!src) { out.error = 'Empty pattern'; return out; }
    if (src.length > LIMITS.globLen) { out.error = 'Too long'; return out; }
    var s = src;
    if (s.charAt(0) === '!') { out.neg = true; s = s.slice(1).trim(); }
    s = s.replace(/\\/g, '/').replace(/^\.\//, '');
    var anchored = s.charAt(0) === '/';
    s = s.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
    if (!s) { out.error = 'Empty pattern'; return out; }
    if (/(^|\/)\.\.(\/|$)/.test(s)) { out.error = 'No .. in patterns'; return out; }
    var alts = expandBraces(s);
    try {
      out.re = new RegExp('^(?:' + alts.map(function (a) {
        var lead = (a.indexOf('/') === -1 && !anchored) ? '(?:.*/)?' : '';
        return lead + globBody(a);
      }).join('|') + ')(?:/.*)?$');
    } catch (e) { out.error = 'Not a valid pattern'; out.re = null; }
    return out;
  }
  /** Files matched by a list of patterns (with ! taking them back): a Uint8Array mask. */
  function matchMask(globs, files) {
    var pos = [], neg = [];
    (globs || []).forEach(function (g) { var c = compileGlob(g); if (c.re) (c.neg ? neg : pos).push(c.re); });
    var mask = new Uint8Array(files.length);
    if (!pos.length) return mask;
    for (var i = 0; i < files.length; i++) {
      var f = files[i], hit = false;
      for (var a = 0; a < pos.length; a++) if (pos[a].test(f)) { hit = true; break; }
      if (hit) for (var b = 0; b < neg.length; b++) if (neg[b].test(f)) { hit = false; break; }
      if (hit) mask[i] = 1;
    }
    return mask;
  }
  function globCount(glob, files) {
    var c = compileGlob(glob);
    if (!c.re) return { count: 0, error: c.error, examples: [] };
    var n = 0, ex = [];
    for (var i = 0; i < files.length; i++) if (c.re.test(files[i])) { n++; if (ex.length < 5) ex.push(files[i]); }
    return { count: n, error: '', examples: ex };
  }

  /** The folder tree with file counts, for the picker. */
  function buildTree(files) {
    var dirs = Object.create(null);
    function node(d) { return dirs[d] || (dirs[d] = { dir: d, count: 0, dirs: [], files: [] }); }
    node('');
    files.forEach(function (p) {
      var parts = p.split('/'), acc = '';
      node('').count++;
      for (var i = 0; i < parts.length - 1; i++) {
        var parent = acc; acc = acc ? acc + '/' + parts[i] : parts[i];
        var nd = dirs[acc];
        if (!nd) { nd = node(acc); node(parent).dirs.push(acc); }
        nd.count++;
      }
      node(acc).files.push(p);
    });
    Object.keys(dirs).forEach(function (k) { dirs[k].dirs.sort(byName); dirs[k].files.sort(byName); });
    return dirs;
  }

  /* ---------------- planning the lanes ---------------- */

  var LANE_STOP = { add: 1, the: 1, a: 1, an: 1, to: 1, for: 1, with: 1, and: 1, of: 1, in: 1, on: 1, new: 1, make: 1, build: 1, implement: 1, fix: 1, update: 1, support: 1, create: 1, our: 1, my: 1, some: 1, from: 1, into: 1, it: 1, all: 1, by: 1, at: 1, be: 1, so: 1, that: 1, this: 1, page: 0 };
  function laneName(task, taken) {
    var words = String(task || '').toLowerCase().replace(CTRL, '').split(/\s+/).map(function (w) { return w.replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, ''); }).filter(function (w) { return w && !LANE_STOP[w]; });
    var name = words.slice(0, 2).join('-').slice(0, 30).replace(/-+$/, '') || 'lane';
    var out = name, k = 2;
    while (taken && taken.indexOf(out) !== -1) out = name + '-' + (k++);
    return out;
  }
  function slugName(s) { return String(s || '').toLowerCase().replace(CTRL, '').replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 30); }

  var DEFAULT_RULES = {
    lockfile: 'Only the lead touches {path}. Need a dependency? Ask for it in your PR description; never run an install that rewrites it.',
    manifest: 'Do not edit {path}. List any dependency you need in the PR description; the lead adds it.',
    migration: 'Only add migrations with your reserved number{s}. Never edit or renumber an existing migration.',
    schema: 'Do not edit {path} by hand; it is regenerated after merging.',
    generated: 'Never edit {path} by hand. Change its source; the lead regenerates it after merging.',
    agent: 'Read it, follow it, never edit it. Suggest changes in your PR description.',
    ci: 'Read-only. If CI needs a change, say so in the PR description.',
    changelog: 'Do not edit {path}. Write your entry in the PR description.',
    version: 'Do not bump the version. The lead does it at release.',
    registry: 'Shared: add your own line at the end of the list. Do not reorder, reformat or remove anything.',
  };

  /** Hotspots in a file list, grouped so a monorepo's 40 package.json do
   *  not become 40 rows: {key, kind, label, glob, files}. */
  function hotspots(files) {
    var groups = Object.create(null), list = [];
    files.forEach(function (p) {
      var k = hotspotKind(p);
      if (!k) return;
      var key, label, glob;
      if (k === 'migration') { var m = migrationOf(p); key = 'migration|' + m.dir; label = (m.dir ? m.dir + '/' : '') + (m.scheme === 'sql' || m.scheme === 'django' ? padNum(1, m.width).replace(/\d/g, 'N') + '_*' : '*'); glob = (m.dir ? m.dir + '/' : '') + '**'; if (m.scheme === 'sql' && !m.dir) glob = '[0-9]*_*.sql'; }
      else if (k === 'generated') { var gd = generatedDir(p); key = 'generated|' + gd; label = gd ? gd + '/' : p; glob = gd ? gd + '/**' : p; }
      else { key = k + '|' + p; label = p; glob = p; }
      if (!groups[key]) { groups[key] = { key: key, kind: k, label: label, glob: glob, files: [] }; list.push(groups[key]); }
      groups[key].files.push(p);
    });
    // many of one kind and name: one row per basename
    var counts = Object.create(null);
    list.forEach(function (g) { if (g.files.length === 1 && g.kind !== 'migration' && g.kind !== 'generated') { var c = g.kind + '|' + basename(g.files[0]); counts[c] = (counts[c] || 0) + 1; } });
    var merged = Object.create(null), out = [];
    list.forEach(function (g) {
      var c = g.files.length === 1 && g.kind !== 'migration' && g.kind !== 'generated' ? g.kind + '|' + basename(g.files[0]) : null;
      if (c && counts[c] > 6) {
        if (!merged[c]) { merged[c] = { key: c, kind: g.kind, label: '**/' + basename(g.files[0]), glob: basename(g.files[0]), files: [] }; out.push(merged[c]); }
        merged[c].files.push(g.files[0]);
      } else out.push(g);
    });
    var order = ['lockfile', 'manifest', 'migration', 'schema', 'agent', 'generated', 'ci', 'registry', 'changelog', 'version'];
    out.sort(function (a, b) { return (order.indexOf(a.kind) - order.indexOf(b.kind)) || byName(a.label, b.label); });
    return out.slice(0, 200);
  }
  function generatedDir(p) {
    var m = /^(.*?(?:^|\/)(?:dist|build|out|coverage|\.next|\.nuxt|node_modules|__generated__|generated|__snapshots__))\//.exec(p);
    return m ? m[1] : '';
  }

  /** Numbered migration folders and their next free number. */
  function migrationDirs(files) {
    var dirs = Object.create(null);
    files.forEach(function (p) {
      var m = migrationOf(p);
      if (!m) return;
      var k = m.scheme + '|' + m.dir;
      if (!dirs[k]) dirs[k] = { dir: m.dir, scheme: m.scheme, max: 0, width: m.width, count: 0 };
      dirs[k].count++;
      if (m.num !== null && m.num > dirs[k].max) dirs[k].max = m.num;
    });
    return Object.keys(dirs).map(function (k) { return dirs[k]; }).sort(function (a, b) { return (b.count - a.count) || byName(a.dir, b.dir); });
  }
  var DB_WORDS = /\b(db|database|migrations?|schema|tables?|columns?|models?|sql|postgres|mysql|sqlite|prisma|invoices?|sessions?|orders?|payments?|billing|accounts?|users?)\b/i;
  /** Migration numbers reserved per lane, in lane order, folder by folder. */
  function reserveMigrations(plan, files) {
    var dirs = migrationDirs(files).filter(function (d) { return d.scheme === 'sql' || d.scheme === 'django' || (d.scheme === 'flyway' && d.max); });
    var byLane = {};
    var ts = migrationDirs(files).filter(function (d) { return d.scheme === 'rails' || d.scheme === 'prisma' || d.scheme === 'timestamp' || d.scheme === 'alembic'; });
    if (!dirs.length) return { dirs: [], byLane: byLane, timestamped: ts };
    var next = dirs.map(function (d) { return d.max + 1; });
    (plan.lanes || []).forEach(function (l) {
      var want = l.migrations === null || l.migrations === undefined ? (DB_WORDS.test(l.task || '') ? 1 : 0) : Math.max(0, Math.min(5, Math.round(Number(l.migrations) || 0)));
      byLane[l.name] = [];
      for (var k = 0; k < want; k++) {
        dirs.forEach(function (d, di) { byLane[l.name].push({ dir: d.dir, number: padNum(next[di], d.width), scheme: d.scheme }); next[di]++; });
      }
    });
    return { dirs: dirs, byLane: byLane, timestamped: ts };
  }

  /** Lanes kept usable: names slugged and unique, tasks bounded, patterns cleaned. */
  function cleanPlan(v) {
    if (!v || typeof v !== 'object') return null;
    var lanes = [], taken = [];
    (Array.isArray(v.lanes) ? v.lanes : []).slice(0, LIMITS.lanes).forEach(function (l) {
      if (!l || typeof l !== 'object') return;
      var task = clean(l.task, LIMITS.taskLen).trim();
      var name = slugName(l.name) || laneName(task, taken);
      if (taken.indexOf(name) !== -1) name = laneName(name, taken);
      taken.push(name);
      var globs = function (a) { return uniq((Array.isArray(a) ? a : []).map(function (g) { return String(g === null || g === undefined ? '' : g).replace(CTRL, '').trim().slice(0, LIMITS.globLen); }).filter(function (g) { return g && !compileGlob(g).error; })).slice(0, LIMITS.globs); };
      var mig = l.migrations === null || l.migrations === undefined || l.migrations === '' ? null : Math.max(0, Math.min(5, Math.round(Number(l.migrations) || 0)));
      lanes.push({ name: name, task: task, owns: globs(l.owns), readOnly: globs(l.readOnly), notes: clean(l.notes, 300), migrations: mig });
    });
    var rules = {};
    if (v.rules && typeof v.rules === 'object') Object.keys(v.rules).slice(0, 300).forEach(function (k) { var t = clean(v.rules[k], LIMITS.ruleLen).trim(); if (t && k.length < 1200) rules[clean(k, 1100)] = t; });
    return {
      tasks: (Array.isArray(v.tasks) ? v.tasks : []).map(function (t) { return clean(t, LIMITS.taskLen).trim(); }).filter(Boolean).slice(0, LIMITS.tasks),
      lanes: lanes,
      base: REF_OK.test(String(v.base || '')) && !/\.\./.test(v.base) ? String(v.base) : 'main',
      prefix: /^[A-Za-z0-9._/-]{0,30}$/.test(String(v.prefix === undefined ? 'lane/' : v.prefix)) ? String(v.prefix === undefined ? 'lane/' : v.prefix) : 'lane/',
      repo: /^[A-Za-z0-9._-]{1,60}$/.test(String(v.repo || '')) ? String(v.repo) : 'app',
      lead: clean(v.lead || 'the lead', 40).trim() || 'the lead',
      rules: rules,
    };
  }
  function tasksToLanes(tasks, existing) {
    var lanes = [], taken = [];
    tasks.slice(0, LIMITS.lanes).forEach(function (t, i) {
      var old = existing && existing[i];
      var name = old && old.task === t ? old.name : laneName(t, taken);
      taken.push(name);
      lanes.push(old && old.task === t ? old : { name: name, task: t, owns: [], readOnly: [], notes: '', migrations: null });
    });
    return lanes;
  }

  /**
   * The plan, checked against the real tree: per lane what it owns (and
   * patterns that match nothing), every overlap between two lanes, the
   * hotspots and which lanes' patterns reach them, files no lane owns, and
   * reserved migration numbers.
   */
  function checkPlan(plan, files) {
    var p = cleanPlan(plan) || cleanPlan({});
    var masks = p.lanes.map(function (l) { return matchMask(l.owns, files); });
    var hs = hotspots(files);
    var hsFile = Object.create(null);
    hs.forEach(function (h, hi) { h.files.forEach(function (f) { hsFile[f] = hi; }); });
    var idx = Object.create(null); files.forEach(function (f, i) { idx[f] = i; });
    var known = knownDirs(files);
    var lanes = p.lanes.map(function (l, li) {
      var m = masks[li], n = 0, ex = [], hot = 0;
      for (var i = 0; i < files.length; i++) if (m[i]) { if (hsFile[files[i]] !== undefined) { hot++; continue; } n++; if (ex.length < 6) ex.push(files[i]); }
      var globs = l.owns.map(function (g) { var c = globCount(g, files); return { glob: g, count: c.count, neg: g.charAt(0) === '!', error: c.error, fresh: !c.count && isFreshPath(g, known, true) }; });
      var ro = l.readOnly.map(function (g) { var c = globCount(g, files); return { glob: g, count: c.count, error: c.error }; });
      return { name: l.name, owned: n, hotOwned: hot, examples: ex, globs: globs, readOnly: ro, empty: !l.owns.filter(function (g) { return g.charAt(0) !== '!'; }).length };
    });
    var overlaps = [];
    for (var a = 0; a < masks.length; a++) for (var b = a + 1; b < masks.length; b++) {
      var n2 = 0, ex2 = [];
      for (var i = 0; i < files.length; i++) if (masks[a][i] && masks[b][i] && hsFile[files[i]] === undefined) { n2++; if (ex2.length < 6) ex2.push(files[i]); }
      if (n2) overlaps.push({ a: a, b: b, count: n2, examples: ex2 });
    }
    var hot = hs.map(function (h) {
      var by = [];
      masks.forEach(function (m, li) { if (h.files.some(function (f) { return m[idx[f]]; })) by.push(li); });
      var rule = p.rules[h.key] || DEFAULT_RULES[h.kind].replace(/\{path\}/g, h.label).replace(/\{s\}/g, '');
      return { key: h.key, kind: h.kind, label: h.label, glob: h.glob, files: h.files.length, ownedBy: by, rule: rule, custom: Boolean(p.rules[h.key]) };
    });
    var owned = new Uint8Array(files.length);
    masks.forEach(function (m) { for (var i = 0; i < files.length; i++) if (m[i]) owned[i] = 1; });
    var unowned = 0; for (var u = 0; u < files.length; u++) if (!owned[u] && hsFile[files[u]] === undefined) unowned++;
    var reserve = reserveMigrations(p, files);
    // Patterns that match nothing yet are not problems: new code has no files.
    var problems = overlaps.length + hot.filter(function (h) { return h.ownedBy.length; }).length;
    return { plan: p, lanes: lanes, overlaps: overlaps, hotspots: hot, unowned: unowned, reserve: reserve, files: files.length, problems: problems };
  }

  /** A Markdown code span that survives backticks and pipes. */
  function mdCode(s) {
    var t = String(s === null || s === undefined ? '' : s).replace(CTRL, '').replace(/[\r\n]+/g, ' ');
    var ticks = 1; while (t.indexOf(new Array(ticks + 1).join('`')) !== -1) ticks++;
    var fence = new Array(ticks + 1).join('`');
    return fence + (ticks > 1 || /^`|`$/.test(t) ? ' ' + t + ' ' : t) + fence;
  }
  /** Prose for Markdown: no markup, no links, no headings from a name. */
  function mdText(s) {
    return String(s === null || s === undefined ? '' : s).replace(CTRL, '').replace(/[\r\n]+/g, ' ')
      .replace(/[\\`*_{}[\]()#+!|>~]/g, '\\$&').replace(/</g, '&lt;').replace(/^(\s*)([-=])/, '$1\\$2').replace(/^(\s*\d+)\./, '$1\\.');
  }
  /** Prose for a brief, which is pasted raw into an agent's first message:
   *  one line, no control or bidi characters, nothing that starts a block. */
  function mdPlain(s) {
    return String(s === null || s === undefined ? '' : s).replace(CTRL, '').replace(/[\r\n]+/g, ' ').replace(/^(\s*)([#>*+=|-]|\d+\.)/, '$1\\$2');
  }
  function fence(lines) {
    var body = lines.join('\n'), f = '```';
    while (body.indexOf(f) !== -1) f += '`';
    return f + (f.length === 3 ? 'sh' : '') + '\n' + body + '\n' + f;
  }
  function worktreeCmd(p, l) {
    var branch = p.prefix + l.name;
    return 'git worktree add -b ' + shq(branch) + ' ' + shq('../' + p.repo + '-' + l.name) + ' ' + shq(p.base);
  }

  /** One agent's brief, as Markdown to paste into its first message. */
  function brief(planOrCheck, li, files) {
    var ck = planOrCheck && planOrCheck.lanes && planOrCheck.hotspots ? planOrCheck : checkPlan(planOrCheck, files || []);
    var p = ck.plan, l = p.lanes[li], info = ck.lanes[li];
    if (!l) return '';
    var out = [];
    out.push('# Lane: ' + mdPlain(l.name));
    out.push('');
    out.push('You are one of ' + p.lanes.length + ' agents working on this repo at the same time, each in its own branch and folder. Stay inside your lane so the work merges without conflicts.');
    out.push('');
    out.push('**Branch:** ' + mdCode(p.prefix + l.name) + ' from ' + mdCode(p.base) + '  ');
    out.push('**Worktree:** ' + mdCode('../' + p.repo + '-' + l.name));
    out.push('');
    out.push(fence([worktreeCmd(p, l)]));
    out.push('');
    out.push('## Your task');
    out.push('');
    out.push(mdPlain(l.task || '(no task written yet)'));
    if (l.notes) { out.push(''); out.push(mdPlain(l.notes)); }
    out.push('');
    out.push('## You own these paths (edit freely)');
    out.push('');
    var pos = info.globs.filter(function (g) { return !g.neg; }), neg = info.globs.filter(function (g) { return g.neg; });
    if (!pos.length) out.push('- Nothing yet. Ask before editing any file.');
    pos.forEach(function (g) { out.push('- ' + mdCode(g.glob) + ' (' + (g.count ? plural(g.count, 'file') : g.fresh ? 'new' : 'no files yet') + ')'); });
    neg.forEach(function (g) { out.push('- except ' + mdCode(g.glob.slice(1))); });
    if (info.hotOwned) out.push('- except the shared files below, even where your paths include them');
    out.push('');
    out.push('## Read-only (read, never edit)');
    out.push('');
    info.readOnly.forEach(function (g) { out.push('- ' + mdCode(g.glob)); });
    p.lanes.forEach(function (o, oi) {
      if (oi === li || !o.owns.length) return;
      out.push('- ' + o.owns.filter(function (g) { return g.charAt(0) !== '!'; }).map(mdCode).join(', ') + ': lane ' + mdPlain(o.name) + ' (working on it right now)');
    });
    out.push('- Everything else not listed under "You own". If you need to change something there, stop and say so in your PR description.');
    var hs = ck.hotspots;
    if (hs.length) {
      out.push('');
      out.push('## Shared files: the rules');
      out.push('');
      hs.slice(0, 40).forEach(function (h) { out.push('- ' + mdCode(h.label) + ': ' + mdPlain(h.rule)); });
      if (hs.length > 40) out.push('- and ' + plural(hs.length - 40, 'more shared file') + ': leave them alone.');
    }
    var res = ck.reserve.byLane[l.name] || [];
    if (ck.reserve.dirs.length) {
      out.push('');
      out.push('## Migrations');
      out.push('');
      if (res.length) res.forEach(function (r) { out.push('- Use number ' + mdCode(r.number) + ' in ' + mdCode((r.dir || '.') + '/') + ' and no other. Another lane may be using the next one.'); });
      else out.push('- This lane has no migration number. If you need a migration, stop and ask for one.');
    } else if (ck.reserve.timestamped.length) {
      out.push('');
      out.push('## Migrations');
      out.push('');
      out.push('- Create migrations with the project\u2019s own generator (timestamped), never by copying one. Do not edit the schema file by hand.');
    }
    out.push('');
    out.push('## Before you open the PR');
    out.push('');
    out.push('- Run the tests and the linter.');
    out.push('- Check ' + mdCode('git diff --stat ' + p.base + '...HEAD') + ': every file should be inside your paths.');
    out.push('- Put anything you needed from a shared file (a dependency, a changelog line, a CI change) in the PR description instead.');
    out.push('- Do not merge ' + mdCode(p.base) + ' into your branch; ' + mdPlain(p.lead) + ' merges in order.');
    return out.join('\n') + '\n';
  }
  function allBriefs(plan, files) {
    var ck = checkPlan(plan, files || []);
    var p = ck.plan;
    var head = ['# Lanes: ' + plural(p.lanes.length, 'agent') + ' in parallel', '', 'Base branch ' + mdCode(p.base) + ' · ' + plural(ck.files, 'file') + ' in the tree · made with Lanes, on this device.', '', '## Set up every worktree', '', fence(p.lanes.map(function (l) { return worktreeCmd(p, l); })), ''];
    if (ck.overlaps.length) {
      head.push('> Warning: ' + plural(ck.overlaps.length, 'pair') + ' of lanes overlap - ' + ck.overlaps.map(function (o) { return mdPlain(p.lanes[o.a].name) + ' and ' + mdPlain(p.lanes[o.b].name) + ' (' + plural(o.count, 'file') + ')'; }).join('; ') + '.');
      head.push('');
    }
    return head.join('\n') + p.lanes.map(function (_, i) { return '\n---\n\n' + brief(ck, i); }).join('');
  }

  /* ---------------- exports ---------------- */

  function toJson(ck) {
    var nm = function (i) { return ck.branches[i].name; };
    return JSON.stringify({
      lanes: 'v1', base: ck.base, verdict: { headline: ck.verdict.headline, detail: ck.verdict.sub },
      branches: ck.branches.map(function (b) { return { name: b.name, authors: b.authors, commits: b.commits, files: b.files, added: b.adds, removed: b.dels, state: b.state, collidesWith: b.collidesWith.map(nm) }; }),
      collisions: ck.collisions.map(function (c) {
        return { path: c.path, conflict: c.conflict, worst: c.worst, branches: c.branches.map(nm), pairs: c.pairs.map(function (p) { return { a: nm(p.a), b: nm(p.b), kind: p.kind, spots: p.spots.slice(0, 10).map(function (s) { return { a: runLabel(s.a), b: runLabel(s.b), kind: s.kind }; }) }; }) };
      }),
      shared: ck.shared.map(function (s) { return { kind: s.kind, severity: s.severity, paths: s.paths, branches: s.branches.map(nm), detail: s.detail, fix: s.fix }; }),
      duplicates: {
        helpers: ck.dupes.symbols.map(function (d) { return { name: d.name, where: d.defs.map(function (x) { return { branch: nm(x.bi), path: x.path, line: x.line }; }) }; }),
        files: ck.dupes.files.map(function (d) { return { why: d.why, a: { branch: nm(d.a.bi), path: d.a.path }, b: { branch: nm(d.b.bi), path: d.b.path } }; }),
      },
      mergeOrder: ck.order.steps.map(function (s, i) { return { step: i + 1, branch: s.name, action: s.action, why: s.why, resolve: s.resolve.map(function (r) { return { path: r.path, with: r.with, kind: r.kind }; }), notes: s.notes, commands: s.commands }; }),
    }, null, 2);
  }
  function toMarkdown(ck) {
    var nm = function (i) { return ck.branches[i].name; };
    var cell = function (s) { return String(s).replace(/\|/g, '\\|'); };
    var o = [];
    o.push('# Lanes check: ' + plural(ck.branches.length, 'branch', 'branches') + ' against ' + mdCode(ck.base));
    o.push('');
    o.push('**' + mdText(ck.verdict.headline) + '**' + (ck.verdict.sub ? '  ' : ''));
    if (ck.verdict.sub) o.push(mdText(ck.verdict.sub));
    o.push('');
    o.push('| Branch | By | Commits | Files | +/- | State |');
    o.push('|---|---|---:|---:|---:|---|');
    ck.branches.forEach(function (b) {
      var st = b.state === 'collides' ? 'Collides with ' + b.collidesWith.map(nm).join(', ') : b.state === 'clean' ? 'Clean' : b.state === 'empty' ? 'No changes' : 'Merges clean, check notes';
      o.push('| ' + cell(mdCode(b.name)) + ' | ' + cell(mdText(b.authors.join(', ') || '-')) + ' | ' + b.commits + ' | ' + b.files + ' | +' + b.adds + ' / -' + b.dels + ' | ' + cell(mdText(st)) + ' |');
    });
    o.push('');
    o.push('## Collisions');
    o.push('');
    if (!ck.collisions.length) o.push('No file is changed on more than one branch.');
    ck.collisions.forEach(function (c) {
      o.push('- ' + (c.conflict ? '**Conflict**' : 'Clean') + ' ' + mdCode(c.path) + ': ' + c.pairs.map(function (p) {
        return mdCode(nm(p.a)) + ' × ' + mdCode(nm(p.b)) + ': ' + mdText(PAIR_TEXT[p.kind]) + (p.spots.length ? ' (' + p.spots.slice(0, 3).map(function (s) { return mdText(runLabel(s.a) + ' / ' + runLabel(s.b)); }).join('; ') + ')' : '');
      }).join('; '));
    });
    o.push('');
    o.push('## Shared state');
    o.push('');
    if (!ck.shared.length) o.push('Nothing shared is changed by more than one branch.');
    ck.shared.forEach(function (s) {
      o.push('- ' + (s.severity === 'clash' ? '**' + mdText(s.title) + '**' : mdText(s.title)) + ' ' + s.paths.map(mdCode).join(', ') + ' (' + s.branches.map(function (b) { return mdCode(nm(b)); }).join(', ') + '): ' + mdText(s.detail) + ' ' + mdText(s.fix));
    });
    o.push('');
    o.push('## Duplicate work');
    o.push('');
    if (!ck.dupes.symbols.length && !ck.dupes.files.length) o.push('No helper or new file looks written twice.');
    ck.dupes.symbols.forEach(function (d) { o.push('- ' + mdCode(d.name) + ' is added on ' + d.defs.map(function (x) { return mdCode(nm(x.bi)) + ' in ' + mdCode(x.path); }).join(' and ')); });
    ck.dupes.files.forEach(function (d) { o.push('- Look-alike new files (' + d.why + '): ' + mdCode(d.a.path) + ' on ' + mdCode(nm(d.a.bi)) + ', ' + mdCode(d.b.path) + ' on ' + mdCode(nm(d.b.bi))); });
    o.push('');
    o.push('## Merge order');
    o.push('');
    ck.order.steps.forEach(function (s, i) {
      o.push((i + 1) + '. ' + (s.action === 'rebase' ? 'Rebase ' : s.action === 'skip' ? 'Skip ' : 'Merge ') + mdCode(s.name) + ': ' + mdText(s.why));
      s.resolve.forEach(function (r) { o.push('   - ' + mdCode(r.path) + ' (with ' + mdCode(r.with) + '): ' + mdText(r.text)); });
      s.notes.forEach(function (n) { o.push('   - ' + mdText(n)); });
      if (s.commands.length) { o.push(''); o.push(fence(s.commands).split('\n').map(function (l) { return '   ' + l; }).join('\n')); o.push(''); }
    });
    o.push('');
    o.push('_Paths, line numbers and branch names only - no code. Made with Lanes, on this device._');
    return o.join('\n') + '\n';
  }

  /* ---------------- the model ---------------- */

  /** What "Split this into lanes for me" sends: the tasks and file PATHS -
   *  never a diff or file contents. Past aiPaths, the tree goes as folder
   *  counts plus the shared files by name. */
  function splitPayload(tasks, files) {
    var t = (tasks || []).map(function (x) { return clean(x, LIMITS.taskLen).trim(); }).filter(Boolean).slice(0, LIMITS.tasks);
    var fs = (files || []).filter(function (p) { return typeof p === 'string' && cleanPath(p) === p; });
    if (fs.length <= LIMITS.aiPaths) return { tasks: t, paths: fs.slice(), dirs: [], total: fs.length };
    var tree = buildTree(fs), depthOf = function (d) { return d ? d.split('/').length : 0; };
    var all = Object.keys(tree).filter(Boolean);
    var maxD = 1;
    for (var d = 1; d < 12; d++) { if (all.filter(function (x) { return depthOf(x) <= d; }).length > LIMITS.aiDirs) break; maxD = d; }
    var dirs = all.filter(function (x) { return depthOf(x) <= maxD; }).sort(byName).slice(0, LIMITS.aiDirs).map(function (x) { return { dir: x, files: tree[x].count }; });
    var hot = fs.filter(function (p) { return hotspotKind(p) && hotspotKind(p) !== 'generated' && hotspotKind(p) !== 'migration'; }).slice(0, LIMITS.aiHotspots);
    var rootFiles = tree[''].files.slice(0, 300);
    return { tasks: t, paths: uniq(rootFiles.concat(hot)).slice(0, LIMITS.aiPaths), dirs: dirs, total: fs.length };
  }
  /** The model's proposal, kept only where it is real: every pattern must
   *  match at least one file in the tree, names are slugged and unique,
   *  text is bounded and stripped. -> {lanes, hotspots, dropped} or null. */
  function cleanProposal(raw, files, dirs) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.lanes)) return null;
    var dropped = [], taken = [];
    var dirPaths = (dirs || []).map(function (d) { return (d && d.dir ? d.dir : '') + '/'; });
    var known = knownDirs(files, dirs);
    function real(g) {
      var c = compileGlob(g);
      if (!c.re) return false;
      for (var i = 0; i < files.length; i++) if (c.re.test(files[i])) return true;
      for (var j = 0; j < dirPaths.length; j++) if (c.re.test(dirPaths[j] + 'x') || c.re.test(dirPaths[j].slice(0, -1))) return true;
      return isFreshPath(g, known);
    }
    var lanes = raw.lanes.slice(0, LIMITS.lanes).map(function (l) {
      if (!l || typeof l !== 'object') return null;
      var task = clean(stripMarkup(l.task), LIMITS.taskLen).trim();
      var name = slugName(stripMarkup(l.name)) || laneName(task, taken);
      if (taken.indexOf(name) !== -1) name = laneName(name, taken);
      taken.push(name);
      var keep = function (list, what) {
        return uniq((Array.isArray(list) ? list : []).slice(0, 60).filter(function (g) { return typeof g === 'string'; }).map(function (g) { return g.replace(CTRL, '').trim().slice(0, LIMITS.globLen + 1); }).filter(function (g) {
          if (!g) return false;
          if (g.length > LIMITS.globLen || compileGlob(g).error || /[<>]/.test(g)) { dropped.push({ lane: name, glob: clean(stripMarkup(g), 80), why: 'not a valid pattern' }); return false; }
          if (g.charAt(0) !== '!' && !real(g)) { dropped.push({ lane: name, glob: clean(g, 120), why: 'matches no file' }); return false; }
          return true;
        })).slice(0, LIMITS.globs);
      };
      return { name: name, task: task, owns: keep(l.owns, 'owns'), readOnly: keep(l.readOnly, 'readOnly'), notes: clean(stripMarkup(l.notes), 300).trim(), migrations: null };
    }).filter(function (l) { return l && (l.task || l.owns.length); });
    var hs = (Array.isArray(raw.hotspots) ? raw.hotspots : []).slice(0, 60).map(function (h) {
      if (!h || typeof h !== 'object' || typeof h.path !== 'string') return null;
      var p = h.path.replace(CTRL, '').trim().slice(0, LIMITS.globLen);
      var rule = clean(stripMarkup(h.rule), LIMITS.ruleLen).trim();
      if (!p || !rule || !real(p)) return null;
      return { path: p, rule: rule };
    }).filter(Boolean);
    if (!lanes.length) return null;
    return { lanes: lanes, hotspots: hs, dropped: dropped.slice(0, 50) };
  }
  /** Every folder in the tree (and in a folder summary). */
  function knownDirs(files, dirs) {
    var k = Object.create(null);
    (files || []).forEach(function (p) { var d = dirname(p); while (d && !k[d]) { k[d] = 1; d = dirname(d); } });
    (dirs || []).forEach(function (x) { var d = x && x.dir ? String(x.dir) : ''; while (d && !k[d]) { k[d] = 1; d = dirname(d); } });
    return k;
  }
  /** A pattern for code that does not exist yet, but only one level inside
   *  a folder that does: `src/billing/**` or `src/routes/billing.ts` when
   *  `src` or `src/routes` exists. A made-up tree (`lib/x/y/**` with no
   *  `lib/x`) is not. */
  function isFreshPath(g, known, anyDepth) {
    var s = String(g).replace(/^\.\//, '').replace(/^\/+/, '');
    if (s.charAt(0) === '!') return false;
    s = s.replace(/\/\*\*$/, '').replace(/\/+$/, '');
    if (!s || /[*?[{]/.test(s) || s.indexOf('/') === -1) return false;
    if (/(^|\/)\.\.(\/|$)/.test(s)) return false;
    if (!anyDepth) return Boolean(known[dirname(s)]);
    // A person's own plan may name a deeper new folder: some ancestor must exist.
    var d = dirname(s);
    while (d) { if (known[d]) return true; d = dirname(d); }
    return false;
  }
  function stripMarkup(v) { return typeof v === 'string' ? v.replace(/<[^>]{0,200}>/g, '').replace(/[<>]/g, '') : ''; }

  return {
    LIMITS: LIMITS, KIND_INFO: KIND_INFO, LOCKFILES: LOCKFILES, PAIR_TEXT: PAIR_TEXT, DEFAULT_RULES: DEFAULT_RULES,
    clean: clean, esc: esc, fmtInt: fmtInt, plural: plural, shq: shq, basename: basename, dirname: dirname,
    unquotePath: unquotePath, cleanPath: cleanPath, cleanBranch: cleanBranch,
    migrationOf: migrationOf, hotspotKind: hotspotKind, isGeneratedPath: isGeneratedPath, definedName: definedName, depOf: depOf, versionOf: versionOf,
    createDiffParser: createDiffParser, parseDiff: parseDiff, createGatherParser: createGatherParser, parseInput: parseInput, branchFromDiff: branchFromDiff,
    gatherCommand: gatherCommand,
    runRelation: runRelation, runLabel: runLabel, comparePair: comparePair, collisions: collisions, sharedState: sharedState, duplicates: duplicates, mergeOrder: mergeOrder, analyse: analyse,
    compileGlob: compileGlob, matchMask: matchMask, globCount: globCount, buildTree: buildTree,
    laneName: laneName, slugName: slugName, cleanPlan: cleanPlan, tasksToLanes: tasksToLanes, hotspots: hotspots, migrationDirs: migrationDirs, reserveMigrations: reserveMigrations,
    checkPlan: checkPlan, brief: brief, allBriefs: allBriefs, worktreeCmd: worktreeCmd,
    mdCode: mdCode, mdText: mdText, mdPlain: mdPlain, toMarkdown: toMarkdown, toJson: toJson,
    splitPayload: splitPayload, cleanProposal: cleanProposal, isFreshPath: isFreshPath, knownDirs: knownDirs,
  };
}));
