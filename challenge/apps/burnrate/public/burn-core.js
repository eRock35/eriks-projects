/* Burnrate - the rules. One file, run three times: by the page (window.BurnCore),
 * by the server and by the tests (require). It reads Claude Code session
 * transcripts (JSONL) line by line, keeps only numbers and short labels,
 * prices them at a dated, editable table of list prices, and finds the waste.
 *
 * What it keeps from a transcript, and nothing else:
 *   - per API response (deduplicated by message id): model, time, the five
 *     token counts, whether it ran in fast mode;
 *   - per tool call: the tool's name, a short label (a file path, the first
 *     60 characters of a command, a search pattern), a hash of its full
 *     input (so "the same call again" can be recognised without keeping the
 *     call), the size of its result and whether it failed.
 * Message text, file contents, command output and thinking are never kept.
 *
 * Every dollar figure is an ESTIMATE AT LIST PRICES. A subscription seat is
 * not billed per token; this is what the same usage would cost on the API.
 *
 * Money is integer "units" of 1e-8 dollars: a token count times a price in
 * cents per million tokens. No float ever touches a sum, so a total is exact
 * to the cent however many turns it adds up.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BurnCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var UNITS_PER_USD = 1e8;
  var MIN = 60000;

  var LIMITS = {
    files: 4000,            // transcript files in one analysis
    bytes: 2 * 1024 * 1024 * 1024, // 2 GB read in total (streamed, never held)
    lineChars: 32 * 1024 * 1024,   // one line longer than this is skipped and counted
    people: 12,
    personName: 40,
    label: 60,
    path: 240,
    sparkPoints: 48,
    detailPoints: 240,
    instances: 40,          // per finding kept for display
    savedInstances: 8,      // per finding kept in this browser's memory
    sessionsSaved: 400,
  };

  /* ------------------------------------------------------------------ *
   * Prices. Anthropic API list prices, US dollars per million tokens, as
   * published on 2026-09-25 (the claude-api reference's dated table).
   * Cache writes: 1.25x input for the 5-minute TTL, 2x for 1 hour. Cache
   * reads differ by model. Fast mode on Opus 5 / 5.5 is 2x. Editable on the
   * page; an edit is kept in this browser only.
   * ------------------------------------------------------------------ */

  var PRICES_AS_OF = '2026-09-25';
  var PRICE_NOTE = 'Anthropic API list prices, US$ per million tokens, as of 25 Sep 2026. Cache writes 1.25× input (5-minute) and 2× (1-hour). Fast mode 2× where listed. Web-search fees are not counted.';

  function P(id, name, tier, inp, out, read, fast) {
    return { id: id, name: name, tier: tier, input: inp, output: out, write5m: inp * 1.25, write1h: inp * 2, read: read, fast: fast || 0 };
  }
  var DEFAULT_PRICES = [
    P('claude-fable-5-1', 'Fable 5.1', 'top', 10, 50, 0.25),
    P('claude-mythos-5-1', 'Mythos 5.1', 'top', 10, 50, 0.25),
    P('claude-fable-5', 'Fable 5', 'top', 10, 50, 1),
    P('claude-mythos-5', 'Mythos 5', 'top', 10, 50, 1),
    P('claude-opus-5-5', 'Opus 5.5', 'top', 4, 20, 0.2, 2),
    P('claude-opus-5', 'Opus 5', 'top', 5, 25, 0.5, 2),
    P('claude-opus-4-8', 'Opus 4.8', 'top', 5, 25, 0.5),
    P('claude-opus-4-7', 'Opus 4.7', 'top', 5, 25, 0.5),
    P('claude-opus-4-6', 'Opus 4.6', 'top', 5, 25, 0.5),
    P('claude-sonnet-5-5', 'Sonnet 5.5', 'mid', 2, 10, 0.2),
    P('claude-sonnet-5', 'Sonnet 5', 'mid', 2, 10, 0.2),
    P('claude-sonnet-4-6', 'Sonnet 4.6', 'mid', 3, 15, 0.3),
    P('claude-haiku-4-5', 'Haiku 4.5', 'small', 1, 5, 0.1),
  ];
  // The cheaper model a "big model for small turns" finding is priced against.
  var CHEAPER_ID = 'claude-sonnet-5-5';
  var PRICE_FIELDS = ['input', 'output', 'write5m', 'write1h', 'read'];
  var TIERS = ['top', 'mid', 'small'];

  function centsPerM(p) { return Math.round(Number(p) * 100 + 1e-9); }

  /** A price table from anything (the page's edited copy, localStorage):
   *  known fields only, prices 0..1000 rounded to the cent, ids in a safe
   *  shape, at most 40 rows. Falls back to the default table. */
  function cleanPrices(v) {
    if (!Array.isArray(v)) return DEFAULT_PRICES.map(function (r) { return Object.assign({}, r); });
    var out = [];
    var seen = {};
    for (var i = 0; i < v.length && out.length < 40; i++) {
      var r = v[i];
      if (!r || typeof r !== 'object') continue;
      var id = String(r.id || '').toLowerCase().trim();
      if (!/^[a-z0-9][a-z0-9.\-]{1,60}$/.test(id) || seen[id]) continue;
      var row = { id: id, name: clean(r.name, 30) || id, tier: TIERS.indexOf(r.tier) >= 0 ? r.tier : 'mid', fast: Number(r.fast) >= 1 && Number(r.fast) <= 10 ? Number(r.fast) : 0 };
      var ok = true;
      for (var j = 0; j < PRICE_FIELDS.length; j++) {
        var n = Number(r[PRICE_FIELDS[j]]);
        if (!isFinite(n) || n < 0 || n > 1000) { ok = false; break; }
        row[PRICE_FIELDS[j]] = Math.round(n * 100 + 1e-9) / 100;
      }
      if (!ok) continue;
      seen[id] = 1;
      out.push(row);
    }
    return out.length ? out : DEFAULT_PRICES.map(function (r) { return Object.assign({}, r); });
  }

  function priceKey(t) {
    return t.map(function (r) { return [r.id, r.fast || 0].concat(PRICE_FIELDS.map(function (f) { return centsPerM(r[f]); })).join(':'); }).join('|');
  }

  /** The model id as Claude Code writes it, folded for matching: lower case,
   *  provider prefixes ("us.anthropic.") and suffixes ("[1m]", "-v1:0",
   *  "@20251001") dropped. */
  function foldModel(m) {
    var s = String(m || '').toLowerCase().trim();
    s = s.replace(/\[[^\]]*\]$/, '').replace(/^(?:[a-z]{2}\.)?anthropic\./, '').replace(/-v\d+(?::\d+)?$/, '').replace(/@\d{8}$/, '');
    return s;
  }
  /** The table row for a model id, or null. The longest id that the model
   *  is, or is followed only by a date stamp ("claude-haiku-4-5-20251001"):
   *  so claude-opus-5-5 is never priced as claude-opus-5. */
  function rowFor(model, table) {
    var m = foldModel(model);
    var best = null;
    for (var i = 0; i < table.length; i++) {
      var id = table[i].id;
      if (m === id || (m.indexOf(id + '-') === 0 && /^\d{8}$/.test(m.slice(id.length + 1)))) {
        if (!best || id.length > best.id.length) best = table[i];
      }
    }
    return best;
  }
  function modelName(model, table) {
    var r = rowFor(model, table);
    return r ? r.name : clean(model, 40) || 'unknown';
  }

  /** Cost of one response in units (1e-8 USD). */
  function turnUnits(t, row) {
    if (!row) return 0;
    var f = t.fast && row.fast ? row.fast : 1;
    return f * (t.inp * centsPerM(row.input) + t.w5 * centsPerM(row.write5m) + t.w1 * centsPerM(row.write1h) + t.cr * centsPerM(row.read) + t.out * centsPerM(row.output));
  }
  /** Just the context (input side) of one response. */
  function inputUnits(t, row) {
    if (!row) return 0;
    var f = t.fast && row.fast ? row.fast : 1;
    return f * (t.inp * centsPerM(row.input) + t.w5 * centsPerM(row.write5m) + t.w1 * centsPerM(row.write1h) + t.cr * centsPerM(row.read));
  }
  function usd(units) { return Math.round(units / 1e6) / 100; } // to the cent

  /* ------------------------------------------------------------------ *
   * Strings from a transcript are hostile: a path or a command can carry
   * markup, bidi overrides, control characters. clean() removes the
   * invisible ones and bounds the length; the page escapes on render.
   * ------------------------------------------------------------------ */

  var INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩؜﻿]/g;
  function clean(v, max) {
    var s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    s = s.replace(INVISIBLE, '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (max && s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
    return s;
  }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function basename(p) {
    var s = clean(p, 0).replace(/[\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return clean(i >= 0 ? s.slice(i + 1) : s, LIMITS.label);
  }
  /** FNV-1a, 32-bit, as 8 hex characters: recognises "the same input again"
   *  without keeping the input. */
  function fnv(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  }
  function int(v) { var n = Number(v); return isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1e12) : 0; }
  function str(v) { return typeof v === 'string' ? v : ''; }

  var READ_TOOLS = { Read: 1, NotebookRead: 1 };
  var EDIT_TOOLS = { Edit: 1, Write: 1, MultiEdit: 1, NotebookEdit: 1 };
  var LOOK_TOOLS = { Read: 1, NotebookRead: 1, Glob: 1, Grep: 1, LS: 1, WebSearch: 1, WebFetch: 1, TodoWrite: 1, ToolSearch: 1 };

  /** One tool call, reduced to what the findings need. */
  function toolInfo(name, input) {
    var n = clean(name, 60) || 'tool';
    var i = input && typeof input === 'object' ? input : {};
    var path = '';
    var label = n;
    var sigSrc;
    if (READ_TOOLS[n] || EDIT_TOOLS[n]) {
      path = clean(str(i.file_path) || str(i.notebook_path) || str(i.path), LIMITS.path);
      label = basename(path) || n;
      sigSrc = n + '|' + path + '|' + (int(i.offset) || '') + '|' + (int(i.limit) || '');
    } else if (n === 'Bash') {
      var cmd = str(i.command);
      label = clean(cmd.split('\n')[0], LIMITS.label) || 'Bash';
      sigSrc = 'Bash|' + cmd;
    } else if (n === 'Grep') {
      label = clean('grep ' + str(i.pattern), LIMITS.label);
      path = clean(str(i.path), LIMITS.path);
      sigSrc = 'Grep|' + str(i.pattern) + '|' + str(i.path) + '|' + str(i.glob) + '|' + str(i.type) + '|' + str(i.output_mode);
    } else if (n === 'Glob') {
      label = clean('glob ' + str(i.pattern), LIMITS.label);
      path = clean(str(i.path), LIMITS.path);
      sigSrc = 'Glob|' + str(i.pattern) + '|' + str(i.path);
    } else if (n === 'Task' || n === 'Agent') {
      label = clean(str(i.description) || str(i.subagent_type) || n, LIMITS.label);
      sigSrc = n + '|' + str(i.description) + '|' + str(i.prompt).length;
    } else if (n === 'WebFetch') {
      var host = '';
      try { host = new URL(str(i.url)).hostname; } catch (e) { host = ''; }
      label = clean('fetch ' + host, LIMITS.label);
      sigSrc = 'WebFetch|' + str(i.url);
    } else {
      var j = '';
      try { j = JSON.stringify(i); } catch (e) { j = ''; }
      sigSrc = n + '|' + (j.length > 20000 ? j.slice(0, 20000) + j.length : j);
    }
    return { name: n, label: label, path: path, sig: fnv(sigSrc), chars: 0, err: false, done: false };
  }

  function resultChars(c) {
    if (typeof c === 'string') return c.length;
    if (!Array.isArray(c)) return 0;
    var n = 0;
    for (var i = 0; i < c.length; i++) {
      var b = c[i];
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') n += b.text.length;
      else if (b.type === 'image') n += 6400; // about 1,600 tokens, a typical screenshot
    }
    return n;
  }
  function tokensOfChars(c) { return Math.ceil(c / 4); } // a stated rule of thumb

  /* ------------------------------------------------------------------ *
   * Reading. A collector takes every line of every file, from every
   * person, and keeps one record per API response.
   * ------------------------------------------------------------------ */

  function cleanProject(cwd) {
    var b = basename(cwd);
    return b || '';
  }
  /** "-Users-maya-code-api-refactor" (a projects folder) -> a fallback name. */
  function projectFromFolder(dir) {
    var d = clean(dir, 200).replace(/^-+/, '');
    var parts = d.split('-').filter(Boolean);
    return clean(parts.slice(-2).join('-'), 40);
  }
  /** Where a file sits: a subagent transcript lives under a subagents/
   *  folder beside its session. */
  function fileInfo(path) {
    var p = clean(path, 1000).replace(/\\/g, '/');
    var parts = p.split('/').filter(Boolean);
    var name = parts[parts.length - 1] || '';
    var sub = parts.indexOf('subagents') >= 0 || /^agent-/.test(name);
    var folder = '';
    for (var i = parts.length - 2; i >= 0; i--) {
      if (parts[i] !== 'subagents' && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(parts[i])) { folder = parts[i]; break; }
    }
    return { path: p, name: name, sub: sub, folder: folder };
  }

  function createCollector(opts) {
    opts = opts || {};
    var msgs = new Map();
    var order = 0;
    var results = new Map();
    var compactions = [];
    var people = [];
    var stats = { files: 0, subFiles: 0, lines: 0, malformed: 0, tooLong: 0, synthetic: 0, noUsage: 0, duplicates: 0, bytes: 0, webSearches: 0 };

    function person(name) {
      var n = clean(name, LIMITS.personName) || ('Person ' + (people.length + 1));
      var i = people.indexOf(n);
      if (i >= 0) return i;
      if (people.length >= LIMITS.people) throw Object.assign(new Error('Up to ' + LIMITS.people + ' people in one analysis.'), { code: 'people' });
      people.push(n);
      return people.length - 1;
    }

    function file(path, who) {
      var fi = fileInfo(path);
      var pi = typeof who === 'number' ? who : person(who || 'Me');
      stats.files++;
      if (fi.sub) stats.subFiles++;
      if (stats.files > LIMITS.files) throw Object.assign(new Error('That is more than ' + LIMITS.files + ' files. Pick one project folder, or a shorter stretch of time.'), { code: 'files' });

      function threadOf(o) {
        var sid = clean(str(o.sessionId), 80) || fi.name.replace(/\.jsonl$/, '');
        var agent = clean(str(o.agentId), 40);
        var side = o.isSidechain === true || fi.sub;
        if (side && !agent) agent = fi.sub ? fi.name.replace(/\.jsonl$/, '').replace(/^agent-/, '') : 'side';
        return { sid: sid, agent: side ? agent : '' };
      }

      function onAssistant(o) {
        var m = o.message;
        if (!m || typeof m !== 'object') return;
        var model = str(m.model);
        if (model === '<synthetic>') { stats.synthetic++; return; }
        var u = m.usage;
        if (!u || typeof u !== 'object') { stats.noUsage++; return; }
        var id = clean(str(m.id) || str(o.requestId) || str(o.uuid), 120);
        if (!id) id = 'noid-' + (order + 1);
        var cc = int(u.cache_creation_input_tokens);
        var split = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
        var w5 = split ? int(split.ephemeral_5m_input_tokens) : 0;
        var w1 = split ? int(split.ephemeral_1h_input_tokens) : 0;
        if (w5 + w1 < cc) w5 += cc - (w5 + w1); // no split (older versions): all 5-minute
        var t = Date.parse(str(o.timestamp));
        var stu = u.server_tool_use && typeof u.server_tool_use === 'object' ? int(u.server_tool_use.web_search_requests) : 0;
        var tools = [];
        var content = Array.isArray(m.content) ? m.content : [];
        for (var i = 0; i < content.length; i++) {
          var b = content[i];
          if (b && b.type === 'tool_use' && typeof b.id === 'string') {
            var ti = toolInfo(b.name, b.input);
            ti.id = clean(b.id, 80);
            tools.push(ti);
          }
        }
        var rec = msgs.get(id);
        if (rec) {
          // A streamed response is written as several lines - one per
          // content block - each repeating the usage (later lines can carry
          // a larger output count). One response, counted once: the largest
          // of each count, the earliest time, every tool call once.
          stats.duplicates++;
          rec.inp = Math.max(rec.inp, int(u.input_tokens));
          rec.w5 = Math.max(rec.w5, w5);
          rec.w1 = Math.max(rec.w1, w1);
          rec.cr = Math.max(rec.cr, int(u.cache_read_input_tokens));
          rec.out = Math.max(rec.out, int(u.output_tokens));
          rec.web = Math.max(rec.web, stu);
          if (isFinite(t) && (!isFinite(rec.t) || t < rec.t)) rec.t = t;
          for (var k = 0; k < tools.length; k++) if (!rec.tools.some(function (x) { return x.id === tools[k].id; })) rec.tools.push(tools[k]);
          return;
        }
        var th = threadOf(o);
        msgs.set(id, {
          n: order++, t: t, model: clean(model, 80), sid: th.sid, agent: th.agent, person: pi,
          cwd: cleanProject(o.cwd) || projectFromFolder(fi.folder) || 'unknown',
          inp: int(u.input_tokens), w5: w5, w1: w1, cr: int(u.cache_read_input_tokens), out: int(u.output_tokens),
          fast: u.speed === 'fast', web: stu, tools: tools,
        });
      }

      function onUser(o) {
        var m = o.message;
        var c = m && Array.isArray(m.content) ? m.content : null;
        if (c) {
          for (var i = 0; i < c.length; i++) {
            var b = c[i];
            if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
            var id = clean(b.tool_use_id, 80);
            var chars = resultChars(b.content);
            var prev = results.get(id);
            results.set(id, { chars: Math.max(chars, prev ? prev.chars : 0), err: b.is_error === true || Boolean(prev && prev.err) });
          }
        }
        if (o.isCompactSummary === true) {
          var th = threadOf(o);
          compactions.push({ sid: th.sid, agent: th.agent, t: Date.parse(str(o.timestamp)) });
        }
      }

      return {
        line: function (s) {
          stats.lines++;
          if (typeof s !== 'string' || !s.trim()) { stats.lines--; return; }
          if (s.length > LIMITS.lineChars) { stats.tooLong++; return; }
          var o;
          try { o = JSON.parse(s); } catch (e) { stats.malformed++; return; }
          if (!o || typeof o !== 'object' || Array.isArray(o)) { stats.malformed++; return; }
          if (o.type === 'assistant') onAssistant(o);
          else if (o.type === 'user') onUser(o);
          else if (o.type === 'system' && o.subtype === 'compact_boundary') {
            var th = threadOf(o);
            compactions.push({ sid: th.sid, agent: th.agent, t: Date.parse(str(o.timestamp)) });
          }
        },
        /** A whole file's text at once (tests, small files). */
        text: function (txt) {
          var self = this;
          String(txt).split(/\r?\n/).forEach(function (l) { self.line(l); });
        },
        bytes: function (n) { stats.bytes += n; },
      };
    }

    /** The dataset: threads of turns, in time order. */
    function finish() {
      var threads = new Map();
      var list = Array.from(msgs.values());
      list.sort(function (a, b) { return (isFinite(a.t) ? a.t : 0) - (isFinite(b.t) ? b.t : 0) || a.n - b.n; });
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (!isFinite(r.t)) continue;
        var key = r.person + '|' + r.sid + '|' + r.agent;
        var th = threads.get(key);
        if (!th) {
          th = { key: key, sid: r.sid, agent: r.agent, sub: Boolean(r.agent), person: r.person, project: r.cwd, turns: [], compactions: [] };
          threads.set(key, th);
        }
        for (var k = 0; k < r.tools.length; k++) {
          var res = results.get(r.tools[k].id);
          if (res) { r.tools[k].chars = res.chars; r.tools[k].err = res.err; r.tools[k].done = true; }
        }
        th.turns.push({ t: r.t, model: r.model, inp: r.inp, w5: r.w5, w1: r.w1, cr: r.cr, out: r.out, fast: r.fast, web: r.web, tools: r.tools, ctx: r.inp + r.w5 + r.w1 + r.cr });
        stats.webSearches += r.web;
      }
      for (var j = 0; j < compactions.length; j++) {
        var c = compactions[j];
        if (!isFinite(c.t)) continue;
        threads.forEach(function (th2) { if (th2.sid === c.sid && th2.agent === c.agent && th2.compactions.indexOf(c.t) < 0) th2.compactions.push(c.t); });
      }
      var arr = Array.from(threads.values());
      arr.forEach(function (th3) { th3.compactions.sort(function (a, b) { return a - b; }); });
      return { version: VERSION, threads: arr, people: people.slice(), stats: Object.assign({}, stats, { responses: msgs.size }) };
    }

    return { file: file, person: person, finish: finish, stats: stats, people: people };
  }

  /** Split a growing text buffer into whole lines; returns the remainder. */
  function splitLines(buf, onLine) {
    var start = 0;
    var i;
    while ((i = buf.indexOf('\n', start)) >= 0) {
      onLine(buf.charCodeAt(i - 1) === 13 ? buf.slice(start, i - 1) : buf.slice(start, i));
      start = i + 1;
    }
    return buf.slice(start);
  }

  /* ------------------------------------------------------------------ *
   * Dates, in the viewer's time zone.
   * ------------------------------------------------------------------ */

  var dayFmt = {};
  var dayCache = {};
  function localDay(ms, tz) {
    var zone = tz || 'UTC';
    var key = zone + '|' + Math.floor(ms / (15 * MIN));
    if (dayCache[key]) return dayCache[key];
    if (!dayFmt[zone]) {
      try { dayFmt[zone] = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch (e) { dayFmt[zone] = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
    }
    var parts = dayFmt[zone].formatToParts(new Date(ms));
    var y = '', m = '', d = '';
    parts.forEach(function (p) { if (p.type === 'year') y = p.value; else if (p.type === 'month') m = p.value; else if (p.type === 'day') d = p.value; });
    var out = y + '-' + m + '-' + d;
    var keys = Object.keys(dayCache);
    if (keys.length > 5000) dayCache = {};
    dayCache[key] = out;
    return out;
  }
  function addDays(day, n) {
    var d = new Date(day + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }

  /* ------------------------------------------------------------------ *
   * Formatting
   * ------------------------------------------------------------------ */

  function fmtUsd(v, opts) {
    var n = Number(v) || 0;
    var whole = opts && opts.whole;
    if (whole || Math.abs(n) >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
    return '$' + n.toFixed(2);
  }
  function fmtTok(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'K';
    return String(Math.round(n));
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }
  function minutes(ms) { var m = Math.round(ms / MIN); return m >= 90 ? (Math.round(m / 6) / 10) + ' h' : m + ' min'; }

  /* ------------------------------------------------------------------ *
   * The waste finder. Each detector is pure, works on the threads (a main
   * session, or one subagent), and returns instances with tokens and units
   * attributed and a concrete fix. Thresholds are stated in METHOD.
   * ------------------------------------------------------------------ */

  var T = {
    coldMinTokens: 20000,  // a rewrite smaller than this is noise
    ttl5m: 5 * MIN,
    ttl1h: 60 * MIN,
    rereadMin: 3,          // reads of one file (unchanged between them)
    giantChars: 40000,     // ~10K tokens in one tool result
    giantKeepTokens: 2000, // what a trimmed version would have cost
    bloatTokens: 150000,   // context past this, uncompacted
    loopMin: 3,            // the same failing call this many times
    smallOut: 600,         // output tokens in a "small" turn
    smallTurnsMin: 8,
    smallShare: 0.6,
    dupMin: 2,             // identical calls across subagents of one session
  };

  var METHOD = [
    'Prices are the dated list prices in the table (editable). Every dollar is an estimate of what the same usage costs on the API; a subscription seat is billed differently.',
    'A token added to a session’s context is written to the prompt cache once and read again on every later turn until the session is compacted or cleared. A tool result’s waste is priced that way: one cache write plus a cache read per later turn. Result sizes are converted at about 4 characters per token.',
    'Cache went cold: a turn more than 5 minutes (60 for 1-hour caching) after the one before that wrote ' + (T.coldMinTokens / 1000) + 'K+ tokens of context again; the waste is the difference between writing that context and reading it.',
    'Re-reading: the same file read ' + T.rereadMin + '+ times in one session with no edit to it in between (and no compaction); every read after the first counts.',
    'Giant tool output: one result over ' + (T.giantChars / 1000) + 'K characters (~10K tokens); the waste is everything past a ' + (T.giantKeepTokens / 1000) + 'K-token trimmed version.',
    'Context bloat: turns after a session passed ' + (T.bloatTokens / 1000) + 'K tokens of context without a compaction; the waste is the context above that line on each of those turns.',
    'Loops: the same tool call failing ' + T.loopMin + '+ times in a session; every repeat’s whole turn counts.',
    'Big model for small turns: Opus- or Fable-class turns with under ' + T.smallOut + ' output tokens that only read or searched, re-priced at Sonnet 5.5. An upper bound: switching models mid-session rewrites the cache.',
    'Duplicate subagent work: a read or search one subagent ran that another subagent in the same session had already run.',
    'Each tool result counts toward one finding at most. The per-turn findings can overlap a little, so the share is rounded down and capped.',
  ];

  var KINDS = {
    cold: { title: 'Cache went cold', icon: '🧊', fix: 'Pauses are fine on small sessions. On big ones: finish the step before a break, run /compact first so less is written back, or come back with /clear and a two-line summary instead of reopening a huge context.', snippet: '' },
    reread: { title: 'Re-reading the same file', icon: '🔁', fix: 'Each re-read adds the whole file to the context again. Ask for a range (Read with offset and limit), or put the key facts about that file in CLAUDE.md so it is not re-opened to check them.', snippet: '- Before re-reading a file you have already read in this session, check whether it changed; read only the lines you need (offset/limit).' },
    giant: { title: 'Giant tool output', icon: '📜', fix: 'A full test log or a big file stays in the context for the rest of the session. Pipe output through tail or grep -c, and read big files by range.', snippet: '- Pipe long command output through `| tail -40` or `| grep -c PATTERN`; never print full logs or lockfiles.' },
    bloat: { title: 'Context bloat', icon: '🎈', fix: 'Every turn pays for the whole history. Run /compact when a session passes ~150K tokens, and /clear between unrelated tasks.', snippet: '- When a task is done, say so, so we can /clear before the next one.' },
    loop: { title: 'Loops', icon: '🌀', fix: 'The same failing call again rarely helps. Tell the agent to stop after two identical failures and explain what it thinks is wrong.', snippet: '- If the same command fails twice, stop and explain the likely cause before trying again.' },
    model: { title: 'Big model for small turns', icon: '🐘', fix: 'Reading and searching rarely need the biggest model. Give exploring subagents a cheaper model (model: sonnet or haiku in the agent’s definition), and switch with /model for routine work.', snippet: '' },
    dupagent: { title: 'Duplicate subagent work', icon: '👯', fix: 'Parallel subagents given overlapping briefs read and search the same things. Give each one its own files or folders, or let one explore and hand its notes to the rest.', snippet: '- When starting several subagents, give each a distinct set of files or directories and say what the others cover.' },
  };
  var KIND_IDS = ['cold', 'reread', 'giant', 'bloat', 'loop', 'model', 'dupagent'];

  /** The analysis: totals, breakdowns, sessions and findings, at a price
   *  table. Recomputed in full when a price is edited (no re-read). */
  function analyse(ds, prices, opts) {
    opts = opts || {};
    var table = cleanPrices(prices);
    var tz = opts.tz || 'UTC';
    var cheaper = rowFor(CHEAPER_ID, table);
    var tot = { units: 0, inp: 0, w5: 0, w1: 0, cr: 0, out: 0, turns: 0, subUnits: 0, subTurns: 0, mainUnits: 0 };
    var byDay = {};
    var byProject = {};
    var byModel = {};
    var unpriced = {};
    var sessions = {};
    var people = ds.people.map(function (name) { return { name: name, units: 0, turns: 0, byDay: {}, sessions: 0, findings: {} }; });
    var first = Infinity, last = -Infinity;
    var findings = {};
    KIND_IDS.forEach(function (k) { findings[k] = { id: k, units: 0, tokens: 0, instances: [] }; });

    // Pass 1: price every turn; sessions and breakdowns.
    ds.threads.forEach(function (th) {
      var sk = th.person + '|' + th.sid;
      var s = sessions[sk];
      if (!s) {
        s = sessions[sk] = { key: sk, sid: th.sid, person: th.person, project: th.project, start: Infinity, end: -Infinity, units: 0, subUnits: 0, turns: 0, subTurns: 0, inp: 0, w: 0, cr: 0, out: 0, peak: 0, models: {}, agents: [], spark: [], detail: [], compactions: [], cold: [], findingUnits: 0 };
        people[th.person] && people[th.person].sessions++;
      }
      if (!th.sub) s.project = th.project;
      var agentUnits = 0;
      th.turns.forEach(function (t) {
        var row = rowFor(t.model, table);
        t.row = row;
        t.units = turnUnits(t, row);
        t.inUnits = inputUnits(t, row);
        if (!row) {
          var um = clean(t.model, 60) || 'unknown';
          unpriced[um] = unpriced[um] || { model: um, turns: 0, tokens: 0 };
          unpriced[um].turns++; unpriced[um].tokens += t.ctx + t.out;
        }
        tot.units += t.units; tot.inp += t.inp; tot.w5 += t.w5; tot.w1 += t.w1; tot.cr += t.cr; tot.out += t.out; tot.turns++;
        if (th.sub) { tot.subUnits += t.units; tot.subTurns++; s.subUnits += t.units; s.subTurns++; agentUnits += t.units; } else tot.mainUnits += t.units;
        s.units += t.units; s.turns++; s.inp += t.inp; s.w += t.w5 + t.w1; s.cr += t.cr; s.out += t.out;
        if (!th.sub && t.ctx > s.peak) s.peak = t.ctx;
        s.start = Math.min(s.start, t.t); s.end = Math.max(s.end, t.t);
        first = Math.min(first, t.t); last = Math.max(last, t.t);
        var mk = row ? row.id : 'unpriced';
        s.models[mk] = 1;
        var bm = byModel[mk] = byModel[mk] || { id: mk, name: row ? row.name : 'Not in the price table', units: 0, turns: 0, out: 0, tokens: 0 };
        bm.units += t.units; bm.turns++; bm.out += t.out; bm.tokens += t.ctx + t.out;
        var bp = byProject[th.project] = byProject[th.project] || { name: th.project, units: 0, turns: 0, sessions: {} };
        bp.units += t.units; bp.turns++; bp.sessions[sk] = 1;
        var day = localDay(t.t, tz);
        var bd = byDay[day] = byDay[day] || { day: day, units: 0, subUnits: 0, turns: 0, people: {} };
        bd.units += t.units; bd.turns++; if (th.sub) bd.subUnits += t.units;
        bd.people[th.person] = (bd.people[th.person] || 0) + t.units;
        var p = people[th.person];
        if (p) { p.units += t.units; p.turns++; p.byDay[day] = (p.byDay[day] || 0) + t.units; }
      });
      if (th.sub) s.agents.push({ id: clean(th.agent, 20), units: agentUnits, turns: th.turns.length, model: th.turns.length ? modelName(th.turns[0].model, table) : '' });
      else {
        s.compactions = s.compactions.concat(th.compactions);
        s.mainSeries = th.turns.map(function (t) { return [t.t, t.ctx]; });
      }
    });

    // Pass 2: the findings.
    var claimed = new Set();
    ds.threads.forEach(function (th) {
      var sk = th.person + '|' + th.sid;
      var ctx = { th: th, session: sessions[sk], findings: findings, claimed: claimed, cheaper: cheaper, people: people };
      detectCold(ctx); detectReread(ctx); detectGiant(ctx); detectBloat(ctx); detectLoop(ctx); detectModel(ctx);
    });
    var bySession = {};
    ds.threads.forEach(function (th) { if (th.sub) (bySession[th.person + '|' + th.sid] = bySession[th.person + '|' + th.sid] || []).push(th); });
    Object.keys(bySession).forEach(function (sk) { detectDupAgents(bySession[sk], { session: sessions[sk], findings: findings, claimed: claimed, people: people }); });

    var avoidUnits = 0;
    var flist = KIND_IDS.map(function (k) {
      var f = findings[k];
      f.instances.sort(function (a, b) { return b.units - a.units; });
      avoidUnits += f.units;
      var top = f.instances[0];
      return {
        id: k, title: KINDS[k].title, icon: KINDS[k].icon, fix: KINDS[k].fix, snippet: KINDS[k].snippet,
        units: f.units, usd: usd(f.units), tokens: f.tokens, count: f.instances.length,
        headline: top ? top.headline : '', instances: f.instances.slice(0, LIMITS.instances).map(function (x) { return publicInstance(x, sessions); }),
      };
    }).filter(function (f) { return f.count > 0 && f.units > 0; }).sort(function (a, b) { return b.units - a.units; });
    avoidUnits = Math.min(avoidUnits, tot.units);
    var avoidPct = tot.units > 0 ? Math.min(95, Math.floor((avoidUnits / tot.units) * 100)) : 0;

    var dayList = [];
    if (isFinite(first)) {
      var d0 = localDay(first, tz), d1 = localDay(last, tz);
      var span = Math.min(daysBetween(d0, d1), 400);
      for (var i = 0; i <= span; i++) {
        var dd = addDays(d0, i);
        var b = byDay[dd] || { day: dd, units: 0, subUnits: 0, turns: 0, people: {} };
        dayList.push({ day: dd, usd: usd(b.units), subUsd: usd(b.subUnits), turns: b.turns, people: ds.people.map(function (_, pi) { return usd(b.people[pi] || 0); }) });
      }
    }
    var activeDays = dayList.filter(function (d) { return d.turns > 0; }).length;
    var spanDays = Math.max(1, dayList.length);
    var perDay = tot.units / spanDays;

    var sessList = Object.keys(sessions).map(function (k) {
      var s = sessions[k];
      return {
        key: s.key, sid: clean(s.sid, 40), person: s.person, project: s.project, start: s.start, end: s.end,
        usd: usd(s.units), units: s.units, subUsd: usd(s.subUnits), turns: s.turns, subTurns: s.subTurns,
        inp: s.inp, write: s.w, read: s.cr, out: s.out, peak: s.peak,
        models: Object.keys(s.models).map(function (id) { var r = rowFor(id, table); return r ? r.name : 'unpriced'; }),
        agents: s.agents.sort(function (a, b) { return b.units - a.units; }).map(function (a) { return { id: a.id, usd: usd(a.units), turns: a.turns, model: a.model }; }),
        spark: downsample(s.mainSeries || [], LIMITS.sparkPoints),
        detail: downsample(s.mainSeries || [], LIMITS.detailPoints),
        compactions: s.compactions.slice(0, 50),
        cold: s.cold.slice(0, 50),
        wasteUsd: usd(Math.min(s.findingUnits, s.units)), // an estimate never exceeds what was spent
      };
    }).sort(function (a, b) { return b.units - a.units; });

    var personList = people.map(function (p, pi) {
      var top = null;
      Object.keys(p.findings).forEach(function (k) { if (!top || p.findings[k] > p.findings[top]) top = k; });
      var topF = top ? flist.filter(function (f) { return f.id === top; })[0] : null;
      var topInst = topF ? topF.instances.filter(function (x) { return x.person === pi; })[0] : null;
      return { name: p.name, usd: usd(p.units), turns: p.turns, sessions: p.sessions, top: top ? { id: top, title: KINDS[top].title, icon: KINDS[top].icon, usd: usd(p.findings[top]), headline: topInst ? topInst.headline : '' } : null, wasteUsd: usd(Math.min(p.units, Object.keys(p.findings).reduce(function (s, k) { return s + p.findings[k]; }, 0))) };
    });

    var cacheBase = tot.inp + tot.w5 + tot.w1 + tot.cr;
    return {
      version: VERSION,
      tz: tz,
      prices: { asOf: PRICES_AS_OF, edited: priceKey(table) !== priceKey(DEFAULT_PRICES) },
      range: { from: isFinite(first) ? first : null, to: isFinite(last) ? last : null, days: spanDays, activeDays: activeDays },
      stats: Object.assign({}, ds.stats),
      people: personList,
      totals: {
        usd: usd(tot.units), units: tot.units, input: tot.inp, write5m: tot.w5, write1h: tot.w1, read: tot.cr, output: tot.out,
        tokensIn: cacheBase, tokensOut: tot.out, turns: tot.turns, sessions: sessList.length,
        cacheHit: cacheBase ? Math.round((tot.cr / cacheBase) * 1000) / 10 : 0,
        subUsd: usd(tot.subUnits), mainUsd: usd(tot.mainUnits), subTurns: tot.subTurns,
        avoidUsd: usd(avoidUnits), avoidUnits: avoidUnits, avoidPct: avoidPct,
        perDayUsd: usd(perDay), monthUsd: usd(perDay * 30),
      },
      byDay: dayList,
      byProject: Object.keys(byProject).map(function (k) { var p = byProject[k]; return { name: p.name, usd: usd(p.units), units: p.units, turns: p.turns, sessions: Object.keys(p.sessions).length }; }).sort(function (a, b) { return b.units - a.units; }),
      byModel: Object.keys(byModel).map(function (k) { var m = byModel[k]; return { id: m.id, name: m.name, usd: usd(m.units), units: m.units, turns: m.turns, out: m.out, tokens: m.tokens }; }).sort(function (a, b) { return b.units - a.units || b.turns - a.turns; }),
      unpriced: Object.keys(unpriced).map(function (k) { return unpriced[k]; }),
      sessions: sessList,
      findings: flist,
    };
  }

  function downsample(series, n) {
    if (series.length <= n) return series.map(function (p) { return [p[0], p[1]]; });
    var out = [];
    var step = series.length / n;
    for (var i = 0; i < n; i++) {
      var a = Math.floor(i * step), b = Math.max(a + 1, Math.floor((i + 1) * step));
      var best = series[a];
      for (var j = a; j < b && j < series.length; j++) if (series[j][1] > best[1]) best = series[j];
      out.push([best[0], best[1]]);
    }
    return out;
  }

  function publicInstance(x, sessions) {
    var s = sessions[x.session];
    return { kind: x.kind, session: x.session, sid: s ? clean(s.sid, 40) : '', person: x.person, project: x.project, t: x.t, label: x.label, tokens: x.tokens, usd: usd(x.units), units: x.units, headline: x.headline, detail: x.detail || '' };
  }

  function addFinding(ctx, kind, inst) {
    if (!(inst.units > 0)) return;
    var f = ctx.findings[kind];
    inst.kind = kind;
    f.units += inst.units;
    f.tokens += inst.tokens;
    f.instances.push(inst);
    if (ctx.session) ctx.session.findingUnits += inst.units;
    var p = ctx.people && ctx.people[inst.person];
    if (p) p.findings[kind] = (p.findings[kind] || 0) + inst.units;
  }
  function q(s) { return '‘' + s + '’'; }

  /** Turns after turn k (same thread) that carry a token added at k: up to
   *  the next compaction, or the end. */
  function laterTurns(th, k) {
    var t0 = th.turns[k].t;
    var stop = Infinity;
    for (var i = 0; i < th.compactions.length; i++) if (th.compactions[i] > t0) { stop = th.compactions[i]; break; }
    var n = 0;
    for (var j = k + 1; j < th.turns.length && th.turns[j].t < stop; j++) n++;
    return n;
  }
  function carryUnits(th, k, tokens) {
    var row = th.turns[k].row;
    if (!row || tokens <= 0) return 0;
    return tokens * (centsPerM(row.write5m) + laterTurns(th, k) * centsPerM(row.read));
  }
  function compactedBetween(th, a, b) {
    for (var i = 0; i < th.compactions.length; i++) if (th.compactions[i] > a && th.compactions[i] <= b) return true;
    return false;
  }

  function detectCold(c) {
    var th = c.th;
    var oneHour = false;
    for (var k = 1; k < th.turns.length; k++) {
      var prev = th.turns[k - 1], t = th.turns[k];
      if (prev.w1 > 0) oneHour = true;
      var gap = t.t - prev.t;
      var ttl = oneHour ? T.ttl1h : T.ttl5m;
      var written = t.w5 + t.w1;
      if (gap <= ttl || written < T.coldMinTokens || !t.row) continue;
      if (compactedBetween(th, prev.t, t.t)) continue;
      if (t.cr > written) continue; // most of it was still read: not a cold start
      var tokens = Math.min(written, prev.ctx);
      var wRate = t.w1 > t.w5 ? centsPerM(t.row.write1h) : centsPerM(t.row.write5m);
      var units = tokens * Math.max(0, wRate - centsPerM(t.row.read)) * (t.fast && t.row.fast ? t.row.fast : 1);
      if (units <= 0) continue;
      if (c.session) c.session.cold.push(t.t);
      addFinding(c, 'cold', {
        session: th.person + '|' + th.sid, person: th.person, project: th.project, t: t.t, tokens: tokens, units: units,
        label: minutes(gap) + ' pause',
        headline: 'You paused ' + minutes(gap) + ' in ' + q(th.project) + (th.sub ? ' (a subagent)' : '') + '; ' + fmtTok(tokens) + ' tokens of context were written again (' + fmtUsd(usd(units)) + ').',
        detail: fmtTok(tokens) + ' tokens rewritten after ' + minutes(gap),
      });
    }
  }

  function detectReread(c) {
    var th = c.th;
    var reads = {}; // path -> {n, last (turn idx), list: [{k, tool}]}
    var edits = {}; // path -> last edit turn idx
    for (var k = 0; k < th.turns.length; k++) {
      var tools = th.turns[k].tools;
      for (var i = 0; i < tools.length; i++) {
        var tl = tools[i];
        if (!tl.path) continue;
        if (EDIT_TOOLS[tl.name]) { edits[tl.path] = k; continue; }
        if (!READ_TOOLS[tl.name] || tl.err) continue;
        // Keyed by the exact read (path, offset, limit): reading another
        // range of a file is not reading it again.
        var r = reads[tl.sig];
        var fresh = !r || (edits[tl.path] !== undefined && edits[tl.path] >= r.lastK) || compactedBetween(th, th.turns[r.lastK].t, th.turns[k].t);
        if (fresh) { reads[tl.sig] = { path: tl.path, first: k, lastK: k, again: [] }; continue; }
        r.again.push({ k: k, tool: tl });
        r.lastK = k;
      }
    }
    Object.keys(reads).forEach(function (sig) {
      var r = reads[sig];
      var p = r.path;
      if (r.again.length + 1 < T.rereadMin) return;
      var units = 0, tokens = 0;
      r.again.forEach(function (a) {
        c.claimed.add(a.tool);
        var tk = tokensOfChars(a.tool.chars);
        tokens += tk;
        units += carryUnits(th, a.k, tk);
      });
      var name = basename(p);
      addFinding(c, 'reread', {
        session: th.person + '|' + th.sid, person: th.person, project: th.project, t: th.turns[r.again[0].k].t, tokens: tokens, units: units,
        label: name,
        headline: name + ' was read ' + (r.again.length + 1) + ' times in ' + q(th.project) + ' without changing; the ' + plural(r.again.length, 'repeat') + ' added ' + fmtTok(tokens) + ' tokens (' + fmtUsd(usd(units)) + ').',
        detail: (r.again.length + 1) + ' reads',
      });
    });
  }

  function detectGiant(c) {
    var th = c.th;
    for (var k = 0; k < th.turns.length; k++) {
      var tools = th.turns[k].tools;
      for (var i = 0; i < tools.length; i++) {
        var tl = tools[i];
        if (tl.chars < T.giantChars || c.claimed.has(tl)) continue;
        c.claimed.add(tl);
        var tk = tokensOfChars(tl.chars);
        var extra = Math.max(0, tk - T.giantKeepTokens);
        var units = carryUnits(th, k, extra);
        var what = tl.name === 'Bash' ? '`' + tl.label + '`' : tl.label;
        var tip = tl.name === 'Bash' ? ' Pipe it through tail or grep -c.' : (READ_TOOLS[tl.name] ? ' Read a range instead.' : (tl.name === 'Grep' ? ' Narrow it, or ask for file names only.' : ''));
        addFinding(c, 'giant', {
          session: th.person + '|' + th.sid, person: th.person, project: th.project, t: th.turns[k].t, tokens: extra, units: units,
          label: tl.name + ': ' + tl.label,
          headline: what + ' returned ' + fmtTok(tk) + ' tokens in ' + q(th.project) + ', carried for ' + plural(laterTurns(th, k), 'more turn') + ' (' + fmtUsd(usd(units)) + ').' + tip,
          detail: fmtTok(tk) + ' tokens from ' + tl.name,
        });
      }
    }
  }

  function detectBloat(c) {
    var th = c.th;
    var over = null;
    function close() {
      if (!over || over.turns < 1 || over.units <= 0) { over = null; return; }
      addFinding(c, 'bloat', {
        session: th.person + '|' + th.sid, person: th.person, project: th.project, t: over.t, tokens: over.tokens, units: over.units,
        label: 'peak ' + fmtTok(over.peak),
        headline: q(th.project) + (th.sub ? ' (a subagent)' : '') + ' ran ' + plural(over.turns, 'turn') + ' above ' + fmtTok(T.bloatTokens) + ' tokens of context, peaking at ' + fmtTok(over.peak) + '; carrying the extra cost ' + fmtUsd(usd(over.units)) + '.',
        detail: plural(over.turns, 'turn') + ' over the line',
      });
      over = null;
    }
    for (var k = 0; k < th.turns.length; k++) {
      var t = th.turns[k];
      var prev = k ? th.turns[k - 1] : null;
      if (prev && (compactedBetween(th, prev.t, t.t) || t.ctx < prev.ctx * 0.6)) close();
      if (t.ctx <= T.bloatTokens) { if (over && t.ctx < T.bloatTokens * 0.8) close(); continue; }
      if (!over) { over = { t: t.t, turns: 0, units: 0, tokens: 0, peak: t.ctx }; continue; } // the crossing turn itself is not counted
      var extra = t.ctx - T.bloatTokens;
      over.turns++;
      over.tokens += extra;
      over.units += t.ctx > 0 ? Math.round(t.inUnits * (extra / t.ctx)) : 0;
      over.peak = Math.max(over.peak, t.ctx);
    }
    close();
  }

  function detectLoop(c) {
    var th = c.th;
    var groups = {};
    for (var k = 0; k < th.turns.length; k++) {
      th.turns[k].tools.forEach(function (tl) {
        if (!tl.err) return;
        var g = groups[tl.sig] = groups[tl.sig] || { tool: tl, ks: [] };
        if (g.ks[g.ks.length - 1] !== k) g.ks.push(k);
      });
    }
    Object.keys(groups).forEach(function (sig) {
      var g = groups[sig];
      if (g.ks.length < T.loopMin) return;
      var units = 0, tokens = 0;
      g.ks.slice(1).forEach(function (k) { units += th.turns[k].units; tokens += th.turns[k].ctx + th.turns[k].out; });
      var what = g.tool.name === 'Bash' ? '`' + g.tool.label + '`' : g.tool.name + (g.tool.label && g.tool.label !== g.tool.name ? ' ' + g.tool.label : '');
      addFinding(c, 'loop', {
        session: th.person + '|' + th.sid, person: th.person, project: th.project, t: th.turns[g.ks[0]].t, tokens: tokens, units: units,
        label: g.tool.name + ': ' + g.tool.label,
        headline: what + ' failed the same way ' + g.ks.length + ' times in ' + q(th.project) + '; the ' + plural(g.ks.length - 1, 'retry', 'retries') + ' cost ' + fmtUsd(usd(units)) + '.',
        detail: g.ks.length + ' identical failures',
      });
    });
  }

  function detectModel(c) {
    var th = c.th;
    if (!c.cheaper) return;
    var small = [], all = 0;
    th.turns.forEach(function (t) {
      if (!t.row || t.row.tier !== 'top') return;
      all++;
      if (t.out < T.smallOut && t.tools.length && t.tools.every(function (x) { return LOOK_TOOLS[x.name]; })) small.push(t);
    });
    if (small.length < T.smallTurnsMin || small.length / Math.max(1, all) < T.smallShare) return;
    var units = 0, tokens = 0;
    small.forEach(function (t) { units += Math.max(0, t.units - turnUnits(t, c.cheaper)); tokens += t.ctx + t.out; });
    var model = small[0].row.name;
    addFinding(c, 'model', {
      session: th.person + '|' + th.sid, person: th.person, project: th.project, t: small[0].t, tokens: tokens, units: units,
      label: (th.sub ? 'subagent on ' : '') + model,
      headline: (th.sub ? 'A subagent in ' : '') + q(th.project) + ' ran ' + small.length + ' of its ' + all + ' ' + model + ' turns just reading or searching; ' + c.cheaper.name + ' could have done them for up to ' + fmtUsd(usd(units)) + ' less.',
      detail: small.length + ' small turns',
    });
  }

  function detectDupAgents(subs, c) {
    if (subs.length < 2) return;
    var seen = {}; // sig -> agent key that ran it first
    var calls = [];
    subs.forEach(function (th) {
      th.turns.forEach(function (t, k) {
        t.tools.forEach(function (tl) {
          if (!(LOOK_TOOLS[tl.name] || tl.name === 'Bash') || tl.err) return;
          calls.push({ th: th, k: k, t: t.t, tool: tl });
        });
      });
    });
    calls.sort(function (a, b) { return a.t - b.t; });
    var units = 0, tokens = 0, n = 0, agents = {}, first = null;
    calls.forEach(function (x) {
      var by = seen[x.tool.sig];
      if (by === undefined) { seen[x.tool.sig] = x.th.key; return; }
      if (by === x.th.key || c.claimed.has(x.tool)) return;
      c.claimed.add(x.tool);
      var tk = tokensOfChars(x.tool.chars);
      tokens += tk;
      units += carryUnits(x.th, x.k, tk);
      n++;
      agents[by] = 1; agents[x.th.key] = 1;
      if (!first) first = x;
    });
    if (n < T.dupMin || units <= 0) return;
    var th0 = subs[0];
    addFinding(c, 'dupagent', {
      session: th0.person + '|' + th0.sid, person: th0.person, project: th0.project, t: first.t, tokens: tokens, units: units,
      label: plural(Object.keys(agents).length, 'subagent'),
      headline: Object.keys(agents).length + ' subagents in ' + q(th0.project) + ' ran ' + plural(n, 'read or search', 'reads and searches') + ' another one had already run (' + fmtUsd(usd(units)) + ').',
      detail: n + ' repeated calls',
    });
  }

  /* ------------------------------------------------------------------ *
   * Exports. Nothing here leaves the device unless the person shares it.
   * ------------------------------------------------------------------ */

  /** CSV, RFC 4180: a field with a comma, quote or line break is quoted
   *  and its quotes doubled. A field a spreadsheet would run as a formula
   *  (= + - @, tab, CR) gets a leading apostrophe. */
  function csvField(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvRow(a) { return a.map(csvField).join(','); }
  function iso(ms) { return ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : ''; }

  function sessionsCsv(a) {
    var rows = [['session', 'person', 'project', 'start_utc', 'end_utc', 'turns', 'subagent_turns', 'cost_usd', 'subagent_cost_usd', 'peak_context_tokens', 'input_tokens', 'cache_write_tokens', 'cache_read_tokens', 'output_tokens', 'models', 'waste_estimate_usd']];
    a.sessions.forEach(function (s) {
      rows.push([s.sid, (a.people[s.person] || {}).name || '', s.project, iso(s.start), iso(s.end), s.turns, s.subTurns, s.usd.toFixed(2), s.subUsd.toFixed(2), s.peak, s.inp, s.write, s.read, s.out, s.models.join(' '), s.wasteUsd.toFixed(2)]);
    });
    return rows.map(csvRow).join('\r\n') + '\r\n';
  }
  function findingsCsv(a) {
    var rows = [['finding', 'person', 'project', 'session', 'when_utc', 'what', 'tokens', 'estimate_usd', 'detail']];
    a.findings.forEach(function (f) {
      f.instances.forEach(function (x) { rows.push([f.title, (a.people[x.person] || {}).name || '', x.project, x.sid, iso(x.t), x.label, x.tokens, x.usd.toFixed(2), x.headline]); });
    });
    return rows.map(csvRow).join('\r\n') + '\r\n';
  }
  /** Markdown: labels from transcripts go in code spans with backticks
   *  removed, so a path or a command cannot become markup or a link. */
  function mdCode(s) { return '`' + clean(String(s), 120).replace(/`/g, "'") + '`'; }
  function mdText(s) {
    return clean(String(s), 400).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\*_\[\]|#])/g, '\\$1');
  }
  function toMarkdown(a, opts) {
    opts = opts || {};
    var t = a.totals;
    var L = [];
    L.push('# Burnrate: where the agent tokens went');
    L.push('');
    L.push('_' + (a.range.from ? dateLabel(a.range.from, a.tz) + ' to ' + dateLabel(a.range.to, a.tz) : 'No dated turns') + ' · ' + plural(t.sessions, 'session') + ' · ' + plural(a.people.length, 'person', 'people') + ' · estimates at list prices as of ' + PRICES_AS_OF + (a.prices.edited ? ' (edited)' : '') + '_');
    L.push('');
    L.push('- **Spend:** ' + fmtUsd(t.usd) + ' (' + fmtUsd(t.monthUsd) + ' a month at this pace)');
    L.push('- **Looks avoidable:** about ' + t.avoidPct + '% (' + fmtUsd(t.avoidUsd) + ')');
    L.push('- **Tokens:** ' + fmtTok(t.tokensIn) + ' in, ' + fmtTok(t.tokensOut) + ' out; cache hit rate ' + t.cacheHit + '%');
    L.push('- **Subagents:** ' + fmtUsd(t.subUsd) + ' of it (' + pct(t.subUsd, t.usd) + '%)');
    L.push('');
    L.push('## What to fix first');
    L.push('');
    a.findings.forEach(function (f, i) {
      L.push((i + 1) + '. **' + mdText(f.title) + ' - ' + fmtUsd(f.usd) + '** (' + fmtTok(f.tokens) + ' tokens, ' + plural(f.count, 'case') + ')');
      if (f.instances[0]) L.push('   - e.g. ' + mdText(f.instances[0].headline));
      L.push('   - Fix: ' + mdText(f.fix));
    });
    if (!a.findings.length) L.push('Nothing stood out.');
    if (opts.fixes) {
      L.push('');
      L.push('## Suggested CLAUDE.md lines');
      L.push('');
      opts.fixes.claudeMd.forEach(function (x) { L.push('- ' + mdText(x)); });
      if (opts.fixes.settings.length) {
        L.push('');
        L.push('## Settings to try');
        L.push('');
        opts.fixes.settings.forEach(function (s) { L.push('- ' + mdCode(s.setting) + ' = ' + mdCode(s.value) + ': ' + mdText(s.why)); });
      }
      if (opts.fixes.habits.length) {
        L.push('');
        L.push('## Habits');
        L.push('');
        opts.fixes.habits.forEach(function (x) { L.push('- ' + mdText(x)); });
      }
    }
    L.push('');
    L.push('## By project');
    L.push('');
    L.push('| Project | Spend | Sessions |');
    L.push('|---|---:|---:|');
    a.byProject.slice(0, 15).forEach(function (p) { L.push('| ' + mdCode(p.name) + ' | ' + fmtUsd(p.usd) + ' | ' + p.sessions + ' |'); });
    L.push('');
    L.push('## By model');
    L.push('');
    L.push('| Model | Spend | Turns |');
    L.push('|---|---:|---:|');
    a.byModel.forEach(function (m) { L.push('| ' + mdText(m.name) + ' | ' + fmtUsd(m.usd) + ' | ' + m.turns + ' |'); });
    if (a.people.length > 1) {
      L.push('');
      L.push('## By person');
      L.push('');
      L.push('| Person | Spend | Biggest finding |');
      L.push('|---|---:|---|');
      a.people.forEach(function (p) { L.push('| ' + mdText(p.name) + ' | ' + fmtUsd(p.usd) + ' | ' + (p.top ? mdText(p.top.title) + ' (' + fmtUsd(p.top.usd) + ')' : '-') + ' |'); });
    }
    L.push('');
    L.push('## How this was worked out');
    L.push('');
    METHOD.forEach(function (m) { L.push('- ' + mdText(m)); });
    L.push('');
    L.push('_Read on the device by Burnrate; no transcript left it._');
    return L.join('\n') + '\n';
  }
  function dateLabel(ms, tz) {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(ms)); } catch (e) { return iso(ms).slice(0, 10); }
  }

  /* ------------------------------------------------------------------ *
   * What "Write our fixes" sends: the findings, as numbers and names. No
   * path (file basenames only), no command, no message text, no code.
   * ------------------------------------------------------------------ */

  var SAFE_TOOL = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
  function fixesSummary(a) {
    var t = a.totals;
    return {
      period: { days: a.range.days, sessions: t.sessions, people: a.people.length },
      spend: { usd: t.usd, perMonthUsd: t.monthUsd, avoidablePct: t.avoidPct, cacheHitPct: t.cacheHit, subagentPct: pct(t.subUsd, t.usd) },
      models: a.byModel.slice(0, 6).map(function (m) { return { model: m.name, sharePct: pct(m.usd, t.usd) }; }),
      findings: a.findings.slice(0, 7).map(function (f) {
        var ex = f.instances.slice(0, 3).map(function (x) {
          var o = { usd: x.usd, tokens: x.tokens };
          var colon = x.label.indexOf(': ');
          var tool = colon > 0 ? x.label.slice(0, colon) : '';
          if (f.id === 'reread') o.file = basename(x.label);
          else if (f.id === 'giant' || f.id === 'loop') { if (SAFE_TOOL.test(tool)) o.tool = tool; if (tool !== 'Bash' && tool && READ_TOOLS[tool]) o.file = basename(x.label.slice(colon + 2)); }
          else if (f.id === 'cold') o.pauseMinutes = Math.round(Number(String(x.label).replace(/[^0-9.]/g, '')) * (/ h /.test(x.label + ' ') ? 60 : 1)) || null;
          else if (f.id === 'bloat') o.peakTokens = Number(x.tokens) || 0;
          return o;
        });
        return { kind: f.id, title: f.title, usd: f.usd, tokens: f.tokens, cases: f.count, examples: ex };
      }),
    };
  }

  /** The model's proposal, made safe: bounded counts and lengths, plain
   *  text only (markup, control and bidi characters removed). */
  function cleanFixes(raw) {
    if (!raw || typeof raw !== 'object') return null;
    function lines(v, n, max) {
      return (Array.isArray(v) ? v : []).slice(0, 40).map(function (x) { return clean(String(typeof x === 'string' ? x : ''), max).replace(/<[^>]*>?/g, '').trim(); }).filter(function (x) { return /[A-Za-z]/.test(x); }).slice(0, n);
    }
    var settings = (Array.isArray(raw.settings) ? raw.settings : []).slice(0, 40).map(function (s) {
      if (!s || typeof s !== 'object') return null;
      var setting = clean(typeof s.setting === 'string' ? s.setting : '', 60).replace(/<[^>]*>?/g, '');
      var value = clean(typeof s.value === 'string' ? s.value : (typeof s.value === 'number' || typeof s.value === 'boolean' ? String(s.value) : ''), 80).replace(/<[^>]*>?/g, '');
      var why = clean(typeof s.why === 'string' ? s.why : '', 200).replace(/<[^>]*>?/g, '');
      return setting && value && /[A-Za-z]/.test(why) ? { setting: setting, value: value, why: why } : null;
    }).filter(Boolean).slice(0, 6);
    var out = { claudeMd: lines(raw.claudeMd, 10, 200), settings: settings, habits: lines(raw.habits, 8, 200) };
    return out.claudeMd.length + out.settings.length + out.habits.length ? out : null;
  }

  /* ------------------------------------------------------------------ *
   * Remembered on this device: the aggregates of the last analysis - never
   * a transcript, a path or a command beyond the short labels already in
   * the findings. Read back through cleanSaved.
   * ------------------------------------------------------------------ */

  function toSaved(a, savedAt) {
    var copy = JSON.parse(JSON.stringify(a));
    copy.sessions = copy.sessions.slice(0, LIMITS.sessionsSaved).map(function (s) { delete s.detail; return s; });
    copy.findings.forEach(function (f) { f.instances = f.instances.slice(0, LIMITS.savedInstances); });
    copy.savedAt = savedAt || Date.now();
    copy.saved = true;
    return copy;
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function cleanSaved(v) {
    if (!v || typeof v !== 'object' || v.version !== VERSION || !v.totals || !Array.isArray(v.findings) || !Array.isArray(v.sessions)) return null;
    try {
      var t = v.totals;
      Object.keys(t).forEach(function (k) { t[k] = num(t[k]); });
      v.people = (Array.isArray(v.people) ? v.people : []).slice(0, LIMITS.people).map(function (p) { return { name: clean(p && p.name, LIMITS.personName) || 'Someone', usd: num(p && p.usd), turns: num(p && p.turns), sessions: num(p && p.sessions), wasteUsd: num(p && p.wasteUsd), top: p && p.top && KINDS[p.top.id] ? { id: p.top.id, title: KINDS[p.top.id].title, icon: KINDS[p.top.id].icon, usd: num(p.top.usd), headline: clean(p.top.headline, 300) } : null }; });
      v.findings = v.findings.filter(function (f) { return f && KINDS[f.id]; }).map(function (f) {
        return { id: f.id, title: KINDS[f.id].title, icon: KINDS[f.id].icon, fix: KINDS[f.id].fix, snippet: KINDS[f.id].snippet, units: num(f.units), usd: num(f.usd), tokens: num(f.tokens), count: num(f.count), headline: clean(f.headline, 300),
          instances: (Array.isArray(f.instances) ? f.instances : []).slice(0, LIMITS.savedInstances).map(function (x) { return { kind: f.id, session: clean(x.session, 140), sid: clean(x.sid, 40), person: num(x.person), project: clean(x.project, 60), t: num(x.t), label: clean(x.label, 140), tokens: num(x.tokens), usd: num(x.usd), units: num(x.units), headline: clean(x.headline, 300), detail: clean(x.detail, 80) }; }) };
      });
      v.sessions = v.sessions.slice(0, LIMITS.sessionsSaved).map(function (s) {
        return { key: clean(s.key, 140), sid: clean(s.sid, 40), person: num(s.person), project: clean(s.project, 60), start: num(s.start), end: num(s.end), usd: num(s.usd), units: num(s.units), subUsd: num(s.subUsd), turns: num(s.turns), subTurns: num(s.subTurns), inp: num(s.inp), write: num(s.write), read: num(s.read), out: num(s.out), peak: num(s.peak),
          models: (Array.isArray(s.models) ? s.models : []).slice(0, 8).map(function (m) { return clean(m, 30); }),
          agents: (Array.isArray(s.agents) ? s.agents : []).slice(0, 30).map(function (g) { return { id: clean(g && g.id, 20), usd: num(g && g.usd), turns: num(g && g.turns), model: clean(g && g.model, 30) }; }),
          spark: (Array.isArray(s.spark) ? s.spark : []).slice(0, LIMITS.sparkPoints).map(function (p) { return [num(p && p[0]), num(p && p[1])]; }),
          detail: null, compactions: [], cold: (Array.isArray(s.cold) ? s.cold : []).slice(0, 50).map(num), wasteUsd: num(s.wasteUsd) };
      });
      v.byDay = (Array.isArray(v.byDay) ? v.byDay : []).slice(0, 400).map(function (d) { return { day: /^\d{4}-\d{2}-\d{2}$/.test(d && d.day) ? d.day : '1970-01-01', usd: num(d.usd), subUsd: num(d.subUsd), turns: num(d.turns), people: (Array.isArray(d.people) ? d.people : []).slice(0, LIMITS.people).map(num) }; });
      v.byProject = (Array.isArray(v.byProject) ? v.byProject : []).slice(0, 200).map(function (p) { return { name: clean(p.name, 60), usd: num(p.usd), units: num(p.units), turns: num(p.turns), sessions: num(p.sessions) }; });
      v.byModel = (Array.isArray(v.byModel) ? v.byModel : []).slice(0, 40).map(function (m) { return { id: clean(m.id, 60), name: clean(m.name, 40), usd: num(m.usd), units: num(m.units), turns: num(m.turns), out: num(m.out), tokens: num(m.tokens) }; });
      v.unpriced = (Array.isArray(v.unpriced) ? v.unpriced : []).slice(0, 20).map(function (u) { return { model: clean(u.model, 60), turns: num(u.turns), tokens: num(u.tokens) }; });
      v.range = { from: num(v.range && v.range.from) || null, to: num(v.range && v.range.to) || null, days: num(v.range && v.range.days) || 1, activeDays: num(v.range && v.range.activeDays) };
      v.stats = v.stats && typeof v.stats === 'object' ? Object.keys(v.stats).reduce(function (o, k) { o[clean(k, 30)] = num(v.stats[k]); return o; }, {}) : {};
      v.prices = { asOf: PRICES_AS_OF, edited: Boolean(v.prices && v.prices.edited) };
      v.tz = clean(v.tz, 60) || 'UTC';
      v.savedAt = num(v.savedAt);
      v.saved = true;
      v.demo = Boolean(v.demo);
      return v;
    } catch (e) { return null; }
  }

  return {
    VERSION: VERSION, LIMITS: LIMITS, T: T, METHOD: METHOD, KINDS: KINDS, KIND_IDS: KIND_IDS,
    PRICES_AS_OF: PRICES_AS_OF, PRICE_NOTE: PRICE_NOTE, DEFAULT_PRICES: DEFAULT_PRICES, CHEAPER_ID: CHEAPER_ID, PRICE_FIELDS: PRICE_FIELDS,
    cleanPrices: cleanPrices, rowFor: rowFor, foldModel: foldModel, modelName: modelName, turnUnits: turnUnits, usd: usd, UNITS_PER_USD: UNITS_PER_USD,
    clean: clean, esc: esc, basename: basename, fnv: fnv, toolInfo: toolInfo, fileInfo: fileInfo,
    createCollector: createCollector, splitLines: splitLines, analyse: analyse, downsample: downsample,
    localDay: localDay, addDays: addDays, daysBetween: daysBetween, dateLabel: dateLabel,
    fmtUsd: fmtUsd, fmtTok: fmtTok, plural: plural, pct: pct, minutes: minutes,
    csvField: csvField, sessionsCsv: sessionsCsv, findingsCsv: findingsCsv, toMarkdown: toMarkdown,
    fixesSummary: fixesSummary, cleanFixes: cleanFixes, toSaved: toSaved, cleanSaved: cleanSaved,
  };
}));
