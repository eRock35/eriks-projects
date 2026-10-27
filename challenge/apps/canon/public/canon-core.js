/* Canon - the rules. One definition of every metric, and a check on every
 * SQL answer that uses it.
 *
 * UMD: window.CanonCore in the page, require() in the server and the tests.
 * Everything that decides a verdict lives here, so the page, the server's
 * validation and the tests run the same code. No clock, no dice, no network
 * and no storage: anything that needs "today" is handed it.
 *
 * What is in here, top to bottom:
 *   - text cleaning and escaping (the one door every typed string goes through)
 *   - a small SQL tokenizer (comments, quoted identifiers in four dialects,
 *     strings with doubled quotes or backslashes, dollar quotes, templates)
 *   - a loose structural parser: WITH, SELECT, FROM/JOIN trees, derived
 *     tables, WHERE / GROUP BY / HAVING, UNION branches, subqueries
 *   - column resolution through aliases, CTEs and derived tables to the base
 *     table that was scanned
 *   - predicates normalised so equivalent filters compare equal
 *     (= false, IS FALSE, NOT x, <> true)
 *   - the checks: source, aggregation, required filters, date column, time
 *     zone, date range (and the BETWEEN trap), grain and fan-out, dimensions
 *   - the verdict line and a deterministic fix where it is safe
 *   - question -> metric matching, and the period a question asks for
 *   - schema text (DDL, describe output, column lists) read into notes
 *   - the canon's own cleaning, merge, import and the three exports
 *   - the two AI calls' requests and answers, cleaned
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CanonCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    sqlChars: 60000, questionChars: 400, tokens: 20000,
    canonNameChars: 80, metrics: 60, nameChars: 60, synonyms: 12, synonymChars: 40,
    meaningChars: 600, ownerChars: 60, metricTables: 8, identChars: 120, measureChars: 400,
    filters: 12, filterChars: 300, keepsOutChars: 60, dims: 30, grainChars: 60, trapsChars: 1000, tzChars: 40,
    schemaTables: 80, columns: 300, tableGrainChars: 120, relationships: 120,
    schemaTextChars: 200000, importChars: 1000000,
    draftMetrics: 12, businessChars: 400, explainSqlChars: 20000, explainMetrics: 5, explainChecks: 40,
    shareDays: [7, 30, 90], sharesOpen: 10,
  };

  var VERDICTS = ['match', 'missing', 'different', 'unsure'];
  var VERDICT_WORD = { match: 'Matches', missing: 'Missing', different: 'Different', unsure: 'Can\u2019t tell' };
  var VERDICT_ICON = { match: '\u2713', missing: '\u2717', different: '\u2260', unsure: '?' };

  /* ================================================================== *
   * Text: one door for every string a person, a file or a model wrote
   * ================================================================== */

  // Control characters, bidi overrides and zero-width characters. Tabs and
  // line breaks are kept; everything here is invisible or reorders text.
  var BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  function strip(v) { return str(v).replace(/\r\n?/g, '\n').replace(BAD, ''); }
  function clip(s, n) { return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).replace(/\s+$/, '') + '\u2026'; }
  /** One line: no breaks, single spaces, bounded. */
  function line(v, n) { return clip(strip(v).replace(/\s+/g, ' ').trim(), n || 200); }
  /** A paragraph: breaks kept (two in a row at most), bounded. */
  function para(v, n) { return clip(strip(v).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), n || 1000); }
  /** SQL written into a definition: breaks kept; too long is refused, never cut. */
  function sqlText(v, n) { var s = strip(v).replace(/\t/g, '  ').trim(); return s.length > n ? '' : s; }
  /** Markup a model might send, removed (escaping on render is the real guard). */
  function noMarkup(s) { return s.replace(/<\/?[a-z][^<>]{0,200}>/gi, '').replace(/javascript:/gi, ''); }
  /** Escaped for HTML: invisible characters dropped, quotes escaped too. */
  function esc(v) { return strip(v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function plural(n, w, ws) { return n + ' ' + (n === 1 ? w : (ws || w + 's')); }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function words(list) { return list.length <= 1 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1]; }
  function setOf(list) { var o = Object.create(null); list.split(' ').forEach(function (w) { if (w) o[w] = 1; }); return o; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /* ================================================================== *
   * The tokenizer
   * ================================================================== */

  var WORD = /[A-Za-z_\u00C0-\uFFFF][A-Za-z0-9_$#\u00C0-\uFFFF]*/y;
  var NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
  var DOLLAR = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;
  var PARAM = /(?:\$\d+|\$[A-Za-z_][A-Za-z0-9_]*|:[A-Za-z_][A-Za-z0-9_]*|@@?[A-Za-z_][A-Za-z0-9_$]*)/y;
  var OPS = ['<=>', '->>', '#>>', '!~*', '::', '<>', '!=', '>=', '<=', '||', '->', '=>', '==', ':=', '!~', '~*', '#>', '&&', '<<', '>>', '@>', '<@'];
  var PREFIXED = /^(e|n|x|b|r|u|br|rb|nr)$/i;

  var RESERVED = setOf('select from where and or not null is in between like ilike rlike regexp similar case when then else end as on join inner left right full outer cross natural using group by having order limit offset fetch union intersect except minus distinct with recursive exists any some all true false interval asc desc nulls over partition qualify lateral apply top values escape collate into window at zone unknown semi anti asof straight_join global');
  var JOINWORD = setOf('join inner left right full outer cross natural straight_join apply semi anti asof global');
  var VALUEWORD = setOf('current_date current_timestamp current_time localtimestamp localtime sysdate systimestamp getdate getutcdate now today sysdatetime current_datetime unix_timestamp');
  var TYPEWORD = setOf('date datetime timestamp timestamptz timestamp_tz timestamp_ntz timestamp_ltz time int integer bigint smallint numeric decimal number float double real text varchar char string boolean bool');
  var DATEPART = setOf('year quarter month week day hour minute second millisecond microsecond dow doy epoch isoweek isoyear dayofweek dayofyear weekday yy yyyy mm dd qq wk ww hh mi ss ms date');
  var AGG = {
    sum: 'sum', count: 'count', avg: 'avg', mean: 'avg', min: 'min', max: 'max', count_big: 'count',
    countif: 'count', count_if: 'count', sumif: 'sum', sum_if: 'sum', avgif: 'avg',
    approx_count_distinct: 'countd', approx_distinct: 'countd', count_distinct: 'countd', uniq: 'countd', uniqexact: 'countd', ndv: 'countd',
    median: 'other', stddev: 'other', stddev_pop: 'other', stddev_samp: 'other', variance: 'other', percentile_cont: 'other', percentile_disc: 'other',
    array_agg: 'list', string_agg: 'list', listagg: 'list', group_concat: 'list', bool_and: 'other', bool_or: 'other', any_value: 'other', max_by: 'other', min_by: 'other',
  };
  var AGG_WORD = { sum: 'SUM', count: 'COUNT', countd: 'COUNT(DISTINCT)', avg: 'AVG', min: 'MIN', max: 'MAX', other: 'another aggregate', list: 'a list aggregate' };
  var DATEFN = setOf('date_trunc datetime_trunc timestamp_trunc trunc date datetime extract date_part datepart year month quarter week day dayofweek dayofmonth to_char format_date format_timestamp format_datetime strftime date_format to_date last_day isoweek yearweek tostartofmonth tostartofweek tostartofday tostartofquarter tostartofyear todate');
  var CMP = { '=': 1, '==': 1, '<>': 1, '!=': 1, '<': 1, '<=': 1, '>': 1, '>=': 1, '<=>': 1 };

  function readQuoted(s, i, q, backslash) {
    var n = s.length, j = i + 1, out = '';
    while (j < n) {
      var c = s[j];
      if (backslash && c === '\\' && j + 1 < n) { out += s[j + 1]; j += 2; continue; }
      if (c === q) {
        if (s[j + 1] === q) { out += q; j += 2; continue; }
        return { end: j + 1, value: out, ok: true };
      }
      out += c; j++;
    }
    return { end: n, value: out, ok: false };
  }

  /** SQL text -> tokens {t, v (as written), n (normalised), s, e}. Comments
   *  and whitespace are dropped (comments are kept as ranges). Never throws:
   *  an unterminated string or comment runs to the end and is noted. */
  function tokenize(src) {
    var s = str(src), n = s.length, i = 0, toks = [], comments = [], problems = [];
    function add(t, a, b, v) { toks.push({ t: t, v: s.slice(a, b), n: v, s: a, e: b }); }
    while (i < n) {
      if (toks.length >= LIMITS.tokens) { problems.push('long'); break; }
      var ch = s[i];
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00A0' || ch === '\u3000') { i++; continue; }
      if (ch === '-' && s[i + 1] === '-') {
        var le = s.indexOf('\n', i); if (le < 0) le = n;
        comments.push({ s: i, e: le }); i = le; continue;
      }
      if (ch === '/' && s[i + 1] === '*') {
        var d = 1, j = i + 2;
        while (j < n && d) {
          if (s[j] === '/' && s[j + 1] === '*') { d++; j += 2; } else if (s[j] === '*' && s[j + 1] === '/') { d--; j += 2; } else j++;
        }
        if (d) problems.push('comment');
        comments.push({ s: i, e: j }); i = j; continue;
      }
      if (ch === '#') {
        if (/[A-Za-z_]/.test(s[i + 1] || '')) { // a T-SQL temp table: #orders
          WORD.lastIndex = i + 1; var tw = WORD.exec(s);
          add('word', i, i + 1 + tw[0].length, ('#' + tw[0]).toLowerCase()); i += 1 + tw[0].length; continue;
        }
        if (s[i + 1] !== '>') { var he = s.indexOf('\n', i); if (he < 0) he = n; comments.push({ s: i, e: he }); i = he; continue; }
      }
      if (ch === "'" || ch === '"') {
        if (s.substr(i, 3) === ch + ch + ch && s[i + 3] !== ch) { // BigQuery triple quotes
          var close3 = s.indexOf(ch + ch + ch, i + 3), end3 = close3 < 0 ? n : close3 + 3;
          add('string', i, end3, s.slice(i + 3, close3 < 0 ? n : close3));
          if (close3 < 0) problems.push('string');
          i = end3; continue;
        }
        var r = readQuoted(s, i, ch, false);
        // MySQL / BigQuery escape a quote with a backslash: 'O\'Brien'. Read
        // that way when the standard reading never closes, or closes on a
        // backslash with a word running straight on.
        if (ch === "'" && (!r.ok || (/\\$/.test(r.value) && /[A-Za-z0-9_]/.test(s[r.end] || '')))) { var r2 = readQuoted(s, i, ch, true); if (r2.ok) r = r2; }
        if (!r.ok) problems.push(ch === "'" ? 'string' : 'ident');
        // A double-quoted date or time zone is a string (BigQuery, MySQL):
        // nobody names a column "2026-07-01" or "America/New_York".
        var dqString = ch === '"' && (/^\d{4}-\d{2}-\d{2}/.test(r.value) || /^[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(r.value));
        add(ch === "'" || dqString ? 'string' : 'qident', i, r.end, r.value);
        if (ch === '"') toks[toks.length - 1].dq = true;
        i = r.end; continue;
      }
      if (ch === '`') {
        var rb = readQuoted(s, i, '`', false);
        if (!rb.ok) problems.push('ident');
        add('qident', i, rb.end, rb.value); i = rb.end; continue;
      }
      if (ch === '[') {
        var cb = s.indexOf(']', i + 1), inner = cb > 0 ? s.slice(i + 1, cb) : null, pv = toks[toks.length - 1];
        // arr[1] is a subscript; [dbo].[orders] [o] are T-SQL names
        var subscript = pv && pv.e === i && ((pv.t === 'word' && !RESERVED[pv.n]) || (pv.t === 'qident' && pv.v.charAt(0) !== '[') || (pv.t === 'punct' && (pv.v === ')' || pv.v === ']')));
        if (inner !== null && !subscript && /^[^\[\]\n,']{1,128}$/.test(inner) && !/^\s*[-\d]/.test(inner)) { add('qident', i, cb + 1, inner); i = cb + 1; continue; }
        add('punct', i, i + 1, '['); i++; continue;
      }
      if (ch === '$') {
        DOLLAR.lastIndex = i; var dm = DOLLAR.exec(s);
        if (dm) {
          var tag = dm[0], dc = s.indexOf(tag, i + tag.length), de = dc < 0 ? n : dc + tag.length;
          add('string', i, de, s.slice(i + tag.length, dc < 0 ? n : dc));
          if (dc < 0) problems.push('string');
          i = de; continue;
        }
        if (s[i + 1] === '{') { var cl = s.indexOf('}', i), ce = cl < 0 ? n : cl + 1; add('param', i, ce, s.slice(i, ce)); i = ce; continue; }
      }
      if (ch === '{' && (s[i + 1] === '{' || s[i + 1] === '%' || s[i + 1] === '#')) { // dbt / Jinja
        var closer = s[i + 1] === '{' ? '}}' : s[i + 1] + '}', tc = s.indexOf(closer, i + 2), te = tc < 0 ? n : tc + 2;
        add('template', i, te, s.slice(i + 2, tc < 0 ? n : tc).trim()); i = te; continue;
      }
      var prevTok = toks[toks.length - 1];
      if ((ch >= '0' && ch <= '9') || (ch === '.' && /[0-9]/.test(s[i + 1] || '') && !(prevTok && (prevTok.t === 'word' || prevTok.t === 'qident' || prevTok.v === ')')))) {
        NUMBER.lastIndex = i; var nm = NUMBER.exec(s);
        add('number', i, i + nm[0].length, Number(nm[0])); i += nm[0].length; continue;
      }
      WORD.lastIndex = i; var wm = WORD.exec(s);
      if (wm) {
        var w = wm[0], we = i + w.length;
        if (s[we] === "'" && PREFIXED.test(w)) { // E'..', N'..', X'..', r'..'
          var rp = readQuoted(s, we, "'", /^e$/i.test(w));
          if (!rp.ok) problems.push('string');
          add('string', i, rp.end, rp.value); i = rp.end; continue;
        }
        add('word', i, we, w.toLowerCase()); i = we; continue;
      }
      if ((ch === ':' && /[A-Za-z_]/.test(s[i + 1] || '') && !(prevTok && prevTok.v === ':')) || ch === '@' || (ch === '$' && /[A-Za-z0-9_]/.test(s[i + 1] || ''))) {
        PARAM.lastIndex = i; var pm = PARAM.exec(s);
        if (pm) { add('param', i, i + pm[0].length, pm[0]); i += pm[0].length; continue; }
      }
      if (ch === '?') { add('param', i, i + 1, '?'); i++; continue; }
      var op = null;
      for (var k = 0; k < OPS.length; k++) if (s.startsWith(OPS[k], i)) { op = OPS[k]; break; }
      if (op) { add('op', i, i + op.length, op); i += op.length; continue; }
      if ('(),;.]{}:'.indexOf(ch) >= 0) { add('punct', i, i + 1, ch); i++; continue; }
      add('op', i, i + 1, ch); i++;
    }
    return { tokens: toks, comments: comments, problems: problems };
  }

  /* ================================================================== *
   * The parser: a loose structure, enough to know what reads what
   * ================================================================== */

  function isW(t, w) { return Boolean(t) && t.t === 'word' && t.n === w; }
  function isP(t, p) { return Boolean(t) && t.t === 'punct' && t.v === p; }
  function isName(t) { return Boolean(t) && (t.t === 'qident' || (t.t === 'word' && !RESERVED[t.n])); }
  function idKey(t) { return t.t === 'qident' ? String(t.n).toLowerCase() : t.n; }

  function pairs(T) {
    var p = new Array(T.length), st = [];
    for (var i = 0; i < T.length; i++) {
      var t = T[i];
      if (t.t !== 'punct') continue;
      if (t.v === '(' || t.v === '[') st.push(i);
      else if ((t.v === ')' || t.v === ']') && st.length) { var o = st.pop(); p[o] = i; p[i] = o; }
    }
    while (st.length) p[st.pop()] = T.length;
    return p;
  }

  function skipCase(A, i, e) {
    var T = A.T, d = 0;
    while (i < e) {
      var t = T[i];
      if (isP(t, '(') || isP(t, '[')) { i = Math.min(A.pair[i], e) + 1; continue; }
      if (isW(t, 'case')) d++;
      else if (isW(t, 'end')) { d--; if (d <= 0) return i + 1; }
      i++;
    }
    return e;
  }

  /** Call fn(i, token) for each token at depth 0 of [s, e), stepping over
   *  parentheses and CASE ... END. fn returns true to stop; returns where. */
  function topScan(A, s, e, fn) {
    var T = A.T, i = s;
    while (i < e) {
      var t = T[i];
      if (isP(t, '(') || isP(t, '[')) { i = Math.min(A.pair[i], e) + 1; continue; }
      if (isW(t, 'case')) { if (fn(i, t)) return i; i = skipCase(A, i, e); continue; }
      if (fn(i, t)) return i;
      i++;
    }
    return -1;
  }
  function splitTop(A, s, e, sep) {
    var out = [], start = s;
    topScan(A, s, e, function (i, t) { if (isP(t, sep)) { out.push([start, i]); start = i + 1; } return false; });
    if (e > start) out.push([start, e]);
    return out;
  }
  /** Split at a top-level AND or OR, keeping BETWEEN x AND y whole. */
  function splitBool(A, s, e, word) {
    var parts = [], start = s, between = 0;
    topScan(A, s, e, function (i, t) {
      if (isW(t, 'between')) between++;
      else if (isW(t, 'and') && between) { between--; return false; }
      if (isW(t, word)) { parts.push([start, i]); start = i + 1; }
      return false;
    });
    parts.push([start, e]);
    return parts.filter(function (p) { return p[1] > p[0]; });
  }
  function stripParens(A, s, e) {
    while (s < e - 1 && isP(A.T[s], '(') && A.pair[s] === e - 1 && !A.subAt[s]) { s++; e--; }
    return [s, e];
  }

  /** Read a dotted name: a.b.c, "Sch"."T", `proj.ds.t`, [dbo].[t]. */
  function readName(A, i, e) {
    var T = A.T, parts = [], j = i;
    while (j < e && (T[j].t === 'word' || T[j].t === 'qident')) {
      var t = T[j];
      if (t.t === 'qident') String(t.n).split('.').forEach(function (p) { if (p) parts.push(p.toLowerCase()); });
      else parts.push(t.n);
      if (isP(T[j + 1], '.') && T[j + 2] && (T[j + 2].t === 'word' || T[j + 2].t === 'qident')) { j += 2; continue; }
      j++; break;
    }
    return { parts: parts, end: j };
  }

  function parseQuery(A, s, e, parentSel, outer) {
    var T = A.T, q = { type: 'query', s: s, e: e, ctes: [], selects: [], parent: parentSel || null, outer: outer || null };
    A.queries.push(q);
    var i = s;
    if (isW(T[i], 'with')) {
      i++;
      if (isW(T[i], 'recursive')) i++;
      while (i < e) {
        var nt = T[i];
        if (!nt || !(nt.t === 'word' || nt.t === 'qident')) break;
        i++;
        if (isP(T[i], '(')) i = A.pair[i] + 1;
        if (!isW(T[i], 'as')) break;
        i++;
        if (isW(T[i], 'not')) i++;
        if (isW(T[i], 'materialized')) i++;
        if (!isP(T[i], '(')) break;
        var close = A.pair[i];
        if (close > e) close = e;
        var cq = parseQuery(A, i + 1, close, parentSel, q);
        cq.cteName = idKey(nt);
        q.ctes.push({ key: idKey(nt), name: nt.v, query: cq, at: nt.s });
        i = close + 1;
        if (isP(T[i], ',')) { i++; continue; }
        break;
      }
    }
    // UNION / INTERSECT / EXCEPT branches
    var start = i, ranges = [];
    topScan(A, i, e, function (k, t) {
      if (t.t === 'word' && (t.n === 'union' || t.n === 'intersect' || t.n === 'except' || t.n === 'minus')) {
        ranges.push([start, k]);
        start = k + 1;
        if (T[start] && (isW(T[start], 'all') || isW(T[start], 'distinct'))) start++;
      }
      return false;
    });
    ranges.push([start, e]);
    ranges.forEach(function (r) { parsePart(A, q, r[0], r[1], parentSel); });
    return q;
  }
  function parsePart(A, q, a, b, parentSel) {
    var T = A.T;
    if (a >= b) return;
    if (isP(T[a], '(')) {
      var c = A.pair[a];
      if (c < b) {
        if (isW(T[a + 1], 'with')) { var iq = parseQuery(A, a + 1, c, parentSel, q); iq.selects.forEach(function (x) { q.selects.push(x); }); return; }
        return parsePart(A, q, a + 1, c, parentSel);
      }
    }
    if (isW(T[a], 'select')) q.selects.push(parseSelect(A, a, b, q));
    else if (isW(T[a], 'with')) { var wq = parseQuery(A, a, b, parentSel, q); wq.selects.forEach(function (x) { q.selects.push(x); }); }
  }

  var CLAUSE_ONE = setOf('from where having qualify limit offset fetch window');
  function parseSelect(A, s, e, q) {
    var T = A.T;
    var sel = { type: 'select', s: s, e: e, query: q, items: [], sources: [], flat: [], where: null, groupBy: [], groupAll: false, having: null, from: null, id: A.selects.length, subs: [] };
    A.selects.push(sel);
    var marks = [], seen = {};
    topScan(A, s + 1, e, function (i, t) {
      if (t.t !== 'word') return false;
      var k = t.n, body = i + 1;
      if (k === 'from' && isW(T[i - 1], 'distinct') && (isW(T[i - 2], 'is') || isW(T[i - 2], 'not'))) return false;
      if ((k === 'group' || k === 'order') && isW(T[i + 1], 'by')) body = i + 2;
      else if (!CLAUSE_ONE[k]) return false;
      if (seen[k]) return false;
      seen[k] = 1;
      marks.push({ k: k, i: i, body: body });
      return false;
    });
    var ends = function (m, idx) { return idx + 1 < marks.length ? marks[idx + 1].i : e; };
    var listEnd = marks.length ? marks[0].i : e;
    // the select list
    var i = s + 1;
    if (isW(T[i], 'distinct')) { sel.distinct = true; i++; if (isW(T[i], 'on') && isP(T[i + 1], '(')) i = A.pair[i + 1] + 1; }
    else if (isW(T[i], 'all')) i++;
    if (isW(T[i], 'top')) { i++; if (isP(T[i], '(')) i = A.pair[i] + 1; else i++; if (isW(T[i], 'percent')) i++; if (isW(T[i], 'with') && isW(T[i + 1], 'ties')) i += 2; }
    if (isW(T[i], 'as') && T[i + 1] && T[i + 1].t === 'word' && (T[i + 1].n === 'struct' || T[i + 1].n === 'value')) i += 2;
    splitTop(A, i, listEnd, ',').forEach(function (r) { sel.items.push(parseItem(A, r[0], r[1])); });
    marks.forEach(function (m, idx) {
      var b = ends(m, idx);
      if (m.k === 'from') { sel.from = { s: m.body, e: b }; sel.sources = parseFrom(A, m.body, b, sel); }
      else if (m.k === 'where') sel.where = { s: m.body, e: b, kw: m.i };
      else if (m.k === 'group') {
        if (isW(T[m.body], 'all') && m.body + 1 >= b) { sel.groupAll = true; return; }
        splitTop(A, m.body, b, ',').forEach(function (r) {
          var t0 = T[r[0]];
          if (t0 && t0.t === 'word' && (t0.n === 'rollup' || t0.n === 'cube') && isP(T[r[0] + 1], '(')) {
            splitTop(A, r[0] + 2, A.pair[r[0] + 1], ',').forEach(function (x) { sel.groupBy.push({ s: x[0], e: x[1] }); });
          } else if (isW(t0, 'grouping') && isW(T[r[0] + 1], 'sets')) {
            for (var gi = r[0] + 2; gi < r[1]; gi++) if (T[gi].t === 'word' || T[gi].t === 'qident') { var rn = readName(A, gi, r[1]); sel.groupBy.push({ s: gi, e: rn.end }); gi = rn.end - 1; }
          } else sel.groupBy.push({ s: r[0], e: r[1] });
        });
      } else if (m.k === 'having') sel.having = { s: m.body, e: b };
    });
    flatten(sel);
    // subqueries in expressions: the list, WHERE, GROUP BY, HAVING, every ON
    var ranges = [[s + 1, listEnd]];
    if (sel.where) ranges.push([sel.where.s, sel.where.e]);
    if (sel.having) ranges.push([sel.having.s, sel.having.e]);
    sel.flat.forEach(function (src) { if (src.on) ranges.push([src.on.s, src.on.e]); });
    ranges.forEach(function (r, k) { findSubs(A, sel, r[0], r[1], k === 0); });
    return sel;
  }
  function findSubs(A, sel, s, e, inList) {
    var T = A.T;
    for (var i = s; i < e; i++) {
      if (isP(T[i], '(') && (isW(T[i + 1], 'select') || isW(T[i + 1], 'with')) && !A.subAt[i]) {
        var c = Math.min(A.pair[i], e);
        var sq = parseQuery(A, i + 1, c, sel, sel.query);
        sq.expr = true;
        A.subAt[i] = sq;
        sel.subs.push({ s: i, e: c + 1, query: sq, inList: Boolean(inList) });
        i = c;
      }
    }
  }

  function parseItem(A, s, e) {
    var T = A.T, it = { s: s, e: e, exprS: s, exprE: e, alias: null, aliasKey: null, star: false, single: null };
    if (e - s === 1 && T[s].t === 'op' && T[s].v === '*') { it.star = true; return it; }
    if (e - s === 3 && isName(T[s]) && isP(T[s + 1], '.') && T[s + 2].v === '*') { it.star = true; it.starQual = idKey(T[s]); return it; }
    var last = T[e - 1], prev = T[e - 2];
    if (e - s >= 3 && isW(prev, 'as') && (last.t === 'word' || last.t === 'qident' || last.t === 'string')) {
      it.alias = last.v; it.aliasKey = last.t === 'string' ? String(last.n).toLowerCase() : idKey(last); it.exprE = e - 2; it.aliasTok = e - 1;
    } else if (e - s >= 2 && (last.t === 'qident' || (last.t === 'word' && !RESERVED[last.n])) && prev && !isP(prev, '.') && !isP(prev, '(') && !isP(prev, ',') && prev.t !== 'op'
      && !(prev.t === 'word' && (RESERVED[prev.n] && prev.n !== 'end'))) {
      it.alias = last.v; it.aliasKey = idKey(last); it.exprE = e - 1; it.aliasTok = e - 1;
    }
    var rn = (T[it.exprS].t === 'word' || T[it.exprS].t === 'qident') ? readName(A, it.exprS, it.exprE) : null;
    if (rn && rn.end === it.exprE && !RESERVED[T[it.exprS].n] && !isP(T[rn.end], '(')) it.single = { parts: rn.parts, col: rn.parts[rn.parts.length - 1] };
    return it;
  }

  function findJoinEnd(A, s, e) {
    var T = A.T;
    var at = topScan(A, s, e, function (i, t) {
      if (isP(t, ',')) return true;
      if (t.t === 'word' && JOINWORD[t.n] && !((t.n === 'left' || t.n === 'right') && isP(T[i + 1], '('))) return true;
      return false;
    });
    return at < 0 ? e : at;
  }
  var ALIAS_STOP = setOf('where group order limit on using with tablesample for qualify window pivot unpivot having union intersect except minus offset fetch');
  function parseFrom(A, s, e, sel) {
    var T = A.T, out = [], i = s, join = 'from';
    var guard = 0;
    while (i < e && guard++ < 5000) {
      var t = T[i];
      if (isP(t, ',')) { join = 'comma'; i++; continue; }
      if (t.t === 'word' && JOINWORD[t.n] && !((t.n === 'left' || t.n === 'right') && isP(T[i + 1], '('))) {
        var kind = null, j = i, applied = false;
        while (j < e && T[j].t === 'word' && JOINWORD[T[j].n]) {
          var w = T[j].n;
          if (!kind && (w === 'left' || w === 'right' || w === 'full' || w === 'cross' || w === 'inner' || w === 'outer')) kind = w;
          j++;
          if (w === 'join' || w === 'straight_join') break;
          if (w === 'apply') { applied = true; break; }
        }
        join = applied ? (kind === 'outer' ? 'left' : 'inner') : (kind === 'outer' || !kind ? 'inner' : kind);
        i = j; continue;
      }
      var src = { kind: 'table', join: join, s: i, sel: sel, parts: [], key: '', alias: null, aliasKey: null, on: null, using: null, optional: false };
      if (isW(T[i], 'lateral')) i++;
      if (isP(T[i], '(')) {
        var close = Math.min(A.pair[i], e);
        if (isW(T[i + 1], 'select') || isW(T[i + 1], 'with') || (isP(T[i + 1], '(') && (isW(T[i + 2], 'select') || isW(T[i + 2], 'with')))) {
          src.kind = 'derived';
          src.query = parseQuery(A, i + 1, close, sel, sel.query);
        } else if (isW(T[i + 1], 'values')) src.kind = 'values';
        else { src.kind = 'group'; src.inner = parseFrom(A, i + 1, close, sel); }
        i = close + 1;
      } else if (T[i].t === 'template') {
        var tm = /^(?:ref|source)\s*\(([^)]*)\)/.exec(String(T[i].n)), args0 = tm ? (tm[1].match(/['"]([^'"]+)['"]/g) || []) : [];
        var tname = args0.length ? args0[args0.length - 1].slice(1, -1) : String(T[i].n);
        src.parts = tname.toLowerCase().split('.'); src.key = src.parts[src.parts.length - 1]; src.nameS = i; src.nameE = i + 1; src.template = true;
        i++;
      } else if (T[i].t === 'word' || T[i].t === 'qident') {
        var nm = readName(A, i, e);
        src.parts = nm.parts; src.key = nm.parts[nm.parts.length - 1] || ''; src.nameS = i; src.nameE = nm.end;
        i = nm.end;
        if (isP(T[i], '(')) { src.kind = 'func'; i = Math.min(A.pair[i], e) + 1; }
      } else { i++; continue; }
      if (isW(T[i], 'as')) i++;
      if (T[i] && i < e && (T[i].t === 'qident' || (T[i].t === 'word' && !RESERVED[T[i].n] && !JOINWORD[T[i].n] && !ALIAS_STOP[T[i].n]))) {
        src.alias = T[i].v; src.aliasKey = idKey(T[i]); src.aliasTok = i; i++;
        if (isP(T[i], '(')) i = Math.min(A.pair[i], e) + 1;
      }
      if (isW(T[i], 'with') && isP(T[i + 1], '(')) i = Math.min(A.pair[i + 1], e) + 1;
      if (isW(T[i], 'tablesample')) { i++; while (i < e && T[i].t === 'word') i++; if (isP(T[i], '(')) i = Math.min(A.pair[i], e) + 1; }
      if (isW(T[i], 'for') && isW(T[i + 1], 'system_time')) i = findJoinEnd(A, i, e);
      if (isW(T[i], 'on')) { var oe = findJoinEnd(A, i + 1, e); src.on = { s: i + 1, e: oe }; i = oe; }
      else if (isW(T[i], 'using') && isP(T[i + 1], '(')) {
        var uc = Math.min(A.pair[i + 1], e);
        src.using = splitTop(A, i + 2, uc, ',').map(function (r) { return idKey(T[r[0]]); });
        i = uc + 1;
      }
      src.e = i;
      out.push(src);
      join = null;
    }
    return out;
  }
  function flatten(sel) {
    var flat = [];
    (function walk(list) {
      list.forEach(function (src, k) {
        if (src.kind === 'group') {
          var first = flat.length;
          walk(src.inner || []);
          if (flat[first]) { flat[first].join = src.join || flat[first].join; if (src.on) flat[first].groupOn = src.on; }
          if (src.on) flat.push({ kind: 'onlyon', on: src.on, sel: sel, join: src.join });
          return;
        }
        flat.push(src);
      });
    }(sel.sources));
    var real = flat.filter(function (x) { return x.kind !== 'onlyon'; });
    real.forEach(function (src, k) {
      if (src.join === 'left') src.optional = true;
      if (src.join === 'right' || src.join === 'full') { for (var b = 0; b < k; b++) real[b].optional = true; if (src.join === 'full') src.optional = true; }
    });
    sel.flat = real;
    sel.onOnly = flat.filter(function (x) { return x.kind === 'onlyon'; });
  }

  /** Bind CTE references to their bodies. */
  function bind(A) {
    A.selects.forEach(function (sel) {
      sel.flat.forEach(function (src) {
        if (src.kind !== 'table' || src.parts.length !== 1) return;
        for (var q = sel.query; q; q = q.outer) {
          for (var k = 0; k < q.ctes.length; k++) {
            var c = q.ctes[k];
            if (c.key !== src.key) continue;
            if (isAncestor(c.query, sel.query)) continue; // a recursive CTE's own name
            src.kind = 'cte'; src.query = c.query; src.cteName = c.key;
            return;
          }
        }
      });
    });
  }
  function isAncestor(q, inner) { for (var x = inner; x; x = x.outer) if (x === q) return true; return false; }

  /** Clean pasted SQL: line breaks normalised, invisible characters removed
   *  (and counted - they can hide what a query does). */
  function cleanSql(v) {
    var raw = str(v).replace(/\r\n?/g, '\n');
    var found = raw.match(BAD);
    return { text: raw.replace(BAD, ''), invisible: found ? found.length : 0 };
  }

  /** Parse SQL into the analysis context every check works on. */
  function parseSql(sqlIn, canon) {
    var c = cleanSql(sqlIn);
    var tk = tokenize(c.text);
    var A = { src: c.text, T: tk.tokens, comments: tk.comments, problems: tk.problems, invisible: c.invisible, pair: null, subAt: {}, queries: [], selects: [], root: null, notes: [], schema: schemaIndex(canon) };
    A.pair = pairs(A.T);
    var T = A.T, stmts = [], st = 0;
    for (var i = 0; i < T.length; i++) {
      if (isP(T[i], '(')) { i = A.pair[i]; continue; }
      if (isP(T[i], ';')) { if (i > st) stmts.push([st, i]); st = i + 1; }
    }
    if (T.length > st) stmts.push([st, T.length]);
    var starts = function (r) { var t = T[r[0]]; return isW(t, 'select') || isW(t, 'with') || (isP(t, '(') && (isW(T[r[0] + 1], 'select') || isW(T[r[0] + 1], 'with'))); };
    var cands = stmts.filter(starts);
    var hasAgg = function (r) { for (var k = r[0]; k < r[1]; k++) if (T[k].t === 'word' && AGG[T[k].n] && isP(T[k + 1], '(')) return true; return false; };
    var pick = cands.filter(hasAgg).pop() || cands[cands.length - 1] || null;
    A.statements = stmts.length;
    if (pick) {
      A.stmt = pick;
      A.root = parseQuery(A, pick[0], pick[1], null, null);
      bind(A);
      if (cands.length > 1) A.notes.push('There are ' + stmts.length + ' statements; Canon checked the one starting on line ' + lineOf(A, T[pick[0]].s) + '.');
    }
    if (A.invisible) A.notes.push('The SQL had ' + plural(A.invisible, 'invisible character') + ' (zero-width or direction-changing). They were removed before checking.');
    if (A.problems.indexOf('string') >= 0) A.notes.push('A quoted string never closes - the check may be off after it.');
    if (A.problems.indexOf('comment') >= 0) A.notes.push('A /* comment never closes - everything after it was ignored.');
    if (A.problems.indexOf('long') >= 0) A.notes.push('The SQL is very long; only the first ' + LIMITS.tokens + ' tokens were read.');
    A.feed = feeding(A);
    return A;
  }
  function lineOf(A, off) {
    if (!A.lines) { A.lines = [0]; for (var i = 0; i < A.src.length; i++) if (A.src[i] === '\n') A.lines.push(i + 1); }
    var lo = 0, hi = A.lines.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (A.lines[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  }
  function textOf(A, s, e) { if (s >= e || !A.T[s]) return ''; return A.src.slice(A.T[s].s, A.T[Math.min(e, A.T.length) - 1].e); }
  function frag(A, s, e) { var t = textOf(A, s, e); return { text: t.length > 400 ? t.slice(0, 399) + '\u2026' : t, line: A.T[s] ? lineOf(A, A.T[s].s) : 0 }; }

  /** The selects and table scans that feed the result: everything reached
   *  from the statement through FROM and JOIN (CTEs and derived tables
   *  included), not subqueries inside WHERE or the select list. */
  function feeding(A) {
    var scans = [], sels = [], seenSel = new Set(), seenSrc = new Set();
    function wq(q, optional, depth) { if (!q || depth > 20) return; q.selects.forEach(function (s) { ws(s, optional, depth); }); }
    function ws(sel, optional, depth) {
      if (!seenSel.has(sel)) { seenSel.add(sel); sels.push(sel); }
      sel.flat.forEach(function (src) {
        var opt = optional || src.optional;
        if (src.kind === 'table') { if (!seenSrc.has(src)) { seenSrc.add(src); scans.push({ src: src, sel: sel, optional: opt }); } }
        else if (src.query) wq(src.query, opt, depth + 1);
      });
      // a scalar subquery in the select list is a column of the result
      sel.subs.forEach(function (x) { if (x.inList) wq(x.query, optional, depth + 1); });
    }
    wq(A.root, false, 0);
    var exprSels = A.selects.filter(function (s) { return !seenSel.has(s); });
    return { scans: scans, sels: sels, exprSels: exprSels };
  }

  /* ================================================================== *
   * Expressions and column resolution
   * ================================================================== */

  function skipWord(A, i) {
    var T = A.T, t = T[i], prev = T[i - 1], next = T[i + 1];
    if (t.t !== 'word') return false;
    if (RESERVED[t.n] || VALUEWORD[t.n]) return true;
    if (TYPEWORD[t.n] && next && next.t === 'string') return true;          // DATE '2026-07-01'
    if (prev && prev.v === '::') return true;                                // x::date
    if (prev && isW(prev, 'as')) return true;                                // CAST(x AS date)
    if (isW(t, 'time') && isW(next, 'zone')) return true;
    if (DATEPART[t.n] && prev && (isP(prev, '(') || isP(prev, ',')) && next && (isP(next, ',') || isP(next, ')') || isW(next, 'from'))) return true;
    if (DATEPART[t.n] && prev && (prev.t === 'number' || prev.t === 'string') && isW(T[i - 2], 'interval')) return true;
    if (TYPEWORD[t.n] && prev && isP(prev, '(') && isW(T[i - 2], 'convert')) return true;
    return false;
  }

  /** Column references, aggregate calls and string literals in [s, e). */
  function exprScan(A, s, e) {
    var T = A.T, refs = [], aggs = [], i = s;
    while (i < e) {
      var t = T[i];
      if (isP(t, '(') && A.subAt[i]) { i = Math.min(A.pair[i], e) + 1; continue; }
      if (t.t === 'word' && isP(T[i + 1], '(')) {
        if (AGG[t.n]) aggs.push(aggAt(A, i));
        i += 1; continue;
      }
      if ((t.t === 'word' || t.t === 'qident') && !skipWord(A, i)) {
        if (t.t === 'qident' && t.dq && A.noDq) { i++; continue; }
        var rn = readName(A, i, e);
        if (isP(T[rn.end], '(')) { i = rn.end; continue; }                 // schema.fn(...)
        if (isP(T[rn.end], '.') && T[rn.end + 1] && T[rn.end + 1].v === '*') { i = rn.end + 2; continue; }
        refs.push({ parts: rn.parts, s: i, e: rn.end, dq: Boolean(t.dq) });
        i = rn.end; continue;
      }
      i++;
    }
    return { refs: refs, aggs: aggs };
  }
  function aggAt(A, i) {
    var T = A.T, close = A.pair[i + 1], fn = AGG[T[i].n];
    var a = i + 2, distinct = false;
    if (isW(T[a], 'distinct')) { distinct = true; a++; } else if (isW(T[a], 'all')) a++;
    if (fn === 'countd') distinct = true;
    var star = close - a === 1 && T[a].v === '*';
    var after = T[close + 1];
    return { at: i, s: i, e: close + 1, argS: a, argE: close, fn: distinct && fn === 'count' ? 'countd' : fn, raw: T[i].n, distinct: distinct, star: star, window: isW(after, 'over'), filtered: isW(after, 'filter') || /if$/.test(T[i].n) };
  }

  function schemaIndex(canon) {
    var tables = Object.create(null), rel = [];
    var c = canon && typeof canon === 'object' ? canon : {};
    (Array.isArray(c.tables) ? c.tables : []).forEach(function (t) {
      if (!t || !t.name) return;
      var k = keyOfName(t.name);
      var cols = Array.isArray(t.columns) && t.columns.length ? Object.create(null) : null;
      if (cols) t.columns.forEach(function (x) { cols[String(x).toLowerCase()] = 1; });
      tables[k] = { name: t.name, key: t.key ? String(t.key).toLowerCase() : '', columns: cols, grain: t.grain || '' };
    });
    (Array.isArray(c.relationships) ? c.relationships : []).forEach(function (r) {
      var one = refOfText(r && r.one), many = refOfText(r && r.many);
      if (one && many && one.table && many.table && one.table !== many.table) rel.push({ one: one, many: many });
    });
    return { tables: tables, rel: rel };
  }
  /** Last part of a typed table name, lower case: "Shop"."Orders" -> orders. */
  function keyOfName(text) {
    var tk = tokenize(String(text || '')).tokens, parts = [];
    tk.forEach(function (t) { if (t.t === 'word' || t.t === 'qident') String(t.t === 'qident' ? t.n : t.v).split('.').forEach(function (p) { if (p) parts.push(p.toLowerCase()); }); });
    return parts.length ? parts[parts.length - 1] : '';
  }
  /** "orders.status" -> {table: 'orders', column: 'status'}; "status" -> {table: '', column}. */
  function refOfText(text) {
    var tk = tokenize(String(text || '')).tokens, parts = [];
    tk.forEach(function (t) { if (t.t === 'word' || t.t === 'qident') String(t.t === 'qident' ? t.n : t.v).split('.').forEach(function (p) { if (p) parts.push(p.toLowerCase()); }); });
    if (!parts.length) return null;
    return { table: parts.length > 1 ? parts[parts.length - 2] : '', column: parts[parts.length - 1] };
  }

  function srcHasCol(A, src, col) {
    if (src.kind === 'table') {
      var info = A.schema.tables[src.key];
      if (info && info.columns) return info.columns[col] ? true : false;
      return 'maybe';
    }
    if (src.query && src.query.selects[0]) {
      var sel0 = src.query.selects[0], maybe = false;
      for (var k = 0; k < sel0.items.length; k++) {
        var it = sel0.items[k];
        if (it.aliasKey === col) return true;
        if (!it.alias && it.single && it.single.col === col) return true;
        if (it.star) maybe = true;
      }
      return maybe ? 'maybe' : false;
    }
    return 'maybe';
  }
  function findQual(sel, qual) {
    var hit = null;
    sel.flat.forEach(function (src) { if (!hit && src.aliasKey === qual) hit = src; });
    if (!hit) sel.flat.forEach(function (src) { if (!hit && !src.aliasKey && src.key === qual) hit = src; });
    if (!hit) sel.flat.forEach(function (src) { if (!hit && src.key === qual) hit = src; });
    return hit;
  }

  /** Where does a column of `sel` come from? -> {refs: [{table, column, src}],
   *  hops: [{s, e}] (the expressions it passed through), ambiguous, unresolved}. */
  function resolve(A, sel, parts, depth) {
    depth = depth || 0;
    if (depth > 18 || !sel) return { refs: [], hops: [], unresolved: true };
    var col = parts[parts.length - 1], qual = parts.length > 1 ? parts[parts.length - 2] : null;
    if (qual) {
      var src = findQual(sel, qual);
      if (!src) {
        if (sel.query.parent) return resolve(A, sel.query.parent, parts, depth + 1);
        return { refs: [], hops: [], unresolved: true };
      }
      return through(A, src, col, depth);
    }
    var cands = [];
    sel.flat.forEach(function (s) { var h = srcHasCol(A, s, col); if (h) cands.push({ src: s, sure: h === true }); });
    var sure = cands.filter(function (c) { return c.sure; });
    var pick = sure.length === 1 ? sure[0] : (cands.length === 1 ? cands[0] : null);
    if (pick) return through(A, pick.src, col, depth);
    if (!cands.length) {
      if (sel.query.parent) { var up = resolve(A, sel.query.parent, parts, depth + 1); if (up.refs.length) return up; }
      return { refs: [], hops: [], unresolved: true };
    }
    if (A.guess) return through(A, (sure[0] || cands[0]).src, col, depth);
    return { refs: [], hops: [], ambiguous: cands.map(function (c) { return c.src; }), col: col };
  }
  function through(A, src, col, depth) {
    if (src.kind === 'table') return { refs: [{ table: src.key, column: col, src: src }], hops: [] };
    if (!src.query) return { refs: [], hops: [], unresolved: true };
    var refs = [], hops = [], ambiguous = null;
    var sels = src.query.selects, idx = -1;
    sels.forEach(function (s0, bi) {
      var it = null;
      if (bi === 0) {
        for (var k = 0; k < s0.items.length; k++) {
          var x = s0.items[k];
          if (x.aliasKey === col || (!x.alias && x.single && x.single.col === col)) { it = x; idx = k; break; }
        }
      } else if (idx >= 0) it = s0.items[idx] || null;
      if (it && !it.star) {
        hops.push({ sel: s0, s: it.exprS, e: it.exprE });
        exprScan(A, it.exprS, it.exprE).refs.forEach(function (r) {
          var rr = resolve(A, s0, r.parts, depth + 1);
          refs = refs.concat(rr.refs); hops = hops.concat(rr.hops || []);
          if (rr.ambiguous) ambiguous = rr;
        });
        return;
      }
      var star = s0.items.filter(function (x) { return x.star; })[0];
      if (star) {
        var rs = resolve(A, s0, star.starQual ? [star.starQual, col] : [col], depth + 1);
        refs = refs.concat(rs.refs); hops = hops.concat(rs.hops || []);
        if (rs.ambiguous) ambiguous = rs;
      }
    });
    if (!refs.length && ambiguous) return ambiguous;
    return { refs: refs, hops: hops, via: src };
  }

  /* ================================================================== *
   * Literals, operands and predicates
   * ================================================================== */

  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?|[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)?$/;
  function dateOf(v) {
    var m = DATE_RE.exec(String(v).trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var day = m[1] + '-' + m[2] + '-' + m[3];
    if (addDays(day, 0) !== day) return null;
    return { day: day, time: m[4] ? m[4] + ':' + m[5] + ':' + (m[6] || '00') : null, frac: m[7] || '', offset: m[8] || '' };
  }
  function literalAt(A, s, e) {
    var T = A.T, r = stripParens(A, s, e); s = r[0]; e = r[1];
    if (s >= e) return null;
    var t = T[s];
    if (e - s === 1) {
      if (t.t === 'string') return mkLit('str', t.n);
      if (t.t === 'number') return { t: 'num', v: t.n };
      if (t.t === 'param' || t.t === 'template') return { t: 'param', v: t.v };
      if (isW(t, 'true') || isW(t, 'false')) return { t: 'bool', v: t.n === 'true' };
      if (isW(t, 'null')) return { t: 'null' };
      if (t.t === 'word' && VALUEWORD[t.n]) return { t: 'dateexpr', v: t.n };
    }
    if (e - s === 2 && t.t === 'op' && t.v === '-' && T[s + 1].t === 'number') return { t: 'num', v: -T[s + 1].n };
    if (e - s === 2 && t.t === 'word' && TYPEWORD[t.n] && T[s + 1].t === 'string') { var l = mkLit('str', T[s + 1].n); l.typed = t.n; return l; }
    if (e - s === 3 && T[s].t === 'string' && T[s + 1].v === '::' && T[s + 2].t === 'word') { var l2 = mkLit('str', T[s].n); l2.typed = T[s + 2].n; return l2; }
    // CAST('2026-07-01' AS DATE), DATE('2026-07-01'), TO_DATE('...')
    if (t.t === 'word' && isP(T[s + 1], '(') && A.pair[s + 1] === e - 1) {
      var args = splitTop(A, s + 2, e - 1, ',');
      if ((t.n === 'cast' || t.n === 'try_cast' || t.n === 'safe_cast') && T[s + 2] && T[s + 2].t === 'string') { var l3 = mkLit('str', T[s + 2].n); l3.typed = (T[e - 2] && T[e - 2].n) || 'date'; return l3; }
      if ((t.n === 'date' || t.n === 'to_date' || t.n === 'timestamp' || t.n === 'to_timestamp' || t.n === 'datetime') && args.length >= 1 && args[0][1] - args[0][0] === 1 && T[args[0][0]].t === 'string') { var l4 = mkLit('str', T[args[0][0]].n); l4.typed = t.n === 'to_date' ? 'date' : t.n; return l4; }
    }
    // no column in it: a date expression (now() - interval '7 days', date_trunc('quarter', current_date))
    var scan = exprScan(A, s, e);
    if (!scan.refs.length) {
      for (var k = s; k < e; k++) {
        var tk = T[k];
        if (tk.t === 'word' && (VALUEWORD[tk.n] || tk.n === 'interval' || DATEFN[tk.n] || /date|time/.test(tk.n))) return { t: 'dateexpr', v: textOf(A, s, e) };
        if (tk.t === 'param' || tk.t === 'template') return { t: 'param', v: textOf(A, s, e) };
      }
      var allNum = true;
      for (var k2 = s; k2 < e; k2++) if (!(T[k2].t === 'number' || T[k2].t === 'op')) allNum = false;
      if (allNum) return { t: 'expr', v: textOf(A, s, e) };
    }
    return null;
  }
  function mkLit(t, v) { var l = { t: t, v: v }; var d = dateOf(v); if (d) l.date = d; return l; }

  var WRAP_CASE = setOf('lower upper lcase ucase');
  var WRAP_KEEP = setOf('trim ltrim rtrim btrim');
  var WRAP_DAY = setOf('date to_date todate');
  var WRAP_TZFN = setOf('convert_timezone convert_tz from_utc_timestamp to_utc_timestamp timezone totimezone todatetime datetime timestamp');
  var WRAP_PART = setOf('year month quarter week day dayofweek dayofmonth dayofyear hour isoweek yearweek tostartofmonth tostartofweek tostartofday tostartofquarter tostartofyear last_day');
  var WRAP_FMT = setOf('to_char format_date format_timestamp format_datetime strftime date_format');

  /** One side of a comparison, with its wrappers peeled off:
   *  LOWER(x), COALESCE(x, d), CAST(x AS date), x::date, x AT TIME ZONE 'z',
   *  DATE(x), DATE_TRUNC('month', x), EXTRACT(year FROM x), CONVERT_TZ(...). */
  function operand(A, sel, s, e) {
    var T = A.T, o = { s: s, e: e, col: null, lit: null, wraps: [], day: false, part: null, ci: false, coalesce: null, complex: false };
    var guard = 0;
    while (s < e && guard++ < 24) {
      var r = stripParens(A, s, e); s = r[0]; e = r[1];
      if (e - s > 4 && isW(T[e - 4], 'at') && isW(T[e - 3], 'time') && isW(T[e - 2], 'zone')) { o.wraps.push('tz'); e -= 4; continue; }
      if (e - s > 2 && T[e - 2].v === '::' && T[e - 1].t === 'word') { if (T[e - 1].n === 'date') o.day = true; o.wraps.push('cast'); e -= 2; continue; }
      if (e - s > 2 && isP(T[e - 1], ')') && T[A.pair[e - 1] - 1] && T[A.pair[e - 1] - 1].t === 'word' && T[A.pair[e - 1] - 2] && T[A.pair[e - 1] - 2].v === '::') { if (T[A.pair[e - 1] - 1].n === 'date') o.day = true; e = A.pair[e - 1] - 2; o.wraps.push('cast'); continue; }
      var t = T[s];
      if (!(t && t.t === 'word' && isP(T[s + 1], '(') && A.pair[s + 1] === e - 1)) break;
      var fn = t.n, args = splitTop(A, s + 2, e - 1, ',');
      if (!args.length) break;
      var colArg = function () { for (var k = 0; k < args.length; k++) { var sc = exprScan(A, args[k][0], args[k][1]); if (sc.refs.length) return args[k]; } return null; };
      if (WRAP_CASE[fn] || WRAP_KEEP[fn]) { if (WRAP_CASE[fn]) o.ci = true; o.wraps.push(fn); s = args[0][0]; e = args[0][1]; continue; }
      if (fn === 'cast' || fn === 'try_cast' || fn === 'safe_cast') {
        var asAt = topScan(A, s + 2, e - 1, function (i, tk) { return isW(tk, 'as'); });
        if (asAt < 0) break;
        if (isW(T[asAt + 1], 'date')) o.day = true;
        o.wraps.push('cast'); e = asAt; s = s + 2; continue;
      }
      if (fn === 'convert' && args.length >= 2) { if (isW(T[args[0][0]], 'date')) o.day = true; o.wraps.push('cast'); s = args[1][0]; e = args[1][1]; continue; }
      if ((fn === 'coalesce' || fn === 'ifnull' || fn === 'nvl' || fn === 'isnull') && args.length === 2) {
        o.coalesce = literalAt(A, args[1][0], args[1][1]); s = args[0][0]; e = args[0][1]; continue;
      }
      if (WRAP_DAY[fn]) { o.day = true; o.wraps.push(fn); var ca = colArg() || args[0]; s = ca[0]; e = ca[1]; continue; }
      if (fn === 'date_trunc' || fn === 'datetime_trunc' || fn === 'timestamp_trunc' || fn === 'trunc' || fn === 'date_part' || fn === 'datepart' || fn === 'extract') {
        var ca2 = colArg(); if (!ca2) break;
        var other = args.filter(function (a) { return a !== ca2; })[0];
        var partTok = other ? T[other[0]] : null;
        if (fn === 'extract') { var fromAt = topScan(A, s + 2, e - 1, function (i, tk) { return isW(tk, 'from'); }); if (fromAt < 0) break; partTok = T[s + 2]; ca2 = [fromAt + 1, e - 1]; }
        var part = partTok ? String(partTok.t === 'string' ? partTok.n : partTok.n || '').toLowerCase() : '';
        if (fn === 'trunc' && !part) part = 'day';
        if (fn === 'date_trunc' || fn === 'datetime_trunc' || fn === 'timestamp_trunc' || fn === 'trunc') { o.trunc = part; if (part === 'day' || part === 'dd') o.day = true; }
        else o.part = part || 'part';
        o.wraps.push(fn); s = ca2[0]; e = ca2[1]; continue;
      }
      if (WRAP_PART[fn] || WRAP_FMT[fn]) { var ca3 = colArg(); if (!ca3) break; if (WRAP_PART[fn]) o.part = fn; else o.fmt = true; o.wraps.push(fn); s = ca3[0]; e = ca3[1]; continue; }
      if (WRAP_TZFN[fn]) { var ca4 = colArg(); if (!ca4) break; o.wraps.push('tz'); if (fn === 'datetime' || fn === 'timestamp') { /* BigQuery DATETIME(ts, zone) */ } s = ca4[0]; e = ca4[1]; continue; }
      break;
    }
    o.cs = s; o.ce = e;
    if (s >= e) return o;
    var lit = literalAt(A, s, e);
    if (lit) { o.lit = lit; return o; }
    var rn = (T[s].t === 'word' || T[s].t === 'qident') && !skipWord(A, s) ? readName(A, s, e) : null;
    if (rn && rn.end === e) { o.col = { parts: rn.parts, s: s, e: e, dq: Boolean(T[s].dq) }; return o; }
    o.complex = true;
    o.refs = exprScan(A, s, e).refs;
    return o;
  }

  function negate(p) {
    if (!p) return { form: 'other' };
    var q = Object.assign({}, p);
    if (p.form === 'bool') { q.v = !p.v; if (p.two) q.nulls = p.nulls === 'in' ? 'out' : 'in'; return q; }
    if (p.form === 'set' || p.form === 'like' || p.form === 'insub' || p.form === 'range' || p.form === 'exists') { q.neg = !p.neg; return q; }
    if (p.form === 'null') { q.isNull = !p.isNull; return q; }
    if (p.form === 'cmp') { q.op = { '<': '>=', '<=': '>', '>': '<=', '>=': '<' }[p.op]; return q; }
    if (p.form === 'and' || p.form === 'or') return { form: 'other', parts: p.parts, col: null, s: p.s, e: p.e };
    return { form: 'other', s: p.s, e: p.e };
  }
  var FLIP = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=', '==': '=', '<>': '<>', '!=': '<>', '<=>': '=' };
  function cmpPred(A, sel, left, op, right, s, e) {
    var col = left, lit = right;
    if (!left.col && right.col) { col = right; lit = left; op = FLIP[op]; }
    // a double-quoted name that is not a column is a string (MySQL, BigQuery)
    if (lit.col && lit.col.dq && !resolve(A, sel, lit.col.parts).refs.length) lit = { lit: mkLit('str', A.T[lit.col.s].n) };
    if (col.col && lit.col) return { form: 'join', a: col, b: lit, s: s, e: e };
    var base = { col: col.col ? col : (col.complex ? col : null), s: s, e: e, opnd: col, other: lit };
    if (!lit.lit) return Object.assign({ form: 'other' }, base);
    var L = lit.lit;
    if (op === '=' || op === '==' || op === '<=>') {
      if (L.t === 'bool') return Object.assign({ form: 'bool', v: L.v, nulls: col.coalesce && col.coalesce.t === 'bool' && col.coalesce.v === L.v ? 'in' : 'out', two: false }, base);
      if (L.t === 'null') return Object.assign({ form: 'other', why: '= NULL is never true; IS NULL was meant' }, base);
      return Object.assign({ form: 'set', vals: [L], neg: false, ci: col.ci, nullsIn: Boolean(col.coalesce && litKey(col.coalesce) === litKey(L)) }, base);
    }
    if (op === '<>' || op === '!=') {
      if (L.t === 'bool') return Object.assign({ form: 'bool', v: !L.v, nulls: 'out', two: false }, base);
      return Object.assign({ form: 'set', vals: [L], neg: true, ci: col.ci }, base);
    }
    return Object.assign({ form: 'cmp', op: op, lit: L }, base);
  }

  /** A condition, normalised: bool / set / null / cmp / range / like / insub
   *  / exists / join / or / and / other, with the column it tests. */
  function predicate(A, sel, s, e, depth) {
    depth = depth || 0;
    var T = A.T, r = stripParens(A, s, e); s = r[0]; e = r[1];
    if (s >= e || depth > 12) return { form: 'other', s: s, e: e };
    var ors = splitBool(A, s, e, 'or');
    if (ors.length > 1) return { form: 'or', s: s, e: e, parts: ors.map(function (p) { return predicate(A, sel, p[0], p[1], depth + 1); }) };
    var ands = splitBool(A, s, e, 'and');
    if (ands.length > 1) return { form: 'and', s: s, e: e, parts: ands.map(function (p) { return predicate(A, sel, p[0], p[1], depth + 1); }) };
    if (isW(T[s], 'exists')) return { form: 'exists', neg: false, s: s, e: e };
    if (isW(T[s], 'not')) {
      if (isW(T[s + 1], 'exists')) return { form: 'exists', neg: true, s: s, e: e };
      var inner = predicate(A, sel, s + 1, e, depth + 1);
      var ng = negate(inner); ng.s = s; ng.e = e; return ng;
    }
    var opAt = -1, kind = null;
    topScan(A, s, e, function (i, t) {
      if (t.t === 'op' && CMP[t.v]) { opAt = i; kind = 'cmp'; return true; }
      if (t.t !== 'word') return false;
      if (t.n === 'is' || t.n === 'isnull' || t.n === 'notnull') { opAt = i; kind = t.n; return true; }
      if (t.n === 'between' || t.n === 'in' || t.n === 'like' || t.n === 'ilike' || t.n === 'rlike' || t.n === 'regexp' || t.n === 'similar') { opAt = i; kind = t.n; return true; }
      if (t.n === 'not' && i > s && T[i + 1] && T[i + 1].t === 'word' && /^(between|in|like|ilike|rlike|regexp|similar)$/.test(T[i + 1].n)) { opAt = i; kind = 'not-' + T[i + 1].n; return true; }
      return false;
    });
    if (opAt < 0) {
      var only = operand(A, sel, s, e);
      if (only.col) return { form: 'bool', v: true, nulls: 'out', two: false, col: only, s: s, e: e, opnd: only };
      return { form: 'other', s: s, e: e, col: only.complex ? only : null };
    }
    var left = operand(A, sel, s, opAt);
    var base = { col: left.col || left.complex ? left : null, s: s, e: e, opnd: left };
    if (kind === 'cmp') return cmpPred(A, sel, left, T[opAt].v, operand(A, sel, opAt + 1, e), s, e);
    if (kind === 'isnull') return Object.assign({ form: 'null', isNull: true }, base);
    if (kind === 'notnull') return Object.assign({ form: 'null', isNull: false }, base);
    if (kind === 'is') {
      var j = opAt + 1, not = false;
      if (isW(T[j], 'not')) { not = true; j++; }
      var w = T[j] && T[j].t === 'word' ? T[j].n : '';
      if (w === 'null' || w === 'unknown') return Object.assign({ form: 'null', isNull: !not }, base);
      if (w === 'true' || w === 'false') {
        var v = w === 'true';
        return Object.assign({ form: 'bool', v: not ? !v : v, nulls: not ? 'in' : 'out', two: true }, base);
      }
      if (w === 'distinct' && isW(T[j + 1], 'from')) {
        var dp = cmpPred(A, sel, left, not ? '=' : '<>', operand(A, sel, j + 2, e), s, e);
        if (dp.form === 'bool') { dp.two = true; if (!not) dp.nulls = 'in'; }
        return dp;
      }
      return Object.assign({ form: 'other' }, base);
    }
    var neg = kind.indexOf('not-') === 0, k2 = neg ? kind.slice(4) : kind, b0 = opAt + (neg ? 2 : 1);
    if (k2 === 'between') {
      if (isW(T[b0], 'symmetric') || isW(T[b0], 'asymmetric')) b0++;
      var andAt = -1, nested = 0;
      topScan(A, b0, e, function (i, t) { if (isW(t, 'between')) nested++; else if (isW(t, 'and')) { if (nested) nested--; else { andAt = i; return true; } } return false; });
      if (andAt < 0) return Object.assign({ form: 'other' }, base);
      return Object.assign({ form: 'range', neg: neg, lo: operand(A, sel, b0, andAt), hi: operand(A, sel, andAt + 1, e), at: opAt, andAt: andAt }, base);
    }
    if (k2 === 'in') {
      if (isP(T[b0], '(')) {
        if (A.subAt[b0]) return Object.assign({ form: 'insub', neg: neg }, base);
        var vals = splitTop(A, b0 + 1, Math.min(A.pair[b0], e), ',').map(function (x) {
          var lt = literalAt(A, x[0], x[1]);
          if (!lt && x[1] - x[0] === 1 && A.T[x[0]].t === 'qident' && A.T[x[0]].dq) lt = mkLit('str', A.T[x[0]].n);
          return lt;
        });
        if (vals.length && vals.every(Boolean)) return Object.assign({ form: 'set', vals: vals, neg: neg, ci: left.ci }, base);
      }
      return Object.assign({ form: 'other' }, base);
    }
    var pat = operand(A, sel, b0, e);
    return Object.assign({ form: 'like', neg: neg, pattern: pat.lit ? String(pat.lit.v) : null }, base);
  }
  function litKey(l) {
    if (!l) return '?';
    if (l.t === 'bool') return 'b:' + l.v;
    if (l.t === 'num') return 'n:' + l.v;
    if (l.t === 'str') return 's:' + l.v;
    return l.t + ':' + l.v;
  }
  function litText(l) {
    if (!l) return '';
    if (l.t === 'str') return "'" + String(l.v).replace(/'/g, "''") + "'";
    if (l.t === 'bool') return l.v ? 'true' : 'false';
    if (l.t === 'null') return 'NULL';
    return String(l.v);
  }
  function asBool(l) {
    if (!l) return null;
    if (l.t === 'bool') return l.v;
    if (l.t === 'num' && (l.v === 0 || l.v === 1)) return l.v === 1;
    if (l.t === 'str' && /^(t|f|true|false|y|n|yes|no)$/i.test(l.v)) return /^(t|true|y|yes)$/i.test(l.v);
    return null;
  }

  /** Is the predicate the SQL wrote equivalent to the one the canon requires?
   *  -> {ok, why, note}. */
  function equivalent(want, got) {
    if (!want || !got) return { ok: false, why: 'a different condition' };
    var wf = want.form, gf = got.form;
    // booleans: = false, IS FALSE, NOT x, <> true, = 0
    if (wf === 'bool' || (wf === 'set' && want.vals.length === 1 && asBool(want.vals[0]) !== null && !want.neg)) {
      var wv = wf === 'bool' ? want.v : asBool(want.vals[0]);
      var gv = null, gNulls = 'out';
      if (gf === 'bool') { gv = got.v; gNulls = got.nulls; }
      else if (gf === 'set' && got.vals.length === 1 && asBool(got.vals[0]) !== null) { gv = got.neg ? !asBool(got.vals[0]) : asBool(got.vals[0]); gNulls = got.nullsIn ? 'in' : 'out'; }
      if (gv === null) return { ok: false, why: 'a different test on the same column' };
      if (gv !== wv) return { ok: false, why: 'the opposite: it keeps exactly the rows the canon leaves out', opposite: true };
      var wNulls = wf === 'bool' ? want.nulls : 'out';
      if (gNulls === 'in' && wNulls === 'out') return { ok: true, note: 'It also keeps rows where the column is NULL; the canon\u2019s form does not.' };
      return { ok: true };
    }
    if (wf === 'null') {
      if (gf !== 'null') return { ok: false, why: 'a different test on the same column' };
      return got.isNull === want.isNull ? { ok: true } : { ok: false, why: 'the opposite (' + (got.isNull ? 'IS NULL' : 'IS NOT NULL') + ')', opposite: true };
    }
    if (wf === 'set') {
      if (gf !== 'set') return { ok: false, why: gf === 'like' ? 'a LIKE pattern instead of an exact value' : 'a different test on the same column' };
      if (Boolean(got.neg) !== Boolean(want.neg)) return { ok: false, why: got.neg ? 'a "not equal" test, which lets every other value through' : 'an "equals" test instead of a "not equal" one' };
      var key = function (l) { return litKey(l).toLowerCase(); };
      var W = want.vals.map(key), G = got.vals.map(key);
      var extra = got.vals.filter(function (l) { return W.indexOf(key(l)) < 0; });
      var missingVals = want.vals.filter(function (l) { return G.indexOf(key(l)) < 0; });
      var exact = want.vals.map(litKey), gotExact = got.vals.map(litKey);
      if (!extra.length && !missingVals.length) {
        var sameCase = exact.every(function (k) { return gotExact.indexOf(k) >= 0; });
        if (!sameCase && !got.ci) return { ok: false, why: 'the same value in a different case - most databases compare text case-sensitively' };
        return got.ci && !sameCase ? { ok: true, note: 'Compared without case (LOWER/UPPER).' } : { ok: true };
      }
      if (want.neg) {
        if (missingVals.length) return { ok: false, why: 'it does not leave out ' + missingVals.map(litText).join(', ') };
        return { ok: true, note: 'It also leaves out ' + extra.map(litText).join(', ') + '.' };
      }
      if (extra.length && missingVals.length) return { ok: false, why: 'it keeps ' + extra.map(litText).join(', ') + ' instead of ' + missingVals.map(litText).join(', ') };
      if (extra.length) return { ok: false, why: 'it also lets in ' + extra.map(litText).join(', ') };
      return { ok: false, why: 'it leaves out ' + missingVals.map(litText).join(', ') };
    }
    if (wf === 'cmp') {
      if (gf !== 'cmp') return { ok: false, why: 'a different test on the same column' };
      if (got.op === want.op && litKey(got.lit) === litKey(want.lit)) return { ok: true };
      if (want.lit.t === 'num' && got.lit.t === 'num') {
        var a = want.lit.v, b = got.lit.v;
        var same = (want.op === '>' && got.op === '>=' && b === a + 1) || (want.op === '>=' && got.op === '>' && b === a - 1) || (want.op === '<' && got.op === '<=' && b === a - 1) || (want.op === '<=' && got.op === '<' && b === a + 1);
        if (same && Number.isInteger(a) && Number.isInteger(b)) return { ok: true, note: 'Written another way; the same for whole numbers.' };
      }
      return { ok: false, why: 'a different bound (' + got.op + ' ' + litText(got.lit) + ')' };
    }
    if (wf === 'like') {
      if (gf === 'like' && got.neg === want.neg && got.pattern === want.pattern) return { ok: true };
      return { ok: false, why: 'a different pattern' };
    }
    return { ok: false, why: 'Canon can\u2019t compare this kind of condition', unsure: true };
  }

  /* ================================================================== *
   * Conditions and their columns
   * ================================================================== */

  function conjuncts(A, s, e, out) {
    out = out || [];
    splitBool(A, s, e, 'and').forEach(function (p) {
      var r = stripParens(A, p[0], p[1]);
      var ors = splitBool(A, r[0], r[1], 'or');
      if (ors.length === 1 && r[0] !== p[0] && splitBool(A, r[0], r[1], 'and').length > 1) conjuncts(A, r[0], r[1], out);
      else out.push({ s: p[0], e: p[1] });
    });
    return out;
  }
  function targetsOf(A, sel, p, inOr, out) {
    out = out || [];
    if (!p) return out;
    if (p.form === 'or' || p.form === 'and' || (p.form === 'other' && p.parts)) { p.parts.forEach(function (x) { targetsOf(A, sel, x, inOr || p.form === 'or', out); }); return out; }
    if (p.form === 'join') {
      [p.a, p.b].forEach(function (o) { var rr = resolve(A, sel, o.col.parts); out.push({ opnd: o, refs: rr.refs, hops: rr.hops || [], ambiguous: rr.ambiguous || null, col: o.col.parts[o.col.parts.length - 1], inOr: inOr, join: true, pred: p }); });
      return out;
    }
    var o = p.opnd || p.col;
    if (!o) return out;
    if (o.col) {
      var rr = resolve(A, sel, o.col.parts);
      out.push({ opnd: o, refs: rr.refs, hops: rr.hops || [], ambiguous: rr.ambiguous || null, col: o.col.parts[o.col.parts.length - 1], inOr: inOr, pred: p });
    } else if (o.refs) {
      o.refs.forEach(function (ref) { var r2 = resolve(A, sel, ref.parts); out.push({ opnd: o, refs: r2.refs, hops: r2.hops || [], ambiguous: r2.ambiguous || null, col: ref.parts[ref.parts.length - 1], inOr: inOr, complex: true, pred: p, ref: ref }); });
    }
    return out;
  }
  function condsOf(A, sels) {
    var list = [];
    sels.forEach(function (sel) {
      var add = function (range, origin, src) {
        conjuncts(A, range.s, range.e).forEach(function (c) {
          var p = predicate(A, sel, c.s, c.e);
          var cd = { sel: sel, s: c.s, e: c.e, origin: origin, onSrc: src || null, pred: p, hasSub: false };
          for (var k = c.s; k < c.e; k++) if (A.subAt[k]) cd.hasSub = true;
          cd.targets = targetsOf(A, sel, p, false);
          list.push(cd);
        });
      };
      if (sel.where) add(sel.where, 'where');
      sel.flat.forEach(function (src) { if (src.on) add(src.on, 'on', src); if (src.groupOn) add(src.groupOn, 'on', src); });
      (sel.onOnly || []).forEach(function (x) { add(x.on, 'on', null); });
      if (sel.having) add(sel.having, 'having');
    });
    return list;
  }
  function targetHits(t, scanSrc, column) {
    if (t.col !== column && !t.refs.some(function (r) { return r.column === column; })) return false;
    if (t.refs.some(function (r) { return r.src === scanSrc && r.column === column; })) return true;
    return Boolean(t.ambiguous && t.col === column && t.ambiguous.indexOf(scanSrc) >= 0);
  }

  /* ================================================================== *
   * The canon side: definitions read with the same machinery
   * ================================================================== */

  function canonCtx(canon, m) {
    var tables = (m && m.tables || []).map(keyOfName).filter(Boolean);
    return { tables: tables, canon: canon };
  }
  function parseCanonExpr(canon, tablesIn, text, where) {
    // A definition names its tables directly (orders.status), so every
    // qualifier it uses is a table to read from, listed or not.
    var tables = tablesIn.slice(), tk = tokenize(String(text || '')).tokens;
    for (var i = 0; i + 2 < tk.length; i++) {
      if ((tk[i].t === 'word' || tk[i].t === 'qident') && isP(tk[i + 1], '.') && (tk[i + 2].t === 'word' || tk[i + 2].t === 'qident') && !isP(tk[i + 3], '.') && !isP(tk[i + 3], '(')) {
        var q = String(tk[i].t === 'qident' ? tk[i].n : tk[i].n).toLowerCase();
        if (!RESERVED[q] && tables.indexOf(q) < 0) tables.push(q);
      }
    }
    var from = tables.length ? tables.map(function (t) { return '"' + t.replace(/"/g, '') + '"'; }).join(', ') : 'canon_table';
    var full = where ? 'SELECT 1 FROM ' + from + ' WHERE ' + text : 'SELECT ' + text + ' FROM ' + from;
    var P = parseSql(full, canon);
    P.guess = true;
    P.offset = where ? ('SELECT 1 FROM ' + from + ' WHERE ').length : 'SELECT '.length;
    P.text = text;
    return P;
  }
  function measureModel(canon, m) {
    var tables = canonCtx(canon, m).tables;
    var P = parseCanonExpr(canon, tables, m.measure, false);
    var sel = P.root && P.root.selects[0];
    if (!sel || !sel.items.length) return { aggs: [], ok: false, text: m.measure };
    var it = sel.items[0];
    var sc = exprScan(P, it.exprS, it.exprE);
    var aggs = sc.aggs.map(function (g) {
      var refs = [];
      exprScan(P, g.argS, g.argE).refs.forEach(function (r) { resolve(P, sel, r.parts).refs.forEach(function (x) { refs.push({ table: x.table, column: x.column }); }); });
      return { fn: g.fn, fam: fam(g.fn), distinct: g.distinct, star: g.star, refs: refs, text: textOf(P, g.s, g.e) };
    });
    // a ratio: two aggregates either side of a top-level '/'
    var ratio = false;
    topScan(P, it.exprS, it.exprE, function (i, t) { if (t.t === 'op' && t.v === '/') ratio = true; return false; });
    var looseRefs = [];
    sc.refs.forEach(function (r) { resolve(P, sel, r.parts).refs.forEach(function (x) { looseRefs.push({ table: x.table, column: x.column }); }); });
    return { aggs: aggs, ratio: ratio && aggs.length >= 2, ok: aggs.length > 0, text: m.measure, refs: looseRefs, tables: tables };
  }
  function filterModel(canon, m, f) {
    var tables = canonCtx(canon, m).tables;
    var P = parseCanonExpr(canon, tables, f.sql, true);
    var sel = P.root && P.root.selects[0];
    if (!sel || !sel.where) return [{ f: f, ok: false }];
    return conjuncts(P, sel.where.s, sel.where.e).map(function (c) {
      var p = predicate(P, sel, c.s, c.e);
      var ts = targetsOf(P, sel, p, false).filter(function (t) { return t.refs.length; });
      var ref = ts[0] ? { table: ts[0].refs[0].table, column: ts[0].refs[0].column } : null;
      return { f: f, ok: Boolean(ref), pred: p, ref: ref, P: P, sel: sel, s: c.s, e: c.e, text: textOf(P, c.s, c.e), targets: ts };
    });
  }
  function refModel(canon, m, text) {
    var r = refOfText(text);
    if (!r) return null;
    if (!r.table) {
      var tables = canonCtx(canon, m).tables, S = schemaIndex(canon);
      var withCol = tables.filter(function (t) { return S.tables[t] && S.tables[t].columns && S.tables[t].columns[r.column]; });
      r.table = withCol[0] || tables[0] || '';
    }
    return r;
  }
  function fam(fn) { return fn === 'countd' ? 'count' : fn; }
  function refName(r) { return r ? (r.table ? r.table + '.' : '') + r.column : '?'; }

  /* ================================================================== *
   * Questions: which metric, which period, which split
   * ================================================================== */

  function stem(w) {
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (w.length > 3 && /(ss|us|is)$/.test(w)) return w;
    if (w.length > 3 && /s$/.test(w)) return w.slice(0, -1);
    return w;
  }
  function wordsOf(s) { return line(s, 600).toLowerCase().replace(/[\u2019']s\b/g, '').split(/[^a-z0-9%]+/).filter(Boolean).map(stem); }

  /** Metrics a question names, by name or another name, in order. The
   *  longest phrase wins where two overlap ("average order value" is not
   *  also "orders"). */
  function matchQuestion(question, canon) {
    var q = wordsOf(question), hits = [];
    ((canon && canon.metrics) || []).forEach(function (m) {
      [{ p: m.name, how: 'name' }].concat((m.synonyms || []).map(function (s) { return { p: s, how: 'synonym' }; })).forEach(function (x) {
        var w = wordsOf(x.p);
        if (!w.length) return;
        for (var i = 0; i + w.length <= q.length; i++) {
          var ok = true;
          for (var k = 0; k < w.length; k++) if (q[i + k] !== w[k]) { ok = false; break; }
          if (ok) hits.push({ id: m.id, s: i, e: i + w.length, len: w.length, how: x.how, phrase: x.p });
        }
      });
    });
    hits.sort(function (a, b) { return (b.len - a.len) || (a.s - b.s); });
    var taken = [], out = [], seen = {};
    hits.forEach(function (h) {
      for (var i = h.s; i < h.e; i++) if (taken[i]) return;
      for (var j = h.s; j < h.e; j++) taken[j] = true;
      if (!seen[h.id]) { seen[h.id] = 1; out.push(h); }
    });
    out.sort(function (a, b) { return a.s - b.s; });
    return out.map(function (h) { return { id: h.id, how: h.how, phrase: h.phrase }; });
  }

  // Calendar sums on civil days ('YYYY-MM-DD'), worked in UTC so no clock
  // change moves a day.
  function dayParts(d) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '')); return m ? [+m[1], +m[2], +m[3]] : null; }
  function fmtDay(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
  function addDays(day, n) { var p = dayParts(day); if (!p) return ''; return fmtDay(Date.UTC(p[0], p[1] - 1, p[2] + n)); }
  function monthStart(y, m) { return fmtDay(Date.UTC(y, m - 1, 1)); }
  function isDay(d) { var p = dayParts(d); return Boolean(p) && addDays(d, 0) === d; }
  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  var MON3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  var SHORTMON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function niceDay(d) { var p = dayParts(d); return p ? SHORTMON[p[1] - 1] + ' ' + p[2] + ', ' + p[0] : String(d); }
  function niceRange(a, endEx) {
    var last = addDays(endEx, -1), pa = dayParts(a), pl = dayParts(last);
    if (!pa || !pl) return a + ' to ' + endEx;
    if (pa[0] === pl[0]) return SHORTMON[pa[1] - 1] + ' ' + pa[2] + ' \u2013 ' + SHORTMON[pl[1] - 1] + ' ' + pl[2] + ', ' + pl[0];
    return niceDay(a) + ' \u2013 ' + niceDay(last);
  }

  /** The period a question asks for, as [start, end) civil days, given today. */
  function timeAsk(question, today) {
    var q = ' ' + line(question, 600).toLowerCase().replace(/[\u2019']/g, "'") + ' ';
    var t = dayParts(today);
    if (!t) return /\b(quarter|month|year|week|yesterday|today|q[1-4]|20\d\d|19\d\d|days?)\b/.test(q) || MONTHS.some(function (m) { return q.indexOf(m) >= 0; }) ? { label: 'a period', exact: false } : null;
    var y = t[0], mo = t[1], qn = Math.floor((mo - 1) / 3) + 1, m;
    var quarter = function (yy, n) { return { start: monthStart(yy, (n - 1) * 3 + 1), end: monthStart(yy, n * 3 + 1) }; };
    var res = function (label, r, exact) { return { label: label, start: r.start, end: r.end, exact: exact !== false }; };
    if ((m = /\bq([1-4])\s*(?:of\s*|')?((?:19|20)\d{2})\b/.exec(q)) || (m = /\b((?:19|20)\d{2})\s*-?\s*q([1-4])\b/.exec(q))) {
      var qq = /^q/.test(m[0].trim()) ? +m[1] : +m[2], yy = /^q/.test(m[0].trim()) ? +m[2] : +m[1];
      return res('Q' + qq + ' ' + yy, quarter(yy, qq));
    }
    if ((m = /\b(first|second|third|fourth|1st|2nd|3rd|4th) quarter(?: of)?(?: ((?:19|20)\d{2}))?/.exec(q))) {
      var qi = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 }[m[1]];
      var qy = m[2] ? +m[2] : (qi > qn ? y - 1 : y);
      return res('Q' + qi + ' ' + qy, quarter(qy, qi));
    }
    if ((m = /\bq([1-4])\b/.exec(q))) { var q1 = +m[1], qy1 = q1 > qn ? y - 1 : y; return res('Q' + q1 + ' ' + qy1, quarter(qy1, q1)); }
    if (/\b(last|previous|prior) quarter\b/.test(q)) { var lq = qn === 1 ? 4 : qn - 1, ly = qn === 1 ? y - 1 : y; return res('last quarter (Q' + lq + ' ' + ly + ')', quarter(ly, lq)); }
    if (/\b(this|current) quarter\b|\bquarter to date\b|\bqtd\b/.test(q)) return res('this quarter so far', { start: quarter(y, qn).start, end: addDays(today, 1) });
    if (/\b(last|previous|prior) month\b/.test(q)) { var pm = mo === 1 ? 12 : mo - 1, py = mo === 1 ? y - 1 : y; return res('last month (' + MONTHS[pm - 1].slice(0, 1).toUpperCase() + MONTHS[pm - 1].slice(1) + ' ' + py + ')', { start: monthStart(py, pm), end: monthStart(y, mo) }); }
    if (/\b(this|current) month\b|\bmonth to date\b|\bmtd\b/.test(q)) return res('this month so far', { start: monthStart(y, mo), end: addDays(today, 1) });
    if (/\b(last|previous|prior) year\b/.test(q)) return res('last year (' + (y - 1) + ')', { start: monthStart(y - 1, 1), end: monthStart(y, 1) });
    if (/\b(this|current) year\b|\byear to date\b|\bytd\b/.test(q)) return res('this year so far', { start: monthStart(y, 1), end: addDays(today, 1) });
    if (/\byesterday\b/.test(q)) return res('yesterday', { start: addDays(today, -1), end: today });
    if (/\btoday\b/.test(q)) return res('today', { start: today, end: addDays(today, 1) });
    if (/\b(last|previous|prior) week\b/.test(q)) { var dow = (new Date(Date.UTC(y, mo - 1, t[2])).getUTCDay() + 6) % 7, mon = addDays(today, -dow); return res('last week', { start: addDays(mon, -7), end: mon }); }
    if ((m = /\b(?:last|past|previous|trailing) (\d{1,3}) (day|week|month)s?\b/.exec(q))) return { label: 'the last ' + m[1] + ' ' + m[2] + 's', exact: false };
    var monRe = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?(?:\s+(?:of\s+)?((?:19|20)\d{2}))?\b/g, mm;
    while ((mm = monRe.exec(q))) {
      var name = mm[1], yr = mm[2] ? +mm[2] : null;
      var before = q.slice(Math.max(0, mm.index - 8), mm.index);
      if (name === 'may' && !yr && !/\b(in|for|during|of|since)\s+$/.test(before)) continue;
      if (name === 'mar' && !yr) continue;
      var mn = MONTHS.indexOf(name) + 1 || MON3[name];
      var my = yr || (mn > mo ? y - 1 : y);
      return res(MONTHS[mn - 1].charAt(0).toUpperCase() + MONTHS[mn - 1].slice(1) + ' ' + my, { start: monthStart(my, mn), end: monthStart(mn === 12 ? my + 1 : my, mn === 12 ? 1 : mn + 1) });
    }
    if ((m = /\b(?:in|for|during|of)\s+((?:19|20)\d{2})\b/.exec(q)) || (m = /\b((?:19|20)\d{2})\b/.exec(q))) { var y2 = +m[1]; return res(String(y2), { start: monthStart(y2, 1), end: monthStart(y2 + 1, 1) }); }
    return null;
  }
  function grainAsk(question) {
    var q = line(question, 600).toLowerCase(), m = /\b(?:by|per|each|every)\s+(day|week|month|quarter|year)\b/.exec(q);
    if (m) return m[1];
    m = /\b(daily|weekly|monthly|quarterly|yearly|annually|annual)\b/.exec(q);
    return m ? { daily: 'day', weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year', annually: 'year', annual: 'year' }[m[1]] : null;
  }
  /** "by channel", "per region", "split by product category" -> ['channel', ...]. */
  function dimAsk(question) {
    var q = line(question, 600).toLowerCase(), out = [], re = /\b(?:by|per|for each|split by|broken down by)\s+([a-z_][a-z_ ]{1,40}?)(?=\s+(?:in|for|during|last|this|and|over|since|from|between|of|with|on)\b|[?.,;!]|$)/g, m;
    while ((m = re.exec(q))) {
      var w = m[1].trim();
      if (/^(day|week|month|quarter|year|the|a|an)$/.test(w)) continue;
      out.push(w);
    }
    return out;
  }

  /* ================================================================== *
   * The checks
   * ================================================================== */

  function isTemporalName(c) { return /(^|_)(at|on|date|time|ts|dt|day|timestamp|datetime)$/.test(c) || /^(date|day|ts|timestamp|created|updated|paid|shipped)$/.test(c); }
  function isDateTyped(c) { return /(^|_)(date|day|dt)$/.test(c) || c === 'date' || c === 'day'; }
  var WINZONE = { 'eastern standard time': 'america/new_york', 'central standard time': 'america/chicago', 'mountain standard time': 'america/denver', 'pacific standard time': 'america/los_angeles', 'gmt standard time': 'europe/london', 'utc': 'utc', 'w. europe standard time': 'europe/berlin', 'aus eastern standard time': 'australia/sydney' };
  var ZONE_ALIAS = { 'us/eastern': 'america/new_york', est5edt: 'america/new_york', 'us/central': 'america/chicago', cst6cdt: 'america/chicago', 'us/mountain': 'america/denver', 'us/pacific': 'america/los_angeles', pst8pdt: 'america/los_angeles', 'etc/utc': 'utc', gmt: 'utc', 'etc/gmt': 'utc', z: 'utc', zulu: 'utc', 'gb': 'europe/london' };
  function normZone(v) { var z = String(v || '').trim().toLowerCase(); if (WINZONE[z]) z = WINZONE[z]; if (ZONE_ALIAS[z]) z = ZONE_ALIAS[z]; return z; }
  function isZoneText(v) { var z = String(v || '').trim(); return /^(utc|gmt|z)$/i.test(z) || /^[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(z) || has(WINZONE, z.toLowerCase()) || /^[+-]\d{2}:?\d{2}$/.test(z); }
  function zonesIn(A, s, e) {
    var T = A.T, out = [];
    for (var i = s; i < e; i++) {
      if (isP(T[i], '(') && A.subAt[i]) { i = A.pair[i]; continue; }
      if (T[i].t === 'string' && isZoneText(T[i].n)) out.push(normZone(T[i].n));
    }
    return out;
  }
  function zonesOfTarget(A, t) {
    var z = zonesIn(A, t.opnd.s, t.opnd.e);
    (t.hops || []).forEach(function (h) { z = z.concat(zonesIn(A, h.s, h.e)); });
    return z;
  }
  function hasDateFn(A, s, e) {
    for (var i = s; i < e; i++) {
      var t = A.T[i];
      if (t.t === 'word' && (DATEFN[t.n] || WRAP_FMT[t.n]) && isP(A.T[i + 1], '(')) return true;
      if (t.v === '::' && isW(A.T[i + 1], 'date')) return true;
    }
    return false;
  }

  function check(key, group, title, verdict, why, extra) {
    return Object.assign({ key: key, group: group, title: title, verdict: verdict, why: why, sql: null, canon: null, label: null }, extra || {});
  }

  /** Every aggregate call in the selects that feed the result. */
  function sqlAggs(A) {
    if (A.aggs) return A.aggs;
    var out = [];
    A.feed.sels.forEach(function (sel) {
      var take = function (s, e, alias) {
        exprScan(A, s, e).aggs.forEach(function (g) {
          var refs = [], unresolved = false, ambiguous = [];
          exprScan(A, g.argS, g.argE).refs.forEach(function (r) {
            var rr = resolve(A, sel, r.parts);
            if (rr.refs.length) rr.refs.forEach(function (x) { refs.push({ table: x.table, column: x.column, src: x.src, at: r }); });
            else { unresolved = true; if (rr.ambiguous) ambiguous.push(rr); }
          });
          out.push(Object.assign({}, g, { sel: sel, refs: refs, unresolved: unresolved, ambiguous: ambiguous, alias: alias || '', fam: fam(g.fn) }));
        });
      };
      sel.items.forEach(function (it) { if (!it.star) take(it.exprS, it.exprE, it.aliasKey); });
      if (sel.having) take(sel.having.s, sel.having.e, '');
    });
    A.aggs = out;
    return out;
  }
  function aliasLike(alias, m) {
    if (!alias) return false;
    var a = alias.replace(/[^a-z0-9]+/g, '');
    return [m.name].concat(m.synonyms || []).some(function (n) { var b = n.toLowerCase().replace(/[^a-z0-9]+/g, ''); return b && (a === b || (b.length > 3 && a.indexOf(b) >= 0) || (a.length > 3 && b.indexOf(a) >= 0)); })
      || (/avg|average/.test(alias) && /average|avg/i.test(m.name));
  }
  function pickAggs(A, MM, m, used) {
    var all = sqlAggs(A).filter(function (g) { return g.fn !== 'list'; });
    return MM.aggs.map(function (ca) {
      var best = null, bestScore = -1;
      all.forEach(function (sa) {
        if (used.indexOf(sa) >= 0) return;
        var sc = 0;
        if (sa.fn === ca.fn) sc += 3; else if (sa.fam === ca.fam) sc += 2;
        sa.refs.forEach(function (r) { if (ca.refs.some(function (c) { return c.table === r.table && c.column === r.column; })) sc += 4; else if (ca.refs.some(function (c) { return c.table === r.table; })) sc += 1; });
        if (aliasLike(sa.alias, m)) sc += 3;
        if (sc > bestScore) { best = sa; bestScore = sc; }
      });
      if (best && (bestScore >= 2 || all.length === 1)) { used.push(best); return best; }
      return null;
    });
  }

  function scansOf(A, table) { return A.feed.scans.filter(function (sc) { return sc.src.key === table; }); }
  function aliasText(A, src) {
    if (src.aliasTok != null) return A.T[src.aliasTok].v;
    if (src.nameS != null) return textOf(A, src.nameS, src.nameE);
    return src.key;
  }

  /** Required filter -> one check row, plus what a fix could do. */
  function filterCheck(A, canon, m, fm, conds, subConds, measureTables) {
    var f = fm.f, label = (f.keepsOut ? f.keepsOut : 'rows outside ' + fm.text);
    var row = check('filter:' + fm.text, 'Filters', 'Required filter: ' + fm.text, 'unsure', '', { canon: fm.text + (f.keepsOut ? '\n-- keeps out ' + f.keepsOut : ''), keepsOut: f.keepsOut || '' });
    if (!fm.ok) { row.why = 'Canon couldn\u2019t read this filter in the definition - check it by hand, or rewrite it as table.column = value.'; return row; }
    var T = fm.ref.table, c = fm.ref.column;
    var scans = scansOf(A, T);
    if (!scans.length) {
      row.verdict = 'missing';
      row.why = 'The SQL never reads ' + T + ', so ' + fm.text + ' can\u2019t apply' + (f.keepsOut ? ' - ' + f.keepsOut + ' are counted.' : '.');
      row.label = f.keepsOut ? f.keepsOut + ' included' : 'no ' + fm.text;
      row.fix = { kind: 'none', why: f.keepsOut ? cap(f.keepsOut) + ': the SQL would need to join ' + T + ' first.' : fm.text + ': the SQL would need to join ' + T + ' first.' };
      var inSub = subConds.filter(function (cd) { return cd.targets.some(function (t) { return t.col === c; }); })[0];
      if (inSub) { row.verdict = 'unsure'; row.why = 'Only a subquery tests ' + c + ' (line ' + lineOf(A, A.T[inSub.s].s) + ') - check by hand that it keeps out the same rows.'; row.sql = frag(A, inSub.s, inSub.e); row.label = null; row.fix = null; }
      return row;
    }
    var per = scans.map(function (sc) {
      var hits = conds.filter(function (cd) { return cd.targets.some(function (t) { return targetHits(t, sc.src, c); }); });
      var res = { scan: sc, hits: hits, state: 'missing', cond: null, why: '' };
      for (var k = 0; k < hits.length; k++) {
        var cd = hits[k], tg = cd.targets.filter(function (t) { return targetHits(t, sc.src, c); })[0];
        if (tg.inOr || cd.pred.form === 'or') { res.state = 'different'; res.cond = cd; res.why = 'it is inside an OR, so rows that match the other side get through'; continue; }
        if (cd.origin === 'having') { res.state = 'unsure'; res.cond = cd; res.why = 'it is in HAVING, which filters groups, not rows'; continue; }
        if (tg.complex) { if (res.state === 'missing') { res.state = 'unsure'; res.cond = cd; res.why = 'it tests ' + c + ' inside an expression Canon can\u2019t compare'; } continue; }
        var eq = equivalent(fm.pred, cd.pred);
        if (eq.ok) {
          if (cd.origin === 'on' && cd.onSrc && cd.onSrc.optional && measureTables.indexOf(T) < 0) { res.state = 'different'; res.cond = cd; res.why = 'it is in a LEFT JOIN\u2019s ON, which changes what is joined, not which rows are counted'; continue; }
          if (sc.optional && measureTables.indexOf(T) < 0 && cd.origin === 'on') { res.state = 'unsure'; res.cond = cd; res.why = T + ' is on the far side of an outer join'; continue; }
          res.state = 'match'; res.cond = cd; res.note = eq.note || ''; break;
        }
        if (eq.unsure) { if (res.state === 'missing') { res.state = 'unsure'; res.cond = cd; res.why = eq.why; } continue; }
        if (res.state === 'missing' || res.state === 'unsure') { res.state = 'different'; res.cond = cd; res.why = eq.why; res.opposite = eq.opposite; }
      }
      return res;
    });
    var states = per.map(function (p) { return p.state; });
    var first = function (st) { return per.filter(function (p) { return p.state === st; })[0]; };
    if (states.every(function (s) { return s === 'match'; })) {
      var mp = per[0];
      row.verdict = 'match';
      row.sql = frag(A, mp.cond.s, mp.cond.e);
      var unq = function (x) { return norm(x).replace(/(^|[^a-z0-9_])[a-z_][a-z0-9_]*\./g, '$1'); };
      var sameText = unq(textOf(A, mp.cond.s, mp.cond.e)) === unq(fm.text);
      row.why = (sameText ? 'Applied' : 'Applied as ' + textOf(A, mp.cond.s, mp.cond.e).replace(/\s+/g, ' ').slice(0, 80) + ' - the same rows') + (per.length > 1 ? ', everywhere ' + T + ' is read.' : '.') + (mp.note ? ' ' + mp.note : '');
      return row;
    }
    var d = first('different');
    if (d) {
      row.verdict = 'different';
      row.sql = frag(A, d.cond.s, d.cond.e);
      row.why = 'The SQL tests ' + c + ', but ' + d.why + '.';
      row.label = f.keepsOut ? f.keepsOut + (d.opposite ? ' only' : ' filter is different') : fm.text + ' is different';
      row.fix = { kind: 'none', why: (f.keepsOut ? cap(f.keepsOut) : fm.text) + ': the SQL already tests ' + c + ' differently - change it by hand.' };
      return row;
    }
    var u = first('unsure');
    if (u && states.indexOf('missing') < 0) { row.verdict = 'unsure'; row.sql = frag(A, u.cond.s, u.cond.e); row.why = 'The SQL tests ' + c + ', but ' + u.why + ' - check it by hand.'; return row; }
    var miss = per.filter(function (p) { return p.state === 'missing'; });
    var okSome = per.filter(function (p) { return p.state === 'match'; });
    row.verdict = okSome.length ? 'different' : 'missing';
    row.why = okSome.length
      ? 'Applied where ' + T + ' is read on line ' + lineOf(A, A.T[okSome[0].scan.src.s].s) + ', but not where it is read again on line ' + lineOf(A, A.T[miss[0].scan.src.s].s) + '.'
      : 'Nothing in the SQL tests ' + c + (f.keepsOut ? ', so ' + f.keepsOut + ' are counted.' : '.');
    row.sql = { text: textOf(A, miss[0].scan.src.s, miss[0].scan.src.e).replace(/\s+$/, ''), line: lineOf(A, A.T[miss[0].scan.src.s].s), note: 'where ' + T + ' is read' };
    row.label = f.keepsOut ? f.keepsOut + ' included' : 'no ' + fm.text;
    row.fix = { kind: 'addFilter', fm: fm, scans: miss.map(function (p) { return p.scan; }) };
    return row;
  }
  function singular(t) { return /ies$/.test(t) ? t.slice(0, -3) + 'y' : (/(ss|us)$/.test(t) ? t : t.replace(/s$/, '')); }
  function norm(s) { return String(s).toLowerCase().replace(/\s+/g, ' ').replace(/\s*([=<>!(),])\s*/g, '$1').trim(); }

  /** The SQL date filters and time groupings, with the base column each uses. */
  function dateUses(A, conds, hostSels, canonDate) {
    var uses = [];
    conds.forEach(function (cd) {
      if (cd.origin === 'having') return;
      cd.targets.forEach(function (t) {
        var p = t.pred || cd.pred;
        if (t.join || !p) return;
        var isDateCond = false, base = t.refs[0] || null, colName = base ? base.column : t.col;
        var temporal = isTemporalName(colName) || (canonDate && base && base.table === canonDate.table && base.column === canonDate.column) || (canonDate && colName === canonDate.column);
        var dateish = function (o) { return o && o.lit && (o.lit.t === 'dateexpr' || o.lit.t === 'param' || (o.lit.t === 'str' && o.lit.date)); };
        if (p.form === 'range') isDateCond = dateish(p.lo) || dateish(p.hi) || (temporal && (p.lo.lit || p.hi.lit));
        else if (p.form === 'cmp') isDateCond = dateish(p.other) || (temporal && p.other && p.other.lit && (p.other.lit.t !== 'num' || (t.opnd && t.opnd.part)));
        else if (p.form === 'set' && t.opnd && t.opnd.part) isDateCond = true;
        if (!isDateCond) return;
        uses.push({ kind: 'filter', cond: cd, target: t, pred: p, refs: t.refs, col: colName, zones: zonesOfTarget(A, t).concat(zonesIn(A, cd.s, cd.e), offsetZones(p)), sel: cd.sel });
      });
    });
    hostSels.forEach(function (sel) {
      groupExprs(A, sel).forEach(function (g) {
        var sc = exprScan(A, g.s, g.e);
        sc.refs.forEach(function (r) {
          var rr = resolve(A, sel, r.parts);
          var viaFn = hasDateFn(A, g.s, g.e) || (rr.hops || []).some(function (h) { return hasDateFn(A, h.s, h.e); });
          var b = rr.refs[0];
          if (!b || !viaFn || !isTemporalName(b.column) && !(canonDate && b.column === canonDate.column)) return;
          var z = zonesIn(A, g.s, g.e);
          (rr.hops || []).forEach(function (h) { z = z.concat(zonesIn(A, h.s, h.e)); });
          uses.push({ kind: 'group', g: g, refs: rr.refs, col: b.column, zones: z, sel: sel, ref: r, hops: rr.hops || [] });
        });
      });
    });
    return uses;
  }
  function offsetZones(p) {
    var out = [];
    [p.lo, p.hi, p.other].forEach(function (o) { if (o && o.lit && o.lit.date && o.lit.date.offset) out.push(o.lit.date.offset.indexOf('/') > 0 ? normZone(o.lit.date.offset) : 'offset'); });
    return out;
  }
  /** GROUP BY expressions with positions and select-list aliases resolved. */
  function groupExprs(A, sel) {
    var out = [];
    if (sel.groupAll) { sel.items.forEach(function (it) { if (!it.star && !exprScan(A, it.exprS, it.exprE).aggs.length) out.push({ s: it.exprS, e: it.exprE, item: it }); }); return out; }
    sel.groupBy.forEach(function (g) {
      var T = A.T;
      if (g.e - g.s === 1 && T[g.s].t === 'number') { var it = sel.items[T[g.s].n - 1]; if (it && !it.star) out.push({ s: it.exprS, e: it.exprE, item: it, at: g }); return; }
      if (g.e - g.s === 1 && (T[g.s].t === 'word' || T[g.s].t === 'qident')) {
        var k = idKey(T[g.s]);
        var al = sel.items.filter(function (x) { return x.aliasKey === k && !(x.single && x.single.col === k); })[0];
        var isSrcCol = sel.flat.some(function (src) { return srcHasCol(A, src, k) === true; });
        if (al && !isSrcCol) { out.push({ s: al.exprS, e: al.exprE, item: al, at: g }); return; }
      }
      out.push({ s: g.s, e: g.e, at: g });
    });
    return out;
  }

  /** Tables a select joins, through derived tables that are not aggregated
   *  (those keep their own joins' grain). */
  function joinedTables(A, sel, depth) {
    var out = [], notes = [];
    depth = depth || 0;
    sel.flat.forEach(function (src) {
      if (src.kind === 'table') { out.push({ table: src.key, src: src }); return; }
      if (!src.query || depth > 12) return;
      src.query.selects.forEach(function (s0) {
        var aggregated = s0.groupBy.length || s0.groupAll || s0.distinct || (s0.items.some(function (it) { return !it.star && exprScan(A, it.exprS, it.exprE).aggs.length; }));
        if (aggregated) { notes.push(src); return; }
        var inner = joinedTables(A, s0, depth + 1);
        out = out.concat(inner.tables); notes = notes.concat(inner.preAgg);
      });
    });
    return { tables: out, preAgg: notes };
  }
  /** Is there a path from table P to table X that steps from a "one" side to
   *  a "many" side? -> {fan, path} or null when the notes do not connect them. */
  function fanPath(S, P, X) {
    if (P === X) return { fan: false, path: [P] };
    var queue = [[P, [P], false]], seen = {};
    seen[P] = 1;
    while (queue.length) {
      var cur = queue.shift();
      for (var i = 0; i < S.rel.length; i++) {
        var r = S.rel[i], next = null, fanStep = false;
        if (r.one.table === cur[0]) { next = r.many.table; fanStep = true; }
        else if (r.many.table === cur[0]) next = r.one.table;
        if (!next || seen[next]) continue;
        var path = cur[1].concat(next), fan = cur[2] || fanStep;
        if (next === X) return { fan: fan, path: path };
        seen[next] = 1;
        queue.push([next, path, fan]);
      }
    }
    return null;
  }

  /** The selects that feed `sel` (FROM sources and scalar subqueries in its
   *  list), itself included. */
  function upstreamOf(sel, seen) {
    seen = seen || new Set();
    if (seen.has(sel)) return seen;
    seen.add(sel);
    sel.flat.forEach(function (src) { if (src.query) src.query.selects.forEach(function (x) { upstreamOf(x, seen); }); });
    sel.subs.forEach(function (x) { if (x.inList) x.query.selects.forEach(function (y) { upstreamOf(y, seen); }); });
    return seen;
  }
  /** What a metric's own aggregate depends on: the selects upstream of where
   *  it is computed, and those downstream of it (an outer WHERE on its
   *  groups) - not a sibling subquery computing another metric. */
  function relevantSels(A, hostSels) {
    var keepSet = new Set();
    hostSels.forEach(function (h) { upstreamOf(h).forEach(function (x) { keepSet.add(x); }); });
    A.feed.sels.forEach(function (x) { var up = upstreamOf(x); if (hostSels.some(function (h) { return up.has(h); })) keepSet.add(x); });
    return A.feed.sels.filter(function (x) { return keepSet.has(x); });
  }

  function checkMetric(A, canon, m, how, ask, used, conds, subConds) {
    var out = { id: m.id, name: m.name, how: how.how, phrase: how.phrase || '', checks: [], notChecked: [], definition: m };
    var MM = measureModel(canon, m);
    var picks = MM.ok ? pickAggs(A, MM, m, used) : [];
    var measureTables = [];
    MM.aggs.forEach(function (a) { a.refs.forEach(function (r) { if (measureTables.indexOf(r.table) < 0) measureTables.push(r.table); }); });
    if (!measureTables.length) measureTables = MM.tables.slice(0, 1);
    var S = A.schema;

    /* ---- source and aggregation ---- */
    var srcRow = check('source', 'Source', 'Source', 'unsure', '', { canon: 'Measure: ' + m.measure });
    var aggRow = check('aggregation', 'Aggregation', 'Aggregation', 'unsure', '', { canon: 'Measure: ' + m.measure });
    if (!MM.ok) {
      srcRow.why = 'Canon couldn\u2019t find an aggregate (SUM, COUNT, AVG...) in this metric\u2019s measure - fix the definition to check against it.';
      aggRow = null;
    } else if (!picks.some(Boolean)) {
      srcRow.why = sqlAggs(A).length ? 'None of the SQL\u2019s aggregates reads what this measure reads - check by hand which column is meant.' : 'The SQL has no aggregate (SUM, COUNT, AVG...), so it lists rows rather than computing ' + m.name + '.';
      srcRow.verdict = sqlAggs(A).length ? 'unsure' : 'different';
      if (srcRow.verdict === 'different') srcRow.label = 'no aggregate for ' + m.name;
      aggRow = null;
    } else {
      var srcBad = [], srcUnsure = [], frags = [];
      MM.aggs.forEach(function (ca, i) {
        var sa = picks[i];
        if (!sa) return;
        frags.push(textOf(A, sa.s, sa.e));
        if (ca.star) { if (!sa.star && !sa.refs.length) srcUnsure.push(textOf(A, sa.s, sa.e)); return; }
        if (sa.star) { if (!ca.distinct) srcBad.push({ got: 'every row (' + textOf(A, sa.s, sa.e) + ')', want: ca.refs.map(refName).join(', ') }); return; }
        if (!sa.refs.length) { srcUnsure.push(textOf(A, sa.s, sa.e)); return; }
        var want = ca.refs.map(refName).sort(), got = sa.refs.map(refName).filter(function (v, k, arr) { return arr.indexOf(v) === k; }).sort();
        var missingCols = want.filter(function (w) { return got.indexOf(w) < 0; });
        if (missingCols.length) srcBad.push({ got: got.join(' and '), want: want.join(' and ') });
      });
      srcRow.sql = { text: frags.join('   \u2026   '), line: lineOf(A, A.T[picks.filter(Boolean)[0].s].s) };
      if (srcBad.length) {
        srcRow.verdict = 'different';
        srcRow.why = srcBad.map(function (b) { return 'Reads ' + b.got + ' where the canon reads ' + b.want + '.'; }).join(' ');
        srcRow.label = srcBad.map(function (b) { return b.got + ' instead of ' + b.want; }).join(', ');
        srcRow.fix = { kind: 'none', why: 'Source: ' + srcBad[0].got + ' and ' + srcBad[0].want + ' are different columns - pick the canon\u2019s by hand.' };
      } else if (srcUnsure.length) {
        srcRow.why = 'Canon couldn\u2019t tell which table ' + srcUnsure[0] + ' reads - qualify the column (table.column) or add the table\u2019s columns to the schema notes.';
      } else {
        srcRow.verdict = 'match';
        var cols = [];
        MM.aggs.forEach(function (ca) { ca.refs.forEach(function (r) { if (cols.indexOf(refName(r)) < 0) cols.push(refName(r)); }); });
        srcRow.why = cols.length ? 'Reads ' + words(cols) + ', as defined.' : 'Counts the rows the canon counts.';
      }
      // aggregation
      var aggBad = [];
      MM.aggs.forEach(function (ca, i) {
        var sa = picks[i];
        if (!sa) return;
        if (sa.fam !== ca.fam) aggBad.push(AGG_WORD[sa.fam] + ' instead of ' + AGG_WORD[ca.fam]);
      });
      var single = picks.filter(Boolean);
      aggRow.sql = srcRow.sql;
      if (MM.ratio && single.length < 2) {
        var sa0 = single[0];
        aggRow.verdict = 'different';
        aggRow.why = 'The canon divides two aggregates (' + MM.aggs.map(function (a) { return a.text; }).join(' / ') + '); the SQL uses one, ' + textOf(A, sa0.s, sa0.e) + '.' + (sa0.fam === 'avg' ? ' An average of rows equals the canon only when every row is one ' + (m.grain ? m.grain.replace(/^(per|one row per)\s+/i, '') : 'unit') + ' and holds the same amount.' : '');
        aggRow.label = (AGG_WORD[sa0.fam] || 'one aggregate') + ' instead of a ratio';
      } else if (aggBad.length) {
        aggRow.verdict = 'different';
        aggRow.why = aggBad.map(cap).join('; ') + ' - the number means something else.';
        aggRow.label = aggBad.join(', ');
      } else {
        aggRow.verdict = 'match';
        aggRow.why = MM.ratio ? 'Divides ' + single.map(function (s) { return AGG_WORD[s.fam]; }).join(' by ') + ', as the canon does.' : AGG_WORD[single[0].fam] + ', as the canon does.';
        if (single.some(function (s) { return s.window; })) { aggRow.verdict = 'unsure'; aggRow.why = 'It is a window function (OVER ...), which repeats a total on every row - check the rows it returns.'; }
        if (single.some(function (s) { return s.filtered; }) && aggRow.verdict === 'match') aggRow.why += ' It has a FILTER / IF condition of its own - its rows are checked below only through WHERE.';
      }
    }
    out.checks.push(srcRow);
    if (aggRow) out.checks.push(aggRow);

    /* ---- required filters ---- */
    var fms = [];
    (m.filters || []).forEach(function (f) { filterModel(canon, m, f).forEach(function (fm) { fms.push(fm); }); });
    fms.forEach(function (fm) { out.checks.push(filterCheck(A, canon, m, fm, conds, subConds, measureTables)); });
    if (!fms.length) out.notChecked.push('filters (this metric has no required filters)');

    /* ---- dates ---- */
    var hostSels = [];
    picks.forEach(function (p) { if (p && hostSels.indexOf(p.sel) < 0) hostSels.push(p.sel); });
    if (!hostSels.length && A.root.selects[0]) hostSels.push(A.root.selects[0]);
    var dateRef = m.date && m.date.column ? refModel(canon, m, m.date.column) : null;
    var tz = m.date && m.date.tz ? normZone(m.date.tz) : '';
    var rel = relevantSels(A, hostSels), relConds = conds.filter(function (cd) { return rel.indexOf(cd.sel) >= 0; });
    var uses = dateUses(A, relConds, rel, dateRef);
    var asked = ask.time || ask.grain;
    var dateLine = dateRef ? 'Date: ' + m.date.column + (m.date.tz ? ' (' + m.date.tz + ')' : '') : '';
    if (!dateRef) out.notChecked.push('dates (no date column in the definition)');
    else if (!uses.length) {
      if (asked) out.checks.push(check('date', 'Date', 'Date column', 'missing', 'The question asks for ' + (ask.time ? ask.time.label : 'a split by ' + ask.grain) + ', but the SQL has no date filter' + (ask.grain ? ' or date grouping' : '') + ' - it covers all time.', { canon: dateLine, label: 'no date range' }));
      else out.notChecked.push('dates (the question names no period)');
    } else {
      // which column
      var wrong = uses.filter(function (u) { var b = u.refs[0]; return b ? !(b.table === dateRef.table && b.column === dateRef.column) : u.col !== dateRef.column; });
      var unres = uses.filter(function (u) { return !u.refs.length; });
      var colRow = check('date', 'Date', 'Date column', 'match', '', { canon: dateLine });
      var shown = wrong[0] || uses[0];
      colRow.sql = shown.kind === 'filter' ? frag(A, shown.cond.s, shown.cond.e) : frag(A, shown.g.s, shown.g.e);
      if (wrong.length && wrong[0].refs.length) {
        var wb = wrong[0].refs[0];
        colRow.verdict = 'different';
        colRow.why = (wrong[0].kind === 'filter' ? 'Filters' : 'Groups') + ' on ' + refName(wb) + '; the canon dates ' + m.name + ' by ' + refName(dateRef) + '.' + (/creat/.test(wb.column) && /paid|complet|ship/.test(dateRef.column) ? ' Orders made in the period but paid later land in the wrong period.' : '');
        colRow.label = wb.column + ' instead of ' + dateRef.column;
        colRow.fix = { kind: 'swapDate', uses: wrong, dateRef: dateRef };
      } else if (unres.length === uses.length) {
        colRow.verdict = 'unsure';
        colRow.why = 'Canon couldn\u2019t tell which table ' + uses[0].col + ' comes from - qualify it (table.column).';
      } else colRow.why = 'Uses ' + refName(dateRef) + ', as defined.';
      out.checks.push(colRow);
      // time zone
      if (tz && tz !== 'utc') {
        var onCanon = uses.filter(function (u) { return u.refs[0] && u.refs[0].table === dateRef.table && u.refs[0].column === dateRef.column; });
        var judge = onCanon.length ? onCanon : uses;
        var states = judge.map(function (u) {
          if (u.zones.indexOf(tz) >= 0 || u.zones.indexOf('offset') >= 0) return 'match';
          var other = u.zones.filter(function (z) { return z !== 'utc' && !/^[+-]00:?00$/.test(z); });
          if (other.length) return 'different:' + other[0];
          if (u.kind === 'filter' && u.pred && [u.pred.lo, u.pred.hi, u.pred.other].some(function (o) { return o && o.lit && (o.lit.t === 'param' || o.lit.t === 'dateexpr'); }) && !(u.pred.lo && u.pred.lo.lit && u.pred.lo.lit.date)) return 'unsure';
          return 'missing';
        });
        var tzRow = check('timezone', 'Date', 'Time zone', 'match', '', { canon: dateLine });
        var bad = judge[states.findIndex(function (s) { return s !== 'match'; })] || judge[0];
        tzRow.sql = bad.kind === 'filter' ? frag(A, bad.cond.s, bad.cond.e) : frag(A, bad.g.s, bad.g.e);
        var diff = states.filter(function (s) { return s.indexOf('different') === 0; })[0];
        if (diff) { tzRow.verdict = 'different'; tzRow.why = 'Converts to ' + diff.slice(10) + '; the canon\u2019s days are ' + m.date.tz + '.'; tzRow.label = 'days in ' + diff.slice(10) + ', not ' + m.date.tz; }
        else if (states.indexOf('missing') >= 0) { tzRow.verdict = 'missing'; tzRow.why = 'Compares ' + refName(dateRef) + ' as stored (usually UTC) with day boundaries. The canon\u2019s days run midnight to midnight in ' + m.date.tz + ', so orders near midnight land on the wrong day - or in the wrong quarter.'; tzRow.label = 'days in UTC, not ' + m.date.tz; tzRow.fix = { kind: 'none', why: 'Time zone: converting depends on your database (AT TIME ZONE, CONVERT_TZ, DATETIME(..., zone)) - add it by hand.' }; }
        else if (states.indexOf('unsure') >= 0) { tzRow.verdict = 'unsure'; tzRow.why = 'The range comes from a parameter or a relative expression - check its days are ' + m.date.tz + '.'; }
        else tzRow.why = 'Converted to ' + m.date.tz + ' before comparing or grouping.';
        out.checks.push(tzRow);
      } else if (!tz) out.notChecked.push('time zone (none in the definition)');
      // range
      var rangeRow = rangeCheck(A, uses.filter(function (u) { return u.kind === 'filter'; }), dateRef, ask, dateLine);
      if (rangeRow) out.checks.push(rangeRow);
    }

    /* ---- grain and fan-out ---- */
    out.checks.push(grainCheck(A, canon, m, MM, picks, S));

    /* ---- dimensions ---- */
    var dimRow = dimensionCheck(A, m, MM, hostSels, dateRef, ask, canon);
    if (dimRow) out.checks.push(dimRow); else out.notChecked.push((m.dimensions || []).length ? 'dimensions (the SQL doesn\u2019t group)' : 'dimensions (none listed in the definition)');

    /* ---- other filters ---- */
    var known = fms.filter(function (fm) { return fm.ref; }).map(function (fm) { return fm.ref.column; });
    var dimCols = (m.dimensions || []).map(function (d) { var r = refOfText(d); return r ? r.column : ''; });
    var extra = relConds.filter(function (cd) {
      if (cd.pred.form === 'join' || cd.origin === 'having') return false;
      if (uses.some(function (u) { return u.cond === cd; })) return false;
      if (!cd.targets.length) return false;
      return cd.targets.every(function (t) { return !t.join && known.indexOf(t.col) < 0 && dimCols.indexOf(t.col) < 0 && !(dateRef && t.col === dateRef.column); });
    });
    if (extra.length) {
      out.checks.push(check('extra', 'Filters', 'Other filters', 'unsure', 'Not in the canon for ' + m.name + ': ' + extra.slice(0, 3).map(function (cd) { return textOf(A, cd.s, cd.e).replace(/\s+/g, ' ').slice(0, 80); }).join('; ') + (extra.length > 3 ? ' and ' + (extra.length - 3) + ' more' : '') + '. Fine if the question asked for it; otherwise it changes the number.', { sql: frag(A, extra[0].s, extra[0].e), canon: 'Required filters: ' + (fms.length ? fms.map(function (x) { return x.text; }).join(', ') : 'none') }));
    }
    return out;
  }

  function rangeCheck(A, filterUses, dateRef, ask, dateLine) {
    if (!filterUses.length) return null;
    var row = check('range', 'Date', 'Date range', 'match', '', { canon: dateLine + '. Ranges are half-open: >= the first day AND < the day after the last.' });
    var traps = [], lo = null, hi = null, relative = false;
    filterUses.forEach(function (u) {
      var p = u.pred, o = u.target.opnd, onDay = (o && (o.day || o.trunc === 'day')) || isDateTyped(u.col) || (o && o.part);
      if (o && o.part) { relative = true; return; }
      var lit = function (x) { return x && x.lit && x.lit.t === 'str' && x.lit.date ? x.lit.date : null; };
      if (p.form === 'range' && !p.neg) {
        var a = lit(p.lo), b = lit(p.hi);
        if (!a || !b) { relative = true; return; }
        lo = a.day;
        if (!onDay && !b.time) { traps.push({ u: u, kind: 'between', day: b.day }); hi = b.day; }
        else if (!onDay && b.time === '23:59:59' && !b.frac) { traps.push({ u: u, kind: 'second', day: b.day }); hi = addDays(b.day, 1); }
        else hi = addDays(b.day, 1);
        return;
      }
      if (p.form === 'cmp') {
        var d = lit(p.other);
        if (!d) { relative = true; return; }
        if (p.op === '>=') lo = d.time && d.time !== '00:00:00' ? d.day + 'T' : d.day;
        else if (p.op === '>') lo = onDay || (d.time === '23:59:59') ? addDays(d.day, 1) : d.day + 'T';
        else if (p.op === '<') hi = d.time && d.time !== '00:00:00' ? addDays(d.day, 1) : d.day;
        else if (p.op === '<=') {
          if (!onDay && !d.time) { traps.push({ u: u, kind: 'lte', day: d.day }); hi = d.day; }
          else if (!onDay && d.time === '23:59:59' && !d.frac) { traps.push({ u: u, kind: 'second', day: d.day }); hi = addDays(d.day, 1); }
          else hi = addDays(d.day, 1);
        } else if (p.op === '=' && onDay) { lo = d.day; hi = addDays(d.day, 1); }
      }
    });
    var shown = traps[0] ? traps[0].u : filterUses[0];
    row.sql = frag(A, shown.cond.s, shown.cond.e);
    if (traps.length) {
      var t0 = traps[0];
      row.verdict = 'different';
      if (t0.kind === 'second') {
        row.why = 'Ends at ' + t0.day + ' 23:59:59, so anything stamped in the last second (23:59:59.5) is lost. Use < the next day instead.';
        row.label = 'the last second of the range is cut off';
      } else {
        row.why = (t0.kind === 'between' ? 'BETWEEN ... AND \u2019' + t0.day + '\u2019' : '<= \u2019' + t0.day + '\u2019') + ' on a timestamp stops at 00:00 on ' + niceDay(t0.day) + ', so that whole day is left out. Use >= the first day AND < ' + niceDay(addDays(t0.day, 1)) + '.';
        row.label = 'the last day (' + niceDay(t0.day) + ') is cut off';
      }
      row.fix = { kind: 'between', traps: traps };
      return row;
    }
    if (relative || !lo || !hi || /T$/.test(lo)) {
      row.verdict = 'unsure';
      row.why = 'The range is relative (now(), date_trunc, a parameter) or split by date parts - check it covers ' + (ask.time ? ask.time.label : 'the period meant') + '.';
      return row;
    }
    var got = niceRange(lo, hi);
    if (ask.time && ask.time.exact) {
      if (lo === ask.time.start && hi === ask.time.end) { row.why = got + ' - exactly ' + ask.time.label + ', half-open, nothing cut off.'; return row; }
      row.verdict = 'different';
      row.why = 'Covers ' + got + '; ' + ask.time.label + ' is ' + niceRange(ask.time.start, ask.time.end) + '.';
      row.label = 'a different date range than asked';
      return row;
    }
    row.why = 'Covers ' + got + ', half-open - nothing cut off.';
    return row;
  }

  function grainCheck(A, canon, m, MM, picks, S) {
    var row = check('grain', 'Grain', 'Grain and double counting', 'match', '', { canon: (m.grain ? 'Grain: ' + m.grain + '. ' : '') + 'Measure: ' + m.measure });
    var any = false, problems = [], unsure = [], notes = [];
    MM.aggs.forEach(function (ca, i) {
      var sa = picks[i];
      if (!sa) return;
      any = true;
      var jt = joinedTables(A, sa.sel);
      var tables = jt.tables.map(function (x) { return x.table; });
      if (jt.preAgg.length) notes.push('It joins a pre-aggregated subquery; Canon assumes it has one row per key.');
      var P = sa.star ? (ca.refs[0] ? ca.refs[0].table : MM.tables[0]) : (sa.refs[0] ? sa.refs[0].table : null);
      if (!P) return;
      var others = tables.filter(function (t, k) { return t !== P && tables.indexOf(t) === k; });
      var fanned = [], unknown = [];
      others.forEach(function (X) {
        var fp = fanPath(S, P, X);
        if (!fp) unknown.push(X); else if (fp.fan) fanned.push({ X: X, path: fp.path });
      });
      var safeAgg = sa.fn === 'countd' || sa.fn === 'min' || sa.fn === 'max';
      var key = (S.tables[P] && S.tables[P].key) || (ca.refs[0] && ca.refs[0].table === P ? ca.refs[0].column : 'id');
      if (sa.star && tables.indexOf(P) < 0) {
        problems.push({ why: textOf(A, sa.s, sa.e) + ' counts ' + (tables[0] || 'the joined') + ' rows, not ' + P + '.', label: 'counts ' + (tables[0] || 'other') + ' rows, not ' + P });
        return;
      }
      if (fanned.length && !safeAgg) {
        var f0 = fanned[0];
        var oneMany = f0.path.length > 1 ? f0.path[0] + ' \u2192 ' + f0.path.slice(1).join(' \u2192 ') : f0.X;
        var what = sa.fam === 'count' ? P + ' are counted once per ' + f0.X + ' row' : 'each ' + P + ' row is added once per ' + f0.X + ' row';
        problems.push({ why: 'The SQL joins ' + f0.X + ' (' + oneMany + ' is one-to-many) before ' + textOf(A, sa.s, sa.e) + ', so ' + what + '.' + (ca.fam === 'count' && ca.distinct ? ' The canon counts COUNT(DISTINCT ' + P + '.' + key + ').' : ''), label: 'double counting from the join to ' + f0.X, sa: sa, P: P, key: key, ca: ca });
        return;
      }
      if (sa.fn === 'sum' && sa.distinct) { unsure.push('SUM(DISTINCT ...) drops amounts that happen to be equal - two orders of $12 count once.'); return; }
      if (unknown.length && !safeAgg) unsure.push('The SQL joins ' + words(unknown) + ', and the schema notes don\u2019t say how ' + (unknown.length > 1 ? 'they relate' : 'it relates') + ' to ' + P + ' - add the relationship to check for double counting.');
      if (ca.fam === 'count' && ca.distinct && !sa.distinct && !unknown.length) notes.push(textOf(A, sa.s, sa.e) + ' counts one per ' + P + ' row here because nothing joined multiplies them; COUNT(DISTINCT ' + P + '.' + key + ') stays right if a join is added later.');
    });
    var firstPick = picks.filter(Boolean)[0];
    if (firstPick) row.sql = { text: textOf(A, firstPick.sel.from ? firstPick.sel.from.s : firstPick.s, firstPick.sel.from ? firstPick.sel.from.e : firstPick.e).replace(/\s+$/, ''), line: lineOf(A, A.T[(firstPick.sel.from || firstPick).s].s), note: 'what is joined' };
    if (!any) { row.verdict = 'unsure'; row.why = 'No aggregate to check.'; return row; }
    if (problems.length) {
      row.verdict = 'different';
      row.why = problems.map(function (p) { return p.why; }).join(' ');
      row.label = problems.map(function (p) { return p.label; }).filter(function (v, k, a) { return a.indexOf(v) === k; }).join(', ');
      var fx = problems.filter(function (p) { return p.sa && p.sa.fam === 'count' && !p.sa.distinct && p.ca.fam === 'count' && p.ca.distinct; });
      row.fix = fx.length ? { kind: 'countDistinct', items: fx } : { kind: 'none', why: 'Double counting: the join has to change - aggregate the many side first, or sum the column at its own grain.' };
      return row;
    }
    if (unsure.length) { row.verdict = 'unsure'; row.why = unsure.join(' '); return row; }
    row.why = 'No join multiplies the rows being ' + (MM.aggs[0] && MM.aggs[0].fam === 'count' ? 'counted' : 'added up') + '.' + (notes.length ? ' ' + notes.join(' ') : '');
    return row;
  }

  function dimensionCheck(A, m, MM, hostSels, dateRef, ask, canon) {
    var allowed = (m.dimensions || []).map(refOfText).filter(Boolean);
    var groups = [];
    hostSels.forEach(function (sel) { groupExprs(A, sel).forEach(function (g) { groups.push({ sel: sel, g: g }); }); });
    // outer selects that re-group a derived table count too
    A.feed.sels.forEach(function (sel) { if (hostSels.indexOf(sel) < 0 && sel.query === A.root) groupExprs(A, sel).forEach(function (g) { groups.push({ sel: sel, g: g }); }); });
    var askedDims = ask.dims || [];
    if (!allowed.length) return null;
    var row = check('dimensions', 'Dimensions', 'Dimensions', 'match', '', { canon: 'Allowed: ' + m.dimensions.join(', ') });
    var bad = [], unres = [], used = [];
    groups.forEach(function (x) {
      var sc = exprScan(A, x.g.s, x.g.e);
      if (!sc.refs.length) return;
      var dateFn = hasDateFn(A, x.g.s, x.g.e);
      sc.refs.forEach(function (r) {
        var rr = resolve(A, x.sel, r.parts);
        var viaFn = dateFn || (rr.hops || []).some(function (h) { return hasDateFn(A, h.s, h.e); });
        var b = rr.refs[0];
        if (!b) { unres.push(r.parts.join('.')); return; }
        if (viaFn || (dateRef && b.column === dateRef.column && b.table === dateRef.table)) return; // a time grain
        var ok = allowed.some(function (d) { return d.column === b.column && (!d.table || d.table === b.table); });
        if (ok) { if (used.indexOf(refName(b)) < 0) used.push(refName(b)); }
        else if (!bad.some(function (z) { return z.name === refName(b); })) bad.push({ name: refName(b), x: x });
      });
    });
    var missingAsked = askedDims.filter(function (w) {
      var hit = allowed.filter(function (d) { return w.replace(/\s+/g, '_') === d.column || w.replace(/s$/, '').replace(/\s+/g, '_') === d.column.replace(/s$/, '') || w.split(' ').pop() === d.column; })[0];
      return hit && used.indexOf(refName(hit)) < 0 && !used.some(function (u) { return u.split('.').pop() === hit.column; });
    });
    if (!groups.length && !missingAsked.length) return null;
    if (groups.length) row.sql = frag(A, groups[0].g.at ? groups[0].g.at.s : groups[0].g.s, groups[0].g.at ? groups[0].g.at.e : groups[0].g.e);
    if (bad.length) {
      row.verdict = 'different';
      row.sql = frag(A, bad[0].x.g.at ? bad[0].x.g.at.s : bad[0].x.g.s, bad[0].x.g.at ? bad[0].x.g.at.e : bad[0].x.g.e);
      row.why = 'Groups by ' + words(bad.map(function (b) { return b.name; })) + ', which ' + m.name + ' doesn\u2019t allow. Allowed: ' + m.dimensions.join(', ') + '.';
      row.label = 'grouped by ' + bad.map(function (b) { return b.name; }).join(', ') + ' (not allowed)';
      return row;
    }
    if (missingAsked.length) {
      row.verdict = 'missing';
      row.why = 'The question asks by ' + missingAsked.join(', ') + ', but the SQL doesn\u2019t group by it.';
      row.label = 'not grouped by ' + missingAsked.join(', ');
      return row;
    }
    if (unres.length && !used.length) { row.verdict = 'unsure'; row.why = 'Canon couldn\u2019t tell which table ' + unres[0] + ' comes from.'; return row; }
    row.why = used.length ? 'Groups by ' + words(used) + ' - allowed.' : 'Groups only by time - allowed.';
    return row;
  }

  /** Match by the SQL when the question names no metric: the measure's columns. */
  function matchBySql(A, canon) {
    var aggs = sqlAggs(A), out = [];
    ((canon && canon.metrics) || []).forEach(function (m) {
      var MM = measureModel(canon, m);
      if (!MM.ok) return;
      var score = 0;
      MM.aggs.forEach(function (ca) {
        aggs.forEach(function (sa) {
          var s = 0;
          sa.refs.forEach(function (r) { if (ca.refs.some(function (c) { return c.table === r.table && c.column === r.column; })) s += 4; });
          if (sa.fam === ca.fam && s) s += 2;
          if (aliasLike(sa.alias, m)) s += 4;
          if (s > score) score = s;
        });
      });
      if (score >= 4) out.push({ id: m.id, how: 'sql', score: score });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, 1);
  }

  /** The whole check: question + SQL against the canon. */
  function analyze(input, canon, opts) {
    opts = opts || {};
    var question = line(input && input.question, LIMITS.questionChars);
    var raw = str(input && input.sql);
    var res = { question: question, metrics: [], notes: [], verdict: null, fix: null, parsed: false, today: opts.today || '' };
    if (!raw.trim()) { res.verdict = { kind: 'none', line: 'Paste the SQL to check.' }; return res; }
    if (raw.length > LIMITS.sqlChars) { res.verdict = { kind: 'none', line: 'That SQL is over ' + LIMITS.sqlChars.toLocaleString('en-US') + ' characters - paste the one query you want checked.' }; return res; }
    var A = parseSql(raw, canon);
    res.sql = A.src;
    res.notes = A.notes.slice();
    if (!A.root || !A.root.selects.length) { res.verdict = { kind: 'none', line: 'That doesn\u2019t look like a SELECT query - paste the SQL the AI wrote.' }; return res; }
    res.parsed = true;
    var metrics = (canon && canon.metrics) || [];
    var byId = {};
    metrics.forEach(function (m) { byId[m.id] = m; });
    var chosen;
    if (Array.isArray(opts.metrics) && opts.metrics.length) chosen = opts.metrics.filter(function (id) { return byId[id]; }).map(function (id) { return { id: id, how: 'picked' }; });
    else {
      chosen = matchQuestion(question, canon);
      if (!chosen.length) chosen = matchBySql(A, canon);
    }
    res.matched = chosen.map(function (c) { return { id: c.id, how: c.how, phrase: c.phrase || '' }; });
    if (!chosen.length) {
      res.verdict = { kind: 'none', line: metrics.length ? 'No metric from the canon found in this question - pick the one it should be checked against.' : 'The canon has no metrics yet - add one to check against.', pick: true };
      return res;
    }
    var ask = { time: timeAsk(question, opts.today), grain: grainAsk(question), dims: dimAsk(question) };
    res.ask = { time: ask.time, grain: ask.grain, dims: ask.dims };
    var conds = condsOf(A, A.feed.sels), subConds = condsOf(A, A.feed.exprSels), used = [];
    chosen.forEach(function (c) { res.metrics.push(checkMetric(A, canon, byId[c.id], c, ask, used, conds, subConds)); });
    res.verdict = verdictOf(res.metrics);
    res.fix = suggestFix(A, res.metrics);
    return res;
  }

  function verdictOf(metrics) {
    var problems = [], unsure = 0, labels = [];
    metrics.forEach(function (m) {
      m.problems = 0; m.unsure = 0;
      m.checks.forEach(function (c) {
        if (c.verdict === 'missing' || c.verdict === 'different') {
          m.problems++;
          problems.push(c);
          var l = c.label || c.title.toLowerCase();
          if (labels.indexOf(l) < 0) labels.push(l);
        } else if (c.verdict === 'unsure') { m.unsure++; unsure++; }
      });
    });
    var names = metrics.map(function (m) { return m.name; });
    if (problems.length) {
      var shown = labels.slice(0, 3).join(', ') + (labels.length > 3 ? ' and ' + (labels.length - 3) + ' more' : '');
      return { kind: 'bad', problems: problems.length, unsure: unsure, labels: labels, line: plural(problems.length, 'problem') + (metrics.length > 1 ? ' across ' + words(names) : '') + ': ' + shown };
    }
    if (unsure) return { kind: 'unsure', problems: 0, unsure: unsure, labels: [], line: 'No problems found - ' + plural(unsure, 'thing') + ' to check by hand' };
    return { kind: 'ok', problems: 0, unsure: 0, labels: [], line: 'Matches the canon for ' + words(names) };
  }

  /* ================================================================== *
   * The fix: deterministic, only where it is safe, never applied
   * ================================================================== */

  function kwCase(A, word) {
    var t = A.T[A.root ? A.root.s : 0];
    return t && t.v && t.v === t.v.toLowerCase() ? word.toLowerCase() : word.toUpperCase();
  }
  function condFor(A, fm, scan) {
    // the canon's filter, with its table qualifier swapped for the alias the SQL uses
    var P = fm.P, text = fm.text, alias = aliasText(A, scan.src), base = P.T[fm.s].s, out = text, edits = [];
    var multi = scan.sel.flat.length > 1;
    exprScan(P, fm.s, fm.e).refs.forEach(function (r) {
      var rs = P.T[r.s].s - base, re = P.T[r.e - 1].e - base;
      if (r.parts.length >= 2) edits.push([rs, re, alias + '.' + P.T[r.e - 1].v]);
      else if (multi) edits.push([rs, re, alias + '.' + P.T[r.s].v]);
    });
    edits.sort(function (a, b) { return b[0] - a[0]; }).forEach(function (ed) { out = out.slice(0, ed[0]) + ed[2] + out.slice(ed[1]); });
    return out;
  }
  function endOfLine(src, at) {
    var nl = src.indexOf('\n', at), rest = src.slice(at, nl < 0 ? src.length : nl);
    return /^[ \t]*(--[^\n]*)?$/.test(rest) ? (nl < 0 ? src.length : nl) : at;
  }
  function indentOf(src, off) { var ls = src.lastIndexOf('\n', off - 1) + 1; return /^[ \t]*/.exec(src.slice(ls))[0]; }

  function suggestFix(A, metrics) {
    var T = A.T, src = A.src, edits = [], changes = [], skipped = [], seen = {};
    var bySel = new Map();
    metrics.forEach(function (m) {
      m.checks.forEach(function (c) {
        var f = c.fix;
        if (!f) return;
        if (f.kind === 'none') { if (!seen['n:' + f.why]) { seen['n:' + f.why] = 1; skipped.push(f.why); } return; }
        if (f.kind === 'addFilter') {
          f.scans.forEach(function (sc) {
            var k = 'f:' + sc.src.s + ':' + norm(f.fm.text);
            if (seen[k]) return;
            seen[k] = 1;
            if (!bySel.has(sc.sel)) bySel.set(sc.sel, []);
            bySel.get(sc.sel).push({ text: condFor(A, f.fm, sc), what: f.fm.f.keepsOut ? 'keeps out ' + f.fm.f.keepsOut : 'adds ' + f.fm.text });
          });
        }
        if (f.kind === 'swapDate') {
          f.uses.forEach(function (u) {
            var b = u.refs[0];
            if (!b) return;
            var ref = u.kind === 'filter' ? u.target.opnd.col : u.ref;
            if (!ref) return;
            var k = 'd:' + ref.s;
            if (seen[k]) return;
            seen[k] = 1;
            var replaceWith = null;
            if (b.table === f.dateRef.table && u.kind === 'filter') replaceWith = (ref.parts.length > 1 ? textOf(A, ref.s, ref.e - 1) : '') + f.dateRef.column;
            else if (b.table === f.dateRef.table && u.kind === 'group' && b.src && b.src.sel === u.sel) replaceWith = (ref.parts.length > 1 ? textOf(A, ref.s, ref.e - 1) : '') + f.dateRef.column;
            else {
              var sc = scansOf(A, f.dateRef.table).filter(function (x) { return x.sel === u.sel; })[0];
              if (sc && u.kind === 'filter') replaceWith = aliasText(A, sc.src) + '.' + f.dateRef.column;
            }
            if (b.src && b.src.sel !== u.sel && u.kind === 'group') replaceWith = null;
            if (!replaceWith) { var why = 'Date column: ' + refName(f.dateRef) + ' isn\u2019t read where the SQL uses ' + refName(b) + ' - change it by hand.'; if (!seen['n:' + why]) { seen['n:' + why] = 1; skipped.push(why); } return; }
            edits.push({ s: T[ref.s].s, e: T[ref.e - 1].e, text: replaceWith, what: 'uses ' + f.dateRef.column + ' instead of ' + b.column, at: T[ref.s].s });
          });
        }
        if (f.kind === 'between') {
          f.traps.forEach(function (tr) {
            var p = tr.u.pred, k = 'b:' + tr.u.cond.s;
            if (seen[k]) return;
            seen[k] = 1;
            var next = addDays(tr.day, 1);
            var bump = function (s) { return s.replace(/\d{4}-\d{2}-\d{2}(?:[ T]23:59:59)?/, next); };
            if (p.form === 'range') {
              var left = src.slice(T[p.opnd.s].s, T[p.at - 1].e);
              var loT = src.slice(T[p.lo.s].s, T[p.lo.e - 1].e), hiT = src.slice(T[p.hi.s].s, T[p.hi.e - 1].e);
              edits.push({ s: T[p.s].s, e: T[p.e - 1].e, text: left + ' >= ' + loT + ' ' + kwCase(A, 'AND') + ' ' + left + ' < ' + bump(hiT), what: 'a half-open range that keeps ' + niceDay(tr.day), at: T[p.s].s });
            } else if (p.form === 'cmp') {
              var opTok = null;
              for (var k2 = p.s; k2 < p.e; k2++) if (T[k2].t === 'op' && (T[k2].v === '<=' || T[k2].v === '>=')) { opTok = k2; break; }
              if (opTok === null) return;
              var litSide = p.other;
              var newOp = T[opTok].v === '<=' ? '<' : '>';
              edits.push({ s: T[opTok].s, e: T[opTok].e, text: newOp, what: '< the next day, which keeps ' + niceDay(tr.day), at: T[opTok].s });
              edits.push({ s: T[litSide.s].s, e: T[litSide.e - 1].e, text: bump(src.slice(T[litSide.s].s, T[litSide.e - 1].e)), what: '', at: T[litSide.s].s });
            }
          });
        }
        if (f.kind === 'countDistinct') {
          f.items.forEach(function (it) {
            var sa = it.sa, k = 'c:' + sa.s;
            if (seen[k]) return;
            seen[k] = 1;
            if (sa.star) {
              var sc = scansOf(A, it.P).filter(function (x) { return x.sel === sa.sel; })[0];
              if (!sc) return;
              var argNew = kwCase(A, 'DISTINCT') + ' ' + aliasText(A, sc.src) + '.' + it.key;
              edits.push({ s: T[sa.argS].s, e: T[sa.argE - 1].e, text: argNew, show: T[sa.s].v + '(' + argNew + ')', what: 'each ' + singular(it.P) + ' counted once', at: T[sa.argS].s });
            } else edits.push({ s: T[sa.argS].s, e: T[sa.argS].s, text: kwCase(A, 'DISTINCT') + ' ', show: T[sa.s].v + '(' + kwCase(A, 'DISTINCT') + ' ' + textOf(A, sa.argS, sa.argE) + ')', what: 'each ' + singular(it.P) + ' counted once', at: T[sa.argS].s });
          });
        }
      });
    });
    bySel.forEach(function (list, sel) {
      var AND = kwCase(A, 'AND'), WHERE = kwCase(A, 'WHERE');
      if (sel.where) {
        var last = T[sel.where.e - 1], at = endOfLine(src, last.e);
        // The last line ends in ';' or ')': add the new conditions before
        // that line instead, so the line itself is left alone.
        if (at === last.e && /^[ \t]*[;)]/.test(src.slice(last.e))) {
          var parts = splitBool(A, sel.where.s, sel.where.e, 'and');
          var namesIn = function (p) { var o = {}; for (var x = p[0]; x < p[1]; x++) if (T[x].t === 'word' && !RESERVED[T[x].n] && isTemporalName(T[x].n)) o[T[x].n] = 1; return o; };
          // the last boundary that ends a line and does not split a date
          // range (paid_at >= ... AND paid_at < ...) in two
          for (var pk = parts.length - 2; pk >= 0; pk--) {
            var prevEnd = T[parts[pk][1] - 1].e, nextStart = T[parts[pk + 1][0] - 1].s;
            var at2 = endOfLine(src, prevEnd);
            if (src[at2] !== '\n' || at2 >= nextStart) continue;
            var na = namesIn(parts[pk]), nb = namesIn(parts[pk + 1]);
            if (Object.keys(na).some(function (k) { return nb[k]; })) continue;
            at = at2; break;
          }
        }
        var ind = null;
        for (var k = sel.where.s; k < sel.where.e; k++) if ((isW(T[k], 'and') || isW(T[k], 'or')) && src.lastIndexOf('\n', T[k].s - 1) >= src.lastIndexOf('\n', T[k - 1] ? T[k - 1].e : 0)) { var lineStart = src.lastIndexOf('\n', T[k].s - 1) + 1; if (/^[ \t]*$/.test(src.slice(lineStart, T[k].s))) { ind = src.slice(lineStart, T[k].s); break; } }
        if (ind === null) ind = indentOf(src, T[sel.where.kw].s) + '  ';
        var hasOr = splitBool(A, sel.where.s, sel.where.e, 'or').length > 1;
        if (hasOr) { edits.push({ s: T[sel.where.s].s, e: T[sel.where.s].s, text: '(', what: '', at: T[sel.where.s].s }); edits.push({ s: last.e, e: last.e, text: ')', what: '', at: last.e - 0.5 }); }
        edits.push({ s: at, e: at, text: list.map(function (x) { return '\n' + ind + AND + ' ' + x.text; }).join(''), what: list.map(function (x) { return x.what; }).join(', '), at: at, add: list });
      } else if (sel.from) {
        var lastF = T[sel.from.e - 1], atF = endOfLine(src, lastF.e), indF = indentOf(src, T[sel.from.s - 1].s);
        edits.push({ s: atF, e: atF, text: '\n' + indF + WHERE + ' ' + list.map(function (x) { return x.text; }).join('\n' + indF + '  ' + AND + ' '), what: list.map(function (x) { return x.what; }).join(', '), at: atF, add: list });
      }
    });
    if (!edits.length && !skipped.length) return null;
    edits.sort(function (a, b) { return (b.s - a.s) || (b.at - a.at); });
    var fixed = src, lastS = Infinity;
    var applied = [];
    edits.forEach(function (ed) {
      if (ed.e > lastS) return; // overlaps one already applied
      fixed = fixed.slice(0, ed.s) + ed.text + fixed.slice(ed.e);
      lastS = ed.s;
      applied.push(ed);
    });
    applied.reverse().forEach(function (ed) {
      if (ed.add) ed.add.forEach(function (x) { changes.push({ what: cap(x.what), text: x.text, line: lineOf(A, ed.s) }); });
      else if (ed.what) changes.push({ what: cap(ed.what), text: ed.show || ed.text.trim(), line: lineOf(A, ed.s) });
    });
    if (!changes.length) return { sql: null, changes: [], skipped: skipped, diff: [] };
    return { sql: fixed, changes: changes, skipped: skipped, diff: lineDiff(src, fixed) };
  }

  /** A line diff (LCS): [{k: ' ' | '-' | '+', t}]. */
  function lineDiff(a, b) {
    var X = String(a).split('\n'), Y = String(b).split('\n'), n = X.length, m = Y.length, out = [];
    if (n * m > 400000) { X.forEach(function (t) { out.push({ k: '-', t: t }); }); Y.forEach(function (t) { out.push({ k: '+', t: t }); }); return out; }
    var L = [];
    for (var i = 0; i <= n; i++) { L.push(new Array(m + 1).fill(0)); }
    for (var i2 = n - 1; i2 >= 0; i2--) for (var j = m - 1; j >= 0; j--) L[i2][j] = X[i2] === Y[j] ? L[i2 + 1][j + 1] + 1 : Math.max(L[i2 + 1][j], L[i2][j + 1]);
    var x = 0, y = 0;
    while (x < n && y < m) {
      if (X[x] === Y[y]) { out.push({ k: ' ', t: X[x] }); x++; y++; }
      else if (L[x + 1][y] >= L[x][y + 1]) { out.push({ k: '-', t: X[x] }); x++; }
      else { out.push({ k: '+', t: Y[y] }); y++; }
    }
    while (x < n) out.push({ k: '-', t: X[x++] });
    while (y < m) out.push({ k: '+', t: Y[y++] });
    return out;
  }

  /* ================================================================== *
   * Schema text: DDL, describe output, column lists -> notes
   * ================================================================== */

  function parseSchemaText(text) {
    var s = strip(text).slice(0, LIMITS.schemaTextChars), tables = [], byName = {}, formats = [];
    var get = function (name) {
      var k = keyOfName(name);
      if (!k) return null;
      if (!byName[k]) { if (tables.length >= LIMITS.schemaTables) return null; byName[k] = { name: name.replace(/^["`\[]|["`\]]$/g, ''), columns: [], key: '', refs: [] }; tables.push(byName[k]); }
      return byName[k];
    };
    var addCol = function (t, name, type) {
      if (!t || !name) return;
      var n = String(name).replace(/^["`\[]|["`\]]$/g, '').trim();
      if (!n || n.length > LIMITS.identChars || /[\s;]/.test(n) || RESERVED[n.toLowerCase()]) return;
      if (t.columns.some(function (c) { return c.name.toLowerCase() === n.toLowerCase(); })) return;
      if (t.columns.length < LIMITS.columns) t.columns.push({ name: n, type: line(type || '', 40) });
    };
    // 1. CREATE TABLE ... ( ... ) and ALTER TABLE ... FOREIGN KEY
    var tk = tokenize(s), T = tk.tokens, A = { T: T, pair: pairs(T), subAt: {} };
    for (var i = 0; i < T.length; i++) {
      if (isW(T[i], 'create') && (isW(T[i + 1], 'table') || (T[i + 1] && T[i + 1].t === 'word' && /^(temporary|temp|external|transient|or|unlogged|global|local|replace)$/.test(T[i + 1].n)))) {
        var j = i + 1;
        while (T[j] && T[j].t === 'word' && !isW(T[j], 'table')) j++;
        if (!isW(T[j], 'table')) continue;
        j++;
        if (isW(T[j], 'if') && isW(T[j + 1], 'not') && isW(T[j + 2], 'exists')) j += 3;
        var nm = readName(A, j, T.length);
        if (!nm.parts.length) continue;
        var tname = nm.parts.join('.'), tb = get(tname);
        j = nm.end;
        if (!isP(T[j], '(')) continue;
        var close = A.pair[j];
        formats.push('ddl');
        splitTop(A, j + 1, close, ',').forEach(function (r) {
          var a = r[0], t0 = T[a];
          if (!t0) return;
          if (isW(t0, 'primary') && isW(T[a + 1], 'key') && isP(T[a + 2], '(')) { var pk = splitTop(A, a + 3, A.pair[a + 2], ',').map(function (x) { return T[x[0]].t === 'qident' ? T[x[0]].n : T[x[0]].v; }); if (tb && pk.length === 1) tb.key = pk[0]; return; }
          if (isW(t0, 'constraint')) { a += 2; t0 = T[a]; }
          if (isW(t0, 'primary') && isW(T[a + 1], 'key') && isP(T[a + 2], '(')) { var pk2 = splitTop(A, a + 3, A.pair[a + 2], ',').map(function (x) { return T[x[0]].t === 'qident' ? T[x[0]].n : T[x[0]].v; }); if (tb && pk2.length === 1) tb.key = pk2[0]; return; }
          if (isW(t0, 'foreign') && isW(T[a + 1], 'key') && isP(T[a + 2], '(')) {
            var fc = T[a + 3], refAt = A.pair[a + 2] + 1;
            if (isW(T[refAt], 'references')) { var rn = readName(A, refAt + 1, r[1]); var rc = isP(T[rn.end], '(') ? T[rn.end + 1] : null; if (tb && fc) tb.refs.push({ column: fc.t === 'qident' ? fc.n : fc.v, table: rn.parts.join('.'), refColumn: rc ? (rc.t === 'qident' ? rc.n : rc.v) : '' }); }
            return;
          }
          if (t0.t === 'word' && /^(unique|index|key|check|exclude|period|like)$/.test(t0.n)) return;
          if (!(t0.t === 'word' || t0.t === 'qident')) return;
          var colName = t0.t === 'qident' ? t0.n : t0.v;
          var typeTok = T[a + 1];
          addCol(tb, colName, typeTok ? textOf({ src: s, T: T }, a + 1, Math.min(r[1], (isP(T[a + 2], '(') ? A.pair[a + 2] + 1 : a + 2))) : '');
          for (var k = a + 1; k < r[1]; k++) {
            if (isW(T[k], 'primary') && isW(T[k + 1], 'key') && tb) tb.key = colName;
            if (isW(T[k], 'references')) { var rn2 = readName(A, k + 1, r[1]); var rc2 = isP(T[rn2.end], '(') ? T[rn2.end + 1] : null; if (tb) tb.refs.push({ column: colName, table: rn2.parts.join('.'), refColumn: rc2 ? (rc2.t === 'qident' ? rc2.n : rc2.v) : '' }); }
          }
        });
        i = close;
      }
      if (isW(T[i], 'alter') && isW(T[i + 1], 'table')) {
        var an = readName(A, i + 2, T.length), at = byName[an.parts[an.parts.length - 1]];
        for (var k2 = an.end; k2 < T.length && !isP(T[k2], ';'); k2++) {
          if (isW(T[k2], 'foreign') && isW(T[k2 + 1], 'key') && isP(T[k2 + 2], '(')) {
            var fc2 = T[k2 + 3], ra = A.pair[k2 + 2] + 1;
            if (isW(T[ra], 'references') && at && fc2) { var rn3 = readName(A, ra + 1, T.length); var rc3 = isP(T[rn3.end], '(') ? T[rn3.end + 1] : null; at.refs.push({ column: fc2.t === 'qident' ? fc2.n : fc2.v, table: rn3.parts.join('.'), refColumn: rc3 ? (rc3.t === 'qident' ? rc3.n : rc3.v) : '' }); }
          }
        }
      }
    }
    // 2. line formats, when there was no DDL
    if (!formats.length) {
      var current = null, header = null;
      s.split('\n').forEach(function (ln) {
        var l = ln.trim();
        if (!l) return;
        var m;
        if ((m = /^(?:table\s+)?"?([A-Za-z_][\w.$"]*)"?\s*\((.*)\)\s*;?$/i.exec(l)) && !/\bselect\b/i.test(l)) { // orders(id, customer_id, ...)
          var t1 = get(m[1]); m[2].split(',').forEach(function (c) { var bits = c.trim().split(/\s+/); addCol(t1, bits[0], bits.slice(1).join(' ')); }); formats.push('list'); current = null; return;
        }
        if ((m = /^([A-Za-z_][\w.$]*)\s*:\s*(.+)$/.exec(l)) && m[2].indexOf(',') >= 0) { // orders: id, customer_id
          var t2 = get(m[1]); m[2].split(',').forEach(function (c) { var bits = c.trim().split(/\s+/); addCol(t2, bits[0], bits.slice(1).join(' ')); }); formats.push('list'); current = null; return;
        }
        if ((m = /^Table "([^"]+)"$/i.exec(l)) || (m = /^(?:describe|desc|\\d\+?|show columns from)\s+([A-Za-z_][\w.$`"]*)\s*;?$/i.exec(l))) { current = get(m[1].replace(/[`"]/g, '')); header = null; formats.push('describe'); return; }
        if (/^[|+\-\s=]+$/.test(l)) return;
        var cells = l.indexOf('|') >= 0 ? l.split('|').map(function (c) { return c.trim(); }).filter(function (c, k, a) { return !(c === '' && (k === 0 || k === a.length - 1)); }) : (l.indexOf('\t') >= 0 ? l.split('\t') : (l.split(',').length >= 3 ? l.split(',') : null));
        if (cells && cells.length >= 2) {
          var low = cells.map(function (c) { return c.replace(/^"|"$/g, '').trim().toLowerCase(); });
          if (low.indexOf('column') >= 0 || low.indexOf('field') >= 0 || low.indexOf('column_name') >= 0) { header = low; formats.push('describe'); return; }
          if (header && header.indexOf('table_name') >= 0) {
            var tn = cells[header.indexOf('table_name')], cn = cells[header.indexOf('column_name')], ty = header.indexOf('data_type') >= 0 ? cells[header.indexOf('data_type')] : '';
            addCol(get(String(tn).replace(/^"|"$/g, '')), String(cn || '').replace(/^"|"$/g, ''), ty); return;
          }
          if (current) {
            var ci = header ? Math.max(header.indexOf('column'), header.indexOf('field'), header.indexOf('column_name')) : 0;
            var ti = header ? Math.max(header.indexOf('type'), header.indexOf('data_type')) : 1;
            addCol(current, cells[ci < 0 ? 0 : ci], cells[ti < 0 ? 1 : ti] || '');
            var keyCell = header && header.indexOf('key') >= 0 ? cells[header.indexOf('key')] : '';
            if (/^pri$/i.test(keyCell || '')) current.key = cells[ci < 0 ? 0 : ci];
            return;
          }
        }
        if ((m = /^([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)(?:\s+(.+))?$/.exec(l))) { addCol(get(m[1]), m[2], m[3] || ''); formats.push('dotted'); return; }
        if (current && (m = /^([A-Za-z_][\w$]*)\s+([A-Za-z].*)$/.exec(l))) addCol(current, m[1], m[2]);
      });
    }
    // keys and relationships
    var rels = [];
    tables.forEach(function (t) {
      if (!t.key && t.columns.some(function (c) { return c.name.toLowerCase() === 'id'; })) t.key = 'id';
    });
    tables.forEach(function (t) {
      t.refs.forEach(function (r) { var to = byName[keyOfName(r.table)]; if (to) rels.push({ one: to.name + '.' + (r.refColumn || to.key || 'id'), many: t.name + '.' + r.column, inferred: false }); });
      t.columns.forEach(function (c) {
        var mm = /^(.+)_id$/i.exec(c.name);
        if (!mm || t.refs.some(function (r) { return r.column.toLowerCase() === c.name.toLowerCase(); })) return;
        var base = mm[1].toLowerCase();
        var to = byName[base + 's'] || byName[base + 'es'] || byName[base.replace(/y$/, 'ies')] || byName[base];
        if (to && to !== t && to.key) rels.push({ one: to.name + '.' + to.key, many: t.name + '.' + c.name, inferred: true });
      });
    });
    var seenRel = {};
    rels = rels.filter(function (r) { var k = (r.one + '>' + r.many).toLowerCase(); if (seenRel[k]) return false; seenRel[k] = 1; return true; }).slice(0, LIMITS.relationships);
    return { tables: tables.filter(function (t) { return t.columns.length; }), relationships: rels, format: formats[0] || '' };
  }
  /** Schema-notes rows from parsed schema text (what "Fill from DDL" adds). */
  function notesFromSchema(parsed) {
    return {
      tables: parsed.tables.map(function (t) { return { name: t.name, grain: '', key: t.key || '', columns: t.columns.map(function (c) { return c.name; }) }; }),
      relationships: parsed.relationships.map(function (r) { return { one: r.one, many: r.many }; }),
    };
  }

  /* ================================================================== *
   * The canon itself: cleaning, ids, merge, import, export
   * ================================================================== */

  var ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
  var TZ_RE = /^(?:UTC|GMT|[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+){1,2})$/;
  function slug(s) { return line(s, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'metric'; }
  function idFor(name, taken) { var b = slug(name), id = b, k = 2; while (taken[id]) id = b + '-' + (k++); return id; }
  function cleanTz(v) { var s = line(v, LIMITS.tzChars); return TZ_RE.test(s) ? s : ''; }
  function cleanIdent(v) {
    var s = line(typeof v === 'string' ? v : (v && typeof v === 'object' && typeof v.name === 'string' ? v.name : ''), LIMITS.identChars);
    return /;|--|\/\*/.test(s) ? '' : s;
  }
  function stamp(v) { var n = Number(v); return Number.isFinite(n) && n > 0 && n < 4102444800000 ? Math.round(n) : 0; }
  function cleanList(v, max, each) {
    var arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []), out = [], seen = {};
    for (var i = 0; i < arr.length && i < max * 4; i++) {
      var c = each(arr[i]);
      if (!c) continue;
      var k = c.toLowerCase();
      if (seen[k]) continue;
      seen[k] = 1;
      out.push(c);
      if (out.length >= max) break;
    }
    return out;
  }
  function cleanFilters(v) {
    return (Array.isArray(v) ? v : []).slice(0, LIMITS.filters * 3).map(function (f) {
      if (typeof f === 'string') f = { sql: f };
      if (!f || typeof f !== 'object') return null;
      var sql = sqlText(f.sql, LIMITS.filterChars);
      if (!sql || /;/.test(sql.replace(/'[^']*'/g, ''))) return null;
      return { sql: sql, keepsOut: line(f.keepsOut, LIMITS.keepsOutChars) };
    }).filter(Boolean).slice(0, LIMITS.filters);
  }
  /** One metric definition, cleaned. A name and a measure are required
   *  (`opts.loose` keeps one without a measure, for the editor's draft). */
  function cleanMetric(v, opts) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    var name = line(v.name, LIMITS.nameChars);
    var measure = sqlText(v.measure, LIMITS.measureChars);
    if (measure && /;/.test(measure.replace(/'[^']*'/g, ''))) measure = '';
    if (!name || (!measure && !(opts && opts.loose))) return null;
    var date = v.date && typeof v.date === 'object' ? v.date : {};
    return {
      id: typeof v.id === 'string' && ID_RE.test(v.id) ? v.id : slug(name),
      name: name,
      synonyms: cleanList(v.synonyms, LIMITS.synonyms, function (x) { return line(x, LIMITS.synonymChars); }).filter(function (s) { return s.toLowerCase() !== name.toLowerCase(); }),
      meaning: para(v.meaning, LIMITS.meaningChars),
      owner: line(v.owner, LIMITS.ownerChars),
      tables: cleanList(v.tables, LIMITS.metricTables, cleanIdent),
      measure: measure,
      filters: cleanFilters(v.filters),
      date: { column: cleanIdent(date.column), tz: cleanTz(date.tz) },
      grain: line(v.grain, LIMITS.grainChars),
      dimensions: cleanList(v.dimensions, LIMITS.dims, cleanIdent),
      traps: para(v.traps, LIMITS.trapsChars),
      updatedAt: stamp(v.updatedAt),
    };
  }
  function cleanTable(t) {
    if (!t || typeof t !== 'object') return null;
    var name = cleanIdent(t.name);
    if (!name) return null;
    return { name: name, grain: line(t.grain, LIMITS.tableGrainChars), key: cleanIdent(t.key), columns: cleanList(t.columns, LIMITS.columns, cleanIdent) };
  }
  function cleanRel(r) {
    if (!r || typeof r !== 'object') return null;
    var one = cleanIdent(r.one), many = cleanIdent(r.many);
    if (!one || !many || one.indexOf('.') < 0 || many.indexOf('.') < 0) return null;
    var a = refOfText(one), b = refOfText(many);
    if (!a || !b || a.table === b.table) return null;
    return { one: one, many: many };
  }
  /** The whole canon, cleaned. `report.skipped` collects what was dropped. */
  function cleanCanon(v, report) {
    report = report || { skipped: [] };
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    var taken = {}, metrics = [];
    (Array.isArray(v.metrics) ? v.metrics : []).forEach(function (raw, i) {
      if (metrics.length >= LIMITS.metrics) { report.skipped.push({ what: 'metric ' + (i + 1), why: 'over the ' + LIMITS.metrics + '-metric limit' }); return; }
      var m = cleanMetric(raw);
      if (!m) { report.skipped.push({ what: (raw && typeof raw.name === 'string' && line(raw.name, 40)) || 'metric ' + (i + 1), why: 'it needs a name and a measure' }); return; }
      if (taken[m.id]) m.id = idFor(m.name, taken);
      taken[m.id] = 1;
      metrics.push(m);
    });
    var seenT = {};
    var tables = (Array.isArray(v.tables) ? v.tables : []).map(cleanTable).filter(function (t) { if (!t) return false; var k = t.name.toLowerCase(); if (seenT[k]) return false; seenT[k] = 1; return true; }).slice(0, LIMITS.schemaTables);
    var seenR = {};
    var relationships = (Array.isArray(v.relationships) ? v.relationships : []).map(cleanRel).filter(function (r) { if (!r) return false; var k = (r.one + '>' + r.many).toLowerCase(); if (seenR[k]) return false; seenR[k] = 1; return true; }).slice(0, LIMITS.relationships);
    return { version: 1, name: line(v.name, LIMITS.canonNameChars) || 'My company', metrics: metrics, tables: tables, relationships: relationships, sample: v.sample === true, updatedAt: stamp(v.updatedAt) };
  }
  function emptyCanon(name) { return { version: 1, name: line(name, LIMITS.canonNameChars) || 'My company', metrics: [], tables: [], relationships: [], sample: false, updatedAt: 0 }; }

  /** Two copies of one canon (two devices, or the account and this device):
   *  metrics by id (or name), the newer copy of each wins; tables by name;
   *  relationships together. */
  function mergeCanons(a, b) {
    var A0 = cleanCanon(a) || emptyCanon(), B0 = cleanCanon(b) || emptyCanon();
    var newer = (B0.updatedAt || 0) >= (A0.updatedAt || 0) ? B0 : A0;
    var byKey = {}, order = [];
    A0.metrics.concat(B0.metrics).forEach(function (m) {
      var k = m.id, kn = 'n:' + m.name.toLowerCase();
      var hit = byKey[k] || byKey[kn];
      if (!hit) { byKey[k] = byKey[kn] = m; order.push(m); return; }
      if ((m.updatedAt || 0) > (hit.updatedAt || 0)) { order[order.indexOf(hit)] = m; byKey[k] = byKey[kn] = byKey[hit.id] = m; }
    });
    var tbl = {}, tables = [];
    A0.tables.concat(B0.tables).forEach(function (t) { var k = t.name.toLowerCase(); if (!tbl[k]) { tbl[k] = t; tables.push(t); } else if (newer.tables.indexOf(t) >= 0) tables[tables.indexOf(tbl[k])] = tbl[k] = t; });
    return cleanCanon({ name: newer.name, metrics: order, tables: tables, relationships: A0.relationships.concat(B0.relationships), updatedAt: Math.max(A0.updatedAt || 0, B0.updatedAt || 0) });
  }

  function importJson(text) {
    var t = str(text);
    if (!t.trim()) throw new Error('That file is empty.');
    if (t.length > LIMITS.importChars) throw new Error('That file is over 1 MB - a canon is much smaller.');
    var data;
    try { data = JSON.parse(t); } catch (e) { throw new Error('That isn\u2019t JSON. Export a canon from Canon (JSON) and import that file.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('That JSON isn\u2019t a canon.');
    if (typeof data.app === 'string' && data.app !== 'canon') throw new Error('That file is from ' + line(data.app, 30) + ', not Canon.');
    var c = data.canon && typeof data.canon === 'object' ? data.canon : data;
    if (!Array.isArray(c.metrics)) throw new Error('No metrics in that file.');
    var report = { skipped: [] };
    var canon = cleanCanon(c, report);
    if (!canon.metrics.length) throw new Error('None of the metrics in that file had a name and a measure.');
    canon.sample = false;
    return { canon: canon, skipped: report.skipped, counts: { metrics: canon.metrics.length, tables: canon.tables.length, relationships: canon.relationships.length } };
  }

  function exportJson(canon, today) {
    var c = cleanCanon(canon) || emptyCanon();
    delete c.sample;
    return JSON.stringify({ app: 'canon', version: 1, exported: isDay(today) ? today : undefined, canon: c }, null, 2) + '\n';
  }

  /** Markdown, written to be pasted into an AI tool's instructions. */
  function code(s) { var t = String(s).replace(/\n+/g, ' '); return t.indexOf('`') >= 0 ? '`` ' + t + ' ``' : '`' + t + '`'; }
  // Escaped for Markdown, but left readable: an underscore inside a word
  // (order_lines, paid_at) cannot start emphasis, so only one at a word's
  // edge is escaped.
  function mdText(s) { return String(s).replace(/([\\*\[\]<>|`])/g, '\\$1').replace(/(^|[^A-Za-z0-9])_/g, '$1\\_').replace(/_(?=$|[^A-Za-z0-9])/g, '\\_'); }
  function mdCell(s) { return String(s).replace(/\|/g, '\\|').replace(/\n+/g, ' '); }
  function toMarkdown(canon, today) {
    var c = cleanCanon(canon) || emptyCanon(), out = [];
    out.push('# ' + mdText(c.name) + ' - metric definitions');
    out.push('');
    out.push('> These are the agreed definitions of ' + mdText(c.name) + '\u2019s metrics. Whenever you write SQL or report a number for one of them (or for any of its other names), compute it exactly as written here: the same measure, every required filter, the date column in its time zone, and only the listed dimensions. Use half-open date ranges (`>= first day AND < the day after the last`), never BETWEEN on timestamps. If a question can\u2019t be answered within a definition, say so instead of guessing.');
    if (isDay(today)) { out.push(''); out.push('_Exported ' + niceDay(today) + ' from Canon._'); }
    c.metrics.forEach(function (m) {
      out.push('');
      out.push('## ' + mdText(m.name));
      if (m.synonyms.length) out.push('Also called: ' + m.synonyms.map(mdText).join(', ') + '.');
      if (m.meaning) { out.push(''); out.push(mdText(m.meaning)); }
      out.push('');
      out.push('- **Measure:** ' + code(m.measure));
      if (m.tables.length) out.push('- **Tables:** ' + m.tables.map(code).join(', '));
      if (m.filters.length) {
        out.push('- **Required filters (always apply):**');
        m.filters.forEach(function (f) { out.push('  - ' + code(f.sql) + (f.keepsOut ? ' - keeps out ' + mdText(f.keepsOut) : '')); });
      }
      if (m.date.column) out.push('- **Date:** ' + code(m.date.column) + (m.date.tz ? ', with days in ' + code(m.date.tz) + ' (convert before comparing or grouping)' : ''));
      if (m.grain) out.push('- **Grain:** ' + mdText(m.grain));
      if (m.dimensions.length) out.push('- **Allowed dimensions:** ' + m.dimensions.map(code).join(', '));
      if (m.owner) out.push('- **Owner:** ' + mdText(m.owner));
      if (m.traps) out.push('- **Known traps:** ' + mdText(m.traps).replace(/\n+/g, ' '));
    });
    if (c.tables.length || c.relationships.length) {
      out.push('');
      out.push('## Schema notes');
      if (c.tables.length) {
        out.push('');
        out.push('| Table | One row per | Key |');
        out.push('| --- | --- | --- |');
        c.tables.forEach(function (t) { out.push('| ' + mdCell(t.name) + ' | ' + mdCell(t.grain || '-') + ' | ' + mdCell(t.key || '-') + ' |'); });
      }
      if (c.relationships.length) {
        out.push('');
        out.push('Relationships (joining the "many" side multiplies rows of the "one" side - aggregate it first or count DISTINCT keys):');
        c.relationships.forEach(function (r) { var a = refOfText(r.one), b = refOfText(r.many); out.push('- One ' + code(a.table) + ' row has many ' + code(b.table) + ' rows (' + code(r.many) + ' \u2192 ' + code(r.one) + ')'); });
      }
    }
    return out.join('\n') + '\n';
  }

  /** YAML shaped like a dbt semantic layer file - "dbt-style", not dbt. */
  function yq(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/[\u0000-\u001F\u007F]/g, function (ch) { return '\\u' + ('000' + ch.charCodeAt(0).toString(16)).slice(-4); }) + '"'; }
  function snake(s) { return line(s, 80).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'metric'; }
  function toYaml(canon, today) {
    var c = cleanCanon(canon) || emptyCanon(), out = [];
    out.push('# dbt-style: shaped like a dbt semantic layer file so it reads familiarly.');
    out.push('# It is NOT checked against dbt and is not guaranteed to be valid for any');
    out.push('# dbt version - treat it as a starting point, not a drop-in file.');
    out.push('# Exported from Canon' + (isDay(today) ? ' on ' + today : '') + ': ' + c.name.replace(/[\r\n]/g, ' '));
    out.push('');
    out.push('semantic_models:');
    if (!c.tables.length) out[out.length - 1] += ' []';
    c.tables.forEach(function (t) {
      out.push('  - name: ' + snake(keyOfName(t.name)));
      out.push('    model: ' + yq("ref('" + keyOfName(t.name) + "')"));
      if (t.grain) out.push('    description: ' + yq('One row per ' + t.grain.replace(/^one row per\s+/i, '')));
      var ents = [];
      if (t.key) ents.push({ name: snake(keyOfName(t.name)).replace(/s$/, ''), type: 'primary', expr: t.key });
      c.relationships.forEach(function (r) { var b = refOfText(r.many), a = refOfText(r.one); if (b.table === keyOfName(t.name)) ents.push({ name: snake(a.table).replace(/s$/, ''), type: 'foreign', expr: b.column }); });
      if (ents.length) {
        out.push('    entities:');
        ents.forEach(function (e) { out.push('      - name: ' + e.name); out.push('        type: ' + e.type); out.push('        expr: ' + yq(e.expr)); });
      }
    });
    out.push('');
    out.push('metrics:');
    if (!c.metrics.length) out[out.length - 1] += ' []';
    c.metrics.forEach(function (m) {
      var MM = measureModel(c, m);
      out.push('  - name: ' + snake(m.name));
      out.push('    label: ' + yq(m.name));
      if (m.meaning) out.push('    description: ' + yq(m.meaning));
      out.push('    type: ' + (MM.ratio ? 'ratio' : (MM.aggs.length > 1 ? 'derived' : 'simple')));
      out.push('    type_params:');
      out.push('      expr: ' + yq(m.measure));
      if (MM.aggs.length === 1) out.push('      agg: ' + ({ sum: 'sum', count: 'count', countd: 'count_distinct', avg: 'average', min: 'min', max: 'max' }[MM.aggs[0].fn] || 'other'));
      if (m.filters.length) {
        out.push('    filter: |');
        m.filters.forEach(function (f, i) { out.push('      ' + (i ? 'AND ' : '') + f.sql.replace(/\n+/g, ' ')); });
      }
      out.push('    meta:');
      if (m.owner) out.push('      owner: ' + yq(m.owner));
      if (m.synonyms.length) out.push('      synonyms: [' + m.synonyms.map(yq).join(', ') + ']');
      if (m.tables.length) out.push('      tables: [' + m.tables.map(yq).join(', ') + ']');
      if (m.grain) out.push('      grain: ' + yq(m.grain));
      if (m.date.column) out.push('      time_dimension: ' + yq(m.date.column));
      if (m.date.tz) out.push('      timezone: ' + yq(m.date.tz));
      if (m.dimensions.length) out.push('      allowed_dimensions: [' + m.dimensions.map(yq).join(', ') + ']');
      if (m.filters.some(function (f) { return f.keepsOut; })) out.push('      keeps_out: [' + m.filters.filter(function (f) { return f.keepsOut; }).map(function (f) { return yq(f.keepsOut); }).join(', ') + ']');
      if (m.traps) out.push('      known_traps: ' + yq(m.traps));
    });
    return out.join('\n') + '\n';
  }

  /** What a read-only share link shows: the canon's name, its definitions and
   *  its schema notes. Nothing else - no account, no checks, no SQL. */
  function shareView(canon) {
    var c = cleanCanon(canon);
    if (!c) return null;
    return { name: c.name, metrics: c.metrics, tables: c.tables, relationships: c.relationships, updatedAt: c.updatedAt };
  }

  /** Hints for the metric editor: does each part read, and does it name
   *  columns the schema notes know? */
  function lintMetric(canon, m) {
    var hints = [], S = schemaIndex(canon);
    var known = function (r) { var t = S.tables[r.table]; return !t || !t.columns || Boolean(t.columns[r.column]); };
    if (!m || !m.measure) hints.push({ field: 'measure', text: 'A measure is required, e.g. SUM(order_lines.net_amount).' });
    else {
      var MM = measureModel(canon, m);
      if (!MM.ok) hints.push({ field: 'measure', text: 'Canon can\u2019t find an aggregate here - write SUM(...), COUNT(DISTINCT ...), AVG(...) or a ratio of two.' });
      MM.aggs.forEach(function (a) { a.refs.forEach(function (r) { if (!known(r)) hints.push({ field: 'measure', text: refName(r) + ' isn\u2019t in the schema notes.' }); }); });
    }
    (m && m.filters || []).forEach(function (f, i) {
      filterModel(canon, m, f).forEach(function (fm) {
        if (!fm.ok) hints.push({ field: 'filter' + i, text: 'Canon can\u2019t read \u201c' + clip(f.sql, 60) + '\u201d - write it as table.column = value, IS NULL, IN (...) or a comparison.' });
        else if (!known(fm.ref)) hints.push({ field: 'filter' + i, text: refName(fm.ref) + ' isn\u2019t in the schema notes.' });
      });
    });
    if (m && m.date && m.date.column) { var dr = refModel(canon, m, m.date.column); if (dr && !known(dr)) hints.push({ field: 'date', text: refName(dr) + ' isn\u2019t in the schema notes.' }); }
    return hints;
  }

  /* ================================================================== *
   * The two AI calls: what is sent, and what comes back
   * ================================================================== */

  /** "Draft definitions from my schema": the parsed tables and columns and
   *  one sentence about the business - never the raw text pasted. */
  function draftRequest(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    var tables = (Array.isArray(v.tables) ? v.tables : []).slice(0, LIMITS.schemaTables).map(function (t) {
      if (!t || typeof t !== 'object') return null;
      var name = cleanIdent(t.name);
      if (!name || /\s/.test(name)) return null;
      var seen = {};
      var cols = (Array.isArray(t.columns) ? t.columns : []).slice(0, LIMITS.columns).map(function (c) {
        var cn = cleanIdent(c && typeof c === 'object' ? c.name : c);
        if (!cn || /\s/.test(cn) || seen[cn.toLowerCase()]) return null;
        seen[cn.toLowerCase()] = 1;
        return { name: cn, type: line(c && typeof c === 'object' ? c.type : '', 40) };
      }).filter(Boolean);
      if (!cols.length) return null;
      return { name: name, key: cleanIdent(t.key), columns: cols };
    }).filter(Boolean);
    if (!tables.length) return null;
    var rels = (Array.isArray(v.relationships) ? v.relationships : []).map(cleanRel).filter(Boolean).slice(0, LIMITS.relationships);
    return { business: line(v.business, LIMITS.businessChars), tables: tables, relationships: rels };
  }
  function draftPayload(schemaText, business) {
    var p = parseSchemaText(schemaText);
    return draftRequest({ business: business, tables: p.tables, relationships: p.relationships });
  }
  function draftCanon(req) {
    return { tables: req.tables.map(function (t) { return { name: t.name, key: t.key, columns: t.columns.map(function (c) { return c.name; }) }; }), relationships: req.relationships || [] };
  }
  function refsIn(canon, m, text, where) {
    var P = parseCanonExpr(canon, m.tables.map(keyOfName).filter(Boolean), text, where);
    P.guess = false;
    var sel = P.root && P.root.selects[0], out = [], bad = 0;
    if (!sel) return { refs: [], bad: 1 };
    var ranges = where ? (sel.where ? [[sel.where.s, sel.where.e]] : []) : sel.items.map(function (it) { return [it.exprS, it.exprE]; });
    ranges.forEach(function (r) {
      exprScan(P, r[0], r[1]).refs.forEach(function (x) {
        var rr = resolve(P, sel, x.parts);
        if (rr.refs.length) out.push({ table: rr.refs[0].table, column: rr.refs[0].column });
        else bad++;
      });
    });
    return { refs: out, bad: bad };
  }
  /** A drafted canon, checked: every column a definition names must be in
   *  the schema that was sent; anything else is dropped and counted. */
  function cleanDraft(raw, req) {
    var schema = draftCanon(req), S = schemaIndex(schema), out = [], dropped = [], taken = {};
    var known = function (r) { var t = S.tables[r.table]; return Boolean(t && t.columns && t.columns[r.column]); };
    var list = raw && Array.isArray(raw.metrics) ? raw.metrics.slice(0, LIMITS.draftMetrics) : [];
    list.forEach(function (rm) {
      var m = cleanMetric(rm && typeof rm === 'object' ? Object.assign({}, rm, {
        name: noMarkup(str(rm.name)), meaning: noMarkup(str(rm.meaning)), traps: noMarkup(str(rm.traps)), grain: noMarkup(str(rm.grain)), owner: '',
        synonyms: Array.isArray(rm.synonyms) ? rm.synonyms.map(function (x) { return noMarkup(str(x)); }) : [],
        filters: Array.isArray(rm.filters) ? rm.filters.map(function (f) { return f && typeof f === 'object' ? { sql: f.sql, keepsOut: noMarkup(str(f.keepsOut)) } : f; }) : [],
      }) : null);
      if (!m) { dropped.push({ metric: noMarkup(line(rm && rm.name, 40)) || '?', what: 'the whole metric', why: 'no name or a usable measure' }); return; }
      m.tables = m.tables.filter(function (t) { return S.tables[keyOfName(t)]; });
      var mr = refsIn(schema, m, m.measure, false);
      if (!mr.refs.length && !/count\s*\(\s*\*\s*\)/i.test(m.measure) || mr.bad || mr.refs.some(function (r) { return !known(r); })) {
        dropped.push({ metric: m.name, what: 'the whole metric', why: 'its measure names a column that isn\u2019t in the schema' }); return;
      }
      mr.refs.forEach(function (r) { if (!m.tables.some(function (t) { return keyOfName(t) === r.table; })) m.tables.push(S.tables[r.table].name); });
      if (!m.tables.length) { dropped.push({ metric: m.name, what: 'the whole metric', why: 'it names no known table' }); return; }
      m.filters = m.filters.filter(function (f) {
        var fr = refsIn(schema, m, f.sql, true);
        var ok = fr.refs.length && !fr.bad && fr.refs.every(known);
        if (!ok) dropped.push({ metric: m.name, what: 'filter ' + clip(f.sql, 60), why: 'it names a column that isn\u2019t in the schema' });
        return ok;
      });
      if (m.date.column) {
        var dr = refModel(schema, m, m.date.column);
        if (!dr || !known(dr)) { dropped.push({ metric: m.name, what: 'date column ' + m.date.column, why: 'not in the schema' }); m.date.column = ''; }
      }
      m.dimensions = m.dimensions.filter(function (d) {
        var r = refModel(schema, m, d);
        var ok = r && known(r);
        if (!ok) dropped.push({ metric: m.name, what: 'dimension ' + d, why: 'not in the schema' });
        return ok;
      });
      if (taken[m.id]) m.id = idFor(m.name, taken);
      taken[m.id] = 1;
      m.updatedAt = 0;
      out.push(m);
    });
    return { metrics: out, dropped: dropped, note: noMarkup(line(raw && raw.note, 300)) };
  }

  /** "Explain this answer": the question, the SQL and only the definitions it
   *  was checked against, plus the rules' own verdicts. */
  function explainPayload(result, canon) {
    if (!result || !result.parsed || !result.metrics || !result.metrics.length) return null;
    var byId = {};
    ((canon && canon.metrics) || []).forEach(function (m) { byId[m.id] = m; });
    var metrics = result.metrics.map(function (r) { return byId[r.id] ? cleanMetric(byId[r.id]) : null; }).filter(Boolean).slice(0, LIMITS.explainMetrics);
    metrics.forEach(function (m) { delete m.updatedAt; delete m.owner; });
    var checks = [];
    result.metrics.forEach(function (r) { r.checks.forEach(function (c) { if (checks.length < LIMITS.explainChecks) checks.push({ metric: r.name, check: c.title, verdict: c.verdict, why: line(c.why, 300) }); }); });
    return explainRequest({ question: result.question, sql: result.sql, metrics: metrics, checks: checks });
  }
  function explainRequest(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    var sql = strip(v.sql).trim();
    if (!sql || sql.length > LIMITS.explainSqlChars) return null;
    var metrics = (Array.isArray(v.metrics) ? v.metrics : []).slice(0, LIMITS.explainMetrics).map(function (m) { var c = cleanMetric(m); if (c) { delete c.updatedAt; delete c.owner; } return c; }).filter(Boolean);
    if (!metrics.length) return null;
    var checks = (Array.isArray(v.checks) ? v.checks : []).slice(0, LIMITS.explainChecks).map(function (c) {
      if (!c || typeof c !== 'object') return null;
      var vd = VERDICTS.indexOf(c.verdict) >= 0 ? c.verdict : null;
      if (!vd) return null;
      return { metric: line(c.metric, LIMITS.nameChars), check: line(c.check, 120), verdict: vd, why: line(c.why, 300) };
    }).filter(Boolean);
    return { question: line(v.question, LIMITS.questionChars), sql: sql, metrics: metrics, checks: checks };
  }
  function cleanExplanation(raw, req) {
    if (!raw || typeof raw !== 'object') return null;
    var t = function (v, n) { return noMarkup(line(v, n)); };
    var differences = (Array.isArray(raw.differences) ? raw.differences : []).slice(0, 8).map(function (d) {
      if (!d || typeof d !== 'object') return null;
      var what = t(d.what, 200);
      if (!what) return null;
      return { what: what, canon: t(d.canon, 300), sql: t(d.sql, 300), effect: t(d.effect, 300) };
    }).filter(Boolean);
    var computes = noMarkup(para(raw.computes, 900));
    if (!computes && !differences.length) return null;
    return { computes: computes, differences: differences, verdict: ['matches', 'differs', 'unclear'].indexOf(raw.verdict) >= 0 ? raw.verdict : 'unclear', fix: noMarkup(para(raw.fix, 600)), metrics: req ? req.metrics.map(function (m) { return m.name; }) : [] };
  }

  return {
    LIMITS: LIMITS, VERDICTS: VERDICTS, VERDICT_WORD: VERDICT_WORD, VERDICT_ICON: VERDICT_ICON, AGG_WORD: AGG_WORD,
    esc: esc, line: line, para: para, clip: clip, plural: plural, strip: strip, sqlText: sqlText, noMarkup: noMarkup,
    tokenize: tokenize, parseSql: parseSql, cleanSql: cleanSql, predicate: predicate, equivalent: equivalent, resolve: resolve, conjuncts: conjuncts,
    analyze: analyze, matchQuestion: matchQuestion, timeAsk: timeAsk, grainAsk: grainAsk, dimAsk: dimAsk, verdictOf: verdictOf, lineDiff: lineDiff,
    measureModel: measureModel, filterModel: filterModel, lintMetric: lintMetric,
    parseSchemaText: parseSchemaText, notesFromSchema: notesFromSchema,
    cleanMetric: cleanMetric, cleanCanon: cleanCanon, emptyCanon: emptyCanon, mergeCanons: mergeCanons, idFor: idFor, slug: slug, keyOfName: keyOfName, refOfText: refOfText,
    importJson: importJson, exportJson: exportJson, toMarkdown: toMarkdown, toYaml: toYaml, shareView: shareView,
    draftRequest: draftRequest, draftPayload: draftPayload, cleanDraft: cleanDraft,
    explainPayload: explainPayload, explainRequest: explainRequest, cleanExplanation: cleanExplanation,
    addDays: addDays, isDay: isDay, niceDay: niceDay, niceRange: niceRange, normZone: normZone,
  };
}));
