/* Sniff - the rules. One file, run in three places: the page and its scan
 * worker (self.SniffCore) and the server and tests (require).
 *
 * It reads code the way a careful person skims it before installing: what
 * the code could get its hands on (SOURCES), the ways it could send
 * something out (SINKS), what it does to hide (HIDING), what runs the moment
 * it is installed (INSTALL), what a browser extension asks to be allowed
 * (PERMISSIONS), every place it names (DESTINATIONS) - and, the headline,
 * where a source and a sink meet (FLOWS).
 *
 * This is static reading, not proof. It finds what code COULD do, from what
 * the text says; it does not run anything, and code that builds its calls at
 * run time can hide from any reader. Everything here is pure and
 * deterministic, and touches no network and no storage.
 *
 *   reading     openArchive (zip, crx, tgz/tar.gz, tar), collect (bounds,
 *               what is skipped and why), langOf
 *   rules       RULES per language, run line by line with a keyword prefilter
 *   special     package.json, manifest.json, setup.py, pyproject.toml
 *   places      destinations, tagged risky / first-party / known / unknown
 *   flows       source -> sink, by a variable, by distance, by a message
 *               between extension scripts, or by an import
 *   report      scan -> {verdict, findings, flows, map, destinations,
 *               permissions, files, skipped}; toMarkdown, toJson
 *   the model   contextOf, explainPayload, reviewPayload, cleanOpinion
 *
 * Every string that came from a scanned file - a path, a line, a URL - is
 * hostile by definition. It is only ever drawn through esc(), and every
 * export escapes for its own format.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SniffCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    inputBytes: 200 * 1024 * 1024,  // a dropped file or archive bigger than this is refused
    unpacked: 160 * 1024 * 1024,    // what a .tgz may unpack to before the rest is cut
    entries: 20000,                 // files looked at in one drop (read or skipped)
    files: 3000,                    // code files read
    totalBytes: 40 * 1024 * 1024,   // code read in all
    fileBytes: 2 * 1024 * 1024,     // read of one file (the rest is cut, and said so)
    longLine: 5000,                 // a line longer than this is "packed"
    findings: 1500,                 // findings kept (the rest are counted)
    linesPerFinding: 40,            // line numbers listed per grouped finding
    snippet: 160,                   // characters of a line shown with a finding
    flowLines: 40,                  // a source and a sink this close are "nearby"
    flowChars: 3000,                // ...or this close on one very long line
    pathLen: 400,
    urlLen: 300,
    skippedKept: 2000,              // skipped paths listed (all are counted)
    contextLines: 20,               // lines either side sent to the model
    contextLineChars: 400,          // characters per line sent
    explainChars: 16000,            // characters sent to "Explain this finding"
    reviewSnippets: 40,             // snippets sent to "Second opinion"
    reviewChars: 48000,             // characters sent to "Second opinion"
    reviewFindings: 80,             // finding titles sent to "Second opinion"
  };

  /* ---------------- text ---------------- */

  var CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF]/g;
  var INVISIBLE_G = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF\u00AD]/g;
  /** A string safe to show as text: control, bidi and zero-width characters removed, bounded. */
  function clean(v, max) {
    if (v === null || v === undefined) return '';
    var s = String(v).replace(/\t/g, ' ').replace(/[\r\n]+/g, ' ').replace(CTRL, '');
    var m = max || 500;
    return s.length > m ? s.slice(0, m - 1) + '…' : s;
  }
  /** HTML-escape (quotes too), and drop control, bidi and zero-width characters. */
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(CTRL, '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /** Invisible characters made visible, as ⟨U+202E⟩ - in snippets, and in what the model is sent. */
  function markInvisible(s) {
    return String(s).replace(INVISIBLE_G, function (c) { return '⟨U+' + ('000' + c.charCodeAt(0).toString(16).toUpperCase()).slice(-4) + '⟩'; })
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, function (c) { return '⟨' + c.charCodeAt(0).toString(16) + '⟩'; });
  }
  function fmtInt(n) { n = Math.round(Number(n) || 0); return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function plural(n, one, many) { return fmtInt(n) + ' ' + (Number(n) === 1 ? one : (many || one + 's')); }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return fmtInt(n) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  /** A short, stable fingerprint (two FNV-1a passes, hex). Never sent anywhere. */
  function hashText(s) {
    s = String(s || '');
    var a = 2166136261, b = 5381;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      a ^= c; a = Math.imul(a, 16777619) >>> 0;
      b = (Math.imul(b, 33) + c) >>> 0;
    }
    return ('0000000' + a.toString(16)).slice(-8) + ('0000000' + b.toString(16)).slice(-8);
  }
  function basename(p) { var i = p.lastIndexOf('/'); return i === -1 ? p : p.slice(i + 1); }
  function dirname(p) { var i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); }
  function extOf(p) { var b = basename(p).toLowerCase(); var i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i + 1); }
  var SEV = { high: 3, medium: 2, low: 1, info: 0 };
  var SEV_WORD = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
  var SEV_ICON = { high: '▲', medium: '◆', low: '●', info: '○' };
  function bump(sev) { return sev === 'info' ? 'low' : sev === 'low' ? 'medium' : 'high'; }
  function maxSev(a, b) { return SEV[a] >= SEV[b] ? a : b; }

  /** A path as it will be shown and keyed: forward slashes, no leading ./ or /, bounded. */
  function normPath(p) {
    var s = String(p || '').replace(/\\/g, '/').replace(CTRL, '').replace(/^(?:\.\/|\/)+/, '').replace(/\/{2,}/g, '/');
    if (s.length > LIMITS.pathLen) s = s.slice(0, LIMITS.pathLen - 1) + '…';
    return s || '(unnamed)';
  }
  /** One shared top folder ("package/", "repo-main/") is dropped from every path. */
  function stripCommonRoot(paths) {
    if (paths.length < 2) return { root: '', paths: paths.slice() };
    var first = paths[0].split('/')[0];
    if (!first || paths[0].indexOf('/') === -1) return { root: '', paths: paths.slice() };
    for (var i = 1; i < paths.length; i++) if (paths[i].split('/')[0] !== first || paths[i].indexOf('/') === -1) return { root: '', paths: paths.slice() };
    return { root: first, paths: paths.map(function (p) { return p.slice(first.length + 1); }) };
  }

  /* ---------------- what is read, and what is skipped ---------------- */

  var SKIP_DIRS = { node_modules: 'dependencies', bower_components: 'dependencies', 'site-packages': 'dependencies', '.venv': 'dependencies', venv: 'dependencies', '.git': 'history', '.hg': 'history', '.svn': 'history', __pycache__: 'cache', '.mypy_cache': 'cache', '.pytest_cache': 'cache', '.tox': 'cache' };
  var LOCKFILES = { 'package-lock.json': 1, 'npm-shrinkwrap.json': 1, 'yarn.lock': 1, 'pnpm-lock.yaml': 1, 'bun.lockb': 1, 'bun.lock': 1, 'poetry.lock': 1, 'pipfile.lock': 1, 'uv.lock': 1, 'cargo.lock': 1, 'composer.lock': 1, 'gemfile.lock': 1, 'pdm.lock': 1 };
  var SKIP_EXT = {
    image: 'png jpg jpeg gif webp ico bmp svg avif tif tiff heic',
    font: 'woff woff2 ttf otf eot',
    media: 'mp3 mp4 wav ogg webm mov m4a flac avi',
    archive: 'zip gz tgz tar 7z rar jar war xpi crx bz2 xz whl egg',
    binary: 'exe dll so dylib node wasm class pyc pyo o a lib bin dat db sqlite',
    document: 'pdf doc docx xls xlsx ppt pptx',
    sourcemap: 'map',
    style: 'css scss sass less styl',
    text: 'md markdown txt rst adoc license licence',
    data: 'json yml yaml csv tsv xml lock ini cfg conf properties env sample',
  };
  var EXT_REASON = {};
  Object.keys(SKIP_EXT).forEach(function (k) { SKIP_EXT[k].split(' ').forEach(function (e) { EXT_REASON[e] = k; }); });
  var REASON_WORDS = {
    dependencies: 'Other packages it depends on - scan those on their own',
    history: 'Version-control history',
    cache: 'Caches',
    lockfile: 'Lockfiles (versions, not code)',
    image: 'Images',
    font: 'Fonts',
    media: 'Audio and video',
    archive: 'Archives inside the drop - scan each on its own',
    binary: 'Compiled or binary files - these cannot be read as text',
    document: 'Documents',
    sourcemap: 'Source maps',
    style: 'Stylesheets',
    text: 'Docs and text',
    data: 'Data and config files',
    other: 'Files of a kind Sniff does not read',
    empty: 'Empty files',
    'too-many': 'Past the ' + fmtInt(LIMITS.files) + '-file limit',
    'too-much': 'Past the ' + fmtBytes(LIMITS.totalBytes) + ' total',
    'too-many-entries': 'Past the ' + fmtInt(LIMITS.entries) + '-entry limit',
    encrypted: 'Encrypted inside the zip',
    unsupported: 'Packed in a way Sniff cannot unpack',
    unreadable: 'Could not be read',
    link: 'Links',
  };
  function skipDir(name) { return Object.prototype.hasOwnProperty.call(SKIP_DIRS, name) ? SKIP_DIRS[name] : null; }

  var JS_EXT = { js: 1, mjs: 1, cjs: 1, jsx: 1, ts: 1, tsx: 1, mts: 1, cts: 1, vue: 1, svelte: 1 };
  /** The language a path is read as, or null. `head` is the file's first bytes as text (for a shebang). */
  function langOf(path, head) {
    var b = basename(path).toLowerCase(), e = extOf(path);
    if (b === 'manifest.json') return 'manifest';
    if (b === 'package.json') return 'pkg';
    if (b === 'pyproject.toml' || b === 'setup.cfg') return 'pyproject';
    if (JS_EXT[e]) return 'js';
    if (e === 'html' || e === 'htm') return 'html';
    if (e === 'py' || e === 'pyw') return 'py';
    if (e === 'sh' || e === 'bash' || e === 'zsh' || e === 'ksh' || e === 'command') return 'sh';
    if (e === 'ps1' || e === 'psm1' || e === 'psd1') return 'ps';
    if (e === 'bat' || e === 'cmd') return 'bat';
    if (!e && head) {
      var m = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(head);
      if (m) {
        var prog = basename(m[1] === '/usr/bin/env' || /\/env$/.test(m[1]) ? (m[2] || '') : m[1]);
        if (/^node|^deno|^bun/.test(prog)) return 'js';
        if (/^python/.test(prog)) return 'py';
        if (/^(?:ba|z|k|da)?sh$/.test(prog)) return 'sh';
        if (/^pwsh|^powershell/.test(prog)) return 'ps';
      }
    }
    return null;
  }
  var LANG_WORD = { js: 'JavaScript / TypeScript', html: 'HTML', py: 'Python', sh: 'Shell', ps: 'PowerShell', bat: 'Windows batch', manifest: 'Extension manifest', pkg: 'npm package.json', pyproject: 'Python packaging' };

  /** Before reading: should this path be read? -> {lang} or {skip: reason}. */
  function classify(path, size) {
    var segs = path.split('/');
    for (var i = 0; i < segs.length - 1; i++) { var r = skipDir(segs[i]); if (r) return { skip: r }; }
    var b = basename(path).toLowerCase();
    if (LOCKFILES[b]) return { skip: 'lockfile' };
    if (size === 0) return { skip: 'empty' };
    var lang = langOf(path, '');
    if (lang) return { lang: lang };
    if (b === 'setup.py') return { lang: 'py' };
    var e = extOf(path);
    if (/\.min\.js$/.test(b)) return { lang: 'js' };
    if (EXT_REASON[e]) return { skip: EXT_REASON[e] };
    if (!e) return { maybe: true }; // read the head for a shebang
    return { skip: 'other' };
  }

  /* ---------------- archives ---------------- */

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; }
  function u64(b, o) { return u32(b, o) + u32(b, o + 4) * 4294967296; }
  function latin1(b) { var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
  function utf8(b) { return new TextDecoder('utf-8', { fatal: false }).decode(b); }
  function streamsOk() { return typeof DecompressionStream === 'function' && typeof Blob === 'function'; }

  /** Inflate with the platform's DecompressionStream, stopping at `max` bytes
   *  of output (a zip bomb is cut, not swallowed). -> {bytes, cut} */
  function inflate(bytes, format, max) {
    if (!streamsOk()) return Promise.reject(Object.assign(new Error('This browser cannot unpack archives. Unpack it yourself and drop the folder.'), { code: 'no-streams' }));
    var reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
    var chunks = [], got = 0, cut = false;
    function step() {
      return reader.read().then(function (r) {
        if (r.done) return;
        var v = r.value;
        if (got + v.length > max) { chunks.push(v.subarray(0, max - got)); got = max; cut = true; try { reader.cancel(); } catch (e) { /* ignore */ } return; }
        chunks.push(v); got += v.length;
        return step();
      });
    }
    return step().then(function () {
      var out = new Uint8Array(got), o = 0;
      chunks.forEach(function (c) { out.set(c, o); o += c.length; });
      return { bytes: out, cut: cut };
    });
  }

  /** What kind of archive the bytes are, by their first bytes (then the name). */
  function archiveKind(bytes, name) {
    var b = bytes;
    if (b.length >= 4 && b[0] === 0x43 && b[1] === 0x72 && b[2] === 0x32 && b[3] === 0x34) return 'crx'; // "Cr24"
    if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) ) return 'zip';
    if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
    if (b.length >= 262 && latin1(b.subarray(257, 262)) === 'ustar') return 'tar';
    var n = String(name || '').toLowerCase();
    if (/\.(zip|xpi|crx|whl|jar)$/.test(n)) return 'zip-ish';
    return null;
  }

  /** A CRX (Chrome extension package): the header stripped, the zip inside. */
  function crxToZip(bytes) {
    var b = bytes;
    if (b.length < 16 || latin1(b.subarray(0, 4)) !== 'Cr24') throw new Error('Not a Chrome extension package.');
    var version = u32(b, 4), start = -1;
    if (version === 2) start = 16 + u32(b, 8) + u32(b, 12);
    else if (version === 3) start = 12 + u32(b, 8);
    if (start < 0 || start + 4 > b.length || b[start] !== 0x50 || b[start + 1] !== 0x4b) {
      // An unknown header: look for the zip's first local header.
      start = -1;
      for (var i = 8; i < Math.min(b.length - 4, 1 << 20); i++) if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 3 && b[i + 3] === 4) { start = i; break; }
      if (start < 0) throw new Error('That .crx has no zip inside it.');
    }
    return { zip: b.subarray(start), version: version };
  }

  /** The central directory of a zip -> [{path, size, read(max)}] and skipped. */
  function zipEntries(bytes) {
    var b = bytes, eocd = -1;
    for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) { eocd = i; break; }
    if (eocd < 0) throw new Error('That zip could not be read - it may be cut short.');
    var count = u16(b, eocd + 10), cdOff = u32(b, eocd + 16);
    if (count === 0xffff || cdOff === 0xffffffff) {
      var loc = eocd - 20;
      if (loc >= 0 && u32(b, loc) === 0x07064b50) {
        var z64 = u64(b, loc + 8);
        if (z64 + 56 <= b.length && u32(b, z64) === 0x06064b50) { count = u64(b, z64 + 32); cdOff = u64(b, z64 + 48); }
      }
    }
    var out = [], skipped = [], p = cdOff;
    for (var n = 0; n < count && p + 46 <= b.length; n++) {
      if (u32(b, p) !== 0x02014b50) break;
      var flags = u16(b, p + 8), method = u16(b, p + 10), csize = u32(b, p + 20), size = u32(b, p + 24);
      var nl = u16(b, p + 28), xl = u16(b, p + 30), cl = u16(b, p + 32), lo = u32(b, p + 42);
      var nameB = b.subarray(p + 46, p + 46 + nl);
      var name = (flags & 0x800) ? utf8(nameB) : latin1(nameB);
      var x = p + 46 + nl, xe = x + xl;
      while (x + 4 <= xe) {
        var id = u16(b, x), len = u16(b, x + 2), q = x + 4;
        if (id === 1) {
          if (size === 0xffffffff && q + 8 <= x + 4 + len) { size = u64(b, q); q += 8; }
          if (csize === 0xffffffff && q + 8 <= x + 4 + len) { csize = u64(b, q); q += 8; }
          if (lo === 0xffffffff && q + 8 <= x + 4 + len) { lo = u64(b, q); }
        }
        x += 4 + len;
      }
      p = xe + cl;
      if (/\/$/.test(name)) continue;
      if (flags & 1) { skipped.push({ path: name, reason: 'encrypted' }); continue; }
      if (method !== 0 && method !== 8) { skipped.push({ path: name, reason: 'unsupported' }); continue; }
      out.push(zipReader(b, name, method, csize, size, lo));
    }
    return { entries: out, skipped: skipped };
  }
  function zipReader(b, name, method, csize, size, lo) {
    return {
      path: name, size: size,
      read: function (max) {
        if (lo + 30 > b.length || u32(b, lo) !== 0x04034b50) return Promise.reject(new Error('bad local header'));
        var start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
        var data = b.subarray(start, Math.min(b.length, start + csize));
        if (method === 0) return Promise.resolve({ bytes: data.subarray(0, Math.min(data.length, max)), cut: data.length > max });
        return inflate(data, 'deflate-raw', max);
      },
    };
  }

  function octal(b, o, n) {
    if (b[o] & 0x80) { var v = 0; for (var i = 1; i < n; i++) v = v * 256 + b[o + i]; return v; }
    var s = latin1(b.subarray(o, o + n)).replace(/\0.*$/, '').trim();
    return s ? parseInt(s, 8) || 0 : 0;
  }
  function cstr(b, o, n) { var e = o; while (e < o + n && b[e]) e++; return utf8(b.subarray(o, e)); }
  /** A tar (an npm tarball once gunzipped) -> [{path, size, read(max)}] and skipped. */
  function tarEntries(bytes) {
    var b = bytes, out = [], skipped = [], p = 0, longName = null, paxPath = null;
    while (p + 512 <= b.length) {
      var zero = true;
      for (var i = 0; i < 512; i++) if (b[p + i]) { zero = false; break; }
      if (zero) break;
      var name = cstr(b, p, 100), size = octal(b, p + 124, 12), type = String.fromCharCode(b[p + 156] || 48);
      if (latin1(b.subarray(p + 257, p + 262)) === 'ustar') { var pre = cstr(b, p + 345, 155); if (pre) name = pre + '/' + name; }
      var data = p + 512, next = data + Math.ceil(size / 512) * 512;
      if (type === 'L') { longName = cstr(b, data, Math.min(size, 4096)); p = next; continue; }
      if (type === 'x') {
        var rec = utf8(b.subarray(data, Math.min(b.length, data + Math.min(size, 65536))));
        var m = /(?:^|\n)\d+ path=([^\n]*)/.exec(rec);
        if (m) paxPath = m[1];
        p = next; continue;
      }
      if (type === 'g') { p = next; continue; }
      if (longName) { name = longName; longName = null; }
      if (paxPath) { name = paxPath; paxPath = null; }
      if (type === '0' || type === '\0' || type === '7') {
        (function (start, len, nm) {
          out.push({ path: nm, size: len, read: function (max) { var e = Math.min(b.length, start + len); return Promise.resolve({ bytes: b.subarray(start, Math.min(e, start + max)), cut: len > max }); } });
        }(data, size, name));
      } else if (type === '1' || type === '2') skipped.push({ path: name, reason: 'link' });
      p = next;
    }
    return { entries: out, skipped: skipped };
  }

  /** Bytes of a dropped file -> {kind, entries, skipped, notes}. Rejects with a sentence. */
  function openArchive(bytes, name) {
    var kind = archiveKind(bytes, name), notes = [];
    if (bytes.length > LIMITS.inputBytes) return Promise.reject(new Error('That file is over ' + fmtBytes(LIMITS.inputBytes) + '. Unpack it and drop the folder you want read.'));
    try {
      if (kind === 'crx') { var c = crxToZip(bytes); var z = zipEntries(c.zip); return Promise.resolve({ kind: 'crx', entries: z.entries, skipped: z.skipped, notes: ['A Chrome extension package (CRX' + c.version + '); its signature header was set aside and the zip inside read.'] }); }
      if (kind === 'zip' || kind === 'zip-ish') { var z2 = zipEntries(bytes); return Promise.resolve({ kind: 'zip', entries: z2.entries, skipped: z2.skipped, notes: notes }); }
      if (kind === 'tar') { var t = tarEntries(bytes); return Promise.resolve({ kind: 'tar', entries: t.entries, skipped: t.skipped, notes: notes }); }
    } catch (e) { return Promise.reject(e); }
    if (kind === 'gzip') {
      return inflate(bytes, 'gzip', LIMITS.unpacked).then(function (r) {
        if (r.cut) notes.push('It unpacks to more than ' + fmtBytes(LIMITS.unpacked) + '; only the first part was read.');
        var raw = r.bytes;
        if (raw.length >= 262 && latin1(raw.subarray(257, 262)) === 'ustar' || /\.(tgz|tar\.gz)$/i.test(String(name || ''))) {
          var t2 = tarEntries(raw);
          return { kind: 'tgz', entries: t2.entries, skipped: t2.skipped, notes: notes };
        }
        // A single gzipped file.
        var inner = String(name || 'file').replace(/\.gz$/i, '');
        return { kind: 'gz', entries: [{ path: inner, size: raw.length, read: function (max) { return Promise.resolve({ bytes: raw.subarray(0, max), cut: raw.length > max }); } }], skipped: [], notes: notes };
      });
    }
    return Promise.resolve(null);
  }

  /** Bytes -> text, or null for a binary file. UTF-16 (a PowerShell habit) is decoded. */
  function decodeText(bytes) {
    var b = bytes;
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
    var n = Math.min(b.length, 8000);
    for (var i = 0; i < n; i++) if (b[i] === 0) return null;
    var s = utf8(b);
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  }

  /**
   * Entries ({path, size, read(max)}) -> the files to scan, bounded, with
   * everything left out said. Async, reading one file at a time.
   * -> {files: [{path, lang, text, bytes, cut}], skipped: [{path, reason}], counts, root, bytes}
   */
  function collect(entries, preSkipped, onProgress) {
    var paths = entries.map(function (e) { return normPath(e.path); });
    var sr = stripCommonRoot(paths);
    var files = [], skipped = [], counts = {}, total = 0, seen = {};
    function skip(path, reason) {
      counts[reason] = (counts[reason] || 0) + 1;
      if (skipped.length < LIMITS.skippedKept) skipped.push({ path: path, reason: reason });
    }
    (preSkipped || []).forEach(function (s) { skip(normPath(s.path), s.reason); });
    var order = entries.map(function (e, i) { return i; });
    // Manifests first (they decide what is first-party), then code by path.
    order.sort(function (x, y) {
      var a = sr.paths[x], b2 = sr.paths[y];
      var ka = /(?:^|\/)(?:package|manifest)\.json$|(?:^|\/)(?:setup\.py|pyproject\.toml)$/.test(a) ? 0 : 1;
      var kb = /(?:^|\/)(?:package|manifest)\.json$|(?:^|\/)(?:setup\.py|pyproject\.toml)$/.test(b2) ? 0 : 1;
      return ka - kb || (a < b2 ? -1 : a > b2 ? 1 : 0);
    });
    var k = 0;
    function next() {
      if (k >= order.length) return Promise.resolve();
      var idx = order[k++], e = entries[idx], path = sr.paths[idx];
      if (onProgress && k % 25 === 0) onProgress(k, order.length);
      if (seen[path]) return next();
      seen[path] = 1;
      if (k > LIMITS.entries) { skip(path, 'too-many-entries'); return next(); }
      var c = classify(path, e.size);
      if (c.skip) { skip(path, c.skip); return next(); }
      if (files.length >= LIMITS.files) { skip(path, 'too-many'); return next(); }
      if (total >= LIMITS.totalBytes) { skip(path, 'too-much'); return next(); }
      var max = Math.min(LIMITS.fileBytes, LIMITS.totalBytes - total);
      return Promise.resolve().then(function () { return e.read(max); }).then(function (r) {
        var text = decodeText(r.bytes);
        if (text === null) { skip(path, 'binary'); return next(); }
        var lang = c.lang || langOf(path, text.slice(0, 200));
        if (!lang) { skip(path, 'other'); return next(); }
        if (!text.trim()) { skip(path, 'empty'); return next(); }
        total += r.bytes.length;
        files.push({ path: path, lang: lang, text: text, bytes: r.bytes.length, size: e.size || r.bytes.length, cut: Boolean(r.cut) });
        return next();
      }, function () { skip(path, 'unreadable'); return next(); });
    }
    return next().then(function () {
      return { files: files, skipped: skipped, counts: counts, root: sr.root, bytes: total };
    });
  }

  /** Pasted text -> one file, named by what it looks like. */
  function pastedFile(text) {
    var t = String(text || '');
    var name = 'pasted.js';
    if (/^\s*\{[\s\S]*"manifest_version"\s*:/.test(t)) name = 'manifest.json';
    else if (/^\s*\{[\s\S]*"(?:scripts|dependencies|devDependencies)"\s*:/.test(t) && /"name"\s*:/.test(t)) name = 'package.json';
    else if (/^#!.*python|^\s*(?:import \w+|from \w+(?:\.\w+)* import )/m.test(t) && !/\b(?:const|let|function|=>)\b/.test(t)) name = 'pasted.py';
    else if (/^#!.*(?:ba|z)?sh\b/.test(t) || /^\s*(?:curl|wget|echo|export|sudo|apt|chmod)\s/m.test(t) && !/[;{}]\s*$/m.test(t)) name = 'pasted.sh';
    else if (/\b(?:Invoke-WebRequest|Write-Host|Get-ChildItem|\$env:|param\s*\()/i.test(t)) name = 'pasted.ps1';
    else if (/\bsetup\s*\(\s*name\s*=/.test(t)) name = 'setup.py';
    return { path: name, lang: langOf(name, '') || (name === 'setup.py' ? 'py' : 'js'), text: t, bytes: t.length, size: t.length, cut: false };
  }

  /* ---------------- places: destinations ---------------- */

  var RISKY = [
    // [host suffix, path prefix or '', label, why]
    ['discord.com', '/api/webhooks', 'a Discord webhook', 'Anyone holding a webhook link can post to it - and whoever made it reads everything sent. A common drop-box for stolen data.'],
    ['discordapp.com', '/api/webhooks', 'a Discord webhook', 'Anyone holding a webhook link can post to it - and whoever made it reads everything sent. A common drop-box for stolen data.'],
    ['api.telegram.org', '/bot', 'a Telegram bot', 'A bot token lets anyone push messages into a chat they control. A common way to collect stolen data.'],
    ['pastebin.com', '', 'a paste site', 'Paste sites take anonymous text. Code has little reason to post to one.'],
    ['hastebin.com', '', 'a paste site', 'Paste sites take anonymous text.'],
    ['toptal.com', '/developers/hastebin', 'a paste site', 'Paste sites take anonymous text.'],
    ['paste.ee', '', 'a paste site', 'Paste sites take anonymous text.'],
    ['ghostbin.co', '', 'a paste site', 'Paste sites take anonymous text.'],
    ['rentry.co', '', 'a paste site', 'Paste sites take anonymous text.'],
    ['dpaste.com', '', 'a paste site', 'Paste sites take anonymous text.'],
    ['dpaste.org', '', 'a paste site', 'Paste sites take anonymous text.'],
    ['termbin.com', '', 'a paste site', 'Paste sites take anonymous text.'],
    ['transfer.sh', '', 'an anonymous file drop', 'Anyone can upload to it and get a link back - handy for moving stolen files.'],
    ['file.io', '', 'an anonymous file drop', 'Anyone can upload to it and get a link back.'],
    ['0x0.st', '', 'an anonymous file drop', 'Anyone can upload to it and get a link back.'],
    ['bashupload.com', '', 'an anonymous file drop', 'Anyone can upload to it and get a link back.'],
    ['temp.sh', '', 'an anonymous file drop', 'Anyone can upload to it and get a link back.'],
    ['oshi.at', '', 'an anonymous file drop', 'Anyone can upload to it and get a link back.'],
    ['gofile.io', '', 'an anonymous file drop', 'Anyone can upload to it and get a link back.'],
    ['catbox.moe', '', 'an anonymous file drop', 'Anyone can upload to it and get a link back.'],
    ['filebin.net', '', 'an anonymous file drop', 'Anyone can upload to it and get a link back.'],
    ['keep.sh', '', 'an anonymous file drop', 'Anyone can upload to it and get a link back.'],
    ['ngrok.io', '', 'a tunnel to someone\u2019s own computer', 'Tunnels give a laptop a public address for a while. Shipped code pointing at one is pointing at a person, not a company.'],
    ['ngrok-free.app', '', 'a tunnel to someone\u2019s own computer', 'Tunnels give a laptop a public address for a while.'],
    ['ngrok.app', '', 'a tunnel to someone\u2019s own computer', 'Tunnels give a laptop a public address for a while.'],
    ['ngrok.dev', '', 'a tunnel to someone\u2019s own computer', 'Tunnels give a laptop a public address for a while.'],
    ['loca.lt', '', 'a tunnel to someone\u2019s own computer', 'Tunnels give a laptop a public address for a while.'],
    ['localtunnel.me', '', 'a tunnel to someone\u2019s own computer', 'Tunnels give a laptop a public address for a while.'],
    ['serveo.net', '', 'a tunnel to someone\u2019s own computer', 'Tunnels give a laptop a public address for a while.'],
    ['trycloudflare.com', '', 'a tunnel to someone\u2019s own computer', 'Quick tunnels give a laptop a public address for a while.'],
    ['localhost.run', '', 'a tunnel to someone\u2019s own computer', 'Tunnels give a laptop a public address for a while.'],
    ['pinggy.io', '', 'a tunnel to someone\u2019s own computer', 'Tunnels give a laptop a public address for a while.'],
    ['bore.pub', '', 'a tunnel to someone\u2019s own computer', 'Tunnels give a laptop a public address for a while.'],
    ['requestbin.com', '', 'a request catcher', 'A free inbox that keeps whatever is sent to it. Testing tools use them; so do people collecting data.'],
    ['requestbin.net', '', 'a request catcher', 'A free inbox that keeps whatever is sent to it.'],
    ['pipedream.net', '', 'a request catcher', 'A free inbox that keeps whatever is sent to it.'],
    ['webhook.site', '', 'a request catcher', 'A free inbox that keeps whatever is sent to it.'],
    ['beeceptor.com', '', 'a request catcher', 'A free inbox that keeps whatever is sent to it.'],
    ['hookbin.com', '', 'a request catcher', 'A free inbox that keeps whatever is sent to it.'],
    ['requestcatcher.com', '', 'a request catcher', 'A free inbox that keeps whatever is sent to it.'],
    ['postb.in', '', 'a request catcher', 'A free inbox that keeps whatever is sent to it.'],
    ['interact.sh', '', 'an out-of-band catcher', 'Used to prove a request was made - security testing, or a quiet way to collect data.'],
    ['oast.pro', '', 'an out-of-band catcher', 'Used to prove a request was made.'],
    ['oast.live', '', 'an out-of-band catcher', 'Used to prove a request was made.'],
    ['oast.site', '', 'an out-of-band catcher', 'Used to prove a request was made.'],
    ['oast.online', '', 'an out-of-band catcher', 'Used to prove a request was made.'],
    ['oast.fun', '', 'an out-of-band catcher', 'Used to prove a request was made.'],
    ['oast.me', '', 'an out-of-band catcher', 'Used to prove a request was made.'],
    ['oastify.com', '', 'an out-of-band catcher', 'Used to prove a request was made.'],
    ['burpcollaborator.net', '', 'an out-of-band catcher', 'Used to prove a request was made.'],
    ['canarytokens.com', '', 'an out-of-band catcher', 'Used to prove a request was made.'],
    ['dnslog.cn', '', 'a DNS catcher', 'Data can leave inside the name being looked up.'],
    ['ceye.io', '', 'a DNS catcher', 'Data can leave inside the name being looked up.'],
    ['duckdns.org', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer, and change whenever its owner likes.'],
    ['ddns.net', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer, and change whenever its owner likes.'],
    ['no-ip.org', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer.'],
    ['no-ip.biz', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer.'],
    ['hopto.org', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer.'],
    ['zapto.org', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer.'],
    ['sytes.net', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer.'],
    ['servebeer.com', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer.'],
    ['myftp.org', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer.'],
    ['serveftp.com', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer.'],
    ['ddns.me', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer.'],
    ['dynu.net', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer.'],
    ['afraid.org', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer.'],
    ['mooo.com', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer.'],
    ['dynv6.net', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer.'],
    ['dyndns.org', '', 'a dynamic DNS name', 'A dynamic DNS name can point at any computer.'],
  ];
  // Well-known services and CDNs: neutral. Being here says "a company you
  // have heard of", not "safe" - what is SENT there still matters.
  var KNOWN = ('googleapis.com gstatic.com google.com google-analytics.com googletagmanager.com googleusercontent.com youtube.com ' +
    'cloudflare.com jsdelivr.net unpkg.com cdnjs.com bootstrapcdn.com jquery.com cloudfront.net fastly.net akamaihd.net akamaized.net ' +
    'github.com githubusercontent.com github.io gitlab.com bitbucket.org npmjs.org npmjs.com yarnpkg.com pypi.org pythonhosted.org ' +
    'mozilla.org mozilla.net microsoft.com live.com office.com azure.com azureedge.net windows.net apple.com icloud.com ' +
    'amazonaws.com amazon.com sentry.io segment.io segment.com mixpanel.com amplitude.com stripe.com paypal.com ' +
    'openai.com anthropic.com open-meteo.com openweathermap.org weather.gov wikipedia.org twitter.com x.com facebook.com ' +
    'discord.com discordapp.com telegram.org slack.com chromewebstore.google.com chrome.google.com mozilla.org').split(' ');
  // Not destinations at all: XML namespaces, schemas and the documentation domains.
  var IGNORE_HOSTS = { 'www.w3.org': 1, 'w3.org': 1, 'schemas.microsoft.com': 1, 'schemas.openxmlformats.org': 1, 'purl.org': 1, 'ns.adobe.com': 1, 'json-schema.org': 1, 'example.com': 1, 'www.example.com': 1, 'example.org': 1, 'example.net': 1, 'schema.org': 1, 'opensource.org': 1, 'www.apache.org': 1, 'spdx.org': 1 };
  var SHARED_SUFFIX = { 'github.io': 1, 'gitlab.io': 1, 'netlify.app': 1, 'vercel.app': 1, 'pages.dev': 1, 'workers.dev': 1, 'herokuapp.com': 1, 'web.app': 1, 'firebaseapp.com': 1, 'glitch.me': 1, 'repl.co': 1, 'onrender.com': 1, 'fly.dev': 1, 'co.uk': 1, 'org.uk': 1, 'com.au': 1, 'co.jp': 1, 'co.nz': 1, 'com.br': 1, 'co.in': 1, 'blogspot.com': 1, 'appspot.com': 1, 'azurewebsites.net': 1 };
  /** The part of a host its owner controls: "api.weatherpal.app" -> "weatherpal.app". */
  function siteOf(host) {
    var h = String(host || '').toLowerCase().replace(/\.$/, '');
    if (isIp(h)) return h;
    var parts = h.split('.');
    if (parts.length <= 2) return h;
    var last2 = parts.slice(-2).join('.');
    if (SHARED_SUFFIX[last2]) return parts.slice(-3).join('.');
    return last2;
  }
  function isIp(h) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    return Boolean(m && [m[1], m[2], m[3], m[4]].every(function (x) { return Number(x) <= 255; }));
  }
  function isLocalIp(h) {
    return /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|172\.(?:1[6-9]|2\d|3[01])\.)/.test(h);
  }
  function endsWithHost(h, suffix) { return h === suffix || h.slice(-(suffix.length + 1)) === '.' + suffix; }

  /** A host (and the URL it came from) -> {tag, label, why}. */
  function tagHost(host, url, firstParty) {
    var h = String(host || '').toLowerCase();
    var path = '';
    try { path = url ? new URL(url).pathname : ''; } catch (e) { path = ''; }
    if (!h || /\$\{|\{\{|%s|\+/.test(h)) return { tag: 'dynamic', label: 'an address built at run time', why: 'The code puts this address together while it runs, so reading it cannot say where it goes.' };
    if (isIp(h)) {
      if (isLocalIp(h)) return { tag: 'local', label: 'this computer or your local network (' + h + ')', why: 'A local address: this machine or something on your own network.' };
      return { tag: 'risky', label: 'a raw IP address (' + h + ')', why: 'A bare number, not a name: there is no company to look up, and shipped code rarely needs one.' };
    }
    if (h === 'localhost') return { tag: 'local', label: 'this computer (localhost)', why: 'This machine itself.' };
    if (/\.onion$/.test(h)) return { tag: 'risky', label: 'a Tor hidden service', why: 'Reachable only through Tor, by design hard to trace.' };
    for (var i = 0; i < RISKY.length; i++) {
      var r = RISKY[i];
      if (endsWithHost(h, r[0]) && (!r[1] || path.indexOf(r[1]) === 0)) return { tag: 'risky', label: r[2], why: r[3] };
    }
    var site = siteOf(h);
    if (firstParty && firstParty[site]) return { tag: 'first', label: 'its own site (' + h + ')', why: 'The same site the package names as its home page or repository.' };
    for (var k = 0; k < KNOWN.length; k++) if (endsWithHost(h, KNOWN[k])) return { tag: 'known', label: 'a well-known service (' + h + ')', why: 'A big, known service or CDN. Known is not the same as harmless - what is sent there still matters.' };
    return { tag: 'unknown', label: 'an unknown server (' + h + ')', why: 'Not the package\u2019s own site and not a service Sniff knows. Worth finding out who runs it.' };
  }
  var TAG_WORD = { risky: 'Risky', unknown: 'Unknown', first: 'Its own site', known: 'Known service', local: 'Local', dynamic: 'Built at run time' };
  var TAG_RANK = { risky: 5, dynamic: 4, unknown: 3, first: 2, known: 1, local: 0 };

  var URL_RE = /\b(?:https?|wss?|ftp):\/\/[^\s'"`<>)\]\\,;]{1,300}/gi;
  /** Hosts named on one line: URLs, quoted IPs, socket and curl targets. */
  function lineDests(raw, lang) {
    var out = [], m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(raw)) && out.length < 12) {
      var url = m[0].replace(/[.!?]+$/, '');
      var hm = /^[a-z]+:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url);
      var host = hm ? hm[1].toLowerCase() : '';
      if (/\$\{/.test(raw.slice(m.index, m.index + url.length + 2)) && /\$\{/.test(url.slice(0, url.indexOf(host) + host.length + 2))) host = '';
      if (IGNORE_HOSTS[host]) continue;
      if (host === '' && !/\$\{/.test(url)) continue;
      out.push({ host: host, url: url.slice(0, LIMITS.urlLen), col: m.index });
    }
    var ipRe = /['"`]((?:\d{1,3}\.){3}\d{1,3})(?::\d{2,5})?['"`]/g;
    while ((m = ipRe.exec(raw)) && out.length < 12) if (isIp(m[1]) && !out.some(function (d) { return d.host === m[1]; })) out.push({ host: m[1], url: m[1], col: m.index });
    if (lang === 'sh' || lang === 'bat' || lang === 'ps' || /\b(?:curl|wget|nc|ncat)\b/.test(raw)) {
      var sh = /\b(?:curl|wget|nc|ncat|netcat|socat|telnet)\b[^|;&\n]*?\s((?:\d{1,3}\.){3}\d{1,3})\b/g;
      while ((m = sh.exec(raw)) && out.length < 12) if (isIp(m[1]) && !out.some(function (d) { return d.host === m[1]; })) out.push({ host: m[1], url: m[1], col: m.index });
      var tcp = /\/dev\/(?:tcp|udp)\/([a-z0-9.-]+)\//gi;
      while ((m = tcp.exec(raw)) && out.length < 12) out.push({ host: m[1].toLowerCase(), url: m[1], col: m.index });
    }
    var sock = /\.connect\(\s*\(\s*['"]([a-z0-9.-]+)['"]\s*,\s*\d+/gi;
    while ((m = sock.exec(raw)) && out.length < 12) out.push({ host: m[1].toLowerCase(), url: m[1], col: m.index });
    var hk = /\b(?:host|hostname)\s*[:=]\s*['"]([a-z0-9-]+(?:\.[a-z0-9-]+)+)['"]/gi;
    while ((m = hk.exec(raw)) && out.length < 12) {
      var hh = m[1].toLowerCase();
      if (!IGNORE_HOSTS[hh] && !/^\d+\.\d+\.\d+$/.test(hh) && !out.some(function (d) { return d.host === hh; })) out.push({ host: hh, url: hh, col: m.index });
    }
    return out;
  }

  /* ---------------- hidden text ---------------- */

  function b64decode(s) {
    var t = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (t.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(t)) return null;
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', out = [], buf = 0, bits = 0;
    for (var i = 0; i < t.length; i++) {
      buf = (buf << 6) | chars.indexOf(t.charAt(i)); bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
      if (out.length > 200000) break;
    }
    return new Uint8Array(out);
  }
  /** Decoded bytes as text if they read as text (>= 90% printable), else null. */
  function asText(bytes) {
    if (!bytes || !bytes.length) return null;
    var ok = 0;
    for (var i = 0; i < bytes.length; i++) { var c = bytes[i]; if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0xc2) ok++; }
    if (ok / bytes.length < 0.9) return null;
    return utf8(bytes);
  }
  function decodeEscapes(s) {
    return String(s).replace(/\\x([0-9a-fA-F]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
  }
  /** What hidden text says, in one bounded line: the URL it holds if it holds one. */
  function hiddenSummary(text) {
    URL_RE.lastIndex = 0;
    var u = URL_RE.exec(text);
    if (u) return { url: u[0].slice(0, LIMITS.urlLen), text: clean(text, 120) };
    return { url: null, text: clean(text, 120) };
  }
  var CODEY = /\b(?:require|import|eval|fetch|exec|spawn|function|XMLHttpRequest|subprocess|socket|curl|wget|powershell|document\.cookie|process\.env|os\.environ)\b/;

  /* ---------------- the rules ---------------- */

  // Sensitive sources: what someone would steal. A flow from one of these is
  // ranked higher than a flow from, say, the page's own settings.
  var SECRET_NAME = /(?:TOKEN|SECRET|PASSW|PASSWD|PWD$|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|AUTH|SESSION|COOKIE|AWS_|GITHUB_|GH_|NPM_|PYPI|SLACK|STRIPE|OPENAI|ANTHROPIC|DATABASE_URL|MNEMONIC|SEED)/i;
  var BENIGN_ENV = /^(?:NODE_ENV|CI|DEBUG|PORT|HOST|HOSTNAME|TZ|LANG|LC_ALL|TERM|PWD|SHELL|USER|HOME|PATH|TMPDIR|TEMP|TMP|npm_\w+|FORCE_COLOR|NO_COLOR|VERBOSE|LOG_LEVEL|ENV|ENVIRONMENT|BROWSER|EDITOR)$/;

  var CRED_FILES = [
    [/\.ssh\/|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|authorized_keys|known_hosts/, 'your SSH keys', '~/.ssh'],
    [/\.aws\/(?:credentials|config)/, 'your AWS keys', '~/.aws/credentials'],
    [/\.npmrc\b/, 'your npm token (~/.npmrc)', '~/.npmrc'],
    [/\.pypirc\b/, 'your PyPI token (~/.pypirc)', '~/.pypirc'],
    [/\.netrc\b|\.git-credentials\b/, 'saved passwords for git and servers', '~/.netrc or ~/.git-credentials'],
    [/\.docker\/config\.json/, 'your Docker login', '~/.docker/config.json'],
    [/\.kube\/config/, 'your Kubernetes credentials', '~/.kube/config'],
    [/\.config\/gh\/hosts|\.config\/gcloud|application_default_credentials/, 'your cloud and GitHub CLI logins', 'a CLI login file'],
    [/\.gnupg\b/, 'your GPG keys', '~/.gnupg'],
    [/\.bash_history|\.zsh_history|ConsoleHost_history/, 'your shell history (often full of pasted tokens)', 'shell history'],
  ];
  var BROWSER_FILES = /Login Data|Local State['"\/\\]|Web Data['"]|key4\.db|logins\.json|cookies\.sqlite|User Data[\/\\]{1,2}Default|Google[\/\\]{1,2}Chrome[\/\\]|BraveSoftware[\/\\]|Microsoft[\/\\]{1,2}Edge[\/\\]{1,2}User Data|Mozilla[\/\\]{1,2}Firefox[\/\\]{1,2}Profiles/;
  var WALLET_FILES = /wallet\.dat|Ethereum[\/\\]{1,2}keystore|\.electrum\b|Electrum[\/\\]{1,2}wallets|Exodus[\/\\]|exodus\.wallet|nkbihfbeogaeaoehlefnkodbefgpgknn|bfnaelmomeimhlpmgjnjophhpkkoljpa|\.config\/solana|solana[\/\\]id\.json|atomic[\/\\]{1,2}Local Storage|\.bitcoin[\/\\]|Phantom[\/\\]|MetaMask/;

  // [id, category, langs, keywords (lowercase, any of), regex, severity, title, why, extra]
  // extra: {phrase, sensitive, net, exec, handoff, internal, check(m, raw, ctx) -> null | overrides}
  var R = [];
  function rule(id, cat, langs, kw, re, sev, title, why, extra) {
    R.push(Object.assign({ id: id, cat: cat, langs: langs.split(' '), kw: kw, re: re, sev: sev, title: title, why: why }, extra || {}));
  }
  var JS = 'js html';
  var ALL = 'js html py sh ps bat';

  // ---- sources ----
  rule('src.cookie', 'source', JS, ['cookie'], /\bdocument\.cookie\b(?!\s*=[^=])/, 'low', 'Reads this site\u2019s cookies',
    'Cookies often hold the session that keeps you signed in. Code that reads them can act as you.', { phrase: 'your cookies', sensitive: 2 });
  rule('src.browsercookies', 'source', JS, ['cookies.'], /\b(?:chrome|browser)\.cookies\.(?:getAll|get)\b/, 'medium', 'Reads your browser cookies for other sites',
    'With the cookies permission an extension can read the sign-in cookies of every site it is allowed on.', { phrase: 'your cookies from other sites', sensitive: 3 });
  rule('src.storageall', 'source', JS, ['storage'], /\b(?:JSON\.stringify|Object\.(?:keys|entries|values|assign))\s*\(\s*(?:\{\s*\}\s*,\s*)?(?:window\.|self\.)?(?:localStorage|sessionStorage)\b|\.\.\.\s*(?:window\.)?(?:localStorage|sessionStorage)\b|for\s*\([^)]*\bin\s+(?:window\.)?(?:localStorage|sessionStorage)\b/, 'medium', 'Copies everything a website keeps in storage',
    'Websites keep sign-in tokens and personal data in local storage. Copying all of it is not something a normal feature needs.', { phrase: 'everything websites keep in storage', sensitive: 3 });
  rule('src.storage', 'source', JS, ['storage'], /\b(?:localStorage|sessionStorage)\s*(?:\.getItem\s*\(|\[)/, 'info', 'Reads website storage',
    'Reading its own saved settings is normal. In a script that runs on other sites, the storage is theirs.', { phrase: 'what websites keep in storage', sensitive: 1 });
  rule('src.indexeddb', 'source', JS, ['indexeddb'], /\bindexedDB\.open\s*\(/, 'info', 'Opens a website database (IndexedDB)', 'Normal for keeping data offline; in a content script, the database belongs to the site.', { phrase: 'a website database', sensitive: 1 });
  rule('src.clipboard', 'source', JS, ['clipboard', 'paste'], /\bnavigator\.clipboard\.read(?:Text)?\s*\(|document\.execCommand\(\s*['"]paste['"]/, 'medium', 'Reads what you copied',
    'The clipboard holds passwords, codes and wallet addresses you just copied.', { phrase: 'what you copied', sensitive: 3 });
  rule('src.keys', 'source', JS, ['key', 'input'], /\b(?:document|window|self|globalThis|document\.body)\.addEventListener\(\s*['"](?:keydown|keypress|keyup|input|beforeinput)['"]|\b(?:document|window)\.on(?:keydown|keypress|keyup|input)\s*=/, 'medium', 'Listens to every key you type on the page',
    'A listener on the whole page hears passwords and messages as you type them, not just one field.', { phrase: 'what you type', sensitive: 3 });
  rule('src.forms', 'source', JS, ['password', 'input', 'form'], /type\s*=\s*\\?["']password|\[type=\\?["']?password|querySelectorAll\(\s*["'`](?:input|form|textarea)\b|\.elements\b[^;\n]{0,30}\.value/, 'low', 'Looks for password and form fields',
    'Finding every input on a page is how form-grabbers work. Password managers and autofill do it too.', { phrase: 'what you type into forms and password fields', sensitive: 2 });
  rule('src.history', 'source', JS, ['history', 'topsites', 'bookmarks'], /\b(?:chrome|browser)\.(?:history\.(?:search|getVisits)|topSites\.get|bookmarks\.(?:getTree|search|getRecent))\b/, 'medium', 'Reads your browsing history or bookmarks',
    'Your history says where you bank, who you see and what you look up.', { phrase: 'your browsing history', sensitive: 3 });
  rule('src.capture', 'source', JS, ['capture', 'getdisplaymedia'], /\b(?:chrome|browser)\.tabs\.captureVisibleTab\b|\bgetDisplayMedia\s*\(|\b(?:chrome|browser)\.(?:tabCapture|desktopCapture)\b/, 'medium', 'Takes screenshots of what you are looking at',
    'A screenshot of a tab can hold anything on screen: messages, balances, codes.', { phrase: 'screenshots of your tabs', sensitive: 3 });
  rule('src.tabs', 'source', JS, ['tabs.'], /\b(?:chrome|browser)\.tabs\.(?:query|getAll|get)\s*\(/, 'info', 'Reads your open tabs',
    'Tab addresses and titles. Most tab tools need this; sent somewhere, it is your browsing.', { phrase: 'the addresses of your open tabs', sensitive: 1 });
  rule('src.geo', 'source', JS, ['geolocation'], /\bnavigator\.geolocation\.(?:getCurrentPosition|watchPosition)\b/, 'info', 'Asks for your location',
    'The browser asks you first. Sent to a weather or map service, that is the point; anywhere else, ask why.', { phrase: 'your location', sensitive: 1 });
  rule('src.envall', 'source', 'js', ['process.env'], /JSON\.stringify\(\s*process\.env\b|Object\.(?:keys|entries|values)\(\s*process\.env\b|=\s*process\.env\s*[;,)\n]|=\s*process\.env$|\(\s*process\.env\s*\)/, 'medium', 'Reads every environment variable at once',
    'Environment variables are where tokens and keys live on a developer\u2019s machine and in CI. A tool rarely needs all of them.', { phrase: 'all your environment variables (where tokens and keys live)', sensitive: 3 });
  rule('src.env', 'source', 'js', ['process.env'], /\bprocess\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/, 'info', 'Reads an environment variable',
    'Reading a setting from the environment is normal. A secret-looking one is worth a look at where it goes.', { phrase: 'an environment variable', sensitive: 0, check: envCheck });
  rule('src.pyenvall', 'source', 'py', ['environ'], /\b(?:dict|json\.dumps|str|repr)\(\s*os\.environ\b|\bos\.environ\.(?:copy|items|keys|values)\(\)|=\s*os\.environ\s*$/, 'medium', 'Reads every environment variable at once',
    'Environment variables are where tokens and keys live. A tool rarely needs all of them.', { phrase: 'all your environment variables (where tokens and keys live)', sensitive: 3 });
  rule('src.pyenv', 'source', 'py', ['environ', 'getenv'], /\bos\.(?:environ(?:\.get)?\s*[\[(]\s*['"]([A-Za-z_][A-Za-z0-9_]*)|getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*))/, 'info', 'Reads an environment variable',
    'Reading a setting from the environment is normal. A secret-looking one is worth a look.', { phrase: 'an environment variable', sensitive: 0, check: envCheck });
  rule('src.shenvall', 'source', 'sh bat', ['env', 'set'], /(?:^|[\s;|&(`$])(?:printenv|env)\s*(?:$|[|>;&)`])|^\s*set\s*(?:\||>)/, 'medium', 'Dumps every environment variable',
    'Environment variables are where tokens and keys live. Dumping them all is how CI secrets leak.', { phrase: 'all your environment variables', sensitive: 3 });
  rule('src.shenv', 'source', 'sh bat', ['$', '%'], /\$\{?([A-Z][A-Z0-9_]*)\}?|%([A-Z][A-Z0-9_]*)%/, 'info', 'Reads a secret-looking environment variable',
    'Worth a look at where it goes.', { phrase: 'a secret from the environment', sensitive: 0, check: envCheck, secretOnly: true });
  rule('src.psenvall', 'source', 'ps', ['env:', 'environment'], /\b(?:Get-ChildItem|gci|dir|ls)\s+env:|\[Environment\]::GetEnvironmentVariables\(\)/i, 'medium', 'Lists every environment variable',
    'Environment variables are where tokens and keys live.', { phrase: 'all your environment variables', sensitive: 3 });
  rule('src.psenv', 'source', 'ps', ['env:'], /\$env:([A-Za-z_][A-Za-z0-9_]*)/i, 'info', 'Reads an environment variable', 'Worth a look at where it goes.', { phrase: 'a secret from the environment', sensitive: 0, check: envCheck, secretOnly: true });
  rule('src.credfile', 'source', ALL, ['.ssh', 'id_', '.aws', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.docker', '.kube', 'gh/hosts', 'gcloud', 'application_default', '.gnupg', 'history', 'authorized_keys', 'known_hosts'],
    /\.ssh\/|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|authorized_keys|known_hosts|\.aws\/(?:credentials|config)|\.npmrc\b|\.pypirc\b|\.netrc\b|\.git-credentials\b|\.docker\/config\.json|\.kube\/config|\.config\/gh\/hosts|\.config\/gcloud|application_default_credentials|\.gnupg\b|\.bash_history|\.zsh_history|ConsoleHost_history/, 'medium', 'Reads a credentials file',
    'These files hold the keys to your accounts: publish packages, push code, reach servers, spend cloud money.', { sensitive: 3, check: credCheck });
  rule('src.dotenv', 'source', ALL, ['.env'], /['"`](?:\.\/|\.\.\/)*\.env(?:\.local|\.production|\.development)?['"`]/, 'low', 'Reads a .env file',
    'A project\u2019s .env holds its API keys and database passwords. Tools that load config read it too.', { phrase: 'your .env secrets', sensitive: 3 });
  rule('src.browserfiles', 'source', ALL, ['login data', 'local state', 'web data', 'key4', 'logins.json', 'cookies.sqlite', 'user data', 'chrome', 'brave', 'edge', 'firefox'], BROWSER_FILES, 'high', 'Looks for your browser\u2019s saved passwords and cookies on disk',
    'Browsers keep saved passwords and sign-in cookies in these files. Reading them from outside the browser is what password stealers do.', { phrase: 'your browser\u2019s saved passwords and cookies', sensitive: 3 });
  rule('src.wallet', 'source', ALL, ['wallet', 'ethereum', 'electrum', 'exodus', 'nkbihfbeog', 'bfnaelmom', 'solana', 'atomic', '.bitcoin', 'phantom', 'metamask'], WALLET_FILES, 'high', 'Looks for crypto wallet files',
    'Wallet files and wallet-extension folders hold the keys to money. Almost nothing legitimate outside a wallet looks for them.', { phrase: 'your crypto wallets', sensitive: 3 });
  rule('src.pyclip', 'source', 'py sh ps', ['paste', 'clipboard', 'xclip', 'xsel'], /\bpyperclip\.paste\s*\(|\.clipboard_get\s*\(|\bGet-Clipboard\b|\bpbpaste\b|\bxclip\b[^|\n]*-o|\bxsel\b[^|\n]*-o/i, 'medium', 'Reads what you copied',
    'The clipboard holds passwords, codes and wallet addresses you just copied.', { phrase: 'what you copied', sensitive: 3 });
  rule('src.keylog', 'source', 'py ps', ['pynput', 'keyboard', 'getasynckeystate', 'setwindowshookex'], /\bpynput\b|\bkeyboard\.(?:on_press|on_release|hook|read_key|record)\b|\bGetAsyncKeyState\b|\bSetWindowsHookEx/i, 'high', 'Records your keystrokes',
    'A keyboard hook hears everything you type, in every app.', { phrase: 'everything you type', sensitive: 3 });
  rule('src.decrypt', 'source', 'py ps', ['cryptunprotectdata', 'browser_cookie3', 'win32crypt'], /\bCryptUnprotectData\b|\bbrowser_cookie3\b|\bwin32crypt\b/i, 'high', 'Decrypts browser passwords or cookies',
    'This is the Windows call password stealers use to unlock what Chrome saved.', { phrase: 'your browser\u2019s saved passwords and cookies', sensitive: 3 });
  rule('src.screenshot', 'source', 'py ps', ['imagegrab', 'pyautogui', 'mss', 'screenshot', 'copyfromscreen'], /\bImageGrab\.grab\b|\bpyautogui\.screenshot\b|\bmss\(\)|\.CopyFromScreen\b/i, 'medium', 'Takes screenshots',
    'A screenshot can hold anything on screen.', { phrase: 'screenshots of your screen', sensitive: 3 });
  rule('src.message', 'source', JS, ['onmessage', 'message'], /\b(?:chrome|browser)\.runtime\.on(?:Message|MessageExternal|Connect)\.addListener|\bonmessage\s*=|addEventListener\(\s*['"]message['"]/, 'info', 'Receives messages from other scripts',
    '', { phrase: 'what other scripts send it', internal: true, handoffIn: true });

  // ---- sinks ----
  rule('sink.fetch', 'sink', JS, ['fetch'], /(?:^|[^.\w$])fetch\s*\(|\b(?:window|self|globalThis)\.fetch\s*\(/, 'info', 'Makes web requests (fetch)', 'How almost every app talks to a server. What matters is where to, and what is in it.', { net: true, label: 'fetch' });
  rule('sink.xhr', 'sink', JS, ['xmlhttprequest'], /\bnew\s+XMLHttpRequest\b/, 'info', 'Makes web requests (XMLHttpRequest)', 'An older way to talk to a server.', { net: true, label: 'XMLHttpRequest' });
  rule('sink.beacon', 'sink', JS, ['sendbeacon'], /\bnavigator\.sendBeacon\s*\(/, 'low', 'Sends data in the background, even as the page closes (sendBeacon)', 'Made for analytics; also a quiet way to send something out as you leave.', { net: true, label: 'sendBeacon' });
  rule('sink.ws', 'sink', JS, ['websocket'], /\bnew\s+WebSocket\s*\(/, 'low', 'Opens a live connection (WebSocket)', 'A connection that stays open both ways: data can go out at any time.', { net: true, label: 'WebSocket' });
  rule('sink.es', 'sink', JS, ['eventsource'], /\bnew\s+EventSource\s*\(/, 'info', 'Listens to a server (EventSource)', 'A server can push instructions down it.', { net: true, label: 'EventSource' });
  rule('sink.pixel', 'sink', JS, ['image', '.src'], /\bnew\s+Image\b[^;\n]{0,40}\.src\s*=|\.src\s*=\s*[`'"]https?:\/\/[^`'"]*\?[^`'"]*[`'"]?\s*\+/, 'low', 'Sends data hidden in an image request', 'Putting data in an image address is an old trick to send it without a "request" anyone notices.', { net: true, label: 'an image request' });
  rule('sink.script', 'sink', JS, ['createelement', 'importscripts', 'import('], /createElement\(\s*['"]script['"]\s*\)|\bimportScripts\(\s*['"`]https?:|\bimport\(\s*['"`]https?:/, 'low', 'Adds code to the page at run time',
    'A script added while it runs can come from anywhere, and is not in the code you are reading.', { net: true, label: 'a script it loads' });
  rule('sink.remotescript', 'sink', 'html', ['<script'], /<script[^>]+src\s*=\s*["']?(?:https?:)?\/\//i, 'low', 'Loads a script from the internet', 'That code is not in the package, so nobody reviewing it saw it.', { net: true, label: 'a remote script' });
  rule('sink.nodenet', 'sink', 'js', ['http', 'net', 'dgram', 'tls', 'axios', 'got', 'superagent', 'needle', 'undici', 'node-fetch', 'request'],
    /\b(?:https?|http2)\.(?:request|get)\s*\(|\bnet\.(?:connect|createConnection|Socket)\b|\bdgram\.createSocket\b|\btls\.connect\b|\b(?:axios|got|superagent|needle|undici)(?:\.(?:post|put|get|patch|request))?\s*\(|require\(\s*['"](?:node-fetch|axios|got|request|superagent|needle|undici)['"]\s*\)/, 'info', 'Makes network requests (Node)', 'How a Node tool talks to a server.', { net: true, label: 'a Node request' });
  rule('sink.dns', 'sink', 'js', ['dns'], /\bdns\.(?:lookup|resolve\w*)\s*\(|require\(\s*['"](?:node:)?dns['"]\s*\)/, 'low', 'Looks up names in DNS', 'Data can leave inside the name being looked up - it gets past many firewalls.', { net: true, label: 'a DNS lookup' });
  rule('sink.exec', 'sink', 'js', ['exec', 'spawn', 'child_process', 'fork'], /\b(?:execSync|execFileSync|spawnSync|execFile|spawn)\s*\(|require\(\s*['"](?:node:)?child_process['"]\s*\)|from\s+['"](?:node:)?child_process['"]|(?:^|[^.\w$])exec\s*\(/, 'low', 'Runs other programs on your computer',
    'It can do anything you can, outside the safety of the language.', { exec: true, label: 'a shell command', check: execCheck });
  rule('sink.py', 'sink', 'py', ['requests', 'httpx', 'urlopen', 'urllib', 'http.client', 'httpsconnection', 'aiohttp', 'urllib3', 'smtplib', 'ftplib'],
    /\b(?:requests|httpx)\.(?:get|post|put|patch|delete|request|Client|AsyncClient|Session)\b|\burllib\.request\.(?:urlopen|Request)\b|\burlopen\s*\(|\bhttp\.client\.HTTPS?Connection\b|\bHTTPS?Connection\s*\(|\baiohttp\.ClientSession\b|\burllib3\.PoolManager\b|\bsmtplib\.SMTP|\bftplib\.FTP/, 'info', 'Makes network requests (Python)', 'How a Python tool talks to a server.', { net: true, label: 'a Python request' });
  rule('sink.pysocket', 'sink', 'py', ['socket'], /\bsocket\.(?:socket|create_connection)\s*\(/, 'low', 'Opens a raw network connection', 'A socket can talk to anything on any port, outside the web.', { net: true, label: 'a socket' });
  rule('sink.pydns', 'sink', 'py', ['gethostbyname', 'getaddrinfo', 'dns.resolver'], /\bsocket\.(?:gethostbyname|getaddrinfo)\s*\(|\bdns\.resolver\b/, 'low', 'Looks up names in DNS', 'Data can leave inside the name being looked up.', { net: true, label: 'a DNS lookup' });
  rule('sink.pyexec', 'sink', 'py', ['subprocess', 'os.system', 'os.popen', 'os.exec', 'pty.spawn'], /\bsubprocess\.(?:run|call|check_call|check_output|Popen|getoutput)\s*\(|\bos\.(?:system|popen|exec\w*)\s*\(|\bpty\.spawn\b/, 'low', 'Runs other programs on your computer', 'It can do anything you can.', { exec: true, label: 'a shell command', check: execCheck });
  rule('sink.curl', 'sink', ALL, ['curl', 'wget'], /(?:^|[\s;&|(`$"'])(?:curl|wget)(?:\.exe)?\s/, 'info', 'Downloads or uploads with curl or wget', 'Fine for fetching a file; posting data with it is sending something out.', { net: true, label: 'curl', check: curlCheck });
  rule('sink.nc', 'sink', 'sh bat ps py js', ['nc ', 'ncat', 'netcat', 'socat', 'telnet', '/dev/tcp', '/dev/udp'], /(?:^|[\s;&|(`$])(?:nc|ncat|netcat|socat|telnet)\s+(?:-\w+\s+)*[\w.-]+\s+\d{2,5}\b|\/dev\/(?:tcp|udp)\//, 'medium', 'Opens a raw network connection (netcat / /dev/tcp)', 'A favourite of reverse shells: a direct line to someone else\u2019s machine.', { net: true, label: 'a raw connection' });
  rule('sink.shdns', 'sink', 'sh bat', ['nslookup', 'dig '], /(?:^|[\s;&|(`$])(?:nslookup|dig)\s+\S/, 'low', 'Looks up names in DNS', 'Data can leave inside the name being looked up.', { net: true, label: 'a DNS lookup' });
  rule('sink.ps', 'sink', 'ps bat', ['invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'webclient', 'downloadstring', 'downloadfile', 'uploadstring', 'uploaddata', 'uploadfile', 'bitstransfer', 'tcpclient', 'resolve-dnsname'],
    /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Net\.WebClient|DownloadString|DownloadFile|UploadString|UploadData|UploadFile|Start-BitsTransfer|Sockets\.TcpClient|Resolve-DnsName)\b/i, 'info', 'Makes network requests (PowerShell)', 'How a PowerShell script talks to a server.', { net: true, label: 'a PowerShell request' });
  rule('sink.certutil', 'sink', 'bat ps sh', ['certutil', 'bitsadmin', 'mshta'], /\bcertutil(?:\.exe)?\s+[^\n]*-urlcache|\bbitsadmin(?:\.exe)?\s+\/transfer|\bmshta(?:\.exe)?\s+https?:/i, 'medium', 'Downloads with a built-in Windows tool',
    'certutil, bitsadmin and mshta are often abused to fetch code past antivirus.', { net: true, label: 'a Windows download tool' });
  rule('sink.message', 'sink', JS, ['sendmessage', 'postmessage', 'runtime.connect'], /\b(?:chrome|browser)\.runtime\.(?:sendMessage|connect)\s*\(|\.postMessage\s*\(/, 'info', 'Passes data to another script',
    '', { internal: true, handoff: true, label: 'a message' });

  // ---- hiding ----
  rule('hide.eval', 'hiding', 'js html py', ['eval'], /(?:^|[^.\w$])eval\s*\(/, 'medium', 'Runs code built from text (eval)',
    'Code that builds code while it runs can do things no reader of the file can see.', {});
  rule('hide.pyexec', 'hiding', 'py', ['exec', 'compile'], /(?:^|[^.\w])exec\s*\(|(?:^|[^.\w])compile\s*\([^)]*['"]exec['"]/, 'medium', 'Runs code built from text (exec)', 'Code that builds code while it runs can do things no reader of the file can see.', {});
  rule('hide.function', 'hiding', JS, ['function'], /\bnew\s+Function\s*\(|(?:^|[^.\w$])Function\s*\(\s*['"`]/, 'medium', 'Builds a function from text (new Function)', 'Like eval: the code that runs is not the code you are reading.', {});
  rule('hide.timerstr', 'hiding', JS, ['settimeout', 'setinterval'], /\bset(?:Timeout|Interval)\s*\(\s*['"`]/, 'medium', 'Runs a string as code later (setTimeout with text)', 'A timer given text instead of a function is eval with a delay.', {});
  rule('hide.b64', 'hiding', ALL, ['atob', 'base64', 'b64decode', 'decodebytes', 'frombase64string'],
    /\b(?:atob|b64decode|urlsafe_b64decode|decodebytes|FromBase64String)\s*\(\s*b?['"`]([A-Za-z0-9+\/=_-]{20,})['"`]|\bBuffer\.from\(\s*['"`]([A-Za-z0-9+\/=]{20,})['"`]\s*,\s*['"`]base64['"`]|['"`]([A-Za-z0-9+\/=]{20,})['"`]\s*\|\s*base64\s+(?:-d|--decode)|echo\s+['"]?([A-Za-z0-9+\/=]{20,})['"]?\s*\|\s*base64\s+(?:-d|--decode)/,
    'low', 'Decodes hidden text (base64)', 'Encoding is a normal way to pack data - and a common way to keep an address or a command out of sight.', { check: b64Check });
  rule('hide.blob', 'hiding', 'js py sh ps', ['"', "'", '`'], /['"`]([A-Za-z0-9+\/]{40,}={0,2})['"`]/, 'low', 'Carries a long encoded text', 'A run of base64 in the code. Sniff decoded it to see what it says.', { check: blobCheck });
  rule('hide.charcode', 'hiding', 'js html py', ['fromcharcode', 'chr('], /String\.fromCharCode\s*\(\s*((?:\d+\s*,\s*){7,}\d+)\s*\)|((?:chr\(\d+\)\s*\+\s*){6,}chr\(\d+\))/, 'medium', 'Spells text out one character at a time',
    'Building a string from character codes hides it from anyone searching the code.', { check: charCheck });
  rule('hide.escapes', 'hiding', 'js html py', ['\\x', '\\u'], /((?:\\x[0-9a-fA-F]{2}){16,}|(?:\\u[0-9a-fA-F]{4}){10,})/, 'medium', 'Hides text in escape codes',
    'Long runs of \\x41-style escapes are text written so a reader cannot see it.', { check: escCheck });
  rule('hide.date', 'hiding', 'js py', ['date', 'time'], /(?:new\s+Date\(\)|Date\.now\(\))\s*[<>]=?\s*(?:new\s+Date\(\s*['"]?\d{4}|\d{12,13}|Date\.UTC\(\s*\d{4})|(?:new\s+Date\(\s*['"]?\d{4}[^)]*\)|\d{12,13})\s*[<>]=?\s*(?:new\s+Date\(\)|Date\.now\(\))|(?:datetime\.(?:now|today|utcnow)\(\)|date\.today\(\)|time\.time\(\))\s*[<>]=?\s*(?:datetime\(|date\(|\d{9,10})/, 'medium', 'Only does something after a set date',
    'A time bomb: code that waits for a date stays quiet while people review it.', {});
  rule('hide.ci', 'hiding', 'js py sh', ['ci'], /!\s*process\.env\.(?:CI|GITHUB_ACTIONS|CONTINUOUS_INTEGRATION|BUILD_NUMBER)\b|process\.env\.CI\s*(?:===?|!==?)\s*(?:undefined|['"](?:false|0)?['"])|not\s+os\.environ\.get\(\s*['"]CI['"]|['"]CI['"]\s+not\s+in\s+os\.environ|if\s+\[\s*-z\s+"?\$\{?CI\b/, 'low', 'Behaves differently when it is not running in CI',
    'Some tools quiet their output in CI. Malware uses the same check to stay hidden from automated scans.', {});
  rule('hide.psenc', 'hiding', 'ps bat sh js py', ['-e', 'enc'], /(?:powershell|pwsh)(?:\.exe)?[^\n]*\s-(?:e|en|enc|enco|encodedcommand)\s+[A-Za-z0-9+\/=]{20,}/i, 'high', 'Runs an encoded PowerShell command', 'The command is base64 so nobody reading the script can see it.', {});
  rule('hide.pipeshell', 'hiding', 'sh bat js py', ['| sh', '|sh', 'bash', '| zsh', 'base64'], /(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|base64\s+(?:-d|--decode)[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, 'medium', 'Downloads code and runs it straight away',
    'Whatever the server sends is run, unread. Installers do this; so do attacks.', {});
  rule('hide.iex', 'hiding', 'ps bat', ['iex', 'invoke-expression'], /\b(?:IEX|Invoke-Expression)\b/i, 'medium', 'Runs text as a PowerShell command (Invoke-Expression)', 'PowerShell\u2019s eval: whatever the text says, runs.', {});
  rule('hide.pyobf', 'hiding', 'py', ['marshal', 'zlib', 'rot', '__import__'], /\bmarshal\.loads\b|\bzlib\.decompress\b|codecs\.decode\([^)]*rot.?13|__import__\(\s*['"](?:base64|zlib|marshal|codecs)['"]/, 'medium', 'Unpacks packed or scrambled code', 'marshal, zlib and rot13 are how Python malware hides its real code.', {});

  // ---- install-time (line rules; package.json and manifest.json are read separately) ----
  rule('inst.cmdclass', 'install', 'py', ['cmdclass'], /\bcmdclass\s*=/, 'medium', 'Replaces pip\u2019s install step with its own code',
    'cmdclass lets setup.py run anything it likes the moment someone types pip install.', {});
  rule('inst.oninstalled', 'install', JS, ['oninstalled'], /\b(?:chrome|browser)\.runtime\.onInstalled\.addListener\b/, 'low', 'Runs code the moment it is installed',
    'Normal for a welcome page. Worth a look at what else that handler does.', {});

  function envCheck(m) {
    var name = m[1] || m[2] || '';
    if (!name || BENIGN_ENV.test(name)) return null;
    if (SECRET_NAME.test(name)) return { sev: 'low', title: 'Reads a secret from the environment (`' + name + '`)', phrase: 'your `' + name + '`', sensitive: 3 };
    if (this.secretOnly) return null;
    return { title: 'Reads an environment variable (`' + name + '`)' };
  }
  function credCheck(m, raw) {
    for (var i = 0; i < CRED_FILES.length; i++) if (CRED_FILES[i][0].test(raw)) return { title: 'Reads ' + CRED_FILES[i][1], phrase: CRED_FILES[i][1] };
    return { phrase: 'a credentials file' };
  }
  function execCheck(m, raw, ctx) {
    var s = m[0];
    if (/^[^.\w$]?exec\s*\(/.test(s.replace(/^\s+/, '')) && !/child_process/.test(ctx.text) && ctx.lang === 'js') return null; // RegExp#exec
    if (/require\(|from\s+['"]/.test(s)) return { sev: 'info', title: 'Can run other programs (child_process)' };
    if (/\b(?:curl|wget|nc|ncat|Invoke-WebRequest|iwr|powershell)\b/i.test(raw)) return { sev: 'medium', title: 'Runs a command that reaches the internet', net: true, label: (/\bcurl\b/.test(raw) ? 'curl' : /\bwget\b/.test(raw) ? 'wget' : 'a shell command'), why: 'A program launched from code, and that program talks to a server.' };
    return null;
  }
  function curlCheck(m, raw, ctx) {
    if ((ctx.lang === 'js' || ctx.lang === 'py' || ctx.lang === 'html') && !/\b(?:exec|execSync|spawn|spawnSync|system|subprocess|popen|run)\b/.test(raw)) return null;
    if (/\s(?:-d|--data(?:-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file|--post-data|--post-file|-X\s*POST|--request\s+POST)\b/.test(raw)) return { sev: 'low', title: 'Sends data out with ' + (/\bwget\b/.test(m[0]) ? 'wget' : 'curl'), why: 'curl and wget can post files and text to any server.' };
    return null;
  }
  function decodedResult(text, how) {
    var s = hiddenSummary(text);
    if (s.url) return { sev: 'medium', title: 'Hides an address in ' + how + ': ' + clean(s.url, 90), hidden: s.url, decoded: s.text };
    if (CODEY.test(text)) return { sev: 'medium', title: 'Hides code in ' + how, decoded: s.text };
    return { decoded: s.text };
  }
  function b64Check(m) {
    var lit = m[1] || m[2] || m[3] || m[4] || '';
    var t = asText(b64decode(lit));
    if (t === null) return { title: 'Decodes data from base64' };
    return decodedResult(t, 'base64');
  }
  function blobCheck(m, raw, ctx) {
    if (/data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(raw.slice(Math.max(0, m.index - 60), m.index + 2))) return null;
    if (ctx.minified) return null;
    if (/\b(?:atob|b64decode|FromBase64String|Buffer\.from)\s*\(\s*['"`]$/.test(raw.slice(Math.max(0, m.index - 30), m.index + 1))) return null; // hide.b64 has it
    var t = asText(b64decode(m[1]));
    if (t === null) return null; // binary data, a hash or an id, most likely
    var r = decodedResult(t, 'base64');
    if (r.sev) return r;
    if (m[1].length < 200) return null; // short and harmless-looking: not worth a line
    r.sev = 'low'; r.title = 'Carries a long encoded text (' + fmtInt(m[1].length) + ' characters of base64)';
    return r;
  }
  function charCheck(m) {
    var t = '';
    if (m[1]) t = m[1].split(',').map(function (n) { return String.fromCharCode(Number(n.trim()) & 0xffff); }).join('');
    else t = (m[2].match(/\d+/g) || []).map(function (n) { return String.fromCharCode(Number(n) & 0xffff); }).join('');
    return decodedResult(t, 'character codes');
  }
  function escCheck(m) { return decodedResult(decodeEscapes(m[1]), 'escape codes'); }

  var RULES_BY_LANG = {};
  R.forEach(function (r) { r.langs.forEach(function (l) { (RULES_BY_LANG[l] = RULES_BY_LANG[l] || []).push(r); }); });
  var RULE_BY_ID = {};
  R.forEach(function (r) { RULE_BY_ID[r.id] = r; });

  function isCommentLine(lang, t) {
    if (!t) return true;
    if (lang === 'js' || lang === 'html') return /^(?:\/\/|\/\*|\*(?!\*?\s*[=(])|<!--)/.test(t);
    if (lang === 'py' || lang === 'sh' || lang === 'pyproject') return t.charAt(0) === '#';
    if (lang === 'ps') return t.charAt(0) === '#' || t.indexOf('<#') === 0;
    if (lang === 'bat') return /^(?:rem\b|::)/i.test(t);
    return false;
  }
  function assignTarget(lang, raw) {
    var m;
    if (lang === 'js' || lang === 'html') {
      m = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(raw) || /^\s*(?:this\.)?([A-Za-z_$][\w$]*)(?:\.[\w$]+|\[[^\]]*\])*\s*(?:\+|\|\|)?=(?!=)/.exec(raw) || /\b([A-Za-z_$][\w$]*)\.(?:push|unshift|concat|append|set)\s*\(/.exec(raw);
      return m ? m[1] : null;
    }
    if (lang === 'py') { m = /^\s*([A-Za-z_]\w*)(?:\[[^\]]*\]|\.\w+)*\s*(?:\+)?=(?!=)/.exec(raw) || /\b([A-Za-z_]\w*)\.(?:append|extend|update)\s*\(/.exec(raw); return m ? m[1] : null; }
    if (lang === 'sh' || lang === 'bat') { m = /^\s*(?:export\s+|local\s+|set\s+)?([A-Za-z_]\w*)=/.exec(raw); return m ? m[1] : null; }
    if (lang === 'ps') { m = /^\s*\$([A-Za-z_]\w*)\s*(?:\+)?=(?!=)/.exec(raw); return m ? m[1] : null; }
    return null;
  }
  var WORD_SKIP = { if: 1, for: 1, while: 1, return: 1, const: 1, let: 1, var: 1, function: 1, this: 1, true: 1, false: 1, null: 1, undefined: 1, data: 0 };
  function mentions(raw, name) {
    if (!name || WORD_SKIP[name]) return false;
    var re = new RegExp('(?:^|[^\\w$])\\$?' + name.replace(/[$]/g, '\\$') + '(?![\\w$])');
    return re.test(raw);
  }
  function snippetOf(raw, col) {
    var s = String(raw).replace(/\t/g, '  ');
    if (s.length <= LIMITS.snippet) return s.trim();
    var start = Math.max(0, (col || 0) - 50);
    var out = s.slice(start, start + LIMITS.snippet);
    return (start > 0 ? '…' : '') + out.trim() + (start + LIMITS.snippet < s.length ? '…' : '');
  }
  var KNOWN_LIB = /^\s*(?:\/\*[!*]?|\/\/)?\s*(?:jQuery|React|Vue(?:\.js)?|lodash|Lodash|Bootstrap|Chart\.js|d3|D3|moment|axios|Popper|core-js|@license|License|Copyright|webextension-polyfill|Sentry|DOMPurify|three\.js|Socket\.IO|@preserve)/;
  var KNOWN_LIB_NAME = /(?:^|\/)(?:jquery|react|react-dom|vue|lodash|bootstrap|chart|d3|moment|axios|popper|polyfill|browser-polyfill|webextension-polyfill|three|socket\.io|purify|sentry|highlight|marked|prism)[\w.-]*\.js$/i;

  /* ---------------- reading one file ---------------- */

  function scanFile(f, ctx) {
    var text = f.text, lang = f.lang;
    var lines = text.split(/\r\n|\r|\n/);
    var rules = RULES_BY_LANG[lang === 'html' ? 'html' : lang] || [];
    var minified = /\.min\.js$/i.test(f.path) || KNOWN_LIB_NAME.test(f.path);
    var longest = 0;
    for (var q = 0; q < lines.length; q++) if (lines[q].length > longest) longest = lines[q].length;
    var known = KNOWN_LIB.test(text.slice(0, 400)) || KNOWN_LIB_NAME.test(f.path);
    var rctx = { text: text, lang: lang, path: f.path, minified: minified || (longest > LIMITS.longLine && known) };
    var occ = [], dests = [], assigns = [], urlVars = {};
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (!raw) continue;
      var t = raw.trim();
      if (isCommentLine(lang, t)) continue;
      var low = raw.length > 200000 ? raw.slice(0, 200000).toLowerCase() : raw.toLowerCase();
      var ld = lineDests(raw, lang);
      for (var r = 0; r < rules.length; r++) {
        var ru = rules[r];
        if (ru.kw) { var hit = false; for (var k = 0; k < ru.kw.length; k++) if (low.indexOf(ru.kw[k]) !== -1) { hit = true; break; } if (!hit) continue; }
        var m = ru.re.exec(raw);
        if (!m) continue;
        var over = ru.check ? ru.check.call(ru, m, raw, rctx) : {};
        if (over === null) continue;
        var col = m.index + (m[0].length - m[0].replace(/^[^\w$.<\-\\/'"`]+/, '').length);
        var o = { rule: ru, line: i + 1, col: col, raw: raw, over: over || {} };
        occ.push(o);
        if (o.over.hidden) ld.push({ host: hostOf(o.over.hidden), url: o.over.hidden.slice(0, LIMITS.urlLen), col: col, hidden: true });
      }
      ld.forEach(function (d) { d.line = i + 1; d.raw = raw; dests.push(d); });
      var tg = assignTarget(lang, raw);
      if (tg) {
        assigns.push({ line: i + 1, target: tg, raw: raw });
        if (ld.length && !urlVars[tg]) urlVars[tg] = ld[0];
      }
    }
    // Hidden URLs assigned through a decode on another line: `const H = atob(X)` where X held it.
    return { lines: lines, occ: occ, dests: dests, assigns: assigns, urlVars: urlVars, longest: longest, known: known, minified: minified };
  }
  function hostOf(url) {
    var hm = /^[a-z]+:\/\/(?:[^@/?#]*@)?([^:/?#]*)/i.exec(url);
    return hm ? hm[1].toLowerCase() : String(url).toLowerCase();
  }

  /* ---------------- package.json, manifest.json, Python packaging ---------------- */

  function lineOfText(text, needle) {
    var i = text.indexOf(needle);
    if (i === -1) return 1;
    var n = 1;
    for (var k = 0; k < i; k++) if (text.charCodeAt(k) === 10) n++;
    return n;
  }
  function lineAt(text, line) { return text.split(/\r\n|\r|\n/)[line - 1] || ''; }
  function looseJson(text) {
    try { return JSON.parse(text); } catch (e) { /* try without comments */ }
    try { return JSON.parse(text.replace(/^\s*\/\/.*$/mg, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1')); } catch (e2) { return null; }
  }
  function urlsIn(v, out) {
    if (!v) return;
    if (typeof v === 'string') { var m = /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]*@)?([^:/?#]+)/i.exec(v) || /^git@([^:]+):/.exec(v); if (m) out.push(m[1].toLowerCase()); return; }
    if (typeof v === 'object') ['url', 'web', 'homepage'].forEach(function (k) { if (typeof v[k] === 'string') urlsIn(v[k], out); });
  }
  var LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preuninstall', 'uninstall', 'postuninstall'];
  var RISKY_SCRIPT = /\b(?:curl|wget|node\s+-e|node\s+--eval|python\d?\s+-c|base64|eval|powershell|pwsh|iwr|irm|bash\s+-c|sh\s+-c|nc\s|https?:\/\/)\b|\|\s*(?:ba)?sh\b/;

  function readPackageJson(f, meta) {
    var j = looseJson(f.text), out = { findings: [], installFiles: [], firstParty: [], deps: [] };
    if (!j || typeof j !== 'object') return out;
    if (!meta.name && typeof j.name === 'string') { meta.name = clean(j.name, 80); meta.kind = meta.kind || 'npm'; meta.version = typeof j.version === 'string' ? clean(j.version, 30) : ''; }
    urlsIn(j.homepage, out.firstParty); urlsIn(j.repository, out.firstParty); urlsIn(j.bugs, out.firstParty); urlsIn(j.author, out.firstParty);
    if (typeof j.repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(j.repository)) out.firstParty.push('github.com');
    var scripts = j.scripts && typeof j.scripts === 'object' ? j.scripts : {};
    LIFECYCLE.forEach(function (name) {
      var cmd = scripts[name];
      if (typeof cmd !== 'string' || !cmd.trim()) return;
      var line = lineOfText(f.text, '"' + name + '"');
      var risky = RISKY_SCRIPT.test(cmd);
      var when = name === 'prepare' ? 'when installed from git, and before publishing' : /uninstall/.test(name) ? 'when it is uninstalled' : 'as soon as it is installed';
      out.findings.push({ rule: 'inst.script', cat: 'install', sev: risky ? 'high' : 'medium', file: f.path, line: line, col: 0, snippet: snippetOf(lineAt(f.text, line), 0),
        title: 'Runs `' + clean(cmd, 90) + '` ' + when + ' (' + name + ')',
        why: 'npm runs ' + name + ' scripts automatically, with your user\u2019s access to files and tokens - before you have used the package at all.' + (risky ? ' This one reaches for the network or runs code from text.' : ''),
        tags: ['install'] });
      var re = /\b(?:node|tsx|ts-node|bun|deno run|python\d?|sh|bash)\s+(?:-[\w-]+\s+)*['"]?([\w./-]+\.(?:c|m)?[jt]s|[\w./-]+\.py|[\w./-]+\.sh)\b/g, m;
      while ((m = re.exec(cmd))) out.installFiles.push(normPath(m[1]));
    });
    ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies'].forEach(function (k) {
      var d = j[k];
      if (!d || typeof d !== 'object') return;
      Object.keys(d).slice(0, 400).forEach(function (dep) {
        var v = d[dep];
        if (typeof v !== 'string') return;
        if (/^(?:https?:|git\+|git:|github:|[\w-]+\/[\w.-]+(?:#.*)?$|file:)/.test(v) && !/^npm:/.test(v)) {
          var line = lineOfText(f.text, '"' + dep + '"');
          out.findings.push({ rule: 'inst.dep', cat: 'install', sev: k === 'devDependencies' ? 'info' : 'low', file: f.path, line: line, col: 0, snippet: snippetOf(lineAt(f.text, line), 0),
            title: 'Gets ' + clean(dep, 60) + ' from outside the npm registry (' + clean(v, 70) + ')', why: 'A dependency from a URL or a git repository is not checked by the registry, and can change under the same name.', tags: ['install'] });
          var h = /^(?:git\+)?https?:\/\/([^/:]+)/.exec(v);
          if (h) out.deps.push({ host: h[1].toLowerCase(), url: v.slice(0, LIMITS.urlLen), line: line, raw: lineAt(f.text, line) });
        }
      });
    });
    return out;
  }

  var PERMS = {
    '<all_urls>': ['high', 'Read and change everything on every website you visit'],
    cookies: ['high', 'Read and change your cookies - including the ones that keep you signed in'],
    webRequest: ['medium', 'See every request your browser makes'],
    webRequestBlocking: ['high', 'Change or block every request your browser makes'],
    history: ['medium', 'Read your whole browsing history'],
    tabs: ['low', 'See the address and title of every tab'],
    clipboardRead: ['high', 'Read what you copy'],
    clipboardWrite: ['low', 'Change what is on your clipboard'],
    nativeMessaging: ['high', 'Talk to a program installed on your computer, outside the browser'],
    debugger: ['high', 'Take over pages with the debugger: read and change anything in them'],
    scripting: ['medium', 'Put its own code into pages'],
    declarativeNetRequest: ['low', 'Block or redirect requests by rules'],
    declarativeNetRequestWithHostAccess: ['medium', 'Block or redirect requests on the sites it can reach'],
    declarativeNetRequestFeedback: ['medium', 'See which requests its rules matched'],
    management: ['medium', 'See, turn off or remove your other extensions'],
    proxy: ['high', 'Send all your browsing through a server of its choosing'],
    privacy: ['medium', 'Change your privacy settings'],
    downloads: ['low', 'Start and read your downloads'],
    'downloads.open': ['medium', 'Open files it downloads'],
    identity: ['medium', 'Sign in to your Google or other accounts as you'],
    'identity.email': ['medium', 'Read your account email address'],
    geolocation: ['medium', 'Know where you are'],
    webNavigation: ['medium', 'See every page you go to'],
    desktopCapture: ['high', 'Record your screen'],
    tabCapture: ['high', 'Record what is in a tab'],
    pageCapture: ['medium', 'Save whole pages'],
    topSites: ['medium', 'See the sites you visit most'],
    bookmarks: ['low', 'Read and change your bookmarks'],
    contentSettings: ['medium', 'Change which sites may use your camera, microphone and more'],
    browsingData: ['medium', 'Delete your browsing data'],
    sessions: ['low', 'See recently closed tabs and other devices\u2019 tabs'],
    storage: ['info', 'Keep its own settings'],
    unlimitedStorage: ['info', 'Keep a lot of its own data'],
    alarms: ['info', 'Wake itself up on a timer'],
    notifications: ['info', 'Show you notifications'],
    contextMenus: ['info', 'Add items to the right-click menu'],
    activeTab: ['info', 'Act on the page you are on when you click it - the safe way to ask'],
    offscreen: ['low', 'Run a hidden page in the background'],
    sidePanel: ['info', 'Open a side panel'],
    tabGroups: ['info', 'Organise your tab groups'],
    idle: ['info', 'Know when you are away'],
    power: ['info', 'Keep the computer awake'],
    tts: ['info', 'Read text aloud'],
    search: ['low', 'Run searches'],
    favicon: ['info', 'Show site icons'],
    userScripts: ['high', 'Run user scripts on pages'],
    certificateProvider: ['high', 'Provide certificates to the browser'],
    vpnProvider: ['high', 'Act as a VPN'],
    'enterprise.platformKeys': ['high', 'Use the device\u2019s keys'],
    readingList: ['low', 'Read your reading list'],
    system: ['info', 'Read system information'],
  };
  function hostScope(p) {
    var s = String(p);
    if (s === '<all_urls>' || /^(?:\*|https?|wss?):\/\/\*\/\*$/.test(s) || /^\*:\/\/\*\//.test(s) || s === '*://*/*' || s === 'http://*/*' || s === 'https://*/*') return 'all';
    var m = /^[*a-z]+:\/\/([^/]+)\//i.exec(s);
    return m ? m[1].replace(/^\*\./, '') : null;
  }
  function readManifest(f, meta) {
    var j = looseJson(f.text), out = { findings: [], permissions: [], background: [], content: [], firstParty: [] };
    if (!j || typeof j !== 'object' || !j.manifest_version) return out;
    meta.kind = 'extension';
    if (!meta.name && typeof j.name === 'string') meta.name = clean(/^__MSG_/.test(j.name) ? 'A browser extension' : j.name, 80);
    meta.version = typeof j.version === 'string' ? clean(j.version, 30) : meta.version;
    meta.mv = j.manifest_version;
    urlsIn(j.homepage_url, out.firstParty); urlsIn(j.author && j.author.email ? null : j.author, out.firstParty);
    var perms = [].concat(Array.isArray(j.permissions) ? j.permissions : [], Array.isArray(j.host_permissions) ? j.host_permissions : []);
    var optional = [].concat(Array.isArray(j.optional_permissions) ? j.optional_permissions : [], Array.isArray(j.optional_host_permissions) ? j.optional_host_permissions : []);
    var seen = {}, allSites = false, hasCookies = false;
    function add(p, isOptional) {
      if (typeof p !== 'string' || seen[p]) return;
      seen[p] = 1;
      var line = lineOfText(f.text, '"' + p + '"');
      var known = PERMS[p], scope = hostScope(p);
      var sev, words;
      if (known) { sev = known[0]; words = known[1]; }
      else if (scope === 'all') { sev = 'high'; words = 'Read and change everything on every website you visit'; allSites = true; }
      else if (scope) { sev = 'low'; words = 'Read and change pages on ' + clean(scope, 60); }
      else { sev = 'low'; words = 'A permission Sniff does not know (' + clean(p, 60) + ')'; }
      if (p === '<all_urls>') allSites = true;
      if (p === 'cookies') hasCookies = true;
      if (isOptional && SEV[sev] > 0) { sev = sev === 'high' ? 'medium' : sev === 'medium' ? 'low' : 'info'; words += ' - only if you agree when it asks'; }
      out.permissions.push({ name: clean(p, 80), sev: sev, words: words, line: line, optional: Boolean(isOptional) });
    }
    perms.forEach(function (p) { add(p, false); });
    optional.forEach(function (p) { add(p, true); });
    if (hasCookies && !allSites) out.permissions.forEach(function (p) { if (p.name === 'cookies') { p.sev = 'medium'; p.words = 'Read and change cookies on the sites it is allowed on'; } });
    // One finding for the permissions (each is listed in words in its own section).
    var asked = out.permissions.filter(function (p) { return SEV[p.sev] >= 1 && !p.optional; }).sort(function (a, b) { return SEV[b.sev] - SEV[a.sev]; });
    var later = out.permissions.filter(function (p) { return SEV[p.sev] >= 1 && p.optional; });
    if (asked.length) {
      var top = asked[0], words = asked.slice(0, 2).map(function (p) { return p.words.charAt(0).toLowerCase() + p.words.slice(1); });
      out.findings.push({ rule: 'perm', cat: 'permission', sev: top.sev, file: f.path, line: top.line, col: 0, snippet: snippetOf(lineAt(f.text, top.line), 0),
        title: 'Asks to ' + words.join(', and to ') + (asked.length > 2 ? ' (+' + (asked.length - 2) + ' more)' : ''),
        why: 'The browser grants these at install and does not ask again: the extension can do this on every page it covers, every day. ' + asked.map(function (p) { return p.name; }).join(', ') + '.',
        lines: asked.map(function (p) { return p.line; }), count: asked.length });
    }
    if (later.length) {
      out.findings.push({ rule: 'perm.optional', cat: 'permission', sev: 'info', file: f.path, line: later[0].line, col: 0, snippet: snippetOf(lineAt(f.text, later[0].line), 0),
        title: 'May ask later for ' + plural(later.length, 'more permission') + ' (' + clean(later.map(function (p) { return p.name; }).join(', '), 80) + ')', why: 'Optional permissions need your yes when it asks - read what it asks for.', lines: later.map(function (p) { return p.line; }), count: later.length });
    }
    (Array.isArray(j.content_scripts) ? j.content_scripts : []).forEach(function (cs) {
      if (!cs || typeof cs !== 'object') return;
      var matches = Array.isArray(cs.matches) ? cs.matches : [];
      var every = matches.some(function (m) { return hostScope(m) === 'all'; });
      var js = Array.isArray(cs.js) ? cs.js.filter(function (x) { return typeof x === 'string'; }).map(normPath) : [];
      js.forEach(function (x) { out.content.push(x); });
      if (every) {
        var line = lineOfText(f.text, '"content_scripts"');
        out.findings.push({ rule: 'perm.content', cat: 'permission', sev: 'high', file: f.path, line: line, col: 0, snippet: snippetOf(lineAt(f.text, line), 0),
          title: 'Runs its own code inside every page you open' + (js.length ? ' (' + clean(js.join(', '), 80) + ')' : ''), why: 'A content script on every site sees what you see there - mail, banking, messages - and can read the page and what you type.' + (cs.all_frames ? ' It runs in every frame too.' : '') });
      }
    });
    var bg = j.background || {};
    [].concat(typeof bg.service_worker === 'string' ? [bg.service_worker] : [], Array.isArray(bg.scripts) ? bg.scripts : [], typeof bg.page === 'string' ? [bg.page] : []).forEach(function (s) {
      if (typeof s !== 'string') return;
      out.background.push(normPath(s));
    });
    if (out.background.length) {
      var bl = lineOfText(f.text, '"background"');
      out.findings.push({ rule: 'inst.background', cat: 'install', sev: 'info', file: f.path, line: bl, col: 0, snippet: snippetOf(lineAt(f.text, bl), 0),
        title: 'Runs in the background whenever your browser is open (' + clean(out.background.join(', '), 80) + ')', why: 'Background code runs without a page open: it is where an extension keeps working while you browse.' });
    }
    var ec = j.externally_connectable;
    if (ec && Array.isArray(ec.matches) && ec.matches.some(function (m) { return hostScope(m) === 'all'; })) {
      var el = lineOfText(f.text, '"externally_connectable"');
      out.findings.push({ rule: 'perm.external', cat: 'permission', sev: 'medium', file: f.path, line: el, col: 0, snippet: snippetOf(lineAt(f.text, el), 0), title: 'Lets any website send it messages', why: 'Any page can talk to the extension, including pages made to trick it.' });
    }
    var csp = typeof j.content_security_policy === 'string' ? j.content_security_policy : (j.content_security_policy && typeof j.content_security_policy.extension_pages === 'string' ? j.content_security_policy.extension_pages : '');
    if (/unsafe-eval|https?:\/\/[^\s;']+|\*/.test(csp)) {
      var cl = lineOfText(f.text, '"content_security_policy"');
      out.findings.push({ rule: 'perm.csp', cat: 'hiding', sev: 'medium', file: f.path, line: cl, col: 0, snippet: snippetOf(lineAt(f.text, cl), 0), title: 'Loosens its own security policy (' + clean(csp, 70) + ')', why: 'Allowing eval or outside scripts lets it run code that is not in the package.' });
    }
    return out;
  }
  function readPyPackaging(f, meta) {
    var out = { findings: [], firstParty: [] }, m;
    var nm = /^\s*name\s*=\s*['"]([^'"]{1,80})['"]/m.exec(f.text) || /\bname\s*=\s*['"]([^'"]{1,80})['"]/.exec(f.text);
    if (nm && !meta.name) { meta.name = clean(nm[1], 80); meta.kind = meta.kind || 'python'; }
    var re = /(?:^|\n)\s*(?:url|homepage|Homepage|Repository|Source|home_page|project_urls\s*=[^\n]*)\s*[=:]\s*['"]?((?:https?):\/\/[^'"\s,]+)/g;
    while ((m = re.exec(f.text))) urlsIn(m[1], out.firstParty);
    var be = /build-backend\s*=\s*['"]([^'"]+)['"]/.exec(f.text);
    if (be && !/^(?:setuptools\.build_meta(?::__legacy__)?|hatchling\.build|poetry\.core\.masonry\.api|poetry\.masonry\.api|flit_core\.buildapi|pdm\.backend|pdm\.pep517\.api|maturin|scikit_build_core\.build|mesonpy|uv_build)$/.test(be[1])) {
      var line = lineOfText(f.text, be[0]);
      out.findings.push({ rule: 'inst.backend', cat: 'install', sev: 'low', file: f.path, line: line, col: 0, snippet: snippetOf(lineAt(f.text, line), 0), title: 'Builds with an unusual backend (' + clean(be[1], 60) + ')', why: 'The build backend runs during pip install. An uncommon one is worth a look at where it comes from.', tags: ['install'] });
    }
    return out;
  }

  /* ---------------- the whole scan ---------------- */

  function relResolve(from, spec) {
    var parts = dirname(from) ? dirname(from).split('/') : [];
    spec.split('/').forEach(function (s) { if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s); });
    return parts.join('/');
  }
  function findingId(f) { return hashText([f.cat, f.rule, f.file, f.line, f.title].join('|')).slice(0, 12); }

  /**
   * files: [{path, lang, text, bytes, cut}] -> the report. meta: {name, kind,
   * source, skipped, counts, notes, root, bytes}. Pure: the same files give
   * the same report.
   */
  function scan(files, meta0) {
    var meta = Object.assign({ name: '', kind: '', version: '', notes: [] }, meta0 || {});
    meta.notes = (meta.notes || []).slice();
    var findings = [], permissions = [], firstParty = {}, installFiles = {}, background = {}, contentFiles = {}, depDests = [];
    var byPath = {};
    files.forEach(function (f) { byPath[f.path] = f; });

    // 1. The packaging files: what is first-party, what runs at install.
    files.forEach(function (f) {
      if (f.lang === 'pkg') {
        var p = readPackageJson(f, meta);
        findings = findings.concat(p.findings);
        p.firstParty.forEach(function (h) { firstParty[siteOf(h)] = 1; });
        p.installFiles.forEach(function (x) { installFiles[relResolve(f.path, x)] = 'npm install script'; });
        p.deps.forEach(function (d) { d.file = f.path; depDests.push(d); });
      } else if (f.lang === 'manifest') {
        var mf = readManifest(f, meta);
        findings = findings.concat(mf.findings);
        permissions = permissions.concat(mf.permissions.map(function (p) { p.file = f.path; return p; }));
        mf.firstParty.forEach(function (h) { firstParty[siteOf(h)] = 1; });
        mf.background.forEach(function (x) { background[relResolve(f.path, x)] = 1; });
        mf.content.forEach(function (x) { contentFiles[relResolve(f.path, x)] = 1; });
      } else if (f.lang === 'pyproject' || basename(f.path) === 'setup.py') {
        var py = readPyPackaging(f, meta);
        findings = findings.concat(py.findings);
        py.firstParty.forEach(function (h) { firstParty[siteOf(h)] = 1; });
        if (basename(f.path) === 'setup.py') installFiles[f.path] = 'pip install (setup.py)';
      }
    });
    ['github.com', 'gitlab.com', 'npmjs.com', 'npmjs.org', 'pypi.org', 'chrome.google.com', 'chromewebstore.google.com', 'addons.mozilla.org', 'google.com', 'bitbucket.org'].forEach(function (h) { delete firstParty[h]; });

    // 2. Every code file, line by line.
    var perFile = {}, destRows = [], totalLines = 0;
    files.forEach(function (f) {
      if (f.lang === 'pkg' || f.lang === 'manifest' || f.lang === 'pyproject') { totalLines += f.text.split('\n').length; return; }
      var s = scanFile(f, meta);
      perFile[f.path] = s;
      totalLines += s.lines.length;
      var installAt = installFiles[f.path] || (basename(f.path) === '__init__.py' ? 'import' : '');
      s.installAt = installAt;
      s.dests.forEach(function (d) { destRows.push({ host: d.host, url: d.url, file: f.path, line: d.line, hidden: Boolean(d.hidden), raw: d.raw, col: d.col }); });
      if (s.longest > LIMITS.longLine) {
        var li = 0; for (var q = 0; q < s.lines.length; q++) if (s.lines[q].length === s.longest) { li = q; break; }
        findings.push({ rule: 'hide.packed', cat: 'hiding', sev: s.known ? 'info' : (s.minified ? 'info' : 'low'), file: f.path, line: li + 1, col: 0, snippet: snippetOf(s.lines[li], 0),
          title: s.known ? 'A known library, minified (' + basename(f.path) + ')' : s.minified ? 'Minified, so hard to read (' + basename(f.path) + ')' : 'Packed onto one line of ' + fmtInt(s.longest) + ' characters',
          why: s.known ? 'Looks like a well-known library. Compare it with the official copy if you want to be sure.' : 'Build tools do this; so does code that does not want to be read. The readable source, if there is one, is not what runs.' });
      }
      if (f.cut) meta.notes.push('Only the first ' + fmtBytes(LIMITS.fileBytes) + ' of ' + f.path + ' was read.');
    });

    // 3. Each rule occurrence -> grouped findings; sinks get their destination.
    var groups = {};
    function destFor(s, o) {
      var here = s.dests.filter(function (d) { return d.line === o.line; });
      if (here.length) return here.sort(function (a, b) { return Math.abs(a.col - o.col) - Math.abs(b.col - o.col); })[0];
      var names = Object.keys(s.urlVars);
      for (var k = 0; k <= 3; k++) {
        var raw = s.lines[o.line - 1 + k];
        if (raw === undefined) break;
        if (k > 0) { var dd = s.dests.filter(function (d) { return d.line === o.line + k; }); if (dd.length) return dd[0]; }
        for (var n = 0; n < names.length; n++) if (mentions(raw, names[n])) return s.urlVars[names[n]];
      }
      return null;
    }
    Object.keys(perFile).forEach(function (path) {
      var s = perFile[path];
      s.sinks = []; s.sources = [];
      s.occ.forEach(function (o) {
        var ru = o.rule, ov = o.over;
        var cat = ru.cat, sev = ov.sev || ru.sev, title = ov.title || ru.title, why = ov.why || ru.why;
        var isNet = ov.net || ru.net, isExec = ru.exec && !ov.net;
        var dest = null, tag = null;
        if (cat === 'sink' && (isNet || ru.handoff)) {
          dest = destFor(s, o);
          if (dest) tag = tagHost(dest.host, dest.url, firstParty);
        }
        if (cat === 'sink') s.sinks.push({ o: o, net: isNet, exec: isExec, handoff: ru.handoff, dest: dest, tag: tag, label: ov.label || ru.label, sev: sev });
        if (cat === 'source') s.sources.push({ o: o, phrase: ov.phrase || ru.phrase, sensitive: ov.sensitive !== undefined ? ov.sensitive : ru.sensitive, handoffIn: ru.handoffIn, sev: sev, title: title });
        if (ru.internal) return;
        if (cat === 'sink' && tag) {
          if (tag.tag === 'risky') { sev = 'high'; title = 'Sends data to ' + tag.label; why = tag.why; }
          else if (tag.tag === 'unknown' || tag.tag === 'dynamic') { sev = maxSev(sev, 'low'); title = title + ' to ' + tag.label; }
          else if (tag.tag === 'first') { sev = maxSev(sev, 'low'); title = title + ' to ' + tag.label; }
          else title = title + ' to ' + tag.label;
        }
        var tags = [];
        if (s.installAt && (cat === 'sink' || cat === 'source' || cat === 'hiding')) {
          tags.push('install');
          if (SEV[sev] >= 1 || isNet || isExec) { sev = bump(sev); why = (why ? why + ' ' : '') + (s.installAt === 'import' ? 'This file runs as soon as the package is imported.' : 'This file runs at install time (' + s.installAt + ').'); }
        }
        if (background[path]) tags.push('background');
        if (contentFiles[path]) tags.push('content');
        var key = ru.id + '|' + path + '|' + title;
        var g = groups[key];
        if (!g) {
          g = groups[key] = { rule: ru.id, cat: cat, sev: sev, file: path, line: o.line, col: o.col, snippet: snippetOf(o.raw, o.col), title: title, why: why, lines: [], count: 0, tags: tags };
          if (dest) g.dest = { host: dest.host, tag: tag.tag };
          if (ov.decoded) g.decoded = ov.decoded;
          findings.push(g);
        }
        g.count++;
        if (g.lines.length < LIMITS.linesPerFinding) g.lines.push(o.line);
      });
    });

    // 4. Flows.
    var flows = [];
    function flowSev(src, sink, inInstall) {
      var t = sink.tag ? sink.tag.tag : 'none';
      var sev;
      if (t === 'risky') sev = 'high';
      else if (src.sensitive >= 3) sev = (t === 'first' || t === 'known' || t === 'local') ? 'medium' : 'high';
      else if (src.sensitive === 2) sev = (t === 'first' || t === 'known' || t === 'local') ? 'low' : 'medium';
      else sev = (t === 'first' || t === 'known' || t === 'local' || t === 'none') ? 'low' : 'medium';
      if (inInstall && sev !== 'high') sev = bump(sev);
      return sev;
    }
    function destPhrase(sink) {
      if (sink.exec && !sink.net) return 'a program it runs';
      if (!sink.tag) return 'an address it works out while it runs';
      return sink.tag.label;
    }
    function flowSentence(src, sink, via) {
      var how = sink.label === 'curl' || sink.label === 'wget' || (sink.exec && sink.net) ? ' with ' + (sink.label === 'a shell command' ? 'a shell command' : sink.label) : '';
      var many = src.many || /^(?:everything|all |screenshots)/.test(src.phrase) || /(?:keys|cookies|wallets|passwords|tabs|logins|credentials|variables|secrets)(?:\s*\([^)]*\))?(?: from other sites)?$/.test(src.phrase);
      return 'Reads ' + src.phrase + ' and sends ' + (many ? 'them' : 'it') + ' to ' + destPhrase(sink) + how + (via ? ' ' + via : '');
    }
    function addFlow(fl) {
      var key = [fl.source.file, fl.source.line, fl.source.rule, fl.sink.file, fl.sink.line, fl.dest ? fl.dest.host : ''].join('|');
      if (flows.some(function (x) { return x.key === key; })) return;
      fl.key = key;
      flows.push(fl);
    }
    function linkInFile(path, s) {
      var tainted = {}; // name -> source index
      s.sources.forEach(function (src, si) {
        if (!src.sensitive && !src.handoffIn) return;
        var tg = assignTarget(perFileLang(path), src.o.raw);
        if (tg) tainted[tg] = si;
      });
      for (var pass = 0; pass < 3; pass++) {
        s.assigns.forEach(function (a) {
          if (tainted[a.target] !== undefined) return;
          var names = Object.keys(tainted);
          for (var n = 0; n < names.length && n < 200; n++) if (mentions(a.raw.slice(a.raw.indexOf('=') + 1 || 0), names[n]) || mentions(a.raw, names[n]) && a.raw.indexOf(a.target) !== a.raw.search(new RegExp('(?:^|[^\\w$])\\$?' + names[n].replace(/[$]/g, '\\$') + '(?![\\w$])'))) { tainted[a.target] = tainted[names[n]]; break; }
        });
      }
      var links = [];
      s.sinks.forEach(function (sk) {
        if (!sk.net && !sk.handoff && !(sk.exec)) return;
        var raw = sk.o.raw;
        s.sources.forEach(function (src, si) {
          if (!src.sensitive && !src.handoffIn) return;
          var via = null;
          var names = Object.keys(tainted).filter(function (nm) { return tainted[nm] === si; });
          for (var n = 0; n < names.length; n++) if (mentions(raw, names[n]) || mentions(s.lines[sk.o.line] || '', names[n]) && /^\s*[^=]*[,(]\s*$/.test(raw)) { via = 'through `' + names[n] + '`'; break; }
          if (!via && src.o.line === sk.o.line && Math.abs(src.o.col - sk.o.col) <= LIMITS.flowChars) via = 'on the same line';
          if (!via && src.o.line !== sk.o.line && Math.abs(src.o.line - sk.o.line) <= LIMITS.flowLines && src.o.raw.length < LIMITS.longLine && raw.length < LIMITS.longLine) via = 'close together (lines ' + Math.min(src.o.line, sk.o.line) + '-' + Math.max(src.o.line, sk.o.line) + ')';
          if (via) links.push({ src: src, si: si, sink: sk, via: via });
        });
      });
      return links;
    }
    var langOfPath = {};
    files.forEach(function (f) { langOfPath[f.path] = f.lang; });
    function perFileLang(p) { return langOfPath[p] || 'js'; }
    var handOut = [], handIn = [];
    Object.keys(perFile).forEach(function (path) {
      var s = perFile[path];
      linkInFile(path, s).forEach(function (L) {
        if (L.src.handoffIn) { if (L.sink.net) handIn.push({ path: path, L: L }); return; }
        if (L.sink.handoff) { handOut.push({ path: path, L: L }); return; }
        if (L.sink.exec && !L.sink.net) return; // a command that does not reach out
        var inInstall = Boolean(s.installAt);
        addFlow({ srcObj: L.src, sinkObj: L.sink, sev: flowSev(L.src, L.sink, inInstall), file: path, line: L.sink.o.line, title: flowSentence(L.src, L.sink, ''), via: L.via,
          source: { file: path, line: L.src.o.line, snippet: snippetOf(L.src.o.raw, L.src.o.col), rule: L.src.o.rule.id, what: L.src.phrase, title: L.src.title },
          sink: { file: path, line: L.sink.o.line, snippet: snippetOf(L.sink.o.raw, L.sink.o.col), rule: L.sink.o.rule.id, how: L.sink.label },
          dest: L.sink.dest ? { host: L.sink.dest.host, tag: L.sink.tag.tag, label: L.sink.tag.label, why: L.sink.tag.why } : null, install: inInstall });
      });
    });
    // A content script that hands something sensitive to a background script that sends it out.
    handOut.forEach(function (A) {
      handIn.forEach(function (B) {
        if (A.path === B.path) return;
        addFlow({ srcObj: A.L.src, sinkObj: B.L.sink, sev: flowSev(A.L.src, B.L.sink, false), file: B.path, line: B.L.sink.o.line, title: flowSentence(A.L.src, B.L.sink, ''), via: 'passed from ' + A.path + ' to ' + B.path + ' in a message',
          source: { file: A.path, line: A.L.src.o.line, snippet: snippetOf(A.L.src.o.raw, A.L.src.o.col), rule: A.L.src.o.rule.id, what: A.L.src.phrase, title: A.L.src.title },
          handoff: { file: A.path, line: A.L.sink.o.line, snippet: snippetOf(A.L.sink.o.raw, A.L.sink.o.col) },
          sink: { file: B.path, line: B.L.sink.o.line, snippet: snippetOf(B.L.sink.o.raw, B.L.sink.o.col), rule: B.L.sink.o.rule.id, how: B.L.sink.label },
          dest: B.L.sink.dest ? { host: B.L.sink.dest.host, tag: B.L.sink.tag.tag, label: B.L.sink.tag.label, why: B.L.sink.tag.why } : null, install: false });
      });
    });
    // A file that reads something sensitive, imported by a file that sends things out.
    Object.keys(perFile).forEach(function (bPath) {
      var b = perFile[bPath];
      var netSinks = b.sinks.filter(function (k) { return k.net; });
      if (!netSinks.length) return;
      var imp = /(?:require\(\s*|from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g, m, seenA = {};
      while ((m = imp.exec(b.lines.join('\n')))) {
        var target = relResolve(bPath, m[1]);
        var cands = [target, target + '.js', target + '.ts', target + '.mjs', target + '.cjs', target + '/index.js', target + '.py'];
        for (var c = 0; c < cands.length; c++) {
          var a = perFile[cands[c]];
          if (!a || seenA[cands[c]] || cands[c] === bPath) continue;
          seenA[cands[c]] = 1;
          var srcs = a.sources.filter(function (x) { return x.sensitive >= 2; });
          if (!srcs.length) continue;
          if (flows.some(function (fl) { return fl.source.file === cands[c]; })) continue;
          var sk = netSinks.slice().sort(function (x, y) { return (y.tag ? TAG_RANK[y.tag.tag] : 3) - (x.tag ? TAG_RANK[x.tag.tag] : 3); })[0];
          var src = srcs[0];
          var sev = flowSev(src, sk, Boolean(b.installAt));
          if (!(sk.tag && sk.tag.tag === 'risky') && sev === 'high') sev = 'medium';
          addFlow({ srcObj: src, sinkObj: sk, sev: sev, file: bPath, line: sk.o.line, title: flowSentence(src, sk, ''), via: 'by importing ' + cands[c] + ' (a looser link - check that the two meet)',
            source: { file: cands[c], line: src.o.line, snippet: snippetOf(src.o.raw, src.o.col), rule: src.o.rule.id, what: src.phrase, title: src.title },
            sink: { file: bPath, line: sk.o.line, snippet: snippetOf(sk.o.raw, sk.o.col), rule: sk.o.rule.id, how: sk.label },
            dest: sk.dest ? { host: sk.dest.host, tag: sk.tag.tag, label: sk.tag.label, why: sk.tag.why } : null, install: Boolean(b.installAt) });
        }
      }
    });
    // One flow per way out: several things read and sent by the same line are one finding.
    var merged = [], bySink = {};
    flows.forEach(function (fl) {
      var k = fl.sink.file + '|' + fl.sink.line + '|' + (fl.dest ? fl.dest.host : '');
      var m0 = bySink[k];
      if (!m0) { fl.sources = [fl.source]; fl.srcObjs = [fl.srcObj]; bySink[k] = fl; merged.push(fl); return; }
      if (m0.sources.some(function (x) { return x.what === fl.source.what; })) return;
      m0.sources.push(fl.source); m0.srcObjs.push(fl.srcObj);
      m0.sev = maxSev(m0.sev, fl.sev);
    });
    flows = merged;
    flows.forEach(function (fl) {
      var whats = fl.sources.map(function (x) { return x.what; });
      var joined = whats.length <= 2 ? whats.join(' and ') : whats.slice(0, -1).join(', ') + ' and ' + whats[whats.length - 1];
      fl.title = flowSentence({ phrase: joined, many: whats.length > 1 || fl.srcObjs[0].many }, fl.sinkObj, '');
      delete fl.srcObj; delete fl.srcObjs; delete fl.sinkObj; delete fl.source; fl.source = fl.sources[0];
    });
    flows.forEach(function (fl) {
      fl.cat = 'flow'; fl.rule = 'flow';
      fl.snippet = fl.sink.snippet;
      // The destination's own explanation, from the class it was tagged with
      // (worked out from its full URL - a webhook path, not just the host).
      fl.why = (fl.dest && fl.dest.why && (fl.dest.tag === 'risky' || fl.dest.tag === 'unknown' || fl.dest.tag === 'dynamic') ? fl.dest.why + ' ' : '') +
        'The code reads it on line ' + fl.source.line + (fl.source.file !== fl.sink.file ? ' of ' + fl.source.file : '') + ' and sends on line ' + fl.sink.line + (fl.sink.file !== fl.source.file ? ' of ' + fl.sink.file : '') + ' - ' + fl.via + '. That the two meet is read from the text, not watched happening.';
      fl.count = 1; fl.lines = [fl.line]; fl.tags = fl.install ? ['install'] : [];
      delete fl.key;
    });

    // 5. Destinations: one row per host.
    var hosts = {};
    destRows.concat(depDests.map(function (d) { return { host: d.host, url: d.url, file: d.file, line: d.line, hidden: false, dep: true }; })).forEach(function (d) {
      var key = d.host || ('(built at run time) ' + clean(d.url, 60));
      var h = hosts[key];
      if (!h) {
        var t = tagHost(d.host, d.url, firstParty);
        h = hosts[key] = { host: d.host || '', url: clean(d.url, LIMITS.urlLen), tag: t.tag, label: t.label, why: t.why, refs: [], count: 0, hidden: false, sent: false, dep: Boolean(d.dep) };
      }
      else {
        // The riskiest class any URL on this host earned wins (a webhook path
        // makes discord.com risky even if a plain discord.com link came first).
        var t2 = tagHost(d.host, d.url, firstParty);
        if (TAG_RANK[t2.tag] > TAG_RANK[h.tag]) { h.tag = t2.tag; h.label = t2.label; h.why = t2.why; h.url = clean(d.url, LIMITS.urlLen); }
      }
      h.count++;
      if (d.hidden) h.hidden = true;
      if (h.refs.length < 10) h.refs.push({ file: d.file, line: d.line });
    });
    flows.forEach(function (fl) { if (fl.dest && hosts[fl.dest.host]) hosts[fl.dest.host].sent = true; });
    findings.forEach(function (f) { if (f.dest && hosts[f.dest.host]) hosts[f.dest.host].used = true; });
    var destinations = Object.keys(hosts).map(function (k) { return hosts[k]; }).sort(function (a, b) {
      return TAG_RANK[b.tag] - TAG_RANK[a.tag] || Number(b.sent) - Number(a.sent) || b.count - a.count || (a.host < b.host ? -1 : 1);
    });
    destinations.forEach(function (d) {
      if (d.tag !== 'risky' || d.sent || d.used) return;
      findings.push({ rule: 'dest.risky', cat: 'destination', sev: d.hidden ? 'high' : 'medium', file: d.refs[0].file, line: d.refs[0].line, col: 0,
        snippet: snippetOf(lineAt(byPath[d.refs[0].file] ? byPath[d.refs[0].file].text : '', d.refs[0].line), 0), title: 'Names ' + d.label + (d.hidden ? ', hidden in encoded text' : ''), why: d.why + ' Sniff did not see it used, but it is in the code.', lines: d.refs.map(function (r) { return r.line; }), count: d.count, tags: [] });
    });

    // 5a. Two rules that say the same thing about the same line (curl run by
    // execSync is both "a shell command" and "curl") are one finding.
    var seenF = {};
    findings = findings.filter(function (f) {
      var k = [f.cat, f.file, f.line, clean(f.title, 220)].join('|');
      var prev = seenF[k];
      if (!prev) { seenF[k] = f; return true; }
      if (SEV[f.sev] > SEV[prev.sev]) prev.sev = f.sev;
      (f.lines || []).forEach(function (l) { if (prev.lines && prev.lines.indexOf(l) === -1 && prev.lines.length < LIMITS.linesPerFinding) prev.lines.push(l); });
      return false;
    });

    // 5b. What a flow already says is not counted twice: the sources and the
    // sinks it joins are listed, marked as part of it, and left out of the verdict.
    var all0 = flows.concat(findings);
    all0.forEach(function (f) { f.title = clean(f.title, 220); f.id = findingId(f); });
    findings.forEach(function (f) {
      if (f.cat !== 'source' && f.cat !== 'sink') return;
      for (var i = 0; i < flows.length; i++) {
        var fl = flows[i];
        var hit = f.cat === 'sink' ? (fl.sink.file === f.file && f.lines.indexOf(fl.sink.line) !== -1) || (fl.handoff && fl.handoff.file === f.file && f.lines.indexOf(fl.handoff.line) !== -1)
          : fl.sources.some(function (x) { return x.file === f.file && f.lines.indexOf(x.line) !== -1; });
        if (hit) { f.partOf = fl.id; break; }
      }
    });

    // 6. Order, bound, id.
    var all = flows.concat(findings);
    all.forEach(function (f) { if (!f.lines) f.lines = [f.line]; if (!f.count) f.count = f.lines.length; if (!f.tags) f.tags = []; f.title = clean(f.title, 220); f.why = clean(f.why || '', 600); f.id = findingId(f); });
    var CAT_ORDER = { flow: 0, destination: 1, install: 2, hiding: 3, source: 4, sink: 5, permission: 6 };
    all.sort(function (a, b) { return SEV[b.sev] - SEV[a.sev] || CAT_ORDER[a.cat] - CAT_ORDER[b.cat] || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line; });
    var dropped = 0;
    if (all.length > LIMITS.findings) { dropped = all.length - LIMITS.findings; all = all.slice(0, LIMITS.findings); meta.notes.push(fmtInt(dropped) + ' lower findings were left off the list.'); }

    var counts = { high: 0, medium: 0, low: 0, info: 0 }, cats = {};
    all.forEach(function (f) { counts[f.sev]++; cats[f.cat] = (cats[f.cat] || 0) + 1; });
    var netFiles = Object.keys(perFile).filter(function (p) { return perFile[p].sinks.some(function (k) { return k.net; }); });
    var report = {
      v: 1,
      name: meta.name || '', kind: meta.kind || (files.some(function (f) { return f.lang === 'py'; }) ? 'python' : 'code'), version: meta.version || '', mv: meta.mv || null,
      root: meta.root || '',
      files: files.map(function (f) { return { path: f.path, lang: f.lang, bytes: f.bytes, lines: f.text.split('\n').length, cut: Boolean(f.cut), install: installFiles[f.path] || '', background: Boolean(background[f.path]), content: Boolean(contentFiles[f.path]) }; }),
      skipped: (meta.skipped || []).slice(0, LIMITS.skippedKept), skippedCounts: meta.counts || {},
      bytes: meta.bytes || files.reduce(function (t, f) { return t + f.bytes; }, 0), lines: totalLines,
      findings: all, counts: counts, cats: cats, dropped: dropped,
      flows: all.filter(function (f) { return f.cat === 'flow'; }).length,
      permissions: permissions, destinations: destinations,
      reachesOut: netFiles.length > 0 || destinations.some(function (d) { return d.tag !== 'local'; }) && netFiles.length > 0,
      networkFiles: netFiles,
      firstParty: Object.keys(firstParty).sort(),
      notes: meta.notes,
      fingerprint: hashText(files.map(function (f) { return f.path + ':' + hashText(f.text); }).sort().join('\n')),
    };
    report.map = dataMap(report);
    report.verdict = verdict(report, {});
    return report;
  }

  /** Sources -> sinks -> destinations, one row per flow, plus what is unconnected. */
  function dataMap(report) {
    var rows = report.findings.filter(function (f) { return f.cat === 'flow'; }).map(function (f) {
      return { id: f.id, sev: f.sev, what: f.source.what, from: f.source.file, how: f.sink.how, at: f.sink.file + ':' + f.sink.line, to: f.dest ? f.dest.host : '', tag: f.dest ? f.dest.tag : 'none', label: f.dest ? f.dest.label : 'an address worked out at run time' };
    });
    var reads = {}, ways = {};
    report.findings.forEach(function (f) {
      if (f.cat === 'source' && SEV[f.sev] >= 1) reads[f.title] = (reads[f.title] || 0) + f.count;
      if (f.cat === 'sink') ways[RULE_BY_ID[f.rule] ? RULE_BY_ID[f.rule].label || f.title : f.title] = 1;
    });
    return { rows: rows, reads: Object.keys(reads).slice(0, 12), ways: Object.keys(ways).slice(0, 12), places: report.destinations.filter(function (d) { return d.tag !== 'local'; }).length };
  }

  /** The one-line answer, counting only what has not been marked "looked at - fine". */
  function verdict(report, fine) {
    var open = { high: 0, medium: 0, low: 0, info: 0 };
    // A source or sink a flow already covers is counted once, as the flow.
    report.findings.forEach(function (f) { if (!(fine && fine[f.id]) && !f.partOf) open[f.sev]++; });
    var v;
    if (open.high) v = { level: 'high', title: plural(open.high, 'thing') + ' to look at before you install', sub: open.medium ? 'Plus ' + plural(open.medium, 'thing') + ' worth a closer look.' : '' };
    else if (open.medium) v = { level: 'medium', title: 'Nothing alarming - ' + plural(open.medium, 'thing') + ' worth a look', sub: 'No high-risk pattern was found. Read the medium ones before you trust it with anything private.' };
    else if (!report.reachesOut) v = { level: 'clear', title: 'Nothing reaches out - still read it', sub: 'Sniff found no code that talks to the internet. That rules out the obvious, not the clever.' };
    else v = { level: 'low', title: 'Nothing stands out - still read it', sub: 'It talks to the internet, but nothing Sniff reads as risky goes with it.' };
    v.open = open;
    v.fine = report.findings.filter(function (f) { return fine && fine[f.id]; }).length;
    return v;
  }

  /* ---------------- the model: what is sent ---------------- */

  /** Lines around one line of a file, each cut to a bounded width centred on
   *  where the finding is, invisible characters made visible. */
  function contextOf(text, line, radius, col) {
    var lines = String(text || '').split(/\r\n|\r|\n/);
    var r = radius === undefined ? LIMITS.contextLines : radius;
    var start = Math.max(1, line - r), end = Math.min(lines.length, line + r);
    var w = LIMITS.contextLineChars, out = [];
    for (var i = start; i <= end; i++) {
      var s = String(lines[i - 1]).replace(/\t/g, '  ');
      if (s.length > w) {
        var c = i === line && col ? Math.max(0, col - Math.floor(w / 3)) : 0;
        s = (c > 0 ? '…' : '') + s.slice(c, c + w) + (c + w < s.length ? '…' : '');
      }
      out.push(markInvisible(s));
    }
    return { start: start, lines: out };
  }
  function snippetRecord(file, ctx) { return { file: clean(file, LIMITS.pathLen), start: ctx.start, lines: ctx.lines }; }
  function findingBrief(f) {
    return { category: f.cat, severity: f.sev, title: clean(f.title, 220), file: clean(f.file, LIMITS.pathLen), line: f.line };
  }
  /** Explain one finding: the finding in words and the lines around it (both
   *  ends of a flow). getText(path) -> the file's text, from the device. */
  function explainPayload(f, getText) {
    var snippets = [];
    var locs = f.cat === 'flow' ? [f.source, f.handoff, f.sink].filter(Boolean) : [{ file: f.file, line: f.line, col: f.col }];
    locs.forEach(function (l) {
      var t = getText(l.file);
      if (t === null || t === undefined) return;
      snippets.push(snippetRecord(l.file, contextOf(t, l.line, LIMITS.contextLines, l.col)));
    });
    var p = { finding: findingBrief(f), snippets: snippets };
    while (JSON.stringify(p).length > LIMITS.explainChars && p.snippets.some(function (s) { return s.lines.length > 9; })) {
      p.snippets.forEach(function (s) { if (s.lines.length > 9) { s.lines = s.lines.slice(2, -2); s.start += 2; } });
    }
    if (!p.snippets.length) return { error: 'That file is not in memory any more - scan it again.' };
    return p;
  }
  /** Second opinion: the shape of the scan, and up to 40 snippets around the
   *  findings that matter most - never whole files. */
  function reviewPayload(report, getText) {
    var top = report.findings.filter(function (f) { return SEV[f.sev] >= 1; });
    var summary = {
      kind: report.kind, name: clean(report.name, 80), files: report.files.length, lines: report.lines,
      permissions: report.permissions.slice(0, 40).map(function (p) { return { name: p.name, severity: p.sev }; }),
      destinations: report.destinations.slice(0, 40).map(function (d) { return { host: clean(d.host, 120), tag: d.tag, hidden: d.hidden }; }),
      findings: top.slice(0, LIMITS.reviewFindings).map(findingBrief),
    };
    var snippets = [], chars = JSON.stringify(summary).length, seen = {};
    for (var i = 0; i < top.length && snippets.length < LIMITS.reviewSnippets; i++) {
      var f = top[i];
      var locs = f.cat === 'flow' ? [f.source, f.sink] : [{ file: f.file, line: f.line, col: f.col }];
      for (var k = 0; k < locs.length && snippets.length < LIMITS.reviewSnippets; k++) {
        var l = locs[k], key = l.file + ':' + Math.floor(l.line / 10);
        if (seen[key]) continue;
        var t = getText(l.file);
        if (t === null || t === undefined) continue;
        var rec = snippetRecord(l.file, contextOf(t, l.line, f.cat === 'permission' || f.rule === 'inst.script' ? 6 : LIMITS.contextLines, l.col));
        var size = JSON.stringify(rec).length;
        if (chars + size > LIMITS.reviewChars) {
          rec = snippetRecord(l.file, contextOf(t, l.line, 4, l.col));
          size = JSON.stringify(rec).length;
          if (chars + size > LIMITS.reviewChars) continue;
        }
        seen[key] = 1; chars += size; snippets.push(rec);
      }
    }
    return { summary: summary, snippets: snippets };
  }

  var VERDICTS = ['likely-benign', 'worth-checking', 'likely-malicious'];
  var VERDICT_WORD = { 'likely-benign': 'Likely fine', 'worth-checking': 'Worth checking', 'likely-malicious': 'Likely malicious' };
  /** The model's answer, bounded and stripped of markup. null when unusable. */
  function cleanOpinion(v) {
    if (!v || typeof v !== 'object') return null;
    var verdictV = typeof v.verdict === 'string' && VERDICTS.indexOf(v.verdict) !== -1 ? v.verdict : null;
    var why = typeof v.why === 'string' ? clean(v.why.replace(/<[^>]*>/g, '').replace(/[<>]/g, ''), 900) : '';
    if (!verdictV || !why.trim()) return null;
    var raw = Array.isArray(v.whatToCheck) ? v.whatToCheck : Array.isArray(v.what_to_check) ? v.what_to_check : [];
    var checks = raw.filter(function (x) { return typeof x === 'string' && x.trim(); }).slice(0, 6).map(function (x) { return clean(x.replace(/<[^>]*>/g, '').replace(/[<>]/g, ''), 240); }).filter(function (x) { return x.trim(); });
    var conf = ['low', 'medium', 'high'].indexOf(v.confidence) !== -1 ? v.confidence : 'low';
    return { verdict: verdictV, why: why, whatToCheck: checks, confidence: conf };
  }

  /* ---------------- exports ---------------- */

  function mdCode(s) {
    var t = String(s === null || s === undefined ? '' : s).replace(CTRL, '').replace(/[\r\n]+/g, ' ');
    var ticks = 1; while (t.indexOf(new Array(ticks + 1).join('`')) !== -1) ticks++;
    var fence = new Array(ticks + 1).join('`');
    return fence + (ticks > 1 || /^`|`$/.test(t) ? ' ' + t + ' ' : t) + fence;
  }
  function mdText(s) {
    return String(s === null || s === undefined ? '' : s).replace(CTRL, '').replace(/[\r\n]+/g, ' ')
      .replace(/[\\`*_{}[\]()#+!|>~]/g, '\\$&').replace(/</g, '&lt;').replace(/^(\s*)([-=])/, '$1\\$2').replace(/^(\s*\d+)\./, '$1\\.');
  }
  /** Markdown with backticks in a title shown as code. */
  function mdRich(s) {
    return String(s || '').split(/`([^`]{1,200})`/).map(function (part, i) { return i % 2 ? mdCode(part) : mdText(part); }).join('');
  }
  var CAT_WORD = { flow: 'Flow', source: 'Reads', sink: 'Sends', hiding: 'Hiding', install: 'Install-time', permission: 'Permission', destination: 'Destination' };
  function toMarkdown(report, fine, when) {
    var v = verdict(report, fine || {});
    var o = ['# Sniff report: ' + mdText(report.name || 'scanned code'), '', '**' + mdText(v.title) + '**' + (v.sub ? ' ' + mdText(v.sub) : ''), '',
      '- Read: ' + plural(report.files.length, 'file') + ', ' + fmtInt(report.lines) + ' lines, ' + fmtBytes(report.bytes) + (when ? ' on ' + mdText(when) : ''),
      '- Findings: ' + ['high', 'medium', 'low', 'info'].map(function (s) { return report.counts[s] + ' ' + s; }).join(', ') + (v.fine ? ' (' + v.fine + ' marked "looked at - fine")' : ''),
      '- Static reading, not proof: this lists what the code could do, from its text. It ran nothing.', ''];
    if (report.findings.some(function (f) { return f.cat === 'flow'; })) {
      o.push('## Where data could go', '');
      report.findings.filter(function (f) { return f.cat === 'flow'; }).forEach(function (f) {
        o.push('- **' + SEV_WORD[f.sev] + '** ' + mdRich(f.title) + ' - ' + mdCode(f.source.file + ':' + f.source.line) + ' -> ' + mdCode(f.sink.file + ':' + f.sink.line) + (fine && fine[f.id] ? ' *(looked at - fine)*' : ''));
      });
      o.push('');
    }
    o.push('## Findings', '');
    ['high', 'medium', 'low', 'info'].forEach(function (s) {
      var list = report.findings.filter(function (f) { return f.sev === s && f.cat !== 'flow'; });
      if (!list.length) return;
      o.push('### ' + SEV_WORD[s] + ' (' + list.length + ')', '');
      list.forEach(function (f) {
        o.push('- ' + CAT_WORD[f.cat] + ': ' + mdRich(f.title) + ' - ' + mdCode(f.file + ':' + f.line) + (f.count > 1 ? ' and ' + (f.count - 1) + ' more' : '') + (fine && fine[f.id] ? ' *(looked at - fine)*' : ''));
        if (f.snippet) o.push('  ' + mdCode(f.snippet));
      });
      o.push('');
    });
    if (report.permissions.length) {
      o.push('## Extension permissions', '');
      report.permissions.forEach(function (p) { o.push('- ' + mdCode(p.name) + ' - ' + mdText(p.words) + ' (' + SEV_WORD[p.sev].toLowerCase() + ')'); });
      o.push('');
    }
    if (report.destinations.length) {
      o.push('## Destinations', '', '| Host | What it is | Where |', '|---|---|---|');
      report.destinations.forEach(function (d) {
        o.push('| ' + mdCode(d.host || d.url) + ' | ' + mdText(TAG_WORD[d.tag] + (d.hidden ? ', hidden' : '') + (d.sent ? ', data sent' : '')) + ' | ' + d.refs.slice(0, 3).map(function (r) { return mdCode(r.file + ':' + r.line); }).join(' ') + ' |');
      });
      o.push('');
    }
    var sk = Object.keys(report.skippedCounts || {});
    if (sk.length) {
      o.push('## Not read', '');
      sk.forEach(function (k) { o.push('- ' + mdText(REASON_WORDS[k] || k) + ': ' + report.skippedCounts[k]); });
      o.push('');
    }
    (report.notes || []).forEach(function (n) { o.push('> ' + mdText(n)); });
    o.push('', '_Made with Sniff. The code was read on the device that ran this report; nothing was uploaded._', '');
    return o.join('\n');
  }
  function toJson(report, fine) {
    var out = JSON.parse(JSON.stringify(report));
    out.findings.forEach(function (f) { f.lookedAtFine = Boolean(fine && fine[f.id]); });
    out.verdict = verdict(report, fine || {});
    out.tool = 'Sniff (static reading, not proof)';
    return JSON.stringify(out, null, 2) + '\n';
  }

  return {
    LIMITS: LIMITS, SEV: SEV, SEV_WORD: SEV_WORD, SEV_ICON: SEV_ICON, TAG_WORD: TAG_WORD, TAG_RANK: TAG_RANK, CAT_WORD: CAT_WORD, REASON_WORDS: REASON_WORDS, LANG_WORD: LANG_WORD, PERMS: PERMS,
    VERDICTS: VERDICTS, VERDICT_WORD: VERDICT_WORD, RULES: R,
    clean: clean, esc: esc, markInvisible: markInvisible, fmtInt: fmtInt, plural: plural, fmtBytes: fmtBytes, hashText: hashText, basename: basename, normPath: normPath, stripCommonRoot: stripCommonRoot,
    skipDir: skipDir, classify: classify, langOf: langOf, archiveKind: archiveKind, crxToZip: crxToZip, zipEntries: zipEntries, tarEntries: tarEntries, openArchive: openArchive, inflate: inflate, decodeText: decodeText, collect: collect, pastedFile: pastedFile, streamsOk: streamsOk,
    tagHost: tagHost, siteOf: siteOf, lineDests: lineDests, b64decode: b64decode,
    scan: scan, verdict: verdict, dataMap: dataMap,
    contextOf: contextOf, explainPayload: explainPayload, reviewPayload: reviewPayload, cleanOpinion: cleanOpinion,
    mdCode: mdCode, mdText: mdText, toMarkdown: toMarkdown, toJson: toJson,
  };
}));
