/* Triage - the rules. One file, run in two places: the page
 * (window.TriageCore) and the server and tests (require).
 *
 * Everything that decides a finding lives here and is pure and
 * deterministic: the same diff gives the same classification, the same risk
 * order, the same review plan and the same split, on every machine. Nothing
 * here touches the network or storage.
 *
 *   reading      parseDiff (git's unified diff, renames, copies, binary,
 *                modes, deletes, CRLF, a --stat header), gatherCommand
 *   mechanical   fileKind, normalisers per language (whitespace, formatting,
 *                import order), the PR-wide rename map, import paths that
 *                follow a moved file, lockfiles, snapshots, generated,
 *                vendored, minified, changelogs, pure renames
 *   risk         DETECTORS: what a meaningful change touches, in words
 *   the plan     analyse -> files ordered by risk, skim groups with their
 *                checks, the verdict, estimate (review time)
 *   splitting    splitPlan -> stacked PRs, the commands, the comment to the
 *                author, rules for agents
 *   exports      toMarkdown, toJson (paths, counts and reasons - never code)
 *   the model    explainPayload, cleanExplanation
 *
 * Paths, diff lines and commit text are hostile: markup, bidi overrides,
 * control characters, very long lines. They are only ever drawn through
 * esc(), and every export escapes for its own format.
 *
 * Conservative by design: when a change might not be mechanical, it is not.
 * A whitespace change inside a string literal, a re-indented Python line, a
 * rename that also edits the file, a line cut short for memory - all of them
 * are read as meaningful.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TriageCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    bytes: 60 * 1024 * 1024,   // a diff bigger than this is refused
    files: 5000,               // files read from one diff
    keepPerFile: 6000,         // diff lines kept in memory per file (counts go on)
    keepTotal: 250000,         // diff lines kept in memory for the whole diff
    lineKeep: 4000,            // characters kept of one diff line
    lineShow: 400,             // characters shown of one diff line
    showPerHunk: 400,          // lines drawn per hunk before "N more"
    pathLen: 1000,
    explainLines: 400,         // lines sent to "Explain this change"
    explainLineLen: 1000,      // characters per line sent
    explainChars: 64000,       // characters sent in all
    longLine: 500,             // a source line longer than this hides itself
    renameMinLines: 3,         // a PR-wide rename: at least this many lines...
    renameMinFiles: 2,         // ...across at least this many files
    maxGroups: 7,              // stacked PRs proposed at most
  };

  /* ---------------- text ---------------- */

  var CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF]/g;
  // Trojan source: characters that reorder or hide text. Tabs, CR and LF are not here.
  var INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF\u00AD]/;
  var INVISIBLE_G = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF\u00AD]/g;
  /** A string safe to show: control, bidi and zero-width characters removed, bounded. */
  function clean(v, max) {
    if (v === null || v === undefined) return '';
    var s = String(v).replace(/\t/g, ' ').replace(/[\r\n]+/g, ' ').replace(CTRL, '');
    var m = max || 500;
    return s.length > m ? s.slice(0, m - 1) + '…' : s;
  }
  /** HTML-escape, and drop control, bidi and zero-width characters. */
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(CTRL, '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /** Invisible characters made visible, as ⟨U+202E⟩ - for showing a line that
   *  carries them, and for what is sent to the model, which should see them. */
  function markInvisible(s) {
    return String(s).replace(INVISIBLE_G, function (c) { return '⟨U+' + ('000' + c.charCodeAt(0).toString(16).toUpperCase()).slice(-4) + '⟩'; })
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, function (c) { return '⟨' + c.charCodeAt(0).toString(16) + '⟩'; });
  }
  function fmtInt(n) {
    n = Math.round(Number(n) || 0);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function plural(n, one, many) { return fmtInt(n) + ' ' + (Number(n) === 1 ? one : (many || one + 's')); }
  /** A short, stable fingerprint of a text (two FNV-1a passes, hex). Used to
   *  key "reviewed" ticks to one diff in this browser - never sent. */
  function hashText(s) {
    s = String(s || '');
    var a = 2166136261, b = 5381;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      a ^= c; a = Math.imul(a, 16777619) >>> 0;
      b = (Math.imul(b, 33) + c) >>> 0;
    }
    return ('0000000' + a.toString(16)).slice(-8) + ('0000000' + b.toString(16)).slice(-8) + '-' + s.length.toString(36);
  }
  function uniq(a) { var s = Object.create(null), out = []; a.forEach(function (x) { if (!s[x]) { s[x] = 1; out.push(x); } }); return out; }
  function basename(p) { var i = p.lastIndexOf('/'); return i === -1 ? p : p.slice(i + 1); }
  function dirname(p) { var i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); }
  function extOf(p) { var b = basename(p).toLowerCase(), i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i + 1); }
  function stripExt(p) { return p.replace(/\.[^./]+$/, ''); }

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

  /** A path as Triage keeps it: unquoted, forward slashes, no ./ - but its
   *  invisible characters KEPT (they are a finding; esc() drops them when
   *  drawn). '' when it is not a usable path. */
  function cleanPath(p) {
    var s = unquotePath(String(p || '').replace(/\r$/, '').trim());
    s = s.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
    if (!s || s.length > LIMITS.pathLen || /(^|\/)\.\.(\/|$)/.test(s)) return '';
    return s;
  }
  /** A path for the server's model request: no invisible characters at all. */
  function plainPath(p) { var s = cleanPath(p); return s ? s.replace(CTRL, '') : ''; }

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
   * Read a unified diff: git's (`diff --git`, renames and copies with their
   * similarity, binary, modes, new and deleted files) or a plain one
   * (`--- x` / `+++ y`), with any amount of context, CRLF or LF, a BOM, a
   * `git diff --stat` block or a patch's commit message in front. Hunks are
   * consumed by their header counts, so a content line "--- x" is content.
   * Lines are kept up to LIMITS.keepPerFile per file and keepTotal overall;
   * past that only the counts go on and the hunk is marked `cut` (and can
   * then never be called mechanical from its content). Never throws.
   */
  function parseDiff(text) {
    var s = String(text || '');
    var files = [], f = null, h = null;
    var remOld = 0, remNew = 0, oldLine = 0, newLine = 0;
    var malformed = 0, kept = 0, skipBinary = false, stat = null, sawAny = false, tooMany = 0;

    function newFile() {
      endFile();
      f = { git: false, a: '', b: '', minus: '', plus: '', status: '', renameFrom: '', renameTo: '', copy: false, similarity: null,
        binary: false, modeFrom: '', modeTo: '', hunks: [], adds: 0, dels: 0, kept: 0, cut: false, markerCtx: false, markerAdded: false };
    }
    function endHunk() { h = null; remOld = remNew = 0; }
    function endFile() {
      if (!f) return;
      endHunk();
      var p = pathOf(f);
      if (p) {
        var status = f.status;
        if (!status) {
          var renamed = f.renameFrom && f.renameTo ? f.renameFrom !== f.renameTo
            : f.minus && f.plus ? f.minus !== f.plus && f.minus !== '/dev/null' && f.plus !== '/dev/null'
              : Boolean(f.a && f.b && f.a !== f.b);
          status = renamed ? (f.copy ? 'C' : 'R') : 'M';
        }
        var oldPath = f.renameFrom || (f.minus && f.minus !== '/dev/null' ? f.minus : '') || f.a || p;
        if (files.length >= LIMITS.files) { tooMany++; f = null; return; }
        files.push({
          path: cleanPath(p) || '(unreadable path)', oldPath: cleanPath(status === 'A' ? p : oldPath) || cleanPath(p),
          status: status, similarity: f.similarity, binary: f.binary,
          modeFrom: f.modeFrom, modeTo: f.modeTo, hunks: f.hunks, adds: f.adds, dels: f.dels, cut: f.cut,
          markerCtx: f.markerCtx, markerAdded: f.markerAdded,
        });
      }
      f = null;
    }
    function pathOf(x) {
      if (x.status === 'D' || x.plus === '/dev/null') return x.renameFrom || (x.minus !== '/dev/null' && x.minus) || x.a || x.b;
      return x.renameTo || (x.plus && x.plus !== '/dev/null' ? x.plus : '') || x.b || x.a || (x.minus !== '/dev/null' ? x.minus : '');
    }
    function keep(c, t) {
      // A generated marker counts only near the top of the file.
      if (f.hunks.length === 1 && h.ns <= 3 && h.lines.length < 12 && c !== '-' && GENERATED_MARK.test(t.slice(0, 300))) {
        if (c === '+') f.markerAdded = true; else f.markerCtx = true;
      }
      if (h.dropped || kept >= LIMITS.keepTotal || f.kept >= LIMITS.keepPerFile) { h.cut = true; h.dropped = true; f.cut = true; return; }
      if (t.length > LIMITS.lineKeep) { t = t.slice(0, LIMITS.lineKeep); h.cut = true; h.long = true; }
      h.lines.push([c, t]); kept++; f.kept++;
    }
    function line(l) {
      if (h && (remOld > 0 || remNew > 0)) {
        var c = l.charAt(0);
        if (c === ' ' || l === '') {
          oldLine++; newLine++; remOld--; remNew--;
          keep(' ', l.slice(1));
          if (remOld <= 0 && remNew <= 0) endHunk();
          return;
        }
        if (c === '-' && remOld > 0) {
          oldLine++; remOld--; f.dels++; h.dels++;
          keep('-', l.slice(1));
          if (remOld <= 0 && remNew <= 0) endHunk();
          return;
        }
        if (c === '+' && remNew > 0) {
          newLine++; remNew--; f.adds++; h.adds++;
          keep('+', l.slice(1));
          if (remOld <= 0 && remNew <= 0) endHunk();
          return;
        }
        if (c === '\\') return;
        malformed++;
        if (h) h.cut = true;
        endHunk();
      }
      if (l.charAt(0) === '\\') return;
      if (l.indexOf('diff --git ') === 0) {
        newFile(); skipBinary = false; f.git = true; sawAny = true;
        var ps = gitHeaderPaths(l.slice(11));
        f.a = ps.a; f.b = ps.b;
        return;
      }
      if (l.indexOf('diff --cc ') === 0 || l.indexOf('diff --combined ') === 0) { newFile(); skipBinary = true; sawAny = true; f.a = f.b = unquotePath(l.replace(/^diff --(cc|combined) /, '')); malformed++; return; }
      if (skipBinary) return;
      if (!f && !sawAny) {
        // Before the first file: a --stat block or a patch's mail header.
        var sm = /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(l);
        if (sm) stat = { files: +sm[1], adds: +(sm[2] || 0), dels: +(sm[3] || 0) };
      }
      if (l.indexOf('--- ') === 0 && !h) {
        if (!f || f.hunks.length > 0 || f.minus || f.binary) newFile();
        sawAny = true;
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
      if (!f) { if (/^@@ /.test(l) && sawAny) malformed++; return; }
      if (l.indexOf('new file mode') === 0) { f.status = 'A'; f.modeTo = l.slice(14).trim(); return; }
      if (l.indexOf('deleted file mode') === 0) { f.status = 'D'; f.modeFrom = l.slice(18).trim(); return; }
      if (l.indexOf('similarity index ') === 0) { var si = parseInt(l.slice(17), 10); if (si >= 0 && si <= 100) f.similarity = si; return; }
      if (l.indexOf('rename from ') === 0 || l.indexOf('copy from ') === 0) { f.copy = l.indexOf('copy') === 0; f.renameFrom = unquotePath(l.replace(/^(rename|copy) from /, '')); return; }
      if (l.indexOf('rename to ') === 0 || l.indexOf('copy to ') === 0) { f.renameTo = unquotePath(l.replace(/^(rename|copy) to /, '')); if (f.renameFrom && f.renameFrom !== f.renameTo && !f.status) f.status = f.copy ? 'C' : 'R'; return; }
      if (l.indexOf('Binary files ') === 0) {
        f.binary = true;
        var bm = /^Binary files (.+) and (.+) differ$/.exec(l);
        if (bm) { if (bm[1] === '/dev/null') f.status = 'A'; else if (bm[2] === '/dev/null') f.status = 'D'; }
        return;
      }
      if (l.indexOf('GIT binary patch') === 0) { f.binary = true; skipBinary = true; return; }
      if (l.indexOf('@@ ') === 0) {
        var m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(l);
        if (!m) { malformed++; return; }
        endHunk();
        var os = +m[1], oc = m[2] === undefined ? 1 : +m[2], ns = +m[3], nc = m[4] === undefined ? 1 : +m[4];
        if (oc > 1e7 || nc > 1e7) { malformed++; return; }
        h = { os: os, oc: oc, ns: ns, nc: nc, header: clean(m[5] || '', 160), lines: [], adds: 0, dels: 0, cut: false };
        f.hunks.push(h);
        remOld = oc; remNew = nc;
        oldLine = oc === 0 ? os + 1 : os;
        newLine = nc === 0 ? ns + 1 : ns;
        if (remOld === 0 && remNew === 0) endHunk();
        return;
      }
      if (/^old mode /.test(l)) { f.modeFrom = l.slice(9).trim(); return; }
      if (/^new mode /.test(l)) { f.modeTo = l.slice(9).trim(); return; }
      // index, dissimilarity, a commit message: ignored
    }
    var start = 0, first = true;
    while (start <= s.length) {
      var i = s.indexOf('\n', start);
      if (i === -1) i = s.length;
      var l = s.slice(start, i);
      if (l.charCodeAt(l.length - 1) === 13) l = l.slice(0, -1);
      if (first) { l = l.replace(/^\uFEFF/, ''); first = false; }
      if (!(i === s.length && l === '' && start === s.length)) line(l);
      start = i + 1;
    }
    if (h && (remOld > 0 || remNew > 0)) { malformed++; h.cut = true; }
    endFile();
    var adds = 0, dels = 0;
    files.forEach(function (x) { adds += x.adds; dels += x.dels; });
    var warnings = [];
    if (malformed) warnings.push(plural(malformed, 'hunk') + ' did not add up and ' + (malformed === 1 ? 'was' : 'were') + ' read as far as ' + (malformed === 1 ? 'it' : 'they') + ' made sense.');
    if (tooMany) warnings.push('Only the first ' + fmtInt(LIMITS.files) + ' files were read (' + fmtInt(tooMany) + ' more were skipped).');
    if (stat && (stat.adds !== adds || stat.dels !== dels)) warnings.push('The summary at the top says +' + fmtInt(stat.adds) + ' / -' + fmtInt(stat.dels) + ' lines, but +' + fmtInt(adds) + ' / -' + fmtInt(dels) + ' were read: the file may have been cut off.');
    var cutFiles = files.filter(function (x) { return x.cut; }).length;
    if (cutFiles) warnings.push(plural(cutFiles, 'file') + ' had very long lines or more lines than are kept in memory; ' + (cutFiles === 1 ? 'it is' : 'they are') + ' counted in full but never called mechanical.');
    return { files: files, malformed: malformed, stat: stat, adds: adds, dels: dels, warnings: warnings, empty: !files.length };
  }

  /** The one command: the diff of this branch against the base, with git's
   *  rename detection and a --stat summary in front (so a cut-off file is
   *  noticed), written to one file. Reads git; no network. */
  var REF_OK = /^[A-Za-z0-9._/@+-]{1,120}$/;
  function gatherCommand(o) {
    o = o || {};
    var base = String(o.base || 'main').trim(), head = String(o.head || 'HEAD').trim(), out = String(o.out || 'triage.diff').trim();
    var bad = function (r) { return !REF_OK.test(r) || r.charAt(0) === '-' || /\.\./.test(r); };
    if (bad(base)) return { error: 'The base branch can only use letters, numbers and . _ / @ + -' };
    if (bad(head)) return { error: 'The PR branch can only use letters, numbers and . _ / @ + -' };
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(out)) return { error: 'The file name can only use letters, numbers and . _ -' };
    var range = base + '...' + head;
    if (o.shell === 'ps') {
      return { command: "$R='" + range + "'; & { git -c core.quotepath=off diff --stat=200 -M $R; git -c core.quotepath=off diff --no-color --no-ext-diff -M $R } | Out-File -Encoding utf8 " + out };
    }
    return { command: "R='" + range + "'; { git -c core.quotepath=off diff --stat=200 -M \"$R\"; git -c core.quotepath=off diff --no-color --no-ext-diff -M \"$R\"; } > " + out };
  }

  /* ---------------- what a path is ---------------- */

  var LOCKFILES = {
    'package-lock.json': 'npm ci', 'npm-shrinkwrap.json': 'npm ci', 'yarn.lock': 'yarn install --frozen-lockfile',
    'pnpm-lock.yaml': 'pnpm install --frozen-lockfile', 'bun.lockb': 'bun install --frozen-lockfile', 'bun.lock': 'bun install --frozen-lockfile',
    'Gemfile.lock': 'bundle install --frozen', 'poetry.lock': 'poetry check --lock', 'Pipfile.lock': 'pipenv verify',
    'uv.lock': 'uv lock --check', 'Cargo.lock': 'cargo build --locked', 'go.sum': 'go mod verify',
    'composer.lock': 'composer validate', 'mix.lock': 'mix deps.get --check-locked', 'Podfile.lock': 'pod install --deployment',
    'packages.lock.json': 'dotnet restore --locked-mode', 'flake.lock': 'nix flake lock --no-update-lock-file', 'pubspec.lock': 'dart pub get --enforce-lockfile',
  };
  var MANIFESTS = /^(package\.json|pyproject\.toml|requirements(-[\w.-]+)?\.txt|Pipfile|Gemfile|go\.mod|Cargo\.toml|composer\.json|mix\.exs|build\.gradle(\.kts)?|pom\.xml|pubspec\.yaml|[\w.-]+\.csproj|setup\.py|setup\.cfg)$/;
  var SNAPSHOT = /(^|\/)__snapshots__\/|\.snap$|(^|\/)__image_snapshots__\//;
  var GENERATED_PATH = [
    /(^|\/)(dist|build|out|\.next|\.nuxt|__generated__|generated|gen)\//,
    /\.(js\.map|css\.map|pb\.go|g\.dart|freezed\.dart|generated\.[a-z]+|pb\.ts|pb\.cc|pb\.h)$/i,
    /_pb2(_grpc)?\.pyi?$/,
  ];
  var GENERATED_MARK = /@generated|DO NOT EDIT|Code generated .{0,80}DO NOT EDIT|\bauto-?generated\b|This file (is|was|has been) (automatically )?generated/i;
  var VENDORED = /(^|\/)(vendor|third_party|third-party|thirdparty|node_modules|bower_components|external)\//;
  var MINIFIED = /\.min\.(js|mjs|css)$|-min\.js$|\.bundle\.js$/i;
  var CHANGELOG = /(^|\/)(CHANGELOG|CHANGES|HISTORY|RELEASES?|RELEASE_NOTES|NEWS)(\.(md|txt|rst|markdown))?$/i;
  var TESTPATH = /(^|\/)(__tests__|tests?|spec|specs|e2e|__mocks__|fixtures?|testdata)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rb)$|(^|\/)test_[\w-]+\.py$|_spec\.rb$/i;
  var DOCS = /\.(md|mdx|markdown|rst|txt|adoc)$|(^|\/)docs?\//i;
  var MIGRATION = /(^|\/)(migrations?|migrate|alembic|flyway|db\/migrate|liquibase|changelog)\/[^/]+|(^|\/)\d{2,14}[_-][\w.-]+\.sql$/i;
  var SCHEMA = /(^|\/)db\/(schema\.rb|structure\.sql)$|(^|\/)schema\.(prisma|sql|graphql|gql)$|(^|\/)migration_lock\.toml$|\.sql$/i;
  var CI = /^(\.github\/workflows\/|\.gitlab-ci\.yml$|\.circleci\/|azure-pipelines\.ya?ml$|\.buildkite\/|bitbucket-pipelines\.yml$|\.travis\.yml$)|(^|\/)Jenkinsfile$/;
  var INFRA = /(^|\/)(Dockerfile[\w.-]*|[\w.-]+\.Dockerfile|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|Procfile|[\w.-]+\.tf|[\w.-]+\.tfvars|serverless\.ya?ml|app\.ya?ml|cloudbuild\.ya?ml|fly\.toml|vercel\.json|netlify\.toml|Chart\.yaml|values[\w.-]*\.ya?ml|\.dockerignore)$|(^|\/)(k8s|kubernetes|helm|charts|terraform|infra|deploy|ansible)\//;
  var CONFIG = /(^|\/)\.env(\.[\w-]+)?$|(^|\/)(config|configs|settings)\/[^/]+$|(^|\/)(settings|config|configuration)\.[a-z]+$|(^|\/)[\w.-]+\.config\.[cm]?[jt]s$|(^|\/)application(-\w+)?\.(ya?ml|properties)$|(^|\/)appsettings[\w.]*\.json$|(^|\/)(feature[-_]?flags?|flags)\.[a-z]+$/i;
  var ASSET = /\.(png|jpe?g|gif|webp|avif|ico|svg|bmp|tiff?|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|webm|mov|pdf)$/i;
  var EXECUTABLE = /\.(exe|dll|so|dylib|jar|war|class|wasm|zip|tar|tgz|gz|bz2|7z|rar|bin|pyc|o|a|lib|apk|ipa|dmg|msi|deb|rpm)$/i;
  var CODE = /\.(m?[jt]sx?|cjs|cts|mts|py|pyi|rb|go|rs|java|kt|kts|cs|php|swift|scala|vue|svelte|ex|exs|dart|c|cc|cpp|cxx|h|hpp|m|mm|lua|pl|sh|bash|zsh|ps1|groovy|clj|erl|hs|ml|fs|r|jl|html?|ejs|hbs|erb|jinja2?|j2|twig|njk|liquid)$/i;

  /** What kind of thing a path is, by its name alone. */
  function fileKind(p) {
    var b = basename(p);
    if (LOCKFILES[b]) return 'lockfile';
    if (SNAPSHOT.test(p)) return 'snapshot';
    if (VENDORED.test(p)) return 'vendored';
    if (MINIFIED.test(p)) return 'minified';
    if (GENERATED_PATH.some(function (re) { return re.test(p); })) return 'generated';
    if (CHANGELOG.test(p)) return 'changelog';
    if (TESTPATH.test(p)) return 'test';
    if (MANIFESTS.test(b)) return 'manifest';
    if (MIGRATION.test(p) && /\.(sql|py|rb|[cm]?[jt]s|go|xml|ya?ml|java|kt|php|exs?)$/i.test(p)) return 'migration';
    if (SCHEMA.test(p)) return 'schema';
    if (CI.test(p)) return 'ci';
    if (INFRA.test(p)) return 'infra';
    if (CONFIG.test(p)) return 'config';
    if (ASSET.test(p)) return 'asset';
    if (EXECUTABLE.test(p)) return 'executable';
    if (DOCS.test(p) && !CODE.test(p)) return 'doc';
    if (CODE.test(p)) return 'code';
    return 'other';
  }
  var PATH_MECH = { lockfile: 1, snapshot: 1, vendored: 1, minified: 1, generated: 1, changelog: 1 };

  /* ---------------- normalising: is this change only whitespace? ---------------- */

  /**
   * How a language treats whitespace, which decides how hard we may squint:
   *   free    newlines and spaces are interchangeable outside strings
   *           (JS/TS, CSS, C-family, Java, C#, Rust, PHP, JSON, SQL)
   *   lines   newlines end statements, spaces inside a line do not matter
   *           (Go, Kotlin, Scala)
   *   indent  newlines AND leading indentation matter (Python, YAML)
   *   text    only trailing spaces and line endings may differ (Markdown,
   *           HTML, Ruby, shell, Swift, anything unknown)
   *   exact   only line endings may differ (Makefiles: trailing spaces are
   *           part of a value)
   * Strings are always compared exactly - a space inside a literal is data.
   */
  function langOf(p) {
    var e = extOf(p), b = basename(p);
    if (/^(GNUmakefile|makefile|Makefile)$/.test(b) || e === 'mk' || e === 'diff' || e === 'patch') return { mode: 'exact' };
    if (/^(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(e)) return { mode: 'free', fam: 'js', quotes: '\'"`', slash: true, block: true, fmtQuotes: true, jsPunct: true };
    if (/^(css|scss|less)$/.test(e)) return { mode: 'free', fam: 'css', quotes: '\'"', slash: e !== 'css', block: true, fmtQuotes: true, cssSemi: true };
    if (/^(c|h|cc|cpp|cxx|hpp|hh|java|cs|rs|php|dart|m|mm|groovy)$/.test(e)) return { mode: 'free', fam: 'c', quotes: '\'"' + (e === 'dart' || e === 'php' ? '' : ''), slash: true, block: true, hash: e === 'php' };
    if (e === 'json') return { mode: 'free', fam: 'json', quotes: '"' };
    if (e === 'sql') return { mode: 'free', fam: 'sql', quotes: '\'"', dash: true, block: true, multiline: true };
    if (/^(go|kt|kts|scala)$/.test(e)) return { mode: 'lines', fam: e === 'go' ? 'go' : 'c', quotes: e === 'go' ? '\'"`' : '\'"', slash: true, block: true, raw: e === 'go' ? '`' : '' };
    if (e === 'py' || e === 'pyi') return { mode: 'indent', fam: 'py', quotes: '\'"', hash: true, triple: true, fmtQuotes: true };
    if (e === 'yml' || e === 'yaml') return { mode: 'indent', fam: 'yaml', quotes: '\'"', hash: true, hashNeedsSpace: true };
    return { mode: 'text' };
  }

  var WORDCH = /[A-Za-z0-9_$\u00C0-\uFFFF]/;
  var ASI_KW = { 'return': 1, 'throw': 1, 'break': 1, 'continue': 1, 'yield': 1, 'await': 0 };
  /**
   * Tokens of a code text, whitespace dropped but remembered where it
   * matters: between two word characters (`return x` is not `returnx`), at a
   * line break where the language ends statements there, and the leading
   * indentation of each line in an indentation language. Strings are whole
   * tokens, kept exactly. null when a string or comment does not end inside
   * the text - we cannot tell what is inside a literal we only see part of.
   */
  function tokens(text, L, fmt) {
    var out = [], i = 0, n = text.length, nlBefore = true, wsBefore = false, depth = 0, lineStart = true, indent = '';
    var sig = L.mode === 'lines' || L.mode === 'indent';
    function push(t, kind) { out.push({ t: t, k: kind, nl: nlBefore, head: nlBefore && depth === 0, ws: wsBefore, ind: indent }); nlBefore = false; wsBefore = false; lineStart = false; }
    while (i < n) {
      var c = text.charAt(i);
      if (c === '\n') {
        if (sig && depth === 0) { if (!lineStart) out.push({ t: '\n', k: 'nl' }); }
        else wsBefore = true;
        nlBefore = true; lineStart = true; indent = ''; i++;
        if (L.mode === 'indent' && depth === 0) { var j0 = i; while (i < n && (text.charAt(i) === ' ' || text.charAt(i) === '\t')) i++; indent = text.slice(j0, i); }
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
        if (lineStart && L.mode === 'indent' && depth === 0 && !out.length) { var j1 = i; while (i < n && /[ \t]/.test(text.charAt(i))) i++; indent = text.slice(j1, i); continue; }
        wsBefore = true; i++; continue;
      }
      if (c === '\\' && L.mode !== 'free' && text.charAt(i + 1) === '\n') { i += 2; wsBefore = true; continue; } // line continuation
      if ((L.slash && c === '/' && text.charAt(i + 1) === '/') || (L.hash && c === '#' && (!L.hashNeedsSpace || i === 0 || /\s/.test(text.charAt(i - 1)))) || (L.dash && c === '-' && text.charAt(i + 1) === '-')) {
        var e = text.indexOf('\n', i); if (e === -1) e = n;
        push(text.slice(i, e).replace(/\s+/g, ' ').trim(), 'comment');
        out.push({ t: '\n', k: 'nl' });
        lineStart = true;
        i = e; continue;
      }
      if (L.block && c === '/' && text.charAt(i + 1) === '*') {
        var be = text.indexOf('*/', i + 2);
        if (be === -1) return null;
        push(text.slice(i, be + 2).replace(/\s+/g, ' '), 'comment');
        i = be + 2; continue;
      }
      if (L.quotes && L.quotes.indexOf(c) !== -1) {
        var triple = L.triple && text.substr(i, 3) === c + c + c;
        var close = triple ? c + c + c : c;
        var j = i + close.length, body = '', ok = false;
        while (j < n) {
          var d = text.charAt(j);
          if (d === '\\' && !(L.raw && L.raw === c)) { body += d + text.charAt(j + 1); j += 2; continue; }
          if (text.substr(j, close.length) === close) { ok = true; break; }
          if (d === '\n' && !triple && c !== '`' && !L.multiline) break;
          body += d; j++;
        }
        if (!ok) return null;
        var t = close + body + close;
        if (fmt && L.fmtQuotes && !triple && c !== '`' && !/['"\\\n]/.test(body)) t = '"' + body + '"';
        push(t, 'str');
        i = j + close.length; continue;
      }
      if (WORDCH.test(c)) {
        var w = i; while (w < n && WORDCH.test(text.charAt(w))) w++;
        push(text.slice(i, w), 'word'); i = w; continue;
      }
      if ('([{'.indexOf(c) !== -1) depth++;
      else if (')]}'.indexOf(c) !== -1 && depth > 0) depth--;
      push(c, 'punct'); i++;
    }
    return out;
  }
  /** Tokens -> one comparable string, applying the formatter's harmless
   *  rewrites when `fmt` (JS trailing commas and ASI-safe semicolons, CSS's
   *  last semicolon, quote style where the language does not care). */
  function render(toks, L, fmt) {
    var t = toks;
    if (fmt && (L.jsPunct || L.cssSemi)) {
      t = toks.filter(function (x, i) {
        if (x.k !== 'punct') return true;
        var nx = toks[i + 1];
        if (L.jsPunct && x.t === ',' && nx && (nx.t === ')' || nx.t === ']' || nx.t === '}')) return false;
        if (x.t === ';' && nx && nx.t === '}') return false;
        if (L.jsPunct && x.t === ';' && nx && nx.nl && (nx.k === 'word' || nx.k === 'str' && nx.t.charAt(0) !== '`')) return false;
        return true;
      });
    }
    var s = '', prev = null;
    for (var i = 0; i < t.length; i++) {
      var x = t[i];
      if (x.k === 'nl') { s += '\n'; prev = x; continue; }
      if (L.mode === 'indent' && x.head) s += '\u0001' + x.ind + '\u0002';
      if (prev && prev.k === 'word' && x.k === 'word') {
        s += (L.fam === 'js' && x.nl && ASI_KW[prev.t]) ? '\n' : ' ';
      } else if (prev && L.fam === 'js' && x.nl && prev.k === 'word' && ASI_KW[prev.t]) s += '\n';
      s += x.t;
      prev = x;
    }
    return s;
  }
  function textLines(text, L) {
    return text.split('\n').map(function (l) { l = l.replace(/\r+$/, ''); return L.mode === 'exact' ? l : l.replace(/[ \t\r\f\v]+$/, ''); }).join('\n');
  }
  /** 'whitespace', 'format' or null: is `b` the same code as `a`? */
  function sameCode(a, b, L) {
    if (a === b) return 'whitespace';
    if (L.mode === 'text' || L.mode === 'exact') return textLines(a, L) === textLines(b, L) ? 'whitespace' : null;
    var ta = tokens(a, L, false), tb = tokens(b, L, false);
    if (!ta || !tb) return null;
    if (render(ta, L, false) === render(tb, L, false)) return 'whitespace';
    if (!(L.fmtQuotes || L.jsPunct || L.cssSemi)) return null;
    var fa = tokens(a, L, true), fb = tokens(b, L, true);
    if (!fa || !fb) return null;
    return render(fa, L, true) === render(fb, L, true) ? 'format' : null;
  }

  /* ---------------- blocks, imports and the rename map ---------------- */

  /** A hunk as change blocks: each run of -/+ lines with the context line on
   *  either side (the same on both sides, so it never makes a change look
   *  equal, but it lets `foo(a` + `)` and trailing commas be judged). */
  function blocksOf(h) {
    var out = [], cur = null, last = null;
    h.lines.forEach(function (l) {
      if (l[0] === ' ') { if (cur) { cur.post = l[1]; out.push(cur); cur = null; } last = l[1]; return; }
      if (!cur) cur = { pre: last, minus: [], plus: [], post: null };
      (l[0] === '-' ? cur.minus : cur.plus).push(l[1]);
    });
    if (cur) out.push(cur);
    return out;
  }
  function sideText(b, which) {
    var mid = b[which];
    return (b.pre !== null ? b.pre + '\n' : '') + mid.join('\n') + (b.post !== null ? '\n' + b.post : '');
  }

  var IMPORT_LINE = {
    js: /^\s*(import\b[^(]|export\s+(\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\b|(const|let|var)\s+[\w${},\s:]+=\s*require\(\s*['"][^'"]+['"]\s*\)\s*;?\s*$)/,
    py: /^(import\s+[\w., ]+|from\s+[\w.]+\s+import\s+[\w., *()]+)\s*(#.*)?$/,
    go: /^\s*(import\s+)?([\w.]+\s+)?"[\w./-]+"\s*$/,
    c: /^\s*(import\s+[\w.*]+;?|using\s+[\w.]+;|#include\s+[<"][^>"]+[>"]|use\s+[\w:{}, *]+;)\s*$/,
    css: /^\s*@(import|use|forward)\s+/,
  };
  function importNorm(l) {
    return l.replace(/\s+/g, ' ').trim().replace(/'/g, '"').replace(/\{([^}]*)\}/, function (_, inner) {
      return '{' + inner.split(',').map(function (s) { return s.trim(); }).filter(Boolean).sort().join(',') + '}';
    }).replace(/;$/, '');
  }
  function isImportBlock(b, L) {
    var re = IMPORT_LINE[L.fam === 'go' ? 'go' : L.fam];
    if (!re || b.minus.length !== b.plus.length || !b.minus.length) return false;
    var all = b.minus.concat(b.plus);
    if (!all.every(function (l) { return re.test(l); })) return false;
    var x = b.minus.map(importNorm).sort(), y = b.plus.map(importNorm).sort();
    return x.join('\n') === y.join('\n');
  }
  function isImportish(l) { return /\b(import|from|require|export)\b/.test(l) && /['"]/.test(l); }

  var SENSITIVE_NAME = /auth|admin|role|perm|owner|session|token|secret|passw|guard|allow|deny|csrf|acl|polic|privileg|verif|valid|sanit|escape|crypt|sign|grant|scope|access|trust/i;
  /** Simple tokens for comparing two lines: words, strings, single characters. */
  function lineToks(l) {
    var out = [], re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[A-Za-z_$][\w$]*|\d[\w.]*|\S)/g, m;
    while ((m = re.exec(l))) out.push(m[1]);
    return out;
  }
  function isWordTok(t) { return /^[A-Za-z_$][\w$]*$/.test(t); }
  function isStrTok(t) { return /^["'`]/.test(t); }
  /** How two lines differ, token by token: [{a, b, kind: 'word'|'str'}], or
   *  null when they differ in anything else (or in length). */
  function lineSubs(a, b) {
    var x = lineToks(a), y = lineToks(b);
    if (x.length !== y.length || !x.length) return null;
    var subs = [];
    for (var i = 0; i < x.length; i++) {
      if (x[i] === y[i]) continue;
      if (isWordTok(x[i]) && isWordTok(y[i])) subs.push({ a: x[i], b: y[i], kind: 'word' });
      else if (isStrTok(x[i]) && isStrTok(y[i])) subs.push({ a: x[i].slice(1, -1), b: y[i].slice(1, -1), kind: 'str' });
      else return null;
    }
    return subs.length ? subs : null;
  }
  function resolveRel(dir, spec) {
    if (spec.charAt(0) !== '.') return null;
    var parts = dir ? dir.split('/') : [];
    spec.split('/').forEach(function (seg) {
      if (seg === '.' || seg === '') return;
      if (seg === '..') parts.pop(); else parts.push(seg);
    });
    return parts.join('/');
  }
  function noIndex(p) { return stripExt(p).replace(/\/index$/, ''); }
  /** Does changing an import from `a` to `b` (in a file that moved from
   *  oldPath to newPath) only follow a file or folder this PR moved? */
  function followsMove(a, b, oldPath, newPath, moves) {
    var ra = resolveRel(dirname(oldPath), a), rb = resolveRel(dirname(newPath), b);
    if (ra !== null && rb !== null) {
      if (ra === rb) return true; // the importer moved; the target did not
      return moves.some(function (m) {
        return (noIndex(m.from) === ra && noIndex(m.to) === rb) || (dirname(m.from) === ra && dirname(m.to) === rb);
      });
    }
    if (ra !== null || rb !== null) return false;
    // Aliased (@/x, ~/x, src/x): the same alias, and the rest names a move.
    var pa = /^([@~][\w-]*\/|)(.*)$/.exec(a), pb = /^([@~][\w-]*\/|)(.*)$/.exec(b);
    if (!pa[2] || !pb[2] || pa[1] !== pb[1]) return false;
    return moves.some(function (m) {
      var fa = noIndex(m.from), ta = noIndex(m.to);
      var endsA = fa === pa[2] || fa.slice(-pa[2].length - 1) === '/' + pa[2];
      var endsB = ta === pb[2] || ta.slice(-pb[2].length - 1) === '/' + pb[2];
      var dA = dirname(m.from), dB = dirname(m.to);
      return (endsA && endsB) || ((dA === pa[2] || dA.slice(-pa[2].length - 1) === '/' + pa[2]) && (dB === pb[2] || dB.slice(-pb[2].length - 1) === '/' + pb[2]));
    });
  }

  /**
   * The PR-wide rename map: a name swapped for another, the same way, on
   * lines that change nothing else, in at least renameMinLines lines across
   * renameMinFiles files. Refused when the old name still appears on an
   * added or unchanged line (the rename is incomplete or it is two
   * different things), when the new name already appeared on a removed or
   * unchanged line (it names something that existed before), when one name
   * maps to two, or when either name sounds like security (a renamed
   * `requireAdmin` is read, never skimmed).
   */
  function renameMap(files) {
    var cand = Object.create(null), seenPlus = Object.create(null), seenOld = Object.create(null);
    files.forEach(function (f) {
      f.hunks.forEach(function (h) {
        h.lines.forEach(function (l) {
          var toks = lineToks(l[1]).filter(isWordTok);
          var into = l[0] === '+' ? seenPlus : seenOld;
          toks.forEach(function (t) { into[t] = (into[t] || 0) + 1; if (l[0] === ' ') seenPlus[t] = (seenPlus[t] || 0) + 1; });
        });
        if (h.cut) return;
        blocksOf(h).forEach(function (b) {
          if (b.minus.length !== b.plus.length) return;
          for (var i = 0; i < b.minus.length; i++) {
            var subs = lineSubs(b.minus[i], b.plus[i]);
            if (!subs) continue;
            subs.forEach(function (s) {
              if (s.kind !== 'word') return;
              var k = s.a + '\u0000' + s.b;
              if (!cand[k]) cand[k] = { a: s.a, b: s.b, lines: 0, files: Object.create(null) };
              cand[k].lines++; cand[k].files[f.path] = 1;
            });
          }
        });
      });
    });
    var byA = Object.create(null), byB = Object.create(null);
    Object.keys(cand).forEach(function (k) { var c = cand[k]; byA[c.a] = (byA[c.a] || 0) + 1; byB[c.b] = (byB[c.b] || 0) + 1; });
    var map = Object.create(null), list = [];
    Object.keys(cand).sort().forEach(function (k) {
      var c = cand[k], nf = Object.keys(c.files).length;
      if (c.lines < LIMITS.renameMinLines || nf < LIMITS.renameMinFiles) return;
      if (byA[c.a] > 1 || byB[c.b] > 1) return;
      if (SENSITIVE_NAME.test(c.a) || SENSITIVE_NAME.test(c.b)) return;
      if (c.a.length < 3 || c.b.length < 3) return;
      // The old name must be gone from every added and unchanged line; the
      // new one must not have existed on any removed or unchanged line.
      if (seenPlus[c.a]) return;
      if ((seenOld[c.b] || 0) > 0) return;
      map[c.a] = c.b;
      list.push({ from: c.a, to: c.b, lines: c.lines, files: nf });
    });
    return { map: map, list: list };
  }

  /** Is a change block mechanical? -> {kind, detail} or null. */
  function blockMech(b, L, f, ctx) {
    if (!b.minus.length && !b.plus.length) return { kind: 'whitespace' };
    var all = b.minus.concat(b.plus);
    if (all.some(function (l) { return INVISIBLE.test(l); })) return null;
    // Whitespace or formatting only (blank lines added or removed count too).
    var k = sameCode(sideText(b, 'minus'), sideText(b, 'plus'), L);
    if (k) return { kind: k };
    if (isImportBlock(b, L)) return { kind: 'imports' };
    // A rename from the PR-wide map, or an import that follows a moved file.
    if (b.minus.length !== b.plus.length) return null;
    var kinds = {}, names = [];
    for (var i = 0; i < b.minus.length; i++) {
      var subs = lineSubs(b.minus[i], b.plus[i]);
      if (!subs) {
        if (sameCode(b.minus[i], b.plus[i], L)) continue;
        return null;
      }
      for (var j = 0; j < subs.length; j++) {
        var s = subs[j];
        if (s.kind === 'word' && ctx.renames.map[s.a] === s.b) { kinds.rename = 1; names.push(s.a + ' → ' + s.b); continue; }
        if (s.kind === 'str' && isImportish(b.plus[i]) && followsMove(s.a, s.b, f.oldPath, f.path, ctx.moves)) { kinds.movepath = 1; continue; }
        return null;
      }
    }
    if (kinds.rename) return { kind: 'rename', detail: uniq(names).slice(0, 4).join(', ') };
    if (kinds.movepath) return { kind: 'movepath' };
    return null;
  }
  var MECH_LABEL = {
    whitespace: 'Whitespace only',
    format: 'Formatting only (quotes, commas, semicolons, line breaks)',
    imports: 'Imports reordered',
    rename: 'A rename made across the PR',
    movepath: 'An import path that follows a moved file',
  };
  var MECH_RANK = { whitespace: 1, format: 2, imports: 3, movepath: 4, rename: 5 };
  /** Inside a meaningful hunk: which -/+ line pairs are only formatting, so
   *  the page can quiet them and the real change stands out. Lines paired in
   *  order within a block of equal size; -> {lineIndex: 1}. */
  function sameLines(h, L) {
    var out = {}, idx = 0, cur = null;
    function flush() {
      if (cur && cur.m.length === cur.p.length) {
        for (var k = 0; k < cur.m.length; k++) {
          var a = h.lines[cur.m[k]][1], b = h.lines[cur.p[k]][1];
          if (a !== b && !INVISIBLE.test(a + b) && sameCode(a, b, L)) { out[cur.m[k]] = 1; out[cur.p[k]] = 1; }
          else if (a === b) { out[cur.m[k]] = 1; out[cur.p[k]] = 1; }
        }
      }
      cur = null;
    }
    for (idx = 0; idx < h.lines.length; idx++) {
      var c = h.lines[idx][0];
      if (c === ' ') { flush(); continue; }
      if (!cur) cur = { m: [], p: [] };
      (c === '-' ? cur.m : cur.p).push(idx);
    }
    flush();
    return out;
  }
  function hunkMech(h, L, f, ctx) {
    if (h.cut || f.binary) return null;
    var blocks = blocksOf(h);
    if (!blocks.length) return null;
    var kinds = [], detail = [];
    for (var i = 0; i < blocks.length; i++) {
      var m = blockMech(blocks[i], L, f, ctx);
      if (!m) return null;
      kinds.push(m.kind); if (m.detail) detail.push(m.detail);
    }
    kinds = uniq(kinds).sort(function (a, b) { return MECH_RANK[b] - MECH_RANK[a]; });
    return { kind: kinds[0], kinds: kinds, label: kinds.map(function (k) { return MECH_LABEL[k]; }).join(' + '), detail: uniq(detail).join(', ') };
  }

  /* ---------------- risk ---------------- */

  var AUTH_WORD = /\b(auth\w*|authori[sz]\w*|authenticat\w*|permissions?|isAdmin|is_admin|isOwner|is_owner|roles?(?!\s*=\s*["'{])|session\w*|jwt|tokens?|passwords?|passwd|bcrypt|argon2|scrypt|pbkdf2|csrf|xsrf|oauth\w*|login|logout|sign_?in|acl|rbac|currentUser|current_user|privileges?|impersonat\w*|timingSafeEqual|createHmac|randomBytes)\b|\bcan[A-Z]\w*|\b(require|ensure|assert|check)(Auth|User|Role|Admin|Login|Owner|Member|Permission|Access)\w*/;
  var AUTH_PATH = /(^|\/)(auth|authn|authz|login|logins|session|sessions|permissions?|rbac|acl|policies|policy|guards?|oauth|sso|security|crypto|identity|access|middleware\/auth\w*)([./_-]|$)/i;
  var COND = /\bif\b|\bunless\b|\breturn\b|\bthrow\b|&&|\|\||[!=]==?|\?|\belse\b|\bwhen\b|\bassert\b/;
  var SECRET_RE = /AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(sk|rk)_live_[0-9a-zA-Z]{10,}|\bgh[pousr]_[0-9A-Za-z]{30,}|\bxox[baprs]-[0-9A-Za-z-]{10,}|\bAIza[0-9A-Za-z_-]{30,}|\bglpat-[0-9A-Za-z_-]{20,}/;
  var SECRET_ASSIGN = /\b(api[_-]?key|secret|client[_-]?secret|password|passwd|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i;
  var PLACEHOLDER = /^(x+|\*+|<.*>|\$\{.*\}|change[-_]?me|example|your[-_].*|dummy|test|placeholder|redacted|\.\.\.)$|process\.env|os\.environ|getenv/i;
  var DANGEROUS = /\beval\s*\(|\bnew\s+Function\s*\(|\bchild_process\b|\b(execSync|execFileSync|spawnSync)\s*\(|(^|[^.\w$])exec\s*\(|\b(cp|shell|child_process)\.exec\s*\(|\bspawn\s*\([^)]*shell\s*:\s*true|\bos\.system\s*\(|\bos\.popen\s*\(|\bsubprocess\.\w+\([^)]*shell\s*=\s*True|\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*SafeLoader)|dangerouslySetInnerHTML|\.(inner|outer)HTML\s*=|\binsertAdjacentHTML\s*\(|\bv-html\b|\|\s*safe\b|\bmark_safe\s*\(|\bMarshal\.load\b|\bunserialize\s*\(|\bdocument\.write\s*\(|\bvm\.run\w*\(|\bRuntime\.getRuntime\(\)\.exec\b/;
  var PAY_WORD = /\b(stripe|paypal|braintree|adyen|billing|invoices?|payments?|payouts?|charges?|refunds?|subscriptions?|checkout|amount_?cents|amountCents|ledger|wallet)\b/i;
  var PAY_PATH = /(^|\/)(billing|payments?|checkout|invoices?|stripe|subscriptions?|ledger)([./_-]|$)/i;
  var SQL_RE = /\b(SELECT\s+[\w*,\s.()]+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|COLUMN|INDEX)|ALTER\s+TABLE|TRUNCATE)\b/i;
  var SQL_INTERP = /\$\{|["'`]\s*\+\s*\w|\w\s*\+\s*["'`]|%s|\bf["']|\.format\(|%\s*\(|\$"|#\{/;
  var DESTRUCTIVE = /\b(DROP\s+(TABLE|COLUMN|INDEX|SCHEMA|DATABASE)|TRUNCATE\b|DELETE\s+FROM\s+\w+\s*;?\s*$|ALTER\s+TABLE\s+\S+\s+DROP\b|remove_column|drop_table|dropColumn|dropTable|op\.drop_)/i;
  var HEADERS = /Access-Control-Allow-[\w-]+|\bcors\s*\(|\borigin\s*:\s*(true|["']\*["'])|Content-Security-Policy|\bhelmet\b|X-Frame-Options|Strict-Transport-Security|\bsame_?site\b|\bhttp_?only\b|\bsecure\s*:\s*false|\bcredentials\s*:\s*(true|["']include["'])|X-Content-Type-Options|Referrer-Policy|\bframe-ancestors\b/i;
  var ROUTE_LINE = /\b(app|router|server|api|route|r|fastify|\w+Router|\w+_router)\.(get|post|put|patch|delete|all|route|options|head)\s*\(\s*["'`/]|@(app|bp|router|blueprint|api)\.(route|get|post|put|delete|patch)\s*\(|@(Get|Post|Put|Patch|Delete|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\b|^\s*export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b|\bHandleFunc\s*\(|\bhttp\.Handle\s*\(|\b(re_)?path\s*\(\s*r?["'][^"']*["']\s*,|^\s*(get|post|put|patch|delete|resources?)\s+["':]/;
  var ROUTE_PATH = /(^|\/)(routes?|controllers?|handlers?|endpoints?|api)\//i;
  var NETWORK = /\b(fetch|axios(\.\w+)?|got|superagent|ky|needle)\s*\(|\bhttps?\.(get|request)\s*\(|\brequests\.(get|post|put|patch|delete|request|Session)\b|\burllib\d?\.request\b|\bhttpx\.\w+\(|\bhttp\.(Get|Post|NewRequest)\s*\(|new\s+(XMLHttpRequest|WebSocket|EventSource)\b|\bnavigator\.sendBeacon\s*\(|\bNet::HTTP\b|\bHttpClient\b|\bOkHttpClient\b/;
  var EMPTY_CATCH = /catch\s*(\(\s*[\w$:\s]*\))?\s*\{\s*\}|\.catch\s*\(\s*(\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(\{\s*\}|null|undefined|void 0)\s*\)|\.catch\s*\(\s*function\s*\([^)]*\)\s*\{\s*\}\s*\)|^\s*except(\s+[\w.,() ]+(\s+as\s+\w+)?)?\s*:\s*pass\b|\bif\s+err\s*!=\s*nil\s*\{\s*\}|rescue\s*(=>\s*\w+)?\s*;?\s*(nil|end)\b/;
  var TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b/;
  var VALID_RE = /\b(validate\w*|sanitiz\w*|isValid\w*|assert\w*|safeParse|z\.(object|string|number)|yup\.|Joi\.|check(Input|Params|Body)\w*|requireFields?|Invalid\w*Error|BadRequest\w*|ValidationError)\b|\bstatus\(\s*4(00|01|03|22)\s*\)|\braise\s+(ValueError|PermissionDenied|ValidationError|BadRequest)\b|\bthrow\s+new\s+\w*(Validation|Invalid|Forbidden|Unauthori[sz]ed)\w*/;
  var TEST_CASE = /\b(it|test|describe)(\.only)?\s*\(\s*["'`]|^\s*(async\s+)?def\s+test_\w*|^\s*func\s+Test\w*\s*\(|@Test\b|\bit\s+["']/;
  var TEST_SKIP = /\b(it|test|describe)\.skip\s*\(|\bx(it|describe|test)\s*\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip\w*\(|@Disabled\b|@Ignore\b|\bskip\s*\(\s*["']|\bpending\s*\(/;
  var CONFIG_DEFAULT = /(process\.env\.(\w+)|process\.env\[["'](\w+)["']\]|import\.meta\.env\.(\w+))\s*(\|\||\?\?)\s*(["'`][^"'`]*["'`]|-?\d[\d_.]*|true|false|null)|os\.environ\.get\(\s*["'](\w+)["']\s*,\s*([^)]+)\)|os\.getenv\(\s*["'](\w+)["']\s*,\s*([^)]+)\)|getenv\(\s*["'](\w+)["']\s*\)\s*(\?:|\|\|)\s*(\S+)/;
  var FLAG_RE = /\b(feature[_-]?flags?|FEATURE_\w+|isEnabled|isFeatureEnabled|flags?\.\w+|launchdarkly|unleash|growthbook|optimizely)\b/i;
  var INFRA_HIGH = /pull_request_target|\$\{\{\s*secrets\.|permissions:\s*write-all|(contents|packages|id-token|actions):\s*write|--privileged|privileged:\s*true|0\.0\.0\.0\/0|^\s*USER\s+root\b|curl[^|\n]*\|\s*(ba|z)?sh\b|wget[^|\n]*\|\s*(ba|z)?sh\b|hostNetwork:\s*true|allowPrivilegeEscalation:\s*true/;
  var INSTALL_SCRIPT = /^\s*"(pre|post)?install"\s*:|^\s*"prepare"\s*:/;
  var RESOLVED_ODD = /"resolved"\s*:\s*"(http:\/\/|https:\/\/(?!registry\.npmjs\.org\/|registry\.yarnpkg\.com\/)[^"]+)"|^\s*resolved\s+"(http:\/\/|https:\/\/(?!registry\.yarnpkg\.com\/|registry\.npmjs\.org\/))/;

  var LOOK = {
    access: ['Write down who could do this before and who can now - each role, a signed-out visitor, someone from another team.', 'Is the new condition stricter or looser? Try the edge cases by hand, not just the happy path.', 'Is there a test that proves a forbidden user is still refused? If not, ask for one before merging.'],
    auth: ['Every new path through this code: is the caller identified before anything happens?', 'Tokens: random enough, single-use where they should be, expiring, compared in constant time, never logged.', 'Does every error path fail closed (refuse) rather than open?'],
    secret: ['If it is a real credential, rotate it now - deleting it from the branch does not delete it from git history.', 'Load it from the environment or a secret manager instead.'],
    bidi: ['These characters can make code read differently from how it runs (Trojan source). Open the file in an editor that shows invisible characters.', 'Unless it is text that genuinely needs them (a right-to-left translation), ask for them to be removed.'],
    dangerous: ['Can any part of what reaches it come from a user, a file or the network?', 'Is there a safer call (an argument list instead of a shell string, textContent instead of HTML, a safe loader)?'],
    payments: ['Amounts in integer cents in the right currency, with explicit rounding?', 'Is every charge idempotent - a retry or a double click must not charge twice?', 'Webhooks: is the signature checked before anything in them is trusted?'],
    migration: ['Will it lock a big table while it runs (an index without CONCURRENTLY, a NOT NULL column without a default, a rewrite)?', 'Does the code that ships with it work both before and after it runs - deploys are not instant?', 'How is it undone if it goes wrong (a down migration, or a written plan)?'],
    destructive: ['Is the data being dropped backed up or copied somewhere first?', 'Run it against a copy of production data before release.'],
    sqlInterp: ['Every value passed as a query parameter, never glued into the SQL string.', 'Does the query filter by the current user or team, so one tenant cannot read another\'s rows?'],
    sql: ['Values passed as parameters, not concatenated?', 'Does it filter by the current user or team where it should?', 'Is there an index for what it filters on?'],
    headers: ['Is any new origin allowed with credentials? A wildcard origin plus cookies is an open door.', 'Cookies still HttpOnly, Secure and SameSite?'],
    testsRemoved: ['Which behaviour did the deleted or skipped test protect? Is it still covered somewhere else?', 'A skipped test is a deleted test that hides: ask why, and for a ticket to bring it back.'],
    validation: ['What does the code accept now that it refused before?', 'If the check moved somewhere else, find it before approving.'],
    route: ['Who can call it? It should sit behind the same sign-in and permission checks as its neighbours.', 'Bad input: what does it return, and does an error leak anything (a stack, an email, whether an account exists)?', 'Anything that sends mail, creates records or costs money needs a rate limit.'],
    routeNoTest: ['Ask for a test that calls the route as a stranger, as a member and as an owner.'],
    config: ['What happens in production, where the variable may not be set at all?', 'Is the new default safe for every existing deployment, not just new ones?'],
    deps: ['Is the package maintained and widely used? Look at its install scripts and what it pulls in.', 'A new major version: read its changelog for breaking changes.', 'Was the lockfile regenerated from this manifest (and nothing else)?'],
    installScript: ['An install script runs on every developer\'s and CI machine at install time. Read exactly what it runs.'],
    infra: ['Does it widen permissions, or expose a secret to forks or pull requests?', 'Are images and actions pinned (a digest or a commit SHA, not a moving tag)?'],
    infraHigh: ['This touches secrets, privileges or a piped install: read every line, and ask who reviewed it on the infrastructure side.'],
    network: ['Timeout, retry and what the code does when the call fails?', 'Is the address fixed, or can input steer it somewhere internal (SSRF)?', 'Is anything personal or secret sent?'],
    swallow: ['Should the error at least be logged - or re-thrown so the caller knows?', 'Does the caller now believe something succeeded when it did not?'],
    longLine: ['A line this long hides most of itself off-screen in review tools. Scroll to its end, or ask for it to be wrapped.'],
    genMarker: ['A hand-written file marked as generated is skipped by reviewers and tools. Ask why the marker was added.'],
    notest: ['No test changed alongside it. What would catch a mistake here?'],
    todo: ['Is the TODO a known gap that should block release, or does it have a ticket?'],
    deleted: ['Does anything still import, link to or load it? `git grep` its name on the branch.'],
    mode: ['Why does the file mode change? An executable bit on a non-script is usually a mistake.'],
    binary: ['A binary cannot be reviewed as a diff. Where did it come from, and can it be built from source instead?'],
    lockOdd: ['A package now resolves from somewhere other than the public registry. Make sure that host is yours.'],
    lowRead: ['Read every changed line once; nothing here touched a risky area.'],
  };
  /** The rules, in words. `level` 3 high, 2 medium, 1 low; `w` the weight
   *  that orders files within a level. Text never quotes code: the UI shows
   *  the matching lines beside it, exports carry the words only. */
  var REASONS = {
    access: { level: 3, w: 30, text: 'Changes an existing permission or sign-in check' },
    secret: { level: 3, w: 25, text: 'Looks like a secret or key is committed' },
    bidi: { level: 3, w: 25, text: 'Hidden characters (bidirectional or zero-width) that can make code read differently from how it runs' },
    dangerous: { level: 3, w: 15, text: 'Runs code or commands built at runtime, or writes raw HTML' },
    destructive: { level: 3, w: 15, text: 'Deletes data (DROP, TRUNCATE or a DELETE with no condition)' },
    validation: { level: 3, w: 14, text: 'Removes input validation or a guard' },
    migration: { level: 3, w: 12, text: 'Changes the database schema' },
    testsRemoved: { level: 3, w: 12, text: 'Deletes or skips tests' },
    sqlInterp: { level: 3, w: 12, text: 'Builds SQL by gluing values into the string' },
    installScript: { level: 3, w: 12, text: 'Adds a script that runs at install time' },
    infraHigh: { level: 3, w: 12, text: 'Touches CI secrets, privileges or a piped install' },
    executable: { level: 3, w: 12, text: 'Adds a binary or archive that cannot be reviewed as text' },
    binary: { level: 2, w: 4, text: 'A binary file that cannot be reviewed as a diff' },
    auth: { level: 3, w: 10, text: 'Touches sign-in, sessions, permissions or tokens' },
    payments: { level: 3, w: 10, text: 'Touches payments or billing' },
    headers: { level: 3, w: 10, text: 'Changes security headers, CORS or cookie settings' },
    routeNoTest: { level: 3, w: 9, text: 'Adds or changes an API route with no test changed alongside it' },
    lockOdd: { level: 3, w: 9, text: 'A package resolves from outside the public registry' },
    route: { level: 2, w: 6, text: 'Adds or changes an API route or handler' },
    infra: { level: 2, w: 6, text: 'Changes build, CI or infrastructure' },
    genMarker: { level: 2, w: 6, text: 'Marks an existing file as generated, which hides it from review' },
    config: { level: 2, w: 5, text: 'Changes a configuration default or feature flag' },
    deps: { level: 2, w: 5, text: 'Adds or upgrades a dependency' },
    network: { level: 2, w: 5, text: 'Makes a new network call' },
    sql: { level: 2, w: 5, text: 'Writes raw SQL' },
    longLine: { level: 2, w: 5, text: 'A very long line that hides its content off-screen' },
    swallow: { level: 2, w: 4, text: 'Swallows an error without handling it' },
    notest: { level: 1, w: 3, text: 'No test changed alongside it' },
    deleted: { level: 1, w: 2, text: 'Deletes a file' },
    todo: { level: 1, w: 1, text: 'Leaves a TODO or FIXME' },
    mode: { level: 1, w: 1, text: 'Changes the file mode' },
  };
  var LEVEL_NAME = { 3: 'high', 2: 'medium', 1: 'low', 0: 'skim' };
  var RISK = {
    high: { icon: '▲', word: 'High', title: 'Read these first' },
    medium: { icon: '◆', word: 'Medium', title: 'Then these' },
    low: { icon: '●', word: 'Low', title: 'Read quickly' },
    skim: { icon: '≈', word: 'Skim', title: 'Skim with checks' },
  };

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

  function stemOf(p) { return basename(p).replace(/\.[^.]*$/, '').replace(/\.(test|spec|stories|module|d|e2e)$/i, '').replace(/^test_|_test$|_spec$/i, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  /** Is test file `t` plausibly the test of code file `c`? The same stem, and
   *  the same folder, a __tests__ beside it, or a test path naming the code's
   *  folder (test/teams/x.test.ts for src/server/teams/x.ts). */
  function testOf(t, c) {
    if (stemOf(t) !== stemOf(c) || !stemOf(c)) return false;
    var cd = dirname(c), td = dirname(t), parent = basename(cd);
    if (td === cd || td === cd + '/__tests__' || td === cd + '/tests' || td === cd + '/test') return true;
    if (!parent) return /^(tests?|spec|__tests__)$/.test(td);
    return ('/' + td + '/').indexOf('/' + parent + '/') !== -1;
  }

  function hasSecret(t, isTest) {
    if (SECRET_RE.test(t)) return true;
    if (isTest) return false;
    var m = SECRET_ASSIGN.exec(t);
    return Boolean(m && !PLACEHOLDER.test(m[2]));
  }

  /** The reasons a file's meaningful changes carry: [{id, level, w, text,
   *  hits: [{h, i}], detail}]. */
  function detect(f, ctx) {
    var kind = f.kind, isTest = kind === 'test', isCode = kind === 'code' || kind === 'migration';
    var plus = [], minus = [];
    f.hunks.forEach(function (h, hi) {
      if (h.mech) return;
      h.lines.forEach(function (l, li) {
        if (l[0] === '+') plus.push({ t: l[1], h: hi, i: li });
        else if (l[0] === '-') minus.push({ t: l[1], h: hi, i: li });
      });
    });
    var out = Object.create(null);
    function add(id, hits, detail) {
      if (!out[id]) out[id] = { id: id, level: REASONS[id].level, w: REASONS[id].w, text: REASONS[id].text, hits: [], detail: [] };
      (hits || []).forEach(function (x) { if (out[id].hits.length < 40) out[id].hits.push({ h: x.h, i: x.i }); });
      if (detail && out[id].detail.indexOf(detail) === -1 && out[id].detail.length < 6) out[id].detail.push(detail);
    }
    function grep(arr, re) { return arr.filter(function (x) { return re.test(x.t); }); }
    var meaningful = f.hunks.some(function (h) { return !h.mech; }) || (!f.hunks.length && !f.mech);

    // Everywhere, even in tests and docs.
    var inv = grep(plus, INVISIBLE);
    if (inv.length || INVISIBLE.test(f.path)) add('bidi', inv, INVISIBLE.test(f.path) ? 'in the file name' : '');
    var sec = plus.filter(function (x) { return hasSecret(x.t, isTest); });
    if (sec.length) add('secret', sec);
    if (f.binary) {
      if (kind === 'executable' || EXECUTABLE.test(f.path)) add('executable', []);
      else if (!f.mech && f.status !== 'D') add('binary', []);
      return finish();
    }
    if (f.status === 'D' && kind !== 'test' && !f.mech) add('deleted', []);
    if (f.modeFrom && f.modeTo && f.modeFrom !== f.modeTo) add('mode', [], f.modeFrom + ' → ' + f.modeTo);
    else if (f.modeTo === '100755' && f.status === 'A' && !/\.(sh|bash|zsh|py|rb|pl)$|(^|\/)bin\//.test(f.path)) add('mode', [], 'new executable file');

    if (isTest) {
      if (f.status === 'D') add('testsRemoved', [], 'a test file deleted');
      var tcRm = grep(minus, TEST_CASE), tcAdd = grep(plus, TEST_CASE);
      if (tcRm.length > tcAdd.length) add('testsRemoved', tcRm, (tcRm.length - tcAdd.length) + ' test case' + (tcRm.length - tcAdd.length === 1 ? '' : 's') + ' fewer');
      var sk = grep(plus, TEST_SKIP);
      if (sk.length) add('testsRemoved', sk, 'a test skipped');
      return finish();
    }
    if (kind === 'doc' || kind === 'changelog' || kind === 'asset' || kind === 'other' && !CODE.test(f.path) && !CONFIG.test(f.path)) {
      if (kind === 'other' && plus.some(function (x) { return x.t.length > LIMITS.longLine; })) add('longLine', grep(plus, /.{500}/));
      return finish();
    }
    if (kind === 'lockfile') {
      var odd = grep(plus, RESOLVED_ODD);
      if (odd.length) add('lockOdd', odd);
      return finish();
    }
    if (kind === 'manifest') {
      plus.forEach(function (x) {
        var d = depOf(f.path, x.t);
        if (d) {
          var was = minus.map(function (y) { return depOf(f.path, y.t); }).filter(function (y) { return y && y.name === d.name; })[0];
          if (!was || was.ver !== d.ver) add('deps', [x], d.name + (was ? ' ' + was.ver + ' → ' + d.ver : ' ' + d.ver + ' (new)'));
        }
      });
      var inst = grep(plus, INSTALL_SCRIPT);
      if (inst.length && basename(f.path) === 'package.json') add('installScript', inst);
    }
    if (kind === 'migration' || kind === 'schema') {
      if (meaningful) add('migration', plus.slice(0, 1), kind === 'migration' ? 'a migration' : 'the schema');
      var des = grep(plus, DESTRUCTIVE);
      if (des.length) add('destructive', des);
    }
    if (kind === 'ci' || kind === 'infra') {
      if (meaningful) add('infra', [], kind === 'ci' ? 'CI' : 'infrastructure');
      var ih = grep(plus, INFRA_HIGH);
      if (ih.length) add('infraHigh', ih);
    }
    if (f.markerAdded && !f.markerCtx && f.status !== 'A') add('genMarker', grep(plus, GENERATED_MARK));

    // Configuration: the file itself, or a default read from the environment.
    if (kind === 'config' && meaningful) add('config', plus.slice(0, 3), 'a configuration file');
    var defs = function (arr) {
      var m = Object.create(null);
      arr.forEach(function (x) {
        var r = CONFIG_DEFAULT.exec(x.t);
        if (r) { var name = r[2] || r[3] || r[4] || r[7] || r[9] || r[11]; var val = r[6] || r[8] || r[10] || r[13]; if (name) m[name] = { v: String(val).trim().replace(/^["'`]|["'`]$/g, ''), x: x }; }
      });
      return m;
    };
    var dOld = defs(minus), dNew = defs(plus);
    Object.keys(dNew).forEach(function (k) {
      if (dOld[k] && dOld[k].v !== dNew[k].v) add('config', [dNew[k].x], k + ': default ' + clean(dOld[k].v, 30) + ' → ' + clean(dNew[k].v, 30));
      else if (!dOld[k] && isCode) add('config', [dNew[k].x], k + ': new setting, default ' + clean(dNew[k].v, 30));
    });
    var fl = grep(plus, FLAG_RE);
    if (fl.length && isCode) add('config', fl, 'a feature flag');

    if (!isCode && kind !== 'config' && kind !== 'other') return finish();

    // Code.
    var authPath = AUTH_PATH.test(f.path);
    var aPlus = grep(plus, AUTH_WORD), aMinus = grep(minus, AUTH_WORD);
    // A removed line that was a condition about who may act, replaced or gone.
    var accessRm = aMinus.filter(function (x) { return COND.test(x.t); });
    if (accessRm.length && f.status !== 'A') add('access', accessRm.concat(aPlus.filter(function (x) { return COND.test(x.t); })));
    if (aPlus.length || aMinus.length || (authPath && meaningful)) add('auth', aPlus.concat(aMinus).slice(0, 20), authPath ? 'in an access-control file' : '');
    var pay = grep(plus.concat(minus), PAY_WORD);
    if (pay.length || (PAY_PATH.test(f.path) && meaningful)) add('payments', pay);
    var dang = grep(plus, DANGEROUS);
    if (dang.length) add('dangerous', dang);
    var hd = grep(plus.concat(minus), HEADERS);
    if (hd.length) add('headers', hd);
    var sq = grep(plus, SQL_RE);
    if (sq.length && kind !== 'migration') {
      var interp = sq.filter(function (x) { return SQL_INTERP.test(x.t); });
      if (interp.length) add('sqlInterp', interp); else add('sql', sq);
    }
    var vRm = grep(minus, VALID_RE), vAdd = grep(plus, VALID_RE);
    if (vRm.length > vAdd.length) add('validation', vRm);
    var rt = grep(plus, ROUTE_LINE);
    if (rt.length || (ROUTE_PATH.test(f.path) && f.status === 'A' && meaningful && CODE.test(f.path))) add('route', rt);
    var net = grep(plus, NETWORK);
    if (net.length) add('network', net);
    var sw = grep(plus, EMPTY_CATCH);
    plus.forEach(function (x, k) {
      var nx = plus[k + 1];
      if (nx && nx.h === x.h && nx.i === x.i + 1 && (/catch\s*(\([^)]*\))?\s*\{\s*$/.test(x.t) && /^\s*\}\s*$/.test(nx.t) || /^\s*except\b[^:]*:\s*$/.test(x.t) && /^\s*pass\s*$/.test(nx.t))) sw.push(x);
    });
    if (sw.length) add('swallow', sw);
    var td = grep(plus, TODO_RE);
    if (td.length) add('todo', td);
    var ll = plus.filter(function (x) { return x.t.length > LIMITS.longLine; });
    if (ll.length && kind !== 'migration') add('longLine', ll);
    // No test alongside: code with a real amount of new or changed logic.
    var addedCode = plus.filter(function (x) { return x.t.trim() && !/^\s*(\/\/|#|\*|\/\*)/.test(x.t); }).length;
    if (kind === 'code' && addedCode >= 5 && !ctx.tests.some(function (t) { return testOf(t, f.path); })) {
      add('notest', []);
      if (out.route) {
        var rr = out.route; delete out.route;
        add('routeNoTest', rr.hits); out.routeNoTest.detail = rr.detail;
      }
    }
    return finish();

    function finish() {
      return Object.keys(out).map(function (k) { return out[k]; }).sort(function (a, b) { return b.level - a.level || b.w - a.w || (a.id < b.id ? -1 : 1); });
    }
  }

  /* ---------------- skim groups and their checks ---------------- */

  var SKIM = {
    rename: { icon: '🚚', title: 'Renamed or moved, nothing inside changed', why: 'git matched each one to its old path at 100% similarity: the same bytes under a new name.' },
    copy: { icon: '📄', title: 'Copied unchanged', why: 'An exact copy of a file that already exists.' },
    lockfile: { icon: '🔒', title: 'Lockfiles', why: 'Written by the package manager, not by hand.' },
    snapshot: { icon: '📸', title: 'Test snapshots', why: 'Recorded output that the test runner rewrites.' },
    generated: { icon: '⚙️', title: 'Generated code', why: 'Marked as generated, or in a generated folder.' },
    vendored: { icon: '📦', title: 'Vendored code', why: 'Someone else\'s code, copied in.' },
    minified: { icon: '🗜️', title: 'Minified or bundled files', why: 'Built from source; not meant to be read.' },
    changelog: { icon: '📰', title: 'Changelog', why: 'Prose describing the change, not the change.' },
    format: { icon: '🧹', title: 'Whitespace and formatting only', why: 'Every changed line is the same code once spaces, line breaks, quote style and trailing commas are set aside. Strings were compared exactly.' },
    imports: { icon: '🔀', title: 'Imports reordered', why: 'The same import lines, in a different order.' },
    refactor: { icon: '🏷️', title: 'Renames and moved imports', why: 'Each changed line only swaps a name renamed across the whole PR, or points an import at a file this PR moved.' },
    asset: { icon: '🖼️', title: 'Images, fonts and media', why: 'Binary assets: nothing to read as a diff.' },
  };
  var SKIM_ORDER = ['rename', 'refactor', 'format', 'imports', 'lockfile', 'generated', 'snapshot', 'vendored', 'minified', 'copy', 'asset', 'changelog'];

  function langFormatter(paths) {
    var exts = uniq(paths.map(extOf));
    var out = [];
    if (exts.some(function (e) { return /^(js|jsx|mjs|cjs|ts|tsx|css|scss|less|json|md)$/.test(e); })) out.push('npx prettier --check ' + paths.filter(function (p) { return /\.(m?[jt]sx?|cjs|css|scss|less|json|md)$/i.test(p); }).slice(0, 12).map(shq).join(' '));
    if (exts.indexOf('py') !== -1) out.push('black --check ' + paths.filter(function (p) { return /\.py$/.test(p); }).slice(0, 12).map(shq).join(' '));
    if (exts.indexOf('go') !== -1) out.push('gofmt -l ' + paths.filter(function (p) { return /\.go$/.test(p); }).slice(0, 12).map(shq).join(' '));
    if (exts.indexOf('rs') !== -1) out.push('cargo fmt --check');
    return out;
  }
  function skimCheck(key, files, refs, renames) {
    var r = refs || {}, range = shq((r.base || 'main') + '...' + (r.head || 'HEAD')), head = shq(r.head || 'HEAD');
    var paths = files.map(function (f) { return f.path; });
    var some = paths.slice(0, 12).map(shq).join(' ') + (paths.length > 12 ? ' …' : '');
    switch (key) {
      case 'rename': return { check: 'Confirm git still sees each one as a pure rename: every line ends in (100%).', cmd: ['git diff -M --summary ' + range + " | grep -E '(rename|copy) .*\\(100%\\)'"] };
      case 'copy': return { check: 'Is a second copy needed? Two copies of one file drift apart.', cmd: ['git diff -C --summary ' + range + ' | grep copy'] };
      case 'lockfile': {
        var cmds = uniq(paths.map(function (p) { return LOCKFILES[basename(p)]; }).filter(Boolean));
        return { check: 'Regenerate from the manifest and confirm the lockfile does not move; then review the manifest change instead. No package should resolve from an unknown host.', cmd: cmds.concat(['git diff --exit-code -- ' + some]) };
      }
      case 'snapshot': return { check: 'Run the tests without letting them rewrite snapshots - they must pass - and open one changed snapshot next to the change that caused it.', cmd: ['npx jest --ci', '# or: pytest --snapshot-warn-unused / the runner\'s "check only" mode'] };
      case 'generated': return { check: 'Re-run the generator and confirm nothing changes. Hand edits in a generated file are lost the next time it runs.', cmd: ['# run your generator (npm run generate, make gen, buf generate ...), then:', 'git status --porcelain -- ' + some] };
      case 'vendored': return { check: 'Compare with the upstream release it claims to be: vendored code should match a tagged version byte for byte.', cmd: [] };
      case 'minified': return { check: 'Rebuild from source and compare. Never review minified code by eye - a change can hide in one line.', cmd: [] };
      case 'changelog': return { check: 'Read it as the author\'s description: does it match what the plan above says changed?', cmd: [] };
      case 'format': return { check: 'Whitespace changes: git shows nothing when told to ignore spaces. Formatting: the formatter accepts the files as they are.', cmd: ['git diff -w --ignore-blank-lines --stat ' + range + ' -- ' + some].concat(langFormatter(paths)) };
      case 'imports': return { check: 'The same lines, reordered. Order only matters for imports with side effects (polyfills, patches): glance for those.', cmd: [] };
      case 'refactor': {
        var olds = (renames || []).map(function (x) { return x.from; });
        return { check: 'Build or type-check the branch (a wrong path or a missed name fails), and confirm the old ' + (olds.length === 1 ? 'name is' : 'names are') + ' gone everywhere.', cmd: (olds.length ? ['git grep -n -w -e ' + olds.slice(0, 6).map(shq).join(' -e ') + ' ' + head + '   # expect no output'] : []).concat(['# then your build or type check, e.g. npx tsc --noEmit']) };
      }
      case 'asset': return { check: 'Open each one and look at it.', cmd: [] };
    }
    return { check: '', cmd: [] };
  }

  /* ---------------- the analysis ---------------- */

  function lineCount(f) { return f.adds + f.dels; }

  /**
   * The whole triage of one parsed diff:
   *   files    every file with its kind, hunks (each marked mechanical or
   *            not), meaningful vs mechanical lines, risk, reasons and checklist
   *   order    file indexes: high, medium, low (each by score), then skim
   *   skim     groups of mechanical files with the check that makes skimming safe
   *   verdict  the sentence at the top, and its numbers
   *   renames  the PR-wide rename map
   */
  function analyse(parsed) {
    var files = (parsed && parsed.files) || [];
    var renames = renameMap(files);
    var moves = files.filter(function (f) { return (f.status === 'R' || f.status === 'C') && f.oldPath && f.oldPath !== f.path; }).map(function (f) { return { from: f.oldPath, to: f.path }; });
    var tests = files.filter(function (f) { return fileKind(f.path) === 'test' && f.status !== 'D'; }).map(function (f) { return f.path; });
    var ctx = { renames: renames, moves: moves, tests: tests };
    var depManifests = Object.create(null);

    var out = files.map(function (f, idx) {
      var kind = fileKind(f.path);
      var L = langOf(f.path);
      var r = {
        i: idx, path: f.path, oldPath: f.oldPath, status: f.status, similarity: f.similarity, binary: f.binary,
        modeFrom: f.modeFrom, modeTo: f.modeTo, adds: f.adds, dels: f.dels, lines: lineCount(f), cut: f.cut,
        kind: kind, hunks: f.hunks, mech: null, markerCtx: f.markerCtx, markerAdded: f.markerAdded,
      };
      // File-level mechanical kinds: by path, a generated marker that was
      // already there, a pure rename or copy, a media asset.
      var pathMech = PATH_MECH[kind] ? kind : null;
      if (!pathMech && f.markerCtx && f.status !== 'A') pathMech = 'generated';
      if (!pathMech && f.markerAdded && f.status === 'A') pathMech = 'generated';
      if (pathMech) r.mech = pathMech;
      else if ((f.status === 'R' || f.status === 'C') && !f.hunks.length && !f.binary && (f.similarity === null || f.similarity === 100) && !(f.modeFrom && f.modeTo && f.modeFrom !== f.modeTo)) r.mech = f.status === 'C' ? 'copy' : 'rename';
      else if (f.binary && (kind === 'asset' || ASSET.test(f.path)) && f.status !== 'D') r.mech = 'asset';
      // Hunk by hunk.
      r.hunks.forEach(function (h) {
        h.mech = r.mech ? { kind: r.mech, label: SKIM[r.mech].title } : hunkMech(h, L, r, ctx);
        h.same = !h.mech && !h.cut && L.mode !== 'text' && L.mode !== 'exact' ? sameLines(h, L) : {};
      });
      return r;
    });
    out.forEach(function (r) {
      var mechLines = 0, meanLines = 0, meanAdds = 0, meanDels = 0;
      r.hunks.forEach(function (h) {
        if (h.mech) mechLines += h.adds + h.dels;
        else { meanLines += h.adds + h.dels; meanAdds += h.adds; meanDels += h.dels; }
      });
      if (r.mech) { mechLines = r.lines; meanLines = 0; meanAdds = 0; meanDels = 0; }
      r.mechLines = mechLines; r.meanLines = meanLines; r.meanAdds = meanAdds; r.meanDels = meanDels;
      // All hunks mechanical: the file is too (grouped by its main kind).
      if (!r.mech && r.hunks.length && !meanLines && r.hunks.every(function (h) { return h.mech; }) && !r.binary && !(r.modeFrom && r.modeTo && r.modeFrom !== r.modeTo)) {
        var by = {};
        r.hunks.forEach(function (h) { h.mech.kinds.forEach(function (k) { by[k] = (by[k] || 0) + h.adds + h.dels + 1; }); });
        var top = Object.keys(by).sort(function (a, b) { return by[b] - by[a] || MECH_RANK[b] - MECH_RANK[a]; })[0];
        r.mech = (top === 'rename' || top === 'movepath') ? 'refactor' : top === 'imports' ? 'imports' : 'format';
        r.mechKinds = Object.keys(by);
      }
      r.reasons = r.mech ? [] : detect(r, ctx);
      if (!r.mech && r.reasons.some(function (x) { return x.id === 'deps'; })) depManifests[dirname(r.path)] = 1;
      var lvl = r.mech ? 0 : Math.max(1, r.reasons.reduce(function (m, x) { return Math.max(m, x.level); }, 0));
      r.risk = LEVEL_NAME[lvl];
      r.score = r.reasons.reduce(function (s, x) { return s + x.w; }, 0) + Math.min(4, r.meanLines / 50);
      // The checklist: what to look for, given why it is here.
      var look = [];
      r.reasons.forEach(function (x) { (LOOK[x.id] || []).forEach(function (t) { if (look.indexOf(t) === -1) look.push(t); }); });
      if (!r.mech && !look.length) look = LOOK.lowRead.slice();
      var mechH = r.hunks.filter(function (h) { return h.mech; }).length;
      if (!r.mech && mechH) look.push(mechH + ' of its ' + r.hunks.length + ' hunks are mechanical (marked below): read the other ' + (r.hunks.length - mechH) + ' closely.');
      r.look = look;
      r.mixed = !r.mech && mechH > 0;
    });
    // A lockfile that moves with a dependency change belongs to it (for the split).
    out.forEach(function (r) { if (r.mech === 'lockfile') r.withDeps = Boolean(depManifests[dirname(r.path)]); });

    var rank = { high: 3, medium: 2, low: 1, skim: 0 };
    var order = out.slice().sort(function (a, b) { return rank[b.risk] - rank[a.risk] || b.score - a.score || b.meanLines - a.meanLines || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0); }).map(function (r) { return r.i; });

    var groups = {};
    out.forEach(function (r) { if (r.mech) (groups[r.mech] = groups[r.mech] || []).push(r); });
    var skim = SKIM_ORDER.filter(function (k) { return groups[k]; }).map(function (k) {
      var fs = groups[k], lines = fs.reduce(function (s, f) { return s + f.lines; }, 0);
      return { key: k, icon: SKIM[k].icon, title: SKIM[k].title, why: SKIM[k].why, files: fs.map(function (f) { return f.i; }), lines: lines };
    });
    // Mechanical hunks inside meaningful files are skimmed too.
    var mixedLines = 0;
    out.forEach(function (r) { if (!r.mech) mixedLines += r.mechLines; });

    var t = { files: out.length, lines: 0, adds: 0, dels: 0, close: 0, low: 0, mech: 0, high: 0, medium: 0, lowFiles: 0, skimFiles: 0, mixedLines: mixedLines };
    out.forEach(function (r) {
      t.lines += r.lines; t.adds += r.adds; t.dels += r.dels; t.mech += r.mechLines;
      if (r.risk === 'high' || r.risk === 'medium') t.close += r.meanLines; else t.low += r.meanLines;
      if (r.risk === 'high') t.high++; else if (r.risk === 'medium') t.medium++; else if (r.risk === 'low') t.lowFiles++; else t.skimFiles++;
    });
    var res = { files: out, order: order, skim: skim, totals: t, renames: renames.list, moves: moves, warnings: (parsed && parsed.warnings) || [], stat: parsed && parsed.stat };
    res.verdict = verdict(res);
    res.estimate = estimate(res);
    return res;
  }

  function verdict(a) {
    var t = a.totals;
    if (!t.files) return { tone: 'none', headline: 'No changes in that diff.', sub: '' };
    var head = plural(t.lines, 'line') + ' changed - ' + fmtInt(t.close) + ' worth reading closely, ' + fmtInt(t.mech) + ' mechanical you can skim with checks.';
    var bits = [];
    if (t.low) bits.push(fmtInt(t.low) + ' more ' + (t.low === 1 ? 'is' : 'are') + ' low-risk and quick to read');
    var parts = [];
    if (t.high) parts.push(plural(t.high, 'high-risk file'));
    if (t.medium) parts.push(fmtInt(t.medium) + ' medium');
    if (t.lowFiles) parts.push(fmtInt(t.lowFiles) + ' low');
    if (t.skimFiles) parts.push(fmtInt(t.skimFiles) + ' to skim');
    var sub = plural(t.files, 'file') + ': ' + parts.join(', ') + '.' + (bits.length ? ' ' + bits.join('. ') + '.' : '');
    var tone = t.high ? 'high' : t.medium ? 'medium' : t.close + t.low ? 'low' : 'skim';
    return { tone: tone, headline: head, sub: sub };
  }

  /**
   * Review time, with the assumptions said out loud (they are in the page):
   * high risk ~20 meaningful lines a minute (200 per 10 minutes), medium
   * ~40, low ~80; a deleted line counts a third of an added one; every file
   * read closely costs a minimum (3, 2, 1 minutes); each skim group is about
   * a minute to run its check plus a few seconds a file. Rounded up to 5.
   */
  var RATE = { high: 20, medium: 40, low: 80 };
  var FLOOR = { high: 3, medium: 2, low: 1 };
  function estimate(a) {
    var parts = { high: 0, medium: 0, low: 0, skim: 0 };
    a.files.forEach(function (f) {
      if (f.risk === 'skim') return;
      var eff = f.meanAdds + f.meanDels / 3;
      parts[f.risk] += Math.max(FLOOR[f.risk], eff / RATE[f.risk]);
    });
    parts.skim = a.skim.reduce(function (s, g) { return s + 1 + g.files.length * 0.1; }, 0) + (a.totals.mixedLines ? 1 : 0);
    var up5 = function (m) { return m <= 0 ? 0 : Math.max(5, Math.ceil(m / 5) * 5); };
    var total = parts.high + parts.medium + parts.low + parts.skim;
    return {
      minutes: up5(total), highOnly: up5(parts.high), parts: { high: Math.round(parts.high), medium: Math.round(parts.medium), low: Math.round(parts.low), skim: Math.round(parts.skim) },
      assumptions: ['High risk: about 200 meaningful lines per 10 minutes, at least 3 minutes a file.', 'Medium: about 400 lines per 10 minutes, at least 2 minutes a file.', 'Low: about 800 lines per 10 minutes, at least a minute a file.', 'A deleted line counts a third of an added one.', 'Skim: about a minute per group to run its check, plus a few seconds a file.'],
    };
  }
  function fmtMinutes(m) {
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return h + ' h' + (r ? ' ' + r + ' min' : '');
  }

  /* ---------------- the split ---------------- */

  var CONCERN = {
    auth: { title: 'Sign-in and permissions', why: 'The change that most needs its own review: who may do what.' },
    payments: { title: 'Payments and billing', why: 'Money, reviewed on its own.' },
    infra: { title: 'Build, CI and infrastructure', why: 'Deploy and pipeline changes, reviewed by whoever owns them.' },
    config: { title: 'Configuration and flags', why: 'Defaults and flags, easy to read alone and easy to roll back.' },
  };
  function concernOf(f) {
    var ids = f.reasons.map(function (x) { return x.id; });
    if (ids.indexOf('access') !== -1 || (ids.indexOf('auth') !== -1 && AUTH_PATH.test(f.path))) return 'auth';
    if (ids.indexOf('payments') !== -1 && PAY_PATH.test(f.path)) return 'payments';
    if (f.kind === 'ci' || f.kind === 'infra') return 'infra';
    if (f.kind === 'config') return 'config';
    return null;
  }
  function dirKey(p) {
    var parts = p.split('/');
    parts.pop();
    if (!parts.length) return '(top level)';
    if (/^(src|lib|app|pkg|packages|apps|internal|cmd|services|modules)$/.test(parts[0]) && parts.length > 1) return parts[0] + '/' + parts[1];
    return parts[0];
  }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'part'; }

  /**
   * Stacked PRs: mechanical changes first (renames, formatting, lockfile
   * churn, generated code, snapshots - nothing to argue about), then
   * dependencies (a manifest with its lockfile), then migrations, then one
   * per concern (permissions, payments, infra, config), then by folder.
   * Tests travel with the code they test. Small folder groups fold together
   * so the stack stays short.
   */
  function splitPlan(a, refs) {
    var r = refs || {};
    var base = String(r.base || 'main'), pr = String(r.pr || '');
    var groups = [], byKey = Object.create(null);
    function g(key, title, why) {
      if (!byKey[key]) { byKey[key] = { key: key, title: title, why: why, files: [] }; groups.push(byKey[key]); }
      return byKey[key];
    }
    var codeFiles = a.files.filter(function (f) { return !f.mech && f.kind !== 'test'; });
    var assigned = Object.create(null);
    var mech = g('mechanical', 'Mechanical changes only', 'Renames, moves, formatting, lockfile churn, generated code and snapshots. Nothing in it changes behaviour, so it can be approved on its checks alone - and every later PR gets smaller.');
    a.files.forEach(function (f) {
      if (f.mech && !(f.mech === 'lockfile' && f.withDeps) && !(f.mech === 'changelog')) { mech.files.push(f.i); assigned[f.i] = 1; }
    });
    var deps = a.files.filter(function (f) { return !f.mech && f.reasons.some(function (x) { return x.id === 'deps' || x.id === 'installScript'; }); });
    if (deps.length) {
      var dg = g('deps', 'Dependencies', 'The new or upgraded packages with their lockfile, so the supply-chain question is asked once.');
      deps.forEach(function (f) { dg.files.push(f.i); assigned[f.i] = 1; });
      a.files.forEach(function (f) { if (f.mech === 'lockfile' && f.withDeps) { dg.files.push(f.i); assigned[f.i] = 1; } });
    }
    var migs = a.files.filter(function (f) { return !f.mech && !assigned[f.i] && (f.kind === 'migration' || f.kind === 'schema'); });
    if (migs.length) {
      var mg = g('migrations', 'Database migrations', 'Schema changes ship and run on their own, before the code that needs them.');
      migs.forEach(function (f) { mg.files.push(f.i); assigned[f.i] = 1; });
    }
    ['auth', 'payments', 'config', 'infra'].forEach(function (c) {
      var fs = codeFiles.filter(function (f) { return !assigned[f.i] && concernOf(f) === c; });
      if (!fs.length) return;
      var cg = g(c, CONCERN[c].title, CONCERN[c].why);
      fs.forEach(function (f) { cg.files.push(f.i); assigned[f.i] = 1; });
    });
    // Documentation travels with the feature it describes: the biggest area.
    codeFiles.forEach(function (f) {
      if (assigned[f.i] || f.kind === 'doc') return;
      var k = dirKey(f.path);
      g('dir:' + k, 'Code in ' + k, 'One area of the code, with its tests.').files.push(f.i); assigned[f.i] = 1;
    });
    // Tests travel with their code; others with their folder's group, else the last.
    a.files.forEach(function (f) {
      if (assigned[f.i] || f.mech || f.kind !== 'test') return;
      var home = null;
      groups.forEach(function (gr) { if (!home && gr.key !== 'mechanical' && gr.files.some(function (i) { return testOf(f.path, a.files[i].path); })) home = gr; });
      if (!home) {
        var stemHit = codeFiles.filter(function (c) { return stemOf(c.path) === stemOf(f.path); })[0];
        if (stemHit) home = groups.filter(function (gr) { return gr.files.indexOf(stemHit.i) !== -1; })[0];
      }
      if (!home) home = byKey['dir:' + dirKey(f.path)] || null;
      if (!home) home = g('tests', 'Tests', 'Tests that did not match any code file in this PR.');
      home.files.push(f.i); assigned[f.i] = 1;
    });
    var lines = function (gr) { return gr.files.reduce(function (s, i) { return s + a.files[i].lines; }, 0); };
    var mean = function (gr) { return gr.files.reduce(function (s, i) { return s + a.files[i].meanLines; }, 0); };
    var areas = function () { return groups.filter(function (gr) { return gr.key.indexOf('dir:') === 0 || gr.key === 'tests' || gr.key === 'other'; }); };
    // What is left (docs, a changelog) rides with the biggest area, else the last group.
    var biggest = areas().slice().sort(function (x, y) { return mean(y) - mean(x); })[0] || groups[groups.length - 1] || mech;
    a.files.forEach(function (f) { if (!assigned[f.i]) { biggest.files.push(f.i); assigned[f.i] = 1; } });
    // Fold the smallest areas together while the stack is long - into one
    // "Everything else", never two.
    while (groups.length > LIMITS.maxGroups) {
      var ds = areas();
      if (ds.length < 2) break;
      var other = ds.filter(function (gr) { return gr.key === 'other'; })[0];
      var rest = ds.filter(function (gr) { return gr !== other; }).sort(function (x, y) { return lines(x) - lines(y); });
      var x = rest[0], y = other || rest[1];
      if (!x || !y) break;
      y.files = y.files.concat(x.files);
      y.key = 'other'; y.title = 'Everything else'; y.why = 'The remaining smaller areas, together.';
      groups.splice(groups.indexOf(x), 1);
    }
    groups = groups.filter(function (gr) { return gr.files.length; });
    var risk = { high: 3, medium: 2, low: 1, skim: 0 };
    groups.forEach(function (gr, n) {
      gr.n = n + 1;
      gr.files.sort(function (i, j) { return a.files[i].path < a.files[j].path ? -1 : 1; });
      gr.lines = lines(gr);
      gr.meanLines = gr.files.reduce(function (s, i) { return s + a.files[i].meanLines; }, 0);
      gr.top = LEVEL_NAME[gr.files.reduce(function (m, i) { return Math.max(m, risk[a.files[i].risk]); }, 0)];
      gr.branch = 'triage/' + (n + 1) + '-' + slug(gr.key === 'mechanical' ? 'mechanical' : gr.key.replace(/^dir:/, '').split('/').pop());
      gr.mixed = gr.files.filter(function (i) { return a.files[i].mixed; }).length;
    });
    return { groups: groups, commands: splitCommands(a, groups, base, pr), comment: splitComment(a, groups), rules: AGENT_RULES };
  }
  function splitCommands(a, groups, base, pr) {
    var o = [];
    o.push('# Run on the PR branch with a clean working tree.');
    o.push('PR=' + (pr ? shq(pr) : '$(git rev-parse HEAD)') + '   # the PR as it is now');
    groups.forEach(function (gr, n) {
      o.push('');
      o.push('# ' + (n + 1) + '. ' + gr.title.replace(/[\r\n]/g, ' ') + ' (' + plural(gr.files.length, 'file') + ')');
      o.push('git switch -c ' + shq(gr.branch) + (n === 0 ? ' ' + shq(base) : ''));
      var restore = [], rm = [];
      gr.files.forEach(function (i) {
        var f = a.files[i];
        if (f.status === 'D') rm.push(f.path);
        else { restore.push(f.path); if (f.status === 'R' && f.oldPath && f.oldPath !== f.path) rm.push(f.oldPath); }
      });
      for (var k = 0; k < restore.length; k += 20) o.push('git restore --source="$PR" --staged --worktree -- ' + restore.slice(k, k + 20).map(shq).join(' '));
      for (var m = 0; m < rm.length; m += 20) o.push('git rm -q --ignore-unmatch -- ' + rm.slice(m, m + 20).map(shq).join(' '));
      o.push('git commit -m ' + shq('Part ' + (n + 1) + ' of ' + groups.length + ': ' + gr.title.replace(/[\r\n'"]/g, ' ')));
    });
    o.push('');
    o.push('# The stack must add up to the PR exactly - expect no output:');
    o.push('git diff "$PR" ' + shq(groups.length ? groups[groups.length - 1].branch : 'HEAD'));
    o.push('');
    o.push('# Then push each branch and open each PR against the one before it.');
    groups.forEach(function (gr) { o.push('git push -u origin ' + shq(gr.branch)); });
    return o;
  }
  function splitComment(a, groups) {
    var t = a.totals;
    var o = [];
    o.push('Thanks for this! It changes ' + plural(t.lines, 'line') + ' across ' + plural(t.files, 'file') + ', but only about ' + fmtInt(t.close + t.low) + ' of those lines are hand-written changes that need reading - the rest is mechanical, and the two are mixed together, which makes this hard to review properly before release.');
    o.push('');
    o.push('Could you split it into a stack of smaller PRs, each based on the one before?');
    o.push('');
    groups.forEach(function (gr) {
      o.push(gr.n + '. **' + mdText(gr.title) + '** - ' + plural(gr.files.length, 'file') + ', ' + plural(gr.lines, 'line') + (gr.key === 'mechanical' ? ' (no behaviour change)' : ''));
    });
    o.push('');
    o.push('Keep each test in the same PR as the code it tests, and keep formatting-only changes out of the feature PRs.' + (groups.some(function (gr) { return gr.mixed; }) ? ' Some feature files also carry formatting changes - please move those into the first PR.' : ''));
    var hi = a.order.map(function (i) { return a.files[i]; }).filter(function (f) { return f.risk === 'high'; }).slice(0, 5);
    if (hi.length) {
      o.push('');
      o.push('The parts I most want to look at closely:');
      hi.forEach(function (f) { o.push('- ' + mdCode(f.path) + ': ' + mdText(f.reasons.filter(function (x) { return x.level === 3; }).map(function (x) { return x.text.charAt(0).toLowerCase() + x.text.slice(1); }).join('; '))); });
    }
    return o.join('\n') + '\n';
  }
  var AGENT_RULES = [
    '## Keeping pull requests reviewable',
    '',
    '- Put mechanical changes - renames, moves, formatting, lockfile updates, regenerated code, snapshot updates - in their own PR with nothing else in it, and say which command produced them.',
    '- One concern per PR: a migration, a dependency, a permission change and a feature are four PRs, stacked if they depend on each other.',
    '- Keep each PR under about 400 lines of hand-written change. Mechanical changes do not count toward that, but still go in their own PR.',
    '- Never reformat, rename or move code you are not otherwise changing in the same task.',
    '- Every new or changed route, permission check or migration ships with a test in the same PR.',
    '- Never hand-edit a generated file, and never mark hand-written code as generated: change the generator\'s input and regenerate.',
    '- Start the PR description with anything that changes who can do what (permissions, sessions, tokens), configuration defaults, or new dependencies.',
    '',
  ].join('\n');

  /* ---------------- exports ---------------- */

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
  function fence(lines) {
    var body = lines.join('\n'), f = '```';
    while (body.indexOf(f) !== -1) f += '`';
    return f + (f.length === 3 ? 'sh' : '') + '\n' + body + '\n' + f;
  }
  function riskWord(r) { return RISK[r].word; }
  /** The review summary, for the PR. Paths, counts, reasons and commands -
   *  never a line of the diff, and never the names it matched. */
  function toMarkdown(a, reviewed, refs) {
    var done = reviewed || {};
    var cell = function (s) { return String(s).replace(/\|/g, '\\|'); };
    var t = a.totals, o = [];
    o.push('# Review summary (Triage)');
    o.push('');
    o.push('**' + mdText(a.verdict.headline) + '**  ');
    o.push(mdText(a.verdict.sub));
    o.push('');
    o.push('Estimated review time: about ' + fmtMinutes(a.estimate.minutes) + ' (' + fmtMinutes(a.estimate.highOnly) + ' for the high-risk files alone).');
    var nDone = a.files.filter(function (f) { return done[f.path]; }).length;
    o.push('Reviewed so far: ' + nDone + ' of ' + a.files.length + ' files.');
    o.push('');
    o.push('## Risk map');
    o.push('');
    o.push('| | File | Risk | Lines read closely | Mechanical | Why |');
    o.push('|---|---|---|---:|---:|---|');
    a.order.forEach(function (i) {
      var f = a.files[i];
      if (f.risk === 'skim') return;
      o.push('| ' + (done[f.path] ? '✓' : ' ') + ' | ' + cell(mdCode(f.path)) + ' | ' + riskWord(f.risk) + ' | ' + f.meanLines + ' | ' + f.mechLines + ' | ' + cell(mdText(f.reasons.map(function (x) { return x.text; }).join('; ') || 'No risky area touched')) + ' |');
    });
    o.push('');
    o.push('## Skimmed, and why that was safe');
    o.push('');
    if (!a.skim.length) o.push('Nothing was mechanical: every file needs reading.');
    a.skim.forEach(function (g) {
      var chk = skimCheck(g.key, g.files.map(function (i) { return a.files[i]; }), refs, a.renames);
      var doneN = g.files.filter(function (i) { return done[a.files[i].path]; }).length;
      o.push('- **' + mdText(g.title) + '** - ' + plural(g.files.length, 'file') + ', ' + plural(g.lines, 'line') + (doneN ? ' (' + doneN + ' checked)' : '') + '. ' + mdText(g.why) + ' Check: ' + mdText(chk.check));
      g.files.slice(0, 30).forEach(function (i) { var f = a.files[i]; o.push('  - ' + (done[f.path] ? '✓ ' : '') + mdCode(f.path) + (f.status === 'R' ? ' (from ' + mdCode(f.oldPath) + ')' : '')); });
      if (g.files.length > 30) o.push('  - … and ' + (g.files.length - 30) + ' more');
    });
    if (t.mixedLines) o.push('- ' + plural(t.mixedLines, 'mechanical line') + ' inside files that also carry real changes (marked in the plan).');
    if (a.renames.length) o.push('- A rename across the PR was found (' + a.renames.length + '), each checked to swap only names on otherwise identical lines.');
    o.push('');
    o.push('## What was checked');
    o.push('');
    var hi = a.order.map(function (i) { return a.files[i]; }).filter(function (f) { return f.risk === 'high' || f.risk === 'medium'; });
    if (!hi.length) o.push('Nothing high or medium risk.');
    hi.forEach(function (f) {
      o.push('- ' + (done[f.path] ? '[x] ' : '[ ] ') + mdCode(f.path) + ' (' + riskWord(f.risk) + ')');
      f.look.slice(0, 4).forEach(function (l) { o.push('  - ' + mdText(l)); });
    });
    if (a.warnings.length) { o.push(''); o.push('## Notes on reading the diff'); o.push(''); a.warnings.forEach(function (w) { o.push('- ' + mdText(w)); }); }
    o.push('');
    o.push('_Paths, counts and reasons only - no code. Worked out on the reviewer\'s device by Triage; mechanical means "the same code by these rules", not "safe"._');
    return o.join('\n') + '\n';
  }
  function toJson(a, reviewed, refs) {
    var done = reviewed || {};
    return JSON.stringify({
      triage: 'v1',
      verdict: { headline: a.verdict.headline, detail: a.verdict.sub },
      totals: a.totals,
      estimate: { minutes: a.estimate.minutes, highOnlyMinutes: a.estimate.highOnly, assumptions: a.estimate.assumptions },
      files: a.order.map(function (i) {
        var f = a.files[i];
        return { path: f.path, oldPath: f.oldPath !== f.path ? f.oldPath : undefined, status: f.status, risk: f.risk, linesChanged: f.lines, meaningfulLines: f.meanLines, mechanicalLines: f.mechLines,
          mechanical: f.mech || undefined, reasons: f.reasons.map(function (x) { return { id: x.id, level: LEVEL_NAME[x.level], text: x.text, lines: x.hits.length }; }), lookFor: f.look, reviewed: Boolean(done[f.path]) };
      }),
      skim: a.skim.map(function (g) { var c = skimCheck(g.key, g.files.map(function (i) { return a.files[i]; }), refs, a.renames); return { group: g.key, title: g.title, why: g.why, check: c.check, files: g.files.map(function (i) { return a.files[i].path; }) }; }),
      warnings: a.warnings,
    }, null, 2);
  }

  /* ---------------- the model ---------------- */

  /** What "Explain this change" sends: the file's path and the chosen
   *  hunk's lines (or the whole file's, when small enough) - nothing else.
   *  -> {path, lines, label} or {error}. Invisible characters are made
   *  visible so the model sees them too. */
  function explainPayload(f, hi) {
    if (!f) return { error: 'Pick a file first.' };
    var hunks = hi === null || hi === undefined ? f.hunks : [f.hunks[hi]].filter(Boolean);
    if (!hunks.length) return { error: 'There are no changed lines to explain here.' };
    if (hunks.some(function (h) { return h.dropped; })) return { error: 'Part of this was not kept in memory (the file is very large), so it cannot be sent as it is. Pick a smaller hunk.' };
    var lines = [];
    hunks.forEach(function (h) {
      if (hunks.length > 1 || h.header) lines.push('@@ -' + h.os + ',' + h.oc + ' +' + h.ns + ',' + h.nc + ' @@' + (h.header ? ' ' + markInvisible(h.header) : ''));
      h.lines.forEach(function (l) { lines.push(l[0] + markInvisible(l[1]).slice(0, LIMITS.explainLineLen)); });
    });
    if (lines.length > LIMITS.explainLines) return { error: 'That is ' + fmtInt(lines.length) + ' lines; up to ' + LIMITS.explainLines + ' can be sent at once. Pick one hunk.' };
    var chars = lines.reduce(function (s, l) { return s + l.length + 1; }, 0);
    if (chars > LIMITS.explainChars) return { error: 'That is too much text to send at once. Pick a smaller hunk.' };
    if (!lines.some(function (l) { return l.charAt(0) === '+' || l.charAt(0) === '-'; })) return { error: 'There are no changed lines to explain here.' };
    return { path: plainPath(f.path), lines: lines, label: hunks.length === 1 ? 'hunk' : 'file' };
  }
  function stripMarkup(v) { return typeof v === 'string' ? v.replace(/<[^>]{0,200}>/g, '').replace(/[<>]/g, '') : ''; }
  function tidy(v, max) { return clean(stripMarkup(v), max).trim(); }
  /** The model's answer, bounded and stripped. null when nothing usable. */
  function cleanExplanation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var summary = tidy(raw.summary, 700);
    var arr = function (v, n, max) { return (Array.isArray(v) ? v : []).filter(function (x) { return typeof x === 'string'; }).map(function (x) { return tidy(x, max); }).filter(Boolean).slice(0, n); };
    var risks = (Array.isArray(raw.risks) ? raw.risks : []).filter(function (x) { return x && typeof x === 'object'; })
      .map(function (x) { return { risk: tidy(x.risk, 300), line_hint: tidy(x.line_hint, 60) }; }).filter(function (x) { return x.risk; }).slice(0, 8);
    var out = { summary: summary, risks: risks, questions_for_author: arr(raw.questions_for_author, 6, 300), tests_to_add: arr(raw.tests_to_add, 6, 300) };
    if (!out.summary) return null;
    return out;
  }

  return {
    LIMITS: LIMITS, RISK: RISK, REASONS: REASONS, SKIM: SKIM, LOCKFILES: LOCKFILES, MECH_LABEL: MECH_LABEL, AGENT_RULES: AGENT_RULES,
    clean: clean, esc: esc, markInvisible: markInvisible, fmtInt: fmtInt, plural: plural, hashText: hashText, shq: shq,
    basename: basename, dirname: dirname, cleanPath: cleanPath, plainPath: plainPath, unquotePath: unquotePath, INVISIBLE: INVISIBLE,
    parseDiff: parseDiff, gatherCommand: gatherCommand,
    fileKind: fileKind, langOf: langOf, sameCode: sameCode, blocksOf: blocksOf, renameMap: renameMap, followsMove: followsMove, testOf: testOf,
    analyse: analyse, estimate: estimate, fmtMinutes: fmtMinutes, skimCheck: skimCheck, splitPlan: splitPlan,
    toMarkdown: toMarkdown, toJson: toJson, mdCode: mdCode, mdText: mdText, fence: fence,
    explainPayload: explainPayload, cleanExplanation: cleanExplanation,
  };
}));
