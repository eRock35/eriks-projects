/* Proof - the rules. One file, run in three places: the page and its parse
 * worker (self.ProofCore) and the server and tests (require).
 *
 * An agent run ends with a confident summary ("Done! All tests pass"). Proof
 * reads the run itself - every command, edit, output and exit code - and
 * checks each claim in that summary against the agent's own receipts:
 *
 *   reading    parseRun: a Claude Code transcript (.jsonl), Claude Code's
 *              terminal output pasted, Anthropic or OpenAI messages (JSON),
 *              OpenAI Responses items or a Codex session (.jsonl), a generic
 *              tool-call log (JSON lines), or plain terminal text. Bounded,
 *              and what was skipped is counted under a reason.
 *   steps      every tool call classified (test / lint / types / build /
 *              edit / write / delete / commit / push / pr / deploy /
 *              migrate / run / read / search), its output parsed for test
 *              and checker summaries, its exit code and duration kept
 *   claims     extractClaims: the sentences in the agent's final message
 *              that say something checkable, with negation, hedges and
 *              intent kept apart
 *   receipts   judge: Backed / Partly / No evidence / Contradicted, each
 *              with the exact steps and lines that decided it
 *   patterns   suspicious: tests skipped, focused, removed or weakened, a
 *              mock of the thing under test, a hard-coded expected value,
 *              code that checks whether it is under test, errors swallowed,
 *              timeouts raised, hooks skipped - only what the run ADDED
 *   verdict    a one-line outcome, a trust score with its reasons, and the
 *              three things to check before merging
 *   exports    toMarkdown (a PR comment), toJson, summaryText
 *   the model  opinionPayload (what the person sees and confirms before a
 *              second opinion), cleanJudgement (the answer, validated)
 *
 * Everything here is pure and deterministic and touches no network and no
 * storage. A run is someone else's output - an agent's, and the programs it
 * ran - so every string from it is hostile by definition: it is kept as
 * plain text here, and only ever drawn through esc(), or exported through
 * mdText / mdCode.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProofCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    inputBytes: 32 * 1024 * 1024,  // a dropped file bigger than this is refused
    lines: 80000,                  // lines of a .jsonl (or text) read; the rest is cut, and said so
    lineChars: 2 * 1024 * 1024,    // one JSON line longer than this is skipped
    steps: 4000,                   // steps kept on the timeline; the rest are counted
    outHead: 3000,                 // characters of a tool's output kept from the start...
    outTail: 6000,                 // ...and from the end, where summaries are
    inputChars: 24000,             // an edit's old / new text kept
    textChars: 8000,               // one message kept
    goalChars: 2000,
    criteria: 12,
    criterionChars: 200,
    claims: 40,
    admissions: 6,
    evLines: 6,                    // evidence lines shown per receipt
    evChars: 240,                  // characters per evidence line
    labelChars: 160,
    pathLen: 300,
    opinionSnippets: 40,           // snippets sent to "Second opinion"
    opinionLines: 12,              // lines per snippet
    opinionLineChars: 300,
    opinionChars: 64000,           // characters sent in all
  };

  /* ---------------- text ---------------- */

  var CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF]/g;
  var INVISIBLE_G = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF\u00AD]/g;
  // Terminal colour codes and OSC sequences: agents' tools print them.
  var ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;
  function str(v) { return v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v); }
  /** A string safe to show as one line of text: control, bidi and zero-width characters removed, bounded. */
  function clean(v, max) {
    var s = str(v).replace(ANSI, '').replace(/\t/g, ' ').replace(/[\r\n]+/g, ' ').replace(CTRL, '');
    var m = max || 500;
    return s.length > m ? s.slice(0, m - 1) + '…' : s;
  }
  /** HTML-escape (quotes too), and drop control, bidi and zero-width characters. */
  function esc(v) {
    return str(v).replace(CTRL, '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /** Invisible characters made visible, as ⟨U+202E⟩ - in evidence, and in what the model is sent. */
  function markInvisible(s) {
    return str(s).replace(INVISIBLE_G, function (c) { return '⟨U+' + ('000' + c.charCodeAt(0).toString(16).toUpperCase()).slice(-4) + '⟩'; })
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, function (c) { return '⟨' + c.charCodeAt(0).toString(16) + '⟩'; });
  }
  function clip(s, n) { s = str(s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; }
  /** A line from a run, made safe to show and to send: colours gone, invisibles visible, tabs as spaces, bounded. */
  function shown(s, n) { return clip(markInvisible(str(s).replace(ANSI, '').replace(/\t/g, '  ').replace(/\r/g, '').replace(/\n/g, ' ')), n || LIMITS.evChars); }
  function firstLine(s, n) {
    var lines = str(s).replace(ANSI, '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) if (lines[i].trim()) return clip(lines[i].trim(), n || LIMITS.labelChars);
    return '';
  }
  function fmtInt(n) { n = Math.round(Number(n) || 0); return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function plural(n, one, many) { return fmtInt(n) + ' ' + (Number(n) === 1 ? one : (many || one + 's')); }
  function fmtMs(ms) {
    ms = Number(ms);
    if (!isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
    if (ms < 3600000) return Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s';
    return Math.floor(ms / 3600000) + ' h ' + Math.round((ms % 3600000) / 60000) + ' min';
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return fmtInt(n) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  /** A short, stable fingerprint (two FNV-1a passes, hex). Never sent anywhere. */
  function hashText(s) {
    s = str(s);
    var a = 2166136261, b = 5381;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      a ^= c; a = Math.imul(a, 16777619) >>> 0;
      b = (Math.imul(b, 33) + c) >>> 0;
    }
    return ('0000000' + a.toString(16)).slice(-8) + ('0000000' + b.toString(16)).slice(-8);
  }
  function basename(p) { p = str(p); var i = p.lastIndexOf('/'); return i === -1 ? p : p.slice(i + 1); }
  function uniq(arr) { var seen = {}, out = []; arr.forEach(function (x) { var k = typeof x + ':' + x; if (!seen[k]) { seen[k] = 1; out.push(x); } }); return out; }
  function lastOf(arr) { return arr.length ? arr[arr.length - 1] : null; }
  /** Keep the head and the tail of a long output: a test summary is at the end. */
  function headTail(text) {
    var t = str(text);
    var max = LIMITS.outHead + LIMITS.outTail;
    if (t.length <= max + 200) return { text: t, cut: false };
    return { text: t.slice(0, LIMITS.outHead) + '\n… [' + fmtInt(t.length - max) + ' characters not kept] …\n' + t.slice(-LIMITS.outTail), cut: true };
  }
  function lastMatch(text, re) {
    var m, last = null;
    re.lastIndex = 0;
    while ((m = re.exec(text))) { last = m; if (m[0] === '') re.lastIndex++; }
    return last;
  }
  function allMatches(text, re) {
    var m, out = [];
    re.lastIndex = 0;
    while ((m = re.exec(text))) { out.push(m); if (m[0] === '') re.lastIndex++; }
    return out;
  }

  /* ---------------- paths ---------------- */

  function normPath(p) {
    var s = clean(p, LIMITS.pathLen).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    s = s.replace(/^(?:\.\/)+/, '');
    s = s.replace(/^['"`]+|['"`,;:]+$/g, '');
    return s;
  }
  var TEST_PATH = /(^|\/)(__tests__|tests?|spec|specs|e2e|__snapshots__|testing)\/|\.(test|spec)\.[a-z0-9]+$|_test\.(go|py|rb|exs?|dart)$|(^|\/)test_[^/]+\.py$|(Test|Tests|Spec)\.(java|kt|cs|swift|php|scala)$|_spec\.rb$|(^|\/)conftest\.py$/i;
  var DOC_PATH = /\.(md|mdx|markdown|rst|txt|adoc)$|(^|\/)(docs?|documentation)\/|(^|\/)(README|CHANGELOG|CHANGES|HISTORY|LICENSE|NOTICE|AUTHORS|CONTRIBUTING)(\.[a-z]+)?$/i;
  var TEST_CONFIG = /(^|\/)(package\.json|jest\.config\.[a-z]+|vitest\.config\.[a-z]+|vitest\.workspace\.[a-z]+|vite\.config\.[a-z]+|\.mocharc(\.[a-z]+)?|karma\.conf\.[a-z]+|playwright\.config\.[a-z]+|cypress\.config\.[a-z]+|pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|noxfile\.py|phpunit\.xml(\.dist)?|\.nycrc(\.[a-z]+)?|codecov\.ya?ml|\.coveragerc|Makefile|\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile|Cargo\.toml|go\.mod)$|(^|\/)\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)\.circleci\/config\.ya?ml$/i;
  function isTestPath(p) { return TEST_PATH.test(str(p)); }
  function isDocPath(p) { return DOC_PATH.test(str(p)) && !isTestPath(p); }
  function isTestConfig(p) { return TEST_CONFIG.test(str(p)); }
  /** Does a changed path answer to a path someone named? `invoice.ts` names `src/billing/invoice.ts`. */
  function samePath(changed, named) {
    var a = normPath(changed).toLowerCase(), b = normPath(named).toLowerCase().replace(/\/+$/, '');
    if (!a || !b) return false;
    return a === b || a.slice(-(b.length + 1)) === '/' + b || b.slice(-(a.length + 1)) === '/' + a;
  }
  /** Is `p` inside the folder or file `scope`? Simple globs (`*`, `**`) are understood. */
  function inScope(p, scope) {
    var a = normPath(p).toLowerCase();
    var s = normPath(scope).toLowerCase().replace(/\/+$/, '');
    if (!s) return false;
    if (/\*/.test(s)) {
      var re = new RegExp('^(?:.*/)?' + s.split('**').map(function (part) { return part.split('*').map(function (x) { return x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }).join('[^/]*'); }).join('.*') + '(?:/.*)?$');
      return re.test(a);
    }
    return a === s || a.indexOf(s + '/') === 0 || a.indexOf('/' + s + '/') !== -1 || a.slice(-(s.length + 1)) === '/' + s;
  }

  /* ---------------- shell commands ---------------- */

  /** Split a command line into segments on && || ; | and newlines, outside quotes. */
  function splitShell(cmd) {
    var out = [], cur = '', q = null, i = 0, s = str(cmd);
    function push(op) { out.push({ text: cur.trim(), op: op || null }); cur = ''; }
    while (i < s.length) {
      var c = s.charAt(i);
      if (q) { cur += c; if (c === '\\' && q === '"' && i + 1 < s.length) { cur += s.charAt(i + 1); i += 2; continue; } if (c === q) q = null; i++; continue; }
      if (c === '\\' && i + 1 < s.length) { cur += c + s.charAt(i + 1); i += 2; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; i++; continue; }
      var two = s.substr(i, 2);
      if (two === '&&' || two === '||') { push(two); i += 2; continue; }
      if (c === ';' || c === '\n') { push(';'); i++; continue; }
      if (c === '|' && s.charAt(i + 1) !== '&') { push('|'); i++; continue; }
      if (c === '|' && s.charAt(i + 1) === '&') { push('|'); i += 2; continue; }
      cur += c; i++;
    }
    push(null);
    return out.filter(function (x) { return x.text; });
  }
  /** One segment with the noise around the real program taken off. */
  function normSeg(seg) {
    var s = str(seg).trim().replace(/^[({]\s*/, '').replace(/\s*[)}]$/, '');
    for (var k = 0; k < 6; k++) {
      var before = s;
      s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
        .replace(/^(?:sudo|time|command|nohup|exec|builtin|env)\s+/, '')
        .replace(/^(?:npx|bunx|pnpx)\s+(?:--yes\s+|-y\s+|--no-install\s+)?/, '')
        .replace(/^(?:pnpm|yarn)\s+(?:exec|dlx)\s+/, '')
        .replace(/^npm\s+exec\s+(?:--\s+)?/, '')
        .replace(/^(?:poetry|uv|pipenv|pdm|rye|hatch)\s+run\s+/, '')
        .replace(/^bundle\s+exec\s+/, '')
        .replace(/^timeout\s+\d+[smh]?\s+/, '');
      if (s === before) break;
    }
    return s;
  }
  var RE_TEST = [
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)(?::[\w:.-]+)?(?:\s|$)/,
    /^(?:npm|pnpm|yarn|bun)\s+run\s+[\w:.-]*test[\w:.-]*(?:\s|$)/,
    /^(?:jest|vitest|mocha|ava|tap|tape|jasmine|karma\s+start|cypress\s+run|playwright\s+test|pytest|py\.test|tox|nox|rspec|phpunit|ctest|mix\s+test|deno\s+test|bun\s+test|swift\s+test|flutter\s+test|dart\s+test|elixir\s+-S\s+mix\s+test|lein\s+test|sbt\s+test|stack\s+test|cabal\s+test|zig\s+build\s+test|bats)(?:\s|$)/,
    /^(?:\.\/)?(?:node_modules\/\.bin\/)?(?:jest|vitest|mocha)(?:\s|$)/,
    /^(?:go|cargo|dotnet|gradle|\.\/gradlew|gradlew|mvn|\.\/mvnw|rake|rails|bin\/rails)\s+(?:test|nextest|verify)(?:\s|$)/,
    /^python[0-9.]*\s+-m\s+(?:pytest|unittest|nose2?)\b/,
    /^python[0-9.]*\s+(?:\S+\/)?manage\.py\s+test\b/,
    /^node\s+(?:--test\b|(?:\S*\/)?(?:test|tests|spec)\/\S+|\S*test\S*\.m?[jt]s\b)/,
    /^make\s+(?:test|tests|check|test-\w+)\b/,
    /^php\s+artisan\s+test\b/,
  ];
  var RE_TYPES = [
    /^(?:tsc|vue-tsc)\b.*--noEmit\b/,
    /^(?:mypy|pyright|pyre|basedpyright)\b/,
    /^flow(?:\s+check)?\s*$/,
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|types|tsc|check-types|check:types|lint:types|types:check)\b/,
    /^cargo\s+check\b/,
  ];
  var RE_LINT = [
    /^(?:eslint|ruff(?:\s+check)?|flake8|pylint|golangci-lint|rubocop|stylelint|standard|xo|swiftlint|ktlint|shellcheck|hadolint|markdownlint|oxlint)\b/,
    /^biome\s+(?:check|lint|ci)\b/,
    /^prettier\b.*(?:--check|-c\b)/,
    /^black\b.*--check\b/,
    /^cargo\s+clippy\b/,
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|eslint|lint:[\w:-]+)\b/,
    /^make\s+lint\b/,
    /^go\s+vet\b/,
  ];
  var RE_BUILD = [
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/,
    /^tsc\b(?!.*--noEmit)/,
    /^(?:go|cargo|dotnet|swift|zig)\s+build\b/,
    /^(?:mvn|\.\/mvnw)\s+(?:package|install|compile)\b/,
    /^(?:gradle|\.\/gradlew)\s+(?:build|assemble)\b/,
    /^(?:webpack|rollup|esbuild|parcel\s+build|vite\s+build|next\s+build|nuxt\s+build|astro\s+build|turbo\s+(?:run\s+)?build)\b/,
    /^make(?:\s+(?:build|all))?\s*$/,
    /^docker\s+(?:build|compose\s+build)\b/,
  ];
  var RE_MIGRATE = [
    /^(?:npm|pnpm|yarn|bun)\s+run\s+[\w:.-]*migrat[\w:.-]*/,
    /^prisma\s+(?:migrate\s+(?:deploy|dev|reset)|db\s+push)\b/,
    /^alembic\s+(?:upgrade|downgrade)\b/,
    /^(?:rails|bin\/rails|rake)\s+db:(?:migrate|rollback|schema:load|setup)\b/,
    /^python[0-9.]*\s+(?:\S+\/)?manage\.py\s+migrate\b/,
    /^(?:knex|sequelize(?:-cli)?|typeorm|drizzle-kit|flyway|goose|dbmate|atlas|liquibase|sqlx|diesel)\b.*\b(?:migrat\w*|up|push|update|run)\b/,
    /^migrate\b.*\b(?:up|down|goto)\b/,
    /^supabase\s+(?:db\s+push|migration\s+up)\b/,
    /^php\s+artisan\s+migrate\b/,
    /^psql\b.*-f\s+\S*migrat/,
  ];
  var RE_DEPLOY = [
    /^(?:npm|pnpm|yarn|bun)\s+run\s+[\w:.-]*(?:deploy|release|ship)[\w:.-]*/,
    /^(?:vercel|netlify\s+deploy|fly\s+deploy|flyctl\s+deploy|firebase\s+deploy|serverless\s+deploy|sls\s+deploy|cdk\s+deploy|pulumi\s+up|terraform\s+apply|eb\s+deploy|heroku\s+\S+|gcpdeploy\s+(?:ship|create)|wrangler\s+(?:deploy|publish)|amplify\s+publish|railway\s+up|render\s+deploy|cap\s+\S+\s+deploy|kamal\s+deploy|helmfile\s+apply)\b/,
    /^gcloud\s+(?:run|app|functions)\s+deploy\b/,
    /^kubectl\s+(?:apply|rollout|set\s+image|replace)\b/,
    /^helm\s+(?:upgrade|install)\b/,
    /^git\s+push\s+(?:heroku|production|prod|dokku|deploy)\b/,
    /^(?:npm|pnpm|yarn)\s+publish\b/,
    /^docker\s+push\b/,
    /^aws\s+\S+\s+(?:deploy|update-function-code|update-service|create-deployment)\b/,
    /^az\s+\S+.*\bdeploy\b/,
  ];
  var RE_PR = [/^gh\s+pr\s+create\b/, /^hub\s+pull-request\b/, /^glab\s+mr\s+create\b/];
  var RE_COMMIT = /^git\s+commit\b/;
  var RE_PUSH = /^git\s+push\b/;
  var RE_READ = /^(?:cat|head|tail|less|more|ls|tree|wc|stat|file|pwd|echo|printf|which|type|whoami|date|env|printenv|du|df|jq|bat|nl|hexdump|xxd|od|realpath|readlink)\b/;
  var RE_SEARCH = /^(?:grep|egrep|fgrep|rg|ag|ack|find|fd|locate|git\s+(?:grep|log|diff|status|show|blame|branch|remote|rev-parse|ls-files)|diff|cmp|test|\[|command\s+-v)\b/;
  var RE_INSTALL = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci|remove|uninstall)|pip[0-9]*\s+install|poetry\s+(?:install|add)|uv\s+(?:pip|add|sync)|cargo\s+(?:add|install|fetch)|go\s+(?:get|mod)|bundle(?:\s+install)?|gem\s+install|composer\s+(?:install|require)|brew\s+install|apt(?:-get)?\s+install)\b/;
  // A probe's non-zero exit is an answer, not a failure: grep found nothing, diff found a difference.
  var PROBE = /^(?:grep|egrep|fgrep|rg|ag|ack|diff|cmp|test|\[|which|command\s+-v|git\s+diff\b.*--(?:exit-code|quiet))\b/;
  var CLEANUP = /^(?:rm|rmdir|mkdir|kill|pkill|killall|docker\s+(?:rm|stop|kill)|git\s+(?:branch\s+-[dD]|stash\s+drop|worktree\s+remove)|unlink|umount|lsof|fuser|pgrep|chmod|chown|ln|touch|cp|mv)\b/;
  var SWALLOW_TAIL = /^(?:true|:|exit\s+0|return\s+0|echo\b.*|printf\b.*)$/;
  var QUIET = /(?:^|\s)(?:2>\s*\/dev\/null|&>\s*\/dev\/null|>\s*\/dev\/null(?:\s+2>&1)?|2>&1\s*>\s*\/dev\/null|>&\s*\/dev\/null)/;
  var ACT_RANK = { pr: 14, deploy: 13, migrate: 12, test: 11, types: 10, lint: 9, build: 8, push: 7, commit: 6, delete: 5, edit: 4, write: 4, install: 3, run: 2, search: 1, read: 0 };

  function segKind(n) {
    var i;
    for (i = 0; i < RE_PR.length; i++) if (RE_PR[i].test(n)) return 'pr';
    for (i = 0; i < RE_DEPLOY.length; i++) if (RE_DEPLOY[i].test(n)) return 'deploy';
    for (i = 0; i < RE_MIGRATE.length; i++) if (RE_MIGRATE[i].test(n)) return 'migrate';
    for (i = 0; i < RE_TEST.length; i++) if (RE_TEST[i].test(n)) return 'test';
    for (i = 0; i < RE_TYPES.length; i++) if (RE_TYPES[i].test(n)) return 'types';
    for (i = 0; i < RE_LINT.length; i++) if (RE_LINT[i].test(n)) return 'lint';
    for (i = 0; i < RE_BUILD.length; i++) if (RE_BUILD[i].test(n)) return 'build';
    if (RE_COMMIT.test(n)) return 'commit';
    if (RE_PUSH.test(n)) return 'push';
    if (/^(?:rm|git\s+rm|unlink|trash)\s/.test(n)) return 'delete';
    if (/^(?:sed\s+(?:-[a-zA-Z]*i|--in-place)|perl\s+-[a-zA-Z]*i|tee\b|mv\s|cp\s|git\s+(?:apply|am|checkout\s+--|restore)\b|patch\b|apply_patch\b|truncate\b)/.test(n)) return 'edit';
    if (RE_INSTALL.test(n)) return 'install';
    if (RE_SEARCH.test(n)) return 'search';
    if (RE_READ.test(n)) return 'read';
    if (/^cd\s|^cd$|^export\s|^set\s|^source\s|^\.\s|^alias\s/.test(n)) return 'noop';
    return 'run';
  }
  function words(seg) {
    // tokens, quotes taken off (good enough to find file arguments)
    var out = [], m, re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
    while ((m = re.exec(seg))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
    return out;
  }
  function fileArgs(seg, skipFirst) {
    return words(seg).slice(skipFirst || 1).filter(function (w) { return w && w.charAt(0) !== '-' && !/^[<>|&]/.test(w) && !/^\d+$/.test(w) && !/[*?]$/.test(w) && w.length < LIMITS.pathLen; });
  }
  function repoPath(p) { return p && !/^(?:\/dev\/|\/tmp\/|\/proc\/|&\d|~\/\.|\$)/.test(p); }
  /** Which tests a test command picked, if not the whole suite. */
  function testSubset(n) {
    var w = words(n);
    var picks = [];
    var from = /^python[0-9.]*$/.test(w[0]) && w[1] === '-m' ? 3 : 1;
    for (var i = from; i < w.length; i++) {
      var t = w[i];
      if (/^(?:-t|--testNamePattern|--grep|-g|-k|-run|--run|--only|--testPathPattern|--filter|-m|--tests|--test|--lf|--last-failed|--onlyChanged|-o|--changed|--related|--findRelatedTests|--deselect|--ignore|--testPathIgnorePatterns)(?:=.*)?$/.test(t)) picks.push(t.split('=')[0] + (w[i + 1] && t.indexOf('=') === -1 && !/^(?:--lf|--last-failed|--onlyChanged|-o|--changed)$/.test(t) ? ' ' + w[i + 1] : ''));
      else if (/\.(?:test|spec)\.[a-z0-9]+$|(?:^|\/)test_\w+\.py(?:::\S+)?$|_test\.(?:go|py)$|\.py::\S+|_spec\.rb(?::\d+)?$|Test\.java$/.test(t)) picks.push(t);
      else if (/^(?:tests?|spec|__tests__)\/\S+/.test(t) && !/^(?:npm|pnpm|yarn|bun)$/.test(w[0])) picks.push(t);
    }
    if (/^go\s+test\b/.test(n) && !/\.\/\.\.\.|^go\s+test\s*$|\s\.\/\.\.\.\b/.test(n) && /\s\.?\/?[\w./-]+/.test(n.replace(/\s-\S+/g, ''))) {
      var pk = fileArgs(n, 2).filter(function (x) { return x !== './...'; });
      if (pk.length) picks.push(pk[0]);
    }
    return picks.length ? uniq(picks).slice(0, 4).join(' ') : null;
  }

  /**
   * What one shell command does, read from its text: its kind (the most
   * telling of its segments), every check it runs, the files it writes or
   * deletes, and the flags that hide failures.
   */
  function analyzeCommand(cmd) {
    var full = str(cmd);
    var out = { act: 'run', checks: [], changes: [], flags: [], subset: null, probe: false, program: '' };
    // Heredocs: `cat > file <<'EOF' ... EOF` writes a file. Its body is
    // content, not commands, so it is taken out before reading the rest.
    var text = full.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g, function (m, q, tag, rest, body, offset) {
      var lineStart = full.lastIndexOf('\n', offset) + 1;
      var head = full.slice(lineStart, offset) + ' ' + rest;
      var t = /(?:^|[^0-9&>])>>?\s*([^\s|&;<>]+)/.exec(head) || /\btee\s+(?:-a\s+)?([^\s|&;<>]+)/.exec(head);
      if (t && repoPath(t[1])) out.changes.push({ path: normPath(t[1]), kind: 'write', added: clip(body, LIMITS.inputChars), removed: null, via: 'shell' });
      return '';
    });
    var segs = splitShell(text);
    var best = 'noop', kinds = [];
    segs.forEach(function (sg, i) {
      var n = normSeg(sg.text);
      var k = segKind(n);
      sg.norm = n; sg.kind = k;
      if (!out.program && k !== 'noop') out.program = words(n)[0] || '';
      kinds.push(k);
      if ((ACT_RANK[k] || 0) > (ACT_RANK[best] === undefined ? -1 : ACT_RANK[best]) || best === 'noop') best = k === 'noop' ? best : k;
      if (['test', 'types', 'lint', 'build'].indexOf(k) !== -1 && out.checks.indexOf(k) === -1) out.checks.push(k);
      if (k === 'test') {
        var sub = testSubset(n);
        if (sub) out.subset = sub;
        if (/--passWithNoTests\b|--pass-with-no-tests\b/.test(n)) out.flags.push({ kind: 'pass-no-tests', on: k, text: sg.text });
        if (/^(?:jest|vitest|(?:npm|pnpm|yarn|bun)\b)/.test(n) && /(?:^|\s)(?:-u|--updateSnapshot|--update-snapshots?|--snapshot-update|-ci=false)(?:\s|$)/.test(n)) out.flags.push({ kind: 'update-snapshots', on: k, text: sg.text });
      }
      if ((k === 'commit' || k === 'push') && /(?:^|\s)--no-verify\b/.test(n)) out.flags.push({ kind: 'no-verify', on: k, text: sg.text });
      if (k === 'push' && /(?:^|\s)(?:--force(?:-with-lease)?|-f)(?:\s|=|$)/.test(n)) out.flags.push({ kind: 'force-push', on: k, text: sg.text });
      if (/(?:^|\s)set\s+\+e\b/.test(sg.text)) out.flags.push({ kind: 'set+e', on: k, text: sg.text });
      if (QUIET.test(sg.text) && ['test', 'types', 'lint', 'build', 'migrate', 'deploy'].indexOf(k) !== -1) out.flags.push({ kind: 'quiet', on: k, text: sg.text });
      if (sg.op === '||' && segs[i + 1] && SWALLOW_TAIL.test(segs[i + 1].text.trim()) && k !== 'noop' && k !== 'read' && k !== 'search' && !CLEANUP.test(n)) out.flags.push({ kind: 'or-true', on: k, text: sg.text + ' || ' + segs[i + 1].text.trim() });
      // files written or removed by the shell
      var m;
      if (k === 'delete') fileArgs(n, /^git\s+rm/.test(n) ? 2 : 1).filter(repoPath).forEach(function (p) { out.changes.push({ path: normPath(p), kind: 'delete', added: '', removed: null, via: 'shell' }); });
      else if (/^sed\s+(?:-[a-zA-Z]*i|--in-place)|^perl\s+-[a-zA-Z]*i/.test(n)) {
        var fa = fileArgs(n, 1).filter(function (x) { return /[./]/.test(x) && !/^s[/|#,]/.test(x) && !/^\d*[,;]?\d*[dpq]$/.test(x); });
        var lastArg = lastOf(fa);
        if (lastArg && repoPath(lastArg)) out.changes.push({ path: normPath(lastArg), kind: 'edit', added: '', removed: null, via: 'shell' });
      } else if (/^(?:mv|cp)\s/.test(n)) {
        var ar = fileArgs(n, 1);
        if (ar.length >= 2) {
          if (/^mv/.test(n) && repoPath(ar[0])) out.changes.push({ path: normPath(ar[0]), kind: 'delete', added: '', removed: null, via: 'shell' });
          if (repoPath(lastOf(ar))) out.changes.push({ path: normPath(lastOf(ar)), kind: 'write', added: '', removed: null, via: 'shell' });
        }
      } else if (/^git\s+(?:checkout\s+--|restore)\b/.test(n)) {
        fileArgs(n, 2).filter(function (x) { return x !== '--' && repoPath(x); }).forEach(function (p) { out.changes.push({ path: normPath(p), kind: 'edit', added: '', removed: null, via: 'shell', revert: true }); });
      } else if (/^(?:git\s+(?:apply|am)|patch)\b/.test(n)) {
        out.changes.push({ path: '', kind: 'edit', added: '', removed: null, via: 'shell', unknown: true });
      }
      var tee = /\btee\s+(?:-a\s+)?([^\s|&;<>]+)/.exec(sg.text);
      if (tee && repoPath(tee[1]) && !out.changes.some(function (c) { return c.path === normPath(tee[1]); })) out.changes.push({ path: normPath(tee[1]), kind: 'write', added: '', removed: null, via: 'shell' });
      var rd = /(?:^|[^0-9&>2])>>?\s*([^\s|&;<>()]+)/g;
      while ((m = rd.exec(sg.text))) {
        var tgt = m[1];
        if (!repoPath(tgt) || /^&/.test(tgt)) continue;
        if (out.changes.some(function (c) { return c.path === normPath(tgt); })) continue;
        if (k === 'test' || k === 'lint' || k === 'types' || k === 'build') continue; // a report written by a check is not an edit
        out.changes.push({ path: normPath(tgt), kind: 'write', added: '', removed: null, via: 'shell' });
      }
    });
    out.act = best === 'noop' ? 'run' : best;
    if (out.changes.length && (out.act === 'run' || out.act === 'read' || out.act === 'search' || out.act === 'noop')) out.act = out.changes.every(function (c) { return c.kind === 'delete'; }) ? 'delete' : 'edit';
    var lastSeg = lastOf(segs.filter(function (s) { return s.kind !== 'noop'; }));
    out.probe = Boolean(lastSeg && PROBE.test(lastSeg.norm)) && kinds.every(function (k) { return k === 'search' || k === 'read' || k === 'noop'; });
    return out;
  }

  /* ---------------- tool calls ---------------- */

  function asObj(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string') {
      var t = v.trim();
      if (t.charAt(0) === '{') { try { var o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch (e) { /* not JSON */ } }
      return { _raw: v };
    }
    if (Array.isArray(v)) return { _arr: v };
    return {};
  }
  function pick(o, keys) {
    if (!o || typeof o !== 'object') return undefined;
    for (var i = 0; i < keys.length; i++) { var v = o[keys[i]]; if (v !== undefined && v !== null && v !== '') return v; }
    return undefined;
  }
  function cmdString(v) {
    if (Array.isArray(v)) {
      var a = v.map(str);
      if (a.length >= 3 && /^(?:ba|z|da|)sh$/.test(basename(a[0])) && /^-l?c$|^-lc$/.test(a[1])) return a.slice(2).join(' ');
      return a.map(function (x) { return /\s/.test(x) ? JSON.stringify(x) : x; }).join(' ');
    }
    return str(v);
  }
  var ACT_WORD = { read: 'Read', write: 'Wrote', edit: 'Edited', delete: 'Deleted' };
  function fileStep(tool, act, path, added, removed) {
    var p = normPath(path);
    var s = { tool: tool, act: act, path: p, label: (ACT_WORD[act] || act) + ' ' + (p || '(no path)') };
    if (act === 'edit' || act === 'write' || act === 'delete') s.changes = [{ path: p, kind: act, added: clip(added, LIMITS.inputChars), removed: removed === null || removed === undefined ? null : clip(removed, LIMITS.inputChars) }];
    return s;
  }
  /** An `apply_patch` envelope (Codex): *** Add / Update / Delete File: path, then +/- lines. */
  function patchStep(tool, patch) {
    var changes = [], cur = null;
    str(patch).split('\n').forEach(function (l) {
      var m = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/.exec(l);
      if (m) { cur = { path: normPath(m[2]), kind: m[1] === 'Add' ? 'write' : m[1] === 'Delete' ? 'delete' : 'edit', addedL: [], removedL: [] }; changes.push(cur); return; }
      var mv = /^\*\*\* Move to:\s*(.+)$/.exec(l);
      if (mv && cur) { changes.push({ path: normPath(mv[1]), kind: 'write', addedL: [], removedL: [] }); return; }
      if (!cur || /^\*\*\* (Begin|End) Patch|^@@/.test(l)) return;
      if (l.charAt(0) === '+') cur.addedL.push(l.slice(1));
      else if (l.charAt(0) === '-') cur.removedL.push(l.slice(1));
    });
    changes = changes.map(function (c) { return { path: c.path, kind: c.kind, added: clip(c.addedL.join('\n'), LIMITS.inputChars), removed: c.kind === 'write' ? null : clip(c.removedL.join('\n'), LIMITS.inputChars) }; });
    var paths = changes.map(function (c) { return c.path; });
    return { tool: tool, act: changes.length && changes.every(function (c) { return c.kind === 'delete'; }) ? 'delete' : 'edit', path: paths[0] || '', paths: paths, changes: changes, label: 'Patched ' + (paths.length ? paths.slice(0, 3).join(', ') + (paths.length > 3 ? ' +' + (paths.length - 3) : '') : '(no files)') };
  }
  function shellStep(tool, cmd) {
    var a = analyzeCommand(cmd);
    var label = firstLine(cmd, LIMITS.labelChars) + (str(cmd).trim().indexOf('\n') !== -1 ? ' …' : '');
    return { tool: tool, act: a.act, cmd: clip(str(cmd), LIMITS.inputChars), label: label || '(empty command)', checks: a.checks, changes: a.changes, flags: a.flags, subset: a.subset, probe: a.probe, program: a.program, paths: a.changes.map(function (c) { return c.path; }).filter(Boolean) };
  }
  var SHELL_NAMES = /^(?:bash|sh|zsh|shell|terminal|run|exec|execute|run_command|run_shell|run_shell_command|shell_command|command|cmd|run_terminal_cmd|execute_command|run_in_terminal|local_shell|computer_terminal|powershell|pwsh|container\.exec|bash_tool)$/i;
  /** Any tool call, from any agent, as one step: what it did, what it touched. */
  function describe(name, rawInput) {
    var nm = clean(name, 80).trim() || 'tool';
    var low = nm.toLowerCase();
    var inp = asObj(rawInput);
    switch (nm) {
      case 'Bash': return shellStep(nm, str(pick(inp, ['command', 'cmd']) || inp._raw));
      case 'Read': return fileStep(nm, 'read', pick(inp, ['file_path', 'path']));
      case 'Write': return fileStep(nm, 'write', pick(inp, ['file_path', 'path']), str(inp.content), null);
      case 'Edit': return fileStep(nm, 'edit', pick(inp, ['file_path', 'path']), str(inp.new_string), str(inp.old_string));
      case 'MultiEdit': {
        var es = Array.isArray(inp.edits) ? inp.edits : [];
        return fileStep(nm, 'edit', pick(inp, ['file_path', 'path']), es.map(function (e) { return str(e && e.new_string); }).join('\n'), es.map(function (e) { return str(e && e.old_string); }).join('\n'));
      }
      case 'NotebookEdit': return fileStep(nm, 'edit', pick(inp, ['notebook_path', 'file_path']), str(inp.new_source), '');
      case 'Glob': case 'Grep': case 'LS': return { tool: nm, act: 'search', label: nm + ' ' + clean(pick(inp, ['pattern', 'path']) || '', 120) };
      case 'Task': case 'Agent': return { tool: nm, act: 'task', label: 'Subagent: ' + clean(pick(inp, ['description', 'prompt']) || '', 120) };
      case 'TodoWrite': return { tool: nm, act: 'other', label: 'Updated the to-do list' };
      case 'WebFetch': case 'WebSearch': return { tool: nm, act: 'web', label: nm + ' ' + clean(pick(inp, ['url', 'query']) || '', 120) };
      case 'BashOutput': case 'KillShell': case 'KillBash': return { tool: nm, act: 'read', label: nm };
      case 'ExitPlanMode': return { tool: nm, act: 'other', label: 'Presented a plan' };
      default: break;
    }
    if (/str_replace|text_editor/.test(low)) {
      var c = str(inp.command), p = pick(inp, ['path', 'file_path']);
      if (c === 'view') return fileStep(nm, 'read', p);
      if (c === 'create') return fileStep(nm, 'write', p, str(inp.file_text), null);
      if (c === 'str_replace') return fileStep(nm, 'edit', p, str(inp.new_str), str(inp.old_str));
      if (c === 'insert') return fileStep(nm, 'edit', p, str(pick(inp, ['new_str', 'insert_text'])), '');
      if (c === 'undo_edit') return fileStep(nm, 'edit', p, '', '');
    }
    if (low === 'apply_patch' || (typeof inp._raw === 'string' && /^\s*\*\*\* Begin Patch/.test(inp._raw))) return patchStep(nm, str(inp._raw || pick(inp, ['input', 'patch'])));
    if (SHELL_NAMES.test(nm) || /(?:^|_)(?:shell|terminal|bash)(?:_|$)|run_?command|exec(?:ute)?_?(?:command|cmd)/.test(low)) {
      var cv = pick(inp, ['command', 'cmd', 'script', 'code', 'input', 'commands']);
      if (cv === undefined) cv = inp._raw !== undefined ? inp._raw : inp._arr;
      if (Array.isArray(cv) && str(cv[0]) === 'apply_patch') return patchStep(nm, str(cv[1]));
      var cs = cmdString(cv);
      if (/^\s*apply_patch\b/.test(cs) && /\*\*\* Begin Patch/.test(cs)) return patchStep(nm, cs.slice(cs.indexOf('*** Begin Patch')));
      return shellStep(nm, cs);
    }
    var path = pick(inp, ['path', 'file_path', 'filePath', 'file', 'filename', 'target_file', 'target', 'notebook_path']);
    var content = pick(inp, ['content', 'file_text', 'new_content', 'contents', 'code_edit', 'new_str', 'new_string', 'replacement', 'text', 'code']);
    var old = pick(inp, ['old_str', 'old_string', 'old', 'search', 'original']);
    if (/(?:^|_)(?:delete|remove|rm|unlink)(?:_|$)|delete_?file|remove_?file/.test(low) && path) return fileStep(nm, 'delete', path);
    if (/edit|replace|patch|modify|update/.test(low) && path) return fileStep(nm, 'edit', path, str(content), str(old));
    if (/write|create|save|new_?file|insert|append/.test(low) && path) return fileStep(nm, old !== undefined ? 'edit' : 'write', path, str(content), old !== undefined ? str(old) : null);
    if (/read|view|cat|open|get_?file|show/.test(low) && path) return fileStep(nm, 'read', path);
    if (/pull_?request|create_?pr|open_?pr|merge_?request/.test(low)) return { tool: nm, act: 'pr', label: nm.replace(/^mcp__/, '').replace(/__/g, ' ') };
    if (/search|grep|find|glob|list|lookup|ls$/.test(low)) return { tool: nm, act: 'search', label: nm + ' ' + clean(pick(inp, ['pattern', 'query', 'path']) || '', 100) };
    if (/deploy|release/.test(low)) return { tool: nm, act: 'deploy', label: nm };
    if (/migrat/.test(low)) return { tool: nm, act: 'migrate', label: nm };
    if (/test/.test(low)) return { tool: nm, act: 'test', checks: ['test'], label: nm + (pick(inp, ['path', 'target', 'pattern']) ? ' ' + clean(pick(inp, ['path', 'target', 'pattern']), 100) : '') };
    if (/lint/.test(low)) return { tool: nm, act: 'lint', checks: ['lint'], label: nm };
    if (/typecheck|type_check/.test(low)) return { tool: nm, act: 'types', checks: ['types'], label: nm };
    if (/build|compile/.test(low)) return { tool: nm, act: 'build', checks: ['build'], label: nm };
    if (/commit/.test(low)) return { tool: nm, act: 'commit', label: nm };
    if (/push/.test(low)) return { tool: nm, act: 'push', label: nm };
    if (/fetch|http|browse|web|url|request|navigate/.test(low)) return { tool: nm, act: 'web', label: nm + ' ' + clean(pick(inp, ['url', 'query']) || '', 100) };
    return { tool: nm, act: 'other', label: nm + (path ? ' ' + normPath(path) : '') };
  }

  /* ---------------- reading outputs ---------------- */

  var COUNT_WORD = { passed: 'passed', passing: 'passed', pass: 'passed', xpassed: 'passed', flaky: 'passed', failed: 'failed', failing: 'failed', failures: 'failed', failure: 'failed', fail: 'failed', skipped: 'skipped', skip: 'skipped', pending: 'skipped', ignored: 'skipped', deselected: 'skipped', xfailed: 'skipped', 'did not run': 'skipped', todo: 'todo', total: 'total', tests: 'total', errors: 'errors', error: 'errors', cancelled: 'errors' };
  function addCounts(r, text) {
    var any = false;
    allMatches(text, /(\d+)\s+(passed|passing|xpassed|flaky|failed|failing|failures?|skipped|pending|ignored|deselected|xfailed|did not run|todo|total|errors?|cancelled)\b/gi).forEach(function (m) {
      var k = COUNT_WORD[m[2].toLowerCase()];
      if (!k) return;
      any = true;
      if (k === 'total') r.total = Number(m[1]);
      else if (k === 'passed') r.passed = (r.passed || 0) + Number(m[1]);
      else r[k] += Number(m[1]);
    });
    return any;
  }
  function pushLine(arr, l, max) { var t = str(l).trim(); if (t && arr.indexOf(t) === -1 && arr.length < (max || 6)) arr.push(t); }

  /** A test runner's verdict, read from its own output. Unknown output stays unknown. */
  function parseTests(raw) {
    var t = str(raw).replace(ANSI, '');
    var r = { known: false, runner: null, passed: null, failed: 0, skipped: 0, todo: 0, total: null, errors: 0, noTests: false, summary: [], bad: [], skippedNames: [] };
    var m;
    function found(runner, line) { r.known = true; r.runner = r.runner || runner; pushLine(r.summary, line); }
    // Jest: "Tests:       1 failed, 1 skipped, 38 passed, 40 total"
    if ((m = lastMatch(t, /^[ \t]*Tests:[ \t]+(.+?)[ \t]*$/gm)) && /\d+\s+(?:passed|failed|total|skipped|todo)/.test(m[1])) {
      addCounts(r, m[1]); found('jest', m[0]);
      var suites = lastMatch(t, /^[ \t]*Test Suites:[ \t]+(.+?)[ \t]*$/gm); if (suites) pushLine(r.summary, suites[0]);
    // Vitest: " Tests  1 failed | 40 passed (41)"
    } else if ((m = lastMatch(t, /^[ \t]*Tests[ \t]+((?:\d+ \w+(?: \| )?)+)\s*\((\d+)\)[ \t]*$/gm))) {
      addCounts(r, m[1]); r.total = Number(m[2]); found('vitest', m[0]);
    }
    // Mocha: "  40 passing (2s)", "  2 failing", "  3 pending"
    if (!r.known && (m = lastMatch(t, /^[ \t]*(\d+) passing\b.*$/gm))) {
      r.passed = Number(m[1]); found('mocha', m[0]);
      var mf = lastMatch(t, /^[ \t]*(\d+) failing\b.*$/gm); if (mf) { r.failed = Number(mf[1]); pushLine(r.summary, mf[0]); }
      var mp = lastMatch(t, /^[ \t]*(\d+) pending\b.*$/gm); if (mp) { r.skipped = Number(mp[1]); pushLine(r.summary, mp[0]); }
    }
    // pytest: "===== 2 failed, 40 passed, 1 skipped in 1.23s =====", or -q "40 passed in 0.5s"
    if (!r.known && (m = lastMatch(t, /^=+ ((?:\d+ \w+(?:, )?)+) in [\d.]+s(?: \([^)]*\))? =+$|^((?:\d+ (?:passed|failed|skipped|errors?|xfailed|xpassed|deselected|warnings?)(?:, )?)+) in [\d.]+s\b.*$/gm))) {
      addCounts(r, m[1] || m[2]); found('pytest', m[0]);
    }
    if (!r.known && (m = lastMatch(t, /^=+ no tests ran in [\d.]+s =+$|^no tests ran in [\d.]+s$/gm))) { r.noTests = true; found('pytest', m[0]); }
    // cargo: "test result: ok. 42 passed; 0 failed; 1 ignored" - once per crate, so summed
    var cargo = allMatches(t, /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored.*$/gm);
    if (!r.known && cargo.length) {
      r.passed = 0;
      cargo.forEach(function (c) { r.passed += Number(c[2]); r.failed += Number(c[3]); r.skipped += Number(c[4]); pushLine(r.summary, c[0]); });
      r.known = true; r.runner = 'cargo';
    }
    // node:test (TAP, and the spec reporter's "ℹ tests 44")
    var tap = allMatches(t, /^(?:#|ℹ) (tests|pass|fail|skipped|todo|cancelled) (\d+)\s*$/gm);
    if (!r.known && tap.length) {
      tap.forEach(function (c) { var k = c[1], n = Number(c[2]); if (k === 'tests') r.total = n; else if (k === 'pass') r.passed = n; else if (k === 'fail') r.failed = n; else if (k === 'skipped') r.skipped = n; else if (k === 'todo') r.todo = n; else r.errors += n; if (k === 'tests' || k === 'pass' || k === 'fail' || (n > 0)) pushLine(r.summary, c[0]); });
      r.known = true; r.runner = 'node';
    }
    // RSpec: "42 examples, 2 failures, 1 pending"
    if (!r.known && (m = lastMatch(t, /^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?.*$/gm))) {
      r.total = Number(m[1]); r.failed = Number(m[2]); r.skipped = Number(m[3] || 0); r.passed = r.total - r.failed - r.skipped; found('rspec', m[0]);
    }
    // unittest: "Ran 42 tests in 0.1s" then "OK (skipped=1)" or "FAILED (failures=2, errors=1)"
    if (!r.known && (m = lastMatch(t, /^Ran (\d+) tests? in [\d.]+s$/gm))) {
      r.total = Number(m[1]); found('unittest', m[0]);
      var tail = t.slice(m.index);
      var ok = /^OK(?: \(([^)]*)\))?\s*$/m.exec(tail), bad = /^FAILED \(([^)]*)\)\s*$/m.exec(tail);
      var detail = (ok && ok[1]) || (bad && bad[1]) || '';
      allMatches(detail, /(failures|errors|skipped|expected failures)=(\d+)/g).forEach(function (c) { if (c[1] === 'failures') r.failed = Number(c[2]); else if (c[1] === 'errors') r.errors = Number(c[2]); else r.skipped += Number(c[2]); });
      if (ok || bad) pushLine(r.summary, (ok || bad)[0]);
      r.passed = r.total - r.failed - r.errors - r.skipped;
      if (r.total === 0) r.noTests = true;
    }
    // PHPUnit
    if (!r.known && (m = lastMatch(t, /^OK \((\d+) tests?, \d+ assertions?\)\s*$/gm))) { r.total = r.passed = Number(m[1]); found('phpunit', m[0]); }
    if (!r.known && (m = lastMatch(t, /^Tests: (\d+), Assertions: \d+(.*)$/gm))) {
      r.total = Number(m[1]);
      allMatches(m[2], /(Errors|Failures|Skipped|Incomplete): (\d+)/g).forEach(function (c) { if (c[1] === 'Errors') r.errors = Number(c[2]); else if (c[1] === 'Failures') r.failed = Number(c[2]); else r.skipped += Number(c[2]); });
      r.passed = r.total - r.failed - r.errors - r.skipped; found('phpunit', m[0]);
    }
    // dotnet test: "Failed!  - Failed: 2, Passed: 40, Skipped: 0, Total: 42"
    if (!r.known && (m = lastMatch(t, /^\s*(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+).*$/gm))) {
      r.failed = Number(m[1]); r.passed = Number(m[2]); r.skipped = Number(m[3]); r.total = Number(m[4]); found('dotnet', m[0]);
    }
    // Playwright: "  40 passed (12.3s)", "  2 failed", "  1 skipped", "  1 flaky"
    var pw = allMatches(t, /^[ \t]+(\d+) (passed|failed|skipped|flaky|did not run)(?: \([\d.]+m?s\))?[ \t]*$/gm);
    if (!r.known && pw.length) { r.passed = 0; pw.forEach(function (c) { addCounts(r, c[1] + ' ' + c[2]); pushLine(r.summary, c[0]); }); r.known = true; r.runner = 'playwright'; }
    // go test: "ok  	pkg	0.01s", "FAIL	pkg", "--- FAIL: TestX", "--- SKIP: TestY"
    var goOk = allMatches(t, /^ok\s+\S+\s+(?:[\d.]+s|\(cached\)).*$/gm), goFail = allMatches(t, /^FAIL\s+\S+\s+[\d.]+s.*$|^FAIL$/gm);
    var goCase = allMatches(t, /^\s*--- (FAIL|PASS|SKIP): (\S+)/gm);
    if (!r.known && (goOk.length || goFail.length || goCase.length)) {
      r.known = true; r.runner = 'go';
      var pass = 0;
      goCase.forEach(function (c) { if (c[1] === 'FAIL') { r.failed++; pushLine(r.bad, c[0]); } else if (c[1] === 'SKIP') { r.skipped++; pushLine(r.skippedNames, c[2]); } else pass++; });
      if (!r.failed && goFail.length) r.failed = goFail.length;
      r.passed = pass || null;
      goOk.concat(goFail).slice(-4).forEach(function (c) { pushLine(r.summary, c[0]); });
      if (!goOk.length && !goFail.length && /no test files/.test(t)) r.noTests = true;
    }
    // "No tests found" (Jest, with or without --passWithNoTests), "collected 0 items", "0 passing"
    if (/No tests found|No test files found|no test files|No test suites found|collected 0 items|^\s*0 passing\b|testMatch:[^\n]*0 matches/im.test(t) && !(r.passed > 0) && !(r.failed > 0)) {
      r.noTests = true; r.known = true;
      var nt = /^.*(?:No tests found|No test files found|no test files|No test suites found|collected 0 items|0 passing|0 matches).*$/im.exec(t); if (nt) pushLine(r.summary, nt[0]);
    }
    // Which tests failed, and which were skipped, by name
    allMatches(t, /^[ \t]*(?:●[ \t]+(?!Console)(.+)|[✕×✗✘][ \t]+(.+?)(?:\s+\(\d+\s*m?s\))?|FAILED[ \t]+(\S+::\S+.*)|\d+\)[ \t]+(.+)|FAIL[ \t]+(\S+\.(?:test|spec)\.\S+))[ \t]*$/gm).forEach(function (c) { if (r.bad.length < 6) pushLine(r.bad, c[0]); });
    allMatches(t, /^[ \t]*(?:○[ \t]+(?:skipped[ \t]+)?(.+)|SKIPPED[ \t]+(.+)|↓[ \t]+(.+))[ \t]*$/gm).forEach(function (c) { pushLine(r.skippedNames, (c[1] || c[2] || c[3] || '').trim()); });
    if (r.total === null && r.passed !== null) r.total = r.passed + r.failed + r.skipped + r.todo;
    if (r.known) r.ok = r.failed === 0 && r.errors === 0 && !r.noTests;
    else r.ok = null;
    return r;
  }

  /** A linter's, type checker's or build's verdict from its output. */
  function parseChecker(kind, raw) {
    var t = str(raw).replace(ANSI, '');
    var r = { known: false, errors: 0, warnings: 0, summary: [], bad: [] };
    var m;
    function hit(n, line) { r.known = true; r.errors += n; pushLine(r.summary, line); }
    if (kind === 'lint') {
      if ((m = lastMatch(t, /^[ \t]*✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\).*$/gm))) { r.known = true; r.errors = Number(m[2]); r.warnings = Number(m[3]); pushLine(r.summary, m[0]); }
      else if ((m = lastMatch(t, /^Found (\d+) errors?\b.*$/gm))) hit(Number(m[1]), m[0]);
      else if ((m = lastMatch(t, /^(\d+) files? inspected, (\d+) offenses? detected.*$|^.*\b(\d+) offenses? detected.*$/gm))) hit(Number(m[2] || m[3]), m[0]);
      else if ((m = lastMatch(t, /^\[warn\] Code style issues found in (\d+) files?.*$|^Code style issues found in (\d+) files?.*$/gm))) hit(Number(m[1] || m[2]), m[0]);
      else if ((m = lastMatch(t, /^(?:All checks passed!|All matched files use Prettier code style!|no offenses detected|Checked \d+ files? in [\d.]+m?s\. No fixes applied\.)\s*$/gm))) { r.known = true; pushLine(r.summary, m[0]); }
      var flake = allMatches(t, /^[^\s:]+:\d+:\d+: [EFW]\d{3,4}\b.*$/gm);
      if (!r.known && flake.length) { r.known = true; r.errors = flake.length; flake.slice(0, 4).forEach(function (c) { pushLine(r.bad, c[0]); }); }
      allMatches(t, /^[ \t]*\d+:\d+[ \t]+error[ \t]+.+$/gm).forEach(function (c) { pushLine(r.bad, c[0], 4); });
      var clippy = allMatches(t, /^error(?:\[\w+\])?: .+$/gm);
      if (!r.known && clippy.length) { r.known = true; r.errors = clippy.length; clippy.slice(0, 4).forEach(function (c) { pushLine(r.bad, c[0]); }); }
    } else if (kind === 'types') {
      var ts = allMatches(t, /^.*error TS\d+:.*$/gm);
      if ((m = lastMatch(t, /^Found (\d+) errors?(?: in \d+ files?)?\.?.*$/gm))) hit(Number(m[1]), m[0]);
      else if (ts.length) hit(ts.length, ts[0][0]);
      else if ((m = lastMatch(t, /^Success: no issues found in \d+ source files?$|^0 errors, \d+ warnings?, \d+ (?:informations?|notes?)\s*$|^No errors!$/gm))) { r.known = true; pushLine(r.summary, m[0]); }
      else if ((m = lastMatch(t, /^(\d+) errors?, (\d+) warnings?, \d+ (?:informations?|notes?).*$/gm))) hit(Number(m[1]), m[0]);
      ts.slice(0, 4).forEach(function (c) { pushLine(r.bad, c[0]); });
      allMatches(t, /^[^\s:]+\.py:\d+: error: .+$/gm).forEach(function (c) { pushLine(r.bad, c[0], 4); });
      var rust = allMatches(t, /^error(?:\[E\d+\])?: .+$/gm);
      if (!r.known && rust.length) { r.known = true; r.errors = rust.length; rust.slice(0, 4).forEach(function (c) { pushLine(r.bad, c[0]); }); }
    } else {
      var bad = allMatches(t, /^(?:ERROR in .+|error(?:\[\w+\])?: .+|.*error TS\d+:.*|.*\bBuild failed\b.*|.*\bFailed to compile\b.*|.*\bCompilation failed\b.*|.*\bBUILD FAILURE\b.*|\[ERROR\] .+|npm ERR! .+|npm error .+|.*✘ \[ERROR\].*)$/gm);
      if (bad.length) { r.known = true; r.errors = bad.length; bad.slice(0, 4).forEach(function (c) { pushLine(r.bad, c[0]); }); }
      else if ((m = lastMatch(t, /^.*(?:compiled successfully|Compiled successfully|Build succeeded|BUILD SUCCESS|built in [\d.]+m?s|Finished `?\w+`? (?:profile|target)|Successfully built|✓ Compiled|Build complete).*$/gm))) { r.known = true; pushLine(r.summary, m[0]); }
    }
    r.ok = r.known ? r.errors === 0 : null;
    return r;
  }

  function firstErrorLine(raw) {
    var lines = str(raw).replace(ANSI, '').split('\n');
    var re = /\b(?:error|Error|ERROR|fatal|FAILED|Failed|failed|Exception|Traceback|panic|not found|No such file|denied|refused|rejected|timed out)\b/;
    for (var i = 0; i < lines.length && i < 400; i++) if (re.test(lines[i]) && !/^Exit code \d+$/.test(lines[i].trim())) return shown(lines[i].trim());
    return shown(firstLine(raw));
  }

  /** Attach what a tool sent back to the step that called it. */
  function attachResult(step, text, isError, exit, at, ms) {
    if (!step) return;
    var raw = str(text).replace(/\r\n?/g, '\n');
    var m = /^\s*Exit code (-?\d+)\b[^\n]*\n?/.exec(raw);
    if (m && (exit === null || exit === undefined)) exit = Number(m[1]);
    if (exit === null || exit === undefined) {
      var tail = raw.slice(-400);
      var m2 = /(?:^|\n)[ \t]*(?:\(?\s*(?:process|command) (?:exited|finished|failed) with (?:exit )?code\s*(-?\d+)|exit(?:ed)? (?:code|status)[:= ]\s*(-?\d+)|\[exit(?: code)?[: ]\s*(-?\d+)\]|\(exit (?:code |status )?(-?\d+)\))\s*\)?[ \t]*$/i.exec(tail);
      if (m2) exit = Number(m2[1] || m2[2] || m2[3] || m2[4]);
    }
    if (exit !== null && exit !== undefined && !isFinite(Number(exit))) exit = null;
    var ht = headTail(raw);
    step.out = ht.text; step.outCut = ht.cut; step.outLen = raw.length;
    step.exit = exit === null || exit === undefined ? null : Number(exit);
    if (at && step.at) { var d = Date.parse(at) - Date.parse(step.at); if (isFinite(d) && d >= 0 && d < 864e5) step.ms = d; }
    if (ms !== null && ms !== undefined && isFinite(Number(ms)) && Number(ms) >= 0) step.ms = Number(ms);
    if (step.exit !== null) step.ok = step.exit === 0;
    else if (isError === true) step.ok = false;
    else if (isError === false) step.ok = true;
    else step.ok = null;
    if (step.probe && (step.exit === 1 || (step.ok === false && step.exit === null && raw.trim().length < 300))) { step.ok = null; step.probeMiss = true; }
    if (step.ok === false) step.err = firstErrorLine(raw);
    if (step.checks && step.checks.length) {
      step.result = {};
      step.checks.forEach(function (k) { step.result[k] = k === 'test' ? parseTests(raw) : parseChecker(k, raw); });
    }
    // a PR's link, a commit's hash: kept from the full output before it is cut
    var pr = /https?:\/\/[^\s"'<>]+\/(?:pull|pulls|merge_requests)\/(\d+)\b/.exec(raw) || (step.act === 'pr' ? /"number"\s*:\s*(\d+)/.exec(raw) : null);
    if (pr) step.prUrl = { number: Number(pr[1]), text: shown(pr[0], 200) };
    var cm = /^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.*)$/m.exec(raw);
    if (cm) step.commit = { branch: cm[1], hash: cm[2], line: shown(cm[0]) };
    var files = /^\s*(\d+) files? changed\b.*$/m.exec(raw);
    if (files) step.filesChangedLine = shown(files[0].trim());
  }

  /* ---------------- reading a run ---------------- */

  var FORMAT_WORD = {
    'claude-jsonl': 'Claude Code transcript (.jsonl)',
    'claude-terminal': 'Claude Code terminal output (pasted)',
    anthropic: 'Anthropic messages (JSON)',
    openai: 'OpenAI chat messages (JSON)',
    responses: 'OpenAI Responses items (JSON)',
    codex: 'Codex CLI session (.jsonl)',
    toollog: 'Tool-call log (JSON)',
    text: 'Terminal output (pasted)',
  };
  var SKIP_WORD = {
    'not-json': 'Lines that were not JSON',
    'too-long': 'Lines too long to read',
    bookkeeping: 'Bookkeeping lines (snapshots, session info, token counts)',
    summary: 'Session summaries',
    meta: 'Commands and notices the tool added, not the person',
    thinking: 'The model’s private reasoning',
    system: 'System prompts',
    image: 'Images',
    orphan: 'Tool results with no matching call',
    unknown: 'Entries of a kind Proof does not read',
    unreadable: 'Entries that could not be read',
    'over-lines': 'Lines past the reading limit',
    'over-steps': 'Steps past the timeline limit',
    banner: 'Banner and status lines',
  };
  function newRun(format) {
    return { format: format, formatWord: FORMAT_WORD[format] || format, steps: [], skipped: {}, notes: [], cut: false, dropped: 0, cwd: '', goal: '', finalText: '', final: [] };
  }
  function skip(run, reason, n) { run.skipped[reason] = (run.skipped[reason] || 0) + (n || 1); }
  function addStep(run, s) {
    if (run.steps.length >= LIMITS.steps) { run.dropped++; run.cut = true; skip(run, 'over-steps'); return null; }
    s.n = run.steps.length + 1;
    run.steps.push(s);
    return s;
  }
  var META_TEXT = /^\s*(?:<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|environment_context|user_instructions|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)\b|Caveat: The messages below|\[Request interrupted|This session is being continued from a previous conversation)/;
  function userText(run, text, at, side, isMeta) {
    var t = str(text).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    if (!t) return null;
    if (isMeta || META_TEXT.test(t)) { skip(run, 'meta'); return null; }
    var s = addStep(run, { kind: 'user', text: clip(t, LIMITS.textChars), at: at || null, side: Boolean(side) });
    if (s && !side && !run.goal) run.goal = clip(t, LIMITS.goalChars);
    return s;
  }
  function say(run, text, at, side) {
    var t = str(text).trim();
    if (!t) return null;
    return addStep(run, { kind: 'say', text: clip(t, LIMITS.textChars), at: at || null, side: Boolean(side) });
  }
  function toolStep(run, name, input, at, side) {
    var d = describe(name, input);
    d.kind = 'tool'; d.at = at || null; d.side = Boolean(side); d.ok = null; d.exit = null;
    return addStep(run, d);
  }
  function blockText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(function (b) { return b && typeof b === 'object' ? (b.type === 'text' || b.type === 'output_text' || b.type === 'input_text' ? str(b.text) : b.type === 'image' ? '[image]' : '') : str(b); }).filter(Boolean).join('\n');
    if (c && typeof c === 'object') return str(c.text || c.output || JSON.stringify(c));
    return str(c);
  }
  /** A tool's reply in a generic framework: often JSON with stdout / stderr / exit_code. */
  function toolReply(content) {
    var text = blockText(content), isError = null, exit = null, ms = null;
    var t = text.trim();
    if (t.charAt(0) === '{') {
      try {
        var o = JSON.parse(t);
        if (o && typeof o === 'object') {
          var e = pick(o, ['exit_code', 'exitCode', 'returncode', 'return_code', 'status_code']);
          if (e !== undefined && isFinite(Number(e))) exit = Number(e);
          if (o.metadata && typeof o.metadata === 'object') {
            if (o.metadata.exit_code !== undefined) exit = Number(o.metadata.exit_code);
            if (o.metadata.duration_seconds !== undefined) ms = Number(o.metadata.duration_seconds) * 1000;
          }
          if (o.is_error === true || o.isError === true || o.success === false || o.ok === false) isError = true;
          var parts = [pick(o, ['output', 'stdout', 'result', 'content', 'text']), pick(o, ['stderr', 'error'])].filter(function (x) { return x !== undefined; }).map(function (x) { return typeof x === 'string' ? x : JSON.stringify(x); });
          if (o.error && isError === null && typeof o.error === 'string') isError = true;
          if (parts.length) text = parts.join('\n');
        }
      } catch (err) { /* not JSON: keep the text */ }
    }
    var cx = /^Exit code: (-?\d+)\nWall time: ([\d.]+) seconds\n(?:Output:\n)?/.exec(text);
    if (cx) { exit = Number(cx[1]); ms = Number(cx[2]) * 1000; text = text.slice(cx[0].length); }
    return { text: text, isError: isError, exit: exit, ms: ms };
  }

  function parseClaudeJsonl(objs, run) {
    var pending = {};
    objs.forEach(function (o) {
      if (!o || typeof o !== 'object') { skip(run, 'unreadable'); return; }
      if (typeof o.cwd === 'string' && !run.cwd) run.cwd = o.cwd;
      var t = o.type;
      if (t !== 'user' && t !== 'assistant') { skip(run, t === 'summary' ? 'summary' : 'bookkeeping'); return; }
      var msg = o.message && typeof o.message === 'object' ? o.message : {};
      var side = o.isSidechain === true;
      var at = typeof o.timestamp === 'string' ? o.timestamp : null;
      var content = msg.content;
      if (t === 'user') {
        if (typeof content === 'string') { userText(run, content, at, side, o.isMeta === true); return; }
        (Array.isArray(content) ? content : []).forEach(function (b) {
          if (!b || typeof b !== 'object') return;
          if (b.type === 'tool_result') {
            var st = pending[b.tool_use_id];
            if (!st) { skip(run, 'orphan'); return; }
            delete pending[b.tool_use_id];
            attachResult(st, blockText(b.content), b.is_error === true ? true : b.is_error === false ? false : null, null, at, null);
          } else if (b.type === 'text') userText(run, b.text, at, side, o.isMeta === true);
          else if (b.type === 'image') skip(run, 'image');
        });
        return;
      }
      (Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []).forEach(function (b) {
        if (!b || typeof b !== 'object') return;
        if (b.type === 'text') say(run, b.text, at, side);
        else if (b.type === 'tool_use') { var st = toolStep(run, b.name, b.input, at, side); if (st && b.id) pending[b.id] = st; }
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') skip(run, 'thinking');
        else if (b.type === 'server_tool_use') toolStep(run, 'WebSearch', b.input, at, side);
        else skip(run, 'unknown');
      });
    });
  }

  function parseMessages(msgs, run) {
    var pending = {}, byName = {};
    msgs.forEach(function (m) {
      if (!m || typeof m !== 'object') { skip(run, 'unreadable'); return; }
      var role = str(m.role || m.type).toLowerCase();
      var at = typeof m.timestamp === 'string' ? m.timestamp : typeof m.created_at === 'string' ? m.created_at : null;
      var c = m.content;
      if (role === 'system' || role === 'developer') { skip(run, 'system'); return; }
      if (role === 'tool') {
        var st = pending[m.tool_call_id] || pending[m.id];
        if (!st) { skip(run, 'orphan'); return; }
        delete pending[m.tool_call_id];
        var rep = toolReply(c);
        attachResult(st, rep.text, rep.isError, rep.exit, at, rep.ms);
        return;
      }
      if (role === 'function') {
        var fs = byName[m.name];
        if (!fs) { skip(run, 'orphan'); return; }
        delete byName[m.name];
        var r2 = toolReply(c);
        attachResult(fs, r2.text, r2.isError, r2.exit, at, r2.ms);
        return;
      }
      if (role === 'user' || role === 'human') {
        if (typeof c === 'string') { userText(run, c, at, false, false); return; }
        (Array.isArray(c) ? c : []).forEach(function (b) {
          if (!b || typeof b !== 'object') return;
          if (b.type === 'tool_result') {
            var ts = pending[b.tool_use_id];
            if (!ts) { skip(run, 'orphan'); return; }
            delete pending[b.tool_use_id];
            var r3 = toolReply(b.content);
            // In the Messages API a tool_result without is_error succeeded.
            attachResult(ts, r3.text, b.is_error === true ? true : r3.isError !== null ? r3.isError : false, r3.exit, at, r3.ms);
          } else if (b.type === 'text' || b.type === 'input_text') userText(run, b.text, at, false, false);
          else if (b.type === 'image' || b.type === 'image_url') skip(run, 'image');
        });
        return;
      }
      if (role === 'assistant' || role === 'ai' || role === 'model') {
        if (typeof c === 'string') say(run, c, at, false);
        else (Array.isArray(c) ? c : []).forEach(function (b) {
          if (!b || typeof b !== 'object') return;
          if (b.type === 'text' || b.type === 'output_text') say(run, b.text, at, false);
          else if (b.type === 'tool_use') { var s1 = toolStep(run, b.name, b.input, at, false); if (s1 && b.id) pending[b.id] = s1; }
          else if (b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'reasoning') skip(run, 'thinking');
        });
        (Array.isArray(m.tool_calls) ? m.tool_calls : []).forEach(function (tc) {
          if (!tc || typeof tc !== 'object') return;
          var fn = tc.function && typeof tc.function === 'object' ? tc.function : tc;
          var s2 = toolStep(run, fn.name, fn.arguments !== undefined ? fn.arguments : fn.input, at, false);
          if (s2 && tc.id) pending[tc.id] = s2;
        });
        if (m.function_call && typeof m.function_call === 'object') {
          var s3 = toolStep(run, m.function_call.name, m.function_call.arguments, at, false);
          if (s3) byName[m.function_call.name] = s3;
        }
        return;
      }
      skip(run, 'unknown');
    });
  }

  function parseItems(items, run, codex) {
    var pending = {};
    items.forEach(function (it0) {
      var it = it0, at = null;
      if (!it0 || typeof it0 !== 'object') { skip(run, 'unreadable'); return; }
      if (codex) {
        at = typeof it0.timestamp === 'string' ? it0.timestamp : null;
        if (it0.type === 'session_meta' || it0.type === 'turn_context') { var p0 = it0.payload || {}; if (typeof p0.cwd === 'string' && !run.cwd) run.cwd = p0.cwd; skip(run, 'bookkeeping'); return; }
        if (it0.type !== 'response_item') { skip(run, 'bookkeeping'); return; }
        it = it0.payload;
        if (!it || typeof it !== 'object') { skip(run, 'unreadable'); return; }
      }
      var id = it.call_id || it.id;
      switch (it.type) {
        case 'message': {
          var text = blockText(it.content);
          if (it.role === 'user') userText(run, text, at, false, false);
          else if (it.role === 'assistant') say(run, text, at, false);
          else skip(run, 'system');
          return;
        }
        case 'function_call': { var s = toolStep(run, it.name, it.arguments, at, false); if (s && id) pending[id] = s; return; }
        case 'custom_tool_call': { var s2 = toolStep(run, it.name, it.input, at, false); if (s2 && id) pending[id] = s2; return; }
        case 'local_shell_call': { var s3 = toolStep(run, 'local_shell', { command: it.action && it.action.command }, at, false); if (s3 && id) pending[id] = s3; return; }
        case 'function_call_output': case 'custom_tool_call_output': case 'local_shell_call_output': {
          var st = pending[it.call_id];
          if (!st) { skip(run, 'orphan'); return; }
          delete pending[it.call_id];
          var rep = toolReply(it.output);
          attachResult(st, rep.text, rep.isError, rep.exit, at, rep.ms);
          return;
        }
        case 'reasoning': skip(run, 'thinking'); return;
        case 'web_search_call': toolStep(run, 'WebSearch', it.action || {}, at, false); return;
        default: skip(run, 'unknown');
      }
    });
  }

  function parseToolLog(objs, run) {
    var pending = {};
    objs.forEach(function (o) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) { skip(run, 'unreadable'); return; }
      var at = pick(o, ['ts', 'timestamp', 'time', 'at', 'created_at', 'startedAt']);
      at = typeof at === 'string' ? at : typeof at === 'number' ? new Date(at > 1e12 ? at : at * 1000).toISOString() : null;
      var role = str(o.role || o.type || o.kind || o.event || '').toLowerCase();
      var ref = o.call_id || o.tool_call_id || o.tool_use_id || o.id;
      if (/result|output|response|observation|tool_end|end$/.test(role) && ref && pending[ref]) {
        var st0 = pending[ref]; delete pending[ref];
        resultOf(st0, o, at);
        return;
      }
      var name = pick(o, ['tool', 'tool_name', 'toolName', 'function', 'action', 'name']);
      if (name && typeof name === 'object') name = name.name;
      var hasInput = ['input', 'args', 'arguments', 'params', 'parameters', 'command', 'cmd'].some(function (k) { return o[k] !== undefined; });
      if (typeof name === 'string' && name && (hasInput || /tool|call|action|step|function/.test(role) || o.output !== undefined || o.result !== undefined)) {
        var input = pick(o, ['input', 'args', 'arguments', 'params', 'parameters']);
        if (input === undefined && (o.command !== undefined || o.cmd !== undefined)) input = { command: o.command !== undefined ? o.command : o.cmd };
        var st = toolStep(run, name, input, at, false);
        if (!st) return;
        var has = ['output', 'result', 'response', 'stdout', 'observation', 'error', 'stderr', 'exit_code', 'exitCode', 'returncode', 'is_error', 'isError', 'success', 'ok', 'status'].some(function (k) { return o[k] !== undefined; });
        if (has) resultOf(st, o, null);
        else if (ref) pending[ref] = st;
        return;
      }
      var text = pick(o, ['content', 'text', 'message', 'output']);
      if (text === undefined) { skip(run, 'unknown'); return; }
      if (typeof text !== 'string') text = blockText(text);
      if (/user|human|prompt|task|goal/.test(role)) userText(run, text, at, false, false);
      else if (/assistant|agent|ai|model|final|answer|summary|message|response/.test(role) || !role) say(run, text, at, false);
      else skip(run, 'unknown');
    });
    function resultOf(st, o, at) {
      var out = pick(o, ['output', 'result', 'response', 'stdout', 'observation', 'content']);
      var err = pick(o, ['stderr', 'error']);
      var exit = pick(o, ['exit_code', 'exitCode', 'returncode', 'return_code', 'code', 'status_code']);
      var isErr = o.is_error === true || o.isError === true || o.ok === false || o.success === false || /^(?:error|failed|failure|errored)$/i.test(str(o.status)) ? true
        : (o.is_error === false || o.isError === false || o.ok === true || o.success === true || /^(?:ok|success|succeeded|completed|done)$/i.test(str(o.status)) ? false : null);
      var text = [out, err].filter(function (x) { return x !== undefined; }).map(function (x) { return typeof x === 'string' ? x : JSON.stringify(x); }).join('\n');
      var rep = typeof out === 'string' && out.trim().charAt(0) === '{' ? toolReply(out) : null;
      var ms = pick(o, ['duration_ms', 'durationMs', 'elapsed_ms', 'elapsedMs', 'latency_ms', 'took_ms']);
      if (ms === undefined && o.duration_s !== undefined) ms = Number(o.duration_s) * 1000;
      if (ms === undefined && typeof o.duration === 'number') ms = Number.isInteger(o.duration) && o.duration > 60 ? o.duration : o.duration * 1000;
      attachResult(st, rep ? rep.text + (err !== undefined ? '\n' + str(err) : '') : text, isErr !== null ? isErr : rep ? rep.isError : null, exit !== undefined && isFinite(Number(exit)) ? Number(exit) : rep ? rep.exit : null, at, ms !== undefined ? ms : rep ? rep.ms : null);
    }
  }

  var CC_TOOLS = { Bash: 1, Update: 1, Edit: 1, MultiEdit: 1, Write: 1, Read: 1, Search: 1, Grep: 1, Glob: 1, List: 1, LS: 1, Task: 1, Agent: 1, Fetch: 1, WebFetch: 1, WebSearch: 1, NotebookEdit: 1, Create: 1, TodoWrite: 1 };
  /** Claude Code's terminal, pasted: "⏺ Bash(npm test)" with "⎿" output under it. */
  function parseClaudeTerminal(text, run) {
    var lines = str(text).replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n');
    var cur = null;
    function flush() {
      if (!cur) return;
      var c = cur; cur = null;
      if (c.type === 'user') { userText(run, c.lines.join('\n'), null, false, false); return; }
      if (c.type === 'say') { say(run, c.lines.join('\n'), null, false); return; }
      var name = c.name, arg = c.arg.trim();
      var out = c.out.join('\n');
      var added = [], removed = [];
      c.out.forEach(function (l) {
        var m = /^\s*\d+\s+([+-])\s?(.*)$/.exec(l);
        if (m) (m[1] === '+' ? added : removed).push(m[2]);
      });
      var st;
      if (name === 'Bash') st = toolStep(run, 'Bash', { command: arg }, null, false);
      else if (name === 'Update' || name === 'Edit' || name === 'MultiEdit') st = toolStep(run, 'Edit', { file_path: arg, new_string: added.join('\n'), old_string: removed.join('\n') }, null, false);
      else if (name === 'Write' || name === 'Create') {
        var body = c.out.slice(1).map(function (l) { return l.replace(/^\s*\d+\s?/, ''); }).join('\n');
        st = toolStep(run, 'Write', { file_path: arg, content: body }, null, false);
      } else if (name === 'Read') st = toolStep(run, 'Read', { file_path: arg }, null, false);
      else if (name === 'Search' || name === 'Grep' || name === 'Glob' || name === 'List' || name === 'LS') st = toolStep(run, 'Grep', { pattern: arg }, null, false);
      else if (name === 'Task' || name === 'Agent') st = toolStep(run, 'Task', { description: arg }, null, false);
      else if (name === 'TodoWrite') st = toolStep(run, 'TodoWrite', {}, null, false);
      else st = toolStep(run, 'WebFetch', { url: arg }, null, false);
      if (!st) return;
      if (/\+\d+ lines? \(ctrl\+[a-z] to expand\)/.test(out)) { st.folded = true; run.folded = true; }
      var isErr = /^\s*(?:Error\b|Interrupted by user|Exit code [1-9])/.test(c.out[0] || '') || /^Exit code [1-9]\d*$/m.test(out);
      attachResult(st, out, isErr ? true : c.out.length ? false : null, null, null, null);
    }
    lines.forEach(function (raw) {
      var l = raw.replace(/\s+$/, '');
      var m;
      if (/^\s*[╭│╰─╮╯┃┏┗]/.test(l) || /^\s*[✻✶✳✢·*]\s+\w+…/.test(l) || /^\s*⎿\s+Interrupted/.test(l) && !cur) { skip(run, 'banner'); return; }
      if ((m = /^[⏺●]\s+(.*)$/.exec(l))) {
        flush();
        var body = m[1];
        var tm = /^([A-Z][A-Za-z]+)\((.*)\)\s*$/.exec(body);
        if (tm && CC_TOOLS[tm[1]]) cur = { type: 'tool', name: tm[1], arg: tm[2], out: [] };
        else cur = { type: 'say', lines: [body] };
        return;
      }
      if ((m = /^>\s(.*)$/.exec(l))) { flush(); cur = { type: 'user', lines: [m[1]] }; return; }
      if ((m = /^\s*⎿\s?(.*)$/.exec(l))) { if (cur && cur.type === 'tool') { cur.out.push(m[1]); cur.inOut = true; } return; }
      if (cur) {
        if (cur.type === 'tool') { if (cur.inOut) cur.out.push(l.replace(/^ {5}/, '')); }
        else cur.lines.push(l.replace(/^ {2}/, ''));
      } else if (l.trim()) skip(run, 'banner');
    });
    flush();
    if (run.folded) run.notes.push('Claude Code’s terminal folds long output ("+23 lines"), so some outputs here are not complete. The .jsonl transcript in ~/.claude/projects has all of it.');
  }

  var PROMPT = /^\s*(?:\([\w.-]+\)\s*)?(?:[\w.-]+@[\w.-]+(?::[^\s$#%]*)?\s?[$%]|[$%❯›]|➜\s+\S+|PS [^>\n]*>|[A-Z]:\\[^>\n]*>)\s+(\S.*)$/;
  var SUMMARY_MARK = /^\s*(?:#{1,3}\s*|\*\*)?(?:summary|final (?:message|answer|summary|report|response)|agent(?:'s)? (?:summary|message|response|report)|assistant|claude|codex|cursor|copilot|aider|devin|the agent(?: says)?|outcome)\s*(?:\*\*)?\s*[:\-–—]\s*(.*)$/i;
  function exitFromText(out) {
    var m = /(?:^|\n)\s*make(?:\[\d+\])?: \*\*\* \[[^\]]*\] Error (\d+)/.exec(out);
    if (m) return Number(m[1]);
    if (/(?:^|\n)npm (?:ERR!|error) (?:code|Test failed|command failed|Lifecycle script)/.test(out)) return 1;
    return null;
  }
  /** Plain terminal text: "$ cmd" prompts with output under them, and the agent's summary. */
  function parsePlain(text, summary, run) {
    var lines = str(text).replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n');
    var sum = str(summary).trim();
    if (!sum) {
      for (var i = lines.length - 1; i >= 0; i--) {
        var mk = SUMMARY_MARK.exec(lines[i]);
        if (mk && !PROMPT.test(lines[i])) {
          var label = clean(mk[0], 60).replace(/^[\s#*]+/, '').split(/[:\-–—]/)[0].replace(/\*+$/, '').trim();
          sum = [mk[1]].concat(lines.slice(i + 1)).join('\n').trim();
          lines = lines.slice(0, i);
          run.notes.push('Read everything after "' + label + ':" as the agent’s summary.');
          break;
        }
      }
    }
    var pre = [], cur = null, sawPrompt = false;
    function flush() {
      if (!cur) return;
      var st = toolStep(run, 'shell', { command: cur.cmd }, null, false);
      var out = cur.out.join('\n').replace(/\n+$/, '');
      if (st) attachResult(st, out, null, exitFromText(out), null, null);
      cur = null;
    }
    lines.forEach(function (l) {
      var m = PROMPT.exec(l);
      if (m) { if (!sawPrompt && pre.join('').trim()) userText(run, pre.join('\n'), null, false, false); sawPrompt = true; flush(); cur = { cmd: m[1], out: [] }; return; }
      if (cur) cur.out.push(l); else pre.push(l);
    });
    if (!sawPrompt) {
      if (!sum) { sum = pre.join('\n').trim(); run.notes.push('No commands were found (no "$ " prompts), so this was read as the agent’s message alone - nothing in it can be backed. Paste the terminal output too.'); }
      else if (pre.join('').trim()) userText(run, pre.join('\n'), null, false, false);
    } else if (!sum && cur) {
      // The last paragraph after the last command's output, if it reads like a summary.
      var o = cur.out;
      var j = o.length - 1;
      while (j >= 0 && !o[j].trim()) j--;
      var end = j;
      while (j >= 0 && o[j].trim()) j--;
      var para = o.slice(j + 1, end + 1);
      var prose = para.join(' ');
      if (j >= 0 && para.length && para.length <= 12 && prose.split(/\s+/).length >= 4 && /\b(?:I|I've|I have|tests?|fixed|done|pass(?:es|ing)?|updated|added|created|deployed|pushed|opened|clean|works?)\b/i.test(prose) && /[.!]\s*$/.test(prose) && !/^\s/.test(para[0]) && para.every(function (x) { return !/^\s*(?:at |[\w./-]+:\d+|[|=+-]{3})/.test(x); })) {
        sum = para.join('\n');
        cur.out = o.slice(0, j + 1);
        run.notes.push('Read the last paragraph as the agent’s summary. If that is wrong, paste the summary in its own box.');
      }
    }
    flush();
    if (sum) say(run, sum, null, false);
  }

  function relativize(run) {
    var abs = [];
    run.steps.forEach(function (s) { (s.changes || []).forEach(function (c) { if (c.path && c.path.charAt(0) === '/') abs.push(c.path); }); if (s.path && s.path.charAt(0) === '/') abs.push(s.path); });
    // Only a working directory the run states is taken off: Claude Code's and
    // Codex's cwd, or the agent's own `cd /path`. Guessing a root from the
    // paths would turn src/billing/a.ts into a.ts and break every scope check.
    var root = run.cwd ? normPath(run.cwd).replace(/\/+$/, '') : '';
    if (!root && abs.length) {
      run.steps.some(function (s) { var m = s.cmd && /(?:^|[;&|]\s*)cd\s+(\/[^\s;&|]+)/.exec(s.cmd); if (m && abs.some(function (p) { return p.indexOf(m[1].replace(/\/+$/, '') + '/') === 0; })) { root = m[1].replace(/\/+$/, ''); return true; } return false; });
    }
    if (!root) return;
    var strip = function (p) { return p && p.indexOf(root + '/') === 0 ? p.slice(root.length + 1) : p; };
    run.steps.forEach(function (s) {
      if (s.path) s.path = strip(s.path);
      if (s.paths) s.paths = s.paths.map(strip);
      (s.changes || []).forEach(function (c) { c.path = strip(c.path); });
      if (s.kind === 'tool' && ACT_WORD[s.act] && s.path !== undefined && !s.cmd && s.label.indexOf('Patched ') !== 0) s.label = ACT_WORD[s.act] + ' ' + (s.path || '(no path)');
      if (s.label && s.label.indexOf('Patched ') === 0 && s.paths) s.label = 'Patched ' + s.paths.slice(0, 3).join(', ') + (s.paths.length > 3 ? ' +' + (s.paths.length - 3) : '');
    });
  }
  function finalize(run) {
    relativize(run);
    var steps = run.steps, lastTool = -1, lastUser = -1;
    steps.forEach(function (s, i) { if (s.kind === 'tool' && !s.side) lastTool = i; if (s.kind === 'user' && !s.side) lastUser = i; });
    var from = Math.max(lastTool, -1) + 1;
    var finals = steps.slice(from).filter(function (s) { return s.kind === 'say' && !s.side; });
    if (!finals.length) {
      var says = steps.filter(function (s) { return s.kind === 'say' && !s.side; });
      if (says.length) { finals = [lastOf(says)]; run.notes.push('The run ends on a tool call, so claims are read from the last thing the agent said (step ' + finals[0].n + ').'); }
    }
    finals.forEach(function (s) { s.final = true; });
    run.final = finals.map(function (s) { return s.n; });
    run.finalText = finals.map(function (s) { return s.text; }).join('\n\n');
    if (lastUser > lastTool && lastUser >= 0 && !finals.length) run.notes.push('The run ends on a message from the person, with no reply after it.');
    var tools = steps.filter(function (s) { return s.kind === 'tool'; });
    var times = steps.map(function (s) { return Date.parse(s.at); }).filter(isFinite);
    run.stats = {
      steps: steps.length, tools: tools.length,
      says: steps.filter(function (s) { return s.kind === 'say'; }).length,
      users: steps.filter(function (s) { return s.kind === 'user'; }).length,
      errors: tools.filter(function (s) { return s.ok === false; }).length,
      side: steps.filter(function (s) { return s.side; }).length,
      ms: times.length >= 2 ? Math.max.apply(null, times) - Math.min.apply(null, times) : null,
    };
    if (run.dropped) run.notes.push('The timeline keeps ' + fmtInt(LIMITS.steps) + ' steps; ' + plural(run.dropped, 'more step was', 'more steps were') + ' counted but not kept, so verdicts after that point can be wrong.');
    return run;
  }

  /** Which shape a pasted or dropped run is in. */
  function detect(text) {
    var t = str(text).replace(/^\uFEFF/, '');
    var head = t.slice(0, 200000).trimStart();
    var c = head.charAt(0);
    if (c === '[' || c === '{') {
      var whole = null;
      try { whole = JSON.parse(t); } catch (e) { whole = undefined; }
      if (whole !== undefined) return { kind: 'json', value: whole };
      return { kind: 'jsonl' };
    }
    var marks = (head.match(/^[⏺●] /gm) || []).length;
    if (marks >= 2 && /⎿/.test(head)) return { kind: 'claude-terminal' };
    return { kind: 'text' };
  }
  function looksMessages(a) { return a.some(function (m) { return m && typeof m === 'object' && typeof m.role === 'string'; }); }
  function looksItems(a) { return a.some(function (m) { return m && typeof m === 'object' && /^(?:function_call|function_call_output|custom_tool_call|local_shell_call|reasoning)$/.test(m.type); }); }
  function msgFormat(a) { return a.some(function (m) { return m && (Array.isArray(m.tool_calls) || m.role === 'tool' || m.function_call); }) ? 'openai' : 'anthropic'; }

  /**
   * Read a run. `opts.summary` is the agent's summary when it was pasted in
   * its own box (plain text only). Returns the run: steps, goal, the final
   * message, what was skipped and why, and notes.
   */
  function parseRun(text, opts) {
    opts = opts || {};
    var t = str(text).replace(/^\uFEFF/, '');
    if (t.length > LIMITS.inputBytes) {
      var big = newRun('text');
      big.error = 'That is over ' + fmtBytes(LIMITS.inputBytes) + '. Drop one session’s file, not a whole folder of them.';
      return big;
    }
    var d = detect(t);
    var run;
    if (d.kind === 'json') {
      var v = d.value;
      var arr = Array.isArray(v) ? v : v && typeof v === 'object' ? (Array.isArray(v.messages) ? v.messages : Array.isArray(v.output) ? (Array.isArray(v.input) ? v.input.concat(v.output) : v.output) : Array.isArray(v.items) ? v.items : Array.isArray(v.steps) ? v.steps : Array.isArray(v.events) ? v.events : Array.isArray(v.log) ? v.log : Array.isArray(v.trajectory) ? v.trajectory : [v]) : [];
      if (looksItems(arr)) { run = newRun('responses'); parseItems(arr, run, false); }
      else if (arr.length && arr.every(function (o) { return o && typeof o === 'object' && (o.type === 'user' || o.type === 'assistant' || o.type === 'summary') && (o.message || o.type === 'summary'); }) && arr.some(function (o) { return o.uuid || o.sessionId; })) { run = newRun('claude-jsonl'); parseClaudeJsonl(arr, run); }
      else if (looksMessages(arr) && !arr.some(function (o) { return o && (o.tool || o.tool_name); })) { run = newRun(msgFormat(arr)); parseMessages(arr, run); }
      else { run = newRun('toollog'); parseToolLog(arr, run); }
      if (v && typeof v === 'object' && !Array.isArray(v) && v.system) skip(run, 'system');
    } else if (d.kind === 'jsonl') {
      var lines = t.split(/\r?\n/);
      var objs = [], bad = 0, long = 0, over = 0;
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (!l.trim()) continue;
        if (objs.length + bad + long >= LIMITS.lines) { over = lines.slice(i).filter(function (x) { return x.trim(); }).length; break; }
        if (l.length > LIMITS.lineChars) { long++; continue; }
        try { objs.push(JSON.parse(l)); } catch (e) { bad++; }
      }
      var sample = objs.slice(0, 80);
      if (sample.some(function (o) { return o && (o.type === 'user' || o.type === 'assistant') && o.message && (o.uuid || o.sessionId || o.parentUuid !== undefined); })) { run = newRun('claude-jsonl'); parseClaudeJsonl(objs, run); }
      else if (sample.some(function (o) { return o && (o.type === 'response_item' || o.type === 'session_meta'); })) { run = newRun('codex'); parseItems(objs, run, true); }
      else if (looksItems(sample)) { run = newRun('responses'); parseItems(objs, run, false); }
      else if (looksMessages(sample) && !sample.some(function (o) { return o && (o.tool || o.tool_name); })) { run = newRun(msgFormat(objs)); parseMessages(objs, run); }
      else { run = newRun('toollog'); parseToolLog(objs, run); }
      if (bad) skip(run, 'not-json', bad);
      if (long) skip(run, 'too-long', long);
      if (over) { skip(run, 'over-lines', over); run.cut = true; run.notes.push('Read the first ' + fmtInt(LIMITS.lines) + ' lines; ' + plural(over, 'more line was', 'more lines were') + ' not read, so later steps are missing.'); }
    } else if (d.kind === 'claude-terminal') {
      run = newRun('claude-terminal'); parseClaudeTerminal(t, run);
    } else {
      var tl = t.split('\n');
      run = newRun('text');
      if (tl.length > LIMITS.lines) { skip(run, 'over-lines', tl.length - LIMITS.lines); run.cut = true; run.notes.push('Read the first ' + fmtInt(LIMITS.lines) + ' lines only.'); t = tl.slice(0, LIMITS.lines).join('\n'); }
      parsePlain(t, opts.summary, run);
    }
    if (d.kind !== 'text' && str(opts.summary).trim()) say(run, opts.summary, null, false);
    if (opts.name) run.name = clean(opts.name, 120);
    finalize(run);
    if (!run.steps.length) run.error = 'Nothing in that could be read as an agent run. Drop a Claude Code .jsonl, a messages .json, a tool log, or paste the terminal output and the agent’s summary.';
    return run;
  }

  /* ---------------- the run's facts ---------------- */

  function stripRead(out) {
    return str(out).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').split('\n').map(function (l) { return l.replace(/^\s*\d+(?:→|\t)/, ''); }).join('\n');
  }
  /** Changes, checks and tool steps, in order: what every verdict is read from. */
  function facts(run) {
    var F = { changes: [], checks: [], tools: [], byN: {}, testTexts: [], paths: [] };
    var seen = {};
    run.steps.forEach(function (s) {
      F.byN[s.n] = s;
      if (s.kind !== 'tool') return;
      F.tools.push(s);
      if (s.act === 'read' && s.path && s.ok !== false && s.out) { seen[s.path] = stripRead(s.out); if (isTestPath(s.path)) F.testTexts.push(seen[s.path]); }
      if (s.changes && s.ok !== false) s.changes.forEach(function (c) {
        if (!c.path && !c.unknown) return;
        var before = c.removed !== null && c.removed !== undefined ? c.removed : (c.kind === 'write' && seen[c.path] !== undefined ? seen[c.path] : null);
        var ch = { n: s.n, path: c.path, kind: c.kind, added: c.added || '', removed: c.removed, before: before, via: c.via || null, unknown: Boolean(c.unknown), revert: Boolean(c.revert), test: isTestPath(c.path), doc: isDocPath(c.path), config: isTestConfig(c.path), step: s };
        F.changes.push(ch);
        if (ch.test) { F.testTexts.push(ch.added); if (before) F.testTexts.push(before); }
        if (c.kind === 'write' && c.added) seen[c.path] = c.added;
        else if (c.kind === 'edit' && c.removed && seen[c.path] && seen[c.path].indexOf(c.removed) !== -1) seen[c.path] = seen[c.path].replace(c.removed, c.added);
        if (c.path) {
          var p = F.paths.filter(function (x) { return x.path === c.path; })[0];
          if (!p) { p = { path: c.path, steps: [], kinds: [], test: ch.test, doc: ch.doc }; F.paths.push(p); }
          if (p.steps.indexOf(s.n) === -1) p.steps.push(s.n);
          if (p.kinds.indexOf(c.kind) === -1) p.kinds.push(c.kind);
        }
      });
      (s.checks || []).forEach(function (k) {
        var r = s.result && s.result[k];
        var ok = r && r.known ? (r.ok && s.ok !== false) : s.ok;
        F.checks.push({ n: s.n, kind: k, ok: ok, r: r || null, step: s, subset: k === 'test' ? s.subset : null, hidden: ok === false && s.ok === true && (s.flags || []).some(function (f) { return f.kind === 'or-true' && f.on === k; }) });
      });
    });
    F.code = F.changes.filter(function (c) { return !c.doc; });
    F.lastCode = lastOf(F.code);
    F.commits = F.tools.filter(function (s) { return s.act === 'commit' || s.commit || (s.cmd && /\bgit\s+commit\b/.test(s.cmd)); });
    F.pushes = F.tools.filter(function (s) { return s.act === 'push' || (s.cmd && /\bgit\s+push\b/.test(s.cmd)); });
    return F;
  }

  /* ---------------- receipts ---------------- */

  function stepLine(s) { return s.cmd ? '$ ' + firstLine(s.cmd, 200) + (str(s.cmd).trim().indexOf('\n') !== -1 ? ' …' : '') : s.label; }
  function evStep(s, extra, tone) {
    return { n: s.n, lines: [stepLine(s)].concat(extra || []).filter(Boolean).slice(0, LIMITS.evLines).map(function (l) { return shown(l); }), tone: tone || 'info' };
  }
  function runShort(c) {
    var r = c.r;
    if (r && r.known) {
      if (c.kind === 'test') {
        if (r.noTests) return 'no tests ran';
        var parts = [];
        if (r.failed) parts.push(r.failed + ' failed');
        if (r.errors) parts.push(plural(r.errors, 'error'));
        if (r.passed !== null) parts.push(r.passed + ' passed');
        if (r.skipped) parts.push(r.skipped + ' skipped');
        if (r.todo) parts.push(r.todo + ' to do');
        return (parts.join(', ') || 'a summary with no counts') + (r.total !== null && r.total !== r.passed ? ', ' + r.total + ' in all' : '');
      }
      return r.errors ? plural(r.errors, 'error') + (r.warnings ? ', ' + plural(r.warnings, 'warning') : '') : 'clean';
    }
    if (c.step.exit !== null && c.step.exit !== undefined) return c.step.exit === 0 ? 'exited cleanly' : 'exit code ' + c.step.exit;
    return c.step.ok === false ? 'it failed' : c.step.ok === true ? 'exited cleanly' : 'no summary in its output';
  }
  function evCheck(c, tone) {
    var x = [];
    if (c.r) { (c.r.summary || []).forEach(function (l) { x.push(l); }); (c.r.bad || []).slice(0, 2).forEach(function (l) { x.push(l); }); }
    if (!x.length && c.step.err) x.push(c.step.err);
    if (c.step.exit !== null && c.step.exit !== undefined) x.push('exit code ' + c.step.exit);
    return evStep(c.step, x, tone);
  }
  function lineDiff(before, after) {
    function bag(text) { var b = {}; str(text).split('\n').forEach(function (l) { var k = l.trim(); if (k) b[k] = (b[k] || 0) + 1; }); return b; }
    var b1 = bag(before), b2 = bag(after), added = [], removed = [];
    str(after).split('\n').forEach(function (l) { var k = l.trim(); if (!k) return; if (b1[k]) b1[k]--; else added.push(l); });
    str(before).split('\n').forEach(function (l) { var k = l.trim(); if (!k) return; if (b2[k]) b2[k]--; else removed.push(l); });
    return { added: added, removed: removed };
  }
  function diffOf(ch) { return lineDiff(ch.before || '', ch.added || ''); }
  function evChange(ch, tone) {
    var d = diffOf(ch);
    var lines = [(ACT_WORD[ch.kind] || 'Changed') + ' ' + (ch.path || 'files Proof cannot see') + (ch.via === 'shell' ? ' (by a shell command)' : '')]
      .concat(d.added.slice(0, 2).map(function (l) { return '+ ' + l.trim(); }));
    return { n: ch.n, lines: lines.map(function (l) { return shown(l); }), tone: tone || 'info' };
  }
  function names(list, max) {
    max = max || 4;
    if (list.length > max) return list.slice(0, max).join(', ') + ' and ' + (list.length - max) + ' more';
    return list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }
  function V(verdict, why, evidence, extra) {
    var o = { verdict: verdict, why: why, evidence: (evidence || []).filter(Boolean).slice(0, 6) };
    if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
  }
  var VERDICTS = ['backed', 'partly', 'none', 'contradicted'];
  var VERDICT_WORD = { backed: 'Backed', partly: 'Partly', none: 'No evidence', contradicted: 'Contradicted' };
  var VERDICT_ICON = { backed: '✓', partly: '½', none: '?', contradicted: '✗' };

  function judgeTests(F, c) {
    var runs = F.checks.filter(function (k) { return k.kind === 'test'; });
    if (!runs.length) return V('none', 'No test command ran in this run.', [], { short: 'no test ever ran' });
    var last = lastOf(runs), r = last.r;
    var desc = 'step ' + last.n + ' (' + runShort(last) + (last.subset ? '; only ' + clip(last.subset, 60) : '') + ')';
    if (F.lastCode && F.lastCode.n > last.n) {
      return V('none', 'Tests last ran at ' + desc + '. The code changed after that, at step ' + F.lastCode.n + ' (' + F.lastCode.path + '), and they were never run again.', [evCheck(last), evChange(F.lastCode, 'against')], { short: 'tests were never re-run after the last edit', stale: true });
    }
    if (last.ok === false) return V('contradicted', 'The last test run, at ' + desc + ', failed' + (last.hidden ? ', and `|| true` hid the failure' : '') + '.', [evCheck(last, 'against')], { short: 'the last test run failed' });
    if (r && r.noTests) return V('contradicted', 'The last test run, at step ' + last.n + ', ran no tests at all.', [evCheck(last, 'against')], { short: 'the last test run ran no tests' });
    if (c.all && r && r.skipped > 0) return V('contradicted', 'It says all tests pass, but the last run (' + desc + ') skipped ' + r.skipped + '.', [evCheck(last, 'against')], { short: 'the last test run skipped ' + plural(r.skipped, 'test') });
    if (c.count && r && r.known && r.passed !== null && c.count !== r.passed) return V('contradicted', 'It says ' + c.count + ' tests; the last run, at ' + desc + ', counted ' + r.passed + ' passing.', [evCheck(last, 'against')], { short: 'the test count does not match the run' });
    if (c.all && last.subset) return V('partly', 'Only part of the suite ran after the last change (' + clip(last.subset, 80) + ' at step ' + last.n + '), so this does not show that all tests pass.', [evCheck(last)], { short: 'only part of the suite ran' });
    if (r && r.skipped > 0) return V('partly', 'Passed at ' + desc + ', with ' + plural(r.skipped, 'test') + ' skipped.', [evCheck(last)], { short: 'tests passed with some skipped' });
    if (last.ok === null) return V('partly', 'A test command ran at step ' + last.n + ', after the last change, but neither its output nor an exit code says how it went.', [evCheck(last)], { short: 'the test result is unclear' });
    if (!r || !r.known) return V('backed', 'The test run at step ' + last.n + ' came after the last change and exited cleanly (its output has no summary to count).', [evCheck(last, 'for')]);
    return V('backed', 'The test run at ' + desc + ' came after the last change and passed.', [evCheck(last, 'for')]);
  }
  var CHECK_WORD = { lint: 'lint', types: 'type check', build: 'build', test: 'tests' };
  function judgeChecker(F, kind) {
    var word = CHECK_WORD[kind];
    var runs = F.checks.filter(function (k) { return k.kind === kind; });
    if (!runs.length) return V('none', 'No ' + word + ' command ran in this run.', [], { short: 'no ' + word + ' ran' });
    var last = lastOf(runs);
    if (F.lastCode && F.lastCode.n > last.n) return V('none', 'The ' + word + ' last ran at step ' + last.n + ' (' + runShort(last) + '). The code changed after that, at step ' + F.lastCode.n + ', and it did not run again.', [evCheck(last), evChange(F.lastCode, 'against')], { short: 'the ' + word + ' did not run after the last edit', stale: true });
    if (last.ok === false) return V('contradicted', 'The ' + word + ' at step ' + last.n + ' reported ' + runShort(last) + (last.hidden ? ', and `|| true` hid the failure' : '') + '.', [evCheck(last, 'against')], { short: 'the ' + word + (last.hidden ? ' failed and the failure was hidden' : ' failed') });
    if (last.ok === null) return V('partly', 'The ' + word + ' ran at step ' + last.n + ', after the last change, but its output does not say how it went.', [evCheck(last)], { short: 'the ' + word + ' result is unclear' });
    return V('backed', 'The ' + word + ' at step ' + last.n + ' came after the last change: ' + runShort(last) + '.', [evCheck(last, 'for')]);
  }
  function judgeNoErrors(F, A) {
    if (!F.tools.length) return V('none', 'There are no tool steps in this run to check.', [], { short: 'there is nothing to check it against' });
    if (A.errors.length) {
      var e = A.errors[0];
      return V('contradicted', 'Step ' + e.n + ' failed' + (e.line ? ' (' + clip(e.line, 100) + ')' : '') + ' and nothing after it fixed or re-ran it' + (A.errors.length > 1 ? '; ' + plural(A.errors.length - 1, 'more error', 'more errors') + ' like it' : '') + '.', A.errors.slice(0, 3).map(function (x) { return evStep(F.byN[x.n], [x.line], 'against'); }), { short: 'it kept going after an error' });
    }
    var hidden = F.checks.filter(function (k) { return k.hidden; });
    if (hidden.length) return V('contradicted', 'The ' + CHECK_WORD[hidden[0].kind] + ' at step ' + hidden[0].n + ' failed (' + runShort(hidden[0]) + '), and `|| true` hid it.', [evCheck(hidden[0], 'against')], { short: 'a failure was hidden with || true' });
    var failed = F.tools.filter(function (s) { return s.ok === false; });
    if (failed.length) return V('backed', plural(failed.length, 'step') + ' failed along the way, and each was followed by a successful re-run.', [evStep(lastOf(failed), [lastOf(failed).err], 'info')]);
    return V('backed', 'No step in the run failed.', []);
  }
  function verifyAfter(F, from) {
    return F.tools.filter(function (s) { return s.n > from && ((s.checks || []).indexOf('test') !== -1 || s.act === 'run'); });
  }
  function judgeFixed(F, run, c) {
    var named = c.paths || [];
    if (named.length) {
      var missing = named.filter(function (p) { return !F.changes.some(function (ch) { return samePath(ch.path, p); }); });
      if (missing.length === named.length) return V(run.cut ? 'none' : 'contradicted', 'No step in this run changed ' + names(missing) + '.', [], { short: 'the file it names was never changed' });
    }
    if (!F.changes.length) return V('none', 'Nothing in this run changed a file.', [], { short: 'nothing was changed' });
    var target = (named.length ? F.changes.filter(function (ch) { return named.some(function (p) { return samePath(ch.path, p); }); })[0] : null) || F.code[0] || F.changes[0];
    if (!F.lastCode) return V('backed', 'Changed ' + target.path + ' at step ' + target.n + ' (documentation only, which no test covers).', [evChange(target, 'for')]);
    var last = F.lastCode;
    var after = F.checks.filter(function (k) { return k.n > last.n; });
    var testAfter = lastOf(after.filter(function (k) { return k.kind === 'test'; }));
    if (testAfter && testAfter.ok === false) return V('contradicted', 'The tests after the last change (step ' + testAfter.n + ') failed: ' + runShort(testAfter) + '.', [evChange(target), evCheck(testAfter, 'against')], { short: 'the tests after the change failed' });
    if (testAfter && testAfter.ok === true) {
      if (testAfter.r && testAfter.r.skipped) return V('partly', 'Changed ' + target.path + ' at step ' + target.n + '; the tests after the last change passed with ' + testAfter.r.skipped + ' skipped (step ' + testAfter.n + ').', [evChange(target), evCheck(testAfter)], { short: 'tests passed only with some skipped' });
      return V('backed', 'Changed ' + target.path + ' at step ' + target.n + ', and the tests after the last change passed (step ' + testAfter.n + ').', [evChange(target, 'for'), evCheck(testAfter, 'for')]);
    }
    var ran = verifyAfter(F, last.n).filter(function (s) { return s.act === 'run'; });
    var goodRun = lastOf(ran.filter(function (s) { return s.ok === true; }));
    if (goodRun) return V('backed', 'Changed ' + target.path + ' at step ' + target.n + ', and ran it after the last change without an error (step ' + goodRun.n + ').', [evChange(target, 'for'), evStep(goodRun, [], 'for')]);
    var tests = F.checks.filter(function (k) { return k.kind === 'test' && k.n > target.n; });
    var lastTest = lastOf(tests);
    var statics = uniq(after.map(function (k) { return CHECK_WORD[k.kind]; }));
    if (lastTest && lastTest.ok) return V('partly', 'Changed ' + target.path + ' at step ' + target.n + '. Tests passed at step ' + lastTest.n + ' (' + runShort(lastTest) + '), but the code changed again after that (step ' + last.n + ')' + (statics.length ? ' and only the ' + statics.join(' and ') + ' ran after it.' : ' and nothing ran after it.'), [evChange(target), evCheck(lastTest), evChange(last, 'against')], { short: 'the tests did not run after the last change' });
    if (after.length) return V('partly', 'Changed ' + target.path + ' at step ' + target.n + '; only the ' + statics.join(' and ') + ' ran after the last change, not the tests.', [evChange(target), evCheck(lastOf(after))], { short: 'no test ran after the last change' });
    return V('partly', 'Changed ' + target.path + ' at step ' + target.n + ', but nothing ran after the last change (step ' + last.n + ') to show it works.', [evChange(target), evChange(last, 'against')], { short: 'nothing ran after the last change' });
  }
  function judgeVerified(F) {
    var from = F.lastCode ? F.lastCode.n : 0;
    var v = verifyAfter(F, from);
    var good = lastOf(v.filter(function (s) { var ch = F.checks.filter(function (k) { return k.n === s.n && k.kind === 'test'; })[0]; return ch ? ch.ok === true : s.ok === true; }));
    var bad = lastOf(v.filter(function (s) { var ch = F.checks.filter(function (k) { return k.n === s.n && k.kind === 'test'; })[0]; return ch ? ch.ok === false : s.ok === false; }));
    if (bad && (!good || bad.n > good.n)) return V('contradicted', 'The check after the last change (step ' + bad.n + ') failed.', [evStep(bad, [bad.err], 'against')], { short: 'the check after the change failed' });
    if (good) return V('backed', (F.lastCode ? 'After the last change (step ' + F.lastCode.n + '), ' : '') + 'step ' + good.n + ' ran it and it passed.', [evStep(good, [], 'for')]);
    var statics = F.checks.filter(function (k) { return k.n > from && k.kind !== 'test'; });
    if (statics.length) return V('partly', 'Only the ' + uniq(statics.map(function (k) { return CHECK_WORD[k.kind]; })).join(' and ') + ' ran after the last change (step ' + from + '); nothing ran the code or the tests.', [evCheck(lastOf(statics))], { short: 'nothing ran the code after the last change' });
    return V('none', F.lastCode ? 'Nothing ran after the last change, at step ' + F.lastCode.n + '.' : 'Nothing in the run tested or ran the code.', F.lastCode ? [evChange(F.lastCode, 'against')] : [], { short: 'nothing was run to verify it' });
  }
  var NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1, an: 1, single: 1, 'a single': 1 };
  function numWord(x) { if (x === undefined || x === null) return null; var s = str(x).toLowerCase().trim(); if (/^\d+$/.test(s)) return Number(s); return NUMW[s] !== undefined ? NUMW[s] : null; }
  function judgeFiles(F, run, c) {
    var list = F.paths.slice();
    if (c.qual === 'test') list = list.filter(function (p) { return p.test; });
    if (c.qual === 'new') list = list.filter(function (p) { return p.kinds.indexOf('write') !== -1; });
    var n = list.length;
    var commit = lastOf(F.commits.filter(function (s) { return s.filesChangedLine; }));
    var ev = list.slice(0, 4).map(function (p) { var ch = F.changes.filter(function (x) { return x.path === p.path; })[0]; return evChange(ch, n === c.count ? 'for' : 'info'); });
    if (commit) ev.push(evStep(commit, [commit.filesChangedLine], n === c.count ? 'for' : 'against'));
    var pl = list.map(function (p) { return p.path; });
    var what = c.qual === 'test' ? 'test file' : c.qual === 'new' ? 'new file' : 'file';
    if (n === c.count) return V('backed', 'It changed ' + plural(n, what) + (n ? ': ' + names(pl) : '') + '.', ev);
    if (F.changes.some(function (ch) { return ch.unknown; }) && n < c.count) return V('partly', 'Proof sees ' + plural(n, what) + '; a patch applied by a shell command may have changed more.', ev);
    var extra = [];
    if (list.some(function (p) { return p.test; }) && c.qual !== 'test') extra.push('a test file');
    if (list.some(function (p) { return p.kinds.indexOf('delete') !== -1; })) extra.push('a deletion');
    return V(run.cut ? 'none' : 'contradicted', 'It changed ' + plural(n, what) + ', not ' + c.count + (extra.length ? ' - including ' + extra.join(' and ') : '') + (n ? ': ' + names(pl) : '') + '.', ev, { short: 'it changed ' + plural(n, what) + ', not ' + c.count });
  }
  function judgePaths(F, run, c) {
    var hit = [], miss = [], mentioned = [];
    c.paths.forEach(function (p) {
      var ch = F.changes.filter(function (x) { return samePath(x.path, p) && (!c.del || x.kind === 'delete'); });
      if (ch.length) hit.push(lastOf(ch));
      else {
        var m = F.tools.filter(function (s) { return s.cmd && s.cmd.toLowerCase().indexOf(basename(p).toLowerCase()) !== -1; })[0];
        if (m) mentioned.push({ p: p, s: m }); else miss.push(p);
      }
    });
    var ev = hit.slice(0, 4).map(function (ch) { return evChange(ch, 'for'); }).concat(mentioned.slice(0, 2).map(function (m) { return evStep(m.s, [], 'info'); }));
    if (!miss.length && !mentioned.length) return V('backed', (c.del ? 'Deleted ' : 'Changed ') + names(hit.map(function (ch) { return ch.path + ' (step ' + ch.n + ')'; })) + '.', ev);
    if (hit.length || mentioned.length) return V('partly', (hit.length ? (c.del ? 'Deleted ' : 'Changed ') + names(hit.map(function (ch) { return ch.path; })) + '; ' : '') + (mentioned.length ? names(mentioned.map(function (m) { return m.p; })) + ' only came up in a command (step ' + mentioned[0].s.n + '), not an edit' : '') + (miss.length ? (mentioned.length ? '; ' : '') + 'no step changed ' + names(miss) : '') + '.', ev, { short: 'not every file it names was changed' });
    return V(run.cut || !F.tools.length ? 'none' : 'contradicted', 'No step in this run ' + (c.del ? 'deleted ' : 'changed ') + names(miss) + '.', [], { short: 'the file it names was never changed' });
  }
  var TEST_DEF = /\b(?:x|f)?(?:it|test|specify|scenario)(?:\.(?:skip|only|todo|concurrent|failing|each\s*(?:\([^)]*\)|`[^`]*`)))*\s*\(\s*['"`]|\bdef\s+test_?\w*\s*\(|\bfunc\s+Test\w+\s*\(|#\[test\]|@Test\b|^\s*test\s+['"]|\bt\.Run\s*\(\s*["`]/gm;
  function countRe(text, re) { return allMatches(str(text), re).length; }
  function judgeAddTests(F, run, c) {
    var tf = F.changes.filter(function (ch) { return ch.test && (!c.paths || !c.paths.length || c.paths.some(function (p) { return samePath(ch.path, p); })); });
    if (!tf.length) return V(run.cut ? 'none' : 'contradicted', 'No step changed a test file' + (c.paths && c.paths.length ? ' named ' + names(c.paths) : '') + '.', [], { short: 'no test file was touched' });
    var net = 0;
    tf.forEach(function (ch) { net += countRe(ch.added, TEST_DEF) - countRe(ch.before || '', TEST_DEF); });
    var ev = tf.slice(0, 3).map(function (ch) { return evChange(ch, net > 0 ? 'for' : 'info'); });
    var tp = uniq(tf.map(function (ch) { return ch.path; }));
    if (net <= 0) return V('partly', 'It changed ' + names(tp) + ', but the changes add no new test cases' + (net < 0 ? ' (they remove ' + plural(-net, 'test') + ')' : '') + '.', ev, { short: 'no new test cases were added' });
    if (c.count && net < c.count) return V('partly', 'It added ' + net + ' test case' + (net === 1 ? '' : 's') + ', not ' + c.count + ', in ' + names(tp) + '.', ev, { short: 'fewer new tests than it says' });
    return V('backed', 'It added ' + plural(net, 'test case') + ' in ' + names(tp) + '.', ev);
  }
  function judgeCommit(F, c) {
    if (!F.commits.length) return V('none', 'No step made a commit.', [], { short: 'no commit was made' });
    var good = F.commits.filter(function (s) { return s.commit || (s.ok === true && !/nothing to commit|no changes added to commit/i.test(s.out || '')); });
    var last = lastOf(F.commits);
    if (!good.length) return V('contradicted', 'The commit at step ' + last.n + ' did not go through' + (/nothing to commit/i.test(last.out || '') ? ' ("nothing to commit")' : last.err ? ' (' + clip(last.err, 80) + ')' : '') + '.', [evStep(last, [last.err], 'against')], { short: 'the commit did not go through' });
    var g = lastOf(good);
    var ev = [evStep(g, [g.commit && g.commit.line, g.filesChangedLine], 'for')];
    if (c.branch && g.commit && g.commit.branch.toLowerCase() !== c.branch.toLowerCase()) return V('partly', 'Committed at step ' + g.n + ', but on ' + g.commit.branch + ', not ' + c.branch + '.', ev, { short: 'the commit is on another branch' });
    if (F.lastCode && F.lastCode.n > g.n) return V('partly', 'Committed at step ' + g.n + ', but files changed after that (step ' + F.lastCode.n + ') and were not committed.', ev.concat([evChange(F.lastCode, 'against')]), { short: 'later changes were not committed' });
    return V('backed', 'Committed at step ' + g.n + (g.commit ? ': ' + g.commit.branch + ' ' + g.commit.hash : '') + '.', ev);
  }
  function judgePush(F) {
    if (!F.pushes.length) return V('none', 'No step pushed anything.', [], { short: 'nothing was pushed' });
    var last = lastOf(F.pushes), out = str(last.out);
    if (last.ok === false || /\[rejected\]|error: failed to push|^fatal:/m.test(out)) return V('contradicted', 'The push at step ' + last.n + ' failed' + (last.err ? ': ' + clip(last.err, 100) : '') + '.', [evStep(last, [last.err], 'against')], { short: 'the push failed' });
    if (/Everything up-to-date/.test(out)) return V('partly', 'The push at step ' + last.n + ' said "Everything up-to-date": nothing new went up.', [evStep(last, ['Everything up-to-date'])], { short: 'the push sent nothing new' });
    var lastCommit = lastOf(F.commits.filter(function (s) { return s.commit || s.ok === true; }));
    if (lastCommit && lastCommit.n > last.n) return V('partly', 'Pushed at step ' + last.n + ', but the commit at step ' + lastCommit.n + ' came after it and was not pushed.', [evStep(last), evStep(lastCommit, [], 'against')], { short: 'the last commit was not pushed' });
    var line = (/^.*(?:->|\[new branch\]).*$/m.exec(out) || [])[0];
    return V('backed', 'Pushed at step ' + last.n + (last.ok === null ? ' (the output does not show an exit code)' : '') + '.', [evStep(last, [line], 'for')]);
  }
  function judgePR(F, c) {
    var withUrl = F.tools.filter(function (s) { return s.prUrl && (s.act === 'pr' || /pull|merge_request/.test(s.prUrl.text)); });
    var prs = F.tools.filter(function (s) { return s.act === 'pr'; });
    if (withUrl.length) {
      var p = lastOf(withUrl);
      if (c.number && p.prUrl.number !== c.number) return V('contradicted', 'The pull request opened at step ' + p.n + ' is #' + p.prUrl.number + ', not #' + c.number + '.', [evStep(p, [p.prUrl.text], 'against')], { short: 'the PR number does not match' });
      if (p.act === 'pr' && p.ok === false) return V('contradicted', 'Opening the pull request failed at step ' + p.n + '.', [evStep(p, [p.err], 'against')], { short: 'opening the PR failed' });
      return V('backed', 'Step ' + p.n + ' opened pull request #' + p.prUrl.number + '.', [evStep(p, [p.prUrl.text], 'for')]);
    }
    if (prs.length) {
      var lp = lastOf(prs);
      if (lp.ok === false) return V('contradicted', 'Opening the pull request failed at step ' + lp.n + (lp.err ? ': ' + clip(lp.err, 100) : '') + '.', [evStep(lp, [lp.err], 'against')], { short: 'opening the PR failed' });
      return V('partly', 'Step ' + lp.n + ' tried to open a pull request' + (lp.ok ? ' and exited cleanly' : '') + ', but no PR link is in its output.', [evStep(lp)], { short: 'no PR link in the output' });
    }
    var pushed = F.pushes.some(function (s) { return s.ok !== false; });
    var lc = lastOf(F.commits);
    return V('none', 'No step opened a pull request (no `gh pr create`, and no PR link in any output)' + (!pushed ? (lc ? ', and the commit at step ' + lc.n + ' was never pushed' : ', and nothing was pushed') : '') + '.', lc && !pushed ? [evStep(lc, [lc.commit && lc.commit.line])] : [], { short: 'nothing shows a PR was opened' });
  }
  function judgeOps(F, act) {
    var word = act === 'deploy' ? 'deploy' : 'migration';
    var ss = F.tools.filter(function (s) { return s.act === act; });
    if (!ss.length) return V('none', 'No ' + word + ' command ran in this run.', [], { short: 'no ' + word + ' ran' });
    var last = lastOf(ss);
    if (last.ok === false) return V('contradicted', 'The ' + word + ' at step ' + last.n + ' failed' + (last.err ? ': ' + clip(last.err, 100) : '') + '.', [evStep(last, [last.err], 'against')], { short: 'the ' + word + ' failed' });
    var hiddenFlag = (last.flags || []).filter(function (f) { return f.kind === 'or-true' || f.kind === 'quiet'; })[0];
    if (hiddenFlag) return V('partly', 'The ' + word + ' ran at step ' + last.n + ', but `' + clip(hiddenFlag.text, 80) + '` hides whether it worked.', [evStep(last, [], 'against')], { short: 'the ' + word + '\u2019s result was hidden' });
    if (last.ok === null) return V('partly', 'The ' + word + ' ran at step ' + last.n + ', but nothing in the output says whether it worked.', [evStep(last)], { short: 'the ' + word + ' result is unclear' });
    if (act === 'deploy' && F.lastCode && F.lastCode.n > last.n) return V('partly', 'Deployed at step ' + last.n + ', but the code changed after that (step ' + F.lastCode.n + ').', [evStep(last), evChange(F.lastCode, 'against')], { short: 'the code changed after the deploy' });
    return V('backed', 'The ' + word + ' at step ' + last.n + ' finished without an error.', [evStep(last, [firstLine(lastOf(str(last.out).trim().split('\n')) || '', 200)], 'for')]);
  }
  var COVERAGE = [/^All files\s*\|\s*([\d.]+)/m, /^TOTAL\s+(?:\d+\s+){2,4}([\d.]+)%/m, /coverage:\s*([\d.]+)% of statements/, /^Statements\s*:\s*([\d.]+)%/m, /^Lines\s*:\s*([\d.]+)%/m, /Total coverage:?\s*([\d.]+)%/i];
  function judgeCoverage(F, c) {
    var found = null;
    F.tools.forEach(function (s) {
      var o = str(s.out);
      for (var i = 0; i < COVERAGE.length; i++) { var m = COVERAGE[i].exec(o); if (m) { found = { n: s.n, pct: Number(m[1]), line: m[0], s: s }; break; } }
    });
    if (!found) return V('none', 'No coverage figure appears in any output.', [], { short: 'no coverage report ran' });
    var ev = [evStep(found.s, [found.line], 'info')];
    if (F.lastCode && F.lastCode.n > found.n) return V('none', 'The last coverage figure (' + found.pct + '%, step ' + found.n + ') came before the last change (step ' + F.lastCode.n + ').', ev, { short: 'coverage was not measured after the last edit', stale: true });
    if (found.pct + 0.5 >= c.pct) { ev[0].tone = 'for'; return V('backed', 'Coverage at step ' + found.n + ': ' + found.pct + '%.', ev); }
    ev[0].tone = 'against';
    return V('contradicted', 'Coverage at step ' + found.n + ' is ' + found.pct + '%, not ' + c.pct + '%.', ev, { short: 'coverage is lower than it says' });
  }
  function judgeScope(F, c) {
    var bad = [];
    F.paths.forEach(function (p) {
      if (c.allow && c.allow.length && !c.allow.some(function (a) { return inScope(p.path, a); })) bad.push(p);
      else if (c.deny && c.deny.some(function (d) { return inScope(p.path, d) || samePath(p.path, d); })) bad.push(p);
      else if (c.denyTests && p.test) bad.push(p);
    });
    var scope = c.allow && c.allow.length ? names(c.allow) : c.deny && c.deny.length ? 'away from ' + names(c.deny) : c.denyTests ? 'away from the tests' : 'the stated scope';
    if (!(c.allow && c.allow.length) && !(c.deny && c.deny.length) && !c.denyTests) return judgeManual(F, c);
    if (bad.length) return V('contradicted', 'Changed ' + names(bad.map(function (p) { return p.path + ' (step ' + p.steps[0] + ')'; })) + (c.allow && c.allow.length ? ', outside ' + scope : '') + '.', bad.slice(0, 4).map(function (p) { return evChange(F.changes.filter(function (x) { return x.path === p.path; })[0], 'against'); }), { short: plural(bad.length, 'change') + ' outside the scope' });
    var unk = F.changes.filter(function (ch) { return ch.unknown; })[0];
    if (unk) return V('partly', 'Every change Proof can see stays inside ' + scope + ', but the patch applied at step ' + unk.n + ' changed files it cannot see.', [evStep(unk.step, [], 'against')], { short: 'a patch changed files Proof cannot see' });
    if (!F.paths.length) return V('backed', 'Nothing was changed, so nothing was changed outside ' + scope + '.', []);
    return V('backed', 'Every change stays inside ' + scope + ': ' + names(F.paths.map(function (p) { return p.path; })) + '.', F.paths.slice(0, 3).map(function (p) { return evChange(F.changes.filter(function (x) { return x.path === p.path; })[0], 'for'); }));
  }
  var NOSKIP_RULES = ['skip-test', 'focus-test', 'removed-tests', 'commented-test', 'deleted-test-file', 'config-fewer', 'pass-no-tests'];
  function judgeNoSkip(F, A) {
    var hits = A.findings.filter(function (f) { return NOSKIP_RULES.indexOf(f.rule) !== -1; });
    if (hits.length) return V('contradicted', hits[0].plain + ' (step ' + hits[0].n + ')' + (hits.length > 1 ? ', and ' + plural(hits.length - 1, 'more change', 'more changes') + ' like it' : '') + '.', hits.slice(0, 3).map(function (f) { return { n: f.n, lines: [f.path ? f.path : stepLine(F.byN[f.n])].concat(f.lines).slice(0, LIMITS.evLines).map(function (l) { return shown(l); }), tone: 'against' }; }), { short: 'a test was skipped or removed' });
    var lastRun = lastOf(F.checks.filter(function (k) { return k.kind === 'test'; }));
    if (lastRun && lastRun.r && lastRun.r.skipped) return V('partly', 'Nothing in this run added a skip, but the last test run (step ' + lastRun.n + ') still skipped ' + lastRun.r.skipped + '.', [evCheck(lastRun)], { short: 'some tests were already skipped' });
    return V('backed', 'No step skipped, focused, removed or disabled a test.', lastRun ? [evCheck(lastRun, 'for')] : []);
  }
  function judgeManual(F, c) {
    var ws = uniq((str(c.text).toLowerCase().match(/[a-z][a-z0-9_-]{4,}/g) || []).filter(function (w) { return !/^(?:should|would|could|about|there|their|which|where|after|before|change|changes|every|works?|working|without|properly|correctly)$/.test(w); }));
    var leads = [];
    F.tools.forEach(function (s) {
      if (leads.length >= 3) return;
      var hay = (str(s.label) + ' ' + str(s.path)).toLowerCase();
      if (ws.some(function (w) { return hay.indexOf(w) !== -1; })) leads.push(evStep(s, [], 'info'));
    });
    return V('none', 'Proof cannot read this one from the run. Check it yourself, or ask for a second opinion' + (leads.length ? '; the steps below mention it' : '') + '.', leads, { manual: true, short: 'it needs checking by hand' });
  }

  /* ---------------- claims ---------------- */

  var NEG = /\b(?:not|never|no longer|unable|cannot|can't|couldn't|could not|didn't|did not|don't|do not|doesn't|does not|haven't|have not|hasn't|has not|isn't|aren't|wasn't|weren't|won't|yet to|without (?:running|testing|verifying|checking))\b|n't\b/i;
  var HEDGE = /\b(?:should|might|may|probably|likely|i think|i believe|hopefully|seems? to|appears? to|expected to|ought to|presumably|i assume)\b/i;
  var INTENT = /\b(?:will|i'll|we'll|i will|going to|let me|let's|next,? i|plan to|need to|needs to|to do:|todo|about to|want to|try to|trying to|ready to|can now|once|before|after|when|until|if|unless|in order to)\b/i;
  function clauseBefore(sent, idx) {
    var parts = sent.slice(0, idx).split(/[,;:()]|\s(?:and|but|while|though|although|however|so|then)\s|\s[-–—]\s/i);
    return parts[parts.length - 1];
  }
  function polarity(sent, idx, quote) {
    var before = clauseBefore(sent, idx);
    var after = sent.slice(idx + quote.length, idx + quote.length + 20);
    if (NEG.test(before) || /^\s*(?:yet\s+)?(?:,\s*)?(?:not|n't)\b/i.test(after)) return 'neg';
    if (INTENT.test(before)) return 'intent';
    if (HEDGE.test(before) || HEDGE.test(quote)) return 'hedge';
    return 'pos';
  }
  var NUM_ALT = '\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
  var DETECT = [
    { kind: 'tests', re: /\b(\d+)\s*\/\s*(\d+)\s+(?:tests?|specs?)\b/i, take: function (m) { return { count: Number(m[1]), all: m[1] === m[2] }; } },
    { kind: 'tests', re: new RegExp('\\b(?:(all(?: of the| the)?|every(?: one of the)?|the (?:full|whole|entire)(?: test)? suite(?:\'s)?|both)\\s+)?(?:(' + NUM_ALT + ')\\s+(?:of\\s+(?:the\\s+)?(\\d+)\\s+)?)?(?:the\\s+)?(?:(unit|integration|e2e|end-to-end|existing|new|remaining|relevant|affected|related|other|regression|added)\\s+)?(?:tests?|specs?|test cases?|test suites?)\\s+(?:(?:are|is|now|all|still|were|have|has|also|again|both|do|does)\\s+)*(?:pass(?:es|ing|ed)?|green|succeed(?:s|ed|ing)?|ok\\b|clean)\\b', 'i'),
      take: function (m) { var count = numWord(m[2]), of = m[3] ? Number(m[3]) : null, q = (m[4] || '').toLowerCase(); var scoped = /^(?:new|relevant|affected|related|regression|added|other|remaining)$/.test(q); return { all: !scoped && (Boolean(m[1]) || (count !== null && of !== null && count === of)), count: scoped ? null : count, scoped: scoped }; } },
    { kind: 'tests', re: /\b(?:the\s+)?(?:full\s+|whole\s+|entire\s+)?test suite\s+(?:(?:is|now|still)\s+)*(?:pass(?:es|ing)?|green|clean)\b|\bno (?:more\s+)?(?:failing|failed|broken) tests?\b|\ball green\b|\b(?:npm test|yarn test|pnpm test|pytest|go test|cargo test|jest|vitest|mocha|rspec)\b[^.]{0,20}?\b(?:pass(?:es|ed)?|green|succeed(?:s|ed)?|is clean)\b/i, take: function () { return { all: true }; } },
    { kind: 'fixed', re: /\b(?:fix(?:ed|es))\b(?!-)|\b(?:resolved|solved|corrected|repaired)\b|\b(?:bug|issue|problem|error|regression|crash|failure|defect)s?\s+(?:is|are|has been|have been|was|were|should be|is now|are now)\s+(?:now\s+)?(?:fixed|resolved|gone|solved|addressed)\b|\b(?:it|this|that|the (?:feature|fix|change|endpoint|page|app|command|flow))\s+(?:now\s+)?works\b|\bworks (?:now|again|correctly|as expected)\b|\bis (?:now )?working(?: again| correctly| as expected)?\b/i },
    { kind: 'files', re: new RegExp('\\b(updated|modified|changed|edited|touched|created|added|wrote|rewrote|refactored|deleted|removed)\\s+(?:(?:a total of|exactly|just|only|the)\\s+)?(' + NUM_ALT + '|a single)\\s+(source\\s+|code\\s+|test\\s+|new\\s+)?files?\\b', 'i'),
      take: function (m) { var q = (m[3] || '').trim().toLowerCase(); return { count: numWord(m[2]), qual: q === 'test' ? 'test' : (q === 'new' || /^(?:created|added|wrote)$/i.test(m[1]) && q === 'new') ? 'new' : null }; } },
    { kind: 'files', re: new RegExp('\\b(' + NUM_ALT + ')\\s+(test\\s+|new\\s+)?files?\\s+(?:were\\s+|have been\\s+|got\\s+)?(?:changed|updated|modified|edited|touched)\\b', 'i'),
      take: function (m) { var q = (m[2] || '').trim().toLowerCase(); return { count: numWord(m[1]), qual: q || null }; } },
    { kind: 'addtests', re: new RegExp('\\b(?:added|wrote|created|introduced|included)\\s+(?:(' + NUM_ALT + '|a|an|some|new|more|several|a few)\\s+)?(?:new\\s+|more\\s+)?(?:unit\\s+|regression\\s+|integration\\s+|e2e\\s+)?(?:tests?|test cases?|specs?)\\b(?!\\s+(?:pass|are|is)\\b)', 'i'),
      take: function (m) { return { count: numWord(m[1]) }; } },
    { kind: 'lint', re: /\bno\s+(?:more\s+)?(?:lint(?:ing|er)?|eslint|ruff|flake8|style)\s+(?:errors|warnings|issues|problems)\b|\b(?:lint(?:ing|er)?|eslint|ruff|flake8|prettier|the linter)\b(?:\s+(?:check|run|step))?\s+(?:(?:is|are|now|also|still|both|and the type ?check)\s+)*(?:pass(?:es|ing|ed)?|clean|green|happy|ok)\b/i },
    { kind: 'types', re: /\bno\s+(?:more\s+)?(?:type|typescript|tsc|mypy)\s+errors\b|\b(?:type ?check(?:s|ing|er)?|typescript|tsc|mypy|pyright|types)\b\s+(?:(?:is|are|now|also|still|both)\s+)*(?:pass(?:es|ing|ed)?|clean|green|ok)\b/i },
    { kind: 'build', re: /\b(?:the\s+)?(?:build|project|app|code|it|everything)\s+(?:(?:now|still|also)\s+)*(?:builds|compiles)(?:\s+(?:cleanly|fine|successfully|without errors))?\b|\b(?:the\s+)?build\s+(?:(?:is|now|still)\s+)*(?:pass(?:es|ing)?|green|succeed(?:s|ed)|clean|ok|successful)\b|\bbuilt successfully\b/i },
    { kind: 'noerrors', re: /\b(?:with\s+)?no\s+(?:more\s+)?(?:errors|warnings|failures|exceptions)\b|\bwithout\s+(?:any\s+)?errors\b|\berror[- ]free\b|\b(?:ran|runs|completed|finished|went)\s+(?:cleanly|smoothly|without (?:errors|issues))\b|\beverything\s+(?:is\s+)?(?:works|working|passes|passing|green)\b/i },
    { kind: 'verified', re: /\b(?:verified|confirmed|double[- ]checked|validated|made sure)\b|\bi(?:'ve| have)?\s+tested\b|\btested\s+(?:it|this|that|the (?:fix|change|feature|endpoint|flow))\b|\bchecked that\b/i },
    { kind: 'commit', re: /\b(?:committed|made a commit|created a commit)\b/i, take: function (m, s) { var b = /\b(?:to|on|in(?:to)?)\s+(?:the\s+)?`?([\w./-]+)`?(?:\s+branch)?/i.exec(s.slice(m.index)) || /\bbranch\s+`?([\w./-]+)`?/i.exec(s); return { branch: b && /[\w]/.test(b[1]) && !/^(?:the|a|it|github|origin|main\.?)$/i.test(b[1]) ? b[1].replace(/[.,]$/, '') : null }; } },
    { kind: 'push', re: /\bpushed\b(?!\s+(?:it\s+)?(?:to\s+)?(?:prod|production|staging)\b)/i },
    { kind: 'pr', re: /\b(?:opened|created|raised|submitted|filed|put up|sent|made)\s+(?:a\s+|the\s+|an?\s+)?(?:draft\s+|new\s+)?(?:PR|pull request|merge request|MR)\b(?:\s*\(?#?(\d+)\)?)?|\bPR\s*#(\d+)\s+(?:is\s+)?(?:open|up|ready|created)\b/i, take: function (m, s) { var n = m[1] || m[2] || (/#(\d+)\b/.exec(s) || [])[1] || (/\/(?:pull|merge_requests)\/(\d+)/.exec(s) || [])[1]; return { number: n ? Number(n) : null }; } },
    { kind: 'deploy', re: /\b(?:deployed|shipped|released|rolled out|published|went live|is (?:now )?live|pushed (?:it )?to (?:prod|production|staging))\b/i },
    { kind: 'migrate', re: /\b(?:ran|applied|run|executed)\s+(?:the\s+|a\s+|all\s+)?(?:new\s+)?(?:db\s+|database\s+|schema\s+)?migrations?\b|\bmigrations?\s+(?:(?:is|are|has been|have been|was|were)\s+)?(?:successfully\s+)?(?:applied|run|executed)\b|\b(?:database|schema|db)\s+(?:is\s+|has been\s+)?(?:migrated|up to date)\b/i },
    { kind: 'coverage', re: /\bcoverage\b[^.\d]{0,30}?(\d{1,3}(?:\.\d+)?)\s?%|(\d{1,3}(?:\.\d+)?)\s?%\s+(?:test\s+|code\s+|line\s+)?coverage\b/i, take: function (m) { return { pct: Number(m[1] || m[2]) }; } },
  ];
  var KIND_WORD = { tests: 'Tests pass', fixed: 'Fixed', files: 'Files changed', paths: 'Files named', addtests: 'New tests', lint: 'Lint', types: 'Type check', build: 'Build', noerrors: 'No errors', verified: 'Verified', commit: 'Committed', push: 'Pushed', pr: 'Pull request', deploy: 'Deployed', migrate: 'Migration', coverage: 'Coverage', scope: 'Scope', noskip: 'No skipped tests', manual: 'Check by hand' };
  var EDIT_VERB = /\b(?:updated|modified|changed|edited|touched|created|added|wrote|rewrote|refactored|renamed|deleted|removed|moved|patched)\b/i;
  var PATH_TOKEN = /`([^`\n]{1,200})`|((?:\.{0,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]+)|\b([\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|cs|php|swift|sql|json|ya?ml|toml|md|css|scss|html|sh|tf|vue|svelte|ini|cfg|lock|gradle|xml|env))\b/g;
  function looksFile(p) {
    p = str(p).trim().replace(/[.,;:)]+$/, '');
    if (!p || p.length > 200 || /^-|[\s(){}=<>,;'"]/.test(p) || /^https?:|^[\w-]+\.(?:com|org|net|io|dev|app|co)(?:\/|$)/i.test(p) || /^v?\d/.test(p)) return null;
    return /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(p) || /(?:^|\/)\.[\w.-]+$/.test(p) ? p : null;
  }
  function pathsIn(s) {
    var out = [];
    allMatches(s, PATH_TOKEN).forEach(function (m) { var p = looksFile(m[1] || m[2] || m[3]); if (p) out.push({ p: normPath(p), at: m.index }); });
    var seen = {};
    return out.filter(function (x) { if (seen[x.p]) return false; seen[x.p] = 1; return true; });
  }
  var ADMIT = /\b(?:not (?:done|yet|tested|run|verified|sure|included|covered|implemented|handled)|didn't|did not|haven't|have not|couldn't|could not|wasn't able|weren't able|unable to|left (?:out|for you|as is|alone|that)|todo|to-do|still (?:need|needs|fail|fails|failing|broken|missing)|out of scope|known issue|caveat|heads[- ]up|one thing (?:i|to)|i skipped|was skipped|remains? (?:broken|failing|open)|follow[- ]up)\b/i;
  function straight(t) { return str(t).replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"'); }
  function sentences(text) {
    var t = straight(text).replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ');
    var out = [];
    t.split(/\n+/).forEach(function (ln) {
      ln = ln.replace(/^\s*(?:[-*+•]|\d+[.)]|#{1,6}|>)\s+/, '').replace(/\*\*|__/g, '').replace(/^[\s\p{Extended_Pictographic}\uFE0F\u200D✓✔✅☑]+/u, '').trim();
      if (!ln) return;
      ln.replace(/([.!?])\s+(?=[A-Z0-9"'`(\[])/g, '$1\u0000').split('\u0000').forEach(function (s) { s = s.trim(); if (s) out.push(clip(s, 400)); });
    });
    return out;
  }
  /** The words of a claim: the match, or - when that is one word ("fixed") - the clause it starts. */
  function quoteOf(s, idx, m) {
    var q = m.trim();
    if (q.length < 24) {
      var clause = s.slice(idx).split(/[.;:!?](?:\s|$)|\s[-–—]\s|,\s|\s(?:and|but|so|while)\s/)[0].trim();
      if (clause.length > q.length) q = clause;
    }
    return clip(q, 110);
  }
  /** The checkable sentences in the agent's summary, and the things it says it did not do. */
  function extractClaims(text) {
    var claims = [], admissions = [], read = 0, seen = {};
    sentences(text).forEach(function (s) {
      read++;
      var found = [], neg = false;
      DETECT.forEach(function (d) {
        if (found.some(function (f) { return f.kind === d.kind; })) return;
        var m = d.re.exec(s);
        if (!m) return;
        var pol = polarity(s, m.index, m[0]);
        if (pol === 'neg') { neg = true; return; }
        if (pol === 'intent') return;
        var c = { kind: d.kind, quote: quoteOf(s, m.index, m[0]), hedged: pol === 'hedge', at: m.index };
        if (d.take) { var x = d.take(m, s); Object.keys(x).forEach(function (k) { c[k] = x[k]; }); }
        if (c.kind === 'files' && !c.count) return;
        found.push(c);
      });
      // "fixed X" can be read as "fixed" alone; "no errors" said next to lint is lint's
      if (found.some(function (f) { return f.kind === 'lint' || f.kind === 'types'; })) found = found.filter(function (f) { return f.kind !== 'noerrors'; });
      var ps = pathsIn(s);
      if (ps.length) {
        var vm = EDIT_VERB.exec(s);
        var host = found.filter(function (f) { return f.kind === 'fixed' || f.kind === 'addtests'; })[0];
        if (host && host.at < ps[0].at) host.paths = ps.map(function (x) { return x.p; });
        else if (vm && vm.index < ps[0].at && !found.some(function (f) { return f.kind === 'files'; })) {
          var pol2 = polarity(s, vm.index, vm[0]);
          if (pol2 === 'pos' || pol2 === 'hedge') found.push({ kind: 'paths', quote: quoteOf(s, vm.index, vm[0]), paths: ps.map(function (x) { return x.p; }), del: /^(?:deleted|removed)$/i.test(vm[0]), hedged: pol2 === 'hedge', at: vm.index });
          else if (pol2 === 'neg') neg = true;
        }
      }
      found.forEach(function (c) {
        var key = c.kind + ':' + c.quote.toLowerCase();
        if (seen[key] || claims.length >= LIMITS.claims) return;
        seen[key] = 1;
        c.text = clip(s, 300);
        claims.push(c);
      });
      if ((neg || ADMIT.test(s)) && admissions.length < LIMITS.admissions) admissions.push(clip(s, 300));
    });
    claims.forEach(function (c, i) { c.id = 'c' + (i + 1); delete c.at; });
    return { claims: claims, admissions: admissions, sentences: read };
  }

  /* ---------------- acceptance criteria ---------------- */

  var DIR_WORD = /^(?:src|lib|app|apps|test|tests|spec|specs|docs?|packages|pkg|cmd|internal|server|client|web|api|scripts|config|migrations|db|public|styles?|components)$/i;
  function scopePaths(t) {
    var out = [];
    allMatches(t, /`([^`\n]{1,120})`|((?:\.{0,2}\/)?(?:[\w@.+*-]+\/)+[\w@.+*-]*)|\b([\w*.-]+\.[A-Za-z][\w]{0,7})\b|\b([a-z]+)\b/gi).forEach(function (m) {
      var p = m[1] || m[2] || m[3] || m[4];
      if (!p) return;
      if (m[4] && !DIR_WORD.test(m[4])) return;
      if (m[3] && /^(?:e\.g|i\.e|etc)\b/i.test(m[3])) return;
      if (/^https?:/i.test(p)) return;
      out.push(normPath(p).replace(/\/+$/, ''));
    });
    // "tests" alone is a folder only when it sits beside another path
    return uniq(out.filter(Boolean));
  }
  function parseCriteria(text) {
    return str(text).split(/\r?\n/).map(function (l) { return clean(l.replace(/^\s*(?:[-*+•]|\d+[.)]|\[[ xX]\])\s*/, ''), LIMITS.criterionChars).trim(); }).filter(Boolean).slice(0, LIMITS.criteria);
  }
  function classifyCriterion(t) {
    t = straight(t);
    var paths = scopePaths(t);
    if (/\b(?:no|don'?t|do not|never|without|zero|nor)\b[^.]*\b(?:skip(?:s|ped|ping)?|disabl\w*|delet\w*|remov\w*|weaken\w*|comment\w* out)\b[^.]*\b(?:tests?|specs?)\b|\bno (?:skipped|disabled|deleted|removed|focused) (?:tests?|specs?)\b|\btests? (?:are |were )?not (?:skipped|disabled|removed)\b|\bkeep (?:all )?(?:the )?(?:existing )?tests\b/i.test(t)) return { kind: 'noskip' };
    if (/\b(?:no|don'?t|do not|never|without|zero)\b[^.]*\b(?:chang\w*|edit\w*|touch\w*|modif\w*)\b[^.]*\boutside\b/i.test(t) || /\bonly\s+(?:chang\w*|touch\w*|edit\w*|modif\w*)\b/i.test(t) || /\b(?:stay|keep (?:it|changes|the change)s?)\s+(?:with)?in\b/i.test(t) || /\bscoped? to\b/i.test(t)) {
      return { kind: 'scope', allow: paths.filter(function (p) { return !/^(?:only|outside)$/i.test(p); }), deny: [] };
    }
    if (/\b(?:don'?t|do not|never|no)\s+(?:chang\w*|edit\w*|touch\w*|modif\w*)\b|\bleave\b.*\b(?:alone|unchanged|untouched)\b|\bno changes? to\b/i.test(t)) {
      var deny = paths.filter(function (p) { return !/^tests?$/i.test(p); });
      return { kind: 'scope', allow: [], deny: deny, denyTests: /\btests?\b/i.test(t) && !deny.length };
    }
    if (/\b(?:add|write|include|cover|create)\w*\b[^.]*\b(?:tests?|specs?|test cases?)\b/i.test(t) && !/\bpass/i.test(t)) return { kind: 'addtests', paths: paths.filter(function (p) { return isTestPath(p) && /\.\w+$/.test(p); }) };
    var cv = /(\d{1,3}(?:\.\d+)?)\s?%/.exec(t);
    if (/\bcoverage\b/i.test(t) && cv) return { kind: 'coverage', pct: Number(cv[1]) };
    if (/\b(?:lint|eslint|ruff|flake8|linter|linting)\b/i.test(t)) return { kind: 'lint' };
    if (/\btype ?check|\btsc\b|\bmypy\b|\bpyright\b|\btype errors?\b|\btypes? (?:pass|are clean|check)/i.test(t)) return { kind: 'types' };
    if (/\b(?:builds?|compiles?)\b/i.test(t)) return { kind: 'build' };
    if (/\b(?:pr|pull request|merge request|mr)\b/i.test(t)) { var pn = /#(\d+)/.exec(t); return { kind: 'pr', number: pn ? Number(pn[1]) : null }; }
    if (/\bmigrat/i.test(t)) return { kind: 'migrate' };
    if (/\bdeploy|\bship(?:ped)? to\b|\bin production\b|\bgo(?:es)? live\b/i.test(t)) return { kind: 'deploy' };
    if (/\bpush(?:ed)?\b/i.test(t)) return { kind: 'push' };
    if (/\bcommit/i.test(t)) return { kind: 'commit', branch: null };
    if (/\btests?\b|\bspecs?\b|\btest suite\b|\b(?:npm test|pytest|go test|cargo test|jest|vitest)\b/i.test(t)) return { kind: 'tests', all: !/\bnew tests?\b|\bthe \w+ tests?\b/i.test(t) || /\ball\b|\bunit\b|\bwhole\b|\bfull\b/i.test(t) };
    if (/\bno (?:errors|warnings|exceptions)\b|\bwithout errors\b|\berror[- ]free\b/i.test(t)) return { kind: 'noerrors' };
    var files = paths.filter(function (p) { return /\.[A-Za-z]\w*$/.test(p); });
    if (files.length && /\b(?:create|add|write|update|change|edit|delete|remove)\w*\b/i.test(t)) return { kind: 'paths', paths: files, del: /\b(?:delete|remove)\w*\b/i.test(t) };
    return { kind: 'manual' };
  }

  /* ---------------- patterns worth a look ---------------- */

  var SKIP_TEST = /\b(?:it|test|describe|context|suite|specify)\.(?:skip|todo)\s*\(|\bx(?:it|test|describe|context|specify)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\bpytest\.skip\s*\(|\bself\.skipTest\s*\(|\bt\.Skip(?:Now|f)?\s*\(|#\[ignore\]|@(?:Disabled|Ignore)\b|\bskip\s*:\s*true\b/;
  var FOCUS_TEST = /\b(?:it|test|describe|context)\.only\s*\(|\bf(?:it|describe|context)\s*\(/;
  var COMMENTED_TEST = /^\s*(?:\/\/+|#+|\/\*+|\*)\s*(?:it|test|describe)\s*\(\s*['"`]|^\s*#+\s*def\s+test_\w*\s*\(|^\s*\/\/+\s*func\s+Test\w+\s*\(/;
  var COMMENTED_ASSERT = /^\s*(?:\/\/+|#+|\/\*+|\*)\s*(?:expect\s*\(|assert\b|self\.assert|require\.|t\.Errorf)/;
  var STRONG = /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toMatch|toContain|toContainEqual|toHaveLength|toHaveBeenCalledWith|toHaveBeenCalledTimes|toHaveBeenNthCalledWith|toThrow|toThrowError|toBeCloseTo|toHaveProperty|toMatchInlineSnapshot)\s*\(\s*[^)\s]|\bassert(?:\.|_)?(?:equal|strictEqual|deepEqual|deepStrictEqual|notEqual|throws|rejects|match|equals?)\s*\(|\bself\.assert(?:Equal|NotEqual|Raises|In|NotIn|AlmostEqual|DictEqual|ListEqual|IsNone|Regex|Count)\w*\s*\(|^\s*assert\s+[^#\n]*(?:==|!=|\bin\b|<=?|>=?)|\bassert_(?:eq|ne)!|\b(?:require|assert)\.(?:Equal|NotEqual|Len|Contains|ErrorIs|EqualValues)\(|\.to\.(?:equal|eql|deep\.equal|have\.length|throw|be\.(?:above|below|closeTo))\b/gm;
  var WEAK = /\.(?:toBeDefined|toBeTruthy|toBeFalsy|toBeInstanceOf)\s*\(\s*\)|\.not\.(?:toBeNull|toBeUndefined)\s*\(\s*\)|expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)|^\s*assert\s+True\s*$|\bassert\.ok\s*\(\s*true\s*\)|\bself\.assertTrue\s*\(\s*True\s*\)|\bexpect\.anything\(\)|\.to\.(?:exist|be\.ok)\b|\bassert\s+\w+\s+is\s+not\s+None\b/gm;
  var EXPECT_LINE = /expect\s*\(\s*([^\n]+?)\s*\)\s*\.((?:not\.)?(?:toBe|toEqual|toStrictEqual|toBeCloseTo|toHaveLength|toMatch))\s*\(\s*([^\n]+?)\s*\)\s*;?\s*$/;
  var ASSERT_EQ_LINE = /(assert(?:Equal|_equal|\.equal|\.strictEqual|\.deepStrictEqual|\.deepEqual|Equals))\s*\(\s*([^,\n]+?)\s*,\s*([^\n]+?)\s*\)\s*;?\s*$/;
  var PY_ASSERT_LINE = /^\s*assert\s+([^=\n]+?)\s*==\s*([^\n#]+?)\s*(?:#.*)?$/;
  var ENV_BRANCH = /process\.env\.NODE_ENV\s*[!=]==?\s*['"]test['"]|['"]test['"]\s*[!=]==?\s*process\.env\.NODE_ENV|process\.env\.(?:JEST_WORKER_ID|VITEST(?:_WORKER_ID|_POOL_ID)?|PYTEST_CURRENT_TEST)\b|import\.meta\.env\.(?:MODE\s*[!=]==?\s*['"]test['"]|VITEST)|typeof\s+(?:jest|vi|describe|it)\s*!==?\s*['"]undefined['"]|['"]PYTEST_CURRENT_TEST['"]|['"]pytest['"]\s+in\s+sys\.modules|\bsys\.modules\b[^\n]*['"]pytest['"]|Rails\.env\.test\?|\btesting\.Testing\(\)|\bif\s+(?:settings\.)?TESTING\b|\bapp\.config\[['"]TESTING['"]\]/;
  var SETUP_FILE = /(^|\/)(?:jest|vitest|test)[._-]?setup|setupTests|(?:^|\/)test[-_]?utils?\b|(?:^|\/)conftest\.py$|\.config\.[a-z]+$/i;
  var EMPTY_CATCH = /\bcatch\s*(?:\(\s*[^)]*\))?\s*\{\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*\}/g;
  var EXCEPT_PASS = /\bexcept\b[^:\n]*:\s*(?:#[^\n]*)?\n?\s*(?:pass|\.\.\.)\s*(?:#[^\n]*)?$/gm;
  var PROMISE_SWALLOW = /\.catch\s*\(\s*(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(?:\{\s*\}|null|undefined|void 0|false)\s*\)/g;
  var GO_SWALLOW = /\bif\s+err\s*!=\s*nil\s*\{\s*\}|^\s*_\s*=\s*err\s*$/gm;
  var RUBY_SWALLOW = /\brescue\s+nil\b|\brescue\b[^\n]*\n\s*end\b/g;
  var SUPPRESS = /@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable(?:-next-line|-line)?|#\s*type:\s*ignore|#\s*noqa\b|#\s*pylint:\s*disable|#\[allow\(|@SuppressWarnings|\/\/\s*nolint\b|#\s*pragma:\s*no cover|istanbul ignore|c8 ignore/;
  var TIMEOUT_RE = /jest\.setTimeout\s*\(\s*(\d+)|\b(?:testTimeout|timeout|defaultTimeout|hookTimeout)\s*[:=]\s*(\d{3,})|this\.timeout\s*\(\s*(\d+)|@pytest\.mark\.timeout\s*\(\s*(\d+)|--testTimeout[= ](\d+)|--timeout[= ](\d+)|,\s*(\d{4,})\s*\)\s*;?\s*$/;
  var RETRY_RE = /jest\.retryTimes\s*\(\s*[1-9]|\bretries\s*:\s*[1-9]|this\.retries\s*\(\s*[1-9]|@flaky\b|@pytest\.mark\.flaky\b|--reruns[= ]?\d|\bretry\s*:\s*[1-9]|--retries[= ][1-9]/;
  var FEWER_RE = /--passWithNoTests|--pass-with-no-tests|testPathIgnorePatterns|modulePathIgnorePatterns|\bcollect_ignore\b|--ignore[= ]\S*tests?\b|--deselect\b|-k\s+['"]?not\b|"test"\s*:\s*"(?:echo\b|exit 0|true\b)|"test"\s*:\s*"[^"]*\|\|\s*(?:true|exit 0)|continue-on-error:\s*true|allow_failure:\s*true/;
  var THRESH_RE = /\b(fail_under|cov-fail-under|branches|lines|functions|statements|minimum_coverage|coverage_threshold)\b["']?\s*[:=]\s*(\d{1,3}(?:\.\d+)?)/g;
  var MOCK_MOD = /\b(?:jest|vi)\.(?:mock|doMock|unstable_mockModule)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  var MOCK_PY = /(?:@|\b)(?:mock\.|mocker\.)?patch(?:\.object)?\s*\(\s*['"]([\w.]+)['"]/g;
  var MOCK_SPY = /\b(?:jest|vi)\.spyOn\s*\(\s*([\w$]+)\s*,\s*['"](\w+)['"]\s*\)\s*\.mock(?:ReturnValue|ResolvedValue|Implementation)/g;
  var LIT = '(-?\\d+(?:\\.\\d+)?|\'[^\'\\n]{1,80}\'|"[^"\\n]{1,80}")';
  var EXPECT_LIT = new RegExp('\\.(?:toBe|toEqual|toStrictEqual|toBeCloseTo)\\s*\\(\\s*' + LIT + '\\s*[,)]|\\bassert(?:Equal|_equal|\\.equal|\\.strictEqual|\\.deepStrictEqual|Equals)\\s*\\([^,\\n]+,\\s*' + LIT + '\\s*\\)|\\bassert\\s+[^=\\n]+==\\s*' + LIT + '\\s*$', 'gm');
  var RETURN_LIT = new RegExp('\\breturn\\s+' + LIT + '\\s*;?\\s*(?:\\/\\/.*|#.*)?$');
  function subjectOf(path) { return basename(path).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/\.(?:test|spec)$/, '').replace(/^test_/, '').replace(/_test$/, '').replace(/[-_]/g, ''); }
  function normLit(l) { var s = str(l).trim(); if (/^['"]/.test(s)) return 's:' + s.slice(1, -1); return 'n:' + Number(s); }
  function distinctive(l) { var s = str(l).trim(); if (/^['"]/.test(s)) return s.length >= 6; var n = Number(s); return isFinite(n) && (/\./.test(s) || Math.abs(n) >= 100); }
  function testNameOf(line) { var m = /\(\s*(['"`])((?:(?!\1).){1,80})\1/.exec(line); return m ? m[2] : null; }
  var RULE_WHY = {
    'skip-test': ['A skipped test cannot fail. If it was failing, skipping it hides the failure instead of fixing it.', 'Un-skip it and run the full suite.'],
    'focus-test': ['With .only, the other tests in that file stop running - with some runners, the whole suite does.', 'Remove the .only and run the full suite.'],
    'commented-test': ['A commented-out test is a test that no longer runs.', 'Restore it and run the full suite.'],
    'removed-tests': ['Fewer tests, fewer ways to fail. Deleting a failing test is the easiest way to make a suite pass.', 'Check why each one went, against the version before the run.'],
    'deleted-test-file': ['Deleting a test file removes every test in it.', 'Check the file was meant to go, and that its cases live somewhere else.'],
    'weakened': ['Exact checks were swapped for looser ones, so a wrong value can now pass.', 'Put the exact expectations back and see if they pass.'],
    'changed-expected': ['Editing the expected value to match what the code returns makes a test pass without showing the code is right.', 'Work out which value is correct before trusting either.'],
    'mock-subject': ['Mocking the thing a test is meant to check means the test checks the mock.', 'Mock what it depends on, not what it tests.'],
    'env-branch': ['Code that behaves differently under test can pass every test and still be wrong in production.', 'Remove the branch, or make it about configuration rather than the test runner.'],
    'returns-expected': ['A function that returns the exact value a test checks for passes that test and nothing else.', 'Check the logic works for inputs the test does not use.'],
    'swallow-code': ['An empty catch or except: pass turns a failure into silence - the code carries on as if it worked.', 'Handle or log the error, or let it fail.'],
    'suppress': ['Silencing a checker hides what it would have said.', 'Read what it was complaining about.'],
    'timeout': ['A raised timeout can hide a test that hangs or a slowdown.', 'Check why it needed more time.'],
    'retries': ['Retrying failing tests until they pass hides flaky or broken behaviour.', 'Find out why it fails the first time.'],
    'config-fewer': ['The test setup changed so fewer tests run, or failures stop counting.', 'Undo the change and run the full suite.'],
    'threshold': ['A lower coverage bar lets less-tested code through.', 'Check whether the drop was agreed.'],
    'snapshots': ['Rewriting snapshots makes them match whatever the code now does - right or wrong.', 'Read the snapshot diff as carefully as the code.'],
    'or-true': ['`|| true` turns a failure into success, so nothing after it - or you - can tell it failed.', 'Run it without `|| true` and read the output.'],
    'quiet': ['Sending a check\u2019s errors to /dev/null hides why it failed.', 'Run it again with the output visible.'],
    'set+e': ['`set +e` lets a script carry on after a command fails.', 'Check every command after it actually succeeded.'],
    'pass-no-tests': ['--passWithNoTests reports success when no test ran at all.', 'Check the run found the tests you expect.'],
    'no-verify': ['--no-verify skips the repository\u2019s pre-commit and pre-push hooks - often its tests and linters.', 'Run the hooks: commit again without it.'],
    'force-push': ['A force push rewrites the branch on the remote and can drop other people\u2019s commits.', 'Check nothing on the remote was lost.'],
    'shell-edit-test': ['A shell command changed a test file, so the run does not show what changed.', 'Diff the file against the version before the run.'],
    'kept-going': ['The agent carried on after this failed, and nothing later fixed or re-ran it.', 'Run it yourself and read the error.'],
  };
  /** What the run ADDED that makes its success look better than it is. Pre-existing patterns are not counted. */
  function suspicious(F) {
    var out = [];
    function add(rule, sev, n, path, title, plain, lines) {
      var w = RULE_WHY[rule] || ['', ''];
      var key = rule + ':' + n + ':' + path + ':' + (lines && lines[0] || '');
      if (out.some(function (f) { return f.key === key; }) || out.length >= 60) return;
      out.push({ key: key, rule: rule, sev: sev, n: n, path: path || '', title: title, plain: plain || title.replace(/`/g, ''), why: w[0], fix: w[1], lines: (lines || []).slice(0, 3).map(function (l) { return shown(str(l).trim()); }) });
    }
    var lits = {};
    F.testTexts.forEach(function (t) { allMatches(t, EXPECT_LIT).forEach(function (m) { var l = m[1] || m[2] || m[3]; if (distinctive(l)) lits[normLit(l)] = l; }); });
    F.changes.forEach(function (ch) {
      if (ch.unknown) return;
      var d = diffOf(ch);
      var addedText = d.added.join('\n'), removedText = d.removed.join('\n');
      if (ch.kind === 'delete') { if (ch.test) add('deleted-test-file', 'high', ch.n, ch.path, 'Deleted the test file `' + ch.path + '`', 'Deleted the test file ' + ch.path, []); return; }
      if (ch.via === 'shell' && !ch.added) { if (ch.test && ch.kind === 'edit') add('shell-edit-test', 'low', ch.n, ch.path, 'Changed a test file with a shell command (`' + ch.path + '`)', null, [stepLine(ch.step)]); return; }
      if (ch.test) {
        d.added.forEach(function (l) {
          if (SKIP_TEST.test(l)) { var nm = testNameOf(l); add('skip-test', 'high', ch.n, ch.path, nm ? 'Skipped a test: `' + clip(nm, 70) + '`' : 'Skipped a test in `' + ch.path + '`', nm ? 'Skipped the test "' + clip(nm, 70) + '" in ' + ch.path : 'Skipped a test in ' + ch.path, [l]); }
          if (FOCUS_TEST.test(l)) add('focus-test', 'high', ch.n, ch.path, 'Focused the run on one test with `.only`', 'Focused the run on one test with .only in ' + ch.path, [l]);
          if (COMMENTED_TEST.test(l)) add('commented-test', 'high', ch.n, ch.path, 'Commented out a test in `' + ch.path + '`', 'Commented out a test in ' + ch.path, [l]);
        });
        var defsGone = countRe(ch.before || '', TEST_DEF) - countRe(ch.added, TEST_DEF);
        if (ch.before !== null && ch.before !== undefined && defsGone > 0) add('removed-tests', 'high', ch.n, ch.path, 'Removed ' + plural(defsGone, 'test') + ' from `' + ch.path + '`', 'Removed ' + plural(defsGone, 'test') + ' from ' + ch.path, d.removed.filter(function (l) { return countRe(l, TEST_DEF); }).slice(0, 2));
        var sDrop = countRe(removedText, STRONG) - countRe(addedText, STRONG);
        var wGain = countRe(addedText, WEAK) - countRe(removedText, WEAK);
        var cAsserts = d.added.filter(function (l) { return COMMENTED_ASSERT.test(l); });
        if (sDrop >= 1 && (wGain >= 1 || cAsserts.length) || (sDrop >= 2 && defsGone <= 0)) add('weakened', 'medium', ch.n, ch.path, 'Weakened the checks in `' + ch.path + '`', 'Weakened the checks in ' + ch.path + ' (' + plural(sDrop, 'exact check') + ' fewer)', d.added.filter(function (l) { return countRe(l, WEAK) > 0 || COMMENTED_ASSERT.test(l); }).concat(d.removed.filter(function (l) { STRONG.lastIndex = 0; return countRe(l, STRONG) > 0; }).map(function (l) { return '- ' + l.trim(); })).slice(0, 3));
        var changedN = 0;
        d.removed.forEach(function (rl) {
          if (changedN >= 3) return;
          var a = EXPECT_LINE.exec(rl), b = ASSERT_EQ_LINE.exec(rl), c = PY_ASSERT_LINE.exec(rl);
          d.added.forEach(function (al) {
            var a2 = EXPECT_LINE.exec(al), b2 = ASSERT_EQ_LINE.exec(al), c2 = PY_ASSERT_LINE.exec(al);
            var hit = (a && a2 && a[1] === a2[1] && a[2] === a2[2] && a[3] !== a2[3]) ? [a[2] + '(' + a[3] + ')', a2[2] + '(' + a2[3] + ')']
              : (b && b2 && b[1] === b2[1] && b[2] === b2[2] && b[3] !== b2[3]) ? [b[3], b2[3]]
              : (c && c2 && c[1] === c2[1] && c[2] !== c2[2]) ? ['== ' + c[2], '== ' + c2[2]] : null;
            if (hit && changedN < 3) { changedN++; add('changed-expected', 'medium', ch.n, ch.path, 'Changed what a test expects: `' + clip(hit[0], 50) + '` to `' + clip(hit[1], 50) + '`', 'Changed what a test in ' + ch.path + ' expects, from ' + clip(hit[0], 50) + ' to ' + clip(hit[1], 50), ['- ' + rl.trim(), '+ ' + al.trim()]); }
          });
        });
        var subj = subjectOf(ch.path);
        if (subj.length >= 3) {
          allMatches(addedText, MOCK_MOD).forEach(function (m) {
            var seg = basename(m[1]).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[-_]/g, '');
            if (seg === 'index') seg = basename(m[1].replace(/\/index(?:\.[a-z]+)?$/i, '')).toLowerCase().replace(/[-_]/g, '');
            if (seg === subj) add('mock-subject', 'high', ch.n, ch.path, 'Mocked the module the test is meant to check (`' + clip(m[1], 60) + '`)', 'Mocked the module its test is meant to check (' + clip(m[1], 60) + ') in ' + ch.path, [m[0]]);
          });
          var testText = ch.added + '\n' + (ch.before || '');
          allMatches(addedText, MOCK_PY).forEach(function (m) {
            var segs = m[1].split('.'); var fn = segs[segs.length - 1], mod = (segs[segs.length - 2] || '').replace(/[-_]/g, '').toLowerCase();
            if (mod === subj && new RegExp('(?:^|[^\\w.])' + fn.replace(/[^\w]/g, '') + '\\s*\\(').test(testText.replace(m[0], ''))) add('mock-subject', 'high', ch.n, ch.path, 'Mocked `' + clip(fn, 40) + '`, which the test itself calls', 'Mocked ' + clip(fn, 40) + ', which its test calls, in ' + ch.path, [m[0]]);
          });
          allMatches(addedText, MOCK_SPY).forEach(function (m) { if (m[1].toLowerCase().replace(/[-_]/g, '') === subj) add('mock-subject', 'high', ch.n, ch.path, 'Replaced `' + clip(m[1] + '.' + m[2], 50) + '` - the thing under test - with a mock', 'Replaced ' + m[1] + '.' + m[2] + ', the thing under test, with a mock in ' + ch.path, [m[0]]); });
        }
      }
      var testy = ch.test || ch.config || /jest|vitest|mocha|karma|playwright|cypress|pytest/i.test(ch.path);
      if (testy) {
        var tAdd = 0, tRem = 0, tLine = null;
        function tval(m) { var v = Number(m[1] || m[2] || m[3] || m[4] || m[5] || m[6] || m[7]); var s = m[4] || (m[6] && v < 1000) ? v * 1000 : v; return s; }
        d.added.forEach(function (l) { var m = TIMEOUT_RE.exec(l); if (m) { var v = tval(m); if (v > tAdd) { tAdd = v; tLine = l; } } });
        d.removed.forEach(function (l) { var m = TIMEOUT_RE.exec(l); if (m) tRem = Math.max(tRem, tval(m)); });
        if (tAdd >= 10000 && tAdd > tRem) add('timeout', 'low', ch.n, ch.path, 'Raised a test timeout to ' + fmtMs(tAdd), 'Raised a test timeout to ' + fmtMs(tAdd) + ' in ' + ch.path, [tLine]);
        d.added.forEach(function (l) { if (RETRY_RE.test(l)) add('retries', 'medium', ch.n, ch.path, 'Retries failing tests until they pass', 'Made failing tests retry in ' + ch.path, [l]); });
      }
      if (ch.config || /jest|vitest|mocha|pytest|karma|playwright|cypress|nyc|coverage|codecov/i.test(ch.path)) {
        d.added.forEach(function (l) { if (FEWER_RE.test(l)) add('config-fewer', 'high', ch.n, ch.path, 'Changed the test setup so fewer tests run or failures stop counting', 'Changed the test setup in ' + ch.path + ' so fewer tests run or failures stop counting', [l]); });
        var before = {}, after = {};
        allMatches(removedText, THRESH_RE).forEach(function (m) { before[m[1]] = Math.max(before[m[1]] || 0, Number(m[2])); });
        allMatches(addedText, THRESH_RE).forEach(function (m) { after[m[1]] = after[m[1]] === undefined ? Number(m[2]) : Math.min(after[m[1]], Number(m[2])); });
        Object.keys(after).forEach(function (k) { if (before[k] !== undefined && after[k] < before[k]) add('threshold', 'medium', ch.n, ch.path, 'Lowered a coverage threshold (' + k + ' from ' + before[k] + ' to ' + after[k] + ')', 'Lowered the ' + k + ' coverage threshold from ' + before[k] + ' to ' + after[k] + ' in ' + ch.path, []); });
      }
      if (/\.snap$|__snapshots__\//.test(ch.path)) add('snapshots', 'low', ch.n, ch.path, 'Rewrote a snapshot file by hand (`' + basename(ch.path) + '`)', 'Rewrote the snapshot file ' + ch.path, []);
      if (!ch.test && !ch.doc && !ch.config && !SETUP_FILE.test(ch.path)) {
        d.added.forEach(function (l) { if (ENV_BRANCH.test(l)) add('env-branch', 'high', ch.n, ch.path, 'Code behaves differently under test (`' + clip(l.trim(), 70) + '`)', 'Made ' + ch.path + ' behave differently when it is under test', [l]); });
        d.added.forEach(function (l) { var m = RETURN_LIT.exec(l); if (m && lits[normLit(m[1])] !== undefined) add('returns-expected', 'high', ch.n, ch.path, 'Returns the exact value a test checks for (`' + clip(m[1], 40) + '`)', ch.path + ' returns the exact value a test checks for (' + clip(m[1], 40) + ')', [l]); });
      }
      if (!ch.doc) {
        var swallowed = [[EMPTY_CATCH, 'an empty `catch`'], [EXCEPT_PASS, '`except: pass`'], [PROMISE_SWALLOW, 'a `.catch` that drops the error'], [GO_SWALLOW, 'an ignored `err`'], [RUBY_SWALLOW, 'a bare `rescue`']];
        swallowed.forEach(function (p) {
          var gain = countRe(ch.added, p[0]) - countRe(ch.before || '', p[0]);
          if (gain > 0) { var m = allMatches(ch.added, p[0])[0]; add('swallow-code', 'medium', ch.n, ch.path, 'Swallowed errors in new code: ' + p[1] + ' in `' + ch.path + '`', 'Added ' + p[1].replace(/`/g, '') + ' in ' + ch.path + ', which swallows errors', [m ? m[0].replace(/\s+/g, ' ') : '']); }
        });
        d.added.forEach(function (l) { var m = SUPPRESS.exec(l); if (m) add('suppress', 'low', ch.n, ch.path, 'Silenced a checker (`' + m[0] + '`)', 'Silenced a checker with ' + m[0] + ' in ' + ch.path, [l]); });
      }
    });
    F.tools.forEach(function (s) {
      var flags = s.flags || [];
      var orTrue = flags.filter(function (f) { return f.kind === 'or-true'; });
      var quiet = flags.filter(function (f) { return f.kind === 'quiet'; });
      orTrue.forEach(function (f) {
        var check = ['test', 'types', 'lint', 'build', 'migrate', 'deploy', 'pr', 'push', 'commit'].indexOf(f.on) !== -1;
        var q = quiet.some(function (x) { return x.on === f.on; });
        add('or-true', check ? 'medium' : 'low', s.n, '', check ? 'Hid a ' + (CHECK_WORD[f.on] || f.on) + ' failure with `' + (q ? '2>/dev/null ' : '') + '|| true`' : 'Ignored a command\u2019s failure with `|| true`', 'Step ' + s.n + ' ran ' + clip(f.text, 80) + ', which hides a failure', [stepLine(s)]);
      });
      quiet.forEach(function (f) { if (!orTrue.some(function (x) { return x.on === f.on; })) add('quiet', 'low', s.n, '', 'Threw away a ' + (CHECK_WORD[f.on] || f.on) + '\u2019s error output (`2>/dev/null`)', 'Step ' + s.n + ' sent the ' + (CHECK_WORD[f.on] || f.on) + '\u2019s errors to /dev/null', [stepLine(s)]); });
      flags.forEach(function (f) {
        if (f.kind === 'set+e') add('set+e', 'medium', s.n, '', 'Turned off stop-on-error (`set +e`)', 'Step ' + s.n + ' turned off stop-on-error', [stepLine(s)]);
        if (f.kind === 'pass-no-tests') add('pass-no-tests', 'medium', s.n, '', 'Told the test runner to pass with no tests (`--passWithNoTests`)', 'Step ' + s.n + ' ran the tests with --passWithNoTests', [stepLine(s)]);
        if (f.kind === 'no-verify') add('no-verify', 'medium', s.n, '', 'Skipped the git hooks (`--no-verify`)', 'Step ' + s.n + ' skipped the git hooks with --no-verify', [stepLine(s)]);
        if (f.kind === 'force-push') add('force-push', 'medium', s.n, '', 'Force-pushed (`--force`)', 'Step ' + s.n + ' force-pushed', [stepLine(s)]);
        if (f.kind === 'update-snapshots') add('snapshots', 'medium', s.n, '', 'Rewrote the test snapshots (`-u`)', 'Step ' + s.n + ' rewrote the test snapshots', [stepLine(s)]);
      });
    });
    var SEVR = { high: 0, medium: 1, low: 2 };
    out.sort(function (a, b) { return SEVR[a.sev] - SEVR[b.sev] || a.n - b.n; });
    out.forEach(function (f, i) { f.id = 'p' + (i + 1); delete f.key; });
    return out;
  }

  /** Steps that failed and that nothing later fixed or re-ran. Looking around (a read, a search) does not count. */
  function unaddressed(F) {
    var out = [];
    F.tools.forEach(function (s, i) {
      if (s.ok !== false) return;
      if (['read', 'search', 'web', 'other', 'task', 'noop'].indexOf(s.act) !== -1) return;
      var later = F.tools.slice(i + 1);
      var fixed;
      if (s.checks && s.checks.length) fixed = F.checks.some(function (k) { return k.n > s.n && s.checks.indexOf(k.kind) !== -1 && k.ok === true; });
      else if (s.path || (s.changes && s.changes.length)) { var p = s.path || s.changes[0].path; fixed = later.some(function (t) { return t.ok !== false && (t.path === p || (t.changes || []).some(function (c) { return c.path === p; })); }); }
      else if (s.cmd) { var sig = words(normSeg(s.cmd)).slice(0, 2).join(' '); fixed = later.some(function (t) { return t.ok === true && t.cmd && words(normSeg(t.cmd)).slice(0, 2).join(' ') === sig; }) || later.some(function (t) { return t.ok === true && t.act === s.act && s.act !== 'run'; }); }
      else fixed = later.some(function (t) { return t.ok === true && t.tool === s.tool; });
      if (fixed) return;
      out.push({ n: s.n, label: s.label, line: s.err || '', act: s.act, sev: ['test', 'types', 'lint', 'build', 'migrate', 'deploy', 'pr', 'push', 'commit'].indexOf(s.act) !== -1 ? 'medium' : 'low', last: i === F.tools.length - 1 });
    });
    return out;
  }

  /* ---------------- the verdict ---------------- */

  var CLAIM_POINTS = { partly: 6, none: 10, contradicted: 22 };
  var CRIT_POINTS = { partly: 6, none: 10, contradicted: 20 };
  var SEV_POINTS = { high: 15, medium: 8, low: 2 };
  var BAND = [
    { min: 80, id: 'good', word: 'Looks backed', sub: 'Still read the diff - this checks claims, not correctness.' },
    { min: 50, id: 'check', word: 'Check before merging', sub: 'Some claims have no receipt, or something needs a look.' },
    { min: 0, id: 'bad', word: 'Don\u2019t trust this yet', sub: 'The run does not show what the summary says.' },
  ];
  function verdictOf(A, run) {
    var reasons = [];
    A.claims.forEach(function (c) {
      if (c.verdict === 'backed') return;
      var w = (c.kind === 'tests' || c.kind === 'fixed' ? 1.5 : 1) * (c.hedged ? 0.5 : 1);
      reasons.push({ pts: Math.round(CLAIM_POINTS[c.verdict] * w), text: VERDICT_WORD[c.verdict] + ': \u201c' + clip(c.quote, 70) + '\u201d', refs: refsOf(c) });
    });
    A.criteria.forEach(function (c) {
      if (c.verdict === 'backed' || c.manual) return;
      reasons.push({ pts: CRIT_POINTS[c.verdict], text: 'Criterion ' + VERDICT_WORD[c.verdict].toLowerCase() + ': \u201c' + clip(c.text, 70) + '\u201d', refs: refsOf(c) });
    });
    var pat = 0;
    A.findings.forEach(function (f) {
      var p = Math.min(SEV_POINTS[f.sev], Math.max(0, 45 - pat));
      pat += p;
      if (p > 0) reasons.push({ pts: p, text: f.plain, refs: [f.n] });
    });
    var errPts = 0;
    A.errors.forEach(function (e) { var p = Math.min(6, Math.max(0, 18 - errPts)); errPts += p; if (p) reasons.push({ pts: p, text: 'Kept going after step ' + e.n + ' failed' + (e.line ? ' (' + clip(e.line, 60) + ')' : ''), refs: [e.n] }); });
    if (run.cut) reasons.push({ pts: 5, text: 'Part of the run was not read (it is over the reading limits)', refs: [] });
    reasons.sort(function (a, b) { return b.pts - a.pts; });
    // Each reason takes its share of what is left, so ten small doubts and
    // one big one both read as low without slamming into zero.
    var left = reasons.reduce(function (t, r) { return t * (1 - Math.min(r.pts, 60) / 100); }, 1);
    var score = Math.max(0, Math.min(100, Math.round(100 * left)));
    var nothing = !A.claims.length && !A.criteria.length;
    if (nothing && !A.findings.length && !A.errors.length) score = Math.min(score, 60);
    // The band must agree with the headline. Anything the receipts contradict,
    // or a high pattern, is "don't trust this yet"; a key claim with no
    // receipt, an error it walked past or a medium pattern is "check first".
    var live = A.claims.concat(A.criteria.filter(function (c) { return !c.manual; }));
    if (live.some(function (c) { return c.verdict === 'contradicted'; }) || A.findings.some(function (f) { return f.sev === 'high'; })) score = Math.min(score, 49);
    else if (live.some(function (c) { return c.verdict === 'none' && /^(?:tests|fixed|verified)$/.test(c.kind); }) || A.errors.length || A.findings.some(function (f) { return f.sev === 'medium'; })) score = Math.min(score, 79);
    var band = BAND.filter(function (b) { return score >= b.min; })[0];
    var backed = A.claims.filter(function (c) { return c.verdict === 'backed'; }).length;
    var head = A.claims.length ? backed + ' of ' + plural(A.claims.length, 'claim') + ' backed' : 'No claims to check';
    var why = headline(A, run);
    return {
      score: score, band: band.id, bandWord: band.word, bandSub: band.sub,
      backed: backed, total: A.claims.length,
      counts: VERDICTS.reduce(function (o, v) { o[v] = A.claims.filter(function (c) { return c.verdict === v; }).length; return o; }, {}),
      outcome: head + (why ? ' - ' + why : ''), reasons: reasons.slice(0, 12),
      checks: whatToCheck(A, run),
    };
  }
  function refsOf(c) { return uniq((c.evidence || []).map(function (e) { return e.n; })).slice(0, 6); }
  function headline(A, run) {
    var all = A.claims.concat(A.criteria.filter(function (c) { return !c.manual; }));
    var stale = all.filter(function (c) { return c.kind === 'tests' && c.stale; })[0];
    if (stale) return stale.short;
    var ct = all.filter(function (c) { return c.kind === 'tests' && c.verdict === 'contradicted'; })[0];
    if (ct) return ct.short;
    var hi = A.findings.filter(function (f) { return f.sev === 'high'; })[0];
    var con = A.claims.filter(function (c) { return c.verdict === 'contradicted'; })[0];
    if (con && (!hi || con.kind !== 'files')) return con.short || 'a claim is contradicted';
    if (hi) return hi.plain.charAt(0).toLowerCase() + hi.plain.slice(1);
    if (con) return con.short || 'a claim is contradicted';
    if (A.errors.length) return 'it kept going after step ' + A.errors[0].n + ' failed';
    var ccrit = A.criteria.filter(function (c) { return c.verdict === 'contradicted'; })[0];
    if (ccrit) return 'a criterion is not met: ' + clip(ccrit.text, 50);
    var none = A.claims.filter(function (c) { return c.verdict === 'none'; });
    if (none.length) return none.length === 1 ? none[0].short : plural(none.length, 'claim has', 'claims have') + ' no receipt';
    if (!A.claims.length) return run.finalText ? 'the summary makes no claim Proof can check' : 'the run has no final message';
    var mid = A.claims.filter(function (c) { return c.verdict === 'partly'; })[0];
    if (mid) return mid.short || 'some claims are only partly backed';
    if (A.findings.length) return 'every claim has a receipt, but ' + plural(A.findings.length, 'pattern needs', 'patterns need') + ' a look';
    return 'every claim has a receipt';
  }
  function whatToCheck(A, run) {
    var items = [];
    function add(prio, key, title, detail, refs) { if (!items.some(function (x) { return x.key === key; })) items.push({ prio: prio, key: key, title: title, detail: detail, refs: uniq(refs || []).slice(0, 4) }); }
    var F = A.F;
    var tc = A.claims.concat(A.criteria).filter(function (c) { return c.kind === 'tests'; });
    var lastRun = lastOf(F.checks.filter(function (k) { return k.kind === 'test'; }));
    var stale = tc.filter(function (c) { return c.stale; })[0];
    var conT = tc.filter(function (c) { return c.verdict === 'contradicted'; })[0];
    if (conT) add(100, 'tests', 'Run the tests yourself: the last run failed', conT.why, refsOf(conT));
    else if (stale) add(95, 'tests', 'Run the whole test suite yourself', stale.why, refsOf(stale));
    else if (tc.some(function (c) { return c.verdict === 'none'; })) add(80, 'tests', 'Run the tests yourself: none ran', 'The summary says the tests pass, but no test command ran in this run.', []);
    A.findings.forEach(function (f) {
      var prio = f.sev === 'high' ? 90 : f.sev === 'medium' ? 55 : 15;
      add(prio - items.length * 0.01, 'p:' + f.rule + ':' + f.n, f.rule === 'skip-test' ? f.title.replace(/^Skipped a test/, 'Un-skip the test') : f.title, 'Step ' + f.n + (f.path ? ', in ' + f.path : '') + '. ' + f.fix, [f.n]);
    });
    A.criteria.forEach(function (c) {
      if (c.verdict === 'contradicted' && c.kind === 'scope') add(85, 'scope', 'Check the changes outside the scope', c.why, refsOf(c));
      else if (c.verdict === 'contradicted' && c.kind !== 'noskip' && c.kind !== 'tests') add(78, 'crit:' + c.kind, 'Not met: ' + clip(c.text, 60), c.why, refsOf(c));
    });
    A.claims.forEach(function (c) {
      if (c.kind === 'tests') return;
      if (c.verdict === 'contradicted') add(80, 'claim:' + c.kind, CHECK_TITLE[c.kind] ? CHECK_TITLE[c.kind].con : 'Check: \u201c' + clip(c.quote, 50) + '\u201d', c.why, refsOf(c));
      else if (c.verdict === 'none') add(60, 'claim:' + c.kind, CHECK_TITLE[c.kind] ? CHECK_TITLE[c.kind].none : 'No receipt for \u201c' + clip(c.quote, 50) + '\u201d', c.why, refsOf(c));
      else if (c.verdict === 'partly') add(40, 'claim:' + c.kind, 'Only partly backed: \u201c' + clip(c.quote, 50) + '\u201d', c.why, refsOf(c));
    });
    A.errors.forEach(function (e) { add(75, 'err:' + e.n, 'Fix the error it walked past at step ' + e.n, (e.line ? '`' + clip(e.label, 70) + '` failed: ' + clip(e.line, 120) + '.' : '`' + clip(e.label, 70) + '` failed.') + ' Nothing after it fixed or re-ran it.', [e.n]); });
    items.sort(function (a, b) { return b.prio - a.prio; });
    var top = items.slice(0, 3);
    if (top.length < 3) {
      var changed = F.paths.map(function (p) { return p.path; });
      if (changed.length) top.push({ key: 'diff', title: 'Read the diff', detail: plural(changed.length, 'file') + ' changed: ' + names(changed, 5) + '. Proof checks the claims, not whether the code is right.', refs: F.paths.slice(0, 3).map(function (p) { return p.steps[0]; }) });
    }
    if (top.length < 3 && A.admissions.length) top.push({ key: 'admit', title: 'Follow up what it says it didn\u2019t do', detail: '\u201c' + clip(A.admissions[0], 160) + '\u201d', refs: run.final.slice(-1) });
    if (top.length < 3 && !A.criteria.length) top.push({ key: 'crit', title: 'Add acceptance criteria', detail: 'Write what "done" means, one line each ("unit tests pass", "no changes outside src/billing", "PR opened"), and Proof checks those too.', refs: [] });
    return top.slice(0, 3).map(function (x) { return { title: x.title, detail: x.detail, refs: x.refs }; });
  }
  var CHECK_TITLE = {
    fixed: { con: 'The fix is not shown to work', none: 'Nothing shows the fix' },
    files: { con: 'Look at every changed file, not just the ones it lists', none: 'Check which files changed' },
    paths: { con: 'A file it names was never changed', none: 'Check the files it names' },
    addtests: { con: 'The new tests it mentions are not there', none: 'Check the new tests exist' },
    lint: { con: 'Read the lint output it got', none: 'Run the linter yourself' },
    types: { con: 'Read the type errors', none: 'Run the type check yourself' },
    build: { con: 'The build failed', none: 'Run the build yourself' },
    noerrors: { con: 'Read the error it walked past', none: 'Check for errors' },
    verified: { con: 'Its own check failed', none: 'Nothing verified the change' },
    commit: { con: 'The commit did not go through', none: 'Check the commit exists' },
    push: { con: 'The push failed', none: 'Check the branch was pushed' },
    pr: { con: 'The PR number does not match', none: 'Check the pull request exists' },
    deploy: { con: 'The deploy failed', none: 'Check it was deployed' },
    migrate: { con: 'The migration failed', none: 'Check the migration ran' },
    coverage: { con: 'Coverage is lower than it says', none: 'Check the coverage figure' },
  };

  /** Read a run against its goal and criteria. Pure: the same run, goal and criteria always give the same answer. */
  function analyze(run, opts) {
    opts = opts || {};
    var F = facts(run);
    var A = { F: F, goal: clip(str(opts.goal !== undefined && opts.goal !== null ? opts.goal : run.goal).trim(), LIMITS.goalChars) };
    A.findings = suspicious(F);
    A.errors = unaddressed(F);
    var ex = extractClaims(run.finalText);
    A.sentences = ex.sentences;
    A.admissions = ex.admissions;
    A.claims = ex.claims.map(function (c) { var j = judge(F, A, run, c); Object.keys(j).forEach(function (k) { c[k] = j[k]; }); c.kindWord = KIND_WORD[c.kind] || c.kind; return c; });
    A.criteria = parseCriteria(opts.criteria).map(function (t, i) {
      var c = classifyCriterion(t);
      c.text = t; c.id = 'k' + (i + 1);
      var j = judge(F, A, run, c);
      Object.keys(j).forEach(function (k) { c[k] = j[k]; });
      c.kindWord = KIND_WORD[c.kind] || c.kind;
      return c;
    });
    A.verdict = verdictOf(A, run);
    A.changed = F.paths.map(function (p) { return { path: p.path, steps: p.steps, kinds: p.kinds, test: p.test, doc: p.doc }; });
    A.checksRun = F.checks.map(function (k) { return { n: k.n, kind: k.kind, ok: k.ok, short: runShort(k), subset: k.subset || null, hidden: k.hidden }; });
    return A;
  }
  function judge(F, A, run, c) {
    switch (c.kind) {
      case 'tests': return judgeTests(F, c);
      case 'lint': case 'types': case 'build': return judgeChecker(F, c.kind);
      case 'noerrors': return judgeNoErrors(F, A);
      case 'fixed': return judgeFixed(F, run, c);
      case 'verified': return judgeVerified(F);
      case 'files': return judgeFiles(F, run, c);
      case 'paths': return judgePaths(F, run, c);
      case 'addtests': return judgeAddTests(F, run, c);
      case 'commit': return judgeCommit(F, c);
      case 'push': return judgePush(F);
      case 'pr': return judgePR(F, c);
      case 'deploy': return judgeOps(F, 'deploy');
      case 'migrate': return judgeOps(F, 'migrate');
      case 'coverage': return judgeCoverage(F, c);
      case 'scope': return judgeScope(F, c);
      case 'noskip': return judgeNoSkip(F, A);
      default: return judgeManual(F, c);
    }
  }

  /* ---------------- exports ---------------- */

  function mdCode(s) {
    var t = str(s).replace(CTRL, '').replace(/[\r\n]+/g, ' ');
    var ticks = 1; while (t.indexOf(new Array(ticks + 1).join('`')) !== -1) ticks++;
    var fence = new Array(ticks + 1).join('`');
    return fence + (ticks > 1 || /^`|`$/.test(t) ? ' ' + t + ' ' : t) + fence;
  }
  function mdText(s) {
    return str(s).replace(CTRL, '').replace(/[\r\n]+/g, ' ')
      .replace(/[\\`*_{}[\]()#+!|>~]/g, '\\$&').replace(/</g, '&lt;').replace(/^(\s*)([-=])/, '$1\\$2').replace(/^(\s*\d+)\./, '$1\\.');
  }
  /** Markdown with `code` in a sentence kept as code. */
  function mdRich(s) { return str(s).split(/`([^`]{1,200})`/).map(function (part, i) { return i % 2 ? mdCode(part) : mdText(part); }).join(''); }
  /** A GitHub table cell: a | ends a cell even inside a code span, unless escaped. */
  function cell(md) { return str(md).replace(/\\\|/g, '\u0000').replace(/\|/g, '\\|').replace(/\u0000/g, '\\|'); }
  function stepsRef(refs) { return refs && refs.length ? ' (step' + (refs.length > 1 ? 's ' : ' ') + refs.join(', ') + ')' : ''; }
  function toMarkdown(A, run, when) {
    var v = A.verdict;
    var o = ['## Proof: did the agent do it?', '', '**' + mdText(v.outcome) + '**', '', 'Trust: **' + v.score + '/100** - ' + mdText(v.bandWord) + (when ? ' - checked ' + mdText(when) : ''), ''];
    if (A.goal) o.push('**Goal:** ' + mdText(clip(A.goal, 600)), '');
    if (v.checks.length) {
      o.push('### What to check before merging', '');
      v.checks.forEach(function (c, i) { o.push((i + 1) + '. **' + mdRich(c.title) + '** - ' + mdRich(c.detail) + mdText(stepsRef(c.refs))); });
      o.push('');
    }
    if (A.claims.length) {
      o.push('### Claims vs receipts', '', '| Claim | Verdict | Receipt |', '|---|---|---|');
      A.claims.forEach(function (c) { o.push('| ' + cell(mdRich('\u201c' + clip(c.quote, 90) + '\u201d')) + (c.hedged ? ' _(hedged)_' : '') + ' | **' + VERDICT_WORD[c.verdict] + '** | ' + cell(mdRich(clip(c.why, 260))) + mdText(stepsRef(refsOf(c))) + ' |'); });
      o.push('');
    } else o.push('_The summary makes no claim Proof can check._', '');
    if (A.criteria.length) {
      o.push('### Acceptance criteria', '');
      A.criteria.forEach(function (c) { o.push('- [' + (c.verdict === 'backed' ? 'x' : ' ') + '] ' + mdText(c.text) + ' - **' + (c.manual ? 'Check by hand' : VERDICT_WORD[c.verdict]) + '**: ' + mdRich(clip(c.why, 260)) + mdText(stepsRef(refsOf(c)))); });
      o.push('');
    }
    if (A.findings.length) {
      o.push('### Patterns worth a look', '');
      A.findings.slice(0, 20).forEach(function (f) { o.push('- **' + f.sev.charAt(0).toUpperCase() + f.sev.slice(1) + '** - ' + mdRich(f.title) + ' (step ' + f.n + (f.path ? ', ' + mdCode(f.path) : '') + ')' + (f.lines[0] ? ': ' + mdCode(clip(f.lines[0], 140)) : '')); });
      o.push('');
    }
    if (A.errors.length) {
      o.push('### Errors it kept going after', '');
      A.errors.slice(0, 10).forEach(function (e) { o.push('- Step ' + e.n + ': ' + mdCode(clip(e.label, 100)) + (e.line ? ' - ' + mdCode(clip(e.line, 140)) : '')); });
      o.push('');
    }
    if (A.admissions.length) {
      o.push('### What it says it did not do', '');
      A.admissions.forEach(function (a) { o.push('> ' + mdText(a)); o.push(''); });
    }
    o.push('_Checked with Proof: ' + mdText(run.formatWord) + ', ' + plural(run.steps.length, 'step') + ', ' + plural(A.changed.length, 'file') + ' changed. Read on the device; nothing was uploaded. Deterministic rules: a strong first look, not a guarantee._', '');
    return o.join('\n');
  }
  function toJson(A, run) {
    var out = {
      tool: 'Proof', checked: 'claims against the run\u2019s own receipts (deterministic rules, not a guarantee)',
      format: run.format, steps: run.steps.length, goal: A.goal,
      outcome: A.verdict.outcome, trust: { score: A.verdict.score, band: A.verdict.bandWord, reasons: A.verdict.reasons },
      whatToCheck: A.verdict.checks,
      claims: A.claims.map(function (c) { return { kind: c.kind, claim: c.quote, sentence: c.text, hedged: c.hedged, verdict: c.verdict, why: c.why, evidence: c.evidence }; }),
      criteria: A.criteria.map(function (c) { return { criterion: c.text, kind: c.kind, verdict: c.verdict, manual: Boolean(c.manual), why: c.why, evidence: c.evidence }; }),
      patterns: A.findings.map(function (f) { return { rule: f.rule, severity: f.sev, step: f.n, path: f.path, title: f.title, why: f.why, fix: f.fix, lines: f.lines }; }),
      errors: A.errors, saidItDidNotDo: A.admissions,
      changed: A.changed, checksRun: A.checksRun,
      skipped: run.skipped, notes: run.notes,
    };
    return JSON.stringify(out, null, 2) + '\n';
  }
  function summaryText(A, run) {
    var v = A.verdict;
    var s = 'Proof checked an agent run (' + run.formatWord + ', ' + plural(run.steps.length, 'step') + ') against its own receipts: ' + v.outcome + '. Trust ' + v.score + '/100 (' + v.bandWord.toLowerCase() + ').';
    var con = A.claims.filter(function (c) { return c.verdict === 'contradicted'; });
    if (con.length) s += ' Contradicted: ' + con.slice(0, 3).map(function (c) { return '\u201c' + clip(c.quote, 60) + '\u201d (' + clip(c.short || c.why, 90) + ')'; }).join('; ') + '.';
    if (v.checks.length) s += ' Before merging: ' + v.checks.map(function (c) { return c.title.replace(/`/g, '').replace(/^./, function (x) { return x.toLowerCase(); }); }).join('; ') + '.';
    return clean(s, 1400);
  }

  /* ---------------- the second opinion (metered, sent only after the person sees it) ---------------- */

  function snippetLines(s) {
    var L = [];
    if (s.kind === 'say' || s.kind === 'user') { str(s.text).split('\n').filter(function (l) { return l.trim(); }).slice(0, 8).forEach(function (l) { L.push(l); }); }
    else {
      L.push(stepLine(s));
      (s.changes || []).slice(0, 2).forEach(function (c) {
        var d = lineDiff(c.removed || '', c.added || '');
        d.removed.slice(0, 3).forEach(function (l) { L.push('- ' + l.trim()); });
        d.added.slice(0, 6).forEach(function (l) { L.push('+ ' + l.trim()); });
      });
      if (s.result) Object.keys(s.result).forEach(function (k) { var r = s.result[k]; (r.summary || []).concat(r.bad || []).slice(0, 4).forEach(function (l) { L.push(l); }); });
      if (s.err) L.push(s.err);
      if (s.commit) L.push(s.commit.line);
      if (s.prUrl) L.push(s.prUrl.text);
      if (L.length < 4 && s.out && !(s.changes && s.changes.length)) str(s.out).split('\n').filter(function (l) { return l.trim(); }).slice(-4).forEach(function (l) { L.push(l); });
      if (s.exit !== null && s.exit !== undefined) L.push('exit code ' + s.exit);
    }
    return uniq(L.filter(Boolean)).slice(0, LIMITS.opinionLines).map(function (l) { return shown(l, LIMITS.opinionLineChars); });
  }
  /** Exactly what "Second opinion" would send: the goal, the criteria, the claims and up to 40 snippets. Shown in full before anything leaves. */
  function opinionPayload(A, run) {
    var crit = A.criteria.map(function (c, i) { return { n: i + 1, text: clip(c.text, LIMITS.criterionChars), proof: c.manual ? 'manual' : c.verdict }; });
    if (!crit.length && A.goal) crit = [{ n: 1, text: clip('The goal: ' + A.goal.replace(/\s+/g, ' '), LIMITS.criterionChars), proof: null }];
    var want = [];
    function wantN(n) { if (n && want.indexOf(n) === -1) want.push(n); }
    A.criteria.forEach(function (c) { refsOf(c).forEach(wantN); });
    A.claims.forEach(function (c) { refsOf(c).forEach(wantN); });
    A.findings.forEach(function (f) { wantN(f.n); });
    A.errors.forEach(function (e) { wantN(e.n); });
    run.final.forEach(wantN);
    A.F.checks.forEach(function (k) { wantN(k.n); });
    A.F.changes.forEach(function (c) { wantN(c.n); });
    A.F.tools.forEach(function (s) { wantN(s.n); });
    var snippets = [];
    want.forEach(function (n) {
      if (snippets.length >= LIMITS.opinionSnippets) return;
      var s = A.F.byN[n];
      if (!s) return;
      var lines = snippetLines(s);
      if (!lines.length) return;
      snippets.push({ step: n, what: s.kind === 'tool' ? clean(s.tool, 40) + ': ' + clean(s.label, 120) : s.kind === 'say' ? 'The agent' + (s.final ? ' (final message)' : '') : 'The person', ok: s.kind === 'tool' ? s.ok : null, lines: lines });
    });
    snippets.sort(function (a, b) { return a.step - b.step; });
    var payload = {
      goal: clip(A.goal, LIMITS.goalChars),
      criteria: crit,
      claims: A.claims.slice(0, LIMITS.claims).map(function (c) { return { text: clip(c.quote, 160), kind: c.kind, proof: c.verdict }; }),
      snippets: snippets,
    };
    while (JSON.stringify(payload).length > LIMITS.opinionChars && payload.snippets.length > 1) payload.snippets.pop();
    return payload;
  }
  function textOut(v, max) { return typeof v === 'string' ? clean(v.replace(/<[^>]*>/g, '').replace(/[<>]/g, ''), max).trim() : ''; }
  var OP_VERDICTS = ['backed', 'partly', 'no-evidence', 'contradicted'];
  var OP_WORD = { backed: 'Backed', partly: 'Partly', 'no-evidence': 'No evidence', contradicted: 'Contradicted' };
  /** The model's answer, checked against what was sent: known criteria only, known verdicts only, step references that exist only. null when unusable. */
  function cleanJudgement(v, sent) {
    if (!v || typeof v !== 'object' || !sent) return null;
    var steps = {};
    (sent.snippets || []).forEach(function (s) { if (Number.isInteger(s.step)) steps[s.step] = 1; });
    var crit = sent.criteria || [];
    var seen = {}, out = [], dropped = 0;
    (Array.isArray(v.criteria) ? v.criteria : []).slice(0, 40).forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var raw = it.criterion !== undefined ? it.criterion : it.index !== undefined ? it.index : it.n;
      var i = typeof raw === 'number' ? raw : /^\d+$/.test(str(raw)) ? Number(raw) : NaN;
      if (!Number.isInteger(i) || i < 1 || i > crit.length || seen[i]) return;
      var verdict = OP_VERDICTS.indexOf(it.verdict) !== -1 ? it.verdict : null;
      var why = textOut(it.why, 600);
      if (!verdict || !why) return;
      seen[i] = 1;
      var refsIn = Array.isArray(it.evidenceRefs) ? it.evidenceRefs : [];
      var refs = uniq(refsIn.filter(function (n) { return typeof n === 'number' && Number.isInteger(n) && steps[n]; })).slice(0, 8);
      dropped += refsIn.length - refs.length;
      out.push({ n: i, text: crit[i - 1].text, verdict: verdict, why: why, evidenceRefs: refs, whatToCheck: textOut(it.whatToCheck, 300) });
    });
    if (!out.length) return null;
    out.sort(function (a, b) { return a.n - b.n; });
    return { criteria: out, overall: textOut(v.overall, 600), droppedRefs: dropped };
  }

  return {
    LIMITS: LIMITS, FORMAT_WORD: FORMAT_WORD, SKIP_WORD: SKIP_WORD, KIND_WORD: KIND_WORD, VERDICTS: VERDICTS, VERDICT_WORD: VERDICT_WORD, VERDICT_ICON: VERDICT_ICON,
    OP_VERDICTS: OP_VERDICTS, OP_WORD: OP_WORD, RULE_WHY: RULE_WHY, NOSKIP_RULES: NOSKIP_RULES, ACT_WORD: ACT_WORD,
    clean: clean, esc: esc, markInvisible: markInvisible, shown: shown, clip: clip, firstLine: firstLine, fmtInt: fmtInt, plural: plural, fmtMs: fmtMs, fmtBytes: fmtBytes, hashText: hashText, normPath: normPath,
    isTestPath: isTestPath, isDocPath: isDocPath, inScope: inScope, samePath: samePath,
    splitShell: splitShell, analyzeCommand: analyzeCommand, describe: describe, parseTests: parseTests, parseChecker: parseChecker,
    detect: detect, parseRun: parseRun,
    sentences: sentences, extractClaims: extractClaims, parseCriteria: parseCriteria, classifyCriterion: classifyCriterion,
    facts: facts, suspicious: suspicious, analyze: analyze,
    mdCode: mdCode, mdText: mdText, toMarkdown: toMarkdown, toJson: toJson, summaryText: summaryText,
    opinionPayload: opinionPayload, cleanJudgement: cleanJudgement,
  };
}));
