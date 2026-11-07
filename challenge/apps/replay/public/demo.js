/* Replay - the demo: a MADE-UP lender's decision log.
 *
 * "Riverton Small Business Lending" does not exist. Its October 2026 log is
 * built here, the same on every run, from a seeded generator: 400 automated
 * credit and fraud decisions on small-business loan applications, every case
 * id pseudonymous, every business, number and reviewer handle invented. The
 * records are hash-chained with Replay's own recipe (canonical JSON, the
 * previous hash first), so the chain checks out - except where it should not.
 *
 * Planted, on purpose, and nothing else:
 *   - one record (RVT-D-0212) edited after it was written: a decline turned
 *     into an approve, so its hash no longer matches it;
 *   - 11 declines with no reason codes;
 *   - the prompt moved from 3.1 to 3.2 on 14 Oct with no change-log entry
 *     (the model's move to 2.5.0 on 22 Oct has one);
 *   - 12 calls (3%) at temperature 0.7, against a temperature-0 policy;
 *   - 4 overrides with no reviewer recorded;
 *   - nothing logged on Tue 20 Oct from about 10:00 to 12:10;
 *   - two applications with identical inputs that got different outcomes
 *     under the same model and prompt versions.
 *
 * No clock, no dice (the generator is seeded), no network, no storage.
 * SHA-256 is handed in, as everywhere in Replay.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./replay-core'));
  else root.ReplayDemo = factory(root.ReplayCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var LENDER = 'Riverton Small Business Lending';
  var FILE = 'riverton-decisions-2026-10.jsonl';

  var CODES = [
    { code: 'R01', text: 'Time in business below the policy minimum' },
    { code: 'R02', text: 'Cash flow does not cover the requested payment' },
    { code: 'R03', text: 'Recent late payments on business credit' },
    { code: 'R04', text: 'Too many overdrafts or returned items in the bank statements' },
    { code: 'R05', text: 'Requested amount above the limit for this revenue' },
    { code: 'R06', text: 'Application incomplete or documents missing' },
    { code: 'R07', text: 'Business details could not be verified' },
    { code: 'R08', text: 'Industry outside the current lending policy' },
    { code: 'R09', text: 'Existing debt high relative to revenue' },
    { code: 'R10', text: 'Owner guarantee requirements not met' },
    { code: 'F01', text: 'Identity details did not match the records checked' },
    { code: 'F02', text: 'Device or contact details seen on other recent applications' },
    { code: 'F03', text: 'Bank account opened very recently' },
    { code: 'F04', text: 'Documents show signs of alteration' },
  ];

  var CHANGE_LOG = [
    '2026-09-28, riverton-underwriter 2.4.0, Model Risk Committee',
    '2026-09-28, sb-credit-memo 3.1, Model Risk Committee',
    '2026-10-21, riverton-underwriter 2.5.0, Model Risk Committee',
  ].join('\n');

  // What Replay should find in it, by finding key - the test holds this.
  var PLANTED = ['chain-changed', 'adverse-none', 'drift-unlogged', 'temperature', 'same-inputs', 'override-noreviewer', 'incomplete', 'gap'];

  var MAP = {
    id: 'decision_id', time: 'ts', case: 'case_id', outcome: 'decision', score: 'risk_score',
    model: 'model.id', modelVersion: 'model.version', prompt: 'prompt.id', promptVersion: 'prompt.version',
    temperature: 'params.temperature', seed: 'params.seed', inputs: 'inputs', inputsHash: 'inputs_hash',
    tools: 'tool_calls', reasons: 'reasons', rules: 'policy.rules', reviewer: 'review.reviewer',
    override: 'review.override', overrideReason: 'review.reason', prevHash: 'prev_hash', hash: 'hash',
  };

  var INDUSTRIES = ['Bakery', 'Auto repair', 'Landscaping', 'Dental practice', 'Coffee shop', 'Plumbing', 'Bookkeeping', 'Florist', 'Taproom', 'Fitness studio', 'Print shop', 'Food truck', 'Hardware store', 'Childcare', 'Pet grooming', 'Electrician', 'Bike shop', 'Tailoring'];
  var PURPOSES = ['Working capital', 'Equipment', 'Inventory', 'Expansion', 'Refinance', 'Vehicle'];
  var STATES = ['OH', 'IN', 'MI', 'IL', 'WI', 'KY', 'PA', 'MO'];
  var REVIEWERS = ['u.alder', 'u.brook', 'u.cole', 'u.dunn'];
  var ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var OVERRIDE_WHY = {
    decline: ['Seasonal dip explained by the owner letter', 'Second-year revenue confirmed with tax return', 'Strong collateral offsets the cash-flow shortfall', 'Late payments were a bank error, letter on file'],
    flag: ['Identity confirmed by a call to the owner', 'Device match is a shared office network', 'Account change explained, statements verified'],
    approve: ['Guarantor did not sign, sent back for documents'],
  };

  var MON = 9; // October, 0-based
  var ZONE = '-05:00';
  function pad(n, w) { var s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; }
  function iso(day, minutes, sec) { return '2026-10-' + pad(day) + 'T' + pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60) + ':' + pad(sec) + ZONE; }
  function ms(day, minutes, sec) { return Date.UTC(2026, MON, day, Math.floor(minutes / 60), minutes % 60, sec) + 5 * 3600000; }

  /** The 400 records, without hashes, and the indices of what was planted. */
  function records() {
    var r = C.rng('riverton-small-business-lending-october');
    var pick = function (a) { return a[Math.floor(r() * a.length)]; };
    var between = function (a, b) { return a + Math.floor(r() * (b - a + 1)); };
    var days = [];
    for (var d = 1; d <= 30; d++) { var dow = new Date(Date.UTC(2026, MON, d)).getUTCDay(); if (dow !== 0 && dow !== 6) days.push(d); }
    // 22 weekdays; 18 decisions each and 19 on four of them = 400
    var perDay = days.map(function (dd, k) { return k === 3 || k === 8 || k === 13 || k === 18 ? 19 : 18; });
    var times = [];
    days.forEach(function (dd, k) {
      var n = perDay[k];
      // nothing logged on Tue 20 Oct between 10:00 and 12:10
      var windows = dd === 20 ? [[485, 604], [724, 1070]] : [[485, 1070]];
      var span = windows.reduce(function (a, w) { return a + (w[1] - w[0]); }, 0);
      for (var j = 0; j < n; j++) {
        var at = span * (j + 0.5) / n + (r() - 0.5) * (span / n) * 0.5;
        var w = windows[0], off = at;
        if (windows.length > 1 && at >= windows[0][1] - windows[0][0]) { w = windows[1]; off = at - (windows[0][1] - windows[0][0]); }
        var minutes = Math.max(w[0], Math.min(w[1] - 1, Math.round(w[0] + off)));
        times.push({ day: dd, minutes: minutes, sec: between(0, 59) });
      }
      if (dd === 20) {
        // the records either side of the outage: 10:03 and 12:05
        var mine = times.filter(function (x) { return x.day === 20; });
        var before = mine.filter(function (x) { return x.minutes < 604; }).sort(function (a, b) { return b.minutes - a.minutes; })[0];
        var after = mine.filter(function (x) { return x.minutes >= 724; }).sort(function (a, b) { return a.minutes - b.minutes; })[0];
        before.minutes = 603; after.minutes = 725;
      }
    });
    times.sort(function (a, b) { return ms(a.day, a.minutes, a.sec) - ms(b.day, b.minutes, b.sec); });

    var used = {};
    var caseId = function () { var s; do { s = 'APP-'; for (var k = 0; k < 4; k++) s += ID_CHARS.charAt(Math.floor(r() * ID_CHARS.length)); } while (used[s]); used[s] = 1; return s; };
    var HOT = [17, 49, 83, 118, 150, 187, 233, 265, 290, 327, 361, 388];   // temperature 0.7
    var EDITED = 211;                                                     // RVT-D-0212
    var TWINS = [317, 351];                                               // the same inputs
    var out = [];
    times.forEach(function (t, i) {
      var when = ms(t.day, t.minutes, t.sec);
      var promptV = when < ms(14, 780, 0) ? '3.1' : '3.2';
      var modelV = when < ms(22, 480, 0) ? '2.4.0' : '2.5.0';
      var inputs = {
        business: { industry: pick(INDUSTRIES), state: pick(STATES), years_in_business: between(1, 24), annual_revenue: between(80, 2400) * 1000 },
        request: { amount: between(2, 50) * 5000, term_months: pick([12, 24, 36, 60]), purpose: pick(PURPOSES) },
        bureau: { score_band: pick(['A', 'B', 'B', 'C', 'C', 'D', 'E']), late_payments_24m: pick([0, 0, 0, 0, 1, 1, 2, 3]) },
        bank: { months_of_statements: between(3, 12), avg_daily_balance: between(2, 180) * 100, returned_items_90d: pick([0, 0, 0, 1, 2, 4]) },
      };
      var u = r();
      var model = u < 0.55 ? 'approve' : u < 0.80 ? 'decline' : u < 0.92 ? 'refer' : 'flag';
      if (i === EDITED) model = 'decline';
      if (TWINS.indexOf(i) >= 0) model = i === TWINS[0] ? 'approve' : 'refer';
      var score = model === 'approve' ? 0.08 + r() * 0.26 : model === 'refer' ? 0.36 + r() * 0.18 : model === 'decline' ? 0.57 + r() * 0.35 : 0.2 + r() * 0.6;
      out.push({
        i: i, when: when, t: t, model: model, final: model, score: Math.round(score * 1000) / 1000,
        rec: {
          decision_id: 'RVT-D-' + pad(i + 1, 4),
          ts: iso(t.day, t.minutes, t.sec),
          case_id: caseId(),
          channel: pick(['online', 'online', 'broker', 'branch']),
          product: pick(['term-loan', 'term-loan', 'line-of-credit']),
          model: { id: 'riverton-underwriter', version: modelV },
          prompt: { id: 'sb-credit-memo', version: promptV },
          params: { temperature: HOT.indexOf(i) >= 0 ? 0.7 : 0, seed: 10000 + ((i * 7919) % 89999), max_tokens: 1200 },
          inputs: inputs,
        },
      });
    });
    // the twins: the second application repeats the first one's inputs exactly
    out[TWINS[1]].rec.inputs = JSON.parse(JSON.stringify(out[TWINS[0]].rec.inputs));

    // reviews and overrides
    var protect = HOT.concat([EDITED], TWINS);
    var free = function (x) { return protect.indexOf(x.i) < 0; };
    var byModel = function (m) { return out.filter(function (x) { return x.model === m && free(x); }); };
    var shuffle = function (a) { a = a.slice(); for (var k = a.length - 1; k > 0; k--) { var j = Math.floor(r() * (k + 1)); var tmp = a[k]; a[k] = a[j]; a[j] = tmp; } return a; };
    var reviews = [];
    shuffle(byModel('refer')).forEach(function (x) { reviews.push({ x: x, override: false }); });
    out.filter(function (x) { return x.model === 'refer' && !free(x); }).forEach(function (x) { reviews.push({ x: x, override: false }); });
    var flags = shuffle(byModel('flag'));
    flags.forEach(function (x, k) { reviews.push({ x: x, override: k < 10, to: 'approve' }); });
    var declines = shuffle(byModel('decline'));
    declines.slice(0, 24).forEach(function (x, k) { reviews.push({ x: x, override: k < 10, to: 'approve' }); });
    var approves = shuffle(byModel('approve'));
    approves.slice(0, 10).forEach(function (x, k) { reviews.push({ x: x, override: k < 2, to: 'decline' }); });
    reviews.sort(function (a, b) { return a.x.i - b.x.i; });
    var overrides = reviews.filter(function (v) { return v.override; });
    var faceless = shuffle(overrides).slice(0, 4);
    reviews.forEach(function (v, k) {
      v.who = REVIEWERS[k % REVIEWERS.length];
      if (faceless.indexOf(v) >= 0) v.who = null;
      if (v.override) {
        v.x.final = v.to;
        v.why = pick(OVERRIDE_WHY[v.x.model]);
      }
    });

    // reasons, rules and tool calls, from the final outcome
    var RCODES = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10'];
    var FCODES = ['F01', 'F02', 'F03', 'F04'];
    var some = function (list, lo, hi) { var n = between(lo, hi), a = shuffle(list).slice(0, n); return a.sort(); };
    var reviewed = {};
    reviews.forEach(function (v) { reviewed[v.x.i] = v; });
    out.forEach(function (x) {
      var f = x.final;
      x.rec.tool_calls = [{ name: 'bureau_pull', status: 'ok', ms: between(180, 900) }, { name: 'bank_statement_summary', status: 'ok', ms: between(600, 2400) }].concat(f === 'flag' || x.model === 'flag' ? [{ name: 'identity_match', status: 'ok', ms: between(150, 700) }] : []);
      x.rec.decision = f;
      x.rec.risk_score = x.score;
      x.rec.reasons = f === 'decline' ? (x.model === 'approve' ? ['R10'] : some(RCODES, 1, 3)) : f === 'refer' ? some(RCODES, 1, 2) : f === 'flag' ? some(FCODES, 1, 2) : [];
      x.rec.policy = { rules: f === 'approve' ? ['DSCR-MIN', 'MAX-EXPOSURE'] : f === 'flag' ? ['KYB-MATCH', 'FRAUD-VELOCITY'] : ['DSCR-MIN', 'MAX-EXPOSURE', 'NSF-LIMIT'] };
      var v = reviewed[x.i];
      x.rec.review = v ? { reviewer: v.who, override: v.override, model_decision: x.model, reason: v.override ? v.why : null } : null;
      x.rec.schema = 'rvt-decision/1';
    });
    // eleven declines with no reasons: seven written as [], four with none at all
    var bare = shuffle(out.filter(function (x) { return x.final === 'decline' && free(x) && !(reviewed[x.i] && reviewed[x.i].override); })).slice(0, 11).sort(function (a, b) { return a.i - b.i; });
    bare.forEach(function (x, k) { if (k % 3 === 2) delete x.rec.reasons; else x.rec.reasons = []; });
    // the edited record is written as the decline it was
    out[EDITED].rec.reasons = ['R02', 'R09'];
    return {
      list: out.map(function (x) { return x.rec; }),
      planted: { hot: HOT, edited: EDITED, twins: TWINS, bare: bare.map(function (x) { return x.i; }), faceless: faceless.map(function (v) { return v.x.i; }), overrides: overrides.map(function (v) { return v.x.i; }) },
    };
  }

  /** The log as a JSON Lines file, hash-chained. A Promise: SHA-256 is
   *  `digest`, handed in. The edit to RVT-D-0212 is made after it was
   *  hashed - that is what makes it show. */
  function build(digest) {
    var made = records();
    var list = made.list;
    return Promise.all(list.map(function (rec) { return digest(C.canon(rec.inputs)); })).then(function (hashes) {
      list.forEach(function (rec, k) {
        // re-key so inputs_hash sits beside inputs in the written line
        var copy = {};
        Object.keys(rec).forEach(function (key) { copy[key] = rec[key]; if (key === 'inputs') copy.inputs_hash = hashes[k]; });
        list[k] = copy;
      });
      var prev = new Array(65).join('0');
      var chain = Promise.resolve();
      list.forEach(function (rec) {
        chain = chain.then(function () {
          rec.prev_hash = prev;
          return digest(C.hashInput(C.canon(rec), prev, true)).then(function (h) { rec.hash = h; prev = h; });
        });
      });
      return chain;
    }).then(function () {
      var e = list[made.planted.edited];
      e.decision = 'approve';
      e.risk_score = 0.31;
      return { name: FILE, lender: LENDER, text: list.map(function (rec) { return JSON.stringify(rec); }).join('\n') + '\n', planted: made.planted };
    });
  }

  function settings() {
    var s = C.defaults();
    s.codes = CODES.map(function (c) { return { code: c.code, text: c.text }; });
    return s;
  }

  return {
    LENDER: LENDER, FILE: FILE, CODES: CODES, CHANGE_LOG: CHANGE_LOG, PLANTED: PLANTED, MAP: MAP, REVIEWERS: REVIEWERS,
    blurb: 'A made-up lender’s October: 400 automated credit and fraud decisions on small-business loans, hash-chained - with seven things wrong.',
    records: records, build: build, settings: settings,
  };
}));
